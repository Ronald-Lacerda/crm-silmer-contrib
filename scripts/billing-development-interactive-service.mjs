import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { Pool } from 'pg';
import Fastify from 'fastify';
import {
  createDatabase,
  loadMigrations,
  migrate,
} from '../modules/database/src/index.js';
import { createServerApi } from '../apps/api/src/server.js';
import { createIdentityApiRuntime } from '../apps/api/src/identity-runtime.js';
import {
  createBillingWorkerRuntime,
  createWorkerRuntime,
} from '../apps/worker/src/worker.js';
import { PostgresN8nCommandStore } from '../modules/n8n-integration/src/index.js';
import { encryptJson } from '../modules/n8n-integration/src/crypto.js';
import { seedDevelopmentUsers } from './seed-dev-users.mjs';
import {
  createBillingDevelopmentSimulator,
  DEVELOPMENT_CREDENTIALS,
} from './billing-development-service.mjs';
import {
  seed,
  KEY,
  SELLER,
} from '../test/support/order-billing-chat-fixture.js';

if (process.env.RUN_BILLING_INTERACTIVE !== 'synthetic-local-only')
  throw new Error('EXPLICIT_BILLING_INTERACTIVE_REQUIRED');
const connectionString =
  'postgresql://synthetic:synthetic-billing-local-only@billing-postgres:5432/crm_silmer_billing_dev';
const bootstrapPool = new Pool({ connectionString });
await migrate(bootstrapPool, { migrations: await loadMigrations() });
const database = createDatabase({ connectionString });
const key = KEY.toString('base64url');
const environment = {
  APP_ENV: 'development',
  APP_ORIGIN: 'http://127.0.0.1:4180',
  APP_BASE_URL: 'http://127.0.0.1:4180',
  FAB_CODE: '01',
  AUTH_THROTTLE_HMAC_KEY: key,
  IDEMPOTENCY_ENVELOPE_KEY: key,
  HANDOFF_ENVELOPE_KEY: key,
  OPERATION_CURSOR_HMAC_KEY: key,
  CONTACT_IDENTITY_ENVELOPE_KEY: key,
  CONTACT_IDENTITY_LOOKUP_KEY: key,
  INBOX_MESSAGE_ENVELOPE_KEY: key,
  N8N_INTEGRATION_ENVELOPE_KEY: key,
  IDENTITY_BOOTSTRAP_TOKEN: 'billing-interactive-synthetic-bootstrap-only',
  N8N_INTEGRATION_ENABLED: 'true',
  CRM_AUTOMATION_CLIENT_ID: DEVELOPMENT_CREDENTIALS.crmUser,
  CRM_AUTOMATION_CLIENT_SECRET: DEVELOPMENT_CREDENTIALS.crmPassword,
  N8N_COMMAND_CLIENT_ID: DEVELOPMENT_CREDENTIALS.workerUser,
  N8N_COMMAND_CLIENT_SECRET: DEVELOPMENT_CREDENTIALS.workerPassword,
  N8N_COMMAND_ALLOW_INSECURE_LOCAL: 'true',
  N8N_COMMAND_REPLAY_SAFE: 'false',
  N8N_COMMAND_TIMEOUT_MS: '30000',
  N8N_COMMAND_URL:
    'http://127.0.0.1:5678/webhook/silmer/order-billing-dev/send',
  ORDER_BILLING_N8N_URL:
    'http://127.0.0.1:5678/webhook/silmer/order-billing-dev/create',
  ORDER_BILLING_CHECK_N8N_URL:
    'http://127.0.0.1:5678/webhook/silmer/order-billing-dev/check',
  ORDER_BILLING_ENABLED: 'true',
  ORDER_BILLING_RECEIVE_ENABLED: 'true',
  ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
  PRIVATE_MEDIA_ROOT: '/tmp/billing-development-media',
  PRIVATE_MEDIA_MAX_BYTES: '67108864',
  PRIVATE_MEDIA_MAX_FILE_BYTES: '16777216',
};
const quiet = {
  debug() {
    return {};
  },
  info() {
    return {};
  },
  warn() {
    return {};
  },
  error() {
    return {};
  },
};
const api = createServerApi({
  database,
  identity: createIdentityApiRuntime(database, environment),
  environment,
  logger: quiet,
});
const simulator = createBillingDevelopmentSimulator();
const effects = new Map();
let ready = false;
const persisted = JSON.parse(
  await readFile('/development-state/simulator.json', 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return 'null';
    throw error;
  }),
);
if (persisted) {
  for (const [id, value] of persisted.charges) simulator.charges.set(id, value);
  Object.assign(simulator.counts, persisted.counts);
  for (const [id, count] of persisted.effects) effects.set(id, count);
}
let writes = Promise.resolve();
const saveSimulator = () =>
  (writes = writes.then(async () => {
    await writeFile(
      '/development-state/simulator.tmp',
      JSON.stringify({
        charges: [...simulator.charges],
        counts: simulator.counts,
        effects: [...effects],
      }),
    );
    await rename(
      '/development-state/simulator.tmp',
      '/development-state/simulator.json',
    );
  }));
