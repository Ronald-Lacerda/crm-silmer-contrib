import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import {
  MAX_ORDER_FILE_BYTES,
  OrderFileTooLargeError,
  renderOrderFicha,
} from '@crm-silmer/orders';
import { renderOrderPdf } from './order-pdf.js';

const ORDER_STATUSES = new Set(['pendente', 'confirmado']);
const ORDER_ORIGINS = new Set(['atendimento', 'loja']);
const ORDER_SECTIONS = new Set(['summary', 'items', 'observations', 'artwork']);
const SUMMARY_PERIODS = new Set(['hoje', '7dias', 'mes']);
const DELIVERY_FILTERS = new Set(['overdue', 'due_soon']);

/**
 * Codes an order route may return as they are. Anything else collapses to
 * INVALID_REQUEST (4xx) or SERVICE_UNAVAILABLE (5xx), so internal messages
 * and identifiers never reach the client.
 */
const PUBLIC_CODES = new Set([
  'STORE_ORDER_CONFLICT',
  'AMOUNT_BELOW_PRICE',
  'CONTACT_NOT_FOUND',
  'CONVERSATION_NOT_FOUND',
  'EMPTY_FILE',
  'FILE_CONTENT_MISMATCH',
  'FILE_LIMIT_REACHED',
  'FILE_NOT_FOUND',
  'FILE_TOO_LARGE',
  'FILE_TYPE_NOT_ALLOWED',
  'FORBIDDEN',
  'IDEMPOTENCY_KEY_REUSED',
  'INVALID_AMOUNT',
  'INVALID_GRADE',
  'ORDER_INVALID',
  'ORDER_LOCKED',
  'ORDER_NOT_CONFIRMABLE',
  'ORDER_NOT_CONFIRMED',
  'ORDER_NOT_FOUND',
  'ORDER_STATUS_CONFLICT',
  'VERSION_CONFLICT',
]);

class OrderRequestError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'OrderRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Order endpoints (ADR 006). Reads need an operational session; ownership is
 * enforced by the orders runtime on each command.
 *
 * @param {import('fastify').FastifyInstance} api
 * @param {Record<string, any>} orders
 * @param {(request: object) => {correlationId: string, requestId: string}} contextFor
 */
