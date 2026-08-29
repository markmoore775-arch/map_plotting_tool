/**
 * Flight Report: form serialization, GPS (HTTPS only), mailto + clipboard fallback, PDF via PdfTheme.
 * Multi-draft reports (localStorage index), report switcher, page theme, PDF theme radios.
 * Clear Report empties the active report; Delete removes the active draft from the list.
 */
(function () {
    'use strict';

    /** Max battery slots on the Flight Report form (cards 2–this many can be revealed). */
    var FN_BATTERY_MAX = 99;

    /** Default max altitude / distance per sortie (editable); used when fields are blank. */
    var FN_BATTERY_DEFAULT_MAX_ALT_FT = '400';
    var FN_BATTERY_DEFAULT_MAX_DIST_M = '500';

    /** Legacy single-draft key; migrated once into FN_REPORTS_STORAGE_KEY. */
    var FN_DRAFT_STORAGE_KEY = 'airplotFlightNotesDraft_v1';
    /** Multi-report index: activeId + reports[id].draft payloads. */
    var FN_REPORTS_STORAGE_KEY = 'airplotFlightNotesReports_v1';
    var FN_REPORTS_MAX = 8;
    /** NOTAM filter checkboxes (Airspace tab); defaults favour drone-focused triage. */
    var FN_NOTAM_FILTER_STORAGE_KEY = 'airplotFlightNotesNotamFilters_v1';
    var FN_DRAFT_BASE_FIELD_IDS = [
        'fnDate',
        'fnTime',
        'fnLocationLabel',
        'fnLocation',
        'fnReference',
        'fnDeconflictions'
    ];

    var BATTERY_N_FIELD_SUFFIXES = [
        'Uas',
        'Name',
        'Site',
        'Voltage',
        'MaxAltFt',
        'MaxDistM',
        'Rp1',
        'Rp2',
        'Launch',
        'Land',
        'FlightTime',
        'AmberMin',
        'RedMin',
        'Alos'
    ];

    function buildFnDraftFieldIds() {
        var ids = FN_DRAFT_BASE_FIELD_IDS.slice();
        var n;
        var i;
        for (n = 1; n <= FN_BATTERY_MAX; n++) {
            for (i = 0; i < BATTERY_N_FIELD_SUFFIXES.length; i++) {
                ids.push('fnBattery' + n + BATTERY_N_FIELD_SUFFIXES[i]);
            }
        }
        ids.push('fnWeather', 'fnAirspaceRadiusKm', 'fnNotes');
        return ids;
    }

    var FN_DRAFT_FIELD_IDS = buildFnDraftFieldIds();

    var fnDraftSaveTimer = null;
    var fnActiveReportId = null;
    var fnReportsIndex = null;
    var fnSwitchingReport = false;

    /** How many battery cards (1–FN_BATTERY_MAX) are shown; exported to email/PDF and saved in draft (v2). */
    var fnVisibleBatteryCount = 1;

    /** Per-battery collapse state (keyed by battery index string). */
    var fnBatteryCollapsed = {};

    function getVisibleBatteryCount() {
        return fnVisibleBatteryCount;
    }

    function batteryNHasAnyValue(n) {
        var b = 'fnBattery' + n;
        var i;
        for (i = 0; i < BATTERY_N_FIELD_SUFFIXES.length; i++) {
            var suf = BATTERY_N_FIELD_SUFFIXES[i];
            if (suf === 'MaxAltFt' || suf === 'MaxDistM') continue;
            var id = b + suf;
            var el = document.getElementById(id);
            if (el && String(el.value || '').trim()) return true;
        }
        return false;
    }

    function deriveVisibleBatteryCountFromFields() {
        var max = 1;
        var n;
        for (n = 2; n <= FN_BATTERY_MAX; n++) {
            if (batteryNHasAnyValue(n)) max = n;
        }
        return max;
    }

    function wrapBatteryCardCollapseStructure(card, n) {
        if (!card || card.querySelector('.fn-battery-card-head')) return;
        if (!card.id) card.id = 'fnBatteryCard' + n;

        var title = card.querySelector('.fn-battery-title');
        if (!title) return;

        var body = document.createElement('div');
        body.className = 'fn-battery-card-body';
        body.id = 'fnBatteryCard' + n + 'Body';

        var children = Array.prototype.slice.call(card.children);
        children.forEach(function (child) {
            if (child === title) return;
            body.appendChild(child);
        });

        var head = document.createElement('div');
        head.className = 'fn-battery-card-head';

        var headMain = document.createElement('div');
        headMain.className = 'fn-battery-card-head-main';

        var summary = document.createElement('p');
        summary.className = 'fn-battery-collapsed-summary';
        summary.id = 'fnBattery' + n + 'CollapsedSummary';
        summary.setAttribute('aria-hidden', 'true');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fn-btn fn-btn-secondary fn-battery-collapse-btn';
        btn.setAttribute('data-battery-collapse', String(n));
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('aria-label', 'Collapse Battery ' + n);
        btn.title = 'Collapse this battery record';
        btn.textContent = 'Collapse';

        headMain.appendChild(title);
        headMain.appendChild(summary);
        head.appendChild(headMain);
        head.appendChild(btn);
        card.insertBefore(head, card.firstChild);
        card.appendChild(body);
    }

    function renumberBatteryCardRefs(root, fromN, toN) {
        var from = 'fnBattery' + fromN;
        var to = 'fnBattery' + toN;
        var re = new RegExp(from, 'g');

        function fixAttr(el, attr) {
            var v = el.getAttribute(attr);
            if (v && v.indexOf(from) !== -1) el.setAttribute(attr, v.replace(re, to));
        }

        if (root.id && root.id.indexOf(from) !== -1) root.id = root.id.replace(re, to);

        var all = root.querySelectorAll('*');
        var i;
        for (i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.id && el.id.indexOf(from) !== -1) el.id = el.id.replace(re, to);
            if (el.name && el.name.indexOf(from) !== -1) el.name = el.name.replace(re, to);
            ['for', 'data-launch-for', 'data-land-for', 'aria-describedby'].forEach(function (attr) {
                fixAttr(el, attr);
            });
        }

        var collapseBtn = root.querySelector('.fn-battery-collapse-btn');
        if (collapseBtn) {
            collapseBtn.setAttribute('data-battery-collapse', String(toN));
            collapseBtn.setAttribute('aria-label', 'Collapse Battery ' + toN);
        }

        var title = root.querySelector('.fn-battery-title');
        if (title) title.textContent = 'Battery ' + toN;

        var body = root.querySelector('.fn-battery-card-body');
        if (body) body.id = 'fnBatteryCard' + toN + 'Body';

        var sum = root.querySelector('.fn-battery-collapsed-summary');
        if (sum) sum.id = 'fnBattery' + toN + 'CollapsedSummary';
    }

    function clearBatteryCardInputValues(card) {
        if (!card) return;
        card.querySelectorAll('input, textarea').forEach(function (el) {
            if (el.id && el.id.indexOf('FlightTime') !== -1) {
                el.value = '';
                return;
            }
            if (el.id && el.id.indexOf('MaxAltFt') !== -1) {
                el.value = FN_BATTERY_DEFAULT_MAX_ALT_FT;
                return;
            }
            if (el.id && el.id.indexOf('MaxDistM') !== -1) {
                el.value = FN_BATTERY_DEFAULT_MAX_DIST_M;
                return;
            }
            el.value = '';
        });
    }

    function ensureBatteryCards() {
        var grid = document.querySelector('.fn-battery-grid');
        if (!grid) return;

        var card1 = document.getElementById('fnBatteryCard1') || grid.querySelector('.fn-battery-card');
        var card2 = document.getElementById('fnBatteryCard2');
        if (!card1 || !card2) return;

        if (!card1.id) card1.id = 'fnBatteryCard1';
        wrapBatteryCardCollapseStructure(card1, 1);
        wrapBatteryCardCollapseStructure(card2, 2);

        var n;
        for (n = 3; n <= FN_BATTERY_MAX; n++) {
            if (document.getElementById('fnBatteryCard' + n)) continue;
            var clone = card2.cloneNode(true);
            clone.id = 'fnBatteryCard' + n;
            clone.classList.add('fn-battery-card--extra');
            clone.hidden = true;
            clone.classList.remove('fn-battery-card--collapsed');
            renumberBatteryCardRefs(clone, 2, n);
            clearBatteryCardInputValues(clone);
            grid.appendChild(clone);
        }
    }

    function isBatteryCollapsed(n) {
        return !!fnBatteryCollapsed[String(n)];
    }

    function updateBatteryCollapsedSummary(n) {
        var sum = document.getElementById('fnBattery' + n + 'CollapsedSummary');
        if (!sum) return;
        var parts = [];
        var uas = trimVal('fnBattery' + n + 'Uas');
        var name = trimVal('fnBattery' + n + 'Name');
        var launch = trimVal('fnBattery' + n + 'Launch');
        var land = trimVal('fnBattery' + n + 'Land');
        var ft = trimVal('fnBattery' + n + 'FlightTime');
        if (uas) parts.push(uas);
        if (name) parts.push(name);
        if (launch || land) {
            var timePart = (launch || '-') + '–' + (land || '-');
            if (ft) timePart += ' (' + ft + ')';
            parts.push(timePart);
        } else if (ft) {
            parts.push(ft);
        }
        sum.textContent = parts.length ? parts.join(' · ') : 'No details entered';
    }

    function setBatteryCollapsed(n, collapsed) {
        var card = document.getElementById('fnBatteryCard' + n);
        var btn = card && card.querySelector('[data-battery-collapse="' + n + '"]');
        var summary = document.getElementById('fnBattery' + n + 'CollapsedSummary');
        if (!card) return;

        if (collapsed) {
            fnBatteryCollapsed[String(n)] = true;
            card.classList.add('fn-battery-card--collapsed');
            if (btn) {
                btn.textContent = 'Expand';
                btn.setAttribute('aria-expanded', 'false');
                btn.setAttribute('aria-label', 'Expand Battery ' + n);
                btn.title = 'Expand this battery record';
            }
            if (summary) {
                updateBatteryCollapsedSummary(n);
                summary.setAttribute('aria-hidden', 'false');
            }
        } else {
            delete fnBatteryCollapsed[String(n)];
            card.classList.remove('fn-battery-card--collapsed');
            if (btn) {
                btn.textContent = 'Collapse';
                btn.setAttribute('aria-expanded', 'true');
                btn.setAttribute('aria-label', 'Collapse Battery ' + n);
                btn.title = 'Collapse this battery record';
            }
            if (summary) summary.setAttribute('aria-hidden', 'true');
        }
        syncBatteryBulkActionButtons();
    }

    function expandAllVisibleBatteries() {
        var n;
        for (n = 1; n <= fnVisibleBatteryCount; n++) {
            setBatteryCollapsed(n, false);
        }
        scheduleFlightNotesDraftSave();
    }

    function collapseAllVisibleBatteries() {
        var n;
        for (n = 1; n <= fnVisibleBatteryCount; n++) {
            setBatteryCollapsed(n, true);
        }
        scheduleFlightNotesDraftSave();
    }

    function syncBatteryBulkActionButtons() {
        var wrap = document.getElementById('fnBatteryBulkActions');
        if (!wrap) return;
        wrap.hidden = fnVisibleBatteryCount < 2;
    }

    function applyCollapsedBatteriesFromDraft(collapsedMap) {
        if (!collapsedMap || typeof collapsedMap !== 'object') return;
        var key;
        for (key in collapsedMap) {
            if (!Object.prototype.hasOwnProperty.call(collapsedMap, key)) continue;
            if (!collapsedMap[key]) continue;
            var n = parseInt(key, 10);
            if (n >= 1 && n <= FN_BATTERY_MAX) setBatteryCollapsed(n, true);
        }
    }

    function collectCollapsedBatteriesForDraft() {
        var collapsed = {};
        var n;
        for (n = 1; n <= fnVisibleBatteryCount; n++) {
            if (fnBatteryCollapsed[String(n)]) collapsed[String(n)] = true;
        }
        return collapsed;
    }

    function resetAllBatteryCollapseState() {
        fnBatteryCollapsed = {};
        var n;
        for (n = 1; n <= FN_BATTERY_MAX; n++) {
            var card = document.getElementById('fnBatteryCard' + n);
            if (!card) continue;
            card.classList.remove('fn-battery-card--collapsed');
            var btn = card.querySelector('[data-battery-collapse="' + n + '"]');
            var summary = document.getElementById('fnBattery' + n + 'CollapsedSummary');
            if (btn) {
                btn.textContent = 'Collapse';
                btn.setAttribute('aria-expanded', 'true');
                btn.setAttribute('aria-label', 'Collapse Battery ' + n);
                btn.title = 'Collapse this battery record';
            }
            if (summary) summary.setAttribute('aria-hidden', 'true');
        }
        syncBatteryBulkActionButtons();
    }

    function bindBatteryCardInteractions() {
        var grid = document.querySelector('.fn-battery-grid');
        if (!grid || grid.dataset.fnBatteryBound === '1') return;
        grid.dataset.fnBatteryBound = '1';

        grid.addEventListener('click', function (e) {
            var collapseBtn = e.target.closest('[data-battery-collapse]');
            if (collapseBtn) {
                var cn = parseInt(collapseBtn.getAttribute('data-battery-collapse'), 10);
                if (cn >= 1 && cn <= FN_BATTERY_MAX) {
                    setBatteryCollapsed(cn, !isBatteryCollapsed(cn));
                    scheduleFlightNotesDraftSave();
                }
                return;
            }
            var launchBtn = e.target.closest('[data-launch-for]');
            if (launchBtn) {
                var launchId = launchBtn.getAttribute('data-launch-for');
                if (launchId) setTimeInputNow(launchId);
                return;
            }
            var landBtn = e.target.closest('[data-land-for]');
            if (landBtn) {
                var landId = landBtn.getAttribute('data-land-for');
                if (landId) setTimeInputNow(landId);
            }
        });

        grid.addEventListener('input', function (e) {
            var el = e.target;
            if (!el.id || el.id.indexOf('fnBattery') !== 0) return;
            var m = el.id.match(/^fnBattery(\d+)/);
            if (!m) return;
            var bn = parseInt(m[1], 10);
            if (isBatteryCollapsed(bn)) updateBatteryCollapsedSummary(bn);
            if (el.id.indexOf('Launch') !== -1 || el.id.indexOf('Land') !== -1) {
                updateBatteryFlightTimeForIndex(bn);
            }
        });

        grid.addEventListener('change', function (e) {
            var el = e.target;
            if (!el.id || el.id.indexOf('fnBattery') !== 0) return;
            var m = el.id.match(/^fnBattery(\d+)/);
            if (!m) return;
            var bn = parseInt(m[1], 10);
            if (isBatteryCollapsed(bn)) updateBatteryCollapsedSummary(bn);
            if (el.id.indexOf('Launch') !== -1 || el.id.indexOf('Land') !== -1) {
                updateBatteryFlightTimeForIndex(bn);
                scheduleFlightNotesDraftSave();
            }
        });
    }

    function ensureBatteryLimitDefaults(n) {
        var altEl = document.getElementById('fnBattery' + n + 'MaxAltFt');
        var distEl = document.getElementById('fnBattery' + n + 'MaxDistM');
        if (altEl && !String(altEl.value || '').trim()) altEl.value = FN_BATTERY_DEFAULT_MAX_ALT_FT;
        if (distEl && !String(distEl.value || '').trim()) distEl.value = FN_BATTERY_DEFAULT_MAX_DIST_M;
    }

    function applyBatteryLimitDefaultsForVisible() {
        var n;
        for (n = 1; n <= fnVisibleBatteryCount; n++) {
            ensureBatteryLimitDefaults(n);
        }
    }

    function setVisibleBatteryCount(count) {
        fnVisibleBatteryCount = Math.min(FN_BATTERY_MAX, Math.max(1, count));
        var i;
        for (i = 2; i <= FN_BATTERY_MAX; i++) {
            var card = document.getElementById('fnBatteryCard' + i);
            if (card) card.hidden = i > fnVisibleBatteryCount;
        }
        var btn = document.getElementById('fnAddBatteryBtn');
        if (btn) {
            if (fnVisibleBatteryCount >= FN_BATTERY_MAX) {
                btn.hidden = true;
            } else {
                btn.hidden = false;
                btn.textContent = 'Add Battery ' + (fnVisibleBatteryCount + 1);
                btn.title = 'Show fields for the next battery (up to ' + FN_BATTERY_MAX + ')';
            }
        }
        var rmBtn = document.getElementById('fnRemoveLastBatteryBtn');
        if (rmBtn) {
            if (fnVisibleBatteryCount <= 1) {
                rmBtn.hidden = true;
            } else {
                rmBtn.hidden = false;
                var bn = fnVisibleBatteryCount;
                rmBtn.textContent = 'Remove Battery ' + bn;
                rmBtn.title = 'Remove Battery ' + bn + ' and hide this slot';
                rmBtn.setAttribute('aria-label', 'Remove Battery ' + bn);
            }
        }
        syncBatteryBulkActionButtons();
    }

    function clearBatteryNFields(n) {
        var b = 'fnBattery' + n;
        var i;
        for (i = 0; i < BATTERY_N_FIELD_SUFFIXES.length; i++) {
            var suf = BATTERY_N_FIELD_SUFFIXES[i];
            if (suf === 'FlightTime') continue;
            var el = document.getElementById(b + suf);
            if (!el) continue;
            if (suf === 'MaxAltFt') {
                el.value = FN_BATTERY_DEFAULT_MAX_ALT_FT;
                continue;
            }
            if (suf === 'MaxDistM') {
                el.value = FN_BATTERY_DEFAULT_MAX_DIST_M;
                continue;
            }
            el.value = '';
        }
        updateBatteryFlightTimeForIndex(n);
    }

    function removeLastBatteryConfirmed() {
        var n = fnVisibleBatteryCount;
        if (n < 2) return;
        clearBatteryNFields(n);
        setVisibleBatteryCount(n - 1);
        updateAllBatteryFlightTimes();
        saveFlightNotesDraft();
    }

    function generateReportId() {
        return 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function buildEmptyDraftPayload() {
        var fields = {};
        var i;
        for (i = 0; i < FN_DRAFT_FIELD_IDS.length; i++) {
            fields[FN_DRAFT_FIELD_IDS[i]] = '';
        }
        return { v: 2, fields: fields, visibleBatteryCount: 1 };
    }

    function buildDraftPayloadFromForm() {
        var fields = {};
        for (var i = 0; i < FN_DRAFT_FIELD_IDS.length; i++) {
            var id = FN_DRAFT_FIELD_IDS[i];
            var el = document.getElementById(id);
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                fields[id] = el.value || '';
            }
        }
        var draftPayload = {
            v: 2,
            fields: fields,
            visibleBatteryCount: fnVisibleBatteryCount
        };
        var extras = serializeExtraLocations();
        if (extras.length) draftPayload.extraLocations = extras;
        var airSiteSel = document.getElementById('fnAirspaceSiteSelect');
        if (airSiteSel && airSiteSel.value && !airSiteSel.disabled) {
            draftPayload.airspaceSiteId = airSiteSel.value;
        }
        var collapsedBatteries = collectCollapsedBatteriesForDraft();
        if (Object.keys(collapsedBatteries).length) {
            draftPayload.collapsedBatteries = collapsedBatteries;
        }
        return draftPayload;
    }

    /**
     * Restores field values from a draft payload. Returns suggested visible battery count (1–FN_BATTERY_MAX).
     */
    function applyDraftPayloadToForm(data) {
        var visibleHint = 1;
        if (!data || !data.fields) return visibleHint;
        if (data.v !== 1 && data.v !== 2) return visibleHint;
        var id;
        for (id in data.fields) {
            if (!Object.prototype.hasOwnProperty.call(data.fields, id)) continue;
            var el = document.getElementById(id);
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                el.value = data.fields[id];
            }
        }
        var bnLegacy;
        for (bnLegacy = 1; bnLegacy <= FN_BATTERY_MAX; bnLegacy++) {
            var legacyKey = 'fnBattery' + bnLegacy;
            if (!Object.prototype.hasOwnProperty.call(data.fields, legacyKey)) continue;
            var legacyVal = data.fields[legacyKey];
            if (legacyVal == null || !String(legacyVal).trim()) continue;
            var nameLegacyEl = document.getElementById('fnBattery' + bnLegacy + 'Name');
            if (nameLegacyEl && !String(nameLegacyEl.value || '').trim()) {
                nameLegacyEl.value = String(legacyVal);
            }
        }
        if (data.v === 2 && typeof data.visibleBatteryCount === 'number') {
            visibleHint = Math.min(FN_BATTERY_MAX, Math.max(1, Math.round(data.visibleBatteryCount)));
        } else {
            visibleHint = deriveVisibleBatteryCountFromFields();
        }
        deserializeExtraLocations(data.extraLocations);
        syncFnAirspaceSiteSelectOptions(data.airspaceSiteId);
        return visibleHint;
    }

    function loadReportsIndexFromStorage() {
        try {
            var raw = localStorage.getItem(FN_REPORTS_STORAGE_KEY);
            if (!raw) return null;
            var data = JSON.parse(raw);
            if (!data || data.v !== 1 || !data.reports || typeof data.reports !== 'object') return null;
            if (!data.activeId || !data.reports[data.activeId]) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    function saveReportsIndex(index) {
        try {
            localStorage.setItem(FN_REPORTS_STORAGE_KEY, JSON.stringify(index));
            fnReportsIndex = index;
            setReportStorageStatus('');
            return true;
        } catch (e) {
            var msg =
                e && e.name === 'QuotaExceededError'
                    ? 'Could not save reports: browser storage is full. Export or delete old reports.'
                    : 'Could not save reports locally.';
            setReportStorageStatus(msg, 'error');
            return false;
        }
    }

    function setReportStorageStatus(message, kind) {
        var el = document.getElementById('fnReportStorageStatus');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'fn-report-storage-status' + (kind === 'error' ? ' fn-report-storage-status--error' : '');
    }

    function migrateLegacySingleDraft() {
        try {
            if (localStorage.getItem(FN_REPORTS_STORAGE_KEY)) return;
            var raw = localStorage.getItem(FN_DRAFT_STORAGE_KEY);
            if (!raw) return;
            var legacyDraft = JSON.parse(raw);
            if (!legacyDraft || !legacyDraft.fields) {
                localStorage.removeItem(FN_DRAFT_STORAGE_KEY);
                return;
            }
            var now = Date.now();
            var id = 'r_migrated';
            var index = {
                v: 1,
                activeId: id,
                reports: {}
            };
            index.reports[id] = {
                id: id,
                createdAt: now,
                updatedAt: now,
                draft: legacyDraft
            };
            saveReportsIndex(index);
            localStorage.removeItem(FN_DRAFT_STORAGE_KEY);
        } catch (e) {
            /* ignore migration errors */
        }
    }

    function ensureReportsIndex() {
        if (
            fnReportsIndex &&
            fnReportsIndex.reports &&
            fnReportsIndex.activeId &&
            fnReportsIndex.reports[fnReportsIndex.activeId]
        ) {
            fnActiveReportId = fnReportsIndex.activeId;
            return fnReportsIndex;
        }
        migrateLegacySingleDraft();
        var index = loadReportsIndexFromStorage();
        if (index) {
            fnReportsIndex = index;
            fnActiveReportId = index.activeId;
            return index;
        }
        var now = Date.now();
        var id = generateReportId();
        index = {
            v: 1,
            activeId: id,
            reports: {}
        };
        index.reports[id] = {
            id: id,
            createdAt: now,
            updatedAt: now,
            draft: buildEmptyDraftPayload()
        };
        fnReportsIndex = index;
        fnActiveReportId = id;
        saveReportsIndex(index);
        return index;
    }

    function getActiveReportEntry() {
        var index = ensureReportsIndex();
        return index.reports[fnActiveReportId] || null;
    }

    function deriveReportBaseTitle(draft) {
        if (!draft || !draft.fields) return 'Untitled report';
        var ref = String(draft.fields.fnReference || '').trim();
        if (ref) return ref;
        var loc = String(draft.fields.fnLocationLabel || '').trim();
        if (loc) return loc;
        var dateVal = String(draft.fields.fnDate || '').trim();
        if (dateVal) return dateVal;
        return 'Untitled report';
    }

    function formatReportShortDate(ts) {
        try {
            return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        } catch (e) {
            return '';
        }
    }

    function buildReportTitleMap(index) {
        var titles = {};
        var baseCounts = {};
        var id;
        for (id in index.reports) {
            if (!Object.prototype.hasOwnProperty.call(index.reports, id)) continue;
            var base = deriveReportBaseTitle(index.reports[id].draft);
            baseCounts[base] = (baseCounts[base] || 0) + 1;
            titles[id] = base;
        }
        for (id in titles) {
            if (!Object.prototype.hasOwnProperty.call(titles, id)) continue;
            if (baseCounts[titles[id]] > 1) {
                var entry = index.reports[id];
                var suffix = formatReportShortDate(entry && entry.updatedAt ? entry.updatedAt : Date.now());
                if (suffix) titles[id] = titles[id] + ' · ' + suffix;
            }
        }
        return titles;
    }

    function syncReportActiveHint() {
        var hint = document.getElementById('fnReportActiveHint');
        if (!hint) return;
        var index = ensureReportsIndex();
        var titles = buildReportTitleMap(index);
        var label = titles[fnActiveReportId] || 'Untitled report';
        hint.textContent = 'PDF and email use the active report: ' + label + '.';
    }

    function syncNewReportButtonState() {
        var btn = document.getElementById('fnNewReportBtn');
        if (!btn) return;
        var index = ensureReportsIndex();
        var count = Object.keys(index.reports).length;
        var atCap = count >= FN_REPORTS_MAX;
        btn.disabled = atCap;
        btn.title = atCap
            ? 'Maximum ' + FN_REPORTS_MAX + ' reports. Delete one to create another.'
            : 'Start a new blank report (current report stays saved)';
    }

    function renderReportPicker() {
        var sel = document.getElementById('fnReportSelect');
        if (!sel) return;
        var index = ensureReportsIndex();
        var titles = buildReportTitleMap(index);
        var ids = Object.keys(index.reports);
        ids.sort(function (a, b) {
            return (index.reports[b].updatedAt || 0) - (index.reports[a].updatedAt || 0);
        });
        fnSwitchingReport = true;
        sel.innerHTML = '';
        var i;
        for (i = 0; i < ids.length; i++) {
            var rid = ids[i];
            var opt = document.createElement('option');
            opt.value = rid;
            opt.textContent = titles[rid] || 'Untitled report';
            if (rid === fnActiveReportId) opt.selected = true;
            sel.appendChild(opt);
        }
        fnSwitchingReport = false;
        syncReportActiveHint();
        syncNewReportButtonState();
    }

    function flushFlightNotesDraftSave() {
        if (fnDraftSaveTimer) {
            clearTimeout(fnDraftSaveTimer);
            fnDraftSaveTimer = null;
        }
        saveFlightNotesDraft();
    }

    function saveFlightNotesDraft() {
        try {
            var index = ensureReportsIndex();
            if (!fnActiveReportId || !index.reports[fnActiveReportId]) return;
            var draftPayload = buildDraftPayloadFromForm();
            var entry = index.reports[fnActiveReportId];
            entry.draft = draftPayload;
            entry.updatedAt = Date.now();
            saveReportsIndex(index);
            renderReportPicker();
        } catch (e) {}
    }

    function scheduleFlightNotesDraftSave() {
        if (fnDraftSaveTimer) clearTimeout(fnDraftSaveTimer);
        fnDraftSaveTimer = setTimeout(function () {
            fnDraftSaveTimer = null;
            saveFlightNotesDraft();
        }, 250);
    }

    function resetTransientReportUi() {
        if (fnLocationPreviewTimer) {
            clearTimeout(fnLocationPreviewTimer);
            fnLocationPreviewTimer = null;
        }
        destroyFnAirspaceMaps();
        fnLastNotams = null;
        fnLastAirspace = null;
        fnAirspaceDataLoaded = false;
        var ac = document.getElementById('fnAirspaceContent');
        if (ac) ac.innerHTML = '';
        var al = document.getElementById('fnAirspaceLoading');
        if (al) al.classList.add('hidden');
        clearAllExtraLocationRows();
        setExtraLocGlobalStatus('', '');
        hideLocationResult();
        setGpsStatus('', '');
        clearWeatherFetchStatus();
        var hintClear = document.getElementById('fnDateManualHint');
        if (hintClear) {
            hintClear.textContent = '';
            hintClear.classList.add('hidden');
        }
        resetAllBatteryCollapseState();
    }

    function refreshFormAfterDraftLoad(visibleHint, collapsedMap) {
        setVisibleBatteryCount(visibleHint);
        resetAllBatteryCollapseState();
        applyCollapsedBatteriesFromDraft(collapsedMap);
        updateAllBatteryFlightTimes();
        applyBatteryLimitDefaultsForVisible();
        syncFnAirspaceIntroKm();
        syncManualSelectsFromDateInput();
        syncLocationPreviewFromField();
        syncAllMissionSiteSelects();
        autoResizeConditionsTextarea();
        updateBatterySiteDatalist();
        renderReportPicker();
        syncReportActiveHint();
    }

    function createNewReport() {
        var index = ensureReportsIndex();
        if (Object.keys(index.reports).length >= FN_REPORTS_MAX) {
            setReportStorageStatus(
                'Maximum ' + FN_REPORTS_MAX + ' reports. Delete one to create another.',
                'error'
            );
            return;
        }
        flushFlightNotesDraftSave();
        var now = Date.now();
        var id = generateReportId();
        index.reports[id] = {
            id: id,
            createdAt: now,
            updatedAt: now,
            draft: buildEmptyDraftPayload()
        };
        fnActiveReportId = id;
        index.activeId = id;
        resetTransientReportUi();
        var form = document.getElementById('flightReportForm');
        if (form) form.reset();
        initFnManualDateSelects();
        applyDraftPayloadToForm(buildEmptyDraftPayload());
        refreshFormAfterDraftLoad(1, null);
        saveReportsIndex(index);
    }

    function switchToReport(id) {
        if (!id || id === fnActiveReportId) return;
        var index = ensureReportsIndex();
        if (!index.reports[id]) return;
        flushFlightNotesDraftSave();
        fnActiveReportId = id;
        index.activeId = id;
        resetTransientReportUi();
        var visibleHint = applyDraftPayloadToForm(index.reports[id].draft);
        refreshFormAfterDraftLoad(visibleHint, index.reports[id].draft.collapsedBatteries);
        saveReportsIndex(index);
    }

    function deleteReport(id) {
        if (!id) return;
        flushFlightNotesDraftSave();
        var index = ensureReportsIndex();
        if (!index.reports[id]) return;
        var wasActive = id === fnActiveReportId;
        delete index.reports[id];
        var remaining = Object.keys(index.reports);
        if (!remaining.length) {
            fnReportsIndex = null;
            fnActiveReportId = null;
            try {
                localStorage.removeItem(FN_REPORTS_STORAGE_KEY);
            } catch (e) {}
            createNewReport();
            return;
        }
        if (wasActive) {
            remaining.sort(function (a, b) {
                return (index.reports[b].updatedAt || 0) - (index.reports[a].updatedAt || 0);
            });
            fnActiveReportId = remaining[0];
            index.activeId = fnActiveReportId;
            saveReportsIndex(index);
            resetTransientReportUi();
            var visibleHint = applyDraftPayloadToForm(index.reports[fnActiveReportId].draft);
            refreshFormAfterDraftLoad(
                visibleHint,
                index.reports[fnActiveReportId].draft.collapsedBatteries
            );
        } else {
            saveReportsIndex(index);
            renderReportPicker();
        }
    }

    function saveEmptyDraftForActiveReport() {
        var index = ensureReportsIndex();
        if (!fnActiveReportId || !index.reports[fnActiveReportId]) return;
        index.reports[fnActiveReportId].draft = buildDraftPayloadFromForm();
        index.reports[fnActiveReportId].updatedAt = Date.now();
        saveReportsIndex(index);
        renderReportPicker();
    }

    /**
     * Restores active report from localStorage. Returns suggested visible battery count (1–FN_BATTERY_MAX).
     */
    function loadFlightNotesDraft() {
        var visibleHint = 1;
        try {
            ensureReportsIndex();
            var entry = getActiveReportEntry();
            if (!entry || !entry.draft) return visibleHint;
            visibleHint = applyDraftPayloadToForm(entry.draft);
            return visibleHint;
        } catch (e) {
            return visibleHint;
        }
    }

    function getActiveDraftCollapsedBatteries() {
        var entry = getActiveReportEntry();
        return entry && entry.draft && entry.draft.collapsedBatteries
            ? entry.draft.collapsedBatteries
            : null;
    }

    function clearFlightNotesDraftStorage() {
        saveEmptyDraftForActiveReport();
    }

    function applyFnNotamFiltersFromStorage() {
        var defaults = { droneOnly: true, hideAd: true, hideCeiling: true, prioritise: false };
        var o = defaults;
        try {
            var raw = localStorage.getItem(FN_NOTAM_FILTER_STORAGE_KEY);
            if (raw) o = Object.assign({}, defaults, JSON.parse(raw));
        } catch (e) { /* keep defaults */ }
        var drone = document.getElementById('fnNotamDroneOnly');
        var hideAd = document.getElementById('fnNotamHideAd');
        var hideCeil = document.getElementById('fnNotamHideCeiling');
        var pri = document.getElementById('fnNotamPrioritise');
        if (drone) drone.checked = !!o.droneOnly;
        if (hideAd) hideAd.checked = !!o.hideAd;
        if (hideCeil) hideCeil.checked = !!o.hideCeiling;
        if (pri) pri.checked = !!o.prioritise;
    }

    function saveFnNotamFiltersToStorage() {
        try {
            var drone = document.getElementById('fnNotamDroneOnly');
            var hideAd = document.getElementById('fnNotamHideAd');
            var hideCeil = document.getElementById('fnNotamHideCeiling');
            var pri = document.getElementById('fnNotamPrioritise');
            localStorage.setItem(
                FN_NOTAM_FILTER_STORAGE_KEY,
                JSON.stringify({
                    droneOnly: !!(drone && drone.checked),
                    hideAd: !!(hideAd && hideAd.checked),
                    hideCeiling: !!(hideCeil && hideCeil.checked),
                    prioritise: !!(pri && pri.checked)
                })
            );
        } catch (e) { /* ignore */ }
    }

    var MAILTO_BODY_MAX = 1800;

    var miniMap = null;
    var fnLocationPreviewTimer = null;

    /** Additional operational locations (same mission); each row has its own mini map. Max rows. */
    var FN_EXTRA_LOC_MAX = 8;
    var fnExtraLocationRows = [];
    var fnExtraRowPreviewIdCounter = 0;
    var fnExtraLocPreviewTimers = {};

    var fnAirspaceRadiusKm = 3;
    var fnLastNotams = null;
    var fnLastAirspace = null;
    var fnAirspaceMaps = [];
    var fnAirspaceDataLoaded = false;

    function missionAirspaceSiteKey(lat, lng) {
        return lat.toFixed(4) + ',' + lng.toFixed(4);
    }

    /** Primary Location plus additional rows with parseable coordinates; duplicates (same ~10 m) omitted. */
    function getMissionAirspaceSitesDeduped() {
        var list = [];
        var seen = {};
        var mainLl = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (mainLl) {
            var k0 = missionAirspaceSiteKey(mainLl.lat, mainLl.lng);
            seen[k0] = true;
            list.push({
                id: 'primary',
                label: trimVal('fnLocationLabel') || 'Primary location',
                lat: mainLl.lat,
                lng: mainLl.lng
            });
        }
        var ri;
        for (ri = 0; ri < fnExtraLocationRows.length; ri++) {
            var row = fnExtraLocationRows[ri];
            var raw = String(row.textInput.value || '').trim();
            var ll = parseLatLngFromLocationString(raw);
            if (!ll) continue;
            var k = missionAirspaceSiteKey(ll.lat, ll.lng);
            if (seen[k]) continue;
            seen[k] = true;
            var lab =
                String(row.labelInput.value || '').trim() || 'Additional location ' + (ri + 1);
            list.push({ id: 'extra-' + ri, label: lab, lat: ll.lat, lng: ll.lng, extraRowIndex: ri });
        }
        return list;
    }

    function populateMissionSiteSelect(sel, preferredId) {
        if (!sel) return null;
        var sites = getMissionAirspaceSitesDeduped();
        var prev = preferredId != null ? preferredId : sel.value;
        sel.innerHTML = '';
        if (!sites.length) {
            var o0 = document.createElement('option');
            o0.value = 'primary';
            o0.textContent = 'Resolve coordinates in Location (or an additional site) first';
            o0.disabled = true;
            sel.appendChild(o0);
            sel.value = 'primary';
            sel.disabled = true;
            return null;
        }
        sel.disabled = false;
        var si;
        for (si = 0; si < sites.length; si++) {
            var s = sites[si];
            var opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.label + ' · ' + s.lat.toFixed(4) + ', ' + s.lng.toFixed(4);
            sel.appendChild(opt);
        }
        var ok = false;
        for (si = 0; si < sites.length; si++) {
            if (sites[si].id === prev) {
                ok = true;
                break;
            }
        }
        var chosen = ok ? prev : sites[0].id;
        sel.value = chosen;
        return chosen;
    }

    function getFnMissionSelectedSiteFromSelect(sel) {
        var want = sel && sel.value ? sel.value : 'primary';
        var sites = getMissionAirspaceSitesDeduped();
        var i;
        for (i = 0; i < sites.length; i++) {
            if (sites[i].id === want) return sites[i];
        }
        return sites.length ? sites[0] : null;
    }

    function syncFnWeatherSiteRowVisibility() {
        var row = document.getElementById('fnWeatherSiteRow');
        if (!row) return;
        var show = getMissionAirspaceSitesDeduped().length > 1;
        row.classList.toggle('hidden', !show);
        row.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    function syncFnWeatherFetchUiState() {
        var btn = document.getElementById('fnWeatherFetchBtn');
        if (!btn || btn.dataset.fetching === '1') return;
        var sites = getMissionAirspaceSitesDeduped();
        btn.disabled = !sites.length;
        btn.title = sites.length
            ? 'Fetches forecast from Open-Meteo for the selected mission site (same source as Flight Weather).'
            : 'Resolve coordinates in Location or an additional operational site first (Use current GPS, Search location, or paste lat/lng).';
    }

    function syncAllMissionSiteSelects(preferredId) {
        var airSel = document.getElementById('fnAirspaceSiteSelect');
        var weatherSel = document.getElementById('fnWeatherSiteSelect');
        var want = preferredId;
        if (want == null && airSel && airSel.value) {
            want = airSel.value;
        } else if (want == null && weatherSel && weatherSel.value) {
            want = weatherSel.value;
        }
        var chosen = populateMissionSiteSelect(airSel, want);
        if (weatherSel) populateMissionSiteSelect(weatherSel, chosen != null ? chosen : want);
        syncFnWeatherSiteRowVisibility();
        syncFnWeatherFetchUiState();
    }

    function syncFnAirspaceSiteSelectOptions(preferredId) {
        syncAllMissionSiteSelects(preferredId);
    }

    function getFnAirspaceSelectedSiteFromUi() {
        return getFnMissionSelectedSiteFromSelect(document.getElementById('fnAirspaceSiteSelect'));
    }

    function getFnWeatherSelectedSiteFromUi() {
        return getFnMissionSelectedSiteFromSelect(document.getElementById('fnWeatherSiteSelect'));
    }

    async function fetchFnAirspaceNearPoint(lat, lng, r) {
        if (typeof AirspaceNearby === 'undefined') {
            throw new Error('Airspace module not loaded');
        }
        var notams = await AirspaceNearby.fetchNearbyNotams(lat, lng, r, fnNotamFetchOptionsWithTime());
        var air = await AirspaceNearby.fetchNearbyAirspace(lat, lng, r);
        return { notams: notams, airspace: air };
    }

    function applyFnAirspaceBundleToUi(notams, airspace, lat, lng) {
        fnLastNotams = notams;
        fnLastAirspace = airspace;
        fnAirspaceDataLoaded = true;
        fnAirspaceRadiusKm = readFnAirspaceRadiusFromInput();
        destroyFnAirspaceMaps();
        var content = document.getElementById('fnAirspaceContent');
        if (content) renderFnAirspaceHtml(notams, airspace, lat, lng);
        return new Promise(function (resolve) {
            setTimeout(function () {
                populateFnAirspaceMaps(lat, lng, notams, airspace);
                resolve();
            }, 50);
        });
    }

    function escapeHtmlFn(str) {
        if (str == null) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatNotamDateFn(str) {
        if (!str) return '';
        var raw = String(str).trim();
        var up = raw.toUpperCase();
        if (up === 'PERM' || up === 'UFN') return up;
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var fmt = function (d) {
            return (
                d.getUTCDate() +
                ' ' +
                months[d.getUTCMonth()] +
                ' ' +
                d.getUTCFullYear() +
                ' ' +
                String(d.getUTCHours()).padStart(2, '0') +
                ':' +
                String(d.getUTCMinutes()).padStart(2, '0') +
                ' UTC'
            );
        };
        var m = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (m) {
            var d = new Date(Date.UTC(+m[1], parseInt(m[2], 10) - 1, +m[3], +m[4], +m[5]));
            if (!isNaN(d.getTime())) return fmt(d);
        }
        m = raw.match(/\d{10}/);
        if (!m) return raw;
        var s = m[0];
        var yy = parseInt(s.slice(0, 2), 10);
        var mm = parseInt(s.slice(2, 4), 10) - 1;
        var dd = parseInt(s.slice(4, 6), 10);
        var hh = parseInt(s.slice(6, 8), 10);
        var min = parseInt(s.slice(8, 10), 10);
        var year = yy >= 50 ? 1900 + yy : 2000 + yy;
        if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return raw;
        return fmt(new Date(Date.UTC(year, mm, dd, hh, min)));
    }

    function readFnAirspaceRadiusFromInput() {
        var input = document.getElementById('fnAirspaceRadiusKm');
        var v = input ? parseInt(String(input.value), 10) : 3;
        if (!isFinite(v)) v = 3;
        return Math.min(100, Math.max(1, Math.round(v)));
    }

    function fnNotamFetchOptions() {
        function on(id) {
            var el = document.getElementById(id);
            return !!(el && el.checked);
        }
        return {
            droneRelevantOnly: on('fnNotamDroneOnly'),
            hideAerodromeGround: on('fnNotamHideAd'),
            hideAboveDroneCeiling: on('fnNotamHideCeiling'),
            prioritiseUas: on('fnNotamPrioritise')
        };
    }

    function fnNotamFetchOptionsWithTime() {
        return Object.assign({}, fnNotamFetchOptions(), {
            referenceAtMs: getTargetTimeMsFromForm() ?? Date.now()
        });
    }

    function fnNotamCatClass(cat) {
        return 'fn-notam-' + String(cat || 'other').replace(/_/g, '-');
    }

    function syncFnAirspaceIntroKm() {
        var intro = document.getElementById('fnAirspaceIntroKm');
        var v = readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = v;
        if (intro) intro.textContent = String(v);
    }

    function destroyFnAirspaceMaps() {
        fnAirspaceMaps.forEach(function (o) {
            try {
                if (o.map) o.map.remove();
            } catch (e) {}
        });
        fnAirspaceMaps = [];
    }

    function fnAirspaceSummaryForExport() {
        var sites = getMissionAirspaceSitesDeduped();
        var r = readFnAirspaceRadiusFromInput();
        if (!sites.length) {
            return 'No mission coordinates; resolve Location (or an additional site) before export.';
        }
        if (sites.length === 1) {
            return (
                sites[0].label +
                ' · ' +
                r +
                ' km radius. PDF export appends NOTAM and UK zone tables for this point.'
            );
        }
        var siteList = sites
            .map(function (s) {
                return s.label + ' (' + s.lat.toFixed(4) + ', ' + s.lng.toFixed(4) + ')';
            })
            .join('; ');
        return (
            sites.length +
            ' mission location(s) · ' +
            r +
            ' km radius each: ' +
            siteList +
            '. PDF export appends a separate NOTAM and zone section for every site.'
        );
    }

    function renderFnAirspaceHtml(notams, airspace, lat, lng) {
        var content = document.getElementById('fnAirspaceContent');
        if (!content) return;
        content.innerHTML = '';

        if (notams.length === 0 && airspace.length === 0) {
            content.innerHTML =
                '<div class="fn-airspace-empty"><p>No NOTAMs or airspace restrictions found within ' +
                fnAirspaceRadiusKm +
                ' km.</p></div>';
            return;
        }

        var catColors = { FRZ: 'frz', Prohibited: 'prohibited', Restricted: 'restricted', Danger: 'danger' };

        if (airspace.length > 0) {
            content.insertAdjacentHTML(
                'beforeend',
                '<div class="fn-airspace-section-title">Airspace restrictions <span>(' + airspace.length + ')</span></div>'
            );
            airspace.forEach(function (a, i) {
                var cls = catColors[a.category] || 'danger';
                var distKm = '';
                if (a.geometry) {
                    var coords =
                        a.geometry.type === 'MultiPolygon'
                            ? a.geometry.coordinates.flat(2)
                            : a.geometry.type === 'Polygon'
                              ? a.geometry.coordinates.flat()
                              : [];
                    var minDist = Infinity;
                    coords.forEach(function (c) {
                        var d = AirspaceNearby.haversineKm(lat, lng, c[1], c[0]);
                        if (d < minDist) minDist = d;
                    });
                    if (isFinite(minDist)) distKm = ' · ' + minDist.toFixed(1) + ' km away';
                }
                var bodyLines = [];
                bodyLines.push('<p><strong>Designator</strong> ' + escapeHtmlFn(a.designator) + '</p>');
                bodyLines.push(
                    '<p><strong>Lower / Upper</strong> ' + escapeHtmlFn(String(a.lower)) + ' / ' + escapeHtmlFn(String(a.upper)) + '</p>'
                );
                if (a.type) bodyLines.push('<p><strong>Type</strong> ' + escapeHtmlFn(a.type) + '</p>');
                if (a.source) bodyLines.push('<p><strong>Source</strong> ' + escapeHtmlFn(a.source) + '</p>');
                if (a.description) {
                    bodyLines.push(
                        '<p class="fn-airspace-detail-desc">' +
                            escapeHtmlFn(AirspaceNearby.htmlToPlainText(a.description)) +
                            '</p>'
                    );
                }
                content.insertAdjacentHTML(
                    'beforeend',
                    '<div class="fn-airspace-item category-' +
                        cls +
                        '">' +
                        '<div class="fn-airspace-item-header">' +
                        '<span class="fn-airspace-badge badge-' +
                        cls +
                        '">' +
                        escapeHtmlFn(a.category) +
                        '</span>' +
                        '<span class="fn-airspace-item-name">' +
                        escapeHtmlFn(a.name || a.designator) +
                        '</span>' +
                        '</div>' +
                        '<div class="fn-airspace-item-detail">' +
                        '<strong>' +
                        escapeHtmlFn(a.designator) +
                        '</strong>' +
                        distKm +
                        ' · Lower: ' +
                        escapeHtmlFn(String(a.lower)) +
                        ' · Upper: ' +
                        escapeHtmlFn(String(a.upper)) +
                        '</div>' +
                        '<div class="fn-airspace-item-body">' +
                        '<div class="fn-airspace-detail-body">' +
                        bodyLines.join('') +
                        '</div>' +
                        '<div class="fn-airspace-minimap" id="fnAirspaceMap-airspace-' +
                        i +
                        '"></div>' +
                        '</div></div>'
                );
            });
        }

        if (notams.length > 0) {
            content.insertAdjacentHTML(
                'beforeend',
                '<div class="fn-airspace-section-title">NOTAMs <span>(' + notams.length + ')</span></div>'
            );
            notams.forEach(function (n, i) {
                var dist = AirspaceNearby.haversineKm(lat, lng, n.lat, n.lng).toFixed(1);
                var validStart = formatNotamDateFn(n.startValidity);
                var validEnd = formatNotamDateFn(n.endValidity);
                var validStr = validStart + ' – ' + validEnd;
                var descText = (n.text || '').replace(/\s+/g, ' ');
                if (descText.length > 300) descText = descText.slice(0, 297) + '…';
                var cat = n.uasCategory || 'other';
                var badge =
                    typeof NotamPib !== 'undefined'
                        ? NotamPib.notamBadgeMeta(cat)
                        : { label: 'NOTAM', cssClass: 'badge-notam-general' };
                var vert = n.verticalSummary ? escapeHtmlFn(n.verticalSummary) : '-';
                var adNote = n.itemA ? '<br>AD: ' + escapeHtmlFn(n.itemA) : '';
                content.insertAdjacentHTML(
                    'beforeend',
                    '<div class="fn-airspace-item category-notam ' +
                        fnNotamCatClass(cat) +
                        '">' +
                        '<div class="fn-airspace-item-header">' +
                        '<span class="fn-airspace-badge ' +
                        badge.cssClass +
                        '">' +
                        escapeHtmlFn(badge.label) +
                        '</span>' +
                        '<span class="fn-airspace-item-name">' +
                        escapeHtmlFn(n.id || 'NOTAM') +
                        '</span>' +
                        '</div>' +
                        '<div class="fn-airspace-item-detail">' +
                        dist +
                        ' km away' +
                        (n.radiusNm > 0 && n.radiusNm < 999 ? ' · Radius: ' + n.radiusNm + ' NM' : '') +
                        '<br>Vertical (Q-line / text): ' +
                        vert +
                        adNote +
                        '<br>Valid: ' +
                        escapeHtmlFn(validStr) +
                        '<br>' +
                        escapeHtmlFn(descText) +
                        '</div>' +
                        '<div class="fn-airspace-item-body">' +
                        '<div class="fn-airspace-detail-body">' +
                        '<p><strong>Distance</strong> ' +
                        escapeHtmlFn(dist) +
                        ' km</p>' +
                        '<p><strong>Radius</strong> ' +
                        escapeHtmlFn(n.radiusNm > 0 && n.radiusNm < 999 ? n.radiusNm + ' NM' : '-') +
                        '</p>' +
                        '<p><strong>Vertical</strong> ' +
                        vert +
                        '</p>' +
                        '<p><strong>Valid</strong> ' +
                        escapeHtmlFn(validStart) +
                        ' – ' +
                        escapeHtmlFn(validEnd) +
                        '</p>' +
                        '<p class="fn-airspace-detail-notam-text">' +
                        escapeHtmlFn(n.text || '').replace(/\n/g, '<br>') +
                        '</p>' +
                        '</div>' +
                        '<div class="fn-airspace-minimap" id="fnAirspaceMap-notam-' +
                        i +
                        '"></div>' +
                        '</div></div>'
                );
            });
        }
    }

    /** Geographic bounds of a circle (Leaflet Circle.getBounds can be unreliable before layout). */
    function latLngBoundsFromRadiusMeters(centerLat, centerLng, radiusM) {
        var R = 6371000;
        var latRad = (centerLat * Math.PI) / 180;
        var dLat = (radiusM / R) * (180 / Math.PI);
        var cosLat = Math.cos(latRad);
        var dLng = cosLat > 1e-10 ? (radiusM / (R * cosLat)) * (180 / Math.PI) : dLat;
        return L.latLngBounds(
            [centerLat - dLat, centerLng - dLng],
            [centerLat + dLat, centerLng + dLng]
        );
    }

    function applyFnNotamMiniMapView(m, lat, lng, groupBounds) {
        if (groupBounds.isValid()) {
            var sw = groupBounds.getSouthWest();
            var ne = groupBounds.getNorthEast();
            var tiny = Math.abs(sw.lat - ne.lat) < 1e-5 && Math.abs(sw.lng - ne.lng) < 1e-5;
            if (tiny) {
                m.setView([lat, lng], 13);
            } else {
                m.fitBounds(groupBounds.pad(0.25), { maxZoom: 15 });
            }
        } else {
            m.setView([lat, lng], 10);
        }
    }

    /** Re-fit after container gets real size (0×0 or wrong aspect breaks first fitBounds; SVG circles misalign under html2canvas). */
    function deferFnMiniMapRefit(map, refitFn) {
        function run() {
            try {
                refitFn();
            } catch (e) {}
        }
        if (!map || typeof map.whenReady !== 'function') return;
        map.whenReady(function () {
            run();
            requestAnimationFrame(function () {
                run();
                setTimeout(run, 0);
                setTimeout(run, 80);
                setTimeout(run, 350);
            });
        });
    }

    function populateFnAirspaceMaps(lat, lng, notams, airspace) {
        destroyFnAirspaceMaps();
        if (typeof L === 'undefined' || typeof AirspaceNearby === 'undefined') return;

        var catColors = { FRZ: '#9333ea', Prohibited: '#991b1b', Restricted: '#dc2626', Danger: '#ca8a04' };

        airspace.forEach(function (a, i) {
            var el = document.getElementById('fnAirspaceMap-airspace-' + i);
            if (!el) return;
            var map = L.map(el, { zoomControl: false, attributionControl: false });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: true }).addTo(map);
            var overlay = L.layerGroup().addTo(map);
            if (a.geometry) {
                var gj = L.geoJSON(a.geometry, {
                    style: {
                        color: catColors[a.category] || '#dc2626',
                        weight: 2,
                        fillColor: catColors[a.category] || '#dc2626',
                        fillOpacity: 0.2
                    }
                });
                overlay.addLayer(gj);
                L.marker([lat, lng], { title: 'Location' }).addTo(overlay);
                var b = gj.getBounds();
                if (b.isValid()) {
                    b.extend([lat, lng]);
                    map.fitBounds(b.pad(0.12));
                } else {
                    map.setView([lat, lng], 11);
                }
            }
            fnAirspaceMaps.push({ map: map });
            setTimeout(function () {
                map.invalidateSize();
            }, 100);
        });

        notams.forEach(function (n, i) {
            var el = document.getElementById('fnAirspaceMap-notam-' + i);
            if (!el) return;
            var map = L.map(el, { zoomControl: false, attributionControl: false });
            var vectorRenderer = L.canvas({ padding: 0.5 });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: true }).addTo(map);
            var overlay = L.layerGroup().addTo(map);
            var nLat = parseFloat(n.lat);
            var nLng = parseFloat(n.lng);
            if (!isFinite(nLat) || !isFinite(nLng)) {
                nLat = lat;
                nLng = lng;
            }
            L.marker([lat, lng], { title: 'Location' }).addTo(overlay);
            L.marker([nLat, nLng], { title: 'NOTAM centre' }).addTo(overlay);
            var groupBounds = L.latLngBounds([lat, lng], [nLat, nLng]);
            if (n.radiusNm > 0 && n.radiusNm < 999) {
                var radiusM = n.radiusNm * 1852;
                L.circle([nLat, nLng], {
                    renderer: vectorRenderer,
                    radius: radiusM,
                    color: '#dc2626',
                    weight: 2,
                    fillColor: '#dc2626',
                    fillOpacity: 0.12
                }).addTo(overlay);
                groupBounds.extend(latLngBoundsFromRadiusMeters(nLat, nLng, radiusM));
            }
            function refitNotamMap() {
                map.invalidateSize();
                applyFnNotamMiniMapView(map, lat, lng, groupBounds);
            }
            applyFnNotamMiniMapView(map, lat, lng, groupBounds);
            fnAirspaceMaps.push({ map: map, refit: refitNotamMap });
            deferFnMiniMapRefit(map, refitNotamMap);
            setTimeout(function () {
                map.invalidateSize();
            }, 100);
        });

        setTimeout(function () {
            fnAirspaceMaps.forEach(function (o) {
                try {
                    if (o.map) o.map.invalidateSize();
                } catch (e) {}
            });
        }, 350);
    }

    async function loadFnAirspaceTab() {
        if (typeof AirspaceNearby === 'undefined') {
            alert('Airspace data module not loaded.');
            return;
        }
        syncFnAirspaceSiteSelectOptions();
        var site = getFnAirspaceSelectedSiteFromUi();
        if (!site) {
            alert(
                'Resolve coordinates for at least one mission location (Location or an additional site with lat, lng), then Refresh.'
            );
            return;
        }
        var r = readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = r;
        syncFnAirspaceIntroKm();
        destroyFnAirspaceMaps();
        var loading = document.getElementById('fnAirspaceLoading');
        if (loading) loading.classList.remove('hidden');
        try {
            var bundle = await fetchFnAirspaceNearPoint(site.lat, site.lng, r);
            await applyFnAirspaceBundleToUi(bundle.notams, bundle.airspace, site.lat, site.lng);
        } catch (e) {
            console.error('Flight Report airspace load failed:', e);
            alert('Failed to load airspace data.');
        } finally {
            if (loading) loading.classList.add('hidden');
        }
    }

    /** Center-crop a canvas to a square (same idea as PdfTheme.captureSquareMap). */
    function cropCanvasToSquare(srcCanvas) {
        var sw = srcCanvas.width;
        var sh = srcCanvas.height;
        var side = Math.min(sw, sh);
        var sx = Math.round((sw - side) / 2);
        var sy = Math.round((sh - side) / 2);
        var sq = document.createElement('canvas');
        sq.width = side;
        sq.height = side;
        sq.getContext('2d').drawImage(srcCanvas, sx, sy, side, side, 0, 0, side, side);
        return sq;
    }

    function waitForFnAirspaceMapsReady(extraMs) {
        extraMs = extraMs == null ? 180 : extraMs;
        if (!fnAirspaceMaps.length) {
            return new Promise(function (resolve) {
                setTimeout(resolve, 80);
            });
        }
        return Promise.all(
            fnAirspaceMaps.map(function (entry) {
                if (!entry || !entry.map) return Promise.resolve();
                return new Promise(function (resolve) {
                    try {
                        entry.map.whenReady(function () {
                            try {
                                entry.map.invalidateSize();
                                if (typeof entry.refit === 'function') entry.refit();
                            } catch (e) {}
                            setTimeout(resolve, extraMs);
                        });
                    } catch (e2) {
                        setTimeout(resolve, extraMs);
                    }
                });
            })
        );
    }

    function appendAirspacePdfSiteErrorPage(doc, siteTitle, lat, lng, rKm, message) {
        PdfTheme.newPage(doc);
        PdfTheme.addHeader(doc, 'Airspace & NOTAMs · ' + siteTitle + ' (' + rKm + ' km)', false);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(185, 55, 55);
        doc.text('Could not load airspace data for this location.', 10, 16);
        doc.setTextColor(85, 85, 85);
        doc.text('Centre: ' + lat.toFixed(5) + ', ' + lng.toFixed(5) + '.', 10, 22);
        var err = String(message || 'Failed to load airspace data.').replace(/\s+/g, ' ').trim();
        if (err.length > 220) err = err.slice(0, 217) + '…';
        doc.text(err, 10, 28);
    }

    /** Plain-text explainer for PDF column (NOTAM / restriction details). */
    function buildAirspaceDetailPdfForRow(kind, lat, lng, a, n) {
        if (kind === 'airspace' && a) {
            var lines = [];
            lines.push(a.category + ': ' + (a.name || a.designator));
            lines.push('Designator: ' + a.designator);
            lines.push('Lower / Upper: ' + a.lower + ' / ' + a.upper);
            if (a.type) lines.push('Type: ' + a.type);
            if (a.source) lines.push('Source: ' + a.source);
            if (a.description) {
                var d = AirspaceNearby.htmlToPlainText(a.description).replace(/\s+/g, ' ').trim();
                if (d.length > 650) d = d.slice(0, 647) + '…';
                lines.push('Description: ' + d);
            }
            return lines.join('\n');
        }
        if (kind === 'notam' && n) {
            var dist = AirspaceNearby.haversineKm(lat, lng, n.lat, n.lng).toFixed(1);
            var lines = [];
            var tag =
                typeof NotamPib !== 'undefined'
                    ? NotamPib.notamBadgeMeta(n.uasCategory || 'other').label
                    : 'NOTAM';
            lines.push('NOTAM ' + (n.id || '-') + ' (' + tag + ')');
            lines.push('Distance: ' + dist + ' km from your location');
            if (n.radiusNm > 0 && n.radiusNm < 999) lines.push('Radius: ' + n.radiusNm + ' NM');
            if (n.verticalSummary) lines.push('Vertical (Q-line / text): ' + n.verticalSummary);
            lines.push('Valid: ' + formatNotamDateFn(n.startValidity) + ' – ' + formatNotamDateFn(n.endValidity));
            var txt = (n.text || '').replace(/\s+/g, ' ').trim();
            if (txt.length > 1100) txt = txt.slice(0, 1097) + '…';
            lines.push('Text: ' + txt);
            return lines.join('\n');
        }
        return '-';
    }

    /**
     * @param {object} [opt] - When set, use for this appendix only: siteTitle, lat, lng, notams, airspace.
     */
    async function appendAirspacePdfPages(doc, opt) {
        if (typeof html2canvas === 'undefined' || typeof doc.autoTable !== 'function') return;
        opt = opt || {};
        var ll =
            opt.lat != null && opt.lng != null && isFinite(opt.lat) && isFinite(opt.lng)
                ? { lat: opt.lat, lng: opt.lng }
                : parseLatLngFromLocationString(trimVal('fnLocation'));
        if (!ll) return;
        var notams = opt.notams != null ? opt.notams : fnLastNotams || [];
        var airspace = opt.airspace != null ? opt.airspace : fnLastAirspace || [];
        var siteTitle = opt.siteTitle || 'Primary location';
        var rKm =
            opt.radiusKm != null && isFinite(opt.radiusKm)
                ? Math.min(100, Math.max(1, Math.round(opt.radiusKm)))
                : readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = rKm;

        if (notams.length === 0 && airspace.length === 0) {
            PdfTheme.newPage(doc);
            PdfTheme.addHeader(doc, 'Airspace & NOTAMs · ' + siteTitle + ' (' + rKm + ' km)', false);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8.5);
            doc.setTextColor(85, 85, 85);
            doc.text(
                'No NOTAMs or UK restriction polygons within ' +
                    rKm +
                    ' km of ' +
                    ll.lat.toFixed(5) +
                    ', ' +
                    ll.lng.toFixed(5) +
                    '.',
                10,
                16
            );
            return;
        }

        var items = [];
        airspace.forEach(function (a, i) {
            items.push({ kind: 'airspace', index: i, a: a, n: null });
        });
        notams.forEach(function (n, i) {
            items.push({ kind: 'notam', index: i, a: null, n: n });
        });

        var MAP_THUMB_MM = 26;
        var MAP_COL_W = 34;
        var pdfMapEntries = [];

        for (var j = 0; j < items.length; j++) {
            var id = 'fnAirspaceMap-' + items[j].kind + '-' + items[j].index;
            var el = document.getElementById(id);
            if (!el) {
                pdfMapEntries.push(null);
                continue;
            }
            if (fnAirspaceMaps[j] && fnAirspaceMaps[j].map) {
                try {
                    fnAirspaceMaps[j].map.invalidateSize();
                    if (typeof fnAirspaceMaps[j].refit === 'function') {
                        fnAirspaceMaps[j].refit();
                    }
                } catch (e) {}
            }
            await new Promise(function (r) {
                setTimeout(r, 150);
            });
            try {
                var h2cOpts =
                    typeof MapCapture !== 'undefined' && MapCapture.html2canvasOptions
                        ? MapCapture.html2canvasOptions('#f5f6f8', { scale: 1.5 })
                        : {
                              useCORS: true,
                              allowTaint: false,
                              scale: 1.5,
                              logging: false,
                              backgroundColor: '#f5f6f8'
                          };
                var canvas = await html2canvas(el, h2cOpts);
                var square = cropCanvasToSquare(canvas);
                pdfMapEntries.push({
                    url: square.toDataURL('image/png'),
                    pxW: square.width,
                    pxH: square.height
                });
            } catch (e) {
                console.warn('Flight Report: airspace map PDF capture failed', e);
                pdfMapEntries.push(null);
            }
        }

        var body = items.map(function (it) {
            var txt =
                it.kind === 'airspace'
                    ? buildAirspaceDetailPdfForRow('airspace', ll.lat, ll.lng, it.a, null)
                    : buildAirspaceDetailPdfForRow('notam', ll.lat, ll.lng, null, it.n);
            return ['', txt];
        });

        var ts = PdfTheme.tableStyles();
        var tableW = PdfTheme.pageWidthMm() - 20;
        var detailColW = tableW - MAP_COL_W;

        PdfTheme.newPage(doc);
        PdfTheme.addHeader(doc, 'Airspace & NOTAMs · ' + siteTitle + ' (' + rKm + ' km)', false);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(85, 85, 85);
        doc.text(
            'Centre: ' +
                ll.lat.toFixed(5) +
                ', ' +
                ll.lng.toFixed(5) +
                '. One row per restriction or NOTAM: map (left) and full details (right). Maps are indicative.',
            10,
            14
        );

        doc.autoTable({
            startY: 22,
            head: [['Map', 'Details']],
            body: body,
            tableWidth: tableW,
            columnStyles: {
                0: { cellWidth: MAP_COL_W },
                1: { cellWidth: detailColW }
            },
            headStyles: Object.assign({}, ts.headStyles, {
                minCellHeight: 6,
                valign: 'middle'
            }),
            bodyStyles: Object.assign({}, ts.bodyStyles, { valign: 'top' }),
            alternateRowStyles: ts.alternateRowStyles,
            styles: Object.assign({}, ts.styles, { minCellHeight: 26, valign: 'top' }),
            margin: ts.margin,
            tableLineColor: ts.tableLineColor,
            tableLineWidth: ts.tableLineWidth,
            didDrawCell: function (data) {
                if (data.section !== 'body' || data.column.index !== 0) return;
                var entry = pdfMapEntries[data.row.index];
                if (!entry || !entry.url) return;
                var pad = 1;
                var cellH = data.cell.height > 1 ? data.cell.height : 26;
                var maxBox = Math.min(
                    MAP_THUMB_MM,
                    data.cell.width - 2 * pad,
                    cellH - 2 * pad
                );
                if (maxBox <= 0) return;
                var dims = mapImageSizeMm(entry.pxW, entry.pxH, maxBox, maxBox);
                var innerW = data.cell.width - 2 * pad;
                var innerH = data.cell.height - 2 * pad;
                var drawX = data.cell.x + pad + (innerW - dims.w) / 2;
                var drawY = data.cell.y + pad + (innerH - dims.h) / 2;
                doc.addImage(entry.url, 'PNG', drawX, drawY, dims.w, dims.h);
            }
        });
    }

    /**
     * Fetch NOTAMs and UK zones for every mission site and append one PDF section per site
     * at the configured search radius.
     */
    async function appendAllMissionAirspaceSitesToFlightReportPdf(doc) {
        var sites = getMissionAirspaceSitesDeduped();
        var rKm = readFnAirspaceRadiusFromInput();
        fnAirspaceRadiusKm = rKm;
        var selAir = document.getElementById('fnAirspaceSiteSelect');
        var origSiteId = selAir && selAir.value ? selAir.value : 'primary';

        if (!sites.length) {
            fnAirspaceDataLoaded = false;
            return origSiteId;
        }

        var si;
        for (si = 0; si < sites.length; si++) {
            var sp = sites[si];
            destroyFnAirspaceMaps();
            try {
                var bundle = await fetchFnAirspaceNearPoint(sp.lat, sp.lng, rKm);
                await applyFnAirspaceBundleToUi(bundle.notams, bundle.airspace, sp.lat, sp.lng);
                await waitForFnAirspaceMapsReady(180);
                await appendAirspacePdfPages(doc, {
                    siteTitle: sp.label,
                    lat: sp.lat,
                    lng: sp.lng,
                    radiusKm: rKm,
                    notams: bundle.notams,
                    airspace: bundle.airspace
                });
            } catch (eSite) {
                console.warn('Flight Report: PDF airspace appendix failed for site', sp.id, eSite);
                appendAirspacePdfSiteErrorPage(
                    doc,
                    sp.label,
                    sp.lat,
                    sp.lng,
                    rKm,
                    eSite && eSite.message ? eSite.message : 'Failed to load airspace data.'
                );
            }
        }

        var restoreSite = null;
        var sj;
        for (sj = 0; sj < sites.length; sj++) {
            if (sites[sj].id === origSiteId) {
                restoreSite = sites[sj];
                break;
            }
        }
        if (!restoreSite) restoreSite = sites[0];
        destroyFnAirspaceMaps();
        try {
            var bundleRestore = await fetchFnAirspaceNearPoint(restoreSite.lat, restoreSite.lng, rKm);
            await applyFnAirspaceBundleToUi(
                bundleRestore.notams,
                bundleRestore.airspace,
                restoreSite.lat,
                restoreSite.lng
            );
            syncAllMissionSiteSelects(restoreSite.id);
        } catch (eRestore) {
            console.warn('Flight Report: airspace UI restore after PDF failed', eRestore);
            syncAllMissionSiteSelects(restoreSite.id);
        }

        return origSiteId;
    }

    /** Grow/shrink Conditions textarea to fit content (fetch + typing); cap height so very long notes scroll inside. */
    function autoResizeConditionsTextarea() {
        var ta = document.getElementById('fnWeather');
        if (!ta) return;
        ta.style.height = 'auto';
        var cap = Math.min(window.innerHeight * 0.85, 1400);
        var h = ta.scrollHeight;
        if (h > cap) {
            ta.style.height = cap + 'px';
            ta.style.overflowY = 'auto';
        } else {
            ta.style.height = h + 'px';
            ta.style.overflowY = 'hidden';
        }
    }

    function trimVal(id) {
        var el = document.getElementById(id);
        if (!el) return '';
        return String(el.value || '').trim();
    }

    function dash(s) {
        return s ? s : '-';
    }

    /** HTML date input is yyyy-mm-dd; exports show dd-mm-yyyy. */
    function formatDateForExportDdMmYyyy(isoOrEmpty) {
        var s = String(isoOrEmpty || '').trim();
        if (!s) return '';
        var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return m[3] + '-' + m[2] + '-' + m[1];
        return s;
    }

    /** Fit image into a max box (mm) without stretching; preserves aspect ratio. */
    function mapImageSizeMm(canvasW, canvasH, maxWMm, maxHMm) {
        if (!canvasW || !canvasH) return { w: maxWMm, h: maxHMm };
        var ar = canvasW / canvasH;
        var w = maxWMm;
        var h = w / ar;
        if (h > maxHMm) {
            h = maxHMm;
            w = h * ar;
        }
        return { w: w, h: h };
    }

    /** Same map centre as Flight Report mini-map, for email (mailto is plain text only; no embedded images). */
    function openStreetMapLink(lat, lng) {
        return (
            'https://www.openstreetmap.org/?mlat=' +
            encodeURIComponent(lat) +
            '&mlon=' +
            encodeURIComponent(lng) +
            '#map=16/' +
            lat +
            '/' +
            lng
        );
    }

    function fnPdfMixRgb(a, b, t) {
        return [
            Math.round(a[0] * (1 - t) + b[0] * t),
            Math.round(a[1] * (1 - t) + b[1] * t),
            Math.round(a[2] * (1 - t) + b[2] * t)
        ];
    }

    /** Section title row spanning both columns (Flight Report PDF). */
    function fnPdfBannerRow(title) {
        var c = PdfTheme.colors();
        return [
            {
                content: title,
                colSpan: 2,
                styles: {
                    fillColor: fnPdfMixRgb(c.surface, c.accent, 0.35),
                    textColor: c.text,
                    fontStyle: 'bold',
                    fontSize: 8.5,
                    cellPadding: { left: 4, right: 4, top: 2.5, bottom: 2.5 },
                    halign: 'left',
                    valign: 'middle'
                }
            }
        ];
    }

    /** Subtle body row tint by section (pairs with `rowSections` from buildFlightReportPdfTableBody). */
    function fnPdfBodyFillForSection(sectionKey) {
        var c = PdfTheme.colors();
        var light = c.bg[0] > 200;
        var tLo = light ? 0.06 : 0.12;
        var tHi = light ? 0.1 : 0.18;
        var blue = [95, 140, 230];
        var warm = [215, 125, 55];
        var green = [70, 145, 95];
        if (sectionKey === 'when') return fnPdfMixRgb(c.bg, c.accent, tLo);
        if (String(sectionKey).indexOf('site-') === 0) return fnPdfMixRgb(c.bg, blue, tLo);
        if (sectionKey === 'mission') return fnPdfMixRgb(c.bg, c.accent, tLo * 0.85);
        if (String(sectionKey).indexOf('battery-') === 0) return fnPdfMixRgb(c.bg, warm, tLo);
        if (sectionKey === 'conditions') return fnPdfMixRgb(c.bg, green, tLo);
        if (sectionKey === 'airspace') return fnPdfMixRgb(c.bg, blue, light ? 0.05 : 0.12);
        if (sectionKey === 'notes') return fnPdfMixRgb(c.bg, c.surface, light ? 0.4 : 0.25);
        return c.surface;
    }

    function formatFlightReportPilotForSummary(n) {
        var rp1 = trimVal('fnBattery' + n + 'Rp1');
        var rp2 = trimVal('fnBattery' + n + 'Rp2');
        if (rp1 && rp2) return rp1 + ' / ' + rp2;
        if (rp1) return rp1;
        if (rp2) return rp2;
        return '-';
    }

    /**
     * Compact summary rows for Flight Report PDF (one row per visible battery).
     * @returns {{ head: string[][], body: string[][] }}
     */
    function buildFlightReportPdfSummaryTable() {
        var rows = [];
        var dateStr = dash(formatDateForExportDdMmYyyy(trimVal('fnDate')));
        var battMax = getVisibleBatteryCount();
        var bn;
        for (bn = 1; bn <= battMax; bn++) {
            var b = 'fnBattery' + bn;
            rows.push([
                String(bn),
                formatFlightReportPilotForSummary(bn),
                dateStr,
                dash(trimVal(b + 'Uas')),
                dash(trimVal(b + 'Name')),
                dash(trimVal(b + 'Voltage')),
                dash(trimVal(b + 'FlightTime')),
                dash(trimVal(b + 'AmberMin')),
                dash(trimVal(b + 'RedMin'))
            ]);
        }
        return {
            head: [['Flight', 'Pilot / Observer', 'Date', 'UAS', 'Battery', 'Voltage', 'Duration', 'Min (Amber)', 'Min (Red)']],
            body: rows
        };
    }

    /**
     * PDF table body with section banners + parallel rowSections for styling.
     * @returns {{ body: Array, rowSections: string[], fieldColW: number }}
     */
    function buildFlightReportPdfTableBody() {
        var body = [];
        var rowSections = [];
        var fieldColW = 52;

        function pushRow(field, detail, section) {
            body.push([field, detail]);
            rowSections.push(section);
        }
        function pushBanner(title) {
            body.push(fnPdfBannerRow(title));
            rowSections.push('banner');
        }

        pushBanner('Schedule');
        pushRow('Date', dash(formatDateForExportDdMmYyyy(trimVal('fnDate'))), 'when');
        pushRow('Time', dash(trimVal('fnTime')), 'when');

        pushBanner('Site 1 (primary operational location)');
        pushRow('Site 1: label', dash(trimVal('fnLocationLabel')), 'site-1');
        pushRow('Site 1: address or coordinates', dash(trimVal('fnLocation')), 'site-1');
        var llPdf = parseLatLngFromLocationString(trimVal('fnLocation'));
        pushRow(
            'Site 1: map (OpenStreetMap)',
            llPdf ? openStreetMapLink(llPdf.lat, llPdf.lng) : '-',
            'site-1'
        );

        var exPdf = serializeExtraLocations();
        for (var ei = 0; ei < exPdf.length; ei++) {
            var siteNum = ei + 2;
            var sk = 'site-' + siteNum;
            var userLab = String(exPdf[ei].label || '').trim();
            var bannerTitle =
                'Site ' +
                siteNum +
                (userLab ? ': ' + userLab : ' (additional operational location)');
            pushBanner(bannerTitle);
            pushRow('Site ' + siteNum + ': label', dash(exPdf[ei].label || '-'), sk);
            pushRow('Site ' + siteNum + ': address or coordinates', dash(exPdf[ei].text || '-'), sk);
            var llExP = parseLatLngFromLocationString(exPdf[ei].text || '');
            pushRow(
                'Site ' + siteNum + ': map (OpenStreetMap)',
                llExP ? openStreetMapLink(llExP.lat, llExP.lng) : '-',
                sk
            );
        }

        pushBanner('Mission');
        pushRow('Reference', dash(trimVal('fnReference')), 'mission');
        pushRow('Deconflictions', trimVal('fnDeconflictions') || '-', 'mission');

        var bn;
        var battMaxPdf = getVisibleBatteryCount();
        for (bn = 1; bn <= battMaxPdf; bn++) {
            var b = 'fnBattery' + bn;
            var bsec = 'battery-' + bn;
            pushBanner('Battery ' + bn);
            pushRow('Battery ' + bn + ': UAS Name', dash(trimVal(b + 'Uas')), bsec);
            pushRow('Battery ' + bn + ': Battery Name', dash(trimVal(b + 'Name')), bsec);
            pushRow('Battery ' + bn + ': site or coordinates', trimVal(b + 'Site') || '-', bsec);
            pushRow('Battery ' + bn + ': voltage', dash(trimVal(b + 'Voltage')), bsec);
            pushRow(
                'Battery ' + bn + ': max altitude (ft)',
                dash(trimVal(b + 'MaxAltFt') || FN_BATTERY_DEFAULT_MAX_ALT_FT),
                bsec
            );
            pushRow(
                'Battery ' + bn + ': max distance (m)',
                dash(trimVal(b + 'MaxDistM') || FN_BATTERY_DEFAULT_MAX_DIST_M),
                bsec
            );
            pushRow('Battery ' + bn + ': Remote Pilot 1', dash(trimVal(b + 'Rp1')), bsec);
            pushRow('Battery ' + bn + ': Remote Pilot 2', dash(trimVal(b + 'Rp2')), bsec);
            pushRow('Battery ' + bn + ': launch', dash(trimVal(b + 'Launch')), bsec);
            pushRow('Battery ' + bn + ': landing', dash(trimVal(b + 'Land')), bsec);
            pushRow('Battery ' + bn + ': flight time', dash(trimVal(b + 'FlightTime')), bsec);
            pushRow('Battery ' + bn + ': minutes (Amber)', dash(trimVal(b + 'AmberMin')), bsec);
            pushRow('Battery ' + bn + ': minutes (Red)', dash(trimVal(b + 'RedMin')), bsec);
            pushRow('Battery ' + bn + ': ALoS comments', trimVal(b + 'Alos') || '-', bsec);
        }

        var w = trimVal('fnWeather');
        pushBanner('Conditions');
        pushRow('Weather', w || '-', 'conditions');

        pushBanner('Airspace');
        pushRow('Airspace summary', fnAirspaceSummaryForExport(), 'airspace');

        pushBanner('Notes');
        pushRow('General notes', trimVal('fnNotes') || '-', 'notes');

        return { body: body, rowSections: rowSections, fieldColW: fieldColW };
    }

    /**
     * Plain-text block for email body (aligned with PDF section naming).
     */
    function buildNotesPlainText() {
        var lines = [];
        lines.push('AirPlan v1: Flight Report');
        lines.push('');

        lines.push('--- Schedule ---');
        lines.push('Date: ' + dash(formatDateForExportDdMmYyyy(trimVal('fnDate'))));
        lines.push('Time: ' + dash(trimVal('fnTime')));

        lines.push('');
        lines.push('--- Site 1 (primary operational location) ---');
        lines.push('Site 1 (label): ' + dash(trimVal('fnLocationLabel')));
        lines.push('Site 1 (address or coordinates): ' + dash(trimVal('fnLocation')));
        var llPlain = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (llPlain) {
            lines.push('Site 1 (map, OpenStreetMap): ' + openStreetMapLink(llPlain.lat, llPlain.lng));
        }

        var exLines = serializeExtraLocations();
        for (var ei = 0; ei < exLines.length; ei++) {
            var siteNum = ei + 2;
            var ex = exLines[ei];
            var userLab = String(ex.label || '').trim();
            lines.push('');
            lines.push(
                '--- Site ' +
                    siteNum +
                    (userLab ? ': ' + userLab : ' (additional operational location)') +
                    ' ---'
            );
            lines.push('Site ' + siteNum + ' (label): ' + dash(ex.label || '-'));
            lines.push('Site ' + siteNum + ' (address or coordinates): ' + dash(ex.text || '-'));
            var llEx = parseLatLngFromLocationString(ex.text || '');
            if (llEx) {
                lines.push(
                    'Site ' + siteNum + ' (map, OpenStreetMap): ' + openStreetMapLink(llEx.lat, llEx.lng)
                );
            }
        }

        lines.push('');
        lines.push('--- Mission ---');
        lines.push('Reference: ' + dash(trimVal('fnReference')));
        lines.push('Deconflictions:');
        lines.push(trimVal('fnDeconflictions') || '-');

        var bn;
        var battMax = getVisibleBatteryCount();
        for (bn = 1; bn <= battMax; bn++) {
            var b = 'fnBattery' + bn;
            lines.push('');
            lines.push('--- Battery ' + bn + ' ---');
            lines.push('Battery ' + bn + ' (UAS Name): ' + dash(trimVal(b + 'Uas')));
            lines.push('Battery ' + bn + ' (Battery Name): ' + dash(trimVal(b + 'Name')));
            lines.push('Battery ' + bn + ' (site or coordinates): ' + dash(trimVal(b + 'Site')));
            lines.push('Battery ' + bn + ' (voltage): ' + dash(trimVal(b + 'Voltage')));
            lines.push(
                'Battery ' + bn + ' (max altitude, ft): ' + dash(trimVal(b + 'MaxAltFt') || FN_BATTERY_DEFAULT_MAX_ALT_FT)
            );
            lines.push(
                'Battery ' + bn + ' (max distance, m): ' + dash(trimVal(b + 'MaxDistM') || FN_BATTERY_DEFAULT_MAX_DIST_M)
            );
            lines.push('Battery ' + bn + ' (Remote Pilot 1): ' + dash(trimVal(b + 'Rp1')));
            lines.push('Battery ' + bn + ' (Remote Pilot 2): ' + dash(trimVal(b + 'Rp2')));
            lines.push('Battery ' + bn + ' (launch): ' + dash(trimVal(b + 'Launch')));
            lines.push('Battery ' + bn + ' (landing): ' + dash(trimVal(b + 'Land')));
            lines.push('Battery ' + bn + ' (flight time): ' + dash(trimVal(b + 'FlightTime')));
            lines.push('Battery ' + bn + ' (minutes, Amber): ' + dash(trimVal(b + 'AmberMin')));
            lines.push('Battery ' + bn + ' (minutes, Red): ' + dash(trimVal(b + 'RedMin')));
            lines.push('Battery ' + bn + ' (ALoS comments): ' + dash(trimVal(b + 'Alos').replace(/\n/g, ' ')));
        }

        lines.push('');
        lines.push('--- Conditions ---');
        lines.push('Weather: ' + dash(trimVal('fnWeather').replace(/\n/g, ' ')));
        lines.push('');
        lines.push('--- Airspace ---');
        lines.push('Airspace summary: ' + fnAirspaceSummaryForExport());
        lines.push('');
        lines.push('--- Notes ---');
        lines.push(trimVal('fnNotes') || '-');

        return lines.join('\n');
    }

    // ---- Open-Meteo (same API as js/weather.js, Flight Weather) ----

    var OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
    var HOURLY_PARAMS =
        'wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_120m,wind_direction_120m,visibility,cloud_cover,cloud_cover_low,precipitation,precipitation_probability,temperature_2m';
    var FS = FlightSuitability;
    var GUST_120M_MULTIPLIER = FS.GUST_120M_MULTIPLIER;
    var WX_MODEL_LABELS = {
        auto: 'Best match',
        ecmwf_ifs: 'ECMWF IFS (EU)',
        gfs_seamless: 'GFS (NOAA, US)',
        ukmo_seamless: 'UK Met Office',
        gem_global: 'GEM (Canada)'
    };

    /**
     * Extract WGS84 lat/lng from a free-text location field.
     * Prefer leading "lat, lng" (format written by Search / GPS), then the segment
     * before " · " when it is exactly one pair (coordinates + Postcode metadata).
     * Otherwise avoid the common false positive "12, 34" inside addresses by
     * taking the last pair that does not look like two small whole street numbers.
     */
    function parseLatLngFromLocationString(s) {
        if (!s || !String(s).trim()) return null;
        var str = String(s).trim().replace(/\u2212/g, '-');
        var pairCore = '(-?\\d{1,3}(?:\\.\\d+)?)\\s*,\\s*(-?\\d{1,3}(?:\\.\\d+)?)';
        function fromMatch(m) {
            if (!m) return null;
            var lat = parseFloat(m[1]);
            var lng = parseFloat(m[2]);
            if (isNaN(lat) || isNaN(lng)) return null;
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
            return { lat: lat, lng: lng };
        }
        var mLead = str.match(new RegExp('^\\s*' + pairCore));
        var rLead = fromMatch(mLead);
        if (rLead) return rLead;
        var dotParts = str.split(/\s*·\s*/);
        if (dotParts.length > 1 && dotParts[0]) {
            var head = dotParts[0].trim();
            var mHead = head.match(new RegExp('^' + pairCore + '$'));
            var rHead = fromMatch(mHead);
            if (rHead) return rHead;
        }
        function looksLikeTinyStreetNumberPair(lat, lng) {
            return (
                Math.abs(lat) < 20 &&
                Math.abs(lng) < 20 &&
                lat === Math.round(lat) &&
                lng === Math.round(lng)
            );
        }
        var re = new RegExp(pairCore, 'g');
        var m;
        var lastNonTiny = null;
        while ((m = re.exec(str)) !== null) {
            var cand = fromMatch(m);
            if (!cand) continue;
            if (!looksLikeTinyStreetNumberPair(cand.lat, cand.lng)) lastNonTiny = cand;
        }
        if (lastNonTiny) return lastNonTiny;
        return fromMatch(str.match(new RegExp(pairCore)));
    }

    /** Postcode suffix from resolved location string (Search / GPS), if present. */
    function extractPostcodeFromLocationField(s) {
        if (!s || !String(s).trim()) return null;
        var m = String(s).match(/Postcode:\s*([^·\n\r]+)/i);
        if (!m) return null;
        var t = m[1].trim();
        return t || null;
    }

    function getTargetTimeMsFromForm() {
        var d = trimVal('fnDate');
        var t = trimVal('fnTime');
        if (d && t) {
            var ms = new Date(d + 'T' + t + ':00').getTime();
            if (!isNaN(ms)) return ms;
        }
        return null;
    }

    function directionToCardinal(deg) {
        if (deg == null || isNaN(deg)) return '-';
        var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        var idx = Math.round(((deg % 360) / 22.5)) % 16;
        return dirs[idx];
    }

    function formatVisibility(m) {
        return FS.formatVisibility(m);
    }

    function formatWindRow(speed, dir) {
        if (speed == null || isNaN(speed)) return '-';
        return Math.round(speed) + ' km/h ' + directionToCardinal(dir);
    }

    function deriveSuitability(data) {
        return FS.deriveSuitability(data);
    }

    function deriveSummaryText(hourlySlice, suitability) {
        if (!hourlySlice || !hourlySlice.hourly) return '';
        var h = hourlySlice.hourly;
        var start = hourlySlice.startIdx;
        var timeLen = (h.time && h.time.length) || 0;
        var count = Math.min(12, timeLen - start);
        if (count <= 0) return '';

        function sliceFilter(key, pred) {
            var arr = h[key] || [];
            var seg = arr.slice(start, start + count);
            var out = [];
            for (var i = 0; i < seg.length; i++) {
                if (pred(seg[i])) out.push(seg[i]);
            }
            return out;
        }

        var w10 = sliceFilter('wind_speed_10m', function (v) {
            return v != null;
        });
        var gusts10 = sliceFilter('wind_gusts_10m', function (v) {
            return v != null;
        });
        var w120 = sliceFilter('wind_speed_120m', function (v) {
            return v != null;
        });
        var vis = sliceFilter('visibility', function (v) {
            return v != null;
        });
        var precip = sliceFilter('precipitation', function (v) {
            return v != null && v > 0;
        });

        var w10Min = w10.length ? Math.min.apply(Math, w10) : null;
        var w10Max = w10.length ? Math.max.apply(Math, w10) : null;
        var gustsMax = gusts10.length ? Math.max.apply(Math, gusts10) : null;
        var w120Max = w120.length ? Math.max.apply(Math, w120) : null;
        var visMin = vis.length ? Math.min.apply(Math, vis) : null;
        var visMax = vis.length ? Math.max.apply(Math, vis) : null;

        var parts = [];
        if (w10Min != null && w10Max != null) {
            if (w10Min === w10Max) parts.push('Sustained 10 m: ' + Math.round(w10Max) + ' km/h');
            else parts.push('Sustained 10 m: ' + Math.round(w10Min) + '-' + Math.round(w10Max) + ' km/h');
        }
        if (gustsMax != null) parts.push('Gusts 10 m: up to ' + Math.round(gustsMax) + ' km/h');
        if (w120Max != null) {
            parts.push('Sustained 120 m: up to ' + Math.round(w120Max) + ' km/h');
            parts.push('Gusts 120 m (est.): up to ' + Math.round(w120Max * GUST_120M_MULTIPLIER) + ' km/h');
        }
        if (visMin != null && visMax != null) {
            var vMin = visMin >= 10000 ? (visMin / 1000).toFixed(1) + ' km' : Math.round(visMin) + ' m';
            var vMax = visMax >= 10000 ? (visMax / 1000).toFixed(1) + ' km' : Math.round(visMax) + ' m';
            if (vMin === vMax) parts.push('Visibility: ' + vMax);
            else parts.push('Visibility: ' + vMin + ' to ' + vMax);
        }
        if (precip.length > 0) {
            var total = 0;
            for (var pi = 0; pi < precip.length; pi++) total += precip[pi];
            parts.push('Precipitation: ' + Math.round(total * 10) / 10 + ' mm expected');
        } else parts.push('No precipitation expected');

        return parts.join('. ') + '.';
    }

    function fetchOpenMeteoForPoint(lat, lng, targetTimestampMs) {
        var params = new URLSearchParams({
            latitude: lat.toFixed(4),
            longitude: lng.toFixed(4),
            hourly: HOURLY_PARAMS,
            forecast_days: '16',
            timezone: 'auto'
        });
        return fetch(OPEN_METEO_BASE + '?' + params.toString())
            .then(function (r) {
                if (!r.ok) throw new Error('Weather service unavailable');
                return r.json();
            })
            .then(function (data) {
                if (!data.hourly || !data.hourly.time || !data.hourly.time.length) {
                    throw new Error('No weather data returned');
                }
                var times = data.hourly.time;
                var useNow = targetTimestampMs === null || isNaN(targetTimestampMs);
                var bestIdx = 0;
                if (useNow) {
                    var now = Date.now();
                    var startIdx = 0;
                    for (var i = 0; i < times.length; i++) {
                        var t = new Date(times[i]).getTime();
                        if (t <= now) startIdx = i;
                    }
                    bestIdx = startIdx;
                } else {
                    var target = targetTimestampMs;
                    var bestDiff = Infinity;
                    for (var j = 0; j < times.length; j++) {
                        var tj = new Date(times[j]).getTime();
                        var diff = Math.abs(tj - target);
                        if (diff < bestDiff) {
                            bestDiff = diff;
                            bestIdx = j;
                        }
                    }
                }
                var weatherData = {};
                var keys = Object.keys(data.hourly);
                for (var k = 0; k < keys.length; k++) {
                    var key = keys[k];
                    if (key !== 'time' && Array.isArray(data.hourly[key])) {
                        weatherData[key] = data.hourly[key][bestIdx];
                    }
                }
                var displayTime = times[bestIdx];
                var hourlySlice = { startIdx: bestIdx, count: 12, hourly: data.hourly };
                return {
                    weatherData: weatherData,
                    displayTime: displayTime,
                    hourlySlice: hourlySlice,
                    model: 'auto'
                };
            });
    }

    function buildWeatherReportText(data, displayTime, hourlySlice, model, lat, lng, usedTargetTime) {
        var suitability = deriveSuitability(data);
        var summaryText = deriveSummaryText(hourlySlice, suitability);
        var modelLabel = WX_MODEL_LABELS[model] || model;

        var gusts = data.wind_gusts_10m;
        var gustsStr = gusts != null ? Math.round(gusts) + ' km/h' : '-';
        var wind120Str = formatWindRow(data.wind_speed_120m, data.wind_direction_120m);
        var gusts120 =
            data.wind_speed_120m != null ? Math.round(data.wind_speed_120m * GUST_120M_MULTIPLIER) + ' km/h' : '-';

        var cloudTotal = data.cloud_cover;
        var cloudLow = data.cloud_cover_low;
        var cloudStr = '-';
        if (cloudTotal != null) {
            cloudStr =
                cloudLow != null
                    ? Math.round(cloudTotal) + '% total, ' + Math.round(cloudLow) + '% low'
                    : Math.round(cloudTotal) + '%';
        }

        var precip = data.precipitation;
        var precipProb = data.precipitation_probability;
        var precipStr = '-';
        if (precip != null) {
            precipStr =
                precipProb != null
                    ? Math.round(precip * 10) / 10 + ' mm (' + Math.round(precipProb) + '% chance)'
                    : Math.round(precip * 10) / 10 + ' mm';
        }

        var temp = data.temperature_2m;
        var tempStr = temp != null ? Math.round(temp) + ' °C' : '-';

        var lines = [];
        lines.push('--- Forecast (selected hour) ---');
        lines.push('10 m wind: ' + formatWindRow(data.wind_speed_10m, data.wind_direction_10m));
        lines.push('10 m gusts: ' + gustsStr);
        lines.push('120 m wind: ' + wind120Str);
        lines.push('120 m gusts (est.): ' + gusts120);
        lines.push('Visibility: ' + formatVisibility(data.visibility));
        lines.push('Cloud cover: ' + cloudStr);
        lines.push('Precipitation: ' + precipStr);
        lines.push('Temperature (2 m): ' + tempStr);
        if (summaryText) {
            lines.push('');
            lines.push('--- Next 12 hours (range from selected hour) ---');
            lines.push(summaryText);
        }
        lines.push('');
        lines.push('--- Assessment ---');
        lines.push(suitability.label + ': ' + suitability.brief);
        lines.push('');
        lines.push('--- How this is calculated ---');
        if (suitability.technical) lines.push(suitability.technical);
        lines.push('');
        FS.buildWeatherRagMethodologyPlainLines(usedTargetTime, 'flightReport').forEach(function (ln) {
            lines.push(ln);
        });
        lines.push('');
        lines.push('--- Source ---');
        lines.push('Open-Meteo forecast (Flight Weather source)');
        lines.push('Coordinates: ' + lat.toFixed(6) + ', ' + lng.toFixed(6));
        lines.push(
            'Forecast hour: ' +
                (displayTime || '-') +
                (usedTargetTime ? ' (from Date/Time fields)' : ' (current time)')
        );
        lines.push('Model: ' + modelLabel);
        lines.push('');
        lines.push('Data: Open-Meteo https://open-meteo.com/ (CC BY 4.0)');
        return lines.join('\n');
    }

    function setWeatherFetchStatus(message, kind) {
        var el = document.getElementById('fnWeatherFetchStatus');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'fn-weather-fetch-status';
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    async function onWeatherFetchClick() {
        var btn = document.getElementById('fnWeatherFetchBtn');
        var ta = document.getElementById('fnWeather');
        if (!ta) return;
        syncAllMissionSiteSelects();
        var site = getFnWeatherSelectedSiteFromUi();
        if (!site) {
            setWeatherFetchStatus(
                'Resolve coordinates in Location (or an additional site) first.',
                'error'
            );
            return;
        }
        var targetMs = getTargetTimeMsFromForm();
        var usedTarget = targetMs != null && !isNaN(targetMs);

        setWeatherFetchStatus('Fetching…', '');
        if (btn) {
            btn.disabled = true;
            btn.dataset.fetching = '1';
        }
        try {
            var result = await fetchOpenMeteoForPoint(site.lat, site.lng, targetMs);
            var block = buildWeatherReportText(
                result.weatherData,
                result.displayTime,
                result.hourlySlice,
                result.model,
                site.lat,
                site.lng,
                usedTarget
            );
            var existing = trimVal('fnWeather');
            var sep =
                '\n\n--- Open-Meteo: ' + site.label + ' · ' + result.displayTime + ' ---\n';
            if (existing) {
                ta.value = existing + sep + block;
            } else {
                ta.value = block;
            }
            setWeatherFetchStatus('Report added to Conditions.', 'ok');
            autoResizeConditionsTextarea();
            saveFlightNotesDraft();
        } catch (err) {
            console.error('Flight Report weather fetch failed:', err);
            setWeatherFetchStatus(err && err.message ? err.message : 'Failed to fetch weather.', 'error');
        } finally {
            if (btn) {
                delete btn.dataset.fetching;
            }
            syncFnWeatherFetchUiState();
        }
    }

    function setNowDateTime() {
        var now = new Date();
        var dateEl = document.getElementById('fnDate');
        var timeEl = document.getElementById('fnTime');
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var d = String(now.getDate()).padStart(2, '0');
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        if (dateEl) dateEl.value = y + '-' + m + '-' + d;
        if (timeEl) timeEl.value = hh + ':' + mm;
        syncManualSelectsFromDateInput();
        var hintNow = document.getElementById('fnDateManualHint');
        if (hintNow) {
            hintNow.textContent = '';
            hintNow.classList.add('hidden');
        }
        saveFlightNotesDraft();
    }

    function setTodayDate() {
        var now = new Date();
        var dateEl = document.getElementById('fnDate');
        if (!dateEl) return;
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var d = String(now.getDate()).padStart(2, '0');
        dateEl.value = y + '-' + m + '-' + d;
        syncManualSelectsFromDateInput();
        var hintT = document.getElementById('fnDateManualHint');
        if (hintT) {
            hintT.textContent = '';
            hintT.classList.add('hidden');
        }
        saveFlightNotesDraft();
    }

    function openFnDatePicker() {
        var dateEl = document.getElementById('fnDate');
        if (!dateEl) return;
        /* iPadOS often reports MacIntel + touch; showPicker may exist but no-op or throw. */
        var isIOSLike =
            /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        function focusDate() {
            try {
                dateEl.focus({ preventScroll: true });
            } catch (e2) {
                dateEl.focus();
            }
        }
        if (isIOSLike) {
            focusDate();
            dateEl.click();
            return;
        }
        if (typeof dateEl.showPicker === 'function') {
            try {
                dateEl.showPicker();
                return;
            } catch (e) {
                /* InvalidStateError / NotSupportedError - fall through */
            }
        }
        focusDate();
        dateEl.click();
    }

    var FN_MONTH_NAMES = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December'
    ];

    function fnDaysInMonth(year, month1to12) {
        return new Date(year, month1to12, 0).getDate();
    }

    function initFnManualDateSelects() {
        var daySel = document.getElementById('fnDateManualDay');
        var monthSel = document.getElementById('fnDateManualMonth');
        var yearSel = document.getElementById('fnDateManualYear');
        if (!daySel || !monthSel || !yearSel) return;
        var i, opt;
        daySel.innerHTML = '';
        for (i = 1; i <= 31; i++) {
            opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = String(i);
            daySel.appendChild(opt);
        }
        monthSel.innerHTML = '';
        for (i = 0; i < 12; i++) {
            opt = document.createElement('option');
            opt.value = String(i + 1);
            opt.textContent = FN_MONTH_NAMES[i];
            monthSel.appendChild(opt);
        }
        var y0 = new Date().getFullYear();
        yearSel.innerHTML = '';
        for (i = y0 - 10; i <= y0 + 10; i++) {
            opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = String(i);
            yearSel.appendChild(opt);
        }
    }

    function ensureYearInManualSelect(yearSel, y) {
        var ys = String(y);
        if (yearSel.querySelector('option[value="' + ys + '"]')) {
            yearSel.value = ys;
            return;
        }
        var opt = document.createElement('option');
        opt.value = ys;
        opt.textContent = ys;
        yearSel.appendChild(opt);
        var opts = Array.prototype.slice.call(yearSel.options);
        opts.sort(function (a, b) {
            return parseInt(a.value, 10) - parseInt(b.value, 10);
        });
        yearSel.innerHTML = '';
        for (var j = 0; j < opts.length; j++) {
            yearSel.appendChild(opts[j]);
        }
        yearSel.value = ys;
    }

    function syncManualSelectsFromDateInput() {
        var dateEl = document.getElementById('fnDate');
        var daySel = document.getElementById('fnDateManualDay');
        var monthSel = document.getElementById('fnDateManualMonth');
        var yearSel = document.getElementById('fnDateManualYear');
        if (!dateEl || !daySel || !monthSel || !yearSel) return;
        var v = dateEl.value;
        if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
        var parts = v.split('-');
        var y = parseInt(parts[0], 10);
        var mo = parseInt(parts[1], 10);
        var da = parseInt(parts[2], 10);
        if (isNaN(y) || isNaN(mo) || isNaN(da)) return;
        ensureYearInManualSelect(yearSel, y);
        var dim = fnDaysInMonth(y, mo);
        if (da > dim) da = dim;
        daySel.value = String(da);
        monthSel.value = String(mo);
        yearSel.value = String(y);
    }

    function applyManualSelectsToDateInput() {
        var dateEl = document.getElementById('fnDate');
        var daySel = document.getElementById('fnDateManualDay');
        var monthSel = document.getElementById('fnDateManualMonth');
        var yearSel = document.getElementById('fnDateManualYear');
        var hintEl = document.getElementById('fnDateManualHint');
        if (!dateEl || !daySel || !monthSel || !yearSel) return;
        var d = parseInt(daySel.value, 10);
        var m = parseInt(monthSel.value, 10);
        var y = parseInt(yearSel.value, 10);
        if (isNaN(d) || isNaN(m) || isNaN(y)) return;
        var dim = fnDaysInMonth(y, m);
        var clamped = false;
        if (d > dim) {
            d = dim;
            clamped = true;
            daySel.value = String(d);
        }
        var mm = String(m).padStart(2, '0');
        var dd = String(d).padStart(2, '0');
        var iso = y + '-' + mm + '-' + dd;
        if (dateEl.value !== iso) dateEl.value = iso;
        if (hintEl) {
            if (clamped) {
                hintEl.textContent = 'Day adjusted to last day of that month.';
                hintEl.classList.remove('hidden');
            } else {
                hintEl.textContent = '';
                hintEl.classList.add('hidden');
            }
        }
        saveFlightNotesDraft();
    }

    function parseHmToMinutes(hhmm) {
        if (!hhmm || !/^\d{1,2}:\d{2}$/.test(String(hhmm).trim())) return null;
        var p = String(hhmm).trim().split(':');
        var h = parseInt(p[0], 10);
        var m = parseInt(p[1], 10);
        if (isNaN(h) || isNaN(m) || h > 23 || m > 59) return null;
        return h * 60 + m;
    }

    function formatFlightDurationMins(totalMins) {
        if (totalMins == null || totalMins < 0) return '';
        var h = Math.floor(totalMins / 60);
        var m = totalMins % 60;
        if (h && m) return h + 'h ' + m + 'm';
        if (h) return h + 'h';
        return m + 'm';
    }

    function updateBatteryFlightTimeForIndex(n) {
        var launch = document.getElementById('fnBattery' + n + 'Launch');
        var land = document.getElementById('fnBattery' + n + 'Land');
        var out = document.getElementById('fnBattery' + n + 'FlightTime');
        if (!launch || !land || !out) return;
        var a = parseHmToMinutes(launch.value);
        var b = parseHmToMinutes(land.value);
        if (a == null || b == null) {
            out.value = '';
            return;
        }
        var d = b - a;
        if (d < 0) d += 24 * 60;
        out.value = formatFlightDurationMins(d);
        if (isBatteryCollapsed(n)) updateBatteryCollapsedSummary(n);
    }

    function updateAllBatteryFlightTimes() {
        var n;
        for (n = 1; n <= FN_BATTERY_MAX; n++) updateBatteryFlightTimeForIndex(n);
    }

    function setTimeInputNow(inputId) {
        var el = document.getElementById(inputId);
        if (!el) return;
        var now = new Date();
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        el.value = hh + ':' + mm;
        var bm = String(inputId).match(/^fnBattery(\d+)(Launch|Land)$/);
        if (bm) {
            var idx = parseInt(bm[1], 10);
            if (idx >= 1 && idx <= FN_BATTERY_MAX) updateBatteryFlightTimeForIndex(idx);
        }
        saveFlightNotesDraft();
    }

    function setGpsStatus(message, kind) {
        var el = document.getElementById('fnGpsStatus');
        if (!el) return;
        el.textContent = message || '';
        el.classList.remove('fn-gps-error', 'fn-gps-ok');
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    function destroyLeafletMapInstance(m) {
        if (!m) return;
        try {
            m.remove();
        } catch (e) {}
    }

    function destroyMiniMap() {
        destroyLeafletMapInstance(miniMap);
        miniMap = null;
    }

    function hideLocationResult() {
        var wrap = document.getElementById('fnLocationResult');
        if (wrap) wrap.hidden = true;
        destroyMiniMap();
        var pc = document.getElementById('fnPostcodeDisplay');
        if (pc) pc.textContent = '-';
    }

    function scheduleSyncLocationPreviewFromField() {
        if (fnLocationPreviewTimer) clearTimeout(fnLocationPreviewTimer);
        fnLocationPreviewTimer = setTimeout(function () {
            fnLocationPreviewTimer = null;
            syncLocationPreviewFromField();
        }, 300);
    }

    function syncLocationPreviewFromField() {
        var ll = parseLatLngFromLocationString(trimVal('fnLocation'));
        var wrap = document.getElementById('fnLocationResult');
        var pcDisp = document.getElementById('fnPostcodeDisplay');
        if (!wrap) return;
        if (ll) {
            wrap.hidden = false;
            var extracted = extractPostcodeFromLocationField(trimVal('fnLocation'));
            if (pcDisp) pcDisp.textContent = extracted || '-';
            initMiniMap(ll.lat, ll.lng);
        } else {
            hideLocationResult();
        }
        updateBatterySiteDatalist();
    }

    /**
     * Reverse geocode via OpenStreetMap Nominatim (postcode where available).
     * See https://operations.osmfoundation.org/policies/nominatim/
     */
    function reversePostcode(lat, lng) {
        var url =
            'https://nominatim.openstreetmap.org/reverse?lat=' +
            encodeURIComponent(lat) +
            '&lon=' +
            encodeURIComponent(lng) +
            '&format=json&addressdetails=1';
        return fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            mode: 'cors'
        })
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .then(function (data) {
                if (!data || !data.address) return null;
                var a = data.address;
                return a.postcode || a.postal_code || null;
            })
            .catch(function () {
                return null;
            });
    }

    function createLeafletMiniMap(containerEl, lat, lng) {
        if (!containerEl || typeof L === 'undefined') return null;
        var m = L.map(containerEl, {
            zoomControl: true,
            attributionControl: true
        }).setView([lat, lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
            maxZoom: 19,
            crossOrigin: true
        }).addTo(m);
        L.marker([lat, lng]).addTo(m);
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (m) m.invalidateSize();
            });
        });
        setTimeout(function () {
            if (m) m.invalidateSize();
        }, 200);
        return m;
    }

    function initMiniMap(lat, lng) {
        destroyMiniMap();
        var el = document.getElementById('fnMiniMap');
        if (!el) return;
        miniMap = createLeafletMiniMap(el, lat, lng);
    }

    function setExtraLocGlobalStatus(message, kind) {
        var el = document.getElementById('fnExtraLocGlobalStatus');
        if (!el) return;
        el.textContent = message || '';
        el.classList.remove('fn-gps-error', 'fn-gps-ok');
        if (kind === 'error') el.classList.add('fn-gps-error');
        if (kind === 'ok') el.classList.add('fn-gps-ok');
    }

    function setExtraRowStatus(row, message, kind) {
        if (!row || !row.statusEl) return;
        row.statusEl.textContent = message || '';
        row.statusEl.classList.remove('fn-gps-error', 'fn-gps-ok');
        if (kind === 'error') row.statusEl.classList.add('fn-gps-error');
        if (kind === 'ok') row.statusEl.classList.add('fn-gps-ok');
    }

    function clearExtraRowPreviewTimer(row) {
        if (!row || row._previewTid == null) return;
        var t = fnExtraLocPreviewTimers[row._previewTid];
        if (t) clearTimeout(t);
        delete fnExtraLocPreviewTimers[row._previewTid];
    }

    function scheduleSyncExtraRowFromField(row) {
        if (!row) return;
        if (row._previewTid == null) row._previewTid = ++fnExtraRowPreviewIdCounter;
        var tid = row._previewTid;
        if (fnExtraLocPreviewTimers[tid]) clearTimeout(fnExtraLocPreviewTimers[tid]);
        fnExtraLocPreviewTimers[tid] = setTimeout(function () {
            delete fnExtraLocPreviewTimers[tid];
            syncExtraRowMapPreview(row);
        }, 300);
    }

    function syncExtraRowMapPreview(row) {
        if (!row) return;
        destroyLeafletMapInstance(row.map);
        row.map = null;
        var ll = parseLatLngFromLocationString(String(row.textInput.value || '').trim());
        if (!row.resultWrap || !row.mapEl || !row.pcEl) return;
        if (ll) {
            row.resultWrap.hidden = false;
            var extracted = extractPostcodeFromLocationField(String(row.textInput.value || '').trim());
            row.pcEl.textContent = extracted || '-';
            row.map = createLeafletMiniMap(row.mapEl, ll.lat, ll.lng);
        } else {
            row.resultWrap.hidden = true;
            row.pcEl.textContent = '-';
        }
        syncFnAirspaceSiteSelectOptions();
    }

    function applyResolvedCoordsToExtraRow(row, lat, lng, postcodeHint, okMessage) {
        var loc = lat.toFixed(6) + ', ' + lng.toFixed(6);
        if (row.resultWrap) row.resultWrap.hidden = false;
        if (row.pcEl) row.pcEl.textContent = postcodeHint != null ? postcodeHint : '…';
        if (row.textInput) {
            row.textInput.value =
                postcodeHint != null && postcodeHint !== ''
                    ? loc + ' · Postcode: ' + postcodeHint
                    : loc;
        }
        saveFlightNotesDraft();
        setTimeout(function () {
            syncExtraRowMapPreview(row);
        }, 0);
        if (postcodeHint != null) {
            setExtraRowStatus(row, okMessage, 'ok');
            setExtraLocGlobalStatus('', '');
            updateBatterySiteDatalist();
        } else {
            setExtraRowStatus(row, 'Looking up postcode…', '');
            reversePostcode(lat, lng).then(function (pc) {
                if (!row.root || !row.root.parentNode) return;
                if (row.pcEl) row.pcEl.textContent = pc || '-';
                if (row.textInput && pc) {
                    row.textInput.value = loc + ' · Postcode: ' + pc;
                }
                setExtraRowStatus(row, okMessage, 'ok');
                saveFlightNotesDraft();
                updateBatterySiteDatalist();
            });
        }
    }

    function onExtraRowSearchClick(row) {
        var q = String(row.textInput.value || '').trim();
        if (!q) {
            setExtraRowStatus(row, 'Enter a postcode, address, or place to search.', 'error');
            return;
        }
        if (row.searchBtn) row.searchBtn.disabled = true;
        setExtraRowStatus(row, 'Searching…', '');
        nominatimSearch(q)
            .then(function (hit) {
                if (row.searchBtn) row.searchBtn.disabled = false;
                if (!hit) {
                    setExtraRowStatus(row, 'No results found.', 'error');
                    return;
                }
                var blat = parseFloat(hit.lat);
                var blng = parseFloat(hit.lon);
                if (isNaN(blat) || isNaN(blng)) {
                    setExtraRowStatus(row, 'Invalid result from search.', 'error');
                    return;
                }
                var pc = postcodeFromNominatimHit(hit);
                applyResolvedCoordsToExtraRow(row, blat, blng, pc, 'Location updated from search.');
            })
            .catch(function () {
                if (row.searchBtn) row.searchBtn.disabled = false;
                setExtraRowStatus(row, 'Search failed.', 'error');
            });
    }

    function onExtraRowGpsClick(row) {
        var blocked =
            typeof GeoLocate !== 'undefined' && GeoLocate.secureContextBlockedMessage
                ? GeoLocate.secureContextBlockedMessage()
                : null;
        if (blocked) {
            setExtraRowStatus(row, blocked, 'error');
            return;
        }
        if (!navigator.geolocation) {
            setExtraRowStatus(row, 'Geolocation is not available.', 'error');
            return;
        }
        if (row.gpsBtn) row.gpsBtn.disabled = true;
        setExtraRowStatus(row, 'Getting location…', '');

        function onOk(pos) {
            if (row.gpsBtn) row.gpsBtn.disabled = false;
            applyResolvedCoordsToExtraRow(row, pos.coords.latitude, pos.coords.longitude, null, 'Location updated from GPS.');
        }
        function onFail(err) {
            if (err && err.handledByIosStandalonePrompt) {
                if (row.gpsBtn) row.gpsBtn.disabled = false;
                setExtraRowStatus(row, '', '');
                return;
            }
            var msg;
            if (typeof GeoLocate !== 'undefined' && GeoLocate.geolocationErrorMessage) {
                msg = GeoLocate.geolocationErrorMessage(err);
            } else {
                msg = 'Could not get location.';
                if (err && err.code === 1) msg = 'Location permission denied.';
                else if (err && err.code === 2) msg = 'Location unavailable.';
                else if (err && err.code === 3) msg = 'Location request timed out.';
            }
            syncExtraRowMapPreview(row);
            if (row.gpsBtn) row.gpsBtn.disabled = false;
            setExtraRowStatus(row, msg, 'error');
        }

        if (typeof GeoLocate !== 'undefined' && GeoLocate.getCurrentPositionRobust) {
            GeoLocate.getCurrentPositionRobust(onOk, onFail);
        } else {
            navigator.geolocation.getCurrentPosition(onOk, onFail, {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 0
            });
        }
    }

    function removeExtraLocationRow(row) {
        var idx = fnExtraLocationRows.indexOf(row);
        if (idx < 0) return;
        clearExtraRowPreviewTimer(row);
        destroyLeafletMapInstance(row.map);
        row.map = null;
        if (row.root && row.root.parentNode) row.root.parentNode.removeChild(row.root);
        fnExtraLocationRows.splice(idx, 1);
        renumberExtraLocationTitles();
        syncFnAddExtraLocationButtonState();
        updateBatterySiteDatalist();
        saveFlightNotesDraft();
    }

    function renumberExtraLocationTitles() {
        var i;
        for (i = 0; i < fnExtraLocationRows.length; i++) {
            if (fnExtraLocationRows[i].titleEl) {
                fnExtraLocationRows[i].titleEl.textContent = 'Additional Location ' + (i + 1);
            }
        }
    }

    function syncFnAddExtraLocationButtonState() {
        var btn = document.getElementById('fnAddExtraLocationBtn');
        if (!btn) return;
        if (fnExtraLocationRows.length >= FN_EXTRA_LOC_MAX) {
            btn.disabled = true;
            btn.title = 'Maximum ' + FN_EXTRA_LOC_MAX + ' additional locations';
        } else {
            btn.disabled = false;
            btn.title = 'Add another resolved site with its own mini map';
        }
    }

    function serializeExtraLocations() {
        var out = [];
        var i;
        for (i = 0; i < fnExtraLocationRows.length; i++) {
            var r = fnExtraLocationRows[i];
            out.push({
                label: String(r.labelInput.value || '').trim(),
                text: String(r.textInput.value || '').trim()
            });
        }
        return out;
    }

    function clearAllExtraLocationRows() {
        while (fnExtraLocationRows.length) {
            var row = fnExtraLocationRows[0];
            clearExtraRowPreviewTimer(row);
            destroyLeafletMapInstance(row.map);
            row.map = null;
            if (row.root && row.root.parentNode) row.root.parentNode.removeChild(row.root);
            fnExtraLocationRows.shift();
        }
        syncFnAddExtraLocationButtonState();
        updateBatterySiteDatalist();
    }

    function deserializeExtraLocations(arr) {
        clearAllExtraLocationRows();
        if (!arr || !arr.length) {
            return;
        }
        var i;
        for (i = 0; i < arr.length && fnExtraLocationRows.length < FN_EXTRA_LOC_MAX; i++) {
            var item = arr[i];
            addExtraLocationRow(false);
            var row = fnExtraLocationRows[fnExtraLocationRows.length - 1];
            if (item && item.label != null) row.labelInput.value = String(item.label);
            if (item && item.text != null) row.textInput.value = String(item.text);
            syncExtraRowMapPreview(row);
        }
        syncFnAddExtraLocationButtonState();
        updateBatterySiteDatalist();
    }

    function updateBatterySiteDatalist() {
        var dl = document.getElementById('fnBatterySiteDatalist');
        if (!dl) return;
        dl.innerHTML = '';
        var mainLl = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (mainLl) {
            var o0 = document.createElement('option');
            var mainLab = trimVal('fnLocationLabel');
            var prefix = mainLab || 'Main location';
            o0.value =
                prefix + ': ' + mainLl.lat.toFixed(5) + ', ' + mainLl.lng.toFixed(5);
            dl.appendChild(o0);
        }
        var ri;
        for (ri = 0; ri < fnExtraLocationRows.length; ri++) {
            var row = fnExtraLocationRows[ri];
            var raw = String(row.textInput.value || '').trim();
            if (!raw) continue;
            var ll = parseLatLngFromLocationString(raw);
            var lab =
                String(row.labelInput.value || '').trim() || 'Additional location ' + (ri + 1);
            var opt = document.createElement('option');
            opt.value = ll
                ? lab + ': ' + ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5)
                : lab + ': ' + raw.slice(0, 120);
            dl.appendChild(opt);
        }
        syncFnAirspaceSiteSelectOptions();
        syncBatterySiteFieldAffordance();
    }

    function syncBatterySiteFieldAffordance() {
        var dl = document.getElementById('fnBatterySiteDatalist');
        var nOpts = dl ? dl.querySelectorAll('option').length : 0;
        var showMulti = nOpts > 1;
        var i;
        for (i = 1; i <= FN_BATTERY_MAX; i++) {
            var inp = document.getElementById('fnBattery' + i + 'Site');
            var hint = document.getElementById('fnBattery' + i + 'SiteHint');
            if (!inp || !hint) continue;
            if (showMulti) {
                hint.classList.remove('hidden');
                hint.setAttribute('aria-hidden', 'false');
                inp.setAttribute('aria-describedby', 'fnBattery' + i + 'SiteHint');
                inp.title =
                    'Use the arrow in this field or start typing to pick a saved mission location, or enter your own text.';
            } else {
                hint.classList.add('hidden');
                hint.setAttribute('aria-hidden', 'true');
                inp.removeAttribute('aria-describedby');
                inp.removeAttribute('title');
            }
        }
    }

    function addExtraLocationRow(fromClick) {
        if (fnExtraLocationRows.length >= FN_EXTRA_LOC_MAX) {
            if (fromClick) setExtraLocGlobalStatus('Maximum ' + FN_EXTRA_LOC_MAX + ' additional locations.', 'error');
            return;
        }
        var listEl = document.getElementById('fnExtraLocationsList');
        if (!listEl) return;

        var root = document.createElement('div');
        root.className = 'fn-extra-loc-card';

        var titleEl = document.createElement('h4');
        titleEl.className = 'fn-extra-loc-title';
        titleEl.textContent = 'Additional Location ' + (fnExtraLocationRows.length + 1);

        var head = document.createElement('div');
        head.className = 'fn-extra-loc-card-head';

        var labelWrap = document.createElement('div');
        labelWrap.className = 'fn-field-grow';
        var labelLbl = document.createElement('label');
        labelLbl.className = 'fn-label';
        labelLbl.textContent = 'Label (Optional)';
        var labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'fn-input';
        labelInput.setAttribute('autocomplete', 'off');
        labelInput.placeholder = 'e.g. Secondary TOLA';
        labelWrap.appendChild(labelLbl);
        labelWrap.appendChild(labelInput);

        var textWrap = document.createElement('div');
        textWrap.className = 'fn-field-grow';
        var textLbl = document.createElement('label');
        textLbl.className = 'fn-label';
        textLbl.textContent = 'Address & Coordinates';
        var textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'fn-input';
        textInput.setAttribute('autocomplete', 'street-address');
        textInput.placeholder = 'Postcode, place, or lat, lng - then Search or GPS';
        textWrap.appendChild(textLbl);
        textWrap.appendChild(textInput);

        head.appendChild(titleEl);
        head.appendChild(labelWrap);
        head.appendChild(textWrap);

        var actions = document.createElement('div');
        actions.className = 'fn-extra-loc-actions';
        var searchBtn = document.createElement('button');
        searchBtn.type = 'button';
        searchBtn.className = 'fn-btn fn-btn-secondary';
        searchBtn.textContent = 'Search Location';
        var gpsBtn = document.createElement('button');
        gpsBtn.type = 'button';
        gpsBtn.className = 'fn-btn fn-btn-now';
        gpsBtn.textContent = 'Use Current GPS';
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'fn-btn fn-btn-secondary';
        removeBtn.textContent = 'Remove';
        var statusEl = document.createElement('span');
        statusEl.className = 'fn-extra-loc-status';
        statusEl.setAttribute('role', 'status');
        actions.appendChild(searchBtn);
        actions.appendChild(gpsBtn);
        actions.appendChild(removeBtn);
        actions.appendChild(statusEl);

        var resultWrap = document.createElement('div');
        resultWrap.className = 'fn-extra-loc-result';
        resultWrap.hidden = true;
        var pcLine = document.createElement('p');
        pcLine.className = 'fn-postcode-line';
        var pcLabel = document.createElement('span');
        pcLabel.className = 'fn-postcode-label';
        pcLabel.textContent = 'Postcode';
        var pcEl = document.createElement('span');
        pcEl.className = 'fn-postcode-value fn-extra-loc-pc';
        pcEl.textContent = '-';
        pcLine.appendChild(pcLabel);
        pcLine.appendChild(document.createTextNode(' '));
        pcLine.appendChild(pcEl);
        var mapWrap = document.createElement('div');
        mapWrap.className = 'fn-extra-loc-map-wrap';
        var mapEl = document.createElement('div');
        mapEl.className = 'fn-mini-map';
        mapEl.setAttribute('aria-label', 'Map centered on this additional location');
        mapWrap.appendChild(mapEl);
        resultWrap.appendChild(pcLine);
        resultWrap.appendChild(mapWrap);

        root.appendChild(head);
        root.appendChild(actions);
        root.appendChild(resultWrap);
        listEl.appendChild(root);

        var row = {
            root: root,
            titleEl: titleEl,
            labelInput: labelInput,
            textInput: textInput,
            searchBtn: searchBtn,
            gpsBtn: gpsBtn,
            removeBtn: removeBtn,
            statusEl: statusEl,
            resultWrap: resultWrap,
            mapEl: mapEl,
            pcEl: pcEl,
            map: null,
            _previewTid: null
        };
        fnExtraLocationRows.push(row);

        labelInput.addEventListener('input', function () {
            updateBatterySiteDatalist();
            scheduleFlightNotesDraftSave();
        });
        textInput.addEventListener('input', function () {
            scheduleSyncExtraRowFromField(row);
            updateBatterySiteDatalist();
            scheduleFlightNotesDraftSave();
        });

        searchBtn.addEventListener('click', function () {
            onExtraRowSearchClick(row);
        });
        gpsBtn.addEventListener('click', function () {
            onExtraRowGpsClick(row);
        });
        removeBtn.addEventListener('click', function () {
            removeExtraLocationRow(row);
        });

        renumberExtraLocationTitles();
        syncFnAddExtraLocationButtonState();
        if (fromClick) {
            setExtraLocGlobalStatus('', '');
            textInput.focus();
        }
        updateBatterySiteDatalist();
        saveFlightNotesDraft();
    }

    function postcodeFromNominatimHit(hit) {
        if (!hit || !hit.address) return null;
        var a = hit.address;
        return a.postcode || a.postal_code || null;
    }

    /**
     * OpenStreetMap Nominatim forward search (same policy as reverse geocode).
     */
    function nominatimSearch(query) {
        var url =
            'https://nominatim.openstreetmap.org/search?q=' +
            encodeURIComponent(query) +
            '&format=json&limit=1&addressdetails=1';
        return fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            mode: 'cors'
        })
            .then(function (res) {
                if (!res.ok) throw new Error('Search failed');
                return res.json();
            })
            .then(function (arr) {
                if (!arr || !arr.length) return null;
                return arr[0];
            });
    }

    /**
     * Show map, postcode line, and location field after coordinates are known (GPS or search).
     * @param {string|null} postcodeHint - if set, skips reverse geocode lookup
     */
    function showLocationResolved(lat, lng, postcodeHint, okMessage) {
        var input = document.getElementById('fnLocation');
        var wrap = document.getElementById('fnLocationResult');
        var pcDisp = document.getElementById('fnPostcodeDisplay');
        var loc = lat.toFixed(6) + ', ' + lng.toFixed(6);
        if (wrap) wrap.hidden = false;
        if (pcDisp) pcDisp.textContent = postcodeHint != null ? postcodeHint : '…';
        if (input) {
            input.value = postcodeHint != null ? loc + ' · Postcode: ' + postcodeHint : loc;
        }
        saveFlightNotesDraft();
        updateBatterySiteDatalist();
        setTimeout(function () {
            initMiniMap(lat, lng);
        }, 0);
        if (postcodeHint != null) {
            setGpsStatus(okMessage, 'ok');
        } else {
            setGpsStatus('Looking up postcode…', '');
            reversePostcode(lat, lng).then(function (pc) {
                if (pcDisp) pcDisp.textContent = pc || '-';
                if (input && pc) {
                    input.value = loc + ' · Postcode: ' + pc;
                }
                setGpsStatus(okMessage, 'ok');
                saveFlightNotesDraft();
                updateBatterySiteDatalist();
            });
        }
    }

    function onSearchLocationClick() {
        var q = trimVal('fnLocation');
        if (!q) {
            setGpsStatus('Enter a postcode, address, or place name to search.', 'error');
            return;
        }
        var btn = document.getElementById('fnSearchLocationBtn');
        if (btn) btn.disabled = true;
        setGpsStatus('Searching…', '');
        nominatimSearch(q)
            .then(function (hit) {
                if (btn) btn.disabled = false;
                if (!hit) {
                    setGpsStatus('No results found. Try a different search.', 'error');
                    return;
                }
                var lat = parseFloat(hit.lat);
                var lng = parseFloat(hit.lon);
                if (isNaN(lat) || isNaN(lng)) {
                    setGpsStatus('Invalid result from search.', 'error');
                    return;
                }
                var pc = postcodeFromNominatimHit(hit);
                showLocationResolved(lat, lng, pc, 'Location updated from search.');
            })
            .catch(function () {
                if (btn) btn.disabled = false;
                setGpsStatus('Search failed. Check your connection and try again.', 'error');
            });
    }

    function onGpsClick() {
        var blocked =
            typeof GeoLocate !== 'undefined' && GeoLocate.secureContextBlockedMessage
                ? GeoLocate.secureContextBlockedMessage()
                : null;
        if (blocked) {
            setGpsStatus(blocked, 'error');
            return;
        }
        if (!navigator.geolocation) {
            setGpsStatus('Geolocation is not available in this browser.', 'error');
            return;
        }
        var btn = document.getElementById('fnGpsBtn');
        if (btn) btn.disabled = true;
        setGpsStatus('Getting location…', '');

        function onOk(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            if (btn) btn.disabled = false;
            showLocationResolved(lat, lng, null, 'Location updated from GPS.');
        }
        function onFail(err) {
            hideLocationResult();
            if (err && err.handledByIosStandalonePrompt) {
                if (btn) btn.disabled = false;
                setGpsStatus('', '');
                return;
            }
            var msg;
            if (typeof GeoLocate !== 'undefined' && GeoLocate.geolocationErrorMessage) {
                msg = GeoLocate.geolocationErrorMessage(err);
            } else {
                msg = 'Could not get location.';
                if (err && err.code === 1) msg = 'Location permission denied.';
                else if (err && err.code === 2) msg = 'Location unavailable.';
                else if (err && err.code === 3) msg = 'Location request timed out.';
            }
            setGpsStatus(msg, 'error');
            if (btn) btn.disabled = false;
        }

        if (typeof GeoLocate !== 'undefined' && GeoLocate.getCurrentPositionRobust) {
            GeoLocate.getCurrentPositionRobust(onOk, onFail);
        } else {
            navigator.geolocation.getCurrentPosition(
                onOk,
                onFail,
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        }
    }

    function emailSubject() {
        var d = formatDateForExportDdMmYyyy(trimVal('fnDate'));
        return d ? 'Flight Report: ' + d : 'Flight Report';
    }

    async function onEmailClick() {
        var text = buildNotesPlainText();
        var subj = emailSubject();
        var shortBody =
            'Your flight report is on the clipboard. Paste into the email body below. (The full text was too long to put in the mail link automatically.)';

        if (text.length > MAILTO_BODY_MAX) {
            try {
                await navigator.clipboard.writeText(text);
                window.location.href =
                    'mailto:?subject=' +
                    encodeURIComponent(subj) +
                    '&body=' +
                    encodeURIComponent(shortBody);
            } catch (e) {
                alert(
                    'Could not copy the report to the clipboard. Try shortening the text or copy it manually from the page.'
                );
            }
            return;
        }

        window.location.href =
            'mailto:?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(text);
    }

    /**
     * Rasterise a Leaflet mini-map container for PDF (same idea as PdfTheme.captureSquareMap).
     * @param {HTMLElement|null} mapEl
     * @param {object|null} leafletMap Leaflet map instance
     */
    async function tryCaptureLeafletMapPng(mapEl, leafletMap) {
        if (!mapEl || !leafletMap || typeof html2canvas === 'undefined') return null;
        await new Promise(function (resolve) {
            setTimeout(resolve, 400);
        });
        try {
            leafletMap.invalidateSize();
        } catch (e) {}
        try {
            var capBg =
                typeof PdfTheme !== 'undefined' && PdfTheme.colors
                    ? PdfTheme.colors().mapBg
                    : document.body.classList.contains('fn-light-theme')
                      ? '#e8eaed'
                      : '#1a1a2e';
            var h2cMini =
                typeof MapCapture !== 'undefined' && MapCapture.html2canvasOptions
                    ? MapCapture.html2canvasOptions(capBg, { scale: 2 })
                    : {
                          useCORS: true,
                          allowTaint: false,
                          backgroundColor: capBg,
                          scale: 2,
                          logging: false
                      };
            var canvas = await html2canvas(mapEl, h2cMini);
            return {
                dataUrl: canvas.toDataURL('image/png'),
                width: canvas.width,
                height: canvas.height
            };
        } catch (e) {
            console.warn('Flight Report: map screenshot failed', e);
            return null;
        }
    }

    /** Sync main + additional location previews so Leaflet maps exist for PDF capture. */
    function syncAllFlightReportLocationMapPreviews() {
        syncLocationPreviewFromField();
        var ri;
        for (ri = 0; ri < fnExtraLocationRows.length; ri++) {
            var row = fnExtraLocationRows[ri];
            var raw = String(row.textInput.value || '').trim();
            if (!raw) continue;
            if (!parseLatLngFromLocationString(raw)) continue;
            if (row.resultWrap) row.resultWrap.hidden = false;
            syncExtraRowMapPreview(row);
        }
    }

    /** Ordered slots (main first, then additional locations) that have a live map. */
    function getFlightReportPdfLocationMapSlots() {
        var slots = [];
        var mainLl = parseLatLngFromLocationString(trimVal('fnLocation'));
        if (mainLl) {
            var mainEl = document.getElementById('fnMiniMap');
            if (mainEl && miniMap) {
                slots.push({
                    label: trimVal('fnLocationLabel') || 'Main location',
                    mapEl: mainEl,
                    map: miniMap
                });
            }
        }
        for (var ri = 0; ri < fnExtraLocationRows.length; ri++) {
            var row = fnExtraLocationRows[ri];
            var raw = String(row.textInput.value || '').trim();
            if (!raw) continue;
            if (!parseLatLngFromLocationString(raw)) continue;
            if (!row.mapEl || !row.map) continue;
            var lab = String(row.labelInput.value || '').trim() || 'Additional location ' + (ri + 1);
            slots.push({ label: lab, mapEl: row.mapEl, map: row.map });
        }
        return slots;
    }

    /**
     * Capture PNG shots for every mission location map (main + additional).
     * @returns {Promise<Array<{ label: string, shot: { dataUrl: string, width: number, height: number } | null }>>}
     */
    async function captureAllFlightReportLocationMapsForPdf() {
        syncAllFlightReportLocationMapPreviews();
        await new Promise(function (resolve) {
            setTimeout(resolve, 650);
        });
        var slots = getFlightReportPdfLocationMapSlots();
        if (!slots.length) {
            syncLocationPreviewFromField();
            await new Promise(function (resolve) {
                setTimeout(resolve, 350);
            });
            slots = getFlightReportPdfLocationMapSlots();
        }
        var out = [];
        var si;
        for (si = 0; si < slots.length; si++) {
            var s = slots[si];
            var shot = await tryCaptureLeafletMapPng(s.mapEl, s.map);
            out.push({ label: s.label, shot: shot });
        }
        return out;
    }

    /**
     * Draw location map(s) and labels at the top of the flight report PDF page.
     * @returns {number} Y position (mm) below the block for the next content
     */
    function layoutFlightReportLocationMapsOnPdf(doc, locationShots, startY) {
        if (!locationShots || !locationShots.length) return startY;
        var margin = 10;
        var pageW = PdfTheme.pageWidthMm();
        var usableW = pageW - 20;
        var gap = 4;
        var cols = locationShots.length === 1 ? 1 : 2;
        var maxMapH = cols === 1 ? 100 : 56;
        var tc = PdfTheme.colors();
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(tc.text[0], tc.text[1], tc.text[2]);

        var y = startY;
        var idx = 0;
        while (idx < locationShots.length) {
            var remaining = locationShots.length - idx;
            var inRow = cols === 1 ? 1 : Math.min(cols, remaining);
            var rowCellW = (usableW - gap * (inRow - 1)) / inRow;
            var rowTop = y;
            var rowMaxBottom = rowTop;
            var j;
            for (j = 0; j < inRow; j++) {
                var item = locationShots[idx + j];
                var x0 = margin + j * (rowCellW + gap);
                var labelLines = doc.splitTextToSize(String(item.label || ''), rowCellW - 1);
                if (!labelLines.length) labelLines = [''];
                var labelStartY = rowTop + 4;
                doc.text(labelLines, x0, labelStartY);
                var labelBlockH = labelLines.length * 4.2;
                var imgTop = labelStartY + labelBlockH + 1;
                if (item.shot && item.shot.dataUrl) {
                    var dims = mapImageSizeMm(
                        item.shot.width,
                        item.shot.height,
                        rowCellW - 2,
                        maxMapH
                    );
                    var mapX = x0 + (rowCellW - dims.w) / 2;
                    try {
                        doc.addImage(item.shot.dataUrl, 'PNG', mapX, imgTop, dims.w, dims.h);
                    } catch (e) {
                        doc.setFont('helvetica', 'italic');
                        doc.setFontSize(8);
                        doc.setTextColor(tc.muted[0], tc.muted[1], tc.muted[2]);
                        doc.text('Map image failed', x0, imgTop + 4);
                        doc.setFont('helvetica', 'bold');
                        doc.setFontSize(9);
                        doc.setTextColor(tc.text[0], tc.text[1], tc.text[2]);
                    }
                    rowMaxBottom = Math.max(rowMaxBottom, imgTop + dims.h + 4);
                } else {
                    doc.setFont('helvetica', 'italic');
                    doc.setFontSize(8);
                    doc.setTextColor(tc.muted[0], tc.muted[1], tc.muted[2]);
                    doc.text('No map preview for this site', x0, imgTop + 2);
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(9);
                    doc.setTextColor(tc.text[0], tc.text[1], tc.text[2]);
                    rowMaxBottom = Math.max(rowMaxBottom, imgTop + 10);
                }
            }
            y = rowMaxBottom;
            idx += inRow;
        }
        return y + 2;
    }

    function isFlightNotesExportLightTheme() {
        var el = document.querySelector('input[name="fnExportTheme"]:checked');
        return !!(el && el.value === 'light');
    }

    async function onPdfClick() {
        var btn = document.getElementById('fnPdfBtn');
        var orig = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating…';
        }

        try {
            if (typeof PdfTheme === 'undefined') {
                throw new Error('PDF library not loaded');
            }

            PdfTheme.setLight(isFlightNotesExportLightTheme());
            await PdfTheme.loadLogo();

            var ts = PdfTheme.tableStyles();
            var doc = PdfTheme.createDoc();
            PdfTheme.addHeader(doc, 'Flight Report', true);

            var startY = 26;
            var locationShots = await captureAllFlightReportLocationMapsForPdf();
            startY = layoutFlightReportLocationMapsOnPdf(doc, locationShots, startY);

            var summaryMeta = buildFlightReportPdfSummaryTable();
            var tableW = PdfTheme.pageWidthMm() - 20;
            var tcSummary = PdfTheme.colors();
            startY += 2;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(9);
            doc.setTextColor(tcSummary.text[0], tcSummary.text[1], tcSummary.text[2]);
            doc.text('Flight Summary', 10, startY + 3);
            startY += 6;

            var tsSummary = Object.assign({}, ts, {
                styles: Object.assign({}, ts.styles, { fontSize: 6 }),
                headStyles: Object.assign({}, ts.headStyles, { fontSize: 6 }),
                bodyStyles: Object.assign({}, ts.bodyStyles, { fontSize: 6 })
            });
            doc.autoTable({
                startY: startY,
                head: summaryMeta.head,
                body: summaryMeta.body,
                tableWidth: tableW,
                columnStyles: {
                    0: { cellWidth: 11 },
                    1: { cellWidth: 36 },
                    2: { cellWidth: 22 },
                    3: { cellWidth: 28 },
                    4: { cellWidth: 24 },
                    5: { cellWidth: 16 },
                    6: { cellWidth: 18 },
                    7: { cellWidth: 17 },
                    8: { cellWidth: 18 }
                },
                ...tsSummary
            });
            startY = doc.lastAutoTable.finalY + 4;

            var pdfBodyMeta = buildFlightReportPdfTableBody();
            var tsNoAlt = Object.assign({}, ts);
            delete tsNoAlt.alternateRowStyles;
            doc.autoTable({
                startY: startY,
                head: [['Field', 'Details']],
                body: pdfBodyMeta.body,
                tableWidth: tableW,
                columnStyles: {
                    0: { cellWidth: pdfBodyMeta.fieldColW },
                    1: { cellWidth: tableW - pdfBodyMeta.fieldColW }
                },
                ...tsNoAlt,
                didParseCell: function (data) {
                    if (data.section !== 'body') return;
                    var rawRow = data.row.raw;
                    if (
                        rawRow &&
                        rawRow.length === 1 &&
                        rawRow[0] &&
                        rawRow[0].colSpan === 2
                    ) {
                        return;
                    }
                    var rs = pdfBodyMeta.rowSections[data.row.index];
                    if (!rs || rs === 'banner') return;
                    var fill = fnPdfBodyFillForSection(rs);
                    if (fill) data.cell.styles.fillColor = fill;
                    var tc = PdfTheme.colors();
                    data.cell.styles.textColor = tc.text;
                }
            });

            await appendAllMissionAirspaceSitesToFlightReportPdf(doc);

            PdfTheme.addAllFooters(doc);

            var datePart =
                formatDateForExportDdMmYyyy(trimVal('fnDate')) ||
                formatDateForExportDdMmYyyy(new Date().toISOString().slice(0, 10));
            doc.save('Flight_Report_' + datePart + '.pdf');
        } catch (err) {
            console.error('Flight Report PDF export failed:', err);
            alert('Failed to export PDF: ' + (err && err.message ? err.message : 'Unknown error'));
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = orig || 'Export PDF';
            }
        }
    }

    function clearWeatherFetchStatus() {
        var wfs = document.getElementById('fnWeatherFetchStatus');
        if (!wfs) return;
        wfs.textContent = '';
        wfs.className = 'fn-weather-fetch-status';
    }

    var PENDING_WEATHER_FROM_FLIGHT_WEATHER_KEY = 'airplotPendingWeatherForReport_v1';

    function consumePendingWeatherFromFlightWeather() {
        try {
            var raw = sessionStorage.getItem(PENDING_WEATHER_FROM_FLIGHT_WEATHER_KEY);
            if (!raw) return;
            sessionStorage.removeItem(PENDING_WEATHER_FROM_FLIGHT_WEATHER_KEY);
            var o = JSON.parse(raw);
            if (!o || o.v !== 1 || !o.text) return;
            var ta = document.getElementById('fnWeather');
            if (!ta) return;
            var existing = trimVal('fnWeather');
            var sep = '\n\n--- Open-Meteo (from Flight Weather) ---\n';
            ta.value = existing ? existing + sep + o.text : o.text;
            setWeatherFetchStatus('Added from Flight Weather.', 'ok');
            autoResizeConditionsTextarea();
            saveFlightNotesDraft();
        } catch (e) {
            try {
                sessionStorage.removeItem(PENDING_WEATHER_FROM_FLIGHT_WEATHER_KEY);
            } catch (e2) {}
        }
    }

    function openClearModal() {
        var m = document.getElementById('fnClearModal');
        if (!m) return;
        m.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        var confirmBtn = document.getElementById('fnClearModalConfirm');
        if (confirmBtn) confirmBtn.focus();
    }

    function closeClearModal() {
        var m = document.getElementById('fnClearModal');
        if (m) m.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function openDeleteReportModal() {
        var m = document.getElementById('fnDeleteReportModal');
        if (!m) return;
        var index = ensureReportsIndex();
        var titles = buildReportTitleMap(index);
        var label = titles[fnActiveReportId] || 'this report';
        var body = document.getElementById('fnDeleteReportModalBody');
        if (body) {
            body.textContent =
                'Delete "' +
                label +
                '" from this browser? This removes the saved draft entirely and cannot be undone.';
        }
        m.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        var confirmBtn = document.getElementById('fnDeleteReportModalConfirm');
        if (confirmBtn) confirmBtn.focus();
    }

    function closeDeleteReportModal() {
        var m = document.getElementById('fnDeleteReportModal');
        if (m) m.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function confirmDeleteReportFromModal() {
        closeDeleteReportModal();
        deleteReport(fnActiveReportId);
    }

    function openWeatherClearModal() {
        var m = document.getElementById('fnWeatherClearModal');
        if (!m) return;
        m.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        var confirmBtn = document.getElementById('fnWeatherClearModalConfirm');
        if (confirmBtn) confirmBtn.focus();
    }

    function closeWeatherClearModal() {
        var m = document.getElementById('fnWeatherClearModal');
        if (m) m.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function openRemoveBatteryModal(n) {
        var m = document.getElementById('fnRemoveBatteryModal');
        var title = document.getElementById('fnRemoveBatteryModalTitle');
        if (title) title.textContent = 'Remove Battery ' + n + '?';
        var body = document.getElementById('fnRemoveBatteryModalBody');
        if (body) {
            body.textContent =
                'Battery ' +
                n +
                ' has details entered. Remove it and hide this battery slot? This cannot be undone.';
        }
        if (!m) return;
        m.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        var c = document.getElementById('fnRemoveBatteryModalConfirm');
        if (c) c.focus();
    }

    function closeRemoveBatteryModal() {
        var m = document.getElementById('fnRemoveBatteryModal');
        if (m) m.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function confirmRemoveBatteryFromModal() {
        closeRemoveBatteryModal();
        removeLastBatteryConfirmed();
    }

    function onRemoveLastBatteryClick() {
        var n = fnVisibleBatteryCount;
        if (n < 2) return;
        if (batteryNHasAnyValue(n)) {
            openRemoveBatteryModal(n);
        } else {
            removeLastBatteryConfirmed();
        }
    }

    function clearConditionsOnly() {
        var ta = document.getElementById('fnWeather');
        if (ta) {
            ta.value = '';
            ta.style.height = '';
            ta.style.overflowY = '';
        }
        clearWeatherFetchStatus();
        autoResizeConditionsTextarea();
        closeWeatherClearModal();
        saveFlightNotesDraft();
    }

    function clearEntireForm() {
        resetTransientReportUi();
        var form = document.getElementById('flightReportForm');
        if (form) form.reset();
        initFnManualDateSelects();
        setVisibleBatteryCount(1);
        resetAllBatteryCollapseState();
        updateAllBatteryFlightTimes();
        syncFnAirspaceIntroKm();
        var ta = document.getElementById('fnWeather');
        if (ta) {
            ta.style.height = '';
            ta.style.overflowY = '';
        }
        syncManualSelectsFromDateInput();
        saveEmptyDraftForActiveReport();
        closeClearModal();
        closeRemoveBatteryModal();
        autoResizeConditionsTextarea();
        updateBatterySiteDatalist();
        syncReportActiveHint();
    }

    function init() {
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
            if (typeof window.syncApBrandLogos === 'function') {
                window.syncApBrandLogos(!!light);
            }
        }

        var fnThemeBtn = document.getElementById('fnThemeToggle');
        if (fnThemeBtn) {
            try {
                applyFnPageTheme(localStorage.getItem('fnLightTheme') === '1');
            } catch (e) {
                applyFnPageTheme(false);
            }
            fnThemeBtn.addEventListener('click', function () {
                applyFnPageTheme(!pageThemeIsLight());
            });
        }

        initFnManualDateSelects();
        ensureBatteryCards();
        bindBatteryCardInteractions();
        ensureReportsIndex();
        var initialBatterySlots = loadFlightNotesDraft();
        consumePendingWeatherFromFlightWeather();
        refreshFormAfterDraftLoad(initialBatterySlots, getActiveDraftCollapsedBatteries());

        var fnReportSelect = document.getElementById('fnReportSelect');
        var fnNewReportBtn = document.getElementById('fnNewReportBtn');
        var fnDeleteReportBtn = document.getElementById('fnDeleteReportBtn');
        var deleteReportModal = document.getElementById('fnDeleteReportModal');
        var deleteReportBackdrop = document.getElementById('fnDeleteReportModalBackdrop');
        var deleteReportCancel = document.getElementById('fnDeleteReportModalCancel');
        var deleteReportClose = document.getElementById('fnDeleteReportModalClose');
        var deleteReportConfirm = document.getElementById('fnDeleteReportModalConfirm');
        if (fnReportSelect) {
            fnReportSelect.addEventListener('change', function () {
                if (fnSwitchingReport) return;
                switchToReport(fnReportSelect.value);
            });
        }
        if (fnNewReportBtn) fnNewReportBtn.addEventListener('click', createNewReport);
        if (fnDeleteReportBtn) fnDeleteReportBtn.addEventListener('click', openDeleteReportModal);
        if (deleteReportCancel) deleteReportCancel.addEventListener('click', closeDeleteReportModal);
        if (deleteReportClose) deleteReportClose.addEventListener('click', closeDeleteReportModal);
        if (deleteReportBackdrop) deleteReportBackdrop.addEventListener('click', closeDeleteReportModal);
        if (deleteReportConfirm) deleteReportConfirm.addEventListener('click', confirmDeleteReportFromModal);

        var fnAirspaceRefresh = document.getElementById('fnAirspaceRefreshBtn');
        var fnAirspaceRadius = document.getElementById('fnAirspaceRadiusKm');
        if (fnAirspaceRefresh) fnAirspaceRefresh.addEventListener('click', loadFnAirspaceTab);
        if (fnAirspaceRadius) {
            fnAirspaceRadius.addEventListener('change', function () {
                syncFnAirspaceIntroKm();
                scheduleFlightNotesDraftSave();
            });
        }
        var fnAirspaceSiteSel = document.getElementById('fnAirspaceSiteSelect');
        if (fnAirspaceSiteSel) {
            fnAirspaceSiteSel.addEventListener('change', function () {
                syncAllMissionSiteSelects(fnAirspaceSiteSel.value);
                scheduleFlightNotesDraftSave();
                loadFnAirspaceTab();
            });
        }
        var fnWeatherSiteSel = document.getElementById('fnWeatherSiteSelect');
        if (fnWeatherSiteSel) {
            fnWeatherSiteSel.addEventListener('change', function () {
                syncAllMissionSiteSelects(fnWeatherSiteSel.value);
                scheduleFlightNotesDraftSave();
            });
        }
        syncAllMissionSiteSelects();

        applyFnNotamFiltersFromStorage();
        ['fnNotamDroneOnly', 'fnNotamHideAd', 'fnNotamHideCeiling', 'fnNotamPrioritise'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', saveFnNotamFiltersToStorage);
        });

        var nowBtn = document.getElementById('fnNowBtn');
        var todayBtn = document.getElementById('fnTodayBtn');
        var fnDateEl = document.getElementById('fnDate');
        var fnDatePickerBtn = document.getElementById('fnDatePickerBtn');
        var searchLocationBtn = document.getElementById('fnSearchLocationBtn');
        var gpsBtn = document.getElementById('fnGpsBtn');
        var emailBtn = document.getElementById('fnEmailBtn');
        var pdfBtn = document.getElementById('fnPdfBtn');

        var weatherFetchBtn = document.getElementById('fnWeatherFetchBtn');
        var weatherClearBtn = document.getElementById('fnWeatherClearBtn');
        var clearFormBtn = document.getElementById('fnClearFormBtn');
        var clearModal = document.getElementById('fnClearModal');
        var clearBackdrop = document.getElementById('fnClearModalBackdrop');
        var clearCancel = document.getElementById('fnClearModalCancel');
        var clearClose = document.getElementById('fnClearModalClose');
        var clearConfirm = document.getElementById('fnClearModalConfirm');
        var weatherClearModal = document.getElementById('fnWeatherClearModal');
        var weatherClearBackdrop = document.getElementById('fnWeatherClearModalBackdrop');
        var weatherClearCancel = document.getElementById('fnWeatherClearModalCancel');
        var weatherClearClose = document.getElementById('fnWeatherClearModalClose');
        var weatherClearConfirm = document.getElementById('fnWeatherClearModalConfirm');
        var removeBatteryModal = document.getElementById('fnRemoveBatteryModal');
        var removeBatteryBackdrop = document.getElementById('fnRemoveBatteryModalBackdrop');
        var removeBatteryCancel = document.getElementById('fnRemoveBatteryModalCancel');
        var removeBatteryClose = document.getElementById('fnRemoveBatteryModalClose');
        var removeBatteryConfirm = document.getElementById('fnRemoveBatteryModalConfirm');
        var removeLastBatteryBtn = document.getElementById('fnRemoveLastBatteryBtn');

        if (todayBtn) todayBtn.addEventListener('click', setTodayDate);
        if (nowBtn) nowBtn.addEventListener('click', setNowDateTime);
        if (fnDatePickerBtn && fnDateEl) {
            fnDatePickerBtn.addEventListener('click', openFnDatePicker);
        }
        if (fnDateEl) {
            fnDateEl.addEventListener('change', syncManualSelectsFromDateInput);
            fnDateEl.addEventListener('input', syncManualSelectsFromDateInput);
        }
        var fnDateManualDetails = document.querySelector('.fn-date-manual-fallback');
        if (fnDateManualDetails) {
            fnDateManualDetails.addEventListener('toggle', function () {
                if (fnDateManualDetails.open) syncManualSelectsFromDateInput();
            });
        }
        ['fnDateManualDay', 'fnDateManualMonth', 'fnDateManualYear'].forEach(function (sid) {
            var sel = document.getElementById(sid);
            if (sel) sel.addEventListener('change', applyManualSelectsToDateInput);
        });
        var fnLocInput = document.getElementById('fnLocation');
        if (fnLocInput) {
            fnLocInput.addEventListener('input', scheduleSyncLocationPreviewFromField);
            fnLocInput.addEventListener('change', syncLocationPreviewFromField);
        }
        var fnLocLabelInput = document.getElementById('fnLocationLabel');
        if (fnLocLabelInput) {
            fnLocLabelInput.addEventListener('input', function () {
                updateBatterySiteDatalist();
            });
            fnLocLabelInput.addEventListener('change', function () {
                updateBatterySiteDatalist();
            });
        }
        var addExtraLocBtn = document.getElementById('fnAddExtraLocationBtn');
        if (addExtraLocBtn) {
            addExtraLocBtn.addEventListener('click', function () {
                addExtraLocationRow(true);
            });
        }
        syncFnAddExtraLocationButtonState();
        var addBatteryBtn = document.getElementById('fnAddBatteryBtn');
        if (addBatteryBtn) {
            addBatteryBtn.addEventListener('click', function () {
                if (fnVisibleBatteryCount >= FN_BATTERY_MAX) return;
                var prev = fnVisibleBatteryCount;
                setVisibleBatteryCount(fnVisibleBatteryCount + 1);
                if (prev >= 1) setBatteryCollapsed(prev, true);
                ensureBatteryLimitDefaults(fnVisibleBatteryCount);
                scheduleFlightNotesDraftSave();
            });
        }
        var collapseAllBatteriesBtn = document.getElementById('fnCollapseAllBatteriesBtn');
        if (collapseAllBatteriesBtn) {
            collapseAllBatteriesBtn.addEventListener('click', collapseAllVisibleBatteries);
        }
        var expandAllBatteriesBtn = document.getElementById('fnExpandAllBatteriesBtn');
        if (expandAllBatteriesBtn) {
            expandAllBatteriesBtn.addEventListener('click', expandAllVisibleBatteries);
        }
        if (removeLastBatteryBtn) removeLastBatteryBtn.addEventListener('click', onRemoveLastBatteryClick);
        if (removeBatteryCancel) removeBatteryCancel.addEventListener('click', closeRemoveBatteryModal);
        if (removeBatteryClose) removeBatteryClose.addEventListener('click', closeRemoveBatteryModal);
        if (removeBatteryBackdrop) removeBatteryBackdrop.addEventListener('click', closeRemoveBatteryModal);
        if (removeBatteryConfirm) removeBatteryConfirm.addEventListener('click', confirmRemoveBatteryFromModal);
        if (searchLocationBtn) searchLocationBtn.addEventListener('click', onSearchLocationClick);
        if (gpsBtn) gpsBtn.addEventListener('click', onGpsClick);
        if (weatherFetchBtn) weatherFetchBtn.addEventListener('click', onWeatherFetchClick);
        if (weatherClearBtn) weatherClearBtn.addEventListener('click', openWeatherClearModal);
        if (weatherClearCancel) weatherClearCancel.addEventListener('click', closeWeatherClearModal);
        if (weatherClearClose) weatherClearClose.addEventListener('click', closeWeatherClearModal);
        if (weatherClearBackdrop) weatherClearBackdrop.addEventListener('click', closeWeatherClearModal);
        if (weatherClearConfirm) weatherClearConfirm.addEventListener('click', clearConditionsOnly);
        var fnWeatherTa = document.getElementById('fnWeather');
        if (fnWeatherTa) {
            fnWeatherTa.addEventListener('input', autoResizeConditionsTextarea);
            autoResizeConditionsTextarea();
        }
        window.addEventListener(
            'resize',
            function () {
                autoResizeConditionsTextarea();
            },
            { passive: true }
        );
        if (emailBtn) emailBtn.addEventListener('click', onEmailClick);
        if (pdfBtn) pdfBtn.addEventListener('click', onPdfClick);

        if (clearFormBtn) clearFormBtn.addEventListener('click', openClearModal);
        var clearNotesTopBtn = document.getElementById('fnClearNotesTopBtn');
        if (clearNotesTopBtn) clearNotesTopBtn.addEventListener('click', openClearModal);
        if (clearCancel) clearCancel.addEventListener('click', closeClearModal);
        if (clearClose) clearClose.addEventListener('click', closeClearModal);
        if (clearBackdrop) clearBackdrop.addEventListener('click', closeClearModal);
        if (clearConfirm) clearConfirm.addEventListener('click', clearEntireForm);
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (removeBatteryModal && !removeBatteryModal.classList.contains('hidden')) {
                closeRemoveBatteryModal();
                return;
            }
            if (weatherClearModal && !weatherClearModal.classList.contains('hidden')) {
                closeWeatherClearModal();
                return;
            }
            if (deleteReportModal && !deleteReportModal.classList.contains('hidden')) {
                closeDeleteReportModal();
                return;
            }
            if (clearModal && !clearModal.classList.contains('hidden')) {
                closeClearModal();
            }
        });

        var fnForm = document.getElementById('flightReportForm');
        if (fnForm) {
            fnForm.addEventListener('input', scheduleFlightNotesDraftSave);
            fnForm.addEventListener('change', scheduleFlightNotesDraftSave);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
