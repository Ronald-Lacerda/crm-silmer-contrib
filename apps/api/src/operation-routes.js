import { LiveEventDispatcher } from './live-event-dispatcher.js';

export const EVENT_STREAMS_PER_MINUTE = 60;

const REGISTRATION_FIELDS = [
  'personType',
  'document',
  'legalName',
  'instagram',
  'stateRegistration',
  'postalCode',
  'city',
  'state',
  'street',
  'district',
  'number',
  'complement',
];

/** Validation codes of the registration form; only these carry `field`. */
const REGISTRATION_CODES = new Set([
  'INVALID_ADDRESS_NUMBER',
  'INVALID_CITY',
  'INVALID_COMPLEMENT',
  'INVALID_DISTRICT',
  'INVALID_DOCUMENT',
  'INVALID_INSTAGRAM',
  'INVALID_LEGAL_NAME',
  'INVALID_PERSON_TYPE',
  'INVALID_POSTAL_CODE',
  'INVALID_STATE',
  'INVALID_STATE_REGISTRATION',
  'INVALID_STREET',
]);

/** 5xx codes the client must tell apart to keep the form usable. */
const PUBLIC_UNAVAILABLE_CODES = new Set(['POSTAL_CODE_UNAVAILABLE']);

class OperationReadRequestError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'OperationReadRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * @param {import('fastify').FastifyInstance} api
 * @param {Record<string, any>} operations
 * @param {(request: object) => {correlationId: string, requestId: string}} contextFor
 */
