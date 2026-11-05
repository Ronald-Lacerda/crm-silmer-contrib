/**
 * OLIST-T02: temporary C01 OAuth transport. Default mode is read-only preflight.
 * --create requires explicit user permission expansion and approval of the exact case.
 * A digest guards input integrity; it does not establish human authorization.
 */
import { createServer } from 'node:http';
import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  constants,
} from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALLBACK,
  authorizationUrl,
  consumeCallback,
  boundedJson,
  normalizeDocument,
} from './read-only-probe.mjs';
import { buildC01, c01Digest, executeC01 } from './controlled-sale.mjs';
const ORIGIN = 'http://127.0.0.1:8765';
const TOKEN =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
function fail(code) {
  throw new Error(code);
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

export async function startC01Session(
  privateRoot = resolve('var/olist-phase1'),
  { fetcher = fetch, mode = 'prepare', approvedPlanDigest } = {},
) {
  if (
    !['prepare', 'create'].includes(mode) ||
    (mode === 'create' && !/^[a-f0-9]{64}$/u.test(approvedPlanDigest ?? ''))
  )
    fail('EXPLICIT_APPROVAL_REQUIRED');
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
  const casePath = join(directory, 'case.enc');
  await writeFile(publicPath, pem, { mode: 0o600, flag: 'wx' });
  const state = randomBytes(32).toString('hex');
  const latch = { used: false };
  const lifecycle = new AbortController();
  let credentials = null;
  let selection = null;
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
        `<!doctype html><meta charset="utf-8"><title>Prova Olist F1</title><main><h1>Prova Olist F1 — caso C01</h1>${text}</main>`,
      );
    };
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:8765')
      return send(403, 'Solicitação recusada.');
    const path = new URL(req.url, ORIGIN).pathname;
    if (path === '/') {
      if (result)
        return send(
          200,
          `<p>Sessão encerrada. Tokens e credenciais foram descartados.</p><pre>${htmlEscape(JSON.stringify(result, null, 2))}</pre>`,
        );
      if (busy)
        return send(
          200,
          '<p>Verificações em andamento. Recarregue esta página para ver o resumo.</p>',
        );
      if (!credentials)
        return send(
          200,
          '<p>Aguardando credenciais e caso cifrados. Nenhuma operação iniciada.</p>',
        );
      return send(
        200,
        `<p>${mode === 'prepare' ? 'Até dez GET de preparação, zero criação ERP.' : 'Caso C01 aprovado: até um POST e doze GET.'} Faça a autorização no Olist.</p><a href="${htmlEscape(authorizationUrl(credentials.clientId, state))}">Conectar Olist para C01</a>`,
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
      result = await executeC01(selection, {
        token: response.body.access_token,
        approvedPlanDigest,
        journalDirectory: join(privateRoot, 'controlled'),
        fetcher,
        signal: lifecycle.signal,
        prepareOnly: mode === 'prepare',
      });
      await writeFile(
        join(directory, 'result.json'),
        JSON.stringify(result, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      response.body = null;
      credentials = null;
      selection = null;
      // The local result page exposes only the sanitized summary.
    } catch (error) {
      const code =
        /^(?:HTTP_\d{3}|HTTP_OUTCOME_UNKNOWN|INVALID_[A-Z_]+|CALLBACK_ALREADY_USED|ACCOUNT_MISMATCH|QUOTA_LOW|BODY_TOO_LARGE|TOKEN_MISSING|EXPECTED_ACCOUNT_REQUIRED)$/u.test(
          error?.message ?? '',
        )
          ? error.message
          : 'PROBE_STOPPED';
      result = {
        code,
        erpPostAttempts: mode === 'prepare' ? 0 : null,
        state:
          mode === 'prepare'
            ? 'blocked_before_write'
            : 'outcome_not_established',
        automaticRetry: false,
        f1GatePassed: false,
      };
      credentials = null;
      selection = null;
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
      const caseInfo = await stat(casePath);
      if (caseInfo.size < 1 || caseInfo.size > 1024) fail('INVALID_ENVELOPE');
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
        const caseBox = await readFile(casePath);
        if (caseBox.length < 1 || caseBox.length > 1024)
          fail('INVALID_ENVELOPE');
        const caseClear = privateDecrypt(
          {
            key: privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
          },
          caseBox,
        );
        try {
          selection = JSON.parse(caseClear.toString('utf8'));
          buildC01(selection);
          if (
            normalizeDocument(selection.accountDocument) !==
            normalizeDocument(parsed.expectedDocument)
          )
            fail('INVALID_ENVELOPE');
          if (mode === 'create' && c01Digest(selection) !== approvedPlanDigest)
            fail('INVALID_ENVELOPE');
        } finally {
          caseClear.fill(0);
        }
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
      await unlink(casePath);
      process.stdout.write(
        'Credenciais importadas em memória; abra a página local para autorizar.\n',
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        imported = true;
        credentials = null;
        selection = null;
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
    selection = null;
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
      encryptedCaseFile: casePath,
      mode,
      publicKeySha256: createHash('sha256').update(pem).digest('hex'),
      lifetimeMinutes: 30,
      maximumApiGet: mode === 'prepare' ? 10 : 12,
      maximumApiPost: mode === 'prepare' ? 0 : 1,
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
  const args = process.argv.slice(2);
  const valid =
    args.length === 0 ||
    (args.length === 2 &&
      args[0] === '--create' &&
      /^[a-f0-9]{64}$/u.test(args[1]));
  if (!valid) {
    process.stderr.write(
      'Modo invalido; nao informe URL, token, documento ou payload na linha de comando.\n',
    );
    process.exitCode = 1;
  } else {
    startC01Session(undefined, {
      mode: args.length ? 'create' : 'prepare',
      approvedPlanDigest: args[1],
    }).catch(() => {
      process.stderr.write('Nao foi possivel iniciar a sessao C01.\n');
      process.exitCode = 1;
    });
  }
}
