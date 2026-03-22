/**
 * Flight Notes — form serialization, GPS (HTTPS only), mailto + clipboard fallback, PDF via PdfTheme.
 */
(function () {
    'use strict';

    /** Draft form fields — local only, same origin; cleared when user clears the form. */
    var FN_DRAFT_STORAGE_KEY = 'airplotFlightNotesDraft_v1';
    var FN_DRAFT_FIELD_IDS = [
        'fnDate',
        'fnTime',
        'fnLocation',
        'fnReference',
        'fnDeconflictions',
        'fnRp1',
        'fnRp2',
        'fnUas',
        'fnBattery1',
        'fnBattery1Time',
        'fnBattery2',
        'fnBattery2Time',
        'fnBattery3',
        'fnBattery3Time',
        'fnBattery4',
        'fnBattery4Time',
        'fnWeather',
        'fnNotes'
    ];

    var fnDraftSaveTimer = null;

    function saveFlightNotesDraft() {
        try {
            var fields = {};
            for (var i = 0; i < FN_DRAFT_FIELD_IDS.length; i++) {
                var id = FN_DRAFT_FIELD_IDS[i];
                var el = document.getElementById(id);
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                    fields[id] = el.value || '';
                }
            }
            localStorage.setItem(FN_DRAFT_STORAGE_KEY, JSON.stringify({ v: 1, fields: fields }));
        } catch (e) {}
    }

    function scheduleFlightNotesDraftSave() {
        if (fnDraftSaveTimer) clearTimeout(fnDraftSaveTimer);
        fnDraftSaveTimer = setTimeout(function () {
            fnDraftSaveTimer = null;
            saveFlightNotesDraft();
        }, 250);
    }

    function loadFlightNotesDraft() {
        try {
            var raw = localStorage.getItem(FN_DRAFT_STORAGE_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            if (!data || data.v !== 1 || !data.fields) return;
            var id;
            for (id in data.fields) {
                if (!Object.prototype.hasOwnProperty.call(data.fields, id)) continue;
                var el = document.getElementById(id);
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                    el.value = data.fields[id];
                }
            }
        } catch (e) {}
    }

    function clearFlightNotesDraftStorage() {
        try {
            localStorage.removeItem(FN_DRAFT_STORAGE_KEY);
        } catch (e) {}
    }

    var MAILTO_BODY_MAX = 1800;
    var GPS_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

    var miniMap = null;

    /** Grow/shrink Conditions textarea to fit content (fetch + typing); cap height so very long notes scroll inside. */
    function autoResizeConditionsTextarea() {
        var ta = document.getElementById('fnWeather');
        if (!ta) return;
        ta.style.height = 'auto';
        var cap = Math.min(window.innerHeight * 0.85, 1400);
        var h = ta.scrollHeight;
        if (h > cap) {
            ta.style.height = cap + 'px';
            ta.style.overflowY = 'auto';
        } else {
            ta.style.height = h + 'px';
            ta.style.overflowY = 'hidden';
        }
    }

    function trimVal(id) {
        var el = document.getElementById(id);
        if (!el) return '';
        return String(el.value || '').trim();
    }

    function dash(s) {
        return s ? s : '—';
    }

    /** Same map centre as Flight Notes mini-map — for email (mailto is plain text only; no embedded images). */
    function openStreetMapLink(lat, lng) {
        return (
            'https://www.openstreetmap.org/?mlat=' +
            encodeURIComponent(lat) +
            '&mlon=' +
            encodeURIComponent(lng) +
            '#map=16/' +
            lat +
            '/' +
            lng
        );
    }

    /**
     * Plain-text block for email body and PDF source of truth.
     */
    function buildNotesPlainText() {
        var lines = [];
        lines.push('AirPlot — Flight Notes');
        lines.push('');

        lines.push('Date: ' + dash(trimVal('fnDate')));
        lines.push('Time: ' + dash(trimVal('fnTime')));
        lines.push('Location: ' + dash(trimVal('fnLocation')));
        var llPlain = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (llPlain) {
            lines.push('Map (OpenStreetMap): ' + openStreetMapLink(llPlain.lat, llPlain.lng));
        }
        lines.push('Reference: ' + dash(trimVal('fnReference')));
        lines.push('Deconflictions: ' + dash(trimVal('fnDeconflictions')));
        lines.push('RP 1: ' + dash(trimVal('fnRp1')));
        lines.push('RP 2: ' + dash(trimVal('fnRp2')));
        lines.push('UAS: ' + dash(trimVal('fnUas')));

        lines.push('Battery 1: ' + dash(trimVal('fnBattery1')));
        lines.push('Battery 1 time: ' + dash(trimVal('fnBattery1Time')));
        lines.push('Battery 2: ' + dash(trimVal('fnBattery2')));
        lines.push('Battery 2 time: ' + dash(trimVal('fnBattery2Time')));
        lines.push('Battery 3: ' + dash(trimVal('fnBattery3')));
        lines.push('Battery 3 time: ' + dash(trimVal('fnBattery3Time')));
        lines.push('Battery 4: ' + dash(trimVal('fnBattery4')));
        lines.push('Battery 4 time: ' + dash(trimVal('fnBattery4Time')));

        lines.push('Weather: ' + dash(trimVal('fnWeather').replace(/\n/g, ' ')));
        lines.push('');
        lines.push('Notes:');
        lines.push(trimVal('fnNotes') || '—');

        return lines.join('\n');
    }

    function tableRowsForPdf() {
        var w = trimVal('fnWeather');
        var llPdf = parseLatLngFromLocationString(trimVal('fnLocation'));
        var mapLinkRow = llPdf
            ? ['Map (OpenStreetMap)', openStreetMapLink(llPdf.lat, llPdf.lng)]
            : ['Map (OpenStreetMap)', '—'];
        return [
            ['Date', dash(trimVal('fnDate'))],
            ['Time', dash(trimVal('fnTime'))],
            ['Location', dash(trimVal('fnLocation'))],
            mapLinkRow,
            ['Reference', dash(trimVal('fnReference'))],
            ['Deconflictions', dash(trimVal('fnDeconflictions'))],
            ['RP 1', dash(trimVal('fnRp1'))],
            ['RP 2', dash(trimVal('fnRp2'))],
            ['UAS', dash(trimVal('fnUas'))],
            ['Battery 1', dash(trimVal('fnBattery1'))],
            ['Battery 1 time', dash(trimVal('fnBattery1Time'))],
            ['Battery 2', dash(trimVal('fnBattery2'))],
            ['Battery 2 time', dash(trimVal('fnBattery2Time'))],
            ['Battery 3', dash(trimVal('fnBattery3'))],
            ['Battery 3 time', dash(trimVal('fnBattery3Time'))],
            ['Battery 4', dash(trimVal('fnBattery4'))],
            ['Battery 4 time', dash(trimVal('fnBattery4Time'))],
            ['Weather', w || '—'],
            ['Notes', trimVal('fnNotes') || '—']
        ];
    }

    // ---- Open-Meteo (same API as js/weather.js — Flight Weather) ----

    var OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
    var HOURLY_PARAMS =
        'wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_120m,wind_direction_120m,visibility,cloud_cover,cloud_cover_low,precipitation,precipitation_probability,temperature_2m';
    var GUST_120M_MULTIPLIER = 1.3;
    var WX_MODEL_LABELS = {
        auto: 'Best match',
        ecmwf_ifs: 'ECMWF IFS (EU)',
        gfs_seamless: 'GFS (NOAA, US)',
        ukmo_seamless: 'UK Met Office',
        gem_global: 'GEM (Canada)'
    };

    function parseLatLngFromLocationString(s) {
        if (!s || !String(s).trim()) return null;
        var m = String(s).match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
        if (!m) return null;
        var lat = parseFloat(m[1]);
        var lng = parseFloat(m[2]);
        if (isNaN(lat) || isNaN(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        return { lat: lat, lng: lng };
    }

    function getTargetTimeMsFromForm() {
        var d = trimVal('fnDate');
        var t = trimVal('fnTime');
        if (d && t) {
            var ms = new Date(d + 'T' + t + ':00').getTime();
            if (!isNaN(ms)) return ms;
        }
        return null;
    }

    function directionToCardinal(deg) {
        if (deg == null || isNaN(deg)) return '—';
        var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        var idx = Math.round(((deg % 360) / 22.5)) % 16;
        return dirs[idx];
    }

    function formatVisibility(m) {
        if (m == null || isNaN(m)) return '—';
        if (m >= 10000) return (m / 1000).toFixed(1) + ' km';
        return Math.round(m) + ' m';
    }

    function formatWindRow(speed, dir) {
        if (speed == null || isNaN(speed)) return '—';
        return Math.round(speed) + ' km/h ' + directionToCardinal(dir);
    }

    function deriveSuitability(data) {
        var wind = data.wind_speed_10m != null ? data.wind_speed_10m : 0;
        var gusts = data.wind_gusts_10m != null ? data.wind_gusts_10m : wind;
        var vis = data.visibility != null ? data.visibility : 10000;
        var precip = data.precipitation != null ? data.precipitation : 0;

        if (wind > 40 || gusts > 50 || vis < 3000 || precip > 2) {
            return { level: 'poor', text: 'Not recommended for flight' };
        }
        if (wind > 25 || gusts > 35 || vis < 5000 || precip > 0) {
            return { level: 'caution', text: 'Caution: marginal conditions' };
        }
        return { level: 'good', text: 'Good conditions for flight' };
    }

    function deriveSummaryText(hourlySlice, suitability) {
        if (!hourlySlice || !hourlySlice.hourly) return '';
        var h = hourlySlice.hourly;
        var start = hourlySlice.startIdx;
        var timeLen = (h.time && h.time.length) || 0;
        var count = Math.min(12, timeLen - start);
        if (count <= 0) return suitability.text;

        function sliceFilter(key, pred) {
            var arr = h[key] || [];
            var seg = arr.slice(start, start + count);
            var out = [];
            for (var i = 0; i < seg.length; i++) {
                if (pred(seg[i])) out.push(seg[i]);
            }
            return out;
        }

        var w10 = sliceFilter('wind_speed_10m', function (v) {
            return v != null;
        });
        var gusts10 = sliceFilter('wind_gusts_10m', function (v) {
            return v != null;
        });
        var w120 = sliceFilter('wind_speed_120m', function (v) {
            return v != null;
        });
        var vis = sliceFilter('visibility', function (v) {
            return v != null;
        });
        var precip = sliceFilter('precipitation', function (v) {
            return v != null && v > 0;
        });

        var w10Min = w10.length ? Math.min.apply(Math, w10) : null;
        var w10Max = w10.length ? Math.max.apply(Math, w10) : null;
        var gustsMax = gusts10.length ? Math.max.apply(Math, gusts10) : null;
        var w120Max = w120.length ? Math.max.apply(Math, w120) : null;
        var visMin = vis.length ? Math.min.apply(Math, vis) : null;
        var visMax = vis.length ? Math.max.apply(Math, vis) : null;

        var parts = [];
        if (w10Min != null && w10Max != null) {
            if (w10Min === w10Max) parts.push('Sustained 10 m: ' + Math.round(w10Max) + ' km/h');
            else parts.push('Sustained 10 m: ' + Math.round(w10Min) + '–' + Math.round(w10Max) + ' km/h');
        }
        if (gustsMax != null) parts.push('Gusts 10 m: up to ' + Math.round(gustsMax) + ' km/h');
        if (w120Max != null) {
            parts.push('Sustained 120 m: up to ' + Math.round(w120Max) + ' km/h');
            parts.push('Gusts 120 m (est.): up to ' + Math.round(w120Max * GUST_120M_MULTIPLIER) + ' km/h');
        }
        if (visMin != null && visMax != null) {
            var vMin = visMin >= 10000 ? (visMin / 1000).toFixed(1) + ' km' : Math.round(visMin) + ' m';
            var vMax = visMax >= 10000 ? (visMax / 1000).toFixed(1) + ' km' : Math.round(visMax) + ' m';
            if (vMin === vMax) parts.push('Visibility: ' + vMax);
            else parts.push('Visibility: ' + vMin + ' to ' + vMax);
        }
        if (precip.length > 0) {
            var total = 0;
            for (var pi = 0; pi < precip.length; pi++) total += precip[pi];
            parts.push('Precipitation: ' + Math.round(total * 10) / 10 + ' mm expected');
        } else parts.push('No precipitation expected');

        return parts.join('. ') + '.';
    }

    function fetchOpenMeteoForPoint(lat, lng, targetTimestampMs) {
        var params = new URLSearchParams({
            latitude: lat.toFixed(4),
            longitude: lng.toFixed(4),
            hourly: HOURLY_PARAMS,
            forecast_days: '16',
            timezone: 'auto'
        });
        return fetch(OPEN_METEO_BASE + '?' + params.toString())
            .then(function (r) {
                if (!r.ok) throw new Error('Weather service unavailable');
                return r.json();
            })
            .then(function (data) {
                if (!data.hourly || !data.hourly.time || !data.hourly.time.length) {
                    throw new Error('No weather data returned');
                }
                var times = data.hourly.time;
                var useNow = targetTimestampMs === null || isNaN(targetTimestampMs);
                var bestIdx = 0;
                if (useNow) {
                    var now = Date.now();
                    var startIdx = 0;
                    for (var i = 0; i < times.length; i++) {
                        var t = new Date(times[i]).getTime();
                        if (t <= now) startIdx = i;
                    }
                    bestIdx = startIdx;
                } else {
                    var target = targetTimestampMs;
                    var bestDiff = Infinity;
                    for (var j = 0; j < times.length; j++) {
                        var tj = new Date(times[j]).getTime();
                        var diff = Math.abs(tj - target);
                        if (diff < bestDiff) {
                            bestDiff = diff;
                            bestIdx = j;
                        }
                    }
                }
                var weatherData = {};
                var keys = Object.keys(data.hourly);
                for (var k = 0; k < keys.length; k++) {
                    var key = keys[k];
                    if (key !== 'time' && Array.isArray(data.hourly[key])) {
                        weatherData[key] = data.hourly[key][bestIdx];
                    }
                }
                var displayTime = times[bestIdx];
                var hourlySlice = { startIdx: bestIdx, count: 12, hourly: data.hourly };
                return {
                    weatherData: weatherData,
                    displayTime: displayTime,
                    hourlySlice: hourlySlice,
                    model: 'auto'
                };
            });
    }

    function buildWeatherReportText(data, displayTime, hourlySlice, model, lat, lng, usedTargetTime) {
        var suitability = deriveSuitability(data);
        var summaryText = deriveSummaryText(hourlySlice, suitability);
        var modelLabel = WX_MODEL_LABELS[model] || model;

        var gusts = data.wind_gusts_10m;
        var gustsStr = gusts != null ? Math.round(gusts) + ' km/h' : '—';
        var wind120Str = formatWindRow(data.wind_speed_120m, data.wind_direction_120m);
        var gusts120 =
            data.wind_speed_120m != null ? Math.round(data.wind_speed_120m * GUST_120M_MULTIPLIER) + ' km/h' : '—';

        var cloudTotal = data.cloud_cover;
        var cloudLow = data.cloud_cover_low;
        var cloudStr = '—';
        if (cloudTotal != null) {
            cloudStr =
                cloudLow != null
                    ? Math.round(cloudTotal) + '% total, ' + Math.round(cloudLow) + '% low'
                    : Math.round(cloudTotal) + '%';
        }

        var precip = data.precipitation;
        var precipProb = data.precipitation_probability;
        var precipStr = '—';
        if (precip != null) {
            precipStr =
                precipProb != null
                    ? Math.round(precip * 10) / 10 + ' mm (' + Math.round(precipProb) + '% chance)'
                    : Math.round(precip * 10) / 10 + ' mm';
        }

        var temp = data.temperature_2m;
        var tempStr = temp != null ? Math.round(temp) + ' °C' : '—';

        var lines = [];
        lines.push('Open-Meteo forecast (Flight Weather source)');
        lines.push('Coordinates: ' + lat.toFixed(6) + ', ' + lng.toFixed(6));
        lines.push(
            'Forecast hour: ' +
                (displayTime || '—') +
                (usedTargetTime ? ' (from Date/Time fields)' : ' (current time)')
        );
        lines.push('Model: ' + modelLabel);
        lines.push('');
        lines.push('Summary: ' + suitability.text);
        if (summaryText) lines.push(summaryText);
        lines.push('');
        lines.push('10 m wind: ' + formatWindRow(data.wind_speed_10m, data.wind_direction_10m));
        lines.push('10 m gusts: ' + gustsStr);
        lines.push('120 m wind: ' + wind120Str);
        lines.push('120 m gusts (est.): ' + gusts120);
        lines.push('Visibility: ' + formatVisibility(data.visibility));
        lines.push('Cloud cover: ' + cloudStr);
        lines.push('Precipitation: ' + precipStr);
        lines.push('Temperature (2 m): ' + tempStr);
        lines.push('');
        lines.push('Data: Open-Meteo https://open-meteo.com/ (CC BY 4.0)');
        return lines.join('\n');
    }

    function setWeatherFetchStatus(message, kind) {
        var el = document.getElementById('fnWeatherFetchStatus');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'fn-weather-fetch-status';
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    async function onWeatherFetchClick() {
        var btn = document.getElementById('fnWeatherFetchBtn');
        var ta = document.getElementById('fnWeather');
        if (!ta) return;
        var loc = trimVal('fnLocation');
        var parsed = parseLatLngFromLocationString(loc);
        if (!parsed) {
            setWeatherFetchStatus(
                'Set Location to coordinates first (e.g. tap Use current GPS).',
                'error'
            );
            return;
        }
        var targetMs = getTargetTimeMsFromForm();
        var usedTarget = targetMs != null && !isNaN(targetMs);

        setWeatherFetchStatus('Fetching…', '');
        if (btn) btn.disabled = true;
        try {
            var result = await fetchOpenMeteoForPoint(parsed.lat, parsed.lng, targetMs);
            var block = buildWeatherReportText(
                result.weatherData,
                result.displayTime,
                result.hourlySlice,
                result.model,
                parsed.lat,
                parsed.lng,
                usedTarget
            );
            var existing = trimVal('fnWeather');
            var sep = '\n\n--- Open-Meteo — ' + result.displayTime + ' ---\n';
            if (existing) {
                ta.value = existing + sep + block;
            } else {
                ta.value = block;
            }
            setWeatherFetchStatus('Report added to Conditions.', 'ok');
            autoResizeConditionsTextarea();
            saveFlightNotesDraft();
        } catch (err) {
            console.error('Flight Notes weather fetch failed:', err);
            setWeatherFetchStatus(err && err.message ? err.message : 'Failed to fetch weather.', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function setNowDateTime() {
        var now = new Date();
        var dateEl = document.getElementById('fnDate');
        var timeEl = document.getElementById('fnTime');
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var d = String(now.getDate()).padStart(2, '0');
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        if (dateEl) dateEl.value = y + '-' + m + '-' + d;
        if (timeEl) timeEl.value = hh + ':' + mm;
        saveFlightNotesDraft();
    }

    function setTimeInputNow(inputId) {
        var el = document.getElementById(inputId);
        if (!el) return;
        var now = new Date();
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        el.value = hh + ':' + mm;
        saveFlightNotesDraft();
    }

    function setGpsStatus(message, kind) {
        var el = document.getElementById('fnGpsStatus');
        if (!el) return;
        el.textContent = message || '';
        el.classList.remove('fn-gps-error', 'fn-gps-ok');
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    function destroyMiniMap() {
        if (miniMap) {
            miniMap.remove();
            miniMap = null;
        }
    }

    function hideLocationResult() {
        var wrap = document.getElementById('fnLocationResult');
        if (wrap) wrap.hidden = true;
        destroyMiniMap();
        var pc = document.getElementById('fnPostcodeDisplay');
        if (pc) pc.textContent = '—';
    }

    /**
     * Reverse geocode via OpenStreetMap Nominatim (postcode where available).
     * See https://operations.osmfoundation.org/policies/nominatim/
     */
    function reversePostcode(lat, lng) {
        var url =
            'https://nominatim.openstreetmap.org/reverse?lat=' +
            encodeURIComponent(lat) +
            '&lon=' +
            encodeURIComponent(lng) +
            '&format=json&addressdetails=1';
        return fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            mode: 'cors'
        })
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .then(function (data) {
                if (!data || !data.address) return null;
                var a = data.address;
                return a.postcode || a.postal_code || null;
            })
            .catch(function () {
                return null;
            });
    }

    function initMiniMap(lat, lng) {
        destroyMiniMap();
        var el = document.getElementById('fnMiniMap');
        if (!el || typeof L === 'undefined') return;
        miniMap = L.map(el, {
            zoomControl: true,
            attributionControl: true
        }).setView([lat, lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
            maxZoom: 19
        }).addTo(miniMap);
        L.marker([lat, lng]).addTo(miniMap);
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (miniMap) miniMap.invalidateSize();
            });
        });
        setTimeout(function () {
            if (miniMap) miniMap.invalidateSize();
        }, 200);
    }

    function postcodeFromNominatimHit(hit) {
        if (!hit || !hit.address) return null;
        var a = hit.address;
        return a.postcode || a.postal_code || null;
    }

    /**
     * OpenStreetMap Nominatim forward search (same policy as reverse geocode).
     */
    function nominatimSearch(query) {
        var url =
            'https://nominatim.openstreetmap.org/search?q=' +
            encodeURIComponent(query) +
            '&format=json&limit=1&addressdetails=1';
        return fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            mode: 'cors'
        })
            .then(function (res) {
                if (!res.ok) throw new Error('Search failed');
                return res.json();
            })
            .then(function (arr) {
                if (!arr || !arr.length) return null;
                return arr[0];
            });
    }

    /**
     * Show map, postcode line, and location field after coordinates are known (GPS or search).
     * @param {string|null} postcodeHint - if set, skips reverse geocode lookup
     */
    function showLocationResolved(lat, lng, postcodeHint, okMessage) {
        var input = document.getElementById('fnLocation');
        var wrap = document.getElementById('fnLocationResult');
        var pcDisp = document.getElementById('fnPostcodeDisplay');
        var loc = lat.toFixed(6) + ', ' + lng.toFixed(6);
        if (wrap) wrap.hidden = false;
        if (pcDisp) pcDisp.textContent = postcodeHint != null ? postcodeHint : '…';
        if (input) {
            input.value = postcodeHint != null ? loc + ' · Postcode: ' + postcodeHint : loc;
        }
        saveFlightNotesDraft();
        setTimeout(function () {
            initMiniMap(lat, lng);
        }, 0);
        if (postcodeHint != null) {
            setGpsStatus(okMessage, 'ok');
        } else {
            setGpsStatus('Looking up postcode…', '');
            reversePostcode(lat, lng).then(function (pc) {
                if (pcDisp) pcDisp.textContent = pc || '—';
                if (input && pc) {
                    input.value = loc + ' · Postcode: ' + pc;
                }
                setGpsStatus(okMessage, 'ok');
                saveFlightNotesDraft();
            });
        }
    }

    function onSearchLocationClick() {
        var q = trimVal('fnLocation');
        if (!q) {
            setGpsStatus('Enter a postcode, address, or place name to search.', 'error');
            return;
        }
        var btn = document.getElementById('fnSearchLocationBtn');
        if (btn) btn.disabled = true;
        setGpsStatus('Searching…', '');
        nominatimSearch(q)
            .then(function (hit) {
                if (btn) btn.disabled = false;
                if (!hit) {
                    setGpsStatus('No results found. Try a different search.', 'error');
                    return;
                }
                var lat = parseFloat(hit.lat);
                var lng = parseFloat(hit.lon);
                if (isNaN(lat) || isNaN(lng)) {
                    setGpsStatus('Invalid result from search.', 'error');
                    return;
                }
                var pc = postcodeFromNominatimHit(hit);
                showLocationResolved(lat, lng, pc, 'Location updated from search.');
            })
            .catch(function () {
                if (btn) btn.disabled = false;
                setGpsStatus('Search failed. Check your connection and try again.', 'error');
            });
    }

    function onGpsClick() {
        if (!navigator.geolocation) {
            setGpsStatus('Geolocation is not available in this browser.', 'error');
            return;
        }
        // Secure context: HTTPS or localhost — required for geolocation in most browsers.
        var btn = document.getElementById('fnGpsBtn');
        if (btn) btn.disabled = true;
        setGpsStatus('Getting location…', '');

        navigator.geolocation.getCurrentPosition(
            function (pos) {
                var lat = pos.coords.latitude;
                var lng = pos.coords.longitude;
                if (btn) btn.disabled = false;
                showLocationResolved(lat, lng, null, 'Location updated from GPS.');
            },
            function (err) {
                hideLocationResult();
                var msg = 'Could not get location.';
                if (err && err.code === 1) msg = 'Location permission denied.';
                else if (err && err.code === 2) msg = 'Location unavailable.';
                else if (err && err.code === 3) msg = 'Location request timed out.';
                setGpsStatus(msg, 'error');
                if (btn) btn.disabled = false;
            },
            GPS_OPTIONS
        );
    }

    function emailSubject() {
        var d = trimVal('fnDate');
        return d ? 'Flight Notes — ' + d : 'Flight Notes';
    }

    async function onEmailClick() {
        var text = buildNotesPlainText();
        var subj = emailSubject();
        var shortBody =
            'Your flight notes are on the clipboard — paste into the email body below. (The full text was too long to put in the mail link automatically.)';

        if (text.length > MAILTO_BODY_MAX) {
            try {
                await navigator.clipboard.writeText(text);
                window.location.href =
                    'mailto:?subject=' +
                    encodeURIComponent(subj) +
                    '&body=' +
                    encodeURIComponent(shortBody);
            } catch (e) {
                alert(
                    'Could not copy notes to the clipboard. Try shortening your notes or copy the text manually from the page.'
                );
            }
            return;
        }

        window.location.href =
            'mailto:?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(text);
    }

    /**
     * Rasterise the Flight Notes Leaflet mini-map for PDF (same idea as PdfTheme.captureSquareMap).
     */
    async function tryCaptureMiniMapPng() {
        var mapEl = document.getElementById('fnMiniMap');
        if (!mapEl || !miniMap || typeof html2canvas === 'undefined') return null;
        await new Promise(function (resolve) {
            setTimeout(resolve, 500);
        });
        if (miniMap) miniMap.invalidateSize();
        try {
            var lt = document.getElementById('fnLightThemeToggle');
            var capBg = lt && lt.checked ? '#e8eaed' : '#1a1a2e';
            var canvas = await html2canvas(mapEl, {
                useCORS: true,
                allowTaint: true,
                backgroundColor: capBg,
                scale: 2,
                logging: false
            });
            return {
                dataUrl: canvas.toDataURL('image/png'),
                width: canvas.width,
                height: canvas.height
            };
        } catch (e) {
            console.warn('Flight Notes: map screenshot failed', e);
            return null;
        }
    }

    /** Fit image into a max box (mm) without stretching — preserves aspect ratio. */
    function mapImageSizeMm(canvasW, canvasH, maxWMm, maxHMm) {
        if (!canvasW || !canvasH) return { w: maxWMm, h: maxHMm };
        var ar = canvasW / canvasH;
        var w = maxWMm;
        var h = w / ar;
        if (h > maxHMm) {
            h = maxHMm;
            w = h * ar;
        }
        return { w: w, h: h };
    }

    async function onPdfClick() {
        var btn = document.getElementById('fnPdfBtn');
        var orig = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating…';
        }

        try {
            if (typeof PdfTheme === 'undefined') {
                throw new Error('PDF library not loaded');
            }

            var lightToggle = document.getElementById('fnLightThemeToggle');
            PdfTheme.setLight(!!(lightToggle && lightToggle.checked));
            await PdfTheme.loadLogo();

            var ts = PdfTheme.tableStyles();
            var doc = PdfTheme.createDoc();
            PdfTheme.addHeader(doc, 'Flight Notes', true);

            var startY = 26;
            var mapShot = await tryCaptureMiniMapPng();
            if (mapShot && mapShot.dataUrl) {
                var maxW = 100;
                var maxH = 100;
                var dims = mapImageSizeMm(mapShot.width, mapShot.height, maxW, maxH);
                doc.addImage(mapShot.dataUrl, 'PNG', 10, startY, dims.w, dims.h);
                startY = startY + dims.h + 4;
            }

            var body = tableRowsForPdf();
            doc.autoTable({
                startY: startY,
                head: [['Field', 'Details']],
                body: body,
                columnStyles: {
                    0: { cellWidth: 52 },
                    1: { cellWidth: 220 }
                },
                ...ts
            });

            PdfTheme.addAllFooters(doc);

            var datePart = trimVal('fnDate') || new Date().toISOString().slice(0, 10);
            doc.save('Flight_Notes_' + datePart + '.pdf');
        } catch (err) {
            console.error('Flight Notes PDF export failed:', err);
            alert('Failed to export PDF: ' + (err && err.message ? err.message : 'Unknown error'));
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = orig || 'Export PDF';
            }
        }
    }

    function clearWeatherFetchStatus() {
        var wfs = document.getElementById('fnWeatherFetchStatus');
        if (!wfs) return;
        wfs.textContent = '';
        wfs.className = 'fn-weather-fetch-status';
    }

    function openClearModal() {
        var m = document.getElementById('fnClearModal');
        if (!m) return;
        m.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        var confirmBtn = document.getElementById('fnClearModalConfirm');
        if (confirmBtn) confirmBtn.focus();
    }

    function closeClearModal() {
        var m = document.getElementById('fnClearModal');
        if (m) m.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function clearEntireForm() {
        var form = document.getElementById('flightNotesForm');
        if (form) form.reset();
        var ta = document.getElementById('fnWeather');
        if (ta) {
            ta.style.height = '';
            ta.style.overflowY = '';
        }
        hideLocationResult();
        setGpsStatus('', '');
        clearWeatherFetchStatus();
        clearFlightNotesDraftStorage();
        closeClearModal();
        autoResizeConditionsTextarea();
    }

    function init() {
        var lightToggle = document.getElementById('fnLightThemeToggle');
        if (lightToggle) {
            try {
                if (localStorage.getItem('fnLightTheme') === '1') {
                    lightToggle.checked = true;
                    document.body.classList.add('fn-light-theme');
                }
            } catch (e) {}
            lightToggle.addEventListener('change', function () {
                document.body.classList.toggle('fn-light-theme', lightToggle.checked);
                try {
                    localStorage.setItem('fnLightTheme', lightToggle.checked ? '1' : '0');
                } catch (e) {}
            });
        }

        loadFlightNotesDraft();

        var nowBtn = document.getElementById('fnNowBtn');
        var searchLocationBtn = document.getElementById('fnSearchLocationBtn');
        var gpsBtn = document.getElementById('fnGpsBtn');
        var emailBtn = document.getElementById('fnEmailBtn');
        var pdfBtn = document.getElementById('fnPdfBtn');

        var weatherFetchBtn = document.getElementById('fnWeatherFetchBtn');
        var clearFormBtn = document.getElementById('fnClearFormBtn');
        var clearModal = document.getElementById('fnClearModal');
        var clearBackdrop = document.getElementById('fnClearModalBackdrop');
        var clearCancel = document.getElementById('fnClearModalCancel');
        var clearClose = document.getElementById('fnClearModalClose');
        var clearConfirm = document.getElementById('fnClearModalConfirm');

        if (nowBtn) nowBtn.addEventListener('click', setNowDateTime);
        document.querySelectorAll('.fn-btn-battery-time-now').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-time-for');
                if (id) setTimeInputNow(id);
            });
        });
        if (searchLocationBtn) searchLocationBtn.addEventListener('click', onSearchLocationClick);
        if (gpsBtn) gpsBtn.addEventListener('click', onGpsClick);
        if (weatherFetchBtn) weatherFetchBtn.addEventListener('click', onWeatherFetchClick);
        var fnWeatherTa = document.getElementById('fnWeather');
        if (fnWeatherTa) {
            fnWeatherTa.addEventListener('input', autoResizeConditionsTextarea);
            autoResizeConditionsTextarea();
        }
        window.addEventListener(
            'resize',
            function () {
                autoResizeConditionsTextarea();
            },
            { passive: true }
        );
        if (emailBtn) emailBtn.addEventListener('click', onEmailClick);
        if (pdfBtn) pdfBtn.addEventListener('click', onPdfClick);

        if (clearFormBtn) clearFormBtn.addEventListener('click', openClearModal);
        if (clearCancel) clearCancel.addEventListener('click', closeClearModal);
        if (clearClose) clearClose.addEventListener('click', closeClearModal);
        if (clearBackdrop) clearBackdrop.addEventListener('click', closeClearModal);
        if (clearConfirm) clearConfirm.addEventListener('click', clearEntireForm);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && clearModal && !clearModal.classList.contains('hidden')) {
                closeClearModal();
            }
        });

        var fnForm = document.getElementById('flightNotesForm');
        if (fnForm) {
            fnForm.addEventListener('input', scheduleFlightNotesDraftSave);
            fnForm.addEventListener('change', scheduleFlightNotesDraftSave);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
