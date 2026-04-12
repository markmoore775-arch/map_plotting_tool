# UK Airspace Data – Real NATS UAS Data

AirPlot **v4** includes a separate **[Airspace](../airspace.html)** page for **live ADS-B traffic** (hazard-themed map, altitude labels, session trails, optional OGN glider-class overlay). That feature uses the [ADSB.lol](https://api.adsb.lol/docs) API, not the GeoJSON files described here. Optional **approx. AGL** on that page uses Mapbox Terrain-RGB when `js/config.js` includes a Mapbox token.

This document covers **Planning** mode **UK airspace** layers: AirPlot can display UK airspace restrictions (Prohibited, Restricted, Danger, FRZ) using official NATS UAS data. The guide below explains how to obtain and convert that data.

## Quick Start

1. **Install dependencies** (one-time):
   ```bash
   npm install
   ```

2. **Download** the NATS UAS Flight Restrictions file (see below).

3. **Convert** to GeoJSON:
   ```bash
   npm run convert-airspace -- path/to/your-download.kmz
   ```
   Or with a custom output path:
   ```bash
   node scripts/convert-airspace-data.js path/to/download.kmz -o assets/uk-airspace.geojson
   ```

4. **Reload** the app – the new data will appear when you toggle UK Airspace.

---

## Obtaining NATS UAS Data

### Step 1: Register at NATS

1. Go to [NATS UK Digital Datasets](https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/)
2. Click **Register now** (or [registration link](https://nats-uk.ead-it.com/cms-nats/opencms/en/registration/))
3. Complete the registration form
4. Log in with your credentials

### Step 2: Download UAS Flight Restrictions

1. From the Digital Datasets page, find **UAS Flight Restrictions** in the Regular Datasets table
2. Click the download link for the current AIRAC cycle (Effective From column)
3. The file is typically a **ZIP** containing a KMZ – e.g. `EG_UAS_FR_DS_AREA1_FULL_20260319_KML.zip`
4. Save it to your computer

**Direct download (no login):** NATS also publishes the same file under export URLs, e.g.  
`https://nats-uk.ead-it.com/cms-nats/export/sites/default/en/Publications/digital-datasets/UAS_AREA_1/EG_UAS_FR_DS_AREA1_FULL_20260319_KML.zip`  
(Replace `20260319` with the date in the **Effective From** column for the cycle you need.)

### Step 3: Convert to GeoJSON

Run the conversion script (accepts .zip, .kmz, or .kml):

```bash
npm run convert-airspace -- path/to/EG_UAS_FR_DS_AREA1_FULL_20260319_KML.zip
```

By default, output is written to `assets/uk-airspace.geojson`. To specify a different path:

```bash
node scripts/convert-airspace-data.js path/to/file.kmz -o assets/uk-airspace.geojson
```

The script supports both `.kml` and `.kmz` files.

---

## Data Updates

NATS updates the UAS Flight Restrictions dataset every **28 days** (AIRAC cycle). To keep your data current:

1. Check the [Digital Datasets](https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/) page for the latest Effective From date
2. Download the new file
3. Re-run the conversion script

---

## Airspace Types

The converter maps NATS designators to AirPlot types:

| NATS Designator | Type | Colour |
|-----------------|------|--------|
| EGP### (Prohibited) | Prohibited | Dark red |
| EGR###, EGRU### (Restricted) | Restricted | Orange |
| EGD### (Danger) | Danger | Yellow |
| FRZ, RPZ, Aerodrome | FRZ / Aerodrome | Purple |

---

## Troubleshooting

### "No .kml file found inside KMZ archive"

Some KMZ files use a different structure. Try unzipping manually and use the `.kml` file:

```bash
unzip your-file.kmz -d temp/
node scripts/convert-airspace-data.js temp/doc.kml
```

### "Conversion produced no features"

- Ensure the file is valid KML/KMZ from NATS
- Check that the file is not corrupted

### Missing dependencies

If you see `MODULE_NOT_FOUND` errors:

```bash
npm install @tmcw/togeojson @xmldom/xmldom adm-zip
```

---

## NOTAM (Temporary Restrictions)

AirPlot fetches NOTAMs from the [UK NOTAM Archive](https://jonty.github.io/uk-notam-archive/) (NATS AIS Contingency, hourly updated). The PIB XML is parsed in one shared module ([`js/notam-pib.js`](../js/notam-pib.js)) so the main map, Flight Weather, Flight Report, and DJI Mission Planner stay consistent.

**Geometry:** the feed supplies a centre coordinate and a radius, which AirPlot draws as a circle. Complex boundaries described only in NOTAM text are not plotted.

### Main map (index)

Enable **NOTAM** in the UK airspace key. Click the arrow (▼) for options:

- **Max radius**: Cap displayed circle size (5–50 NM or All). Default 12 NM reduces clutter from very large NOTAMs.
- **Drone-relevant only**: Keep NOTAMs that match UAS/hazard keywords (e.g. UAS, crane, TDA, BVLOS, danger area).
- **Hide airfield ops**: Hide typical aerodrome ground-ops NOTAMs (taxiway, lighting, comms, runway works, etc.) when they are not also tagged as UAS-relevant by keywords. Heuristic only - always confirm on the official NATS PIB.
- **Opacity**: Fill opacity (about 3–20%).

Popups show **vertical limits** from the PIB **Q-line** (`Lower` / `Upper`, shown as e.g. SFC–UNL or flight levels) where present, plus a short note to verify on an official briefing for flight-critical use.

Circle colours reflect triage: **amber** (strong UAS/hazard keywords), **orange** (“check” - e.g. temporary restricted wording), **purple** (airfield-ops class), **slate** (other).

### Flight Weather and Flight Report

The Airspace tab / section uses the same data. After setting **Search radius**, use **Refresh**. Optional NOTAM controls:

- **Drone-keyword filter** - same idea as “Drone-relevant only” on the map.
- **Hide airfield ops** - same heuristic as on the map.
- **Prioritise for UAS** - sort so UAS-relevant categories appear first.

List rows use coloured **tags** (UAS / hazard, UAS check, Airfield ops, NOTAM). **Vertical (Q-line / text)** uses structured Q-line values when the PIB includes them, with a few simple text fallbacks; treat as advisory and cross-check NATS AIS if altitude matters.

### DJI Mission Planner (`flight-planning.html`)

The map includes a **NOTAM** control (bottom-left) with the same toggle, max radius, filters, and opacity as the main app, so temporary areas can be seen while building KMZ missions.

## RA(T) – Restricted Area Temporary

AirPlot can display RA(T)s from the [UK Airspace Service](https://airspace.bgaladder.net/) (BGA). **Registration required** at airspace.bgaladder.net. Add your username and password in **Settings** to enable the RA(T) layer.

## Data Validity

When you run the conversion script, the output GeoJSON includes metadata with the effective date range (from the NATS filename). This is shown in the airspace panel as "Data valid: YYYY-MM-DD – YYYY-MM-DD".

---

## UK ICAO AIP Dataset (AIXM)

AirPlot can optionally display additional airspace from the **UK ICAO AIP Dataset** (CTR, TMA, FIR, etc.) alongside ENR 5.1. This dataset is in AIXM 5.1 XML format and requires conversion.

### Obtaining the AIP Dataset

1. Register at [NATS Digital Datasets](https://nats-uk.ead-it.com/cms-nats/opencms/en/registration/)
2. Log in and go to [Digital Datasets](https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/) (or [Evaluation](https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/evaluation))
3. Download **UK ICAO AIP Dataset** for the current AIRAC cycle (AIXM XML, often in a ZIP)
4. Save to your computer

### Converting to GeoJSON

Run the conversion script:

```bash
npm run convert-aip -- path/to/UK_ICAO_AIP_Dataset.zip
```

Or with a custom output path:

```bash
node scripts/convert-aip-aixm.js path/to/download.zip -o assets/uk-aip-airspace.geojson
```

The script accepts `.xml` or `.zip` files. Output defaults to `assets/uk-aip-airspace.geojson`.

### Integration

If `assets/uk-aip-airspace.geojson` exists, AirPlot loads it automatically and merges it with ENR 5.1 data. AIP features (CTR, TMA, FIR, etc.) appear in the **Other** category in the airspace key. If the file is missing, the app works normally with ENR 5.1 only.

### AIP Conversion Troubleshooting

- **"No airspace features found"** – The AIXM file may use a different structure. Check that the file contains `Airspace` elements with `AirspaceVolume` and GML geometry. You can inspect the XML to verify.
- **"No AIXM XML file found inside ZIP"** – Ensure the ZIP contains an `.xml` file (not just metadata). Some NATS downloads have multiple files; the script looks for `.xml` excluding `*metadata*`.
- **Parse errors** – Ensure the file is valid AIXM 5.1 XML. The UK ICAO AIP Dataset follows Eurocontrol AIXM coding guidelines.

---

## Data Sources

- **NATS UK**: [UAS Restriction Zones](https://nats-uk.ead-it.com/cms-nats/opencms/en/uas-restriction-zones/)
- **NATS UK**: [Digital Datasets](https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/) (AIP, UAS FR, Obstacles)
- **UK AIP ENR 5.1**: [Prohibited, Restricted and Danger Areas](https://www.aurora.nats.co.uk/htmlAIP/Publications/current-AIRAC/html/eAIP/EG-ENR-5.1-en-GB.html)
- **CAA**: [Drone airspace restrictions](https://www.caa.co.uk/drones/airspace-and-restrictions/airspace-restrictions-for-remotely-piloted-aircraft-and-drones/)
