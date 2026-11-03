<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  provide,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import AppIcon from './components/AppIcon.vue';
import AppToast from './components/AppToast.vue';
import AuthPanel from './components/AuthPanel.vue';
import BrandMark from './components/BrandMark.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import { brand } from './brand/index.js';
import { ApiError, request } from './lib/api-client.js';
import { LiveEventStream } from './lib/event-stream.js';
import { canReadHealthErrors } from './lib/health-errors.js';
import { RETURN_QUERY, safeReturnPath } from './lib/return-path.js';

const router = useRouter();
const route = useRoute();
const SIDEBAR_STORAGE_KEY = 'crm.sidebar.compact';
const sidebarMedia = globalThis.matchMedia?.('(max-width: 1199px)');
const sidebarNarrow = ref(sidebarMedia?.matches ?? false);
const sidebarPreference = ref(readSidebarPreference());
const sidebarTipsDismissed = ref(false);
const sidebarCompact = computed(
  () =>
    sidebarPreference.value ??
    (route.path.startsWith('/inbox') || sidebarNarrow.value),
);

/** @returns {boolean | null} */
function readSidebarPreference() {
  try {
    const value = globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch {
    return null;
  }
}

function toggleSidebar() {
  sidebarPreference.value = !sidebarCompact.value;
  try {
    globalThis.localStorage?.setItem(
      SIDEBAR_STORAGE_KEY,
      String(sidebarPreference.value),
    );
  } catch {
    // The menu remains usable when browser storage is unavailable.
  }
}

/** @param {MediaQueryListEvent} event */
function updateSidebarWidth(event) {
  sidebarNarrow.value = event.matches;
}
sidebarMedia?.addEventListener('change', updateSidebarWidth);
onBeforeUnmount(() =>
  sidebarMedia?.removeEventListener('change', updateSidebarWidth),
);
const phase = ref('restoring');
const session = shallowRef(null);
const activeView = shallowRef(null);
const authPanel = ref(null);
const errorMessage = ref('');
const errorSummary = ref(null);
const runtimeStatus = ref('Verificando sua sessão…');
const connection = ref('conectando');
const lastUpdatedAt = ref(0);
const moreOpen = ref(false);
const logoutBusy = ref(false);
let lastAnnouncement = '';
let sessionRefreshInFlight = false;
let financeSessionTimer = 0;

const user = computed(() => session.value?.user ?? session.value ?? {});
const sidebarUserName = computed(() => user.value.name || 'Conta autenticada');
const sidebarUserEmail = computed(() => user.value.email || '');
const sidebarUserInitials = computed(() =>
  sidebarUserName.value
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toLocaleUpperCase('pt-BR'),
);
const sessionSummary = computed(
  () =>
    (isAdmin.value ? 'Administrador' : null) ??
    session.value?.functionName ??
    user.value.functionName ??
    'Conta autenticada',
);
const pageTitle = computed(() => String(route.meta.title ?? 'CRM'));
const isAdmin = computed(() =>
  (user.value.capabilities ?? []).includes('COMMERCIAL_ADMIN'),
);
const isFinance = computed(() => user.value.functionName === 'Financeiro');
const canAccessHealthErrors = computed(() => canReadHealthErrors(user.value));
const homePath = computed(() =>
  isFinance.value ? '/financeiro' : '/dashboard',
);
const canAccessCurrentRoute = computed(() => {
  if (isFinance.value) return ['/financeiro', '/conta'].includes(route.path);
  if (route.meta.requiresHealthErrors) return canAccessHealthErrors.value;
  if (route.meta.requiresFinance) return isAdmin.value;
  return route.meta.requiresAdmin !== true || isAdmin.value;
});
// One list feeds the sidebar and the mobile menu, so both always offer the
// same places (Usuários and Sair included on a phone).
const navItems = computed(() =>
  isFinance.value
    ? [
        { to: '/financeiro', label: 'Financeiro', icon: 'orders' },
        { to: '/conta', label: 'Minha conta', icon: 'account' },
      ]
    : [
        {
          to: '/dashboard',
          label: 'Dashboard',
          short: 'Início',
          icon: 'dashboard',
        },
        {
          to: '/inbox',
          label: 'Caixa de Entrada',
          short: 'Caixa',
          icon: 'inbox',
        },
        {
          to: '/pedidos',
          label: 'Pedidos',
          icon: 'orders',
          count: storeNewCount,
        },
        { to: '/clientes', label: 'Clientes', icon: 'clients' },
        ...(isAdmin.value
          ? [
              { to: '/financeiro', label: 'Financeiro', icon: 'orders' },
              { to: '/melhor-envio', label: 'Melhor Envio', icon: 'orders' },
              { to: '/usuarios', label: 'Usuários', icon: 'team' },
            ]
          : []),
        ...(canAccessHealthErrors.value
          ? [{ to: '/saude-erros', label: 'Saúde e erros', icon: 'panel' }]
          : []),
        { to: '/conta', label: 'Conta', icon: 'account' },
      ],
);

// Mobile-first: sellers live on the phone. The four daily places sit in a
// bottom bar under the thumb; the rest opens from "Mais".
const MOBILE_TABS = new Set(['/dashboard', '/inbox', '/pedidos', '/clientes']);
const mobileTabs = computed(() =>
  isFinance.value
    ? navItems.value
    : navItems.value.filter((item) => MOBILE_TABS.has(item.to)),
);
const mobileMore = computed(() =>
  isFinance.value
    ? []
    : navItems.value.filter((item) => !MOBILE_TABS.has(item.to)),
);
const moreActive = computed(() =>
  mobileMore.value.some((item) => sectionCurrent(item.to)),
);
/** @param {{label: string, count?: import('vue').Ref<number>}} item */
function tabName(item) {
  // The visible word must start the accessible name (WCAG 2.5.3): "Caixa"
  // reads "Caixa de Entrada"; "Início" stands for the Dashboard on its own.
  const base =
    item.short && !item.label.startsWith(item.short) ? item.short : item.label;
  const count = item.count?.value ?? 0;
  return count > 0 ? `${base}, ${count}${storeCountLabel.value}` : base;
}

// PGE-01: the order page belongs to Pedidos. RouterLink only marks a link it
// matches exactly, so `/pedidos/07-CRM` would leave the menu dark; each item
// claims its whole section instead.
/** @param {string} to */
function sectionCurrent(to) {
  return route.path === to || route.path.startsWith(`${to}/`)
    ? 'page'
    : undefined;
}
const connectionLabel = computed(() => {
  if (isFinance.value) return 'Atualização manual';
  if (connection.value === 'conectado') return 'Atualizado agora';
  if (connection.value === 'reconectando') return 'Reconectando…';
  if (connection.value === 'indisponível')
    return 'Atualização automática pausada';
  return 'Preparando atualização…';
});
const connectionDetail = computed(() =>
  isFinance.value
    ? 'Use Atualizar para conferir a fila financeira'
    : connection.value === 'conectado'
      ? 'Atualização automática ativa'
      : 'Tentando manter os dados atualizados',
);

// One live connection per session: the topic follows the route, because the
// server caps concurrent SSE streams and a second connection per user would
// halve how many people can stay online.
const liveEvent = ref(null);
const liveTopic = computed(() => (isFinance.value ? null : 'inbox'));
const stream = new LiveEventStream({
  onChange(event) {
    if (
      event.type === 'identity.user.changed' &&
      event.userId === user.value.id
    ) {
      void refreshShellSession();
    }
    activeView.value?.refreshFromEvent(event);
    liveEvent.value = { ...event, receivedAt: Date.now() };
    lastUpdatedAt.value = Date.now();
    announce('Conteúdo atualizado automaticamente.');
  },
  onReset() {
    void refreshShellSession();
    activeView.value?.reset();
    liveEvent.value = { receivedAt: Date.now(), reset: true };
    announce('A conexão foi ressincronizada.');
  },
  onSessionExpired() {
    void refreshShellSession();
    activeView.value?.reset();
    liveEvent.value = { receivedAt: Date.now(), reset: true };
  },
  onState(value) {
    connection.value = value;
    if (value === 'conectado' && lastUpdatedAt.value === 0) {
      lastUpdatedAt.value = Date.now();
    }
  },
});

provide('liveEvent', liveEvent);
provide('liveConnection', connection);
provide('sessionUser', user);

// Pesquisa UX 2026-10-15, achado 6: a visible confirmation of what a person
// just did, with an optional "Desfazer"; screen readers hear it once.
const toast = ref(null);
/**
 * @param {string} message
 * @param {{actionLabel?: string, onAction?: () => unknown}} [options]
 */
function notify(message, options) {
  toast.value?.notify(message, options);
  announce(message);
}
provide('notify', notify);

// LOJ-32 (ADR 031): the "Pedidos" item counts the new site orders — paid,
// not a test, ficha never printed. The Dashboard already reads the summary
// and publishes the number here (`storeNewCount`); on every other page the
// shell reads it when the session opens and after order events (collapsed).
// A failed read keeps the last number.
const storeNewCount = ref(0);
let storeCountTimer = 0;
const storeCountLabel = computed(() =>
  storeNewCount.value === 1 ? ' pedido novo do site' : ' pedidos novos do site',
);
provide('storeNewCount', storeNewCount);

async function refreshStoreCount() {
  if (
    phase.value !== 'authenticated' ||
    isFinance.value ||
    route.path === '/dashboard'
  )
    return;
  try {
    const response = await request('/api/v1/orders/summary');
    const count = Number(response.data?.storeNewCount ?? 0);
    storeNewCount.value = Number.isSafeInteger(count) && count > 0 ? count : 0;
  } catch {
    // The Dashboard notice stays the primary signal; the menu waits.
  }
}

function scheduleStoreCount() {
  if (storeCountTimer) globalThis.clearTimeout(storeCountTimer);
  storeCountTimer = globalThis.setTimeout(() => {
    storeCountTimer = 0;
    void refreshStoreCount();
  }, 300);
}

watch(liveEvent, (event) => {
  if (event?.reset || event?.type === 'inbox.order.changed') {
    scheduleStoreCount();
  }
});

watch(liveTopic, (topic) => {
  if (phase.value !== 'authenticated') return;
  if (topic) stream.start(topic);
  else stream.close();
});

watch(isFinance, (finance) => {
  if (financeSessionTimer) globalThis.clearInterval(financeSessionTimer);
  financeSessionTimer = finance
    ? globalThis.setInterval(() => {
        if (globalThis.document.visibilityState === 'visible')
          void refreshShellSession();
      }, 30_000)
    : 0;
});

watch(
  () => route.fullPath,
  () => {
    moreOpen.value = false;
    clearError();
    void redirectUnauthorizedAdminRoute();
  },
);

void restoreSession();
onBeforeUnmount(() => {
  stream.close();
  if (storeCountTimer) globalThis.clearTimeout(storeCountTimer);
  if (financeSessionTimer) globalThis.clearInterval(financeSessionTimer);
});

async function restoreSession() {
  phase.value = 'restoring';
  clearError();
  try {
    const response = await request('/api/v1/sessions/current');
    await showSession(response.data, false);
    announce('Sessão restaurada.');
  } catch (error) {
    if (
      error instanceof ApiError &&
      [400, 401, 403, 404].includes(error.status)
    ) {
      await showSignedOut(false, true);
      announce('Entre para continuar.');
      return;
    }
    phase.value = 'unavailable';
    announce('Não foi possível verificar sua sessão.');
  }
}

async function refreshShellSession() {
  if (phase.value !== 'authenticated' || sessionRefreshInFlight) return;
  sessionRefreshInFlight = true;
  try {
    const response = await request('/api/v1/sessions/current');
    session.value = response.data;
    await redirectUnauthorizedAdminRoute();
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      await showSignedOut(false, true);
    } else {
      announce('Não foi possível atualizar seu acesso. Tentaremos novamente.');
    }
  } finally {
    sessionRefreshInFlight = false;
  }
}

