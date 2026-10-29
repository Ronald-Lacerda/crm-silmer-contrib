import { OrderError, OrderValidationError } from './errors.js';

// ADR 023: the art files of an order. Five reference files plus one final
// art, 10 MB each. The extension must be on the allowlist and the content must
// carry that format's signature, so a renamed executable is refused.

export const MAX_ORDER_REFERENCE_FILES = 5;
export const MAX_ORDER_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ORDER_THUMBNAIL_BYTES = 256 * 1024;
export const MAX_ORDER_FILE_NAME_LENGTH = 120;
export const ORDER_FILE_SLOTS = Object.freeze(
  /** @type {const} */ (['reference', 'final']),
);

/** @param {Buffer} content @param {string} text @param {number} [offset] */
function startsWith(content, text, offset = 0) {
  return content
    .subarray(offset, offset + text.length)
    .equals(Buffer.from(text, 'latin1'));
}

/** @param {Buffer} content */
const isPdf = (content) => startsWith(content, '%PDF-');
/** @param {Buffer} content */
const isPostScript = (content) => startsWith(content, '%!PS-Adobe');
/** @param {Buffer} content */
const isZip = (content) =>
  startsWith(content, 'PK\u0003\u0004') ||
  startsWith(content, 'PK\u0005\u0006');
/** @param {Buffer} content @param {string} form */
const isRiff = (content, form) =>
  startsWith(content, 'RIFF') && startsWith(content, form, 8);
/** @param {Buffer} content */
const isJpeg = (content) => startsWith(content, 'ÿØÿ');
/** @param {Buffer} content */
const isGif = (content) =>
  content.length >= 14 &&
  (startsWith(content, 'GIF87a') || startsWith(content, 'GIF89a')) &&
  content.readUInt16LE(6) > 0 &&
  content.readUInt16LE(8) > 0 &&
  content.at(-1) === 0x3b;

/** @param {Buffer} content */
function isSvg(content) {
  const head = content
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^﻿/u, '')
    .trimStart();
  return (
    !head.includes('\u0000') &&
    /^(?:<\?xml|<!--|<!DOCTYPE svg|<svg)/iu.test(head) &&
    /<svg[\s>]/iu.test(head)
  );
}

/**
 * Allowlist by extension: the type the download declares, whether the page
 * may show a thumbnail and how to recognize the content. CDR X4 and later
 * are ZIP containers; earlier versions are RIFF with a CDR form.
 *
 * @type {Readonly<Record<string, {contentType: string, thumbnail: boolean, matches: (content: Buffer) => boolean}>>}
 */
export const ORDER_FILE_FORMATS = Object.freeze({
  ai: {
    contentType: 'application/postscript',
    matches: (content) => isPdf(content) || isPostScript(content),
    thumbnail: false,
  },
  cdr: {
    contentType: 'application/vnd.corel-draw',
    matches: (content) => isZip(content) || isRiff(content, 'CDR'),
    thumbnail: false,
  },
  eps: {
    contentType: 'application/postscript',
    matches: (content) => isPostScript(content) || startsWith(content, 'ÅÐÓÆ'),
    thumbnail: false,
  },
  gif: {
    contentType: 'image/gif',
    matches: isGif,
    thumbnail: true,
  },
  jpeg: {
    contentType: 'image/jpeg',
    matches: isJpeg,
    thumbnail: true,
  },
  jpg: {
    contentType: 'image/jpeg',
    matches: isJpeg,
    thumbnail: true,
  },
  pdf: {
    contentType: 'application/pdf',
    matches: isPdf,
    thumbnail: false,
  },
  png: {
    contentType: 'image/png',
    matches: (content) => startsWith(content, '\u0089PNG\r\n\u001a\n'),
    thumbnail: true,
  },
  psd: {
    contentType: 'image/vnd.adobe.photoshop',
    matches: (content) => startsWith(content, '8BPS'),
    thumbnail: false,
  },
  rar: {
    contentType: 'application/vnd.rar',
    matches: (content) => startsWith(content, 'Rar!\u001a\u0007'),
    thumbnail: false,
  },
  // Rendering an uploaded SVG could run its scripts; it only downloads.
  svg: {
    contentType: 'image/svg+xml',
    matches: isSvg,
    thumbnail: false,
  },
  tif: {
    contentType: 'image/tiff',
    matches: (content) =>
      startsWith(content, 'II*\u0000') || startsWith(content, 'MM\u0000*'),
    thumbnail: false,
  },
  tiff: {
    contentType: 'image/tiff',
    matches: (content) =>
      startsWith(content, 'II*\u0000') || startsWith(content, 'MM\u0000*'),
    thumbnail: false,
  },
  webp: {
    contentType: 'image/webp',
    matches: (content) => isRiff(content, 'WEBP'),
    thumbnail: true,
  },
  zip: {
    contentType: 'application/zip',
    matches: isZip,
    thumbnail: false,
  },
});

