/* ============================================
   FLIGHT SUITABILITY - shared RAG rules
   Used by Flight Weather and Flight Report
   ============================================ */

const FlightSuitability = (() => {
    'use strict';

    const GUST_120M_MULTIPLIER = 1.3;

    const SUIT_SUSTAINED_AMBER_KMH = 26;
    const SUIT_SUSTAINED_RED_KMH = 38;
    const SUIT_GUST_AMBER_KMH = 34;
    const SUIT_GUST_RED_KMH = 47;
    const SUIT_VIS_AMBER_M = 5500;
    const SUIT_VIS_RED_M = 4000;
    const SUIT_PRECIP_AMBER_MM = 0.5;
    const SUIT_PRECIP_RED_MM = 1.5;

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

    /** RAG suitability: ~12 m/s-class enterprise multi-rotor, thermal + optical; 120 m wind/gust estimates included. */
    function deriveSuitability(data) {
        const w10 = data.wind_speed_10m ?? 0;
        const w120 = data.wind_speed_120m ?? w10;
        const sustained = Math.max(w10, w120);
        const g10 = data.wind_gusts_10m ?? sustained;
        const g120Est = data.wind_speed_120m != null ? data.wind_speed_120m * GUST_120M_MULTIPLIER : g10;
        const gusts = Math.max(g10, g120Est);
        const vis = data.visibility ?? 10000;
        const precip = data.precipitation ?? 0;

        const explainerGoodTail =
            'Within usual operating margins for DJI enterprise-class aircraft. Still check wind and visibility on site before take-off.';
        const explainerCautionTail =
            'Marginal for heavier multi-rotor thermal and optical work. Keep flights shorter, allow extra height margin, watch for stronger gusts higher up, and keep battery in reserve.';
        const explainerPoorTail =
            'Conditions exceed safe margins for typical enterprise-class multi-rotor wind limits and visibility. Postpone or re-plan.';

        const redHits = [];
        if (sustained > SUIT_SUSTAINED_RED_KMH) {
            redHits.push(
                `sustained wind ~${Math.round(sustained)} km/h (red above ${SUIT_SUSTAINED_RED_KMH} km/h; uses the higher of 10 m and 120 m)`
            );
        }
        if (gusts > SUIT_GUST_RED_KMH) {
            redHits.push(
                `gusts ~${Math.round(gusts)} km/h (red above ${SUIT_GUST_RED_KMH} km/h; includes 120 m estimate where available)`
            );
        }
        if (vis < SUIT_VIS_RED_M) {
            redHits.push(
                `visibility ${formatVisibility(vis)} (red below ~${SUIT_VIS_RED_M / 1000} km)`
            );
        }
        if (precip > SUIT_PRECIP_RED_MM) {
            redHits.push(
                `forecast rain ~${suitFormatPrecipMm(precip)} mm in the hour (red above ${SUIT_PRECIP_RED_MM} mm)`
            );
        }

        const isRed =
            sustained > SUIT_SUSTAINED_RED_KMH ||
            gusts > SUIT_GUST_RED_KMH ||
            vis < SUIT_VIS_RED_M ||
            precip > SUIT_PRECIP_RED_MM;

        if (isRed) {
            const technical =
                redHits.length > 0 ? 'Red because: ' + redHits.join('; ') + '.' : '';
            const explainer = (technical ? technical + ' ' : '') + explainerPoorTail;
            return {
                level: 'poor',
                label: 'Red',
                brief: explainerPoorTail,
                technical,
                explainer,
                text: 'Red: ' + explainer
            };
        }

        const amberHits = [];
        if (sustained > SUIT_SUSTAINED_AMBER_KMH) {
            amberHits.push(
                `sustained wind ~${Math.round(sustained)} km/h (amber above ${SUIT_SUSTAINED_AMBER_KMH} km/h)`
            );
        }
        if (gusts > SUIT_GUST_AMBER_KMH) {
            amberHits.push(`gusts ~${Math.round(gusts)} km/h (amber above ${SUIT_GUST_AMBER_KMH} km/h)`);
        }
        if (vis < SUIT_VIS_AMBER_M) {
            amberHits.push(
                `visibility ${formatVisibility(vis)} (amber below ~${SUIT_VIS_AMBER_M / 1000} km)`
            );
        }
        if (precip > SUIT_PRECIP_AMBER_MM) {
            amberHits.push(
                `forecast rain ~${suitFormatPrecipMm(precip)} mm in the hour (amber above ${SUIT_PRECIP_AMBER_MM} mm; trace drizzle up to that stays green)`
            );
        }

        const isAmber =
            sustained > SUIT_SUSTAINED_AMBER_KMH ||
            gusts > SUIT_GUST_AMBER_KMH ||
            vis < SUIT_VIS_AMBER_M ||
            precip > SUIT_PRECIP_AMBER_MM;

        if (isAmber) {
            const technical =
                amberHits.length > 0 ? 'Amber because: ' + amberHits.join('; ') + '.' : '';
            const explainer = (technical ? technical + ' ' : '') + explainerCautionTail;
            return {
                level: 'caution',
                label: 'Amber',
                brief: explainerCautionTail,
                technical,
                explainer,
                text: 'Amber: ' + explainer
            };
        }

        const precipPhrase =
            precip <= 0
                ? 'no meaningful rain in the forecast hour'
                : `~${suitFormatPrecipMm(precip)} mm rain in the hour (green at ≤ ${SUIT_PRECIP_AMBER_MM} mm)`;
        const technical =
            `Green band: ~${Math.round(sustained)} km/h sustained and ~${Math.round(gusts)} km/h gusts, visibility ${formatVisibility(vis)}, ${precipPhrase}. ` +
            `Amber would be wind or gusts above ~${SUIT_SUSTAINED_AMBER_KMH} / ~${SUIT_GUST_AMBER_KMH} km/h, visibility below ~${SUIT_VIS_AMBER_M / 1000} km, or rain above ~${SUIT_PRECIP_AMBER_MM} mm.`;
        const explainer = technical + ' ' + explainerGoodTail;
        return {
            level: 'good',
            label: 'Green',
            brief: explainerGoodTail,
            technical,
            explainer,
            text: 'Green: ' + explainer
        };
    }

    /**
     * Plain methodology lines for exports / Flight Report hand-off.
     * @param {boolean} usedTargetTime
     * @param {'weather'|'flightReport'} [variant]
     */
    function buildWeatherRagMethodologyPlainLines(usedTargetTime, variant) {
        variant = variant || 'weather';
        const lines = [];
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
        lines.push('- Sustained wind uses the higher of 10 m and 120 m.');
        lines.push(
            '- Gusts use the higher of 10 m gusts and an estimate at 120 m from sustained 120 m wind (factor ' +
                GUST_120M_MULTIPLIER +
                ') when 120 m data exists.'
        );
        lines.push('');
        lines.push('Flight suitability thresholds (model units; km/h, m, mm in the hour):');
        lines.push(
            '- Sustained wind: amber above ~' +
                SUIT_SUSTAINED_AMBER_KMH +
                ' km/h, red above ~' +
                SUIT_SUSTAINED_RED_KMH +
                ' km/h (uses the higher of 10 m and 120 m).'
        );
        lines.push(
            '- Gusts: amber above ~' +
                SUIT_GUST_AMBER_KMH +
                ' km/h, red above ~' +
                SUIT_GUST_RED_KMH +
                ' km/h (includes 120 m estimate where available).'
        );
        lines.push(
            '- Visibility: amber below ~' +
                SUIT_VIS_AMBER_M / 1000 +
                ' km, red below ~' +
                SUIT_VIS_RED_M / 1000 +
                ' km.'
        );
        lines.push(
            '- Rain in the hour: trace/drizzle up to ~' +
                SUIT_PRECIP_AMBER_MM +
                ' mm/h stays in the green band; above ~' +
                SUIT_PRECIP_AMBER_MM +
                ' mm/h trends amber; above ~' +
                SUIT_PRECIP_RED_MM +
                ' mm/h trends red.'
        );
        return lines;
    }

    function deriveSuitabilityForHourlyIndex(h, idx) {
        return deriveSuitability({
            wind_speed_10m: h.wind_speed_10m != null ? h.wind_speed_10m[idx] : undefined,
            wind_speed_120m: h.wind_speed_120m != null ? h.wind_speed_120m[idx] : undefined,
            wind_gusts_10m: h.wind_gusts_10m != null ? h.wind_gusts_10m[idx] : undefined,
            visibility: h.visibility != null ? h.visibility[idx] : undefined,
            precipitation: h.precipitation != null ? h.precipitation[idx] : undefined
        });
    }

    return {
        GUST_120M_MULTIPLIER,
        SUIT_SUSTAINED_AMBER_KMH,
        SUIT_SUSTAINED_RED_KMH,
        SUIT_GUST_AMBER_KMH,
        SUIT_GUST_RED_KMH,
        SUIT_VIS_AMBER_M,
        SUIT_VIS_RED_M,
        SUIT_PRECIP_AMBER_MM,
        SUIT_PRECIP_RED_MM,
        formatVisibility,
        suitFormatPrecipMm,
        deriveSuitability,
        buildWeatherRagMethodologyPlainLines,
        deriveSuitabilityForHourlyIndex
    };
})();
