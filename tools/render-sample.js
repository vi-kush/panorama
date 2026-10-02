#!/usr/bin/env node
'use strict';

/**
 * Renders the sample flat from tour.js: four 360° photos (samples/*.jpg) and a
 * walking video (samples/walkthrough.mp4). A tiny ray tracer, no dependencies
 * beyond Node and macOS (sips for JPEG, Swift/AVFoundation for H.264).
 *
 *   node tools/render-sample.js            everything
 *   node tools/render-sample.js photos     only the photos
 *   node tools/render-sample.js video      only the video
 *   node tools/render-sample.js preview    small previews into ./tools/preview
 */

const { Worker, isMainThread, parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tour = require(path.join(ROOT, 'tour.js'));

// ═════════════════════════════════════════════════════════════════════════
// Ray tracing core (runs inside the workers)
// ═════════════════════════════════════════════════════════════════════════

const ROOMS = tour.rooms;
const SOLIDS = tour.solids;
const EPS = 1e-4;
const MAX_PASSES = 8;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
};
const fract = (v) => v - Math.floor(v);
function hash2(a, b) {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

// Lighting zones: 0 = hallway + living room + doorways, 2 = bedroom, 3 = bathroom, 4 = second bedroom, 5 = kitchen.
// Light mostly stays in its own zone (there is no shadow casting, so this stands in for walls).
const ZONES = { 'Bedroom': 2, 'Bathroom': 3, 'Bedroom 2': 4, 'Kitchen': 5 };
const zoneOf = (ri) => ZONES[ROOMS[ri].name] ?? 0;
const isDoorway = (ri) => ROOMS[ri].name.endsWith('door');

const CEILING_Y = 2.6;
const LIGHTS = [
    { x: 0, z: 1.5, zone: 0 }, { x: 0, z: 3.6, zone: 0 }, { x: 0, z: 5.7, zone: 0 },
    { x: -1.2, z: 8.2, zone: 0 }, { x: 1.2, z: 8.2, zone: 0 }, { x: -1.2, z: 10.8, zone: 0 }, { x: 1.2, z: 10.8, zone: 0 },
    { x: -2.9, z: 4.75, zone: 2 }, { x: 2.1, z: 2.6, zone: 3 },
    { x: -4.7, z: 8.8, zone: 4 },
    { x: 4.4, z: 6.3, zone: 5 }, { x: 4.4, z: 8.2, zone: 5 }
];
// Window light sources (x, y, z) per zone
const WINDOW_LIGHTS = [
    { zone: 0, x: 0, y: 1.4, z: 12.5, k: 1.5 },
    { zone: 2, x: -2.7, y: 1.55, z: 3.0, k: 1.3 },
    { zone: 3, x: 2.4, y: 1.6, z: 1.2, k: 1.0 },
    { zone: 4, x: -4.7, y: 1.55, z: 10.8, k: 1.2 },
    { zone: 5, x: 4.7, y: 1.55, z: 5.2, k: 1.3 }
];

const LIVING_WINDOW = { x0: -1.7, x1: 1.7, y0: 0.55, y1: 2.3, z: 12.5 };
const BED_WINDOW = { x0: -3.8, x1: -1.6, y0: 0.9, y1: 2.2 };    // on the south wall (z = 3.0)
const BATH_WINDOW = { x0: 1.9, x1: 2.9, y0: 1.3, y1: 1.95 };    // on the south wall (z = 1.2)
const KITCHEN_WINDOW = { x0: 4.0, x1: 5.4, y0: 1.0, y1: 2.1 };  // on the south wall (z = 5.2)
const BED2_WINDOW = { x0: -5.4, x1: -4.0, y0: 0.9, y1: 2.2 };   // on the north wall (z = 10.8)
const RUGS = [
    { x0: -2.3, x1: 0.6, z0: 8.3, z1: 11.4, body: [0.44, 0.5, 0.55], border: [0.62, 0.55, 0.44], edge: [0.2, 0.22, 0.26] },   // living room
    { x0: -4.3, x1: -2.2, z0: 3.7, z1: 6.3, body: [0.66, 0.6, 0.5], border: [0.5, 0.46, 0.4], edge: [0.3, 0.27, 0.24] },      // bedroom
    { x0: -5.9, x1: -3.5, z0: 8.1, z1: 10.3, body: [0.74, 0.7, 0.6], border: [0.55, 0.5, 0.42], edge: [0.35, 0.3, 0.26] }     // second bedroom
];

const hit = { t: 0, axis: -1, sign: 0, solid: -1, nx: 0, ny: 0, nz: 0 };

function trace(ox, oy, oz, dx, dy, dz) {
    // 1. Walls: leave every room that contains the point until none does
    let t = 0;
    let axis = -1;
    let sign = 0;
    for (let it = 0; it < MAX_PASSES; it++) {
        const px = ox + dx * t;
        const py = oy + dy * t;
        const pz = oz + dz * t;
        let best = -1;
        let bAxis = 0;
        let bSign = 0;
        for (let i = 0; i < ROOMS.length; i++) {
            const r = ROOMS[i];
            if (px > r.min[0] && px < r.max[0] && py > r.min[1] && py < r.max[1] && pz > r.min[2] && pz < r.max[2]) {
                let te = Infinity;
                let a = 0;
                let s = 0;
                let tt;
                if (dx > 1e-9) { tt = (r.max[0] - px) / dx; if (tt < te) { te = tt; a = 0; s = 1; } }
                else if (dx < -1e-9) { tt = (r.min[0] - px) / dx; if (tt < te) { te = tt; a = 0; s = -1; } }
                if (dy > 1e-9) { tt = (r.max[1] - py) / dy; if (tt < te) { te = tt; a = 1; s = 1; } }
                else if (dy < -1e-9) { tt = (r.min[1] - py) / dy; if (tt < te) { te = tt; a = 1; s = -1; } }
                if (dz > 1e-9) { tt = (r.max[2] - pz) / dz; if (tt < te) { te = tt; a = 2; s = 1; } }
                else if (dz < -1e-9) { tt = (r.min[2] - pz) / dz; if (tt < te) { te = tt; a = 2; s = -1; } }
                if (te > best) { best = te; bAxis = a; bSign = s; }
            }
        }
        if (best < 0) break;
        t += best + EPS;
        axis = bAxis;
        sign = bSign;
    }
    hit.t = t;
    hit.axis = axis;
    hit.sign = sign;
    hit.solid = -1;

    // 2. Furniture in front of the wall
    for (let i = 0; i < SOLIDS.length; i++) {
        const b = SOLIDS[i];
        let tn = -Infinity;
        let tf = Infinity;
        let nAxis = 0;
        const o = [ox, oy, oz];
        const d = [dx, dy, dz];
        for (let a = 0; a < 3; a++) {
            if (Math.abs(d[a]) < 1e-9) {
                if (o[a] < b.min[a] || o[a] > b.max[a]) { tn = Infinity; break; }
                continue;
            }
            let t1 = (b.min[a] - o[a]) / d[a];
            let t2 = (b.max[a] - o[a]) / d[a];
            if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
            if (t1 > tn) { tn = t1; nAxis = a; }
            if (t2 < tf) tf = t2;
        }
        if (tn <= tf && tn > 0 && tn < hit.t) {
            hit.t = tn;
            hit.solid = i;
            hit.axis = nAxis;
            hit.sign = d[nAxis] > 0 ? -1 : 1; // outward normal = -ray direction along that axis
            hit.nx = hit.ny = hit.nz = 0;
            if (nAxis === 0) hit.nx = hit.sign;
            else if (nAxis === 1) hit.ny = hit.sign;
            else hit.nz = hit.sign;
        }
    }
}

// Which room box a point belongs to (first match wins, so doorways come last)
function roomAt(x, y, z) {
    const m = 1e-3;
    for (let i = 0; i < ROOMS.length; i++) {
        const r = ROOMS[i];
        if (x > r.min[0] - m && x < r.max[0] + m && y > r.min[1] - m && y < r.max[1] + m && z > r.min[2] - m && z < r.max[2] + m) return i;
    }
    return 0;
}

// Darkening in corners where two surfaces meet, and around the feet of furniture
function ambientOcclusion(x, y, z, hitAxis, isFloor, ri) {
    if (isDoorway(ri)) return 1;
    const name = ROOMS[ri].name;
    const r = ROOMS[ri];
    const p = [x, y, z];
    let ao = 1;
    for (let a = 0; a < 3; a++) {
        if (a === hitAxis) continue;
        for (let side = 0; side < 2; side++) {
            // The planes where hallway and living room join are not real walls
            if (a === 2 && ((name === 'Hallway' && side === 1) || (name === 'Living room' && side === 0))) continue;
            const dist = Math.abs(side ? r.max[a] - p[a] : p[a] - r.min[a]);
            ao *= 1 - 0.32 * Math.exp(-dist / 0.28);
        }
    }
    if (isFloor) {
        for (let i = 0; i < SOLIDS.length; i++) {
            const b = SOLIDS[i];
            const ddx = Math.max(b.min[0] - x, 0, x - b.max[0]);
            const ddz = Math.max(b.min[2] - z, 0, z - b.max[2]);
            ao *= 1 - 0.45 * Math.exp(-Math.hypot(ddx, ddz) / 0.18);
        }
    }
    return ao;
}

// Irradiance at a surface point: warm ceiling lights plus cool light from windows
const E = [0, 0, 0];
function lighting(x, y, z, nx, ny, nz, zone) {
    let er = 0.2;
    let eg = 0.2;
    let eb = 0.23;
    for (let i = 0; i < LIGHTS.length; i++) {
        const L = LIGHTS[i];
        const leak = L.zone === zone ? 1 : 0.1;
        const lx = L.x - x;
        const ly = CEILING_Y - 0.05 - y;
        const lz = L.z - z;
        const d2 = lx * lx + ly * ly + lz * lz;
        const inv = 1 / Math.sqrt(d2);
        const wrap = (nx * lx + ny * ly + nz * lz) * inv * 0.5 + 0.5;
        const k = (leak * 0.95 * wrap * wrap) / (1 + d2 * 0.45);
        er += k * 1.0;
        eg += k * 0.93;
        eb += k * 0.8;
    }
    for (let i = 0; i < WINDOW_LIGHTS.length; i++) {
        const W = WINDOW_LIGHTS[i];
        const leak = W.zone === zone ? 1 : 0.06;
        const wx = W.x - x;
        const wy = W.y - y;
        const wz = W.z - z;
        const wd2 = wx * wx + wy * wy + wz * wz;
        const wrapW = (nx * wx + ny * wy + nz * wz) / Math.sqrt(wd2) * 0.5 + 0.5;
        const kw = (leak * W.k * wrapW * wrapW) / (1 + wd2 * 0.08);
        er += kw * 0.85;
        eg += kw * 0.95;
        eb += kw * 1.1;
    }
    E[0] = er; E[1] = eg; E[2] = eb;
}

// ── Surface appearance ───────────────────────────────────────────────────

const COL = [0, 0, 0];
let emissive = false;

function setCol(r, g, b) { COL[0] = r; COL[1] = g; COL[2] = b; }
function dim(k) { COL[0] *= k; COL[1] *= k; COL[2] *= k; }

function woodFloor(x, z) {
    const plank = 0.16;
    const row = Math.floor((x + 10) / plank);
    const offset = hash2(row, 1) * 1.3;
    const board = Math.floor((z + offset) / 1.3);
    const tone = 0.84 + 0.3 * hash2(row, board);
    const grain = 1 + 0.07 * Math.sin((z + offset) * 38 + hash2(row, 7) * 6.28) + 0.04 * Math.sin(x * 220 + row);
    let seam = 1;
    const fx = fract((x + 10) / plank);
    const fz = fract((z + offset) / 1.3);
    if (fx < 0.045 || fx > 0.975) seam = 0.62;
    if (fz < 0.006 || fz > 0.994) seam = Math.min(seam, 0.7);
    const k = tone * grain * seam;
    setCol(0.64 * k, 0.46 * k, 0.3 * k);
}

function tileFloor(x, z, warm) {
    const s = warm ? 0.45 : 0.3;
    const fx = fract(x / s);
    const fz = fract(z / s);
    if (fx < 0.03 || fx > 0.97 || fz < 0.03 || fz > 0.97) { warm ? setCol(0.5, 0.45, 0.38) : setCol(0.5, 0.52, 0.53); return; }
    const tone = 0.9 + 0.06 * hash2(Math.floor(x / s), Math.floor(z / s));
    warm ? setCol(0.78 * tone, 0.68 * tone, 0.54 * tone) : setCol(0.74 * tone, 0.76 * tone, 0.78 * tone);
}

function rug(rg, x, z) {
    const edge = Math.min(x - rg.x0, rg.x1 - x, z - rg.z0, rg.z1 - z);
    if (edge < 0.05) setCol(rg.edge[0], rg.edge[1], rg.edge[2]);
    else if (edge < 0.2) setCol(rg.border[0], rg.border[1], rg.border[2]);
    else {
        const weave = 1 + 0.06 * Math.sin(x * 140) * Math.sin(z * 140);
        setCol(rg.body[0] * weave, rg.body[1] * weave, rg.body[2] * weave);
    }
}

function artFrame(u, v, u0, u1, v0, v1, palette) {
    // u, v: wall coordinates. Returns true when the point is on this frame.
    if (u < u0 || u > u1 || v < v0 || v > v1) return false;
    const b = 0.035;
    if (u < u0 + b || u > u1 - b || v < v0 + b || v > v1 - b) { setCol(0.1, 0.08, 0.07); return true; }
    if (u < u0 + 2 * b || u > u1 - 2 * b || v < v0 + 2 * b || v > v1 - 2 * b) { setCol(0.93, 0.92, 0.88); return true; }
    const cu = ((u - u0) / (u1 - u0)) * 2 - 1;
    const cv = ((v - v0) / (v1 - v0)) * 2 - 1;
    const r = Math.hypot(cu * 0.9, cv);
    if (r < 0.45) setCol(palette[0][0], palette[0][1], palette[0][2]);
    else if (cv < -0.2 && r < 0.9) setCol(palette[1][0], palette[1][1], palette[1][2]);
    else setCol(palette[2][0], palette[2][1], palette[2][2]);
    return true;
}

function doorPanel(u, v, uc, half) {
    // u: along the wall, v: height. White door with recessed panels, frame and handle.
    const du = u - uc;
    if (Math.abs(du) > half + 0.06 || v > 2.1) return false;
    if (Math.abs(du) > half || v > 2.04) { setCol(0.97, 0.96, 0.94); return true; }
    let shade = 0.94;
    const pu = Math.abs(du) / half;
    if (pu < 0.68 && ((v > 0.14 && v < 0.9) || (v > 1.1 && v < 1.9))) shade = 0.86;
    setCol(shade, shade * 0.99, shade * 0.96);
    if (Math.hypot(du - half * 0.78, v - 1.02) < 0.035) setCol(0.78, 0.72, 0.55);
    return true;
}

// A window pane with a frame and a centre bar; bright sky behind it
function windowPane(u, v, u0, u1, v0, v1, horizontalBar) {
    if (u < u0 || u > u1 || v < v0 || v > v1) return false;
    const edge = Math.min(u - u0, u1 - u, v - v0, v1 - v);
    if (edge < 0.05 || Math.abs(u - (u0 + u1) / 2) < 0.025 || (horizontalBar && Math.abs(v - (v0 + v1) / 2) < 0.025)) {
        setCol(0.96, 0.96, 0.95);
        emissive = false;
    } else {
        const g = (v - v0) / (v1 - v0);
        setCol(0.6 + 0.35 * (1 - g), 0.78 + 0.18 * (1 - g), 1.0);
        emissive = true;
    }
    return true;
}

function curtain(u, v, u0, u1, color) {
    if (u < u0 || u > u1 || v > 2.5 || v < 0.02) return false;
    const pleat = 0.86 + 0.14 * Math.sin(u * 55);
    setCol(color[0] * pleat, color[1] * pleat, color[2] * pleat);
    return true;
}

function wallColor(x, y, z, axis, sign, name) {
    emissive = false;
    // Door openings: white frame trim
    if (name.endsWith('door')) { setCol(0.97, 0.96, 0.94); return; }

    // Base paint
    if (name === 'Living room') {
        if (axis === 2 && sign === 1 && z > 12.4) setCol(0.17, 0.38, 0.4); // accent wall
        else setCol(0.8, 0.74, 0.64);
    } else if (name === 'Bedroom') {
        if (axis === 0 && sign === -1 && x < -4.7) setCol(0.38, 0.5, 0.56); // headboard wall
        else setCol(0.6, 0.68, 0.7);
    } else if (name === 'Bathroom') {
        setCol(0.62, 0.8, 0.82);
    } else if (name === 'Kitchen') {
        setCol(0.84, 0.8, 0.6);
    } else if (name === 'Bedroom 2') {
        if (axis === 0 && sign === -1 && x < -6.3) setCol(0.46, 0.58, 0.48); // headboard wall
        else setCol(0.66, 0.74, 0.64);
    } else {
        setCol(0.82, 0.78, 0.7);
    }
    const paint = 1 + 0.025 * (hash2(Math.floor(x * 9), Math.floor(y * 9) + Math.floor(z * 9)) - 0.5);
    dim(paint);

    // Bathroom: white tile up to 1.25 m (running bond), mirror and window above the fittings
    if (name === 'Bathroom') {
        const u = axis === 0 ? z : x;
        if (y < 1.25) {
            const row = Math.floor(y / 0.15);
            const fy = fract(y / 0.15);
            const fu = fract((u + (row % 2) * 0.15) / 0.3);
            if (fy < 0.07 || fu < 0.04) setCol(0.62, 0.64, 0.64);
            else setCol(0.93, 0.95, 0.95);
        } else if (y < 1.28) setCol(0.7, 0.72, 0.72);
    }

    // Skirting and top moulding
    if (name !== 'Bathroom') {
        if (y < 0.09) setCol(0.95, 0.95, 0.93);
        else if (y < 0.105) dim(0.7);
    }
    if (y > 2.55) setCol(0.95, 0.94, 0.92);

    // ── Per-room decoration ──
    if (name === 'Hallway') {
        // Entrance door, behind the first stop
        if (axis === 2 && sign === -1 && z < 0.1) {
            const ax = Math.abs(x);
            if (ax < 0.52 && y < 2.12) {
                if (ax > 0.45 || y > 2.06) setCol(0.95, 0.94, 0.92);
                else {
                    const k = 1 + 0.12 * Math.sin(x * 70 + Math.sin(y * 6));
                    setCol(0.3 * k, 0.18 * k, 0.1 * k);
                    if (Math.hypot(x - 0.32, y - 1.0) < 0.04) setCol(0.8, 0.72, 0.5);
                    if (Math.hypot(x, y - 1.55) < 0.016) setCol(0.02, 0.02, 0.03);
                }
            }
            return;
        }
        if (axis === 0) {
            if (x > 0) {
                // Bathroom is on this side (open doorway at z = 2.4); a closed door further along
                if (doorPanel(z, y, 5.0, 0.45)) return;
                if (artFrame(z, y, 3.35, 3.95, 1.25, 1.95, [[0.85, 0.5, 0.32], [0.3, 0.45, 0.5], [0.94, 0.9, 0.82]])) return;
            } else if (artFrame(z, y, 3.45, 4.05, 1.25, 1.95, [[0.2, 0.5, 0.55], [0.85, 0.65, 0.25], [0.94, 0.9, 0.82]])) return;
        }
        return;
    }

    if (name === 'Living room') {
        if (axis === 2 && z > 12.4) {
            const inX = x > LIVING_WINDOW.x0 && x < LIVING_WINDOW.x1;
            if (inX && y > LIVING_WINDOW.y0 && y < LIVING_WINDOW.y1) {
                windowPane(x, y, LIVING_WINDOW.x0, LIVING_WINDOW.x1, LIVING_WINDOW.y0, LIVING_WINDOW.y1, true);
                return;
            }
            if (curtain(x, y, -2.55, -1.72, [0.68, 0.66, 0.61]) || curtain(x, y, 1.72, 2.55, [0.68, 0.66, 0.61])) return;
            if (Math.abs(y - 2.45) < 0.012 && Math.abs(x) < 2.6) setCol(0.2, 0.2, 0.2); // curtain rod
        }
        if (axis === 0 && sign === -1 && x < 0) {
            if (artFrame(z, y, 8.95, 9.55, 1.25, 1.95, [[0.85, 0.5, 0.32], [0.3, 0.45, 0.5], [0.94, 0.9, 0.82]])) return;
            if (artFrame(z, y, 9.7, 10.3, 1.25, 1.95, [[0.2, 0.5, 0.55], [0.85, 0.65, 0.25], [0.94, 0.9, 0.82]])) return;
            if (artFrame(z, y, 10.45, 11.05, 1.25, 1.95, [[0.86, 0.66, 0.26], [0.7, 0.32, 0.25], [0.94, 0.9, 0.82]])) return;
        }
        return;
    }

    if (name === 'Bedroom') {
        // South wall window with curtains
        if (axis === 2 && sign === -1 && z < 3.1) {
            if (windowPane(x, y, BED_WINDOW.x0, BED_WINDOW.x1, BED_WINDOW.y0, BED_WINDOW.y1, true)) return;
            if (curtain(x, y, -4.3, -3.82, [0.78, 0.74, 0.68]) || curtain(x, y, -1.58, -1.1, [0.78, 0.74, 0.68])) return;
        }
        // Art above the bed
        if (axis === 0 && sign === -1 && x < -4.7) {
            if (artFrame(z, y, 4.3, 5.7, 1.35, 2.0, [[0.9, 0.62, 0.4], [0.3, 0.45, 0.5], [0.94, 0.9, 0.82]])) return;
        }
        return;
    }

    if (name === 'Kitchen') {
        // White tile splashback between the base and wall cabinets
        if (axis === 0 && sign === 1 && x > 6.2 && y > 0.88 && y < 1.52 && z > 5.38 && z < 8.12) {
            const row = Math.floor(y / 0.15);
            const fy = fract(y / 0.15);
            const fu = fract((z + (row % 2) * 0.15) / 0.3);
            if (fy < 0.07 || fu < 0.04) setCol(0.62, 0.62, 0.6);
            else setCol(0.94, 0.95, 0.93);
            return;
        }
        if (axis === 2 && sign === -1 && z < 5.3) {
            if (windowPane(x, y, KITCHEN_WINDOW.x0, KITCHEN_WINDOW.x1, KITCHEN_WINDOW.y0, KITCHEN_WINDOW.y1, true)) return;
        }
        return;
    }

    if (name === 'Bedroom 2') {
        if (axis === 2 && sign === 1 && z > 10.7) {
            if (windowPane(x, y, BED2_WINDOW.x0, BED2_WINDOW.x1, BED2_WINDOW.y0, BED2_WINDOW.y1, true)) return;
            if (curtain(x, y, -5.9, -5.42, [0.84, 0.78, 0.7]) || curtain(x, y, -3.98, -3.5, [0.84, 0.78, 0.7])) return;
        }
        if (axis === 0 && sign === -1 && x < -6.3) {
            if (artFrame(z, y, 8.65, 9.75, 1.5, 2.05, [[0.9, 0.55, 0.35], [0.35, 0.5, 0.45], [0.94, 0.92, 0.84]])) return;
        }
        return;
    }

    if (name === 'Bathroom') {
        if (axis === 2 && sign === -1 && z < 1.3) {
            // Frosted window over the tub
            if (windowPane(x, y, BATH_WINDOW.x0, BATH_WINDOW.x1, BATH_WINDOW.y0, BATH_WINDOW.y1, false)) return;
        }
        if (axis === 2 && sign === 1 && z > 3.9) {
            // Mirror above the vanity
            if (x > 1.6 && x < 2.4 && y > 1.1 && y < 2.0) {
                const edge = Math.min(x - 1.6, 2.4 - x, y - 1.1, 2.0 - y);
                if (edge < 0.03) setCol(0.35, 0.35, 0.36);
                else {
                    const sheen = 0.6 + 0.3 * (1 - (y - 1.1) / 0.9);
                    setCol(0.62 * sheen + 0.2, 0.7 * sheen + 0.2, 0.74 * sheen + 0.2);
                }
                return;
            }
        }
    }
}

function solidColor(i, x, y, z, nx, ny, nz) {
    const name = SOLIDS[i].name;
    emissive = false;
    if (name === 'shoe cabinet') {
        if (ny > 0.5) setCol(0.55, 0.4, 0.27);
        else {
            setCol(0.93, 0.93, 0.91);
            if (nx > 0.5) {
                if (Math.abs(z - 2.3) < 0.006) setCol(0.65, 0.65, 0.63);
                if (Math.hypot(z - 2.22, y - 0.85) < 0.018 || Math.hypot(z - 2.38, y - 0.85) < 0.018) setCol(0.7, 0.62, 0.45);
            }
        }
    } else if (name === 'sofa seat' || name === 'sofa back') {
        const weave = 1 + 0.05 * Math.sin(x * 160) * Math.sin(z * 160);
        setCol(0.4 * weave, 0.45 * weave, 0.5 * weave);
        if (ny > 0.5 && (Math.abs(fract((z - 8.6) / 0.5)) < 0.012 || Math.abs(fract((z - 8.6) / 0.5) - 1) < 0.012)) dim(0.6);
        if (name === 'sofa back' && Math.abs(y - 0.45) < 0.01) dim(0.7);
    } else if (name === 'ottoman') {
        const weave = 1 + 0.07 * Math.sin(x * 120) * Math.sin(z * 120);
        setCol(0.78 * weave, 0.55 * weave, 0.18 * weave);
        if (ny > 0.5 && Math.abs(Math.hypot(x + 0.65, z - 9.45) - 0.18) < 0.01) dim(0.7);
    } else if (name === 'tv unit') {
        const k = 1 + 0.1 * Math.sin(z * 45 + Math.sin(y * 9));
        setCol(0.22 * k, 0.15 * k, 0.1 * k);
        if (ny > 0.5) setCol(0.3, 0.21, 0.14);
    } else if (name === 'tv') {
        setCol(0.015, 0.015, 0.02);
        if (nx < -0.5) {
            const sx = (z - 9.2) / 1.2;
            const sy = (y - 1.0) / 0.75;
            if (sx > 0.025 && sx < 0.975 && sy > 0.04 && sy < 0.96) {
                setCol(0.05 + 0.08 * sy, 0.09 + 0.1 * sy, 0.16 + 0.12 * sy);
                emissive = true;
            }
        }
    } else if (name === 'bed') {
        if (y < 0.14) { setCol(0.34, 0.24, 0.17); return; }     // wooden base
        const linen = 1 + 0.03 * Math.sin(z * 90) * Math.sin(x * 70);
        setCol(0.9 * linen, 0.9 * linen, 0.87 * linen);          // sheets
        if (ny > 0.5) {
            // two pillows near the headboard
            for (const pz of [4.6, 5.4]) {
                const pr = Math.hypot((x + 4.35) / 0.32, (z - pz) / 0.32);
                if (pr < 1) { setCol(0.97, 0.97, 0.95); if (pr > 0.9) dim(0.82); }
            }
            // folded-back blanket over the foot of the bed
            if (x > -3.95) {
                const fold = x < -3.87;
                setCol(fold ? 0.93 : 0.2, fold ? 0.93 : 0.42, fold ? 0.9 : 0.45);
                if (!fold) dim(1 + 0.05 * Math.sin(z * 60));
            }
        }
    } else if (name === 'headboard') {
        setCol(0.3, 0.34, 0.42);
        if (nx > 0.5) {
            const panel = Math.abs(fract((z - 4.0) / 0.5) - 0.5) > 0.47;
            if (panel) dim(0.7);
        }
    } else if (name === 'nightstand') {
        const k = 1 + 0.08 * Math.sin(z * 50 + y * 10);
        setCol(0.5 * k, 0.36 * k, 0.25 * k);
        if (ny > 0.5) {
            const cz = (SOLIDS[i].min[2] + SOLIDS[i].max[2]) / 2;
            if (Math.hypot(x + 4.475, z - cz) < 0.07) { setCol(1.5, 1.2, 0.8); emissive = true; } // little lamp glow
        }
    } else if (name === 'wardrobe') {
        setCol(0.9, 0.89, 0.86);
        if (nz < -0.5) {
            const f = fract((x + 3.9) / 0.55);
            if (f < 0.012 || f > 0.988) setCol(0.6, 0.6, 0.58);
            if (Math.abs(f - 0.08) < 0.012 && y > 0.9 && y < 1.3) setCol(0.7, 0.64, 0.48);
        }
    } else if (name === 'bathtub') {
        setCol(0.95, 0.96, 0.96);
        if (ny > 0.5) {
            const inside = x > 1.5 && x < 3.2 && z > 1.28 && z < 1.82;
            if (inside) setCol(0.84, 0.9, 0.93);
        }
    } else if (name === 'toilet bowl' || name === 'toilet tank') {
        setCol(0.95, 0.96, 0.96);
        if (name === 'toilet bowl' && ny > 0.5) {
            const r = Math.hypot((x - 2.98) / 0.2, (z - 2.9) / 0.2);
            if (r < 1) { setCol(0.9, 0.92, 0.93); if (r > 0.88) dim(0.85); }
        }
    } else if (name === 'vanity') {
        if (ny > 0.5) {
            setCol(0.85, 0.85, 0.83);
            const r = Math.hypot((x - 2.0) / 0.26, (z - 3.7) / 0.2);
            if (r < 1) { setCol(0.9, 0.92, 0.93); if (r > 0.9) dim(0.8); }
        } else {
            setCol(0.9, 0.9, 0.88);
            if (nz < -0.5) {
                if (Math.abs(x - 2.0) < 0.006) setCol(0.62, 0.62, 0.6);
                if (Math.hypot(x - 1.92, y - 0.7) < 0.015 || Math.hypot(x - 2.08, y - 0.7) < 0.015) setCol(0.7, 0.64, 0.5);
            }
        }
    } else if (name === 'kitchen base') {
        if (ny > 0.5) {
            setCol(0.16, 0.16, 0.18); // dark worktop
            // sink
            if (x > 5.8 && x < 6.2 && z > 6.1 && z < 6.9) { setCol(0.72, 0.74, 0.76); if (Math.abs(z - 6.5) < 0.012) dim(0.6); }
            // hob
            for (const hz of [7.45, 7.8]) if (Math.abs(Math.hypot(x - 6.0, z - hz) - 0.09) < 0.012) setCol(0.55, 0.55, 0.58);
        } else {
            setCol(0.92, 0.91, 0.87);
            if (y < 0.1) setCol(0.2, 0.2, 0.22);                        // kickboard
            else if (nx < -0.5) {
                const f = fract((z - 5.4) / 0.45);
                if (f < 0.015 || f > 0.985) setCol(0.62, 0.62, 0.6);
                if (Math.abs(f - 0.5) < 0.12 && Math.abs(y - 0.78) < 0.012) setCol(0.72, 0.66, 0.5); // handles
            }
        }
    } else if (name === 'kitchen upper') {
        setCol(0.9, 0.88, 0.82);
        if (nx < -0.5) {
            const f = fract((z - 5.4) / 0.45);
            if (f < 0.015 || f > 0.985) setCol(0.62, 0.62, 0.6);
            if (Math.abs(f - 0.5) < 0.12 && Math.abs(y - 1.62) < 0.012) setCol(0.72, 0.66, 0.5);
        }
    } else if (name === 'fridge') {
        setCol(0.74, 0.76, 0.78);
        if (nx < -0.5) {
            if (Math.abs(y - 1.22) < 0.01) setCol(0.35, 0.36, 0.38);       // freezer / fridge split
            if (Math.abs(z - 8.3) < 0.012 && ((y > 1.3 && y < 1.7) || (y > 0.55 && y < 1.1))) setCol(0.45, 0.46, 0.48); // handles
        }
    } else if (name === 'island') {
        if (ny > 0.5) setCol(0.84, 0.82, 0.76);                             // pale stone top
        else {
            setCol(0.2, 0.36, 0.4);                                         // teal cabinets
            if (nz > 0.5 && (Math.abs(fract((x - 3.7) / 0.45)) < 0.015)) dim(0.6);
        }
    } else if (name === 'stool') {
        setCol(0.3, 0.22, 0.16);
        if (ny > 0.5) setCol(0.14, 0.14, 0.16);
    } else if (name === 'bed 2') {
        if (y < 0.12) { setCol(0.4, 0.3, 0.22); return; }
        const linen = 1 + 0.03 * Math.sin(z * 90) * Math.sin(x * 70);
        setCol(0.88 * linen, 0.9 * linen, 0.84 * linen);
        if (ny > 0.5) {
            const pr = Math.hypot((x + 5.85) / 0.3, (z - 9.2) / 0.38);
            if (pr < 1) { setCol(0.97, 0.97, 0.95); if (pr > 0.9) dim(0.82); }
            if (x > -5.45) {
                const fold = x < -5.37;
                setCol(fold ? 0.93 : 0.8, fold ? 0.93 : 0.58, fold ? 0.9 : 0.22);
                if (!fold) dim(1 + 0.05 * Math.sin(z * 60));
            }
        }
    } else if (name === 'headboard 2') {
        setCol(0.45, 0.33, 0.24);
    } else if (name === 'wardrobe 2') {
        setCol(0.92, 0.9, 0.84);
        if (nz > 0.5) {
            const f = fract((x + 5.6) / 0.55);
            if (f < 0.012 || f > 0.988) setCol(0.6, 0.6, 0.58);
            if (Math.abs(f - 0.9) < 0.012 && y > 0.9 && y < 1.3) setCol(0.7, 0.64, 0.48);
        }
    } else if (name === 'desk') {
        if (ny > 0.5) setCol(0.62, 0.47, 0.33);
        else {
            setCol(0.55, 0.4, 0.28);
            if (nz < -0.5) {
                const f = fract((x + 5.6) / 0.7);
                if (f < 0.015 || f > 0.985) dim(0.6);
                if (Math.abs(f - 0.5) < 0.08 && Math.abs(y - 0.55) < 0.012) setCol(0.75, 0.68, 0.5);
            }
        }
    } else {
        setCol(0.7, 0.7, 0.7);
    }
}

// Colour of whatever the ray hits; result in `out` (linear 0..1+)
const out = [0, 0, 0];
function shade(ox, oy, oz, dx, dy, dz) {
    trace(ox, oy, oz, dx, dy, dz);
    const x = ox + dx * hit.t;
    const y = oy + dy * hit.t;
    const z = oz + dz * hit.t;
    const ri = roomAt(x, y, z);
    const zone = zoneOf(ri);
    let nx;
    let ny;
    let nz;
    let ao;

    if (hit.solid >= 0) {
        nx = hit.nx; ny = hit.ny; nz = hit.nz;
        solidColor(hit.solid, x, y, z, nx, ny, nz);
        ao = y < 0.15 ? 0.78 + (y / 0.15) * 0.22 : 1;
        ao *= ny > 0.5 ? 1.15 : 1;
    } else {
        // Inward-facing normal of the wall that was hit
        nx = hit.axis === 0 ? -hit.sign : 0;
        ny = hit.axis === 1 ? -hit.sign : 0;
        nz = hit.axis === 2 ? -hit.sign : 0;
        emissive = false;
        const name = ROOMS[ri].name;

        if (hit.axis === 1 && hit.sign === -1) {
            // floor
            let onRug = null;
            for (const rg of RUGS) if (x > rg.x0 && x < rg.x1 && z > rg.z0 && z < rg.z1) onRug = rg;
            if (name === 'Bathroom') tileFloor(x, z, false);
            else if (name === 'Kitchen') tileFloor(x, z, true);
            else if (onRug) rug(onRug, x, z);
            else woodFloor(x, z);
            ao = ambientOcclusion(x, y, z, 1, true, ri);
        } else if (hit.axis === 1) {
            // ceiling with downlights
            setCol(0.94, 0.94, 0.92);
            for (let i = 0; i < LIGHTS.length; i++) {
                if (Math.hypot(x - LIGHTS[i].x, z - LIGHTS[i].z) < 0.13) { setCol(1.9, 1.8, 1.55); emissive = true; break; }
            }
            ao = ambientOcclusion(x, y, z, 1, false, ri);
        } else {
            wallColor(x, y, z, hit.axis, hit.sign, name);
            ao = ambientOcclusion(x, y, z, hit.axis, false, ri);
        }
    }

    if (emissive) {
        out[0] = COL[0] * 1.6; out[1] = COL[1] * 1.6; out[2] = COL[2] * 1.6;
    } else {
        lighting(x, y, z, nx, ny, nz, zone);
        out[0] = COL[0] * E[0] * ao;
        out[1] = COL[1] * E[1] * ao;
        out[2] = COL[2] * E[2] * ao;
    }
    // Soft tone map, then gamma
    for (let c = 0; c < 3; c++) {
        const v = 1 - Math.exp(-out[c] * 1.05);
        out[c] = Math.pow(v, 1 / 1.7);
    }
}

// ── Pixel loops ──────────────────────────────────────────────────────────

function renderEquirect(buf, W, H, y0, y1, cam, ss) {
    const [cx, cy, cz] = cam;
    const inv = 1 / (ss * ss);
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const u = (x + (sx + 0.5) / ss) / W;
                    const v = (y + (sy + 0.5) / ss) / H;
                    const phi = u * 2 * Math.PI;
                    const theta = v * Math.PI;
                    const st = Math.sin(theta);
                    shade(cx, cy, cz, st * Math.cos(phi), Math.cos(theta), st * Math.sin(phi));
                    r += out[0]; g += out[1]; b += out[2];
                }
            }
            const i = (y * W + x) * 4;
            buf[i] = r * inv * 255 + 0.5;
            buf[i + 1] = g * inv * 255 + 0.5;
            buf[i + 2] = b * inv * 255 + 0.5;
            buf[i + 3] = 255;
        }
    }
}

