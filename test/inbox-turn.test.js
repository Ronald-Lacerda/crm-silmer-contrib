import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INBOX_BUCKETS,
  businessMinutesBetween,
  conversationBadges,
  isBusinessTime,
  listMatchesBucket,
  lossReasonLabel,
  minutesSince,
  LOSS_FORBIDDEN,
  bucketForRoute,
  ownerForRoute,
  REMINDER_MAX_DAYS,
  previewAuthor,
  reminderInRange,
  splitBadges,
  turnClock,
  turnCommandError,
  turnSpan,
} from '../apps/edge-web/src/lib/inbox-turn.js';

// RFC 052 (INBOX-VEZ-02): synthetic conversations only.
const ACTOR = 'seller-synthetic';
const base = {
  automationState: 'human',
  state: 'em_atendimento',
  assignedUser: { id: ACTOR, name: 'Vendedora Sintética' },
  lastMessage: { direction: 'inbound' },
};

test('four tabs, in the order of whose turn it is, with stable URL names', () => {
  assert.deepEqual(
    INBOX_BUCKETS.map((item) => [item.value, item.route, item.label]),
    [
      ['respond', 'responder', 'Responder'],
      ['awaiting', 'aguardando', 'Aguardando'],
      ['silent', 'sem-retorno', 'Sem retorno'],
      ['lost', 'perdidos', 'Perdidos'],
    ],
  );
  assert.equal(INBOX_BUCKETS[1].name, 'Aguardando cliente');
});

test('a span reads short on screen and in full for a screen reader', () => {
  assert.deepEqual(turnSpan(0), { label: '0 min', spoken: '0 minutos' });
  assert.deepEqual(turnSpan(8), { label: '8 min', spoken: '8 minutos' });
  assert.deepEqual(turnSpan(60), { label: '1 h', spoken: '1 hora' });
  assert.deepEqual(turnSpan(80), {
    label: '1 h 20',
    spoken: '1 hora e 20 minutos',
  });
  assert.deepEqual(turnSpan(125), {
    label: '2 h 05',
    spoken: '2 horas e 5 minutos',
  });
  assert.deepEqual(turnSpan(2 * 1440 + 30), { label: '2 d', spoken: '2 dias' });
  assert.equal(turnSpan(-5).label, '0 min');
});

test('calendar minutes since a turn began; unknown stays unknown', () => {
  const now = new Date('2026-11-06T17:30:00.000Z');
  assert.equal(minutesSince('2026-11-06T17:00:00.000Z', now), 30);
  assert.equal(minutesSince(null, now), null);
  assert.equal(minutesSince('not a date', now), null);
});

test('the preview names who spoke last for the team', () => {
  assert.equal(previewAuthor({ direction: 'inbound' }), '');
  assert.equal(
    previewAuthor({ direction: 'outbound', authorKind: 'human' }),
    'Você: ',
  );
  assert.equal(
    previewAuthor({ direction: 'outbound', authorKind: 'assistant' }),
    'Agente: ',
  );
});

test('seals keep the priority order and never invent an owner or a loss', () => {
  const all = conversationBadges(
    {
      ...base,
      assignedUser: { id: 'other', name: 'Carlos Lima' },
      deliveryIssue: { status: 'failed' },
      handoff: { reasonCode: 'urgency', status: 'pending' },
      assistantStalled: true,
      reviewOrder: { status: 'pendente', readyForConfirmation: true },
      lostOutcome: { reasonCode: 'prazo' },
      reminder: { remindAt: '2026-11-10T12:00:00.000Z' },
    },
    { actorId: ACTOR, reminderLabel: () => '10/11 09:00' },
  );
  assert.deepEqual(
    all.map((badge) => [badge.label, badge.tone]),
    [
      ['Falha de envio', 'error'],
      ['Urgente', 'warning'],
      ['Agente parou', 'warning'],
      ['Pedido pronto', 'success'],
      ['Lembrete 10/11 09:00', 'info'],
      ['Com Carlos', undefined],
      ['Perdido · Prazo', undefined],
    ],
  );
  assert.deepEqual(
    conversationBadges(
      { ...base, lastMessage: { deliveryStatus: 'outcome_unknown' } },
      { actorId: ACTOR },
    ).map((badge) => badge.label),
    ['Envio incerto'],
  );
  assert.deepEqual(conversationBadges(base, { actorId: ACTOR }), []);
  assert.deepEqual(
    conversationBadges({ ...base, assignedUser: null }, { actorId: ACTOR }).map(
      (badge) => badge.label,
    ),
    ['Sem dono'],
  );
  assert.deepEqual(
    conversationBadges(
      { ...base, assignedUser: null, automationState: 'assistant' },
      { actorId: ACTOR },
    ),
    [],
  );
});

