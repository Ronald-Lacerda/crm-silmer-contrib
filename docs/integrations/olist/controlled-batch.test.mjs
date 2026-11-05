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

async function diagnosticRun(rejectCustomer) {
  const previous = await run({ rejectCustomer: true });
  const { diagnoseCustomerOnce } = await import('./controlled-batch.mjs');
  const fs = await import('node:fs/promises'),
    dir = await mkdtemp(join(tmpdir(), 'olist-diagnostic-once-'));
  const original = join(dir, BATCH_NAME + '.jsonl'),
    diagnostic = join(dir, 'CUSTOMER-DIAG01.jsonl');
  await fs.writeFile(original, previous.journal);
  const mock = provider(await loadBatchPlan(), { rejectCustomer });
  try {
    const options = {
      token: 'MOCK',
      approvedDigest: previous.bound.digest,
      journalDirectory: dir,
      fetcher: mock.fetch,
      pause: async () => {},
    };
    const result = await diagnoseCustomerOnce(previous.bound, options);
    assert.equal(await fs.readFile(original, 'utf8'), previous.journal);
    const callsBefore = mock.calls.length;
    await assert.rejects(
      diagnoseCustomerOnce(previous.bound, options),
      /DIAGNOSTIC_ALREADY_RESERVED/,
    );
    assert.equal(mock.calls.length, callsBefore);
    return {
      result,
      journal: await fs.readFile(diagnostic, 'utf8'),
      calls: mock.calls,
    };
  } finally {
    for (const p of [original, diagnostic]) {
      try {
        await fs.unlink(p);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    await fs.rmdir(dir);
  }
}
test('explicit diagnostic rejection sends exactly the original customer once, records safe fields, leaves both reservations', async () => {
  const { result, journal, calls } = await diagnosticRun(true);
  assert.equal(result.code, 'HTTP_400');
  assert.equal(result.gets, 14);
  assert.equal(result.erpPostAttempts, 1);
  assert.deepEqual(result.calls.at(-1).validationFields, ['cpfCnpj']);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(!journal.includes('"event":"created"'));
  assert.equal(result.dependentPosts, 0);
});
test('successful diagnostic preserves confirmed ID and reconciles fiscal identity without creating dependents', async () => {
  const { result, journal } = await diagnosticRun(false);
  assert.equal(
    result.state,
    'diagnostic_customer_created_and_reconciled',
    JSON.stringify(result),
  );
  assert.equal(result.gets, 17);
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(result.dependentPosts, 0);
  assert.ok(journal.includes('"event":"api-reconciled"'));
  assert.equal(result.identicalOriginalPayload, true);
});

async function correctedRun(options = {}) {
  const before = await run({ rejectCustomer: true });
  const fs = await import('node:fs/promises'),
    { executeCorrectedBatch } = await import('./controlled-batch.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'olist-corrected-'));
  const original = join(directory, BATCH_NAME + '.jsonl'),
    diag = join(directory, 'CUSTOMER-DIAG01.jsonl'),
    corrected = join(directory, 'CUSTOMER-CORRECTED01-FULL.jsonl');
  const events = before.journal.trim().split('\n').map(JSON.parse),
    originalHash = events.find((x) => x.resource === 'customer').payloadHash;
  const diagContents =
    JSON.stringify({
      event: 'diagnostic-reserved',
      originalPayloadHash: originalHash,
    }) + '\n';
  await fs.writeFile(original, before.journal);
  await fs.writeFile(diag, diagContents);
  const mock = provider(await loadBatchPlan(), options),
    payloads = [];
  try {
    const result = await executeCorrectedBatch(before.bound, {
      token: 'MOCK',
      approvedDigest: before.bound.digest,
      journalDirectory: directory,
      pause: async () => {},
      fetcher: async (url, init) => {
        if (
          init.method === 'POST' &&
          new URL(url).pathname.endsWith('/contatos')
        )
          payloads.push(JSON.parse(init.body));
        return mock.fetch(url, init);
      },
    });
    assert.equal(await fs.readFile(original, 'utf8'), before.journal);
    assert.equal(await fs.readFile(diag, 'utf8'), diagContents);
    assert.equal(payloads.length, 1);
    const expected = { ...input().customer, tipos: [5] };
    delete expected.codigo;
    assert.deepEqual(payloads[0], expected);
    const count = mock.calls.length;
    await assert.rejects(
      executeCorrectedBatch(before.bound, {
        token: 'MOCK',
        approvedDigest: before.bound.digest,
        journalDirectory: directory,
        fetcher: () => assert.fail('no second dispatch'),
      }),
      /BATCH_ALREADY_RESERVED/,
    );
    assert.equal(mock.calls.length, count);
    return {
      result,
      journal: await fs.readFile(corrected, 'utf8'),
      calls: mock.calls,
    };
  } finally {
    for (const f of [original, diag, corrected]) {
      try {
        await fs.unlink(f);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    await fs.rmdir(directory);
  }
}
test('approved corrected batch removes only codigo, reconciles assigned code and executes unchanged dependents', async () => {
  const { result, journal } = await correctedRun();
  assert.equal(
    result.state,
    'api_batch_completed_ui_proof_required',
    JSON.stringify(result),
  );
  assert.equal(result.erpPostAttempts, 6);
  assert.equal(result.anonymousGets, 0);
  assert.ok(result.gets <= 66);
  assert.equal(result.previousAuthenticatedGets + result.gets <= 120, true);
  assert.equal(result.previousPostAttempts + result.erpPostAttempts, 8);
  assert.equal(result.outcomes.find((x) => x.resource === 'C03').lineCount, 4);
  assert.ok(journal.includes('"omittedField":"codigo"'));
  assert.ok(journal.includes('"resource":"C04"'));
});
test('corrected rejection preserves both historical reservations and sends no dependent POST', async () => {
  const { result, calls } = await correctedRun({ rejectCustomer: true });
  assert.equal(result.code, 'HTTP_400');
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(calls.filter((x) => x.method === 'POST').length, 1);
});
test('corrected C02 reference divergence stops C03/C04 with confirmed IDs journalled', async () => {
  const { result, journal, calls } = await correctedRun({
    dropReference: true,
  });
  assert.equal(result.code, 'ORDER_REFERENCE_DIVERGENT');
  assert.equal(result.erpPostAttempts, 4);
  assert.equal(
    calls.filter((x) => x.p === '/pedidos' && x.method === 'POST').length,
    1,
  );
  assert.ok(journal.includes('"resource":"C02","id":400'));
});
test('complete partial SKU search is matched locally by exact SKU and parent IDs', async () => {
  const { result } = await correctedRun({ partialProducts: true });
  assert.equal(
    result.state,
    'api_batch_completed_ui_proof_required',
    JSON.stringify(result),
  );
});

async function ggReadback(changedInitial = false) {
  const previous = await correctedRun({ ggReturnsParent: true });
  assert.equal(previous.result.code, 'VARIATION_LINK_CHANGED');
  const { reconcileCreatedGG } = await import('./controlled-batch.mjs'),
    fs = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'olist-gg-read-')),
    file = join(root, 'CUSTOMER-CORRECTED01-FULL.jsonl');
  await fs.writeFile(file, previous.journal);
  const plan = await loadBatchPlan(),
    mock = provider(plan, { seedCreatedGG: true });
  try {
    const result = await reconcileCreatedGG(bindBatch(plan, input()), {
      token: 'MOCK',
      journalDirectory: root,
      pause: async () => {},
      fetcher: async (url, init) => {
        assert.equal(init.method, 'GET');
        const r = await mock.fetch(url, init);
        if (changedInitial && new URL(url).pathname.endsWith('/produtos/200')) {
          const b = await r.json();
          b.variacoes[0].id = 299;
          return new Response(JSON.stringify(b), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return r;
      },
    });
    const journal = await fs.readFile(file, 'utf8');
    assert.ok(journal.startsWith(previous.journal));
    return { result, journal, calls: mock.calls };
  } finally {
    await fs.unlink(file);
    await fs.rmdir(root);
  }
}
test('GG POST returning parent ID is reconciled by six GETs and the exact canonical child', async () => {
  const { result, journal, calls } = await ggReadback();
  assert.equal(
    result.state,
    'gg_reconciled_by_parent_and_exact_sku',
    JSON.stringify(result),
  );
  assert.equal(result.gets, 6);
  assert.equal(result.erpPostAttempts, 0);
  assert.equal(result.responseIdRelation, 'parent');
  assert.ok(result.initialMStable && result.initialGStable);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.ok(journal.includes('"canonicalId":203,"responseId":200'));
});
test('GG reconciliation never accepts changed original M/G identity', async () => {
  const { result, journal } = await ggReadback(true);
  assert.equal(result.code, 'INITIAL_VARIATION_IDS_CHANGED');
  assert.equal(result.erpPostAttempts, 0);
  assert.ok(!journal.includes('"event":"gg-reconciled"'));
});

async function ordersRun(dropReference = false) {
  const fs = await import('node:fs/promises'),
    { executeRemainingOrders } = await import('./controlled-batch.mjs');
  const before = await correctedRun({ ggReturnsParent: true }),
    events = before.journal.trim().split('\n').map(JSON.parse);
  const originalHash = events[0].originalCustomerHash;
  const gg = {
    event: 'gg-reconciled',
    canonicalId: 203,
    responseId: 200,
    parentId: 200,
    ids: { M: 201, G: 202, GG: 203 },
    responseIdRelation: 'parent',
  };
  const root = await mkdtemp(join(tmpdir(), 'olist-orders-resume-'));
  const src = join(root, 'CUSTOMER-CORRECTED01-FULL.jsonl'),
    original = join(root, BATCH_NAME + '.jsonl'),
    out = join(root, 'F1-ORDERS-20261104.jsonl');
  const content = before.journal + JSON.stringify(gg) + '\n';
  await fs.writeFile(src, content);
  await fs.writeFile(
    original,
    JSON.stringify({
      event: 'reserved',
      resource: 'customer',
      payloadHash: originalHash,
    }) + '\n',
  );
  const plan = await loadBatchPlan(),
    bound = bindBatch(plan, input()),
    mock = provider(plan, {
      seedCreatedGG: true,
      seedCreatedCustomer: true,
      dropReference,
    });
  const bodies = [];
  try {
    const result = await executeRemainingOrders(bound, {
      token: 'MOCK',
      approvedDigest: bound.digest,
      journalDirectory: root,
      pause: async () => {},
      fetcher: async (url, init) => {
        if (init.method === 'POST') bodies.push(init.body);
        return mock.fetch(url, init);
      },
    });
    assert.equal(await fs.readFile(src, 'utf8'), content);
    await assert.rejects(
      executeRemainingOrders(bound, {
        token: 'MOCK',
        approvedDigest: bound.digest,
        journalDirectory: root,
        fetcher: () => assert.fail('no replay'),
      }),
      /ORDERS_ALREADY_RESERVED/,
    );
    return { result, bodies, calls: mock.calls };
  } finally {
    for (const p of [src, original, out]) {
      try {
        await fs.unlink(p);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    await fs.rmdir(root);
  }
}
test('order-only resume creates exactly three approved orders, retains raw six-place literal and no other records', async () => {
  const { result, bodies, calls } = await ordersRun();
  assert.equal(
    result.state,
    'approved_orders_completed_ui_proof_required',
    JSON.stringify(result),
  );
  assert.equal(result.erpPostAttempts, 3);
  assert.equal(result.gets, 16);
  assert.equal(result.previousAuthenticatedGets + result.gets, 116);
  assert.ok(
    calls.filter((c) => c.method === 'POST').every((c) => c.p === '/pedidos'),
  );
  assert.match(bodies[2], /"valorUnitario":0\.000010/);
  assert.equal(result.outcomes.find((x) => x.resource === 'C03').lineCount, 4);
});
test('order-only resume stops after C02 reference loss without creating C03 or C04', async () => {
  const { result, bodies } = await ordersRun(true);
  assert.equal(result.code, 'ORDER_REFERENCE_DIVERGENT');
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(bodies.length, 1);
  assert.equal(result.gets, 10);
});

async function lastProbeRun(
  badC03Numeric = false,
  c03ProductProjectionDiffers = false,
) {
  const fs = await import('node:fs/promises'),
    { executeLastScaleProbe } = await import('./controlled-batch.mjs');
  const before = await correctedRun({ ggReturnsParent: true }),
    events = before.journal.trim().split('\n').map(JSON.parse),
    originalHash = events[0].originalCustomerHash;
  const plan = await loadBatchPlan(),
    bound = bindBatch(plan, input()),
    root = await mkdtemp(join(tmpdir(), 'olist-last-scale-'));
  const src = join(root, 'CUSTOMER-CORRECTED01-FULL.jsonl'),
    orig = join(root, BATCH_NAME + '.jsonl'),
    prior = join(root, 'F1-ORDERS-20261104.jsonl'),
    last = join(root, 'F1-C04-20261104.jsonl');
  await fs.writeFile(
    src,
    before.journal +
      JSON.stringify({
        event: 'gg-reconciled',
        canonicalId: 203,
        responseId: 200,
        parentId: 200,
        ids: { M: 201, G: 202, GG: 203 },
      }) +
      '\n',
  );
  await fs.writeFile(
    orig,
    JSON.stringify({
      event: 'reserved',
      resource: 'customer',
      payloadHash: originalHash,
    }) + '\n',
  );
  const priorContent =
    [
      { event: 'orders-reserved', planHash: bound.digest },
      { event: 'created', resource: 'C02', id: 400 },
      { event: 'api-reconciled', resource: 'C02', id: 400 },
      { event: 'reserved', resource: 'C03' },
      { event: 'created', resource: 'C03', id: 401 },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n';
  await fs.writeFile(prior, priorContent);
  const mock = provider(plan, {
      seedCreatedGG: true,
      seedCreatedCustomer: true,
      seedRoundingOrders: true,
      badC03Numeric,
      c03ProductProjectionDiffers,
    }),
    bodies = [];
  try {
    const opts = {
      token: 'MOCK',
      approvedDigest: bound.digest,
      journalDirectory: root,
      pause: async () => {},
      fetcher: async (url, init) => {
        if (init.method === 'POST') bodies.push(init.body);
        return mock.fetch(url, init);
      },
    };
    const result = await executeLastScaleProbe(bound, opts);
    assert.ok((await fs.readFile(prior, 'utf8')).startsWith(priorContent));
    if (!badC03Numeric)
      await assert.rejects(
        executeLastScaleProbe(bound, opts),
        /ORDERS_ALREADY_RESERVED/,
      );
    return { result, bodies, calls: mock.calls };
  } finally {
    for (const f of [src, orig, prior, last]) {
      try {
        await fs.unlink(f);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    await fs.rmdir(root);
  }
}
test('C04-only resume reconciles C03 against predeclared cents and creates exactly one unchanged last probe', async () => {
  const { result, bodies, calls } = await lastProbeRun();
  assert.equal(
    result.state,
    'approved_orders_completed_ui_proof_required',
    JSON.stringify(result),
  );
  assert.equal(result.gets, 6);
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(result.previousAuthenticatedGets + result.gets, 120);
  assert.equal(result.previousPostAttempts + result.erpPostAttempts, 8);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /CRM-F1-20261104-C04/);
  assert.match(bodies[0], /"valorUnitario":0\.000010/);
  assert.ok(
    calls.filter((x) => x.method === 'POST').every((x) => x.p === '/pedidos'),
  );
});
test('C04 is blocked if fresh C03 values no longer match the independently checked diagnostic', async () => {
  const { result, bodies } = await lastProbeRun(true);
  assert.equal(result.erpPostAttempts, 0);
  assert.equal(bodies.length, 0);
  assert.equal(result.code, 'ORDER_LINES_AMBIGUOUS');
});

test('C04 preserves the independently proved per-line check while explicitly recording a different API product-total projection', async () => {
  const { result, bodies } = await lastProbeRun(false, true);
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(bodies.length, 1);
  const projection = result.outcomes.find(
    (x) => x.resource === 'C03-read-only-diagnostic',
  );
  assert.equal(projection.totalProductsLexeme, '1.08');
  assert.equal(projection.totalOrderLexeme, '1.1');
  assert.equal(projection.productTotalProjectionMatchesUi, false);
});