function renderPerspective(buf, W, H, y0, y1, cam, forward, fovDeg, ss) {
    const [cx, cy, cz] = cam;
    let [fx, fy, fz] = forward;
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl; fy /= fl; fz /= fl;
    // right = forward × up, trueUp = right × forward (same convention as three.js)
    let rx = -fz; let ry = 0; let rz = fx;
    const rl = Math.hypot(rx, ry, rz);
    rx /= rl; rz /= rl;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;
    const tanH = Math.tan((fovDeg * Math.PI) / 360);
    const aspect = W / H;
    const inv = 1 / (ss * ss);
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const nx = ((x + (sx + 0.5) / ss) / W) * 2 - 1;
                    const ny = 1 - ((y + (sy + 0.5) / ss) / H) * 2;
                    let dx = fx + rx * nx * tanH * aspect + ux * ny * tanH;
                    let dy = fy + ry * nx * tanH * aspect + uy * ny * tanH;
                    let dz = fz + rz * nx * tanH * aspect + uz * ny * tanH;
                    const l = Math.hypot(dx, dy, dz);
                    dx /= l; dy /= l; dz /= l;
                    shade(cx, cy, cz, dx, dy, dz);
                    r += out[0]; g += out[1]; b += out[2];
                }
            }
            const i = (y * W + x) * 4;
            buf[i] = r * inv * 255 + 0.5;
            buf[i + 1] = g * inv * 255 + 0.5;
            buf[i + 2] = b * inv * 255 + 0.5;
            buf[i + 3] = 255;
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
// Worker side
// ═════════════════════════════════════════════════════════════════════════

