import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { billingDevelopmentInteractive } from '../scripts/billing-development-interactive.mjs';

test('BDEV2-04 interactive CLI refuses remote targets and requires explicit synthetic reset', async () => {
  await assert.rejects(
    billingDevelopmentInteractive(['reset']),
    /explicit flag required/u,
  );
  await assert.rejects(
    billingDevelopmentInteractive(['up', 'https://production.example.test']),
    /No alternate host/u,
  );
  await assert.rejects(billingDevelopmentInteractive(['deploy']), /Use up/u);
});
test('BDEV2-04 financial and API services stay internal; only fixed ingress loopback ports are published', async () => {
  const manifest = await readFile('docker-compose.billing-dev.yml', 'utf8');
  assert.match(manifest, /billing-internal:\s+internal: true/u);
  assert.match(manifest, /127\.0\.0\.1:4180:4180/u);
  assert.match(manifest, /127\.0\.0\.1:5685:5685/u);
  assert.doesNotMatch(
    manifest,
    /host\.docker\.internal|network_mode: host|ORDER_BILLING_ENABLED:\s*['"]?true/u,
  );
  const ingress = await readFile(
    'scripts/billing-development-ingress.mjs',
    'utf8',
  );
  assert.match(ingress, /hostname = port === 5685 \? 'n8n' : 'billing-crm'/u);
  assert.doesNotMatch(
    ingress,
    /hostname:\s*request|fetch\(request|new URL\(request/u,
  );
});
