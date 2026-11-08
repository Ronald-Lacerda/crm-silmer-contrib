<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { colorSwatch } from '../../lib/order-catalog.js';
import {
  AUDIENCE_OPTIONS,
  duplicateSizeWarning,
  isDuplicateSize,
  itemHeading,
  itemPieces,
  itemQuantityLabel,
  itemQuantityWarning,
  orderSteps,
  sortedGrade,
} from '../../lib/order-format.js';
import OrderIcon from './OrderIcon.vue';
import OrderSheetHead from './OrderSheetHead.vue';
import OrderPricedItemsSection from './OrderPricedItemsSection.vue';

const SECTION = 'items';
// The value the ficha prints when a garment has no sleeve or no viés (PFI-07).
const NOT_APPLICABLE = 'NAO APLICAVEL';
const NOT_APPLICABLE_LABEL = 'NÃO APLICÁVEL';
const GRADE_MESSAGE = 'Use uma quantidade inteira maior que zero.';
const EXTRAS_LABEL = 'Adicionais (não obrigatórios)';

// PIT-02 (ADR 016/020): what the seller may add to an item. None of it
// blocks the order. The print is a reference of what goes where; who makes
// the art is the order's ("Arte do pedido"). The part colours are the
// fabric's, never the art's colour count of the production sheet. Only
// sleeves and sleeve trim accept "Não aplicável" (PFI-07): a shirt without
// sleeves still has a front and a back.
const EXTRA_FIELDS = Object.freeze([
  Object.freeze({
    hint: 'O que vai estampado e onde, se ajudar a produção.',
    key: 'estampa',
    label: 'Estampa (referência)',
    text: true,
  }),
  Object.freeze({
    color: true,
    key: 'cor_frente',
    label: 'Cor do tecido — frente',
  }),
  Object.freeze({
    color: true,
    key: 'cor_costas',
    label: 'Cor do tecido — costas',
  }),
  Object.freeze({
    color: true,
    key: 'cor_manga_direita',
    label: 'Cor do tecido — manga direita',
    optional: true,
  }),
  Object.freeze({
    color: true,
    key: 'cor_manga_esquerda',
    label: 'Cor do tecido — manga esquerda',
    optional: true,
  }),
  Object.freeze({
    color: true,
    key: 'vies_mangas',
    label: 'Viés das mangas',
    optional: true,
  }),
]);

const props = defineProps({
  order: { type: Object, required: true },
});

const editing = inject('orderEditing');
const form = ref(null);
const draft = ref([]);
const saving = ref(false);
const initializing = ref(false);
const hasPricing = computed(() => Array.isArray(props.order.ficha.sizePricing));
const errorMessage = ref('');
/** @type {import('vue').Ref<Record<string, string>>} */
const lineErrors = ref({});
/** ADR 025: what a screen reader hears after "Duplicar item". */
const announcement = ref('');
/** Which "Adicionais" blocks are open, by `read-N` or `edit-N`. */
/** @type {import('vue').Ref<Record<string, boolean>>} */
const extrasOpen = ref({});

const isEditing = computed(
  () => editing.editingSection.value === SECTION && !initializing.value,
);
const canEdit = computed(
  () =>
    !hasPricing.value &&
    !initializing.value &&
    editing.canEdit.value &&
    props.order.status === 'pendente',
);
const otherSectionOpen = computed(
  () => editing.editingSection.value !== '' && !isEditing.value,
);
// PFI-18: on a phone the body is shown only while the accordion opens it.
const open = computed(() => editing.isSectionOpen?.(SECTION) ?? true);
const items = computed(() =>
  isEditing.value ? draft.value : shownItems.value,
);
const shownItems = computed(() => props.order.ficha.items);
// PFI-04: every total is summed from the sizes, in reading and while
// editing, so the seller sees the number the server will store before saving.
const draftTotal = computed(() =>
  items.value.reduce((total, item) => total + itemPieces(item), 0),
);
const headline = computed(() => {
  const count = items.value.length;
  return `${count} ${count === 1 ? 'item' : 'itens'} · ${draftTotal.value} peças`;
});
// PFI-17: what the items still owe to "Gerar", in the words of the progress
// (PFI-15); with nothing missing, how many items and pieces there are.
const headState = computed(() => {
  const step = orderSteps(props.order).find((one) => one.key === 'items');
  if (step && !step.done) {
    return {
      text: step.missing.charAt(0).toUpperCase() + step.missing.slice(1),
      tone: 'missing',
    };
  }
  return { text: headline.value, tone: items.value.length ? 'ok' : 'neutral' };
});

