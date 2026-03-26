#!/usr/bin/env node
/**
 * Serves the project root on PORT (default 8081, or next free if busy) and proxies GET /api/adsb → ADSB.lol.
 * Browsers cannot call api.adsb.lol directly (no CORS); use this instead of python -m http.server.
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
  let upstream;
  if (hexParam != null && hexParam !== '') {
    const hex = String(hexParam)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, '');
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid hex' }));
      return;
    }
    upstream = `https://api.adsb.lol/v2/hex/${hex}`;
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
    upstream = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
  }
  https
    .get(upstream, { headers: { Accept: 'application/json' } }, (upstreamRes) => {
      const code = upstreamRes.statusCode || 502;
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      upstreamRes.pipe(res);
    })
    .on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream fetch failed' }));
    });
}

function serveStatic(req, res) {
  const u = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');
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

function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/adsb') {
    handleAdsbProxy(req, res);
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
    console.log('AirPlot dev: http://localhost:' + port + '/');
    console.log('  /api/adsb → https://api.adsb.lol (CORS proxy for Airspace)');
  });
}

listenFrom(START_PORT);