export function registerOrderRoutes(
  api,
  orders,
  contextFor,
  pdfRenderer = renderOrderPdf,
) {
  api.get('/api/v1/orders/summary', async (request, reply) =>
    respond(reply, async () => {
      const query = requireObject(request.query ?? {});
      rejectUnknownKeys(query, ['period']);
      if (query.period !== undefined && !SUMMARY_PERIODS.has(query.period)) {
        throw new OrderRequestError(400, 'INVALID_FILTER');
      }
      await authorizeRead(request, orders);
      privateReadHeaders(reply);
      return reply
        .code(200)
        .send(await orders.summary({ period: query.period ?? 'hoje' }));
    }),
  );
  api.get('/api/v1/orders', async (request, reply) =>
    respond(reply, async () => {
      const input = parseListQuery(request.query);
      if ((input.q?.match(/\d/gu) ?? []).length >= 8) {
        throw new OrderRequestError(400, 'INVALID_REQUEST');
      }
      const access = await authorizeRead(request, orders);
      privateReadHeaders(reply);
      return reply
        .code(200)
        .send(await orders.list(withOwner(input, access.actor.id)));
    }),
  );

  api.post(
    '/api/v1/orders/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) =>
      respond(reply, async () => {
        const body = requireObject(request.body);
        if (body.limit !== undefined && !Number.isSafeInteger(body.limit)) {
          throw new OrderRequestError(400, 'INVALID_LIMIT');
        }
        const input = parseListQuery({
          ...body,
          ...(body.limit !== undefined ? { limit: String(body.limit) } : {}),
        });
        if (!input.q) throw new OrderRequestError(400, 'INVALID_QUERY');
        const principal = await orders.authorizeWrite({
          action: 'order.read',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          csrfToken: request.headers['x-csrf-token'],
          origin: request.headers.origin,
        });
        privateReadHeaders(reply);
        return reply
          .code(200)
          .send(await orders.list(withOwner(input, principal.actor.id)));
      }),
  );

  api.post('/api/v1/orders', async (request, reply) =>
    respond(reply, async () => {
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['contactId']);
      const command = await authorizeCommand(
        request,
        orders,
        contextFor,
        'order.create',
      );
      const order = await orders.createForContact({
        ...command,
        contactId: requireIdentifier(body.contactId, 'CONTACT_ID'),
      });
      privateReadHeaders(reply);
      return reply.code(201).send({ order });
    }),
  );

  api.get('/api/v1/orders/:orderId', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      await authorizeRead(request, orders);
      privateReadHeaders(reply);
      return reply.code(200).send(await orders.get(orderId));
    }),
  );

  /**
   * PIM-02/PIM-03/PIM-05: the printed document of a confirmed order. Any
   * operational session may print one, so this read is not scoped to the
   * conversation owner; a pending order has no document yet and is refused
   * with 409, the same reason the page keeps the button locked. The template
   * is chosen in one place, `PRINT_TEMPLATE` (PIM-10, ADR 017); a site shop
   * order prints its simplified ficha (ADR 027). `?download=1` sends the
   * same document as the attachment `pedido-NN-CRM.html` (LOJ-10). ADR 031:
   * the first time a person prints or downloads a store order's ficha, the
   * order records who and when and leaves the Dashboard notice; later prints
   * change nothing. Fastify answers HEAD on this route too; a HEAD sends no
   * document, so it records nothing.
   */
  api.get('/api/v1/orders/:orderId/print', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      const query = requireObject(request.query ?? {});
      rejectUnknownKeys(query, ['download']);
      if (query.download !== undefined && query.download !== '1') {
        throw new OrderRequestError(400, 'INVALID_REQUEST');
      }
      const principal = await authorizeRead(request, orders, 'order.print');
      const { order } = await orders.get(orderId);
      if (order.status !== 'confirmado') {
        throw new OrderRequestError(409, 'ORDER_NOT_CONFIRMED');
      }
      if (
        request.method !== 'HEAD' &&
        order.origin === 'loja' &&
        !order.fichaFirstPrintedAt
      ) {
        await orders.recordFirstPrint({
          actor: principal.actor,
          correlationId: contextFor(request).correlationId,
          orderId,
        });
      }
      privateReadHeaders(reply);
      if (query.download === '1') {
        reply.header(
          'content-disposition',
          attachment('pedido-' + order.number + '.html'),
        );
      }
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(renderOrderFicha(order));
    }),
  );

  /** PIM-13: an authenticated, shareable PDF of the approved ficha. */
  api.register(async (pdfScope) => {
    await pdfScope.register(rateLimit, { global: false });
    pdfScope.get(
      '/api/v1/orders/:orderId/pdf',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (request, reply) =>
        respond(reply, async () => {
          const params = requireObject(request.params);
          const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
          rejectUnknownKeys(requireObject(request.query ?? {}), []);
          const principal = await authorizeRead(request, orders, 'order.print');
          const { order } = await orders.get(orderId);
          if (order.status !== 'confirmado') {
            throw new OrderRequestError(409, 'ORDER_NOT_CONFIRMED');
          }
          reply.header('cache-control', 'private, no-store');
          reply.header('vary', 'Origin, Cookie');
          reply.header('x-content-type-options', 'nosniff');
          reply.header(
            'content-security-policy',
            "default-src 'none'; sandbox",
          );
          reply.header(
            'content-disposition',
            attachment(`pedido-${order.number}.pdf`),
          );
          if (request.method === 'HEAD') {
            return reply.code(200).type('application/pdf').send();
          }
          const pdf = await pdfRenderer(renderOrderFicha(order));
          if (order.origin === 'loja' && !order.fichaFirstPrintedAt) {
            await orders.recordFirstPrint({
              actor: principal.actor,
              correlationId: contextFor(request).correlationId,
              orderId,
            });
          }
          return reply.code(200).type('application/pdf').send(pdf);
        }),
    );
  });

  api.get(
    '/api/v1/conversations/:conversationId/order',
    async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        const conversationId = requireIdentifier(
          params.conversationId,
          'CONVERSATION_ID',
        );
        await authorizeRead(request, orders);
        privateReadHeaders(reply);
        return reply
          .code(200)
          .send(await orders.currentForConversation(conversationId));
      }),
  );

  api.post(
    '/api/v1/conversations/:conversationId/orders',
    async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        const conversationId = requireIdentifier(
          params.conversationId,
          'CONVERSATION_ID',
        );
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['expectedVersion']);
        const expectedVersion = requireVersion(body.expectedVersion);
        const command = await authorizeCommand(
          request,
          orders,
          contextFor,
          'order.create',
        );
        const result = await orders.createManual({
          ...command,
          conversationId,
          expectedVersion,
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({ order: result.order });
      }),
  );

  api.patch(
    '/api/v1/orders/:orderId/sections/:section',
    async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
        if (!ORDER_SECTIONS.has(params.section)) {
          throw new OrderRequestError(400, 'INVALID_SECTION');
        }
        const body = requireObject(request.body);
        rejectUnknownKeys(body, ['expectedVersion', 'value']);
        const expectedVersion = requireVersion(body.expectedVersion);
        if (!Object.hasOwn(body, 'value')) {
          throw new OrderRequestError(400, 'INVALID_REQUEST');
        }
        const command = await authorizeCommand(
          request,
          orders,
          contextFor,
          'order.edit',
        );
        const order = await orders.patchSection({
          ...command,
          expectedVersion,
          orderId,
          section: params.section,
          value: body.value,
        });
        return reply.code(200).send({ order });
      }),
  );

  api.post('/api/v1/orders/:orderId/store-correction', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      const body = requireObject(request.body);
      rejectUnknownKeys(body, [
        'expectedVersion',
        'expectedQuantity',
        'expectedAmountCents',
        'quantity',
        'reason',
      ]);
      const expectedVersion = requireVersion(body.expectedVersion);
      const command = await authorizeCommand(
        request,
        orders,
        contextFor,
        'order.edit',
      );
      const order = await orders.correctStoreOrder({
        ...command,
        orderId,
        expectedVersion,
        expectedQuantity: body.expectedQuantity,
        expectedAmountCents: body.expectedAmountCents,
        quantity: body.quantity,
        reason: body.reason,
      });
      return reply
        .header('cache-control', 'no-store')
        .code(200)
        .send({ order });
    }),
  );

  api.post('/api/v1/orders/:orderId/confirm', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      const body = requireObject(request.body);
      rejectUnknownKeys(body, [
        'amountText',
        'expectedVersion',
        'paymentCondition',
      ]);
      const expectedVersion = requireVersion(body.expectedVersion);
      // A missing amount or condition is not malformed: the service answers
      // 422 ORDER_NOT_CONFIRMABLE naming it, next to the other blockers.
      for (const field of ['amountText', 'paymentCondition']) {
        if (body[field] !== undefined && typeof body[field] !== 'string') {
          throw new OrderRequestError(400, 'INVALID_REQUEST');
        }
      }
      const command = await authorizeCommand(
        request,
        orders,
        contextFor,
        'order.confirm',
      );
      const order = await orders.confirm({
        ...command,
        amountText: body.amountText,
        expectedVersion,
        orderId,
        paymentCondition: body.paymentCondition,
      });
      return reply.code(200).send({ order });
    }),
  );

  api.post('/api/v1/orders/:orderId/reopen', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['expectedVersion']);
      const expectedVersion = requireVersion(body.expectedVersion);
      const command = await authorizeCommand(
        request,
        orders,
        contextFor,
        'order.reopen',
      );
      const order = await orders.reopen({
        ...command,
        expectedVersion,
        orderId,
      });
      return reply.code(200).send({ order });
    }),
  );

  /**
   * PLA-04/PLA-05: the paid and delivered days, both in every write (null
   * clears one). A confirmed order takes them without a reopen.
   */
  api.patch('/api/v1/orders/:orderId/milestones', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      const body = requireObject(request.body);
      rejectUnknownKeys(body, ['deliveredOn', 'expectedVersion', 'paidOn']);
      const expectedVersion = requireVersion(body.expectedVersion);
      // A malformed or future day is not malformed JSON: the service answers
      // 422 INVALID_DATE naming the field.
      for (const field of ['deliveredOn', 'paidOn']) {
        if (body[field] !== null && typeof body[field] !== 'string') {
          throw new OrderRequestError(400, 'INVALID_REQUEST');
        }
      }
      const command = await authorizeCommand(
        request,
        orders,
        contextFor,
        'order.milestones',
      );
      const order = await orders.recordMilestones({
        ...command,
        deliveredOn: body.deliveredOn,
        expectedVersion,
        orderId,
        paidOn: body.paidOn,
      });
      return reply.code(200).send({ order });
    }),
  );

  registerOrderFileRoutes(api, orders, contextFor);
}

