import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANCEL_REASON_MAX,
  describeCancelError,
  needsPaymentNotice,
  normalizeCancelReason,
  normalizeReasonText,
  validateCancelReason,
} from '../apps/edge-web/src/lib/order-cancel.js';

// OLIST-T13 (ADR 068): the reason is 1..1000 characters with no control
// character; the page cleans it before it asks, so the server never has to
// refuse a line break the person typed.

test('normalizes line breaks, tabs and runs of spaces into single spaces', () => {
  assert.equal(
    normalizeCancelReason('  Cliente\r\ndesistiu\tdo   evento \u0007 '),
    'Cliente desistiu do evento',
  );
  assert.equal(normalizeCancelReason(undefined), '');
  assert.equal(normalizeCancelReason(' \n\t '), '');
});

test('the shared normalizer is what the Olist dialogs send', () => {
  assert.equal(
    normalizeReasonText('Venda\nlançada\t\u0000à mão'),
    'Venda lançada à mão',
  );
  assert.doesNotMatch(
    normalizeReasonText('a\r\nb\u007fc'),
    /[\u0000-\u001f\u007f]/u,
  );
});

test('requires a reason within the contract limit', () => {
  assert.equal(validateCancelReason(''), 'Informe o motivo do cancelamento.');
  assert.equal(validateCancelReason('a'), '');
  assert.equal(validateCancelReason('a'.repeat(CANCEL_REASON_MAX)), '');
  assert.match(
    validateCancelReason('a'.repeat(CANCEL_REASON_MAX + 1)),
    /até 1000 caracteres/u,
  );
});

test('flags the no-refund notice for paid and store orders only', () => {
  assert.equal(needsPaymentNotice({ paidOn: '2026-09-10' }), true);
  assert.equal(needsPaymentNotice({ origin: 'loja' }), true);
  assert.equal(needsPaymentNotice({ gatewayPayment: { source: 'x' } }), true);
  assert.equal(
    needsPaymentNotice({ origin: 'atendimento', paidOn: null }),
    false,
  );
  assert.equal(needsPaymentNotice(null), false);
});

test('maps each server answer to a Portuguese message and a next step', () => {
  const blocked = describeCancelError({
    code: 'ORDER_CANCELLATION_BLOCKED',
    status: 409,
  });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.closes, true);
  assert.equal(blocked.refresh, true);
  assert.equal(blocked.retryable, false);
  assert.match(blocked.message, /venda reservada/u);

  const already = describeCancelError({ code: 'ORDER_CANCELLED', status: 409 });
  assert.equal(already.kind, 'already');
  assert.equal(already.closes, true);

  for (const code of ['VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'X']) {
    const stale = describeCancelError({ code, status: 409 });
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.closes, false);
    assert.equal(stale.refresh, true);
    assert.match(stale.message, /motivo digitado será mantido/u);
  }

  // FORBIDDEN is shared by permission, session, CSRF and origin on the server:
  // the dialog stays open with the typed reason and the session is checked.
  const forbidden = describeCancelError({ code: 'FORBIDDEN', status: 403 });
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.closes, false);
  assert.equal(forbidden.refresh, true);
  assert.match(forbidden.message, /sessão pode ter expirado/u);
  assert.match(forbidden.message, /motivo foi mantido/u);
  assert.equal(describeCancelError({ status: 404 }).kind, 'not-found');
  assert.equal(describeCancelError({ status: 401 }).kind, 'unauthorized');
  assert.equal(describeCancelError({ status: 400 }).kind, 'invalid');
  assert.equal(describeCancelError({ status: 422 }).kind, 'invalid');
  assert.equal(describeCancelError({ status: 418 }).kind, 'unknown');
});

test('an uncertain result keeps the same command retryable', () => {
  for (const status of [0, 500, 503]) {
    const result = describeCancelError({ status });
    assert.equal(result.retryable, true);
    assert.equal(result.closes, false);
  }
  assert.equal(describeCancelError(undefined).kind, 'offline');
});

test('never reflects the server body or the raw code', () => {
  const all = [
    { code: 'ORDER_CANCELLATION_BLOCKED', status: 409, message: 'secret-body' },
    { code: 'VERSION_CONFLICT', status: 409, message: 'secret-body' },
    { code: 'FORBIDDEN', status: 403, message: 'secret-body' },
    { code: 'UNAVAILABLE', status: 503, message: 'secret-body' },
  ].map((cause) => describeCancelError(cause).message);
  for (const message of all) {
    assert.doesNotMatch(message, /secret-body|[A-Z]{3,}_[A-Z_]+/u);
  }
});
