import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RESERVE = 'Preparar reserva de envio humano (MVP)';
const SITE = 'Resposta humana pelo site? (MVP)';
const MEDIA = 'Mensagem humana tem midia? (MVP)';
const SEND = 'WhatsApp - Enviar texto humano (MVP)';
const CONCLUDE = 'CRM - Concluir falha anterior ao envio (MVP)';
const CHECK = 'Evolution - Consultar destinatario humano (MVP)';
const VALIDATE = 'Evolution - Validar destinatario humano (MVP)';
const ALLOWED = 'Evolution - Destinatario humano reconhecido? (MVP)';
const NOT_FOUND = 'Evolution - Destinatario humano nao encontrado (MVP)';
const UNAVAILABLE = 'Evolution - Consulta de destinatario indisponivel (MVP)';
const RECORD = 'CRM - Concluir falha do destinatario (MVP)';
const REJECT = 'Responder destinatario recusado (MVP)';
const ADDED = [
  CHECK,
  VALIDATE,
  ALLOWED,
  NOT_FOUND,
  UNAVAILABLE,
  RECORD,
  REJECT,
];

/** OPS-INBOX-SEND-06: only an unambiguous provider assertion can release send.
 * The requested number is never rewritten and no reusable identity is created.
 * @param {any} response @param {string} requested @returns {boolean}
 */
export function evolutionRecipientRegistered(response, requested) {
  if (
    !/^\d{8,15}$/u.test(requested) ||
    !Array.isArray(response) ||
    response.length !== 1
  )
    throw new Error('EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE');
  const record = response[0];
  if (
    !record ||
    record.number !== requested ||
    typeof record.exists !== 'boolean' ||
    !/^(?:\d{8,15}@s\.whatsapp\.net|\d{1,30}@lid)$/u.test(
      String(record.jid ?? ''),
    )
  )
    throw new Error('EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE');
  return record.exists;
}

const edge = (/** @type {string} */ node) => ({ node, type: 'main', index: 0 });

/** Add a read-only check after the single-use CRM reservation and site branch.
 * All failures stop before either text or media transport; no retries or replay.
 * The current export remains authoritative for credentials/settings/domain code.
 * @param {any} source @returns {{workflow:any, changedNodeNames:string[]}}
 */
