/* ============================================
   PROJECT SAVE / LOAD (JSON)
   ============================================ */

const ProjectIO = (() => {

    function filterValidPoints(points) {
        return (points || []).filter(p =>
            p.lat != null && p.lng != null &&
            !isNaN(p.lat) && !isNaN(p.lng)
        );
    }

    /**
     * Remove credentials that should never leave the browser (shared project
     * files would otherwise leak the user's BGA login).
     */
    function sanitizeSettingsForExport(settings) {
        const safe = { ...(settings || {}) };
        delete safe.bgaAirspaceUsername;
        delete safe.bgaAirspacePassword;
        return safe;
    }

    /**
     * Save project to a JSON file. Uses native Save As dialog when available
     * (File System Access API), otherwise falls back to download.
     * @param {Array} points - Array of point objects
     * @param {object} settings - Application settings
     * @param {Array} shapes - Array of shape objects (optional)
     * @param {object|null} grid - Grid overlay state { bounds, rows, cols, visible } (optional)
     */
    async function saveProject(points, settings, shapes, grid) {
        const project = {
            version: 3,
            exportedAt: new Date().toISOString(),
            settings: sanitizeSettingsForExport(settings),
            points: points,
            shapes: shapes || [],
            grid: grid || null
        };

        const json = JSON.stringify(project, null, 2);

        if ('showSaveFilePicker' in window) {
            try {
                const handle = await showSaveFilePicker({
                    suggestedName: 'map_project.json',
                    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
            } catch (err) {
                if (err.name === 'AbortError') return; // User cancelled
                if (typeof window.airplotToast === 'function') {
                    window.airplotToast('Failed to save: ' + err.message, 'error');
                } else {
                    alert('Failed to save: ' + err.message);
                }
            }
        } else {
            Exporters.downloadFile(json, 'map_project.json', 'application/json');
        }
    }

    /**
     * Load project from a JSON file.
     * @param {File} file - File object from file input
     * @returns {Promise<object>} Parsed project data { points, settings, shapes }
     */
    function loadProject(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                try {
                    const project = JSON.parse(e.target.result);

                    // Support v1 (no shapes), v2 (shapes), and v3 (shapes + grid)
                    const validPoints = filterValidPoints(project.points);

                    resolve({
                        points: validPoints,
                        settings: project.settings || {},
                        shapes: project.shapes || [],
                        grid: project.grid || null
                    });
                } catch (err) {
                    reject(new Error('Invalid JSON file: ' + err.message));
                }
            };

            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    return {
        saveProject,
        loadProject,
        filterValidPoints
    };

})();
