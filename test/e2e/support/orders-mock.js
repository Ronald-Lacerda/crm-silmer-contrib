import { expect } from '@playwright/test';

// Mock da API de Pedidos para os testes de ponta a ponta, com dados
// sintéticos. Uso: `await mockOrders(page, { orders: [pendingOrder] })`
// antes de `page.goto(...)`; as fixtures exportadas servem de base para
// variações com spread. Compartilhado pela lista (orders-list.spec.js) e
// pela página do pedido (orders.spec.js).

const session = {
  user: {
    capabilities: [],
    email: 'marina@example.test',
    functionName: 'Vendedor',
    id: 'seller-marina',
    name: 'Marina Aguiar',
  },
};

export const confirmedOrder = {
  confirmedAt: '2026-09-09T19:20:00.000Z',
  confirmedBy: { id: 'seller-ricardo', name: 'Ricardo Lima' },
  conversationId: 'conversation-5',
  createdAt: '2026-09-08T12:00:00.000Z',
  fabCode: 'FAB 01',
  ficha: {
    artwork: {
      feito_pelo_cliente: false,
      feito_pela_silmer: true,
      files: [],
      sem_estampa: false,
    },
    items: [
      {
        cor: 'BRANCA',
        cor_costas: 'BRANCA',
        cor_frente: 'BRANCA',
        cor_manga_direita: 'VERDE BANDEIRA',
        cor_manga_esquerda: 'VERDE BANDEIRA',
        estampa: 'Sem estampa',
        gola: 'GOLA V',
        grade: [{ quantidade: 60, tamanho: 'M' }],
        malhas: ['DRY FIT 100% POLIÉSTER'],
        modelo: 'GOLA OLÍMPICA',
        tipo: 'AVENTAL',
        vies_gola: 'VERDE',
        vies_mangas: 'VERDE',
      },
    ],
    observations: [],
    serviceData: {},
    summary: {
      aplicacao: 'SUBLIMAÇÃO TOTAL',
      cliente: 'Buffet Casa Rosa',
      data_entrega_confirmada: '2026-10-24',
      nome: 'Aventais e camisetas',
    },
  },
  deliveredOn: null,
  finalAmountCents: 118000,
  firstContactAt: '2026-09-02T14:12:00.000Z',
  id: 'order-confirmado',
  missingFields: [],
  number: '05-CRM',
  orderDate: '2026-09-09',
  paidOn: '2026-09-10',
  paymentCondition: 'pix',
  reopenedAt: null,
  reopenedBy: null,
  seller: { id: 'seller-ricardo', name: 'Ricardo Lima' },
  status: 'confirmado',
  totalPieces: 60,
  updatedAt: '2026-09-09T19:20:00.000Z',
  version: 4,
};

export const pendingOrder = {
  confirmedAt: null,
  confirmedBy: null,
  conversationId: 'conversation-7',
  createdAt: '2026-09-12T09:00:00.000Z',
  deliveredOn: null,
  fabCode: 'FAB 01',
  ficha: {
    artwork: {
      feito_pelo_cliente: true,
      feito_pela_silmer: false,
      files: [],
      sem_estampa: false,
    },
    items: [
      {
        cor: 'BRANCA',
        cor_costas: 'BRANCA',
        cor_frente: 'BRANCA',
        cor_manga_direita: 'VERDE BANDEIRA',
        cor_manga_esquerda: 'VERDE BANDEIRA',
        estampa: 'Logo · frente',
        gola: 'GOLA REDONDA',
        grade: [
          { quantidade: 100, tamanho: 'M' },
          { quantidade: 50, tamanho: 'G' },
        ],
        malhas: ['DRY FIT 100% POLIÉSTER'],
        modelo: 'GOLA OLÍMPICA',
        tipo: 'CAMISETA',
        tipo_servico: 'SUBLIMAÇÃO TOTAL',
        vies_gola: 'OLÍMPICA - VERDE',
        vies_mangas: 'VERDE',
      },
    ],
    observations: ['Separar os itens por tamanho.'],
    serviceData: {
      artwork_status: 'Arte recebida do cliente',
      city_or_postal_code: 'Salvador/BA',
      purchase_profile: 'Compra recorrente',
      purpose: 'Uso próprio',
    },
    summary: {
      aplicacao: 'SUBLIMAÇÃO TOTAL',
      cliente: 'Colégio Ápice',
      data_entrega_confirmada: '2026-10-24',
      nome: 'Uniforme escolar 2027',
    },
  },
  finalAmountCents: null,
  firstContactAt: '2026-09-11T20:40:00.000Z',
  id: 'order-pendente',
  missingFields: ['finalAmount', 'paymentCondition'],
  number: '07-CRM',
  orderDate: null,
  paidOn: null,
  paymentCondition: null,
  reopenedAt: null,
  reopenedBy: null,
  seller: { id: 'seller-marina', name: 'Marina Aguiar' },
  status: 'pendente',
  totalPieces: 150,
  updatedAt: '2026-09-12T09:46:00.000Z',
  version: 2,
};

