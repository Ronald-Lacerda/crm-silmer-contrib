import { computed, ref, watch } from 'vue';
import { brand } from '../../brand/index.js';
import { request } from '../../lib/api-client.js';
import { lossReasonLabel } from '../../lib/inbox-turn.js';
import { openDialog } from '../../lib/ui.js';

/**
 * MET-06/07 (RFC 052, INBOX-VEZ-03): declaring a loss ("Marcar perdido") and
 * correcting it ("Corrigir perda", D9) from inside the conversation. This
 * composable owns the dialogs' state, the frozen versions the commands send
 * (conversation and outcome), the refusal handling and the focus afterwards;
 * the Inbox keeps the shared command runner, the tabs and the list.
 *
 * @param {{
 *   active: import('vue').Ref<Record<string, any>|null>,
 *   activeId: import('vue').Ref<string>,
 *   busy: import('vue').Ref<boolean>,
 *   error: import('vue').Ref<string>,
 *   isTerminal: import('vue').Ref<boolean>,
 *   owner: import('vue').Ref<Record<string, any>|null>,
 *   currentUserId: import('vue').Ref<string>,
 *   isAdmin: import('vue').Ref<boolean>,
 *   hasPendingOrder: import('vue').Ref<boolean>,
 *   now: import('vue').Ref<Date>,
 *   turnStrip: import('vue').Ref<any>,
 *   runCommand: (path: string, body: Record<string, unknown>, successMessage: string, keepOpen?: boolean, targetId?: string) => Promise<boolean|undefined>,
 *   wasCommandRefused: () => boolean,
 *   focusConversationTitle: (dialog?: HTMLDialogElement|null, conversationId?: string) => Promise<void>,
 *   listWhen: (value: unknown) => string,
 *   timeOfDay: (date: Date) => string,
 * }} deps
 */
