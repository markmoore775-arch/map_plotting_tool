#!/usr/bin/env node
/**
 * Serves the project root on PORT (default 8081, or next free if busy) and proxies:
 * - GET /api/adsb → ADSB.lol (primary), airplanes.live fallback
 * - GET /api/ogn → Open Glider Network live feed (lxml.php; CORS proxy for Airspace)
 * - GET /api/aviation → aviationweather.gov (METAR/TAF JSON; same contract as worker.js)
 * Browsers cannot call those APIs directly (CORS); use this instead of python -m http.server.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const START_PORT = Number(process.env.PORT) || 8081;
/** Try up to this many consecutive ports if START_PORT is in use */
const PORT_TRY_COUNT = 30;

const ADSB_CACHE_MS = 5000;
const ADSB_UPSTREAM_HEADERS = { Accept: 'application/json' };
/** @type {Map<string, { body: string, storedAt: number, source: string }>} */
const adsbResponseCache = new Map();

function roundAdsbCoord(value) {
  return Math.round(value * 100) / 100;
}

function adsbCacheKeyFromQuery(query) {
  if (query.hex) return 'hex:' + query.hex;
  return 'area:' + query.latKey + ',' + query.lonKey + ',' + query.distKey;
}

function fetchAdsbUpstreamText(url) {
  return new Promise(function (resolve, reject) {
    https
      .get(url, { headers: ADSB_UPSTREAM_HEADERS }, function (upstreamRes) {
        const chunks = [];
        upstreamRes.on('data', function (chunk) {
          chunks.push(chunk);
        });
        upstreamRes.on('end', function () {
          resolve({
            status: upstreamRes.statusCode || 502,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      })
      .on('error', reject);
  });
}

async function fetchAdsbWithFailover(query) {
  let primaryUrl;
  let fallbackUrl;
  if (query.hex) {
    primaryUrl = 'https://api.adsb.lol/v2/hex/' + query.hex;
    fallbackUrl = 'https://api.airplanes.live/v2/hex/' + query.hex;
  } else {
    primaryUrl =
      'https://api.adsb.lol/v2/lat/' +
      query.latKey +
      '/lon/' +
      query.lonKey +
      '/dist/' +
      query.distKey;
    fallbackUrl =
      'https://api.airplanes.live/v2/point/' +
      query.latKey +
      '/' +
      query.lonKey +
      '/' +
      query.distKey;
  }

  let primary = await fetchAdsbUpstreamText(primaryUrl);
  if (primary.status === 429) {
    await new Promise(function (resolve) {
      setTimeout(resolve, 1500);
    });
    primary = await fetchAdsbUpstreamText(primaryUrl);
  }
  if (primary.status >= 200 && primary.status < 300) {
    return { ok: true, body: primary.body, source: 'adsblol' };
  }

  const fallback = await fetchAdsbUpstreamText(fallbackUrl);
  if (fallback.status >= 200 && fallback.status < 300) {
    return { ok: true, body: fallback.body, source: 'airplaneslive' };
  }

  return {
    ok: false,
    status: primary.status === 429 || fallback.status === 429 ? 429 : 502
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

function safePath(rel) {
  const resolved = path.resolve(ROOT, rel);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

function handleAdsbProxy(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const hexParam = u.searchParams.get('hex');
  let query;

  if (hexParam != null && hexParam !== '') {
    const hex = String(hexParam)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, '');
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid hex' }));
      return;
    }
    query = { hex };
  } else {
    const lat = Number(u.searchParams.get('lat'));
    const lon = Number(u.searchParams.get('lon'));
    const dist = Number(u.searchParams.get('dist'));
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid lat' }));
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid lon' }));
      return;
    }
    if (!Number.isFinite(dist) || dist < 1 || dist > 250) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid dist' }));
      return;
    }
    const latKey = roundAdsbCoord(lat);
    const lonKey = roundAdsbCoord(lon);
    const distKey = Math.round(dist);
    query = { latKey, lonKey, distKey, hex: null };
  }

  const cacheKey = adsbCacheKeyFromQuery(query);
  const cached = adsbResponseCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.storedAt < ADSB_CACHE_MS) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=5',
      'X-AirPlan-Source': cached.source
    });
    res.end(cached.body);
    return;
  }

  fetchAdsbWithFailover(query)
    .then(function (result) {
      if (result.ok) {
        adsbResponseCache.set(cacheKey, {
          body: result.body,
          storedAt: now,
          source: result.source
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=5',
          'X-AirPlan-Source': result.source
        });
        res.end(result.body);
        return;
      }

      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=5',
          'X-AirPlan-Cache': 'stale',
          'X-AirPlan-Source': 'stale'
        });
        res.end(cached.body);
        return;
      }

      const status = result.status === 429 ? 429 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
    })
    .catch(function () {
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=5',
          'X-AirPlan-Cache': 'stale',
          'X-AirPlan-Source': 'stale'
        });
        res.end(cached.body);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
    });

  if (cached && now - cached.storedAt > ADSB_CACHE_MS * 4) {
    adsbResponseCache.delete(cacheKey);
  }
}