/**
 * ADR 023: the art files of an order. Listing and downloading need order
 * access; sending and removing are order edits (owner or admin, pending
 * order) under an Idempotency-Key. The upload is multipart with a `slot`
 * field, the `file` and, for an image, the `thumbnail` the page drew.
 *
 * @param {import('fastify').FastifyInstance} api
 * @param {Record<string, any>} orders
 * @param {(request: object) => {correlationId: string, requestId: string}} contextFor
 */
function registerOrderFileRoutes(api, orders, contextFor) {
  api.get('/api/v1/orders/:orderId/files', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      await authorizeRead(request, orders);
      privateReadHeaders(reply);
      return reply.code(200).send(await orders.listFiles(orderId));
    }),
  );

  api.get(
    '/api/v1/orders/:orderId/files/:fileId/content',
    async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
        const fileId = requireIdentifier(params.fileId, 'FILE_ID');
        const principal = await authorizeRead(request, orders);
        const opened = await orders.openFileContent({
          actor: principal.actor,
          correlationId: contextFor(request).correlationId,
          fileId,
          orderId,
        });
        // Always a download, never rendered: an SVG or PDF from a client
        // must not run in the CRM origin.
        privateReadHeaders(reply);
        reply.header('content-disposition', attachment(opened.file.name));
        sandboxHeaders(reply, opened.contentLength);
        return reply
          .code(200)
          .type(opened.file.contentType)
          .send(opened.stream);
      }),
  );

  api.get(
    '/api/v1/orders/:orderId/files/:fileId/thumbnail',
    async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
        const fileId = requireIdentifier(params.fileId, 'FILE_ID');
        await authorizeRead(request, orders);
        const opened = await orders.openFileThumbnail(orderId, fileId);
        // A file id never changes its bytes, so the browser may keep it.
        reply.header('cache-control', 'private, max-age=86400, immutable');
        reply.header('vary', 'Origin, Cookie');
        sandboxHeaders(reply, opened.contentLength);
        return reply.code(200).type('image/webp').send(opened.stream);
      }),
  );

  api.delete('/api/v1/orders/:orderId/files/:fileId', async (request, reply) =>
    respond(reply, async () => {
      const params = requireObject(request.params);
      const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
      const fileId = requireIdentifier(params.fileId, 'FILE_ID');
      const command = await authorizeCommand(
        request,
        orders,
        contextFor,
        'order.edit',
      );
      return reply
        .code(200)
        .send(await orders.removeFile({ ...command, fileId, orderId }));
    }),
  );

  api.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fieldNameSize: 16,
        fieldSize: 16,
        fields: 1,
        fileSize: MAX_ORDER_FILE_BYTES,
        files: 2,
        headerPairs: 50,
        parts: 3,
      },
    });

    scope.post('/api/v1/orders/:orderId/files', async (request, reply) =>
      respond(reply, async () => {
        const params = requireObject(request.params);
        const orderId = requireIdentifier(params.orderId, 'ORDER_ID');
        // The session is checked before a byte of the body is read.
        const command = await authorizeCommand(
          request,
          orders,
          contextFor,
          'order.edit',
        );
        const upload = await readUpload(request);
        return reply
          .code(201)
          .send(await orders.uploadFile({ ...command, ...upload, orderId }));
      }),
    );
  });
}

