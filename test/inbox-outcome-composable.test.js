import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { computed, markRaw, nextTick, ref } from 'vue';
import { useInboxOutcome } from '../apps/edge-web/src/components/inbox/useInboxOutcome.js';
import { brand } from '../apps/edge-web/src/brand/index.js';

// INBOX-VEZ-04 (RFC 052, MET-06/07, D9): the loss and its correction, with
// synthetic conversations only. The command runner and the focus are injected;
// the outcome-version read goes through a stubbed `fetch`.

const NOW = new Date('2026-11-08T15:00:00.000Z');
const ACTOR = 'seller-synthetic';

class FakeDialog {
  open = false;
  closed = 0;
  /** @type {Map<string, Set<() => void>>} */
  listeners = new Map();
  addEventListener(/** @type {string} */ type, /** @type {() => void} */ fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(
    /** @type {string} */ type,
    /** @type {() => void} */ fn,
  ) {
    this.listeners.get(type)?.delete(fn);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.closed += 1;
    if (!this.open) return;
    this.open = false;
    for (const fn of [...(this.listeners.get('close') ?? [])]) fn();
  }
  querySelector() {
    return null;
  }
}

const originalDialog = globalThis.HTMLDialogElement;
const originalFetch = globalThis.fetch;
/** @type {Array<{url: string}>} */
let reads = [];
/** @type {(url: string) => {status: number, body: unknown}} */
let readAnswer = () => ({ status: 200, body: { outcomeVersion: 2 } });

beforeEach(() => {
  // @ts-expect-error the composable only needs `instanceof`.
  globalThis.HTMLDialogElement = FakeDialog;
  reads = [];
  readAnswer = () => ({ status: 200, body: { outcomeVersion: 2 } });
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      reads.push({ url });
      const { status, body } = readAnswer(url);
      return new globalThis.Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
  );
});

afterEach(() => {
  globalThis.HTMLDialogElement = originalDialog;
  globalThis.fetch = originalFetch;
});

/** @param {Record<string, any>} [overrides] */
function lostConversation(overrides = {}) {
  return {
    id: 'conversation-synthetic-1',
    version: 7,
    state: 'em_atendimento',
    automationState: 'human',
    assignedUser: { id: ACTOR, name: 'Vendedora Sintética' },
    bucket: 'silent',
    lostOutcome: null,
    order: null,
    ...overrides,
  };
}

/**
 * @param {{
 *   conversation?: Record<string, any>|null,
 *   commandResult?: boolean,
 *   commandError?: string,
 *   refused?: boolean,
 *   actor?: string,
 *   admin?: boolean,
 *   pendingOrder?: boolean,
 * }} [options]
 */