export function patchEvolutionRecipientPreflight(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('EVOLUTION_RECIPIENT_WORKFLOW_INVALID');
  const find = (/** @type {string} */ name) => {
    const matches = source.nodes.filter(
      (/** @type {any} */ n) => n.name === name,
    );
    if (matches.length !== 1)
      throw new Error('EVOLUTION_RECIPIENT_NODE_MISSING_OR_AMBIGUOUS');
    return matches[0];
  };
  const send = find(SEND),
    site = find(SITE),
    media = find(MEDIA);
  const template = find('Falha de preflight da midia (MVP)');
  find(RESERVE);
  const conclude = find(CONCLUDE);
  const responder = find('Responder comando sem envio (MVP)');
  if (
    send.type !== 'n8n-nodes-base.httpRequest' ||
    send.parameters?.method !== 'POST' ||
    !send.parameters.url?.includes('/message/sendText/') ||
    send.parameters.genericAuthType !== 'httpHeaderAuth' ||
    !send.credentials?.httpHeaderAuth ||
    template.type !== 'n8n-nodes-base.code' ||
    !template.parameters?.jsCode?.includes("code: 'MEDIA_PREFLIGHT_REJECTED'")
  )
    throw new Error('EVOLUTION_RECIPIENT_CONTEXT_MISMATCH');
  const workflow = structuredClone(source);
  const check = {
    ...structuredClone(send),
    id: 'evolution-recipient-check',
    name: CHECK,
    position: [media.position[0] - 660, media.position[1]],
    retryOnFail: false,
    parameters: {
      ...structuredClone(send.parameters),
      url: send.parameters.url.replace(
        '/message/sendText/',
        '/chat/whatsappNumbers/',
      ),
      jsonBody: `={{ (()=>{const to=String($('${RESERVE}').item.json.command.to).replace(/^\\+/, '');if(!/^\\d{8,15}$/.test(to))throw new Error('EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE');return {numbers:[to]};})() }}`,
      options: {
        timeout: 4000,
        redirect: { redirect: { followRedirects: false } },
        response: { response: { responseFormat: 'json', fullResponse: true } },
      },
    },
    onError: 'continueErrorOutput',
  };
  delete check.maxTries;
  delete check.waitBetweenTries;
  const code = (
    /** @type {string} */ name,
    /** @type {string} */ id,
    /** @type {string} */ jsCode,
    /** @type {number} */ offset,
  ) => ({
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [media.position[0] - 440, media.position[1] + offset],
    parameters: { mode: 'runOnceForEachItem', jsCode },
  });
  const validate = {
    ...code(
      VALIDATE,
      'evolution-recipient-validate',
      `const registered=${evolutionRecipientRegistered.toString()};const to=String($('${RESERVE}').item.json.command.to).replace(/^\\+/, '');if($json.statusCode!==200)throw new Error('EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE');return {json:{registered:registered($json.body,to)}};`,
      0,
    ),
    onError: 'continueErrorOutput',
  };
  const allowed = {
    ...structuredClone(site),
    id: 'evolution-recipient-allowed',
    name: ALLOWED,
    position: [media.position[0] - 220, media.position[1]],
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
            id: 'evolution-recipient-exists',
            leftValue: '={{ $json.registered }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };
  const failure = (
    /** @type {string} */ name,
    /** @type {string} */ id,
    /** @type {string} */ failureCode,
    /** @type {number} */ offset,
  ) =>
    code(
      name,
      id,
      template.parameters.jsCode.replace(
        "code: 'MEDIA_PREFLIGHT_REJECTED'",
        `code: '${failureCode}'`,
      ),
      offset,
    );
  const nodes = [
    check,
    validate,
    allowed,
    failure(
      NOT_FOUND,
      'evolution-recipient-not-found',
      'EVOLUTION_RECIPIENT_NOT_FOUND',
      220,
    ),
    failure(
      UNAVAILABLE,
      'evolution-recipient-unavailable',
      'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
      440,
    ),
    {
      ...structuredClone(conclude),
      id: 'evolution-recipient-record',
      name: RECORD,
      position: [media.position[0] - 220, media.position[1] + 330],
    },
    {
      ...structuredClone(responder),
      id: 'evolution-recipient-reject',
      name: REJECT,
      position: [media.position[0], media.position[1] + 330],
      parameters: {
        respondWith: 'json',
        responseBody: `={{ { accepted: false, command_id: $('${RESERVE}').item.json.command.command_id } }}`,
        options: { responseCode: 422 },
      },
    },
  ];
  const expected = {
    [CHECK]: { main: [[edge(VALIDATE)], [edge(UNAVAILABLE)]] },
    [VALIDATE]: { main: [[edge(ALLOWED)], [edge(UNAVAILABLE)]] },
    [ALLOWED]: { main: [[edge(MEDIA)], [edge(NOT_FOUND)]] },
    [NOT_FOUND]: { main: [[edge(RECORD)]] },
    [UNAVAILABLE]: { main: [[edge(RECORD)]] },
    [RECORD]: { main: [[edge(REJECT)]] },
  };
  const existing = ADDED.filter((name) =>
    source.nodes.some((/** @type {any} */ n) => n.name === name),
  );
  if (existing.length) {
    if (
      existing.length !== ADDED.length ||
      JSON.stringify(source.connections[SITE]?.main?.[1]) !==
        JSON.stringify([edge(CHECK)]) ||
      nodes.some((n) => JSON.stringify(find(n.name)) !== JSON.stringify(n)) ||
      Object.entries(expected).some(
        ([name, value]) =>
          JSON.stringify(source.connections[name]) !== JSON.stringify(value),
      )
    )
      throw new Error('EVOLUTION_RECIPIENT_PATCH_CONTEXT_MISMATCH');
    return { workflow, changedNodeNames: [] };
  }
  if (
    JSON.stringify(source.connections[SITE]?.main?.[1]) !==
      JSON.stringify([edge(MEDIA)]) ||
    nodes.some((n) =>
      source.nodes.some((/** @type {any} */ old) => old.id === n.id),
    )
  )
    throw new Error('EVOLUTION_RECIPIENT_PATCH_CONTEXT_MISMATCH');
  workflow.nodes.push(...nodes);
  workflow.connections[SITE].main[1] = [edge(CHECK)];
  Object.assign(workflow.connections, expected);
  return { workflow, changedNodeNames: [SITE, ...ADDED] };
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
      'Usage: node evolution-recipient-preflight.mjs <export.json> <review.json>',
    );
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const sources = Array.isArray(input) ? input : [input];
  if (sources.length !== 1)
    throw new Error('EVOLUTION_RECIPIENT_SINGLE_WORKFLOW_REQUIRED');
  const result = patchEvolutionRecipientPreflight(sources[0]);
  await writeFile(
    outputPath,
    JSON.stringify(
      Array.isArray(input) ? [result.workflow] : result.workflow,
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ changedNodeNames: result.changedNodeNames }));
}
