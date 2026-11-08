<script setup>
import { ref } from 'vue';

/**
 * INBOX-VEZ-03 (RFC 052): the customer's silence or a declared loss, decided
 * above the reply. Retomar is the reply itself. The strip only draws and
 * reports intent; the commands, the dialogs and the version checks stay with
 * the Inbox. It renders nothing when the conversation is in neither state.
 */
defineProps({
  /** @type {import('vue').PropType<{text: string, reminder: string}|null>} */
  silentNotice: { type: Object, default: null },
  /** "Marcada como perdida · motivo · quando", or null. */
  lostNotice: { type: String, default: null },
  /** Why declaring a loss is not possible now; empty when it is. */
  lossBlockedReason: { type: String, default: '' },
  /** Why correcting a loss is not possible now; empty when it is. */
  outcomeBlockedReason: { type: String, default: '' },
  canMarkLost: { type: Boolean, default: false },
  canReopenLoss: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  /** The reminder form is open. */
  snoozeOpen: { type: Boolean, default: false },
  reminderError: { type: String, default: '' },
  /** `min`/`max` of the datetime-local field (São Paulo wall time). */
  reminderBounds: {
    type: Object,
    default: () => ({ min: '', max: '' }),
  },
});
/** The reminder's date and time (São Paulo wall time), edited in the field. */
const reminderAt = defineModel('reminderAt', { type: String, default: '' });
/**
 * `toggle-snooze`, `close-snooze`, `save-reminder`, `mark-lost` and `reopen`
 * report what the person asked for.
 */
const emit = defineEmits([
  'toggle-snooze',
  'close-snooze',
  'save-reminder',
  'mark-lost',
  'reopen',
]);

/** @type {import('vue').Ref<HTMLButtonElement|null>} */
const snoozeToggle = ref(null);
/** @type {import('vue').Ref<HTMLInputElement|null>} */
const reminderInput = ref(null);
/** @type {import('vue').Ref<HTMLButtonElement|null>} */
const lostTrigger = ref(null);
/** @type {import('vue').Ref<HTMLButtonElement|null>} */
const reopenTrigger = ref(null);

// The Inbox moves the focus here (the field when it refuses a reminder, the
// "Lembrar depois" button when the form closes) and returns it to the triggers
// when a dialog closes.
defineExpose({ snoozeToggle, reminderInput, lostTrigger, reopenTrigger });
</script>

<template>
  <div
    v-if="silentNotice"
    class="inbox-notice inbox-turn-notice"
    role="group"
    aria-labelledby="inbox-turn-notice-text"
  >
    <div class="inbox-turn-row">
      <p id="inbox-turn-notice-text">
        {{ silentNotice.text }}
        <span v-if="silentNotice.reminder">{{ silentNotice.reminder }}</span>
      </p>
      <div class="inline-actions">
        <button
          ref="snoozeToggle"
          type="button"
          class="quiet"
          aria-controls="inbox-reminder-form"
          :aria-expanded="snoozeOpen ? 'true' : 'false'"
          @click="emit('toggle-snooze')"
        >
          Lembrar depois
        </button>
        <button
          ref="lostTrigger"
          type="button"
          class="quiet"
          aria-haspopup="dialog"
          :aria-disabled="canMarkLost ? undefined : 'true'"
          :aria-describedby="canMarkLost ? undefined : 'inbox-outcome-reason'"
          @click="canMarkLost && emit('mark-lost')"
        >
          Marcar perdido
        </button>
      </div>
    </div>
    <p
      v-if="lossBlockedReason"
      id="inbox-outcome-reason"
      class="inbox-turn-hint"
    >
      {{ lossBlockedReason }}
    </p>
    <form
      v-if="snoozeOpen"
      id="inbox-reminder-form"
      class="inbox-turn-form"
      novalidate
      aria-labelledby="inbox-reminder-title"
      @submit.prevent="emit('save-reminder')"
      @keydown.esc.prevent="emit('close-snooze')"
    >
      <h3 id="inbox-reminder-title">Quando lembrar você?</h3>
      <p>
        A conversa sai de Sem retorno até o horário escolhido, em até 90 dias.
        Nenhuma mensagem é enviada ao cliente.
      </p>
      <label for="inbox-reminder-at">Data e horário de São Paulo</label>
      <input
        id="inbox-reminder-at"
        ref="reminderInput"
        v-model="reminderAt"
        type="datetime-local"
        required
        :min="reminderBounds.min"
        :max="reminderBounds.max"
        :readonly="busy"
        :aria-invalid="reminderError ? 'true' : undefined"
        :aria-describedby="reminderError ? 'inbox-reminder-error' : undefined"
      />
      <p
        v-if="reminderError"
        id="inbox-reminder-error"
        class="inbox-turn-error"
        role="alert"
      >
        {{ reminderError }}
      </p>
      <div class="inline-actions">
        <button type="submit" :aria-disabled="busy ? 'true' : undefined">
          {{ busy ? 'Salvando…' : 'Salvar lembrete' }}
        </button>
        <button type="button" class="quiet" @click="emit('close-snooze')">
          Cancelar
        </button>
      </div>
    </form>
  </div>
  <div
    v-else-if="lostNotice"
    class="inbox-notice inbox-turn-notice"
    role="group"
    aria-labelledby="inbox-turn-notice-text"
  >
    <div class="inbox-turn-row">
      <p id="inbox-turn-notice-text">{{ lostNotice }}</p>
      <div class="inline-actions">
        <button
          ref="reopenTrigger"
          type="button"
          class="quiet"
          aria-haspopup="dialog"
          :aria-disabled="busy || !canReopenLoss ? 'true' : undefined"
          :aria-describedby="canReopenLoss ? undefined : 'inbox-outcome-reason'"
          @click="emit('reopen')"
        >
          Reabrir
        </button>
      </div>
    </div>
    <p
      v-if="outcomeBlockedReason"
      id="inbox-outcome-reason"
      class="inbox-turn-hint"
    >
      {{ outcomeBlockedReason }}
    </p>
  </div>
</template>
