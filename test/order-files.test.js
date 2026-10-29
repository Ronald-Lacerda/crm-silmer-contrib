import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import {
  InMemoryObjectStorage,
  InMemoryOrderFileRepository,
} from '../modules/orders/src/adapters/in-memory-order-files.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import {
  S3ObjectStorage,
  objectStorageFromEnvironment,
} from '../modules/orders/src/adapters/s3-object-storage.js';
import {
  describeOrderFile,
  sanitizeOrderFileName,
} from '../modules/orders/src/domain/order-files.js';
import { syntheticItems } from './fixtures/order-items.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';
import { SYNTHETIC_GIF } from './fixtures/inbound-raster.js';

// ADR 023: art files of an order — five references plus one final art,
// 10 MB each, content checked against the extension.

const SELLER = Object.freeze({
  capabilities: [],
  functionName: 'Vendedor',
  id: 'seller-1',
  kind: 'human',
});
const OTHER = Object.freeze({ ...SELLER, id: 'seller-2' });

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(64, 1),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(32, 2),
]);
const CDR_RIFF = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('CDRv'),
  Buffer.alloc(32, 3),
]);
const ZIP = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.7\n%synthetic\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

const readHeaders = Object.freeze({
  cookie: 'crm_session=session-synthetic',
  origin: 'https://crm.example.test',
});

let keySequence = 0;
function writeHeaders(key = `file-key-${(keySequence += 1)}`) {
  return {
    ...readHeaders,
    'idempotency-key': key,
    'x-csrf-token': 'csrf-synthetic',
  };
}

/**
 * @param {Array<{name: string, filename?: string, content?: Buffer, value?: string}>} parts
 */
