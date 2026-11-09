<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';
import { RouterLink } from 'vue-router';
import OrderSheetHead from '../../apps/edge-web/src/components/order/OrderSheetHead.vue';
import AppIcon from '../../apps/edge-web/src/components/AppIcon.vue';
import BillingChatPreviewAction from './BillingChatPreviewAction.vue';

defineProps({ order: { type: Object, required: true } });
const emit = defineEmits(['state', 'changed']);
const orderEditing = inject('orderEditing', null);
const state = ref(null);
const error = ref('');
const artifact = ref(null);
const artifactNotice = ref(null);
let timer;
let controller;
let signature;
let mounted = true;
let artifactTrigger;
const open = computed(() => orderEditing?.isSectionOpen?.('billing') ?? true);
const charges = computed(() => state.value?.charges ?? []);
const payments = computed(() => state.value?.payments ?? []);
const history = computed(() =>
  [...(state.value?.history ?? [])].sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      Number(a.sequence ?? 0) - Number(b.sequence ?? 0),
  ),
);
const paid = computed(() => state.value?.balanceAmountCents === 0);
const status = computed(() =>
  paid.value
    ? 'Quitado'
    : state.value?.receivedAmountCents > 0
      ? 'Pago parcialmente'
      : 'A receber',
);
const money = (value) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    (value ?? 0) / 100,
  );
const date = (value) =>
  value
    ? new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Aguardando confirmação';
const kind = (charge) =>
  charge.kind === 'balance'
    ? 'Saldo restante'
    : charge.kind === 'full'
      ? 'Pagamento integral'
      : 'Sinal';
const number = (charge) =>
  String(charge?.number ?? charges.value.indexOf(charge) + 1).padStart(2, '0');
const chargeFor = (id) => charges.value.find((charge) => charge.id === id);
const intentFor = (charge) =>
  [...(state.value?.intents ?? [])]
    .reverse()
    .find((intent) => intent.chargeId === charge.id);
const chargeStatus = (charge) =>
  charge.paid
    ? 'Pagamento confirmado'
    : charge.closed || charge.expired
      ? 'Vencida e encerrada'
      : 'Aguardando pagamento';
const sendStatus = (charge) =>
  ({
    waiting_link: 'Gerando link',
    queued: 'Na fila de envio',
    sending: 'Enviando',
    sent: 'Enviado',
    delivered: 'Entregue',
    failed: 'Falha no envio',
    unknown: 'Envio não confirmado',
    blocked: 'Envio bloqueado',
  })[intentFor(charge)?.state] ?? 'Link ainda não enviado';
const paymentMethod = (payment) =>
  payment.method === 'credit_card'
    ? `Cartão de crédito${payment.installments > 1 ? ` · ${payment.installments}x` : ''}`
    : 'Pix';
function eventLabel(event) {
  const labels = {
    charge_created: 'Cobrança criada',
    charge_corrected: 'Cobrança corrigida',
    charge_closed: 'Cobrança vencida e encerrada',
    link_ready: 'Link disponível',
    message_queued: 'Mensagem na fila de envio',
    message_sending: 'Envio iniciado',
    message_sent: 'Envio confirmado',
    message_delivered: 'Entrega confirmada',
    payment_confirmed: 'Pagamento confirmado',
  };
  return labels[event.kind] ?? 'Cobrança atualizada';
}
async function load() {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  try {
    const response = await fetch('/__billing-preview/state', {
      signal: own.signal,
    });
    if (!response.ok) throw new Error('Preview unavailable');
    const next = await response.json();
    if (!mounted || own.signal.aborted) return;
    const nextSignature = JSON.stringify([
      next.receivedAmountCents,
      next.balanceAmountCents,
      next.charges,
      next.intents,
      next.payments,
      next.history,
    ]);
    state.value = next;
    if (artifact.value) {
      const updated = (
        artifact.value.type === 'receipt' ? (next.payments ?? []) : next.charges
      ).find((item) => item.id === artifact.value.item.id);
      artifact.value = updated ? { ...artifact.value, item: updated } : null;
    }
    error.value = '';
    emit('state', {
      ready: true,
      managed: next.charges.length > 0,
      available: true,
    });
    if (signature && signature !== nextSignature) emit('changed');
    signature = nextSignature;
  } catch (cause) {
    if (!own.signal.aborted && mounted)
      error.value =
        'Não foi possível carregar a prévia das cobranças. Atualize para tentar novamente.';
  }
}
async function showArtifact(type, item, trigger) {
  artifactTrigger = trigger;
  artifact.value = { type, item };
  await nextTick();
  artifactNotice.value?.focus();
}
async function closeArtifact() {
  artifact.value = null;
  await nextTick();
  if (artifactTrigger?.isConnected) artifactTrigger.focus();
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    void load();
  }, 500);
});
onBeforeUnmount(() => {
  mounted = false;
  controller?.abort();
  clearInterval(timer);
});
</script>