const gateway = Fastify({ logger: false });
gateway.addHook('onRequest', async (request, reply) => {
  if (request.headers['x-api-key'] !== DEVELOPMENT_CREDENTIALS.gatewayKey)
    return reply.code(401).send({ code: 'SYNTHETIC_KEY_REQUIRED' });
});
gateway.post('/links', async (request) => {
  const result = simulator.create(request.body);
  await saveSimulator();
  return result;
});
gateway.post('/payment_check', async (request) =>
  simulator.check(request.body),
);
api.get('/__billing-development/health', async (_request, reply) =>
  reply
    .code(ready ? 200 : 503)
    .send({ synthetic: true, interactive: true, ready }),
);
api.post('/__billing-development/transport/send', async (request) => {
  const command = /** @type {any} */ (request.body);
  assert.equal(command.message?.type, 'text');
  const count = effects.get(command.command_id) ?? 0;
  assert.equal(count, 0, 'Duplicate simulated provider effect');
  effects.set(command.command_id, count + 1);
  await saveSimulator();
  return {
    id: `synthetic-message-${command.command_id}`,
    messages: [{ id: `synthetic-message-${command.command_id}` }],
    simulated: true,
  };
});
api.get('/__billing-development/state', async () => ({
  synthetic: true,
  orders: (
    await database.query(
      "SELECT id,number,conversation_id FROM crm.orders WHERE origin='atendimento' ORDER BY created_at DESC LIMIT 30",
    )
  ).rows,
  effects: Object.fromEntries(effects),
}));
api.post('/__billing-development/confirm', async (request) => {
  const {
    chargeId,
    notify = true,
    ...options
  } = /** @type {any} */ (request.body);
  const candidate = simulator.confirm(chargeId, options);
  await saveSimulator();
  if (!notify) return { candidate, notified: false };
  const response = await globalThis.fetch(
    'http://n8n:5678/webhook/silmer/order-billing-dev/paid',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(candidate),
      signal: AbortSignal.timeout(45000),
    },
  );
  return { candidate, notified: response.ok, status: response.status };
});
api.post('/__billing-development/seed', async () => {
  const owner = (
    await database.query(
      "SELECT id FROM crm.users WHERE email='vendedor@crm-silmer.local'",
    )
  ).rows[0]?.id;
  assert.ok(owner);
  await database.query(
    "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,'billing-fixture@example.test','$argon2id$synthetic','Registro sintético') ON CONFLICT(id) DO NOTHING",
    [SELLER.id],
  );
  const orderId = await seed(bootstrapPool, {
    conversation: true,
    amount: 10000,
    owner,
  });
  const row = (
    await database.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [
      orderId,
    ])
  ).rows[0];
  await database.query(
    "UPDATE crm.conversations SET automation_state='human',state='em_atendimento',inbound_revision=1 WHERE id=$1",
    [row.conversation_id],
  );
  const identity = (
    await database.query(
      'SELECT i.id,i.external_identity_lookup_hash FROM crm.contact_identities i JOIN crm.conversations c ON c.contact_identity_id=i.id WHERE c.id=$1',
      [row.conversation_id],
    )
  ).rows[0];
  await database.query(
    'UPDATE crm.contact_identities SET identity_envelope=$2::jsonb WHERE id=$1',
    [
      identity.id,
      JSON.stringify(
        encryptJson(
          {
            externalIdentityId: '5511999999999',
            displayName: 'Cliente de desenvolvimento',
          },
          JSON.stringify([
            'crm.contact_identities',
            1,
            identity.external_identity_lookup_hash,
          ]),
          KEY,
        ),
      ),
    ],
  );
  return { orderId, conversationId: row.conversation_id };
});
api.get('/__billing-development', async (_request, reply) =>
  reply
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Cobranças DEV</title><body><main><h1>Cobranças DEV</h1><p>Dados fictícios. InfinitePay e WhatsApp simulados. Este painel não pertence à interface de produção.</p><p><a href="/">Abrir CRM</a> · <a href="http://127.0.0.1:5685">Abrir n8n DEV</a></p><p>Login vendedor@crm-silmer.local ou admin@crm-silmer.local. Senha Desenvolvimento!2026.</p><button id="seed">Criar pedido e conversa de R$ 100</button><p><label>Cobrança ID <input id="charge"></label> <button id="pay">Confirmar Pix fictício</button> <button id="missed">Pagar sem webhook</button></p><pre id="result" role="status"></pre><script>const out=document.querySelector('#result'); async function post(path,body){const r=await fetch('/__billing-development/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});out.textContent=JSON.stringify(await r.json(),null,2)}document.querySelector('#seed').onclick=()=>post('seed',{});document.querySelector('#pay').onclick=()=>post('confirm',{chargeId:document.querySelector('#charge').value});document.querySelector('#missed').onclick=()=>post('confirm',{chargeId:document.querySelector('#charge').value,notify:false});fetch('/__billing-development/state').then(r=>r.json()).then(x=>out.textContent=JSON.stringify(x,null,2));</script></main></body></html>`,
    ),
);
await gateway.listen({ host: '0.0.0.0', port: 8080 });
await api.listen({ host: '0.0.0.0', port: 3000 });
await seedDevelopmentUsers({
  apiOrigin: 'http://127.0.0.1:3000',
  bootstrapToken: environment.IDENTITY_BOOTSTRAP_TOKEN,
  origin: environment.APP_ORIGIN,
});
const fetchInternal = (
  /** @type {URL} */ url,
  /** @type {RequestInit} */ options,
) => {
  assert.ok(
    [
      '/webhook/silmer/order-billing-dev/send',
      '/webhook/silmer/order-billing-dev/create',
      '/webhook/silmer/order-billing-dev/check',
    ].includes(url.pathname),
  );
  return globalThis.fetch('http://n8n:5678' + url.pathname, options);
};
const worker = createBillingWorkerRuntime({
  database,
  environment,
  logger: quiet,
  fetchImpl: fetchInternal,
});
const commandWorker = createWorkerRuntime({
  database,
  environment,
  logger: quiet,
  fetchImpl: fetchInternal,
  commandStore: new PostgresN8nCommandStore({
    database,
    envelopeKey: KEY,
    billingSendEnabled: true,
  }),
});
await worker.start();
await commandWorker.start();
const edge = spawn(process.execPath, ['scripts/serve-dev.mjs'], {
  cwd: '/workspace',
  env: {
    ...process.env,
    HOST: '0.0.0.0',
    PORT: '4173',
    API_ORIGIN: 'http://127.0.0.1:3000',
  },
  stdio: 'inherit',
});
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await globalThis.fetch('http://127.0.0.1:4173/')).ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((done) => setTimeout(done, 100));
}
if (!ready) throw new Error('BILLING_DEVELOPMENT_EDGE_NOT_READY');
process.stdout.write('BILLING_INTERACTIVE_READY\n');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, async () => {
    edge.kill('SIGTERM');
    await commandWorker.stop();
    await worker.stop();
    await gateway.close();
    await api.close();
    await bootstrapPool.end();
  });
