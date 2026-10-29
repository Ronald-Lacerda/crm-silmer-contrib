import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  validateEnvironment,
  protectWebhookRequest,
  protectAxios,
  protectStream,
} = require('./privacy.cjs');
const {
  purgeExpiredMessages,
  scheduleRetention,
  RETENTION_SECONDS,
  RETENTION_INTERVAL_MS,
} = require('./retention.cjs');
const example = await readFile(
  new URL('environment.env.example', import.meta.url),
  'utf8',
);
const profileEnvironment = () => ({
  ...Object.fromEntries(
    example
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const equals = line.indexOf('=');
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  ),
  AUTHENTICATION_API_KEY: 'a'.repeat(48),
  SILMER_EVOLUTION_WEBHOOK_TOKEN: 'b'.repeat(48),
  DATABASE_CONNECTION_URI:
    'postgresql://silmer_evolution:synthetic@isolated:5432/silmer_evolution?schema=public',
});

test('private profile accepts isolated PostgreSQL and local cache without Redis', () => {
  const profile = validateEnvironment(profileEnvironment());
  assert.equal(
    profile.webhookUrl,
    'https://schedule-n8n.jicnzg.easypanel.host/webhook/silmer/evolution-events',
  );
});

test('profile fails closed on default/shared secrets, CRM database, telemetry or Redis', () => {
  for (const patch of [
    { AUTHENTICATION_API_KEY: 'short' },
    { SILMER_EVOLUTION_WEBHOOK_TOKEN: 'a'.repeat(48) },
    { DATABASE_CONNECTION_URI: 'postgresql://crm:synthetic@db:5432/crm' },
    { TELEMETRY_ENABLED: 'true' },
    { CACHE_REDIS_ENABLED: 'true' },
    { AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: 'true' },
    { WEBHOOK_GLOBAL_ENABLED: 'true' },
    { SILMER_EVOLUTION_WEBHOOK_URL: 'http://n8n/webhook/test' },
    { SILMER_EVOLUTION_WEBHOOK_URL: 'https://user:password@n8n/webhook/test' },
  ]) {
    assert.throws(
      () => validateEnvironment({ ...profileEnvironment(), ...patch }),
      /^Error: EVOLUTION_/,
    );
  }
});

test('webhook keeps delivery identity but strips the upstream instance credential and disallows redirects', () => {
  const profile = validateEnvironment(profileEnvironment());
  const input = {
    baseURL: profile.webhookUrl,
    url: '',
    headers: { 'Content-Type': 'application/json' },
    data: {
      event: 'messages.upsert',
      instance: 'synthetic-instance',
      sender: 'synthetic-sender',
      date_time: '2026-10-29T12:00:00.000Z',
      apikey: 'never-forward-this-instance-secret',
      data: { key: { id: 'synthetic-message' } },
    },
  };
  const output = protectWebhookRequest(input, profile);
  assert.equal(output.data.apikey, undefined);
  assert.equal(output.data.sender, 'synthetic-sender');
  assert.equal(output.data.date_time, '2026-10-29T12:00:00.000Z');
  assert.equal(output.maxRedirects, 0);
  assert.equal(output.headers['X-Silmer-Evolution-Token'], 'b'.repeat(48));
});

test('unexpected webhook destinations and QR/history events fail before network dispatch', () => {
  const profile = validateEnvironment(profileEnvironment());
  for (const patch of [
    { baseURL: 'https://other.invalid/webhook/test' },
    { url: 'https://other.invalid/webhook/test' },
    { data: { event: 'qrcode.updated', instance: 'synthetic' } },
    { data: { event: 'messages.set', instance: 'synthetic' } },
  ]) {
    assert.throws(
      () =>
        protectWebhookRequest(
          {
            baseURL: profile.webhookUrl,
            url: '',
            data: { event: 'messages.upsert', instance: 'synthetic' },
            ...patch,
          },
          profile,
        ),
      /EVOLUTION_WEBHOOK_DESTINATION_REJECTED/,
    );
  }
});

test('Axios protection is idempotent and leaves non-webhook requests unchanged', () => {
  let intercepted;
  const client = {
    interceptors: {
      request: {
        use(handler) {
          intercepted = handler;
        },
      },
    },
  };
  const axios = {
    create() {
      return client;
    },
  };
  const profile = validateEnvironment(profileEnvironment());
  protectAxios(axios, profile);
  const create = axios.create;
  protectAxios(axios, profile);
  assert.equal(axios.create, create);
  axios.create();
  const request = {
    data: { unrelated: true },
    baseURL: 'https://whatsapp.invalid',
  };
  assert.equal(intercepted(request), request);
});

