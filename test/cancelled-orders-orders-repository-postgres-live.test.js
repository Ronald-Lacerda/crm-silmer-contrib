import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import {
  PostgresContactIdentityRepository,
  createContactIdentityService,
} from '../modules/contacts/src/index.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  PostgresInboxRepository,
  createInboxService,
} from '../modules/inbox-channels/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { PostgresOrderConversationPort } from '../modules/orders/src/adapters/postgres-order-conversation-port.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';

// OLIST-45/46, ADR 068: a locally cancelled order leaves every active
// universe of the order module (vendas, valor vendido, painel diário,
// entregas abertas, "ficha da loja nova" e primeira impressão) while it stays
// readable by id and through the explicit `cancellation` list filter.
const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-08T12:00:00.000Z');
const KEY = Buffer.alloc(32, 94);
const CONTACT_KEY = Buffer.alloc(32, 95);
const SELLER = 'cancelled-orders-seller';
const PERIOD = {
  from: '2026-11-01',
  to: '2026-11-30',
  dailyFrom: '2026-11-01',
  dailyTo: '2026-11-30',
};

/** @param {Pool} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}

/** @param {Pool} pool */
function channelServices(pool) {
  const database = databaseFor(pool);
  const auditPort = { append: async () => undefined };
  return {
    contacts: createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 96),
      }),
    }),
    inbox: createInboxService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: Buffer.alloc(32, 97),
        outboundMessageOutbox: { enqueueChannelMessage: async () => undefined },
      }),
    }),
  };
}

/** A real conversation owned by the seller; the handle is searchable. @param {Pool} pool */
async function seedConversation(pool) {
  const runId = randomUUID().replaceAll('-', '');
  const handle = `@cancelled_${runId.slice(0, 8)}`;
  const { contacts, inbox } = channelServices(pool);
  const resolved = await contacts.resolveInboundIdentity({
    channel: 'instagram',
    correlationId: `correlation-identity-${runId}`,
    displayHandle: handle,
    externalIdentityId: `identity-${runId}`,
    identityKind: 'handle',
    occurredAt: NOW.toISOString(),
    phoneStatus: 'pending',
    provider: 'meta',
    providerAccountId: `account-cancelled-${runId}`,
  });
  const { conversation } = await inbox.receiveInbound({
    contactId: resolved.contact.id,
    correlationId: `correlation-message-${runId}`,
    externalConversationId: `conversation-${runId}`,
    externalMessageId: `message-${runId}`,
    identityId: resolved.identity.id,
    message: { content: { text: 'Quero orçamento' }, type: 'text' },
    occurredAt: NOW.toISOString(),
    provider: 'meta',
    providerAccountId: `account-cancelled-${runId}`,
  });
  await pool.query(
    'UPDATE crm.conversations SET assigned_user_id=$2 WHERE id=$1',
    [conversation.id, SELLER],
  );
  return {
    conversationId: /** @type {string} */ (conversation.id),
    contactId: /** @type {string} */ (resolved.contact.id),
    handle,
  };
}

/**
 * @param {Pool} pool
 * @param {{origin?:'atendimento'|'loja', status?:'pendente'|'confirmado', amount?:number, date?:string, conversation?:{conversationId:string,contactId:string}, cancelled?:boolean, paidAt?:Date}} [options]
 */
async function seedOrder(pool, options = {}) {
  const id = `cancelled-orders-${randomUUID()}`;
  const store = options.origin === 'loja';
  const confirmed = (options.status ?? 'confirmado') === 'confirmado';
  const contact = store
    ? null
    : (options.conversation?.contactId ?? `contact-${id}`);
  if (contact && !options.conversation)
    await pool.query(
      'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES ($1,$2,$2)',
      [contact, NOW],
    );
  const sequence = Number(
    (await pool.query("SELECT nextval('crm.order_number_seq') AS n")).rows[0].n,
  );
  const amount = confirmed ? (options.amount ?? 10000) : null;
  await pool.query(
    `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,origin,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at,is_test,store_number,lead_time_business_days,payment_source,payment_confirmed_at,paid_amount_cents,payment_transaction_nsu,payment_invoice_slug,paid_on)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'01',$10::jsonb,2,$11,$12,$13::date,$14,$15,'user',$16,$17,$17,false,$18,$19,$20,$21,$22,$23,$24,$25::date)`,
    [
      id,
      sequence,
      `${String(sequence).padStart(2, '0')}-CRM`,
      options.conversation?.conversationId ?? null,
      contact,
      store || options.conversation ? null : SELLER,
      store || options.conversation ? null : randomUUID(),
      store ? 'loja' : 'atendimento',
      options.status ?? 'confirmado',
      JSON.stringify(
        encryptJson(
          {
            summary: { cliente: 'Cliente sintético' },
            items: [],
            artwork: {},
            serviceData: {},
          },
          `order-ficha:${id}`,
          KEY,
        ),
      ),
      amount,
      confirmed ? 'pix' : null,
      confirmed ? (options.date ?? '2026-11-05') : null,
      confirmed ? NOW : null,
      confirmed ? SELLER : null,
      SELLER,
      NOW,
      store ? `LJ-${randomUUID().slice(0, 8).toUpperCase()}` : null,
      store ? 10 : null,
      store ? 'infinitepay' : null,
      store ? (options.paidAt ?? NOW) : null,
      store ? amount : null,
      store ? randomUUID() : null,
      store ? 'synthetic-invoice' : null,
      store ? (options.date ?? '2026-11-05') : null,
    ],
  );
  if (options.cancelled) await cancel(pool, id);
  return id;
}

