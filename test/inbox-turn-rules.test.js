import assert from 'node:assert/strict';
import test from 'node:test';
import { brand } from '../apps/edge-web/src/brand/index.js';
import {
  BADGE_RULES,
  conversationBadges,
  inboxBucketsUrl,
  inboxListUrl,
  inboxStateFromRoute,
  splitBadges,
  turnCardTime,
} from '../apps/edge-web/src/lib/inbox-turn.js';

// INBOX-VEZ-07: the pure rules that used to live in InboxView.vue.
// Synthetic data only.

test('with no query the Inbox opens Responder, open, for the saved owner', () => {
  assert.deepEqual(inboxStateFromRoute({}, 'all'), {
    bucket: 'respond',
    ownerScope: 'all',
    orderReadyOnly: false,
    consult: 'open',
    ownerFilter: '',
  });
  assert.equal(inboxStateFromRoute({}, 'mine').ownerScope, 'mine');
  assert.equal(inboxStateFromRoute(undefined).ownerScope, 'all');
  assert.equal(
    inboxStateFromRoute(null, 'unassigned').ownerScope,
    'unassigned',
  );
});

test('old ?situacao= links map onto the tabs (D1, D10)', () => {
  /** @param {string} situacao @param {string} [stored] */
  const open = (situacao, stored = 'mine') =>
    inboxStateFromRoute({ situacao }, stored);
  // D1: Atender opens Responder for everyone, ignoring the saved preference.
  assert.deepEqual(open('atender'), {
    bucket: 'respond',
    ownerScope: 'all',
    orderReadyOnly: false,
    consult: 'open',
    ownerFilter: '',
  });
  // D10: the agent's own turn is Aguardando; the human turn is Responder.
  assert.equal(open('agente').bucket, 'awaiting');
  assert.equal(open('aguardando').bucket, 'respond');
  assert.equal(open('vendedor').bucket, 'respond');
  // Only Atender overrides the saved owner; the others keep it.
  assert.equal(open('agente').ownerScope, 'mine');
  assert.equal(open('aguardando').ownerScope, 'mine');
  assert.equal(open('vendedor').ownerScope, 'mine');
  // Fechar is the "Pedido pronto" chip; Arquivadas is a consultation.
  assert.deepEqual(open('fechar'), {
    bucket: 'respond',
    ownerScope: 'mine',
    orderReadyOnly: true,
    consult: 'open',
    ownerFilter: '',
  });
  assert.deepEqual(open('arquivadas', 'all'), {
    bucket: 'respond',
    ownerScope: 'all',
    orderReadyOnly: false,
    consult: 'archived',
    ownerFilter: '',
  });
  // An unknown queue changes nothing.
  assert.deepEqual(open('inexistente'), inboxStateFromRoute({}, 'mine'));
});

test('?aba= and ?fila= win over ?situacao= and never over the saved value', () => {
  assert.equal(inboxStateFromRoute({ aba: 'perdidos' }).bucket, 'lost');
  assert.equal(inboxStateFromRoute({ aba: 'sem-retorno' }).bucket, 'silent');
  assert.equal(inboxStateFromRoute({ aba: 'aguardando' }).bucket, 'awaiting');
  // ?aba= beats ?situacao=agente.
  assert.equal(
    inboxStateFromRoute({ aba: 'responder', situacao: 'agente' }).bucket,
    'respond',
  );
  // An unknown tab falls back to what ?situacao= says.
  assert.equal(
    inboxStateFromRoute({ aba: 'constructor', situacao: 'agente' }).bucket,
    'awaiting',
  );
  assert.equal(
    inboxStateFromRoute({ fila: 'minhas' }, 'all').ownerScope,
    'mine',
  );
  assert.equal(
    inboxStateFromRoute({ fila: 'sem-responsavel' }, 'mine').ownerScope,
    'unassigned',
  );
  // ?fila= beats ?situacao=atender.
  assert.equal(
    inboxStateFromRoute({ fila: 'minhas', situacao: 'atender' }, 'all')
      .ownerScope,
    'mine',
  );
  // An unknown queue name keeps the saved scope.
  assert.equal(
    inboxStateFromRoute({ fila: '__proto__' }, 'mine').ownerScope,
    'mine',
  );
});