// The same confirmed order, owned by the signed-in seller: only the owner (or
// an admin) sees the edit buttons.
export const ownConfirmedOrder = {
  ...confirmedOrder,
  seller: { id: session.user.id, name: session.user.name },
};

export const extraPending = {
  ...pendingOrder,
  conversationId: 'conversation-9',
  id: 'order-pendente-2',
  ficha: {
    ...pendingOrder.ficha,
    summary: { ...pendingOrder.ficha.summary, cliente: 'Loja Vitória Sports' },
  },
  missingFields: ['items[0].gola', 'finalAmount', 'paymentCondition'],
  number: '09-CRM',
  totalPieces: 45,
};

/**
 * The server recomputes totals and what is missing on every write; the mock
 * does the same, so the page is never asserted against a stale derived field.
 *
 * @param {any} order @param {string} section @param {any} value
 */
function applySection(order, section, value) {
  const ficha = { ...order.ficha };
  if (section === 'summary') {
    ficha.summary = { ...ficha.summary, ...value };
  } else if (section === 'items') {
    ficha.items = value;
  } else if (section === 'artwork') {
    ficha.artwork = { ...ficha.artwork, ...value };
  } else {
    ficha.observations = value;
  }
  const totalPieces = ficha.items.reduce(
    /** @param {number} total @param {any} item */
    (total, item) =>
      total +
      item.grade.reduce(
        /** @param {number} sum @param {any} line */
        (sum, line) => sum + line.quantidade,
        0,
      ),
    0,
  );
  return {
    ficha,
    missingFields: missingFor({ ...order, ficha }),
    totalPieces,
    updatedAt: new Date().toISOString(),
    version: order.version + 1,
  };
}

/** @param {any} order @param {string} action @param {any} body */
function applyCommand(order, action, body) {
  // OLIST-T13 (ADR 068): terminal local cancellation; the commercial status
  // stays and the effective one reads Cancelado.
  if (action === 'cancel') {
    return {
      cancelledAt: '2026-11-08T15:30:00.000Z',
      cancelledBy: { id: session.user.id, name: session.user.name },
      cancellationReason: body.reason,
      effectiveStatus: 'cancelado',
      version: order.version + 1,
    };
  }
  if (action === 'reopen') {
    const reopened = {
      ...order,
      reopenedAt: '2026-09-13T12:00:00.000Z',
      reopenedBy: { id: session.user.id, name: session.user.name },
      status: 'pendente',
      version: order.version + 1,
    };
    return { ...reopened, missingFields: missingFor(reopened) };
  }
  return {
    confirmedAt: '2026-09-13T12:00:00.000Z',
    confirmedBy: { id: session.user.id, name: session.user.name },
    finalAmountCents: brlToCents(body.amountText),
    missingFields: [],
    orderDate: '2026-09-13',
    paymentCondition: body.paymentCondition,
    status: 'confirmado',
    version: order.version + 1,
  };
}

/** @param {string} text */
function brlToCents(text) {
  const [reais, cents = '00'] = String(text).split(',');
  return Number(reais.replaceAll('.', '')) * 100 + Number(cents.padEnd(2, '0'));
}

// ADR 016/020: the seven points of every item, who makes the art, the
// promised delivery, the amount and the payment method — the same rule and
// order the server applies.
const ITEM_POINTS = ['tipo', 'cor', 'tipo_servico', 'malhas', 'grade', 'gola'];
const ART_ORIGINS = ['feito_pelo_cliente', 'feito_pela_silmer', 'sem_estampa'];

/** @param {any} order */
function missingFor(order) {
  if (order.status === 'confirmado') return [];
  /** @type {string[]} */
  const missing = [];
  if (order.ficha.items.length === 0) missing.push('items');
  order.ficha.items.forEach(
    /** @param {any} item @param {number} index */ (item, index) => {
      for (const key of ITEM_POINTS) {
        const value = item[key];
        const blank = Array.isArray(value)
          ? value.length === 0
          : !String(value ?? '').trim();
        if (blank) missing.push(`items[${index}].${key}`);
      }
    },
  );
  if (!ART_ORIGINS.some((origin) => order.ficha.artwork?.[origin] === true)) {
    missing.push('artwork');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(
      order.ficha.summary.data_entrega_confirmada ?? '',
    )
  ) {
    missing.push('summary.data_entrega_confirmada');
  }
  if (!order.finalAmountCents) missing.push('finalAmount');
  if (!order.paymentCondition) missing.push('paymentCondition');
  return missing;
}

