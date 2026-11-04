import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliveryFailureCode,
  deliveryFailureHint,
} from '../apps/edge-web/src/lib/delivery-failure.js';

// INBOX-DELIVERY-01/02 (RFC 041): the code for support, one plain sentence.

test('shows only a code with the shape the database accepts', () => {
  assert.equal(deliveryFailureCode('SEND_FAILED'), 'SEND_FAILED');
  assert.equal(
    deliveryFailureCode('N8N_COMMAND_HTTP_401'),
    'N8N_COMMAND_HTTP_401',
  );
  assert.equal(deliveryFailureCode('send_failed'), null);
  assert.equal(deliveryFailureCode('SEND FAILED'), null);
  assert.equal(deliveryFailureCode('X'.repeat(65)), null);
  assert.equal(deliveryFailureCode(null), null);
  assert.equal(deliveryFailureCode(7), null);
});

test('explains the agent codes and the n8n command codes', () => {
  assert.equal(
    deliveryFailureHint('SEND_FAILED'),
    'O serviço de mensagens não entregou a mensagem ao cliente.',
  );
  assert.equal(
    deliveryFailureHint('SEND_OUTCOME_UNKNOWN'),
    'O serviço de mensagens não confirmou se a mensagem chegou ao cliente.',
  );
  assert.equal(
    deliveryFailureHint('OUTCOME_UNKNOWN'),
    deliveryFailureHint('SEND_OUTCOME_UNKNOWN'),
  );
  // The code the published workflow reports for an unconfirmed send.
  assert.equal(
    deliveryFailureHint('META_SEND_OUTCOME_UNKNOWN'),
    deliveryFailureHint('SEND_OUTCOME_UNKNOWN'),
  );
  for (const code of [
    'COMMAND_LEASE_EXPIRED',
    'N8N_COMMAND_ACK_MISMATCH',
    'N8N_COMMAND_DELIVERY_FAILED',
    'N8N_COMMAND_HTTP_401',
    'N8N_COMMAND_HTTP_403',
    'N8N_COMMAND_HTTP_404',
    'N8N_COMMAND_HTTP_405',
    'N8N_COMMAND_ID_MISMATCH',
    'N8N_COMMAND_INVALID',
    'N8N_COMMAND_NETWORK_ERROR',
    'N8N_COMMAND_NOT_FOUND',
    'N8N_COMMAND_PAYLOAD_CHANGED',
    'N8N_COMMAND_PAYLOAD_INVALID',
    'N8N_COMMAND_RECONCILED_FAILED',
    'N8N_COMMAND_REJECTED',
    'N8N_COMMAND_REMOTE_UNAVAILABLE',
    'N8N_COMMAND_STALE',
    'N8N_COMMAND_TIMEOUT',
  ]) {
    assert.notEqual(deliveryFailureHint(code), '', code);
  }
});

test('an unknown code keeps the code and adds no guess', () => {
  assert.equal(deliveryFailureHint('META_131047'), '');
  assert.equal(deliveryFailureHint('toString'), '');
  assert.equal(deliveryFailureHint(undefined), '');
});

test('explains recipient checks without claiming a permanent account state', () => {
  assert.equal(
    deliveryFailureHint('EVOLUTION_RECIPIENT_NOT_FOUND'),
    'O WhatsApp não reconheceu o número informado na verificação.',
  );
  assert.equal(
    deliveryFailureHint('EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE'),
    'A verificação do número no WhatsApp não pôde ser concluída.',
  );
});
