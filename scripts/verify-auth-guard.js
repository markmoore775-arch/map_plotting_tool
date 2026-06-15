/*
 * Verifies the live site serves the public app shell after deploy.
 */

const BASE_URL = (process.env.AIRPLAN_URL || 'https://airplan.uk').replace(/\/+$/, '');

async function main() {
  const res = await fetch(BASE_URL + '/', { redirect: 'follow' });
  const text = await res.text();

  if (!res.ok) {
    fail('Homepage returned HTTP ' + res.status + '.');
  }

  if (/Enter the password to access AirPlan/i.test(text) || /class="login-btn"/i.test(text)) {
    fail('Homepage is still password-gated.');
  }

  if (!/AirPlan/i.test(text)) {
    fail('Homepage did not return expected AirPlan content.');
  }

  console.log('Live site check passed: public app is reachable.');
}

function fail(msg) {
  console.error('Live site check failed: ' + msg);
  process.exit(1);
}

main().catch((err) => {
  console.error('Live site check failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
