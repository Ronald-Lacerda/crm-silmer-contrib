/** OLIST-T02 / F1-G01. Bounded approved order reads; no ERP mutation, OAuth or retry. */
import { createHash } from 'node:crypto';
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { compareMoney, decimal } from './monetary-comparator.mjs';

const V3 = 'https://api.tiny.com.br/public-api/v3/pedidos/';
const V2 = 'https://api.tiny.com.br/api2/pedido.obter.php';
export const READ_APPROVAL = 'OLIST-T02-READBACK-SIX-READS';
export const FIVE_READ_APPROVAL =
  'OLIST-T02-C02-V2-REPLACEMENT-AND-FOUR-REMAINING';
const aliases = ['C02', 'C03', 'C04'];
const resourceNames = ['new-M', 'new-G', 'existing-M-from-C01'];
class ProbeError extends Error {}
const fail = (code) => {
  throw new ProbeError(code);
};
const digest = (x) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');
const document = (x) => {
  if (typeof x !== 'string' || !/^[0-9.\-/\s]{11,20}$/.test(x))
    fail('INVALID_ACCOUNT_BINDING');
  const s = x.replace(/\D/g, '');
  if (![11, 14].includes(s.length)) fail('INVALID_ACCOUNT_BINDING');
  return s;
};
const id = (x) => typeof x === 'string' && /^[1-9]\d{0,15}$/.test(x);
function validatePlan(plan) {
  if (
    plan?.approval !== READ_APPROVAL ||
    plan.maximumReads !== 6 ||
    !Array.isArray(plan.orders) ||
    plan.orders.map((o) => o.alias).join() !== aliases.join() ||
    !Array.isArray(plan.products) ||
    plan.products.map((p) => p.resource).join() !== resourceNames.join()
  )
    fail('INVALID_READ_PLAN');
  document(plan.accountDocument);
  document(plan.buyerDocument);
  if (
    !id(plan.originId) ||
    !id(plan.buyerId) ||
    new Set(plan.orders.map((o) => o.id)).size !== 3 ||
    new Set(plan.products.map((p) => p.id)).size !== 3 ||
    new Set(plan.products.map((p) => p.sku)).size !== 3
  )
    fail('INVALID_READ_PLAN');
  for (const product of plan.products)
    if (
      !id(product.id) ||
      typeof product.sku !== 'string' ||
      !product.sku ||
      product.sku.length > 100
    )
      fail('INVALID_READ_PLAN');
  for (const order of plan.orders) {
    if (
      !id(order.id) ||
      order.reference !== 'CRM-F1-20261104-' + order.alias ||
      order.date !== '2026-11-04' ||
      order.expected?.alias !== order.alias
    )
      fail('INVALID_READ_PLAN');
    // Reuse the comparator's strict input validation before reserving any read.
    compareMoney(order.expected, {
      lines: [],
      totalProducts: '0',
      totalOrder: '0',
    });
  }
}
export function parseDecimalJson(raw) {
  try {
    return JSON.parse(raw, (_key, value, context) => {
      if (typeof value !== 'number') return value;
      if (typeof context?.source !== 'string')
        fail('DECIMAL_SOURCE_UNAVAILABLE');
      return context.source;
    });
  } catch {
    fail('INVALID_PROVIDER_JSON');
  }
}
function monetary(x) {
  decimal(x);
  return x;
}
export function normalizeReadback(version, body, plan, order) {
  validatePlan(plan);
  if (!['v2', 'v3'].includes(version)) fail('INVALID_API_VERSION');
  if (version === 'v2' && body?.retorno?.status !== 'OK')
    fail('PROVIDER_READ_REJECTED');
  const b = version === 'v3' ? body : body.retorno.pedido;
  const reference =
    version === 'v3'
      ? b?.ecommerce?.numeroPedidoEcommerce
      : b?.numero_ecommerce;
  const buyer = version === 'v3' ? b?.cliente?.cpfCnpj : b?.cliente?.cpf_cnpj;
  const date =
    version === 'v3' ? b?.data : b?.data_pedido?.split('/').reverse().join('-');
  if (
    !b ||
    b.id !== order.id ||
    reference !== order.reference ||
    document(buyer) !== document(plan.buyerDocument) ||
    date !== order.date
  )
    fail('ORDER_IDENTITY_DIVERGENT');
  if (
    version === 'v3' &&
    (b.ecommerce.id !== plan.originId || b.cliente.id !== plan.buyerId)
  )
    fail('ORDER_IDENTITY_DIVERGENT');
  if (!Array.isArray(b.itens) || b.itens.length > 10)
    fail('INVALID_PROVIDER_LINES');
  const lines = b.itens.map((entry) => {
    const line = version === 'v3' ? entry : entry?.item;
    const productId = version === 'v3' ? line?.produto?.id : line?.id_produto;
    const sku = version === 'v3' ? line?.produto?.sku : line?.codigo;
    const byId = plan.products.find((p) => p.id === productId);
    const bySku = plan.products.find((p) => p.sku === sku);
    // Either supported identity may be absent, but present identities must agree.
    const product = byId ?? bySku;
    if (
      !product ||
      (productId != null && productId !== product.id) ||
      (sku != null && sku !== product.sku)
    )
      fail('PRODUCT_IDENTITY_DIVERGENT');
    return {
      resource: product.resource,
      quantity: monetary(line.quantidade),
      unit: monetary(
        version === 'v3' ? line.valorUnitario : line.valor_unitario,
      ),
    };
  });
  return {
    lines,
    totalProducts: monetary(
      version === 'v3' ? b.valorTotalProdutos : b.total_produtos,
    ),
    totalOrder: monetary(
      version === 'v3' ? b.valorTotalPedido : b.total_pedido,
    ),
  };
}
function contentTypeKind(response) {
  const type = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return ['application/json', 'text/plain', 'text/html'].includes(type)
    ? type
    : 'other';
}
async function responseText(response, version) {
  const reject = async (code) => {
    await response.body?.cancel().catch(() => {});
    fail(code);
  };
  if (response.status !== 200) return reject('READBACK_HTTP_REJECTED');
  const type = contentTypeKind(response);
  // The legacy PHP route may label JSON as text. Still parse strict JSON below;
  // HTML/challenges never become a valid order, and v3 remains JSON-only.
  if (
    type !== 'application/json' &&
    !(version === 'v2' && ['text/plain', 'text/html'].includes(type))
  )
    return reject('INVALID_CONTENT_TYPE');
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 131072) fail('RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof ProbeError) throw e;
    fail('READBACK_BODY_FAILED');
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function verifyFiveReadContinuation(
  plan,
  approvedDigest,
  continuation,
) {
  if (
    continuation?.approval !== FIVE_READ_APPROVAL ||
    typeof continuation.previousJournalPath !== 'string' ||
    !/^[a-f0-9]{64}$/.test(continuation.previousJournalSha256 ?? '')
  )
    fail('FIVE_READ_APPROVAL_REQUIRED');
  validatePlan(plan);
  if (digest(plan) !== approvedDigest) fail('READ_PLAN_APPROVAL_REQUIRED');
  const raw = await readFile(continuation.previousJournalPath);
  if (
    createHash('sha256').update(raw).digest('hex') !==
    continuation.previousJournalSha256
  )
    fail('PREVIOUS_READ_JOURNAL_CHANGED');
  let events;
  try {
    events = raw.toString('utf8').trim().split('\n').map(JSON.parse);
  } catch {
    fail('INVALID_PREVIOUS_READ_JOURNAL');
  }
  const attempts = events.filter((e) => e.event === 'read-attempt-reserved');
  const compared = events.filter((e) => e.event === 'read-compared');
  if (
    events[0]?.event !== 'six-read-budget-reserved' ||
    events[0].planDigest !== approvedDigest ||
    events[0].maximumReads !== 6 ||
    JSON.stringify(attempts.map((e) => [e.attempt, e.alias, e.version])) !==
      JSON.stringify([
        [1, 'C02', 'v3'],
        [2, 'C02', 'v2'],
      ]) ||
    compared.length !== 1 ||
    compared[0].alias !== 'C02' ||
    compared[0].version !== 'v3' ||
    events.at(-1)?.event !== 'stopped' ||
    events.at(-1).code !== 'INVALID_CONTENT_TYPE' ||
    events.at(-1).attemptedReads !== 2
  )
    fail('CONTINUATION_BASELINE_NOT_CONFIRMED');
  return { previousOrderReadAttempts: 2, maximumTotalOrderReadAttempts: 7 };
}
export async function runReadbackProbe(
  plan,
  {
    credentials,
    approvedDigest,
    journalPath,
    fetcher = fetch,
    pause = delay,
    signal,
    continuation,
  } = {},
) {
  validatePlan(plan);
  // Capture immutable inputs before any await, including references from caller.
  plan = JSON.parse(JSON.stringify(plan));
  credentials = { ...credentials };
  continuation = continuation ? { ...continuation } : null;
  if (approvedDigest !== digest(plan)) fail('READ_PLAN_APPROVAL_REQUIRED');
  if (credentials.credentialsRenewed !== true)
    fail('CREDENTIAL_RENEWAL_REQUIRED');
  if (
    document(credentials.verifiedAccountDocument) !==
    document(plan.accountDocument)
  )
    fail('ACCOUNT_SESSION_NOT_VERIFIED');
  if (
    !['v3AccessToken', 'v2Token'].every(
      (k) =>
        typeof credentials[k] === 'string' &&
        credentials[k].length > 0 &&
        credentials[k].length <= 16384 &&
        !/[\r\n]/.test(credentials[k]),
    )
  )
    fail('PRIVATE_CREDENTIALS_REQUIRED');
  if (typeof journalPath !== 'string' || !journalPath)
    fail('PRIVATE_JOURNAL_REQUIRED');
  const carry = continuation
    ? await verifyFiveReadContinuation(plan, approvedDigest, continuation)
    : null;
  if (
    carry &&
    resolve(journalPath) !==
      resolve(
        dirname(continuation.previousJournalPath),
        'five-read-journal.jsonl',
      )
  )
    fail('CONTINUATION_JOURNAL_PATH_INVALID');
  const maximumReads = carry ? 5 : 6;
  const schedule = plan.orders
    .flatMap((order) => ['v3', 'v2'].map((version) => ({ order, version })))
    .filter(
      ({ order, version }) =>
        !carry || order.alias !== 'C02' || version === 'v2',
    );
  let journal;
  try {
    journal = await open(journalPath, 'wx', 0o600);
  } catch {
    fail('READ_JOURNAL_UNAVAILABLE_OR_ALREADY_RESERVED');
  }
  let attemptedReads = 0;
  const results = [];
  const record = async (event) => {
    await journal.writeFile(JSON.stringify(event) + '\n');
    await journal.sync();
  };
  try {
    await record({
      event: carry
        ? 'five-read-continuation-reserved'
        : 'six-read-budget-reserved',
      planDigest: approvedDigest,
      maximumReads,
      ...(carry
        ? {
            ...carry,
            previousJournalSha256: continuation.previousJournalSha256,
          }
        : {}),
    });
    for (const { order, version } of schedule) {
      if (signal?.aborted) fail('READBACK_STOPPED');
      if (attemptedReads) await pause(1500);
      if (signal?.aborted) fail('READBACK_STOPPED');
      // Failed requests consume their slot. A restart never gets a fresh budget.
      await record({
        event: 'read-attempt-reserved',
        attempt: attemptedReads + 1,
        alias: order.alias,
        version,
      });
      attemptedReads++;
      let response;
      try {
        response = await fetcher(version === 'v3' ? V3 + order.id : V2, {
          method: version === 'v3' ? 'GET' : 'POST',
          redirect: 'error',
          headers:
            version === 'v3'
              ? {
                  Accept: 'application/json',
                  Authorization: 'Bearer ' + credentials.v3AccessToken,
                }
              : {
                  Accept: 'application/json',
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
          ...(version === 'v2'
            ? {
                body: new URLSearchParams({
                  token: credentials.v2Token,
                  formato: 'json',
                  id: order.id,
                }).toString(),
              }
            : {}),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        });
      } catch {
        fail('READBACK_HTTP_OUTCOME_UNKNOWN');
      }
      await record({
        event: 'read-response-received',
        attempt: attemptedReads,
        alias: order.alias,
        version,
        httpStatus: response.status,
        contentType: contentTypeKind(response),
      });
      const normalized = normalizeReadback(
        version,
        parseDecimalJson(await responseText(response, version)),
        plan,
        order,
      );
      const comparison = compareMoney(order.expected, normalized);
      // Store only fixed aliases, decimal lexemes and diagnostic data, never raw PII.
      const result = {
        alias: order.alias,
        version,
        observed: normalized,
        comparison,
      };
      await record({ event: 'read-compared', ...result });
      results.push(result);
      if (
        response.headers.get('x-ratelimit-remaining') === '0' &&
        attemptedReads < maximumReads
      )
        fail('READBACK_RATE_LIMIT_EXHAUSTED');
    }
    const result = {
      state: carry
        ? 'five_read_continuation_completed_diagnostic_only'
        : 'six_reads_completed_diagnostic_only',
      attemptedReads,
      erpWrites: 0,
      results,
      f1GatePassed: false,
      ...(carry ?? {}),
    };
    await record({ event: 'finished', attemptedReads, f1GatePassed: false });
    return result;
  } catch (e) {
    const result = {
      state: 'readback_stopped',
      code: e instanceof ProbeError ? e.message : 'READBACK_LOCAL_FAILURE',
      attemptedReads,
      erpWrites: 0,
      results,
      f1GatePassed: false,
      ...(carry ?? {}),
    };
    await record({ event: 'stopped', code: result.code, attemptedReads }).catch(
      () => {},
    );
    return result;
  } finally {
    credentials = null;
    await journal.close();
  }
}
export async function preparePrivatePlan(root) {
  const json = async (file) =>
    JSON.parse(await readFile(join(root, file), 'utf8'));
  const events = async (file) =>
    (await readFile(join(root, 'controlled', file), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
  const input = await json('f1-next-cases-private.json'),
    ui = await json('c02-c04-ui-proof.json');
  const created = await events('CUSTOMER-CORRECTED01-FULL.jsonl');
  const orderEvents = [
    ...(await events('F1-ORDERS-20261104.jsonl')),
    ...(await events('F1-C04-20261104.jsonl')),
  ];
  const one = (a, predicate) => {
    const found = a.filter(predicate);
    if (found.length !== 1) fail('PRIVATE_BASELINE_AMBIGUOUS');
    return found[0];
  };
  const buyer = one(
    created,
    (e) => e.event === 'created' && e.resource === 'customer',
  );
  const children = one(created, (e) => e.event === 'children-reconciled').ids;
  if (ui.independentNativeUi !== true || ui.noOrderEdited !== true)
    fail('PRIVATE_UI_BASELINE_REQUIRED');
  const plan = {
    approval: READ_APPROVAL,
    maximumReads: 6,
    accountDocument: input.accountDocument,
    buyerDocument: input.customer.cpfCnpj,
    buyerId: String(buyer.id),
    originId: String(input.originIntegratorIdCandidate),
    products: [
      { resource: 'new-M', id: String(children.M), sku: 'CRM-F1-20261104-A-M' },
      { resource: 'new-G', id: String(children.G), sku: 'CRM-F1-20261104-A-G' },
      {
        resource: 'existing-M-from-C01',
        id: String(input.existingM.id),
        sku: input.existingM.sku,
      },
    ],
    orders: aliases.map((alias) => {
      const order = one(
        orderEvents,
        (e) => e.event === 'created' && e.resource === alias,
      );
      if (
        !orderEvents.some(
          (e) =>
            e.id === order.id &&
            e.resource === alias &&
            ['api-reconciled', 'api-reconciled-diagnostic'].includes(e.event),
        )
      )
        fail('PRIVATE_ORDER_NOT_RECONCILED');
      return {
        alias,
        id: String(order.id),
        reference: ui[alias].reference,
        date: input.date,
        expected: {
          alias,
          totalCents: ui[alias].totalCents,
          lines: ui[alias].lines.map((line) => ({
            resource:
              line.resource === 'existing-M'
                ? 'existing-M-from-C01'
                : line.resource,
            quantity: String(line.quantity),
            subtotalCents: line.subtotalCents,
          })),
        },
      };
    }),
  };
  validatePlan(plan);
  return { plan, approvedDigest: digest(plan) };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [mode, root] = process.argv.slice(2);
    if (
      !root ||
      process.argv.length !== 4 ||
      !['--prepare', '--live'].includes(mode)
    )
      fail('INVALID_PROBE_COMMAND');
    const target = join(resolve(root), 'monetary-readback');
    if (mode === '--prepare') {
      const prepared = await preparePrivatePlan(resolve(root));
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFile(
        join(target, 'private-plan.json'),
        JSON.stringify(prepared),
        { flag: 'wx', mode: 0o600 },
      );
      process.stdout.write(
        'PRIVATE_PLAN_PREPARED: C02,C03,C04; maximumReads=6; networkCalls=0\n',
      );
    } else {
      let raw = '';
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (raw.length > 40000) fail('PRIVATE_CREDENTIALS_REQUIRED');
      }
      const credentials = JSON.parse(raw);
      raw = '';
      const prepared = JSON.parse(
        await readFile(join(target, 'private-plan.json'), 'utf8'),
      );
      const result = await runReadbackProbe(prepared.plan, {
        credentials,
        approvedDigest: prepared.approvedDigest,
        journalPath: join(target, 'six-read-journal.jsonl'),
      });
      // The full diagnostic is private. Terminal output has no amounts or identities.
      process.stdout.write(
        JSON.stringify({
          state: result.state,
          code: result.code,
          attemptedReads: result.attemptedReads,
          erpWrites: 0,
          f1GatePassed: false,
        }) + '\n',
      );
      if (result.state === 'readback_stopped') process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write(
      (e instanceof ProbeError ? e.message : 'READBACK_COMMAND_FAILED') + '\n',
    );
    process.exitCode = 1;
  }
}
