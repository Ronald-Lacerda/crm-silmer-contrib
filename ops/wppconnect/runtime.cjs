// WPP-01 / ORC-08. Private profile for the pinned upstream gateway.
const fs = require('node:fs/promises');
const { timingSafeEqual, createHash } = require('node:crypto');

let sessionToken;

function required(env, name, minimum = 1) {
  const value = env[name];
  if (typeof value !== 'string' || value.length < minimum)
    throw new Error('WPP_CONFIGURATION_REQUIRED_' + name);
  return value;
}

function settings(env) {
  const session = required(env, 'WPP_SESSION');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session))
    throw new Error('WPP_SESSION_INVALID');
  const phase = required(env, 'WPP_PHASE');
  if (!['pair', 'integrated'].includes(phase))
    throw new Error('WPP_PHASE_INVALID');
  const secret = required(env, 'SECRET_KEY', 32);
  let webhook = null;
  if (phase === 'integrated') {
    required(env, 'WPP_WEBHOOK_TOKEN', 32);
    if (
      !/^\d{8,15}@(c\.us|s\.whatsapp\.net)$/.test(
        env.WPP_EXPECTED_OWN_JID || '',
      )
    )
      throw new Error('WPP_EXPECTED_OWN_JID_REQUIRED');
    let url;
    try {
      url = new URL(required(env, 'WPP_WEBHOOK_URL'));
    } catch {
      throw new Error('WPP_WEBHOOK_URL_INVALID');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('WPP_WEBHOOK_URL_INVALID');
    webhook = url.href;
  }
  return { session, phase, secret, webhook };
}

