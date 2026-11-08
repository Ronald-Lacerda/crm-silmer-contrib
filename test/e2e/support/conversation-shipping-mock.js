import { withBucket } from './inbox-bucket.js';
import { pendingOrder } from './orders-mock.js';

export const shippingInput = {
  fromPostalCode: '01001-000',
  toPostalCode: '20040-020',
  weightGrams: 1250,
  widthCm: 20,
  heightCm: 12,
  lengthCm: 30,
  insuranceValueCents: 15025,
};

export const shippingQuote = {
  id: 'shipping-quote-1',
  conversationId: 'shipping-conversation-1',
  subjectId: 'shipping-subject-1',
  orderId: 'shipping-order-1',
  orderVersion: 2,
  input: shippingInput,
  services: [
    {
      id: 1,
      name: 'PAC',
      company: 'Correios',
      priceCents: 2350,
      deliveryDays: 5,
    },
    {
      id: 2,
      name: 'SEDEX',
      company: 'Correios',
      priceCents: 3250,
      deliveryDays: 2,
    },
  ],
  unavailable: [],
  selectedServiceId: null,
  createdAt: '2026-11-02T15:00:00.000Z',
  createdBy: { id: 'shipping-seller', name: 'Vendedora sintética' },
  totalPieces: 150,
  stale: false,
};

/**
 * T139: synthetic conversations, explicit subjects/orders and a provider result.
 * Unknown writes are recorded so an estimate can never silently send or confirm.
 * @param {import('@playwright/test').Page} page
 * @param {{owner?:string|null,assistant?:boolean,multiple?:boolean,quoteError?:boolean,empty?:boolean,saved?:any,delay?:Promise<void>,message?:string}} [options]
 */
export async function mockConversationShipping(page, options = {}) {
  const owner = options.owner === undefined ? 'shipping-seller' : options.owner;
  const orders = [1, 2].map((number) => ({
    ...pendingOrder,
    id: `shipping-order-${number}`,
    number: `0${number}-CRM`,
    conversationId: `shipping-conversation-${number}`,
    seller: { id: owner ?? 'shipping-seller', name: 'Vendedora sintética' },
  }));
  const conversations = [1, 2].map((number) => ({
    id: `shipping-conversation-${number}`,
    version: 4,
    channel: 'whatsapp',
    state: 'em_atendimento',
    automationState: options.assistant ? 'assistant' : 'human',
    automationEpoch: 2,
    assignedUser: owner ? { id: owner, functionName: 'Vendedor' } : null,
    handoff: null,
    terminalAt: null,
    openedAt: '2026-11-02T14:00:00.000Z',
    contact: {
      id: `shipping-contact-${number}`,
      label: `Cliente sintético ${number}`,
      externalId: '5500000000000',
    },
    order: {
      id: orders[number - 1].id,
      number: orders[number - 1].number,
      status: 'pendente',
    },
    lastMessage: {
      id: `shipping-message-${number}`,
      type: 'text',
      direction: 'inbound',
      preview: options.message ?? 'Quanto fica o frete para 20040-020?',
      text: options.message ?? 'Quanto fica o frete para 20040-020?',
      occurredAt: '2026-11-02T14:30:00.000Z',
      status: 'received',
      authorKind: 'contact',
    },
    requiresAttention: false,
  }));
  /** @type {Array<{path:string,method:string,body:any,csrf?:string,key?:string}>} */
  const calls = [];
  /** @type {any} */ let saved = options.saved ?? null;
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'shipping-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({ status, json: body });
    if (path === '/api/v1/sessions/current')
      return json({
        user: {
          id: 'shipping-seller',
          name: 'Vendedora sintética',
          functionName: 'Vendedor',
          capabilities: [],
        },
      });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n: connected\n\n',
      });
    if (path === '/api/v1/users/assignable')
      return json({ users: [{ id: owner, name: 'Vendedora sintética' }] });
    if (path === '/api/v1/inbox/conversations')
      return json({
        items: withBucket(conversations, request.url()),
        totalCount: 2,
        nextCursor: null,
      });
    const subject =
      /^\/api\/v1\/inbox\/conversations\/shipping-conversation-(\d)\/subjects$/u.exec(
        path,
      );
    if (subject && method === 'GET') {
      const number = Number(subject[1]);
      const subjects = [
        {
          id: `shipping-subject-${number}`,
          kind: 'order',
          orderId: orders[number - 1].id,
          orderNumber: orders[number - 1].number,
          orderStatus: 'pendente',
          position: 1,
          isCurrent: true,
          selectedSource: 'human',
          version: 1,
        },
      ];
      if (options.multiple)
        subjects.push({
          ...subjects[0],
          id: 'shipping-subject-other',
          orderId: 'shipping-order-2',
          orderNumber: '02-CRM',
          position: 2,
          isCurrent: false,
        });
      return json({
        currentSubjectId: subjects[0].id,
        subjects,
        orders: orders.map(({ id, number, status }) => ({
          id,
          number,
          status,
        })),
        links: [],
        needsSubjectMessageIds: [],
        ordersHasMore: false,
      });
    }
    const detail =
      /^\/api\/v1\/inbox\/conversations\/shipping-conversation-(\d)$/u.exec(
        path,
      );
    if (detail) {
      const conversation = conversations[Number(detail[1]) - 1];
      return json({
        conversation,
        messages: [conversation.lastMessage],
        suggestion: null,
      });
    }
    const order = /^\/api\/v1\/orders\/shipping-order-(\d)$/u.exec(path);
    if (order && method === 'GET')
      return json({ order: orders[Number(order[1]) - 1] });
    if (
      /^\/api\/v1\/conversations\/shipping-conversation-\d\/order$/u.test(path)
    )
      return json({ order: orders[0] });
    if (
      /^\/api\/v1\/orders\/shipping-order-\d\/shipping-quote$/u.test(path) &&
      method === 'GET'
    )
      return json({ quote: saved });
    if (method !== 'GET')
      calls.push({
        path,
        method,
        body: request.postDataJSON(),
        csrf: request.headers()['x-csrf-token'],
        key: request.headers()['idempotency-key'],
      });
    if (
      /^\/api\/v1\/conversations\/shipping-conversation-\d\/shipping-quotes$/u.test(
        path,
      )
    ) {
      await options.delay;
      if (options.quoteError)
        return json({ code: 'MELHOR_ENVIO_UNAVAILABLE' }, 503);
      const body = request.postDataJSON();
      return json({
        quote: {
          ...shippingQuote,
          conversationId: path.split('/')[4],
          subjectId: body.subjectId,
          orderId: body.orderId,
          orderVersion: body.orderVersion,
          services: options.empty ? [] : shippingQuote.services,
        },
      });
    }
    if (/\/shipping-quotes\/shipping-quote-1\/select$/u.test(path)) {
      const body = request.postDataJSON();
      saved = { ...shippingQuote, selectedServiceId: body.serviceId };
      return json({ quote: saved });
    }
    return json({}, 404);
  });
  return { calls, orders, conversations, saved: () => saved };
}
