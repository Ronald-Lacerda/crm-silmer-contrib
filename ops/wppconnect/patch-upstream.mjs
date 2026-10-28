import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Deliberately fail if upstream moves. Use only the source commit pinned in Dockerfile.
const root = resolve(process.argv[2] || '.');
async function edit(path, before, after) {
  const file = resolve(root, path);
  const source = await readFile(file, 'utf8');
  if (
    !source.includes(before) ||
    source.indexOf(before) !== source.lastIndexOf(before)
  )
    throw new Error('WPP_PATCH_CONTEXT_MISMATCH_' + path);
  await writeFile(file, source.replace(before, after));
}

await writeFile(
  resolve(root, 'src/config.ts'),
  `import { ServerOptions } from './types/ServerOptions';
const { buildConfig } = require('./silmer-runtime.cjs');
export default buildConfig(process.env) as unknown as ServerOptions;
`,
);
await writeFile(
  resolve(root, 'src/server.ts'),
  `import bcrypt from 'bcrypt';
import config from './config';
import { initServer } from './index';
const runtime = require('./silmer-runtime.cjs');
runtime.silenceConsole();
runtime.prepareToken(process.env, bcrypt).then(() => initServer(config)).catch(() => {
  process.stderr.write('WPP_STARTUP_CONFIGURATION_FAILED\\n'); process.exit(1);
});
`,
);

await edit(
  'src/index.ts',
  'export const logger = createLogger(config.log);',
  `defaultLogger.silent = true;
export const logger = createLogger(config.log);
logger.silent = true;`,
);
await edit(
  'src/index.ts',
  '  const app = express();',
  `  const app = express();
  app.disable('x-powered-by');
  app.use(require('./silmer-runtime.cjs').guard);`,
);
await edit(
  'src/index.ts',
  '  app.use(cors());',
  '  // Private gateway: no browser CORS surface.',
);
await edit(
  'src/index.ts',
  '  app.use(boolParser());',
  `  app.use(boolParser());
  app.use(require('./silmer-runtime.cjs').guardBody);`,
);
await edit(
  'src/index.ts',
  '  const io = new Socket(http, {',
  `  const io = new Socket(http, {
    allowRequest: (_request, callback) => callback('Disabled', false),`,
);

const fnPath = resolve(root, 'src/util/functions.ts');
let source = await readFile(fnPath, 'utf8');
const begin = source.indexOf('export async function callWebHook(');
const end = source.indexOf('\nfunction webhookNumber(', begin);
if (begin < 0 || end < 0) throw new Error('WPP_WEBHOOK_PATCH_CONTEXT_MISMATCH');
source =
  source.slice(0, begin) +
  `export async function callWebHook(client: any, req: Request, event: any, data: any) {
  return require('../silmer-webhook.cjs').deliverWebhook(client, req, event, data, api);
}
` +
  source.slice(end);
await writeFile(fnPath, source);
await edit(
  'src/util/tokenStore/FileTokenStore/FileTokenStore.ts',
  "  path: './tokens',",
  "  path: '/data/tokens',",
);
await edit(
  'src/util/createSessionUtil.ts',
  '    await this.listenMessages(client, req);',
  "    if (process.env.WPP_PHASE === 'integrated') await this.listenMessages(client, req);",
);
await edit(
  'src/util/createSessionUtil.ts',
  `      if (message.type === 'sticker') {
        download(message, client, req.logger);
      }`,
  '      // Silmer: no unsolicited sticker download or public static media copy.',
);

// Upstream routes import instrumentation at module load and Babel emits runtime
// helper imports. Keep these locked packages when pruning build-only packages.
const packagePath = resolve(root, 'package.json');
const project = JSON.parse(await readFile(packagePath, 'utf8'));
if (project.version !== '2.10.69')
  throw new Error('WPP_PACKAGE_PATCH_CONTEXT_MISMATCH');
for (const [name, version] of [
  ['prom-client', '^14.2.0'],
  ['@babel/runtime', '^7.29.10'],
]) {
  if (project.devDependencies[name] !== version)
    throw new Error('WPP_PACKAGE_PATCH_CONTEXT_MISMATCH');
  project.dependencies[name] = version;
  delete project.devDependencies[name];
}
await writeFile(packagePath, JSON.stringify(project, null, 2) + '\n');

// No dependency updates: the upstream immutable lock must resolve this exact core.
const lock = await readFile(resolve(root, 'yarn.lock'), 'utf8');
if (!lock.includes('resolution: "@wppconnect-team/wppconnect@npm:2.3.6"'))
  throw new Error('WPP_CORE_LOCK_MISMATCH');
console.log('WPP_PATCH_APPLIED');
