import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  MELHOR_ENVIO_SIGNATURE_HEADER,
  MELHOR_ENVIO_WEBHOOK_EVENTS,
  parseMelhorEnvioWebhook,
  verifyMelhorEnvioSignature,
} from '../modules/shipping/src/adapters/melhor-envio-webhook.js';
import { ShippingError } from '../modules/shipping/src/domain/errors.js';

const SECRET = 'app-secret-for-tests';
const ORDER_ID = '0000aaaa-aa00-00aa-aa00-000000aaaaaa';

/** @param {string} event @param {Record<string, unknown>} [data] */
function payload(event, data = {}) {
  return {
    event,
    data: {
      id: ORDER_ID,
      protocol: 'ORD-2024XXXXXXXXXX',
      status: 'posted',
      tracking: null,
      self_tracking: null,
      user_id: '0000111',
      tags: [{ tag: 'crm-order-42', url: 'https://crm.example.test/p/42' }],
      created_at: '2024-03-29T23:49:26+00:00',
      paid_at: '2024-03-29T23:50:00+00:00',
      generated_at: '2024-03-29T23:51:00+00:00',
      posted_at: '2024-03-29T23:55:00+00:00',
      delivered_at: '2024-03-31T10:00:00+00:00',
      canceled_at: '2024-03-30T08:00:00+00:00',
      expired_at: null,
      tracking_url: 'https://www.melhorrastreio.com.br/rastreio/XXXXXXXXX',
      ...data,
    },
  };
}

/** @param {string|Buffer} body @param {BufferEncoding|'base64'} [encoding] */
function sign(body, encoding = 'base64') {
  return createHmac('sha256', SECRET)
    .update(body)
    .digest(/** @type {any} */ (encoding));
}

test('the signature header is the documented X-ME-Signature', () => {
  assert.equal(MELHOR_ENVIO_SIGNATURE_HEADER, 'x-me-signature');
});

test('accepts a base64 HMAC-SHA256 of the raw body, as string or Buffer', () => {
  const raw = JSON.stringify(payload('order.posted'));
  const signature = sign(raw);
  assert.equal(signature.length, 44);
  assert.equal(
    verifyMelhorEnvioSignature({ rawBody: raw, signature, secret: SECRET }),
    true,
  );
  assert.equal(
    verifyMelhorEnvioSignature({
      rawBody: Buffer.from(raw, 'utf8'),
      signature,
      secret: SECRET,
    }),
    true,
  );
});

test('accepts the hex form until the sandbox confirms the encoding', () => {
  const raw = '{"event":"order.posted"}';
  assert.equal(
    verifyMelhorEnvioSignature({
      rawBody: raw,
      signature: sign(raw, 'hex'),
      secret: SECRET,
    }),
    true,
  );
});

test('rejects tampered bodies, wrong secrets and malformed signatures', () => {
  const raw = JSON.stringify(payload('order.delivered'));
  const signature = sign(raw);
  const cases = [
    { rawBody: `${raw} `, signature, secret: SECRET },
    { rawBody: raw.replace('delivered', 'posted'), signature, secret: SECRET },
    { rawBody: raw, signature, secret: 'other-secret' },
    { rawBody: raw, signature: signature.slice(0, 20), secret: SECRET },
    { rawBody: raw, signature: `${signature}AA`, secret: SECRET },
    { rawBody: raw, signature: '', secret: SECRET },
    { rawBody: raw, signature: undefined, secret: SECRET },
    { rawBody: raw, signature: ['x'], secret: SECRET },
    { rawBody: raw, signature, secret: '' },
    { rawBody: raw, signature, secret: undefined },
    { rawBody: JSON.parse(raw), signature, secret: SECRET },
    { rawBody: undefined, signature, secret: SECRET },
  ];
  for (const input of cases) {
    assert.equal(verifyMelhorEnvioSignature(/** @type {any} */ (input)), false);
  }
  assert.equal(verifyMelhorEnvioSignature(/** @type {any} */ (null)), false);
});

test('normalizes every known event', () => {
  const expectedTime = {
    'order.created': '2024-03-29T23:49:26.000Z',
    'order.released': '2024-03-29T23:50:00.000Z',
    'order.generated': '2024-03-29T23:51:00.000Z',
    'order.posted': '2024-03-29T23:55:00.000Z',
    'order.delivered': '2024-03-31T10:00:00.000Z',
    'order.cancelled': '2024-03-30T08:00:00.000Z',
  };
  for (const event of MELHOR_ENVIO_WEBHOOK_EVENTS) {
    const parsed = parseMelhorEnvioWebhook(payload(event));
    assert.ok(Object.isFrozen(parsed));
    assert.deepEqual(parsed, {
      event,
      known: true,
      orderId: ORDER_ID,
      status: 'posted',
      tracking: null,
      trackingUrl: 'https://www.melhorrastreio.com.br/rastreio/XXXXXXXXX',
      tags: ['crm-order-42'],
      occurredAt:
        expectedTime[/** @type {keyof typeof expectedTime} */ (event)] ?? null,
    });
  }
  assert.equal(MELHOR_ENVIO_WEBHOOK_EVENTS.length, 11);
});

test('keeps the tracking code and plain string tags', () => {
  const parsed = parseMelhorEnvioWebhook(
    payload('order.posted', {
      tracking: 'ME23002OWZ7BR',
      tags: ['crm-order-7', { tag: '' }, 42, null],
      posted_at: 'not a date',
    }),
  );
  assert.ok(parsed.known);
  assert.equal(parsed.tracking, 'ME23002OWZ7BR');
  assert.deepEqual(parsed.tags, ['crm-order-7']);
  assert.ok(Object.isFrozen(parsed.tags));
  assert.equal(parsed.occurredAt, null);
});

/** @param {string} event @param {Record<string, unknown>} [data] */
function occurredAtOf(event, data) {
  const parsed = parseMelhorEnvioWebhook(payload(event, data));
  assert.ok(parsed.known);
  return parsed.occurredAt;
}

test('events without their own timestamp fall back to updated_at', () => {
  const updatedAt = '2024-04-01T12:30:00+00:00';
  for (const event of ['order.paused', 'order.undelivered']) {
    assert.equal(
      occurredAtOf(event, { updated_at: updatedAt }),
      '2024-04-01T12:30:00.000Z',
    );
    assert.equal(occurredAtOf(event), null);
    assert.equal(occurredAtOf(event, { updated_at: 'yesterday' }), null);
  }
  assert.equal(
    occurredAtOf('order.posted', { posted_at: null, updated_at: updatedAt }),
    '2024-04-01T12:30:00.000Z',
  );
  assert.equal(
    occurredAtOf('order.posted', { updated_at: updatedAt }),
    '2024-03-29T23:55:00.000Z',
    'the event timestamp wins over updated_at',
  );
});

test('an unknown event is recorded and ignored, not thrown', () => {
  const parsed = parseMelhorEnvioWebhook({ event: 'order.teleported' });
  assert.deepEqual(parsed, { event: 'order.teleported', known: false });
  assert.ok(Object.isFrozen(parsed));
});

test('a payload without event or order id is invalid', () => {
  for (const bad of [
    null,
    'order.posted',
    [],
    {},
    { event: '' },
    { event: 'order.posted' },
    { event: 'order.posted', data: { status: 'posted' } },
    { event: 'order.posted', data: [] },
  ]) {
    assert.throws(
      () => parseMelhorEnvioWebhook(bad),
      (error) =>
        error instanceof ShippingError &&
        error.code === 'MELHOR_ENVIO_WEBHOOK_INVALID' &&
        error.statusCode === 400,
    );
  }
});
