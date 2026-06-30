/**
 * Swap .ap-brand-logo src between white (dark UI) and black (light theme) PNGs.
 * Intro/splash logos stay white on the dark welcome gradient.
 */
(function () {
    'use strict';

    var LOGO_DARK_UI = 'assets/airplanlogowhite.png';
    var LOGO_LIGHT_UI = 'assets/airplanlogoblack.png';
    var HOME_LOGO_DARK_UI = 'assets/airplanlogowhite-notext.png';
    var HOME_LOGO_LIGHT_UI = 'assets/airplanlogoblack-notext.png';

    function pageThemeIsLight() {
        return document.body.classList.contains('fn-light-theme') ||
            document.body.classList.contains('cl-light-theme');
    }

    function syncApBrandLogos(forceLight) {
        var light = forceLight != null ? !!forceLight : pageThemeIsLight();
        var src = light ? LOGO_LIGHT_UI : LOGO_DARK_UI;
        var homeSrc = light ? HOME_LOGO_LIGHT_UI : HOME_LOGO_DARK_UI;
        document.querySelectorAll('.ap-brand-logo').forEach(function (img) {
            if (img.classList.contains('intro-logo') || img.classList.contains('intro-splash-logo')) {
                return;
            }
            var nextSrc = img.classList.contains('fp-welcome-logo') ? homeSrc : src;
            if (img.getAttribute('src') !== nextSrc) {
                img.setAttribute('src', nextSrc);
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
