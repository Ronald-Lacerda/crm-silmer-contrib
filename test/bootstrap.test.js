import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

/** @param {string} relativePath */
async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, rootUrl), 'utf8'));
}

async function digestBuild() {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: rootUrl,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const files = await readdir(new URL('dist/', rootUrl), {
    recursive: true,
    withFileTypes: true,
  });
  const paths = files
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .sort();
  const hash = createHash('sha256');

  for (const path of paths) {
    hash.update(path.replaceAll('\\', '/'));
    hash.update(await readFile(path));
  }

  return hash.digest('hex');
}

test('declares the deployable ESM workspaces and shared module', async () => {
  const expectedPackages = [
    'apps/edge-web/package.json',
    'apps/api/package.json',
    'apps/worker/package.json',
    'modules/inbox-channels/package.json',
    'modules/integration-reliability/package.json',
    'modules/shared/package.json',
  ];

  for (const path of expectedPackages) {
    const packageJson = await readJson(path);
    assert.equal(packageJson.type, 'module', `${path} must be ESM`);
  }
});

test('pins the approved runtime and toolchain versions exactly', async () => {
  const packageJson = await readJson('package.json');
  const apiPackage = await readJson('apps/api/package.json');

  assert.equal(await readFile(new URL('.nvmrc', rootUrl), 'utf8'), '24.20.0\n');
  assert.equal(
    await readFile(new URL('.node-version', rootUrl), 'utf8'),
    '24.20.0\n',
  );
  assert.equal(packageJson.packageManager, 'npm@11.19.0');
  assert.deepEqual(packageJson.engines, { node: '24.20.0', npm: '11.19.0' });
  assert.equal(apiPackage.dependencies.fastify, '5.12.5');
  assert.deepEqual(packageJson.devDependencies, {
    '@axe-core/playwright': '4.13.0',
    '@fontsource/poppins': '5.3.0',
    '@playwright/test': '1.62.1',
    '@types/node': '24.13.3',
    '@types/punycode': '2.1.4',
    '@vitejs/plugin-vue': '6.0.8',
    eslint: '10.9.1',
    'eslint-plugin-vue': '10.11.0',
    prettier: '3.9.6',
    typescript: '7.0.2',
    vite: '8.3.5',
    vue: '3.5.42',
    'vue-router': '4.6.4',
  });
});

test('pins the approved Vue client stack without runtime workspace packages', async () => {
  const rootPackage = await readJson('package.json');
  const packageJson = await readJson('apps/edge-web/package.json');
  const source = await readFile(
    new URL('apps/edge-web/src/main.js', rootUrl),
    'utf8',
  );

  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.equal(rootPackage.devDependencies.vue, '3.5.42');
  assert.equal(rootPackage.devDependencies['vue-router'], '4.6.4');
  assert.equal(rootPackage.devDependencies.vite, '8.3.5');
  assert.match(source, /createApp\(App\)\.use\(router\)\.mount/u);
  assert.doesNotMatch(source, /\b(?:React|Angular|Svelte)\b/u);
  assert.doesNotMatch(source, /\bwindow\s*(?:\.|\[)/u);
});

test('build emits deployable Vue assets instead of source components', async () => {
  await digestBuild();
  const html = await readFile(
    new URL('dist/edge-web/index.html', rootUrl),
    'utf8',
  );
  const files = await readdir(new URL('dist/edge-web/assets/', rootUrl));

  assert.match(html, /\/assets\/[^"']+\.js/u);
  assert.ok(files.some((file) => file.endsWith('.css')));
  assert.ok(files.some((file) => file.endsWith('.woff2')));
  assert.equal(
    files.some((file) => file.endsWith('.vue')),
    false,
  );
});

test('reads form values before disabling the submit button', async () => {
  const source = await readFile(
    new URL('apps/edge-web/src/components/AuthPanel.vue', rootUrl),
    'utf8',
  );

  assert.match(
    source,
    /const data = formValues\(form\);[\s\S]*busy\.value = true;/u,
  );
});

test('exposes a live API health contract', async () => {
  const { createApi } = await import('../apps/api/src/app.js');
  const api = createApi();

  const response = await api.inject({ method: 'GET', url: '/health/live' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    service: 'crm-silmer-api',
    status: 'ok',
  });
  await api.close();
});

test('wires configuration and catalog PostgreSQL runtimes when a database is present', async () => {
  const { createServerApi } = await import('../apps/api/src/server.js');
  let closed = false;
  const database = /** @type {any} */ ({
    async close() {
      closed = true;
    },
    async query() {
      return { rows: [] };
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      return work(database);
    },
  });
  const api = createServerApi({ database });
  const commercial = /** @type {any} */ (api).commercial;

  assert.equal(typeof commercial.configuration.createVersion, 'function');
  assert.equal(
    typeof commercial.configuration.readChannelConfiguration,
    'function',
  );
  assert.equal(typeof commercial.catalog.publish, 'function');
  assert.equal(typeof commercial.catalog.select, 'function');

  await api.close();
  assert.equal(closed, true);
});

test('accepts the legacy operation cursor key during the environment migration', async () => {
  const { createServerApi } = await import('../apps/api/src/server.js');
  const key = Buffer.alloc(32, 7).toString('base64url');
  const database = /** @type {any} */ ({
    async close() {},
    async query() {
      return { rows: [] };
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      return work(database);
    },
  });

  const api = createServerApi({
    database,
    environment: {
      N8N_INTEGRATION_ENABLED: 'false',
      IDEMPOTENCY_ENVELOPE_KEY: key,
      CONTACT_IDENTITY_ENVELOPE_KEY: key,
      CONTACT_IDENTITY_LOOKUP_KEY: key,
      INBOX_MESSAGE_ENVELOPE_KEY: key,
      HANDOFF_ENVELOPE_KEY: key,
      KANBAN_CURSOR_HMAC_KEY: key,
    },
  });

  await api.close();
});

test('produces byte-for-byte reproducible build output', async () => {
  assert.equal(await digestBuild(), await digestBuild());
});

test('build artifact excludes the retired commercial runtime workspace', async () => {
  await digestBuild();
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import('node:fs/promises').then(({access}) => access('./dist/runtime/modules/qualification/src/index.js'))",
    ],
    { cwd: rootUrl, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
});
