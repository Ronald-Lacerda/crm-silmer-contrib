import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const INBOUND = 'CRM - Registrar inbound (MVP)';
const PREFIX = 'Inbox - Imagem recebida - ';
const FILTER = PREFIX + 'Filtrar';
const MEASURE = PREFIX + 'Medir';

const previousFilter = `={{ (() => { const n = $('${NORMALIZE}').item.json; return n.channel === 'whatsapp' && n.message_type === 'image' && ['image/jpeg','image/png','image/webp'].includes(String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase()); })() }}`;
const audioFilter = `={{ (() => { const n = $('${NORMALIZE}').item.json; const mime = String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase(); const allowed = { image: ['image/jpeg','image/png','image/webp'], audio: ['audio/ogg','audio/mpeg'] }; return n.channel === 'whatsapp' && (allowed[n.message_type] ?? []).includes(mime); })() }}`;
const previousMeasure = `const n = $('${NORMALIZE}').item.json;
const mime = String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase();
const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
const bytes = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');
if (!ext || bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error('INBOUND_IMAGE_INVALID');
const file = $input.item.binary?.data;
if (!file) throw new Error('INBOUND_IMAGE_MISSING');
return { json: { mime_type: mime, filename: 'imagem.' + ext }, binary: { data: { ...file, mimeType: mime, fileName: 'imagem.' + ext, fileExtension: ext } } };`;
const audioMeasure = `// INBOX-AUDIO-01: persisted media is independent of the AI/human route.
const n = $('${NORMALIZE}').item.json;
const mime = String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase();
const formats = { image: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }, audio: { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' } };
const ext = formats[n.message_type]?.[mime];
const file = $input.item.binary?.data;
if (!file) throw new Error('INBOUND_MEDIA_MISSING');
if (n.channel !== 'whatsapp' || !ext || String(file.mimeType ?? '').split(';')[0].trim().toLowerCase() !== mime) throw new Error('INBOUND_MEDIA_INVALID');
const bytes = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');
const limit = (n.message_type === 'image' ? 5 : 16) * 1024 * 1024;
if (bytes.length < 1 || bytes.length > limit) throw new Error('INBOUND_MEDIA_INVALID');
const filename = (n.message_type === 'audio' ? 'audio.' : 'imagem.') + ext;
return { json: { mime_type: mime, filename }, binary: { data: { ...file, mimeType: mime, fileName: filename, fileExtension: ext } } };`;

/** @param {unknown} value */
const canonical = (value) =>
  typeof value === 'string' ? value.replace(/\r\n/gu, '\n').trim() : null;

/**
 * INBOX-AUDIO-01 / EVOL-01D / INB-01 / MSG-01..04.
 * Extends the existing, independently connected persistence branch. This is
 * offline and never executes workflow code, calls a service or republishes.
 * Keep historical node names/IDs: attachments, hashes, failure reporting,
 * credentials, settings and every commercial edge remain exactly as supplied.
 * @param {any} source
 * @returns {{workflow:any, changedNodeNames:string[]}}
 */
