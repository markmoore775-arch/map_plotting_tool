#!/usr/bin/env node
/**
 * Fetch aviation stations from OpenFlights data for METAR/TAF lookup.
 * Output: assets/aviation-stations.json
 * Run: node scripts/fetch-aviation-stations.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';
const OUT = path.join(__dirname, '../assets/aviation-stations.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === ',' && !inQuotes) || c === '\n') {
      result.push(current.replace(/^"|"$/g, '').replace(/\\N/g, ''));
      current = '';
      if (c === '\n') break;
    } else {
      current += c;
    }
  }
  if (current) result.push(current.replace(/^"|"$/g, '').replace(/\\N/g, ''));
  return result;
}

async function main() {
  console.log('Fetching OpenFlights airports data...');
  const data = await fetch(URL);
  const lines = data.split('\n');
  const stations = [];
  const seen = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 8) continue;
    const [id, name, city, country, iata, icao, lat, lon] = cols;
    if (!icao || icao.length !== 4 || !/^[A-Z]{4}$/i.test(icao)) continue;
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (isNaN(latNum) || isNaN(lonNum)) continue;
    if (seen.has(icao.toUpperCase())) continue;
    seen.add(icao.toUpperCase());
    stations.push({
      icao: icao.toUpperCase(),
      name: name || city || icao,
      lat: latNum,
      lon: lonNum
    });
  }

  console.log(`Writing ${stations.length} stations to ${OUT}`);
  fs.writeFileSync(OUT, JSON.stringify(stations), 'utf8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