function multipart(parts) {
  const boundary = '----crm-silmer-synthetic';
  /** @type {Buffer[]} */
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          'utf8',
        ),
        /** @type {Buffer} */ (part.content),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`,
        ),
      );
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat(chunks),
  };
}

/** @param {{writeActor?: any, files?: boolean, storage?: any}} [options] */
function harness(options = {}) {
  /** @type {Record<string, string|null>} */
  const assignments = { 'conversation-1': 'seller-1' };
  let clock = Date.parse('2026-10-05T12:00:00.000Z');
  let sequence = 0;
  /** @type {any[]} */
  const audits = [];
  const repository = new InMemoryOrderRepository();
  const storage = options.storage ?? new InMemoryObjectStorage();
  const files = new InMemoryOrderFileRepository(repository);
  const runtime = createOrderRuntime({
    access: {
      authorizeRead: async () => ({ actor: OTHER }),
      authorizeWrite: async () => ({ actor: options.writeActor ?? SELLER }),
    },
    auditTrail: {
      append: async (/** @type {any} */ event) => {
        audits.push(event);
      },
    },
    clock: () => {
      clock += 60_000;
      return new Date(clock);
    },
    conversations: {
      readAssignment: async (/** @type {string} */ id) =>
        id in assignments
          ? { assignedUserId: assignments[id], version: 4 }
          : null,
      readAssignments: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, assignments[id] ?? null])),
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: orderContextsFrom(() => ({
        briefing: { order_name: 'Equipe Sintetica' },
        customerName: 'Cliente Sintetico',
        openedAt: '2026-09-01T13:05:00.000Z',
      })),
      readUserNames: async (/** @type {string[]} */ ids) =>
        new Map(
          ids.map((id) => [id, id === 'seller-1' ? 'Vendedora Um' : null]),
        ),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    files: options.files === false ? undefined : { repository: files, storage },
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    idFactory: () => `order-${(sequence += 1)}`,
    repository,
  });
  const api = createApi({}, { orders: runtime });
  return { api, assignments, audits, runtime, storage };
}

let seedSequence = 0;
/** @param {Record<string, unknown>} input */
function seed(input) {
  return {
    actor: SELLER,
    correlationId: 'correlation-seed',
    idempotencyKey: `seed-${(seedSequence += 1)}`,
    ...input,
  };
}

/** @param {any} runtime */
async function createPending(runtime) {
  const { order } = await runtime.createManual(
    seed({ conversationId: 'conversation-1', expectedVersion: 4 }),
  );
  return order;
}

/** @param {any} runtime @param {any} order */
async function confirm(runtime, order) {
  let current = order;
  for (const [section, value] of /** @type {const} */ ([
    [
      'summary',
      {
        aplicacao: null,
        data_entrega_confirmada: '2026-10-24',
        nome: 'Equipe Sintetica',
      },
    ],
    ['items', syntheticItems()],
    ['artwork', { feito_pela_silmer: false, feito_pelo_cliente: true }],
  ])) {
    current = await runtime.patchSection(
      seed({
        expectedVersion: current.version,
        orderId: current.id,
        section,
        value,
      }),
    );
  }
  return runtime.confirm(
    seed({
      amountText: '4.820,00',
      expectedVersion: current.version,
      orderId: current.id,
      paymentCondition: 'pix',
    }),
  );
}

/**
 * @param {any} api @param {string} orderId
 * @param {{slot?: string, filename?: string, content?: Buffer, thumbnail?: Buffer, headers?: Record<string, string>}} [input]
 */
function upload(api, orderId, input = {}) {
  /** @type {Array<{name: string, filename?: string, content?: Buffer, value?: string}>} */
  const parts = [{ name: 'slot', value: input.slot ?? 'reference' }];
  parts.push({
    content: input.content ?? PNG,
    filename: input.filename ?? 'logo.png',
    name: 'file',
  });
  if (input.thumbnail) {
    parts.push({
      content: input.thumbnail,
      filename: 'thumbnail.webp',
      name: 'thumbnail',
    });
  }
  const body = multipart(parts);
  return api.inject({
    headers: {
      ...(input.headers ?? writeHeaders()),
      'content-type': body.contentType,
    },
    method: 'POST',
    payload: body.payload,
    url: `/api/v1/orders/${orderId}/files`,
  });
}

test('the domain accepts listed formats by content and refuses the rest', () => {
  assert.equal(
    describeOrderFile({ content: PNG, name: 'logo.PNG' }).contentType,
    'image/png',
  );
  assert.equal(
    describeOrderFile({ content: CDR_RIFF, name: 'brasao.cdr' }).extension,
    'cdr',
  );
  // CDR X4+ is a ZIP container.
  assert.equal(
    describeOrderFile({ content: ZIP, name: 'brasao.cdr' }).extension,
    'cdr',
  );
  assert.equal(
    describeOrderFile({ content: PDF, name: 'arte.ai' }).extension,
    'ai',
  );
  assert.throws(() => describeOrderFile({ content: EXE, name: 'logo.png' }), {
    code: 'FILE_CONTENT_MISMATCH',
    statusCode: 422,
  });
  assert.throws(() => describeOrderFile({ content: EXE, name: 'setup.exe' }), {
    code: 'FILE_TYPE_NOT_ALLOWED',
    statusCode: 422,
  });
  assert.throws(
    () =>
      describeOrderFile({
        content: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]),
        name: 'grande.png',
      }),
    { code: 'FILE_TOO_LARGE', statusCode: 413 },
  );
  assert.throws(
    () =>
      describeOrderFile({ content: CDR_RIFF, name: 'a.cdr', thumbnail: WEBP }),
    { code: 'INVALID_THUMBNAIL' },
  );
  assert.throws(
    () => describeOrderFile({ content: PNG, name: 'a.png', thumbnail: PNG }),
    { code: 'INVALID_THUMBNAIL' },
  );
  assert.throws(
    () => describeOrderFile({ content: Buffer.alloc(0), name: 'a.png' }),
    {
      code: 'EMPTY_FILE',
    },
  );
});

test('EVOL-02 GIF reference checks content and preserves original bytes and idempotency', async () => {
  assert.equal(
    describeOrderFile({ content: SYNTHETIC_GIF, name: 'synthetic.gif' })
      .contentType,
    'image/gif',
  );
  const gif87 = Buffer.from(
    'R0lGODdhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    'base64',
  );
  assert.equal(
    describeOrderFile({ content: gif87, name: 'legacy.gif' }).extension,
    'gif',
  );
  for (const content of [
    PNG,
    EXE,
    Buffer.from('GIF89a'),
    SYNTHETIC_GIF.subarray(0, -1),
  ])
    assert.throws(() => describeOrderFile({ content, name: 'invalid.gif' }), {
      code: 'FILE_CONTENT_MISMATCH',
    });
  const { api, runtime } = harness();
  const order = await createPending(runtime);
  const headers = writeHeaders('synthetic-gif-replay');
  const input = {
    content: SYNTHETIC_GIF,
    filename: 'synthetic.gif',
    thumbnail: WEBP,
    headers,
  };
  const sent = await upload(api, order.id, input);
  assert.equal(sent.statusCode, 201);
  assert.deepEqual((await upload(api, order.id, input)).json(), sent.json());
  assert.equal(sent.json().references.length, 1);
  const file = sent.json().references[0];
  assert.equal(file.contentType, 'image/gif');
  assert.equal(file.thumbnail, true);
  const downloaded = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${order.id}/files/${file.id}/content`,
  });
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.rawPayload, SYNTHETIC_GIF);
  assert.equal(downloaded.headers['content-type'], 'image/gif');
});

