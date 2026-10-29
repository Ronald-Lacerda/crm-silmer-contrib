import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Decode only authenticated gateway bytes; URLs and embedded keys are ignored.
 * @param {any} response @param {any} source
 */
export function decodeInboxImage(response, source) {
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const mime = String(response?.mimetype ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const expected = String(source.media_mime_type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const encoded = response?.base64;
  const limit = 5 * 1024 * 1024;
  if (
    !['image', 'document'].includes(source.message_type) ||
    !Object.hasOwn(extensions, mime) ||
    mime !== expected ||
    typeof encoded !== 'string' ||
    !encoded.length ||
    encoded.length > Math.ceil(limit / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw new Error('INBOUND_IMAGE_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  if (
    !bytes.length ||
    bytes.length > limit ||
    bytes.toString('base64') !== encoded
  )
    throw new Error('INBOUND_IMAGE_INVALID');
  const extension = extensions[/** @type {keyof typeof extensions} */ (mime)];
  return {
    json: {},
    binary: {
      data: {
        data: encoded,
        mimeType: mime,
        fileName: 'imagem.' + extension,
        fileExtension: extension,
      },
    },
  };
}

/** Preserve n8n binary metadata while bounding a raster document like an image.
 * @param {any} source @param {any} file @param {Buffer} bytes
 */
export function measureInboxImage(source, file, bytes) {
  const formats = /** @type {Record<string,string>} */ ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  });
  const mime = String(source.media_mime_type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const ext = formats[mime];
  if (
    !file ||
    !ext ||
    !bytes.length ||
    bytes.length > 5 * 1024 * 1024 ||
    String(file.mimeType ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase() !== mime
  )
    throw new Error('INBOUND_IMAGE_INVALID');
  const filename = 'imagem.' + ext;
  return {
    json: { mime_type: mime, filename },
    binary: {
      data: { ...file, mimeType: mime, fileName: filename, fileExtension: ext },
    },
  };
}

/** Narrow, offline patch for the existing Evolution Inbox branch.
 * Commercial routing, canonical message types, credentials and IDs stay intact.
 * @param {Record<string, any>} source
 */
export function patchEvolutionInboundImages(source) {
  if (
    !Array.isArray(source?.nodes) ||
    !source.connections ||
    source.settings?.executionOrder !== 'v1'
  )
    throw new Error('EXPECTED_V1_WORKFLOW');
  const workflow = structuredClone(source);
  /** @param {string} name */
  function find(name) {
    const nodes = workflow.nodes.filter(
      (/** @type {any} */ n) => n.name === name,
    );
    if (nodes.length !== 1) throw new Error('EXPECTED_UNIQUE_IMAGE_NODE');
    return nodes[0];
  }
  const prefix = 'Inbox - Imagem recebida - ';
  const filter = find(prefix + 'Filtrar');
  const lookup = find(prefix + 'Consultar URL');
  const download = find(prefix + 'Baixar');
  const measure = find(prefix + 'Medir');
  const report = find(prefix + 'Registrar falha');
  if (
    filter.type !== 'n8n-nodes-base.if' ||
    download.type !== 'n8n-nodes-base.code' ||
    !download.parameters.jsCode.includes('decodeEvolutionMedia') ||
    lookup.type !== 'n8n-nodes-base.httpRequest' ||
    !String(lookup.parameters.url).includes(
      '/chat/getBase64FromMediaMessage/',
    ) ||
    !lookup.credentials?.httpHeaderAuth?.id ||
    !measure.parameters.jsCode.includes('getBinaryDataBuffer')
  )
    throw new Error('EXPECTED_EVOLUTION_IMAGE_BRANCH');
  const condition = filter.parameters.conditions?.conditions;
  if (
    !Array.isArray(condition) ||
    condition.length !== 1 ||
    condition[0].operator?.type !== 'boolean' ||
    condition[0].operator.operation !== 'true'
  )
    throw new Error('EXPECTED_IMAGE_FILTER');
  const chain = [
    'Filtrar',
    'Consultar URL',
    'Baixar',
    'Medir',
    'SHA256',
    'Preparar anexo',
    'Salvar no CRM',
  ];
  /** @param {string} from @param {string} to @param {number} output */
  function requireEdge(from, to, output) {
    const edges = workflow.connections[prefix + from]?.main?.[output];
    if (
      !Array.isArray(edges) ||
      edges.length !== 1 ||
      edges[0].node !== prefix + to ||
      edges[0].type !== 'main' ||
      edges[0].index !== 0
    )
      throw new Error('EXPECTED_IMAGE_CHAIN');
  }
  for (let i = 0; i < chain.length - 1; i++)
    requireEdge(chain[i], chain[i + 1], 0);
  for (const name of chain.slice(1)) {
    if (find(prefix + name).onError !== 'continueErrorOutput')
      throw new Error('EXPECTED_IMAGE_ERROR_ROUTE');
    requireEdge(name, 'Preparar falha', 1);
  }
  requireEdge('Preparar falha', 'Registrar falha', 0);
  const originalFilter = condition[0].leftValue;
  if (
    typeof originalFilter !== 'string' ||
    !originalFilter.startsWith('={{') ||
    originalFilter.indexOf('}}', 3) !== originalFilter.length - 2
  )
    throw new Error('EXPECTED_IMAGE_EXPRESSION');
  // The shared persistence branch can already support audio. Keep that exact
  // predicate and decoder as the non-raster path instead of reverting it.
  condition[0].leftValue = `={{ (${originalFilter.slice(3, -2)}) || (() => { const n = $('Normalizar evento WhatsApp (MVP)').item.json; return n.channel === 'whatsapp' && ['image','document'].includes(n.message_type) && ['image/jpeg','image/png','image/webp','image/gif'].includes(String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase()); })() }}`;
  download.parameters.jsCode = `if (['image','document'].includes($('Normalizar evento WhatsApp (MVP)').item.json.message_type)) { const decodeInboxImage=${decodeInboxImage.toString()}; return decodeInboxImage($json,$('Normalizar evento WhatsApp (MVP)').item.json); }\n${download.parameters.jsCode}`;
  measure.parameters.jsCode = `if (['image','document'].includes($('Normalizar evento WhatsApp (MVP)').item.json.message_type)) { const measureInboxImage=${measureInboxImage.toString()}; return measureInboxImage($('Normalizar evento WhatsApp (MVP)').item.json,$input.item.binary?.data,await this.helpers.getBinaryDataBuffer($itemIndex,'data')); }\n${measure.parameters.jsCode}`;
  // n8n v1 schedules fanout destinations by (y,x), not array order. Persist
  // first so a later commercial/AI failure cannot prevent the Inbox upload.
  const fanout =
    workflow.connections['CRM - Registrar inbound (MVP)']?.main?.[0];
  if (
    !Array.isArray(fanout) ||
    fanout.filter((/** @type {any} */ e) => e.node === filter.name).length !== 1
  )
    throw new Error('EXPECTED_IMAGE_FANOUT');
  const siblings = fanout
    .filter((/** @type {any} */ e) => e.node !== filter.name)
    .map((/** @type {any} */ e) => find(e.node));
  if (
    !siblings.length ||
    siblings.some((/** @type {any} */ n) => !Number.isFinite(n.position?.[1]))
  )
    throw new Error('EXPECTED_IMAGE_SIBLINGS');
  filter.position[1] =
    Math.min(...siblings.map((/** @type {any} */ n) => n.position[1])) - 320;
  // Failure reporting is best effort; a monitoring outage cannot block the
  // preserved human/commercial route after this independent branch finishes.
  report.onError = 'continueRegularOutput';
  return workflow;
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
      'Usage: node patch-evolution-inbound-images.mjs <current.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const list = Array.isArray(source) ? source : [source];
  if (list.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const result = patchEvolutionInboundImages(list[0]);
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [result] : result, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    'Prepared Inbox image patch offline; nothing was published.\n',
  );
}
