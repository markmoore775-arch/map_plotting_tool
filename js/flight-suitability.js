/* ============================================
   FLIGHT SUITABILITY - shared RAG rules
   Used by Flight Weather and Flight Report
   ============================================ */

const FlightSuitability = (() => {
    'use strict';

    const GUST_120M_MULTIPLIER = 1.3;

    const AIRCRAFT_PROFILE_STORAGE_KEY = 'airplotWeatherAircraftProfile_v1';
    const DEFAULT_AIRCRAFT_PROFILE_ID = 'matrice4_enterprise';

    const FORECAST_DISCLAIMER =
        'Model-based forecast indicator only. Not a substitute for on-site weather assessment, your Operations Manual, or operational authorisation limits.';

    /** @type {Record<string, object>} */
    const AIRCRAFT_PROFILES = {
        matrice4_enterprise: {
            id: 'matrice4_enterprise',
            label: 'DJI Matrice 4 (enterprise)',
            shortLabel: 'Matrice 4',
            sustainedAmberKmh: 26,
            sustainedRedKmh: 38,
            gustAmberKmh: 34,
            gustRedKmh: 47,
            visAmberM: 5500,
            visRedM: 4000,
            precipAmberMm: 0.5,
            precipRedMm: 1.5,
            useWind120m: true,
            notes:
                'Conservative margins below the 12 m/s manufacturer rating; suited to heavier payloads, thermal, and optical work. Uses the higher of 10 m and 120 m wind.'
        },
        mini5_pro: {
            id: 'mini5_pro',
            label: 'DJI Mini 5 Pro',
            shortLabel: 'Mini 5 Pro',
            sustainedAmberKmh: 24,
            sustainedRedKmh: 36,
            gustAmberKmh: 32,
            gustRedKmh: 42,
            visAmberM: 5500,
            visRedM: 4000,
            precipAmberMm: 0.5,
            precipRedMm: 1.5,
            useWind120m: false,
            notes:
                'Lighter airframe with stricter reference gust margins. Wind assessment uses 10 m model values only (typical for lower AGL operations). Confirm on site before deciding.'
        }
    };

    // Legacy exports (Matrice 4 enterprise defaults)
    const SUIT_SUSTAINED_AMBER_KMH = AIRCRAFT_PROFILES.matrice4_enterprise.sustainedAmberKmh;
    const SUIT_SUSTAINED_RED_KMH = AIRCRAFT_PROFILES.matrice4_enterprise.sustainedRedKmh;
    const SUIT_GUST_AMBER_KMH = AIRCRAFT_PROFILES.matrice4_enterprise.gustAmberKmh;
    const SUIT_GUST_RED_KMH = AIRCRAFT_PROFILES.matrice4_enterprise.gustRedKmh;
    const SUIT_VIS_AMBER_M = AIRCRAFT_PROFILES.matrice4_enterprise.visAmberM;
    const SUIT_VIS_RED_M = AIRCRAFT_PROFILES.matrice4_enterprise.visRedM;
    const SUIT_PRECIP_AMBER_MM = AIRCRAFT_PROFILES.matrice4_enterprise.precipAmberMm;
    const SUIT_PRECIP_RED_MM = AIRCRAFT_PROFILES.matrice4_enterprise.precipRedMm;

    function getProfileIds() {
        return Object.keys(AIRCRAFT_PROFILES);
    }

    function resolveProfile(profileId) {
        const id =
            profileId && AIRCRAFT_PROFILES[profileId]
                ? profileId
                : getStoredAircraftProfileId() || DEFAULT_AIRCRAFT_PROFILE_ID;
        return AIRCRAFT_PROFILES[id] || AIRCRAFT_PROFILES[DEFAULT_AIRCRAFT_PROFILE_ID];
    }

    function getStoredAircraftProfileId() {
        try {
            const raw = localStorage.getItem(AIRCRAFT_PROFILE_STORAGE_KEY);
            if (raw && AIRCRAFT_PROFILES[raw]) return raw;
        } catch (e) {
            /* ignore */
        }
        return DEFAULT_AIRCRAFT_PROFILE_ID;
    }

    function setStoredAircraftProfileId(profileId) {
        if (!profileId || !AIRCRAFT_PROFILES[profileId]) return;
        try {
            localStorage.setItem(AIRCRAFT_PROFILE_STORAGE_KEY, profileId);
        } catch (e) {
            /* ignore */
        }
    }

    function populateAircraftProfileSelect(selectEl, selectedId) {
        if (!selectEl) return;
        const want = selectedId && AIRCRAFT_PROFILES[selectedId] ? selectedId : getStoredAircraftProfileId();
        selectEl.innerHTML = '';
        getProfileIds().forEach(function (id) {
            const p = AIRCRAFT_PROFILES[id];
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = p.label;
            opt.title = p.notes;
            selectEl.appendChild(opt);
        });
        selectEl.value = want;
    }

    function formatVisibility(m) {
        if (m == null || isNaN(m)) return '-';
        if (m >= 10000) return (m / 1000).toFixed(1) + ' km';
        return Math.round(m) + ' m';
    }

    function suitFormatPrecipMm(p) {
        if (p == null || p <= 0) return '0';
        const r = Math.round(p * 10) / 10;
        return r % 1 === 0 ? String(Math.round(r)) : String(r);
    }

    function windBasisPhrase(profile) {
        return profile.useWind120m
            ? 'uses the higher of 10 m and 120 m'
            : 'uses 10 m model values only';
    }

    function gustBasisPhrase(profile) {
        return profile.useWind120m
            ? 'includes 120 m estimate where available'
            : 'uses 10 m gusts only';
    }

    /**
     * Forecast suitability indicator (Green / Amber / Red) for a selected aircraft profile.
     * @param {object} data - Open-Meteo hour slice fields
     * @param {string} [profileId]
     */
    function deriveSuitability(data, profileId) {
        const profile = resolveProfile(profileId);
        const w10 = data.wind_speed_10m ?? 0;
        const w120 = data.wind_speed_120m ?? w10;
        const sustained = profile.useWind120m ? Math.max(w10, w120) : w10;
        const g10 = data.wind_gusts_10m ?? sustained;
        const g120Est = data.wind_speed_120m != null ? data.wind_speed_120m * GUST_120M_MULTIPLIER : g10;
        const gusts = profile.useWind120m ? Math.max(g10, g120Est) : g10;
        const vis = data.visibility ?? 10000;
        const precip = data.precipitation ?? 0;

        const explainerGoodTail =
            'Forecast within reference margins for ' +
            profile.shortLabel +
            '. Confirm wind and visibility on site before take-off.';
        const explainerCautionTail =
            'Forecast marginal for ' +
            profile.shortLabel +
            '. Keep flights shorter, monitor gusts, and confirm conditions on site before deciding.';
        const explainerPoorTail =
            'Forecast unfavourable against ' +
            profile.shortLabel +
            ' reference thresholds. Confirm on site; apply your Operations Manual and operational authorisation limits before deciding.';

        const redHits = [];
        if (sustained > profile.sustainedRedKmh) {
            redHits.push(
                'sustained wind ~' +
                    Math.round(sustained) +
                    ' km/h (unfavourable above ' +
                    profile.sustainedRedKmh +
                    ' km/h; ' +
                    windBasisPhrase(profile) +
                    ')'
            );
        }
        if (gusts > profile.gustRedKmh) {
            redHits.push(
                'gusts ~' +
                    Math.round(gusts) +
                    ' km/h (unfavourable above ' +
                    profile.gustRedKmh +
                    ' km/h; ' +
                    gustBasisPhrase(profile) +
                    ')'
            );
        }
        if (vis < profile.visRedM) {
            redHits.push(
                'visibility ' + formatVisibility(vis) + ' (unfavourable below ~' + profile.visRedM / 1000 + ' km)'
            );
        }
        if (precip > profile.precipRedMm) {
            redHits.push(
                'forecast rain ~' +
                    suitFormatPrecipMm(precip) +
                    ' mm in the hour (unfavourable above ' +
                    profile.precipRedMm +
                    ' mm)'
            );
        }

        const isRed =
            sustained > profile.sustainedRedKmh ||
            gusts > profile.gustRedKmh ||
            vis < profile.visRedM ||
            precip > profile.precipRedMm;

        if (isRed) {
            const technical = redHits.length > 0 ? 'Unfavourable because: ' + redHits.join('; ') + '.' : '';
            const explainer = (technical ? technical + ' ' : '') + explainerPoorTail;
            return {
                level: 'poor',
                label: 'Red',
                brief: explainerPoorTail,
                technical,
                explainer,
                text: 'Red: ' + explainer,
                profileId: profile.id,
                profileLabel: profile.label
            };
        }

        const amberHits = [];
        if (sustained > profile.sustainedAmberKmh) {
            amberHits.push(
                'sustained wind ~' +
                    Math.round(sustained) +
                    ' km/h (marginal above ' +
                    profile.sustainedAmberKmh +
                    ' km/h)'
            );
        }
        if (gusts > profile.gustAmberKmh) {
            amberHits.push(
                'gusts ~' + Math.round(gusts) + ' km/h (marginal above ' + profile.gustAmberKmh + ' km/h)'
            );
        }
        if (vis < profile.visAmberM) {
            amberHits.push(
                'visibility ' + formatVisibility(vis) + ' (marginal below ~' + profile.visAmberM / 1000 + ' km)'
            );
        }
        if (precip > profile.precipAmberMm) {
            amberHits.push(
                'forecast rain ~' +
                    suitFormatPrecipMm(precip) +
                    ' mm in the hour (marginal above ' +
                    profile.precipAmberMm +
                    ' mm; trace drizzle up to that stays green)'
            );
        }

        const isAmber =
            sustained > profile.sustainedAmberKmh ||
            gusts > profile.gustAmberKmh ||
            vis < profile.visAmberM ||
            precip > profile.precipAmberMm;

        if (isAmber) {
            const technical = amberHits.length > 0 ? 'Marginal because: ' + amberHits.join('; ') + '.' : '';
            const explainer = (technical ? technical + ' ' : '') + explainerCautionTail;
            return {
                level: 'caution',
                label: 'Amber',
                brief: explainerCautionTail,
                technical,
                explainer,
                text: 'Amber: ' + explainer,
                profileId: profile.id,
                profileLabel: profile.label
            };
        }

        const precipPhrase =
            precip <= 0
                ? 'no meaningful rain in the forecast hour'
                : '~' +
                  suitFormatPrecipMm(precip) +
                  ' mm rain in the hour (green at ≤ ' +
                  profile.precipAmberMm +
                  ' mm)';
        const technical =
            'Green band: ~' +
            Math.round(sustained) +
            ' km/h sustained and ~' +
            Math.round(gusts) +
            ' km/h gusts, visibility ' +
            formatVisibility(vis) +
            ', ' +
            precipPhrase +
            '. Marginal would be wind or gusts above ~' +
            profile.sustainedAmberKmh +
            ' / ~' +
            profile.gustAmberKmh +
            ' km/h, visibility below ~' +
            profile.visAmberM / 1000 +
            ' km, or rain above ~' +
            profile.precipAmberMm +
            ' mm.';
        const explainer = technical + ' ' + explainerGoodTail;
        return {
            level: 'good',
            label: 'Green',
            brief: explainerGoodTail,
            technical,
            explainer,
            text: 'Green: ' + explainer,
            profileId: profile.id,
            profileLabel: profile.label
        };
    }

    /**
     * Plain methodology lines for exports / Flight Report hand-off.
     * @param {boolean} usedTargetTime
     * @param {'weather'|'flightReport'} [variant]
     * @param {string} [profileId]
     */
    function buildWeatherRagMethodologyPlainLines(usedTargetTime, variant, profileId) {
        variant = variant || 'weather';
        const profile = resolveProfile(profileId);
        const lines = [];
        lines.push('Aircraft profile: ' + profile.label + '.');
        lines.push(profile.notes);
        lines.push('');
        lines.push('Forecast hour selection:');
        if (usedTargetTime) {
            if (variant === 'flightReport') {
                lines.push(
                    '- With Date and Time set above, the nearest Open-Meteo hourly bin to that instant is used.'
                );
            } else {
                lines.push(
                    '- With Date & time selected, the nearest Open-Meteo hourly bin to your chosen instant is used.'
                );
            }
        } else if (variant === 'flightReport') {
            lines.push('- When Date or Time is not set, the latest hourly bin at or before the current moment is used.');
        } else {
            lines.push('- With Now selected, the latest hourly bin at or before the current moment is used.');
        }
        lines.push('');
        lines.push('Wind and gusts (summary hour):');
        if (profile.useWind120m) {
            lines.push('- Sustained wind uses the higher of 10 m and 120 m.');
            lines.push(
                '- Gusts use the higher of 10 m gusts and an estimate at 120 m from sustained 120 m wind (factor ' +
                    GUST_120M_MULTIPLIER +
                    ') when 120 m data exists.'
            );
        } else {
            lines.push('- Sustained wind uses 10 m model values only for this profile.');
            lines.push('- Gusts use 10 m model gusts only for this profile.');
        }
        lines.push('');
        lines.push('Forecast indicator thresholds (model units; km/h, m, mm in the hour):');
        lines.push(
            '- Sustained wind: amber above ~' +
                profile.sustainedAmberKmh +
                ' km/h, unfavourable above ~' +
                profile.sustainedRedKmh +
                ' km/h (' +
                windBasisPhrase(profile) +
                ').'
        );
        lines.push(
            '- Gusts: amber above ~' +
                profile.gustAmberKmh +
                ' km/h, unfavourable above ~' +
                profile.gustRedKmh +
                ' km/h (' +
                gustBasisPhrase(profile) +
                ').'
        );
        lines.push(
            '- Visibility: amber below ~' +
                profile.visAmberM / 1000 +
                ' km, unfavourable below ~' +
                profile.visRedM / 1000 +
                ' km.'
        );
        lines.push(
            '- Rain in the hour: trace/drizzle up to ~' +
                profile.precipAmberMm +
                ' mm/h stays in the green band; above ~' +
                profile.precipAmberMm +
                ' mm/h trends amber; above ~' +
                profile.precipRedMm +
                ' mm/h trends unfavourable.'
        );
        return lines;
    }

    /**
     * Shared forecast-indicator block for Flight Report / hand-off text.
     * @param {object} suitability
     * @param {string} [profileId]
     */
    function buildForecastIndicatorPlainLines(suitability, profileId) {
        const profile = resolveProfile(profileId || (suitability && suitability.profileId));
        const lines = [];
        lines.push('--- Forecast indicator (model) ---');
        lines.push('Aircraft profile: ' + profile.label);
        lines.push(suitability.label + ': ' + suitability.brief);
        if (suitability.technical) lines.push(suitability.technical);
        lines.push('');
        lines.push(FORECAST_DISCLAIMER);
        return lines;
    }

    function deriveSuitabilityForHourlyIndex(h, idx, profileId) {
        return deriveSuitability(
            {
                wind_speed_10m: h.wind_speed_10m != null ? h.wind_speed_10m[idx] : undefined,
                wind_speed_120m: h.wind_speed_120m != null ? h.wind_speed_120m[idx] : undefined,
                wind_gusts_10m: h.wind_gusts_10m != null ? h.wind_gusts_10m[idx] : undefined,
                visibility: h.visibility != null ? h.visibility[idx] : undefined,
                precipitation: h.precipitation != null ? h.precipitation[idx] : undefined
            },
            profileId
        );
    }

    return {
        GUST_120M_MULTIPLIER,
        AIRCRAFT_PROFILE_STORAGE_KEY,
        DEFAULT_AIRCRAFT_PROFILE_ID,
        FORECAST_DISCLAIMER,
        AIRCRAFT_PROFILES,
        SUIT_SUSTAINED_AMBER_KMH,
        SUIT_SUSTAINED_RED_KMH,
        SUIT_GUST_AMBER_KMH,
        SUIT_GUST_RED_KMH,
        SUIT_VIS_AMBER_M,
        SUIT_VIS_RED_M,
        SUIT_PRECIP_AMBER_MM,
        SUIT_PRECIP_RED_MM,
        getProfileIds,
        resolveProfile,
        getStoredAircraftProfileId,
        setStoredAircraftProfileId,
        populateAircraftProfileSelect,
        formatVisibility,
        suitFormatPrecipMm,
        deriveSuitability,
        buildWeatherRagMethodologyPlainLines,
        buildForecastIndicatorPlainLines,
        deriveSuitabilityForHourlyIndex
    };
})();