if (!isMainThread) {
    parentPort.on('message', (job) => {
        const buf = new Uint8ClampedArray(job.sab);
        if (job.kind === 'equirect') renderEquirect(buf, job.W, job.H, job.y0, job.y1, job.cam, job.ss);
        else renderPerspective(buf, job.W, job.H, job.y0, job.y1, job.cam, job.forward, job.fov, job.ss);
        parentPort.postMessage('done');
    });
    return;
}

// ═════════════════════════════════════════════════════════════════════════
// Main thread: pool, PNG/JPEG output, video pipeline
// ═════════════════════════════════════════════════════════════════════════

const WORKERS = Math.max(1, Math.min(os.cpus().length - 1, 8));
const pool = Array.from({ length: WORKERS }, () => new Worker(__filename));

function runJob(base, W, H) {
    // Split into many thin bands so the workers stay balanced
    const bands = Math.min(H, WORKERS * 6);
    let next = 0;
    return new Promise((resolve) => {
        let remaining = bands;
        const feed = (worker) => {
            if (next >= bands) return;
            const k = next++;
            const y0 = Math.floor((k * H) / bands);
            const y1 = Math.floor(((k + 1) * H) / bands);
            const onDone = () => {
                worker.off('message', onDone);
                if (--remaining === 0) resolve();
                else feed(worker);
            };
            worker.on('message', onDone);
            worker.postMessage({ ...base, y0, y1 });
        };
        pool.forEach(feed);
    });
}