<template>
  <section
    class="op-sheet billing-order-preview"
    aria-labelledby="order-billing-title"
  >
    <OrderSheetHead
      title-id="order-billing-title"
      title="Cobranças e pagamentos"
      :state="state ? status : 'Consultando'"
      :tone="paid ? 'ok' : 'neutral'"
      section="billing"
      body-id="billing-preview-order-body"
    />
    <div id="billing-preview-order-body" class="op-sheet-body" :hidden="!open">
      <p class="op-hint billing-order-preview-disclaimer">
        <AppIcon name="info" /> Protótipo local: dados fictícios, sem cobrança,
        pagamento ou envio real.
      </p>
      <p v-if="!state && !error" role="status">
        Consultando cobranças e pagamentos…
      </p>
      <div v-if="error" class="op-alert" role="alert">
        <p>{{ error }}</p>
        <button type="button" @click="load">Atualizar cobranças</button>
      </div>
      <template v-if="state">
        <dl class="billing-order-preview-totals" aria-label="Valores do pedido">
          <div>
            <dt>Total do pedido</dt>
            <dd>{{ money(state.order.totalAmountCents) }}</dd>
          </div>
          <div>
            <dt>Recebido</dt>
            <dd>{{ money(state.receivedAmountCents) }}</dd>
          </div>
          <div>
            <dt>Falta receber</dt>
            <dd>{{ money(state.balanceAmountCents) }}</dd>
          </div>
        </dl>
        <p v-if="paid" class="billing-order-preview-state" role="status">
          <AppIcon name="check" /><span
            ><strong>Pedido integralmente pago.</strong> Todos os recebimentos
            permanecem no histórico.</span
          >
        </p>
        <p
          v-else-if="state.receivedAmountCents"
          class="billing-order-preview-state"
        >
          <AppIcon name="info" /><span
            >Pagamento parcial confirmado. Você pode revisar a cobrança do saldo
            de <strong>{{ money(state.balanceAmountCents) }}</strong
            >.</span
          >
        </p>
        <p v-else class="op-hint">
          Criar ou entregar um link não significa receber. O saldo muda após a
          confirmação do pagamento.
        </p>
        <div class="inline-actions billing-order-preview-actions">
          <BillingChatPreviewAction
            presentation="text"
            :label="paid ? 'Consultar cobranças' : 'Gerenciar cobranças'"
            @sent="load"
          />
          <RouterLink class="button-link" :to="`/inbox/${state.conversationId}`"
            >Voltar à conversa</RouterLink
          >
        </div>
        <p class="op-hint">
          As ações usam a mesma conversa e o mesmo histórico do chat. Seu
          rascunho continua preservado ao voltar.
        </p>

        <section
          class="billing-order-preview-group"
          aria-labelledby="billing-preview-charges-title"
        >
          <h3 id="billing-preview-charges-title">
            Cobranças <span>({{ charges.length }})</span>
          </h3>
          <p v-if="!charges.length" class="op-hint">
            Nenhuma cobrança criada para este pedido.
          </p>
          <ol
            v-else
            class="billing-order-preview-list"
            aria-label="Cobranças do pedido"
          >
            <li
              v-for="charge in [...charges].reverse()"
              :key="charge.id"
              class="billing-order-preview-card"
            >
              <div class="billing-order-preview-card-head">
                <h4>Cobrança {{ number(charge) }} · {{ kind(charge) }}</h4>
                <strong class="billing-order-preview-amount">{{
                  money(charge.amountCents)
                }}</strong>
              </div>
              <p class="billing-order-preview-card-status">
                <AppIcon :name="charge.paid ? 'check' : 'info'" />{{
                  chargeStatus(charge)
                }}
              </p>
              <p v-if="charge.supersedesChargeId" class="op-hint">
                Corrige a cobrança
                {{ number(chargeFor(charge.supersedesChargeId)) }}. O valor e o
                link anteriores continuam preservados.
              </p>
              <dl class="billing-order-preview-facts">
                <div>
                  <dt>Envio da mensagem</dt>
                  <dd>{{ sendStatus(charge) }}</dd>
                </div>
                <div>
                  <dt>
                    {{
                      charge.paid
                        ? 'Link de uso único'
                        : charge.expired || charge.closed
                          ? 'Validade encerrada em'
                          : 'Link válido até'
                    }}
                  </dt>
                  <dd>
                    {{
                      charge.paid
                        ? 'Pagamento já confirmado'
                        : date(charge.validUntil)
                    }}
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                class="link-button"
                @click="showArtifact('link', charge, $event.currentTarget)"
              >
                Ver link {{ charge.closed ? 'anterior' : 'da cobrança' }}
                {{ number(charge) }}
              </button>
              <p v-if="charge.closed" class="op-hint">
                Link vencido e encerrado no CRM. Corrigir o valor não apaga nem
                cancela o link anterior na InfinitePay.
              </p>
            </li>
          </ol>
        </section>

        <section
          class="billing-order-preview-group"
          aria-labelledby="billing-preview-payments-title"
        >
          <h3 id="billing-preview-payments-title">
            Pagamentos confirmados <span>({{ payments.length }})</span>
          </h3>
          <p v-if="!payments.length" class="op-hint">
            Nenhum pagamento confirmado. O envio de uma cobrança não quita o
            pedido.
          </p>
          <ol
            v-else
            class="billing-order-preview-list"
            aria-label="Pagamentos confirmados do pedido"
          >
            <li
              v-for="(payment, index) in payments"
              :key="payment.id"
              class="billing-order-preview-card"
            >
              <div class="billing-order-preview-card-head">
                <h4>Pagamento {{ String(index + 1).padStart(2, '0') }}</h4>
                <strong class="billing-order-preview-amount">{{
                  money(payment.amountCents)
                }}</strong>
              </div>
              <p>
                {{ paymentMethod(payment) }} · Cobrança
                {{ number(chargeFor(payment.chargeId)) }}
              </p>
              <p class="op-hint">
                Confirmado em
                <time :datetime="payment.paidAt">{{
                  date(payment.paidAt)
                }}</time
                >.
              </p>
              <button
                type="button"
                class="link-button"
                @click="showArtifact('receipt', payment, $event.currentTarget)"
              >
                Ver comprovante do pagamento
                {{ String(index + 1).padStart(2, '0') }}
              </button>
            </li>
          </ol>
        </section>

        <div
          v-if="artifact"
          ref="artifactNotice"
          class="billing-order-preview-artifact"
          role="status"
          tabindex="-1"
        >
          <template v-if="artifact.type === 'receipt'">
            <h3>Comprovante de demonstração</h3>
            <p>
              <strong>{{ money(artifact.item.amountCents) }}</strong> ·
              {{ paymentMethod(artifact.item) }}
            </p>
            <p>
              Pagamento confirmado em {{ date(artifact.item.paidAt) }} para a
              cobrança {{ number(chargeFor(artifact.item.chargeId)) }}.
            </p>
            <p class="op-hint">
              Referência sintética:
              {{ artifact.item.transactionNsu || artifact.item.id }}. Este
              comprovante não representa uma transação real.
            </p>
          </template>
          <template v-else>
            <h3>
              Link {{ artifact.item.closed ? 'anterior' : 'da cobrança' }}
              {{ number(artifact.item) }}
            </h3>
            <p>{{ artifact.item.url }}</p>
            <p>
              {{ chargeStatus(artifact.item) }} ·
              {{ money(artifact.item.amountCents) }}
            </p>
            <p class="op-hint">
              Endereço fictício preservado para avaliação. Nenhum checkout real
              será aberto.
            </p>
          </template>
          <button type="button" @click="closeArtifact">Fechar detalhes</button>
        </div>

        <details class="billing-order-preview-history" open>
          <summary>
            Histórico completo de cobranças e pagamentos
            <span>({{ history.length }})</span>
          </summary>
          <p v-if="!history.length" class="op-hint">
            Os eventos aparecerão aqui conforme as ações forem simuladas.
          </p>
          <ol
            v-else
            class="billing-order-preview-timeline"
            aria-label="Histórico de cobranças e pagamentos"
            tabindex="0"
          >
            <li v-for="event in history" :key="event.id">
              <div>
                <strong>{{ eventLabel(event) }}</strong
                ><span
                  >Cobrança {{ number(chargeFor(event.chargeId))
                  }}<template v-if="event.amountCents">
                    · {{ money(event.amountCents) }}</template
                  ></span
                ><span v-if="event.supersedesChargeId"
                  >Anterior: cobrança
                  {{ number(chargeFor(event.supersedesChargeId)) }},
                  preservada.</span
                >
              </div>
              <time :datetime="event.occurredAt">{{
                date(event.occurredAt)
              }}</time>
            </li>
          </ol>
        </details>
      </template>
    </div>
  </section>
