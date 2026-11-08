<script setup>
import AppIcon from '../AppIcon.vue';
import { CHANNEL_LABELS, messageText } from '../../lib/format.js';
import { previewAuthor } from '../../lib/inbox-turn.js';

/**
 * RFC 052 card: who and how long; what was said; up to two seals. The time
 * and the seals are computed by the list (they depend on the clock, the tab
 * and the owner scope); the card only draws them.
 */
defineProps({
  /** @type {import('vue').PropType<Record<string, any>>} */
  conversation: { type: Object, required: true },
  /**
   * @type {import('vue').PropType<{label: string, spoken: string, title: string, tone?: string}|null>}
   */
  time: { type: Object, default: null },
  /**
   * @type {import('vue').PropType<{visible: Array<Record<string, any>>, hidden: Array<Record<string, any>>}>}
   */
  badges: { type: Object, required: true },
  /** The conversation open in the pane (`aria-current`). */
  current: { type: Boolean, default: false },
});
/** `open(conversationId)`: the row was activated. */
const emit = defineEmits(['open']);
</script>

<template>
  <button
    type="button"
    class="conversation-row"
    :data-conversation-id="conversation.id"
    :aria-current="current ? 'true' : undefined"
    @click="emit('open', conversation.id)"
  >
    <span class="conv-top">
      <span class="conv-name" :title="conversation.contact.label">{{
        conversation.contact.label
      }}</span>
      <span
        class="conv-channel"
        :title="CHANNEL_LABELS[conversation.channel] ?? 'Canal'"
        ><AppIcon
          :name="conversation.channel === 'site_chat' ? 'globe' : 'message'"
        /><span class="sr-only">{{
          conversation.channel === 'site_chat'
            ? 'Site'
            : (CHANNEL_LABELS[conversation.channel] ?? 'Canal')
        }}</span></span
      >
      <span
        v-if="time"
        class="conv-waiting"
        :data-tone="time.tone"
        :title="time.title"
        ><span class="sr-only">{{ time.spoken }}.</span
        ><span aria-hidden="true">{{ time.label }}</span></span
      >
    </span>
    <span v-if="conversation.lastMessage" class="conv-preview"
      ><span v-if="previewAuthor(conversation.lastMessage)">{{
        previewAuthor(conversation.lastMessage)
      }}</span
      >{{ messageText(conversation.lastMessage) }}</span
    >
    <span v-if="badges.visible.length" class="conv-badges"
      ><span
        v-for="badge in badges.visible"
        :key="badge.key"
        class="badge"
        :data-tone="badge.tone"
        ><AppIcon v-if="badge.key === 'delivery'" name="alert" />{{
          badge.label
        }}</span
      ><span v-if="badges.hidden.length" class="badge" data-overflow="true"
        ><span aria-hidden="true">+{{ badges.hidden.length }}</span
        ><span class="sr-only">{{
          badges.hidden.map((badge) => badge.label).join(', ')
        }}</span></span
      ></span
    >
  </button>
</template>
