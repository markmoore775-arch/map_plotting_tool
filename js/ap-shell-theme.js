/**
 * Planner / Weather / Airspace header theme: same storage and body class as Flight Report.
 */
(function () {
    'use strict';

    function pageThemeIsLight() {
        return document.body.classList.contains('fn-light-theme');
    }

    function syncFnThemeToggleButton() {
        var btn = document.getElementById('fnThemeToggle');
        if (!btn) return;
        var light = pageThemeIsLight();
        btn.setAttribute('aria-pressed', light ? 'true' : 'false');
        var label = light ? 'Switch to dark theme' : 'Switch to light theme';
        btn.setAttribute('aria-label', label);
        btn.title = label;
        var moon = btn.querySelector('.fn-theme-toggle-icon--moon');
        var sun = btn.querySelector('.fn-theme-toggle-icon--sun');
        if (moon && sun) {
            moon.classList.toggle('hidden', light);
            sun.classList.toggle('hidden', !light);
        }
    }

    function applyFnPageTheme(light) {
        document.body.classList.toggle('fn-light-theme', !!light);
        try {
            localStorage.setItem('fnLightTheme', light ? '1' : '0');
        } catch (e) {}
        syncFnThemeToggleButton();
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
