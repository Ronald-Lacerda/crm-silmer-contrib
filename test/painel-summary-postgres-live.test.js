import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { createOperationReadService } from '../apps/api/src/operation-runtime.js';
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
  PostgresInboxReadRepository,
  PostgresInboxRepository,
  createInboxService,
} from '../modules/inbox-channels/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { PostgresOrderConversationPort } from '../modules/orders/src/adapters/postgres-order-conversation-port.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';

const connectionString = process.env.TEST_DATABASE_URL;
// Messages arrive around noon UTC; the Painel reads the database half an
// hour later (09:30 in São Paulo).
const NOW = new Date('2026-09-08T12:00:00.000Z');
const READ_AT = new Date('2026-09-08T12:30:00.000Z');
const CONTACT_KEY = Buffer.alloc(32, 71);
const MESSAGE_KEY = Buffer.alloc(32, 72);
const ORDER_KEY = Buffer.alloc(32, 73);

if (connectionString) {
  test('Painel: the Inbox and order summaries count from PostgreSQL on the server clock', async () => {
    assert.match(
      new URL(connectionString).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 6 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 74),
      }),
    });
    const inbox = createInboxService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: MESSAGE_KEY,
        outboundMessageOutbox: {
          enqueueChannelMessage: async () => undefined,
        },
      }),
    });
    const reads = createOperationReadService({
      clock: () => READ_AT,
      // The repository rule under a 10-minute window, as before.
      stallMinutes: 10,
      contactRepository: {},
      cursorKey: Buffer.alloc(32, 75),
      handoffRepository: {},
      inboxRepository: new PostgresInboxReadRepository({
        contactEnvelopeKey: CONTACT_KEY,
        database,
        messageEnvelopeKey: MESSAGE_KEY,
      }),
    });
    const orderRepository = new PostgresOrderRepository({
      database,
      envelopeKey: ORDER_KEY,
    });
    const conversationPort = new PostgresOrderConversationPort({
      contactEnvelopeKey: CONTACT_KEY,
      contactLookupKey: Buffer.alloc(32, 74),
      database,
      envelopeKey: ORDER_KEY,
    });
    const orders = createOrderService({
      authorizeOwnership: async () => undefined,
      clock: () => READ_AT,
      conversations: {
        listAssignedOrderConversationIds: (/** @type {string} */ userId) =>
          conversationPort.listAssignedOrderConversationIds(userId),
        readOrderContexts: async () => new Map(),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository: orderRepository,
    });
    const runId = randomUUID().replaceAll('-', '').slice(0, 12);
    const sellerId = `seller-painel-${runId}`;
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await pool.query(
        `INSERT INTO crm.users (id, email, password_hash, name)
         VALUES ($1, $2, '$argon2id$synthetic', 'Vendedora Painel')`,
        [sellerId, `${sellerId}@example.test`],
      );
      await pool.query(
        `INSERT INTO crm.user_functions (user_id, function_name)
         VALUES ($1, 'Vendedor')`,
        [sellerId],
      );

      /** @param {string} suffix @param {string} occurredAt */
      const open = async (suffix, occurredAt) => {
        const resolved = await contacts.resolveInboundIdentity({
          channel: 'instagram',
          correlationId: `correlation-${suffix}-${runId}`,
          displayHandle: `@${suffix}_${runId.slice(0, 6)}`,
          externalIdentityId: `identity-${suffix}-${runId}`,
          identityKind: 'handle',
          occurredAt: NOW.toISOString(),
          phoneStatus: 'pending',
          provider: 'meta',
          providerAccountId: `account-${suffix}-${runId}`,
        });
        const received = await inbox.receiveInbound({
          contactId: resolved.contact.id,
          correlationId: `correlation-message-${suffix}-${runId}`,
          externalConversationId: `conversation-${suffix}-${runId}`,
          externalMessageId: `message-${suffix}-${runId}`,
          identityId: resolved.identity.id,
          message: { content: { text: `Mensagem ${suffix}` }, type: 'text' },
          occurredAt,
          provider: 'meta',
          providerAccountId: `account-${suffix}-${runId}`,
        });
        return /** @type {string} */ (received.conversation.id);
      };
      /** @param {string} conversationId */
      const assignToSeller = (conversationId) =>
        pool.query(
          `UPDATE crm.conversations
           SET assigned_user_id = $2, automation_state = 'human'
           WHERE id = $1`,
          [conversationId, sellerId],
        );
      /** @param {string} conversationId @param {string} createdAt */
      const pendingHandoff = (conversationId, createdAt) =>
        pool.query(
          `INSERT INTO crm.handoffs
             (id, conversation_id, assigned_user_id, status, version,
              reason_code, summary_envelope, due_at, sla_minutes,
              sla_policy_version, created_at, updated_at, target_role)
           VALUES ($1, $2, NULL, 'pending', 1, 'price_before_quote',
                   '{"algorithm":"AES-256-GCM","version":"1"}'::jsonb,
                   $3::timestamptz + interval '30 minutes', 30, 'v1', $3, $3,
                   'Vendedor')`,
          [`handoff-${randomUUID()}`, conversationId, createdAt],
        );

      // The assistant left one client message unanswered for 30 minutes
      // and has a fresh one from 5 minutes ago.
      const stalled = await open('stalled', '2026-09-08T12:00:00.000Z');
      await open('fresh', '2026-09-08T12:25:00.000Z');
      // Two handoffs wait for a seller; the older one is past its SLA.
      const lateHandoff = await open('late', '2026-09-08T11:30:00.000Z');
      await pendingHandoff(lateHandoff, '2026-09-08T11:30:00.000Z');
      const newHandoff = await open('newhandoff', '2026-09-08T12:20:00.000Z');
      await pendingHandoff(newHandoff, '2026-09-08T12:20:00.000Z');
      // The seller owns three open conversations: one ends on the client.
      const awaiting = await open('awaiting', '2026-09-08T12:10:00.000Z');
      await assignToSeller(awaiting);
      const answered = await open('answered', '2026-09-08T11:50:00.000Z');
      await assignToSeller(answered);
      const { version } = (
        await pool.query('SELECT version FROM crm.conversations WHERE id=$1', [
          answered,
        ])
      ).rows[0];
      const sent = await inbox.sendHumanMessage({
        actor: {
          capabilities: [],
          functionName: 'Vendedor',
          id: sellerId,
          kind: 'human',
        },
        content: { text: 'Já te respondo com o orçamento.' },
        conversationId: answered,
        correlationId: `correlation-reply-${runId}`,
        expectedVersion: Number(version),
        idempotencyKey: `reply-${runId}`,
        messageType: 'text',
        reason: 'Synthetic reply',
      });
      // ...whose send then failed: it counts in the assistant's health.
      await pool.query(
        `UPDATE crm.messages SET status = 'failed' WHERE id = $1`,
        [sent.id],
      );
      // An archived conversation is out of every queue.
      const archived = await open('archived', '2026-09-08T11:00:00.000Z');
      await assignToSeller(archived);
      await pool.query(
        `UPDATE crm.conversations SET archived_at = $2 WHERE id = $1`,
        [archived, NOW],
      );

      const inboxSummary = await reads.summarizeInbox({ actorId: sellerId });
      assert.deepEqual(inboxSummary, {
        assistant: {
          activeCount: 2,
          failedDeliveryCount: 1,
          lastReplyAt: null,
          stalledCount: 1,
          stallMinutes: 10,
        },
        generatedAt: READ_AT.toISOString(),
        mine: {
          awaitingReplyCount: 1,
          count: 2,
          oldestAwaitingSince: '2026-09-08T12:10:00.000Z',
          pendingOrderCount: 0,
        },
        waitingHandoff: {
          count: 2,
          oldestSince: '2026-09-08T11:30:00.000Z',
          overdueCount: 1,
        },
      });
      // Another reader has an empty queue of their own.
      assert.equal(
        (await reads.summarizeInbox({ actorId: `other-${runId}` })).mine.count,
        0,
      );
      assert.ok(stalled);

      /**
       * @param {{conversationId: string, status?: 'pendente'|'confirmado',
       *   promised?: string|null, orderDate?: string|null,
       *   deliveredOn?: string|null, amountCents?: number}} input
       */
      const insertOrder = async ({
        amountCents = 50_000,
        conversationId,
        deliveredOn = null,
        orderDate = '2026-09-08',
        promised = null,
        status = 'confirmado',
      }) => {
        const id = `order-${randomUUID()}`;
        const confirmed = status === 'confirmado';
        const ficha = {
          artwork: {},
          items: [],
          observations: [],
          summary: {
            cliente: '',
            data_entrega_confirmada: promised,
            nome: null,
          },
        };
        await pool.query(
          `WITH number AS (SELECT nextval('crm.order_number_seq') AS sequence)
           INSERT INTO crm.orders
             (id, number_sequence, number, conversation_id, contact_id,
              status, fab_code, ficha_envelope, final_amount_cents,
              payment_condition, order_date, confirmed_at, confirmed_by,
              created_by_kind, created_at, updated_at, delivered_on)
           SELECT $1, number.sequence,
                  lpad(number.sequence::text, 2, '0') || '-CRM', $2,
                  identity.current_contact_id, $3, '01', $4::jsonb, $5, $6,
                  $7::date, $8, $9, 'automation', $10, $10, $11::date
           FROM number, crm.conversations conversation
           JOIN crm.contact_identities identity
             ON identity.id = conversation.contact_identity_id
           WHERE conversation.id = $2`,
          [
            id,
            conversationId,
            status,
            JSON.stringify(encryptJson(ficha, `order-ficha:${id}`, ORDER_KEY)),
            confirmed ? amountCents : null,
            confirmed ? 'pix' : null,
            confirmed ? orderDate : null,
            confirmed ? NOW : null,
            confirmed ? sellerId : null,
            NOW,
            deliveredOn,
          ],
        );
        return id;
      };
      // Today in São Paulo is 08/09/2026.
      const lateOrder = await insertOrder({
        conversationId: stalled,
        promised: '2026-09-05',
      });
      const lateToday = await insertOrder({
        conversationId: stalled,
        orderDate: '2026-09-02',
        promised: '2026-09-07',
      });
      const dueToday = await insertOrder({
        amountCents: 30_000,
        conversationId: awaiting,
        promised: '2026-09-08',
      });
      // A week ahead is the last day "this week" still covers.
      await insertOrder({
        conversationId: awaiting,
        orderDate: '2026-08-30',
        promised: '2026-09-14',
      });
      await insertOrder({
        conversationId: answered,
        orderDate: '2026-08-20',
        promised: '2026-09-15',
      });
      // Delivered, even if late, is no longer late.
      await insertOrder({
        conversationId: answered,
        deliveredOn: '2026-09-04',
        orderDate: '2026-08-10',
        promised: '2026-09-01',
      });
      // No promised day yet: neither late nor upcoming.
      await insertOrder({ conversationId: answered, orderDate: '2026-09-01' });
      // A pending order is never a sale nor a delivery to track.
      await insertOrder({
        conversationId: lateHandoff,
        promised: '2026-09-01',
        status: 'pendente',
      });

      const today = await orders.summary();
      assert.equal(today.today, '2026-09-08');
      assert.deepEqual(today.period, {
        confirmedCount: 2,
        from: '2026-09-08',
        key: 'hoje',
        soldAmountCents: 80_000,
        timeZone: 'America/Sao_Paulo',
        to: '2026-09-08',
      });
      assert.deepEqual(today.deliveries, {
        dueSoonCount: 2,
        dueSoonUntil: '2026-09-14',
        oldestOverdueOn: '2026-09-05',
        overdueCount: 2,
      });
      assert.equal(today.confirmedCount, 7);
      assert.equal(today.pendingCount, 1);
      const week = await orders.summary({ period: '7dias' });
      assert.equal(week.period.from, '2026-09-02');
      assert.equal(week.period.confirmedCount, 3);
      const month = await orders.summary({ period: 'mes' });
      assert.equal(month.period.from, '2026-09-01');
      // 01/09 counts in the month, not in the last seven days.
      assert.equal(month.period.confirmedCount, 4);

      const overdue = await orders.list({ delivery: 'overdue' });
      assert.deepEqual(
        overdue.items.map((order) => order.id),
        [lateOrder, lateToday],
      );
      const upcoming = await orders.list({ delivery: 'due_soon' });
      assert.equal(upcoming.items[0].id, dueToday);
      assert.equal(upcoming.counts.confirmado, 2);

      // "Meus pedidos pendentes": the seller's conversation has one; the
      // pending order of an unassigned handoff is nobody's yet.
      const myPending = await insertOrder({
        conversationId: awaiting,
        status: 'pendente',
      });
      assert.equal(
        (await reads.summarizeInbox({ actorId: sellerId })).mine
          .pendingOrderCount,
        1,
      );
      const mine = await orders.list({ ownerId: sellerId, status: 'pendente' });
      assert.deepEqual(
        mine.items.map((order) => order.id),
        [myPending],
      );
      assert.deepEqual(mine.counts, { confirmado: 5, pendente: 1 });
    } finally {
      await pool.end();
    }
  });
}
