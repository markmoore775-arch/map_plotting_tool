/* ============================================
   PPTX THEME — Shared branded slide masters
   Used by all PowerPoint export functions
   ============================================ */

const PptxTheme = (() => {
    'use strict';

    let logoBase64 = null;

    const COLORS = {
        darkBg:      '1E1E2E',
        surface:     '2A2A3D',
        textPrimary: 'E0E0E8',
        textMuted:   '9999AA',
        accent:      '5B8DEF',
        accentDark:  '4A6FBF',
        footerBg:    '16162A',
        border:      '3A3A50'
    };

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
        var C = COLORS;

        var titleObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.28, w: '100%', h: 0.04, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: C.textMuted, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];
        if (logo) {
            titleObjects.push({ image: { x: 0.35, y: 0.2, w: 0.55, h: 0.55, data: logo } });
        }

        var contentObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.05, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: C.textMuted, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];
        if (logo) {
            contentObjects.push({ image: { x: 12.35, y: 0.12, w: 0.4, h: 0.4, data: logo } });
        }

        var mapObjects = [
            { rect: { x: 0, y: 0, w: '100%', h: 0.05, fill: { color: C.accent } } },
            { rect: { x: 0, y: 7.32, w: '100%', h: 0.18, fill: { color: C.footerBg } } },
            { text: { text: 'AirPlot', options: { x: 11, y: 7.32, w: 2.2, h: 0.18, fontSize: 8, color: C.textMuted, fontFace: 'Arial', align: 'right', valign: 'middle' } } }
        ];

        pptx.defineSlideMaster({ title: 'TITLE_SLIDE', background: { color: C.darkBg }, objects: titleObjects });
        pptx.defineSlideMaster({ title: 'CONTENT_SLIDE', background: { color: C.darkBg }, objects: contentObjects });
        pptx.defineSlideMaster({ title: 'MAP_SLIDE', background: { color: C.darkBg }, objects: mapObjects });
    }

    function tableHeaderOpts() {
        return { fill: { color: COLORS.accent }, color: 'FFFFFF', bold: true, fontSize: 10, fontFace: 'Arial' };
    }

    function tableCellOpts() {
        return { fill: { color: COLORS.surface }, color: COLORS.textPrimary, fontSize: 10, fontFace: 'Arial' };
    }

    function tableLabelOpts() {
        return { fill: { color: COLORS.surface }, color: COLORS.textMuted, fontSize: 10, fontFace: 'Arial' };
    }

    function tableBorder() {
        return { type: 'solid', pt: 0.5, color: COLORS.border };
    }

    return {
        COLORS: COLORS,
        loadLogo: loadLogo,
        applyTheme: applyTheme,
        tableHeaderOpts: tableHeaderOpts,
        tableCellOpts: tableCellOpts,
        tableLabelOpts: tableLabelOpts,
        tableBorder: tableBorder
    };
})();
