/* ============================================
   ADS-B EXCHANGE EMBED — zoom / geolocation
   Recentres iframe via globe URL lat, lon, zoom
   (same placement pattern as Leaflet on airspace/weather)
   ============================================ */

(function () {
    'use strict';

    const ZOOM_MIN = 2;
    const ZOOM_MAX = 18;
    const LOCATE_ZOOM = 12;

    const frame = document.getElementById('adsbxFrame');
    const zoomInBtn = document.getElementById('adsbxZoomIn');
    const zoomOutBtn = document.getElementById('adsbxZoomOut');
    const locateBtn = document.getElementById('adsbxLocate');
    const statusEl = document.getElementById('adsbxMapStatus');

    if (!frame) return;

    let lat = 51.5074;
    let lon = -0.1278;
    let zoom = 10;

    let statusClearTimer = null;

    function setStatus(msg, isError) {
        if (!statusEl) return;
        if (statusClearTimer) {
            clearTimeout(statusClearTimer);
            statusClearTimer = null;
        }
        statusEl.textContent = msg || '';
        statusEl.classList.toggle('adsbx-map-status--error', !!isError);
        if (msg) {
            statusClearTimer = setTimeout(function () {
                statusEl.textContent = '';
                statusEl.classList.remove('adsbx-map-status--error');
            }, 5000);
        }
    }

    function buildSrc() {
        return (
            'https://globe.adsbexchange.com/?kiosk&hideSidebar' +
            '&lat=' +
            encodeURIComponent(lat.toFixed(6)) +
            '&lon=' +
            encodeURIComponent(lon.toFixed(6)) +
            '&zoom=' +
            encodeURIComponent(String(zoom))
        );
    }

    function applyView() {
        frame.src = buildSrc();
        if (zoomInBtn) zoomInBtn.disabled = zoom >= ZOOM_MAX;
        if (zoomOutBtn) zoomOutBtn.disabled = zoom <= ZOOM_MIN;
    }

    function onZoomIn() {
        if (zoom < ZOOM_MAX) {
            zoom += 1;
            applyView();
        }
    }

    function onZoomOut() {
        if (zoom > ZOOM_MIN) {
            zoom -= 1;
            applyView();
        }
    }

    function onLocate() {
        var blocked =
            typeof GeoLocate !== 'undefined' && GeoLocate.secureContextBlockedMessage
                ? GeoLocate.secureContextBlockedMessage()
                : null;
        if (blocked) {
            setStatus(blocked, true);
            return;
        }
        if (!navigator.geolocation) {
            setStatus('Location is not available in this browser.', true);
            return;
        }
        setStatus('Getting your location…', false);
        locateBtn.disabled = true;

        function onOk(pos) {
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
            zoom = LOCATE_ZOOM;
            applyView();
            setStatus('', false);
            locateBtn.disabled = false;
        }
        function onFail(err) {
            var msg =
                typeof GeoLocate !== 'undefined' && GeoLocate.geolocationErrorMessage
                    ? GeoLocate.geolocationErrorMessage(err)
                    : 'Could not get your location. Allow access when prompted, or use HTTPS / localhost.';
            setStatus(msg, true);
            locateBtn.disabled = false;
        }

        if (typeof GeoLocate !== 'undefined' && GeoLocate.getCurrentPositionRobust) {
            GeoLocate.getCurrentPositionRobust(onOk, onFail);
        } else {
            navigator.geolocation.getCurrentPosition(
                onOk,
                onFail,
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
            );
        }
    }

    if (zoomInBtn) zoomInBtn.addEventListener('click', onZoomIn);
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', onZoomOut);
    if (locateBtn) locateBtn.addEventListener('click', onLocate);

    applyView();
})();
