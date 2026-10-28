import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createWahaWorkflow } from './create-waha-workflow.mjs';

const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const VALIDATE = 'WPPConnect - Validar origem (MVP)';
const CONVERT = 'WPPConnect - Montar evento WhatsApp (MVP)';
const LOOKUP = 'WPPConnect - Consultar identidade (MVP)';
const HUMAN_RESERVE = 'Preparar reserva de envio humano (MVP)';
const MEDIA_UPLOAD = 'Meta - Upload midia humana (MVP)';
const MEDIA_PREPARE = 'Preparar mensagem Meta de midia (MVP)';
const MEDIA_SEND = 'Meta - Enviar midia humana (MVP)';

/** WPP-01 / ORC-01..08 / MSG-01..04.
 * Requires the operator's authenticated webhook patch, not stock webhooks.
 * The patch overwrites __wpp_own_jid and __wpp_received_at after the payload
 * spread, before bounded retries. No message body is logged or persisted here.
 * Primary contracts: wppconnect-server v2.10.69 functions.ts, messageController,
 * sessionController; wppconnect v2.3.6 sender.layer/model/{message,ack};
 * @wppconnect/wa-js v4.7.2 contact.getPnLidEntry.
 * @param {any} root @param {any} config @returns {any}
 */
export function validateWppconnectEvent(root, config) {
  // Raw WPP messages themselves contain a text `body`; only unwrap the
  // n8n HTTP envelope when that body is an object.
  const event = root?.body && typeof root.body === 'object' ? root.body : root;
  if (!event || event.session !== config.session)
    throw new Error('WPP_SOURCE_MISMATCH');
  if (!['onmessage', 'onack'].includes(event.event)) return null;
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@(?:c\.us|s\.whatsapp\.net)$/.exec(String(value ?? ''))?.[1] ??
    null;
  if (pn(event.__wpp_own_jid) !== config.ownNumber)
    throw new Error('WPP_ACCOUNT_MISMATCH');
  const received = event.__wpp_received_at;
  if (
    typeof received !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(received) ||
    !Number.isFinite(Date.parse(received)) ||
    Date.parse(received) <= 0 ||
    new Date(received).toISOString() !== received
  )
    throw new Error('WPP_RECEIPT_TIMESTAMP_INVALID');
  const ack = event.event === 'onack';
  const id = typeof event.id === 'string' ? event.id : event.id?._serialized;
  const match = /^(true|false)_([^_]+)_(.+)$/.exec(String(id ?? ''));
  if (
    typeof id !== 'string' ||
    id.length > 512 ||
    !match ||
    /[\x00-\x20]/.test(id)
  )
    throw new Error('WPP_MESSAGE_ID_INVALID');
  // ACK1 is already represented by the synchronous send with command_id.
  if (ack && ![-1, 2, 3, 4].includes(event.ack)) return null;
  if (
    ack
      ? match[1] !== 'true' ||
        event.id?.fromMe === false ||
        event.fromMe === false
      : event.fromMe !== false || match[1] !== 'false'
  )
    return null;
  if (
    event.isGroupMsg === true ||
    event.isNotification === true ||
    event.isPSA === true ||
    event.broadcast === true ||
    event.isMdHistoryMsg === true ||
    event.author ||
    /@(?:g\.us|broadcast|newsletter)$/.test(String(event.from)) ||
    /@(?:g\.us|broadcast|newsletter)$/.test(match[2])
  )
    return null;
  const chat = ack ? match[2] : event.from;
  if (!pn(chat) && !/^\d{1,30}@lid$/.test(String(chat ?? ''))) return null;
  if (pn(chat) === config.ownNumber) return null;
  if (!ack && match[2] !== chat) throw new Error('WPP_MESSAGE_CHAT_MISMATCH');
  if (ack && event.id?.remote) {
    const remote =
      typeof event.id.remote === 'string'
        ? event.id.remote
        : event.id.remote._serialized;
    if (remote !== chat) throw new Error('WPP_MESSAGE_CHAT_MISMATCH');
  }
  // The envelope account is pinned. A supplied PN destination must agree;
  // a migrated account's LID is never interpreted as a phone number.
  if (!ack && pn(event.to) && pn(event.to) !== config.ownNumber)
    throw new Error('WPP_DESTINATION_MISMATCH');
  let seconds = ack
    ? Date.parse(received) / 1000
    : Number(event.timestamp ?? event.t);
  if (seconds > 1e12) seconds /= 1000;
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('WPP_TIMESTAMP_INVALID');
  if (ack)
    return {
      chat,
      needs_lid: String(chat).endsWith('@lid'),
      occurred_at_seconds: Math.floor(seconds),
      event: { event: event.event, id, ack: event.ack },
    };
  // Retain only content needed by the converter. Exclude mediaKey, raw chat,
  // clientUrl, access tokens, thumbnail/base64 bodies and address-book fields.
  const type = String(event.type ?? '');
  const media = [
    'image',
    'audio',
    'ptt',
    'video',
    'document',
    'sticker',
  ].includes(type);
  return {
    chat,
    needs_lid: String(chat).endsWith('@lid'),
    occurred_at_seconds: Math.floor(seconds),
    event: {
      event: event.event,
      id,
      ack: event.ack,
      type,
      body:
        !media && type === 'chat'
          ? String(event.body ?? event.content ?? '').slice(0, 4096)
          : '',
      caption: media ? String(event.caption ?? '').slice(0, 4096) : '',
      mimetype: media
        ? String(event.mimetype ?? '')
            .split(';')[0]
            .trim()
            .toLowerCase()
        : '',
      filename: media ? String(event.filename ?? '').slice(0, 255) : '',
      notifyName: String(
        event.notifyName ?? event.sender?.pushname ?? '',
      ).slice(0, 200),
      quotedMsgId:
        typeof event.quotedMsgId === 'string'
          ? event.quotedMsgId.slice(0, 512)
          : '',
      lat: type === 'location' ? event.lat : undefined,
      lng: type === 'location' ? event.lng : undefined,
      loc:
        type === 'location' ? String(event.loc ?? '').slice(0, 255) : undefined,
    },
  };
}

