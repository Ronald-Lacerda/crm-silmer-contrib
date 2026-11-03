// OA-01..12: observations advise an operator; only an explicit human decision creates an order.
export class OrderAssistanceError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'OrderAssistanceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value @param {string} field */
export function assistanceIdentifier(value, field) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,254}$/u.test(value)
  )
    throw new OrderAssistanceError(400, 'INVALID_' + field);
  return value;
}

/** @param {unknown} value */
export function assistanceVersion(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new OrderAssistanceError(400, 'INVALID_VERSION');
  return Number(value);
}

/** @param {any} actor @param {any} conversation */
export function requireAssistanceOwner(actor, conversation) {
  if (
    !actor?.id ||
    actor.kind !== 'human' ||
    (conversation.assigned_user_id !== actor.id &&
      !(actor.capabilities ?? []).includes('COMMERCIAL_ADMIN'))
  )
    throw new OrderAssistanceError(403, 'FORBIDDEN');
}

/** @param {any} repository */
export function createOrderAssistanceService(repository) {
  return Object.freeze({
    /** @param {any} input */
    async observe(input) {
      const signals = [
        'purchase_confirmed',
        'not_ready',
        'withdrawn',
        'unsupported',
        'uncertain',
        'analysis_failed',
      ];
      if (!signals.includes(input?.signal))
        throw new OrderAssistanceError(400, 'INVALID_SIGNAL');
      const conversationId = assistanceIdentifier(
        input.conversation_id,
        'CONVERSATION_ID',
      );
      const sourceRevision = assistanceVersion(input.source_revision);
      if (sourceRevision < 1)
        throw new OrderAssistanceError(400, 'INVALID_VERSION');
      const automationEpoch = assistanceVersion(input.automation_epoch);
      if (input.technical?.actor !== 'AUTOMATION_EXECUTOR')
        throw new OrderAssistanceError(403, 'FORBIDDEN');
      const evidenceMessageId =
        input.evidence_message_id === null ||
        input.evidence_message_id === undefined
          ? null
          : assistanceIdentifier(input.evidence_message_id, 'MESSAGE_ID');
      if (
        input.signal === 'purchase_confirmed' &&
        (!evidenceMessageId ||
          typeof input.product_summary !== 'string' ||
          !input.product_summary.trim() ||
          input.product_summary.length > 256)
      )
        throw new OrderAssistanceError(400, 'INVALID_PURCHASE_EVIDENCE');
      const fields = [
        'artwork_locations',
        'artwork_status',
        'artwork_technique',
        'audiences',
        'city_or_postal_code',
        'collar',
        'colors',
        'customer_name',
        'customizations',
        'delivery_address',
        'delivery_mode',
        'fabrics',
        'needed_by',
        'notes',
        'numbers',
        'order_name',
        'pickup_location',
        'product_model',
        'product_type',
        'purchase_profile',
        'purpose',
        'quantity',
        'segment',
        'sizes',
        'sponsors',
      ];
      if (
        input.briefing_patch !== null &&
        input.briefing_patch !== undefined &&
        (typeof input.briefing_patch !== 'object' ||
          Array.isArray(input.briefing_patch) ||
          Object.entries(input.briefing_patch).some(
            ([field, value]) =>
              !fields.includes(field) ||
              (typeof value !== 'string' && typeof value !== 'number') ||
              (typeof value === 'number' && !Number.isFinite(value)) ||
              String(value).length > 2000,
          ))
      )
        throw new OrderAssistanceError(400, 'INVALID_BRIEFING');
      return repository.observe({
        conversationId,
        sourceRevision,
        automationEpoch,
        signal: input.signal,
        evidenceMessageId,
        productSummary:
          typeof input.product_summary === 'string'
            ? input.product_summary.trim().slice(0, 256)
            : null,
        subjectId:
          input.subject_id === null || input.subject_id === undefined
            ? null
            : assistanceIdentifier(input.subject_id, 'SUBJECT_ID'),
        briefing: input.briefing_patch ?? null,
        correlationId: assistanceIdentifier(
          input.technical.correlationId,
          'CORRELATION_ID',
        ),
      });
    },
    /** @param {any} input */
    async list(input) {
      return repository.list({
        ...input,
        conversationId: assistanceIdentifier(
          input.conversationId,
          'CONVERSATION_ID',
        ),
      });
    },
    /** @param {any} input */
    async decide(input) {
      if (!['accept', 'defer', 'reject', 'missed'].includes(input?.decision))
        throw new OrderAssistanceError(400, 'INVALID_DECISION');
      if (
        ![
          'not_ready',
          'withdrawn',
          'unsupported',
          'wrong_product',
          'other',
          'ready',
        ].includes(input.reason)
      )
        throw new OrderAssistanceError(400, 'INVALID_REASON');
      if (input.decision === 'accept' && input.reason !== 'ready')
        throw new OrderAssistanceError(400, 'INVALID_REASON');
      if (
        input.decision !== 'accept' &&
        input.decision !== 'missed' &&
        input.reason === 'ready'
      )
        throw new OrderAssistanceError(400, 'INVALID_REASON');
      const result = {
        ...input,
        conversationId: assistanceIdentifier(
          input.conversationId,
          'CONVERSATION_ID',
        ),
        idempotencyKey: assistanceIdentifier(
          input.idempotencyKey,
          'IDEMPOTENCY_KEY',
        ),
        correlationId: assistanceIdentifier(
          input.correlationId,
          'CORRELATION_ID',
        ),
        expectedConversationVersion: assistanceVersion(
          input.expectedConversationVersion,
        ),
        expectedSourceRevision: assistanceVersion(input.expectedSourceRevision),
      };
      if (input.decision === 'missed')
        result.sourceMessageId = assistanceIdentifier(
          input.sourceMessageId,
          'MESSAGE_ID',
        );
      else {
        result.suggestionId = assistanceIdentifier(
          input.suggestionId,
          'SUGGESTION_ID',
        );
        result.expectedVersion = assistanceVersion(input.expectedVersion);
      }
      return repository.decide(result);
    },
    /** @param {any} input */
    async metrics(input) {
      if (!input.actor?.capabilities?.includes('COMMERCIAL_ADMIN'))
        throw new OrderAssistanceError(403, 'FORBIDDEN');
      const days = Number(input.days ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 90)
        throw new OrderAssistanceError(400, 'INVALID_DAYS');
      return repository.metrics(days);
    },
  });
}
