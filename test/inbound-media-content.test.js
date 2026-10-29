import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { createInboundMediaRuntime } from '../apps/api/src/inbound-media-runtime.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const id = 'media-20000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-28T18:00:00Z');
const bytes = Buffer.from('synthetic-inbound-image');

/** @param {any} t @param {any} [options] */
async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crm-inbound-media-'));
  const path = join(directory, 'opaque-file');
  await writeFile(path, options.bytes ?? bytes);
  let reads = 0;
  const row = {
    id,
    media_type: 'image',
    availability_status: 'available',
    validation_status: 'clean',
    expires_at: '2026-10-29T18:00:00Z',
    terminal_at: null,
    size_bytes: bytes.length,
    content_sha256: createHash('sha256').update(bytes).digest('hex'),
    detected_mime_type: 'image/png',
    storage_key: '20000000-0000-4000-8000-000000000002',
    ...options.row,
  };
  const runtime = createInboundMediaRuntime({
    clock: () => NOW,
    access: {
      async authorizeRead(/** @type {any} */ input) {
        assert.equal(input.action, 'conversation.read');
        if (options.forbidden)
          throw Object.assign(new Error('private-details'), {
            statusCode: 403,
          });
        return { actor: { id: 'seller-synthetic' } };
      },
    },
    database: {
      async query(/** @type {string} */ sql, /** @type {any[]} */ values) {
        assert.match(sql, /message\.conversation_id=\$2/u);
        assert.match(sql, /message\.direction='inbound'/u);
        assert.match(sql, /media\.media_type=message\.message_type/u);
        return { rows: values[1] === 'conversation-synthetic' ? [row] : [] };
      },
    },
    mediaVolume: {
      async resolvePath(/** @type {any} */ input) {
        reads++;
        assert.deepEqual(input, { mediaId: id, storageKey: row.storage_key });
        if (options.missingAfterResolve) {
          if (reads > 1) return null;
          await rm(path);
        }
        return options.lost ? null : path;
      },
    },
    retained: options.retained,
  });
  const api = createApi(
    {},
    {
      inboundMedia: runtime,
      logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
    },
  );
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    row,
    reads: () => reads,
    get: (
      headers = {},
      conversation = 'conversation-synthetic',
      mediaId = id,
    ) =>
      api.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversation}/media/${mediaId}/content`,
        headers: { cookie: 'crm_session=synthetic', ...headers },
      }),
  };
}

test('MSG-02/INBOX-2: received image returns original bytes through private route', async (t) => {
  const response = await (await harness(t)).get();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, bytes);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(Number(response.headers['content-length']), bytes.length);
});

for (const type of ['image', 'document']) {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    test(`IMG-01/EVOL-02: ${mime} received as ${type} serves only validated original bytes`, async (t) => {
      const response = await (
        await harness(t, {
          row: { media_type: type, detected_mime_type: mime },
        })
      ).get();
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, bytes);
      assert.equal(response.headers['content-type'], mime);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    });
  }
}

for (const [
  name,
  options,
  headers,
  conversation,
  status,
] of /** @type {Array<[string, any, any, string|undefined, number]>} */ ([
  ['missing session', {}, { cookie: '' }, undefined, 401],
  [
    'Basic credential is not a human session',
    {},
    { authorization: 'Basic synthetic' },
    undefined,
    403,
  ],
  ['actor lacks conversation read', { forbidden: true }, {}, undefined, 403],
  [
    'attachment belongs to another conversation',
    {},
    {},
    'other-conversation',
    404,
  ],
  [
    'deadline reached',
    { row: { expires_at: NOW.toISOString() } },
    {},
    undefined,
    410,
  ],
  [
    'conversation ended',
    { row: { terminal_at: NOW.toISOString() } },
    {},
    undefined,
    410,
  ],
  [
    'deleted attachment',
    { row: { availability_status: 'deleted' } },
    {},
    undefined,
    410,
  ],
  [
    'lost attachment',
    { row: { availability_status: 'lost' } },
    {},
    undefined,
    410,
  ],
  [
    'quarantined attachment',
    { row: { availability_status: 'quarantined' } },
    {},
    undefined,
    503,
  ],
  [
    'unscanned attachment',
    { row: { validation_status: 'pending' } },
    {},
    undefined,
    503,
  ],
  [
    'invalid MIME',
    { row: { detected_mime_type: 'text/html' } },
    {},
    undefined,
    503,
  ],
  [
    'MIME belongs to another media kind',
    { row: { detected_mime_type: 'audio/ogg' } },
    {},
    undefined,
    503,
  ],
  [
    'PDF document cannot be served as an image',
    { row: { media_type: 'document', detected_mime_type: 'application/pdf' } },
    {},
    undefined,
    503,
  ],
  [
    'SVG document cannot be served inline',
    { row: { media_type: 'document', detected_mime_type: 'image/svg+xml' } },
    {},
    undefined,
    503,
  ],
  [
    'image document exceeds five MB',
    { row: { media_type: 'document', size_bytes: 5 * 1024 * 1024 + 1 } },
    {},
    undefined,
    503,
  ],
  [
    'image document is unscanned',
    { row: { media_type: 'document', validation_status: 'pending' } },
    {},
    undefined,
    503,
  ],
  [
    'GIF document has expired',
    {
      row: {
        media_type: 'document',
        detected_mime_type: 'image/gif',
        expires_at: NOW.toISOString(),
      },
    },
    {},
    undefined,
    410,
  ],
  [
    'image exceeds five MB',
    { row: { size_bytes: 5 * 1024 * 1024 + 1 } },
    {},
    undefined,
    503,
  ],
])) {
  test(`MSG-02/PRV-03: ${name} returns no file bytes`, async (t) => {
    const fixture = await harness(t, options);
    const response = await fixture.get(headers, conversation);
    assert.equal(response.statusCode, status);
    assert.equal(fixture.reads(), 0);
    assert.equal(
      response.headers['content-type'],
      'application/problem+json; charset=utf-8',
    );
    assert.doesNotMatch(
      response.body,
      /synthetic-inbound-image|private-details|opaque-file/u,
    );
  });
}

test('MSG-02: file lost between path resolution and open is marked lost', async (t) => {
  const fixture = await harness(t, { missingAfterResolve: true });
  const response = await fixture.get();
  assert.equal(response.statusCode, 410);
  assert.equal(response.json().error.code, 'MEDIA_LOST');
  assert.equal(fixture.reads(), 2);
});

test('MSG-02: missing file is explicitly lost', async (t) => {
  const response = await (await harness(t, { lost: true })).get();
  assert.equal(response.statusCode, 410);
  assert.equal(response.json().error.code, 'MEDIA_LOST');
});

for (const override of [
  { bytes: Buffer.from('different-inbound-data') },
  { row: { size_bytes: bytes.length + 1 } },
])
  test('MSG-02: divergent hash or length never publishes corrupted bytes', async (t) => {
    const response = await (await harness(t, override)).get();
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(
      response.body,
      /different-inbound-data|synthetic-inbound-image/u,
    );
  });

test('INBOX-2: received media supports exact partial playback', async (t) => {
  const response = await (await harness(t)).get({ range: 'bytes=2-5' });
  assert.equal(response.statusCode, 206);
  assert.deepEqual(response.rawPayload, bytes.subarray(2, 6));
  assert.equal(response.headers['content-range'], `bytes 2-5/${bytes.length}`);
});

test('IMG-02: one changed byte at the same file size fails the content digest', async (t) => {
  const corrupted = Buffer.from(bytes);
  corrupted[0] ^= 1;
  assert.equal(corrupted.length, bytes.length);
  const response = await (await harness(t, { bytes: corrupted })).get();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
  assert.notDeepEqual(response.rawPayload, corrupted);
  assert.doesNotMatch(response.body, /synthetic-inbound-image/u);
});

test('INBOX-2: invalid Range is rejected without bytes', async (t) => {
  const response = await (await harness(t)).get({ range: 'bytes=5-2' });
  assert.equal(response.statusCode, 416);
  assert.equal(response.headers['content-range'], `bytes */${bytes.length}`);
});

test('INBOX-2: retained seller UUIDs keep using their original runtime', async (t) => {
  const fixture = await harness(t, {
    retained: {
      async content(/** @type {any} */ input) {
        assert.equal(input.mediaId, id.slice(6));
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/plain' },
          stream: 'retained-synthetic',
        };
      },
    },
  });
  const response = await fixture.get({}, undefined, id.slice(6));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'retained-synthetic');
  assert.equal(fixture.reads(), 0);
});
