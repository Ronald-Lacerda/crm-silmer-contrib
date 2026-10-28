import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';

export const DEV_WORKFLOW_ID = '0S5ZS1xeDCSoWovs';
export const DEV_WORKFLOW_NAME = 'DEV | Silmer | Fluxo completo sem WhatsApp';
export const DEV_WORKFLOW_VERSION = 'dev-mvp-simple-18';
export const LOCAL_WORKFLOW_NAME =
  'LOCAL | Silmer | Fluxo completo sem WhatsApp';

const MAIN_TRIGGER = 'WhatsApp - Receber eventos (MVP)';
const DEV_TRIGGER = 'DEV - Receber evento sintético (MVP)';
const DEV_CHAT_TRIGGER = 'DEV - Conversa manual no chat (MVP)';
const BUILD_SYNTHETIC_EVENT = 'DEV - Montar evento WhatsApp sintético (MVP)';
const NORMALIZE_EVENT = 'Normalizar evento WhatsApp (MVP)';
const AI_SEND = 'WhatsApp - Enviar resposta da IA (MVP)';
const DEV_AI_SEND = 'DEV - Simular envio da IA (MVP)';
const HUMAN_SEND = 'WhatsApp - Enviar texto humano (MVP)';
const NOTICE_SEND = 'WhatsApp - Enviar aviso de transferência (MVP)';
const DEV_NOTICE_SEND = 'DEV - Simular aviso de transferência (MVP)';
const DEV_HUMAN_SEND = 'DEV - Simular envio humano (MVP)';
const MEDIA_UPLOAD = 'Meta - Upload midia humana (MVP)';
const DEV_MEDIA_UPLOAD = 'DEV - Simular upload Meta de midia (MVP)';
const MEDIA_SEND = 'Meta - Enviar midia humana (MVP)';
const DEV_MEDIA_SEND = 'DEV - Simular envio Meta de midia (MVP)';
const PANEL_TRIGGER = 'Painel - Receber comando (MVP)';
// ADR 026: the public site chat stays in the canonical workflow; DEV and LOCAL
// keep their own chat, restricted to the n8n user.
const SITE_CHAT_NODES = [
  'Site - Direcionar para WhatsApp (MVP)',
  'Site - Receber mensagem do chat (MVP)',
  'Site - Montar evento do chat (MVP)',
];
const CRM_TO_N8N_CREDENTIAL = 'Silmer CRM para n8n Basic DEV';
const N8N_TO_CRM_CREDENTIAL = 'Silmer n8n para CRM Basic DEV';

/**
 * Builds the non-WhatsApp validation workflow from the canonical workflow.
 * The domain path stays identical: CRM inbound, briefing, AI decision,
 * handoff, send fence, delivery callback and CRM-originated commands.
 *
 * @param {Record<string, any>} source
 * @param {{deployment?: boolean, local?: boolean}} [options]
 */
