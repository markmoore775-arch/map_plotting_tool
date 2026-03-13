/* ============================================
   FLIGHT WEATHER - Weather check for drone flights
   Map point selection, Open-Meteo API, report display
   ============================================ */

(function () {
    'use strict';

    const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
    const HOURLY_PARAMS = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_120m,wind_direction_120m,visibility,cloud_cover,cloud_cover_low,precipitation,precipitation_probability,temperature_2m';
    const AVIATION_RADIUS_NM = 50;
    const AVIATION_STATIONS_URL = 'assets/aviation-stations.json';
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
    const GUST_120M_MULTIPLIER = 1.3;

    let map;
    let selectedPoint = null;
    let selectedMarker = null;
    let selectMode = false;
    let contextMenuLatLng = null;

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
        document.getElementById('weatherStatus').innerHTML = 'Location selected. Set time and tap <strong>Get Weather</strong>.';
    }

    function clearSelectedPoint() {
        selectedPoint = null;
        if (selectedMarker) {
            map.removeLayer(selectedMarker);
            selectedMarker = null;
        }
        document.getElementById('weatherFetchBtn').disabled = true;
        document.getElementById('weatherStatus').innerHTML = 'Tap <strong>Select Location</strong>, then tap the map to choose a point. Set time and tap <strong>Get Weather</strong>.';
    }

    function onMapClick(e) {
        if (selectMode) {
            setSelectedPoint(e.latlng.lat, e.latlng.lng);
            selectMode = false;
            document.getElementById('weatherSelectBtn').classList.remove('active');
        }
    }

    // Touch/pointer fallback: when dragging is disabled in select mode, use pointer events
    // (more reliable than click on touch devices)
    function setupTouchFallback() {
        const container = map.getContainer();
        let pointerStartPos = null;

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
                    const rect = container.getBoundingClientRect();
                    const pt = L.point(e.clientX - rect.left, e.clientY - rect.top);
                    const latLng = map.containerPointToLatLng(pt);
                    setSelectedPoint(latLng.lat, latLng.lng);
                    selectMode = false;
                    document.getElementById('weatherSelectBtn').classList.remove('active');
                    map.dragging.enable();
                    container.style.touchAction = '';
                }
                pointerStartPos = null;
            }
        }

        container.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
        container.addEventListener('pointerup', onPointerUp, { passive: true, capture: true });
    }

    function toggleSelectMode() {
        selectMode = !selectMode;
        document.getElementById('weatherSelectBtn').classList.toggle('active', selectMode);
        const container = map.getContainer();
        if (selectMode) {
            map.dragging.disable();
            container.style.touchAction = 'manipulation';
        } else {
            map.dragging.enable();
            container.style.touchAction = '';
        }
        if (!selectMode && !selectedPoint) {
            document.getElementById('weatherStatus').innerHTML = 'Tap <strong>Select Location</strong>, then tap the map to choose a point. Set time and tap <strong>Get Weather</strong>.';
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

    async function fetchAviationJson(url) {
        const attempts = [
            { name: 'direct', url: url, kind: 'json' },
            { name: 'corsproxy', url: CORS_PROXY + encodeURIComponent(url), kind: 'json' },
            { name: 'jina', url: JINA_PROXY_PREFIX + url.replace(/^https?:\/\//i, ''), kind: 'jina-text' }
        ];
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
            fetchAviationJson(metarUrl),
            fetchAviationJson(tafUrl)
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

        renderAviationSection(aviationData || { nearby: [], metars: [], tafs: [], error: null });
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

    function formatVisib(v) {
        if (v == null) return '—';
        if (typeof v === 'string') {
            if (v === '6+' || v === 'P6SM') return '6 statute miles or more';
            if (v === '9999' || v === '10+') return '10 km or more';
            if (v.endsWith('SM')) return v.slice(0, -2) + ' statute miles';
            return v;
        }
        if (typeof v === 'number') {
            if (v >= 10) return v + ' km';
            return v + ' statute miles';
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
        document.getElementById('weatherBackBtn').addEventListener('click', () => {
            window.location.href = 'index.html';
        });
        document.getElementById('weatherReportClose').addEventListener('click', hideReport);

        const weatherLightToggle = document.getElementById('weatherLightThemeToggle');
        if (weatherLightToggle) {
            weatherLightToggle.addEventListener('change', () => {
                const report = document.getElementById('weatherReport');
                if (report) report.classList.toggle('weather-light-theme', weatherLightToggle.checked);
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
