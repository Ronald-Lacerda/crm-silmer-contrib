import { Readable } from 'node:stream';

import { OrderConflictError, OrderNotFoundError } from '../domain/errors.js';
import { MAX_ORDER_REFERENCE_FILES } from '../domain/order-files.js';
import { requireActiveOrder } from '../domain/order.js';

/**
 * @typedef {import('../application/order-file-service.js').OrderFileRecord} OrderFileRecord
 */

/** Reference object storage for unit tests: a Map of buffers. */
export class InMemoryObjectStorage {
  /** @type {Map<string, {body: Buffer, contentType: string}>} */
  objects = new Map();

  async ensureBucket() {}

  /** @param {string} key @param {Buffer} body @param {string} contentType */
  async putObject(key, body, contentType) {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  /** @param {string} key */
  async getObject(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      contentLength: object.body.length,
      stream: Readable.from([object.body]),
    };
  }

  /** @param {string} key */
  async deleteObject(key) {
    this.objects.delete(key);
  }
}

/**
 * Reference implementation of the order file catalog. Commands run one at a
 * time, like the order lock the PostgreSQL adapter takes, and re-read the
 * order so a status change between the check and the write is refused.
 */
export class InMemoryOrderFileRepository {
  /** @type {Map<string, OrderFileRecord>} */
  #files = new Map();
  #orders;
  #tail = Promise.resolve();

  /** @param {{findById(orderId: string): Promise<{status: string, cancelledAt?: string|null}|null>}} orders */
  constructor(orders) {
    this.#orders = orders;
  }

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  async #exclusive(work) {
    const previous = this.#tail;
    /** @type {(() => void)|undefined} */
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  /** @param {string} orderId */
  async #requirePending(orderId) {
    const order = await this.#orders.findById(orderId);
    if (!order) throw new OrderNotFoundError();
    requireActiveOrder(order);
    if (order.status !== 'pendente') {
      throw new OrderConflictError(
        'Only pending orders accept file changes',
        'ORDER_STATUS_CONFLICT',
      );
    }
  }

  /** @param {string} orderId */
  async listByOrder(orderId) {
    return [...this.#files.values()]
      .filter((file) => file.orderId === orderId)
      .sort(
        (left, right) =>
          left.uploadedAt.localeCompare(right.uploadedAt) ||
          left.id.localeCompare(right.id),
      )
      .map((file) => ({ ...file }));
  }

  /** @param {string} orderId @param {string} fileId */
  async findById(orderId, fileId) {
    const file = this.#files.get(fileId);
    return file && file.orderId === orderId ? { ...file } : null;
  }

  /** @param {OrderFileRecord} record */
  async add(record) {
    return this.#exclusive(async () => {
      await this.#requirePending(record.orderId);
      const current = await this.listByOrder(record.orderId);
      /** @type {OrderFileRecord|null} */
      let replaced = null;
      if (record.slot === 'final') {
        replaced = current.find((file) => file.slot === 'final') ?? null;
        if (replaced) this.#files.delete(replaced.id);
      } else if (
        current.filter((file) => file.slot === 'reference').length >=
        MAX_ORDER_REFERENCE_FILES
      ) {
        throw new OrderConflictError(
          'The order already has five art files',
          'FILE_LIMIT_REACHED',
        );
      }
      this.#files.set(record.id, { ...record });
      return { replaced };
    });
  }

  /** @param {string} orderId @param {string} fileId */
  async remove(orderId, fileId) {
    return this.#exclusive(async () => {
      await this.#requirePending(orderId);
      const file = await this.findById(orderId, fileId);
      if (!file) {
        throw new OrderNotFoundError('File was not found', 'FILE_NOT_FOUND');
      }
      this.#files.delete(fileId);
      return file;
    });
  }
}
