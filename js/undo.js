/* ============================================
   UNDO HISTORY
   ============================================ */

const UndoHistory = (() => {
    'use strict';

    const MAX_HISTORY = 50;
    let stack = [];
    let getState = null;
    let restoreState = null;

    function init(callbacks) {
        getState = callbacks.getState;
        restoreState = callbacks.restoreState;
        stack = [];
    }

    function pushSnapshot() {
        if (!getState || !restoreState) return;
        try {
            const state = getState();
            if (!state) return;
            stack.push(state);
            if (stack.length > MAX_HISTORY) stack.shift();
            updateUndoButtonState();
        } catch (e) {
            console.warn('Undo: failed to push snapshot', e);
        }
    }

    function undo() {
        if (!restoreState || stack.length === 0) return false;
        try {
            const snapshot = stack.pop();
            restoreState(snapshot);
            updateUndoButtonState();
            return true;
        } catch (e) {
            console.warn('Undo: failed to restore', e);
            return false;
        }
    }

    function canUndo() {
        return stack.length > 0;
    }

    function updateUndoButtonState() {
        const enabled = canUndo();
        const sidebarBtn = document.getElementById('undoBtn');
        if (sidebarBtn) sidebarBtn.disabled = !enabled;
        document.querySelectorAll('.leaflet-control-undo').forEach(el => {
            el.classList.toggle('disabled', !enabled);
            el.setAttribute('aria-disabled', !enabled);
        });
    }

    return {
        init,
        pushSnapshot,
        undo,
        canUndo,
        updateUndoButtonState
    };

})();