export function createDevTestWorkflow(source, options = {}) {
  if (options.deployment && options.local) {
    throw new Error(
      'A workflow cannot target deployment and local n8n together',
    );
  }
  const workflow = structuredClone(source);
  const local = options.local === true;
  const workflowName = local ? LOCAL_WORKFLOW_NAME : DEV_WORKFLOW_NAME;
  workflow.name = workflowName;
  workflow.id = DEV_WORKFLOW_ID;
  workflow.active = false;
  delete workflow.versionId;
  delete workflow.activeVersionId;
  delete workflow.webhookId;
  delete workflow.pinData;

  if (workflow.source) {
    workflow.source = {
      ...workflow.source,
      id: DEV_WORKFLOW_ID,
      name: workflowName,
      active: false,
      activeVersionId: null,
    };
    delete workflow.source.versionId;
  }

  workflow.settings = {
    ...(workflow.settings ?? {}),
    availableInMCP: false,
    saveDataErrorExecution: 'none',
    saveDataSuccessExecution: 'none',
    saveExecutionProgress: false,
    saveManualExecutions: false,
  };

  workflow.nodes = (workflow.nodes ?? []).filter(
    (/** @type {Record<string, any>} */ node) =>
      !SITE_CHAT_NODES.includes(node.name),
  );
  const nodes = workflow.nodes;
  const trigger = requiredNode(nodes, MAIN_TRIGGER);
  trigger.name = DEV_TRIGGER;
  trigger.type = 'n8n-nodes-base.webhook';
  trigger.typeVersion = 2;
  if (local) {
    trigger.id = '7cbe7a1f-4442-4d4c-9dbd-8c1de2a2d6a1';
    trigger.webhookId = '2d846e1d-f2f4-4862-9c24-0c1b93afda0d';
  } else {
    delete trigger.id;
    delete trigger.webhookId;
  }
  trigger.parameters = {
    httpMethod: 'POST',
    path: local ? 'silmer/local-mvp-flow' : 'silmer/dev-mvp-flow',
    responseMode: local ? 'onReceived' : 'lastNode',
    options: {},
  };
  delete trigger.credentials;

  nodes.push({
    id: 'c38c09db-e293-4547-8d2c-807d4d18c0ea',
    name: DEV_CHAT_TRIGGER,
    type: '@n8n/n8n-nodes-langchain.chatTrigger',
    typeVersion: 1.4,
    position: [trigger.position[0], trigger.position[1] - 300],
    parameters: {
      public: true,
      mode: 'hostedChat',
      authentication: 'n8nUserAuth',
      requireExecuteAccess: true,
      initialMessages:
        'Teste Silmer: as mensagens passam pelo CRM e pela IA reais; o WhatsApp é simulado. Ao recarregar, o histórico pode sumir da tela, mas a mesma conversa continua no CRM. Para uma conversa independente, use outra sessão do navegador.',
      options: {
        allowFileUploads: true,
        allowedFilesMimeTypes: 'image/*,audio/*',
        loadPreviousSession: 'notSupported',
        responseMode: 'lastNode',
        showWelcomeScreen: true,
        title: 'Teste manual | Silmer',
        subtitle:
          'Recarregar pode ocultar o histórico; a conversa continua no CRM.',
        getStarted: 'Continuar sessão de teste',
        inputPlaceholder: 'Escreva como se fosse um cliente...',
      },
    },
  });

  const buildSyntheticEvent = {
    id: 'f321065d-4c9e-41d1-a0fe-65a94ed99351',
    name: BUILD_SYNTHETIC_EVENT,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    // Between the webhook and the chat trigger, clear of the normalizer it feeds.
    position: [trigger.position[0] + 120, trigger.position[1] - 150],
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const chatInput = typeof $json.chatInput === 'string' ? $json.chatInput.trim() : '';
const isChat = chatInput.length > 0;
const body = isChat ? {} : ($json.body ?? $json);
const chatSessionId = String($json.sessionId ?? $execution.id);
const syntheticWaId = (() => {
  let hash = 0;
  for (const char of chatSessionId) hash = (hash * 31 + char.charCodeAt(0)) % 100000000;
  return '55419' + String(hash).padStart(8, '0');
})();
const waId = String(body.wa_id ?? '').trim();
const contactWaId = isChat ? syntheticWaId : waId;
if (!/^[1-9][0-9]{7,14}$/.test(contactWaId)) throw new Error('DEV_WA_ID_INVALID');
const occurredAt = String(Math.floor(Date.now() / 1000));
const eventId = String(body.event_id ?? (isChat ? ('dev-chat-' + chatSessionId + '-' + $execution.id) : ('dev-inbound-' + $execution.id)));
const phoneNumberId = String(body.phone_number_id ?? 'dev-phone-number');
const scenario = String(body.scenario ?? 'message').trim() || 'message';
if (!['message', 'handoff', 'send_unknown', 'delivery_status'].includes(scenario)) {
  throw new Error('DEV_SCENARIO_INVALID');
}
const status = body.status == null
  ? scenario === 'delivery_status' ? 'delivered' : null
  : String(body.status);
if (status) {
  return { json: { __dev_input: { source: isChat ? 'chat' : 'webhook', scenario }, entry: [{ changes: [{ value: {
    metadata: { phone_number_id: phoneNumberId },
    statuses: [{ id: String(body.external_message_id ?? eventId), status, timestamp: occurredAt, recipient_id: contactWaId }]
  } }] }] } };
}
const defaultText = {
  handoff: 'Quero falar com uma pessoa da Silmer, por favor.',
  send_unknown: 'Preciso de 120 camisetas para um evento.',
  message: 'Preciso de 120 camisetas para um evento.'
}[scenario] ?? '';
const text = isChat ? chatInput : String(body.message ?? body.text ?? defaultText).trim();
// ADR 026: an image or audio uploaded in the chat goes the way of a WhatsApp file.
const file = isChat ? Object.values($input.item.binary ?? {})[0] : undefined;
const mimeType = String(file?.mimeType ?? '').split(';')[0].toLowerCase();
const fileType = !file ? null : mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'document';
if (!text && !file) throw new Error('DEV_MESSAGE_REQUIRED');
const message = { from: contactWaId, id: eventId, timestamp: occurredAt, type: 'text', text: { body: text } };
if (fileType) {
  delete message.text;
  message.type = fileType;
  message[fileType] = { id: eventId + '-file', mime_type: mimeType, ...(text ? { caption: text } : {}) };
}
return { json: { __dev_input: { source: isChat ? 'chat' : 'webhook', scenario }, entry: [{ changes: [{ value: {
  metadata: { phone_number_id: phoneNumberId },
  contacts: [{ profile: { name: String(body.customer_name ?? (isChat ? 'Cliente Chat DEV' : 'Cliente de teste')) }, wa_id: contactWaId }],
  messages: [message]
} }] }] }, ...(file ? { binary: { data: file } } : {}) };`,
    },
  };
  nodes.push(buildSyntheticEvent);

  transformSendNode(
    requiredNode(nodes, AI_SEND),
    DEV_AI_SEND,
    `const input = $('${BUILD_SYNTHETIC_EVENT}').item.json.__dev_input ?? {};
if (input.simulate_send_unknown === true || input.scenario === 'send_unknown') throw new Error('DEV_SIMULATED_SEND_OUTCOME_UNKNOWN');
const command = $('Preparar reserva de envio da IA (MVP)').item.json.command_id;
return { json: { id: 'dev-ai-' + command, messages: [{ id: 'dev-ai-' + command }], simulated: true } };`,
  );
  transformSendNode(
    requiredNode(nodes, NOTICE_SEND),
    DEV_NOTICE_SEND,
    `const notice = $('Preparar aviso de transferência (MVP)').item.json;
return { json: { id: 'dev-notice-' + notice.command_id, messages: [{ id: 'dev-notice-' + notice.command_id }], simulated: true } };`,
  );
  transformSendNode(
    requiredNode(nodes, HUMAN_SEND),
    DEV_HUMAN_SEND,
    `const command = $('Preparar reserva de envio humano (MVP)').item.json.command;
return { json: { id: 'dev-human-' + command.command_id, messages: [{ id: 'dev-human-' + command.command_id }], simulated: true } };`,
  );

  transformSendNode(
    requiredNode(nodes, MEDIA_UPLOAD),
    DEV_MEDIA_UPLOAD,
    `const command = $('Preparar reserva de envio humano (MVP)').item.json.command;
const bytes = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');
if (bytes.length !== command.message.size_bytes) throw new Error('DEV_MEDIA_UPLOAD_INVALID');
if ($('Painel - Receber comando (MVP)').item.json.body?.simulate_media_upload_failed === true) throw new Error('DEV_MEDIA_UPLOAD_FAILED');
return { json: { id: 'dev-media-' + command.command_id, simulated: true } };`,
  );
  transformSendNode(
    requiredNode(nodes, MEDIA_SEND),
    DEV_MEDIA_SEND,
    `const command = $('Preparar reserva de envio humano (MVP)').item.json.command;
if ($('Painel - Receber comando (MVP)').item.json.body?.simulate_send_unknown === true) throw new Error('DEV_SIMULATED_SEND_OUTCOME_UNKNOWN');
return { json: { messages: [{ id: 'dev-human-media-' + command.command_id }], simulated: true } };`,
  );

  for (const node of nodes) {
    if (typeof node.parameters?.jsCode === 'string') {
      node.parameters.jsCode = node.parameters.jsCode.replaceAll(
        MEDIA_UPLOAD,
        DEV_MEDIA_UPLOAD,
      );
    }
    // Only the CRM calls change; Meta media and OpenAI keep their own accounts.
    if (isCrmRequest(node)) {
      rewriteWorkflowHeaders(node);
      if (options.deployment) {
        node.credentials = {
          httpBasicAuth: { name: N8N_TO_CRM_CREDENTIAL },
        };
      } else if (local) {
        configureLocalCrmRequest(node);
      } else {
        delete node.credentials;
      }
    }
  }

  const panelTrigger = requiredNode(nodes, PANEL_TRIGGER);
  if (local) {
    panelTrigger.id = '343ddc1c-73f5-4b8f-8ea2-cf4f8d6ca9bd';
    panelTrigger.webhookId = '34edee34-4a73-494f-b7ca-69a9e48bd1b9';
  } else {
    delete panelTrigger.id;
    delete panelTrigger.webhookId;
  }
  panelTrigger.parameters.path = local
    ? 'silmer/local-panel-command'
    : 'silmer/dev-panel-command';
  if (options.deployment) {
    panelTrigger.credentials = {
      httpBasicAuth: { name: CRM_TO_N8N_CREDENTIAL },
    };
  } else {
    delete panelTrigger.credentials;
    if (local) {
      panelTrigger.parameters.authentication = 'none';
      // This localhost webhook is invoked by the Node command worker.
      // User-agent bot detection is not authentication for technical clients.
      panelTrigger.parameters.options.ignoreBots = false;
    }
  }

  nodes.push(
    resultNode(
      'DEV - Resultado da resposta da IA',
      [1910, -690],
      `const decision = $('Normalizar decisão da IA (MVP)').item.json;
const input = $('${BUILD_SYNTHETIC_EVENT}').item.json.__dev_input ?? {};
// ADR 014: whether the workflow asked to open the order and what the CRM answered.
let order = null;
try { order = $('CRM - Reservar envio da IA (MVP)').item.json.order ?? null; } catch (error) { order = null; }
return { json: { ok: true, scenario: input.scenario ?? 'message', route: 'ai_reply', whatsapp_simulated: true, conversation_id: decision.conversation_id, turn: decision.turn, reply_text: decision.reply_text, output: decision.reply_text, answer_status: decision.answer_status, briefing_patch: decision.briefing_patch, open_order: decision.open_order ?? null, order, handoff_ready: decision.handoff_ready, missing_briefing_fields: decision.missing_briefing_fields, ficha_filled: decision.ficha_filled ?? null, ficha_total: decision.ficha_total ?? null } };`,
    ),
    resultNode(
      'DEV - Resultado do handoff',
      [620, -980],
      `const input = $('${BUILD_SYNTHETIC_EVENT}').item.json.__dev_input ?? {};
let decision = {};
try { decision = $('Normalizar decisão da IA (MVP)').item.json; } catch (error) { decision = {}; }
let notice = {};
try { notice = $('Preparar aviso de transferência (MVP)').item.json; } catch (error) { notice = {}; }
let crm = null;
try { crm = $('CRM - Registrar handoff (MVP)').item.json; } catch (error) { crm = $json; }
const reply = notice.text || decision.reply_text || 'Vou encaminhar seu atendimento para nossa equipe.';
return { json: { ok: true, scenario: input.scenario ?? 'handoff', route: 'handoff', whatsapp_simulated: true, notice_authorized: notice.send_authorized === true, notice_command_id: notice.command_id ?? null, conversation_id: decision.conversation_id ?? notice.conversation_id ?? null, turn: decision.turn, reply_text: reply, output: reply, trigger: decision.trigger ?? 'unsupported_media', handoff_reason: decision.handoff_reason ?? 'unsupported', requested_seller: decision.requested_seller ?? null, handoff_summary: decision.reasoning ?? null, briefing_patch: decision.briefing_patch ?? null, open_order: decision.open_order ?? null, order: crm?.order ?? null, missing_briefing_fields: decision.missing_briefing_fields ?? null, ficha_filled: decision.ficha_filled ?? null, ficha_total: decision.ficha_total ?? null, crm } };`,
    ),
    resultNode(
      'DEV - Resultado do envio desconhecido',
      [1910, -500],
      `const input = $('${BUILD_SYNTHETIC_EVENT}').item.json.__dev_input ?? {};
const reply = $('Normalizar decisão da IA (MVP)').item.json.reply_text ?? 'O envio simulado ficou pendente de reconciliação.';
return { json: { ok: true, scenario: input.scenario ?? 'send_unknown', route: 'send_unknown', whatsapp_simulated: true, output: reply, crm: $json } };`,
    ),
    resultNode(
      'DEV - Resultado do status',
      [-990, -80],
      `const input = $('${BUILD_SYNTHETIC_EVENT}').item.json.__dev_input ?? {};
return { json: { ok: true, scenario: input.scenario ?? 'delivery_status', route: 'delivery_status', whatsapp_simulated: true, crm: $json } };`,
    ),
    resultNode(
      'DEV - Resultado sem novo envio',
      [620, -420],
      `const reply = $('Preparar reserva de envio da IA (MVP)').item.json.reply_text ?? 'A resposta não foi autorizada para envio.';
return { json: { ok: true, route: 'send_not_authorized', whatsapp_simulated: true, output: reply, crm: $json } };`,
    ),
    resultNode(
      'DEV - Resultado sem ação',
      [-750, -200],
      `const inbound = $json;
return { json: { ok: true, route: 'no_action', whatsapp_simulated: true, conversation_id: inbound.conversation_id, mode: inbound.mode, turn: inbound.source_revision, reply_text: null, output: 'A conversa está com um vendedor; o bot não responde.' } };`,
    ),
    {
      id: '4c662d98-dfd8-4b62-b08a-2826435e36ed',
      name: 'DEV - Como testar o fluxo completo',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-2440, -1080],
      parameters: {
        width: 760,
        height: 470,
        color: 3,
        content:
          `# ${local ? 'LOCAL' : 'DEV'} | Fluxo completo sem WhatsApp\n\n` +
          'Mantém a lógica do workflow principal e substitui apenas o transporte WhatsApp.\n\n' +
          `- Entrada: webhook \`${local ? 'silmer/local-mvp-flow' : 'silmer/dev-mvp-flow'}\`.\n` +
          '- Entrada alternativa: Chat Trigger hospedado e restrito ao usuário autenticado do n8n.\n' +
          '- Chat: usa uma identidade sintética por sessionId. Recarregar pode ocultar o histórico visual sem trocar o sessionId; use outra sessão do navegador para isolar uma nova conversa.\n' +
          '- CRM real: inbound, briefing, handoff, reserva e callbacks.\n' +
          '- IA real: mesma decisão estruturada do MVP.\n' +
          '- Mídia: o chat aceita imagem e áudio; a IA vê a imagem e lê o áudio transcrito.\n' +
          '- Pré-ficha: cada mensagem atualiza os campos confirmados e a IA pergunta pelo próximo dado pendente.\n' +
          '- Saída WhatsApp: simulada, com `message.sent` persistido no CRM.\n' +
          '- `simulate_send_unknown: true` exercita reconciliação.\n\n' +
          'Cenários: `message`, `handoff`, `send_unknown` e `delivery_status`. ' +
          'Eles apenas montam a entrada sintética; a jornada do CRM, IA e fence ' +
          'continua igual à do workflow canônico.\n\n' +
          (local
            ? 'Local: a credencial n8n → CRM é efêmera por variável de ambiente e o webhook do painel fica exposto somente em localhost.'
            : 'Requer `SILMER_PANEL_BASE_URL` acessível pelo n8n e as credenciais Basic DEV nos dois sentidos.'),
      },
    },
  );

  const connections = { ...(workflow.connections ?? {}) };
  for (const name of SITE_CHAT_NODES) delete connections[name];
  workflow.connections = rewriteConnections(connections);
  workflow.nodeGroups = workflow.nodeGroups ?? [];
  return workflow;
}

