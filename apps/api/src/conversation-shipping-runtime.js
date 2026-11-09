import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { authorize } from '@crm-silmer/identity-access';
import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';

export class ConversationShippingError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value */
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value))
    throw new ConversationShippingError(400, 'INVALID_REQUEST');
  return value;
}

/** @param {unknown} value @param {string} aad @param {Buffer} key */
function encrypt(value, aad, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return {
    algorithm: 'AES-256-GCM',
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** @param {any} row @param {Buffer} key */
function decrypt(row, key) {
  try {
    const envelope = row.quote_envelope;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(`shipping-quote:${row.id}:1`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw new ConversationShippingError(503, 'SHIPPING_QUOTE_UNAVAILABLE');
  }
}

/** @param {any} client @param {any} supplied @param {string} action */
async function actorFor(client, supplied, action) {
  if (supplied?.kind !== 'human')
    throw new ConversationShippingError(403, 'FORBIDDEN');
  const result = await client.query(
    `SELECT u.id,u.name,f.function_name FROM crm.users u
     JOIN crm.user_functions f ON f.user_id=u.id
     WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f`,
    [supplied.id],
  );
  if (!result.rows[0]) throw new ConversationShippingError(403, 'FORBIDDEN');
  const grants = await client.query(
    'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
    [supplied.id],
  );
  const actor = {
    id: supplied.id,
    kind: /** @type {const} */ ('human'),
    functionName: result.rows[0].function_name,
    capabilities: grants.rows.map((/** @type {any} */ row) => row.capability),
  };
  authorize(actor, action);
  return actor;
}

/**
 * T139: the current conversation owns the estimate, not the commercial order.
 * Remote calculations are read-only. Each durable write rechecks the current
 * actor, owner, subject and order after the remote call under row locks.
 * @param {any} database
 * @param {{key:Buffer,clock:()=>Date,calculate:(input:any)=>Promise<any>,requireConfigured:()=>void,environment?:string,contextKey?:string}} options
 */
export function createConversationShippingRuntime(database, options) {
  const { key, clock } = options;

  /** @param {any} client @param {any} input @param {boolean} [checkVersion] */
  async function context(client, input, checkVersion = true) {
    const actor = await actorFor(client, input.actor, 'shipping.quote');
    const conversations = await client.query(
      `SELECT id,assigned_user_id,automation_state,terminal_at
       FROM crm.conversations WHERE id=$1 FOR UPDATE`,
      [identifier(input.conversationId)],
    );
    const conversation = conversations.rows[0];
    if (!conversation)
      throw new ConversationShippingError(404, 'CONVERSATION_NOT_FOUND');
    if (
      !actor.capabilities.includes('COMMERCIAL_ADMIN') &&
      conversation.assigned_user_id !== actor.id
    )
      throw new ConversationShippingError(403, 'FORBIDDEN');
    if (conversation.terminal_at || conversation.automation_state !== 'human')
      throw new ConversationShippingError(409, 'CONVERSATION_NOT_HUMAN');
    const subjects = await client.query(
      `SELECT order_id FROM crm.conversation_subjects
       WHERE id=$1 AND conversation_id=$2 FOR SHARE`,
      [identifier(input.subjectId), input.conversationId],
    );
    if (subjects.rows[0]?.order_id !== identifier(input.orderId))
      throw new ConversationShippingError(409, 'SHIPPING_TARGET_CHANGED');
    const orders = await client.query(
      `SELECT id,version,total_pieces,origin,cancelled_at FROM crm.orders WHERE id=$1 FOR UPDATE`,
      [input.orderId],
    );
    const order = orders.rows[0];
    if (!order) throw new ConversationShippingError(404, 'ORDER_NOT_FOUND');
    // ADR 068: a cancelled order is terminal; quoting/selecting freight is refused.
    if (order.cancelled_at)
      throw new ConversationShippingError(409, 'ORDER_CANCELLED');
    if (order.origin !== 'atendimento')
      throw new ConversationShippingError(409, 'ORDER_LOCKED');
    if (
      !Number.isSafeInteger(input.orderVersion) ||
      input.orderVersion < 1 ||
      (checkVersion && Number(order.version) !== input.orderVersion)
    )
      throw new ConversationShippingError(409, 'VERSION_CONFLICT');
    return order;
  }

  /** @param {any} client @param {string} quoteId */
  async function rowFor(client, quoteId) {
    const result = await client.query(
      `SELECT quote.*,u.name AS creator_name,orders.version AS current_order_version
       FROM crm.shipping_quotes quote
       JOIN crm.users u ON u.id=quote.created_by
       JOIN crm.orders orders ON orders.id=quote.order_id WHERE quote.id=$1`,
      [quoteId],
    );
    if (!result.rows[0])
      throw new ConversationShippingError(404, 'SHIPPING_QUOTE_NOT_FOUND');
    return result.rows[0];
  }

  /** @param {any} row */
  function present(row) {
    const { providerContext, ...payload } = decrypt(row, key);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      subjectId: row.subject_id,
      orderId: row.order_id,
      orderVersion: Number(row.order_version),
      ...payload,
      totalPieces: row.total_pieces,
      selectedServiceId: row.selected_service_id,
      selectedAt: row.selected_at
        ? new Date(row.selected_at).toISOString()
        : null,
      createdAt: new Date(row.created_at).toISOString(),
      createdBy: { id: row.created_by, name: row.creator_name },
      stale:
        Boolean(row.superseded_at) ||
        providerContext !== options.contextKey ||
        Number(row.current_order_version) !== Number(row.order_version),
    };
  }

  /** @param {any} client @param {'quote'|'select'} operation @param {any} input @param {any} body */
  async function command(client, operation, input, body) {
    const idempotencyKey = identifier(input.idempotencyKey);
    const fingerprint = createHmac('sha256', key)
      .update(
        JSON.stringify({
          actor: input.actor.id,
          conversationId: input.conversationId,
          ...body,
        }),
      )
      .digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `shipping-quote:${operation}:${idempotencyKey}`,
    ]);
    const previous = await client.query(
      'SELECT fingerprint,quote_id FROM crm.shipping_quote_commands WHERE operation=$1 AND idempotency_key=$2',
      [operation, idempotencyKey],
    );
    if (previous.rows[0] && previous.rows[0].fingerprint !== fingerprint)
      throw new ConversationShippingError(409, 'IDEMPOTENCY_KEY_REUSED');
    return { idempotencyKey, fingerprint, quoteId: previous.rows[0]?.quote_id };
  }

  /** @param {any} client @param {'quote'|'select'} operation @param {any} input @param {any} identity @param {string} quoteId */
  async function record(client, operation, input, identity, quoteId) {
    await client.query(
      `INSERT INTO crm.shipping_quote_commands(operation,idempotency_key,fingerprint,quote_id,actor_id,completed_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        operation,
        identity.idempotencyKey,
        identity.fingerprint,
        quoteId,
        input.actor.id,
        clock(),
      ],
    );
    await new PostgresAuditTrail(client, { clock }).append({
      actor: input.actor.id,
      action: `shipping.quote.${operation}`,
      target: { type: 'shipping-quote', id: quoteId },
      version: 1,
      reason:
        operation === 'quote'
          ? 'SHIPPING_QUOTED'
          : 'SHIPPING_ESTIMATE_SELECTED',
      correlationId: input.correlationId,
    });
  }

  return Object.freeze({
    /** @param {any} input */
    async quote(input) {
      options.requireConfigured();
      const body = input.body;
      const target = { ...input, ...body };
      // Authorize/replay before contacting the provider; repeat after the call.
      const replay = await database.transaction(
        async (/** @type {any} */ client) => {
          await context(client, target, false);
          const identity = await command(client, 'quote', input, body);
          if (identity.quoteId)
            return { quote: present(await rowFor(client, identity.quoteId)) };
          await context(client, target);
          return null;
        },
      );
      if (replay) return replay;
      const { subjectId, orderId, orderVersion, ...packageInput } = body;
      const result = await options.calculate({ ...input, body: packageInput });
      return database.transaction(async (/** @type {any} */ client) => {
        const order = await context(client, target, false);
        const identity = await command(client, 'quote', input, body);
        if (identity.quoteId)
          return { quote: present(await rowFor(client, identity.quoteId)) };
        await context(client, target);
        await client.query(
          'UPDATE crm.shipping_quotes SET superseded_at=$2 WHERE order_id=$1 AND superseded_at IS NULL',
          [orderId, clock()],
        );
        const id = `quote-${randomUUID()}`;
        const envelope = encrypt(
          {
            input: packageInput,
            ...result,
            environment: options.environment,
            providerContext: options.contextKey,
          },
          `shipping-quote:${id}:1`,
          key,
        );
        await client.query(
          `INSERT INTO crm.shipping_quotes(id,conversation_id,subject_id,order_id,order_version,total_pieces,quote_envelope,created_by,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
          [
            id,
            input.conversationId,
            subjectId,
            orderId,
            orderVersion,
            order.total_pieces,
            JSON.stringify(envelope),
            input.actor.id,
            clock(),
          ],
        );
        await record(client, 'quote', input, identity, id);
        return { quote: present(await rowFor(client, id)) };
      });
    },
    /** @param {any} input */
    async select(input) {
      options.requireConfigured();
      const target = { ...input, ...input.body };
      return database.transaction(async (/** @type {any} */ client) => {
        await context(client, target, false);
        const identity = await command(client, 'select', input, {
          quoteId: input.quoteId,
          ...input.body,
        });
        const row = await rowFor(client, identifier(input.quoteId));
        if (
          row.order_id !== target.orderId ||
          row.subject_id !== target.subjectId ||
          row.conversation_id !== input.conversationId
        )
          throw new ConversationShippingError(409, 'SHIPPING_TARGET_CHANGED');
        if (identity.quoteId) return { quote: present(row) };
        await context(client, target);
        if (
          row.superseded_at ||
          Number(row.order_version) !== target.orderVersion ||
          decrypt(row, key).providerContext !== options.contextKey
        )
          throw new ConversationShippingError(409, 'SHIPPING_QUOTE_STALE');
        const quote = decrypt(row, key);
        if (
          !Number.isSafeInteger(input.body.serviceId) ||
          !quote.services.some(
            (/** @type {any} */ service) => service.id === input.body.serviceId,
          )
        )
          throw new ConversationShippingError(422, 'INVALID_SHIPPING_SERVICE');
        await client.query(
          'UPDATE crm.shipping_quotes SET selected_service_id=$2,selected_by=$3,selected_at=$4 WHERE id=$1',
          [row.id, input.body.serviceId, input.actor.id, clock()],
        );
        await record(client, 'select', input, identity, row.id);
        return { quote: present(await rowFor(client, row.id)) };
      });
    },
    /** @param {any} input */
    async read(input) {
      options.requireConfigured();
      return database.transaction(async (/** @type {any} */ client) => {
        await actorFor(client, input.actor, 'order.read');
        const orderId = identifier(input.orderId);
        const order = await client.query(
          'SELECT id FROM crm.orders WHERE id=$1',
          [orderId],
        );
        if (!order.rows[0])
          throw new ConversationShippingError(404, 'ORDER_NOT_FOUND');
        const result = await client.query(
          `SELECT id FROM crm.shipping_quotes WHERE order_id=$1
           ORDER BY selected_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
          [orderId],
        );
        return {
          quote: result.rows[0]
            ? present(await rowFor(client, result.rows[0].id))
            : null,
        };
      });
    },
  });
}