test('?responsavel= lists one seller and only without an owner scope', () => {
  // Without ?fila= it opens for everyone, whatever was saved.
  assert.deepEqual(
    inboxStateFromRoute({ responsavel: '  user-synthetic-1 ' }, 'mine'),
    {
      bucket: 'respond',
      ownerScope: 'all',
      orderReadyOnly: false,
      consult: 'open',
      ownerFilter: 'user-synthetic-1',
    },
  );
  // With ?fila=<owner> the seller filter is dropped.
  const withQueue = inboxStateFromRoute(
    { responsavel: 'user-synthetic-1', fila: 'minhas' },
    'all',
  );
  assert.equal(withQueue.ownerScope, 'mine');
  assert.equal(withQueue.ownerFilter, '');
  // A repeated parameter (array) or a blank value is not a person.
  assert.equal(
    inboxStateFromRoute({ responsavel: ['a', 'b'] }).ownerFilter,
    '',
  );
  assert.equal(
    inboxStateFromRoute({ responsavel: '   ' }, 'mine').ownerScope,
    'mine',
  );
});

test('the list URL carries tab, owner, chip and seller in a fixed order', () => {
  /** @param {Record<string, any>} [over] */
  const state = (over = {}) => ({
    bucket: 'respond',
    consult: 'open',
    ownerScope: 'all',
    orderReadyOnly: false,
    ownerFilter: '',
    ...over,
  });
  assert.equal(
    inboxListUrl(state()),
    '/api/v1/inbox/conversations?limit=100&bucket=respond&owner=all',
  );
  assert.equal(
    inboxListUrl(state({ bucket: 'lost', ownerScope: 'mine' }), 25),
    '/api/v1/inbox/conversations?limit=25&bucket=lost&owner=mine',
  );
  assert.equal(
    inboxListUrl(state({ ownerScope: 'unassigned', bucket: 'silent' })),
    '/api/v1/inbox/conversations?limit=100&bucket=silent&owner=unassigned',
  );
  // Consultations replace the bucket.
  assert.equal(
    inboxListUrl(state({ consult: 'archived' })),
    '/api/v1/inbox/conversations?limit=100&archived=true&owner=all',
  );
  assert.equal(
    inboxListUrl(state({ consult: 'closed', ownerScope: 'mine' })),
    '/api/v1/inbox/conversations?limit=100&terminal=true&owner=mine',
  );
  // orderReady only with a tab (open), never in a consultation.
  assert.equal(
    inboxListUrl(state({ orderReadyOnly: true })),
    '/api/v1/inbox/conversations?limit=100&bucket=respond&owner=all&orderReady=true',
  );
  assert.equal(
    inboxListUrl(state({ orderReadyOnly: true, consult: 'archived' })),
    '/api/v1/inbox/conversations?limit=100&archived=true&owner=all',
  );
  assert.equal(
    inboxListUrl(state({ orderReadyOnly: true, consult: 'closed' })),
    '/api/v1/inbox/conversations?limit=100&terminal=true&owner=all',
  );
  // assignedUserId only with owner all.
  assert.equal(
    inboxListUrl(state({ ownerFilter: 'user-synthetic-1' })),
    '/api/v1/inbox/conversations?limit=100&bucket=respond&owner=all&assignedUserId=user-synthetic-1',
  );
  assert.equal(
    inboxListUrl(
      state({ ownerFilter: 'user-synthetic-1', ownerScope: 'mine' }),
    ),
    '/api/v1/inbox/conversations?limit=100&bucket=respond&owner=mine',
  );
  // Everything together, with the cursor last and encoded.
  assert.equal(
    inboxListUrl(
      state({
        bucket: 'awaiting',
        orderReadyOnly: true,
        ownerFilter: 'user-synthetic-1',
      }),
      50,
      'abc/def=+',
    ),
    '/api/v1/inbox/conversations?limit=50&bucket=awaiting&owner=all&orderReady=true&assignedUserId=user-synthetic-1&cursor=abc%2Fdef%3D%2B',
  );
});

