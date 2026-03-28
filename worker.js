const SESSION_COOKIE = 'airplot_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours
const DEFAULT_NEXT_PATH = '/index.html?autostart=1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (path === '/api/aviation') {
      return handleAviationApi(request);
    }

    if (path === '/api/adsb') {
      return handleAdsbApi(request);
    }

    if (path === '/api/ogn') {
      return handleOgnApi(request);
    }

    // Temporary test mode: disable all password protection.
    if (path === '/unlock' || path === '/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: DEFAULT_NEXT_PATH,
          'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
        }
      });
    }

    // Backwards compatibility: old launch links may still target /app.
    if (path === '/app') {
      const targetUrl = new URL(request.url);
      targetUrl.pathname = '/index.html';
      targetUrl.searchParams.set('autostart', '1');
      return env.ASSETS.fetch(new Request(targetUrl.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};

function isProtectedRoute(pathname) {
  const path = normalizePath(pathname);
  return path === '/app'
    || path === '/weather'
    || path === '/weather.html'
    || path === '/flight-planning'
    || path === '/flight-planning.html';
}

function normalizePath(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function parseCookies(cookieHeader) {
  const out = {};
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function normalizeNextPath(nextRaw) {
  if (!nextRaw || typeof nextRaw !== 'string') return DEFAULT_NEXT_PATH;
  if (!nextRaw.startsWith('/')) return DEFAULT_NEXT_PATH;
  if (nextRaw.startsWith('//')) return DEFAULT_NEXT_PATH;
  if (nextRaw.startsWith('/unlock')) return DEFAULT_NEXT_PATH;
  return nextRaw;
}

async function handleAdsbApi(request) {
  if (request.method.toUpperCase() !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const hexRaw = url.searchParams.get('hex');
  let upstreamUrl;

  if (hexRaw != null && hexRaw !== '') {
    const hex = String(hexRaw)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, '');
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      return jsonResponse({ error: 'Invalid hex (expect 6 hex chars)' }, 400);
    }
    upstreamUrl = `https://api.adsb.lol/v2/hex/${hex}`;
  } else {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const dist = Number(url.searchParams.get('dist'));

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return jsonResponse({ error: 'Invalid lat' }, 400);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      return jsonResponse({ error: 'Invalid lon' }, 400);
    }
    if (!Number.isFinite(dist) || dist < 1 || dist > 250) {
      return jsonResponse({ error: 'Invalid dist (nm)' }, 400);
    }

    upstreamUrl =
      `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
  }

  const upstream = await fetch(upstreamUrl, {
    headers: { Accept: 'application/json' }
  });

  if (!upstream.ok) {
    return jsonResponse(
      { error: `Upstream returned HTTP ${upstream.status}` },
      502
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleOgnApi(request) {
  if (request.method.toUpperCase() !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const a = String(url.searchParams.get('a') || '0');
  const b = Number(url.searchParams.get('b'));
  const c = Number(url.searchParams.get('c'));
  const d = Number(url.searchParams.get('d'));
  const e = Number(url.searchParams.get('e'));
  const z = String(url.searchParams.get('z') || '0');

  if (a !== '0' && a !== '1') {
    return jsonResponse({ error: 'Invalid a (use 0 or 1)' }, 400);
  }
  if (!Number.isFinite(b) || b < -90 || b > 90) {
    return jsonResponse({ error: 'Invalid b (north lat)' }, 400);
  }
  if (!Number.isFinite(c) || c < -90 || c > 90) {
    return jsonResponse({ error: 'Invalid c (south lat)' }, 400);
  }
  if (!Number.isFinite(d) || d < -180 || d > 180) {
    return jsonResponse({ error: 'Invalid d (east lon)' }, 400);
  }
  if (!Number.isFinite(e) || e < -180 || e > 180) {
    return jsonResponse({ error: 'Invalid e (west lon)' }, 400);
  }

  const qs = new URLSearchParams({
    a,
    b: b.toFixed(6),
    c: c.toFixed(6),
    d: d.toFixed(6),
    e: e.toFixed(6),
    z
  });
  const upstreamUrl = 'https://live.glidernet.org/lxml.php?' + qs.toString();

  const upstream = await fetch(upstreamUrl, {
    headers: { Accept: 'application/xml, text/xml, */*' }
  });

  if (!upstream.ok) {
    return jsonResponse(
      { error: `Upstream returned HTTP ${upstream.status}` },
      502
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleAviationApi(request) {
  if (request.method.toUpperCase() !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const type = String(url.searchParams.get('type') || '').toLowerCase();
  const idsRaw = String(url.searchParams.get('ids') || '').toUpperCase();
  const ids = idsRaw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[A-Z0-9]{3,6}$/.test(v))
    .slice(0, 20);

  if ((type !== 'metar' && type !== 'taf') || ids.length === 0) {
    return jsonResponse({ error: 'Invalid query. Expected type=metar|taf and ids=ICAO,ICAO...' }, 400);
  }

  const endpoint = `https://aviationweather.gov/api/data/${type}?ids=${encodeURIComponent(ids.join(','))}&format=json`;
  const upstream = await fetch(endpoint, {
    headers: { Accept: 'application/json' }
  });

  if (!upstream.ok) {
    return jsonResponse({ error: `Upstream returned HTTP ${upstream.status}` }, 502);
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }
  });
}

function redirectToUnlock(nextPath) {
  const loc = '/unlock?next=' + encodeURIComponent(nextPath);
  return new Response(null, {
    status: 302,
    headers: { Location: loc }
  });
}

async function handleUnlock(request, env) {
  const url = new URL(request.url);
  const next = normalizeNextPath(url.searchParams.get('next') || DEFAULT_NEXT_PATH);
  const isPost = request.method.toUpperCase() === 'POST';

  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const existingSession = cookies[SESSION_COOKIE] || '';
  const alreadyAuthenticated = await verifySessionToken(existingSession, env.AUTH_SECRET || '');
  if (alreadyAuthenticated && !isPost) {
    return new Response(null, {
      status: 302,
      headers: { Location: next }
    });
  }

  if (!isPost) {
    return htmlResponse(renderUnlockPage({ next, error: '' }));
  }

  const form = await request.formData();
  const password = String(form.get('password') || '');
  const postedNext = normalizeNextPath(String(form.get('next') || next));
  const expected = env.SITE_PASS || '';

  if (!expected) {
    return htmlResponse(renderUnlockPage({
      next: postedNext,
      error: 'Password protection is not configured yet.'
    }), 500);
  }

  if (!constantTimeEqual(password, expected)) {
    return htmlResponse(renderUnlockPage({
      next: postedNext,
      error: 'Incorrect password. Please try again.'
    }), 401);
  }

  if (!env.AUTH_SECRET) {
    return htmlResponse(renderUnlockPage({
      next: postedNext,
      error: 'Server auth secret is missing. Ask admin to set AUTH_SECRET.'
    }), 500);
  }

  const token = await createSessionToken(env.AUTH_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      Location: postedNext,
      'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
    }
  });
}

