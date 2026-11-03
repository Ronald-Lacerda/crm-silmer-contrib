import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orderAssistanceEvidence,
  orderAssistanceMetrics,
  orderAssistanceReason,
  orderAssistanceStatus,
} from '../apps/edge-web/src/lib/order-assistance.js';

test('OA-10: evidence choices contain only customer messages of the supplied conversation', () => {
  const result = orderAssistanceEvidence([
    { id: 'seller-1', direction: 'outbound', text: 'Quer fechar?' },
    { id: 'customer-1', direction: 'inbound', text: 'Sim, vamos fechar.' },
    { id: 'customer-2', sender_type: 'customer', preview: '30 peças.' },
    { id: 'system-1', sender_type: 'assistant', text: 'Pedido confirmado' },
    { direction: 'inbound', text: 'Sem identidade não serve de evidência' },
  ]);
  assert.deepEqual(
    result.map((item) => [item.id, item.text]),
    [
      ['customer-1', 'Sim, vamos fechar.'],
      ['customer-2', '30 peças.'],
    ],
  );
  assert.equal(
    orderAssistanceEvidence([
      {
        id: 'audio-1',
        direction: 'inbound',
        transcript: { text: 'Pode fechar o orçamento.' },
      },
    ])[0].text,
    'Pode fechar o orçamento.',
  );
});

test('OA-11: unknown metrics and sampleless times never look like zero', () => {
  const items = orderAssistanceMetrics({
    suggestions: 0,
    accepted: 2,
    missed: null,
    averageDecisionSeconds: 0,
    averageCreationSeconds: null,
    observations: -1,
  });
  const value = (/** @type {string} */ label) =>
    items.find((item) => item.label === label)?.value;
  assert.equal(value('Sugestões feitas'), '0');
  assert.equal(value('Pedidos criados pela sugestão'), '2');
  assert.equal(value('Omissões marcadas pelo vendedor'), '—');
  assert.equal(value('Análises realizadas'), '—');
  assert.equal(value('Tempo médio até a decisão'), 'menos de 1 min');
  assert.equal(
    value('Tempo médio até criar o pedido'),
    'Sem amostras no período',
  );
  assert.equal(
    orderAssistanceMetrics({ averageCreationSeconds: 7200 }).find(
      (item) => item.label === 'Tempo médio até criar o pedido',
    )?.value,
    '2 h',
  );
});

test('OA-06: operational states do not expose unknown model output', () => {
  assert.equal(
    orderAssistanceStatus('obsolete'),
    'Conversa mudou; sugestão substituída',
  );
  assert.equal(orderAssistanceStatus('toString'), 'Decisão registrada');
  assert.equal(orderAssistanceStatus('<script>'), 'Decisão registrada');
  assert.equal(
    orderAssistanceReason('unsupported'),
    'Produto ou serviço não atendido',
  );
  assert.equal(orderAssistanceReason('model hallucination'), '');
});
