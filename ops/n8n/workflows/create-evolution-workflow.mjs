import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { synchronizeOrderAssistanceMedia } from '../patch-order-assistance.mjs';
import { patchEvolutionRecipientPreflight } from '../evolution-recipient-preflight.mjs';

import { createWppconnectWorkflow } from './create-wppconnect-workflow.mjs';

const VALIDATE = 'Evolution - Validar origem (MVP)';
const LOOKUP = 'Evolution - Consultar identidade (MVP)';
const CONVERT = 'Evolution - Montar evento WhatsApp (MVP)';
const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const INBOUND = 'CRM - Registrar inbound (MVP)';
const HUMAN_RESERVE = 'Preparar reserva de envio humano (MVP)';
const MEDIA_UPLOAD = 'Evolution - Preparar bytes humanos (MVP)';
const MEDIA_PREPARE = 'Preparar mensagem Evolution de midia (MVP)';
const MEDIA_SEND = 'Evolution - Enviar midia humana (MVP)';

export const EVOLUTION_IDENTITY_LOOKUP_BODY =
  "={{ ({ where: { key: $json.event?.kind === 'ack' ? { id: $json.id, fromMe: true } : { id: $json.id, remoteJid: $json.chat } }, offset: 2, page: 1 }) }}";

/** The transport adapter must retain the source journey's measurable version.
 * AGENTE-OBS-03: one inbound node and one literal version are authoritative;
 * never replace an unknown or ambiguous release with a transport label.
 * @param {any} source @returns {string}
 */
function sourceWorkflowVersion(source) {
  const inbound = source?.nodes?.filter(
    (/** @type {any} */ node) => node.name === INBOUND,
  );
  if (!inbound?.length) throw new Error('EVOLUTION_WORKFLOW_VERSION_REQUIRED');
  if (inbound.length !== 1)
    throw new Error('EVOLUTION_WORKFLOW_VERSION_AMBIGUOUS');
  const versions = (
    inbound[0].parameters?.headerParameters?.parameters ?? []
  ).filter(
    (/** @type {any} */ header) =>
      String(header.name).toLowerCase() === 'x-silmer-workflow-version',
  );
  if (!versions.length) throw new Error('EVOLUTION_WORKFLOW_VERSION_REQUIRED');
  if (versions.length !== 1)
    throw new Error('EVOLUTION_WORKFLOW_VERSION_AMBIGUOUS');
  const version = versions[0].value;
  if (typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(version))
    throw new Error('EVOLUTION_WORKFLOW_VERSION_INVALID');
  return version;
}

/** EVOL-01 / ORC-01..08 / INB-01 / MSG-01..04.
 * Contract: Evolution API tag 2.3.7, channel.service.ts sendDataWebhook,
 * webhook.controller.ts emit, whatsapp.baileys.service.ts messages.upsert/
 * messages.update/prepareMessage/getBase64FromMediaMessage, sendMessage.dto.ts.
 * Configure TZ=UTC, AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false,
 * webhook.base64=false, byEvents=false; only MESSAGES_UPSERT/MESSAGES_UPDATE.
 * Header authentication is enforced by the n8n Webhook before this code.
 * @param {any} root @param {any} config @returns {any}
 */
