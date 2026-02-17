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
    let shapeLayerMap = {};
    // Each entry: { layer, measureTooltip?, radialGroup?, labelMarker? }
    let customDrawMode = null;       // 'arrow' | 'curve' | 'arrow_stamp' | null
    let customDrawPoints = [];
    let customTempLayer = null;

    // Selection & interaction state
    let selectedShapeId = null;
    let contextMenuEl = null;
    let contextTargetId = null;

    // Default style for new shapes
    let currentStyle = {
        color: '#e05555',
        fillColor: '#e05555',
        fillOpacity: 0.15,
        weight: 2,
        dashArray: ''
    };

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

    // ---- Initialisation ----

    function init(mapInstance) {
        map = mapInstance;
        contextMenuEl = document.getElementById('shapeContextMenu');
        setupGeoman();
        setupExtraDrawControls();
        setupStylePanel();
        setupShapeEvents();
        setupCircleDrawFeedback();
        setupContextMenu();
        setupKeyboardShortcuts();
        setupMapDismiss();
        setupCursorState();
        map.on('zoomend', refreshAllArrowStampLayers);
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

        const isCustomDraw = !!customDrawMode;
        const isGeoDraw = !!(map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled());
        const isMoveMode = !!(
            (map.pm.globalDragModeEnabled && map.pm.globalDragModeEnabled()) ||
            (map.pm.globalEditModeEnabled && map.pm.globalEditModeEnabled()) ||
            (map.pm.globalRemovalModeEnabled && map.pm.globalRemovalModeEnabled())
        );

        mapEl.classList.toggle('draw-tool-cursor', isCustomDraw || isGeoDraw);
        mapEl.classList.toggle('move-tool-cursor', !isCustomDraw && !isGeoDraw && isMoveMode);
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
            drawPolyline: true,
            cutPolygon: false,
            rotateMode: false,
            editMode: true,
            dragMode: true,
            removalMode: true
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

    function setupExtraDrawControls() {
        const ExtraControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');

                const arrowBtn = L.DomUtil.create('a', 'leaflet-control-extra-draw', container);
                arrowBtn.href = '#';
                arrowBtn.title = 'Draw Arrow';
                arrowBtn.innerHTML = '&#8599;';

                const curveBtn = L.DomUtil.create('a', 'leaflet-control-extra-draw', container);
                curveBtn.href = '#';
                curveBtn.title = 'Draw Curve';
                curveBtn.innerHTML = '&#8764;';

                const stampBtn = L.DomUtil.create('a', 'leaflet-control-extra-draw', container);
                stampBtn.href = '#';
                stampBtn.title = 'Place Arrow Stamp';
                stampBtn.innerHTML = '&#10148;';

                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(arrowBtn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    if (customDrawMode === 'arrow') {
                        stopCustomDraw(true);
                    } else {
                        startCustomDraw('arrow');
                    }
                });
                L.DomEvent.on(curveBtn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    if (customDrawMode === 'curve') {
                        stopCustomDraw(true);
                    } else {
                        startCustomDraw('curve');
                    }
                });
                L.DomEvent.on(stampBtn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    if (customDrawMode === 'arrow_stamp') {
                        stopCustomDraw(true);
                    } else {
                        startCustomDraw('arrow_stamp');
                    }
                });

                container._arrowBtn = arrowBtn;
                container._curveBtn = curveBtn;
                container._stampBtn = stampBtn;
                return container;
            }
        });

        const control = new ExtraControl();
        map.addControl(control);

        map.on('click', (e) => {
            if (!customDrawMode) return;
            const clickPt = [e.latlng.lat, e.latlng.lng];

            if (customDrawMode === 'arrow_stamp') {
                createArrowStamp(clickPt);
                stopCustomDraw(true);
                return;
            }

            customDrawPoints.push(clickPt);

            if (customDrawMode === 'arrow' && customDrawPoints.length === 2) {
                finishCustomDraw();
                return;
            }
            if (customDrawMode === 'curve' && customDrawPoints.length === 3) {
                finishCustomDraw();
                return;
            }

            redrawCustomTempLayer();
        });

        map.on('mousemove', (e) => {
            if (!customDrawMode || customDrawPoints.length === 0) return;
            redrawCustomTempLayer([e.latlng.lat, e.latlng.lng]);
        });

        map.on('dblclick', () => {
            if (!customDrawMode) return;
            if (customDrawMode === 'arrow_stamp') return;
            finishCustomDraw();
        });
    }

    function startCustomDraw(mode) {
        stopCustomDraw(true);
        customDrawMode = mode;
        customDrawPoints = [];
        map.doubleClickZoom.disable();
        refreshInteractionCursor();
    }

    function stopCustomDraw(clearTemp) {
        if (clearTemp && customTempLayer && map.hasLayer(customTempLayer)) {
            map.removeLayer(customTempLayer);
        }
        customTempLayer = null;
        customDrawMode = null;
        customDrawPoints = [];
        map.doubleClickZoom.enable();
        refreshInteractionCursor();
    }

    function redrawCustomTempLayer(hoverPoint) {
        if (customTempLayer && map.hasLayer(customTempLayer)) {
            map.removeLayer(customTempLayer);
            customTempLayer = null;
        }
        const pts = hoverPoint ? [...customDrawPoints, hoverPoint] : [...customDrawPoints];
        if (pts.length < 2) return;

        if (customDrawMode === 'arrow') {
            customTempLayer = L.polyline(pts.slice(0, 2), {
                color: currentStyle.color,
                weight: currentStyle.weight,
                dashArray: currentStyle.dashArray || '',
                opacity: 0.85
            }).addTo(map);
        } else if (customDrawMode === 'curve' && pts.length >= 3 && L.curve) {
            const path = ['M', pts[0], 'Q', pts[1], pts[2]];
            customTempLayer = L.curve(path, {
                color: currentStyle.color,
                weight: currentStyle.weight,
                dashArray: currentStyle.dashArray || '',
                opacity: 0.85
            }).addTo(map);
        }
    }

    function finishCustomDraw() {
        if (!customDrawMode) return;
        if (customDrawMode === 'arrow' && customDrawPoints.length >= 2) {
            const shape = {
                id: nextShapeId++,
                type: 'arrow',
                label: '',
                style: { ...currentStyle },
                latlngs: customDrawPoints.slice(0, 2)
            };
            shapes.push(shape);
            addShapeToMap(shape);
            refreshShapesList();
        }
        if (customDrawMode === 'curve' && customDrawPoints.length >= 3) {
            const shape = {
                id: nextShapeId++,
                type: 'curve',
                label: '',
                style: { ...currentStyle },
                curvePoints: customDrawPoints.slice(0, 3)
            };
            shapes.push(shape);
            addShapeToMap(shape);
            refreshShapesList();
        }
        stopCustomDraw(true);
    }

    function createArrowStamp(center) {
        const shape = {
            id: nextShapeId++,
            type: 'arrow_stamp',
            label: '',
            style: { ...currentStyle },
            center: [center[0], center[1]],
            arrowLength: 200,
            arrowAngle: 45
        };
        shapes.push(shape);
        addShapeToMap(shape);
        refreshShapesList();
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

        // Set initial values
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

        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
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

        // Live-update the layer
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
        if (shape.type === 'arrow') {
            refreshArrowDecorator(shape);
        }
        if (shape.type === 'arrow_stamp') {
            refreshArrowStampLayer(shape);
        }

        refreshShapesList();
    }

    function refreshArrowDecorator(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || shape.type !== 'arrow' || !entry.layer) return;

        const latlngs = entry.layer.getLatLngs ? entry.layer.getLatLngs() : (shape.latlngs || []);
        if (!latlngs || latlngs.length < 2) return;
        const start = latlngs[latlngs.length - 2];
        const end = latlngs[latlngs.length - 1];
        const endLat = end.lat != null ? end.lat : end[0];
        const endLng = end.lng != null ? end.lng : end[1];
        const startLat = start.lat != null ? start.lat : start[0];
        const startLng = start.lng != null ? start.lng : start[1];
        const bearing = bearingTo(startLat, startLng, endLat, endLng);

        if (entry.arrowDecorator && map.hasLayer(entry.arrowDecorator)) {
            map.removeLayer(entry.arrowDecorator);
        }
        if (entry.arrowHeadMarker && map.hasLayer(entry.arrowHeadMarker)) {
            map.removeLayer(entry.arrowHeadMarker);
        }

        const arrowColor = shape.style.color || currentStyle.color;
        const arrowSize = Math.max(14, (shape.style.weight || 2) * 6);
        if (L.polylineDecorator) {
            entry.arrowDecorator = L.polylineDecorator(entry.layer, {
                patterns: [{
                    offset: '100%',
                    repeat: 0,
                    symbol: L.Symbol.arrowHead({
                        pixelSize: arrowSize,
                        polygon: true,
                        pathOptions: {
                            color: arrowColor,
                            fillColor: arrowColor,
                            fillOpacity: 1,
                            weight: 1.5
                        }
                    })
                }]
            }).addTo(map);
        }

        // Fallback/assist marker to guarantee visible arrowhead.
        const arrowHeadIcon = L.divIcon({
            className: 'map-arrowhead-wrap',
            html: `<div class="map-arrowhead" style="border-left-color:${arrowColor}; transform: translate(-50%, -50%) rotate(${bearing - 90}deg);"></div>`,
            iconSize: [arrowSize, arrowSize],
            iconAnchor: [arrowSize / 2, arrowSize / 2]
        });
        entry.arrowHeadMarker = L.marker([endLat, endLng], {
            icon: arrowHeadIcon,
            interactive: false,
            keyboard: false,
            zIndexOffset: 900
        }).addTo(map);
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

        // Ensure panel is visible and expanded
        const panel = document.getElementById('drawStylePanel');
        panel.classList.remove('collapsed');
        panel.classList.add('editing-shape');
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
        // Deselect previous
        if (selectedShapeId && selectedShapeId !== id) {
            deselectShape();
        }

        const shape = shapes.find(s => s.id === id);
        const entry = shapeLayerMap[id];
        if (!shape || !entry || !entry.layer) return;

        selectedShapeId = id;
        populatePanelFromShape(shape);

        // Highlight in sidebar
        refreshShapesList();
    }

    function deselectShape() {
        if (!selectedShapeId) return;

        const entry = shapeLayerMap[selectedShapeId];
        if (entry && entry.layer && entry.layer.pm) {
            entry.layer.pm.disable();
            if (entry.layer.pm.disableLayerDrag) {
                entry.layer.pm.disableLayerDrag();
            }
        }

        // Update shape data from layer in case it was edited
        const shape = shapes.find(s => s.id === selectedShapeId);
        if (shape && entry && entry.layer) {
            updateShapeFromLayer(shape, entry.layer);
            updateMeasurement(shape);
            bindShapePopup(shape);
        }

        selectedShapeId = null;
        restorePanelDefaults();
        refreshShapesList();
    }

    function editVertices(id) {
        selectShape(id);
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
        } else if (entry && entry.layer && entry.layer.dragging) {
            entry.layer.dragging.enable();
        }
    }

    // ============================================================
    //  CONTEXT MENU - right-click on shapes
    // ============================================================

    function setupContextMenu() {
        if (!contextMenuEl) return;

        // Handle menu item clicks
        contextMenuEl.addEventListener('click', (e) => {
            const item = e.target.closest('[data-action]');
            if (!item || contextTargetId == null) return;
            const action = item.dataset.action;
            const id = contextTargetId;

            hideContextMenu();

            switch (action) {
                case 'edit-vertices':
                    editVertices(id);
                    break;
                case 'move':
                    moveShape(id);
                    break;
                case 'properties':
                    openShapeEditModal(id);
                    break;
                case 'delete':
                    removeShape(id);
                    break;
            }
        });

        // Prevent menu's own context menu
        contextMenuEl.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function showContextMenu(shapeId, originalEvent) {
        if (!contextMenuEl) return;
        originalEvent.preventDefault();
        originalEvent.stopPropagation();

        contextTargetId = shapeId;
        const shape = shapes.find(s => s.id === shapeId);

        // Show/hide "Edit Vertices" for text shapes
        const editVertBtn = contextMenuEl.querySelector('[data-action="edit-vertices"]');
        const layer = shape ? (shapeLayerMap[shapeId] && shapeLayerMap[shapeId].layer) : null;
        const canEditGeometry = !!(layer && layer.pm);
        const canMoveShape = !!((layer && layer.pm) || (shape && shape.type === 'arrow_stamp' && layer && layer.dragging));
        if (editVertBtn) {
            editVertBtn.style.display = (shape && shape.type === 'text') || !canEditGeometry ? 'none' : '';
        }
        const moveBtn = contextMenuEl.querySelector('[data-action="move"]');
        if (moveBtn) {
            moveBtn.style.display = (shape && shape.type === 'text') || !canMoveShape ? 'none' : '';
        }

        contextMenuEl.classList.remove('hidden');

        // Position near cursor, clamped to viewport
        const x = originalEvent.clientX;
        const y = originalEvent.clientY;
        const menuW = contextMenuEl.offsetWidth;
        const menuH = contextMenuEl.offsetHeight;
        const winW = window.innerWidth;
        const winH = window.innerHeight;

        contextMenuEl.style.left = (x + menuW > winW ? winW - menuW - 4 : x) + 'px';
        contextMenuEl.style.top = (y + menuH > winH ? winH - menuH - 4 : y) + 'px';
    }

    function hideContextMenu() {
        if (contextMenuEl) {
            contextMenuEl.classList.add('hidden');
        }
        contextTargetId = null;
    }

    function setupMapDismiss() {
        // Click on map (not shape) dismisses context menu and deselects
        map.on('click', () => {
            hideContextMenu();
        });

        // Also dismiss on any click outside the context menu
        document.addEventListener('mousedown', (e) => {
            if (contextMenuEl && !contextMenuEl.classList.contains('hidden') &&
                !contextMenuEl.contains(e.target)) {
                hideContextMenu();
            }
        });

        // Deselect when global Geoman modes toggle on
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
            if (e.key === 'Escape') {
                // Close context menu first
                if (contextMenuEl && !contextMenuEl.classList.contains('hidden')) {
                    hideContextMenu();
                    return;
                }

                // Close shape edit modal if open
                const modal = document.getElementById('shapeEditModal');
                if (modal && !modal.classList.contains('hidden')) {
                    modal.classList.add('hidden');
                    return;
                }

                // Deselect shape
                if (selectedShapeId) {
                    deselectShape();
                    return;
                }

                // Cancel custom arrow/curve drawing.
                if (customDrawMode) {
                    stopCustomDraw(true);
                    return;
                }

                // Cancel any active Geoman drawing
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

        // Right-click context menu
        layer.on('contextmenu', (e) => {
            showContextMenu(shape.id, e.originalEvent);
        });

        // Double-click -> open properties
        layer.on('dblclick', (e) => {
            L.DomEvent.stop(e);
            openShapeEditModal(shape.id);
        });

        if (shape.type === 'arrow_stamp') {
            layer.on('drag', () => {
                updateShapeFromLayer(shape, layer);
                updateMeasurement(shape);
                updateShapeLabelMarker(shape);
            });
            layer.on('dragend', () => {
                updateShapeFromLayer(shape, layer);
                updateMeasurement(shape);
                updateShapeLabelMarker(shape);
                bindShapePopup(shape);
                refreshShapesList();
            });
            return;
        }

        // Keep measurements and labels attached while dragging/moving.
        layer.on('pm:drag', () => {
            updateShapeFromLayer(shape, layer);
            updateMeasurement(shape);
            updateShapeLabelMarker(shape);
        });
        layer.on('pm:dragend', () => {
            updateShapeFromLayer(shape, layer);
            updateMeasurement(shape);
            updateShapeLabelMarker(shape);
            if (shape.type === 'arrow') refreshArrowDecorator(shape);
            bindShapePopup(shape);
            refreshShapesList();
        });
    }

    // ---- Shape Events ----

    function setupShapeEvents() {
        map.on('pm:create', (e) => {
            const layer = e.layer;
            const shapeType = e.shape;

            const shape = layerToShape(layer, shapeType);
            shapes.push(shape);

            layer._shapeId = shape.id;
            shapeLayerMap[shape.id] = { layer };

            if (showMeasurements) {
                addMeasurement(shape);
            }

            bindShapePopup(shape);
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
            bindShapePopup(shape);
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
            if (shapeLayerMap[id] && shapeLayerMap[id].arrowDecorator && map.hasLayer(shapeLayerMap[id].arrowDecorator)) {
                map.removeLayer(shapeLayerMap[id].arrowDecorator);
            }
            if (shapeLayerMap[id] && shapeLayerMap[id].arrowHeadMarker && map.hasLayer(shapeLayerMap[id].arrowHeadMarker)) {
                map.removeLayer(shapeLayerMap[id].arrowHeadMarker);
            }
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
                        if (shape.type === 'arrow') refreshArrowDecorator(shape);
                        bindShapePopup(shape);
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
                        if (shape.type === 'arrow') refreshArrowDecorator(shape);
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
            shape.measureAngle = 45;
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
        } else if (shape.type === 'arrow_stamp') {
            const center = layer.getLatLng();
            shape.center = [center.lat, center.lng];
        } else if (shape.type === 'text') {
            const pos = layer.getLatLng();
            shape.position = [pos.lat, pos.lng];
            if (layer.pm && layer.pm.getText) {
                shape.text = layer.pm.getText();
            }
        } else if (shape.type === 'curve') {
            // Curves are currently created as 3-point bezier and are not vertex-editable.
            // Preserve original control points.
            return;
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
            'Arrow': 'arrow',
            'Curve': 'curve',
            'ArrowStamp': 'arrow_stamp'
        };
        return typeMap[geomanType] || geomanType.toLowerCase();
    }

    function flattenLatLngs(latlngs) {
        if (latlngs.length > 0 && Array.isArray(latlngs[0]) && latlngs[0].length > 0 && typeof latlngs[0][0] !== 'number') {
            return latlngs[0].map(ll => ll.lat !== undefined ? [ll.lat, ll.lng] : ll);
        }
        return latlngs.map(ll => ll.lat !== undefined ? [ll.lat, ll.lng] : ll);
    }

    function getArrowStampIcon(shape) {
        const center = shape.center || [0, 0];
        const angle = shape.arrowAngle != null ? shape.arrowAngle : 45;
        const halfLen = Math.max(20, (shape.arrowLength || 200) / 2);
        const tip = destinationPoint(center[0], center[1], angle, halfLen);
        const tail = destinationPoint(center[0], center[1], (angle + 180) % 360, halfLen);
        const pxLen = map.latLngToLayerPoint(L.latLng(tip)).distanceTo(map.latLngToLayerPoint(L.latLng(tail)));
        const width = Math.max(28, Math.min(180, pxLen));
        const height = Math.max(14, Math.min(54, width * 0.32));
        const color = shape.style?.color || currentStyle.color;
        const opacity = shape.style?.fillOpacity != null ? Math.max(0.45, shape.style.fillOpacity) : 0.85;
        return L.divIcon({
            className: 'map-arrow-stamp-wrap',
            html: `<div class="map-arrow-stamp" style="opacity:${opacity}; transform: translate(-50%, -50%) rotate(${angle - 90}deg);">
                    <svg width="${width}" height="${height}" viewBox="0 0 140 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path d="M0 15 H86 V4 L140 22 L86 40 V29 H0 Z" fill="${color}" />
                    </svg>
                   </div>`,
            iconSize: null,
            iconAnchor: [0, 0]
        });
    }

    function refreshArrowStampLayer(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.layer || shape.type !== 'arrow_stamp') return;
        entry.layer.setIcon(getArrowStampIcon(shape));
        if (shape.center) {
            entry.layer.setLatLng(shape.center);
        }
    }

    function refreshAllArrowStampLayers() {
        for (const shape of shapes) {
            if (shape.type === 'arrow_stamp') {
                refreshArrowStampLayer(shape);
            }
        }
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
        } else if (shape.type === 'rectangle') {
            layer = L.rectangle(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'polyline') {
            layer = L.polyline(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'arrow') {
            layer = L.polyline(shape.latlngs, pathOpts).addTo(map);
        } else if (shape.type === 'arrow_stamp' && shape.center) {
            layer = L.marker(shape.center, {
                icon: getArrowStampIcon(shape),
                draggable: true
            }).addTo(map);
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
            shapeLayerMap[shape.id] = { layer };
            if (shape.type === 'arrow') {
                refreshArrowDecorator(shape);
            }

            if (showMeasurements) {
                addMeasurement(shape);
            }
            addShapeLabelMarker(shape);
            bindShapePopup(shape);
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
                entry.layer.getTooltip().setContent(text);
            } else {
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

    function makeLabelIcon(text) {
        return L.divIcon({
            className: 'radial-label-marker',
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
        const mid = midpoint(center, edgePt);

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
        const label = L.marker(mid, {
            icon: makeLabelIcon(text || ''),
            interactive: false,
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

        handle.on('drag', (e) => {
            const pos = e.target.getLatLng();
            const newAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            const newEdge = destinationPoint(center[0], center[1], newAngle, radius);
            const newMid = midpoint(center, newEdge);

            e.target.setLatLng(newEdge);
            line.setLatLngs([center, newEdge]);
            label.setLatLng(newMid);
            shape.measureAngle = newAngle;
        });

        handle.on('dragend', () => {
            const pos = handle.getLatLng();
            const finalAngle = bearingTo(center[0], center[1], pos.lat, pos.lng);
            shape.measureAngle = finalAngle;
            const finalEdge = destinationPoint(center[0], center[1], finalAngle, radius);
            handle.setLatLng(finalEdge);
            line.setLatLngs([center, finalEdge]);
            label.setLatLng(midpoint(center, finalEdge));
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
        const mid = midpoint(center, edgePt);
        const text = getMeasurementText(shape);

        const rg = entry.radialGroup;
        rg.line.setLatLngs([center, edgePt]);
        rg.centerDot.setLatLng(center);
        rg.label.setLatLng(mid);
        rg.label.setIcon(makeLabelIcon(text || ''));
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
            if (r >= 1000) {
                return `${(r / 1000).toFixed(2)} km`;
            }
            return `${Math.round(r)} m`;
        }

        if (shape.type === 'polyline') {
            const dist = calcPolylineLength(shape.latlngs);
            if (dist >= 1000) {
                return `${(dist / 1000).toFixed(2)} km`;
            }
            return `${Math.round(dist)} m`;
        }

        if (shape.type === 'arrow') {
            // Hidden by default for arrow workflow.
            return null;
        }

        if (shape.type === 'arrow_stamp') {
            // Hidden by default for stamp workflow.
            return null;
        }

        if (shape.type === 'curve') {
            // Hidden by default for curve workflow.
            return null;
        }

        if (shape.type === 'polygon' || shape.type === 'rectangle') {
            // Area display intentionally disabled for planning workflow.
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

        // Circles: use the same angle as radial measurement so label stays near perimeter.
        if (shape.type === 'circle' && shape.center && shape.radius != null) {
            const angle = shape.measureAngle != null ? shape.measureAngle : 45;
            const edge = destinationPoint(shape.center[0], shape.center[1], angle, shape.radius);
            return projectOutwardPixels(edge, shape.center, 14);
        }

        // Polylines: place near the end point, pushed outward from midpoint.
        if (shape.type === 'polyline' && shape.latlngs && shape.latlngs.length >= 2) {
            const end = shape.latlngs[shape.latlngs.length - 1];
            const prev = shape.latlngs[shape.latlngs.length - 2];
            const mid = midpoint(prev, end);
            return projectOutwardPixels(end, mid, 12);
        }
        if (shape.type === 'arrow' && shape.latlngs && shape.latlngs.length >= 2) {
            const end = shape.latlngs[shape.latlngs.length - 1];
            const prev = shape.latlngs[shape.latlngs.length - 2];
            const mid = midpoint(prev, end);
            return projectOutwardPixels(end, mid, 12);
        }
        if (shape.type === 'arrow_stamp' && shape.center && shape.arrowLength != null) {
            const tip = destinationPoint(shape.center[0], shape.center[1], shape.arrowAngle || 45, Math.max(20, shape.arrowLength / 2));
            return projectOutwardPixels(tip, shape.center, 12);
        }
        if (shape.type === 'curve' && shape.curvePoints && shape.curvePoints.length >= 3) {
            const end = shape.curvePoints[2];
            const ctrl = shape.curvePoints[1];
            return projectOutwardPixels(end, ctrl, 12);
        }

        // Polygons/rectangles: use right edge midpoint then push outward.
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

        // Remove existing label marker if any
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
            interactive: false,
            zIndexOffset: 800
        }).addTo(map);

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

    // ---- Shape Popups ----

    function bindShapePopup(shape) {
        const entry = shapeLayerMap[shape.id];
        if (!entry || !entry.layer || shape.type === 'text') return;

        const typeLabel = shape.type.charAt(0).toUpperCase() + shape.type.slice(1);
        const measurement = showMeasurements ? (getMeasurementText(shape) || '') : '';
        const labelText = shape.label ? escapeHtml(shape.label) : '<em>No label</em>';

        let html = `
            <div class="shape-popup">
                <div class="popup-title">${typeLabel}</div>
                <div class="popup-detail">${labelText}</div>
                ${measurement ? `<div class="popup-detail">${measurement}</div>` : ''}
                <div class="popup-actions">
                    <a href="#" class="popup-edit-link shape-edit-link" data-shape-id="${shape.id}">Properties</a>
                    <a href="#" class="popup-edit-link shape-delete-link" data-shape-id="${shape.id}" style="color:#e05555; margin-left:12px;">Delete</a>
                </div>
            </div>
        `;

        entry.layer.unbindPopup();
        entry.layer.bindPopup(html);

        entry.layer.off('popupopen');
        entry.layer.on('popupopen', () => {
            const editLink = document.querySelector(`.shape-edit-link[data-shape-id="${shape.id}"]`);
            const deleteLink = document.querySelector(`.shape-delete-link[data-shape-id="${shape.id}"]`);

            if (editLink) {
                editLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    entry.layer.closePopup();
                    openShapeEditModal(shape.id);
                });
            }
            if (deleteLink) {
                deleteLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    entry.layer.closePopup();
                    removeShape(shape.id);
                });
            }
        });
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
        } else if (shape.type === 'arrow_stamp') {
            radiusGroup.classList.remove('hidden');
            angleGroup.classList.remove('hidden');
            if (radiusLabel) radiusLabel.textContent = 'Arrow Length (metres)';
            if (angleLabel) angleLabel.innerHTML = 'Arrow Direction (0-360&deg;, 0=North)';
            if (angleHint) angleHint.textContent = 'Use direction + length to resize/orient the arrow';
            document.getElementById('editShapeRadius').value = Math.round(shape.arrowLength || 200);
            document.getElementById('editShapeAngle').value = Math.round(shape.arrowAngle || 45);
        } else {
            radiusGroup.classList.add('hidden');
            angleGroup.classList.add('hidden');
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
        } else if (shape.type === 'arrow_stamp') {
            const newLength = parseFloat(document.getElementById('editShapeRadius').value);
            if (newLength > 0) {
                shape.arrowLength = newLength;
            }
            const newAngle = parseFloat(document.getElementById('editShapeAngle').value);
            if (!isNaN(newAngle)) {
                shape.arrowAngle = ((newAngle % 360) + 360) % 360;
            }
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
                refreshArrowDecorator(shape);
            }
            if (shape.type === 'arrow_stamp') {
                refreshArrowStampLayer(shape);
            }
        }

        updateMeasurement(shape);
        updateShapeLabelMarker(shape);
        bindShapePopup(shape);
        refreshShapesList();

        // If this shape is selected, refresh the style panel too
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
            if (entry.arrowDecorator && map.hasLayer(entry.arrowDecorator)) {
                map.removeLayer(entry.arrowDecorator);
            }
            if (entry.arrowHeadMarker && map.hasLayer(entry.arrowHeadMarker)) {
                map.removeLayer(entry.arrowHeadMarker);
            }
            if (entry.layer) map.removeLayer(entry.layer);
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
            if (entry && entry.arrowDecorator && map.hasLayer(entry.arrowDecorator)) {
                map.removeLayer(entry.arrowDecorator);
            }
            if (entry && entry.arrowHeadMarker && map.hasLayer(entry.arrowHeadMarker)) {
                map.removeLayer(entry.arrowHeadMarker);
            }
            removeShapeLabelMarker(numId);
            if (entry && entry.layer) map.removeLayer(entry.layer);
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
                style: shapeData.style || { ...currentStyle },
                center: shapeData.center,
                radius: shapeData.radius,
                measureAngle: shapeData.measureAngle != null ? shapeData.measureAngle : 45,
                arrowLength: shapeData.arrowLength,
                arrowAngle: shapeData.arrowAngle,
                latlngs: shapeData.latlngs,
                curvePoints: shapeData.curvePoints,
                position: shapeData.position,
                text: shapeData.text
            };
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
        if (type === 'arrow_stamp') return 'Arrow Stamp';
        if (!type) return 'Shape';
        return type.charAt(0).toUpperCase() + type.slice(1);
    }

    function isDrawingActive() {
        return !!(map && map.pm && map.pm.globalDrawModeEnabled()) || !!customDrawMode;
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
        isDrawingActive,
        getShapes,
        getShowMeasurements,
        saveShapeEdit,
        deleteShapeFromModal,
        refreshShapesList
    };

})();
