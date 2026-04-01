/* ============================================
   UNDO / REDO HISTORY
   ============================================ */

const UndoHistory = (() => {
    'use strict';

    const MAX_HISTORY = 50;
    let undoStack = [];
    let redoStack = [];
    let getState = null;
    let restoreState = null;

    function init(callbacks) {
        getState = callbacks.getState;
        restoreState = callbacks.restoreState;
        undoStack = [];
        redoStack = [];
    }

    function pushSnapshot() {
        if (!getState || !restoreState) return;
        try {
            const state = getState();
            if (!state) return;
            redoStack = [];
            undoStack.push(state);
            if (undoStack.length > MAX_HISTORY) undoStack.shift();
            updateUndoButtonState();
        } catch (e) {
            console.warn('Undo: failed to push snapshot', e);
        }
    }

    function undo() {
        if (!getState || !restoreState || undoStack.length === 0) return false;
        try {
            const current = getState();
            const snapshot = undoStack.pop();
            if (current) {
                redoStack.push(current);
                if (redoStack.length > MAX_HISTORY) redoStack.shift();
            }
            restoreState(snapshot);
            updateUndoButtonState();
            return true;
        } catch (e) {
            console.warn('Undo: failed to restore', e);
            return false;
        }
    }

    function redo() {
        if (!getState || !restoreState || redoStack.length === 0) return false;
        try {
            const current = getState();
            const snapshot = redoStack.pop();
            if (current) {
                undoStack.push(current);
                if (undoStack.length > MAX_HISTORY) undoStack.shift();
            }
            restoreState(snapshot);
            updateUndoButtonState();
            return true;
        } catch (e) {
            console.warn('Redo: failed to restore', e);
            return false;
        }
    }

    function canUndo() {
        return undoStack.length > 0;
    }

    function canRedo() {
        return redoStack.length > 0;
    }

    function updateUndoButtonState() {
        const undoEnabled = canUndo();
        const redoEnabled = canRedo();
        const sidebarUndo = document.getElementById('undoBtn');
        if (sidebarUndo) sidebarUndo.disabled = !undoEnabled;
        const sidebarRedo = document.getElementById('redoBtn');
        if (sidebarRedo) sidebarRedo.disabled = !redoEnabled;
        document.querySelectorAll('.leaflet-control-undo').forEach(el => {
            el.classList.toggle('disabled', !undoEnabled);
            el.setAttribute('aria-disabled', String(!undoEnabled));
        });
        document.querySelectorAll('.leaflet-control-redo').forEach(el => {
            el.classList.toggle('disabled', !redoEnabled);
            el.setAttribute('aria-disabled', String(!redoEnabled));
        });
    }

    return {
        init,
        pushSnapshot,
        undo,
        redo,
        canUndo,
        canRedo,
        updateUndoButtonState
    };

})();
