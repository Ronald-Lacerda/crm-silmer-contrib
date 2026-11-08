<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import {
  amountLabel,
  AUDIENCE_OPTIONS,
  formatBrl,
  itemHeading,
  itemQuantityWarning,
  parseBrl,
} from '../../lib/order-format.js';
import OrderSheetHead from './OrderSheetHead.vue';

const props = defineProps({ order: { type: Object, required: true } });
const editing = inject('orderEditing');
const sheet = ref(null);
const form = ref(null);
const title = ref(null);
const saving = ref(false);
const error = ref('');
const stale = ref(false);
const announcement = ref('');
const action = ref(null);
const text = ref('');
const sizeText = ref('');
const quantityText = ref('1');
const attributes = ref({});
const previousColors = ref({});
const optionalColorFields = new Set([
  'cor_manga_direita',
  'cor_manga_esquerda',
  'vies_mangas',
]);
let opener = null;

const ATTRIBUTE_FIELDS = Object.freeze([
  { key: 'tipo', label: 'Tipo de roupa' },
  { key: 'cor', label: 'Cor' },
  { key: 'tipo_servico', label: 'Aplicação' },
  { key: 'gola', label: 'Gola' },
  { key: 'modelo', label: 'Modelo' },
  { key: 'estampa', label: 'Estampa (referência)' },
  { key: 'cor_frente', label: 'Cor do tecido — frente' },
  { key: 'cor_costas', label: 'Cor do tecido — costas' },
  { key: 'cor_manga_direita', label: 'Cor do tecido — manga direita' },
  { key: 'cor_manga_esquerda', label: 'Cor do tecido — manga esquerda' },
  { key: 'vies_gola', label: 'Viés da gola' },
  { key: 'vies_mangas', label: 'Viés das mangas' },
]);
const groups = computed(() => props.order.ficha.sizePricing);
const open = computed(() => editing.isSectionOpen?.('items') ?? true);
const canEdit = computed(
  () => editing.canEdit.value && props.order.status === 'pendente',
);
const isEditing = computed(() => editing.editingSection.value === 'items');
const blocked = computed(() => editing.editingSection.value !== '');
const attributesForm = computed(() =>
  ['update_group', 'add_group'].includes(action.value?.action),
);
const total = computed(() => amountLabel(props.order.pricing?.totalCents));
const selectedTitle = computed(() => action.value?.title ?? 'Editar itens');
const currentContext = computed(() => action.value?.context ?? '');
const isQuantity = computed(() => action.value?.action === 'change_quantity');
const isSubtotal = computed(() => action.value?.action === 'review_subtotal');
const isSize = computed(() =>
  ['add_line', 'rename_line'].includes(action.value?.action),
);

