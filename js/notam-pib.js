/* ============================================
   UK PIB NOTAM - shared parse, classify, vertical limits
   Source: https://jonty.github.io/uk-notam-archive/data/PIB.xml
   ============================================ */

(function (global) {
    'use strict';

    var PIB_URL = 'https://jonty.github.io/uk-notam-archive/data/PIB.xml';

    /** Strong UAS / hazard signals (ItemE text, uppercased) */
    var DRONE_KEYWORDS = [
        'UAS', 'WU LW', 'RD CS', 'OB CE', 'CRANE', 'TDA', 'BVLOS', 'UAS OPR',
        'UAS OPS', 'DANGER AREA', 'TEMP DANGER', 'EGD', 'EGRU', 'AR-20'
    ];

    /** En-route / event NOTAMs that often matter for UAS even without drone keywords */
    var UAS_MAYBE_KEYWORDS = [
        'TEMPORARY RESTRICTED', 'RESTRICTED AREA', ' TRA ', 'RA(T)', 'AERIAL DISPLAY',
        'AIR DISPLAY', 'FIREWORK', 'PARACHUTE', 'DROP ZONE', 'CAP1735', 'RESTRICTED AIRSPACE'
    ];

    /** Typical aerodrome-only / surface ops noise (ignored for UAS triage when not uas_high) */
    var AERODROME_GROUND_KEYWORDS = [
        'TAXIWAY', 'APRON', 'LIGHTING', 'LOCALISER', 'LOCALIZER', 'GLIDEPATH', 'ILS ',
        ' RWY ', 'RUNWAY ', 'THR ', 'THRESHOLD', 'AD CLSD', 'AERODROME CLSD', 'AIRPORT CLSD',
        'ATS COMMUNICATION', 'ATIS ', 'GND ', 'GROUND ', 'FIRE VEHICLE', 'BIRD', 'WILDLIFE',
        'NDB ', 'VOR ', 'DME ', 'PAPI', 'APAPI', 'OBSTACLE', 'OBST ', 'CRACK', 'WORKS ON'
    ];

    var UAS_CATEGORY_ORDER = { uas_high: 0, uas_maybe: 1, other: 2, aerodrome_ground: 3 };

    function formatNotamDate(str) {
        if (str == null || str === '') return '';
        var raw = String(str).trim();
        var d;
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        function fmt(dt) {
            return dt.getUTCDate() + ' ' + months[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear() + ' ' +
                String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0') + ' UTC';
        }
        var m = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (m) {
            d = new Date(Date.UTC(+m[1], parseInt(m[2], 10) - 1, +m[3], +m[4], +m[5]));
            if (!isNaN(d.getTime())) return fmt(d);
        }
        m = raw.match(/\d{10}/);
        if (!m) return '';
        var s = m[0];
        var yy = parseInt(s.slice(0, 2), 10);
        var mm = parseInt(s.slice(2, 4), 10) - 1;
        var dd = parseInt(s.slice(4, 6), 10);
        var hh = parseInt(s.slice(6, 8), 10);
        var min = parseInt(s.slice(8, 10), 10);
        var year = yy >= 50 ? 1900 + yy : 2000 + yy;
        if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return '';
        d = new Date(Date.UTC(year, mm, dd, hh, min));
        return fmt(d);
    }

    function parseCoord(coordStr) {
        if (!coordStr || coordStr.length < 9) return null;
        var m = coordStr.match(/^(\d{4})([NS])(\d{5})([EW])$/);
        if (!m) return null;
        var lat = parseInt(m[1].slice(0, 2), 10) + parseInt(m[1].slice(2, 4), 10) / 60;
        if (m[2] === 'S') lat = -lat;
        var lng = parseInt(m[3].slice(0, 3), 10) + parseInt(m[3].slice(3, 5), 10) / 60;
        if (m[4] === 'W') lng = -lng;
        return [lat, lng];
    }

    function isDroneKeywordRelevant(notam) {
        var text = (notam && notam.text ? notam.text : '').toUpperCase();
        return DRONE_KEYWORDS.some(function (kw) { return text.includes(kw.toUpperCase()); });
    }

    function classifyNotamForUas(notam) {
        var text = (notam && notam.text ? notam.text : '').toUpperCase();
        if (isDroneKeywordRelevant(notam)) return 'uas_high';
        if (UAS_MAYBE_KEYWORDS.some(function (kw) { return text.includes(kw); })) return 'uas_maybe';
        if (AERODROME_GROUND_KEYWORDS.some(function (kw) { return text.includes(kw); })) return 'aerodrome_ground';
        return 'other';
    }

    /**
     * Q-line Lower/Upper in PIB are ICAO-style vertical limits (000–999); 0 ≈ SFC, 999 ≈ unlimited.
     */
    function formatVerticalFromQLine(lower, upper) {
        if (lower == null || upper == null) return '';
        var lo = Number(lower);
        var hi = Number(upper);
        if (isNaN(lo) || isNaN(hi)) return '';
        var lowStr = lo === 0 ? 'SFC' : 'FL' + String(Math.round(lo)).padStart(3, '0');
        var hiStr = hi >= 999 ? 'UNL' : 'FL' + String(Math.round(hi)).padStart(3, '0');
        return lowStr + ' – ' + hiStr;
    }

    function parseTextualVerticalFallback(text) {
        if (!text) return '';
        var t = String(text);
        var m = t.match(/FROM\s+SFC\s+TO\s+(\d+)\s*FT/i);
        if (m) return 'SFC – ' + m[1] + ' FT';
        m = t.match(/SFC\s*[-–]\s*(\d+)\s*FT/i);
        if (m) return 'SFC – ' + m[1] + ' FT';
        m = t.match(/(\d+)\s*FT\s*(?:ALT|AMSL)?\s*[-–]\s*(\d+)\s*FT/i);
        if (m) return m[1] + ' FT – ' + m[2] + ' FT';
        return '';
    }

    function notamRecordFromElement(el) {
        var coords = el.querySelector('Coordinates');
        var radius = el.querySelector('Radius');
        var itemE = el.querySelector('ItemE');
        var startVal = el.querySelector('StartValidity');
        var endVal = el.querySelector('EndValidity');
        var nof = el.querySelector('NOF');
        var series = el.querySelector('Series');
        var number = el.querySelector('Number');
        var year = el.querySelector('Year');
        var itemA = el.querySelector('ItemA');
        var qLine = el.querySelector('QLine');
        if (!coords || !coords.textContent) return null;
        var latLng = parseCoord(coords.textContent.trim());
        if (!latLng) return null;
        var radiusNm = radius && radius.textContent ? parseInt(radius.textContent.trim(), 10) || 0 : 0;
        var id =
            (nof ? nof.textContent : '') +
            (series ? series.textContent : '') +
            (number ? number.textContent : '') +
            '/' +
            (year ? year.textContent : '');
        var qLower = null;
        var qUpper = null;
        if (qLine) {
            var loEl = qLine.querySelector('Lower');
            var upEl = qLine.querySelector('Upper');
            if (loEl && loEl.textContent !== '') qLower = parseInt(loEl.textContent.trim(), 10);
            if (upEl && upEl.textContent !== '') qUpper = parseInt(upEl.textContent.trim(), 10);
            if (isNaN(qLower)) qLower = null;
            if (isNaN(qUpper)) qUpper = null;
        }
        var text = itemE ? itemE.textContent.trim() : '';
        var verticalSummary = formatVerticalFromQLine(qLower, qUpper);
        if (!verticalSummary) verticalSummary = parseTextualVerticalFallback(text);
        var rec = {
            id: id.trim(),
            lat: latLng[0],
            lng: latLng[1],
            radiusNm: radiusNm,
            text: text,
            startValidity: startVal ? startVal.textContent : '',
            endValidity: endVal ? endVal.textContent : '',
            itemA: itemA ? itemA.textContent.trim() : '',
            qLower: qLower,
            qUpper: qUpper,
            verticalSummary: verticalSummary
        };
        rec.uasCategory = classifyNotamForUas(rec);
        return rec;
    }

    function parsePibNotamsFromDoc(doc) {
        var notams = [];
        var notamEls = doc.querySelectorAll('Notam');
        notamEls.forEach(function (el) {
            var r = notamRecordFromElement(el);
            if (r) notams.push(r);
        });
        return notams;
    }

    function parsePibNotams(xmlText) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(xmlText, 'text/xml');
        return parsePibNotamsFromDoc(doc);
    }

    function extractPibValidity(doc) {
        var h = doc.querySelector('AreaPIBHeader');
        if (!h) return null;
        var vf = h.querySelector('Validity ValidFrom') || h.querySelector('ValidFrom');
        var vt = h.querySelector('Validity ValidTo') || h.querySelector('ValidTo');
        if (vf && vt && vf.textContent && vt.textContent) {
            return {
                effectiveFrom: vf.textContent.trim().slice(0, 10),
                effectiveTo: vt.textContent.trim().slice(0, 10)
            };
        }
        return null;
    }

    function fetchPibXml() {
        return fetch(PIB_URL + '?t=' + Date.now()).then(function (r) {
            if (!r.ok) throw new Error('PIB fetch failed');
            return r.text();
        });
    }

    function compareNotamsUasPriority(a, b) {
        var oa = UAS_CATEGORY_ORDER[a.uasCategory] != null ? UAS_CATEGORY_ORDER[a.uasCategory] : 9;
        var ob = UAS_CATEGORY_ORDER[b.uasCategory] != null ? UAS_CATEGORY_ORDER[b.uasCategory] : 9;
        if (oa !== ob) return oa - ob;
        return 0;
    }

    function notamBadgeMeta(category) {
        switch (category) {
            case 'uas_high':
                return { label: 'UAS / hazard', cssClass: 'badge-notam-uas-high' };
            case 'uas_maybe':
                return { label: 'UAS check', cssClass: 'badge-notam-uas-maybe' };
            case 'aerodrome_ground':
                return { label: 'Airfield ops', cssClass: 'badge-notam-ad' };
            default:
                return { label: 'NOTAM', cssClass: 'badge-notam-general' };
        }
    }

    function circleStyleForCategory(category, radiusNm, fillOpacity) {
        var fo = fillOpacity != null ? fillOpacity : 0.08;
        var r = radiusNm;
        var mult = r <= 3 ? 1.5 : r <= 10 ? 1 : 0.5;
        var base = { weight: r <= 3 ? 2 : r <= 10 ? 1.5 : 1, fillOpacity: Math.min(fo * mult, 0.22) };
        switch (category) {
            case 'uas_high':
                return Object.assign({ color: '#d97706', fillColor: '#f59e0b' }, base);
            case 'uas_maybe':
                return Object.assign({ color: '#c2410c', fillColor: '#ea580c' }, base);
            case 'aerodrome_ground':
                return Object.assign({ color: '#6b21a8', fillColor: '#9333ea' }, base);
            default:
                return Object.assign({ color: '#475569', fillColor: '#64748b' }, base);
        }
    }

    global.NotamPib = {
        PIB_URL: PIB_URL,
        fetchPibXml: fetchPibXml,
        parsePibNotams: parsePibNotams,
        parsePibNotamsFromDoc: parsePibNotamsFromDoc,
        extractPibValidity: extractPibValidity,
        formatNotamDate: formatNotamDate,
        parseCoord: parseCoord,
        isDroneKeywordRelevant: isDroneKeywordRelevant,
        classifyNotamForUas: classifyNotamForUas,
        formatVerticalFromQLine: formatVerticalFromQLine,
        compareNotamsUasPriority: compareNotamsUasPriority,
        notamBadgeMeta: notamBadgeMeta,
        circleStyleForCategory: circleStyleForCategory,
        UAS_CATEGORY_ORDER: UAS_CATEGORY_ORDER
    };
})(typeof window !== 'undefined' ? window : this);
