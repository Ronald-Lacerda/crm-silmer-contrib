<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { request } from '../lib/api-client.js';

// T138 / MEV-13: the manager connects the account and checks an explicitly
// measured package. No quote changes an order or initiates a purchase.
const route = useRoute();
const router = useRouter();
const base = '/api/v1/shipping/melhor-envio';
const heading = ref(null);
const notice = ref(null);
const quoteNotice = ref(null);
const resultsHeading = ref(null);
const status = ref(null);
const loading = ref(true);
const accountBusy = ref(false);
const quoteBusy = ref(false);
const accountError = ref('');
const quoteError = ref('');
const announcement = ref('');
const quote = ref(null);
const fields = reactive({
  fromPostalCode: '',
  toPostalCode: '',
  weightGrams: '',
  widthCm: '',
  heightCm: '',
  lengthCm: '',
  insuranceValue: '0,00',
});
let accountController;
let quoteController;
let disposed = false;
const callback = {
  code: typeof route.query.code === 'string' ? route.query.code : '',
  state: typeof route.query.state === 'string' ? route.query.state : '',
  error: Boolean(route.query.error),
};
const hasCallback = ['code', 'state', 'error'].some((key) =>
  Object.hasOwn(route.query, key),
);
// Keep codes out of the address bar and history as soon as this authorized
// view is mounted; no callback secret is written to browser storage.
if (hasCallback) void router.replace({ path: '/melhor-envio' });

const connectionLabel = computed(() => {
  if (!status.value) return 'Estado indisponível';
  if (!status.value.configured) return 'Conexão ainda não configurada';
  if (status.value.reconnectRequired) return 'Reconexão necessária';
  return status.value.connected ? 'Conta conectada' : 'Conta desconectada';
});
const canQuote = computed(() =>
  Boolean(status.value?.connected && !status.value?.reconnectRequired),
);
const expiresLabel = computed(() => {
  const time = Date.parse(status.value?.expiresAt ?? '');
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeZone: 'America/Sao_Paulo',
      }).format(time)
    : '';
});

/** @param {unknown} cause */
function failureText(cause) {
  const error = /** @type {any} */ (cause);
  if (error?.status === 401 || error?.status === 403)
    return 'Sua sessão não permite esta ação. Entre novamente com uma conta de administrador.';
  if (error?.status === 429 || error?.code === 'MELHOR_ENVIO_RATE_LIMITED')
    return 'Aguarde um momento antes de consultar novamente.';
  if (
    [
      'MELHOR_ENVIO_AUTH',
      'MELHOR_ENVIO_NOT_CONNECTED',
      'MELHOR_ENVIO_RECONNECT_REQUIRED',
    ].includes(error?.code)
  )
    return 'Reconecte a conta do Melhor Envio para continuar.';
  if (error?.code === 'MELHOR_ENVIO_REFRESH_IN_PROGRESS')
    return 'A conexão está sendo renovada. Tente novamente em instantes.';
  if (error?.code === 'MELHOR_ENVIO_CONNECTION_CHANGED')
    return 'A conexão mudou. Atualize a página e tente novamente.';
  if (error?.status === 409 || error?.code === 'INVALID_OAUTH_STATE')
    return 'Esta autorização não está mais disponível. Inicie uma nova conexão.';
  if (error?.status === 400 || error?.status === 422)
    return 'Confira os CEPs, o peso, as medidas e o valor segurado antes de tentar novamente.';
  return 'O Melhor Envio está indisponível agora. Tente novamente em instantes.';
}

async function focusNotice() {
  await nextTick();
  if (!disposed) notice.value?.focus();
}

async function loadStatus() {
  if (accountBusy.value) return;
  accountController?.abort();
  const own = new AbortController();
  accountController = own;
  loading.value = true;
  accountError.value = '';
  try {
    const response = await request(`${base}/status`, { signal: own.signal });
    if (accountController === own && !disposed) status.value = response.data;
  } catch (cause) {
    if (own.signal.aborted || disposed) return;
    accountError.value = failureText(cause);
  } finally {
    if (accountController === own && !disposed) loading.value = false;
  }
}

