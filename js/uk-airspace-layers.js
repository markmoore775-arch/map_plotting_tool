/* ============================================
   AIRSPACE MODULE - UK Airspace Restrictions
   Multi-layer support: Prohibited, Restricted, Danger, FRZ
   Data: NATS UAS / UK AIP ENR 5.1
   Dense-area UX: presets, zoom-scaled fills, viewport, min-area cull, detail panel + pick list.
   Loaded by Planning (index.html) only.
   ============================================ */

(function (global) {
    'use strict';

    const STORAGE_KEY = 'airplotUkAirspacePrefs_v3';
    const STORAGE_KEY_LEGACY = 'airplotUkAirspacePrefs_v2';
    const LOD_ZOOM_DETAIL = 11;
    const VIEWPORT_PAD_RATIO = 0.12;
    const MAP_REBUILD_DEBOUNCE_MS = 90;
    const ZOOM_FILL_LOW = 8;
    const ZOOM_FILL_HIGH = 14;

    const AIRSPACE_TYPES = {
        prohibited: {
            label: 'Prohibited',
            color: '#991b1b',
            fillColor: '#991b1b',
            fillOpacity: 0.2,
            weight: 2,
            description: 'No flying permitted'
        },
        restricted: {
            label: 'Restricted',
            color: '#ea580c',
            fillColor: '#ea580c',
            fillOpacity: 0.18,
            weight: 2,
            description: 'Flying limited under certain conditions'
        },
        danger: {
            label: 'Danger',
            color: '#ca8a04',
            fillColor: '#ca8a04',
            fillOpacity: 0.18,
            weight: 2,
            description: 'Hazardous activities may occur'
        },
        frz: {
            label: 'FRZ / Aerodrome',
            color: '#9333ea',
            fillColor: '#9333ea',
            fillOpacity: 0.2,
            weight: 2,
            description: 'Flight Restriction Zone around protected aerodrome'
        },
        other: {
            label: 'Other',
            color: '#6b7280',
            fillColor: '#6b7280',
            fillOpacity: 0.15,
            weight: 2,
            description: 'Other airspace restriction (internal fallback, not shown in menu)'
        }
    };

    function defaultPrefs() {
        return {
            version: 4,
            displayPreset: 'readable',
            layers: {
                prohibited: true,
                restricted: false,
                danger: false,
                frz: true
            },
            outlineMode: true,
            lodMode: 'essential',
            viewportOnly: true,
            minAreaCullEnabled: true,
            opacity: {
                prohibited: null,
                restricted: null,
                danger: null,
                frz: null
            },
            notam: {
                droneRelevantOnly: true,
                hideAerodromeGround: true,
                hideAboveDroneCeiling: true,
                droneCeilingFt: 600,
                mapEnabled: false,
                maxRadius: 12,
                fillOpacity: 0.08
            }
        };
    }

    function mergePrefsObj(o) {
        const d = defaultPrefs();
        const displayPresetMerged =
            Object.prototype.hasOwnProperty.call(o, 'displayPreset') &&
            (o.displayPreset === 'readable' ||
                o.displayPreset === 'full' ||
                o.displayPreset === 'custom')
                ? o.displayPreset
                : 'custom';
        return {
            version: 4,
            displayPreset: displayPresetMerged,
            layers: Object.assign({}, d.layers, o.layers || {}),
            outlineMode: typeof o.outlineMode === 'boolean' ? o.outlineMode : d.outlineMode,
            lodMode: o.lodMode === 'full' || o.lodMode === 'essential' ? o.lodMode : d.lodMode,
            viewportOnly: typeof o.viewportOnly === 'boolean' ? o.viewportOnly : d.viewportOnly,
            minAreaCullEnabled:
                typeof o.minAreaCullEnabled === 'boolean' ? o.minAreaCullEnabled : d.minAreaCullEnabled,
            opacity: Object.assign({}, d.opacity, o.opacity || {}),
            notam: Object.assign({}, d.notam, o.notam || {})
        };
    }

    function loadPrefs() {
        try {
            if (global.localStorage) {
                let raw = global.localStorage.getItem(STORAGE_KEY);
                if (!raw) {
                    raw = global.localStorage.getItem(STORAGE_KEY_LEGACY);
                }
                if (raw) {
                    const o = JSON.parse(raw);
                    return mergePrefsObj(o);
                }
            }
        } catch (e) { /* ignore */ }
        return defaultPrefs();
    }

    function savePrefs(prefs) {
        try {
            if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
        } catch (e) { /* ignore */ }
    }

    /**
     * Bounding box for GeoJSON geometry (lng, lat order).
     */
    function bboxFromGeometry(geometry) {
        if (!geometry) return null;
        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLng = Infinity;
        let maxLng = -Infinity;

        function scanCoords(coords) {
            if (!coords) return;
            if (coords.length >= 2 && typeof coords[0] === 'number') {
                const lng = coords[0];
                const lat = coords[1];
                if (typeof lat === 'number' && typeof lng === 'number') {
                    minLat = Math.min(minLat, lat);
                    maxLat = Math.max(maxLat, lat);
                    minLng = Math.min(minLng, lng);
                    maxLng = Math.max(maxLng, lng);
                }
                return;
            }
            for (let i = 0; i < coords.length; i++) {
                scanCoords(coords[i]);
            }
        }

        if (geometry.type === 'GeometryCollection' && geometry.geometries) {
            for (let g = 0; g < geometry.geometries.length; g++) {
                const b = bboxFromGeometry(geometry.geometries[g]);
                if (b) {
                    minLat = Math.min(minLat, b.getSouth());
                    maxLat = Math.max(maxLat, b.getNorth());
                    minLng = Math.min(minLng, b.getWest());
                    maxLng = Math.max(maxLng, b.getEast());
                }
            }
        } else {
            scanCoords(geometry.coordinates);
        }

        if (!isFinite(minLat) || !isFinite(minLng)) return null;
        return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
    }

    function padBounds(bounds, ratio) {
        if (!bounds || !bounds.isValid()) return bounds;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const latPad = Math.max((ne.lat - sw.lat) * ratio, 0.02);
        const lngPad = Math.max((ne.lng - sw.lng) * ratio, 0.02);
        return L.latLngBounds(
            [sw.lat - latPad, sw.lng - lngPad],
            [ne.lat + latPad, ne.lng + lngPad]
        );
    }

    function approxAreaKm2FromBounds(bounds) {
        if (!bounds || !bounds.isValid()) return null;
        const latSpan = Math.max(bounds.getNorth() - bounds.getSouth(), 0);
        const lngSpan = Math.max(bounds.getEast() - bounds.getWest(), 0);
        const midLat = ((bounds.getNorth() + bounds.getSouth()) / 2) * (Math.PI / 180);
        const kmLat = latSpan * 111;
        const kmLng = lngSpan * 111 * Math.max(0.1, Math.cos(midLat));
        return Math.abs(kmLat * kmLng);
    }

    function zoomFillScale(zoom) {
        if (zoom <= ZOOM_FILL_LOW) return 0.32;
        if (zoom >= ZOOM_FILL_HIGH) return 1;
        return 0.32 + (0.68 * (zoom - ZOOM_FILL_LOW)) / (ZOOM_FILL_HIGH - ZOOM_FILL_LOW);
    }

    function cullMinAreaKm2ForZoom(zoom) {
        if (zoom >= LOD_ZOOM_DETAIL) return 0;
        if (zoom <= 8) return 80;
        if (zoom >= 10) return 2;
        return 80 - (78 * (zoom - 8)) / 2;
    }

    function pointInRing(lng, lat, ring) {
        if (!ring || ring.length < 3) return false;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0];
            const yi = ring[i][1];
            const xj = ring[j][0];
            const yj = ring[j][1];
            const intersect =
                yi > lat !== yj > lat &&
                lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function pointInPolygonRings(lng, lat, rings) {
        if (!rings || !rings[0]) return false;
        if (!pointInRing(lng, lat, rings[0])) return false;
        for (let h = 1; h < rings.length; h++) {
            if (pointInRing(lng, lat, rings[h])) return false;
        }
        return true;
    }

    function pointInGeometry(lng, lat, geom) {
        if (!geom) return false;
        switch (geom.type) {
            case 'Polygon':
                return pointInPolygonRings(lng, lat, geom.coordinates);
            case 'MultiPolygon':
                for (let i = 0; i < geom.coordinates.length; i++) {
                    if (pointInPolygonRings(lng, lat, geom.coordinates[i])) return true;
                }
                return false;
            case 'GeometryCollection':
                if (!geom.geometries) return false;
                for (let g = 0; g < geom.geometries.length; g++) {
                    if (pointInGeometry(lng, lat, geom.geometries[g])) return true;
                }
                return false;
            default:
                return false;
        }
    }

    /**
     * Classify a feature into an airspace type from its properties.
     */
    function classifyAirspaceType(feature) {
        const props = feature.properties || {};
        const designator = (props.designator || props.type || props.id || '').toUpperCase();
        const name = (props.name || '').toUpperCase();
        const description = (props.description || '').toUpperCase();
        const aixmType = (props.type || '').toUpperCase();

        if (designator.startsWith('EGRU') || description.includes('FRZ') || designator.includes('FRZ') || designator.includes('RPZ') || name.includes('FRZ') || name.includes('AERODROME') || name.includes('FLIGHT RESTRICTION')) {
            return 'frz';
        }
        if (designator.startsWith('EG-P') || designator.startsWith('EGP') || designator.startsWith('P') || name.includes('PROHIBITED') || aixmType === 'P') {
            return 'prohibited';
        }
        if (designator.startsWith('EG-R') || designator.startsWith('EGR') || designator.startsWith('R') || name.includes('RESTRICTED') || aixmType === 'R') {
            return 'restricted';
        }
        if (designator.startsWith('EG-D') || designator.startsWith('EGD') || designator.startsWith('D') || name.includes('DANGER') || aixmType === 'D') {
            return 'danger';
        }
        if (aixmType === 'CTR' || aixmType === 'TMA' || aixmType === 'FIR' || aixmType === 'UIR' || aixmType === 'CTA') {
            return 'other';
        }

        return 'other';
    }

    function escapeHtml(str) {
        if (str == null || str === '') return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function parseDescription(description) {
        if (!description || typeof description !== 'string') return { limits: null, geometry: null, sections: [] };
        const div = document.createElement('div');
        div.innerHTML = description;
        const cells = div.querySelectorAll('td');
        let limits = null;
        let geometry = null;
        const sections = [];

        cells.forEach(function (cell) {
            const raw = cell.innerHTML.replace(/<br\s*\/?>/gi, '\n');
            const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (!text) return;

            const upperMatch = text.match(/Upper limit:\s*([^<\n]+?)(?:\s*<|$|\n|Lower limit)/i);
            const lowerMatch = text.match(/Lower limit:\s*([^<\n]+?)(?:\s*<|$|\n|Class)/i);
            if (upperMatch || lowerMatch) {
                limits = { lower: (lowerMatch && lowerMatch[1].trim()) || 'SFC', upper: (upperMatch && upperMatch[1].trim()) || 'UNL' };
            }
            if (text.match(/circle.*radius.*centred|radius.*centred.*at/i) && !geometry) {
                const geomPart = text.split(/Upper limit/i)[0];
                geometry = geomPart.replace(/\s+/g, ' ').trim();
                if (geometry.length > 80) geometry = geometry.substring(0, 77) + '...';
            }

            if (text.includes('Activity:') || text.includes('FRZ') || text.includes('Contact:') || text.includes('Service:')) {
                const parts = text.split(/\s*(?=(?:Activity|Service|Contact|SUA Authority|Hours|FRZ)\s*:)/i);
                parts.forEach(function (p) {
                    const t = p.trim();
                    if (t.length > 15) sections.push(t);
                });
            } else if (text.length > 25 && !text.match(/^\d{6}[NS]\s+\d{7}[EW]/) && !text.match(/^[\d\s\-\.]+$/)) {
                sections.push(text);
            }
        });

        if (cells.length === 0 && description) {
            const plain = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (plain.length > 15) sections.push(plain);
        }
        return { limits: limits, geometry: geometry, sections: sections };
    }

    /**
     * Shared HTML for popup + detail panel (variant: 'popup' | 'panel').
     */
    function buildAirspaceDetailHtml(feature, variant) {
        variant = variant || 'popup';
        const props = feature.properties || {};
        const typeKey = classifyAirspaceType(feature);
        const typeInfo = AIRSPACE_TYPES[typeKey];
        const name = props.name || props.designator || 'Unnamed';
        const designator = props.designator || props.id || '';
        let lowerLimit = props.lowerLimit || props.lower_limit || props.altitudeBottom || '';
        let upperLimit = props.upperLimit || props.upper_limit || props.altitudeTop || '';
        const activation = props.activation || props.operatingTimes || props.times || '';
        const parsed = parseDescription(props.description || '');

        if (parsed.limits && !lowerLimit) lowerLimit = parsed.limits.lower;
        if (parsed.limits && !upperLimit) upperLimit = parsed.limits.upper;

        const limitsLine = (lowerLimit || upperLimit)
            ? (lowerLimit || 'SFC') + ' – ' + (upperLimit || 'UNL')
            : '';

        const wrapClass =
            variant === 'panel'
                ? 'airspace-detail-inner airspace-detail-inner--panel'
                : 'airspace-popup';

        let html = '<div class="' + wrapClass + '">';
        html += '<div class="airspace-popup-header">';
        html += '<div class="airspace-popup-title">' + escapeHtml(name) + '</div>';
        html +=
            '<span class="airspace-popup-badge" style="background:' +
            typeInfo.color +
            ';color:white">' +
            escapeHtml(typeInfo.label) +
            '</span>';
        html += '</div>';

        if (limitsLine && variant === 'panel') {
            html += '<div class="airspace-vertical-hero">' + escapeHtml(limitsLine) + '</div>';
        }

        if (designator) {
            html += '<div class="airspace-popup-designator">' + escapeHtml(designator) + '</div>';
        }

        html += '<div class="airspace-popup-body">';

        const infoRows = [];
        if (limitsLine && variant !== 'panel') {
            infoRows.push({ label: 'Vertical limits', value: limitsLine });
        }
        if (activation) {
            infoRows.push({ label: 'Activation', value: activation });
        }
        if (parsed.geometry) {
            infoRows.push({ label: 'Geometry', value: parsed.geometry });
        }

        if (infoRows.length > 0) {
            html += '<div class="airspace-popup-info">';
            infoRows.forEach(function (r) {
                html +=
                    '<div class="airspace-popup-row"><span class="airspace-popup-label">' +
                    escapeHtml(r.label) +
                    '</span><span class="airspace-popup-value">' +
                    escapeHtml(r.value) +
                    '</span></div>';
            });
            html += '</div>';
        }

        if (parsed.sections.length > 0) {
            html += '<div class="airspace-popup-details">';
            parsed.sections.forEach(function (s) {
                html += '<div class="airspace-popup-detail">' + escapeHtml(s) + '</div>';
            });
            html += '</div>';
        }

        const source = props.source || 'UK AIP ENR 5.1 / NATS UAS';
        html += '<div class="airspace-popup-source">' + escapeHtml(source) + '</div>';
        html += '</div></div>';
        return html;
    }

    function buildPopupContent(feature) {
        return buildAirspaceDetailHtml(feature, 'popup');
    }

    function init(options) {
        options = options || {};
        const map = options.map;
        const dataUrl = options.dataUrl || 'assets/uk-airspace.geojson';
        const aipDataUrl = options.aipDataUrl || 'assets/uk-aip-airspace.geojson';
        const notamModule = options.notamModule || null;
        const ratModule = options.ratModule || null;

        const prefs = loadPrefs();
        const typeKeys = ['prohibited', 'restricted', 'danger', 'frz'];

        /** @type {{ [key: string]: Array<{ feature: GeoJSON.Feature, bounds: L.LatLngBounds|null, approxAreaKm2: number|null }> }} */
        const allFeaturesByType = {
            prohibited: [],
            restricted: [],
            danger: [],
            frz: []
        };

        let lastPickHits = [];

        function resolvePathStyle(typeKey) {
            const base = AIRSPACE_TYPES[typeKey] || AIRSPACE_TYPES.other;
            let fillOp = prefs.opacity[typeKey];
            if (fillOp == null || typeof fillOp !== 'number') fillOp = base.fillOpacity;
            const zoom = map ? map.getZoom() : LOD_ZOOM_DETAIL;
            fillOp *= zoomFillScale(zoom);
            if (prefs.outlineMode) {
                fillOp = Math.min(fillOp * 0.2, 0.06);
            }
            const weight = prefs.outlineMode ? Math.max(base.weight, 2.5) : base.weight;
            return {
                color: base.color,
                weight: weight,
                fillColor: base.fillColor,
                fillOpacity: Math.min(Math.max(fillOp, 0.01), 0.95)
            };
        }

        function syncLayerVisibilityFromPrefs() {
            typeKeys.forEach(function (key) {
                if (prefs.layers[key]) {
                    addLayerToMap(key);
                } else {
                    removeLayerFromMap(key);
                }
            });
        }

        function shouldCullSmallFeature(typeKey, zoom, entry) {
            if (!prefs.minAreaCullEnabled) return false;
            if (zoom >= LOD_ZOOM_DETAIL) return false;
            if (typeKey !== 'restricted' && typeKey !== 'danger') return false;
            const minA = cullMinAreaKm2ForZoom(zoom);
            if (minA <= 0) return false;
            if (entry.approxAreaKm2 == null) return false;
            return entry.approxAreaKm2 < minA;
        }

        function createLayerForType(typeKey) {
            return L.geoJSON(null, {
                style: function () {
                    return resolvePathStyle(typeKey);
                },
                onEachFeature: function (feature, layer) {
                    if (feature.properties) {
                        const content = buildPopupContent(feature);
                        layer.bindPopup(content, { maxWidth: 420, maxHeight: 480 });
                    }
                }
            });
        }

        const layersByType = {};
        typeKeys.forEach(function (key) {
            layersByType[key] = createLayerForType(key);
        });

        const detailPanelEl = L.DomUtil.create('div', 'airspace-detail-panel');
        detailPanelEl.style.display = 'none';
        detailPanelEl.setAttribute('role', 'dialog');
        detailPanelEl.setAttribute('aria-label', 'Airspace zone');

        function closeAirspaceDetailPanel() {
            detailPanelEl.style.display = 'none';
            detailPanelEl.innerHTML = '';
            lastPickHits = [];
        }

        function wireAirspaceDetailPanel() {
            const closes = detailPanelEl.querySelectorAll('.airspace-detail-close');
            for (let c = 0; c < closes.length; c++) {
                L.DomEvent.on(closes[c], 'click', function (ev) {
                    L.DomEvent.stop(ev);
                    closeAirspaceDetailPanel();
                });
            }
        }

        L.DomEvent.on(detailPanelEl, 'click', function (ev) {
            const t = ev.target;
            if (!t || !t.closest) return;
            const btn = t.closest('.airspace-pick-item');
            if (!btn || !detailPanelEl.contains(btn)) return;
            L.DomEvent.stop(ev);
            const idx = parseInt(btn.getAttribute('data-idx'), 10);
            const hit = lastPickHits[idx];
            if (!hit || !hit.feature) return;
            openAirspaceDetailPanel(
                '<button type="button" class="airspace-detail-close airspace-detail-close--floating" aria-label="Close">&times;</button>' +
                    buildAirspaceDetailHtml(hit.feature, 'panel')
            );
        });

        function openAirspaceDetailPanel(htmlString) {
            detailPanelEl.innerHTML = htmlString;
            detailPanelEl.style.display = 'block';
            wireAirspaceDetailPanel();
        }

        function collectHitsAt(latlng) {
            const lng = latlng.lng;
            const lat = latlng.lat;
            const hits = [];
            typeKeys.forEach(function (key) {
                if (!prefs.layers[key]) return;
                if (!map.hasLayer(layersByType[key])) return;
                layersByType[key].eachLayer(function (ly) {
                    let hit = false;
                    if (ly instanceof L.Circle) {
                        hit = ly.getLatLng().distanceTo(latlng) <= ly.getRadius();
                    } else if (ly.feature && ly.feature.geometry) {
                        hit = pointInGeometry(lng, lat, ly.feature.geometry);
                    }
                    if (!hit) return;
                    let areaKm2 = null;
                    if (ly instanceof L.Circle) {
                        const rKm = ly.getRadius() / 1000;
                        areaKm2 = Math.PI * rKm * rKm;
                    } else if (ly.feature && ly.feature.geometry) {
                        areaKm2 = approxAreaKm2FromBounds(bboxFromGeometry(ly.feature.geometry));
                    }
                    hits.push({
                        typeKey: key,
                        feature: ly.feature,
                        areaKm2: areaKm2
                    });
                });
            });
            hits.sort(function (a, b) {
                const aa = a.areaKm2 == null ? Infinity : a.areaKm2;
                const bb = b.areaKm2 == null ? Infinity : b.areaKm2;
                return aa - bb;
            });
            return hits;
        }

        function renderPickListHtml(hits) {
            lastPickHits = hits;
            let h = '<div class="airspace-detail-inner airspace-detail-inner--panel">';
            h += '<div class="airspace-detail-toolbar">';
            h += '<span class="airspace-detail-title">Zones here</span>';
            h += '<button type="button" class="airspace-detail-close" aria-label="Close">&times;</button>';
            h += '</div>';
            h += '<ul class="airspace-pick-list">';
            for (let i = 0; i < hits.length; i++) {
                const hit = hits[i];
                const props = hit.feature.properties || {};
                const name = props.name || props.designator || 'Unnamed';
                const tk = AIRSPACE_TYPES[hit.typeKey];
                h += '<li><button type="button" class="airspace-pick-item" data-idx="' + i + '">';
                h += '<span class="airspace-pick-badge" style="background:' + tk.color + '"></span>';
                h += '<span class="airspace-pick-label">' + escapeHtml(name) + '</span>';
                h += '</button></li>';
            }
            h += '</ul></div>';
            return h;
        }

        if (map) {
            map.getContainer().appendChild(detailPanelEl);
            L.DomEvent.disableClickPropagation(detailPanelEl);
            map.on('click', function (e) {
                const hits = collectHitsAt(e.latlng);
                if (hits.length === 0) {
                    closeAirspaceDetailPanel();
                    return;
                }
                if (hits.length === 1) {
                    openAirspaceDetailPanel(
                        '<button type="button" class="airspace-detail-close airspace-detail-close--floating" aria-label="Close">&times;</button>' +
                            buildAirspaceDetailHtml(hits[0].feature, 'panel')
                    );
                    return;
                }
                openAirspaceDetailPanel(renderPickListHtml(hits));
            });
            document.addEventListener('keydown', function airspaceDetailEsc(ev) {
                if (ev.key === 'Escape') closeAirspaceDetailPanel();
            });
        }

        function isLodHiddenType(typeKey, zoom) {
            if (prefs.lodMode !== 'essential') return false;
            if (zoom >= LOD_ZOOM_DETAIL) return false;
            return typeKey === 'restricted' || typeKey === 'danger';
        }

        function ingestCollection(data) {
            if (!data || !data.features) return;
            data.features.forEach(function (feature) {
                const typeKey = classifyAirspaceType(feature);
                if (!layersByType[typeKey]) return;
                const bounds = bboxFromGeometry(feature.geometry);
                allFeaturesByType[typeKey].push({
                    feature: feature,
                    bounds: bounds,
                    approxAreaKm2: approxAreaKm2FromBounds(bounds)
                });
            });
        }

        function rebuildFilteredContent() {
            typeKeys.forEach(function (key) {
                const geoLayer = layersByType[key];
                geoLayer.clearLayers();
                const list = allFeaturesByType[key];
                const zoom = map ? map.getZoom() : LOD_ZOOM_DETAIL;
                let padB = null;
                if (prefs.viewportOnly && map) {
                    padB = padBounds(map.getBounds(), VIEWPORT_PAD_RATIO);
                }

                for (let i = 0; i < list.length; i++) {
                    const entry = list[i];
                    if (isLodHiddenType(key, zoom)) continue;
                    if (shouldCullSmallFeature(key, zoom, entry)) continue;
                    if (padB && entry.bounds && entry.bounds.isValid()) {
                        if (!padB.intersects(entry.bounds)) continue;
                    }
                    geoLayer.addData(entry.feature);
                }
                geoLayer.eachLayer(function (ly) {
                    ly.setStyle(resolvePathStyle(key));
                });
            });
        }

        let rebuildTimer = null;
        function scheduleRebuild() {
            if (!map) return;
            clearTimeout(rebuildTimer);
            rebuildTimer = setTimeout(function () {
                rebuildFilteredContent();
                if (legendUpdateLodHint) legendUpdateLodHint();
            }, MAP_REBUILD_DEBOUNCE_MS);
        }

        function applyStylesOnly() {
            typeKeys.forEach(function (key) {
                const geoLayer = layersByType[key];
                const st = resolvePathStyle(key);
                geoLayer.eachLayer(function (ly) {
                    ly.setStyle(st);
                });
            });
        }

        let legendUpdateLodHint = null;

        function addLayerToMap(key) {
            if (map && layersByType[key]) {
                map.addLayer(layersByType[key]);
            }
        }

        function removeLayerFromMap(key) {
            if (map && layersByType[key]) {
                map.removeLayer(layersByType[key]);
            }
        }

        function addAllToMap() {
            typeKeys.forEach(function (key) {
                if (map && layersByType[key]) {
                    map.addLayer(layersByType[key]);
                }
            });
        }

        function removeAllFromMap() {
            typeKeys.forEach(function (key) {
                if (map && layersByType[key]) {
                    map.removeLayer(layersByType[key]);
                }
            });
        }

        let lastValidity = null;
        let validityUpdateCallback = null;

        function loadData(callback) {
            typeKeys.forEach(function (key) {
                allFeaturesByType[key] = [];
                layersByType[key].clearLayers();
            });
            const url = dataUrl + (dataUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
            const aipUrl = aipDataUrl + (aipDataUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
            Promise.all([
                fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
                fetch(aipUrl).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            ]).then(function (results) {
                const enrData = results[0];
                const aipData = results[1];
                if (enrData && enrData.features) {
                    ingestCollection(enrData);
                    lastValidity = enrData.metadata || lastValidity;
                }
                if (aipData && aipData.features && aipData.features.length > 0) {
                    ingestCollection(aipData);
                    if (!lastValidity && aipData.metadata) lastValidity = aipData.metadata;
                }
                rebuildFilteredContent();
                if (validityUpdateCallback) validityUpdateCallback();
                if (callback) callback();
            }).catch(function () {
                if (callback) callback();
            });
        }

        function setValidityUpdateCallback(fn) { validityUpdateCallback = fn; }

        if (map) {
            map.on('moveend', scheduleRebuild);
            map.on('zoomend', scheduleRebuild);
        }

        if (notamModule && typeof notamModule.setOptions === 'function') {
            notamModule.setOptions({
                maxRadius: prefs.notam.maxRadius,
                droneRelevantOnly: prefs.notam.droneRelevantOnly,
                hideAerodromeGround: prefs.notam.hideAerodromeGround,
                hideAboveDroneCeiling:
                    prefs.notam.hideAboveDroneCeiling != null ? prefs.notam.hideAboveDroneCeiling : true,
                droneCeilingFt: prefs.notam.droneCeilingFt != null ? prefs.notam.droneCeilingFt : 600,
                fillOpacity: prefs.notam.fillOpacity
            });
        }

        loadData();

        function createLegendControl() {
            const LegendControl = L.Control.extend({
                options: { position: 'bottomright' },
                onAdd: function () {
                    const container = L.DomUtil.create('div', 'leaflet-control airspace-legend');
                    const header = L.DomUtil.create('div', 'airspace-legend-header', container);
                    const titleSpan = L.DomUtil.create('span', 'airspace-legend-title', header);
                    titleSpan.textContent = 'UK Airspace';
                    const collapseBtn = L.DomUtil.create('button', 'airspace-legend-collapse', header);
                    collapseBtn.type = 'button';
                    collapseBtn.title = 'Collapse';
                    collapseBtn.textContent = '\u25BC';
                    collapseBtn.setAttribute('aria-expanded', 'true');
                    const refreshBtn = L.DomUtil.create('button', 'airspace-legend-refresh', header);
                    refreshBtn.type = 'button';
                    refreshBtn.title = 'Refresh airspace data';
                    refreshBtn.textContent = '\u21BB';
                    L.DomEvent.disableClickPropagation(container);
                    const body = L.DomUtil.create('div', 'airspace-legend-body', container);

                    let syncPresetButtonsImpl = null;
                    function markCustomPreset() {
                        prefs.displayPreset = 'custom';
                        savePrefs(prefs);
                        if (syncPresetButtonsImpl) syncPresetButtonsImpl();
                    }

                    L.DomEvent.on(collapseBtn, 'click', function () {
                        const isCollapsed = body.classList.toggle('airspace-legend-body-collapsed');
                        container.classList.toggle('airspace-legend-collapsed', isCollapsed);
                        collapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
                        collapseBtn.textContent = isCollapsed ? '\u25B6' : '\u25BC';
                        collapseBtn.title = isCollapsed ? 'Expand' : 'Collapse';
                    });
                    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
                        body.classList.add('airspace-legend-body-collapsed');
                        container.classList.add('airspace-legend-collapsed');
                        collapseBtn.setAttribute('aria-expanded', 'false');
                        collapseBtn.textContent = '\u25B6';
                        collapseBtn.title = 'Expand';
                    }
                    L.DomEvent.on(refreshBtn, 'click', function () {
                        refreshBtn.disabled = true;
                        refreshBtn.classList.add('airspace-refreshing');
                        loadData(function () {
                            refreshBtn.disabled = false;
                            refreshBtn.classList.remove('airspace-refreshing');
                        });
                    });

                    const validityEl = L.DomUtil.create('div', 'airspace-legend-validity', body);
                    validityEl.style.fontSize = '10px';
                    validityEl.style.color = '#9ca3af';
                    validityEl.style.marginBottom = '6px';
                    function updateValidityDisplay() {
                        if (lastValidity && lastValidity.effectiveFrom && lastValidity.effectiveTo) {
                            validityEl.textContent = 'Data valid: ' + lastValidity.effectiveFrom + ' – ' + lastValidity.effectiveTo;
                            validityEl.style.display = '';
                        } else {
                            validityEl.style.display = 'none';
                        }
                    }
                    updateValidityDisplay();
                    setValidityUpdateCallback(updateValidityDisplay);

                    const hintEl = L.DomUtil.create('p', 'airspace-legend-hint', body);
                    hintEl.textContent =
                        'Busy area? Use outline mode, essential zoom detail, adjust fill opacity, or zoom in.';

                    const displaySection = L.DomUtil.create('div', 'airspace-display-section', body);
                    const outlineRow = L.DomUtil.create('div', 'airspace-display-row', displaySection);
                    const outlineLabel = L.DomUtil.create('label', 'airspace-display-check', outlineRow);
                    const outlineCb = L.DomUtil.create('input', '', outlineLabel);
                    outlineCb.type = 'checkbox';
                    outlineCb.checked = prefs.outlineMode;
                    outlineLabel.appendChild(document.createTextNode(' Outline only'));
                    L.DomEvent.on(outlineCb, 'change', function () {
                        prefs.outlineMode = outlineCb.checked;
                        savePrefs(prefs);
                        markCustomPreset();
                        applyStylesOnly();
                    });

                    const lodRow = L.DomUtil.create('div', 'airspace-display-row airspace-display-row-select', displaySection);
                    const lodLab = L.DomUtil.create('span', 'airspace-display-label', lodRow);
                    lodLab.textContent = 'Zoom detail';
                    const lodSelect = L.DomUtil.create('select', 'airspace-lod-select', lodRow);
                    [
                        { v: 'essential', l: 'Essential when zoomed out' },
                        { v: 'full', l: 'All types at any zoom' }
                    ].forEach(function (o) {
                        const opt = L.DomUtil.create('option', '', lodSelect);
                        opt.value = o.v;
                        opt.textContent = o.l;
                        if (o.v === prefs.lodMode) opt.selected = true;
                    });
                    L.DomEvent.on(lodSelect, 'change', function () {
                        prefs.lodMode = lodSelect.value === 'full' ? 'full' : 'essential';
                        savePrefs(prefs);
                        markCustomPreset();
                        rebuildFilteredContent();
                        if (legendUpdateLodHint) legendUpdateLodHint();
                        refreshLodDimming();
                    });

                    const vpRow = L.DomUtil.create('div', 'airspace-display-row', displaySection);
                    const vpLabel = L.DomUtil.create('label', 'airspace-display-check', vpRow);
                    const vpCb = L.DomUtil.create('input', '', vpLabel);
                    vpCb.type = 'checkbox';
                    vpCb.checked = prefs.viewportOnly;
                    vpLabel.appendChild(document.createTextNode(' Only features in view'));
                    L.DomEvent.on(vpCb, 'change', function () {
                        prefs.viewportOnly = vpCb.checked;
                        savePrefs(prefs);
                        markCustomPreset();
                        rebuildFilteredContent();
                    });

                    const minAreaRow = L.DomUtil.create('div', 'airspace-display-row', displaySection);
                    const minAreaLabel = L.DomUtil.create('label', 'airspace-display-check', minAreaRow);
                    const minAreaCullCb = L.DomUtil.create('input', '', minAreaLabel);
                    minAreaCullCb.type = 'checkbox';
                    minAreaCullCb.checked = prefs.minAreaCullEnabled;
                    minAreaCullCb.title = 'Hide small Restricted/Danger zones when map is zoomed out';
                    minAreaLabel.appendChild(document.createTextNode(' Hide tiny R/D when zoomed out'));
                    L.DomEvent.on(minAreaCullCb, 'change', function () {
                        prefs.minAreaCullEnabled = minAreaCullCb.checked;
                        savePrefs(prefs);
                        markCustomPreset();
                        rebuildFilteredContent();
                    });

                    const lodNote = L.DomUtil.create('div', 'airspace-lod-note', displaySection);

                    legendUpdateLodHint = function () {
                        if (!map || !lodNote) return;
                        if (prefs.lodMode !== 'essential') {
                            lodNote.style.display = 'none';
                            return;
                        }
                        const z = map.getZoom();
                        if (z < LOD_ZOOM_DETAIL) {
                            lodNote.style.display = '';
                            lodNote.textContent = 'Below zoom ' + LOD_ZOOM_DETAIL + ', Restricted & Danger stay hidden until you zoom in.';
                        } else {
                            lodNote.style.display = 'none';
                        }
                    };
                    legendUpdateLodHint();

                    const opacityToggle = L.DomUtil.create('button', 'airspace-opacity-toggle', body);
                    opacityToggle.type = 'button';
                    opacityToggle.textContent = 'Fill opacity per layer \u25BC';
                    const opacityWrap = L.DomUtil.create('div', 'airspace-opacity-section', body);
                    opacityWrap.style.display = 'none';
                    const opacityRanges = {};

                    typeKeys.forEach(function (key) {
                        const info = AIRSPACE_TYPES[key];
                        const row = L.DomUtil.create('div', 'airspace-opacity-row', opacityWrap);
                        const lab = L.DomUtil.create('span', 'airspace-opacity-type', row);
                        lab.textContent = info.label;
                        const rng = L.DomUtil.create('input', 'airspace-opacity-range', row);
                        rng.type = 'range';
                        rng.min = '0.03';
                        rng.max = '0.32';
                        rng.step = '0.01';
                        const defOp = prefs.opacity[key] != null ? prefs.opacity[key] : info.fillOpacity;
                        rng.value = String(defOp);
                        rng.title = info.label + ' fill opacity';
                        opacityRanges[key] = rng;
                        L.DomEvent.on(rng, 'input', function () {
                            prefs.opacity[key] = parseFloat(rng.value);
                            savePrefs(prefs);
                            markCustomPreset();
                            applyStylesOnly();
                        });
                    });
                    const resetOpacityBtn = L.DomUtil.create('button', 'airspace-opacity-reset', opacityWrap);
                    resetOpacityBtn.type = 'button';
                    resetOpacityBtn.textContent = 'Reset to defaults';
                    L.DomEvent.on(resetOpacityBtn, 'click', function () {
                        typeKeys.forEach(function (key) {
                            prefs.opacity[key] = null;
                            const r = opacityRanges[key];
                            if (r) r.value = String(AIRSPACE_TYPES[key].fillOpacity);
                        });
                        savePrefs(prefs);
                        markCustomPreset();
                        applyStylesOnly();
                    });
                    L.DomEvent.on(opacityToggle, 'click', function (e) {
                        L.DomEvent.stop(e);
                        const open = opacityWrap.style.display !== 'none';
                        opacityWrap.style.display = open ? 'none' : 'block';
                        opacityToggle.textContent = open ? 'Fill opacity per layer \u25BC' : 'Fill opacity per layer \u25B2';
                    });

                    const list = L.DomUtil.create('ul', 'airspace-legend-list', body);
                    const itemLiByType = {};

                    const selectAllLi = L.DomUtil.create('li', 'airspace-legend-item airspace-legend-item-select-all', list);
                    const selectAllLabel = L.DomUtil.create('label', 'airspace-legend-item-label', selectAllLi);
                    selectAllLabel.style.cursor = 'pointer';
                    const selectAllCb = L.DomUtil.create('input', 'airspace-legend-item-cb airspace-select-all-cb', selectAllLabel);
                    selectAllCb.type = 'checkbox';
                    selectAllCb.dataset.type = 'select-all';
                    selectAllCb.title = 'Show UK airspace restrictions (NATS UAS / UK AIP ENR 5.1)';
                    const selectAllLbl = L.DomUtil.create('span', 'airspace-legend-label', selectAllLabel);
                    selectAllLbl.textContent = 'Select all';
                    function updateSelectAllState() {
                        const itemCbs = container.querySelectorAll('.airspace-legend-item-cb:not(.airspace-select-all-cb)');
                        let allChecked = true;
                        itemCbs.forEach(function (cb) {
                            const key = cb.dataset.type;
                            if (key === 'rat') return;
                            if (!cb.checked) allChecked = false;
                        });
                        selectAllCb.checked = allChecked;
                    }
                    L.DomEvent.on(selectAllCb, 'change', function () {
                        const itemCbs = container.querySelectorAll('.airspace-legend-item-cb:not(.airspace-select-all-cb)');
                        itemCbs.forEach(function (cb) {
                            const key = cb.dataset.type;
                            if (key === 'rat') return;
                            if (key === 'notam') {
                                if (!notamModule) return;
                                cb.checked = selectAllCb.checked;
                                prefs.notam.mapEnabled = selectAllCb.checked;
                                if (selectAllCb.checked) {
                                    notamModule.loadNotams(function () {
                                        notamModule.addToMap();
                                    });
                                } else {
                                    notamModule.removeFromMap();
                                }
                                return;
                            }
                            cb.checked = selectAllCb.checked;
                            prefs.layers[key] = selectAllCb.checked;
                            if (selectAllCb.checked) {
                                addLayerToMap(key);
                            } else {
                                removeLayerFromMap(key);
                            }
                        });
                        savePrefs(prefs);
                        markCustomPreset();
                    });
                    typeKeys.forEach(function (key) {
                        const info = AIRSPACE_TYPES[key];
                        const li = L.DomUtil.create('li', 'airspace-legend-item', list);
                        itemLiByType[key] = li;
                        const itemLabel = L.DomUtil.create('label', 'airspace-legend-item-label', li);
                        itemLabel.style.cursor = 'pointer';
                        const cb = L.DomUtil.create('input', 'airspace-legend-item-cb', itemLabel);
                        cb.type = 'checkbox';
                        cb.dataset.type = key;
                        cb.checked = !!prefs.layers[key];
                        const swatch = L.DomUtil.create('span', 'airspace-legend-swatch', itemLabel);
                        swatch.style.backgroundColor = info.color;
                        const lbl = L.DomUtil.create('span', 'airspace-legend-label', itemLabel);
                        lbl.textContent = info.label;
                        if (cb.checked) {
                            addLayerToMap(key);
                        }
                        L.DomEvent.on(cb, 'change', function () {
                            prefs.layers[key] = cb.checked;
                            savePrefs(prefs);
                            markCustomPreset();
                            if (cb.checked) {
                                addLayerToMap(key);
                            } else {
                                removeLayerFromMap(key);
                            }
                            updateSelectAllState();
                        });
                    });
                    updateSelectAllState();

                    function refreshLodDimming() {
                        if (!map) return;
                        const z = map.getZoom();
                        const dim = prefs.lodMode === 'essential' && z < LOD_ZOOM_DETAIL;
                        ['restricted', 'danger'].forEach(function (key) {
                            const li = itemLiByType[key];
                            if (!li) return;
                            li.classList.toggle('airspace-legend-item-lod-dimmed', dim);
                        });
                    }
                    refreshLodDimming();
                    map.on('zoomend', refreshLodDimming);

                    const presetRow = L.DomUtil.create('div', 'airspace-preset-row', body);
                    const readableBtn = L.DomUtil.create('button', 'airspace-preset-btn', presetRow);
                    readableBtn.type = 'button';
                    readableBtn.textContent = 'Readable';
                    readableBtn.title = 'Outline, essential zoom, viewport, lighter fills';
                    const fullBtn = L.DomUtil.create('button', 'airspace-preset-btn', presetRow);
                    fullBtn.type = 'button';
                    fullBtn.textContent = 'Full regulatory';
                    fullBtn.title = 'All categories on, full zoom detail, stronger fills';

                    function applyReadablePreset() {
                        prefs.displayPreset = 'readable';
                        prefs.outlineMode = true;
                        prefs.lodMode = 'essential';
                        prefs.viewportOnly = true;
                        prefs.minAreaCullEnabled = true;
                        prefs.layers = {
                            prohibited: true,
                            restricted: false,
                            danger: false,
                            frz: true
                        };
                        prefs.opacity = {
                            prohibited: 0.11,
                            restricted: 0.06,
                            danger: 0.06,
                            frz: 0.11
                        };
                        savePrefs(prefs);
                        outlineCb.checked = true;
                        lodSelect.value = 'essential';
                        vpCb.checked = true;
                        minAreaCullCb.checked = true;
                        typeKeys.forEach(function (key) {
                            const li = itemLiByType[key];
                            if (li) {
                                const inp = li.querySelector('.airspace-legend-item-cb');
                                if (inp) inp.checked = !!prefs.layers[key];
                            }
                            const r = opacityRanges[key];
                            if (r) r.value = String(prefs.opacity[key]);
                        });
                        syncLayerVisibilityFromPrefs();
                        rebuildFilteredContent();
                        applyStylesOnly();
                        if (legendUpdateLodHint) legendUpdateLodHint();
                        refreshLodDimming();
                        updateSelectAllState();
                        syncPresetButtonsImpl();
                    }

                    function applyFullPreset() {
                        prefs.displayPreset = 'full';
                        prefs.outlineMode = false;
                        prefs.lodMode = 'full';
                        prefs.viewportOnly = false;
                        prefs.minAreaCullEnabled = false;
                        prefs.layers = {
                            prohibited: true,
                            restricted: true,
                            danger: true,
                            frz: true
                        };
                        prefs.opacity = {
                            prohibited: null,
                            restricted: null,
                            danger: null,
                            frz: null
                        };
                        savePrefs(prefs);
                        outlineCb.checked = false;
                        lodSelect.value = 'full';
                        vpCb.checked = false;
                        minAreaCullCb.checked = false;
                        typeKeys.forEach(function (key) {
                            const li = itemLiByType[key];
                            if (li) {
                                const inp = li.querySelector('.airspace-legend-item-cb');
                                if (inp) inp.checked = !!prefs.layers[key];
                            }
                            const r = opacityRanges[key];
                            if (r) r.value = String(AIRSPACE_TYPES[key].fillOpacity);
                        });
                        syncLayerVisibilityFromPrefs();
                        rebuildFilteredContent();
                        applyStylesOnly();
                        if (legendUpdateLodHint) legendUpdateLodHint();
                        refreshLodDimming();
                        updateSelectAllState();
                        syncPresetButtonsImpl();
                    }

                    syncPresetButtonsImpl = function () {
                        readableBtn.classList.toggle('airspace-preset-active', prefs.displayPreset === 'readable');
                        fullBtn.classList.toggle('airspace-preset-active', prefs.displayPreset === 'full');
                    };
                    L.DomEvent.on(readableBtn, 'click', function (e) {
                        L.DomEvent.stop(e);
                        applyReadablePreset();
                    });
                    L.DomEvent.on(fullBtn, 'click', function (e) {
                        L.DomEvent.stop(e);
                        applyFullPreset();
                    });
                    syncPresetButtonsImpl();

                    if (notamModule) {
                        const li = L.DomUtil.create('li', 'airspace-legend-item airspace-legend-item-notam', list);
                        const mainRow = L.DomUtil.create('div', 'airspace-notam-main-row', li);
                        const itemLabel = L.DomUtil.create('label', 'airspace-legend-item-label airspace-notam-primary', mainRow);
                        itemLabel.style.cursor = 'pointer';
                        const cb = L.DomUtil.create('input', 'airspace-legend-item-cb', itemLabel);
                        cb.type = 'checkbox';
                        cb.dataset.type = 'notam';
                        cb.checked = prefs.notam.mapEnabled === true;
                        const swatch = L.DomUtil.create('span', 'airspace-legend-swatch', itemLabel);
                        swatch.style.backgroundColor = '#dc2626';
                        const lbl = L.DomUtil.create('span', 'airspace-legend-label', itemLabel);
                        lbl.textContent = 'NOTAM';
                        const droneInline = L.DomUtil.create('label', 'airspace-notam-inline-check', mainRow);
                        const droneCb = L.DomUtil.create('input', 'airspace-notam-drone-cb', droneInline);
                        droneCb.type = 'checkbox';
                        droneCb.checked = !!prefs.notam.droneRelevantOnly;
                        droneInline.title = 'Drone-focused: UAS/hazard keywords, UAS check, and event/restriction triage';
                        droneInline.appendChild(document.createTextNode(' Drone'));
                        const adInline = L.DomUtil.create('label', 'airspace-notam-inline-check', mainRow);
                        const adCb = L.DomUtil.create('input', 'airspace-notam-ad-cb', adInline);
                        adCb.type = 'checkbox';
                        adCb.checked = !!prefs.notam.hideAerodromeGround;
                        adInline.title = 'Hide typical aerodrome ground-ops NOTAMs';
                        adInline.appendChild(document.createTextNode(' Hide ops'));
                        const expandBtn = L.DomUtil.create('button', 'airspace-notam-expand', mainRow);
                        expandBtn.type = 'button';
                        expandBtn.title = 'More NOTAM options';
                        expandBtn.textContent = '\u25BC';
                        const optsWrap = L.DomUtil.create('div', 'airspace-notam-options', li);
                        optsWrap.style.display = 'none';
                        L.DomEvent.on(expandBtn, 'click', function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            const isOpen = optsWrap.style.display !== 'none';
                            optsWrap.style.display = isOpen ? 'none' : 'block';
                            expandBtn.textContent = isOpen ? '\u25BC' : '\u25B2';
                        });
                        const ceilingRow = L.DomUtil.create('div', 'airspace-notam-option-row', optsWrap);
                        const ceilingLbl = L.DomUtil.create('label', 'airspace-notam-option-label', ceilingRow);
                        const ceilingCb = L.DomUtil.create('input', '', ceilingLbl);
                        ceilingCb.type = 'checkbox';
                        ceilingCb.checked =
                            prefs.notam.hideAboveDroneCeiling != null ? !!prefs.notam.hideAboveDroneCeiling : true;
                        ceilingLbl.appendChild(
                            document.createTextNode(' Hide NOTAMs above 600 ft (Q-line; SFC–600 ft band)')
                        );
                        ceilingLbl.title =
                            'Drop NOTAMs whose lower vertical limit is entirely above FL006 (600 ft). Unknown Q-line: kept.';

                        notamModule.setOptions({
                            droneRelevantOnly: droneCb.checked,
                            hideAerodromeGround: adCb.checked,
                            hideAboveDroneCeiling: ceilingCb.checked,
                            droneCeilingFt: prefs.notam.droneCeilingFt != null ? prefs.notam.droneCeilingFt : 600,
                            maxRadius: prefs.notam.maxRadius,
                            fillOpacity: prefs.notam.fillOpacity
                        });
                        L.DomEvent.on(cb, 'change', function () {
                            prefs.notam.mapEnabled = cb.checked;
                            savePrefs(prefs);
                            if (cb.checked) {
                                notamModule.loadNotams(function () {
                                    notamModule.addToMap();
                                });
                            } else {
                                notamModule.removeFromMap();
                            }
                            updateSelectAllState();
                        });
                        function persistNotamOpts() {
                            prefs.notam.droneRelevantOnly = droneCb.checked;
                            prefs.notam.hideAerodromeGround = adCb.checked;
                            prefs.notam.hideAboveDroneCeiling = ceilingCb.checked;
                            prefs.notam.droneCeilingFt =
                                prefs.notam.droneCeilingFt != null ? prefs.notam.droneCeilingFt : 600;
                            savePrefs(prefs);
                            notamModule.setOptions({
                                droneRelevantOnly: prefs.notam.droneRelevantOnly,
                                hideAerodromeGround: prefs.notam.hideAerodromeGround,
                                hideAboveDroneCeiling: prefs.notam.hideAboveDroneCeiling,
                                droneCeilingFt: prefs.notam.droneCeilingFt
                            });
                        }
                        L.DomEvent.on(droneCb, 'change', persistNotamOpts);
                        L.DomEvent.on(adCb, 'change', persistNotamOpts);
                        L.DomEvent.on(ceilingCb, 'change', persistNotamOpts);

                        const maxRadiusRow = L.DomUtil.create('div', 'airspace-notam-option-row', optsWrap);
                        const maxRadiusLabel = L.DomUtil.create('label', 'airspace-notam-option-label', maxRadiusRow);
                        maxRadiusLabel.textContent = 'Max radius';
                        const maxRadiusSelect = L.DomUtil.create('select', 'airspace-notam-select', maxRadiusRow);
                        [ { v: 5, l: '5 NM' }, { v: 10, l: '10 NM' }, { v: 12, l: '12 NM' }, { v: 20, l: '20 NM' }, { v: 50, l: '50 NM' }, { v: 999, l: 'All' } ].forEach(function (o) {
                            const opt = L.DomUtil.create('option', '', maxRadiusSelect);
                            opt.value = String(o.v);
                            opt.textContent = o.l;
                            if (o.v === prefs.notam.maxRadius) opt.selected = true;
                        });
                        if (!maxRadiusSelect.value) {
                            maxRadiusSelect.value = '12';
                        }
                        L.DomEvent.on(maxRadiusSelect, 'change', function () {
                            prefs.notam.maxRadius = parseInt(maxRadiusSelect.value, 10);
                            savePrefs(prefs);
                            notamModule.setOptions({ maxRadius: prefs.notam.maxRadius });
                        });
                        const opacityRow = L.DomUtil.create('div', 'airspace-notam-option-row', optsWrap);
                        const opacityLabel = L.DomUtil.create('label', 'airspace-notam-option-label', opacityRow);
                        opacityLabel.textContent = 'Opacity';
                        const opacityRange = L.DomUtil.create('input', 'airspace-notam-opacity', opacityRow);
                        opacityRange.type = 'range';
                        opacityRange.min = '0.03';
                        opacityRange.max = '0.2';
                        opacityRange.step = '0.01';
                        opacityRange.value = String(prefs.notam.fillOpacity);
                        opacityRange.title = 'Fill opacity';
                        L.DomEvent.on(opacityRange, 'input', function () {
                            const val = parseFloat(opacityRange.value);
                            prefs.notam.fillOpacity = val;
                            savePrefs(prefs);
                            notamModule.setOptions({ fillOpacity: val });
                        });
                        if (cb.checked) {
                            notamModule.loadNotams(function () {
                                notamModule.addToMap();
                            });
                        }
                        updateSelectAllState();
                    }
                    if (ratModule) {
                        const li = L.DomUtil.create('li', 'airspace-legend-item', list);
                        const itemLabel = L.DomUtil.create('label', 'airspace-legend-item-label', li);
                        itemLabel.style.cursor = 'pointer';
                        const cb = L.DomUtil.create('input', 'airspace-legend-item-cb', itemLabel);
                        cb.type = 'checkbox';
                        cb.dataset.type = 'rat';
                        const swatch = L.DomUtil.create('span', 'airspace-legend-swatch', itemLabel);
                        swatch.style.backgroundColor = '#7c3aed';
                        const lbl = L.DomUtil.create('span', 'airspace-legend-label', itemLabel);
                        lbl.textContent = 'RA(T)';
                        L.DomEvent.on(cb, 'change', function () {
                            if (cb.checked) {
                                const bounds = map.getBounds();
                                ratModule.loadRAT(bounds, function () {
                                    ratModule.addToMap();
                                });
                            } else {
                                ratModule.removeFromMap();
                            }
                        });
                    }
                    return container;
                }
            });
            return new LegendControl();
        }

        return {
            layersByType: layersByType,
            addAllToMap: addAllToMap,
            removeAllFromMap: removeAllFromMap,
            loadData: loadData,
            createLegendControl: createLegendControl,
            setValidityUpdateCallback: setValidityUpdateCallback,
            AIRSPACE_TYPES: AIRSPACE_TYPES,
            classifyAirspaceType: classifyAirspaceType
        };
    }

    global.Airspace = { init: init, AIRSPACE_TYPES: AIRSPACE_TYPES };
})(typeof window !== 'undefined' ? window : this);