/** A file over the size limit (413); the page says which one and the limit. */
export class OrderFileTooLargeError extends OrderError {
  /** @param {string} [message] */
  constructor(message = 'The file exceeds 10 MB') {
    super(message, 'FILE_TOO_LARGE', 413);
  }
}

/**
 * The name the seller sees: no path, no control characters, at most 120
 * characters and always ending in the extension the content was checked
 * against.
 *
 * @param {unknown} value
 */
export function sanitizeOrderFileName(value) {
  if (typeof value !== 'string') {
    throw new OrderValidationError('name is required', 'INVALID_FILE_NAME', [
      'name',
    ]);
  }
  const base = value
    .normalize('NFC')
    .split(/[\\/]/u)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f"<>|*?:]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const dot = base ? base.lastIndexOf('.') : -1;
  if (!base || dot <= 0 || dot === base.length - 1) {
    throw new OrderValidationError(
      'name needs a stem and an extension',
      'INVALID_FILE_NAME',
      ['name'],
    );
  }
  const extension = base.slice(dot + 1).toLowerCase();
  const stem = base.slice(0, dot);
  const room = MAX_ORDER_FILE_NAME_LENGTH - extension.length - 1;
  return {
    extension,
    name: `${Array.from(stem).slice(0, room).join('').trim()}.${extension}`,
  };
}

/**
 * Checks one upload and describes it for storage. `thumbnail` is the WebP the
 * page drew for an image; any other format must arrive without one.
 *
 * @param {{name: unknown, content: unknown, thumbnail?: Buffer|null}} input
 */
export function describeOrderFile({ name, content, thumbnail = null }) {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new OrderValidationError('content is empty', 'EMPTY_FILE', ['file']);
  }
  if (content.length > MAX_ORDER_FILE_BYTES) throw new OrderFileTooLargeError();
  const sanitized = sanitizeOrderFileName(name);
  const format = ORDER_FILE_FORMATS[sanitized.extension];
  if (!format) {
    throw new OrderValidationError(
      `.${sanitized.extension} is not accepted`,
      'FILE_TYPE_NOT_ALLOWED',
      ['file'],
    );
  }
  if (!format.matches(content)) {
    throw new OrderValidationError(
      `content is not a .${sanitized.extension} file`,
      'FILE_CONTENT_MISMATCH',
      ['file'],
    );
  }
  if (thumbnail !== null) {
    if (
      !format.thumbnail ||
      !Buffer.isBuffer(thumbnail) ||
      thumbnail.length === 0 ||
      thumbnail.length > MAX_ORDER_THUMBNAIL_BYTES ||
      !isRiff(thumbnail, 'WEBP')
    ) {
      throw new OrderValidationError(
        'thumbnail must be a WebP of an image, up to 256 KB',
        'INVALID_THUMBNAIL',
        ['thumbnail'],
      );
    }
  }
  return Object.freeze({
    contentType: format.contentType,
    extension: sanitized.extension,
    name: sanitized.name,
    sizeBytes: content.length,
  });
}

/** @param {unknown} value */
export function requireOrderFileSlot(value) {
  if (!ORDER_FILE_SLOTS.includes(/** @type {any} */ (value))) {
    throw new OrderValidationError('slot is invalid', 'INVALID_FILE_SLOT', [
      'slot',
    ]);
  }
  return /** @type {typeof ORDER_FILE_SLOTS[number]} */ (value);
}
