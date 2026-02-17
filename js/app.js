/* ============================================
   MAP PLOTTING TOOL - MAIN APPLICATION
   ============================================ */

(function () {
    'use strict';

    // ---- State ----
    let map;
    let points = [];
    let markerLayers = {};   // pointId -> { marker, fans, label }
    let nextId = 1;
    let dropPointMode = false;
    let dropPointKeepActive = false;
    let dropPointToolbarButton = null;

    let settings = {
        w3wApiKey: '',
        showLabels: true,
        showMeasurements: true,
        showShapeLabels: true
    };

    // ---- Map Initialisation ----

    function initMap() {
        map = L.map('map', {
            center: [54.5, -2.5], // Centre of UK
            zoom: 6,
            zoomControl: true
        });

        // Base layers
        const osmStandard = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        });

        const osmTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap',
            maxZoom: 17
        });

        const esriSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '&copy; Esri, Maxar, Earthstar Geographics',
            maxZoom: 18
        });

        osmStandard.addTo(map);

        L.control.layers({
            'OpenStreetMap': osmStandard,
            'Topographic': osmTopo,
            'Satellite': esriSatellite
        }, null, { position: 'topright' }).addTo(map);
        initDropPointToolbarControl();

        // Click on map to place point or show coordinates (skip when drawing)
        map.on('click', function (e) {
            if (Drawings.isDrawingActive()) return;
            if (dropPointMode) {
                createPointAtLatLng(e.latlng.lat, e.latlng.lng);
                return;
            }
            const popup = L.popup()
                .setLatLng(e.latlng)
                .setContent(`<div class="popup-detail">${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}</div>`)
                .openOn(map);
        });
    }

    function initDropPointToolbarControl() {
        const DropPointControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const btn = L.DomUtil.create('a', 'leaflet-control-drop-point', container);
                btn.href = '#';
                btn.title = 'Drop Point Tool';
                btn.innerHTML = '&#128205;';

                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(btn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    L.DomEvent.preventDefault(e);
                        if (dropPointMode) {
                            setDropPointMode(false);
                            hideDropPointToolbarPanel();
                        } else {
                            openDropPointToolbarPanel();
                        }
                });

                dropPointToolbarButton = btn;
                return container;
            }
        });

        map.addControl(new DropPointControl());
    }

    // ---- Point Management ----

    function createPoint(data) {
        const resolvedIconType = normalizeIconType(data.iconType);
        const point = {
            id: nextId++,
            name: data.name || '',
            lat: data.lat,
            lng: data.lng,
            iconType: resolvedIconType,
            iconColor: getIconColor(resolvedIconType, data.iconColor),
            customSymbol: (data.customSymbol || '').trim().toUpperCase().slice(0, 2),
            notes: data.notes || '',
            originalInput: data.originalInput || ''
        };
        points.push(point);
        addMarkerToMap(point);
        refreshPointsList();
        return point;
    }

    function createPointAtLatLng(lat, lng) {
        const iconType = normalizeIconType(pointIconType.value);
        const defaultLabel = (ICON_DEFS[iconType] && ICON_DEFS[iconType].label) || 'Dropped Point';
        const name = pointName.value.trim() || defaultLabel;
        createPoint({
            name,
            lat,
            lng,
            iconType,
            iconColor: pointIconColor.value,
            customSymbol: pointCustomSymbol.value,
            notes: pointNotes.value.trim(),
            originalInput: `${lat.toFixed(6)}, ${lng.toFixed(6)}`
        });
        map.setView([lat, lng], Math.max(map.getZoom(), 14));

        // One-shot by default; optional multi-drop when keep active is enabled.
        if (!dropPointKeepActive) {
            setDropPointMode(false);
        }
    }

    function updatePoint(id, data) {
        const point = points.find(p => p.id === id);
        if (!point) return;

        if (data.iconType !== undefined) {
            data.iconType = normalizeIconType(data.iconType || point.iconType);
            data.iconColor = getIconColor(data.iconType, data.iconColor || point.iconColor);
        }
        if (data.customSymbol !== undefined) {
            data.customSymbol = (data.customSymbol || '').trim().toUpperCase().slice(0, 2);
        }

        Object.assign(point, data);
        removeMarkerFromMap(id);
        addMarkerToMap(point);
        refreshPointsList();
    }

    function deletePoint(id) {
        removeMarkerFromMap(id);
        points = points.filter(p => p.id !== id);
        refreshPointsList();
    }

    function clearAllPoints() {
        for (const id of Object.keys(markerLayers)) {
            removeMarkerFromMap(parseInt(id));
        }
        points = [];
        nextId = 1;
        refreshPointsList();
    }

    // ---- Markers ----

    const ICON_DEFS = {
        address: { label: 'Address / Reference', symbol: 'A', color: '#5b8def', colorEditable: true },
        primary_tola: { label: 'Primary TOLA', symbol: 'H', color: '#1e88e5', colorEditable: false },
        secondary_tola: { label: 'Secondary TOLA', symbol: 'H', color: '#f4c542', colorEditable: false },
        emergency_lz: { label: 'Emergency Landing Zone', symbol: '+', color: '#e05555', colorEditable: false },
        no_fly: { label: 'No-Fly Marker', symbol: 'X', color: '#d32f2f', colorEditable: false },
        hazard: { label: 'Hazard', symbol: '!', color: '#ff9800', colorEditable: false },
        custom_point: { label: 'Custom Point', symbol: '?', color: '#8e24aa', colorEditable: true }
    };

    const iconCache = {};

    function isValidIconType(iconType) {
        return Object.prototype.hasOwnProperty.call(ICON_DEFS, iconType);
    }

    function normalizeIconType(iconType) {
        if (isValidIconType(iconType)) return iconType;
        return 'address';
    }

    function parseIconTypeInput(rawValue) {
        const val = (rawValue || '').toString().trim().toLowerCase()
            .replace(/[\s-]+/g, '_')
            .replace(/[^\w]/g, '');
        if (!val) return normalizeIconType('');

        const aliases = {
            primary: 'primary_tola',
            primarytola: 'primary_tola',
            tola_primary: 'primary_tola',
            secondary: 'secondary_tola',
            secondarytola: 'secondary_tola',
            tola_secondary: 'secondary_tola',
            emergency: 'emergency_lz',
            emergencylandingzone: 'emergency_lz',
            emergency_landing_zone: 'emergency_lz',
            nofly: 'no_fly',
            no_fly_marker: 'no_fly',
            pilot: 'custom_point',
            pilot_position: 'custom_point',
            observer: 'custom_point',
            observer_position: 'custom_point',
            command: 'custom_point',
            command_post: 'custom_point',
            battery: 'custom_point',
            battery_swap: 'custom_point',
            custom: 'custom_point',
            custompoint: 'custom_point',
            user: 'custom_point'
        };

        const canonical = aliases[val] || val;
        return normalizeIconType(canonical);
    }

    function getDefaultIconColor(iconType) {
        const type = normalizeIconType(iconType, 'general');
        return ICON_DEFS[type].color;
    }

    function getIconColor(iconType, iconColor) {
        const type = normalizeIconType(iconType, 'general');
        const def = ICON_DEFS[type];
        if (def.colorEditable && iconColor && /^#[0-9a-fA-F]{6}$/.test(iconColor)) return iconColor;
        return def.color;
    }

    function getPointSymbol(point) {
        const type = normalizeIconType(point.iconType);
        if (type === 'custom_point') {
            const custom = (point.customSymbol || '').trim().toUpperCase();
            return custom ? custom.slice(0, 2) : ICON_DEFS.custom_point.symbol;
        }
        return ICON_DEFS[type].symbol;
    }

    function getContrastingTextColor(hexColor) {
        const hex = (hexColor || '#000000').replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16) || 0;
        const g = parseInt(hex.substring(2, 4), 16) || 0;
        const b = parseInt(hex.substring(4, 6), 16) || 0;
        const yiq = (r * 299 + g * 587 + b * 114) / 1000;
        return yiq >= 150 ? '#111111' : '#ffffff';
    }

    function markerSvg(symbol, color) {
        const safeSymbol = escapeHtml(symbol || '?');
        return encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
            <path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0z" fill="${color}" stroke="#1f2937" stroke-width="1"/>
            <circle cx="12.5" cy="12.5" r="7.2" fill="#ffffff" opacity="0.95"/>
            <text x="12.5" y="16.1" text-anchor="middle" font-size="9.2" font-family="Arial, sans-serif" font-weight="700" fill="#111827">${safeSymbol}</text>
        </svg>`);
    }

    function initIconLegend() {
        const legend = document.getElementById('iconLegend');
        const body = document.getElementById('iconLegendBody');
        const toggle = document.getElementById('iconLegendToggle');
        if (!legend || !body || !toggle) return;

        const entries = [
            'address',
            'primary_tola',
            'secondary_tola',
            'emergency_lz',
            'no_fly',
            'hazard',
            'custom_point'
        ];

        body.innerHTML = entries.map((key) => {
            const def = ICON_DEFS[key];
            const color = def.color;
            const txt = getContrastingTextColor(color);
            return `
                <div class="legend-item">
                    <span class="legend-badge" style="background:${color}; color:${txt};">${escapeHtml(def.symbol)}</span>
                    <span class="legend-label">${escapeHtml(def.label)}</span>
                </div>
            `;
        }).join('');

        toggle.addEventListener('click', () => {
            legend.classList.toggle('collapsed');
            toggle.innerHTML = legend.classList.contains('collapsed') ? '&plus;' : '&minus;';
        });
    }

    function getPointIcon(point) {
        const iconType = normalizeIconType(point.iconType);
        const color = getIconColor(iconType, point.iconColor);
        const symbol = getPointSymbol(point);
        const key = `${iconType}|${color}|${symbol}`;
        if (iconCache[key]) return iconCache[key];

        const icon = L.icon({
            iconUrl: `data:image/svg+xml,${markerSvg(symbol, color)}`,
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
            shadowSize: [41, 41]
        });
        iconCache[key] = icon;
        return icon;
    }

    function buildPointPopupHtml(point) {
        let popupHtml = `<div class="popup-title">${escapeHtml(point.name || 'Unnamed')}</div>`;
        popupHtml += `<div class="popup-detail">${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}</div>`;
        const iconType = normalizeIconType(point.iconType);
        popupHtml += `<div class="popup-detail">Icon: ${escapeHtml(ICON_DEFS[iconType].label)}</div>`;
        if (iconType === 'custom_point') {
            popupHtml += `<div class="popup-detail">Symbol: ${escapeHtml(getPointSymbol(point))}</div>`;
        }
        if (point.notes) {
            popupHtml += `<div class="popup-detail">${escapeHtml(point.notes)}</div>`;
        }
        popupHtml += `<div class="popup-actions"><a href="#" class="popup-edit-link" data-point-id="${point.id}">Edit Point</a></div>`;
        return popupHtml;
    }

    function bindPointPopup(marker, point) {
        marker.unbindPopup();
        const popup = L.popup().setContent(buildPointPopupHtml(point));
        marker.bindPopup(popup);

        marker.off('popupopen');
        marker.on('popupopen', () => {
            const editLink = document.querySelector(`.popup-edit-link[data-point-id="${point.id}"]`);
            if (editLink) {
                editLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    marker.closePopup();
                    openEditModal(point.id);
                });
            }
        });
    }

    function addMarkerToMap(point) {
        const icon = getPointIcon(point);
        const marker = L.marker([point.lat, point.lng], { icon, draggable: true }).addTo(map);
        bindPointPopup(marker, point);

        // Tooltip/label
        let label = null;
        if (settings.showLabels && point.name) {
            label = L.tooltip({
                permanent: true,
                direction: 'top',
                offset: [0, -35],
                className: 'point-label-tooltip'
            }).setContent(point.name);
            marker.bindTooltip(label);
        }

        let fans = null;

        marker.on('click', () => {
            highlightPoint(point.id);
        });

        marker.on('dragstart', () => {
            marker.closePopup();
        });
        marker.on('dragend', () => {
            const pos = marker.getLatLng();
            point.lat = pos.lat;
            point.lng = pos.lng;

            const layers = markerLayers[point.id];
            if (layers && layers.fans) {
                map.removeLayer(layers.fans);
                layers.fans = null;
            }
            bindPointPopup(marker, point);
            refreshPointsList();
        });

        markerLayers[point.id] = { marker, fans, label };
    }

    function removeMarkerFromMap(id) {
        const layers = markerLayers[id];
        if (!layers) return;

        map.removeLayer(layers.marker);
        if (layers.fans) map.removeLayer(layers.fans);
        delete markerLayers[id];
    }

    function panToPoint(id) {
        const point = points.find(p => p.id === id);
        if (!point) return;
        map.setView([point.lat, point.lng], Math.max(map.getZoom(), 14));
        const layers = markerLayers[id];
        if (layers) layers.marker.openPopup();
    }

    function fitAllPoints() {
        if (points.length === 0) return;
        const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [40, 40] });
    }

    // ---- Points List UI ----

    const pointsList = document.getElementById('pointsList');
    const pointCount = document.getElementById('pointCount');
    const pointSearch = document.getElementById('pointSearch');

    function refreshPointsList() {
        const searchTerm = pointSearch.value.toLowerCase();
        const filtered = points.filter(p => {
            if (!searchTerm) return true;
            return (p.name || '').toLowerCase().includes(searchTerm) ||
                   (p.notes || '').toLowerCase().includes(searchTerm) ||
                   `${p.lat}, ${p.lng}`.includes(searchTerm);
        });

        pointCount.textContent = `(${points.length})`;

        pointsList.innerHTML = '';
        for (const p of filtered) {
            const li = document.createElement('li');
            li.className = 'point-item';
            li.dataset.id = p.id;
            const iconType = normalizeIconType(p.iconType);
            const iconDef = ICON_DEFS[iconType];
            const badgeColor = getIconColor(iconType, p.iconColor);
            const badgeTextColor = getContrastingTextColor(badgeColor);
            const badgeSymbol = getPointSymbol(p);

            li.innerHTML = `
                <div class="point-marker-icon icon-badge" style="background:${badgeColor}; color:${badgeTextColor};">${escapeHtml(badgeSymbol)}</div>
                <div class="point-item-info">
                    <div class="point-item-name">${escapeHtml(p.name || 'Unnamed')}</div>
                    <div class="point-item-detail">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} | ${escapeHtml(iconDef.label)}</div>
                </div>
                <div class="point-item-actions">
                    <button class="btn-icon btn-edit" title="Edit">&#9998;</button>
                    <button class="btn-icon btn-delete" title="Delete">&times;</button>
                </div>
            `;

            li.addEventListener('click', (e) => {
                if (e.target.closest('.btn-edit')) {
                    openEditModal(p.id);
                } else if (e.target.closest('.btn-delete')) {
                    if (confirm(`Delete "${p.name || 'Unnamed'}"?`)) {
                        deletePoint(p.id);
                    }
                } else {
                    panToPoint(p.id);
                    highlightPoint(p.id);
                }
            });

            pointsList.appendChild(li);
        }
    }

    function highlightPoint(id) {
        document.querySelectorAll('.point-item').forEach(el => el.classList.remove('active'));
        const el = document.querySelector(`.point-item[data-id="${id}"]`);
        if (el) {
            el.classList.add('active');
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    pointSearch.addEventListener('input', refreshPointsList);

    // ---- Add Point Form ----

    const addPointForm = document.getElementById('addPointForm');
    const pointInput = document.getElementById('pointInput');
    const pointName = document.getElementById('pointName');
    const pointIconType = document.getElementById('pointIconType');
    const pointIconColor = document.getElementById('pointIconColor');
    const pointIconColorGroup = document.getElementById('pointIconColorGroup');
    const pointCustomSymbol = document.getElementById('pointCustomSymbol');
    const pointCustomSymbolGroup = document.getElementById('pointCustomSymbolGroup');
    const pointNotes = document.getElementById('pointNotes');
    const formatHint = document.getElementById('formatHint');
    const dropPointModeBtn = document.getElementById('dropPointModeBtn');
    const dropPointToolbarPanel = document.getElementById('dropPointToolbarPanel');
    const dropPointToolbarIconType = document.getElementById('dropPointToolbarIconType');
    const dropPointToolbarIconColor = document.getElementById('dropPointToolbarIconColor');
    const dropPointToolbarSymbol = document.getElementById('dropPointToolbarSymbol');
    const dropPointToolbarColorGroup = document.getElementById('dropPointToolbarColorGroup');
    const dropPointToolbarSymbolGroup = document.getElementById('dropPointToolbarSymbolGroup');
    const dropPointKeepActiveInput = document.getElementById('dropPointKeepActive');
    const dropPointToolbarStart = document.getElementById('dropPointToolbarStart');
    const dropPointToolbarCancel = document.getElementById('dropPointToolbarCancel');

    function refreshPointIconControls() {
        const iconType = normalizeIconType(pointIconType.value);
        const iconDef = ICON_DEFS[iconType];
        pointIconColorGroup.classList.toggle('hidden', !iconDef.colorEditable);
        pointCustomSymbolGroup.classList.toggle('hidden', iconType !== 'custom_point');
    }

    function refreshDropPointModeButton() {
        if (!dropPointModeBtn) return;
        dropPointModeBtn.textContent = dropPointMode ? 'Drop Point Mode: On' : 'Drop Point Mode: Off';
        dropPointModeBtn.classList.toggle('btn-toggle-active', dropPointMode);
        if (dropPointToolbarButton) {
            dropPointToolbarButton.classList.toggle('active', dropPointMode);
        }
        const mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.classList.toggle('drop-point-cursor', dropPointMode);
        }
    }

    function setDropPointMode(enabled) {
        dropPointMode = !!enabled;
        refreshDropPointModeButton();
    }

    function refreshDropPointToolbarControls() {
        const iconType = normalizeIconType(dropPointToolbarIconType.value);
        const iconDef = ICON_DEFS[iconType];
        dropPointToolbarColorGroup.classList.toggle('hidden', !iconDef.colorEditable);
        dropPointToolbarSymbolGroup.classList.toggle('hidden', iconType !== 'custom_point');
    }

    function copyFormSelectionsToDropToolbar() {
        dropPointToolbarIconType.value = pointIconType.value;
        dropPointToolbarIconColor.value = pointIconColor.value;
        dropPointToolbarSymbol.value = pointCustomSymbol.value || '';
        dropPointKeepActiveInput.checked = dropPointKeepActive;
        refreshDropPointToolbarControls();
    }

    function applyDropToolbarToForm() {
        pointIconType.value = dropPointToolbarIconType.value;
        pointIconColor.value = dropPointToolbarIconColor.value;
        pointCustomSymbol.value = dropPointToolbarSymbol.value;
        refreshPointIconControls();
    }

    function openDropPointToolbarPanel() {
        copyFormSelectionsToDropToolbar();
        dropPointToolbarPanel.classList.remove('hidden');
    }

    function hideDropPointToolbarPanel() {
        dropPointToolbarPanel.classList.add('hidden');
    }

    function populateDropToolbarSelectors() {
        dropPointToolbarIconType.innerHTML = pointIconType.innerHTML;
    }

    pointIconType.addEventListener('change', () => {
        refreshPointIconControls();
    });
    pointIconType.value = 'address';
    pointIconColor.value = '#5b8def';
    pointCustomSymbol.value = '';
    populateDropToolbarSelectors();
    refreshPointIconControls();
    refreshDropPointModeButton();

    dropPointModeBtn.addEventListener('click', () => {
        setDropPointMode(!dropPointMode);
    });

    dropPointToolbarIconType.addEventListener('change', refreshDropPointToolbarControls);

    dropPointToolbarStart.addEventListener('click', () => {
        applyDropToolbarToForm();
        dropPointKeepActive = !!dropPointKeepActiveInput.checked;
        setDropPointMode(true);
        hideDropPointToolbarPanel();
    });
    dropPointToolbarCancel.addEventListener('click', hideDropPointToolbarPanel);

    // Format hint on input
    pointInput.addEventListener('input', () => {
        const val = pointInput.value.trim();
        if (!val) {
            formatHint.textContent = '';
            return;
        }
        const fmt = Converters.detectFormat(val);
        formatHint.textContent = fmt ? `Detected: ${Converters.formatLabel(fmt)}` : '';
    });

    // Submit
    addPointForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const inputVal = pointInput.value.trim();
        if (!inputVal) return;

        const addBtn = document.getElementById('addPointBtn');
        addBtn.disabled = true;
        addBtn.textContent = 'Resolving...';

        try {
            const coords = await Converters.resolve(inputVal, settings.w3wApiKey);
            if (!coords) {
                alert('Could not resolve location. Please check the format and try again.');
                return;
            }

            createPoint({
                name: pointName.value.trim(),
                lat: coords.lat,
                lng: coords.lng,
                iconType: pointIconType.value,
                iconColor: pointIconColor.value,
                customSymbol: pointCustomSymbol.value,
                notes: pointNotes.value.trim(),
                originalInput: inputVal
            });

            // Pan to new point
            map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 14));

            // Reset form
            pointInput.value = '';
            pointName.value = '';
            pointNotes.value = '';
            pointIconType.value = 'address';
            pointIconColor.value = '#5b8def';
            pointCustomSymbol.value = '';
            refreshPointIconControls();
            formatHint.textContent = '';
        } catch (err) {
            alert('Error resolving location: ' + err.message);
        } finally {
            addBtn.disabled = false;
            addBtn.textContent = 'Add Point';
        }
    });

    // ---- Sidebar Toggle ----

    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarOpen = document.getElementById('sidebarOpen');

    sidebarToggle.addEventListener('click', () => {
        document.body.classList.add('sidebar-collapsed');
        sidebarOpen.classList.remove('hidden');
        setTimeout(() => map.invalidateSize(), 300);
    });

    sidebarOpen.addEventListener('click', () => {
        document.body.classList.remove('sidebar-collapsed');
        sidebarOpen.classList.add('hidden');
        setTimeout(() => map.invalidateSize(), 300);
    });

    // Start with sidebar collapsed for more map space.
    document.body.classList.add('sidebar-collapsed');
    sidebarOpen.classList.remove('hidden');
    setTimeout(() => map.invalidateSize(), 50);

    // ---- Clear All / Fit All ----

    document.getElementById('clearAllBtn').addEventListener('click', () => {
        if (points.length === 0) return;
        if (confirm(`Clear all ${points.length} points?`)) {
            clearAllPoints();
        }
    });

    document.getElementById('fitAllBtn').addEventListener('click', fitAllPoints);

    // ---- Modal Helpers ----

    function openModal(id) {
        document.getElementById(id).classList.remove('hidden');
    }

    function closeModal(id) {
        document.getElementById(id).classList.add('hidden');
    }

    // Close modals with X, Cancel, or backdrop
    document.querySelectorAll('.modal-close, .modal-cancel').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('.modal').classList.add('hidden');
        });
    });

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            backdrop.closest('.modal').classList.add('hidden');
        });
    });

    // ---- Edit Point Modal ----

    const editModal = document.getElementById('editModal');

    function openEditModal(id) {
        const point = points.find(p => p.id === id);
        if (!point) return;

        document.getElementById('editPointId').value = id;
        document.getElementById('editPointName').value = point.name || '';
        document.getElementById('editCoordDisplay').textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
        const editIconType = normalizeIconType(point.iconType);
        document.getElementById('editPointIconType').value = editIconType;
        document.getElementById('editPointIconColor').value = getIconColor(editIconType, point.iconColor);
        document.getElementById('editPointCustomSymbol').value = (point.customSymbol || '').slice(0, 2);
        document.getElementById('editPointNotes').value = point.notes || '';
        refreshEditPointIconControls();

        openModal('editModal');
    }

    function refreshEditPointIconControls() {
        const iconSel = document.getElementById('editPointIconType');
        const iconType = normalizeIconType(iconSel.value);
        const iconDef = ICON_DEFS[iconType];
        document.getElementById('editPointIconColorGroup').classList.toggle('hidden', !iconDef.colorEditable);
        document.getElementById('editPointCustomSymbolGroup').classList.toggle('hidden', iconType !== 'custom_point');
    }

    document.getElementById('editPointIconType').addEventListener('change', function () {
        refreshEditPointIconControls();
    });

    document.getElementById('editSaveBtn').addEventListener('click', () => {
        const id = parseInt(document.getElementById('editPointId').value);

        updatePoint(id, {
            name: document.getElementById('editPointName').value.trim(),
            iconType: document.getElementById('editPointIconType').value,
            iconColor: document.getElementById('editPointIconColor').value,
            customSymbol: document.getElementById('editPointCustomSymbol').value,
            notes: document.getElementById('editPointNotes').value.trim()
        });

        closeModal('editModal');
    });

    document.getElementById('editDeleteBtn').addEventListener('click', () => {
        const id = parseInt(document.getElementById('editPointId').value);
        const point = points.find(p => p.id === id);
        if (confirm(`Delete "${point ? point.name || 'Unnamed' : ''}"?`)) {
            deletePoint(id);
            closeModal('editModal');
        }
    });

    // ---- Bulk Import ----

    let bulkParsedData = null;
    let bulkParsedHeaders = null;

    document.getElementById('bulkImportBtn').addEventListener('click', () => {
        resetBulkModal();
        openModal('bulkModal');
    });

    // Tabs
    document.querySelectorAll('#bulkModal .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#bulkModal .tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#bulkModal .tab-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            document.getElementById('columnMapping').classList.add('hidden');
            setBulkStatus('');
        });
    });

    function resetBulkModal() {
        bulkParsedData = null;
        bulkParsedHeaders = null;
        document.getElementById('csvFileInput').value = '';
        document.getElementById('pasteDataInput').value = '';
        document.getElementById('listInput').value = '';
        document.getElementById('csvPreview').classList.add('hidden');
        document.getElementById('pastePreview').classList.add('hidden');
        document.getElementById('columnMapping').classList.add('hidden');
        setBulkStatus('');
    }

    function setBulkStatus(message, type) {
        const el = document.getElementById('bulkStatus');
        if (!message) {
            el.classList.add('hidden');
            return;
        }
        el.classList.remove('hidden');
        el.className = `bulk-status ${type || 'info'}`;
        el.textContent = message;
    }

    // CSV file parsing
    document.getElementById('csvFileInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            const text = ev.target.result;
            parseTabularData(text, 'csvPreview');
        };
        reader.readAsText(file);
    });

    // Paste data parsing
    document.getElementById('parsePasteBtn').addEventListener('click', () => {
        const text = document.getElementById('pasteDataInput').value.trim();
        if (!text) return;
        parseTabularData(text, 'pastePreview');
    });

    function parseTabularData(text, previewId) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length === 0) return;

        // Detect delimiter
        const firstLine = lines[0];
        const tabCount = (firstLine.match(/\t/g) || []).length;
        const commaCount = (firstLine.match(/,/g) || []).length;
        const delimiter = tabCount >= commaCount ? '\t' : ',';

        // Parse rows (simple CSV - handles basic quoting)
        const rows = lines.map(line => parseCsvLine(line, delimiter));
        bulkParsedHeaders = rows[0];
        bulkParsedData = rows;

        // Show preview
        showDataPreview(previewId, rows.slice(0, 6));

        // Populate column mapping
        populateColumnMapping(bulkParsedHeaders);
        document.getElementById('columnMapping').classList.remove('hidden');
    }

    function parseCsvLine(line, delimiter) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"' && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else if (ch === '"') {
                    inQuotes = false;
                } else {
                    current += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === delimiter) {
                    result.push(current.trim());
                    current = '';
                } else {
                    current += ch;
                }
            }
        }
        result.push(current.trim());
        return result;
    }

    function showDataPreview(containerId, rows) {
        const container = document.getElementById(containerId);
        container.classList.remove('hidden');

        let html = '<table><thead><tr>';
        rows[0].forEach(h => {
            html += `<th>${escapeHtml(h)}</th>`;
        });
        html += '</tr></thead><tbody>';
        rows.slice(1).forEach(row => {
            html += '<tr>';
            row.forEach(cell => {
                html += `<td>${escapeHtml(cell)}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';

        container.innerHTML = html;
    }

    function populateColumnMapping(headers) {
        const selects = ['mapLat', 'mapLng', 'mapLocation', 'mapName', 'mapNotes', 'mapIconType', 'mapIconColor', 'mapIconSymbol'];
        for (const selectId of selects) {
            const sel = document.getElementById(selectId);
            sel.innerHTML = '<option value="">-- None --</option>';
            headers.forEach((h, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = h;
                sel.appendChild(opt);
            });
        }

        // Auto-detect columns from headers
        autoMapColumns(headers);
    }

    function autoMapColumns(headers) {
        const lower = headers.map(h => h.toLowerCase().trim());

        const mappings = {
            'mapLat': ['lat', 'latitude', 'northing', 'y'],
            'mapLng': ['lng', 'lon', 'long', 'longitude', 'easting', 'x'],
            'mapLocation': ['location', 'postcode', 'address', 'gridref', 'grid_ref', 'coord', 'coordinates'],
            'mapName': ['name', 'label', 'title', 'site', 'site_name', 'sitename'],
            'mapNotes': ['notes', 'note', 'description', 'comment', 'comments'],
            'mapIconType': ['icon', 'icon_type', 'icontype', 'marker', 'marker_type'],
            'mapIconColor': ['icon_color', 'iconcolor', 'color', 'marker_color', 'markercolor'],
            'mapIconSymbol': ['icon_symbol', 'iconsymbol', 'symbol', 'marker_symbol', 'markersymbol']
        };

        for (const [selectId, keywords] of Object.entries(mappings)) {
            for (const kw of keywords) {
                const idx = lower.indexOf(kw);
                if (idx !== -1) {
                    document.getElementById(selectId).value = idx;
                    break;
                }
            }
        }
    }

    // Execute bulk import
    document.getElementById('bulkImportExecute').addEventListener('click', async () => {
        const activeTab = document.querySelector('#bulkModal .tab.active').dataset.tab;

        if (activeTab === 'list') {
            await importFromList();
        } else {
            await importFromTabular();
        }
    });

    async function importFromList() {
        const text = document.getElementById('listInput').value.trim();
        if (!text) {
            setBulkStatus('Please enter some locations.', 'error');
            return;
        }

        const lines = text.split(/\r?\n/).filter(l => l.trim());
        showLoading(`Importing ${lines.length} locations...`);

        let imported = 0;
        let failed = 0;

        // Separate postcodes for bulk lookup
        const postcodeLines = [];
        const otherLines = [];

        for (const line of lines) {
            const fmt = Converters.detectFormat(line.trim());
            if (fmt === 'postcode') {
                postcodeLines.push(line.trim());
            } else {
                otherLines.push(line.trim());
            }
        }

        // Bulk postcode lookup
        if (postcodeLines.length > 0) {
            const results = await Converters.lookupPostcodesBulk(postcodeLines);
            for (const pc of postcodeLines) {
                const key = pc.toUpperCase().replace(/\s+/g, '');
                if (results[key]) {
                    createPoint({
                        name: pc.toUpperCase(),
                        lat: results[key].lat,
                        lng: results[key].lng,
                        originalInput: pc
                    });
                    imported++;
                } else {
                    failed++;
                }
            }
        }

        // Resolve other formats
        for (const line of otherLines) {
            try {
                const coords = await Converters.resolve(line, settings.w3wApiKey);
                if (coords) {
                    createPoint({
                        name: line,
                        lat: coords.lat,
                        lng: coords.lng,
                        originalInput: line
                    });
                    imported++;
                } else {
                    failed++;
                }
            } catch {
                failed++;
            }
        }

        hideLoading();

        if (imported > 0) fitAllPoints();

        let msg = `Imported ${imported} point${imported !== 1 ? 's' : ''}.`;
        if (failed > 0) msg += ` ${failed} failed.`;
        setBulkStatus(msg, failed > 0 ? 'warning' : 'success');
    }

    async function importFromTabular() {
        if (!bulkParsedData || bulkParsedData.length < 2) {
            setBulkStatus('No data to import. Parse data first.', 'error');
            return;
        }

        const hasHeader = document.getElementById('hasHeaderRow').checked;
        const startRow = hasHeader ? 1 : 0;
        const rows = bulkParsedData.slice(startRow);

        const colLat = getColIndex('mapLat');
        const colLng = getColIndex('mapLng');
        const colLocation = getColIndex('mapLocation');
        const colName = getColIndex('mapName');
        const colNotes = getColIndex('mapNotes');
        const colIconType = getColIndex('mapIconType');
        const colIconColor = getColIndex('mapIconColor');
        const colIconSymbol = getColIndex('mapIconSymbol');

        if (colLat === -1 && colLng === -1 && colLocation === -1) {
            setBulkStatus('Please map at least Lat/Lng columns OR a Location column.', 'error');
            return;
        }

        showLoading(`Importing ${rows.length} rows...`);

        let imported = 0;
        let failed = 0;

        // Collect postcodes for bulk lookup
        const postcodeRows = [];
        const otherRows = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (colLat !== -1 && colLng !== -1) {
                otherRows.push({ row, index: i });
            } else if (colLocation !== -1) {
                const loc = (row[colLocation] || '').trim();
                const fmt = Converters.detectFormat(loc);
                if (fmt === 'postcode') {
                    postcodeRows.push({ row, index: i, postcode: loc });
                } else {
                    otherRows.push({ row, index: i });
                }
            }
        }

        // Bulk postcode resolve
        if (postcodeRows.length > 0) {
            const postcodes = postcodeRows.map(r => r.postcode);
            const results = await Converters.lookupPostcodesBulk(postcodes);

            for (const pr of postcodeRows) {
                const key = pr.postcode.toUpperCase().replace(/\s+/g, '');
                if (results[key]) {
                    const row = pr.row;

                    createPoint({
                        name: colName !== -1 ? (row[colName] || '') : pr.postcode,
                        lat: results[key].lat,
                        lng: results[key].lng,
                        iconType: colIconType !== -1 ? parseIconTypeInput(row[colIconType]) : '',
                        iconColor: colIconColor !== -1 ? (row[colIconColor] || '').trim() : '',
                        customSymbol: colIconSymbol !== -1 ? (row[colIconSymbol] || '').trim() : '',
                        notes: colNotes !== -1 ? (row[colNotes] || '') : '',
                        originalInput: pr.postcode
                    });
                    imported++;
                } else {
                    failed++;
                }
            }
        }

        // Resolve other rows
        for (const item of otherRows) {
            const row = item.row;
            try {
                let coords = null;

                if (colLat !== -1 && colLng !== -1) {
                    const lat = parseFloat(row[colLat]);
                    const lng = parseFloat(row[colLng]);
                    if (!isNaN(lat) && !isNaN(lng)) {
                        coords = { lat, lng };
                    }
                }

                if (!coords && colLocation !== -1) {
                    const loc = (row[colLocation] || '').trim();
                    if (loc) {
                        coords = await Converters.resolve(loc, settings.w3wApiKey);
                    }
                }

                if (coords) {
                    createPoint({
                        name: colName !== -1 ? (row[colName] || '') : '',
                        lat: coords.lat,
                        lng: coords.lng,
                        iconType: colIconType !== -1 ? parseIconTypeInput(row[colIconType]) : '',
                        iconColor: colIconColor !== -1 ? (row[colIconColor] || '').trim() : '',
                        customSymbol: colIconSymbol !== -1 ? (row[colIconSymbol] || '').trim() : '',
                        notes: colNotes !== -1 ? (row[colNotes] || '') : '',
                        originalInput: colLocation !== -1 ? (row[colLocation] || '') : ''
                    });
                    imported++;
                } else {
                    failed++;
                }
            } catch {
                failed++;
            }
        }

        hideLoading();

        if (imported > 0) fitAllPoints();

        let msg = `Imported ${imported} point${imported !== 1 ? 's' : ''}.`;
        if (failed > 0) msg += ` ${failed} failed.`;
        setBulkStatus(msg, failed > 0 ? 'error' : 'success');
    }

    function getColIndex(selectId) {
        const val = document.getElementById(selectId).value;
        return val === '' ? -1 : parseInt(val);
    }

    // ---- Export ----

    document.getElementById('exportBtn').addEventListener('click', () => {
        openModal('exportModal');
    });

    document.getElementById('exportCSV').addEventListener('click', () => {
        if (points.length === 0) {
            alert('No points to export.');
            return;
        }
        Exporters.exportCSV(points);
        closeModal('exportModal');
    });

    document.getElementById('exportKML').addEventListener('click', () => {
        const shapesData = Drawings.serializeShapes();
        if (points.length === 0 && shapesData.length === 0) {
            alert('No points or shapes to export.');
            return;
        }
        Exporters.exportKML(points, shapesData);
        closeModal('exportModal');
    });

    document.getElementById('exportScreenshot').addEventListener('click', async () => {
        closeModal('exportModal');
        showLoading('Capturing screenshot...');
        try {
            await Exporters.exportScreenshot(document.getElementById('map'));
        } finally {
            hideLoading();
        }
    });

    // ---- Save / Load Project ----

    document.getElementById('saveProjectBtn').addEventListener('click', () => {
        ProjectIO.saveProject(points, settings, Drawings.serializeShapes());
    });

    document.getElementById('loadProjectBtn').addEventListener('click', () => {
        document.getElementById('projectFileInput').click();
    });

    document.getElementById('projectFileInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        showLoading('Loading project...');
        try {
            const project = await ProjectIO.loadProject(file);

            // Apply settings
            if (project.settings) {
                Object.assign(settings, project.settings);
                applySettings();
            }

            // Clear existing and load points
            clearAllPoints();
            Drawings.clearAllShapes();

            for (const p of project.points) {
                const point = {
                    id: nextId++,
                    name: p.name || '',
                    lat: p.lat,
                    lng: p.lng,
                    iconType: normalizeIconType(p.iconType),
                    iconColor: getIconColor(normalizeIconType(p.iconType), p.iconColor),
                    customSymbol: (p.customSymbol || '').trim().toUpperCase().slice(0, 2),
                    notes: p.notes || '',
                    originalInput: p.originalInput || ''
                };
                points.push(point);
                addMarkerToMap(point);
            }
            refreshPointsList();

            // Restore shapes
            if (project.shapes) {
                Drawings.loadShapes(project.shapes);
            }

            if (points.length > 0) fitAllPoints();

            setBulkStatus(`Loaded ${points.length} points.`, 'success');
        } catch (err) {
            alert('Failed to load project: ' + err.message);
        } finally {
            hideLoading();
            e.target.value = ''; // Reset file input
        }
    });

    // ---- Settings ----

    document.getElementById('settingsBtn').addEventListener('click', () => {
        // Populate from current settings
        document.getElementById('w3wApiKey').value = settings.w3wApiKey;
        document.getElementById('showLabels').checked = settings.showLabels;
        document.getElementById('showMeasurements').checked = settings.showMeasurements;
        document.getElementById('showShapeLabels').checked = settings.showShapeLabels;
        openModal('settingsModal');
    });

    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
        settings.w3wApiKey = document.getElementById('w3wApiKey').value.trim();
        settings.showLabels = document.getElementById('showLabels').checked;
        settings.showMeasurements = document.getElementById('showMeasurements').checked;
        settings.showShapeLabels = document.getElementById('showShapeLabels').checked;
        applySettings();
        closeModal('settingsModal');
    });

    function applySettings() {
        // Refresh labels on all markers
        for (const point of points) {
            const layers = markerLayers[point.id];
            if (!layers) continue;

            if (settings.showLabels && point.name) {
                if (!layers.marker.getTooltip()) {
                    layers.marker.bindTooltip(point.name, {
                        permanent: true,
                        direction: 'top',
                        offset: [0, -35],
                        className: 'point-label-tooltip'
                    });
                }
            } else {
                layers.marker.unbindTooltip();
            }
        }

        // Toggle shape measurements
        Drawings.toggleMeasurements(settings.showMeasurements);
        Drawings.toggleShapeLabels(settings.showShapeLabels);
    }

    // ---- Loading Overlay ----

    function showLoading(text) {
        document.getElementById('loadingText').textContent = text || 'Loading...';
        document.getElementById('loadingOverlay').classList.remove('hidden');
    }

    function hideLoading() {
        document.getElementById('loadingOverlay').classList.add('hidden');
    }

    // ---- Utility ----

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- Keyboard Shortcuts ----

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (dropPointMode) {
                dropPointMode = false;
                refreshDropPointModeButton();
                return;
            }
            document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
        }
    });

    // ---- Drawings Integration ----

    // Init drawings after map is ready
    function initDrawings() {
        Drawings.init(map);

        // Shape edit modal buttons
        document.getElementById('shapeEditSaveBtn').addEventListener('click', () => {
            Drawings.saveShapeEdit();
        });

        document.getElementById('shapeEditDeleteBtn').addEventListener('click', () => {
            Drawings.deleteShapeFromModal();
        });

        // Shape edit modal opacity slider live update
        document.getElementById('editShapeFillOpacity').addEventListener('input', (e) => {
            document.getElementById('editShapeFillOpacityVal').textContent = e.target.value;
        });

        // Close shape edit modal
        document.querySelectorAll('#shapeEditModal .modal-close, #shapeEditModal .modal-cancel').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('shapeEditModal').classList.add('hidden');
            });
        });
        document.querySelector('#shapeEditModal .modal-backdrop').addEventListener('click', () => {
            document.getElementById('shapeEditModal').classList.add('hidden');
        });

        // Clear shapes button
        document.getElementById('clearShapesBtn').addEventListener('click', () => {
            const count = Drawings.getShapes().length;
            if (count === 0) return;
            if (confirm(`Clear all ${count} shapes?`)) {
                Drawings.clearAllShapes();
            }
        });
    }

    // ---- Initialise ----

    initMap();
    initIconLegend();
    initDrawings();

})();
