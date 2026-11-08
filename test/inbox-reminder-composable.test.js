import assert from 'node:assert/strict';
import test from 'node:test';
import { computed, nextTick, ref } from 'vue';
import { useInboxReminder } from '../apps/edge-web/src/components/inbox/useInboxReminder.js';
import { REMINDER_RANGE_MESSAGE } from '../apps/edge-web/src/lib/inbox-turn.js';

// INBOX-VEZ-04 (RFC 052, ACT-05): the reminder composable, with synthetic
// conversations only. The command runner and the focus are injected, so the
// tests read what was asked of them.

const NOW = new Date('2026-11-08T15:00:00.000Z');
const SAO_PAULO = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A datetime-local value, São Paulo wall time, `days` from the real now. @param {number} days */
function wallTimeInDays(days) {
  return SAO_PAULO.format(new Date(Date.now() + days * 86_400_000)).replace(
    ' ',
    'T',
  );
}

/** @param {Record<string, any>} [overrides] */
function silentConversation(overrides = {}) {
  return {
    id: 'conversation-synthetic-1',
    version: 7,
    state: 'em_atendimento',
    bucket: 'silent',
    turnSince: '2026-11-04T15:00:00.000Z',
    reminder: null,
    ...overrides,
  };
}

/**
 * @param {{
 *   conversation?: Record<string, any>|null,
 *   commandResult?: boolean|undefined,
 *   commandError?: string,
 * }} [options]
 */
function setup({
  conversation = silentConversation(),
  commandResult = true,
  commandError = '',
} = {}) {
  const active = ref(conversation);
  const activeId = ref(conversation?.id ?? '');
  const busy = ref(false);
  const error = ref('');
  const isTerminal = computed(() =>
    ['convertida_em_lead', 'sem_lead', 'encerrada'].includes(
      active.value?.state,
    ),
  );
  /** @type {Array<Record<string, any>>} */
  const commands = [];
  /** @type {Array<[HTMLDialogElement|null|undefined, string|undefined]>} */
  const focused = [];
  /** @type {string[]} */
  const focusLog = [];
  const input = { focus: () => focusLog.push('input') };
  const toggle = { focus: () => focusLog.push('toggle') };
  const turnStrip = ref({ reminderInput: input, snoozeToggle: toggle });
  const reminder = useInboxReminder({
    active,
    activeId,
    busy,
    error,
    isTerminal,
    now: ref(NOW),
    turnStrip,
    async runCommand(path, body, successMessage, keepOpen, targetId) {
      commands.push({ path, body, successMessage, keepOpen, targetId });
      if (!commandResult) error.value = commandError;
      return commandResult;
    },
    async focusConversationTitle(dialog, conversationId) {
      focused.push([dialog, conversationId]);
    },
  });
  return {
    active,
    activeId,
    busy,
    commands,
    error,
    focusLog,
    focused,
    reminder,
  };
}

test('silentNotice: says how long the customer is silent and shows the reminder', () => {
  const { reminder, active } = setup({
    conversation: silentConversation({
      reminder: { remindAt: '2026-11-09T18:00:00.000Z', mine: true },
    }),
  });
  assert.equal(
    reminder.silentNotice.value?.text,
    'Cliente sem responder há 4 dias.',
  );
  assert.match(
    reminder.silentNotice.value?.reminder ?? '',
    /^Lembrete para 09\/11,? 15:00\.$/u,
  );
  active.value = silentConversation({ turnSince: null });
  assert.equal(
    reminder.silentNotice.value?.text,
    'Cliente sem responder há mais de 72 horas.',
  );
  assert.equal(reminder.silentNotice.value?.reminder, '');
});

test('silentNotice: only for Sem retorno on an open conversation', () => {
  const { reminder, active } = setup();
  assert.ok(reminder.silentNotice.value);
  active.value = silentConversation({ bucket: 'awaiting' });
  assert.equal(reminder.silentNotice.value, null);
  active.value = silentConversation({ state: 'encerrada' });
  assert.equal(reminder.silentNotice.value, null);
  active.value = null;
  assert.equal(reminder.silentNotice.value, null);
});

test('reminderBounds: from now up to 90 days ahead, São Paulo wall time', () => {
  const { reminder } = setup();
  assert.equal(reminder.reminderBounds.value.min, '2026-11-08T12:00');
  assert.equal(reminder.reminderBounds.value.max, '2027-02-06T11:59');
});

