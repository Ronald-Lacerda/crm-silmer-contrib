import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TURN_TELEMETRY_VERSION = 'evolution-baileys-1-turns-1';
const INBOUND = 'Preparar inbound CRM (MVP)';
const CONTEXT = 'Montar contexto da IA (MVP)';
const DECISION = 'Normalizar decisão da IA (MVP)';
const RESERVE = 'Preparar reserva de envio da IA (MVP)';
const HANDOFF = 'Preparar handoff da IA (MVP)';
const CONTENT = 'Preparar handoff de conteúdo (MVP)';
// Reviewed from the published export b4407864 on 04/11/2026. These hashes
// contain no credentials or customer data; never accept drift automatically.
/** @type {Readonly<Record<string,string>>} */
export const REVIEWED_TURN_CODE_HASHES = Object.freeze({
  [INBOUND]: '80c13ef352b42fff245a52a0b518baad4b93969985188bbe918d4921ac544dce',
  [CONTEXT]: 'b9aaa96c5cd3442d8fa516f38a7af9a267e3e5e3870a7310a32fa04feb01eb7f',
  [DECISION]:
    '0f31533c4fd18dfd54b6f132cc94902f5c98a4f12e3c51e4b488536879b4bef8',
  [RESERVE]: '3140625802ee927690feb511100d3c6178117f5a04ad1628bbe38d514a0dfb9f',
  [HANDOFF]: 'f83ca128f4f19e5ca6b27b14b46e42ad736cf95eb7fc064808c4d02fcb64f3f0',
  [CONTENT]: '2a2dc1daca62e7f53940d2360c11933d0be8fe1b00e666889a6e14adafedc6c5',
});

/** @param {string} code */
export const turnCodeHash = (code) =>
  createHash('sha256').update(code.replaceAll('\r\n', '\n')).digest('hex');
const START = '// AGENTE-OBS-03 original start\n';
const END = '\n// AGENTE-OBS-03 original end';

const UPSTREAM = `const telemetryRead = (name) => { try { return $(name).item.json; } catch { return null; } };
const telemetryCrm = telemetryRead('CRM - Reler conversa (MVP)') ?? telemetryRead('CRM - Registrar inbound (MVP)') ?? $json;
const telemetrySource = telemetryRead('Normalizar evento WhatsApp (MVP)') ?? {};
const telemetryStarted = telemetryRead('Preparar inbound CRM (MVP)')?.received_at;
const telemetryCapable = !!telemetryCrm && Object.prototype.hasOwnProperty.call(telemetryCrm, 'contact_context');
const telemetryKind = ['image', 'audio'].includes(telemetrySource.media_kind) ? telemetrySource.media_kind
  : telemetrySource.message_type === 'image' && String(telemetrySource.text ?? '').trim() === '[figurinha]' ? 'sticker'
  : ['text', 'button', 'interactive'].includes(telemetrySource.message_type) ? 'text' : null;`;

/** @param {string} model */
function turnBuilder(model) {
  return `const telemetryBuild = (d) => {
  if (!d || d.crm_evolution !== true || !('turn_started_at' in d)) return null;
  const code = (v, pattern) => typeof v === 'string' && pattern.test(v) ? v : null;
  const count = (v) => Number.isInteger(v) && v >= 0 && v <= 64 ? v : 0;
  const total = count(d.ficha_total);
  const start = Date.parse(String(d.turn_started_at ?? ''));
  const end = Date.parse(String(d.decided_at ?? ''));
  const latency = Number.isFinite(start) ? Math.round((Number.isFinite(end) ? end : Date.now()) - start) : null;
  return {
    asked_field: code(d.asked_point, /^[a-z_]{1,48}$/),
    answer_status: ['answered', 'unclear', 'undecided', 'question', 'deferred', 'other', 'none'].includes(d.answer_status) ? d.answer_status : null,
    ficha_filled: Math.min(count(d.ficha_filled), total), ficha_total: total,
    trigger: code(d.trigger, /^[a-z0-9_]{1,64}$/),
    model: d.turn_model === null ? null : ${JSON.stringify(model)},
    latency_ms: latency !== null && latency >= 0 && latency <= 600000 ? latency : null,
    media_kind: ['text', 'image', 'audio', 'sticker'].includes(d.turn_media_kind) ? d.turn_media_kind : null
  };
};`;
}

