#!/usr/bin/env node
/**
 * Convert NATS UK UAS Airspace data (KML/KMZ) to GeoJSON for AirPlot.
 *
 * Usage:
 *   node scripts/convert-airspace-data.js <input.kml|input.kmz>
 *   node scripts/convert-airspace-data.js <input.kml|input.kmz> -o assets/uk-airspace.geojson
 *
 * The NATS UAS Flight Restrictions file can be downloaded from:
 *   https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/
 * (Registration required. Select "UAS Flight Restrictions" / "UAS Airspace Restrictions File (ENR 5.1)")
 *
 * The file is typically provided as KMZ (zipped KML). This script handles both KML and KMZ.
 */

const fs = require('fs');
const path = require('path');

// Parse args
const args = process.argv.slice(2);
let inputPath = null;
let outputPath = path.join(__dirname, '..', 'assets', 'uk-airspace.geojson');

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
Usage: node scripts/convert-airspace-data.js <input.kml|input.kmz> [-o output.geojson]

  input.kml / input.kmz  Path to NATS UAS Airspace Restrictions file
  -o output.geojson      Output path (default: assets/uk-airspace.geojson)

To obtain the NATS data:
  1. Register at https://nats-uk.ead-it.com/cms-nats/opencms/en/registration/
  2. Log in at https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/
  3. Download "UAS Flight Restrictions" (ENR 5.1) - typically a KMZ file
  4. Run this script: node scripts/convert-airspace-data.js path/to/downloaded.kmz
`);
    process.exit(1);
}

const inputExt = path.extname(inputPath).toLowerCase();
if (inputExt !== '.kml' && inputExt !== '.kmz') {
    console.error('Input file must be .kml or .kmz');
    process.exit(1);
}

// Load KML content (handle KMZ = zip)
function loadKmlContent(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.kmz') {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(filePath);
            const entries = zip.getEntries();
            const kmlEntry = entries.find(e =>
                e.entryName.toLowerCase().endsWith('.kml') || e.entryName === 'doc.kml'
            );
            if (!kmlEntry) {
                throw new Error('No .kml file found inside KMZ archive');
            }
            return kmlEntry.getData().toString('utf8');
        } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') {
                throw new Error('adm-zip required for KMZ. Run: npm install adm-zip');
            }
            throw e;
        }
    }
    return fs.readFileSync(filePath, 'utf8');
}

// Convert and run
async function main() {
    let togeojson;
    let DOMParser;

    try {
        togeojson = require('@tmcw/togeojson');
    } catch (e) {
        console.error('Missing dependency. Run: npm install @tmcw/togeojson xmldom adm-zip');
        process.exit(1);
    }

    try {
        DOMParser = require('@xmldom/xmldom').DOMParser;
    } catch (e) {
        try {
            DOMParser = require('xmldom').DOMParser;
        } catch (e2) {
            console.error('Missing xmldom. Run: npm install @tmcw/togeojson @xmldom/xmldom adm-zip');
            process.exit(1);
        }
    }

    console.log('Reading input:', inputPath);
    const kmlContent = loadKmlContent(inputPath);

    console.log('Parsing KML...');
    const parser = new DOMParser();
    const kmlDoc = parser.parseFromString(kmlContent, 'text/xml');

    console.log('Converting to GeoJSON...');
    const geojson = togeojson.kml(kmlDoc);

    if (!geojson || !geojson.features) {
        console.error('Conversion produced no features. Check the input file.');
        process.exit(1);
    }

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

    // Map NATS KML properties to AirPlot format
    // NATS designators: EGD### (Danger), EGP### (Prohibited), EGR### (Restricted), EGRU### (UAS Restricted), FRZ
    const effectiveDate = extractEffectiveDate(inputPath);
    const mapped = {
        type: 'FeatureCollection',
        metadata: effectiveDate ? {
            effectiveFrom: effectiveDate.from,
            effectiveTo: effectiveDate.to,
            source: 'NATS UAS ENR 5.1'
        } : undefined,
        features: geojson.features.map(f => {
            const p = f.properties || {};
            const name = (p.name || '').trim();
            // Extract designator: "EGD001 TREVOSE HEAD" -> EGD001, or from ExtendedData
            let designator = p.designator || p.id || p.Identifier || '';
            if (!designator && name) {
                const m = name.match(/^(EG[DPRU][A-Z0-9]+(?:\s+[A-Z0-9]+)*)/i);
                if (m) designator = m[1].split(/\s+/)[0].toUpperCase();
            }

            return {
                type: 'Feature',
                geometry: f.geometry,
                properties: {
                    designator: designator,
                    name: name || designator || 'Unnamed',
                    description: p.description || undefined,
                    lowerLimit: p.lower || p.lowerLimit || p.LowerLimit || p['lower limit'],
                    upperLimit: p.upper || p.upperLimit || p.UpperLimit || p['upper limit'],
                    activation: p.activation || p.hours || p.Activation || p.operatingTimes,
                    ...p
                }
            };
        })
    };

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(mapped, null, 2), 'utf8');
    console.log('Wrote', mapped.features.length, 'features to', outputPath);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