function buildConfig(env) {
  const { secret, webhook } = settings(env);
  const args = ['--disable-dev-shm-usage', '--no-first-run', '--mute-audio'];
  // Opt in only after proving the container cannot use Chromium's sandbox.
  if (env.WPP_CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox');
  return {
    secretKey: secret,
    host: 'http://127.0.0.1',
    port: 21465,
    deviceName: 'Silmer CRM',
    poweredBy: 'Chrome',
    startAllSession: false,
    tokenStoreType: 'file',
    maxListeners: 15,
    customUserDataDir: '/data/browser',
    webhook: {
      url: webhook,
      allowedUrls: webhook ? [webhook] : [],
      autoDownload: false,
      retryAttempts: 3,
      retryDelay: 5000,
      requestTimeout: 30000,
      autoDownloadMaxSize: 5 * 1024 * 1024,
      uploadS3: false,
      readMessage: false,
      allUnreadOnStart: false,
      listenAcks: env.WPP_PHASE === 'integrated',
      onPresenceChanged: false,
      onParticipantsChanged: false,
      onReactionMessage: false,
      onPollResponse: false,
      onRevokedMessage: false,
      onLabelUpdated: false,
      onSelfMessage: false,
      ignore: ['status@broadcast', 'qrcode', 'phoneCode'],
    },
    websocket: { autoDownload: false, uploadS3: false },
    chatwoot: { sendQrCode: false, sendStatus: false },
    archive: { enable: false, waitTime: 10, daysToArchive: 45 },
    log: { level: 'error', logger: [] },
    createOptions: {
      browserArgs: args,
      useInsecureChromiumArgs: false,
      useChrome: false,
      headless: true,
      debug: false,
      devtools: false,
      logQR: false,
      disableWelcome: true,
      updatesLog: false,
      autoClose: 120000,
      deviceSyncTimeout: 180000,
      linkPreviewApiServers: [],
      puppeteerOptions: { executablePath: '/usr/bin/chromium' },
    },
    mapper: { enable: false, prefix: '' },
    db: {},
    aws_s3: {},
  };
}

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

async function prepareToken(env, bcrypt) {
  const { session, secret } = settings(env);
  process.umask(0o077);
  await fs.mkdir('/data/api', { recursive: true, mode: 0o700 });
  const file = '/data/api/session.token';
  let value = env.WPP_SESSION_TOKEN;
  if (
    value &&
    !(await bcrypt.compare(
      session + secret,
      value.replaceAll('_', '/').replaceAll('-', '+'),
    ))
  )
    throw new Error('WPP_TOKEN_BINDING_INVALID');
  if (value) {
    await fs.writeFile(file, value + '\n', { mode: 0o600 });
  } else {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256)
        throw new Error('WPP_TOKEN_FILE_INVALID');
      value = (await fs.readFile(file, 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      value = (await bcrypt.hash(session + secret, 12))
        .replaceAll('/', '_')
        .replaceAll('+', '-');
      await fs.writeFile(file, value + '\n', { flag: 'wx', mode: 0o600 });
    }
  }
  if (
    !(await bcrypt.compare(
      session + secret,
      value.replaceAll('_', '/').replaceAll('-', '+'),
    ))
  )
    throw new Error('WPP_TOKEN_BINDING_INVALID');
  await fs.chmod(file, 0o600);
  sessionToken = value;
}

const pairGet = new Set([
  'qrcode-session',
  'check-connection-session',
  'status-session',
]);
const pairPost = new Set(['start-session', 'close-session']);
const integratedPost = new Set([
  'send-message',
  'send-file-base64',
  'send-voice-base64',
]);

function createGuard(
  env,
  token,
  getClients = () => require('./util/sessionUtil').clientsArray,
) {
  const { session, phase } = settings(env);
  return function guard(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.originalUrl?.includes('?')) return res.status(404).end();
    if (req.method === 'GET' && req.path === '/healthz') return next();
    // Exact session route; rejects URL credentials and stock secret-in-URL APIs.
    const prefix = '/api/' + session + '/';
    if (!req.path.startsWith(prefix)) return res.status(404).end();
    if (!equalSecret(req.headers.authorization, 'Bearer ' + token))
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    const action = req.path.slice(prefix.length);
    if (req.method === 'GET' && action === 'silmer-identity') {
      const clients = getClients();
      const client = clients[session];
      return Promise.resolve(client?.isConnected?.())
        .then((connected) => (connected === true ? client.getWid() : null))
        .then((jid) => {
          if (
            typeof jid !== 'string' ||
            !/^\d{8,15}@(c\.us|s\.whatsapp\.net)$/.test(jid)
          )
            return res.status(409).json({ connected: false });
          return res.status(200).json({ connected: true, own_jid: jid });
        })
        .catch(() => res.status(409).json({ connected: false }));
    }
    const allowed =
      (req.method === 'GET' && pairGet.has(action)) ||
      (req.method === 'POST' && pairPost.has(action)) ||
      (phase === 'integrated' &&
        req.method === 'POST' &&
        integratedPost.has(action)) ||
      (phase === 'integrated' &&
        req.method === 'GET' &&
        /^get-media-by-message\/[^/]+$/.test(action)) ||
      (phase === 'integrated' &&
        req.method === 'GET' &&
        /^contact\/pn-lid\/(?:\d{8,15}(?:%40|@)(?:c\.us|s\.whatsapp\.net)|\d{5,30}(?:%40|@)lid)$/.test(
          action,
        ));
    if (!allowed) return res.status(404).end();
    return next();
  };
}

function guard(req, res, next) {
  return createGuard(process.env, sessionToken)(req, res, next);
}

function guardBody(req, res, next) {
  if (req.path.endsWith('/start-session')) req.body = { waitQrCode: false };
  return next();
}

function silenceConsole() {
  for (const key of ['log', 'warn', 'error', 'info', 'debug', 'trace'])
    console[key] = () => {};
  process.on('uncaughtException', () => {
    process.stderr.write('WPP_UNCAUGHT_ERROR\n');
    process.exit(1);
  });
  process.on('unhandledRejection', () => {
    process.stderr.write('WPP_UNHANDLED_REJECTION\n');
    process.exit(1);
  });
}

module.exports = {
  buildConfig,
  settings,
  prepareToken,
  guard,
  createGuard,
  guardBody,
  silenceConsole,
  equalSecret,
};
