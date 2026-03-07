#!/usr/bin/env node
/**
 * Convert NATS UK ICAO AIP Dataset (AIXM 5.1 XML) to GeoJSON for AirPlot.
 *
 * Usage:
 *   node scripts/convert-aip-aixm.js <input.xml|input.zip>
 *   node scripts/convert-aip-aixm.js <input> -o assets/uk-aip-airspace.geojson
 *
 * The UK ICAO AIP Dataset can be downloaded from:
 *   https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/evaluation
 *   or https://www.nats.aero/ais/datasets (operational)
 * (Registration required. Select "UK ICAO AIP Dataset")
 *
 * The download is typically a ZIP containing AIXM XML file(s).
 * This script extracts airspace features (CTR, TMA, FIR, Prohibited, Restricted, Danger, etc.)
 * and outputs GeoJSON compatible with AirPlot's airspace module.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse args
const args = process.argv.slice(2);
let inputPath = null;
let outputPath = path.join(__dirname, '..', 'assets', 'uk-aip-airspace.geojson');

for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' && args[i + 1]) {
        outputPath = args[i + 1];
        i++;
    } else if (!args[i].startsWith('-')) {
        inputPath = args[i];
    }
}

if (!inputPath) {
    console.error(`
Usage: node scripts/convert-aip-aixm.js <input.xml|input.zip> [-o output.geojson]

  input.xml / input.zip  Path to NATS UK ICAO AIP Dataset (AIXM 5.1)
  -o output.geojson      Output path (default: assets/uk-aip-airspace.geojson)

To obtain the NATS data:
  1. Register at https://nats-uk.ead-it.com/cms-nats/opencms/en/registration/
  2. Log in at Digital Datasets (evaluation or operational)
  3. Download "UK ICAO AIP Dataset" - AIXM XML (often in a ZIP)
  4. Run: node scripts/convert-aip-aixm.js path/to/downloaded.zip
`);
    process.exit(1);
}

// Resolve input: if .zip, extract and find .xml inside
function resolveInputPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.zip') return filePath;
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const xmlEntries = entries.filter(e =>
        e.entryName.toLowerCase().endsWith('.xml') && !e.entryName.toLowerCase().includes('metadata')
    );
    const xmlEntry = xmlEntries.find(e => e.entryName.toLowerCase().includes('full')) || xmlEntries[0];
    if (!xmlEntry || xmlEntries.length === 0) {
        throw new Error('No AIXM XML file found inside ZIP (expected .xml, excluding *metadata*)');
    }
    const tmpDir = path.join(os.tmpdir(), 'nats-aip-aixm-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractEntryTo(xmlEntry, tmpDir, false, true);
    return path.join(tmpDir, path.basename(xmlEntry.entryName));
}

// Find elements by local name (handles namespaces)
function findByLocalName(parent, localName) {
    if (!parent || !parent.getElementsByTagName) return [];
    const all = parent.getElementsByTagName('*');
    const out = [];
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const name = (el.localName || el.tagName || '').split(':').pop();
        if (name === localName) out.push(el);
    }
    return out;
}

function getFirstByLocalName(parent, localName) {
    const found = findByLocalName(parent, localName);
    return found[0] || null;
}

function getTextContent(el) {
    if (!el) return '';
    const t = el.textContent || '';
    return t.replace(/\s+/g, ' ').trim();
}

// Parse GML posList to GeoJSON coordinates
// GML posList: space-separated. For EPSG:4326, axis order is typically lat lon (y x)
// GeoJSON: [lon, lat]
function parsePosList(posListText) {
    if (!posListText || typeof posListText !== 'string') return null;
    const parts = posListText.trim().split(/\s+/).map(parseFloat);
    if (parts.length < 4 || parts.length % 2 !== 0) return null;
    const coords = [];
    for (let i = 0; i < parts.length; i += 2) {
        const a = parts[i];
        const b = parts[i + 1];
        let lon, lat;
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
            lat = a;
            lon = b;
        } else if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
            lat = b;
            lon = a;
        } else {
            lon = a;
            lat = b;
        }
        coords.push([lon, lat]);
    }
    if (coords.length < 3) return null;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push([first[0], first[1]]);
    }
    return coords;
}

// Extract polygon from gml:pos elements (NATS uses pointProperty -> Point -> pos)
function extractPolygonFromPosElements(container) {
    const posEls = findByLocalName(container, 'pos');
    if (posEls.length < 3) return null;
    const coords = [];
    for (let i = 0; i < posEls.length; i++) {
        const t = getTextContent(posEls[i]);
        const parts = t.trim().split(/\s+/).map(parseFloat);
        if (parts.length >= 2) {
            const a = parts[0];
            const b = parts[1];
            let lon, lat;
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
                lat = a;
                lon = b;
            } else if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
                lat = b;
                lon = a;
            } else {
                lon = a;
                lat = b;
            }
            coords.push([lon, lat]);
        }
    }
    if (coords.length < 3) return null;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push([first[0], first[1]]);
    }
    return coords;
}

// Extract polygon from GML Surface/Polygon (handles posList and gml:pos)
function extractPolygonFromGml(el) {
    const posList = getFirstByLocalName(el, 'posList');
    if (posList) {
        const coords = parsePosList(getTextContent(posList));
        if (coords) return coords;
    }
    const coordsFromPos = extractPolygonFromPosElements(el);
    if (coordsFromPos) return coordsFromPos;
    const posEls = el.getElementsByTagName ? el.getElementsByTagName('*') : [];
    for (let i = 0; i < posEls.length; i++) {
        const p = posEls[i];
        const local = (p.localName || p.tagName || '').split(':').pop();
        if (local === 'posList') {
            const coords = parsePosList(getTextContent(p));
            if (coords) return coords;
        }
    }
    return null;
}

// Extract geometry from AirspaceVolume
function extractGeometry(airspaceVolume) {
    const horiz = getFirstByLocalName(airspaceVolume, 'horizontalProjection');
    if (!horiz) return null;
    const surface = getFirstByLocalName(horiz, 'Surface') || getFirstByLocalName(horiz, 'Polygon') || horiz;
    const patches = findByLocalName(surface, 'polygonPatch') || findByLocalName(surface, 'exterior');
    if (patches.length > 0) {
        for (let i = 0; i < patches.length; i++) {
            const ring = getFirstByLocalName(patches[i], 'Ring') || getFirstByLocalName(patches[i], 'LinearRing') || patches[i];
            const curveMember = getFirstByLocalName(ring, 'curveMember') || getFirstByLocalName(ring, 'LineString');
            const target = curveMember || ring;
            const coords = extractPolygonFromGml(target);
            if (coords && coords.length >= 3) return coords;
        }
    }
    const coords = extractPolygonFromGml(surface);
    if (coords && coords.length >= 3) return coords;
    return null;
}

// Extract vertical limits
function extractLimits(airspaceVolume) {
    let lower = 'SFC';
    let upper = 'UNL';
    const lowerEl = getFirstByLocalName(airspaceVolume, 'lowerLimit');
    const upperEl = getFirstByLocalName(airspaceVolume, 'upperLimit');
    if (lowerEl) lower = getTextContent(lowerEl) || 'SFC';
    if (upperEl) upper = getTextContent(upperEl) || 'UNL';
    return { lower, upper };
}

// Extract effective date from filename
function extractEffectiveDate(filePath) {
    const name = path.basename(filePath, path.extname(filePath));
    const m = name.match(/(\d{8})/);
    if (!m) return null;
    const yyyymmdd = m[1];
    const year = parseInt(yyyymmdd.slice(0, 4), 10);
    const month = parseInt(yyyymmdd.slice(4, 6), 10);
    const day = parseInt(yyyymmdd.slice(6, 8), 10);
    const from = new Date(year, month - 1, day);
    const to = new Date(from);
    to.setDate(to.getDate() + 28);
    return {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10)
    };
}

async function main() {
    const inputExt = path.extname(inputPath).toLowerCase();
    if (inputExt !== '.xml' && inputExt !== '.zip') {
        console.error('Input file must be .xml or .zip');
        process.exit(1);
    }

    if (!fs.existsSync(inputPath)) {
        console.error('Input file not found:', inputPath);
        process.exit(1);
    }
    console.log('Reading input:', inputPath);
    const resolvedPath = inputExt === '.zip' ? resolveInputPath(inputPath) : inputPath;
    let xmlContent = fs.readFileSync(resolvedPath, 'utf8');

    const DOMParser = require('@xmldom/xmldom').DOMParser;
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');

    const features = [];
    const allEls = doc.getElementsByTagName('*');
    const airspaces = [];
    for (let i = 0; i < allEls.length; i++) {
        const el = allEls[i];
        const local = (el.localName || el.tagName || '').split(':').pop();
        if (local === 'Airspace') airspaces.push(el);
    }
    for (let i = 0; i < airspaces.length; i++) {
        const airspace = airspaces[i];
        const timeSlice = getFirstByLocalName(airspace, 'timeSlice') ||
            getFirstByLocalName(airspace, 'AirspaceTimeSlice') ||
            getFirstByLocalName(airspace, 'hasTimeSlice');
        if (!timeSlice) continue;

        const designator = getTextContent(getFirstByLocalName(timeSlice, 'designator'));
        const name = getTextContent(getFirstByLocalName(timeSlice, 'name'));
        const typeEl = getFirstByLocalName(timeSlice, 'type');
        const type = typeEl ? getTextContent(typeEl) : '';

        const geomComp = getFirstByLocalName(timeSlice, 'geometryComponent') ||
            getFirstByLocalName(timeSlice, 'hasGeometryComponent');
        let volume = geomComp && getFirstByLocalName(geomComp, 'AirspaceVolume');
        if (!volume && geomComp) {
            const theVol = getFirstByLocalName(geomComp, 'theAirspaceVolume');
            volume = theVol && getFirstByLocalName(theVol, 'AirspaceVolume');
        }
        if (!volume) {
            const volumes = findByLocalName(timeSlice, 'AirspaceVolume');
            volume = volumes[0] || null;
        }
        if (!volume) continue;

        const coords = extractGeometry(volume);
        if (!coords || coords.length < 3) continue;

        const { lower, upper } = extractLimits(volume);

        features.push({
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [coords]
            },
            properties: {
                designator: designator || '',
                name: name || designator || 'Unnamed',
                type: type,
                lowerLimit: lower,
                upperLimit: upper,
                source: 'NATS UK ICAO AIP'
            }
        });
    }

    if (features.length === 0) {
        const msg = doc.getElementsByTagName('parsererror').length
            ? 'XML parse error. Check the file is valid AIXM.'
            : 'No airspace features found. The file may use a different structure.';
        console.error(msg);
        process.exit(1);
    }

    const effectiveDate = extractEffectiveDate(inputPath);
    const geojson = {
        type: 'FeatureCollection',
        metadata: effectiveDate ? {
            effectiveFrom: effectiveDate.from,
            effectiveTo: effectiveDate.to,
            source: 'NATS UK ICAO AIP Dataset'
        } : { source: 'NATS UK ICAO AIP Dataset' },
        features: features
    };

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(geojson, null, 2), 'utf8');
    console.log('Wrote', features.length, 'airspace features to', outputPath);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
