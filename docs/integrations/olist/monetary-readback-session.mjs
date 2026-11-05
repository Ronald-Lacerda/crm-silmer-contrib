/** OLIST-T02: fresh OAuth in memory, then the approved initial or continuation schedule. */
import { createServer } from 'node:http';
import {
  generateKeyPairSync,
  privateDecrypt,
  constants,
  randomBytes,
} from 'node:crypto';
import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALLBACK,
  authorizationUrl,
  consumeCallback,
  boundedJson,
  normalizeDocument,
} from './read-only-probe.mjs';
import {
  runReadbackProbe,
  verifyFiveReadContinuation,
  FIVE_READ_APPROVAL,
} from './monetary-readback-probe.mjs';
import {
  EXACT_CENT_APPROVAL,
  validateExactCentPlan,
  executeExactCentProof,
} from './exact-cent-proof.mjs';

const LOCAL = 'http://127.0.0.1:8765';
const TOKEN =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
const safeCode = (e) =>
  [
    'CREDENTIAL_RENEWAL_REQUIRED',
    'ACCOUNT_SESSION_NOT_VERIFIED',
    'INVALID_CREDENTIAL_ENVELOPE',
    'CALLBACK_ALREADY_USED',
    'INVALID_CALLBACK_STATE',
    'TOKEN_MISSING',
    'HTTP_OUTCOME_UNKNOWN',
    'INVALID_CONTENT_TYPE',
    'INVALID_RESPONSE',
    'BODY_TOO_LARGE',
    'READ_PLAN_APPROVAL_REQUIRED',
    'PRIVATE_CREDENTIALS_REQUIRED',
    'READ_JOURNAL_UNAVAILABLE_OR_ALREADY_RESERVED',
  ].includes(e?.message)
    ? e.message
    : /^HTTP_[1-5]\d{2}$/.test(e?.message ?? '')
      ? e.message
      : 'MONETARY_SESSION_STOPPED';