export function validateEvolutionEvent(root, config) {
  const event = root?.body && typeof root.body === 'object' ? root.body : root;
  if (!event || event.instance !== config.session)
    throw new Error('EVOLUTION_SOURCE_MISMATCH');
  if (!['messages.upsert', 'messages.update'].includes(event.event))
    return null;
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@s\.whatsapp\.net$/.exec(String(value ?? ''))?.[1] ?? null;
  if (pn(event.sender) !== config.ownNumber)
    throw new Error('EVOLUTION_ACCOUNT_MISMATCH');
  if (
    typeof event.date_time !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.date_time) ||
    !Number.isFinite(Date.parse(event.date_time)) ||
    Date.parse(event.date_time) <= 0 ||
    new Date(event.date_time).toISOString() !== event.date_time
  )
    throw new Error('EVOLUTION_RECEIPT_TIMESTAMP_INVALID');
  const payload = event.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('EVOLUTION_PAYLOAD_INVALID');
  const ack = event.event === 'messages.update';
  const key = ack ? payload : payload.key;
  if (!key || typeof key !== 'object') throw new Error('EVOLUTION_KEY_INVALID');
  if (ack ? key.fromMe !== true : key.fromMe !== false) return null;
  const chat = key.remoteJid;
  if (
    key.participant ||
    key.participantAlt ||
    /@(?:g\.us|broadcast|newsletter)$/.test(String(chat))
  )
    return null;
  if (!pn(chat) && !/^\d{1,30}@lid$/.test(String(chat ?? ''))) return null;
  if (pn(chat) === config.ownNumber) return null;
  const id = ack ? key.keyId : key.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(id))
    throw new Error('EVOLUTION_MESSAGE_ID_INVALID');
  if (ack && !['ERROR', 'DELIVERY_ACK', 'READ', 'PLAYED'].includes(key.status))
    return null; // SERVER_ACK is represented once by the reserved HTTP result.
  const alternate = key.remoteJidAlt;
  if (alternate && !pn(alternate) && !/^\d{1,30}@lid$/.test(String(alternate)))
    throw new Error('EVOLUTION_IDENTITY_UNRESOLVED');
  let seconds = ack
    ? Date.parse(event.date_time) / 1000
    : payload.messageTimestamp;
  if (seconds > 1e12) seconds /= 1000;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
    throw new Error('EVOLUTION_TIMESTAMP_INVALID');
  const base = {
    chat,
    id,
    needs_lid: String(chat).endsWith('@lid') && !pn(alternate),
    provider_phone: String(chat).endsWith('@lid') ? pn(alternate) : pn(chat),
    occurred_at_seconds: Math.floor(seconds),
  };
  if (ack) return { ...base, event: { kind: 'ack', status: key.status } };
  // No mediaKey, remote URLs, thumbnail/base64, API keys or address-book objects
  // escape this boundary. Download by stored key through the authenticated API.
  let message = payload.message ?? {};
  for (let depth = 0; depth < 3; depth++) {
    const wrapper =
      message.ephemeralMessage ??
      message.viewOnceMessage ??
      message.viewOnceMessageV2 ??
      message.documentWithCaptionMessage;
    if (!wrapper?.message) break;
    message = wrapper.message;
  }
  const mediaKey = [
    'imageMessage',
    'audioMessage',
    'videoMessage',
    'documentMessage',
    'stickerMessage',
  ].find((name) => message[name]);
  const media = mediaKey ? message[mediaKey] : null;
  const text = message.conversation ?? message.extendedTextMessage?.text ?? '';
  const quoted =
    payload.contextInfo?.stanzaId ??
    media?.contextInfo?.stanzaId ??
    message.extendedTextMessage?.contextInfo?.stanzaId;
  return {
    ...base,
    event: {
      kind: 'message',
      type: mediaKey
        ? mediaKey.replace('Message', '')
        : message.locationMessage
          ? 'location'
          : message.contactMessage || message.contactsArrayMessage
            ? 'contact'
            : message.reactionMessage || message.protocolMessage
              ? 'system'
              : typeof text === 'string' && text.trim()
                ? 'text'
                : 'unsupported',
      text: typeof text === 'string' ? text.slice(0, 4096) : '',
      caption:
        typeof media?.caption === 'string' ? media.caption.slice(0, 4096) : '',
      mimetype: String(media?.mimetype ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase(),
      filename: String(media?.fileName ?? '').slice(0, 255),
      name: String(payload.pushName ?? '').slice(0, 200),
      quoted:
        typeof quoted === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(quoted)
          ? quoted
          : '',
      location: message.locationMessage
        ? {
            latitude: message.locationMessage.degreesLatitude,
            longitude: message.locationMessage.degreesLongitude,
            address: String(message.locationMessage.address ?? '').slice(
              0,
              255,
            ),
          }
        : null,
    },
  };
}

/** Exact stored provider key is binding evidence; never interpret LID digits.
 * @param {any} validated @param {any} mapping @param {any} config @returns {any}
 */
