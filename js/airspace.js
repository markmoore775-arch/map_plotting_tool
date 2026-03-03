/* ============================================
   AIRSPACE MODULE - UK Airspace Restrictions
   Multi-layer support: Prohibited, Restricted, Danger, FRZ
   Data: NATS UAS / UK AIP ENR 5.1
   ============================================ */

(function (global) {
    'use strict';

    const AIRSPACE_TYPES = {
        prohibited: {
            label: 'Prohibited',
            color: '#dc2626',
            fillColor: '#dc2626',
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
            description: 'Other airspace restriction'
        }
    };

    /**
     * Classify a feature into an airspace type from its properties.
     * NATS UAS: EGP (Prohibited), EGR/EGRU (Restricted), EGD (Danger).
     * FRZ zones use EGRU designators but have "FRZ Active" in description - check description first.
     */
    function classifyAirspaceType(feature) {
        const props = feature.properties || {};
        const designator = (props.designator || props.type || props.id || '').toUpperCase();
        const name = (props.name || '').toUpperCase();
        const description = (props.description || '').toUpperCase();

        if (description.includes('FRZ') || designator.includes('FRZ') || designator.includes('RPZ') || name.includes('FRZ') || name.includes('AERODROME') || name.includes('FLIGHT RESTRICTION')) {
            return 'frz';
        }
        if (designator.startsWith('EG-P') || designator.startsWith('EGP') || designator.startsWith('P') || name.includes('PROHIBITED')) {
            return 'prohibited';
        }
        if (designator.startsWith('EG-R') || designator.startsWith('EGR') || designator.startsWith('R') || name.includes('RESTRICTED')) {
            return 'restricted';
        }
        if (designator.startsWith('EG-D') || designator.startsWith('EGD') || designator.startsWith('D') || name.includes('DANGER')) {
            return 'danger';
        }

        return 'other';
    }

    function escapeHtml(str) {
        if (str == null || str === '') return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Parse NATS HTML description into structured sections.
     */
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
     * Build rich popup content for an airspace feature.
     */
    function buildPopupContent(feature) {
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

        let html = '<div class="airspace-popup">';
        html += '<div class="airspace-popup-header">';
        html += '<div class="airspace-popup-title">' + escapeHtml(name) + '</div>';
        html += '<span class="airspace-popup-badge" style="background:' + typeInfo.color + ';color:white">' + escapeHtml(typeInfo.label) + '</span>';
        html += '</div>';
        if (designator) {
            html += '<div class="airspace-popup-designator">' + escapeHtml(designator) + '</div>';
        }

        html += '<div class="airspace-popup-body">';

        const infoRows = [];
        if (lowerLimit || upperLimit) {
            infoRows.push({ label: 'Vertical limits', value: (lowerLimit || 'SFC') + ' – ' + (upperLimit || 'UNL') });
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
                html += '<div class="airspace-popup-row"><span class="airspace-popup-label">' + escapeHtml(r.label) + '</span><span class="airspace-popup-value">' + escapeHtml(r.value) + '</span></div>';
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

        html += '<div class="airspace-popup-source">UK AIP ENR 5.1 / NATS UAS</div>';
        html += '</div></div>';
        return html;
    }

    /**
     * Create a GeoJSON layer for a specific airspace type.
     */
    function createLayerForType(typeKey) {
        const style = AIRSPACE_TYPES[typeKey] || AIRSPACE_TYPES.other;
        return L.geoJSON(null, {
            style: {
                color: style.color,
                weight: style.weight,
                fillColor: style.fillColor,
                fillOpacity: style.fillOpacity
            },
            onEachFeature: function (feature, layer) {
                if (feature.properties) {
                    const content = buildPopupContent(feature);
                    layer.bindPopup(content, { maxWidth: 420, maxHeight: 480 });
                }
            }
        });
    }

    /**
     * Split GeoJSON FeatureCollection by type and add to respective layers.
     */
    function addDataToLayers(data, layersByType) {
        if (!data || !data.features) return;
        data.features.forEach(function (feature) {
            const typeKey = classifyAirspaceType(feature);
            const layer = layersByType[typeKey];
            if (layer) {
                layer.addData(feature);
            }
        });
    }

    /**
     * Initialize airspace layers and load data.
     * Returns { layersByType, addAllToMap, removeAllFromMap, loadData }
     */
    function init(options) {
        options = options || {};
        const map = options.map;
        const dataUrl = options.dataUrl || 'assets/uk-airspace.geojson';

        const layersByType = {};
        const typeKeys = ['prohibited', 'restricted', 'danger', 'frz', 'other'];
        typeKeys.forEach(function (key) {
            layersByType[key] = createLayerForType(key);
        });

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

        function loadData(callback) {
            typeKeys.forEach(function (key) {
                layersByType[key].clearLayers();
            });
            const url = dataUrl + (dataUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
            fetch(url)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    addDataToLayers(data, layersByType);
                    if (callback) callback();
                })
                .catch(function () {
                    if (callback) callback();
                });
        }

        loadData();

        /**
         * Create combined legend control with integrated toggle and refresh.
         */
        function createLegendControl() {
            const LegendControl = L.Control.extend({
                options: { position: 'bottomleft' },
                onAdd: function () {
                    const container = L.DomUtil.create('div', 'leaflet-control airspace-legend');
                    const header = L.DomUtil.create('div', 'airspace-legend-header', container);
                    const label = L.DomUtil.create('label', 'airspace-toggle-label', header);
                    const input = L.DomUtil.create('input', 'airspace-toggle-input', label);
                    input.type = 'checkbox';
                    input.checked = false;
                    input.title = 'Show UK airspace restrictions (NATS UAS / UK AIP ENR 5.1)';
                    const span = L.DomUtil.create('span', 'airspace-toggle-text', label);
                    span.textContent = 'UK Airspace';
                    const refreshBtn = L.DomUtil.create('button', 'airspace-legend-refresh', header);
                    refreshBtn.type = 'button';
                    refreshBtn.title = 'Refresh airspace data';
                    refreshBtn.textContent = '\u21BB';
                    L.DomEvent.disableClickPropagation(container);
                    L.DomEvent.on(input, 'change', function () {
                        const checkboxes = container.querySelectorAll('.airspace-legend-item-cb');
                        checkboxes.forEach(function (cb) {
                            cb.checked = input.checked;
                            const key = cb.dataset.type;
                            if (input.checked) {
                                addLayerToMap(key);
                            } else {
                                removeLayerFromMap(key);
                            }
                        });
                    });
                    L.DomEvent.on(refreshBtn, 'click', function () {
                        refreshBtn.disabled = true;
                        refreshBtn.classList.add('airspace-refreshing');
                        loadData(function () {
                            refreshBtn.disabled = false;
                            refreshBtn.classList.remove('airspace-refreshing');
                        });
                    });
                    const list = L.DomUtil.create('ul', 'airspace-legend-list', container);
                    const types = ['prohibited', 'restricted', 'danger', 'frz', 'other'];
                    types.forEach(function (key) {
                        const info = AIRSPACE_TYPES[key];
                        const li = L.DomUtil.create('li', 'airspace-legend-item', list);
                        const itemLabel = L.DomUtil.create('label', 'airspace-legend-item-label', li);
                        itemLabel.style.cursor = 'pointer';
                        const cb = L.DomUtil.create('input', 'airspace-legend-item-cb', itemLabel);
                        cb.type = 'checkbox';
                        cb.dataset.type = key;
                        const swatch = L.DomUtil.create('span', 'airspace-legend-swatch', itemLabel);
                        swatch.style.backgroundColor = info.color;
                        const lbl = L.DomUtil.create('span', 'airspace-legend-label', itemLabel);
                        lbl.textContent = info.label;
                        L.DomEvent.on(cb, 'change', function () {
                            if (cb.checked) {
                                addLayerToMap(key);
                            } else {
                                removeLayerFromMap(key);
                            }
                        });
                    });
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
            AIRSPACE_TYPES: AIRSPACE_TYPES,
            classifyAirspaceType: classifyAirspaceType
        };
    }

    global.Airspace = { init: init, AIRSPACE_TYPES: AIRSPACE_TYPES };
})(typeof window !== 'undefined' ? window : this);
