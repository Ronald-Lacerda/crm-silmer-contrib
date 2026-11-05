/** OLIST-T02 approved batch transport. Ephemeral OAuth, no token persistence. */
import { createServer } from 'node:http';
import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  constants,
} from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALLBACK,
  authorizationUrl,
  consumeCallback,
  boundedJson,
  normalizeDocument,
} from './read-only-probe.mjs';
import {
  loadBatchPlan,
  bindBatch,
  executeBatch,
  reconcileRejectedCustomer,
  diagnoseCustomerOnce,
} from './controlled-batch.mjs';
const ROOT = resolve('C:/Users/sutil/dev/Pessoal/crm-silmer/var/olist-phase1');
const LOCAL = 'http://127.0.0.1:8765';
const TOKEN =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
const esc = (x) =>
  String(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export async function startBatchSession(
  root = ROOT,
  { approvedDigest, fetcher = fetch, pause, mode = 'execute' } = {},
) {
  if (!['execute', 'reconcile', 'diagnostic'].includes(mode))
    throw new Error('INVALID_MODE');
  const input = JSON.parse(
    await readFile(join(root, 'f1-next-cases-private.json'), 'utf8'),
  );
  let bound = bindBatch(await loadBatchPlan(), input);
  if (approvedDigest !== bound.digest)
    throw new Error('EXPLICIT_APPROVAL_REQUIRED');
  const directory = join(
    root,
    'batch-session-' + randomBytes(12).toString('hex'),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
  });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(join(directory, 'public-key.pem'), pem, {
    flag: 'wx',
    mode: 0o600,
  });
  const envelope = join(directory, 'credentials.enc');
  const state = randomBytes(32).toString('hex'),
    latch = { used: false },
    controller = new AbortController();
  let credentials = null,
    result = null,
    busy = false,
    importing = false,
    imported = false,
    closing = false;
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Prova Olist F1</title><main><h1>Lote aprovado da Fase 1</h1>' +
          body +
          '</main>',
      );
    };
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:8765')
      return send(403, 'Solicitacao recusada.');
    const path = new URL(req.url, LOCAL).pathname;
    if (path === '/') {
      if (result)
        return send(
          200,
          '<p>Tokens descartados. Nenhuma repeticao automatica.</p><pre>' +
            esc(JSON.stringify(result, null, 2)) +
            '</pre>',
        );
      if (busy)
        return send(
          200,
          '<p>Provas em andamento, dentro dos limites aprovados. Recarregue para consultar o resultado.</p>',
        );
      if (!credentials)
        return send(
          200,
          '<p>Aguardando credenciais cifradas. Nenhuma operacao iniciada.</p>',
        );
      return send(
        200,
        (mode === 'reconcile'
          ? '<p>Somente treze GETs de reconciliacao, zero POST ERP. A reserva anterior permanece.</p><a href="'
          : mode === 'diagnostic'
            ? '<p>Uma tentativa adicional identica do cliente aprovada pelo PO, ate dezessete GETs. Sem produtos ou pedidos neste modo.</p><a href="'
            : '<p>Ate seis POSTs, oitenta GETs autenticados e um GET sem autenticacao. Lote aprovado pelo PO; os registros permanecerao no ERP.</p><a href="') +
          esc(authorizationUrl(credentials.clientId, state)) +
          '">Conectar Olist para lote F1</a>',
      );
    }
    if (path !== '/olist/callback' || !credentials || busy)
      return send(409, 'Fluxo indisponivel.');
    try {
      const code = consumeCallback(req.url, req.headers.host, state, latch);
      busy = true;
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
        signal: controller.signal,
        fetcher,
      });
      if (
        typeof response.body?.access_token !== 'string' ||
        !response.body.access_token
      )
        throw new Error('TOKEN_MISSING');
      result = await (
        mode === 'reconcile'
          ? reconcileRejectedCustomer
          : mode === 'diagnostic'
            ? diagnoseCustomerOnce
            : executeBatch
      )(bound, {
        token: response.body.access_token,
        approvedDigest,
        journalDirectory: join(root, 'controlled'),
        fetcher,
        signal: controller.signal,
        ...(pause ? { pause } : {}),
        onProgress: (x) => process.stdout.write(JSON.stringify(x) + '\n'),
      });
      response.body = null;
      await writeFile(
        join(directory, 'result.json'),
        JSON.stringify(result, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    } catch (e) {
      result = {
        state: 'batch_stopped_consult_durable_journal',
        code: /^[A-Z][A-Z_0-9]+$/.test(e.message)
          ? e.message
          : 'SESSION_STOPPED',
        automaticRetry: false,
        f1GatePassed: false,
      };
      if (!res.headersSent) {
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
        res.end();
      }
      await writeFile(
        join(directory, 'session-stop.json'),
        JSON.stringify(result, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      ).catch(() => {});
    } finally {
      credentials = null;
      bound = null;
      busy = false;
    }
  });
  const interval = setInterval(async () => {
    if (importing || imported || closing) return;
    importing = true;
    try {
      const s = await stat(envelope);
      if (s.size !== 384) throw new Error('INVALID_ENVELOPE');
      const clear = privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        await readFile(envelope),
      );
      try {
        const p = JSON.parse(clear.toString('utf8'));
        if (
          Object.keys(p).sort().join() !==
            'clientId,clientSecret,expectedDocument' ||
          normalizeDocument(p.expectedDocument) !==
            normalizeDocument(input.accountDocument) ||
          typeof p.clientSecret !== 'string' ||
          !p.clientSecret ||
          p.clientSecret.length > 150
        )
          throw new Error('INVALID_ENVELOPE');
        authorizationUrl(p.clientId, state);
        credentials = p;
        imported = true;
      } finally {
        clear.fill(0);
      }
      await unlink(envelope);
      process.stdout.write(
        'Credenciais importadas em memoria; autorize pela pagina local.\n',
      );
    } catch (e) {
      if (e.code !== 'ENOENT') {
        imported = true;
        credentials = null;
        result = { code: 'CREDENTIAL_IMPORT_FAILED', erpWrites: 0 };
        process.stdout.write('Importacao recusada, sem gravar credenciais.\n');
      }
    } finally {
      importing = false;
    }
  }, 1000);
  let expiry;
  const close = () => {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    clearTimeout(expiry);
    controller.abort();
    credentials = null;
    bound = null;
    server.close();
    server.closeAllConnections();
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  };
  expiry = setTimeout(close, 30 * 60 * 1000);
  try {
    await new Promise((ok, no) => {
      server.once('error', no);
      server.listen(8765, '127.0.0.1', ok);
    });
  } catch {
    close();
    throw new Error('LOOPBACK_PORT_UNAVAILABLE');
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdout.write(
    JSON.stringify({
      localUrl: LOCAL,
      publicKeyFile: join(directory, 'public-key.pem'),
      encryptedEnvelopeFile: envelope,
      publicKeySha256: createHash('sha256').update(pem).digest('hex'),
      mode,
      maximumPosts: mode === 'reconcile' ? 0 : mode === 'diagnostic' ? 1 : 6,
      maximumAuthenticatedGets:
        mode === 'reconcile' ? 13 : mode === 'diagnostic' ? 17 : 80,
      maximumUnauthenticatedGets: mode === 'execute' ? 1 : 0,
      lifetimeMinutes: 30,
    }) + '\n',
  );
  return { close, directory };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const a = process.argv.slice(2);
  if (
    a.length !== 2 ||
    !['--approved', '--reconcile', '--diagnostic'].includes(a[0]) ||
    !/^[a-f0-9]{64}$/.test(a[1])
  ) {
    process.stderr.write(
      'Informe somente --approved e o hash privado do plano aprovado.\n',
    );
    process.exitCode = 1;
  } else
    startBatchSession(undefined, {
      approvedDigest: a[1],
      mode:
        a[0] === '--reconcile'
          ? 'reconcile'
          : a[0] === '--diagnostic'
            ? 'diagnostic'
            : 'execute',
    }).catch((e) => {
      process.stderr.write(
        /^[A-Z][A-Z_0-9]+$/.test(e.message)
          ? e.message + '\n'
          : 'SESSION_START_FAILED\n',
      );
      process.exitCode = 1;
    });
}
