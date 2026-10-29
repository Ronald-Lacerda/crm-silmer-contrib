/** @param {import('fastify').FastifyInstance} api @param {Record<string, any>} subjects @param {(request: object) => {correlationId: string, requestId: string}} contextFor */
export function registerSubjectRoutes(api, subjects, contextFor) {
  api.get(
    '/api/v1/inbox/conversations/:conversationId/subjects',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const conversationId = id(
          /** @type {any} */ (request.params)?.conversationId,
          'CONVERSATION_ID',
        );
        const query = /** @type {any} */ (request.query ?? {});
        if (Object.keys(query).some((key) => key !== 'order')) {
          throw problem(400, 'INVALID_REQUEST');
        }
        const orderQuery = query.order ?? '';
        if (typeof orderQuery !== 'string' || orderQuery.length > 40) {
          throw problem(400, 'INVALID_ORDER_QUERY');
        }
        await subjects.authorizeRead({
          action: 'conversation.read',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
          secFetchSite: request.headers['sec-fetch-site'],
        });
        privateHeaders(reply);
        return reply
          .code(200)
          .send(await subjects.list(conversationId, orderQuery));
      }),
  );

  api.post(
    '/api/v1/inbox/conversations/:conversationId/subjects',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const conversationId = id(
          /** @type {any} */ (request.params)?.conversationId,
          'CONVERSATION_ID',
        );
        const body = object(request.body, ['orderId', 'select']);
        if (body.select !== undefined && typeof body.select !== 'boolean') {
          throw problem(400, 'INVALID_REQUEST');
        }
        const input = await command(
          request,
          subjects,
          contextFor,
          conversationId,
        );
        const orderId =
          body.orderId === undefined || body.orderId === null
            ? null
            : id(body.orderId, 'ORDER_ID');
        privateHeaders(reply);
        return reply.code(201).send(
          await subjects.create({
            ...input,
            orderId,
            select: body.select ?? true,
          }),
        );
      }),
  );

  api.post(
    '/api/v1/inbox/conversations/:conversationId/subjects/:subjectId/select',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const conversationId = id(
          /** @type {any} */ (request.params)?.conversationId,
          'CONVERSATION_ID',
        );
        const subjectId = id(
          /** @type {any} */ (request.params)?.subjectId,
          'SUBJECT_ID',
        );
        object(request.body, []);
        const input = await command(
          request,
          subjects,
          contextFor,
          conversationId,
        );
        privateHeaders(reply);
        return reply
          .code(200)
          .send(await subjects.select({ ...input, subjectId }));
      }),
  );

  api.put(
    '/api/v1/inbox/conversations/:conversationId/messages/:messageId/subjects',
    async (request, reply) =>
      respond(reply, request, contextFor, async () => {
        const conversationId = id(
          /** @type {any} */ (request.params)?.conversationId,
          'CONVERSATION_ID',
        );
        const messageId = id(
          /** @type {any} */ (request.params)?.messageId,
          'MESSAGE_ID',
        );
        const body = object(request.body, ['subjectIds']);
        if (!Array.isArray(body.subjectIds))
          throw problem(400, 'INVALID_SUBJECTS');
        const input = await command(
          request,
          subjects,
          contextFor,
          conversationId,
        );
        privateHeaders(reply);
        return reply.code(200).send(
          await subjects.tagMessage({
            ...input,
            messageId,
            subjectIds: body.subjectIds,
          }),
        );
      }),
  );
}

/** @param {any} request @param {any} subjects @param {Function} contextFor @param {string} conversationId */
async function command(request, subjects, contextFor, conversationId) {
  const principal = await subjects.authorizeWrite({
    action: 'conversation.subject.manage',
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    csrfToken: request.headers['x-csrf-token'],
    origin: request.headers.origin,
  });
  return {
    actor: principal.actor,
    conversationId,
    correlationId: contextFor(request).correlationId,
    idempotencyKey: id(request.headers['idempotency-key'], 'IDEMPOTENCY_KEY'),
  };
}

/** @param {any} reply */
function privateHeaders(reply) {
  reply.header('cache-control', 'private, no-cache');
  reply.header('vary', 'Origin, Cookie');
}

/** @param {unknown} value @param {string[]} keys */
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw problem(400, 'INVALID_REQUEST');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw problem(400, 'INVALID_REQUEST');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} code */
function id(value, code) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw problem(400, `INVALID_${code}`);
  }
  return value.trim();
}

/** @param {number} statusCode @param {string} code */
function problem(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code });
}

/** @param {any} reply @param {any} request @param {Function} contextFor @param {() => Promise<any>} work */
async function respond(reply, request, contextFor, work) {
  try {
    return await work();
  } catch (error) {
    const normalized = /** @type {{statusCode?: unknown, code?: unknown}} */ (
      error
    );
    const statusCode = Number(normalized?.statusCode);
    if (!Number.isSafeInteger(statusCode) || statusCode < 400) throw error;
    const safe = new Set([
      'CONVERSATION_CLOSED',
      'CONVERSATION_NOT_FOUND',
      'FORBIDDEN',
      'IDEMPOTENCY_KEY_REUSED',
      'INVALID_SUBJECTS',
      'INVALID_ORDER_QUERY',
      'MESSAGE_NOT_FOUND',
      'ORDER_CONTACT_MISMATCH',
      'SUBJECT_CONTACT_MISMATCH',
      'SUBJECT_EXISTS',
      'SUBJECT_NOT_FOUND',
    ]);
    return reply.code(statusCode >= 500 ? 503 : statusCode).send({
      error: {
        code: safe.has(String(normalized.code))
          ? normalized.code
          : 'INVALID_REQUEST',
      },
      request_id: contextFor(request).requestId,
    });
  }
}
