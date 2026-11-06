import { createHash, randomUUID } from 'node:crypto';

import {
  OrderConflictError,
  OrderForbiddenError,
  OrderNotFoundError,
} from '../domain/errors.js';
import {
  MAX_ORDER_FILE_BYTES,
  MAX_ORDER_REFERENCE_FILES,
  describeOrderFile,
  requireOrderFileSlot,
} from '../domain/order-files.js';
import { requireUnlocked } from '../domain/store-order.js';

/**
 * @typedef {{
 *   id: string,
 *   orderId: string,
 *   slot: 'reference'|'final',
 *   name: string,
 *   extension: string,
 *   contentType: string,
 *   sizeBytes: number,
 *   contentSha256: string,
 *   objectKey: string,
 *   thumbnailKey: string|null,
 *   uploadedBy: string,
 *   uploadedAt: string,
 * }} OrderFileRecord
 * @typedef {{id: string, kind: string, capabilities?: readonly string[]}} OrderActor
 * @typedef {{
 *   listByOrder(orderId: string): Promise<OrderFileRecord[]>,
 *   findById(orderId: string, fileId: string): Promise<OrderFileRecord|null>,
 *   add(record: OrderFileRecord, options: {actor: OrderActor}): Promise<{replaced: OrderFileRecord|null}>,
 *   remove(orderId: string, fileId: string, options: {actor: OrderActor}): Promise<OrderFileRecord>,
 * }} OrderFileRepository
 * @typedef {{
 *   putObject(key: string, body: Buffer, contentType: string): Promise<void>,
 *   getObject(key: string): Promise<{stream: import('node:stream').Readable, contentLength: number|null}|null>,
 *   deleteObject(key: string): Promise<void>,
 * }} ObjectStorage
 */

export const ORDER_FILE_LIMITS = Object.freeze({
  maxBytes: MAX_ORDER_FILE_BYTES,
  maxReferences: MAX_ORDER_REFERENCE_FILES,
});

/** @param {Buffer} content */
function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * ADR 023: upload, list, download and remove an order's art files. The bytes
 * go to object storage first and the catalog row second, so a row never
 * points at a missing object; when the row is refused, the stored bytes are
 * deleted again. Download reads only need order access, so a confirmed order
 * still serves its files to production.
 *
 * @param {{
 *   files: OrderFileRepository,
 *   storage: ObjectStorage,
 *   orders: {findById(orderId: string): Promise<{id: string, status: string, conversationId: string|null, manualOwnerId?: string|null, origin?: string, cancelledAt?: string|null}|null>},
 *   authorizeOwnership: (input: {actor: OrderActor, conversationId: string|null, order: {conversationId: string|null, manualOwnerId?: string|null}}) => Promise<void>,
 *   clock?: () => Date,
 *   idFactory?: () => string,
 * }} dependencies
 */
