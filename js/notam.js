/* ============================================
   NOTAM MODULE - UK NOTAMs from UK NOTAM Archive
   Source: https://jonty.github.io/uk-notam-archive/
   Data: NATS AIS Contingency PIB (hourly updated)
   ============================================ */

(function (global) {
    'use strict';

    const PIB_URL = 'https://jonty.github.io/uk-notam-archive/data/PIB.xml';

    /** Keywords indicating drone/UAS-relevant NOTAMs (from ItemE / Q-line) */
    const DRONE_KEYWORDS = [
        'UAS', 'WU LW', 'RD CS', 'OB CE', 'CRANE', 'TDA', 'BVLOS', 'UAS OPR',
        'UAS OPS', 'DANGER AREA', 'TEMP DANGER', 'EGD', 'EGRU', 'AR-20'
    ];

    /** Parse ICAO NOTAM date (YYMMDDHHMM) or ISO to readable string e.g. "8 Jan 2026 00:00 UTC" */
    function formatNotamDate(str) {
        if (str == null || str === '') return '';
        const raw = String(str).trim();
        var d, months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var fmt = function (d) {
            return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
                String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
        };
        var m = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (m) {
            d = new Date(Date.UTC(+m[1], parseInt(m[2], 10) - 1, +m[3], +m[4], +m[5]));
            if (!isNaN(d.getTime())) return fmt(d);
        }
        m = raw.match(/\d{10}/);
        if (!m) return '';
        const s = m[0];
        const yy = parseInt(s.slice(0, 2), 10);
        const mm = parseInt(s.slice(2, 4), 10) - 1;
        const dd = parseInt(s.slice(4, 6), 10);
        const hh = parseInt(s.slice(6, 8), 10);
        const min = parseInt(s.slice(8, 10), 10);
        const year = yy >= 50 ? 1900 + yy : 2000 + yy;
        if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return '';
        d = new Date(Date.UTC(year, mm, dd, hh, min));
        return fmt(d);
    }

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

    function isDroneRelevant(notam) {
        const text = (notam.text || '').toUpperCase();
        return DRONE_KEYWORDS.some(function (kw) { return text.includes(kw.toUpperCase()); });
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

    function createCircleLayer(notam, opts) {
        opts = opts || {};
        const maxRadius = opts.maxRadius != null ? opts.maxRadius : 12;
        const fillOpacity = opts.fillOpacity != null ? opts.fillOpacity : 0.08;

        let radiusNm = notam.radiusNm;
        if (radiusNm <= 0) return null;
        if (radiusNm >= 999) return null;
        radiusNm = Math.min(radiusNm, maxRadius);

        const radiusM = radiusNm * 1852;

        var style;
        if (radiusNm <= 3) {
            style = { color: '#059669', weight: 2, fillColor: '#059669', fillOpacity: Math.min(fillOpacity * 1.5, 0.2) };
        } else if (radiusNm <= 10) {
            style = { color: '#059669', weight: 1.5, fillColor: '#059669', fillOpacity: fillOpacity };
        } else {
            style = { color: '#059669', weight: 1, fillColor: '#059669', fillOpacity: fillOpacity * 0.5 };
        }

        const circle = L.circle([notam.lat, notam.lng], {
            radius: radiusM,
            color: style.color,
            weight: style.weight,
            fillColor: style.fillColor,
            fillOpacity: style.fillOpacity
        });

        let html = '<div class="airspace-popup"><div class="airspace-popup-header">';
        html += '<div class="airspace-popup-title">' + (notam.id || 'NOTAM') + '</div>';
        html += '<span class="airspace-popup-badge" style="background:#059669;color:white">NOTAM</span></div>';
        if (notam.startValidity || notam.endValidity) {
            const startReadable = formatNotamDate(notam.startValidity);
            const endReadable = formatNotamDate(notam.endValidity);
            const endRaw = (notam.endValidity || '').trim().toUpperCase();
            const endDisplay = endReadable || (endRaw === 'PERM' || endRaw === 'UFN' ? endRaw : (notam.endValidity || ''));
            const startDisplay = startReadable || (notam.startValidity || '');
            if (startDisplay || endDisplay) {
                html += '<div class="airspace-popup-designator">Valid: ' + startDisplay + ' – ' + endDisplay + '</div>';
            }
            html += '<div class="airspace-popup-designator airspace-popup-validity-raw">' + (notam.startValidity || '') + ' – ' + (notam.endValidity || '') + '</div>';
        }
        if (notam.radiusNm > 0 && notam.radiusNm < 999) {
            html += '<div class="airspace-popup-designator">Radius: ' + notam.radiusNm + ' NM</div>';
        }
        html += '<div class="airspace-popup-body"><div class="airspace-popup-detail">' + (notam.text || '').replace(/</g, '&lt;') + '</div>';
        html += '<div class="airspace-popup-source">UK NOTAM Archive · NATS AIS</div></div></div>';
        circle.bindPopup(html, { maxWidth: 420, maxHeight: 400 });
        circle._notamData = notam;
        return circle;
    }

    function circleIntersectsBounds(circle, bounds) {
        try {
            const circleBounds = circle.getBounds();
            return bounds.intersects(circleBounds);
        } catch (e) {
            return true;
        }
    }

    function init(options) {
        options = options || {};
        const map = options.map;
        let notamLayer = null;
        let lastValidity = null;
        let allNotams = [];
        let allCircles = [];
        let isVisible = false;

        var config = {
            maxRadius: 12,
            excludeRadius999: true,
            droneRelevantOnly: false,
            fillOpacity: 0.08,
            zoomFilterRadius: 10
        };

        function getZoomMaxRadius() {
            if (!map) return config.maxRadius;
            const zoom = map.getZoom();
            if (zoom >= 12) return Math.min(10, config.maxRadius);
            if (zoom >= 10) return Math.min(20, config.maxRadius);
            if (zoom >= 8) return Math.min(50, config.maxRadius);
            return config.maxRadius;
        }

        function applyFilters() {
            const bounds = map ? map.getBounds() : null;
            const effectiveMaxRadius = map ? getZoomMaxRadius() : config.maxRadius;

            var toShow = allCircles.filter(function (c) {
                const notam = c._notamData;
                if (!notam) return false;
                if (config.droneRelevantOnly && !isDroneRelevant(notam)) return false;
                if (notam.radiusNm > effectiveMaxRadius) return false;
                if (bounds && !circleIntersectsBounds(c, bounds)) return false;
                return true;
            });

            toShow.sort(function (a, b) {
                const ra = a.getRadius ? a.getRadius() : 0;
                const rb = b.getRadius ? b.getRadius() : 0;
                return rb - ra;
            });

            return toShow;
        }

        function updateDisplay() {
            if (!notamLayer || !isVisible) return;
            notamLayer.clearLayers();
            const toShow = applyFilters();
            toShow.forEach(function (c) { notamLayer.addLayer(c); });
        }

        function buildCircles() {
            allCircles = [];
            allNotams.forEach(function (notam) {
                if (config.excludeRadius999 && notam.radiusNm >= 999) return;
                if (notam.radiusNm <= 0) return;
                const circle = createCircleLayer(notam, {
                    maxRadius: config.maxRadius,
                    fillOpacity: config.fillOpacity
                });
                if (circle) allCircles.push(circle);
            });
        }

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
                    allNotams = parsePIBXml(xmlText);
                    buildCircles();
                    if (isVisible) updateDisplay();
                    if (callback) callback({ notams: allNotams, count: allCircles.length, validity: lastValidity });
                })
                .catch(function (err) {
                    if (callback) callback({ error: err, count: 0 });
                });
        }

        notamLayer = L.layerGroup();

        if (map) {
            map.on('moveend', updateDisplay);
            map.on('zoomend', updateDisplay);
        }

        return {
            layer: notamLayer,
            loadNotams: loadNotams,
            getLastValidity: function () { return lastValidity; },
            addToMap: function () {
                isVisible = true;
                if (map && notamLayer) {
                    map.addLayer(notamLayer);
                    updateDisplay();
                }
            },
            removeFromMap: function () {
                isVisible = false;
                if (map && notamLayer) map.removeLayer(notamLayer);
            },
            setOptions: function (opts) {
                if (opts.maxRadius != null) config.maxRadius = opts.maxRadius;
                if (opts.excludeRadius999 != null) config.excludeRadius999 = opts.excludeRadius999;
                if (opts.droneRelevantOnly != null) config.droneRelevantOnly = opts.droneRelevantOnly;
                if (opts.fillOpacity != null) config.fillOpacity = opts.fillOpacity;
                if (opts.zoomFilterRadius != null) config.zoomFilterRadius = opts.zoomFilterRadius;
                buildCircles();
                updateDisplay();
            },
            getOptions: function () { return Object.assign({}, config); },
            updateDisplay: updateDisplay
        };
    }

    global.Notam = { init: init };
})(typeof window !== 'undefined' ? window : this);