test('the totals URL follows the owner scope, never the tab or the consult', () => {
  assert.equal(
    inboxBucketsUrl({
      ownerScope: 'all',
      orderReadyOnly: false,
      ownerFilter: '',
    }),
    '/api/v1/inbox/buckets?owner=all',
  );
  assert.equal(
    inboxBucketsUrl({
      ownerScope: 'mine',
      orderReadyOnly: true,
      ownerFilter: 'user-synthetic-1',
    }),
    '/api/v1/inbox/buckets?owner=mine&orderReady=true',
  );
  assert.equal(
    inboxBucketsUrl({
      ownerScope: 'all',
      orderReadyOnly: true,
      ownerFilter: 'user-synthetic-1',
    }),
    '/api/v1/inbox/buckets?owner=all&orderReady=true&assignedUserId=user-synthetic-1',
  );
  assert.equal(
    inboxBucketsUrl({
      ownerScope: 'unassigned',
      orderReadyOnly: false,
      ownerFilter: '',
    }),
    '/api/v1/inbox/buckets?owner=unassigned',
  );
});

// --- turnCardTime ---------------------------------------------------------

/** @param {string} iso São Paulo wall clock (UTC-3, no DST since 2019) */
const at = (iso) => new Date(`${iso}-03:00`);
const format = {
  formatWhen: (/** @type {unknown} */ value) =>
    value ? `quando(${value})` : '',
  formatDateTime: (/** @type {unknown} */ value) => `data(${value})`,
  assistantReference: 'o Agente',
};
/** @param {string} now @param {boolean} [showBuckets] */
const card = (now, showBuckets = true) => ({
  ...format,
  showBuckets,
  now: at(now),
});

test('Perdidos shows the day of the loss; without it, nothing', () => {
  const lost = {
    bucket: 'lost',
    lostOutcome: { occurredAt: '2026-11-05T12:00:00.000Z' },
  };
  assert.deepEqual(turnCardTime(lost, card('2026-11-06T10:00:00')), {
    label: 'quando(2026-11-05T12:00:00.000Z)',
    spoken: 'Marcada como perdida em quando(2026-11-05T12:00:00.000Z)',
    title: 'Marcada como perdida em data(2026-11-05T12:00:00.000Z)',
  });
  assert.equal(
    turnCardTime({ bucket: 'lost' }, card('2026-11-06T10:00:00')),
    null,
  );
});

test('a consultation shows the last message, not a turn', () => {
  const closed = {
    bucket: 'respond',
    updatedAt: '2026-11-01T12:00:00.000Z',
    lastMessage: { occurredAt: '2026-11-04T12:00:00.000Z' },
  };
  const time = turnCardTime(closed, card('2026-11-06T10:00:00', false));
  assert.deepEqual(time, {
    label: 'quando(2026-11-04T12:00:00.000Z)',
    spoken: 'Última mensagem em quando(2026-11-04T12:00:00.000Z)',
    title: 'Última mensagem em data(2026-11-04T12:00:00.000Z)',
  });
  // Falls back to updatedAt, then to nothing.
  assert.equal(
    turnCardTime(
      { updatedAt: '2026-11-01T12:00:00.000Z' },
      card('2026-11-06T10:00:00', false),
    )?.label,
    'quando(2026-11-01T12:00:00.000Z)',
  );
  assert.equal(turnCardTime({}, card('2026-11-06T10:00:00', false)), null);
});

const waiting = {
  bucket: 'respond',
  turnSince: at('2026-11-06T10:00:00').toISOString(),
  turnBusinessMinutes: 10,
  turnAsOf: at('2026-11-06T10:10:00').toISOString(),
};

