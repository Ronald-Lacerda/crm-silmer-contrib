<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useRouter } from 'vue-router';
import ClientRegistration from '../components/ClientRegistration.vue';
import { request } from '../lib/api-client.js';
import {
  CHANNEL_LABELS,
  conversationLabel,
  dateTimeBR,
  formatPhoneNumber,
} from '../lib/format.js';

const LIVE_REFRESH_DELAY_MS = 250;

const props = defineProps({ selectedId: { type: String, default: '' } });
const liveEvent = inject('liveEvent', ref(null));
const router = useRouter();
const heading = ref(null);
const searchInput = ref(null);
const query = ref('');
const loading = ref(true);
const detailLoading = ref(false);
const refreshing = ref(false);
const hasLoadedContacts = ref(false);
const error = ref('');
const contacts = ref([]);
const totalCount = ref(0);
const nextCursor = ref(null);
const loadingMore = ref(false);
const detail = ref(null);
const busy = ref(false);
const renaming = ref(false);
const draftName = ref('');
const renameBase = ref(null);
const renameConflict = ref(false);
const renameCurrentKnown = ref(false);
const actionMessage = ref('');
const nameInput = ref(null);
const renameTrigger = ref(null);
let listController;
let detailController;
let refreshTimer = 0;
let searchTimer = 0;

const filtered = computed(() => contacts.value);
const selected = computed(() => detail.value?.contact ?? null);

function openContact(contact, event) {
  if (event.target?.closest?.('a, button, input, select, textarea')) return;
  void router.push(`/clientes/${contact.id}`);
}

/** @param {unknown} cause */
function describeError(cause) {
  const status = Number(/** @type {any} */ (cause)?.status);
  if (status === 403) return 'Sem permissão para renomear este contato.';
  if (status === 409) {
    return 'O contato mudou enquanto você editava. Os dados foram recarregados.';
  }
  if (status === 400) return 'Informe um nome com até 120 caracteres.';
  if (status >= 500) return 'Serviço indisponível no momento.';
  return 'Não foi possível salvar o nome.';
}

