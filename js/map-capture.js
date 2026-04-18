/* ============================================
   Map raster capture for PPTX / PDF / screenshots
   - Leaflet: use crossOrigin on tile layers so canvas stays origin-clean.
   - html2canvas: allowTaint must be false when calling toDataURL (iOS Safari).
   ============================================ */

const MapCapture = (function () {
    'use strict';

    /** Merge into every L.tileLayer(..., opts) so tiles load with CORS. */
    const tileCorsOptions = { crossOrigin: true };

    function html2canvasOptions(mapBg, overrides) {
        return Object.assign(
            {
                useCORS: true,
                allowTaint: false,
                backgroundColor: mapBg,
                scale: 2,
                logging: false
            },
            overrides || {}
        );
    }

    function cropCanvasToSquareDataUrl(srcCanvas) {
        var sw = srcCanvas.width;
        var sh = srcCanvas.height;
        var side = Math.min(sw, sh);
        var sx = Math.round((sw - side) / 2);
        var sy = Math.round((sh - side) / 2);
        var sq = document.createElement('canvas');
        sq.width = side;
        sq.height = side;
        sq.getContext('2d').drawImage(srcCanvas, sx, sy, side, side, 0, 0, side, side);
        return sq.toDataURL('image/png');
    }

    function solidPlaceholderDataUrl(mapBg) {
        var side = 512;
        var sq = document.createElement('canvas');
        sq.width = side;
        sq.height = side;
        var ctx = sq.getContext('2d');
        ctx.fillStyle = mapBg || '#1a1a2e';
        ctx.fillRect(0, 0, side, side);
        return sq.toDataURL('image/png');
    }

    /** html2canvas uses off-screen iframes; remove any that were not detached (seen on some mobile browsers). */
    function removeOrphanHtml2canvasIframes() {
        try {
            document.querySelectorAll('iframe.html2canvas-container').forEach(function (el) {
                if (el.parentNode) el.parentNode.removeChild(el);
            });
        } catch (e) { /* ignore */ }
    }

    async function captureSquareMap(mapElement, mapBg) {
        if (typeof html2canvas === 'undefined') {
            return solidPlaceholderDataUrl(mapBg);
        }
        try {
            var srcCanvas = await html2canvas(mapElement, html2canvasOptions(mapBg));
            return cropCanvasToSquareDataUrl(srcCanvas);
        } catch (e) {
            console.warn('Map capture failed, using placeholder', e);
            return solidPlaceholderDataUrl(mapBg);
        } finally {
            removeOrphanHtml2canvasIframes();
        }
    }

    async function captureFullMapToDataUrl(mapElement, mapBg) {
        if (typeof html2canvas === 'undefined') {
            return solidPlaceholderDataUrl(mapBg);
        }
        try {
            var canvas = await html2canvas(mapElement, html2canvasOptions(mapBg));
            return canvas.toDataURL('image/png');
        } catch (e) {
            console.warn('Map capture failed, using placeholder', e);
            return solidPlaceholderDataUrl(mapBg);
        } finally {
            removeOrphanHtml2canvasIframes();
        }
    }

    return {
        tileCorsOptions: tileCorsOptions,
        html2canvasOptions: html2canvasOptions,
        captureSquareMap: captureSquareMap,
        captureFullMapToDataUrl: captureFullMapToDataUrl,
        removeOrphanHtml2canvasIframes: removeOrphanHtml2canvasIframes
    };
})();
