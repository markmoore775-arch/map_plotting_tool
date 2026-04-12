/* ============================================
   AIRSPACE PAGE: ADS-B (ADSB.lol) + optional OGN (live.glidernet.org lxml)
   Plane markers, session trail, detail on click; optional AGL (Mapbox terrain)
   Loaded only by airspace.html. Planning UK layers: js/uk-airspace-layers.js (Airspace.init).
   ============================================ */

(function () {
    'use strict';

    const ADSB_LOL_BASE = 'https://api.adsb.lol/v2';
    const OGN_STORAGE_KEY = 'airspaceOgnEnabled';
    const AIRSPACE_MAP_DRAFT_KEY = 'airplotAirspaceMapView_v1';
    let airspaceMapDraftTimer = null;
    const MIN_POLL_MS = 1100;
    const MOVE_DEBOUNCE_MS = 500;
    const RADIUS_MIN_NM = 5;
    const RADIUS_MAX_NM = 250;
    /** Recent positions per ICAO hex (API has no trail; we build from polls) */
    const MAX_TRAIL_POINTS = 120;

    const HELP_HTML = [
        '<p class="airspace-help-lead"><strong>Airspace</strong> (AirPlot v4) uses <a href="https://api.adsb.lol/docs" target="_blank" rel="noopener">ADSB.lol</a> for <strong>hazard awareness</strong> while flying drones: aircraft use <strong>red</strong> icons by altitude band, <strong>altitude (ft)</strong> is shown next to each track, and a <strong>session trail</strong> builds while this tab stays open. Optional <strong>OGN (FLARM-class)</strong> uses the <a href="https://www.glidernet.org/" target="_blank" rel="noopener">Open Glider Network</a> live feed: <strong>cyan</strong> markers for gliders and similar traffic that may not appear on ADS-B.</p>',
        '<p>Optional <strong>approx. AGL</strong> (metres) uses the same <strong>Mapbox Terrain-RGB</strong> source as Planning mode when a token is set in <code>js/config.js</code>. It is <strong>barometric altitude vs terrain model</strong>; not for separation. DEM and altimeter errors apply.</p>',
        '<p><strong>Not for separation.</strong> Situational awareness only.</p>',
        '<p><strong>Steps</strong></p>',
        '<ol class="airspace-help-list">',
        '<li>Default map is <strong>OpenStreetMap</strong>; switch to <strong>Dark (Carto)</strong> in the layer control for a night-tracker look. Each marker shows a <strong>type/category silhouette</strong> (ADS-B Radar icon set) tinted <strong>red by altitude band</strong> with <strong>altitude (ft)</strong> under the icon. Tap the marker or label for full detail and the highlighted path. Known <strong>NPAS</strong> police helicopter registrations use the <strong>rotorcraft</strong> icon and an <strong>NPAS</strong> altitude label.</li>',
        '<li>While details are open, <strong>auto-refresh pauses</strong> so the panel and trail stay on screen. Close the panel or tap <strong>Refresh</strong> to update positions. The red-orange line is from this session, not full flight history (see ADSB.lol docs for archives).</li>',
        '</ol>',
        '<p>Local dev: <code>npm run serve</code> for <code>/api/adsb</code> and <code>/api/ogn</code>. Open <a href="flight-notes.html">Flight Report</a> or the <a href="checklist.html">Checklist</a> from the welcome screen.</p>'
    ].join('');

    const DEFAULT_MAP_CENTER = [51.5074, -0.1278];
    const GEO_INITIAL_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

    let map;
    let trafficLayer;
    let ognLayer;
    let trafficEnabled = true;
    let pollTimer = null;
    let moveDebounce = null;
    let lastFetchAt = 0;
    let isFetching = false;

    /** @type {Map<string, number[][]>} */
    const trailByHex = new Map();
    /** @type {Map<string, number[][]>} */
    const trailByOgnId = new Map();
    /** @type {L.Polyline|null} */
    let selectedTrailPolyline = null;

    /** True while a traffic marker popup is open (pauses polling so the panel is not torn down). */
    let trafficPopupOpen = false;
    /** ICAO hex of the open popup, preserved across forced re-renders (Refresh). */
    let pinnedHex = null;
    /** OGN device id (hex) when its popup is open. */
    let pinnedOgnId = null;
    /** Leaflet fires popupclose when clearing layers; suppress clearing our pinned state during re-render. */
    let suppressTrafficPopupClose = false;
    let suppressOgnPopupClose = false;
    /** Which trail is highlighted with the open detail panel. */
    let selectedTrailKind = null;
    /** @type {string|null} */
    let selectedTrailKey = null;

    /** Last successful aircraft list (for AGL toggle refresh without a new API call). */
    let lastAircraftList = [];
    /** @type {Array<{id:string,lat:number,lon:number,altM:number|null,speed:number|null,track:number|null,climb:number|null,callsign:string}>} */
    let lastOgnList = [];
    /** Incremented each render so stale AGL tile callbacks do not update old markers. */
    let airspaceRenderGen = 0;

    /** AGL always starts off each visit (not persisted). */
    let aglEnabled = false;

    function loadOgnPreference() {
        try {
            return localStorage.getItem(OGN_STORAGE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    let ognEnabled = loadOgnPreference();

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

    /** Lat/lon for map geometry; some feeds use lastPosition when primary coords age out. */
    function positionLatLon(a) {
        if (!a) return null;
        if (a.lat != null && a.lon != null) {
            return { lat: a.lat, lon: a.lon };
        }
        const lp = a.lastPosition;
        if (lp && lp.lat != null && lp.lon != null) {
            return { lat: lp.lat, lon: lp.lon };
        }
        return null;
    }

    /** Response list key: ADSB.lol uses <code>ac</code>; other feeds may use <code>aircraft</code>. */
    function aircraftListFromResponse(data) {
        if (!data) return [];
        const list = data.aircraft || data.ac;
        return Array.isArray(list) ? list : [];
    }

    function getMapboxToken() {
        if (typeof AIRPLOT_CONFIG === 'undefined' || !AIRPLOT_CONFIG.mapboxAccessToken) {
            return '';
        }
        return String(AIRPLOT_CONFIG.mapboxAccessToken).trim();
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

    function formatTime(ts) {
        if (ts == null) return '-';
        try {
            const sec = typeof ts === 'number' && ts > 1e12 ? Math.floor(ts / 1000) : ts;
            return new Date(sec * 1000).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            return '-';
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

    function clearOgnTraffic() {
        suppressOgnPopupClose = true;
        ognLayer.clearLayers();
        suppressOgnPopupClose = false;
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

    /** UK NPAS police helicopter registrations (ADS-B field <code>r</code>); force rotor icon + map label. */
    function normalizeAircraftRegistration(r) {
        if (r == null || r === '') return '';
        return String(r)
            .trim()
            .toUpperCase()
            .replace(/\s+/g, '');
    }

    const NPAS_REGISTRATION_SET = (function () {
        const list = [
            'G-POLA',
            'G-POLB',
            'G-POLC',
            'G-POLD',
            'G-POLF',
            'G-POLG',
            'G-POLH',
            'G-POLJ',
            'G-POLU',
            'G-POLV',
            'G-POLW',
            'G-POLX',
            'G-POL'
        ];
        const o = Object.create(null);
        for (let i = 0; i < list.length; i++) {
            o[normalizeAircraftRegistration(list[i])] = true;
        }
        return o;
    })();

    function isNpasPoliceHelicopter(a) {
        const reg = normalizeAircraftRegistration(a && a.r);
        return reg !== '' && !!NPAS_REGISTRATION_SET[reg];
    }

    function showHelicopterMarker(a) {
        return isHelicopter(a) || isNpasPoliceHelicopter(a);
    }

    /**
     * Aircraft mask SVGs: assets/aircraft-icons/ (ADS-B Radar free set; see ATTRIBUTION.txt there).
     * Colour = altitude tier via currentColor (CSS mask on .airspace-plane-rot).
     */
    const AIRCRAFT_ICON_DIR = 'assets/aircraft-icons/';
    const AIRCRAFT_ICON_FALLBACK = AIRCRAFT_ICON_DIR + 'a0.svg';

    /** Exact ICAO type designator (field `t`) → filename. Prefix rules fill gaps below. */
    const AIRCRAFT_ICON_BY_TYPE = (function () {
        const o = Object.create(null);
        function add(list, file) {
            for (let i = 0; i < list.length; i++) {
                o[list[i]] = file;
            }
        }
        add(
            ['A318', 'A319', 'A320', 'A321', 'A19N', 'A20N', 'A21N', 'A318N', 'A319N', 'A320N', 'A321N'],
            'a320.svg'
        );
        add(['A332', 'A333', 'A338', 'A339', 'A337', 'A330'], 'a330.svg');
        add(['A340', 'A343', 'A345', 'A346', 'A342'], 'a340.svg');
        add(['A359', 'A35K', 'A35X'], 'a330.svg');
        add(['A388', 'A380'], 'a380.svg');
        add(
            [
                'B731',
                'B732',
                'B733',
                'B734',
                'B735',
                'B736',
                'B737',
                'B738',
                'B739',
                'B37M',
                'B38M',
                'B39M',
                'BBJ',
                'BBJ2',
                'BBJ3'
            ],
            'b737.svg'
        );
        add(['B741', 'B742', 'B743', 'B744', 'BLCF', 'BSCA'], 'b747.svg');
        add(['B762', 'B763', 'B764'], 'b767.svg');
        add(['B772', 'B773', 'B774', 'B77L', 'B77W'], 'b777.svg');
        add(['B788', 'B789', 'B78X'], 'b787.svg');
        add(['CRJ2', 'CRJ7', 'CRJ9', 'CRJX', 'CRJ1', 'CRJ5'], 'crjx.svg');
        add(['DH8A', 'DH8B', 'DH8C', 'DH8D', 'DHC6', 'DHC7'], 'dh8a.svg');
        add(['E170', 'E175', 'E190', 'E195', 'E135', 'E145', 'E275', 'E545', 'E550'], 'e195.svg');
        add(['E45X', 'E75L', 'E75S'], 'erj.svg');
        add(['F70', 'F100', 'F28'], 'f100.svg');
        add(['C172', 'C152', 'C150', 'C182', 'C206', 'C208', 'C82S', 'P28A', 'P28B', 'P28T', 'SR22', 'SR20'], 'cessna.svg');
        add(['GLF5', 'GLF6', 'G150', 'G280', 'GA5C', 'GA6C', 'G650'], 'glf5.svg');
        add(['FA7X', 'FA8X', 'F900', 'F950', 'F2TH', 'FALX'], 'fa7x.svg');
        add(['LJ45', 'LJ60', 'LJ75', 'BE40', 'C25A', 'C25B', 'C25C', 'C25M', 'C510', 'C525', 'C550', 'C560', 'C680', 'C750', 'C700', 'PC24', 'EA50'], 'learjet.svg');
        add(['C130', 'C30J', 'KC130', 'C295'], 'c130.svg');
        add(['F5', 'RF5'], 'f5.svg');
        add(['F15', 'F16', 'F22', 'F35', 'F18', 'F18H', 'FA18', 'EF18'], 'f15.svg');
        add(['F11', 'F104'], 'f11.svg');
        add(['MD11', 'DC10', 'DC11'], 'md11.svg');
        return o;
    })();

    /** Track 0° = north; pack art is top-down, nose-up in viewBox. */
    const MAP_ICON_ROTATION_OFFSET = 0;

    /** Resolve icon SVG URL for <img src> (reliable vs CSS mask-image in WebKit/Safari). */
    function aircraftIconAbsUrl(relPath) {
        try {
            return new URL(relPath, document.baseURI).href;
        } catch (e) {
            return relPath;
        }
    }

    /** Single digit 0–7 from ADS-B emitter category, or null. */
    function emitterCategoryDigit(a) {
        const raw = (a.category != null && String(a.category).trim()) || '';
        if (!raw) return null;
        const u = raw.toUpperCase();
        if (/^A[0-7]$/.test(u)) return u.charAt(1);
        if (/^[0-7]$/.test(u)) return u;
        return null;
    }

    /** Map ICAO type code `t` to icon filename, or null (use category / fallback). */
    function icaoTypeToIconFile(tRaw) {
        const t = String(tRaw || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
        if (!t) return null;
        const exact = AIRCRAFT_ICON_BY_TYPE[t];
        if (exact) return exact;

        if (/^A388|^A380/.test(t)) return 'a380.svg';
        if (/^A33/.test(t)) return 'a330.svg';
        if (/^A340|^A342|^A343|^A345|^A346/.test(t)) return 'a340.svg';
        if (/^A35/.test(t)) return 'a330.svg';
        if (/^A30/.test(t)) return 'a330.svg';
        if (/^A31|^A32|^A318|^A319|^A320|^A321|^A19|^A20|^A21/.test(t)) return 'a320.svg';

        if (/^B73|^B37|^B38|^B39/.test(t)) return 'b737.svg';
        if (/^B74|^BLCF|^BSCA/.test(t)) return 'b747.svg';
        if (/^B76[234]/.test(t)) return 'b767.svg';
        if (/^B77/.test(t)) return 'b777.svg';
        if (/^B78/.test(t)) return 'b787.svg';

        if (/^CRJ|^CL35|^CL30|^CL60/.test(t)) return 'crjx.svg';
        if (/^DH8|^DHC8/.test(t)) return 'dh8a.svg';

        if (/^E170|^E175|^E190|^E195|^E135|^E145|^E275|^E545|^E550/.test(t)) return 'e195.svg';
        if (/^E75|^E45|^E40|^E50/.test(t)) return 'erj.svg';

        if (/^AT4|^AT4[56]|^AT7|^AT72|^AT76|^SF34|^SH36|^JS41|^DHC6/.test(t)) return 'dh8a.svg';

        if (/^C1[0-9][0-9]/.test(t) || /^C82|^P28|^PA28|^SR22|^SR20|^DV20/.test(t)) return 'cessna.svg';

        if (/^GLF|^G150|^G280|^GA5|^GA6/.test(t)) return 'glf5.svg';
        if (/^F2T|^F900|^FA7|^FA8|^F950|^FALX/.test(t)) return 'fa7x.svg';
        if (/^LJ|^BE40|^BE4W|^C25|^C5[0-9]|^C68|^C70|^C75|^C7X|^EA50|^PC24/.test(t)) return 'learjet.svg';

        if (/^C130|^C30J|^KC130|^C295/.test(t)) return 'c130.svg';
        if (/^F5|^RF5/.test(t)) return 'f5.svg';
        if (/^F15|^F16|^F22|^F35|^F18|^FA18|^EF18/.test(t)) return 'f15.svg';
        if (/^F11|^F104/.test(t)) return 'f11.svg';
        if (/^F70|^F100|^F28/.test(t)) return 'f100.svg';

        if (/^MD1|^MD11|^DC10/.test(t)) return 'md11.svg';

        return null;
    }

    /** Relative path (from site root) to mask SVG for this aircraft. */
    function aircraftMaskRelPath(a) {
        if (showHelicopterMarker(a)) {
            return AIRCRAFT_ICON_DIR + 'a7.svg';
        }
        const typeFile = icaoTypeToIconFile(a.t);
        if (typeFile) {
            return AIRCRAFT_ICON_DIR + typeFile;
        }
        const d = emitterCategoryDigit(a);
        if (d != null) {
            return AIRCRAFT_ICON_DIR + 'a' + d + '.svg';
        }
        return AIRCRAFT_ICON_FALLBACK;
    }

    /**
     * One divIcon: silhouette (img + CSS filter for altitude colour) + altitude pill.
     * Altitude is inside the marker so taps hit the marker (Leaflet tooltips are non-interactive).
     */
    function aircraftIconHtml(trackDeg, tier, svgRelPath, altitudeText, hexLower) {
        const tr = trackDeg != null && !Number.isNaN(Number(trackDeg)) ? Number(trackDeg) : 0;
        const rot = tr + MAP_ICON_ROTATION_OFFSET;
        const path = svgRelPath || AIRCRAFT_ICON_FALLBACK;
        const src = aircraftIconAbsUrl(path);
        const altElId = 'airspace-marker-alt-' + hexLower;
        return (
            '<div class="airspace-marker-wrap airspace-marker-tier--' +
            tier +
            '">' +
            '<div class="airspace-plane-drop">' +
            '<div class="airspace-plane-spin" style="transform:rotate(' +
            rot +
            'deg)">' +
            '<div class="airspace-plane-img-cell airspace-icon airspace-icon--' +
            tier +
            '">' +
            '<img class="airspace-plane-img" src="' +
            escapeHtml(src) +
            '" alt="" draggable="false"/>' +
            '</div></div></div>' +
            '<div class="airspace-marker-alt" id="' +
            altElId +
            '">' +
            escapeHtml(altitudeText) +
            '</div>' +
            '</div>'
        );
    }

    /** Leaflet divIcon width must cover the altitude pill (option 1: grow horizontally with AGL text). */
    const AIRSPACE_MARKER_ICON_H = 66;
    const AIRSPACE_MARKER_ANCHOR_Y = 22;
    const AIRSPACE_MARKER_MIN_W = 52;
    const AIRSPACE_MARKER_MAX_W = 240;

    function estimateAirspaceIconWidth(altitudeText) {
        const s = String(altitudeText || '');
        const approxCharPx = 7;
        const padBorder = 16;
        const w = Math.ceil(s.length * approxCharPx + padBorder);
        return Math.min(
            AIRSPACE_MARKER_MAX_W,
            Math.max(AIRSPACE_MARKER_MIN_W, w)
        );
    }

    function trafficAircraftDivIcon(a, aglMeters) {
        const tier = altitudeIconTier(a);
        const trk = a.track != null ? a.track : 0;
        const heli = showHelicopterMarker(a);
        const hex = normalizeHex(a.hex);
        const altText = formatAltitudeLabel(a, aglMeters);
        const w = estimateAirspaceIconWidth(altText);
        return L.divIcon({
            className: 'airspace-plane-marker' + (heli ? ' airspace-marker-heli' : ''),
            html: aircraftIconHtml(trk, tier, aircraftMaskRelPath(a), altText, hex),
            iconSize: [w, AIRSPACE_MARKER_ICON_H],
            iconAnchor: [Math.round(w / 2), AIRSPACE_MARKER_ANCHOR_Y]
        });
    }

    const OGN_MARKER_SVG = AIRCRAFT_ICON_DIR + 'cessna.svg';

    /** Altitude tier for OGN markers (cyan styling); alt in metres MSL. */
    function ognAltitudeTier(rec) {
        if (rec.altM == null) return 'low';
        if (rec.altM < 120) return 'ground';
        if (rec.altM >= 8000) return 'high';
        if (rec.altM >= 3000) return 'mid';
        return 'low';
    }

    function formatOgnAltitudeLabel(rec, aglMeters) {
        let base;
        if (rec.altM != null && !Number.isNaN(Number(rec.altM))) {
            const ft = Math.round(Number(rec.altM) * 3.280839895);
            base = ft + "' · " + Math.round(Number(rec.altM)) + 'm';
        } else {
            base = '-';
        }
        if (
            aglMeters != null &&
            !Number.isNaN(Number(aglMeters)) &&
            getMapboxToken() &&
            aglEnabled
        ) {
            base = base + ' · ~' + Math.round(Number(aglMeters)) + 'm AGL';
        }
        return 'OGN ' + base;
    }

    function ognTrafficDivIcon(rec, aglMeters) {
        const tier = 'ogn';
        const trk = rec.track != null && !Number.isNaN(Number(rec.track)) ? Number(rec.track) : 0;
        const altText = formatOgnAltitudeLabel(rec, aglMeters);
        const w = estimateAirspaceIconWidth(altText);
        const idSafe = String(rec.id || '').replace(/[^0-9a-f]/gi, '');
        return L.divIcon({
            className: 'airspace-plane-marker airspace-plane-marker--ogn',
            html: aircraftIconHtml(trk, tier, OGN_MARKER_SVG, altText, idSafe || 'ogn'),
            iconSize: [w, AIRSPACE_MARKER_ICON_H],
            iconAnchor: [Math.round(w / 2), AIRSPACE_MARKER_ANCHOR_Y]
        });
    }

    function pseudoAircraftFromOgn(rec) {
        if (!rec || rec.altM == null) return null;
        return {
            lat: rec.lat,
            lon: rec.lon,
            alt_baro: Number(rec.altM) * 3.280839895
        };
    }

    function recordTrailsFromList(ac) {
        if (!ac || !ac.length) return;
        for (let i = 0; i < ac.length; i++) {
            const a = ac[i];
            const hex = normalizeHex(a.hex);
            if (hex.length !== 6) continue;
            const pos = positionLatLon(a);
            if (!pos) continue;
            let arr = trailByHex.get(hex);
            if (!arr) arr = [];
            const last = arr[arr.length - 1];
            if (last && last[0] === pos.lat && last[1] === pos.lon) continue;
            arr.push([pos.lat, pos.lon]);
            if (arr.length > MAX_TRAIL_POINTS) {
                arr = arr.slice(-MAX_TRAIL_POINTS);
            }
            trailByHex.set(hex, arr);
        }
    }

    function recordOgnTrailsFromList(list) {
        if (!list || !list.length) return;
        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (!rec || !rec.id) continue;
            const id = rec.id;
            const lat = rec.lat;
            const lon = rec.lon;
            if (!isFinite(lat) || !isFinite(lon)) continue;
            let arr = trailByOgnId.get(id);
            if (!arr) arr = [];
            const last = arr[arr.length - 1];
            if (last && last[0] === lat && last[1] === lon) continue;
            arr.push([lat, lon]);
            if (arr.length > MAX_TRAIL_POINTS) {
                arr = arr.slice(-MAX_TRAIL_POINTS);
            }
            trailByOgnId.set(id, arr);
        }
    }

    function fmtNum(n, suffix) {
        if (n == null || Number.isNaN(Number(n))) return '-';
        return Math.round(Number(n)) + (suffix || '');
    }

    /** Short baro/geom altitude for always-visible map labels (ft, prime = feet). */
    function formatAltitudeLabel(a, aglMeters) {
        let base;
        if (a.alt_baro != null && !Number.isNaN(Number(a.alt_baro))) {
            base = Math.round(Number(a.alt_baro)) + "'";
        } else if (a.alt_geom != null && !Number.isNaN(Number(a.alt_geom))) {
            base = Math.round(Number(a.alt_geom)) + "' g";
        } else if (isGroundAircraft(a)) {
            base = 'GND';
        } else {
            base = '-';
        }
        if (
            aglMeters != null &&
            !Number.isNaN(Number(aglMeters)) &&
            getMapboxToken() &&
            aglEnabled
        ) {
            base = base + ' · ~' + Math.round(Number(aglMeters)) + 'm AGL';
        }
        if (isNpasPoliceHelicopter(a)) {
            return 'NPAS ' + base;
        }
        return base;
    }

    function buildPopupHtml(a, trailPts, aglMeters) {
        const flight = (a.flight && String(a.flight).trim()) || '';
        const hex = a.hex || '';
        const reg = (a.r && String(a.r).trim()) || '';
        const typ = (a.t && String(a.t).trim()) || '';
        const desc = (a.desc && String(a.desc).trim()) || '';
        const alt =
            a.alt_baro != null && !Number.isNaN(a.alt_baro)
                ? fmtNum(a.alt_baro, ' ft baro')
                : '-';
        const altg =
            a.alt_geom != null && !Number.isNaN(a.alt_geom)
                ? fmtNum(a.alt_geom, ' ft geom')
                : null;
        const gs = a.gs != null ? fmtNum(a.gs, ' kt') : '-';
        const trk = a.track != null ? fmtNum(a.track, '°') : '-';
        const sq = (a.squawk && String(a.squawk).trim()) || '-';
        const cat = (a.category && String(a.category).trim()) || '-';
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
            '. Full history is not in the public API; this path is built while the page is open.</p>';

        const npas = isNpasPoliceHelicopter(a);
        const rows = [
            npas ? ['Service', 'NPAS (police helicopter)'] : null,
            ['Altitude', alt + (altg ? ' · ' + altg : '')],
            [
                'AGL (approx.)',
                aglMeters != null && !Number.isNaN(Number(aglMeters))
                    ? '~' + Math.round(Number(aglMeters)) + ' m (terrain vs baro/geom)'
                    : null
            ],
            ['Speed', 'GS ' + gs + (tas ? ' · TAS ' + tas : '') + (ias ? ' · IAS ' + ias : '')],
            ['Track / heading', 'Track ' + trk + (thd ? ' · TH ' + thd : '') + (mhdg ? ' · MH ' + mhdg : '')],
            ['Vert rate', (br ? 'Baro ' + br : '') + (br && gr ? ' · ' : '') + (gr ? 'Geom ' + gr : '') || '-'],
            ['Wind', wd && ws ? wd + ' / ' + ws : '-'],
            ['Mach', mach || '-'],
            ['Squawk', escapeHtml(sq)],
            ['Category', escapeHtml(cat)],
            [
                'Type',
                typ || desc
                    ? escapeHtml(typ + (desc ? ': ' + desc : ''))
                    : '-'
            ],
            ['Registration', reg ? escapeHtml(reg) : '-'],
            ['Position', dst || '-'],
            ['Bearing', dir || '-'],
            ['Nav alt (MCP)', navAlt || '-']
        ];

        let table = '<table class="airspace-popup-table">';
        for (let r = 0; r < rows.length; r++) {
            if (rows[r] == null || rows[r][1] == null) {
                continue;
            }
            if (
                rows[r][1] === '-' &&
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

    function buildOgnPopupHtml(rec, trailPts, aglMeters) {
        const id = rec && rec.id ? String(rec.id) : '';
        const cs = rec && rec.callsign ? String(rec.callsign) : '';
        const altM = rec && rec.altM != null ? Math.round(Number(rec.altM)) + ' m MSL' : '-';
        const altFt =
            rec && rec.altM != null ? Math.round(Number(rec.altM) * 3.280839895) + ' ft' : null;
        const trk = rec && rec.track != null ? fmtNum(rec.track, '°') : '-';
        const spd = rec && rec.speed != null ? String(rec.speed) : '-';
        const clb = rec && rec.climb != null ? String(rec.climb) : '-';
        const tlen = trailPts ? trailPts.length : 0;
        let trailNote =
            '<p class="airspace-popup-muted">Trail: <strong>' +
            tlen +
            '</strong> points in this session';
        if (tlen >= 2) {
            trailNote += ' (~' + Math.round((tlen - 1) * (MIN_POLL_MS / 1000)) + ' s of samples)';
        }
        trailNote +=
            '. Open Glider Network; not for separation. Speed/climb are feed-specific units where shown.</p>';

        const rows = [
            ['Source', 'Open Glider Network (live.glidernet.org)'],
            ['Device ID', id ? escapeHtml(id) : '-'],
            ['Callsign / name', cs ? escapeHtml(cs) : '-'],
            ['Altitude', altFt ? altM + ' · ' + altFt : altM],
            [
                'AGL (approx.)',
                aglMeters != null && !Number.isNaN(Number(aglMeters))
                    ? '~' + Math.round(Number(aglMeters)) + ' m (terrain vs MSL)'
                    : null
            ],
            ['Track', trk],
            ['Speed (raw)', spd],
            ['Climb (raw)', clb]
        ];

        let table = '<table class="airspace-popup-table">';
        for (let r = 0; r < rows.length; r++) {
            if (rows[r] == null || rows[r][1] == null) continue;
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
            escapeHtml(cs || id || 'OGN target') +
            '</div>' +
            '<div class="airspace-popup-sub">OGN · ' +
            escapeHtml(id) +
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
        selectedTrailKind = null;
        selectedTrailKey = null;
    }

    /**
     * @param {'adsb'|'ogn'} kind
     * @param {string} key - ICAO hex (ADS-B) or OGN device id
     */
    function showSelectedTrail(kind, key) {
        clearSelectedTrail();
        const pts = kind === 'ogn' ? trailByOgnId.get(key) : trailByHex.get(key);
        if (!pts || pts.length < 2) return;
        selectedTrailKind = kind;
        selectedTrailKey = key;
        const color = kind === 'ogn' ? '#22d3ee' : '#fb7185';
        selectedTrailPolyline = L.polyline(pts, {
            color: color,
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
     * 2–4) Public relays (Python http.server / Live Server have no /api; 404 here)
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

    const OGN_LIVE_LXML = 'https://live.glidernet.org/lxml.php';

    function buildOgnQueryString(bounds) {
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        return new URLSearchParams({
            a: '0',
            b: ne.lat.toFixed(6),
            c: sw.lat.toFixed(6),
            d: ne.lng.toFixed(6),
            e: sw.lng.toFixed(6),
            z: '0'
        }).toString();
    }

    function buildOgnUpstreamUrl(bounds) {
        return OGN_LIVE_LXML + '?' + buildOgnQueryString(bounds);
    }

    /**
     * Same-origin /api/ogn then CORS relays (XML body as text; allorigins wraps JSON).
     */
    function fetchTextWithProxy(upstreamUrl, sameOriginQueryString) {
        const sameOrigin = '/api/ogn?' + sameOriginQueryString;

        return fetch(sameOrigin, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store'
        })
            .then(function (res) {
                if (res.ok) return res.text();
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
                            return data.contents;
                        }
                        throw new Error('allorigins_parse');
                    });
            })
            .catch(function () {
                return fetch('https://corsproxy.io/?' + encodeURIComponent(upstreamUrl), {
                    method: 'GET',
                    credentials: 'omit',
                    cache: 'no-store'
                }).then(function (res) {
                    if (!res.ok) throw new Error('corsproxy');
                    return res.text();
                });
            })
            .catch(function () {
                throw new Error('no_proxy');
            });
    }

    function fetchOgnXmlForBounds(bounds) {
        const qs = buildOgnQueryString(bounds);
        const upstream = buildOgnUpstreamUrl(bounds);
        return fetchTextWithProxy(upstream, qs);
    }

    /**
     * @param {string|null} attr - OGN <m a="…"/> comma-separated payload
     * @returns {{id:string,lat:number,lon:number,altM:number|null,speed:number|null,track:number|null,climb:number|null,callsign:string}|null}
     */
    function parseOgnMarkerAttribute(attr) {
        if (attr == null || attr === '') return null;
        const parts = String(attr).split(',');
        if (parts.length < 5) return null;
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        let deviceId = '';
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i].trim();
            if (/^[0-9a-fA-F]{6,8}$/.test(p)) {
                deviceId = p.toLowerCase();
                break;
            }
        }
        if (!deviceId) return null;

        let altM = null;
        for (let i = 2; i < Math.min(parts.length, 14); i++) {
            const raw = parts[i].trim();
            if (/^[0-9a-fA-F]{6,8}$/i.test(raw)) continue;
            if (!/^-?\d+$/.test(raw)) continue;
            const n = parseInt(raw, 10);
            if (n >= 0 && n <= 20000) {
                altM = n;
                break;
            }
        }

        let timeIdx = -1;
        for (let i = 2; i < parts.length; i++) {
            if (/^\d{1,2}:\d{2}:\d{2}$/.test(parts[i].trim())) {
                timeIdx = i;
                break;
            }
        }
        let speed = null;
        let track = null;
        let climb = null;
        if (timeIdx >= 0 && timeIdx + 3 < parts.length) {
            const sp = parseInt(parts[timeIdx + 1], 10);
            if (isFinite(sp)) speed = sp;
            const tr = parseInt(parts[timeIdx + 2], 10);
            if (isFinite(tr)) track = tr;
            const cl = parseFloat(parts[timeIdx + 3]);
            if (isFinite(cl)) climb = cl;
        }

        let callsign = '';
        for (let i = 2; i < parts.length; i++) {
            const t = parts[i].trim();
            if (
                t.length >= 2 &&
                t.length <= 12 &&
                /^[A-Za-z0-9][A-Za-z0-9\-]*$/.test(t) &&
                !/^\d{1,2}:\d{2}/.test(t) &&
                !/^[0-9a-fA-F]{6,8}$/i.test(t) &&
                !/^-?\d+$/.test(t)
            ) {
                if (t.length > callsign.length) callsign = t;
            }
        }
        if (!callsign) callsign = deviceId;

        return {
            id: deviceId,
            lat: lat,
            lon: lon,
            altM: altM,
            speed: speed,
            track: track,
            climb: climb,
            callsign: callsign
        };
    }

    function parseOgnXml(xmlText) {
        if (!xmlText || typeof xmlText !== 'string') return [];
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        if (doc.querySelector('parsererror')) return [];
        const nodes = doc.querySelectorAll('markers > m');
        const out = [];
        for (let i = 0; i < nodes.length; i++) {
            const rec = parseOgnMarkerAttribute(nodes[i].getAttribute('a'));
            if (rec) out.push(rec);
        }
        return out;
    }

    /**
     * @param {function(number|null):void} cb - metres AGL or null
     */
    function computeAglMeters(a, cb) {
        const token = getMapboxToken();
        if (!aglEnabled || !token || typeof Elevation === 'undefined') {
            cb(null);
            return;
        }
        const pos = positionLatLon(a);
        if (!pos) {
            cb(null);
            return;
        }
        const mslFt = aircraftMslFt(a);
        if (mslFt == null) {
            cb(null);
            return;
        }
        Elevation.getElevationAtLatLng(pos.lat, pos.lon, token).then(function (terrainM) {
            if (terrainM == null || Number.isNaN(Number(terrainM))) {
                cb(null);
                return;
            }
            cb(mslFt * 0.3048 - Number(terrainM));
        });
    }

    function scheduleAglForList(ac, renderGen) {
        const token = getMapboxToken();
        if (!aglEnabled || !token || typeof Elevation === 'undefined' || !trafficLayer) {
            return;
        }
        if (!ac || !ac.length) return;
        for (let i = 0; i < ac.length; i++) {
            const a = ac[i];
            const hex = normalizeHex(a.hex);
            if (hex.length !== 6) continue;
            (function (aircraft, hexKey) {
                computeAglMeters(aircraft, function (aglM) {
                    if (renderGen !== airspaceRenderGen) return;
                    if (aglM == null) return;
                    trafficLayer.eachLayer(function (layer) {
                        if (layer._airspaceHex !== hexKey) return;
                        layer.setIcon(trafficAircraftDivIcon(aircraft, aglM));
                    });
                });
            })(a, hex);
        }
    }

    function scheduleAglForOgnList(list, renderGen) {
        const token = getMapboxToken();
        if (!aglEnabled || !token || typeof Elevation === 'undefined' || !ognLayer) {
            return;
        }
        if (!list || !list.length) return;
        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (!rec || !rec.id) continue;
            const pseudo = pseudoAircraftFromOgn(rec);
            if (!pseudo) continue;
            (function (r, idKey) {
                computeAglMeters(pseudo, function (aglM) {
                    if (renderGen !== airspaceRenderGen) return;
                    if (aglM == null) return;
                    ognLayer.eachLayer(function (layer) {
                        if (layer._airspaceOgnId !== idKey) return;
                        layer.setIcon(ognTrafficDivIcon(r, aglM));
                    });
                });
            })(rec, rec.id);
        }
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
        const renderGen = ++airspaceRenderGen;
        clearTraffic();
        recordTrailsFromList(ac);
        if (!ac || !ac.length) {
            if (pinnedHex) {
                trafficPopupOpen = false;
                pinnedHex = null;
                pinnedOgnId = null;
                clearSelectedTrail();
            }
            return 0;
        }

        const bounds = map.getBounds();
        let count = 0;

        for (let i = 0; i < ac.length; i++) {
            const a = ac[i];
            const pos = positionLatLon(a);
            if (!pos) continue;
            if (!bounds.contains(L.latLng(pos.lat, pos.lon))) continue;

            const hex = normalizeHex(a.hex);
            if (hex.length !== 6) continue;

            const icon = trafficAircraftDivIcon(a, undefined);

            const m = L.marker([pos.lat, pos.lon], { icon: icon, interactive: true }).addTo(trafficLayer);
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

            m.on('popupopen', function () {
                trafficPopupOpen = true;
                pinnedHex = hex;
                pinnedOgnId = null;
                showSelectedTrail('adsb', hex);
                setStatus(
                    '<strong>Details open</strong> · auto-refresh paused until you close.',
                    false
                );
                fetchAdsbHex(hex)
                    .then(function (data) {
                        const list = aircraftListFromResponse(data);
                        const ac0 = list[0];
                        const el = document.getElementById(popupId);
                        if (!el || !ac0) return;
                        const trailPts = trailByHex.get(hex) || [];
                        el.innerHTML = buildPopupHtml(ac0, trailPts);
                        computeAglMeters(ac0, function (agl) {
                            const el2 = document.getElementById(popupId);
                            if (!el2 || !trafficPopupOpen || pinnedHex !== hex) return;
                            el2.innerHTML = buildPopupHtml(ac0, trailPts, agl);
                        });
                    })
                    .catch(function () {});
            });

            m.on('popupclose', function () {
                if (suppressTrafficPopupClose) return;
                trafficPopupOpen = false;
                pinnedHex = null;
                pinnedOgnId = null;
                clearSelectedTrail();
                lastFetchAt = 0;
                fetchTraffic();
            });

            count++;
        }

        scheduleAglForList(ac, renderGen);

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
                pinnedOgnId = null;
                clearSelectedTrail();
            }
        }

        return count;
    }

    function renderOgnList(list) {
        const renderGen = ++airspaceRenderGen;
        clearOgnTraffic();
        recordOgnTrailsFromList(list);
        if (!list || !list.length) {
            if (pinnedOgnId) {
                trafficPopupOpen = false;
                pinnedOgnId = null;
                pinnedHex = null;
                clearSelectedTrail();
            }
            return 0;
        }

        const bounds = map.getBounds();
        let count = 0;

        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (!rec || !rec.id) continue;
            if (!bounds.contains(L.latLng(rec.lat, rec.lon))) continue;

            const icon = ognTrafficDivIcon(rec, undefined);
            const m = L.marker([rec.lat, rec.lon], { icon: icon, interactive: true }).addTo(ognLayer);
            m._airspaceOgnId = rec.id;

            const popupId = 'airspace-ogn-popup-' + rec.id;
            const trailPts = trailByOgnId.get(rec.id) || [];
            m.bindPopup(
                '<div class="airspace-popup" id="' +
                    popupId +
                    '">' +
                    buildOgnPopupHtml(rec, trailPts) +
                    '</div>',
                trafficPopupLeafletOptions()
            );

            const ognId = rec.id;
            m.on('popupopen', function () {
                trafficPopupOpen = true;
                pinnedOgnId = ognId;
                pinnedHex = null;
                showSelectedTrail('ogn', ognId);
                setStatus(
                    '<strong>Details open</strong> · auto-refresh paused until you close.',
                    false
                );
                const pseudo = pseudoAircraftFromOgn(rec);
                if (pseudo) {
                    computeAglMeters(pseudo, function (agl) {
                        const el = document.getElementById(popupId);
                        if (!el || !trafficPopupOpen || pinnedOgnId !== ognId) return;
                        const tp = trailByOgnId.get(ognId) || [];
                        el.innerHTML = buildOgnPopupHtml(rec, tp, agl);
                    });
                }
            });

            m.on('popupclose', function () {
                if (suppressOgnPopupClose) return;
                trafficPopupOpen = false;
                pinnedOgnId = null;
                pinnedHex = null;
                clearSelectedTrail();
                lastFetchAt = 0;
                fetchTraffic();
            });

            count++;
        }

        scheduleAglForOgnList(list, renderGen);

        if (pinnedOgnId) {
            let found = false;
            ognLayer.eachLayer(function (layer) {
                if (layer._airspaceOgnId === pinnedOgnId && typeof layer.openPopup === 'function') {
                    layer.openPopup();
                    found = true;
                }
            });
            if (!found) {
                trafficPopupOpen = false;
                pinnedOgnId = null;
                pinnedHex = null;
                clearSelectedTrail();
            }
        }

        return count;
    }

    function fetchTraffic(force) {
        if ((!trafficEnabled && !ognEnabled) || !map) return;
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

        const wantAdsb = trafficEnabled;
        const wantOgn = ognEnabled;

        const c = b.getCenter();
        const lat = c.lat;
        const lon = c.lng;

        let rNm = null;
        if (wantAdsb) {
            rNm = radiusNmForMap();
            if (rNm == null) {
                setStatus('Could not compute view radius.', true);
                return;
            }
        }

        isFetching = true;
        setStatus('Loading traffic…', false);

        const pAdsb = wantAdsb
            ? fetchAdsbJson(lat, lon, rNm)
                  .then(function (data) {
                      return { ok: true, data: data };
                  })
                  .catch(function (err) {
                      return { ok: false, error: err };
                  })
            : Promise.resolve({ ok: false, skipped: true });

        const pOgn = wantOgn
            ? fetchOgnXmlForBounds(b)
                  .then(function (text) {
                      return { ok: true, text: text };
                  })
                  .catch(function (err) {
                      return { ok: false, error: err };
                  })
            : Promise.resolve({ ok: false, skipped: true });

        Promise.all([pAdsb, pOgn])
            .then(function (pair) {
                lastFetchAt = Date.now();
                const adRes = pair[0];
                const ognRes = pair[1];

                let nAdsb = 0;
                let nOgn = 0;
                let adsbTime = '-';

                if (wantAdsb) {
                    if (adRes.ok && adRes.data) {
                        const list = aircraftListFromResponse(adRes.data);
                        lastAircraftList = list.slice();
                        nAdsb = renderAircraftList(list);
                        adsbTime = formatTime(
                            adRes.data.now != null ? adRes.data.now : adRes.data.ctime
                        );
                    } else if (!adRes.skipped) {
                        lastAircraftList = [];
                        renderAircraftList([]);
                    }
                }

                if (wantOgn) {
                    if (ognRes.ok && ognRes.text) {
                        const ognList = parseOgnXml(ognRes.text);
                        lastOgnList = ognList;
                        nOgn = renderOgnList(ognList);
                    } else if (!ognRes.skipped) {
                        lastOgnList = [];
                        renderOgnList([]);
                    }
                }

                const bits = [];
                let hasErr = false;
                if (wantAdsb) {
                    if (adRes.ok) {
                        bits.push('<strong>' + nAdsb + '</strong> ADS-B');
                    } else {
                        hasErr = true;
                        bits.push(
                            adRes.error && adRes.error.message === 'no_proxy'
                                ? 'ADS-B: no proxy'
                                : 'ADS-B: failed'
                        );
                    }
                }
                if (wantOgn) {
                    if (ognRes.ok) {
                        bits.push('<strong>' + nOgn + '</strong> OGN');
                    } else {
                        hasErr = true;
                        bits.push(
                            ognRes.error && ognRes.error.message === 'no_proxy'
                                ? 'OGN: no proxy'
                                : 'OGN: failed'
                        );
                    }
                }

                let detail = '';
                if (wantAdsb && adRes.ok && rNm != null) {
                    detail +=
                        '~' +
                        rNm.toFixed(0) +
                        ' NM · ADSB.lol' +
                        (adsbTime !== '-' ? ' · data ' + escapeHtml(adsbTime) : '');
                }
                if (wantAdsb && wantOgn && detail) detail += ' · ';
                if (wantOgn && ognRes.ok) {
                    detail += 'OGN live';
                }
                if (detail) detail += ' · ';
                detail += 'refresh ~1s';

                const summary = bits.length ? bits.join(' · ') + ' in view · ' + detail : detail;

                const adsbNoProxy =
                    wantAdsb &&
                    !adRes.ok &&
                    !adRes.skipped &&
                    adRes.error &&
                    adRes.error.message === 'no_proxy';
                const ognNoProxy =
                    wantOgn &&
                    !ognRes.ok &&
                    !ognRes.skipped &&
                    ognRes.error &&
                    ognRes.error.message === 'no_proxy';

                if (adsbNoProxy || ognNoProxy) {
                    let extra = '';
                    if (wantAdsb && adRes.ok) {
                        extra += '<strong>' + nAdsb + '</strong> ADS-B in view. ';
                    }
                    if (wantOgn && ognRes.ok) {
                        extra += '<strong>' + nOgn + '</strong> OGN in view. ';
                    }
                    setStatus(
                        extra +
                            '<strong>No API proxy</strong>. Run <code>npm run serve</code> from the project folder (not <code>python -m http.server</code>) so <code>/api/adsb</code> and <code>/api/ogn</code> work. Or use the deployed site.',
                        true
                    );
                } else {
                    setStatus(summary, hasErr);
                }
            })
            .catch(function () {
                setStatus('Could not load traffic. Try again later.', true);
            })
            .finally(function () {
                isFetching = false;
            });
    }

    function scheduleFetch() {
        if (!trafficEnabled && !ognEnabled) return;
        clearTimeout(moveDebounce);
        moveDebounce = setTimeout(fetchTraffic, MOVE_DEBOUNCE_MS);
    }

    function startPolling() {
        stopPolling();
        if (!trafficEnabled && !ognEnabled) return;
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

    function peekAirspaceMapDraft() {
        try {
            var raw = localStorage.getItem(AIRSPACE_MAP_DRAFT_KEY);
            if (!raw) return null;
            var d = JSON.parse(raw);
            if (!d || d.v !== 1 || d.lat == null || d.lng == null) return null;
            return { lat: d.lat, lng: d.lng, zoom: d.zoom != null ? d.zoom : 13 };
        } catch (e) {
            return null;
        }
    }

    function scheduleAirspaceMapDraftSave() {
        if (!map) return;
        if (airspaceMapDraftTimer) clearTimeout(airspaceMapDraftTimer);
        airspaceMapDraftTimer = setTimeout(function () {
            airspaceMapDraftTimer = null;
            try {
                var c = map.getCenter();
                localStorage.setItem(
                    AIRSPACE_MAP_DRAFT_KEY,
                    JSON.stringify({
                        v: 1,
                        lat: c.lat,
                        lng: c.lng,
                        zoom: map.getZoom()
                    })
                );
            } catch (err) { /* ignore */ }
        }, 600);
    }

    function saveAirspaceMapDraftNow() {
        if (!map) return;
        try {
            var c = map.getCenter();
            localStorage.setItem(
                AIRSPACE_MAP_DRAFT_KEY,
                JSON.stringify({
                    v: 1,
                    lat: c.lat,
                    lng: c.lng,
                    zoom: map.getZoom()
                })
            );
        } catch (err) { /* ignore */ }
    }

    function tryInitialViewFromGeolocation() {
        if (!map) return;
        function applyPos(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            if (!map || !isFinite(lat) || !isFinite(lng)) return;
            map.setView([lat, lng], map.getZoom(), { animate: false });
        }
        if (typeof GeoLocate !== 'undefined' && GeoLocate.getCurrentPositionRobust) {
            GeoLocate.getCurrentPositionRobust(applyPos, function () {
                /* keep DEFAULT_MAP_CENTER */
            });
            return;
        }
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(applyPos, function () {}, GEO_INITIAL_OPTIONS);
    }

    function initMap() {
        var draftView = peekAirspaceMapDraft();
        var initCenter = draftView ? [draftView.lat, draftView.lng] : DEFAULT_MAP_CENTER;
        var initZoom = draftView && draftView.zoom != null ? draftView.zoom : 13;
        map = L.map('map', {
            center: initCenter,
            zoom: initZoom,
            zoomControl: true
        });

        trafficLayer = L.layerGroup().addTo(map);
        ognLayer = L.layerGroup().addTo(map);

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
            var geoOkAs = typeof GeoLocate === 'undefined' || GeoLocate.isGeolocationEnvironmentOk();
            if (geoOkAs) {
                var locateOptsAs =
                    typeof GeoLocate !== 'undefined' && GeoLocate.leafletLocateOptions
                        ? GeoLocate.leafletLocateOptions()
                        : { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
                L.control.locate({
                    position: 'topleft',
                    strings: {
                        title: 'Show my location',
                        popup: 'You are within {distance} from this point',
                        outsideMapBoundsMsg: 'You seem located outside the boundaries of the map'
                    },
                    locateOptions: locateOptsAs
                }).addTo(map);
            }
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
        map.on('moveend', scheduleAirspaceMapDraftSave);

        document.addEventListener('visibilitychange', function () {
            if (
                document.visibilityState === 'visible' &&
                (trafficEnabled || ognEnabled) &&
                !trafficPopupOpen
            ) {
                lastFetchAt = 0;
                fetchTraffic();
            }
        });

        if (!draftView) {
            tryInitialViewFromGeolocation();
        }
    }

    function wireUi() {
        const toggle = document.getElementById('airspaceTrafficToggle');
        const refreshBtn = document.getElementById('airspaceRefreshBtn');
        const helpToggle = document.getElementById('airspaceHelpToggle');
        const helpClose = document.getElementById('airspaceHelpClose');
        const helpWrap = document.getElementById('airspaceHelpPanelWrap');
        const helpBody = document.getElementById('airspaceHelpBody');
        const aglToggle = document.getElementById('airspaceAglToggle');
        const aglHint = document.getElementById('airspaceAglHint');

        if (helpBody) {
            helpBody.innerHTML = HELP_HTML;
        }

        function syncAglControls() {
            const tokenOk = !!getMapboxToken() && typeof Elevation !== 'undefined';
            if (!tokenOk) {
                aglEnabled = false;
            }
            if (aglToggle) {
                aglToggle.disabled = !tokenOk;
                aglToggle.checked = tokenOk && aglEnabled;
            }
            if (aglHint) {
                aglHint.style.display = tokenOk ? 'none' : '';
            }
        }
        syncAglControls();

        if (aglToggle) {
            aglToggle.addEventListener('change', function () {
                const tokenOk = !!getMapboxToken() && typeof Elevation !== 'undefined';
                if (!tokenOk) {
                    aglToggle.checked = false;
                    return;
                }
                aglEnabled = !!aglToggle.checked;
                airspaceRenderGen++;
                if (lastAircraftList.length) {
                    renderAircraftList(lastAircraftList.slice());
                }
                if (ognEnabled && lastOgnList.length) {
                    renderOgnList(lastOgnList.slice());
                }
            });
        }

        const ognToggle = document.getElementById('airspaceOgnToggle');
        if (ognToggle) {
            ognToggle.checked = ognEnabled;
            ognToggle.addEventListener('change', function () {
                ognEnabled = !!ognToggle.checked;
                try {
                    localStorage.setItem(OGN_STORAGE_KEY, ognEnabled ? '1' : '0');
                } catch (e) {}
                if (!ognEnabled) {
                    clearOgnTraffic();
                    if (pinnedOgnId) {
                        trafficPopupOpen = false;
                        pinnedOgnId = null;
                        pinnedHex = null;
                        clearSelectedTrail();
                    }
                }
                if (trafficEnabled || ognEnabled) {
                    startPolling();
                } else {
                    stopPolling();
                    trafficPopupOpen = false;
                    pinnedHex = null;
                    pinnedOgnId = null;
                    clearTraffic();
                    clearOgnTraffic();
                    clearSelectedTrail();
                    setStatus(
                        'ADS-B and OGN are off. Enable <strong>Show traffic</strong> and/or <strong>OGN</strong> to load data.',
                        false
                    );
                }
            });
        }

        if (toggle) {
            toggle.checked = trafficEnabled;
            toggle.addEventListener('change', function () {
                trafficEnabled = toggle.checked;
                if (!trafficEnabled) {
                    clearTraffic();
                    if (pinnedHex) {
                        trafficPopupOpen = false;
                        pinnedHex = null;
                        pinnedOgnId = null;
                        clearSelectedTrail();
                    }
                }
                if (trafficEnabled || ognEnabled) {
                    startPolling();
                } else {
                    stopPolling();
                    trafficPopupOpen = false;
                    pinnedHex = null;
                    pinnedOgnId = null;
                    clearTraffic();
                    clearOgnTraffic();
                    clearSelectedTrail();
                    setStatus(
                        'ADS-B and OGN are off. Enable <strong>Show traffic</strong> and/or <strong>OGN</strong> to load data.',
                        false
                    );
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
        window.addEventListener('pagehide', saveAirspaceMapDraftNow);
        startPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
