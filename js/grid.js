/* ============================================
   GRID OVERLAY MODULE
   ============================================ */

const GridOverlay = (() => {
    'use strict';

    let map;
    let gridLayer;
    let gridBounds = null;
    let gridRows = 3;
    let gridCols = 3;
    let isVisible = true;
    let gridDrawModeActive = false;

    function init(m) {
        map = m;
        gridLayer = L.layerGroup().addTo(map);
    }

    function setBounds(bounds) {
        gridBounds = bounds;
    }

    function setParams(rows, cols) {
        gridRows = Math.max(1, Math.min(50, rows));
        gridCols = Math.max(1, Math.min(26, cols));
    }

    function clear() {
        gridLayer.clearLayers();
        gridBounds = null;
    }

    function render() {
        gridLayer.clearLayers();
        if (!gridBounds || !isVisible) return;

        const [[swLat, swLng], [neLat, neLng]] = gridBounds;
        const cellHeight = (neLat - swLat) / gridRows;
        const cellWidth = (neLng - swLng) / gridCols;

        for (let r = 0; r < gridRows; r++) {
            for (let c = 0; c < gridCols; c++) {
                const cellSw = [swLat + r * cellHeight, swLng + c * cellWidth];
                const cellNe = [cellSw[0] + cellHeight, cellSw[1] + cellWidth];
                const rect = L.rectangle([cellSw, cellNe], {
                    color: '#333',
                    weight: 1,
                    fillColor: '#e0e0e0',
                    fillOpacity: 0.25
                });
                rect.on('contextmenu', (e) => {
                    e.originalEvent.preventDefault();
                    e.originalEvent.stopPropagation();
                    map.fire('grid:contextmenu', { originalEvent: e.originalEvent, latlng: e.latlng });
                });
                gridLayer.addLayer(rect);
            }
        }

        // Column labels (A, B, C...) along top - use shape-label-text style
        for (let c = 0; c < gridCols; c++) {
            const centerLng = swLng + (c + 0.5) * cellWidth;
            const label = L.marker([neLat + 0.02 * (neLat - swLat), centerLng], {
                icon: L.divIcon({
                    className: 'grid-label-marker grid-col-label',
                    html: `<div class="shape-label-text">${String.fromCharCode(65 + c)}</div>`,
                    iconSize: [40, 40],
                    iconAnchor: [20, 20]
                })
            });
            gridLayer.addLayer(label);
        }

        // Row labels (1, 2, 3...) along left - use shape-label-text style
        for (let r = 0; r < gridRows; r++) {
            const centerLat = swLat + (r + 0.5) * cellHeight;
            const label = L.marker([centerLat, swLng - 0.02 * (neLng - swLng)], {
                icon: L.divIcon({
                    className: 'grid-label-marker grid-row-label',
                    html: `<div class="shape-label-text">${r + 1}</div>`,
                    iconSize: [40, 40],
                    iconAnchor: [20, 20]
                })
            });
            gridLayer.addLayer(label);
        }
    }

    function toggle(visible) {
        isVisible = visible;
        if (gridBounds) render();
    }

    function startGridDrawMode() {
        gridDrawModeActive = true;
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
        map.pm.enableDraw('Rectangle', { snappable: true });
    }

    function exitGridDrawMode() {
        gridDrawModeActive = false;
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
            map.pm.disableDraw();
        }
    }

    function captureBoundsFromLayer(layer) {
        const bounds = layer.getBounds();
        gridBounds = [
            [bounds.getSouthWest().lat, bounds.getSouthWest().lng],
            [bounds.getNorthEast().lat, bounds.getNorthEast().lng]
        ];
    }

    function isGridDrawModeActive() {
        return gridDrawModeActive;
    }

    function getParams() {
        return { rows: gridRows, cols: gridCols };
    }

    return {
        init,
        setBounds,
        setParams,
        getParams,
        clear,
        render,
        toggle,
        startGridDrawMode,
        exitGridDrawMode,
        captureBoundsFromLayer,
        isGridDrawModeActive,
        getBounds: () => gridBounds,
        hasGrid: () => !!gridBounds,
        isVisible: () => isVisible
    };
})();