/** @param {boolean} [silent] */
async function loadContacts(silent = false) {
  listController?.abort();
  const currentController = new AbortController();
  listController = currentController;
  if (!silent) {
    loading.value = true;
    error.value = '';
  } else refreshing.value = true;
  try {
    const needle = query.value.trim();
    const response = await request(
      needle ? '/api/v1/contacts/search' : '/api/v1/contacts?limit=100',
      needle
        ? {
            body: { limit: 100, q: needle },
            method: 'POST',
            signal: currentController.signal,
          }
        : { signal: currentController.signal },
    );
    contacts.value = response.data.items;
    totalCount.value = response.data.totalCount;
    nextCursor.value = response.data.nextCursor;
    hasLoadedContacts.value = true;
    error.value = '';
    const id = props.selectedId || selected.value?.id || contacts.value[0]?.id;
    if (id) await loadContact(id, silent);
    else detail.value = null;
  } catch (cause) {
    if (cause?.name !== 'AbortError') {
      error.value = hasLoadedContacts.value
        ? 'Não foi possível atualizar os clientes. Os dados exibidos podem estar desatualizados.'
        : 'Não foi possível carregar os clientes.';
    }
  } finally {
    if (listController === currentController) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function loadMoreContacts() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  const needle = query.value.trim();
  const cursor = nextCursor.value;
  try {
    const response = await request(
      needle
        ? '/api/v1/contacts/search'
        : `/api/v1/contacts?limit=100&cursor=${encodeURIComponent(cursor)}`,
      needle ? { body: { cursor, limit: 100, q: needle }, method: 'POST' } : {},
    );
    if (query.value.trim() !== needle) return;
    contacts.value = [...contacts.value, ...response.data.items];
    nextCursor.value = response.data.nextCursor;
  } catch {
    error.value = 'Não foi possível carregar mais clientes.';
  } finally {
    loadingMore.value = false;
  }
}

/** @param {string} id @param {boolean} [silent] */
async function loadContact(id, silent = false) {
  if (!id) return;
  detailController?.abort();
  const currentController = new AbortController();
  detailController = currentController;
  if (!silent) {
    detailLoading.value = true;
    error.value = '';
  }
  try {
    const response = await request(
      `/api/v1/contacts/${encodeURIComponent(id)}`,
      {
        signal: currentController.signal,
      },
    );
    detail.value = response.data;
    error.value = '';
  } catch (cause) {
    if (cause?.name !== 'AbortError') {
      error.value =
        silent && detail.value
          ? 'Não foi possível atualizar este cliente. Os dados exibidos podem estar desatualizados.'
          : 'Não foi possível carregar o contato selecionado.';
      if (!silent) detail.value = null;
    }
  } finally {
    if (detailController === currentController) detailLoading.value = false;
  }
}

async function retryInitialLoad() {
  await loadContacts();
  await nextTick();
  heading.value?.focus();
}

function clearSearch() {
  query.value = '';
  void nextTick(() => searchInput.value?.focus());
}

async function openRename() {
  if (!selected.value) return;
  draftName.value = selected.value?.displayName ?? '';
  renameBase.value = {
    contactId: selected.value.id,
    expectedVersion: selected.value.version,
  };
  renameConflict.value = false;
  renameCurrentKnown.value = false;
  error.value = '';
  renaming.value = true;
  await nextTick();
  nameInput.value?.focus();
}

async function refreshConflictName() {
  const contactId = renameBase.value?.contactId;
  if (!contactId) return;
  try {
    const response = await request(
      `/api/v1/contacts/${encodeURIComponent(contactId)}`,
    );
    if (renameBase.value?.contactId !== contactId) return;
    detail.value = response.data;
    renameCurrentKnown.value = true;
  } catch {
    renameCurrentKnown.value = false;
  }
}

async function cancelRename() {
  const hadConflict = renameConflict.value;
  const contactId = renameBase.value?.contactId;
  renaming.value = false;
  renameBase.value = null;
  renameConflict.value = false;
  renameCurrentKnown.value = false;
  if (hadConflict && contactId) await loadContact(contactId, true);
  await nextTick();
  renameTrigger.value?.focus();
}

async function saveName() {
  const base = renameBase.value;
  if (
    !base ||
    selected.value?.id !== base.contactId ||
    busy.value ||
    renameConflict.value
  )
    return;
  busy.value = true;
  error.value = '';
  actionMessage.value = '';
  try {
    await request(
      `/api/v1/contacts/${encodeURIComponent(base.contactId)}/name`,
      {
        body: {
          displayName: draftName.value.trim(),
          expectedVersion: base.expectedVersion,
          reason: 'Nome do contato ajustado na ficha do cliente',
        },
        method: 'POST',
      },
    );
    actionMessage.value = 'Nome do contato atualizado.';
    renaming.value = false;
    renameBase.value = null;
    await loadContacts(true);
    await nextTick();
    renameTrigger.value?.focus();
  } catch (cause) {
    if (Number(cause?.status) === 409) {
      renameConflict.value = true;
      await refreshConflictName();
      await nextTick();
      nameInput.value?.focus();
    } else {
      error.value = describeError(cause);
    }
  } finally {
    busy.value = false;
  }
}

/**
 * CP-25: the registration form saved. Show the answer at once, then reload
 * the list so its "Cadastro completo" mark follows. With `partial` only the
 * phone and e-mail were saved; the form stays open and says so itself.
 *
 * @param {Record<string, any>} patch @param {boolean} [partial]
 */
function onRegistrationSaved(patch, partial = false) {
  const current = detail.value?.contact;
  if (current?.id === patch.id) {
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    detail.value = { ...detail.value, contact: { ...current, ...changes } };
  }
  if (patch.registrationStatus) {
    contacts.value = contacts.value.map((contact) =>
      contact.id === patch.id
        ? { ...contact, registrationStatus: patch.registrationStatus }
        : contact,
    );
  }
  if (!partial) actionMessage.value = 'Cadastro do cliente salvo.';
  void loadContacts(true);
}

/** @param {Record<string, any>} data */
function onRegistrationLoaded(data) {
  if (data?.contact?.id && data.contact.id === selected.value?.id)
    detail.value = data;
}

/** Collapses bursts of live events into one silent refresh. */
function scheduleLiveRefresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void loadContacts(true);
  }, LIVE_REFRESH_DELAY_MS);
}