/** @param {'authorize'|'complete'|'disconnect'} action @param {Record<string, unknown>} [body] */
async function accountAction(action, body = {}) {
  if (accountBusy.value || loading.value) return;
  accountBusy.value = true;
  clearQuote();
  accountError.value = '';
  announcement.value = '';
  accountController?.abort();
  const own = new AbortController();
  accountController = own;
  try {
    const response = await request(`${base}/${action}`, {
      method: 'POST',
      body,
      signal: own.signal,
    });
    if (disposed || own.signal.aborted) return;
    if (action === 'authorize') {
      const url = new URL(response.data.authorizationUrl);
      if (
        ![
          'https://melhorenvio.com.br',
          'https://sandbox.melhorenvio.com.br',
        ].includes(url.origin) ||
        url.pathname !== '/oauth/authorize' ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('Invalid authorization destination');
      globalThis.location.assign(url.href);
      return;
    }
    status.value = response.data;
    quote.value = null;
    announcement.value =
      action === 'complete'
        ? 'Conta do Melhor Envio conectada.'
        : 'Conta do Melhor Envio desconectada do CRM.';
    await nextTick();
    heading.value?.focus();
  } catch (cause) {
    if (own.signal.aborted || disposed) return;
    accountError.value =
      action === 'complete'
        ? 'Não foi possível concluir a autorização. Inicie uma nova conexão com o Melhor Envio.'
        : failureText(cause);
    await focusNotice();
  } finally {
    if (!disposed) accountBusy.value = false;
  }
}

function clearQuote() {
  quoteController?.abort();
  quoteController = undefined;
  quoteBusy.value = false;
  quote.value = null;
  quoteError.value = '';
  announcement.value = '';
}
watch(fields, clearQuote, { flush: 'sync' });

async function calculate() {
  if (quoteBusy.value || !canQuote.value || accountBusy.value) return;
  const amount = fields.insuranceValue.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(amount)) {
    quoteError.value =
      'Informe o valor segurado em reais, com até duas casas decimais.';
    await nextTick();
    quoteNotice.value?.focus();
    return;
  }
  const own = new AbortController();
  quoteController?.abort();
  quoteController = own;
  quoteBusy.value = true;
  quoteError.value = '';
  quote.value = null;
  announcement.value = '';
  try {
    const response = await request(`${base}/quote`, {
      method: 'POST',
      signal: own.signal,
      body: {
        fromPostalCode: fields.fromPostalCode,
        toPostalCode: fields.toPostalCode,
        weightGrams: Number(fields.weightGrams),
        widthCm: Number(fields.widthCm),
        heightCm: Number(fields.heightCm),
        lengthCm: Number(fields.lengthCm),
        insuranceValueCents: Math.round(Number(amount) * 100),
      },
    });
    if (quoteController !== own || disposed) return;
    quote.value = response.data;
    announcement.value = `${quote.value.services.length} opções de frete encontradas.`;
    await nextTick();
    resultsHeading.value?.focus();
  } catch (cause) {
    if (own.signal.aborted || quoteController !== own || disposed) return;
    quoteError.value = failureText(cause);
    if (
      /** @type {any} */ (cause)?.code === 'MELHOR_ENVIO_AUTH' &&
      status.value
    )
      status.value = { ...status.value, reconnectRequired: true };
    await nextTick();
    quoteNotice.value?.focus();
  } finally {
    if (quoteController === own && !disposed) quoteBusy.value = false;
  }
}

