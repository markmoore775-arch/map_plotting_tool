# AirPlan Changelog

## v1.1 — 29 August 2026

### Removed
- **DJI Mission Planner** (`flight-planning.html`) — waypoint/KMZ mission builder removed from the site and sitemap.

### Planning map
- **Welcome screen** — **Log a Flight** is now the primary call-to-action; **Plan & Map** is secondary.
- **Sidebar Draw Tools** — circle, rectangle, polygon, line, arrow, flight path, text, and grid buttons in the **Draw** tab (especially useful on small screens).
- **Search Location** — UK place-name lookup via Nominatim; **Add Point Here** resolves a search and drops a named point in one step.
- **Undo messaging** — delete/clear confirmations note that **Ctrl+Z** can restore changes.
- **Grid overlay** — edit/clear actions now participate in undo/redo and auto-save.

### Flight Weather
- **Map dock UI** — clearer primary/secondary layout; collapsible forecast and wind options on mobile so the map stays visible.
- **Export parity** — PowerPoint and PDF exports align more closely with on-screen report content (precipitation probability, hourly cells).

### Documentation & privacy
- In-app help updated for draw tools, search, and welcome screen changes.
- Privacy policy updated to remove flight-planning draft storage references.
- `docs/AIRSPACE_DATA.md` updated to drop Mission Planner NOTAM section.
