import { createHash } from 'node:crypto';

/**
 * @typedef {{ type: string, id: string }} CommandTarget
 * @typedef {{
 *   key: string,
 *   actor: string,
 *   action: string,
 *   target: CommandTarget,
 *   version: string | number,
 *   reason: string,
 *   correlationId: string,
 *   command: unknown,
 * }} IdempotentCommandRequest
 * @typedef {{
 *   scope: string,
 *   key: string,
 *   fingerprint: string,
 *   actor: string,
 *   action: string,
 *   target: CommandTarget,
 *   version: string | number,
 *   reason: string,
 *   correlationId: string,
 *   status: 'pending' | 'completed',
 *   response?: unknown,
 *   completion: Promise<unknown>,
 *   resolve: (value: unknown) => void,
 *   reject: (reason?: unknown) => void,
 * }} InternalIdempotencyRecord
 */

export class IdempotencyConflictError extends Error {
  /** @param {string} scope @param {string} key */
  constructor(scope, key) {
    super(`Idempotency key ${key} was reused with a different command`);
    this.name = 'IdempotencyConflictError';
    this.code = 'IDEMPOTENCY_KEY_REUSED';
    this.statusCode = 409;
    this.scope = scope;
    this.key = key;
  }
}

/**
 * @param {unknown} command
 * @returns {string}
 */
export function fingerprintCommand(command) {
  return createHash('sha256').update(canonicalJson(command)).digest('hex');
}

/** @param {unknown} value @param {Set<object>} [ancestors] @returns {string} */
function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Command numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError('Command must contain only JSON values');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Command must not contain circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Command objects must be plain JSON objects');
    }
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            /** @type {Record<string, unknown>} */ (value)[key],
            ancestors,
          )}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return structuredClone(value);
}

function createDeferred() {
  /** @type {(value: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const completion = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  completion.catch(() => undefined);
  return { completion, resolve, reject };
}

export class InMemoryIdempotencyRecordStore {
  /** @type {Map<string, InternalIdempotencyRecord>} */
  #records = new Map();

  /**
   * @template T
   * @param {{
   *   scope: string,
   *   key: string,
   *   fingerprint: string,
   *   actor: string,
   *   action: string,
   *   target: CommandTarget,
   *   version: string | number,
   *   reason: string,
   *   correlationId: string,
   * }} identity
   * @param {() => Promise<T>} operation
   * @param {(transaction?: unknown) => Promise<unknown>} [beforeExecute]
   * @returns {Promise<T>}
   */
  async execute(identity, operation, beforeExecute) {
    requireNonEmpty(identity.scope, 'scope');
    requireNonEmpty(identity.key, 'key');
    requireNonEmpty(identity.fingerprint, 'fingerprint');
    await beforeExecute?.();
    const storageKey = this.#storageKey(identity.scope, identity.key);
    const existing = this.#records.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== identity.fingerprint) {
        throw new IdempotencyConflictError(identity.scope, identity.key);
      }
      return /** @type {T} */ (clone(await existing.completion));
    }

    const deferred = createDeferred();
    const record = /** @type {InternalIdempotencyRecord} */ ({
      scope: identity.scope,
      key: identity.key,
      fingerprint: identity.fingerprint,
      actor: identity.actor,
      action: identity.action,
      target: clone(identity.target),
      version: identity.version,
      reason: identity.reason,
      correlationId: identity.correlationId,
      status: 'pending',
      ...deferred,
    });
    this.#records.set(storageKey, record);

    try {
      const response = clone(await operation());
      record.status = 'completed';
      record.response = response;
      record.resolve(response);
      return clone(response);
    } catch (error) {
      if (this.#records.get(storageKey) === record) {
        this.#records.delete(storageKey);
      }
      record.reject(error);
      throw error;
    }
  }

  /**
   * @param {{ scope: string, key: string }} identity
   * @returns {Promise<Readonly<{
   *   fingerprint: string,
   *   actor: string,
   *   action: string,
   *   target: CommandTarget,
   *   version: string | number,
   *   reason: string,
   *   correlationId: string,
   *   status: string,
   *   response?: unknown,
   * }> | null>}
   */
  async get(identity) {
    const record = this.#records.get(
      this.#storageKey(identity.scope, identity.key),
    );
    if (!record) return null;
    return clone({
      fingerprint: record.fingerprint,
      actor: record.actor,
      action: record.action,
      target: record.target,
      version: record.version,
      reason: record.reason,
      correlationId: record.correlationId,
      status: record.status,
      ...(record.status === 'completed' ? { response: record.response } : {}),
    });
  }

  /** @param {string} scope @param {string} key */
  #storageKey(scope, key) {
    return `${scope}\u0000${key}`;
  }
}

