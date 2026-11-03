import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTEXT = 'Montar contexto da IA (MVP)';
const DECISION = 'Normalizar decisão da IA (MVP)';
const INBOUND = 'CRM - Registrar inbound (MVP)';
const MODEL = 'OpenAI - Modelo do MVP';
const ELIGIBLE = 'Acompanhar intenção de compra? (OA)';
const VERSION = 'mvp-simple-21';
const AUDIO_TEMPLATES = Object.freeze({
  'WhatsApp - Consultar áudio interno (OA)': 'WhatsApp - Consultar mídia (MVP)',
  'WhatsApp - Baixar áudio interno (OA)': 'WhatsApp - Baixar mídia (MVP)',
  'Preparar áudio interno (OA)': 'Preparar mídia para a IA (MVP)',
  'OpenAI - Transcrever áudio interno (OA)': 'OpenAI - Transcrever áudio (MVP)',
});
/** @type {Readonly<Record<string, string>>} */
const REVIEWED_CODE_HASHES = Object.freeze({
  [CONTEXT]: '006da9a2c3de535615c8d46103b8e77a82325d7142956d38a3125fdf35fbb7a3',
  [DECISION]:
    '59ea6010bb501526f1e2e35b946705d8c42c8c30134cc02314e9c63047aca7bc',
});

/** @param {string} value */
export function orderAssistanceCodeHash(value) {
  return createHash('sha256')
    .update(value.replaceAll('\r\n', '\n'))
    .digest('hex');
}

/**
 * Keep the observation-only audio path on the same provider as the main path.
 * Called after each provider adapter has rewritten its own media nodes; old
 * workflows without OA nodes remain unchanged. Target IDs and edges survive.
 * @param {any} workflow
 */
export function synchronizeOrderAssistanceMedia(workflow) {
  for (const [targetName, templateName] of Object.entries(AUDIO_TEMPLATES)) {
    const targets = workflow.nodes.filter(
      (/** @type {any} */ item) => item.name === targetName,
    );
    if (!targets.length) continue;
    const templates = workflow.nodes.filter(
      (/** @type {any} */ item) => item.name === templateName,
    );
    if (targets.length !== 1 || templates.length !== 1)
      throw new Error('ORDER_ASSISTANCE_AUDIO_TEMPLATE_AMBIGUOUS');
    const target = targets[0];
    const template = templates[0];
    target.type = template.type;
    target.typeVersion = template.typeVersion;
    target.parameters = JSON.parse(
      JSON.stringify(template.parameters)
        .replaceAll(
          'WhatsApp - Consultar mídia (MVP)',
          'WhatsApp - Consultar áudio interno (OA)',
        )
        .replaceAll(
          'WhatsApp - Baixar mídia (MVP)',
          'WhatsApp - Baixar áudio interno (OA)',
        ),
    );
    if (template.credentials)
      target.credentials = structuredClone(template.credentials);
    else delete target.credentials;
    target.onError = 'continueErrorOutput';
    target.retryOnFail = false;
    delete target.maxTries;
    delete target.waitBetweenTries;
    if (target.type === 'n8n-nodes-base.httpRequest') {
      const limit = targetName.includes('Consultar') ? 15000 : 30000;
      const configured = Number(target.parameters.options?.timeout);
      target.parameters.options = {
        ...target.parameters.options,
        timeout:
          Number.isFinite(configured) && configured > 0
            ? Math.min(configured, limit)
            : limit,
      };
    }
  }
  return workflow;
}

/** @param {string} code @param {string} before @param {string} after */
function replaceOnce(code, before, after) {
  if (code.includes(after)) return code;
  if (
    !code.includes(before) ||
    code.indexOf(before) !== code.lastIndexOf(before)
  )
    throw new Error('ORDER_ASSISTANCE_PATCH_CONTEXT_MISMATCH');
  return code.replace(before, after);
}

/**
 * OA-T01: prepare only the reviewed policy and observation branch. Nothing is
 * imported, published or executed. Operational transport, IDs and credentials
 * are taken from this export. Any changed Code node requires a reviewed hash.
 * @param {any} source @param {any} canonical
 * @param {{reviewedCodeHashes?: Record<string,string>}} [options]
 */