function renderUnlockPage({ next, error }) {
  const safeNext = escapeHtml(next || DEFAULT_NEXT_PATH);
  const safeError = error ? `<p class="error">${escapeHtml(error)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unlock AirPlot</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at 20% 10%, #22233a 0%, #0a0a0f 50%, #050508 100%);
      color: #f4f4f5;
      font-family: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
    }
    .card {
      width: min(92vw, 420px);
      background: rgba(21, 21, 31, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 24px;
      box-shadow: 0 20px 45px rgba(0,0,0,0.45);
    }
    h1 { margin: 0 0 8px; font-size: 1.35rem; font-weight: 700; }
    p { margin: 0 0 16px; color: #c9c9cf; line-height: 1.45; }
    label { display: block; margin: 10px 0 6px; font-weight: 600; font-size: 0.92rem; }
    input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 13px;
      border-radius: 10px;
      border: 1px solid #3d3d4f;
      background: #101018;
      color: #fff;
      outline: none;
    }
    input[type="password"]:focus { border-color: #5b8def; }
    button {
      margin-top: 14px;
      width: 100%;
      border: 0;
      border-radius: 10px;
      padding: 12px;
      font-size: 0.95rem;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      cursor: pointer;
    }
    button:hover { filter: brightness(1.08); }
    .error {
      margin: 0 0 10px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(220, 38, 38, 0.16);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fecaca;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Enter Password</h1>
    <p>This area is protected. Enter the shared password to continue.</p>
    ${safeError}
    <form method="post" action="/unlock">
      <input type="hidden" name="next" value="${safeNext}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Unlock</button>
    </form>
  </main>
</body>
</html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function constantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= (aa[i] ^ bb[i]);
  return diff === 0;
}

async function createSessionToken(secret) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const payload = `${expires}.${nonce}`;
  const signature = await signPayload(payload, secret);
  return `${toBase64Url(payload)}.${toBase64Url(signature)}`;
}

async function verifySessionToken(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const payload = fromBase64Url(parts[0]);
  const providedSig = fromBase64Url(parts[1]);
  if (!payload || !providedSig) return false;

  const expectedSig = await signPayload(payload, secret);
  if (!constantTimeEqual(providedSig, expectedSig)) return false;

  const dot = payload.indexOf('.');
  if (dot <= 0) return false;
  const expires = Number(payload.slice(0, dot));
  if (!Number.isFinite(expires)) return false;
  return Math.floor(Date.now() / 1000) < expires;
}

async function signPayload(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToBinary(new Uint8Array(sig));
}

function toBase64Url(str) {
  return btoa(str).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(str) {
  try {
    const normalized = str.replaceAll('-', '+').replaceAll('_', '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return atob(normalized + pad);
  } catch (_) {
    return '';
  }
}

function bytesToBinary(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
