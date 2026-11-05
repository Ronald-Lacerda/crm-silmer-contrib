import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactCentFixture,
  exactCentMock,
} from './exact-cent-proof.fixtures.mjs';
import { mkdtemp, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeExactCentProof } from './exact-cent-proof.mjs';

async function setup(t, change) {
  const root = await mkdtemp(join(tmpdir(), 'olist-exact-proof-'));
  t.after(async () => {
    for (const name of await readdir(root)) await unlink(join(root, name));
    await rmdir(root);
  });
  const prepared = exactCentFixture();
  const transport = exactCentMock(prepared.plan, change);
  const options = {
    ...prepared,
    credentials: {
      credentialsRenewed: true,
      verifiedAccountDocument: '00000000000000',
      v3AccessToken: 'MOCK',
    },
    journalPath: join(root, 'proof.jsonl'),
    fetcher: transport.fetcher,
    pause: async () => {},
  };
  return { ...prepared, ...transport, options };
}
test('three fixed exact-cent orders use14GET/3POST,520cents,opaque markers and exact decimal payloads', async (t) => {
  const { plan, options, calls } = await setup(t);
  const result = await executeExactCentProof(plan, options);
  assert.equal(result.state, 'exact_cent_api_proof_completed');
  assert.equal(result.gets, 14);
  assert.equal(result.postAttempts, 3);
  assert.equal(result.nominalTotalCents, 520);
  assert.equal(result.apiProofPassed, true);
  assert.equal(result.f1GatePassed, false);
  assert.equal(calls.length, 17);
  assert.ok(
    result.results.every(
      (r) => r.markerIdentityVerified && r.exactLineMoneyVerified,
    ),
  );
  await assert.rejects(executeExactCentProof(plan, options), {
    code: 'EEXIST',
  });
  assert.equal(calls.length, 17);
});
for (const [label, change] of [
  [
    'missing marker',
    (kind, b) => {
      if (kind === 'detail') delete b.itens[0].infoAdicional;
      return b;
    },
  ],
  [
    'duplicate marker',
    (kind, b) => {
      if (kind === 'detail')
        b.itens[0].infoAdicional = b.itens[1].infoAdicional;
      return b;
    },
  ],
  [
    'product mismatch',
    (kind, b) => {
      if (kind === 'detail') b.itens[0].produto.id = 999;
      return b;
    },
  ],
  [
    'quantity mismatch',
    (kind, b) => {
      if (kind === 'detail') b.itens[0].quantidade = 99;
      return b;
    },
  ],
  [
    'subtotal mismatch with equal global total',
    (kind, b) => {
      if (kind === 'detail') b.itens[0].valorUnitario = 0.03;
      return b;
    },
  ],
  [
    'wrong total',
    (kind, b) => {
      if (kind === 'detail') b.valorTotalPedido = 0.01;
      return b;
    },
  ],
  [
    'malformed POST JSON',
    (kind, b) =>
      kind === 'post'
        ? new Response('PRIVATE_PROVIDER_DETAIL', {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        : b,
  ],
  ['missing POST ID', (kind, b) => (kind === 'post' ? {} : b)],
  [
    'POST rejection',
    (kind, b) =>
      kind === 'post'
        ? new Response('PRIVATE_PROVIDER_DETAIL', {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        : b,
  ],
  [
    'POST timeout',
    (kind, b) => {
      if (kind === 'post') throw Error('PRIVATE_SECRET_URL');
      return b;
    },
  ],
])
  test(
    label +
      ' stops after one POST and never retries/deletes/creates dependents',
    async (t) => {
      const { plan, options, calls } = await setup(t, change);
      const result = await executeExactCentProof(plan, options);
      assert.equal(result.state, 'exact_cent_proof_stopped');
      assert.equal(result.postAttempts, 1);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
      assert.equal(result.apiProofPassed, false);
      assert.ok(!JSON.stringify(result).includes('PRIVATE'));
      const journal = await readFile(options.journalPath, 'utf8');
      assert.ok(journal.includes('post-attempt-reserved'));
    },
  );
test('changed approval, fractional plan or unrenewed credentials blocks before HTTP', async (t) => {
  const { plan, options, calls } = await setup(t);
  await assert.rejects(
    executeExactCentProof(plan, { ...options, approvedDigest: '0'.repeat(64) }),
  );
  const changed = structuredClone(plan);
  changed.orders[0].groups[0].lines[0].subtotalCents = 1;
  await assert.rejects(
    executeExactCentProof(changed, {
      ...options,
      approvedDigest: createHash('sha256')
        .update(JSON.stringify(changed))
        .digest('hex'),
    }),
  );
  await assert.rejects(
    executeExactCentProof(plan, {
      ...options,
      credentials: { ...options.credentials, credentialsRenewed: false },
    }),
  );
  assert.equal(calls.length, 0);
});
test('POST ID is journalled before stopping on exhausted quota', async (t) => {
  const { plan, options } = await setup(t, (kind, b) =>
    kind === 'post'
      ? new Response(JSON.stringify(b), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '0',
          },
        })
      : b,
  );
  const result = await executeExactCentProof(plan, options);
  assert.equal(result.code, 'EXACT_CENT_QUOTA_EXHAUSTED');
  assert.equal(result.createdOrders, 1);
  assert.ok(
    (await readFile(options.journalPath, 'utf8')).includes('"event":"created"'),
  );
});
