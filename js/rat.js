/* ============================================
   RA(T) MODULE - Restricted Area Temporary
   Source: UK Airspace Service (BGA)
   https://airspace.bgaladder.net/API
   Requires: Registration + Bearer token
   ============================================ */

(function (global) {
    'use strict';

    const API_BASE = 'https://airspace.bgaladder.net/API';

    function init(options) {
        options = options || {};
        const map = options.map;
        const getCredentials = options.getCredentials || function () { return { username: '', password: '' }; };
        let ratLayer = null;
        let token = null;

        function createLayer() {
            return L.geoJSON(null, {
                style: {
                    color: '#7c3aed',
                    weight: 2,
                    fillColor: '#7c3aed',
                    fillOpacity: 0.2,
                    dashArray: '8,4'
                },
                onEachFeature: function (feature, layer) {
                    const p = feature.properties || {};
                    let html = '<div class="airspace-popup"><div class="airspace-popup-header">';
                    html += '<div class="airspace-popup-title">' + (p.name || 'RA(T)') + '</div>';
                    html += '<span class="airspace-popup-badge" style="background:#7c3aed;color:white">RA(T)</span></div>';
                    if (p.lower || p.upper) {
                        html += '<div class="airspace-popup-designator">' + (p.lower || 'SFC') + ' – ' + (p.upper || 'UNL') + '</div>';
                    }
                    html += '<div class="airspace-popup-body">';
                    if (p.rules) html += '<div class="airspace-popup-detail">' + String(p.rules).replace(/</g, '&lt;') + '</div>';
                    html += '<div class="airspace-popup-source">UK Airspace Service · Mauve AICs</div></div></div>';
                    layer.bindPopup(html, { maxWidth: 420, maxHeight: 400 });
                }
            });
        }

        function fetchToken(callback) {
            const creds = getCredentials();
            if (!creds.username || !creds.password) {
                if (callback) callback(null, 'No credentials');
                return;
            }
            const url = 'https://airspace.bgaladder.net/Auth/Token?username=' + encodeURIComponent(creds.username) + '&password=' + encodeURIComponent(creds.password);
            fetch(url)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    token = data.token || data.tokenValue || data.access_token;
                    if (callback) callback(token);
                })
                .catch(function (err) {
                    if (callback) callback(null, err);
                });
        }

        function loadRAT(bounds, callback) {
            if (!bounds) return;
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();
            const baseLat = sw.lat;
            const baseLng = sw.lng;
            const topLat = ne.lat;
            const topLng = ne.lng;

            function doFetch(t) {
                const url = API_BASE + '/GetRAT/' + baseLat + '/' + baseLng + '/' + topLat + '/' + topLng;
                return fetch(url, {
                    headers: { 'Authorization': 'Bearer ' + t }
                }).then(function (r) {
                    if (!r.ok) throw new Error('RA(T) fetch failed');
                    return r.json();
                });
            }

            if (token) {
                doFetch(token).then(function (data) {
                    addRATData(data, callback);
                }).catch(function () {
                    token = null;
                    fetchToken(function (t) {
                        if (t) doFetch(t).then(function (d) { addRATData(d, callback); }).catch(function (e) { if (callback) callback({ error: e, count: 0 }); });
                        else if (callback) callback({ error: 'Auth failed', count: 0 });
                    });
                });
            } else {
                fetchToken(function (t) {
                    if (!t) {
                        if (callback) callback({ error: 'No credentials. Add BGA Airspace Service username/password in Settings.', count: 0 });
                        return;
                    }
                    doFetch(t).then(function (d) { addRATData(d, callback); }).catch(function (e) { if (callback) callback({ error: e, count: 0 }); });
                });
            }
        }

        function addRATData(data, callback) {
            if (!ratLayer) return;
            ratLayer.clearLayers();
            let count = 0;
            const items = Array.isArray(data) ? data : (data.items || data.features || []);
            items.forEach(function (item) {
                const gj = item.geojSON || item.geoJSON || item;
                const geom = gj.geometry || (gj.type === 'Feature' ? gj.geometry : null);
                if (geom) {
                    const props = gj.properties || {};
                    props.lower = item.lower || props.lower;
                    props.upper = item.upper || props.upper;
                    props.name = item.name || props.name;
                    props.rules = item.rules || props.rules;
                    ratLayer.addData({ type: 'Feature', geometry: geom, properties: props });
                    count++;
                }
            });
            if (callback) callback({ count: count });
        }

        ratLayer = createLayer();

        return {
            layer: ratLayer,
            loadRAT: loadRAT,
            addToMap: function () { if (map && ratLayer) map.addLayer(ratLayer); },
            removeFromMap: function () { if (map && ratLayer) map.removeLayer(ratLayer); }
        };
    }

    global.RAT = { init: init };
})(typeof window !== 'undefined' ? window : this);