export function registerOperationRoutes(api, operations, contextFor) {
  const dispatcher = new LiveEventDispatcher(
    /** @type {{readLiveEvents: Function}} */ (operations),
  );
  let activeStreams = 0;

  api.get(
    '/api/v1/events',
    {
      config: {
        rateLimit: {
          max: EVENT_STREAMS_PER_MINUTE,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const query = requireObject(request.query ?? {});
      rejectUnknownKeys(query, ['after', 'topic']);
      if (query.topic !== undefined && query.topic !== 'inbox') {
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
      }
      const access = await authorizeRead(
        request,
        operations,
        'deal.events.read',
      );
      const actorId = access.actor.id;
      if (activeStreams >= 30) {
        reply.header('retry-after', '1');
        return reply
          .code(429)
          .send({ error: { code: 'SSE_CAPACITY_EXCEEDED' } });
      }
      const headerCursor = request.headers['last-event-id'];
      const after = headerCursor ?? query.after ?? 0;
      const afterCursor = Number(after);
      if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
        return reply.code(400).send({ error: { code: 'INVALID_CURSOR' } });
      }
      const aheadReset = await dispatcher.reconcileAhead(afterCursor);
      reply.hijack();
      reply.raw.writeHead(200, {
        'cache-control': 'private, no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        vary: 'Origin, Cookie',
        'x-accel-buffering': 'no',
      });
      activeStreams += 1;
      let closed = false;
      let deliveredCursor = afterCursor;
      let unsubscribe = () => {};
      const heartbeat = {
        /** @type {ReturnType<typeof globalThis.setInterval>|undefined} */
        current: undefined,
      };
      const close = () => {
        if (closed) return;
        closed = true;
        activeStreams = Math.max(0, activeStreams - 1);
        if (heartbeat.current) globalThis.clearInterval(heartbeat.current);
        unsubscribe();
      };
      /** @param {unknown} [cursor] */
      const expire = (cursor) => {
        if (closed) return;
        // The browser rechecks its session and leaves the page if access was
        // revoked. No domain event or identifier is sent after revocation.
        close();
        try {
          const id = Number.isSafeInteger(cursor) ? `id: ${cursor}\n` : '';
          reply.raw.write(`${id}event: session.expired\ndata: {}\n\n`);
          reply.raw.end();
        } catch {
          reply.raw.destroy?.();
        }
      };
      const stillAuthorized = async () => {
        try {
          const current = await authorizeRead(
            request,
            operations,
            'deal.events.read',
          );
          return current.actor.id === actorId;
        } catch {
          return false;
        }
      };
      let writes = Promise.resolve();
      /** @param {{cursor: number, payload: object, type: string}} event */
      const write = (event) => {
        if (closed) return;
        if (
          event.type === 'identity.user.changed' &&
          /** @type {{userId?: string}} */ (event.payload)?.userId === actorId
        ) {
          expire(event.cursor);
          return;
        }
        writes = writes
          .then(async () => {
            if (closed) return;
            if (!(await stillAuthorized())) return expire();
            if (
              closed ||
              (event.type !== 'stream.reset' &&
                Number(event.cursor) <= deliveredCursor)
            )
              return;
            reply.raw.write(
              `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
            );
            deliveredCursor = Number(event.cursor);
          })
          .catch(expire);
      };
      if (aheadReset) write(aheadReset);
      unsubscribe = dispatcher.subscribe(write, afterCursor);
      heartbeat.current = globalThis.setInterval(() => {
        writes = writes
          .then(async () => {
            if (closed) return;
            if (!(await stillAuthorized())) return expire();
            if (!closed) reply.raw.write(': heartbeat\n\n');
          })
          .catch(expire);
      }, 15_000);
      heartbeat.current.unref?.();
      request.raw.on('close', close);
      reply.raw.on('close', close);
      reply.raw.write(': connected\n\n');
      return reply;
    },
  );

  api.get('/api/v1/inbox/summary', async (request, reply) =>
    respond(reply, async () => {
      rejectUnknownKeys(requireObject(request.query ?? {}), []);
      const access = await authorizeRead(
        request,
        operations,
        'conversation.read',
      );
      privateReadHeaders(reply);
      return reply
        .code(200)
        .send(await operations.summarizeInbox({ actorId: access.actor.id }));
    }),
  );

  api.get('/api/v1/inbox/conversations', async (request, reply) =>
    respond(reply, async () => {
      const input = parseListQuery(request.query, [
        'assignedUserId',
        'archived',
        'automationState',
        'channel',
        'cursor',
        'limit',
        'pendingHandoff',
        'state',
        'unassignedHumanHandoff',
      ]);
      await authorizeRead(request, operations, 'conversation.read');
      privateReadHeaders(reply);
      return reply.code(200).send(await operations.listInbox(input));
    }),
  );

  api.get(
    '/api/v1/inbox/conversations/:conversationId',
    async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        await authorizeRead(request, operations, 'conversation.read');
        privateReadHeaders(reply);
        return reply.code(200).send(
          await operations.getConversation({
            conversationId: requireIdentifier(
              params.conversationId,
              'CONVERSATION_ID',
            ),
          }),
        );
      }),
  );

  api.get('/api/v1/inbox/handoffs', async (request, reply) =>
    respond(reply, async () => {
      const input = parseListQuery(request.query, ['cursor', 'limit']);
      await authorizeRead(request, operations, 'handoff.read');
      privateReadHeaders(reply);
      return reply.code(200).send(await operations.listOpenHandoffs(input));
    }),
  );

  api.get('/api/v1/contacts', async (request, reply) =>
    respond(reply, async () => {
      const input = parseListQuery(request.query, ['cursor', 'limit', 'q']);
      // A phone in the request URL would be retained by proxies and browser history.
      if ((input.q?.match(/\d/gu) ?? []).length >= 8) {
        throw new OperationReadRequestError(400, 'INVALID_REQUEST');
      }
      await authorizeRead(request, operations, 'contact.read');
      privateReadHeaders(reply);
      return reply.code(200).send(await operations.listContacts(input));
    }),
  );

  api.post(
    '/api/v1/contacts/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) =>
      respond(reply, async () => {
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['q', 'cursor', 'limit']);
        const input = {
          q: requireIdentifier(body.q, 'QUERY', 120),
          ...(body.cursor !== undefined
            ? { cursor: requireIdentifier(body.cursor, 'CURSOR', 1024) }
            : {}),
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
        };
        await operations.authorizeWrite({
          action: 'contact.read',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          csrfToken: request.headers['x-csrf-token'],
          origin: request.headers.origin,
        });
        privateReadHeaders(reply);
        return reply.code(200).send(await operations.listContacts(input));
      }),
  );

  api.post('/api/v1/contacts', async (request, reply) =>
    respond(reply, async () => {
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['displayName', 'phone', 'email']);
      const principal = await operations.authorizeWrite({
        action: 'contact.create',
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        csrfToken: request.headers['x-csrf-token'],
        origin: request.headers.origin,
      });
      const result = await operations.createContact({
        actor: principal.actor,
        correlationId: contextFor(request).correlationId,
        displayName: body.displayName,
        phone: body.phone,
        email: body.email,
        idempotencyKey: requireIdentifier(
          request.headers['idempotency-key'],
          'IDEMPOTENCY_KEY',
        ),
      });
      privateReadHeaders(reply);
      return reply
        .code(result.created ? 201 : 200)
        .send({ contact: result.contact });
    }),
  );

  api.post('/api/v1/contacts/:contactId/name', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['displayName', 'expectedVersion', 'reason']);
      const principal = await operations.authorizeWrite({
        action: 'contact.rename',
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        csrfToken: request.headers['x-csrf-token'],
        origin: request.headers.origin,
      });
      const result = await operations.renameContact({
        actor: principal.actor,
        contactId: requireIdentifier(params.contactId, 'CONTACT_ID'),
        correlationId: contextFor(request).correlationId,
        displayName: body.displayName,
        expectedVersion: body.expectedVersion,
        reason: requireIdentifier(body.reason, 'REASON'),
      });
      privateReadHeaders(reply);
      return reply.code(200).send(result);
    }),
  );

  api.post('/api/v1/contacts/:contactId/details', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['phone', 'email', 'expectedVersion']);
      const principal = await operations.authorizeWrite({
        action: 'contact.rename',
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        csrfToken: request.headers['x-csrf-token'],
        origin: request.headers.origin,
      });
      const result = await operations.setContactDetails({
        actor: principal.actor,
        contactId: requireIdentifier(params.contactId, 'CONTACT_ID'),
        correlationId: contextFor(request).correlationId,
        email: body.email,
        expectedVersion: body.expectedVersion,
        idempotencyKey: requireIdentifier(
          request.headers['idempotency-key'],
          'IDEMPOTENCY_KEY',
        ),
        phone: body.phone,
      });
      privateReadHeaders(reply);
      return reply.code(200).send({ contact: result });
    }),
  );

  // ADR 047 / CP-25..27: PUT replaces the whole optional registration.
  api.put('/api/v1/contacts/:contactId/registration', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['expectedVersion', 'registration']);
      const registration = requireObject(body.registration);
      rejectUnknownKeys(registration, REGISTRATION_FIELDS);
      const principal = await operations.authorizeWrite({
        action: 'contact.rename',
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        csrfToken: request.headers['x-csrf-token'],
        origin: request.headers.origin,
      });
      const result = await operations.setContactRegistration({
        actor: principal.actor,
        contactId: requireIdentifier(params.contactId, 'CONTACT_ID'),
        correlationId: contextFor(request).correlationId,
        expectedVersion: body.expectedVersion,
        idempotencyKey: requireIdentifier(
          request.headers['idempotency-key'],
          'IDEMPOTENCY_KEY',
        ),
        registration,
      });
      privateNoStoreHeaders(reply);
      return reply.code(200).send({ contact: result });
    }),
  );

  // ADR 047 / CP-28: the API, not the browser, asks ViaCEP for a suggestion.
  // The CEP travels in the body so proxy access logs never record it.
  api.post(
    '/api/v1/postal-codes/lookup',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) =>
      respond(reply, async () => {
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['postalCode']);
        await operations.authorizeWrite({
          action: 'contact.read',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          csrfToken: request.headers['x-csrf-token'],
          origin: request.headers.origin,
        });
        const suggestion = await operations.lookupPostalCode({
          postalCode: body.postalCode,
        });
        privateNoStoreHeaders(reply);
        return reply.code(200).send(suggestion);
      }),
  );

  api.get('/api/v1/contacts/:contactId', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      await authorizeRead(request, operations, 'contact.read');
      // The detail carries the encrypted-at-rest registration (ADR 047).
      privateNoStoreHeaders(reply);
      return reply.code(200).send(
        await operations.getContact({
          contactId: requireIdentifier(params.contactId, 'CONTACT_ID'),
        }),
      );
    }),
  );
}

/** @param {any} request @param {any} operations @param {string} action */
async function authorizeRead(request, operations, action) {
  return operations.authorizeRead({
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    secFetchSite: request.headers['sec-fetch-site'],
  });
}

/** @param {unknown} value @param {string[]} allowed */
function parseListQuery(value, allowed) {
  const query = requireObject(value ?? {});
  rejectUnknownKeys(query, allowed);
  const parsed = /** @type {Record<string, any>} */ ({});
  for (const key of allowed) {
    if (query[key] === undefined) continue;
    if (key === 'limit') {
      if (
        typeof query[key] !== 'string' ||
        !/^[0-9]+$/u.test(query[key]) ||
        Number(query[key]) < 1 ||
        Number(query[key]) > 100
      ) {
        throw new OperationReadRequestError(400, 'INVALID_LIMIT');
      }
      parsed[key] = Number(query[key]);
      continue;
    }
    if (
      key === 'archived' ||
      key === 'pendingHandoff' ||
      key === 'unassignedHumanHandoff'
    ) {
      if (query[key] !== 'true' && query[key] !== 'false') {
        throw new OperationReadRequestError(400, 'INVALID_FILTER');
      }
      parsed[key] = query[key] === 'true';
      continue;
    }
    parsed[key] = requireIdentifier(
      query[key],
      key.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase(),
      key === 'cursor' ? 1024 : 512,
    );
  }
  return parsed;
}

/** @param {unknown} value */
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationReadRequestError(400, 'INVALID_REQUEST');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} field @param {number} [limit] */
function requireIdentifier(value, field, limit = 512) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > limit ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OperationReadRequestError(400, `INVALID_${field}`);
  }
  return value.trim();
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function rejectUnknownKeys(value, allowed) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new OperationReadRequestError(400, 'INVALID_REQUEST');
  }
}

/** @param {import('fastify').FastifyReply} reply */
function privateReadHeaders(reply) {
  reply.header('cache-control', 'private, no-cache');
  reply.header('vary', 'Origin, Cookie');
}

/**
 * ADR 047: responses with the customer registration or a postal-code lookup
 * must not be kept by the browser or an intermediary cache.
 * @param {import('fastify').FastifyReply} reply
 */
function privateNoStoreHeaders(reply) {
  reply.header('cache-control', 'private, no-store');
  reply.header('vary', 'Origin, Cookie');
}

/** @param {import('fastify').FastifyReply} reply @param {() => Promise<unknown>} operation */
async function respond(reply, operation) {
  try {
    return await operation();
  } catch (error) {
    const normalized =
      /** @type {{code?: unknown, field?: unknown, statusCode?: unknown}} */ (
        error
      );
    const statusCode = Number(normalized?.statusCode);
    if (!Number.isSafeInteger(statusCode) || statusCode < 400) throw error;
    const publicStatus = statusCode >= 500 ? 503 : statusCode;
    const allowed = new Set([
      'CONTACT_CONFLICT',
      'CONTACT_PHONE_MATCH',
      'CONTACT_NOT_FOUND',
      'CONVERSATION_NOT_FOUND',
      'FORBIDDEN',
      'IDEMPOTENCY_KEY_REUSED',
      'INVALID_CURSOR',
      'INVALID_DISPLAY_NAME',
      'INVALID_FILTER',
      'INVALID_LIMIT',
      'INVALID_REQUEST',
      'POSTAL_CODE_NOT_FOUND',
      ...REGISTRATION_CODES,
    ]);
    const rawCode = String(normalized.code);
    const code =
      statusCode >= 500
        ? PUBLIC_UNAVAILABLE_CODES.has(rawCode)
          ? rawCode
          : 'SERVICE_UNAVAILABLE'
        : allowed.has(rawCode)
          ? rawCode
          : 'INVALID_REQUEST';
    const field =
      statusCode === 400 &&
      REGISTRATION_CODES.has(code) &&
      typeof normalized.field === 'string' &&
      REGISTRATION_FIELDS.includes(normalized.field)
        ? normalized.field
        : undefined;
    return reply
      .code(publicStatus)
      .send({ error: field ? { code, field } : { code } });
  }
}
