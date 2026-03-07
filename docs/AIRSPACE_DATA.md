# UK Airspace Data – Real NATS UAS Data

AirPlot can display UK airspace restrictions (Prohibited, Restricted, Danger, FRZ) using official NATS UAS data. This guide explains how to obtain and convert the data.

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
3. The file is typically a **ZIP** containing a KMZ – e.g. `EG_UAS_FR_DS_AREA1_FULL_20260219_KML.zip`
4. Save it to your computer

### Step 3: Convert to GeoJSON

Run the conversion script (accepts .zip, .kmz, or .kml):

```bash
npm run convert-airspace -- path/to/EG_UAS_FR_DS_AREA1_FULL_20260219_KML.zip
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
| EGP### (Prohibited) | Prohibited | Red |
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

AirPlot fetches NOTAMs from the [UK NOTAM Archive](https://jonty.github.io/uk-notam-archive/) (NATS AIS Contingency, hourly updated). Enable the **NOTAM** layer in the airspace key to display temporary restrictions. No API key required.

When NOTAM is enabled, click the arrow (▼) next to the label to reveal options:
- **Max radius**: Cap displayed circle size (5–50 NM or All). Default 12 NM reduces clutter from very large NOTAMs.
- **Drone-relevant only**: Show only NOTAMs mentioning UAS, cranes, TDA, BVLOS, etc.
- **Opacity**: Adjust fill opacity (3–20%).

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
