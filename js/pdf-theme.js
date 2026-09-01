/* ============================================
   PDF THEME: Shared branded PDF generation
   Used by all PDF export functions
   ============================================ */

const PdfTheme = (() => {
    'use strict';

    /** PDF exports default to light theme (paper-style). */
    let _light = true;
    let _logoBase64 = null;
    /** airplanlogowhite/black.png aspect (width / height). */
    var LOGO_ASPECT = 840 / 938;

    const DARK = {
        bg: [30, 30, 46],
        surface: [42, 42, 61],
        text: [224, 224, 232],
        muted: [153, 153, 170],
        accent: [91, 141, 239],
        accentDark: [74, 111, 191],
        footer: [22, 22, 42],
        border: [58, 58, 80],
        headerText: [255, 255, 255],
        mapBg: '#1a1a2e'
    };

    const LIGHT = {
        bg: [255, 255, 255],
        surface: [240, 241, 243],
        text: [26, 26, 26],
        muted: [85, 85, 85],
        accent: [74, 111, 191],
        accentDark: [58, 90, 159],
        footer: [232, 233, 236],
        border: [208, 208, 208],
        headerText: [255, 255, 255],
        mapBg: '#f5f6f8'
    };

    function C() { return _light ? LIGHT : DARK; }
    function hex(rgb) { return '#' + rgb.map(function (v) { return v.toString(16).padStart(2, '0'); }).join(''); }

    function setLight(v) {
        _light = !!v;
        _logoBase64 = null;
    }

    async function loadLogo() {
        if (_logoBase64) return _logoBase64;
        var path = _light ? 'assets/airplanlogoblack.png' : 'assets/airplanlogowhite.png';
        try {
            var resp = await fetch(path);
            if (!resp.ok) return null;
            var blob = await resp.blob();
            _logoBase64 = await new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onerror = function () { reject(new Error('read failed')); };
                reader.onloadend = function () { resolve(reader.result); };
                reader.readAsDataURL(blob);
            });
            return _logoBase64;
        } catch (e) {
            return null;
        }
    }

    var _landscape = false;
    /** Default Y (mm) where body content begins below the page header. */
    var _contentTopMm = 18;

    function setContentTopMm(v) {
        _contentTopMm = v;
    }

    function contentTopMm() {
        return _contentTopMm;
    }

    /** Title-page content (map/panel) sits slightly lower than inner pages. */
    function titleContentTopMm() {
        return _contentTopMm + 8;
    }

    function pageDims() {
        return _landscape ? { w: 297, h: 210 } : { w: 210, h: 297 };
    }

    function createDoc(opts) {
        opts = opts || {};
        _landscape = !!opts.landscape;
        var dims = pageDims();
        var orient = _landscape ? 'landscape' : 'portrait';
        var doc = new jspdf.jsPDF({ orientation: orient, unit: 'mm', format: 'a4' });
        var c = C();
        doc.setFillColor(c.bg[0], c.bg[1], c.bg[2]);
        doc.rect(0, 0, dims.w, dims.h, 'F');
        return doc;
    }

    function newPage(doc) {
        var orient = _landscape ? 'landscape' : 'portrait';
        doc.addPage('a4', orient);
        var dims = pageDims();
        var c = C();
        doc.setFillColor(c.bg[0], c.bg[1], c.bg[2]);
        doc.rect(0, 0, dims.w, dims.h, 'F');
    }

    function addHeader(doc, title, isTitlePage) {
        var c = C();
        var pw = pageDims().w;
        var barH = isTitlePage ? 3 : 2;
        doc.setFillColor(c.accent[0], c.accent[1], c.accent[2]);
        doc.rect(0, 0, pw, barH, 'F');
        var logoLeft = 10;
        var logoTop = 5;
        var logoH = isTitlePage ? 14 : 10;
        var logoW = logoH * LOGO_ASPECT;
        if (_logoBase64) {
            try {
                if (isTitlePage) {
                    doc.addImage(_logoBase64, 'PNG', logoLeft, logoTop, logoW, logoH);
                } else {
                    logoH = 10;
                    logoW = logoH * LOGO_ASPECT;
                    logoTop = 3.5;
                    logoLeft = pw - 10 - logoW;
                    doc.addImage(_logoBase64, 'PNG', logoLeft, logoTop, logoW, logoH);
                }
            } catch (e) {}
        }
        if (title) {
            var titleSize = isTitlePage ? 22 : 16;
            var titleX = isTitlePage && _logoBase64 ? logoLeft + logoW + 4 : 10;
            var titleY;
            if (_logoBase64) {
                titleY = logoTop + logoH / 2;
            } else if (isTitlePage) {
                titleY = 14;
            } else {
                titleY = 7;
            }
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(titleSize);
            doc.setTextColor(c.text[0], c.text[1], c.text[2]);
            doc.text(title, titleX, titleY, { baseline: 'middle' });
        }
    }

    function addFooter(doc) {
        var c = C();
        var pw = pageDims().w;
        var ph = pageDims().h;
        doc.setFillColor(c.accent[0], c.accent[1], c.accent[2]);
        doc.rect(0, ph - 6, pw, 1.5, 'F');
        doc.setFillColor(c.footer[0], c.footer[1], c.footer[2]);
        doc.rect(0, ph - 4.5, pw, 4.5, 'F');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6);
        doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
        doc.text('AirPlan v1', pw - 10, ph - 1.2, { align: 'right' });
        var pages = doc.internal.getNumberOfPages();
        var current = doc.internal.getCurrentPageInfo().pageNumber;
        doc.text('Page ' + current + ' of ' + pages, 10, ph - 1.2);
    }

    function addAllFooters(doc) {
        var total = doc.internal.getNumberOfPages();
        for (var i = 1; i <= total; i++) {
            doc.setPage(i);
            addFooter(doc);
        }
    }

    function addInfoPanel(doc, x, y, w, rows) {
        var c = C();
        var padding = 4;
        var maxTextW = w - 10;
        var defaultValueFontSize = 9;

        function measureValueBlock(row) {
            if (row.suitability) {
                var sb = row.suitability;
                var vSize = row.fontSize || defaultValueFontSize;
                var eSize = Math.max(7.5, vSize - 1);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(vSize);
                var labelH = vSize * 0.42;
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(eSize);
                var explLines = doc.splitTextToSize(String(sb.explainer || ''), maxTextW);
                if (!explLines.length) explLines = [''];
                var lhExpl = eSize * 0.42;
                var valueH = labelH + 2 + explLines.length * lhExpl;
                return {
                    suitability: true,
                    label: String(sb.label || ''),
                    labelRgb: sb.labelColor,
                    explLines: explLines,
                    vSize: vSize,
                    eSize: eSize,
                    labelH: labelH,
                    lhExpl: lhExpl,
                    valueH: valueH
                };
            }
            var vSize = row.fontSize || defaultValueFontSize;
            doc.setFont('helvetica', row.bold ? 'bold' : 'normal');
            doc.setFontSize(vSize);
            var valStr = row.value != null ? String(row.value) : '';
            var lines = doc.splitTextToSize(valStr, maxTextW);
            if (!lines.length) lines = [''];
            var lhMm = vSize * 0.42;
            return { lines: lines, lhMm: lhMm, vSize: vSize, bold: !!row.bold, valueH: lines.length * lhMm };
        }

        var measured = [];
        var totalH = padding;
        for (var ri = 0; ri < rows.length; ri++) {
            measured.push(measureValueBlock(rows[ri]));
            var labelGap = rows[ri].label ? 4 : 0;
            var rowH = labelGap + 3 + measured[ri].valueH + 3;
            totalH += rowH;
        }
        totalH += padding;

        doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
        doc.roundedRect(x, y, w, totalH, 2, 2, 'F');
        doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
        doc.setLineWidth(0.3);
        doc.roundedRect(x, y, w, totalH, 2, 2, 'S');

        var cy = y + padding;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var m = measured[i];
            var labelGap = row.label ? 4 : 0;
            var rowH = labelGap + 3 + m.valueH + 3;

            if (row.label) {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(6.5);
                doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                doc.text(row.label, x + 5, cy + 3);
            }
            var vx = x + 5;
            var firstBaseline = cy + (row.label ? 8 : 4);
            if (m.suitability) {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(m.vSize);
                if (m.labelRgb) {
                    doc.setTextColor(m.labelRgb[0], m.labelRgb[1], m.labelRgb[2]);
                } else {
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                }
                doc.text(m.label, vx, firstBaseline);
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(m.eSize);
                doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                var explY = firstBaseline + m.labelH + 2;
                for (var ei = 0; ei < m.explLines.length; ei++) {
                    doc.text(m.explLines[ei], vx, explY + ei * m.lhExpl);
                }
            } else {
                doc.setFont('helvetica', m.bold ? 'bold' : 'normal');
                doc.setFontSize(m.vSize);
                if (row.color) {
                    doc.setTextColor(row.color[0], row.color[1], row.color[2]);
                } else {
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                }
                for (var li = 0; li < m.lines.length; li++) {
                    doc.text(m.lines[li], vx, firstBaseline + li * m.lhMm);
                }
            }
            if (row.divider && i < rows.length - 1) {
                doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
                doc.setLineWidth(0.15);
                doc.line(x + 5, cy + rowH - 0.5, x + w - 5, cy + rowH - 0.5);
            }
            cy += rowH;
        }
        return totalH;
    }

    function tableStyles(opts) {
        opts = opts || {};
        var c = C();
        var large = !!opts.large;
        return {
            headStyles: {
                fillColor: c.accent,
                textColor: c.headerText,
                fontStyle: 'bold',
                fontSize: large ? 9 : 7.5,
                font: 'helvetica'
            },
            bodyStyles: {
                fillColor: c.surface,
                textColor: c.text,
                fontSize: large ? 8.5 : 7,
                font: 'helvetica',
                cellPadding: large ? 2.5 : 2
            },
            alternateRowStyles: {
                fillColor: c.bg
            },
            styles: {
                lineColor: c.border,
                lineWidth: 0.2,
                overflow: 'linebreak'
            },
            margin: { left: 10, right: 10 },
            tableLineColor: c.border,
            tableLineWidth: 0.2
        };
    }

    async function captureSquareMap(mapElement) {
        var c = C();
        if (typeof MapCapture !== 'undefined' && MapCapture.captureSquareMap) {
            return MapCapture.captureSquareMap(mapElement, c.mapBg);
        }
        var srcCanvas = await html2canvas(mapElement, {
            useCORS: true,
            allowTaint: false,
            backgroundColor: c.mapBg,
            scale: 2,
            logging: false
        });
        var sw = srcCanvas.width, sh = srcCanvas.height;
        var side = Math.min(sw, sh);
        var sx = Math.round((sw - side) / 2);
        var sy = Math.round((sh - side) / 2);
        var sq = document.createElement('canvas');
        sq.width = side;
        sq.height = side;
        sq.getContext('2d').drawImage(srcCanvas, sx, sy, side, side, 0, 0, side, side);
        return sq.toDataURL('image/png');
    }

    /** Draw image inside a rounded surface-coloured frame (matches PPTX map styling). */
    function addFramedImage(doc, imgData, x, y, size) {
        var c = C();
        var pad = 2;
        doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
        doc.roundedRect(x - pad, y - pad, size + pad * 2, size + pad * 2, 2, 2, 'F');
        doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
        doc.setLineWidth(0.3);
        doc.roundedRect(x - pad, y - pad, size + pad * 2, size + pad * 2, 2, 2, 'S');
        doc.addImage(imgData, 'PNG', x, y, size, size);
    }

    return {
        setLight: setLight,
        loadLogo: loadLogo,
        colors: C,
        hex: hex,
        pageWidthMm: function () { return pageDims().w; },
        pageHeightMm: function () { return pageDims().h; },
        isLandscape: function () { return _landscape; },
        setContentTopMm: setContentTopMm,
        contentTopMm: contentTopMm,
        titleContentTopMm: titleContentTopMm,
        createDoc: createDoc,
        newPage: newPage,
        addHeader: addHeader,
        addFooter: addFooter,
        addAllFooters: addAllFooters,
        addInfoPanel: addInfoPanel,
        addFramedImage: addFramedImage,
        tableStyles: tableStyles,
        captureSquareMap: captureSquareMap
    };
})();