export function convertEvolutionEvent(validated, mapping, config) {
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@s\.whatsapp\.net$/.exec(String(value ?? ''))?.[1] ?? null;
  let phone = validated.provider_phone;
  // OPS-INBOX-ACK-05: correlate a receipt to one stored outbound message;
  // this never establishes an inbound LID identity or a reusable phone alias.
  if (validated.needs_lid) {
    const records = mapping?.messages?.records;
    phone = null;
    if (validated.event?.kind === 'ack') {
      // Count every same-ID record before checking direction or identity. A
      // duplicate ID is ambiguous even when only one row looks usable.
      const matches = Array.isArray(records)
        ? records.filter((record) => record?.key?.id === validated.id)
        : [];
      const key = matches.length === 1 ? matches[0]?.key : null;
      if (key?.fromMe === true) {
        if (key.remoteJid === validated.chat) phone = pn(key.remoteJidAlt);
        else if (pn(key.remoteJid)) {
          const alternate = key.remoteJidAlt;
          if (
            alternate === undefined ||
            alternate === null ||
            alternate === '' ||
            alternate === validated.chat
          )
            phone = pn(key.remoteJid);
        }
      }
    } else {
      const matches = Array.isArray(records)
        ? records.filter(
            (record) =>
              record?.key?.id === validated.id &&
              record?.key?.remoteJid === validated.chat &&
              record?.key?.fromMe === false &&
              pn(record?.key?.remoteJidAlt),
          )
        : [];
      phone = matches.length === 1 ? pn(matches[0].key.remoteJidAlt) : null;
    }
  }
  if (!phone || phone === config.ownNumber)
    throw new Error('EVOLUTION_IDENTITY_UNRESOLVED');
  const payload = validated.event;
  const metadata = { phone_number_id: config.ownNumber };
  if (payload.kind === 'ack')
    return {
      metadata,
      statuses: [
        {
          id: validated.id,
          status: /** @type {Record<string,string>} */ ({
            ERROR: 'failed',
            DELIVERY_ACK: 'delivered',
            READ: 'read',
            PLAYED: 'read',
          })[payload.status],
          recipient_id: phone,
          timestamp: String(validated.occurred_at_seconds),
        },
      ],
    };
  const message = /** @type {any} */ ({
    id: validated.id,
    from: phone,
    timestamp: String(validated.occurred_at_seconds),
    type: payload.type,
  });
  if (payload.quoted) message.context = { id: payload.quoted };
  if (payload.type === 'text') message.text = { body: payload.text };
  else if (
    ['image', 'audio', 'video', 'document', 'sticker'].includes(payload.type)
  )
    message[payload.type] = {
      id: validated.id,
      mime_type: payload.mimetype,
      caption: payload.caption,
      filename: payload.filename,
    };
  else if (payload.type === 'contact') {
    message.type = 'text';
    message.text = { body: '[Contato compartilhado]' };
  } else if (payload.type === 'location') {
    const loc = payload.location;
    if (
      Number.isFinite(loc?.latitude) &&
      Math.abs(loc.latitude) <= 90 &&
      Number.isFinite(loc?.longitude) &&
      Math.abs(loc.longitude) <= 180
    )
      message.location = { ...loc, name: '' };
    else message.type = 'unsupported';
  }
  return {
    metadata,
    contacts: [{ wa_id: phone, profile: { name: payload.name } }],
    messages: [message],
  };
}

/** HTTP success without a valid outbound provider key has unknown outcome.
 * @param {any} response @returns {string}
 */
export function getEvolutionMessageId(response) {
  if (
    response?.key?.fromMe !== true ||
    !/^\d{8,15}@s\.whatsapp\.net$/.test(String(response.key.remoteJid ?? '')) ||
    typeof response.key.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(response.key.id) ||
    response.status === 'ERROR'
  )
    throw new Error('EVOLUTION_SEND_OUTCOME_UNKNOWN');
  return response.key.id;
}

/** Decode only fetched bytes matching the original content metadata.
 * @param {any} response @param {any} source @returns {any}
 */
