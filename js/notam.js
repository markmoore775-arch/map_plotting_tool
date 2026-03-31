/* ============================================
   NOTAM MODULE - UK NOTAMs from UK NOTAM Archive
   Source: https://jonty.github.io/uk-notam-archive/
   Data: NATS AIS Contingency PIB (hourly updated)
   ============================================ */

(function (global) {
    'use strict';

    var NP = global.NotamPib;
    if (!NP) {
        console.error('notam.js requires notam-pib.js');
    }

    function formatNotamDate(str) {
        return NP ? NP.formatNotamDate(str) : '';
    }

    function createCircleLayer(notam, opts) {
        opts = opts || {};
        var maxRadius = opts.maxRadius != null ? opts.maxRadius : 12;
        var fillOpacity = opts.fillOpacity != null ? opts.fillOpacity : 0.08;

        var radiusNm = notam.radiusNm;
        if (radiusNm <= 0) return null;
        if (radiusNm >= 999) return null;
        radiusNm = Math.min(radiusNm, maxRadius);

        var radiusM = radiusNm * 1852;
        var cat = notam.uasCategory || 'other';
        var style = NP ? NP.circleStyleForCategory(cat, radiusNm, fillOpacity) : {
            color: '#64748b', fillColor: '#64748b', weight: 1.5, fillOpacity: fillOpacity
        };

        var circle = L.circle([notam.lat, notam.lng], {
            radius: radiusM,
            color: style.color,
            weight: style.weight,
            fillColor: style.fillColor,
            fillOpacity: style.fillOpacity
        });

        var badge = NP ? NP.notamBadgeMeta(cat) : { label: 'NOTAM', cssClass: 'badge-notam-general' };
        var badgeBg =
            cat === 'uas_high' ? '#d97706' :
            cat === 'uas_maybe' ? '#ea580c' :
            cat === 'aerodrome_ground' ? '#9333ea' : '#64748b';

        var html = '<div class="airspace-popup"><div class="airspace-popup-header">';
        html += '<div class="airspace-popup-title">' + (notam.id || 'NOTAM') + '</div>';
        html += '<span class="airspace-popup-badge airspace-popup-badge--notam-' + cat + '" style="background:' + badgeBg + ';color:white">' +
            badge.label + '</span></div>';
        if (notam.startValidity || notam.endValidity) {
            var startReadable = formatNotamDate(notam.startValidity);
            var endReadable = formatNotamDate(notam.endValidity);
            var endRaw = (notam.endValidity || '').trim().toUpperCase();
            var endDisplay = endReadable || (endRaw === 'PERM' || endRaw === 'UFN' ? endRaw : (notam.endValidity || ''));
            var startDisplay = startReadable || (notam.startValidity || '');
            if (startDisplay || endDisplay) {
                html += '<div class="airspace-popup-designator">Valid: ' + startDisplay + ' – ' + endDisplay + '</div>';
            }
            html += '<div class="airspace-popup-designator airspace-popup-validity-raw">' + (notam.startValidity || '') + ' – ' + (notam.endValidity || '') + '</div>';
        }
        if (notam.verticalSummary) {
            html += '<div class="airspace-popup-designator">Vertical (Q-line): ' +
                String(notam.verticalSummary).replace(/</g, '&lt;') + '</div>';
            html += '<div class="airspace-popup-designator airspace-popup-muted">Use official PIB for flight-critical vertical limits.</div>';
        }
        if (notam.radiusNm > 0 && notam.radiusNm < 999) {
            html += '<div class="airspace-popup-designator">Radius: ' + notam.radiusNm + ' NM</div>';
        }
        html += '<div class="airspace-popup-body"><div class="airspace-popup-detail">' + (notam.text || '').replace(/</g, '&lt;') + '</div>';
        html += '<div class="airspace-popup-source">UK NOTAM Archive · NATS AIS</div></div></div>';
        circle.bindPopup(html, {
            maxWidth: 420,
            maxHeight: 400,
            autoPan: false
        });
        circle._notamData = notam;
        return circle;
    }

    function circleIntersectsBounds(circle, bounds) {
        try {
            var circleBounds = circle.getBounds();
            return bounds.intersects(circleBounds);
        } catch (e) {
            return true;
        }
    }

    function init(options) {
        options = options || {};
        var map = options.map;
        var notamLayer = null;
        var lastValidity = null;
        var allNotams = [];
        var allCircles = [];
        var isVisible = false;
        var notamPopupOpen = false;

        var config = {
            maxRadius: 12,
            excludeRadius999: true,
            droneRelevantOnly: false,
            hideAerodromeGround: false,
            fillOpacity: 0.08,
            zoomFilterRadius: 10
        };

        function getZoomMaxRadius() {
            if (!map) return config.maxRadius;
            var zoom = map.getZoom();
            if (zoom >= 12) return Math.min(10, config.maxRadius);
            if (zoom >= 10) return Math.min(20, config.maxRadius);
            if (zoom >= 8) return Math.min(50, config.maxRadius);
            return config.maxRadius;
        }

        function applyFilters() {
            var bounds = map ? map.getBounds() : null;
            var effectiveMaxRadius = map ? getZoomMaxRadius() : config.maxRadius;

            var toShow = allCircles.filter(function (c) {
                var notam = c._notamData;
                if (!notam) return false;
                if (config.droneRelevantOnly && NP && !NP.isDroneKeywordRelevant(notam)) return false;
                if (config.hideAerodromeGround && notam.uasCategory === 'aerodrome_ground') return false;
                if (notam.radiusNm > effectiveMaxRadius) return false;
                if (bounds && !circleIntersectsBounds(c, bounds)) return false;
                return true;
            });

            toShow.sort(function (a, b) {
                var ra = a.getRadius ? a.getRadius() : 0;
                var rb = b.getRadius ? b.getRadius() : 0;
                return rb - ra;
            });

            return toShow;
        }

        function updateDisplay(force) {
            if (!notamLayer || !isVisible) return;
            if (force) notamPopupOpen = false;
            else if (notamPopupOpen) return;
            notamLayer.clearLayers();
            var toShow = applyFilters();
            toShow.forEach(function (c) { notamLayer.addLayer(c); });
        }

        function buildCircles() {
            allCircles = [];
            allNotams.forEach(function (notam) {
                if (config.excludeRadius999 && notam.radiusNm >= 999) return;
                if (notam.radiusNm <= 0) return;
                var circle = createCircleLayer(notam, {
                    maxRadius: config.maxRadius,
                    fillOpacity: config.fillOpacity
                });
                if (circle) allCircles.push(circle);
            });
        }

        function loadNotams(callback) {
            if (!NP) {
                if (callback) callback({ error: new Error('NotamPib missing'), count: 0 });
                return;
            }
            NP.fetchPibXml()
                .then(function (xmlText) {
                    var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
                    lastValidity = NP.extractPibValidity(doc);
                    allNotams = NP.parsePibNotamsFromDoc(doc);
                    buildCircles();
                    if (isVisible) updateDisplay(true);
                    if (callback) callback({ notams: allNotams, count: allCircles.length, validity: lastValidity });
                })
                .catch(function (err) {
                    if (callback) callback({ error: err, count: 0 });
                });
        }

        notamLayer = L.layerGroup();

        if (map) {
            map.on('popupopen', function (e) {
                var src = e.popup && e.popup._source;
                if (src && src._notamData) notamPopupOpen = true;
            });
            map.on('popupclose', function (e) {
                var src = e.popup && e.popup._source;
                if (!(src && src._notamData) || !notamPopupOpen) return;
                notamPopupOpen = false;
                updateDisplay(false);
            });
            map.on('moveend', function () { updateDisplay(false); });
            map.on('zoomend', function () { updateDisplay(false); });
        }

        return {
            layer: notamLayer,
            loadNotams: loadNotams,
            getLastValidity: function () { return lastValidity; },
            addToMap: function () {
                isVisible = true;
                if (map && notamLayer) {
                    map.addLayer(notamLayer);
                    updateDisplay(true);
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
                if (opts.hideAerodromeGround != null) config.hideAerodromeGround = opts.hideAerodromeGround;
                if (opts.fillOpacity != null) config.fillOpacity = opts.fillOpacity;
                if (opts.zoomFilterRadius != null) config.zoomFilterRadius = opts.zoomFilterRadius;
                buildCircles();
                updateDisplay(true);
            },
            getOptions: function () { return Object.assign({}, config); },
            updateDisplay: updateDisplay
        };
    }

    global.Notam = { init: init };
})(typeof window !== 'undefined' ? window : this);