function crc32(buf) {
    let c;
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        c = (crc ^ buf[i]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return ~crc >>> 0;
}

function writePng(file, rgba, W, H) {
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 3 + 1)] = 0;
        for (let x = 0; x < W; x++) {
            const s = (y * W + x) * 4;
            const d = y * (W * 3 + 1) + 1 + x * 3;
            raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0))
    ]));
}

const SAMPLES = path.join(ROOT, 'samples');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-render-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

async function renderPhotos({ width = 4096, ss = 2, outDir = SAMPLES } = {}) {
    fs.mkdirSync(outDir, { recursive: true });
    const W = width;
    const H = width / 2;
    const sab = new SharedArrayBuffer(W * H * 4);
    const pixels = new Uint8ClampedArray(sab);
    const done = new Set();
    for (const stop of tour.stops) {
        if (done.has(stop.photo)) continue; // same spot visited again: one render is enough
        done.add(stop.photo);
        const t0 = Date.now();
        await runJob({ kind: 'equirect', sab, W, H, cam: stop.pos, ss }, W, H);
        const png = path.join(TMP, path.basename(stop.photo, '.jpg') + '.png');
        writePng(png, pixels, W, H);
        const jpg = path.join(outDir, path.basename(stop.photo));
        execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '86', png, '--out', jpg], { stdio: 'ignore' });
        console.log(`  ${path.relative(ROOT, jpg)}  ${W}x${H}  ${(fs.statSync(jpg).size / 1048576).toFixed(2)} MB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
}


async function renderVideo() {
    const v = tour.video;
    const swiftSrc = path.join(__dirname, 'encode-video.swift');
    const bin = path.join(TMP, 'encode-video');
    console.log('  compiling the video encoder (Swift)…');
    execFileSync('swiftc', ['-O', '-swift-version', '5', swiftSrc, '-o', bin], { stdio: 'inherit' });

    fs.mkdirSync(SAMPLES, { recursive: true });
    const outFile = path.join(ROOT, v.src);
    const encoder = spawn(bin, [outFile, String(v.width), String(v.height), String(v.fps), String(5_000_000)], { stdio: ['pipe', 'inherit', 'inherit'] });
    const finished = new Promise((resolve, reject) => {
        encoder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`encoder exited with ${code}`))));
        encoder.on('error', reject);
    });

    const total = Math.round(v.seconds * v.fps);
    const sab = new SharedArrayBuffer(v.width * v.height * 4);
    const pixels = new Uint8ClampedArray(sab);
    const bgra = Buffer.alloc(v.width * v.height * 4);
    const segments = tour.stops.length - 1;
    const t0 = Date.now();

    for (let frame = 0; frame < total; frame++) {
        const time = frame / v.fps;
        const s = (frame / (total - 1)) * segments;
        const { pos: cam, forward } = tour.videoPose(s, time);

        await runJob({ kind: 'persp', sab, W: v.width, H: v.height, cam, forward, fov: v.fov, ss: 2 }, v.width, v.height);
        for (let i = 0; i < pixels.length; i += 4) {
            bgra[i] = pixels[i + 2]; bgra[i + 1] = pixels[i + 1]; bgra[i + 2] = pixels[i]; bgra[i + 3] = 255;
        }
        if (!encoder.stdin.write(bgra)) await new Promise((r) => encoder.stdin.once('drain', r));
        if (frame % 24 === 0) process.stdout.write(`\r  frame ${frame + 1}/${total}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    encoder.stdin.end();
    await finished;
    console.log(`\n  ${path.relative(ROOT, outFile)}  ${v.width}x${v.height}  ${v.fps} fps  ${v.seconds}s  ${(fs.statSync(outFile).size / 1048576).toFixed(2)} MB`);
}

(async () => {
    const what = process.argv[2] || 'all';
    try {
        if (what === 'preview') {
            const dir = path.join(__dirname, 'preview');
            console.log('Rendering previews…');
            await renderPhotos({ width: 1536, ss: 1, outDir: dir });
        } else {
            if (what === 'all' || what === 'photos') {
                console.log('Rendering the 360° photos…');
                await renderPhotos();
            }
            if (what === 'all' || what === 'video') {
                console.log('Rendering the walking video…');
                await renderVideo();
            }
        }
    } finally {
        pool.forEach((w) => w.terminate());
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
