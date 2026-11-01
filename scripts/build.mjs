import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { build as buildFrontend } from 'vite';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
const copies = [
  ['apps/api/src', 'runtime/apps/api/src'],
  ['apps/api/package.json', 'runtime/apps/api/package.json'],
  ['apps/worker/src', 'runtime/apps/worker/src'],
  ['apps/worker/package.json', 'runtime/apps/worker/package.json'],
  ['modules/database/src', 'runtime/modules/database/src'],
  ['modules/database/migrations', 'runtime/modules/database/migrations'],
  ['modules/database/package.json', 'runtime/modules/database/package.json'],
  ['modules/audit-privacy/src', 'runtime/modules/audit-privacy/src'],
  [
    'modules/audit-privacy/package.json',
    'runtime/modules/audit-privacy/package.json',
  ],
  ['modules/catalog/src', 'runtime/modules/catalog/src'],
  ['modules/catalog/package.json', 'runtime/modules/catalog/package.json'],
  ['modules/configuration/src', 'runtime/modules/configuration/src'],
  [
    'modules/configuration/package.json',
    'runtime/modules/configuration/package.json',
  ],
  ['modules/contacts/src', 'runtime/modules/contacts/src'],
  ['modules/contacts/package.json', 'runtime/modules/contacts/package.json'],
  ['modules/identity-access/src', 'runtime/modules/identity-access/src'],
  [
    'modules/identity-access/package.json',
    'runtime/modules/identity-access/package.json',
  ],
  ['modules/inbox-channels/src', 'runtime/modules/inbox-channels/src'],
  [
    'modules/inbox-channels/package.json',
    'runtime/modules/inbox-channels/package.json',
  ],
  [
    'modules/integration-reliability/src',
    'runtime/modules/integration-reliability/src',
  ],
  [
    'modules/integration-reliability/package.json',
    'runtime/modules/integration-reliability/package.json',
  ],
  ['modules/n8n-integration/src', 'runtime/modules/n8n-integration/src'],
  [
    'modules/n8n-integration/package.json',
    'runtime/modules/n8n-integration/package.json',
  ],
  ['modules/orders/src', 'runtime/modules/orders/src'],
  ['modules/orders/package.json', 'runtime/modules/orders/package.json'],
  ['modules/work-management/src', 'runtime/modules/work-management/src'],
  [
    'modules/work-management/package.json',
    'runtime/modules/work-management/package.json',
  ],
  ['modules/shared/src', 'runtime/modules/shared/src'],
  ['modules/shipping/src', 'runtime/modules/shipping/src'],
  ['modules/shipping/package.json', 'runtime/modules/shipping/package.json'],
  ['modules/shared/package.json', 'runtime/modules/shared/package.json'],
];

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });

await buildFrontend({
  configFile: resolve(root, 'apps/edge-web/vite.config.js'),
});

for (const [source, destination] of copies) {
  const destinationPath = resolve(output, destination);
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(resolve(root, source), destinationPath, { recursive: true });
}

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

const manifest = [];
for (const path of (await listFiles(output)).sort()) {
  const content = await readFile(path);
  manifest.push({
    path: relative(output, path).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(content).digest('hex'),
  });
}

await writeFile(
  resolve(output, 'manifest.json'),
  `${JSON.stringify({ files: manifest }, null, 2)}\n`,
  'utf8',
);