export function decodeEvolutionMedia(response, source) {
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
    !base64.length ||
    base64.length > Math.ceil(limit / 3) * 4 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error('EVOLUTION_MEDIA_INVALID');
  const bytes = Buffer.from(base64, 'base64');
  if (
    !bytes.length ||
    bytes.length > limit ||
    bytes.toString('base64') !== base64
  )
    throw new Error('EVOLUTION_MEDIA_INVALID');
  const ext = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  }[mime];
  return {
    json: {},
    binary: {
      data: { data: base64, mimeType: mime, fileName: 'attachment.' + ext },
    },
  };
}

/** Remove only the known WAHA adapter from a current export, using a preserved
 * Meta export for transport parameter definitions. Domain changes, notes, IDs,
 * credentials, image persistence and current successor edges come from current.
 * Neither input is mutated; this never imports or edits the Meta workflow.
 * @param {any} current @param {any} baseline @returns {any}
 */
export function restoreEvolutionTransportSource(current, baseline) {
  if (
    !Array.isArray(current?.nodes) ||
    !current.connections ||
    !Array.isArray(baseline?.nodes) ||
    !baseline.connections
  )
    throw new Error('EVOLUTION_TRANSPORT_BASELINE_REQUIRED');
  if (
    baseline.nodes.some((/** @type {any} */ node) =>
      /^(?:WAHA|WPPConnect|Evolution) - Validar origem/.test(node.name),
    )
  )
    throw new Error('EVOLUTION_TRANSPORT_BASELINE_INVALID');
  const result = structuredClone(current);
  const removedNames = new Set([
    'WAHA - Validar origem (MVP)',
    'WAHA - Resolver LID? (MVP)',
    'WAHA - Consultar identidade (MVP)',
    'WAHA - Montar evento WhatsApp (MVP)',
    'WAHA - Filtrar confirmação durável (MVP)',
    'WAHA - Confirmar recebimento durável (MVP)',
    'WAHA - Validar envio aviso de transferência (MVP)',
    'WAHA - Validar envio resposta da IA (MVP)',
    'WAHA - Validar envio texto humano (MVP)',
  ]);
  for (const name of removedNames)
    if (
      result.nodes.filter((/** @type {any} */ node) => node.name === name)
        .length !== 1
    )
      throw new Error('EVOLUTION_WAHA_ADAPTER_SHAPE_INVALID');
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const validator =
      'WAHA - Validar envio ' + name.replace('WhatsApp - Enviar ', '');
    const next = result.connections[validator]?.main;
    if (
      !next?.[0]?.length ||
      !next?.[1]?.length ||
      result.connections[name]?.main?.[0]?.length !== 1 ||
      result.connections[name].main[0][0].node !== validator
    )
      throw new Error('EVOLUTION_WAHA_SEND_SHAPE_INVALID');
    result.connections[name].main[0] = structuredClone(next[0]);
  }
  const transport = new Set([
    'WhatsApp - Receber eventos (MVP)',
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
    'WhatsApp - Consultar mídia (MVP)',
    'WhatsApp - Baixar mídia (MVP)',
    'Meta - Upload midia humana (MVP)',
    'Preparar mensagem Meta de midia (MVP)',
    'Meta - Enviar midia humana (MVP)',
    'Validar resposta do envio de midia (MVP)',
  ]);
  result.nodes = result.nodes
    .filter((/** @type {any} */ node) => !removedNames.has(node.name))
    .map((/** @type {any} */ node) => {
      if (!transport.has(node.name)) return node;
      const originals = baseline.nodes.filter(
        (/** @type {any} */ original) => original.name === node.name,
      );
      if (originals.length !== 1)
        throw new Error('EVOLUTION_TRANSPORT_BASELINE_NODE_MISSING');
      const restored = structuredClone(originals[0]);
      // Keep the living graph's identities/layout, restore only provider boundary.
      for (const key of [
        'id',
        'name',
        'position',
        'webhookId',
        'notes',
        'notesInFlow',
      ])
        if (node[key] !== undefined) restored[key] = node[key];
      return restored;
    });
  for (const node of result.nodes)
    if (typeof node.parameters?.jsCode === 'string') {
      node.parameters.jsCode = node.parameters.jsCode.replaceAll(
        'WAHA_SEND_OUTCOME_UNKNOWN',
        'META_SEND_OUTCOME_UNKNOWN',
      );
      if (node.name === NORMALIZE)
        node.parameters.jsCode = node.parameters.jsCode.replace(
          /\n\s*waha_media_url: root\.__waha_media_url \?\? '',?/g,
          '',
        );
    }
  result.connections = Object.fromEntries(
    Object.entries(result.connections)
      .filter(([name]) => !removedNames.has(name))
      .map(([name, groups]) => [
        name,
        Object.fromEntries(
          Object.entries(/** @type {any} */ (groups)).map(([kind, outputs]) => [
            kind,
            /** @type {any[]} */ (outputs).map((edges) =>
              edges.filter(
                (/** @type {any} */ edge) => !removedNames.has(edge.node),
              ),
            ),
          ]),
        ),
      ]),
  );
  result.connections['WhatsApp - Receber eventos (MVP)'] = {
    main: [[{ node: NORMALIZE, type: 'main', index: 0 }]],
  };
  return result;
}