/**
 * One SSE payload delivered on connect, with a long retry so the reconnect
 * does not turn a single event into a refresh loop during the test.
 *
 * @param {Record<string, unknown>|null} event
 */
export function eventStreamBody(event) {
  if (!event) return 'retry: 60000\n\n: connected\n\n';
  return [
    'retry: 60000',
    '',
    `event: ${event.type}`,
    'id: evt-2',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}

let uploadedSequence = 0;
export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** @param {string} name @param {string} slot @param {number} index */
export function syntheticFile(name, slot, index) {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return {
    contentType: 'application/octet-stream',
    extension,
    id: `file-${index}`,
    name,
    sizeBytes: 640 * 1024,
    slot,
    thumbnail: ['png', 'jpg', 'jpeg', 'webp'].includes(extension),
    uploadedAt: '2026-10-05T17:12:00.000Z',
    uploadedBy: { id: 'seller-marina', name: 'Marina Aguiar' },
  };
}

/**
 * The /files routes of ADR 023 over an in-memory store per order.
 *
 * @param {import('@playwright/test').Route} route
 * @param {import('@playwright/test').Request} request
 * @param {RegExpExecArray} match
 * @param {Map<string, {final: any, references: any[]}>} store
 * @param {any} options
 */
async function routeFiles(route, request, match, store, options) {
  const [, orderId, fileId, kind] = match;
  const state = store.get(orderId) ?? { final: null, references: [] };
  store.set(orderId, state);
  const json = (/** @type {number} */ status, /** @type {any} */ body) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  const listing = () => ({
    ...state,
    limits: { maxBytes: 10 * 1024 * 1024, maxReferences: 5 },
  });
  if (request.method() === 'GET' && !fileId) {
    await json(200, listing());
    return;
  }
  if (request.method() === 'GET' && kind) {
    await route.fulfill({
      status: 200,
      contentType: kind === 'thumbnail' ? 'image/png' : 'application/pdf',
      headers: { 'Content-Disposition': 'attachment' },
      body: ONE_PIXEL_PNG,
    });
    return;
  }
  expect(request.headers()['idempotency-key']).toBeTruthy();
  if (request.method() === 'DELETE') {
    options.onRemove?.(fileId);
    if (state.final?.id === fileId) state.final = null;
    state.references = state.references.filter((file) => file.id !== fileId);
    await json(200, listing());
    return;
  }
  const raw = (request.postDataBuffer() ?? Buffer.alloc(0)).toString('latin1');
  const slot = /name="slot"\r\n\r\n([a-z]+)/u.exec(raw)?.[1] ?? '';
  const filename = Buffer.from(
    /name="file"; filename="([^"]+)"/u.exec(raw)?.[1] ?? '',
    'latin1',
  ).toString('utf8');
  const hasThumbnail = raw.includes('name="thumbnail"');
  options.onUpload?.({ filename, hasThumbnail, slot });
  if (options.uploadFailure) {
    await json(options.uploadFailure.status, {
      error: options.uploadFailure.body,
    });
    return;
  }
  if (slot === 'reference' && state.references.length >= 5) {
    await json(409, { error: { code: 'FILE_LIMIT_REACHED' } });
    return;
  }
  const file = {
    ...syntheticFile(filename, slot, (uploadedSequence += 1) + 100),
    thumbnail: hasThumbnail,
  };
  if (slot === 'final') state.final = file;
  else state.references.push(file);
  await json(201, listing());
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{user?: Record<string, unknown>, orders?: any[], failDetailOnce?: boolean, failListOnce?: boolean, liveEvent?: Record<string, unknown>|null, onDetail?: (orderId: string) => void, onList?: (params: URLSearchParams) => void, onWrite?: (call: {section?: string, action?: string, body: any}) => void, pages?: any[][], writeFailure?: {status: number, body: Record<string, unknown>, persist?: Record<string, unknown>}, files?: Record<string, {final: any, references: any[]}>, onUpload?: (call: {filename: string, hasThumbnail: boolean, slot: string}) => void, onRemove?: (fileId: string) => void, uploadFailure?: {status: number, body: Record<string, unknown>}}} [options]
 */
