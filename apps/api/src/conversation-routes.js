class ConversationRequestError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'ConversationRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Human conversation commands are persisted by the injected domain service
 * before its transactional outbox notifies n8n.
 *
 * @param {import('fastify').FastifyInstance} api
 * @param {Record<string, any>} conversations
 * @param {(request: object) => {correlationId: string, requestId: string}} contextFor
 */
export function registerConversationRoutes(api, conversations, contextFor) {
  // ADR 015: a conversation never goes back to the bot. `return-to-ai` is not
  // registered, so it answers 404 like any unknown route, before
  // authentication and without reaching the domain.
  const stateCommands =
    /** @type {Array<[string, string, string, string|undefined]>} */ ([
      ['takeover', 'conversation.takeover', 'takeover', undefined],
    ]);
  for (const [path, action, method, state] of stateCommands) {
    api.post(
      `/api/v1/conversations/:conversationId/${path}`,
      async (request, reply) =>
        respond(reply, request, contextFor, async () => {
          const params = requireObject(request.params);
          const body = requireObject(request.body);
          rejectUnknownKeys(body, ['expectedVersion', 'reason']);
          const command = await authorizeHumanCommand(
            request,
            conversations,
            contextFor,
            action,
          );
          const result = await conversations[method]({
            ...command,
            conversationId: requireString(
              params.conversationId,
              'CONVERSATION_ID',
            ),
            expectedVersion: requireVersion(body.expectedVersion),
            reason: requireString(body.reason, 'REASON'),
            ...(state === undefined ? {} : { state }),
          });
          return reply.code(202).send({ accepted: true, ...result });
        }),
    );
  }

  api.post(
    '/api/v1/conversations/:conversationId/close',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const params = requireObject(request.params);
        const body = requireObject(request.body);
        rejectUnknownKeys(body, [
          'acknowledgePending',
          'expectedVersion',
          'outcome',
        ]);
        const command = await authorizeHumanCommand(
          request,
          conversations,
          contextFor,
          'conversation.transition',
        );
        const outcome = requireString(body.outcome, 'OUTCOME');
        if (!['concluido', 'sem_pedido'].includes(outcome)) {
          throw new ConversationRequestError(400, 'INVALID_OUTCOME');
        }
        if (typeof body.acknowledgePending !== 'boolean') {
          throw new ConversationRequestError(400, 'INVALID_REQUEST');
        }
        const result = await conversations.close({
          ...command,
          acknowledgePending: body.acknowledgePending,
          conversationId: requireString(
            params.conversationId,
            'CONVERSATION_ID',
          ),
          expectedVersion: requireVersion(body.expectedVersion),
          outcome,
          reason: `Encerramento: ${outcome}`,
        });
        return reply.code(202).send({ accepted: true, ...result });
      }),
  );

  api.post(
    '/api/v1/conversations/:conversationId/archive',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const params = requireObject(request.params);
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['expectedVersion', 'reason']);
        const command = await authorizeHumanCommand(
          request,
          conversations,
          contextFor,
          'conversation.archive',
        );
        const result = await conversations.archive({
          ...command,
          conversationId: requireString(
            params.conversationId,
            'CONVERSATION_ID',
          ),
          expectedVersion: requireVersion(body.expectedVersion),
          reason: requireString(body.reason, 'REASON'),
        });
        return reply.code(202).send({ accepted: true, ...result });
      }),
  );

  api.post(
    '/api/v1/conversations/:conversationId/unarchive',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const params = requireObject(request.params);
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['expectedVersion', 'reason']);
        const command = await authorizeHumanCommand(
          request,
          conversations,
          contextFor,
          'conversation.unarchive',
        );
        const result = await conversations.unarchive({
          ...command,
          conversationId: requireString(
            params.conversationId,
            'CONVERSATION_ID',
          ),
          expectedVersion: requireVersion(body.expectedVersion),
          reason: requireString(body.reason, 'REASON'),
        });
        return reply.code(202).send({ accepted: true, ...result });
      }),
  );

  api.post(
    '/api/v1/conversations/:conversationId/transfer',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const params = requireObject(request.params);
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['expectedVersion', 'reason', 'targetUserId']);
        const command = await authorizeHumanCommand(
          request,
          conversations,
          contextFor,
          'conversation.transfer',
        );
        const result = await conversations.transfer({
          ...command,
          conversationId: requireString(
            params.conversationId,
            'CONVERSATION_ID',
          ),
          expectedVersion: requireVersion(body.expectedVersion),
          reason: requireString(body.reason, 'REASON'),
          targetUserId: requireString(body.targetUserId, 'TARGET_USER_ID'),
        });
        return reply.code(202).send({ accepted: true, ...result });
      }),
  );

  api.post(
    '/api/v1/conversations/:conversationId/messages',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const params = requireObject(request.params);
        const body = requireObject(request.body);
        rejectUnknownKeys(body, [
          'content',
          'expectedVersion',
          'messageType',
          'reason',
        ]);
        const command = await authorizeHumanCommand(
          request,
          conversations,
          contextFor,
          'conversation.message.send',
        );
        const content = requireObject(body.content);
        const result = await conversations.sendMessage({
          ...command,
          content,
          conversationId: requireString(
            params.conversationId,
            'CONVERSATION_ID',
          ),
          expectedVersion: requireVersion(body.expectedVersion),
          messageType: requireString(body.messageType, 'MESSAGE_TYPE'),
          reason: requireString(body.reason, 'REASON'),
        });
        return reply.code(202).send({ accepted: true, ...result });
      }),
  );

  api.post('/api/v1/handoffs/:handoffId/claim', async (request, reply) =>
    respond(reply, request, contextFor, async () => {
      const params = requireObject(request.params);
      const body = requireObject(request.body);
      rejectUnknownKeys(body, [
        'expectedConversationVersion',
        'expectedHandoffVersion',
        'reasonCode',
      ]);
      const command = await authorizeHumanCommand(
        request,
        conversations,
        contextFor,
        'handoff.claim',
      );
      const result = await conversations.claimHandoff({
        ...command,
        handoffId: requireString(params.handoffId, 'HANDOFF_ID'),
        expectedConversationVersion: optionalVersion(
          body.expectedConversationVersion,
        ),
        expectedHandoffVersion: requireVersion(body.expectedHandoffVersion),
        reasonCode: requireString(body.reasonCode, 'REASON_CODE'),
      });
      return reply.code(200).send(result);
    }),
  );
}

