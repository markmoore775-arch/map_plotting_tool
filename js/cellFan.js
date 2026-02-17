/* ============================================
   CELL SITE FAN VISUALIZATION
   ============================================ */

const CellFan = (() => {

    /**
     * Create a cell-site coverage fan on the map.
     *
     * The fan is 120 degrees wide, centred on the given azimuth bearing.
     * Soft edges are achieved by layering three concentric semi-transparent
     * polygons with increasing radius and decreasing opacity.
     *
     * @param {L.Map} map - Leaflet map instance
     * @param {number} lat - Centre latitude
     * @param {number} lng - Centre longitude
     * @param {number} azimuth - Bearing in degrees (0 = North, clockwise)
     * @param {number} radius - Radius in metres
     * @param {string} color - CSS colour string
     * @returns {L.LayerGroup} A layer group containing the fan polygons
     */
    function createFan(map, lat, lng, azimuth, radius, color) {
        const layerGroup = L.layerGroup();

        // Three layers for soft-edge effect
        const layers = [
            { radiusFactor: 0.70, opacity: 0.30, weight: 0 },
            { radiusFactor: 0.85, opacity: 0.18, weight: 0 },
            { radiusFactor: 1.00, opacity: 0.10, weight: 1 },
        ];

        const halfAngle = 60; // 120 / 2
        const startAngle = azimuth - halfAngle;
        const endAngle = azimuth + halfAngle;
        const steps = 40; // number of arc points for smooth curve

        for (const layer of layers) {
            const r = radius * layer.radiusFactor;
            const points = [L.latLng(lat, lng)]; // centre point

            for (let i = 0; i <= steps; i++) {
                const angle = startAngle + (endAngle - startAngle) * (i / steps);
                const pt = destinationPoint(lat, lng, angle, r);
                points.push(L.latLng(pt.lat, pt.lng));
            }

            points.push(L.latLng(lat, lng)); // close back to centre

            const polygon = L.polygon(points, {
                color: color,
                weight: layer.weight,
                opacity: layer.opacity + 0.1,
                fillColor: color,
                fillOpacity: layer.opacity,
                interactive: false
            });

            layerGroup.addLayer(polygon);
        }

        // Add a thin direction line from centre along the azimuth
        const tip = destinationPoint(lat, lng, azimuth, radius * 0.75);
        const dirLine = L.polyline(
            [L.latLng(lat, lng), L.latLng(tip.lat, tip.lng)],
            {
                color: color,
                weight: 2,
                opacity: 0.5,
                dashArray: '6,4',
                interactive: false
            }
        );
        layerGroup.addLayer(dirLine);

        return layerGroup;
    }

    /**
     * Calculate destination point given start, bearing, and distance.
     * Uses the Haversine formula (spherical Earth approximation).
     */
    function destinationPoint(lat, lng, bearing, distance) {
        const R = 6371000; // Earth radius in metres
        const d = distance / R;
        const brng = bearing * Math.PI / 180;
        const lat1 = lat * Math.PI / 180;
        const lon1 = lng * Math.PI / 180;

        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(d) +
            Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
        );

        const lon2 = lon1 + Math.atan2(
            Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
            Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
        );

        return {
            lat: lat2 * 180 / Math.PI,
            lng: ((lon2 * 180 / Math.PI) + 540) % 360 - 180
        };
    }

    /**
     * Create all fans for a cell-site point's sectors.
     * @param {L.Map} map
     * @param {object} point - Point object with sectors array
     * @returns {L.LayerGroup} Layer group containing all sector fans
     */
    function createFansForPoint(map, point) {
        const group = L.layerGroup();

        if (!point.sectors || point.sectors.length === 0) return group;

        for (const sector of point.sectors) {
            if (sector.azimuth == null || isNaN(sector.azimuth)) continue;
            const fanRadius = sector.radius || 500;
            const fanColor = sector.color || '#3388ff';
            const fan = createFan(map, point.lat, point.lng, sector.azimuth, fanRadius, fanColor);
            group.addLayer(fan);
        }

        return group;
    }

    /**
     * Export fan sector as KML polygon coordinates
     */
    function fanToKMLCoords(lat, lng, azimuth, radius) {
        const coords = [];
        const halfAngle = 60;
        const startAngle = azimuth - halfAngle;
        const endAngle = azimuth + halfAngle;
        const steps = 30;

        coords.push([lng, lat, 0]); // centre

        for (let i = 0; i <= steps; i++) {
            const angle = startAngle + (endAngle - startAngle) * (i / steps);
            const pt = destinationPoint(lat, lng, angle, radius);
            coords.push([pt.lng, pt.lat, 0]);
        }

        coords.push([lng, lat, 0]); // close

        return coords;
    }

    return {
        createFan,
        createFansForPoint,
        destinationPoint,
        fanToKMLCoords
    };

})();
