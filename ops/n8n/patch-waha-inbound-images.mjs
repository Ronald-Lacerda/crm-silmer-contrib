import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const INBOUND = 'CRM - Registrar inbound (MVP)';
const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const LOOKUP = 'WhatsApp - Consultar mídia (MVP)';
const DOWNLOAD = 'WhatsApp - Baixar mídia (MVP)';
const PREFIX = 'Inbox - Imagem recebida - ';
const names = Object.freeze({
  filter: PREFIX + 'Filtrar',
  lookup: PREFIX + 'Consultar URL',
  download: PREFIX + 'Baixar',
  measure: PREFIX + 'Medir',
  hash: PREFIX + 'SHA256',
  prepare: PREFIX + 'Preparar anexo',
  upload: PREFIX + 'Salvar no CRM',
  failure: PREFIX + 'Preparar falha',
  report: PREFIX + 'Registrar falha',
});

/**
 * Adds an isolated persistence branch to an exported WAHA workflow. This
 * function is offline: it never calls n8n, WAHA or the CRM. Existing nodes,
 * credentials, settings and reply paths are preserved verbatim.
 * @param {Record<string, any>} source
 */
export function patchWahaInboundImages(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('WORKFLOW_INVALID');
  /** @param {string} name */
  const find = (name) => {
    const matches = source.nodes.filter(
      (/** @type {any} */ n) => n.name === name,
    );
    if (matches.length !== 1)
      throw new Error('WORKFLOW_NODE_MISSING_OR_AMBIGUOUS');
    return matches[0];
  };
  const inbound = find(INBOUND);
  find(NORMALIZE);
  const lookup = find(LOOKUP);
  const download = find(DOWNLOAD);
  if (
    lookup.type !== 'n8n-nodes-base.code' ||
    !lookup.parameters?.jsCode?.includes('validateWahaMediaUrl') ||
    !lookup.parameters.jsCode.includes('waha_media_url') ||
    !lookup.parameters.jsCode.includes('/api/files/') ||
    download.type !== 'n8n-nodes-base.httpRequest' ||
    (download.parameters?.method ?? 'GET') !== 'GET' ||
    !/^=\{\{\s*\$json\.url\s*\}\}$/u.test(download.parameters?.url ?? '') ||
    download.credentials?.whatsAppApi
  )
    throw new Error('EXPECTED_WAHA_MEDIA_ADAPTER');
  if (
    inbound.type !== 'n8n-nodes-base.httpRequest' ||
    inbound.parameters?.authentication !== 'genericCredentialType' ||
    inbound.parameters?.genericAuthType !== 'httpBasicAuth' ||
    !inbound.credentials?.httpBasicAuth?.id
  )
    throw new Error('BOUND_CRM_CREDENTIAL_REQUIRED');
  let base;
  try {
    const rawUrl = inbound.parameters.url;
    if (typeof rawUrl !== 'string') throw new Error();
    // The deployed n8n export uses two constant JSON strings. Parse that
    // precise shape; never evaluate an expression supplied by a workflow.
    const constant =
      /^=?\{\{\s*("(?:[^"\\]|\\.)*")\s*\+\s*("(?:[^"\\]|\\.)*")\s*\}\}$/u.exec(
        rawUrl,
      );
    const url = new URL(
      constant ? JSON.parse(constant[1]) + JSON.parse(constant[2]) : rawUrl,
    );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/api/v1/integrations/n8n/messages/inbound'
    )
      throw new Error();
    base = url.origin;
  } catch {
    throw new Error('FIXED_CRM_INBOUND_URL_REQUIRED');
  }
  const originalHeaders = inbound.parameters.headerParameters?.parameters;
  if (!Array.isArray(originalHeaders)) throw new Error('CRM_HEADERS_REQUIRED');
  for (const required of [
    'X-Silmer-Workflow-Key',
    'X-Silmer-Workflow-Version',
    'X-Silmer-Execution-Id',
  ]) {
    if (
      originalHeaders.filter(
        (/** @type {any} */ h) =>
          h.name.toLowerCase() === required.toLowerCase(),
      ).length !== 1
    )
      throw new Error('CRM_HEADERS_REQUIRED');
  }
  if (source.nodes.some((/** @type {any} */ n) => n.name?.startsWith(PREFIX)))
    throw new Error('INBOUND_IMAGE_PATCH_ALREADY_PRESENT');
  const workflow = structuredClone(source);
  const existing = workflow.connections[INBOUND]?.main?.[0];
  if (!Array.isArray(existing) || existing.length === 0)
    throw new Error('CRM_INBOUND_CONNECTION_REQUIRED');
  const ids = new Set(workflow.nodes.map((/** @type {any} */ n) => n.id));
  let addedCount = 0;
  /** @param {string} key @param {any} definition */
  function add(key, definition) {
    const id = `inbox-inbound-image-${key}`;
    if (ids.has(id)) throw new Error('INBOUND_IMAGE_NODE_ID_CONFLICT');
    const name = /** @type {Record<string,string>} */ (names)[key];
    const result = {
      ...definition,
      id,
      name,
      position: [
        Number(inbound.position?.[0] ?? 0) + 240 * addedCount++,
        Number(inbound.position?.[1] ?? 0) + 900,
      ],
    };
    workflow.nodes.push(result);
    return result;
  }
  /** @param {string} key @param {string} jsCode */
  const code = (key, jsCode) =>
    add(key, {
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      onError: 'continueErrorOutput',
      parameters: { mode: 'runOnceForEachItem', jsCode },
    });
  const filter = add('filter', {
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
        conditions: [
          {
            id: 'inbox-inbound-image-filter',
            leftValue: `={{ (() => { const n = $('${NORMALIZE}').item.json; return n.channel === 'whatsapp' && n.message_type === 'image' && ['image/jpeg','image/png','image/webp'].includes(String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase()); })() }}`,
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  });
  const getUrl = add('lookup', structuredClone(lookup));
  const getBytes = add('download', structuredClone(download));
  for (const n of [getUrl, getBytes]) {
    n.onError = 'continueErrorOutput';
    delete n.disabled;
  }
  getBytes.parameters.options = {
    ...getBytes.parameters.options,
    timeout: 30000,
    redirect: { redirect: { followRedirects: false } },
    response: {
      response: { responseFormat: 'file', outputPropertyName: 'data' },
    },
  };
  const measure = code(
    'measure',
    `const n = $('${NORMALIZE}').item.json;
const mime = String(n.media_mime_type ?? '').split(';')[0].trim().toLowerCase();
const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
const bytes = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');
if (!ext || bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error('INBOUND_IMAGE_INVALID');
const file = $input.item.binary?.data;
if (!file) throw new Error('INBOUND_IMAGE_MISSING');
return { json: { mime_type: mime, filename: 'imagem.' + ext }, binary: { data: { ...file, mimeType: mime, fileName: 'imagem.' + ext, fileExtension: ext } } };`,
  );
  const hash = add('hash', {
    type: 'n8n-nodes-base.crypto',
    typeVersion: 2,
    onError: 'continueErrorOutput',
    parameters: {
      action: 'hash',
      type: 'SHA256',
      binaryData: true,
      binaryPropertyName: 'data',
      encoding: 'hex',
      dataPropertyName: 'media_sha256',
    },
  });
  const prepare = code(
    'prepare',
    `const n = $('${NORMALIZE}').item.json;
const inbound = $('${INBOUND}').item.json;
const measured = $('${names.measure}').item;
if (typeof inbound.conversation_id !== 'string' || !inbound.conversation_id || typeof n.event_id !== 'string' || !n.event_id || n.event_id.length > 255 || !/^[a-f0-9]{64}$/.test($json.media_sha256 ?? '')) throw new Error('INBOUND_IMAGE_METADATA_INVALID');
// The attachment receipt has its own scope; reuse the full external ID without
// adding a prefix that would overflow the 255-character Idempotency-Key limit.
return { json: { conversation_id: inbound.conversation_id, external_id: n.event_id, filename: measured.json.filename, mime_type: measured.json.mime_type, content_sha256: $json.media_sha256, idempotency_key: n.event_id, correlation_id: String($execution.id).padStart(16, '0') }, binary: measured.binary };`,
  );
  /** @param {boolean} attachment */
  function headers(attachment) {
    return [
      ...structuredClone(originalHeaders).filter(
        (/** @type {any} */ h) =>
          ![
            'content-type',
            'idempotency-key',
            'x-correlation-id',
            'x-silmer-content-sha256',
          ].includes(h.name.toLowerCase()),
      ),
      { name: 'Idempotency-Key', value: '={{ $json.idempotency_key }}' },
      { name: 'X-Correlation-Id', value: '={{ $json.correlation_id }}' },
      ...(attachment
        ? [
            {
              name: 'X-Silmer-Content-SHA256',
              value: '={{ $json.content_sha256 }}',
            },
          ]
        : [{ name: 'Content-Type', value: 'application/json' }]),
    ];
  }
  const upload = add('upload', {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: inbound.typeVersion,
    credentials: structuredClone(inbound.credentials),
    onError: 'continueErrorOutput',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 1000,
    parameters: {
      method: 'POST',
      url: `={{ '${base}/api/v1/integrations/n8n/conversations/' + encodeURIComponent($json.conversation_id) + '/attachments' }}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendHeaders: true,
      headerParameters: { parameters: headers(true) },
      sendBody: true,
      contentType: 'multipart-form-data',
      bodyParameters: {
        parameters: [
          { name: 'schema_version', value: '1.0' },
          ...['external_id', 'filename', 'mime_type'].map((name) => ({
            name,
            value: `={{ $json.${name} }}`,
          })),
          {
            parameterType: 'formBinaryData',
            name: 'file',
            inputDataFieldName: 'data',
          },
        ],
      },
      options: {
        redirect: { redirect: { followRedirects: false } },
        response: { response: { responseFormat: 'json' } },
        timeout: 60000,
      },
    },
  });
  const failure = code(
    'failure',
    `const executionId = String($execution.id);
if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) throw new Error('INBOUND_IMAGE_EXECUTION_INVALID');
const eventId = 'inbound-image-failed:' + executionId;
return { json: { payload: { schema_version: '1.0', event_id: eventId, event_type: 'workflow.failed', occurred_at: new Date().toISOString(), conversation_id: $('${INBOUND}').item.json.conversation_id, failure: { code: 'INBOUND_MEDIA_STORE_FAILED' } }, idempotency_key: eventId, correlation_id: String($execution.id).padStart(16, '0') } };`,
  );
  delete failure.onError;
  const report = add('report', {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: inbound.typeVersion,
    credentials: structuredClone(inbound.credentials),
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 1000,
    parameters: {
      method: 'POST',
      url: base + '/api/v1/integrations/n8n/events',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendHeaders: true,
      headerParameters: { parameters: headers(false) },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ $json.payload }}',
      options: {
        redirect: { redirect: { followRedirects: false } },
        response: { response: { responseFormat: 'json' } },
        timeout: 10000,
      },
    },
  });
  /** @param {any} from @param {any} to @param {number} [output] */
  function connect(from, to, output = 0) {
    const outputs = (workflow.connections[from.name] ??= { main: [] }).main;
    while (outputs.length <= output) outputs.push([]);
    outputs[output].push({ node: to.name, type: 'main', index: 0 });
  }
  existing.push({ node: filter.name, type: 'main', index: 0 });
  const chain = [filter, getUrl, getBytes, measure, hash, prepare, upload];
  for (let i = 0; i < chain.length - 1; i++) connect(chain[i], chain[i + 1]);
  for (const n of chain.slice(1)) connect(n, failure, 1);
  connect(failure, report);
  return { workflow, addedNodeNames: Object.values(names) };
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
      'Usage: node patch-waha-inbound-images.mjs <export.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const workflows = Array.isArray(source) ? source : [source];
  if (workflows.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const { workflow, addedNodeNames } = patchWahaInboundImages(workflows[0]);
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [workflow] : workflow, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    `Prepared ${addedNodeNames.length} image persistence nodes offline; nothing was published.\n`,
  );
}