function blankAttributes(item = {}) {
  const result = Object.fromEntries(
    ATTRIBUTE_FIELDS.map(({ key }) => [key, item[key] ?? '']),
  );
  return {
    ...result,
    publico: item.publico ?? '',
    quantidade_informada: item.quantidade_informada ?? '',
    malhas: item.malhas?.length ? [...item.malhas] : [''],
  };
}
function groupTotal(groupId) {
  return amountLabel(
    props.order.pricing?.groups?.find((group) => group.id === groupId)
      ?.subtotalCents,
  );
}
function context(index, line) {
  return `item ${index + 1}, tamanho ${line.size}`;
}
async function begin(command, label, event, details = {}) {
  if (!canEdit.value || blocked.value || saving.value) return;
  opener = event?.currentTarget ?? null;
  action.value = { ...command, title: label, ...details };
  text.value = details.text ?? '';
  sizeText.value = details.size ?? '';
  quantityText.value = String(details.quantity ?? 1);
  attributes.value = blankAttributes(details.item);
  previousColors.value = {};
  error.value = '';
  stale.value = false;
  editing.start('items');
  await nextTick();
  form.value?.querySelector('input, select, button')?.focus();
}
async function cancel() {
  if (saving.value) return;
  const trigger = opener;
  action.value = null;
  error.value = '';
  stale.value = false;
  editing.stop();
  await nextTick();
  if (trigger?.isConnected) trigger.focus();
  else title.value?.focus();
}
function toggleNotApplicable(key, event) {
  if (event.target.checked) {
    previousColors.value[key] = attributes.value[key];
    attributes.value[key] = 'NAO APLICAVEL';
  } else attributes.value[key] = previousColors.value[key] ?? '';
}
function positiveQuantity(value) {
  if (!/^\d+$/u.test(String(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 && result <= 2147483647
    ? result
    : null;
}
function command() {
  const {
    title: _title,
    context: _context,
    text: _text,
    size: _size,
    quantity: _quantity,
    item: _item,
    ...value
  } = action.value;
  if (isQuantity.value || value.action === 'add_line') {
    const quantity = positiveQuantity(quantityText.value);
    if (quantity === null)
      throw new Error('Use uma quantidade inteira maior que zero.');
    value.quantity = quantity;
  }
  if (isSize.value) {
    const size = sizeText.value.trim();
    if (!size || size.length > 200)
      throw new Error('Informe um tamanho com até 200 caracteres.');
    if (
      groups.value
        .find((group) => group.id === value.groupId)
        ?.lines.some((line) => line.size === size && line.id !== value.lineId)
    )
      throw new Error(
        'Este tamanho já existe neste item. Revise a linha existente.',
      );
    value.size = size;
  }
  if (isSubtotal.value) {
    const subtotalCents =
      text.value.trim() === '' ? null : parseBrl(text.value);
    if (text.value.trim() !== '' && subtotalCents === null)
      throw new Error('Use um subtotal maior que zero no formato 4.820,00.');
    value.subtotalCents = subtotalCents;
  }
  if (attributesForm.value) {
    const informedText = String(attributes.value.quantidade_informada).trim();
    const informed =
      informedText === '' ? null : positiveQuantity(informedText);
    if (informedText !== '' && (informed === null || informed > 100000))
      throw new Error('Use uma quantidade informada inteira de 1 a 100000.');
    const attrs = {
      ...attributes.value,
      quantidade_informada: informed,
      malhas: attributes.value.malhas
        .map((value) => value.trim())
        .filter(Boolean),
    };
    if (value.action === 'update_group') value.attributes = attrs;
    else value.item = { ...attrs, grade: [] };
  }
  return value;
}
async function save() {
  if (saving.value || stale.value || !canEdit.value || !action.value) return;
  error.value = '';
  let value;
  try {
    value = command();
  } catch (cause) {
    error.value = cause.message;
    await nextTick();
    form.value?.querySelector('[role="alert"]')?.focus();
    return;
  }
  saving.value = true;
  const result = await editing.save('size-pricing', value);
  saving.value = false;
  if (result.ok) {
    announcement.value =
      value.action === 'change_quantity' ||
      value.action === 'rename_line' ||
      value.action === 'update_group' ||
      value.action === 'duplicate_group'
        ? 'Alteração salva. Revise os subtotais dos tamanhos alterados antes de confirmar o pedido.'
        : `Alteração salva. Total calculado: ${total.value}.`;
    await cancel();
    return;
  }
  stale.value =
    [
      'VERSION_CONFLICT',
      'ORDER_VERSION_CONFLICT',
      'SIZE_PRICING_CONFLICT',
    ].includes(result.code) || result.status === 409;
  error.value =
    result.message ||
    'Não foi possível salvar. Cancele a edição e confira o pedido atual.';
  await nextTick();
  form.value?.querySelector('[role="alert"]')?.focus();
}
function moveGroup(index, delta, event) {
  const ids = groups.value.map((group) => group.id);
  [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
  begin(
    { action: 'reorder_groups', groupIds: ids },
    `Mover item ${index + 1} ${delta < 0 ? 'para cima' : 'para baixo'}`,
    event,
  );
}
function moveLine(group, index, delta, event) {
  const ids = group.lines.map((line) => line.id);
  [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
  begin(
    { action: 'reorder_lines', groupId: group.id, lineIds: ids },
    `Mover tamanho ${group.lines[index].size} ${delta < 0 ? 'para cima' : 'para baixo'}`,
    event,
  );
}
watch(canEdit, (allowed) => {
  if (!allowed && action.value) {
    saving.value = false;
    void cancel();
  }
});
watch(
  () => editing.editRequest?.value,
  (request) => {
    if (request?.section !== 'items') return;
    sheet.value?.scrollIntoView?.({ block: 'start' });
    nextTick(() => title.value?.focus());
  },
);
</script>

<template>
  <section
    ref="sheet"
    class="op-sheet"
    :data-editing="isEditing || undefined"
    aria-labelledby="order-items-title"
  >
    <OrderSheetHead
      title-id="order-items-title"
      title="Itens e especificações"
      :state="`${groups.length} itens · total ${total}`"
      :tone="order.pricing?.complete ? 'ok' : 'missing'"
      section="items"
      body-id="order-items-body"
    />
    <div
      id="order-items-body"
      class="op-sheet-body op-priced-items"
      :hidden="!open"
    >
      <p
        id="size-pricing-instructions"
        ref="title"
        tabindex="-1"
        class="op-hint"
      >
        Informe o subtotal negociado para todas as peças de cada tamanho. O
        total é calculado pelo servidor.
      </p>
      <p class="op-visually-hidden" role="status">{{ announcement }}</p>
      <form
        v-if="action"
        ref="form"
        class="op-form op-priced-form"
        novalidate
        :aria-label="selectedTitle"
        :aria-busy="saving || undefined"
        @submit.prevent="save"
        @keydown.esc.prevent="cancel"
      >
        <h3>{{ selectedTitle }}</h3>
        <p
          v-if="error"
          id="size-pricing-error"
          role="alert"
          tabindex="-1"
          class="op-alert"
        >
          {{ error }}
        </p>
        <fieldset :disabled="saving || stale">
          <legend class="op-visually-hidden">{{ selectedTitle }}</legend>
          <div v-if="attributesForm" class="op-item-fields">
            <div
              v-for="field in ATTRIBUTE_FIELDS"
              :key="field.key"
              class="op-field"
            >
              <label :for="`priced-${field.key}`">{{ field.label }}</label>
              <input
                :id="`priced-${field.key}`"
                v-model="attributes[field.key]"
                :disabled="
                  optionalColorFields.has(field.key) &&
                  attributes[field.key] === 'NAO APLICAVEL'
                "
                type="text"
                maxlength="200"
                autocomplete="off"
              />
              <label
                v-if="optionalColorFields.has(field.key)"
                class="op-input-row"
                ><input
                  type="checkbox"
                  :checked="attributes[field.key] === 'NAO APLICAVEL'"
                  @change="toggleNotApplicable(field.key, $event)"
                />Não aplicável</label
              >
            </div>
            <div class="op-field">
              <label for="priced-audience">Público</label>
              <select id="priced-audience" v-model="attributes.publico">
                <option value="">Não informado</option>
                <option
                  v-for="option in AUDIENCE_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </div>
            <div class="op-field">
              <label for="priced-informed">Quantidade informada</label>
              <input
                id="priced-informed"
                v-model="attributes.quantidade_informada"
                type="text"
                inputmode="numeric"
                aria-describedby="priced-informed-hint"
              />
              <p id="priced-informed-hint" class="op-hint">
                O que o cliente disse; não entra no total.
              </p>
            </div>
            <div class="op-field op-field--wide">
              <span class="op-label">Modelo de malha</span>
              <div
                v-for="(_, index) in attributes.malhas"
                :key="index"
                class="op-input-row"
              >
                <input
                  v-model="attributes.malhas[index]"
                  type="text"
                  maxlength="200"
                  :aria-label="`Modelo de malha ${index + 1}`"
                />
                <button
                  v-if="attributes.malhas.length > 1"
                  type="button"
                  :aria-label="`Remover modelo de malha ${index + 1}`"
                  @click="attributes.malhas.splice(index, 1)"
                >
                  Remover
                </button>
              </div>
              <button
                type="button"
                class="op-add-inline"
                @click="attributes.malhas.push('')"
              >
                Adicionar modelo de malha
              </button>
            </div>
            <p
              v-if="action.action === 'update_group'"
              class="op-hint op-field--wide"
            >
              Alterar os atributos exige nova revisão dos subtotais deste item.
            </p>
          </div>
          <div v-if="isSize" class="op-field">
            <label for="priced-size">Tamanho do {{ currentContext }}</label>
            <input
              id="priced-size"
              v-model="sizeText"
              type="text"
              maxlength="200"
              :aria-invalid="Boolean(error) || undefined"
              :aria-describedby="error ? 'size-pricing-error' : undefined"
            />
          </div>
          <div
            v-if="isQuantity || action.action === 'add_line'"
            class="op-field"
          >
            <label for="priced-quantity"
              >Quantidade do {{ currentContext }}</label
            >
            <input
              id="priced-quantity"
              v-model="quantityText"
              type="text"
              inputmode="numeric"
              :aria-invalid="Boolean(error) || undefined"
              :aria-describedby="
                error ? 'size-pricing-error' : 'priced-quantity-hint'
              "
            />
            <p id="priced-quantity-hint" class="op-hint">
              Salvar a quantidade exige revisar o subtotal em uma ação separada.
              O valor anterior não é recalculado.
            </p>
          </div>
          <div v-if="isSubtotal" class="op-field">
            <label for="priced-subtotal"
              >Subtotal do {{ currentContext }}</label
            >
            <input
              id="priced-subtotal"
              v-model="text"
              type="text"
              inputmode="decimal"
              :aria-invalid="Boolean(error) || undefined"
              :aria-describedby="
                error ? 'size-pricing-error' : 'priced-subtotal-hint'
              "
            />
            <p id="priced-subtotal-hint" class="op-hint">
              Valor de todas as peças deste tamanho. Deixe vazio para salvar o
              rascunho sem preço.
            </p>
          </div>
          <p
            v-if="!attributesForm && !isQuantity && !isSubtotal && !isSize"
            class="op-hint"
          >
            Salve para aplicar esta alteração à composição do pedido.
          </p>
        </fieldset>
        <div class="op-form-actions">
          <button type="button" :disabled="saving" @click="cancel">
            Cancelar
          </button>
          <button type="submit" :disabled="saving || stale">
            {{
              saving
                ? 'Salvando…'
                : isSubtotal
                  ? 'Salvar subtotal revisado'
                  : 'Salvar alteração'
            }}
          </button>
        </div>
      </form>
      <div
        v-for="(group, index) in groups"
        :key="group.id"
        class="op-priced-group"
        :data-group-id="group.id"
      >
        <h3>{{ itemHeading(order.ficha.items[index], index) }}</h3>
        <p v-if="itemQuantityWarning(order.ficha.items[index])" class="op-hint">
          {{ itemQuantityWarning(order.ficha.items[index]) }}
        </p>
        <dl class="op-priced-attributes">
          <div
            v-for="field in ATTRIBUTE_FIELDS.filter((field) =>
              ['tipo', 'cor', 'tipo_servico', 'gola'].includes(field.key),
            )"
            :key="field.key"
          >
            <dt>{{ field.label }}</dt>
            <dd>
              {{
                order.ficha.items[index]?.[field.key] === 'NAO APLICAVEL'
                  ? 'NÃO APLICÁVEL'
                  : order.ficha.items[index]?.[field.key] || '—'
              }}
            </dd>
          </div>
          <div>
            <dt>Modelo de malha</dt>
            <dd>{{ order.ficha.items[index]?.malhas?.join(' / ') || '—' }}</dd>
          </div>
        </dl>
        <div class="op-priced-table-wrap">
          <table class="op-priced-table">
            <caption class="op-visually-hidden">
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
              <template v-for="(line, lineIndex) in group.lines" :key="line.id">
                <tr :data-line-id="line.id">
                  <th scope="row">{{ line.size }}</th>
                  <td class="op-num">{{ line.quantity }}</td>
                  <td class="op-num">
                    {{ amountLabel(line.subtotalCents)
                    }}<span
                      v-if="line.subtotalCents === null"
                      class="op-priced-review"
                      >Falta subtotal</span
                    ><span
                      v-else-if="!line.subtotalReviewed"
                      class="op-priced-review"
                      >Revisar subtotal</span
                    >
                  </td>
                </tr>
                <tr v-if="canEdit">
                  <td colspan="3">
                    <div class="op-priced-actions">
                      <button
                        type="button"
                        :disabled="blocked"
                        :aria-label="`Alterar quantidade do ${context(index, line)}`"
                        @click="
                          begin(
                            {
                              action: 'change_quantity',
                              groupId: group.id,
                              lineId: line.id,
                            },
                            'Alterar quantidade',
                            $event,
                            {
                              context: context(index, line),
                              quantity: line.quantity,
                            },
                          )
                        "
                      >
                        Alterar quantidade
                      </button>
                      <button
                        type="button"
                        :disabled="blocked"
                        :aria-label="`Revisar subtotal do ${context(index, line)}`"
                        @click="
                          begin(
                            {
                              action: 'review_subtotal',
                              groupId: group.id,
                              lineId: line.id,
                            },
                            'Revisar subtotal',
                            $event,
                            {
                              context: context(index, line),
                              text: formatBrl(line.subtotalCents),
                            },
                          )
                        "
                      >
                        Revisar subtotal
                      </button>
                      <details>
                        <summary>
                          Mais ações<span class="op-visually-hidden">
                            do {{ context(index, line) }}</span
                          >
                        </summary>
                        <div class="op-priced-actions">
                          <button
                            type="button"
                            :disabled="blocked"
                            @click="
                              begin(
                                {
                                  action: 'rename_line',
                                  groupId: group.id,
                                  lineId: line.id,
                                },
                                'Renomear tamanho',
                                $event,
                                {
                                  context: context(index, line),
                                  size: line.size,
                                },
                              )
                            "
                          >
                            Renomear tamanho
                          </button>
                          <button
                            type="button"
                            :disabled="blocked"
                            @click="
                              begin(
                                {
                                  action: 'remove_line',
                                  groupId: group.id,
                                  lineId: line.id,
                                },
                                `Remover tamanho ${line.size} do item ${index + 1}`,
                                $event,
                              )
                            "
                          >
                            Remover tamanho
                          </button>
                          <button
                            v-if="lineIndex > 0"
                            type="button"
                            :disabled="blocked"
                            @click="moveLine(group, lineIndex, -1, $event)"
                          >
                            Mover tamanho para cima
                          </button>
                          <button
                            v-if="lineIndex < group.lines.length - 1"
                            type="button"
                            :disabled="blocked"
                            @click="moveLine(group, lineIndex, 1, $event)"
                          >
                            Mover tamanho para baixo
                          </button>
                        </div>
                      </details>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-if="!group.lines.length">
                <td colspan="3">Nenhum tamanho neste item.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="op-num">
          Subtotal do item {{ index + 1 }}:
          <strong>{{ groupTotal(group.id) }}</strong>
        </p>
        <div v-if="canEdit" class="op-priced-actions">
          <button
            type="button"
            :disabled="blocked"
            :aria-label="`Editar atributos do item ${index + 1}`"
            @click="
              begin(
                { action: 'update_group', groupId: group.id },
                `Editar atributos do item ${index + 1}`,
                $event,
                { item: order.ficha.items[index] },
              )
            "
          >
            Editar atributos
          </button>
          <button
            type="button"
            :disabled="blocked"
            :aria-label="`Adicionar tamanho ao item ${index + 1}`"
            @click="
              begin(
                { action: 'add_line', groupId: group.id },
                `Adicionar tamanho ao item ${index + 1}`,
                $event,
                { context: `item ${index + 1}` },
              )
            "
          >
            Adicionar tamanho
          </button>
          <details>
            <summary>
              Mais ações<span class="op-visually-hidden">
                do item {{ index + 1 }}</span
              >
            </summary>
            <div class="op-priced-actions">
              <button
                type="button"
                :disabled="blocked"
                @click="
                  begin(
                    { action: 'duplicate_group', groupId: group.id },
                    `Duplicar item ${index + 1}`,
                    $event,
                  )
                "
              >
                Duplicar item {{ index + 1 }}
              </button>
              <button
                type="button"
                :disabled="blocked"
                @click="
                  begin(
                    { action: 'remove_group', groupId: group.id },
                    `Remover item ${index + 1}`,
                    $event,
                  )
                "
              >
                Remover item {{ index + 1 }}
              </button>
              <button
                v-if="index > 0"
                type="button"
                :disabled="blocked"
                @click="moveGroup(index, -1, $event)"
              >
                Mover item para cima
              </button>
              <button
                v-if="index < groups.length - 1"
                type="button"
                :disabled="blocked"
                @click="moveGroup(index, 1, $event)"
              >
                Mover item para baixo
              </button>
            </div>
          </details>
        </div>
        <details class="op-priced-extras">
          <summary>Adicionais (não obrigatórios)</summary>
          <dl class="op-priced-attributes">
            <div
              v-for="field in ATTRIBUTE_FIELDS.filter(
                (field) =>
                  !['tipo', 'cor', 'tipo_servico', 'gola'].includes(field.key),
              )"
              :key="field.key"
            >
              <dt>{{ field.label }}</dt>
              <dd>
                {{
                  order.ficha.items[index]?.[field.key] === 'NAO APLICAVEL'
                    ? 'NÃO APLICÁVEL'
                    : order.ficha.items[index]?.[field.key] || '—'
                }}
              </dd>
            </div>
            <div>
              <dt>Público</dt>
              <dd>
                {{
                  AUDIENCE_OPTIONS.find(
                    (option) =>
                      option.value === order.ficha.items[index]?.publico,
                  )?.label || '—'
                }}
              </dd>
            </div>
            <div>
              <dt>Quantidade informada</dt>
              <dd>
                {{ order.ficha.items[index]?.quantidade_informada ?? '—' }}
              </dd>
            </div>
          </dl>
        </details>
      </div>
      <p v-if="!groups.length" class="op-empty">Nenhum item no pedido ainda.</p>
      <button
        v-if="canEdit && groups.length < 50"
        type="button"
        class="op-add-inline"
        :disabled="blocked"
        @click="begin({ action: 'add_group' }, 'Adicionar item', $event)"
      >
        Adicionar item
      </button>
      <p class="op-num">
        Total do pedido: <strong>{{ total }}</strong>
      </p>
      <p v-if="!order.pricing?.complete" class="op-hint">
        O total fica pendente até todos os tamanhos terem subtotal revisado. O
        rascunho continua salvo.
      </p>
    </div>
  </section>
</template>

<style scoped>
.op-priced-items,
.op-priced-group,
.op-priced-form,
.op-priced-form fieldset {
  display: grid;
  gap: var(--space-4);
  min-inline-size: 0;
}
.op-priced-group + .op-priced-group {
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border);
}
.op-priced-group h3,
.op-priced-form h3,
.op-priced-group p {
  margin: 0;
}
.op-priced-form {
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border-radius: var(--radius-md);
}
.op-priced-form fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}
.op-priced-attributes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3) var(--space-4);
  margin: 0;
}
.op-priced-attributes dt {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.op-priced-attributes dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.op-priced-table {
  inline-size: 100%;
  table-layout: fixed;
  border-collapse: collapse;
}
.op-priced-table th,
.op-priced-table td {
  padding: var(--space-2) var(--space-1);
  text-align: start;
  vertical-align: top;
  overflow-wrap: anywhere;
  border-block-end: 1px solid var(--color-border-subtle);
}
.op-priced-table thead {
  font-size: var(--text-sm);
}
.op-priced-review {
  display: block;
  color: var(--status-warning-text);
  font-size: var(--text-sm);
}
.op-priced-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.op-priced-actions button,
.op-priced-actions summary,
.op-priced-extras > summary {
  min-block-size: var(--target-min);
}
.op-priced-actions button {
  max-inline-size: 100%;
  white-space: normal;
}
.op-priced-actions summary,
.op-priced-extras > summary {
  display: list-item;
  align-content: center;
  cursor: pointer;
}
.op-priced-actions details > div {
  padding-block: var(--space-2);
}
.op-priced-form input:not([type='checkbox']),
.op-priced-form select {
  min-inline-size: 0;
  inline-size: 100%;
}
@media (max-width: 480px) {
  .op-priced-table {
    table-layout: auto;
    font-size: var(--text-xs);
  }
  .op-priced-table thead,
  .op-priced-review {
    font-size: var(--text-xs);
  }
  .op-priced-table th[scope='col'] {
    overflow-wrap: normal;
  }
  .op-priced-attributes {
    grid-template-columns: minmax(0, 1fr);
  }
  .op-priced-form {
    padding: var(--space-3);
  }
  .op-priced-actions {
    align-items: stretch;
  }
}
</style>
