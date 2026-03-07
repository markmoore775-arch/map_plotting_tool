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
    let dropPointPickerOpen = false;
    let lastDropIconType = 'address';
    let lastDropIconColor = '#dc2626';
    let dropPointToolbarButton = null;
    let dropPointIconStrip = null;
    let handToolbarButton = null;
    let quickEditUpdating = false;

    const SETTINGS_STORAGE_KEY = 'airplot_settings';

    let settings = {
        w3wApiKey: '',
        osMapsApiKey: '',
        bgaAirspaceUsername: '',
        bgaAirspacePassword: '',
        showLabels: true,
        showMeasurements: true,
        showShapeLabels: true,
        showFlightPathDistance: false
    };

    function loadSettingsFromStorage() {
        try {
            const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed.w3wApiKey !== undefined) settings.w3wApiKey = parsed.w3wApiKey;
                if (parsed.osMapsApiKey !== undefined) settings.osMapsApiKey = parsed.osMapsApiKey;
                if (parsed.bgaAirspaceUsername !== undefined) settings.bgaAirspaceUsername = parsed.bgaAirspaceUsername;
                if (parsed.bgaAirspacePassword !== undefined) settings.bgaAirspacePassword = parsed.bgaAirspacePassword;
                if (parsed.showLabels !== undefined) settings.showLabels = parsed.showLabels;
                if (parsed.showMeasurements !== undefined) settings.showMeasurements = parsed.showMeasurements;
                if (parsed.showShapeLabels !== undefined) settings.showShapeLabels = parsed.showShapeLabels;
                if (parsed.showFlightPathDistance !== undefined) settings.showFlightPathDistance = parsed.showFlightPathDistance;
            }
        } catch (_) { /* ignore */ }
    }

    // Load persisted settings on startup
    loadSettingsFromStorage();

    function getW3WApiKey() {
        return settings.w3wApiKey
            || (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.w3wApiKey)
            || '';
    }

    function saveSettingsToStorage() {
        try {
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                w3wApiKey: settings.w3wApiKey,
                osMapsApiKey: settings.osMapsApiKey,
                bgaAirspaceUsername: settings.bgaAirspaceUsername,
                bgaAirspacePassword: settings.bgaAirspacePassword,
                showLabels: settings.showLabels,
                showMeasurements: settings.showMeasurements,
                showShapeLabels: settings.showShapeLabels,
                showFlightPathDistance: settings.showFlightPathDistance
            }));
        } catch (_) { /* ignore */ }
    }

    // ---- Map Initialisation ----

    let layerControl = null;
    let osMapsLayers = {}; // name -> layer, for add/remove when key changes

    function createOsMapsLayer(style, key) {
        return L.tileLayer(
            `https://api.os.uk/maps/raster/v1/zxy/${style}_3857/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`,
            {
                attribution: '&copy; <a href="https://www.ordnancesurvey.co.uk/">Ordnance Survey</a>',
                maxZoom: 20,
                minZoom: 7
            }
        );
    }

    function createMapboxLayer(styleId, token) {
        return L.tileLayer(
            'https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}',
            {
                attribution: '© <a href="https://www.mapbox.com/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                maxZoom: 22,
                id: styleId,
                accessToken: token
            }
        );
    }

    function updateOsMapsLayers() {
        const key = (settings.osMapsApiKey || (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.osMapsApiKey) || '').trim();
        const hasKey = key.length > 0;

        if (hasKey && Object.keys(osMapsLayers).length === 0) {
            // Add OS Maps layers
            osMapsLayers['OS Outdoor'] = createOsMapsLayer('Outdoor', key);
            osMapsLayers['OS Road'] = createOsMapsLayer('Road', key);
            osMapsLayers['OS Light'] = createOsMapsLayer('Light', key);
            for (const [name, layer] of Object.entries(osMapsLayers)) {
                layerControl.addBaseLayer(layer, name);
            }
        } else if (!hasKey && Object.keys(osMapsLayers).length > 0) {
            // Remove OS Maps layers (user cleared the key)
            for (const [name, layer] of Object.entries(osMapsLayers)) {
                layerControl.removeLayer(layer);
                if (map.hasLayer(layer)) map.removeLayer(layer);
            }
            osMapsLayers = {};
        } else if (hasKey && Object.keys(osMapsLayers).length > 0) {
            // Key changed - recreate layers with new key
            for (const [name, layer] of Object.entries(osMapsLayers)) {
                layerControl.removeLayer(layer);
                if (map.hasLayer(layer)) map.removeLayer(layer);
            }
            const styleMap = { 'OS Outdoor': 'Outdoor', 'OS Road': 'Road', 'OS Light': 'Light' };
            osMapsLayers = {};
            for (const [name, style] of Object.entries(styleMap)) {
                osMapsLayers[name] = createOsMapsLayer(style, key);
                layerControl.addBaseLayer(osMapsLayers[name], name);
            }
        }
    }

    function initMap() {
        map = L.map('map', {
            center: [51.5074, -0.1278], // London
            zoom: 11,
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

        const baseLayers = {
            'OpenStreetMap': osmStandard,
            'Topographic': osmTopo,
            'Satellite': esriSatellite
        };
        const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';
        if (mapboxToken) {
            baseLayers['Mapbox Streets'] = createMapboxLayer('mapbox/streets-v12', mapboxToken);
            baseLayers['Mapbox Outdoors'] = createMapboxLayer('mapbox/outdoors-v12', mapboxToken);
            baseLayers['Mapbox Light'] = createMapboxLayer('mapbox/light-v11', mapboxToken);
        }

        // UK Airspace Restrictions (toggled from legend, not layer control)
        let airspaceModule = null;
        let notamModule = null;
        let ratModule = null;
        if (typeof Notam !== 'undefined') {
            notamModule = Notam.init({ map: map });
        }
        if (typeof RAT !== 'undefined') {
            ratModule = RAT.init({
                map: map,
                getCredentials: function () {
                    return {
                        username: settings.bgaAirspaceUsername || '',
                        password: settings.bgaAirspacePassword || ''
                    };
                }
            });
        }
        if (typeof Airspace !== 'undefined') {
            airspaceModule = Airspace.init({
                map: map,
                dataUrl: 'assets/uk-airspace.geojson',
                aipDataUrl: 'assets/uk-aip-airspace.geojson',
                notamModule: notamModule,
                ratModule: ratModule
            });
        }

        layerControl = L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

        if (airspaceModule && airspaceModule.createLegendControl) {
            map.addControl(airspaceModule.createLegendControl());
        }

        // Add OS Maps layers if API key is configured (from localStorage or project)
        updateOsMapsLayers();

        // Geolocation: show user's current location (Leaflet.Locate plugin)
        if (typeof L.control.locate === 'function') {
            L.control.locate({
                position: 'topleft',
                strings: {
                    title: 'Show my location',
                    popup: 'You are within {distance} from this point',
                    outsideMapBoundsMsg: 'You seem located outside the boundaries of the map'
                },
                locateOptions: { enableHighAccuracy: true }
            }).addTo(map);
        }

        // Save / Load project buttons (toolbar)
        const SaveLoadControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-save-load');
                const saveBtn = L.DomUtil.create('a', 'leaflet-control-save leaflet-buttons-control-button', container);
                saveBtn.href = '#';
                saveBtn.title = 'Save Project';
                saveBtn.innerHTML = '<span class="control-icon lucide-save-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-save"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg></span>';
                const loadBtn = L.DomUtil.create('a', 'leaflet-control-load leaflet-buttons-control-button', container);
                loadBtn.href = '#';
                loadBtn.title = 'Load Project';
                loadBtn.innerHTML = '<span class="control-icon lucide-folder-open-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></span>';
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(saveBtn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    L.DomEvent.preventDefault(e);
                    ProjectIO.saveProject(points, settings, Drawings.serializeShapes());
                });
                L.DomEvent.on(loadBtn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    L.DomEvent.preventDefault(e);
                    document.getElementById('projectFileInput').click();
                });
                return container;
            }
        });
        map.addControl(new SaveLoadControl());

        // Click on map to place point (skip when drawing). No coordinate popup by default.
        map.on('click', function (e) {
            if (Drawings.isDrawingActive()) return;
            if (dropPointMode) {
                createPointAtLatLng(e.latlng.lat, e.latlng.lng);
                // Single-shot placement: disarm and reset picker after one pin drop.
                setDropPointMode(false);
                setDropPointPickerOpen(false);
            }
        });

        // Ensure map fills container: invalidateSize when container resizes (handles initial load + layout changes)
        const mapContainer = document.getElementById('map');
        if (mapContainer && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => map.invalidateSize());
            ro.observe(mapContainer);
        }
        map.whenReady(() => {
            requestAnimationFrame(() => map.invalidateSize());
        });
    }

    function addStandaloneUndoControl() {
        const UndoControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const btn = L.DomUtil.create('a', 'leaflet-control-undo leaflet-buttons-control-button disabled', container);
                btn.href = '#';
                btn.title = 'Undo last action (Ctrl+Z)';
                btn.setAttribute('aria-disabled', 'true');
                btn.innerHTML = '<span class="control-icon lucide-undo2-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-undo2-icon lucide-undo-2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg></span>';
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(btn, 'click', (e) => {
                    L.DomEvent.stop(e);
                    L.DomEvent.preventDefault(e);
                    if (typeof UndoHistory !== 'undefined' && UndoHistory.undo()) {
                        refreshHandToolState();
                    }
                });
                return container;
            }
        });
        map.addControl(new UndoControl());
    }

    function initDropPointToolbarControl() {
        const toolbar = document.querySelector('.leaflet-pm-toolbar.leaflet-pm-draw')
            || document.querySelector('.leaflet-pm-toolbar');
        if (!toolbar) {
            addStandaloneUndoControl();
            return;
        }

        // Move the arrow button into the Geoman toolbar if it's in a separate container
        const arrowBtn = document.querySelector('.leaflet-control-extra-draw');
        if (arrowBtn) {
            const oldContainer = arrowBtn.closest('.leaflet-bar');
            toolbar.appendChild(arrowBtn);
            if (oldContainer && oldContainer !== toolbar && !oldContainer.children.length) {
                oldContainer.remove();
            }
        }

        // Move the line draw button into the Geoman toolbar
        const lineDrawBtn = document.querySelector('.leaflet-control-line-draw');
        if (lineDrawBtn) {
            const oldContainer = lineDrawBtn.closest('.leaflet-bar');
            toolbar.appendChild(lineDrawBtn);
            if (oldContainer && oldContainer !== toolbar && !oldContainer.children.length) {
                oldContainer.remove();
            }
        }

        // Move the flight path button into the Geoman toolbar
        const flightPathBtn = document.querySelector('.leaflet-control-flight-path');
        if (flightPathBtn) {
            const oldContainer = flightPathBtn.closest('.leaflet-bar');
            toolbar.appendChild(flightPathBtn);
            if (oldContainer && oldContainer !== toolbar && !oldContainer.children.length) {
                oldContainer.remove();
            }
        }

        // Create search button and prepend to toolbar (first button, above hand)
        const searchBtn = document.createElement('a');
        searchBtn.className = 'leaflet-control-search leaflet-buttons-control-button';
        searchBtn.href = '#';
        searchBtn.title = 'Search location (postcode, lat/long, w3w...)';
        searchBtn.innerHTML = '<span class="control-icon lucide-search-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search-icon lucide-search"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg></span>';
        toolbar.insertBefore(searchBtn, toolbar.firstChild);

        L.DomEvent.on(searchBtn, 'click', (e) => {
            L.DomEvent.stop(e);
            L.DomEvent.preventDefault(e);
            openModal('searchModal');
            const input = document.getElementById('searchInput');
            if (input) {
                input.value = '';
                document.getElementById('searchStatus').classList.add('hidden');
                document.getElementById('searchFormatHint').textContent = '';
                requestAnimationFrame(() => input.focus());
            }
        });

        // Create hand/pan button and prepend to toolbar (second button)
        const handBtn = document.createElement('a');
        handBtn.className = 'leaflet-control-hand-tool leaflet-buttons-control-button';
        handBtn.href = '#';
        handBtn.title = 'Pan / Move map (drag to pan)';
        handBtn.innerHTML = '<span class="control-icon lucide-hand-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hand"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg></span>';
        handBtn.classList.add('active');
        toolbar.insertBefore(handBtn, searchBtn.nextSibling);

        L.DomEvent.on(handBtn, 'click', (e) => {
            L.DomEvent.stop(e);
            L.DomEvent.preventDefault(e);
            setDropPointMode(false);
            setDropPointPickerOpen(false);
            Drawings.exitAllDrawingModes();
            refreshHandToolState();
        });

        handToolbarButton = handBtn;

        // Create undo button and insert after hand (wrap in button-container to match Geoman structure)
        const undoContainer = document.createElement('div');
        undoContainer.className = 'button-container';
        const undoToolbarBtn = document.createElement('a');
        undoToolbarBtn.className = 'leaflet-control-undo leaflet-buttons-control-button disabled';
        undoToolbarBtn.href = '#';
        undoToolbarBtn.title = 'Undo last action (Ctrl+Z)';
        undoToolbarBtn.setAttribute('aria-disabled', 'true');
        undoToolbarBtn.innerHTML = '<span class="control-icon lucide-undo2-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-undo2-icon lucide-undo-2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg></span>';
        undoContainer.appendChild(undoToolbarBtn);
        const insertBefore = handBtn.nextElementSibling || handBtn.nextSibling;
        toolbar.insertBefore(undoContainer, insertBefore);

        L.DomEvent.on(undoToolbarBtn, 'click', (e) => {
            L.DomEvent.stop(e);
            L.DomEvent.preventDefault(e);
            if (typeof UndoHistory !== 'undefined' && UndoHistory.undo()) {
                refreshHandToolState();
            }
        });

        // Create drop point wrapper (button + popup menu) and insert at top of toolbar (after hand)
        const dropPointWrapper = document.createElement('div');
        dropPointWrapper.className = 'drop-point-wrapper';

        const btn = document.createElement('a');
        btn.className = 'leaflet-control-drop-point leaflet-buttons-control-button';
        btn.href = '#';
        btn.title = 'Drop Point (choose type, then click map)';
        btn.innerHTML = '<span class="control-icon lucide-map-pin-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg></span>';
        dropPointWrapper.appendChild(btn);

        L.DomEvent.on(btn, 'click', (e) => {
            L.DomEvent.stop(e);
            L.DomEvent.preventDefault(e);
            if (dropPointPickerOpen || dropPointMode) {
                setDropPointMode(false);
                setDropPointPickerOpen(false);
                return;
            }
            setDropPointMode(false);
            setDropPointPickerOpen(true);
        });

        // Create icon strip (positioned to the side of the button)
        const strip = document.createElement('div');
        strip.className = 'drop-icon-strip leaflet-control hidden';
        strip.innerHTML = '<div class="drop-icon-strip-title">Select a point type</div>';
        dropPointWrapper.appendChild(strip);

        toolbar.insertBefore(dropPointWrapper, handBtn.nextSibling);
        L.DomEvent.disableClickPropagation(strip);

        Object.keys(ICON_DEFS).forEach(key => {
            const def = ICON_DEFS[key];
            const option = document.createElement('button');
            option.className = 'drop-icon-strip-btn';
            option.type = 'button';
            option.dataset.icon = key;
            option.title = def.label;
            if (def.svgContent) {
                const dataUri = svgToDataUri(def.svgContent, def.color);
                option.innerHTML = `
                    <span class="drop-icon-strip-symbol drop-icon-strip-svg"><img src="${dataUri}" alt="" width="18" height="18"></span>
                    <span class="drop-icon-strip-label">${escapeHtml(def.label)}</span>
                `;
            } else {
                option.innerHTML = `
                    <span class="drop-icon-strip-symbol" style="background:${def.color}; color:${getContrastingTextColor(def.color)}">${def.symbol}</span>
                    <span class="drop-icon-strip-label">${escapeHtml(def.label)}</span>
                `;
            }
            if (key === lastDropIconType) option.classList.add('selected');
            strip.appendChild(option);

            option.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const newType = normalizeIconType(key);
                const newDef = ICON_DEFS[newType];
                lastDropIconType = newType;
                lastDropIconColor = (newDef.useColorPalette ? newDef.color : (newDef.colorEditable ? lastDropIconColor : newDef.color));
                refreshDropIconStrip();
                setDropPointPickerOpen(false);
                setDropPointMode(true);
            });
        });

        dropPointToolbarButton = btn;
        dropPointIconStrip = strip;
    }

    function refreshDropIconStrip() {
        if (!dropPointIconStrip) return;
        dropPointIconStrip.querySelectorAll('.drop-icon-strip-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.icon === lastDropIconType);
        });
    }

    // ---- Point Management ----

    function pushUndoSnapshot() {
        if (typeof UndoHistory !== 'undefined') UndoHistory.pushSnapshot();
    }

    function createPoint(data, options) {
        if (!(options && options.skipUndoSnapshot)) pushUndoSnapshot();
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
            originalInput: data.originalInput || '',
            alwaysDisplayElevation: !!data.alwaysDisplayElevation,
            elevation: (typeof data.elevation === 'number' && !isNaN(data.elevation)) ? data.elevation : undefined
        };
        points.push(point);
        addMarkerToMap(point);
        refreshPointsList();
        return point;
    }

    function createPointAtLatLng(lat, lng) {
        const iconType = normalizeIconType(lastDropIconType);
        const defaultLabel = (ICON_DEFS[iconType] && ICON_DEFS[iconType].label) || 'Dropped Point';
        const point = createPoint({
            name: defaultLabel,
            lat,
            lng,
            iconType,
            iconColor: lastDropIconColor,
            customSymbol: '',
            notes: '',
            originalInput: `${lat.toFixed(6)}, ${lng.toFixed(6)}`
        });
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
        openQuickEditPopup(point.id, true);
    }

    function updatePoint(id, data) {
        const point = points.find(p => p.id === id);
        if (!point) return;
        pushUndoSnapshot();

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
        pushUndoSnapshot();
        removeMarkerFromMap(id);
        points = points.filter(p => p.id !== id);
        refreshPointsList();
    }

    function clearAllPoints() {
        pushUndoSnapshot();
        for (const id of Object.keys(markerLayers)) {
            removeMarkerFromMap(parseInt(id));
        }
        points = [];
        nextId = 1;
        refreshPointsList();
    }

    function restorePointsFromSnapshot(snapshotPoints) {
        for (const id of Object.keys(markerLayers)) {
            removeMarkerFromMap(parseInt(id));
        }
        markerLayers = {};
        points = [];
        if (!snapshotPoints || snapshotPoints.length === 0) {
            nextId = 1;
            refreshPointsList();
            return;
        }
        let maxId = 0;
        for (const p of snapshotPoints) {
            const point = { ...p };
            points.push(point);
            addMarkerToMap(point);
            if (point.id != null) maxId = Math.max(maxId, point.id);
        }
        nextId = maxId + 1;
        refreshPointsList();
    }

    // ---- Markers ----

    const ICON_COLOR_PALETTE = ['#000000', '#dc2626', '#2563eb', '#16a34a', '#ca8a04', '#ea580c', '#9333ea', '#0891b2'];

    const ICON_DEFS = {
        address: { label: 'Address / Reference', symbol: 'A', color: '#dc2626', colorEditable: true },
        primary_tola: { label: 'Primary TOLA', symbol: 'H', color: '#1e88e5', colorEditable: false },
        secondary_tola: { label: 'Secondary TOLA', symbol: 'H', color: '#f4c542', colorEditable: false },
        custom_tola: { label: 'Custom TOLA', symbol: 'H', color: '#22c55e', colorEditable: true },
        emergency_lz: { label: 'Emergency Landing Zone', symbol: '\u271A', color: '#ef4444', colorEditable: false },
        no_fly: { label: 'No-Fly Marker', symbol: 'X', color: '#d32f2f', colorEditable: false },
        hazard: { label: 'Hazard', symbol: '!', color: '#ff9800', colorEditable: false },
        waypoint: { label: 'Waypoint', symbol: 'W', color: '#0ea5e9', colorEditable: true },
        custom_point: { label: 'Custom Point', symbol: '?', color: '#8e24aa', colorEditable: true },
        house: {
            label: 'House',
            symbol: '\u2302',
            color: '#000000',
            colorEditable: true,
            svgContent: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
            useColorPalette: true
        },
        tola_house: {
            label: 'TOLA',
            symbol: 'T',
            color: '#000000',
            colorEditable: true,
            svgContent: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22a1 1 0 0 1-1-1v-4a1 1 0 0 1 .445-.832l3-2a1 1 0 0 1 1.11 0l3 2A1 1 0 0 1 22 17v4a1 1 0 0 1-1 1z"/><path d="M18 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 .601.2"/><path d="M18 22v-3"/><circle cx="10" cy="10" r="3"/></svg>',
            useColorPalette: true
        }
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
            customtola: 'custom_tola',
            custom_tola: 'custom_tola',
            tola_custom: 'custom_tola',
            emergency: 'emergency_lz',
            emergencylandingzone: 'emergency_lz',
            emergency_landing_zone: 'emergency_lz',
            nofly: 'no_fly',
            no_fly_marker: 'no_fly',
            wp: 'waypoint',
            waypoint: 'waypoint',
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
            user: 'custom_point',
            home: 'house',
            tola: 'tola_house',
            tolahouse: 'tola_house'
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

    function colorizeSvg(svgString, color) {
        const hex = (color || '#000000').replace('#', '');
        return svgString.replace(/currentColor/gi, '#' + hex);
    }

    function svgToDataUri(svgString, color) {
        const colored = colorizeSvg(svgString, color || '#000000');
        return `data:image/svg+xml,${encodeURIComponent(colored)}`;
    }

    function getPointIcon(point) {
        const iconType = normalizeIconType(point.iconType);
        const color = getIconColor(iconType, point.iconColor);
        const def = ICON_DEFS[iconType];

        if (def.svgContent) {
            const key = `${iconType}|${color}`;
            if (iconCache[key]) return iconCache[key];
            const icon = L.icon({
                iconUrl: svgToDataUri(def.svgContent, color),
                iconSize: [24, 24],
                iconAnchor: [12, 24],
                popupAnchor: [0, -12],
                shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                shadowSize: [41, 41]
            });
            iconCache[key] = icon;
            return icon;
        }

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

    function getPointTooltipContent(point) {
        if (!settings.showLabels) return null;
        const name = point.name || '';
        if (!point.alwaysDisplayElevation) return name || null;
        if (point.elevation != null && !isNaN(point.elevation)) {
            return `${name} (${point.elevation.toFixed(1)} m)`;
        }
        return name ? `${name} (…)` : null;
    }

    function buildQuickEditPopupHtml(point, fromDropPin) {
        let html = '<div class="quick-edit-popup">';
        if (!fromDropPin) {
            const iconKeys = Object.keys(ICON_DEFS);
            const currentType = normalizeIconType(point.iconType);
            html += '<div class="quick-edit-icons">';
            iconKeys.forEach(key => {
                const def = ICON_DEFS[key];
                const txtColor = getContrastingTextColor(def.color);
                const sel = key === currentType ? ' selected' : '';
                html += `<button class="quick-icon-btn${sel}" data-icon="${key}" style="background:${def.color}; color:${txtColor}" title="${escapeHtml(def.label)}">${escapeHtml(def.symbol)}</button>`;
            });
            html += '</div>';
        }
        html += '<div class="quick-edit-field">';
        html += '<input class="quick-edit-label" type="text" value="" placeholder="Label...">';
        html += '</div>';
        html += '<div class="quick-edit-elevation">Elevation: <span class="elevation-value">—</span></div>';
        html += '<div class="quick-edit-actions">';
        html += `<a href="#" class="quick-edit-details" data-point-id="${point.id}">View details</a>`;
        html += `<a href="#" class="quick-edit-more" data-point-id="${point.id}">Edit...</a>`;
        html += '</div>';
        html += '</div>';
        return html;
    }

    function openQuickEditPopup(pointId, fromDropPin) {
        const point = points.find(p => p.id === pointId);
        if (!point) return;
        const layers = markerLayers[pointId];
        if (!layers) return;

        const marker = layers.marker;
        marker.unbindPopup();
        marker.off('popupopen');
        marker.off('popupclose');

        const popup = L.popup({
            closeOnClick: false,
            autoClose: true,
            minWidth: 220,
            maxWidth: 280,
            className: 'quick-edit-popup-wrapper'
        }).setContent(buildQuickEditPopupHtml(point, fromDropPin));

        marker.bindPopup(popup);

        marker.on('popupclose', function onClose() {
            marker.off('popupclose', onClose);
            if (quickEditUpdating) return;

            const currentPoint = points.find(p => p.id === pointId);
            if (!currentPoint) return;

            const currentLayers = markerLayers[pointId];
            if (currentLayers) {
                const m = currentLayers.marker;
                m.unbindPopup();
                m.unbindTooltip();
                const tooltipContent = getPointTooltipContent(currentPoint);
                if (tooltipContent) {
                    m.bindTooltip(tooltipContent, {
                        permanent: true,
                        direction: 'top',
                        offset: [0, -35],
                        className: 'point-label-tooltip'
                    });
                }
            }
            refreshPointsList();
        });

        marker.openPopup();

        const container = document.querySelector('.quick-edit-popup');
        if (!container) return;

        const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';
        const elevationEl = container.querySelector('.elevation-value');
        if (elevationEl && mapboxToken && typeof Elevation !== 'undefined') {
            elevationEl.textContent = '…';
            Elevation.getElevationAtLatLng(point.lat, point.lng, mapboxToken).then(elev => {
                if (elev !== null) {
                    point.elevation = elev;
                    if (elevationEl) elevationEl.textContent = `${elev.toFixed(1)} m AMSL`;
                } else if (elevationEl) {
                    elevationEl.textContent = '—';
                }
            }).catch(() => {
                if (elevationEl) elevationEl.textContent = '—';
            });
        } else if (elevationEl && !mapboxToken) {
            elevationEl.closest('.quick-edit-elevation').style.display = 'none';
        }

        container.querySelectorAll('.quick-icon-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const newIconType = normalizeIconType(btn.dataset.icon);
                const def = ICON_DEFS[newIconType];

                const labelInput = container.querySelector('.quick-edit-label');
                const currentLabel = labelInput ? labelInput.value.trim() : point.name;
                const isDefault = Object.values(ICON_DEFS).some(d => d.label === currentLabel);
                const newLabel = isDefault ? def.label : currentLabel;

                lastDropIconType = newIconType;
                lastDropIconColor = (def.useColorPalette ? def.color : (def.colorEditable ? lastDropIconColor : def.color));
                refreshDropIconStrip();

                quickEditUpdating = true;
                updatePoint(pointId, {
                    iconType: newIconType,
                    iconColor: lastDropIconColor,
                    name: newLabel
                });
                quickEditUpdating = false;

                openQuickEditPopup(pointId, false);
            });
        });

        const labelInput = container.querySelector('.quick-edit-label');
        if (labelInput) {
            labelInput.value = point.name || '';
            labelInput.focus();
            labelInput.select();

            labelInput.addEventListener('input', () => {
                point.name = labelInput.value.trim();
            });
            labelInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    marker.closePopup();
                }
            });
        }

        const detailsLink = container.querySelector('.quick-edit-details');
        if (detailsLink) {
            detailsLink.addEventListener('click', (e) => {
                e.preventDefault();
                quickEditUpdating = true;
                marker.closePopup();
                marker.unbindPopup();
                refreshPointsList();
                quickEditUpdating = false;
                openPointDetailsModal(pointId);
            });
        }

        const moreLink = container.querySelector('.quick-edit-more');
        if (moreLink) {
            moreLink.addEventListener('click', (e) => {
                e.preventDefault();
                quickEditUpdating = true;
                marker.closePopup();
                marker.unbindPopup();
                refreshPointsList();
                quickEditUpdating = false;
                openEditModal(pointId);
            });
        }
    }

    function addMarkerToMap(point) {
        const icon = getPointIcon(point);
        const marker = L.marker([point.lat, point.lng], { icon, draggable: true }).addTo(map);

        // Tooltip/label
        let label = null;
        const tooltipContent = getPointTooltipContent(point);
        if (tooltipContent) {
            label = L.tooltip({
                permanent: true,
                direction: 'top',
                offset: [0, -35],
                className: 'point-label-tooltip'
            }).setContent(tooltipContent);
            marker.bindTooltip(label);
        }

        // Fetch elevation on demand when alwaysDisplayElevation is on but we don't have it yet
        const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';
        if (point.alwaysDisplayElevation && point.elevation == null && mapboxToken && typeof Elevation !== 'undefined') {
            Elevation.getElevationAtLatLng(point.lat, point.lng, mapboxToken).then(elev => {
                if (elev != null && points.find(p => p.id === point.id)) {
                    point.elevation = elev;
                    const layers = markerLayers[point.id];
                    if (layers) {
                        const content = getPointTooltipContent(point);
                        if (content) {
                            layers.marker.unbindTooltip();
                            layers.marker.bindTooltip(content, {
                                permanent: true,
                                direction: 'top',
                                offset: [0, -35],
                                className: 'point-label-tooltip'
                            });
                        }
                    }
                }
            }).catch(() => {});
        }

        let fans = null;

        marker.on('click', () => {
            highlightPoint(point.id);
        });

        marker.on('contextmenu', (e) => {
            L.DomEvent.preventDefault(e);
            L.DomEvent.stopPropagation(e);
            mapContextPointId = point.id;
            mapContextMenuLatLng = marker.getLatLng();
            mapContextShapeId = null;
            showMapContextMenu(e.originalEvent);
        });

        marker.on('dragstart', () => {
            marker.closePopup();
        });
        marker.on('dragend', () => {
            const pos = marker.getLatLng();
            point.lat = pos.lat;
            point.lng = pos.lng;
            point.elevation = undefined; // invalidate cached elevation when position changes

            const layers = markerLayers[point.id];
            if (layers && layers.fans) {
                map.removeLayer(layers.fans);
                layers.fans = null;
            }
            // Refetch elevation and update tooltip if alwaysDisplayElevation is on
            const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';
            if (point.alwaysDisplayElevation && mapboxToken && typeof Elevation !== 'undefined') {
                Elevation.getElevationAtLatLng(point.lat, point.lng, mapboxToken).then(elev => {
                    if (elev != null && points.find(p => p.id === point.id)) {
                        point.elevation = elev;
                        const ly = markerLayers[point.id];
                        if (ly) {
                            const content = getPointTooltipContent(point);
                            if (content) {
                                ly.marker.unbindTooltip();
                                ly.marker.bindTooltip(content, {
                                    permanent: true,
                                    direction: 'top',
                                    offset: [0, -35],
                                    className: 'point-label-tooltip'
                                });
                            }
                        }
                    }
                }).catch(() => {});
            }
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
    const pointIconColorPaletteGroup = document.getElementById('pointIconColorPaletteGroup');
    const pointIconColorPalette = document.getElementById('pointIconColorPalette');
    const pointCustomSymbol = document.getElementById('pointCustomSymbol');
    const pointCustomSymbolGroup = document.getElementById('pointCustomSymbolGroup');
    const pointNotes = document.getElementById('pointNotes');
    const formatHint = document.getElementById('formatHint');

    function refreshPointIconControls() {
        const iconType = normalizeIconType(pointIconType.value);
        const iconDef = ICON_DEFS[iconType];
        const usePalette = iconDef.useColorPalette === true;
        pointIconColorGroup.classList.toggle('hidden', usePalette || !iconDef.colorEditable);
        pointIconColorPaletteGroup.classList.toggle('hidden', !usePalette);
        pointCustomSymbolGroup.classList.toggle('hidden', iconType !== 'custom_point');
        if (usePalette && pointIconColorPalette) {
            pointIconColorPalette.innerHTML = '';
            const currentColor = pointIconColor.value;
            ICON_COLOR_PALETTE.forEach(c => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'color-swatch' + (c.toLowerCase() === currentColor.toLowerCase() ? ' selected' : '');
                btn.dataset.color = c;
                btn.style.backgroundColor = c;
                btn.title = c;
                btn.addEventListener('click', () => {
                    pointIconColor.value = c;
                    pointIconColorPalette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
                    btn.classList.add('selected');
                });
                pointIconColorPalette.appendChild(btn);
            });
        }
    }

    function refreshHandToolState() {
        const isPanMode = !dropPointMode && !dropPointPickerOpen && !Drawings.isDrawingActive();
        const mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.classList.toggle('pan-mode', isPanMode);
        }
        if (handToolbarButton) {
            handToolbarButton.classList.toggle('active', isPanMode);
        }
    }

    function refreshDropPointModeButton() {
        if (dropPointToolbarButton) {
            dropPointToolbarButton.classList.toggle('active', dropPointMode || dropPointPickerOpen);
        }
        if (dropPointIconStrip) {
            dropPointIconStrip.classList.toggle('hidden', !dropPointPickerOpen);
            if (dropPointPickerOpen) refreshDropIconStrip();
        }
        // Mobile bottom drawer backdrop
        updateDropPointBackdrop(dropPointPickerOpen);
        const mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.classList.toggle('drop-point-cursor', dropPointMode);
        }
        refreshHandToolState();
    }

    let dropPointBackdrop = null;
    function updateDropPointBackdrop(show) {
        if (window.innerWidth > 600) return;
        if (show && !dropPointBackdrop) {
            dropPointBackdrop = document.createElement('div');
            dropPointBackdrop.className = 'drop-icon-strip-backdrop';
            dropPointBackdrop.addEventListener('click', () => {
                setDropPointMode(false);
                setDropPointPickerOpen(false);
            });
            document.body.appendChild(dropPointBackdrop);
        } else if (!show && dropPointBackdrop) {
            dropPointBackdrop.remove();
            dropPointBackdrop = null;
        }
    }

    function setDropPointMode(enabled) {
        dropPointMode = !!enabled;
        refreshDropPointModeButton();
    }

    function setDropPointPickerOpen(open) {
        dropPointPickerOpen = !!open;
        refreshDropPointModeButton();
    }


    pointIconType.addEventListener('change', () => {
        const iconType = normalizeIconType(pointIconType.value);
        const iconDef = ICON_DEFS[iconType];
        if (iconDef.useColorPalette) pointIconColor.value = iconDef.color;
        refreshPointIconControls();
    });
    pointIconType.value = 'address';
    pointIconColor.value = '#dc2626';
    pointCustomSymbol.value = '';
    refreshPointIconControls();
    refreshDropPointModeButton();

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
            const coords = await Converters.resolve(inputVal, getW3WApiKey());
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
                originalInput: inputVal,
                alwaysDisplayElevation: document.getElementById('pointAlwaysDisplayElevation').checked
            });

            // Pan to new point
            map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 14));

            // Reset form
            pointInput.value = '';
            pointName.value = '';
            pointNotes.value = '';
            pointIconType.value = 'address';
            pointIconColor.value = '#dc2626';
            pointCustomSymbol.value = '';
            document.getElementById('pointAlwaysDisplayElevation').checked = false;
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

    // Sidebar starts collapsed via HTML class; no layout shift before map init.

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

    // ---- Help Modal ----

    document.getElementById('helpBtn').addEventListener('click', () => {
        openModal('helpModal');
    });

    const footerDisclaimerBtn = document.getElementById('footerDisclaimerBtn');
    if (footerDisclaimerBtn) {
        footerDisclaimerBtn.addEventListener('click', () => {
        openModal('helpModal');
        document.querySelectorAll('#helpModal .tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('#helpModal .tab-panel').forEach(p => p.classList.remove('active'));
        const disclaimerTab = document.querySelector('#helpModal .tab[data-tab="disclaimer"]');
        const disclaimerPanel = document.getElementById('help-tab-disclaimer');
        if (disclaimerTab) disclaimerTab.classList.add('active');
        if (disclaimerPanel) disclaimerPanel.classList.add('active');
        });
    }

    document.querySelectorAll('#helpModal .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#helpModal .tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#helpModal .tab-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('help-tab-' + tab.dataset.tab).classList.add('active');
        });
    });

    // ---- Edit Point Modal ----

    const editModal = document.getElementById('editModal');

    // ---- Point Details Modal ----

    function openPointDetailsModal(id) {
        const point = points.find(p => p.id === id);
        if (!point) return;

        const titleEl = document.getElementById('pointDetailsTitle');
        titleEl.textContent = point.name || 'Point Details';

        document.getElementById('detailDecimal').textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
        document.getElementById('detailDMS').textContent = Converters.latLngToDMS(point.lat, point.lng);

        const gridRef = Converters.latLngToGridRef(point.lat, point.lng, 10);
        document.getElementById('detailOSGrid').textContent = gridRef || 'Outside UK grid';

        const w3wEl = document.getElementById('detailW3WText');
        const w3wHint = document.getElementById('detailW3WHint');
        const w3wKey = getW3WApiKey();

        if (w3wKey) {
            w3wEl.textContent = 'Loading…';
            w3wHint.style.display = 'none';
            Converters.reverseW3W(point.lat, point.lng, w3wKey).then(words => {
                if (words) {
                    w3wEl.innerHTML = '<span class="detail-w3w-prefix">///</span>' + escapeHtml(words);
                } else {
                    w3wEl.textContent = 'Not available';
                }
            }).catch(() => {
                w3wEl.textContent = 'Error';
            });
        } else {
            w3wEl.textContent = '—';
            w3wHint.style.display = '';
        }

        const elevationEl = document.getElementById('detailElevation');
        const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';
        if (point.elevation != null && !isNaN(point.elevation)) {
            elevationEl.textContent = `${point.elevation.toFixed(1)} m AMSL`;
        } else if (mapboxToken && typeof Elevation !== 'undefined') {
            elevationEl.textContent = 'Loading…';
            Elevation.getElevationAtLatLng(point.lat, point.lng, mapboxToken).then(elev => {
                if (elev !== null) {
                    point.elevation = elev;
                    elevationEl.textContent = `${elev.toFixed(1)} m AMSL`;
                } else {
                    elevationEl.textContent = '—';
                }
            }).catch(() => {
                elevationEl.textContent = '—';
            });
        } else {
            elevationEl.textContent = '—';
        }

        openModal('pointDetailsModal');
    }

    function initPointDetailsModal() {
        const modal = document.getElementById('pointDetailsModal');
        if (!modal) return;

        modal.querySelectorAll('.detail-copyable').forEach(el => {
            el.addEventListener('click', () => {
                let text = el.textContent.trim();
                if (!text || text === '—' || text === 'Loading…' || text === 'Error') return;
                navigator.clipboard.writeText(text).then(() => {
                    el.classList.add('copied');
                    setTimeout(() => el.classList.remove('copied'), 1200);
                }).catch(() => {});
            });
        });

        document.getElementById('detailCopyAllBtn').addEventListener('click', () => {
            const title = document.getElementById('pointDetailsTitle').textContent.trim();
            const dec = document.getElementById('detailDecimal').textContent.trim();
            const dms = document.getElementById('detailDMS').textContent.trim();
            const grid = document.getElementById('detailOSGrid').textContent.trim();
            const w3w = document.getElementById('detailW3WText').textContent.trim();
            const elev = document.getElementById('detailElevation').textContent.trim();

            const rows = [];
            if (dec && dec !== '—')
                rows.push({ label: 'Decimal', value: dec });
            if (dms && dms !== '—')
                rows.push({ label: 'DMS', value: dms });
            if (grid && grid !== '—' && grid !== 'Outside UK grid')
                rows.push({ label: 'OS Grid Ref', value: grid });
            if (w3w && w3w !== '—' && w3w !== 'Loading…' && w3w !== 'Not available' && w3w !== 'Error')
                rows.push({ label: 'What3Words', value: '///' + w3w.replace(/^\/\/\//, '') });
            if (elev && elev !== '—' && elev !== 'Loading…')
                rows.push({ label: 'Elevation', value: elev });

            const maxLabel = Math.max(...rows.map(r => r.label.length));
            const divider = '\u2500'.repeat(maxLabel + 4 + Math.max(...rows.map(r => r.value.length)));

            const lines = [];
            lines.push(title.toUpperCase());
            lines.push(divider);
            for (const row of rows) {
                lines.push(`  ${row.label.padEnd(maxLabel + 2)}${row.value}`);
            }
            lines.push(divider);

            const text = lines.join('\n');
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('detailCopyAllBtn');
                const orig = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = orig; }, 1200);
            }).catch(() => {});
        });
    }

    function openFlightOverviewModal(shapeId) {
        const modal = document.getElementById('flightOverviewModal');
        const loadingEl = document.getElementById('flightOverviewLoading');
        const noTokenEl = document.getElementById('flightOverviewNoToken');
        const errorEl = document.getElementById('flightOverviewError');
        const errorTextEl = document.getElementById('flightOverviewErrorText');
        const contentEl = document.getElementById('flightOverviewContent');

        if (!modal || !loadingEl || !contentEl) return;

        const shape = Drawings.getShapes().find(s => s.id === shapeId);
        const isPathOrLine = shape && (shape.type === 'flightpath' || shape.type === 'polyline');
        if (!isPathOrLine || !shape.latlngs || shape.latlngs.length < 2) return;

        const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';

        loadingEl.classList.remove('hidden');
        noTokenEl.classList.add('hidden');
        errorEl.classList.add('hidden');
        contentEl.classList.add('hidden');

        modal.classList.remove('hidden');

        if (!mapboxToken || !mapboxToken.trim()) {
            loadingEl.classList.add('hidden');
            noTokenEl.classList.remove('hidden');
            return;
        }

        (async () => {
            try {
                const results = typeof Elevation !== 'undefined'
                    ? await Elevation.getElevationsAlongPath(shape.latlngs, mapboxToken)
                    : [];

                loadingEl.classList.add('hidden');

                const elevations = results.map(r => r.elevation);
                const hasData = elevations.some(e => e != null && !Number.isNaN(e));

                if (!hasData) {
                    errorTextEl.textContent = 'Could not load elevation data for this path.';
                    errorEl.classList.remove('hidden');
                    return;
                }

                const validElevs = elevations.filter(e => e != null && !Number.isNaN(e));
                const startAlt = elevations[0] != null ? elevations[0] : validElevs[0];
                const endAlt = elevations[elevations.length - 1] != null ? elevations[elevations.length - 1] : validElevs[validElevs.length - 1];
                const highest = Math.max(...validElevs);
                const lowest = Math.min(...validElevs);
                const variation = highest - lowest;
                const netChange = endAlt - startAlt;

                let totalGain = 0;
                let totalLoss = 0;
                for (let i = 1; i < elevations.length; i++) {
                    const prev = elevations[i - 1];
                    const curr = elevations[i];
                    if (prev != null && curr != null && !Number.isNaN(prev) && !Number.isNaN(curr)) {
                        const d = curr - prev;
                        if (d > 0) totalGain += d;
                        else totalLoss += Math.abs(d);
                    }
                }

                const numSegments = Math.max(1, elevations.length - 1);
                const avgChange = netChange / numSegments;

                function fmtAlt(v) {
                    if (v == null || Number.isNaN(v)) return '—';
                    return `${v.toFixed(1)} m`;
                }
                function fmtChange(v) {
                    if (v == null || Number.isNaN(v) || v === 0) return '—';
                    const s = v > 0 ? '+' : '';
                    return `${s}${v.toFixed(1)} m`;
                }

                document.getElementById('foStartAlt').textContent = fmtAlt(startAlt);
                document.getElementById('foEndAlt').textContent = fmtAlt(endAlt);
                document.getElementById('foHighest').textContent = fmtAlt(highest);
                document.getElementById('foLowest').textContent = fmtAlt(lowest);
                document.getElementById('foVariation').textContent = fmtAlt(variation);

                const netChangeEl = document.getElementById('foNetChange');
                netChangeEl.textContent = fmtChange(netChange);
                netChangeEl.className = 'flight-stat-value' + (netChange > 0 ? ' positive' : netChange < 0 ? ' negative' : '');

                document.getElementById('foTotalGain').textContent = fmtAlt(totalGain);
                document.getElementById('foTotalLoss').textContent = fmtAlt(totalLoss);

                const avgChangeEl = document.getElementById('foAvgChange');
                avgChangeEl.textContent = fmtChange(avgChange);
                avgChangeEl.className = 'flight-stat-value' + (avgChange > 0 ? ' positive' : avgChange < 0 ? ' negative' : '');

                const tbody = document.getElementById('flightOverviewWaypointsBody');
                tbody.innerHTML = '';
                for (let i = 0; i < shape.latlngs.length; i++) {
                    const ll = shape.latlngs[i];
                    const lat = Array.isArray(ll) ? ll[0] : ll.lat;
                    const lng = Array.isArray(ll) ? ll[1] : ll.lng;
                    const elev = results[i]?.elevation;
                    const prevElev = i > 0 ? results[i - 1]?.elevation : null;
                    const change = (elev != null && prevElev != null) ? elev - prevElev : null;

                    const tr = document.createElement('tr');
                    const changeClass = change != null && change !== 0 ? (change > 0 ? 'change-up' : 'change-down') : '';
                    tr.innerHTML = `
                        <td>${i + 1}</td>
                        <td>${lat.toFixed(5)}</td>
                        <td>${lng.toFixed(5)}</td>
                        <td>${elev != null ? elev.toFixed(1) : '—'}</td>
                        <td class="${changeClass}">${change != null && change !== 0 ? (change > 0 ? '+' : '') + change.toFixed(1) + ' m' : '—'}</td>
                    `;
                    tbody.appendChild(tr);
                }

                contentEl.classList.remove('hidden');
            } catch (err) {
                loadingEl.classList.add('hidden');
                errorTextEl.textContent = 'Error: ' + (err.message || String(err));
                errorEl.classList.remove('hidden');
            }
        })();
    }

    function initSearchModal() {
        const searchGoBtn = document.getElementById('searchGoBtn');
        const searchInput = document.getElementById('searchInput');
        const searchFormatHint = document.getElementById('searchFormatHint');
        const searchStatus = document.getElementById('searchStatus');

        if (!searchGoBtn || !searchInput) return;

        searchGoBtn.addEventListener('click', async () => {
            const input = searchInput.value.trim();
            if (!input) return;

            searchGoBtn.disabled = true;
            searchGoBtn.textContent = 'Resolving...';
            searchStatus.classList.add('hidden');

            try {
                const coords = await Converters.resolve(input, getW3WApiKey());
                if (coords) {
                    map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 14));
                    closeModal('searchModal');
                    searchInput.value = '';
                    searchFormatHint.textContent = '';
                } else {
                    searchStatus.textContent = 'Could not resolve location. Check format and try again.';
                    searchStatus.className = 'bulk-status error';
                    searchStatus.classList.remove('hidden');
                }
            } catch (err) {
                searchStatus.textContent = 'Error: ' + (err.message || String(err));
                searchStatus.className = 'bulk-status error';
                searchStatus.classList.remove('hidden');
            } finally {
                searchGoBtn.disabled = false;
                searchGoBtn.textContent = 'Go to Location';
            }
        });

        searchInput.addEventListener('input', () => {
            const val = searchInput.value.trim();
            if (!val) {
                searchFormatHint.textContent = '';
                return;
            }
            const fmt = Converters.detectFormat(val);
            searchFormatHint.textContent = fmt ? `Detected: ${Converters.formatLabel(fmt)}` : '';
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchGoBtn.click();
            }
        });
    }

    function openEditModal(id) {
        const point = points.find(p => p.id === id);
        if (!point) return;

        document.getElementById('editPointId').value = id;
        document.getElementById('editPointName').value = point.name || '';
        document.getElementById('editCoordDisplay').textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
        const elevationEl = document.getElementById('editElevationDisplay');
        const mapboxToken = (typeof AIRPLOT_CONFIG !== 'undefined' && AIRPLOT_CONFIG.mapboxAccessToken) || '';
        if (elevationEl) {
            if (mapboxToken && typeof Elevation !== 'undefined') {
                elevationEl.textContent = 'Elevation: …';
                elevationEl.style.display = '';
                Elevation.getElevationAtLatLng(point.lat, point.lng, mapboxToken).then(elev => {
                    if (elev !== null) {
                        point.elevation = elev;
                        if (elevationEl) elevationEl.textContent = `Elevation: ${elev.toFixed(1)} m AMSL`;
                    } else if (elevationEl) {
                        elevationEl.textContent = '';
                        elevationEl.style.display = 'none';
                    }
                }).catch(() => {
                    if (elevationEl) {
                        elevationEl.textContent = '';
                        elevationEl.style.display = 'none';
                    }
                });
            } else {
                elevationEl.textContent = '';
                elevationEl.style.display = 'none';
            }
        }
        const editIconType = normalizeIconType(point.iconType);
        document.getElementById('editPointIconType').value = editIconType;
        document.getElementById('editPointIconColor').value = getIconColor(editIconType, point.iconColor);
        document.getElementById('editPointCustomSymbol').value = (point.customSymbol || '').slice(0, 2);
        document.getElementById('editPointNotes').value = point.notes || '';
        document.getElementById('editPointAlwaysDisplayElevation').checked = !!point.alwaysDisplayElevation;
        refreshEditPointIconControls();

        openModal('editModal');
    }

    function refreshEditPointIconControls() {
        const iconSel = document.getElementById('editPointIconType');
        const iconType = normalizeIconType(iconSel.value);
        const iconDef = ICON_DEFS[iconType];
        const usePalette = iconDef.useColorPalette === true;
        document.getElementById('editPointIconColorGroup').classList.toggle('hidden', usePalette || !iconDef.colorEditable);
        const paletteGroup = document.getElementById('editPointIconColorPaletteGroup');
        const paletteEl = document.getElementById('editPointIconColorPalette');
        paletteGroup.classList.toggle('hidden', !usePalette);
        if (usePalette && paletteEl) {
            paletteEl.innerHTML = '';
            const colorInput = document.getElementById('editPointIconColor');
            const currentColor = colorInput.value;
            ICON_COLOR_PALETTE.forEach(c => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'color-swatch' + (c.toLowerCase() === currentColor.toLowerCase() ? ' selected' : '');
                btn.dataset.color = c;
                btn.style.backgroundColor = c;
                btn.title = c;
                btn.addEventListener('click', () => {
                    colorInput.value = c;
                    paletteEl.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
                    btn.classList.add('selected');
                });
                paletteEl.appendChild(btn);
            });
        }
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
            notes: document.getElementById('editPointNotes').value.trim(),
            alwaysDisplayElevation: document.getElementById('editPointAlwaysDisplayElevation').checked
        });

        closeModal('editModal');
    });

    document.getElementById('editViewDetailsBtn').addEventListener('click', () => {
        const id = parseInt(document.getElementById('editPointId').value);
        closeModal('editModal');
        openPointDetailsModal(id);
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
        pushUndoSnapshot();

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
                    }, { skipUndoSnapshot: true });
                    imported++;
                } else {
                    failed++;
                }
            }
        }

        // Resolve other formats
        for (const line of otherLines) {
            try {
                const coords = await Converters.resolve(line, getW3WApiKey());
                if (coords) {
                    createPoint({
                        name: line,
                        lat: coords.lat,
                        lng: coords.lng,
                        originalInput: line
                    }, { skipUndoSnapshot: true });
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
        pushUndoSnapshot();

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
                    }, { skipUndoSnapshot: true });
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
                        coords = await Converters.resolve(loc, getW3WApiKey());
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
                    }, { skipUndoSnapshot: true });
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
            pushUndoSnapshot();

            // Apply settings
            if (project.settings) {
                Object.assign(settings, project.settings);
                saveSettingsToStorage();
                updateOsMapsLayers();
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
                    originalInput: p.originalInput || '',
                    alwaysDisplayElevation: !!p.alwaysDisplayElevation,
                    elevation: (typeof p.elevation === 'number' && !isNaN(p.elevation)) ? p.elevation : undefined
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
        document.getElementById('osMapsApiKey').value = settings.osMapsApiKey;
        const bgaUser = document.getElementById('bgaAirspaceUsername');
        const bgaPass = document.getElementById('bgaAirspacePassword');
        if (bgaUser) bgaUser.value = settings.bgaAirspaceUsername;
        if (bgaPass) bgaPass.value = settings.bgaAirspacePassword;
        document.getElementById('showLabels').checked = settings.showLabels;
        document.getElementById('showMeasurements').checked = settings.showMeasurements;
        document.getElementById('showShapeLabels').checked = settings.showShapeLabels;
        document.getElementById('showFlightPathDistance').checked = settings.showFlightPathDistance === true;
        openModal('settingsModal');
    });

    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
        settings.w3wApiKey = document.getElementById('w3wApiKey').value.trim();
        settings.osMapsApiKey = document.getElementById('osMapsApiKey').value.trim();
        const bgaUserEl = document.getElementById('bgaAirspaceUsername');
        const bgaPassEl = document.getElementById('bgaAirspacePassword');
        if (bgaUserEl) settings.bgaAirspaceUsername = bgaUserEl.value.trim();
        if (bgaPassEl) settings.bgaAirspacePassword = bgaPassEl.value.trim();
        settings.showLabels = document.getElementById('showLabels').checked;
        settings.showMeasurements = document.getElementById('showMeasurements').checked;
        settings.showShapeLabels = document.getElementById('showShapeLabels').checked;
        settings.showFlightPathDistance = document.getElementById('showFlightPathDistance').checked;
        saveSettingsToStorage();
        updateOsMapsLayers();
        applySettings();
        closeModal('settingsModal');
    });

    function applySettings() {
        // Refresh labels on all markers
        for (const point of points) {
            const layers = markerLayers[point.id];
            if (!layers) continue;

            const tooltipContent = getPointTooltipContent(point);
            if (tooltipContent) {
                layers.marker.unbindTooltip();
                layers.marker.bindTooltip(tooltipContent, {
                    permanent: true,
                    direction: 'top',
                    offset: [0, -35],
                    className: 'point-label-tooltip'
                });
            } else {
                layers.marker.unbindTooltip();
            }
        }

        // Toggle shape measurements
        Drawings.toggleMeasurements(settings.showMeasurements);
        Drawings.toggleShapeLabels(settings.showShapeLabels);
        Drawings.toggleFlightPathDistance(settings.showFlightPathDistance === true);
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
            if (dropPointMode || dropPointPickerOpen) {
                setDropPointMode(false);
                setDropPointPickerOpen(false);
                map.closePopup();
                return;
            }
            document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
        }
        if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
            const active = document.activeElement;
            const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
            if (!isInput && typeof UndoHistory !== 'undefined' && UndoHistory.undo()) {
                e.preventDefault();
                refreshHandToolState();
            }
        }
    });

    // ---- Drawings Integration ----

    // Init drawings after map is ready
    function initDrawings() {
        Drawings.init(map);

        // Undo history
        if (typeof UndoHistory !== 'undefined') {
            UndoHistory.init({
                getState: () => ({
                    points: points.map(p => ({ ...p })),
                    shapes: Drawings.serializeShapes(),
                    nextId,
                    nextShapeId: Math.max(0, ...(Drawings.getShapes().map(s => s.id) || [0])) + 1
                }),
                restoreState: (snapshot) => {
                    document.getElementById('shapeEditModal').classList.add('hidden');
                    restorePointsFromSnapshot(snapshot.points);
                    Drawings.loadShapes(snapshot.shapes || [], { preserveIds: true });
                    if (typeof UndoHistory !== 'undefined') UndoHistory.updateUndoButtonState();
                }
            });
            const undoBtn = document.getElementById('undoBtn');
            if (undoBtn) {
                undoBtn.addEventListener('click', () => {
                    if (UndoHistory.undo()) refreshHandToolState();
                });
                UndoHistory.updateUndoButtonState();
            }
        }

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

        // Text preset change - show/hide custom colour fields
        document.getElementById('editShapeTextPreset').addEventListener('change', (e) => {
            const preset = e.target.value;
            document.getElementById('editShapeTextColorGroup').classList.toggle('hidden', preset !== 'custom' && preset !== 'highlight');
            document.getElementById('editShapeTextBgGroup').classList.toggle('hidden', preset !== 'custom');
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
                pushUndoSnapshot();
                Drawings.clearAllShapes();
            }
        });

        initMapContextMenu();
    }

    // ---- Map Context Menu (right-click on empty map) ----

    let mapContextMenuLatLng = null;
    let mapContextShapeId = null;
    let mapContextPointId = null;

    function initMapContextMenu() {
        const menuEl = document.getElementById('mapContextMenu');
        if (!menuEl) return;

        // Capturing listener: handle right-click on text markers (divIcons / pm-textarea often don't propagate)
        map.getContainer().addEventListener('contextmenu', (e) => {
            const shapeIdEl = e.target.closest('[data-shape-id]');
            const markerIcon = e.target.closest('.leaflet-marker-icon');
            if (shapeIdEl) {
                const shapeId = parseInt(shapeIdEl.dataset.shapeId, 10);
                const shape = Drawings.getShapes().find(s => s.id === shapeId);
                if (shape && shape.type === 'text') {
                    e.preventDefault();
                    e.stopPropagation();
                    mapContextMenuLatLng = L.latLng(shape.position);
                    mapContextShapeId = shapeId;
                    mapContextPointId = null;
                    showMapContextMenu(e);
                    return;
                }
            }
            if (markerIcon && e.target.closest('.pm-textarea')) {
                for (const id in map._layers) {
                    const layer = map._layers[id];
                    if (layer._icon === markerIcon && layer._shapeId) {
                        const shape = Drawings.getShapes().find(s => s.id === layer._shapeId);
                        if (shape && shape.type === 'text') {
                            e.preventDefault();
                            e.stopPropagation();
                            mapContextMenuLatLng = L.latLng(shape.position);
                            mapContextShapeId = shape.id;
                            mapContextPointId = null;
                            showMapContextMenu(e);
                            return;
                        }
                        break;
                    }
                }
            }
        }, true);

        map.on('contextmenu', (e) => {
            if (e.originalEvent.target.closest('.leaflet-control')) return;
            e.originalEvent.preventDefault();
            e.originalEvent.stopPropagation();
            mapContextMenuLatLng = e.latlng;
            mapContextShapeId = e.originalEvent._contextShapeId || null;
            mapContextPointId = e.originalEvent._contextPointId || null;
            showMapContextMenu(e.originalEvent);
        });

        menuEl.addEventListener('click', (e) => {
            const item = e.target.closest('[data-action]');
            if (!item || item.disabled) return;
            const action = item.dataset.action;
            const latlng = mapContextMenuLatLng;
            const shapeId = mapContextShapeId;
            const pointId = mapContextPointId;
            hideMapContextMenu();
            handleMapContextAction(action, latlng, shapeId, pointId);
        });

        menuEl.addEventListener('contextmenu', (e) => e.preventDefault());

        document.addEventListener('mousedown', (e) => {
            if (menuEl && !menuEl.classList.contains('hidden') && !menuEl.contains(e.target)) {
                hideMapContextMenu();
            }
            const pickerEl = document.getElementById('mapPointTypePicker');
            if (pickerEl && !pickerEl.classList.contains('hidden') && !pickerEl.contains(e.target)) {
                hideMapPointTypePicker();
            }
        });

        document.addEventListener('touchstart', (e) => {
            if (menuEl && !menuEl.classList.contains('hidden') && !menuEl.contains(e.target)) {
                hideMapContextMenu();
            }
            const pickerEl = document.getElementById('mapPointTypePicker');
            if (pickerEl && !pickerEl.classList.contains('hidden') && !pickerEl.contains(e.target)) {
                hideMapPointTypePicker();
            }
        }, { passive: true });

        map.on('click', hideMapContextMenu);
        map.on('click', hideMapPointTypePicker);

        // Long-press (touch-hold) to open context menu on touch devices
        setupLongPressContextMenu();

        initMapPointTypePicker();
    }

    function setupLongPressContextMenu() {
        if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;

        const LONG_PRESS_MS = 500;
        const MOVE_THRESHOLD = 10;
        let lpTimer = null;
        let startX = 0;
        let startY = 0;
        let cancelled = false;

        const mapContainer = map.getContainer();

        mapContainer.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (e.target.closest('.leaflet-control')) return;
            if (e.target.closest('.mobile-draw-controls')) return;
            if (Drawings.isDrawingActive()) return;

            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            cancelled = false;

            lpTimer = setTimeout(() => {
                if (cancelled) return;
                const latlng = map.containerPointToLatLng(L.point(
                    startX - mapContainer.getBoundingClientRect().left,
                    startY - mapContainer.getBoundingClientRect().top
                ));

                mapContextMenuLatLng = latlng;
                mapContextShapeId = null;
                mapContextPointId = null;

                // Synthesize a fake event for positioning
                showMapContextMenu({ clientX: startX, clientY: startY, preventDefault() {}, stopPropagation() {} });
            }, LONG_PRESS_MS);
        }, { passive: true });

        mapContainer.addEventListener('touchmove', (e) => {
            if (!lpTimer) return;
            const touch = e.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
                clearTimeout(lpTimer);
                lpTimer = null;
                cancelled = true;
            }
        }, { passive: true });

        mapContainer.addEventListener('touchend', () => {
            if (lpTimer) {
                clearTimeout(lpTimer);
                lpTimer = null;
            }
        }, { passive: true });

        mapContainer.addEventListener('touchcancel', () => {
            if (lpTimer) {
                clearTimeout(lpTimer);
                lpTimer = null;
            }
            cancelled = true;
        }, { passive: true });
    }

    function showMapContextMenu(originalEvent) {
        const menuEl = document.getElementById('mapContextMenu');
        if (!menuEl) return;

        const pointSection = menuEl.querySelector('.ctx-point-section');
        if (pointSection) {
            pointSection.style.display = mapContextPointId ? '' : 'none';
        }

        const shapeInfo = mapContextShapeId ? Drawings.getShapeInfo(mapContextShapeId) : null;

        const shapeSection = menuEl.querySelector('.ctx-shape-section');
        if (shapeSection) {
            shapeSection.style.display = shapeInfo ? '' : 'none';
        }

        if (shapeInfo) {
            const isArrow = shapeInfo.type === 'arrow';
            const isText = shapeInfo.type === 'text';
            const isFlightPath = shapeInfo.type === 'flightpath';
            const isPolyline = shapeInfo.type === 'polyline';
            const editVertBtn = menuEl.querySelector('[data-action="edit-vertices"]');
            const moveBtn = menuEl.querySelector('[data-action="move-shape"]');
            const flightOverviewBtn = menuEl.querySelector('#ctxFlightOverview');
            if (editVertBtn) editVertBtn.style.display = (isText || isArrow) ? 'none' : '';
            if (moveBtn) moveBtn.style.display = isText ? 'none' : '';
            if (flightOverviewBtn) flightOverviewBtn.style.display = (isFlightPath || isPolyline) ? '' : 'none';
        }

        const pasteBtn = menuEl.querySelector('[data-action="paste"]');
        if (pasteBtn) {
            pasteBtn.disabled = !Drawings.hasClipboard();
            pasteBtn.title = Drawings.hasClipboard() ? 'Paste shape' : 'Copy a shape first (Ctrl+C)';
        }

        menuEl.classList.remove('hidden');
        const x = originalEvent.clientX;
        const y = originalEvent.clientY;
        const menuW = menuEl.offsetWidth;
        const menuH = menuEl.offsetHeight;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        menuEl.style.left = (x + menuW > winW ? winW - menuW - 4 : x) + 'px';
        menuEl.style.top = (y + menuH > winH ? winH - menuH - 4 : y) + 'px';
    }

    function hideMapContextMenu() {
        const menuEl = document.getElementById('mapContextMenu');
        if (menuEl) menuEl.classList.add('hidden');
        mapContextMenuLatLng = null;
        mapContextShapeId = null;
        mapContextPointId = null;
    }

    function initMapPointTypePicker() {
        const pickerEl = document.getElementById('mapPointTypePicker');
        const optionsEl = document.getElementById('mapPointTypePickerOptions');
        if (!pickerEl || !optionsEl) return;

        optionsEl.innerHTML = '';
        const iconKeys = ['address', 'primary_tola', 'secondary_tola', 'custom_tola', 'emergency_lz', 'no_fly', 'hazard', 'waypoint', 'custom_point', 'house', 'tola_house'];
        iconKeys.forEach(key => {
            const def = ICON_DEFS[key];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ctx-type-btn';
            btn.dataset.iconType = key;
            if (def.svgContent) {
                const dataUri = svgToDataUri(def.svgContent, def.color);
                btn.innerHTML = `<span class="ctx-type-symbol ctx-type-svg"><img src="${dataUri}" alt="" width="18" height="18"></span><span>${escapeHtml(def.label)}</span>`;
            } else {
                btn.innerHTML = `<span class="ctx-type-symbol" style="background:${def.color}; color:${getContrastingTextColor(def.color)}">${escapeHtml(def.symbol)}</span><span>${escapeHtml(def.label)}</span>`;
            }
            btn.addEventListener('click', () => {
                const latlng = mapPointTypePickerLatLng;
                hideMapPointTypePicker();
                if (latlng) createPointAtLatLngWithType(latlng.lat, latlng.lng, key);
            });
            optionsEl.appendChild(btn);
        });
    }

    let mapPointTypePickerLatLng = null;

    function showMapPointTypePicker(latlng, menuX, menuY) {
        const pickerEl = document.getElementById('mapPointTypePicker');
        if (!pickerEl) return;
        mapPointTypePickerLatLng = latlng;
        pickerEl.classList.remove('hidden');
        const menuW = pickerEl.offsetWidth;
        const menuH = pickerEl.offsetHeight;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        pickerEl.style.left = (menuX + menuW > winW ? winW - menuW - 4 : menuX) + 'px';
        pickerEl.style.top = (menuY + menuH > winH ? winH - menuH - 4 : menuY) + 'px';
    }

    function hideMapPointTypePicker() {
        const pickerEl = document.getElementById('mapPointTypePicker');
        if (pickerEl) pickerEl.classList.add('hidden');
        mapPointTypePickerLatLng = null;
    }

    function createPointAtLatLngWithType(lat, lng, iconType) {
        const type = normalizeIconType(iconType);
        const def = ICON_DEFS[type];
        lastDropIconType = type;
        lastDropIconColor = (def.useColorPalette ? def.color : (def.colorEditable ? lastDropIconColor : def.color));
        createPointAtLatLng(lat, lng);
    }

    function handleMapContextAction(action, latlng, shapeId, pointId) {
        switch (action) {
            case 'point-details':
                if (pointId) openPointDetailsModal(pointId);
                break;
            case 'edit-point':
                if (pointId) openEditModal(pointId);
                break;
            case 'delete-point':
                if (pointId) {
                    const point = points.find(p => p.id === pointId);
                    if (point && confirm(`Delete "${point.name || 'Unnamed'}"?`)) {
                        deletePoint(pointId);
                    }
                }
                break;
            case 'edit-shape':
                if (shapeId) Drawings.openShapeEditModal(shapeId);
                break;
            case 'flight-overview':
                if (shapeId) openFlightOverviewModal(shapeId);
                break;
            case 'edit-vertices':
                if (shapeId) Drawings.editVertices(shapeId);
                break;
            case 'move-shape':
                if (shapeId) Drawings.moveShape(shapeId);
                break;
            case 'copy-shape':
                if (shapeId) Drawings.copyShape(shapeId);
                break;
            case 'delete-shape':
                if (shapeId) Drawings.removeShape(shapeId);
                break;
            case 'drop-point':
                if (latlng) {
                    const menuEl = document.getElementById('mapContextMenu');
                    const menuX = menuEl ? parseInt(menuEl.style.left, 10) || 0 : 0;
                    const menuY = menuEl ? parseInt(menuEl.style.top, 10) || 0 : 0;
                    showMapPointTypePicker(latlng, menuX, menuY);
                }
                break;
            case 'add-text':
                Drawings.enableDrawMode('Text');
                break;
            case 'draw-circle':
                Drawings.enableDrawMode('Circle');
                break;
            case 'draw-rectangle':
                Drawings.enableDrawMode('Rectangle');
                break;
            case 'draw-polygon':
                Drawings.enableDrawMode('Polygon');
                break;
            case 'draw-line':
                if (latlng) {
                    Drawings.enableLineDrawAt(latlng);
                } else {
                    Drawings.enableDrawMode('Line');
                }
                break;
            case 'draw-arrow':
                if (latlng) {
                    Drawings.enableArrowDrawAt(latlng);
                } else {
                    Drawings.enableDrawMode('Arrow');
                }
                break;
            case 'draw-flightpath':
                Drawings.enableDrawMode('FlightPath');
                break;
            case 'paste':
                Drawings.pasteShape(latlng);
                break;
            case 'return-to-pan':
                setDropPointMode(false);
                setDropPointPickerOpen(false);
                Drawings.exitAllDrawingModes();
                refreshHandToolState();
                break;
        }
    }

    // ---- Initialise ----

    // Defer init until load so layout is stable and map container has final dimensions
    window.addEventListener('load', () => {
        const introOverlay = document.getElementById('introOverlay');
        const introProceedBtn = document.getElementById('introProceedBtn');

        function dismissIntro() {
            if (introOverlay) introOverlay.classList.add('hidden');
            initMap();
            initDrawings();
            map.on('drawingmodechange', refreshHandToolState);
            // Defer toolbar setup to ensure Geoman has fully rendered
            requestAnimationFrame(() => {
                initDropPointToolbarControl();
                initPointDetailsModal();
                initSearchModal();
                refreshHandToolState();
                if (typeof UndoHistory !== 'undefined') UndoHistory.updateUndoButtonState();
            });
        }

        if (introProceedBtn) {
            introProceedBtn.addEventListener('click', dismissIntro);
        } else {
            dismissIntro();
        }

        const introHelpBtn = document.getElementById('introHelpBtn');
        if (introHelpBtn) {
            introHelpBtn.addEventListener('click', () => openModal('helpModal'));
        }

        const introFlightPlanBtn = document.getElementById('introFlightPlanBtn');
        if (introFlightPlanBtn) {
            introFlightPlanBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const target = introFlightPlanBtn.getAttribute('href') || 'flight-planning.html';
                window.location.assign(target);
            }, true);
        }
    });

})();
