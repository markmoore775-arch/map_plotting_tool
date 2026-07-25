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

    if (path === '/api/open-meteo') {
      return handleOpenMeteoApi(request);
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

function normalizePath(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

const ADSB_CACHE_SECONDS = 5;
const OGN_CACHE_SECONDS = 10;
const OPEN_METEO_CACHE_SECONDS = 300;
const OPEN_METEO_MAX_LOCATIONS = 100;
const ADSB_LOL_BASE = 'https://api.adsb.lol/v2';
const AIRPLANES_LIVE_BASE = 'https://api.airplanes.live/v2';
const ADSB_UPSTREAM_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'AirPlan/1.0 (+https://airplan.uk; airspace traffic proxy)'
};

function roundAdsbCoord(value) {
  return Math.round(value * 100) / 100;
}

function buildAdsbCacheRequest(requestUrl, query) {
  const cacheUrl = new URL(requestUrl);
  cacheUrl.search = new URLSearchParams(query).toString();
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function adsbJsonResponse(body, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${ADSB_CACHE_SECONDS}`,
    ...(extraHeaders || {})
  };
  return new Response(body, { status: 200, headers });
}

async function fetchAdsbUpstream(upstreamUrl) {
  return fetch(upstreamUrl, {
    headers: ADSB_UPSTREAM_HEADERS,
    cf: {
      cacheTtl: ADSB_CACHE_SECONDS,
      cacheEverything: true
    }
  });
}

function buildAdsbLolUrl(query) {
  if (query.hex) {
    return `${ADSB_LOL_BASE}/hex/${query.hex}`;
  }
  return `${ADSB_LOL_BASE}/lat/${query.latKey}/lon/${query.lonKey}/dist/${query.distKey}`;
}

function buildAirplanesLiveUrl(query) {
  if (query.hex) {
    return `${AIRPLANES_LIVE_BASE}/hex/${query.hex}`;
  }
  return `${AIRPLANES_LIVE_BASE}/point/${query.latKey}/${query.lonKey}/${query.distKey}`;
}

async function fetchAdsbWithFailover(query) {
  const primaryUrl = buildAdsbLolUrl(query);
  let primary = await fetchAdsbUpstream(primaryUrl);
  if (!primary.ok && primary.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    primary = await fetchAdsbUpstream(primaryUrl);
  }
  if (primary.ok) {
    return { response: primary, source: 'adsblol' };
  }

  const fallbackUrl = buildAirplanesLiveUrl(query);
  const fallback = await fetchAdsbUpstream(fallbackUrl);
  if (fallback.ok) {
    return { response: fallback, source: 'airplaneslive' };
  }

  return {
    response: primary.status >= fallback.status ? primary : fallback,
    source: null
  };
}

async function handleAdsbApi(request) {
  if (request.method.toUpperCase() !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const hexRaw = url.searchParams.get('hex');
  let query;
  let cacheQuery;

  if (hexRaw != null && hexRaw !== '') {
    const hex = String(hexRaw)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, '');
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      return jsonResponse({ error: 'Invalid hex (expect 6 hex chars)' }, 400);
    }
    query = { hex };
    cacheQuery = { hex };
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

    const latKey = roundAdsbCoord(lat);
    const lonKey = roundAdsbCoord(lon);
    const distKey = Math.round(dist);
    query = { latKey, lonKey, distKey };
    cacheQuery = {
      lat: String(latKey),
      lon: String(lonKey),
      dist: String(distKey)
    };
  }

  const cache = caches.default;
  const cacheRequest = buildAdsbCacheRequest(request.url, cacheQuery);
  const cached = await cache.match(cacheRequest);

  const result = await fetchAdsbWithFailover(query);
  const upstream = result.response;

  if (!upstream.ok) {
    if (cached) {
      return adsbJsonResponse(await cached.text(), {
        'X-AirPlan-Cache': 'stale',
        'X-AirPlan-Source': 'stale'
      });
    }
    const status = upstream.status === 429 ? 429 : 502;
    return jsonResponse(
      { error: `Upstream returned HTTP ${upstream.status}` },
      status
    );
  }

  const body = await upstream.text();
  const response = adsbJsonResponse(body, {
    'X-AirPlan-Source': result.source || 'adsblol'
  });
  await cache.put(cacheRequest, response.clone());
  return response;
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
  const cacheKey = 'ogn:' + qs.toString();
  const cache = caches.default;
  const cacheRequest = new Request(new URL('/ogn-cache/' + cacheKey, request.url).toString(), {
    method: 'GET'
  });
  const cached = await cache.match(cacheRequest);
  const upstreamUrl = 'https://live.glidernet.org/lxml.php?' + qs.toString();

  const upstream = await fetch(upstreamUrl, {
    headers: { Accept: 'application/xml, text/xml, */*' }
  });

  if (!upstream.ok) {
    if (cached) {
      return new Response(await cached.text(), {
        status: 200,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-AirPlan-Cache': 'stale'
        }
      });
    }
    return jsonResponse(
      { error: `Upstream returned HTTP ${upstream.status}` },
      502
    );
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${OGN_CACHE_SECONDS}`
    }
  });
  await cache.put(cacheRequest, response.clone());
  return response;
}

function countCsvValues(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .length;
}

async function handleOpenMeteoApi(request) {
  if (request.method.toUpperCase() !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const latitude = url.searchParams.get('latitude');
  const longitude = url.searchParams.get('longitude');
  if (!latitude || !longitude) {
    return jsonResponse({ error: 'Missing latitude or longitude' }, 400);
  }

  const latCount = countCsvValues(latitude);
  const lonCount = countCsvValues(longitude);
  if (latCount === 0 || latCount !== lonCount) {
    return jsonResponse({ error: 'latitude and longitude must have the same number of values' }, 400);
  }
  if (latCount > OPEN_METEO_MAX_LOCATIONS) {
    return jsonResponse({ error: `Too many locations (max ${OPEN_METEO_MAX_LOCATIONS})` }, 400);
  }

  const forecastDays = Number(url.searchParams.get('forecast_days') || '1');
  if (!Number.isFinite(forecastDays) || forecastDays < 1 || forecastDays > 16) {
    return jsonResponse({ error: 'Invalid forecast_days (1–16)' }, 400);
  }

  const upstreamParams = new URLSearchParams(url.searchParams);
  upstreamParams.delete('cache_bust');
  const upstreamUrl = 'https://api.open-meteo.com/v1/forecast?' + upstreamParams.toString();
  const cache = caches.default;
  const cacheRequest = new Request(
    new URL('/open-meteo-cache/' + encodeURIComponent(upstreamParams.toString()), request.url).toString(),
    { method: 'GET' }
  );
  const cached = await cache.match(cacheRequest);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        ...Object.fromEntries(cached.headers.entries()),
        'X-AirPlan-Cache': 'hit'
      }
    });
  }

  let upstream = await fetch(upstreamUrl, {
    headers: { Accept: 'application/json' }
  });
  if (!upstream.ok && upstream.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' }
    });
  }

  if (!upstream.ok) {
    if (cached) {
      return new Response(await cached.text(), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-AirPlan-Cache': 'stale'
        }
      });
    }
    const status = upstream.status === 429 ? 429 : 502;
    return jsonResponse(
      { error: `Open-Meteo returned HTTP ${upstream.status}` },
      status
    );
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${OPEN_METEO_CACHE_SECONDS}`,
      'X-AirPlan-Source': 'open-meteo'
    }
  });
  await cache.put(cacheRequest, response.clone());
  return response;
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
