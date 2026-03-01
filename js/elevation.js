/* ============================================
   MAPBOX TERRAIN-RGB ELEVATION
   ============================================
   Fetches elevation at a point from Mapbox Terrain-RGB tiles.
   Height formula: -10000 + ((R×256² + G×256 + B) × 0.1) meters AMSL
   ============================================ */

const Elevation = (() => {
    'use strict';

    const TILE_SIZE = 256;
    const MAX_ZOOM = 14; // Terrain-RGB has data up to zoom 15; 14 gives good coverage
    const tileCache = new Map();

    function latLngToTileCoords(lat, lng, zoom) {
        const n = Math.pow(2, zoom);
        const x = (lng + 180) / 360 * n;
        const latRad = (lat * Math.PI) / 180;
        const y = (1 - (Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2 * n;
        return { x, y, z: zoom };
    }

    function decodeTerrainPixel(r, g, b) {
        const height = -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
        return Math.round(height * 10) / 10;
    }

    function loadTileImage(url) {
        return new Promise((resolve, reject) => {
            const cached = tileCache.get(url);
            if (cached) {
                resolve(cached);
                return;
            }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                tileCache.set(url, img);
                resolve(img);
            };
            img.onerror = () => reject(new Error('Failed to load terrain tile'));
            img.src = url;
        });
    }

    function getPixelFromImage(img, px, py) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
        return { r: data[0], g: data[1], b: data[2] };
    }

    /**
     * Get elevation at a lat/lng using Mapbox Terrain-RGB tiles.
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @param {string} accessToken - Mapbox access token
     * @param {number} [zoom=14] - Tile zoom level (default 14)
     * @returns {Promise<number|null>} Elevation in meters AMSL, or null if unavailable
     */
    async function getElevationAtLatLng(lat, lng, accessToken, zoom = MAX_ZOOM) {
        if (!accessToken || !accessToken.trim()) return null;

        try {
            const coords = latLngToTileCoords(lat, lng, zoom);
            const tileX = Math.floor(coords.x);
            const tileY = Math.floor(coords.y);
            const px = (coords.x - tileX) * TILE_SIZE;
            const py = (coords.y - tileY) * TILE_SIZE;

            const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${tileX}/${tileY}.pngraw?access_token=${encodeURIComponent(accessToken)}`;
            const img = await loadTileImage(url);
            const pixel = getPixelFromImage(img, px, py);
            return decodeTerrainPixel(pixel.r, pixel.g, pixel.b);
        } catch {
            return null;
        }
    }

    /**
     * Get elevations along a path (for flight path profiles).
     * @param {Array<[number,number]>} latLngs - Array of [lat, lng] pairs
     * @param {string} accessToken - Mapbox access token
     * @returns {Promise<Array<{lat:number,lng:number,elevation:number}>>}
     */
    async function getElevationsAlongPath(latLngs, accessToken) {
        if (!accessToken || !accessToken.trim() || !latLngs || latLngs.length === 0) {
            return [];
        }
        const results = [];
        for (const ll of latLngs) {
            const lat = Array.isArray(ll) ? ll[0] : ll.lat;
            const lng = Array.isArray(ll) ? ll[1] : ll.lng;
            const elevation = await getElevationAtLatLng(lat, lng, accessToken);
            results.push({ lat, lng, elevation: elevation !== null ? elevation : undefined });
        }
        return results;
    }

    return {
        getElevationAtLatLng,
        getElevationsAlongPath
    };
})();
