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
                } else if ((s.type === 'polyline' || s.type === 'flightpath') && s.latlngs) {
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

    // ---- PowerPoint Export ----

    async function exportPptx(mapElement, points, shapes, light) {
        PptxTheme.setLight(!!light);

        const pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
        pptx.author = 'AirPlot v3';
        pptx.subject = 'Map Report';

        const logo = await PptxTheme.loadLogo();
        PptxTheme.applyTheme(pptx, logo);

        const C = PptxTheme.colors();
        const headerOpts = PptxTheme.tableHeaderOpts();
        const cellOpts = PptxTheme.tableCellOpts();
        const border = PptxTheme.tableBorder();

        const mapImg = await PptxTheme.captureSquareMap(mapElement);
        const dateLabel = new Date().toLocaleString();

        // --- Slide 1: Title + Map ---
        let slide = pptx.addSlide({ masterName: 'TITLE_SLIDE' });
        slide.addText('Map Report', { x: 1.1, y: 0.15, w: 8, h: 0.6, fontSize: 26, bold: true, color: C.textPrimary, fontFace: 'Arial' });

        var mapSize = 5.6;
        slide.addShape('roundRect', { x: 0.42, y: 1.02, w: mapSize + 0.16, h: mapSize + 0.16, fill: { color: C.surface }, rectRadius: 0.12, line: { color: C.border, width: 0.5 } });
        slide.addImage({ data: mapImg, x: 0.5, y: 1.1, w: mapSize, h: mapSize, rounding: false });

        var panelX = 6.5;
        var panelW = 6.3;
        var panelRows = [
            { label: 'DATE & TIME', value: dateLabel, divider: true },
            { label: 'POINTS', value: points.length + ' point' + (points.length !== 1 ? 's' : '') + ' plotted', bold: true, fontSize: 15, divider: true },
            { label: 'SHAPES & DRAWINGS', value: shapes.length + ' shape' + (shapes.length !== 1 ? 's' : '') + ' defined', bold: true, fontSize: 15, divider: true }
        ];
        if (points.length > 0) {
            var firstPt = points[0];
            panelRows.push({ label: 'FIRST POINT', value: (firstPt.name || 'Unnamed') + '  (' + firstPt.lat.toFixed(5) + ', ' + firstPt.lng.toFixed(5) + ')', divider: true });
        }
        panelRows.push({ label: 'GENERATED', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '  at  ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
        PptxTheme.addInfoPanel(slide, panelX, 1.0, panelW, 5.7, panelRows);

        // --- Slide 2+: Points table ---
        if (points.length > 0) {
            const pageSize = 14;
            const ptHeader = [
                { text: '#', options: headerOpts },
                { text: 'Name', options: headerOpts },
                { text: 'Latitude', options: headerOpts },
                { text: 'Longitude', options: headerOpts },
                { text: 'Notes', options: headerOpts }
            ];
            const colW = [0.6, 3, 2, 2, 4.6];

            let rows = [ptHeader];
            for (let i = 0; i < points.length; i++) {
                if (i > 0 && i % pageSize === 0) {
                    slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                    slide.addText('Points (continued)', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                    slide.addTable(rows, { x: 0.3, y: 0.85, w: 12.6, colW: colW, border: border, rowH: 0.38 });
                    rows = [ptHeader];
                }
                const p = points[i];
                const notes = (p.notes || '').replace(/\n/g, ' ');
                const truncNotes = notes.length > 80 ? notes.slice(0, 77) + '…' : notes;
                rows.push([
                    { text: String(i + 1), options: cellOpts },
                    { text: p.name || 'Unnamed', options: cellOpts },
                    { text: p.lat.toFixed(6), options: cellOpts },
                    { text: p.lng.toFixed(6), options: cellOpts },
                    { text: truncNotes, options: cellOpts }
                ]);
            }
            if (rows.length > 1) {
                slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                slide.addText(points.length === rows.length - 1 ? 'Points' : 'Points (continued)', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                slide.addTable(rows, { x: 0.3, y: 0.85, w: 12.6, colW: colW, border: border, rowH: 0.38 });
            }
        }

        // --- Shapes slide ---
        if (shapes.length > 0) {
            slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
            slide.addText('Shapes & Drawings', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });

            const shHeader = [
                { text: '#', options: headerOpts },
                { text: 'Type', options: headerOpts },
                { text: 'Label', options: headerOpts },
                { text: 'Details', options: headerOpts }
            ];
            const shColW = [0.6, 2.5, 3, 6.1];
            const shRows = [shHeader];

            shapes.forEach(function (s, i) {
                const typeStr = (s.type || 'unknown').charAt(0).toUpperCase() + (s.type || 'unknown').slice(1);
                const label = s.label || s.text || '—';
                let details = '';

                if (s.type === 'circle' && s.center) {
                    const r = s.radius >= 1000 ? (s.radius / 1000).toFixed(2) + ' km' : Math.round(s.radius) + ' m';
                    details = 'Centre: ' + s.center[0].toFixed(5) + ', ' + s.center[1].toFixed(5) + ' | Radius: ' + r;
                } else if ((s.type === 'polygon' || s.type === 'rectangle') && s.latlngs) {
                    details = s.latlngs.length + ' vertices';
                } else if ((s.type === 'polyline' || s.type === 'flightpath') && s.latlngs) {
                    details = s.latlngs.length + ' points';
                } else if (s.type === 'arrow' && s.tail && s.tip) {
                    details = 'From ' + s.tail[0].toFixed(5) + ',' + s.tail[1].toFixed(5) + ' → ' + s.tip[0].toFixed(5) + ',' + s.tip[1].toFixed(5);
                } else if (s.type === 'text' && s.position) {
                    details = 'At ' + s.position[0].toFixed(5) + ', ' + s.position[1].toFixed(5);
                }

                shRows.push([
                    { text: String(i + 1), options: cellOpts },
                    { text: typeStr, options: cellOpts },
                    { text: label, options: cellOpts },
                    { text: details || '—', options: cellOpts }
                ]);

                if (shRows.length > 15 && i < shapes.length - 1) {
                    slide.addTable(shRows.splice(0), { x: 0.3, y: 0.85, w: 12.6, colW: shColW, border: border, rowH: 0.38 });
                    slide = pptx.addSlide({ masterName: 'CONTENT_SLIDE' });
                    slide.addText('Shapes & Drawings (continued)', { x: 0.5, y: 0.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: C.textPrimary, fontFace: 'Arial' });
                    shRows.push(shHeader);
                }
            });

            if (shRows.length > 1) {
                slide.addTable(shRows, { x: 0.3, y: 0.85, w: 12.6, colW: shColW, border: border, rowH: 0.38 });
            }
        }

        const fileName = 'Map_Report_' + new Date().toISOString().slice(0, 10) + '.pptx';
        await pptx.writeFile({ fileName: fileName });
    }

    // ---- PDF Export ----

    async function exportPdf(mapElement, points, shapes, light) {
        PdfTheme.setLight(!!light);
        var logo = await PdfTheme.loadLogo();
        var c = PdfTheme.colors();
        var ts = PdfTheme.tableStyles();

        var mapImg = await PdfTheme.captureSquareMap(mapElement);
        var dateLabel = new Date().toLocaleString();

        var doc = PdfTheme.createDoc();

        PdfTheme.addHeader(doc, 'Map Report', true);
        doc.addImage(mapImg, 'PNG', 10, 25, 120, 120);

        var panelRows = [
            { label: 'DATE & TIME', value: dateLabel, divider: true },
            { label: 'POINTS', value: points.length + ' point' + (points.length !== 1 ? 's' : '') + ' plotted', bold: true, fontSize: 11, divider: true },
            { label: 'SHAPES & DRAWINGS', value: shapes.length + ' shape' + (shapes.length !== 1 ? 's' : '') + ' defined', bold: true, fontSize: 11, divider: true }
        ];
        if (points.length > 0) {
            var firstPt = points[0];
            panelRows.push({ label: 'FIRST POINT', value: (firstPt.name || 'Unnamed') + '  (' + firstPt.lat.toFixed(5) + ', ' + firstPt.lng.toFixed(5) + ')', divider: true });
        }
        panelRows.push({ label: 'GENERATED', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '  at  ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
        PdfTheme.addInfoPanel(doc, 140, 25, 147, panelRows);

        if (points.length > 0) {
            PdfTheme.newPage(doc);
            PdfTheme.addHeader(doc, 'Points');
            var ptBody = points.map(function (p, i) {
                var notes = (p.notes || '').replace(/\n/g, ' ');
                if (notes.length > 80) notes = notes.slice(0, 77) + '…';
                return [String(i + 1), p.name || 'Unnamed', p.lat.toFixed(6), p.lng.toFixed(6), notes];
            });
            doc.autoTable({
                startY: 18,
                head: [['#', 'Name', 'Latitude', 'Longitude', 'Notes']],
                body: ptBody,
                columnStyles: { 4: { cellWidth: 70 } },
                ...ts
            });
        }

        if (shapes.length > 0) {
            PdfTheme.newPage(doc);
            PdfTheme.addHeader(doc, 'Shapes & Drawings');
            var shBody = shapes.map(function (s, i) {
                var typeStr = (s.type || 'unknown').charAt(0).toUpperCase() + (s.type || 'unknown').slice(1);
                var label = s.label || s.text || '—';
                var details = '';
                if (s.type === 'circle' && s.center) {
                    var r = s.radius >= 1000 ? (s.radius / 1000).toFixed(2) + ' km' : Math.round(s.radius) + ' m';
                    details = 'Centre: ' + s.center[0].toFixed(5) + ', ' + s.center[1].toFixed(5) + ' | Radius: ' + r;
                } else if ((s.type === 'polygon' || s.type === 'rectangle') && s.latlngs) {
                    details = s.latlngs.length + ' vertices';
                } else if ((s.type === 'polyline' || s.type === 'flightpath') && s.latlngs) {
                    details = s.latlngs.length + ' points';
                } else if (s.type === 'arrow' && s.tail && s.tip) {
                    details = 'From ' + s.tail[0].toFixed(5) + ',' + s.tail[1].toFixed(5) + ' → ' + s.tip[0].toFixed(5) + ',' + s.tip[1].toFixed(5);
                } else if (s.type === 'text' && s.position) {
                    details = 'At ' + s.position[0].toFixed(5) + ', ' + s.position[1].toFixed(5);
                }
                return [String(i + 1), typeStr, label, details || '—'];
            });
            doc.autoTable({
                startY: 18,
                head: [['#', 'Type', 'Label', 'Details']],
                body: shBody,
                ...ts
            });
        }

        PdfTheme.addAllFooters(doc);
        doc.save('Map_Report_' + new Date().toISOString().slice(0, 10) + '.pdf');
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
        exportPptx,
        exportPdf,
        downloadFile
    };

})();
