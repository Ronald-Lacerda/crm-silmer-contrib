<script setup>
import { computed, inject, nextTick, ref } from 'vue';
import { operationalDay, orderMilestones } from '../../lib/order-format.js';
import OrderIcon from './OrderIcon.vue';
import OrderSheetHead from './OrderSheetHead.vue';

const SECTION = 'milestones';
const FUTURE_DAY_MESSAGE = 'Use uma data até hoje.';

const props = defineProps({
  order: { type: Object, required: true },
});

const editing = inject('orderEditing');
const billingState = inject('orderBillingState', null);
const billingReadonly = computed(() =>
  Boolean(
    billingState && (!billingState.value.ready || billingState.value.managed),
  ),
);
const firstField = ref(null);
const draft = ref({ deliveredOn: '', paidOn: '' });
const paymentReviewed = ref(false);
/** @type {import('vue').Ref<Record<string, string>>} */
const fieldErrors = ref({});
const saving = ref(false);
const errorMessage = ref('');
const today = ref('');

const isEditing = computed(() => editing.editingSection.value === SECTION);
const isManual = computed(
  () => props.order.origin === 'atendimento' && !props.order.conversationId,
);
// ADR 008: unlike the ficha sections, the trail stays open after the order
// is generated — payment and delivery usually come later — and never needs a
// reopen.
const canEdit = computed(
  () =>
    (editing.canEditMilestones ?? editing.canEdit).value &&
    !(isManual.value && billingReadonly.value),
);
const otherSectionOpen = computed(
  () => editing.editingSection.value !== '' && !isEditing.value,
);
// PFI-18: on a phone the body is shown only while the accordion opens it.
const open = computed(() => editing.isSectionOpen?.(SECTION) ?? true);
const steps = computed(() => orderMilestones(props.order));
const recordedCount = computed(
  () => steps.value.filter((step) => step.recorded).length,
);

async function startEditing() {
  if (!canEdit.value) return;
  paymentReviewed.value = false;
  draft.value = {
    deliveredOn: props.order.deliveredOn ?? '',
    paidOn: props.order.paidOn ?? '',
  };
  today.value = operationalDay(new Date());
  fieldErrors.value = {};
  errorMessage.value = '';
  editing.start(SECTION);
  await nextTick();
  firstField.value?.focus();
}

function cancel() {
  fieldErrors.value = {};
  errorMessage.value = '';
  editing.stop();
}

/**
 * PLA-05: a day after today is caught here, next to the field; the server
 * checks it again on São Paulo time and answers 422 INVALID_DATE.
 */
async function save() {
  errorMessage.value = '';
  /** @type {Record<string, string>} */
  const errors = {};
  const fields = isManual.value ? ['paidOn'] : ['paidOn', 'deliveredOn'];
  for (const field of fields) {
    if (draft.value[field] !== '' && draft.value[field] > today.value) {
      errors[field] = FUTURE_DAY_MESSAGE;
    }
  }
  if (
    props.order.paymentReviewRequired &&
    paymentReviewed.value &&
    !draft.value.paidOn
  )
    errors.paidOn = 'Informe a data em que o valor integral foi recebido.';
  fieldErrors.value = errors;
  if (Object.keys(errors).length > 0) return;

  saving.value = true;
  const result = await editing.saveMilestones({
    ...(isManual.value ? {} : { deliveredOn: draft.value.deliveredOn || null }),
    paidOn: billingReadonly.value
      ? (props.order.paidOn ?? null)
      : draft.value.paidOn || null,
    ...(props.order.paymentReviewRequired &&
    paymentReviewed.value &&
    !billingReadonly.value
      ? { paymentReviewed: true }
      : {}),
  });
  saving.value = false;
  if (result.ok) {
    editing.stop();
    return;
  }
  if (result.code === 'INVALID_DATE') {
    fieldErrors.value = Object.fromEntries(
      result.fields.map((/** @type {string} */ field) => [
        field,
        FUTURE_DAY_MESSAGE,
      ]),
    );
    return;
  }
  errorMessage.value = result.message;
}
</script>