test('file names lose paths and control characters but keep accents', () => {
  assert.deepEqual(sanitizeOrderFileName('..\\..\\pasta/Logo Ação\u0007.PNG'), {
    extension: 'png',
    name: 'Logo Ação.png',
  });
  assert.equal(
    sanitizeOrderFileName(`${'a'.repeat(300)}.pdf`).name.length,
    120,
  );
  assert.throws(() => sanitizeOrderFileName('semextensao'), {
    code: 'INVALID_FILE_NAME',
  });
  assert.throws(() => sanitizeOrderFileName('.png'), {
    code: 'INVALID_FILE_NAME',
  });
});

test('a seller uploads, lists, previews and downloads an art file', async () => {
  const { api, audits, runtime, storage } = harness();
  const order = await createPending(runtime);

  const sent = await upload(api, order.id, {
    filename: 'Logo Ação.png',
    thumbnail: WEBP,
  });
  assert.equal(sent.statusCode, 201);
  const body = sent.json();
  assert.equal(body.final, null);
  assert.deepEqual(body.limits, {
    maxBytes: 10 * 1024 * 1024,
    maxReferences: 5,
  });
  assert.equal(body.references.length, 1);
  const [file] = body.references;
  assert.deepEqual(Object.keys(file).sort(), [
    'contentType',
    'extension',
    'id',
    'name',
    'sizeBytes',
    'slot',
    'thumbnail',
    'uploadedAt',
    'uploadedBy',
  ]);
  assert.equal(file.name, 'Logo Ação.png');
  assert.equal(file.thumbnail, true);
  assert.deepEqual(file.uploadedBy, { id: 'seller-1', name: 'Vendedora Um' });
  assert.equal(storage.objects.size, 2);
  assert.ok(
    [...storage.objects.keys()].every((key) =>
      key.startsWith(`orders/${order.id}/`),
    ),
    'object keys are opaque and never carry the file name',
  );
  assert.equal(
    [...storage.objects.keys()].some((key) => key.includes('Logo')),
    false,
  );

  const listed = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${order.id}/files`,
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), body);

  const content = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${order.id}/files/${file.id}/content`,
  });
  assert.equal(content.statusCode, 200);
  assert.deepEqual(content.rawPayload, PNG);
  assert.equal(content.headers['content-type'], 'image/png');
  assert.equal(
    content.headers['content-disposition'],
    'attachment; filename="Logo Acao.png"; filename*=UTF-8\'\'Logo%20A%C3%A7%C3%A3o.png',
  );
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  assert.match(String(content.headers['content-security-policy']), /sandbox/u);
  assert.equal(
    audits.filter((event) => event.action === 'order.file.download').length,
    1,
  );

  const thumbnail = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${order.id}/files/${file.id}/thumbnail`,
  });
  assert.equal(thumbnail.statusCode, 200);
  assert.equal(thumbnail.headers['content-type'], 'image/webp');
  assert.deepEqual(thumbnail.rawPayload, WEBP);
  assert.ok(audits.some((event) => event.action === 'order.file.upload'));
});

test('five references fill the slots; the final art is a sixth and replaces itself', async () => {
  const { api, runtime, storage } = harness();
  const order = await createPending(runtime);
  for (let index = 1; index <= 5; index += 1) {
    const sent = await upload(api, order.id, {
      filename: `ref-${index}.pdf`,
      content: PDF,
    });
    assert.equal(sent.statusCode, 201);
  }
  const sixth = await upload(api, order.id, {
    filename: 'ref-6.pdf',
    content: PDF,
  });
  assert.equal(sixth.statusCode, 409);
  assert.deepEqual(sixth.json(), { error: { code: 'FILE_LIMIT_REACHED' } });
  assert.equal(storage.objects.size, 5, 'a refused upload stores nothing');

  const first = await upload(api, order.id, {
    content: CDR_RIFF,
    filename: 'arte-final.cdr',
    slot: 'final',
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().final.name, 'arte-final.cdr');
  assert.equal(first.json().references.length, 5);

  const second = await upload(api, order.id, {
    filename: 'arte-final-v2.png',
    slot: 'final',
    thumbnail: WEBP,
  });
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().final.name, 'arte-final-v2.png');
  assert.equal(storage.objects.size, 7, 'the replaced final art is deleted');
});

test('only the owner of a pending order changes its files; anyone may download', async () => {
  const other = harness({ writeActor: OTHER });
  const order = await createPending(other.runtime);
  const refused = await upload(other.api, order.id);
  assert.equal(refused.statusCode, 403);
  assert.equal(other.storage.objects.size, 0);

  const { api, runtime } = harness();
  const pending = await createPending(runtime);
  const sent = (await upload(api, pending.id)).json();
  await confirm(runtime, pending);

  const late = await upload(api, pending.id);
  assert.equal(late.statusCode, 409);
  assert.deepEqual(late.json(), { error: { code: 'ORDER_STATUS_CONFLICT' } });
  const removal = await api.inject({
    headers: writeHeaders(),
    method: 'DELETE',
    url: `/api/v1/orders/${pending.id}/files/${sent.references[0].id}`,
  });
  assert.equal(removal.statusCode, 409);

  const download = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${pending.id}/files/${sent.references[0].id}/content`,
  });
  assert.equal(
    download.statusCode,
    200,
    'production downloads a confirmed order',
  );
});

