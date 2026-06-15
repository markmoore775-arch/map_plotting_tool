#!/usr/bin/env node
/**
 * Generates PWA/home-screen PNGs and raster logo fallbacks from AirPlan SVG assets.
 * Uses sharp for SVG to PNG conversion.
 */

const path = require('path');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const LOGO_WHITE_PNG = path.join(ASSETS_DIR, 'airplanlogowhite.png');

async function rasterizeIcon(size, outPath, paddingPercent = 0.08) {
  const innerSize = Math.round(size * (1 - paddingPercent * 2));
  const logo = await sharp(LOGO_WHITE_PNG)
    .resize(innerSize, innerSize, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const { width = innerSize, height = innerSize } = await sharp(logo).metadata();
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - height) / 2);

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: logo, left, top }])
    .png()
    .toFile(outPath);
}

async function rasterizeLogo(size, outPath) {
  await sharp(LOGO_WHITE_PNG)
    .resize(size, size, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
}

async function generateIcons() {
  await rasterizeIcon(512, path.join(ASSETS_DIR, 'icon-512.png'));
  await rasterizeIcon(192, path.join(ASSETS_DIR, 'icon-192.png'));
  await rasterizeIcon(180, path.join(ASSETS_DIR, 'icon-180.png'));
  await rasterizeIcon(1024, path.join(ASSETS_DIR, 'airplan-icon.png'));
  await rasterizeLogo(2048, path.join(ASSETS_DIR, 'airplan-logo.png'));

  console.log('Generated assets/icon-192.png, icon-180.png, icon-512.png');
  console.log('Generated assets/airplan-icon.png, airplan-logo.png');
}

generateIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
