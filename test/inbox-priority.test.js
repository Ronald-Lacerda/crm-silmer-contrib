import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationHandoffTitle,
  conversationNextAction,
  conversationWaitingSince,
  orderReadyToReview,
} from '../apps/edge-web/src/lib/inbox-priority.js';

const owned = {
  assignedUser: { id: 'seller-synthetic' },
  automationState: 'human',
  state: 'em_atendimento',
  lastMessage: { direction: 'inbound' },
};
const handoff = {
  status: 'pending',
  createdAt: '2026-11-01T12:00:00Z',
  reasonCode: 'unsupported',
};

test('synthetic triage: human assignment, own response, other seller and assistant have distinct next actions', () => {
  assert.equal(
    conversationNextAction(
      { ...owned, assignedUser: null, handoff },
      'seller-synthetic',
    ).label,
    'Assumir atendimento',
  );
  assert.equal(
    conversationNextAction(owned, 'seller-synthetic').label,
    'Responder cliente',
  );
  assert.equal(
    conversationNextAction(
      { ...owned, assignedUser: { id: 'other', name: 'Pessoa sintética' } },
      'seller-synthetic',
    ).label,
    'Com Pessoa sintética',
  );
  assert.equal(
    conversationNextAction(
      {
        ...owned,
        assignedUser: null,
        state: 'nova',
        automationState: 'assistant',
      },
      'seller-synthetic',
    ).label,
    'Com o agente',
  );
  assert.equal(
    conversationNextAction(
      { ...owned, lastMessage: { direction: 'outbound' } },
      'seller-synthetic',
    ).label,
    'Aguardando cliente',
  );
});

test('synthetic closing: only an explicit official readiness flag on a pending order offers review', () => {
  for (const order of [
    null,
    { status: 'pendente' },
    { status: 'pendente', readyForConfirmation: false },
    { status: 'confirmado', readyForConfirmation: true },
  ]) {
    const conversation = {
      ...owned,
      order,
      handoff: { ...handoff, reasonCode: 'briefing_complete' },
    };
    assert.equal(orderReadyToReview(conversation), false);
    assert.equal(
      conversationNextAction(conversation, 'seller-synthetic').label,
      'Assumir atendimento',
    );
  }
  const ready = {
    ...owned,
    order: { status: 'pendente', readyForConfirmation: true },
  };
  assert.equal(
    conversationNextAction(ready, 'seller-synthetic').label,
    'Revisar pedido',
  );
  assert.equal(
    orderReadyToReview({
      ...owned,
      order: { status: 'pendente', readyForConfirmation: false },
      reviewOrder: ready.order,
    }),
    true,
  );
  assert.equal(
    conversationNextAction(
      { ...ready, assignedUser: null, handoff },
      'seller-synthetic',
    ).label,
    'Assumir e revisar pedido',
  );
  assert.equal(
    conversationNextAction(
      { ...ready, assignedUser: { id: 'other' } },
      'seller-synthetic',
    ).label,
    'Com outro vendedor',
  );
});

test('synthetic waiting: a later automatic notice never resets handoff waiting, invalid and terminal instants are hidden', () => {
  assert.equal(
    conversationWaitingSince({
      ...owned,
      handoff,
      updatedAt: '2026-11-03T12:00:00Z',
    }),
    handoff.createdAt,
  );
  assert.equal(
    conversationWaitingSince({ ...owned, waitingSince: handoff.createdAt }),
    handoff.createdAt,
  );
  assert.equal(
    conversationWaitingSince({ ...owned, updatedAt: handoff.createdAt }),
    null,
  );
  assert.equal(
    conversationWaitingSince({
      ...owned,
      handoff: { ...handoff, createdAt: 'invalid' },
    }),
    null,
  );
  assert.equal(
    conversationWaitingSince({ ...owned, handoff, state: 'encerrada' }),
    null,
  );
  assert.equal(
    conversationWaitingSince({
      ...owned,
      handoff,
      archivedAt: handoff.createdAt,
    }),
    null,
  );
});

test('synthetic alerts: failed or uncertain sends override closing and never invite resending', () => {
  const ready = {
    ...owned,
    order: { status: 'pendente', readyForConfirmation: true },
  };
  assert.deepEqual(
    conversationNextAction(
      { ...ready, deliveryIssue: { status: 'failed' } },
      'seller-synthetic',
    ),
    { label: 'Envio falhou — revisar', tone: 'error' },
  );
  assert.deepEqual(
    conversationNextAction(
      { ...ready, lastMessage: { deliveryStatus: 'outcome_unknown' } },
      'seller-synthetic',
    ),
    { label: 'Envio incerto — verificar', tone: 'error' },
  );
  assert.equal(
    conversationNextAction(
      {
        ...ready,
        deliveryIssue: { status: 'failed' },
        assignedUser: { id: 'other', name: 'Ana sintética' },
      },
      'seller-synthetic',
    ).label,
    'Envio falhou · Com Ana sintética',
  );
  assert.equal(conversationHandoffTitle({ handoff }), 'Agente não continuou');
  assert.equal(
    conversationHandoffTitle({ handoff: { reasonCode: 'urgency' } }),
    'Urgência',
  );
});
