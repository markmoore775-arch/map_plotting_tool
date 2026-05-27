/* ============================================
   DJI MISSION PLANNER - Flight Planning for M4T
   Exports WPML KMZ for DJI Pilot 2
   ============================================ */

(function () {
    'use strict';

    let map;
    let waypoints = [];      // { lat, lng, index }
    let exclusions = [];     // { type: 'rectangle'|'circle', latlngs, center, radius }
    let waypointMarkers = [];
    let exclusionLayers = [];
    let exclusionRadialGroups = [];  // { line, centerDot, label, handle } for circles
    let waypointMode = false;
    let undoStack = [];
    const R = 6371000; // Earth radius in metres

    // Manual Recce mode: POI + exclusion fence for overlay (no auto-flight)
    const RECCE_DEFAULT_RADIUS = 300;
    let recceMode = true;    // default to Manual Recce
    let recceTarget = null;  // { lat, lng } | null
    let recceRadius = RECCE_DEFAULT_RADIUS;
    let reccePoiMarker = null;
    let recceExclusionLayer = null;
    let recceAddTargetMode = false;

    const FP_DRAFT_STORAGE_KEY = 'airplotFlightPlanningDraft_v1';
    let fpDraftSaveTimer = null;
    let fpDraftLoadInProgress = false;

    // Default mission params (M4T - use M350 RTK enum as fallback; verify for M4T)
    const MISSION_DEFAULTS = {
        droneEnumValue: 89,      // M350 RTK - M4T may need different value
        droneSubEnumValue: 0,
        payloadEnumValue: 83,   // H30T - adjust for M4T payload
        payloadPositionIndex: 0,
        executeHeight: 60,      // metres
        waypointSpeed: 10,
        takeOffSecurityHeight: 20,
        globalTransitionalSpeed: 10
    };

    // ---- Geo helpers ----
    function destinationPoint(lat, lng, bearing, distance) {
        const d = distance / R;
        const brng = bearing * Math.PI / 180;
        const lat1 = lat * Math.PI / 180;
        const lon1 = lng * Math.PI / 180;
        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(d) +
            Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
        );
        const lon2 = lon1 + Math.atan2(
            Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
            Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
        );
        return [
            lat2 * 180 / Math.PI,
            ((lon2 * 180 / Math.PI) + 540) % 360 - 180
        ];
    }

    function bearingTo(lat1, lng1, lat2, lng2) {
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const la1 = lat1 * Math.PI / 180;
        const la2 = lat2 * Math.PI / 180;
        const y = Math.sin(dLng) * Math.cos(la2);
        const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
        return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }

    function pointAlongRadius(center, edgePt, ratio) {
        return [
            center[0] + ratio * (edgePt[0] - center[0]),
            center[1] + ratio * (edgePt[1] - center[1])
        ];
    }

    function projectOntoRadius(center, edgePt, pos) {
        const dx = edgePt[0] - center[0];
        const dy = edgePt[1] - center[1];
        const px = pos.lat - center[0];
        const py = pos.lng - center[1];
        const denom = dx * dx + dy * dy;
        const t = denom ? (px * dx + py * dy) / denom : 0.5;
        return Math.max(0.05, Math.min(0.95, t));
    }

    function getRadiusText(radius) {
        if (radius >= 1000) return `${(radius / 1000).toFixed(2)} km`;
        return `${Math.round(radius)} m`;
    }

    function makeRadialLabelIcon(text) {
        return L.divIcon({
            className: 'radial-label-marker radial-label-draggable',
            html: `<div class="radial-measurement-label">${String(text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`,
            iconSize: null,
            iconAnchor: [0, 14]
        });
    }

    // ---- Manual Recce ----
    function generateCircleLatlngs(centerLat, centerLng, radiusM) {
        const latlngs = [];
        for (let i = 0; i <= 36; i++) {
            latlngs.push(destinationPoint(centerLat, centerLng, (i * 10) % 360, radiusM));
        }
        return latlngs;
    }

    function setRecceTarget(lat, lng, skipUndo) {
        if (!skipUndo) pushUndo();
        recceTarget = { lat, lng };
        if (reccePoiMarker) map.removeLayer(reccePoiMarker);
        if (recceExclusionLayer) map.removeLayer(recceExclusionLayer);

        const poiIcon = L.divIcon({
            className: 'recce-poi-marker',
            html: '<div class="recce-poi-diamond"></div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });
        reccePoiMarker = L.marker([lat, lng], { icon: poiIcon })
            .addTo(map)
            .bindTooltip('Target (POI)', { permanent: false, direction: 'top' });

        const latlngs = generateCircleLatlngs(lat, lng, recceRadius);
        recceExclusionLayer = L.polygon(latlngs, {
            color: '#e05555',
            fillColor: '#e05555',
            fillOpacity: 0.25,
            weight: 2
        }).addTo(map);

        updateRecceUI();
    }

    function clearRecceTarget() {
        recceTarget = null;
        if (reccePoiMarker) { map.removeLayer(reccePoiMarker); reccePoiMarker = null; }
        if (recceExclusionLayer) { map.removeLayer(recceExclusionLayer); recceExclusionLayer = null; }
        updateRecceUI();
    }

    function updateRecceRadius(newRadius) {
        recceRadius = Math.max(10, Math.min(5000, newRadius));
        if (recceTarget && recceExclusionLayer) {
            const latlngs = generateCircleLatlngs(recceTarget.lat, recceTarget.lng, recceRadius);
            recceExclusionLayer.setLatLngs(latlngs);
        }
        const input = document.getElementById('fpRecceRadiusInput');
        if (input) input.value = recceRadius;
        scheduleFlightPlanningDraftSave();
    }

    function updateRecceUI() {
        const addBtn = document.getElementById('fpRecceTargetBtn');
        const radiusWrap = document.getElementById('fpRecceRadiusWrap');
        const exportRecceBtn = document.getElementById('fpExportRecceBtn');
        const recceInfo = document.getElementById('fpRecceInfo');
        const waypointCount = document.getElementById('fpWaypointCount');
        const exclusionCount = document.getElementById('fpExclusionCount');
        if (addBtn) addBtn.classList.toggle('active', recceAddTargetMode);
        if (radiusWrap) radiusWrap.classList.toggle('hidden', !recceTarget);
        if (exportRecceBtn) exportRecceBtn.disabled = !recceTarget;
        if (recceInfo) {
            recceInfo.classList.toggle('hidden', !recceMode || !recceTarget);
            recceInfo.textContent = recceTarget ? '1 target' : '';
        }
        if (recceMode) {
            if (waypointCount) waypointCount.classList.add('hidden');
            if (exclusionCount) exclusionCount.classList.add('hidden');
        } else {
            if (waypointCount) waypointCount.classList.remove('hidden');
            if (exclusionCount) exclusionCount.classList.remove('hidden');
        }
    }

    function buildRecceKml() {
        if (!recceTarget) return '';
        const latlngs = generateCircleLatlngs(recceTarget.lat, recceTarget.lng, recceRadius);
        // DJI Pilot 2 requires altitude for each coordinate; use 0 for relativeToGround
        const coords = latlngs.map(ll => `${ll[1]},${ll[0]},0`).join(' ');
        // Single polygon only - DJI rejects multiple placemarks (Point + Polygon)
        // Structure matches DJI Pilot 2 expectations: tessellate, altitudeMode, coordinates with Z
        return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Recce Mission</name>
    <Placemark>
      <name>${recceRadius}m Exclusion Zone</name>
      <description>Recce target at ${recceTarget.lat.toFixed(6)}, ${recceTarget.lng.toFixed(6)}. Use as overlay in DJI Pilot 2.</description>
      <Style>
        <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
        <PolyStyle><color>4dff0000</color><outline>1</outline></PolyStyle>
      </Style>
      <Polygon>
        <tessellate>1</tessellate>
        <altitudeMode>relativeToGround</altitudeMode>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
    }

    async function exportRecceKmz() {
        if (!recceTarget) {
            alert('Add a target first by clicking the map.');
            return;
        }
        const zip = new JSZip();
        zip.file('doc.kml', buildRecceKml());
        const blob = await zip.generateAsync({ type: 'blob' });
        const defaultName = 'Recce_Mission.kmz';

        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: defaultName,
                    types: [{
                        description: 'KMZ file',
                        accept: { 'application/vnd.google-earth.kmz': ['.kmz'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                openSdCardModal(true);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error(err);
                    alert('Failed to save file.');
                }
            }
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultName;
            a.click();
            URL.revokeObjectURL(url);
            openSdCardModal(true);
        }
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
            maxZoom: 19,
            crossOrigin: true
        });
        const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors, SRTM',
            maxZoom: 17,
            crossOrigin: true
        });
        const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '&copy; Esri, Maxar',
            maxZoom: 18,
            crossOrigin: true
        });

        osm.addTo(map);
        L.control.layers(
            { 'OpenStreetMap': osm, 'Topographic': topo, 'Satellite': satellite },
            null, { position: 'topright' }
        ).addTo(map);

        if (typeof L.control.locate === 'function') {
            var geoOkFp = typeof GeoLocate === 'undefined' || GeoLocate.isGeolocationEnvironmentOk();
            if (geoOkFp) {
                var locateOptsFp =
                    typeof GeoLocate !== 'undefined' && GeoLocate.leafletLocateOptions
                        ? GeoLocate.leafletLocateOptions()
                        : { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
                L.control.locate({
                    position: 'topleft',
                    strings: { title: 'Show my location' },
                    locateOptions: locateOptsFp
                }).addTo(map);
            }
        }

        // Geoman for rectangle and circle
        map.pm.addControls({
            position: 'topleft',
            drawMarker: false,
            drawCircleMarker: false,
            drawText: false,
            drawCircle: false,
            drawRectangle: false,
            drawPolygon: false,
            drawPolyline: false,
            cutPolygon: false,
            rotateMode: false,
            editMode: false,
            dragMode: false,
            removalMode: false
        });

        map.pm.setPathOptions({
            color: '#e05555',
            fillColor: '#e05555',
            fillOpacity: 0.25,
            weight: 2
        });

        map.on('pm:create', onExclusionCreated);

        if (typeof Notam !== 'undefined' && Notam.init) {
            const fpNotamModule = Notam.init({ map });
            const FpNotamControl = L.Control.extend({
                options: { position: 'bottomleft' },
                onAdd: function () {
                    const root = L.DomUtil.create('div', 'fp-notam-control leaflet-control');
                    L.DomEvent.disableClickPropagation(root);
                    const mainRow = L.DomUtil.create('div', 'fp-notam-control-main', root);
                    const toggleLabel = L.DomUtil.create('label', 'fp-notam-toggle-label', mainRow);
                    const notamCb = L.DomUtil.create('input', '', toggleLabel);
                    notamCb.type = 'checkbox';
                    toggleLabel.appendChild(document.createTextNode(' NOTAM'));
                    const expandBtn = L.DomUtil.create('button', 'fp-notam-expand', mainRow);
                    expandBtn.type = 'button';
                    expandBtn.title = 'NOTAM options';
                    expandBtn.textContent = '\u25BC';
                    expandBtn.style.display = 'none';
                    const optsEl = L.DomUtil.create('div', 'fp-notam-options', root);
                    optsEl.style.display = 'none';
                    L.DomEvent.on(expandBtn, 'click', function (e) {
                        L.DomEvent.stop(e);
                        const open = optsEl.style.display !== 'none';
                        optsEl.style.display = open ? 'none' : 'block';
                        expandBtn.textContent = open ? '\u25BC' : '\u25B2';
                    });
                    const maxRow = L.DomUtil.create('div', 'fp-notam-opt-row', optsEl);
                    const maxLbl = L.DomUtil.create('span', 'fp-notam-opt-lbl', maxRow);
                    maxLbl.textContent = 'Max radius ';
                    const maxSel = L.DomUtil.create('select', 'fp-notam-select', maxRow);
                    [
                        [5, '5 NM'],
                        [10, '10 NM'],
                        [12, '12 NM'],
                        [20, '20 NM'],
                        [50, '50 NM'],
                        [999, 'All']
                    ].forEach(function (pair) {
                        const op = L.DomUtil.create('option', '', maxSel);
                        op.value = String(pair[0]);
                        op.textContent = pair[1];
                        if (pair[0] === 12) op.selected = true;
                    });
                    L.DomEvent.on(maxSel, 'change', function () {
                        fpNotamModule.setOptions({ maxRadius: parseInt(maxSel.value, 10) });
                    });
                    const droneRow = L.DomUtil.create('div', 'fp-notam-opt-row', optsEl);
                    const droneLbl = L.DomUtil.create('label', 'fp-notam-check', droneRow);
                    const droneCb = L.DomUtil.create('input', '', droneLbl);
                    droneCb.type = 'checkbox';
                    droneCb.checked = true;
                    droneLbl.title = 'Drone-focused: UAS/hazard keywords, UAS check, and event/restriction triage';
                    droneLbl.appendChild(document.createTextNode(' Drone-focused'));
                    L.DomEvent.on(droneCb, 'change', function () {
                        fpNotamModule.setOptions({ droneRelevantOnly: droneCb.checked });
                    });
                    const adRow = L.DomUtil.create('div', 'fp-notam-opt-row', optsEl);
                    const adLbl = L.DomUtil.create('label', 'fp-notam-check', adRow);
                    const adCb = L.DomUtil.create('input', '', adLbl);
                    adCb.type = 'checkbox';
                    adCb.checked = true;
                    adLbl.appendChild(document.createTextNode(' Hide airfield ops'));
                    L.DomEvent.on(adCb, 'change', function () {
                        fpNotamModule.setOptions({ hideAerodromeGround: adCb.checked });
                    });
                    const ceilRow = L.DomUtil.create('div', 'fp-notam-opt-row', optsEl);
                    const ceilLbl = L.DomUtil.create('label', 'fp-notam-check', ceilRow);
                    const ceilCb = L.DomUtil.create('input', '', ceilLbl);
                    ceilCb.type = 'checkbox';
                    ceilCb.checked = true;
                    ceilLbl.title =
                        'Hide NOTAMs whose Q-line lower limit is entirely above 600 ft (SFC–600 ft band). Unknown Q-line: kept.';
                    ceilLbl.appendChild(document.createTextNode(' Hide above 600 ft (Q-line)'));
                    L.DomEvent.on(ceilCb, 'change', function () {
                        fpNotamModule.setOptions({ hideAboveDroneCeiling: ceilCb.checked });
                    });
                    const opRow = L.DomUtil.create('div', 'fp-notam-opt-row', optsEl);
                    const opLbl = L.DomUtil.create('label', 'fp-notam-opacity-lbl', opRow);
                    opLbl.textContent = 'Opacity ';
                    const opRg = L.DomUtil.create('input', '', opLbl);
                    opRg.type = 'range';
                    opRg.min = '0.03';
                    opRg.max = '0.2';
                    opRg.step = '0.01';
                    opRg.value = '0.08';
                    L.DomEvent.on(opRg, 'input', function () {
                        fpNotamModule.setOptions({ fillOpacity: parseFloat(opRg.value) });
                    });
                    fpNotamModule.setOptions({
                        droneRelevantOnly: true,
                        hideAerodromeGround: true,
                        hideAboveDroneCeiling: true,
                        droneCeilingFt: 600
                    });
                    L.DomEvent.on(notamCb, 'change', function () {
                        if (notamCb.checked) {
                            expandBtn.style.display = '';
                            fpNotamModule.loadNotams(function () {
                                fpNotamModule.addToMap();
                            });
                        } else {
                            fpNotamModule.removeFromMap();
                            expandBtn.style.display = 'none';
                            optsEl.style.display = 'none';
                            expandBtn.textContent = '\u25BC';
                        }
                    });
                    return root;
                }
            });
            map.addControl(new FpNotamControl());
        }
    }

    // ---- Waypoints ----
    function pushUndo() {
        undoStack.push({
            waypoints: waypoints.map(w => ({ ...w })),
            exclusions: exclusions.map(e => ({
                ...e,
                latlngs: e.latlngs ? e.latlngs.map(ll => [...ll]) : undefined,
                center: e.center ? [...e.center] : undefined
            })),
            recceTarget: recceTarget ? { ...recceTarget } : null,
            recceRadius
        });
        document.getElementById('fpUndoBtn').disabled = undoStack.length === 0;
        scheduleFlightPlanningDraftSave();
    }

    function cloneExclusionsForStorage() {
        return exclusions.map(e => ({
            type: e.type,
            latlngs: e.latlngs ? e.latlngs.map(ll => [...ll]) : undefined,
            center: e.center ? [...e.center] : undefined,
            radius: e.radius,
            measureAngle: e.measureAngle,
            measureLabelRatio: e.measureLabelRatio
        }));
    }

    function scheduleFlightPlanningDraftSave() {
        if (fpDraftLoadInProgress || !map) return;
        if (fpDraftSaveTimer) clearTimeout(fpDraftSaveTimer);
        fpDraftSaveTimer = setTimeout(() => {
            fpDraftSaveTimer = null;
            saveFlightPlanningDraftNow();
        }, 400);
    }

    function saveFlightPlanningDraftNow() {
        if (fpDraftLoadInProgress || !map) return;
        try {
            const c = map.getCenter();
            localStorage.setItem(FP_DRAFT_STORAGE_KEY, JSON.stringify({
                v: 1,
                recceMode,
                recceTarget: recceTarget ? { ...recceTarget } : null,
                recceRadius,
                waypoints: waypoints.map(w => ({ lat: w.lat, lng: w.lng, index: w.index })),
                exclusions: cloneExclusionsForStorage(),
                mission: { ...MISSION_DEFAULTS },
                mapLat: c.lat,
                mapLng: c.lng,
                mapZoom: map.getZoom()
            }));
        } catch (_) { /* ignore */ }
    }

    function loadFlightPlanningDraft() {
        let raw;
        try {
            raw = localStorage.getItem(FP_DRAFT_STORAGE_KEY);
        } catch (_) {
            setRecceMode(recceMode);
            return;
        }
        if (!raw) {
            setRecceMode(recceMode);
            return;
        }
        let d;
        try {
            d = JSON.parse(raw);
        } catch (_) {
            setRecceMode(recceMode);
            return;
        }
        if (!d || d.v !== 1) {
            setRecceMode(recceMode);
            return;
        }

        fpDraftLoadInProgress = true;
        try {
            if (d.mission && typeof d.mission === 'object') {
                Object.assign(MISSION_DEFAULTS, d.mission);
            }
            recceMode = !!d.recceMode;

            clearRecceTarget();
            waypointMarkers.forEach(m => map.removeLayer(m));
            waypointMarkers = [];
            exclusions.forEach((_, i) => removeCircleRadialMeasurement(i));
            exclusionLayers.forEach(l => map.removeLayer(l));
            exclusions = [];
            exclusionLayers = [];
            exclusionRadialGroups = [];
            waypoints = [];
            undoStack = [];

            if (recceMode && d.recceTarget && d.recceTarget.lat != null && d.recceTarget.lng != null) {
                recceRadius = d.recceRadius != null
                    ? Math.max(10, Math.min(5000, d.recceRadius))
                    : RECCE_DEFAULT_RADIUS;
                setRecceTarget(d.recceTarget.lat, d.recceTarget.lng, true);
            } else {
                recceRadius = d.recceRadius != null
                    ? Math.max(10, Math.min(5000, d.recceRadius))
                    : RECCE_DEFAULT_RADIUS;
            }

            waypoints = (d.waypoints || []).map((w, i) => ({
                lat: w.lat,
                lng: w.lng,
                index: i
            }));

            exclusions = (d.exclusions || []).map(exc => ({
                type: exc.type,
                latlngs: exc.latlngs ? exc.latlngs.map(ll => [...ll]) : undefined,
                center: exc.center ? [...exc.center] : undefined,
                radius: exc.radius,
                measureAngle: exc.measureAngle,
                measureLabelRatio: exc.measureLabelRatio
            }));

            waypoints.forEach((w, i) => {
                const m = L.circleMarker([w.lat, w.lng], {
                    radius: 8,
                    fillColor: '#0ea5e9',
                    color: '#0284c7',
                    weight: 2,
                    fillOpacity: 0.9
                }).addTo(map);
                m.bindTooltip(`WP${i}`, { permanent: true, direction: 'top', offset: [0, -10] });
                waypointMarkers.push(m);
            });

            exclusionRadialGroups = [];
            exclusions.forEach((exc, i) => {
                let layer;
                if (exc.type === 'circle' && exc.center) {
                    layer = L.circle(exc.center, { radius: exc.radius });
                    layer._exclusionIdx = i;
                    layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
                    layer.addTo(map);
                    layer.on('pm:remove', () => removeExclusion(layer));
                    if (layer.pm) layer.pm.enableLayerDrag();
                    layer.on('pm:drag', () => onCircleDrag(layer));
                    layer.on('pm:dragend', () => onCircleDragEnd(layer));
                    exclusionRadialGroups.push(null);
                    exclusionLayers.push(layer);
                    createCircleRadialMeasurement(i);
                } else if (exc.latlngs && exc.latlngs.length >= 3) {
                    layer = L.polygon(exc.latlngs);
                    layer._exclusionIdx = i;
                    layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
                    layer.addTo(map);
                    if (layer.pm) layer.pm.enableLayerDrag();
                    layer.on('pm:drag', () => {
                        const verts = layer.getLatLngs()[0];
                        if (exclusions[i]) exclusions[i].latlngs = verts.map(ll => [ll.lat, ll.lng]);
                    });
                    layer.on('pm:remove', () => removeExclusion(layer));
                    exclusionRadialGroups.push(null);
                    exclusionLayers.push(layer);
                }
            });

            if (d.mapLat != null && d.mapLng != null) {
                map.setView([d.mapLat, d.mapLng], d.mapZoom != null ? d.mapZoom : 11, { animate: false });
            }

            const ri = document.getElementById('fpRecceRadiusInput');
            if (ri) ri.value = String(recceRadius);
        } catch (e) {
            console.warn('Flight planning draft restore failed', e);
        } finally {
            fpDraftLoadInProgress = false;
        }
        setRecceMode(recceMode);
        document.getElementById('fpUndoBtn').disabled = undoStack.length === 0;
        updateCounts();
        updateRecceUI();
    }

    function addWaypoint(lat, lng) {
        pushUndo();
        const index = waypoints.length;
        waypoints.push({ lat, lng, index });

        const marker = L.circleMarker([lat, lng], {
            radius: 8,
            fillColor: '#0ea5e9',
            color: '#0284c7',
            weight: 2,
            fillOpacity: 0.9
        }).addTo(map);

        marker.bindTooltip(`WP${index}`, {
            permanent: true,
            direction: 'top',
            offset: [0, -10]
        });

        waypointMarkers.push(marker);
        updateCounts();
    }

    function removeLastWaypoint() {
        if (waypoints.length === 0) return;
        pushUndo();
        waypoints.pop();
        const m = waypointMarkers.pop();
        if (m) map.removeLayer(m);
        updateCounts();
    }

    function onMapClick(e) {
        if (recceAddTargetMode) {
            setRecceTarget(e.latlng.lat, e.latlng.lng);
            recceAddTargetMode = false;
            updateRecceUI();
        } else if (waypointMode) {
            addWaypoint(e.latlng.lat, e.latlng.lng);
        }
    }

    // ---- Exclusions (Rectangle, Circle) ----
    function onExclusionCreated(e) {
        const layer = e.layer;
        const shape = e.shape;

        if (shape === 'Rectangle' || shape === 'rectangle') {
            const latlngs = layer.getLatLngs()[0];
            if (latlngs && latlngs.length >= 3) {
                pushUndo();
                const coords = latlngs.map(ll => [ll.lat, ll.lng]);
                exclusions.push({ type: 'rectangle', latlngs: coords });
                exclusionRadialGroups.push(null);
                exclusionLayers.push(layer);
                layer._exclusionIdx = exclusions.length - 1;
                layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
                layer.on('pm:remove', () => removeExclusion(layer));
                if (layer.pm) layer.pm.enableLayerDrag();
                layer.on('pm:drag', () => {
                    const idx = layer._exclusionIdx;
                    if (idx != null && exclusions[idx]?.type === 'rectangle') {
                        const verts = layer.getLatLngs()[0];
                        exclusions[idx].latlngs = verts.map(ll => [ll.lat, ll.lng]);
                    }
                });
                updateCounts();
            }
        } else if (shape === 'Circle' || shape === 'circle') {
            const center = layer.getLatLng();
            const radius = layer.getRadius();
            pushUndo();
            const latlngs = [];
            for (let i = 0; i <= 36; i++) {
                const pt = destinationPoint(center.lat, center.lng, (i * 10) % 360, radius);
                latlngs.push(pt);
            }
            const exc = { type: 'circle', center: [center.lat, center.lng], radius, latlngs, measureAngle: 45, measureLabelRatio: 0.5 };
            exclusions.push(exc);
            exclusionLayers.push(layer);
            exclusionRadialGroups.push(null);
            layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
            layer._exclusionIdx = exclusions.length - 1;
            layer.on('pm:remove', () => removeExclusion(layer));
            if (layer.pm) layer.pm.enableLayerDrag();
            layer.on('pm:drag', () => onCircleDrag(layer));
            layer.on('pm:dragend', () => onCircleDragEnd(layer));
            createCircleRadialMeasurement(exclusions.length - 1);
            updateCounts();
        } else if (shape === 'Polygon' || shape === 'polygon') {
            const latlngs = layer.getLatLngs()[0];
            if (latlngs && latlngs.length >= 3) {
                pushUndo();
                const coords = latlngs.map(ll => [ll.lat, ll.lng]);
                exclusions.push({ type: 'polygon', latlngs: coords });
                exclusionRadialGroups.push(null);
                exclusionLayers.push(layer);
                layer._exclusionIdx = exclusions.length - 1;
                layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
                layer.on('pm:remove', () => removeExclusion(layer));
                if (layer.pm) layer.pm.enableLayerDrag();
                layer.on('pm:drag', () => {
                    const idx = layer._exclusionIdx;
                    if (idx != null && exclusions[idx]?.type === 'polygon') {
                        const verts = layer.getLatLngs()[0];
                        exclusions[idx].latlngs = verts.map(ll => [ll.lat, ll.lng]);
                    }
                });
                updateCounts();
            }
        }
    }

    function removeCircleRadialMeasurement(idx) {
        const rg = exclusionRadialGroups[idx];
        if (!rg) return;
        if (rg.line && map.hasLayer(rg.line)) map.removeLayer(rg.line);
        if (rg.centerDot && map.hasLayer(rg.centerDot)) map.removeLayer(rg.centerDot);
        if (rg.label && map.hasLayer(rg.label)) map.removeLayer(rg.label);
        if (rg.handle && map.hasLayer(rg.handle)) map.removeLayer(rg.handle);
        exclusionRadialGroups[idx] = null;
    }

    function createCircleRadialMeasurement(idx) {
        const exc = exclusions[idx];
        if (!exc || exc.type !== 'circle' || !exc.center) return;
        removeCircleRadialMeasurement(idx);

        const angle = exc.measureAngle != null ? exc.measureAngle : 45;
        const center = exc.center;
        const radius = exc.radius;
        const edgePt = destinationPoint(center[0], center[1], angle, radius);
        const labelRatio = exc.measureLabelRatio != null ? exc.measureLabelRatio : 0.5;
        const labelPt = pointAlongRadius(center, edgePt, labelRatio);

        const line = L.polyline([center, edgePt], {
            color: '#333',
            weight: 1.5,
            dashArray: '6,4',
            opacity: 0.8,
            interactive: false
        }).addTo(map);

        const centerDot = L.circleMarker(center, {
            radius: 3,
            color: '#333',
            fillColor: '#333',
            fillOpacity: 1,
            weight: 0,
            interactive: false
        }).addTo(map);

        const text = getRadiusText(radius);
        const label = L.marker(labelPt, {
            icon: makeRadialLabelIcon(text),
            draggable: true,
            zIndexOffset: 900
        }).addTo(map);

        const handleIcon = L.divIcon({
            className: 'radial-drag-handle',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });

        const handle = L.marker(edgePt, {
            icon: handleIcon,
            draggable: true,
            zIndexOffset: 1000
        }).addTo(map);

        const layer = exclusionLayers[idx];
        if (!layer) return;

        label.on('drag', (e) => {
            const pos = e.target.getLatLng();
            const currentEdge = handle.getLatLng();
            const newRatio = projectOntoRadius(center, [currentEdge.lat, currentEdge.lng], pos);
            const newLabelPt = pointAlongRadius(center, [currentEdge.lat, currentEdge.lng], newRatio);
            e.target.setLatLng(newLabelPt);
            exc.measureLabelRatio = newRatio;
        });

        label.on('dragend', () => {
            const pos = label.getLatLng();
            const currentEdge = handle.getLatLng();
            const finalRatio = projectOntoRadius(center, [currentEdge.lat, currentEdge.lng], pos);
            label.setLatLng(pointAlongRadius(center, [currentEdge.lat, currentEdge.lng], finalRatio));
            exc.measureLabelRatio = finalRatio;
        });

        handle.on('drag', (e) => {
            const pos = e.target.getLatLng();
            const newAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            const newRadius = Math.max(1, L.latLng(center).distanceTo(L.latLng(pos)));
            const newEdge = destinationPoint(center[0], center[1], newAngle, newRadius);
            const ratio = exc.measureLabelRatio != null ? exc.measureLabelRatio : 0.5;
            const newLabelPt = pointAlongRadius(center, newEdge, ratio);

            exc.radius = newRadius;
            exc.measureAngle = newAngle;
            const newLatlngs = [];
            for (let i = 0; i <= 36; i++) {
                newLatlngs.push(destinationPoint(center[0], center[1], (i * 10) % 360, newRadius));
            }
            exc.latlngs = newLatlngs;

            if (layer.setRadius) layer.setRadius(newRadius);
            e.target.setLatLng(newEdge);
            line.setLatLngs([center, newEdge]);
            label.setLatLng(newLabelPt);
            label.setIcon(makeRadialLabelIcon(getRadiusText(newRadius)));
        });

        handle.on('dragend', () => {
            const pos = handle.getLatLng();
            const finalAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            const finalRadius = Math.max(1, L.latLng(center).distanceTo(L.latLng(pos)));
            exc.radius = finalRadius;
            exc.measureAngle = finalAngle;
            const newLatlngs = [];
            for (let i = 0; i <= 36; i++) {
                newLatlngs.push(destinationPoint(center[0], center[1], (i * 10) % 360, finalRadius));
            }
            exc.latlngs = newLatlngs;
            if (layer.setRadius) layer.setRadius(finalRadius);
        });

        exclusionRadialGroups[idx] = { line, centerDot, label, handle };
    }

    function updateCircleRadialMeasurement(idx) {
        const exc = exclusions[idx];
        const rg = exclusionRadialGroups[idx];
        if (!exc || exc.type !== 'circle' || !rg) return;

        const angle = exc.measureAngle != null ? exc.measureAngle : 45;
        const center = exc.center;
        const radius = exc.radius;
        const edgePt = destinationPoint(center[0], center[1], angle, radius);
        const labelRatio = exc.measureLabelRatio != null ? exc.measureLabelRatio : 0.5;
        const labelPt = pointAlongRadius(center, edgePt, labelRatio);

        rg.line.setLatLngs([center, edgePt]);
        rg.centerDot.setLatLng(center);
        rg.label.setLatLng(labelPt);
        rg.label.setIcon(makeRadialLabelIcon(getRadiusText(radius)));
        rg.handle.setLatLng(edgePt);
    }

    function onCircleDrag(layer) {
        const idx = layer._exclusionIdx;
        if (idx == null || !exclusions[idx] || exclusions[idx].type !== 'circle') return;
        const exc = exclusions[idx];
        const center = layer.getLatLng();
        exc.center = [center.lat, center.lng];
        const radius = exc.radius;
        exc.latlngs = [];
        for (let i = 0; i <= 36; i++) {
            exc.latlngs.push(destinationPoint(center.lat, center.lng, (i * 10) % 360, radius));
        }
        updateCircleRadialMeasurement(idx);
    }

    function onCircleDragEnd(layer) {
        onCircleDrag(layer);
    }

    function removeExclusion(layer) {
        const idx = exclusionLayers.indexOf(layer);
        if (idx >= 0) {
            pushUndo();
            removeCircleRadialMeasurement(idx);
            exclusionRadialGroups.splice(idx, 1);
            exclusionLayers.splice(idx, 1);
            exclusions.splice(idx, 1);
            exclusionLayers.forEach((l, i) => { l._exclusionIdx = i; });
            map.removeLayer(layer);
            updateCounts();
        }
    }

    function startRectangleDraw() {
        waypointMode = false;
        document.getElementById('fpWaypointBtn').classList.remove('active');
        map.pm.disableDraw();
        map.pm.enableDraw('Rectangle', { snappable: true });
    }

    function startCircleDraw() {
        waypointMode = false;
        document.getElementById('fpWaypointBtn').classList.remove('active');
        map.pm.disableDraw();
        map.pm.enableDraw('Circle', { snappable: true });
    }

    function startPolygonDraw() {
        waypointMode = false;
        document.getElementById('fpWaypointBtn').classList.remove('active');
        map.pm.disableDraw();
        map.pm.enableDraw('Polygon', { snappable: true });
    }

    function startWaypointMode() {
        map.pm.disableDraw();
        waypointMode = true;
        document.getElementById('fpWaypointBtn').classList.add('active');
    }

    function stopWaypointMode() {
        waypointMode = false;
        document.getElementById('fpWaypointBtn').classList.remove('active');
    }

    // ---- Clear / Undo ----
    function clearAll() {
        const hasRecce = recceTarget !== null;
        const hasWaypoint = waypoints.length > 0 || exclusions.length > 0;
        if (!hasRecce && !hasWaypoint) return;
        const title = recceMode && hasRecce ? 'Clear recce target?' : 'Clear waypoint mission?';
        const message = recceMode && hasRecce
            ? 'Clear the recce target and exclusion zone? This cannot be undone.'
            : 'Clear all waypoints and exclusion zones? This cannot be undone.';
        showConfirmModal({
            title,
            message,
            confirmLabel: 'Clear'
        }).then(ok => {
            if (!ok) return;
            pushUndo();
            if (recceMode && recceTarget) {
                clearRecceTarget();
            }
            waypoints = [];
            waypointMarkers.forEach(m => map.removeLayer(m));
            waypointMarkers = [];
            exclusions.forEach((_, i) => {
                removeCircleRadialMeasurement(i);
                map.removeLayer(exclusionLayers[i]);
            });
            exclusions = [];
            exclusionLayers = [];
            exclusionRadialGroups = [];
            updateCounts();
        });
    }

    function undo() {
        if (undoStack.length === 0) return;
        const state = undoStack.pop();
        waypoints = state.waypoints;
        exclusions = state.exclusions || [];
        if (state.recceTarget !== undefined) {
            if (state.recceTarget) {
                recceTarget = state.recceTarget;
                recceRadius = state.recceRadius != null ? state.recceRadius : RECCE_DEFAULT_RADIUS;
                if (reccePoiMarker) map.removeLayer(reccePoiMarker);
                if (recceExclusionLayer) map.removeLayer(recceExclusionLayer);
                const poiIcon = L.divIcon({
                    className: 'recce-poi-marker',
                    html: '<div class="recce-poi-diamond"></div>',
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });
                reccePoiMarker = L.marker([recceTarget.lat, recceTarget.lng], { icon: poiIcon })
                    .addTo(map)
                    .bindTooltip('Target (POI)', { permanent: false, direction: 'top' });
                const latlngs = generateCircleLatlngs(recceTarget.lat, recceTarget.lng, recceRadius);
                recceExclusionLayer = L.polygon(latlngs, {
                    color: '#e05555',
                    fillColor: '#e05555',
                    fillOpacity: 0.25,
                    weight: 2
                }).addTo(map);
            } else {
                clearRecceTarget();
            }
        }

        waypointMarkers.forEach(m => map.removeLayer(m));
        waypointMarkers = [];
        exclusionLayers.forEach(l => map.removeLayer(l));
        exclusionLayers = [];

        waypoints.forEach((w, i) => {
            const m = L.circleMarker([w.lat, w.lng], {
                radius: 8,
                fillColor: '#0ea5e9',
                color: '#0284c7',
                weight: 2,
                fillOpacity: 0.9
            }).addTo(map);
            m.bindTooltip(`WP${i}`, { permanent: true, direction: 'top', offset: [0, -10] });
            waypointMarkers.push(m);
        });

        exclusionRadialGroups = [];
        exclusions.forEach((exc, i) => {
            let layer;
            if (exc.type === 'circle' && exc.center) {
                layer = L.circle(exc.center, { radius: exc.radius });
                layer._exclusionIdx = i;
                layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
                layer.addTo(map);
                layer.on('pm:remove', () => removeExclusion(layer));
                if (layer.pm) layer.pm.enableLayerDrag();
                layer.on('pm:drag', () => onCircleDrag(layer));
                layer.on('pm:dragend', () => onCircleDragEnd(layer));
                exclusionRadialGroups.push(null);
                exclusionLayers.push(layer);
                createCircleRadialMeasurement(i);
            } else if (exc.latlngs && exc.latlngs.length >= 3) {
                layer = L.polygon(exc.latlngs);
                layer._exclusionIdx = i;
                layer.setStyle({ color: '#e05555', fillColor: '#e05555', fillOpacity: 0.25, weight: 2 });
                layer.addTo(map);
                if (layer.pm) layer.pm.enableLayerDrag();
                layer.on('pm:drag', () => {
                    const verts = layer.getLatLngs()[0];
                    if (exclusions[i]) exclusions[i].latlngs = verts.map(ll => [ll.lat, ll.lng]);
                });
                exclusionRadialGroups.push(null);
                exclusionLayers.push(layer);
            }
        });

        document.getElementById('fpUndoBtn').disabled = undoStack.length === 0;
        updateCounts();
        updateRecceUI();
        scheduleFlightPlanningDraftSave();
    }

    function setRecceMode(enable) {
        recceMode = enable;
        recceAddTargetMode = false;
        waypointMode = false;
        map.pm.disableDraw();
        document.getElementById('fpRecceModeBtn').classList.toggle('active', recceMode);
        document.getElementById('fpWaypointModeBtn').classList.toggle('active', !recceMode);
        document.getElementById('fpRecceToolbar').classList.toggle('hidden', !recceMode);
        document.getElementById('fpWaypointToolbar').classList.toggle('hidden', recceMode);
        document.getElementById('fpExportBtn').classList.toggle('hidden', recceMode);
        document.getElementById('fpWaypointBtn').classList.remove('active');
        updateRecceUI();
        scheduleFlightPlanningDraftSave();
    }

    // ---- WPML / KMZ Export ----
    function escapeXml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function buildWaylinesWpml() {
        const h = MISSION_DEFAULTS.executeHeight;
        const speed = MISSION_DEFAULTS.waypointSpeed;

        let placemarks = '';
        waypoints.forEach((w, i) => {
            placemarks += `
      <Placemark>
        <Point><coordinates>${w.lng},${w.lat}</coordinates></Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${h}</wpml:executeHeight>
        <wpml:waypointSpeed>${speed}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
      </Placemark>`;
        });

        return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goContinue</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>hover</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${MISSION_DEFAULTS.takeOffSecurityHeight}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${MISSION_DEFAULTS.globalTransitionalSpeed}</wpml:globalTransitionalSpeed>
      <wpml:globalRTHHeight>${h}</wpml:globalRTHHeight>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${MISSION_DEFAULTS.droneEnumValue}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${MISSION_DEFAULTS.droneSubEnumValue}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${MISSION_DEFAULTS.payloadEnumValue}</wpml:payloadEnumValue>
        <wpml:payloadPositionIndex>${MISSION_DEFAULTS.payloadPositionIndex}</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>WGS84</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>${placemarks}
    </Folder>
  </Document>
</kml>`;
    }

    function buildTemplateKml() {
        const now = Date.now();
        let placemarks = '';
        waypoints.forEach((w, i) => {
            placemarks += `
    <Placemark>
      <name>WP${i}</name>
      <Point><coordinates>${w.lng},${w.lat}</coordinates></Point>
      <wpml:index>${i}</wpml:index>
      <wpml:ellipsoidHeight>${MISSION_DEFAULTS.executeHeight}</wpml:ellipsoidHeight>
      <wpml:height>${MISSION_DEFAULTS.executeHeight}</wpml:height>
      <wpml:useGlobalHeight>1</wpml:useGlobalHeight>
      <wpml:useGlobalSpeed>1</wpml:useGlobalSpeed>
      <wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam>
      <wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>
      <wpml:gimbalPitchAngle>0</wpml:gimbalPitchAngle>
    </Placemark>`;
        });

        let exclusionPlacemarks = '';
        exclusions.forEach((exc, i) => {
            if (exc.latlngs && exc.latlngs.length >= 3) {
                const coords = exc.latlngs.map(ll => `${ll[1]},${ll[0]},0`).join(' ');
                exclusionPlacemarks += `
    <Placemark>
      <name>Exclusion ${i + 1}</name>
      <Style>
        <PolyStyle><color>7f0000ff</color><outline>1</outline></PolyStyle>
        <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`;
            }
        });

        return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">
  <Document>
    <wpml:author>AirPlot v4</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goContinue</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>hover</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${MISSION_DEFAULTS.takeOffSecurityHeight}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${MISSION_DEFAULTS.globalTransitionalSpeed}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${MISSION_DEFAULTS.droneEnumValue}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${MISSION_DEFAULTS.droneSubEnumValue}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${MISSION_DEFAULTS.payloadEnumValue}</wpml:payloadEnumValue>
        <wpml:payloadPositionIndex>${MISSION_DEFAULTS.payloadPositionIndex}</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>
    <Folder>
      <name>Waypoints</name>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>EGM96</wpml:heightMode>
        <wpml:globalShootHeight>${MISSION_DEFAULTS.executeHeight}</wpml:globalShootHeight>
        <wpml:positioningType>GPS</wpml:positioningType>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${MISSION_DEFAULTS.waypointSpeed}</wpml:autoFlightSpeed>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>0</wpml:globalUseStraightLine>${placemarks}
    </Folder>${exclusionPlacemarks ? `
    <Folder><name>Exclusion Zones</name>${exclusionPlacemarks}
    </Folder>` : ''}
  </Document>
</kml>`;
    }

    async function exportKmz() {
        const hasWaypoints = waypoints.length >= 2;
        const hasExclusions = exclusions.some(exc => exc.latlngs && exc.latlngs.length >= 3);
        if (!hasWaypoints && !hasExclusions) {
            alert('Add at least 2 waypoints or at least 1 exclusion zone to export.');
            return;
        }

        const zip = new JSZip();
        zip.file('template.kml', buildTemplateKml());
        zip.file('waylines.wpml', buildWaylinesWpml());

        const blob = await zip.generateAsync({ type: 'blob' });
        const defaultName = `mission_${new Date().toISOString().slice(0, 10)}.kmz`;

        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: defaultName,
                    types: [{
                        description: 'KMZ file',
                        accept: { 'application/vnd.google-earth.kmz': ['.kmz'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                openSdCardModal(false);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error(err);
                    alert('Failed to save file.');
                }
            }
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultName;
            a.click();
            URL.revokeObjectURL(url);
            openSdCardModal(false);
        }
    }

    function openSdCardModal(isRecce) {
        const modal = document.getElementById('fpSdCardModal');
        modal.classList.remove('hidden');
        const recceSection = document.getElementById('fpRecceWorkflow');
        const waypointSection = document.getElementById('fpWaypointWorkflow');
        if (recceSection) recceSection.classList.toggle('hidden', !isRecce);
        if (waypointSection) waypointSection.classList.toggle('hidden', !!isRecce);
    }

    function closeSdCardModal() {
        document.getElementById('fpSdCardModal').classList.add('hidden');
    }

    function openHelpModal() {
        document.getElementById('fpHelpModal').classList.remove('hidden');
    }

    function closeHelpModal() {
        document.getElementById('fpHelpModal').classList.add('hidden');
    }

    // ---- PPTX Report Export ----
    async function captureMapImage() {
        const mapEl = document.getElementById('map');
        if (typeof MapCapture !== 'undefined' && MapCapture.captureFullMapToDataUrl) {
            return MapCapture.captureFullMapToDataUrl(mapEl, '#1a1a2e');
        }
        const canvas = await html2canvas(mapEl, {
            useCORS: true,
            allowTaint: false,
            backgroundColor: '#1a1a2e',
            scale: 2,
            logging: false
        });
        return canvas.toDataURL('image/png');
    }

    async function exportFlightPlanPptx() {
        const hasRecce = recceMode && recceTarget;
        const hasWaypoints = !recceMode && waypoints.length > 0;
        const hasExclusions = !recceMode && exclusions.length > 0;

        if (!hasRecce && !hasWaypoints && !hasExclusions) {
            alert('Add a target, waypoints, or exclusion zones before exporting a report.');
            return;
        }

        const btn = document.getElementById('fpExportReportBtn');
        const origText = btn.querySelector('span').textContent;
        btn.disabled = true;
        btn.querySelector('span').textContent = 'Exporting…';

        try {
            PptxTheme.setLight(true);

            const pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_WIDE';
            pptx.author = 'AirPlot v4';
            pptx.subject = 'Flight Plan Report';

            const logo = await PptxTheme.loadLogo();
            PptxTheme.applyTheme(pptx, logo);

            const C = PptxTheme.colors();
            const headerOpts = PptxTheme.tableHeaderOpts();
            const cellOpts = PptxTheme.tableCellOpts();
            const labelOpts = PptxTheme.tableLabelOpts();
            const border = PptxTheme.tableBorder();

            const modeLabel = recceMode ? 'Manual Recce' : 'Waypoint Mission';
            const dateLabel = new Date().toLocaleString();

            const mapEl = document.getElementById('map');
            const mapImg = await PptxTheme.captureSquareMap(mapEl);

            // --- Slide 1: Title + Map ---
            let slide = pptx.addSlide({ masterName: 'TITLE_SLIDE' });
            slide.addText('Flight Plan Report', { x: 1.1, y: 0.15, w: 8, h: 0.6, fontSize: 26, bold: true, color: C.textPrimary, fontFace: 'Arial' });

            var mapSize = 5.6;
            slide.addShape('roundRect', { x: 0.42, y: 1.02, w: mapSize + 0.16, h: mapSize + 0.16, fill: { color: C.surface }, rectRadius: 0.12, line: { color: C.border, width: 0.5 } });
            slide.addImage({ data: mapImg, x: 0.5, y: 1.1, w: mapSize, h: mapSize, rounding: false });

            var panelX = 6.5;
            var panelW = 6.3;
            var panelRows = [
                { label: 'MISSION TYPE', value: modeLabel, bold: true, fontSize: 15, divider: true },
                { label: 'DATE & TIME', value: dateLabel, divider: true }
            ];
            if (hasRecce && recceTarget) {
                panelRows.push({ label: 'TARGET (POI)', value: recceTarget.lat.toFixed(6) + '°N   ' + Math.abs(recceTarget.lng).toFixed(6) + '°' + (recceTarget.lng >= 0 ? 'E' : 'W'), divider: true });
                panelRows.push({ label: 'EXCLUSION RADIUS', value: getRadiusText(recceRadius), divider: true });
            }
            if (hasWaypoints) {
                panelRows.push({ label: 'WAYPOINTS', value: waypoints.length + ' waypoint' + (waypoints.length !== 1 ? 's' : '') + ' defined', divider: true });
            }
            if (hasExclusions) {
                panelRows.push({ label: 'EXCLUSION ZONES', value: exclusions.length + ' zone' + (exclusions.length !== 1 ? 's' : '') + ' defined', divider: true });
            }
            panelRows.push({ label: 'GENERATED', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '  at  ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
            PptxTheme.addInfoPanel(slide, panelX, 1.0, panelW, 5.7, panelRows);

            if (hasRecce) {
                // --- Slide 2: Recce Mission Details ---
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Manual Recce: Mission Details', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                const recceRows = [
                    [{ text: 'Parameter', options: headerOpts }, { text: 'Value', options: headerOpts }],
                    [{ text: 'Target (POI)', options: labelOpts }, { text: recceTarget.lat.toFixed(6) + ', ' + recceTarget.lng.toFixed(6), options: cellOpts }],
                    [{ text: 'Exclusion zone radius', options: labelOpts }, { text: getRadiusText(recceRadius), options: cellOpts }],
                    [{ text: 'Flight mode', options: labelOpts }, { text: 'Manual: overlay only (no auto-flight)', options: cellOpts }],
                    [{ text: 'Export format', options: labelOpts }, { text: 'KMZ for DJI Pilot 2', options: cellOpts }]
                ];
                slide.addTable(recceRows, { x: 0.5, y: 0.9, w: 8, colW: [3.5, 4.5], border: border, rowH: 0.4 });

                slide.addText(
                    'Workflow: Export the KMZ, copy to SD card, import in DJI Pilot 2 as an overlay. ' +
                    'The exclusion zone will appear on the map. The drone brakes at the fence boundary.',
                    { x: 0.5, y: 3.4, w: 10, h: 0.7, fontSize: 11, color: C.textMuted, fontFace: 'Arial', valign: 'top' }
                );
            }

            if (hasWaypoints || hasExclusions) {
                // --- Slide 2: Mission Parameters ---
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Waypoint Mission: Parameters', { x: 0.5, y: 0.2, w: 10, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                const paramRows = [
                    [{ text: 'Parameter', options: headerOpts }, { text: 'Value', options: headerOpts }],
                    [{ text: 'Waypoints', options: labelOpts }, { text: String(waypoints.length), options: cellOpts }],
                    [{ text: 'Exclusion zones', options: labelOpts }, { text: String(exclusions.length), options: cellOpts }],
                    [{ text: 'Execute height', options: labelOpts }, { text: MISSION_DEFAULTS.executeHeight + ' m', options: cellOpts }],
                    [{ text: 'Waypoint speed', options: labelOpts }, { text: MISSION_DEFAULTS.waypointSpeed + ' m/s', options: cellOpts }],
                    [{ text: 'Take-off security height', options: labelOpts }, { text: MISSION_DEFAULTS.takeOffSecurityHeight + ' m', options: cellOpts }],
                    [{ text: 'Transit speed', options: labelOpts }, { text: MISSION_DEFAULTS.globalTransitionalSpeed + ' m/s', options: cellOpts }],
                    [{ text: 'Finish action', options: labelOpts }, { text: 'Go Home', options: cellOpts }],
                    [{ text: 'RC Lost action', options: labelOpts }, { text: 'Hover', options: cellOpts }]
                ];
                slide.addTable(paramRows, { x: 0.5, y: 0.9, w: 8, colW: [3.5, 4.5], border: border, rowH: 0.4 });
            }

            if (hasWaypoints) {
                // --- Slide 3: Waypoint Table ---
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Waypoints', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                const wpHeader = [
                    { text: '#', options: headerOpts },
                    { text: 'Latitude', options: headerOpts },
                    { text: 'Longitude', options: headerOpts },
                    { text: 'Height (m)', options: headerOpts },
                    { text: 'Speed (m/s)', options: headerOpts }
                ];
                const wpRows = [wpHeader];
                const pageSize = 14;

                waypoints.forEach(function (w, i) {
                    if (i > 0 && i % pageSize === 0) {
                        slide.addTable(wpRows.splice(0), { x: 0.5, y: 0.85, w: 10, colW: [1, 2.5, 2.5, 2, 2], border: border, rowH: 0.38 });
                        slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                        slide.addText('Waypoints (continued)', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                        wpRows.push(wpHeader);
                    }
                    wpRows.push([
                        { text: 'WP' + i, options: cellOpts },
                        { text: w.lat.toFixed(6), options: cellOpts },
                        { text: w.lng.toFixed(6), options: cellOpts },
                        { text: String(MISSION_DEFAULTS.executeHeight), options: cellOpts },
                        { text: String(MISSION_DEFAULTS.waypointSpeed), options: cellOpts }
                    ]);
                });
                if (wpRows.length > 0) {
                    slide.addTable(wpRows, { x: 0.5, y: 0.85, w: 10, colW: [1, 2.5, 2.5, 2, 2], border: border, rowH: 0.38 });
                }
            }

            if (hasExclusions) {
                // --- Exclusion Zones Slide ---
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText('Exclusion Zones', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

                const exHeader = [
                    { text: '#', options: headerOpts },
                    { text: 'Type', options: headerOpts },
                    { text: 'Centre / Bounds', options: headerOpts },
                    { text: 'Radius / Size', options: headerOpts }
                ];
                const exRows = [exHeader];

                exclusions.forEach(function (exc, i) {
                    let typeStr = exc.type.charAt(0).toUpperCase() + exc.type.slice(1);
                    let centreStr = '-';
                    let sizeStr = '-';

                    if (exc.type === 'circle' && exc.center) {
                        centreStr = exc.center[0].toFixed(6) + ', ' + exc.center[1].toFixed(6);
                        sizeStr = getRadiusText(exc.radius);
                    } else if (exc.latlngs && exc.latlngs.length > 0) {
                        const lats = exc.latlngs.map(function (ll) { return ll[0]; });
                        const lngs = exc.latlngs.map(function (ll) { return ll[1]; });
                        centreStr = ((Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2).toFixed(6) + ', ' +
                                    ((Math.min.apply(null, lngs) + Math.max.apply(null, lngs)) / 2).toFixed(6);
                        sizeStr = exc.latlngs.length + ' vertices';
                    }

                    exRows.push([
                        { text: String(i + 1), options: cellOpts },
                        { text: typeStr, options: cellOpts },
                        { text: centreStr, options: cellOpts },
                        { text: sizeStr, options: cellOpts }
                    ]);
                });

                slide.addTable(exRows, { x: 0.5, y: 0.85, w: 10, colW: [1, 2, 4, 3], border: border, rowH: 0.4 });
            }

            const fileName = 'Flight_Plan_' + new Date().toISOString().slice(0, 10) + '.pptx';
            await pptx.writeFile({ fileName: fileName });

        } catch (err) {
            console.error('PPTX export failed:', err);
            alert('Failed to export PowerPoint: ' + (err.message || 'Unknown error'));
        } finally {
            btn.disabled = false;
            btn.querySelector('span').textContent = origText;
        }
    }

    async function exportFlightPlanPdf() {
        var hasRecce = recceMode && recceTarget;
        var hasWp = !recceMode && waypoints.length > 0;
        var hasExc = !recceMode && exclusions.length > 0;

        if (!hasRecce && !hasWp && !hasExc) {
            alert('Add a target, waypoints, or exclusion zones before exporting a report.');
            return;
        }

        var btn = document.getElementById('fpExportPdfBtn');
        var origText = btn.querySelector('span').textContent;
        btn.disabled = true;
        btn.querySelector('span').textContent = 'Exporting…';

        try {
            PdfTheme.setLight(true);
            await PdfTheme.loadLogo();
            var c = PdfTheme.colors();
            var ts = PdfTheme.tableStyles();

            var modeLabel = recceMode ? 'Manual Recce' : 'Waypoint Mission';
            var dateLabel = new Date().toLocaleString();

            var mapEl = document.getElementById('map');
            var mapImg = await PdfTheme.captureSquareMap(mapEl);

            var doc = PdfTheme.createDoc();

            PdfTheme.addHeader(doc, 'Flight Plan Report', true);
            doc.addImage(mapImg, 'PNG', 10, 25, 120, 120);

            var panelTopY = 25 + 120 + 8;
            var panelRows = [
                { label: 'MISSION TYPE', value: modeLabel, bold: true, fontSize: 11, divider: true },
                { label: 'DATE & TIME', value: dateLabel, divider: true }
            ];
            if (hasRecce && recceTarget) {
                panelRows.push({ label: 'TARGET (POI)', value: recceTarget.lat.toFixed(6) + '°N   ' + Math.abs(recceTarget.lng).toFixed(6) + '°' + (recceTarget.lng >= 0 ? 'E' : 'W'), divider: true });
                panelRows.push({ label: 'EXCLUSION RADIUS', value: getRadiusText(recceRadius), divider: true });
            }
            if (hasWp) {
                panelRows.push({ label: 'WAYPOINTS', value: waypoints.length + ' waypoint' + (waypoints.length !== 1 ? 's' : ''), divider: true });
            }
            if (hasExc) {
                panelRows.push({ label: 'EXCLUSION ZONES', value: exclusions.length + ' zone' + (exclusions.length !== 1 ? 's' : ''), divider: true });
            }
            panelRows.push({ label: 'GENERATED', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '  at  ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
            PdfTheme.addInfoPanel(doc, 10, panelTopY, 190, panelRows);

            if (hasRecce) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Manual Recce: Mission Details');
                doc.autoTable({
                    startY: 18,
                    head: [['Parameter', 'Value']],
                    body: [
                        ['Target (POI)', recceTarget.lat.toFixed(6) + ', ' + recceTarget.lng.toFixed(6)],
                        ['Exclusion zone radius', getRadiusText(recceRadius)],
                        ['Flight mode', 'Manual: overlay only (no auto-flight)'],
                        ['Export format', 'KMZ for DJI Pilot 2']
                    ],
                    columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } },
                    ...ts
                });
                doc.setFontSize(8);
                doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                doc.text('Workflow: Export the KMZ, copy to SD card, import in DJI Pilot 2 as an overlay.', 10, doc.lastAutoTable.finalY + 8);
            }

            if (hasWp || hasExc) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Waypoint Mission: Parameters');
                doc.autoTable({
                    startY: 18,
                    head: [['Parameter', 'Value']],
                    body: [
                        ['Waypoints', String(waypoints.length)],
                        ['Exclusion zones', String(exclusions.length)],
                        ['Execute height', MISSION_DEFAULTS.executeHeight + ' m'],
                        ['Waypoint speed', MISSION_DEFAULTS.waypointSpeed + ' m/s'],
                        ['Take-off security height', MISSION_DEFAULTS.takeOffSecurityHeight + ' m'],
                        ['Transit speed', MISSION_DEFAULTS.globalTransitionalSpeed + ' m/s'],
                        ['Finish action', 'Go Home'],
                        ['RC Lost action', 'Hover']
                    ],
                    columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } },
                    ...ts
                });
            }

            if (hasWp) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Waypoints');
                var wpBody = waypoints.map(function (w, i) {
                    return ['WP' + i, w.lat.toFixed(6), w.lng.toFixed(6), String(MISSION_DEFAULTS.executeHeight), String(MISSION_DEFAULTS.waypointSpeed)];
                });
                doc.autoTable({
                    startY: 18,
                    head: [['#', 'Latitude', 'Longitude', 'Height (m)', 'Speed (m/s)']],
                    body: wpBody,
                    ...ts
                });
            }

            if (hasExc) {
                PdfTheme.newPage(doc);
                PdfTheme.addHeader(doc, 'Exclusion Zones');
                var exBody = exclusions.map(function (exc, i) {
                    var typeStr = exc.type.charAt(0).toUpperCase() + exc.type.slice(1);
                    var centreStr = '-';
                    var sizeStr = '-';
                    if (exc.type === 'circle' && exc.center) {
                        centreStr = exc.center[0].toFixed(6) + ', ' + exc.center[1].toFixed(6);
                        sizeStr = getRadiusText(exc.radius);
                    } else if (exc.latlngs && exc.latlngs.length > 0) {
                        var lats = exc.latlngs.map(function (ll) { return ll[0]; });
                        var lngs = exc.latlngs.map(function (ll) { return ll[1]; });
                        centreStr = ((Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2).toFixed(6) + ', ' +
                                    ((Math.min.apply(null, lngs) + Math.max.apply(null, lngs)) / 2).toFixed(6);
                        sizeStr = exc.latlngs.length + ' vertices';
                    }
                    return [String(i + 1), typeStr, centreStr, sizeStr];
                });
                doc.autoTable({
                    startY: 18,
                    head: [['#', 'Type', 'Centre / Bounds', 'Radius / Size']],
                    body: exBody,
                    ...ts
                });
            }

            PdfTheme.addAllFooters(doc);
            doc.save('Flight_Plan_' + new Date().toISOString().slice(0, 10) + '.pdf');

        } catch (err) {
            console.error('PDF export failed:', err);
            alert('Failed to export PDF: ' + (err.message || 'Unknown error'));
        } finally {
            btn.disabled = false;
            btn.querySelector('span').textContent = origText;
        }
    }

    // ---- UI ----
    function updateCounts() {
        document.getElementById('fpWaypointCount').textContent = `${waypoints.length} waypoint${waypoints.length !== 1 ? 's' : ''}`;
        document.getElementById('fpExclusionCount').textContent = `${exclusions.length} exclusion zone${exclusions.length !== 1 ? 's' : ''}`;
        document.getElementById('fpUndoBtn').disabled = undoStack.length === 0;
    }

    function init() {
        initMap();
        loadFlightPlanningDraft();

        document.getElementById('fpRecceModeBtn').addEventListener('click', () => setRecceMode(true));
        document.getElementById('fpWaypointModeBtn').addEventListener('click', () => setRecceMode(false));
        document.getElementById('fpRecceTargetBtn').addEventListener('click', () => {
            recceAddTargetMode = !recceAddTargetMode;
            updateRecceUI();
        });
        const radiusInput = document.getElementById('fpRecceRadiusInput');
        if (radiusInput) {
            radiusInput.addEventListener('change', () => updateRecceRadius(parseInt(radiusInput.value, 10) || RECCE_DEFAULT_RADIUS));
            radiusInput.addEventListener('input', () => updateRecceRadius(parseInt(radiusInput.value, 10) || RECCE_DEFAULT_RADIUS));
        }
        document.getElementById('fpExportRecceBtn').addEventListener('click', exportRecceKmz);

        document.getElementById('fpWaypointBtn').addEventListener('click', () => {
            if (waypointMode) stopWaypointMode();
            else startWaypointMode();
        });
        document.getElementById('fpRectangleBtn').addEventListener('click', startRectangleDraw);
        document.getElementById('fpCircleBtn').addEventListener('click', startCircleDraw);
        document.getElementById('fpPolygonBtn').addEventListener('click', startPolygonDraw);
        document.getElementById('fpUndoBtn').addEventListener('click', () => {
            undo();
        });
        document.getElementById('fpClearBtn').addEventListener('click', clearAll);
        document.getElementById('fpExportBtn').addEventListener('click', exportKmz);
        document.getElementById('fpSdCardHelpBtn').addEventListener('click', () => openSdCardModal(recceMode));
        document.getElementById('fpExportReportBtn').addEventListener('click', exportFlightPlanPptx);
        document.getElementById('fpExportPdfBtn').addEventListener('click', exportFlightPlanPdf);

        document.getElementById('fpHelpBtn').addEventListener('click', openHelpModal);

        const mobileHelpBtn = document.getElementById('mobileHelpBtn');
        if (mobileHelpBtn) {
            mobileHelpBtn.addEventListener('click', openHelpModal);
        }

        const helpModal = document.getElementById('fpHelpModal');
        if (helpModal) {
            helpModal.querySelector('.modal-backdrop').addEventListener('click', closeHelpModal);
            helpModal.querySelector('.modal-close').addEventListener('click', closeHelpModal);
            helpModal.querySelector('.modal-cancel').addEventListener('click', closeHelpModal);
        }

        const sdModal = document.getElementById('fpSdCardModal');
        if (sdModal) {
            sdModal.querySelector('.modal-backdrop').addEventListener('click', closeSdCardModal);
            sdModal.querySelector('.modal-close').addEventListener('click', closeSdCardModal);
            sdModal.querySelector('.modal-cancel').addEventListener('click', closeSdCardModal);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (helpModal && !helpModal.classList.contains('hidden')) {
                closeHelpModal();
                return;
            }
            if (sdModal && !sdModal.classList.contains('hidden')) {
                closeSdCardModal();
            }
        });

        map.on('click', onMapClick);
        map.on('moveend', scheduleFlightPlanningDraftSave);
        window.addEventListener('pagehide', saveFlightPlanningDraftNow);

        map.on('pm:drawstart', () => {
            stopWaypointMode();
            recceAddTargetMode = false;
            updateRecceUI();
        });

        /* Attribution: single-row strip on small screens via css/style.css */
    }

    window.addEventListener('load', init);
})();
