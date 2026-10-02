'use strict';

/**
 * Panorama Explorer: a 360° viewer with linked scenes (hotspots), an edit mode
 * for placing links, and support for the user's own equirectangular photos.
 * Rendering uses Three.js (loaded from a CDN in index.html).
 */
(() => {
    // ─── Configuration ──────────────────────────────────────────────────────

    const VIEW = {
        fovMin: 30,
        fovMax: 100,
        fovDefault: 75,
        latLimit: 85,
        wheelZoom: 0.04,       // degrees of FOV per wheel delta
        friction: 0.92,        // inertia kept per 16 ms after release
        autoRotateSpeed: 0.05, // degrees per 16 ms
        autoRotateDelayMs: 2500,
        fadeMs: 330,
        dragThresholdPx: 5,
        sphereRadius: 500,
        hotspotDistance: 400
    };

    const MAX_PHOTO_WIDTH = 6144; // keeps several large photos within a sane memory budget

    const state = {
        scenes: [],
        current: -1,
        autoRotate: true,
        editing: false,
        busy: false,
        lastInput: 0,
        mode: 'view'          // 'view' (360° scenes) or 'walk' (walkthrough)
    };

    // Filled in by walkthrough.js: { enter, exit, frame, wheel, key }
    const hooks = { walk: null };

    const view = { lon: 0, lat: 0, fov: VIEW.fovDefault, targetFov: VIEW.fovDefault, vLon: 0, vLat: 0 };

    // ─── Helpers ────────────────────────────────────────────────────────────

    const $ = (id) => document.getElementById(id);
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rad = (deg) => (deg * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

    // Direction vector for a longitude / latitude pair (degrees)
    function lonLatToVector(lon, lat, length = 1) {
        const phi = rad(90 - lat);
        const theta = rad(lon);
        return new THREE.Vector3(
            length * Math.sin(phi) * Math.cos(theta),
            length * Math.cos(phi),
            length * Math.sin(phi) * Math.sin(theta)
        );
    }

    let toastTimer = 0;
    function toast(message) {
        const el = $('toast');
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
    }

    // ─── Three.js setup ─────────────────────────────────────────────────────

    const canvas = $('view');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const camera = new THREE.PerspectiveCamera(view.fov, 1, 0.1, 1100);
    const threeScene = new THREE.Scene();

    const sphereGeometry = new THREE.SphereGeometry(VIEW.sphereRadius, 64, 40);
    sphereGeometry.scale(-1, 1, 1); // look at the inside of the sphere
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    threeScene.add(new THREE.Mesh(sphereGeometry, sphereMaterial));

    function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    }

    // Textures are created per scene (never re-pointed), since a texture's size is fixed on upload
    function applyTexture(source) {
        const texture = new THREE.CanvasTexture(source);
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;

        const previous = sphereMaterial.map;
        sphereMaterial.map = texture;
        sphereMaterial.color.setHex(0xffffff);
        sphereMaterial.needsUpdate = true;
        if (previous) previous.dispose();
    }

    // ─── Scenes ─────────────────────────────────────────────────────────────

    function makeThumbnail(source) {
        const thumb = document.createElement('canvas');
        thumb.width = 264;
        thumb.height = 148;
        thumb.getContext('2d').drawImage(source, 0, 0, thumb.width, thumb.height);
        return thumb.toDataURL('image/jpeg', 0.75);
    }

    function addScene({ name, canvas: source, hotspots = [], startLon = 0 }) {
        state.scenes.push({ name, canvas: source, hotspots, startLon, thumb: makeThumbnail(source) });
        renderStrip();
        return state.scenes.length - 1;
    }

    function setScene(index, look) {
        const scene = state.scenes[index];
        state.current = index;
        closeLinkForm();
        applyTexture(scene.canvas);

        view.lon = look?.lon ?? scene.startLon;
        view.lat = look?.lat ?? 0;
        view.vLon = view.vLat = 0;

        $('scene-title').textContent = scene.name;
        renderStrip();
        renderHotspots();
    }

    async function goTo(index, look) {
        if (state.busy || index === state.current || !state.scenes[index]) return;
        state.busy = true;
        $('fade').classList.add('on');
        await sleep(VIEW.fadeMs);
        setScene(index, look);
        $('fade').classList.remove('on');
        await sleep(VIEW.fadeMs);
        state.busy = false;
    }

    function renderStrip() {
        const strip = $('strip');
        strip.replaceChildren();
        state.scenes.forEach((scene, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'thumb' + (i === state.current ? ' active' : '');
            btn.style.backgroundImage = `url(${scene.thumb})`;
            btn.setAttribute('aria-label', `Open scene: ${scene.name}`);
            btn.setAttribute('aria-current', String(i === state.current));
            const label = document.createElement('span');
            label.textContent = scene.name;
            btn.append(label);
            btn.addEventListener('click', () => goTo(i));
            strip.append(btn);
        });
    }

    // ─── Hotspots ───────────────────────────────────────────────────────────

    let hotspotEls = [];

    function renderHotspots() {
        const layer = $('hotspots');
        layer.replaceChildren();
        hotspotEls = [];

        const scene = state.scenes[state.current];
        if (!scene) return;

        scene.hotspots.forEach((hotspot, i) => {
            const target = state.scenes[hotspot.target];
            if (!target) return;

            const el = document.createElement('div');
            el.className = 'hotspot hidden';
            el.tabIndex = 0;
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', hotspot.label || `Go to ${target.name}`);
            el.textContent = '➜';

            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = hotspot.label || `Go to ${target.name}`;

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remove';
            remove.textContent = '×';
            remove.setAttribute('aria-label', 'Delete this link');
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                scene.hotspots.splice(i, 1);
                renderHotspots();
            });

            el.append(label, remove);
            // Links work in edit mode too, so a new one can be tried straight away
            // (the × deletes it; clicking empty space adds another)
            const go = () => goTo(hotspot.target, hotspot.arrive);
            el.addEventListener('click', go);
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    go();
                }
            });

            layer.append(el);
            hotspotEls.push({ el, vector: lonLatToVector(hotspot.lon, hotspot.lat, VIEW.hotspotDistance) });
        });
    }

    const projected = new THREE.Vector3();
    const forward = new THREE.Vector3();

    function positionHotspots() {
        camera.getWorldDirection(forward);
        const w = window.innerWidth;
        const h = window.innerHeight;
        for (const { el, vector } of hotspotEls) {
            // Hide anything behind the camera (the projection mirrors those points)
            const inFront = vector.dot(forward) > 0;
            el.classList.toggle('hidden', !inFront);
            if (!inFront) continue;
            projected.copy(vector).project(camera);
            const x = (projected.x * 0.5 + 0.5) * w;
            const y = (-projected.y * 0.5 + 0.5) * h;
            el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        }
    }

    // ─── Input: drag, pinch, wheel, keyboard ────────────────────────────────

    const pointers = new Map();
    let drag = null;       // { moved, lastX, lastY, lastT }
    let pinchStart = null; // { distance, fov }

    function markInput() {
        state.lastInput = performance.now();
        $('hint').classList.add('gone');
    }

    function pinchDistance() {
        const [a, b] = [...pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        markInput();

        if (pointers.size === 1) {
            drag = { moved: 0, lastX: e.clientX, lastY: e.clientY, lastT: e.timeStamp, startX: e.clientX, startY: e.clientY };
            view.vLon = view.vLat = 0;
            canvas.classList.add('dragging');
        } else if (pointers.size === 2) {
            pinchStart = { distance: pinchDistance(), fov: view.targetFov };
            drag = null;
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        markInput();

        if (pointers.size === 2 && pinchStart) {
            view.targetFov = clamp(pinchStart.fov * (pinchStart.distance / pinchDistance()), VIEW.fovMin, VIEW.fovMax);
            return;
        }
        if (!drag) return;

        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        const dt = Math.max(8, e.timeStamp - drag.lastT);
        drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY));

        // Degrees per pixel scale with the zoom, so the image sticks to the finger
        const k = view.fov / window.innerHeight;
        view.lon -= dx * k;
        view.lat = clamp(view.lat + dy * k, -VIEW.latLimit, VIEW.latLimit);
        view.vLon = ((-dx * k) / dt) * 16; // velocity in degrees per 16 ms, used for inertia
        view.vLat = ((dy * k) / dt) * 16;

        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        drag.lastT = e.timeStamp;
    });

    function endPointer(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        canvas.classList.remove('dragging');
        pinchStart = null;

        const wasClick = drag && drag.moved < VIEW.dragThresholdPx && e.type === 'pointerup';
        if (wasClick && state.editing) beginPlacingLink(e.clientX, e.clientY);

        // A fast flick keeps spinning; a held-still release stops dead
        if (drag && e.timeStamp - drag.lastT > 80) view.vLon = view.vLat = 0;
        drag = null;
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    $('stage').addEventListener('wheel', (e) => {
        e.preventDefault();
        markInput();
        if (state.mode === 'walk') {
            hooks.walk?.wheel(e);
            return;
        }
        view.targetFov = clamp(view.targetFov + e.deltaY * VIEW.wheelZoom, VIEW.fovMin, VIEW.fovMax);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        if (e.target.closest?.('input, select, textarea')) return;
        if (state.mode === 'walk' && hooks.walk?.key(e)) {
            e.preventDefault();
            markInput();
            return;
        }
        const step = view.fov / 12;
        switch (e.key) {
            case 'ArrowLeft':  view.lon -= step; break;
            case 'ArrowRight': view.lon += step; break;
            case 'ArrowUp':    view.lat = clamp(view.lat + step, -VIEW.latLimit, VIEW.latLimit); break;
            case 'ArrowDown':  view.lat = clamp(view.lat - step, -VIEW.latLimit, VIEW.latLimit); break;
            case '+': case '=': view.targetFov = clamp(view.targetFov - 6, VIEW.fovMin, VIEW.fovMax); break;
            case '-': case '_': view.targetFov = clamp(view.targetFov + 6, VIEW.fovMin, VIEW.fovMax); break;
            case 'f': toggleFullscreen(); return;
            default: return;
        }
        e.preventDefault();
        markInput();
    });

    // ─── Edit mode: placing links ───────────────────────────────────────────

    let pendingLink = null; // { lon, lat }

    // Convert a screen point into the longitude / latitude it looks at
    function screenToLonLat(clientX, clientY) {
        const ndc = new THREE.Vector3(
            (clientX / window.innerWidth) * 2 - 1,
            -(clientY / window.innerHeight) * 2 + 1,
            0.5
        );
        ndc.unproject(camera).normalize();
        return { lon: wrapLon(deg(Math.atan2(ndc.z, ndc.x))), lat: deg(Math.asin(clamp(ndc.y, -1, 1))) };
    }

    function beginPlacingLink(clientX, clientY) {
        const others = state.scenes.map((scene, i) => ({ scene, i })).filter(({ i }) => i !== state.current);
        if (others.length === 0) {
            toast('Add another photo first: a link needs a scene to go to.');
            return;
        }

        pendingLink = screenToLonLat(clientX, clientY);

        const select = $('link-target');
        select.replaceChildren(...others.map(({ scene, i }) => new Option(scene.name, String(i))));
        $('link-label').value = '';

        const form = $('link-form');
        form.hidden = false;
        const x = clamp(clientX + 16, 12, window.innerWidth - form.offsetWidth - 12);
        const y = clamp(clientY - 20, 70, window.innerHeight - form.offsetHeight - 120);
        form.style.left = `${x}px`;
        form.style.top = `${y}px`;
        select.focus();
    }

    function closeLinkForm() {
        $('link-form').hidden = true;
        pendingLink = null;
    }

    $('link-form').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!pendingLink) return;
        const target = Number($('link-target').value);
        const label = $('link-label').value.trim() || `Go to ${state.scenes[target].name}`;
        state.scenes[state.current].hotspots.push({ ...pendingLink, target, label });
        closeLinkForm();
        renderHotspots();
        toast('Link added. Click it to try it out.');
    });
    $('link-cancel').addEventListener('click', closeLinkForm);
    $('link-form').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLinkForm();
    });

    function setEditing(on) {
        state.editing = on;
        document.body.classList.toggle('editing', on);
        $('btn-edit').setAttribute('aria-pressed', String(on));
        $('edit-banner').hidden = !on;
        if (!on) closeLinkForm();
    }

    // ─── Toolbar ────────────────────────────────────────────────────────────

    function toggleFullscreen() {
        if (!document.fullscreenEnabled) return;
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch((err) => toast(`Fullscreen failed: ${err.message}`));
    }

    $('btn-rotate').addEventListener('click', () => {
        state.autoRotate = !state.autoRotate;
        $('btn-rotate').setAttribute('aria-pressed', String(state.autoRotate));
    });
    $('btn-edit').addEventListener('click', () => setEditing(!state.editing));
    $('btn-full').addEventListener('click', toggleFullscreen);
    $('btn-add').addEventListener('click', () => $('file-input').click());

    // ─── Adding your own photos ─────────────────────────────────────────────

    // Accepts a File (upload / drop) or a URL (bundled photos)
    function loadImage(source) {
        return new Promise((resolve, reject) => {
            const isFile = typeof source !== 'string';
            const url = isFile ? URL.createObjectURL(source) : source;
            const img = new Image();
            img.onload = () => {
                if (isFile) URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                if (isFile) URL.revokeObjectURL(url);
                reject(new Error('not a readable image'));
            };
            img.src = url;
        });
    }

    // Average colour of a strip of the image, used to fill the empty sky / ground
    function averageColor(img, sy, sh) {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 1;
        const pctx = probe.getContext('2d');
        pctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, 0, 1, 1);
        const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
        return `rgb(${r},${g},${b})`;
    }

    // Draw a photo onto a canvas the GPU can use. A 360° view must be 2:1: wider photos
    // (panoramas that don't reach straight up and down) are centred on a 2:1 canvas so
    // the geometry stays correct; narrower ones are stretched.
    function photoToCanvas(img) {
        const maxWidth = Math.min(renderer.capabilities.maxTextureSize, MAX_PHOTO_WIDTH);
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const out = document.createElement('canvas');
        const octx = out.getContext('2d');
        const ratio = img.naturalWidth / img.naturalHeight;

        if (ratio > 2.05) {
            const fullHeight = Math.round(w / 2);
            const top = Math.round((fullHeight - h) / 2);
            out.width = w;
            out.height = fullHeight;
            const strip = Math.max(1, Math.round(img.naturalHeight * 0.02));
            octx.fillStyle = averageColor(img, 0, strip);
            octx.fillRect(0, 0, w, top);
            octx.fillStyle = averageColor(img, img.naturalHeight - strip, strip);
            octx.fillRect(0, top + h, w, fullHeight - top - h);
            octx.drawImage(img, 0, top, w, h);
        } else {
            out.width = w;
            out.height = h;
            octx.drawImage(img, 0, 0, w, h);
        }
        return { canvas: out, stretched: ratio < 1.95 };
    }

    async function addPhoto(file) {
        if (!file.type.startsWith('image/')) {
            toast(`${file.name} is not an image.`);
            return -1;
        }
        let img;
        try {
            img = await loadImage(file);
        } catch (err) {
            toast(`Couldn't open ${file.name}: ${err.message}.`);
            return -1;
        }

        const { canvas: source, stretched } = photoToCanvas(img);
        if (stretched) toast(`${file.name} is taller than 2:1, so it will look stretched. 360° photos are 2:1.`);

        return addScene({ name: file.name.replace(/\.[^.]+$/, ''), canvas: source });
    }

    // Embedded data URI (pictures.js) first: it works from file://. Plain path otherwise.
    const photoUrl = (photo) => window.EmbeddedPhotos?.[photo.src] ?? photo.src;

    // Bundled photos: loaded in parallel, added in the listed order
    async function loadDefaultPhotos() {
        const results = await Promise.allSettled(window.DefaultPhotos.map((photo) => loadImage(photoUrl(photo))));
        let failed = 0;
        results.forEach((result, i) => {
            const photo = window.DefaultPhotos[i];
            try {
                if (result.status !== 'fulfilled') throw result.reason;
                addScene({ name: photo.name, canvas: photoToCanvas(result.value).canvas, startLon: photo.startLon });
            } catch (err) {
                failed++;
                console.warn(`Could not load ${photo.src}:`, err);
            }
        });
        if (failed) {
            toast(window.EmbeddedPhotos
                ? `${failed} bundled photo${failed > 1 ? 's' : ''} failed to load. Check the files in /pictures.`
                : 'Photos are missing from pictures.js. Run "node build-pictures.js" in this folder, then reload.');
        }
    }

    async function addPhotos(files) {
        let first = -1;
        for (const file of files) {
            const index = await addPhoto(file);
            if (first === -1 && index !== -1) first = index;
        }
        if (first !== -1) goTo(first);
    }

    $('file-input').addEventListener('change', (e) => {
        addPhotos([...e.target.files]);
        e.target.value = '';
    });

    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        dragDepth++;
        $('drop').hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) $('drop').hidden = true;
    });
    window.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        $('drop').hidden = true;
        addPhotos([...e.dataTransfer.files]);
    });

    // ─── Modes ──────────────────────────────────────────────────────────────

    const viewHint = $('hint').textContent;

    function setMode(mode) {
        if (state.mode === mode) return;
        if (mode === 'walk' && !hooks.walk) {
            toast('The walkthrough could not load. Check the console for errors.');
            return;
        }
        state.mode = mode;
        document.body.classList.toggle('mode-walk', mode === 'walk');
        $('mode-view').setAttribute('aria-pressed', String(mode === 'view'));
        $('mode-walk').setAttribute('aria-pressed', String(mode === 'walk'));

        if (mode === 'walk') {
            setEditing(false);
            hooks.walk.enter();
        } else {
            hooks.walk?.exit();
            camera.position.set(0, 0, 0); // the 360° view always looks from the centre
            view.targetFov = VIEW.fovDefault;
            canvas.style.visibility = '';
            $('hint').textContent = viewHint;
            $('scene-title').textContent = state.scenes[state.current]?.name ?? '';
        }
        $('hint').classList.remove('gone');
        state.lastInput = performance.now();
    }

    $('mode-view').addEventListener('click', () => setMode('view'));
    $('mode-walk').addEventListener('click', () => setMode('walk'));

    // What walkthrough.js needs from the viewer
    window.Explorer = {
        VIEW, view, state, hooks, renderer, camera, canvas,
        toast, clamp, rad, deg, wrapLon, markInput, lonLatToVector,
        loadImage, photoToCanvas, photoUrl,
        isDragging: () => pointers.size > 0
    };

    // ─── Render loop ────────────────────────────────────────────────────────

    let lastTime = 0;
    const lookTarget = new THREE.Vector3();

    function frame(time) {
        const dt = Math.min(50, lastTime ? time - lastTime : 16);
        lastTime = time;
        const step = dt / 16;

        if (pointers.size === 0) {
            view.lon += view.vLon * step;
            view.lat = clamp(view.lat + view.vLat * step, -VIEW.latLimit, VIEW.latLimit);
            const damp = Math.pow(VIEW.friction, step);
            view.vLon *= damp;
            view.vLat *= damp;
            if (Math.abs(view.vLon) < 0.001) view.vLon = 0;
            if (Math.abs(view.vLat) < 0.001) view.vLat = 0;

            const idle = performance.now() - state.lastInput > VIEW.autoRotateDelayMs;
            if (state.autoRotate && idle && state.mode === 'view' && !state.editing && !state.busy) view.lon += VIEW.autoRotateSpeed * step;
        }
        view.lon = wrapLon(view.lon);

        // Ease the zoom so wheel notches don't jump
        view.fov += (view.targetFov - view.fov) * (1 - Math.pow(0.85, step));
        camera.fov = view.fov;
        camera.updateProjectionMatrix();

        if (state.mode === 'walk' && hooks.walk) {
            hooks.walk.frame(dt);
        } else {
            lookTarget.copy(lonLatToVector(view.lon, view.lat, VIEW.sphereRadius));
            camera.lookAt(lookTarget);

            renderer.render(threeScene, camera);
            positionHotspots();
        }
        requestAnimationFrame(frame);
    }

    // ─── Boot ───────────────────────────────────────────────────────────────

    function init() {
        resize();
        window.addEventListener('resize', resize);

        for (const demo of window.DemoScenes) {
            addScene({ name: demo.name, canvas: demo.create(), hotspots: demo.hotspots.map((h) => ({ ...h })), startLon: demo.startLon });
        }
        setScene(0);

        state.lastInput = performance.now();
        requestAnimationFrame(frame);

        loadDefaultPhotos(); // the demos are already usable while these decode
    }

    init();
})();