/** @param {Record<string, any>} node */
function isCrmRequest(node) {
  return (
    node.type === 'n8n-nodes-base.httpRequest' &&
    (node.parameters?.headerParameters?.parameters ?? []).some(
      (/** @type {Record<string, any>} */ header) =>
        header.name === 'X-Silmer-Workflow-Key',
    )
  );
}

/** @param {Record<string, any>} node */
function configureLocalCrmRequest(node) {
  node.parameters.authentication = 'none';
  delete node.parameters.genericAuthType;
  const headers = node.parameters.headerParameters?.parameters;
  if (!Array.isArray(headers)) return;
  headers.push({
    name: 'Authorization',
    value: '={{ $env.SILMER_LOCAL_N8N_TO_CRM_AUTHORIZATION }}',
  });
  delete node.credentials;
}

/**
 * @param {Record<string, any>} node
 * @param {string} name
 * @param {string} jsCode
 */
function transformSendNode(node, name, jsCode) {
  node.name = name;
  node.type = 'n8n-nodes-base.code';
  node.typeVersion = 2;
  node.parameters = { mode: 'runOnceForEachItem', jsCode };
  delete node.credentials;
}

/**
 * @param {string} name
 * @param {number[]} position
 * @param {string} jsCode
 */
function resultNode(name, position, jsCode) {
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { mode: 'runOnceForEachItem', jsCode },
  };
}

