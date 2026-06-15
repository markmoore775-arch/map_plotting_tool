#!/usr/bin/env node
/**
 * Checks airplan.uk Cloudflare zone status and deploys when active.
 * Usage:
 *   node scripts/setup-airplan-domain.mjs          # status only
 *   node scripts/setup-airplan-domain.mjs --deploy # deploy when zone is active
 *   node scripts/setup-airplan-domain.mjs --watch  # poll until active, then deploy
 */

import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ZONE_NAME = 'airplan.uk';
const ACCOUNT_ID = '8f133b3cbd166fd5db11242963d9cce2';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function getWranglerToken() {
  const out = execSync('npx wrangler auth token', { cwd: ROOT, encoding: 'utf8' });
  const lines = out.trim().split('\n');
  return lines[lines.length - 1].trim();
}

async function cfGet(pathname) {
  const token = getWranglerToken();
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`Cloudflare API ${pathname}: ${JSON.stringify(json.errors || json)}`);
  }
  return json;
}

async function getZone() {
  const json = await cfGet(`/zones?name=${ZONE_NAME}`);
  return json.result?.[0] || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const deploy = process.argv.includes('--deploy');
  const watch = process.argv.includes('--watch');

  for (;;) {
    const zone = await getZone();
    if (!zone) {
      console.error(`Zone ${ZONE_NAME} not found in Cloudflare. Add it in the dashboard first.`);
      process.exit(1);
    }

    console.log(`Zone: ${zone.name}`);
    console.log(`Status: ${zone.status}`);
    if (zone.activation_failure_reason) {
      console.log(`Activation issue: ${zone.activation_failure_reason}`);
    }
    console.log('Set Porkbun nameservers to:');
    for (const ns of zone.name_servers || []) {
      console.log(`  - ${ns}`);
    }
    if (zone.original_name_servers?.length) {
      console.log('Current registrar nameservers (from Cloudflare scan):');
      for (const ns of zone.original_name_servers) {
        console.log(`  - ${ns}`);
      }
    }

    if (zone.status === 'active') {
      console.log('\nZone is active.');
      if (deploy || watch) {
        console.log('Running npm run deploy...');
        const result = spawnSync('npm', ['run', 'deploy'], { cwd: ROOT, stdio: 'inherit', shell: true });
        process.exit(result.status ?? 1);
      }
      console.log('Run with --deploy to attach Worker domains and publish.');
      return;
    }

    if (!watch) {
      console.log('\nWaiting for Porkbun nameserver update. Re-run with --watch to auto-deploy when ready.');
      return;
    }

    console.log('\nZone not active yet. Checking again in 60s...');
    await sleep(60000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
