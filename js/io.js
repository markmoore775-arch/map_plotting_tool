/* ============================================
   PROJECT SAVE / LOAD (JSON)
   ============================================ */

const ProjectIO = (() => {

    /**
     * Save project to a JSON file. Uses native Save As dialog when available
     * (File System Access API), otherwise falls back to download.
     * @param {Array} points - Array of point objects
     * @param {object} settings - Application settings
     * @param {Array} shapes - Array of shape objects (optional)
     */
    async function saveProject(points, settings, shapes) {
        const project = {
            version: 2,
            exportedAt: new Date().toISOString(),
            settings: settings,
            points: points,
            shapes: shapes || []
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
                alert('Failed to save: ' + err.message);
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

                    // Support both v1 (no shapes) and v2 (with shapes)
                    const points = project.points || [];
                    const validPoints = points.filter(p =>
                        p.lat != null && p.lng != null &&
                        !isNaN(p.lat) && !isNaN(p.lng)
                    );

                    resolve({
                        points: validPoints,
                        settings: project.settings || {},
                        shapes: project.shapes || []
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
        loadProject
    };

})();
