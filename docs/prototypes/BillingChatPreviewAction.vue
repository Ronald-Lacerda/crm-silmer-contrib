<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { openDialog } from '../../apps/edge-web/src/lib/ui.js';
import AppIcon from '../../apps/edge-web/src/components/AppIcon.vue';

defineProps({
  disabled: { type: Boolean, default: false },
  presentation: { type: String, default: 'icon' },
  label: { type: String, default: 'Gerar e enviar cobrança' },
});
const emit = defineEmits(['sent']);
const dialog = ref(null);
const state = ref(null);
const step = ref('choose');
const mode = ref('signal');
const percent = ref(30);
const correctionAmount = ref('240,00');
const agreement = ref(false);
const review = ref(false);
const error = ref('');
const notice = ref('');
const busy = ref(false);
const scenario = ref('new');
const errorNotice = ref(null);
let timer;
let signature;
const money = (value) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    (value ?? 0) / 100,
  );
const current = computed(() => state.value?.charges?.at(-1));
const intent = computed(() => state.value?.latestIntent);
const active = computed(
  () => current.value && !current.value.paid && !current.value.closed,
);
const pending = computed(() =>
  ['waiting_link', 'queued', 'sending'].includes(intent.value?.state),
);
const uncertain = computed(() => intent.value?.state === 'unknown');
const due = computed(() => state.value?.balanceAmountCents ?? 0);
watch(
  () => state.value?.receivedAmountCents,
  (received, previous) => {
    if (received > 0) {
      mode.value = 'balance';
      if (previous !== undefined && step.value.endsWith('review'))
        step.value = 'choose';
    } else if (mode.value === 'balance') mode.value = 'signal';
  },
);
const value = computed(() =>
  mode.value === 'balance'
    ? due.value
    : mode.value === 'full'
      ? state.value?.order.totalAmountCents
      : Math.round(
          ((state.value?.order.totalAmountCents ?? 0) * Number(percent.value)) /
            100,
        ),
);
const corrected = computed(() =>
  Math.round(Number(correctionAmount.value.replace(',', '.')) * 100),
);
const validValue = (value) =>
  Number.isSafeInteger(value) &&
  value >= 100 &&
  value <= due.value &&
  (due.value - value === 0 || due.value - value >= 100);
const canCorrect = computed(
  () =>
    current.value &&
    !current.value.paid &&
    current.value.expired &&
    current.value.closed &&
    agreement.value &&
    review.value &&
    validValue(corrected.value),
);
const actionName = computed(() =>
  step.value === 'correct-review'
    ? 'correct'
    : mode.value === 'balance'
      ? 'balance'
      : 'issue',
);
const reviewAmount = computed(() =>
  step.value === 'correct-review'
    ? corrected.value
    : step.value === 'existing-review' || step.value === 'retry-review'
      ? current.value?.amountCents
      : value.value,
);
const reviewKind = computed(() =>
  step.value === 'correct-review'
    ? 'cobrança corrigida'
    : mode.value === 'balance'
      ? 'saldo'
      : mode.value === 'full'
        ? 'pagamento integral'
        : 'sinal',
);
const statuses = {
  waiting_link: 'Gerando link',
  queued: 'Na fila de envio',
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregue',
  failed: 'Falha antes do envio',
  unknown: 'Envio não confirmado',
  blocked: 'Envio bloqueado',
};
const date = (value) =>
  new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