test('loss reasons follow the closed MET-06 list', () => {
  assert.equal(lossReasonLabel('silencio'), 'Silêncio do cliente');
  assert.equal(lossReasonLabel('indisponivel'), 'Indisponível');
  assert.equal(lossReasonLabel('unknown'), 'Outro');
});

// RFC 052 rodada 2: expediente-v1 projected on the client (Sao Paulo, UTC-3).
/** @param {string} iso */
const at = (iso) => new Date(`${iso}-03:00`);
// 2026-11-06 is a Friday, 2026-11-07 Saturday, 2026-11-09 Monday.

test('business time: weekdays 09-12 and 13-18, never lunch, night or weekend', () => {
  assert.equal(isBusinessTime(at('2026-11-06T09:00:00')), true);
  assert.equal(isBusinessTime(at('2026-11-06T11:59:59')), true);
  assert.equal(isBusinessTime(at('2026-11-06T12:00:00')), false);
  assert.equal(isBusinessTime(at('2026-11-06T12:30:00')), false);
  assert.equal(isBusinessTime(at('2026-11-06T13:00:00')), true);
  assert.equal(isBusinessTime(at('2026-11-06T17:59:59')), true);
  assert.equal(isBusinessTime(at('2026-11-06T18:00:00')), false);
  assert.equal(isBusinessTime(at('2026-11-06T08:59:59')), false);
  assert.equal(isBusinessTime(at('2026-11-07T10:00:00')), false);
  assert.equal(isBusinessTime(at('2026-11-08T10:00:00')), false);
  assert.equal(isBusinessTime(new Date('nope')), false);
});

test('business minutes stop at lunch, at night and on the weekend', () => {
  /** @param {string} a @param {string} b */
  const between = (a, b) => businessMinutesBetween(at(a), at(b));
  assert.equal(between('2026-11-06T10:00:00', '2026-11-06T10:15:00'), 15);
  assert.equal(between('2026-11-06T11:50:00', '2026-11-06T13:10:00'), 20);
  assert.equal(between('2026-11-06T12:00:00', '2026-11-06T13:00:00'), 0);
  assert.equal(between('2026-11-06T17:50:00', '2026-11-06T23:00:00'), 10);
  assert.equal(between('2026-11-06T18:00:00', '2026-11-09T09:00:00'), 0);
  // Friday 17:50 to Monday 09:10: 10 + 10 minutes.
  assert.equal(between('2026-11-06T17:50:00', '2026-11-09T09:10:00'), 20);
  // A full business week is 2400 minutes.
  assert.equal(between('2026-11-02T00:00:00', '2026-11-09T00:00:00'), 2400);
  // Rounds down like the server's integer, seconds included.
  assert.equal(between('2026-11-06T10:00:00', '2026-11-06T10:00:59'), 0);
  assert.equal(between('2026-11-06T10:00:30', '2026-11-06T10:02:00'), 1);
  // Accepts ISO strings (UTC) as the API sends them.
  assert.equal(
    businessMinutesBetween(
      '2026-11-06T13:00:00.000Z',
      at('2026-11-06T10:30:00'),
    ),
    30,
  );
});

test('business minutes: inverted, equal or invalid input is zero', () => {
  const now = at('2026-11-06T10:30:00');
  assert.equal(businessMinutesBetween(at('2026-11-06T11:00:00'), now), 0);
  assert.equal(businessMinutesBetween(now, now), 0);
  assert.equal(businessMinutesBetween('not a date', now), 0);
  assert.equal(businessMinutesBetween(/** @type {any} */ (null), now), 0);
  assert.equal(businessMinutesBetween(/** @type {any} */ (undefined), now), 0);
  assert.equal(businessMinutesBetween(now, new Date('nope')), 0);
});

const respond = {
  bucket: 'respond',
  turnSince: '2026-11-06T13:00:00.000Z', // 10:00 in Sao Paulo
  turnBusinessMinutes: 15,
  turnAsOf: '2026-11-06T13:15:00.000Z', // 10:15
};

