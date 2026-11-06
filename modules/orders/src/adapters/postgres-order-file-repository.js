import { assertOlistCommercialWrite } from './olist-commercial-lock.js';
import { OrderConflictError, OrderNotFoundError } from '../domain/errors.js';
import { MAX_ORDER_REFERENCE_FILES } from '../domain/order-files.js';
import { decryptJson, encryptJson } from './envelope.js';
import {
  assertWriteOwner,
  lockConversation,
} from './postgres-order-repository.js';

/**
 * @typedef {import('../application/order-file-service.js').OrderFileRecord} OrderFileRecord
 * @typedef {import('./postgres-order-repository.js').TransactionalDatabase} TransactionalDatabase
 * @typedef {import('./postgres-order-repository.js').Queryable} Queryable
 * @typedef {{id: string, kind: string, capabilities?: readonly string[]}} OrderActor
 */

const FILE_COLUMNS = `id, order_id, slot, object_key, thumbnail_key,
  name_envelope, extension, content_type, size_bytes, content_sha256,
  uploaded_by, uploaded_at`;

/** @param {string} fileId */
function nameAad(fileId) {
  return `order-file-name:${fileId}`;
}

/**
 * The catalog of an order's art files (ADR 023). Writes take the same locks
 * as an order write — conversation, then order — so the owner check, the
 * pending status and the five-file limit hold against concurrent commands.
 */
export class PostgresOrderFileRepository {
  /** @type {TransactionalDatabase} */
  #database;
  /** @type {Buffer} */
  #envelopeKey;

  /** @param {{database: TransactionalDatabase, envelopeKey: Buffer}} options */
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

  /** @param {any} row @returns {OrderFileRecord} */
  #map(row) {
    return {
      contentSha256: row.content_sha256,
      contentType: row.content_type,
      extension: row.extension,
      id: row.id,
      name: decryptJson(row.name_envelope, nameAad(row.id), this.#envelopeKey),
      objectKey: row.object_key,
      orderId: row.order_id,
      sizeBytes: Number(row.size_bytes),
      slot: row.slot,
      thumbnailKey: row.thumbnail_key,
      uploadedAt: (row.uploaded_at instanceof Date
        ? row.uploaded_at
        : new Date(row.uploaded_at)
      ).toISOString(),
      uploadedBy: row.uploaded_by,
    };
  }

  /** @param {string} orderId */
  async listByOrder(orderId) {
    const result = await this.#database.query(
      `SELECT ${FILE_COLUMNS} FROM crm.order_files
       WHERE order_id = $1 ORDER BY uploaded_at, id`,
      [orderId],
    );
    return result.rows.map((row) => this.#map(row));
  }

  /** @param {string} orderId @param {string} fileId */
  async findById(orderId, fileId) {
    const result = await this.#database.query(
      `SELECT ${FILE_COLUMNS} FROM crm.order_files
       WHERE order_id = $1 AND id = $2`,
      [orderId, fileId],
    );
    return result.rows[0] ? this.#map(result.rows[0]) : null;
  }

  /**
   * A final art replaces the previous one in the same transaction; the
   * caller deletes the replaced objects after commit.
   *
   * @param {OrderFileRecord} record @param {{actor: OrderActor}} options
   * @returns {Promise<{replaced: OrderFileRecord|null}>}
   */
  async add(record, options) {
    return this.#database.transaction(async (transaction) => {
      await this.#lockPending(transaction, record.orderId, options.actor);
      /** @type {OrderFileRecord|null} */
      let replaced = null;
      if (record.slot === 'final') {
        const removed = await transaction.query(
          `DELETE FROM crm.order_files
           WHERE order_id = $1 AND slot = 'final'
           RETURNING ${FILE_COLUMNS}`,
          [record.orderId],
        );
        replaced = removed.rows[0] ? this.#map(removed.rows[0]) : null;
      } else {
        const counted = await transaction.query(
          `SELECT count(*)::integer AS total FROM crm.order_files
           WHERE order_id = $1 AND slot = 'reference'`,
          [record.orderId],
        );
        if (Number(counted.rows[0]?.total) >= MAX_ORDER_REFERENCE_FILES) {
          throw new OrderConflictError(
            'The order already has five art files',
            'FILE_LIMIT_REACHED',
          );
        }
      }
      await transaction.query(
        `INSERT INTO crm.order_files
           (id, order_id, slot, object_key, thumbnail_key, name_envelope,
            extension, content_type, size_bytes, content_sha256,
            uploaded_by, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
        [
          record.id,
          record.orderId,
          record.slot,
          record.objectKey,
          record.thumbnailKey,
          JSON.stringify(
            encryptJson(record.name, nameAad(record.id), this.#envelopeKey),
          ),
          record.extension,
          record.contentType,
          record.sizeBytes,
          record.contentSha256,
          record.uploadedBy,
          record.uploadedAt,
        ],
      );
      return { replaced };
    });
  }

  /**
   * @param {string} orderId @param {string} fileId @param {{actor: OrderActor}} options
   * @returns {Promise<OrderFileRecord>}
   */
  async remove(orderId, fileId, options) {
    return this.#database.transaction(async (transaction) => {
      await this.#lockPending(transaction, orderId, options.actor);
      const removed = await transaction.query(
        `DELETE FROM crm.order_files WHERE order_id = $1 AND id = $2
         RETURNING ${FILE_COLUMNS}`,
        [orderId, fileId],
      );
      if (!removed.rows[0]) {
        throw new OrderNotFoundError('File was not found', 'FILE_NOT_FOUND');
      }
      return this.#map(removed.rows[0]);
    });
  }

  /**
   * @param {Queryable} transaction @param {string} orderId @param {OrderActor} actor
   */
  async #lockPending(transaction, orderId, actor) {
    const order = await transaction.query(
      `SELECT conversation_id, manual_owner_id, origin
       FROM crm.orders WHERE id = $1`,
      [orderId],
    );
    const row = order.rows[0];
    if (!row || row.origin === 'loja') throw new OrderNotFoundError();
    const conversationId = row.conversation_id;
    if (conversationId) {
      const conversation = await lockConversation(transaction, conversationId);
      if (!conversation) throw new OrderNotFoundError();
      await assertWriteOwner(transaction, actor, conversation, false);
    } else if (row.manual_owner_id) {
      await assertWriteOwner(
        transaction,
        actor,
        { assigned_user_id: row.manual_owner_id },
        false,
      );
    } else {
      throw new OrderNotFoundError();
    }
    const locked = await transaction.query(
      `SELECT conversation_id, manual_owner_id, status, cancelled_at FROM crm.orders
       WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const current = locked.rows[0];
    if (
      !current ||
      current.conversation_id !== conversationId ||
      current.manual_owner_id !== row.manual_owner_id
    ) {
      throw new OrderNotFoundError();
    }
    if (current.cancelled_at) {
      throw new OrderConflictError(
        'Cancelled orders are terminal',
        'ORDER_CANCELLED',
      );
    }
    await assertOlistCommercialWrite(
      transaction,
      { id: orderId, status: current.status },
      null,
      'order.files_changed',
    );
    if (current.status !== 'pendente') {
      throw new OrderConflictError(
        'Only pending orders accept file changes',
        'ORDER_STATUS_CONFLICT',
      );
    }
  }
}