function setup({
  conversation = lostConversation(),
  commandResult = true,
  commandError = '',
  refused = false,
  actor = ACTOR,
  admin = false,
  pendingOrder = false,
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
  const owner = computed(() => active.value?.assignedUser ?? null);
  /** @type {Array<Record<string, any>>} */
  const commands = [];
  /** @type {Array<[any, string|undefined]>} */
  const focused = [];
  /** @type {string[]} */
  const triggerFocus = [];
  const trigger = (/** @type {string} */ name) => ({
    isConnected: true,
    focus: () => triggerFocus.push(name),
  });
  const turnStrip = ref({
    lostTrigger: trigger('lost'),
    reopenTrigger: trigger('reopen'),
  });
  const outcome = useInboxOutcome({
    active,
    activeId,
    busy,
    error,
    isTerminal,
    owner,
    currentUserId: ref(actor),
    isAdmin: ref(admin),
    hasPendingOrder: ref(pendingOrder),
    now: ref(NOW),
    turnStrip,
    async runCommand(path, body, successMessage, keepOpen, targetId) {
      commands.push({ path, body, successMessage, keepOpen, targetId });
      if (!commandResult) error.value = commandError;
      return commandResult;
    },
    wasCommandRefused: () => refused,
    async focusConversationTitle(dialog, conversationId) {
      focused.push([dialog, conversationId]);
      // As the real one does: a dialog still open is closed first.
      dialog?.close();
    },
    listWhen: () => '05/11',
    timeOfDay: () => '09:30',
  });
  const lostDialog = markRaw(new FakeDialog());
  const reopenDialog = markRaw(new FakeDialog());
  outcome.lostDialog.value = lostDialog;
  outcome.reopenDialog.value = reopenDialog;
  // The template wires `@close` to these, as the Inbox does.
  lostDialog.addEventListener('close', outcome.clearLostDialogState);
  reopenDialog.addEventListener('close', outcome.clearReopenDialogState);
  return {
    active,
    activeId,
    busy,
    commands,
    error,
    focused,
    lostDialog,
    outcome,
    reopenDialog,
    triggerFocus,
  };
}

test('blocked reasons: only the owner or an administrator, with a person attending', () => {
  const { outcome, active } = setup();
  assert.equal(outcome.outcomeBlockedReason.value, '');
  assert.equal(outcome.canMarkLost.value, true);
  assert.equal(outcome.canReopenLoss.value, true);

  active.value = lostConversation({ automationState: 'assistant' });
  assert.equal(
    outcome.outcomeBlockedReason.value,
    `Só é possível com atendimento humano; ${brand.assistant.reference} ainda atende.`,
  );
  assert.equal(outcome.canMarkLost.value, false);

  active.value = lostConversation({ assignedUser: null });
  assert.equal(
    outcome.outcomeBlockedReason.value,
    'Assuma a conversa para marcar ou corrigir a perda.',
  );

  active.value = lostConversation({ assignedUser: { id: 'someone-else' } });
  assert.equal(
    outcome.outcomeBlockedReason.value,
    'Só quem atende a conversa ou um administrador pode marcar ou corrigir a perda.',
  );
  assert.equal(outcome.canReopenLoss.value, false);

  active.value = lostConversation({ state: 'encerrada' });
  assert.equal(outcome.outcomeBlockedReason.value, '');
  assert.equal(outcome.canMarkLost.value, false);
  assert.equal(outcome.canReopenLoss.value, false);
});

test('blocked reasons: an administrator may act on another seller, and an order in progress blocks only the loss', () => {
  const { outcome, active } = setup({ admin: true });
  active.value = lostConversation({ assignedUser: { id: 'someone-else' } });
  assert.equal(outcome.outcomeBlockedReason.value, '');
  assert.equal(outcome.canMarkLost.value, true);

  active.value = lostConversation({ order: { status: 'confirmado' } });
  assert.equal(
    outcome.lossBlockedReason.value,
    'Há pedido em aberto; encerre ou cancele o pedido antes de marcar como perdida.',
  );
  assert.equal(outcome.canMarkLost.value, false);
  assert.equal(outcome.canReopenLoss.value, true);

  const pending = setup({ pendingOrder: true });
  assert.match(
    pending.outcome.lossBlockedReason.value,
    /^Há pedido em aberto/u,
  );
  assert.equal(pending.outcome.outcomeBlockedReason.value, '');
});

test('lostNotice: reason and day of the loss, only in Perdidos', () => {
  const { outcome, active } = setup();
  assert.equal(outcome.lostNotice.value, null);
  active.value = lostConversation({
    bucket: 'lost',
    lostOutcome: {
      reasonCode: 'preco',
      version: 1,
      occurredAt: '2026-11-08T12:30:00.000Z',
    },
  });
  assert.equal(
    outcome.lostNotice.value,
    'Marcada como perdida · Preço · hoje às 09:30',
  );
  active.value = lostConversation({
    bucket: 'lost',
    lostOutcome: {
      reasonCode: 'desconhecido',
      version: 1,
      occurredAt: '2026-11-05T12:30:00.000Z',
    },
  });
  assert.equal(
    outcome.lostNotice.value,
    'Marcada como perdida · Outro · em 05/11',
  );
});

test('mark lost (happy path): sends the versions frozen on opening, then focuses the title', async () => {
  const { outcome, commands, focused, lostDialog, active, triggerFocus } =
    setup();
  await outcome.openLostDialog();
  assert.equal(lostDialog.open, true);
  assert.deepEqual(
    reads.map((read) => read.url),
    ['/api/v1/conversations/conversation-synthetic-1/lead-outcome'],
  );
  // The list moves on (a live refresh) while the person chooses the reason.
  active.value = { ...active.value, version: 9 };
  outcome.lostReason.value = 'preco';
  await outcome.confirmLost();

  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].body, {
    outcome: 'lost',
    reasonCode: 'preco',
    expectedConversationVersion: 7,
    expectedOutcomeVersion: 2,
  });
  assert.equal(commands[0].path, 'lead-outcome');
  assert.equal(commands[0].keepOpen, true);
  assert.equal(commands[0].targetId, 'conversation-synthetic-1');
  assert.equal(
    commands[0].successMessage,
    'Conversa marcada como perdida. Uma nova mensagem do cliente a devolve para Responder.',
  );
  assert.deepEqual(focused, [[lostDialog, 'conversation-synthetic-1']]);
  assert.equal(lostDialog.open, false);
  // Closing the dialog returns the focus to the trigger, then forgets state.
  assert.deepEqual(triggerFocus, ['lost']);
  assert.equal(outcome.lostReason.value, '');
});