export function patchEvolutionInboundAudio(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('WORKFLOW_INVALID');
  /** @param {string} name */
  const find = (name) => {
    const nodes = source.nodes.filter(
      (/** @type {any} */ n) => n.name === name,
    );
    if (nodes.length !== 1)
      throw new Error('WORKFLOW_NODE_MISSING_OR_AMBIGUOUS');
    if (nodes[0].disabled === true)
      throw new Error('INBOUND_MEDIA_BRANCH_DISABLED');
    return nodes[0];
  };
  find('Evolution - Validar origem (MVP)');
  find(NORMALIZE);
  const filter = find(FILTER);
  const measure = find(MEASURE);
  const lookup = find(PREFIX + 'Consultar URL');
  const download = find(PREFIX + 'Baixar');
  if (
    lookup.type !== 'n8n-nodes-base.httpRequest' ||
    lookup.parameters?.method !== 'POST' ||
    !/^http:\/\/[a-z0-9_-]+:8080\/chat\/getBase64FromMediaMessage\/[a-z0-9_-]+$/u.test(
      lookup.parameters?.url ?? '',
    ) ||
    lookup.parameters?.genericAuthType !== 'httpHeaderAuth' ||
    !lookup.credentials?.httpHeaderAuth?.id ||
    download.type !== 'n8n-nodes-base.code' ||
    !download.parameters?.jsCode?.includes('function decodeEvolutionMedia(') ||
    !download.parameters.jsCode.includes('EVOLUTION_MEDIA_INVALID')
  )
    throw new Error('EXPECTED_EVOLUTION_MEDIA_ADAPTER');
  if (
    filter.type !== 'n8n-nodes-base.if' ||
    filter.parameters?.conditions?.conditions?.length !== 1 ||
    filter.parameters.conditions.conditions[0].operator?.operation !== 'true' ||
    measure.type !== 'n8n-nodes-base.code' ||
    measure.parameters?.mode !== 'runOnceForEachItem'
  )
    throw new Error('INBOUND_MEDIA_BRANCH_SHAPE_INVALID');
  /** @param {string} from @param {string} to */
  const hasEdge = (from, to) =>
    source.connections[from]?.main?.[0]?.some(
      (/** @type {any} */ edge) =>
        edge.node === to && edge.type === 'main' && edge.index === 0,
    );
  const chain = [
    INBOUND,
    FILTER,
    PREFIX + 'Consultar URL',
    PREFIX + 'Baixar',
    MEASURE,
    PREFIX + 'SHA256',
    PREFIX + 'Preparar anexo',
    PREFIX + 'Salvar no CRM',
  ];
  for (let index = 0; index < chain.length; index++) {
    find(chain[index]);
    if (index && !hasEdge(chain[index - 1], chain[index]))
      throw new Error('INBOUND_MEDIA_CONNECTION_REQUIRED');
  }
  // A persistence branch must not acquire a second route into IA or sending.
  // The inbound node itself still retains all of its unrelated successor edges.
  const failure = PREFIX + 'Preparar falha';
  const report = PREFIX + 'Registrar falha';
  find(failure);
  find(report);
  for (let index = 1; index < chain.length; index++) {
    const expected = [
      ...(chain[index + 1] ? [chain[index + 1]] : []),
      ...(index > 1 ? [failure] : []),
    ];
    const outputs = source.connections[chain[index]]?.main ?? [];
    const actual = outputs.flat().map((/** @type {any} */ edge) => edge.node);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('INBOUND_MEDIA_BRANCH_SHAPE_INVALID');
  }
  if (
    !hasEdge(failure, report) ||
    source.connections[failure]?.main?.flat().length !== 1 ||
    (source.connections[report]?.main?.flat().length ?? 0) !== 0
  )
    throw new Error('INBOUND_MEDIA_BRANCH_SHAPE_INVALID');
  const expression = filter.parameters.conditions.conditions[0].leftValue;
  const measureCode = measure.parameters.jsCode;
  const alreadyPatched =
    canonical(expression) === canonical(audioFilter) &&
    canonical(measureCode) === canonical(audioMeasure);
  if (
    !alreadyPatched &&
    (canonical(expression) !== canonical(previousFilter) ||
      canonical(measureCode) !== canonical(previousMeasure))
  )
    throw new Error('INBOUND_MEDIA_PATCH_CONTEXT_MISMATCH');
  const workflow = structuredClone(source);
  if (alreadyPatched) return { workflow, changedNodeNames: [] };
  for (const node of workflow.nodes) {
    if (node.name === FILTER)
      node.parameters.conditions.conditions[0].leftValue = audioFilter;
    if (node.name === MEASURE) node.parameters.jsCode = audioMeasure;
  }
  return { workflow, changedNodeNames: [FILTER, MEASURE] };
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
      'Usage: node patch-evolution-inbound-audio.mjs <export.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const workflows = Array.isArray(source) ? source : [source];
  if (workflows.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const { workflow, changedNodeNames } = patchEvolutionInboundAudio(
    workflows[0],
  );
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [workflow] : workflow, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    `Prepared ${changedNodeNames.length} node changes offline; nothing was published.\n`,
  );
}