function handleOgnProxy(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const a = String(u.searchParams.get('a') || '0');
  const b = Number(u.searchParams.get('b'));
  const c = Number(u.searchParams.get('c'));
  const d = Number(u.searchParams.get('d'));
  const e = Number(u.searchParams.get('e'));
  const z = String(u.searchParams.get('z') || '0');

  if (a !== '0' && a !== '1') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid a (use 0 or 1)' }));
    return;
  }
  if (!Number.isFinite(b) || b < -90 || b > 90) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid b (north lat)' }));
    return;
  }
  if (!Number.isFinite(c) || c < -90 || c > 90) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid c (south lat)' }));
    return;
  }
  if (!Number.isFinite(d) || d < -180 || d > 180) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid d (east lon)' }));
    return;
  }
  if (!Number.isFinite(e) || e < -180 || e > 180) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid e (west lon)' }));
    return;
  }

  const qs = new URLSearchParams({
    a,
    b: b.toFixed(6),
    c: c.toFixed(6),
    d: d.toFixed(6),
    e: e.toFixed(6),
    z
  });
  const upstream = 'https://live.glidernet.org/lxml.php?' + qs.toString();

  https
    .get(upstream, { headers: { Accept: 'application/xml, text/xml, */*' } }, (upstreamRes) => {
      const code = upstreamRes.statusCode || 502;
      res.writeHead(code, {
        'Content-Type': 'text/xml; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      upstreamRes.pipe(res);
    })
    .on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Upstream fetch failed');
    });
}

function handleAviationProxy(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const type = String(u.searchParams.get('type') || '').toLowerCase();
  const idsRaw = String(u.searchParams.get('ids') || '').toUpperCase();
  const ids = idsRaw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[A-Z0-9]{3,6}$/.test(v))
    .slice(0, 20);

  if ((type !== 'metar' && type !== 'taf') || ids.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Invalid query. Expected type=metar|taf and ids=ICAO,ICAO...' }));
    return;
  }

  const endpoint =
    'https://aviationweather.gov/api/data/' +
    type +
    '?ids=' +
    encodeURIComponent(ids.join(',')) +
    '&format=json';

  https
    .get(endpoint, { headers: { Accept: 'application/json' } }, (upstreamRes) => {
      const code = upstreamRes.statusCode || 502;
      if (code < 200 || code >= 300) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Upstream returned HTTP ' + code }));
        upstreamRes.resume();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      });
      upstreamRes.pipe(res);
    })
    .on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
    });
}

function serveStatic(req, res) {
  const u = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');
  if (rel === 'favicon.ico') {
    const rootIco = safePath('favicon.ico');
    if (!rootIco || !fs.existsSync(rootIco)) {
      const svg = safePath('assets/airplan-icon.svg');
      if (svg && fs.existsSync(svg)) rel = 'assets/airplan-icon.svg';
    }
  }
  let filePath = safePath(rel);
  if (!filePath) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(filePath)) {
    const withHtml = filePath + '.html';
    if (fs.existsSync(withHtml)) filePath = withHtml;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function normalizeApiPathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = normalizeApiPathname(u.pathname);
  if (pathname === '/api/adsb') {
    handleAdsbProxy(req, res);
  } else if (pathname === '/api/ogn') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    handleOgnProxy(req, res);
  } else if (pathname === '/api/aviation') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    handleAviationProxy(req, res);
  } else {
    serveStatic(req, res);
  }
}

function listenFrom(port) {
  const maxPort = START_PORT + PORT_TRY_COUNT - 1;
  const server = http.createServer(handleRequest);
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE' && port < maxPort) {
      console.warn('Port ' + port + ' in use, trying ' + (port + 1) + '…');
      listenFrom(port + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, function () {
    console.log('AirPlan dev: http://localhost:' + port + '/');
    console.log('  /api/adsb → ADSB.lol, then airplanes.live fallback (CORS proxy for Airspace)');
    console.log('  /api/ogn → https://live.glidernet.org (OGN lxml; CORS proxy for Airspace)');
    console.log('  /api/aviation → aviationweather.gov METAR/TAF (CORS proxy for Flight Weather)');
  });
}

listenFrom(START_PORT);
