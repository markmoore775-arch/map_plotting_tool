/* ============================================
   WEATHER WIND OVERLAY - Windy-style wind map
   Colour speed field + animated white streamlines
   Open-Meteo grid data
   ============================================ */

(function () {
    'use strict';

    const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
    const GRID_SIZE = 13;
    const CHUNK_SIZE = 90;
    const REFRESH_DEBOUNCE_MS = 650;

    /** Wind speed (m/s) → RGB. Calm = green, strong = red (Windy-like). */
    const COLOR_SCALE = [
        [98, 187, 106],
        [130, 205, 115],
        [175, 220, 110],
        [230, 225, 80],
        [250, 195, 60],
        [245, 145, 45],
        [230, 85, 35],
        [195, 40, 40]
    ];
    const COLOR_REF_MAX_MS = 14;

    let map = null;
    let windLayer = null;
    let enabled = false;
    let altitude = '120m';
    let refreshTimer = null;
    let fetchGen = 0;
    let optionsProvider = null;
    let statusCallback = null;
    let lastStatus = 'off';

    const IS_MOBILE = /android|iphone|ipad|ipod|iemobile|webos/i.test(navigator.userAgent);

    function setStatus(status, detail) {
        lastStatus = status;
        if (typeof statusCallback === 'function') {
            statusCallback(status, detail || '');
        }
    }

    function metToUv(speedKmh, dirDeg) {
        if (speedKmh == null || dirDeg == null || !isFinite(speedKmh) || !isFinite(dirDeg)) {
            return [0, 0];
        }
        var speedMs = speedKmh / 3.6;
        var rad = (dirDeg * Math.PI) / 180;
        return [-speedMs * Math.sin(rad), -speedMs * Math.cos(rad)];
    }

    function pickHourIndex(times, targetTimeMs) {
        if (!times || !times.length) return 0;
        var target = targetTimeMs == null ? Date.now() : targetTimeMs;
        var bestIdx = 0;
        var bestDiff = Infinity;
        for (var i = 0; i < times.length; i++) {
            var diff = Math.abs(new Date(times[i]).getTime() - target);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    function buildGrid(bounds) {
        var sw = bounds.getSouthWest();
        var ne = bounds.getNorthEast();
        var nx = GRID_SIZE;
        var ny = GRID_SIZE;
        var padLat = (ne.lat - sw.lat) * 0.06;
        var padLng = (ne.lng - sw.lng) * 0.06;
        var south = sw.lat - padLat;
        var north = ne.lat + padLat;
        var west = sw.lng - padLng;
        var east = ne.lng + padLng;
        var dLon = nx > 1 ? (east - west) / (nx - 1) : 0;
        var dLat = ny > 1 ? (north - south) / (ny - 1) : 0;

        var lats = [];
        var lons = [];
        for (var j = 0; j < ny; j++) {
            var lat = north - j * dLat;
            for (var i = 0; i < nx; i++) {
                lats.push(lat);
                lons.push(west + i * dLon);
            }
        }

        return {
            nx: nx,
            ny: ny,
            lo1: west,
            la1: north,
            dx: dLon,
            dy: -dLat,
            lats: lats,
            lons: lons
        };
    }

    function speedToColor(speedMs) {
        var t = Math.max(0, Math.min(1, speedMs / COLOR_REF_MAX_MS));
        var idx = t * (COLOR_SCALE.length - 1);
        var i0 = Math.floor(idx);
        var i1 = Math.min(i0 + 1, COLOR_SCALE.length - 1);
        var f = idx - i0;
        var c0 = COLOR_SCALE[i0];
        var c1 = COLOR_SCALE[i1];
        return [
            Math.round(c0[0] + (c1[0] - c0[0]) * f),
            Math.round(c0[1] + (c1[1] - c0[1]) * f),
            Math.round(c0[2] + (c1[2] - c0[2]) * f)
        ];
    }

    function createWindField(grid, speedsKmh, directions) {
        var nx = grid.nx;
        var ny = grid.ny;
        var lo1 = grid.lo1;
        var la1 = grid.la1;
        var dx = grid.dx;
        var dy = grid.dy;
        var us = [];
        var vs = [];
        var speedsMs = [];
        var maxSpeed = 0.1;

        for (var i = 0; i < speedsKmh.length; i++) {
            var uv = metToUv(speedsKmh[i], directions[i]);
            us.push(uv[0]);
            vs.push(uv[1]);
            var spd = Math.sqrt(uv[0] * uv[0] + uv[1] * uv[1]);
            speedsMs.push(spd);
            if (spd > maxSpeed) maxSpeed = spd;
        }

        function interpolate(lng, lat) {
            if (dx === 0 || dy === 0) return null;
            var fi = (lng - lo1) / dx;
            var latStep = Math.abs(dy);
            var fj = (la1 - lat) / latStep;
            if (fi < 0 || fj < 0 || fi > nx - 1 || fj > ny - 1) return null;

            var i0 = Math.floor(fi);
            var j0 = Math.floor(fj);
            var i1 = Math.min(i0 + 1, nx - 1);
            var j1 = Math.min(j0 + 1, ny - 1);
            var tx = fi - i0;
            var ty = fj - j0;

            function at(ci, ri) {
                var idx = ri * nx + ci;
                return [us[idx], vs[idx], speedsMs[idx]];
            }

            var a = at(i0, j0);
            var b = at(i1, j0);
            var c = at(i0, j1);
            var d = at(i1, j1);
            var u = a[0] * (1 - tx) * (1 - ty) + b[0] * tx * (1 - ty) + c[0] * (1 - tx) * ty + d[0] * tx * ty;
            var v = a[1] * (1 - tx) * (1 - ty) + b[1] * tx * (1 - ty) + c[1] * (1 - tx) * ty + d[1] * tx * ty;
            var speed = Math.sqrt(u * u + v * v);
            if (!isFinite(speed)) return null;
            return [u, v, speed];
        }

        return {
            interpolate: interpolate,
            maxSpeed: maxSpeed,
            grid: grid,
            speedsMs: speedsMs,
            speedsKmh: speedsKmh
        };
    }

    function windToPixelDelta(map, lng, lat, u, v) {
        var simSec = 35;
        var mPerDegLat = 111320;
        var cosLat = Math.cos((lat * Math.PI) / 180) || 1;
        var dLat = (v * simSec) / mPerDegLat;
        var dLng = (u * simSec) / (mPerDegLat * cosLat);
        var p0 = map.latLngToContainerPoint(L.latLng(lat, lng));
        var p1 = map.latLngToContainerPoint(L.latLng(lat + dLat, lng + dLng));
        var dx = p1.x - p0.x;
        var dy = p1.y - p0.y;
        var mag = Math.hypot(dx, dy);
        var maxStep = 2.1;
        var minStep = 0.4;
        if (mag > maxStep) {
            dx = (dx / mag) * maxStep;
            dy = (dy / mag) * maxStep;
        } else if (mag > 0 && mag < minStep) {
            dx = (dx / mag) * minStep;
            dy = (dy / mag) * minStep;
        }
        return [dx, dy];
    }

    function smoothParticleDir(p, dx, dy) {
        var mag = Math.hypot(dx, dy);
        if (mag < 0.001) return [p.vx || 1, p.vy || 0];
        var nx = dx / mag;
        var ny = dy / mag;
        if (p.vx == null || p.vy == null) {
            p.vx = nx;
            p.vy = ny;
        } else {
            p.vx = p.vx * 0.6 + nx * 0.4;
            p.vy = p.vy * 0.6 + ny * 0.4;
            var vm = Math.hypot(p.vx, p.vy) || 1;
            p.vx /= vm;
            p.vy /= vm;
        }
        return [p.vx, p.vy];
    }

    function drawWindComet(ctx, tailX, tailY, headX, headY, width, headAlpha) {
        var grad = ctx.createLinearGradient(tailX, tailY, headX, headY);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        grad.addColorStop(0.2, 'rgba(255, 255, 255, 0.05)');
        grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.28)');
        grad.addColorStop(0.85, 'rgba(255, 255, 255, 0.65)');
        grad.addColorStop(1, 'rgba(255, 255, 255, ' + Math.min(0.9, headAlpha).toFixed(3) + ')');
        ctx.strokeStyle = grad;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(headX, headY);
        ctx.stroke();
    }

    function cometTailLength(speedMs, maxSpeed) {
        var t = Math.min(1, speedMs / Math.max(maxSpeed, 1));
        return 4 + t * 5;
    }

    function particleBudget(map) {
        var size = map.getSize();
        var base = Math.round(Math.sqrt(size.x * size.y) * 0.32);
        var zoom = map.getZoom();
        if (zoom <= 8) base = Math.round(base * 0.55);
        else if (zoom >= 13) base = Math.round(base * 1.15);
        if (IS_MOBILE) base = Math.round(base * 0.72);
        return Math.max(120, Math.min(IS_MOBILE ? 280 : 420, base));
    }

    const WindOverlayLayer = L.Layer.extend({
        initialize: function () {
            this._field = null;
            this._particles = [];
            this._animId = null;
            this._lastFrame = 0;
            this._paused = false;
            this._fadeAlpha = IS_MOBILE ? 0.91 : 0.93;
            this._maxAge = IS_MOBILE ? 48 : 64;
            this._frameMs = IS_MOBILE ? 1000 / 12 : 1000 / 14;
            this._cometWidth = IS_MOBILE ? 2 : 2.35;
        },

        setWindField: function (field) {
            this._field = field;
            this._drawColorField();
            this._seedParticles(true);
        },

        onAdd: function (map) {
            this._map = map;
            this._paused = false;

            this._colorCanvas = L.DomUtil.create('canvas', 'weather-wind-color-canvas');
            this._particleCanvas = L.DomUtil.create('canvas', 'weather-wind-canvas');
            this._colorCanvas.style.pointerEvents = 'none';
            this._particleCanvas.style.pointerEvents = 'none';

            var pane = map.getPane('overlayPane');
            pane.appendChild(this._colorCanvas);
            pane.appendChild(this._particleCanvas);

            map.on('movestart', this._onMoveStart, this);
            map.on('moveend', this._onMoveEnd, this);
            map.on('zoomstart', this._onMoveStart, this);
            map.on('zoomend', this._onMoveEnd, this);
            map.on('resize', this._onResize, this);

            this._onResize();
            this._seedParticles(true);
            this._lastFrame = performance.now();
            this._animId = requestAnimationFrame(this._frame.bind(this));
        },

        onRemove: function (map) {
            this._paused = true;
            if (this._animId) cancelAnimationFrame(this._animId);
            this._animId = null;
            map.off('movestart', this._onMoveStart, this);
            map.off('moveend', this._onMoveEnd, this);
            map.off('zoomstart', this._onMoveStart, this);
            map.off('zoomend', this._onMoveEnd, this);
            map.off('resize', this._onResize, this);
            L.DomUtil.remove(this._colorCanvas);
            L.DomUtil.remove(this._particleCanvas);
            this._colorCanvas = null;
            this._particleCanvas = null;
        },

        _onMoveStart: function () {
            this._paused = true;
        },

        _onMoveEnd: function () {
            this._paused = false;
            this._onResize();
            this._drawColorField();
            this._seedParticles(true);
        },

        _onResize: function () {
            if (!this._map) return;
            var size = this._map.getSize();
            var dpr = window.devicePixelRatio || 1;
            var topLeft = this._map.containerPointToLayerPoint([0, 0]);

            [this._colorCanvas, this._particleCanvas].forEach(function (canvas) {
                if (!canvas) return;
                canvas.width = Math.round(size.x * dpr);
                canvas.height = Math.round(size.y * dpr);
                canvas.style.width = size.x + 'px';
                canvas.style.height = size.y + 'px';
                L.DomUtil.setPosition(canvas, topLeft);
                var ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, size.x, size.y);
            });
        },

        _drawColorField: function () {
            if (!this._map || !this._colorCanvas || !this._field) return;

            var ctx = this._colorCanvas.getContext('2d');
            var size = this._map.getSize();
            var grid = this._field.grid;
            var nx = grid.nx;
            var ny = grid.ny;
            var latStep = Math.abs(grid.dy);

            ctx.clearRect(0, 0, size.x, size.y);

            for (var j = 0; j < ny - 1; j++) {
                for (var i = 0; i < nx - 1; i++) {
                    var idx00 = j * nx + i;
                    var idx10 = j * nx + (i + 1);
                    var idx01 = (j + 1) * nx + i;
                    var idx11 = (j + 1) * nx + (i + 1);

                    var latN = grid.la1 - j * latStep;
                    var latS = grid.la1 - (j + 1) * latStep;
                    var lngW = grid.lo1 + i * grid.dx;
                    var lngE = grid.lo1 + (i + 1) * grid.dx;

                    var sw = this._map.latLngToContainerPoint(L.latLng(latS, lngW));
                    var ne = this._map.latLngToContainerPoint(L.latLng(latN, lngE));

                    var avgMs = (
                        this._field.speedsMs[idx00] +
                        this._field.speedsMs[idx10] +
                        this._field.speedsMs[idx01] +
                        this._field.speedsMs[idx11]
                    ) / 4;
                    var rgb = speedToColor(avgMs);
                    ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.62)';
                    ctx.fillRect(sw.x, ne.y, ne.x - sw.x + 1, sw.y - ne.y + 1);
                }
            }
        },

        _seedParticles: function (clear) {
            if (!this._map) return;
            var size = this._map.getSize();
            var count = particleBudget(this._map);
            this._particles = [];
            for (var n = 0; n < count; n++) {
                this._particles.push({
                    x: Math.random() * size.x,
                    y: Math.random() * size.y,
                    vx: null,
                    vy: null,
                    age: Math.floor(Math.random() * this._maxAge),
                    maxAge: this._maxAge
                });
            }
            if (clear && this._particleCanvas) {
                var ctx = this._particleCanvas.getContext('2d');
                ctx.clearRect(0, 0, size.x, size.y);
            }
        },

        _randomizeParticle: function (p) {
            if (!this._map) return p;
            var size = this._map.getSize();
            for (var tries = 0; tries < 24; tries++) {
                p.x = Math.random() * size.x;
                p.y = Math.random() * size.y;
                var ll = this._map.containerPointToLatLng(L.point(p.x, p.y));
                if (this._field && this._field.interpolate(ll.lng, ll.lat)) {
                    p.age = 0;
                    p.vx = null;
                    p.vy = null;
                    return p;
                }
            }
            p.age = p.maxAge;
            return p;
        },

        _frame: function (now) {
            this._animId = requestAnimationFrame(this._frame.bind(this));
            if (this._paused || !this._map || !this._particleCanvas || !this._field) return;

            var dt = now - this._lastFrame;
            if (dt < this._frameMs) return;
            this._lastFrame = now;

            var size = this._map.getSize();
            var ctx = this._particleCanvas.getContext('2d');

            ctx.globalCompositeOperation = 'destination-in';
            ctx.fillStyle = 'rgba(0, 0, 0, ' + this._fadeAlpha + ')';
            ctx.fillRect(0, 0, size.x, size.y);
            ctx.globalCompositeOperation = 'source-over';
            var maxSpeed = this._field.maxSpeed || 10;
            var cometW = this._cometWidth;

            for (var pi = 0; pi < this._particles.length; pi++) {
                var p = this._particles[pi];
                p.age += 1;
                if (p.age >= p.maxAge) {
                    this._randomizeParticle(p);
                    continue;
                }

                var ll = this._map.containerPointToLatLng(L.point(p.x, p.y));
                var w = this._field.interpolate(ll.lng, ll.lat);
                if (!w || w[2] < 0.05) {
                    p.age = p.maxAge;
                    continue;
                }

                var delta = windToPixelDelta(this._map, ll.lng, ll.lat, w[0], w[1]);
                var dir = smoothParticleDir(p, delta[0], delta[1]);
                var nx = p.x + delta[0];
                var ny = p.y + delta[1];
                if (nx < 0 || ny < 0 || nx > size.x || ny > size.y) {
                    this._randomizeParticle(p);
                    continue;
                }

                var tailLen = cometTailLength(w[2], maxSpeed);
                var hx = nx;
                var hy = ny;
                var tx = hx - dir[0] * tailLen;
                var ty = hy - dir[1] * tailLen;
                var life = 1 - p.age / p.maxAge;
                var headAlpha = 0.48 + life * 0.38;

                drawWindComet(ctx, tx, ty, hx, hy, cometW, headAlpha);
                p.x = nx;
                p.y = ny;
            }
        }
    });

    function getOptions() {
        if (typeof optionsProvider === 'function') {
            return optionsProvider() || {};
        }
        return {};
    }

    async function fetchWindGrid(grid) {
        var opts = getOptions();
        var model = opts.model || 'auto';
        var targetTimeMs = opts.targetTimeMs;
        var speedKey = altitude === '120m' ? 'wind_speed_120m' : 'wind_speed_10m';
        var dirKey = altitude === '120m' ? 'wind_direction_120m' : 'wind_direction_10m';
        var hourly = speedKey + ',' + dirKey;
        var speedsKmh = new Array(grid.lats.length);
        var directions = new Array(grid.lats.length);

        for (var off = 0; off < grid.lats.length; off += CHUNK_SIZE) {
            var chunkLats = grid.lats.slice(off, off + CHUNK_SIZE);
            var chunkLons = grid.lons.slice(off, off + CHUNK_SIZE);
            var params = new URLSearchParams({
                latitude: chunkLats.map(function (l) { return l.toFixed(4); }).join(','),
                longitude: chunkLons.map(function (l) { return l.toFixed(4); }).join(','),
                hourly: hourly,
                forecast_days: '16',
                timezone: 'auto',
                wind_speed_unit: 'kmh'
            });
            if (model !== 'auto') {
                params.set('models', model);
            }

            var resp = await fetch(OPEN_METEO_BASE + '?' + params.toString());
            if (!resp.ok) {
                throw new Error('Wind overlay unavailable (HTTP ' + resp.status + ')');
            }
            var json = await resp.json();
            var entries = Array.isArray(json) ? json : [json];

            for (var e = 0; e < entries.length; e++) {
                var entry = entries[e];
                var idx = off + e;
                var times = entry.hourly && entry.hourly.time;
                var hourIdx = pickHourIndex(times, targetTimeMs);
                speedsKmh[idx] = entry.hourly && entry.hourly[speedKey] != null
                    ? entry.hourly[speedKey][hourIdx]
                    : 0;
                directions[idx] = entry.hourly && entry.hourly[dirKey] != null
                    ? entry.hourly[dirKey][hourIdx]
                    : 0;
            }
        }

        return createWindField(grid, speedsKmh, directions);
    }

    function mountWindLayer(field) {
        if (!map || typeof L === 'undefined') return null;
        removeWindLayer();
        windLayer = new WindOverlayLayer();
        windLayer.addTo(map);
        windLayer.setWindField(field);
        return windLayer;
    }

    function removeWindLayer() {
        if (windLayer && map) {
            map.removeLayer(windLayer);
        }
        windLayer = null;
    }

    async function loadOverlayData() {
        if (!enabled || !map) return;
        if (typeof L === 'undefined') {
            setStatus('error', 'Map library failed to load');
            return;
        }

        var gen = ++fetchGen;
        setStatus('loading', '');

        try {
            var grid = buildGrid(map.getBounds());
            var field = await fetchWindGrid(grid);
            if (gen !== fetchGen || !enabled) return;
            mountWindLayer(field);
            setStatus('ready', altitude === '120m' ? '120 m AGL' : '10 m');
        } catch (err) {
            if (gen !== fetchGen) return;
            setStatus('error', err && err.message ? err.message : 'Wind fetch failed');
        }
    }

    function scheduleRefresh() {
        if (!enabled) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            loadOverlayData();
        }, REFRESH_DEBOUNCE_MS);
    }

    function bindMapEvents() {
        if (!map || map._weatherWindOverlayBound) return;
        map._weatherWindOverlayBound = true;
        map.on('moveend', scheduleRefresh);
        map.on('zoomend', scheduleRefresh);
    }

    function setEnabled(on) {
        enabled = !!on;
        fetchGen++;
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }

        if (!enabled) {
            removeWindLayer();
            setStatus('off', '');
            return;
        }

        bindMapEvents();
        loadOverlayData();
    }

    function setAltitude(value) {
        var next = value === '10m' ? '10m' : '120m';
        if (altitude === next) return;
        altitude = next;
        if (enabled) {
            fetchGen++;
            loadOverlayData();
        }
    }

    window.WeatherWindOverlay = {
        init: function (mapInstance) {
            map = mapInstance;
            bindMapEvents();
        },

        setOptionsProvider: function (fn) {
            optionsProvider = fn;
        },

        setStatusCallback: function (fn) {
            statusCallback = fn;
        },

        setEnabled: setEnabled,
        isEnabled: function () { return enabled; },

        setAltitude: setAltitude,
        getAltitude: function () { return altitude; },

        refresh: function () {
            if (enabled) loadOverlayData();
        },

        onOptionsChanged: function () {
            if (enabled) scheduleRefresh();
        },

        getState: function () {
            return { enabled: enabled, altitude: altitude };
        },

        applyState: function (state) {
            if (!state) return;
            if (state.altitude) {
                altitude = state.altitude === '10m' ? '10m' : '120m';
            }
            setEnabled(!!state.enabled);
        },

        getLastStatus: function () {
            return lastStatus;
        }
    };
})();
