<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { useLatestRead } from '../lib/dashboard-read.js';
import { elapsedLabel } from '../lib/dashboard-format.js';
import { messageText } from '../lib/format.js';

// "Esperando um vendedor" (PCX-03, MET-02): the oldest handoffs nobody took,
// read from the same list the Inbox opens with `?situacao=aguardando`. The
// row names the client and links to the conversation; the wait is text plus
// an icon when it broke the server's deadline, never colour alone.
const props = defineProps({
  /** Server instant of the queue summary, so waits do not use the phone's clock. */
  now: { type: String, default: '' },
  /** The queue summary's total, for "Ver todos (N)"; null when unknown. */
  total: { type: Number, default: null },
});
const LIMIT = 5;
const liveEvent = inject('liveEvent', ref(null));
const heading = ref(null);
const list = useLatestRead({
  unavailable: 'Não foi possível consultar quem espera um vendedor agora.',
  stale:
    'Não foi possível atualizar a fila de espera. Os dados exibidos podem estar desatualizados.',
});
let refreshTimer = 0;

const items = computed(() =>
  (list.data.value?.items ?? [])
    .slice(0, LIMIT)
    .map((/** @type {Record<string, any>} */ conversation) => {
      const reference = props.now || new Date().toISOString();
      const due = Date.parse(String(conversation.handoff?.dueAt ?? ''));
      const late = !Number.isNaN(due) && due < Date.parse(reference);
      return {
        id: String(conversation.id),
        name: String(conversation.contact?.label ?? 'Contato sem nome'),
        message: messageText(conversation.lastMessage),
        wait:
          elapsedLabel(conversation.handoff?.createdAt, reference).replace(
            /^há /u,
            '',
          ) || '—',
        late,
      };
    }),
);
const count = computed(() =>
  typeof props.total === 'number'
    ? props.total
    : (list.data.value?.items?.length ?? null),
);

function load() {
  return list.load(
    `/api/v1/inbox/conversations?archived=false&limit=${LIMIT}&pendingHandoff=true`,
  );
}
async function retry() {
  if (list.loading.value) return;
  if (await load()) {
    await nextTick();
    heading.value?.focus();
  }
}
function refresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void load();
  }, 250);
}
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    ['inbox.conversation.changed', 'inbox.contact.changed'].includes(
      event?.type,
    )
  )
    refresh();
});
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <section
    class="dashboard-panel dashboard-waiting"
    aria-labelledby="dashboard-waiting-title"
    :aria-busy="list.loading.value ? 'true' : undefined"
  >
    <div class="dashboard-panel-head">
      <h2 id="dashboard-waiting-title" ref="heading" tabindex="-1">
        Esperando um vendedor
      </h2>
      <RouterLink
        class="dashboard-panel-link"
        :to="{ path: '/inbox', query: { situacao: 'aguardando' } }"
        >{{ count === null ? 'Ver todos' : `Ver todos (${count})` }}</RouterLink
      >
    </div>
    <div v-if="list.error.value" class="audit-note" role="alert">
      <p>{{ list.error.value }}</p>
      <button
        type="button"
        :aria-disabled="list.loading.value ? 'true' : undefined"
        @click="retry"
      >
        {{ list.loading.value ? 'Consultando…' : 'Atualizar fila de espera' }}
      </button>
    </div>
    <p
      v-if="list.loading.value && !list.data.value"
      class="dashboard-data-loading"
      role="status"
    >
      Carregando quem espera…
    </p>
    <template v-if="list.data.value">
      <ul v-if="items.length" class="dashboard-waiting-list" role="list">
        <li v-for="item in items" :key="item.id">
          <RouterLink
            class="dashboard-waiting-row"
            :to="`/inbox/${encodeURIComponent(item.id)}`"
          >
            <span class="dashboard-waiting-copy"
              ><strong class="dashboard-person-name">{{ item.name }}</strong
              ><span class="dashboard-waiting-message">{{
                item.message
              }}</span></span
            ><span
              class="badge dashboard-waiting-badge"
              :data-tone="item.late ? 'error' : 'warning'"
              ><AppIcon :name="item.late ? 'alert' : 'info'" />{{
                item.late
                  ? `Fora do prazo · ${item.wait}`
                  : `Espera ${item.wait}`
              }}</span
            >
          </RouterLink>
        </li>
      </ul>
      <p v-else class="dashboard-performance-note">
        Ninguém esperando um vendedor agora.
      </p>
    </template>
  </section>
</template>
