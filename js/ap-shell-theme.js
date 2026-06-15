/**
 * Planner / Weather / Airspace header theme: same storage and body class as Flight Report.
 */
(function () {
    'use strict';

    function pageThemeIsLight() {
        return document.body.classList.contains('fn-light-theme');
    }

    function syncFnThemeToggleButton() {
        var light = pageThemeIsLight();
        var label = light ? 'Switch to dark theme' : 'Switch to light theme';
        var ids = ['fnThemeToggle', 'helpModalThemeToggle'];
        for (var i = 0; i < ids.length; i++) {
            var btn = document.getElementById(ids[i]);
            if (!btn) continue;
            btn.setAttribute('aria-pressed', light ? 'true' : 'false');
            btn.setAttribute('aria-label', label);
            if (ids[i] === 'fnThemeToggle') {
                btn.title = label;
            }
            var moon = btn.querySelector('.fn-theme-toggle-icon--moon');
            var sun = btn.querySelector('.fn-theme-toggle-icon--sun');
            if (moon && sun) {
                moon.classList.toggle('hidden', light);
                sun.classList.toggle('hidden', !light);
            }
        }
        var helpModalEl = document.getElementById('helpModal');
        if (helpModalEl) {
            helpModalEl.classList.toggle('help-modal--light', light);
        }
    }

    function applyFnPageTheme(light) {
        document.body.classList.toggle('fn-light-theme', !!light);
        try {
            localStorage.setItem('fnLightTheme', light ? '1' : '0');
        } catch (e) {}
        syncFnThemeToggleButton();
        if (typeof window.syncApBrandLogos === 'function') {
            window.syncApBrandLogos(!!light);
        }
    }

    function init() {
        var fnThemeBtn = document.getElementById('fnThemeToggle');
        if (!fnThemeBtn) return;
        try {
            applyFnPageTheme(localStorage.getItem('fnLightTheme') === '1');
        } catch (e) {
            applyFnPageTheme(false);
        }
        fnThemeBtn.addEventListener('click', function () {
            applyFnPageTheme(!pageThemeIsLight());
        });
        var helpThemeBtn = document.getElementById('helpModalThemeToggle');
        if (helpThemeBtn) {
            helpThemeBtn.addEventListener('click', function () {
                applyFnPageTheme(!pageThemeIsLight());
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
