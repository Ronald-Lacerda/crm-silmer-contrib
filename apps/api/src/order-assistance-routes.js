/** OA-T01: use the existing order capability and session/CSRF guards. @param {import('fastify').FastifyInstance} api @param {any} assistance @param {(request:any)=>any} contextFor */
export function registerOrderAssistanceRoutes(api, assistance, contextFor) {
  api.get(
    '/api/v1/inbox/conversations/:conversationId/order-assistance',
    async (request, reply) =>
      respond(reply, async () => {
        const params = /** @type {any} */ (request.params);
        strict(request.query ?? {}, []);
        const access = await assistance.authorizeRead(
          auth(request, 'order.read'),
        );
        return assistance.list({
          actor: access.actor,
          conversationId: params.conversationId,
        });
      }),
  );
  api.post(
    '/api/v1/inbox/conversations/:conversationId/order-assistance/decisions',
    async (request, reply) =>
      respond(reply, async () => {
        const params = /** @type {any} */ (request.params);
        const body = /** @type {any} */ (request.body);
        strict(body, [
          'suggestionId',
          'decision',
          'reason',
          'sourceMessageId',
          'expectedVersion',
          'expectedConversationVersion',
          'expectedSourceRevision',
        ]);
        const access = await assistance.authorizeWrite({
          ...auth(request, 'order.create'),
          csrfToken: request.headers['x-csrf-token'],
        });
        return assistance.decide({
          ...body,
          actor: access.actor,
          conversationId: params.conversationId,
          idempotencyKey: request.headers['idempotency-key'],
          correlationId: contextFor(request).correlationId,
        });
      }),
  );
  api.get('/api/v1/inbox/order-assistance/metrics', async (request, reply) =>
    respond(reply, async () => {
      const query = /** @type {any} */ (request.query ?? {});
      strict(query, ['days']);
      const access = await assistance.authorizeRead(
        auth(request, 'assistant.performance.read'),
      );
      return assistance.metrics({
        actor: access.actor,
        days: query.days ?? 30,
      });
    }),
  );
}

/** @param {any} request @param {string} action */
function auth(request, action) {
  return {
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    secFetchSite: request.headers['sec-fetch-site'],
  };
}
/** @param {any} value @param {string[]} keys */
function strict(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Object.assign(new Error('INVALID_REQUEST'), {
      code: 'INVALID_REQUEST',
      statusCode: 400,
    });
}
/** @param {any} reply @param {()=>Promise<any>} operation */
async function respond(reply, operation) {
  reply
    .header('cache-control', 'private, no-store')
    .header('vary', 'Origin, Cookie');
  try {
    return reply.code(200).send(await operation());
  } catch (error) {
    const value = /** @type {any} */ (error);
    const status = Number(value?.statusCode ?? 500);
    const code =
      status < 500 && /^[A-Z_]+$/u.test(value?.code ?? '')
        ? value.code
        : 'SERVICE_UNAVAILABLE';
    return reply
      .code(status >= 400 && status <= 599 ? status : 500)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: code, status, error: { code } });
  }
}