test('uploads are refused by content, size, thumbnail, slot and missing key', async () => {
  const { api, runtime, storage } = harness();
  const order = await createPending(runtime);

  const renamed = await upload(api, order.id, {
    content: EXE,
    filename: 'logo.png',
  });
  assert.equal(renamed.statusCode, 422);
  assert.equal(renamed.json().error.code, 'FILE_CONTENT_MISMATCH');

  const executable = await upload(api, order.id, {
    content: EXE,
    filename: 'a.exe',
  });
  assert.equal(executable.json().error.code, 'FILE_TYPE_NOT_ALLOWED');

  const large = await upload(api, order.id, {
    content: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]),
  });
  assert.equal(large.statusCode, 413);
  assert.deepEqual(large.json(), { error: { code: 'FILE_TOO_LARGE' } });

  const thumbnail = await upload(api, order.id, {
    content: CDR_RIFF,
    filename: 'a.cdr',
    thumbnail: WEBP,
  });
  assert.equal(thumbnail.json().error.code, 'INVALID_THUMBNAIL');

  const slot = await upload(api, order.id, { slot: 'extra' });
  assert.equal(slot.json().error.code, 'INVALID_FILE_SLOT');

  /** @type {Record<string, string>} */
  const withoutKey = writeHeaders();
  delete withoutKey['idempotency-key'];
  const unkeyed = await upload(api, order.id, { headers: withoutKey });
  assert.equal(unkeyed.statusCode, 400);
  assert.equal(unkeyed.json().error.code, 'INVALID_IDEMPOTENCY_KEY');

  const json = await api.inject({
    headers: { ...writeHeaders(), 'content-type': 'application/json' },
    method: 'POST',
    payload: { slot: 'reference' },
    url: `/api/v1/orders/${order.id}/files`,
  });
  assert.equal(json.statusCode, 400);
  assert.equal(storage.objects.size, 0);
});