export function useInboxOutcome({
  active,
  activeId,
  busy,
  error,
  isTerminal,
  owner,
  currentUserId,
  isAdmin,
  hasPendingOrder,
  now,
  turnStrip,
  runCommand,
  wasCommandRefused,
  focusConversationTitle,
  listWhen,
  timeOfDay,
}) {
  /** @type {import('vue').Ref<any>} */
  const lostDialog = ref(null);
  /** @type {import('vue').Ref<any>} */
  const reopenDialog = ref(null);
  const lostReason = ref('');
  const lostNote = ref('');
  const lostError = ref('');
  const reopenError = ref('');
  // The turn strip draws the triggers the focus returns to when a dialog closes.
  const lostTrigger = computed(() => turnStrip.value?.lostTrigger ?? null);
  const reopenTrigger = computed(() => turnStrip.value?.reopenTrigger ?? null);

  /**
   * MET-06/07: the API records a loss, or its correction, only for the owner
   * of the conversation or an administrator, and only while a person (not the
   * agent) is attending it. The strip says why instead of failing on click.
   */
  const outcomeBlockedReason = computed(() => {
    const conversation = active.value;
    if (!conversation || isTerminal.value) return '';
    if (conversation.automationState !== 'human')
      return `Só é possível com atendimento humano; ${brand.assistant.reference} ainda atende.`;
    if (!owner.value)
      return 'Assuma a conversa para marcar ou corrigir a perda.';
    if (owner.value.id === currentUserId.value || isAdmin.value) return '';
    return 'Só quem atende a conversa ou um administrador pode marcar ou corrigir a perda.';
  });
  /** Declaring a loss also needs no order in progress (LEAD_HAS_ORDER). */
  const lossBlockedReason = computed(() => {
    if (outcomeBlockedReason.value) return outcomeBlockedReason.value;
    if (!active.value || isTerminal.value) return '';
    if (hasPendingOrder.value || active.value.order?.status === 'confirmado')
      return 'Há pedido em aberto; encerre ou cancele o pedido antes de marcar como perdida.';
    return '';
  });
  const canMarkLost = computed(
    () =>
      Boolean(active.value) && !isTerminal.value && !lossBlockedReason.value,
  );
  const canReopenLoss = computed(
    () =>
      Boolean(active.value) && !isTerminal.value && !outcomeBlockedReason.value,
  );

  /** "Marcada como perdida · motivo · quando", or null. */
  const lostNotice = computed(() => {
    const outcome = active.value?.lostOutcome;
    if (active.value?.bucket !== 'lost' || !outcome) return null;
    const date = new Date(String(outcome.occurredAt ?? ''));
    const when = Number.isNaN(date.getTime())
      ? ''
      : date.toDateString() === now.value.toDateString()
        ? `hoje às ${timeOfDay(date)}`
        : `em ${listWhen(outcome.occurredAt)}`;
    return [
      'Marcada como perdida',
      lossReasonLabel(outcome.reasonCode),
      ...(when ? [when] : []),
    ].join(' · ');
  });

  /**
   * The loss and the reopening act on what the person saw when the dialog
   * opened: conversation, its version and the outcome version are frozen then.
   * A live refresh that moves the selection voids the dialog (see activeId).
   *
   * @type {{id: string, version: number, outcomeVersion: number|null}}
   */
  let lostFrozen = { id: '', version: 0, outcomeVersion: null };
  /** @type {{id: string, version: number, outcomeVersion: number}} */
  let reopenFrozen = { id: '', version: 0, outcomeVersion: 1 };

  /** Closing (or finishing) forgets the frozen values and what was typed. */
  function clearLostDialogState() {
    lostFrozen = { id: '', version: 0, outcomeVersion: null };
    lostReason.value = '';
    lostNote.value = '';
    lostError.value = '';
  }

  function clearReopenDialogState() {
    reopenFrozen = { id: '', version: 0, outcomeVersion: 1 };
    reopenError.value = '';
  }

  /**
   * MET-06: the API wants the version of the latest outcome event of the
   * conversation, which is above zero once a loss was reopened. The list never
   * carries it while the loss is not active, so the owner reads it on opening.
   * The note that the same answer may carry is dropped here, unread.
   *
   * @param {string} conversationId
   * @returns {Promise<number|null>}
   */
  async function readOutcomeVersion(conversationId) {
    try {
      const response = await request(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/lead-outcome`,
      );
      const version = Number(response.data?.outcomeVersion);
      return Number.isSafeInteger(version) && version >= 0 ? version : null;
    } catch {
      return null;
    }
  }

  /** MET-06: a declared loss, with a reason from the closed list. */
  async function openLostDialog() {
    const dialog = lostDialog.value;
    if (
      !(dialog instanceof globalThis.HTMLDialogElement) ||
      !active.value ||
      !canMarkLost.value
    )
      return;
    clearLostDialogState();
    const conversationId = active.value.id;
    lostFrozen = {
      id: conversationId,
      version: active.value.version,
      outcomeVersion: active.value.lostOutcome?.version ?? null,
    };
    openDialog(dialog, /** @type {HTMLElement} */ (lostTrigger.value));
    if (lostFrozen.outcomeVersion === null) {
      const version = await readOutcomeVersion(conversationId);
      if (lostFrozen.id === conversationId) lostFrozen.outcomeVersion = version;
    }
  }

  async function confirmLost() {
    if (!active.value || busy.value) return;
    // The dialog belongs to the conversation it was opened for (a live refresh
    // may have moved the selection): never send its answers to another one.
    const conversationId = lostFrozen.id;
    if (!conversationId || active.value.id !== conversationId) {
      lostDialog.value?.close();
      return;
    }
    const note = lostNote.value.trim();
    if (!lostReason.value) {
      lostError.value = 'Escolha o motivo da perda.';
      return;
    }
    if (lostReason.value === 'outro' && !note) {
      lostError.value = 'Descreva o motivo em até 140 caracteres.';
      return;
    }
    if (lostFrozen.outcomeVersion === null) {
      busy.value = true;
      const version = await readOutcomeVersion(conversationId);
      busy.value = false;
      // The selection may have moved while the version was being read: nothing
      // is sent for a conversation that is no longer the one on screen.
      if (
        lostFrozen.id !== conversationId ||
        active.value?.id !== conversationId
      ) {
        lostDialog.value?.close();
        return;
      }
      if (version === null) {
        lostError.value =
          'Não foi possível conferir a conversa agora. Tente novamente.';
        return;
      }
      lostFrozen.outcomeVersion = version;
    }
    const marked = await runCommand(
      'lead-outcome',
      {
        outcome: 'lost',
        reasonCode: lostReason.value,
        ...(lostReason.value === 'outro' ? { note } : {}),
        expectedConversationVersion: lostFrozen.version,
        expectedOutcomeVersion: lostFrozen.outcomeVersion,
      },
      'Conversa marcada como perdida. Uma nova mensagem do cliente a devolve para Responder.',
      true,
      conversationId,
    );
    if (marked) {
      await focusConversationTitle(
        /** @type {HTMLDialogElement|null} */ (lostDialog.value),
        conversationId,
      );
    } else if (wasCommandRefused()) {
      // A refusal (403/409) says the frozen values can no longer be right: the
      // dialog closes, the reason stays in the pane and the focus goes to the
      // conversation title.
      await focusConversationTitle(
        /** @type {HTMLDialogElement|null} */ (lostDialog.value),
        conversationId,
      );
    } else {
      // One message, next to the field: the pane keeps none of it.
      lostError.value = error.value;
      error.value = '';
    }
  }

  /** D9: reopening is a correction of the loss; it asks once, in a short dialog. */
  function openReopenDialog() {
    const dialog = reopenDialog.value;
    const outcome = active.value?.lostOutcome;
    if (
      !(dialog instanceof globalThis.HTMLDialogElement) ||
      busy.value ||
      !active.value ||
      !outcome ||
      !canReopenLoss.value
    )
      return;
    clearReopenDialogState();
    reopenFrozen = {
      id: active.value.id,
      version: active.value.version,
      outcomeVersion: outcome.version ?? 1,
    };
    openDialog(dialog, /** @type {HTMLElement} */ (reopenTrigger.value));
  }

  /** MET-07: a manual reopening is a correction; the loss leaves the counts. */
  async function confirmReopen() {
    if (!active.value || busy.value) return;
    const conversationId = reopenFrozen.id;
    if (!conversationId || active.value.id !== conversationId) {
      reopenDialog.value?.close();
      return;
    }
    const reopened = await runCommand(
      'lead-outcome',
      {
        outcome: 'reopened',
        expectedConversationVersion: reopenFrozen.version,
        expectedOutcomeVersion: reopenFrozen.outcomeVersion,
      },
      'Conversa reaberta. Ela volta para a aba da vez.',
      true,
      conversationId,
    );
    if (reopened) {
      await focusConversationTitle(
        /** @type {HTMLDialogElement|null} */ (reopenDialog.value),
        conversationId,
      );
    } else if (wasCommandRefused()) {
      // A refusal (403/409) says the frozen values can no longer be right: the
      // dialog closes, the reason stays in the pane and the focus goes to the
      // conversation title.
      await focusConversationTitle(
        /** @type {HTMLDialogElement|null} */ (reopenDialog.value),
        conversationId,
      );
    } else {
      reopenError.value = error.value;
      error.value = '';
    }
  }

  // The loss and its correction belong to one conversation: their commands
  // name the conversation on screen, so a new one voids them.
  watch(activeId, () => {
    lostDialog.value?.close();
    reopenDialog.value?.close();
    clearLostDialogState();
    clearReopenDialogState();
  });

  return {
    lostDialog,
    reopenDialog,
    lostReason,
    lostNote,
    lostError,
    reopenError,
    outcomeBlockedReason,
    lossBlockedReason,
    canMarkLost,
    canReopenLoss,
    lostNotice,
    clearLostDialogState,
    clearReopenDialogState,
    openLostDialog,
    confirmLost,
    openReopenDialog,
    confirmReopen,
  };
}
