// @ts-nocheck -- isolated synthetic preview, no provider clients, database or secrets.
export const PREVIEW_CONVERSATION = 'billing-preview';
export const PREVIEW_ORDER = 'billing-preview-order';
export const PREVIEW_USER = {
  id: 'billing-preview-seller',
  name: 'Marina — demonstração',
  functionName: 'Vendedor',
  capabilities: [],
};

export function createBillingPreviewFixtures(onChange = () => {}) {
  let charges = [],
    intents = [],
    messages = [],
    payments = [],
    history = [],
    sequence = 0,
    scenario = 'new';
  const timers = new Set();
  const amount = 120000;
  const stamp = () => new Date().toISOString();
  const money = (value) =>
    new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value / 100);
  const received = () =>
    charges.reduce(
      (sum, charge) => sum + (charge.paid ? charge.amountCents : 0),
      0,
    );
  const balance = () => Math.max(0, amount - received());
  const latest = () => charges.at(-1);
  const latestIntent = () => intents.at(-1) ?? null;
  function record(kind, item, intent = null, fields = {}) {
    history.push({
      id: `preview-event-${history.length + 1}`,
      sequence: history.length + 1,
      kind,
      chargeId: item.id,
      intentId: intent?.id ?? null,
      amountCents: item.amountCents,
      occurredAt: stamp(),
      ...fields,
    });
  }
  function receive(item, method = 'pix', installments = 1) {
    if (
      !['pix', 'credit_card'].includes(method) ||
      !Number.isInteger(installments) ||
      installments < 1 ||
      installments > 12
    )
      refuse('Meio de pagamento simulado inválido.');
    const payment = {
      id: `preview-payment-${payments.length + 1}`,
      chargeId: item.id,
      amountCents: item.amountCents,
      method,
      installments: method === 'credit_card' ? installments : 1,
      paidAt: stamp(),
      transactionNsu: `transacao-demonstracao-${payments.length + 1}`,
    };
    payment.receiptUrl = `/__billing-preview/receipts/${payment.id}`;
    payments.push(payment);
    item.paid = true;
    item.status = 'paid';
    item.paidAt = payment.paidAt;
    record('payment_confirmed', item, null, { paymentId: payment.id });
    return payment;
  }
  const dispose = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  function after(ms, work) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      work();
      onChange();
    }, ms);
    timers.add(timer);
  }
  function charge(value = 36000, kind = 'signal') {
    sequence++;
    const result = {
      id: `preview-charge-${sequence}`,
      number: sequence,
      amountCents: value,
      kind,
      status: 'waiting',
      paid: false,
      expired: false,
      closed: false,
      url: `https://pagamento.exemplo.test/cobranca/${sequence}`,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      createdAt: stamp(),
    };
    charges.push(result);
    record('charge_created', result);
    return result;
  }
  function addMessage(item, state = 'queued') {
    const kind =
      item.kind === 'signal'
        ? 'sinal'
        : item.kind === 'balance'
          ? 'saldo'
          : 'pagamento integral';
    const result = {
      id: `preview-message-${intents.length}`,
      type: 'text',
      direction: 'outbound',
      authorKind: 'human',
      authorId: PREVIEW_USER.id,
      text: `Pedido 24-CRM — ${kind} de ${money(item.amountCents)}. Link para pagamento: ${item.url}`,
      status: state,
      deliveryStatus: state,
      occurredAt: stamp(),
    };
    messages.push(result);
    return result;
  }
  function begin(item, action, waitForLink = true) {
    const intent = {
      id: `preview-intent-${intents.length + 1}`,
      chargeId: item.id,
      action,
      state: waitForLink ? 'waiting_link' : 'queued',
      safeRetry: false,
    };
    intents.push(intent);
    let message;
    const queue = () => {
      if (intent.state === 'blocked') return;
      intent.state = 'queued';
      message = addMessage(item);
      if (waitForLink) record('link_ready', item, intent);
      record('message_queued', item, intent);
    };
    if (waitForLink) after(850, queue);
    else queue();
    after(waitForLink ? 1650 : 800, () => {
      if (intent.state === 'blocked') return;
      intent.state = 'sending';
      message.status = 'sending';
      message.deliveryStatus = 'sending';
      record('message_sending', item, intent);
    });
    after(waitForLink ? 2450 : 1600, () => {
      if (intent.state === 'blocked') return;
      intent.state = 'sent';
      message.status = 'sent';
      message.deliveryStatus = 'sent';
      record('message_sent', item, intent);
    });
    after(waitForLink ? 3250 : 2400, () => {
      if (intent.state === 'blocked') return;
      intent.state = 'delivered';
      message.deliveryStatus = 'delivered';
      record('message_delivered', item, intent);
    });
    return intent;
  }
  function reset(value = 'new') {
    dispose();
    charges = [];
    intents = [];
    messages = [];
    payments = [];
    history = [];
    sequence = 0;
    scenario = value;
    if (value !== 'new') {
      const item = charge();
      record('link_ready', item);
      if (value === 'signal-paid') {
        intents.push({
          id: 'preview-intent-1',
          chargeId: item.id,
          action: 'issue',
          state: 'delivered',
        });
        addMessage(item, 'sent').deliveryStatus = 'delivered';
        record('message_delivered', item, latestIntent());
        receive(item);
      }
      if (value === 'expired') {
        item.expired = true;
        item.closed = true;
        item.status = 'closed';
        item.validUntil = new Date(Date.now() - 3600000).toISOString();
        record('charge_closed', item);
      }
      if (value === 'before-send-failure' || value === 'unknown') {
        const state = value === 'unknown' ? 'unknown' : 'failed';
        intents.push({
          id: 'preview-intent-1',
          chargeId: item.id,
          action: 'send_existing',
          state,
          safeRetry: state === 'failed',
        });
        addMessage(item, state === 'unknown' ? 'outcome_unknown' : 'failed');
      }
    }
    onChange();
    return view();
  }
  function view() {
    return structuredClone({
      order: {
        id: PREVIEW_ORDER,
        number: '24-CRM',
        name: 'Uniformes da equipe',
        totalAmountCents: amount,
        status: 'confirmado',
      },
      conversationId: PREVIEW_CONVERSATION,
      customer: 'Cliente de demonstração',
      scenario,
      charges,
      intents,
      payments,
      history: [...history].reverse(),
      latestIntent: latestIntent(),
      receivedAmountCents: received(),
      balanceAmountCents: balance(),
      messageCount: messages.length,
    });
  }
  function refuse(message) {
    throw Object.assign(new Error(message), { statusCode: 409 });
  }
  function action(name, body = {}) {
    if (name === 'scenario') return reset(body.scenario);
    const previous = latest();
    if (name === 'expire') {
      if (!previous || previous.paid)
        refuse('Escolha uma cobrança sem pagamento.');
      previous.expired = true;
      previous.closed = true;
      previous.status = 'closed';
      previous.validUntil = new Date(Date.now() - 3600000).toISOString();
      record('charge_closed', previous);
    } else if (name === 'pay') {
      if (!previous || previous.paid)
        refuse('Não há cobrança pendente para receber.');
      receive(previous, body.method, body.installments ?? 1);
      const pendingIntent = latestIntent();
      if (['waiting_link', 'queued'].includes(pendingIntent?.state)) {
        pendingIntent.state = 'blocked';
        pendingIntent.blockedReason = 'PAYMENT_CONFIRMED';
        const queuedMessage = messages.at(-1);
        if (queuedMessage && queuedMessage.status === 'queued') {
          queuedMessage.status = 'failed';
          queuedMessage.deliveryStatus = 'failed';
        }
      }
    } else {
      if (balance() === 0) refuse('O pedido está quitado.');
      if (name === 'issue' && received() > 0)
        refuse(
          'Já há recebimento confirmado. Revise a cobrança do saldo restante.',
        );
      if (
        ['waiting_link', 'queued', 'sending', 'unknown'].includes(
          latestIntent()?.state,
        )
      )
        refuse('Aguarde ou confira o resultado da tentativa anterior.');
      if (name === 'send_existing') {
        if (!previous || previous.paid || previous.expired || latestIntent())
          refuse('Este link não está disponível para um primeiro envio.');
        begin(previous, name, false);
      } else if (name === 'retry') {
        if (
          !previous ||
          previous.paid ||
          previous.expired ||
          !latestIntent()?.safeRetry
        )
          refuse('Não há prova de falha anterior ao envio.');
        begin(previous, name, false);
      } else {
        if (name === 'correct') {
          if (
            !previous ||
            previous.paid ||
            !previous.expired ||
            !previous.closed ||
            !body.confirmedAgreement ||
            !body.confirmedProviderReview
          )
            refuse(
              'A correção exige link vencido, encerrado sem pagamento e conferência explícita.',
            );
        } else if (previous && !previous.paid && !previous.closed)
          refuse('Já existe uma cobrança ativa.');
        if (name === 'balance' && !received())
          refuse('O saldo só pode ser cobrado após um recebimento.');
        const value =
          name === 'balance'
            ? balance()
            : name === 'correct'
              ? Number(body.amountCents)
              : Math.round((amount * Number(body.percent)) / 100);
        if (
          !Number.isSafeInteger(value) ||
          value < 100 ||
          value > balance() ||
          (balance() - value > 0 && balance() - value < 100)
        )
          refuse(
            'Informe um valor válido de pelo menos R$ 1,00, limitado ao saldo.',
          );
        const item = charge(
          value,
          name === 'balance' ? 'balance' : value === amount ? 'full' : 'signal',
        );
        if (name === 'correct') {
          item.supersedesChargeId = previous.id;
          record('charge_corrected', item, null, {
            supersedesChargeId: previous.id,
          });
        }
        begin(item, name);
      }
    }
    onChange();
    return view();
  }
  function conversation() {
    const recent = messages.at(-1) ?? {
      id: 'preview-inbound-2',
      type: 'text',
      direction: 'inbound',
      authorKind: 'contact',
      text: 'Combinado! Pode me enviar o link do sinal de 30%.',
      preview: 'Pode me enviar o link do sinal de 30%.',
      status: 'received',
      occurredAt: stamp(),
    };
    return {
      id: PREVIEW_CONVERSATION,
      version: 4,
      channel: 'whatsapp',
      state: 'em_atendimento',
      automationState: 'human',
      automationEpoch: 2,
      assignedUser: PREVIEW_USER,
      handoff: null,
      terminalAt: null,
      archivedAt: null,
      openedAt: stamp(),
      contact: {
        id: 'billing-preview-contact',
        label: 'Cliente de demonstração',
        displayName: 'Cliente de demonstração',
        externalId: '5500000000000',
      },
      order: { id: PREVIEW_ORDER, number: '24-CRM', status: 'confirmado' },
      reviewOrder: null,
      lastMessage: { ...recent, preview: recent.text },
      requiresAttention: false,
      waitingSince: messages.length ? null : stamp(),
      bucket: messages.length ? 'awaiting' : 'respond',
      turnSince: stamp(),
      turnAsOf: stamp(),
      turnBusinessMinutes: 0,
      reminder: null,
      lostOutcome: null,
    };
  }
  const order = () => ({
    id: PREVIEW_ORDER,
    number: '24-CRM',
    version: 2,
    status: 'confirmado',
    conversationId: PREVIEW_CONVERSATION,
    origin: 'atendimento',
    seller: PREVIEW_USER,
    finalAmountCents: amount,
    totalPieces: 30,
    fabCode: 'FAB 01',
    createdAt: '2026-11-08T15:00:00.000Z',
    updatedAt: stamp(),
    firstContactAt: '2026-11-06T15:00:00.000Z',
    orderDate: '2026-11-08',
    deliveredOn: null,
    reopenedAt: null,
    reopenedBy: null,
    paymentCondition: 'pix',
    confirmedAt: stamp(),
    confirmedBy: PREVIEW_USER,
    paidOn: balance() === 0 ? '2026-11-08' : null,
    missingFields: [],
    ficha: {
      summary: {
        nome: 'Uniformes da equipe',
        cliente: 'Cliente de demonstração',
        aplicacao: 'BORDADO',
        data_entrega_confirmada: '2026-12-08',
      },
      artwork: {
        feito_pelo_cliente: true,
        feito_pela_silmer: false,
        sem_estampa: false,
        files: [],
      },
      serviceData: {
        purpose: 'Uniformes da equipe',
        city_or_postal_code: 'Cidade de demonstração',
      },
      observations: [],
      items: [
        {
          id: 'preview-item-1',
          tipo: 'CAMISETA',
          cor: 'BRANCA',
          modelo: 'BÁSICA',
          tipo_servico: 'BORDADO',
          estampa: 'Logo da equipe',
          gola: 'GOLA REDONDA',
          malhas: ['ALGODÃO'],
          grade: [
            { tamanho: 'M', quantidade: 20 },
            { tamanho: 'G', quantidade: 10 },
          ],
        },
      ],
    },
  });
  function api(path, method = 'GET') {
    if (method !== 'GET')
      return {
        status: 403,
        body: {
          code: 'PREVIEW_READ_ONLY',
          detail: 'Esta prévia não executa comandos reais.',
        },
      };
    if (path === '/api/v1/sessions/current')
      return { body: { user: PREVIEW_USER } };
    if (path === '/api/v1/users/assignable')
      return { body: { users: [PREVIEW_USER] } };
    if (path === '/api/v1/orders/summary')
      return { body: { storeNewCount: 0 } };
    if (path === '/api/v1/orders')
      return { body: { items: [order()], totalCount: 1, nextCursor: null } };
    if (path === `/api/v1/orders/${PREVIEW_ORDER}/files`)
      return { body: { final: null, references: [] } };
    if (path === '/api/v1/inbox/buckets')
      return {
        body: {
          respond: messages.length ? 0 : 1,
          awaiting: messages.length ? 1 : 0,
          silent: 0,
          lost: 0,
        },
      };
    if (path === '/api/v1/inbox/conversations')
      return {
        body: { items: [conversation()], totalCount: 1, nextCursor: null },
      };
    if (path.endsWith(`/${PREVIEW_CONVERSATION}/subjects`))
      return {
        body: {
          currentSubjectId: 'billing-preview-subject',
          subjects: [
            {
              id: 'billing-preview-subject',
              kind: 'order',
              orderId: PREVIEW_ORDER,
              orderNumber: '24-CRM',
              orderStatus: 'confirmado',
              label: 'Uniformes da equipe',
              isCurrent: true,
              position: 1,
              version: 1,
            },
          ],
          orders: [
            { id: PREVIEW_ORDER, number: '24-CRM', status: 'confirmado' },
          ],
          links: [],
          needsSubjectMessageIds: [],
          ordersHasMore: false,
        },
      };
    if (path.endsWith(`/${PREVIEW_CONVERSATION}/handoff`))
      return { body: { handoff: null } };
    if (path === `/api/v1/inbox/conversations/${PREVIEW_CONVERSATION}`)
      return {
        body: {
          conversation: conversation(),
          messages: [
            {
              id: 'preview-inbound-1',
              type: 'text',
              direction: 'inbound',
              authorKind: 'contact',
              text: 'Fechado o pedido das 30 camisetas por R$ 1.200,00.',
              status: 'received',
              occurredAt: stamp(),
            },
            {
              id: 'preview-outbound-1',
              type: 'text',
              direction: 'outbound',
              authorKind: 'human',
              text: 'Perfeito! Ficou combinado o sinal de 30% e o restante depois.',
              status: 'sent',
              deliveryStatus: 'delivered',
              occurredAt: stamp(),
            },
            {
              ...conversation().lastMessage,
              id: 'preview-inbound-2',
              direction: 'inbound',
              authorKind: 'contact',
              text: 'Pode me enviar o link do sinal de 30%?',
              status: 'received',
              deliveryStatus: null,
            },
            ...messages,
          ].map((message) => ({ ...message, preview: message.text })),
          suggestion: null,
        },
      };
    if (
      path === `/api/v1/orders/${PREVIEW_ORDER}` ||
      path === `/api/v1/conversations/${PREVIEW_CONVERSATION}/order`
    )
      return { body: { order: order() } };
    if (path.endsWith('/shipping-quote')) return { body: { quote: null } };
    if (path.endsWith('/order-assistance'))
      return {
        body: {
          suggestions: [],
          evaluations: [],
          sourceRevision: 1,
          conversationVersion: 4,
        },
      };
    if (path.endsWith('/lead-outcome'))
      return { body: { outcome: null, outcomeVersion: 0 } };
    return { status: 404, body: { code: 'PREVIEW_NOT_FOUND' } };
  }
  reset();
  return { view, action, api, dispose, order };
}