test('mark lost: "Outro" needs the note, which is sent trimmed', async () => {
  const { outcome, commands } = setup();
  await outcome.openLostDialog();
  outcome.lostReason.value = 'outro';
  outcome.lostNote.value = '   ';
  await outcome.confirmLost();
  assert.equal(
    outcome.lostError.value,
    'Descreva o motivo em até 140 caracteres.',
  );
  assert.equal(commands.length, 0);
  outcome.lostNote.value = '  comprou na concorrência  ';
  await outcome.confirmLost();
  assert.deepEqual(commands[0].body, {
    outcome: 'lost',
    reasonCode: 'outro',
    note: 'comprou na concorrência',
    expectedConversationVersion: 7,
    expectedOutcomeVersion: 2,
  });
});

test('mark lost (error): no reason chosen sends nothing', async () => {
  const { outcome, commands } = setup();
  await outcome.openLostDialog();
  await outcome.confirmLost();
  assert.equal(outcome.lostError.value, 'Escolha o motivo da perda.');
  assert.equal(commands.length, 0);
});

test('mark lost uses the outcome version the list already carries and skips the read', async () => {
  const { outcome, commands } = setup({
    conversation: lostConversation({ lostOutcome: { version: 4 } }),
  });
  await outcome.openLostDialog();
  assert.equal(reads.length, 0);
  outcome.lostReason.value = 'prazo';
  await outcome.confirmLost();
  assert.equal(commands[0].body.expectedOutcomeVersion, 4);
});

test('mark lost (error): a failed command is written next to the field, not in the pane', async () => {
  const { outcome, error, focused, lostDialog } = setup({
    commandResult: false,
    commandError: 'Falha de rede. Tente novamente.',
  });
  await outcome.openLostDialog();
  outcome.lostReason.value = 'preco';
  await outcome.confirmLost();
  assert.equal(outcome.lostError.value, 'Falha de rede. Tente novamente.');
  assert.equal(error.value, '');
  assert.deepEqual(focused, []);
  assert.equal(lostDialog.open, true);
});

test('mark lost (version conflict): a refusal closes the dialog and focuses the title', async () => {
  const { outcome, focused, lostDialog, error } = setup({
    commandResult: false,
    commandError: 'A conversa mudou. Atualize e tente de novo.',
    refused: true,
  });
  await outcome.openLostDialog();
  outcome.lostReason.value = 'preco';
  await outcome.confirmLost();
  assert.deepEqual(focused, [[lostDialog, 'conversation-synthetic-1']]);
  assert.equal(lostDialog.open, false);
  // The reason stays in the pane (set by the runner), not in the dialog.
  assert.equal(error.value, 'A conversa mudou. Atualize e tente de novo.');
  assert.equal(outcome.lostError.value, '');
});

test('mark lost (version conflict): an unreadable outcome version blocks the command', async () => {
  readAnswer = () => ({ status: 500, body: { error: 'boom' } });
  const { outcome, commands, busy } = setup();
  await outcome.openLostDialog();
  outcome.lostReason.value = 'preco';
  await outcome.confirmLost();
  assert.equal(commands.length, 0);
  assert.equal(
    outcome.lostError.value,
    'Não foi possível conferir a conversa agora. Tente novamente.',
  );
  assert.equal(busy.value, false);

  // The owner tries again once the read works: it is read again, then sent.
  readAnswer = () => ({ status: 200, body: { outcomeVersion: 3 } });
  await outcome.confirmLost();
  assert.equal(commands[0].body.expectedOutcomeVersion, 3);
});

test('mark lost: nothing is sent for a conversation that is no longer on screen', async () => {
  const { outcome, commands, activeId, active, lostDialog } = setup();
  await outcome.openLostDialog();
  outcome.lostReason.value = 'preco';
  // The selection moved without the watcher having run yet.
  active.value = lostConversation({ id: 'conversation-synthetic-2' });
  await outcome.confirmLost();
  assert.equal(commands.length, 0);
  assert.equal(lostDialog.closed, 1);
  activeId.value = 'conversation-synthetic-2';
  await nextTick();
  assert.equal(outcome.lostReason.value, '');
});

test('mark lost: does not open when blocked or without a dialog', async () => {
  const blocked = setup({
    conversation: lostConversation({ assignedUser: null }),
  });
  await blocked.outcome.openLostDialog();
  assert.equal(blocked.lostDialog.open, false);

  const missing = setup();
  missing.outcome.lostDialog.value = null;
  await missing.outcome.openLostDialog();
  assert.equal(reads.length, 0);
});

