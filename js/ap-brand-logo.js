/**
 * Swap .ap-brand-logo src between white (dark UI) and black (light theme) PNGs.
 * Intro/splash logos stay white on the dark welcome gradient.
 */
(function () {
    'use strict';

    var LOGO_DARK_UI = 'assets/airplanlogowhite.png';
    var LOGO_LIGHT_UI = 'assets/airplanlogoblack.png';

    function pageThemeIsLight() {
        return document.body.classList.contains('fn-light-theme') ||
            document.body.classList.contains('cl-light-theme');
    }

    function syncApBrandLogos(forceLight) {
        var light = forceLight != null ? !!forceLight : pageThemeIsLight();
        var src = light ? LOGO_LIGHT_UI : LOGO_DARK_UI;
        document.querySelectorAll('.ap-brand-logo').forEach(function (img) {
            if (img.classList.contains('intro-logo') || img.classList.contains('intro-splash-logo')) {
                return;
            }
            if (img.getAttribute('src') !== src) {
                img.setAttribute('src', src);
            }
        });
    }

    window.syncApBrandLogos = syncApBrandLogos;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            syncApBrandLogos();
        });
    } else {
        syncApBrandLogos();
    }
})();
