import { computed, nextTick, ref, watch } from 'vue';
import {
  REMINDER_MAX_DAYS,
  REMINDER_RANGE_MESSAGE,
  minutesSince,
  reminderInRange,
  turnSpan,
} from '../../lib/inbox-turn.js';
import {
  defaultReminder,
  reminderInstant,
  reminderLabel,
} from '../../lib/dashboard-actions.js';

/** São Paulo's wall time as `YYYY-MM-DD HH:mm`, for the datetime-local field. */
const SAO_PAULO_LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A datetime-local value (São Paulo wall time) for an instant. @param {number} at */
function localValue(at) {
  return SAO_PAULO_LOCAL.format(new Date(at)).replace(' ', 'T');
}

/**
 * INBOX-VEZ-03 (ACT-05, RFC 052): "Lembrar depois" for a conversation in Sem
 * retorno. The reminder is per person (D2): the API keeps it for whoever set
 * it. This composable owns the form's state, the command and the focus after
 * it; the Inbox keeps the shared command runner, the tabs and the list.
 *
 * @param {{
 *   active: import('vue').Ref<Record<string, any>|null>,
 *   activeId: import('vue').Ref<string>,
 *   busy: import('vue').Ref<boolean>,
 *   error: import('vue').Ref<string>,
 *   isTerminal: import('vue').Ref<boolean>,
 *   now: import('vue').Ref<Date>,
 *   turnStrip: import('vue').Ref<any>,
 *   runCommand: (path: string, body: Record<string, unknown>, successMessage: string, keepOpen?: boolean, targetId?: string) => Promise<boolean|undefined>,
 *   focusConversationTitle: (dialog?: HTMLDialogElement|null, conversationId?: string) => Promise<void>,
 * }} deps
 */
export function useInboxReminder({
  active,
  activeId,
  busy,
  error,
  isTerminal,
  now,
  turnStrip,
  runCommand,
  focusConversationTitle,
}) {
  const snoozeOpen = ref(false);
  const reminderAt = ref('');
  const reminderError = ref('');
  // The turn strip draws the form and exposes the elements the focus goes to.
  const reminderInput = computed(() => turnStrip.value?.reminderInput ?? null);
  const snoozeToggle = computed(() => turnStrip.value?.snoozeToggle ?? null);

  /** INBOX-VEZ-03: the customer went quiet; the reminder shows in the strip. */
  const silentNotice = computed(() => {
    const turn = active.value;
    if (turn?.bucket !== 'silent' || isTerminal.value) return null;
    const minutes = minutesSince(turn.turnSince, now.value);
    return {
      text:
        minutes === null
          ? 'Cliente sem responder há mais de 72 horas.'
          : `Cliente sem responder há ${turnSpan(minutes).spoken}.`,
      reminder: turn.reminder?.remindAt
        ? `Lembrete para ${reminderLabel(turn.reminder.remindAt)}.`
        : '',
    };
  });

  /** The field accepts what the API does: from now up to 90 days ahead. */
  const reminderBounds = computed(() => ({
    min: localValue(now.value.getTime()),
    max: localValue(
      now.value.getTime() + REMINDER_MAX_DAYS * 86_400_000 - 60_000,
    ),
  }));

  /** São Paulo's calendar day, the default for a reminder. */
  function todayInSaoPaulo() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now.value);
  }

  /** INBOX-VEZ-03: the reminder form of the Central de ações (ACT-05). */
  async function toggleSnooze() {
    if (snoozeOpen.value) {
      await closeSnooze();
      return;
    }
    reminderError.value = '';
    reminderAt.value =
      reminderAt.value ||
      defaultReminder(todayInSaoPaulo(), now.value.toISOString());
    snoozeOpen.value = true;
    await nextTick();
    /** @type {HTMLInputElement|null} */ (reminderInput.value)?.focus();
  }

  async function closeSnooze() {
    snoozeOpen.value = false;
    reminderError.value = '';
    await nextTick();
    /** @type {HTMLElement|null} */ (snoozeToggle.value)?.focus();
  }

  async function saveReminder() {
    if (!active.value || busy.value) return;
    const conversationId = active.value.id;
    const instant = reminderInstant(reminderAt.value);
    if (!instant || !reminderInRange(instant, new Date())) {
      reminderError.value = REMINDER_RANGE_MESSAGE;
      await nextTick();
      /** @type {HTMLInputElement|null} */ (reminderInput.value)?.focus();
      return;
    }
    const saved = await runCommand(
      'reminder',
      { remindAt: instant, expectedVersion: active.value.version },
      `Lembrete salvo para ${reminderLabel(instant)}. Nada foi enviado ao cliente.`,
      true,
    );
    if (!saved) {
      // The refusal belongs next to the field while the form is still there; a
      // conversation that left Sem retorno keeps it in the pane.
      if (
        snoozeOpen.value &&
        silentNotice.value &&
        activeId.value === conversationId
      ) {
        reminderError.value = error.value;
        error.value = '';
        await nextTick();
        /** @type {HTMLInputElement|null} */ (reminderInput.value)?.focus();
      }
      return;
    }
    snoozeOpen.value = false;
    reminderAt.value = '';
    await focusConversationTitle(null, conversationId);
  }

  // The reminder form belongs to one conversation: a new one voids it.
  watch(activeId, () => {
    snoozeOpen.value = false;
    reminderAt.value = '';
    reminderError.value = '';
  });

  return {
    snoozeOpen,
    reminderAt,
    reminderError,
    reminderBounds,
    silentNotice,
    toggleSnooze,
    closeSnooze,
    saveReminder,
  };
}