</template>

<style scoped>
.billing-order-preview-disclaimer,
.billing-order-preview-state {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}
.billing-order-preview-disclaimer .app-icon,
.billing-order-preview-state .app-icon {
  flex: 0 0 auto;
}
.billing-order-preview-totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
  margin: var(--space-4) 0;
}
.billing-order-preview-totals div {
  padding-block: var(--space-3);
  border-block-end: 1px solid var(--color-border);
}
.billing-order-preview-totals dt,
.billing-order-preview-facts dt {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.billing-order-preview-totals dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-lg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.billing-order-preview-state {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.billing-order-preview-actions {
  margin-block: var(--space-4);
}
.billing-order-preview-group {
  margin-block-start: var(--space-5);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border);
}
.billing-order-preview-group h3 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-base);
}
.billing-order-preview-group h3 span {
  color: var(--color-text-muted);
  font-weight: 400;
}
.billing-order-preview-list {
  display: grid;
  gap: var(--space-3);
  padding: 0;
  margin: 0;
  list-style: none;
}
.billing-order-preview-card {
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.billing-order-preview-card-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  align-items: baseline;
}
.billing-order-preview-card-head h4 {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}
.billing-order-preview-amount {
  font-variant-numeric: tabular-nums;
}
.billing-order-preview-card p {
  margin-block: var(--space-2);
  overflow-wrap: anywhere;
}
.billing-order-preview-card-status {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--text-sm);
}
.billing-order-preview-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin-block: var(--space-3);
}
.billing-order-preview-facts dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
}
.billing-order-preview-artifact {
  margin-block-start: var(--space-4);
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  overflow-wrap: anywhere;
}
.billing-order-preview-artifact h3 {
  margin-block-start: 0;
  font-size: var(--text-base);
}
.billing-order-preview-history {
  margin-block-start: var(--space-5);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border);
}
.billing-order-preview-history summary {
  padding-block: var(--space-2);
  cursor: pointer;
  font-weight: 500;
}
.billing-order-preview-timeline {
  max-block-size: 28rem;
  overflow: auto;
  overscroll-behavior: contain;
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0 var(--space-2);
}
.billing-order-preview-timeline li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding-block: var(--space-3);
  border-block-end: 1px solid var(--color-border-subtle);
}
.billing-order-preview-timeline li > div {
  display: grid;
  gap: var(--space-1);
}
.billing-order-preview-timeline strong {
  font-size: var(--text-sm);
  font-weight: 500;
}
.billing-order-preview-timeline span,
.billing-order-preview-timeline time {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.billing-order-preview-timeline time {
  flex: 0 0 auto;
}
@media (max-width: 480px) {
  .billing-order-preview-totals {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .billing-order-preview-totals div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .billing-order-preview-totals dd {
    font-size: var(--text-base);
  }
  .billing-order-preview-facts {
    grid-template-columns: 1fr;
  }
  .billing-order-preview-actions > * {
    flex: 1 1 100%;
  }
  .billing-order-preview-actions :deep(.conversation-shipping-action > button) {
    flex: 1 1 100%;
    justify-content: center;
  }
  .billing-order-preview-timeline li {
    flex-direction: column;
    gap: var(--space-1);
  }
}
</style>
