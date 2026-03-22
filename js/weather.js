/* ============================================
   FLIGHT WEATHER - Weather check for drone flights
   Map point selection, Open-Meteo API, report display
   ============================================ */

(function () {
    'use strict';

    const WEATHER_STATUS_HTML_DEFAULT = [
        '<p class="weather-help-lead"><strong>Flight Weather</strong> (AirPlot v2.0) shows forecast and aviation information for a point on the map.</p>',
        '<p><strong>Steps</strong></p>',
        '<ol class="weather-help-list">',
        '<li>Choose a <strong>Model</strong> (e.g. Best match, ECMWF, GFS) and time: <strong>Now</strong> or <strong>Date &amp; Time</strong>.</li>',
        '<li>Set a location: tap <strong>Select Location</strong> then tap the map, or <strong>right-click</strong> the map and choose <strong>Get Weather</strong>.</li>',
        '<li>Tap <strong>Get Weather</strong> to open the report panel.</li>',
        '</ol>',
        '<p><strong>Report tabs</strong> — <strong>Summary</strong> (wind by altitude, visibility, clouds, precipitation, temperature), <strong>12-hour forecast</strong>, <strong>METAR / TAF</strong>, <strong>Airspace</strong>. Expand <strong>About this forecast model</strong> on the Summary tab for model notes.</p>',
        '<p><strong>Export</strong> — <strong>PPTX</strong> or <strong>PDF</strong> downloads a branded report. <strong>Light</strong> switches the report to a light theme (e.g. for screenshots or copy/paste). The map <strong>ⓘ</strong> button opens or closes this instructions panel.</p>',
        '<p>Use <strong>Welcome</strong> (top-left) to return to the AirPlot home screen. Attribution and data sources are shown in the report.</p>'
    ].join('');

    const WEATHER_STATUS_HTML_SELECTED = 'Location selected. Set time and tap <strong>Get Weather</strong>.';

    const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
    const HOURLY_PARAMS = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_120m,wind_direction_120m,visibility,cloud_cover,cloud_cover_low,precipitation,precipitation_probability,temperature_2m';
    const AVIATION_RADIUS_NM = 50;
    const AVIATION_STATIONS_URL = 'assets/aviation-stations.json';
    const AVIATION_PROXY_URL = '/api/aviation';
    const AWC_METAR_URL = 'https://aviationweather.gov/api/data/metar';
    const AWC_TAF_URL = 'https://aviationweather.gov/api/data/taf';
    const CORS_PROXY = 'https://corsproxy.io/?';
    const JINA_PROXY_PREFIX = 'https://r.jina.ai/http://';

    let aviationStationsCache = null;

    const MODEL_LABELS = {
        auto: 'Best match',
        ecmwf_ifs: 'ECMWF IFS (EU)',
        gfs_seamless: 'GFS (NOAA, US)',
        ukmo_seamless: 'UK Met Office',
        gem_global: 'GEM (Canada)'
    };

    const MODEL_EXPLAINERS = {
        ecmwf_ifs: {
            name: 'ECMWF IFS',
            fullName: 'European Centre for Medium-Range Weather Forecasts — Integrated Forecasting System',
            resolution: '9 km',
            provider: 'ECMWF (Reading, UK)',
            equiv: 'This is the <strong>primary model behind BBC Weather</strong> (via MeteoGroup/DTN) and the <strong>default model on Windy.com</strong>. ECMWF IFS is widely regarded as the most accurate global forecast model and is the standard reference across European aviation and meteorology.'
        },
        gfs_seamless: {
            name: 'GFS',
            fullName: 'Global Forecast System — National Centers for Environmental Prediction',
            resolution: '13–27 km',
            provider: 'NOAA / NWS (USA)',
            equiv: 'GFS is a <strong>secondary model used by BBC Weather</strong> (MeteoGroup blends it with ECMWF) and is <strong>available on Windy.com</strong> as an alternative view. It is the primary model for US domestic forecasts and is freely available worldwide.'
        },
        ukmo_seamless: {
            name: 'UK Met Office (Global + UKV)',
            fullName: 'Met Office Unified Model — Global (10 km) with UKV high-resolution (2 km) for the UK',
            resolution: '2 km (UK) / 10 km (global)',
            provider: 'Met Office (Exeter, UK)',
            equiv: 'This is the <strong>same model that powers the Met Office website and app</strong>. For UK locations it uses the UKV at 2 km resolution — the highest-resolution operational model available for the British Isles. MeteoGroup also incorporates Met Office data into BBC Weather forecasts.'
        },
        gem_global: {
            name: 'GEM',
            fullName: 'Global Environmental Multiscale Model',
            resolution: '15 km',
            provider: 'Environment and Climate Change Canada',
            equiv: 'GEM is the <strong>primary model for Canadian forecasts</strong>. It provides an independent global perspective and is useful as a comparison against the European (ECMWF) and American (GFS) models.'
        },
        auto: {
            name: 'Best Match (Auto)',
            fullName: 'Automatic model selection by Open-Meteo',
            resolution: 'Varies',
            provider: 'Open-Meteo (multi-model blend)',
            equiv: 'Open-Meteo selects the best-performing model for your location. This typically blends data from <strong>ECMWF IFS</strong> (BBC Weather / Windy.com default), <strong>Met Office UKV</strong> (Met Office website), and other regional models to produce the most accurate local forecast.'
        }
    };

    const GUST_120M_MULTIPLIER = 1.3;

    let map;
    let selectedPoint = null;
    let selectedMarker = null;
    let selectMode = false;
    let contextMenuLatLng = null;

    let lastReportData = null;
    let lastHourlySlice = null;
    let lastModel = null;
    let lastAviationData = null;
    let lastDisplayTime = null;
    let lastNotamData = null;
    let lastAirspaceData = null;

    const AIRSPACE_RADIUS_STORAGE_KEY = 'weatherAirspaceRadiusKm';
    const AIRSPACE_RADIUS_MIN_KM = 1;
    const AIRSPACE_RADIUS_MAX_KM = 100;
    let airspaceSearchRadiusKm = 10;
    let airspaceMinimap = null;
    let airspaceMinimapOverlay = null;
    let airspaceDetailSelectedEl = null;

    function clampAirspaceRadiusKm(n) {
        var v = typeof n === 'number' ? n : parseInt(String(n), 10);
        if (!isFinite(v)) return 10;
        return Math.min(AIRSPACE_RADIUS_MAX_KM, Math.max(AIRSPACE_RADIUS_MIN_KM, Math.round(v)));
    }

    function syncAirspaceRadiusInput() {
        var input = document.getElementById('weatherAirspaceRadiusKm');
        if (input) input.value = String(airspaceSearchRadiusKm);
        var introKm = document.getElementById('weatherAirspaceIntroKm');
        if (introKm) introKm.textContent = String(airspaceSearchRadiusKm);
    }

    function readAirspaceRadiusFromInput() {
        var input = document.getElementById('weatherAirspaceRadiusKm');
        return clampAirspaceRadiusKm(input ? input.value : airspaceSearchRadiusKm);
    }

    function persistAirspaceRadiusKm() {
        try {
            sessionStorage.setItem(AIRSPACE_RADIUS_STORAGE_KEY, String(airspaceSearchRadiusKm));
        } catch (e) { /* ignore */ }
    }

    function haversineKm(lat1, lng1, lat2, lng2) {
        var R = 6371;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLng = (lng2 - lng1) * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function classifyAirspaceFeature(f) {
        var props = f.properties || {};
        var desig = (props.designator || props.type || props.id || '').toUpperCase();
        var name = (props.name || '').toUpperCase();
        var desc = (props.description || '').toUpperCase();
        var aType = (props.type || '').toUpperCase();
        if (desig.startsWith('EGRU') || desc.includes('FRZ') || desig.includes('FRZ') || desig.includes('RPZ') || name.includes('FRZ') || name.includes('AERODROME') || name.includes('FLIGHT RESTRICTION')) return 'FRZ';
        if (desig.startsWith('EG-P') || desig.startsWith('EGP') || desig.startsWith('P') || name.includes('PROHIBITED') || aType === 'P') return 'Prohibited';
        if (desig.startsWith('EG-R') || desig.startsWith('EGR') || desig.startsWith('R') || name.includes('RESTRICTED') || aType === 'R') return 'Restricted';
        if (desig.startsWith('EG-D') || desig.startsWith('EGD') || desig.startsWith('D') || name.includes('DANGER') || aType === 'D') return 'Danger';
        return null;
    }

    async function fetchNearbyNotams(lat, lng, radiusKm) {
        try {
            var resp = await fetch('https://jonty.github.io/uk-notam-archive/data/PIB.xml?t=' + Date.now());
            if (!resp.ok) return [];
            var xmlText = await resp.text();
            var parser = new DOMParser();
            var doc = parser.parseFromString(xmlText, 'text/xml');
            var notamEls = doc.querySelectorAll('Notam');
            var all = [];
            notamEls.forEach(function (el) {
                var coords = el.querySelector('Coordinates');
                var radius = el.querySelector('Radius');
                var itemE = el.querySelector('ItemE');
                var startVal = el.querySelector('StartValidity');
                var endVal = el.querySelector('EndValidity');
                var nof = el.querySelector('NOF');
                var series = el.querySelector('Series');
                var number = el.querySelector('Number');
                var year = el.querySelector('Year');
                if (!coords || !coords.textContent) return;
                var cStr = coords.textContent.trim();
                var m = cStr.match(/^(\d{4})([NS])(\d{5})([EW])$/);
                if (!m) return;
                var nLat = parseInt(m[1].slice(0, 2), 10) + parseInt(m[1].slice(2, 4), 10) / 60;
                if (m[2] === 'S') nLat = -nLat;
                var nLng = parseInt(m[3].slice(0, 3), 10) + parseInt(m[3].slice(3, 5), 10) / 60;
                if (m[4] === 'W') nLng = -nLng;
                var radiusNm = radius && radius.textContent ? parseInt(radius.textContent.trim(), 10) || 0 : 0;
                var id = (nof ? nof.textContent : '') + (series ? series.textContent : '') + (number ? number.textContent : '') + '/' + (year ? year.textContent : '');
                all.push({
                    id: id.trim(), lat: nLat, lng: nLng, radiusNm: radiusNm,
                    text: itemE ? itemE.textContent.trim() : '',
                    startValidity: startVal ? startVal.textContent : '',
                    endValidity: endVal ? endVal.textContent : ''
                });
            });
            return all.filter(function (n) {
                var dist = haversineKm(lat, lng, n.lat, n.lng);
                var notamRadiusKm = (n.radiusNm > 0 && n.radiusNm < 999) ? n.radiusNm * 1.852 : 0;
                return (dist - notamRadiusKm) <= radiusKm;
            });
        } catch (e) {
            console.warn('NOTAM fetch failed:', e);
            return [];
        }
    }

    async function fetchNearbyAirspace(lat, lng, radiusKm) {
        try {
            var results = await Promise.all([
                fetch('assets/uk-airspace.geojson?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
                fetch('assets/uk-aip-airspace.geojson?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            ]);
            var features = [];
            results.forEach(function (data) {
                if (data && data.features) features = features.concat(data.features);
            });
            return features.filter(function (f) {
                var category = classifyAirspaceFeature(f);
                if (!category) return false;
                var geom = f.geometry;
                if (!geom || !geom.coordinates) return false;
                var coords = geom.type === 'MultiPolygon' ? geom.coordinates.flat(2) : (geom.type === 'Polygon' ? geom.coordinates.flat() : []);
                return coords.some(function (c) {
                    return haversineKm(lat, lng, c[1], c[0]) <= radiusKm;
                });
            }).map(function (f) {
                var props = f.properties || {};
                return {
                    category: classifyAirspaceFeature(f),
                    designator: props.designator || props.id || '—',
                    name: props.name || '—',
                    lower: props.lowerLimit || props.lower || '—',
                    upper: props.upperLimit || props.upper || '—',
                    type: props.type || '',
                    source: props.source || '',
                    description: props.description || '',
                    geometry: f.geometry
                };
            }).sort(function (a, b) {
                var order = { 'FRZ': 0, 'Prohibited': 1, 'Restricted': 2, 'Danger': 3 };
                return (order[a.category] || 4) - (order[b.category] || 4);
            });
        } catch (e) {
            console.warn('Airspace fetch failed:', e);
            return [];
        }
    }

    // ---- Helpers ----
    function directionToCardinal(deg) {
        if (deg == null || isNaN(deg)) return '—';
        const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const idx = Math.round(((deg % 360) / 22.5)) % 16;
        return dirs[idx];
    }

    function formatVisibility(m) {
        if (m == null || isNaN(m)) return '—';
        if (m >= 10000) return (m / 1000).toFixed(1) + ' km';
        return Math.round(m) + ' m';
    }

    function deriveSuitability(data) {
        const wind = data.wind_speed_10m ?? 0;
        const gusts = data.wind_gusts_10m ?? wind;
        const vis = data.visibility ?? 10000;
        const precip = data.precipitation ?? 0;

        if (wind > 40 || gusts > 50 || vis < 3000 || precip > 2) {
            return { level: 'poor', text: 'Not recommended for flight' };
        }
        if (wind > 25 || gusts > 35 || vis < 5000 || precip > 0) {
            return { level: 'caution', text: 'Caution: marginal conditions' };
        }
        return { level: 'good', text: 'Good conditions for flight' };
    }

    // ---- Map init ----
    function initMap() {
        map = L.map('map', {
            center: [51.5074, -0.1278],
            zoom: 11,
            zoomControl: true
        });

        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19
        });
        const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors, SRTM',
            maxZoom: 17
        });
        const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '&copy; Esri, Maxar',
            maxZoom: 18
        });

        osm.addTo(map);
        L.control.layers(
            { 'OpenStreetMap': osm, 'Topographic': topo, 'Satellite': satellite },
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
                const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-weather-info');
                const link = L.DomUtil.create('a', '', div);
                link.href = '#';
                link.title = 'Instructions';
                link.setAttribute('aria-label', 'Show instructions');
                link.id = 'weatherHelpToggle';
                link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
                L.DomEvent.on(link, 'click', L.DomEvent.stop);
                return div;
            }
        });
        new InfoControl({ position: 'topleft' }).addTo(map);
    }

    // ---- Point selection ----
    function setSelectedPoint(lat, lng) {
        selectedPoint = { lat, lng };
        if (selectedMarker) map.removeLayer(selectedMarker);
        selectedMarker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'weather-location-marker',
                html: '<div class="weather-marker-pin"></div>',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        })
            .addTo(map)
            .bindTooltip(`Selected: ${lat.toFixed(5)}, ${lng.toFixed(5)}`, { permanent: false, direction: 'top' });
        document.getElementById('weatherFetchBtn').disabled = false;
        document.getElementById('weatherStatus').innerHTML = WEATHER_STATUS_HTML_SELECTED;
    }

    function clearSelectedPoint() {
        selectedPoint = null;
        if (selectedMarker) {
            map.removeLayer(selectedMarker);
            selectedMarker = null;
        }
        document.getElementById('weatherFetchBtn').disabled = true;
        document.getElementById('weatherStatus').innerHTML = WEATHER_STATUS_HTML_DEFAULT;
    }

    function exitSelectMode() {
        selectMode = false;
        const btn = document.getElementById('weatherSelectBtn');
        if (btn) btn.classList.remove('active');
        if (map && map.dragging) map.dragging.enable();
        if (map && map.touchZoom) map.touchZoom.enable();
        if (map && map.doubleClickZoom) map.doubleClickZoom.enable();
        const container = map ? map.getContainer() : null;
        if (container) container.style.touchAction = '';
    }

    function onMapClick(e) {
        if (selectMode) {
            setSelectedPoint(e.latlng.lat, e.latlng.lng);
            exitSelectMode();
        }
    }

    // Touch/pointer fallback: when dragging is disabled in select mode, use pointer events
    // (more reliable than click on touch devices)
    function setupTouchFallback() {
        const container = map.getContainer();
        let pointerStartPos = null;
        let touchStartPos = null;

        function placeFromClientPoint(clientX, clientY, targetEl) {
            if (!selectMode) return false;
            if (targetEl && targetEl.closest && targetEl.closest('.leaflet-control')) return false;
            const rect = container.getBoundingClientRect();
            const pt = L.point(clientX - rect.left, clientY - rect.top);
            const latLng = map.containerPointToLatLng(pt);
            setSelectedPoint(latLng.lat, latLng.lng);
            exitSelectMode();
            return true;
        }

        function onPointerDown(e) {
            if (selectMode && (e.pointerType === 'touch' || e.pointerType === 'pen') && e.isPrimary) {
                pointerStartPos = { x: e.clientX, y: e.clientY };
            }
        }

        function onPointerUp(e) {
            if (selectMode && (e.pointerType === 'touch' || e.pointerType === 'pen') && pointerStartPos && e.isPrimary) {
                const dx = e.clientX - pointerStartPos.x;
                const dy = e.clientY - pointerStartPos.y;
                if (dx * dx + dy * dy < 400) {
                    placeFromClientPoint(e.clientX, e.clientY, e.target);
                }
                pointerStartPos = null;
            }
        }

        function onTouchStart(e) {
            if (!selectMode || !e.touches || e.touches.length !== 1) return;
            const t = e.touches[0];
            touchStartPos = { x: t.clientX, y: t.clientY };
        }

        function onTouchEnd(e) {
            if (!selectMode || !touchStartPos || !e.changedTouches || e.changedTouches.length === 0) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - touchStartPos.x;
            const dy = t.clientY - touchStartPos.y;
            if (dx * dx + dy * dy < 400) {
                const placed = placeFromClientPoint(t.clientX, t.clientY, e.target);
                if (placed) e.preventDefault();
            }
            touchStartPos = null;
        }

        container.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
        container.addEventListener('pointerup', onPointerUp, { passive: true, capture: true });
        container.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
        container.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
    }

    function toggleSelectMode() {
        selectMode = !selectMode;
        document.getElementById('weatherSelectBtn').classList.toggle('active', selectMode);
        const container = map.getContainer();
        if (selectMode) {
            map.dragging.disable();
            if (map.touchZoom) map.touchZoom.disable();
            if (map.doubleClickZoom) map.doubleClickZoom.disable();
            container.style.touchAction = 'none';
        } else {
            exitSelectMode();
        }
        if (!selectMode && !selectedPoint) {
            document.getElementById('weatherStatus').innerHTML = WEATHER_STATUS_HTML_DEFAULT;
        }
    }

    // ---- Time picker ----
    function setupDateTimeLimits() {
        const input = document.getElementById('weatherDateTime');
        const now = new Date();
        const min = new Date(now);
        min.setMinutes(min.getMinutes() - 60);
        const max = new Date(now);
        max.setDate(max.getDate() + 16);
        input.min = min.toISOString().slice(0, 16);
        input.max = max.toISOString().slice(0, 16);
    }

    function getTargetTimestamp() {
        const useNow = document.getElementById('weatherTimeNow').checked;
        if (useNow) return null;
        const input = document.getElementById('weatherDateTime');
        const val = input.value;
        if (!val) return null;
        return new Date(val).getTime();
    }

    // ---- Aviation (METAR/TAF) ----
    async function loadAviationStations() {
        if (aviationStationsCache) return aviationStationsCache;
        const resp = await fetch(AVIATION_STATIONS_URL + '?t=' + Date.now());
        if (!resp.ok) throw new Error('Could not load aviation stations');
        aviationStationsCache = await resp.json();
        return aviationStationsCache;
    }

    function findNearbyStations(lat, lng, radiusNm) {
        const radiusM = radiusNm * 1852;
        const point = L.latLng(lat, lng);
        return aviationStationsCache
            .map(function (s) {
                const dist = point.distanceTo(L.latLng(s.lat, s.lon));
                return { ...s, distM: dist, distNm: dist / 1852 };
            })
            .filter(function (s) { return s.distM <= radiusM; })
            .sort(function (a, b) { return a.distM - b.distM; })
            .slice(0, 10);
    }

    function parseAviationJsonPayload(payload) {
        return Array.isArray(payload) ? payload : (payload && payload.data ? payload.data : []);
    }

    function extractJsonFromJinaProxy(text) {
        if (!text) return '';
        const marker = 'Markdown Content:';
        const markerIdx = text.indexOf(marker);
        let body = markerIdx >= 0 ? text.slice(markerIdx + marker.length).trim() : text.trim();
        if (body.startsWith('```')) {
            body = body.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
        }
        return body;
    }

    function isLocalDevHost() {
        const host = (window.location.hostname || '').toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    }

    async function fetchAviationJson(url, type, ids) {
        const params = new URLSearchParams({ type: type, ids: ids });
        const attempts = [{ name: 'worker-proxy', url: AVIATION_PROXY_URL + '?' + params.toString(), kind: 'json' }];
        if (isLocalDevHost()) {
            attempts.push(
                { name: 'direct', url: url, kind: 'json' },
                { name: 'corsproxy', url: CORS_PROXY + encodeURIComponent(url), kind: 'json' },
                { name: 'jina', url: JINA_PROXY_PREFIX + url.replace(/^https?:\/\//i, ''), kind: 'jina-text' }
            );
        }
        let lastError = null;
        for (const attempt of attempts) {
            try {
                const resp = await fetch(attempt.url, { headers: { 'Accept': 'application/json' } });
                if (!resp.ok) throw new Error(attempt.name + ' returned HTTP ' + resp.status);
                if (resp.status === 204) return [];

                if (attempt.kind === 'jina-text') {
                    const text = await resp.text();
                    const jsonText = extractJsonFromJinaProxy(text);
                    const parsed = JSON.parse(jsonText);
                    return parseAviationJsonPayload(parsed);
                }

                const parsed = await resp.json();
                return parseAviationJsonPayload(parsed);
            } catch (err) {
                lastError = err;
            }
        }
        throw new Error('Could not fetch aviation JSON (' + (lastError && lastError.message ? lastError.message : 'unknown error') + ')');
    }

    async function fetchAviationWeather(icaoIds) {
        if (!icaoIds || icaoIds.length === 0) return { metars: [], tafs: [] };
        const ids = icaoIds.join(',');
        const metarUrl = AWC_METAR_URL + '?ids=' + encodeURIComponent(ids) + '&format=json';
        const tafUrl = AWC_TAF_URL + '?ids=' + encodeURIComponent(ids) + '&format=json';
        const [metarResult, tafResult] = await Promise.allSettled([
            fetchAviationJson(metarUrl, 'metar', ids),
            fetchAviationJson(tafUrl, 'taf', ids)
        ]);
        const metars = metarResult.status === 'fulfilled' ? metarResult.value : [];
        const tafs = tafResult.status === 'fulfilled' ? tafResult.value : [];
        if (metarResult.status !== 'fulfilled' && tafResult.status !== 'fulfilled') {
            const metarErr = metarResult.reason && metarResult.reason.message ? metarResult.reason.message : 'METAR failed';
            const tafErr = tafResult.reason && tafResult.reason.message ? tafResult.reason.message : 'TAF failed';
            throw new Error(metarErr + '; ' + tafErr);
        }
        return { metars, tafs };
    }

    // ---- API fetch ----
    async function fetchWeather() {
        if (!selectedPoint) return;
        const targetTime = getTargetTimestamp();
        const useNow = targetTime === null;

        const report = document.getElementById('weatherReport');
        const loading = document.getElementById('weatherReportLoading');
        const error = document.getElementById('weatherReportError');
        const content = document.getElementById('weatherReportContent');

        report.classList.remove('hidden');
        loading.classList.remove('hidden');
        error.classList.add('hidden');
        content.classList.add('hidden');

        const model = document.getElementById('weatherModel').value || 'auto';
        const params = new URLSearchParams({
            latitude: selectedPoint.lat.toFixed(4),
            longitude: selectedPoint.lng.toFixed(4),
            hourly: HOURLY_PARAMS,
            forecast_days: '16',
            timezone: 'auto'
        });
        if (model !== 'auto') {
            params.set('models', model);
        }

        try {
            const [data, aviationData] = await Promise.all([
                fetch(OPEN_METEO_BASE + '?' + params.toString()).then(function (r) {
                    if (!r.ok) throw new Error('Weather service unavailable');
                    return r.json();
                }),
                (async function () {
                    try {
                        await loadAviationStations();
                        const nearby = findNearbyStations(selectedPoint.lat, selectedPoint.lng, AVIATION_RADIUS_NM);
                        const icaoIds = nearby.map(function (s) { return s.icao; });
                        const { metars, tafs } = await fetchAviationWeather(icaoIds);
                        return { nearby, metars, tafs };
                    } catch (e) {
                        return { nearby: [], metars: [], tafs: [], error: e.message };
                    }
                })()
            ]);

            let weatherData;
            let displayTime;
            let hourlySlice = null;

            if (useNow && data.hourly && data.hourly.time && data.hourly.time.length > 0) {
                const times = data.hourly.time;
                const now = Date.now();
                let startIdx = 0;
                for (let i = 0; i < times.length; i++) {
                    const t = new Date(times[i]).getTime();
                    if (t <= now) startIdx = i;
                }
                weatherData = {};
                for (const key of Object.keys(data.hourly)) {
                    if (key !== 'time' && Array.isArray(data.hourly[key])) {
                        weatherData[key] = data.hourly[key][startIdx];
                    }
                }
                displayTime = times[startIdx];
                hourlySlice = { startIdx, count: 12, hourly: data.hourly };
            } else if (data.hourly && data.hourly.time && data.hourly.time.length > 0) {
                const times = data.hourly.time;
                const target = targetTime || Date.now();
                let bestIdx = 0;
                let bestDiff = Infinity;
                for (let i = 0; i < times.length; i++) {
                    const t = new Date(times[i]).getTime();
                    const diff = Math.abs(t - target);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        bestIdx = i;
                    }
                }
                weatherData = {};
                for (const key of Object.keys(data.hourly)) {
                    if (key !== 'time' && Array.isArray(data.hourly[key])) {
                        weatherData[key] = data.hourly[key][bestIdx];
                    }
                }
                displayTime = times[bestIdx];
            } else {
                throw new Error('No weather data returned');
            }

            lastReportData = weatherData;
            lastHourlySlice = hourlySlice;
            lastModel = model;
            lastAviationData = aviationData;
            lastDisplayTime = displayTime;

            renderReport(weatherData, displayTime, hourlySlice, model, aviationData);
            loading.classList.add('hidden');
            content.classList.remove('hidden');
        } catch (err) {
            loading.classList.add('hidden');
            error.classList.remove('hidden');
            document.getElementById('weatherReportErrorText').textContent = err.message || 'Failed to fetch weather.';
        }
    }

    function formatWindRow(speed, dir) {
        if (speed == null || isNaN(speed)) return '—';
        return `${Math.round(speed)} km/h ${directionToCardinal(dir)}`;
    }

    function deriveSummaryText(hourlySlice, suitability) {
        if (!hourlySlice || !hourlySlice.hourly) return '';
        const h = hourlySlice.hourly;
        const start = hourlySlice.startIdx;
        const count = Math.min(12, (h.time?.length || 0) - start);
        if (count <= 0) return suitability.text;

        const w10 = (h.wind_speed_10m || []).slice(start, start + count).filter(v => v != null);
        const gusts10 = (h.wind_gusts_10m || []).slice(start, start + count).filter(v => v != null);
        const w120 = (h.wind_speed_120m || []).slice(start, start + count).filter(v => v != null);
        const vis = (h.visibility || []).slice(start, start + count).filter(v => v != null);
        const precip = (h.precipitation || []).slice(start, start + count).filter(v => v != null && v > 0);

        const w10Min = w10.length ? Math.min(...w10) : null;
        const w10Max = w10.length ? Math.max(...w10) : null;
        const gustsMax = gusts10.length ? Math.max(...gusts10) : null;
        const w120Max = w120.length ? Math.max(...w120) : null;
        const visMin = vis.length ? Math.min(...vis) : null;
        const visMax = vis.length ? Math.max(...vis) : null;

        const parts = [];
        if (w10Min != null && w10Max != null) {
            if (w10Min === w10Max) parts.push(`Sustained 10 m: ${Math.round(w10Max)} km/h`);
            else parts.push(`Sustained 10 m: ${Math.round(w10Min)}–${Math.round(w10Max)} km/h`);
        }
        if (gustsMax != null) parts.push(`Gusts 10 m: up to ${Math.round(gustsMax)} km/h`);
        if (w120Max != null) {
            parts.push(`Sustained 120 m: up to ${Math.round(w120Max)} km/h`);
            parts.push(`Gusts 120 m (est.): up to ${Math.round(w120Max * GUST_120M_MULTIPLIER)} km/h`);
        }
        if (visMin != null && visMax != null) {
            const vMin = visMin >= 10000 ? (visMin / 1000).toFixed(1) + ' km' : Math.round(visMin) + ' m';
            const vMax = visMax >= 10000 ? (visMax / 1000).toFixed(1) + ' km' : Math.round(visMax) + ' m';
            if (vMin === vMax) parts.push(`Visibility: ${vMax}`);
            else parts.push(`Visibility: ${vMin} to ${vMax}`);
        }
        if (precip.length > 0) {
            const total = precip.reduce((a, b) => a + b, 0);
            parts.push(`Precipitation: ${Math.round(total * 10) / 10} mm expected`);
        } else parts.push('No precipitation expected');

        return parts.join('. ') + '.';
    }

    // ---- Report rendering ----
    function renderReport(data, displayTime, hourlySlice, model, aviationData) {
        const suitability = deriveSuitability(data);
        const summaryText = deriveSummaryText(hourlySlice, suitability);

        const summaryEl = document.getElementById('weatherSummary');
        summaryEl.textContent = suitability.text;
        summaryEl.className = 'weather-summary ' + suitability.level;

        const summaryTextEl = document.getElementById('weatherSummaryText');
        summaryTextEl.textContent = summaryText;
        summaryTextEl.className = 'weather-summary-text';
        summaryTextEl.style.display = summaryText ? 'block' : 'none';

        const wind10Str = formatWindRow(data.wind_speed_10m, data.wind_direction_10m);
        document.getElementById('weatherWind10m').textContent = wind10Str;

        const gusts = data.wind_gusts_10m;
        document.getElementById('weatherGusts').textContent = gusts != null ? Math.round(gusts) + ' km/h' : '—';

        const wind120Str = formatWindRow(data.wind_speed_120m, data.wind_direction_120m);
        document.getElementById('weatherWind120m').textContent = wind120Str;

        const gusts120 = data.wind_speed_120m != null ? Math.round(data.wind_speed_120m * GUST_120M_MULTIPLIER) : null;
        document.getElementById('weatherGusts120m').textContent = gusts120 != null ? gusts120 + ' km/h' : '—';

        document.getElementById('weatherVisibility').textContent = formatVisibility(data.visibility);

        const cloudTotal = data.cloud_cover;
        const cloudLow = data.cloud_cover_low;
        let cloudStr = '—';
        if (cloudTotal != null) {
            cloudStr = cloudLow != null ? `${Math.round(cloudTotal)}% total, ${Math.round(cloudLow)}% low` : Math.round(cloudTotal) + '%';
        }
        document.getElementById('weatherClouds').textContent = cloudStr;

        const precip = data.precipitation;
        const precipProb = data.precipitation_probability;
        let precipStr = '—';
        if (precip != null) {
            precipStr = precipProb != null ? `${Math.round(precip * 10) / 10} mm (${Math.round(precipProb)}% chance)` : Math.round(precip * 10) / 10 + ' mm';
        }
        document.getElementById('weatherPrecip').textContent = precipStr;

        const temp = data.temperature_2m;
        document.getElementById('weatherTemp').textContent = temp != null ? Math.round(temp) + ' °C' : '—';

        const hourlyTableWrap = document.querySelector('.weather-hourly-table-wrap');
        const hourlyEmpty = document.getElementById('weatherHourlyEmpty');
        const hourlyBody = document.getElementById('weatherHourlyBody');
        if (hourlySlice && hourlySlice.hourly) {
            const h = hourlySlice.hourly;
            const start = hourlySlice.startIdx;
            const count = Math.min(12, (h.time?.length || 0) - start);
            if (hourlyTableWrap) hourlyTableWrap.style.display = '';
            if (hourlyEmpty) hourlyEmpty.classList.add('hidden');
            hourlyBody.innerHTML = '';
            for (let i = 0; i < count; i++) {
                const idx = start + i;
                const timeStr = h.time[idx] ? new Date(h.time[idx]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
                const w10 = h.wind_speed_10m?.[idx];
                const gusts10 = h.wind_gusts_10m?.[idx];
                const w120 = h.wind_speed_120m?.[idx];
                const gusts120Est = w120 != null ? Math.round(w120 * GUST_120M_MULTIPLIER) : null;
                const vis = h.visibility?.[idx];
                const cloud = h.cloud_cover?.[idx];
                const p = h.precipitation?.[idx];
                const pProb = h.precipitation_probability?.[idx];
                const t = h.temperature_2m?.[idx];
                const precipCell = p != null && p > 0
                    ? (pProb != null ? `${(p * 10) / 10} mm (${Math.round(pProb)}%)` : `${(p * 10) / 10} mm`)
                    : (pProb != null ? `${Math.round(pProb)}%` : '0');
                const row = document.createElement('tr');
                row.innerHTML = `<td>${timeStr}</td><td>${w10 != null ? Math.round(w10) + ' km/h' : '—'}</td><td>${gusts10 != null ? Math.round(gusts10) + ' km/h' : '—'}</td><td>${w120 != null ? Math.round(w120) + ' km/h' : '—'}</td><td>${gusts120Est != null ? gusts120Est + ' km/h' : '—'}</td><td>${formatVisibility(vis)}</td><td>${cloud != null ? Math.round(cloud) + '%' : '—'}</td><td>${precipCell}</td><td>${t != null ? Math.round(t) + '°' : '—'}</td>`;
                hourlyBody.appendChild(row);
            }
        } else {
            if (hourlyTableWrap) hourlyTableWrap.style.display = 'none';
            if (hourlyEmpty) hourlyEmpty.classList.remove('hidden');
        }

        const modelLabel = MODEL_LABELS[model] || model;
        const attrHtml = 'Data from <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (' + modelLabel + ')';
        const attrEl = document.getElementById('weatherAttribution');
        const attrHourlyEl = document.getElementById('weatherAttributionHourly');
        if (attrEl) attrEl.innerHTML = attrHtml;
        if (attrHourlyEl) attrHourlyEl.innerHTML = attrHtml;

        updateModelExplainer(model);

        renderAviationSection(aviationData || { nearby: [], metars: [], tafs: [], error: null });

        if (selectedPoint) {
            loadAirspaceTab(selectedPoint.lat, selectedPoint.lng, airspaceSearchRadiusKm);
        }
    }

    function updateModelExplainer(model) {
        var body = document.getElementById('weatherModelExplainerBody');
        if (!body) return;
        var info = MODEL_EXPLAINERS[model] || MODEL_EXPLAINERS['auto'];

        body.innerHTML =
            '<p><strong>' + info.name + '</strong> — ' + info.fullName + '</p>' +
            '<table class="model-equiv-table">' +
            '<tr><th>Resolution</th><th>Provider</th></tr>' +
            '<tr><td>' + info.resolution + '</td><td>' + info.provider + '</td></tr>' +
            '</table>' +
            '<p style="margin-top:10px">' + info.equiv + '</p>' +
            '<table class="model-equiv-table" style="margin-top:10px">' +
            '<tr><th>Service</th><th>Primary Model</th><th>AirPlot Equivalent</th></tr>' +
            '<tr><td>BBC Weather</td><td>ECMWF IFS (via MeteoGroup/DTN)</td><td class="equiv-highlight">ECMWF IFS</td></tr>' +
            '<tr><td>Met Office</td><td>Met Office UKV (2 km) + Global</td><td class="equiv-highlight">UK Met Office</td></tr>' +
            '<tr><td>Windy.com</td><td>ECMWF IFS (default), GFS, ICON</td><td class="equiv-highlight">ECMWF IFS / GFS</td></tr>' +
            '</table>';
    }

    function formatNotamDate(str) {
        if (!str) return '';
        var raw = String(str).trim();
        var up = raw.toUpperCase();
        if (up === 'PERM' || up === 'UFN') return up;
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var fmt = function (d) {
            return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
                String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
        };
        var m = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (m) { var d = new Date(Date.UTC(+m[1], parseInt(m[2],10)-1, +m[3], +m[4], +m[5])); if (!isNaN(d.getTime())) return fmt(d); }
        m = raw.match(/\d{10}/);
        if (!m) return raw;
        var s = m[0];
        var yy = parseInt(s.slice(0,2),10); var mm = parseInt(s.slice(2,4),10)-1; var dd = parseInt(s.slice(4,6),10);
        var hh = parseInt(s.slice(6,8),10); var min = parseInt(s.slice(8,10),10);
        var year = yy >= 50 ? 1900 + yy : 2000 + yy;
        if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return raw;
        return fmt(new Date(Date.UTC(year, mm, dd, hh, min)));
    }

    function escapeHtml(str) {
        if (str == null) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function parkAirspaceMinimap() {
        var park = document.getElementById('weatherAirspaceMinimapPark');
        var mm = document.getElementById('weatherAirspaceMinimap');
        if (park && mm && mm.parentNode !== park) {
            park.appendChild(mm);
        }
    }

    function hideAirspaceDetailPanel() {
        parkAirspaceMinimap();
        var content = document.getElementById('weatherAirspaceContent');
        if (content) {
            content.querySelectorAll('.weather-airspace-item-expanded').forEach(function (exp) {
                exp.classList.add('hidden');
                exp.setAttribute('aria-hidden', 'true');
            });
            content.querySelectorAll('.weather-airspace-item-trigger').forEach(function (tr) {
                tr.setAttribute('aria-expanded', 'false');
            });
            content.querySelectorAll('.weather-airspace-item--selected').forEach(function (row) {
                row.classList.remove('weather-airspace-item--selected');
            });
        }
        airspaceDetailSelectedEl = null;
    }

    function ensureAirspaceMinimap() {
        var el = document.getElementById('weatherAirspaceMinimap');
        if (!el) return null;
        if (airspaceMinimap) return airspaceMinimap;
        airspaceMinimap = L.map(el, { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19
        }).addTo(airspaceMinimap);
        airspaceMinimapOverlay = L.layerGroup().addTo(airspaceMinimap);
        return airspaceMinimap;
    }

    function refreshAirspaceMinimapView() {
        if (!airspaceMinimap) return;
        requestAnimationFrame(function () {
            airspaceMinimap.invalidateSize();
            setTimeout(function () { airspaceMinimap.invalidateSize(); }, 200);
        });
    }

    function showAirspaceDetail(kind, index, lat, lng, itemEl) {
        if (!itemEl) return;
        var titleEl = itemEl.querySelector('.weather-airspace-detail-title');
        var bodyEl = itemEl.querySelector('.weather-airspace-detail-body');
        var slot = itemEl.querySelector('.weather-airspace-minimap-slot');
        if (!titleEl || !bodyEl) return;

        parkAirspaceMinimap();
        if (slot) {
            var mmEl = document.getElementById('weatherAirspaceMinimap');
            if (mmEl) slot.appendChild(mmEl);
        }

        var mm = ensureAirspaceMinimap();
        if (airspaceMinimapOverlay) airspaceMinimapOverlay.clearLayers();

        if (kind === 'airspace') {
            var a = lastAirspaceData && lastAirspaceData[index];
            if (!a) return;
            titleEl.textContent = (a.name && a.name !== '—' ? a.name : a.designator) + ' (' + a.category + ')';
            var lines = [];
            lines.push('<p><strong>Designator</strong> ' + escapeHtml(a.designator) + '</p>');
            lines.push('<p><strong>Lower / Upper</strong> ' + escapeHtml(String(a.lower)) + ' / ' + escapeHtml(String(a.upper)) + '</p>');
            if (a.type) lines.push('<p><strong>Type</strong> ' + escapeHtml(a.type) + '</p>');
            if (a.source) lines.push('<p><strong>Source</strong> ' + escapeHtml(a.source) + '</p>');
            if (a.description) lines.push('<p class="weather-airspace-detail-desc">' + escapeHtml(a.description) + '</p>');
            bodyEl.innerHTML = lines.join('');

            var catColors = { FRZ: '#9333ea', Prohibited: '#991b1b', Restricted: '#dc2626', Danger: '#ca8a04' };
            if (mm && a.geometry && airspaceMinimapOverlay) {
                var gj = L.geoJSON(a.geometry, {
                    style: { color: catColors[a.category] || '#dc2626', weight: 2, fillColor: catColors[a.category] || '#dc2626', fillOpacity: 0.2 }
                });
                airspaceMinimapOverlay.addLayer(gj);
                L.marker([lat, lng], { title: 'Selected point' }).addTo(airspaceMinimapOverlay);
                var b = gj.getBounds();
                if (b.isValid()) {
                    b.extend([lat, lng]);
                    mm.fitBounds(b.pad(0.12));
                } else {
                    mm.setView([lat, lng], 11);
                }
            }
        } else if (kind === 'notam') {
            var n = lastNotamData && lastNotamData[index];
            if (!n) return;
            titleEl.textContent = n.id || 'NOTAM';
            var dist = haversineKm(lat, lng, n.lat, n.lng).toFixed(1);
            var validStart = formatNotamDate(n.startValidity);
            var validEnd = formatNotamDate(n.endValidity);
            var radStr = (n.radiusNm > 0 && n.radiusNm < 999) ? n.radiusNm + ' NM' : '—';
            bodyEl.innerHTML =
                '<p><strong>Distance</strong> ' + escapeHtml(dist) + ' km</p>' +
                '<p><strong>Radius</strong> ' + escapeHtml(radStr) + '</p>' +
                '<p><strong>Valid</strong> ' + escapeHtml(validStart) + ' – ' + escapeHtml(validEnd) + '</p>' +
                '<p class="weather-airspace-detail-notam-text">' + escapeHtml(n.text || '').replace(/\n/g, '<br>') + '</p>';

            if (mm && airspaceMinimapOverlay) {
                L.marker([lat, lng], { title: 'Selected point' }).addTo(airspaceMinimapOverlay);
                L.marker([n.lat, n.lng], { title: 'NOTAM centre' }).addTo(airspaceMinimapOverlay);
                if (n.radiusNm > 0 && n.radiusNm < 999) {
                    L.circle([n.lat, n.lng], { radius: n.radiusNm * 1852, color: '#dc2626', weight: 2, fillColor: '#dc2626', fillOpacity: 0.12 }).addTo(airspaceMinimapOverlay);
                }
                var groupBounds = L.latLngBounds([lat, lng], [n.lat, n.lng]);
                if (groupBounds.isValid()) {
                    mm.fitBounds(groupBounds.pad(0.25));
                } else {
                    mm.setView([lat, lng], 10);
                }
            }
        }

        refreshAirspaceMinimapView();
        if (typeof itemEl.scrollIntoView === 'function') {
            itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function activateAirspaceListItem(trigger) {
        if (!trigger || !selectedPoint) return;
        var item = trigger.closest('.weather-airspace-item');
        if (!item) return;
        var kind = trigger.getAttribute('data-kind');
        var idx = parseInt(trigger.getAttribute('data-index'), 10);
        if (!kind || !isFinite(idx)) return;

        if (airspaceDetailSelectedEl && airspaceDetailSelectedEl !== item) {
            var prevExp = airspaceDetailSelectedEl.querySelector('.weather-airspace-item-expanded');
            if (prevExp) {
                prevExp.classList.add('hidden');
                prevExp.setAttribute('aria-hidden', 'true');
            }
            var prevTr = airspaceDetailSelectedEl.querySelector('.weather-airspace-item-trigger');
            if (prevTr) prevTr.setAttribute('aria-expanded', 'false');
            airspaceDetailSelectedEl.classList.remove('weather-airspace-item--selected');
            parkAirspaceMinimap();
        }

        airspaceDetailSelectedEl = item;
        item.classList.add('weather-airspace-item--selected');
        trigger.setAttribute('aria-expanded', 'true');
        var exp = item.querySelector('.weather-airspace-item-expanded');
        if (exp) {
            exp.classList.remove('hidden');
            exp.setAttribute('aria-hidden', 'false');
        }
        showAirspaceDetail(kind, idx, selectedPoint.lat, selectedPoint.lng, item);
    }

    async function loadAirspaceTab(lat, lng, radiusKm) {
        var loading = document.getElementById('weatherAirspaceLoading');
        var content = document.getElementById('weatherAirspaceContent');
        if (!loading || !content) return;
        var r = radiusKm != null ? clampAirspaceRadiusKm(radiusKm) : readAirspaceRadiusFromInput();
        airspaceSearchRadiusKm = r;
        syncAirspaceRadiusInput();
        persistAirspaceRadiusKm();

        hideAirspaceDetailPanel();
        loading.classList.remove('hidden');
        content.classList.add('hidden');
        content.innerHTML = '';

        var results = await Promise.all([
            fetchNearbyNotams(lat, lng, airspaceSearchRadiusKm),
            fetchNearbyAirspace(lat, lng, airspaceSearchRadiusKm)
        ]);
        lastNotamData = results[0];
        lastAirspaceData = results[1];

        loading.classList.add('hidden');
        content.classList.remove('hidden');
        renderAirspaceTab(lastNotamData, lastAirspaceData, lat, lng);
    }

    function weatherAirspaceExpandedHtml() {
        return '<div class="weather-airspace-item-expanded hidden" aria-hidden="true">' +
            '<div class="weather-airspace-detail weather-airspace-detail--inline">' +
            '<div class="weather-airspace-detail-header">' +
            '<h4 class="weather-airspace-detail-title"></h4>' +
            '<button type="button" class="weather-airspace-detail-close" aria-label="Close details">&times;</button>' +
            '</div>' +
            '<div class="weather-airspace-detail-body"></div>' +
            '<div class="weather-airspace-minimap-slot"></div>' +
            '</div></div>';
    }

    function renderAirspaceTab(notams, airspace, lat, lng) {
        var content = document.getElementById('weatherAirspaceContent');
        if (!content) return;
        content.innerHTML = '';

        if (notams.length === 0 && airspace.length === 0) {
            content.innerHTML = '<div class="weather-airspace-empty"><p>No NOTAMs or airspace restrictions found within ' + airspaceSearchRadiusKm + ' km.</p></div>';
            return;
        }

        if (airspace.length > 0) {
            var catColors = { FRZ: 'frz', Prohibited: 'prohibited', Restricted: 'restricted', Danger: 'danger' };
            content.insertAdjacentHTML('beforeend',
                '<div class="weather-airspace-section-title">Airspace Restrictions <span class="airspace-count">(' + airspace.length + ')</span></div>'
            );
            airspace.forEach(function (a, i) {
                var cls = catColors[a.category] || 'danger';
                var distKm = '';
                if (a.geometry) {
                    var coords = a.geometry.type === 'MultiPolygon' ? a.geometry.coordinates.flat(2) : (a.geometry.type === 'Polygon' ? a.geometry.coordinates.flat() : []);
                    var minDist = Infinity;
                    coords.forEach(function (c) { var d = haversineKm(lat, lng, c[1], c[0]); if (d < minDist) minDist = d; });
                    if (isFinite(minDist)) distKm = ' · ' + minDist.toFixed(1) + ' km away';
                }
                content.insertAdjacentHTML('beforeend',
                    '<div class="weather-airspace-item category-' + cls + '">' +
                    '<div class="weather-airspace-item-trigger weather-airspace-item--selectable" role="button" tabindex="0" data-kind="airspace" data-index="' + i + '" aria-expanded="false">' +
                    '<div class="weather-airspace-item-header">' +
                    '<span class="weather-airspace-badge badge-' + cls + '">' + a.category + '</span>' +
                    '<span class="weather-airspace-item-name">' + escapeHtml(a.name || a.designator) + '</span>' +
                    '</div>' +
                    '<div class="weather-airspace-item-detail">' +
                    '<strong>' + escapeHtml(a.designator) + '</strong>' + distKm +
                    ' · Lower: ' + escapeHtml(String(a.lower)) + ' · Upper: ' + escapeHtml(String(a.upper)) +
                    '</div></div>' +
                    weatherAirspaceExpandedHtml() +
                    '</div>'
                );
            });
        }

        if (notams.length > 0) {
            content.insertAdjacentHTML('beforeend',
                '<div class="weather-airspace-section-title">NOTAMs <span class="airspace-count">(' + notams.length + ')</span></div>'
            );
            notams.forEach(function (n, i) {
                var dist = haversineKm(lat, lng, n.lat, n.lng).toFixed(1);
                var validStart = formatNotamDate(n.startValidity);
                var validEnd = formatNotamDate(n.endValidity);
                var validStr = validStart + ' – ' + validEnd;
                var descText = (n.text || '').replace(/\s+/g, ' ');
                if (descText.length > 300) descText = descText.slice(0, 297) + '…';
                content.insertAdjacentHTML('beforeend',
                    '<div class="weather-airspace-item category-notam">' +
                    '<div class="weather-airspace-item-trigger weather-airspace-item--selectable" role="button" tabindex="0" data-kind="notam" data-index="' + i + '" aria-expanded="false">' +
                    '<div class="weather-airspace-item-header">' +
                    '<span class="weather-airspace-badge badge-notam">NOTAM</span>' +
                    '<span class="weather-airspace-item-name">' + escapeHtml(n.id || 'NOTAM') + '</span>' +
                    '</div>' +
                    '<div class="weather-airspace-item-detail">' +
                    dist + ' km away' +
                    (n.radiusNm > 0 && n.radiusNm < 999 ? ' · Radius: ' + n.radiusNm + ' NM' : '') +
                    '<br>Valid: ' + escapeHtml(validStr) +
                    '<br>' + escapeHtml(descText) +
                    '</div></div>' +
                    weatherAirspaceExpandedHtml() +
                    '</div>'
                );
            });
        }
    }

    const WX_CODES = {
        RA: 'rain', SN: 'snow', DZ: 'drizzle', GR: 'hail', GS: 'snow pellets',
        PL: 'ice pellets', SG: 'snow grains', IC: 'ice crystals', UP: 'unknown precipitation',
        BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'dust',
        SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust/sand whirls', SQ: 'squalls',
        FC: 'funnel cloud', DS: 'dust storm', SS: 'sandstorm', SH: 'showers',
        TS: 'thunderstorm', FZ: 'freezing', BL: 'blowing', DR: 'low drifting',
        MI: 'shallow', PR: 'partial', BC: 'patches', VC: 'vicinity'
    };
    const WX_COMBINED = { SHRA: 'rain showers', TSRA: 'thunderstorms with rain', TSSN: 'thunderstorms with snow', '-RA': 'light rain', '-SN': 'light snow', RA: 'rain', SN: 'snow' };

    function decodeWxString(wx) {
        if (!wx) return '';
        const s = String(wx).trim();
        if (WX_COMBINED[s]) return WX_COMBINED[s];
        let intensity = '';
        let rest = s;
        if (s.startsWith('-')) { intensity = 'light '; rest = s.slice(1); }
        else if (s.startsWith('+')) { intensity = 'heavy '; rest = s.slice(1); }
        const parts = [];
        for (let i = 0; i < rest.length; i += 2) {
            const code = rest.slice(i, i + 2);
            if (WX_CODES[code]) parts.push(WX_CODES[code]);
        }
        return intensity + (parts.length ? parts.join(' ') : s.toLowerCase());
    }

    const MI_TO_KM = 1.609344;

    function kmBracketFromMiles(mi) {
        const km = mi * MI_TO_KM;
        if (km < 1) {
            const rounded = Math.round(km * 10) / 10;
            return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
        }
        return String(Math.round(km));
    }

    function milesWithKm(mi) {
        return mi + ' miles (' + kmBracketFromMiles(mi) + ' km)';
    }

    function parseMilesFromVisibPrefix(prefix) {
        const s = String(prefix).trim();
        if (!s) return null;
        const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
        if (frac) {
            const a = parseInt(frac[1], 10);
            const b = parseInt(frac[2], 10);
            if (b > 0) return a / b;
        }
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    function formatVisib(v) {
        if (v == null) return '—';
        if (typeof v === 'string') {
            if (v === '6+' || v === 'P6SM') return '6 miles or more (' + kmBracketFromMiles(6) + ' km)';
            if (v === '9999' || v === '10+') return '10 km or more';
            if (v.endsWith('SM')) {
                const prefix = v.slice(0, -2);
                const mi = parseMilesFromVisibPrefix(prefix);
                if (mi != null) return milesWithKm(mi);
                return prefix.trim() + ' miles';
            }
            return v;
        }
        if (typeof v === 'number') {
            if (v >= 10) return v + ' km';
            return milesWithKm(v);
        }
        return String(v);
    }

    function formatClouds(clouds) {
        if (!clouds || !clouds.length) return '';
        const coverNames = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' };
        return clouds.map(function (c) {
            const name = coverNames[c.cover] || c.cover;
            const base = c.base != null ? Math.round(c.base) + ' ft' : '';
            return name + (base ? ' at ' + base : '');
        }).join(', ');
    }

    function decodeMetar(m) {
        if (!m) return '';
        const parts = [];
        if (m.wdir != null && m.wspd != null) {
            let wind = 'Wind ' + (m.wspd >= 7 ? directionToCardinal(m.wdir) + ' at ' + m.wspd : 'calm');
            if (m.wdir === 0 && m.wspd === 0) wind = 'Wind calm';
            else if (m.wspd < 7) wind = 'Wind variable at ' + m.wspd + ' kt';
            if (m.wgst != null && m.wgst > m.wspd) wind += ' gusting ' + m.wgst;
            wind += ' kt';
            parts.push(wind);
        }
        parts.push('Visibility ' + formatVisib(m.visib));
        if (m.clouds && m.clouds.length) parts.push('Clouds: ' + formatClouds(m.clouds));
        if (m.temp != null) parts.push('Temperature ' + m.temp + '°C' + (m.dewp != null ? ', dewpoint ' + m.dewp + '°C' : ''));
        if (m.altim != null) {
            const inHg = (m.altim >= 900 && m.altim <= 1100) ? (m.altim * 0.02953).toFixed(2) : (m.altim / 100).toFixed(2);
            parts.push('Altimeter ' + inHg + ' inHg');
        }
        if (m.fltCat) parts.push('Flight category: ' + m.fltCat);
        return parts.join('. ');
    }

    function decodeTaf(t) {
        if (!t || !t.fcsts || !t.fcsts.length) return '';
        const lines = [];
        t.fcsts.forEach(function (f, i) {
            const from = f.timeFrom ? formatAviationTime(f.timeFrom) : '';
            const to = f.timeTo ? formatAviationTime(f.timeTo) : '';
            const change = f.fcstChange ? ' (' + f.fcstChange + (f.probability ? ' ' + f.probability + '%' : '') + ')' : '';
            const parts = [];
            if (from && to) parts.push(from + ' – ' + to + change);
            if (f.wdir != null && f.wspd != null) {
                let w = 'Wind ' + directionToCardinal(f.wdir) + ' ' + f.wspd + ' kt';
                if (f.wgst) w += ' gusting ' + f.wgst + ' kt';
                parts.push(w);
            }
            if (f.visib != null) parts.push('Visibility ' + formatVisib(f.visib));
            if (f.wxString) parts.push(decodeWxString(f.wxString));
            if (f.clouds && f.clouds.length) parts.push('Clouds: ' + formatClouds(f.clouds));
            if (parts.length) lines.push(parts.join('. '));
        });
        return lines.join('\n\n');
    }

    function formatAviationTime(val) {
        if (val == null) return '';
        let d;
        if (typeof val === 'number') {
            d = new Date(val * 1000);
        } else if (typeof val === 'string') {
            d = new Date(val);
        } else {
            return '';
        }
        if (isNaN(d.getTime())) return '';
        const day = d.getUTCDate();
        const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
        const year = d.getUTCFullYear();
        const h = String(d.getUTCHours()).padStart(2, '0');
        const m = String(d.getUTCMinutes()).padStart(2, '0');
        return day + ' ' + month + ' ' + year + ' ' + h + ':' + m + ' UTC';
    }

    function renderAviationSection(aviationData) {
        const container = document.getElementById('weatherAviationContent');
        if (!container) return;
        const { nearby, metars, tafs, error } = aviationData;
        const metarByIcao = {};
        (metars || []).forEach(function (m) {
            const icao = (m.icaoId || m.stationId || m.icao || '').toUpperCase();
            if (icao) metarByIcao[icao] = m;
        });
        const tafByIcao = {};
        (tafs || []).forEach(function (t) {
            const icao = (t.icaoId || t.stationId || t.icao || '').toUpperCase();
            if (icao) tafByIcao[icao] = t;
        });

        let html = '';
        if (error) {
            html = '<div class="weather-aviation-error">Could not load aviation data: ' + (error || 'Unknown error') + '</div>';
        } else if (!nearby || nearby.length === 0) {
            html = '<div class="weather-aviation-empty">No aerodromes with METAR/TAF within 50 NM of the selected location.</div>';
        } else {
            nearby.forEach(function (s) {
                const metar = metarByIcao[s.icao];
                const taf = tafByIcao[s.icao];
                const rawMetar = metar && (metar.rawOb || metar.raw || metar.report);
                const rawTaf = taf && (taf.rawTAF || taf.raw || taf.report);
                const metarTime = metar && (metar.reportTime || metar.obsTime);
                const tafIssue = taf && (taf.issueTime || taf.bulletinTime);
                const tafValidFrom = taf && taf.validTimeFrom;
                const tafValidTo = taf && taf.validTimeTo;

                html += '<div class="weather-aviation-station">';
                html += '<div class="weather-aviation-station-header">';
                html += '<strong>' + (s.name || s.icao) + '</strong> <span class="weather-aviation-icao">' + s.icao + '</span>';
                html += ' <span class="weather-aviation-dist">' + s.distNm.toFixed(1) + ' NM</span>';
                html += '</div>';
                if (rawMetar) {
                    const decodedMetar = decodeMetar(metar);
                    html += '<div class="weather-aviation-block"><span class="weather-aviation-label">METAR</span>';
                    if (metarTime) html += '<span class="weather-aviation-validity">Observed: ' + formatAviationTime(metarTime) + '</span>';
                    html += '<div class="weather-aviation-decoded" data-view="decoded">' + (decodedMetar || '—').replace(/</g, '&lt;') + '</div>';
                    html += '<code class="weather-aviation-raw" data-view="raw">' + (rawMetar || '').replace(/</g, '&lt;') + '</code></div>';
                } else {
                    html += '<div class="weather-aviation-block"><span class="weather-aviation-label">METAR</span><span class="weather-aviation-missing">—</span></div>';
                }
                if (rawTaf) {
                    const decodedTaf = decodeTaf(taf);
                    html += '<div class="weather-aviation-block"><span class="weather-aviation-label">TAF</span>';
                    if (tafIssue || tafValidFrom || tafValidTo) {
                        const parts = [];
                        if (tafIssue) parts.push('Issued: ' + formatAviationTime(tafIssue));
                        if (tafValidFrom && tafValidTo) parts.push('Valid: ' + formatAviationTime(tafValidFrom) + ' – ' + formatAviationTime(tafValidTo));
                        html += '<span class="weather-aviation-validity">' + parts.join(' · ') + '</span>';
                    }
                    html += '<div class="weather-aviation-decoded" data-view="decoded">' + (decodedTaf || '—').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</div>';
                    html += '<code class="weather-aviation-raw" data-view="raw">' + (rawTaf || '').replace(/</g, '&lt;') + '</code></div>';
                } else {
                    html += '<div class="weather-aviation-block"><span class="weather-aviation-label">TAF</span><span class="weather-aviation-missing">—</span></div>';
                }
                html += '</div>';
            });
        }
        container.innerHTML = html;
    }

    // ---- PPTX Export ----
    async function captureMapImage() {
        const mapEl = document.getElementById('map');
        const canvas = await html2canvas(mapEl, {
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#1a1a2e',
            scale: 2,
            logging: false
        });
        return canvas.toDataURL('image/png');
    }

    function suitabilityColor(level) {
        if (level === 'good') return { bg: '4CAF50', text: 'FFFFFF' };
        if (level === 'caution') return { bg: 'FF9800', text: 'FFFFFF' };
        return { bg: 'E05555', text: 'FFFFFF' };
    }

    async function exportWeatherPptx() {
        if (!lastReportData || !selectedPoint) {
            alert('Fetch weather data first before exporting.');
            return;
        }
        const btn = document.getElementById('weatherExportPptxBtn');
        const origText = btn.querySelector('span').textContent;
        btn.disabled = true;
        btn.querySelector('span').textContent = 'Exporting…';

        try {
            const lightToggle = document.getElementById('weatherLightThemeToggle');
            PptxTheme.setLight(lightToggle && lightToggle.checked);

            const pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_WIDE';
            pptx.author = 'AirPlot';
            pptx.subject = 'Flight Weather Report';

            const logo = await PptxTheme.loadLogo();
            PptxTheme.applyTheme(pptx, logo);

            const C = PptxTheme.colors();
            const headerOpts = PptxTheme.tableHeaderOpts();
            const cellOpts = PptxTheme.tableCellOpts();
            const labelOpts = PptxTheme.tableLabelOpts();
            const border = PptxTheme.tableBorder();

            const data = lastReportData;
            const suitability = deriveSuitability(data);
            const suitColor = suitabilityColor(suitability.level);
            const modelLabel = MODEL_LABELS[lastModel] || lastModel;
            const locLabel = selectedPoint.lat.toFixed(5) + ', ' + selectedPoint.lng.toFixed(5);
            const timeLabel = lastDisplayTime ? new Date(lastDisplayTime).toLocaleString() : new Date().toLocaleString();

            const mapContainer = document.getElementById('weatherMap') || document.getElementById('map');
            const mapImg = await PptxTheme.captureSquareMap(mapContainer);

            // --- Slide 1: Title + Map ---
            let slide = pptx.addSlide({ masterName: 'TITLE_SLIDE' });
            slide.addText('Flight Weather Report', { x: 1.1, y: 0.15, w: 8, h: 0.6, fontSize: 26, bold: true, color: C.textPrimary, fontFace: 'Arial' });

            var mapSize = 5.6;
            slide.addShape('roundRect', { x: 0.42, y: 1.02, w: mapSize + 0.16, h: mapSize + 0.16, fill: { color: C.surface }, rectRadius: 0.12, line: { color: C.border, width: 0.5 } });
            slide.addImage({ data: mapImg, x: 0.5, y: 1.1, w: mapSize, h: mapSize, rounding: false });

            var panelX = 6.5;
            var panelW = 6.3;
            PptxTheme.addInfoPanel(slide, panelX, 1.0, panelW, 5.7, [
                { label: 'LOCATION', value: locLabel, divider: true },
                { label: 'DATE & TIME', value: timeLabel, divider: true },
                { label: 'WEATHER MODEL', value: modelLabel, divider: true },
                { label: 'FLIGHT SUITABILITY', value: suitability.text, color: suitColor.bg === '4CAF50' ? '66BB6A' : (suitColor.bg === 'FF9800' ? 'FFB74D' : 'EF5350'), bold: true, fontSize: 15, divider: true },
                { label: 'COORDINATES', value: selectedPoint.lat.toFixed(6) + '°N   ' + Math.abs(selectedPoint.lng).toFixed(6) + '°' + (selectedPoint.lng >= 0 ? 'E' : 'W'), divider: true },
                { label: 'GENERATED', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '  at  ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }
            ]);

            // --- Slide 2: Weather Summary ---
            slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
            slide.addText('Weather Summary', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
            slide.addText(suitability.text, { x: 0.5, y: 0.85, w: 5, h: 0.45, fontSize: 14, bold: true, color: suitColor.text, fontFace: 'Arial', fill: { color: suitColor.bg }, shape: pptx.ShapeType.roundRect, rectRadius: 0.05 });

            const summaryText = deriveSummaryText(lastHourlySlice, suitability);
            if (summaryText) {
                slide.addText(summaryText, { x: 0.5, y: 1.45, w: 12, h: 0.5, fontSize: 11, color: C.textMuted, fontFace: 'Arial' });
            }

            const gusts120 = data.wind_speed_120m != null ? Math.round(data.wind_speed_120m * GUST_120M_MULTIPLIER) + ' km/h' : '—';
            const cloudTotal = data.cloud_cover;
            const cloudLow = data.cloud_cover_low;
            let cloudStr = '—';
            if (cloudTotal != null) {
                cloudStr = cloudLow != null ? Math.round(cloudTotal) + '% total, ' + Math.round(cloudLow) + '% low' : Math.round(cloudTotal) + '%';
            }
            const precip = data.precipitation;
            const precipProb = data.precipitation_probability;
            let precipStr = '—';
            if (precip != null) {
                precipStr = precipProb != null ? (Math.round(precip * 10) / 10) + ' mm (' + Math.round(precipProb) + '% chance)' : (Math.round(precip * 10) / 10) + ' mm';
            }

            const summaryRows = [
                [{ text: 'Parameter', options: headerOpts }, { text: 'Value', options: headerOpts }],
                [{ text: 'Wind 10 m (sustained)', options: labelOpts }, { text: formatWindRow(data.wind_speed_10m, data.wind_direction_10m), options: cellOpts }],
                [{ text: 'Gusts 10 m', options: labelOpts }, { text: data.wind_gusts_10m != null ? Math.round(data.wind_gusts_10m) + ' km/h' : '—', options: cellOpts }],
                [{ text: 'Wind 120 m (sustained)', options: labelOpts }, { text: formatWindRow(data.wind_speed_120m, data.wind_direction_120m), options: cellOpts }],
                [{ text: 'Gusts 120 m (est.)', options: labelOpts }, { text: gusts120, options: cellOpts }],
                [{ text: 'Visibility', options: labelOpts }, { text: formatVisibility(data.visibility), options: cellOpts }],
                [{ text: 'Cloud cover', options: labelOpts }, { text: cloudStr, options: cellOpts }],
                [{ text: 'Precipitation', options: labelOpts }, { text: precipStr, options: cellOpts }],
                [{ text: 'Temperature', options: labelOpts }, { text: data.temperature_2m != null ? Math.round(data.temperature_2m) + ' °C' : '—', options: cellOpts }]
            ];
            slide.addTable(summaryRows, { x: 0.5, y: 2.05, w: 8, colW: [3.5, 4.5], border: border, rowH: 0.4 });
            slide.addText('Data from Open-Meteo (' + modelLabel + ')', { x: 0.5, y: 6.7, w: 8, h: 0.3, fontSize: 9, color: C.textMuted, fontFace: 'Arial' });

            // --- Slide 3: 12-Hour Forecast (if available) ---
            if (lastHourlySlice && lastHourlySlice.hourly) {
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('12-Hour Forecast', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                const h = lastHourlySlice.hourly;
                const start = lastHourlySlice.startIdx;
                const count = Math.min(12, (h.time?.length || 0) - start);

                const forecastHeader = [
                    { text: 'Time', options: headerOpts },
                    { text: 'Sust. 10m', options: headerOpts },
                    { text: 'Gusts 10m', options: headerOpts },
                    { text: 'Sust. 120m', options: headerOpts },
                    { text: 'Gusts 120m', options: headerOpts },
                    { text: 'Vis', options: headerOpts },
                    { text: 'Cloud', options: headerOpts },
                    { text: 'Precip', options: headerOpts },
                    { text: 'Temp', options: headerOpts }
                ];
                const forecastRows = [forecastHeader];

                for (let i = 0; i < count; i++) {
                    const idx = start + i;
                    const timeStr = h.time[idx] ? new Date(h.time[idx]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
                    const w10 = h.wind_speed_10m?.[idx];
                    const g10 = h.wind_gusts_10m?.[idx];
                    const w120 = h.wind_speed_120m?.[idx];
                    const g120Est = w120 != null ? Math.round(w120 * GUST_120M_MULTIPLIER) : null;
                    const vis = h.visibility?.[idx];
                    const cloud = h.cloud_cover?.[idx];
                    const p = h.precipitation?.[idx];
                    const t = h.temperature_2m?.[idx];

                    forecastRows.push([
                        { text: timeStr, options: cellOpts },
                        { text: w10 != null ? Math.round(w10) + '' : '—', options: cellOpts },
                        { text: g10 != null ? Math.round(g10) + '' : '—', options: cellOpts },
                        { text: w120 != null ? Math.round(w120) + '' : '—', options: cellOpts },
                        { text: g120Est != null ? g120Est + '' : '—', options: cellOpts },
                        { text: formatVisibility(vis), options: cellOpts },
                        { text: cloud != null ? Math.round(cloud) + '%' : '—', options: cellOpts },
                        { text: p != null ? (Math.round(p * 10) / 10) + ' mm' : '0', options: cellOpts },
                        { text: t != null ? Math.round(t) + '°C' : '—', options: cellOpts }
                    ]);
                }

                slide.addText('All wind speeds in km/h', { x: 0.5, y: 0.7, w: 8, h: 0.3, fontSize: 10, color: C.textMuted, fontFace: 'Arial' });
                slide.addTable(forecastRows, { x: 0.3, y: 1.05, w: 12.6, colW: [1.2, 1.3, 1.3, 1.3, 1.3, 1.5, 1.2, 1.3, 1.2], border: border, rowH: 0.4, fontSize: 9 });
            }

            // --- Slide 4: METAR / TAF (if available) ---
            if (lastAviationData && lastAviationData.nearby && lastAviationData.nearby.length > 0) {
                const metarByIcao = {};
                (lastAviationData.metars || []).forEach(function (m) {
                    const icao = (m.icaoId || m.stationId || m.icao || '').toUpperCase();
                    if (icao) metarByIcao[icao] = m;
                });
                const tafByIcao = {};
                (lastAviationData.tafs || []).forEach(function (t) {
                    const icao = (t.icaoId || t.stationId || t.icao || '').toUpperCase();
                    if (icao) tafByIcao[icao] = t;
                });

                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('METAR / TAF — Aerodromes within 50 NM', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                var maxY = 6.6;
                let yPos = 0.85;

                function newMetarSlide(title) {
                    slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                    slide.addText(title, { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                    yPos = 0.85;
                }

                lastAviationData.nearby.forEach(function (s) {
                    const metar = metarByIcao[s.icao];
                    const taf = tafByIcao[s.icao];
                    const rawMetar = metar && (metar.rawOb || metar.raw || metar.report);
                    const rawTaf = taf && (taf.rawTAF || taf.raw || taf.report);

                    var metarH = rawMetar ? 0.7 : 0;
                    var tafH = 0;
                    if (rawTaf) {
                        var decoded = decodeTaf(taf);
                        var tafText = decoded || rawTaf;
                        var lineCount = (tafText.match(/\n/g) || []).length + 1;
                        tafH = Math.max(0.6, Math.min(2.0, lineCount * 0.22)) + 0.1;
                    }
                    var blockH = 0.4 + metarH + tafH + 0.2;

                    if (yPos + blockH > maxY) {
                        newMetarSlide('METAR / TAF (continued)');
                    }

                    slide.addText(
                        [
                            { text: (s.name || s.icao), options: { bold: true, fontSize: 12, color: C.textPrimary } },
                            { text: '  ' + s.icao + '  (' + s.distNm.toFixed(1) + ' NM)', options: { fontSize: 10, color: C.accent } }
                        ],
                        { x: 0.5, y: yPos, w: 12, h: 0.35, fontFace: 'Arial' }
                    );
                    yPos += 0.4;

                    if (rawMetar) {
                        var decodedMetar = decodeMetar(metar);
                        slide.addText('METAR: ' + (decodedMetar || rawMetar), { x: 0.7, y: yPos, w: 11.5, h: 0.6, fontSize: 9, color: C.textPrimary, fontFace: 'Arial', fill: { color: C.surface }, shape: pptx.ShapeType.roundRect, rectRadius: 0.03, valign: 'top', paraSpaceAfter: 4 });
                        yPos += 0.7;
                    }
                    if (rawTaf) {
                        var boxH = tafH - 0.1;
                        slide.addText('TAF: ' + tafText, { x: 0.7, y: yPos, w: 11.5, h: boxH, fontSize: 9, color: C.textPrimary, fontFace: 'Arial', fill: { color: C.surface }, shape: pptx.ShapeType.roundRect, rectRadius: 0.03, valign: 'top', paraSpaceAfter: 4 });
                        yPos += boxH + 0.1;
                    }
                    yPos += 0.2;
                });

                slide.addText('Data from Aviation Weather Center (aviationweather.gov)', { x: 0.5, y: maxY + 0.1, w: 8, h: 0.3, fontSize: 9, color: C.textMuted, fontFace: 'Arial' });
            }

            // --- NOTAMs & Airspace within 10 km ---
            var notamSlides = lastNotamData || await fetchNearbyNotams(selectedPoint.lat, selectedPoint.lng, airspaceSearchRadiusKm);
            var airspaceFeatures = lastAirspaceData || await fetchNearbyAirspace(selectedPoint.lat, selectedPoint.lng, airspaceSearchRadiusKm);

            if (notamSlides.length > 0 || airspaceFeatures.length > 0) {
                var tempLayers = [];
                var catMapColors = { FRZ: '#9333ea', Prohibited: '#991b1b', Restricted: '#dc2626', Danger: '#ca8a04' };
                var origView = { center: map.getCenter(), zoom: map.getZoom() };

                airspaceFeatures.forEach(function (af) {
                    if (af.geometry) {
                        var layer = L.geoJSON(af.geometry, {
                            style: { color: catMapColors[af.category] || '#dc2626', weight: 2, fillColor: catMapColors[af.category] || '#dc2626', fillOpacity: 0.15 }
                        });
                        layer.addTo(map);
                        tempLayers.push(layer);
                    }
                });
                notamSlides.forEach(function (n) {
                    if (n.radiusNm > 0 && n.radiusNm < 999) {
                        var c = L.circle([n.lat, n.lng], { radius: n.radiusNm * 1852, color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.1 });
                        c.addTo(map);
                        tempLayers.push(c);
                    }
                });

                var radiusDeg = airspaceSearchRadiusKm / 111.32;
                map.fitBounds([
                    [selectedPoint.lat - radiusDeg, selectedPoint.lng - radiusDeg * 1.5],
                    [selectedPoint.lat + radiusDeg, selectedPoint.lng + radiusDeg * 1.5]
                ], { animate: false, padding: [10, 10] });
                await new Promise(function (r) { setTimeout(r, 600); });

                var airspaceMapImg = await PptxTheme.captureSquareMap(mapContainer);

                tempLayers.forEach(function (l) { map.removeLayer(l); });
                map.setView(origView.center, origView.zoom, { animate: false });

                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Airspace & NOTAMs — ' + airspaceSearchRadiusKm + ' km radius', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                var amapSize = 5.6;
                slide.addShape('roundRect', { x: 0.42, y: 0.82, w: amapSize + 0.16, h: amapSize + 0.16, fill: { color: C.surface }, rectRadius: 0.12, line: { color: C.border, width: 0.5 } });
                slide.addImage({ data: airspaceMapImg, x: 0.5, y: 0.9, w: amapSize, h: amapSize, rounding: false });

                var legendY = 0.9;
                var legendX = 6.5;
                slide.addText('Legend', { x: legendX, y: legendY, w: 4, h: 0.3, fontSize: 12, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                legendY += 0.4;
                var legendItems = [
                    { color: '9333EA', label: 'FRZ / Aerodrome' },
                    { color: '991B1B', label: 'Prohibited' },
                    { color: 'DC2626', label: 'Restricted / NOTAM' },
                    { color: 'CA8A04', label: 'Danger Area' }
                ];
                legendItems.forEach(function (item) {
                    slide.addShape('rect', { x: legendX, y: legendY + 0.05, w: 0.2, h: 0.2, fill: { color: item.color } });
                    slide.addText(item.label, { x: legendX + 0.35, y: legendY, w: 4, h: 0.3, fontSize: 10, color: C.textPrimary, fontFace: 'Arial' });
                    legendY += 0.35;
                });

                legendY += 0.2;
                slide.addText(notamSlides.length + ' NOTAM' + (notamSlides.length !== 1 ? 's' : '') + ', ' + airspaceFeatures.length + ' airspace zone' + (airspaceFeatures.length !== 1 ? 's' : ''), { x: legendX, y: legendY, w: 6, h: 0.3, fontSize: 11, bold: true, color: C.accent, fontFace: 'Arial' });
                legendY += 0.4;
                slide.addText('Search radius: ' + airspaceSearchRadiusKm + ' km from ' + selectedPoint.lat.toFixed(5) + ', ' + selectedPoint.lng.toFixed(5), { x: legendX, y: legendY, w: 6, h: 0.25, fontSize: 9, color: C.textMuted, fontFace: 'Arial' });
            }

            if (notamSlides.length > 0) {
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('NOTAMs within ' + airspaceSearchRadiusKm + ' km (' + notamSlides.length + ')', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                var nRows = [[
                    { text: 'NOTAM ID', options: headerOpts },
                    { text: 'Distance', options: headerOpts },
                    { text: 'Radius', options: headerOpts },
                    { text: 'Validity', options: headerOpts },
                    { text: 'Description', options: headerOpts }
                ]];
                var nPageSize = 10;
                for (var ni = 0; ni < notamSlides.length; ni++) {
                    if (ni > 0 && ni % nPageSize === 0) {
                        slide.addTable(nRows, { x: 0.3, y: 0.85, w: 12.6, colW: [1.6, 1.3, 1.0, 2.7, 6.0], border: border, rowH: 0.45, fontSize: 8 });
                        slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                        slide.addText('NOTAMs (continued)', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                        nRows = [[
                            { text: 'NOTAM ID', options: headerOpts },
                            { text: 'Distance', options: headerOpts },
                            { text: 'Radius', options: headerOpts },
                            { text: 'Validity', options: headerOpts },
                            { text: 'Description', options: headerOpts }
                        ]];
                    }
                    var ntm = notamSlides[ni];
                    var ntmDist = haversineKm(selectedPoint.lat, selectedPoint.lng, ntm.lat, ntm.lng).toFixed(1) + ' km';
                    var validStart = formatNotamDate(ntm.startValidity);
                    var validEnd = formatNotamDate(ntm.endValidity);
                    var validStr = (validStart || ntm.startValidity || '?') + ' – ' + (validEnd || ntm.endValidity || '?');
                    var descText = (ntm.text || '').replace(/\s+/g, ' ');
                    if (descText.length > 120) descText = descText.slice(0, 117) + '…';
                    nRows.push([
                        { text: ntm.id || '—', options: cellOpts },
                        { text: ntmDist, options: cellOpts },
                        { text: ntm.radiusNm > 0 && ntm.radiusNm < 999 ? ntm.radiusNm + ' NM' : '—', options: cellOpts },
                        { text: validStr, options: cellOpts },
                        { text: descText, options: cellOpts }
                    ]);
                }
                slide.addTable(nRows, { x: 0.3, y: 0.85, w: 12.6, colW: [1.6, 1.3, 1.0, 2.7, 6.0], border: border, rowH: 0.45, fontSize: 8 });
                slide.addText('UK NOTAMs from NATS AIS via UK NOTAM Archive', { x: 0.5, y: 6.8, w: 8, h: 0.3, fontSize: 9, color: C.textMuted, fontFace: 'Arial' });
            }

            if (airspaceFeatures.length > 0) {
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Airspace Restrictions within ' + airspaceSearchRadiusKm + ' km (' + airspaceFeatures.length + ')', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                var catColors = { 'FRZ': '9333EA', 'Prohibited': '991B1B', 'Restricted': 'DC2626', 'Danger': 'CA8A04' };
                var aRows = [[
                    { text: 'Type', options: headerOpts },
                    { text: 'Designator', options: headerOpts },
                    { text: 'Name', options: headerOpts },
                    { text: 'Lower', options: headerOpts },
                    { text: 'Upper', options: headerOpts }
                ]];
                var aPageSize = 12;
                for (var ai = 0; ai < airspaceFeatures.length; ai++) {
                    if (ai > 0 && ai % aPageSize === 0) {
                        slide.addTable(aRows, { x: 0.3, y: 0.85, w: 12.6, colW: [1.8, 2.2, 4.8, 1.9, 1.9], border: border, rowH: 0.4 });
                        slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                        slide.addText('Airspace Restrictions (continued)', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                        aRows = [[
                            { text: 'Type', options: headerOpts },
                            { text: 'Designator', options: headerOpts },
                            { text: 'Name', options: headerOpts },
                            { text: 'Lower', options: headerOpts },
                            { text: 'Upper', options: headerOpts }
                        ]];
                    }
                    var af = airspaceFeatures[ai];
                    var catColor = catColors[af.category] || C.textPrimary;
                    aRows.push([
                        { text: af.category, options: { fill: { color: C.surface }, color: catColor, fontSize: 10, fontFace: 'Arial', bold: true } },
                        { text: af.designator, options: cellOpts },
                        { text: af.name, options: cellOpts },
                        { text: af.lower, options: cellOpts },
                        { text: af.upper, options: cellOpts }
                    ]);
                }
                slide.addTable(aRows, { x: 0.3, y: 0.85, w: 12.6, colW: [1.8, 2.2, 4.8, 1.9, 1.9], border: border, rowH: 0.4 });
                slide.addText('UK airspace data from NATS AIS (ENR 5.1) and UK AIP', { x: 0.5, y: 6.8, w: 8, h: 0.3, fontSize: 9, color: C.textMuted, fontFace: 'Arial' });
            }

            // --- Airspace & NOTAM Data Sources explainer ---
            if (notamSlides.length > 0 || airspaceFeatures.length > 0) {
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Airspace & NOTAM Data Sources', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                var srcY = 0.85;

                if (notamSlides.length > 0) {
                    slide.addText('NOTAMs', { x: 0.5, y: srcY, w: 5, h: 0.3, fontSize: 14, bold: true, color: C.accent, fontFace: 'Arial' });
                    srcY += 0.35;
                    slide.addShape('roundRect', { x: 0.5, y: srcY, w: 12.2, h: 1.55, fill: { color: C.surface }, rectRadius: 0.06, line: { color: C.border, width: 0.3 } });
                    slide.addText([
                        { text: 'Source: ', options: { bold: true, color: C.textMuted, fontSize: 10 } },
                        { text: 'UK NOTAM Archive (jonty.github.io/uk-notam-archive), mirroring the NATS AIS Contingency Pre-flight Information Bulletin (PIB).', options: { color: C.textPrimary, fontSize: 10 } }
                    ], { x: 0.7, y: srcY + 0.08, w: 11.8, h: 0.3, fontFace: 'Arial' });
                    slide.addText([
                        { text: 'Authority: ', options: { bold: true, color: C.textMuted, fontSize: 10 } },
                        { text: 'NOTAMs are issued by NATS (National Air Traffic Services) on behalf of the UK Civil Aviation Authority (CAA). They are the official mechanism for communicating temporary airspace restrictions, hazards, and aeronautical changes.', options: { color: C.textPrimary, fontSize: 10 } }
                    ], { x: 0.7, y: srcY + 0.38, w: 11.8, h: 0.45, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.2 });
                    slide.addText([
                        { text: 'Reliability: ', options: { bold: true, color: C.textMuted, fontSize: 10 } },
                        { text: 'Data is updated hourly from the official NATS PIB. However, this report uses an unofficial open-data mirror. For flight-critical decisions, always verify against the official NATS AIS PIB (pibs.nats.aero) or the Drone Assist app.', options: { color: C.textPrimary, fontSize: 10 } }
                    ], { x: 0.7, y: srcY + 0.85, w: 11.8, h: 0.6, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.2 });
                    srcY += 1.7;
                }

                if (airspaceFeatures.length > 0) {
                    slide.addText('FRZ, Restricted & Danger Areas', { x: 0.5, y: srcY, w: 8, h: 0.3, fontSize: 14, bold: true, color: C.accent, fontFace: 'Arial' });
                    srcY += 0.35;
                    slide.addShape('roundRect', { x: 0.5, y: srcY, w: 12.2, h: 2.15, fill: { color: C.surface }, rectRadius: 0.06, line: { color: C.border, width: 0.3 } });
                    slide.addText([
                        { text: 'Source: ', options: { bold: true, color: C.textMuted, fontSize: 10 } },
                        { text: 'UK Aeronautical Information Publication (AIP) ENR 5.1 and NATS UAS airspace boundaries. Data includes Flight Restriction Zones (FRZ), Prohibited (EG P), Restricted (EG R), and Danger (EG D) areas.', options: { color: C.textPrimary, fontSize: 10 } }
                    ], { x: 0.7, y: srcY + 0.08, w: 11.8, h: 0.45, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.2 });
                    slide.addText([
                        { text: 'Authority: ', options: { bold: true, color: C.textMuted, fontSize: 10 } },
                        { text: 'Airspace boundaries are defined by the UK CAA and published through the AIP, managed by NATS Aeronautical Information Service. FRZs are mandated under the Air Navigation Order (ANO) Article 94A for drone operations near aerodromes.', options: { color: C.textPrimary, fontSize: 10 } }
                    ], { x: 0.7, y: srcY + 0.55, w: 11.8, h: 0.55, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.2 });
                    slide.addText([
                        { text: 'Reliability: ', options: { bold: true, color: C.textMuted, fontSize: 10 } },
                        { text: 'These are official published boundaries and are considered authoritative for planning purposes. However, Danger and Restricted areas may be temporarily activated or deactivated — always cross-reference with current NOTAMs. This data does not include temporary airspace reservations (RA(T)) which require a separate check.', options: { color: C.textPrimary, fontSize: 10 } }
                    ], { x: 0.7, y: srcY + 1.15, w: 11.8, h: 0.85, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.2 });
                    srcY += 2.3;
                }

                slide.addText('This report is for planning purposes only and does not replace the obligation to conduct a formal pre-flight assessment using official sources.', { x: 0.5, y: Math.max(srcY + 0.15, 6.5), w: 12, h: 0.4, fontSize: 9, bold: true, color: C.textMuted, fontFace: 'Arial', italic: true });
            }

            // --- Final Slide: Data Sources & Model Explainer ---
            var info = MODEL_EXPLAINERS[lastModel] || MODEL_EXPLAINERS['auto'];
            slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
            slide.addText('Data Sources & Forecast Model', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

            slide.addText([
                { text: 'Model: ', options: { fontSize: 12, color: C.textMuted, fontFace: 'Arial' } },
                { text: info.name, options: { fontSize: 12, color: C.textPrimary, fontFace: 'Arial', bold: true } }
            ], { x: 0.5, y: 0.85, w: 12, h: 0.3 });
            slide.addText(info.fullName, { x: 0.5, y: 1.15, w: 12, h: 0.3, fontSize: 10, color: C.textMuted, fontFace: 'Arial' });
            slide.addText('Resolution: ' + info.resolution + '   |   Provider: ' + info.provider, { x: 0.5, y: 1.45, w: 12, h: 0.3, fontSize: 10, color: C.textMuted, fontFace: 'Arial' });

            slide.addShape('roundRect', { x: 0.5, y: 1.9, w: 12.2, h: 1.2, fill: { color: C.surface }, rectRadius: 0.06, line: { color: C.border, width: 0.3 } });
            slide.addText(info.equiv.replace(/<\/?strong>/g, ''), { x: 0.7, y: 2.0, w: 11.8, h: 1.0, fontSize: 11, color: C.textPrimary, fontFace: 'Arial', valign: 'top', lineSpacingMultiple: 1.3 });

            var equivHeader = [
                { text: 'Service', options: headerOpts },
                { text: 'Primary Model', options: headerOpts },
                { text: 'AirPlot Equivalent', options: headerOpts },
                { text: 'Match', options: headerOpts }
            ];
            var equivRows = [equivHeader,
                [{ text: 'BBC Weather', options: cellOpts }, { text: 'ECMWF IFS (via MeteoGroup/DTN)', options: cellOpts }, { text: 'ECMWF IFS', options: cellOpts }, { text: 'Direct equivalent', options: { fill: { color: C.surface }, color: '66BB6A', fontSize: 10, fontFace: 'Arial' } }],
                [{ text: 'Met Office', options: cellOpts }, { text: 'Met Office UKV (2 km) + Global', options: cellOpts }, { text: 'UK Met Office', options: cellOpts }, { text: 'Direct equivalent', options: { fill: { color: C.surface }, color: '66BB6A', fontSize: 10, fontFace: 'Arial' } }],
                [{ text: 'Windy.com', options: cellOpts }, { text: 'ECMWF IFS (default) / GFS / ICON', options: cellOpts }, { text: 'ECMWF IFS / GFS', options: cellOpts }, { text: 'Direct equivalent', options: { fill: { color: C.surface }, color: '66BB6A', fontSize: 10, fontFace: 'Arial' } }]
            ];
            slide.addTable(equivRows, { x: 0.3, y: 3.35, w: 12.6, colW: [2.5, 4.2, 3.2, 2.7], border: border, rowH: 0.42 });

            slide.addText('Forecast data: Open-Meteo (open-meteo.com) CC BY 4.0. METAR/TAF: Aviation Weather Center (aviationweather.gov). NOTAMs: NATS AIS via UK NOTAM Archive. Airspace: UK AIP / NATS.', { x: 0.5, y: 5.6, w: 12, h: 0.5, fontSize: 9, color: C.textMuted, fontFace: 'Arial', lineSpacingMultiple: 1.3 });

            const fileName = 'Weather_Report_' + new Date().toISOString().slice(0, 10) + '.pptx';
            await pptx.writeFile({ fileName: fileName });

        } catch (err) {
            console.error('PPTX export failed:', err);
            alert('Failed to export PowerPoint: ' + (err.message || 'Unknown error'));
        } finally {
            btn.disabled = false;
            btn.querySelector('span').textContent = origText;
        }
    }

    async function exportWeatherPdf() {
        if (!lastReportData || !selectedPoint) {
            alert('Fetch weather data first before exporting.');
            return;
        }
        const btn = document.getElementById('weatherExportPdfBtn');
        const origText = btn.querySelector('span').textContent;
        btn.disabled = true;
        btn.querySelector('span').textContent = 'Exporting…';

        try {
            const lightToggle = document.getElementById('weatherLightThemeToggle');
            PdfTheme.setLight(lightToggle && lightToggle.checked);

            const logo = await PdfTheme.loadLogo();
            const c = PdfTheme.colors();
            const ts = PdfTheme.tableStyles();

            const data = lastReportData;
            const suitability = deriveSuitability(data);
            const suitColor = suitabilityColor(suitability.level);
            const modelLabel = MODEL_LABELS[lastModel] || lastModel;
            const locLabel = selectedPoint.lat.toFixed(5) + ', ' + selectedPoint.lng.toFixed(5);
            const timeLabel = lastDisplayTime ? new Date(lastDisplayTime).toLocaleString() : new Date().toLocaleString();

            const mapContainer = document.getElementById('weatherMap') || document.getElementById('map');
            const mapImg = await PdfTheme.captureSquareMap(mapContainer);

            const doc = PdfTheme.createDoc();

            // Page 1: Title + Map + Info Panel
            PdfTheme.addHeader(doc, 'Flight Weather Report', true);
            doc.addImage(mapImg, 'PNG', 10, 25, 120, 120);
            var suitRgb = suitColor.bg === '4CAF50' ? [102,187,106] : (suitColor.bg === 'FF9800' ? [255,183,77] : [239,83,80]);
            PdfTheme.addInfoPanel(doc, 140, 25, 147, [
                { label: 'LOCATION', value: locLabel, divider: true },
                { label: 'DATE & TIME', value: timeLabel, divider: true },
                { label: 'WEATHER MODEL', value: modelLabel, divider: true },
                { label: 'FLIGHT SUITABILITY', value: suitability.text, color: suitRgb, bold: true, fontSize: 11, divider: true },
                { label: 'COORDINATES', value: selectedPoint.lat.toFixed(6) + '°N   ' + Math.abs(selectedPoint.lng).toFixed(6) + '°' + (selectedPoint.lng >= 0 ? 'E' : 'W'), divider: true },
                { label: 'GENERATED', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '  at  ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }
            ]);

            // Page 2: Weather Summary
            PdfTheme.newPage(doc);
            PdfTheme.addHeader(doc, 'Weather Summary');

            var windDir = data.wind_direction_10m != null ? Math.round(data.wind_direction_10m) + '° (' + directionToCardinal(data.wind_direction_10m) + ')' : '—';
            var w10 = data.wind_speed_10m != null ? Math.round(data.wind_speed_10m) + ' km/h' : '—';
            var g10 = data.wind_gusts_10m != null ? Math.round(data.wind_gusts_10m) + ' km/h' : '—';
            var w120 = data.wind_speed_120m != null ? Math.round(data.wind_speed_120m) + ' km/h' : '—';
            var g120 = data.wind_gusts_10m != null ? Math.round(data.wind_gusts_10m * GUST_120M_MULTIPLIER) + ' km/h (est.)' : '—';
            var visStr = data.visibility != null ? formatVisibility(data.visibility) : '—';
            var cloudStr = data.cloud_cover != null ? Math.round(data.cloud_cover) + '%' + (data.cloud_cover_low != null ? ' (low: ' + Math.round(data.cloud_cover_low) + '%)' : '') : '—';
            var precipStr = data.precipitation != null ? (data.precipitation > 0 ? (Math.round(data.precipitation * 10) / 10) + ' mm' : 'None') : '—';
            var tempStr = data.temperature_2m != null ? Math.round(data.temperature_2m) + ' °C' : '—';

            doc.autoTable({
                startY: 18,
                head: [['Parameter', 'Value']],
                body: [
                    ['Suitability', suitability.text],
                    ['Wind Direction', windDir],
                    ['Wind 10m (sustained)', w10],
                    ['Gusts 10m', g10],
                    ['Wind 120m (sustained)', w120],
                    ['Gusts 120m', g120],
                    ['Visibility', visStr],
                    ['Cloud Cover', cloudStr],
                    ['Precipitation', precipStr],
                    ['Temperature', tempStr]
                ],
                columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } },
                ...ts
            });

            // Page 3: 12-Hour Forecast (limited to 12 rows from startIdx, matching PPTX)
            if (lastHourlySlice && lastHourlySlice.hourly) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, '12-Hour Forecast');

                var hourly = lastHourlySlice.hourly;
                var startIdx = lastHourlySlice.startIdx || 0;
                var forecastCount = Math.min(12, (hourly.time ? hourly.time.length : 0) - startIdx);
                var fRows = [];
                for (var hi = 0; hi < forecastCount; hi++) {
                    var idx = startIdx + hi;
                    var tDate = new Date(hourly.time[idx]);
                    var timeStr = String(tDate.getHours()).padStart(2, '0') + ':' + String(tDate.getMinutes()).padStart(2, '0');
                    var hw10 = hourly.wind_speed_10m ? hourly.wind_speed_10m[idx] : null;
                    var hg10 = hourly.wind_gusts_10m ? hourly.wind_gusts_10m[idx] : null;
                    var hw120 = hourly.wind_speed_120m ? hourly.wind_speed_120m[idx] : null;
                    var hg120Est = hg10 != null ? Math.round(hg10 * GUST_120M_MULTIPLIER) : null;
                    var hvis = hourly.visibility ? hourly.visibility[idx] : null;
                    var hcloud = hourly.cloud_cover ? hourly.cloud_cover[idx] : null;
                    var hp = hourly.precipitation ? hourly.precipitation[idx] : null;
                    var ht = hourly.temperature_2m ? hourly.temperature_2m[idx] : null;
                    fRows.push([
                        timeStr,
                        hw10 != null ? Math.round(hw10) + '' : '—',
                        hg10 != null ? Math.round(hg10) + '' : '—',
                        hw120 != null ? Math.round(hw120) + '' : '—',
                        hg120Est != null ? hg120Est + '' : '—',
                        hvis != null ? formatVisibility(hvis) : '—',
                        hcloud != null ? Math.round(hcloud) + '%' : '—',
                        hp != null ? (Math.round(hp * 10) / 10) + ' mm' : '0',
                        ht != null ? Math.round(ht) + '°C' : '—'
                    ]);
                }
                doc.autoTable({
                    startY: 18,
                    head: [['Time', 'Wind 10m', 'Gusts 10m', 'Wind 120m', 'Gusts 120m', 'Vis', 'Cloud', 'Precip', 'Temp']],
                    body: fRows,
                    ...ts,
                    styles: { ...ts.styles, fontSize: 6.5 },
                    headStyles: { ...ts.headStyles, fontSize: 6.5 }
                });
                doc.setFontSize(7);
                doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                doc.text('All wind speeds in km/h', 10, doc.lastAutoTable.finalY + 5);
            }

            // Page 4: METAR / TAF
            if (lastAviationData && lastAviationData.nearby && lastAviationData.nearby.length > 0) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'METAR / TAF — Aerodromes within 50 NM');

                var metarByIcao = {};
                (lastAviationData.metars || []).forEach(function (m) {
                    var icao = (m.icaoId || m.stationId || m.icao || '').toUpperCase();
                    if (icao) metarByIcao[icao] = m;
                });
                var tafByIcao = {};
                (lastAviationData.tafs || []).forEach(function (t) {
                    var icao = (t.icaoId || t.stationId || t.icao || '').toUpperCase();
                    if (icao) tafByIcao[icao] = t;
                });

                var yPos = 18;
                lastAviationData.nearby.forEach(function (s) {
                    var metar = metarByIcao[s.icao];
                    var taf = tafByIcao[s.icao];
                    var rawMetar = metar && (metar.rawOb || metar.raw || metar.report);
                    var rawTaf = taf && (taf.rawTAF || taf.raw || taf.report);

                    var decodedMetar = rawMetar ? decodeMetar(metar) : null;
                    var decodedTaf = rawTaf ? decodeTaf(taf) : null;
                    var metarStr = rawMetar ? 'METAR: ' + (decodedMetar || rawMetar) : '';
                    var tafStr = rawTaf ? 'TAF: ' + (decodedTaf || rawTaf) : '';

                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(6.5);
                    var metarLines = metarStr ? doc.splitTextToSize(metarStr, 260) : [];
                    var tafLines = tafStr ? doc.splitTextToSize(tafStr, 260) : [];
                    var metarBoxH = metarLines.length > 0 ? metarLines.length * 3.2 + 4 : 0;
                    var tafBoxH = tafLines.length > 0 ? tafLines.length * 3.2 + 4 : 0;
                    var blockH = 8 + metarBoxH + tafBoxH + 3;

                    if (yPos + blockH > 195) {
                        PdfTheme.newPage(doc);
                        PdfTheme.addHeader(doc, 'METAR / TAF (continued)');
                        yPos = 18;
                    }

                    var nameText = (s.name || s.icao);
                    var icaoText = '  ' + s.icao + '  (' + s.distNm.toFixed(1) + ' NM)';
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(10);
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    doc.text(nameText, 10, yPos);
                    var nameWidth = doc.getTextWidth(nameText);
                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(8);
                    doc.setTextColor(c.accent[0], c.accent[1], c.accent[2]);
                    doc.text(icaoText, 10 + nameWidth + 1, yPos);
                    yPos += 6;

                    if (metarLines.length > 0) {
                        doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
                        doc.roundedRect(12, yPos - 3, 273, metarBoxH, 1, 1, 'F');
                        doc.setFont('helvetica', 'normal');
                        doc.setFontSize(6.5);
                        doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                        doc.text(metarLines, 14, yPos + 1);
                        yPos += metarBoxH + 2;
                    }
                    if (tafLines.length > 0) {
                        if (yPos + tafBoxH > 195) {
                            PdfTheme.newPage(doc);
                            PdfTheme.addHeader(doc, 'METAR / TAF (continued)');
                            yPos = 18;
                        }
                        doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
                        doc.roundedRect(12, yPos - 3, 273, tafBoxH, 1, 1, 'F');
                        doc.setFont('helvetica', 'normal');
                        doc.setFontSize(6.5);
                        doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                        doc.text(tafLines, 14, yPos + 1);
                        yPos += tafBoxH + 2;
                    }
                    yPos += 4;
                });
            }

            // Page 5+: NOTAMs & Airspace (with map visualisation matching PPTX)
            var notams = lastNotamData || await fetchNearbyNotams(selectedPoint.lat, selectedPoint.lng, airspaceSearchRadiusKm);
            var airspace = lastAirspaceData || await fetchNearbyAirspace(selectedPoint.lat, selectedPoint.lng, airspaceSearchRadiusKm);

            if (notams.length > 0 || airspace.length > 0) {
                var catMapColorsHex = { FRZ: '#9333ea', Prohibited: '#991b1b', Restricted: '#dc2626', Danger: '#ca8a04' };
                var tempLayers = [];
                var origView = { center: map.getCenter(), zoom: map.getZoom() };

                airspace.forEach(function (af) {
                    if (af.geometry) {
                        var layer = L.geoJSON(af.geometry, {
                            style: { color: catMapColorsHex[af.category] || '#dc2626', weight: 2, fillColor: catMapColorsHex[af.category] || '#dc2626', fillOpacity: 0.15 }
                        });
                        layer.addTo(map);
                        tempLayers.push(layer);
                    }
                });
                notams.forEach(function (n) {
                    if (n.radiusNm > 0 && n.radiusNm < 999) {
                        var circle = L.circle([n.lat, n.lng], { radius: n.radiusNm * 1852, color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.1 });
                        circle.addTo(map);
                        tempLayers.push(circle);
                    }
                });

                var radiusDeg = airspaceSearchRadiusKm / 111.32;
                map.fitBounds([
                    [selectedPoint.lat - radiusDeg, selectedPoint.lng - radiusDeg * 1.5],
                    [selectedPoint.lat + radiusDeg, selectedPoint.lng + radiusDeg * 1.5]
                ], { animate: false, padding: [10, 10] });
                await new Promise(function (r) { setTimeout(r, 600); });

                var airspaceMapImg = await PdfTheme.captureSquareMap(mapContainer);

                tempLayers.forEach(function (l) { map.removeLayer(l); });
                map.setView(origView.center, origView.zoom, { animate: false });

                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Airspace & NOTAMs — ' + airspaceSearchRadiusKm + ' km radius');
                doc.addImage(airspaceMapImg, 'PNG', 10, 16, 120, 120);

                var legX = 140;
                var legY = 20;
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(11);
                doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                doc.text('Legend', legX, legY);
                legY += 6;

                var legendItems = [
                    { rgb: [147, 51, 234], label: 'FRZ / Aerodrome' },
                    { rgb: [153, 27, 27], label: 'Prohibited' },
                    { rgb: [220, 38, 38], label: 'Restricted / NOTAM' },
                    { rgb: [202, 138, 4], label: 'Danger Area' }
                ];
                legendItems.forEach(function (item) {
                    doc.setFillColor(item.rgb[0], item.rgb[1], item.rgb[2]);
                    doc.rect(legX, legY - 2.5, 5, 4, 'F');
                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(9);
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    doc.text(item.label, legX + 8, legY + 0.5);
                    legY += 7;
                });

                legY += 4;
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(10);
                doc.setTextColor(c.accent[0], c.accent[1], c.accent[2]);
                doc.text(notams.length + ' NOTAM' + (notams.length !== 1 ? 's' : '') + ', ' + airspace.length + ' airspace zone' + (airspace.length !== 1 ? 's' : ''), legX, legY);
                legY += 6;
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(7.5);
                doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                doc.text('Search radius: ' + airspaceSearchRadiusKm + ' km from ' + selectedPoint.lat.toFixed(5) + ', ' + selectedPoint.lng.toFixed(5), legX, legY);
            }

            if (notams.length > 0) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'NOTAMs within ' + airspaceSearchRadiusKm + ' km (' + notams.length + ')');
                var nBody = notams.map(function (n) {
                    var dist = haversineKm(selectedPoint.lat, selectedPoint.lng, n.lat, n.lng).toFixed(1) + ' km';
                    var validStart = formatNotamDate(n.startValidity);
                    var validEnd = formatNotamDate(n.endValidity);
                    var desc = (n.text || '').replace(/\s+/g, ' ');
                    if (desc.length > 150) desc = desc.slice(0, 147) + '…';
                    return [n.id || '—', dist, n.radiusNm > 0 && n.radiusNm < 999 ? n.radiusNm + ' NM' : '—', (validStart || '?') + ' – ' + (validEnd || '?'), desc];
                });
                doc.autoTable({
                    startY: 18,
                    head: [['NOTAM ID', 'Distance', 'Radius', 'Validity', 'Description']],
                    body: nBody,
                    columnStyles: { 4: { cellWidth: 80 } },
                    ...ts
                });
            }

            if (airspace.length > 0) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Airspace Restrictions within ' + airspaceSearchRadiusKm + ' km (' + airspace.length + ')');
                var catRgb = { FRZ: [147,51,234], Prohibited: [153,27,27], Restricted: [220,38,38], Danger: [202,138,4] };
                var aBody = airspace.map(function (a) {
                    return [a.category, a.designator, a.name, a.lower, a.upper];
                });
                doc.autoTable({
                    startY: 18,
                    head: [['Type', 'Designator', 'Name', 'Lower', 'Upper']],
                    body: aBody,
                    ...ts,
                    didParseCell: function (data) {
                        if (data.section === 'body' && data.column.index === 0) {
                            var rgb = catRgb[data.cell.raw];
                            if (rgb) data.cell.styles.textColor = rgb;
                            data.cell.styles.fontStyle = 'bold';
                        }
                    }
                });
            }

            // Airspace & NOTAM Data Sources explainer
            if (notams.length > 0 || airspace.length > 0) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Airspace & NOTAM Data Sources');

                var srcY = 18;

                if (notams.length > 0) {
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(12);
                    doc.setTextColor(c.accent[0], c.accent[1], c.accent[2]);
                    doc.text('NOTAMs', 10, srcY);
                    srcY += 4;

                    doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
                    doc.roundedRect(10, srcY, 277, 28, 1, 1, 'F');
                    doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
                    doc.setLineWidth(0.2);
                    doc.roundedRect(10, srcY, 277, 28, 1, 1, 'S');

                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(8);
                    doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                    doc.text('Source:', 14, srcY + 5);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    doc.text('UK NOTAM Archive (jonty.github.io/uk-notam-archive), mirroring the NATS AIS Contingency Pre-flight Information Bulletin (PIB).', 30, srcY + 5);

                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                    doc.text('Authority:', 14, srcY + 12);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    var authLines = doc.splitTextToSize('NOTAMs are issued by NATS (National Air Traffic Services) on behalf of the UK Civil Aviation Authority (CAA). They are the official mechanism for communicating temporary airspace restrictions, hazards, and aeronautical changes.', 250);
                    doc.text(authLines, 30, srcY + 12);

                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                    doc.text('Reliability:', 14, srcY + 21);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    var relLines = doc.splitTextToSize('Data is updated hourly from the official NATS PIB. However, this report uses an unofficial open-data mirror. For flight-critical decisions, always verify against the official NATS AIS PIB (pibs.nats.aero) or the Drone Assist app.', 250);
                    doc.text(relLines, 30, srcY + 21);
                    srcY += 33;
                }

                if (airspace.length > 0) {
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(12);
                    doc.setTextColor(c.accent[0], c.accent[1], c.accent[2]);
                    doc.text('FRZ, Restricted & Danger Areas', 10, srcY);
                    srcY += 4;

                    doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
                    doc.roundedRect(10, srcY, 277, 35, 1, 1, 'F');
                    doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
                    doc.setLineWidth(0.2);
                    doc.roundedRect(10, srcY, 277, 35, 1, 1, 'S');

                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(8);
                    doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                    doc.text('Source:', 14, srcY + 5);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    var srcLines = doc.splitTextToSize('UK Aeronautical Information Publication (AIP) ENR 5.1 and NATS UAS airspace boundaries. Data includes Flight Restriction Zones (FRZ), Prohibited (EG P), Restricted (EG R), and Danger (EG D) areas.', 250);
                    doc.text(srcLines, 30, srcY + 5);

                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                    doc.text('Authority:', 14, srcY + 14);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    var authLines2 = doc.splitTextToSize('Airspace boundaries are defined by the UK CAA and published through the AIP, managed by NATS Aeronautical Information Service. FRZs are mandated under the Air Navigation Order (ANO) Article 94A for drone operations near aerodromes.', 250);
                    doc.text(authLines2, 30, srcY + 14);

                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                    doc.text('Reliability:', 14, srcY + 24);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                    var relLines2 = doc.splitTextToSize('These are official published boundaries and are considered authoritative for planning purposes. However, Danger and Restricted areas may be temporarily activated or deactivated — always cross-reference with current NOTAMs. This data does not include temporary airspace reservations (RA(T)) which require a separate check.', 250);
                    doc.text(relLines2, 30, srcY + 24);
                    srcY += 40;
                }

                doc.setFont('helvetica', 'bolditalic');
                doc.setFontSize(7.5);
                doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                doc.text('This report is for planning purposes only and does not replace the obligation to conduct a formal pre-flight assessment using official sources.', 10, Math.min(srcY + 5, 195));
            }

            // Final Page: Data Sources
            var info = MODEL_EXPLAINERS[lastModel] || MODEL_EXPLAINERS['auto'];
            PdfTheme.newPage(doc);
            PdfTheme.addHeader(doc, 'Data Sources & Forecast Model');

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(c.text[0], c.text[1], c.text[2]);
            doc.text('Model: ' + info.name, 10, 20);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
            doc.text(info.fullName, 10, 26);
            doc.text('Resolution: ' + info.resolution + '   |   Provider: ' + info.provider, 10, 31);

            doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
            doc.roundedRect(10, 35, 277, 18, 1, 1, 'F');
            doc.setFontSize(7.5);
            doc.setTextColor(c.text[0], c.text[1], c.text[2]);
            var equivLines = doc.splitTextToSize(info.equiv.replace(/<\/?strong>/g, ''), 270);
            doc.text(equivLines, 14, 40);

            doc.autoTable({
                startY: 58,
                head: [['Service', 'Primary Model', 'AirPlot Equivalent', 'Match']],
                body: [
                    ['BBC Weather', 'ECMWF IFS (via MeteoGroup/DTN)', 'ECMWF IFS', 'Direct equivalent'],
                    ['Met Office', 'Met Office UKV (2 km) + Global', 'UK Met Office', 'Direct equivalent'],
                    ['Windy.com', 'ECMWF IFS (default) / GFS / ICON', 'ECMWF IFS / GFS', 'Direct equivalent']
                ],
                ...ts,
                didParseCell: function (data) {
                    if (data.section === 'body' && data.column.index === 3) {
                        data.cell.styles.textColor = [102, 187, 106];
                    }
                }
            });

            doc.setFontSize(6.5);
            doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
            doc.text('Forecast data: Open-Meteo (open-meteo.com) CC BY 4.0. METAR/TAF: Aviation Weather Center. NOTAMs: NATS AIS via UK NOTAM Archive. Airspace: UK AIP / NATS.', 10, doc.lastAutoTable.finalY + 8);
            doc.text('This report is for planning purposes only and does not replace the obligation to conduct a formal pre-flight assessment using official sources.', 10, doc.lastAutoTable.finalY + 13);

            PdfTheme.addAllFooters(doc);

            doc.save('Weather_Report_' + new Date().toISOString().slice(0, 10) + '.pdf');

        } catch (err) {
            console.error('PDF export failed:', err);
            alert('Failed to export PDF: ' + (err.message || 'Unknown error'));
        } finally {
            btn.disabled = false;
            btn.querySelector('span').textContent = origText;
        }
    }

    // ---- Report panel ----
    function showReport() {
        document.getElementById('weatherReport').classList.remove('hidden');
    }

    function hideReport() {
        document.getElementById('weatherReport').classList.add('hidden');
    }

    // ---- Context menu (right-click) ----
    function showWeatherContextMenu(e) {
        const menuEl = document.getElementById('weatherContextMenu');
        if (!menuEl) return;
        contextMenuLatLng = e.latlng;
        menuEl.classList.remove('hidden');
        const ev = e.originalEvent;
        const x = ev.clientX;
        const y = ev.clientY;
        const menuW = menuEl.offsetWidth;
        const menuH = menuEl.offsetHeight;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        menuEl.style.left = (x + menuW > winW ? winW - menuW - 4 : x) + 'px';
        menuEl.style.top = (y + menuH > winH ? winH - menuH - 4 : y) + 'px';
    }

    function hideWeatherContextMenu() {
        const menuEl = document.getElementById('weatherContextMenu');
        if (menuEl) menuEl.classList.add('hidden');
        contextMenuLatLng = null;
    }

    function onContextGetWeather() {
        if (!contextMenuLatLng) return;
        setSelectedPoint(contextMenuLatLng.lat, contextMenuLatLng.lng);
        hideWeatherContextMenu();
        fetchWeather();
    }

    // ---- Event handlers ----
    function onTimeModeChange() {
        const useFuture = document.getElementById('weatherTimeFuture').checked;
        document.getElementById('weatherDateTime').classList.toggle('hidden', !useFuture);
        if (useFuture) {
            const input = document.getElementById('weatherDateTime');
            if (!input.value) {
                const now = new Date();
                now.setMinutes(Math.ceil(now.getMinutes() / 60) * 60, 0, 0);
                input.value = now.toISOString().slice(0, 16);
            }
        }
    }

    // ---- Init ----
    function init() {
        initMap();
        setupDateTimeLimits();

        document.getElementById('weatherSelectBtn').addEventListener('click', toggleSelectMode);
        document.getElementById('weatherFetchBtn').addEventListener('click', fetchWeather);
        document.getElementById('weatherReportClose').addEventListener('click', hideReport);
        document.getElementById('weatherExportPptxBtn').addEventListener('click', exportWeatherPptx);
        document.getElementById('weatherExportPdfBtn').addEventListener('click', exportWeatherPdf);

        const weatherLightToggle = document.getElementById('weatherLightThemeToggle');
        if (weatherLightToggle) {
            weatherLightToggle.addEventListener('change', () => {
                const report = document.getElementById('weatherReport');
                if (report) report.classList.toggle('weather-light-theme', weatherLightToggle.checked);
            });
        }

        const weatherStatusEl = document.getElementById('weatherStatus');
        if (weatherStatusEl) {
            weatherStatusEl.innerHTML = WEATHER_STATUS_HTML_DEFAULT;
        }

        try {
            var st = sessionStorage.getItem(AIRSPACE_RADIUS_STORAGE_KEY);
            if (st) airspaceSearchRadiusKm = clampAirspaceRadiusKm(parseInt(st, 10));
        } catch (errSt) { /* ignore */ }
        syncAirspaceRadiusInput();

        var airspaceRefreshBtn = document.getElementById('weatherAirspaceRefreshBtn');
        if (airspaceRefreshBtn) {
            airspaceRefreshBtn.addEventListener('click', function () {
                if (!selectedPoint) return;
                loadAirspaceTab(selectedPoint.lat, selectedPoint.lng, readAirspaceRadiusFromInput());
            });
        }
        var airspaceContentEl = document.getElementById('weatherAirspaceContent');
        if (airspaceContentEl) {
            airspaceContentEl.addEventListener('click', function (e) {
                if (e.target.closest('.weather-airspace-detail-close')) {
                    e.stopPropagation();
                    hideAirspaceDetailPanel();
                    return;
                }
                var trigger = e.target.closest('.weather-airspace-item-trigger');
                if (!trigger || !airspaceContentEl.contains(trigger)) return;
                activateAirspaceListItem(trigger);
            });
            airspaceContentEl.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                var trigger = e.target.closest('.weather-airspace-item-trigger');
                if (!trigger || !airspaceContentEl.contains(trigger)) return;
                e.preventDefault();
                activateAirspaceListItem(trigger);
            });
        }

        const helpToggle = document.getElementById('weatherHelpToggle');
        const helpClose = document.getElementById('weatherHelpClose');
        const sideToolbar = document.getElementById('weatherHelpPanelWrap');
        if (helpToggle && sideToolbar) {
            const infoControl = helpToggle.closest('.leaflet-control-weather-info');
            L.DomEvent.addListener(helpToggle, 'click', () => {
                const isOpen = sideToolbar.classList.toggle('weather-side-open');
                if (infoControl) infoControl.classList.toggle('active', isOpen);
                helpToggle.setAttribute('aria-expanded', isOpen);
            });
            if (helpClose) {
                helpClose.addEventListener('click', () => {
                    sideToolbar.classList.remove('weather-side-open');
                    if (infoControl) infoControl.classList.remove('active');
                    helpToggle.setAttribute('aria-expanded', 'false');
                });
            }
        }

        document.getElementById('weatherTimeNow').addEventListener('change', onTimeModeChange);
        document.getElementById('weatherTimeFuture').addEventListener('change', onTimeModeChange);

        document.getElementById('weatherReport').querySelector('.weather-report-body').addEventListener('click', (e) => {
            if (e.target.classList.contains('weather-report-body') || e.target.closest('.weather-report-body')) {
                e.stopPropagation();
            }
        });

        document.querySelectorAll('.weather-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                const tabName = this.dataset.tab;
                document.querySelectorAll('.weather-tab').forEach(function (t) { t.classList.remove('active'); });
                document.querySelectorAll('.weather-tab-panel').forEach(function (p) { p.classList.remove('active'); });
                this.classList.add('active');
                const panel = document.getElementById('weatherTab' + (tabName.charAt(0).toUpperCase() + tabName.slice(1)));
                if (panel) panel.classList.add('active');
                if (tabName === 'airspace' && airspaceMinimap) {
                    refreshAirspaceMinimapView();
                }
            });
        });

        document.querySelectorAll('.weather-aviation-toggle-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const view = this.dataset.view;
                document.querySelectorAll('.weather-aviation-toggle-btn').forEach(function (b) { b.classList.remove('active'); });
                this.classList.add('active');
                const content = document.getElementById('weatherAviationContent');
                if (content) content.classList.toggle('weather-aviation-raw-mode', view === 'raw');
            });
        });

        const ctxMenu = document.getElementById('weatherContextMenu');
        if (ctxMenu) {
            ctxMenu.addEventListener('click', (e) => {
                const item = e.target.closest('[data-action="get-weather"]');
                if (item) {
                    onContextGetWeather();
                }
            });
            ctxMenu.addEventListener('contextmenu', (e) => e.preventDefault());
        }

        document.addEventListener('mousedown', (e) => {
            if (ctxMenu && !ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
                hideWeatherContextMenu();
            }
        });
        document.addEventListener('touchstart', (e) => {
            if (ctxMenu && !ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
                hideWeatherContextMenu();
            }
        }, { passive: true });

        map.on('click', onMapClick);
        map.on('click', hideWeatherContextMenu);
        setupTouchFallback();

        map.on('contextmenu', (e) => {
            if (e.originalEvent.target.closest('.leaflet-control')) return;
            e.originalEvent.preventDefault();
            e.originalEvent.stopPropagation();
            showWeatherContextMenu(e);
        });
    }

    window.addEventListener('load', init);
})();
