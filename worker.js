/**
 * AirPlot Worker - serves static assets and proxies OpenSky API for CORS
 */
const OPENSKY_BASE = 'https://opensky-network.org/api';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/opensky/')) {
            return handleOpenSkyProxy(request, url);
        }
        return env.ASSETS.fetch(request);
    }
};

async function handleOpenSkyProxy(request, url) {
    const path = url.pathname.replace(/^\/api\/opensky/, '') || '/states/all';
    const proxyUrl = `${OPENSKY_BASE}${path}${url.search}`;
    try {
        const res = await fetch(proxyUrl);
        const body = await res.arrayBuffer();
        return new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: {
                'Content-Type': res.headers.get('Content-Type') || 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: String(err.message) }), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