const escape = (x) =>
  String(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

export function validateRenewedCredentials(input, expectedDocument) {
  if (
    !input ||
    Object.keys(input).sort().join() !==
      'clientId,clientSecret,credentialsRenewed,v2Token,verifiedAccountDocument'
  )
    throw new Error('INVALID_CREDENTIAL_ENVELOPE');
  if (input.credentialsRenewed !== true)
    throw new Error('CREDENTIAL_RENEWAL_REQUIRED');
  if (
    normalizeDocument(input.verifiedAccountDocument) !==
    normalizeDocument(expectedDocument)
  )
    throw new Error('ACCOUNT_SESSION_NOT_VERIFIED');
  authorizationUrl(input.clientId, '0'.repeat(64));
  if (
    !['clientSecret', 'v2Token'].every(
      (k) =>
        typeof input[k] === 'string' &&
        input[k].length > 0 &&
        input[k].length <= 150 &&
        !/[\r\n]/.test(input[k]),
    )
  )
    throw new Error('INVALID_CREDENTIAL_ENVELOPE');
}

export async function startMonetarySession(
  root,
  {
    fetcher = fetch,
    pause,
    importIntervalMs = 1000,
    lifetimeMs = 30 * 60 * 1000,
    readEncryptedInput = readFile,
    mode = 'initial',
  } = {},
) {
  root = resolve(root);
  const exactCentProof = mode === 'exact-cent-proof';
  const prepared = JSON.parse(
    await readFile(
      join(root, exactCentProof ? 'exact-cent-plan.json' : 'private-plan.json'),
      'utf8',
    ),
  );
  if (!['initial', 'continuation-five', 'exact-cent-proof'].includes(mode))
    throw new Error('INVALID_READBACK_MODE');
  if (exactCentProof) {
    const approval = JSON.parse(
      await readFile(join(root, 'exact-cent-approval.json'), 'utf8'),
    );
    if (
      approval.approved !== true ||
      approval.approval !== EXACT_CENT_APPROVAL ||
      approval.approvedDigest !== prepared.approvedDigest
    )
      throw new Error('EXPLICIT_EXACT_CENT_APPROVAL_REQUIRED');
    validateExactCentPlan(prepared.plan, prepared.approvedDigest);
  }
  let continuation = null;
  if (mode === 'continuation-five') {
    const approval = JSON.parse(
      await readFile(join(root, 'five-read-approval.json'), 'utf8'),
    );
    if (approval.approved !== true || approval.approval !== FIVE_READ_APPROVAL)
      throw new Error('EXPLICIT_FIVE_READ_APPROVAL_REQUIRED');
    continuation = {
      approval: approval.approval,
      previousJournalPath: join(root, 'six-read-journal.jsonl'),
      previousJournalSha256: approval.previousJournalSha256,
    };
    await verifyFiveReadContinuation(
      prepared.plan,
      prepared.approvedDigest,
      continuation,
    );
  }
  const maximumOrderReads = exactCentProof ? 14 : continuation ? 5 : 6;
  const journalPath = join(
    root,
    exactCentProof
      ? 'exact-cent-journal.jsonl'
      : continuation
        ? 'five-read-journal.jsonl'
        : 'six-read-journal.jsonl',
  );
  const resultPath = join(
    root,
    exactCentProof
      ? 'exact-cent-result.json'
      : continuation
        ? 'five-read-result.json'
        : 'six-read-result.json',
  );
  try {
    await stat(journalPath);
    throw new Error('SIX_READ_BUDGET_ALREADY_RESERVED');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const directory = join(
    root,
    'oauth-session-' + randomBytes(12).toString('hex'),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
  });
  const publicKeyFile = join(directory, 'public-key.pem');
  const encryptedInputFile = join(directory, 'renewed-credentials.enc');
  await writeFile(
    publicKeyFile,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { flag: 'wx', mode: 0o600 },
  );
  publicKey = null;
  const state = randomBytes(32).toString('hex'),
    latch = { used: false },
    controller = new AbortController();
  let credentials = null,
    result = null,
    phase = 'awaiting_renewed_credentials',
    importing = false,
    imported = false,
    closing = false,
    stage = 'credential_import',
    oauthPostAttempts = 0,
    oauthHttpStatus = null;
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Comparação Olist v2 × v3</title><main><h1>Comparação Olist v2 × v3</h1>' +
          body +
          '</main>',
      );
    };
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:8765')
      return send(403, 'Solicitação recusada.');
    if (req.url === '/') {
      if (phase === 'ready_oauth')
        return send(
          200,
          (exactCentProof
            ? '<p>Prova autorizada: até 3 novos pedidos abertos, R$ 5,20 no total, até 14 leituras. Sem emissão fiscal, lançamento de estoque ou contas.</p><a href="'
            : '<p>Conta conferida e credenciais renovadas importadas em memória. Até ' +
              maximumOrderReads +
              ' consultas de pedidos, sem criação ou alteração.</p><a href="') +
            escape(authorizationUrl(credentials.clientId, state)) +
            (exactCentProof
              ? '">Conectar Olist para prova de centavos</a>'
              : '">Conectar Olist para ' +
                maximumOrderReads +
                ' consultas</a>'),
        );
      return send(
        200,
        '<p>' +
          escape(phase) +
          '</p><p>Tokens não são exibidos ou persistidos. Nenhuma repetição automática.</p>',
      );
    }
    if (
      !req.url?.startsWith('/olist/callback?') ||
      !credentials ||
      phase !== 'ready_oauth'
    )
      return send(409, 'Fluxo indisponível.');
    try {
      stage = 'callback_validation';
      const code = consumeCallback(req.url, req.headers.host, state, latch);
      phase = 'running';
      // Clean code/state from the address bar before any ERP request.
      res.writeHead(303, {
        Location: '/',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      stage = 'oauth_exchange';
      let response = await boundedJson(TOKEN, 'POST', {
        fetcher: async (url, init) => {
          if (
            url !== TOKEN ||
            init.method !== 'POST' ||
            oauthPostAttempts !== 0
          )
            throw new Error('OAUTH_REQUEST_NOT_ALLOWED');
          await writeFile(
            join(directory, 'oauth-attempt.json'),
            JSON.stringify({ stage: 'oauth_exchange', maximumAttempts: 1 }) +
              '\n',
            { flag: 'wx', mode: 0o600 },
          );
          oauthPostAttempts++;
          const returned = await fetcher(url, init);
          oauthHttpStatus = returned.status;
          return returned;
        },
        signal: controller.signal,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          redirect_uri: CALLBACK,
          code,
        }).toString(),
      });
      if (closing) throw new Error('MONETARY_SESSION_STOPPED');
      if (
        typeof response.body?.access_token !== 'string' ||
        !response.body.access_token
      )
        throw new Error('TOKEN_MISSING');
      const fresh = {
        v3AccessToken: response.body.access_token,
        v2Token: credentials.v2Token,
        credentialsRenewed: true,
        verifiedAccountDocument: credentials.verifiedAccountDocument,
      };
      response = null;
      credentials = null;
      try {
        stage = 'order_readback';
        result = await (
          exactCentProof ? executeExactCentProof : runReadbackProbe
        )(prepared.plan, {
          credentials: fresh,
          approvedDigest: prepared.approvedDigest,
          journalPath,
          fetcher,
          signal: controller.signal,
          ...(pause ? { pause } : {}),
          ...(continuation ? { continuation } : {}),
        });
      } finally {
        fresh.v3AccessToken = null;
        fresh.v2Token = null;
      }
      stage = 'result_persistence';
      await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      if (!closing) phase = result.state;
    } catch (e) {
      result = {
        state: 'session_stopped',
        code: safeCode(e),
        stage,
        oauthPostAttempts,
        oauthHttpStatus,
        f1GatePassed: false,
      };
      if (!closing) phase = result.state;
      if (!res.headersSent) {
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
        res.end();
      }
      await writeFile(
        join(directory, 'session-stop.json'),
        JSON.stringify(result) + '\n',
        { flag: 'wx', mode: 0o600 },
      ).catch(() => {});
    } finally {
      credentials = null;
      privateKey = null;
    }
  });
  const interval = setInterval(async () => {
    if (importing || imported || closing) return;
    importing = true;
    try {
      const s = await stat(encryptedInputFile);
      if (closing) return;
      if (s.size !== 512) throw new Error('INVALID_CREDENTIAL_ENVELOPE');
      imported = true;
      const encrypted = await readEncryptedInput(encryptedInputFile);
      if (closing) return;
      const clear = privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        encrypted,
      );
      try {
        const input = JSON.parse(clear.toString('utf8'));
        validateRenewedCredentials(input, prepared.plan.accountDocument);
        await unlink(encryptedInputFile);
        if (closing) return;
        credentials = input;
        privateKey = null;
        phase = 'ready_oauth';
      } finally {
        clear.fill(0);
      }
    } catch (e) {
      if (e.code !== 'ENOENT' && !closing) {
        imported = true;
        credentials = null;
        privateKey = null;
        result = {
          state: 'credential_import_stopped',
          code: safeCode(e),
          f1GatePassed: false,
        };
        phase = result.state;
      }
    } finally {
      importing = false;
    }
  }, importIntervalMs);
  let expiry = null;
  const close = () => {
    if (closing) return;
    closing = true;
    phase = 'closed';
    controller.abort();
    credentials = null;
    privateKey = null;
    clearInterval(interval);
    clearTimeout(expiry);
    server.close();
    server.closeAllConnections();
  };
  try {
    await new Promise((ok, no) => {
      server.once('error', no);
      server.listen(8765, '127.0.0.1', ok);
    });
  } catch (e) {
    close();
    throw e;
  }
  expiry = setTimeout(close, lifetimeMs);
  return {
    publicKeyFile,
    encryptedInputFile,
    directory,
    maximumOrderReads,
    close,
    get phase() {
      return phase;
    },
    get result() {
      return result;
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      ![3, 4].includes(process.argv.length) ||
      (process.argv.length === 4 &&
        !['--continue-five', '--exact-cent-proof'].includes(process.argv[3]))
    )
      throw new Error();
    const session = await startMonetarySession(process.argv[2], {
      mode:
        process.argv[3] === '--exact-cent-proof'
          ? 'exact-cent-proof'
          : process.argv[3]
            ? 'continuation-five'
            : 'initial',
    });
    process.stdout.write(
      JSON.stringify({
        localUrl: LOCAL,
        publicKeyFile: session.publicKeyFile,
        encryptedInputFile: session.encryptedInputFile,
        maximumOrderReads: session.maximumOrderReads,
        oauthErpGetCalls: 0,
        lifetimeMinutes: 30,
      }) + '\n',
    );
    process.once('SIGINT', session.close);
    process.once('SIGTERM', session.close);
  } catch {
    process.stderr.write('MONETARY_SESSION_START_FAILED\n');
    process.exitCode = 1;
  }
}
