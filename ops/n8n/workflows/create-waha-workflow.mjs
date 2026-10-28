import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TRIGGER = 'WhatsApp - Receber eventos (MVP)';
const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const VALIDATE = 'WAHA - Validar origem (MVP)';
const NEEDS_LID = 'WAHA - Resolver LID? (MVP)';
const LOOKUP_LID = 'WAHA - Consultar identidade (MVP)';
const CONVERT = 'WAHA - Montar evento WhatsApp (MVP)';
const ACK_GATE = 'WAHA - Filtrar confirmação durável (MVP)';
const ACK = 'WAHA - Confirmar recebimento durável (MVP)';
const HUMAN_RESERVE = 'Preparar reserva de envio humano (MVP)';
const MEDIA_UPLOAD = 'Meta - Upload midia humana (MVP)';
const MEDIA_PREPARE = 'Preparar mensagem Meta de midia (MVP)';
const MEDIA_SEND = 'Meta - Enviar midia humana (MVP)';

/** A PN is accepted only when WhatsApp itself identifies it as a PN JID.
 * @param {any} root @param {any} config @returns {any}
 */
export function validateWahaEvent(root, config) {
  const event = root?.body ?? root;
  if (!event || event.session !== config.session || event.engine !== 'WEBJS') {
    throw new Error('WAHA_SOURCE_MISMATCH');
  }
  if (!['message', 'message.any', 'message.ack'].includes(event.event))
    return null;
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@(?:c\.us|s\.whatsapp\.net)$/.exec(String(value ?? ''))?.[1] ??
    null;
  if (pn(event.me?.id) !== config.ownNumber)
    throw new Error('WAHA_ACCOUNT_MISMATCH');
  const payload = event.payload;
  if (!payload || typeof payload !== 'object')
    throw new Error('WAHA_PAYLOAD_INVALID');
  const ack = event.event === 'message.ack';
  if ((!ack && payload.fromMe !== false) || (ack && payload.fromMe !== true))
    return null;
  if (
    payload.isGroup === true ||
    payload.participant ||
    /@(?:g\.us|broadcast|newsletter)$/.test(String(payload.from))
  )
    return null;
  const chat =
    ack && payload.to && pn(payload.to) !== config.ownNumber
      ? payload.to
      : payload.from;
  if (!pn(chat) && !/^\d{1,30}@lid$/.test(String(chat ?? ''))) return null;
  if (pn(chat) === config.ownNumber) return null;
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 512)
    throw new Error('WAHA_MESSAGE_ID_INVALID');
  // WAHA-01D / ORC-08: the synchronous reserved send records message.sent
  // with its command_id. SERVER/ACK 1 has no command_id and is not a second
  // authoritative send result. Only delivery/read/failure receipts follow.
  if (ack && ![-1, 2, 3, 4].includes(Number(payload.ack))) return null;
  // MSG-03: a receipt's payload timestamp is the original message time.
  // Its envelope timestamp identifies the receipt; never invent that time.
  let occurred = ack ? event.timestamp : (payload.timestamp ?? event.timestamp);
  if (typeof occurred === 'string' && !/^\d+(?:\.\d+)?$/.test(occurred))
    occurred = Date.parse(occurred);
  occurred = Number(occurred);
  if (occurred > 1e12) occurred /= 1000;
  if (!Number.isFinite(occurred) || occurred <= 0)
    throw new Error('WAHA_TIMESTAMP_INVALID');
  return {
    waha: event,
    chat,
    needs_lid: String(chat).endsWith('@lid'),
    occurred_at_seconds: Math.floor(occurred),
  };
}

/** Lookup results must bind the requested LID exactly; never strip @lid.
 * @param {any} validated @param {any} mapping @param {any} config @returns {any}
 */