/** @param {unknown} value */
function shownValue(value) {
  if (value === NOT_APPLICABLE) return NOT_APPLICABLE_LABEL;
  return value || '—';
}

/**
 * The colour chip beside a part, when the text names a catalog colour.
 *
 * @param {unknown} value
 */
function swatchOf(value) {
  if (value === NOT_APPLICABLE) return '';
  return colorSwatch(value);
}

/** Historical front/back colours imply a whole garment colour only when equal. */
function itemColor(item) {
  return (
    item.cor ||
    (item.cor_frente && item.cor_frente === item.cor_costas
      ? item.cor_frente
      : '')
  );
}

/** @param {string} mode @param {number} index */
function extrasKey(mode, index) {
  return `${mode}-${index}`;
}

/**
 * PIT-02: a native button toggles the block, so Enter and Space work and the
 * focus stays on it; `aria-expanded` tells a screen reader the new state.
 *
 * @param {string} mode @param {number} index
 */
function toggleExtras(mode, index) {
  const key = extrasKey(mode, index);
  extrasOpen.value = { ...extrasOpen.value, [key]: !isExtrasOpen(mode, index) };
}

/**
 * Pesquisa UX 2026-10-15: on a confirmed order the shop floor reads the
 * extras, so a block that holds data starts open there; the seller's own
 * toggle always wins.
 *
 * @param {string} mode @param {number} index
 */
function isExtrasOpen(mode, index) {
  const key = extrasKey(mode, index);
  if (Object.hasOwn(extrasOpen.value, key)) return extrasOpen.value[key];
  const item = mode === 'read' ? shownItems.value[index] : null;
  return Boolean(
    item && props.order.status === 'confirmado' && filledExtras(item) > 0,
  );
}

/**
 * The extras someone filled, so a closed block still says it holds data.
 *
 * @param {Record<string, any>} item
 */
function filledExtras(item) {
  return EXTRA_FIELDS.filter((field) => String(item[field.key] ?? '') !== '')
    .length;
}

/**
 * The stepper beside the quantity moves a whole piece at a time and stops at
 * one, since the size rule refuses zero anyway.
 *
 * @param {Record<string, any>} line @param {number} delta
 */
function step(line, delta) {
  const current = Number.parseInt(String(line.quantidade), 10) || 0;
  line.quantidade = Math.max(1, current + delta);
}

/** @param {Record<string, any>} item @param {string} key */
function isNotApplicable(item, key) {
  return item[key] === NOT_APPLICABLE;
}

/**
 * Unchecking restores what was typed before, because an unchecked box means
 * "there is a colour here", not "erase it".
 *
 * @param {Record<string, any>} item @param {string} key @param {boolean} checked
 */
function toggleNotApplicable(item, key, checked) {
  if (checked) {
    item[`${key}_previous`] = item[key];
    item[key] = NOT_APPLICABLE;
    return;
  }
  item[key] = item[`${key}_previous`] ?? '';
}

/**
 * A ficha saved before ADR 016 has no colour, print or collar; the form
 * starts them blank, and an item with no fabric still offers one line.
 *
 * @param {Record<string, any>} item
 */
function editable(item) {
  return {
    ...blankItem(),
    ...item,
    // Older fichas carried the collar in vies_gola. Matching front/back
    // colours can fill the general colour; differing colours need a decision.
    cor: itemColor(item),
    gola: item.gola || item.vies_gola || '',
    malhas: item.malhas?.length ? [...item.malhas] : [''],
    publico: item.publico ?? '',
    quantidade_informada: item.quantidade_informada ?? null,
  };
}

function blankItem() {
  return {
    cor: '',
    cor_costas: '',
    cor_frente: '',
    cor_manga_direita: '',
    cor_manga_esquerda: '',
    estampa: '',
    gola: '',
    grade: [],
    malhas: [''],
    modelo: '',
    publico: '',
    quantidade_informada: null,
    tipo: '',
    tipo_servico: '',
    vies_gola: '',
    vies_mangas: '',
  };
}