/** @param {Record<string, any>} node */
function rewriteWorkflowHeaders(node) {
  const headers = node.parameters?.headerParameters?.parameters ?? [];
  for (const header of headers) {
    if (header.name === 'X-Silmer-Workflow-Key') {
      header.value = DEV_WORKFLOW_ID;
    }
    if (header.name === 'X-Silmer-Workflow-Version') {
      header.value = DEV_WORKFLOW_VERSION;
    }
  }
}

/**
 * @param {Record<string, any>} connections
 * @returns {Record<string, any>}
 */
function rewriteConnections(connections) {
  /** @type {Record<string, string>} */
  const renamed = {
    [MAIN_TRIGGER]: DEV_TRIGGER,
    [AI_SEND]: DEV_AI_SEND,
    [HUMAN_SEND]: DEV_HUMAN_SEND,
    [NOTICE_SEND]: DEV_NOTICE_SEND,
    [MEDIA_UPLOAD]: DEV_MEDIA_UPLOAD,
    [MEDIA_SEND]: DEV_MEDIA_SEND,
  };
  /** @type {Record<string, any>} */
  const result = {};
  for (const [source, groups] of Object.entries(connections)) {
    result[renamed[source] ?? source] = structuredClone(groups);
  }
  for (const groups of Object.values(result)) {
    for (const outputs of Object.values(groups)) {
      for (const output of outputs) {
        for (const edge of output ?? [])
          edge.node = renamed[edge.node] ?? edge.node;
      }
    }
  }

  const syntheticInput = {
    main: [
      [
        {
          node: BUILD_SYNTHETIC_EVENT,
          type: 'main',
          index: 0,
        },
      ],
    ],
  };
  result[DEV_TRIGGER] = structuredClone(syntheticInput);
  result[DEV_CHAT_TRIGGER] = structuredClone(syntheticInput);
  result[BUILD_SYNTHETIC_EVENT] = {
    main: [[{ node: NORMALIZE_EVENT, type: 'main', index: 0 }]],
  };
  appendMain(
    result,
    'CRM - Registrar message.sent da IA (MVP)',
    0,
    'DEV - Resultado da resposta da IA',
  );
  // The handoff result answers after the notice chain, sent or not.
  appendMain(
    result,
    'CRM - Registrar message.sent do aviso (MVP)',
    0,
    'DEV - Resultado do handoff',
  );
  appendMain(
    result,
    'CRM - Marcar envio desconhecido do aviso (MVP)',
    0,
    'DEV - Resultado do handoff',
  );
  appendMain(
    result,
    'Aviso de transferência autorizado? (MVP)',
    1,
    'DEV - Resultado do handoff',
  );
  appendMain(
    result,
    'CRM - Marcar envio desconhecido da IA (MVP)',
    0,
    'DEV - Resultado do envio desconhecido',
  );
  appendMain(
    result,
    'CRM - Registrar status de entrega (MVP)',
    0,
    'DEV - Resultado do status',
  );
  appendMain(
    result,
    'Envio da IA autorizado? (MVP)',
    1,
    'DEV - Resultado sem novo envio',
  );
  appendMain(
    result,
    'Rotear conversa registrada (MVP)',
    2,
    'DEV - Resultado sem ação',
  );
  return result;
}

