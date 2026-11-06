import { sizePricingSummary } from '../domain/size-pricing-composition.js';
import { randomUUID } from 'node:crypto';

import {
  OrderConflictError,
  OrderForbiddenError,
  OrderNotFoundError,
} from '../domain/errors.js';
import {
  StoreOrderDuplicateError,
  StoreOrderError,
} from '../domain/store-order.js';
import {
  encodeOrderCursor,
  readOrderListQuery,
  statusEventType,
} from '../ports/contracts.js';
import { decryptJson, encryptJson } from './envelope.js';

/**
 * @typedef {import('../ports/contracts.js').Order} Order
 * @typedef {import('../ports/contracts.js').OrderWriteOptions} OrderWriteOptions
 * @typedef {{query: (sql: string, values?: unknown[]) => Promise<{rows: any[]}>}} Queryable
 * @typedef {{query: Queryable['query'], transaction: <T>(work: (transaction: Queryable) => Promise<T>) => Promise<T>}} TransactionalDatabase
 */

const ORDER_COLUMNS = `id, number_sequence, number, conversation_id,
  contact_id, manual_owner_id, manual_create_key, status,
  fab_code, ficha_envelope, total_pieces, missing_fields, final_amount_cents,
  payment_condition, order_date::text AS order_date, confirmed_at,
  confirmed_by, reopened_at, reopened_by, created_by_kind, created_by,
  first_contact_at, paid_on::text AS paid_on, finance_payment_review_required,
  delivered_on::text AS delivered_on, origin, is_test, store_number,
  lead_time_business_days, payment_source, payment_confirmed_at,
  paid_amount_cents, payment_transaction_nsu, payment_invoice_slug,
  ficha_first_printed_at, ficha_first_printed_by,
  version, created_at, updated_at`;

/** @param {string} orderId */
function fichaAad(orderId) {
  return `order-ficha:${orderId}`;
}