test('the alert flips after 15 business minutes, with no new API answer', () => {
  const at15 = turnClock(respond, at('2026-11-06T10:15:00'));
  assert.equal(at15.businessMinutes, 15);
  assert.equal(at15.alert, false);
  assert.equal(at15.label, '15 min');
  assert.equal(at15.spoken, '15 minutos de expediente');
  assert.equal(at15.offHours, false);
  const at16 = turnClock(respond, at('2026-11-06T10:16:00'));
  assert.equal(at16.businessMinutes, 16);
  assert.equal(at16.alert, true);
  assert.equal(at16.label, '16 min');
});

test('the clock advances between two ticks from the same server anchor', () => {
  const first = turnClock(respond, at('2026-11-06T10:20:00'));
  const later = turnClock(respond, at('2026-11-06T11:15:00'));
  assert.equal(first.businessMinutes, 20);
  assert.equal(later.businessMinutes, 75);
  assert.equal(later.label, '1 h 15');
  assert.equal(later.spoken, '1 hora e 15 minutos de expediente');
  assert.equal(later.alert, true);
});

test('the projection stops at lunch, at night and on the weekend', () => {
  // Anchor 10:15 with 15 minutes: 105 more until noon.
  assert.equal(
    turnClock(respond, at('2026-11-06T12:40:00')).businessMinutes,
    15 + 105,
  );
  assert.equal(
    turnClock(respond, at('2026-11-06T13:30:00')).businessMinutes,
    15 + 105 + 30,
  );
  const night = turnClock(respond, at('2026-11-06T22:00:00'));
  const weekend = turnClock(respond, at('2026-11-08T15:00:00'));
  assert.equal(night.businessMinutes, 15 + 105 + 300);
  assert.equal(weekend.businessMinutes, night.businessMinutes);
});

test('Friday 17:50 to Monday 09:10 counts 20 business minutes', () => {
  const friday = {
    bucket: 'respond',
    turnSince: at('2026-11-06T17:50:00').toISOString(),
    turnBusinessMinutes: 0,
    turnAsOf: at('2026-11-06T17:50:00').toISOString(),
  };
  const clock = turnClock(friday, at('2026-11-09T09:10:00'));
  assert.equal(clock.businessMinutes, 20);
  assert.equal(clock.alert, true);
  // 63 calendar hours: D4 shows calendar days, the alert stays on.
  assert.equal(clock.label, '2 d');
  // Thursday 17:50 to Friday 09:10 is under 24 h: business time is shown.
  const thursday = {
    ...friday,
    turnSince: at('2026-11-05T17:50:00').toISOString(),
    turnAsOf: at('2026-11-05T17:50:00').toISOString(),
  };
  const overnight = turnClock(thursday, at('2026-11-06T09:10:00'));
  assert.equal(overnight.businessMinutes, 20);
  assert.equal(overnight.label, '20 min');
  assert.equal(overnight.spoken, '20 minutos de expediente');
});

test('"fora do expediente" only for 0 minutes outside business hours', () => {
  /** @param {string} iso @param {number} [minutes] */
  const anchored = (iso, minutes = 0) => ({
    bucket: 'respond',
    turnSince: at(iso).toISOString(),
    turnBusinessMinutes: minutes,
    turnAsOf: at(iso).toISOString(),
  });
  const night = turnClock(
    anchored('2026-11-06T19:00:00'),
    at('2026-11-06T21:00:00'),
  );
  assert.equal(night.offHours, true);
  assert.equal(night.label, 'fora do expediente');
  assert.equal(night.spoken, 'fora do expediente');
  assert.equal(night.alert, false);
  // 0 minutes inside business hours stays "0 min".
  const open = turnClock(
    anchored('2026-11-06T10:00:00'),
    at('2026-11-06T10:00:20'),
  );
  assert.equal(open.offHours, false);
  assert.equal(open.label, '0 min');
  // Minutes above 0 outside business hours keep the number.
  const waited = turnClock(
    anchored('2026-11-06T17:55:00', 3),
    at('2026-11-06T20:00:00'),
  );
  assert.equal(waited.offHours, false);
  assert.equal(waited.businessMinutes, 8);
  assert.equal(waited.label, '8 min');
  // Other tabs never say it.
  const awaiting = turnClock(
    { ...anchored('2026-11-06T19:00:00'), bucket: 'awaiting' },
    at('2026-11-06T21:00:00'),
  );
  assert.equal(awaiting.offHours, false);
});