/**
 * @param {any} request
 * @returns {Promise<{slot: string, name: string, content: Buffer, thumbnail: Buffer|null}>}
 */
async function readUpload(request) {
  /** @type {string|undefined} */
  let slot;
  /** @type {{name: string, content: Buffer}|undefined} */
  let file;
  /** @type {Buffer|null} */
  let thumbnail = null;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === 'file' && !file) {
        file = { content: await part.toBuffer(), name: part.filename };
      } else if (
        part.type === 'file' &&
        part.fieldname === 'thumbnail' &&
        thumbnail === null
      ) {
        thumbnail = await part.toBuffer();
      } else if (
        part.type === 'field' &&
        part.fieldname === 'slot' &&
        slot === undefined &&
        typeof part.value === 'string'
      ) {
        slot = part.value;
      } else {
        throw new OrderRequestError(400, 'INVALID_REQUEST');
      }
    }
  } catch (error) {
    if (error instanceof OrderRequestError) throw error;
    const code = /** @type {{code?: unknown}} */ (error)?.code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new OrderFileTooLargeError();
    throw new OrderRequestError(400, 'INVALID_REQUEST');
  }
  if (!file || slot === undefined) {
    throw new OrderRequestError(400, 'INVALID_REQUEST');
  }
  return { ...file, slot, thumbnail };
}