/** @param {string} name @param {string} code @param {string} model */
function wrap(name, code, model) {
  let before = '';
  let after = '';
  if (name === INBOUND) {
    before = 'const telemetryReceivedAt = new Date().toISOString();\n';
    after = 'telemetryOutput.json.received_at = telemetryReceivedAt;';
  } else if (name === CONTEXT) {
    after = `${UPSTREAM}
telemetryOutput.json.crm_evolution = telemetryCapable;
if (telemetryStarted) telemetryOutput.json.turn_started_at = telemetryStarted;
telemetryOutput.json.turn_media_kind = telemetryKind;`;
  } else if (name === DECISION) {
    after = `telemetryOutput.json.decided_at = new Date().toISOString();
telemetryOutput.json.asked_point = telemetryOutput.json.handoff_required ? null
  : telemetryOutput.json.briefing_patch?.next_required_field ?? telemetryOutput.json.next_point ?? null;`;
  } else {
    before = turnBuilder(model) + '\n';
    after =
      name === CONTENT
        ? `${UPSTREAM}
const telemetryTurn = telemetryStarted ? telemetryBuild({
  crm_evolution: telemetryCapable, turn_started_at: telemetryStarted,
  turn_model: null, ficha_filled: 0, ficha_total: 0,
  turn_media_kind: telemetryKind, trigger: 'unsupported_content'
}) : null;`
        : 'const telemetryTurn = telemetryBuild($json);';
    after +=
      '\nif (telemetryTurn) telemetryOutput.json.payload.turn = telemetryTurn;';
  }
  return `// AGENTE-OBS-03 telemetry overlay\n${before}const telemetryOutput = (() => {\n${START}${code}${END}\n})();\n${after}\nreturn telemetryOutput;\n`;
}

/** Prepare only telemetry; preserve transport, prompts, business behavior,
 * fences, OA, credentials, nodes, connections and settings byte-for-byte.
 * @param {any} source
 * @param {{reviewedCodeHashes?: Record<string,string>}} [options]
 */
export function patchTurnTelemetry(source, options = {}) {
  if (
    source?.id !== 'k7tI6T4RhQPyJkn9' ||
    !Array.isArray(source.nodes) ||
    !source.connections ||
    !source.settings
  )
    throw new Error('TURN_WORKFLOW_INVALID');
  if (Object.keys(source.pinData ?? {}).length)
    throw new Error('TURN_PINNED_DATA_NOT_ALLOWED');
  const result = structuredClone(source);
  const find = (/** @type {string} */ name) => {
    const found = result.nodes.filter(
      (/** @type {any} */ n) => n.name === name,
    );
    if (found.length !== 1)
      throw new Error('TURN_NODE_MISSING_OR_AMBIGUOUS: ' + name);
    return found[0];
  };
  const modelNode = find('OpenAI - Modelo do MVP');
  const model =
    modelNode.parameters?.model?.value ?? modelNode.parameters?.modelName;
  if (typeof model !== 'string' || !/^[a-z0-9._-]{1,64}$/u.test(model))
    throw new Error('TURN_MODEL_INVALID');
  const changedNodeNames = [];
  for (const name of Object.keys(REVIEWED_TURN_CODE_HASHES)) {
    const target = find(name);
    if (
      target.type !== 'n8n-nodes-base.code' ||
      typeof target.parameters?.jsCode !== 'string'
    )
      throw new Error('TURN_CODE_INVALID: ' + name);
    const current = target.parameters.jsCode.replaceAll('\r\n', '\n');
    let original = current;
    if (current.startsWith('// AGENTE-OBS-03 telemetry overlay\n')) {
      const start = current.indexOf(START);
      const end = current.lastIndexOf(END);
      if (start < 0 || end < start)
        throw new Error('TURN_OVERLAY_INVALID: ' + name);
      original = current.slice(start + START.length, end);
      if (current !== wrap(name, original, model))
        throw new Error('TURN_OVERLAY_DRIFT: ' + name);
    }
    if (
      turnCodeHash(original) !==
      (options.reviewedCodeHashes?.[name] ?? REVIEWED_TURN_CODE_HASHES[name])
    )
      throw new Error('TURN_CODE_DRIFT: ' + name);
    const prepared = wrap(name, original, model);
    if (prepared !== current) changedNodeNames.push(name);
    target.parameters.jsCode = prepared;
  }
  for (const name of [
    'CRM - Reservar envio da IA (MVP)',
    'CRM - Registrar handoff (MVP)',
  ]) {
    const target = find(name);
    const headers = (
      target.parameters?.headerParameters?.parameters ?? []
    ).filter(
      (/** @type {any} */ header) =>
        String(header.name).toLowerCase() === 'x-silmer-workflow-version',
    );
    if (headers.length !== 1)
      throw new Error('TURN_VERSION_HEADER_MISSING_OR_AMBIGUOUS: ' + name);
    headers[0].value = TURN_TELEMETRY_VERSION;
  }
  return { workflow: result, changedNodeNames };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || resolve(input) === resolve(output))
    throw new Error('Distinct input and candidate paths required');
  const result = patchTurnTelemetry(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, JSON.stringify(result.workflow, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({
      prepared: true,
      changedNodeNames: result.changedNodeNames,
      version: TURN_TELEMETRY_VERSION,
      published: false,
    }) + '\n',
  );
}
