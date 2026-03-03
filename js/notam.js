/* ============================================
   NOTAM MODULE - UK NOTAMs from UK NOTAM Archive
   Source: https://jonty.github.io/uk-notam-archive/
   Data: NATS AIS Contingency PIB (hourly updated)
   ============================================ */

(function (global) {
    'use strict';

    const PIB_URL = 'https://jonty.github.io/uk-notam-archive/data/PIB.xml';

    function parseCoord(coordStr) {
        if (!coordStr || coordStr.length < 9) return null;
        const m = coordStr.match(/^(\d{4})([NS])(\d{5})([EW])$/);
        if (!m) return null;
        let lat = parseInt(m[1].slice(0, 2), 10) + parseInt(m[1].slice(2, 4), 10) / 60;
        if (m[2] === 'S') lat = -lat;
        let lng = parseInt(m[3].slice(0, 3), 10) + parseInt(m[3].slice(3, 5), 10) / 60;
        if (m[4] === 'W') lng = -lng;
        return [lat, lng];
    }

    function parsePIBXml(xmlText) {
        const notams = [];
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        const notamEls = doc.querySelectorAll('Notam');
        notamEls.forEach(function (el) {
            const coords = el.querySelector('Coordinates');
            const radius = el.querySelector('Radius');
            const itemE = el.querySelector('ItemE');
            const startVal = el.querySelector('StartValidity');
            const endVal = el.querySelector('EndValidity');
            const nof = el.querySelector('NOF');
            const series = el.querySelector('Series');
            const number = el.querySelector('Number');
            const year = el.querySelector('Year');
            if (!coords || !coords.textContent) return;
            const latLng = parseCoord(coords.textContent.trim());
            if (!latLng) return;
            const radiusNm = radius && radius.textContent ? parseInt(radius.textContent.trim(), 10) || 0 : 0;
            const id = (nof ? nof.textContent : '') + (series ? series.textContent : '') + (number ? number.textContent : '') + '/' + (year ? year.textContent : '');
            notams.push({
                id: id.trim(),
                lat: latLng[0],
                lng: latLng[1],
                radiusNm: radiusNm,
                text: itemE ? itemE.textContent.trim() : '',
                startValidity: startVal ? startVal.textContent : '',
                endValidity: endVal ? endVal.textContent : ''
            });
        });
        return notams;
    }

    function createCircleLayer(notam) {
        const radiusNm = Math.min(notam.radiusNm, 50);
        if (radiusNm <= 0) return null;
        const radiusM = radiusNm * 1852;
        const circle = L.circle([notam.lat, notam.lng], {
            radius: radiusM,
            color: '#059669',
            weight: 2,
            fillColor: '#059669',
            fillOpacity: 0.15
        });
        let html = '<div class="airspace-popup"><div class="airspace-popup-header">';
        html += '<div class="airspace-popup-title">' + (notam.id || 'NOTAM') + '</div>';
        html += '<span class="airspace-popup-badge" style="background:#059669;color:white">NOTAM</span></div>';
        if (notam.startValidity || notam.endValidity) {
            html += '<div class="airspace-popup-designator">Valid: ' + (notam.startValidity || '') + ' – ' + (notam.endValidity || '') + '</div>';
        }
        html += '<div class="airspace-popup-body"><div class="airspace-popup-detail">' + (notam.text || '').replace(/</g, '&lt;') + '</div>';
        html += '<div class="airspace-popup-source">UK NOTAM Archive · NATS AIS</div></div></div>';
        circle.bindPopup(html, { maxWidth: 420, maxHeight: 400 });
        return circle;
    }

    function init(options) {
        options = options || {};
        const map = options.map;
        let notamLayer = null;
        let lastValidity = null;

        function loadNotams(callback) {
            fetch(PIB_URL + '?t=' + Date.now())
                .then(function (r) { return r.text(); })
                .then(function (xmlText) {
                    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
                    const validFrom = doc.querySelector('AreaPIBHeader ValidFrom') || doc.querySelector('ValidFrom');
                    const validTo = doc.querySelector('AreaPIBHeader ValidTo') || doc.querySelector('ValidTo');
                    if (validFrom && validTo) {
                        lastValidity = {
                            effectiveFrom: validFrom.textContent.slice(0, 10),
                            effectiveTo: validTo.textContent.slice(0, 10)
                        };
                    }
                    const notams = parsePIBXml(xmlText);
                    const circles = notams.map(createCircleLayer).filter(Boolean);
                    circles.sort(function (a, b) { return b.getRadius() - a.getRadius(); });
                    if (notamLayer) {
                        notamLayer.clearLayers();
                        circles.forEach(function (c) { notamLayer.addLayer(c); });
                    }
                    if (callback) callback({ notams: notams, count: circles.length, validity: lastValidity });
                })
                .catch(function (err) {
                    if (callback) callback({ error: err, count: 0 });
                });
        }

        notamLayer = L.layerGroup();

        return {
            layer: notamLayer,
            loadNotams: loadNotams,
            getLastValidity: function () { return lastValidity; },
            addToMap: function () { if (map && notamLayer) map.addLayer(notamLayer); },
            removeFromMap: function () { if (map && notamLayer) map.removeLayer(notamLayer); }
        };
    }

    global.Notam = { init: init };
})(typeof window !== 'undefined' ? window : this);
