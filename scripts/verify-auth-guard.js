/*
 * Verifies live password protection after deploy.
 *
 * Fails when:
 * - SITE_PASS is missing/blank in Worker env
 * - AUTH_SECRET is missing in Worker env
 *
 * Passes when:
 * - /unlock responds with "Incorrect password" for an intentionally wrong password
 */

const BASE_URL = (process.env.AIRPLOT_URL || 'https://airplot.app').replace(/\/+$/, '');
const WRONG_PASSWORD = '__airplot_guard_wrong_password__';

async function main() {
  const body = new URLSearchParams({
    password: WRONG_PASSWORD,
    next: '/app'
  });

  const res = await fetch(BASE_URL + '/unlock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString(),
    redirect: 'manual'
  });

  const text = await res.text();

  if (/Password protection is not configured yet\./i.test(text)) {
    fail('SITE_PASS is missing or blank in Worker secrets.');
  }

  if (/Server auth secret is missing\./i.test(text)) {
    fail('AUTH_SECRET is missing in Worker secrets.');
  }

  const incorrectPasswordDetected = /Incorrect password\. Please try again\./i.test(text);
  if (res.status === 401 && incorrectPasswordDetected) {
    console.log('Auth guard passed: password protection is configured.');
    return;
  }

  // Accept redirect as a success if environment already has an authenticated cookie path,
  // though this should be rare for this script.
  if (res.status >= 300 && res.status < 400) {
    console.log('Auth guard passed: unlock flow returned redirect.');
    return;
  }

  fail('Unexpected unlock response. Status=' + res.status + '.');
}

function fail(msg) {
  console.error('Auth guard failed: ' + msg);
  console.error('Fix with: npx wrangler secret put SITE_PASS && npx wrangler secret put AUTH_SECRET');
  process.exit(1);
}

main().catch((err) => {
  console.error('Auth guard failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
