import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  normalizeBillingInput,
  normalizeDevelopmentBillingInput,
  verifiedBillingPayment,
} from './create-order-billing-workflow.mjs';

/** Check requests contain an opaque CRM identity, never a payment assertion.
 * @param {any} body @param {any} config @param {boolean} [development] */
export function normalizeBillingCheckInput(body, config, development = false) {
  if (
    !body ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !['schema_version', 'check_id'].includes(key),
    )
  )
    throw new Error('BILLING_CHECK_INPUT_INVALID');
  const mapped = {
    schema_version: body.schema_version,
    charge_id: body.check_id,
  };
  const result = development
    ? normalizeDevelopmentBillingInput(mapped, config)
    : normalizeBillingInput(mapped, config);
  const { chargeId, ...common } = result;
  return { ...common, checkId: chargeId };
}

/** A separate inactive workflow preserves the issued-link workflow byte-for-byte.
 * Only this lookup/check/result chain is added for recovery of missed notices.
 * @param {{crmBaseUrl?:string,handle?:string,webhookUrl?:string,gatewayBaseUrl?:string}} [configuration]
 * @param {{development?:boolean}} [options] */
export function createOrderBillingCheckWorkflow(
  configuration = {},
  options = {},
) {
  const development = options.development === true;
  if (
    !configuration ||
    Array.isArray(configuration) ||
    Object.keys(configuration).some(
      (key) =>
        ![
          'crmBaseUrl',
          'handle',
          'webhookUrl',
          ...(development ? ['gatewayBaseUrl'] : []),
        ].includes(key),
    )
  )
    throw new Error('BILLING_CHECK_CONFIGURATION_INVALID');
  const config = development
    ? {
        crmBaseUrl: 'http://billing-crm:3000',
        gatewayBaseUrl: 'http://billing-simulator:8080',
        webhookUrl: 'http://n8n:5678/webhook/silmer/order-billing-dev/paid',
        handle: 'synthetic-billing',
        ...configuration,
      }
    : { crmBaseUrl: '', webhookUrl: '', handle: '', ...configuration };
  if (
    Object.values(config).some(
      (value) =>
        typeof value !== 'string' ||
        value.length > 2048 ||
        /\{\{|\}\}|Basic |Bearer |inchk_/iu.test(value),
    )
  )
    throw new Error('BILLING_CHECK_CONFIGURATION_INVALID');
  if (development)
    normalizeBillingCheckInput(
      {
        schema_version: '1.0',
        check_id: '50c242cc-7a80-48a0-b2ce-750807589e17',
      },
      config,
      true,
    );
  /** @type {any[]} */ const nodes = [];
  /** @type {Record<string,any>} */ const connections = {};
  const suffix = development ? ' DEV' : '';
  function add(
    /** @type {string} */ name,
    /** @type {string} */ type,
    /** @type {any} */ parameters,
    /** @type {any} */ extra = {},
  ) {
    nodes.push({
      id: `billing-check-${development ? 'dev' : 'prod'}-${nodes.length}`,
      name,
      type: `n8n-nodes-base.${type}`,
      typeVersion:
        type === 'httpRequest'
          ? 4.2
          : type === 'if'
            ? 2.2
            : type === 'set'
              ? 3.4
              : type === 'respondToWebhook'
                ? 1.4
                : 2,
      position: [nodes.length * 240, 0],
      parameters,
      ...extra,
    });
    return name;
  }
  function connect(
    /** @type {string} */ from,
    /** @type {string} */ to,
    branch = 0,
  ) {
    connections[from] ??= { main: [] };
    connections[from].main[branch] ??= [];
    connections[from].main[branch].push({ node: to, type: 'main', index: 0 });
  }
  const trigger = add(
    'Receber conferência autorizada',
    'webhook',
    {
      httpMethod: 'POST',
      path: development
        ? 'silmer/order-billing-dev/check'
        : 'silmer/order-billing/check',
      authentication: 'basicAuth',
      responseMode: 'responseNode',
      options: {},
    },
    {
      webhookId: development
        ? '2c6144b4-e909-4777-9614-3fb1e098ef64'
        : '48b34240-0a48-4b55-ab6c-cde4d4d259d0',
      credentials: {
        httpBasicAuth: { name: 'Silmer CRM para n8n Basic' + suffix },
      },
    },
  );
  const configure = add('Configurar conferência sem segredos', 'set', {
    mode: 'raw',
    jsonOutput: JSON.stringify({ billingConfig: config }),
    includeOtherFields: true,
    options: {},
  });
  const normalized = add('Validar identidade da conferência', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const normalizeBillingInput=${normalizeBillingInput.toString()};const normalizeDevelopmentBillingInput=${normalizeDevelopmentBillingInput.toString()};const normalize=${normalizeBillingCheckInput.toString()};return {json:normalize($json.body,$json.billingConfig,${development})};`,
  });
  function crm(
    /** @type {string} */ name,
    /** @type {string} */ url,
    method = 'GET',
    body = '={{ ({}) }}',
    key = `={{ $('${normalized}').first().json.checkId + ':' + $execution.id }}`,
  ) {
    return add(
      name,
      'httpRequest',
      {
        method,
        url,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            {
              name: 'X-Correlation-Id',
              value: `={{ $('${normalized}').first().json.checkId }}`,
            },
            { name: 'Idempotency-Key', value: key },
            { name: 'X-Silmer-Workflow-Key', value: 'silmer-order-billing' },
            {
              name: 'X-Silmer-Workflow-Version',
              value: 'order-billing-check-1',
            },
            { name: 'X-Silmer-Execution-Id', value: '={{ $execution.id }}' },
          ],
        },
        ...(method === 'POST'
          ? {
              sendBody: true,
              contentType: 'json',
              specifyBody: 'json',
              jsonBody: body,
            }
          : {}),
        options: {
          timeout: 5000,
          redirect: { redirect: { followRedirects: false } },
          response: { response: { responseFormat: 'json' } },
        },
      },
      {
        credentials: {
          httpBasicAuth: { name: 'Silmer n8n para CRM Basic' + suffix },
        },
        retryOnFail: false,
      },
    );
  }
  const candidate = crm(
    'Consultar conferência conhecida no CRM',
    `={{ $('${normalized}').first().json.crmBaseUrl + '/api/v1/integrations/n8n/billing/payment-checks/' + $('${normalized}').first().json.checkId }}`,
  );
  const check = add(
    'InfinitePay consultar pagamento',
    'httpRequest',
    {
      method: 'POST',
      url: development
        ? `={{ $('${normalized}').first().json.gatewayBaseUrl + '/payment_check' }}`
        : 'https://api.checkout.infinitepay.io/payment_check',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: `={{ ({handle:$('${normalized}').first().json.handle,order_nsu:$('${candidate}').first().json.chargeId,slug:$('${candidate}').first().json.invoiceSlug,transaction_nsu:$('${candidate}').first().json.transactionNsu}) }}`,
      options: {
        timeout: 15000,
        redirect: { redirect: { followRedirects: false } },
        response: { response: { responseFormat: 'json' } },
      },
    },
    {
      credentials: {
        httpHeaderAuth: { name: 'InfinitePay Checkout API Key' + suffix },
      },
      retryOnFail: false,
    },
  );
  const unpaid = add('Pagamento verificado ainda pendente', 'if', {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'unpaid',
          leftValue: '={{ $json.success === true && $json.paid === false }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  });
  const verify = add('Validar pagamento confirmado', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const verify=${verifiedBillingPayment.toString()};const candidate=$('${candidate}').first().json;return {json:verify($json,candidate,{chargeId:candidate.chargeId,amountCents:candidate.amountCents})};`,
  });
  const received = crm(
    'Persistir pagamento recuperado no CRM',
    `={{ $('${normalized}').first().json.crmBaseUrl + '/api/v1/integrations/n8n/billing/charges/' + $('${candidate}').first().json.chargeId + '/payment' }}`,
    'POST',
    '={{ $json }}',
    `={{ $('${candidate}').first().json.transactionNsu }}`,
  );
  const resultUrl = `={{ $('${normalized}').first().json.crmBaseUrl + '/api/v1/integrations/n8n/billing/payment-checks/' + $('${normalized}').first().json.checkId + '/result' }}`;
  const paidResult = crm(
    'Registrar conferência paga',
    resultUrl,
    'POST',
    "={{ ({status:'paid'}) }}",
  );
  const unpaidResult = crm(
    'Registrar conferência pendente',
    resultUrl,
    'POST',
    "={{ ({status:'not_paid'}) }}",
  );
  const ack = add(
    'Confirmar somente após resultado durável',
    'respondToWebhook',
    {
      respondWith: 'json',
      responseBody: '={{ ({accepted:true}) }}',
      options: { responseCode: 200 },
    },
  );
  connect(trigger, configure);
  connect(configure, normalized);
  connect(normalized, candidate);
  connect(candidate, check);
  connect(check, unpaid);
  connect(unpaid, unpaidResult, 0);
  connect(unpaid, verify, 1);
  connect(verify, received);
  connect(received, paidResult);
  connect(paidResult, ack);
  connect(unpaidResult, ack);
  return {
    name: `${development ? 'DEV | ' : ''}Silmer | CRM | Conferir pagamentos InfinitePay`,
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      timezone: 'America/Sao_Paulo',
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveExecutionProgress: false,
      saveManualExecutions: false,
    },
    meta: { templateCredsSetupCompleted: false },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [destination, configPath, profile, ...extra] = process.argv.slice(2);
  if (
    !destination?.endsWith('.json') ||
    extra.length ||
    !['development', 'production', undefined].includes(profile)
  )
    throw new Error(
      'Usage: node create-order-billing-check-workflow.mjs <destination.json> [config.json] [development|production]',
    );
  const configuration = configPath
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : {};
  await writeFile(
    destination,
    JSON.stringify(
      createOrderBillingCheckWorkflow(configuration, {
        development: profile === 'development',
      }),
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    'Inactive payment-check workflow written. Bind private credentials before activation.\n',
  );
}