export function convertWahaEvent(validated, mapping, config) {
  const {
    waha: event,
    chat,
    needs_lid: needsLid,
    occurred_at_seconds: timestamp,
  } = validated;
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@(?:c\.us|s\.whatsapp\.net)$/.exec(String(value ?? ''))?.[1] ??
    null;
  const phone =
    needsLid && mapping?.lid === chat
      ? pn(mapping.pn)
      : !needsLid
        ? pn(chat)
        : null;
  if (!phone || phone === config.ownNumber)
    throw new Error('WAHA_IDENTITY_UNRESOLVED');
  const payload = event.payload;
  const metadata = { phone_number_id: config.ownNumber };
  if (event.event === 'message.ack') {
    /** @type {Record<string, string>} */
    const statuses = {
      '-1': 'failed',
      2: 'delivered',
      3: 'read',
      4: 'read',
    };
    return {
      metadata,
      statuses: [
        {
          id: payload.id,
          status: statuses[payload.ack],
          recipient_id: phone,
          timestamp: String(timestamp),
        },
      ],
    };
  }
  /** @type {any} */
  const message = {
    id: payload.id,
    from: phone,
    timestamp: String(timestamp),
    type: 'text',
    text: { body: String(payload.body ?? '').slice(0, 4096) },
  };
  if (payload.replyTo?.id)
    message.context = { id: String(payload.replyTo.id).slice(0, 512) };
  let mediaUrl = '';
  if (payload.hasMedia === true) {
    const mime = String(payload.media?.mimetype ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const type =
      (payload.type ?? payload._data?.type) === 'sticker'
        ? 'sticker'
        : mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('audio/')
            ? 'audio'
            : mime.startsWith('video/')
              ? 'video'
              : 'document';
    message.type = type;
    delete message.text;
    message[type] = {
      id: payload.id,
      mime_type: mime,
      caption: String(payload.body ?? '').slice(0, 4096),
      filename: String(payload.media?.filename ?? '').slice(0, 255),
    };
    mediaUrl = String(payload.media?.url ?? '');
  } else if (payload.location) {
    message.type = 'location';
    message.location = {
      latitude: payload.location.latitude,
      longitude: payload.location.longitude,
      name: payload.location.name ?? '',
      address: payload.location.address ?? '',
    };
    delete message.text;
  } else if (Array.isArray(payload.vCards) && payload.vCards.length) {
    // A vCard is not a verified identity link. Keep it as content for the seller.
    message.text.body = '[Contato compartilhado]';
  } else if (
    [
      'reaction',
      'revoked',
      'e2e_notification',
      'notification_template',
      'protocol',
    ].includes(payload.type ?? payload._data?.type)
  ) {
    message.type = 'system';
  } else if (!message.text.body.trim()) {
    // An unsupported empty event is handed to a person, not passed to the
    // model as a fictional blank customer message.
    message.type = 'unsupported';
  }
  return {
    metadata,
    contacts: [
      {
        wa_id: phone,
        profile: {
          name: String(
            payload.notifyName ?? payload._data?.notifyName ?? '',
          ).slice(0, 200),
        },
      },
    ],
    messages: [message],
    __waha_media_url: mediaUrl,
  };
}

/** Credential-bearing downloads may only address the configured WAHA files.
 * @param {string} value @param {string} baseUrl
 */
export function validateWahaMediaUrl(value, baseUrl) {
  const prefix = baseUrl + '/api/files/';
  if (typeof value !== 'string' || !value.startsWith(prefix))
    throw new Error('WAHA_MEDIA_URL_INVALID');
  const relative = value.slice(prefix.length);
  if (
    !relative ||
    relative.length > 1024 ||
    /[?#\\\x00-\x20]/.test(relative) ||
    /%(?:2e|2f|5c|00)/i.test(relative)
  )
    throw new Error('WAHA_MEDIA_URL_INVALID');
  if (
    relative
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          !/^[a-zA-Z0-9_@.%+-]+$/.test(part),
      )
  )
    throw new Error('WAHA_MEDIA_URL_INVALID');
  return value;
}

/** WAHA versions return a normalized ID or the WEBJS MessageId object.
 * Only the full serialized ID can be matched to later delivery events.
 * @param {any} response @returns {string}
 */
export function getWahaMessageId(response) {
  const id =
    typeof response?.id === 'string' ? response.id : response?.id?._serialized;
  if (typeof id !== 'string' || !id || id.length > 512)
    throw new Error('WAHA_SEND_OUTCOME_UNKNOWN');
  return id;
}

/** @param {string} name @param {number[]} position @param {string} jsCode @param {any} [extra] @returns {any} */
function codeNode(name, position, jsCode, extra = {}) {
  return {
    id: createHash('sha256').update(name).digest('hex').slice(0, 32),
    name,
    position,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForEachItem', jsCode },
    ...extra,
  };
}

/** @param {string} name */
function edge(name) {
  return { node: name, type: 'main', index: 0 };
}

/** @param {string|undefined} id @param {string} name */
function credential(id, name) {
  return id ? { id, name } : { name };
}

function requestOptions(timeout = 30000) {
  return {
    timeout,
    redirect: { redirect: { followRedirects: false } },
    response: { response: { responseFormat: 'json' } },
  };
}

/** @param {any} node @param {any} parameters @param {any} apiCredential */
function asHttp(node, parameters, apiCredential) {
  node.type = 'n8n-nodes-base.httpRequest';
  node.typeVersion = 4.5;
  node.retryOnFail = false;
  delete node.maxTries;
  delete node.waitBetweenTries;
  node.credentials = { httpHeaderAuth: apiCredential };
  node.parameters = {
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    ...parameters,
  };
}

/** @param {string} expression */
function expressionBody(expression) {
  if (typeof expression !== 'string' || !/^=?\{\{[\s\S]*\}\}$/.test(expression))
    throw new Error('WAHA_SEND_EXPRESSION_MISSING');
  return expression.replace(/^=?\{\{\s*/, '').replace(/\s*\}\}$/, '');
}

/**
 * Adapt a live export, retaining domain nodes, IDs, fences, credentials and
 * site/panel webhook identities. Only WAHA-specific nodes are added.
 * @param {any} source
 * @param {{ownNumber:string, baseUrl?:string, session?:string, apiCredentialId?:string, apiCredentialName?:string, webhookCredentialId?:string, webhookCredentialName?:string, webhookPath?:string, workflowVersion?:string}} options
 */
export function createWahaWorkflow(source, options) {
  if (!/^\d{8,15}$/.test(options?.ownNumber ?? ''))
    throw new Error('WAHA_OWN_NUMBER_REQUIRED');
  const config = {
    ownNumber: options.ownNumber,
    baseUrl: options.baseUrl ?? 'http://schedule_silmer-waha:3000',
    session: options.session ?? 'default',
  };
  const parsed = new URL(config.baseUrl);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('WAHA_BASE_URL_INVALID');
  config.baseUrl = config.baseUrl.replace(/\/$/, '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.session))
    throw new Error('WAHA_SESSION_INVALID');
  const workflow = structuredClone(source);
  if (!Array.isArray(workflow.nodes) || !workflow.connections)
    throw new Error('WAHA_WORKFLOW_INVALID');
  if (
    workflow.settings?.executionOrder &&
    workflow.settings.executionOrder !== 'v1'
  )
    throw new Error('WAHA_EXECUTION_ORDER_UNSUPPORTED');
  if (workflow.nodes.some((/** @type {any} */ node) => node.name === VALIDATE))
    throw new Error('WAHA_WORKFLOW_ALREADY_ADAPTED');
  const find = (/** @type {string} */ name) => {
    const node = workflow.nodes.find(
      (/** @type {any} */ item) => item.name === name,
    );
    if (!node) throw new Error('WAHA_NODE_MISSING: ' + name);
    return node;
  };
  const apiCredential = credential(
    options.apiCredentialId,
    options.apiCredentialName ?? 'Silmer WAHA API',
  );
  const webhookCredential = credential(
    options.webhookCredentialId,
    options.webhookCredentialName ?? 'Silmer WAHA para n8n',
  );
  const trigger = find(TRIGGER);
  trigger.type = 'n8n-nodes-base.webhook';
  trigger.typeVersion = 2.1;
  trigger.parameters = {
    httpMethod: 'POST',
    path: options.webhookPath ?? 'silmer/waha-events',
    authentication: 'headerAuth',
    responseMode: 'responseNode',
    options: {},
  };
  trigger.credentials = { httpHeaderAuth: webhookCredential };
  trigger.disabled = false;
  const configured = JSON.stringify(config);
  const guard = codeNode(
    VALIDATE,
    [-2660, -300],
    `const validate = ${validateWahaEvent.toString()};\nconst checked = validate($json, ${configured});\nreturn checked ? { json: checked } : [];`,
  );
  // Filtering requires run-once-for-all-items: returning [] is a deliberate
  // no-op for echoes, group chats, statuses and events outside this adapter.
  guard.parameters.mode = 'runOnceForAllItems';
  guard.parameters.jsCode = `const validate = ${validateWahaEvent.toString()};\nreturn $input.all().map((item, index) => { const checked = validate(item.json, ${configured}); return checked ? { json: checked, pairedItem: { item: index } } : null; }).filter(Boolean);`;
  const lidSwitch = {
    id: createHash('sha256').update(NEEDS_LID).digest('hex').slice(0, 32),
    name: NEEDS_LID,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    position: [-2460, -300],
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
            id: 'waha-lid-required',
            leftValue: '={{ $json.needs_lid }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };
  const lookup = codeNode(LOOKUP_LID, [-2260, -450], '');
  asHttp(
    lookup,
    {
      method: 'GET',
      url: `={{ ${JSON.stringify(config.baseUrl + '/api/' + encodeURIComponent(config.session) + '/lids/')} + encodeURIComponent($json.chat) }}`,
      options: requestOptions(10000),
    },
    apiCredential,
  );
  const converter = codeNode(
    CONVERT,
    [-2060, -300],
    `const convert = ${convertWahaEvent.toString()};\nconst input = $('${VALIDATE}').item.json;\nreturn { json: convert(input, input.needs_lid ? $json : null, ${configured}) };`,
  );
  workflow.nodes.push(guard, lidSwitch, lookup, converter);
  workflow.connections[TRIGGER] = { main: [[edge(VALIDATE)]] };
  workflow.connections[VALIDATE] = { main: [[edge(NEEDS_LID)]] };
  workflow.connections[NEEDS_LID] = {
    main: [[edge(LOOKUP_LID)], [edge(CONVERT)]],
  };
  workflow.connections[LOOKUP_LID] = { main: [[edge(CONVERT)]] };
  workflow.connections[CONVERT] = { main: [[edge(NORMALIZE)]] };
  // WAHA-01D / ORC-08: acknowledge transport only after the CRM has durably
  // accepted the message/status. v1 executes topmost branches first, so the
  // ACK branch is both first in the connection list and above the journey.
  // The inbound CRM node is shared by Site Chat. Its ACK branch must be a
  // no-op there, otherwise Respond to Webhook could preempt the chat reply.
  const ackY =
    Math.min(
      ...workflow.nodes.map(
        (/** @type {any} */ node) => node.position?.[1] ?? 0,
      ),
    ) - 200;
  const ackGate = codeNode(
    ACK_GATE,
    [-1700, ackY],
    `if ($('${NORMALIZE}').item.json.channel !== 'whatsapp') return [];\nreturn $input.all();`,
  );
  ackGate.parameters.mode = 'runOnceForAllItems';
  const ackNode = {
    id: createHash('sha256').update(ACK).digest('hex').slice(0, 32),
    name: ACK,
    position: [-1500, ackY],
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    parameters: {
      respondWith: 'json',
      responseBody: '{"accepted":true}',
      options: { responseCode: 202 },
    },
  };
  for (const name of [
    'CRM - Registrar inbound (MVP)',
    'CRM - Registrar status de entrega (MVP)',
  ]) {
    find(name);
    const original = workflow.connections[name] ?? {};
    const main = original.main ?? [];
    main[0] = [edge(ACK_GATE), ...(main[0] ?? [])];
    workflow.connections[name] = { ...original, main };
  }
  workflow.connections[ACK_GATE] = { main: [[edge(ACK)]] };
  workflow.nodes.push(ackGate, ackNode);
  const normalizer = find(NORMALIZE);
  if (!normalizer.parameters.jsCode.includes("media_id: media?.id ?? '',"))
    throw new Error('WAHA_NORMALIZER_UNSUPPORTED');
  normalizer.parameters.jsCode = normalizer.parameters.jsCode.replace(
    "media_id: media?.id ?? '',",
    "media_id: media?.id ?? '',\n  waha_media_url: root.__waha_media_url ?? '',",
  );

  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const node = find(name);
    const recipient = expressionBody(node.parameters.recipientPhoneNumber);
    const text = expressionBody(node.parameters.textBody);
    asHttp(
      node,
      {
        method: 'POST',
        url: config.baseUrl + '/api/sendText',
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: `={{ (() => { const to = String(${recipient}); if (!/^\\d{8,15}$/.test(to)) throw new Error('WAHA_RECIPIENT_INVALID'); return { session: ${JSON.stringify(config.session)}, chatId: to + '@c.us', text: String(${text}), linkPreview: false }; })() }}`,
        options: requestOptions(),
      },
      apiCredential,
    );
    node.onError = 'continueErrorOutput';
    const validationName =
      'WAHA - Validar envio ' + name.replace('WhatsApp - Enviar ', '');
    const validator = codeNode(
      validationName,
      [(node.position?.[0] ?? 0) + 110, (node.position?.[1] ?? 0) + 65],
      `const getId = ${getWahaMessageId.toString()};\nconst id = getId($json); return { json: { messages: [{ id }], id } };`,
      { onError: 'continueErrorOutput' },
    );
    const prior = structuredClone(workflow.connections[name]?.main ?? []);
    if (!prior[0]?.length || !prior[1]?.length)
      throw new Error('WAHA_SEND_FAILURE_PATH_MISSING: ' + name);
    workflow.connections[name].main[0] = [edge(validationName)];
    workflow.connections[validationName] = { main: [prior[0], prior[1]] };
    workflow.nodes.push(validator);
  }

  const mediaQuery = find('WhatsApp - Consultar mídia (MVP)');
  const mediaCode = `const validateUrl = ${validateWahaMediaUrl.toString()};\nreturn { json: { url: validateUrl($('${NORMALIZE}').item.json.waha_media_url, ${JSON.stringify(config.baseUrl)}) } };`;
  Object.assign(mediaQuery, {
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForEachItem', jsCode: mediaCode },
    retryOnFail: false,
  });
  delete mediaQuery.credentials;
  delete mediaQuery.maxTries;
  delete mediaQuery.waitBetweenTries;
  const download = find('WhatsApp - Baixar mídia (MVP)');
  asHttp(
    download,
    {
      method: 'GET',
      url: '={{ $json.url }}',
      options: {
        ...requestOptions(30000),
        response: {
          response: { responseFormat: 'file', outputPropertyName: 'data' },
        },
      },
    },
    apiCredential,
  );

  const upload = find(MEDIA_UPLOAD);
  Object.assign(upload, {
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    retryOnFail: false,
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const command = $('${HUMAN_RESERVE}').item.json.command;\nconst bytes = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');\nif (bytes.length !== command.message.size_bytes || !bytes.length || bytes.length > (command.message.type === 'image' ? 5 : 16) * 1024 * 1024) throw new Error('MEDIA_INTEGRITY_MISMATCH');\nreturn { json: { id: command.message.media_id, file: { mimetype: command.message.mime_type, filename: 'attachment.' + ({ image: 'jpg', audio: 'ogg', video: 'mp4' }[command.message.type] ?? 'bin'), data: bytes.toString('base64') } } };`,
    },
  });
  delete upload.credentials;
  const prepare = find(MEDIA_PREPARE);
  prepare.parameters.jsCode = `const command = $('${HUMAN_RESERVE}').item.json.command;\nconst expected = command.message;\nif ($json.valid !== true || $json.media_id !== expected.media_id || $json.type !== expected.type || $json.sha256 !== expected.sha256 || $json.mime_type !== expected.mime_type || $json.size_bytes !== expected.size_bytes) throw new Error('MEDIA_PREFLIGHT_REJECTED');\nconst prepared = $('${MEDIA_UPLOAD}').item.json;\nif (prepared.id !== expected.media_id || typeof prepared.file?.data !== 'string' || prepared.file.mimetype !== expected.mime_type) throw new Error('MEDIA_PREFLIGHT_REJECTED');\nif (!/^\\d{8,15}$/.test(String(command.to))) throw new Error('WAHA_RECIPIENT_INVALID');\nconst endpoint = { image: 'sendImage', audio: 'sendVoice', video: 'sendVideo' }[expected.type];\nif (!endpoint) throw new Error('WAHA_MEDIA_TYPE_UNSUPPORTED');\nreturn { json: { waha_endpoint: endpoint, waha_message: { session: ${JSON.stringify(config.session)}, chatId: command.to + '@c.us', file: prepared.file, ...(expected.type !== 'audio' && expected.caption ? { caption: expected.caption } : {}), ...(expected.type === 'audio' || expected.type === 'video' ? { convert: true } : {}) } } };`;
  asHttp(
    find(MEDIA_SEND),
    {
      method: 'POST',
      url: `={{ (() => { if (!['sendImage','sendVoice','sendVideo'].includes($json.waha_endpoint)) throw new Error('WAHA_MEDIA_TYPE_UNSUPPORTED'); return ${JSON.stringify(config.baseUrl + '/api/')} + $json.waha_endpoint; })() }}`,
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ $json.waha_message }}',
      options: requestOptions(60000),
    },
    apiCredential,
  );
  find('Validar resposta do envio de midia (MVP)').parameters.jsCode =
    `const getId = ${getWahaMessageId.toString()};\nconst id = getId($json); return { json: { messages: [{ id }] } };`;

  const version = options.workflowVersion ?? 'waha-webjs-1';
  for (const node of workflow.nodes) {
    if (node.parameters?.jsCode)
      node.parameters.jsCode = node.parameters.jsCode.replaceAll(
        'META_SEND_OUTCOME_UNKNOWN',
        'WAHA_SEND_OUTCOME_UNKNOWN',
      );
    for (const header of node.parameters?.headerParameters?.parameters ?? []) {
      if (header.name === 'X-Silmer-Workflow-Version') header.value = version;
    }
  }
  workflow.settings = {
    ...workflow.settings,
    executionOrder: 'v1',
    saveExecutionProgress: false,
    saveManualExecutions: false,
    saveDataErrorExecution: 'none',
    saveDataSuccessExecution: 'none',
  };
  // n8n defaults a workflow containing Error Trigger to itself. Make this
  // explicit only when a persisted workflow ID is available and no other
  // handler was configured; retain its inherited sanitized failure branch.
  if (
    (workflow.settings.errorWorkflow === undefined ||
      workflow.settings.errorWorkflow === null ||
      workflow.settings.errorWorkflow === '') &&
    typeof workflow.id === 'string' &&
    workflow.id.trim() &&
    workflow.nodes.some(
      (/** @type {any} */ node) => node.type === 'n8n-nodes-base.errorTrigger',
    )
  )
    workflow.settings.errorWorkflow = workflow.id;
  delete workflow.pinData;
  workflow.active = false;
  return workflow;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output, configPath] = process.argv.slice(2);
  if (!input || !output || !configPath)
    throw new Error(
      'Usage: node create-waha-workflow.mjs source.json output.json config.json',
    );
  const result = createWahaWorkflow(
    JSON.parse(await readFile(input, 'utf8')),
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      adapted: true,
      nodes: result.nodes.length,
      active: result.active,
    }),
  );
}
