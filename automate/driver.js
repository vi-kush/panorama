#!/usr/bin/env node
'use strict';

/**
 * Drives the explorer in headless Chrome over the DevTools protocol: opens index.html
 * from disk (file://), runs a list of steps, takes screenshots and prints any page errors.
 * No dependencies besides Node and an installed Google Chrome. Uses software 3D
 * rendering, so it checks behaviour and looks but says nothing about real-GPU speed.
 *
 *   node automate/driver.js automate/steps.example.json
 *   node automate/driver.js my-steps.json --out automate/output
 *
 * A steps file is a JSON array. Each step may have, and runs in this order:
 *   "wait":  milliseconds to wait first
 *   "click": [x, y] viewport position to click with a real mouse click
 *   "clickSelector": CSS selector; clicks the centre of the first matching, visible element
 *   "eval":  JavaScript to run in the page (its result is returned)
 *   "print": label; prints the result of "eval" under that label
 *   "shot":  file name (no extension); saves <out>/<name>.jpg
 *
 * Options:
 *   --out DIR      where screenshots go (default: automate/output)
 *   --width N      viewport width  (default 1280)
 *   --height N     viewport height (default 720)
 *   --chrome PATH  Chrome executable (default: the usual macOS/Linux locations)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// WebSocket is built into newer Node versions; Node 20 needs a flag, so restart with it.
if (typeof WebSocket === 'undefined') {
    const child = spawn(process.execPath, ['--experimental-websocket', '--no-warnings', ...process.argv.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
}

// ── Arguments ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const [, value] = args.splice(i, 2);
    return value;
};

const OUT = path.resolve(option('out', path.join(__dirname, 'output')));
const WIDTH = Number(option('width', 1280));
const HEIGHT = Number(option('height', 720));
const CHROME = option('chrome', [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
].find((p) => fs.existsSync(p)));
const stepsFile = args[0];

if (!stepsFile) {
    console.error('usage: node automate/driver.js <steps.json> [--out DIR] [--width N] [--height N] [--chrome PATH]');
    process.exit(2);
}
if (!CHROME) {
    console.error('Could not find Chrome. Pass its path with --chrome.');
    process.exit(2);
}

const steps = JSON.parse(fs.readFileSync(path.resolve(stepsFile), 'utf8'));
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-chrome-'));

    const chrome = spawn(CHROME, [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--no-first-run', '--hide-scrollbars',
        `--window-size=${WIDTH},${HEIGHT}`,
        'about:blank'
    ], { stdio: 'ignore' });

    // Stop Chrome and wait for it to exit before deleting its temporary profile
    const shutdown = async (code) => {
        if (chrome.exitCode === null) {
            await new Promise((resolve) => {
                chrome.once('exit', resolve);
                chrome.kill();
            });
        }
        try {
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
            // The OS clears its temp folder eventually; not worth failing the run over
        }
        process.exit(code);
    };

    // Find the page's DevTools endpoint
    let wsUrl;
    for (let i = 0; i < 50 && !wsUrl; i++) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
        } catch {
            await sleep(200);
        }
    }
    if (!wsUrl) throw new Error('Chrome did not start (is another one using port ' + PORT + '?)');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('could not connect to Chrome'));
    });

    // ── DevTools protocol plumbing ──
    let nextId = 0;
    const pending = new Map();
    const pageLog = [];
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === 'Runtime.consoleAPICalled') {
            pageLog.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            pageLog.push('[EXCEPTION] ' + (d.exception?.description || d.text));
        } else if (msg.method === 'Log.entryAdded') {
            pageLog.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
        }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
        const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        const failure = reply.result.exceptionDetails;
        if (failure) pageLog.push('[eval error] ' + (failure.exception?.description || failure.text));
        return reply.result.result?.value;
    };

    const screenshot = async (name) => {
        const reply = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
        const file = path.join(OUT, `${name}.jpg`);
        fs.writeFileSync(file, Buffer.from(reply.result.data, 'base64'));
        console.log(`shot  ${path.relative(process.cwd(), file)}`);
    };

    // A real mouse click (move, press, release) at viewport coordinates
    const click = async (x, y) => {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
            await sleep(40);
        }
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: PAGE });
    console.log(`opened ${PAGE}`);

    // ── Run the steps ──
    for (const step of steps) {
        if (step.wait) await sleep(step.wait);
        if (step.click) await click(step.click[0], step.click[1]);
        if (step.clickSelector) {
            const centre = await evaluate(`(() => {
                const el = document.querySelector(${JSON.stringify(step.clickSelector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return r.width && r.height ? [r.left + r.width / 2, r.top + r.height / 2] : null;
            })()`);
            if (centre) await click(centre[0], centre[1]);
            else pageLog.push(`[driver] nothing to click for "${step.clickSelector}"`);
        }
        if (step.eval) {
            const value = await evaluate(step.eval);
            if (step.print) console.log(`${step.print} ${JSON.stringify(value)}`);
        }
        if (step.shot) await screenshot(step.shot);
    }

    // Software 3D warns about screenshot readbacks; those are noise
    const interesting = pageLog.filter((line) => !/GPU stall due to ReadPixels/.test(line));
    console.log(interesting.length ? '--- page console ---' : '--- page console: no errors or warnings ---');
    interesting.forEach((line) => console.log(line));

    ws.close();
    await shutdown(interesting.some((line) => /\[EXCEPTION\]|\[eval error\]|\[log:error\]/.test(line)) ? 1 : 0);
})().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