test('a retried upload replays its answer; the same key with other bytes is refused', async () => {
  const { api, runtime, storage } = harness();
  const order = await createPending(runtime);
  const headers = writeHeaders('upload-retry');
  const first = await upload(api, order.id, { headers });
  const retry = await upload(api, order.id, { headers });
  assert.equal(retry.statusCode, first.statusCode);
  assert.deepEqual(retry.json(), first.json());
  assert.equal(first.json().references.length, 1);
  assert.equal(storage.objects.size, 1);

  const other = await upload(api, order.id, {
    content: PDF,
    filename: 'b.pdf',
    headers,
  });
  assert.equal(other.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('removing a file deletes it and its thumbnail', async () => {
  const { api, runtime, storage } = harness();
  const order = await createPending(runtime);
  const sent = (await upload(api, order.id, { thumbnail: WEBP })).json();
  const removed = await api.inject({
    headers: writeHeaders(),
    method: 'DELETE',
    url: `/api/v1/orders/${order.id}/files/${sent.references[0].id}`,
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json().references, []);
  assert.equal(storage.objects.size, 0);

  const missing = await api.inject({
    headers: writeHeaders(),
    method: 'DELETE',
    url: `/api/v1/orders/${order.id}/files/${sent.references[0].id}`,
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: { code: 'FILE_NOT_FOUND' } });
});

test('files answer 503 without storage, and a storage failure leaves no row', async () => {
  const off = harness({ files: false });
  const pending = await createPending(off.runtime);
  const listed = await off.api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${pending.id}/files`,
  });
  assert.equal(listed.statusCode, 503);
  assert.deepEqual(listed.json(), { error: { code: 'SERVICE_UNAVAILABLE' } });

  const failing = new InMemoryObjectStorage();
  failing.putObject = async () => {
    throw Object.assign(new Error('down'), { statusCode: 503 });
  };
  const broken = harness({ storage: failing });
  const order = await createPending(broken.runtime);
  const sent = await upload(broken.api, order.id);
  assert.equal(sent.statusCode, 503);
  const after = await broken.api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${order.id}/files`,
  });
  assert.deepEqual(after.json().references, []);
});

test('the RustFS adapter signs path-style S3 calls and creates the bucket once', async () => {
  /** @type {Array<{url: string, method: string, headers: Record<string, string>, body?: any}>} */
  const calls = [];
  const statuses = [404, 200, 200, 200, 200];
  const storage = new S3ObjectStorage({
    accessKeyId: 'local-access',
    bucket: 'crm-silmer-arquivos',
    clock: () => new Date('2026-10-05T12:00:00.000Z'),
    endpoint: 'http://rustfs:9000',
    fetch: /** @type {any} */ (
      async (/** @type {URL} */ url, /** @type {any} */ init) => {
        calls.push({
          body: init.body,
          headers: init.headers,
          method: init.method,
          url: String(url),
        });
        return new globalThis.Response(null, {
          status: statuses.shift() ?? 200,
        });
      }
    ),
    region: 'us-east-1',
    secretAccessKey: 'local-secret',
  });
  await storage.putObject('orders/order-1/file-1', PNG, 'image/png');
  await storage.putObject('orders/order-1/file-2', PNG, 'image/png');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      'HEAD http://rustfs:9000/crm-silmer-arquivos',
      'PUT http://rustfs:9000/crm-silmer-arquivos',
      'PUT http://rustfs:9000/crm-silmer-arquivos/orders/order-1/file-1',
      'PUT http://rustfs:9000/crm-silmer-arquivos/orders/order-1/file-2',
    ],
  );
  const put = calls[2];
  assert.equal(
    put.headers['x-amz-content-sha256'],
    createHash('sha256').update(PNG).digest('hex'),
  );
  assert.equal(put.headers['x-amz-date'], '20261005T120000Z');
  assert.match(
    put.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=local-access\/20261005\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
  );
  assert.equal(JSON.stringify(calls).includes('local-secret'), false);

  assert.equal(objectStorageFromEnvironment({}), undefined);
  assert.throws(
    () =>
      objectStorageFromEnvironment({
        OBJECT_STORAGE_ENDPOINT: 'http://rustfs:9000',
      }),
    /OBJECT_STORAGE_SECRET_ACCESS_KEY/u,
  );
});
