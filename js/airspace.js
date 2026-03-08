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
        const aixmType = (props.type || '').toUpperCase();

        if (description.includes('FRZ') || designator.includes('FRZ') || designator.includes('RPZ') || name.includes('FRZ') || name.includes('AERODROME') || name.includes('FLIGHT RESTRICTION')) {
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

        const source = props.source || 'UK AIP ENR 5.1 / NATS UAS';
        html += '<div class="airspace-popup-source">' + escapeHtml(source) + '</div>';
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
        const aipDataUrl = options.aipDataUrl || 'assets/uk-aip-airspace.geojson';
        const notamModule = options.notamModule || null;
        const ratModule = options.ratModule || null;

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

        let lastValidity = null;

        let validityUpdateCallback = null;
        function loadData(callback) {
            typeKeys.forEach(function (key) {
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
                    addDataToLayers(enrData, layersByType);
                    lastValidity = enrData.metadata || lastValidity;
                }
                if (aipData && aipData.features && aipData.features.length > 0) {
                    addDataToLayers(aipData, layersByType);
                    if (!lastValidity && aipData.metadata) lastValidity = aipData.metadata;
                }
                if (validityUpdateCallback) validityUpdateCallback();
                if (callback) callback();
            }).catch(function () {
                if (callback) callback();
            });
        }
        function setValidityUpdateCallback(fn) { validityUpdateCallback = fn; }

        loadData();

        /**
         * Create combined legend control with integrated toggle and refresh.
         */
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
                    L.DomEvent.on(collapseBtn, 'click', function () {
                        const isCollapsed = body.classList.toggle('airspace-legend-body-collapsed');
                        container.classList.toggle('airspace-legend-collapsed', isCollapsed);
                        collapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
                        collapseBtn.textContent = isCollapsed ? '\u25B6' : '\u25BC';
                        collapseBtn.title = isCollapsed ? 'Expand' : 'Collapse';
                    });
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

                    const list = L.DomUtil.create('ul', 'airspace-legend-list', body);
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
                            if (key === 'notam' || key === 'rat') return;
                            if (!cb.checked) allChecked = false;
                        });
                        selectAllCb.checked = allChecked;
                    }
                    L.DomEvent.on(selectAllCb, 'change', function () {
                        const itemCbs = container.querySelectorAll('.airspace-legend-item-cb:not(.airspace-select-all-cb)');
                        itemCbs.forEach(function (cb) {
                            const key = cb.dataset.type;
                            if (key === 'notam' || key === 'rat') return;
                            cb.checked = selectAllCb.checked;
                            if (selectAllCb.checked) {
                                addLayerToMap(key);
                            } else {
                                removeLayerFromMap(key);
                            }
                        });
                    });
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
                            updateSelectAllState();
                        });
                    });
                    if (notamModule) {
                        const li = L.DomUtil.create('li', 'airspace-legend-item airspace-legend-item-notam', list);
                        const itemLabel = L.DomUtil.create('label', 'airspace-legend-item-label', li);
                        itemLabel.style.cursor = 'pointer';
                        const cb = L.DomUtil.create('input', 'airspace-legend-item-cb', itemLabel);
                        cb.type = 'checkbox';
                        cb.dataset.type = 'notam';
                        const swatch = L.DomUtil.create('span', 'airspace-legend-swatch', itemLabel);
                        swatch.style.backgroundColor = '#059669';
                        const lbl = L.DomUtil.create('span', 'airspace-legend-label', itemLabel);
                        lbl.textContent = 'NOTAM';
                        const expandBtn = L.DomUtil.create('button', 'airspace-notam-expand', itemLabel);
                        expandBtn.type = 'button';
                        expandBtn.title = 'NOTAM options';
                        expandBtn.textContent = '\u25BC';
                        expandBtn.style.display = 'none';
                        L.DomEvent.on(expandBtn, 'click', function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            const isOpen = optsWrap.style.display !== 'none';
                            optsWrap.style.display = isOpen ? 'none' : 'block';
                            expandBtn.textContent = isOpen ? '\u25BC' : '\u25B2';
                        });
                        L.DomEvent.on(cb, 'change', function () {
                            if (cb.checked) {
                                notamModule.loadNotams(function () {
                                    notamModule.addToMap();
                                });
                            } else {
                                notamModule.removeFromMap();
                            }
                        });
                        const optsWrap = L.DomUtil.create('div', 'airspace-notam-options', li);
                        optsWrap.style.display = 'none';
                        const maxRadiusRow = L.DomUtil.create('div', 'airspace-notam-option-row', optsWrap);
                        const maxRadiusLabel = L.DomUtil.create('label', 'airspace-notam-option-label', maxRadiusRow);
                        maxRadiusLabel.textContent = 'Max radius';
                        const maxRadiusSelect = L.DomUtil.create('select', 'airspace-notam-select', maxRadiusRow);
                        [ { v: 5, l: '5 NM' }, { v: 10, l: '10 NM' }, { v: 12, l: '12 NM' }, { v: 20, l: '20 NM' }, { v: 50, l: '50 NM' }, { v: 999, l: 'All' } ].forEach(function (o) {
                            const opt = L.DomUtil.create('option', '', maxRadiusSelect);
                            opt.value = String(o.v);
                            opt.textContent = o.l;
                            if (o.v === 12) opt.selected = true;
                        });
                        L.DomEvent.on(maxRadiusSelect, 'change', function () {
                            notamModule.setOptions({ maxRadius: parseInt(maxRadiusSelect.value, 10) });
                        });
                        const droneRow = L.DomUtil.create('div', 'airspace-notam-option-row', optsWrap);
                        const droneLabel = L.DomUtil.create('label', 'airspace-notam-option-label airspace-notam-check-label', droneRow);
                        const droneCb = L.DomUtil.create('input', 'airspace-notam-drone-cb', droneLabel);
                        droneCb.type = 'checkbox';
                        droneCb.title = 'Show only UAS/drone-relevant NOTAMs (cranes, TDA, BVLOS, etc.)';
                        droneLabel.appendChild(document.createTextNode(' Drone-relevant only'));
                        L.DomEvent.on(droneCb, 'change', function () {
                            notamModule.setOptions({ droneRelevantOnly: droneCb.checked });
                        });
                        const opacityRow = L.DomUtil.create('div', 'airspace-notam-option-row', optsWrap);
                        const opacityLabel = L.DomUtil.create('label', 'airspace-notam-option-label', opacityRow);
                        opacityLabel.textContent = 'Opacity';
                        const opacityRange = L.DomUtil.create('input', 'airspace-notam-opacity', opacityRow);
                        opacityRange.type = 'range';
                        opacityRange.min = '0.03';
                        opacityRange.max = '0.2';
                        opacityRange.step = '0.01';
                        opacityRange.value = '0.08';
                        opacityRange.title = 'Fill opacity';
                        L.DomEvent.on(opacityRange, 'input', function () {
                            const val = parseFloat(opacityRange.value);
                            notamModule.setOptions({ fillOpacity: val });
                        });
                        cb.addEventListener('change', function () {
                            if (cb.checked) {
                                expandBtn.style.display = '';
                            } else {
                                expandBtn.style.display = 'none';
                                optsWrap.style.display = 'none';
                                expandBtn.textContent = '\u25BC';
                            }
                        });
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