async function initializePricing() {
  if (!canEdit.value || otherSectionOpen.value || initializing.value) return;
  initializing.value = true;
  errorMessage.value = '';
  editing.start(SECTION);
  const result = await editing.save('size-pricing', { action: 'initialize' });
  initializing.value = false;
  editing.stop();
  if (!result.ok) errorMessage.value = result.message;
  await nextTick();
  if (result.ok) document.getElementById('size-pricing-instructions')?.focus();
  else sheet.value?.querySelector('[role="alert"]')?.focus();
}

async function startEditing() {
  if (hasPricing.value || initializing.value) return;
  // structuredClone refuses a reactive proxy (DataCloneError); the ficha is
  // plain JSON data, so a JSON round trip is the copy that works here.
  draft.value = JSON.parse(JSON.stringify(props.order.ficha.items)).map(
    editable,
  );
  lineErrors.value = {};
  errorMessage.value = '';
  extrasOpen.value = {};
  announcement.value = '';
  editing.start(SECTION);
  await nextTick();
  // The first field lives inside a v-for; a ref on a repeated element would
  // be a list, so the form itself is asked for its first input.
  form.value?.querySelector('input')?.focus();
}

function cancel() {
  errorMessage.value = '';
  lineErrors.value = {};
  editing.stop();
}

// PFI-15/PFI-16: "Completar itens" (the progress, the footer or "Gerar
// pedido") opens this editor, like the other sections answer their own
// request; with another section open it only brings the items into view.
const sheet = ref(null);
watch(
  () => editing.editRequest?.value,
  (request) => {
    if (request?.section !== SECTION || isEditing.value) return;
    if (canEdit.value && !otherSectionOpen.value) {
      void startEditing();
      return;
    }
    sheet.value?.scrollIntoView?.({ block: 'start' });
  },
);

function addItem() {
  draft.value.push(blankItem());
}

/** @param {number} index */
function removeItem(index) {
  draft.value.splice(index, 1);
}

/**
 * ADR 025 (D7): a copy right below, with everything but the sizes and the
 * quantity said, so each audience of a split gets its own item. The focus
 * goes to the copy's audience, the field the seller changes next.
 *
 * @param {number} index
 */
async function duplicateItem(index) {
  const copy = JSON.parse(JSON.stringify(draft.value[index]));
  copy.grade = [];
  copy.quantidade_informada = null;
  draft.value.splice(index + 1, 0, copy);
  announcement.value = `Item ${index + 2} criado como cópia do item ${index + 1}.`;
  await nextTick();
  document.getElementById(`item-${index + 1}-publico`)?.focus();
}

/**
 * The quantity said is optional: a blank field sends null, anything else the
 * whole number the server checks again.
 *
 * @param {unknown} value
 */
function informedValue(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  return Number(value);
}

/** @param {Record<string, any>} item */
function addMalha(item) {
  item.malhas.push('');
}

/** @param {Record<string, any>} item @param {number} index */
function removeMalha(item, index) {
  item.malhas.splice(index, 1);
}

/** @param {Record<string, any>} item */
function addGradeLine(item) {
  item.grade.push({ quantidade: 1, tamanho: '' });
}

/** @param {Record<string, any>} item @param {number} index */
function removeGradeLine(item, index) {
  item.grade.splice(index, 1);
}

const INFORMED_MESSAGE = 'Use um número inteiro de 1 a 100000.';

/**
 * The sizes are checked here before the request so the error lands on the
 * line the seller is looking at; the server checks them again and answers
 * 422 INVALID_GRADE with the same index. Everything else may stay blank
 * (PIT-03): the order says what is missing when it is generated.
 */