/**
 * Stored files are served as inert bytes: no sniffing, no scripts, no
 * same-origin access if a browser ever renders one.
 *
 * @param {import('fastify').FastifyReply} reply @param {number|null} contentLength
 */
function sandboxHeaders(reply, contentLength) {
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header('x-content-type-options', 'nosniff');
  if (contentLength !== null) {
    reply.header('content-length', String(contentLength));
  }
}

/**
 * RFC 6266: an ASCII fallback and the UTF-8 name, so accents survive.
 *
 * @param {string} name
 */
function attachment(name) {
  const fallback =
    name
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/gu, '')
      .replace(/["\\]/gu, '_')
      .trim() || 'arquivo';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Checks the Idempotency-Key before the session so a malformed retry is
 * refused without touching the identity store, then authorizes the action
 * with session and CSRF.
 *
 * @param {any} request @param {any} orders @param {Function} contextFor @param {string} action
 */
async function authorizeCommand(request, orders, contextFor, action) {
  const idempotencyKey = requireIdentifier(
    request.headers['idempotency-key'],
    'IDEMPOTENCY_KEY',
    255,
  );
  const principal = await orders.authorizeWrite({
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    csrfToken: request.headers['x-csrf-token'],
    origin: request.headers.origin,
  });
  return {
    actor: principal.actor,
    correlationId: contextFor(request).correlationId,
    idempotencyKey,
  };
}

/** @param {unknown} value */
function requireVersion(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new OrderRequestError(400, 'INVALID_EXPECTED_VERSION');
  }
  return Number(value);
}

/** @param {any} request @param {any} orders @param {string} [action] */
async function authorizeRead(request, orders, action = 'order.read') {
  return orders.authorizeRead({
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    secFetchSite: request.headers['sec-fetch-site'],
  });
}

/** @param {unknown} value */
function parseListQuery(value) {
  const query = requireObject(value ?? {});
  rejectUnknownKeys(query, [
    'cursor',
    'delivery',
    'limit',
    'origin',
    'owner',
    'q',
    'status',
  ]);
  /** @type {{status?: string, origin?: string, q?: string, cursor?: string, limit?: number, delivery?: string, owner?: 'me'}} */
  const input = {};
  // Painel ("Meus pedidos"): only "me"; the seller is always the session's.
  if (query.owner !== undefined) {
    if (query.owner !== 'me') {
      throw new OrderRequestError(400, 'INVALID_FILTER');
    }
    input.owner = 'me';
  }
  // Painel: confirmed orders whose promised day passed or comes this week.
  if (query.delivery !== undefined) {
    if (!DELIVERY_FILTERS.has(query.delivery)) {
      throw new OrderRequestError(400, 'INVALID_FILTER');
    }
    input.delivery = query.delivery;
  }
  if (query.status !== undefined) {
    if (!ORDER_STATUSES.has(query.status)) {
      throw new OrderRequestError(400, 'INVALID_FILTER');
    }
    input.status = query.status;
  }
  // ADR 027: "Loja do site" narrows the list to the site shop's orders.
  if (query.origin !== undefined) {
    if (!ORDER_ORIGINS.has(query.origin)) {
      throw new OrderRequestError(400, 'INVALID_FILTER');
    }
    input.origin = query.origin;
  }
  if (query.q !== undefined) {
    input.q = requireIdentifier(query.q, 'QUERY', 128);
  }
  if (query.cursor !== undefined) {
    input.cursor = requireIdentifier(query.cursor, 'CURSOR', 1024);
  }
  if (query.limit !== undefined) {
    if (
      typeof query.limit !== 'string' ||
      !/^[0-9]{1,3}$/u.test(query.limit) ||
      Number(query.limit) < 1 ||
      Number(query.limit) > 100
    ) {
      throw new OrderRequestError(400, 'INVALID_LIMIT');
    }
    input.limit = Number(query.limit);
  }
  return input;
}

/**
 * @param {{owner?: 'me'} & Record<string, unknown>} input
 * @param {string} actorId
 */
function withOwner({ owner, ...input }, actorId) {
  return owner === 'me' ? { ...input, ownerId: actorId } : input;
}

/** @param {unknown} value */
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderRequestError(400, 'INVALID_REQUEST');
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
    throw new OrderRequestError(400, `INVALID_${field}`);
  }
  return value.trim();
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function rejectUnknownKeys(value, allowed) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new OrderRequestError(400, 'INVALID_REQUEST');
  }
}

