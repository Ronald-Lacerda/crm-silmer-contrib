<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  useId,
  watch,
} from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import {
  BRAZILIAN_STATES,
  normalizeContactRegistration,
  REGISTRATION_FIELDS,
} from '../../lib/contact-registration.js';
import { amountLabel, formatBrl } from '../../lib/order-format.js';

// T12: supplemental values are kept beside, never in, a historical ficha.
const props = defineProps({
  order: { type: Object, required: true },
  canEdit: { type: Boolean, default: false },
});
const emit = defineEmits(['changed']);
const editing = inject('orderEditing', null);
const uid = useId();
const source = ref(null);
const loading = ref(false);
const saving = ref(false);
const formOpen = ref(false);
const conflict = ref(false);
const denied = ref(false);
const error = ref('');
const message = ref('');
const alert = ref(null);
const form = ref(null);
const trigger = ref(null);
const title = ref(null);
const expectedVersion = ref(0);
const lineDrafts = ref([]);
const deliveryOn = ref('');
const applications = ref([]);
const registration = reactive(
  Object.fromEntries(REGISTRATION_FIELDS.map((key) => [key, ''])),
);
const errors = ref({});
let controller;
let disposed = false;
let pendingRefresh = false;
let attempt = { fingerprint: '', key: '' };
const isStore = computed(() => props.order.origin === 'loja');
const allowed = computed(
  () => props.canEdit && !props.order.cancelledAt && !denied.value,
);
const otherEditing = computed(() =>
  Boolean(
    editing?.editingSection.value &&
    editing.editingSection.value !== 'price-breakdown',
  ),
);
const groups = computed(() => source.value?.groups ?? []);
const total = computed(() =>
  source.value?.sourceValid ? source.value.pricing?.totalCents : null,
);
const registrationFields = [
  { key: 'document', label: 'CPF ou CNPJ', limit: 18 },
  { key: 'legalName', label: 'Nome completo ou razão social', limit: 150 },
  { key: 'stateRegistration', label: 'Inscrição estadual', limit: 18 },
  { key: 'postalCode', label: 'CEP', limit: 9 },
  { key: 'street', label: 'Endereço', limit: 150 },
  { key: 'number', label: 'Número', limit: 10 },
  { key: 'district', label: 'Bairro', limit: 80 },
  { key: 'city', label: 'Cidade', limit: 80 },
  { key: 'complement', label: 'Complemento', limit: 80 },
  { key: 'instagram', label: 'Instagram', limit: 150 },
];
const fieldLabels = Object.fromEntries(
  registrationFields.map((field) => [field.key, field.label]),
);

