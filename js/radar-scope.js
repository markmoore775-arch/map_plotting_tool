/* ============================================
   RADAR SCOPE: CRT-style ADS-B display (ADSB.lol)
   Loaded only by radar.html. Uses /api/adsb proxy.
   ============================================ */

(function () {
    'use strict';

    const ADSB_LOL_BASE = 'https://api.adsb.lol/v2';
    const DEFAULT_CENTER = { lat: 51.5074, lon: -0.1278 };
    const CENTER_STORAGE_KEY = 'airplotRadarCenter_v1';
    const RANGE_STORAGE_KEY = 'airplotRadarRangeNm_v1';
    const MIN_POLL_MS = 5000;
    const POLL_MS_MAX = 60000;
    const PROXY_FETCH_TIMEOUT_MS = 8000;
    const MARKER_STALE_AGE_SEC = 45;
    /** Full revolution time — slower leaves labels readable between paints. */
    const SWEEP_PERIOD_MS = 10000;
    const PAINT_ARC_DEG = 2.8;
    /** Angular width of the live sweep trail (degrees behind the beam). */
    const SWEEP_TRAIL_DEG = 75;
    /**
     * Frozen contact fade: stay readable most of the turn, reach 0 before the
     * next sweep hit replaces the snapshot (no stacked ghost text).
     */
    const CONTACT_FADE_END_FRAC = 0.92;
    /** Screen-space radius for treating contacts as one clutter cluster. */
    const CLUSTER_RADIUS_PX = 52;
    /** Max full/compact labels kept inside one cluster (selected always wins). */
    const CLUSTER_MAX_COMPACT = 2;
    /** Extra callsign-only labels allowed in the same cluster. */
    const CLUSTER_MAX_CALLSIGN = 2;
    const NM_TO_M = 1852;
    const RANGE_OPTIONS = [5, 10, 25, 50];

    /** Label anchor slots around a blip (ox/oy from blip; align for text). */
    const LABEL_SLOTS = [
        { ox: 10, oy: -14, align: 'left' },
        { ox: -10, oy: -14, align: 'right' },
        { ox: 10, oy: 10, align: 'left' },
        { ox: -10, oy: 10, align: 'right' },
        { ox: 16, oy: -32, align: 'left' },
        { ox: -16, oy: -32, align: 'right' },
        { ox: 16, oy: 26, align: 'left' },
        { ox: -16, oy: 26, align: 'right' },
        { ox: 28, oy: -6, align: 'left' },
        { ox: -28, oy: -6, align: 'right' }
    ];

    const PHOSPHOR = '#33ff66';
    const PHOSPHOR_DIM = 'rgba(51, 255, 102, 0.35)';
    const PHOSPHOR_SOFT = 'rgba(51, 255, 102, 0.18)';
    const BG = '#020805';

    let canvas;
    let ctx;
    /** Pre-rendered smooth conical sweep (beam at north); rotated each frame. */
    let sweepSprite;
    let sweepSpriteRadius = 0;
    let wrapEl;
    let statusEl;
    let detailEl;
    let detailBodyEl;
    let animId = null;
    let pollTimer = null;
    let currentPollMs = MIN_POLL_MS;
    let isFetching = false;
    let lastAdsbSource = 'adsblol';
    let lastAdsbCache = 'fresh';
    let adsbRateLimited = false;
    let hideGround = true;
    let showLabels = true;
    let rangeNm = 5;
    let center = Object.assign({}, DEFAULT_CENTER);
    let dpr = 1;
    let cx = 0;
    let cy = 0;
    let radiusPx = 0;
    let sweepAngle = -Math.PI / 2;
    let lastFrameTs = 0;
    let selectedHex = null;
    /** @type {Array<RadarTarget>} */
    let targets = [];
    /** @type {Map<string, number>} last painted sweep angle (radians) per hex */
    const lastPaintAngle = new Map();
    /**
     * Snapshot of blip + label frozen at sweep-hit. Replaced (not stacked) on the next hit.
     * @type {Map<string, FrozenContact>}
     */
    const frozenByHex = new Map();
    /** @type {Map<string, LabelLayout>} last frame's declutter layout (for hit-testing) */
    let lastLabelLayout = new Map();

    /**
     * @typedef {{
     *   hex: string,
     *   callsign: string,
     *   reg: string,
     *   lat: number,
     *   lon: number,
     *   altFt: number|null,
     *   gs: number|null,
     *   track: number|null,
     *   climb: number|null,
     *   type: string,
     *   squawk: string,
     *   ageSec: number|null,
     *   ground: boolean,
     *   bearingDeg: number,
     *   rangeNm: number,
     *   bearingRad: number,
     *   stale: boolean
     * }} RadarTarget
     */

    /**
     * @typedef {{
     *   hex: string,
     *   callsign: string,
     *   compactLine: string,
     *   line2: string,
     *   line3: string,
     *   x: number,
     *   y: number,
     *   track: number|null,
     *   stale: boolean,
     *   paintAngle: number,
     *   altFt: number|null,
     *   rangeNm: number,
     *   squawk: string
     * }} FrozenContact
     */

    /**
     * Per-frame declutter layout for a frozen contact.
     * @typedef {{
     *   mode: 'full'|'compact'|'callsign'|'none',
     *   lx: number,
     *   ly: number,
     *   align: 'left'|'right',
     *   w: number,
     *   h: number
     * }} LabelLayout
     */

    function clamp(n, lo, hi) {
        return Math.max(lo, Math.min(hi, n));
    }

    function toRad(deg) {
        return (deg * Math.PI) / 180;
    }

    function toDeg(rad) {
        return (rad * 180) / Math.PI;
    }

    function normalizeBearing(deg) {
        let d = deg % 360;
        if (d < 0) d += 360;
        return d;
    }

    function normalizeAngle(rad) {
        let a = rad % (Math.PI * 2);
        if (a < 0) a += Math.PI * 2;
        return a;
    }

    function angleDiff(a, b) {
        let d = normalizeAngle(a) - normalizeAngle(b);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        return d;
    }

    function haversineNm(lat1, lon1, lat2, lon2) {
        const r1 = toRad(lat1);
        const r2 = toRad(lat2);
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const h =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(r1) * Math.cos(r2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return (2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 6371008.8) / NM_TO_M;
    }

    /** Initial bearing from observer to target, degrees clockwise from north. */
    function bearingDeg(lat1, lon1, lat2, lon2) {
        const φ1 = toRad(lat1);
        const φ2 = toRad(lat2);
        const Δλ = toRad(lon2 - lon1);
        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        return normalizeBearing(toDeg(Math.atan2(y, x)));
    }

    function positionLatLon(a) {
        if (!a) return null;
        if (a.lat != null && a.lon != null) {
            return { lat: Number(a.lat), lon: Number(a.lon) };
        }
        const lp = a.lastPosition;
        if (lp && lp.lat != null && lp.lon != null) {
            return { lat: Number(lp.lat), lon: Number(lp.lon) };
        }
        return null;
    }

    function aircraftListFromResponse(data) {
        if (!data) return [];
        const list = data.aircraft || data.ac;
        return Array.isArray(list) ? list : [];
    }

    function aircraftMslFt(a) {
        if (!a) return null;
        if (a.alt_baro != null && !Number.isNaN(Number(a.alt_baro))) {
            return Number(a.alt_baro);
        }
        if (a.alt_geom != null && !Number.isNaN(Number(a.alt_geom))) {
            return Number(a.alt_geom);
        }
        return null;
    }

    function aircraftAgeSec(a) {
        if (!a) return null;
        if (a.seen_pos != null && !Number.isNaN(Number(a.seen_pos))) {
            return Number(a.seen_pos);
        }
        if (a.seen != null && !Number.isNaN(Number(a.seen))) {
            return Number(a.seen);
        }
        return null;
    }

    function isGroundAircraft(a) {
        const alt = a.alt_baro;
        const gs = a.gs;
        if (alt != null && alt < 400) return true;
        if (gs != null && gs < 8) return true;
        return false;
    }

    function normalizeHex(hex) {
        return String(hex || '')
            .toLowerCase()
            .replace(/[^0-9a-f]/g, '');
    }

    function callsignFor(a) {
        const flight = a.flight != null ? String(a.flight).trim() : '';
        if (flight) return flight;
        const reg = a.r != null ? String(a.r).trim() : '';
        if (reg) return reg;
        const hex = normalizeHex(a.hex);
        return hex ? hex.toUpperCase() : '????';
    }

    function formatAlt(altFt) {
        if (altFt == null || !isFinite(altFt)) return '----';
        if (altFt >= 10000) {
            return 'FL' + String(Math.round(altFt / 100)).padStart(3, '0');
        }
        return Math.round(altFt) + 'ft';
    }

    function formatGs(gs) {
        if (gs == null || !isFinite(gs)) return '';
        return Math.round(gs) + 'kt';
    }

    function climbArrow(climb) {
        if (climb == null || !isFinite(climb)) return '';
        if (climb > 200) return '↑';
        if (climb < -200) return '↓';
        return '';
    }

    function setStatus(html, isError) {
        if (!statusEl) return;
        statusEl.classList.toggle('radar-status-error', !!isError);
        statusEl.innerHTML = html;
    }

    function adsbProviderLabel(source) {
        if (source === 'adsblol') return 'ADSB.lol';
        if (source === 'airplaneslive') return 'airplanes.live';
        if (source === 'stale') return 'cached ADS-B';
        return 'ADSB.lol';
    }

    function loadStoredCenter() {
        try {
            const raw = localStorage.getItem(CENTER_STORAGE_KEY);
            if (!raw) return;
            const o = JSON.parse(raw);
            if (o && isFinite(o.lat) && isFinite(o.lon)) {
                center = { lat: Number(o.lat), lon: Number(o.lon) };
            }
        } catch (e) {
            /* ignore */
        }
    }

    function saveCenter() {
        try {
            localStorage.setItem(
                CENTER_STORAGE_KEY,
                JSON.stringify({ v: 1, lat: center.lat, lon: center.lon })
            );
        } catch (e) {
            /* ignore */
        }
    }

    function loadStoredRange() {
        try {
            const n = Number(localStorage.getItem(RANGE_STORAGE_KEY));
            if (RANGE_OPTIONS.indexOf(n) !== -1) rangeNm = n;
        } catch (e) {
            /* ignore */
        }
    }

    function saveRange() {
        try {
            localStorage.setItem(RANGE_STORAGE_KEY, String(rangeNm));
        } catch (e) {
            /* ignore */
        }
    }

    function fetchWithTimeout(url, options, timeoutMs) {
        const ms = timeoutMs != null ? timeoutMs : PROXY_FETCH_TIMEOUT_MS;
        if (typeof AbortController === 'undefined') {
            return fetch(url, options);
        }
        const controller = new AbortController();
        const timer = setTimeout(function () {
            controller.abort();
        }, ms);
        const merged = Object.assign({}, options || {}, { signal: controller.signal });
        return fetch(url, merged).finally(function () {
            clearTimeout(timer);
        });
    }

    function fetchJsonFromResponse(res) {
        if (res.ok) {
            const source = res.headers.get('X-AirPlan-Source');
            if (source) lastAdsbSource = source;
            const cacheHdr = res.headers.get('X-AirPlan-Cache');
            lastAdsbCache = cacheHdr === 'stale' ? 'stale' : 'fresh';
            return res.json();
        }
        return res
            .text()
            .catch(function () {
                return '';
            })
            .then(function (text) {
                const err = new Error('same_origin_proxy');
                err.status = res.status;
                if (res.status === 429) err.message = 'rate_limited';
                if (text) {
                    try {
                        err.body = JSON.parse(text);
                    } catch (parseErr) {
                        err.body = null;
                    }
                }
                throw err;
            });
    }

    function buildAdsbUpstreamUrl(lat, lon, distNm) {
        return (
            ADSB_LOL_BASE +
            '/lat/' +
            lat.toFixed(5) +
            '/lon/' +
            lon.toFixed(5) +
            '/dist/' +
            distNm.toFixed(1)
        );
    }

    function fetchJsonWithProxy(upstreamUrl, sameOriginQueryString) {
        const sameOrigin = '/api/adsb?' + sameOriginQueryString;
        return fetchWithTimeout(
            sameOrigin,
            { method: 'GET', credentials: 'omit', cache: 'no-store' },
            PROXY_FETCH_TIMEOUT_MS
        )
            .then(fetchJsonFromResponse)
            .catch(function (firstErr) {
                if (firstErr && firstErr.message === 'rate_limited') throw firstErr;
                return fetchWithTimeout(
                    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(upstreamUrl),
                    { method: 'GET', credentials: 'omit', cache: 'no-store' },
                    PROXY_FETCH_TIMEOUT_MS
                ).then(function (res) {
                    if (!res.ok) throw new Error('codetabs');
                    return res.json();
                });
            })
            .catch(function (secondErr) {
                if (secondErr && secondErr.message === 'rate_limited') throw secondErr;
                return fetchWithTimeout(
                    'https://corsproxy.io/?' + encodeURIComponent(upstreamUrl),
                    { method: 'GET', credentials: 'omit', cache: 'no-store' },
                    PROXY_FETCH_TIMEOUT_MS
                ).then(function (res) {
                    if (!res.ok) throw new Error('corsproxy');
                    return res.json();
                });
            })
            .catch(function (thirdErr) {
                if (thirdErr && thirdErr.message === 'rate_limited') throw thirdErr;
                throw new Error('no_proxy');
            });
    }

    function fetchAdsbJson(lat, lon, distNm) {
        const params = new URLSearchParams({
            lat: lat.toFixed(5),
            lon: lon.toFixed(5),
            dist: distNm.toFixed(1)
        });
        return fetchJsonWithProxy(buildAdsbUpstreamUrl(lat, lon, distNm), params.toString());
    }

    function applyRateLimitBackoff() {
        adsbRateLimited = true;
        const next = Math.min(POLL_MS_MAX, currentPollMs * 2);
        if (next !== currentPollMs) {
            currentPollMs = next;
            restartPollTimer();
        }
    }

    function resetPollInterval() {
        adsbRateLimited = false;
        if (currentPollMs !== MIN_POLL_MS) {
            currentPollMs = MIN_POLL_MS;
            restartPollTimer();
        }
    }

    function restartPollTimer() {
        stopPolling();
        pollTimer = setInterval(function () {
            if (document.visibilityState !== 'visible') return;
            fetchTraffic();
        }, currentPollMs);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function polarToCanvas(bearingRad, rangeFraction) {
        const r = clamp(rangeFraction, 0, 1) * radiusPx;
        return {
            x: cx + Math.sin(bearingRad) * r,
            y: cy - Math.cos(bearingRad) * r
        };
    }

    function normalizeTargets(list) {
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            const pos = positionLatLon(a);
            const hex = normalizeHex(a.hex);
            if (!pos || !hex || hex.length !== 6) continue;
            if (!isFinite(pos.lat) || !isFinite(pos.lon)) continue;
            const ground = isGroundAircraft(a);
            if (hideGround && ground) continue;
            const rng = haversineNm(center.lat, center.lon, pos.lat, pos.lon);
            if (rng > rangeNm * 1.02) continue;
            const brg = bearingDeg(center.lat, center.lon, pos.lat, pos.lon);
            const age = aircraftAgeSec(a);
            out.push({
                hex: hex,
                callsign: callsignFor(a),
                reg: a.r != null ? String(a.r).trim() : '',
                lat: pos.lat,
                lon: pos.lon,
                altFt: aircraftMslFt(a),
                gs: a.gs != null && !Number.isNaN(Number(a.gs)) ? Number(a.gs) : null,
                track: a.track != null && !Number.isNaN(Number(a.track)) ? Number(a.track) : null,
                climb: a.baro_rate != null && !Number.isNaN(Number(a.baro_rate)) ? Number(a.baro_rate) : null,
                type: a.t != null ? String(a.t).trim() : '',
                squawk: a.squawk != null ? String(a.squawk).trim() : '',
                ageSec: age,
                ground: ground,
                bearingDeg: brg,
                rangeNm: rng,
                bearingRad: toRad(brg),
                stale: age != null ? age > MARKER_STALE_AGE_SEC : lastAdsbCache === 'stale'
            });
        }
        out.sort(function (a, b) {
            return a.rangeNm - b.rangeNm;
        });
        return out;
    }

    function updateStatusBar() {
        const src = adsbProviderLabel(lastAdsbSource);
        const staleNote = lastAdsbCache === 'stale' ? ' · stale' : '';
        const rateNote = adsbRateLimited ? ' · rate-limited (' + Math.round(currentPollMs / 1000) + 's)' : '';
        setStatus(
            '<span class="radar-status-count">' +
                targets.length +
                '</span> contact' +
                (targets.length === 1 ? '' : 's') +
                ' · ' +
                rangeNm +
                ' NM · ' +
                src +
                staleNote +
                rateNote +
                ' · ' +
                center.lat.toFixed(3) +
                ', ' +
                center.lon.toFixed(3)
        );
    }

    function fetchTraffic() {
        if (isFetching) return;
        isFetching = true;
        fetchAdsbJson(center.lat, center.lon, rangeNm)
            .then(function (data) {
                resetPollInterval();
                targets = normalizeTargets(aircraftListFromResponse(data));
                pruneMissingFrozen();
                if (selectedHex && !targets.some(function (t) { return t.hex === selectedHex; })) {
                    selectedHex = null;
                    hideDetail();
                } else if (selectedHex) {
                    const sel = targets.find(function (t) { return t.hex === selectedHex; });
                    if (sel) showDetail(sel);
                }
                updateStatusBar();
            })
            .catch(function (err) {
                if (err && err.message === 'rate_limited') {
                    applyRateLimitBackoff();
                    setStatus(
                        'ADS-B rate limited — slowing refresh to ' +
                            Math.round(currentPollMs / 1000) +
                            's. Showing last contacts.',
                        true
                    );
                    return;
                }
                if (err && err.message === 'no_proxy') {
                    setStatus(
                        'No API proxy. Run <code>npm run serve</code> or use the deployed site so <code>/api/adsb</code> works.',
                        true
                    );
                    return;
                }
                setStatus('Traffic fetch failed. Retrying…', true);
            })
            .finally(function () {
                isFetching = false;
            });
    }

    function resizeCanvas() {
        if (!canvas || !wrapEl) return;
        const rect = wrapEl.getBoundingClientRect();
        const cssW = Math.max(1, Math.floor(rect.width));
        const cssH = Math.max(1, Math.floor(rect.height));
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cx = cssW / 2;
        cy = cssH / 2;
        radiusPx = Math.max(40, Math.min(cssW, cssH) * 0.46);
        sweepSpriteRadius = 0; // force conical sprite rebuild at new radius
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, cssW, cssH);
        // Positions are canvas-absolute; drop frozen contacts on resize
        frozenByHex.clear();
        lastPaintAngle.clear();
    }

    function drawStaticScope() {
        // Range rings
        ctx.save();
        ctx.strokeStyle = PHOSPHOR_SOFT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
        ctx.stroke();

        for (let i = 1; i < 4; i++) {
            const r = (radiusPx * i) / 4;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Cross hairs / bearing ticks
        for (let deg = 0; deg < 360; deg += 10) {
            const rad = toRad(deg);
            const major = deg % 30 === 0;
            const r0 = radiusPx * (major ? 0.94 : 0.97);
            const r1 = radiusPx;
            const p0 = polarToCanvas(rad, r0 / radiusPx);
            const p1 = polarToCanvas(rad, r1 / radiusPx);
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.strokeStyle = major ? PHOSPHOR_DIM : PHOSPHOR_SOFT;
            ctx.stroke();
        }

        // Cardinal labels
        ctx.fillStyle = PHOSPHOR_DIM;
        ctx.font = '600 12px "Share Tech Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelR = 1.08;
        [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(function (pair) {
            const outer = polarToCanvas(toRad(pair[1]), 1);
            const lx = cx + (outer.x - cx) * labelR;
            const ly = cy + (outer.y - cy) * labelR;
            ctx.fillText(pair[0], lx, ly);
        });

        // Range labels along east axis
        ctx.fillStyle = 'rgba(51, 255, 102, 0.45)';
        ctx.font = '11px "Share Tech Mono", ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        for (let i = 1; i <= 4; i++) {
            const nm = (rangeNm * i) / 4;
            const p = polarToCanvas(toRad(90), i / 4);
            ctx.fillText(nm % 1 === 0 ? String(nm) : nm.toFixed(1), p.x + 4, p.y - 2);
        }

        // Center pip
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fillStyle = PHOSPHOR;
        ctx.fill();
        ctx.restore();
    }

    /** Build a pixel-smooth conical trail with the beam pointing up (north). */
    function rebuildSweepSprite() {
        const r = Math.max(32, Math.ceil(radiusPx));
        if (sweepSprite && sweepSpriteRadius === r) return;
        sweepSpriteRadius = r;
        const size = r * 2;
        sweepSprite = document.createElement('canvas');
        sweepSprite.width = size;
        sweepSprite.height = size;
        const sctx = sweepSprite.getContext('2d');
        const img = sctx.createImageData(size, size);
        const data = img.data;
        const scx = r;
        const scy = r;
        const trailRad = toRad(SWEEP_TRAIL_DEG);
        const maxR = r - 1;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - scx + 0.5;
                const dy = y - scy + 0.5;
                const dist = Math.hypot(dx, dy);
                if (dist > maxR || dist < 0.5) continue;

                // 0 = north (up), increasing clockwise
                let ang = Math.atan2(dx, -dy);
                if (ang < 0) ang += Math.PI * 2;

                // Trail sits immediately behind a clockwise beam at angle 0 → near 2π
                let behind = ang === 0 ? 0 : Math.PI * 2 - ang;
                if (behind > trailRad) continue;

                const t = behind / trailRad;
                const u = 1 - t;
                // Strong near the beam, soft continuous falloff behind (not a flat wedge)
                const angFall = Math.pow(u, 2.4);
                const radFall = 1 - (dist / maxR) * 0.25;
                let alpha = 0.5 * angFall * radFall;
                if (behind < toRad(2.5)) {
                    alpha = Math.min(0.78, alpha + 0.28 * (1 - behind / toRad(2.5)));
                }
                const a = Math.round(clamp(alpha, 0, 1) * 255);
                if (a < 2) continue;
                const i = (y * size + x) * 4;
                data[i] = 51;
                data[i + 1] = 255;
                data[i + 2] = 102;
                data[i + 3] = a;
            }
        }
        sctx.putImageData(img, 0, 0);

        // Soft blur pass removes any residual angular stepping
        const blurCanvas = document.createElement('canvas');
        blurCanvas.width = size;
        blurCanvas.height = size;
        const bctx = blurCanvas.getContext('2d');
        bctx.filter = 'blur(1.25px)';
        bctx.drawImage(sweepSprite, 0, 0);
        bctx.filter = 'none';
        sctx.clearRect(0, 0, size, size);
        sctx.drawImage(blurCanvas, 0, 0);

        // Crisp beam line on the sprite (north)
        sctx.strokeStyle = 'rgba(220, 255, 230, 0.95)';
        sctx.lineWidth = 2;
        sctx.shadowColor = 'rgba(51, 255, 102, 0.9)';
        sctx.shadowBlur = 10;
        sctx.beginPath();
        sctx.moveTo(scx, scy);
        sctx.lineTo(scx, 1);
        sctx.stroke();
        sctx.shadowBlur = 0;
    }

    function drawSweepTrail(angle) {
        rebuildSweepSprite();
        if (!sweepSprite) return;
        const size = sweepSprite.width;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.drawImage(sweepSprite, -size / 2, -size / 2);
        ctx.restore();
    }

    function clearFrozenContacts() {
        frozenByHex.clear();
        lastPaintAngle.clear();
        lastLabelLayout = new Map();
    }

    /**
     * Opacity for a frozen snapshot: fades over one turn and hits 0 before the
     * next sweep replaces it (so old + new text never stack).
     */
    function frozenOpacity(paintAngle) {
        const behind = normalizeAngle(sweepAngle - paintAngle);
        const frac = behind / (Math.PI * 2);
        if (frac >= CONTACT_FADE_END_FRAC) return 0;
        // Ease-out: linger bright, then soft falloff
        const t = frac / CONTACT_FADE_END_FRAC;
        const linger = 0.55;
        if (t <= linger) return 1;
        const u = (t - linger) / (1 - linger);
        return Math.max(0, 1 - u * u);
    }

    function isEmergencySquawk(sq) {
        const s = String(sq || '').trim();
        return s === '7500' || s === '7600' || s === '7700';
    }

    function freezeContact(t, paintAngle) {
        const frac = t.rangeNm / rangeNm;
        if (frac > 1.02) {
            frozenByHex.delete(t.hex);
            return;
        }
        const p = polarToCanvas(t.bearingRad, frac);
        const altBit = formatAlt(t.altFt) + climbArrow(t.climb);
        frozenByHex.set(t.hex, {
            hex: t.hex,
            callsign: t.callsign,
            compactLine: t.callsign + (altBit && altBit !== '----' ? ' ' + altBit : ''),
            line2: altBit + (formatGs(t.gs) ? ' ' + formatGs(t.gs) : ''),
            line3:
                t.rangeNm.toFixed(1) +
                'NM ' +
                String(Math.round(t.bearingDeg)).padStart(3, '0') +
                '°',
            x: p.x,
            y: p.y,
            track: t.track,
            stale: t.stale,
            paintAngle: paintAngle,
            altFt: t.altFt,
            rangeNm: t.rangeNm,
            squawk: t.squawk || ''
        });
    }

    /** Lower score = higher priority (selected / emergency / low / close). */
    function contactPriorityScore(f) {
        if (f.hex === selectedHex) return -1e9;
        let score = 0;
        if (isEmergencySquawk(f.squawk)) score -= 1e6;
        score += (f.altFt != null && isFinite(f.altFt) ? f.altFt : 60000) / 50;
        score += (f.rangeNm != null ? f.rangeNm : 999) * 8;
        return score;
    }

    function labelTextForMode(f, mode) {
        if (mode === 'full') {
            return [f.callsign, f.line2, f.line3];
        }
        if (mode === 'compact') {
            return [f.compactLine || f.callsign];
        }
        if (mode === 'callsign') {
            return [f.callsign];
        }
        return [];
    }

    function measureLabelBox(lines, mode) {
        if (!lines.length) return { w: 0, h: 0 };
        ctx.save();
        ctx.font =
            mode === 'callsign'
                ? '600 10px "Share Tech Mono", ui-monospace, monospace'
                : '600 11px "Share Tech Mono", ui-monospace, monospace';
        let w = 0;
        for (let i = 0; i < lines.length; i++) {
            w = Math.max(w, ctx.measureText(lines[i]).width);
        }
        ctx.restore();
        const lineH = mode === 'full' ? 13 : 12;
        return { w: w + 4, h: lines.length * lineH + 2 };
    }

    function boxesOverlap(a, b, pad) {
        const p = pad != null ? pad : 3;
        return !(
            a.x + a.w + p < b.x ||
            b.x + b.w + p < a.x ||
            a.y + a.h + p < b.y ||
            b.y + b.h + p < a.y
        );
    }

    /**
     * Assign declutter modes + non-overlapping label slots for visible contacts.
     * @returns {Map<string, LabelLayout>}
     */
    function buildLabelLayout(visible) {
        /** @type {Map<string, LabelLayout>} */
        const layout = new Map();
        if (!visible.length) return layout;

        const aggressive = visible.length > 32 || rangeNm >= 50;
        const maxCompact = aggressive ? 1 : CLUSTER_MAX_COMPACT;
        const maxCallsign = aggressive ? 1 : CLUSTER_MAX_CALLSIGN;

        // Sort best-first for mode assignment
        const ranked = visible.slice().sort(function (a, b) {
            return contactPriorityScore(a.f) - contactPriorityScore(b.f);
        });

        /** @type {Map<string, string>} */
        const modes = new Map();

        for (let i = 0; i < ranked.length; i++) {
            const f = ranked[i].f;
            if (!showLabels) {
                modes.set(f.hex, 'none');
                continue;
            }
            if (f.hex === selectedHex) {
                modes.set(f.hex, 'full');
                continue;
            }

            let compactN = 0;
            let callsignN = 0;
            let neighborN = 0;
            for (let j = 0; j < ranked.length; j++) {
                const o = ranked[j].f;
                if (o.hex === f.hex) continue;
                if (Math.hypot(o.x - f.x, o.y - f.y) > CLUSTER_RADIUS_PX) continue;
                neighborN++;
                const m = modes.get(o.hex);
                if (m === 'full' || m === 'compact') compactN++;
                else if (m === 'callsign') callsignN++;
            }

            if (neighborN === 0) {
                modes.set(f.hex, aggressive ? 'callsign' : 'compact');
            } else if (compactN < maxCompact) {
                modes.set(f.hex, 'compact');
            } else if (callsignN < maxCallsign) {
                modes.set(f.hex, 'callsign');
            } else {
                modes.set(f.hex, 'none');
            }
        }

        // Place labels into free slots (priority order)
        /** @type {Array<{x:number,y:number,w:number,h:number}>} */
        const placed = [];

        for (let i = 0; i < ranked.length; i++) {
            const f = ranked[i].f;
            const mode = modes.get(f.hex) || 'none';
            if (mode === 'none') {
                layout.set(f.hex, {
                    mode: 'none',
                    lx: f.x,
                    ly: f.y,
                    align: 'left',
                    w: 0,
                    h: 0
                });
                continue;
            }

            const lines = labelTextForMode(f, mode);
            const box = measureLabelBox(lines, mode);
            let chosen = null;

            for (let s = 0; s < LABEL_SLOTS.length; s++) {
                const slot = LABEL_SLOTS[s];
                const lx =
                    slot.align === 'right' ? f.x + slot.ox - box.w : f.x + slot.ox;
                const ly = f.y + slot.oy;
                const candidate = { x: lx, y: ly, w: box.w, h: box.h };
                let hit = false;
                for (let p = 0; p < placed.length; p++) {
                    if (boxesOverlap(candidate, placed[p], 4)) {
                        hit = true;
                        break;
                    }
                }
                // Prefer not covering other blips
                if (!hit) {
                    for (let j = 0; j < visible.length; j++) {
                        const o = visible[j].f;
                        if (o.hex === f.hex) continue;
                        if (
                            o.x >= candidate.x - 2 &&
                            o.x <= candidate.x + candidate.w + 2 &&
                            o.y >= candidate.y - 2 &&
                            o.y <= candidate.y + candidate.h + 2
                        ) {
                            hit = true;
                            break;
                        }
                    }
                }
                if (!hit) {
                    chosen = {
                        mode: mode,
                        lx: lx,
                        ly: ly,
                        align: slot.align,
                        w: box.w,
                        h: box.h
                    };
                    placed.push(candidate);
                    break;
                }
            }

            if (!chosen) {
                // No free slot — demote to blip-only (selected keeps a fallback)
                if (f.hex === selectedHex) {
                    const lx = f.x + 10;
                    const ly = f.y - 14;
                    chosen = {
                        mode: 'full',
                        lx: lx,
                        ly: ly,
                        align: 'left',
                        w: box.w,
                        h: box.h
                    };
                    placed.push({ x: lx, y: ly, w: box.w, h: box.h });
                } else {
                    chosen = {
                        mode: 'none',
                        lx: f.x,
                        ly: f.y,
                        align: 'left',
                        w: 0,
                        h: 0
                    };
                }
            }
            layout.set(f.hex, chosen);
        }

        return layout;
    }

    function drawLeaderLine(f, lay, alpha) {
        if (!lay || lay.mode === 'none' || lay.w < 1) return;
        const x1 = f.x;
        const y1 = f.y;
        const x2 = lay.align === 'right' ? lay.lx + lay.w : lay.lx;
        const y2 = lay.ly + Math.min(8, lay.h * 0.35);
        // Only draw if label is meaningfully offset
        if (Math.hypot(x2 - x1, y2 - y1) < 16) return;
        ctx.save();
        ctx.globalAlpha = alpha * 0.45;
        ctx.strokeStyle = PHOSPHOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
    }

    function drawFrozenContact(f, opacity, lay) {
        if (opacity < 0.02) return;
        const selected = f.hex === selectedHex;
        const alpha = (f.stale ? 0.5 : 1) * opacity;
        const mode = lay ? lay.mode : 'compact';

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = selected ? '#b8ffc8' : PHOSPHOR;
        ctx.shadowColor = PHOSPHOR;
        ctx.shadowBlur = selected ? 14 : 8;

        ctx.beginPath();
        ctx.arc(f.x, f.y, selected ? 4.5 : 3.2, 0, Math.PI * 2);
        ctx.fill();

        if (f.track != null && isFinite(f.track)) {
            const len = 14;
            const tr = toRad(f.track);
            ctx.beginPath();
            ctx.moveTo(f.x, f.y);
            ctx.lineTo(f.x + Math.sin(tr) * len, f.y - Math.cos(tr) * len);
            ctx.strokeStyle = PHOSPHOR;
            ctx.lineWidth = 1.5;
            ctx.shadowBlur = 4;
            ctx.stroke();
        }
        ctx.restore();

        if (!showLabels || !lay || mode === 'none') return;

        drawLeaderLine(f, lay, alpha);

        const lines = labelTextForMode(f, mode);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 0;
        ctx.textAlign = lay.align === 'right' ? 'right' : 'left';
        ctx.textBaseline = 'top';
        const tx = lay.align === 'right' ? lay.lx + lay.w : lay.lx;

        if (mode === 'full') {
            ctx.font = '600 11px "Share Tech Mono", ui-monospace, monospace';
            ctx.fillStyle = selected ? '#d4ffe0' : PHOSPHOR;
            ctx.fillText(lines[0], tx, lay.ly);
            ctx.font = '10px "Share Tech Mono", ui-monospace, monospace';
            ctx.fillStyle = selected ? 'rgba(212, 255, 224, 0.95)' : 'rgba(51, 255, 102, 0.9)';
            ctx.fillText(lines[1], tx, lay.ly + 13);
            ctx.fillStyle = 'rgba(51, 255, 102, 0.7)';
            ctx.fillText(lines[2], tx, lay.ly + 26);
        } else if (mode === 'compact') {
            ctx.font = '600 11px "Share Tech Mono", ui-monospace, monospace';
            ctx.fillStyle = selected ? '#d4ffe0' : PHOSPHOR;
            ctx.fillText(lines[0], tx, lay.ly);
        } else {
            ctx.font = '600 10px "Share Tech Mono", ui-monospace, monospace';
            ctx.fillStyle = 'rgba(51, 255, 102, 0.85)';
            ctx.fillText(lines[0], tx, lay.ly);
        }
        ctx.restore();
    }

    function drawFrozenContacts() {
        /** @type {Array<{f: FrozenContact, op: number}>} */
        const visible = [];
        frozenByHex.forEach(function (f) {
            const op = f.hex === selectedHex ? 1 : frozenOpacity(f.paintAngle);
            if (op < 0.02) return;
            visible.push({ f: f, op: op });
        });

        const layout = buildLabelLayout(visible);
        lastLabelLayout = layout;

        // Draw blip-only first, then labeled (keeps text on top)
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < visible.length; i++) {
                const item = visible[i];
                const lay = layout.get(item.f.hex);
                const isLabeled = lay && lay.mode !== 'none';
                if (pass === 0 && isLabeled) continue;
                if (pass === 1 && !isLabeled) continue;
                drawFrozenContact(item.f, item.op, lay);
            }
        }
    }

    function bearingInSweepArc(bearing, from, to) {
        // Sweep advances clockwise in our north-based angle space (increasing radians).
        const b = normalizeAngle(bearing);
        const a0 = normalizeAngle(from);
        const a1 = normalizeAngle(to);
        if (a0 <= a1) {
            return b >= a0 && b <= a1;
        }
        // Wrapped past 2π
        return b >= a0 || b <= a1;
    }

    function paintTargetsUnderSweep(prevAngle, nextAngle) {
        const paintSpan = toRad(PAINT_ARC_DEG);
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            const crossed = bearingInSweepArc(t.bearingRad, prevAngle, nextAngle);
            const nearLead = Math.abs(angleDiff(t.bearingRad, nextAngle)) <= paintSpan;
            if (!crossed && !nearLead) continue;

            const last = lastPaintAngle.get(t.hex);
            if (last != null && Math.abs(angleDiff(nextAngle, last)) < paintSpan * 0.5 && !crossed) {
                continue;
            }
            lastPaintAngle.set(t.hex, nextAngle);
            // Replace previous snapshot for this hex — never stack ghosts
            freezeContact(t, nextAngle);
        }
    }

    function pruneMissingFrozen() {
        // Drop snapshots for aircraft that left the feed / range
        const live = Object.create(null);
        for (let i = 0; i < targets.length; i++) {
            live[targets[i].hex] = true;
        }
        frozenByHex.forEach(function (_f, hex) {
            if (!live[hex]) frozenByHex.delete(hex);
        });
    }

    function frame(ts) {
        if (!ctx) return;
        if (!lastFrameTs) lastFrameTs = ts;
        const dt = Math.min(64, ts - lastFrameTs);
        lastFrameTs = ts;

        const prev = sweepAngle;
        const delta = ((Math.PI * 2) / SWEEP_PERIOD_MS) * dt;
        sweepAngle = normalizeAngle(sweepAngle + delta);

        paintTargetsUnderSweep(prev, sweepAngle);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Rings/ticks under the sweep so ticks are not mistaken for trail spokes
        drawStaticScope();

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx + 1, 0, Math.PI * 2);
        ctx.clip();
        drawSweepTrail(sweepAngle);
        drawFrozenContacts();
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx + 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(51, 255, 102, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();

        animId = requestAnimationFrame(frame);
    }

    function targetAtCanvasPoint(x, y) {
        let bestHex = null;
        let bestDist = 28;
        // Prefer label boxes, then blips
        frozenByHex.forEach(function (f) {
            if (frozenOpacity(f.paintAngle) < 0.08 && f.hex !== selectedHex) return;
            const lay = lastLabelLayout.get(f.hex);
            if (lay && lay.mode !== 'none' && lay.w > 0) {
                if (
                    x >= lay.lx - 2 &&
                    x <= lay.lx + lay.w + 2 &&
                    y >= lay.ly - 2 &&
                    y <= lay.ly + lay.h + 2
                ) {
                    bestHex = f.hex;
                    bestDist = 0;
                    return;
                }
            }
            const d = Math.hypot(f.x - x, f.y - y);
            if (d < bestDist) {
                bestDist = d;
                bestHex = f.hex;
            }
        });
        if (!bestHex) return null;
        return (
            targets.find(function (t) {
                return t.hex === bestHex;
            }) || null
        );
    }

    function showDetail(t) {
        if (!detailEl || !detailBodyEl) return;
        selectedHex = t.hex;
        detailEl.hidden = false;
        detailEl.setAttribute('aria-hidden', 'false');
        const rows = [
            ['Callsign', t.callsign],
            ['ICAO', t.hex.toUpperCase()],
            ['Registration', t.reg || '—'],
            ['Type', t.type || '—'],
            ['Altitude', formatAlt(t.altFt) + (climbArrow(t.climb) ? ' ' + climbArrow(t.climb) : '')],
            ['Ground speed', t.gs != null ? Math.round(t.gs) + ' kt' : '—'],
            ['Track', t.track != null ? Math.round(t.track) + '°' : '—'],
            ['Range / bearing', t.rangeNm.toFixed(1) + ' NM / ' + Math.round(t.bearingDeg) + '°'],
            ['Squawk', t.squawk || '—'],
            ['Position age', t.ageSec != null ? Math.round(t.ageSec) + 's' : '—']
        ];
        let html =
            '<h2 class="radar-detail-title" id="radarDetailTitle">' +
            escapeHtml(t.callsign) +
            '</h2>' +
            '<p class="radar-detail-sub">' +
            escapeHtml(t.hex.toUpperCase()) +
            (t.ground ? ' · ground' : '') +
            (t.stale ? ' · stale' : '') +
            '</p><table class="radar-detail-table">';
        for (let i = 0; i < rows.length; i++) {
            html +=
                '<tr><th>' +
                escapeHtml(rows[i][0]) +
                '</th><td>' +
                escapeHtml(rows[i][1]) +
                '</td></tr>';
        }
        html +=
            '</table><p class="radar-detail-links"><a href="https://globe.adsbexchange.com/?icao=' +
            encodeURIComponent(t.hex) +
            '" target="_blank" rel="noopener">ADS-B Exchange</a> · <a href="https://adsb.lol/?icao=' +
            encodeURIComponent(t.hex) +
            '" target="_blank" rel="noopener">ADSB.lol</a></p>';
        detailBodyEl.innerHTML = html;
    }

    function hideDetail() {
        selectedHex = null;
        if (!detailEl) return;
        detailEl.hidden = true;
        detailEl.setAttribute('aria-hidden', 'true');
        if (detailBodyEl) detailBodyEl.innerHTML = '';
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function onCanvasPointer(ev) {
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        const hit = targetAtCanvasPoint(x, y);
        if (hit) {
            showDetail(hit);
        } else {
            hideDetail();
        }
    }

    function setRange(nm) {
        if (RANGE_OPTIONS.indexOf(nm) === -1) return;
        rangeNm = nm;
        saveRange();
        syncRangeButtons();
        clearFrozenContacts();
        fetchTraffic();
        updateStatusBar();
    }

    function syncRangeButtons() {
        const buttons = document.querySelectorAll('[data-radar-range]');
        buttons.forEach(function (btn) {
            const v = Number(btn.getAttribute('data-radar-range'));
            const on = v === rangeNm;
            btn.classList.toggle('radar-btn--active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function locateMe() {
        setStatus('Acquiring position…');
        function apply(pos) {
            center = {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude
            };
            saveCenter();
            clearFrozenContacts();
            fetchTraffic();
        }
        function fail(err) {
            const msg =
                typeof GeoLocate !== 'undefined' && GeoLocate.geolocationErrorMessage
                    ? GeoLocate.geolocationErrorMessage(err)
                    : 'Could not get location.';
            setStatus(msg, true);
        }
        if (typeof GeoLocate !== 'undefined' && GeoLocate.getCurrentPositionRobust) {
            GeoLocate.getCurrentPositionRobust(apply, fail);
            return;
        }
        if (!navigator.geolocation) {
            setStatus('Geolocation not available in this browser.', true);
            return;
        }
        navigator.geolocation.getCurrentPosition(apply, fail, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        });
    }

    function tryInitialGeolocation() {
        if (typeof GeoLocate !== 'undefined' && GeoLocate.shouldSkipAutomaticGeolocation && GeoLocate.shouldSkipAutomaticGeolocation()) {
            return;
        }
        function apply(pos) {
            center = {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude
            };
            saveCenter();
            clearFrozenContacts();
            fetchTraffic();
        }
        if (typeof GeoLocate !== 'undefined' && GeoLocate.getCurrentPositionRobust) {
            GeoLocate.getCurrentPositionRobust(apply, function () {
                /* keep stored / default */
            });
            return;
        }
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(apply, function () {}, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 60000
        });
    }

    function bindUi() {
        document.querySelectorAll('[data-radar-range]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setRange(Number(btn.getAttribute('data-radar-range')));
            });
        });

        const locateBtn = document.getElementById('radarLocateBtn');
        if (locateBtn) locateBtn.addEventListener('click', locateMe);

        const refreshBtn = document.getElementById('radarRefreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                fetchTraffic();
            });
        }

        const groundToggle = document.getElementById('radarHideGround');
        if (groundToggle) {
            groundToggle.checked = hideGround;
            groundToggle.addEventListener('change', function () {
                hideGround = !!groundToggle.checked;
                fetchTraffic();
            });
        }

        const labelsToggle = document.getElementById('radarShowLabels');
        if (labelsToggle) {
            labelsToggle.checked = showLabels;
            labelsToggle.addEventListener('change', function () {
                showLabels = !!labelsToggle.checked;
            });
        }

        const detailClose = document.getElementById('radarDetailClose');
        if (detailClose) detailClose.addEventListener('click', hideDetail);
        const detailBackdrop = document.getElementById('radarDetailBackdrop');
        if (detailBackdrop) detailBackdrop.addEventListener('click', hideDetail);

        canvas.addEventListener('click', onCanvasPointer);

        window.addEventListener('resize', function () {
            resizeCanvas();
        });

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') fetchTraffic();
        });
    }

    function init() {
        canvas = document.getElementById('radarCanvas');
        wrapEl = document.getElementById('radarScopeWrap');
        statusEl = document.getElementById('radarStatus');
        detailEl = document.getElementById('radarDetailSheet');
        detailBodyEl = document.getElementById('radarDetailBody');
        if (!canvas || !wrapEl) return;
        ctx = canvas.getContext('2d');
        if (!ctx) return;

        loadStoredCenter();
        loadStoredRange();
        syncRangeButtons();
        bindUi();
        resizeCanvas();
        // Seed background
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

        setStatus('Starting radar…');
        fetchTraffic();
        restartPollTimer();
        tryInitialGeolocation();
        lastFrameTs = 0;
        animId = requestAnimationFrame(frame);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