/** @param {Record<string, any>} value @param {boolean} [announceLogin] */
async function showSession(value, announceLogin = true) {
  session.value = value;
  phase.value = 'authenticated';
  // LOJ-24: a link opened without a session comes back to its page.
  if (route.path === '/') {
    await router.replace(
      isFinance.value
        ? homePath.value
        : (safeReturnPath(route.query[RETURN_QUERY]) ?? homePath.value),
    );
  }
  await redirectUnauthorizedAdminRoute();
  if (liveTopic.value) stream.start(liveTopic.value);
  else stream.close();
  void refreshStoreCount();
  if (announceLogin) announce('Sessão iniciada com segurança.');
}

async function redirectUnauthorizedAdminRoute() {
  if (phase.value !== 'authenticated' || canAccessCurrentRoute.value) {
    return;
  }
  await router.replace(homePath.value);
  announce('Você não tem acesso a essa área.');
}

/**
 * @param {boolean} [focus]
 * @param {boolean} [keepReturn] LOJ-24: keep the page asked for, so the
 *   login goes back to it; an explicit logout does not.
 */
async function showSignedOut(focus = true, keepReturn = false) {
  session.value = null;
  phase.value = 'signed-out';
  storeNewCount.value = 0;
  stream.close();
  activeView.value?.dispose();
  activeView.value = null;
  await router.isReady();
  if (route.path !== '/') {
    const back = keepReturn ? safeReturnPath(route.fullPath) : null;
    await router.replace(
      back ? { path: '/', query: { [RETURN_QUERY]: back } } : '/',
    );
  }
  clearError();
  if (focus) {
    await nextTick();
    authPanel.value?.focusHeading();
  }
}