function fieldId(key) {
  return `${uid}-${key}`;
}
async function focus(target) {
  await nextTick();
  if (!disposed) target.value?.focus();
}
function clearDraft() {
  lineDrafts.value = [];
  applications.value = [];
  deliveryOn.value = '';
  for (const key of REGISTRATION_FIELDS) registration[key] = '';
  errors.value = {};
}
function closeEditor() {
  formOpen.value = false;
  clearDraft();
  if (editing?.editingSection.value === 'price-breakdown') editing.stop();
}
function invalidate() {
  controller?.abort();
  controller = undefined;
  loading.value = false;
  saving.value = false;
  source.value = null;
  closeEditor();
}
function failure(cause) {
  if ([401, 403].includes(Number(cause?.status))) {
    denied.value = true;
    source.value = null;
    closeEditor();
    return 'Seu acesso mudou ou sua sessão expirou. Entre novamente para continuar.';
  }
  if (cause?.code === 'SIZE_PRICING_AMOUNT_MISMATCH')
    return 'A soma dos subtotais deve ser igual ao valor histórico. Confira cada tamanho; o valor do pedido não será alterado.';
  if (cause?.status === 409) {
    conflict.value = true;
    return 'O pedido mudou. Cancele a edição e confira a composição atual antes de salvar.';
  }
  if (cause?.status === 429)
    return 'Aguarde um momento antes de consultar novamente.';
  if ([400, 422].includes(Number(cause?.status)))
    return 'Confira os campos informados. Nenhum complemento foi salvo.';
  return 'Não foi possível concluir a operação. Consulte a composição antes de tentar salvar novamente.';
}
async function load() {
  if (saving.value || formOpen.value || denied.value) return;
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loading.value = true;
  error.value = '';
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.order.id)}/price-breakdown`,
      { signal: own.signal },
    );
    if (disposed || own.signal.aborted || controller !== own) return;
    source.value = response.data;
    conflict.value = false;
    pendingRefresh = false;
  } catch (cause) {
    if (disposed || own.signal.aborted || controller !== own) return;
    source.value = null;
    error.value = failure(cause);
  } finally {
    if (controller === own && !disposed) loading.value = false;
  }
}
async function begin() {
  if (
    !allowed.value ||
    otherEditing.value ||
    saving.value ||
    loading.value ||
    !source.value?.sourceValid
  )
    return;
  expectedVersion.value = source.value.orderVersion;
  lineDrafts.value = groups.value.flatMap((group, groupIndex) =>
    group.lines.map((line) => ({
      groupId: group.id,
      lineId: line.id,
      groupIndex,
      size: line.size,
      text: formatBrl(line.subtotalCents),
    })),
  );
  deliveryOn.value =
    source.value.details?.deliveryOn ??
    props.order.ficha?.summary?.data_entrega_confirmada ??
    '';
  applications.value = groups.value.map((group, index) => ({
    groupId: group.id,
    application:
      source.value.details?.applications?.find(
        (entry) => entry.groupId === group.id,
      )?.application ??
      props.order.ficha?.items?.[index]?.tipo_servico ??
      '',
  }));
  for (const key of REGISTRATION_FIELDS)
    registration[key] = source.value.details?.registration?.[key] ?? '';
  errors.value = {};
  error.value = '';
  message.value = '';
  conflict.value = false;
  attempt = { fingerprint: '', key: '' };
  editing?.start('price-breakdown');
  formOpen.value = true;
  await nextTick();
  form.value?.querySelector('input:not([readonly]), select')?.focus();
}
async function cancel() {
  if (saving.value) return;
  const refresh = conflict.value || pendingRefresh;
  closeEditor();
  conflict.value = false;
  error.value = '';
  if (refresh) await load();
  await focus(trigger);
}
// Parse cents without a floating-point round trip near the safe-integer limit.
function cents(text) {
  if (text.trim() === '') return null;
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/u.test(text.trim()))
    return undefined;
  const [reais, fraction = ''] = text.trim().split(',');
  const value =
    BigInt(reais.replaceAll('.', '')) * 100n + BigInt(fraction.padEnd(2, '0'));
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : undefined;
}
async function saveValue(value, version) {
  if (!allowed.value || saving.value || conflict.value || otherEditing.value)
    return;
  const own = new AbortController();
  controller?.abort();
  controller = own;
  saving.value = true;
  error.value = '';
  message.value = '';
  const body = { expectedVersion: version, value };
  const fingerprint = JSON.stringify(body);
  if (attempt.fingerprint !== fingerprint)
    attempt = { fingerprint, key: commandKey() };
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.order.id)}/price-breakdown`,
      {
        method: 'POST',
        body,
        idempotencyKey: attempt.key,
        signal: own.signal,
      },
    );
    if (disposed || own.signal.aborted || own !== controller || !allowed.value)
      return;
    source.value = response.data;
    closeEditor();
    conflict.value = false;
    message.value =
      'Complemento salvo. A ficha e o valor histórico do pedido foram preservados.';
    emit('changed', response.data);
    await focus(title);
  } catch (cause) {
    if (disposed || own.signal.aborted || own !== controller) return;
    error.value = failure(cause);
    await focus(alert);
  } finally {
    if (controller === own && !disposed) saving.value = false;
  }
}
async function initialize() {
  if (formOpen.value || !source.value || loading.value) return;
  await saveValue({ action: 'initialize' }, source.value.orderVersion);
}
async function save() {
  if (!formOpen.value || saving.value || conflict.value || !allowed.value)
    return;
  const nextErrors = {};
  let value;
  if (isStore.value) {
    const normalized = normalizeContactRegistration(registration);
    if (!normalized.ok) {
      for (const key of Object.keys(normalized.errors))
        nextErrors[`registration-${key}`] =
          `Confira ${fieldLabels[key] ?? 'o tipo de pessoa'}.`;
    }
    if (deliveryOn.value && !/^\d{4}-\d{2}-\d{2}$/u.test(deliveryOn.value))
      nextErrors.deliveryOn = 'Informe uma data válida ou deixe em branco.';
    value = {
      action: 'set_store_details',
      deliveryOn: deliveryOn.value || null,
      applications: applications.value.map((entry) => ({
        groupId: entry.groupId,
        application: entry.application.trim() || null,
      })),
      registration: normalized.ok ? normalized.value : null,
    };
  } else {
    value = {
      action: 'set_subtotals',
      lines: lineDrafts.value.map((line) => {
        const subtotalCents = cents(line.text);
        if (subtotalCents === undefined)
          nextErrors[line.lineId] =
            'Informe um subtotal positivo, como 120,00, ou deixe em branco.';
        return {
          groupId: line.groupId,
          lineId: line.lineId,
          subtotalCents: subtotalCents ?? null,
        };
      }),
    };
  }
  errors.value = nextErrors;
  if (Object.keys(nextErrors).length) {
    error.value =
      'Confira os campos indicados. O complemento ainda não foi salvo.';
    await focus(alert);
    return;
  }
  await saveValue(value, expectedVersion.value);
}
function issueLabel(issue) {
  const code = String(issue.code ?? '');
  const known = {
    LEGACY_PRICE_BREAKDOWN_REQUIRED:
      'Informe os subtotais negociados por tamanho, sem dividir automaticamente o valor histórico.',
    STORE_ORDER_COMPLEMENT_REQUIRED: 'Prepare o complemento do pedido da loja.',
    ORDER_SOURCE_STALE:
      'O pedido mudou. Prepare novamente o complemento a partir dos dados atuais.',
    STORE_DELIVERY_REQUIRED: 'Informe a previsão de entrega no complemento.',
    STORE_APPLICATION_REQUIRED: 'Informe a aplicação do item no complemento.',
    STORE_ARTWORK_REQUIRED:
      'A origem da arte precisa de conferência no pedido de origem.',
    STORE_ITEM_FIELD_REQUIRED:
      'Há especificações ausentes na ficha original; peça a conferência da operação.',
  };
  if (known[code]) return known[code];
  if (code === 'STORE_BUYER_FIELD_REQUIRED')
    return `Complete o cadastro: ${fieldLabels[String(issue.field).replace('registration.', '')] ?? 'tipo de pessoa'}.`;
  for (const [index, group] of groups.value.entries()) {
    const line = group.lines.find((entry) =>
      String(issue.field).endsWith(entry.id),
    );
    if (line)
      return `Item ${index + 1}, tamanho ${line.size}: ${code === 'SIZE_SUBTOTAL_REVIEW_REQUIRED' ? 'revise o subtotal' : 'informe o subtotal'}.`;
  }
  return 'Confira os dados complementares antes da prévia Olist.';
}
function groupSubtotal(id) {
  return source.value?.sourceValid
    ? source.value.pricing?.groups?.find((group) => group.id === id)
        ?.subtotalCents
    : null;
}
watch(
  () => [props.order.id, props.order.version],
  (next, previous) => {
    if (!previous || next[0] !== previous[0]) {
      invalidate();
      denied.value = false;
      void load();
    } else if (formOpen.value) {
      pendingRefresh = true;
      conflict.value = true;
      error.value =
        'O pedido mudou durante a edição. Cancele e confira a composição atual.';
    } else void load();
  },
  { immediate: true },
);
watch(
  () => props.canEdit,
  (allowedNow, previous) => {
    if (!allowedNow && previous) {
      invalidate();
      denied.value = true;
      error.value =
        'Seu acesso mudou. Atualize a página para conferir suas permissões.';
    }
  },
);
onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
  closeEditor();
});
</script>