/** @param {import('fastify').FastifyReply} reply */
function privateReadHeaders(reply) {
  reply.header('cache-control', 'private, no-cache');
  reply.header('vary', 'Origin, Cookie');
}

/**
 * Maps domain and guard errors to the OrderError contract: `fields` and
 * `index` travel only with 422, where the page shows them next to the field.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {() => Promise<unknown>} operation
 */
async function respond(reply, operation) {
  try {
    return await operation();
  } catch (error) {
    const normalized =
      /** @type {{code?: unknown, statusCode?: unknown, fields?: unknown, index?: unknown}} */ (
        error
      );
    const statusCode = Number(normalized?.statusCode);
    if (!Number.isSafeInteger(statusCode) || statusCode < 400) throw error;
    if (statusCode >= 500) {
      return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE' } });
    }
    const code = String(normalized.code);
    /** @type {{code: string, fields?: string[], index?: number}} */
    const body = {
      code:
        PUBLIC_CODES.has(code) || /^INVALID_[A-Z_]+$/u.test(code)
          ? code
          : 'INVALID_REQUEST',
    };
    if (statusCode === 422 && Array.isArray(normalized.fields)) {
      body.fields = normalized.fields.map(String);
    }
    if (statusCode === 422 && Number.isSafeInteger(normalized.index)) {
      body.index = Number(normalized.index);
    }
    return reply.code(statusCode).send({ error: body });
  }
}
