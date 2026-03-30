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

    /** WebKit on iPhone/iPad (and iPadOS desktop UA) often times out with enableHighAccuracy indoors. */
    function prefersGentleGeoOptions() {
        var ua = navigator.userAgent || '';
        if (/iPad|iPhone|iPod/.test(ua)) return true;
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
        if (/Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|OPR|Brave/i.test(ua)) return true;
        return false;
    }

    /** Options passed to Leaflet.Locate / L.Map.locate (single browser request). */
    function leafletLocateOptions() {
        if (prefersGentleGeoOptions()) {
            return {
                enableHighAccuracy: false,
                timeout: 25000,
                maximumAge: 60000
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
     * Try GPS/high accuracy first; on timeout or position unavailable, retry with network / cached fix.
     * @param {PositionCallback} onSuccess
     * @param {PositionErrorCallback} [onError]
     * @param {{ highTimeout?: number, lowTimeout?: number, lowMaximumAge?: number }} [opts]
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
        var highAcc = {
            enableHighAccuracy: true,
            timeout: opts.highTimeout != null ? opts.highTimeout : gentle ? 7000 : 12000,
            maximumAge: 0
        };
        var lowAcc = {
            enableHighAccuracy: false,
            timeout: opts.lowTimeout != null ? opts.lowTimeout : 25000,
            maximumAge: opts.lowMaximumAge != null ? opts.lowMaximumAge : 120000
        };

        navigator.geolocation.getCurrentPosition(
            onSuccess,
            function (err) {
                if (err && (err.code === 2 || err.code === 3)) {
                    navigator.geolocation.getCurrentPosition(
                        onSuccess,
                        function (err2) {
                            if (onError) {
                                onError(err2);
                            }
                        },
                        lowAcc
                    );
                } else if (onError) {
                    onError(err);
                }
            },
            highAcc
        );
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