test('a different conversation voids both dialogs and what was typed', async () => {
  const { outcome, activeId, lostDialog, reopenDialog, active } = setup({
    conversation: lostConversation({
      bucket: 'lost',
      lostOutcome: { version: 1, reasonCode: 'preco', occurredAt: null },
    }),
  });
  await outcome.openLostDialog();
  outcome.lostReason.value = 'preco';
  outcome.lostNote.value = 'x';
  outcome.openReopenDialog();
  assert.equal(reopenDialog.open, true);
  activeId.value = 'conversation-synthetic-2';
  active.value = lostConversation({ id: 'conversation-synthetic-2' });
  await nextTick();
  assert.equal(lostDialog.open, false);
  assert.equal(reopenDialog.open, false);
  assert.equal(outcome.lostReason.value, '');
  assert.equal(outcome.lostNote.value, '');
});

/** A conversation in Perdidos, as the detail carries it. */
function inLost(version = 3) {
  return lostConversation({
    bucket: 'lost',
    lostOutcome: {
      version,
      reasonCode: 'preco',
      occurredAt: '2026-11-08T12:30:00.000Z',
    },
  });
}

test('reopen (happy path): asks once, sends the frozen versions and focuses the title', async () => {
  const { outcome, commands, focused, reopenDialog, active } = setup({
    conversation: inLost(3),
  });
  outcome.openReopenDialog();
  assert.equal(reopenDialog.open, true);
  active.value = { ...active.value, version: 12 };
  await outcome.confirmReopen();
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].body, {
    outcome: 'reopened',
    expectedConversationVersion: 7,
    expectedOutcomeVersion: 3,
  });
  assert.equal(commands[0].path, 'lead-outcome');
  assert.equal(commands[0].keepOpen, true);
  assert.equal(commands[0].targetId, 'conversation-synthetic-1');
  assert.equal(
    commands[0].successMessage,
    'Conversa reaberta. Ela volta para a aba da vez.',
  );
  assert.deepEqual(focused, [[reopenDialog, 'conversation-synthetic-1']]);
});

test('reopen: an outcome without a version counts as the first one', async () => {
  const { outcome, commands } = setup({
    conversation: lostConversation({
      bucket: 'lost',
      lostOutcome: { reasonCode: 'preco' },
    }),
  });
  outcome.openReopenDialog();
  await outcome.confirmReopen();
  assert.equal(commands[0].body.expectedOutcomeVersion, 1);
});

test('reopen (error): the message shows inside the dialog, which stays open', async () => {
  const { outcome, reopenDialog, error, focused } = setup({
    conversation: inLost(),
    commandResult: false,
    commandError: 'Falha de rede. Tente novamente.',
  });
  outcome.openReopenDialog();
  await outcome.confirmReopen();
  assert.equal(outcome.reopenError.value, 'Falha de rede. Tente novamente.');
  assert.equal(error.value, '');
  assert.equal(reopenDialog.open, true);
  assert.deepEqual(focused, []);
});

test('reopen (version conflict): a refusal closes the dialog and focuses the title', async () => {
  const { outcome, reopenDialog, focused, error } = setup({
    conversation: inLost(),
    commandResult: false,
    commandError: 'A perda mudou. Atualize e tente de novo.',
    refused: true,
  });
  outcome.openReopenDialog();
  await outcome.confirmReopen();
  assert.deepEqual(focused, [[reopenDialog, 'conversation-synthetic-1']]);
  assert.equal(reopenDialog.open, false);
  assert.equal(error.value, 'A perda mudou. Atualize e tente de novo.');
  assert.equal(outcome.reopenError.value, '');
});

test('reopen: nothing is sent for another conversation, and it does not open without a loss, when blocked or busy', async () => {
  const moved = setup({ conversation: inLost() });
  moved.outcome.openReopenDialog();
  moved.active.value = lostConversation({ id: 'conversation-synthetic-2' });
  await moved.outcome.confirmReopen();
  assert.equal(moved.commands.length, 0);
  assert.equal(moved.reopenDialog.closed, 1);

  const noLoss = setup();
  noLoss.outcome.openReopenDialog();
  assert.equal(noLoss.reopenDialog.open, false);

  const blocked = setup({
    conversation: { ...inLost(), assignedUser: { id: 'someone-else' } },
  });
  blocked.outcome.openReopenDialog();
  assert.equal(blocked.reopenDialog.open, false);

  const busy = setup({ conversation: inLost() });
  busy.busy.value = true;
  busy.outcome.openReopenDialog();
  assert.equal(busy.reopenDialog.open, false);
  await busy.outcome.confirmReopen();
  assert.equal(busy.commands.length, 0);
});
