import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_SCANNER_SIGNATURE_AGE_MS = 36 * 60 * 60 * 1000;
const DEFAULT_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'audio/mpeg',
  'audio/ogg',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
]);

export class MediaQuotaExceededError extends Error {
  constructor() {
    super('Private media volume quota exceeded');
    this.name = 'MediaQuotaExceededError';
    this.code = 'MEDIA_QUOTA_EXCEEDED';
  }
}

export class MediaVolumeUnavailableError extends Error {
  /** @param {{cause?: unknown}} [options] */
  constructor(options = {}) {
    super('Private media volume is unavailable', options);
    this.name = 'MediaVolumeUnavailableError';
    this.code = 'MEDIA_VOLUME_UNAVAILABLE';
  }
}

export class MediaHashMismatchError extends Error {
  constructor() {
    super('Uploaded media hash does not match the declared digest');
    this.name = 'MediaHashMismatchError';
    this.code = 'MEDIA_HASH_MISMATCH';
  }
}

/**
 * Private, non-public transient byte store. Writes are serialized for the
 * single-worker pilot, staged under an unpredictable partial name, fsynced,
 * scanned and atomically renamed before becoming available.
 */
export class PrivateMediaVolume {
  #allowedMimeTypes;
  #maxBytes;
  #maxFileBytes;
  #now;
  #repository;
  #rootDirectory;
  #scanner;
  #tail = Promise.resolve();