test('Responder counts business minutes and alerts after 15', () => {
  const quiet = turnCardTime(waiting, card('2026-11-06T10:10:00'));
  assert.deepEqual(quiet, {
    label: '10 min',
    spoken: 'Esperando resposta há 10 minutos de expediente',
    title: `Esperando resposta desde data(${waiting.turnSince})`,
    tone: undefined,
  });
  const late = turnCardTime(waiting, card('2026-11-06T10:16:00'));
  assert.equal(late?.label, '16 min');
  assert.equal(
    late?.spoken,
    'Esperando resposta há 16 minutos de expediente. Prazo de 15 minutos excedido',
  );
  assert.equal(late?.tone, 'warning');
  // At exactly 15 there is no alert yet.
  assert.equal(
    turnCardTime(waiting, card('2026-11-06T10:15:00'))?.tone,
    undefined,
  );
});

test('Responder out of hours says so and does not claim a number', () => {
  const night = {
    bucket: 'respond',
    turnSince: at('2026-11-06T19:00:00').toISOString(),
    turnBusinessMinutes: 0,
    turnAsOf: at('2026-11-06T19:00:00').toISOString(),
  };
  const time = turnCardTime(night, card('2026-11-06T21:00:00'));
  assert.equal(time?.label, 'fora do expediente');
  assert.equal(time?.spoken, 'Fora do expediente');
  assert.equal(time?.tone, undefined);
  assert.equal(
    time?.title,
    `Esperando resposta desde data(${night.turnSince})`,
  );
});

test('Aguardando with the agent in its window starts at the customer message', () => {
  const awaiting = {
    bucket: 'awaiting',
    automationState: 'assistant',
    lastMessage: { direction: 'inbound' },
    turnSince: at('2026-11-06T09:00:00').toISOString(),
  };
  assert.deepEqual(turnCardTime(awaiting, card('2026-11-06T10:20:00')), {
    label: '1 h 20',
    spoken: 'Cliente escreveu há 1 hora e 20 minutos; o Agente está atendendo',
    title: `Cliente escreveu em data(${awaiting.turnSince})`,
  });
  // The reference comes from the caller (the brand), never from the lib.
  assert.equal(
    turnCardTime(awaiting, {
      ...card('2026-11-06T10:20:00'),
      assistantReference: brand.assistant.reference,
    })?.spoken,
    `Cliente escreveu há 1 hora e 20 minutos; ${brand.assistant.reference} está atendendo`,
  );
});

test('Aguardando on a human reply, and Sem retorno, count calendar time', () => {
  const human = {
    bucket: 'awaiting',
    automationState: 'human',
    lastMessage: { direction: 'outbound' },
    turnSince: at('2026-11-06T09:00:00').toISOString(),
  };
  assert.deepEqual(turnCardTime(human, card('2026-11-06T09:45:00')), {
    label: '45 min',
    spoken: 'Cliente sem responder há 45 minutos',
    title: `Última resposta em data(${human.turnSince})`,
  });
  // The agent, but the last message is ours: still the human wording.
  assert.equal(
    turnCardTime(
      {
        ...human,
        automationState: 'assistant',
        lastMessage: { direction: 'outbound' },
      },
      card('2026-11-06T09:45:00'),
    )?.spoken,
    'Cliente sem responder há 45 minutos',
  );
  const silent = {
    bucket: 'silent',
    turnSince: at('2026-11-03T09:00:00').toISOString(),
  };
  const time = turnCardTime(silent, card('2026-11-06T09:00:00'));
  assert.equal(time?.label, '3 d');
  assert.equal(time?.spoken, 'Cliente sem responder há 3 dias');
  // No anchor, no clock.
  assert.equal(
    turnCardTime({ bucket: 'silent' }, card('2026-11-06T09:00:00')),
    null,
  );
});

// --- BADGE_RULES ----------------------------------------------------------

const full = {
  automationState: 'human',
  state: 'em_atendimento',
  assignedUser: { id: 'other', name: 'Carlos Lima' },
  lastMessage: { direction: 'inbound' },
  deliveryIssue: { status: 'failed' },
  handoff: { reasonCode: 'urgency', status: 'pending' },
  assistantStalled: true,
  reviewOrder: { status: 'pendente', readyForConfirmation: true },
  lostOutcome: { reasonCode: 'prazo' },
  reminder: { remindAt: '2026-11-10T12:00:00.000Z' },
};
/** @param {string} [bucket] */
const context = (bucket) => ({
  actorId: 'seller-synthetic',
  bucket,
  reminderLabel: () => '10/11 09:00',
});

