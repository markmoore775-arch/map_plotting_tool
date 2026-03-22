/**
 * In-app confirmation for destructive actions (replaces window.confirm).
 * Depends on #confirmModal markup in the page.
 */
(function () {
    'use strict';

    function getModal() {
        return document.getElementById('confirmModal');
    }

    /**
     * @param {Object} opts
     * @param {string} opts.title
     * @param {string} opts.message
     * @param {string} [opts.confirmLabel='Confirm']
     * @param {boolean} [opts.danger=true] — false uses btn-primary for confirm
     * @returns {Promise<boolean>}
     */
    function showConfirmModal(opts) {
        const modal = getModal();
        if (!modal) {
            console.warn('confirmModal element missing from page');
            return Promise.resolve(false);
        }

        const titleEl = document.getElementById('confirmModalTitle');
        const bodyEl = document.getElementById('confirmModalBody');
        const confirmBtn = document.getElementById('confirmModalConfirm');
        const cancelBtn = document.getElementById('confirmModalCancel');
        const closeBtn = document.getElementById('confirmModalClose');
        const backdrop = modal.querySelector('.modal-backdrop');

        if (titleEl) titleEl.textContent = opts.title || 'Confirm';
        if (bodyEl) bodyEl.textContent = opts.message || '';

        const label = opts.confirmLabel != null ? opts.confirmLabel : 'Confirm';
        if (confirmBtn) {
            confirmBtn.textContent = label;
            confirmBtn.className = 'btn ' + (opts.danger !== false ? 'btn-danger' : 'btn-primary');
        }

        modal.classList.remove('hidden');
        if (confirmBtn) confirmBtn.focus();

        return new Promise(function (resolve) {
            function finish(value) {
                modal.classList.add('hidden');
                document.removeEventListener('keydown', onKey);
                if (confirmBtn) confirmBtn.removeEventListener('click', onConfirm);
                if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
                if (closeBtn) closeBtn.removeEventListener('click', onCancel);
                if (backdrop) backdrop.removeEventListener('click', onCancel);
                resolve(value);
            }

            function onConfirm() {
                finish(true);
            }

            function onCancel() {
                finish(false);
            }

            function onKey(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    finish(false);
                }
            }

            if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
            if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
            if (closeBtn) closeBtn.addEventListener('click', onCancel);
            if (backdrop) backdrop.addEventListener('click', onCancel);
            document.addEventListener('keydown', onKey);
        });
    }

    window.showConfirmModal = showConfirmModal;
})();
