/* ============================================
   EXPORT: CSV, KML, SCREENSHOT
   ============================================ */

const Exporters = (() => {

    // ---- CSV Export ----

    function exportCSV(points) {
        const headers = ['Name', 'Latitude', 'Longitude', 'IconType', 'IconColor', 'IconSymbol', 'Notes'];
        const rows = points.map(p => {
            return [
                csvEscape(p.name || ''),
                p.lat,
                p.lng,
                p.iconType || '',
                p.iconColor || '',
                p.customSymbol || '',
                csvEscape(p.notes || '')
            ].join(',');
        });

        const csv = [headers.join(','), ...rows].join('\n');
        downloadFile(csv, 'map_points.csv', 'text/csv');
    }

    function csvEscape(str) {
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    // ---- KML Export ----

    function exportKML(points, shapes) {
        let placemarks = '';

        for (const p of points) {
            // Point placemark
            placemarks += `
    <Placemark>
      <name>${escapeXml(p.name || 'Unnamed')}</name>
      <description>${escapeXml(p.notes || '')}</description>
      <Point>
        <coordinates>${p.lng},${p.lat},0</coordinates>
      </Point>
    </Placemark>`;

        }

        // Export drawn shapes
        if (shapes && shapes.length > 0) {
            for (const s of shapes) {
                const label = s.label || s.type.charAt(0).toUpperCase() + s.type.slice(1);
                const color = kmlColor(s.style.color || '#e05555', s.style.fillOpacity || 0.3);
                const lineColor = kmlColor(s.style.color || '#e05555', 0.8);

                if (s.type === 'circle' && s.center) {
                    // Approximate circle as polygon
                    const circleCoords = [];
                    for (let i = 0; i <= 36; i++) {
                        const angle = (i * 10) % 360;
                        const pt = destinationPoint(s.center[0], s.center[1], angle, s.radius);
                        circleCoords.push(`${pt.lng},${pt.lat},0`);
                    }
                    placemarks += `
    <Placemark>
      <name>${escapeXml(label)}</name>
      <Style>
        <PolyStyle><color>${color}</color><outline>1</outline></PolyStyle>
        <LineStyle><color>${lineColor}</color><width>${s.style.weight || 2}</width></LineStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${circleCoords.join(' ')}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`;
                } else if ((s.type === 'polygon' || s.type === 'rectangle') && s.latlngs) {
                    const coords = s.latlngs.map(ll => `${ll[1]},${ll[0]},0`);
                    coords.push(coords[0]); // close ring
                    placemarks += `
    <Placemark>
      <name>${escapeXml(label)}</name>
      <Style>
        <PolyStyle><color>${color}</color><outline>1</outline></PolyStyle>
        <LineStyle><color>${lineColor}</color><width>${s.style.weight || 2}</width></LineStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${coords.join(' ')}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`;
                } else if (s.type === 'polyline' && s.latlngs) {
                    const coords = s.latlngs.map(ll => `${ll[1]},${ll[0]},0`);
                    placemarks += `
    <Placemark>
      <name>${escapeXml(label)}</name>
      <Style>
        <LineStyle><color>${lineColor}</color><width>${s.style.weight || 2}</width></LineStyle>
      </Style>
      <LineString>
        <coordinates>${coords.join(' ')}</coordinates>
      </LineString>
    </Placemark>`;
                } else if (s.type === 'text' && s.position) {
                    placemarks += `
    <Placemark>
      <name>${escapeXml(s.text || label)}</name>
      <Point><coordinates>${s.position[1]},${s.position[0]},0</coordinates></Point>
    </Placemark>`;
                }
            }
        }

        const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Map Export</name>
    <description>Exported from Map Plotting Tool</description>${placemarks}
  </Document>
</kml>`;

        downloadFile(kml, 'map_export.kml', 'application/vnd.google-earth.kml+xml');
    }

    function escapeXml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function kmlColor(hexColor, alpha) {
        // KML uses aabbggrr format
        const hex = hexColor.replace('#', '');
        const r = hex.substring(0, 2);
        const g = hex.substring(2, 4);
        const b = hex.substring(4, 6);
        const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
        return a + b + g + r;
    }

    // Local geo helper to keep exporter standalone.
    function destinationPoint(lat, lng, bearing, distance) {
        const R = 6371000;
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

    // ---- Screenshot Export ----

    async function exportScreenshot(mapElement) {
        try {
            // html2canvas needs the element to be visible
            const canvas = await html2canvas(mapElement, {
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#fff',
                scale: 2, // higher resolution
                logging: false
            });
            canvas.toBlob(blob => {
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'map_screenshot.png';
                    a.click();
                    URL.revokeObjectURL(url);
                }
            }, 'image/png');
        } catch (e) {
            console.error('Screenshot failed:', e);
            alert('Screenshot capture failed. This may be due to cross-origin tile restrictions. Try using a different base layer.');
        }
    }

    // ---- Download helper ----

    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    return {
        exportCSV,
        exportKML,
        exportScreenshot,
        downloadFile
    };

})();