test('beyond 24 calendar hours it shows calendar days and keeps the alert', () => {
  const stale = {
    bucket: 'respond',
    turnSince: at('2026-11-04T10:00:00').toISOString(),
    turnBusinessMinutes: 600,
    turnAsOf: at('2026-11-06T10:00:00').toISOString(),
  };
  const clock = turnClock(stale, at('2026-11-06T10:00:00'));
  assert.equal(clock.label, '2 d');
  assert.equal(clock.spoken, '2 dias');
  assert.equal(clock.alert, true);
  assert.equal(clock.offHours, false);
  assert.equal(clock.businessMinutes, 600);
  // Just under 24 h keeps business time.
  const recent = turnClock(
    { ...stale, turnSince: at('2026-11-05T10:30:00').toISOString() },
    at('2026-11-06T10:00:00'),
  );
  assert.equal(recent.label, '10 h');
});

test('outside Responder, or without the API fields, the clock is calendar time', () => {
  const awaiting = turnClock(
    {
      bucket: 'awaiting',
      turnSince: '2026-11-06T12:00:00.000Z',
      turnBusinessMinutes: 40,
    },
    new Date('2026-11-06T13:20:00.000Z'),
  );
  assert.equal(awaiting.businessMinutes, null);
  assert.equal(awaiting.calendarMinutes, 80);
  assert.equal(awaiting.label, '1 h 20');
  assert.equal(awaiting.spoken, '1 hora e 20 minutos');
  assert.equal(awaiting.alert, false);
  const old = turnClock(
    { bucket: 'respond', turnSince: '2026-11-06T12:00:00.000Z' },
    new Date('2026-11-06T12:30:00.000Z'),
  );
  assert.equal(old.businessMinutes, null);
  assert.equal(old.alert, false);
  assert.equal(old.label, '30 min');
  const unknown = turnClock({ bucket: 'silent' }, new Date());
  assert.equal(unknown.calendarMinutes, null);
  assert.equal(unknown.label, '');
  // A missing anchor projects no delta.
  assert.equal(
    turnClock({ ...respond, turnAsOf: undefined }, at('2026-11-06T12:00:00'))
      .businessMinutes,
    15,
  );
});

const crowded = {
  ...base,
  assignedUser: { id: 'other', name: 'Carlos Lima' },
  deliveryIssue: { status: 'failed' },
  handoff: { reasonCode: 'urgency', status: 'pending' },
  assistantStalled: true,
  reviewOrder: { status: 'pendente', readyForConfirmation: true },
  lostOutcome: { reasonCode: 'prazo' },
  reminder: { remindAt: '2026-11-10T12:00:00.000Z' },
};
/** @param {string} bucket */
const ctx = (bucket) => ({
  actorId: ACTOR,
  bucket,
  reminderLabel: () => '10/11 09:00',
});

test('Perdidos always shows the loss reason first, even among many seals', () => {
  const lost = conversationBadges(crowded, ctx('lost'));
  assert.equal(lost[0].key, 'lost');
  assert.equal(lost[0].label, 'Perdido · Prazo');
  const { shown, hidden } = splitBadges(lost);
  assert.equal(shown[0].key, 'lost');
  assert.equal(shown.length, 2);
  assert.equal(hidden.length, lost.length - 2);
  assert.equal(lost.length, 7);
  for (const badge of lost) assert.equal('title' in badge, false);
});

test('Sem retorno always shows the reminder, Responder keeps the default order', () => {
  const silent = conversationBadges(crowded, ctx('silent'));
  assert.equal(silent[0].key, 'reminder');
  assert.equal(splitBadges(silent).shown[0].key, 'reminder');
  /** @param {string} bucket */
  const keys = (bucket) =>
    conversationBadges(crowded, ctx(bucket)).map((badge) => badge.key);
  assert.deepEqual(keys('respond'), [
    'delivery',
    'urgent',
    'stalled',
    'ready',
    'reminder',
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
  // Without a reminder label helper the seal still appears.
  assert.equal(
    conversationBadges(crowded, { actorId: ACTOR, bucket: 'silent' })[0].label,
    'Lembrete',
  );
});

test('"Assumir" shows for a pending transfer without owner and not otherwise', () => {
  const pending = {
    ...base,
    assignedUser: null,
    handoff: { status: 'pending' },
  };
  const claim = conversationBadges(pending, ctx('respond'));
  assert.deepEqual(
    claim.map((badge) => [badge.key, badge.label, badge.tone]),
    [
      ['claim', 'Assumir', 'warning'],
      ['owner', 'Sem dono', undefined],
    ],
  );
  /** @param {Record<string, any>} conversation */
  const hasClaim = (conversation) =>
    conversationBadges(conversation, ctx('respond')).some(
      (badge) => badge.key === 'claim',
    );
  assert.equal(
    hasClaim({
      ...pending,
      assignedUser: { id: 'other', name: 'Carlos Lima' },
    }),
    false,
  );
  assert.equal(
    hasClaim({ ...pending, assignedUser: { id: ACTOR, name: 'Eu' } }),
    false,
  );
  assert.equal(
    hasClaim({ ...pending, handoff: { status: 'accepted' } }),
    false,
  );
  assert.equal(hasClaim({ ...pending, handoff: null }), false);
  // A new conversation without handoff is also waiting to be taken.
  const fresh = { ...base, assignedUser: null, state: 'nova' };
  assert.equal(hasClaim(fresh), true);
  assert.equal(
    hasClaim({ ...fresh, assignedUser: { id: ACTOR, name: 'Eu' } }),
    false,
  );
  assert.equal(hasClaim({ ...fresh, handoff: { status: 'accepted' } }), false);
});

test('split badges keeps two by default and never loses one', () => {
  const list = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
  ];
  assert.deepEqual(splitBadges(list), {
    shown: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ],
    hidden: [{ key: 'c', label: 'C' }],
  });
  assert.deepEqual(splitBadges(list, 5), { shown: list, hidden: [] });
  assert.deepEqual(splitBadges([]), { shown: [], hidden: [] });
});

