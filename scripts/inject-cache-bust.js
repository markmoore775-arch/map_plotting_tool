#!/usr/bin/env node
/**
 * Injects a cache-busting timestamp into index.html before deploy.
 * Replaces {{CACHE_BUST}} with current Unix timestamp.
 */
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const bust = Date.now();
html = html.replace(/\{\{CACHE_BUST\}\}/g, String(bust));
fs.writeFileSync(indexPath, html);
console.log(`Injected cache-bust: ${bust}`);
