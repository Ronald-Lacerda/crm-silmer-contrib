import { h } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { performanceTitle } from './lib/assistant-performance.js';
import AccountView from './views/AccountView.vue';
import AssistantPerformanceView from './views/AssistantPerformanceView.vue';
import ClientsView from './views/ClientsView.vue';
import DashboardView from './views/DashboardView.vue';
import FinanceView from './views/FinanceView.vue';
import InboxView from './views/InboxView.vue';
import OrdersView from './views/OrdersView.vue';
import OrderView from './views/OrderView.vue';
import UsersView from './views/UsersView.vue';

const PublicRoute = { name: 'PublicRoute', render: () => h('span') };

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PublicRoute, meta: { title: 'Acesso' } },
    {
      path: '/dashboard',
      component: DashboardView,
      meta: { title: 'Dashboard' },
    },
    {
      // AGENTE-OBS-01: opened from the agent's card, the manager's question.
      path: '/dashboard/agente',
      component: AssistantPerformanceView,
      meta: { requiresAdmin: true, title: performanceTitle() },
    },
    {
      // Deep link to one conversation (Pedido, Clientes and Dashboard open it
      // directly). `viewKey` keeps one InboxView alive while the reader moves
      // between conversations, so the list, filters and search survive.
      path: '/inbox/:conversationId?',
      component: InboxView,
      props: (route) => ({
        conversationId: String(route.params.conversationId ?? ''),
      }),
      meta: { title: 'Caixa de Entrada', viewKey: 'inbox' },
    },
    {
      path: '/handoffs',
      redirect: '/inbox',
    },
    {
      path: '/pedidos',
      component: OrdersView,
      meta: { title: 'Pedidos' },
    },
    {
      // PGE-01: two ways in — the list and the conversation drawer. The
      // drawer passes the conversation it came from so the trail can name it.
      path: '/pedidos/:orderId',
      component: OrderView,
      props: (route) => ({
        fromConversationId: String(route.query.conversa ?? ''),
        orderId: String(route.params.orderId ?? ''),
      }),
      meta: { title: 'Pedido' },
    },
    {
      path: '/clientes/:clientId?',
      component: ClientsView,
      props: (route) => ({ selectedId: String(route.params.clientId ?? '') }),
      meta: { title: 'Clientes' },
    },
    {
      path: '/financeiro',
      component: FinanceView,
      meta: { requiresFinance: true, title: 'Financeiro' },
    },
    {
      path: '/usuarios',
      component: UsersView,
      meta: { requiresAdmin: true, title: 'Usuários' },
    },
    { path: '/conta', component: AccountView, meta: { title: 'Conta' } },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
});