<template>
  <section
    class="op-sheet"
    :data-editing="isEditing || undefined"
    aria-labelledby="order-milestones-title"
  >
    <!-- PFI-17, PLA-07: the dates never block "Gerar" (PLA-06), so their
         state is a plain count. PFI-20: "Datas do pedido" on the screen; the
         printed ficha keeps "Lastro do pedido". -->
    <OrderSheetHead
      title-id="order-milestones-title"
      title="Datas do pedido"
      :state="`${recordedCount} de ${steps.length} datas`"
      edit-label="Editar datas"
      :can-edit="canEdit"
      :blocked="otherSectionOpen"
      :editing="isEditing"
      section="milestones"
      body-id="order-milestones-body"
      @edit="startEditing"
    />

    <p v-if="errorMessage" role="alert" class="op-alert" :hidden="!open">
      {{ errorMessage }}
    </p>

    <form
      v-if="isEditing"
      id="order-milestones-body"
      class="op-form"
      novalidate
      :hidden="!open"
      @submit.prevent="save"
    >
      <div class="op-form-grid">
        <div class="op-field">
          <label for="milestone-paid">Pago em</label>
          <input
            id="milestone-paid"
            ref="firstField"
            v-model="draft.paidOn"
            type="date"
            :disabled="billingReadonly"
            :max="today"
            :aria-invalid="Boolean(fieldErrors.paidOn) || undefined"
            :aria-describedby="
              fieldErrors.paidOn
                ? 'milestone-paid-error'
                : 'milestone-paid-hint'
            "
          />
          <p
            v-if="fieldErrors.paidOn"
            id="milestone-paid-error"
            role="alert"
            class="op-field-error"
          >
            {{ fieldErrors.paidOn }}
          </p>
          <p v-else id="milestone-paid-hint" class="op-hint">
            {{
              billingReadonly
                ? 'A quitação é calculada pelas cobranças confirmadas na InfinitePay.'
                : 'O dia em que o valor integral do pagamento entrou.'
            }}
          </p>
          <p v-if="order.paymentReviewRequired" class="op-hint">
            Confirme o recebimento integral e salve a data de pagamento para
            liberar no Financeiro.
          </p>
          <label
            v-if="order.paymentReviewRequired && !billingReadonly"
            class="op-check"
          >
            <input
              v-model="paymentReviewed"
              type="checkbox"
              :disabled="saving"
            />
            <span>Confirmo que o valor integral foi recebido</span>
          </label>
        </div>

        <div v-if="!isManual" class="op-field">
          <label for="milestone-delivered">Entregue em</label>
          <input
            id="milestone-delivered"
            v-model="draft.deliveredOn"
            type="date"
            :max="today"
            :aria-invalid="Boolean(fieldErrors.deliveredOn) || undefined"
            :aria-describedby="
              fieldErrors.deliveredOn
                ? 'milestone-delivered-error'
                : 'milestone-delivered-hint'
            "
          />
          <p
            v-if="fieldErrors.deliveredOn"
            id="milestone-delivered-error"
            role="alert"
            class="op-field-error"
          >
            {{ fieldErrors.deliveredOn }}
          </p>
          <p v-else id="milestone-delivered-hint" class="op-hint">
            O dia em que o cliente recebeu o pedido.
          </p>
        </div>
      </div>

      <p class="op-locked-note">
        <OrderIcon name="lock" />
        {{
          isManual
            ? 'Primeiro contato é preenchido na criação. Confirme a entrega nos seus afazeres do Dashboard.'
            : 'Primeiro contato vem da conversa.'
        }}
        Data do pedido e previsão de entrega ficam no Resumo do pedido.
      </p>

      <div class="op-form-actions">
        <button type="button" :disabled="saving" @click="cancel">
          Cancelar
        </button>
        <button type="submit" class="op-save" :disabled="saving">
          {{ saving ? 'Salvando…' : 'Salvar datas' }}
        </button>
      </div>
    </form>

    <div
      v-else
      id="order-milestones-body"
      class="op-sheet-body"
      :hidden="!open"
    >
      <ol class="op-milestones">
        <li
          v-for="step in steps"
          :key="step.key"
          class="op-milestone"
          :data-recorded="step.recorded || undefined"
        >
          <span class="op-milestone-dot" aria-hidden="true"></span>
          <span class="op-label">{{ step.label }}</span>
          <strong class="op-num">{{ step.value }}</strong>
          <span class="op-origin-note">{{ step.note }}</span>
        </li>
      </ol>
      <p v-if="order.paymentReviewRequired && !billingReadonly" class="op-hint">
        Confirme o recebimento integral e salve a data de pagamento para liberar
        no Financeiro.
      </p>
      <p class="op-hint">
        {{
          billingReadonly
            ? 'Pago em é calculado pelas cobranças confirmadas na InfinitePay; receber um sinal não registra quitação integral.'
            : isManual
              ? 'Pago em é informado aqui. Entregue em é preenchido ao confirmar a entrega nos seus afazeres do Dashboard.'
              : 'Pago em e Entregue em são informados no pedido.'
        }}
        Essas datas não mudam o status nem a ficha já gerada.
      </p>
    </div>
  </section>
</template>
