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
import { brand } from '../brand/index.js';
import { ApiError, commandKey, request } from '../lib/api-client.js';

const props = defineProps({
  announce: { type: Function, required: true },
  session: { type: Object, required: true },
  showError: { type: Function, required: true },
});
const liveEvent = inject('liveEvent', ref(null));
const liveConnection = inject('liveConnection', ref('indisponível'));
// Pesquisa UX 2026-10-15, achado 6: the shell's visible notice; without a
// shell (tests of the view alone) the screen-reader announcement remains.
const notify = inject(
  'notify',
  /** @param {string} message */ (message) => props.announce(message),
);

const CREATE_REASON = 'Conta criada pelo administrador comercial';
const UPDATE_REASON = 'Conta atualizada pelo administrador comercial';
const DELETE_REASON =
  'Conta sem histórico excluída pelo administrador comercial';

const heading = ref(null);
const users = ref([]);
const loading = ref(true);
const busy = ref(false);
/** Credentials of the account just created, kept only until the panel closes. */
const handover = ref(null);
const editing = ref(null);
const copied = ref(false);
const confirmingDelete = ref(null);
const confirmingDisable = ref(null);
const disableCancel = ref(null);
/** @type {HTMLElement|null} */
let disableTrigger = null;
const deleteCancel = ref(null);
const deleteTrigger = ref(null);
const actionMenu = ref(null);
const actionMenuFor = ref(null);
const actionMenuPosition = ref({ left: 0, top: 0 });
const actionMenuTrigger = ref(null);
const interactionBlocked = computed(
  () =>
    busy.value ||
    Boolean(
      editing.value ||
      confirmingDelete.value ||
      confirmingDisable.value ||
      actionMenuFor.value,
    ),
);
let fallbackTimer = 0;
let pendingLiveRefresh = false;

const currentUser = computed(() => props.session.user ?? props.session);
const isAdmin = computed(() =>
  (currentUser.value.capabilities ?? []).includes('COMMERCIAL_ADMIN'),
);
const activeCount = computed(
  () => users.value.filter((user) => !user.disabledAt).length,
);

const markdown = computed(() => {
  if (!handover.value) return '';
  return [
    `**Acesso ao ${brand.productName}**`,
    '',
    `- Nome: ${handover.value.name}`,
    `- E-mail: ${handover.value.email}`,
    `- Senha: ${handover.value.password}`,
    `- Entrar em: ${globalThis.location.origin}`,
  ].join('\n');
});

onMounted(async () => {
  heading.value?.focus();
  globalThis.document.addEventListener('pointerdown', closeActionMenuOnOutside);
  globalThis.addEventListener('keydown', closeActionMenuOnEscape);
  globalThis.addEventListener('resize', closeActionMenu);
  await load();
  fallbackTimer = globalThis.setInterval(() => {
    if (
      liveConnection.value !== 'conectado' &&
      globalThis.document.visibilityState === 'visible'
    )
      queueLiveRefresh();
  }, 30_000);
});

onBeforeUnmount(() => {
  globalThis.document.removeEventListener(
    'pointerdown',
    closeActionMenuOnOutside,
  );
  globalThis.removeEventListener('keydown', closeActionMenuOnEscape);
  globalThis.removeEventListener('resize', closeActionMenu);
  if (fallbackTimer) globalThis.clearInterval(fallbackTimer);
});

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const response = await request('/api/v1/users');
    users.value = response.data.users ?? [];
  } catch (error) {
    if (!silent) props.showError(publicMessage(error));
  } finally {
    if (!silent) loading.value = false;
  }
}

function flushLiveRefresh() {
  if (!pendingLiveRefresh || interactionBlocked.value) return;
  pendingLiveRefresh = false;
  void load(true);
}

function queueLiveRefresh() {
  pendingLiveRefresh = true;
  flushLiveRefresh();
}

