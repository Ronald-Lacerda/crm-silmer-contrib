import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TARGET = 'k7tI6T4RhQPyJkn9';
const CODE_NODES = [
  'Montar contexto da IA (MVP)',
  'Normalizar decisão da IA (MVP)',
];
const SITE_TRIGGER = 'Site - Receber mensagem do chat (MVP)';
const REDIRECT = 'Site - Direcionar para WhatsApp (MVP)';

/** Merge only this release's behavior into an operational export.
 * Credentials, node IDs, webhook IDs, URLs and retention remain operational.
 * @param {any} deployed @param {any} canonical
 */
export function prepareVendedorUpdate(deployed, canonical) {
  if (deployed.id !== TARGET) throw new Error('WORKFLOW_TARGET_MISMATCH');
  const result = structuredClone(deployed);
  const find = (/** @type {any} */ source, /** @type {string} */ name) => {
    const node = source.nodes.find((/** @type {any} */ n) => n.name === name);
    if (!node) throw new Error('WORKFLOW_NODE_MISSING: ' + name);
    return node;
  };
  for (const name of CODE_NODES) {
    find(result, name).parameters.jsCode = find(
      canonical,
      name,
    ).parameters.jsCode;
  }
  // Explicitly preserve the remotely discovered security wrapper.
  for (const name of CODE_NODES) {
    if (!find(result, name).parameters.jsCode.includes('silmerGuardrail')) {
      throw new Error('PUBLISHED_SECURITY_GUARD_REQUIRED');
    }
  }
  find(
    result,
    'Atendente virtual Silmer (MVP)',
  ).parameters.options.systemMessage = find(
    canonical,
    'Atendente virtual Silmer (MVP)',
  ).parameters.options.systemMessage;
  find(result, SITE_TRIGGER).parameters.options.allowFileUploads = false;
  let redirect = result.nodes.find(
    (/** @type {any} */ n) => n.name === REDIRECT,
  );
  if (!redirect) {
    redirect = structuredClone(find(canonical, REDIRECT));
    redirect.id = randomUUID();
    result.nodes.push(redirect);
  } else {
    redirect.parameters = structuredClone(find(canonical, REDIRECT).parameters);
  }
  result.connections[SITE_TRIGGER] = {
    main: [[{ node: REDIRECT, type: 'main', index: 0 }]],
  };
  // A pre-existing redirect must never retain an edge back to sales/AI.
  delete result.connections[REDIRECT];
  delete result.pinData;
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [deployedPath, outputPath] = process.argv.slice(2);
  if (!deployedPath || !outputPath || deployedPath === outputPath) {
    throw new Error('Distinct deployed export and candidate paths required');
  }
  const deployed = JSON.parse(await readFile(deployedPath, 'utf8'));
  const canonical = JSON.parse(
    await readFile(
      new URL('./k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json', import.meta.url),
      'utf8',
    ),
  );
  await writeFile(
    outputPath,
    JSON.stringify(prepareVendedorUpdate(deployed, canonical), null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    'Candidate saved; no import or publication performed.\n',
  );
}