export async function mockOrders(page, options = {}) {
  // A write mutates the order it answers with, so each test gets its own
  // copy: sharing the module fixture would let one test's confirmation
  // decide what the next test in the same worker reads.
  /** @type {any[]} */
  const orders = JSON.parse(
    JSON.stringify(options.orders ?? [confirmedOrder, pendingOrder]),
  );
  const pages = options.pages ?? null;
  /** @type {Map<string, {final: any, references: any[]}>} */
  const fileStore = new Map(
    Object.entries(JSON.parse(JSON.stringify(options.files ?? {}))),
  );
  let listCalls = 0;
  let detailCalls = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (/^\/api\/v1\/orders\/[^/]+\/pdf$/u.test(path)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: '%PDF-1.4\n% synthetic order ficha\n',
      });
      return;
    }

    if (path === '/api/v1/sessions/current') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          options.user
            ? { user: { ...session.user, ...options.user } }
            : session,
        ),
      });
      return;
    }
    if (path === '/api/v1/events') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache' },
        body: eventStreamBody(options.liveEvent ?? null),
      });
      return;
    }
    if (path === '/api/v1/orders' && request.method() === 'GET') {
      options.onList?.(url.searchParams);
      const pageIndex = listCalls;
      listCalls += 1;
      if (options.failListOnce && listCalls === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'UNAVAILABLE' }),
        });
        return;
      }
      const source = pages
        ? (pages[Math.min(pageIndex, pages.length - 1)] ?? [])
        : orders.filter(
            (order) =>
              !url.searchParams.get('status') ||
              order.status === url.searchParams.get('status'),
          );
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          counts: {
            confirmado: orders.filter((o) => o.status === 'confirmado').length,
            pendente: orders.filter((o) => o.status === 'pendente').length,
          },
          items: source,
          nextCursor:
            pages && listCalls < pages.length ? `cursor-${listCalls}` : null,
        }),
      });
      return;
    }
    const section = /^\/api\/v1\/orders\/([^/]+)\/sections\/([^/]+)$/u.exec(
      path,
    );
    if (section && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      options.onWrite?.({ body, section: section[2] });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      if (options.writeFailure) {
        await route.fulfill({
          status: options.writeFailure.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: options.writeFailure.body }),
        });
        return;
      }
      const current = orders.find((candidate) => candidate.id === section[1]);
      const next = applySection(current, section[2], body.value);
      Object.assign(current, next);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ order: current }),
      });
      return;
    }

    const milestones = /^\/api\/v1\/orders\/([^/]+)\/milestones$/u.exec(path);
    if (milestones && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      options.onWrite?.({ action: 'milestones', body });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      if (options.writeFailure) {
        await route.fulfill({
          status: options.writeFailure.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: options.writeFailure.body }),
        });
        return;
      }
      const current = orders.find(
        (candidate) => candidate.id === milestones[1],
      );
      Object.assign(current, {
        ...(Object.hasOwn(body, 'deliveredOn')
          ? { deliveredOn: body.deliveredOn }
          : {}),
        paidOn: body.paidOn,
        version: current.version + 1,
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ order: current }),
      });
      return;
    }

    const command =
      /^\/api\/v1\/orders\/([^/]+)\/(confirm|reopen|cancel)$/u.exec(path);
    if (command && request.method() === 'POST') {
      const body = request.postDataJSON();
      options.onWrite?.({ action: command[2], body });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      if (options.writeFailure) {
        // The persisted state the failure left behind (e.g. a lock that won
        // the race), read again by the page.
        if (options.writeFailure.persist) {
          Object.assign(
            orders.find((candidate) => candidate.id === command[1]),
            options.writeFailure.persist,
          );
        }
        await route.fulfill({
          status: options.writeFailure.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: options.writeFailure.body }),
        });
        return;
      }
      const current = orders.find((candidate) => candidate.id === command[1]);
      Object.assign(current, applyCommand(current, command[2], body));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ order: current }),
      });
      return;
    }

    // ADR 023: the art files of each order, kept per test like the orders.
    const filesRoute =
      /^\/api\/v1\/orders\/([^/]+)\/files(?:\/([^/]+)(?:\/(content|thumbnail))?)?$/u.exec(
        path,
      );
    if (filesRoute) {
      await routeFiles(route, request, filesRoute, fileStore, options);
      return;
    }

    // T139: ordinary order scenarios have no selected freight estimate.
    if (
      /^\/api\/v1\/orders\/[^/]+\/shipping-quote$/u.test(path) &&
      request.method() === 'GET'
    ) {
      await route.fulfill({ json: { quote: null } });
      return;
    }

    const detail = /^\/api\/v1\/orders\/([^/]+)$/u.exec(path);
    if (detail && request.method() === 'GET') {
      options.onDetail?.(detail[1]);
      if (options.failDetailOnce && detailCalls++ === 0) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'UNAVAILABLE' }),
        });
        return;
      }
      const order = orders.find((candidate) => candidate.id === detail[1]);
      if (!order) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'ORDER_NOT_FOUND' } }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ order }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'ORDER_NOT_FOUND' } }),
    });
  });
}
