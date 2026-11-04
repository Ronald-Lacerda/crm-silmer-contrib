/** OLIST-T02: temporary loopback OAuth proof; no ERP write operation exists here. */
import { createServer } from 'node:http';
import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
  constants,
} from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CALLBACK = 'http://127.0.0.1:8765/olist/callback';
const ORIGIN = 'http://127.0.0.1:8765';
const AUTH =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
const TOKEN =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
const API = 'https://api.tiny.com.br/public-api/v3';
export const QUERIES = Object.freeze([
  '/info',
  '/contatos?nome=teste&limit=10&offset=0',
  '/produtos?nome=teste&limit=10&offset=0',
  '/pedidos?numeroPedidoEcommerce=CRM-F1-20261104-C01&limit=10&offset=0',
  '/vendedores?limit=10&offset=0',
  '/depositos',
  '/formas-pagamento?limit=10&offset=0',
  '/formas-recebimento?limit=10&offset=0',
]);

function fail(code) {
  throw new Error(code);
}
export function normalizeDocument(value) {
  if (typeof value !== 'string') fail('EXPECTED_ACCOUNT_REQUIRED');
  const document = value.replace(/[.\-/\s]/gu, '').toUpperCase();
  if (!/^(?:[0-9]{11}|[A-Z0-9]{12}[0-9]{2})$/u.test(document))
    fail('EXPECTED_ACCOUNT_REQUIRED');
  return document;
}
export function authorizationUrl(clientId, state) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(clientId)) fail('INVALID_CLIENT_ID');
  if (!/^[a-f0-9]{64}$/u.test(state)) fail('INVALID_STATE');
  const url = new URL(AUTH);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: 'openid',
    response_type: 'code',
    state,
  }))
    url.searchParams.set(key, value);
  return url.href;
}
export function consumeCallback(requestUrl, host, expectedState, latch) {
  if (host !== '127.0.0.1:8765') fail('INVALID_CALLBACK_HOST');
  if (typeof requestUrl !== 'string' || requestUrl.length > 16384)
    fail('INVALID_CALLBACK');
  const url = new URL(requestUrl, ORIGIN);
  if (
    url.origin !== ORIGIN ||
    url.pathname !== '/olist/callback' ||
    url.searchParams.has('error')
  )
    fail('INVALID_CALLBACK');
  const values = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  if (
    values.length !== 1 ||
    codes.length !== 1 ||
    !codes[0] ||
    codes[0].length > 4096
  )
    fail('INVALID_CALLBACK');
  const actual = Buffer.from(values[0]);
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail('INVALID_CALLBACK_STATE');
  if (latch.used) fail('CALLBACK_ALREADY_USED');
  latch.used = true;
  return codes[0];
}
export function assertRequest(url, method) {
  if (url === TOKEN && method === 'POST') return;
  if (method === 'GET' && QUERIES.some((path) => API + path === url)) return;
  fail('REQUEST_NOT_ALLOWED');
}
export function safeSummary(path, status, body, headers) {
  // Never include IDs, buyer data, account document, payloads or provider messages.
  const items = Array.isArray(body?.itens)
    ? body.itens
    : Array.isArray(body)
      ? body
      : null;
  const integerHeader = (name) => {
    const value = headers.get(name);
    return value !== null && /^\d{1,8}$/u.test(value) ? Number(value) : null;
  };
  return {
    path: path.split('?')[0],
    status,
    count: items ? items.length : null,
    rateLimit: integerHeader('x-ratelimit-limit'),
    remaining: integerHeader('x-ratelimit-remaining'),
    resetSeconds: integerHeader('x-ratelimit-reset'),
  };
}
export async function boundedJson(
  url,
  method,
  { body, token, fetcher = fetch, signal } = {},
) {
  assertRequest(url, method);
  const headers =
    method === 'POST'
      ? { 'Content-Type': 'application/x-www-form-urlencoded' }
      : { Accept: 'application/json', Authorization: `Bearer ${token}` };
  let response;
  try {
    response = await fetcher(url, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
  } catch {
    fail('HTTP_OUTCOME_UNKNOWN');
  }
  if (response.status < 200 || response.status >= 300)
    fail(`HTTP_${response.status}`);
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  )
    fail('INVALID_CONTENT_TYPE');
  const limit = method === 'POST' ? 16384 : 131072;
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        await response.body.cancel().catch(() => {});
        fail('BODY_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    return {
      status: response.status,
      headers: response.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
  } catch (error) {
    if (error?.message === 'BODY_TOO_LARGE') throw error;
    fail('INVALID_RESPONSE');
  }
}
export async function queryAccount(
  accessToken,
  expectedDocument,
  fetcher = fetch,
  signal,
) {
  const expected = normalizeDocument(expectedDocument);
  const summaries = [];
  for (const path of QUERIES) {
    if (signal?.aborted) fail('PROBE_STOPPED');
    const result = await boundedJson(API + path, 'GET', {
      token: accessToken,
      fetcher,
      signal,
    });
    if (
      path === '/info' &&
      normalizeDocument(result.body?.cpfCnpj) !== expected
    )
      fail('ACCOUNT_MISMATCH');
    summaries.push(
      safeSummary(path, result.status, result.body, result.headers),
    );
    // Do not automatically retry or exhaust the shared account quota.
    const remaining = result.headers.get('x-ratelimit-remaining');
    if (remaining !== null && /^\d+$/u.test(remaining) && Number(remaining) < 2)
      fail('QUOTA_LOW');
  }
  return { accountMatched: true, queries: summaries, erpWrites: 0 };
}
function htmlEscape(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

export async function startProbe(
  privateRoot = resolve('var/olist-phase1'),
  { fetcher = fetch } = {},
) {
  const directory = join(
    privateRoot,
    `session-${randomBytes(12).toString('hex')}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
  });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicPath = join(directory, 'public-key.pem');
  const envelopePath = join(directory, 'credentials.enc');
  await writeFile(publicPath, pem, { mode: 0o600, flag: 'wx' });
  const state = randomBytes(32).toString('hex');
  const latch = { used: false };
  const lifecycle = new AbortController();
  let credentials = null;
  let result = null;
  let busy = false;
  let imported = false;
  let importPending = false;
  let closePending = false;
  const server = createServer(async (req, res) => {
    const send = (status, text) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Prova Olist F1</title><main><h1>Prova Olist F1 — consultas</h1>${text}</main>`,
      );
    };
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:8765')
      return send(403, 'Solicitação recusada.');
    const path = new URL(req.url, ORIGIN).pathname;
    if (path === '/') {
      if (result)
        return send(
          200,
          `<p>Consulta encerrada. Tokens e credenciais foram descartados.</p><pre>${htmlEscape(JSON.stringify(result, null, 2))}</pre>`,
        );
      if (busy)
        return send(
          200,
          '<p>Consultas em andamento. Recarregue esta página para ver o resumo.</p>',
        );
      if (!credentials)
        return send(
          200,
          '<p>Aguardando credenciais cifradas e documento esperado da conta. Nenhuma consulta iniciada.</p>',
        );
      return send(
        200,
        `<p>Até oito GET, sem criação ERP. Faça a autorização no Olist.</p><a href="${htmlEscape(authorizationUrl(credentials.clientId, state))}">Conectar Olist para consultas</a>`,
      );
    }
    if (path !== '/olist/callback' || !credentials || busy)
      return send(409, 'Fluxo indisponível.');
    try {
      const code = consumeCallback(req.url, req.headers.host, state, latch);
      busy = true;
      // Remove authorization code/state from the browser URL before any remote I/O.
      res.writeHead(303, {
        Location: '/',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      const response = await boundedJson(TOKEN, 'POST', {
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          redirect_uri: CALLBACK,
          code,
        }).toString(),
        signal: lifecycle.signal,
        fetcher,
      });
      if (
        typeof response.body?.access_token !== 'string' ||
        !response.body.access_token
      )
        fail('TOKEN_MISSING');
      // No refresh is issued or persisted. All private response data stays in memory.
      result = await queryAccount(
        response.body.access_token,
        credentials.expectedDocument,
        fetcher,
        lifecycle.signal,
      );
      response.body = null;
      credentials = null;
      // The local result page exposes only the sanitized summary.
    } catch (error) {
      const code =
        /^(?:HTTP_\d{3}|HTTP_OUTCOME_UNKNOWN|INVALID_[A-Z_]+|CALLBACK_ALREADY_USED|ACCOUNT_MISMATCH|QUOTA_LOW|BODY_TOO_LARGE|TOKEN_MISSING|EXPECTED_ACCOUNT_REQUIRED)$/u.test(
          error?.message ?? '',
        )
          ? error.message
          : 'PROBE_STOPPED';
      result = { code, erpWrites: 0, automaticRetry: false };
      credentials = null;
      if (!res.headersSent) {
        res.writeHead(303, {
          Location: '/',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end();
      }
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  const interval = setInterval(async () => {
    if (imported || importPending || closePending) return;
    importPending = true;
    try {
      const info = await stat(envelopePath);
      if (info.size < 1 || info.size > 1024) fail('INVALID_ENVELOPE');
      const box = await readFile(envelopePath);
      if (box.length < 1 || box.length > 1024) fail('INVALID_ENVELOPE');
      const clear = privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        box,
      );
      try {
        const parsed = JSON.parse(clear.toString('utf8'));
        if (
          typeof parsed.clientSecret !== 'string' ||
          parsed.clientSecret.length < 1 ||
          parsed.clientSecret.length > 150
        )
          fail('INVALID_ENVELOPE');
        normalizeDocument(parsed.expectedDocument);
        authorizationUrl(parsed.clientId, state);
        credentials = {
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret,
          expectedDocument: parsed.expectedDocument,
        };
        imported = true;
      } finally {
        clear.fill(0);
      }
      await unlink(envelopePath);
      process.stdout.write(
        'Credenciais importadas em memória; abra a página local para autorizar.\n',
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        imported = true;
        credentials = null;
        result = { code: 'CREDENTIAL_IMPORT_FAILED', erpWrites: 0 };
        process.stdout.write(
          'Importação recusada; nenhuma credencial ou resposta foi registrada.\n',
        );
      }
    } finally {
      importPending = false;
    }
  }, 1000);
  const close = () => {
    if (closePending) return;
    closePending = true;
    clearInterval(interval);
    clearTimeout(expiry);
    credentials = null;
    lifecycle.abort();
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
    server.close();
    server.closeAllConnections();
  };
  const expiry = setTimeout(close, 30 * 60 * 1000);
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(8765, '127.0.0.1', accept);
    });
  } catch {
    close();
    fail('LOOPBACK_PORT_UNAVAILABLE');
  }
  process.stdout.write(
    JSON.stringify({
      localUrl: ORIGIN,
      callback: CALLBACK,
      publicKeyFile: publicPath,
      encryptedEnvelopeFile: envelopePath,
      publicKeySha256: createHash('sha256').update(pem).digest('hex'),
      lifetimeMinutes: 30,
      maximumApiGet: QUERIES.length,
    }) + '\n',
  );
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return { close, directory };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) {
    process.stderr.write(
      'Este coletor não aceita URLs, tokens ou payloads na linha de comando.\n',
    );
    process.exitCode = 1;
  } else {
    startProbe().catch(() => {
      process.stderr.write('Não foi possível iniciar a prova local.\n');
      process.exitCode = 1;
    });
  }
}
