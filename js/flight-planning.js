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
            null, { position: 'topright' }
        ).addTo(map);

        if (typeof L.control.locate === 'function') {
            L.control.locate({
                position: 'topleft',
                strings: { title: 'Show my location' },
                locateOptions: { enableHighAccuracy: true }
            }).addTo(map);
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
    }

    // ---- Waypoints ----
    function pushUndo() {
        undoStack.push({
            waypoints: waypoints.map(w => ({ ...w })),
            exclusions: exclusions.map(e => ({
                ...e,
                latlngs: e.latlngs ? e.latlngs.map(ll => [...ll]) : undefined,
                center: e.center ? [...e.center] : undefined
            }))
        });
        document.getElementById('fpUndoBtn').disabled = undoStack.length === 0;
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
        if (waypointMode) {
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
        if (waypoints.length === 0 && exclusions.length === 0) return;
        if (!confirm('Clear all waypoints and exclusion zones?')) return;
        pushUndo();
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
    }

    function undo() {
        if (undoStack.length === 0) return;
        const state = undoStack.pop();
        waypoints = state.waypoints;
        exclusions = state.exclusions || [];

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
    <wpml:author>AirPlot</wpml:author>
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
                openSdCardModal();
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
            openSdCardModal();
        }
    }

    function openSdCardModal() {
        document.getElementById('fpSdCardModal').classList.remove('hidden');
    }

    function closeSdCardModal() {
        document.getElementById('fpSdCardModal').classList.add('hidden');
    }

    // ---- UI ----
    function updateCounts() {
        document.getElementById('fpWaypointCount').textContent = `${waypoints.length} waypoint${waypoints.length !== 1 ? 's' : ''}`;
        document.getElementById('fpExclusionCount').textContent = `${exclusions.length} exclusion zone${exclusions.length !== 1 ? 's' : ''}`;
        document.getElementById('fpUndoBtn').disabled = undoStack.length === 0;
    }

    function init() {
        initMap();

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
        document.getElementById('fpSdCardHelpBtn').addEventListener('click', openSdCardModal);
        document.getElementById('fpBackBtn').addEventListener('click', () => {
            window.location.href = 'index.html';
        });

        const sdModal = document.getElementById('fpSdCardModal');
        if (sdModal) {
            sdModal.querySelector('.modal-backdrop').addEventListener('click', closeSdCardModal);
            sdModal.querySelector('.modal-close').addEventListener('click', closeSdCardModal);
            sdModal.querySelector('.modal-cancel').addEventListener('click', closeSdCardModal);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sdModal && !sdModal.classList.contains('hidden')) {
                closeSdCardModal();
            }
        });

        map.on('click', onMapClick);

        map.on('pm:drawstart', () => {
            stopWaypointMode();
        });
    }

    window.addEventListener('load', init);
})();
