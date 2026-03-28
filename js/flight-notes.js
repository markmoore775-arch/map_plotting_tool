/**
 * Flight Report — form serialization, GPS (HTTPS only), mailto + clipboard fallback, PDF via PdfTheme.
 * Page Theme + PDF theme (Dark/Light) radios; Clear report (header) / Clear form share one confirmation modal.
 */
(function () {
    'use strict';

    /** Draft form fields — local only, same origin; cleared when user clears the form. */
    var FN_DRAFT_STORAGE_KEY = 'airplotFlightNotesDraft_v1';
    var FN_DRAFT_FIELD_IDS = [
        'fnDate',
        'fnTime',
        'fnLocation',
        'fnReference',
        'fnDeconflictions',
        'fnRp1',
        'fnRp2',
        'fnUas',
        'fnBattery1',
        'fnBattery1Time',
        'fnBattery2',
        'fnBattery2Time',
        'fnBattery3',
        'fnBattery3Time',
        'fnBattery4',
        'fnBattery4Time',
        'fnAlosRagNotes',
        'fnWeather',
        'fnAirspaceRadiusKm',
        'fnNotes'
    ];

    var fnDraftSaveTimer = null;

    function saveFlightNotesDraft() {
        try {
            var fields = {};
            for (var i = 0; i < FN_DRAFT_FIELD_IDS.length; i++) {
                var id = FN_DRAFT_FIELD_IDS[i];
                var el = document.getElementById(id);
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                    fields[id] = el.value || '';
                }
            }
            localStorage.setItem(FN_DRAFT_STORAGE_KEY, JSON.stringify({ v: 1, fields: fields }));
        } catch (e) {}
    }

    function scheduleFlightNotesDraftSave() {
        if (fnDraftSaveTimer) clearTimeout(fnDraftSaveTimer);
        fnDraftSaveTimer = setTimeout(function () {
            fnDraftSaveTimer = null;
            saveFlightNotesDraft();
        }, 250);
    }

    function loadFlightNotesDraft() {
        try {
            var raw = localStorage.getItem(FN_DRAFT_STORAGE_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            if (!data || data.v !== 1 || !data.fields) return;
            var id;
            for (id in data.fields) {
                if (!Object.prototype.hasOwnProperty.call(data.fields, id)) continue;
                var el = document.getElementById(id);
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                    el.value = data.fields[id];
                }
            }
        } catch (e) {}
    }

    function clearFlightNotesDraftStorage() {
        try {
            localStorage.removeItem(FN_DRAFT_STORAGE_KEY);
        } catch (e) {}
    }

    var MAILTO_BODY_MAX = 1800;
    var GPS_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

    var miniMap = null;

    var fnAirspaceRadiusKm = 3;
    var fnLastNotams = null;
    var fnLastAirspace = null;
    var fnAirspaceMaps = [];
    var fnAirspaceDataLoaded = false;

    function escapeHtmlFn(str) {
        if (str == null) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatNotamDateFn(str) {
        if (!str) return '';
        var raw = String(str).trim();
        var up = raw.toUpperCase();
        if (up === 'PERM' || up === 'UFN') return up;
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var fmt = function (d) {
            return (
                d.getUTCDate() +
                ' ' +
                months[d.getUTCMonth()] +
                ' ' +
                d.getUTCFullYear() +
                ' ' +
                String(d.getUTCHours()).padStart(2, '0') +
                ':' +
                String(d.getUTCMinutes()).padStart(2, '0') +
                ' UTC'
            );
        };
        var m = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (m) {
            var d = new Date(Date.UTC(+m[1], parseInt(m[2], 10) - 1, +m[3], +m[4], +m[5]));
            if (!isNaN(d.getTime())) return fmt(d);
        }
        m = raw.match(/\d{10}/);
        if (!m) return raw;
        var s = m[0];
        var yy = parseInt(s.slice(0, 2), 10);
        var mm = parseInt(s.slice(2, 4), 10) - 1;
        var dd = parseInt(s.slice(4, 6), 10);
        var hh = parseInt(s.slice(6, 8), 10);
        var min = parseInt(s.slice(8, 10), 10);
        var year = yy >= 50 ? 1900 + yy : 2000 + yy;
        if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return raw;
        return fmt(new Date(Date.UTC(year, mm, dd, hh, min)));
    }

    function readFnAirspaceRadiusFromInput() {
        var input = document.getElementById('fnAirspaceRadiusKm');
        var v = input ? parseInt(String(input.value), 10) : 3;
        if (!isFinite(v)) v = 3;
        return Math.min(100, Math.max(1, Math.round(v)));
    }

    function syncFnAirspaceIntroKm() {
        var intro = document.getElementById('fnAirspaceIntroKm');
        var v = readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = v;
        if (intro) intro.textContent = String(v);
    }

    function destroyFnAirspaceMaps() {
        fnAirspaceMaps.forEach(function (o) {
            try {
                if (o.map) o.map.remove();
            } catch (e) {}
        });
        fnAirspaceMaps = [];
    }

    function fnAirspaceSummaryForExport() {
        if (!fnAirspaceDataLoaded) {
            return '— (set coordinates and tap Refresh in Airspace)';
        }
        var na = (fnLastNotams || []).length;
        var nb = (fnLastAirspace || []).length;
        return fnAirspaceRadiusKm + ' km · ' + (na + nb) + ' item(s) · maps after table';
    }

    function renderFnAirspaceHtml(notams, airspace, lat, lng) {
        var content = document.getElementById('fnAirspaceContent');
        if (!content) return;
        content.innerHTML = '';

        if (notams.length === 0 && airspace.length === 0) {
            content.innerHTML =
                '<div class="fn-airspace-empty"><p>No NOTAMs or airspace restrictions found within ' +
                fnAirspaceRadiusKm +
                ' km.</p></div>';
            return;
        }

        var catColors = { FRZ: 'frz', Prohibited: 'prohibited', Restricted: 'restricted', Danger: 'danger' };

        if (airspace.length > 0) {
            content.insertAdjacentHTML(
                'beforeend',
                '<div class="fn-airspace-section-title">Airspace restrictions <span>(' + airspace.length + ')</span></div>'
            );
            airspace.forEach(function (a, i) {
                var cls = catColors[a.category] || 'danger';
                var distKm = '';
                if (a.geometry) {
                    var coords =
                        a.geometry.type === 'MultiPolygon'
                            ? a.geometry.coordinates.flat(2)
                            : a.geometry.type === 'Polygon'
                              ? a.geometry.coordinates.flat()
                              : [];
                    var minDist = Infinity;
                    coords.forEach(function (c) {
                        var d = AirspaceNearby.haversineKm(lat, lng, c[1], c[0]);
                        if (d < minDist) minDist = d;
                    });
                    if (isFinite(minDist)) distKm = ' · ' + minDist.toFixed(1) + ' km away';
                }
                var bodyLines = [];
                bodyLines.push('<p><strong>Designator</strong> ' + escapeHtmlFn(a.designator) + '</p>');
                bodyLines.push(
                    '<p><strong>Lower / Upper</strong> ' + escapeHtmlFn(String(a.lower)) + ' / ' + escapeHtmlFn(String(a.upper)) + '</p>'
                );
                if (a.type) bodyLines.push('<p><strong>Type</strong> ' + escapeHtmlFn(a.type) + '</p>');
                if (a.source) bodyLines.push('<p><strong>Source</strong> ' + escapeHtmlFn(a.source) + '</p>');
                if (a.description) {
                    bodyLines.push(
                        '<p class="fn-airspace-detail-desc">' +
                            escapeHtmlFn(AirspaceNearby.htmlToPlainText(a.description)) +
                            '</p>'
                    );
                }
                content.insertAdjacentHTML(
                    'beforeend',
                    '<div class="fn-airspace-item category-' +
                        cls +
                        '">' +
                        '<div class="fn-airspace-item-header">' +
                        '<span class="fn-airspace-badge badge-' +
                        cls +
                        '">' +
                        escapeHtmlFn(a.category) +
                        '</span>' +
                        '<span class="fn-airspace-item-name">' +
                        escapeHtmlFn(a.name || a.designator) +
                        '</span>' +
                        '</div>' +
                        '<div class="fn-airspace-item-detail">' +
                        '<strong>' +
                        escapeHtmlFn(a.designator) +
                        '</strong>' +
                        distKm +
                        ' · Lower: ' +
                        escapeHtmlFn(String(a.lower)) +
                        ' · Upper: ' +
                        escapeHtmlFn(String(a.upper)) +
                        '</div>' +
                        '<div class="fn-airspace-item-body">' +
                        '<div class="fn-airspace-detail-body">' +
                        bodyLines.join('') +
                        '</div>' +
                        '<div class="fn-airspace-minimap" id="fnAirspaceMap-airspace-' +
                        i +
                        '"></div>' +
                        '</div></div>'
                );
            });
        }

        if (notams.length > 0) {
            content.insertAdjacentHTML(
                'beforeend',
                '<div class="fn-airspace-section-title">NOTAMs <span>(' + notams.length + ')</span></div>'
            );
            notams.forEach(function (n, i) {
                var dist = AirspaceNearby.haversineKm(lat, lng, n.lat, n.lng).toFixed(1);
                var validStart = formatNotamDateFn(n.startValidity);
                var validEnd = formatNotamDateFn(n.endValidity);
                var validStr = validStart + ' – ' + validEnd;
                var descText = (n.text || '').replace(/\s+/g, ' ');
                if (descText.length > 300) descText = descText.slice(0, 297) + '…';
                content.insertAdjacentHTML(
                    'beforeend',
                    '<div class="fn-airspace-item category-notam">' +
                        '<div class="fn-airspace-item-header">' +
                        '<span class="fn-airspace-badge badge-notam">NOTAM</span>' +
                        '<span class="fn-airspace-item-name">' +
                        escapeHtmlFn(n.id || 'NOTAM') +
                        '</span>' +
                        '</div>' +
                        '<div class="fn-airspace-item-detail">' +
                        dist +
                        ' km away' +
                        (n.radiusNm > 0 && n.radiusNm < 999 ? ' · Radius: ' + n.radiusNm + ' NM' : '') +
                        '<br>Valid: ' +
                        escapeHtmlFn(validStr) +
                        '<br>' +
                        escapeHtmlFn(descText) +
                        '</div>' +
                        '<div class="fn-airspace-item-body">' +
                        '<div class="fn-airspace-detail-body">' +
                        '<p><strong>Distance</strong> ' +
                        escapeHtmlFn(dist) +
                        ' km</p>' +
                        '<p><strong>Radius</strong> ' +
                        escapeHtmlFn(n.radiusNm > 0 && n.radiusNm < 999 ? n.radiusNm + ' NM' : '—') +
                        '</p>' +
                        '<p><strong>Valid</strong> ' +
                        escapeHtmlFn(validStart) +
                        ' – ' +
                        escapeHtmlFn(validEnd) +
                        '</p>' +
                        '<p class="fn-airspace-detail-notam-text">' +
                        escapeHtmlFn(n.text || '').replace(/\n/g, '<br>') +
                        '</p>' +
                        '</div>' +
                        '<div class="fn-airspace-minimap" id="fnAirspaceMap-notam-' +
                        i +
                        '"></div>' +
                        '</div></div>'
                );
            });
        }
    }

    function populateFnAirspaceMaps(lat, lng, notams, airspace) {
        destroyFnAirspaceMaps();
        if (typeof L === 'undefined' || typeof AirspaceNearby === 'undefined') return;

        var catColors = { FRZ: '#9333ea', Prohibited: '#991b1b', Restricted: '#dc2626', Danger: '#ca8a04' };

        airspace.forEach(function (a, i) {
            var el = document.getElementById('fnAirspaceMap-airspace-' + i);
            if (!el) return;
            var map = L.map(el, { zoomControl: false, attributionControl: false });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: true }).addTo(map);
            var overlay = L.layerGroup().addTo(map);
            if (a.geometry) {
                var gj = L.geoJSON(a.geometry, {
                    style: {
                        color: catColors[a.category] || '#dc2626',
                        weight: 2,
                        fillColor: catColors[a.category] || '#dc2626',
                        fillOpacity: 0.2
                    }
                });
                overlay.addLayer(gj);
                L.marker([lat, lng], { title: 'Location' }).addTo(overlay);
                var b = gj.getBounds();
                if (b.isValid()) {
                    b.extend([lat, lng]);
                    map.fitBounds(b.pad(0.12));
                } else {
                    map.setView([lat, lng], 11);
                }
            }
            fnAirspaceMaps.push({ map: map });
            setTimeout(function () {
                map.invalidateSize();
            }, 100);
        });

        notams.forEach(function (n, i) {
            var el = document.getElementById('fnAirspaceMap-notam-' + i);
            if (!el) return;
            var map = L.map(el, { zoomControl: false, attributionControl: false });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: true }).addTo(map);
            var overlay = L.layerGroup().addTo(map);
            L.marker([lat, lng], { title: 'Location' }).addTo(overlay);
            L.marker([n.lat, n.lng], { title: 'NOTAM centre' }).addTo(overlay);
            if (n.radiusNm > 0 && n.radiusNm < 999) {
                L.circle([n.lat, n.lng], {
                    radius: n.radiusNm * 1852,
                    color: '#dc2626',
                    weight: 2,
                    fillColor: '#dc2626',
                    fillOpacity: 0.12
                }).addTo(overlay);
            }
            var groupBounds = L.latLngBounds([lat, lng], [n.lat, n.lng]);
            if (groupBounds.isValid()) {
                map.fitBounds(groupBounds.pad(0.25));
            } else {
                map.setView([lat, lng], 10);
            }
            fnAirspaceMaps.push({ map: map });
            setTimeout(function () {
                map.invalidateSize();
            }, 100);
        });

        setTimeout(function () {
            fnAirspaceMaps.forEach(function (o) {
                try {
                    if (o.map) o.map.invalidateSize();
                } catch (e) {}
            });
        }, 350);
    }

    async function loadFnAirspaceTab() {
        if (typeof AirspaceNearby === 'undefined') {
            alert('Airspace data module not loaded.');
            return;
        }
        var ll = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (!ll) {
            alert('Location must include latitude and longitude (e.g. 51.05, -0.08).');
            return;
        }
        var r = readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = r;
        syncFnAirspaceIntroKm();
        destroyFnAirspaceMaps();
        var loading = document.getElementById('fnAirspaceLoading');
        var content = document.getElementById('fnAirspaceContent');
        if (loading) loading.classList.remove('hidden');
        try {
            var notams = await AirspaceNearby.fetchNearbyNotams(ll.lat, ll.lng, r);
            var air = await AirspaceNearby.fetchNearbyAirspace(ll.lat, ll.lng, r);
            fnLastNotams = notams;
            fnLastAirspace = air;
            fnAirspaceDataLoaded = true;
            if (content) renderFnAirspaceHtml(notams, air, ll.lat, ll.lng);
            setTimeout(function () {
                populateFnAirspaceMaps(ll.lat, ll.lng, notams, air);
            }, 50);
        } catch (e) {
            console.error('Flight Report airspace load failed:', e);
            alert('Failed to load airspace data.');
        } finally {
            if (loading) loading.classList.add('hidden');
        }
    }

    async function ensureFnAirspaceForPdf() {
        if (typeof AirspaceNearby === 'undefined' || typeof L === 'undefined') return;
        var ll = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (!ll) return;
        if (fnAirspaceMaps.length > 0) return;
        if (
            fnAirspaceDataLoaded &&
            fnLastNotams &&
            fnLastAirspace &&
            fnLastNotams.length + fnLastAirspace.length === 0
        ) {
            return;
        }
        var r = readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = r;
        syncFnAirspaceIntroKm();
        try {
            var notams = await AirspaceNearby.fetchNearbyNotams(ll.lat, ll.lng, r);
            var air = await AirspaceNearby.fetchNearbyAirspace(ll.lat, ll.lng, r);
            fnLastNotams = notams;
            fnLastAirspace = air;
            fnAirspaceDataLoaded = true;
            var c = document.getElementById('fnAirspaceContent');
            if (c) renderFnAirspaceHtml(notams, air, ll.lat, ll.lng);
            populateFnAirspaceMaps(ll.lat, ll.lng, notams, air);
            await new Promise(function (res) {
                setTimeout(res, 900);
            });
        } catch (e) {
            console.warn('Flight Report: PDF airspace prefetch failed', e);
        }
    }

    /** Center-crop a canvas to a square (same idea as PdfTheme.captureSquareMap). */
    function cropCanvasToSquare(srcCanvas) {
        var sw = srcCanvas.width;
        var sh = srcCanvas.height;
        var side = Math.min(sw, sh);
        var sx = Math.round((sw - side) / 2);
        var sy = Math.round((sh - side) / 2);
        var sq = document.createElement('canvas');
        sq.width = side;
        sq.height = side;
        sq.getContext('2d').drawImage(srcCanvas, sx, sy, side, side, 0, 0, side, side);
        return sq;
    }

    /** Plain-text explainer for PDF column (NOTAM / restriction details). */
    function buildAirspaceDetailPdfForRow(kind, lat, lng, a, n) {
        if (kind === 'airspace' && a) {
            var lines = [];
            lines.push(a.category + ' — ' + (a.name || a.designator));
            lines.push('Designator: ' + a.designator);
            lines.push('Lower / Upper: ' + a.lower + ' / ' + a.upper);
            if (a.type) lines.push('Type: ' + a.type);
            if (a.source) lines.push('Source: ' + a.source);
            if (a.description) {
                var d = AirspaceNearby.htmlToPlainText(a.description).replace(/\s+/g, ' ').trim();
                if (d.length > 650) d = d.slice(0, 647) + '…';
                lines.push('Description: ' + d);
            }
            return lines.join('\n');
        }
        if (kind === 'notam' && n) {
            var dist = AirspaceNearby.haversineKm(lat, lng, n.lat, n.lng).toFixed(1);
            var lines = [];
            lines.push('NOTAM ' + (n.id || '—'));
            lines.push('Distance: ' + dist + ' km from your location');
            if (n.radiusNm > 0 && n.radiusNm < 999) lines.push('Radius: ' + n.radiusNm + ' NM');
            lines.push('Valid: ' + formatNotamDateFn(n.startValidity) + ' – ' + formatNotamDateFn(n.endValidity));
            var txt = (n.text || '').replace(/\s+/g, ' ').trim();
            if (txt.length > 1100) txt = txt.slice(0, 1097) + '…';
            lines.push('Text: ' + txt);
            return lines.join('\n');
        }
        return '—';
    }

    async function appendAirspacePdfPages(doc) {
        if (typeof html2canvas === 'undefined' || typeof doc.autoTable !== 'function') return;
        var ll = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (!ll) return;
        await ensureFnAirspaceForPdf();
        var notams = fnLastNotams || [];
        var airspace = fnLastAirspace || [];
        if (notams.length === 0 && airspace.length === 0) return;

        var items = [];
        airspace.forEach(function (a, i) {
            items.push({ kind: 'airspace', index: i, a: a, n: null });
        });
        notams.forEach(function (n, i) {
            items.push({ kind: 'notam', index: i, a: null, n: n });
        });

        var MAP_THUMB_MM = 26;
        var MAP_COL_W = 34;
        var pdfMapEntries = [];

        for (var j = 0; j < items.length; j++) {
            var id = 'fnAirspaceMap-' + items[j].kind + '-' + items[j].index;
            var el = document.getElementById(id);
            if (!el) {
                pdfMapEntries.push(null);
                continue;
            }
            if (fnAirspaceMaps[j] && fnAirspaceMaps[j].map) {
                try {
                    fnAirspaceMaps[j].map.invalidateSize();
                } catch (e) {}
            }
            await new Promise(function (r) {
                setTimeout(r, 150);
            });
            try {
                var h2cOpts =
                    typeof MapCapture !== 'undefined' && MapCapture.html2canvasOptions
                        ? MapCapture.html2canvasOptions('#f5f6f8', { scale: 1.5 })
                        : {
                              useCORS: true,
                              allowTaint: false,
                              scale: 1.5,
                              logging: false,
                              backgroundColor: '#f5f6f8'
                          };
                var canvas = await html2canvas(el, h2cOpts);
                var square = cropCanvasToSquare(canvas);
                pdfMapEntries.push({
                    url: square.toDataURL('image/png'),
                    pxW: square.width,
                    pxH: square.height
                });
            } catch (e) {
                console.warn('Flight Report: airspace map PDF capture failed', e);
                pdfMapEntries.push(null);
            }
        }

        var body = items.map(function (it) {
            var txt =
                it.kind === 'airspace'
                    ? buildAirspaceDetailPdfForRow('airspace', ll.lat, ll.lng, it.a, null)
                    : buildAirspaceDetailPdfForRow('notam', ll.lat, ll.lng, null, it.n);
            return ['', txt];
        });

        var ts = PdfTheme.tableStyles();
        var tableW = PdfTheme.pageWidthMm() - 20;
        var detailColW = tableW - MAP_COL_W;

        PdfTheme.newPage(doc);
        PdfTheme.addHeader(doc, 'Airspace & NOTAMs (' + fnAirspaceRadiusKm + ' km)', false);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(85, 85, 85);
        doc.text('One row per restriction or NOTAM: map (left) and full details (right). Maps are indicative.', 10, 14);

        doc.autoTable({
            startY: 18,
            head: [['Map', 'Details']],
            body: body,
            tableWidth: tableW,
            columnStyles: {
                0: { cellWidth: MAP_COL_W },
                1: { cellWidth: detailColW }
            },
            headStyles: Object.assign({}, ts.headStyles, {
                minCellHeight: 6,
                valign: 'middle'
            }),
            bodyStyles: Object.assign({}, ts.bodyStyles, { valign: 'top' }),
            alternateRowStyles: ts.alternateRowStyles,
            styles: Object.assign({}, ts.styles, { minCellHeight: 26, valign: 'top' }),
            margin: ts.margin,
            tableLineColor: ts.tableLineColor,
            tableLineWidth: ts.tableLineWidth,
            didDrawCell: function (data) {
                if (data.section !== 'body' || data.column.index !== 0) return;
                var entry = pdfMapEntries[data.row.index];
                if (!entry || !entry.url) return;
                var pad = 1;
                var cellH = data.cell.height > 1 ? data.cell.height : 26;
                var maxBox = Math.min(
                    MAP_THUMB_MM,
                    data.cell.width - 2 * pad,
                    cellH - 2 * pad
                );
                if (maxBox <= 0) return;
                var dims = mapImageSizeMm(entry.pxW, entry.pxH, maxBox, maxBox);
                var innerW = data.cell.width - 2 * pad;
                var innerH = data.cell.height - 2 * pad;
                var drawX = data.cell.x + pad + (innerW - dims.w) / 2;
                var drawY = data.cell.y + pad + (innerH - dims.h) / 2;
                doc.addImage(entry.url, 'PNG', drawX, drawY, dims.w, dims.h);
            }
        });
    }

    /** Grow/shrink Conditions textarea to fit content (fetch + typing); cap height so very long notes scroll inside. */
    function autoResizeConditionsTextarea() {
        var ta = document.getElementById('fnWeather');
        if (!ta) return;
        ta.style.height = 'auto';
        var cap = Math.min(window.innerHeight * 0.85, 1400);
        var h = ta.scrollHeight;
        if (h > cap) {
            ta.style.height = cap + 'px';
            ta.style.overflowY = 'auto';
        } else {
            ta.style.height = h + 'px';
            ta.style.overflowY = 'hidden';
        }
    }

    function trimVal(id) {
        var el = document.getElementById(id);
        if (!el) return '';
        return String(el.value || '').trim();
    }

    function dash(s) {
        return s ? s : '—';
    }

    /** HTML date input is yyyy-mm-dd; exports show dd-mm-yyyy. */
    function formatDateForExportDdMmYyyy(isoOrEmpty) {
        var s = String(isoOrEmpty || '').trim();
        if (!s) return '';
        var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return m[3] + '-' + m[2] + '-' + m[1];
        return s;
    }

    /** Fit image into a max box (mm) without stretching — preserves aspect ratio. */
    function mapImageSizeMm(canvasW, canvasH, maxWMm, maxHMm) {
        if (!canvasW || !canvasH) return { w: maxWMm, h: maxHMm };
        var ar = canvasW / canvasH;
        var w = maxWMm;
        var h = w / ar;
        if (h > maxHMm) {
            h = maxHMm;
            w = h * ar;
        }
        return { w: w, h: h };
    }

    /** Same map centre as Flight Report mini-map — for email (mailto is plain text only; no embedded images). */
    function openStreetMapLink(lat, lng) {
        return (
            'https://www.openstreetmap.org/?mlat=' +
            encodeURIComponent(lat) +
            '&mlon=' +
            encodeURIComponent(lng) +
            '#map=16/' +
            lat +
            '/' +
            lng
        );
    }

    /**
     * Plain-text block for email body and PDF source of truth.
     */
    function buildNotesPlainText() {
        var lines = [];
        lines.push('AirPlot v3 — Flight Report');
        lines.push('');

        lines.push('Date: ' + dash(formatDateForExportDdMmYyyy(trimVal('fnDate'))));
        lines.push('Time: ' + dash(trimVal('fnTime')));
        lines.push('Location: ' + dash(trimVal('fnLocation')));
        var llPlain = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (llPlain) {
            lines.push('Map (OpenStreetMap): ' + openStreetMapLink(llPlain.lat, llPlain.lng));
        }
        lines.push('Reference: ' + dash(trimVal('fnReference')));
        lines.push('Deconflictions: ' + dash(trimVal('fnDeconflictions')));
        lines.push('RP 1: ' + dash(trimVal('fnRp1')));
        lines.push('RP 2: ' + dash(trimVal('fnRp2')));
        lines.push('UAS: ' + dash(trimVal('fnUas')));

        lines.push('Battery 1: ' + dash(trimVal('fnBattery1')));
        lines.push('Battery 1 time: ' + dash(trimVal('fnBattery1Time')));
        lines.push('Battery 2: ' + dash(trimVal('fnBattery2')));
        lines.push('Battery 2 time: ' + dash(trimVal('fnBattery2Time')));
        lines.push('Battery 3: ' + dash(trimVal('fnBattery3')));
        lines.push('Battery 3 time: ' + dash(trimVal('fnBattery3Time')));
        lines.push('Battery 4: ' + dash(trimVal('fnBattery4')));
        lines.push('Battery 4 time: ' + dash(trimVal('fnBattery4Time')));

        lines.push('ALoS RAG Notes: ' + dash(trimVal('fnAlosRagNotes').replace(/\n/g, ' ')));
        lines.push('Weather: ' + dash(trimVal('fnWeather').replace(/\n/g, ' ')));
        lines.push('Airspace: ' + fnAirspaceSummaryForExport());
        lines.push('');
        lines.push('Notes:');
        lines.push(trimVal('fnNotes') || '—');

        return lines.join('\n');
    }

    function tableRowsForPdf() {
        var alos = trimVal('fnAlosRagNotes');
        var w = trimVal('fnWeather');
        var llPdf = parseLatLngFromLocationString(trimVal('fnLocation'));
        var mapLinkRow = llPdf
            ? ['Map (OpenStreetMap)', openStreetMapLink(llPdf.lat, llPdf.lng)]
            : ['Map (OpenStreetMap)', '—'];
        return [
            ['Date', dash(formatDateForExportDdMmYyyy(trimVal('fnDate')))],
            ['Time', dash(trimVal('fnTime'))],
            ['Location', dash(trimVal('fnLocation'))],
            mapLinkRow,
            ['Reference', dash(trimVal('fnReference'))],
            ['Deconflictions', dash(trimVal('fnDeconflictions'))],
            ['RP 1', dash(trimVal('fnRp1'))],
            ['RP 2', dash(trimVal('fnRp2'))],
            ['UAS', dash(trimVal('fnUas'))],
            ['Battery 1', dash(trimVal('fnBattery1'))],
            ['Battery 1 time', dash(trimVal('fnBattery1Time'))],
            ['Battery 2', dash(trimVal('fnBattery2'))],
            ['Battery 2 time', dash(trimVal('fnBattery2Time'))],
            ['Battery 3', dash(trimVal('fnBattery3'))],
            ['Battery 3 time', dash(trimVal('fnBattery3Time'))],
            ['Battery 4', dash(trimVal('fnBattery4'))],
            ['Battery 4 time', dash(trimVal('fnBattery4Time'))],
            ['ALoS RAG Notes', alos || '—'],
            ['Weather', w || '—'],
            ['Airspace', fnAirspaceSummaryForExport()],
            ['Notes', trimVal('fnNotes') || '—']
        ];
    }

    // ---- Open-Meteo (same API as js/weather.js — Flight Weather) ----

    var OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
    var HOURLY_PARAMS =
        'wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_120m,wind_direction_120m,visibility,cloud_cover,cloud_cover_low,precipitation,precipitation_probability,temperature_2m';
    var GUST_120M_MULTIPLIER = 1.3;
    var WX_MODEL_LABELS = {
        auto: 'Best match',
        ecmwf_ifs: 'ECMWF IFS (EU)',
        gfs_seamless: 'GFS (NOAA, US)',
        ukmo_seamless: 'UK Met Office',
        gem_global: 'GEM (Canada)'
    };

    function parseLatLngFromLocationString(s) {
        if (!s || !String(s).trim()) return null;
        var m = String(s).match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
        if (!m) return null;
        var lat = parseFloat(m[1]);
        var lng = parseFloat(m[2]);
        if (isNaN(lat) || isNaN(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        return { lat: lat, lng: lng };
    }

    function getTargetTimeMsFromForm() {
        var d = trimVal('fnDate');
        var t = trimVal('fnTime');
        if (d && t) {
            var ms = new Date(d + 'T' + t + ':00').getTime();
            if (!isNaN(ms)) return ms;
        }
        return null;
    }

    function directionToCardinal(deg) {
        if (deg == null || isNaN(deg)) return '—';
        var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        var idx = Math.round(((deg % 360) / 22.5)) % 16;
        return dirs[idx];
    }

    function formatVisibility(m) {
        if (m == null || isNaN(m)) return '—';
        if (m >= 10000) return (m / 1000).toFixed(1) + ' km';
        return Math.round(m) + ' m';
    }

    function formatWindRow(speed, dir) {
        if (speed == null || isNaN(speed)) return '—';
        return Math.round(speed) + ' km/h ' + directionToCardinal(dir);
    }

    /**
     * RAG suitability for heavier enterprise multi-rotor ops (~12 m/s wind class), thermal + optical payloads.
     * Uses max(10 m, 120 m) sustained wind and max(10 m gusts, estimated 120 m gusts) so higher-level conditions count.
     * Open-Meteo wind values are km/h.
     */
    function deriveSuitability(data) {
        var w10 = data.wind_speed_10m != null ? data.wind_speed_10m : 0;
        var w120 = data.wind_speed_120m != null ? data.wind_speed_120m : w10;
        var sustained = Math.max(w10, w120);
        var g10 = data.wind_gusts_10m != null ? data.wind_gusts_10m : sustained;
        var g120Est = data.wind_speed_120m != null ? data.wind_speed_120m * GUST_120M_MULTIPLIER : g10;
        var gusts = Math.max(g10, g120Est);
        var vis = data.visibility != null ? data.visibility : 10000;
        var precip = data.precipitation != null ? data.precipitation : 0;

        if (sustained > 38 || gusts > 47 || vis < 4000 || precip > 1.5) {
            return {
                level: 'poor',
                text:
                    'Red: conditions exceed safe margins for typical enterprise-class multi-rotor wind limits and visibility; postpone or re-plan.'
            };
        }
        if (sustained > 26 || gusts > 34 || vis < 5500 || precip > 0) {
            return {
                level: 'caution',
                text:
                    'Amber: marginal for heavier multi-rotor thermal and optical work; keep flights shorter, allow extra height margin, watch for stronger gusts higher up, and keep battery in reserve.'
            };
        }
        return {
            level: 'good',
                text:
                'Green: within usual operating margins for DJI enterprise-class aircraft; still check wind and visibility on site before take-off.'
        };
    }

    function deriveSummaryText(hourlySlice, suitability) {
        if (!hourlySlice || !hourlySlice.hourly) return '';
        var h = hourlySlice.hourly;
        var start = hourlySlice.startIdx;
        var timeLen = (h.time && h.time.length) || 0;
        var count = Math.min(12, timeLen - start);
        if (count <= 0) return suitability.text;

        function sliceFilter(key, pred) {
            var arr = h[key] || [];
            var seg = arr.slice(start, start + count);
            var out = [];
            for (var i = 0; i < seg.length; i++) {
                if (pred(seg[i])) out.push(seg[i]);
            }
            return out;
        }

        var w10 = sliceFilter('wind_speed_10m', function (v) {
            return v != null;
        });
        var gusts10 = sliceFilter('wind_gusts_10m', function (v) {
            return v != null;
        });
        var w120 = sliceFilter('wind_speed_120m', function (v) {
            return v != null;
        });
        var vis = sliceFilter('visibility', function (v) {
            return v != null;
        });
        var precip = sliceFilter('precipitation', function (v) {
            return v != null && v > 0;
        });

        var w10Min = w10.length ? Math.min.apply(Math, w10) : null;
        var w10Max = w10.length ? Math.max.apply(Math, w10) : null;
        var gustsMax = gusts10.length ? Math.max.apply(Math, gusts10) : null;
        var w120Max = w120.length ? Math.max.apply(Math, w120) : null;
        var visMin = vis.length ? Math.min.apply(Math, vis) : null;
        var visMax = vis.length ? Math.max.apply(Math, vis) : null;

        var parts = [];
        if (w10Min != null && w10Max != null) {
            if (w10Min === w10Max) parts.push('Sustained 10 m: ' + Math.round(w10Max) + ' km/h');
            else parts.push('Sustained 10 m: ' + Math.round(w10Min) + '–' + Math.round(w10Max) + ' km/h');
        }
        if (gustsMax != null) parts.push('Gusts 10 m: up to ' + Math.round(gustsMax) + ' km/h');
        if (w120Max != null) {
            parts.push('Sustained 120 m: up to ' + Math.round(w120Max) + ' km/h');
            parts.push('Gusts 120 m (est.): up to ' + Math.round(w120Max * GUST_120M_MULTIPLIER) + ' km/h');
        }
        if (visMin != null && visMax != null) {
            var vMin = visMin >= 10000 ? (visMin / 1000).toFixed(1) + ' km' : Math.round(visMin) + ' m';
            var vMax = visMax >= 10000 ? (visMax / 1000).toFixed(1) + ' km' : Math.round(visMax) + ' m';
            if (vMin === vMax) parts.push('Visibility: ' + vMax);
            else parts.push('Visibility: ' + vMin + ' to ' + vMax);
        }
        if (precip.length > 0) {
            var total = 0;
            for (var pi = 0; pi < precip.length; pi++) total += precip[pi];
            parts.push('Precipitation: ' + Math.round(total * 10) / 10 + ' mm expected');
        } else parts.push('No precipitation expected');

        return parts.join('. ') + '.';
    }

    function fetchOpenMeteoForPoint(lat, lng, targetTimestampMs) {
        var params = new URLSearchParams({
            latitude: lat.toFixed(4),
            longitude: lng.toFixed(4),
            hourly: HOURLY_PARAMS,
            forecast_days: '16',
            timezone: 'auto'
        });
        return fetch(OPEN_METEO_BASE + '?' + params.toString())
            .then(function (r) {
                if (!r.ok) throw new Error('Weather service unavailable');
                return r.json();
            })
            .then(function (data) {
                if (!data.hourly || !data.hourly.time || !data.hourly.time.length) {
                    throw new Error('No weather data returned');
                }
                var times = data.hourly.time;
                var useNow = targetTimestampMs === null || isNaN(targetTimestampMs);
                var bestIdx = 0;
                if (useNow) {
                    var now = Date.now();
                    var startIdx = 0;
                    for (var i = 0; i < times.length; i++) {
                        var t = new Date(times[i]).getTime();
                        if (t <= now) startIdx = i;
                    }
                    bestIdx = startIdx;
                } else {
                    var target = targetTimestampMs;
                    var bestDiff = Infinity;
                    for (var j = 0; j < times.length; j++) {
                        var tj = new Date(times[j]).getTime();
                        var diff = Math.abs(tj - target);
                        if (diff < bestDiff) {
                            bestDiff = diff;
                            bestIdx = j;
                        }
                    }
                }
                var weatherData = {};
                var keys = Object.keys(data.hourly);
                for (var k = 0; k < keys.length; k++) {
                    var key = keys[k];
                    if (key !== 'time' && Array.isArray(data.hourly[key])) {
                        weatherData[key] = data.hourly[key][bestIdx];
                    }
                }
                var displayTime = times[bestIdx];
                var hourlySlice = { startIdx: bestIdx, count: 12, hourly: data.hourly };
                return {
                    weatherData: weatherData,
                    displayTime: displayTime,
                    hourlySlice: hourlySlice,
                    model: 'auto'
                };
            });
    }

    function buildWeatherReportText(data, displayTime, hourlySlice, model, lat, lng, usedTargetTime) {
        var suitability = deriveSuitability(data);
        var summaryText = deriveSummaryText(hourlySlice, suitability);
        var modelLabel = WX_MODEL_LABELS[model] || model;

        var gusts = data.wind_gusts_10m;
        var gustsStr = gusts != null ? Math.round(gusts) + ' km/h' : '—';
        var wind120Str = formatWindRow(data.wind_speed_120m, data.wind_direction_120m);
        var gusts120 =
            data.wind_speed_120m != null ? Math.round(data.wind_speed_120m * GUST_120M_MULTIPLIER) + ' km/h' : '—';

        var cloudTotal = data.cloud_cover;
        var cloudLow = data.cloud_cover_low;
        var cloudStr = '—';
        if (cloudTotal != null) {
            cloudStr =
                cloudLow != null
                    ? Math.round(cloudTotal) + '% total, ' + Math.round(cloudLow) + '% low'
                    : Math.round(cloudTotal) + '%';
        }

        var precip = data.precipitation;
        var precipProb = data.precipitation_probability;
        var precipStr = '—';
        if (precip != null) {
            precipStr =
                precipProb != null
                    ? Math.round(precip * 10) / 10 + ' mm (' + Math.round(precipProb) + '% chance)'
                    : Math.round(precip * 10) / 10 + ' mm';
        }

        var temp = data.temperature_2m;
        var tempStr = temp != null ? Math.round(temp) + ' °C' : '—';

        var lines = [];
        lines.push('Open-Meteo forecast (Flight Weather source)');
        lines.push('Coordinates: ' + lat.toFixed(6) + ', ' + lng.toFixed(6));
        lines.push(
            'Forecast hour: ' +
                (displayTime || '—') +
                (usedTargetTime ? ' (from Date/Time fields)' : ' (current time)')
        );
        lines.push('Model: ' + modelLabel);
        lines.push('');
        lines.push('Summary: ' + suitability.text);
        if (summaryText) lines.push(summaryText);
        lines.push('');
        lines.push('10 m wind: ' + formatWindRow(data.wind_speed_10m, data.wind_direction_10m));
        lines.push('10 m gusts: ' + gustsStr);
        lines.push('120 m wind: ' + wind120Str);
        lines.push('120 m gusts (est.): ' + gusts120);
        lines.push('Visibility: ' + formatVisibility(data.visibility));
        lines.push('Cloud cover: ' + cloudStr);
        lines.push('Precipitation: ' + precipStr);
        lines.push('Temperature (2 m): ' + tempStr);
        lines.push('');
        lines.push('Data: Open-Meteo https://open-meteo.com/ (CC BY 4.0)');
        return lines.join('\n');
    }

    function setWeatherFetchStatus(message, kind) {
        var el = document.getElementById('fnWeatherFetchStatus');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'fn-weather-fetch-status';
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    async function onWeatherFetchClick() {
        var btn = document.getElementById('fnWeatherFetchBtn');
        var ta = document.getElementById('fnWeather');
        if (!ta) return;
        var loc = trimVal('fnLocation');
        var parsed = parseLatLngFromLocationString(loc);
        if (!parsed) {
            setWeatherFetchStatus(
                'Set Location to coordinates first (e.g. tap Use current GPS).',
                'error'
            );
            return;
        }
        var targetMs = getTargetTimeMsFromForm();
        var usedTarget = targetMs != null && !isNaN(targetMs);

        setWeatherFetchStatus('Fetching…', '');
        if (btn) btn.disabled = true;
        try {
            var result = await fetchOpenMeteoForPoint(parsed.lat, parsed.lng, targetMs);
            var block = buildWeatherReportText(
                result.weatherData,
                result.displayTime,
                result.hourlySlice,
                result.model,
                parsed.lat,
                parsed.lng,
                usedTarget
            );
            var existing = trimVal('fnWeather');
            var sep = '\n\n--- Open-Meteo — ' + result.displayTime + ' ---\n';
            if (existing) {
                ta.value = existing + sep + block;
            } else {
                ta.value = block;
            }
            setWeatherFetchStatus('Report added to Conditions.', 'ok');
            autoResizeConditionsTextarea();
            saveFlightNotesDraft();
        } catch (err) {
            console.error('Flight Report weather fetch failed:', err);
            setWeatherFetchStatus(err && err.message ? err.message : 'Failed to fetch weather.', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function setNowDateTime() {
        var now = new Date();
        var dateEl = document.getElementById('fnDate');
        var timeEl = document.getElementById('fnTime');
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var d = String(now.getDate()).padStart(2, '0');
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        if (dateEl) dateEl.value = y + '-' + m + '-' + d;
        if (timeEl) timeEl.value = hh + ':' + mm;
        saveFlightNotesDraft();
    }

    function setTimeInputNow(inputId) {
        var el = document.getElementById(inputId);
        if (!el) return;
        var now = new Date();
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        el.value = hh + ':' + mm;
        saveFlightNotesDraft();
    }

    function setGpsStatus(message, kind) {
        var el = document.getElementById('fnGpsStatus');
        if (!el) return;
        el.textContent = message || '';
        el.classList.remove('fn-gps-error', 'fn-gps-ok');
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    function destroyMiniMap() {
        if (miniMap) {
            miniMap.remove();
            miniMap = null;
        }
    }

    function hideLocationResult() {
        var wrap = document.getElementById('fnLocationResult');
        if (wrap) wrap.hidden = true;
        destroyMiniMap();
        var pc = document.getElementById('fnPostcodeDisplay');
        if (pc) pc.textContent = '—';
    }

    /**
     * Reverse geocode via OpenStreetMap Nominatim (postcode where available).
     * See https://operations.osmfoundation.org/policies/nominatim/
     */
    function reversePostcode(lat, lng) {
        var url =
            'https://nominatim.openstreetmap.org/reverse?lat=' +
            encodeURIComponent(lat) +
            '&lon=' +
            encodeURIComponent(lng) +
            '&format=json&addressdetails=1';
        return fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            mode: 'cors'
        })
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .then(function (data) {
                if (!data || !data.address) return null;
                var a = data.address;
                return a.postcode || a.postal_code || null;
            })
            .catch(function () {
                return null;
            });
    }

    function initMiniMap(lat, lng) {
        destroyMiniMap();
        var el = document.getElementById('fnMiniMap');
        if (!el || typeof L === 'undefined') return;
        miniMap = L.map(el, {
            zoomControl: true,
            attributionControl: true
        }).setView([lat, lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
            maxZoom: 19,
            crossOrigin: true
        }).addTo(miniMap);
        L.marker([lat, lng]).addTo(miniMap);
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (miniMap) miniMap.invalidateSize();
            });
        });
        setTimeout(function () {
            if (miniMap) miniMap.invalidateSize();
        }, 200);
    }

    function postcodeFromNominatimHit(hit) {
        if (!hit || !hit.address) return null;
        var a = hit.address;
        return a.postcode || a.postal_code || null;
    }

    /**
     * OpenStreetMap Nominatim forward search (same policy as reverse geocode).
     */
    function nominatimSearch(query) {
        var url =
            'https://nominatim.openstreetmap.org/search?q=' +
            encodeURIComponent(query) +
            '&format=json&limit=1&addressdetails=1';
        return fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            mode: 'cors'
        })
            .then(function (res) {
                if (!res.ok) throw new Error('Search failed');
                return res.json();
            })
            .then(function (arr) {
                if (!arr || !arr.length) return null;
                return arr[0];
            });
    }

    /**
     * Show map, postcode line, and location field after coordinates are known (GPS or search).
     * @param {string|null} postcodeHint - if set, skips reverse geocode lookup
     */
    function showLocationResolved(lat, lng, postcodeHint, okMessage) {
        var input = document.getElementById('fnLocation');
        var wrap = document.getElementById('fnLocationResult');
        var pcDisp = document.getElementById('fnPostcodeDisplay');
        var loc = lat.toFixed(6) + ', ' + lng.toFixed(6);
        if (wrap) wrap.hidden = false;
        if (pcDisp) pcDisp.textContent = postcodeHint != null ? postcodeHint : '…';
        if (input) {
            input.value = postcodeHint != null ? loc + ' · Postcode: ' + postcodeHint : loc;
        }
        saveFlightNotesDraft();
        setTimeout(function () {
            initMiniMap(lat, lng);
        }, 0);
        if (postcodeHint != null) {
            setGpsStatus(okMessage, 'ok');
        } else {
            setGpsStatus('Looking up postcode…', '');
            reversePostcode(lat, lng).then(function (pc) {
                if (pcDisp) pcDisp.textContent = pc || '—';
                if (input && pc) {
                    input.value = loc + ' · Postcode: ' + pc;
                }
                setGpsStatus(okMessage, 'ok');
                saveFlightNotesDraft();
            });
        }
    }

    function onSearchLocationClick() {
        var q = trimVal('fnLocation');
        if (!q) {
            setGpsStatus('Enter a postcode, address, or place name to search.', 'error');
            return;
        }
        var btn = document.getElementById('fnSearchLocationBtn');
        if (btn) btn.disabled = true;
        setGpsStatus('Searching…', '');
        nominatimSearch(q)
            .then(function (hit) {
                if (btn) btn.disabled = false;
                if (!hit) {
                    setGpsStatus('No results found. Try a different search.', 'error');
                    return;
                }
                var lat = parseFloat(hit.lat);
                var lng = parseFloat(hit.lon);
                if (isNaN(lat) || isNaN(lng)) {
                    setGpsStatus('Invalid result from search.', 'error');
                    return;
                }
                var pc = postcodeFromNominatimHit(hit);
                showLocationResolved(lat, lng, pc, 'Location updated from search.');
            })
            .catch(function () {
                if (btn) btn.disabled = false;
                setGpsStatus('Search failed. Check your connection and try again.', 'error');
            });
    }

    function onGpsClick() {
        if (!navigator.geolocation) {
            setGpsStatus('Geolocation is not available in this browser.', 'error');
            return;
        }
        // Secure context: HTTPS or localhost — required for geolocation in most browsers.
        var btn = document.getElementById('fnGpsBtn');
        if (btn) btn.disabled = true;
        setGpsStatus('Getting location…', '');

        navigator.geolocation.getCurrentPosition(
            function (pos) {
                var lat = pos.coords.latitude;
                var lng = pos.coords.longitude;
                if (btn) btn.disabled = false;
                showLocationResolved(lat, lng, null, 'Location updated from GPS.');
            },
            function (err) {
                hideLocationResult();
                var msg = 'Could not get location.';
                if (err && err.code === 1) msg = 'Location permission denied.';
                else if (err && err.code === 2) msg = 'Location unavailable.';
                else if (err && err.code === 3) msg = 'Location request timed out.';
                setGpsStatus(msg, 'error');
                if (btn) btn.disabled = false;
            },
            GPS_OPTIONS
        );
    }

    function emailSubject() {
        var d = formatDateForExportDdMmYyyy(trimVal('fnDate'));
        return d ? 'Flight Report — ' + d : 'Flight Report';
    }

    async function onEmailClick() {
        var text = buildNotesPlainText();
        var subj = emailSubject();
        var shortBody =
            'Your flight report is on the clipboard — paste into the email body below. (The full text was too long to put in the mail link automatically.)';

        if (text.length > MAILTO_BODY_MAX) {
            try {
                await navigator.clipboard.writeText(text);
                window.location.href =
                    'mailto:?subject=' +
                    encodeURIComponent(subj) +
                    '&body=' +
                    encodeURIComponent(shortBody);
            } catch (e) {
                alert(
                    'Could not copy the report to the clipboard. Try shortening the text or copy it manually from the page.'
                );
            }
            return;
        }

        window.location.href =
            'mailto:?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(text);
    }

    /**
     * Rasterise the Flight Report Leaflet mini-map for PDF (same idea as PdfTheme.captureSquareMap).
     */
    async function tryCaptureMiniMapPng() {
        var mapEl = document.getElementById('fnMiniMap');
        if (!mapEl || !miniMap || typeof html2canvas === 'undefined') return null;
        await new Promise(function (resolve) {
            setTimeout(resolve, 500);
        });
        if (miniMap) miniMap.invalidateSize();
        try {
            var capBg = document.body.classList.contains('fn-light-theme') ? '#e8eaed' : '#1a1a2e';
            var h2cMini =
                typeof MapCapture !== 'undefined' && MapCapture.html2canvasOptions
                    ? MapCapture.html2canvasOptions(capBg, { scale: 2 })
                    : {
                          useCORS: true,
                          allowTaint: false,
                          backgroundColor: capBg,
                          scale: 2,
                          logging: false
                      };
            var canvas = await html2canvas(mapEl, h2cMini);
            return {
                dataUrl: canvas.toDataURL('image/png'),
                width: canvas.width,
                height: canvas.height
            };
        } catch (e) {
            console.warn('Flight Report: map screenshot failed', e);
            return null;
        }
    }

    function isFlightNotesExportLightTheme() {
        var el = document.querySelector('input[name="fnExportTheme"]:checked');
        return !!(el && el.value === 'light');
    }

    async function onPdfClick() {
        var btn = document.getElementById('fnPdfBtn');
        var orig = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating…';
        }

        try {
            if (typeof PdfTheme === 'undefined') {
                throw new Error('PDF library not loaded');
            }

            PdfTheme.setLight(isFlightNotesExportLightTheme());
            await PdfTheme.loadLogo();

            var ts = PdfTheme.tableStyles();
            var doc = PdfTheme.createDoc();
            PdfTheme.addHeader(doc, 'Flight Report', true);

            var startY = 26;
            var mapShot = await tryCaptureMiniMapPng();
            if (mapShot && mapShot.dataUrl) {
                var maxW = 100;
                var maxH = 100;
                var dims = mapImageSizeMm(mapShot.width, mapShot.height, maxW, maxH);
                var pageW = PdfTheme.pageWidthMm();
                var mapX = (pageW - dims.w) / 2;
                doc.addImage(mapShot.dataUrl, 'PNG', mapX, startY, dims.w, dims.h);
                startY = startY + dims.h + 4;
            }

            var body = tableRowsForPdf();
            var tableW = PdfTheme.pageWidthMm() - 20;
            var fieldColW = 42;
            doc.autoTable({
                startY: startY,
                head: [['Field', 'Details']],
                body: body,
                tableWidth: tableW,
                columnStyles: {
                    0: { cellWidth: fieldColW },
                    1: { cellWidth: tableW - fieldColW }
                },
                ...ts
            });

            await appendAirspacePdfPages(doc);

            PdfTheme.addAllFooters(doc);

            var datePart =
                formatDateForExportDdMmYyyy(trimVal('fnDate')) ||
                formatDateForExportDdMmYyyy(new Date().toISOString().slice(0, 10));
            doc.save('Flight_Report_' + datePart + '.pdf');
        } catch (err) {
            console.error('Flight Report PDF export failed:', err);
            alert('Failed to export PDF: ' + (err && err.message ? err.message : 'Unknown error'));
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = orig || 'Export PDF';
            }
        }
    }

    function clearWeatherFetchStatus() {
        var wfs = document.getElementById('fnWeatherFetchStatus');
        if (!wfs) return;
        wfs.textContent = '';
        wfs.className = 'fn-weather-fetch-status';
    }

    function openClearModal() {
        var m = document.getElementById('fnClearModal');
        if (!m) return;
        m.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        var confirmBtn = document.getElementById('fnClearModalConfirm');
        if (confirmBtn) confirmBtn.focus();
    }

    function closeClearModal() {
        var m = document.getElementById('fnClearModal');
        if (m) m.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function clearEntireForm() {
        destroyFnAirspaceMaps();
        fnLastNotams = null;
        fnLastAirspace = null;
        fnAirspaceDataLoaded = false;
        var ac = document.getElementById('fnAirspaceContent');
        if (ac) ac.innerHTML = '';
        var al = document.getElementById('fnAirspaceLoading');
        if (al) al.classList.add('hidden');
        var form = document.getElementById('flightReportForm');
        if (form) form.reset();
        syncFnAirspaceIntroKm();
        var ta = document.getElementById('fnWeather');
        if (ta) {
            ta.style.height = '';
            ta.style.overflowY = '';
        }
        hideLocationResult();
        setGpsStatus('', '');
        clearWeatherFetchStatus();
        clearFlightNotesDraftStorage();
        closeClearModal();
        autoResizeConditionsTextarea();
    }

    function init() {
        function syncPageThemeFromRadios() {
            var el = document.querySelector('input[name="fnPageTheme"]:checked');
            var light = !!(el && el.value === 'light');
            document.body.classList.toggle('fn-light-theme', light);
            try {
                localStorage.setItem('fnLightTheme', light ? '1' : '0');
            } catch (e) {}
        }

        var pageThemeInputs = document.querySelectorAll('input[name="fnPageTheme"]');
        if (pageThemeInputs.length) {
            try {
                if (localStorage.getItem('fnLightTheme') === '1') {
                    var rLight = document.querySelector('input[name="fnPageTheme"][value="light"]');
                    if (rLight) rLight.checked = true;
                } else {
                    var rDark = document.querySelector('input[name="fnPageTheme"][value="dark"]');
                    if (rDark) rDark.checked = true;
                }
            } catch (e) {}
            syncPageThemeFromRadios();
            pageThemeInputs.forEach(function (inp) {
                inp.addEventListener('change', syncPageThemeFromRadios);
            });
        }

        loadFlightNotesDraft();
        syncFnAirspaceIntroKm();

        var fnAirspaceRefresh = document.getElementById('fnAirspaceRefreshBtn');
        var fnAirspaceRadius = document.getElementById('fnAirspaceRadiusKm');
        if (fnAirspaceRefresh) fnAirspaceRefresh.addEventListener('click', loadFnAirspaceTab);
        if (fnAirspaceRadius) {
            fnAirspaceRadius.addEventListener('change', function () {
                syncFnAirspaceIntroKm();
                scheduleFlightNotesDraftSave();
            });
        }

        var nowBtn = document.getElementById('fnNowBtn');
        var searchLocationBtn = document.getElementById('fnSearchLocationBtn');
        var gpsBtn = document.getElementById('fnGpsBtn');
        var emailBtn = document.getElementById('fnEmailBtn');
        var pdfBtn = document.getElementById('fnPdfBtn');

        var weatherFetchBtn = document.getElementById('fnWeatherFetchBtn');
        var clearFormBtn = document.getElementById('fnClearFormBtn');
        var clearModal = document.getElementById('fnClearModal');
        var clearBackdrop = document.getElementById('fnClearModalBackdrop');
        var clearCancel = document.getElementById('fnClearModalCancel');
        var clearClose = document.getElementById('fnClearModalClose');
        var clearConfirm = document.getElementById('fnClearModalConfirm');

        if (nowBtn) nowBtn.addEventListener('click', setNowDateTime);
        document.querySelectorAll('.fn-btn-battery-time-now').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-time-for');
                if (id) setTimeInputNow(id);
            });
        });
        if (searchLocationBtn) searchLocationBtn.addEventListener('click', onSearchLocationClick);
        if (gpsBtn) gpsBtn.addEventListener('click', onGpsClick);
        if (weatherFetchBtn) weatherFetchBtn.addEventListener('click', onWeatherFetchClick);
        var fnWeatherTa = document.getElementById('fnWeather');
        if (fnWeatherTa) {
            fnWeatherTa.addEventListener('input', autoResizeConditionsTextarea);
            autoResizeConditionsTextarea();
        }
        window.addEventListener(
            'resize',
            function () {
                autoResizeConditionsTextarea();
            },
            { passive: true }
        );
        if (emailBtn) emailBtn.addEventListener('click', onEmailClick);
        if (pdfBtn) pdfBtn.addEventListener('click', onPdfClick);

        if (clearFormBtn) clearFormBtn.addEventListener('click', openClearModal);
        var clearNotesTopBtn = document.getElementById('fnClearNotesTopBtn');
        if (clearNotesTopBtn) clearNotesTopBtn.addEventListener('click', openClearModal);
        if (clearCancel) clearCancel.addEventListener('click', closeClearModal);
        if (clearClose) clearClose.addEventListener('click', closeClearModal);
        if (clearBackdrop) clearBackdrop.addEventListener('click', closeClearModal);
        if (clearConfirm) clearConfirm.addEventListener('click', clearEntireForm);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && clearModal && !clearModal.classList.contains('hidden')) {
                closeClearModal();
            }
        });

        var fnForm = document.getElementById('flightReportForm');
        if (fnForm) {
            fnForm.addEventListener('input', scheduleFlightNotesDraftSave);
            fnForm.addEventListener('change', scheduleFlightNotesDraftSave);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
