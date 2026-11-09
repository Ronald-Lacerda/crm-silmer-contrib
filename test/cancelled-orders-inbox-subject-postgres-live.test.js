import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { createOperationReadService } from '../apps/api/src/operation-runtime.js';
import {
  PostgresContactIdentityRepository,
  PostgresContactReadRepository,
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
  createSubjectService,
} from '../modules/inbox-channels/src/index.js';
import { PostgresOrderAssistanceRepository } from '../modules/inbox-channels/src/adapters/postgres-order-assistance.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { PostgresHandoffReadRepository } from '../modules/work-management/src/index.js';

/**
 * OLIST-19/45/46, ADR 068: a locally cancelled order (`crm.orders.cancelled_at`)
 * keeps `status = 'pendente'` but is not a pending order for the Inbox: no
 * "Pedido pronto" chip, no pending-order closure prompt, no pending subject
 * and no pending-order assistance block. The history stays readable by id.
 */
const connectionString = process.env.TEST_DATABASE_URL;
/** Sunday 08/11/2026 12:00 in São Paulo. */
const NOW = new Date('2026-11-08T15:00:00.000Z');
const LATER = new Date(NOW.getTime() + 30 * 60_000);
const ENVELOPE_KEY = Buffer.alloc(32, 141);
const SELLER = Object.freeze({
  functionName: 'Vendedor',
  id: 'seller-cancelled-inbox',
  kind: 'human',
});

