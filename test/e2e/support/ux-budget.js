import { expect } from '@playwright/test';
import { withBucket } from './inbox-bucket.js';

// T132 (RFC 024, ADR 036, design.md §16): conta os controles visíveis de uma
// região para travar o orçamento de ações das jornadas. Controle é botão,
// link, campo, seleção ou `summary`; visível é ter caixa, sem `hidden`,
// `display: none` nem `visibility: hidden` e fora de um `dialog` fechado. A
// navegação do app (barra lateral, barra inferior, topo) e o link de pular
// conteúdo ficam fora de `#main-content`, então nunca entram na contagem.
// Dados sintéticos; nenhuma PII.

const CONTROLS = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
].join(', ');

/** O conteúdo da página, sem a navegação global nem os diálogos. */
export const MAIN = '#main-content';

/** Os diálogos abertos, cada um uma região própria. */
const DIALOGS = 'dialog[open], [role="dialog"]';

/**
 * @typedef {object} Measure
 * @property {string} selector  CSS das raízes da região (uma ou mais).
 * @property {string} [exclude] CSS do que não conta (dentro da região).
 * @property {boolean} [firstScreen] só o que cruza a janela visível.
 * @property {boolean} [outsideDialogs] ignora o que está em diálogos (a
 *   página atrás de um modal é outra região).
 * @property {string} [within] restringe a controles que casam este CSS
 *   (por exemplo, `.primary`).
 */

/**
 * Lista os controles visíveis de uma região, com o nome acessível
 * aproximado de cada um, para a mensagem de falha dizer o que foi
 * acrescentado.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Measure} measure
 * @returns {Promise<string[]>}
 */
export function listControls(page, measure) {
  return page.evaluate(
    ({ controls, dialogs, measure: options }) => {
      const doc = globalThis.document;
      const view = {
        height: globalThis.innerHeight,
        width: globalThis.innerWidth,
      };
      /** @param {Element} element */
      const text = (element) =>
        (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
      /** @param {Element} element */
      const nameOf = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const label = labelledBy
            .split(/\s+/u)
            .map((id) => {
              const target = doc.getElementById(id);
              return target ? text(target) : '';
            })
            .join(' ')
            .trim();
          if (label) return label;
        }
        const aria = element.getAttribute('aria-label');
        if (aria) return aria.trim();
        const labels = /** @type {HTMLInputElement} */ (element).labels;
        if (labels?.length) {
          return [...labels].map(text).join(' ').trim();
        }
        return (
          text(element) ||
          element.getAttribute('title') ||
          element.getAttribute('placeholder') ||
          ''
        );
      };
      /** @param {Element} element */
      const kindOf = (element) => {
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role');
        if (role) return role;
        if (tag === 'a') return 'link';
        if (tag === 'input') {
          return `input[${element.getAttribute('type') ?? 'text'}]`;
        }
        return tag;
      };
      /** @param {Element} element */
      const visible = (element) => {
        if (element.closest('[hidden], dialog:not([open])')) return false;
        if (
          !element.checkVisibility({
            contentVisibilityAuto: true,
            opacityProperty: false,
            visibilityProperty: true,
          })
        ) {
          return false;
        }
        const box = element.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return false;
        if (!options.firstScreen) return true;
        return (
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < view.height &&
          box.left < view.width
        );
      };
      /** @type {Set<Element>} */
      const found = new Set();
      for (const root of doc.querySelectorAll(options.selector)) {
        const candidates = root.matches(controls)
          ? [root, ...root.querySelectorAll(controls)]
          : [...root.querySelectorAll(controls)];
        for (const element of candidates) {
          if (options.within && !element.matches(options.within)) continue;
          if (options.exclude && element.closest(options.exclude)) continue;
          if (options.outsideDialogs && element.closest(dialogs)) continue;
          if (visible(element)) found.add(element);
        }
      }
      return [...found].map(
        (element) => `${kindOf(element)} "${nameOf(element)}"`,
      );
    },
    { controls: CONTROLS, dialogs: DIALOGS, measure },
  );
}

/**
 * Falha quando a região passa do orçamento, listando os controles contados.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} label nome da região para a mensagem.
 * @param {Measure} measure
 * @param {number} budget máximo de controles visíveis.
 * @returns {Promise<string[]>} os controles contados, para outros asserts.
 */
export async function expectBudget(page, label, measure, budget) {
  const controls = await listControls(page, measure);
  expect(
    controls.length,
    `${label}: ${controls.length} controles visíveis para um orçamento de ${budget}:\n  - ${controls.join('\n  - ')}`,
  ).toBeLessThanOrEqual(budget);
  return controls;
}

/**
 * Regra geral (design.md §16): nenhuma região — a página fora dos diálogos e
 * cada diálogo aberto — tem mais de uma ação primária visível. Devolve o
 * número de primárias de cada região, para quem quiser exigir exatamente uma.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, string[]>>}
 */
