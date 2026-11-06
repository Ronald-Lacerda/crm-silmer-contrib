import { persistFixturePricing } from './fixtures/size-pricing.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOrderApiRuntime,
  createOrderRuntime,
} from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { syntheticItems } from './fixtures/order-items.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';

const OWNER = Object.freeze({
  capabilities: [],
  functionName: 'Vendedor',
  id: 'seller-1',
  kind: 'human',
});
const OTHER = Object.freeze({ ...OWNER, id: 'seller-2' });
const ADMIN = Object.freeze({
  ...OWNER,
  capabilities: ['COMMERCIAL_ADMIN'],
  id: 'admin-1',
});

function harness() {
  /** @type {Record<string, string|null>} */
  const assignments = {
    'conversation-1': 'seller-1',
    'conversation-unassigned': null,
  };
  /** @type {string[]} */
  const assignmentReads = [];
  /** @type {any[]} */
  const audits = [];
  const access = {
    authorizeRead: async () => ({ actor: OTHER }),
    authorizeWrite: async () => ({ actor: OWNER }),
  };
  const repository = new InMemoryOrderRepository();
  const runtime = createOrderRuntime({
    access,
    auditTrail: {
      append: async (/** @type {any} */ event) => void audits.push(event),
    },
    clock: () => new Date('2026-09-12T15:00:00.000Z'),
    conversations: {
      readAssignment: async (/** @type {string} */ conversationId) => {
        assignmentReads.push(conversationId);
        return conversationId in assignments
          ? { assignedUserId: assignments[conversationId], version: 7 }
          : null;
      },
      readAssignments: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, assignments[id] ?? null])),
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: orderContextsFrom(
        (/** @type {string} */ conversationId) =>
          conversationId in assignments
            ? { briefing: null, customerName: 'Cliente Sintetico' }
            : null,
      ),
      readContactNames: async (/** @type {string[]} */ ids) =>
        new Map(
          ids
            .filter((id) => id === 'contact-1')
            .map((id) => [id, 'Cliente Sintético']),
        ),
      readUserNames: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, `Nome ${id}`])),
      searchConversationIds: async () => [],
      searchContactIds: async () => ['contact-1'],
    },
    fabCode: '01',
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    repository,
  });
  return { access, assignmentReads, assignments, audits, runtime, repository };
}

test('a seller creates a manual contact order and its owner may edit it', async () => {
  const { runtime } = harness();
  const input = command(OWNER, { contactId: 'contact-1' });
  const created = await runtime.createForContact(input);
  assert.equal(created.conversationId, null);
  assert.equal(created.seller?.id, OWNER.id);
  assert.equal(created.ficha.summary.cliente, 'Cliente Sintético');
  assert.deepEqual(await runtime.createForContact(input), created);
  await assert.rejects(
    runtime.patchSection(
      command(OTHER, {
        orderId: created.id,
        expectedVersion: created.version,
        section: 'summary',
        value: { data_entrega_confirmada: '2026-10-24', nome: 'Evento' },
      }),
    ),
    { code: 'FORBIDDEN' },
  );
  const edited = await runtime.patchSection(
    command(OWNER, {
      orderId: created.id,
      expectedVersion: created.version,
      section: 'summary',
      value: { data_entrega_confirmada: '2026-10-24', nome: 'Evento' },
    }),
  );
  assert.equal(edited.ficha.summary.nome, 'Evento');
});

let commandSequence = 0;
/** @param {any} actor @param {Record<string, unknown>} extra @returns {any} */
function command(actor, extra) {
  commandSequence += 1;
  return {
    actor,
    correlationId: 'correlation-command',
    idempotencyKey: `command-${commandSequence}`,
    ...extra,
  };
}

/** @param {any} runtime @param {any} actor @param {string} conversationId */
function create(runtime, actor, conversationId) {
  return runtime.createManual(
    command(actor, { conversationId, expectedVersion: 7 }),
  );
}

