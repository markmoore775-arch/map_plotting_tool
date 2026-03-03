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
     * Supports: designator (EG-R201, EG-P500, EG-D301), type, or name patterns.
     */
    function classifyAirspaceType(feature) {
        const props = feature.properties || {};
        const designator = (props.designator || props.type || props.id || '').toUpperCase();
        const name = (props.name || '').toUpperCase();

        if (designator.startsWith('EG-P') || designator.startsWith('EGP') || designator.startsWith('P') || name.includes('PROHIBITED')) {
            return 'prohibited';
        }
        if (designator.startsWith('EG-R') || designator.startsWith('EGR') || designator.startsWith('R') || name.includes('RESTRICTED')) {
            return 'restricted';
        }
        if (designator.startsWith('EG-D') || designator.startsWith('EGD') || designator.startsWith('D') || name.includes('DANGER')) {
            return 'danger';
        }
        if (designator.includes('FRZ') || designator.includes('RPZ') || name.includes('FRZ') || name.includes('AERODROME') || name.includes('FLIGHT RESTRICTION')) {
            return 'frz';
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
     * Build rich popup content for an airspace feature.
     */
    function buildPopupContent(feature) {
        const props = feature.properties || {};
        const typeKey = classifyAirspaceType(feature);
        const typeInfo = AIRSPACE_TYPES[typeKey];
        const name = props.name || props.designator || 'Unnamed';
        const designator = props.designator || props.id || '';
        const lowerLimit = props.lowerLimit || props.lower_limit || props.altitudeBottom || '';
        const upperLimit = props.upperLimit || props.upper_limit || props.altitudeTop || '';
        const activation = props.activation || props.operatingTimes || props.times || '';
        const description = props.description || '';

        let html = '<div class="airspace-popup">';
        html += '<strong>' + escapeHtml(name) + '</strong>';
        if (designator) {
            html += '<div class="airspace-popup-type" style="color:' + typeInfo.color + ';font-size:11px;margin-top:4px;">' + escapeHtml(typeInfo.label) + (designator ? ' · ' + escapeHtml(designator) : '') + '</div>';
        }
        html += '<div class="airspace-popup-body">';

        const rows = [];
        if (lowerLimit || upperLimit) {
            rows.push(['Vertical limits', (lowerLimit || 'SFC') + ' – ' + (upperLimit || 'UNL')]);
        }
        if (activation) {
            rows.push(['Activation', activation]);
        }
        if (rows.length > 0) {
            html += '<table class="airspace-popup-table"><tbody>';
            rows.forEach(function (r) {
                html += '<tr><td>' + escapeHtml(r[0]) + '</td><td>' + escapeHtml(r[1]) + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        if (description) {
            html += '<div class="airspace-popup-desc">' + escapeHtml(description) + '</div>';
        }
        html += '<div class="airspace-popup-source">Source: UK AIP ENR 5.1 / NATS UAS</div>';
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
                    layer.bindPopup(content, { maxWidth: 420, maxHeight: 400 });
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
     * Returns { layersByType, overlayGroups, addAllToMap, removeAllFromMap, loadData }
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

        const overlayGroups = {};
        typeKeys.forEach(function (key) {
            const info = AIRSPACE_TYPES[key];
            overlayGroups['Airspace: ' + info.label] = layersByType[key];
        });

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

        function loadData() {
            fetch(dataUrl)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    addDataToLayers(data, layersByType);
                })
                .catch(function () { /* ignore - layers will be empty */ });
        }

        loadData();

        /**
         * Create a legend control for airspace types.
         */
        function createLegendControl() {
            const LegendControl = L.Control.extend({
                options: { position: 'bottomleft' },
                onAdd: function () {
                    const container = L.DomUtil.create('div', 'leaflet-control airspace-legend');
                    container.innerHTML = '<div class="airspace-legend-title">Airspace</div>';
                    const list = L.DomUtil.create('ul', 'airspace-legend-list', container);
                    const types = ['prohibited', 'restricted', 'danger', 'frz', 'other'];
                    types.forEach(function (key) {
                        const info = AIRSPACE_TYPES[key];
                        const li = L.DomUtil.create('li', 'airspace-legend-item', list);
                        const span = L.DomUtil.create('span', 'airspace-legend-swatch', li);
                        span.style.backgroundColor = info.color;
                        const label = L.DomUtil.create('span', 'airspace-legend-label', li);
                        label.textContent = info.label;
                    });
                    L.DomEvent.disableClickPropagation(container);
                    return container;
                }
            });
            return new LegendControl();
        }

        return {
            layersByType: layersByType,
            overlayGroups: overlayGroups,
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
