/**
 * Drone Run — top-down vertical scroller (shoot + dodge).
 * Screen-space entities; obstacles drift downward.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'airplot_drone_run_high';
    const PERF_STORAGE_KEY = 'airplot_drone_run_perf';

    let performanceMode = false;
    try {
        performanceMode = localStorage.getItem(PERF_STORAGE_KEY) === '1';
    } catch {
        performanceMode = false;
    }

    const canvas = document.getElementById('gameCanvas');
    const host = document.querySelector('.dr-canvas-host');
    const overlayIntro = document.getElementById('drOverlayIntro');
    const overlayStart = document.getElementById('drOverlayStart');
    const overlayGameOver = document.getElementById('drOverlayGameOver');
    const btnInstructionsContinue = document.getElementById('drBtnInstructionsContinue');
    const btnBackToInstructions = document.getElementById('drBtnBackToInstructions');
    const btnStart = document.getElementById('drBtnStart');
    const btnRestart = document.getElementById('drBtnRestart');
    const elScoreFinal = document.getElementById('drScoreFinal');
    const elHighFinal = document.getElementById('drHighFinal');
    const elHudScore = document.getElementById('drHudScore');
    const elHudAlt = document.getElementById('drHudAlt');
    const batterySegs = document.querySelectorAll('.dr-battery-seg');
    const btnFire = document.getElementById('drMobileFire');

    if (!canvas || !host) return;

    const DRONE_SRC = 'assets/airplot-icon.svg';
    const TARGET_SRC = 'assets/drone-run-target.svg';
    const PLANE_PATHS = [
        'assets/aircraft-icons/a0.svg',
        'assets/aircraft-icons/a1.svg',
        'assets/aircraft-icons/a2.svg',
        'assets/aircraft-icons/a3.svg',
        'assets/aircraft-icons/a320.svg',
        'assets/aircraft-icons/b737.svg',
        'assets/aircraft-icons/cessna.svg',
        'assets/aircraft-icons/erj.svg',
        'assets/aircraft-icons/glf5.svg'
    ];
    /** Obstacle planes only — blues, teals, greens, ambers, purples (no red; red reserved for targets). */
    const PLANE_PRIMARY_FILTERS = [
        'brightness(0) saturate(100%) invert(32%) sepia(90%) saturate(1400%) hue-rotate(198deg) brightness(99%) contrast(97%)',
        'brightness(0) saturate(100%) invert(36%) sepia(85%) saturate(1200%) hue-rotate(168deg) brightness(98%) contrast(96%)',
        'brightness(0) saturate(100%) invert(40%) sepia(100%) saturate(900%) hue-rotate(92deg) brightness(97%) contrast(98%)',
        'brightness(0) saturate(100%) invert(52%) sepia(75%) saturate(1000%) hue-rotate(58deg) brightness(103%) contrast(97%)',
        'brightness(0) saturate(100%) invert(38%) sepia(80%) saturate(1100%) hue-rotate(235deg) brightness(98%) contrast(97%)',
        'brightness(0) saturate(100%) invert(34%) sepia(70%) saturate(800%) hue-rotate(265deg) brightness(99%) contrast(98%)'
    ];
    /** Solid fills for performance mode (matches filter order; no ctx.filter). */
    const OBSTACLE_COLORS = [
        '#2563eb',
        '#0d9488',
        '#16a34a',
        '#ca8a04',
        '#6366f1',
        '#7c3aed'
    ];
    const MAX_ENTITIES_PERF = 20;
    /** Single bright red for all shootable enemy drones. */
    const ENEMY_DRONE_FILTER =
        'brightness(0) saturate(100%) invert(16%) sepia(100%) saturate(9000%) hue-rotate(348deg) brightness(106%) contrast(110%)';

    const MAP_ZOOM = 15;
    const LONDON_LAT = 51.5074;
    const LONDON_LON = -0.1278;

    function mercatorWorldPx(lat, lon, zoom) {
        const scale = 256 * Math.pow(2, zoom);
        const x = ((lon + 180) / 360) * scale;
        const latRad = (lat * Math.PI) / 180;
        const y =
            ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
        return { x, y };
    }

    const londonWorldPx = mercatorWorldPx(LONDON_LAT, LONDON_LON, MAP_ZOOM);
    const tileCache = Object.create(null);

    const sheet = { drone: null, target: null, planes: Object.create(null) };

    function preloadGameImages() {
        const pending = [];
        const drone = new Image();
        pending.push(
            new Promise((resolve) => {
                drone.onload = resolve;
                drone.onerror = resolve;
            })
        );
        drone.src = DRONE_SRC;
        sheet.drone = drone;

        const target = new Image();
        pending.push(
            new Promise((resolve) => {
                target.onload = resolve;
                target.onerror = resolve;
            })
        );
        target.src = TARGET_SRC;
        sheet.target = target;

        PLANE_PATHS.forEach((p) => {
            const im = new Image();
            pending.push(
                new Promise((resolve) => {
                    im.onload = resolve;
                    im.onerror = resolve;
                })
            );
            im.src = p;
            sheet.planes[p] = im;
        });
        return Promise.all(pending);
    }

    function planeImageFor(path) {
        return sheet.planes[path] || null;
    }

    function droneImageReady() {
        const d = sheet.drone;
        return d && d.complete && d.naturalWidth > 0;
    }

    function planeImageReady(path) {
        const im = planeImageFor(path);
        return im && im.complete && im.naturalWidth > 0;
    }

    function targetImageReady() {
        const t = sheet.target;
        return t && t.complete && t.naturalWidth > 0;
    }

    const ctx = canvas.getContext('2d', { alpha: false });
    let dpr = 1;
    let W = 0;
    let H = 0;

    const state = {
        phase: 'menu',
        lastT: 0,
        score: 0,
        distance: 0,
        lives: 3,
        spawnAcc: 0,
        difficulty: 1,
        mapScrollPx: 0,
        entities: [],
        bullets: [],
        effects: [],
        screenShake: 0,
        keys: Object.create(null),
        fireCooldown: 0,
        autoFireAcc: 0,
        raf: 0
    };

    const player = {
        x: 0,
        y: 0,
        r: 21,
        vx: 0,
        vy: 0
    };

    function loadHigh() {
        try {
            const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
            return Number.isFinite(v) ? v : 0;
        } catch {
            return 0;
        }
    }

    function saveHigh(s) {
        try {
            const cur = loadHigh();
            if (s > cur) localStorage.setItem(STORAGE_KEY, String(s));
        } catch { /* ignore */ }
    }

    function savePerfMode(on) {
        performanceMode = !!on;
        try {
            localStorage.setItem(PERF_STORAGE_KEY, performanceMode ? '1' : '0');
        } catch { /* ignore */ }
        syncPerfCheckboxes();
        resize();
        if (state.phase === 'menu') {
            menuDraw(1 / 60);
        } else if (state.phase === 'over') {
            draw(0);
        }
    }

    function syncPerfCheckboxes() {
        const startCb = document.getElementById('drPerfToggle');
        const overCb = document.getElementById('drPerfToggleOver');
        if (startCb) startCb.checked = performanceMode;
        if (overCb) overCb.checked = performanceMode;
    }

    function resize() {
        const bar = document.querySelector('.dr-top-bar');
        if (bar) {
            document.documentElement.style.setProperty(
                '--dr-top-pad',
                `${Math.ceil(bar.getBoundingClientRect().height)}px`
            );
        }
        dpr = Math.min(window.devicePixelRatio || 1, performanceMode ? 1 : 2);
        const rect = host.getBoundingClientRect();
        W = Math.max(320, Math.floor(rect.width));
        H = Math.max(240, Math.floor(rect.height));
        canvas.width = Math.floor(W * dpr);
        canvas.height = Math.floor(H * dpr);
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        player.x = W / 2;
        player.y = H - Math.min(100, H * 0.18);
    }

    function resetGame() {
        state.score = 0;
        state.distance = 0;
        state.lives = 3;
        state.spawnAcc = 0;
        state.difficulty = 1;
        state.mapScrollPx = 0;
        state.entities = [];
        state.bullets = [];
        state.effects = [];
        state.screenShake = 0;
        state.fireCooldown = 0;
        state.autoFireAcc = 0;
        player.x = W / 2;
        player.y = H - Math.min(100, H * 0.18);
        player.vx = 0;
        player.vy = 0;
        updateHud();
    }

    function updateHud() {
        if (elHudScore) elHudScore.textContent = String(Math.floor(state.score));
        if (elHudAlt) elHudAlt.textContent = String(Math.floor(state.distance));
        batterySegs.forEach((el, i) => {
            el.classList.toggle('on', i < state.lives);
        });
    }

    function spawnObstacle() {
        if (performanceMode && state.entities.length >= MAX_ENTITIES_PERF) return;
        const roll = Math.random();
        const speed = (120 + state.difficulty * 35) * (0.85 + Math.random() * 0.3);
        if (roll < 0.38) {
            const r = 22 + Math.random() * 14;
            const iconPath = PLANE_PATHS[(Math.random() * PLANE_PATHS.length) | 0];
            const pi = (Math.random() * PLANE_PRIMARY_FILTERS.length) | 0;
            const planeFilter = PLANE_PRIMARY_FILTERS[pi];
            const planeColor = OBSTACLE_COLORS[pi];
            state.entities.push({
                type: 'obstaclePlane',
                x: r + Math.random() * Math.max(4, W - 2 * r),
                y: -r,
                r,
                vy: speed,
                vx: 0,
                hp: 999,
                solid: true,
                iconPath,
                planeFilter,
                planeColor,
                headingRad: Math.PI / 2
            });
        } else if (roll < 0.68) {
            const r = 15 + Math.random() * 12;
            let hvx = (Math.random() - 0.5) * 48;
            if (Math.abs(hvx) < 12) hvx += hvx >= 0 ? 18 : -18;
            const iconPath = PLANE_PATHS[(Math.random() * PLANE_PATHS.length) | 0];
            const pi = (Math.random() * PLANE_PRIMARY_FILTERS.length) | 0;
            const planeFilter = PLANE_PRIMARY_FILTERS[pi];
            const planeColor = OBSTACLE_COLORS[pi];
            state.entities.push({
                type: 'obstaclePlane',
                x: r + Math.random() * Math.max(4, W - 2 * r),
                y: -r,
                r,
                vy: speed * 1.08,
                vx: hvx,
                hp: 999,
                solid: true,
                iconPath,
                planeFilter,
                planeColor,
                headingRad: 0
            });
        } else {
            const r = 11 + Math.random() * 17;
            let hvx = (Math.random() - 0.5) * 42;
            if (Math.abs(hvx) < 10) hvx += hvx >= 0 ? 16 : -16;
            const targetDraw = r * (2.15 + Math.random() * 0.55);
            state.entities.push({
                type: 'target',
                x: r + Math.random() * Math.max(4, W - 2 * r),
                y: -r,
                r,
                targetDraw,
                vy: speed * 0.92,
                vx: hvx,
                hp: 1,
                solid: false,
                spinAngle: Math.random() * Math.PI * 2,
                spinSpeed: (Math.random() - 0.5) * 0.85
            });
        }
    }

    function fireBullet() {
        if (state.fireCooldown > 0) return;
        state.bullets.push({
            x: player.x,
            y: player.y - player.r - 4,
            vy: -420,
            r: 4.5
        });
        state.fireCooldown = 0.14;
    }

    function hitCircles(ax, ay, ar, bx, by, br) {
        const dx = ax - bx;
        const dy = ay - by;
        return dx * dx + dy * dy < (ar + br) ** 2;
    }

    function hitPlayer(e) {
        if (e.type === 'obstaclePlane' || e.type === 'target') {
            return hitCircles(player.x, player.y, player.r * 0.85, e.x, e.y, e.r * 0.9);
        }
        return false;
    }

    function hitBullet(b, e) {
        if (e.type === 'obstaclePlane' || e.type === 'target') {
            return hitCircles(b.x, b.y, b.r, e.x, e.y, e.r);
        }
        return false;
    }

    function ensureOsmTile(z, tx, ty) {
        const n = 1 << z;
        if (ty < 0 || ty >= n) return null;
        const txNorm = ((tx % n) + n) % n;
        const key = `${z}/${txNorm}/${ty}`;
        if (!tileCache[key]) {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.decoding = 'async';
            im.src = `https://tile.openstreetmap.org/${z}/${txNorm}/${ty}.png`;
            tileCache[key] = im;
        }
        return tileCache[key];
    }

    /** Scrolls Web Mercator tiles north over London (same tile server as OSM website). */
    function drawOsmScrolling(dt) {
        const rate =
            state.phase === 'play' ? 92 * (1 + state.difficulty * 0.14) : 30;
        state.mapScrollPx += rate * dt;

        if (performanceMode) {
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, '#1e293b');
            g.addColorStop(0.55, '#0f172a');
            g.addColorStop(1, '#020617');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            const band = (state.mapScrollPx * 0.4) % 80;
            ctx.fillStyle = 'rgba(51, 65, 85, 0.35)';
            for (let y = -band; y < H + 80; y += 80) {
                ctx.fillRect(0, y, W, 36);
            }
            return;
        }

        const ts = 256;
        const z = MAP_ZOOM;
        const n = 1 << z;
        const viewLeft = londonWorldPx.x - W / 2;
        const viewTop = londonWorldPx.y - H / 2 - state.mapScrollPx;

        ctx.fillStyle = '#1e2a3a';
        ctx.fillRect(0, 0, W, H);

        const txMin = Math.floor(viewLeft / ts) - 1;
        const txMax = Math.floor((viewLeft + W) / ts) + 1;
        const tyMin = Math.floor(viewTop / ts) - 1;
        const tyMax = Math.floor((viewTop + H) / ts) + 1;

        for (let ty = tyMin; ty <= tyMax; ty++) {
            if (ty < 0 || ty >= n) continue;
            for (let tx = txMin; tx <= txMax; tx++) {
                const img = ensureOsmTile(z, tx, ty);
                if (!img || !img.complete || !img.naturalWidth) continue;
                const sx = tx * ts - viewLeft;
                const sy = ty * ts - viewTop;
                ctx.drawImage(img, sx, sy, ts + 1, ts + 1);
            }
        }
    }

    function drawBackground(dt) {
        drawOsmScrolling(dt);
        ctx.fillStyle = performanceMode ? 'rgba(10, 14, 22, 0.32)' : 'rgba(10, 14, 22, 0.44)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(240, 248, 255, 0.42)';
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        if (performanceMode) {
            ctx.fillText('Performance mode — simplified backdrop', 10, 10);
        } else {
            ctx.fillText('London (OpenStreetMap)', 10, 10);
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
            performanceMode ? 'No live map tiles' : '© OpenStreetMap contributors',
            10,
            H - 8
        );
    }

    function drawDroneFallback(x, y, tilt) {
        const k = player.r / 14;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(tilt + Math.PI);
        ctx.fillStyle = '#3a4556';
        ctx.strokeStyle = '#5b8def';
        ctx.lineWidth = Math.max(1.5, 2 * k);
        ctx.beginPath();
        ctx.moveTo(0, -18 * k);
        ctx.lineTo(16 * k, 12 * k);
        ctx.lineTo(0, 6 * k);
        ctx.lineTo(-16 * k, 12 * k);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#3ddc97';
        ctx.beginPath();
        ctx.arc(0, -4 * k, 3 * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    /** AirPlot app icon (quad silhouette); same asset as favicon / welcome branding. */
    function drawDrone(x, y, tilt) {
        const img = sheet.drone;
        const size = player.r * 2.75;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(tilt + Math.PI);
        if (droneImageReady()) {
            if (!performanceMode) {
                ctx.shadowColor = 'rgba(91, 141, 239, 0.9)';
                ctx.shadowBlur = 16;
            }
            ctx.drawImage(img, -size / 2, -size / 2, size, size);
            ctx.shadowBlur = 0;
        } else {
            ctx.restore();
            drawDroneFallback(x, y, tilt);
            return;
        }
        ctx.restore();
    }

    /** ADS-B / Airspace aircraft silhouettes — used as hazards (obstacles). */
    function drawAdsbPlane(e) {
        const img = planeImageFor(e.iconPath);
        const drawSize = e.r * 2.35;
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(e.headingRad);
        if (performanceMode) {
            const fill = e.planeColor || OBSTACLE_COLORS[0];
            ctx.fillStyle = fill;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(0, 0, e.r * 1.35, e.r * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
            return;
        }
        if (planeImageReady(e.iconPath)) {
            ctx.filter = e.planeFilter || PLANE_PRIMARY_FILTERS[0];
            ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
            ctx.shadowBlur = 6;
            ctx.drawImage(img, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
            ctx.shadowBlur = 0;
            ctx.filter = 'none';
        } else {
            ctx.fillStyle = '#475569';
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, e.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }

    /** Shootable targets — custom potrace silhouette, tinted per spawn. */
    function drawTarget(e) {
        const img = sheet.target;
        const s = e.targetDraw;
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(e.spinAngle);
        if (performanceMode) {
            ctx.fillStyle = '#dc2626';
            ctx.strokeStyle = 'rgba(254, 202, 202, 0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, e.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
            return;
        }
        if (targetImageReady()) {
            ctx.filter = ENEMY_DRONE_FILTER;
            ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
            ctx.shadowBlur = 10;
            ctx.drawImage(img, -s / 2, -s / 2, s, s);
            ctx.shadowBlur = 0;
            ctx.filter = 'none';
        } else {
            ctx.fillStyle = '#dc2626';
            ctx.beginPath();
            ctx.arc(0, 0, e.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function spawnTargetExplosion(x, y) {
        const n = performanceMode ? 5 : 14;
        const parts = [];
        for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4;
            const spd = 95 + Math.random() * 160;
            parts.push({
                ang,
                vx: Math.cos(ang) * spd,
                vy: Math.sin(ang) * spd,
                sz: 2.5 + Math.random() * 3.5
            });
        }
        state.effects.push({
            kind: 'explode',
            x,
            y,
            t: 0,
            life: performanceMode ? 0.26 : 0.38,
            parts
        });
    }

    function spawnCrashFx(x, y) {
        state.effects.push({
            kind: 'crash',
            x,
            y,
            t: 0,
            life: performanceMode ? 0.32 : 0.48,
            rot: Math.random() * Math.PI * 2
        });
        state.screenShake = Math.max(state.screenShake, performanceMode ? 9 : 17);
    }

    function stepEffects(dt) {
        state.screenShake = Math.max(0, state.screenShake - dt * 42);
        for (let i = state.effects.length - 1; i >= 0; i--) {
            const fx = state.effects[i];
            fx.t += dt;
            if (fx.t >= fx.life) state.effects.splice(i, 1);
        }
    }

    function drawEffects() {
        for (const fx of state.effects) {
            const k = fx.t / fx.life;
            const fade = 1 - k;
            if (fx.kind === 'explode') {
                ctx.save();
                ctx.globalAlpha = fade;
                const ringR = 6 + k * 48;
                if (!performanceMode) {
                    ctx.strokeStyle = `rgba(255, 200, 120, ${0.35 + fade * 0.45})`;
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.arc(fx.x, fx.y, ringR, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = `rgba(255, 90, 60, ${fade * 0.85})`;
                    ctx.beginPath();
                    ctx.arc(fx.x, fx.y, ringR * 0.55, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    ctx.strokeStyle = `rgba(255, 160, 80, ${fade * 0.9})`;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(fx.x, fx.y, ringR * 0.65, 0, Math.PI * 2);
                    ctx.stroke();
                }
                for (const p of fx.parts) {
                    const px = fx.x + p.vx * fx.t;
                    const py = fx.y + p.vy * fx.t;
                    const ps = p.sz * fade;
                    ctx.fillStyle = k < 0.35 ? '#ffffff' : `rgba(255, 160, 80, ${fade})`;
                    ctx.beginPath();
                    ctx.arc(px, py, ps, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            } else if (fx.kind === 'crash') {
                ctx.save();
                ctx.translate(fx.x, fx.y);
                ctx.rotate(fx.rot);
                ctx.globalAlpha = fade * 0.95;
                const spike = 28 + k * 40;
                const spikes = performanceMode ? 4 : 8;
                ctx.strokeStyle = `rgba(251, 191, 36, ${fade})`;
                ctx.lineWidth = performanceMode ? 3 : 4;
                for (let s = 0; s < spikes; s++) {
                    const a = (s / spikes) * Math.PI * 2;
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
                    ctx.lineTo(Math.cos(a) * spike, Math.sin(a) * spike);
                    ctx.stroke();
                }
                ctx.fillStyle = `rgba(248, 113, 113, ${fade * 0.55})`;
                ctx.beginPath();
                ctx.arc(0, 0, 14 + k * 22, 0, Math.PI * 2);
                ctx.fill();
                if (!performanceMode) {
                    ctx.strokeStyle = `rgba(254, 249, 195, ${fade})`;
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.moveTo(-18, -18);
                    ctx.lineTo(18, 18);
                    ctx.moveTo(18, -18);
                    ctx.lineTo(-18, 18);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }
    }

    function drawEntity(e) {
        if (e.type === 'obstaclePlane') {
            drawAdsbPlane(e);
        } else if (e.type === 'target') {
            drawTarget(e);
        }
    }

    function step(dt) {
        if (state.phase !== 'play') return;

        state.distance += dt * (60 + state.difficulty * 8);
        state.difficulty = 1 + state.distance / 800;
        const spawnMul = performanceMode ? 0.82 : 1;
        state.spawnAcc += dt * (1.1 + state.difficulty * 0.35) * spawnMul;
        while (state.spawnAcc >= 1) {
            state.spawnAcc -= 1;
            spawnObstacle();
        }

        const acc = 1400;
        const fric = 8;
        let ax = 0;
        let ay = 0;
        if (state.keys['arrowleft'] || state.keys['a']) ax -= 1;
        if (state.keys['arrowright'] || state.keys['d']) ax += 1;
        if (state.keys['arrowup'] || state.keys['w']) ay -= 1;
        if (state.keys['arrowdown'] || state.keys['s']) ay += 1;
        if (ax !== 0 || ay !== 0) {
            const len = Math.hypot(ax, ay) || 1;
            ax /= len;
            ay /= len;
        }
        player.vx += ax * acc * dt;
        player.vy += ay * acc * dt;
        player.vx -= player.vx * fric * dt;
        player.vy -= player.vy * fric * dt;
        player.x += player.vx * dt;
        player.y += player.vy * dt;
        const m = player.r + 4;
        player.x = Math.max(m, Math.min(W - m, player.x));
        player.y = Math.max(m, Math.min(H - m, player.y));

        if (state.keys[' ']) {
            fireBullet();
        }

        state.autoFireAcc += dt;
        if (state.autoFireAcc >= 0.28) {
            state.autoFireAcc = 0;
            if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
                fireBullet();
            }
        }

        if (state.fireCooldown > 0) state.fireCooldown -= dt;

        for (const b of state.bullets) {
            b.y += b.vy * dt;
        }
        state.bullets = state.bullets.filter((b) => b.y > -20 && b.y < H + 20);

        for (const e of state.entities) {
            e.y += e.vy * dt;
            if (e.vx) e.x += e.vx * dt;
            if (e.type === 'obstaclePlane') {
                if (e.vx) {
                    if (e.x < e.r) e.vx = Math.abs(e.vx);
                    if (e.x > W - e.r) e.vx = -Math.abs(e.vx);
                }
                const hvx = e.vx || 0;
                const hvy = e.vy || 0.001;
                e.headingRad = Math.atan2(hvy, hvx) + Math.PI / 2;
            }
            if (e.type === 'target') {
                if (e.x < e.r) e.vx = Math.abs(e.vx || 24);
                if (e.x > W - e.r) e.vx = -Math.abs(e.vx || 24);
                e.spinAngle += e.spinSpeed * dt;
            }
        }

        outer: for (let bi = state.bullets.length - 1; bi >= 0; bi--) {
            const b = state.bullets[bi];
            for (let ei = 0; ei < state.entities.length; ei++) {
                const e = state.entities[ei];
                if (e.solid) {
                    if (hitBullet(b, e)) {
                        state.bullets.splice(bi, 1);
                        continue outer;
                    }
                } else if (hitBullet(b, e)) {
                    state.bullets.splice(bi, 1);
                    spawnTargetExplosion(e.x, e.y);
                    state.entities.splice(ei, 1);
                    state.score += 50;
                    updateHud();
                    continue outer;
                }
            }
        }

        for (let ei = state.entities.length - 1; ei >= 0; ei--) {
            const e = state.entities[ei];
            if (e.y > H + 80) {
                state.entities.splice(ei, 1);
                if (!e.solid) state.score += 5;
                updateHud();
                continue;
            }
            if (hitPlayer(e)) {
                if (e.type === 'obstaclePlane') {
                    spawnCrashFx(
                        (player.x + e.x) / 2,
                        (player.y + e.y) / 2
                    );
                } else {
                    spawnTargetExplosion(e.x, e.y);
                }
                state.entities.splice(ei, 1);
                state.lives -= 1;
                updateHud();
                if (state.lives <= 0) {
                    endGame();
                    return;
                }
            }
        }

        stepEffects(dt);

        state.score += dt * 12 * state.difficulty;
        updateHud();
    }

    function draw(dt) {
        const tilt = (player.vx / 400) * 0.35;
        drawBackground(dt);
        const tShake = state.phase === 'play' ? performance.now() * 0.05 : 0;
        const sh = state.screenShake;
        const ox = sh > 0.5 ? Math.sin(tShake) * sh * 0.55 : 0;
        const oy = sh > 0.5 ? Math.cos(tShake * 1.17) * sh * 0.55 : 0;
        ctx.save();
        ctx.translate(ox, oy);
        for (const e of state.entities) drawEntity(e);
        for (const b of state.bullets) {
            const core = b.r;
            if (performanceMode) {
                ctx.fillStyle = '#fffef0';
                ctx.beginPath();
                ctx.arc(b.x, b.y, core, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(b.x, b.y, core * 0.4, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.shadowColor = 'rgba(255, 240, 180, 0.95)';
                ctx.shadowBlur = 14;
                ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
                ctx.beginPath();
                ctx.arc(b.x, b.y, core * 1.15, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 10;
                ctx.shadowColor = 'rgba(255, 100, 200, 0.8)';
                ctx.fillStyle = '#fff8e8';
                ctx.beginPath();
                ctx.arc(b.x, b.y, core * 0.55, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(b.x, b.y, core * 0.28, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        drawEffects();
        drawDrone(player.x, player.y, tilt);
        ctx.restore();
    }

    function loop(t) {
        const last = state.lastT || t;
        state.lastT = t;
        const dt = Math.min(0.05, (t - last) / 1000);
        step(dt);
        if (state.phase === 'play') {
            draw(dt);
        } else if (state.phase === 'menu') {
            menuDraw(dt);
        }
        state.raf = requestAnimationFrame(loop);
    }

    function startGame() {
        if (overlayIntro) overlayIntro.hidden = true;
        overlayStart.hidden = true;
        overlayGameOver.hidden = true;
        resetGame();
        state.phase = 'play';
        state.lastT = 0;
        canvas.focus();
    }

    function endGame() {
        state.phase = 'over';
        saveHigh(Math.floor(state.score));
        const hi = loadHigh();
        if (elScoreFinal) elScoreFinal.textContent = String(Math.floor(state.score));
        if (elHighFinal) elHighFinal.textContent = String(hi);
        overlayGameOver.hidden = false;
        syncPerfCheckboxes();
    }

    function onKeyDown(e) {
        const k = e.key.toLowerCase();
        if (k === ' ' || e.code === 'Space') {
            e.preventDefault();
            state.keys[' '] = true;
        }
        state.keys[k] = true;
    }

    function onKeyUp(e) {
        const k = e.key.toLowerCase();
        if (k === ' ' || e.code === 'Space') state.keys[' '] = false;
        state.keys[k] = false;
    }

    let touchId = null;
    /** Relative drag: finger delta from pointerdown, not absolute finger → ship (avoids snap + thumb cover). */
    let touchStartGx = 0;
    let touchStartGy = 0;
    let touchStartPx = 0;
    let touchStartPy = 0;

    /** CSS px — ship stays roughly this far above the touch on touch pointers. */
    const TOUCH_THUMB_LIFT_PX = 64;

    function clientToGame(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const tx = clientX - rect.left;
        const ty = clientY - rect.top;
        const scaleX = W / rect.width;
        const scaleY = H / rect.height;
        return {
            gx: tx * scaleX,
            gy: ty * scaleY,
            rect
        };
    }

    function applyDragFromPointer(clientX, clientY) {
        const { gx, gy } = clientToGame(clientX, clientY);
        const m = player.r + 4;
        player.x = Math.max(m, Math.min(W - m, touchStartPx + gx - touchStartGx));
        player.y = Math.max(m, Math.min(H - m, touchStartPy + gy - touchStartGy));
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (state.phase !== 'play') return;
        if (e.target.closest('.dr-mobile-fire')) return;
        touchId = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
        const { gx, gy, rect } = clientToGame(e.clientX, e.clientY);
        const liftGame =
            e.pointerType === 'touch' ? (TOUCH_THUMB_LIFT_PX / rect.height) * H : 0;
        touchStartGx = gx;
        touchStartGy = gy + liftGame;
        touchStartPx = player.x;
        touchStartPy = player.y;
        applyDragFromPointer(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointermove', (e) => {
        if (state.phase !== 'play' || touchId !== e.pointerId) return;
        applyDragFromPointer(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointerup', (e) => {
        if (touchId === e.pointerId) touchId = null;
    });

    canvas.addEventListener('pointercancel', (e) => {
        if (touchId === e.pointerId) touchId = null;
    });

    if (btnFire) {
        btnFire.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (state.phase === 'play') fireBullet();
        });
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    function showPrePlayModal() {
        if (overlayStart) overlayStart.hidden = true;
        if (overlayIntro) overlayIntro.hidden = false;
        if (btnStart) btnStart.focus();
    }

    function showInstructionsModal() {
        if (overlayIntro) overlayIntro.hidden = true;
        if (overlayStart) overlayStart.hidden = false;
        if (btnInstructionsContinue) btnInstructionsContinue.focus();
    }

    if (btnInstructionsContinue) {
        btnInstructionsContinue.addEventListener('click', showPrePlayModal);
    }
    if (btnBackToInstructions) {
        btnBackToInstructions.addEventListener('click', showInstructionsModal);
    }

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (overlayIntro && !overlayIntro.hidden) {
            e.preventDefault();
            showInstructionsModal();
        }
    });

    if (btnInstructionsContinue) btnInstructionsContinue.focus();

    if (btnStart) btnStart.addEventListener('click', () => startGame());
    if (btnRestart) btnRestart.addEventListener('click', () => startGame());

    function onPerfToggleChange(checked) {
        savePerfMode(checked);
    }

    const perfStart = document.getElementById('drPerfToggle');
    const perfOver = document.getElementById('drPerfToggleOver');
    if (perfStart) {
        perfStart.checked = performanceMode;
        perfStart.addEventListener('change', () => onPerfToggleChange(perfStart.checked));
    }
    if (perfOver) {
        perfOver.checked = performanceMode;
        perfOver.addEventListener('change', () => onPerfToggleChange(perfOver.checked));
    }

    window.addEventListener('resize', () => {
        resize();
        if (state.phase === 'menu') {
            drawBackground(0);
        } else if (state.phase === 'over') {
            draw(0);
        }
    });

    resize();
    syncPerfCheckboxes();

    preloadGameImages();

    function menuDraw(dt) {
        drawBackground(dt);
        drawDrone(W / 2, H * 0.42, 0);
        ctx.fillStyle = 'rgba(91, 141, 239, 0.9)';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Tap Start or press keys to fly', W / 2, H * 0.42 + 48);
    }

    state.raf = requestAnimationFrame(loop);

    window.addEventListener('beforeunload', () => cancelAnimationFrame(state.raf));
})();
