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

    async function loadLogo() {
        if (logoBase64) return logoBase64;
        try {
            const resp = await fetch('assets/airplot-icon.png');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const blob = await resp.blob();
            return new Promise(function (resolve) {
                const reader = new FileReader();
                reader.onloadend = function () { logoBase64 = reader.result; resolve(logoBase64); };
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.warn('Could not load logo for PPTX branding:', e);
            return null;
        }
    }

    function applyTheme(pptx, logo) {
        var C = colors();
        var footerTextColor = _light ? '888888' : C.textMuted;

        var titleObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.28, w: '100%', h: 0.04, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: footerTextColor, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];
        if (logo) {
            titleObjects.push({ image: { x: 0.35, y: 0.2, w: 0.55, h: 0.55, data: logo } });
        }

        var contentObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.05, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: footerTextColor, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];
        if (logo) {
            contentObjects.push({ image: { x: 12.35, y: 0.12, w: 0.4, h: 0.4, data: logo } });
        }

        var mapObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.05, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: footerTextColor, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];

        pptx.defineSlideMaster({ title: 'TITLE_SLIDE', background: { color: C.darkBg }, objects: titleObjects });
        pptx.defineSlideMaster({ title: 'CONTENT_SLIDE', background: { color: C.darkBg }, objects: contentObjects });
        pptx.defineSlideMaster({ title: 'MAP_SLIDE', background: { color: C.darkBg }, objects: mapObjects });
    }

    async function captureSquareMap(mapElement) {
        var C = colors();
        var srcCanvas = await html2canvas(mapElement, {
            useCORS: true,
            allowTaint: true,
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

    function addInfoPanel(slide, x, y, w, h, rows) {
        var C = colors();
        slide.addShape('roundRect', {
            x: x, y: y, w: w, h: h,
            fill: { color: C.surface },
            rectRadius: 0.08,
            line: { color: C.border, width: 0.5 }
        });
        var rowH = 0.55;
        var padding = 0.2;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var ry = y + padding + (i * rowH);
            if (row.label) {
                slide.addText(row.label, {
                    x: x + 0.25, y: ry, w: w - 0.5, h: 0.2,
                    fontSize: 9, fontFace: 'Arial', color: C.textMuted,
                    bold: true, letterSpacing: 0.5
                });
            }
            if (row.value) {
                slide.addText(row.value, {
                    x: x + 0.25, y: ry + 0.18, w: w - 0.5, h: 0.28,
                    fontSize: row.fontSize || 13, fontFace: 'Arial',
                    color: row.color || C.textPrimary, bold: row.bold || false
                });
            }
            if (row.divider && i < rows.length - 1) {
                slide.addShape('line', {
                    x: x + 0.25, y: ry + rowH - 0.05, w: w - 0.5, h: 0,
                    line: { color: C.border, width: 0.3 }
                });
            }
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
