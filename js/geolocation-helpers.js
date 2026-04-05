/**
 * Shared geolocation helpers: secure-context checks, Safari/iOS-friendly options,
 * and high-accuracy → network/cached fallback for getCurrentPosition.
 */
(function (global) {
    'use strict';

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
     * WebKit / iOS-style environments: avoid high-accuracy-first and rely on gentle getCurrentPosition.
     * iPad “desktop” UA is often Macintosh + touch (maxTouchPoints can be 1 — treat MacIntel + any touch as iPad-class).
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
     * resolves the query — CriOS / FxiOS / EdgiOS). Skip the probe and call geolocation directly.
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
                    'If you opened this from the home-screen icon, try the same page in Safari (not the standalone app); iOS often breaks GPS there. ' +
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
        prefersGentleGeoOptions: prefersGentleGeoOptions,
        leafletLocateOptions: leafletLocateOptions,
        getCurrentPositionRobust: getCurrentPositionRobust,
        geolocationErrorMessage: geolocationErrorMessage
    };
})(typeof window !== 'undefined' ? window : this);
