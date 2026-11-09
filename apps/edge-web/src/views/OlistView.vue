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
import { useRoute } from 'vue-router';
import OrderOlistPanel from '../components/order/OrderOlistPanel.vue';
import { commandKey, request } from '../lib/api-client.js';
import { consumeOlistCallback } from '../lib/olist-callback.js';
import OlistMappingsPanel from '../components/OlistMappingsPanel.vue';
import { olistAdminFailure } from '../lib/olist-admin-feedback.js';

const props = defineProps({
  session: { type: Object, required: true },
  announce: { type: Function, required: true },
  showError: { type: Function, required: true },
});
const base = '/api/v1/integrations/olist';
const route = useRoute();
const selectedOrderId = computed(() => {
  const id = route.query.pedido;
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
    ? id
    : '';
});
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
// The Olist projection carries no cancellation; the lookup of this same order
// does. A page opened straight from the address has no lookup: the API
// refuses (ORDER_CANCELLED) and the panel explains it.
const lookupCancelled = computed(
  () =>
    result.value?.orderId === selectedOrderId.value &&
    result.value?.status === 'cancelado',
);
const lookupBusy = ref(false);
const lookupError = ref('');
const accountError = ref('');
const accountMessage = ref('');
const creationReason = ref('');
const recoveryReason = ref('');
const recoveryAttested = ref(false);
const status = ref(null);
const accountCreationActive = computed(
  () => status.value?.creationActive ?? status.value?.creationEnabled ?? false,
);
const loading = ref(false);
const accountBusy = ref(false);
const settingsEditing = ref(false);
const settingsForm = ref(null);
const settingsEditButton = ref(null);
const editingVersion = ref(0);
const settingsConflict = ref(false);
const fiscal = reactive({ ncm: '', origin: '', unit: '' });
const idFields = [
  { key: 'sellerId', label: 'Vendedor no Olist (ID)' },
  { key: 'operationNatureId', label: 'Natureza de operação (ID)' },
  { key: 'warehouseId', label: 'Depósito (ID)' },
  { key: 'paymentMethodId', label: 'Forma de pagamento (ID)' },
  { key: 'receivingMethodId', label: 'Forma de recebimento (ID)' },
  { key: 'priceListId', label: 'Lista de preços (ID)' },
  { key: 'originId', label: 'Origem CRM no Olist (ID)' },
];
const settings = reactive(
  Object.fromEntries([
    ...idFields.map((field) => [field.key, '']),
    ['paymentDueOn', ''],
    ['paymentTerms', ''],
    ['purchaseOrder', ''],
  ]),
);
let lookupController;
let accountController;
let disposed = false;
const expiresLabel = computed(() => {
  const value = Date.parse(status.value?.expiresAt ?? '');
  return Number.isFinite(value)
    ? new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'America/Sao_Paulo',
      }).format(value)
    : '';
});
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
  copySettings();
});

