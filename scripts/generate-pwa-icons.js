#!/usr/bin/env node
/**
 * Generates 192x192 and 512x512 PNG icons from assets/airplot-icon.svg
 * for PWA manifest and home screen. Uses sharp for SVG to PNG conversion.
 */

const path = require('path');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SVG_PATH = path.join(ASSETS_DIR, 'airplot-icon.svg');
const ICON_192 = path.join(ASSETS_DIR, 'icon-192.png');
const ICON_512 = path.join(ASSETS_DIR, 'icon-512.png');

const BACKGROUND = '#0a0a0a';

async function generateIcons() {
  const pipeline = sharp(SVG_PATH)
    .flatten({ background: BACKGROUND });

  await pipeline
    .clone()
    .resize(512, 512)
    .png()
    .toFile(ICON_512);

  await pipeline
    .clone()
    .resize(192, 192)
    .png()
    .toFile(ICON_192);

  console.log('Generated assets/icon-192.png and assets/icon-512.png');
}

generateIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
