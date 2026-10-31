<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { request } from '../../lib/api-client.js';
import { assistantContextLines } from '../../lib/assistant-context.js';

/**
 * INBOX-HANDOFF-02: on a direct takeover (the agent is still answering and
 * there is no handoff summary), what the agent was doing — the point it was
 * asking, the ficha progress and how many of its messages it used. Lines of
 * the takeover reason, so "Assumir atendimento" is described by them too.
 * Supplementary: without permission, on an older API or on any failure the
 * reason reads as before. Kept in memory only.
 */
const props = defineProps({
  conversationId: { type: String, required: true },
  /** Changes when the conversation does, so a new agent turn is read. */
  revision: { type: [String, Number], default: '' },
});

/** @type {import('vue').Ref<Record<string, any>|null>} */
const context = ref(null);
let controller;

const lines = computed(() => assistantContextLines(context.value));

async function load() {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  try {
    const response = await request(
      `/api/v1/inbox/conversations/${encodeURIComponent(props.conversationId)}/assistant-context`,
      { signal: own.signal },
    );
    if (own === controller) context.value = response.data ?? null;
  } catch {
    if (own === controller) context.value = null;
  }
}

watch(
  () => props.conversationId,
  () => {
    // Another conversation never shows the context of the one before it.
    context.value = null;
    void load();
  },
  { immediate: true },
);
watch(
  () => props.revision,
  () => void load(),
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <template v-for="line in lines" :key="line"
    >{{ ' ' }}<span class="takeover-context">{{ line }}</span></template
  >
</template>