async function logout() {
  logoutBusy.value = true;
  let serverConfirmed = true;
  try {
    await request('/api/v1/sessions/current', { method: 'DELETE' });
  } catch {
    serverConfirmed = false;
  } finally {
    logoutBusy.value = false;
    await showSignedOut();
    announce(
      serverConfirmed
        ? 'Sessão encerrada.'
        : 'Acesso local encerrado. A confirmação do servidor falhou.',
    );
  }
}

/** @param {KeyboardEvent} event */
function dismissSidebarTip(event) {
  const visible = Array.from(
    document.querySelectorAll('.app-sidebar .sidebar-tooltip'),
  ).some((element) => element.getClientRects().length > 0);
  if (!visible) return;
  sidebarTipsDismissed.value = true;
  // Dismiss only the visible tip; do not also discard the reply's media.
  event.preventDefault();
  event.stopPropagation();
}

/** @param {KeyboardEvent} event */
function handleShellKey(event) {
  if (event.key !== 'Escape' || !moreOpen.value) return;
  moreOpen.value = false;
  document.querySelector('#more-toggle')?.focus();
}

/** @param {string} message */
function announce(message) {
  if (message === lastAnnouncement) return;
  lastAnnouncement = message;
  runtimeStatus.value = '';
  globalThis.setTimeout(() => {
    runtimeStatus.value = message;
  }, 20);
}

