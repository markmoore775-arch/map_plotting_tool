/* ============================================
   PPTX THEME — Shared branded slide masters
   Used by all PowerPoint export functions
   ============================================ */

const PptxTheme = (() => {
    'use strict';

    let logoBase64 = null;
    let _light = false;

    const COLORS_DARK = {
        darkBg:      '1E1E2E',
        surface:     '2A2A3D',
        textPrimary: 'E0E0E8',
        textMuted:   '9999AA',
        accent:      '5B8DEF',
        accentDark:  '4A6FBF',
        footerBg:    '16162A',
        border:      '3A3A50',
        mapBg:       '#1a1a2e',
        tableHeader: 'FFFFFF'
    };

    const COLORS_LIGHT = {
        darkBg:      'FFFFFF',
        surface:     'F0F1F3',
        textPrimary: '1A1A1A',
        textMuted:   '555555',
        accent:      '4A6FBF',
        accentDark:  '3A5A9F',
        footerBg:    'E8E9EC',
        border:      'D0D0D0',
        mapBg:       '#f5f6f8',
        tableHeader: 'FFFFFF'
    };

    function colors() {
        return _light ? COLORS_LIGHT : COLORS_DARK;
    }

    function setLight(isLight) {
        _light = !!isLight;
    }

    /**
     * Match PdfTheme: raster logo (light glyph on dark) → black pin/drone on white for slide headers.
     */
    function dataUrlToBlackOnWhitePng(dataUrl) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () {
                try {
                    var w = img.naturalWidth;
                    var h = img.naturalHeight;
                    if (!w || !h) {
                        resolve(dataUrl);
                        return;
                    }
                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    var id = ctx.getImageData(0, 0, w, h);
                    var d = id.data;
                    var lumThreshold = 135;
                    for (var i = 0; i < d.length; i += 4) {
                        var lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                        if (lum > lumThreshold) {
                            d[i] = 0;
                            d[i + 1] = 0;
                            d[i + 2] = 0;
                            d[i + 3] = 255;
                        } else {
                            d[i] = 255;
                            d[i + 1] = 255;
                            d[i + 2] = 255;
                            d[i + 3] = 255;
                        }
                    }
                    ctx.putImageData(id, 0, 0);
                    resolve(canvas.toDataURL('image/png'));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = function () {
                resolve(dataUrl);
            };
            img.src = dataUrl;
        });
    }

    async function loadLogo() {
        if (logoBase64) return logoBase64;
        const paths = ['assets/icon-192.png', 'assets/airplot-icon.png'];
        for (let i = 0; i < paths.length; i++) {
            try {
                const resp = await fetch(paths[i]);
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const rawUrl = await new Promise(function (resolve, reject) {
                    const reader = new FileReader();
                    reader.onerror = function () {
                        reject(new Error('read failed'));
                    };
                    reader.onloadend = function () {
                        resolve(reader.result);
                    };
                    reader.readAsDataURL(blob);
                });
                try {
                    logoBase64 = await dataUrlToBlackOnWhitePng(rawUrl);
                } catch (e) {
                    logoBase64 = rawUrl;
                }
                return logoBase64;
            } catch (e) { /* try next */ }
        }
        console.warn('Could not load logo for PPTX branding (tried icon-192.png, airplot-icon.png).');
        return null;
    }

    function applyTheme(pptx, logo) {
        var C = colors();
        var footerTextColor = _light ? '888888' : C.textMuted;

        var titleObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.28, w: '100%', h: 0.04, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot v3', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: footerTextColor, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];
        if (logo) {
            titleObjects.push({ image: { x: 0.35, y: 0.2, w: 0.55, h: 0.55, data: logo } });
        }

        var contentObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.05, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot v3', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: footerTextColor, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];
        if (logo) {
            contentObjects.push({ image: { x: 12.35, y: 0.12, w: 0.4, h: 0.4, data: logo } });
        }

        var mapObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.05, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot v3', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: footerTextColor, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];

        pptx.defineSlideMaster({ title: 'TITLE_SLIDE', background: { color: C.darkBg }, objects: titleObjects });
        pptx.defineSlideMaster({ title: 'CONTENT_SLIDE', background: { color: C.darkBg }, objects: contentObjects });
        pptx.defineSlideMaster({ title: 'MAP_SLIDE', background: { color: C.darkBg }, objects: mapObjects });
    }

    async function captureSquareMap(mapElement) {
        var C = colors();
        if (typeof MapCapture !== 'undefined' && MapCapture.captureSquareMap) {
            return MapCapture.captureSquareMap(mapElement, C.mapBg);
        }
        var srcCanvas = await html2canvas(mapElement, {
            useCORS: true,
            allowTaint: false,
            backgroundColor: C.mapBg,
            scale: 2,
            logging: false
        });
        var sw = srcCanvas.width;
        var sh = srcCanvas.height;
        var side = Math.min(sw, sh);
        var sx = Math.round((sw - side) / 2);
        var sy = Math.round((sh - side) / 2);

        var sq = document.createElement('canvas');
        sq.width = side;
        sq.height = side;
        var ctx = sq.getContext('2d');
        ctx.drawImage(srcCanvas, sx, sy, side, side, 0, 0, side, side);
        return sq.toDataURL('image/png');
    }

    /** Word-wrap line count for panel width (inches) and font size (pt). */
    function estimateInfoPanelLines(text, widthInches, fontSizePt) {
        if (text == null || text === '') return 1;
        var avgCharW = (fontSizePt / 72) * 0.5;
        var cpl = Math.max(12, Math.floor(widthInches / avgCharW));
        var words = String(text).split(/\s+/);
        var lines = 1;
        var cur = 0;
        for (var wi = 0; wi < words.length; wi++) {
            var word = words[wi];
            var need = word.length + (cur > 0 ? 1 : 0);
            if (cur + need > cpl && cur > 0) {
                lines++;
                cur = word.length;
            } else {
                cur += need;
            }
        }
        return Math.max(1, lines);
    }

    function addInfoPanel(slide, x, y, w, h, rows) {
        var C = colors();
        var padding = 0.2;
        var labelH = 0.2;
        var defaultValueH = 0.28;
        var textW = w - 0.5;

        /** Coloured status word + normal explainer (Flight Weather panel). */
        function suitabilityValueHeight(row) {
            var sb = row.suitability;
            var fs = row.fontSize || 13;
            var efs = Math.max(10, fs - 1.5);
            var labelLineH = Math.max(0.2, (fs / 72) * 1.18);
            var explLines = estimateInfoPanelLines(sb.explainer, textW, efs);
            var lineGap = (efs / 72) * 1.22;
            var explBlockH = Math.max(0.32, explLines * lineGap + 0.04);
            return labelLineH + 0.06 + explBlockH;
        }

        function valueBlockHeight(row) {
            if (row.suitability) return suitabilityValueHeight(row);
            if (row.value == null || row.value === '') return 0;
            if (typeof row.valueHeight === 'number' && row.valueHeight > 0) return row.valueHeight;
            var fs = row.fontSize || 13;
            var lines = estimateInfoPanelLines(String(row.value), textW, fs);
            var lineGap = (fs / 72) * 1.22;
            return Math.max(defaultValueH, lines * lineGap + 0.04);
        }

        function rowTotalHeight(row) {
            var vh = valueBlockHeight(row);
            if (vh === 0 && !row.suitability) return Math.max(labelH + 0.08, 0.35);
            return labelH + vh + 0.06;
        }

        var totalH = padding;
        var ri;
        for (ri = 0; ri < rows.length; ri++) {
            totalH += rowTotalHeight(rows[ri]);
        }
        totalH += padding;

        var panelH = Math.max(h, totalH);

        slide.addShape('roundRect', {
            x: x, y: y, w: w, h: panelH,
            fill: { color: C.surface },
            rectRadius: 0.08,
            line: { color: C.border, width: 0.5 }
        });

        var cy = y + padding;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var ry = cy;
            var vh = valueBlockHeight(row);
            var rH = rowTotalHeight(row);

            if (row.label) {
                slide.addText(row.label, {
                    x: x + 0.25, y: ry, w: textW, h: labelH,
                    fontSize: 9, fontFace: 'Arial', color: C.textMuted,
                    bold: true, letterSpacing: 0.5, valign: 'top'
                });
            }
            if (row.suitability) {
                var sb = row.suitability;
                var fs = row.fontSize || 13;
                var efs = Math.max(10, fs - 1.5);
                var labelLineH = Math.max(0.2, (fs / 72) * 1.18);
                var explLines = estimateInfoPanelLines(sb.explainer, textW, efs);
                var lineGap = (efs / 72) * 1.22;
                var explBlockH = Math.max(0.32, explLines * lineGap + 0.04);
                slide.addText(sb.label, {
                    x: x + 0.25,
                    y: ry + labelH,
                    w: textW * 0.42,
                    h: labelLineH,
                    fontSize: fs,
                    bold: true,
                    color: sb.labelColor,
                    fontFace: 'Arial',
                    valign: 'top'
                });
                slide.addText(sb.explainer, {
                    x: x + 0.25,
                    y: ry + labelH + labelLineH + 0.05,
                    w: textW,
                    h: explBlockH,
                    fontSize: efs,
                    color: C.textPrimary,
                    fontFace: 'Arial',
                    wrap: true,
                    valign: 'top'
                });
            } else if (row.value != null && row.value !== '') {
                slide.addText(String(row.value), {
                    x: x + 0.25, y: ry + labelH, w: textW, h: vh,
                    fontSize: row.fontSize || 13, fontFace: 'Arial',
                    color: row.color || C.textPrimary, bold: row.bold || false,
                    wrap: true, valign: 'top'
                });
            }
            if (row.divider && i < rows.length - 1) {
                slide.addShape('line', {
                    x: x + 0.25, y: ry + rH - 0.04, w: textW, h: 0,
                    line: { color: C.border, width: 0.3 }
                });
            }
            cy += rH;
        }
    }

    function tableHeaderOpts() {
        var C = colors();
        return { fill: { color: C.accent }, color: C.tableHeader, bold: true, fontSize: 10, fontFace: 'Arial' };
    }

    function tableCellOpts() {
        var C = colors();
        return { fill: { color: C.surface }, color: C.textPrimary, fontSize: 10, fontFace: 'Arial' };
    }

    function tableLabelOpts() {
        var C = colors();
        return { fill: { color: C.surface }, color: C.textMuted, fontSize: 10, fontFace: 'Arial' };
    }

    function tableBorder() {
        var C = colors();
        return { type: 'solid', pt: 0.5, color: C.border };
    }

    return {
        COLORS: COLORS_DARK,
        colors: colors,
        setLight: setLight,
        loadLogo: loadLogo,
        applyTheme: applyTheme,
        captureSquareMap: captureSquareMap,
        addInfoPanel: addInfoPanel,
        tableHeaderOpts: tableHeaderOpts,
        tableCellOpts: tableCellOpts,
        tableLabelOpts: tableLabelOpts,
        tableBorder: tableBorder
    };
})();