/**
 * @param {Record<string, any>} connections
 * @param {string} source
 * @param {number} index
 * @param {string} target
 */
function appendMain(connections, source, index, target) {
  connections[source] ??= {};
  connections[source].main ??= [];
  connections[source].main[index] ??= [];
  connections[source].main[index].push({
    node: target,
    type: 'main',
    index: 0,
  });
}

/**
 * @param {Array<Record<string, any>>} nodes
 * @param {string} name
 */
function requiredNode(nodes, name) {
  const node = nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`Canonical workflow node not found: ${name}`);
  return node;
}

async function runCli() {
  const args = process.argv.slice(2);
  const deployment = args.includes('--deployment');
  const local = args.includes('--local');
  const values = args.filter(
    (argument) => argument !== '--deployment' && argument !== '--local',
  );
  const sourcePath =
    values[0] ??
    new URL('./k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json', import.meta.url);
  const outputPath =
    values[1] ??
    new URL(
      local
        ? './0S5ZS1xeDCSoWovs-local-test.sanitized.json'
        : './0S5ZS1xeDCSoWovs-dev-test.sanitized.json',
      import.meta.url,
    );
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const workflow = createDevTestWorkflow(source, { deployment, local });
  await writeFile(
    outputPath,
    await format(JSON.stringify(workflow), { parser: 'json' }),
    'utf8',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
