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
import { commandKey, request } from '../lib/api-client.js';
import { consumeOlistCallback } from '../lib/olist-callback.js';

const props = defineProps({
  session: { type: Object, required: true },
  announce: { type: Function, required: true },
  showError: { type: Function, required: true },
});
const base = '/api/v1/integrations/olist';
const user = computed(() => props.session.user ?? props.session);
const canManage = computed(() =>
  (user.value.capabilities ?? []).includes('COMMERCIAL_ADMIN'),
);
const canOperate = computed(() => user.value.olistEnabled === true);
const heading = ref(null);
const resultHeading = ref(null);
const lookupNotice = ref(null);
const accountNotice = ref(null);
const query = ref('');
const result = ref(null);
const lookupBusy = ref(false);
const lookupError = ref('');
const accountError = ref('');
const accountMessage = ref('');
const status = ref(null);
const loading = ref(false);
const accountBusy = ref(false);
const settingsEditing = ref(false);
const settingsForm = ref(null);
const settingsEditButton = ref(null);
const idFields = [
  { key: 'sellerId', label: 'Vendedor no Olist (ID)' },
  { key: 'operationNatureId', label: 'Natureza de operação (ID)' },
  { key: 'warehouseId', label: 'Depósito (ID)' },
  { key: 'paymentMethodId', label: 'Forma de pagamento (ID)' },
  { key: 'priceListId', label: 'Lista de preços (ID)' },
  { key: 'originId', label: 'Origem CRM no Olist (ID)' },
];
const settings = reactive(
  Object.fromEntries([
    ...idFields.map((field) => [field.key, '']),
    ['paymentTerms', ''],
    ['purchaseOrder', ''],
  ]),
);
let lookupController;
let accountController;
let disposed = false;
const connectionLabel = computed(() => {
  if (!status.value) return 'Estado indisponível';
  if (!status.value.configured) return 'Conexão ainda não configurada';
  if (status.value.reconnectRequired) return 'Reconexão necessária';
  return status.value.connected ? 'Conta conectada' : 'Conta desconectada';
});

/** @param {unknown} cause */
function failureText(cause) {
  const error = /** @type {any} */ (cause);
  if (error?.status === 401 || error?.status === 403)
    return 'Seu acesso mudou ou sua sessão expirou. Entre novamente para continuar.';
  if (error?.status === 404)
    return 'Pedido não encontrado. Confira o número completo ou o identificador.';
  if (error?.status === 429)
    return 'Aguarde um momento antes de consultar novamente.';
  if (error?.status === 409)
    return 'A conexão ou configuração mudou. Atualize os dados antes de tentar novamente.';
  if (error?.status === 400 || error?.status === 422)
    return 'Confira os dados informados e tente novamente.';
  return 'Não foi possível concluir agora. Tente novamente em instantes.';
}

/** @param {import('vue').Ref<any>} target */
async function focus(target) {
  await nextTick();
  if (!disposed) target.value?.focus();
}

function clearLookup() {
  lookupController?.abort();
  lookupController = undefined;
  lookupBusy.value = false;
  lookupError.value = '';
  result.value = null;
}
watch(query, clearLookup, { flush: 'sync' });
watch(canOperate, (allowed) => {
  if (!allowed) clearLookup();
});
watch(canManage, (allowed) => {
  if (allowed) return;
  accountController?.abort();
  status.value = null;
  settingsEditing.value = false;
});

