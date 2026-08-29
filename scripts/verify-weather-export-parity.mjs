#!/usr/bin/env node
/**
 * Static + unit checks for weather PPTX/PDF export parity with on-screen report.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../js/weather.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

// --- Unit tests for shared helper logic (mirrors js/weather.js) ---
function formatPrecipWithProb(precip, precipProb) {
    if (precip == null) return '-';
    var mm = Math.round(precip * 10) / 10;
    if (precipProb != null) return mm + ' mm (' + Math.round(precipProb) + '% chance)';
    return String(mm) + ' mm';
}

function formatHourlyPrecipCell(p, pProb) {
    if (p != null && p > 0) {
        return pProb != null ? Math.round(p * 10) / 10 + ' mm (' + Math.round(pProb) + '%)' : String(Math.round(p * 10) / 10) + ' mm';
    }
    if (pProb != null) return Math.round(pProb) + '%';
    return '0';
}

function formatCloudCoverStr(cloudTotal, cloudLow) {
    if (cloudTotal == null) return '-';
    if (cloudLow != null) return Math.round(cloudTotal) + '% total, ' + Math.round(cloudLow) + '% low';
    return Math.round(cloudTotal) + '%';
}

assert(formatPrecipWithProb(0, 35) === '0 mm (35% chance)', 'precip with zero mm but probability');
assert(formatPrecipWithProb(1.5, 80) === '1.5 mm (80% chance)', 'precip with mm and probability');
assert(formatPrecipWithProb(0.4, null) === '0.4 mm', 'precip mm only');
assert(formatHourlyPrecipCell(0, 45) === '45%', 'hourly precip probability only');
assert(formatHourlyPrecipCell(1.2, 80) === '1.2 mm (80%)', 'hourly precip mm and prob');
assert(formatHourlyPrecipCell(0, null) === '0', 'hourly precip dry');
assert(formatCloudCoverStr(75, 20) === '75% total, 20% low', 'cloud cover');

const staticChecks = [
    ['PPTX forecast hour source label', /exportWeatherPptx[\s\S]*?formatForecastHourSourceLabel/],
    ['PDF forecast hour source label', /exportWeatherPdf[\s\S]*?formatForecastHourSourceLabel/],
    ['PPTX how-calculated slide', /exportWeatherPptx[\s\S]*?How This Is Calculated[\s\S]*?buildWeatherHowCalculatedPlainLines/],
    ['PDF how-calculated page', /exportWeatherPdf[\s\S]*?How This Is Calculated[\s\S]*?buildWeatherHowCalculatedPlainLines/],
    ['PPTX hourly precip helper', /exportWeatherPptx[\s\S]*?formatHourlyPrecipCell/],
    ['PDF hourly precip helper', /exportWeatherPdf[\s\S]*?formatHourlyPrecipCell/],
    ['PDF 12-hour summary text', /exportWeatherPdf[\s\S]*?deriveSummaryText\(lastHourlySlice/],
    ['PDF 120m wind with direction', /exportWeatherPdf[\s\S]*?formatWindRow\(data\.wind_speed_120m/],
    ['PDF METAR observed time', /exportWeatherPdf[\s\S]*?Observed:/],
    ['PPTX METAR observed time', /exportWeatherPptx[\s\S]*?Observed:/],
    ['PDF TAF issued/valid', /exportWeatherPdf[\s\S]*?Issued:/],
    ['PPTX TAF issued/valid', /exportWeatherPptx[\s\S]*?Issued:/],
    ['NOTAM AD in PPTX builder', /buildWeatherNotamPptxLines[\s\S]*?n\.itemA/],
    ['NOTAM AD in PDF detail', /buildWeatherPdfAirspaceDetail[\s\S]*?n\.itemA/],
    ['Airspace distance in PPTX', /buildWeatherAirspacePptxLines[\s\S]*?airspaceNearestDistKm/],
    ['Airspace distance in PDF detail', /buildWeatherPdfAirspaceDetail[\s\S]*?airspaceNearestDistKm/],
    ['Aviation error PPTX', /exportWeatherPptx[\s\S]*?lastAviationData\.error/],
    ['Aviation error PDF', /exportWeatherPdf[\s\S]*?lastAviationData\.error/],
    ['Aviation empty PPTX', /exportWeatherPptx[\s\S]*?No aerodromes with METAR/],
    ['Aviation empty PDF', /exportWeatherPdf[\s\S]*?No aerodromes with METAR/],
    ['PDF precip with probability', /exportWeatherPdf[\s\S]*?formatPrecipWithProb/],
];

let failed = 0;
for (const [name, re] of staticChecks) {
    if (!re.test(src)) {
        console.error('FAIL:', name);
        failed++;
    } else {
        console.log('OK:', name);
    }
}

if (failed) {
    console.error('\n' + failed + ' static check(s) failed.');
    process.exit(1);
}

console.log('\nAll weather export parity checks passed.');