watch(liveEvent, (event) => {
  if (event?.reset || event?.type === 'identity.user.changed')
    queueLiveRefresh();
});

watch(interactionBlocked, (blocked) => {
  if (!blocked) flushLiveRefresh();
});

/** @param {SubmitEvent} event */
async function submitCreate(event) {
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const values = formValues(form);
  props.showError('');
  busy.value = true;
  try {
    await request('/api/v1/users', {
      method: 'POST',
      idempotencyKey: commandKey(),
      body: {
        email: values.email,
        name: values.name,
        password: values.password,
        accessType: values.accessType,
        olistEnabled: values.olistEnabled === 'on',
        reason: CREATE_REASON,
      },
    });
    // The password never comes back from the API, so the block is built from
    // what the administrator typed, before the form is cleared.
    handover.value = {
      email: values.email,
      name: values.name,
      password: values.password,
    };
    copied.value = false;
    form.reset();
    await load();
    props.announce(`Conta de ${values.name} criada.`);
  } catch (error) {
    props.showError(publicMessage(error));
  } finally {
    busy.value = false;
  }
}

/** @param {SubmitEvent} event */
async function submitEdit(event) {
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const values = formValues(form);
  const target = editing.value;
  props.showError('');
  busy.value = true;
  try {
    /** @type {Record<string, string | boolean | number>} */
    const body = { reason: UPDATE_REASON };
    if (values.name !== target.name) body.name = values.name;
    if (values.email !== target.email) body.email = values.email;
    if (values.password !== '') body.password = values.password;
    if (values.accessType && values.accessType !== accessType(target))
      body.accessType = values.accessType;
    const olistEnabled = values.olistEnabled === 'on';
    const ownDisabledCheckbox =
      target.id === currentUser.value.id && target.olistEnabled !== true;
    if (
      !ownDisabledCheckbox &&
      olistEnabled !== (target.olistEnabled === true)
    ) {
      body.olistEnabled = olistEnabled;
      body.expectedOlistAuthorizationVersion =
        target.olistAuthorizationVersion ?? 0;
    }
    if (Object.keys(body).length === 1) {
      editing.value = null;
      return;
    }
    await request(`/api/v1/users/${encodeURIComponent(target.id)}`, {
      method: 'PATCH',
      idempotencyKey: commandKey(),
      body,
    });
    editing.value = null;
    await load();
    props.announce(`Conta de ${values.name} atualizada.`);
  } catch (error) {
    props.showError(publicMessage(error));
  } finally {
    busy.value = false;
  }
}

/** @param {Record<string, any>} user @param {boolean} disabled */
async function changeDisabled(user, disabled) {
  closeActionMenu();
  props.showError('');
  busy.value = true;
  let changed = false;
  try {
    await request(
      `/api/v1/users/${encodeURIComponent(user.id)}/${
        disabled ? 'disable' : 'enable'
      }`,
      {
        method: 'POST',
        idempotencyKey: commandKey(),
        body: { reason: UPDATE_REASON },
      },
    );
    editing.value = null;
    await load();
    changed = true;
    if (disabled) {
      notify(`Conta de ${user.name} desativada.`, {
        actionLabel: 'Desfazer',
        onAction: () => changeDisabled(user, false),
      });
    } else {
      notify(`Conta de ${user.name} reativada.`);
    }
  } catch (error) {
    props.showError(publicMessage(error));
  } finally {
    busy.value = false;
  }
  return changed;
}

/** @param {Record<string, any>} user */
function rowTrigger(user) {
  return /** @type {HTMLElement|null} */ (
    globalThis.document.querySelector(
      `[aria-controls="user-actions-${globalThis.CSS.escape(user.id)}"]`,
    )
  );
}

/**
 * Pesquisa UX 2026-10-15, achado 6: disabling locks a person out at once,
 * so it is confirmed first. From the edit dialog the confirmation replaces
 * it — never a dialog over a dialog.
 *
 * @param {Record<string, any>} user
 */
