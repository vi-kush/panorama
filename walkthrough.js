'use strict';

/**
 * Walkthrough mode: scroll to walk through a property described in tour.js.
 *
 *  - Forward glide     Each photo is seen on a sphere around the spot it was taken
 *                      from. The camera really moves between the two spots and the
 *                      photos blend, so the view pushes forward.
 *  - Projected photos  Both photos are projected onto a simple 3D model of the rooms,
 *                      so walls and doors slide past with real parallax.
 *  - Video walkthrough Scrolling scrubs a walking video back and forth.
 *
 * The two photo techniques are drawn by one fullscreen fragment shader that casts a
 * ray for every pixel; there is no scene geometry.
 */
(() => {
    const X = window.Explorer;
    const tour = window.SampleTour;
    if (!X || !tour || typeof THREE === 'undefined') return;

    const { view, state, camera, renderer, canvas, toast, clamp, rad, deg, wrapLon, lonLatToVector } = X;
    const $ = (id) => document.getElementById(id);

    // ─── Configuration ──────────────────────────────────────────────────────

    const WALK = {
        scrollPerLeg: 450,   // wheel distance between two stops
        scrollCap: 150,      // largest single wheel event counted (a hard flick can't skip stops)
        smoothing: 0.01,     // share of the remaining distance left after one second
        recenter: 0.02,      // how quickly a dragged view drifts back to the walking direction (per 16 ms)
        videoSeekEpsilon: 0.012,
        jumpOutMs: 120,      // fade to black before a jump…
        jumpInMs: 260,       // …and back in at the new spot
        jumpVideoWaitMs: 500, // longest wait for the video to reach the new frame
        // Where in a segment (0..1) the two photos cross-fade. Glide has no depth, so
        // the blend shows two rooms at once; a short window keeps that brief. Projected
        // photos line up, so they can blend over a longer stretch.
        blendWindow: { glide: [0.38, 0.62], projected: [0.25, 0.75] },
        markerHeight: 0.04,       // stop markers lie on the floor
        markerDiameter: 0.8,      // metres
        markerMinDistance: 0.9,   // no marker for the spot you are standing on
        planClickRadius: 14,      // px: how close a click must be to a stop on the floor plan
        maxRooms: 12,        // must match the shader arrays (tour.js header)
        maxSolids: 32
    };

    const TECHNIQUES = {
        glide: 'Photos blend while the camera glides between them. Simple, works for any photos.',
        projected: 'Photos are projected onto the room’s walls, so walls and doors slide past like real movement.',
        video: 'Scrolling plays a walking video forwards and backwards. Smoothest, but the view is fixed.'
    };

    const stops = tour.stops;
    const segments = stops.length - 1;
    const ready = { photos: false, video: false };

    // ─── Shader ─────────────────────────────────────────────────────────────
    // For each pixel: build the view ray, find where it meets either a sphere around
    // each photo's stop (glide) or the room model (projected), then look that point up
    // in each photo as seen from where that photo was taken, and blend the two.

    const VERTEX = /* glsl */ `
        varying vec2 vNdc;
        void main() {
            vNdc = position.xy;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }`;

    const FRAGMENT = /* glsl */ `
        uniform vec3 uCamPos;
        uniform vec3 uCamRight;
        uniform vec3 uCamUp;
        uniform vec3 uCamFwd;
        uniform float uTanHalf;
        uniform float uAspect;
        uniform int uMode;          // 0 = glide (spheres), 1 = projected (room model)
        uniform float uBlend;       // 0 = all photo A, 1 = all photo B
        uniform float uRadius;      // sphere radius for glide
        uniform vec3 uPosA;
        uniform vec3 uPosB;
        uniform sampler2D uTexA;
        uniform sampler2D uTexB;
        uniform int uRoomCount;
        uniform vec3 uRoomMin[${WALK.maxRooms}];
        uniform vec3 uRoomMax[${WALK.maxRooms}];
        uniform int uSolidCount;
        uniform vec3 uSolidMin[${WALK.maxSolids}];
        uniform vec3 uSolidMax[${WALK.maxSolids}];
        varying vec2 vNdc;

        const float PI = 3.14159265359;

        // Equirectangular lookup: u = azimuth from +x towards +z, v = 1 at the top.
        // Same convention as the 360° view and the sample renderer.
        vec2 equirect(vec3 d) {
            float u = fract(atan(d.z, d.x) / (2.0 * PI));
            float v = 1.0 - acos(clamp(d.y, -1.0, 1.0)) / PI;
            return vec2(u, v);
        }

        vec3 nonZero(vec3 d) {
            return vec3(abs(d.x) < 1e-6 ? 1e-6 : d.x, abs(d.y) < 1e-6 ? 1e-6 : d.y, abs(d.z) < 1e-6 ? 1e-6 : d.z);
        }

        // Distance along the ray to the wall of the union of rooms, starting inside it:
        // keep leaving whichever room we are in until no room contains the point.
        float roomExit(vec3 o, vec3 d) {
            vec3 sd = nonZero(d);
            float t = 0.0;
            for (int pass = 0; pass < 8; pass++) {
                vec3 p = o + d * t;
                float best = -1.0;
                for (int i = 0; i < ${WALK.maxRooms}; i++) {
                    if (i >= uRoomCount) break;
                    vec3 mn = uRoomMin[i];
                    vec3 mx = uRoomMax[i];
                    if (all(greaterThan(p, mn)) && all(lessThan(p, mx))) {
                        vec3 far = max((mn - p) / sd, (mx - p) / sd);
                        best = max(best, min(far.x, min(far.y, far.z)));
                    }
                }
                if (best < 0.0) break;
                t += best + 1e-4;
            }
            return t;
        }

        // Nearest furniture box in front of the wall
        float nearestSolid(vec3 o, vec3 d, float limit) {
            vec3 sd = nonZero(d);
            float nearest = limit;
            for (int i = 0; i < ${WALK.maxSolids}; i++) {
                if (i >= uSolidCount) break;
                vec3 t1 = (uSolidMin[i] - o) / sd;
                vec3 t2 = (uSolidMax[i] - o) / sd;
                vec3 tNear = min(t1, t2);
                vec3 tFar = max(t1, t2);
                float tn = max(tNear.x, max(tNear.y, tNear.z));
                float tf = min(tFar.x, min(tFar.y, tFar.z));
                if (tn <= tf && tn > 0.0 && tn < nearest) nearest = tn;
            }
            return nearest;
        }

        // Far side of a sphere around c, seen from inside
        float sphereExit(vec3 o, vec3 d, vec3 c, float r) {
            vec3 oc = o - c;
            float b = dot(d, oc);
            float k = dot(oc, oc) - r * r;
            return -b + sqrt(max(b * b - k, 0.0));
        }

        vec3 lookup(sampler2D tex, vec3 stop, vec3 point) {
            return texture2D(tex, equirect(normalize(point - stop))).rgb;
        }

        // Could the photo taken at \`stop\` actually see \`point\`? Cast a ray from the stop:
        // if something is hit before the point, the photo shows that something instead.
        float sees(vec3 stop, vec3 point) {
            vec3 toPoint = point - stop;
            float dist = length(toPoint);
            vec3 dir = toPoint / dist;
            float firstHit = nearestSolid(stop, dir, roomExit(stop, dir));
            return step(dist, firstHit + 0.02 + 0.002 * dist);
        }

        void main() {
            vec3 d = normalize(uCamFwd + uCamRight * (vNdc.x * uTanHalf * uAspect) + uCamUp * (vNdc.y * uTanHalf));
            vec3 color;
            if (uMode == 0) {
                vec3 hitA = uCamPos + d * sphereExit(uCamPos, d, uPosA, uRadius);
                vec3 hitB = uCamPos + d * sphereExit(uCamPos, d, uPosB, uRadius);
                color = mix(lookup(uTexA, uPosA, hitA), lookup(uTexB, uPosB, hitB), uBlend);
            } else {
                float wall = roomExit(uCamPos, d);
                vec3 hit = uCamPos + d * nearestSolid(uCamPos, d, wall);
                // A photo only paints what it could see. Where just one of them can see the
                // point (e.g. inside a room the other one looked at through a doorway),
                // that one is used on its own.
                float wA = (1.0 - uBlend) * sees(uPosA, hit);
                float wB = uBlend * sees(uPosB, hit);
                if (wA + wB < 1e-4) {
                    wA = 1.0 - uBlend;
                    wB = uBlend;
                }
                color = (lookup(uTexA, uPosA, hit) * wA + lookup(uTexB, uPosB, hit) * wB) / (wA + wB);
            }
            gl_FragColor = vec4(color, 1.0);
        }`;

    // ─── Renderer pieces, created on first use ──────────────────────────────

    let walkScene = null;
    let uniforms = null;

    function boxVectors(boxes, count, key) {
        return Array.from({ length: count }, (_, i) => new THREE.Vector3(...(boxes[i]?.[key] ?? [0, 0, 0])));
    }

    function setupShader() {
        if (walkScene) return;
        const v3 = () => ({ value: new THREE.Vector3() });
        uniforms = {
            uCamPos: v3(), uCamRight: v3(), uCamUp: v3(), uCamFwd: v3(),
            uTanHalf: { value: 1 }, uAspect: { value: 1 },
            uMode: { value: 0 }, uBlend: { value: 0 }, uRadius: { value: tour.glideRadius },
            uPosA: v3(), uPosB: v3(),
            uTexA: { value: null }, uTexB: { value: null },
            uRoomCount: { value: Math.min(tour.rooms.length, WALK.maxRooms) },
            uRoomMin: { value: boxVectors(tour.rooms, WALK.maxRooms, 'min') },
            uRoomMax: { value: boxVectors(tour.rooms, WALK.maxRooms, 'max') },
            uSolidCount: { value: Math.min(tour.solids.length, WALK.maxSolids) },
            uSolidMin: { value: boxVectors(tour.solids, WALK.maxSolids, 'min') },
            uSolidMax: { value: boxVectors(tour.solids, WALK.maxSolids, 'max') }
        };
        const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, depthTest: false, depthWrite: false });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.frustumCulled = false;
        walkScene = new THREE.Scene();
        walkScene.add(quad);
    }

    // ─── Assets ─────────────────────────────────────────────────────────────

    let textures = [];   // one per stop; stops that share a photo share the texture
    let loadingPhotos = null;

    function loadPhotos() {
        if (loadingPhotos) return loadingPhotos;
        const paths = [...new Set(stops.map((stop) => stop.photo))];
        loadingPhotos = Promise.all(paths.map(async (src) => {
            const img = await X.loadImage(X.photoUrl({ src }));
            const source = X.photoToCanvas(img).canvas;
            const texture = new THREE.CanvasTexture(source);
            // Once the GPU has its copy, release the 4096×2048 canvas (~34 MB each) from memory
            texture.onUpdate = () => {
                source.width = source.height = 1;
                texture.onUpdate = null;
            };
            texture.wrapS = THREE.RepeatWrapping; // the 360° seam blends instead of showing a line
            texture.minFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
            return [src, texture];
        })).then((loaded) => {
            const bySrc = new Map(loaded);
            textures = stops.map((stop) => bySrc.get(stop.photo));
            ready.photos = true;
            refreshTechniqueButtons();
            updateUi();
        }).catch((err) => {
            console.warn('Walkthrough photos failed to load:', err);
            toast(window.EmbeddedPhotos
                ? 'The sample photos could not be loaded. Check the files in /samples.'
                : 'Photos are missing from pictures.js. Run "node build-pictures.js" in this folder, then reload.');
            refreshTechniqueButtons();
        });
        return loadingPhotos;
    }

    const video = $('walk-video');
    let videoRequested = false;

    function loadVideo() {
        if (videoRequested || !tour.video) return;
        videoRequested = true;
        video.addEventListener('loadedmetadata', () => {
            ready.video = true;
            refreshTechniqueButtons();
            updateUi();
        }, { once: true });
        video.addEventListener('error', () => {
            ready.video = false;
            toast('The walkthrough video could not be loaded. Check samples/walkthrough.mp4.');
            refreshTechniqueButtons();
        }, { once: true });
        video.src = tour.video.src;
        video.load();
    }

    // ─── State ──────────────────────────────────────────────────────────────

    let technique = 'glide';
    let target = 0;   // 0..1 along the whole tour, set by scrolling
    let current = 0;  // eased towards target

    const smoothstep = (a, b, v) => {
        const t = clamp((v - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
    };

    // Direction the visitor faces (longitude, degrees, unwrapped) at a tour progress 0..1
    const headingAtProgress = (progress) => tour.headingAt(progress * segments);

    let lastHeading = 0;

    // ─── Controls ───────────────────────────────────────────────────────────

    const nearestStop = (progress) => Math.round(progress * segments);

    function goToStop(index) {
        target = clamp(index, 0, segments) / segments;
        X.markInput();
    }

    // Jump straight to a spot instead of walking there. Flying through every room on the way
    // is fast, dizzying movement, so cut with a short fade: out, move, wait until the new view
    // is ready to draw (textures uploaded, video frame decoded), in.
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fadeEl = $('fade');
    let jumping = false;
    let queuedJump = null;

    function videoSettled() {
        return new Promise((resolve) => {
            if (!video.seeking) return resolve();
            const done = () => {
                clearTimeout(timer);
                video.removeEventListener('seeked', done);
                resolve();
            };
            const timer = setTimeout(done, WALK.jumpVideoWaitMs);
            video.addEventListener('seeked', done);
        });
    }

    async function jumpTo(progress) {
        X.markInput();
        const destination = clamp(progress, 0, 1);
        if (jumping) {
            queuedJump = destination; // finish this cut first, then go to the latest choice
            return;
        }
        jumping = true;
        const fade = !reducedMotion.matches;

        if (fade) {
            fadeEl.style.transition = `opacity ${WALK.jumpOutMs}ms ease-out`;
            fadeEl.classList.add('on');
            await sleep(WALK.jumpOutMs);
        }

        // Arrive where the tour intends the visitor to look, with no easing in between
        target = current = destination;
        lastHeading = headingAtProgress(destination);
        view.lon = lastHeading;
        view.lat = 0;
        view.vLon = view.vLat = 0;

        if (fade) {
            await nextFrame();
            await nextFrame(); // the first draw at a new spot uploads its photo to the GPU
            if (technique === 'video') {
                await videoSettled();
                await nextFrame();
            }
            fadeEl.style.transition = `opacity ${WALK.jumpInMs}ms ease-in`;
            fadeEl.classList.remove('on');
            await sleep(WALK.jumpInMs);
            fadeEl.style.transition = '';
        }

        jumping = false;
        if (queuedJump !== null) {
            const next = queuedJump;
            queuedJump = null;
            jumpTo(next);
        }
    }

    const jumpToStop = (index) => jumpTo(clamp(index, 0, segments) / segments);

    function stepStop(direction) {
        const s = target * segments;
        goToStop(direction > 0 ? Math.floor(s + 0.01) + 1 : Math.ceil(s - 0.01) - 1);
    }

    function wheel(e) {
        if (jumping) return;
        const pixels = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
        const wholeTour = WALK.scrollPerLeg * segments;
        target = clamp(target + clamp(pixels, -WALK.scrollCap, WALK.scrollCap) / wholeTour, 0, 1);
    }

    function key(e) {
        switch (e.key) {
            case ' ': case 'PageDown': if (!jumping) stepStop(1); return true;
            case 'PageUp': if (!jumping) stepStop(-1); return true;
            case 'Home': jumpToStop(0); return true;
            case 'End': jumpToStop(segments); return true;
            default: return false;
        }
    }

    // ─── UI ─────────────────────────────────────────────────────────────────

    const ui = {
        root: $('walk-ui'),
        fill: $('walk-fill'),
        track: $('walk-track'),
        stops: $('walk-stops'),
        now: $('walk-now'),
        desc: $('tech-desc'),
        techniques: [...document.querySelectorAll('.technique')],
        dots: []
    };

    function buildStopMarkers() {
        stops.forEach((stop, i) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'stop-dot';
            dot.style.left = `${(i / segments) * 100}%`;
            dot.setAttribute('aria-label', `Go to ${stop.name}`);
            const label = document.createElement('span');
            label.textContent = stop.name;
            dot.append(label);
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                jumpToStop(i);
            });
            ui.stops.append(dot);
            ui.dots.push(dot);
        });
        // Clicking the bar itself jumps there
        ui.track.addEventListener('click', (e) => {
            const rect = ui.track.getBoundingClientRect();
            jumpTo((e.clientX - rect.left) / rect.width);
        });
    }

    function refreshTechniqueButtons() {
        for (const btn of ui.techniques) {
            const name = btn.dataset.tech;
            const unavailable = name === 'video' ? !tour.video : false;
            btn.disabled = unavailable;
            btn.setAttribute('aria-pressed', String(name === technique));
        }
        ui.desc.textContent = TECHNIQUES[technique];
    }

    function updateUi() {
        const s = current * segments;
        const near = nearestStop(current);
        ui.fill.style.width = `${current * 100}%`;
        ui.track.setAttribute('aria-valuenow', String(Math.round(current * 100)));
        ui.dots.forEach((dot, i) => {
            dot.classList.toggle('passed', s >= i - 0.01);
            dot.classList.toggle('near', i === near);
        });

        const needsPhotos = technique !== 'video';
        const loaded = needsPhotos ? ready.photos : ready.video;
        ui.now.textContent = loaded ? `${stops[near].name}  ·  stop ${near + 1} of ${stops.length}` : 'Loading…';
        $('scene-title').textContent = `${tour.name}: ${TECHNIQUES_LABEL[technique]}`;
    }

    const TECHNIQUES_LABEL = { glide: 'Forward glide', projected: 'Projected photos', video: 'Video walkthrough' };

    function setTechnique(name) {
        technique = name;
        const isVideo = name === 'video';
        video.hidden = !isVideo;
        canvas.style.visibility = isVideo ? 'hidden' : '';
        if (isVideo) {
            loadVideo();
            video.pause();
        } else {
            setupShader();
            uniforms.uMode.value = name === 'projected' ? 1 : 0;
            loadPhotos();
        }
        refreshTechniqueButtons();
        updateUi();
    }

    // ─── Per-frame drawing ──────────────────────────────────────────────────

    const camPos = new THREE.Vector3();
    const lookAt = new THREE.Vector3();

    function drawPhotos() {
        if (!ready.photos) {
            renderer.clear();
            return;
        }
        const s = current * segments;
        const i = Math.min(Math.floor(s), segments - 1);
        const f = s - i;
        const a = stops[i].pos;
        const b = stops[i + 1].pos;

        camPos.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
        camera.position.copy(camPos);
        lookAt.copy(lonLatToVector(view.lon, view.lat)).add(camPos);
        camera.lookAt(lookAt);
        camera.updateMatrixWorld();

        const m = camera.matrixWorld.elements;
        uniforms.uCamPos.value.copy(camPos);
        uniforms.uCamRight.value.set(m[0], m[1], m[2]);
        uniforms.uCamUp.value.set(m[4], m[5], m[6]);
        uniforms.uCamFwd.value.set(-m[8], -m[9], -m[10]);
        uniforms.uTanHalf.value = Math.tan(rad(camera.fov) / 2);
        uniforms.uAspect.value = camera.aspect;

        // Hold each photo for the first and last part of a segment, blend in the middle
        const [from, to] = WALK.blendWindow[technique];
        uniforms.uBlend.value = smoothstep(from, to, f);
        uniforms.uPosA.value.set(a[0], a[1], a[2]);
        uniforms.uPosB.value.set(b[0], b[1], b[2]);
        uniforms.uTexA.value = textures[i];
        uniforms.uTexB.value = textures[i + 1];

        renderer.render(walkScene, camera);
    }

    function updateVideo() {
        if (!ready.video || !isFinite(video.duration)) return;
        const time = current * Math.max(0, video.duration - 0.04);
        // Only seek when the last seek has finished, otherwise they queue up and stutter
        if (!video.seeking && Math.abs(video.currentTime - time) > WALK.videoSeekEpsilon) video.currentTime = time;
    }

    function frame(dt) {
        const gap = target - current;
        current = Math.abs(gap) < 1e-5 ? target : current + gap * (1 - Math.pow(WALK.smoothing, dt / 1000));

        // The view turns with the route (into a side room, back out again) in both
        // directions, so what the visitor was looking at stays in front of them. Dragging
        // adds to that, and while walking forward a dragged view drifts back to centre.
        const heading = headingAtProgress(current);
        view.lon += heading - lastHeading;
        lastHeading = heading;
        if (gap > 1e-4 && !X.isDragging() && technique !== 'video') {
            const step = dt / 16;
            view.lon += wrapLon(heading - view.lon) * clamp(WALK.recenter * step, 0, 1);
            view.lat += (0 - view.lat) * clamp(WALK.recenter * step, 0, 1);
        }

        let pose = null;
        if (technique === 'video') {
            updateVideo();
            pose = videoPoseNow();
        } else {
            drawPhotos();
            if (ready.photos) pose = photoPose();
        }
        updateMarkers(pose);
        drawPlan(pose);
        updateUi();
    }

    // ─── Places ─────────────────────────────────────────────────────────────
    // The route passes some spots more than once (the hallway, the living room), so stops
    // at the same spot are merged into one place for the map and the in-view markers.

    const places = [];
    stops.forEach((stop, index) => {
        let place = places.find((p) => Math.hypot(p.pos[0] - stop.pos[0], p.pos[2] - stop.pos[2]) < 0.05);
        if (!place) {
            place = { name: stop.name, pos: stop.pos, indices: [] };
            places.push(place);
        }
        place.indices.push(index);
    });

    // Which stop to travel to for a place: the visit closest to where the visitor is on the
    // route (the later one if both are equally close)
    function stopFor(place) {
        const s = current * segments;
        return place.indices.reduce((best, i) => (Math.abs(i - s) <= Math.abs(best - s) ? i : best), place.indices[0]);
    }

    // ─── Line of sight ──────────────────────────────────────────────────────
    // Markers must not show through walls, so ask the room model whether the camera can see
    // the spot. Same union-of-boxes logic as the shader.

    function wallDistance(o, d) {
        let t = 0;
        for (let pass = 0; pass < 10; pass++) {
            const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
            let best = -1;
            for (const r of tour.rooms) {
                if (p[0] > r.min[0] && p[0] < r.max[0] && p[1] > r.min[1] && p[1] < r.max[1] && p[2] > r.min[2] && p[2] < r.max[2]) {
                    let exit = Infinity;
                    for (let a = 0; a < 3; a++) {
                        if (Math.abs(d[a]) < 1e-9) continue;
                        exit = Math.min(exit, ((d[a] > 0 ? r.max[a] : r.min[a]) - p[a]) / d[a]);
                    }
                    best = Math.max(best, exit);
                }
            }
            if (best < 0) break;
            t += best + 1e-4;
        }
        return t;
    }

    function solidDistance(o, d, limit) {
        let nearest = limit;
        for (const b of tour.solids) {
            let near = -Infinity;
            let far = Infinity;
            for (let a = 0; a < 3; a++) {
                if (Math.abs(d[a]) < 1e-9) {
                    if (o[a] < b.min[a] || o[a] > b.max[a]) { near = Infinity; break; }
                    continue;
                }
                const t1 = (b.min[a] - o[a]) / d[a];
                const t2 = (b.max[a] - o[a]) / d[a];
                near = Math.max(near, Math.min(t1, t2));
                far = Math.min(far, Math.max(t1, t2));
            }
            if (near <= far && near > 0 && near < nearest) nearest = near;
        }
        return nearest;
    }

    function canSee(from, to) {
        const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const dist = Math.hypot(...delta);
        if (dist < 1e-6) return true;
        const dir = delta.map((v) => v / dist);
        return dist <= solidDistance(from, dir, wallDistance(from, dir)) + 0.05 + 0.002 * dist;
    }

    // ─── Camera pose for projecting things into the view ────────────────────
    // { pos, right, up, fwd, fpx (focal length in pixels), hfov (horizontal, radians) }

    function photoPose() {
        camera.updateMatrixWorld();
        const m = camera.matrixWorld.elements;
        const tanHalf = Math.tan(rad(camera.fov) / 2);
        return {
            pos: [camera.position.x, camera.position.y, camera.position.z],
            right: [m[0], m[1], m[2]],
            up: [m[4], m[5], m[6]],
            fwd: [-m[8], -m[9], -m[10]],
            fpx: window.innerHeight / 2 / tanHalf,
            hfov: 2 * Math.atan(tanHalf * camera.aspect)
        };
    }

    // The video was rendered from tour.videoPose(); the browser shows it scaled to cover the
    // window, so work out how the cropped image maps to the screen.
    function videoPoseNow() {
        if (!ready.video || !isFinite(video.duration)) return null;
        const v = tour.video;
        const progress = clamp(video.currentTime / Math.max(0.001, video.duration - 1 / v.fps), 0, 1);
        const { pos, forward } = tour.videoPose(progress * segments, video.currentTime);

        const length = Math.hypot(...forward);
        const fwd = forward.map((c) => c / length);
        const rl = Math.hypot(fwd[2], fwd[0]);
        const right = [-fwd[2] / rl, 0, fwd[0] / rl];
        const up = [
            right[1] * fwd[2] - right[2] * fwd[1],
            right[2] * fwd[0] - right[0] * fwd[2],
            right[0] * fwd[1] - right[1] * fwd[0]
        ];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const scale = Math.max(W / v.width, H / v.height); // object-fit: cover
        const fpx = (v.height * scale) / 2 / Math.tan(rad(v.fov) / 2);
        return { pos, right, up, fwd, fpx, hfov: 2 * Math.atan(W / 2 / fpx) };
    }

    // ─── Stop markers in the view ───────────────────────────────────────────

    const markerLayer = $('walk-hotspots');
    const markers = places.map((place) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'stop-hotspot';
        el.hidden = true;
        el.setAttribute('aria-label', `Go to ${place.name}`);
        const ring = document.createElement('span');
        ring.className = 'ring';
        const tip = document.createElement('span');
        tip.className = 'tip';
        tip.textContent = place.name;
        el.append(ring, tip);
        el.addEventListener('click', () => jumpToStop(stopFor(place)));
        markerLayer.append(el);
        return { place, el, ring, shown: false };
    });

    function updateMarkers(pose) {
        const W = window.innerWidth;
        const H = window.innerHeight;
        for (const marker of markers) {
            let visible = false;
            if (pose) {
                const target = [marker.place.pos[0], WALK.markerHeight, marker.place.pos[2]];
                const v = [target[0] - pose.pos[0], target[1] - pose.pos[1], target[2] - pose.pos[2]];
                const cx = v[0] * pose.right[0] + v[1] * pose.right[1] + v[2] * pose.right[2];
                const cy = v[0] * pose.up[0] + v[1] * pose.up[1] + v[2] * pose.up[2];
                const cz = v[0] * pose.fwd[0] + v[1] * pose.fwd[1] + v[2] * pose.fwd[2];
                const floorDistance = Math.hypot(v[0], v[2]);

                if (cz > 0.35 && floorDistance > WALK.markerMinDistance) {
                    const sx = W / 2 + (pose.fpx * cx) / cz;
                    const sy = H / 2 - (pose.fpx * cy) / cz;
                    if (sx > 12 && sx < W - 12 && sy > 12 && sy < H - 12 && canSee(pose.pos, target)) {  // fully on screen only
                        visible = true;
                        const size = clamp((pose.fpx * WALK.markerDiameter) / cz, 26, 76);
                        // A ring lying on the floor looks flatter the lower the camera is above it
                        const flatten = clamp(-v[1] / Math.hypot(...v), 0.3, 1);
                        marker.el.style.setProperty('--size', `${size.toFixed(1)}px`);
                        marker.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
                        marker.ring.style.transform = `scaleY(${flatten.toFixed(2)})`;
                    }
                }
            }
            if (visible === marker.shown) continue;
            marker.shown = visible;
            marker.el.hidden = !visible;
        }
    }

    // ─── Floor plan ─────────────────────────────────────────────────────────
    // Top-down plan drawn from the room model. It is turned so that "up" is the way the tour
    // starts out facing (+z), which also puts the left-hand rooms on the left of the plan.

    const plan = {
        canvas: $('walk-map'),
        ctx: $('walk-map').getContext('2d'),
        base: document.createElement('canvas'),
        pad: 14,
        scale: 1,
        width: 0,
        height: 0,
        bounds: tour.rooms.reduce((b, r) => ({
            minX: Math.min(b.minX, r.min[0]), maxX: Math.max(b.maxX, r.max[0]),
            minZ: Math.min(b.minZ, r.min[2]), maxZ: Math.max(b.maxZ, r.max[2])
        }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })
    };
    const planX = (x) => plan.pad + (plan.bounds.maxX - x) * plan.scale; // +x is on the visitor's left
    const planY = (z) => plan.pad + (plan.bounds.maxZ - z) * plan.scale; // +z is up the plan
    const isDoorway = (room) => room.name.endsWith('door');

    function drawPlanBase() {
        const c = plan.base.getContext('2d');
        const dpr = plan.dpr;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, plan.width, plan.height);

        // Walls: every room outline grown a little, then the floors painted over it. Where two
        // boxes overlap (a doorway bridging two rooms) the floor covers the wall, leaving an opening.
        const rect = (r, grow) => [
            planX(r.max[0]) - grow, planY(r.max[2]) - grow,
            planX(r.min[0]) - planX(r.max[0]) + 2 * grow, planY(r.min[2]) - planY(r.max[2]) + 2 * grow
        ];
        c.fillStyle = 'rgba(150, 158, 205, 0.9)';
        for (const r of tour.rooms) c.fillRect(...rect(r, 1.6));
        c.fillStyle = '#20243f';
        for (const r of tour.rooms) c.fillRect(...rect(r, 0));

        // Furniture
        c.fillStyle = 'rgba(255, 255, 255, 0.2)';
        for (const b of tour.solids) c.fillRect(...rect(b, 0));

        // Room names
        c.fillStyle = 'rgba(205, 210, 240, 0.6)';
        c.font = '600 9px system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        for (const r of tour.rooms) {
            if (isDoorway(r)) continue;
            const [x, y, w, h] = rect(r, 0);
            c.save();
            c.translate(x + w / 2, y + h / 2);
            if (h > 3 * w) c.rotate(-Math.PI / 2); // long narrow rooms: read along their length
            c.fillText(r.name, 0, 0);
            c.restore();
        }
    }

    function layoutPlan() {
        const { bounds, pad } = plan;
        plan.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = clamp(Math.round(window.innerWidth * 0.2), 150, 240);
        plan.scale = (cssWidth - 2 * pad) / (bounds.maxX - bounds.minX);
        plan.width = cssWidth;
        plan.height = Math.round((bounds.maxZ - bounds.minZ) * plan.scale + 2 * pad);

        for (const canvasEl of [plan.canvas, plan.base]) {
            canvasEl.width = Math.round(plan.width * plan.dpr);
            canvasEl.height = Math.round(plan.height * plan.dpr);
        }
        plan.canvas.style.width = `${plan.width}px`;
        plan.canvas.style.height = `${plan.height}px`;
        drawPlanBase();
    }

    // Where the visitor is and which way they face, taken from whatever is on screen
    function drawPlan(pose) {
        const c = plan.ctx;
        const s = current * segments;
        const position = pose ? pose.pos : tour.positionAt(s);
        const facing = pose ? Math.atan2(pose.fwd[2], pose.fwd[0]) : rad(view.lon); // radians from +x towards +z
        const hfov = pose ? pose.hfov : rad(75);

        c.setTransform(plan.dpr, 0, 0, plan.dpr, 0, 0);
        c.clearRect(0, 0, plan.width, plan.height);
        c.drawImage(plan.base, 0, 0, plan.width, plan.height);

        // Route: the whole way dimmed, the part already walked bright
        const through = (limit) => {
            c.beginPath();
            stops.forEach((stop, i) => {
                if (i > Math.floor(limit)) return;
                c.lineTo(planX(stop.pos[0]), planY(stop.pos[2]));
            });
            const [px, , pz] = tour.positionAt(limit);
            c.lineTo(planX(px), planY(pz));
        };
        c.lineWidth = 2;
        c.lineJoin = 'round';
        c.lineCap = 'round';
        c.strokeStyle = 'rgba(94, 225, 255, 0.28)';
        through(segments);
        c.stroke();
        c.strokeStyle = 'rgba(94, 225, 255, 0.95)';
        through(s);
        c.stroke();

        // Places along the route
        for (const place of places) {
            const x = planX(place.pos[0]);
            const y = planY(place.pos[2]);
            const passed = place.indices.some((i) => i <= s + 0.01);
            c.beginPath();
            c.arc(x, y, 3.2, 0, Math.PI * 2);
            c.fillStyle = passed ? '#5ee1ff' : '#20243f';
            c.fill();
            c.lineWidth = 1.5;
            c.strokeStyle = passed ? '#5ee1ff' : 'rgba(255, 255, 255, 0.75)';
            c.stroke();
        }

        // The visitor: a view cone showing the field of view, and a dot. On the plan +x points
        // left and +z points up, so a world direction (cos a, sin a) is (-cos a, -sin a) on screen.
        const px = planX(position[0]);
        const py = planY(position[2]);
        const angle = Math.atan2(-Math.sin(facing), -Math.cos(facing));
        const reach = 38;
        c.beginPath();
        c.moveTo(px, py);
        c.arc(px, py, reach, angle - hfov / 2, angle + hfov / 2);
        c.closePath();
        const cone = c.createRadialGradient(px, py, 0, px, py, reach);
        cone.addColorStop(0, 'rgba(94, 225, 255, 0.6)');
        cone.addColorStop(1, 'rgba(94, 225, 255, 0)');
        c.fillStyle = cone;
        c.fill();
        c.beginPath();
        c.arc(px, py, 5, 0, Math.PI * 2);
        c.fillStyle = '#ffffff';
        c.fill();
        c.lineWidth = 2.5;
        c.strokeStyle = '#5ee1ff';
        c.stroke();
    }

    // Click a stop on the plan to go there
    plan.canvas.addEventListener('click', (e) => {
        const rect = plan.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        let best = null;
        let bestDistance = WALK.planClickRadius;
        for (const place of places) {
            const d = Math.hypot(planX(place.pos[0]) - x, planY(place.pos[2]) - y);
            if (d < bestDistance) {
                best = place;
                bestDistance = d;
            }
        }
        if (best) jumpToStop(stopFor(best));
    });
    window.addEventListener('resize', () => {
        if (state.mode === 'walk') layoutPlan();
    });

    // ─── Enter / exit ───────────────────────────────────────────────────────

    // Point the view along the route at the current position
    function faceRoute() {
        lastHeading = headingAtProgress(current);
        view.lon = lastHeading;
        view.lat = 0;
        view.vLon = view.vLat = 0;
    }

    function enter() {
        ui.root.hidden = false;
        $('hint').textContent = 'Scroll to walk · drag to look around · Space for the next stop';
        view.targetFov = X.VIEW.fovDefault;
        plan.canvas.hidden = false;
        layoutPlan();
        faceRoute();
        setTechnique(technique);
    }

    function exit() {
        ui.root.hidden = true;
        plan.canvas.hidden = true;
        for (const marker of markers) {
            marker.shown = false;
            marker.el.hidden = true;
        }
        video.pause();
        video.hidden = true;
    }

    // ─── Boot ───────────────────────────────────────────────────────────────

    buildStopMarkers();
    for (const btn of ui.techniques) btn.addEventListener('click', () => setTechnique(btn.dataset.tech));
    $('walk-prev').addEventListener('click', () => stepStop(-1));
    $('walk-next').addEventListener('click', () => stepStop(1));
    refreshTechniqueButtons();

    X.hooks.walk = { enter, exit, frame, wheel, key };
})();
