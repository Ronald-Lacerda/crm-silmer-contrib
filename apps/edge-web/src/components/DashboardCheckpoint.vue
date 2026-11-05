<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { request } from '../lib/api-client.js';

const loading = ref(true);
const error = ref('');
/** @type {import('vue').Ref<Record<string, any>|null>} */
const checkpoint = ref(null);
let controller;
const labels = {
  not_generated: 'Aguardando geração',
  pending: 'Aguardando envio',
  reserved: 'Envio em andamento',
  sent: 'Aceito pelo provedor',
  failed: 'Envio não realizado',
  outcome_unknown: 'Conferir envio',
};
function dayLabel(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day ?? '')
    ? day.split('-').reverse().join('/')
    : 'dia anterior';
}
async function load() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const response = await request('/api/v1/dashboard/checkpoint', {
      signal: current.signal,
    });
    if (controller !== current) return;
    checkpoint.value = response.data;
    error.value = '';
  } catch (failure) {
    if (controller !== current || current.signal.aborted) return;
    error.value = 'Não foi possível consultar o checkpoint.';
  } finally {
    if (controller === current) loading.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section
    class="dashboard-checkpoint"
    aria-labelledby="checkpoint-title"
    :aria-busy="loading"
  >
    <div class="dashboard-section-head">
      <h2 id="checkpoint-title">Checkpoint dos sócios</h2>
      <span class="checkpoint-schedule">Todos os dias · 08h · São Paulo</span>
    </div>
    <p v-if="loading && !checkpoint" class="checkpoint-note" role="status">
      Consultando resumo e envios…
    </p>
    <div v-if="error" role="alert">
      <p>
        {{ error }}
        {{ checkpoint ? 'Os dados abaixo podem estar desatualizados.' : '' }}
      </p>
      <button
        type="button"
        class="button button-secondary"
        :disabled="loading"
        @click="load"
      >
        Tentar novamente
      </button>
    </div>
    <template v-if="checkpoint">
      <p v-if="!checkpoint.enabled" class="checkpoint-note">
        Envio diário ainda não ativado. A prévia permite conferir o resumo antes
        da ativação.
      </p>
      <p v-else class="checkpoint-note">
        Resumo de {{ dayLabel(checkpoint.day) }}. O status abaixo acompanha cada
        destinatário.
      </p>
      <ul
        v-if="checkpoint.recipients?.length"
        class="checkpoint-recipients"
        aria-label="Situação por destinatário"
      >
        <li v-for="recipient in checkpoint.recipients" :key="recipient.id">
          <strong>{{ recipient.label }}</strong>
          <span>{{ labels[recipient.status] ?? 'Status indisponível' }}</span>
        </li>
      </ul>
      <p v-else class="checkpoint-note">
        Os dois destinatários serão definidos na configuração privada do envio.
      </p>
      <p
        v-if="
          checkpoint.recipients?.some(
            (recipient) => recipient.status === 'outcome_unknown',
          )
        "
        class="checkpoint-note"
      >
        O resultado de um envio está indefinido. Confira o WhatsApp antes de
        qualquer nova tentativa.
      </p>
      <details class="checkpoint-preview">
        <summary>
          {{
            checkpoint.snapshot
              ? 'Ver resumo registrado'
              : 'Ver prévia do resumo'
          }}
          · {{ dayLabel(checkpoint.day) }}
        </summary>
        <p v-if="!checkpoint.snapshot" class="checkpoint-note">
          Prévia com os dados atuais. O resumo será fixado quando o envio diário
          for preparado.
        </p>
        <pre>{{ checkpoint.previewText }}</pre>
      </details>
      <button
        type="button"
        class="link-button checkpoint-refresh"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Atualizando…' : 'Atualizar situação' }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.dashboard-checkpoint {
  margin-block-end: var(--space-6);
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.checkpoint-schedule,
.checkpoint-note,
.checkpoint-recipients span {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.checkpoint-recipients {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-6);
  padding: 0;
  list-style: none;
}
.checkpoint-recipients li {
  display: grid;
  gap: var(--space-1);
}
.checkpoint-preview summary,
.checkpoint-refresh {
  min-block-size: var(--target-min);
  align-content: center;
  cursor: pointer;
}
.checkpoint-preview pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: var(--text-sm);
  line-height: 1.7;
}
@media (max-width: 40rem) {
  .dashboard-checkpoint {
    padding: var(--space-4);
  }
}
</style>