/** @param {string} message @param {boolean} [focus] */
async function showError(message, focus = true) {
  errorMessage.value = message;
  if (!message || !focus) return;
  await nextTick();
  errorSummary.value?.focus();
}

function clearError() {
  errorMessage.value = '';
}

/** @param {string} cursor */
function onCursor(cursor) {
  if (cursor && !stream.cursor) stream.cursor = cursor;
}
</script>

<template>
  <a class="skip-link" href="#main-content">Pular para o conteúdo</a>

  <div v-if="phase !== 'authenticated'" class="public-shell">
    <header class="site-header">
      <a class="brand" href="/" :aria-label="`${brand.productName}, início`">
        <BrandMark class="brand-logo" />
        <span class="product-label">CRM</span>
      </a>
      <p class="environment">
        <span class="environment-dot" aria-hidden="true"></span> Ambiente seguro
      </p>
    </header>
    <main id="main-content" class="public-content" tabindex="-1">
      <div class="intro">
        <h1>{{ brand.productName }}</h1>
        <p>{{ brand.tagline }}</p>
      </div>
      <p v-if="phase === 'restoring'" class="loading-state" role="status">
        Verificando sua sessão…
      </p>
      <section
        v-else-if="phase === 'unavailable'"
        class="surface unavailable-state"
        aria-labelledby="unavailable-title"
      >
        <h2 id="unavailable-title">Não foi possível verificar sua sessão</h2>
        <p>
          Seus dados não foram enviados. Confira a conexão e tente novamente.
        </p>
        <button class="primary" type="button" @click="restoreSession">
          Tentar novamente
        </button>
      </section>
      <AuthPanel
        v-else
        ref="authPanel"
        @authenticated="showSession"
        @error="showError"
      />
    </main>
  </div>

  <div
    v-else
    class="app-shell"
    :data-sidebar="sidebarCompact ? 'compact' : 'expanded'"
    @keydown.esc.capture="dismissSidebarTip"
    @keydown="handleShellKey"
  >
    <aside
      class="app-sidebar"
      :data-tips-dismissed="sidebarTipsDismissed"
      @focusin="sidebarTipsDismissed = false"
      @pointerover="sidebarTipsDismissed = false"
    >
      <RouterLink
        class="brand app-brand"
        :to="homePath"
        :aria-label="`${brand.productName}, ${isFinance ? 'Financeiro' : 'Dashboard'}`"
      >
        <BrandMark class="brand-logo" />
        <BrandMark class="brand-monogram" variant="monogram" />
        <span class="product-label brand-label">CRM</span>
      </RouterLink>
      <button
        class="quiet sidebar-toggle"
        type="button"
        :aria-expanded="!sidebarCompact"
        aria-controls="main-navigation"
        :title="sidebarCompact ? 'Expandir menu' : 'Recolher menu'"
        @click="toggleSidebar"
      >
        <AppIcon name="menu" />
        <span class="nav-label">{{
          sidebarCompact ? 'Expandir menu' : 'Recolher menu'
        }}</span>
        <span
          class="sidebar-tooltip"
          data-label="Expandir menu"
          aria-hidden="true"
        ></span>
      </button>
      <nav id="main-navigation" aria-label="Navegação principal">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          v-slot="{ href, navigate }"
          :to="item.to"
          custom
        >
          <a
            :href="href"
            :aria-current="sectionCurrent(item.to)"
            :title="item.label"
            @click="navigate"
          >
            <AppIcon :name="item.icon" />
            <span class="nav-label">{{ item.label }}</span>
            <span
              class="sidebar-tooltip"
              :data-label="item.label"
              aria-hidden="true"
            ></span>
            <span v-if="item.count?.value > 0" class="nav-count"
              >{{ item.count.value
              }}<span class="sr-only">{{ storeCountLabel }}</span></span
            >
          </a>
        </RouterLink>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-account">
          <span class="sidebar-account-avatar" aria-hidden="true">{{
            sidebarUserInitials
          }}</span>
          <span class="sidebar-account-copy">
            <strong class="sidebar-account-name" :title="sidebarUserName">{{
              sidebarUserName
            }}</strong>
            <span v-if="sidebarUserEmail" :title="sidebarUserEmail">{{
              sidebarUserEmail
            }}</span>
          </span>
        </div>
        <button
          class="quiet sidebar-logout"
          type="button"
          :disabled="logoutBusy"
          :title="logoutBusy ? 'Saindo…' : 'Sair'"
          @click="logout"
        >
          <AppIcon name="logout" />
          <span class="nav-label">{{ logoutBusy ? 'Saindo…' : 'Sair' }}</span>
          <span
            class="sidebar-tooltip"
            data-label="Sair"
            aria-hidden="true"
          ></span>
        </button>
      </div>
    </aside>
    <div class="app-frame">
      <header class="app-topbar">
        <RouterLink
          class="topbar-brand"
          :to="homePath"
          :aria-label="`${brand.productName}, ${isFinance ? 'Financeiro' : 'Dashboard'}`"
        >
          <BrandMark class="topbar-logo" />
        </RouterLink>
        <p class="topbar-trail">
          <span class="topbar-company">{{ brand.companyName }}</span>
          <AppIcon class="topbar-separator" name="chevron" />
          <strong class="topbar-title">{{ pageTitle }}</strong>
        </p>
        <div class="topbar-tools">
          <span class="topbar-role">{{ sessionSummary }}</span>
          <span
            class="connection-state"
            :data-state="isFinance ? 'manual' : connection"
            :data-updated-at="lastUpdatedAt"
            :title="connectionDetail"
            :aria-label="`${connectionLabel}. ${connectionDetail}`"
          >
            {{ connectionLabel }}
            <span class="sr-only">{{ connectionDetail }}</span>
          </span>
          <ThemeSwitcher class="topbar-theme" />
        </div>
      </header>
      <main id="main-content" tabindex="-1">
        <RouterView v-slot="{ Component }">
          <component
            v-if="canAccessCurrentRoute"
            :is="Component"
            :key="route.meta.viewKey ?? route.fullPath"
            :session="session"
            :announce="announce"
            :show-error="showError"
            :on-cursor="onCursor"
            @active-view="activeView = $event"
          />
        </RouterView>
      </main>
      <nav
        class="mobile-nav"
        :data-finance="isFinance || undefined"
        aria-label="Navegação móvel"
      >
        <RouterLink
          v-for="item in mobileTabs"
          :key="item.to"
          v-slot="{ href, navigate }"
          :to="item.to"
          custom
        >
          <a
            class="mobile-tab"
            :href="href"
            :aria-current="sectionCurrent(item.to)"
            :aria-label="tabName(item)"
            @click="navigate"
          >
            <span class="mobile-tab-icon">
              <AppIcon :name="item.icon" />
              <span
                v-if="item.count?.value > 0"
                class="nav-count"
                aria-hidden="true"
                >{{ item.count.value }}</span
              >
            </span>
            <span class="mobile-tab-label">{{ item.short ?? item.label }}</span>
          </a>
        </RouterLink>
        <button
          v-if="mobileMore.length"
          id="more-toggle"
          class="mobile-tab"
          type="button"
          :aria-expanded="moreOpen"
          aria-controls="mobile-more"
          :data-active="moreActive || undefined"
          @click="moreOpen = !moreOpen"
        >
          <span class="mobile-tab-icon"><AppIcon name="more" /></span>
          <span class="mobile-tab-label">Mais</span>
        </button>
      </nav>
      <div
        v-if="moreOpen"
        class="mobile-more-backdrop"
        aria-hidden="true"
        @click="moreOpen = false"
      ></div>
      <section
        id="mobile-more"
        class="mobile-more"
        aria-label="Mais opções"
        :hidden="!moreOpen"
      >
        <template v-if="moreOpen">
          <div class="mobile-more-account">
            <span class="sidebar-account-avatar" aria-hidden="true">{{
              sidebarUserInitials
            }}</span>
            <span class="sidebar-account-copy">
              <strong class="sidebar-account-name">{{
                sidebarUserName
              }}</strong>
              <span>{{ sessionSummary }}</span>
            </span>
          </div>
          <RouterLink
            v-for="item in mobileMore"
            :key="item.to"
            v-slot="{ href, navigate }"
            :to="item.to"
            custom
          >
            <a
              class="mobile-more-link"
              :href="href"
              :aria-current="sectionCurrent(item.to)"
              @click="navigate"
            >
              <AppIcon :name="item.icon" />{{ item.label }}
            </a>
          </RouterLink>
          <div class="mobile-more-theme">
            <span>Aparência</span>
            <ThemeSwitcher />
          </div>
          <button
            class="quiet mobile-logout"
            type="button"
            :disabled="logoutBusy"
            @click="logout"
          >
            <AppIcon name="logout" />
            {{ logoutBusy ? 'Saindo…' : 'Sair' }}
          </button>
        </template>
      </section>
    </div>
  </div>

  <p class="sr-only" role="status" aria-live="polite">{{ runtimeStatus }}</p>
  <AppToast ref="toast" />
  <div
    v-if="errorMessage"
    ref="errorSummary"
    class="error toast"
    role="alert"
    tabindex="-1"
  >
    {{ errorMessage }}
  </div>
</template>
