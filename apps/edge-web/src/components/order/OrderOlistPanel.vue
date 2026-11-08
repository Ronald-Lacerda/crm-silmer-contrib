<script setup>
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import {
  amountLabel,
  dayLabel,
  paymentConditionLabel,
} from '../../lib/order-format.js';
import {
  olistIssueLabel,
  olistFailure,
  registrationAction,
} from '../../lib/olist-feedback.js';

const props = defineProps({
  orderId: { type: String, required: true },
  revision: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['operation']);
const user = inject('sessionUser', ref({}));
const liveEvent = inject('liveEvent', ref(null));
const canOperate = computed(() => user.value.olistEnabled === true);
const projection = ref(null);
const preview = ref(null);
const busy = ref(false);
const message = ref('');
const error = ref('');
const denied = ref(false);
const notice = ref(null);
let controller;
let disposed = false;
let expiration = 0;
const base = computed(
  () => `/api/v1/orders/${encodeURIComponent(props.orderId)}/olist`,
);
const hasOperation = computed(() => Boolean(projection.value?.operation));
const operationLabel = computed(() => {
  const state = projection.value?.operation?.state;
  if (state === 'confirmed' || state === 'linked')
    return 'Venda Olist conferida';
  if (
    ['outcome_unknown', 'divergent', 'reconciliation_required'].includes(state)
  )
    return 'Operação bloqueada para conferência administrativa';
  return 'Operação Olist em acompanhamento';
});
const expiryLabel = computed(() => {
  const stamp = Date.parse(preview.value?.expiresAt ?? '');
  return Number.isFinite(stamp)
    ? new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }).format(stamp)
    : '';
});

function clearPreview() {
  if (expiration) globalThis.clearTimeout(expiration);
  expiration = 0;
  preview.value = null;
  message.value = '';
}
function invalidate() {
  controller?.abort();
  controller = undefined;
  busy.value = false;
  clearPreview();
}
async function focusNotice() {
  await nextTick();
  if (!disposed) notice.value?.focus();
}
/** Only the current request may publish data, including after access changes. */
async function run(path, body, focusError = true) {
  if (busy.value || props.disabled || denied.value) return;
  const own = new AbortController();
  controller?.abort();
  controller = own;
  const id = props.orderId;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const response = await request(`${base.value}${path}`, {
      signal: own.signal,
      ...(body === undefined
        ? {}
        : { method: 'POST', body, idempotencyKey: commandKey() }),
    });
    if (
      disposed ||
      own.signal.aborted ||
      controller !== own ||
      props.orderId !== id
    )
      return;
    return response.data;
  } catch (cause) {
    if (disposed || own.signal.aborted || controller !== own) return;
    clearPreview();
    if ([401, 403].includes(Number(cause?.status))) {
      denied.value = true;
      projection.value = null;
      emit('operation', { unavailable: true });
    }
    error.value = olistFailure(cause);
    if (focusError) await focusNotice();
  } finally {
    if (controller === own && !disposed) busy.value = false;
  }
}
async function load(interactive = false) {
  if (props.disabled || denied.value || busy.value) return;
  clearPreview();
  const data = await run('', undefined, interactive);
  if (!data) return;
  projection.value = data;
  emit('operation', data.operation ?? null);
}
async function confer() {
  if (!canOperate.value || busy.value || props.disabled || hasOperation.value)
    return;
  clearPreview();
  const data = await run('/preview', {});
  if (!data || !canOperate.value) return;
  preview.value = data;
  if (data.previewToken && data.expiresAt) {
    const remaining = Date.parse(data.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      clearPreview();
      error.value =
        'A prévia expirou. Confira uma nova prévia antes de continuar.';
    } else {
      expiration = globalThis.setTimeout(
        () => {
          clearPreview();
          error.value =
            'A prévia expirou. Confira uma nova prévia antes de continuar.';
        },
        Math.min(remaining, 900000),
      );
    }
  }
  await focusNotice();
}
async function validate() {
  if (
    !canOperate.value ||
    !preview.value?.previewToken ||
    busy.value ||
    props.disabled ||
    hasOperation.value
  )
    return;
  const data = await run('/preview/check', {
    previewToken: preview.value.previewToken,
  });
  if (!data || !canOperate.value) return;
  if (data.valid !== true) {
    clearPreview();
    error.value = 'A prévia mudou. Confira novamente os dados do pedido.';
  } else
    message.value = 'Prévia validada. A geração de vendas continua desativada.';
  await focusNotice();
}
watch(
  () => [props.orderId, props.revision],
  () => {
    invalidate();
    projection.value = null;
    denied.value = false;
    void load();
  },
  { immediate: true },
);
watch(
  () => props.disabled,
  (disabled) => {
    invalidate();
    if (!disabled) void load();
  },
);
watch(
  () => [
    user.value.id,
    user.value.olistEnabled,
    user.value.olistAuthorizationVersion,
  ],
  () => {
    invalidate();
    projection.value = null;
    denied.value = !canOperate.value;
    if (!denied.value) void load();
  },
);
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    [
      'inbox.order.changed',
      'inbox.contact.changed',
      'identity.user.changed',
    ].includes(event?.type)
  ) {
    invalidate();
    // Explicit refresh avoids ERP polling and never reuses a receipt after a live change.
    error.value =
      'Os dados ou o acesso podem ter mudado. Atualize a preparação e confira uma nova prévia.';
  }
});
onBeforeUnmount(() => {
  disposed = true;
  invalidate();
});
</script>