/** @param {Date|string|null} value */
function isoOrNull(value) {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Publishes the change on the shared domain event stream inside the same
 * transaction, so no event exists for a write that rolled back. The payload
 * carries identifiers only; the Inbox and the order list re-read the order
 * through the authorized API.
 *
 * @param {Queryable} transaction
 * @param {Order} order
 * @param {string} eventType
 * @param {string} correlationId
 */
async function appendOrderEvent(transaction, order, eventType, correlationId) {
  await transaction.query(
    `INSERT INTO crm.domain_events
       (id, aggregate_type, aggregate_id, aggregate_version, event_type,
        payload, correlation_id, occurred_at)
     VALUES ($1, 'order', $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      `event-${randomUUID()}`,
      order.id,
      order.version,
      eventType,
      JSON.stringify({
        conversationId: order.conversationId,
        orderId: order.id,
      }),
      correlationId,
      order.updatedAt,
    ],
  );
}

/** @param {unknown} error @param {string} constraint */
function violates(error, constraint) {
  const candidate = /** @type {{code?: string, constraint?: string}} */ (error);
  return (
    (candidate?.code === '23505' || candidate?.code === '23503') &&
    candidate.constraint === constraint
  );
}

/**
 * ADR 028: the audit of a store order write, in its transaction. Only the
 * technical actor, the order id, its version and the correlation: no name,
 * phone, receipt link or gateway identifier.
 *
 * @param {Queryable} transaction
 * @param {Order} order
 * @param {{action: string, reason: string, audit: import('../ports/contracts.js').StoreAuditContext}} input
 */
async function appendStoreAudit(transaction, order, { action, audit, reason }) {
  await transaction.query(
    `INSERT INTO crm.audit_events
       (id, actor_id, action, target_type, target_id, version, reason,
        correlation_id, occurred_at)
     VALUES ($1, $2, $3, 'order', $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      audit.actor,
      action,
      order.id,
      String(order.version),
      reason,
      audit.correlationId,
      order.updatedAt,
    ],
  );
}

/**
 * Conversation transfers lock this row first. Keeping the same lock until
 * commit orders ownership changes and order writes against each other.
 *
 * @param {Queryable} transaction @param {string} conversationId
 */
export async function lockConversation(transaction, conversationId) {
  const result = await transaction.query(
    `SELECT assigned_user_id, terminal_at FROM crm.conversations
     WHERE id = $1 FOR UPDATE`,
    [conversationId],
  );
  return result.rows[0] ?? null;
}

/**
 * The service checks before validation to avoid leaking details. This second
 * check runs against the locked assignment, before any order write. An admin
 * grant is checked in the same transaction and held against revocation.
 *
 * @param {Queryable} transaction
 * @param {{id: string, kind: string, capabilities?: readonly string[]}|undefined} actor
 * @param {{assigned_user_id: string|null}} conversation
 * @param {boolean} allowTechnical
 */
export async function assertWriteOwner(
  transaction,
  actor,
  conversation,
  allowTechnical,
) {
  // Only automation creation and briefing projection may omit a human actor.
  if (!actor) {
    if (allowTechnical) return;
    throw new OrderForbiddenError();
  }
  if (actor.kind !== 'human' || !actor.id) throw new OrderForbiddenError();
  if (conversation.assigned_user_id === actor.id) return;
  if (!(actor.capabilities ?? []).includes('COMMERCIAL_ADMIN')) {
    throw new OrderForbiddenError();
  }
  const grant = await transaction.query(
    `SELECT 1 FROM crm.user_capabilities
     WHERE user_id = $1 AND capability = 'COMMERCIAL_ADMIN'
     FOR SHARE`,
    [actor.id],
  );
  if (!grant.rows[0]) throw new OrderForbiddenError();
}

export class PostgresOrderRepository {
  /** @type {TransactionalDatabase} */
  #database;
  /** @type {Buffer} */
  #envelopeKey;

  /**
   * `envelopeKey` is the key the n8n integration uses for the pre-ficha
   * (`N8N_INTEGRATION_ENVELOPE_KEY`): the ficha is built from that briefing.
   *
   * @param {{database: TransactionalDatabase, envelopeKey: Buffer}} options
   */
  constructor({ database, envelopeKey }) {
    if (
      !database ||
      typeof database.query !== 'function' ||
      typeof database.transaction !== 'function'
    ) {
      throw new TypeError('A transactional PostgreSQL database is required');
    }
    if (!Buffer.isBuffer(envelopeKey) || envelopeKey.length !== 32) {
      throw new TypeError('envelopeKey must be a 32-byte Buffer');
    }
    this.#database = database;
    this.#envelopeKey = Buffer.from(envelopeKey);
  }

  /** @param {any} row @returns {Order} */
  #map(row) {
    return {
      confirmedAt: isoOrNull(row.confirmed_at),
      confirmedBy: row.confirmed_by,
      conversationId: row.conversation_id,
      contactId: row.contact_id ?? null,
      manualCreateKey: row.manual_create_key ?? null,
      manualOwnerId: row.manual_owner_id ?? null,
      createdAt: /** @type {string} */ (isoOrNull(row.created_at)),
      createdBy: row.created_by,
      createdByKind: row.created_by_kind,
      deliveredOn: row.delivered_on,
      fabCode: row.fab_code,
      ficha: decryptJson(
        row.ficha_envelope,
        fichaAad(row.id),
        this.#envelopeKey,
      ),
      finalAmountCents:
        row.final_amount_cents === null ? null : Number(row.final_amount_cents),
      // ADR 031: the first print of a store order's ficha.
      fichaFirstPrintedAt: isoOrNull(row.ficha_first_printed_at ?? null),
      fichaFirstPrintedBy: row.ficha_first_printed_by ?? null,
      firstContactAt: isoOrNull(row.first_contact_at),
      // ADR 028: the payment InfinitePay confirmed, on a store order only.
      gatewayPayment:
        row.payment_source === 'infinitepay'
          ? {
              confirmedAt: /** @type {string} */ (
                isoOrNull(row.payment_confirmed_at)
              ),
              invoiceSlug: row.payment_invoice_slug,
              paidAmountCents: Number(row.paid_amount_cents),
              source: 'infinitepay',
              transactionNsu: row.payment_transaction_nsu,
            }
          : null,
      id: row.id,
      isTest: row.is_test === true,
      leadTimeBusinessDays:
        row.lead_time_business_days === null ||
        row.lead_time_business_days === undefined
          ? null
          : Number(row.lead_time_business_days),
      missingFields: [...row.missing_fields],
      number: row.number,
      numberSequence: Number(row.number_sequence),
      orderDate: row.order_date,
      origin: row.origin ?? 'atendimento',
      paidOn: row.paid_on,
      paymentReviewRequired: row.finance_payment_review_required ?? false,
      paymentCondition: row.payment_condition,
      reopenedAt: isoOrNull(row.reopened_at),
      reopenedBy: row.reopened_by,
      status: row.status,
      storeNumber: row.store_number ?? null,
      totalPieces: Number(row.total_pieces),
      updatedAt: /** @type {string} */ (isoOrNull(row.updated_at)),
      version: Number(row.version),
    };
  }

  /** @param {import('../ports/contracts.js').CreatePendingOrderInput} input */
  async createPending(input) {
    try {
      return await this.#database.transaction(async (transaction) => {
        let contactId;
        if (input.conversationId) {
          const conversation = await lockConversation(
            transaction,
            input.conversationId,
          );
          if (!conversation) {
            throw new OrderNotFoundError(
              'Conversation was not found',
              'CONVERSATION_NOT_FOUND',
            );
          }
          await assertWriteOwner(
            transaction,
            input.actor,
            conversation,
            input.createdByKind === 'automation',
          );
          if (conversation.terminal_at !== null) {
            throw new OrderConflictError(
              'Conversation is closed',
              'CONVERSATION_CLOSED',
            );
          }
          const linked = await transaction.query(
            `SELECT identity.current_contact_id FROM crm.conversations conversation
             JOIN crm.contact_identities identity
               ON identity.id = conversation.contact_identity_id
             WHERE conversation.id = $1`,
            [input.conversationId],
          );
          contactId = linked.rows[0]?.current_contact_id;
        } else {
          if (
            !input.contactId ||
            !input.manualCreateKey ||
            input.actor?.kind !== 'human' ||
            input.actor.id !== input.manualOwnerId
          ) {
            throw new OrderForbiddenError();
          }
          const contact = await transaction.query(
            'SELECT id FROM crm.contacts WHERE id = $1 FOR SHARE',
            [input.contactId],
          );
          if (!contact.rows[0]) {
            throw new OrderNotFoundError(
              'Contact was not found',
              'CONTACT_NOT_FOUND',
            );
          }
          contactId = input.contactId;
        }
        const reachable = await transaction.query(
          `SELECT 1 FROM crm.contacts AS contact
           WHERE contact.id = $1 AND (
             contact.contact_phone_hash IS NOT NULL OR EXISTS (
               SELECT 1 FROM crm.contact_phone_lookup AS phone
               LEFT JOIN crm.contact_identities AS identity
                 ON identity.id = phone.identity_id
               WHERE (phone.source = 'manual' AND phone.contact_id = contact.id)
                  OR (phone.source = 'whatsapp'
                      AND identity.current_contact_id = contact.id)
             ) OR ($2::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM crm.site_contact_claims AS claim
               JOIN crm.conversations AS conversation
                 ON conversation.id = claim.conversation_id
               JOIN crm.contact_identities AS identity
                 ON identity.id = conversation.contact_identity_id
               WHERE claim.conversation_id = $2
                 AND claim.contact_id = contact.id
                 AND identity.current_contact_id = contact.id
                 AND identity.channel = 'site_chat'
             ))
           ) FOR SHARE OF contact`,
          [contactId, input.conversationId ?? null],
        );
        if (!reachable.rows[0]) {
          throw new OrderConflictError(
            'Contact needs a phone before opening an order',
            'CONTACT_PHONE_REQUIRED',
          );
        }
        const at = input.now.toISOString();
        const inserted = await transaction.query(
          `WITH reserved AS (SELECT nextval('crm.order_number_seq') AS sequence)
           INSERT INTO crm.orders
             (id, number_sequence, number, conversation_id, status, fab_code,
              ficha_version, ficha_envelope, total_pieces, missing_fields,
              created_by_kind, created_by, first_contact_at, version,
              created_at, updated_at, contact_id, manual_owner_id,
              manual_create_key)
           SELECT $1, reserved.sequence,
                  lpad(reserved.sequence::text, 2, '0') || '-CRM',
                  $2, 'pendente', $3, 1, $4::jsonb, $5, $6::text[], $7, $8,
                  $10, 1, $9, $9, $11, $12, $13
           FROM reserved
           ON CONFLICT (manual_create_key) DO NOTHING
           RETURNING ${ORDER_COLUMNS}`,
          [
            input.id,
            input.conversationId,
            input.fabCode,
            JSON.stringify(
              encryptJson(input.ficha, fichaAad(input.id), this.#envelopeKey),
            ),
            input.totalPieces,
            input.missingFields,
            input.createdByKind,
            input.createdBy,
            at,
            input.firstContactAt,
            contactId,
            input.manualOwnerId ?? null,
            input.manualCreateKey ?? null,
          ],
        );
        if (!inserted.rows[0] && input.manualCreateKey) {
          const existing = await transaction.query(
            `SELECT ${ORDER_COLUMNS} FROM crm.orders WHERE manual_create_key = $1`,
            [input.manualCreateKey],
          );
          const row = existing.rows[0];
          if (
            !row ||
            row.contact_id !== contactId ||
            row.manual_owner_id !== input.manualOwnerId
          ) {
            throw new OrderConflictError(
              'Idempotency key was reused',
              'IDEMPOTENCY_KEY_REUSED',
            );
          }
          return this.#map(row);
        }
        const order = this.#map(inserted.rows[0]);
        await appendOrderEvent(
          transaction,
          order,
          'order.created',
          input.correlationId,
        );
        return order;
      });
    } catch (error) {
      if (violates(error, 'orders_one_pending_per_conversation')) {
        throw new OrderConflictError(
          'The conversation already has a pending order',
          'ORDER_PENDING_EXISTS',
        );
      }
      if (violates(error, 'orders_conversation_id_fkey')) {
        throw new OrderNotFoundError(
          'Conversation was not found',
          'CONVERSATION_NOT_FOUND',
        );
      }
      throw error;
    }
  }

  /**
   * ADR 028: the order recorded for a `pedido_id`, with the hash of the data
   * a retry must repeat.
   *
   * @param {string} requestId
   * @returns {Promise<import('../ports/contracts.js').StoredStoreOrder|null>}
   */
  async findStoreOrder(requestId) {
    const result = await this.#database.query(
      `SELECT ${ORDER_COLUMNS}, record_sha256
       FROM crm.orders
       JOIN crm.store_order_receipts ON order_id = id
       WHERE request_id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    return row
      ? { order: this.#map(row), recordSha256: row.record_sha256 }
      : null;
  }

  /**
   * ADR 028: the store order, its receipt, its `order.created` event and its
   * `store.order.create` audit in one transaction. Two calls for the same
   * `pedido_id` wait for each other on an advisory lock, so the loser finds
   * the winner's receipt before it reserves an order number.
   *
   * @param {import('../ports/contracts.js').CreateStoreOrderInput} input
   */
  async createStoreOrder(input) {
    const { audit, now, order, receipt } = input;
    const payment = order.gatewayPayment;
    const at = now.toISOString();
    try {
      return await this.#database.transaction(async (transaction) => {
        await transaction.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`store-order:${receipt.requestId}`],
        );
        const known = await transaction.query(
          'SELECT 1 FROM crm.store_order_receipts WHERE request_id = $1',
          [receipt.requestId],
        );
        if (known.rows[0]) throw new StoreOrderDuplicateError();
        const taken = await transaction.query(
          `SELECT 1 FROM crm.orders
           WHERE payment_source = $1 AND payment_transaction_nsu = $2`,
          [payment.source, payment.transactionNsu],
        );
        if (taken.rows[0]) {
          throw new StoreOrderError(409, 'STORE_ORDER_CONFLICT');
        }
        const inserted = await transaction.query(
          `WITH reserved AS (SELECT nextval('crm.order_number_seq') AS sequence)
           INSERT INTO crm.orders
             (id, number_sequence, number, conversation_id, status, fab_code,
              ficha_version, ficha_envelope, total_pieces, missing_fields,
              final_amount_cents, payment_condition, order_date, confirmed_at,
              confirmed_by, created_by_kind, created_by, first_contact_at,
              paid_on, origin, is_test, store_number, lead_time_business_days,
              payment_source, payment_confirmed_at, paid_amount_cents,
              payment_transaction_nsu, payment_invoice_slug, version,
              created_at, updated_at)
           SELECT $1, reserved.sequence,
                  lpad(reserved.sequence::text, 2, '0') || '-CRM',
                  NULL, 'confirmado', $2, 1, $3::jsonb, $4, '{}'::text[],
                  $5, $6, $7::date, $8, $9, $10, $11, $12, $13::date, 'loja',
                  $14, $15, $16, $17, $18, $19, $20, $21, 1, $8, $8
           FROM reserved
           RETURNING ${ORDER_COLUMNS}`,
          [
            order.id,
            order.fabCode,
            JSON.stringify(
              encryptJson(order.ficha, fichaAad(order.id), this.#envelopeKey),
            ),
            order.totalPieces,
            order.finalAmountCents,
            order.paymentCondition,
            order.orderDate,
            at,
            order.confirmedBy,
            order.createdByKind,
            order.createdBy,
            order.firstContactAt,
            order.paidOn,
            order.isTest,
            order.storeNumber,
            order.leadTimeBusinessDays,
            payment.source,
            payment.confirmedAt,
            payment.paidAmountCents,
            payment.transactionNsu,
            payment.invoiceSlug,
          ],
        );
        const saved = this.#map(inserted.rows[0]);
        await transaction.query(
          `INSERT INTO crm.store_order_receipts
             (order_id, request_id, phone_digest, record_sha256, received_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            saved.id,
            receipt.requestId,
            receipt.phoneDigest,
            receipt.recordSha256,
            at,
          ],
        );
        await appendOrderEvent(
          transaction,
          saved,
          'order.created',
          audit.correlationId,
        );
        await appendStoreAudit(transaction, saved, {
          action: 'store.order.create',
          audit,
          reason: 'INFINITEPAY_PAYMENT_CONFIRMED',
        });
        return saved;
      });
    } catch (error) {
      if (violates(error, 'store_order_receipts_request_id_key')) {
        throw new StoreOrderDuplicateError();
      }
      if (violates(error, 'orders_payment_transaction_nsu')) {
        throw new StoreOrderError(409, 'STORE_ORDER_CONFLICT');
      }
      throw error;
    }
  }

  /**
   * ADR 028: the receipt link a store order did not have yet. It lives in
   * the encrypted ficha, so the row is locked, the ficha read, changed and
   * written back with a new version, an `order.receipt_attached` event and
   * the `store.order.receipt_attached` audit.
   *
   * @param {import('../ports/contracts.js').AttachStoreReceiptInput} input
   */
  async attachStoreReceipt(input) {
    return this.#database.transaction(async (transaction) => {
      const locked = await transaction.query(
        `SELECT ${ORDER_COLUMNS} FROM crm.orders
         WHERE id = $1 AND origin = 'loja'
         FOR UPDATE`,
        [input.orderId],
      );
      if (!locked.rows[0]) throw new OrderNotFoundError();
      const current = this.#map(locked.rows[0]);
      const loja = current.ficha.loja;
      if (!loja) throw new OrderNotFoundError();
      const stored = loja.comprovanteUrl ?? null;
      if (stored === input.receiptUrl)
        return { attached: false, order: current };
      if (stored !== null) {
        throw new StoreOrderError(409, 'STORE_ORDER_CONFLICT');
      }
      const ficha = {
        ...current.ficha,
        loja: { ...loja, comprovanteUrl: input.receiptUrl },
      };
      const updated = await transaction.query(
        `UPDATE crm.orders
         SET ficha_envelope = $2::jsonb, version = version + 1,
             updated_at = $3
         WHERE id = $1
         RETURNING ${ORDER_COLUMNS}`,
        [
          current.id,
          JSON.stringify(
            encryptJson(ficha, fichaAad(current.id), this.#envelopeKey),
          ),
          input.now.toISOString(),
        ],
      );
      const saved = this.#map(updated.rows[0]);
      await appendOrderEvent(
        transaction,
        saved,
        'order.receipt_attached',
        input.audit.correlationId,
      );
      await appendStoreAudit(transaction, saved, {
        action: 'store.order.receipt_attached',
        audit: input.audit,
        reason: 'INFINITEPAY_RECEIPT_ATTACHED',
      });
      return { attached: true, order: saved };
    });
  }

  /** @param {import('../ports/contracts.js').CorrectStoreOrderInput} input */
  async correctStoreOrder(input) {
    return this.#database.transaction(async (transaction) => {
      if (
        input.actor?.kind !== 'human' ||
        !(input.actor.capabilities ?? []).includes('COMMERCIAL_ADMIN')
      )
        throw new OrderForbiddenError();
      const admin = await transaction.query(
        `SELECT 1 FROM crm.users AS users JOIN crm.user_capabilities AS capability ON capability.user_id = users.id
         WHERE users.id = $1 AND users.disabled_at IS NULL AND capability.capability = 'COMMERCIAL_ADMIN'
         FOR SHARE OF users, capability`,
        [input.actor.id],
      );
      if (!admin.rows[0]) throw new OrderForbiddenError();
      const locked = await transaction.query(
        `SELECT ${ORDER_COLUMNS} FROM crm.orders
         JOIN crm.store_order_receipts ON order_id = id
         WHERE id = $1 FOR UPDATE OF orders, store_order_receipts`,
        [input.orderId],
      );
      if (!locked.rows[0]) throw new OrderNotFoundError();
      const current = this.#map(locked.rows[0]);
      const reason = `USER_CONFIRMED_QUANTITY:${input.marker}`;
      const done = await transaction.query(
        "SELECT 1 FROM crm.audit_events WHERE target_id = $1 AND action = 'store.order.quantity_corrected' AND reason = $2",
        [current.id, reason],
      );
      if (done.rows[0]) return current;
      if (current.version !== input.expectedVersion)
        throw new OrderConflictError('The order version changed');
      if (
        current.origin !== 'loja' ||
        current.status !== 'confirmado' ||
        current.totalPieces !== input.expectedQuantity ||
        current.finalAmountCents !== input.expectedAmountCents
      )
        throw new StoreOrderError(409, 'STORE_ORDER_CONFLICT');
      const ficha = structuredClone(current.ficha);
      ficha.items[0].grade[0].quantidade = input.quantity;
      const updated = await transaction.query(
        `UPDATE crm.orders SET ficha_envelope = $2::jsonb, total_pieces = $3,
         final_amount_cents = $4, version = version + 1, updated_at = $5
         WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
        [
          current.id,
          JSON.stringify(
            encryptJson(ficha, fichaAad(current.id), this.#envelopeKey),
          ),
          input.quantity,
          input.amountCents,
          input.now.toISOString(),
        ],
      );
      const saved = this.#map(updated.rows[0]);
      await appendOrderEvent(
        transaction,
        saved,
        'order.store_corrected',
        input.correlationId,
      );
      await appendStoreAudit(transaction, saved, {
        action: 'store.order.quantity_corrected',
        reason,
        audit: { actor: input.actor.id, correlationId: input.correlationId },
      });
      return saved;
    });
  }

  /** @param {string} orderId */
  async findById(orderId) {
    const result = await this.#database.query(
      `SELECT ${ORDER_COLUMNS} FROM crm.orders WHERE id = $1`,
      [orderId],
    );
    return result.rows[0] ? this.#map(result.rows[0]) : null;
  }

  /**
   * @param {import('../ports/contracts.js').OrdersSummaryQuery} query
   * @returns {Promise<import('../ports/contracts.js').OrdersSummary>}
   */
  async summary(query) {
    const result = await this.#database.query(
      `SELECT
         count(*) FILTER (WHERE status = 'confirmado')::integer AS confirmed_count,
         count(*) FILTER (WHERE status = 'confirmado' AND order_date BETWEEN $1::date AND $2::date)::integer AS period_confirmed_count,
         coalesce(sum(final_amount_cents) FILTER (WHERE status = 'confirmado' AND order_date BETWEEN $1::date AND $2::date), 0)::bigint AS period_sold_amount_cents,
         coalesce(sum(final_amount_cents) FILTER (WHERE status = 'confirmado'), 0)::bigint AS sold_amount_cents,
         count(*) FILTER (WHERE status = 'pendente')::integer AS pending_count,
         coalesce(sum(total_pieces) FILTER (WHERE status = 'confirmado'), 0)::bigint AS total_pieces_sold,
         count(*) FILTER (WHERE origin = 'loja' AND ficha_first_printed_at IS NULL)::integer AS store_new_count,
         min(payment_confirmed_at) FILTER (WHERE origin = 'loja' AND ficha_first_printed_at IS NULL) AS store_new_oldest_paid_at,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'day', to_char(sold.order_date, 'YYYY-MM-DD'),
                    'confirmedCount', sold.confirmed_count,
                    'soldAmountCents', sold.sold_amount_cents)
                  ORDER BY sold.order_date), '[]'::jsonb)
          FROM (SELECT order_date, count(*)::integer AS confirmed_count,
                       coalesce(sum(final_amount_cents), 0)::bigint AS sold_amount_cents
                FROM crm.orders
                WHERE NOT is_test AND status = 'confirmado'
                  AND order_date BETWEEN $3::date AND $4::date
                GROUP BY order_date) sold) AS daily
       FROM crm.orders
       WHERE NOT is_test`,
      [query.from, query.to, query.dailyFrom, query.dailyTo],
    );
    const row = result.rows[0];
    const confirmedCount = Number(row.confirmed_count);
    const soldAmountCents = Number(row.sold_amount_cents);
    return {
      confirmedCount,
      soldAmountCents,
      averageTicketCents: confirmedCount
        ? Math.round(soldAmountCents / confirmedCount)
        : 0,
      pendingCount: Number(row.pending_count),
      totalPiecesSold: Number(row.total_pieces_sold),
      // ADR 031: store orders whose ficha nobody printed yet.
      storeNewCount: Number(row.store_new_count ?? 0),
      storeNewOldestPaidAt: isoOrNull(row.store_new_oldest_paid_at ?? null),
      period: {
        confirmedCount: Number(row.period_confirmed_count ?? 0),
        soldAmountCents: Number(row.period_sold_amount_cents ?? 0),
      },
      // PNL-05: only the days that sold, grouped in the same statement.
      daily: (Array.isArray(row.daily) ? row.daily : []).map(
        (/** @type {any} */ day) => ({
          day: String(day.day),
          confirmedCount: Number(day.confirmedCount),
          soldAmountCents: Number(day.soldAmountCents),
        }),
      ),
    };
  }

  /**
   * Painel: confirmed attendance orders still waiting for "Entregue em".
   * The promised day lives in the encrypted ficha, so the rows are read
   * whole; the set stays small because delivering an order leaves it.
   */
  async openDeliveries() {
    const result = await this.#database.query(
      `SELECT ${ORDER_COLUMNS} FROM crm.orders
       WHERE status = 'confirmado' AND origin = 'atendimento'
         AND delivered_on IS NULL AND NOT is_test
       ORDER BY number_sequence`,
    );
    return result.rows.map((row) => this.#map(row));
  }

  /**
   * ADR 031: the first print of a store order's ficha. Only the first one
   * writes: the guarded UPDATE matches a store order nobody printed yet, so
   * two prints at once record one person and one instant. The version moves
   * so the change has its own `order.ficha_first_printed` event (the live
   * `inbox.order.changed`); `updated_at` stays, since the order itself did
   * not change. The audit carries the user id and the order, no PII.
   *
   * @param {import('../ports/contracts.js').RecordFirstPrintInput} input
   */
  async recordFirstPrint(input) {
    return this.#database.transaction(async (transaction) => {
      const at = input.now.toISOString();
      const updated = await transaction.query(
        `UPDATE crm.orders
         SET ficha_first_printed_at = $2, ficha_first_printed_by = $3,
             version = version + 1
         WHERE id = $1 AND origin = 'loja'
           AND ficha_first_printed_at IS NULL
         RETURNING ${ORDER_COLUMNS}`,
        [input.orderId, at, input.actorId],
      );
      if (!updated.rows[0]) {
        const current = await transaction.query(
          `SELECT ${ORDER_COLUMNS} FROM crm.orders WHERE id = $1`,
          [input.orderId],
        );
        if (!current.rows[0]) throw new OrderNotFoundError();
        return { order: this.#map(current.rows[0]), recorded: false };
      }
      const saved = this.#map(updated.rows[0]);
      await transaction.query(
        `INSERT INTO crm.domain_events
           (id, aggregate_type, aggregate_id, aggregate_version, event_type,
            payload, correlation_id, occurred_at)
         VALUES ($1, 'order', $2, $3, 'order.ficha_first_printed', $4::jsonb,
                 $5, $6)`,
        [
          `event-${randomUUID()}`,
          saved.id,
          saved.version,
          JSON.stringify({ conversationId: null, orderId: saved.id }),
          input.correlationId,
          at,
        ],
      );
      await transaction.query(
        `INSERT INTO crm.audit_events
           (id, actor_id, action, target_type, target_id, version, reason,
            correlation_id, occurred_at)
         VALUES ($1, $2, 'order.ficha.first_print', 'order', $3, $4,
                 'STORE_FICHA_FIRST_PRINTED', $5, $6)`,
        [
          randomUUID(),
          input.actorId,
          saved.id,
          String(saved.version),
          input.correlationId,
          at,
        ],
      );
      return { order: saved, recorded: true };
    });
  }

  /** @param {string} conversationId */
  async findPendingByConversation(conversationId) {
    const result = await this.#database.query(
      `SELECT ${ORDER_COLUMNS} FROM crm.orders
       WHERE conversation_id = $1 AND status = 'pendente'`,
      [conversationId],
    );
    return result.rows[0] ? this.#map(result.rows[0]) : null;
  }

  /** @param {string} conversationId */
  async listByConversation(conversationId) {
    const result = await this.#database.query(
      `SELECT ${ORDER_COLUMNS} FROM crm.orders
       WHERE conversation_id = $1
       ORDER BY number_sequence DESC`,
      [conversationId],
    );
    return result.rows.map((row) => this.#map(row));
  }

  /** @param {import('../ports/contracts.js').OrderListQuery} query */
  async list(query) {
    const {
      after,
      conversationIds,
      contactIds,
      limit,
      numberSequence,
      origin,
      owner,
      phoneDigests,
      status,
      storeNumber,
    } = readOrderListQuery(query);
    /** @type {unknown[]} */
    const values = [];
    /** @param {unknown} value */
    const bind = (value) => {
      values.push(value);
      return `$${values.length}`;
    };

    let scope = 'TRUE';
    if (
      numberSequence !== undefined ||
      conversationIds !== undefined ||
      contactIds !== undefined ||
      phoneDigests !== undefined ||
      storeNumber !== undefined
    ) {
      const matches = [];
      if (numberSequence !== undefined) {
        matches.push(`number_sequence = ${bind(numberSequence)}`);
      }
      if (conversationIds !== undefined) {
        matches.push(`conversation_id = ANY(${bind(conversationIds)}::text[])`);
      }
      if (contactIds !== undefined) {
        matches.push(`contact_id = ANY(${bind(contactIds)}::text[])`);
      }
      if (phoneDigests !== undefined) {
        // ADR 027: a store order has no conversation; its phone is found by
        // the HMAC kept on its receipt, never by the number in the clear.
        matches.push(
          `id IN (SELECT order_id FROM crm.store_order_receipts
                  WHERE phone_digest = ANY(${bind(phoneDigests)}::text[]))`,
        );
      }
      if (storeNumber !== undefined) {
        // ADR 028: the shop's number, LJ- and eight hex digits.
        matches.push(`store_number = ${bind(storeNumber)}`);
      }
      scope = `(${matches.join(' OR ')})`;
    }
    if (origin !== undefined) scope = `${scope} AND origin = ${bind(origin)}`;
    if (owner !== undefined) {
      scope = `${scope} AND (manual_owner_id = ${bind(owner.userId)}
        OR conversation_id = ANY(${bind(owner.conversationIds)}::text[]))`;
    }

    const counted = await this.#database.query(
      `SELECT status, count(*)::integer AS total FROM crm.orders
       WHERE ${scope} GROUP BY status`,
      values,
    );
    const counts = { confirmado: 0, pendente: 0 };
    for (const row of counted.rows) {
      counts[/** @type {'confirmado'|'pendente'} */ (row.status)] = row.total;
    }

    const filters = [scope];
    if (status !== undefined) filters.push(`status = ${bind(status)}`);
    if (after !== null) {
      filters.push(
        `(updated_at, id) < (${bind(after.updatedAt)}::timestamptz, ${bind(after.id)})`,
      );
    }
    const page = await this.#database.query(
      `SELECT ${ORDER_COLUMNS} FROM crm.orders
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC, id DESC
       LIMIT ${bind(limit + 1)}`,
      values,
    );
    const items = page.rows.slice(0, limit).map((row) => this.#map(row));
    return {
      counts,
      items,
      nextCursor:
        page.rows.length > limit
          ? encodeOrderCursor(/** @type {Order} */ (items.at(-1)))
          : null,
    };
  }

  /** @param {Order} order @param {OrderWriteOptions} options */
  async saveSection(order, options) {
    return this.#writeFicha(order, options, 'order.section_saved');
  }

  /** @param {Order} order @param {OrderWriteOptions} options */
  async projectBriefing(order, options) {
    return this.#writeFicha(order, options, 'order.briefing_projected');
  }

  /** @param {Order} order @param {OrderWriteOptions} options @param {string} eventType */
  async #writeFicha(order, options, eventType) {
    return this.#write(order, options, eventType, async (current, tx) => {
      if (current.status !== 'pendente') {
        throw new OrderConflictError(
          'Only pending orders accept ficha changes',
          'ORDER_STATUS_CONFLICT',
        );
      }
      return tx.query(
        `UPDATE crm.orders
         SET ficha_envelope = $2::jsonb, total_pieces = $3,
             missing_fields = $4::text[], updated_at = $5,
             final_amount_cents = CASE WHEN $7::boolean THEN $6::bigint ELSE final_amount_cents END,
             version = version + 1
         WHERE id = $1
         RETURNING ${ORDER_COLUMNS}`,
        [
          order.id,
          JSON.stringify(
            encryptJson(order.ficha, fichaAad(order.id), this.#envelopeKey),
          ),
          order.totalPieces,
          order.missingFields,
          order.updatedAt,
          order.ficha.sizePricing === undefined
            ? null
            : sizePricingSummary(order.ficha).totalCents,
          order.ficha.sizePricing !== undefined,
        ],
      );
    });
  }

  /**
   * The ficha travels with the status: generating writes down the client
   * the order showed then (ADR 018); reopening writes it back unchanged.
   *
   * @param {Order} order @param {OrderWriteOptions} options
   */
  async saveStatus(order, options) {
    return this.#write(
      order,
      options,
      statusEventType(order.status),
      async (current, tx) => {
        if (current.status === order.status) {
          throw new OrderConflictError(
            `Order is already ${order.status}`,
            'ORDER_STATUS_CONFLICT',
          );
        }
        return tx.query(
          `UPDATE crm.orders
           SET status = $2, final_amount_cents = $3, payment_condition = $4,
               order_date = $5::date, confirmed_at = $6, confirmed_by = $7,
               reopened_at = $8, reopened_by = $9,
               missing_fields = $10::text[], updated_at = $11,
               ficha_envelope = $12::jsonb, version = version + 1
           WHERE id = $1
           RETURNING ${ORDER_COLUMNS}`,
          [
            order.id,
            order.status,
            order.finalAmountCents,
            order.paymentCondition,
            order.orderDate,
            order.confirmedAt,
            order.confirmedBy,
            order.reopenedAt,
            order.reopenedBy,
            order.missingFields,
            order.updatedAt,
            JSON.stringify(
              encryptJson(order.ficha, fichaAad(order.id), this.#envelopeKey),
            ),
          ],
        );
      },
    );
  }

  /** @param {Order} order @param {OrderWriteOptions} options */
  async saveMilestones(order, options) {
    return this.#write(
      order,
      options,
      'order.milestones_saved',
      async (_current, tx) =>
        tx.query(
          `UPDATE crm.orders
           SET paid_on = $2::date, delivered_on = $3::date, updated_at = $4,
               finance_payment_review_required = CASE WHEN $5::boolean THEN false ELSE finance_payment_review_required END,
               version = version + 1
           WHERE id = $1
           RETURNING ${ORDER_COLUMNS}`,
          [
            order.id,
            order.paidOn,
            order.deliveredOn,
            order.updatedAt,
            options.paymentReviewed === true,
          ],
        ),
    );
  }

  /**
   * Locks the conversation before the order, checks current ownership and
   * version, applies the change and appends its event in one transaction.
   * A transfer or another writer waits and sees the resulting state.
   *
   * @param {Order} order
   * @param {OrderWriteOptions} options
   * @param {string} eventType
   * @param {(current: {status: string}, transaction: Queryable) => Promise<{rows: any[]}>} change
   */
  async #write(order, options, eventType, change) {
    // ADR 027: store orders are locked. Manual attendance orders have their
    // own owner and no conversation to lock.
    const conversationId = order.conversationId;
    if (
      order.origin === 'loja' ||
      (conversationId === null && !order.manualOwnerId)
    ) {
      throw new OrderConflictError('Store orders are locked', 'ORDER_LOCKED');
    }
    return this.#database.transaction(async (transaction) => {
      if (options.agentTarget) {
        const completed = await transaction.query(
          `SELECT order_id, subject_id FROM crm.agent_briefing_projections
           WHERE event_id = $1`,
          [options.agentTarget.eventId],
        );
        if (completed.rows[0]) {
          if (
            completed.rows[0].order_id !== order.id ||
            completed.rows[0].subject_id !== options.agentTarget.subjectId
          ) {
            throw new OrderConflictError(
              'Projection event belongs to another target',
              'IDEMPOTENCY_CONFLICT',
            );
          }
          const current = await transaction.query(
            `SELECT ${ORDER_COLUMNS} FROM crm.orders WHERE id = $1`,
            [order.id],
          );
          if (!current.rows[0]) throw new OrderNotFoundError();
          return this.#map(current.rows[0]);
        }
      }
      if (options.agentTarget) {
        if (
          eventType !== 'order.briefing_projected' ||
          options.actor ||
          options.agentTarget.orderId !== order.id
        ) {
          throw new OrderForbiddenError();
        }
        const target = options.agentTarget;
        const active = (
          await transaction.query(
            `SELECT conversation.*, identity.current_contact_id,
                    identity.channel AS identity_channel
             FROM crm.conversations AS conversation
             JOIN crm.contact_identities AS identity
               ON identity.id = conversation.contact_identity_id
             WHERE conversation.id = $1 FOR UPDATE OF conversation`,
            [target.conversationId],
          )
        ).rows[0];
        if (
          active?.identity_channel === 'site_chat' &&
          order.conversationId !== target.conversationId
        ) {
          throw new OrderConflictError(
            'Site chat can only project its own conversation order',
            'SUBJECT_TARGET_INVALID',
          );
        }
        let acceptedRecovery = false;
        if (target.recovery) {
          const receipt = await transaction.query(
            `SELECT 1 FROM crm.n8n_events
             WHERE idempotency_scope = 'n8n.events'
               AND conversation_id = $1 AND external_event_id = $2
               AND event_type = $3 AND source_revision = $4
               AND automation_epoch = $5
               AND (outcome->>'projectionSubjectVersion')::bigint = $6
               AND (outcome->>'projectionOrderVersion')::bigint = $7
               AND outcome->>'projectionSubjectId' = $8
               AND outcome->>'projectionOrderId' = $9`,
            [
              target.conversationId,
              target.eventId,
              target.eventType,
              target.sourceRevision,
              target.automationEpoch,
              target.expectedSubjectVersion,
              target.expectedOrderVersion,
              target.subjectId,
              target.orderId,
            ],
          );
          acceptedRecovery = Boolean(receipt.rows[0]);
          if (!acceptedRecovery) {
            throw new OrderConflictError(
              'Accepted event snapshot is unavailable for recovery',
              'PROJECTION_SNAPSHOT_MISSING',
            );
          }
        }
        const sameRevision =
          active &&
          !active.terminal_at &&
          (acceptedRecovery
            ? Number(active.inbound_revision) >= target.sourceRevision &&
              Number(active.claimed_revision) >= target.sourceRevision
            : Number(active.inbound_revision) === target.sourceRevision &&
              Number(active.claimed_revision) === target.sourceRevision) &&
          active.current_contact_id === order.contactId;
        const activeSend =
          sameRevision &&
          target.eventType === 'message.send.requested' &&
          active.automation_state === 'assistant' &&
          Number(active.automation_epoch) === target.automationEpoch;
        let acceptedHandoff = false;
        if (
          sameRevision &&
          target.eventType === 'handoff.requested' &&
          active.automation_state === 'human' &&
          Number(active.automation_epoch) === target.automationEpoch + 1
        ) {
          const receipt = await transaction.query(
            `SELECT 1 FROM crm.n8n_events WHERE conversation_id = $1
               AND external_event_id = $2 AND event_type = 'handoff.requested'`,
            [target.conversationId, target.eventId],
          );
          acceptedHandoff = Boolean(receipt.rows[0]);
        }
        if (!activeSend && !acceptedHandoff) {
          throw new OrderConflictError(
            'Automated projection is stale',
            'STALE_AUTOMATION_FENCE',
          );
        }
        const subject = (
          await transaction.query(
            `SELECT subject.id, briefing.version AS briefing_version
             FROM crm.conversation_subjects AS subject
             JOIN crm.orders AS orders ON orders.id = subject.order_id
             JOIN crm.subject_briefings AS briefing
               ON briefing.subject_id = subject.id
             WHERE subject.id = $1 AND subject.conversation_id = $2
               AND subject.order_id = $3 AND subject.contact_id = $4
               AND orders.contact_id = $4 AND orders.status = 'pendente'
             FOR SHARE OF subject, orders, briefing`,
            [
              target.subjectId,
              target.conversationId,
              order.id,
              order.contactId,
            ],
          )
        ).rows[0];
        if (!subject)
          throw new OrderConflictError(
            'Subject target changed',
            'SUBJECT_TARGET_INVALID',
          );
        if (
          Number(subject.briefing_version) !== target.expectedSubjectVersion
        ) {
          throw new OrderConflictError(
            'Subject briefing changed after the accepted event',
            'SUBJECT_SUPERSEDED',
          );
        }
        const selected = (
          await transaction.query(
            `SELECT id FROM crm.conversation_subjects
             WHERE conversation_id = $1 AND is_current AND selected_source = 'human'`,
            [target.conversationId],
          )
        ).rows[0];
        if (selected && selected.id !== target.subjectId) {
          throw new OrderConflictError(
            'Human-selected subject changed',
            'SUBJECT_TARGET_CONFLICT',
          );
        }
        const links = await transaction.query(
          `SELECT DISTINCT link.subject_id
           FROM crm.message_subject_links AS link
           JOIN crm.messages AS message ON message.id = link.message_id
           WHERE message.conversation_id = $1 AND message.direction = 'inbound'
             AND message.inbound_revision = $2`,
          [target.conversationId, target.sourceRevision],
        );
        if (
          links.rows.length > 1 ||
          (links.rows.length === 1 &&
            links.rows[0].subject_id !== target.subjectId)
        ) {
          throw new OrderConflictError(
            'Inbound message is ambiguous',
            'SUBJECT_AMBIGUOUS',
          );
        }
      } else if (conversationId) {
        const conversation = await lockConversation(
          transaction,
          conversationId,
        );
        if (!conversation) throw new OrderNotFoundError();
        await assertWriteOwner(
          transaction,
          options.actor,
          conversation,
          eventType === 'order.briefing_projected',
        );
      } else {
        await assertWriteOwner(
          transaction,
          options.actor,
          { assigned_user_id: order.manualOwnerId ?? null },
          false,
        );
      }
      const locked = await transaction.query(
        `SELECT ${ORDER_COLUMNS} FROM crm.orders
         WHERE id = $1 FOR UPDATE`,
        [order.id],
      );
      const current = locked.rows[0];
      if (
        !current ||
        current.conversation_id !== order.conversationId ||
        current.manual_owner_id !== (order.manualOwnerId ?? null)
      ) {
        throw new OrderNotFoundError();
      }
      if (options.agentTarget) {
        const projected = await transaction.query(
          `SELECT order_id, subject_id FROM crm.agent_briefing_projections
           WHERE event_id = $1`,
          [options.agentTarget.eventId],
        );
        if (projected.rows[0]) {
          if (
            projected.rows[0].order_id !== order.id ||
            projected.rows[0].subject_id !== options.agentTarget.subjectId
          ) {
            throw new OrderConflictError(
              'Projection event belongs to another target',
              'IDEMPOTENCY_CONFLICT',
            );
          }
          return this.#map(current);
        }
      }
      if (Number(current.version) !== options.expectedVersion) {
        throw new OrderConflictError(
          `Expected order version ${options.expectedVersion}, current version is ${current.version}`,
        );
      }
      if (
        options.agentTarget &&
        Number(current.version) !== options.agentTarget.expectedOrderVersion
      ) {
        throw new OrderConflictError(
          'Order changed after the accepted event',
          'ORDER_CHANGED_SINCE_EVENT',
        );
      }
      const updated = await change(current, transaction);
      const saved = this.#map(updated.rows[0]);
      if (options.agentTarget) {
        await transaction.query(
          `INSERT INTO crm.agent_briefing_projections
             (event_id, order_id, subject_id, projected_at)
           VALUES ($1, $2, $3, $4)`,
          [
            options.agentTarget.eventId,
            order.id,
            options.agentTarget.subjectId,
            saved.updatedAt,
          ],
        );
      }
      await appendOrderEvent(
        transaction,
        saved,
        eventType,
        options.correlationId,
      );
      return saved;
    });
  }
}
