// COB-CHAT-B01: HTTP shapes only. Live ACL, versions and money require T2/T3.
export const billingIntentStates = Object.freeze([
  'waiting_link',
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'unknown',
  'blocked',
]);

const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  pattern: '^[!-~]+$',
};
const version = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const cents = {
  type: 'integer',
  minimum: 100,
  maximum: Number.MAX_SAFE_INTEGER,
};
const common = {
  action: { type: 'string' },
  conversationId: identifier,
  expectedVersion: version,
  expectedBillingVersion: { ...version, minimum: 0 },
  expectedConversationVersion: version,
};

export const billingIntentActions = Object.freeze({
  issue: { percent: { type: 'integer', minimum: 1, maximum: 100 } },
  send_existing: { chargeId: identifier },
  balance: {},
  correct: {
    chargeId: identifier,
    amountCents: cents,
    confirmedAgreement: { const: true },
    confirmedProviderReview: { const: true },
  },
  retry: { intentId: identifier, expectedIntentVersion: version },
});

export const billingSendCommandSchema = {
  oneOf: Object.entries(billingIntentActions).map(([action, fields]) => ({
    type: 'object',
    additionalProperties: false,
    required: [...Object.keys(common), ...Object.keys(fields)],
    properties: { ...common, action: { const: action }, ...fields },
  })),
};

export const billingIntentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'version',
    'action',
    'chargeId',
    'conversationId',
    'state',
    'blockedReason',
    'messageId',
    'commandId',
    'amountCents',
  ],
  properties: {
    id: identifier,
    version,
    action: { enum: Object.keys(billingIntentActions) },
    chargeId: identifier,
    conversationId: identifier,
    state: { enum: [...billingIntentStates] },
    blockedReason: {
      enum: [
        null,
        'OWNER_CHANGED',
        'ACTOR_DISABLED',
        'CONVERSATION_CLOSED',
        'AGREEMENT_CHANGED',
        'CHARGE_EXPIRED',
        'PAYMENT_CONFIRMED',
        'INBOUND_CHANGED',
        'SENDING_DISABLED',
      ],
    },
    messageId: { type: ['string', 'null'], maxLength: 255 },
    commandId: { type: ['string', 'null'], maxLength: 255 },
    amountCents: cents,
    supersedesChargeId: { type: ['string', 'null'], maxLength: 255 },
    retryOfIntentId: { type: ['string', 'null'], maxLength: 255 },
  },
};

export const billingHistorySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'orderId',
    'orderVersion',
    'billingVersion',
    'totalAmountCents',
    'receivedAmountCents',
    'balanceAmountCents',
    'items',
    'nextCursor',
  ],
  properties: {
    orderId: identifier,
    orderVersion: version,
    billingVersion: { ...version, minimum: 0 },
    totalAmountCents: { ...cents, minimum: 0 },
    receivedAmountCents: { ...cents, minimum: 0 },
    balanceAmountCents: { ...cents, minimum: 0 },
    nextCursor: { type: ['string', 'null'], maxLength: 255 },
    items: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kind',
          'chargeId',
          'intentId',
          'amountCents',
          'status',
          'occurredAt',
        ],
        properties: {
          id: identifier,
          chargeId: identifier,
          intentId: { type: ['string', 'null'], maxLength: 255 },
          supersedesChargeId: { type: ['string', 'null'], maxLength: 255 },
          retryOfIntentId: { type: ['string', 'null'], maxLength: 255 },
          kind: {
            enum: ['charge', 'receipt', 'intent', 'correction', 'refund'],
          },
          amountCents: { ...cents, minimum: 0 },
          status: {
            enum: [
              ...new Set([
                ...billingIntentStates,
                'creating',
                'waiting',
                'paid',
                'review',
                'closed',
              ]),
            ],
          },
          occurredAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

/** @param {string} [code] @param {number} [statusCode] */
export function billingChatError(code = 'INVALID_REQUEST', statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

/** @param {unknown} value */
export function billingChatIdentifier(value) {
  if (typeof value !== 'string' || !/^[!-~]{1,255}$/u.test(value))
    throw billingChatError();
  return value;
}

/** Strict validation without coercing values or stripping unknown fields.
 * @param {any} input
 * @returns {Record<string, any>}
 */
export function readBillingSendCommand(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Object.hasOwn(billingIntentActions, input.action)
  )
    throw billingChatError();
  const variant = billingSendCommandSchema.oneOf.find(
    (s) => s.properties.action.const === input.action,
  );
  if (
    !variant ||
    Object.keys(input).length !== variant.required.length ||
    variant.required.some((key) => !Object.hasOwn(input, key))
  )
    throw billingChatError();
  for (const [key, raw] of Object.entries(variant.properties)) {
    const rule = /** @type {any} */ (raw);
    const value = input[key];
    if (Object.hasOwn(rule, 'const') && value !== rule.const)
      throw billingChatError();
    if (rule.type === 'string') billingChatIdentifier(value);
    if (
      rule.type === 'integer' &&
      (!Number.isSafeInteger(value) ||
        value < rule.minimum ||
        value > rule.maximum)
    )
      throw billingChatError();
  }
  return { ...input };
}