export async function expectOnePrimaryPerRegion(page) {
  const regions = await page.evaluate((dialogs) => {
    /** @type {string[]} */
    const selectors = ['main'];
    globalThis.document.querySelectorAll(dialogs).forEach((element, index) => {
      element.setAttribute('data-ux-budget-region', String(index));
      selectors.push(`[data-ux-budget-region="${index}"]`);
    });
    return selectors;
  }, DIALOGS);
  /** @type {Record<string, string[]>} */
  const primaries = {};
  for (const selector of regions) {
    const isMain = selector === 'main';
    const found = await listControls(page, {
      outsideDialogs: isMain,
      selector,
      within: '.primary',
    });
    // Um diálogo fechado ou vazio não é região na tela.
    if (!isMain && !found.length) continue;
    primaries[selector] = found;
    expect(
      found.length,
      `Região ${selector}: ${found.length} ações primárias visíveis, o máximo é 1:\n  - ${found.join('\n  - ')}`,
    ).toBeLessThanOrEqual(1);
  }
  return primaries;
}

/** Os dois tamanhos das metas do RFC 024. */
export const PHONE = { height: 844, width: 390 };
export const NOTEBOOK = { height: 768, width: 1366 };

const SELLER = { functionName: 'Vendedor', id: 'seller-budget' };

/**
 * Uma conversa sintética por estado da jornada: aguardando vendedor
 * (handoff), com o agente, com o vendedor dono e com o vendedor dono e um
 * pedido pendente. Nomes e telefone são fictícios.
 *
 * @param {'handoff'|'agent'|'owner'|'owner-order'} state
 * @param {number} index
 */
function inboxConversation(state, index) {
  const id = `conversation-${state}`;
  const human = state === 'owner' || state === 'owner-order';
  const occurredAt = `2026-10-15T1${index}:00:00.000Z`;
  return {
    archivedAt: null,
    assignedUser: human ? SELLER : null,
    automationEpoch: 2,
    automationState: state === 'agent' ? 'assistant' : 'human',
    channel: 'whatsapp',
    contact: {
      displayHandle: `Cliente Sintético ${index + 1}`,
      externalId: `550000000000${index}`,
      id: `contact-${state}`,
      label: `Cliente Sintético ${index + 1}`,
    },
    handoff:
      state === 'handoff'
        ? {
            createdAt: '2026-10-15T14:00:00.000Z',
            dueAt: '2026-10-15T16:00:00.000Z',
            id: `handoff-${state}`,
            reasonCode: 'customer_requested_human',
            status: 'pending',
            targetRole: 'Vendedor',
            version: 1,
          }
        : null,
    id,
    lastMessage: {
      authorId: `contact-${state}`,
      authorKind: 'contact',
      deliveryStatus: null,
      direction: 'inbound',
      id: `message-${state}`,
      occurredAt,
      preview: 'Mensagem sintética de teste.',
      status: 'received',
      type: 'text',
    },
    openedAt: occurredAt,
    order:
      state === 'owner-order'
        ? { id: 'order-budget', number: '21-CRM', status: 'pendente' }
        : null,
    requiresAttention: state === 'handoff',
    state: state === 'handoff' ? 'requer_atencao' : 'em_atendimento',
    terminalAt: null,
    updatedAt: occurredAt,
    version: 3,
  };
}

/**
 * Mock mínimo da Caixa de Entrada (lista, conversa e mensagens) com a sessão
 * de um vendedor sem capacidade de administrador.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function mockInbox(page) {
  const conversations = /** @type {const} */ ([
    'owner',
    'handoff',
    'agent',
    'owner-order',
  ]).map((state, index) => inboxConversation(state, index));
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        body: JSON.stringify(body),
        contentType: 'application/json',
        status,
      });
    if (path === '/api/v1/sessions/current') {
      return json({ user: { ...SELLER, capabilities: [], name: 'Vendedora' } });
    }
    if (path === '/api/v1/events') {
      return route.fulfill({
        body: 'retry: 60000\n\n: connected\n\n',
        contentType: 'text/event-stream',
      });
    }
    if (path === '/api/v1/inbox/conversations') {
      return json({
        items: withBucket(conversations, route.request().url()),
        nextCursor: null,
        totalCount: conversations.length,
      });
    }
    if (/^\/api\/v1\/inbox\/conversations\/[^/]+\/subjects$/u.test(path)) {
      return json({
        currentSubjectId: null,
        links: [],
        orders: [],
        ordersHasMore: false,
        subjects: [],
      });
    }
    const detail = /^\/api\/v1\/inbox\/conversations\/([^/]+)$/u.exec(path);
    if (detail) {
      const conversation = conversations.find((item) => item.id === detail[1]);
      if (!conversation) return json({}, 404);
      return json({
        conversation,
        messages: [conversation.lastMessage],
        suggestion: null,
      });
    }
    if (/^\/api\/v1\/conversations\/[^/]+\/order$/u.test(path)) {
      return json({ order: null });
    }
    if (path === '/api/v1/users/assignable') return json({ items: [] });
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
}
