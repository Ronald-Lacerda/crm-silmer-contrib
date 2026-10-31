import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASKED_FIELD_LABELS,
  askedFieldLabel,
  assistantContextLines,
  preferredSellerFirstName,
  preferredSellerLabel,
  snakeKeys,
} from '../apps/edge-web/src/lib/assistant-context.js';
import { performanceSummary } from '../apps/edge-web/src/lib/assistant-performance.js';

// INBOX-HANDOFF-02 (RFC 041): synthetic names and codes only.

test('reads the asked seller from the list, the handoff and the contract', () => {
  assert.equal(
    preferredSellerFirstName({ preferredSellerFirstName: 'Ana' }),
    'Ana',
  );
  assert.equal(
    preferredSellerFirstName({
      preferredSeller: { id: 'u-1', firstName: 'Bia' },
    }),
    'Bia',
  );
  assert.equal(
    preferredSellerFirstName({ handoff_preferred_seller_first_name: 'Caio' }),
    'Caio',
  );
  assert.equal(
    preferredSellerFirstName({
      preferred_seller: { id: 'u-2', first_name: 'Duda Lima' },
    }),
    'Duda',
  );
  // The handoff read answers `{handoff, preferred_seller}`; the whole
  // answer is read, never the handoff object alone.
  assert.equal(
    preferredSellerFirstName({
      handoff: { id: 'h-1', status: 'pending' },
      preferred_seller: { id: 'u-3', first_name: 'Eva' },
    }),
    'Eva',
  );
  assert.equal(
    preferredSellerFirstName({
      handoff: { id: 'h-1' },
      preferred_seller: null,
    }),
    '',
  );
  assert.equal(preferredSellerFirstName({ preferredSeller: null }), '');
  assert.equal(preferredSellerFirstName(null), '');
  assert.equal(preferredSellerFirstName({ preferredSellerFirstName: 42 }), '');
  assert.equal(
    preferredSellerFirstName({ preferredSellerFirstName: 'x'.repeat(41) }),
    '',
  );
  assert.equal(
    preferredSellerFirstName({ preferredSellerFirstName: '<script>' }),
    '',
  );
});

test('says who the customer asked for, or nothing', () => {
  assert.equal(preferredSellerLabel('Ana'), 'Cliente pediu: Ana');
  assert.equal(preferredSellerLabel(''), '');
  assert.equal(preferredSellerLabel(null), '');
});

test('names every point the agent asks in the words of the Ficha', () => {
  for (const code of [
    'customer_name',
    'product_type',
    'product_model',
    'colors',
    'quantity',
    'fabrics',
    'artwork_locations',
    'artwork_status',
    'needed_by',
    'sizes',
    'collar',
  ]) {
    assert.ok(Object.hasOwn(ASKED_FIELD_LABELS, code), code);
  }
  assert.equal(askedFieldLabel('colors'), 'Cor');
  assert.equal(askedFieldLabel('needed_by'), 'Para quando');
  assert.equal(askedFieldLabel('inventado'), '');
  assert.equal(askedFieldLabel('toString'), '');
});

test('reads the last turn of the agent for a direct takeover', () => {
  assert.deepEqual(
    assistantContextLines({
      last_turn: {
        asked_field: 'colors',
        answer_status: 'answered',
        ficha_filled: 3,
        ficha_total: 8,
        trigger: null,
        occurred_at: '2026-10-30T12:00:00.000Z',
      },
      assistant_messages: 4,
      assistant_message_cap: 15,
    }),
    [
      'O agente estava perguntando: Cor · Ficha 3 de 8',
      '4 de 15 mensagens do agente',
    ],
  );
  // The read model's camelCase reads the same.
  assert.deepEqual(
    assistantContextLines({
      lastTurn: { askedField: 'quantity', fichaFilled: 1, fichaTotal: 8 },
      assistantMessages: 1,
      assistantMessageCap: 15,
    }),
    [
      'O agente estava perguntando: Quantidade · Ficha 1 de 8',
      '1 de 15 mensagens do agente',
    ],
  );
});

test('leaves out what the agent did not report', () => {
  assert.deepEqual(
    assistantContextLines({
      last_turn: { asked_field: 'inventado', ficha_filled: 2, ficha_total: 8 },
      assistant_messages: null,
      assistant_message_cap: 15,
    }),
    ['Ficha 2 de 8'],
  );
  assert.deepEqual(
    assistantContextLines({
      last_turn: { asked_field: 'colors', ficha_filled: 9, ficha_total: 8 },
    }),
    ['O agente estava perguntando: Cor'],
  );
  assert.deepEqual(
    assistantContextLines({
      last_turn: null,
      assistant_messages: 0,
      assistant_message_cap: 15,
    }),
    ['0 de 15 mensagens do agente'],
  );
  assert.deepEqual(assistantContextLines(null), []);
  assert.deepEqual(assistantContextLines({}), []);
});

test('turns camelCase keys into the contract names, values untouched', () => {
  assert.deepEqual(
    snakeKeys({
      byWorkflowVersion: [{ workflowVersion: 'mvp-simple-12' }],
      p90: 3,
    }),
    { by_workflow_version: [{ workflow_version: 'mvp-simple-12' }], p90: 3 },
  );
  const summary = performanceSummary({
    conversationsWithAssistant: 5,
    handoffs: { total: 1, byReason: [{ reasonCode: 'partnership', count: 1 }] },
    stalledNow: 0,
  });
  assert.equal(summary.totals[0].value, '5');
  assert.deepEqual(
    summary.reasons.map((reason) => reason.label),
    ['Parceria ou revenda'],
  );
});
