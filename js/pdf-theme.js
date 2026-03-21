/* ============================================
   PDF THEME — Shared branded PDF generation
   Used by all PDF export functions
   ============================================ */

const PdfTheme = (() => {
    'use strict';

    let _light = false;
    let _logoBase64 = null;

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

    function setLight(v) { _light = !!v; }

    async function loadLogo() {
        if (_logoBase64) return _logoBase64;
        try {
            var resp = await fetch('assets/airplot-icon.png');
            if (!resp.ok) return null;
            var blob = await resp.blob();
            return new Promise(function (resolve) {
                var reader = new FileReader();
                reader.onloadend = function () { _logoBase64 = reader.result; resolve(_logoBase64); };
                reader.readAsDataURL(blob);
            });
        } catch (e) { return null; }
    }

    function createDoc() {
        var doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        var c = C();
        doc.setFillColor(c.bg[0], c.bg[1], c.bg[2]);
        doc.rect(0, 0, 297, 210, 'F');
        return doc;
    }

    function newPage(doc) {
        doc.addPage('a4', 'landscape');
        var c = C();
        doc.setFillColor(c.bg[0], c.bg[1], c.bg[2]);
        doc.rect(0, 0, 297, 210, 'F');
    }

    function addHeader(doc, title, isTitlePage) {
        var c = C();
        var barH = isTitlePage ? 3 : 2;
        doc.setFillColor(c.accent[0], c.accent[1], c.accent[2]);
        doc.rect(0, 0, 297, barH, 'F');
        if (_logoBase64) {
            try {
                if (isTitlePage) {
                    doc.addImage(_logoBase64, 'PNG', 10, 5, 14, 14);
                } else {
                    doc.addImage(_logoBase64, 'PNG', 280, 3.5, 10, 10);
                }
            } catch (e) {}
        }
        if (title) {
            var titleY = isTitlePage ? 10 : 6;
            var titleSize = isTitlePage ? 22 : 16;
            var titleX = isTitlePage && _logoBase64 ? 28 : 10;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(titleSize);
            doc.setTextColor(c.text[0], c.text[1], c.text[2]);
            doc.text(title, titleX, titleY);
        }
    }

    function addFooter(doc) {
        var c = C();
        var pw = 297, ph = 210;
        doc.setFillColor(c.accent[0], c.accent[1], c.accent[2]);
        doc.rect(0, ph - 6, pw, 1.5, 'F');
        doc.setFillColor(c.footer[0], c.footer[1], c.footer[2]);
        doc.rect(0, ph - 4.5, pw, 4.5, 'F');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6);
        doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
        doc.text('AirPlot', pw - 10, ph - 1.2, { align: 'right' });
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
        var rowH = 10;
        var padding = 4;
        var h = padding * 2 + rows.length * rowH;
        doc.setFillColor(c.surface[0], c.surface[1], c.surface[2]);
        doc.roundedRect(x, y, w, h, 2, 2, 'F');
        doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
        doc.setLineWidth(0.3);
        doc.roundedRect(x, y, w, h, 2, 2, 'S');

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var ry = y + padding + i * rowH;
            if (row.label) {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(6.5);
                doc.setTextColor(c.muted[0], c.muted[1], c.muted[2]);
                doc.text(row.label, x + 5, ry + 3);
            }
            if (row.value) {
                doc.setFont('helvetica', row.bold ? 'bold' : 'normal');
                doc.setFontSize(row.fontSize || 9);
                if (row.color) {
                    doc.setTextColor(row.color[0], row.color[1], row.color[2]);
                } else {
                    doc.setTextColor(c.text[0], c.text[1], c.text[2]);
                }
                doc.text(String(row.value), x + 5, ry + 8);
            }
            if (row.divider && i < rows.length - 1) {
                doc.setDrawColor(c.border[0], c.border[1], c.border[2]);
                doc.setLineWidth(0.15);
                doc.line(x + 5, ry + rowH - 0.5, x + w - 5, ry + rowH - 0.5);
            }
        }
        return h;
    }

    function tableStyles() {
        var c = C();
        return {
            headStyles: {
                fillColor: c.accent,
                textColor: c.headerText,
                fontStyle: 'bold',
                fontSize: 7.5,
                font: 'helvetica'
            },
            bodyStyles: {
                fillColor: c.surface,
                textColor: c.text,
                fontSize: 7,
                font: 'helvetica',
                cellPadding: 2
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
        var srcCanvas = await html2canvas(mapElement, {
            useCORS: true,
            allowTaint: true,
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

    return {
        setLight: setLight,
        loadLogo: loadLogo,
        colors: C,
        hex: hex,
        createDoc: createDoc,
        newPage: newPage,
        addHeader: addHeader,
        addFooter: addFooter,
        addAllFooters: addAllFooters,
        addInfoPanel: addInfoPanel,
        tableStyles: tableStyles,
        captureSquareMap: captureSquareMap
    };
})();