/** Produce a separate inactive candidate; the supplied Meta export is immutable.
 * @param {any} source
 * @param {{ownNumber:string,baseUrl?:string,session?:string,apiCredentialId?:string,apiCredentialName?:string,webhookCredentialId?:string,webhookCredentialName?:string,webhookPath?:string,workflowVersion?:string,workflowId?:string,workflowName?:string,transportBaseline?:any}} options
 */
export function createEvolutionWorkflow(source, options) {
  if (
    source?.nodes?.some(
      (/** @type {any} */ node) => node.name === 'WAHA - Validar origem (MVP)',
    )
  ) {
    if (!options?.transportBaseline)
      throw new Error('EVOLUTION_TRANSPORT_BASELINE_REQUIRED');
    source = restoreEvolutionTransportSource(source, options.transportBaseline);
  }
  if (
    source?.nodes?.some((/** @type {any} */ node) =>
      /^(?:WAHA|WPPConnect|Evolution) - Validar origem/.test(node.name),
    )
  )
    throw new Error('EVOLUTION_WORKFLOW_ALREADY_ADAPTED');
  const config = {
    ownNumber: options?.ownNumber,
    baseUrl: options?.baseUrl ?? 'http://schedule_silmer-evolution:8080',
    session: options?.session ?? 'silmer',
  };
  const workflow = createWppconnectWorkflow(source, {
    ...options,
    ...config,
    apiCredentialName: options?.apiCredentialName ?? 'Silmer Evolution API',
    webhookCredentialName:
      options?.webhookCredentialName ?? 'Silmer Evolution para n8n',
    webhookPath: options?.webhookPath ?? 'silmer/evolution-events',
    workflowVersion: options?.workflowVersion ?? sourceWorkflowVersion(source),
  });
  config.baseUrl = config.baseUrl.replace(/\/$/, '');
  const rename = (/** @type {string} */ name) =>
    name
      .replace(/^WPPConnect - /, 'Evolution - ')
      .replace(
        'Meta - Upload midia humana',
        'Evolution - Preparar bytes humanos',
      )
      .replace(
        'Preparar mensagem Meta de midia',
        'Preparar mensagem Evolution de midia',
      )
      .replace('Meta - Enviar midia humana', 'Evolution - Enviar midia humana');
  for (const node of workflow.nodes) {
    node.name = rename(node.name);
    if (node.parameters?.jsCode)
      node.parameters.jsCode = node.parameters.jsCode
        .replaceAll('WPPConnect - ', 'Evolution - ')
        .replaceAll(
          'Meta - Upload midia humana',
          'Evolution - Preparar bytes humanos',
        )
        .replaceAll(
          'Preparar mensagem Meta de midia',
          'Preparar mensagem Evolution de midia',
        )
        .replaceAll(
          'Meta - Enviar midia humana',
          'Evolution - Enviar midia humana',
        )
        .replaceAll(
          'WPP_SEND_OUTCOME_UNKNOWN',
          'EVOLUTION_SEND_OUTCOME_UNKNOWN',
        );
    for (const condition of node.parameters?.conditions?.conditions ?? [])
      if (condition.id === 'wpp-lid-required')
        condition.id = 'evolution-lid-required';
  }
  workflow.connections = Object.fromEntries(
    Object.entries(workflow.connections).map(([name, value]) => [
      rename(name),
      JSON.parse(
        JSON.stringify(value)
          .replaceAll('WPPConnect - ', 'Evolution - ')
          .replaceAll(
            'Meta - Upload midia humana',
            'Evolution - Preparar bytes humanos',
          )
          .replaceAll(
            'Preparar mensagem Meta de midia',
            'Preparar mensagem Evolution de midia',
          )
          .replaceAll(
            'Meta - Enviar midia humana',
            'Evolution - Enviar midia humana',
          ),
      ),
    ]),
  );
  const find = (/** @type {string} */ name) => {
    const node = workflow.nodes.find(
      (/** @type {any} */ item) => item.name === name,
    );
    if (!node) throw new Error('EVOLUTION_NODE_MISSING: ' + name);
    return node;
  };
  const configured = JSON.stringify(config);
  find(VALIDATE).parameters.jsCode =
    `const validate = ${validateEvolutionEvent.toString()};\nreturn $input.all().map((item,index)=>{const checked=validate(item.json,${configured});return checked?{json:checked,pairedItem:{item:index}}:null;}).filter(Boolean);`;
  const lookup = find(LOOKUP);
  lookup.parameters = {
    ...lookup.parameters,
    method: 'POST',
    url: config.baseUrl + '/chat/findMessages/' + config.session,
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    // n8n closes a template at the first unescaped }}; adjacent object
    // braces would truncate the expression before offset/page.
    jsonBody: EVOLUTION_IDENTITY_LOOKUP_BODY,
  };
  find(CONVERT).parameters.jsCode =
    `const convert=${convertEvolutionEvent.toString()};\nconst input=$('${VALIDATE}').item.json;return {json:convert(input,input.needs_lid?$json:null,${configured})};`;
  const apiCredential = lookup.credentials;
  const expression = (/** @type {string} */ value) =>
    value.replace(/^=?\{\{\s*/, '').replace(/\s*\}\}$/, '');
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const node = find(name);
    const original = source.nodes.find(
      (/** @type {any} */ item) => item.name === name,
    );
    const plus =
      name === 'WhatsApp - Enviar texto humano (MVP)'
        ? ".replace(/^\\+/, '')"
        : '';
    node.parameters.url =
      config.baseUrl + '/message/sendText/' + config.session;
    node.parameters.jsonBody = `={{ (()=>{const to=String(${expression(original.parameters.recipientPhoneNumber)})${plus};if(!/^\\d{8,15}$/.test(to))throw new Error('EVOLUTION_RECIPIENT_INVALID');return {number:to,text:String(${expression(original.parameters.textBody)}),linkPreview:false};})() }}`;
    find(
      'Evolution - Validar envio ' + name.replace('WhatsApp - Enviar ', ''),
    ).parameters.jsCode =
      `const getId=${getEvolutionMessageId.toString()};const id=getId($json);return {json:{messages:[{id}],id}};`;
  }
  const query = find('WhatsApp - Consultar mídia (MVP)');
  query.parameters = {
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    method: 'POST',
    url: config.baseUrl + '/chat/getBase64FromMediaMessage/' + config.session,
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody: `={{ ({ message: { key: { id: $('${NORMALIZE}').item.json.media_id } }, convertToMp4: false }) }}`,
    options: {
      timeout: 30000,
      redirect: { redirect: { followRedirects: false } },
      response: { response: { responseFormat: 'json' } },
    },
  };
  query.credentials = apiCredential;
  find('WhatsApp - Baixar mídia (MVP)').parameters.jsCode =
    `const decode=${decodeEvolutionMedia.toString()};return decode($json,$('${NORMALIZE}').item.json);`;
  // The current workflow may include the independent Inbox image persistence
  // branch added after initial WAHA cutover. Keep its domain/attachment nodes
  // and edges; replace only its copied provider query/download definitions.
  for (const [target, reference] of [
    [
      'Inbox - Imagem recebida - Consultar URL',
      'WhatsApp - Consultar mídia (MVP)',
    ],
    ['Inbox - Imagem recebida - Baixar', 'WhatsApp - Baixar mídia (MVP)'],
  ]) {
    const cloned = workflow.nodes.find(
      (/** @type {any} */ node) => node.name === target,
    );
    if (!cloned) continue;
    const template = find(reference);
    cloned.type = template.type;
    cloned.typeVersion = template.typeVersion;
    cloned.parameters = structuredClone(template.parameters);
    cloned.retryOnFail = false;
    delete cloned.maxTries;
    delete cloned.waitBetweenTries;
    if (template.credentials)
      cloned.credentials = structuredClone(template.credentials);
    else delete cloned.credentials;
  }
  find(MEDIA_PREPARE).parameters.jsCode =
    `const command=$('${HUMAN_RESERVE}').item.json.command;const expected=command.message;\nif($json.valid!==true||$json.media_id!==expected.media_id||$json.type!==expected.type||$json.sha256!==expected.sha256||$json.mime_type!==expected.mime_type||$json.size_bytes!==expected.size_bytes)throw new Error('MEDIA_PREFLIGHT_REJECTED');\nconst prepared=$('${MEDIA_UPLOAD}').item.json;if(prepared.id!==expected.media_id||typeof prepared.file?.data!=='string'||prepared.file.mimetype!==expected.mime_type)throw new Error('MEDIA_PREFLIGHT_REJECTED');\nconst to=String(command.to).replace(/^\\+/, '');if(!/^\\d{8,15}$/.test(to))throw new Error('EVOLUTION_RECIPIENT_INVALID');if(!['image','audio','video'].includes(expected.type))throw new Error('EVOLUTION_MEDIA_TYPE_UNSUPPORTED');\nreturn {json:{evolution_endpoint:expected.type==='audio'?'sendWhatsAppAudio':'sendMedia',evolution_message:expected.type==='audio'?{number:to,audio:prepared.file.data}:{number:to,mediatype:expected.type,mimetype:prepared.file.mimetype,media:prepared.file.data,fileName:prepared.file.filename,caption:expected.caption??'',linkPreview:false}}};`;
  find(MEDIA_SEND).parameters.url =
    `={{ (()=>{if(!['sendMedia','sendWhatsAppAudio'].includes($json.evolution_endpoint))throw new Error('EVOLUTION_MEDIA_TYPE_UNSUPPORTED');return ${JSON.stringify(config.baseUrl + '/message/')}+$json.evolution_endpoint+${JSON.stringify('/' + config.session)};})() }}`;
  find(MEDIA_SEND).parameters.jsonBody = '={{ $json.evolution_message }}';
  find('Validar resposta do envio de midia (MVP)').parameters.jsCode =
    `const getId=${getEvolutionMessageId.toString()};const id=getId($json);return {json:{messages:[{id}]}};`;
  if (options?.workflowId) {
    workflow.id = options.workflowId;
    if (
      workflow.nodes.some(
        (/** @type {any} */ node) =>
          node.type === 'n8n-nodes-base.errorTrigger',
      )
    )
      workflow.settings.errorWorkflow = workflow.id;
  } else {
    delete workflow.id;
    if (workflow.settings.errorWorkflow === source.id)
      delete workflow.settings.errorWorkflow;
  }
  workflow.name =
    options?.workflowName ?? 'Vendedor Silmer — Evolution Baileys';
  delete workflow.versionId;
  delete workflow.activeVersionId;
  delete workflow.activeVersion;
  workflow.active = false;
  return patchEvolutionRecipientPreflight(
    synchronizeOrderAssistanceMedia(workflow),
  ).workflow;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output, configPath, baselinePath] = process.argv.slice(2);
  if (!input || !output || !configPath)
    throw new Error(
      'Usage: node create-evolution-workflow.mjs source.json output.json config.json [meta-baseline.json]',
    );
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (baselinePath)
    config.transportBaseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const result = createEvolutionWorkflow(
    JSON.parse(await readFile(input, 'utf8')),
    config,
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
