/* ============================================
   LIVE FLIGHTS - ADS-B via OpenSky Network
   ============================================ */

const LiveFlights = (() => {
    'use strict';

    // Use same-origin proxy only when served over http/https (deployed or wrangler dev)
    const isHttp = typeof window !== 'undefined' && window.location.protocol &&
        ['http:', 'https:'].includes(window.location.protocol);
    const OPENSKY_BASE = isHttp ? `${window.location.origin}/api/opensky` : null;
    const POLL_INTERVAL_MS = 12000; // 12s to respect ~10s rate limit with buffer

    let map = null;
    let aircraftLayer = null;
    let markersByIcao = {};
    let pollTimer = null;
    let isActive = false;

    // OpenSky state vector indices
    const IDX = {
        icao24: 0,
        callsign: 1,
        origin_country: 2,
        time_position: 3,
        last_contact: 4,
        longitude: 5,
        latitude: 6,
        baro_altitude: 7,
        on_ground: 8,
        velocity: 9,
        true_track: 10,
        vertical_rate: 11,
        squawk: 14
    };

    function createAircraftIcon(heading) {
        const angle = (heading != null && !isNaN(heading)) ? heading : 0;
        const size = 24;
        // Top-down aircraft: triangle pointing in direction of travel
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" 
                 fill="#2563eb" stroke="#1e40af" stroke-width="1.2" stroke-linejoin="round"
                 style="transform: rotate(${angle}deg);">
                <path d="M12 2 L22 12 L12 10 L2 12 Z"/>
            </svg>
        `;
        return L.divIcon({
            html: svg,
            className: 'live-flight-marker',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
    }

    function formatAltitude(m) {
        if (m == null || isNaN(m)) return '—';
        if (m < 1000) return `${Math.round(m)} m`;
        return `${(m / 1000).toFixed(1)} km`;
    }

    function formatSpeed(ms) {
        if (ms == null || isNaN(ms)) return '—';
        const kts = ms * 1.94384;
        return `${Math.round(kts)} kts`;
    }

    function formatCallsign(cs) {
        if (!cs || typeof cs !== 'string') return '—';
        return cs.trim() || '—';
    }

    function buildPopupContent(state) {
        const callsign = formatCallsign(state[IDX.callsign]);
        const alt = formatAltitude(state[IDX.baro_altitude]);
        const speed = formatSpeed(state[IDX.velocity]);
        const track = state[IDX.true_track] != null && !isNaN(state[IDX.true_track])
            ? `${Math.round(state[IDX.true_track])}°` : '—';
        const country = state[IDX.origin_country] || '—';
        const squawk = state[IDX.squawk] || '—';
        const onGround = state[IDX.on_ground] ? ' (on ground)' : '';

        return `
            <div class="live-flight-popup">
                <strong>${callsign}</strong> ${onGround}<br>
                <small>${state[IDX.icao24].toUpperCase()}</small><br>
                Alt: ${alt} &nbsp; Spd: ${speed}<br>
                Track: ${track} &nbsp; Squawk: ${squawk}<br>
                <small>${country}</small>
            </div>
        `;
    }

    function createMarker(state) {
        const lat = state[IDX.latitude];
        const lng = state[IDX.longitude];
        if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return null;

        const heading = state[IDX.true_track];
        const icon = createAircraftIcon(heading);
        const marker = L.marker([lat, lng], { icon })
            .bindPopup(buildPopupContent(state), { maxWidth: 280 });

        return marker;
    }

    function updateMarkers(states) {
        if (!aircraftLayer) return;

        const seen = new Set();
        const validStates = (states || []).filter(s => {
            const lat = s[IDX.latitude];
            const lng = s[IDX.longitude];
            return lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
        });

        for (const state of validStates) {
            const icao = state[IDX.icao24];
            if (!icao) continue;
            seen.add(icao);

            if (markersByIcao[icao]) {
                const m = markersByIcao[icao];
                m.setLatLng([state[IDX.latitude], state[IDX.longitude]]);
                m.setIcon(createAircraftIcon(state[IDX.true_track]));
                m.setPopupContent(buildPopupContent(state));
            } else {
                const marker = createMarker(state);
                if (marker) {
                    markersByIcao[icao] = marker;
                    marker.addTo(aircraftLayer);
                }
            }
        }

        for (const icao of Object.keys(markersByIcao)) {
            if (!seen.has(icao)) {
                aircraftLayer.removeLayer(markersByIcao[icao]);
                delete markersByIcao[icao];
            }
        }
    }

    async function fetchAircraftInBounds(bounds) {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const params = new URLSearchParams({
            lamin: Math.max(-90, sw.lat - 1).toFixed(4),
            lomin: Math.max(-180, sw.lng - 1).toFixed(4),
            lamax: Math.min(90, ne.lat + 1).toFixed(4),
            lomax: Math.min(180, ne.lng + 1).toFixed(4)
        });
        const directUrl = `https://opensky-network.org/api/states/all?${params}`;
        const corsProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;
        const urls = OPENSKY_BASE
            ? [`${OPENSKY_BASE}/states/all?${params}`, corsProxyUrl]
            : [corsProxyUrl];
        let lastErr;
        for (const url of urls) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`OpenSky API: ${res.status}`);
                const text = await res.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    throw new Error(text || `Invalid response`);
                }
                return data.states || [];
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }

    async function poll() {
        if (!map || !isActive) return;
        const panel = document.getElementById('liveFlightsPanel');
        const countEl = document.getElementById('liveFlightsCount');
        const updateEl = document.getElementById('liveFlightsLastUpdate');

        try {
            const bounds = map.getBounds();
            const states = await fetchAircraftInBounds(bounds);
            updateMarkers(states);

            if (countEl) countEl.textContent = states.length;
            if (updateEl) updateEl.textContent = new Date().toLocaleTimeString();
        } catch (err) {
            console.warn('LiveFlights poll error:', err);
            if (countEl) countEl.textContent = '—';
            if (updateEl) updateEl.textContent = 'Error';
        }
    }

    function startPolling() {
        stopPolling();
        poll();
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function showPanel() {
        const panel = document.getElementById('liveFlightsPanel');
        if (panel) panel.classList.remove('hidden');
    }

    function hidePanel() {
        const panel = document.getElementById('liveFlightsPanel');
        if (panel) panel.classList.add('hidden');
    }

    function init(refMap) {
        map = refMap;
        aircraftLayer = L.layerGroup().addTo(map);
        isActive = true;
        showPanel();
        startPolling();

        const refreshBtn = document.getElementById('liveFlightsRefreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                poll();
            });
        }
    }

    function destroy() {
        isActive = false;
        stopPolling();
        hidePanel();
        if (aircraftLayer && map) {
            map.removeLayer(aircraftLayer);
            aircraftLayer = null;
        }
        markersByIcao = {};
    }

    return {
        init,
        destroy,
        poll,
        isActive: () => isActive
    };
})();
