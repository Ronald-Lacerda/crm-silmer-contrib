import { createHmac, timingSafeEqual } from 'node:crypto';

import { ShippingError } from '../domain/errors.js';

// Melhor Envio webhooks (RFC 038 2.7, MEV-11). "Postado" and "entregue" are
// trusted only after the HMAC check below.

/**
 * Lower-case, as Node exposes request headers. The docs name it X-ME-Signature:
 * HMAC-SHA256 of the raw body keyed by the app secret. The documented sample
 * value is base64 (44 characters, 32 bytes).
 */
export const MELHOR_ENVIO_SIGNATURE_HEADER = 'x-me-signature';

export const MELHOR_ENVIO_WEBHOOK_EVENTS = Object.freeze([
  'order.created',
  'order.pending',
  'order.released',
  'order.generated',
  'order.received',
  'order.posted',
  'order.delivered',
  'order.cancelled',
  'order.undelivered',
  'order.paused',
  'order.suspended',
]);

// Timestamp that dates each event in the payload's `data`.
const EVENT_TIMESTAMP_FIELD = Object.freeze({
  'order.created': 'created_at',
  'order.released': 'paid_at',
  'order.generated': 'generated_at',
  'order.posted': 'posted_at',
  'order.delivered': 'delivered_at',
  'order.cancelled': 'canceled_at',
});

const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/u;
// TODO(ME-0 sandbox): drop the hex form once a real delivery confirms base64.
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/u;
const MAX_TEXT_LENGTH = 2048;
const MAX_TAGS = 20;

/**
 * Constant-time HMAC-SHA256 check over the exact received bytes. Returns
 * false on any missing or malformed input and never throws.
 *
 * @param {{rawBody: Buffer|string, signature: unknown, secret: unknown}} input
 */
export function verifyMelhorEnvioSignature(input) {
  try {
    const { rawBody, signature, secret } = input ?? {};
    if (typeof secret !== 'string' || secret === '') return false;
    if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;
    const supplied = decodeSignature(signature);
    if (!supplied) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

/**
 * Normalizes a verified payload. An unknown event is returned as
 * `{event, known: false}` so the inbox records and ignores it; a payload
 * without an event or an order id is rejected.
 *
 * @param {unknown} payload
 */
export function parseMelhorEnvioWebhook(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidWebhook();
  }
  const record = /** @type {Record<string, unknown>} */ (payload);
  const event = boundedText(record.event);
  if (event === null) throw invalidWebhook();
  if (!MELHOR_ENVIO_WEBHOOK_EVENTS.includes(event)) {
    return Object.freeze({ event, known: false });
  }

  const data =
    record.data &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data)
      ? /** @type {Record<string, unknown>} */ (record.data)
      : null;
  const orderId = boundedText(data?.id);
  if (!data || orderId === null) throw invalidWebhook();

  const timestampField =
    EVENT_TIMESTAMP_FIELD[
      /** @type {keyof typeof EVENT_TIMESTAMP_FIELD} */ (event)
    ];
  return Object.freeze({
    event,
    known: true,
    orderId,
    status: boundedText(data.status),
    tracking: boundedText(data.tracking),
    trackingUrl: boundedText(data.tracking_url),
    tags: Object.freeze(tagsOf(data.tags)),
    // Events without their own timestamp (paused, undelivered...) or with it
    // missing are ordered by `updated_at`; null only when neither is usable.
    occurredAt:
      (timestampField ? isoOrNull(data[timestampField]) : null) ??
      isoOrNull(data.updated_at),
  });
}

/** @param {unknown} signature */
function decodeSignature(signature) {
  if (typeof signature !== 'string') return null;
  const value = signature.trim();
  if (BASE64_SHA256.test(value)) return Buffer.from(value, 'base64');
  if (HEX_SHA256.test(value)) return Buffer.from(value, 'hex');
  return null;
}

/**
 * Docs show `tags: [{tag, url}]`; plain strings are accepted too. Only the tag
 * value is kept, since it carries the CRM order id for reconciliation.
 *
 * @param {unknown} value
 */
function tagsOf(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const tags = [];
  for (const entry of value.slice(0, MAX_TAGS)) {
    const tag =
      entry && typeof entry === 'object'
        ? boundedText(/** @type {Record<string, unknown>} */ (entry).tag)
        : boundedText(entry);
    if (tag !== null) tags.push(tag);
  }
  return tags;
}

/** @param {unknown} value */
function boundedText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text.length > MAX_TEXT_LENGTH ? null : text;
}

/** @param {unknown} value */
function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function invalidWebhook() {
  return new ShippingError(
    'Melhor Envio webhook payload is invalid',
    'MELHOR_ENVIO_WEBHOOK_INVALID',
    400,
  );
}
