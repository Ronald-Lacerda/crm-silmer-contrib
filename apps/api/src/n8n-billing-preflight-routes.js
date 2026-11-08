import { N8nRouteError } from './n8n-routes.js';

/** Revalidates the original reservation; never reserves or retries a send.
 * @param {import('fastify').FastifyInstance} api @param {any} integration @param {Function} contextFor
 */
export function registerN8nBillingPreflightRoutes(
  api,
  integration,
  contextFor,
) {
  api.get(
    '/api/v1/integrations/n8n/commands/:commandId/preflight',
    { exposeHeadRoute: false },
    async (request, reply) => {
      const context = contextFor(request);
      reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff');
      try {
        const auth = /** @type {any} */ (api).automationAuth;
        if (!auth) throw new N8nRouteError(503, 'AUTOMATION_AUTH_UNAVAILABLE');
        await auth.authorize({
          action: 'integration.n8n.command.media.read',
          authorization: request.headers.authorization,
          correlationId: context.correlationId,
        });
        const technical = /** @type {any} */ ({});
        for (const [key, header] of [
          ['workflowKey', 'x-silmer-workflow-key'],
          ['workflowVersion', 'x-silmer-workflow-version'],
          ['executionId', 'x-silmer-execution-id'],
        ]) {
          const value = request.headers[header];
          if (
            typeof value !== 'string' ||
            !value ||
            value.length > 128 ||
            /[^\x21-\x7e]/u.test(value)
          )
            throw new N8nRouteError(400, 'INVALID_TECHNICAL_IDENTITY');
          technical[key] = value;
        }
        if (request.headers['x-correlation-id'] !== context.correlationId)
          throw new N8nRouteError(400, 'INVALID_CORRELATION_ID');
        if (Object.keys(/** @type {any} */ (request.query)).length)
          throw new N8nRouteError(400, 'INVALID_PREFLIGHT_QUERY');
        const result = await integration.readReservedSend({
          commandId: /** @type {any} */ (request.params).commandId,
          technical,
        });
        return reply.send({ valid: result.valid === true });
      } catch (error) {
        const raw = Number(/** @type {any} */ (error)?.statusCode);
        const status = [400, 401, 403, 404, 409, 410, 429].includes(raw)
          ? raw
          : 503;
        if (status === 401)
          reply.header('WWW-Authenticate', 'Basic realm="crm-silmer-n8n"');
        return reply.code(status).type('application/problem+json').send({
          type: 'about:blank',
          title: 'Send preflight failed',
          status,
          request_id: context.requestId,
          valid: false,
        });
      }
    },
  );
}