test('the conversation owner creates, edits and confirms its order', async () => {
  const { audits, runtime, repository } = harness();
  const created = await create(runtime, OWNER, 'conversation-1');
  assert.equal(created.created, true);
  const promised = await runtime.patchSection(
    command(OWNER, {
      expectedVersion: created.order.version,
      orderId: created.order.id,
      section: 'summary',
      value: {
        aplicacao: null,
        data_entrega_confirmada: '2026-10-24',
        nome: null,
      },
    }),
  );
  const withItems = await runtime.patchSection(
    command(OWNER, {
      expectedVersion: promised.version,
      orderId: created.order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  const edited = await runtime.patchSection(
    command(OWNER, {
      expectedVersion: withItems.version,
      orderId: created.order.id,
      section: 'artwork',
      value: { feito_pela_silmer: true, feito_pelo_cliente: false },
    }),
  );
  const priced = await persistFixturePricing(repository, edited, 482000, OWNER);
  const confirmed = await runtime.confirm(
    command(OWNER, {
      amountText: '4.820,00',
      expectedVersion: priced.version,
      orderId: edited.id,
      paymentCondition: 'pix',
    }),
  );
  assert.equal(confirmed.status, 'confirmado');
  assert.deepEqual(confirmed.confirmedBy, {
    id: 'seller-1',
    name: 'Nome seller-1',
  });
  const paid = await runtime.recordMilestones(
    command(OWNER, {
      deliveredOn: null,
      expectedVersion: confirmed.version,
      orderId: confirmed.id,
      paidOn: '2026-09-12',
    }),
  );
  assert.equal(paid.paidOn, '2026-09-12');
  assert.deepEqual(
    audits.map((event) => [event.action, event.actor, event.target]),
    [
      [
        'order.create',
        'seller-1',
        { id: 'conversation-1', type: 'conversation' },
      ],
      ['order.edit', 'seller-1', { id: created.order.id, type: 'order' }],
      ['order.edit', 'seller-1', { id: created.order.id, type: 'order' }],
      ['order.edit', 'seller-1', { id: created.order.id, type: 'order' }],
      ['order.confirm', 'seller-1', { id: created.order.id, type: 'order' }],
      ['order.milestones', 'seller-1', { id: created.order.id, type: 'order' }],
    ],
  );
});

test('another seller is refused with 403 on every order command', async () => {
  const { runtime } = harness();
  await assert.rejects(create(runtime, OTHER, 'conversation-1'), {
    code: 'FORBIDDEN',
    statusCode: 403,
  });
  const { order } = await create(runtime, OWNER, 'conversation-1');
  for (const attempt of [
    () =>
      runtime.patchSection(
        command(OTHER, {
          expectedVersion: order.version,
          orderId: order.id,
          section: 'observations',
          value: [],
        }),
      ),
    () =>
      runtime.confirm(
        command(OTHER, {
          amountText: '10,00',
          expectedVersion: order.version,
          orderId: order.id,
          paymentCondition: 'pix',
        }),
      ),
    () =>
      runtime.reopen(
        command(OTHER, { expectedVersion: order.version, orderId: order.id }),
      ),
  ]) {
    await assert.rejects(attempt(), { code: 'FORBIDDEN', statusCode: 403 });
  }
  // Nobody owns an unassigned conversation, so only an admin may act on it.
  await assert.rejects(create(runtime, OWNER, 'conversation-unassigned'), {
    code: 'FORBIDDEN',
    statusCode: 403,
  });
});

test('a commercial admin acts on any conversation', async () => {
  const { runtime } = harness();
  const { order } = await create(runtime, ADMIN, 'conversation-unassigned');
  const saved = await runtime.patchSection(
    command(ADMIN, {
      expectedVersion: order.version,
      orderId: order.id,
      section: 'observations',
      value: ['Conferir arte'],
    }),
  );
  assert.deepEqual(saved.ficha.observations, ['Conferir arte']);
  assert.equal(saved.seller, null);
});

test('ownership is read from the conversation on each command', async () => {
  const { assignmentReads, assignments, runtime } = harness();
  const { order } = await create(runtime, OWNER, 'conversation-1');
  assignmentReads.length = 0;
  // "Repassar atendimento": the new owner gains the order, the old one loses it.
  assignments['conversation-1'] = 'seller-2';
  await assert.rejects(
    runtime.patchSection(
      command(OWNER, {
        expectedVersion: order.version,
        orderId: order.id,
        section: 'observations',
        value: [],
      }),
    ),
    { code: 'FORBIDDEN', statusCode: 403 },
  );
  const saved = await runtime.patchSection(
    command(OTHER, {
      expectedVersion: order.version,
      orderId: order.id,
      section: 'observations',
      value: ['Novo dono'],
    }),
  );
  assert.equal(saved.version, order.version + 1);
  assert.deepEqual(assignmentReads, ['conversation-1', 'conversation-1']);
});

test('creating checks the conversation version after ownership', async () => {
  const { runtime } = harness();
  await assert.rejects(
    runtime.createManual(
      command(OTHER, { conversationId: 'conversation-1', expectedVersion: 3 }),
    ),
    { code: 'FORBIDDEN', statusCode: 403 },
  );
  await assert.rejects(
    runtime.createManual(
      command(OWNER, { conversationId: 'conversation-1', expectedVersion: 3 }),
    ),
    { code: 'VERSION_CONFLICT', statusCode: 409 },
  );
});

test('an order command on a missing conversation is a 404', async () => {
  const { runtime } = harness();
  await assert.rejects(create(runtime, ADMIN, 'conversation-x'), {
    code: 'CONVERSATION_NOT_FOUND',
    statusCode: 404,
  });
});

test('a repeated command key replays the first response without a second effect', async () => {
  const { audits, runtime } = harness();
  const { order } = await create(runtime, OWNER, 'conversation-1');
  const patch = command(OWNER, {
    expectedVersion: order.version,
    orderId: order.id,
    section: 'observations',
    value: ['Primeira'],
  });
  const first = await runtime.patchSection(patch);
  const replay = await runtime.patchSection({ ...patch });
  assert.deepEqual(replay, first);
  assert.equal((await runtime.get(order.id)).order.version, order.version + 1);
  assert.equal(
    audits.filter((event) => event.action === 'order.edit').length,
    1,
  );

  await assert.rejects(
    runtime.patchSection({ ...patch, value: ['Outra coisa'] }),
    { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 },
  );
});

test('a confirmation without amount or condition is a 422, not a crash', async () => {
  const { runtime } = harness();
  const { order } = await create(runtime, OWNER, 'conversation-1');
  await assert.rejects(
    runtime.confirm(
      command(OWNER, { expectedVersion: order.version, orderId: order.id }),
    ),
    {
      code: 'ORDER_NOT_CONFIRMABLE',
      fields: [
        'items',
        'artwork',
        'summary.data_entrega_confirmada',
        'finalAmount',
        'paymentCondition',
        'sizePricing',
      ],
      statusCode: 422,
    },
  );
});

test('a failed command does not burn its key', async () => {
  const { runtime } = harness();
  const { order } = await create(runtime, OWNER, 'conversation-1');
  const stale = command(OWNER, {
    expectedVersion: order.version + 5,
    orderId: order.id,
    section: 'observations',
    value: [],
  });
  await assert.rejects(runtime.patchSection(stale), {
    code: 'VERSION_CONFLICT',
  });
  const retried = await runtime.patchSection({
    ...stale,
    expectedVersion: order.version,
  });
  assert.equal(retried.version, order.version + 1);
});

test('commands require an idempotency key and an expected version', async () => {
  const { runtime } = harness();
  await assert.rejects(
    runtime.createManual(
      /** @type {any} */ ({
        actor: OWNER,
        conversationId: 'conversation-1',
        correlationId: 'correlation-command',
        expectedVersion: 7,
      }),
    ),
    TypeError,
  );
  await assert.rejects(
    runtime.createManual(command(OWNER, { conversationId: 'conversation-1' })),
    { statusCode: 400 },
  );
});

test('reads need no ownership and the runtime forwards session guards', async () => {
  const { access, assignmentReads, runtime } = harness();
  const { order } = await create(runtime, OWNER, 'conversation-1');
  assignmentReads.length = 0;
  assert.equal((await runtime.get(order.id)).order.id, order.id);
  assert.equal(
    (await runtime.currentForConversation('conversation-1')).order?.id,
    order.id,
  );
  assert.equal((await runtime.list({})).items.length, 1);
  assert.deepEqual(assignmentReads, []);
  assert.equal(runtime.authorizeRead, access.authorizeRead);
  assert.equal(runtime.authorizeWrite, access.authorizeWrite);
});

test('the automation intent reuses the pending order without ownership', async () => {
  const { assignmentReads, runtime } = harness();
  const first = await runtime.ensurePendingFromIntent({
    conversationId: 'conversation-unassigned',
    correlationId: 'correlation-intent',
  });
  const second = await runtime.ensurePendingFromIntent({
    conversationId: 'conversation-unassigned',
    correlationId: 'correlation-intent-2',
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.order.id, first.order.id);
  assert.deepEqual(assignmentReads, []);
});

const KEY = Buffer.alloc(32, 7).toString('base64url');
const ENVIRONMENT = Object.freeze({
  CONTACT_IDENTITY_ENVELOPE_KEY: KEY,
  CONTACT_IDENTITY_LOOKUP_KEY: KEY,
  FAB_CODE: '01',
  IDEMPOTENCY_ENVELOPE_KEY: KEY,
  N8N_INTEGRATION_ENVELOPE_KEY: KEY,
});
const FAKE_DATABASE = Object.freeze({
  query: async () => ({ rows: [] }),
  transaction: async () => {},
});

test('the PostgreSQL wiring refuses incomplete configuration', () => {
  const access = {
    authorizeRead: async () => ({ actor: OWNER }),
    authorizeWrite: async () => ({ actor: OWNER }),
  };
  assert.equal(
    typeof createOrderApiRuntime(FAKE_DATABASE, {
      access,
      environment: ENVIRONMENT,
    }).confirm,
    'function',
  );
  for (const [
    name,
    value,
    message,
  ] of /** @type {Array<[string, string|undefined, RegExp]>} */ ([
    ['FAB_CODE', undefined, /FAB_CODE is required/u],
    ['N8N_INTEGRATION_ENVELOPE_KEY', 'c2hvcnQ', /32 bytes/u],
    ['CONTACT_IDENTITY_ENVELOPE_KEY', undefined, /CONTACT_IDENTITY/u],
    ['CONTACT_IDENTITY_LOOKUP_KEY', undefined, /CONTACT_IDENTITY_LOOKUP_KEY/u],
    ['IDEMPOTENCY_ENVELOPE_KEY', undefined, /IDEMPOTENCY_ENVELOPE_KEY/u],
  ])) {
    assert.throws(
      () =>
        createOrderApiRuntime(FAKE_DATABASE, {
          access,
          environment: { ...ENVIRONMENT, [name]: value },
        }),
      message,
    );
  }
});

test('the server composes orders only when FAB_CODE is configured', async () => {
  const { createOrdersForServer } = await import('../apps/api/src/server.js');
  const operations = {
    authorizeRead: async () => ({ actor: OWNER }),
    authorizeWrite: async () => ({ actor: OWNER }),
  };
  assert.equal(
    createOrdersForServer({
      database: FAKE_DATABASE,
      environment: {},
      operations,
    }),
    undefined,
  );
  assert.equal(
    createOrdersForServer({
      database: FAKE_DATABASE,
      environment: ENVIRONMENT,
      operations: undefined,
    }),
    undefined,
  );
  const orders = createOrdersForServer({
    database: FAKE_DATABASE,
    environment: ENVIRONMENT,
    operations,
  });
  assert.equal(orders?.authorizeWrite, operations.authorizeWrite);
});

test('fails fast without the ports it composes', () => {
  assert.throws(
    () =>
      createOrderRuntime(
        /** @type {any} */ ({
          access: {},
          conversations: {},
          fabCode: '01',
          repository: new InMemoryOrderRepository(),
        }),
      ),
    TypeError,
  );
});

test('OLIST-T20b adoption replays the same IDs once, audits no pricing payload and does not create on a new key', async () => {
  const { runtime, audits } = harness();
  const { order } = await create(runtime, OWNER, 'conversation-1');
  const input = command(OWNER, {
    orderId: order.id,
    expectedVersion: order.version,
    section: 'size-pricing',
    value: { action: 'initialize' },
  });
  const adopted = await runtime.patchSection(input);
  assert.deepEqual(await runtime.patchSection(input), adopted);
  assert.deepEqual(
    (await runtime.get(order.id)).order.ficha.sizePricing,
    adopted.ficha.sizePricing,
  );
  assert.equal(audits.filter((a) => a.action === 'order.edit').length, 1);
  assert.doesNotMatch(
    JSON.stringify(audits),
    /subtotal|sizePricing|initialize/u,
  );
  await assert.rejects(
    runtime.patchSection(
      command(OWNER, {
        orderId: order.id,
        expectedVersion: adopted.version,
        section: 'size-pricing',
        value: { action: 'initialize' },
      }),
    ),
    { code: 'SIZE_PRICING_ALREADY_INITIALIZED' },
  );
  await assert.rejects(
    runtime.patchSection({
      ...input,
      value: { action: 'duplicate_group', groupId: 'forged' },
    }),
    { code: 'IDEMPOTENCY_KEY_REUSED' },
  );
});