<template>
  <section
    class="op-sheet olist-preparation"
    :aria-labelledby="`olist-preparation-${orderId}`"
    :aria-busy="busy"
  >
    <div class="op-sheet-head">
      <h2 :id="`olist-preparation-${orderId}`">Preparação para o Olist</h2>
      <p v-if="projection">
        Pedido {{ projection.number }} ·
        {{ projection.status === 'confirmado' ? 'Confirmado' : 'Pendente' }}
      </p>
    </div>
    <div class="op-sheet-body">
      <p>
        A geração de vendas está desativada. Conferir a prévia consulta os
        cadastros e não cria cliente, produto ou venda no Olist.
      </p>
      <p v-if="!canOperate" class="field-help">
        Seu usuário não está habilitado para conferir a prévia Olist.
      </p>
      <p v-if="disabled" class="field-help">
        Salve ou cancele a edição aberta antes de conferir.
      </p>
      <p v-if="busy" role="status">Conferindo a preparação…</p>
      <div v-if="error || message || preview" ref="notice" tabindex="-1">
        <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <template v-if="preview && !denied">
          <h3>
            {{
              preview.eligible
                ? 'Prévia pronta para conferência'
                : 'Pendências para o Olist'
            }}
          </h3>
          <ul v-if="preview.issues?.length">
            <li
              v-for="(issue, index) in preview.issues"
              :key="`${issue.code}:${issue.field}:${index}`"
            >
              {{ olistIssueLabel(issue, preview.commercial?.groups) }}
            </li>
          </ul>
          <p v-if="preview.issues?.length" class="field-help">
            Peça a uma pessoa autorizada a corrigir o pedido, o cadastro de
            origem ou os parâmetros. A habilitação Olist não concede edição.
          </p>
          <dl class="olist-preview-summary">
            <div v-if="preview.customer">
              <dt>Comprador</dt>
              <dd>
                {{ preview.customer.name }} · documento final
                {{ preview.customer.documentSuffix }}
              </dd>
            </div>
            <div>
              <dt>Data da venda Olist</dt>
              <dd>
                {{ dayLabel(preview.commercial?.orderDate) || 'Não definida' }}
              </dd>
            </div>
            <div>
              <dt>Entrega prometida</dt>
              <dd>
                {{
                  dayLabel(preview.commercial?.deliveryOn) || 'Não informada'
                }}
              </dd>
            </div>
            <div>
              <dt>Forma de pagamento</dt>
              <dd>
                {{
                  paymentConditionLabel(preview.commercial?.paymentCondition)
                }}
              </dd>
            </div>
            <div>
              <dt>Total do pedido</dt>
              <dd>{{ amountLabel(preview.commercial?.totalCents) }}</dd>
            </div>
          </dl>
          <p class="field-help">
            Exportar um pedido pendente não o confirma no CRM. A data da venda é
            conferida novamente ao aceitar o comando.
          </p>
          <section
            v-for="(group, index) in preview.commercial?.groups ?? []"
            :key="group.groupId"
            class="olist-preview-group"
            :aria-labelledby="`olist-group-${group.groupId}`"
          >
            <h3 :id="`olist-group-${group.groupId}`">
              Item {{ index + 1 }} · {{ group.attributes?.garment }} ·
              {{ group.attributes?.color }}
            </h3>
            <table>
              <caption class="sr-only">
                Tamanhos e subtotais do item
                {{
                  index + 1
                }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tamanho</th>
                  <th scope="col">Quantidade</th>
                  <th scope="col">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in group.lines" :key="line.lineId">
                  <th scope="row">{{ line.size }}</th>
                  <td>{{ line.quantity }}</td>
                  <td>{{ amountLabel(line.subtotalCents) }}</td>
                </tr>
              </tbody>
            </table>
          </section>
          <section v-if="preview.registrations" aria-label="Plano de cadastros">
            <h3>Plano de cadastros</h3>
            <p>
              Comprador:
              {{ registrationAction(preview.registrations.customer?.action) }}
            </p>
            <ul>
              <li
                v-for="(group, index) in preview.registrations.groups ?? []"
                :key="group.groupId"
              >
                Item {{ index + 1 }}: {{ registrationAction(group.action) }}
                <ul>
                  <li v-for="line in group.lines ?? []" :key="line.lineId">
                    Tamanho
                    {{
                      preview.commercial?.groups
                        ?.find((item) => item.groupId === group.groupId)
                        ?.lines?.find((item) => item.lineId === line.lineId)
                        ?.size || 'não conferido'
                    }}: {{ registrationAction(line.action) }}
                  </li>
                </ul>
              </li>
            </ul>
          </section>
          <p v-if="expiryLabel" class="field-help">
            Prévia válida até {{ expiryLabel }} (São Paulo). Mudanças no pedido,
            cadastro, configuração ou acesso exigem nova conferência.
          </p>
        </template>
      </div>
      <template v-if="hasOperation && !denied">
        <p>
          {{ operationLabel
          }}<span v-if="projection.operation.number">
            · Venda {{ projection.operation.number }}</span
          >
        </p>
        <p class="field-help">
          Não repita a geração. A conferência e a recuperação da operação são
          administrativas.
        </p>
      </template>
      <div class="form-actions">
        <button
          type="button"
          :disabled="busy || disabled || denied"
          @click="load(true)"
        >
          Atualizar preparação
        </button>
        <button
          v-if="canOperate && !denied && !hasOperation"
          type="button"
          :disabled="busy || disabled"
          @click="confer"
        >
          Conferir prévia Olist
        </button>
        <button
          v-if="
            canOperate &&
            preview?.eligible &&
            preview?.previewToken &&
            !hasOperation
          "
          type="button"
          :disabled="busy || disabled"
          @click="validate"
        >
          Validar prévia
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.olist-preparation {
  margin-block: var(--space-6);
  min-inline-size: 0;
}
.olist-preparation .op-sheet-body {
  display: grid;
  gap: var(--space-4);
}
.olist-preparation p {
  margin: 0;
}
.olist-preparation h3 {
  font-size: var(--text-base);
  margin-block: var(--space-4) var(--space-2);
}
.olist-preview-summary {
  display: grid;
  gap: var(--space-3);
}
.olist-preview-summary dt {
  color: var(--color-text-muted);
}
.olist-preview-summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.olist-preview-group {
  min-inline-size: 0;
}
.olist-preview-group table {
  inline-size: 100%;
  table-layout: fixed;
  font-variant-numeric: tabular-nums;
}
.olist-preview-group th,
.olist-preview-group td {
  overflow-wrap: anywhere;
  padding: var(--space-2);
  text-align: start;
}
.olist-preparation .form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.olist-preparation button {
  min-block-size: var(--target-min);
}
@media (width <= 30rem) {
  .olist-preview-group table {
    table-layout: auto;
    font-size: var(--text-xs);
  }
  .olist-preview-group th,
  .olist-preview-group td {
    padding: var(--space-1);
  }
  .olist-preview-group th[scope='col'] {
    overflow-wrap: normal;
  }
  .olist-preparation .form-actions {
    display: grid;
  }
}
</style>
