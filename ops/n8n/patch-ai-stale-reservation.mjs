import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUEST = 'CRM - Reservar envio da IA (MVP)';
const VALIDATE = 'CRM - Validar reserva da IA (MVP)';
const VALIDATE_ID = 'crm-ai-reservation-response';

/**
 * OPS-INBOX-SEND-08: a rejected obsolete turn is a completed no-op, never
 * another permission to send. All other errors remain workflow failures.
 * Remote bodies and headers never enter thrown diagnostics.
 * @param {any} response @returns {Record<string, any> | null}
 */
export function unwrapAiReservationResponse(response) {
  const status = response?.statusCode;
  const body = response?.body;
  const objectBody = body && typeof body === 'object' && !Array.isArray(body);
  if (
    status === 409 &&
    objectBody &&
    body.status === 409 &&
    body.accepted === false &&
    body.error?.code === 'STALE_AUTOMATION_FENCE' &&
    body.type === 'urn:silmer:problem:stale_automation_fence'
  )
    return null;
  if (
    (status === 200 || status === 202) &&
    objectBody &&
    body.accepted === true &&
    typeof body.send_authorized === 'boolean'
  )
    return body;
  if (Number.isInteger(status) && status >= 400 && status <= 599)
    throw new Error(`AI_RESERVATION_HTTP_${status}`);
  throw new Error('AI_RESERVATION_RESPONSE_INVALID');
}

const VALIDATE_CODE =
  '// OPS-INBOX-SEND-08: discard only the closed stale-fence rejection.\n' +
  `const unwrap=${unwrapAiReservationResponse.toString()};\n` +
  'return $input.all().flatMap((item,index)=>{const body=unwrap(item.json);return body===null?[]:[{json:body,pairedItem:{item:index}}];});';

const edge = () => ({ node: VALIDATE, type: 'main', index: 0 });

/**
 * Prepare one current private export offline. No workflow is executed or
 * published, and no domain, credential or unrelated branch is rewritten.
 * @param {any} source
 * @returns {{workflow:any,changedNodeNames:string[]}}
 */
export function patchAiStaleReservation(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('AI_RESERVATION_WORKFLOW_INVALID');
  const requests = source.nodes.filter(
    (/** @type {any} */ node) => node.name === REQUEST,
  );
  if (requests.length !== 1)
    throw new Error('AI_RESERVATION_REQUEST_MISSING_OR_AMBIGUOUS');
  const request = requests[0];
  if (
    request.type !== 'n8n-nodes-base.httpRequest' ||
    request.parameters?.method !== 'POST' ||
    request.parameters.authentication !== 'genericCredentialType' ||
    request.parameters.genericAuthType !== 'httpBasicAuth' ||
    !request.credentials?.httpBasicAuth ||
    typeof request.parameters.url !== 'string' ||
    !request.parameters.url.includes('/api/v1/integrations/n8n/events') ||
    request.parameters.options?.response?.response?.responseFormat !== 'json' ||
    request.onError ||
    request.continueOnFail ||
    !Array.isArray(request.position) ||
    request.position.length !== 2
  )
    throw new Error('AI_RESERVATION_REQUEST_CONTEXT_MISMATCH');

  // The original node becomes an HTTP envelope. Fail closed if another node
  // reads its old JSON by name; only the rewired edges receive the unwrapped body.
  const escapedName = REQUEST.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const namedLookup = new RegExp(
    String.raw`\$\s*\(\s*['"]${escapedName}['"]\s*\)|\$node\s*\[\s*['"]${escapedName}['"]\s*\]`,
    'u',
  );
  const referencesRequest = (/** @type {any} */ value) => {
    if (typeof value === 'string') return namedLookup.test(value);
    if (value && typeof value === 'object')
      return Object.values(value).some(referencesRequest);
    return false;
  };
  if (
    source.nodes.some(
      (/** @type {any} */ node) =>
        node.name !== REQUEST &&
        node.name !== VALIDATE &&
        referencesRequest(node.parameters),
    )
  )
    throw new Error('AI_RESERVATION_NAMED_REFERENCE_UNSUPPORTED');

  const validators = source.nodes.filter(
    (/** @type {any} */ node) =>
      node.name === VALIDATE || node.id === VALIDATE_ID,
  );
  const responseOptions = request.parameters.options.response.response;
  const expectedValidator = {
    id: VALIDATE_ID,
    name: VALIDATE,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [request.position[0] + 120, request.position[1] + 140],
    parameters: { mode: 'runOnceForAllItems', jsCode: VALIDATE_CODE },
  };
  const requestEdges = source.connections[REQUEST];
  const validEdges = (/** @type {any} */ edges) =>
    edges &&
    Object.keys(edges).join(',') === 'main' &&
    Array.isArray(edges.main) &&
    edges.main.length === 1 &&
    Array.isArray(edges.main[0]) &&
    edges.main[0].length > 0 &&
    edges.main[0].every(
      (/** @type {any} */ connection) =>
        connection.type === 'main' &&
        connection.index === 0 &&
        source.nodes.filter(
          (/** @type {any} */ node) => node.name === connection.node,
        ).length === 1,
    );
  if (!validEdges(requestEdges))
    throw new Error('AI_RESERVATION_CONNECTION_CONTEXT_MISMATCH');
  const workflow = structuredClone(source);
  if (validators.length) {
    if (
      validators.length !== 1 ||
      JSON.stringify(validators[0]) !== JSON.stringify(expectedValidator) ||
      JSON.stringify(requestEdges) !== JSON.stringify({ main: [[edge()]] }) ||
      !validEdges(source.connections[VALIDATE]) ||
      source.connections[VALIDATE].main[0].some(
        (/** @type {any} */ connection) => connection.node === VALIDATE,
      ) ||
      request.retryOnFail !== false ||
      request.maxTries !== undefined ||
      request.waitBetweenTries !== undefined ||
      responseOptions.fullResponse !== true ||
      responseOptions.neverError !== true
    )
      throw new Error('AI_RESERVATION_PATCH_CONTEXT_MISMATCH');
    return { workflow, changedNodeNames: [] };
  }
  if (
    source.connections[VALIDATE] ||
    responseOptions.fullResponse === true ||
    responseOptions.neverError === true
  )
    throw new Error('AI_RESERVATION_PATCH_CONTEXT_MISMATCH');
  const patched = workflow.nodes.find(
    (/** @type {any} */ node) => node.name === REQUEST,
  );
  patched.retryOnFail = false;
  delete patched.maxTries;
  delete patched.waitBetweenTries;
  Object.assign(patched.parameters.options.response.response, {
    fullResponse: true,
    neverError: true,
  });
  workflow.nodes.push(expectedValidator);
  workflow.connections[REQUEST] = { main: [[edge()]] };
  workflow.connections[VALIDATE] = structuredClone(requestEdges);
  return { workflow, changedNodeNames: [REQUEST, VALIDATE] };
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
      'Usage: node patch-ai-stale-reservation.mjs <export.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const workflows = Array.isArray(source) ? source : [source];
  if (workflows.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const { workflow, changedNodeNames } = patchAiStaleReservation(workflows[0]);
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [workflow] : workflow, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ changedNodeNames }) + '\n');
}
