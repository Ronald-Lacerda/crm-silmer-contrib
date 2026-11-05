import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBatchPlan,
  bindBatch,
  executeBatch,
  parseWithLexemes,
  BATCH_NAME,
} from './controlled-batch.mjs';
// Isolated mock fixture, no valid taxpayer identity and no external fetch.
import { input, provider } from './controlled-batch.fixtures.mjs';
async function run(options = {}, mutate) {
  const plan = await loadBatchPlan(),
    privateInput = input();
  mutate?.(privateInput);
  const bound = bindBatch(plan, privateInput),
    mock = provider(plan, options),
    directory = await mkdtemp(join(tmpdir(), 'olist-f1-batch-'));
  try {
    const result = await executeBatch(bound, {
      token: 'MOCK',
      approvedDigest: bound.digest,
      journalDirectory: directory,
      fetcher: mock.fetch,
      pause: async () => {},
    });
    let journal = '';
    try {
      journal = await readFile(join(directory, BATCH_NAME + '.jsonl'), 'utf8');
    } catch {}
    return { result, journal, calls: mock.calls, bound, directory };
  } finally {
    await rm(join(directory, BATCH_NAME + '.jsonl'), { force: true });
    await (await import('node:fs/promises')).rmdir(directory);
  }
}
test('numeric source preserves six decimals and trailing zeros', () => {
  const p = parseWithLexemes('{"x":0.000010,"y":1.025,"z":1.00}');
  assert.equal(p.numeric.x.lexeme, '0.000010');
  assert.equal(p.numeric.z.lexeme, '1.00');
});
test('complete approved batch has six POSTs and independent per-line data', async () => {
  const { result, journal, calls } = await run();
  assert.equal(
    result.state,
    'api_batch_completed_ui_proof_required',
    JSON.stringify(result),
  );
  assert.equal(result.erpPostAttempts, 6);
  assert.equal(result.anonymousGets, 1);
  assert.ok(result.gets < 80);
  assert.equal(calls.filter((x) => x.method === 'POST').length, 6);
  assert.equal(result.outcomes.find((x) => x.resource === 'C03').lineCount, 4);
  assert.equal(
    result.outcomes.find((x) => x.resource === 'C04').lines[0].quantity,
    1000,
  );
  assert.equal(result.f1GatePassed, false);
  assert.ok(!journal.includes(input().customer.cpfCnpj));
});
test('lost C02 reference stops before C03 and preserves ID', async () => {
  const { result, journal, calls } = await run({ dropReference: true });
  assert.equal(result.code, 'ORDER_REFERENCE_DIVERGENT');
  assert.equal(result.erpPostAttempts, 4);
  assert.equal(
    calls.filter((x) => x.method === 'POST' && x.p === '/pedidos').length,
    1,
  );
  assert.ok(journal.includes('"resource":"C02","id":400'));
  assert.equal(result.outcomes.at(-1).originIdState, 'zero');
  assert.equal(result.outcomes.at(-1).observedMoney.totalOrderLexeme, '3');
});
test('unknown parent POST keeps reservation and stops all child/order writes', async () => {
  const { result, journal } = await run({ timeoutParent: true });
  assert.equal(result.code, 'HTTP_OUTCOME_UNKNOWN');
  assert.equal(result.erpPostAttempts, 2);
  assert.ok(journal.includes('"resource":"parent"'));
  assert.ok(!journal.includes('"resource":"GG"'));
});
test('successful response without parent ID cannot start dependents', async () => {
  const { result } = await run({ noParentId: true });
  assert.equal(result.code, 'CREATED_ID_MISSING');
  assert.equal(result.erpPostAttempts, 2);
});
test('duplicate fiscal identity prevents every POST', async () => {
  const { result } = await run({ ambiguousCustomer: true });
  assert.equal(result.code, 'CUSTOMER_AMBIGUOUS');
  assert.equal(result.erpPostAttempts, 0);
});
test('existing test SKU prevents every POST', async () => {
  const { result } = await run({ existingSku: true });
  assert.equal(result.code, 'TEST_SKU_EXISTS');
  assert.equal(result.erpPostAttempts, 0);
});
test('pre-existing durable batch reservation cannot dispatch any request', async () => {
  const plan = await loadBatchPlan(),
    bound = bindBatch(plan, input()),
    dir = await mkdtemp(join(tmpdir(), 'olist-f1-reserve-'));
  const fs = await import('node:fs/promises'),
    path = join(dir, BATCH_NAME + '.jsonl');
  await fs.writeFile(path, '{"event":"batch-reserved"}\n');
  try {
    await assert.rejects(
      executeBatch(bound, {
        token: 'MOCK',
        approvedDigest: bound.digest,
        journalDirectory: dir,
        fetcher: () => assert.fail('NO REQUEST'),
      }),
      /BATCH_ALREADY_RESERVED/,
    );
  } finally {
    await fs.unlink(path);
    await fs.rmdir(dir);
  }
});
test('private selection changes invalidate approved digest before network', async () => {
  const plan = await loadBatchPlan(),
    bound = bindBatch(plan, input());
  await assert.rejects(
    executeBatch(bound, { approvedDigest: '0'.repeat(64) }),
    /EXPLICIT_APPROVAL_REQUIRED/,
  );
  assert.throws(
    () => bindBatch(plan, { ...input(), date: '2026-11-05' }),
    /INVALID_PRIVATE_PLAN/,
  );
});

test('HTTP400 exposes only allowed field/category, never provider values, and sends no dependent POST', async () => {
  const { result, journal } = await run({ rejectCustomer: true });
  assert.equal(result.code, 'HTTP_400');
  assert.equal(result.erpPostAttempts, 1);
  assert.deepEqual(result.calls.at(-1).validationFields, ['cpfCnpj']);
  assert.deepEqual(result.calls.at(-1).validationCategories, ['invalid']);
  assert.ok(!JSON.stringify(result).includes('00.000.000/0000-00'));
  assert.ok(!JSON.stringify(result).includes('SECRET_NOT_FOR_ARTIFACT'));
  assert.ok(!journal.includes('"event":"created"'));
});
test('reconciliation of rejected customer uses thirteen GETs and never frees reservation', async () => {
  const previous = await run({ rejectCustomer: true });
  const { reconcileRejectedCustomer } = await import('./controlled-batch.mjs');
  const fs = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'olist-rejected-read-'));
  const journal = join(dir, BATCH_NAME + '.jsonl');
  await fs.writeFile(journal, previous.journal);
  const mock = provider(await loadBatchPlan());
  try {
    const result = await reconcileRejectedCustomer(previous.bound, {
      token: 'MOCK',
      journalDirectory: dir,
      fetcher: mock.fetch,
      pause: async () => {},
    });
    assert.equal(result.gets, 13);
    assert.equal(result.erpPostAttempts, 0);
    assert.equal(result.allQueriesEmpty, true);
    assert.equal(result.zeroDoesNotAuthorizeRetry, true);
    assert.ok(mock.calls.every((c) => c.method === 'GET'));
    assert.equal(await fs.readFile(journal, 'utf8'), previous.journal);
  } finally {
    await fs.unlink(journal);
    await fs.rmdir(dir);
  }
});