test('toggleSnooze: opens with the default time and focuses the field, then closes back to the button', async () => {
  const { reminder, focusLog } = setup();
  await reminder.toggleSnooze();
  assert.equal(reminder.snoozeOpen.value, true);
  // 15:00 of today (São Paulo) is still ahead of `now`, so it is the default.
  assert.equal(reminder.reminderAt.value, '2026-11-08T15:00');
  assert.deepEqual(focusLog, ['input']);
  await reminder.toggleSnooze();
  assert.equal(reminder.snoozeOpen.value, false);
  assert.equal(reminder.reminderError.value, '');
  assert.deepEqual(focusLog, ['input', 'toggle']);
});

test('saveReminder (happy path): sends the instant and version, keeps the conversation open and focuses its title', async () => {
  const { reminder, commands, focused } = setup();
  await reminder.toggleSnooze();
  reminder.reminderAt.value = wallTimeInDays(2);
  await reminder.saveReminder();
  assert.equal(commands.length, 1);
  const [command] = commands;
  assert.equal(command.path, 'reminder');
  assert.equal(command.body.expectedVersion, 7);
  assert.match(command.body.remindAt, /^\d{4}-\d{2}-\d{2}T.+Z$/u);
  assert.match(
    command.successMessage,
    /^Lembrete salvo para .+\. Nada foi enviado ao cliente\.$/u,
  );
  assert.equal(command.keepOpen, true);
  assert.equal(reminder.snoozeOpen.value, false);
  assert.equal(reminder.reminderAt.value, '');
  assert.deepEqual(focused, [[null, 'conversation-synthetic-1']]);
});

test('saveReminder (error): a time in the past or beyond 90 days never reaches the API', async () => {
  const { reminder, commands, focusLog } = setup();
  await reminder.toggleSnooze();
  for (const value of [wallTimeInDays(-1), wallTimeInDays(120), '']) {
    focusLog.length = 0;
    reminder.reminderAt.value = value;
    await reminder.saveReminder();
    assert.equal(reminder.reminderError.value, REMINDER_RANGE_MESSAGE);
    assert.deepEqual(focusLog, ['input']);
  }
  assert.equal(commands.length, 0);
  assert.equal(reminder.snoozeOpen.value, true);
});

test('saveReminder (error): the refusal is written next to the field and the focus stays in it', async () => {
  const { reminder, commands, error, focusLog, focused } = setup({
    commandResult: false,
    commandError: 'A conversa mudou. Atualize e tente de novo.',
  });
  await reminder.toggleSnooze();
  focusLog.length = 0;
  reminder.reminderAt.value = wallTimeInDays(2);
  await reminder.saveReminder();
  assert.equal(commands.length, 1);
  assert.equal(
    reminder.reminderError.value,
    'A conversa mudou. Atualize e tente de novo.',
  );
  assert.equal(error.value, '');
  assert.equal(reminder.snoozeOpen.value, true);
  assert.deepEqual(focusLog, ['input']);
  assert.deepEqual(focused, []);
});

test('saveReminder (version conflict): a conversation that left Sem retorno keeps the refusal in the pane', async () => {
  const { reminder, active, error, focusLog } = setup({
    commandResult: false,
    commandError: 'A conversa mudou.',
  });
  await reminder.toggleSnooze();
  focusLog.length = 0;
  reminder.reminderAt.value = wallTimeInDays(2);
  // The refusal came with a refreshed detail: the conversation is in another tab.
  const original = active.value;
  const refusing = reminder.saveReminder();
  active.value = { ...original, bucket: 'respond', version: 8 };
  await refusing;
  assert.equal(error.value, 'A conversa mudou.');
  assert.equal(reminder.reminderError.value, '');
  assert.deepEqual(focusLog, []);
});

test('saveReminder: sends the version of the conversation on screen and nothing while busy', async () => {
  const { reminder, commands, active, busy } = setup();
  await reminder.toggleSnooze();
  reminder.reminderAt.value = wallTimeInDays(2);
  busy.value = true;
  await reminder.saveReminder();
  assert.equal(commands.length, 0);
  busy.value = false;
  active.value = silentConversation({ version: 11 });
  await reminder.saveReminder();
  assert.equal(commands[0].body.expectedVersion, 11);
  active.value = null;
  await reminder.saveReminder();
  assert.equal(commands.length, 1);
});

test('a different conversation voids the open form', async () => {
  const { reminder, activeId } = setup();
  await reminder.toggleSnooze();
  reminder.reminderAt.value = wallTimeInDays(2);
  reminder.reminderError.value = 'algo';
  activeId.value = 'conversation-synthetic-2';
  await nextTick();
  assert.equal(reminder.snoozeOpen.value, false);
  assert.equal(reminder.reminderAt.value, '');
  assert.equal(reminder.reminderError.value, '');
});