test('the registry declares each seal once, with unique keys and priorities', () => {
  const keys = BADGE_RULES.map((rule) => rule.key);
  assert.deepEqual(keys, [
    'delivery',
    'claim',
    'urgent',
    'stalled',
    'ready',
    'reminder',
    'owner',
    'lost',
  ]);
  assert.equal(new Set(keys).size, keys.length);
  const priorities = BADGE_RULES.map((rule) => rule.priority);
  assert.deepEqual(
    priorities,
    [...priorities].sort((a, b) => a - b),
  );
  assert.equal(new Set(priorities).size, priorities.length);
  assert.deepEqual(
    BADGE_RULES.filter((rule) => rule.leadsIn).map((rule) => [
      rule.key,
      rule.leadsIn,
    ]),
    [
      ['reminder', ['silent']],
      ['lost', ['lost']],
    ],
  );
  assert.ok(Object.isFrozen(BADGE_RULES));
});

test('seal order per tab: reason leads in Perdidos, reminder in Sem retorno', () => {
  /** @param {string} [bucket] */
  const keys = (bucket) =>
    conversationBadges(full, context(bucket)).map((badge) => badge.key);
  const standard = [
    'delivery',
    'urgent',
    'stalled',
    'ready',
    'reminder',
    'owner',
    'lost',
  ];
  assert.deepEqual(keys('respond'), standard);
  assert.deepEqual(keys('awaiting'), standard);
  assert.deepEqual(keys(undefined), standard);
  assert.deepEqual(keys('silent'), [
    'reminder',
    'delivery',
    'urgent',
    'stalled',
    'ready',
    'owner',
    'lost',
  ]);
  assert.deepEqual(keys('lost'), [
    'lost',
    'delivery',
    'urgent',
    'stalled',
    'ready',
    'reminder',
    'owner',
  ]);
  // Two visible at most; the leader never falls into "+N".
  for (const bucket of ['silent', 'lost']) {
    const { shown, hidden } = splitBadges(
      conversationBadges(full, context(bucket)),
    );
    assert.equal(shown.length, 2);
    assert.equal(hidden.length, 5);
    assert.equal(shown[0].key, bucket === 'lost' ? 'lost' : 'reminder');
  }
});

test('labels and tones are exactly the ones the card has always shown', () => {
  const all = conversationBadges(full, context('respond'));
  assert.deepEqual(
    all.map((badge) => [badge.key, badge.label, badge.tone]),
    [
      ['delivery', 'Falha de envio', 'error'],
      ['urgent', 'Urgente', 'warning'],
      ['stalled', `${brand.assistant.name} parou`, 'warning'],
      ['ready', 'Pedido pronto', 'success'],
      ['reminder', 'Lembrete 10/11 09:00', 'info'],
      ['owner', 'Com Carlos', undefined],
      ['lost', 'Perdido · Prazo', undefined],
    ],
  );
  // A neutral seal carries no tone key at all.
  assert.equal('tone' in all[5], false);
  assert.equal('tone' in all[6], false);
  const uncertain = conversationBadges(
    { lastMessage: { deliveryStatus: 'outcome_unknown' }, assignedUser: null },
    { actorId: 'seller-synthetic' },
  );
  assert.deepEqual(
    uncertain.map((badge) => [badge.key, badge.label, badge.tone]),
    [
      ['delivery', 'Envio incerto', 'warning'],
      ['owner', 'Sem dono', undefined],
    ],
  );
  // The seller's own conversation has no owner seal; no name falls back.
  assert.deepEqual(
    conversationBadges(
      { assignedUser: { id: 'other', name: '   ' } },
      { actorId: 'seller-synthetic' },
    ).map((badge) => badge.label),
    ['Com outro vendedor'],
  );
  assert.deepEqual(
    conversationBadges(
      { assignedUser: { id: 'other', name: 'Carlos Lima' } },
      { actorId: 'seller-synthetic', ownerName: 'Ana Souza Lima' },
    ).map((badge) => badge.label),
    ['Com Ana'],
  );
});