/**
 * @param {{
 *   auditTrail: { append: (event: {
 *     actor: string,
 *     action: string,
 *     target: CommandTarget,
 *     version: string | number,
 *     reason: string,
 *     correlationId: string,
 *   }, context?: {transaction: unknown}) => Promise<unknown> },
 *   idempotencyStore: { execute: (
 *     identity: {
 *       scope: string,
 *       key: string,
 *       fingerprint: string,
 *       actor: string,
 *       action: string,
 *       target: CommandTarget,
 *       version: string | number,
 *       reason: string,
 *       correlationId: string,
 *     },
 *     operation: (transaction?: unknown) => Promise<unknown>,
 *     beforeExecute?: (transaction?: unknown) => Promise<unknown>,
 *   ) => Promise<unknown> },
 * }} dependencies
 */
export function createIdempotentCommandExecutor(dependencies) {
  const { auditTrail, idempotencyStore } = dependencies;

  /**
   * @template T
   * @param {IdempotentCommandRequest} request
   * @param {(transaction?: unknown) => Promise<T>} effect
   * @param {(transaction?: unknown) => Promise<unknown>} [beforeExecute]
   * @returns {Promise<T>}
   */
  return async function execute(request, effect, beforeExecute) {
    validateCommandRequest(request);
    const scope = `${request.actor}:${request.action}`;
    const fingerprint = fingerprintCommand({
      action: request.action,
      target: request.target,
      version: request.version,
      reason: request.reason,
      command: request.command,
    });

    return /** @type {Promise<T>} */ (
      idempotencyStore.execute(
        {
          scope,
          key: request.key,
          fingerprint,
          actor: request.actor,
          action: request.action,
          target: request.target,
          version: request.version,
          reason: request.reason,
          correlationId: request.correlationId,
        },
        async (transaction) => {
          const response = await effect(transaction);
          await auditTrail.append(
            {
              actor: request.actor,
              action: request.action,
              target: request.target,
              version: request.version,
              reason: request.reason,
              correlationId: request.correlationId,
            },
            transaction === undefined ? undefined : { transaction },
          );
          return response;
        },
        beforeExecute,
      )
    );
  };
}

/** @param {IdempotentCommandRequest} request */
function validateCommandRequest(request) {
  requireNonEmpty(request.key, 'key');
  requireNonEmpty(request.actor, 'actor');
  requireNonEmpty(request.action, 'action');
  requireNonEmpty(request.reason, 'reason');
  requireNonEmpty(request.correlationId, 'correlationId');
  if (request.target === null || typeof request.target !== 'object') {
    throw new TypeError('target must identify a type and id');
  }
  requireNonEmpty(request.target.type, 'target.type');
  requireNonEmpty(request.target.id, 'target.id');
  if (
    (typeof request.version !== 'string' &&
      typeof request.version !== 'number') ||
    request.version === '' ||
    (typeof request.version === 'number' && !Number.isFinite(request.version))
  ) {
    throw new TypeError('version must be a string or number');
  }
}

/** @param {unknown} value @param {string} field */
function requireNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}