test('a list matches its tab only when every item carries that bucket', () => {
  assert.equal(listMatchesBucket([], 'respond'), true);
  assert.equal(
    listMatchesBucket(
      [{ bucket: 'respond' }, { bucket: 'respond' }],
      'respond',
    ),
    true,
  );
  assert.equal(listMatchesBucket([{ id: 'old-api' }], 'respond'), false);
  assert.equal(
    listMatchesBucket([{ bucket: 'respond' }, { bucket: 'lost' }], 'respond'),
    false,
  );
  assert.equal(listMatchesBucket([{ bucket: 'silent' }], 'respond'), false);
});

// Contract audit (A4/A5): the words for what the API refuses.
test('the loss and reminder refusals have a text of their own', () => {
  for (const code of [
    'LEAD_HAS_ORDER',
    'LEAD_AWAITING_REPLY',
    'LEAD_NOT_ELIGIBLE',
    'LEAD_ALREADY_LOST',
    'LEAD_NOT_LOST',
    'ACTION_NOT_AVAILABLE',
    'INVALID_LOSS_REASON',
    'INVALID_LOSS_NOTE',
    'INVALID_REMINDER_DATE',
  ])
    assert.notEqual(turnCommandError(code), '', code);
  assert.match(turnCommandError('LEAD_HAS_ORDER'), /encerre ou cancele/u);
  assert.match(turnCommandError('LEAD_AWAITING_REPLY'), /espera resposta/u);
  assert.match(turnCommandError('INVALID_REMINDER_DATE'), /90 dias/u);
  // A code with no text of its own falls back to the status message.
  assert.equal(turnCommandError('VERSION_CONFLICT'), '');
  assert.equal(turnCommandError(undefined), '');
  assert.match(LOSS_FORBIDDEN, /dono da conversa ou um administrador/u);
});

test('a reminder is valid from now up to 90 days ahead', () => {
  const now = new Date('2026-11-06T17:30:00.000Z');
  assert.equal(REMINDER_MAX_DAYS, 90);
  const at = (/** @type {number} */ ms) =>
    new Date(now.getTime() + ms).toISOString();
  assert.equal(reminderInRange(at(-1), now), false);
  assert.equal(reminderInRange(at(0), now), false);
  assert.equal(reminderInRange(at(1), now), true);
  assert.equal(reminderInRange(at(90 * 86_400_000), now), true);
  assert.equal(reminderInRange(at(90 * 86_400_000 + 1), now), false);
  assert.equal(reminderInRange(null, now), false);
  assert.equal(reminderInRange('not a date', now), false);
});

test('route values map through own entries only', () => {
  assert.equal(bucketForRoute('perdidos'), 'lost');
  assert.equal(bucketForRoute('sem-retorno'), 'silent');
  assert.equal(ownerForRoute('minhas'), 'mine');
  assert.equal(ownerForRoute('sem-responsavel'), 'unassigned');
  for (const hostile of [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '',
    undefined,
    null,
    ['perdidos'].toString() + 'x',
  ]) {
    assert.equal(bucketForRoute(hostile), null, String(hostile));
    assert.equal(ownerForRoute(hostile), null, String(hostile));
  }
});
