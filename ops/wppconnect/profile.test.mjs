import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildConfig, createGuard, guardBody } = require('./runtime.cjs');
const { deliverWebhook } = require('./webhook.cjs');
const pair = {
  WPP_SESSION: 'silmer-pilot',
  WPP_PHASE: 'pair',
  SECRET_KEY: 'synthetic-master-secret-32-characters',
};
const env = {
  ...pair,
  WPP_PHASE: 'integrated',
  WPP_WEBHOOK_URL: 'https://n8n.example.test/webhook/silmer/wpp-events',
  WPP_WEBHOOK_TOKEN: 'synthetic-header-secret-32-characters',
  WPP_EXPECTED_OWN_JID: '5511999990000@c.us',
};
const client = {
  session: pair.WPP_SESSION,
  config: {},
  isConnected: async () => true,
  getWid: async () => env.WPP_EXPECTED_OWN_JID,
};
const req = { serverOptions: { webhook: { url: env.WPP_WEBHOOK_URL } } };
const message = {
  id: 'synthetic-message-1',
  from: '5511888880000@c.us',
  fromMe: false,
  body: 'Synthetic test',
};

function response() {
  return {
    code: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.code = n;
      return this;
    },
    json(v) {
      this.body = v;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('pair-only profile has no webhook, autoplay, unsafe browser flags or raw logs', () => {
  const c = buildConfig(pair);
  assert.equal(c.webhook.url, null);
  assert.equal(c.startAllSession, false);
  assert.equal(c.createOptions.logQR, false);
  assert.equal(c.createOptions.useInsecureChromiumArgs, false);
  assert.equal(c.webhook.readMessage, false);
  assert.equal(c.webhook.listenAcks, false);
  assert.deepEqual(c.log.logger, []);
  assert.equal(
    c.createOptions.browserArgs.some((x) =>
      /sandbox|web-security|certificate|ssl/.test(x),
    ),
    false,
  );
});

test('no fallback secrets or implicit integrated mode; insecure URLs and missing own identity rejected', () => {
  assert.throws(() => buildConfig({}), /WPP_CONFIGURATION_REQUIRED/);
  assert.throws(
    () => buildConfig({ ...pair, SECRET_KEY: '' }),
    /WPP_CONFIGURATION_REQUIRED/,
  );
  assert.throws(
    () => buildConfig({ ...env, WPP_EXPECTED_OWN_JID: '' }),
    /WPP_EXPECTED_OWN_JID_REQUIRED/,
  );
  for (const url of [
    'http://n8n.example.test/x',
    'https://user:secret@n8n.example.test/x',
    'https://n8n.example.test/x?key=secret',
    'https://n8n.example.test/x#secret',
  ])
    assert.throws(
      () => buildConfig({ ...env, WPP_WEBHOOK_URL: url }),
      /WPP_WEBHOOK_URL_INVALID/,
    );
});

test('pairing route guard rejects public surfaces, URL tokens, other sessions and all sends', () => {
  const guard = createGuard(pair, 'synthetic-bearer');
  for (const path of [
    '/api-docs',
    '/manager',
    '/api/manager',
    '/files/a',
    '/socket.io',
    '/unhealthy',
    '/metrics',
    '/api/other/qrcode-session',
    '/api/silmer-pilot:token/qrcode-session',
    '/api/silmer-pilot/secret/generate-token',
    '/api/silmer-pilot/send-message',
  ]) {
    const res = response();
    let next = false;
    guard(
      {
        method: path.endsWith('send-message') ? 'POST' : 'GET',
        path,
        headers: { authorization: 'Bearer synthetic-bearer' },
      },
      res,
      () => {
        next = true;
      },
    );
    assert.equal(next, false, path);
    assert.equal(res.code, 404, path);
  }
  const denied = response();
  guard(
    { method: 'GET', path: '/api/silmer-pilot/qrcode-session', headers: {} },
    denied,
    () => assert.fail(),
  );
  assert.equal(denied.code, 401);
  const allowed = response();
  let ran = false;
  guard(
    {
      method: 'GET',
      path: '/api/silmer-pilot/qrcode-session',
      headers: { authorization: 'Bearer synthetic-bearer' },
    },
    allowed,
    () => {
      ran = true;
    },
  );
  assert.equal(ran, true);
  assert.equal(allowed.headers['Cache-Control'], 'no-store');
});

test('start-session cannot inject phone, proxy, other webhook or wait indefinitely', () => {
  const r = {
    path: '/api/silmer-pilot/start-session',
    body: {
      phone: 'synthetic',
      proxy: { url: 'http://attacker.test' },
      webhook: 'https://attacker.test',
      waitQrCode: true,
    },
  };
  guardBody(r, {}, () => {});
  assert.deepEqual(r.body, { waitQrCode: false });
});

test('PN/LID identity lookup is authenticated, exact and integrated only', () => {
  for (const phase of ['pair', 'integrated']) {
    const guard = createGuard({ ...env, WPP_PHASE: phase }, 'synthetic-bearer');
    for (const suffix of [
      '123456789012345%40lid',
      '5511999990000%40c.us',
      '5511999990000@s.whatsapp.net',
    ]) {
      let ran = false;
      const res = response();
      guard(
        {
          method: 'GET',
          path: '/api/silmer-pilot/contact/pn-lid/' + suffix,
          headers: { authorization: 'Bearer synthetic-bearer' },
        },
        res,
        () => {
          ran = true;
        },
      );
      assert.equal(ran, phase === 'integrated');
    }
  }
  const guard = createGuard(env, 'synthetic-bearer');
  for (const suffix of [
    '..%2Fsecret',
    '123%2540lid',
    '12345%40lid/extra',
    'bad%40lid',
  ]) {
    const res = response();
    guard(
      {
        method: 'GET',
        path: '/api/silmer-pilot/contact/pn-lid/' + suffix,
        headers: { authorization: 'Bearer synthetic-bearer' },
      },
      res,
      () => assert.fail(),
    );
    assert.equal(res.code, 404);
  }
});

test('safe identity endpoint uses real getWid without returning host tokens', async () => {
  const guard = createGuard(pair, 'synthetic-bearer', () => ({
    [pair.WPP_SESSION]: client,
  }));
  const res = response();
  await guard(
    {
      method: 'GET',
      path: '/api/silmer-pilot/silmer-identity',
      headers: { authorization: 'Bearer synthetic-bearer' },
    },
    res,
    () => assert.fail(),
  );
  assert.deepEqual(res.body, {
    connected: true,
    own_jid: env.WPP_EXPECTED_OWN_JID,
  });
  const disconnected = createGuard(pair, 'synthetic-bearer', () => ({
    [pair.WPP_SESSION]: { ...client, isConnected: async () => false },
  }));
  const closed = response();
  await disconnected(
    {
      method: 'GET',
      path: '/api/silmer-pilot/silmer-identity',
      headers: { authorization: 'Bearer synthetic-bearer' },
    },
    closed,
    () => assert.fail(),
  );
  assert.equal(closed.code, 409);
  assert.deepEqual(closed.body, { connected: false });
});

test('paired transport stamps authenticated metadata once, overriding spoofed payload', async () => {
  const calls = [];
  const now = new Date('2026-10-28T12:00:00.000Z');
  let clock = 0;
  const ok = await deliverWebhook(
    client,
    req,
    'onmessage',
    {
      ...message,
      __wpp_own_jid: 'spoofed',
      __wpp_received_at: 'spoofed',
      event: 'spoofed',
      session: 'spoofed',
    },
    {
      post: async (...args) => {
        calls.push(args);
        return { status: 202 };
      },
    },
    {
      env,
      now: () => {
        clock++;
        return now;
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(clock, 1);
  assert.equal(calls[0][1].__wpp_own_jid, env.WPP_EXPECTED_OWN_JID);
  assert.equal(calls[0][1].__wpp_received_at, now.toISOString());
  assert.equal(calls[0][1].session, pair.WPP_SESSION);
  assert.equal(calls[0][1].event, 'onmessage');
  assert.equal(
    calls[0][2].headers['X-Silmer-WPP-Token'],
    env.WPP_WEBHOOK_TOKEN,
  );
  assert.equal(calls[0][2].maxRedirects, 0);
});

test('HTTP5xx and network errors retry same event; HTTP4xx do not retry', async () => {
  const calls = [];
  const sleeps = [];
  const ok = await deliverWebhook(
    client,
    req,
    'onack',
    { id: 'synthetic-id', ack: 2 },
    {
      post: async (...args) => {
        calls.push(args);
        if (calls.length < 3) {
          const e = new Error('sensitive-must-not-log');
          if (calls.length === 1) e.response = { status: 503 };
          else e.code = 'ECONNRESET';
          throw e;
        }
        return { status: 202 };
      },
    },
    { env, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(ok, true);
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.strictEqual(calls[0][1], calls[2][1]);
  let attempts = 0;
  const previous = process.stderr.write;
  let output = '';
  process.stderr.write = (text) => {
    output += text;
    return true;
  };
  try {
    assert.equal(
      await deliverWebhook(
        client,
        req,
        'onmessage',
        message,
        {
          post: async () => {
            attempts++;
            throw {
              response: { status: 403 },
              config: { headers: { secret: 'NEVER_LOG' } },
            };
          },
        },
        { env, sleep: async () => assert.fail() },
      ),
      false,
    );
  } finally {
    process.stderr.write = previous;
  }
  assert.equal(attempts, 1);
  assert.equal(output, 'WPP_WEBHOOK_DELIVERY_FAILED\n');
});

test('pair phase, QR, messages from self/groups and mismatched identity cannot reach webhook', async () => {
  const transport = { post: async () => assert.fail() };
  assert.equal(
    await deliverWebhook(client, req, 'onmessage', message, transport, {
      env: pair,
    }),
    false,
  );
  assert.equal(
    await deliverWebhook(
      client,
      req,
      'qrcode',
      { qrcode: 'NEVER_TRANSMIT' },
      transport,
      { env },
    ),
    false,
  );
  for (const payload of [
    { ...message, fromMe: true },
    { ...message, isGroupMsg: true },
    { ...message, from: 'status@broadcast' },
  ])
    assert.equal(
      await deliverWebhook(client, req, 'onmessage', payload, transport, {
        env,
      }),
      false,
    );
  const previous = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(
      await deliverWebhook(
        { ...client, getWid: async () => '5511777770000@c.us' },
        req,
        'onmessage',
        message,
        transport,
        { env },
      ),
      false,
    );
  } finally {
    process.stderr.write = previous;
  }
});
