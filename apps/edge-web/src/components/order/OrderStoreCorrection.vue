<script setup>
import { nextTick, ref } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';

const props = defineProps({ order: { type: Object, required: true } });
const emit = defineEmits(['saved']);
const quantity = ref(props.order.totalPieces);
const busy = ref(false);
const error = ref('');
const success = ref('');
/** @type {import('vue').Ref<HTMLInputElement|null>} */
const field = ref(null);
/** @type {import('vue').Ref<HTMLButtonElement|null>} */
const submitButton = ref(null);
/** @type {{key: string, body: {expectedVersion: number, expectedQuantity: number, expectedAmountCents: number, quantity: number, reason: string}}|null} */
let pending = null;

async function save() {
  if (busy.value) return;
  error.value = '';
  success.value = '';
  const value = Number(quantity.value);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    error.value = 'Informe uma quantidade inteira de 1 a 10 peças.';
    await nextTick();
    field.value?.focus();
    return;
  }
  // Reuse the complete command after a lost response, including its version.
  if (!pending || pending.body.quantity !== value) {
    pending = {
      key: commandKey(),
      body: {
        expectedVersion: props.order.version,
        expectedQuantity: props.order.totalPieces,
        expectedAmountCents: props.order.finalAmountCents,
        quantity: value,
        reason: 'USER_CONFIRMED_QUANTITY',
      },
    };
  }
  busy.value = true;
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.order.id)}/store-correction`,
      { method: 'POST', body: pending.body, idempotencyKey: pending.key },
    );
    emit('saved', response.data.order);
    pending = null;
    success.value =
      'Quantidade corrigida. Gere novamente a ficha para usar os dados atualizados.';
  } catch (cause) {
    if (Number(cause?.status) === 409) {
      error.value =
        'O pedido mudou. Atualize a página e confira os dados antes de corrigir.';
      pending = null;
    } else if (Number(cause?.status) === 403) {
      error.value = 'Somente um administrador pode corrigir a quantidade.';
    } else if (Number(cause?.status) === 422) {
      error.value =
        'A correção não é compatível com o catálogo ou com o valor já pago.';
    } else {
      error.value =
        'Não foi possível confirmar a correção. Tente novamente para consultar o mesmo comando.';
    }
  } finally {
    busy.value = false;
    await nextTick();
    submitButton.value?.focus();
  }
}
</script>

<template>
  <details class="op-sheet op-store-correction">
    <summary class="op-sheet-head">
      Correção administrativa de quantidade
    </summary>
    <form class="op-form" @submit.prevent="save">
      <div class="op-sheet-body">
        <p id="store-correction-help" class="op-hint">
          Use após confirmar a quantidade com o cliente. O valor das peças será
          recalculado pelo catálogo, até o limite já pago. O pagamento original
          e o histórico serão preservados.
        </p>
        <div class="op-field">
          <label for="store-correction-quantity"
            >Quantidade confirmada pelo cliente</label
          >
          <input
            id="store-correction-quantity"
            ref="field"
            v-model="quantity"
            type="number"
            min="1"
            max="10"
            step="1"
            required
            :disabled="busy"
            aria-describedby="store-correction-help"
          />
        </div>
        <p v-if="error" class="op-alert" role="alert">{{ error }}</p>
        <p role="status" aria-live="polite">{{ success }}</p>
      </div>
      <div class="op-form-actions">
        <button
          ref="submitButton"
          class="op-save"
          type="submit"
          :disabled="busy"
        >
          {{ busy ? 'Corrigindo…' : 'Registrar correção de quantidade' }}
        </button>
      </div>
    </form>
  </details>
</template>