function validate() {
  /** @type {Record<string, string>} */
  const errors = {};
  draft.value.forEach((item, itemIndex) => {
    item.grade.forEach(
      /** @param {Record<string, any>} line @param {number} index */
      (line, index) => {
        const quantity = Number(line.quantidade);
        if (
          !Number.isSafeInteger(quantity) ||
          quantity <= 0 ||
          String(line.tamanho).trim() === ''
        ) {
          errors[`${itemIndex}:${index}`] = GRADE_MESSAGE;
        }
      },
    );
    const informed = informedValue(item.quantidade_informada);
    if (
      informed !== null &&
      (!Number.isSafeInteger(informed) || informed < 1 || informed > 100000)
    ) {
      errors[`${itemIndex}:informed`] = INFORMED_MESSAGE;
    }
  });
  lineErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function save() {
  if (!validate()) return;
  saving.value = true;
  errorMessage.value = '';
  const result = await editing.save(
    SECTION,
    draft.value.map((item) => ({
      cor: item.cor,
      cor_costas: item.cor_costas,
      cor_frente: item.cor_frente,
      cor_manga_direita: item.cor_manga_direita,
      cor_manga_esquerda: item.cor_manga_esquerda,
      estampa: item.estampa,
      gola: item.gola,
      grade: item.grade.map(
        /** @param {Record<string, any>} line */
        (line) => ({
          quantidade: Number(line.quantidade),
          tamanho: String(line.tamanho).trim(),
        }),
      ),
      malhas: item.malhas.filter(
        /** @param {string} malha */
        (malha) => String(malha).trim() !== '',
      ),
      modelo: item.modelo,
      publico: item.publico,
      quantidade_informada: informedValue(item.quantidade_informada),
      tipo: item.tipo,
      tipo_servico: item.tipo_servico,
      vies_gola: item.vies_gola,
      vies_mangas: item.vies_mangas,
    })),
  );
  saving.value = false;
  if (result.ok) {
    editing.stop();
    return;
  }
  if (result.code === 'INVALID_GRADE') {
    const target = String(result.fields?.[0] ?? '');
    const match = /^items\[(\d+)\]\.grade\[(\d+)\]$/u.exec(target);
    lineErrors.value = match
      ? { [`${match[1]}:${match[2]}`]: GRADE_MESSAGE }
      : { '0:0': GRADE_MESSAGE };
    return;
  }
  errorMessage.value = result.message;
}
</script>

<template>
  <OrderPricedItemsSection v-if="hasPricing" :order="order" />
  <section
    v-else
    ref="sheet"
    class="op-sheet"
    :data-editing="isEditing || undefined"
    aria-labelledby="order-items-title"
  >
    <OrderSheetHead
      title-id="order-items-title"
      title="Itens e especificações"
      :state="headState.text"
      :tone="headState.tone"
      edit-label="Editar itens"
      :can-edit="canEdit"
      :blocked="otherSectionOpen"
      :editing="isEditing"
      section="items"
      body-id="order-items-body"
      @edit="startEditing"
    />

    <p
      v-if="errorMessage"
      role="alert"
      tabindex="-1"
      class="op-alert"
      :hidden="!open"
    >
      {{ errorMessage }}
    </p>

    <!-- novalidate: the browser would block the submit on its own and show
         its own message; the error belongs on the size line, in Portuguese. -->
    <form
      v-if="isEditing"
      id="order-items-body"
      ref="form"
      class="op-form"
      novalidate
      :hidden="!open"
      @submit.prevent="save"
    >
      <div class="op-sheet-body op-item-list">
        <fieldset
          v-for="(item, itemIndex) in draft"
          :key="itemIndex"
          class="op-item op-item-edit"
        >
          <legend class="op-visually-hidden">Item {{ itemIndex + 1 }}</legend>
          <div class="op-item-head">
            <p class="op-item-heading" aria-hidden="true">
              {{ itemHeading(item, itemIndex) }}
            </p>
            <button
              type="button"
              class="op-icon-button"
              @click="duplicateItem(itemIndex)"
            >
              <OrderIcon name="copy" />
              <span class="op-visually-hidden">{{
                `Duplicar item ${itemIndex + 1}`
              }}</span>
            </button>
            <button
              v-if="draft.length > 1"
              type="button"
              class="op-icon-button op-icon-button--danger"
              @click="removeItem(itemIndex)"
            >
              <OrderIcon name="trash" />
              <span class="op-visually-hidden">{{
                `Remover item ${itemIndex + 1}`
              }}</span>
            </button>
          </div>

          <!-- PIT-01 (ADR 020): the seven points, in the order the ficha prints. -->
          <div class="op-item-fields">
            <div class="op-field">
              <label :for="`item-${itemIndex}-tipo`">Tipo de roupa</label>
              <input
                :id="`item-${itemIndex}-tipo`"
                v-model="item.tipo"
                type="text"
                autocomplete="off"
                autocapitalize="characters"
              />
            </div>

            <div class="op-field">
              <label :for="`item-${itemIndex}-publico`">Público</label>
              <select
                :id="`item-${itemIndex}-publico`"
                v-model="item.publico"
                :aria-describedby="`item-${itemIndex}-publico-hint`"
              >
                <option value="">Não informado</option>
                <option
                  v-for="option in AUDIENCE_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <p :id="`item-${itemIndex}-publico-hint`" class="op-hint">
                Só quando o cliente divide o pedido.
              </p>
            </div>

            <div class="op-field">
              <label :for="`item-${itemIndex}-cor`">Cor</label>
              <div class="op-input-swatch">
                <span
                  v-if="swatchOf(item.cor)"
                  class="op-swatch"
                  :style="{ background: swatchOf(item.cor) }"
                  aria-hidden="true"
                ></span>
                <input
                  :id="`item-${itemIndex}-cor`"
                  v-model="item.cor"
                  type="text"
                  autocomplete="off"
                  autocapitalize="characters"
                />
              </div>
            </div>

            <div class="op-field">
              <span :id="`item-${itemIndex}-quantidade`" class="op-label"
                >Quantidade</span
              >
              <output
                class="op-quantity op-num"
                :aria-labelledby="`item-${itemIndex}-quantidade`"
                >{{ itemPieces(item) }} peças</output
              >
              <p class="op-hint">Soma dos tamanhos.</p>
              <label class="op-label" :for="`item-${itemIndex}-informada`"
                >Quantidade informada</label
              >
              <input
                :id="`item-${itemIndex}-informada`"
                v-model="item.quantidade_informada"
                class="op-num"
                type="number"
                min="1"
                max="100000"
                step="1"
                inputmode="numeric"
                :aria-invalid="
                  Boolean(lineErrors[`${itemIndex}:informed`]) || undefined
                "
                :aria-describedby="
                  lineErrors[`${itemIndex}:informed`]
                    ? `item-${itemIndex}-informada-error`
                    : `item-${itemIndex}-informada-hint`
                "
              />
              <p
                v-if="lineErrors[`${itemIndex}:informed`]"
                :id="`item-${itemIndex}-informada-error`"
                role="alert"
                class="op-field-error"
              >
                {{ lineErrors[`${itemIndex}:informed`] }}
              </p>
              <p
                v-else
                :id="`item-${itemIndex}-informada-hint`"
                class="op-hint"
              >
                O que o cliente disse; não entra no total.
              </p>
            </div>

            <div class="op-field op-field--wide">
              <label :for="`item-${itemIndex}-aplicacao`">Aplicação</label>
              <input
                :id="`item-${itemIndex}-aplicacao`"
                v-model="item.tipo_servico"
                type="text"
                autocomplete="off"
                :aria-describedby="`item-${itemIndex}-aplicacao-hint`"
              />
              <p :id="`item-${itemIndex}-aplicacao-hint`" class="op-hint">
                Silk, DTF, sublimação, bordado… ou Sem estampa. Obrigatória para
                gerar.
              </p>
            </div>

            <div class="op-field op-field--wide">
              <span class="op-label">Modelo de malha</span>
              <div
                v-for="(malha, malhaIndex) in item.malhas"
                :key="malhaIndex"
                class="op-input-row"
              >
                <input
                  v-model="item.malhas[malhaIndex]"
                  type="text"
                  autocomplete="off"
                  autocapitalize="characters"
                  :aria-label="`Modelo de malha ${malhaIndex + 1}`"
                />
                <button
                  v-if="item.malhas.length > 1"
                  type="button"
                  class="op-icon-button"
                  @click="removeMalha(item, malhaIndex)"
                >
                  <OrderIcon name="x" />
                  <span class="op-visually-hidden">{{
                    `Remover modelo de malha ${malhaIndex + 1}`
                  }}</span>
                </button>
              </div>
              <button
                type="button"
                class="op-add-inline"
                @click="addMalha(item)"
              >
                <OrderIcon name="plus" />Adicionar modelo de malha
              </button>
            </div>

            <div class="op-grade-editor op-field--wide">
              <div class="op-grade-editor-head">
                <span class="op-label">Tamanhos</span>
                <span class="op-num"
                  >Total do item
                  <strong>{{ itemPieces(item) }} peças</strong></span
                >
              </div>
              <div v-if="item.grade.length" class="op-grade-lines">
                <div
                  v-for="(line, lineIndex) in item.grade"
                  :key="lineIndex"
                  class="op-grade-cell"
                >
                  <div
                    class="op-grade-line"
                    :data-invalid="
                      Boolean(lineErrors[`${itemIndex}:${lineIndex}`]) ||
                      undefined
                    "
                    :data-duplicate="
                      isDuplicateSize(item.grade, line.tamanho) || undefined
                    "
                  >
                    <input
                      v-model="line.tamanho"
                      class="op-grade-size"
                      type="text"
                      autocomplete="off"
                      autocapitalize="characters"
                      :aria-label="`Tamanho da linha ${lineIndex + 1}`"
                      :aria-invalid="
                        (Boolean(lineErrors[`${itemIndex}:${lineIndex}`]) &&
                          String(line.tamanho).trim() === '') ||
                        undefined
                      "
                      :aria-describedby="
                        lineErrors[`${itemIndex}:${lineIndex}`]
                          ? `grade-error-${itemIndex}-${lineIndex}`
                          : undefined
                      "
                    />
                    <button
                      type="button"
                      class="op-icon-button"
                      @click="step(line, -1)"
                    >
                      <OrderIcon name="minus" />
                      <span class="op-visually-hidden">{{
                        `Uma peça a menos na linha ${lineIndex + 1}`
                      }}</span>
                    </button>
                    <input
                      v-model="line.quantidade"
                      class="op-grade-qty op-num"
                      type="number"
                      min="1"
                      step="1"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      enterkeyhint="next"
                      :aria-invalid="
                        Boolean(lineErrors[`${itemIndex}:${lineIndex}`]) ||
                        undefined
                      "
                      :aria-describedby="
                        lineErrors[`${itemIndex}:${lineIndex}`]
                          ? `grade-error-${itemIndex}-${lineIndex}`
                          : undefined
                      "
                      :aria-label="
                        line.tamanho
                          ? `Quantidade do tamanho ${line.tamanho}`
                          : `Quantidade da linha ${lineIndex + 1}`
                      "
                    />
                    <button
                      type="button"
                      class="op-icon-button"
                      @click="step(line, 1)"
                    >
                      <OrderIcon name="plus" />
                      <span class="op-visually-hidden">{{
                        `Uma peça a mais na linha ${lineIndex + 1}`
                      }}</span>
                    </button>
                    <button
                      type="button"
                      class="op-icon-button op-icon-button--quiet"
                      @click="removeGradeLine(item, lineIndex)"
                    >
                      <OrderIcon name="x" />
                      <span class="op-visually-hidden">{{
                        `Remover linha ${lineIndex + 1}`
                      }}</span>
                    </button>
                  </div>
                  <p
                    v-if="lineErrors[`${itemIndex}:${lineIndex}`]"
                    :id="`grade-error-${itemIndex}-${lineIndex}`"
                    role="alert"
                    class="op-field-error"
                  >
                    {{ lineErrors[`${itemIndex}:${lineIndex}`] }}
                  </p>
                </div>
              </div>
              <p v-else class="op-hint">Nenhum tamanho ainda.</p>
              <div aria-live="polite">
                <p
                  v-if="duplicateSizeWarning(item.grade)"
                  class="op-quantity-warning"
                >
                  <OrderIcon name="alert" />{{
                    duplicateSizeWarning(item.grade)
                  }}
                </p>
              </div>
              <button
                type="button"
                class="op-add-inline"
                @click="addGradeLine(item)"
              >
                <OrderIcon name="plus" />Adicionar tamanho
              </button>
            </div>

            <div class="op-field">
              <label :for="`item-${itemIndex}-gola`">Gola</label>
              <input
                :id="`item-${itemIndex}-gola`"
                v-model="item.gola"
                type="text"
                autocomplete="off"
                autocapitalize="characters"
              />
            </div>
          </div>
          <p v-if="itemQuantityWarning(item)" class="op-quantity-warning">
            <OrderIcon name="alert" />{{ itemQuantityWarning(item) }}
          </p>

          <div class="op-extras">
            <button
              type="button"
              class="op-extras-toggle"
              :aria-expanded="isExtrasOpen('edit', itemIndex)"
              :aria-controls="`item-edit-${itemIndex}-extras`"
              @click="toggleExtras('edit', itemIndex)"
            >
              {{ EXTRAS_LABEL }}
              <OrderIcon name="chevron" />
            </button>
            <div
              :id="`item-edit-${itemIndex}-extras`"
              class="op-item-fields op-extras-body"
              :hidden="!isExtrasOpen('edit', itemIndex)"
            >
              <div
                v-for="field in EXTRA_FIELDS"
                :key="field.key"
                class="op-field"
                :class="{ 'op-field--wide': field.text }"
              >
                <label :for="`item-${itemIndex}-${field.key}`">{{
                  field.label
                }}</label>
                <div class="op-input-swatch">
                  <span
                    v-if="field.color && swatchOf(item[field.key])"
                    class="op-swatch"
                    :style="{ background: swatchOf(item[field.key]) }"
                    aria-hidden="true"
                  ></span>
                  <input
                    :id="`item-${itemIndex}-${field.key}`"
                    :value="
                      isNotApplicable(item, field.key)
                        ? NOT_APPLICABLE_LABEL
                        : item[field.key]
                    "
                    type="text"
                    autocomplete="off"
                    :autocapitalize="field.text ? 'sentences' : 'characters'"
                    :aria-describedby="
                      field.hint
                        ? `item-${itemIndex}-${field.key}-hint`
                        : undefined
                    "
                    :disabled="isNotApplicable(item, field.key)"
                    @input="item[field.key] = $event.target.value"
                  />
                </div>
                <p
                  v-if="field.hint"
                  :id="`item-${itemIndex}-${field.key}-hint`"
                  class="op-hint"
                >
                  {{ field.hint }}
                </p>
                <label v-if="field.optional" class="op-check">
                  <input
                    type="checkbox"
                    :checked="isNotApplicable(item, field.key)"
                    :aria-label="`${field.label} não se aplica`"
                    @change="
                      toggleNotApplicable(
                        item,
                        field.key,
                        $event.target.checked,
                      )
                    "
                  />
                  <span aria-hidden="true">Não aplicável</span>
                </label>
              </div>
            </div>
          </div>
        </fieldset>

        <button type="button" class="op-add-item" @click="addItem">
          <OrderIcon name="plus" />Adicionar item
        </button>
        <p class="op-visually-hidden" aria-live="polite">{{ announcement }}</p>
      </div>

      <div class="op-form-actions">
        <p class="op-num">
          Total do pedido: <strong>{{ draftTotal }} peças</strong>, somado dos
          tamanhos.
        </p>
        <button type="button" :disabled="saving" @click="cancel">
          Cancelar
        </button>
        <!-- PFI-13: "Gerar pedido" is the only primary button here. -->
        <button type="submit" class="op-save" :disabled="saving">
          {{ saving ? 'Salvando…' : 'Salvar itens' }}
        </button>
      </div>
    </form>

    <div
      v-else
      id="order-items-body"
      class="op-sheet-body op-item-list"
      :hidden="!open"
    >
      <div
        v-for="(item, itemIndex) in shownItems"
        :key="itemIndex"
        class="op-item"
        role="group"
        :aria-labelledby="`item-${itemIndex}-title`"
      >
        <div class="op-item-head">
          <h3 :id="`item-${itemIndex}-title`" class="op-item-heading">
            {{ itemHeading(item, itemIndex) }}
          </h3>
        </div>
        <!-- PIT-01 (ADR 020): the seven points, as the ficha prints them. -->
        <dl class="op-points">
          <div>
            <dt>Tipo de roupa</dt>
            <dd>{{ shownValue(item.tipo) }}</dd>
          </div>
          <div>
            <dt>Cor</dt>
            <dd>
              <span
                v-if="swatchOf(itemColor(item))"
                class="op-swatch"
                :style="{ background: swatchOf(itemColor(item)) }"
                aria-hidden="true"
              ></span>
              {{ shownValue(itemColor(item)) }}
            </dd>
          </div>
          <div>
            <dt>Quantidade</dt>
            <dd class="op-num">
              {{ itemQuantityLabel(item, itemIndex, order) }}
            </dd>
          </div>
          <div class="op-point--wide">
            <dt>Aplicação</dt>
            <dd>{{ shownValue(item.tipo_servico) }}</dd>
          </div>
          <div>
            <dt>Modelo de malha</dt>
            <dd>{{ (item.malhas ?? []).join(' / ') || '—' }}</dd>
          </div>
          <div class="op-point--wide">
            <dt>Tamanhos</dt>
            <dd>
              <!-- Pesquisa UX 2026-10-15, achado 4: size and quantity with
                   the same weight, in the order the floor counts them. -->
              <ul
                v-if="item.grade.length"
                class="op-grade-tiles"
                :aria-label="`Tamanhos do item ${itemIndex + 1}`"
              >
                <li
                  v-for="line in sortedGrade(item.grade)"
                  :key="line.index"
                  :data-duplicate="
                    isDuplicateSize(item.grade, line.tamanho) || undefined
                  "
                >
                  <span class="op-grade-tile-size">{{ line.tamanho }}</span>
                  <span class="op-grade-tile-qty op-num"
                    >{{ line.quantidade
                    }}<span class="op-visually-hidden">
                      {{ Number(line.quantidade) === 1 ? 'peça' : 'peças' }}
                    </span></span
                  >
                  <span
                    v-if="isDuplicateSize(item.grade, line.tamanho)"
                    class="op-visually-hidden"
                    >, tamanho repetido</span
                  >
                </li>
              </ul>
              <template v-else>—</template>
            </dd>
          </div>
          <div>
            <dt>Gola</dt>
            <dd>{{ shownValue(item.gola || item.vies_gola) }}</dd>
          </div>
        </dl>
        <p v-if="itemQuantityWarning(item)" class="op-quantity-warning">
          <OrderIcon name="alert" />{{ itemQuantityWarning(item) }}
        </p>
        <p v-if="duplicateSizeWarning(item.grade)" class="op-quantity-warning">
          <OrderIcon name="alert" />{{ duplicateSizeWarning(item.grade) }}
        </p>
        <div class="op-extras">
          <button
            type="button"
            class="op-extras-toggle"
            :aria-expanded="isExtrasOpen('read', itemIndex)"
            :aria-controls="`item-${itemIndex}-extras`"
            @click="toggleExtras('read', itemIndex)"
          >
            {{ EXTRAS_LABEL }}
            <span v-if="filledExtras(item)" class="op-quiet-tag op-num">{{
              filledExtras(item)
            }}</span>
            <OrderIcon name="chevron" />
          </button>
          <dl
            :id="`item-${itemIndex}-extras`"
            class="op-points op-extras-body"
            :hidden="!isExtrasOpen('read', itemIndex)"
          >
            <div
              v-for="field in EXTRA_FIELDS"
              :key="field.key"
              :class="{ 'op-point--wide': field.text }"
            >
              <dt>{{ field.label }}</dt>
              <dd :data-muted="isNotApplicable(item, field.key) || undefined">
                <span
                  v-if="field.color && swatchOf(item[field.key])"
                  class="op-swatch"
                  :style="{ background: swatchOf(item[field.key]) }"
                  aria-hidden="true"
                ></span>
                {{ shownValue(item[field.key]) }}
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <p v-if="!shownItems.length" class="op-empty">
        Nenhum item no pedido ainda.
      </p>
      <div v-if="(canEdit || initializing) && order.confirmedAt == null">
        <button
          type="button"
          :disabled="initializing || otherSectionOpen"
          @click="initializePricing"
        >
          {{
            initializing
              ? 'Preparando subtotais…'
              : 'Usar subtotais por tamanho'
          }}
        </button>
        <p class="op-hint">
          Os subtotais começam vazios e precisam de revisão humana. Nenhum preço
          é inferido do valor anterior.
        </p>
      </div>
      <p class="op-hint">
        A quantidade de cada item e o total do pedido saem dos tamanhos e nunca
        são digitados.
      </p>
    </div>
  </section>
</template>