/** Only the exact provider LID/PN binding is identity evidence.
 * @param {any} validated @param {any} mapping @param {any} config @returns {any}
 */
export function convertWppconnectEvent(validated, mapping, config) {
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@(?:c\.us|s\.whatsapp\.net)$/.exec(String(value ?? ''))?.[1] ??
    null;
  const serialized = (/** @type {any} */ value) =>
    typeof value === 'string' ? value : value?._serialized;
  const phone = validated.needs_lid
    ? serialized(mapping?.lid) === validated.chat
      ? pn(serialized(mapping?.phoneNumber))
      : null
    : pn(validated.chat);
  if (!phone || phone === config.ownNumber)
    throw new Error('WPP_IDENTITY_UNRESOLVED');
  const payload = validated.event;
  const metadata = { phone_number_id: config.ownNumber };
  if (payload.event === 'onack') {
    const statuses = /** @type {Record<string,string>} */ ({
      '-1': 'failed',
      2: 'delivered',
      3: 'read',
      4: 'read',
    });
    return {
      metadata,
      statuses: [
        {
          id: payload.id,
          status: statuses[payload.ack],
          recipient_id: phone,
          timestamp: String(validated.occurred_at_seconds),
        },
      ],
    };
  }
  const message = /** @type {any} */ ({
    id: payload.id,
    from: phone,
    timestamp: String(validated.occurred_at_seconds),
    type: 'text',
    text: { body: payload.body },
  });
  if (payload.quotedMsgId) message.context = { id: payload.quotedMsgId };
  if (
    ['image', 'audio', 'ptt', 'video', 'document', 'sticker'].includes(
      payload.type,
    )
  ) {
    const type = payload.type === 'ptt' ? 'audio' : payload.type;
    message.type = type;
    delete message.text;
    message[type] = {
      id: payload.id,
      mime_type: payload.mimetype,
      caption: payload.caption,
      filename: payload.filename,
    };
  } else if (
    payload.type === 'location' &&
    Number.isFinite(payload.lat) &&
    Number.isFinite(payload.lng) &&
    Math.abs(payload.lat) <= 90 &&
    Math.abs(payload.lng) <= 180
  ) {
    message.type = 'location';
    delete message.text;
    message.location = {
      latitude: payload.lat,
      longitude: payload.lng,
      name: '',
      address: payload.loc ?? '',
    };
  } else if (['vcard', 'multi_vcard'].includes(payload.type)) {
    message.text.body = '[Contato compartilhado]';
  } else if (
    [
      'reaction',
      'revoked',
      'gp2',
      'e2e_notification',
      'notification_template',
      'protocol',
    ].includes(payload.type)
  ) {
    message.type = 'system';
  } else if (payload.type !== 'chat' || !message.text.body.trim()) {
    message.type = 'unsupported';
  }
  return {
    metadata,
    contacts: [{ wa_id: phone, profile: { name: payload.notifyName } }],
    messages: [message],
  };
}

