import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ORDER_BILLING_WORKFLOW_KEY = 'silmer-order-billing';
export const ORDER_BILLING_WORKFLOW_VERSION = 'order-billing-1';

/** Validate before any external call. This function is embedded in n8n.
 * @param {any} body @param {any} config @param {'command'|'payment'} [mode] */
export function normalizeBillingInput(body, config, mode = 'command') {
  const https = /^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9/_-]*)?$/i;
  const base = String(config.crmBaseUrl ?? '').replace(/\/$/, '');
  const webhook = String(config.webhookUrl ?? '');
  const handle = String(config.handle ?? '');
  if (
    !https.test(base) ||
    !https.test(webhook) ||
    !/^[a-z0-9_-]{1,128}$/i.test(handle)
  ) {
    throw new Error('BILLING_CONFIGURATION_INVALID');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('BILLING_INPUT_INVALID');
  }
  let bytes = 0;
  for (const char of JSON.stringify(body)) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > 16384) throw new Error('BILLING_INPUT_INVALID');
  }
  const chargeId = mode === 'command' ? body.charge_id : body.order_nsu;
  if (
    typeof chargeId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      chargeId,
    )
  ) {
    throw new Error('BILLING_CHARGE_ID_INVALID');
  }
  const common = { chargeId, crmBaseUrl: base, webhookUrl: webhook, handle };
  if (mode === 'command') {
    if (
      body.schema_version !== '1.0' ||
      Object.keys(body).some(
        (key) => !['schema_version', 'charge_id'].includes(key),
      )
    ) {
      throw new Error('BILLING_COMMAND_INVALID');
    }
    return common;
  }
  const invoiceSlug = body.invoice_slug;
  const transactionNsu = body.transaction_nsu;
  for (const value of [invoiceSlug, transactionNsu]) {
    if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value)) {
      throw new Error('BILLING_PAYMENT_ID_INVALID');
    }
  }
  const receiptUrl = body.receipt_url ?? null;
  if (
    receiptUrl !== null &&
    (typeof receiptUrl !== 'string' ||
      receiptUrl.length > 4096 ||
      !/^https:\/\/(?:[a-z0-9-]+\.)*(?:infinitepay\.io|infinitepay\.com\.br)\/[^\s#]*$/i.test(
        receiptUrl,
      ))
  ) {
    throw new Error('BILLING_RECEIPT_URL_INVALID');
  }
  return { ...common, invoiceSlug, transactionNsu, receiptUrl };
}

/** The webhook contributes only identifiers, never proof of payment.
 * @param {any} check @param {any} candidate @param {any} charge */
export function verifiedBillingPayment(check, candidate, charge) {
  if (
    !charge ||
    charge.chargeId !== candidate.chargeId ||
    !Number.isSafeInteger(charge.amountCents) ||
    charge.amountCents < 100
  ) {
    throw new Error('BILLING_CHARGE_UNKNOWN');
  }
  if (check?.success !== true || check.paid !== true) {
    throw new Error('BILLING_PAYMENT_NOT_CONFIRMED');
  }
  if (
    !Number.isSafeInteger(check.amount) ||
    check.amount !== charge.amountCents ||
    !Number.isSafeInteger(check.paid_amount) ||
    check.paid_amount < charge.amountCents
  ) {
    throw new Error('BILLING_PAYMENT_AMOUNT_MISMATCH');
  }
  if (
    !['pix', 'credit_card'].includes(check.capture_method) ||
    !Number.isInteger(check.installments) ||
    check.installments < 1 ||
    check.installments > 12 ||
    (check.capture_method === 'pix' && check.installments !== 1)
  ) {
    throw new Error('BILLING_PAYMENT_METHOD_INVALID');
  }
  return {
    transactionNsu: candidate.transactionNsu,
    invoiceSlug: candidate.invoiceSlug,
    amountCents: check.amount,
    paidAmountCents: check.paid_amount,
    method: check.capture_method,
    installments: check.installments,
    receiptUrl: candidate.receiptUrl,
  };
}

/** One payload, created only after a unique CRM reservation.
 * @param {any} reservation @param {any} config */
export function billingCheckoutPayload(reservation, config) {
  if (
    reservation?.allowed !== true ||
    reservation.chargeId !== config.chargeId ||
    !Number.isSafeInteger(reservation.amountCents) ||
    reservation.amountCents < 100 ||
    typeof reservation.description !== 'string' ||
    !reservation.description.trim() ||
    reservation.description.length > 160 ||
    !Number.isFinite(Date.parse(reservation.validUntil)) ||
    Date.parse(reservation.validUntil) <= Date.now() ||
    Date.parse(reservation.validUntil) - Date.now() > 365 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('BILLING_RESERVATION_INVALID');
  }
  return {
    handle: config.handle,
    order_nsu: reservation.chargeId,
    items: [
      {
        quantity: 1,
        price: reservation.amountCents,
        description: reservation.description,
      },
    ],
    webhook_url: config.webhookUrl,
    options: {
      single_payment: true,
      valid_until: reservation.validUntil,
      payment_methods_enabled: ['pix', 'credit_card'],
    },
  };
}

