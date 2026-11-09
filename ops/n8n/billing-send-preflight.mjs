import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MEDIA = 'Mensagem humana tem midia? (MVP)';
const SEND = 'WhatsApp - Enviar texto humano (MVP)';
const RESERVE = 'Preparar reserva de envio humano (MVP)';
const REQUIRED = 'Texto humano e cobranca? (MVP)';
const CHECK = 'CRM - Preflight cobranca reservada (MVP)';
const VALIDATE = 'Validar preflight de cobranca (MVP)';
const FAILURE = 'Falha de preflight da midia (MVP)';
const ADDED = [REQUIRED, CHECK, VALIDATE];
const edge = (/** @type {string} */ node) => ({ node, type: 'main', index: 0 });

/** BAPI-07/09/10: fail closed on anything except explicit CRM authorization.
 * @param {any} response @returns {boolean}
 */
export function billingSendPreflightValid(response) {
  return response?.valid === true;
}

/** Add the final CRM guard only to billing text in the reserved human path.
 * Credentials, execution identity, provider calls and other branches are kept.
 * Existing authenticated before_message_send failure concludes safe rejection.
 * @param {any} source @returns {{workflow:any, changedNodeNames:string[]}}
 */
export function patchBillingSendPreflight(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('BILLING_PREFLIGHT_WORKFLOW_INVALID');
  const find = (/** @type {string} */ name) => {
    const matches = source.nodes.filter(
      (/** @type {any} */ n) => n.name === name,
    );
    if (matches.length !== 1)
      throw new Error('BILLING_PREFLIGHT_NODE_MISSING_OR_AMBIGUOUS');
    return matches[0];
  };
  const media = find(MEDIA);
  const template = find('CRM - Preflight midia reservada (MVP)');
  const failure = find(FAILURE);
  find(RESERVE);
  find(SEND);
  const url = template.parameters?.url;
  if (
    media.type !== 'n8n-nodes-base.if' ||
    template.type !== 'n8n-nodes-base.httpRequest' ||
    // n8n omits the HTTP Request node's default GET method on export.
    (template.parameters?.method !== undefined &&
      template.parameters.method !== 'GET') ||
    template.parameters?.genericAuthType !== 'httpBasicAuth' ||
    typeof url !== 'string' ||
    !url.includes('/media?preflight=true') ||
    failure.type !== 'n8n-nodes-base.code' ||
    !failure.parameters?.jsCode?.includes("code: 'MEDIA_PREFLIGHT_REJECTED'") ||
    !failure.parameters.jsCode.includes("phase: 'before_message_send'") ||
    source.connections[FAILURE]?.main?.[0]?.[0]?.node !==
      'CRM - Concluir falha anterior ao envio (MVP)'
  )
    throw new Error('BILLING_PREFLIGHT_CONTEXT_MISMATCH');
  const required = {
    ...structuredClone(media),
    id: 'billing-send-preflight-required',
    name: REQUIRED,
    position: [media.position[0] + 220, media.position[1] + 220],
    parameters: {
      conditions: {
        ...structuredClone(media.parameters.conditions),
        conditions: [
          {
            leftValue: `={{ $('${RESERVE}').item.json.command.billing_send === true }}`,
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
      },
      options: {},
    },
  };
  const check = {
    ...structuredClone(template),
    id: 'billing-send-preflight-check',
    name: CHECK,
    position: [media.position[0] + 440, media.position[1] + 220],
    retryOnFail: false,
    onError: 'continueErrorOutput',
    parameters: {
      ...structuredClone(template.parameters),
      method: 'GET',
      url: url.replace('/media?preflight=true', '/preflight'),
      options: {
        timeout: 10000,
        redirect: { redirect: { followRedirects: false } },
        response: { response: { responseFormat: 'json' } },
      },
    },
  };
  delete check.maxTries;
  delete check.waitBetweenTries;
  const validate = {
    id: 'billing-send-preflight-validate',
    name: VALIDATE,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [media.position[0] + 660, media.position[1] + 220],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const valid=${billingSendPreflightValid.toString()};if(!valid($json))throw new Error('MEDIA_PREFLIGHT_REJECTED');return {json:{valid:true}};`,
    },
  };
  const nodes = [required, check, validate];
  const expected = {
    [REQUIRED]: { main: [[edge(CHECK)], [edge(SEND)]] },
    [CHECK]: { main: [[edge(VALIDATE)], [edge(FAILURE)]] },
    [VALIDATE]: { main: [[edge(SEND)], [edge(FAILURE)]] },
  };
  const workflow = structuredClone(source);
  const existing = ADDED.filter((name) =>
    source.nodes.some((/** @type {any} */ n) => n.name === name),
  );
  if (existing.length) {
    if (
      existing.length !== ADDED.length ||
      JSON.stringify(source.connections[MEDIA]?.main?.[1]) !==
        JSON.stringify([edge(REQUIRED)]) ||
      nodes.some((n) => JSON.stringify(find(n.name)) !== JSON.stringify(n)) ||
      Object.entries(expected).some(
        ([name, value]) =>
          JSON.stringify(source.connections[name]) !== JSON.stringify(value),
      )
    )
      throw new Error('BILLING_PREFLIGHT_PATCH_CONTEXT_MISMATCH');
    return { workflow, changedNodeNames: [] };
  }
  if (
    JSON.stringify(source.connections[MEDIA]?.main?.[1]) !==
      JSON.stringify([edge(SEND)]) ||
    nodes.some((n) =>
      source.nodes.some((/** @type {any} */ old) => old.id === n.id),
    )
  )
    throw new Error('BILLING_PREFLIGHT_PATCH_CONTEXT_MISMATCH');
  workflow.nodes.push(...nodes);
  workflow.connections[MEDIA].main[1] = [edge(REQUIRED)];
  Object.assign(workflow.connections, expected);
  return { workflow, changedNodeNames: [MEDIA, ...ADDED] };
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
      'Usage: node billing-send-preflight.mjs <export.json> <review.json>',
    );
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const sources = Array.isArray(input) ? input : [input];
  if (sources.length !== 1)
    throw new Error('BILLING_PREFLIGHT_SINGLE_WORKFLOW_REQUIRED');
  const result = patchBillingSendPreflight(sources[0]);
  await writeFile(
    outputPath,
    JSON.stringify(
      Array.isArray(input) ? [result.workflow] : result.workflow,
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ changedNodeNames: result.changedNodeNames }));
}
