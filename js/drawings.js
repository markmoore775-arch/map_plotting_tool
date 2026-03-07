/* ============================================
   DRAWING & ANNOTATION MODULE
   ============================================ */

const Drawings = (() => {
    'use strict';

    function pushUndoSnapshot() {
        if (typeof UndoHistory !== 'undefined') UndoHistory.pushSnapshot();
    }

    let map;
    let shapes = [];
    let nextShapeId = 1;
    let showMeasurements = true;
    let showShapeLabels = true;
    let showFlightPathDistance = false;
    let shapeLayerMap = {};
    let arrowDrawState = null; // { tail: [lat,lng] } while placing tip
    let flightPathDrawState = null; // true when drawing a flight path
    let lineDrawState = null; // { start: [lat,lng] } while placing end point
    let lastCircleRadiusPoint = null; // last mouse pos during circle draw (for label angle)
    let mobileDrawControlsEl = null; // floating Finish/Undo/Cancel bar on touch devices

    // Selection & interaction state
    let selectedShapeId = null;
    let shapeClipboard = null;    // { type, label, style, center, radius, latlngs, tail, tip, ... }

    // Default style for new shapes
    let currentStyle = {
        color: '#e05555',
        fillColor: '#e05555',
        fillOpacity: 0.15,
        weight: 2,
        dashArray: ''
    };

    // Arrow geometry proportions
    const ARROW_SHAFT_RATIO = 0.08;
    const ARROW_HEAD_WIDTH_RATIO = 0.22;
    const ARROW_HEAD_LENGTH_RATIO = 0.25;

    // ---- Geo helpers ----

    function destinationPoint(lat, lng, bearing, distance) {
        const R = 6371000;
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

        return [lat2 * 180 / Math.PI, ((lon2 * 180 / Math.PI) + 540) % 360 - 180];
    }

    function bearingTo(lat1, lng1, lat2, lng2) {
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const la1 = lat1 * Math.PI / 180;
        const la2 = lat2 * Math.PI / 180;

        const y = Math.sin(dLng) * Math.cos(la2);
        const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);

        return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }

    function midpoint(a, b) {
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
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
        let t = denom ? (px * dx + py * dy) / denom : 0.5;
        return Math.max(0.05, Math.min(0.95, t));
    }

    function pointAlongPolyline(latlngs, ratio) {
        if (!latlngs || latlngs.length < 2) return latlngs && latlngs[0] ? latlngs[0] : [0, 0];
        const total = calcPolylineLength(latlngs);
        if (total <= 0) return latlngs[0];
        let target = Math.max(0, Math.min(1, ratio)) * total;
        let acc = 0;
        for (let i = 1; i < latlngs.length; i++) {
            const a = L.latLng(latlngs[i - 1]);
            const b = L.latLng(latlngs[i]);
            const segLen = a.distanceTo(b);
            if (acc + segLen >= target) {
                const frac = segLen > 0 ? (target - acc) / segLen : 0;
                return [
                    latlngs[i - 1][0] + frac * (latlngs[i][0] - latlngs[i - 1][0]),
                    latlngs[i - 1][1] + frac * (latlngs[i][1] - latlngs[i - 1][1])
                ];
            }
            acc += segLen;
        }
        return latlngs[latlngs.length - 1];
    }

    function projectOntoPolyline(latlngs, pos) {
        if (!latlngs || latlngs.length < 2) return 0.5;
        const total = calcPolylineLength(latlngs);
        if (total <= 0) return 0.5;
        const p = L.latLng(pos);
        let bestRatio = 0.5;
        let bestDist = Infinity;
        let acc = 0;
        for (let i = 1; i < latlngs.length; i++) {
            const a = L.latLng(latlngs[i - 1]);
            const b = L.latLng(latlngs[i]);
            const segLen = a.distanceTo(b);
            if (segLen <= 0) {
                const d = p.distanceTo(a);
                if (d < bestDist) {
                    bestDist = d;
                    bestRatio = acc / total;
                }
                acc += segLen;
                continue;
            }
            const ax = a.lat; const ay = a.lng;
            const bx = b.lat; const by = b.lng;
            const dx = bx - ax; const dy = by - ay;
            const t = Math.max(0, Math.min(1,
                ((p.lat - ax) * dx + (p.lng - ay) * dy) / (dx * dx + dy * dy)
            ));
            const projLat = ax + t * dx;
            const projLng = ay + t * dy;
            const proj = L.latLng(projLat, projLng);
            const d = p.distanceTo(proj);
            if (d < bestDist) {
                bestDist = d;
                bestRatio = (acc + t * segLen) / total;
            }
            acc += segLen;
        }
        return Math.max(0.02, Math.min(0.98, bestRatio));
    }

    // ---- Copy / Paste ----
    const PASTE_OFFSET_DEG = 0.0004; // ~44m offset so pasted shape doesn't overlap

    function getShapeDataForCopy(shape) {
        const data = {
            type: shape.type,
            label: shape.label || '',
            style: { ...shape.style }
        };
        if (shape.center) data.center = [...shape.center];
        if (shape.radius != null) data.radius = shape.radius;
        if (shape.measureAngle != null) data.measureAngle = shape.measureAngle;
        if (shape.measureLabelRatio != null) data.measureLabelRatio = shape.measureLabelRatio;
        if (shape.latlngs) data.latlngs = shape.latlngs.map(ll => [...ll]);
        if (shape.tail) data.tail = [...shape.tail];
        if (shape.tip) data.tip = [...shape.tip];
        if (shape.curvePoints) data.curvePoints = shape.curvePoints.map(p => [...p]);
        if (shape.position) data.position = [...shape.position];
        if (shape.text != null) data.text = shape.text;
        if (shape.textStyle) data.textStyle = { ...shape.textStyle };
        if (shape.showDistance != null) data.showDistance = shape.showDistance;
        if (shape.arrowSize != null) data.arrowSize = shape.arrowSize;
        return data;
    }

    function getClipboardCentroid(data) {
        if (data.center) return data.center;
        if (data.tail && data.tip) return midpoint(data.tail, data.tip);
        if (data.position) return data.position;
        if (data.latlngs && data.latlngs.length > 0) {
            let latSum = 0, lngSum = 0;
            for (const ll of data.latlngs) {
                latSum += ll[0];
                lngSum += ll[1];
            }
            return [latSum / data.latlngs.length, lngSum / data.latlngs.length];
        }
        if (data.curvePoints && data.curvePoints.length > 0) {
            const pts = data.curvePoints;
            return midpoint(pts[0], pts[pts.length - 1]);
        }
        return [0, 0];
    }

    function applyOffsetToShapeData(data, dLat, dLng) {
        const offset = (arr) => arr && (arr[0] += dLat, arr[1] += dLng, arr);
        const offsetAll = (arr) => arr && arr.forEach(ll => { ll[0] += dLat; ll[1] += dLng; });
        if (data.center) offset(data.center);
        if (data.latlngs) offsetAll(data.latlngs);
        if (data.tail) offset(data.tail);
        if (data.tip) offset(data.tip);
        if (data.curvePoints) offsetAll(data.curvePoints);
        if (data.position) offset(data.position);
        return data;
    }

    function copyShape(id) {
        const shape = shapes.find(s => s.id === id);
        if (!shape) return;
        shapeClipboard = getShapeDataForCopy(shape);
    }

    function pasteShape(anchorLatLng) {
        if (!shapeClipboard) return null;
        pushUndoSnapshot();
        const center = anchorLatLng && anchorLatLng.lat != null
            ? [anchorLatLng.lat, anchorLatLng.lng]
            : (map.getCenter ? [map.getCenter().lat, map.getCenter().lng] : [0, 0]);
        const origCentroid = getClipboardCentroid(shapeClipboard);
        const dLat = center[0] + PASTE_OFFSET_DEG - origCentroid[0];
        const dLng = center[1] + PASTE_OFFSET_DEG - origCentroid[1];
        const data = applyOffsetToShapeData(JSON.parse(JSON.stringify(shapeClipboard)), dLat, dLng);
        const shape = {
            id: nextShapeId++,
            type: data.type,
            label: data.label || '',
            style: data.style || { ...currentStyle },
            center: data.center,
            radius: data.radius,
            measureAngle: data.measureAngle != null ? data.measureAngle : 45,
            measureLabelRatio: data.measureLabelRatio != null ? data.measureLabelRatio : 0.5,
            tail: data.tail,
            tip: data.tip,
            latlngs: data.latlngs,
            curvePoints: data.curvePoints,
            position: data.position,
            text: data.text,
            textStyle: data.textStyle ? { ...data.textStyle } : undefined,
            showDistance: data.showDistance,
            arrowSize: data.arrowSize != null ? data.arrowSize : FLIGHT_PATH_ARROW_SIZE_DEFAULT
        };
        if (shape.type === 'flightpath' && !shape.style.color) {
            shape.style = { ...flightPathStyle };
        }
        shapes.push(shape);
        addShapeToMap(shape);
        refreshShapesList();
        return shape.id;
    }

    function hasClipboard() {
        return !!shapeClipboard;
    }

    // ---- Arrow polygon geometry ----

    function computeArrowVertices(tail, tip) {
        const bearing = bearingTo(tail[0], tail[1], tip[0], tip[1]);
        const length = L.latLng(tail).distanceTo(L.latLng(tip));

        if (length < 0.5) return [tail, tail, tail, tip, tail, tail, tail];

        const shaftHalf = length * ARROW_SHAFT_RATIO;
        const headHalf = length * ARROW_HEAD_WIDTH_RATIO;
        const headStart = length * (1 - ARROW_HEAD_LENGTH_RATIO);

        const perpL = (bearing + 270) % 360;
        const perpR = (bearing + 90) % 360;

        const sL1 = destinationPoint(tail[0], tail[1], perpL, shaftHalf);
        const sR1 = destinationPoint(tail[0], tail[1], perpR, shaftHalf);

        const neckPt = destinationPoint(tail[0], tail[1], bearing, headStart);
        const sL2 = destinationPoint(neckPt[0], neckPt[1], perpL, shaftHalf);
        const sR2 = destinationPoint(neckPt[0], neckPt[1], perpR, shaftHalf);

        const wL = destinationPoint(neckPt[0], neckPt[1], perpL, headHalf);
        const wR = destinationPoint(neckPt[0], neckPt[1], perpR, headHalf);

        return [sL1, sL2, wL, tip, wR, sR2, sR1];
    }

    function extractTailTipFromVertices(vertices) {
        if (!vertices || vertices.length < 7) return { tail: [0, 0], tip: [0, 0] };
        const sL1 = vertices[0];
        const sR1 = vertices[6];
        const tail = midpoint(sL1, sR1);
        const tip = vertices[3];
        return { tail, tip };
    }

    // ---- Flight path: small arrowhead at a point (for direction markers) ----
    const FLIGHT_PATH_ARROW_SIZE_DEFAULT = 20; // metres (default size for new flight paths)
    const FLIGHT_PATH_ARROW_INTERVAL = 100; // metres between arrows
    const FLIGHT_PATH_ZOOM_REFERENCE = 15; // zoom level where base size/interval are used

    function getFlightPathZoomScale() {
        if (!map) return 1;
        const zoom = map.getZoom();
        const scale = Math.pow(2, FLIGHT_PATH_ZOOM_REFERENCE - zoom);
        return Math.max(0.25, Math.min(16, scale));
    }

    function computeArrowheadVertices(center, bearing, sizeM) {
        const tip = destinationPoint(center[0], center[1], bearing, sizeM);
        const perpL = (bearing + 270) % 360;
        const perpR = (bearing + 90) % 360;
        const back = destinationPoint(center[0], center[1], (bearing + 180) % 360, sizeM * 0.6);
        const wL = destinationPoint(back[0], back[1], perpL, sizeM * 0.5);
        const wR = destinationPoint(back[0], back[1], perpR, sizeM * 0.5);
        return [tip, wL, wR];
    }

    function getPointsAlongPath(latlngs, intervalM) {
        if (!latlngs || latlngs.length < 2) return [];
        const points = [];
        let remaining = intervalM;
        for (let i = 1; i < latlngs.length; i++) {
            const a = L.latLng(latlngs[i - 1]);
            const b = L.latLng(latlngs[i]);
            const segLen = a.distanceTo(b);
            const bearing = bearingTo(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);

            while (remaining <= segLen) {
                const frac = remaining / segLen;
                const lat = latlngs[i - 1][0] + frac * (latlngs[i][0] - latlngs[i - 1][0]);
                const lng = latlngs[i - 1][1] + frac * (latlngs[i][1] - latlngs[i - 1][1]);
                points.push({ latlng: [lat, lng], bearing });
                remaining += intervalM;
            }
            remaining -= segLen;
        }
        return points;
    }

    // Default style for flight paths
    const flightPathStyle = {
        color: '#2196F3',
        fillColor: '#2196F3',
        fillOpacity: 0.9,
        weight: 2.5,
        dashArray: '10,6'
    };

    // ---- Initialisation ----

    function init(mapInstance) {
        map = mapInstance;
        setupGeoman();
        setupArrowDrawControl();
        setupLineDrawControl();
        setupFlightPathDrawControl();
        setupStylePanel();
        setupShapeEvents();
        setupCircleDrawFeedback();
        setupKeyboardShortcuts();
        setupMapDismiss();
        setupCursorState();
        setupFlightPathZoomRebuild();
    }

    function setupFlightPathZoomRebuild() {
        map.on('zoomend', () => {
            for (const shape of shapes) {
                if (shape.type === 'flightpath') {
                    rebuildFlightPathArrows(shape);
                }
            }
        });
    }

    function setupCursorState() {
        map.on('pm:drawstart', (e) => {
            refreshInteractionCursor();
            if (isTouchDevice() && window.innerWidth <= 600 && !flightPathDrawState) {
                const shape = e.shape;
                if (shape === 'Polygon') {
                    showMobileGeomanControls(shape);
                    showMobileToast('Tap to add vertices \u00b7 Press Finish to complete');
                }
            }
        });
        map.on('pm:drawend', () => {
            refreshInteractionCursor();
            hideMobileDrawControls();
        });
        map.on('pm:globaleditmodetoggled', refreshInteractionCursor);
        map.on('pm:globaldragmodetoggled', refreshInteractionCursor);
        map.on('pm:globalremovalmodetoggled', refreshInteractionCursor);
        refreshInteractionCursor();
    }

    function refreshInteractionCursor() {
        const mapEl = document.getElementById('map');
        if (!mapEl || !map || !map.pm) return;

        const isArrowDraw = !!arrowDrawState;
        const isLineDraw = !!lineDrawState;
        const isFlightPathDraw = !!flightPathDrawState;
        const isGeoDraw = !!(map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled());
        const isMoveMode = !!(
            (map.pm.globalDragModeEnabled && map.pm.globalDragModeEnabled()) ||
            (map.pm.globalEditModeEnabled && map.pm.globalEditModeEnabled()) ||
            (map.pm.globalRemovalModeEnabled && map.pm.globalRemovalModeEnabled())
        );

        mapEl.classList.toggle('draw-tool-cursor', isArrowDraw || isLineDraw || isFlightPathDraw || isGeoDraw);
        mapEl.classList.toggle('move-tool-cursor', !isArrowDraw && !isGeoDraw && isMoveMode);
        map.fire('drawingmodechange');
    }

    function setupGeoman() {
        map.pm.addControls({
            position: 'topleft',
            drawMarker: false,
            drawCircleMarker: false,
            drawText: true,
            drawCircle: true,
            drawRectangle: true,
            drawPolygon: true,
            drawPolyline: false,
            cutPolygon: false,
            rotateMode: false,
            editMode: false,
            dragMode: false,
            removalMode: false
        });

        applyStyleToGeoman();
    }

    function applyStyleToGeoman() {
        const pathOpts = {
            color: currentStyle.color,
            fillColor: currentStyle.fillColor,
            fillOpacity: currentStyle.fillOpacity,
            weight: currentStyle.weight,
            dashArray: currentStyle.dashArray
        };

        const isTouch = isTouchDevice();
        map.pm.setPathOptions(pathOpts);
        map.pm.setGlobalOptions({
            pathOptions: pathOpts,
            templineStyle: { color: currentStyle.color, dashArray: '5,5' },
            hintlineStyle: { color: currentStyle.color, dashArray: '5,5' },
            snappable: true,
            snapDistance: isTouch ? 30 : 15
        });
    }

    // ============================================================
    //  ARROW DRAW TOOL - single button, two-click placement
    // ============================================================

    let arrowDrawBtn = null;
    let arrowTempLine = null;
    let arrowTempPolygon = null;

    function setupArrowDrawControl() {
        const ArrowControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const btn = L.DomUtil.create('a', 'leaflet-control-extra-draw leaflet-buttons-control-button', container);
                btn.href = '#';
                btn.title = 'Draw Arrow';
                btn.innerHTML = '<span class="control-icon lucide-arrow-big-right-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-big-right"><path d="M11 9a1 1 0 0 0 1-1V5.061a1 1 0 0 1 1.811-.75l6.836 6.836a1.207 1.207 0 0 1 0 1.707l-6.836 6.835a1 1 0 0 1-1.811-.75V16a1 1 0 0 0-1-1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"/></svg></span>';

                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(btn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    if (arrowDrawState != null) {
                        cancelArrowDraw();
                    } else {
                        startArrowDraw();
                    }
                });

                arrowDrawBtn = btn;
                return container;
            }
        });

        map.addControl(new ArrowControl());

        map.on('click', onArrowMapClick);
        map.on('mousemove', onArrowMapMouseMove);
    }

    // ============================================================
    //  LINE DRAW TOOL - two-click placement, shows distance
    // ============================================================

    let lineDrawBtn = null;
    let lineTempLine = null;

    function setupLineDrawControl() {
        const LineControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const btn = L.DomUtil.create('a', 'leaflet-control-line-draw leaflet-buttons-control-button', container);
                btn.href = '#';
                btn.title = 'Draw Line (measure distance)';
                btn.innerHTML = '<span class="control-icon lucide-ruler-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ruler"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg></span>';

                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(btn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    if (lineDrawState != null) {
                        cancelLineDraw();
                    } else {
                        startLineDraw();
                    }
                });

                lineDrawBtn = btn;
                return container;
            }
        });

        map.addControl(new LineControl());

        map.on('click', onLineMapClick);
        map.on('mousemove', onLineMapMouseMove);
    }

    function startLineDraw(optionalStartLatLng) {
        cancelArrowDraw();
        cancelFlightPathDraw();
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        lineDrawState = optionalStartLatLng
            ? { start: [optionalStartLatLng.lat, optionalStartLatLng.lng] }
            : {};
        map.doubleClickZoom.disable();
        if (lineDrawBtn) lineDrawBtn.classList.add('active-draw');
        refreshInteractionCursor();
    }

    function cancelLineDraw() {
        lineDrawState = null;
        if (lineTempLine && map.hasLayer(lineTempLine)) map.removeLayer(lineTempLine);
        lineTempLine = null;
        map.doubleClickZoom.enable();
        if (lineDrawBtn) lineDrawBtn.classList.remove('active-draw');
        refreshInteractionCursor();
    }

    function onLineMapClick(e) {
        if (!lineDrawState) return;
        const pt = [e.latlng.lat, e.latlng.lng];

        if (!lineDrawState.start) {
            lineDrawState.start = pt;
            return;
        }

        const start = lineDrawState.start;
        const end = pt;
        createLineShape(start, end);
        cancelLineDraw();
    }

    function onLineMapMouseMove(e) {
        if (!lineDrawState || !lineDrawState.start) return;
        const start = lineDrawState.start;
        const hover = [e.latlng.lat, e.latlng.lng];

        if (lineTempLine && map.hasLayer(lineTempLine)) map.removeLayer(lineTempLine);

        lineTempLine = L.polyline([start, hover], {
            color: currentStyle.color,
            weight: currentStyle.weight,
            dashArray: currentStyle.dashArray || '5,5',
            opacity: 0.8,
            interactive: false
        }).addTo(map);
    }

    function createLineShape(start, end) {
        pushUndoSnapshot();
        const shape = {
            id: nextShapeId++,
            type: 'polyline',
            label: '',
            style: { ...currentStyle },
            latlngs: [[...start], [...end]]
        };
        shapes.push(shape);
        addShapeToMap(shape);
        refreshShapesList();
    }

    // ============================================================
    //  FLIGHT PATH DRAW TOOL - polyline with direction arrows
    // ============================================================

    let flightPathDrawBtn = null;

    function setupFlightPathDrawControl() {
        const FlightPathControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const btn = L.DomUtil.create('a', 'leaflet-control-flight-path leaflet-buttons-control-button', container);
                btn.href = '#';
                btn.title = 'Draw Flight Path';
                btn.innerHTML = '<span class="control-icon lucide-drone-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m3 7l6-3l6 3l6-3v13l-6 3l-6-3l-6 3zm6 5v.01M6 13v.01M17 15l-4-4m0 4l4-4"/></svg></span>';

                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(btn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    if (flightPathDrawState) {
                        cancelFlightPathDraw();
                    } else {
                        startFlightPathDraw();
                    }
                });

                flightPathDrawBtn = btn;
                return container;
            }
        });

        map.addControl(new FlightPathControl());
    }

    function startLineDraw(optionalStartLatLng) {
        cancelArrowDraw();
        cancelFlightPathDraw();
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        lineDrawState = optionalStartLatLng
            ? { start: [optionalStartLatLng.lat, optionalStartLatLng.lng] }
            : {};
        map.doubleClickZoom.disable();
        if (lineDrawBtn) lineDrawBtn.classList.add('active-draw');
        refreshInteractionCursor();
    }

    function isTouchDevice() {
        return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    }

    function startFlightPathDraw() {
        cancelArrowDraw();
        cancelLineDraw();
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        flightPathDrawState = true;
        map.doubleClickZoom.disable();
        if (flightPathDrawBtn) flightPathDrawBtn.classList.add('active-draw');
        const isTouch = isTouchDevice();
        map.pm.enableDraw('Line', {
            pathOptions: { ...flightPathStyle },
            templineStyle: { color: flightPathStyle.color, dashArray: '5,5' },
            hintlineStyle: { color: flightPathStyle.color, dashArray: '5,5' },
            snappable: true,
            snapDistance: isTouch ? 30 : 15
        });
        refreshInteractionCursor();
        if (isTouch) {
            showMobileDrawControls();
            showMobileToast('Tap to add points \u00b7 Double-tap or press Finish to complete');
        }
    }

    function cancelFlightPathDraw() {
        flightPathDrawState = null;
        map.doubleClickZoom.enable();
        if (flightPathDrawBtn) flightPathDrawBtn.classList.remove('active-draw');
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        hideMobileDrawControls();
        refreshInteractionCursor();
    }

    // ---- Mobile draw controls (Finish / Undo / Cancel bar) ----

    function showMobileDrawControls() {
        hideMobileDrawControls();
        if (window.innerWidth > 600) return;

        const container = document.createElement('div');
        container.className = 'mobile-draw-controls';

        const finishBtn = document.createElement('button');
        finishBtn.className = 'mobile-draw-finish-btn';
        finishBtn.textContent = 'Finish';
        finishBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                if (map.pm.Draw && map.pm.Draw.Line && map.pm.Draw.Line._finishShape) {
                    map.pm.Draw.Line._finishShape();
                }
            } catch (_) { /* shape may not have enough points yet */ }
        });

        const undoBtn = document.createElement('button');
        undoBtn.className = 'mobile-draw-undo-btn';
        undoBtn.textContent = 'Undo';
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                if (map.pm.Draw && map.pm.Draw.Line && map.pm.Draw.Line._removeLastVertex) {
                    map.pm.Draw.Line._removeLastVertex();
                }
            } catch (_) { /* ignore */ }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'mobile-draw-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelFlightPathDraw();
        });

        container.appendChild(undoBtn);
        container.appendChild(finishBtn);
        container.appendChild(cancelBtn);
        document.body.appendChild(container);
        mobileDrawControlsEl = container;
        L.DomEvent.disableClickPropagation(container);
    }

    function hideMobileDrawControls() {
        if (mobileDrawControlsEl) {
            mobileDrawControlsEl.remove();
            mobileDrawControlsEl = null;
        }
    }

    function showMobileGeomanControls(shape) {
        hideMobileDrawControls();
        if (window.innerWidth > 600) return;

        const container = document.createElement('div');
        container.className = 'mobile-draw-controls';

        const finishBtn = document.createElement('button');
        finishBtn.className = 'mobile-draw-finish-btn';
        finishBtn.textContent = 'Finish';
        finishBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                const drawer = map.pm.Draw[shape];
                if (drawer && drawer._finishShape) drawer._finishShape();
            } catch (_) { /* ignore */ }
        });

        const undoBtn = document.createElement('button');
        undoBtn.className = 'mobile-draw-undo-btn';
        undoBtn.textContent = 'Undo';
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                const drawer = map.pm.Draw[shape];
                if (drawer && drawer._removeLastVertex) drawer._removeLastVertex();
            } catch (_) { /* ignore */ }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'mobile-draw-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            map.pm.disableDraw();
        });

        container.appendChild(undoBtn);
        container.appendChild(finishBtn);
        container.appendChild(cancelBtn);
        document.body.appendChild(container);
        mobileDrawControlsEl = container;
        L.DomEvent.disableClickPropagation(container);
    }

    // ---- Mobile toast notification ----

    function showMobileToast(message, durationMs) {
        if (window.innerWidth > 600) return;
        const existing = document.querySelector('.mobile-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'mobile-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        const duration = durationMs || 3500;
        setTimeout(() => {
            toast.classList.add('fade-out');
            toast.addEventListener('animationend', () => toast.remove());
        }, duration);
    }

    function startArrowDraw(optionalTailLatLng) {
        cancelLineDraw();
        cancelArrowDraw(); // clear any existing arrow state
        arrowDrawState = optionalTailLatLng
            ? { tail: [optionalTailLatLng.lat, optionalTailLatLng.lng] }
            : {};
        map.doubleClickZoom.disable();
        if (arrowDrawBtn) arrowDrawBtn.classList.add('active-draw');
        refreshInteractionCursor();
    }

    function cancelArrowDraw() {
        arrowDrawState = null;
        if (arrowTempLine && map.hasLayer(arrowTempLine)) map.removeLayer(arrowTempLine);
        if (arrowTempPolygon && map.hasLayer(arrowTempPolygon)) map.removeLayer(arrowTempPolygon);
        arrowTempLine = null;
        arrowTempPolygon = null;
        map.doubleClickZoom.enable();
        if (arrowDrawBtn) arrowDrawBtn.classList.remove('active-draw');
        refreshInteractionCursor();
    }

    function onArrowMapClick(e) {
        if (!arrowDrawState) return;
        const pt = [e.latlng.lat, e.latlng.lng];

        if (!arrowDrawState.tail) {
            arrowDrawState.tail = pt;
            return;
        }

        const tail = arrowDrawState.tail;
        const tip = pt;
        createArrowShape(tail, tip);
        cancelArrowDraw();
    }

    function onArrowMapMouseMove(e) {
        if (!arrowDrawState || !arrowDrawState.tail) return;
        const tail = arrowDrawState.tail;
        const hover = [e.latlng.lat, e.latlng.lng];

        if (arrowTempLine && map.hasLayer(arrowTempLine)) map.removeLayer(arrowTempLine);
        if (arrowTempPolygon && map.hasLayer(arrowTempPolygon)) map.removeLayer(arrowTempPolygon);

        const dist = L.latLng(tail).distanceTo(L.latLng(hover));
        if (dist < 1) return;

        const vertices = computeArrowVertices(tail, hover);
        arrowTempPolygon = L.polygon(vertices, {
            color: currentStyle.color,
            fillColor: currentStyle.fillColor,
            fillOpacity: Math.max(0.25, currentStyle.fillOpacity),
            weight: currentStyle.weight,
            dashArray: '',
            interactive: false
        }).addTo(map);
    }

    function createArrowShape(tail, tip) {
        pushUndoSnapshot();
        const shape = {
            id: nextShapeId++,
            type: 'arrow',
            label: '',
            style: { ...currentStyle, fillOpacity: Math.max(0.25, currentStyle.fillOpacity) },
            tail: [...tail],
            tip: [...tip]
        };
        shapes.push(shape);
        addShapeToMap(shape);
        refreshShapesList();
    }

    // ---- Arrow handles (tip + tail drag markers) ----

    function addArrowHandles(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || shape.type !== 'arrow') return;
        removeArrowHandles(shape.id);

        const makeHandle = (latlng) => {
            return L.marker(latlng, {
                icon: L.divIcon({
                    className: 'arrow-handle-icon',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                }),
                draggable: true,
                zIndexOffset: 1100
            }).addTo(map);
        };

        const tipHandle = makeHandle(shape.tip);
        const tailHandle = makeHandle(shape.tail);

        tipHandle.on('drag', () => {
            const pos = tipHandle.getLatLng();
            shape.tip = [pos.lat, pos.lng];
            rebuildArrowPolygon(shape);
        });
        tipHandle.on('dragend', () => {
            rebuildArrowPolygon(shape);
            refreshShapesList();
        });

        tailHandle.on('drag', () => {
            const pos = tailHandle.getLatLng();
            shape.tail = [pos.lat, pos.lng];
            rebuildArrowPolygon(shape);
        });
        tailHandle.on('dragend', () => {
            rebuildArrowPolygon(shape);
            refreshShapesList();
        });

        const bindHandleContextMenu = (handle) => {
            handle.on('contextmenu', (e) => {
                e.originalEvent._contextShapeId = shape.id;
            });
        };
        bindHandleContextMenu(tipHandle);
        bindHandleContextMenu(tailHandle);

        entry.arrowHandles = { tipHandle, tailHandle };
    }

    function refreshArrowHandlePositions(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.arrowHandles) return;
        entry.arrowHandles.tipHandle.setLatLng(shape.tip);
        entry.arrowHandles.tailHandle.setLatLng(shape.tail);
    }

    function removeArrowHandles(id) {
        const entry = shapeLayerMap[id];
        if (!entry || !entry.arrowHandles) return;
        if (entry.arrowHandles.tipHandle && map.hasLayer(entry.arrowHandles.tipHandle)) {
            map.removeLayer(entry.arrowHandles.tipHandle);
        }
        if (entry.arrowHandles.tailHandle && map.hasLayer(entry.arrowHandles.tailHandle)) {
            map.removeLayer(entry.arrowHandles.tailHandle);
        }
        entry.arrowHandles = null;
    }

    function rebuildArrowPolygon(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.layer) return;
        const vertices = computeArrowVertices(shape.tail, shape.tip);
        entry.layer.setLatLngs([vertices]);
        updateMeasurement(shape);
        updateShapeLabelMarker(shape);
        refreshArrowHandlePositions(shape);
    }

    // ---- Live radius feedback during circle draw ----

    function setupCircleDrawFeedback() {
        let drawCenter = null;
        let feedbackTooltip = null;
        let feedbackLine = null;
        let mouseMoveHandler = null;

        map.on('pm:drawstart', (e) => {
            if (e.shape !== 'Circle') return;
            drawCenter = null;
            lastCircleRadiusPoint = null;

            const workingLayer = e.workingLayer;
            if (workingLayer) {
                workingLayer.on('pm:centerplaced', (ev) => {
                    drawCenter = ev.latlng || (workingLayer.getLatLng && workingLayer.getLatLng());
                });
            }

            feedbackTooltip = L.tooltip({
                className: 'measurement-tooltip draw-feedback-tooltip',
                permanent: true,
                direction: 'right',
                offset: [15, 0]
            });

            feedbackLine = L.polyline([], {
                color: currentStyle.color,
                weight: 1,
                dashArray: '6,4',
                opacity: 0.7,
                interactive: false
            }).addTo(map);

            mouseMoveHandler = (ev) => {
                if (!drawCenter) return;
                lastCircleRadiusPoint = ev.latlng;
                const dist = drawCenter.distanceTo(ev.latlng);
                const text = dist >= 1000
                    ? `${(dist / 1000).toFixed(2)} km`
                    : `${Math.round(dist)} m`;

                feedbackTooltip.setLatLng(ev.latlng).setContent(text);
                if (!map.hasLayer(feedbackTooltip)) {
                    feedbackTooltip.addTo(map);
                }

                feedbackLine.setLatLngs([drawCenter, ev.latlng]);
            };

            map.on('mousemove', mouseMoveHandler);
        });

        function cleanupFeedback() {
            if (mouseMoveHandler) {
                map.off('mousemove', mouseMoveHandler);
                mouseMoveHandler = null;
            }
            if (feedbackTooltip && map.hasLayer(feedbackTooltip)) {
                map.removeLayer(feedbackTooltip);
            }
            if (feedbackLine && map.hasLayer(feedbackLine)) {
                map.removeLayer(feedbackLine);
            }
            drawCenter = null;
            feedbackTooltip = null;
            feedbackLine = null;
        }

        map.on('pm:create', cleanupFeedback);
        map.on('pm:drawend', cleanupFeedback);
    }

    // ============================================================
    //  STYLE PANEL - bidirectional (edits selected shape or default)
    // ============================================================

    function setupStylePanel() {
        const panel = document.getElementById('drawStylePanel');
        if (!panel) return;

        const colorInput = document.getElementById('drawColor');
        const opacityInput = document.getElementById('drawFillOpacity');
        const opacityVal = document.getElementById('drawFillOpacityVal');
        const weightInput = document.getElementById('drawWeight');
        const dashSelect = document.getElementById('drawDash');
        const toggleBtn = document.getElementById('drawStyleToggle');

        colorInput.value = currentStyle.color;
        opacityInput.value = currentStyle.fillOpacity;
        opacityVal.textContent = currentStyle.fillOpacity;
        weightInput.value = currentStyle.weight;

        colorInput.addEventListener('input', (e) => {
            if (selectedShapeId) {
                applyStyleToSelected('color', e.target.value);
            } else {
                currentStyle.color = e.target.value;
                currentStyle.fillColor = e.target.value;
                applyStyleToGeoman();
            }
        });

        opacityInput.addEventListener('input', (e) => {
            opacityVal.textContent = e.target.value;
            if (selectedShapeId) {
                applyStyleToSelected('fillOpacity', parseFloat(e.target.value));
            } else {
                currentStyle.fillOpacity = parseFloat(e.target.value);
                applyStyleToGeoman();
            }
        });

        weightInput.addEventListener('input', (e) => {
            if (selectedShapeId) {
                applyStyleToSelected('weight', parseInt(e.target.value));
            } else {
                currentStyle.weight = parseInt(e.target.value);
                applyStyleToGeoman();
            }
        });

        dashSelect.addEventListener('change', (e) => {
            if (selectedShapeId) {
                applyStyleToSelected('dashArray', e.target.value);
            } else {
                currentStyle.dashArray = e.target.value;
                applyStyleToGeoman();
            }
        });

        const flightPathArrowSizeInput = document.getElementById('drawFlightPathArrowSize');
        const flightPathArrowSizeRow = document.getElementById('drawFlightPathArrowSizeRow');
        if (flightPathArrowSizeInput && flightPathArrowSizeRow) {
            flightPathArrowSizeInput.addEventListener('input', (e) => {
                if (!selectedShapeId) return;
                const shape = shapes.find(s => s.id === selectedShapeId);
                if (!shape || shape.type !== 'flightpath') return;
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 1 && val <= 100) {
                    shape.arrowSize = val;
                    rebuildFlightPathArrows(shape);
                    refreshShapesList();
                }
            });
        }

        panel.classList.add('collapsed');

        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
            toggleBtn.innerHTML = panel.classList.contains('collapsed') ? '&plus;' : '&minus;';
        });
    }

    function applyStyleToSelected(prop, value) {
        const shape = shapes.find(s => s.id === selectedShapeId);
        if (!shape) return;

        if (prop === 'color') {
            shape.style.color = value;
            shape.style.fillColor = value;
        } else {
            shape.style[prop] = value;
        }

        const entry = shapeLayerMap[shape.id];
        if (entry && entry.layer && entry.layer.setStyle) {
            entry.layer.setStyle({
                color: shape.style.color,
                fillColor: shape.style.fillColor,
                fillOpacity: shape.style.fillOpacity,
                weight: shape.style.weight,
                dashArray: shape.style.dashArray || ''
            });
        }

        refreshShapesList();
    }

    function populatePanelFromShape(shape) {
        const headerText = document.querySelector('#drawStylePanel .draw-style-header span');
        const typeLabel = getShapeTypeLabel(shape.type);
        headerText.textContent = `Editing: ${shape.label || typeLabel}`;

        document.getElementById('drawColor').value = shape.style.color || currentStyle.color;
        document.getElementById('drawFillOpacity').value = shape.style.fillOpacity != null ? shape.style.fillOpacity : currentStyle.fillOpacity;
        document.getElementById('drawFillOpacityVal').textContent = shape.style.fillOpacity != null ? shape.style.fillOpacity : currentStyle.fillOpacity;
        document.getElementById('drawWeight').value = shape.style.weight || currentStyle.weight;
        document.getElementById('drawDash').value = shape.style.dashArray || '';

        const flightPathArrowSizeRow = document.getElementById('drawFlightPathArrowSizeRow');
        const flightPathArrowSizeInput = document.getElementById('drawFlightPathArrowSize');
        if (shape.type === 'flightpath' && flightPathArrowSizeRow && flightPathArrowSizeInput) {
            flightPathArrowSizeRow.classList.remove('hidden');
            flightPathArrowSizeInput.value = shape.arrowSize != null ? shape.arrowSize : FLIGHT_PATH_ARROW_SIZE_DEFAULT;
        } else if (flightPathArrowSizeRow) {
            flightPathArrowSizeRow.classList.add('hidden');
        }

        const panel = document.getElementById('drawStylePanel');
        panel.classList.remove('collapsed');
        panel.classList.add('editing-shape');
        const toggleBtn = document.getElementById('drawStyleToggle');
        if (toggleBtn) toggleBtn.innerHTML = '&minus;';
    }

    function restorePanelDefaults() {
        const headerText = document.querySelector('#drawStylePanel .draw-style-header span');
        headerText.textContent = 'Drawing Style';

        document.getElementById('drawColor').value = currentStyle.color;
        document.getElementById('drawFillOpacity').value = currentStyle.fillOpacity;
        document.getElementById('drawFillOpacityVal').textContent = currentStyle.fillOpacity;
        document.getElementById('drawWeight').value = currentStyle.weight;
        document.getElementById('drawDash').value = currentStyle.dashArray || '';

        const flightPathArrowSizeRow = document.getElementById('drawFlightPathArrowSizeRow');
        if (flightPathArrowSizeRow) flightPathArrowSizeRow.classList.add('hidden');

        const panel = document.getElementById('drawStylePanel');
        panel.classList.remove('editing-shape');
    }

    // ============================================================
    //  SELECTION - select/deselect shapes for per-shape editing
    // ============================================================

    function selectShape(id) {
        if (selectedShapeId && selectedShapeId !== id) {
            deselectShape();
        }

        const shape = shapes.find(s => s.id === id);
        const entry = shapeLayerMap[id];
        if (!shape || !entry || !entry.layer) return;

        selectedShapeId = id;
        populatePanelFromShape(shape);

        if (shape.type === 'arrow') {
            addArrowHandles(shape);
        }

        if (entry.layer.pm) {
            entry.layer.pm.enableLayerDrag();
            const el = entry.layer.getElement ? entry.layer.getElement() : null;
            if (el) el.classList.add('shape-draggable');
        }

        refreshShapesList();
    }

    function deselectShape() {
        if (!selectedShapeId) return;

        const entry = shapeLayerMap[selectedShapeId];
        if (entry && entry.layer) {
            const el = entry.layer.getElement ? entry.layer.getElement() : null;
            if (el) el.classList.remove('shape-draggable');

            if (entry.layer.pm) {
                entry.layer.pm.disable();
                if (entry.layer.pm.disableLayerDrag) {
                    entry.layer.pm.disableLayerDrag();
                }
            }
        }

        const shape = shapes.find(s => s.id === selectedShapeId);
        if (shape && entry && entry.layer) {
            updateShapeFromLayer(shape, entry.layer);
            updateMeasurement(shape);
        }

        removeArrowHandles(selectedShapeId);

        selectedShapeId = null;
        restorePanelDefaults();
        refreshShapesList();
    }

    function editVertices(id) {
        selectShape(id);
        panToShape(id);
        const shape = shapes.find(s => s.id === id);
        if (shape && shape.type === 'arrow') return;

        const entry = shapeLayerMap[id];
        if (entry && entry.layer && entry.layer.pm) {
            entry.layer.pm.enable();
        }
    }

    function moveShape(id) {
        selectShape(id);
        const entry = shapeLayerMap[id];
        if (entry && entry.layer && entry.layer.pm) {
            entry.layer.pm.enableLayerDrag();
        }
    }

    // ============================================================
    //  CONTEXT MENU - right-click on shapes
    // ============================================================

    function setupMapDismiss() {
        map.on('pm:globaleditmodetoggled', (e) => {
            if (e.enabled && selectedShapeId) deselectShape();
        });
        map.on('pm:globaldragmodetoggled', (e) => {
            if (e.enabled && selectedShapeId) deselectShape();
        });
        map.on('pm:globalremovalmodetoggled', (e) => {
            if (e.enabled && selectedShapeId) deselectShape();
        });
    }

    // ============================================================
    //  KEYBOARD SHORTCUTS
    // ============================================================

    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
            const isPaste = (e.ctrlKey || e.metaKey) && e.key === 'v';
            if (isCopy && selectedShapeId) {
                e.preventDefault();
                copyShape(selectedShapeId);
                return;
            }
            if (isPaste && hasClipboard()) {
                e.preventDefault();
                pasteShape(null);
                return;
            }
            if (e.key === 'Escape') {
                const modal = document.getElementById('shapeEditModal');
                if (modal && !modal.classList.contains('hidden')) {
                    modal.classList.add('hidden');
                    return;
                }

                if (selectedShapeId) {
                    deselectShape();
                    return;
                }

                if (arrowDrawState) {
                    cancelArrowDraw();
                    return;
                }

                if (flightPathDrawState) {
                    cancelFlightPathDraw();
                    return;
                }

                if (lineDrawState) {
                    cancelLineDraw();
                    return;
                }

                if (map.pm.globalDrawModeEnabled()) {
                    map.pm.disableDraw();
                }
            }
        });
    }

    // ============================================================
    //  SHAPE INTERACTIONS - bind right-click & double-click to layers
    // ============================================================

    function bindShapeInteractions(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.layer) return;
        const layer = entry.layer;

        layer.on('contextmenu', (e) => {
            e.originalEvent._contextShapeId = shape.id;
        });

        layer.on('click', () => {
            selectShape(shape.id);
        });

        layer.on('dblclick', (e) => {
            L.DomEvent.stop(e);
            openShapeEditModal(shape.id);
        });

        if (shape.type === 'arrow') {
            layer.on('pm:drag', () => {
                const verts = flattenLatLngs(layer.getLatLngs());
                const { tail, tip } = extractTailTipFromVertices(verts);
                shape.tail = tail;
                shape.tip = tip;
                updateMeasurement(shape);
                updateShapeLabelMarker(shape);
                refreshArrowHandlePositions(shape);
            });
            layer.on('pm:dragend', () => {
                const verts = flattenLatLngs(layer.getLatLngs());
                const { tail, tip } = extractTailTipFromVertices(verts);
                shape.tail = tail;
                shape.tip = tip;
                rebuildArrowPolygon(shape);
                refreshShapesList();
            });
            return;
        }

        layer.on('pm:drag', () => {
            updateShapeFromLayer(shape, layer);
            updateMeasurement(shape);
            updateShapeLabelMarker(shape);
        });
        layer.on('pm:dragend', () => {
            updateShapeFromLayer(shape, layer);
            updateMeasurement(shape);
            updateShapeLabelMarker(shape);
            refreshShapesList();
        });
    }

    // ---- Shape Events ----

    function setupShapeEvents() {
        map.on('pm:create', (e) => {
            pushUndoSnapshot();
            const layer = e.layer;
            const shapeType = e.shape;

            // Intercept Line creation when in flight path mode
            if (flightPathDrawState && shapeType === 'Line') {
                const latlngs = flattenLatLngs(layer.getLatLngs());
                if (latlngs.length < 2) return;
                map.removeLayer(layer);
                flightPathDrawState = null;
                if (flightPathDrawBtn) flightPathDrawBtn.classList.remove('active-draw');
                map.doubleClickZoom.enable();
                if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
                    map.pm.disableDraw();
                }
                hideMobileDrawControls();
                refreshInteractionCursor();

                const shape = {
                    id: nextShapeId++,
                    type: 'flightpath',
                    label: '',
                    style: { ...flightPathStyle },
                    latlngs,
                    arrowSize: FLIGHT_PATH_ARROW_SIZE_DEFAULT
                };
                shapes.push(shape);
                addShapeToMap(shape);
                refreshShapesList();
                return;
            }

            const shape = layerToShape(layer, shapeType);
            shapes.push(shape);

            layer._shapeId = shape.id;
            shapeLayerMap[shape.id] = { layer };

            if (shape.type === 'text') {
                if (shape.text) applyTextAnnotationStyle(layer, shape);
                if (layer.dragging && layer.dragging.enable) layer.dragging.enable();
            }

            if (showMeasurements) {
                addMeasurement(shape);
            }

            bindShapeInteractions(shape);
            addShapeLabelMarker(shape);
            refreshShapesList();
        });

        map.on('pm:edit', (e) => {
            const layer = e.layer;
            const id = layer._shapeId;
            if (!id) return;

            const shape = shapes.find(s => s.id === id);
            if (!shape) return;
            pushUndoSnapshot();

            updateShapeFromLayer(shape, layer);
            if (shape.type === 'text' && shape.text) {
                applyTextAnnotationStyle(layer, shape);
            }
            updateMeasurement(shape);
            updateShapeLabelMarker(shape);
            refreshShapesList();
        });

        map.on('pm:remove', (e) => {
            const layer = e.layer;
            const id = layer._shapeId;
            if (!id) return;
            pushUndoSnapshot();

            if (selectedShapeId === id) {
                selectedShapeId = null;
                restorePanelDefaults();
            }

            removeMeasurement(id);
            removeShapeLabelMarker(id);
            removeArrowHandles(id);
            shapes = shapes.filter(s => s.id !== id);
            delete shapeLayerMap[id];
            refreshShapesList();
        });

        map.on('pm:globaleditmodetoggled', (e) => {
            if (e.enabled) {
                pushUndoSnapshot();
            } else {
                for (const shape of shapes) {
                    const entry = shapeLayerMap[shape.id];
                    if (entry && entry.layer) {
                        updateShapeFromLayer(shape, entry.layer);
                        if (shape.type === 'text' && shape.text) {
                            applyTextAnnotationStyle(entry.layer, shape);
                        }
                        updateMeasurement(shape);
                        updateShapeLabelMarker(shape);
                    }
                }
                refreshShapesList();
            }
        });

        map.on('pm:globaldragmodetoggled', (e) => {
            if (e.enabled) {
                pushUndoSnapshot();
            } else {
                for (const shape of shapes) {
                    const entry = shapeLayerMap[shape.id];
                    if (entry && entry.layer) {
                        updateShapeFromLayer(shape, entry.layer);
                        if (shape.type === 'text' && shape.text) {
                            applyTextAnnotationStyle(entry.layer, shape);
                        }
                        updateMeasurement(shape);
                        updateShapeLabelMarker(shape);
                    }
                }
            }
        });
    }

    // ---- Layer <-> Shape conversion ----

    function layerToShape(layer, shapeType) {
        const shape = {
            id: nextShapeId++,
            type: normalizeType(shapeType),
            label: '',
            style: { ...currentStyle },
        };

        if (shape.type === 'circle') {
            const center = layer.getLatLng();
            shape.center = [center.lat, center.lng];
            shape.radius = layer.getRadius();
            if (lastCircleRadiusPoint) {
                shape.measureAngle = bearingTo(center.lat, center.lng, lastCircleRadiusPoint.lat, lastCircleRadiusPoint.lng);
            } else {
                shape.measureAngle = 45;
            }
        } else if (shape.type === 'text') {
            const pos = layer.getLatLng();
            shape.position = [pos.lat, pos.lng];
            shape.text = layer.pm.getText ? layer.pm.getText() : (layer.options.text || '');
            if (!shape.textStyle) {
                shape.textStyle = { preset: 'label', fontSize: 12 };
            }
        } else {
            const latlngs = layer.getLatLngs();
            shape.latlngs = flattenLatLngs(latlngs);
        }

        return shape;
    }

    function updateShapeFromLayer(shape, layer) {
        if (shape.type === 'circle') {
            const center = layer.getLatLng();
            shape.center = [center.lat, center.lng];
            shape.radius = layer.getRadius();
        } else if (shape.type === 'arrow') {
            const verts = flattenLatLngs(layer.getLatLngs());
            const { tail, tip } = extractTailTipFromVertices(verts);
            shape.tail = tail;
            shape.tip = tip;
        } else if (shape.type === 'text') {
            const pos = layer.getLatLng();
            shape.position = [pos.lat, pos.lng];
            if (layer.pm && layer.pm.getText) {
                shape.text = layer.pm.getText();
            }
        } else if (shape.type === 'curve') {
            return;
        } else if (shape.type === 'flightpath') {
            const latlngs = layer.getLatLngs();
            shape.latlngs = flattenLatLngs(latlngs);
            rebuildFlightPathArrows(shape);
        } else {
            const latlngs = layer.getLatLngs();
            shape.latlngs = flattenLatLngs(latlngs);
        }
    }

    function normalizeType(geomanType) {
        const typeMap = {
            'Circle': 'circle',
            'Polygon': 'polygon',
            'Rectangle': 'rectangle',
            'Line': 'polyline',
            'Text': 'text',
            'Curve': 'curve'
        };
        return typeMap[geomanType] || geomanType.toLowerCase();
    }

    function flattenLatLngs(latlngs) {
        if (latlngs.length > 0 && Array.isArray(latlngs[0]) && latlngs[0].length > 0 && typeof latlngs[0][0] !== 'number') {
            return latlngs[0].map(ll => ll.lat !== undefined ? [ll.lat, ll.lng] : ll);
        }
        return latlngs.map(ll => ll.lat !== undefined ? [ll.lat, ll.lng] : ll);
    }

    // ---- Flight path arrow markers ----

    function createFlightPathArrows(shape) {
        const group = L.layerGroup();
        const fpStyle = shape.style || flightPathStyle;
        const color = fpStyle.color || flightPathStyle.color;
        const baseArrowSize = shape.arrowSize != null ? shape.arrowSize : FLIGHT_PATH_ARROW_SIZE_DEFAULT;
        const zoomScale = getFlightPathZoomScale();
        const arrowSize = baseArrowSize * zoomScale;
        const interval = FLIGHT_PATH_ARROW_INTERVAL * zoomScale;
        const points = getPointsAlongPath(shape.latlngs, interval);
        for (const p of points) {
            const verts = computeArrowheadVertices(p.latlng, p.bearing, arrowSize);
            const arrow = L.polygon(verts, {
                color,
                fillColor: color,
                fillOpacity: 0.9,
                weight: 1,
                interactive: false
            });
            group.addLayer(arrow);
        }
        // Add arrow at end of path to show final direction
        if (shape.latlngs && shape.latlngs.length >= 2) {
            const last = shape.latlngs[shape.latlngs.length - 1];
            const prev = shape.latlngs[shape.latlngs.length - 2];
            const bearing = bearingTo(prev[0], prev[1], last[0], last[1]);
            const verts = computeArrowheadVertices(last, bearing, arrowSize);
            const endArrow = L.polygon(verts, {
                color,
                fillColor: color,
                fillOpacity: 0.9,
                weight: 1,
                interactive: false
            });
            group.addLayer(endArrow);
        }
        return group;
    }

    function rebuildFlightPathArrows(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.arrowGroup) return;
        map.removeLayer(entry.arrowGroup);
        const newGroup = createFlightPathArrows(shape);
        newGroup.addTo(map);
        entry.arrowGroup = newGroup;
    }

    // ---- Add shapes to map (from loaded data) ----

    function addShapeToMap(shape) {
        let layer;
        const style = shape.style || currentStyle;
        const pathOpts = {
            color: style.color || currentStyle.color,
            fillColor: style.fillColor || style.color || currentStyle.fillColor,
            fillOpacity: style.fillOpacity != null ? style.fillOpacity : currentStyle.fillOpacity,
            weight: style.weight || currentStyle.weight,
            dashArray: style.dashArray || ''
        };

        if (shape.type === 'circle') {
            layer = L.circle(shape.center, {
                radius: shape.radius,
                ...pathOpts
            }).addTo(map);
        } else if (shape.type === 'text') {
            layer = L.marker(shape.position, {
                textMarker: true,
                text: shape.text || '',
                draggable: true
            }).addTo(map);
            if (shape.text) {
                applyTextAnnotationStyle(layer, shape);
            }
        } else if (shape.type === 'arrow') {
            const vertices = computeArrowVertices(shape.tail, shape.tip);
            layer = L.polygon(vertices, pathOpts).addTo(map);
        } else if (shape.type === 'rectangle') {
            layer = L.rectangle(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'polyline') {
            const lineRenderer = L.canvas({ tolerance: 12 });
            layer = L.polyline(shape.latlngs, { ...pathOpts, renderer: lineRenderer }).addTo(map);
        } else if (shape.type === 'flightpath') {
            const fpStyle = shape.style || flightPathStyle;
            const fpPathOpts = {
                color: fpStyle.color || flightPathStyle.color,
                fillColor: fpStyle.fillColor || fpStyle.color || flightPathStyle.fillColor,
                fillOpacity: 0,
                weight: fpStyle.weight || flightPathStyle.weight,
                dashArray: fpStyle.dashArray || flightPathStyle.dashArray
            };
            const fpRenderer = L.canvas({ tolerance: 12 });
            layer = L.polyline(shape.latlngs, { ...fpPathOpts, renderer: fpRenderer }).addTo(map);
            const arrowGroup = createFlightPathArrows(shape);
            arrowGroup.addTo(map);
            shapeLayerMap[shape.id] = { layer, arrowGroup };
        } else if (shape.type === 'polygon') {
            layer = L.polygon(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'curve' && shape.curvePoints && shape.curvePoints.length >= 3 && L.curve) {
            layer = L.curve(['M', shape.curvePoints[0], 'Q', shape.curvePoints[1], shape.curvePoints[2]], pathOpts).addTo(map);
        }

        if (layer) {
            layer._shapeId = shape.id;
            if (layer.pm) {
                layer.pm.setOptions({ allowSelfIntersection: false });
            }
            if (!shapeLayerMap[shape.id]) shapeLayerMap[shape.id] = { layer };

            if (showMeasurements) {
                addMeasurement(shape);
            }
            addShapeLabelMarker(shape);
            bindShapeInteractions(shape);
        }
    }

    // ============================================================
    //  MEASUREMENTS
    // ============================================================

    function addMeasurement(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.layer || shape.type === 'text') return;

        if (shape.type === 'circle') {
            createRadialMeasurement(shape);
        } else if ((shape.type === 'polyline' || shape.type === 'flightpath') && shape.latlngs && shape.latlngs.length >= 2) {
            const text = getMeasurementText(shape);
            if (text) createLineMeasurement(shape);
        } else {
            const text = getMeasurementText(shape);
            if (!text) return;

            const tooltip = L.tooltip({
                permanent: true,
                direction: 'center',
                className: 'measurement-tooltip'
            }).setContent(text);

            entry.layer.bindTooltip(tooltip);
            entry.measureTooltip = tooltip;
        }
    }

    function updateMeasurement(shape) {
        if (!showMeasurements) {
            removeMeasurement(shape.id);
            return;
        }

        if (shape.type === 'circle') {
            updateRadialMeasurement(shape);
        } else if (shape.type === 'polyline' || shape.type === 'flightpath') {
            const text = getMeasurementText(shape);
            if (!text) {
                removeLineMeasurement(shape.id);
                return;
            }
            if (shapeLayerMap[shape.id]?.lineMeasureGroup) {
                updateLineMeasurement(shape);
            } else {
                createLineMeasurement(shape);
            }
        } else {
            const entry = shapeLayerMap[shape.id];
            if (!entry || shape.type === 'text') return;
            const text = getMeasurementText(shape);
            if (entry.layer.getTooltip()) {
                if (text) {
                    entry.layer.getTooltip().setContent(text);
                } else {
                    entry.layer.unbindTooltip();
                }
            } else if (text) {
                addMeasurement(shape);
            }
        }
    }

    function removeMeasurement(id) {
        const entry = shapeLayerMap[id];
        if (!entry) return;

        const shape = shapes.find(s => s.id === id);
        if (shape && shape.type === 'circle') {
            removeRadialMeasurement(id);
        } else if (shape && (shape.type === 'polyline' || shape.type === 'flightpath')) {
            removeLineMeasurement(id);
        } else {
            if (entry.layer && entry.layer.getTooltip()) {
                entry.layer.unbindTooltip();
            }
            entry.measureTooltip = null;
        }
    }

    // ---- Radial dimension line for circles ----

    function makeLabelIcon(text, draggable) {
        const cls = draggable ? 'radial-label-marker radial-label-draggable' : 'radial-label-marker';
        return L.divIcon({
            className: cls,
            html: `<div class="radial-measurement-label">${escapeHtml(String(text || ''))}</div>`,
            iconSize: null,
            iconAnchor: [0, 14]
        });
    }

    function createLineMeasurement(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.layer || !shape.latlngs || shape.latlngs.length < 2) return;

        removeLineMeasurement(shape.id);

        const text = getMeasurementText(shape);
        if (!text) return;

        const ratio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
        const labelPt = pointAlongPolyline(shape.latlngs, ratio);

        const label = L.marker(labelPt, {
            icon: makeLabelIcon(text, true),
            draggable: true,
            zIndexOffset: 900
        }).addTo(map);

        label.on('drag', (e) => {
            const pos = e.target.getLatLng();
            const newRatio = projectOntoPolyline(shape.latlngs, pos);
            const newLabelPt = pointAlongPolyline(shape.latlngs, newRatio);
            e.target.setLatLng(newLabelPt);
            shape.measureLabelRatio = newRatio;
        });

        label.on('dragend', () => {
            const pos = label.getLatLng();
            const finalRatio = projectOntoPolyline(shape.latlngs, pos);
            const finalLabelPt = pointAlongPolyline(shape.latlngs, finalRatio);
            label.setLatLng(finalLabelPt);
            shape.measureLabelRatio = finalRatio;
        });

        label.on('contextmenu', (e) => {
            e.originalEvent._contextShapeId = shape.id;
        });

        entry.lineMeasureGroup = { label };
    }

    function updateLineMeasurement(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry) return;

        if (!entry.lineMeasureGroup) {
            if (showMeasurements) createLineMeasurement(shape);
            return;
        }

        const ratio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
        const labelPt = pointAlongPolyline(shape.latlngs, ratio);
        const text = getMeasurementText(shape);

        const lg = entry.lineMeasureGroup;
        lg.label.setLatLng(labelPt);
        lg.label.setIcon(makeLabelIcon(text || '', true));
    }

    function removeLineMeasurement(id) {
        const entry = shapeLayerMap[id];
        if (!entry || !entry.lineMeasureGroup) return;

        const lg = entry.lineMeasureGroup;
        if (lg.label && map.hasLayer(lg.label)) map.removeLayer(lg.label);
        entry.lineMeasureGroup = null;
    }

    function createRadialMeasurement(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry) return;

        removeRadialMeasurement(shape.id);

        const angle = shape.measureAngle != null ? shape.measureAngle : 45;
        const center = shape.center;
        const radius = shape.radius;
        const edgePt = destinationPoint(center[0], center[1], angle, radius);
        const labelRatio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
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

        const text = getMeasurementText(shape);
        const label = L.marker(labelPt, {
            icon: makeLabelIcon(text || '', true),
            draggable: true,
            zIndexOffset: 900
        }).addTo(map);

        label.on('drag', (e) => {
            const pos = e.target.getLatLng();
            const currentEdge = handle.getLatLng();
            const newRatio = projectOntoRadius(center, [currentEdge.lat, currentEdge.lng], pos);
            const newLabelPt = pointAlongRadius(center, [currentEdge.lat, currentEdge.lng], newRatio);
            e.target.setLatLng(newLabelPt);
            shape.measureLabelRatio = newRatio;
        });

        label.on('dragend', () => {
            const pos = label.getLatLng();
            const currentEdge = handle.getLatLng();
            const finalRatio = projectOntoRadius(center, [currentEdge.lat, currentEdge.lng], pos);
            const finalLabelPt = pointAlongRadius(center, [currentEdge.lat, currentEdge.lng], finalRatio);
            label.setLatLng(finalLabelPt);
            shape.measureLabelRatio = finalRatio;
        });

        label.on('contextmenu', (e) => {
            e.originalEvent._contextShapeId = shape.id;
        });

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

        handle.on('drag', (e) => {
            const pos = e.target.getLatLng();
            const newAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            const newRadius = Math.max(1, L.latLng(center).distanceTo(L.latLng(pos)));
            const newEdge = destinationPoint(center[0], center[1], newAngle, newRadius);
            const ratio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
            const newLabelPt = pointAlongRadius(center, newEdge, ratio);

            shape.radius = newRadius;
            shape.measureAngle = newAngle;
            if (entry.layer && entry.layer.setRadius) entry.layer.setRadius(newRadius);
            e.target.setLatLng(newEdge);
            line.setLatLngs([center, newEdge]);
            label.setLatLng(newLabelPt);
            label.setIcon(makeLabelIcon(getMeasurementText(shape) || '', true));
        });

        handle.on('dragend', () => {
            const pos = handle.getLatLng();
            const finalAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            const finalRadius = Math.max(1, L.latLng(center).distanceTo(L.latLng(pos)));
            const finalEdge = destinationPoint(center[0], center[1], finalAngle, finalRadius);
            const ratio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;

            shape.radius = finalRadius;
            shape.measureAngle = finalAngle;
            if (entry.layer && entry.layer.setRadius) entry.layer.setRadius(finalRadius);
            handle.setLatLng(finalEdge);
            line.setLatLngs([center, finalEdge]);
            label.setLatLng(pointAlongRadius(center, finalEdge, ratio));
            label.setIcon(makeLabelIcon(getMeasurementText(shape) || '', true));

            pushUndoSnapshot();
            const modal = document.getElementById('shapeEditModal');
            if (modal && !modal.classList.contains('hidden') && parseInt(document.getElementById('editShapeId').value, 10) === shape.id) {
                document.getElementById('editShapeRadius').value = Math.round(shape.radius);
                document.getElementById('editShapeAngle').value = Math.round(shape.measureAngle || 45);
            }
        });

        handle.on('contextmenu', (e) => {
            e.originalEvent._contextShapeId = shape.id;
        });

        entry.radialGroup = { line, centerDot, label, handle };
    }

    function updateRadialMeasurement(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry) return;

        if (!entry.radialGroup) {
            if (showMeasurements) createRadialMeasurement(shape);
            return;
        }

        const angle = shape.measureAngle != null ? shape.measureAngle : 45;
        const center = shape.center;
        const radius = shape.radius;
        const edgePt = destinationPoint(center[0], center[1], angle, radius);
        const labelRatio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
        const labelPt = pointAlongRadius(center, edgePt, labelRatio);
        const text = getMeasurementText(shape);

        const rg = entry.radialGroup;
        rg.line.setLatLngs([center, edgePt]);
        rg.centerDot.setLatLng(center);
        rg.label.setLatLng(labelPt);
        rg.label.setIcon(makeLabelIcon(text || '', true));
        rg.handle.setLatLng(edgePt);
    }

    function removeRadialMeasurement(id) {
        const entry = shapeLayerMap[id];
        if (!entry || !entry.radialGroup) return;

        const rg = entry.radialGroup;
        if (rg.line && map.hasLayer(rg.line)) map.removeLayer(rg.line);
        if (rg.centerDot && map.hasLayer(rg.centerDot)) map.removeLayer(rg.centerDot);
        if (rg.label && map.hasLayer(rg.label)) map.removeLayer(rg.label);
        if (rg.handle && map.hasLayer(rg.handle)) map.removeLayer(rg.handle);
        entry.radialGroup = null;
    }

    // ---- Measurement text ----

    function getMeasurementText(shape) {
        if (shape.type === 'circle') {
            const r = shape.radius;
            if (r >= 1000) return `${(r / 1000).toFixed(2)} km`;
            return `${Math.round(r)} m`;
        }

        if (shape.type === 'polyline') {
            const dist = calcPolylineLength(shape.latlngs);
            if (dist >= 1000) return `${(dist / 1000).toFixed(2)} km`;
            return `${Math.round(dist)} m`;
        }

        if (shape.type === 'flightpath') {
            const showDist = shape.showDistance !== undefined ? shape.showDistance : showFlightPathDistance;
            if (!showDist) return null;
            const dist = calcPolylineLength(shape.latlngs);
            if (dist >= 1000) return `${(dist / 1000).toFixed(2)} km`;
            return `${Math.round(dist)} m`;
        }

        if (shape.type === 'arrow') {
            return null;
        }

        if (shape.type === 'curve') {
            return null;
        }

        if (shape.type === 'polygon' || shape.type === 'rectangle') {
            return null;
        }

        return null;
    }

    function calcPolylineLength(latlngs) {
        let total = 0;
        for (let i = 1; i < latlngs.length; i++) {
            const a = L.latLng(latlngs[i - 1]);
            const b = L.latLng(latlngs[i]);
            total += a.distanceTo(b);
        }
        return total;
    }

    function calcCurveLength(points) {
        if (!points || points.length < 3) return 0;
        const p0 = points[0];
        const p1 = points[1];
        const p2 = points[2];
        let length = 0;
        let prev = p0;
        for (let i = 1; i <= 24; i++) {
            const t = i / 24;
            const omt = 1 - t;
            const lat = omt * omt * p0[0] + 2 * omt * t * p1[0] + t * t * p2[0];
            const lng = omt * omt * p0[1] + 2 * omt * t * p1[1] + t * t * p2[1];
            const curr = [lat, lng];
            length += L.latLng(prev).distanceTo(L.latLng(curr));
            prev = curr;
        }
        return length;
    }

    function calcPolygonArea(latlngs) {
        if (latlngs.length < 3) return 0;
        let area = 0;
        const R = 6371000;
        const toRad = Math.PI / 180;

        for (let i = 0; i < latlngs.length; i++) {
            const j = (i + 1) % latlngs.length;
            const lat1 = latlngs[i][0] * toRad;
            const lat2 = latlngs[j][0] * toRad;
            const lon1 = latlngs[i][1] * toRad;
            const lon2 = latlngs[j][1] * toRad;
            area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
        }

        return Math.abs(area * R * R / 2);
    }

    function toggleMeasurements(show) {
        showMeasurements = show;
        for (const shape of shapes) {
            if (show) {
                addMeasurement(shape);
            } else {
                removeMeasurement(shape.id);
            }
        }
    }

    function toggleFlightPathDistance(show) {
        showFlightPathDistance = show;
        for (const shape of shapes) {
            if (shape.type === 'flightpath') {
                updateMeasurement(shape);
            }
        }
    }

    // ============================================================
    //  SHAPE LABELS ON MAP
    // ============================================================

    function projectOutwardPixels(anchorLatLng, centerLatLng, pixels) {
        if (!map) return anchorLatLng;

        const a = map.latLngToLayerPoint(L.latLng(anchorLatLng));
        const c = map.latLngToLayerPoint(L.latLng(centerLatLng));
        let dx = a.x - c.x;
        let dy = a.y - c.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        dx /= len;
        dy /= len;

        const shifted = L.point(a.x + dx * pixels, a.y + dy * pixels);
        return map.layerPointToLatLng(shifted);
    }

    function getShapeCentroid(shape) {
        if (!shape.latlngs || shape.latlngs.length === 0) return null;
        let latSum = 0;
        let lngSum = 0;
        for (const ll of shape.latlngs) {
            latSum += ll[0];
            lngSum += ll[1];
        }
        return [latSum / shape.latlngs.length, lngSum / shape.latlngs.length];
    }

    function getShapeLabelAnchor(shape) {
        if (shape.type === 'text') return null;

        if (shape.type === 'circle' && shape.center && shape.radius != null) {
            const angle = shape.measureAngle != null ? shape.measureAngle : 45;
            const edge = destinationPoint(shape.center[0], shape.center[1], angle, shape.radius);
            return projectOutwardPixels(edge, shape.center, 14);
        }

        if ((shape.type === 'polyline' || shape.type === 'flightpath') && shape.latlngs && shape.latlngs.length >= 2) {
            const end = shape.latlngs[shape.latlngs.length - 1];
            const prev = shape.latlngs[shape.latlngs.length - 2];
            const mid2 = midpoint(prev, end);
            return projectOutwardPixels(end, mid2, 12);
        }

        if (shape.type === 'arrow' && shape.tip && shape.tail) {
            return projectOutwardPixels(shape.tip, shape.tail, 16);
        }

        if (shape.type === 'curve' && shape.curvePoints && shape.curvePoints.length >= 3) {
            const end = shape.curvePoints[2];
            const ctrl = shape.curvePoints[1];
            return projectOutwardPixels(end, ctrl, 12);
        }

        if (shape.latlngs && shape.latlngs.length > 0) {
            const centroid = getShapeCentroid(shape);
            if (!centroid) return null;

            let minLat = shape.latlngs[0][0];
            let maxLat = shape.latlngs[0][0];
            let maxLng = shape.latlngs[0][1];
            for (const ll of shape.latlngs) {
                minLat = Math.min(minLat, ll[0]);
                maxLat = Math.max(maxLat, ll[0]);
                maxLng = Math.max(maxLng, ll[1]);
            }
            const edge = [(minLat + maxLat) / 2, maxLng];
            return projectOutwardPixels(edge, centroid, 12);
        }

        return null;
    }

    function addShapeLabelMarker(shape) {
        if (!showShapeLabels || !shape.label || shape.type === 'text') return;

        const entry = shapeLayerMap[shape.id];
        if (!entry) return;

        removeShapeLabelMarker(shape.id);

        const anchor = getShapeLabelAnchor(shape);
        if (!anchor) return;

        const icon = L.divIcon({
            className: 'shape-label-marker',
            html: `<div class="shape-label-text">${escapeHtml(shape.label)}</div>`,
            iconSize: null,
            iconAnchor: [0, 0]
        });

        const marker = L.marker(anchor, {
            icon: icon,
            interactive: true,
            zIndexOffset: 800
        }).addTo(map);

        marker.on('contextmenu', (e) => {
            e.originalEvent._contextShapeId = shape.id;
        });

        entry.labelMarker = marker;
    }

    function updateShapeLabelMarker(shape) {
        if (!showShapeLabels || !shape.label || shape.type === 'text') {
            removeShapeLabelMarker(shape.id);
            return;
        }

        const entry = shapeLayerMap[shape.id];
        if (!entry) return;

        if (entry.labelMarker) {
            const anchor = getShapeLabelAnchor(shape);
            if (anchor) {
                entry.labelMarker.setLatLng(anchor);
                entry.labelMarker.setIcon(L.divIcon({
                    className: 'shape-label-marker',
                    html: `<div class="shape-label-text">${escapeHtml(shape.label)}</div>`,
                    iconSize: null,
                    iconAnchor: [0, 0]
                }));
            }
        } else {
            addShapeLabelMarker(shape);
        }
    }

    function removeShapeLabelMarker(id) {
        const entry = shapeLayerMap[id];
        if (entry && entry.labelMarker) {
            if (map.hasLayer(entry.labelMarker)) {
                map.removeLayer(entry.labelMarker);
            }
            entry.labelMarker = null;
        }
    }

    function toggleShapeLabels(show) {
        showShapeLabels = show;
        for (const shape of shapes) {
            if (show) {
                addShapeLabelMarker(shape);
            } else {
                removeShapeLabelMarker(shape.id);
            }
        }
    }

    // ---- Shape Edit Modal ----

    function openShapeEditModal(id) {
        const shape = shapes.find(s => s.id === id);
        if (!shape) return;

        document.getElementById('editShapeId').value = id;
        document.getElementById('editShapeLabel').value = shape.label || '';
        document.getElementById('editShapeColor').value = shape.style.color || currentStyle.color;
        document.getElementById('editShapeFillOpacity').value = shape.style.fillOpacity != null ? shape.style.fillOpacity : currentStyle.fillOpacity;
        document.getElementById('editShapeFillOpacityVal').textContent = (shape.style.fillOpacity != null ? shape.style.fillOpacity : currentStyle.fillOpacity);
        document.getElementById('editShapeWeight').value = shape.style.weight || currentStyle.weight;

        const textGroup = document.getElementById('editShapeTextGroup');
        const textStyleGroup = document.getElementById('editShapeTextStyleGroup');
        const textColorGroup = document.getElementById('editShapeTextColorGroup');
        const textBgGroup = document.getElementById('editShapeTextBgGroup');
        const textSizeGroup = document.getElementById('editShapeTextSizeGroup');
        const colorGroup = document.getElementById('editShapeColorGroup');
        const fillOpacityGroup = document.getElementById('editShapeFillOpacityGroup');
        const weightGroup = document.getElementById('editShapeWeightGroup');
        const labelGroup = document.getElementById('editShapeLabelGroup');
        const labelHint = document.getElementById('editShapeLabelHint');
        const labelInput = document.getElementById('editShapeLabel');

        if (shape.type === 'text') {
            textGroup.classList.remove('hidden');
            textStyleGroup.classList.remove('hidden');
            textSizeGroup.classList.remove('hidden');
            if (labelHint) labelHint.textContent = 'Optional: name for sidebar list';
            if (labelInput) labelInput.placeholder = 'e.g. Note 1, Waypoint label...';
            document.getElementById('editShapeText').value = shape.text || '';
            const ts = shape.textStyle || { preset: 'label', fontSize: 12 };
            document.getElementById('editShapeTextPreset').value = ts.preset || 'label';
            document.getElementById('editShapeTextColor').value = ts.textColor || currentStyle.color;
            document.getElementById('editShapeTextBg').value = ts.bgColor || '#1e1e2e';
            document.getElementById('editShapeTextSize').value = ts.fontSize || 12;
            textColorGroup.classList.toggle('hidden', ts.preset !== 'custom' && ts.preset !== 'highlight');
            textBgGroup.classList.toggle('hidden', ts.preset !== 'custom');
            colorGroup.classList.add('hidden');
            fillOpacityGroup.classList.add('hidden');
            weightGroup.classList.add('hidden');
        } else {
            textGroup.classList.add('hidden');
            textStyleGroup.classList.add('hidden');
            textColorGroup.classList.add('hidden');
            textBgGroup.classList.add('hidden');
            textSizeGroup.classList.add('hidden');
            colorGroup.classList.remove('hidden');
            fillOpacityGroup.classList.remove('hidden');
            weightGroup.classList.remove('hidden');
            if (labelHint) labelHint.textContent = 'Shown in sidebar list';
            if (labelInput) labelInput.placeholder = 'e.g. Max Flight Radius, No-Fly Zone...';
        }

        const radiusGroup = document.getElementById('editShapeRadiusGroup');
        const angleGroup = document.getElementById('editShapeAngleGroup');
        const radiusLabel = radiusGroup ? radiusGroup.querySelector('label[for="editShapeRadius"]') : null;
        const angleLabel = angleGroup ? angleGroup.querySelector('label[for="editShapeAngle"]') : null;
        const angleHint = angleGroup ? angleGroup.querySelector('.form-hint') : null;

        if (shape.type === 'circle') {
            radiusGroup.classList.remove('hidden');
            angleGroup.classList.remove('hidden');
            if (radiusLabel) radiusLabel.textContent = 'Radius (metres)';
            if (angleLabel) angleLabel.innerHTML = 'Label Angle (0-360&deg;, 0=North)';
            if (angleHint) angleHint.textContent = 'Or drag the handle on the map to change angle or radius';
            document.getElementById('editShapeRadius').value = Math.round(shape.radius);
            document.getElementById('editShapeAngle').value = Math.round(shape.measureAngle || 45);
        } else if (shape.type === 'arrow') {
            radiusGroup.classList.remove('hidden');
            angleGroup.classList.remove('hidden');
            const arrowLen = L.latLng(shape.tail).distanceTo(L.latLng(shape.tip));
            const arrowBearing = bearingTo(shape.tail[0], shape.tail[1], shape.tip[0], shape.tip[1]);
            if (radiusLabel) radiusLabel.textContent = 'Arrow Length (metres)';
            if (angleLabel) angleLabel.innerHTML = 'Arrow Direction (0-360&deg;, 0=North)';
            if (angleHint) angleHint.textContent = 'Or drag the tip/tail handles on the map';
            document.getElementById('editShapeRadius').value = Math.round(arrowLen);
            document.getElementById('editShapeAngle').value = Math.round(arrowBearing);
        } else {
            radiusGroup.classList.add('hidden');
            angleGroup.classList.add('hidden');
        }

        const flightPathArrowSizeGroup = document.getElementById('editShapeFlightPathArrowSizeGroup');
        const flightPathDistanceGroup = document.getElementById('editShapeFlightPathDistanceGroup');
        const flightPathShowDistanceCheck = document.getElementById('editShapeFlightPathShowDistance');
        if (shape.type === 'flightpath') {
            flightPathArrowSizeGroup.classList.remove('hidden');
            document.getElementById('editShapeFlightPathArrowSize').value = shape.arrowSize != null ? shape.arrowSize : FLIGHT_PATH_ARROW_SIZE_DEFAULT;
            flightPathDistanceGroup.classList.remove('hidden');
            flightPathShowDistanceCheck.checked = shape.showDistance !== undefined ? shape.showDistance : showFlightPathDistance;
        } else {
            flightPathArrowSizeGroup.classList.add('hidden');
            flightPathDistanceGroup.classList.add('hidden');
        }

        document.getElementById('shapeEditModal').classList.remove('hidden');
    }

    function saveShapeEdit() {
        const id = parseInt(document.getElementById('editShapeId').value);
        const shape = shapes.find(s => s.id === id);
        if (!shape) return;
        pushUndoSnapshot();

        shape.label = document.getElementById('editShapeLabel').value.trim();
        shape.style.color = document.getElementById('editShapeColor').value;
        shape.style.fillColor = shape.style.color;
        shape.style.fillOpacity = parseFloat(document.getElementById('editShapeFillOpacity').value);
        shape.style.weight = parseInt(document.getElementById('editShapeWeight').value);

        if (shape.type === 'text') {
            shape.text = document.getElementById('editShapeText').value.trim() || ' ';
            const preset = document.getElementById('editShapeTextPreset').value;
            shape.textStyle = {
                preset,
                fontSize: Math.max(10, Math.min(24, parseInt(document.getElementById('editShapeTextSize').value) || 12))
            };
            if (preset === 'custom' || preset === 'highlight') {
                shape.textStyle.textColor = document.getElementById('editShapeTextColor').value;
            }
            if (preset === 'custom') {
                shape.textStyle.bgColor = document.getElementById('editShapeTextBg').value;
            }
        } else if (shape.type === 'circle') {
            const newRadius = parseFloat(document.getElementById('editShapeRadius').value);
            if (newRadius > 0) {
                shape.radius = newRadius;
            }
            const newAngle = parseFloat(document.getElementById('editShapeAngle').value);
            if (!isNaN(newAngle)) {
                shape.measureAngle = ((newAngle % 360) + 360) % 360;
            }
        } else if (shape.type === 'arrow') {
            const newLength = parseFloat(document.getElementById('editShapeRadius').value);
            const newBearing = parseFloat(document.getElementById('editShapeAngle').value);
            if (newLength > 0 && !isNaN(newBearing)) {
                const bearing = ((newBearing % 360) + 360) % 360;
                shape.tip = destinationPoint(shape.tail[0], shape.tail[1], bearing, newLength);
            } else if (newLength > 0) {
                const currentBearing = bearingTo(shape.tail[0], shape.tail[1], shape.tip[0], shape.tip[1]);
                shape.tip = destinationPoint(shape.tail[0], shape.tail[1], currentBearing, newLength);
            }
        } else if (shape.type === 'flightpath') {
            const arrowSizeVal = parseFloat(document.getElementById('editShapeFlightPathArrowSize').value);
            if (!isNaN(arrowSizeVal) && arrowSizeVal >= 1 && arrowSizeVal <= 100) {
                shape.arrowSize = arrowSizeVal;
            }
            shape.showDistance = document.getElementById('editShapeFlightPathShowDistance').checked;
        }

        const entry = shapeLayerMap[id];
        if (entry && entry.layer) {
            if (shape.type === 'text' && shape.text) {
                applyTextAnnotationStyle(entry.layer, shape);
            } else if (entry.layer.setStyle) {
                entry.layer.setStyle({
                    color: shape.style.color,
                    fillColor: shape.style.fillColor,
                    fillOpacity: shape.style.fillOpacity,
                    weight: shape.style.weight,
                    dashArray: shape.style.dashArray || ''
                });
            }
            if (shape.type === 'circle' && entry.layer.setRadius) {
                entry.layer.setRadius(shape.radius);
            }
            if (shape.type === 'arrow') {
                rebuildArrowPolygon(shape);
            }
            if (shape.type === 'flightpath') {
                entry.layer.setStyle({
                    color: shape.style.color,
                    weight: shape.style.weight,
                    dashArray: shape.style.dashArray || ''
                });
                rebuildFlightPathArrows(shape);
            }
        }

        updateMeasurement(shape);
        updateShapeLabelMarker(shape);
        refreshShapesList();

        if (selectedShapeId === id) {
            populatePanelFromShape(shape);
        }

        document.getElementById('shapeEditModal').classList.add('hidden');
    }

    function deleteShapeFromModal() {
        const id = parseInt(document.getElementById('editShapeId').value);
        removeShape(id);
        document.getElementById('shapeEditModal').classList.add('hidden');
    }

    // ---- Shape CRUD ----

    function removeShape(id) {
        pushUndoSnapshot();
        if (selectedShapeId === id) {
            selectedShapeId = null;
            restorePanelDefaults();
        }

        const entry = shapeLayerMap[id];
        if (entry) {
            removeMeasurement(id);
            removeShapeLabelMarker(id);
            removeArrowHandles(id);
            if (entry.layer) map.removeLayer(entry.layer);
            if (entry.arrowGroup) map.removeLayer(entry.arrowGroup);
            delete shapeLayerMap[id];
        }
        shapes = shapes.filter(s => s.id !== id);
        refreshShapesList();
    }

    function clearAllShapes() {
        if (selectedShapeId) {
            selectedShapeId = null;
            restorePanelDefaults();
        }

        for (const id of Object.keys(shapeLayerMap)) {
            const numId = parseInt(id);
            const entry = shapeLayerMap[id];
            const shape = shapes.find(s => s.id === numId);
            if (shape && shape.type === 'circle') {
                removeRadialMeasurement(numId);
            }
            if (shape && (shape.type === 'polyline' || shape.type === 'flightpath')) {
                removeLineMeasurement(numId);
            }
            removeArrowHandles(numId);
            removeShapeLabelMarker(numId);
            if (entry && entry.layer) map.removeLayer(entry.layer);
            if (entry && entry.arrowGroup) map.removeLayer(entry.arrowGroup);
        }
        shapes = [];
        shapeLayerMap = {};
        nextShapeId = 1;
        refreshShapesList();
    }

    // ---- Shapes List UI ----

    function refreshShapesList() {
        const list = document.getElementById('shapesList');
        const count = document.getElementById('shapeCount');
        if (!list || !count) return;

        count.textContent = `(${shapes.length})`;
        list.innerHTML = '';

        for (const s of shapes) {
            const li = document.createElement('li');
            li.className = 'point-item';
            if (s.id === selectedShapeId) {
                li.classList.add('active');
            }
            li.dataset.id = s.id;

            const typeLabel = getShapeTypeLabel(s.type);
            const measurement = showMeasurements ? (getMeasurementText(s) || '') : '';
            const colorDot = `<div class="point-marker-icon" style="background:${s.style.color || currentStyle.color}"></div>`;
            const listName = s.type === 'text'
                ? (s.label || (s.text ? String(s.text).slice(0, 30) + (String(s.text).length > 30 ? '…' : '') : '') || typeLabel)
                : (s.label || typeLabel);

            const isLineShape = s.type === 'polyline' || s.type === 'flightpath';
            const verticesBtn = isLineShape
                ? `<button class="btn-icon btn-edit-vertices" title="Edit vertices">&#9997;</button>`
                : '';

            li.innerHTML = `
                ${colorDot}
                <div class="point-item-info">
                    <div class="point-item-name">${escapeHtml(listName)}</div>
                    <div class="point-item-detail">${typeLabel}${measurement ? ' | ' + measurement : ''}</div>
                </div>
                <div class="point-item-actions">
                    <button class="btn-icon btn-edit" title="Edit properties">&#9998;</button>
                    ${verticesBtn}
                    <button class="btn-icon btn-delete" title="Delete">&times;</button>
                </div>
            `;

            li.addEventListener('click', (e) => {
                if (e.target.closest('.btn-edit')) {
                    openShapeEditModal(s.id);
                } else if (e.target.closest('.btn-edit-vertices')) {
                    editVertices(s.id);
                } else if (e.target.closest('.btn-delete')) {
                    removeShape(s.id);
                } else {
                    selectShape(s.id);
                    panToShape(s.id);
                }
            });

            list.appendChild(li);
        }
    }

    function panToShape(id) {
        const entry = shapeLayerMap[id];
        if (!entry || !entry.layer) return;

        if (entry.layer.getBounds) {
            map.fitBounds(entry.layer.getBounds(), { padding: [60, 60] });
        } else if (entry.layer.getLatLng) {
            map.setView(entry.layer.getLatLng(), Math.max(map.getZoom(), 14));
        }
    }

    // ---- Serialization ----

    function serializeShapes() {
        return shapes.map(s => ({
            ...s,
            style: { ...s.style }
        }));
    }

    function loadShapes(data, options) {
        clearAllShapes();
        if (!data || !Array.isArray(data)) return;
        const preserveIds = options && options.preserveIds;

        for (const shapeData of data) {
            const shape = {
                id: preserveIds && shapeData.id != null ? shapeData.id : nextShapeId++,
                type: shapeData.type,
                label: shapeData.label || '',
                style: shapeData.style || (shapeData.type === 'flightpath' ? { ...flightPathStyle } : { ...currentStyle }),
                center: shapeData.center,
                radius: shapeData.radius,
                measureAngle: shapeData.measureAngle != null ? shapeData.measureAngle : 45,
                measureLabelRatio: shapeData.measureLabelRatio != null ? shapeData.measureLabelRatio : 0.5,
                tail: shapeData.tail,
                tip: shapeData.tip,
                latlngs: shapeData.latlngs,
                curvePoints: shapeData.curvePoints,
                position: shapeData.position,
                text: shapeData.text,
                textStyle: shapeData.textStyle ? { ...shapeData.textStyle } : undefined,
                showDistance: shapeData.showDistance,
                arrowSize: shapeData.arrowSize != null ? shapeData.arrowSize : FLIGHT_PATH_ARROW_SIZE_DEFAULT
            };

            // Migrate old arrow_stamp data to new arrow format
            if (shape.type === 'arrow_stamp') {
                shape.type = 'arrow';
                if (shapeData.center && shapeData.arrowLength && shapeData.arrowAngle != null) {
                    const halfLen = Math.max(20, shapeData.arrowLength / 2);
                    shape.tip = destinationPoint(shapeData.center[0], shapeData.center[1], shapeData.arrowAngle, halfLen);
                    shape.tail = destinationPoint(shapeData.center[0], shapeData.center[1], (shapeData.arrowAngle + 180) % 360, halfLen);
                }
            }

            // Migrate old polyline-based arrow data
            if (shape.type === 'arrow' && !shape.tail && shape.latlngs && shape.latlngs.length >= 2) {
                shape.tail = shape.latlngs[0];
                shape.tip = shape.latlngs[shape.latlngs.length - 1];
                delete shape.latlngs;
            }

            shapes.push(shape);
            addShapeToMap(shape);
        }
        if (preserveIds && data.length > 0) {
            nextShapeId = Math.max(...data.map(s => s.id != null ? s.id : 0), 0) + 1;
        }
        refreshShapesList();
    }

    // ---- Utility ----

    function applyTextAnnotationStyle(layer, shape) {
        if (!shape.text || !layer.setIcon) return;
        const ts = shape.textStyle || { preset: 'label', fontSize: 12 };
        const preset = ts.preset || 'label';
        const fontSize = Math.max(10, Math.min(24, ts.fontSize || 12));
        const pathColor = (shape.style || currentStyle).color || currentStyle.color;
        let bg = 'transparent';
        let color = pathColor;
        let extraClass = '';
        if (preset === 'label') {
            bg = 'rgba(30, 30, 46, 0.92)';
            color = '#fff';
            extraClass = ' text-annotation-label';
        } else if (preset === 'highlight') {
            color = ts.textColor || pathColor;
            extraClass = ' text-annotation-highlight';
        } else if (preset === 'custom') {
            bg = ts.bgColor || 'rgba(30, 30, 46, 0.92)';
            color = ts.textColor || '#fff';
            extraClass = ' text-annotation-custom';
        }
        const icon = L.divIcon({
            className: 'map-text-annotation' + extraClass,
            html: `<div class="text-annotation-content" data-shape-id="${shape.id}" style="background:${bg};color:${color};font-size:${fontSize}px">${escapeHtml(shape.text)}</div>`,
            iconSize: null
        });
        layer.setIcon(icon);
        if (layer._icon) layer._icon.dataset.shapeId = shape.id;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function getShapeTypeLabel(type) {
        if (!type) return 'Shape';
        if (type === 'flightpath') return 'Flight Path';
        return type.charAt(0).toUpperCase() + type.slice(1);
    }

    function getShapeInfo(id) {
        const shape = shapes.find(s => s.id === id);
        if (!shape) return null;
        const entry = shapeLayerMap[id];
        const layer = entry ? entry.layer : null;
        return {
            id: shape.id,
            type: shape.type,
            label: shape.label,
            hasPm: !!(layer && layer.pm)
        };
    }

    function isDrawingActive() {
        return !!(map && map.pm && map.pm.globalDrawModeEnabled()) || !!arrowDrawState || !!lineDrawState || !!flightPathDrawState;
    }

    function enableDrawMode(mode) {
        exitAllDrawingModes();
        if (mode === 'Arrow') {
            startArrowDraw();
            return;
        }
        if (mode === 'Line') {
            startLineDraw();
            return;
        }
        if (mode === 'FlightPath') {
            startFlightPathDraw();
            return;
        }
        if (map && map.pm) {
            const geomanMode = mode === 'Line' ? 'Line' : mode;
            map.pm.enableDraw(geomanMode);
        }
    }

    function enableArrowDrawAt(tailLatLng) {
        exitAllDrawingModes();
        startArrowDraw(tailLatLng);
    }

    function enableLineDrawAt(startLatLng) {
        exitAllDrawingModes();
        startLineDraw(startLatLng);
    }

    function exitAllDrawingModes() {
        if (arrowDrawState) cancelArrowDraw();
        if (lineDrawState) cancelLineDraw();
        if (flightPathDrawState) cancelFlightPathDraw();
        if (map && map.pm && map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
    }

    function getShapes() {
        return shapes;
    }

    function getShowMeasurements() {
        return showMeasurements;
    }

    // ---- Public API ----

    return {
        init,
        serializeShapes,
        loadShapes,
        clearAllShapes,
        toggleMeasurements,
        toggleShapeLabels,
        toggleFlightPathDistance,
        isDrawingActive,
        exitAllDrawingModes,
        getShapes,
        getShowMeasurements,
        getShapeInfo,
        saveShapeEdit,
        deleteShapeFromModal,
        openShapeEditModal,
        editVertices,
        moveShape,
        removeShape,
        refreshShapesList,
        copyShape,
        pasteShape,
        hasClipboard,
        enableDrawMode,
        enableArrowDrawAt,
        enableLineDrawAt
    };

})();
