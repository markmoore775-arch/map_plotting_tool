/**
 * Shared geolocation helpers: secure-context checks, Safari/iOS-friendly options,
 * and high-accuracy → network/cached fallback for getCurrentPosition.
 * iOS home-screen (standalone) WebKit often breaks geolocation; we try GPS first
 * and only then prompt with copy-link instructions (links from standalone often stay in-app).
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

    function isIosHomeScreenDisplayMode() {
        try {
            if (typeof global.matchMedia !== 'function') return false;
            return (
                global.matchMedia('(display-mode: standalone)').matches ||
                global.matchMedia('(display-mode: fullscreen)').matches ||
                global.matchMedia('(display-mode: minimal-ui)').matches
            );
        } catch (e) {
            return false;
        }
    }

    /**
     * Add to Home Screen on iOS (navigator.standalone or display-mode standalone/fullscreen/minimal-ui).
     * Deliberately false on Android installed PWAs so we do not show this prompt there.
     */
    function isIosStandaloneWebApp() {
        if (!isIosLikeAppleDevice()) return false;
        var standaloneLegacy = typeof navigator.standalone === 'boolean' && navigator.standalone === true;
        return standaloneLegacy || isIosHomeScreenDisplayMode();
    }

    /**
     * iOS WebKit often denies or hangs getCurrentPosition unless it follows a tap.
     * Weather / Airspace / Radar must not auto-locate on load on these devices.
     */
    function shouldSkipAutomaticGeolocation() {
        return isIosLikeAppleDevice();
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
                '<p><strong>This is a limitation in Apple&rsquo;s iOS WebKit</strong> when a site runs from the home screen icon (standalone mode): GPS and &ldquo;show my location&rdquo; often fail or never complete. <strong>It is not an AirPlan bug.</strong></p>' +
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
     * After a failed GPS attempt in a home-screen web app, offer the open-in-browser path.
     * Permission denials stay as permission errors (user can still grant in Settings).
     */
    function maybePromptIosStandaloneOnFailure(err) {
        if (!isIosStandaloneWebApp()) return false;
        if (err && err.code === 1) return false;
        showIosStandaloneOpenInBrowserPrompt();
        return true;
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
     * Safari / iOS WebKit (including Chrome/Firefox/Edge on iOS) often never settles
     * navigator.permissions.query({ name: 'geolocation' }), so awaiting it before
     * getCurrentPosition means we never start the real request.
     */
    function skipPermissionsQueryBeforeGeolocation() {
        return prefersGentleGeoOptions();
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

    function defaultLocateOnLocationError(err) {
        if (err && err.handledByIosStandalonePrompt) return;
        var msg = err && err.message ? String(err.message) : '';
        msg = msg.replace(/^Geolocation error:\s*/i, '').replace(/\.\s*$/, '');
        if (!msg) return;
        alert(msg);
    }

    /**
     * Merge plugin options for L.control.locate: iOS-safe locateOptions, keepCurrentZoomLevel
     * (coarse cell fixes otherwise zoom the map out to a huge accuracy circle), and an
     * onLocationError that does not alert when the standalone-browser modal is shown.
     */
    function mergeLeafletLocateControlOptions(userOpts) {
        userOpts = userOpts || {};
        var out = {};
        var key;
        for (key in userOpts) {
            if (Object.prototype.hasOwnProperty.call(userOpts, key)) {
                out[key] = userOpts[key];
            }
        }
        if (!out.locateOptions) {
            out.locateOptions = leafletLocateOptions();
        }
        if (prefersGentleGeoOptions()) {
            if (out.keepCurrentZoomLevel == null) {
                out.keepCurrentZoomLevel = true;
            }
        }
        if (!out.onLocationError) {
            out.onLocationError = defaultLocateOnLocationError;
        }
        return out;
    }

    function geolocationErrorMessage(err) {
        if (!err) return 'Could not get location.';
        if (err.handledByIosStandalonePrompt) return '';
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
     * Home-screen (standalone) apps try GPS first; the open-in-browser modal is shown only if
     * the request hangs or fails for a non-permission reason.
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

        var gentle = prefersGentleGeoOptions();
        var settled = false;
        var watchdogId = null;

        function clearWatchdog() {
            if (watchdogId !== null) {
                clearTimeout(watchdogId);
                watchdogId = null;
            }
        }

        function armWatchdog(ms) {
            clearWatchdog();
            watchdogId = setTimeout(function () {
                watchdogId = null;
                wrapErr({ code: 0, message: stallMessage() });
            }, ms);
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
            var out = err || { code: 0, message: 'Could not get location.' };
            if (maybePromptIosStandaloneOnFailure(out)) {
                out = {
                    code: out.code || 0,
                    message: out.message || '',
                    handledByIosStandalonePrompt: true
                };
            }
            if (onError) {
                onError(out);
            }
        }

        function stallMessage() {
            var fromHomeScreen = isIosStandaloneWebApp();
            var base =
                'Location did not respond (Safari on iPad sometimes never finishes the GPS request). ';
            var settings =
                'Check Settings → Privacy & Security → Location Services → Safari Websites, and allow location for this site. ';
            var alt = 'You can use Search location instead of GPS.';
            if (fromHomeScreen) {
                return (
                    base +
                    'Apple’s iOS WebKit often breaks geolocation for home-screen web apps (standalone mode) - not an AirPlan bug. Open this page in Safari or Chrome instead. ' +
                    settings +
                    alt
                );
            }
            return base + settings + alt;
        }

        function startWatchdogAndRequests() {
            var firstWatchdogMs =
                opts.watchdogMs != null ? opts.watchdogMs : gentle ? 20000 : 18000;
            armWatchdog(firstWatchdogMs);

            var lowAcc = {
                enableHighAccuracy: false,
                timeout: opts.lowTimeout != null ? opts.lowTimeout : gentle ? 15000 : 25000,
                maximumAge: opts.lowMaximumAge != null ? opts.lowMaximumAge : 120000
            };

            function retryLowAccuracy(err) {
                if (err && (err.code === 2 || err.code === 3)) {
                    armWatchdog(gentle ? 28000 : 30000);
                    navigator.geolocation.getCurrentPosition(
                        wrapOk,
                        function (err2) {
                            wrapErr(err2);
                        },
                        gentle
                            ? {
                                  enableHighAccuracy: false,
                                  timeout: 25000,
                                  maximumAge: 300000
                              }
                            : lowAcc
                    );
                    return;
                }
                wrapErr(err);
            }

            if (gentle) {
                navigator.geolocation.getCurrentPosition(wrapOk, retryLowAccuracy, lowAcc);
                return;
            }

            var highAcc = {
                enableHighAccuracy: true,
                timeout: opts.highTimeout != null ? opts.highTimeout : 12000,
                maximumAge: 0
            };

            navigator.geolocation.getCurrentPosition(wrapOk, retryLowAccuracy, highAcc);
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

    function leafletExtend(dest, src) {
        var extendFn =
            (typeof L !== 'undefined' && L.Util && L.Util.extend) ||
            (typeof L !== 'undefined' && L.extend);
        if (typeof extendFn === 'function') {
            return extendFn(dest, src);
        }
        var key;
        for (key in src) {
            if (Object.prototype.hasOwnProperty.call(src, key)) {
                dest[key] = src[key];
            }
        }
        return dest;
    }

    function fireLeafletLocateError(map, err) {
        var e = err || { code: 0, message: 'Could not get location.' };
        var msg = geolocationErrorMessage(e);
        var payload = {
            code: e.code || 0,
            message: msg ? 'Geolocation error: ' + msg + '.' : '',
            handledByIosStandalonePrompt: !!e.handledByIosStandalonePrompt
        };
        if (typeof map.fire === 'function') {
            map.fire('locationerror', payload);
            return;
        }
        if (typeof map._handleGeolocationError === 'function') {
            map._handleGeolocationError({ code: payload.code, message: msg || 'Could not get location.' });
        }
    }

    /**
     * Leaflet.Locate / map.locate() call navigator.geolocation directly, which hangs on iOS.
     * Route one-shot locates through getCurrentPositionRobust (watch mode on non-iOS is unchanged).
     */
    function patchLeafletMapLocate() {
        if (typeof L === 'undefined' || !L.Map || !L.Map.prototype.locate) return;
        if (L.Map.prototype._airplotLocateOriginal) return;
        L.Map.prototype._airplotLocateOriginal = L.Map.prototype.locate;
        L.Map.prototype.locate = function (options) {
            options = options || {};
            this._locateOptions = leafletExtend({ timeout: 10000, watch: false }, options);
            if (this._locateOptions.watch && !prefersGentleGeoOptions()) {
                return this._airplotLocateOriginal.call(this, this._locateOptions);
            }
            var map = this;
            getCurrentPositionRobust(
                function (pos) {
                    if (typeof map._handleGeolocationResponse === 'function') {
                        map._handleGeolocationResponse(pos);
                    }
                },
                function (err) {
                    fireLeafletLocateError(map, err);
                }
            );
            return this;
        };
    }

    global.GeoLocate = {
        secureContextBlockedMessage: secureContextBlockedMessage,
        isGeolocationEnvironmentOk: isGeolocationEnvironmentOk,
        isIosLikeAppleDevice: isIosLikeAppleDevice,
        isIosStandaloneWebApp: isIosStandaloneWebApp,
        shouldSkipAutomaticGeolocation: shouldSkipAutomaticGeolocation,
        showIosStandaloneOpenInBrowserPrompt: showIosStandaloneOpenInBrowserPrompt,
        prefersGentleGeoOptions: prefersGentleGeoOptions,
        leafletLocateOptions: leafletLocateOptions,
        mergeLeafletLocateControlOptions: mergeLeafletLocateControlOptions,
        getCurrentPositionRobust: getCurrentPositionRobust,
        geolocationErrorMessage: geolocationErrorMessage
    };

    patchLeafletMapLocate();
})(typeof window !== 'undefined' ? window : this);
