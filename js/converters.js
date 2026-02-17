/* ============================================
   COORDINATE CONVERTERS & PARSERS
   ============================================ */

const Converters = (() => {

    // ---- OS Grid Reference to Lat/Lng ----
    // Uses Ordnance Survey National Grid (OSGB36) to WGS84 conversion

    const OSGridLetters = {
        'S': [0, 0], 'T': [1, 0],
        'N': [0, 1], 'O': [1, 1],
        'H': [0, 2], 'J': [1, 2]
    };

    const OSGridMinorLetters = {
        'A': [0, 4], 'B': [1, 4], 'C': [2, 4], 'D': [3, 4], 'E': [4, 4],
        'F': [0, 3], 'G': [1, 3], 'H': [2, 3], 'J': [3, 3], 'K': [4, 3],
        'L': [0, 2], 'M': [1, 2], 'N': [2, 2], 'O': [3, 2], 'P': [4, 2],
        'Q': [0, 1], 'R': [1, 1], 'S': [2, 1], 'T': [3, 1], 'U': [4, 1],
        'V': [0, 0], 'W': [1, 0], 'X': [2, 0], 'Y': [3, 0], 'Z': [4, 0]
    };

    function parseOSGrid(ref) {
        ref = ref.trim().toUpperCase().replace(/\s+/g, '');
        if (ref.length < 4) return null;

        const major = ref[0];
        const minor = ref[1];

        if (!OSGridLetters[major] || !OSGridMinorLetters[minor]) return null;

        const digits = ref.substring(2);
        if (digits.length % 2 !== 0 || digits.length < 2 || digits.length > 10) return null;
        if (!/^\d+$/.test(digits)) return null;

        const half = digits.length / 2;
        const multiplier = Math.pow(10, 5 - half);

        let easting = parseInt(digits.substring(0, half)) * multiplier;
        let northing = parseInt(digits.substring(half)) * multiplier;

        // Add offsets from grid letters
        const [majE, majN] = OSGridLetters[major];
        const [minE, minN] = OSGridMinorLetters[minor];

        easting += (majE * 500000 + minE * 100000);
        northing += (majN * 500000 + minN * 100000);

        return osgb36ToWgs84(easting, northing);
    }

    function osgb36ToWgs84(E, N) {
        // Airy 1830 ellipsoid
        const a = 6377563.396;
        const b = 6356256.909;
        const F0 = 0.9996012717;
        const lat0 = 49 * Math.PI / 180;
        const lon0 = -2 * Math.PI / 180;
        const N0 = -100000;
        const E0 = 400000;
        const e2 = 1 - (b * b) / (a * a);
        const n = (a - b) / (a + b);
        const n2 = n * n;
        const n3 = n * n * n;

        let lat = lat0;
        let M = 0;

        do {
            lat = (N - N0 - M) / (a * F0) + lat;

            const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
            const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
            const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
            const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
            M = b * F0 * (Ma - Mb + Mc - Md);
        } while (Math.abs(N - N0 - M) >= 0.00001);

        const cosLat = Math.cos(lat);
        const sinLat = Math.sin(lat);
        const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
        const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
        const eta2 = nu / rho - 1;

        const tanLat = Math.tan(lat);
        const tan2 = tanLat * tanLat;
        const tan4 = tan2 * tan2;
        const tan6 = tan4 * tan2;
        const secLat = 1 / cosLat;
        const nu3 = nu * nu * nu;
        const nu5 = nu3 * nu * nu;
        const nu7 = nu5 * nu * nu;
        const VII = tanLat / (2 * rho * nu);
        const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
        const IX = tanLat / (720 * rho * nu5) * (61 + 90 * tan2 + 45 * tan4);
        const X = secLat / nu;
        const XI = secLat / (6 * nu3) * (nu / rho + 2 * tan2);
        const XII = secLat / (120 * nu5) * (5 + 28 * tan2 + 24 * tan4);
        const XIIA = secLat / (5040 * nu7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

        const dE = E - E0;
        const dE2 = dE * dE;
        const dE3 = dE2 * dE;
        const dE4 = dE2 * dE2;
        const dE5 = dE3 * dE2;
        const dE6 = dE3 * dE3;
        const dE7 = dE4 * dE3;

        let osgbLat = lat - VII * dE2 + VIII * dE4 - IX * dE6;
        let osgbLon = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

        // Helmert transform OSGB36 -> WGS84
        const osgbLatDeg = osgbLat * 180 / Math.PI;
        const osgbLonDeg = osgbLon * 180 / Math.PI;

        return helmertToWgs84(osgbLatDeg, osgbLonDeg);
    }

    function helmertToWgs84(lat, lon) {
        // Convert OSGB36 lat/lon to WGS84 using Helmert transformation
        const a1 = 6377563.396, b1 = 6356256.909; // Airy
        const a2 = 6378137.000, b2 = 6356752.3141; // GRS80/WGS84

        const tx = 446.448, ty = -125.157, tz = 542.060;
        const rx = (0.1502 / 3600) * Math.PI / 180;
        const ry = (0.2470 / 3600) * Math.PI / 180;
        const rz = (0.8421 / 3600) * Math.PI / 180;
        const s = -20.4894e-6;

        const latR = lat * Math.PI / 180;
        const lonR = lon * Math.PI / 180;

        const e2_1 = 1 - (b1 * b1) / (a1 * a1);
        const sinLat = Math.sin(latR);
        const cosLat = Math.cos(latR);
        const sinLon = Math.sin(lonR);
        const cosLon = Math.cos(lonR);
        const nu = a1 / Math.sqrt(1 - e2_1 * sinLat * sinLat);

        const x1 = (nu + 0) * cosLat * cosLon;
        const y1 = (nu + 0) * cosLat * sinLon;
        const z1 = (nu * (1 - e2_1) + 0) * sinLat;

        const x2 = tx + (1 + s) * (x1 - rz * y1 + ry * z1);
        const y2 = ty + (1 + s) * (rz * x1 + y1 - rx * z1);
        const z2 = tz + (1 + s) * (-ry * x1 + rx * y1 + z1);

        const e2_2 = 1 - (b2 * b2) / (a2 * a2);
        const p = Math.sqrt(x2 * x2 + y2 * y2);
        let lat2 = Math.atan2(z2, p * (1 - e2_2));

        for (let i = 0; i < 10; i++) {
            const nu2 = a2 / Math.sqrt(1 - e2_2 * Math.sin(lat2) * Math.sin(lat2));
            lat2 = Math.atan2(z2 + e2_2 * nu2 * Math.sin(lat2), p);
        }

        const lon2 = Math.atan2(y2, x2);

        return {
            lat: lat2 * 180 / Math.PI,
            lng: lon2 * 180 / Math.PI
        };
    }

    // ---- DMS Parser ----

    function parseDMS(input) {
        input = input.trim();

        // Pattern matches various DMS formats:
        // 51°30'26.4"N 0°07'40.1"W
        // 51 30 26.4 N, 0 07 40.1 W
        // N51°30'26.4" W0°07'40.1"
        // 51.508 N 0.128 W (decimal degrees with direction)
        const dmsRegex = /([NSEW]?)\s*(-?\d+(?:\.\d+)?)[°\s]+(\d+(?:\.\d+)?)?['\u2019\u2032\s]*(\d+(?:\.\d+)?)?["\u201D\u2033\s]*([NSEW]?)/gi;

        const matches = [];
        let m;
        while ((m = dmsRegex.exec(input)) !== null) {
            const dir = (m[1] || m[5] || '').toUpperCase();
            const deg = parseFloat(m[2]) || 0;
            const min = parseFloat(m[3]) || 0;
            const sec = parseFloat(m[4]) || 0;
            let decimal = Math.abs(deg) + min / 60 + sec / 3600;
            if (deg < 0 || dir === 'S' || dir === 'W') {
                decimal = -Math.abs(decimal);
            }
            matches.push({ value: decimal, dir: dir });
        }

        if (matches.length < 2) return null;

        let lat, lng;
        // Determine which is lat and which is lng from direction letters
        if (matches[0].dir === 'N' || matches[0].dir === 'S') {
            lat = matches[0].value;
            lng = matches[1].value;
        } else if (matches[0].dir === 'E' || matches[0].dir === 'W') {
            lng = matches[0].value;
            lat = matches[1].value;
        } else if (matches[1].dir === 'N' || matches[1].dir === 'S') {
            lat = matches[1].value;
            lng = matches[0].value;
        } else if (matches[1].dir === 'E' || matches[1].dir === 'W') {
            lng = matches[1].value;
            lat = matches[0].value;
        } else {
            // No direction - assume lat, lng order
            lat = matches[0].value;
            lng = matches[1].value;
        }

        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

        return { lat, lng };
    }

    // ---- Decimal lat/lng parser ----

    function parseDecimal(input) {
        input = input.trim();
        // Accept: "51.5074, -0.1278" or "51.5074 -0.1278"
        const parts = input.split(/[,\s]+/).filter(p => p.length > 0);
        if (parts.length < 2) return null;

        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);

        if (isNaN(lat) || isNaN(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

        return { lat, lng };
    }

    // ---- UK Postcode lookup via postcodes.io ----

    async function lookupPostcode(postcode) {
        postcode = postcode.trim().toUpperCase();
        try {
            const resp = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
            const data = await resp.json();
            if (data.status === 200 && data.result) {
                return {
                    lat: data.result.latitude,
                    lng: data.result.longitude
                };
            }
        } catch (e) {
            console.error('Postcode lookup failed:', e);
        }
        return null;
    }

    async function lookupPostcodesBulk(postcodes) {
        // postcodes.io accepts up to 100 per request
        const results = {};
        const batches = [];
        for (let i = 0; i < postcodes.length; i += 100) {
            batches.push(postcodes.slice(i, i + 100));
        }
        for (const batch of batches) {
            try {
                const resp = await fetch('https://api.postcodes.io/postcodes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ postcodes: batch })
                });
                const data = await resp.json();
                if (data.status === 200 && data.result) {
                    for (const item of data.result) {
                        if (item.result) {
                            results[item.query.toUpperCase().replace(/\s+/g, '')] = {
                                lat: item.result.latitude,
                                lng: item.result.longitude
                            };
                        }
                    }
                }
            } catch (e) {
                console.error('Bulk postcode lookup failed:', e);
            }
        }
        return results;
    }

    // ---- What3Words lookup ----

    async function lookupW3W(words, apiKey) {
        if (!apiKey) return null;
        words = words.trim().replace(/^\/+/, '');
        try {
            const resp = await fetch(
                `https://api.what3words.com/v3/convert-to-coordinates?words=${encodeURIComponent(words)}&key=${encodeURIComponent(apiKey)}`
            );
            const data = await resp.json();
            if (data.coordinates) {
                return {
                    lat: data.coordinates.lat,
                    lng: data.coordinates.lng
                };
            }
        } catch (e) {
            console.error('W3W lookup failed:', e);
        }
        return null;
    }

    // ---- Format Detection ----

    const UK_POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
    const OS_GRID_REGEX = /^[STNOHJ][A-Z]\s*\d{2,10}$/i;
    const DMS_REGEX = /[°'"NSEW]/i;
    const W3W_REGEX = /^(\/{3})?[a-z]+\.[a-z]+\.[a-z]+$/i;

    function detectFormat(input) {
        input = input.trim();
        if (!input) return null;

        if (UK_POSTCODE_REGEX.test(input)) return 'postcode';
        if (OS_GRID_REGEX.test(input.replace(/\s+/g, ''))) return 'osgrid';
        if (W3W_REGEX.test(input)) return 'w3w';
        if (DMS_REGEX.test(input)) return 'dms';
        // Check if it looks like decimal coordinates
        const parts = input.split(/[,\s]+/).filter(p => p.length > 0);
        if (parts.length >= 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) {
            return 'decimal';
        }
        return 'unknown';
    }

    function formatLabel(format) {
        const labels = {
            'postcode': 'UK Postcode',
            'osgrid': 'OS Grid Reference',
            'dms': 'Degrees Minutes Seconds',
            'w3w': 'What3Words',
            'decimal': 'Decimal Lat/Lng',
            'unknown': 'Unknown format'
        };
        return labels[format] || format;
    }

    // ---- Resolve any format to lat/lng ----

    async function resolve(input, w3wApiKey) {
        const format = detectFormat(input);

        switch (format) {
            case 'decimal':
                return parseDMS(input) || parseDecimal(input);
            case 'dms':
                return parseDMS(input);
            case 'osgrid':
                return parseOSGrid(input);
            case 'postcode':
                return await lookupPostcode(input);
            case 'w3w':
                return await lookupW3W(input, w3wApiKey);
            default:
                // Try all parsers
                let result = parseDecimal(input);
                if (result) return result;
                result = parseDMS(input);
                if (result) return result;
                result = parseOSGrid(input);
                if (result) return result;
                return null;
        }
    }

    // ---- Public API ----

    return {
        parseOSGrid,
        parseDMS,
        parseDecimal,
        lookupPostcode,
        lookupPostcodesBulk,
        lookupW3W,
        detectFormat,
        formatLabel,
        resolve
    };

})();