async function lookup() {
  if (!canOperate.value || lookupBusy.value) return;
  const value = query.value.trim();
  if (
    !/^(?:\d{1,12}-CRM|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(
      value,
    )
  ) {
    lookupError.value =
      'Informe o número completo do pedido, como 41-CRM, ou seu identificador UUID.';
    await focus(lookupNotice);
    return;
  }
  const own = new AbortController();
  lookupController?.abort();
  lookupController = own;
  lookupBusy.value = true;
  lookupError.value = '';
  result.value = null;
  try {
    const response = await request(`${base}/order-lookup`, {
      method: 'POST',
      body: { query: value },
      idempotencyKey: commandKey(),
      signal: own.signal,
    });
    if (
      disposed ||
      own.signal.aborted ||
      lookupController !== own ||
      !canOperate.value
    )
      return;
    result.value = response.data;
    props.announce(`Pedido ${result.value.number} localizado.`);
    await focus(resultHeading);
  } catch (cause) {
    if (disposed || own.signal.aborted || lookupController !== own) return;
    lookupError.value = failureText(cause);
    await focus(lookupNotice);
  } finally {
    if (lookupController === own && !disposed) lookupBusy.value = false;
  }
}

async function loadStatus() {
  if (!canManage.value || accountBusy.value) return;
  accountController?.abort();
  const own = new AbortController();
  accountController = own;
  loading.value = true;
  accountError.value = '';
  try {
    const response = await request(`${base}/status`, { signal: own.signal });
    if (disposed || own.signal.aborted || !canManage.value) return;
    status.value = response.data;
    copySettings();
  } catch (cause) {
    if (disposed || own.signal.aborted) return;
    accountError.value = failureText(cause);
  } finally {
    if (!disposed && accountController === own) loading.value = false;
  }
}

function copySettings() {
  for (const key of Object.keys(settings))
    settings[key] = String(status.value?.settings?.[key] ?? '');
}

async function beginSettingsEdit() {
  copySettings();
  settingsEditing.value = true;
  await nextTick();
  if (!disposed) settingsForm.value?.querySelector('input')?.focus();
}

async function cancelSettingsEdit() {
  settingsEditing.value = false;
  copySettings();
  await focus(settingsEditButton);
}

/** @param {'authorize'|'complete'|'disconnect'|'settings'} action @param {Record<string, unknown>} body */
async function accountAction(action, body) {
  if (!canManage.value || accountBusy.value || loading.value) return;
  const own = new AbortController();
  accountController?.abort();
  accountController = own;
  accountBusy.value = true;
  accountError.value = '';
  accountMessage.value = '';
  try {
    const response = await request(`${base}/${action}`, {
      method: 'POST',
      body,
      signal: own.signal,
      ...(action === 'complete' ? {} : { idempotencyKey: commandKey() }),
    });
    if (disposed || own.signal.aborted || !canManage.value) return;
    if (action === 'authorize') {
      const url = new URL(response.data.authorizationUrl);
      if (
        url.origin !== 'https://accounts.tiny.com.br' ||
        url.pathname !== '/realms/tiny/protocol/openid-connect/auth' ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('Invalid authorization destination');
      globalThis.location.assign(url.href);
      return;
    }
    status.value = response.data;
    copySettings();
    settingsEditing.value = false;
    accountMessage.value =
      action === 'complete'
        ? 'Conta Olist conectada.'
        : action === 'settings'
          ? 'Parâmetros comerciais salvos.'
          : 'Conta Olist desconectada do CRM.';
    props.announce(accountMessage.value);
    await focus(heading);
  } catch (cause) {
    if (disposed || own.signal.aborted) return;
    accountError.value =
      action === 'complete'
        ? 'Não foi possível concluir a autorização. Inicie uma nova conexão com o Olist.'
        : failureText(cause);
    await focus(accountNotice);
  } finally {
    if (!disposed && accountController === own) accountBusy.value = false;
  }
}

function saveSettings() {
  /** @type {Record<string, string|number|null>} */
  const values = {};
  for (const field of idFields) {
    const value = String(settings[field.key]).trim();
    if (
      value &&
      (!/^\d+$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) <= 0)
    ) {
      accountError.value =
        'Os identificadores devem ser números inteiros positivos.';
      void focus(accountNotice);
      return;
    }
    values[field.key] = value ? Number(value) : null;
  }
  values.paymentTerms = settings.paymentTerms.trim() || null;
  values.purchaseOrder = settings.purchaseOrder.trim() || null;
  void accountAction('settings', {
    expectedVersion: status.value.settingsVersion,
    reason: 'Parâmetros comerciais Olist atualizados pelo administrador',
    settings: values,
  });
}

onMounted(async () => {
  heading.value?.focus();
  const callback = consumeOlistCallback();
  await loadStatus();
  if (disposed || !callback || !canManage.value) return;
  if (callback.error || !callback.code || !callback.state) {
    accountError.value =
      'A autorização não foi concluída. Inicie uma nova conexão.';
    await focus(accountNotice);
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
  lookupController?.abort();
  accountController?.abort();
});
</script>

<template>
  <div class="page olist-page">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Olist</h1>
        <p>Consulte a preparação dos pedidos para o Olist.</p>
      </div>
    </header>
    <p class="olist-release-note">
      A geração de vendas está desativada nesta etapa.
    </p>

    <section
      v-if="canOperate"
      class="surface"
      aria-labelledby="olist-lookup-title"
      :aria-busy="lookupBusy"
    >
      <h2 id="olist-lookup-title">Localizar pedido</h2>
      <p class="field-help">
        Use o número completo ou o identificador do pedido, de qualquer
        responsável ou origem.
      </p>
      <form class="olist-lookup-form" @submit.prevent="lookup">
        <div class="olist-field">
          <label for="olist-query">Número ou identificador do pedido</label>
          <input
            id="olist-query"
            v-model="query"
            type="text"
            maxlength="36"
            autocomplete="off"
            required
            aria-describedby="olist-query-help"
          />
          <p id="olist-query-help" class="field-help">
            Exemplo: 41-CRM. A busca é exata.
          </p>
        </div>
        <button class="primary" type="submit" :disabled="lookupBusy">
          {{ lookupBusy ? 'Localizando…' : 'Localizar pedido' }}
        </button>
      </form>
      <p
        v-if="lookupError"
        ref="lookupNotice"
        class="inline-error"
        role="alert"
        tabindex="-1"
      >
        {{ lookupError }}
      </p>
      <div v-if="result" class="olist-result">
        <h3 ref="resultHeading" tabindex="-1">Pedido {{ result.number }}</h3>
        <p>
          Situação:
          {{
            result.status === 'confirmado'
              ? 'Confirmado'
              : result.status === 'cancelado'
                ? 'Cancelado'
                : 'Pendente'
          }}
        </p>
        <template v-if="result.pendingFields?.length">
          <h4>Pendências para o Olist</h4>
          <ul>
            <li v-for="field in result.pendingFields" :key="field.code">
              {{ field.label }}
            </li>
          </ul>
          <p class="field-help">
            Peça a uma pessoa autorizada a corrigir o pedido ou cadastro de
            origem.
          </p>
        </template>
        <p v-if="result.operation?.number">
          Venda Olist: {{ result.operation.number }}
        </p>
        <p v-else-if="result.operation">
          Existe uma operação Olist em acompanhamento.
        </p>
        <p v-else>Nenhuma venda Olist vinculada.</p>
      </div>
    </section>
    <p v-else class="surface">
      Seu usuário não está habilitado para operar pedidos no Olist. Outro
      administrador pode conceder essa habilitação em Usuários.
    </p>

    <section
      v-if="canManage"
      class="surface"
      aria-labelledby="olist-account-title"
      :aria-busy="loading || accountBusy"
    >
      <div class="panel-head">
        <h2 id="olist-account-title">Conexão da empresa</h2>
        <button
          class="quiet"
          type="button"
          :disabled="loading || accountBusy"
          @click="loadStatus"
        >
          Atualizar conexão
        </button>
      </div>
      <p v-if="loading" role="status">Consultando a conexão…</p>
      <template v-else>
        <p>{{ connectionLabel }}</p>
        <p v-if="status && !status.accountConfigured" class="field-help">
          A conta da empresa precisa ser configurada antes da conexão.
        </p>
        <p v-if="status && !status.configured" class="field-help">
          A configuração da integração precisa ser concluída pela operação.
        </p>
        <p v-if="accountMessage" role="status">{{ accountMessage }}</p>
        <p
          v-if="accountError"
          ref="accountNotice"
          class="inline-error"
          role="alert"
          tabindex="-1"
        >
          {{ accountError }}
        </p>
        <div v-if="status?.configured" class="button-row">
          <button
            type="button"
            :disabled="accountBusy"
            @click="accountAction('authorize', {})"
          >
            {{ status.connected ? 'Reconectar Olist' : 'Conectar Olist' }}
          </button>
          <button
            v-if="status.connected || status.reconnectRequired"
            class="quiet"
            type="button"
            :disabled="accountBusy"
            @click="
              accountAction('disconnect', {
                expectedVersion: status.version,
                reason: 'Conexão Olist encerrada pelo administrador',
              })
            "
          >
            Desconectar Olist
          </button>
        </div>
        <details v-if="status" class="olist-settings">
          <summary>Parâmetros comerciais</summary>
          <p class="field-help">
            Parâmetros centrais da empresa. Confira os identificadores na conta
            Olist; o responsável do CRM não define o vendedor do ERP.
          </p>
          <form
            v-if="settingsEditing"
            ref="settingsForm"
            @submit.prevent="saveSettings"
          >
            <div class="olist-settings-grid">
              <div
                v-for="field in idFields"
                :key="field.key"
                class="olist-field"
              >
                <label :for="`olist-${field.key}`">{{ field.label }}</label>
                <input
                  :id="`olist-${field.key}`"
                  v-model="settings[field.key]"
                  type="number"
                  min="1"
                  step="1"
                  :disabled="accountBusy"
                />
              </div>
              <div class="olist-field">
                <label for="olist-payment-terms">Prazo de pagamento</label
                ><input
                  id="olist-payment-terms"
                  v-model="settings.paymentTerms"
                  type="text"
                  maxlength="120"
                  :disabled="accountBusy"
                />
              </div>
              <div class="olist-field">
                <label for="olist-purchase-order">Ordem de compra padrão</label
                ><input
                  id="olist-purchase-order"
                  v-model="settings.purchaseOrder"
                  type="text"
                  maxlength="120"
                  :disabled="accountBusy"
                />
              </div>
            </div>
            <div class="button-row">
              <button
                class="quiet"
                type="button"
                :disabled="accountBusy"
                @click="cancelSettingsEdit"
              >
                Cancelar</button
              ><button class="primary" type="submit" :disabled="accountBusy">
                {{ accountBusy ? 'Salvando…' : 'Salvar parâmetros' }}
              </button>
            </div>
          </form>
          <template v-else>
            <dl class="olist-settings-list">
              <template v-for="field in idFields" :key="field.key"
                ><dt>{{ field.label }}</dt>
                <dd>
                  {{ status.settings?.[field.key] ?? 'Não informado' }}
                </dd></template
              >
              <dt>Prazo de pagamento</dt>
              <dd>{{ status.settings?.paymentTerms || 'Não informado' }}</dd>
              <dt>Ordem de compra padrão</dt>
              <dd>{{ status.settings?.purchaseOrder || 'Não informado' }}</dd>
            </dl>
            <button
              ref="settingsEditButton"
              type="button"
              :disabled="accountBusy"
              @click="beginSettingsEdit"
            >
              Editar parâmetros
            </button>
          </template>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.olist-page {
  max-inline-size: 62rem;
}
.olist-page > .surface + .surface {
  margin-block-start: var(--space-6);
}
.olist-release-note {
  color: var(--color-text-muted);
  margin-block: 0 var(--space-6);
}
.olist-lookup-form {
  display: grid;
  gap: var(--space-4);
  align-items: start;
}
.olist-field {
  display: grid;
  gap: var(--space-2);
  min-inline-size: 0;
}
.olist-field label {
  margin: 0;
}
.olist-field input {
  inline-size: 100%;
  min-inline-size: 0;
}
.olist-field .field-help {
  margin: 0;
}
.olist-result {
  margin-block-start: var(--space-6);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border-subtle);
}
.olist-result h3 {
  margin-block-start: 0;
}
.olist-result h3:focus {
  outline: none;
}
.olist-settings {
  margin-block-start: var(--space-6);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border-subtle);
}
.olist-settings summary {
  cursor: pointer;
  min-block-size: var(--target-min);
  align-content: center;
  font-weight: 600;
}
.olist-settings-grid {
  display: grid;
  gap: var(--space-4);
  margin-block-end: var(--space-4);
}
.olist-settings-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
}
.olist-settings-list dt {
  color: var(--color-text-muted);
}
.olist-settings-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (width >= 48rem) {
  .olist-lookup-form {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .olist-lookup-form > button {
    margin-block-start: 1.9rem;
  }
  .olist-settings-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