test('raw log chunks never appear in output, while callbacks and backpressure are preserved', () => {
  const output = [];
  let callbackCalled = false;
  const stream = {
    write(chunk, callback) {
      output.push(chunk);
      callback?.();
      return false;
    },
  };
  protectStream(stream, 'SYNTHETIC_REDACTED');
  assert.equal(
    stream.write('synthetic private QR and token', 'utf8', () => {
      callbackCalled = true;
    }),
    false,
  );
  assert.deepEqual(output, ['SYNTHETIC_REDACTED\n']);
  assert.equal(callbackCalled, true);
});

test('inline image pins upstream and suppresses migration output before starting the API preload', async () => {
  const dockerfile = await readFile(
    new URL('Dockerfile.inline', import.meta.url),
    'utf8',
  );
  assert.match(
    dockerfile,
    /FROM evoapicloud\/evolution-api:v2\.3\.7@sha256:[a-f0-9]{64}/,
  );
  assert.match(
    dockerfile,
    /FROM node:24\.22\.1-alpine3\.23@sha256:[a-f0-9]{64} AS node_runtime/,
  );
  assert.match(dockerfile, /COPY --from=node_runtime \/usr\/local\/bin\/node/);
  assert.match(
    dockerfile,
    /import\("baileys"\), import\("sharp"\), import\("@prisma\/client"\)/,
  );
  assert.match(dockerfile, /deploy_database\.sh >\/dev\/null 2>&1/);
  assert.match(
    dockerfile,
    /exec node --require \/evolution\/silmer-privacy\.cjs dist\/main/,
  );
  assert.match(dockerfile, /USER node/);
  assert.doesNotMatch(dockerfile, /NODE_OPTIONS|--no-sandbox/);
});

test('retention deletes only older transport messages for the selected instance and preserves recent/boundary/other rows', async () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const cutoff = Math.floor(now / 1000) - RETENTION_SECONDS;
  const rows = [
    { id: 'old-own', instance: 'silmer', timestamp: cutoff - 1 },
    { id: 'boundary-own', instance: 'silmer', timestamp: cutoff },
    { id: 'recent-own', instance: 'silmer', timestamp: cutoff + 1 },
    { id: 'old-other', instance: 'other', timestamp: cutoff - 1 },
  ];
  let filter;
  const prisma = {
    message: {
      async deleteMany({ where }) {
        filter = where;
        const eligible = rows.filter(
          (row) =>
            row.instance === where.Instance.is.name &&
            row.timestamp < where.messageTimestamp.lt,
        );
        return { count: eligible.length, ids: eligible.map((row) => row.id) };
      },
    },
    instance: {
      deleteMany() {
        assert.fail('Instance must never be deleted');
      },
    },
    session: {
      deleteMany() {
        assert.fail('Session must never be deleted');
      },
    },
  };
  assert.deepEqual(
    await purgeExpiredMessages(prisma, { instance: 'silmer', now }),
    { count: 1, ids: ['old-own'] },
  );
  assert.deepEqual(filter, {
    Instance: { is: { name: 'silmer' } },
    messageTimestamp: { lt: cutoff },
  });
  for (const args of [
    { instance: '' },
    { instance: 'bad/path' },
    { instance: 'silmer', now: Number.NaN },
  ]) {
    await assert.rejects(
      () => purgeExpiredMessages(prisma, args),
      /EVOLUTION_RETENTION_CONFIGURATION_INVALID/,
    );
  }
});

test('hourly retention suppresses overlapping work and reports fixed failure code without PII', async () => {
  let releases;
  let calls = 0;
  const reports = [];
  const prisma = {
    message: {
      async deleteMany() {
        calls++;
        if (calls === 1)
          await new Promise((resolve) => {
            releases = resolve;
          });
        if (calls === 2) throw new Error('synthetic sensitive database error');
        return { count: 0 };
      },
    },
  };
  const job = scheduleRetention(prisma, {
    instance: 'silmer',
    report: (code) => reports.push(code),
    schedule(_handler, milliseconds) {
      assert.equal(milliseconds, RETENTION_INTERVAL_MS);
      return { unref() {} };
    },
  });
  const first = job.tick();
  await job.tick();
  assert.equal(calls, 1);
  releases();
  await first;
  await job.tick();
  await job.tick();
  assert.deepEqual(reports, [
    'EVOLUTION_RETENTION_COMPLETED',
    'EVOLUTION_RETENTION_FAILED',
    'EVOLUTION_RETENTION_COMPLETED',
  ]);
});
