import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationShippingRuntime } from '../apps/api/src/conversation-shipping-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';

const INPUT = {
  actor: { id: 'seller', kind: 'human' },
  conversationId: 'conversation',
  correlationId: 'synthetic-quote',
  idempotencyKey: 'request-1',
  body: {
    subjectId: 'subject',
    orderId: 'order',
    orderVersion: 1,
    fromPostalCode: '01001000',
    toPostalCode: '20040020',
    weightGrams: 1000,
    widthCm: 20,
    heightCm: 15,
    lengthCm: 10,
    insuranceValueCents: 10000,
  },
};

function fixture() {
  /** @type {any} */ const state = {
    role: 'Vendedor',
    disabled: false,
    owner: 'seller',
    mode: 'human',
    closed: false,
    subjectOrder: 'order',
    orderVersion: 1,
    quotes: [],
    commands: [],
    audits: [],
    calls: 0,
  };
  const db = {
    /** @param {string} sql @param {any[]} [values] */
    async query(sql, values = []) {
      if (sql.includes('SELECT u.id,u.name'))
        return {
          rows: state.disabled
            ? []
            : [{ id: 'seller', name: 'Seller', function_name: state.role }],
        };
      if (sql.includes('SELECT capability')) return { rows: [] };
      if (sql.includes('FROM crm.conversations'))
        return {
          rows: [
            {
              id: 'conversation',
              assigned_user_id: state.owner,
              automation_state: state.mode,
              terminal_at: state.closed ? '2026-11-02' : null,
            },
          ],
        };
      if (sql.includes('FROM crm.conversation_subjects'))
        return { rows: [{ order_id: state.subjectOrder }] };
      if (sql.includes('SELECT id,version,total_pieces'))
        return {
          rows: [
            {
              id: 'order',
              version: state.orderVersion,
              total_pieces: 4,
              origin: 'atendimento',
            },
          ],
        };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT fingerprint,quote_id'))
        return {
          rows: state.commands.filter(
            (/** @type {any} */ row) =>
              row.operation === values[0] && row.key === values[1],
          ),
        };
      if (sql.startsWith('UPDATE crm.shipping_quotes SET superseded_at')) {
        for (const row of state.quotes)
          if (!row.superseded_at) row.superseded_at = values[1];
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO crm.shipping_quotes')) {
        const [
          id,
          conversation_id,
          subject_id,
          order_id,
          order_version,
          total_pieces,
          envelope,
          created_by,
          created_at,
        ] = values;
        state.quotes.push({
          id,
          conversation_id,
          subject_id,
          order_id,
          order_version,
          total_pieces,
          quote_envelope: JSON.parse(envelope),
          created_by,
          created_at,
          selected_service_id: null,
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT quote.*'))
        return {
          rows: state.quotes
            .filter((/** @type {any} */ row) => row.id === values[0])
            .map((/** @type {any} */ row) => ({
              ...structuredClone(row),
              creator_name: 'Seller',
              current_order_version: state.orderVersion,
            })),
        };
      if (sql.startsWith('INSERT INTO crm.shipping_quote_commands')) {
        state.commands.push({
          operation: values[0],
          key: values[1],
          fingerprint: values[2],
          quote_id: values[3],
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO crm.audit_events')) {
        state.audits.push(values);
        return { rows: [] };
      }
      if (
        sql.startsWith('UPDATE crm.shipping_quotes SET selected_service_id')
      ) {
        Object.assign(
          state.quotes.find((/** @type {any} */ row) => row.id === values[0]),
          {
            selected_service_id: values[1],
            selected_by: values[2],
            selected_at: values[3],
          },
        );
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    /** @param {(client:any)=>Promise<any>} work */
    async transaction(work) {
      const before = structuredClone(state);
      try {
        return await work(db);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
  };
  /** @type {()=>void} */ let afterCalculate = () => {};
  const runtime = createConversationShippingRuntime(db, {
    key: Buffer.alloc(32, 7),
    clock: () => new Date('2026-11-02T12:00:00Z'),
    requireConfigured: () => {},
    calculate: async () => {
      state.calls++;
      afterCalculate();
      return {
        services: [
          {
            id: 1,
            name: 'PAC',
            company: 'Correios',
            priceCents: 2250,
            deliveryDays: 5,
          },
        ],
        unavailable: [],
      };
    },
  });
  return {
    state,
    runtime,
    setAfterCalculate: (/** @type {()=>void} */ work) => {
      afterCalculate = work;
    },
  };
}

test('T139 sellers can quote without account management; automation and Financeiro cannot', () => {
  const seller = {
    id: 'seller',
    kind: /** @type {const} */ ('human'),
    functionName: /** @type {const} */ ('Vendedor'),
    capabilities: [],
  };
  assert.doesNotThrow(() => authorize(seller, 'shipping.quote'));
  assert.throws(() => authorize(seller, 'shipping.manage'), {
    code: 'FORBIDDEN',
  });
  assert.throws(
    () =>
      authorize({ ...seller, functionName: 'Financeiro' }, 'shipping.quote'),
    { code: 'FORBIDDEN' },
  );
  assert.throws(
    () => authorize({ ...seller, kind: 'assistant' }, 'shipping.quote'),
    { code: 'FORBIDDEN' },
  );
});

test('T139 quote and selection are encrypted, audited, replayed and server priced', async () => {
  const { runtime, state } = fixture();
  const { quote } = await runtime.quote(INPUT);
  assert.equal(quote.totalPieces, 4);
  assert.equal(quote.selectedServiceId, null);
  assert.equal(quote.stale, false);
  assert.ok(!JSON.stringify(state).includes(INPUT.body.toPostalCode));
  assert.equal((await runtime.quote(INPUT)).quote.id, quote.id);
  assert.equal(state.calls, 1);
  await assert.rejects(
    runtime.quote({
      ...INPUT,
      body: { ...INPUT.body, toPostalCode: '30000000' },
    }),
    { code: 'IDEMPOTENCY_KEY_REUSED' },
  );
  const selection = {
    ...INPUT,
    quoteId: quote.id,
    idempotencyKey: 'select-1',
    body: {
      subjectId: 'subject',
      orderId: 'order',
      orderVersion: 1,
      serviceId: 1,
    },
  };
  assert.equal((await runtime.select(selection)).quote.selectedServiceId, 1);
  await runtime.select(selection);
  assert.equal(state.audits.length, 2);
  await assert.rejects(
    runtime.select({
      ...selection,
      idempotencyKey: 'select-invalid',
      body: { ...selection.body, serviceId: 99 },
    }),
    { code: 'INVALID_SHIPPING_SERVICE' },
  );
  assert.equal(state.orderVersion, 1);
});

test('T139 target, owner, role and lifecycle are rechecked before and after remote calculation', async () => {
  for (const [
    field,
    value,
    code,
  ] of /** @type {Array<[string,unknown,string]>} */ ([
    ['owner', 'other', 'FORBIDDEN'],
    ['role', 'Financeiro', 'FORBIDDEN'],
    ['disabled', true, 'FORBIDDEN'],
    ['mode', 'assistant', 'CONVERSATION_NOT_HUMAN'],
    ['closed', true, 'CONVERSATION_NOT_HUMAN'],
    ['subjectOrder', 'other', 'SHIPPING_TARGET_CHANGED'],
    ['orderVersion', 2, 'VERSION_CONFLICT'],
  ])) {
    const before = fixture();
    before.state[field] = value;
    await assert.rejects(before.runtime.quote(INPUT), { code });
    assert.equal(before.state.calls, 0);
    const during = fixture();
    during.setAfterCalculate(() => {
      during.state[field] = value;
    });
    await assert.rejects(during.runtime.quote(INPUT), { code });
    assert.equal(during.state.quotes.length, 0);
  }
});

test('T139 new destination or order changes invalidate an earlier selection; stale replay cannot bypass owner', async () => {
  const { runtime, state } = fixture();
  const { quote } = await runtime.quote(INPUT);
  const select = {
    ...INPUT,
    quoteId: quote.id,
    idempotencyKey: 'select-1',
    body: {
      subjectId: 'subject',
      orderId: 'order',
      orderVersion: 1,
      serviceId: 1,
    },
  };
  await runtime.select(select);
  await runtime.quote({
    ...INPUT,
    idempotencyKey: 'new-destination',
    body: { ...INPUT.body, toPostalCode: '30000000' },
  });
  assert.equal((await runtime.select(select)).quote.stale, true);
  await assert.rejects(
    runtime.select({ ...select, idempotencyKey: 'old-selection' }),
    { code: 'SHIPPING_QUOTE_STALE' },
  );
  state.owner = 'other';
  await assert.rejects(runtime.select(select), { code: 'FORBIDDEN' });
});