<template>
  <section
    class="op-sheet order-source"
    :aria-labelledby="fieldId('title')"
    :aria-busy="loading || saving"
  >
    <div class="op-sheet-head">
      <h2 :id="fieldId('title')" ref="title" tabindex="-1">
        Complemento para o Olist
      </h2>
      <button
        v-if="source?.sourceValid && allowed && !formOpen"
        ref="trigger"
        type="button"
        :aria-disabled="otherEditing || loading || saving || undefined"
        @click="begin"
      >
        Editar complemento
      </button>
    </div>
    <div class="op-sheet-body">
      <p class="op-hint">
        {{
          isStore
            ? 'Dados complementares para a conferência Olist. Itens, checkout e pagamento da loja permanecem preservados.'
            : 'Os subtotais negociados são registrados separadamente. A ficha e o valor histórico permanecem preservados.'
        }}
      </p>
      <p v-if="loading" role="status">Consultando complemento…</p>
      <p v-if="error" ref="alert" role="alert" tabindex="-1" class="op-alert">
        {{ error }}
      </p>
      <p v-if="message" role="status">{{ message }}</p>
      <button v-if="!source && !loading && !denied" type="button" @click="load">
        Consultar complemento novamente
      </button>
      <template v-if="source">
        <p v-if="!source.sourceValid" class="op-hint">
          Nenhum complemento atual conferido. Valores anteriores não são usados
          para exportação.
        </p>
        <button
          v-if="!source.sourceValid && allowed"
          type="button"
          :disabled="loading || saving || otherEditing"
          @click="initialize"
        >
          {{ saving ? 'Preparando…' : 'Preparar complemento' }}
        </button>
        <ul
          v-if="source.issues?.length && !formOpen"
          class="order-source-issues"
        >
          <li
            v-for="issue in source.issues"
            :key="`${issue.code}:${issue.field}`"
          >
            {{ issueLabel(issue) }}
          </li>
        </ul>
        <form
          v-if="formOpen"
          ref="form"
          class="op-form"
          novalidate
          @submit.prevent="save"
          @keydown.esc.prevent="cancel"
        >
          <p class="op-hint">
            Campos vazios podem ser salvos como pendência. Salvar não cria
            cadastro nem venda no Olist.
          </p>
          <template v-if="!isStore">
            <div
              v-for="line in lineDrafts"
              :key="line.lineId"
              class="op-field order-source-line"
            >
              <label :for="fieldId(line.lineId)"
                >Subtotal do item {{ line.groupIndex + 1 }}, tamanho
                {{ line.size }}</label
              >
              <input
                :id="fieldId(line.lineId)"
                v-model="line.text"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                :disabled="saving"
                :aria-invalid="Boolean(errors[line.lineId]) || undefined"
                :aria-describedby="
                  errors[line.lineId]
                    ? fieldId(`${line.lineId}-error`)
                    : undefined
                "
              />
              <p
                v-if="errors[line.lineId]"
                :id="fieldId(`${line.lineId}-error`)"
                class="op-field-error"
              >
                {{ errors[line.lineId] }}
              </p>
            </div>
            <p class="op-hint">
              A soma precisa preservar
              {{ amountLabel(order.finalAmountCents) }}, o valor histórico do
              pedido. Nenhum preço é inferido.
            </p>
          </template>
          <template v-else>
            <div class="order-source-grid">
              <div class="op-field">
                <label :for="fieldId('delivery')"
                  >Previsão de entrega complementar</label
                >
                <input
                  :id="fieldId('delivery')"
                  v-model="deliveryOn"
                  type="date"
                  :readonly="
                    Boolean(order.ficha?.summary?.data_entrega_confirmada)
                  "
                  :disabled="saving"
                  :aria-invalid="Boolean(errors.deliveryOn) || undefined"
                  :aria-describedby="
                    errors.deliveryOn ? fieldId('delivery-error') : undefined
                  "
                />
                <p
                  v-if="errors.deliveryOn"
                  :id="fieldId('delivery-error')"
                  class="op-field-error"
                >
                  {{ errors.deliveryOn }}
                </p>
              </div>
              <div
                v-for="(application, index) in applications"
                :key="application.groupId"
                class="op-field"
              >
                <label :for="fieldId(application.groupId)"
                  >Aplicação complementar do item {{ index + 1 }}</label
                >
                <input
                  :id="fieldId(application.groupId)"
                  v-model="application.application"
                  type="text"
                  maxlength="200"
                  :readonly="
                    Boolean(order.ficha?.items?.[index]?.tipo_servico?.trim())
                  "
                  :disabled="saving"
                />
              </div>
            </div>
            <fieldset class="order-source-registration">
              <legend>Cadastro do comprador</legend>
              <p class="op-hint">
                Informe dados conferidos com o comprador. Preencha ISENTO
                somente quando declarado.
              </p>
              <div class="order-source-grid">
                <div class="op-field">
                  <label :for="fieldId('registration-personType')"
                    >Tipo de pessoa</label
                  >
                  <select
                    :id="fieldId('registration-personType')"
                    v-model="registration.personType"
                    :disabled="saving"
                    :aria-invalid="
                      Boolean(errors['registration-personType']) || undefined
                    "
                    :aria-describedby="
                      errors['registration-personType']
                        ? fieldId('registration-personType-error')
                        : undefined
                    "
                  >
                    <option value="">Não informado</option>
                    <option value="individual">Pessoa física</option>
                    <option value="company">Pessoa jurídica</option>
                  </select>
                  <p
                    v-if="errors['registration-personType']"
                    :id="fieldId('registration-personType-error')"
                    class="op-field-error"
                  >
                    {{ errors['registration-personType'] }}
                  </p>
                </div>
                <div
                  v-for="field in registrationFields"
                  :key="field.key"
                  class="op-field"
                >
                  <label :for="fieldId(`registration-${field.key}`)">{{
                    field.label
                  }}</label>
                  <input
                    :id="fieldId(`registration-${field.key}`)"
                    v-model="registration[field.key]"
                    type="text"
                    :maxlength="field.limit"
                    :disabled="saving"
                    :aria-invalid="
                      Boolean(errors[`registration-${field.key}`]) || undefined
                    "
                    :aria-describedby="
                      errors[`registration-${field.key}`]
                        ? fieldId(`registration-${field.key}-error`)
                        : undefined
                    "
                  />
                  <p
                    v-if="errors[`registration-${field.key}`]"
                    :id="fieldId(`registration-${field.key}-error`)"
                    class="op-field-error"
                  >
                    {{ errors[`registration-${field.key}`] }}
                  </p>
                </div>
                <div class="op-field">
                  <label :for="fieldId('registration-state')">UF</label>
                  <select
                    :id="fieldId('registration-state')"
                    v-model="registration.state"
                    :disabled="saving"
                    :aria-invalid="
                      Boolean(errors['registration-state']) || undefined
                    "
                    :aria-describedby="
                      errors['registration-state']
                        ? fieldId('registration-state-error')
                        : undefined
                    "
                  >
                    <option value="">Não informada</option>
                    <option
                      v-for="state in BRAZILIAN_STATES"
                      :key="state"
                      :value="state"
                    >
                      {{ state }}
                    </option>
                  </select>
                  <p
                    v-if="errors['registration-state']"
                    :id="fieldId('registration-state-error')"
                    class="op-field-error"
                  >
                    {{ errors['registration-state'] }}
                  </p>
                </div>
              </div>
            </fieldset>
          </template>
          <div class="order-source-actions">
            <button
              class="primary"
              type="submit"
              :disabled="saving || conflict"
            >
              {{ saving ? 'Salvando…' : 'Salvar complemento' }}
            </button>
            <button type="button" :disabled="saving" @click="cancel">
              Cancelar complemento
            </button>
          </div>
        </form>
        <template v-else-if="groups.length">
          <div
            v-for="(group, index) in groups"
            :key="group.id"
            class="order-source-group"
          >
            <h3>
              Item {{ index + 1 }} ·
              {{ order.ficha?.items?.[index]?.tipo || 'Peça' }}
            </h3>
            <table>
              <caption class="sr-only">
                Composição complementar do item
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
                <tr v-for="line in group.lines" :key="line.id">
                  <th scope="row">{{ line.size }}</th>
                  <td class="op-num">{{ line.quantity }}</td>
                  <td class="op-num">
                    {{
                      source.sourceValid && line.subtotalReviewed
                        ? amountLabel(line.subtotalCents)
                        : '—'
                    }}
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colspan="2">Subtotal do item</th>
                  <td class="op-num">
                    {{ amountLabel(groupSubtotal(group.id)) }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p class="order-source-total" role="status">
            Total conferido:
            <strong class="op-num">{{ amountLabel(total) }}</strong>
          </p>
          <p v-if="total === null" class="op-hint">
            Total indisponível até a revisão de todos os subtotais.
          </p>
        </template>
        <dl
          v-if="isStore && source.sourceValid && !formOpen"
          class="order-source-details"
        >
          <div>
            <dt>Previsão de entrega complementar</dt>
            <dd>
              {{
                source.details?.deliveryOn ||
                order.ficha?.summary?.data_entrega_confirmada ||
                'Não informada'
              }}
            </dd>
          </div>
          <div
            v-for="(application, index) in source.details?.applications ?? []"
            :key="application.groupId"
          >
            <dt>Aplicação do item {{ index + 1 }}</dt>
            <dd>
              {{
                order.ficha?.items?.[index]?.tipo_servico ||
                application.application ||
                'Não informada'
              }}
            </dd>
          </div>
          <div>
            <dt>Cadastro complementar</dt>
            <dd>
              {{ source.details?.registration?.legalName || 'Não informado' }}
            </dd>
          </div>
        </dl>
        <p v-if="!allowed && !formOpen" class="op-hint">
          {{
            isStore
              ? 'Somente um administrador pode completar os dados da loja.'
              : 'Peça ao responsável pelo pedido ou a um administrador para completar os subtotais.'
          }}
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.order-source {
  margin-block: var(--space-4);
}
.order-source .op-sheet-head {
  flex-wrap: wrap;
}
.order-source .op-sheet-body {
  display: grid;
  gap: var(--space-4);
}
.order-source p {
  margin: 0;
  overflow-wrap: anywhere;
}
.order-source-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr);
}
.order-source-line {
  margin-block: var(--space-4);
}
.order-source-registration {
  border: 0;
  margin: var(--space-4) 0;
  padding: 0;
  min-inline-size: 0;
}
.order-source-registration legend {
  margin-block-end: var(--space-3);
  font-weight: 600;
}
.order-source-registration .op-hint {
  margin-block-end: var(--space-4);
}
.order-source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-block-start: var(--space-4);
}
.order-source :is(button, input, select) {
  min-block-size: var(--target-min);
}
.order-source :is(input, select) {
  inline-size: 100%;
  min-inline-size: 0;
}
.order-source-group {
  min-inline-size: 0;
}
.order-source-group h3 {
  font-size: var(--text-base);
}
.order-source table {
  inline-size: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.order-source :is(th, td) {
  padding: var(--space-2);
  border-block-end: 1px solid var(--color-border-subtle);
  text-align: start;
  overflow-wrap: anywhere;
}
.order-source .op-num {
  font-variant-numeric: tabular-nums;
}
.order-source-details {
  display: grid;
  gap: var(--space-3);
  margin: 0;
}
.order-source-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.order-source-total {
  font-weight: 600;
}
@media (max-width: 480px) {
  .order-source table {
    table-layout: auto;
    font-size: var(--text-xs);
  }
  .order-source th,
  .order-source td {
    padding: var(--space-1);
  }
  .order-source th[scope='col'] {
    overflow-wrap: normal;
  }
}
@media (min-width: 769px) {
  .order-source-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