  /**
   * @param {{rootDirectory: string, maxBytes: number, maxFileBytes: number, scanner: {scan: (path: string) => Promise<{clean: boolean, detectedMimeType: string, signatureUpdatedAt: string|Date}>}, repository: {markAvailable: Function, markDeleted: Function, markQuarantined: Function, markRejected: Function, markUnavailable: Function}, allowedMimeTypes?: Iterable<string>, now?: () => Date}} options
   */
  constructor({
    rootDirectory,
    maxBytes,
    maxFileBytes,
    scanner,
    repository,
    allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES,
    now = () => new Date(),
  }) {
    if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
      throw new TypeError('rootDirectory is required');
    }
    positiveInteger(maxBytes, 'maxBytes');
    positiveInteger(maxFileBytes, 'maxFileBytes');
    if (maxFileBytes > maxBytes) {
      throw new TypeError('maxFileBytes must not exceed maxBytes');
    }
    if (!scanner || typeof scanner.scan !== 'function') {
      throw new TypeError('A media scanner is required');
    }
    for (const method of /** @type {const} */ ([
      'markAvailable',
      'markDeleted',
      'markQuarantined',
      'markRejected',
      'markUnavailable',
    ])) {
      if (!repository || typeof repository[method] !== 'function') {
        throw new TypeError(`repository.${method} is required`);
      }
    }
    if (typeof now !== 'function')
      throw new TypeError('now must be a function');
    this.#rootDirectory = resolve(rootDirectory);
    this.#maxBytes = maxBytes;
    this.#maxFileBytes = maxFileBytes;
    this.#scanner = scanner;
    this.#repository = repository;
    this.#allowedMimeTypes = new Set(allowedMimeTypes);
    this.#now = now;
  }

  /**
   * @param {{mediaId: string, bytes: Buffer|Uint8Array|AsyncIterable<Uint8Array>, declaredMimeType?: string|null, expectedSha256?: string|null}} input
   */
  async store(input) {
    return this.#serialize(() => this.#storeSerial(input));
  }

  /**
   * Rechecks an existing quarantined copy without allocating storage or quota.
   * The caller must first verify canonical binding, retryable state and TTL.
   * @param {{mediaId: string, storageKey: string, expectedSha256: string, expectedSizeBytes: number, declaredMimeType: string}} input
   */
  async revalidate(input) {
    return this.#serialize(() => this.#revalidateSerial(input));
  }

  /** @template T @param {() => Promise<T>} work */
  async #serialize(work) {
    const previous = this.#tail;
    /** @type {() => void} */
    let release = () => {};
    this.#tail = new Promise((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** @param {{mediaId: string, storageKey: string, expectedSha256: string, expectedSizeBytes: number, declaredMimeType: string}} input */
  async #revalidateSerial(input) {
    const mediaId = boundedString(input.mediaId, 'mediaId', 128);
    const declared = boundedString(
      input.declaredMimeType,
      'declaredMimeType',
      255,
    );
    const expected = sha256Digest(input.expectedSha256, 'expectedSha256');
    positiveInteger(input.expectedSizeBytes, 'expectedSizeBytes');
    const limit = Math.min(
      this.#maxFileBytes,
      (declared.startsWith('image/') ? 5 : 16) * 1024 * 1024,
    );
    if (input.expectedSizeBytes > limit) throw new MediaQuotaExceededError();
    const now = validDate(this.#now(), 'now');
    const path = this.#storagePath(input.storageKey);
    const common = {
      mediaId,
      storageKey: input.storageKey,
      sizeBytes: input.expectedSizeBytes,
      contentSha256: expected,
      declaredMimeType: declared,
      detectedMimeType: declared,
      now,
    };
    try {
      const file = await open(path, 'r');
      let contentSha256;
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size !== input.expectedSizeBytes)
          throw new MediaHashMismatchError();
        const digest = createHash('sha256');
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > input.expectedSizeBytes)
            throw new MediaHashMismatchError();
          digest.update(chunk);
        }
        contentSha256 = digest.digest('hex');
      } finally {
        await file.close();
      }
      if (contentSha256 !== expected) throw new MediaHashMismatchError();
      const scan = await this.#scanner.scan(path);
      const detectedMimeType = boundedString(
        scan?.detectedMimeType,
        'detectedMimeType',
        255,
      );
      const signatureUpdatedAt = validDate(
        scan?.signatureUpdatedAt,
        'signatureUpdatedAt',
      );
      common.detectedMimeType = detectedMimeType;
      if (
        !scan.clean ||
        !this.#allowedMimeTypes.has(detectedMimeType) ||
        detectedMimeType !== declared
      ) {
        await rm(path, { force: true });
        await this.#repository.markRejected({
          ...common,
          reason: scan.clean ? 'invalid_type' : 'infected',
        });
        return Object.freeze({
          availabilityStatus: 'rejected',
          contentSha256,
          sizeBytes: common.sizeBytes,
          storageKey: null,
        });
      }
      if (
        now.getTime() - signatureUpdatedAt.getTime() >
        MAX_SCANNER_SIGNATURE_AGE_MS
      ) {
        await this.#repository.markQuarantined({
          ...common,
          reason: 'stale_signatures',
        });
        return Object.freeze({
          availabilityStatus: 'quarantined',
          contentSha256,
          sizeBytes: common.sizeBytes,
          storageKey: input.storageKey,
        });
      }
      await this.#repository.markAvailable(common);
      return Object.freeze({
        availabilityStatus: 'available',
        contentSha256,
        sizeBytes: common.sizeBytes,
        storageKey: input.storageKey,
      });
    } catch (error) {
      if (error instanceof MediaHashMismatchError) {
        await rm(path, { force: true });
        await this.#repository.markRejected({
          ...common,
          reason: 'hash_mismatch',
        });
      } else {
        await this.#repository.markUnavailable({
          mediaId,
          now,
          reason:
            /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
              ? 'lost'
              : 'storage_or_scan_failed',
        });
      }
      throw error;
    }
  }

  /** @param {{mediaId: string, bytes: Buffer|Uint8Array|AsyncIterable<Uint8Array>, declaredMimeType?: string|null, expectedSha256?: string|null}} input */
  async #storeSerial({
    mediaId,
    bytes,
    declaredMimeType = null,
    expectedSha256 = null,
  }) {
    const normalizedMediaId = boundedString(mediaId, 'mediaId', 128);
    const declared = declaredMimeType
      ? boundedString(declaredMimeType, 'declaredMimeType', 255)
      : null;
    const fileLimit = declared?.startsWith('image/')
      ? Math.min(this.#maxFileBytes, 5 * 1024 * 1024)
      : this.#maxFileBytes;
    const expectedDigest =
      expectedSha256 === null
        ? null
        : sha256Digest(expectedSha256, 'expectedSha256');
    const now = validDate(this.#now(), 'now');
    await this.#prepareRoot();
    let usedBytes;
    try {
      usedBytes = await this.#usedBytes();
    } catch (error) {
      await this.#repository.markUnavailable({
        mediaId: normalizedMediaId,
        now,
        reason: 'volume_unavailable',
      });
      throw new MediaVolumeUnavailableError({ cause: error });
    }
    if (usedBytes >= this.#maxBytes) {
      await this.#repository.markUnavailable({
        mediaId: normalizedMediaId,
        now,
        reason: 'quota_exceeded',
      });
      throw new MediaQuotaExceededError();
    }

    const storageKey = randomUUID();
    const partialPath = join(this.#rootDirectory, `.partial-${randomUUID()}`);
    const finalPath = join(this.#rootDirectory, storageKey);
    const digest = createHash('sha256');
    let sizeBytes = 0;
    let handle;
    try {
      handle = await open(partialPath, 'wx', 0o600);
      for await (const value of toAsyncIterable(bytes)) {
        const chunk = Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > fileLimit || usedBytes + sizeBytes > this.#maxBytes) {
          throw new MediaQuotaExceededError();
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      const contentSha256 = digest.digest('hex');
      if (
        expectedDigest !== null &&
        !timingSafeEqual(
          Buffer.from(contentSha256, 'hex'),
          Buffer.from(expectedDigest, 'hex'),
        )
      ) {
        await rm(partialPath, { force: true });
        await this.#repository.markRejected({
          contentSha256,
          declaredMimeType: declared,
          detectedMimeType: declared ?? 'application/octet-stream',
          mediaId: normalizedMediaId,
          now,
          reason: 'hash_mismatch',
          sizeBytes,
          storageKey,
        });
        throw new MediaHashMismatchError();
      }
      const scan = await this.#scanner.scan(partialPath);
      const detectedMimeType = boundedString(
        scan?.detectedMimeType,
        'detectedMimeType',
        255,
      );
      const signatureUpdatedAt = validDate(
        scan?.signatureUpdatedAt,
        'signatureUpdatedAt',
      );
      const common = {
        contentSha256,
        declaredMimeType: declared,
        detectedMimeType,
        mediaId: normalizedMediaId,
        now,
        sizeBytes,
        storageKey,
      };

      if (!scan.clean) {
        await rm(partialPath, { force: true });
        await this.#repository.markRejected({
          ...common,
          reason: 'infected',
        });
        return Object.freeze({
          availabilityStatus: 'rejected',
          contentSha256,
          sizeBytes,
          storageKey: null,
        });
      }
      if (
        !this.#allowedMimeTypes.has(detectedMimeType) ||
        (declared && declared !== detectedMimeType)
      ) {
        await rm(partialPath, { force: true });
        await this.#repository.markRejected({
          ...common,
          reason: 'invalid_type',
        });
        return Object.freeze({
          availabilityStatus: 'rejected',
          contentSha256,
          sizeBytes,
          storageKey: null,
        });
      }

      await rename(partialPath, finalPath);
      if (
        now.getTime() - signatureUpdatedAt.getTime() >
        MAX_SCANNER_SIGNATURE_AGE_MS
      ) {
        await this.#repository.markQuarantined({
          ...common,
          reason: 'stale_signatures',
        });
        return Object.freeze({
          availabilityStatus: 'quarantined',
          contentSha256,
          sizeBytes,
          storageKey,
        });
      }

      await this.#repository.markAvailable(common);
      return Object.freeze({
        availabilityStatus: 'available',
        contentSha256,
        sizeBytes,
        storageKey,
      });
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the storage or validation failure.
      }
      await rm(partialPath, { force: true });
      if (error instanceof MediaQuotaExceededError) {
        await this.#repository.markUnavailable({
          mediaId: normalizedMediaId,
          now,
          reason: 'quota_exceeded',
        });
        throw error;
      }
      if (error instanceof MediaHashMismatchError) throw error;
      await this.#repository.markUnavailable({
        mediaId: normalizedMediaId,
        now,
        reason: 'storage_or_scan_failed',
      });
      throw error;
    }
  }

  /** @param {{mediaId: string, storageKey: string}} input */
  async resolvePath({ mediaId, storageKey }) {
    const normalizedMediaId = boundedString(mediaId, 'mediaId', 128);
    const path = this.#storagePath(storageKey);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error('media path is not a file');
      return path;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
      await this.#repository.markUnavailable({
        mediaId: normalizedMediaId,
        now: validDate(this.#now(), 'now'),
        reason: 'lost',
      });
      return null;
    }
  }

  /** @param {{mediaId: string, storageKey: string, reason: 'expired'|'journey_terminal'}} input */
  async delete({ mediaId, storageKey, reason }) {
    const normalizedMediaId = boundedString(mediaId, 'mediaId', 128);
    if (!['expired', 'journey_terminal'].includes(reason)) {
      throw new TypeError('reason must be expired or journey_terminal');
    }
    await rm(this.#storagePath(storageKey), { force: true });
    await this.#repository.markDeleted({
      mediaId: normalizedMediaId,
      now: validDate(this.#now(), 'now'),
      reason,
    });
  }

  async #prepareRoot() {
    try {
      await mkdir(this.#rootDirectory, { mode: 0o700, recursive: true });
      const entries = await readdir(this.#rootDirectory, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('.partial-')) {
          await rm(join(this.#rootDirectory, entry.name), { force: true });
        }
      }
    } catch (error) {
      throw new MediaVolumeUnavailableError({ cause: error });
    }
  }

  async #usedBytes() {
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error('private media volume contains a non-file entry');
      }
      total += (await stat(join(this.#rootDirectory, entry.name))).size;
    }
    return total;
  }

  /** @param {string} storageKey */
  #storagePath(storageKey) {
    if (!/^[0-9a-f-]{36}$/u.test(storageKey)) {
      throw new TypeError('storageKey must be an opaque UUID');
    }
    return join(this.#rootDirectory, storageKey);
  }
}

/** @param {Buffer|Uint8Array|AsyncIterable<Uint8Array>} bytes */
async function* toAsyncIterable(bytes) {
  if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
    yield bytes;
    return;
  }
  if (bytes && typeof bytes[Symbol.asyncIterator] === 'function') {
    yield* bytes;
    return;
  }
  throw new TypeError('bytes must be binary data or an async iterable');
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

/** @param {unknown} value @param {string} field @param {number} maximum */
function boundedString(value, field, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${field} must be between 1 and ${maximum} characters`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function sha256Digest(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function validDate(value, field) {
  const date =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return date;
}
