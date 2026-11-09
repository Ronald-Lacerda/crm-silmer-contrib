import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  PostgresN8nIntegrationRepository,
  createN8nIntegrationService,
} from '../modules/n8n-integration/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import {
  PostgresOrderConversationPort,
  PostgresOrderRepository,
  createOrderService,
} from '../modules/orders/src/index.js';

/**
 * OLIST-19/45/46, ADR 068: a locally cancelled order (`crm.orders.cancelled_at`)
 * keeps its commercial `status = 'pendente'`, but it is no longer a pending
 * order for the n8n agent. It is not a previous purchase, an explicit target,
 * an order to open a subject on, or a pending subject in the payload; the
 * order itself stays readable by id.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-08T15:00:00.000Z');
const SELLER_ID = 'seller-cancelled-n8n';

if (!connectionString) {
  test(
    'cancelled orders in the n8n repository require TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  test('cancelled orders are not pending for the n8n agent and stay readable by id', async () => {
    assert.match(
      new URL(connectionString).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9_]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 6 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    const envelopeKey = Buffer.alloc(32, 131);
    const contactEnvelopeKey = Buffer.alloc(32, 132);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 133),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    let sequence = 0;
    /** @param {any} ordersPort */
    const serviceWith = (ordersPort) =>
      createN8nIntegrationService({
        clock: () => NOW,
        idFactory: (kind) => `${kind}-cancelled-${++sequence}`,
        repository: new PostgresN8nIntegrationRepository({
          contactEnvelopeKey,
          contactLookupKey: Buffer.alloc(32, 133),
          database,
          envelopeKey,
          messageEnvelopeKey: Buffer.alloc(32, 134),
          orders: ordersPort,
        }),
      });
    const service = serviceWith(orders);
    /** @param {string} id @param {string} [workflowVersion] */
    const technical = (id, workflowVersion = 'mvp-simple-15') => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${id}`,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: `request-${id}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion,
    });
    /** @param {string} phone @param {number} turn */
    const inbound = (phone, turn) =>
      service.receiveInbound({
        channel: 'whatsapp',
        contact: { wa_id: phone },
        event_id: `wamid.cancelled.${phone}.${turn}`,
        message: {
          external_id: `wamid.cancelled.${phone}.${turn}`,
          text: `Mensagem sintética ${turn}`,
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-cancelled' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical(`inbound-cancelled-${phone}-${turn}`),
      });
    /** @param {any} context @param {string} id @param {Record<string, unknown>} [extra] @returns {any} */
    const send = (context, id, extra = {}) => ({
      automation_epoch: context.automation_epoch,
      command_id: `${context.conversation_id}:${context.source_revision}:ai-response`,
      conversation_id: context.conversation_id,
      event_id: `send-cancelled-${id}`,
      event_type: 'message.send.requested',
      message: { type: 'text', text: 'Qual a cor?' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      source_revision: context.source_revision,
      target_contract: 'subject-v1',
      technical: technical(`send-cancelled-${id}`),
      ...extra,
    });
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
          SELLER_ID,
          JSON.stringify(
            encryptJson(
              'Motivo sintético',
              `order-cancellation:${orderId}`,
              envelopeKey,
            ),
          ),
        ],
      );
    /** @param {string} id @param {string} conversationId @param {string} contactId @param {string} orderId @param {number} position @param {boolean} current */
    const insertSubject = (
      id,
      conversationId,
      contactId,
      orderId,
      position,
      current,
    ) =>
      pool.query(
        `INSERT INTO crm.conversation_subjects
           (id, conversation_id, contact_id, order_id, kind, position,
            is_current, selected_source, selected_by, selected_at,
            created_by, created_by_kind, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pedido', $5, $6,
                 CASE WHEN $6 THEN 'human' END,
                 CASE WHEN $6 THEN $8 END,
                 CASE WHEN $6 THEN $7::timestamptz END,
                 $8, 'human', $7, $7)`,
        [
          id,
          conversationId,
          contactId,
          orderId,
          position,
          current,
          NOW,
          SELLER_ID,
        ],
      );
    /** @param {string} conversationId @param {number} revision @param {string} subjectId */
    const linkInbound = async (conversationId, revision, subjectId) => {
      await pool.query(
        `INSERT INTO crm.message_subject_links
           (message_id, subject_id, conversation_id, assigned_by,
            assigned_by_kind, assigned_at)
         SELECT id, $3, $1, $5, 'human', $4 FROM crm.messages
         WHERE conversation_id = $1 AND direction = 'inbound'
           AND inbound_revision = $2
         ON CONFLICT DO NOTHING`,
        [conversationId, revision, subjectId, NOW, SELLER_ID],
      );
    };
    /** @param {string} orderId */
    const byId = async (orderId) =>
      (
        await pool.query(
          `SELECT status, cancelled_at, version FROM crm.orders WHERE id = $1`,
          [orderId],
        )
      ).rows[0];
    /** @param {string} conversationId */
    const subjectOrders = async (conversationId) =>
      (
        await pool.query(
          `SELECT order_id FROM crm.conversation_subjects
           WHERE conversation_id = $1 ORDER BY position`,
          [conversationId],
        )
      ).rows.map((/** @type {any} */ row) => row.order_id);
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await pool.query(
        `INSERT INTO crm.users (id, email, password_hash, name)
         VALUES ($1, 'seller-cancelled-n8n@example.test', '$argon2id$synthetic',
                 'Vendedora Sintética')`,
        [SELLER_ID],
      );

      const a = await inbound('5527900000401', 1);
      const names = ['b', 'c', 'd', 'f', 'g', 'h', 'i'];
      /** @type {Record<string, string>} */
      const phones = {};
      /** @type {Record<string, any>} */
      const rest = {};
      for (const [index, name] of names.entries()) {
        phones[name] = `552790000041${index}`;
        rest[name] = await inbound(phones[name], 1);
      }
      await pool.query(
        `UPDATE crm.contact_identities SET current_contact_id = $1
         WHERE id IN (SELECT contact_identity_id FROM crm.conversations
                      WHERE id = ANY($2::text[]))`,
        [a.contact_id, names.map((name) => rest[name].conversation_id)],
      );
      /** @param {string} conversationId */
      const open = async (conversationId) =>
        (
          await orders.ensurePendingFromIntent({
            conversationId,
            correlationId: `open-${conversationId}`,
          })
        ).order;
      const orderB = await open(rest.b.conversation_id);
      const orderC = await open(rest.c.conversation_id);

      // previous_orders_count: a cancelled order is not an earlier purchase.
      assert.equal(
        (await inbound('5527900000401', 2)).contact_context
          .previous_orders_count,
        2,
      );
      await cancel(orderC.id);
      assert.equal(
        (await inbound('5527900000401', 3)).contact_context
          .previous_orders_count,
        1,
      );
      // The cancelled order is still there by id, with its commercial status.
      const kept = await byId(orderC.id);
      assert.equal(kept.status, 'pendente');
      assert.ok(kept.cancelled_at);
      assert.equal((await orders.get(orderC.id)).id, orderC.id);

      // The subject payload keeps the link and the number, but the cancelled
      // order is no longer `pendente` for the workflow.
      await insertSubject(
        'subject-d-b',
        rest.d.conversation_id,
        a.contact_id,
        orderB.id,
        1,
        true,
      );
      await insertSubject(
        'subject-d-c',
        rest.d.conversation_id,
        a.contact_id,
        orderC.id,
        2,
        false,
      );
      const payload = (await inbound(phones.d, 2)).subjects;
      assert.deepEqual(
        payload.map((/** @type {any} */ subject) => [
          subject.subject_id,
          subject.order_number,
          subject.order_status,
        ]),
        [
          ['subject-d-b', orderB.number, 'pendente'],
          ['subject-d-c', orderC.number, 'cancelado'],
        ],
      );

      // An explicit target must be a live pending order of the contact.
      const dTurn = await inbound(phones.d, 3);
      await assert.rejects(
        service.recordEvent(
          send(dTurn, 'd-cancelled', {
            order_id: orderC.id,
            subject_id: 'subject-d-c',
          }),
        ),
        (error) =>
          /** @type {any} */ (error)?.code === 'SUBJECT_TARGET_INVALID',
      );
      const orderF = await open(rest.f.conversation_id);
      await insertSubject(
        'subject-f',
        rest.f.conversation_id,
        a.contact_id,
        orderF.id,
        1,
        true,
      );
      await linkInbound(rest.f.conversation_id, 1, 'subject-f');
      const control = await service.recordEvent(
        send(rest.f, 'f-active', {
          order_id: orderF.id,
          subject_id: 'subject-f',
        }),
      );
      assert.equal(control.send_authorized, true);
      await cancel(orderF.id);
      const afterCancel = await inbound(phones.f, 2);
      await assert.rejects(
        service.recordEvent(
          send(afterCancel, 'f-cancelled', {
            order_id: orderF.id,
            subject_id: 'subject-f',
          }),
        ),
        (error) =>
          /** @type {any} */ (error)?.code === 'SUBJECT_TARGET_INVALID',
      );

      // Without an explicit target the legacy workflow only knows the
      // conversation's live pending order: a cancelled one no longer is it.
      const orderG = await open(rest.g.conversation_id);
      await insertSubject(
        'subject-g',
        rest.g.conversation_id,
        a.contact_id,
        orderG.id,
        1,
        true,
      );
      /** @param {any} context @param {string} id @param {Record<string, unknown>} [extra] */
      const legacy = (context, id, extra = {}) => {
        const event = send(context, id, extra);
        delete event.target_contract;
        // The pre-subject workflow: no subject_id and a conversation briefing.
        event.technical = technical(`send-cancelled-${id}`, 'mvp-simple-11');
        return event;
      };
      const legacyActive = await service.recordEvent(
        legacy(rest.g, 'g-active', { briefing_patch: { quantity: 12 } }),
      );
      assert.equal(legacyActive.send_authorized, true);
      await cancel(orderG.id);
      const gAfter = await inbound(phones.g, 2);
      await assert.rejects(
        service.recordEvent(
          legacy(gAfter, 'g-cancelled', { briefing_patch: { quantity: 12 } }),
        ),
        (error) =>
          /** @type {any} */ (error)?.code === 'SUBJECT_TARGET_REQUIRED',
      );

      // Pairing a freshly opened order with a subject (a race with a human
      // cancellation between the two statements) refuses a cancelled order.
      /** @param {string} orderId */
      const racing = (orderId) =>
        serviceWith({
          async ensurePendingFromIntent() {
            return { created: false, order: { id: orderId } };
          },
          projectAgentBriefing: orders.projectAgentBriefing,
        });
      const opened = await racing(orderB.id).recordEvent(
        legacy(rest.h, 'h-active', { open_order: true }),
      );
      assert.deepEqual(
        { ...opened.order, subject_id: undefined },
        { created: false, id: orderB.id, opened: true, subject_id: undefined },
      );
      assert.deepEqual(await subjectOrders(rest.h.conversation_id), [
        orderB.id,
      ]);
      const originalError = console.error;
      console.error = () => {};
      let refused;
      try {
        refused = await racing(orderC.id).recordEvent(
          legacy(rest.i, 'i-cancelled', { open_order: true }),
        );
      } finally {
        console.error = originalError;
      }
      assert.equal(refused.send_authorized, true);
      assert.deepEqual(refused.order, {
        error: 'SUBJECT_TARGET_INVALID',
        opened: false,
      });
      assert.deepEqual(await subjectOrders(rest.i.conversation_id), []);

      // History stays consultable by id after every command above.
      for (const id of [orderC.id, orderF.id, orderG.id]) {
        const row = await byId(id);
        assert.equal(row.status, 'pendente');
        assert.ok(row.cancelled_at);
        assert.equal((await orders.get(id)).id, id);
      }
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
}