watch(
  () => props.selectedId,
  (id) => {
    if (id && id !== renameBase.value?.contactId) {
      renaming.value = false;
      renameBase.value = null;
      renameConflict.value = false;
    }
    if (id && id !== selected.value?.id) void loadContact(id);
  },
);
onMounted(() => {
  heading.value?.focus();
  void loadContacts();
});
watch(liveEvent, (event) => {
  if (event) scheduleLiveRefresh();
});
watch(query, () => {
  listController?.abort();
  if (searchTimer) globalThis.clearTimeout(searchTimer);
  searchTimer = globalThis.setTimeout(() => {
    searchTimer = 0;
    void loadContacts();
  }, 300);
});
onBeforeUnmount(() => {
  listController?.abort();
  detailController?.abort();
  if (searchTimer) globalThis.clearTimeout(searchTimer);
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="page">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Clientes</h1>
        <p>
          Clientes, canais de contato e histórico de atendimento, atualizados
          automaticamente.
        </p>
      </div>
    </header>

    <div class="filter-bar">
      <div class="search-control">
        <label for="client-search">Buscar cliente por nome ou telefone</label>
        <div class="search-field">
          <input
            id="client-search"
            ref="searchInput"
            v-model="query"
            type="search"
          />
          <button
            v-if="query"
            type="button"
            aria-label="Limpar busca"
            @click="clearSearch"
          >
            Limpar
          </button>
        </div>
      </div>
      <p class="filter-summary">
        {{ filtered.length }} exibidos · {{ totalCount }} contatos
      </p>
    </div>

    <div v-if="error && hasLoadedContacts" role="alert" class="audit-note">
      <p>{{ error }}</p>
      <button type="button" :disabled="refreshing" @click="loadContacts(true)">
        Tentar novamente
      </button>
    </div>
    <p v-if="actionMessage" role="status" class="audit-note">
      {{ actionMessage }}
    </p>
    <div v-if="loading" class="loading-state" role="status">
      Carregando contatos…
    </div>
    <section
      v-else-if="error && !hasLoadedContacts"
      class="surface empty-list"
      role="alert"
    >
      <h2>Clientes indisponíveis</h2>
      <p>{{ error }}</p>
      <button type="button" @click="retryInitialLoad">Tentar novamente</button>
    </section>
    <div v-else class="clients-layout">
      <section class="surface list-panel" aria-labelledby="portfolio-title">
        <div class="panel-head">
          <h2 id="portfolio-title">Lista de clientes</h2>
          <p>Ordenados pela atualização cadastral</p>
        </div>
        <p v-if="filtered.length" class="table-scroll-hint">
          Deslize a tabela para ver todas as colunas.
        </p>
        <div
          v-if="filtered.length"
          class="table-wrap list-scroll"
          role="region"
          tabindex="0"
          aria-label="Clientes; role horizontalmente para ver todas as colunas"
        >
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Contato</th>
                <th scope="col">Telefone e canais</th>
                <th scope="col">Situação</th>
                <th scope="col">Última atividade</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="contact in filtered"
                :key="contact.id"
                class="clickable-row"
                :data-selected="selected?.id === contact.id"
                @click="openContact(contact, $event)"
              >
                <td>
                  <RouterLink class="row-link" :to="`/clientes/${contact.id}`">
                    {{ contact.label }}
                  </RouterLink>
                  <span
                    v-if="contact.registrationStatus === 'complete'"
                    class="registration-mark"
                    >Cadastro completo</span
                  >
                </td>
                <td>
                  <span v-if="contact.phone">{{
                    formatPhoneNumber(contact.phone)
                  }}</span>
                  <span v-if="contact.phoneSource === 'site_unverified'">
                    · informado no site · não confirmado
                  </span>
                  {{
                    contact.identities
                      .map((identity) =>
                        identity.channel === 'site_chat'
                          ? 'Chat do site'
                          : CHANNEL_LABELS[identity.channel],
                      )
                      .join(', ') ||
                    (contact.phone ? '· sem canal' : 'Sem canal')
                  }}
                </td>
                <td>{{ contact.provisional ? 'Provisório' : 'Canônico' }}</td>
                <td>{{ dateTimeBR(contact.latestActivityAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-list">
          <h3>Nenhum contato encontrado</h3>
          <p>Revise a busca informada.</p>
        </div>
        <button
          v-if="nextCursor"
          type="button"
          :disabled="loadingMore"
          @click="loadMoreContacts"
        >
          {{ loadingMore ? 'Carregando…' : 'Carregar mais clientes' }}
        </button>
      </section>

      <section
        v-if="selected"
        class="surface"
        :aria-labelledby="`client-${selected.id}`"
      >
        <div class="client-head">
          <form v-if="renaming" class="rename-form" @submit.prevent="saveName">
            <h2 :id="`client-${selected.id}`" class="sr-only">
              {{ selected.label }}
            </h2>
            <label :for="`client-name-${selected.id}`">Nome do contato</label>
            <input
              :id="`client-name-${selected.id}`"
              ref="nameInput"
              v-model="draftName"
              type="text"
              maxlength="120"
              placeholder="Sem nome definido"
            />
            <div v-if="renameConflict" class="audit-note" role="alert">
              <p>O nome mudou enquanto você editava. Seu texto foi mantido.</p>
              <p v-if="renameCurrentKnown">
                Nome atual: {{ selected.label }}. Cancele e abra a edição
                novamente para revisar antes de salvar.
              </p>
              <p v-else>
                Não foi possível consultar o nome atual. Consulte novamente ou
                cancele para atualizar.
              </p>
              <button type="button" @click="refreshConflictName">
                Consultar nome atual
              </button>
            </div>
            <div class="inline-actions">
              <button
                type="submit"
                class="primary"
                :disabled="busy || renameConflict"
              >
                Salvar nome
              </button>
              <button type="button" :disabled="busy" @click="cancelRename">
                Cancelar
              </button>
            </div>
          </form>
          <template v-else>
            <div class="client-title-row">
              <h2 :id="`client-${selected.id}`">{{ selected.label }}</h2>
              <button
                ref="renameTrigger"
                type="button"
                class="link-button"
                @click="openRename"
              >
                Editar nome
              </button>
            </div>
          </template>
        </div>
        <div v-if="detailLoading" class="loading-state" role="status">
          Carregando histórico…
        </div>
        <template v-else>
          <dl class="client-facts client-facts--single">
            <div>
              <dt>Cadastrado em</dt>
              <dd>{{ dateTimeBR(selected.createdAt) }}</dd>
            </div>
            <div v-if="selected.phone">
              <dt>Telefone informado</dt>
              <dd>
                {{ formatPhoneNumber(selected.phone) }}
                <span v-if="selected.phoneSource === 'site_unverified'">
                  · informado no site · não confirmado
                </span>
              </dd>
            </div>
            <div v-if="selected.email">
              <dt>E-mail</dt>
              <dd>{{ selected.email }}</dd>
            </div>
          </dl>

          <ClientRegistration
            :key="selected.id"
            :contact="selected"
            @saved="onRegistrationSaved"
            @loaded="onRegistrationLoaded"
          />

          <div class="panel-head subsection-heading">
            <h3>Canais de contato</h3>
          </div>
          <ul class="history-list contact-channels">
            <li v-for="identity in detail.identities" :key="identity.id">
              <template v-if="identity.kind !== 'phone'">
                <strong>{{
                  identity.channel === 'site_chat'
                    ? 'Chat do site'
                    : (CHANNEL_LABELS[identity.channel] ?? identity.channel)
                }}</strong>
                <span v-if="identity.channel !== 'site_chat'">{{
                  identity.displayHandle ?? identity.externalId
                }}</span>
              </template>
              <dl v-if="identity.kind === 'phone'" class="contact-phone">
                <div>
                  <dt>Telefone</dt>
                  <dd>{{ formatPhoneNumber(identity.externalId) }}</dd>
                </div>
              </dl>
            </li>
          </ul>

          <div class="panel-head subsection-heading">
            <h3>Conversas</h3>
          </div>
          <ul v-if="detail.conversations.length" class="history-list">
            <li
              v-for="conversation in detail.conversations"
              :key="conversation.id"
            >
              <RouterLink
                :to="`/inbox/${encodeURIComponent(conversation.id)}`"
                >{{ CHANNEL_LABELS[conversation.channel] }}</RouterLink
              >
              <span>{{ conversationLabel(conversation) }}</span>
              <small
                >Última mensagem em
                {{ dateTimeBR(conversation.lastMessageAt) }}</small
              >
            </li>
          </ul>
          <p v-else class="empty-list">Nenhuma conversa associada.</p>
        </template>
      </section>
      <section v-else class="surface empty-list" aria-live="polite">
        <h2>Selecione um contato</h2>
        <p>Identidades e conversas aparecerão aqui.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.clickable-row {
  cursor: pointer;
}
</style>

<style scoped>
.client-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem 1rem;
}

.client-title-row .link-button {
  flex: none;
}

.client-facts--single {
  grid-template-columns: minmax(0, 1fr);
}

.contact-phone {
  display: grid;
  gap: 0.25rem;
  margin: 0.35rem 0 0;
}

.contact-phone dt {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.contact-phone dd {
  margin: 0.1rem 0 0;
  font-size: var(--text-sm);
  font-weight: 600;
}

.contact-channels li {
  padding-inline-start: 0;
  border-inline-start: 0;
}

/* CP-26: only a complete registration is marked, so the list stays quiet. */
.registration-mark {
  display: block;
  margin-block-start: 0.2rem;
  color: var(--status-success-text);
  font-size: var(--text-xs);
  font-weight: 600;
}
</style>
