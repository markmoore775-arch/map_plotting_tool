/**
 * Knowledge page theme: same storage key and body class as Flight Report (fnLightTheme / fn-light-theme).
 */
(function () {
    'use strict';

    function syncPageThemeFromRadios() {
        var el = document.querySelector('input[name="fnPageTheme"]:checked');
        var light = !!(el && el.value === 'light');
        document.body.classList.toggle('fn-light-theme', light);
        try {
            localStorage.setItem('fnLightTheme', light ? '1' : '0');
        } catch (e) {}
    }

    function init() {
        var pageThemeInputs = document.querySelectorAll('input[name="fnPageTheme"]');
        if (!pageThemeInputs.length) return;

        try {
            if (localStorage.getItem('fnLightTheme') === '1') {
                var rLight = document.querySelector('input[name="fnPageTheme"][value="light"]');
                if (rLight) rLight.checked = true;
            } else {
                var rDark = document.querySelector('input[name="fnPageTheme"][value="dark"]');
                if (rDark) rDark.checked = true;
            }
        } catch (e) {}

        syncPageThemeFromRadios();
        pageThemeInputs.forEach(function (inp) {
            inp.addEventListener('change', syncPageThemeFromRadios);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
