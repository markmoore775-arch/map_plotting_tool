/* ============================================
   DRAWING & ANNOTATION MODULE
   ============================================ */

const Drawings = (() => {
    'use strict';

    let map;
    let shapes = [];
    let nextShapeId = 1;
    let showMeasurements = true;
    let showShapeLabels = true;
    let showFlightPathDistance = false;
    let shapeLayerMap = {};
    let arrowDrawState = null; // { tail: [lat,lng] } while placing tip
    let flightPathDrawState = null; // true when drawing a flight path
    let lastCircleRadiusPoint = null; // last mouse pos during circle draw (for label angle)

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
        if (shape.showDistance != null) data.showDistance = shape.showDistance;
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
            showDistance: data.showDistance
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
    const FLIGHT_PATH_ARROW_SIZE = 4; // metres
    const FLIGHT_PATH_ARROW_INTERVAL = 50; // metres between arrows

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
        setupFlightPathDrawControl();
        setupStylePanel();
        setupShapeEvents();
        setupCircleDrawFeedback();
        setupKeyboardShortcuts();
        setupMapDismiss();
        setupCursorState();
    }

    function setupCursorState() {
        map.on('pm:drawstart', refreshInteractionCursor);
        map.on('pm:drawend', refreshInteractionCursor);
        map.on('pm:globaleditmodetoggled', refreshInteractionCursor);
        map.on('pm:globaldragmodetoggled', refreshInteractionCursor);
        map.on('pm:globalremovalmodetoggled', refreshInteractionCursor);
        refreshInteractionCursor();
    }

    function refreshInteractionCursor() {
        const mapEl = document.getElementById('map');
        if (!mapEl || !map || !map.pm) return;

        const isArrowDraw = !!arrowDrawState;
        const isFlightPathDraw = !!flightPathDrawState;
        const isGeoDraw = !!(map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled());
        const isMoveMode = !!(
            (map.pm.globalDragModeEnabled && map.pm.globalDragModeEnabled()) ||
            (map.pm.globalEditModeEnabled && map.pm.globalEditModeEnabled()) ||
            (map.pm.globalRemovalModeEnabled && map.pm.globalRemovalModeEnabled())
        );

        mapEl.classList.toggle('draw-tool-cursor', isArrowDraw || isFlightPathDraw || isGeoDraw);
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

        map.pm.setPathOptions(pathOpts);
        map.pm.setGlobalOptions({
            pathOptions: pathOpts,
            templineStyle: { color: currentStyle.color, dashArray: '5,5' },
            hintlineStyle: { color: currentStyle.color, dashArray: '5,5' }
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
                const btn = L.DomUtil.create('a', 'leaflet-control-extra-draw', container);
                btn.href = '#';
                btn.title = 'Draw Arrow';
                btn.innerHTML = '&#10148;';

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
                btn.innerHTML = '<span class="control-icon leaflet-pm-icon-polyline"></span>';

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

    function startFlightPathDraw() {
        cancelArrowDraw();
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        flightPathDrawState = true;
        map.doubleClickZoom.disable();
        if (flightPathDrawBtn) flightPathDrawBtn.classList.add('active-draw');
        map.pm.enableDraw('Line', {
            pathOptions: { ...flightPathStyle },
            templineStyle: { color: flightPathStyle.color, dashArray: '5,5' },
            hintlineStyle: { color: flightPathStyle.color, dashArray: '5,5' }
        });
        refreshInteractionCursor();
    }

    function cancelFlightPathDraw() {
        flightPathDrawState = null;
        map.doubleClickZoom.enable();
        if (flightPathDrawBtn) flightPathDrawBtn.classList.remove('active-draw');
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        refreshInteractionCursor();
    }

    function startArrowDraw(optionalTailLatLng) {
        cancelArrowDraw();
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

        if (shape.type !== 'text' && entry.layer.pm) {
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
                refreshInteractionCursor();

                const shape = {
                    id: nextShapeId++,
                    type: 'flightpath',
                    label: '',
                    style: { ...flightPathStyle },
                    latlngs
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

            updateShapeFromLayer(shape, layer);
            updateMeasurement(shape);
            updateShapeLabelMarker(shape);
            refreshShapesList();
        });

        map.on('pm:remove', (e) => {
            const layer = e.layer;
            const id = layer._shapeId;
            if (!id) return;

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
            if (!e.enabled) {
                for (const shape of shapes) {
                    const entry = shapeLayerMap[shape.id];
                    if (entry && entry.layer) {
                        updateShapeFromLayer(shape, entry.layer);
                        updateMeasurement(shape);
                        updateShapeLabelMarker(shape);
                    }
                }
                refreshShapesList();
            }
        });

        map.on('pm:globaldragmodetoggled', (e) => {
            if (!e.enabled) {
                for (const shape of shapes) {
                    const entry = shapeLayerMap[shape.id];
                    if (entry && entry.layer) {
                        updateShapeFromLayer(shape, entry.layer);
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
        const points = getPointsAlongPath(shape.latlngs, FLIGHT_PATH_ARROW_INTERVAL);
        for (const p of points) {
            const verts = computeArrowheadVertices(p.latlng, p.bearing, FLIGHT_PATH_ARROW_SIZE);
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
            const verts = computeArrowheadVertices(last, bearing, FLIGHT_PATH_ARROW_SIZE);
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
                text: shape.text || ''
            }).addTo(map);
            if (shape.text) {
                const icon = L.divIcon({
                    className: 'map-text-annotation',
                    html: `<div class="text-annotation-content" style="color:${pathOpts.color}">${escapeHtml(shape.text)}</div>`,
                    iconSize: null
                });
                layer.setIcon(icon);
            }
        } else if (shape.type === 'arrow') {
            const vertices = computeArrowVertices(shape.tail, shape.tip);
            layer = L.polygon(vertices, pathOpts).addTo(map);
        } else if (shape.type === 'rectangle') {
            layer = L.rectangle(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'polyline') {
            layer = L.polyline(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'flightpath') {
            const fpStyle = shape.style || flightPathStyle;
            const fpPathOpts = {
                color: fpStyle.color || flightPathStyle.color,
                fillColor: fpStyle.fillColor || fpStyle.color || flightPathStyle.fillColor,
                fillOpacity: 0,
                weight: fpStyle.weight || flightPathStyle.weight,
                dashArray: fpStyle.dashArray || flightPathStyle.dashArray
            };
            layer = L.polyline(shape.latlngs, fpPathOpts).addTo(map);
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
            html: `<div class="radial-measurement-label">${text}</div>`,
            iconSize: null,
            iconAnchor: [0, 14]
        });
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
            const newEdge = destinationPoint(center[0], center[1], newAngle, radius);
            const ratio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
            const newLabelPt = pointAlongRadius(center, newEdge, ratio);

            e.target.setLatLng(newEdge);
            line.setLatLngs([center, newEdge]);
            label.setLatLng(newLabelPt);
            shape.measureAngle = newAngle;
        });

        handle.on('dragend', () => {
            const pos = handle.getLatLng();
            const finalAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            shape.measureAngle = finalAngle;
            const finalEdge = destinationPoint(center[0], center[1], finalAngle, radius);
            const ratio = shape.measureLabelRatio != null ? shape.measureLabelRatio : 0.5;
            handle.setLatLng(finalEdge);
            line.setLatLngs([center, finalEdge]);
            label.setLatLng(pointAlongRadius(center, finalEdge, ratio));
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
            if (angleHint) angleHint.textContent = 'Or drag the handle on the map to reposition';
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

        const flightPathDistanceGroup = document.getElementById('editShapeFlightPathDistanceGroup');
        const flightPathShowDistanceCheck = document.getElementById('editShapeFlightPathShowDistance');
        if (shape.type === 'flightpath') {
            flightPathDistanceGroup.classList.remove('hidden');
            flightPathShowDistanceCheck.checked = shape.showDistance !== undefined ? shape.showDistance : showFlightPathDistance;
        } else {
            flightPathDistanceGroup.classList.add('hidden');
        }

        document.getElementById('shapeEditModal').classList.remove('hidden');
    }

    function saveShapeEdit() {
        const id = parseInt(document.getElementById('editShapeId').value);
        const shape = shapes.find(s => s.id === id);
        if (!shape) return;

        shape.label = document.getElementById('editShapeLabel').value.trim();
        shape.style.color = document.getElementById('editShapeColor').value;
        shape.style.fillColor = shape.style.color;
        shape.style.fillOpacity = parseFloat(document.getElementById('editShapeFillOpacity').value);
        shape.style.weight = parseInt(document.getElementById('editShapeWeight').value);

        if (shape.type === 'circle') {
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
            shape.showDistance = document.getElementById('editShapeFlightPathShowDistance').checked;
        }

        const entry = shapeLayerMap[id];
        if (entry && entry.layer) {
            if (entry.layer.setStyle) {
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

            li.innerHTML = `
                ${colorDot}
                <div class="point-item-info">
                    <div class="point-item-name">${escapeHtml(s.label || typeLabel)}</div>
                    <div class="point-item-detail">${typeLabel}${measurement ? ' | ' + measurement : ''}</div>
                </div>
                <div class="point-item-actions">
                    <button class="btn-icon btn-edit" title="Properties">&#9998;</button>
                    <button class="btn-icon btn-delete" title="Delete">&times;</button>
                </div>
            `;

            li.addEventListener('click', (e) => {
                if (e.target.closest('.btn-edit')) {
                    openShapeEditModal(s.id);
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

    function loadShapes(data) {
        clearAllShapes();
        if (!data || !Array.isArray(data)) return;

        for (const shapeData of data) {
            const shape = {
                id: nextShapeId++,
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
                showDistance: shapeData.showDistance
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
        refreshShapesList();
    }

    // ---- Utility ----

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
        return !!(map && map.pm && map.pm.globalDrawModeEnabled()) || !!arrowDrawState || !!flightPathDrawState;
    }

    function enableDrawMode(mode) {
        exitAllDrawingModes();
        if (mode === 'Arrow') {
            startArrowDraw();
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

    function exitAllDrawingModes() {
        if (arrowDrawState) cancelArrowDraw();
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
        enableArrowDrawAt
    };

})();
