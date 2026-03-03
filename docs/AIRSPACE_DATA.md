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
3. The file is typically a **KMZ** (zipped KML) – e.g. `UAS_Flight_Restrictions_ENR5.1.kmz`
4. Save it to your computer

### Step 3: Convert to GeoJSON

Run the conversion script:

```bash
npm run convert-airspace -- path/to/UAS_Flight_Restrictions_ENR5.1.kmz
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

## Alternative: UK Airspace Service API

The [UK Airspace Service](https://airspace.bgaladder.net/) (BGA) provides GeoJSON via API with registration. It includes airspace, LoAs, and RA(T)s. Integration would require adding an API client and handling authentication. Contact them for API access.

---

## Data Sources

- **NATS UK**: [UAS Restriction Zones](https://nats-uk.ead-it.com/cms-nats/opencms/en/uas-restriction-zones/)
- **UK AIP ENR 5.1**: [Prohibited, Restricted and Danger Areas](https://www.aurora.nats.co.uk/htmlAIP/Publications/current-AIRAC/html/eAIP/EG-ENR-5.1-en-GB.html)
- **CAA**: [Drone airspace restrictions](https://www.caa.co.uk/drones/airspace-and-restrictions/airspace-restrictions-for-remotely-piloted-aircraft-and-drones/)