/** @param {Pool} pool @param {string} orderId */
async function cancel(pool, orderId) {
  await pool.query(
    `UPDATE crm.orders SET cancelled_at=$2,cancelled_by=$3,cancellation_reason_envelope=$4::jsonb,version=version+1,updated_at=$2 WHERE id=$1`,
    [
      orderId,
      NOW,
      SELLER,
      JSON.stringify(
        encryptJson('Motivo sintético', `order-cancellation:${orderId}`, KEY),
      ),
    ],
  );
}

if (!connectionString) {
  test(
    'Cancelled order repository PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(
    new URL(connectionString).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    'Only a dedicated synthetic database may be reset',
  );
  const pool = new Pool({ connectionString, max: 6 });
  const repository = new PostgresOrderRepository({
    database: databaseFor(pool),
    envelopeKey: KEY,
  });
  const port = new PostgresOrderConversationPort({
    database: databaseFor(pool),
    envelopeKey: KEY,
    contactEnvelopeKey: CONTACT_KEY,
    contactLookupKey: Buffer.alloc(32, 96),
  });

  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      "INSERT INTO crm.users(id,email,password_hash,name) VALUES ($1,$2,'$argon2id$synthetic','Pessoa sintética')",
      [SELLER, `${SELLER}@example.test`],
    );
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });

  test('summary(): cancelled orders add nothing to sales, sold value, pieces, pending, store-new or the daily panel', async () => {
    // Active universe first.
    await seedOrder(pool, { amount: 10000, date: '2026-11-05' });
    await seedOrder(pool, { amount: 20000, date: '2026-11-06' });
    await seedOrder(pool, { status: 'pendente' });
    await seedOrder(pool, {
      origin: 'loja',
      amount: 18000,
      date: '2026-11-06',
      paidAt: new Date('2026-11-06T12:00:00Z'),
    });
    const expected = {
      confirmedCount: 3,
      soldAmountCents: 48000,
      averageTicketCents: 16000,
      pendingCount: 1,
      totalPiecesSold: 6,
      storeNewCount: 1,
      storeNewOldestPaidAt: '2026-11-06T12:00:00.000Z',
      period: { confirmedCount: 3, soldAmountCents: 48000 },
      daily: [
        { day: '2026-11-05', confirmedCount: 1, soldAmountCents: 10000 },
        { day: '2026-11-06', confirmedCount: 2, soldAmountCents: 38000 },
      ],
    };
    assert.deepEqual(await repository.summary(PERIOD), expected);

    // Cancelled orders of every kind, including a day that only they sold on
    // and an older unprinted store order that would move the oldest-paid mark.
    await seedOrder(pool, {
      amount: 5000,
      date: '2026-11-05',
      cancelled: true,
    });
    await seedOrder(pool, {
      amount: 7000,
      date: '2026-11-07',
      cancelled: true,
    });
    await seedOrder(pool, { status: 'pendente', cancelled: true });
    await seedOrder(pool, {
      origin: 'loja',
      amount: 9000,
      date: '2026-11-01',
      paidAt: new Date('2026-11-01T12:00:00Z'),
      cancelled: true,
    });
    assert.deepEqual(await repository.summary(PERIOD), expected);
  });

  test('openDeliveries(): the cancelled confirmed order leaves the delivery queue, the active one stays', async () => {
    const active = await seedOrder(pool);
    const cancelled = await seedOrder(pool);
    assert.ok(
      (await repository.openDeliveries()).some((order) => order.id === active),
    );
    assert.ok(
      (await repository.openDeliveries()).some(
        (order) => order.id === cancelled,
      ),
    );
    await cancel(pool, cancelled);
    const open = (await repository.openDeliveries()).map((order) => order.id);
    assert.ok(open.includes(active));
    assert.equal(open.includes(cancelled), false);
    // History by id is intact and still reports the cancellation.
    const found = await repository.findById(cancelled);
    assert.equal(found?.id, cancelled);
    assert.ok(found?.cancelledAt);
  });

  test('recordFirstPrint(): an active store order records once; a cancelled one records nothing but stays readable', async () => {
    const active = await seedOrder(pool, { origin: 'loja' });
    const first = await repository.recordFirstPrint({
      orderId: active,
      actorId: SELLER,
      correlationId: 'synthetic-print',
      now: NOW,
    });
    assert.equal(first.recorded, true);
    const second = await repository.recordFirstPrint({
      orderId: active,
      actorId: SELLER,
      correlationId: 'synthetic-print-2',
      now: NOW,
    });
    assert.equal(second.recorded, false);

    const cancelled = await seedOrder(pool, { origin: 'loja' });
    await cancel(pool, cancelled);
    const before = (
      await pool.query('SELECT version FROM crm.orders WHERE id=$1', [
        cancelled,
      ])
    ).rows[0].version;
    const result = await repository.recordFirstPrint({
      orderId: cancelled,
      actorId: SELLER,
      correlationId: 'synthetic-print-cancelled',
      now: NOW,
    });
    assert.equal(result.recorded, false);
    assert.equal(result.order.id, cancelled);
    assert.ok(result.order.cancelledAt);
    const row = (
      await pool.query(
        'SELECT ficha_first_printed_at,ficha_first_printed_by,version FROM crm.orders WHERE id=$1',
        [cancelled],
      )
    ).rows[0];
    assert.equal(row.ficha_first_printed_at, null);
    assert.equal(row.ficha_first_printed_by, null);
    assert.equal(row.version, before);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM crm.domain_events WHERE aggregate_id=$1 AND event_type='order.ficha_first_printed'",
          [cancelled],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM crm.audit_events WHERE target_id=$1 AND action='order.ficha.first_print'",
          [cancelled],
        )
      ).rows[0].n,
      0,
    );
  });

  test('conversation port: owner and search only scope the list; the cancellation filter of list() decides what is shown', async () => {
    const conversation = await seedConversation(pool);
    const activeOrder = await seedOrder(pool, {
      status: 'pendente',
      conversation,
    });
    const owner = async () => ({
      userId: SELLER,
      conversationIds: await port.listAssignedOrderConversationIds(SELLER),
    });
    /** @param {'active'|'cancelled'|'all'} cancellation @param {any} [extra] */
    const listed = async (cancellation, extra = {}) =>
      (
        await repository.list({
          cancellation,
          cursor: null,
          limit: 100,
          ...extra,
        })
      ).items.map((order) => order.id);

    assert.ok(
      (await port.listAssignedOrderConversationIds(SELLER)).includes(
        conversation.conversationId,
      ),
    );
    assert.ok(
      (await listed('active', { owner: await owner() })).includes(activeOrder),
    );
    const search = {
      conversationIds: await port.searchConversationIds(
        conversation.handle.slice(1),
      ),
    };
    assert.deepEqual(search.conversationIds, [conversation.conversationId]);
    assert.ok((await listed('active', search)).includes(activeOrder));

    await cancel(pool, activeOrder);
    // The port still names the conversation (it is only a scope helper)...
    assert.ok(
      (await port.listAssignedOrderConversationIds(SELLER)).includes(
        conversation.conversationId,
      ),
    );
    assert.deepEqual(
      await port.searchConversationIds(conversation.handle.slice(1)),
      [conversation.conversationId],
    );
    // ...but the cancelled order is out of the active list, owner view and search.
    assert.equal(
      (await listed('active', { owner: await owner() })).includes(activeOrder),
      false,
    );
    assert.equal((await listed('active', search)).includes(activeOrder), false);
    assert.equal((await listed('active')).includes(activeOrder), false);
    // It is found by the explicit cancelled/all filters and by id.
    assert.ok(
      (await listed('cancelled', { owner: await owner() })).includes(
        activeOrder,
      ),
    );
    assert.ok((await listed('cancelled', search)).includes(activeOrder));
    assert.ok((await listed('all')).includes(activeOrder));
    assert.ok((await repository.findById(activeOrder))?.cancelledAt);
    // A cancelled pending order is not the conversation's pending order.
    assert.equal(
      await repository.findPendingByConversation(conversation.conversationId),
      null,
    );
  });
}