async function lookup() {
  if (!canOperate.value || lookupBusy.value) return;
  const value = query.value.trim();
  if (
    !/^(?:[0-9]{2,15}-CRM|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.test(
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
  if (!canManage.value || accountBusy.value || settingsEditing.value) return;
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
    status.value = null;
    copySettings();
    accountError.value = olistAdminFailure(cause);
  } finally {
    if (!disposed && accountController === own) {
      loading.value = false;
      if (accountError.value) await focus(accountNotice);
    }
  }
}

function copySettings() {
  for (const key of Object.keys(settings))
    settings[key] = String(status.value?.settings?.[key] ?? '');
  for (const key of Object.keys(fiscal))
    fiscal[key] = String(status.value?.settings?.productFiscal?.[key] ?? '');
}

async function denyAdministration() {
  status.value = null;
  settingsEditing.value = false;
  copySettings();
  accountError.value = olistAdminFailure({ status: 403 });
  await focus(accountNotice);
}

async function beginSettingsEdit() {
  if (
    !canManage.value ||
    !status.value?.configured ||
    loading.value ||
    accountBusy.value
  )
    return;
  copySettings();
  editingVersion.value = status.value.settingsVersion;
  settingsConflict.value = false;
  accountError.value = '';
  accountMessage.value = '';
  settingsEditing.value = true;
  await nextTick();
  if (!disposed) settingsForm.value?.querySelector('input')?.focus();
}

async function cancelSettingsEdit() {
  settingsEditing.value = false;
  accountError.value = '';
  copySettings();
  if (settingsConflict.value) await loadStatus();
  settingsConflict.value = false;
  await focus(settingsEditButton);
}

/** @param {'authorize'|'complete'|'disconnect'|'settings'|'creation'|'recovery'} action @param {Record<string, unknown>} body */
async function accountAction(action, body) {
  if (!canManage.value || accountBusy.value || loading.value) return;
  if (settingsEditing.value && action !== 'settings') return;
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
          : action === 'creation'
            ? accountCreationActive.value
              ? 'Geração Olist ativada para o piloto.'
              : 'Geração Olist desativada.'
            : action === 'recovery'
              ? 'Conferência registrada. A geração continua desativada.'
              : 'Conta Olist desconectada do CRM.';
    if (action === 'creation') creationReason.value = '';
    if (action === 'recovery') {
      recoveryReason.value = '';
      recoveryAttested.value = false;
    }
    props.announce(accountMessage.value);
    await focus(heading);
  } catch (cause) {
    if (disposed || own.signal.aborted) return;
    accountError.value =
      action === 'complete'
        ? 'Não foi possível concluir a autorização. Inicie uma nova conexão com o Olist.'
        : olistAdminFailure(cause);
    if (action === 'settings' && /** @type {any} */ (cause)?.status === 409) {
      settingsConflict.value = true;
      accountError.value =
        'Os parâmetros mudaram em outra sessão. Cancele a edição para carregar a versão atual e revisar antes de salvar.';
    }
    if ([401, 403].includes(/** @type {any} */ (cause)?.status)) {
      status.value = null;
      settingsEditing.value = false;
      copySettings();
    }
    await focus(accountNotice);
  } finally {
    if (!disposed && accountController === own) accountBusy.value = false;
  }
}

function saveSettings() {
  if (!canManage.value || !settingsEditing.value || settingsConflict.value)
    return;
  /** @type {Record<string, any>} */
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
  values.paymentDueOn = settings.paymentDueOn || null;
  values.paymentTerms = settings.paymentTerms.trim() || null;
  const fiscalValues = Object.values(fiscal).map((value) => value.trim());
  if (
    fiscalValues.some(Boolean) &&
    (!/^[0-9]{8}$/u.test(fiscal.ncm) ||
      !/^[0-8]$/u.test(fiscal.origin) ||
      !/^[A-Z0-9]{1,6}$/u.test(fiscal.unit))
  ) {
    accountError.value =
      'Informe NCM com 8 dígitos, origem fiscal entre 0 e 8 e unidade com até 6 letras maiúsculas ou números. Para remover a configuração fiscal, limpe os três campos.';
    void focus(accountNotice);
    return;
  }
  values.productFiscal = fiscalValues.some(Boolean)
    ? { ncm: fiscal.ncm, origin: Number(fiscal.origin), unit: fiscal.unit }
    : null;
  values.purchaseOrder = settings.purchaseOrder.trim() || null;
  void accountAction('settings', {
    expectedVersion: editingVersion.value,
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
        <p>
          {{
            canManage
              ? 'Gerencie a conexão e os parâmetros centrais do Olist.'
              : 'Consulte a preparação dos pedidos para o Olist.'
          }}
        </p>
      </div>
    </header>
    <p class="olist-release-note">
      A disponibilidade da geração é conferida na prévia de cada pedido.
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
        <RouterLink :to="{ path: '/olist', query: { pedido: result.orderId } }"
          >Conferir pedido no Olist</RouterLink
        >
      </div>
    </section>
    <p v-else class="surface">
      Seu usuário não está habilitado para operar pedidos no Olist. Outro
      administrador pode conceder essa habilitação em Usuários.
    </p>

    <OrderOlistPanel
      v-if="canOperate && selectedOrderId"
      :key="selectedOrderId"
      :order-id="selectedOrderId"
      :cancelled="lookupCancelled"
    />
    <p
      v-else-if="canOperate && route.query.pedido"
      class="inline-error"
      role="alert"
    >
      Identificador de pedido inválido. Localize o pedido pelo número completo.
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
          :disabled="loading || accountBusy || settingsEditing"
          @click="loadStatus"
        >
          Atualizar conexão
        </button>
      </div>
      <p v-if="loading" role="status">Consultando a conexão…</p>
      <template v-if="!loading || status">
        <p>{{ connectionLabel }}</p>
        <p v-if="status" class="field-help">
          Ambiente: produção. Use a empresa autorizada para esta integração. A
          empresa é conferida ao conectar e reconectar.
        </p>
        <p v-if="status?.connected && expiresLabel" class="field-help">
          Acesso válido até {{ expiresLabel }} (horário de São Paulo). A
          renovação é automática enquanto a autorização permitir.
        </p>
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
            :disabled="loading || accountBusy || settingsEditing"
            @click="accountAction('authorize', {})"
          >
            {{
              status.connected || status.reconnectRequired
                ? 'Reconectar Olist'
                : 'Conectar Olist'
            }}
          </button>
          <button
            v-if="status.connected || status.reconnectRequired"
            class="quiet"
            type="button"
            :disabled="loading || accountBusy || settingsEditing"
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
        <details v-if="status?.configured" class="olist-settings">
          <summary>Geração no piloto</summary>
          <p role="status">
            {{
              accountCreationActive ? 'Geração ativada.' : 'Geração desativada.'
            }}
          </p>
          <p id="olist-creation-help" class="field-help">
            Somente a operadora designada e habilitada pode gerar vendas.
            Desativar preserva vendas e cadastros já registrados e permite sua
            conferência.
          </p>
          <p v-if="status.recoveryRequired" class="field-help">
            A geração aguarda a conferência da recuperação pela operação.
          </p>
          <p v-else-if="!status.pilotConfigured" class="field-help">
            A operação precisa configurar a identidade da operadora do piloto.
          </p>
          <form
            v-if="status.recoveryRequired"
            @submit.prevent="
              accountAction('recovery', {
                expectedVersion: status.version,
                confirmed: recoveryAttested,
                reason: recoveryReason.trim(),
              })
            "
          >
            <p id="olist-recovery-help" class="field-help">
              Confira os cadastros e as vendas já existentes antes de liberar a
              primeira geração ou retomar após uma recuperação. Resolva
              resultados incertos e confira a janela posterior ao backup.
              Registrar esta conferência não ativa a geração.
            </p>
            <label class="olist-checkbox">
              <input
                v-model="recoveryAttested"
                type="checkbox"
                required
                :disabled="
                  accountBusy ||
                  loading ||
                  settingsEditing ||
                  accountCreationActive
                "
                aria-describedby="olist-recovery-help"
              />
              Conferi os cadastros e as vendas existentes, inclusive a janela de
              recuperação.
            </label>
            <div class="olist-field">
              <label for="olist-recovery-reason">Motivo da conferência</label>
              <input
                id="olist-recovery-reason"
                v-model="recoveryReason"
                required
                maxlength="200"
                :disabled="
                  accountBusy ||
                  loading ||
                  settingsEditing ||
                  accountCreationActive
                "
              />
            </div>
            <button
              type="submit"
              :disabled="
                accountBusy ||
                loading ||
                settingsEditing ||
                accountCreationActive ||
                !recoveryAttested ||
                !recoveryReason.trim()
              "
            >
              Registrar conferência concluída
            </button>
          </form>
          <form
            @submit.prevent="
              accountAction('creation', {
                expectedVersion: status.version,
                enabled: !accountCreationActive,
                reason: creationReason.trim(),
              })
            "
          >
            <div class="olist-field">
              <label for="olist-creation-reason">Motivo da alteração</label>
              <input
                id="olist-creation-reason"
                v-model="creationReason"
                required
                maxlength="200"
                :disabled="accountBusy || loading || settingsEditing"
                aria-describedby="olist-creation-help"
              />
            </div>
            <button
              type="submit"
              :disabled="
                accountBusy ||
                loading ||
                settingsEditing ||
                !creationReason.trim() ||
                (!accountCreationActive &&
                  (!status.connected ||
                    status.recoveryRequired ||
                    !status.pilotConfigured))
              "
            >
              {{
                accountCreationActive
                  ? 'Desativar geração'
                  : 'Ativar geração no piloto'
              }}
            </button>
          </form>
        </details>
        <details v-if="status" class="olist-settings">
          <summary>Parâmetros comerciais</summary>
          <p class="field-help">
            Parâmetros centrais da empresa. Confira os identificadores na conta
            Olist; o responsável do CRM não define o vendedor do ERP.
          </p>
          <p class="field-help">
            Versão dos parâmetros: {{ status.settingsVersion }}.
            {{
              settingsEditing
                ? 'Salve ou cancele a edição antes de atualizar a conexão.'
                : 'Salvar substitui os parâmetros centrais e invalida prévias anteriores.'
            }}
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
                <label for="olist-payment-due">Vencimento do pagamento</label>
                <input
                  id="olist-payment-due"
                  v-model="settings.paymentDueOn"
                  type="date"
                  :disabled="accountBusy"
                  aria-describedby="olist-payment-due-help"
                />
                <p id="olist-payment-due-help" class="field-help">
                  Data explícita; não é calculada pelo prazo de pagamento.
                </p>
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
            <fieldset class="olist-fiscal" :disabled="accountBusy">
              <legend>Cadastro fiscal de novos produtos</legend>
              <p class="field-help">
                Preencha com orientação fiscal. Deixe os três campos vazios para
                manter o cadastro de novos produtos bloqueado.
              </p>
              <div class="olist-settings-grid">
                <div class="olist-field">
                  <label for="olist-ncm">NCM</label
                  ><input
                    id="olist-ncm"
                    v-model="fiscal.ncm"
                    type="text"
                    inputmode="numeric"
                    maxlength="8"
                  />
                </div>
                <div class="olist-field">
                  <label for="olist-fiscal-origin"
                    >Origem fiscal (código de 0 a 8)</label
                  ><input
                    id="olist-fiscal-origin"
                    v-model="fiscal.origin"
                    type="text"
                    inputmode="numeric"
                    maxlength="1"
                  />
                </div>
                <div class="olist-field">
                  <label for="olist-unit">Unidade fiscal</label
                  ><input
                    id="olist-unit"
                    v-model="fiscal.unit"
                    type="text"
                    maxlength="6"
                  />
                </div>
              </div>
            </fieldset>
            <div class="button-row">
              <button
                class="quiet"
                type="button"
                :disabled="accountBusy"
                @click="cancelSettingsEdit"
              >
                Cancelar</button
              ><button
                class="primary"
                type="submit"
                :disabled="accountBusy || settingsConflict"
              >
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
              <dt>Vencimento do pagamento</dt>
              <dd>
                {{
                  status.settings?.paymentDueOn
                    ? new Intl.DateTimeFormat('pt-BR', {
                        timeZone: 'UTC',
                      }).format(
                        new Date(status.settings.paymentDueOn + 'T00:00:00Z'),
                      )
                    : 'Não informado'
                }}
              </dd>
              <dt>Cadastro fiscal de novos produtos</dt>
              <dd>
                {{
                  status.settings?.productFiscal
                    ? `NCM ${status.settings.productFiscal.ncm} · Origem ${status.settings.productFiscal.origin} · ${status.settings.productFiscal.unit}`
                    : 'Não informado; cadastro de novos produtos bloqueado'
                }}
              </dd>
              <dt>Prazo de pagamento</dt>
              <dd>{{ status.settings?.paymentTerms || 'Não informado' }}</dd>
              <dt>Ordem de compra padrão</dt>
              <dd>{{ status.settings?.purchaseOrder || 'Não informado' }}</dd>
            </dl>
            <button
              ref="settingsEditButton"
              type="button"
              :disabled="!status.configured || loading || accountBusy"
              @click="beginSettingsEdit"
            >
              Editar parâmetros
            </button>
          </template>
        </details>
      </template>
    </section>
    <OlistMappingsPanel
      v-if="canManage && status?.configured && !loading && !accountBusy"
      :key="`${status.generation}:${status.version}:${status.settingsVersion}`"
      @access-denied="denyAdministration"
      :connected="
        Boolean(
          status.configured && status.connected && !status.reconnectRequired,
        )
      "
    />
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
.olist-fiscal {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin: 0 0 var(--space-4);
  min-inline-size: 0;
}
.olist-fiscal legend {
  padding-inline: var(--space-2);
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
  align-items: start;
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
