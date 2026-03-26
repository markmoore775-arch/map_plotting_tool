/* ============================================
   AIRSPACE PAGE — ADS-B traffic (ADSB.lol API)
   Plane markers, session trail, detail on click
   Loaded only by airspace.html. Planning UK layers: js/uk-airspace-layers.js (Airspace.init).
   ============================================ */

(function () {
    'use strict';

    const ADSB_LOL_BASE = 'https://api.adsb.lol/v2';
    const MIN_POLL_MS = 1100;
    const MOVE_DEBOUNCE_MS = 500;
    const RADIUS_MIN_NM = 5;
    const RADIUS_MAX_NM = 250;
    /** Recent positions per ICAO hex (API has no trail; we build from polls) */
    const MAX_TRAIL_POINTS = 120;

    const HELP_HTML = [
        '<p class="airspace-help-lead"><strong>Airspace</strong> (AirPlot v3) uses <a href="https://api.adsb.lol/docs" target="_blank" rel="noopener">ADSB.lol</a> for <strong>hazard awareness</strong> while flying drones: aircraft use <strong>red</strong> icons by altitude band, <strong>altitude (ft)</strong> is shown next to each track, and a <strong>session trail</strong> builds while this tab stays open.</p>',
        '<p><strong>Not for separation.</strong> Situational awareness only.</p>',
        '<p><strong>Steps</strong></p>',
        '<ol class="airspace-help-list">',
        '<li>Default map is <strong>OpenStreetMap</strong>; switch to <strong>Dark (Carto)</strong> in the layer control for a night-tracker look. <strong>Altitude (ft)</strong> is shown next to each aircraft; tap for full detail and the highlighted path.</li>',
        '<li>While details are open, <strong>auto-refresh pauses</strong> so the panel and trail stay on screen. Close the panel or tap <strong>Refresh</strong> to update positions. The red-orange line is from this session—not full flight history (see ADSB.lol docs for archives).</li>',
        '</ol>',
        '<p>Local dev: <code>npm run serve</code> for <code>/api/adsb</code>. Open <a href="flight-notes.html">Flight Notes</a> or the <a href="checklist.html">Checklist</a> from the welcome screen.</p>'
    ].join('');

    let map;
    let trafficLayer;
    let trafficEnabled = true;
    let pollTimer = null;
    let moveDebounce = null;
    let lastFetchAt = 0;
    let isFetching = false;

    /** @type {Map<string, number[][]>} */
    const trailByHex = new Map();
    /** @type {L.Polyline|null} */
    let selectedTrailPolyline = null;

    /** True while a traffic marker popup is open (pauses polling so the panel is not torn down). */
    let trafficPopupOpen = false;
    /** ICAO hex of the open popup — preserved across forced re-renders (Refresh). */
    let pinnedHex = null;
    /** Leaflet fires popupclose when clearing layers; suppress clearing our pinned state during re-render. */
    let suppressTrafficPopupClose = false;

    function escapeHtml(s) {
        if (s == null || s === '') return '';
        const d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    function normalizeHex(h) {
        return String(h || '')
            .toLowerCase()
            .replace(/[^0-9a-f]/g, '');
    }

    function formatTime(ts) {
        if (ts == null) return '—';
        try {
            const sec = typeof ts === 'number' && ts > 1e12 ? Math.floor(ts / 1000) : ts;
            return new Date(sec * 1000).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            return '—';
        }
    }

    function setStatus(html, isError) {
        const el = document.getElementById('airspaceStatus');
        if (!el) return;
        el.classList.toggle('airspace-status-error', !!isError);
        el.innerHTML = html;
    }

    function radiusMetersFromBounds(bounds) {
        const c = bounds.getCenter();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const nw = L.latLng(ne.lat, sw.lng);
        const se = L.latLng(sw.lat, ne.lng);
        const d1 = c.distanceTo(sw);
        const d2 = c.distanceTo(ne);
        const d3 = c.distanceTo(nw);
        const d4 = c.distanceTo(se);
        return Math.max(d1, d2, d3, d4) * 1.08;
    }

    function radiusNmForMap() {
        const b = map.getBounds();
        if (b.getWest() > b.getEast()) {
            return null;
        }
        const m = radiusMetersFromBounds(b);
        const nm = m / 1852;
        return Math.min(RADIUS_MAX_NM, Math.max(RADIUS_MIN_NM, nm));
    }

    function clearTraffic() {
        suppressTrafficPopupClose = true;
        trafficLayer.clearLayers();
        suppressTrafficPopupClose = false;
    }

    function isGroundAircraft(a) {
        const alt = a.alt_baro;
        const gs = a.gs;
        if (alt != null && alt < 400) return true;
        if (gs != null && gs < 8) return true;
        return false;
    }

    /** Altitude band for CSS `airspace-icon--*` (red hazard ramp in airspace.css). */
    function altitudeIconTier(a) {
        if (isGroundAircraft(a)) return 'ground';
        const alt = a.alt_baro;
        if (alt == null) return 'low';
        if (alt >= 26000) return 'high';
        if (alt >= 10000) return 'mid';
        return 'low';
    }

    /** ICAO ADS-B emitter category A7 = rotorcraft; description / type hints. */
    function isHelicopter(a) {
        const cat = (a.category && String(a.category).toUpperCase()) || '';
        if (cat === 'A7') return true;
        const desc = (a.desc && String(a.desc).toLowerCase()) || '';
        if (desc.indexOf('helicopter') !== -1 || desc.indexOf('rotorcraft') !== -1) {
            return true;
        }
        const typ = (a.t && String(a.t).toUpperCase()) || '';
        if (/^H[0-9]/.test(typ)) return true;
        return false;
    }

    /** Lucide icons: align ~north for track 0° (tune per silhouette). */
    const PLANE_ICON_ROTATION_OFFSET = -45;
    const HELI_ICON_ROTATION_OFFSET = -90;

    const ICON_STROKE_W = 2.85;

    function planeIconHtml(trackDeg, tier) {
        const tr = trackDeg != null && !Number.isNaN(Number(trackDeg)) ? Number(trackDeg) : 0;
        const rot = tr + PLANE_ICON_ROTATION_OFFSET;
        const size = 36;
        return (
            '<div class="airspace-plane-rot airspace-icon airspace-icon--' +
            tier +
            '" style="transform:rotate(' +
            rot +
            'deg)">' +
            '<svg class="airspace-plane-svg" xmlns="http://www.w3.org/2000/svg" width="' +
            size +
            '" height="' +
            size +
            '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
            ICON_STROKE_W +
            '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>' +
            '</svg></div>'
        );
    }

    function helicopterIconHtml(trackDeg, tier) {
        const tr = trackDeg != null && !Number.isNaN(Number(trackDeg)) ? Number(trackDeg) : 0;
        const rot = tr + HELI_ICON_ROTATION_OFFSET;
        const size = 36;
        return (
            '<div class="airspace-plane-rot airspace-heli-rot airspace-icon airspace-icon--' +
            tier +
            '" style="transform:rotate(' +
            rot +
            'deg)">' +
            '<svg class="airspace-plane-svg" xmlns="http://www.w3.org/2000/svg" width="' +
            size +
            '" height="' +
            size +
            '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
            ICON_STROKE_W +
            '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M11 17v4"/>' +
            '<path d="M14 3v8a2 2 0 0 0 2 2h5.865"/>' +
            '<path d="M17 17v4"/>' +
            '<path d="M18 17a4 4 0 0 0 4-4 8 6 0 0 0-8-6 6 5 0 0 0-6 5v3a2 2 0 0 0 2 2z"/>' +
            '<path d="M2 10v5"/>' +
            '<path d="M6 3h16"/>' +
            '<path d="M7 21h14"/>' +
            '<path d="M8 13H2"/>' +
            '</svg></div>'
        );
    }

    function aircraftIconHtml(trackDeg, tier, heli) {
        if (heli) return helicopterIconHtml(trackDeg, tier);
        return planeIconHtml(trackDeg, tier);
    }

    function recordTrailsFromList(ac) {
        if (!ac || !ac.length) return;
        for (let i = 0; i < ac.length; i++) {
            const a = ac[i];
            const hex = normalizeHex(a.hex);
            if (hex.length !== 6) continue;
            if (a.lat == null || a.lon == null) continue;
            let arr = trailByHex.get(hex);
            if (!arr) arr = [];
            const last = arr[arr.length - 1];
            if (last && last[0] === a.lat && last[1] === a.lon) continue;
            arr.push([a.lat, a.lon]);
            if (arr.length > MAX_TRAIL_POINTS) {
                arr = arr.slice(-MAX_TRAIL_POINTS);
            }
            trailByHex.set(hex, arr);
        }
    }

    function fmtNum(n, suffix) {
        if (n == null || Number.isNaN(Number(n))) return '—';
        return Math.round(Number(n)) + (suffix || '');
    }

    /** Short baro/geom altitude for always-visible map labels (ft, prime = feet). */
    function formatAltitudeLabel(a) {
        if (a.alt_baro != null && !Number.isNaN(Number(a.alt_baro))) {
            return Math.round(Number(a.alt_baro)) + "'";
        }
        if (a.alt_geom != null && !Number.isNaN(Number(a.alt_geom))) {
            return Math.round(Number(a.alt_geom)) + "' g";
        }
        if (isGroundAircraft(a)) return 'GND';
        return '—';
    }

    function buildPopupHtml(a, trailPts) {
        const flight = (a.flight && String(a.flight).trim()) || '';
        const hex = a.hex || '';
        const reg = (a.r && String(a.r).trim()) || '';
        const typ = (a.t && String(a.t).trim()) || '';
        const desc = (a.desc && String(a.desc).trim()) || '';
        const alt =
            a.alt_baro != null && !Number.isNaN(a.alt_baro)
                ? fmtNum(a.alt_baro, ' ft baro')
                : '—';
        const altg =
            a.alt_geom != null && !Number.isNaN(a.alt_geom)
                ? fmtNum(a.alt_geom, ' ft geom')
                : null;
        const gs = a.gs != null ? fmtNum(a.gs, ' kt') : '—';
        const trk = a.track != null ? fmtNum(a.track, '°') : '—';
        const sq = (a.squawk && String(a.squawk).trim()) || '—';
        const cat = (a.category && String(a.category).trim()) || '—';
        const mach = a.mach != null ? Number(a.mach).toFixed(3) : null;
        const tas = a.tas != null ? fmtNum(a.tas, ' kt') : null;
        const ias = a.ias != null ? fmtNum(a.ias, ' kt') : null;
        const br = a.baro_rate != null ? fmtNum(a.baro_rate, ' ft/min') : null;
        const gr = a.geom_rate != null ? fmtNum(a.geom_rate, ' ft/min') : null;
        const wd = a.wd != null ? fmtNum(a.wd, '°') : null;
        const ws = a.ws != null ? fmtNum(a.ws, ' kt') : null;
        const dst = a.dst != null ? Number(a.dst).toFixed(1) + ' NM from query center' : null;
        const dir = a.dir != null ? fmtNum(a.dir, '° rel.') : null;
        const navAlt = a.nav_altitude_mcp != null ? fmtNum(a.nav_altitude_mcp, ' ft') : null;
        const mhdg = a.mag_heading != null ? fmtNum(a.mag_heading, '°') : null;
        const thd = a.true_heading != null ? fmtNum(a.true_heading, '°') : null;

        const tlen = trailPts ? trailPts.length : 0;
        const estSec = Math.max(0, (tlen - 1) * (MIN_POLL_MS / 1000));
        let trailNote =
            '<p class="airspace-popup-muted">Trail: <strong>' +
            tlen +
            '</strong> points in this session';
        if (tlen >= 2) {
            trailNote += ' (~' + Math.round(estSec) + ' s of samples)';
        }
        trailNote +=
            '. Full history is not in the public API—this path is built while the page is open.</p>';

        const rows = [
            ['Altitude', alt + (altg ? ' · ' + altg : '')],
            ['Speed', 'GS ' + gs + (tas ? ' · TAS ' + tas : '') + (ias ? ' · IAS ' + ias : '')],
            ['Track / heading', 'Track ' + trk + (thd ? ' · TH ' + thd : '') + (mhdg ? ' · MH ' + mhdg : '')],
            ['Vert rate', (br ? 'Baro ' + br : '') + (br && gr ? ' · ' : '') + (gr ? 'Geom ' + gr : '') || '—'],
            ['Wind', wd && ws ? wd + ' / ' + ws : '—'],
            ['Mach', mach || '—'],
            ['Squawk', escapeHtml(sq)],
            ['Category', escapeHtml(cat)],
            [
                'Type',
                typ || desc
                    ? escapeHtml(typ + (desc ? ' — ' + desc : ''))
                    : '—'
            ],
            ['Registration', reg ? escapeHtml(reg) : '—'],
            ['Position', dst || '—'],
            ['Bearing', dir || '—'],
            ['Nav alt (MCP)', navAlt || '—']
        ];

        let table = '<table class="airspace-popup-table">';
        for (let r = 0; r < rows.length; r++) {
            if (
                rows[r][1] === '—' &&
                rows[r][0] !== 'Squawk' &&
                rows[r][0] !== 'Category' &&
                rows[r][0] !== 'Registration'
            ) {
                continue;
            }
            table +=
                '<tr><th>' +
                escapeHtml(rows[r][0]) +
                '</th><td>' +
                rows[r][1] +
                '</td></tr>';
        }
        table += '</table>';

        return (
            '<div class="airspace-popup-inner">' +
            '<div class="airspace-popup-title">' +
            escapeHtml(flight || '(no callsign)') +
            '</div>' +
            '<div class="airspace-popup-sub">ICAO ' +
            escapeHtml(hex) +
            '</div>' +
            trailNote +
            table +
            '</div>'
        );
    }

    function clearSelectedTrail() {
        if (selectedTrailPolyline && map) {
            map.removeLayer(selectedTrailPolyline);
            selectedTrailPolyline = null;
        }
    }

    function showSelectedTrail(hex) {
        clearSelectedTrail();
        const pts = trailByHex.get(hex);
        if (!pts || pts.length < 2) return;
        selectedTrailPolyline = L.polyline(pts, {
            color: '#fb7185',
            weight: 4,
            opacity: 0.95,
            lineJoin: 'round',
            lineCap: 'round'
        }).addTo(map);
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

    function buildAdsbUpstreamHexUrl(hexClean) {
        return ADSB_LOL_BASE + '/hex/' + encodeURIComponent(hexClean);
    }

    /**
     * 1) Same-origin /api/adsb (npm run serve or Cloudflare Worker)
     * 2–4) Public relays (Python http.server / Live Server have no /api — 404 here)
     */
    function fetchJsonWithProxy(upstreamUrl, sameOriginQueryString) {
        const sameOrigin = '/api/adsb?' + sameOriginQueryString;

        return fetch(sameOrigin, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store'
        })
            .then(function (res) {
                if (res.ok) return res.json();
                throw new Error('same_origin_proxy');
            })
            .catch(function () {
                return fetch(
                    'https://api.allorigins.win/get?url=' + encodeURIComponent(upstreamUrl),
                    {
                        method: 'GET',
                        credentials: 'omit',
                        cache: 'no-store'
                    }
                )
                    .then(function (res) {
                        if (!res.ok) throw new Error('allorigins');
                        return res.json();
                    })
                    .then(function (data) {
                        if (typeof data.contents === 'string') {
                            return JSON.parse(data.contents);
                        }
                        throw new Error('allorigins_parse');
                    });
            })
            .catch(function () {
                return fetch(
                    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(upstreamUrl),
                    {
                        method: 'GET',
                        credentials: 'omit',
                        cache: 'no-store'
                    }
                ).then(function (res) {
                    if (!res.ok) throw new Error('codetabs');
                    return res.json();
                });
            })
            .catch(function () {
                return fetch('https://corsproxy.io/?' + encodeURIComponent(upstreamUrl), {
                    method: 'GET',
                    credentials: 'omit',
                    cache: 'no-store'
                }).then(function (res) {
                    if (!res.ok) throw new Error('corsproxy');
                    return res.json();
                });
            })
            .catch(function () {
                throw new Error('no_proxy');
            });
    }

    function fetchAdsbJson(lat, lon, distNm) {
        const params = new URLSearchParams({
            lat: lat.toFixed(5),
            lon: lon.toFixed(5),
            dist: distNm.toFixed(1)
        });
        const upstream = buildAdsbUpstreamUrl(lat, lon, distNm);
        return fetchJsonWithProxy(upstream, params.toString());
    }

    function fetchAdsbHex(hex) {
        const h = normalizeHex(hex);
        if (h.length !== 6) return Promise.reject(new Error('Invalid ICAO'));
        const qs = new URLSearchParams({ hex: h }).toString();
        const upstream = buildAdsbUpstreamHexUrl(h);
        return fetchJsonWithProxy(upstream, qs);
    }

    function trafficPopupLeafletOptions() {
        const narrow =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(max-width: 600px)').matches;
        return {
            maxWidth: Math.min(340, Math.max(240, window.innerWidth - 32)),
            closeButton: true,
            autoPan: true,
            autoPanPadding: narrow ? [12, 120] : [16, 88]
        };
    }

    function renderAircraftList(ac) {
        clearTraffic();
        recordTrailsFromList(ac);
        if (!ac || !ac.length) {
            if (pinnedHex) {
                trafficPopupOpen = false;
                pinnedHex = null;
                clearSelectedTrail();
            }
            return 0;
        }

        const bounds = map.getBounds();
        let count = 0;

        for (let i = 0; i < ac.length; i++) {
            const a = ac[i];
            const lat = a.lat;
            const lon = a.lon;
            if (lat == null || lon == null) continue;
            if (!bounds.contains(L.latLng(lat, lon))) continue;

            const hex = normalizeHex(a.hex);
            if (hex.length !== 6) continue;

            const tier = altitudeIconTier(a);
            const trk = a.track != null ? a.track : 0;
            const heli = isHelicopter(a);
            const icon = L.divIcon({
                className: 'airspace-plane-marker' + (heli ? ' airspace-marker-heli' : ''),
                html: aircraftIconHtml(trk, tier, heli),
                iconSize: [40, 40],
                iconAnchor: [20, 20]
            });

            const m = L.marker([lat, lon], { icon: icon }).addTo(trafficLayer);
            m._airspaceHex = hex;

            const popupId = 'airspace-popup-body-' + hex;
            const trailPts = trailByHex.get(hex) || [];
            m.bindPopup(
                '<div class="airspace-popup" id="' +
                    popupId +
                    '">' +
                    buildPopupHtml(a, trailPts) +
                    '</div>',
                trafficPopupLeafletOptions()
            );

            m.bindTooltip(formatAltitudeLabel(a), {
                permanent: true,
                direction: 'right',
                opacity: 1,
                interactive: false,
                className: 'airspace-alt-label',
                offset: [16, 0]
            });

            m.on('popupopen', function () {
                trafficPopupOpen = true;
                pinnedHex = hex;
                showSelectedTrail(hex);
                setStatus(
                    '<strong>Details open</strong> · auto-refresh paused until you close.',
                    false
                );
                fetchAdsbHex(hex)
                    .then(function (data) {
                        const ac0 = data.ac && data.ac[0];
                        const el = document.getElementById(popupId);
                        if (!el || !ac0) return;
                        el.innerHTML = buildPopupHtml(ac0, trailByHex.get(hex) || []);
                    })
                    .catch(function () {});
            });

            m.on('popupclose', function () {
                if (suppressTrafficPopupClose) return;
                trafficPopupOpen = false;
                pinnedHex = null;
                clearSelectedTrail();
                lastFetchAt = 0;
                fetchTraffic();
            });

            count++;
        }

        if (pinnedHex) {
            let found = false;
            trafficLayer.eachLayer(function (layer) {
                if (layer._airspaceHex === pinnedHex && typeof layer.openPopup === 'function') {
                    layer.openPopup();
                    found = true;
                }
            });
            if (!found) {
                trafficPopupOpen = false;
                pinnedHex = null;
                clearSelectedTrail();
            }
        }

        return count;
    }

    function fetchTraffic(force) {
        if (!trafficEnabled || !map) return;
        if (!force && trafficPopupOpen) return;

        const now = Date.now();
        if (now - lastFetchAt < MIN_POLL_MS && lastFetchAt > 0) {
            return;
        }
        if (isFetching) return;

        const b = map.getBounds();
        if (b.getWest() > b.getEast()) {
            setStatus('Map crosses the date line; zoom to a single region.', true);
            return;
        }

        const rNm = radiusNmForMap();
        if (rNm == null) {
            setStatus('Could not compute view radius.', true);
            return;
        }

        const c = b.getCenter();
        const lat = c.lat;
        const lon = c.lng;

        isFetching = true;
        setStatus('Loading traffic…', false);

        fetchAdsbJson(lat, lon, rNm)
            .then(function (data) {
                lastFetchAt = Date.now();

                const list = data.ac || [];
                const n = renderAircraftList(list);

                const t = formatTime(data.now != null ? data.now : data.ctime);
                setStatus(
                    '<strong>' +
                        n +
                        '</strong> in view · ~' +
                        rNm.toFixed(0) +
                        ' NM · ' +
                        (t !== '—' ? 'data ' + escapeHtml(t) : '') +
                        ' · refresh ~1s',
                    false
                );
            })
            .catch(function (err) {
                if (err && err.message === 'no_proxy') {
                    setStatus(
                        '<strong>No ADSB proxy</strong>. Run <code>npm run serve</code> from the project folder (not <code>python -m http.server</code>). If port 8081 is busy, stop the other process or use the port shown in the terminal. Or use the deployed site.',
                        true
                    );
                } else {
                    setStatus(
                        'Could not load traffic (' +
                            escapeHtml(err.message || 'network') +
                            '). Try again later.',
                        true
                    );
                }
            })
            .finally(function () {
                isFetching = false;
            });
    }

    function scheduleFetch() {
        if (!trafficEnabled) return;
        clearTimeout(moveDebounce);
        moveDebounce = setTimeout(fetchTraffic, MOVE_DEBOUNCE_MS);
    }

    function startPolling() {
        stopPolling();
        lastFetchAt = 0;
        fetchTraffic();
        pollTimer = setInterval(function () {
            if (document.visibilityState !== 'visible') return;
            lastFetchAt = 0;
            fetchTraffic();
        }, MIN_POLL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function initMap() {
        map = L.map('map', {
            center: [51.5074, -0.1278],
            zoom: 11,
            zoomControl: true
        });

        trafficLayer = L.layerGroup().addTo(map);

        const dark = L.tileLayer(
            'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            {
                attribution: '&copy; OpenStreetMap, &copy; CARTO',
                subdomains: 'abcd',
                maxZoom: 19,
                crossOrigin: true
            }
        );
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19,
            crossOrigin: true
        });
        const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors, SRTM',
            maxZoom: 17,
            crossOrigin: true
        });
        const satellite = L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            {
                attribution: '&copy; Esri, Maxar',
                maxZoom: 18,
                crossOrigin: true
            }
        );

        osm.addTo(map);
        L.control.layers(
            {
                OpenStreetMap: osm,
                'Dark (Carto)': dark,
                Topographic: topo,
                Satellite: satellite
            },
            null,
            { position: 'topright' }
        ).addTo(map);

        if (typeof L.control.locate === 'function') {
            L.control.locate({
                position: 'topleft',
                strings: {
                    title: 'Show my location',
                    popup: 'You are within {distance} from this point',
                    outsideMapBoundsMsg: 'You seem located outside the boundaries of the map'
                },
                locateOptions: { enableHighAccuracy: true }
            }).addTo(map);
        }

        const InfoControl = L.Control.extend({
            onAdd: function () {
                const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-airspace-info');
                const link = L.DomUtil.create('a', '', div);
                link.href = '#';
                link.title = 'Instructions';
                link.setAttribute('aria-label', 'Show instructions');
                link.id = 'airspaceHelpToggle';
                link.innerHTML =
                    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><circle cx="12" cy="8" r="1.25" fill="currentColor" stroke="none"/></svg>';
                L.DomEvent.on(link, 'click', L.DomEvent.stop);
                return div;
            }
        });
        new InfoControl({ position: 'topleft' }).addTo(map);

        map.on('moveend', scheduleFetch);

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && trafficEnabled && !trafficPopupOpen) {
                lastFetchAt = 0;
                fetchTraffic();
            }
        });
    }

    function wireUi() {
        const toggle = document.getElementById('airspaceTrafficToggle');
        const refreshBtn = document.getElementById('airspaceRefreshBtn');
        const helpToggle = document.getElementById('airspaceHelpToggle');
        const helpClose = document.getElementById('airspaceHelpClose');
        const helpWrap = document.getElementById('airspaceHelpPanelWrap');
        const helpBody = document.getElementById('airspaceHelpBody');

        if (helpBody) {
            helpBody.innerHTML = HELP_HTML;
        }

        if (toggle) {
            toggle.checked = trafficEnabled;
            toggle.addEventListener('change', function () {
                trafficEnabled = toggle.checked;
                if (trafficEnabled) {
                    startPolling();
                } else {
                    stopPolling();
                    trafficPopupOpen = false;
                    pinnedHex = null;
                    clearTraffic();
                    clearSelectedTrail();
                    setStatus('Traffic is off. Enable <strong>Show traffic</strong> to load ADS-B data.', false);
                }
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                lastFetchAt = 0;
                fetchTraffic(true);
            });
        }

        function openHelp() {
            if (helpWrap) helpWrap.classList.add('airspace-help-open');
        }

        function closeHelp() {
            if (helpWrap) helpWrap.classList.remove('airspace-help-open');
        }

        if (helpToggle) {
            helpToggle.addEventListener('click', function (e) {
                e.preventDefault();
                if (helpWrap && helpWrap.classList.contains('airspace-help-open')) {
                    closeHelp();
                } else {
                    openHelp();
                }
            });
        }

        if (helpClose) {
            helpClose.addEventListener('click', closeHelp);
        }
    }

    function init() {
        initMap();
        wireUi();
        startPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
