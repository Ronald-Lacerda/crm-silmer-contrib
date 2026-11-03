import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  convertEvolutionEvent,
  EVOLUTION_IDENTITY_LOOKUP_BODY,
} from './workflows/create-evolution-workflow.mjs';

const VALIDATE = 'Evolution - Validar origem (MVP)';
const LOOKUP = 'Evolution - Consultar identidade (MVP)';
const CONVERT = 'Evolution - Montar evento WhatsApp (MVP)';
const ORIGINAL_LOOKUP =
  '={{ ({ where: { key: { id: $json.id, remoteJid: $json.chat } }, offset: 2, page: 1 }) }}';
const ORIGINAL_IDENTITY_BLOCK = String.raw`  if (validated.needs_lid) {
    const records = mapping?.messages?.records;
    const matches = Array.isArray(records)
      ? records.filter(
          (record) =>
            record.key?.id === validated.id &&
            record.key?.remoteJid === validated.chat &&
            record.key?.fromMe === (validated.event.kind === 'ack') &&
            pn(record.key?.remoteJidAlt),
        )
      : [];
    phone = matches.length === 1 ? pn(matches[0].key.remoteJidAlt) : null;
  }`;

function converterSources() {
  const current = convertEvolutionEvent.toString().replaceAll('\r\n', '\n');
  const start = current.indexOf('  // OPS-INBOX-ACK-05:');
  const end = current.indexOf(
    '\n  if (!phone || phone === config.ownNumber)',
    start,
  );
  if (start < 0 || end < 0)
    throw new Error('EVOLUTION_ACK_PATCH_SOURCE_CHANGED');
  return {
    current,
    original:
      current.slice(0, start) + ORIGINAL_IDENTITY_BLOCK + current.slice(end),
  };
}

/**
 * OPS-INBOX-ACK-05: patch only the two reviewed fields of a current private
 * export. Configuration stays in that export; no identity, payload or URL is
 * printed. This function never executes source code or contacts a provider.
 * @param {any} source
 * @returns {{workflow:any, changedNodeNames:string[]}}
 */
export function patchEvolutionAckIdentity(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('EVOLUTION_ACK_WORKFLOW_INVALID');
  const find = (/** @type {string} */ name) => {
    const found = source.nodes.filter(
      (/** @type {any} */ node) => node.name === name,
    );
    if (found.length !== 1)
      throw new Error('EVOLUTION_ACK_NODE_MISSING_OR_AMBIGUOUS');
    return found[0];
  };
  const lookup = find(LOOKUP);
  const converter = find(CONVERT);
  if (
    lookup.type !== 'n8n-nodes-base.httpRequest' ||
    lookup.parameters?.method !== 'POST' ||
    converter.type !== 'n8n-nodes-base.code' ||
    converter.parameters?.mode !== 'runOnceForEachItem' ||
    typeof converter.parameters?.jsCode !== 'string'
  )
    throw new Error('EVOLUTION_ACK_NODE_SHAPE_INVALID');
  const currentCode = converter.parameters.jsCode.replaceAll('\r\n', '\n');
  const wrapper = `;\nconst input=$('${VALIDATE}').item.json;return {json:convert(input,input.needs_lid?$json:null,`;
  const parts = currentCode.split(wrapper);
  if (
    parts.length !== 2 ||
    !parts[0].startsWith('const convert=') ||
    !parts[1].endsWith(')};')
  )
    throw new Error('EVOLUTION_ACK_CONVERTER_CONTEXT_MISMATCH');
  let config;
  try {
    config = JSON.parse(parts[1].slice(0, -3));
  } catch {
    throw new Error('EVOLUTION_ACK_CONFIGURATION_INVALID');
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(',') !== 'baseUrl,ownNumber,session' ||
    typeof config.ownNumber !== 'string' ||
    !/^\d{8,15}$/u.test(config.ownNumber) ||
    typeof config.baseUrl !== 'string' ||
    typeof config.session !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(config.session) ||
    lookup.parameters.url !==
      config.baseUrl + '/chat/findMessages/' + config.session
  )
    throw new Error('EVOLUTION_ACK_CONFIGURATION_INVALID');
  const code = parts[0].slice('const convert='.length);
  const expected = converterSources();
  const original =
    code === expected.original &&
    lookup.parameters.jsonBody === ORIGINAL_LOOKUP;
  const alreadyPatched =
    code === expected.current &&
    lookup.parameters.jsonBody === EVOLUTION_IDENTITY_LOOKUP_BODY;
  if (!original && !alreadyPatched)
    throw new Error('EVOLUTION_ACK_PATCH_CONTEXT_MISMATCH');
  const workflow = structuredClone(source);
  if (alreadyPatched) return { workflow, changedNodeNames: [] };
  workflow.nodes.find(
    (/** @type {any} */ node) => node.name === LOOKUP,
  ).parameters.jsonBody = EVOLUTION_IDENTITY_LOOKUP_BODY;
  workflow.nodes.find(
    (/** @type {any} */ node) => node.name === CONVERT,
  ).parameters.jsCode =
    'const convert=' +
    expected.current +
    wrapper +
    JSON.stringify(config) +
    ')};';
  return { workflow, changedNodeNames: [LOOKUP, CONVERT] };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (
    !inputPath ||
    !outputPath ||
    extra.length ||
    resolve(inputPath) === resolve(outputPath)
  )
    throw new Error(
      'Usage: node patch-evolution-ack-identity.mjs <export.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const workflows = Array.isArray(source) ? source : [source];
  if (workflows.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const { workflow, changedNodeNames } = patchEvolutionAckIdentity(
    workflows[0],
  );
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [workflow] : workflow, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ changedNodeNames }) + '\n');
}
