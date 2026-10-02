'use strict';

/**
 * Procedural demo panoramas (equirectangular, 2:1). They are drawn in code so the
 * explorer works with no image files. Every horizontal pattern uses whole-number
 * frequencies or wrapped cells, so the left and right edges meet without a seam.
 */
window.DemoScenes = (() => {
    const W = 2048;
    const H = 1024;
    const TAU = Math.PI * 2;

    // Deterministic random numbers so each demo looks the same on every load
    function rng(seed) {
        let s = seed >>> 0;
        return () => {
            s = (s + 0x6d2b79f5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function makeCanvas() {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        return c;
    }

    // Sum of sines with whole-number frequencies: periodic in longitude
    function ridge(x, layers) {
        let v = 0;
        for (const [freq, amp, phase] of layers) v += Math.sin((x / W) * TAU * freq + phase) * amp;
        return v;
    }

    // Stars are stretched towards the poles by the projection, so widen them there
    function drawStars(ctx, rand, count, maxLat) {
        for (let i = 0; i < count; i++) {
            const x = rand() * W;
            const lat = rand() * maxLat; // degrees above the horizon
            const y = H / 2 - (lat / 90) * (H / 2);
            const stretch = 1 / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
            const r = 0.4 + rand() * 1.1;
            ctx.globalAlpha = 0.35 + rand() * 0.65;
            ctx.fillStyle = rand() > 0.8 ? '#ffd9b0' : '#ffffff';
            ctx.beginPath();
            ctx.ellipse(x, y, r * stretch, r, 0, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function glow(ctx, x, y, radius, inner, outer) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
        g.addColorStop(0, inner);
        g.addColorStop(1, outer);
        ctx.fillStyle = g;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // ── 1. Sunset dunes ───────────────────────────────────────────────────
    function sunsetDunes() {
        const c = makeCanvas();
        const ctx = c.getContext('2d');
        const rand = rng(11);

        const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
        sky.addColorStop(0, '#1b1b4b');
        sky.addColorStop(0.45, '#6b3a7d');
        sky.addColorStop(0.8, '#f2735b');
        sky.addColorStop(1, '#ffc27a');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, H / 2);

        ctx.globalAlpha = 0.5;
        drawStars(ctx, rand, 260, 80);
        ctx.globalAlpha = 1;

        // Sun and glow (placed away from the wrap edge)
        const sunX = W * 0.3;
        const sunY = H / 2 - 40;
        glow(ctx, sunX, sunY, 420, 'rgba(255,214,150,0.9)', 'rgba(255,150,90,0)');
        ctx.fillStyle = '#fff3d6';
        ctx.beginPath();
        ctx.arc(sunX, sunY, 34, 0, TAU);
        ctx.fill();

        // Soft cloud streaks
        for (let i = 0; i < 26; i++) {
            const x = rand() * W;
            const y = H / 2 - 60 - rand() * 220;
            ctx.fillStyle = `rgba(255, ${170 + rand() * 60 | 0}, ${140 + rand() * 60 | 0}, ${0.1 + rand() * 0.14})`;
            ctx.beginPath();
            ctx.ellipse(x, y, 90 + rand() * 160, 5 + rand() * 9, 0, 0, TAU);
            ctx.fill();
        }

        // Three layers of dunes, far to near
        const layers = [
            { base: 14, color: ['#c0617a', '#8d4262'], wave: [[2, 9, 0.4], [5, 5, 1.2], [9, 2.5, 2]] },
            { base: 4, color: ['#a8504f', '#6e3340'], wave: [[3, 10, 2.1], [7, 4, 0.2], [11, 2, 1.4]] },
            { base: -9, color: ['#7d3b3a', '#3a1c26'], wave: [[2, 12, 1.1], [4, 6, 2.6], [8, 3, 0.8]] }
        ];
        for (const L of layers) {
            const fill = ctx.createLinearGradient(0, H / 2 - 40, 0, H);
            fill.addColorStop(0, L.color[0]);
            fill.addColorStop(1, L.color[1]);
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.moveTo(0, H);
            for (let x = 0; x <= W; x += 4) {
                const elev = L.base + ridge(x, L.wave); // pixels above the horizon
                ctx.lineTo(x, H / 2 - elev);
            }
            ctx.lineTo(W, H);
            ctx.closePath();
            ctx.fill();
        }

        // Ground: dark sand towards the nadir
        const ground = ctx.createLinearGradient(0, H / 2 + 80, 0, H);
        ground.addColorStop(0, 'rgba(58, 28, 38, 0)');
        ground.addColorStop(1, '#1d0f1a');
        ctx.fillStyle = ground;
        ctx.fillRect(0, H / 2 + 80, W, H / 2 - 80);

        // Wind ripples on the sand
        ctx.strokeStyle = 'rgba(255, 190, 150, 0.07)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 70; i++) {
            const y = H / 2 + 90 + rand() * (H / 2 - 100);
            ctx.beginPath();
            for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin((x / W) * TAU * (3 + (i % 5)) + i) * 4);
            ctx.stroke();
        }
        return c;
    }

    // ── 2. Night lake ─────────────────────────────────────────────────────
    function nightLake() {
        const c = makeCanvas();
        const ctx = c.getContext('2d');
        const rand = rng(23);

        const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
        sky.addColorStop(0, '#02030c');
        sky.addColorStop(0.6, '#0b1233');
        sky.addColorStop(1, '#27406b');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, H / 2);

        // Milky-way band: a tilted sine band of faint stars
        for (let i = 0; i < 2600; i++) {
            const x = rand() * W;
            const bandY = H * 0.2 + Math.sin((x / W) * TAU) * H * 0.1;
            const y = bandY + (rand() + rand() - 1) * H * 0.07;
            ctx.fillStyle = `rgba(190, 205, 255, ${rand() * 0.18})`;
            ctx.fillRect(x, y, 1.5, 1.5);
        }
        drawStars(ctx, rand, 900, 90);

        // Moon
        const moonX = W * 0.72;
        const moonY = H / 2 - 190;
        glow(ctx, moonX, moonY, 300, 'rgba(190, 215, 255, 0.55)', 'rgba(120, 160, 255, 0)');
        ctx.fillStyle = '#eef4ff';
        ctx.beginPath();
        ctx.arc(moonX, moonY, 32, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(150, 170, 210, 0.35)';
        for (const [dx, dy, r] of [[-9, -6, 8], [10, 8, 6], [4, -14, 4]]) {
            ctx.beginPath();
            ctx.arc(moonX + dx, moonY + dy, r, 0, TAU);
            ctx.fill();
        }

        const mountainPath = (mirror) => {
            ctx.beginPath();
            ctx.moveTo(0, H / 2);
            for (let x = 0; x <= W; x += 4) {
                const elev = 28 + ridge(x, [[2, 26, 0.7], [5, 18, 2.2], [9, 10, 0.3], [17, 5, 1.1], [31, 2.5, 2.5]]);
                ctx.lineTo(x, H / 2 + (mirror ? 1 : -1) * Math.max(4, elev));
            }
            ctx.lineTo(W, H / 2);
            ctx.closePath();
        };

        // Lake below the horizon: reflected sky, then the reflected mountains
        const lake = ctx.createLinearGradient(0, H / 2, 0, H);
        lake.addColorStop(0, '#27406b');
        lake.addColorStop(0.35, '#0b1233');
        lake.addColorStop(1, '#02030c');
        ctx.fillStyle = lake;
        ctx.fillRect(0, H / 2, W, H / 2);

        ctx.fillStyle = 'rgba(2, 4, 14, 0.9)';
        mountainPath(true);
        ctx.fill();

        // Moon reflection as shimmering bars
        for (let i = 0; i < 46; i++) {
            const y = H / 2 + 60 + i * 9;
            const spread = 8 + i * 1.8;
            ctx.fillStyle = `rgba(200, 220, 255, ${Math.max(0, 0.32 - i * 0.006) * (0.5 + rand() * 0.5)})`;
            ctx.fillRect(moonX - spread + rand() * 8, y, spread * 2, 2.5);
        }

        ctx.fillStyle = '#02030a';
        mountainPath(false);
        ctx.fill();

        // A few pines on the near shore
        for (let i = 0; i < 70; i++) {
            const x = rand() * W;
            const h = 22 + rand() * 40;
            const base = H / 2 + 2;
            ctx.beginPath();
            ctx.moveTo(x - h * 0.18, base);
            ctx.lineTo(x, base - h);
            ctx.lineTo(x + h * 0.18, base);
            ctx.closePath();
            ctx.fill();
        }

        // Ripples
        ctx.strokeStyle = 'rgba(160, 190, 255, 0.06)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 90; i++) {
            const y = H / 2 + 20 + Math.pow(rand(), 1.6) * (H / 2 - 30);
            ctx.beginPath();
            for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin((x / W) * TAU * (4 + (i % 7)) + i * 2) * 2);
            ctx.stroke();
        }
        return c;
    }

    // ── 3. Neon grid ──────────────────────────────────────────────────────
    function neonGrid() {
        const c = makeCanvas();
        const ctx = c.getContext('2d');
        const rand = rng(37);

        const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
        sky.addColorStop(0, '#04010f');
        sky.addColorStop(0.55, '#2a0a52');
        sky.addColorStop(1, '#ff3d8b');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, H / 2);

        drawStars(ctx, rand, 500, 85);

        // Striped retro sun
        const sunX = W * 0.5;
        const sunY = H / 2 - 150;
        glow(ctx, sunX, sunY, 380, 'rgba(255, 80, 160, 0.55)', 'rgba(255, 80, 160, 0)');
        ctx.save();
        ctx.beginPath();
        ctx.arc(sunX, sunY, 120, 0, TAU);
        ctx.clip();
        const sun = ctx.createLinearGradient(0, sunY - 120, 0, sunY + 120);
        sun.addColorStop(0, '#ffe45e');
        sun.addColorStop(1, '#ff2e88');
        ctx.fillStyle = sun;
        ctx.fillRect(sunX - 120, sunY - 120, 240, 240);
        ctx.fillStyle = '#2a0a52';
        for (let i = 0; i < 7; i++) ctx.fillRect(sunX - 120, sunY + 10 + i * 17, 240, 2 + i * 1.6);
        ctx.restore();

        // City skyline: cells wrap, so the edges meet
        const cells = 96;
        const cellW = W / cells;
        for (let i = 0; i < cells; i++) {
            const h = 14 + Math.pow(rand(), 2) * 110;
            ctx.fillStyle = '#0a0220';
            ctx.fillRect(i * cellW, H / 2 - h, cellW + 1, h + 2);
            ctx.fillStyle = 'rgba(94, 225, 255, 0.55)';
            for (let w = 0; w < h - 8; w += 9) {
                if (rand() > 0.72) ctx.fillRect(i * cellW + 3 + rand() * (cellW - 8), H / 2 - h + 5 + w, 2, 3);
            }
        }

        // Floor: perspective grid computed per pixel from the viewing ray
        const floor = ctx.getImageData(0, H / 2, W, H / 2);
        const data = floor.data;
        const camHeight = 1.5;
        for (let y = 0; y < H / 2; y++) {
            const below = ((y + 0.5) / H) * Math.PI; // angle below the horizon
            const dist = camHeight / Math.tan(Math.max(below, 0.0005));
            const fade = Math.exp(-dist * 0.085);
            const lineW = 0.025 + dist * 0.0025; // widen with distance to avoid shimmering
            for (let x = 0; x < W; x++) {
                const lon = (x / W) * TAU;
                const gx = (dist * Math.cos(lon)) / 2;
                const gz = (dist * Math.sin(lon)) / 2;
                const fx = Math.abs(gx - Math.round(gx)) * 2;
                const fz = Math.abs(gz - Math.round(gz)) * 2;
                const line = Math.max(1 - Math.min(fx, fz) / lineW, 0);
                const i = (y * W + x) * 4;
                const horizonGlow = Math.exp(-below * 14) * 0.55;
                const base = 0.04 + horizonGlow * 0.5;
                data[i] = Math.min(255, (10 + 255 * line * fade + 255 * base * 0.9));
                data[i + 1] = Math.min(255, (4 + 60 * line * fade + 40 * base));
                data[i + 2] = Math.min(255, (28 + 255 * line * fade * 0.85 + 120 * base));
                data[i + 3] = 255;
            }
        }
        ctx.putImageData(floor, 0, H / 2);
        return c;
    }

    // Hotspots sit on the ground (negative latitude) so they read as "walk this way"
    return [
        {
            name: 'Sunset Dunes',
            startLon: 20,
            create: sunsetDunes,
            hotspots: [
                { lon: 140, lat: -9, target: 1, label: 'To the Night Lake', arrive: { lon: -40 } },
                { lon: 250, lat: -11, target: 2, label: 'To the Neon Grid', arrive: { lon: 90 } }
            ]
        },
        {
            name: 'Night Lake',
            startLon: -40,
            create: nightLake,
            hotspots: [
                { lon: 150, lat: -8, target: 0, label: 'Back to the Dunes', arrive: { lon: 320 } },
                { lon: 30, lat: -10, target: 2, label: 'To the Neon Grid', arrive: { lon: 90 } }
            ]
        },
        {
            name: 'Neon Grid',
            startLon: 90,
            create: neonGrid,
            hotspots: [
                { lon: 270, lat: -12, target: 0, label: 'Back to the Dunes', arrive: { lon: 320 } },
                { lon: 180, lat: -9, target: 1, label: 'To the Night Lake', arrive: { lon: -40 } }
            ]
        }
    ];
})();

/**
 * Real 360° photos shipped in ./pictures. They load after the demo scenes.
 * To add one: drop a 2:1 equirectangular image in ./pictures, list it here, then
 * run "node build-pictures.js" (it packs the folders into pictures.js so the page
 * also works when opened straight from disk, i.e. file://).
 */
window.DefaultPhotos = [
    { name: 'Aurora Night', src: 'pictures/bryan-goff-IuyhXAia8EA-unsplash.jpg', startLon: 0 },
    { name: 'Turquoise Lagoon', src: 'pictures/kris-guico-rsB-he-ye7w-unsplash.jpg', startLon: 0 },
    { name: 'Lakeside Pier', src: 'pictures/timothy-oldfield-luufnHoChRU-unsplash.jpg', startLon: 0 }
];