if (!connectionString) {
  test(
    'cancelled orders in the Inbox and subject service require TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  test('cancelled orders are not pending in the Inbox, subjects or assistance, and stay readable by id', async (t) => {
    assert.match(
      new URL(connectionString).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });

    const runId = randomUUID().replaceAll('-', '').slice(0, 12);
    const contactKey = Buffer.alloc(32, 142);
    const messageKey = Buffer.alloc(32, 143);
    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: contactKey,
        lookupKey: Buffer.alloc(32, 144),
      }),
    });
    const inbox = createInboxService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: messageKey,
        outboundMessageOutbox: { enqueueChannelMessage: async () => undefined },
      }),
    });
    const reads = createOperationReadService({
      clock: () => LATER,
      contactRepository: new PostgresContactReadRepository({
        database,
        envelopeKey: contactKey,
        lookupKey: Buffer.alloc(32, 144),
      }),
      cursorKey: Buffer.alloc(32, 145),
      handoffRepository: new PostgresHandoffReadRepository({
        contactEnvelopeKey: contactKey,
        database,
        handoffEnvelopeKey: Buffer.alloc(32, 146),
        n8nEnvelopeKey: Buffer.alloc(32, 147),
      }),
      inboxRepository: new PostgresInboxReadRepository({
        contactEnvelopeKey: contactKey,
        database,
        messageEnvelopeKey: messageKey,
      }),
      stallMinutes: 5,
    });
    const subjects = createSubjectService(database);
    const assistance = new PostgresOrderAssistanceRepository({
      createPending: async () => undefined,
      database,
      envelopeKey: ENVELOPE_KEY,
    });

    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name)
       VALUES ($1, $2, '$argon2id$synthetic', 'Vendedora Sintética')`,
      [SELLER.id, `${SELLER.id}@example.test`],
    );
    await pool.query(
      `INSERT INTO crm.user_functions (user_id, function_name)
       VALUES ($1, $2)`,
      [SELLER.id, SELLER.functionName],
    );

    /** A conversation taken over by the seller, with one customer message.
     * @param {string} label */
    async function conversation(label) {
      const identity = await contacts.resolveInboundIdentity({
        channel: 'instagram',
        correlationId: `identity-${runId}-${label}`,
        displayHandle: `@cancelled_${label.replaceAll('-', '_')}`,
        externalIdentityId: `identity-${runId}-${label}`,
        identityKind: 'handle',
        occurredAt: NOW.toISOString(),
        phoneStatus: 'pending',
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const received = await inbox.receiveInbound({
        contactId: identity.contact.id,
        correlationId: `inbound-${runId}-${label}`,
        externalConversationId: `external-${runId}-${label}`,
        externalMessageId: `message-${runId}-${label}`,
        identityId: identity.identity.id,
        message: { content: { text: 'Mensagem sintética' }, type: 'text' },
        occurredAt: NOW.toISOString(),
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const owned = await inbox.takeover({
        actor: SELLER,
        conversationId: received.conversation.id,
        correlationId: `takeover-${runId}-${label}`,
        expectedVersion: received.conversation.version,
        idempotencyKey: `takeover-${runId}-${label}`,
        reason: 'Atendimento sintético',
      });
      return {
        contactId: /** @type {string} */ (identity.contact.id),
        id: /** @type {string} */ (received.conversation.id),
        version: /** @type {number} */ (owned.version),
      };
    }
    let counter = 0;
    /** A pending order ready for review, on the conversation (or manual).
     * @param {{conversationId: string|null, contactId: string, createdAt?: Date}} where */
    async function order({ conversationId, contactId, createdAt = NOW }) {
      const id = `order-${runId}-${(counter += 1)}`;
      await pool.query(
        `WITH numbered AS (SELECT nextval('crm.order_number_seq') AS sequence)
         INSERT INTO crm.orders
           (id, number_sequence, number, conversation_id, contact_id,
            manual_owner_id, manual_create_key, status, fab_code,
            ficha_envelope, created_by_kind, created_by, created_at, updated_at,
            total_pieces, missing_fields, final_amount_cents, payment_condition)
         SELECT $1, numbered.sequence,
                lpad(numbered.sequence::text, 2, '0') || '-CRM', $2, $3,
                CASE WHEN $2::text IS NULL THEN $4 END,
                CASE WHEN $2::text IS NULL THEN $5 END,
                'pendente', '01', '{}'::jsonb, 'user', $4, $6, $6,
                20, '{}', 100000, 'pix'
         FROM numbered`,
        [id, conversationId, contactId, SELLER.id, `manual-${id}`, createdAt],
      );
      return id;
    }
    /** @param {string} orderId */
    const cancel = (orderId) =>
      pool.query(
        `UPDATE crm.orders
         SET cancelled_at = $2, cancelled_by = $3,
             cancellation_reason_envelope = $4::jsonb,
             version = version + 1, updated_at = $2
         WHERE id = $1`,
        [
          orderId,
          NOW,
          SELLER.id,
          JSON.stringify(
            encryptJson(
              'Motivo sintético',
              `order-cancellation:${orderId}`,
              ENVELOPE_KEY,
            ),
          ),
        ],
      );
    /** @param {string} conversationId @param {string|null} orderId @param {string} key */
    const link = (conversationId, orderId, key) =>
      subjects.create({
        actor: SELLER,
        conversationId,
        correlationId: `correlation-${key}`,
        idempotencyKey: `${key}-${runId}`,
        orderId,
      });
    /** @param {Record<string, any>} query */
    const list = (query) =>
      reads.listInbox(
        { limit: 50, owner: 'all', ...query },
        {
          actorId: SELLER.id,
        },
      );
    /** @param {string} id */
    const orderRow = async (id) =>
      (
        await pool.query(
          'SELECT status, cancelled_at FROM crm.orders WHERE id = $1',
          [id],
        )
      ).rows[0];

    // One ready order per conversation: live, or cancelled after it was ready.
    const live = await conversation('live');
    const cancelled = await conversation('cancelled');
    const liveOrder = await order({
      contactId: live.contactId,
      conversationId: live.id,
    });
    const cancelledOrder = await order({
      contactId: cancelled.contactId,
      conversationId: cancelled.id,
    });
    const readyIds = async () =>
      (await list({ bucket: 'respond', orderReady: true })).items.map(
        (/** @type {any} */ item) => item.id,
      );
    assert.deepEqual((await readyIds()).sort(), [cancelled.id, live.id].sort());
    await cancel(cancelledOrder);

    await t.test(
      'the Responder tab chip and the conversation header ignore a cancelled order',
      async () => {
        assert.deepEqual(await readyIds(), [live.id]);
        const respond = (await list({ bucket: 'respond' })).items;
        const byId = new Map(
          respond.map((/** @type {any} */ item) => [item.id, item]),
        );
        assert.equal(byId.get(live.id).hasPendingOrder, true);
        assert.equal(byId.get(live.id).order.id, liveOrder);
        assert.equal(byId.get(live.id).reviewOrder.id, liveOrder);
        // The conversation is still listed, just without the order.
        assert.equal(byId.get(cancelled.id).hasPendingOrder, false);
        assert.equal(byId.get(cancelled.id).order, null);
        assert.equal(byId.get(cancelled.id).reviewOrder, null);
        const detail = await reads.getConversation(
          { conversationId: cancelled.id },
          { actorId: SELLER.id },
        );
        assert.equal(detail.conversation.id, cancelled.id);
        assert.equal(
          (
            await reads.countInboxBuckets(
              { owner: 'all', orderReady: true },
              { actorId: SELLER.id },
            )
          ).respond,
          1,
        );
        // The order itself is not lost: it reads by id, still `pendente`.
        const kept = await orderRow(cancelledOrder);
        assert.equal(kept.status, 'pendente');
        assert.ok(kept.cancelled_at);
      },
    );

    await t.test(
      "the seller's pending-order count leaves out a cancelled order",
      async () => {
        const summary = await reads.summarizeInbox({ actorId: SELLER.id });
        assert.equal(summary.mine.pendingOrderCount, 1);
      },
    );

    await t.test(
      'assistance sees a pending order only while it is live, directly or by subject',
      async () => {
        /** @param {string} conversationId */
        const pending = (conversationId) =>
          database.transaction((/** @type {any} */ tx) =>
            assistance.pending(tx, conversationId),
          );
        assert.equal(await pending(live.id), true);
        assert.equal(await pending(cancelled.id), false);
        // A manual order linked by a subject follows the same rule.
        const viaSubject = await conversation('via-subject');
        const manual = await order({
          contactId: viaSubject.contactId,
          conversationId: null,
        });
        await link(viaSubject.id, manual, 'assist-subject');
        assert.equal(await pending(viaSubject.id), true);
        await cancel(manual);
        assert.equal(await pending(viaSubject.id), false);
        assert.equal((await orderRow(manual)).status, 'pendente');
      },
    );

    await t.test(
      'closing needs no pending-order acknowledgement for a cancelled order, directly or by subject',
      async () => {
        /** @param {{id: string, version: number}} target @param {string} key */
        const close = (target, key) => ({
          acknowledgePending: false,
          actor: SELLER,
          conversationId: target.id,
          correlationId: `correlation-${key}`,
          expectedVersion: target.version,
          idempotencyKey: `${key}-${runId}`,
          outcome: 'concluido',
          reason: 'Encerramento sintético',
        });
        await assert.rejects(
          inbox.closeConversation(close(live, 'close-live')),
          /Pending order requires acknowledgement/u,
        );
        await inbox.closeConversation(close(cancelled, 'close-cancelled'));
        const linkedLive = await conversation('linked-live');
        const linkedCancelled = await conversation('linked-cancelled');
        const liveManual = await order({
          contactId: linkedLive.contactId,
          conversationId: null,
        });
        const cancelledManual = await order({
          contactId: linkedCancelled.contactId,
          conversationId: null,
        });
        await link(linkedLive.id, liveManual, 'close-live-subject');
        await link(
          linkedCancelled.id,
          cancelledManual,
          'close-cancelled-subject',
        );
        await cancel(cancelledManual);
        const current = async (/** @type {string} */ id) => ({
          id,
          version: Number(
            (
              await pool.query(
                'SELECT version FROM crm.conversations WHERE id = $1',
                [id],
              )
            ).rows[0].version,
          ),
        });
        await assert.rejects(
          inbox.closeConversation(
            close(await current(linkedLive.id), 'close-linked-live'),
          ),
          /Pending order requires acknowledgement/u,
        );
        await inbox.closeConversation(
          close(await current(linkedCancelled.id), 'close-linked-cancelled'),
        );
      },
    );

    await t.test(
      'subjects show a cancelled order as cancelled, link it by id and rank it after live orders',
      async () => {
        const target = await conversation('subjects');
        // The cancelled order is the newest, so only the ranking can put the
        // live one first.
        const liveManual = await order({
          contactId: target.contactId,
          conversationId: null,
          createdAt: new Date(NOW.getTime() - 3_600_000),
        });
        const cancelledManual = await order({
          contactId: target.contactId,
          conversationId: null,
          createdAt: NOW,
        });
        await cancel(cancelledManual);
        const picker = await subjects.list(target.id);
        assert.deepEqual(
          picker.orders.map((/** @type {any} */ row) => row.id),
          [liveManual, cancelledManual],
        );
        const first = await link(target.id, liveManual, 'subject-live');
        assert.equal(first.subject.orderStatus, 'pendente');
        // Linking by id is history, not a pending order.
        const second = await link(
          target.id,
          cancelledManual,
          'subject-cancelled',
        );
        assert.equal(second.subject.orderStatus, 'cancelado');
        assert.equal(second.subject.kind, 'pedido');
        assert.equal(second.subject.orderId, cancelledManual);
        const listed = await subjects.list(target.id);
        assert.deepEqual(
          listed.subjects.map((/** @type {any} */ row) => [
            row.orderId,
            row.orderStatus,
          ]),
          [
            [liveManual, 'pendente'],
            [cancelledManual, 'cancelado'],
          ],
        );
        assert.ok(
          listed.subjects.every(
            (/** @type {any} */ row) => typeof row.orderNumber === 'string',
          ),
        );
        // The raw status is untouched: only the subject payload says it.
        assert.equal((await orderRow(cancelledManual)).status, 'pendente');
      },
    );
  });
}