export function patchOrderAssistance(source, canonical, options = {}) {
  if (
    (source?.id ?? source?.source?.workflowId) !== 'k7tI6T4RhQPyJkn9' ||
    !Array.isArray(source.nodes) ||
    !source.connections ||
    !source.settings ||
    !Array.isArray(canonical?.nodes)
  )
    throw new Error('ORDER_ASSISTANCE_WORKFLOW_INVALID');
  const result = structuredClone(source);
  const find = (/** @type {any} */ workflow, /** @type {string} */ name) => {
    const found = workflow.nodes.filter(
      (/** @type {any} */ candidate) => candidate.name === name,
    );
    if (found.length !== 1)
      throw new Error('ORDER_ASSISTANCE_NODE_MISSING_OR_AMBIGUOUS: ' + name);
    return found[0];
  };
  const changedNodeNames = [];
  for (const name of [CONTEXT, DECISION]) {
    const target = find(result, name);
    if (
      target.type !== 'n8n-nodes-base.code' ||
      typeof target.parameters?.jsCode !== 'string' ||
      !target.parameters.jsCode.includes('silmerGuardrail')
    )
      throw new Error('ORDER_ASSISTANCE_SECURITY_GUARD_REQUIRED');
    const code = target.parameters.jsCode.replaceAll('\r\n', '\n');
    const canonicalCode = find(canonical, name).parameters.jsCode.replaceAll(
      '\r\n',
      '\n',
    );
    const alreadyPatched =
      name === CONTEXT
        ? code.includes(
            'order_opening_policy: inbound.order_opening_policy ?? null,',
          )
        : code.includes(
            "const humanOrderConfirmation = context.order_opening_policy === 'human_confirmation';",
          );
    if (!alreadyPatched) {
      const expected =
        options.reviewedCodeHashes?.[name] ?? REVIEWED_CODE_HASHES[name];
      if (orderAssistanceCodeHash(code) !== expected)
        throw new Error('ORDER_ASSISTANCE_CODE_DRIFT: ' + name);
    } else if (
      code !== canonicalCode &&
      orderAssistanceCodeHash(code) !== options.reviewedCodeHashes?.[name]
    ) {
      throw new Error('ORDER_ASSISTANCE_PATCHED_CODE_DRIFT: ' + name);
    }
    const patched =
      name === CONTEXT
        ? replaceOnce(
            code,
            '  source_revision: inbound.source_revision,',
            '  source_revision: inbound.source_revision,\n  order_opening_policy: inbound.order_opening_policy ?? null,',
          )
        : replaceOnce(
            replaceOnce(
              code,
              'const openOrder = legacyContext',
              "const humanOrderConfirmation = context.order_opening_policy === 'human_confirmation';\nconst openOrder = humanOrderConfirmation ? false : legacyContext",
            ),
            'briefing_patch: unsafeTarget || (!legacyContext && !context.target_subject_id && !openOrder) ? null : patch,',
            'briefing_patch: unsafeTarget || (!humanOrderConfirmation && !legacyContext && !context.target_subject_id && !openOrder) ? null : patch,',
          );
    if (patched !== code) changedNodeNames.push(name);
    target.parameters.jsCode = patched;
  }
  const inbound = find(result, INBOUND);
  const model = find(result, MODEL);
  if (
    !inbound.credentials?.httpBasicAuth ||
    !model.credentials?.openAiApi ||
    typeof inbound.parameters?.url !== 'string'
  )
    throw new Error('ORDER_ASSISTANCE_OPERATIONAL_BINDING_REQUIRED');
  const observerNodes = canonical.nodes.filter((/** @type {any} */ item) =>
    item.name.endsWith('(OA)'),
  );
  if (observerNodes.length !== 20)
    throw new Error('ORDER_ASSISTANCE_CANONICAL_BRANCH_CHANGED');
  const observerNames = new Set(
    observerNodes.map((/** @type {any} */ item) => item.name),
  );
  const existingCount = result.nodes.filter((/** @type {any} */ item) =>
    observerNames.has(item.name),
  ).length;
  if (existingCount !== 0 && existingCount !== observerNodes.length)
    throw new Error('ORDER_ASSISTANCE_PARTIAL_BRANCH');
  for (const original of observerNodes) {
    const audioTemplate = /** @type {Record<string,string>} */ (
      AUDIO_TEMPLATES
    )[original.name];
    const prepared = structuredClone(
      audioTemplate ? find(source, audioTemplate) : original,
    );
    prepared.name = original.name;
    prepared.position = structuredClone(original.position);
    if (audioTemplate) {
      prepared.parameters = JSON.parse(
        JSON.stringify(prepared.parameters)
          .replaceAll(
            'WhatsApp - Consultar mídia (MVP)',
            'WhatsApp - Consultar áudio interno (OA)',
          )
          .replaceAll(
            'WhatsApp - Baixar mídia (MVP)',
            'WhatsApp - Baixar áudio interno (OA)',
          ),
      );
      prepared.onError = 'continueErrorOutput';
      prepared.retryOnFail = false;
      delete prepared.maxTries;
      delete prepared.waitBetweenTries;
      if (prepared.type === 'n8n-nodes-base.httpRequest') {
        const limit = original.name.includes('Consultar') ? 15000 : 30000;
        const configured = Number(prepared.parameters.options?.timeout);
        prepared.parameters.options = {
          ...prepared.parameters.options,
          timeout:
            Number.isFinite(configured) && configured > 0
              ? Math.min(configured, limit)
              : limit,
        };
      }
    }
    const present = existingCount ? find(result, original.name) : null;
    if (source.nodes.some((/** @type {any} */ item) => item.id))
      prepared.id = present?.id ?? randomUUID();
    if (!audioTemplate && prepared.type === 'n8n-nodes-base.httpRequest') {
      prepared.credentials = structuredClone(inbound.credentials);
      prepared.parameters.url = inbound.parameters.url.replace(
        '/messages/inbound',
        original.name.includes('Reler') ? '/messages/inbound' : '/events',
      );
      if (
        original.name.includes('Registrar') &&
        prepared.parameters.url === inbound.parameters.url
      )
        throw new Error('ORDER_ASSISTANCE_CRM_URL_CONTEXT_MISMATCH');
    } else if (prepared.type === '@n8n/n8n-nodes-langchain.lmChatOpenAi') {
      prepared.credentials = structuredClone(model.credentials);
    }
    if (present) {
      if (JSON.stringify(present) !== JSON.stringify(prepared))
        throw new Error('ORDER_ASSISTANCE_OBSERVER_DRIFT: ' + original.name);
    } else {
      result.nodes.push(prepared);
      changedNodeNames.push(prepared.name);
    }
  }
  for (const name of observerNames) {
    if (canonical.connections[name])
      result.connections[name] = structuredClone(canonical.connections[name]);
  }
  const outgoing = result.connections[INBOUND]?.main?.[0];
  if (!Array.isArray(outgoing))
    throw new Error('ORDER_ASSISTANCE_INBOUND_CONNECTION_MISSING');
  if (!outgoing.some((/** @type {any} */ edge) => edge.node === ELIGIBLE))
    outgoing.push({ node: ELIGIBLE, type: 'main', index: 0 });
  for (const target of result.nodes) {
    for (const header of target.parameters?.headerParameters?.parameters ??
      []) {
      if (
        header.name === 'X-Silmer-Workflow-Version' &&
        /^mvp-simple-\d+$/u.test(header.value)
      )
        header.value = VERSION;
    }
  }
  result.settings.executionTimeout = Math.max(
    180,
    Number(result.settings.executionTimeout ?? 0),
  );
  delete result.pinData;
  return { workflow: result, changedNodeNames };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath))
    throw new Error('Distinct input and candidate paths required');
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const canonical = JSON.parse(
    await readFile(
      new URL(
        './workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const candidate = patchOrderAssistance(source, canonical);
  await writeFile(
    outputPath,
    JSON.stringify(candidate.workflow, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      prepared: true,
      changedNodeNames: candidate.changedNodeNames,
      published: false,
    }) + '\n',
  );
}