async function api(path, body) {
  const result = await fetch(
    `/__billing-preview/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await result.json();
  if (!result.ok)
    throw new Error(data.detail ?? 'Não foi possível atualizar a simulação.');
  return data;
}
async function load() {
  const result = await api('state');
  const nextSignature = `${result.messageCount}:${result.latestIntent?.state}:${result.receivedAmountCents}`;
  state.value = result;
  scenario.value = result.scenario;
  if (signature && signature !== nextSignature) emit('sent');
  signature = nextSignature;
}
async function command(action, fields = {}) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    state.value = await api('action', { action, ...fields });
    await load();
    return true;
  } catch (cause) {
    error.value = cause.message;
    await nextTick();
    errorNotice.value?.focus();
    return false;
  } finally {
    busy.value = false;
  }
}
async function open(trigger) {
  await load();
  step.value = 'choose';
  error.value = '';
  notice.value = '';
  openDialog(dialog.value, trigger);
}
async function navigate(next) {
  step.value = next;
  error.value = '';
  notice.value = '';
  await nextTick();
  dialog.value?.querySelector('h2')?.focus();
}
async function submit() {
  const action =
    step.value === 'existing-review'
      ? 'send_existing'
      : step.value === 'retry-review'
        ? 'retry'
        : actionName.value;
  const fields =
    action === 'correct'
      ? {
          amountCents: corrected.value,
          confirmedAgreement: agreement.value,
          confirmedProviderReview: review.value,
        }
      : { percent: mode.value === 'full' ? 100 : Number(percent.value) };
  if (await command(action, fields)) await navigate('choose');
}
async function reset() {
  if (await command('scenario', { scenario: scenario.value })) {
    mode.value = scenario.value === 'signal-paid' ? 'balance' : 'signal';
    agreement.value = false;
    review.value = false;
    step.value = 'choose';
  }
}
async function expire() {
  if (await command('expire'))
    notice.value =
      'Validade encerrada na simulação. Confira a ausência de pagamento antes de corrigir.';
}
async function pay() {
  if (await command('pay')) {
    notice.value = due.value
      ? 'Recebimento confirmado na simulação. O saldo foi atualizado.'
      : 'Recebimento confirmado na simulação. Pedido quitado.';
    mode.value = 'balance';
  }
}
onMounted(async () => {
  await load();
  timer = setInterval(() => {
    void load();
  }, 500);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="conversation-shipping-action">
    <button
      type="button"
      :title="label"
      :aria-label="label"
      :class="presentation === 'text' ? 'primary' : undefined"
      :disabled="disabled"
      @click="open($event.currentTarget)"
    >
      <svg
        class="app-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20M6 15h3" />
      </svg>
      <span :class="presentation === 'text' ? undefined : 'sr-only'">{{
        label
      }}</span>
    </button>
    <Teleport to="body"
      ><dialog
        ref="dialog"
        class="conversation-shipping-dialog billing-chat-preview-dialog"
        aria-labelledby="billing-preview-title"
        aria-describedby="billing-preview-description"
      >
        <div class="conversation-shipping-head">
          <h2 id="billing-preview-title" tabindex="-1">
            {{
              step === 'correct'
                ? 'Corrigir cobrança'
                : step.endsWith('review') || step === 'review'
                  ? 'Revisar cobrança'
                  : 'Cobranças do pedido'
            }}
          </h2>
          <button type="button" @click="dialog?.close()">
            Fechar cobrança
          </button>
        </div>
        <p id="billing-preview-description" class="billing-preview-disclaimer">
          <AppIcon name="info" /> Protótipo local. Dados fictícios; nenhum link,
          pagamento ou envio real.
        </p>
        <p v-if="error" ref="errorNotice" role="alert" tabindex="-1">
          {{ error }}
        </p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <template v-if="state">
          <template v-if="step === 'choose'">
            <label for="billing-preview-order">Pedido deste atendimento</label>
            <select id="billing-preview-order">
              <option>
                {{ state.order.number }} · {{ state.order.name }} · Confirmado
              </option>
            </select>
            <p class="muted">
              A cobrança será enviada para <strong>{{ state.customer }}</strong
              >, nesta conversa.
            </p>
            <dl class="billing-preview-totals">
              <div>
                <dt>Total do pedido</dt>
                <dd>{{ money(state.order.totalAmountCents) }}</dd>
              </div>
              <div>
                <dt>Recebido</dt>
                <dd>{{ money(state.receivedAmountCents) }}</dd>
              </div>
              <div>
                <dt>Saldo a receber</dt>
                <dd>{{ money(due) }}</dd>
              </div>
            </dl>
            <section
              v-if="intent"
              class="billing-preview-progress"
              aria-label="Andamento do envio"
            >
              <div class="billing-preview-status">
                <AppIcon
                  :name="
                    uncertain || intent.state === 'failed'
                      ? 'alert'
                      : intent.state === 'delivered'
                        ? 'check'
                        : 'info'
                  "
                /><strong role="status" aria-live="polite">{{
                  statuses[intent.state]
                }}</strong>
              </div>
              <p v-if="pending">
                Você pode fechar esta janela. A simulação continua e o histórico
                fica disponível ao voltar.
              </p>
              <p v-else-if="uncertain">
                O envio pode ter ocorrido. Confira a conversa antes de qualquer
                nova tentativa. Não será reenviado automaticamente.
              </p>
              <p v-else-if="intent.state === 'failed'">
                Falha comprovada antes do envio. É possível revisar outra
                tentativa com o mesmo link válido.
              </p>
              <p v-else>
                O resultado do envio é separado do pagamento. Entrega da
                mensagem não significa recebimento.
              </p>
              <button
                v-if="intent.safeRetry && !current?.paid && !current?.expired"
                type="button"
                @click="navigate('retry-review')"
              >
                Revisar nova tentativa
              </button>
            </section>
            <p v-if="!due" role="status" class="billing-preview-status">
              <AppIcon name="check" /> Pedido quitado. Não há saldo para outra
              cobrança.
            </p>
            <template v-else-if="!pending && !uncertain">
              <section v-if="active" class="billing-preview-progress">
                <h3>Cobrança em aberto: {{ money(current.amountCents) }}</h3>
                <p>
                  Use o link existente. Outra cobrança fica bloqueada enquanto
                  este link estiver ativo.
                </p>
                <div class="inline-actions">
                  <button
                    v-if="!intent"
                    type="button"
                    class="primary"
                    @click="navigate('existing-review')"
                  >
                    Revisar envio do link
                  </button>
                  <button type="button" @click="navigate('correct')">
                    Corrigir cobrança
                  </button>
                </div>
              </section>
              <form v-else @submit.prevent="navigate('review')">
                <fieldset class="billing-preview-options">
                  <legend>O que você quer cobrar?</legend>
                  <label
                    ><input
                      v-model="mode"
                      type="radio"
                      value="signal"
                      :disabled="state.receivedAmountCents > 0"
                    />
                    Sinal</label
                  >
                  <label
                    ><input
                      v-model="mode"
                      type="radio"
                      value="full"
                      :disabled="state.receivedAmountCents > 0"
                    />
                    Valor integral</label
                  >
                  <label
                    ><input
                      v-model="mode"
                      type="radio"
                      value="balance"
                      :disabled="!state.receivedAmountCents"
                    />
                    Saldo restante</label
                  >
                </fieldset>
                <div v-if="mode === 'signal'" class="billing-preview-percent">
                  <label for="billing-preview-percent"
                    >Sinal combinado (%)</label
                  ><input
                    id="billing-preview-percent"
                    v-model="percent"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                  />
                </div>
                <p
                  v-if="mode === 'signal' && Number(percent) === 0"
                  role="status"
                >
                  Sem entrada não gera cobrança. Para cobrar tudo agora, escolha
                  Valor integral.
                </p>
                <p v-else>
                  Valor desta cobrança: <strong>{{ money(value) }}</strong
                  >. Restante após o pagamento:
                  <strong>{{ money(due - value) }}</strong
                  >.
                </p>
                <div class="inline-actions">
                  <button
                    v-if="current && !current.paid"
                    type="button"
                    @click="navigate('correct')"
                  >
                    Corrigir cobrança anterior
                  </button>
                  <button
                    type="submit"
                    class="primary"
                    :disabled="!validValue(value) || busy"
                  >
                    Revisar cobrança
                  </button>
                </div>
              </form>
            </template>
            <details
              class="billing-preview-history"
              :open="state.charges.length > 0"
            >
              <summary>
                Histórico de cobranças ({{ state.charges.length }})
              </summary>
              <p v-if="!state.charges.length" class="muted">
                Nenhuma cobrança gerada para este pedido.
              </p>
              <ol v-else>
                <li
                  v-for="charge in [...state.charges].reverse()"
                  :key="charge.id"
                >
                  <div class="billing-preview-history-head">
                    <strong
                      >Cobrança {{ String(charge.number).padStart(2, '0') }} ·
                      {{ money(charge.amountCents) }}</strong
                    ><span>{{
                      charge.paid
                        ? 'Pagamento confirmado'
                        : charge.closed
                          ? 'Vencida e encerrada'
                          : 'Aguardando pagamento'
                    }}</span>
                  </div>
                  <p>
                    {{
                      charge.kind === 'balance'
                        ? 'Saldo'
                        : charge.kind === 'full'
                          ? 'Integral'
                          : 'Sinal'
                    }}<template v-if="charge.supersedesChargeId">
                      · Corrige a cobrança anterior</template
                    >
                  </p>
                  <button
                    class="link-button"
                    type="button"
                    @click="notice = 'Link fictício preservado: ' + charge.url"
                  >
                    Ver link {{ charge.closed ? 'anterior' : 'da cobrança' }}
                  </button>
                  <p class="muted">
                    {{ charge.closed ? 'Venceu' : 'Válido até' }}
                    {{ date(charge.validUntil) }}.
                    {{
                      charge.closed
                        ? 'O link e seu histórico foram preservados.'
                        : 'Uso único.'
                    }}
                  </p>
                </li>
              </ol>
            </details>
            <details class="billing-preview-controls">
              <summary>Controles da avaliação</summary>
              <p class="muted">
                Simulam respostas externas apenas nesta prévia.
              </p>
              <label for="billing-preview-scenario">Cenário</label>
              <select
                id="billing-preview-scenario"
                v-model="scenario"
                @change="reset"
              >
                <option value="new">Pedido sem cobrança</option>
                <option value="existing">
                  Link existente, ainda não enviado
                </option>
                <option value="signal-paid">Sinal pago → cobrar saldo</option>
                <option value="expired">Link vencido → corrigir valor</option>
                <option value="before-send-failure">
                  Falha comprovada antes do envio
                </option>
                <option value="unknown">Resultado do envio incerto</option>
              </select>
              <div class="inline-actions">
                <button
                  type="button"
                  :disabled="!current || current.paid || pending"
                  @click="expire"
                >
                  Simular vencimento e encerramento</button
                ><button
                  type="button"
                  :disabled="!current || current.paid || pending"
                  @click="pay"
                >
                  Simular pagamento confirmado
                </button>
              </div>
            </details>
          </template>
          <template v-else-if="step === 'correct'">
            <p>
              Pedido <strong>{{ state.order.number }}</strong
              >. A cobrança anterior de
              <strong>{{ money(current?.amountCents) }}</strong> será preservada
              no histórico.
            </p>
            <div class="billing-preview-progress">
              <strong>O link anterior não é cancelado pela correção.</strong>
              <p>
                Na InfinitePay, a API não cancela um link já criado. Uma nova
                cobrança exige que o anterior tenha vencido, esteja encerrado e
                não tenha pagamento.
              </p>
            </div>
            <p v-if="!current?.expired || !current?.closed" role="alert">
              O link anterior ainda está válido. Aguarde o vencimento e confira
              a cobrança. Nesta avaliação, use os controles abaixo para simular
              essa etapa.
            </p>
            <button
              v-if="!current?.expired || !current?.closed"
              type="button"
              @click="expire"
            >
              Simular vencimento e encerramento
            </button>
            <label for="billing-preview-correction"
              >Novo valor combinado (R$)</label
            ><input
              id="billing-preview-correction"
              v-model="correctionAmount"
              inputmode="decimal"
            />
            <p>
              Limitado ao saldo de {{ money(due) }}. O total comercial do pedido
              continua {{ money(state.order.totalAmountCents) }}.
            </p>
            <label class="billing-preview-check"
              ><input v-model="agreement" type="checkbox" /> Combinei este novo
              valor com o cliente.</label
            >
            <label class="billing-preview-check"
              ><input v-model="review" type="checkbox" /> Conferi na
              InfinitePay: cobrança anterior vencida, encerrada e sem
              pagamento.</label
            >
            <div class="inline-actions">
              <button type="button" @click="navigate('choose')">
                Voltar ao histórico</button
              ><button
                type="button"
                class="primary"
                :disabled="!canCorrect || busy"
                @click="navigate('correct-review')"
              >
                Revisar correção
              </button>
            </div>
          </template>
          <template v-else>
            <dl class="billing-preview-review">
              <div>
                <dt>Destino</dt>
                <dd>{{ state.customer }} · conversa atual</dd>
              </div>
              <div>
                <dt>Pedido</dt>
                <dd>{{ state.order.number }} · {{ state.order.name }}</dd>
              </div>
              <div>
                <dt>Valor da cobrança</dt>
                <dd>{{ money(reviewAmount) }}</dd>
              </div>
              <div>
                <dt>Saldo após este pagamento</dt>
                <dd>{{ money(due - reviewAmount) }}</dd>
              </div>
              <div>
                <dt>Pagamento</dt>
                <dd>Pix ou cartão no checkout InfinitePay</dd>
              </div>
            </dl>
            <p
              v-if="step === 'correct-review'"
              class="billing-preview-progress"
            >
              Será gerado um link novo para {{ money(reviewAmount) }}. O link
              anterior permanece no histórico como vencido e encerrado.
            </p>
            <p
              v-if="step === 'existing-review' || step === 'retry-review'"
              class="billing-preview-progress"
            >
              Será usado o mesmo link de {{ money(reviewAmount) }}. Nenhuma nova
              cobrança será criada.
            </p>
            <h3>Mensagem na conversa</h3>
            <blockquote class="billing-preview-message">
              Pedido {{ state.order.number }} — {{ reviewKind }} de
              {{ money(reviewAmount) }}. Link para pagamento:
              <span>{{
                step === 'existing-review' || step === 'retry-review'
                  ? current?.url
                  : '[link gerado após a confirmação]'
              }}</span>
            </blockquote>
            <p class="muted">
              Seu rascunho no chat será preservado. Enviar a cobrança não
              confirma pagamento.
            </p>
            <div class="inline-actions">
              <button
                type="button"
                :disabled="busy"
                @click="
                  navigate(step === 'correct-review' ? 'correct' : 'choose')
                "
              >
                Voltar</button
              ><button
                type="button"
                class="primary"
                :disabled="busy"
                @click="submit"
              >
                {{
                  busy
                    ? 'Confirmando…'
                    : step === 'existing-review' || step === 'retry-review'
                      ? 'Enviar este link na conversa'
                      : 'Gerar e enviar cobrança'
                }}
              </button>
            </div>
          </template>
        </template>
      </dialog></Teleport
    >
  </div>
</template>

<style scoped>
.conversation-shipping-action {
  display: contents;
}
.conversation-shipping-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.conversation-shipping-head h2 {
  margin: 0;
}
.billing-chat-preview-dialog {
  box-sizing: border-box;
  inline-size: min(42rem, calc(100vw - var(--space-6)));
  max-inline-size: min(42rem, calc(100vw - var(--space-6)));
  max-block-size: calc(100dvh - var(--space-8));
  overflow: auto;
  padding: var(--space-5);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.billing-chat-preview-dialog::backdrop {
  background: var(--color-overlay);
}
.billing-chat-preview-dialog form {
  display: block;
  margin: 0;
  padding: 0;
}
.billing-chat-preview-dialog > label {
  display: block;
  margin-block: var(--space-3) var(--space-1);
}
.billing-chat-preview-dialog > select,
.billing-chat-preview-dialog > input {
  inline-size: 100%;
}
.billing-chat-preview-dialog h2:focus {
  outline: none;
}
.billing-chat-preview-dialog p {
  line-height: 1.6;
}
.billing-chat-preview-dialog h3 {
  font-size: var(--text-base);
}
.billing-preview-disclaimer {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.billing-preview-disclaimer .app-icon {
  flex: 0 0 auto;
}
.billing-preview-totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin-block: var(--space-5);
}
.billing-preview-totals div {
  border-block-end: 1px solid var(--color-border);
  padding-block-end: var(--space-3);
}
.billing-preview-totals dt,
.billing-preview-review dt {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.billing-preview-totals dd {
  margin: var(--space-1) 0 0;
  font-weight: 600;
  font-size: var(--text-lg);
  font-variant-numeric: tabular-nums;
}
.billing-preview-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border: 0;
}
.billing-preview-options label,
.billing-preview-check {
  display: flex;
  align-items: start;
  gap: var(--space-2);
}
.billing-preview-options legend {
  margin-block-end: var(--space-2);
  font-weight: 600;
}
.billing-preview-options input,
.billing-preview-check input {
  inline-size: auto;
  flex: 0 0 auto;
  margin-block-start: var(--space-1);
}
.billing-preview-check {
  margin-block: var(--space-4);
}
.billing-preview-percent input {
  max-inline-size: 8rem;
}
.billing-preview-progress {
  margin-block: var(--space-4);
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.billing-preview-progress p:last-child {
  margin-block-end: 0;
}
.billing-preview-status {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.billing-preview-history,
.billing-preview-controls {
  margin-block-start: var(--space-5);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border);
}
.billing-preview-history summary,
.billing-preview-controls summary {
  cursor: pointer;
  font-weight: 500;
  padding-block: var(--space-2);
}
.billing-preview-history ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
.billing-preview-history li {
  padding-block: var(--space-4);
  border-block-end: 1px solid var(--color-border-subtle);
}
.billing-preview-history-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: space-between;
}
.billing-preview-history-head span {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.billing-preview-history p {
  margin-block: var(--space-2);
}
.billing-preview-review {
  display: grid;
  gap: var(--space-4);
  margin-block: var(--space-5);
}
.billing-preview-review dd {
  margin: var(--space-1) 0 0;
  font-weight: 500;
}
.billing-preview-message {
  margin: var(--space-3) 0;
  padding: var(--space-4);
  border-inline-start: 3px solid var(--color-border-strong);
  background: var(--color-surface-raised);
  overflow-wrap: anywhere;
}
.billing-chat-preview-dialog .inline-actions {
  margin-block: var(--space-4);
}
.muted {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
@media (max-width: 480px) {
  .billing-preview-totals {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
  .billing-preview-totals div {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    align-items: baseline;
  }
  .billing-preview-totals dd {
    font-size: var(--text-base);
  }
  .billing-chat-preview-dialog .inline-actions > button {
    flex: 1 1 100%;
  }
}
</style>