export function createOrderFileService(dependencies) {
  const { authorizeOwnership, files, orders, storage } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? (() => `file-${randomUUID()}`);

  /** @param {string} orderId */
  async function requireOrder(orderId) {
    const order = await orders.findById(orderId);
    if (!order) throw new OrderNotFoundError();
    return order;
  }

  /** @param {OrderActor} actor @param {string} orderId */
  async function requireEditable(actor, orderId) {
    if (actor?.kind !== 'human' || !actor.id) throw new OrderForbiddenError();
    const order = await requireOrder(orderId);
    // ADR 027: a store order takes no art file, whoever asks.
    requireUnlocked(order);
    await authorizeOwnership({
      actor,
      conversationId: order.conversationId,
      order,
    });
    if (order.status !== 'pendente') {
      throw new OrderConflictError(
        'Reopen the order before changing its files',
        'ORDER_STATUS_CONFLICT',
      );
    }
    return order;
  }

  /** Best effort: an orphan object costs space, never a wrong file. @param {Array<string|null>} keys */
  async function discard(keys) {
    await Promise.allSettled(
      keys.filter(Boolean).map((key) => storage.deleteObject(String(key))),
    );
  }

  /** @param {string} orderId */
  async function list(orderId) {
    const records = await files.listByOrder(orderId);
    return {
      final: records.find((file) => file.slot === 'final') ?? null,
      references: records.filter((file) => file.slot === 'reference'),
    };
  }

  /** @param {string} orderId @param {string} fileId */
  async function requireFile(orderId, fileId) {
    const file = await files.findById(orderId, fileId);
    if (!file) {
      throw new OrderNotFoundError('File was not found', 'FILE_NOT_FOUND');
    }
    return file;
  }

  return Object.freeze({
    /** @param {string} orderId */
    async list(orderId) {
      await requireOrder(orderId);
      return list(orderId);
    },

    /**
     * @param {{actor: OrderActor, orderId: string, slot: unknown, name: unknown, content: Buffer, thumbnail?: Buffer|null}} input
     */
    async upload(input) {
      const slot = requireOrderFileSlot(input.slot);
      const described = describeOrderFile({
        content: input.content,
        name: input.name,
        thumbnail: input.thumbnail ?? null,
      });
      await requireEditable(input.actor, input.orderId);
      // Checked again under the order lock; this spares storing bytes that
      // the catalog would refuse anyway.
      if (slot === 'reference') {
        const current = await list(input.orderId);
        if (current.references.length >= MAX_ORDER_REFERENCE_FILES) {
          throw new OrderConflictError(
            'The order already has five art files',
            'FILE_LIMIT_REACHED',
          );
        }
      }
      const id = idFactory();
      const objectKey = `orders/${input.orderId}/${id}`;
      const thumbnailKey = input.thumbnail
        ? `${objectKey}.thumbnail.webp`
        : null;
      /** @type {OrderFileRecord} */
      const record = {
        ...described,
        contentSha256: sha256Hex(input.content),
        id,
        objectKey,
        orderId: input.orderId,
        slot,
        thumbnailKey,
        uploadedAt: clock().toISOString(),
        uploadedBy: input.actor.id,
      };
      try {
        await storage.putObject(
          objectKey,
          input.content,
          described.contentType,
        );
        if (thumbnailKey && input.thumbnail) {
          await storage.putObject(thumbnailKey, input.thumbnail, 'image/webp');
        }
      } catch (error) {
        await discard([objectKey, thumbnailKey]);
        throw error;
      }
      /** @type {{replaced: OrderFileRecord|null}} */
      let added;
      try {
        added = await files.add(record, { actor: input.actor });
      } catch (error) {
        await discard([objectKey, thumbnailKey]);
        throw error;
      }
      if (added.replaced) {
        await discard([added.replaced.objectKey, added.replaced.thumbnailKey]);
      }
      return { file: record, files: await list(input.orderId) };
    },

    /** @param {{actor: OrderActor, orderId: string, fileId: string}} input */
    async remove(input) {
      await requireEditable(input.actor, input.orderId);
      const removed = await files.remove(input.orderId, input.fileId, {
        actor: input.actor,
      });
      await discard([removed.objectKey, removed.thumbnailKey]);
      return { files: await list(input.orderId) };
    },

    /** @param {string} orderId @param {string} fileId */
    async openContent(orderId, fileId) {
      const file = await requireFile(orderId, fileId);
      const object = await storage.getObject(file.objectKey);
      if (!object) {
        throw new OrderNotFoundError('File was not found', 'FILE_NOT_FOUND');
      }
      return { file, ...object };
    },

    /** @param {string} orderId @param {string} fileId */
    async openThumbnail(orderId, fileId) {
      const file = await requireFile(orderId, fileId);
      const object = file.thumbnailKey
        ? await storage.getObject(file.thumbnailKey)
        : null;
      if (!object) {
        throw new OrderNotFoundError('File was not found', 'FILE_NOT_FOUND');
      }
      return { file, ...object };
    },
  });
}
