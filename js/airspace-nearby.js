/* ============================================
   AIRSPACE NEARBY - Shared NOTAM + UK airspace fetch
   Used by Flight Weather and Flight Report
   ============================================ */

var AirspaceNearby = (function () {
    'use strict';

    var NP = typeof NotamPib !== 'undefined' ? NotamPib : null;

    /**
     * UK AIP / NATS airspace descriptions are often HTML tables. Strip to readable plain text
     * for UI and exports (avoids showing raw tags when escaped, or unsafe innerHTML).
     */
    function htmlToPlainText(html) {
        if (html == null || html === '') return '';
        var s = String(html);
        s = s.replace(/<\s*br\s*\/?>/gi, '\n');
        s = s.replace(/<\/\s*tr\s*>/gi, '\n');
        s = s.replace(/<\/\s*p\s*>/gi, '\n');
        s = s.replace(/<\/\s*div\s*>/gi, '\n');
        s = s.replace(/<\/\s*td\s*>/gi, ' ');
        s = s.replace(/<\/\s*th\s*>/gi, ' ');
        s = s.replace(/<[^>]+>/g, '');
        if (typeof document !== 'undefined') {
            try {
                var ta = document.createElement('textarea');
                ta.innerHTML = s;
                s = ta.value;
            } catch (e) { /* keep stripped string */ }
        } else {
            s = s
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#(\d+);/g, function (_, n) {
                    return String.fromCharCode(parseInt(n, 10));
                })
                .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
                    return String.fromCharCode(parseInt(h, 16));
                });
        }
        s = s.replace(/[ \t\f\v]+/g, ' ');
        s = s.replace(/\n[ \t]+/g, '\n');
        s = s.replace(/\n{3,}/g, '\n\n');
        return s.trim();
    }

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

    /**
     * @param {number} lat
     * @param {number} lng
     * @param {number} radiusKm
     * @param {object} [options]
     * @param {boolean} [options.droneRelevantOnly] - drone triage (uas_high / uas_maybe / hazard keywords)
     * @param {boolean} [options.hideAerodromeGround] - drop heuristic “airfield ops” NOTAMs
     * @param {boolean} [options.hideAboveDroneCeiling] - drop NOTAMs whose Q-line band lies entirely above droneCeilingFt
     * @param {number} [options.droneCeilingFt] - default NP.DEFAULT_DRONE_CEILING_FT (600)
     * @param {boolean} [options.prioritiseUas] - sort UAS-relevant categories first
     * @param {number} [options.referenceAtMs] - instant for validity filter (default Date.now())
     */
    async function fetchNearbyNotams(lat, lng, radiusKm, options) {
        options = options || {};
        try {
            if (!NP) {
                console.warn('NotamPib not loaded; NOTAM list unavailable');
                return [];
            }
            var referenceAtMs =
                options.referenceAtMs != null && isFinite(options.referenceAtMs)
                    ? options.referenceAtMs
                    : Date.now();
            var ceilingFt =
                options.droneCeilingFt != null
                    ? options.droneCeilingFt
                    : NP.DEFAULT_DRONE_CEILING_FT != null
                        ? NP.DEFAULT_DRONE_CEILING_FT
                        : 600;
            var xmlText = await NP.fetchPibXml();
            var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
            var all = NP.parsePibNotamsFromDoc(doc);
            var filtered = all.filter(function (n) {
                var dist = haversineKm(lat, lng, n.lat, n.lng);
                var notamRadiusKm = n.radiusNm > 0 && n.radiusNm < 999 ? n.radiusNm * 1.852 : 0;
                return dist - notamRadiusKm <= radiusKm;
            });
            filtered = filtered.filter(function (n) {
                return NP.notamIsActiveAt(n, referenceAtMs);
            });
            if (options.droneRelevantOnly) {
                filtered = filtered.filter(function (n) {
                    return NP.notamPassesDroneFocusFilter(n);
                });
            }
            if (options.hideAerodromeGround) {
                filtered = filtered.filter(function (n) {
                    return n.uasCategory !== 'aerodrome_ground';
                });
            }
            if (options.hideAboveDroneCeiling) {
                filtered = filtered.filter(function (n) {
                    return NP.notamOverlapsDroneCeilingFt(n, ceilingFt);
                });
            }
            if (options.prioritiseUas) {
                filtered = filtered.slice().sort(function (a, b) {
                    var c = NP.compareNotamsUasPriority(a, b);
                    if (c !== 0) return c;
                    return haversineKm(lat, lng, a.lat, a.lng) - haversineKm(lat, lng, b.lat, b.lng);
                });
            }
            return filtered;
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
                        designator: props.designator || props.id || '-',
                        name: props.name || '-',
                        lower: props.lowerLimit || props.lower || '-',
                        upper: props.upperLimit || props.upper || '-',
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
        fetchNearbyAirspace: fetchNearbyAirspace,
        htmlToPlainText: htmlToPlainText
    };
})();