function requestDisable(user) {
  disableTrigger = actionMenuTrigger.value ?? rowTrigger(user);
  closeActionMenu();
  editing.value = null;
  props.showError('');
  confirmingDisable.value = user;
}

function cancelDisable() {
  confirmingDisable.value = null;
  nextTick(() => disableTrigger?.focus());
}

async function confirmDisable() {
  const user = confirmingDisable.value;
  if (!user) return;
  const changed = await changeDisabled(user, true);
  if (!changed) return;
  confirmingDisable.value = null;
  await nextTick();
  (rowTrigger(user) ?? disableTrigger)?.focus();
}

watch(confirmingDisable, async (user) => {
  if (!user) return;
  await nextTick();
  disableCancel.value?.focus();
});

/** @param {Record<string, any>} user */
function requestDelete(user) {
  deleteTrigger.value = actionMenuTrigger.value;
  closeActionMenu();
  confirmingDelete.value = user;
}

function cancelDelete() {
  confirmingDelete.value = null;
  nextTick(() => deleteTrigger.value?.focus());
}

async function deleteUser() {
  const user = confirmingDelete.value;
  if (!user) return;
  props.showError('');
  busy.value = true;
  try {
    await request(`/api/v1/users/${encodeURIComponent(user.id)}`, {
      method: 'DELETE',
      idempotencyKey: commandKey(),
      body: { reason: DELETE_REASON },
    });
    await load();
    confirmingDelete.value = null;
    props.announce(`Conta de ${user.name} excluída.`);
  } catch (error) {
    props.showError(publicMessage(error));
  } finally {
    busy.value = false;
  }
}

watch(confirmingDelete, async (user) => {
  if (!user) return;
  await nextTick();
  deleteCancel.value?.focus();
});

async function copyMarkdown() {
  try {
    await globalThis.navigator.clipboard.writeText(markdown.value);
    copied.value = true;
    props.announce('Bloco copiado.');
  } catch {
    copied.value = false;
    props.showError('Não foi possível copiar. Selecione o texto manualmente.');
  }
}

/** @param {Record<string, any>} user */
function startEdit(user) {
  closeActionMenu();
  props.showError('');
  editing.value = user;
}

/** @param {Record<string, any>} user @param {MouseEvent} event */
function toggleActionMenu(user, event) {
  if (actionMenuFor.value?.id === user.id) {
    closeActionMenu();
    return;
  }

  const trigger = /** @type {HTMLElement} */ (event.currentTarget);
  const bounds = trigger.getBoundingClientRect();
  const menuWidth = 160;
  const menuHeight = user.canDelete ? 132 : 96;
  const edge = 8;
  const openBelow = globalThis.innerHeight - bounds.bottom >= menuHeight + edge;

  actionMenuPosition.value = {
    left: Math.min(
      Math.max(edge, bounds.right - menuWidth),
      globalThis.innerWidth - menuWidth - edge,
    ),
    top: openBelow
      ? bounds.bottom + 4
      : Math.max(edge, bounds.top - menuHeight - 4),
  };
  actionMenuTrigger.value = trigger;
  actionMenuFor.value = user;
}

function closeActionMenu() {
  actionMenuFor.value = null;
  actionMenuTrigger.value = null;
}

/** @param {PointerEvent} event */
function closeActionMenuOnOutside(event) {
  const target = event.target;
  if (!(target instanceof globalThis.Node)) return;
  if (actionMenu.value?.contains(target)) return;
  if (actionMenuTrigger.value?.contains(target)) return;
  closeActionMenu();
}

/** @param {KeyboardEvent} event */
function closeActionMenuOnEscape(event) {
  if (event.key !== 'Escape' || !actionMenuFor.value) return;
  event.preventDefault();
  const trigger = actionMenuTrigger.value;
  closeActionMenu();
  nextTick(() => trigger?.focus());
}