/** A returned URL is private; validate it before sending it back to the CRM.
 * @param {any} response */
export function billingCreatedResult(response) {
  const value = response?.url;
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^https:\/\/(?:[a-z0-9-]+\.)*(?:infinitepay\.io|infinitepay\.com\.br)\/[^\s#]*$/i.test(
      value,
    )
  ) {
    throw new Error('BILLING_CHECKOUT_URL_INVALID');
  }
  return { checkoutUrl: value };
}

/**
 * Offline, inactive export. Operators bind three credentials after import:
 * CRM -> n8n Basic, n8n -> CRM Basic, InfinitePay X-Api-Key header.
 * Community-compatible Edit Fields nodes hold only public configuration.
 * Default values are empty; no license, environment access or custom vars.
 * @param {{crmBaseUrl?:string,handle?:string,webhookUrl?:string}} [configuration]
 */
export function createOrderBillingWorkflow(configuration = {}) {
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    Object.keys(configuration).some(
      (key) => !['crmBaseUrl', 'handle', 'webhookUrl'].includes(key),
    )
  )
    throw new TypeError('Only non-secret billing configuration is accepted');
  const publicConfiguration = {
    crmBaseUrl: configuration.crmBaseUrl ?? '',
    handle: configuration.handle ?? '',
    webhookUrl: configuration.webhookUrl ?? '',
  };
  if (
    Object.values(publicConfiguration).some(
      (value) =>
        typeof value !== 'string' ||
        value.length > 2048 ||
        /\{\{|\}\}|inchk_|Bearer |Basic /iu.test(value),
    )
  )
    throw new TypeError(
      'Only fixed non-secret billing configuration is accepted',
    );
  /** @type {any[]} */
  const nodes = [];
  /** @type {Record<string,any>} */
  const connections = {};
  let sequence = 0;
  /** @param {string} name @param {string} type @param {any} parameters @param {any} [extra] */
  function add(name, type, parameters, extra = {}) {
    const node = {
      id: `order-billing-${++sequence}`,
      name,
      type: `n8n-nodes-base.${type}`,
      typeVersion:
        type === 'httpRequest'
          ? 4.2
          : type === 'if'
            ? 2.2
            : type === 'respondToWebhook'
              ? 1.4
              : type === 'set'
                ? 3.4
                : 2,
      position: [sequence * 240, 0],
      parameters,
      ...extra,
    };
    nodes.push(node);
    return name;
  }
  /** @param {string} from @param {string} to @param {number} [branch] */
  function connect(from, to, branch = 0) {
    connections[from] ??= { main: [] };
    connections[from].main[branch] ??= [];
    connections[from].main[branch].push({ node: to, type: 'main', index: 0 });
  }
  const config = '$json.billingConfig';
  /** @param {string} name */
  function configure(name) {
    return add(name, 'set', {
      mode: 'raw',
      jsonOutput: JSON.stringify({ billingConfig: publicConfiguration }),
      includeOtherFields: true,
      options: {},
    });
  }
  /** @param {string} source @param {string} key */
  const technicalHeaders = (source, key) => ({
    parameters: [
      {
        name: 'X-Correlation-Id',
        value: `={{ $('${source}').first().json.chargeId }}`,
      },
      { name: 'Idempotency-Key', value: key },
      { name: 'X-Silmer-Workflow-Key', value: ORDER_BILLING_WORKFLOW_KEY },
      {
        name: 'X-Silmer-Workflow-Version',
        value: ORDER_BILLING_WORKFLOW_VERSION,
      },
      { name: 'X-Silmer-Execution-Id', value: '={{ $execution.id }}' },
    ],
  });
  /** @param {string} name @param {string} source @param {string} operation @param {string} [method] @param {string} [body] @param {string} [key] */
  function crm(
    name,
    source,
    operation,
    method = 'POST',
    body = '={{ ({}) }}',
    key = `={{ $('${source}').first().json.chargeId + ':${operation}:' + $execution.id }}`,
  ) {
    return add(
      name,
      'httpRequest',
      {
        method,
        url: `={{ $('${source}').first().json.crmBaseUrl + '/api/v1/integrations/n8n/billing/charges/' + $('${source}').first().json.chargeId + '/${operation}' }}`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
        sendHeaders: true,
        headerParameters: technicalHeaders(source, key),
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
        credentials: { httpBasicAuth: { name: 'Silmer n8n para CRM Basic' } },
        retryOnFail: false,
      },
    );
  }
  /** @param {string} name @param {string} path @param {string} body */
  function gateway(name, path, body) {
    return add(
      name,
      'httpRequest',
      {
        method: 'POST',
        url: 'https://api.checkout.infinitepay.io/' + path,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: body,
        options: {
          timeout: 15000,
          redirect: { redirect: { followRedirects: false } },
          response: { response: { responseFormat: 'json' } },
        },
      },
      {
        credentials: {
          httpHeaderAuth: { name: 'InfinitePay Checkout API Key' },
        },
        retryOnFail: false,
      },
    );
  }
  /** @param {string} name @param {string} body */
  function respond(name, body) {
    return add(name, 'respondToWebhook', {
      respondWith: 'json',
      responseBody: body,
      options: { responseCode: 200 },
    });
  }
  const command = add(
    'Receber emissão autorizada',
    'webhook',
    {
      path: 'silmer/order-billing/create',
      httpMethod: 'POST',
      authentication: 'basicAuth',
      responseMode: 'responseNode',
      options: {},
    },
    {
      webhookId: 'f0689210-cf56-4771-bc76-b08a3aa03616',
      credentials: { httpBasicAuth: { name: 'Silmer CRM para n8n Basic' } },
    },
  );
  const commandConfig = configure('Configurar emissão sem segredos');
  const normalized = add('Validar cobrança e configuração', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const normalize=${normalizeBillingInput.toString()};return {json:normalize($json.body,${config})};`,
  });
  const reserve = crm('Reservar efeito no CRM', normalized, 'reserve');
  const allowed = add('Emissão permitida nesta execução', 'if', {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'allowed',
          leftValue: '={{ $json.allowed }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  });
  const payload = add('Montar checkout reservado', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const build=${billingCheckoutPayload.toString()};return {json:build($json,$('${normalized}').first().json)};`,
  });
  const create = gateway(
    'InfinitePay criar link uma única vez',
    'links',
    '={{ $json }}',
  );
  const created = add('Validar URL de checkout', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const validate=${billingCreatedResult.toString()};return {json:validate($json)};`,
  });
  const callback = crm(
    'Persistir link no CRM',
    normalized,
    'created',
    'POST',
    '={{ $json }}',
  );
  const createdAck = respond(
    'Responder emissão concluída',
    '={{ ({accepted:true}) }}',
  );
  const duplicateAck = respond(
    'Responder reserva já consumida',
    '={{ ({accepted:true,duplicate:true}) }}',
  );
  connect(command, commandConfig);
  connect(commandConfig, normalized);
  connect(normalized, reserve);
  connect(reserve, allowed);
  connect(allowed, payload, 0);
  connect(allowed, duplicateAck, 1);
  connect(payload, create);
  connect(create, created);
  connect(created, callback);
  connect(callback, createdAck);

  const payment = add(
    'Receber aviso de pagamento',
    'webhook',
    {
      path: 'silmer/order-billing/paid',
      httpMethod: 'POST',
      responseMode: 'responseNode',
      options: {},
    },
    { webhookId: 'b561842f-af4f-4094-a305-dd0e4f17ddba' },
  );
  const paymentConfig = configure('Configurar recebimento sem segredos');
  const candidate = add('Validar identificadores do aviso', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const normalize=${normalizeBillingInput.toString()};return {json:normalize($json.body,${config},'payment')};`,
  });
  const lookup = crm(
    'Consultar cobrança conhecida no CRM',
    candidate,
    'lookup',
    'GET',
  );
  const check = gateway(
    'InfinitePay verificar pagamento no servidor',
    'payment_check',
    `={{ ({handle:$('${candidate}').first().json.handle,order_nsu:$('${candidate}').first().json.chargeId,transaction_nsu:$('${candidate}').first().json.transactionNsu,slug:$('${candidate}').first().json.invoiceSlug}) }}`,
  );
  const verified = add('Conferir pagamento verificado', 'code', {
    mode: 'runOnceForEachItem',
    jsCode: `const verify=${verifiedBillingPayment.toString()};return {json:verify($json,$('${candidate}').first().json,$('${lookup}').first().json)};`,
  });
  const received = crm(
    'Persistir recebimento no CRM',
    candidate,
    'payment',
    'POST',
    '={{ $json }}',
    `={{ $('${candidate}').first().json.transactionNsu }}`,
  );
  const receivedAck = respond(
    'Confirmar aviso somente após persistência',
    '={{ ({accepted:true}) }}',
  );
  connect(payment, paymentConfig);
  connect(paymentConfig, candidate);
  connect(candidate, lookup);
  connect(lookup, check);
  connect(check, verified);
  connect(verified, received);
  connect(received, receivedAck);
  for (const node of nodes.slice(
    nodes.indexOf(nodes.find((node) => node.name === payment)),
  ))
    node.position[1] = 480;
  return {
    name: 'Silmer | CRM | Cobranças InfinitePay',
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
  const destination = process.argv[2];
  if (!destination || !destination.endsWith('.json'))
    throw new Error(
      'Usage: node create-order-billing-workflow.mjs <destination.json> [public-config.json]',
    );
  const configuration = process.argv[3]
    ? JSON.parse(await readFile(process.argv[3], 'utf8'))
    : {};
  await writeFile(
    destination,
    JSON.stringify(createOrderBillingWorkflow(configuration), null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    'Inactive order billing workflow written. Bind credentials and configure the two Edit Fields nodes before activation.',
  );
}
