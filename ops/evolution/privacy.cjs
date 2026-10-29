'use strict';

// EVOL-01 / ORC-08 / MSG-01..04. No credentials or message content in logs.
const Module = require('node:module');

const WEBHOOK_HEADER = 'X-Silmer-Evolution-Token';
const WEBHOOK_EVENTS = new Set([
  'messages.upsert',
  'messages.update',
  'connection.update',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateEnvironment(env) {
  for (const key of [
    'AUTHENTICATION_API_KEY',
    'SILMER_EVOLUTION_WEBHOOK_TOKEN',
  ]) {
    if (
      !env[key] ||
      env[key].length < 32 ||
      /CHANGE|REPLACE|EXAMPLE/i.test(env[key])
    ) {
      fail('EVOLUTION_SECRET_CONFIGURATION_INVALID');
    }
  }
  if (env.AUTHENTICATION_API_KEY === env.SILMER_EVOLUTION_WEBHOOK_TOKEN) {
    fail('EVOLUTION_SECRETS_MUST_DIFFER');
  }
  let database;
  let webhook;
  try {
    database = new URL(env.DATABASE_CONNECTION_URI);
    webhook = new URL(env.SILMER_EVOLUTION_WEBHOOK_URL);
  } catch {
    fail('EVOLUTION_URL_CONFIGURATION_INVALID');
  }
  if (
    database.protocol !== 'postgresql:' ||
    database.pathname !== '/silmer_evolution' ||
    decodeURIComponent(database.username) !== 'silmer_evolution' ||
    !database.password
  ) {
    fail('EVOLUTION_DATABASE_MUST_BE_ISOLATED');
  }
  if (
    webhook.protocol !== 'https:' ||
    webhook.username ||
    webhook.password ||
    webhook.search ||
    webhook.hash ||
    !webhook.pathname.startsWith('/webhook/')
  ) {
    fail('EVOLUTION_WEBHOOK_CONFIGURATION_INVALID');
  }
  const required = {
    DATABASE_PROVIDER: 'postgresql',
    CACHE_REDIS_ENABLED: 'false',
    CACHE_REDIS_SAVE_INSTANCES: 'false',
    CACHE_LOCAL_ENABLED: 'true',
    TELEMETRY_ENABLED: 'false',
    AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: 'false',
    WEBHOOK_GLOBAL_ENABLED: 'false',
    PROMETHEUS_METRICS: 'false',
    WEBSOCKET_ENABLED: 'false',
    LOG_LEVEL: 'ERROR',
    LOG_BAILEYS: 'fatal',
    DOCKER_ENV: 'true',
    TZ: 'UTC',
    DATABASE_SAVE_DATA_NEW_MESSAGE: 'true',
  };
  for (const [key, value] of Object.entries(required)) {
    if (env[key] !== value) fail('EVOLUTION_PROFILE_CONFIGURATION_INVALID');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.SILMER_EVOLUTION_INSTANCE || '')) {
    fail('EVOLUTION_INSTANCE_CONFIGURATION_INVALID');
  }
  return {
    webhookUrl: webhook.href,
    webhookToken: env.SILMER_EVOLUTION_WEBHOOK_TOKEN,
  };
}

function protectWebhookRequest(config, profile) {
  const data = config.data;
  // Evolution uses Axios for other integrations too. Only intercept event envelopes.
  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.event !== 'string' ||
    !data.instance
  ) {
    return config;
  }
  let destination;
  try {
    destination = new URL(config.url || '', config.baseURL).href;
  } catch {
    fail('EVOLUTION_WEBHOOK_DESTINATION_REJECTED');
  }
  if (destination !== profile.webhookUrl || !WEBHOOK_EVENTS.has(data.event)) {
    fail('EVOLUTION_WEBHOOK_DESTINATION_REJECTED');
  }
  // Upstream includes its instance API key in every webhook payload.
  const safeData = { ...data };
  delete safeData.apikey;
  delete safeData.api_key;
  config.data = safeData;
  config.maxRedirects = 0;
  config.headers = {
    ...config.headers,
    [WEBHOOK_HEADER]: profile.webhookToken,
  };
  return config;
}

function protectAxios(axios, profile) {
  if (
    !axios ||
    typeof axios.create !== 'function' ||
    axios.__silmerWebhookProtected
  )
    return axios;
  const create = axios.create.bind(axios);
  axios.create = (...args) => {
    const client = create(...args);
    client.interceptors.request.use((config) =>
      protectWebhookRequest(config, profile),
    );
    return client;
  };
  Object.defineProperty(axios, '__silmerWebhookProtected', { value: true });
  return axios;
}

function protectStream(stream, tag) {
  const write = stream.write.bind(stream);
  stream.write = (_chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    // Do not inspect or echo the original chunk: it can contain QR, token or PII.
    return write(`${tag}\n`, done);
  };
}

function installRuntimeProtection(env = process.env) {
  const profile = validateEnvironment(env);
  const safeOutput = process.stdout.write.bind(process.stdout);
  protectStream(process.stdout, 'EVOLUTION_RUNTIME_OUTPUT_REDACTED');
  protectStream(process.stderr, 'EVOLUTION_RUNTIME_ERROR_REDACTED');
  const load = Module._load;
  Module._load = function loadProtected(request, parent, isMain) {
    const result = load.call(this, request, parent, isMain);
    if (request === 'axios') protectAxios(result, profile);
    return result;
  };
  const { PrismaClient } = require('@prisma/client');
  const { scheduleRetention } = require('./silmer-retention.cjs');
  const prisma = new PrismaClient({ log: [] });
  scheduleRetention(prisma, {
    instance: env.SILMER_EVOLUTION_INSTANCE,
    report: (code) => safeOutput(`${code}\n`),
  });
}

module.exports = {
  validateEnvironment,
  protectWebhookRequest,
  protectAxios,
  protectStream,
  installRuntimeProtection,
};

if (require.main === module) {
  try {
    validateEnvironment(process.env);
    process.stdout.write('EVOLUTION_PROFILE_VALIDATED\n');
  } catch {
    process.stderr.write('EVOLUTION_PROFILE_INVALID\n');
    process.exitCode = 1;
  }
} else if (
  process.env.SILMER_EVOLUTION_RUNTIME === 'true' &&
  /(?:^|[\\/])dist[\\/]main(?:\.js)?$/.test(process.argv[1] || '')
) {
  installRuntimeProtection();
}