/** @param {string | null} value */
function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR').format(new Date(value));
}

/** @param {string} name */
function initials(name) {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/** @param {Record<string, any>} user */
function isAdminUser(user) {
  return (user.capabilities ?? []).includes('COMMERCIAL_ADMIN');
}

/** @param {Record<string, any>} user */
function accessType(user) {
  if (isAdminUser(user)) return 'admin';
  return user.functionName === 'Financeiro' ? 'finance' : 'seller';
}

/** @param {Record<string, any>} user */
function accessLabel(user) {
  return { seller: 'Vendedor', finance: 'Financeiro', admin: 'Administrador' }[
    accessType(user)
  ];
}

/** @param {unknown} error */
function publicMessage(error) {
  if (error instanceof ApiError) {
    if (error.code === 'EMAIL_ALREADY_REGISTERED')
      return 'Esse e-mail já pertence a outra conta.';
    if (error.code === 'USER_HAS_HISTORY')
      return 'Essa conta possui histórico e só pode ser desativada.';
    if (error.code === 'USER_IS_ADMINISTRATOR')
      return 'Contas de administrador não podem ser excluídas.';
    if (error.status === 403)
      return 'Você não tem permissão para concluir esta ação.';
    if (error.status === 404) return 'Essa conta não existe mais.';
    if (error.code === 'VERSION_CONFLICT')
      return 'A habilitação Olist mudou em outra sessão. Feche a edição, atualize a lista e tente novamente.';
  }
  return 'Não foi possível concluir. Revise os dados e tente novamente.';
}

/** @param {HTMLFormElement} form */
function formValues(form) {
  return Object.fromEntries(
    [...new globalThis.FormData(form).entries()].map(([key, value]) => [
      key,
      String(value),
    ]),
  );
}
</script>

<template>
  <div class="page users-page">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Usuários</h1>
        <p>
          Gerencie as contas e os perfis de acesso ao CRM. O acesso a esta área
          é exclusivo de administradores.
        </p>
      </div>
    </header>

    <p v-if="!isAdmin" class="surface" role="status">
      Esta área é exclusiva de administradores comerciais.
    </p>

    <div v-else class="users-layout">
      <section class="surface" aria-labelledby="users-overview">
        <div class="count-line">
          <div>
            <h2 id="users-overview">Usuários do CRM</h2>
          </div>
          <p v-if="!loading">
            {{ users.length }} contas · {{ activeCount }} ativas ·
            {{ users.length - activeCount }} desativadas
          </p>
        </div>

        <p v-if="loading" role="status">Carregando contas…</p>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Usuário</th>
                <th scope="col">Acesso</th>
                <th scope="col">Situação</th>
                <th scope="col">Criado em</th>
                <th scope="col"><span class="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="user in users"
                :key="user.id"
                :data-disabled="Boolean(user.disabledAt)"
              >
                <td>
                  <div class="user-cell">
                    <span class="avatar" aria-hidden="true">
                      {{ initials(user.name) }}
                    </span>
                    <div>
                      <div class="user-name">{{ user.name }}</div>
                      <div class="user-email">{{ user.email }}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    class="badge"
                    :data-tone="isAdminUser(user) ? 'info' : undefined"
                  >
                    {{ accessLabel(user) }}
                  </span>
                </td>
                <td>
                  <span
                    class="badge"
                    :data-tone="user.disabledAt ? 'warning' : 'success'"
                  >
                    {{ user.disabledAt ? 'Desativado' : 'Ativo' }}
                  </span>
                </td>
                <td>{{ formatDate(user.createdAt) }}</td>
                <td class="row-menu-cell">
                  <button
                    class="row-menu-trigger"
                    type="button"
                    :aria-label="`Mais ações para ${user.name}`"
                    :aria-controls="`user-actions-${user.id}`"
                    :aria-expanded="actionMenuFor?.id === user.id"
                    @click="toggleActionMenu(user, $event)"
                  >
                    <span class="action-menu-icon" aria-hidden="true">
                      <span></span><span></span><span></span>
                    </span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <Teleport to="body">
        <div
          v-if="actionMenuFor"
          :id="`user-actions-${actionMenuFor.id}`"
          ref="actionMenu"
          class="row-menu-actions row-menu-popover"
          :style="{
            left: `${actionMenuPosition.left}px`,
            top: `${actionMenuPosition.top}px`,
          }"
        >
          <button class="small" type="button" @click="startEdit(actionMenuFor)">
            Editar
          </button>
          <button
            v-if="actionMenuFor.id !== currentUser.id"
            class="small quiet"
            type="button"
            :disabled="busy"
            @click="
              actionMenuFor.disabledAt
                ? changeDisabled(actionMenuFor, false)
                : requestDisable(actionMenuFor)
            "
          >
            {{ actionMenuFor.disabledAt ? 'Reativar' : 'Desativar' }}
          </button>
          <button
            v-if="actionMenuFor.canDelete"
            class="small"
            type="button"
            :disabled="busy"
            @click="requestDelete(actionMenuFor)"
          >
            Excluir
          </button>
        </div>
      </Teleport>

      <section
        v-if="handover"
        class="surface handover-panel"
        aria-labelledby="handover-title"
      >
        <h2 id="handover-title">{{ handover.name }}</h2>
        <p class="field-help">
          Copie o bloco abaixo e entregue à pessoa. A senha não volta a ser
          exibida depois que você sair desta tela.
        </p>
        <div class="markdown-head">
          <span class="markdown-label">Markdown</span>
          <button class="small" type="button" @click="copyMarkdown">
            {{ copied ? 'Copiado' : 'Copiar' }}
          </button>
        </div>
        <pre
          class="markdown-block"
          tabindex="0"
        ><code>{{ markdown }}</code></pre>
        <div class="button-row">
          <button class="quiet" type="button" @click="handover = null">
            Fechar
          </button>
        </div>
      </section>

      <section v-else class="surface" aria-labelledby="create-user">
        <h2 id="create-user">Criar usuário</h2>
        <form @submit.prevent="submitCreate">
          <label for="new-name">Nome</label>
          <input id="new-name" name="name" type="text" required />
          <label for="new-email">E-mail</label>
          <input id="new-email" name="email" type="email" required />
          <label for="new-access">Perfil de acesso</label>
          <select id="new-access" name="accessType" :disabled="busy">
            <option value="seller">Vendedor</option>
            <option value="finance">Financeiro</option>
            <option value="admin">Administrador</option>
          </select>
          <label class="olist-checkbox" for="new-olist">
            <input
              id="new-olist"
              name="olistEnabled"
              type="checkbox"
              :disabled="busy"
            />
            Habilitado Olist
          </label>
          <p class="field-help">
            Permite consultar e operar pedidos no Olist, sem conceder edição de
            pedidos de outras pessoas.
          </p>
          <label for="new-password">Senha</label>
          <input
            id="new-password"
            name="password"
            type="text"
            autocomplete="off"
            required
          />
          <p class="field-help">
            Você define a senha. Ela aparece uma única vez, no bloco pronto para
            copiar.
          </p>
          <div class="button-row">
            <button class="primary" type="submit" :disabled="busy">
              {{ busy ? 'Criando…' : 'Criar usuário' }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <div v-if="editing" class="overlay" @click.self="editing = null">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-title"
      >
        <h2 id="edit-title">{{ editing.name }}</h2>
        <form @submit.prevent="submitEdit">
          <label for="edit-name">Nome</label>
          <input
            id="edit-name"
            name="name"
            type="text"
            :value="editing.name"
            required
          />
          <label for="edit-email">E-mail</label>
          <input
            id="edit-email"
            name="email"
            type="email"
            :value="editing.email"
            required
          />
          <label for="edit-access">Perfil de acesso</label>
          <select
            id="edit-access"
            name="accessType"
            :value="accessType(editing)"
            :disabled="busy || editing.id === currentUser.id"
            :aria-describedby="
              editing.id === currentUser.id ? 'own-access-help' : undefined
            "
          >
            <option value="seller">Vendedor</option>
            <option value="finance">Financeiro</option>
            <option value="admin">Administrador</option>
          </select>
          <p
            v-if="editing.id === currentUser.id"
            id="own-access-help"
            class="field-help"
          >
            Seu próprio perfil de acesso não pode ser alterado.
          </p>
          <label class="olist-checkbox" for="edit-olist">
            <input
              id="edit-olist"
              name="olistEnabled"
              type="checkbox"
              :checked="editing.olistEnabled === true"
              :disabled="
                busy ||
                (editing.id === currentUser.id && editing.olistEnabled !== true)
              "
              aria-describedby="edit-olist-help"
            />
            Habilitado Olist
          </label>
          <p id="edit-olist-help" class="field-help">
            {{
              editing.id === currentUser.id && editing.olistEnabled !== true
                ? 'Outro administrador deve habilitar seu acesso ao Olist.'
                : 'A alteração vale para as sessões e operações em andamento.'
            }}
          </p>
          <label for="edit-password">Nova senha</label>
          <input
            id="edit-password"
            name="password"
            type="text"
            autocomplete="off"
            placeholder="Deixe em branco para manter a atual"
          />
          <p class="field-help">
            Trocar a senha não derruba as sessões abertas: ela vale a partir do
            próximo login.
          </p>
          <div class="dialog-footer">
            <button
              v-if="editing.id !== currentUser.id && !editing.disabledAt"
              class="danger"
              type="button"
              :disabled="busy"
              @click="requestDisable(editing)"
            >
              Desativar conta
            </button>
            <span v-else></span>
            <div class="button-row">
              <button class="quiet" type="button" @click="editing = null">
                Cancelar
              </button>
              <button class="primary" type="submit" :disabled="busy">
                {{ busy ? 'Salvando…' : 'Salvar alterações' }}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>

    <div
      v-if="confirmingDisable"
      class="overlay"
      @click.self="cancelDisable"
      @keydown.esc="cancelDisable"
    >
      <section
        class="dialog delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="disable-title"
        aria-describedby="disable-description"
      >
        <h2 id="disable-title">Desativar {{ confirmingDisable.name }}?</h2>
        <p id="disable-description">
          A pessoa perde o acesso ao CRM na hora e deixa de poder assumir
          atendimentos. Conversas e pedidos já registrados continuam no
          histórico, e a conta pode ser reativada depois.
        </p>
        <div class="dialog-footer">
          <span></span>
          <div class="button-row">
            <button
              ref="disableCancel"
              class="quiet"
              type="button"
              :disabled="busy"
              @click="cancelDisable"
            >
              Cancelar
            </button>
            <button
              class="danger"
              type="button"
              :disabled="busy"
              @click="confirmDisable"
            >
              {{ busy ? 'Desativando…' : 'Desativar conta' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <div
      v-if="confirmingDelete"
      class="overlay"
      @click.self="cancelDelete"
      @keydown.esc="cancelDelete"
    >
      <section
        class="dialog delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-description"
      >
        <h2 id="delete-title">Excluir {{ confirmingDelete.name }}?</h2>
        <p id="delete-description">
          Esta ação remove a conta permanentemente e não pode ser desfeita.
        </p>
        <div class="dialog-footer">
          <span></span>
          <div class="button-row">
            <button
              ref="deleteCancel"
              class="quiet"
              type="button"
              :disabled="busy"
              @click="cancelDelete"
            >
              Cancelar
            </button>
            <button
              class="danger"
              type="button"
              :disabled="busy"
              @click="deleteUser"
            >
              {{ busy ? 'Excluindo…' : 'Excluir conta' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
