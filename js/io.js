/* ============================================
   PROJECT SAVE / LOAD (JSON)
   ============================================ */

const ProjectIO = (() => {

    /**
     * Save project to a JSON file (triggers download).
     * @param {Array} points - Array of point objects
     * @param {object} settings - Application settings
     * @param {Array} shapes - Array of shape objects (optional)
     */
    function saveProject(points, settings, shapes) {
        const project = {
            version: 2,
            exportedAt: new Date().toISOString(),
            settings: settings,
            points: points,
            shapes: shapes || []
        };

        const json = JSON.stringify(project, null, 2);
        Exporters.downloadFile(json, 'map_project.json', 'application/json');
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
