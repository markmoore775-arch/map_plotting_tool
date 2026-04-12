/**
 * Shared geolocation helpers: secure-context checks, Safari/iOS-friendly options,
 * and high-accuracy → network/cached fallback for getCurrentPosition.
 * iOS home-screen (standalone) WebKit often breaks geolocation; we detect that
 * case and prompt with copy-link instructions (links from standalone often stay in-app).
 */
(function (global) {
    'use strict';

    function syncGeolocateIosStandaloneModalTheme(root) {
        if (!root || typeof document === 'undefined' || !document.body) return;
        var light = document.body.classList.contains('fn-light-theme');
        root.classList.toggle('geolocate-ios-standalone-modal--light', light);
    }

    function copyTextToClipboard(text, onDone, onFail) {
        function ok() {
            if (onDone) onDone();
        }
        function fail() {
            if (onFail) onFail();
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard
                .writeText(text)
                .then(ok)
                .catch(function () {
                    legacyCopy();
                });
            return;
        }
        legacyCopy();

        function legacyCopy() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                ta.style.top = '0';
                document.body.appendChild(ta);
                ta.select();
                ta.setSelectionRange(0, text.length);
                var copied = document.execCommand('copy');
                document.body.removeChild(ta);
                if (copied) ok();
                else fail();
            } catch (e) {
                fail();
            }
        }
    }

    function secureContextBlockedMessage() {
        if (typeof global.isSecureContext === 'boolean' && !global.isSecureContext) {
            return 'Location needs a secure page. Open this site with HTTPS (or localhost), not plain HTTP.';
        }
        return null;
    }

    function isGeolocationEnvironmentOk() {
        return !secureContextBlockedMessage() && !!navigator.geolocation;
    }

    /**
     * True for iPhone / iPad / iPod class devices (excludes Android and desktop).
     */
    function isIosLikeAppleDevice() {
        var ua = navigator.userAgent || '';
        if (/Android/i.test(ua)) return false;
        if (/iPhone|iPod|iPad/i.test(ua)) return true;
        if (navigator.platform === 'iPad') return true;
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 0) return true;
        return false;
    }

    /**
     * Add to Home Screen on iOS (navigator.standalone or display-mode: standalone).
     * Deliberately false on Android installed PWAs so we do not show this prompt there.
     */
    function isIosStandaloneWebApp() {
        if (!isIosLikeAppleDevice()) return false;
        var standaloneLegacy = typeof navigator.standalone === 'boolean' && navigator.standalone === true;
        var standaloneDisplay = false;
        try {
            standaloneDisplay =
                typeof global.matchMedia === 'function' &&
                global.matchMedia('(display-mode: standalone)').matches;
        } catch (e) {
            standaloneDisplay = false;
        }
        return standaloneLegacy || standaloneDisplay;
    }

    /**
     * Modal: WebKit standalone limitation (Apple), not the site; copy URL and open in a real browser.
     */
    function showIosStandaloneOpenInBrowserPrompt() {
        if (typeof document === 'undefined') return;

        var copyFeedbackTimer = null;

        var root = document.getElementById('geolocateIosStandaloneModal');
        if (!root) {
            root = document.createElement('div');
            root.id = 'geolocateIosStandaloneModal';
            root.className = 'modal hidden';
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-labelledby', 'geolocateIosStandaloneTitle');
            root.innerHTML =
                '<div class="modal-backdrop"></div>' +
                '<div class="modal-content">' +
                '<div class="modal-header">' +
                '<h2 id="geolocateIosStandaloneTitle">Use a browser for location</h2>' +
                '<button type="button" class="modal-close" aria-label="Close">&times;</button>' +
                '</div>' +
                '<div class="modal-body">' +
                '<p><strong>This is a limitation in Apple&rsquo;s iOS WebKit</strong> when a site runs from the home screen icon (standalone mode): GPS and &ldquo;show my location&rdquo; often fail or never complete. <strong>It is not an AirPlot bug.</strong></p>' +
                '<p><strong>What to do:</strong> copy the address below, open <strong>Safari</strong>, <strong>Chrome</strong>, or another browser you prefer, paste it into the address bar, then load the page and use location there.</p>' +
                '<p class="geolocate-ios-standalone-url-label">Page address</p>' +
                '<div class="geolocate-ios-standalone-url-box">' +
                '<a class="geolocate-ios-standalone-url" href="#" target="_blank" rel="noopener noreferrer"></a>' +
                '</div>' +
                '<p class="geolocate-ios-standalone-tap-hint">Tapping the link may stay inside this home-screen app; if it does, use <strong>Copy link</strong> instead.</p>' +
                '</div>' +
                '<div class="modal-footer geolocate-ios-standalone-footer">' +
                '<span class="geolocate-ios-standalone-copied hidden" id="geolocateIosStandaloneCopyFeedback" role="status" aria-live="polite">Copied</span>' +
                '<button type="button" class="btn btn-primary" id="geolocateIosStandaloneCopy">Copy link</button>' +
                '<button type="button" class="btn btn-secondary" id="geolocateIosStandaloneDismiss">OK</button>' +
                '</div>' +
                '</div>';
            document.body.appendChild(root);

            var copyBtnInit = document.getElementById('geolocateIosStandaloneCopy');
            if (copyBtnInit) {
                copyBtnInit.addEventListener('click', function () {
                    var url = '';
                    try {
                        url = global.location.href || '';
                    } catch (e) {
                        url = '';
                    }
                    var feedback = document.getElementById('geolocateIosStandaloneCopyFeedback');
                    function showCopied() {
                        if (feedback) {
                            feedback.classList.remove('hidden');
                            feedback.textContent = 'Copied';
                        }
                        if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
                        copyFeedbackTimer = setTimeout(function () {
                            if (feedback) feedback.classList.add('hidden');
                            copyFeedbackTimer = null;
                        }, 2500);
                    }
                    function showFailed() {
                        if (feedback) {
                            feedback.classList.remove('hidden');
                            feedback.textContent = 'Could not copy - select the link above and copy manually';
                        }
                        if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
                        copyFeedbackTimer = setTimeout(function () {
                            if (feedback) feedback.classList.add('hidden');
                            copyFeedbackTimer = null;
                        }, 5000);
                    }
                    copyTextToClipboard(url, showCopied, showFailed);
                });
            }
        }

        if (!root.classList.contains('hidden')) return;

        var pageUrl = '';
        try {
            pageUrl = global.location.href || '';
        } catch (e) {
            pageUrl = '';
        }

        var urlLink = root.querySelector('.geolocate-ios-standalone-url');
        if (urlLink) {
            urlLink.href = pageUrl || '#';
            urlLink.textContent = pageUrl || '(address unavailable)';
        }

        syncGeolocateIosStandaloneModalTheme(root);

        var feedbackEl = document.getElementById('geolocateIosStandaloneCopyFeedback');
        if (feedbackEl) {
            feedbackEl.classList.add('hidden');
            feedbackEl.textContent = 'Copied';
        }

        root.classList.remove('hidden');

        var backdrop = root.querySelector('.modal-backdrop');
        var closeBtn = root.querySelector('.modal-close');
        var dismissBtn = document.getElementById('geolocateIosStandaloneDismiss');
        var copyBtn = document.getElementById('geolocateIosStandaloneCopy');

        function finish() {
            root.classList.add('hidden');
            document.removeEventListener('keydown', onKey);
            if (backdrop) backdrop.removeEventListener('click', onBackdrop);
        }

        function onBackdrop() {
            finish();
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish();
            }
        }

        if (backdrop) backdrop.addEventListener('click', onBackdrop);
        if (closeBtn) {
            closeBtn.onclick = function () {
                finish();
            };
        }
        if (dismissBtn) {
            dismissBtn.onclick = function () {
                finish();
            };
        }
        document.addEventListener('keydown', onKey);
        if (copyBtn) copyBtn.focus();
        else if (dismissBtn) dismissBtn.focus();
    }

    /**
     * WebKit / iOS-style environments: avoid high-accuracy-first and rely on gentle getCurrentPosition.
     * iPad “desktop” UA is often Macintosh + touch (maxTouchPoints can be 1 - treat MacIntel + any touch as iPad-class).
     * All iOS store browsers use CriOS, FxiOS, EdgiOS, etc.; match those even when “iPad” is absent from UA.
     */
    function prefersGentleGeoOptions() {
        var ua = navigator.userAgent || '';
        if (/iPad|iPhone|iPod|iPadOS/i.test(ua)) return true;
        if (/FxiOS|CriOS|EdgiOS/i.test(ua)) return true;
        if (navigator.platform === 'iPad') return true;
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 0) return true;
        if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPR|Brave/i.test(ua)) return true;
        return false;
    }

    /**
     * Safari on iOS/iPad often never settles navigator.permissions.query({ name: 'geolocation' }),
     * so awaiting it before getCurrentPosition means we never start the real request (Chrome iOS
     * resolves the query - CriOS / FxiOS / EdgiOS). Skip the probe and call geolocation directly.
     */
    function skipPermissionsQueryBeforeGeolocation() {
        var ua = navigator.userAgent || '';
        if (/CriOS|FxiOS|EdgiOS/i.test(ua)) return false;
        if (/iPad|iPhone|iPod|iPadOS/i.test(ua)) return true;
        if (navigator.platform === 'iPad') return true;
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 0) return true;
        return false;
    }

    /**
     * Options passed to Leaflet.Locate / L.Map.locate.
     * leaflet-locatecontrol defaults to watch: true (watchPosition). On WebKit / iOS,
     * watchPosition often never invokes success or error, so the locate button spins
     * forever; the plugin also ignores timeouts while watch is true. Force watch: false
     * so Leaflet uses getCurrentPosition, which behaves reliably after the user grants
     * permission (live “follow” updates are traded off on those platforms).
     */
    function leafletLocateOptions() {
        if (prefersGentleGeoOptions()) {
            return {
                enableHighAccuracy: false,
                timeout: 20000,
                maximumAge: 60000,
                watch: false
            };
        }
        return {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        };
    }

    function geolocationErrorMessage(err) {
        if (!err) return 'Could not get location.';
        if (err.code === 1) {
            return 'Location permission denied. Allow access when prompted, or enable Location for Safari in Settings.';
        }
        if (err.code === 2) {
            return 'Location unavailable. Try outdoors, turn on Precise Location for this site, or use Wi‑Fi.';
        }
        if (err.code === 3) {
            return 'Location request timed out. Try again or move to improve GPS.';
        }
        if (err.message && typeof err.code === 'number' && err.code === 0) {
            return err.message;
        }
        return 'Could not get location.';
    }

    /**
     * Try GPS/high accuracy first on desktop-style browsers; on timeout or position unavailable,
     * retry with network / cached fix.
     * On WebKit / iOS / iPad (prefersGentleGeoOptions), skip the high-accuracy pass entirely:
     * the first getCurrentPosition with enableHighAccuracy true often never invokes success or
     * error, so callers like Flight Report’s “Use current GPS” appear to hang forever.
     * @param {PositionCallback} onSuccess
     * @param {PositionErrorCallback} [onError]
     * @param {{ highTimeout?: number, lowTimeout?: number, lowMaximumAge?: number, watchdogMs?: number }} [opts]
     */
    function getCurrentPositionRobust(onSuccess, onError, opts) {
        opts = opts || {};
        var blocked = secureContextBlockedMessage();
        if (blocked) {
            if (onError) {
                onError({ code: 0, message: blocked });
            }
            return;
        }
        if (!navigator.geolocation) {
            if (onError) {
                onError({ code: 0, message: 'Geolocation is not available in this browser.' });
            }
            return;
        }

        if (isIosStandaloneWebApp()) {
            showIosStandaloneOpenInBrowserPrompt();
            if (onError) {
                onError({ code: 0, message: '', handledByIosStandalonePrompt: true });
            }
            return;
        }

        var gentle = prefersGentleGeoOptions();
        var settled = false;
        var watchdogId = null;

        function clearWatchdog() {
            if (watchdogId !== null) {
                clearTimeout(watchdogId);
                watchdogId = null;
            }
        }

        function wrapOk(pos) {
            if (settled) return;
            settled = true;
            clearWatchdog();
            onSuccess(pos);
        }

        function wrapErr(err) {
            if (settled) return;
            settled = true;
            clearWatchdog();
            if (onError) {
                onError(err);
            }
        }

        function stallMessage() {
            var standaloneDisplay = false;
            try {
                standaloneDisplay =
                    typeof global.matchMedia === 'function' &&
                    global.matchMedia('(display-mode: standalone)').matches;
            } catch (e) {
                standaloneDisplay = false;
            }
            var fromHomeScreen =
                typeof navigator !== 'undefined' &&
                (navigator.standalone === true || standaloneDisplay);
            var base =
                'Location did not respond (Safari on iPad sometimes never finishes the GPS request). ';
            var settings =
                'Check Settings → Privacy & Security → Location Services → Safari Websites, and allow location for this site. ';
            var alt = 'You can use Search location instead of GPS.';
            if (fromHomeScreen) {
                return (
                    base +
                    'Apple’s iOS WebKit often breaks geolocation for home-screen web apps (standalone mode) - not an AirPlot bug. Open this page in Safari or Chrome instead. ' +
                    settings +
                    alt
                );
            }
            return base + settings + alt;
        }

        function startWatchdogAndRequests() {
            var watchdogMs =
                opts.watchdogMs != null
                    ? opts.watchdogMs
                    : gentle
                      ? 52000
                      : 42000;
            watchdogId = setTimeout(function () {
                if (settled) return;
                settled = true;
                watchdogId = null;
                if (onError) {
                    onError({ code: 0, message: stallMessage() });
                }
            }, watchdogMs);

            var lowAcc = {
                enableHighAccuracy: false,
                timeout: opts.lowTimeout != null ? opts.lowTimeout : gentle ? 15000 : 25000,
                maximumAge: opts.lowMaximumAge != null ? opts.lowMaximumAge : 120000
            };

            if (gentle) {
                navigator.geolocation.getCurrentPosition(
                    wrapOk,
                    function (err) {
                        if (err && (err.code === 2 || err.code === 3)) {
                            navigator.geolocation.getCurrentPosition(
                                wrapOk,
                                function (err2) {
                                    wrapErr(err2);
                                },
                                {
                                    enableHighAccuracy: false,
                                    timeout: 25000,
                                    maximumAge: 300000
                                }
                            );
                        } else {
                            wrapErr(err);
                        }
                    },
                    lowAcc
                );
                return;
            }

            var highAcc = {
                enableHighAccuracy: true,
                timeout: opts.highTimeout != null ? opts.highTimeout : 12000,
                maximumAge: 0
            };

            navigator.geolocation.getCurrentPosition(
                wrapOk,
                function (err) {
                    if (err && (err.code === 2 || err.code === 3)) {
                        navigator.geolocation.getCurrentPosition(
                            wrapOk,
                            function (err2) {
                                wrapErr(err2);
                            },
                            lowAcc
                        );
                    } else {
                        wrapErr(err);
                    }
                },
                highAcc
            );
        }

        if (
            skipPermissionsQueryBeforeGeolocation() ||
            !navigator.permissions ||
            typeof navigator.permissions.query !== 'function'
        ) {
            startWatchdogAndRequests();
        } else {
            navigator.permissions
                .query({ name: 'geolocation' })
                .then(function (result) {
                    if (result.state === 'denied') {
                        if (onError) {
                            onError({ code: 1, message: 'Location permission denied.' });
                        }
                        return;
                    }
                    startWatchdogAndRequests();
                })
                .catch(function () {
                    startWatchdogAndRequests();
                });
        }
    }

    global.GeoLocate = {
        secureContextBlockedMessage: secureContextBlockedMessage,
        isGeolocationEnvironmentOk: isGeolocationEnvironmentOk,
        isIosStandaloneWebApp: isIosStandaloneWebApp,
        showIosStandaloneOpenInBrowserPrompt: showIosStandaloneOpenInBrowserPrompt,
        prefersGentleGeoOptions: prefersGentleGeoOptions,
        leafletLocateOptions: leafletLocateOptions,
        getCurrentPositionRobust: getCurrentPositionRobust,
        geolocationErrorMessage: geolocationErrorMessage
    };

    /** Leaflet.Locate calls map.locate() directly; intercept on iOS standalone only. */
    (function patchLeafletLocateForIosStandalone() {
        if (typeof L === 'undefined' || !L.Control || !L.Control.Locate) return;
        var proto = L.Control.Locate.prototype;
        if (proto._airplotActivateOriginal) return;
        proto._airplotActivateOriginal = proto._activate;
        proto._activate = function () {
            if (
                typeof GeoLocate !== 'undefined' &&
                GeoLocate.isIosStandaloneWebApp &&
                GeoLocate.isIosStandaloneWebApp()
            ) {
                GeoLocate.showIosStandaloneOpenInBrowserPrompt();
                return;
            }
            return proto._airplotActivateOriginal.call(this);
        };
    })();
})(typeof window !== 'undefined' ? window : this);