/** @param {any} request @param {any} conversations @param {Function} contextFor @param {string} action */
async function authorizeHumanCommand(
  request,
  conversations,
  contextFor,
  action,
) {
  const context = contextFor(request);
  const idempotencyKey = requireString(
    request.headers['idempotency-key'],
    'IDEMPOTENCY_KEY',
  );
  const principal = await conversations.authorize({
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    correlationId: context.correlationId,
    csrfToken: request.headers['x-csrf-token'],
    origin: request.headers.origin,
  });
  return {
    actor: principal.actor,
    correlationId: context.correlationId,
    idempotencyKey,
  };
}

/** @param {import('fastify').FastifyReply} reply @param {any} request @param {Function} contextFor @param {() => Promise<unknown>} operation */
async function respond(reply, request, contextFor, operation) {
  try {
    return await operation();
  } catch (error) {
    const normalized = /** @type {{statusCode?: unknown, code?: unknown}} */ (
      error
    );
    const statusCode = Number(normalized?.statusCode);
    if (!Number.isSafeInteger(statusCode) || statusCode < 400) throw error;
    const context = contextFor(request);
    const publicStatus = statusCode >= 500 ? 503 : statusCode;
    const code = statusCode >= 500 ? 'SERVICE_UNAVAILABLE' : publicCode(error);
    return reply.code(publicStatus).send({
      accepted: false,
      error: { code },
      request_id: context.requestId,
    });
  }
}

/** @param {any} error */
function publicCode(error) {
  const allowed = new Set([
    'FORBIDDEN',
    'INBOX_CONFLICT',
    'INBOX_FORBIDDEN',
    'INBOX_INVALID',
    'INVALID_AUTOMATION_CREDENTIALS',
    'NON_PRODUCTION_CONVERSATION',
    'WORK_CONFLICT',
    'WORK_FORBIDDEN',
    'WORK_INVALID',
  ]);
  return allowed.has(String(error?.code))
    ? String(error.code)
    : 'INVALID_REQUEST';
}

/** @param {unknown} value */
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationRequestError(400, 'INVALID_REQUEST');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} field */
function requireString(value, field) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConversationRequestError(400, `INVALID_${field}`);
  }
  return value.trim();
}

/** @param {unknown} value */
function requireVersion(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ConversationRequestError(400, 'INVALID_EXPECTED_VERSION');
  }
  return Number(value);
}

/** @param {unknown} value */
function optionalVersion(value) {
  return value === undefined || value === null
    ? undefined
    : requireVersion(value);
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function rejectUnknownKeys(value, allowed) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new ConversationRequestError(400, 'INVALID_REQUEST');
  }
}
