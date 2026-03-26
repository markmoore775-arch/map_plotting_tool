/* ============================================
   AIRSPACE NEARBY — Shared NOTAM + UK airspace fetch
   Used by Flight Weather and Flight Notes
   ============================================ */

var AirspaceNearby = (function () {
    'use strict';

    function haversineKm(lat1, lng1, lat2, lng2) {
        var R = 6371;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLng = (lng2 - lng1) * Math.PI / 180;
        var a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) *
                Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng / 2) *
                Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function classifyAirspaceFeature(f) {
        var props = f.properties || {};
        var desig = (props.designator || props.type || props.id || '').toUpperCase();
        var name = (props.name || '').toUpperCase();
        var desc = (props.description || '').toUpperCase();
        var aType = (props.type || '').toUpperCase();
        if (
            desig.startsWith('EGRU') ||
            desc.includes('FRZ') ||
            desig.includes('FRZ') ||
            desig.includes('RPZ') ||
            name.includes('FRZ') ||
            name.includes('AERODROME') ||
            name.includes('FLIGHT RESTRICTION')
        ) {
            return 'FRZ';
        }
        if (desig.startsWith('EG-P') || desig.startsWith('EGP') || desig.startsWith('P') || name.includes('PROHIBITED') || aType === 'P') {
            return 'Prohibited';
        }
        if (desig.startsWith('EG-R') || desig.startsWith('EGR') || desig.startsWith('R') || name.includes('RESTRICTED') || aType === 'R') {
            return 'Restricted';
        }
        if (desig.startsWith('EG-D') || desig.startsWith('EGD') || desig.startsWith('D') || name.includes('DANGER') || aType === 'D') {
            return 'Danger';
        }
        return null;
    }

    async function fetchNearbyNotams(lat, lng, radiusKm) {
        try {
            var resp = await fetch('https://jonty.github.io/uk-notam-archive/data/PIB.xml?t=' + Date.now());
            if (!resp.ok) return [];
            var xmlText = await resp.text();
            var parser = new DOMParser();
            var doc = parser.parseFromString(xmlText, 'text/xml');
            var notamEls = doc.querySelectorAll('Notam');
            var all = [];
            notamEls.forEach(function (el) {
                var coords = el.querySelector('Coordinates');
                var radius = el.querySelector('Radius');
                var itemE = el.querySelector('ItemE');
                var startVal = el.querySelector('StartValidity');
                var endVal = el.querySelector('EndValidity');
                var nof = el.querySelector('NOF');
                var series = el.querySelector('Series');
                var number = el.querySelector('Number');
                var year = el.querySelector('Year');
                if (!coords || !coords.textContent) return;
                var cStr = coords.textContent.trim();
                var m = cStr.match(/^(\d{4})([NS])(\d{5})([EW])$/);
                if (!m) return;
                var nLat = parseInt(m[1].slice(0, 2), 10) + parseInt(m[1].slice(2, 4), 10) / 60;
                if (m[2] === 'S') nLat = -nLat;
                var nLng = parseInt(m[3].slice(0, 3), 10) + parseInt(m[3].slice(3, 5), 10) / 60;
                if (m[4] === 'W') nLng = -nLng;
                var radiusNm = radius && radius.textContent ? parseInt(radius.textContent.trim(), 10) || 0 : 0;
                var id =
                    (nof ? nof.textContent : '') +
                    (series ? series.textContent : '') +
                    (number ? number.textContent : '') +
                    '/' +
                    (year ? year.textContent : '');
                all.push({
                    id: id.trim(),
                    lat: nLat,
                    lng: nLng,
                    radiusNm: radiusNm,
                    text: itemE ? itemE.textContent.trim() : '',
                    startValidity: startVal ? startVal.textContent : '',
                    endValidity: endVal ? endVal.textContent : ''
                });
            });
            return all.filter(function (n) {
                var dist = haversineKm(lat, lng, n.lat, n.lng);
                var notamRadiusKm = n.radiusNm > 0 && n.radiusNm < 999 ? n.radiusNm * 1.852 : 0;
                return dist - notamRadiusKm <= radiusKm;
            });
        } catch (e) {
            console.warn('NOTAM fetch failed:', e);
            return [];
        }
    }

    async function fetchNearbyAirspace(lat, lng, radiusKm) {
        try {
            var results = await Promise.all([
                fetch('assets/uk-airspace.geojson?t=' + Date.now())
                    .then(function (r) {
                        return r.ok ? r.json() : null;
                    })
                    .catch(function () {
                        return null;
                    }),
                fetch('assets/uk-aip-airspace.geojson?t=' + Date.now())
                    .then(function (r) {
                        return r.ok ? r.json() : null;
                    })
                    .catch(function () {
                        return null;
                    })
            ]);
            var features = [];
            results.forEach(function (data) {
                if (data && data.features) features = features.concat(data.features);
            });
            return features
                .filter(function (f) {
                    var category = classifyAirspaceFeature(f);
                    if (!category) return false;
                    var geom = f.geometry;
                    if (!geom || !geom.coordinates) return false;
                    var coords =
                        geom.type === 'MultiPolygon' ? geom.coordinates.flat(2) : geom.type === 'Polygon' ? geom.coordinates.flat() : [];
                    return coords.some(function (c) {
                        return haversineKm(lat, lng, c[1], c[0]) <= radiusKm;
                    });
                })
                .map(function (f) {
                    var props = f.properties || {};
                    return {
                        category: classifyAirspaceFeature(f),
                        designator: props.designator || props.id || '—',
                        name: props.name || '—',
                        lower: props.lowerLimit || props.lower || '—',
                        upper: props.upperLimit || props.upper || '—',
                        type: props.type || '',
                        source: props.source || '',
                        description: props.description || '',
                        geometry: f.geometry
                    };
                })
                .sort(function (a, b) {
                    var order = { FRZ: 0, Prohibited: 1, Restricted: 2, Danger: 3 };
                    return (order[a.category] || 4) - (order[b.category] || 4);
                });
        } catch (e) {
            console.warn('Airspace fetch failed:', e);
            return [];
        }
    }

    return {
        haversineKm: haversineKm,
        classifyAirspaceFeature: classifyAirspaceFeature,
        fetchNearbyNotams: fetchNearbyNotams,
        fetchNearbyAirspace: fetchNearbyAirspace
    };
})();
