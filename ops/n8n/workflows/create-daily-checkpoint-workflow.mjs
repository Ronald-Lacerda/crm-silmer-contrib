import { writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { evolutionRecipientRegistered } from '../evolution-recipient-preflight.mjs';
import { getEvolutionMessageId } from './create-evolution-workflow.mjs';

/** CHK-04: failure before transport is definite; ambiguous transport is never retried.
 * @param {any} response @param {string} requested */
export function classifyCheckpointLookup(response, requested) {
  try {
    if (response?.statusCode !== 200) throw new Error('LOOKUP_UNAVAILABLE');
    return evolutionRecipientRegistered(response.body, requested)
      ? { registered: true }
      : { registered: false, status: 'failed', code: 'RECIPIENT_UNREGISTERED' };
  } catch {
    return {
      registered: false,
      status: 'failed',
      code: 'RECIPIENT_LOOKUP_UNAVAILABLE',
    };
  }
}

/** An accepted response must identify the exact reserved recipient.
 * @param {any} response @param {string} requested */
export function classifyCheckpointSend(response, requested) {
  try {
    if (
      response?.statusCode < 200 ||
      response?.statusCode >= 300 ||
      !Number.isInteger(response?.statusCode)
    )
      throw new Error('SEND_UNKNOWN');
    const providerMessageId = getEvolutionMessageId(response.body);
    if (response.body.key.remoteJid !== requested + '@s.whatsapp.net')
      throw new Error('SEND_UNKNOWN');
    return { status: 'sent', code: 'PROVIDER_ACCEPTED', providerMessageId };
  } catch {
    return { status: 'outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN' };
  }
}

export const CHECKPOINT_NODES = Object.freeze({
  schedule: 'Checkpoint - Diariamente às 08h',
  prepare: 'CRM - Preparar checkpoint',
  recipients: 'Checkpoint - Separar destinatários',
  reserve: 'CRM - Reservar destinatário',
  authorized: 'Checkpoint - Reserva autorizada?',
  lookup: 'Evolution - Consultar destinatário',
  validate: 'Checkpoint - Validar destinatário',
  registered: 'Checkpoint - Destinatário registrado?',
  send: 'Evolution - Enviar checkpoint',
  classify: 'Checkpoint - Classificar envio',
  lookupFailure: 'Checkpoint - Falha de consulta',
  unknown: 'Checkpoint - Resultado desconhecido',
  complete: 'CRM - Registrar resultado',
});

/** Private bindings contain endpoint addresses and credential REFERENCES only.
 * Credentials themselves belong in n8n's credential store. The generated
 * workflow is always inactive and stores no execution data.
 * @param {{crmBaseUrl?:string,evolutionBaseUrl?:string,evolutionInstance?:string,crmCredential?:{id:string,name:string},evolutionCredential?:{id:string,name:string}}} [bindings] */
export function createDailyCheckpointWorkflow(bindings = {}) {
  const names = CHECKPOINT_NODES;
  /** @type {any[]} */
  const nodes = [];
  /** @type {Record<string,any>} */
  const connections = {};
  const edge = (/** @type {string} */ node) => ({
    node,
    type: 'main',
    index: 0,
  });
  const link = (
    /** @type {string} */ from,
    /** @type {string[]} */ targets,
  ) => {
    connections[from] = { main: targets.map((name) => [edge(name)]) };
  };
  const code = (
    /** @type {string} */ name,
    /** @type {string} */ jsCode,
    /** @type {number[]} */ position,
    mode = 'runOnceForEachItem',
  ) => {
    const node = {
      id: `checkpoint-${nodes.length}`,
      name,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position,
      parameters: { mode, jsCode },
    };
    nodes.push(node);
    return node;
  };
  const base = (
    /** @type {string|undefined} */ literal,
    /** @type {string} */ variable,
  ) =>
    literal ? JSON.stringify(literal.replace(/\/$/u, '')) : `$vars.${variable}`;
  const crmBase = base(bindings.crmBaseUrl, 'DAILY_CHECKPOINT_CRM_URL');
  const evolutionBase = base(
    bindings.evolutionBaseUrl,
    'DAILY_CHECKPOINT_EVOLUTION_URL',
  );
  const instance = bindings.evolutionInstance
    ? JSON.stringify(bindings.evolutionInstance)
    : '$vars.DAILY_CHECKPOINT_EVOLUTION_INSTANCE';
  const crmCredential = bindings.crmCredential ?? {
    id: 'CONFIGURE_CRM_AUTOMATION_BASIC',
    name: 'Configure CRM automation Basic',
  };
  const evolutionCredential = bindings.evolutionCredential ?? {
    id: 'CONFIGURE_EVOLUTION_API_HEADER',
    name: 'Configure Evolution API header',
  };
  const http = (
    /** @type {string} */ name,
    /** @type {string} */ url,
    /** @type {string} */ jsonBody,
    /** @type {number[]} */ position,
    provider = false,
  ) => {
    /** @type {any} */
    const node = {
      id: `checkpoint-${nodes.length}`,
      name,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position,
      retryOnFail: false,
      parameters: {
        method: 'POST',
        url,
        authentication: 'genericCredentialType',
        genericAuthType: provider ? 'httpHeaderAuth' : 'httpBasicAuth',
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody,
        options: {
          timeout: provider ? 15000 : 20000,
          redirect: { redirect: { followRedirects: false } },
          response: {
            response: {
              responseFormat: 'json',
              ...(provider ? { fullResponse: true, neverError: true } : {}),
            },
          },
        },
      },
      credentials: provider
        ? { httpHeaderAuth: evolutionCredential }
        : { httpBasicAuth: crmCredential },
    };
    nodes.push(node);
    return node;
  };
  const condition = (
    /** @type {string} */ name,
    /** @type {string} */ expression,
    /** @type {number[]} */ position,
  ) => {
    nodes.push({
      id: `checkpoint-${nodes.length}`,
      name,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position,
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
              id: `condition-${nodes.length}`,
              leftValue: expression,
              rightValue: true,
              operator: {
                type: 'boolean',
                operation: 'true',
                singleValue: true,
              },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    });
  };
  const reservation = `$('${names.reserve}').item.json`;
  const number = `String(${reservation}.phone).replace(/^\\+/, '')`;
  nodes.push({
    id: 'checkpoint-schedule',
    name: names.schedule,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 0],
    parameters: {
      rule: {
        interval: [{ field: 'cronExpression', expression: '0 8 * * *' }],
      },
    },
  });
  // The server resolves yesterday in São Paulo; the workflow does not derive a day in host timezone.
  http(
    names.prepare,
    `={{ ${crmBase} + '/api/v1/integrations/n8n/dashboard/checkpoint/prepare' }}`,
    '{}',
    [240, 0],
  );
  code(
    names.recipients,
    "const report=$input.first().json;if(typeof report.checkpointId!=='string'||!Array.isArray(report.recipients))throw new Error('CHECKPOINT_PREPARE_INVALID');return report.recipients.map(recipient=>({json:{checkpointId:report.checkpointId,recipientId:recipient.id},pairedItem:{item:0}}));",
    [480, 0],
    'runOnceForAllItems',
  );
  http(
    names.reserve,
    `={{ ${crmBase} + '/api/v1/integrations/n8n/dashboard/checkpoint/reserve' }}`,
    '={{ { checkpointId: $json.checkpointId, recipientId: $json.recipientId } }}',
    [720, 0],
  );
  condition(names.authorized, '={{ $json.authorized === true }}', [960, 0]);
  const lookup = http(
    names.lookup,
    `={{ ${evolutionBase} + '/chat/whatsappNumbers/' + encodeURIComponent(${instance}) }}`,
    `={{ { numbers: [${number}] } }}`,
    [1200, 0],
    true,
  );
  lookup.onError = 'continueErrorOutput';
  code(
    names.validate,
    `const evolutionRecipientRegistered=${evolutionRecipientRegistered.toString()};const classify=${classifyCheckpointLookup.toString()};return {json:classify($json,${number})};`,
    [1440, 0],
  );
  condition(names.registered, '={{ $json.registered === true }}', [1680, 0]);
  const send = http(
    names.send,
    `={{ ${evolutionBase} + '/message/sendText/' + encodeURIComponent(${instance}) }}`,
    `={{ { number: ${number}, text: ${reservation}.text, linkPreview: false } }}`,
    [1920, 0],
    true,
  );
  send.onError = 'continueErrorOutput';
  code(
    names.classify,
    `const getEvolutionMessageId=${getEvolutionMessageId.toString()};const classify=${classifyCheckpointSend.toString()};return {json:classify($json,${number})};`,
    [2160, 0],
  );
  code(
    names.lookupFailure,
    "return {json:{status:'failed',code:'RECIPIENT_LOOKUP_UNAVAILABLE'}};",
    [1440, 300],
  );
  code(
    names.unknown,
    "return {json:{status:'outcome_unknown',code:'PROVIDER_OUTCOME_UNKNOWN'}};",
    [2160, 300],
  );
  http(
    names.complete,
    `={{ ${crmBase} + '/api/v1/integrations/n8n/dashboard/checkpoint/complete' }}`,
    `={{ { checkpointId: ${reservation}.checkpointId, recipientId: ${reservation}.recipientId, reservationId: ${reservation}.reservationId, status: $json.status, code: $json.code, ...($json.providerMessageId ? { providerMessageId: $json.providerMessageId } : {}) } }}`,
    [2400, 0],
  );
  link(names.schedule, [names.prepare]);
  link(names.prepare, [names.recipients]);
  link(names.recipients, [names.reserve]);
  link(names.reserve, [names.authorized]);
  connections[names.authorized] = { main: [[edge(names.lookup)], []] };
  link(names.lookup, [names.validate, names.lookupFailure]);
  link(names.validate, [names.registered]);
  link(names.registered, [names.send, names.complete]);
  link(names.send, [names.classify, names.unknown]);
  link(names.classify, [names.complete]);
  link(names.lookupFailure, [names.complete]);
  link(names.unknown, [names.complete]);
  return {
    name: 'Silmer | Checkpoint diário dos sócios',
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      timezone: 'America/Sao_Paulo',
      saveExecutionProgress: false,
      saveManualExecutions: false,
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'none',
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [output, privateBindings] = process.argv.slice(2);
  if (!output)
    throw new Error(
      'Usage: node create-daily-checkpoint-workflow.mjs output.json [private-bindings.json]',
    );
  const bindings = privateBindings
    ? JSON.parse(await readFile(privateBindings, 'utf8'))
    : {};
  await writeFile(
    output,
    await format(JSON.stringify(createDailyCheckpointWorkflow(bindings)), {
      parser: 'json',
    }),
  );
}