/** @param {number} cents */
function money(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

onMounted(async () => {
  heading.value?.focus();
  await loadStatus();
  if (disposed || !hasCallback) return;
  if (callback.error || !callback.code || !callback.state) {
    accountError.value =
      'A autorização não foi concluída. Você pode iniciar uma nova conexão.';
    await focusNotice();
  } else if (status.value?.configured) {
    await accountAction('complete', {
      code: callback.code,
      state: callback.state,
    });
  }
  callback.code = '';
  callback.state = '';
});
onBeforeUnmount(() => {
  disposed = true;
  accountController?.abort();
  quoteController?.abort();
});
</script>

<template>
  <div class="page shipping-page">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Melhor Envio</h1>
        <p>Conecte a conta e consulte o frete de uma embalagem.</p>
      </div>
    </header>
    <p class="sr-only" role="status">{{ announcement }}</p>
    <section
      class="surface shipping-section"
      aria-labelledby="shipping-account-title"
      :aria-busy="loading || accountBusy"
    >
      <h2 id="shipping-account-title">Conta do Melhor Envio</h2>
      <p v-if="loading" role="status">Consultando conexão…</p>
      <template v-else-if="status">
        <p>
          <strong>{{ connectionLabel }}</strong>
        </p>
        <p v-if="!status.configured">
          A conexão precisa ser habilitada pela administração técnica antes da
          autorização da conta.
        </p>
        <p v-else>
          Ambiente:
          {{
            status.environment === 'production'
              ? 'produção'
              : 'testes (sandbox)'
          }}.
          <span v-if="expiresLabel && status.connected"
            >Autorização válida até {{ expiresLabel }}.</span
          >
        </p>
        <div v-if="status.configured" class="inline-actions">
          <button
            class="primary"
            type="button"
            :aria-disabled="accountBusy ? 'true' : undefined"
            :aria-busy="accountBusy"
            @click="accountAction('authorize')"
          >
            {{
              status.connected || status.reconnectRequired
                ? 'Reconectar conta'
                : 'Conectar conta'
            }}
          </button>
          <button
            v-if="status.connected"
            type="button"
            :aria-disabled="accountBusy ? 'true' : undefined"
            @click="accountAction('disconnect')"
          >
            Desconectar conta
          </button>
        </div>
      </template>
      <div v-if="accountError" ref="notice" tabindex="-1" role="alert">
        <p>{{ accountError }}</p>
        <button
          type="button"
          :aria-disabled="accountBusy || loading ? 'true' : undefined"
          @click="loadStatus"
        >
          Consultar conexão novamente
        </button>
      </div>
    </section>

    <section
      v-if="status?.configured"
      class="surface shipping-section"
      aria-labelledby="shipping-quote-title"
    >
      <h2 id="shipping-quote-title">Consultar frete</h2>
      <p id="shipping-quote-help">
        Informe o peso total e as medidas da embalagem fechada. O valor e o
        prazo são estimativas da transportadora. Use centímetros inteiros,
        arredondando as medidas para cima.
      </p>
      <p v-if="!canQuote" id="shipping-quote-unavailable">
        Conecte a conta para consultar o frete.
      </p>
      <form
        v-else
        aria-describedby="shipping-quote-help"
        :aria-busy="quoteBusy"
        @submit.prevent="calculate"
      >
        <div class="shipping-fields">
          <div class="shipping-field">
            <label for="shipping-from">CEP de origem</label>
            <input
              id="shipping-from"
              v-model="fields.fromPostalCode"
              inputmode="numeric"
              autocomplete="off"
              pattern="[0-9]{5}-?[0-9]{3}"
              maxlength="9"
              required
            />
          </div>
          <div class="shipping-field">
            <label for="shipping-to">CEP de destino</label>
            <input
              id="shipping-to"
              v-model="fields.toPostalCode"
              inputmode="numeric"
              autocomplete="off"
              pattern="[0-9]{5}-?[0-9]{3}"
              maxlength="9"
              required
            />
          </div>
          <div
            v-for="field in [
              { key: 'weightGrams', label: 'Peso total (g)', step: '1' },
              { key: 'widthCm', label: 'Largura (cm)', step: '1' },
              { key: 'heightCm', label: 'Altura (cm)', step: '1' },
              { key: 'lengthCm', label: 'Comprimento (cm)', step: '1' },
            ]"
            :key="field.key"
            class="shipping-field"
          >
            <label :for="`shipping-${field.key}`">{{ field.label }}</label>
            <input
              :id="`shipping-${field.key}`"
              v-model="fields[field.key]"
              type="number"
              inputmode="numeric"
              :min="field.step"
              :step="field.step"
              required
            />
          </div>
          <div class="shipping-field">
            <label for="shipping-insurance">Valor segurado (R$)</label>
            <input
              id="shipping-insurance"
              v-model="fields.insuranceValue"
              inputmode="decimal"
              maxlength="12"
              required
            />
          </div>
        </div>
        <p v-if="quoteError" ref="quoteNotice" tabindex="-1" role="alert">
          {{ quoteError }}
        </p>
        <div class="inline-actions">
          <button
            class="primary"
            type="submit"
            :aria-disabled="quoteBusy || accountBusy ? 'true' : undefined"
            :aria-busy="quoteBusy"
          >
            {{ quoteBusy ? 'Consultando frete…' : 'Consultar frete' }}
          </button>
        </div>
      </form>
      <div v-if="quote" class="shipping-results">
        <h3 ref="resultsHeading" tabindex="-1">Opções de frete</h3>
        <p v-if="!quote.services.length">
          Nenhum serviço disponível para esta embalagem e estes CEPs.
        </p>
        <div
          v-else
          class="shipping-table-wrap"
          tabindex="0"
          role="region"
          aria-label="Tabela de opções de frete"
        >
          <table>
            <caption class="sr-only">
              Cotação da embalagem informada
            </caption>
            <thead>
              <tr>
                <th scope="col">Transportadora e serviço</th>
                <th scope="col">Valor</th>
                <th scope="col">Prazo previsto</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="service in quote.services" :key="service.id">
                <th scope="row">{{ service.company }} · {{ service.name }}</th>
                <td>{{ money(service.priceCents) }}</td>
                <td>
                  {{
                    service.deliveryDays === null
                      ? 'Não informado'
                      : `${service.deliveryDays} dias úteis`
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="quote.unavailable?.length">
          <h3>Serviços indisponíveis</h3>
          <ul>
            <li v-for="service in quote.unavailable" :key="service.id">
              {{ service.name }}: {{ service.message }}
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.shipping-page,
.shipping-section,
.shipping-results {
  display: grid;
  gap: var(--space-4);
}
.shipping-section p,
.shipping-section h2,
.shipping-section h3 {
  margin: 0;
}
.shipping-section,
.shipping-results {
  min-inline-size: 0;
}
.shipping-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: var(--space-4);
}
.shipping-field {
  display: grid;
  gap: var(--space-3);
}
.shipping-field input,
.shipping-page button {
  min-block-size: var(--target-min);
}
.shipping-table-wrap {
  overflow-x: auto;
}
.shipping-page table {
  inline-size: 100%;
  border-collapse: collapse;
  text-align: start;
}
.shipping-page th,
.shipping-page td {
  padding: var(--space-3);
  border-block-end: 1px solid var(--color-border);
  vertical-align: top;
}
</style>