/** Results are arrays because the upstream endpoint supports bulk sending.
 * The adapter issues exactly one recipient and requires exactly one result.
 * A malformed successful HTTP response is unknown, never permission to retry.
 * @param {any} response @returns {string}
 */
export function getWppconnectMessageId(response) {
  if (
    response?.status !== 'success' ||
    !Array.isArray(response.response) ||
    response.response.length !== 1
  )
    throw new Error('WPP_SEND_OUTCOME_UNKNOWN');
  const result = response.response[0];
  const id =
    typeof result?.id === 'string' ? result.id : result?.id?._serialized;
  if (
    result?.erro === true ||
    result?.ack === -1 ||
    typeof id !== 'string' ||
    !/^true_\d{1,30}@(?:c\.us|s\.whatsapp\.net|lid)_[^\s]+$/.test(id) ||
    id.length > 512
  )
    throw new Error('WPP_SEND_OUTCOME_UNKNOWN');
  return id;
}

/** Authenticated bytes only; no remote URL, local path or redirects.
 * @param {any} response @param {any} source @returns {any}
 */
export function decodeWppconnectMedia(response, source) {
  const mime = String(response?.mimetype ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const allowed = /** @type {Record<string,string[]>} */ ({
    image: ['image/jpeg', 'image/png', 'image/webp'],
    audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'],
  });
  const base64 = response?.base64;
  const limit = (source.media_kind === 'image' ? 5 : 16) * 1024 * 1024;
  if (
    !allowed[source.media_kind]?.includes(mime) ||
    mime !== source.media_mime_type ||
    typeof base64 !== 'string' ||
    base64.length === 0 ||
    base64.length > Math.ceil(limit / 3) * 4 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error('WPP_MEDIA_INVALID');
  const bytes = Buffer.from(base64, 'base64');
  if (
    !bytes.length ||
    bytes.length > limit ||
    bytes.toString('base64') !== base64
  )
    throw new Error('WPP_MEDIA_INVALID');
  return {
    json: {},
    binary: {
      data: {
        data: base64,
        mimeType: mime,
        fileName:
          'attachment.' +
          ({
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'audio/ogg': 'ogg',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/wav': 'wav',
            'audio/webm': 'webm',
          }[mime] ?? 'bin'),
      },
    },
  };
}

/** @param {any} source @param {{ownNumber:string,baseUrl?:string,session?:string,apiCredentialId?:string,apiCredentialName?:string,webhookCredentialId?:string,webhookCredentialName?:string,webhookPath?:string,workflowVersion?:string}} options */
export function createWppconnectWorkflow(source, options) {
  if (
    source?.nodes?.some((/** @type {any} */ node) =>
      /^(?:WAHA|WPPConnect) - Validar origem/.test(node.name),
    )
  )
    throw new Error('WPP_WORKFLOW_ALREADY_ADAPTED');
  const config = {
    ownNumber: options?.ownNumber,
    baseUrl: options?.baseUrl ?? 'http://schedule_silmer-wppconnect:21465',
    session: options?.session ?? 'default',
  };
  // Reuse the existing scaffold for original IDs, CRM fences, domain nodes,
  // human/AI unknown branches and durable ACK. Every provider boundary below
  // is replaced; the resulting workflow has no WAHA/Meta transport endpoint.
  const workflow = createWahaWorkflow(source, {
    ...options,
    ...config,
    apiCredentialName: options?.apiCredentialName ?? 'Silmer WPPConnect API',
    webhookCredentialName:
      options?.webhookCredentialName ?? 'Silmer WPPConnect para n8n',
    webhookPath: options?.webhookPath ?? 'silmer/wppconnect-events',
    workflowVersion: options?.workflowVersion ?? 'wppconnect-1',
  });
  config.baseUrl = config.baseUrl.replace(/\/$/, '');
  const rename = (/** @type {string} */ name) =>
    name.replace(/^WAHA - /, 'WPPConnect - ');
  for (const node of workflow.nodes) {
    node.name = rename(node.name);
    if (node.parameters?.jsCode)
      node.parameters.jsCode = node.parameters.jsCode
        .replaceAll('WAHA - ', 'WPPConnect - ')
        .replaceAll('WAHA_SEND_OUTCOME_UNKNOWN', 'WPP_SEND_OUTCOME_UNKNOWN');
    for (const condition of node.parameters?.conditions?.conditions ?? []) {
      if (condition.id === 'waha-lid-required')
        condition.id = 'wpp-lid-required';
    }
  }
  workflow.connections = Object.fromEntries(
    Object.entries(workflow.connections).map(([name, value]) => [
      rename(name),
      JSON.parse(JSON.stringify(value).replaceAll('WAHA - ', 'WPPConnect - ')),
    ]),
  );
  const find = (/** @type {string} */ name) => {
    const node = workflow.nodes.find(
      (/** @type {any} */ item) => item.name === name,
    );
    if (!node) throw new Error('WPP_NODE_MISSING: ' + name);
    return node;
  };
  const configured = JSON.stringify(config);
  find(VALIDATE).parameters.jsCode =
    `const validate = ${validateWppconnectEvent.toString()};\nreturn $input.all().map((item,index) => { const checked = validate(item.json, ${configured}); return checked ? {json:checked,pairedItem:{item:index}} : null; }).filter(Boolean);`;
  find(LOOKUP).parameters.url =
    `={{ ${JSON.stringify(config.baseUrl + '/api/' + config.session + '/contact/pn-lid/')} + encodeURIComponent($json.chat) }}`;
  find(CONVERT).parameters.jsCode =
    `const convert = ${convertWppconnectEvent.toString()};\nconst input = $('${VALIDATE}').item.json;\nreturn {json:convert(input,input.needs_lid ? $json : null,${configured})};`;
  find(NORMALIZE).parameters.jsCode = find(NORMALIZE).parameters.jsCode.replace(
    "\n  waha_media_url: root.__waha_media_url ?? '',",
    '',
  );
  const apiCredential = find(LOOKUP).credentials;
  const reqOptions = (timeout = 30000) => ({
    timeout,
    redirect: { redirect: { followRedirects: false } },
    response: { response: { responseFormat: 'json' } },
  });
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const node = find(name);
    const original = source.nodes.find(
      (/** @type {any} */ item) => item.name === name,
    );
    const expression = (/** @type {string} */ value) =>
      value.replace(/^=?\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const humanPrefix =
      name === 'WhatsApp - Enviar texto humano (MVP)'
        ? ".replace(/^\\+/, '')"
        : '';
    node.parameters.url =
      config.baseUrl + '/api/' + config.session + '/send-message';
    node.parameters.jsonBody = `={{ (() => { const to=String(${expression(original.parameters.recipientPhoneNumber)})${humanPrefix}; if (!/^\\d{8,15}$/.test(to)) throw new Error('WPP_RECIPIENT_INVALID'); return {phone:to+'@c.us',isGroup:false,isNewsletter:false,isLid:false,message:String(${expression(original.parameters.textBody)}),options:{linkPreview:false}}; })() }}`;
    find(
      'WPPConnect - Validar envio ' + name.replace('WhatsApp - Enviar ', ''),
    ).parameters.jsCode =
      `const getId = ${getWppconnectMessageId.toString()};\nconst id = getId($json); return {json:{messages:[{id}],id}};`;
  }
  const query = find('WhatsApp - Consultar mídia (MVP)');
  query.type = 'n8n-nodes-base.httpRequest';
  query.typeVersion = 4.5;
  query.credentials = apiCredential;
  query.parameters = {
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    method: 'GET',
    url: `={{ ${JSON.stringify(config.baseUrl + '/api/' + config.session + '/get-media-by-message/')} + encodeURIComponent($('${NORMALIZE}').item.json.media_id) }}`,
    options: reqOptions(),
  };
  const download = find('WhatsApp - Baixar mídia (MVP)');
  download.type = 'n8n-nodes-base.code';
  download.typeVersion = 2;
  delete download.credentials;
  download.parameters = {
    mode: 'runOnceForEachItem',
    jsCode: `const decode = ${decodeWppconnectMedia.toString()};\nreturn decode($json, $('${NORMALIZE}').item.json);`,
  };
  const prepare = find(MEDIA_PREPARE);
  prepare.parameters.jsCode = `const command=$('${HUMAN_RESERVE}').item.json.command;\nconst expected=command.message;\nif ($json.valid!==true || $json.media_id!==expected.media_id || $json.type!==expected.type || $json.sha256!==expected.sha256 || $json.mime_type!==expected.mime_type || $json.size_bytes!==expected.size_bytes) throw new Error('MEDIA_PREFLIGHT_REJECTED');\nconst prepared=$('${MEDIA_UPLOAD}').item.json;\nif (prepared.id!==expected.media_id || typeof prepared.file?.data!=='string' || prepared.file.mimetype!==expected.mime_type) throw new Error('MEDIA_PREFLIGHT_REJECTED');\nconst to = String(command.to).replace(/^\\+/, '');\nif (!/^\\d{8,15}$/.test(to)) throw new Error('WPP_RECIPIENT_INVALID');\nif (!['image','audio','video'].includes(expected.type)) throw new Error('WPP_MEDIA_TYPE_UNSUPPORTED');\nconst file='data:'+prepared.file.mimetype+';base64,'+prepared.file.data;\nconst recipient={phone:to+'@c.us',isGroup:false,isNewsletter:false,isLid:false};\nreturn {json:{wpp_endpoint:expected.type==='audio'?'send-voice-base64':'send-file-base64',wpp_message:expected.type==='audio'?{...recipient,base64Ptt:file}:{...recipient,base64:file,filename:prepared.file.filename,caption:expected.caption??'',options:{type:expected.type}}}};`;
  const send = find(MEDIA_SEND);
  send.parameters.url = `={{ (()=>{if (!['send-file-base64','send-voice-base64'].includes($json.wpp_endpoint)) throw new Error('WPP_MEDIA_TYPE_UNSUPPORTED'); return ${JSON.stringify(config.baseUrl + '/api/' + config.session + '/')}+$json.wpp_endpoint;})() }}`;
  send.parameters.jsonBody = '={{ $json.wpp_message }}';
  find('Validar resposta do envio de midia (MVP)').parameters.jsCode =
    `const getId = ${getWppconnectMessageId.toString()};\nconst id=getId($json);return {json:{messages:[{id}]}};`;
  return workflow;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output, configPath] = process.argv.slice(2);
  if (!input || !output || !configPath)
    throw new Error(
      'Usage: node create-wppconnect-workflow.mjs source.json output.json config.json',
    );
  const result = createWppconnectWorkflow(
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
