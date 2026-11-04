import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';
import { contactPhoneHash } from '../modules/contacts/src/index.js';

import { createN8nApiRuntime } from '../apps/api/src/n8n-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  PostgresInboxReadRepository,
  createSubjectService,
} from '../modules/inbox-channels/src/index.js';
import {
  PostgresN8nIntegrationRepository,
  createN8nIntegrationService,
} from '../modules/n8n-integration/src/index.js';
import {
  PostgresOrderConversationPort,
  PostgresOrderRepository,
  createOrderService,
} from '../modules/orders/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-09-08T15:00:00.000Z');

/**
 * These suites drop and recreate the `crm` schema, so they only run on a
 * dedicated test database: `crm_silmer_test`, or a per-branch copy named
 * `crm_silmer_test_<suffix>` when several branches share one PostgreSQL.
 *
 * @param {string} url
 */
function assertTestDatabase(url) {
  assert.match(
    new URL(url).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9_]+)?$/u,
  );
}

if (connectionString) {
  test('OA-T03/PCX-05: fresh inbound restores an archived human conversation, while replay and failed inserts preserve its archive', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 4 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client:any)=>Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    const envelopeKey = Buffer.alloc(32, 71);
    const contactEnvelopeKey = Buffer.alloc(32, 72);
    const messageEnvelopeKey = Buffer.alloc(32, 74);
    let sequence = 0;
    const service = createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `archive-${kind}-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        database,
        envelopeKey,
        contactEnvelopeKey,
        messageEnvelopeKey,
        requireHumanOrderCreation: true,
      }),
    });
    /** @param {number} turn */
    const inbound = (turn) => ({
      channel: 'whatsapp',
      contact: { name: 'Synthetic archive test', wa_id: '5527900000444' },
      event_id: `archive-inbound-${turn}`,
      message: {
        external_id: `archive-inbound-${turn}`,
        text: 'Synthetic incoming message',
        type: 'text',
      },
      metadata: { phone_number_id: 'synthetic-archive-account' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      technical: {
        actor: 'AUTOMATION_EXECUTOR',
        correlationId: `archive-correlation-${turn}`,
        credentialVersion: 'current',
        executionId: `archive-execution-${turn}`,
        idempotencyKey: `archive-inbound-${turn}`,
        requestId: `archive-request-${turn}`,
        workflowKey: 'whatsapp-mvp',
        workflowVersion: 'mvp-simple-21',
      },
    });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await pool.query(
        `INSERT INTO crm.users (id,email,password_hash,name) VALUES ('archive-seller','archive-seller@example.test','$argon2id$synthetic','Synthetic seller')`,
      );
      const first = await service.receiveInbound(inbound(1));
      await pool.query(
        `UPDATE crm.conversations SET archived_at=$2,automation_state='human',state='em_atendimento',assigned_user_id='archive-seller',automation_epoch=5,version=version+1 WHERE id=$1`,
        [first.conversation_id, NOW],
      );
      const [fresh, replay] = await allValues([
        service.receiveInbound(inbound(2)),
        service.receiveInbound(inbound(2)),
      ]);
      assert.deepEqual([fresh.duplicate, replay.duplicate].sort(), [
        false,
        true,
      ]);
      assert.equal(fresh.conversation_id, first.conversation_id);
      const state = async () =>
        (
          await pool.query(
            `SELECT archived_at,automation_state,state,assigned_user_id,automation_epoch,inbound_revision,version FROM crm.conversations WHERE id=$1`,
            [first.conversation_id],
          )
        ).rows[0];
      const restored = await state();
      assert.equal(restored.archived_at, null);
      assert.equal(restored.automation_state, 'human');
      assert.equal(restored.state, 'em_atendimento');
      assert.equal(restored.assigned_user_id, 'archive-seller');
      assert.equal(Number(restored.automation_epoch), 5);
      assert.equal(Number(restored.inbound_revision), 2);
      const inbox = new PostgresInboxReadRepository({
        database,
        contactEnvelopeKey,
        messageEnvelopeKey,
      });
      assert.ok(
        (await inbox.list({ archived: false, limit: 50 })).items.some(
          (/** @type {any} */ row) => row.id === first.conversation_id,
        ),
      );
      assert.equal(
        (await inbox.list({ archived: true, limit: 50 })).items.length,
        0,
      );

      // A seller may archive again after this message. Old receipts must not undo it.
      await pool.query(
        'UPDATE crm.conversations SET archived_at=$2,version=version+1 WHERE id=$1',
        [first.conversation_id, NOW],
      );
      const archived = await state();
      assert.equal((await service.receiveInbound(inbound(2))).duplicate, true);
      assert.deepEqual(await state(), archived);

      // Another delivery key reaches the UPDATE but fails the message identity constraint.
      // The complete transaction, including restoring visibility, must roll back.
      const duplicateIdentity = inbound(2);
      duplicateIdentity.technical = {
        ...duplicateIdentity.technical,
        idempotencyKey: 'archive-different-delivery-key',
      };
      await assert.rejects(service.receiveInbound(duplicateIdentity));
      assert.deepEqual(await state(), archived);
      assert.ok(
        (await inbox.list({ archived: true, limit: 50 })).items.some(
          (/** @type {any} */ row) => row.id === first.conversation_id,
        ),
      );
      const counts = (
        await pool.query(
          `SELECT (SELECT count(*)::integer FROM crm.messages) AS messages,(SELECT count(*)::integer FROM crm.n8n_events WHERE event_type='message.inbound') AS receipts,(SELECT count(*)::integer FROM crm.domain_events WHERE event_type='conversation.message_received') AS events,(SELECT count(*)::integer FROM crm.orders) AS orders`,
        )
      ).rows[0];
      assert.deepEqual(counts, {
        messages: 2,
        receipts: 2,
        events: 2,
        orders: 0,
      });
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL folds revision fencing, briefing and delivery into the MVP model', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 12 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    let sequence = 0;
    const contactEnvelopeKey = Buffer.alloc(32, 72);
    const envelopeKey = Buffer.alloc(32, 71);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    let currentTime = NOW;
    const service = createN8nIntegrationService({
      clock: () => currentTime,
      idFactory: (kind) => `${kind}-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
        messageEnvelopeKey: Buffer.alloc(32, 74),
        orders,
      }),
    });
    /** @param {string} executionId @param {string} idempotencyKey */
    const technical = (executionId, idempotencyKey) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${executionId}`,
      credentialVersion: 'current',
      executionId,
      idempotencyKey,
      requestId: `request-${executionId}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion: 'mvp-simple-1',
    });

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      const inbound = {
        channel: 'whatsapp',
        contact: { name: 'Synthetic', wa_id: '5527999999999' },
        event_id: 'wamid.inbound.1',
        message: {
          external_id: 'wamid.inbound.1',
          text: 'Quero trinta camisas',
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-account-1' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical('inbound-1', 'wamid.inbound.1'),
      };
      const [first, replay] = await allValues([
        service.receiveInbound(inbound),
        service.receiveInbound(inbound),
      ]);
      assert.equal(first.conversation_id, replay.conversation_id);
      assert.equal(first.source_revision, 1);
      assert.deepEqual([first.duplicate, replay.duplicate].sort(), [
        false,
        true,
      ]);

      // The Inbox goes live off crm.domain_events. This integration owns its
      // own persistence path, so an inbound message that lands here without an
      // event leaves every open panel silently stale.
      const inboundStream = await pool.query(
        `SELECT event_type FROM crm.domain_events
         WHERE aggregate_type = 'conversation' AND aggregate_id = $1`,
        [first.conversation_id],
      );
      assert.deepEqual(
        inboundStream.rows.map((/** @type {any} */ row) => row.event_type),
        ['conversation.message_received'],
      );

      // T22/PAG-01: a pending order created before the agent's next briefing
      // patch must absorb that patch while the conversation is still with
      // the agent (message.send.requested's #mergeBriefing call site).
      const { order: pendingOnFirst } = await orders.ensurePendingFromIntent({
        conversationId: first.conversation_id,
        correlationId: 'correlation-order-1',
      });

      const reservation = {
        automation_epoch: first.automation_epoch,
        briefing_patch: { quantity: 30, segment: 'uniform' },
        command_id: 'command-ai-1',
        conversation_id: first.conversation_id,
        event_id: 'send-request-1',
        event_type: 'message.send.requested',
        message: { text: 'Qual modelo voce precisa?', type: 'text' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        source_revision: first.source_revision,
        technical: technical('send-1', 'send-request-1'),
      };
      const contact = await pool.query(
        `SELECT identity.current_contact_id AS id
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity
           ON identity.id=conversation.contact_identity_id
         WHERE conversation.id=$1`,
        [first.conversation_id],
      );
      await pool.query(
        `INSERT INTO crm.conversation_subjects
           (id, conversation_id, contact_id, order_id, kind, position,
            is_current, selected_source, selected_by, selected_at,
            created_by, created_by_kind, version, created_at, updated_at)
         VALUES ($1,$2,$3,NULL,'geral',1,true,'human','seller-test',$4,
                 'seller-test','human',1,$4,$4)`,
        ['subject-other-topic', first.conversation_id, contact.rows[0].id, NOW],
      );
      await assert.rejects(service.recordEvent(reservation), {
        code: 'SUBJECT_TARGET_REQUIRED',
      });
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::integer AS count FROM crm.messages
                           WHERE command_id=$1`,
            [reservation.command_id],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT briefing_version FROM crm.conversations WHERE id=$1',
            [first.conversation_id],
          )
        ).rows[0].briefing_version,
        '0',
      );
      await pool.query(
        `UPDATE crm.conversation_subjects
         SET kind='pedido', order_id=$2 WHERE id=$1`,
        ['subject-other-topic', pendingOnFirst.id],
      );
      assert.equal(
        (await service.recordEvent(reservation)).send_authorized,
        true,
      );
      await pool.query(
        'DELETE FROM crm.agent_briefing_projections WHERE subject_id=$1',
        ['subject-other-topic'],
      );
      await pool.query(
        'DELETE FROM crm.subject_briefings WHERE subject_id=$1',
        ['subject-other-topic'],
      );
      await pool.query('DELETE FROM crm.conversation_subjects WHERE id=$1', [
        'subject-other-topic',
      ]);
      assert.equal(
        (await service.recordEvent(reservation)).send_authorized,
        false,
      );

      const projectedOnFirst = await orders.get(pendingOnFirst.id);
      assert.equal(projectedOnFirst.version, pendingOnFirst.version + 1);
      assert.equal(projectedOnFirst.ficha.serviceData.quantity, 30);
      assert.equal(projectedOnFirst.ficha.serviceData.segment, 'uniform');

      await assert.rejects(
        service.recordEvent({
          ...reservation,
          command_id: 'command-ai-2',
          event_id: 'send-request-2',
          technical: technical('send-2', 'send-request-2'),
        }),
        /stale|already processed/iu,
      );

      await service.recordEvent({
        command_id: reservation.command_id,
        conversation_id: first.conversation_id,
        event_id: 'unknown-1',
        event_type: 'message.send.unknown',
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical('unknown-1', 'unknown-1'),
      });
      const beforeReconciliation = await pool.query(
        `SELECT status, sent_at FROM crm.messages
         WHERE command_id = 'command-ai-1'`,
      );
      assert.deepEqual(beforeReconciliation.rows[0], {
        sent_at: null,
        status: 'outcome_unknown',
      });

      await service.recordEvent({
        command_id: reservation.command_id,
        conversation_id: first.conversation_id,
        event_id: 'sent-1',
        event_type: 'message.sent',
        external_message_id: 'wamid.outbound.1',
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical('sent-1', 'sent-1'),
      });
      // A delayed read receipt must not restart the 48-hour customer clock.
      currentTime = new Date(NOW.getTime() + 49 * 60 * 60 * 1000);
      for (const eventType of [
        'message.read',
        'message.delivered',
        'message.sent',
      ]) {
        await service.recordEvent({
          command_id: reservation.command_id,
          conversation_id: first.conversation_id,
          event_id: `${eventType}-1`,
          event_type: eventType,
          external_message_id: 'wamid.outbound.1',
          occurred_at: currentTime.toISOString(),
          schema_version: '1.0',
          technical: technical(`${eventType}-1`, `${eventType}-1`),
        });
      }

      const state = await pool.query(
        `SELECT conversation.briefing_version, conversation.claimed_revision,
                conversation.inbound_revision, message.delivery_status,
                message.delivery_status_at, message.sent_at, message.status
         FROM crm.conversations AS conversation
         JOIN crm.messages AS message ON message.conversation_id = conversation.id
         WHERE message.command_id = 'command-ai-1'`,
      );
      assert.deepEqual(state.rows[0], {
        briefing_version: '1',
        claimed_revision: '1',
        delivery_status: 'read',
        delivery_status_at: currentTime,
        inbound_revision: '1',
        sent_at: NOW,
        status: 'sent',
      });
      const latestMessage = await new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }).readLatestMessageStates([first.conversation_id]);
      assert.equal(
        latestMessage.get(first.conversation_id)?.sentAt,
        NOW.toISOString(),
      );
      await assert.rejects(
        pool.query(
          `UPDATE crm.messages SET sent_at = $1
           WHERE command_id = 'command-ai-1'`,
          [currentTime],
        ),
        /first sent time is immutable/iu,
      );

      const secondInbound = await service.receiveInbound({
        ...inbound,
        event_id: 'wamid.inbound.2',
        message: {
          external_id: 'wamid.inbound.2',
          text: 'Quero negociar com uma pessoa',
          type: 'text',
        },
        technical: technical('inbound-2', 'wamid.inbound.2'),
      });
      // T22/PAG-01: the handoff.requested #mergeBriefing call site also
      // projects, since automation_state is still 'assistant' at merge time
      // (the handoff itself flips it afterwards).
      const { order: pendingOnSecond } = await orders.ensurePendingFromIntent({
        conversationId: secondInbound.conversation_id,
        correlationId: 'correlation-order-2',
      });

      const handoff = await service.recordEvent({
        automation_epoch: secondInbound.automation_epoch,
        briefing_patch: { customer_name: 'Ana Horizonte' },
        conversation_id: secondInbound.conversation_id,
        event_id: 'handoff-1',
        event_type: 'handoff.requested',
        handoff: {
          reason: 'negotiation',
          summary: 'Cliente pediu negociação.',
        },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        source_revision: secondInbound.source_revision,
        technical: technical('handoff-1', 'handoff-1'),
      });
      assert.match(handoff.handoff_id, /^handoff-/u);
      const projectedOnSecond = await orders.get(pendingOnSecond.id);
      assert.equal(projectedOnSecond.version, pendingOnSecond.version + 1);
      assert.equal(projectedOnSecond.ficha.summary.cliente, 'Ana Horizonte');
      const handoffState = await pool.query(
        `SELECT handoff.assigned_user_id, handoff.status, handoff.target_role,
                conversation.automation_epoch, conversation.state,
                history.to_status
         FROM crm.handoffs AS handoff
         JOIN crm.conversations AS conversation
           ON conversation.id = handoff.conversation_id
         JOIN crm.handoff_history AS history
           ON history.handoff_id = handoff.id
         WHERE handoff.id = $1`,
        [handoff.handoff_id],
      );
      assert.deepEqual(handoffState.rows[0], {
        assigned_user_id: null,
        automation_epoch: '1',
        state: 'requer_atencao',
        status: 'pending',
        target_role: 'Vendedor',
        to_status: 'pending',
      });
      const contactName = await pool.query(
        `SELECT contact.display_name, contact.display_name_source
         FROM crm.contacts AS contact
         JOIN crm.contact_identities AS identity
           ON identity.current_contact_id = contact.id
         JOIN crm.conversations AS conversation
           ON conversation.contact_identity_id = identity.id
         WHERE conversation.id = $1`,
        [secondInbound.conversation_id],
      );
      assert.deepEqual(contactName.rows[0], {
        display_name: 'Ana Horizonte',
        display_name_source: 'automation',
      });

      const counts = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM crm.contacts) AS contacts,
           (SELECT count(*)::integer FROM crm.conversations) AS conversations,
           (SELECT count(*)::integer FROM crm.messages) AS messages,
           (SELECT count(*)::integer FROM crm.ai_turns) AS dormant_ai_turns,
           (SELECT count(*)::integer FROM crm.automation_runs) AS dormant_runs,
           (SELECT count(*)::integer FROM crm.conversation_briefing_versions)
             AS dormant_briefing_versions,
           (SELECT count(*)::integer FROM crm.message_delivery_attempts)
             AS dormant_delivery_attempts,
           (SELECT count(*)::integer FROM crm.handoffs) AS handoffs,
           (SELECT count(*)::integer FROM crm.handoff_history)
             AS handoff_history`,
      );
      assert.deepEqual(counts.rows[0], {
        contacts: 1,
        conversations: 1,
        dormant_ai_turns: 0,
        dormant_briefing_versions: 0,
        dormant_delivery_attempts: 0,
        dormant_runs: 0,
        handoff_history: 1,
        handoffs: 1,
        messages: 3,
      });

      // A conflicting subject still permits a pure handoff: the seller can
      // resolve the ambiguity without the legacy agent touching any order.
      const ambiguous = await service.receiveInbound({
        ...inbound,
        contact: { name: 'Another Synthetic', wa_id: '5527999999998' },
        event_id: 'wamid.inbound.ambiguous',
        message: {
          external_id: 'wamid.inbound.ambiguous',
          text: 'Quero tratar de outro assunto',
          type: 'text',
        },
        occurred_at: currentTime.toISOString(),
        technical: technical('inbound-ambiguous', 'inbound-ambiguous'),
      });
      const ambiguousContact = await pool.query(
        `SELECT identity.current_contact_id AS id
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity
           ON identity.id=conversation.contact_identity_id
         WHERE conversation.id=$1`,
        [ambiguous.conversation_id],
      );
      await pool.query(
        `INSERT INTO crm.conversation_subjects
           (id, conversation_id, contact_id, order_id, kind, position,
            is_current, selected_source, selected_by, selected_at,
            created_by, created_by_kind, version, created_at, updated_at)
         VALUES ($1,$2,$3,NULL,'geral',1,true,'human','seller-test',$4,
                 'seller-test','human',1,$4,$4)`,
        [
          'subject-ambiguous',
          ambiguous.conversation_id,
          ambiguousContact.rows[0].id,
          currentTime,
        ],
      );
      const safeHandoff = await service.recordEvent({
        automation_epoch: ambiguous.automation_epoch,
        conversation_id: ambiguous.conversation_id,
        event_id: 'handoff-ambiguous',
        event_type: 'handoff.requested',
        handoff: { reason: 'negotiation', summary: 'Outro assunto.' },
        occurred_at: currentTime.toISOString(),
        schema_version: '1.0',
        source_revision: ambiguous.source_revision,
        technical: technical('handoff-ambiguous', 'handoff-ambiguous'),
      });
      assert.match(safeHandoff.handoff_id, /^handoff-/u);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL seeds an order created after the agent reply with the merged briefing', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 12 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    let sequence = 0;
    const contactEnvelopeKey = Buffer.alloc(32, 72);
    const envelopeKey = Buffer.alloc(32, 71);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    const service = createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `${kind}-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
        messageEnvelopeKey: Buffer.alloc(32, 74),
        orders,
      }),
    });
    /** @param {string} id */
    const technical = (id) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${id}`,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: `request-${id}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion: 'mvp-simple-1',
    });
    /** @param {string} waId */
    const inbound = (waId) =>
      service.receiveInbound({
        channel: 'whatsapp',
        contact: { name: 'Synthetic', wa_id: waId },
        event_id: `wamid.${waId}`,
        message: {
          external_id: `wamid.${waId}`,
          text: 'Pode fechar o pedido',
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-account-1' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical(`inbound-${waId}`),
      });
    const briefingPatch = {
      order_name: 'Formatura 2026',
      product_type: 'camiseta',
      quantity: 30,
    };

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      // The MVP workflow posts the reply (or handoff) before
      // order.intent_confirmed on the same customer message: the reply's
      // projection finds no pending order yet, so the order the intent
      // creates must already carry the briefing that reply merged.
      const replied = await inbound('5527900000001');
      await service.recordEvent({
        automation_epoch: replied.automation_epoch,
        briefing_patch: briefingPatch,
        command_id: 'command-reply-first',
        conversation_id: replied.conversation_id,
        event_id: 'send-reply-first',
        event_type: 'message.send.requested',
        message: { text: 'Pedido anotado!', type: 'text' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        source_revision: replied.source_revision,
        technical: technical('send-reply-first'),
      });
      const { order: afterReply } = await orders.ensurePendingFromIntent({
        conversationId: replied.conversation_id,
        correlationId: 'correlation-intent-reply-first',
      });
      assert.equal(afterReply.ficha.summary.nome, 'Formatura 2026');
      assert.equal(afterReply.ficha.items[0]?.tipo, 'camiseta');
      assert.equal(afterReply.ficha.serviceData.quantity, 30);

      // Same message ending in a handoff: automation_state leaves
      // 'assistant', so no later projection could fill the order.
      const handedOff = await inbound('5527900000002');
      await service.recordEvent({
        automation_epoch: handedOff.automation_epoch,
        briefing_patch: briefingPatch,
        conversation_id: handedOff.conversation_id,
        event_id: 'handoff-reply-first',
        event_type: 'handoff.requested',
        handoff: { reason: 'negotiation', summary: 'Cliente fechou pedido.' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        source_revision: handedOff.source_revision,
        technical: technical('handoff-reply-first'),
      });
      const { order: afterHandoff } = await orders.ensurePendingFromIntent({
        conversationId: handedOff.conversation_id,
        correlationId: 'correlation-intent-handoff-first',
      });
      assert.equal(afterHandoff.ficha.summary.nome, 'Formatura 2026');
      assert.equal(afterHandoff.ficha.items[0]?.tipo, 'camiseta');
      assert.equal(afterHandoff.ficha.serviceData.quantity, 30);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL caps automated messages and reserves the handoff notice (ADR 009)', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 4 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    let sequence = 0;
    const service = createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `${kind}-cap-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        automationMessageCap: 3,
        database,
        envelopeKey: Buffer.alloc(32, 81),
        messageEnvelopeKey: Buffer.alloc(32, 82),
      }),
    });
    /** @param {string} id */
    const technical = (id) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${id}`,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: `request-${id}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion: 'mvp-simple-3',
    });
    /** @param {number} turn */
    const inbound = (turn) =>
      service.receiveInbound({
        channel: 'whatsapp',
        contact: { name: 'Synthetic', wa_id: '5527988887777' },
        event_id: `wamid.cap.${turn}`,
        message: {
          external_id: `wamid.cap.${turn}`,
          text: `Mensagem ${turn}`,
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-account-cap' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical(`inbound-cap-${turn}`),
      });
    /** @param {any} context @param {number} turn */
    const reply = (context, turn) =>
      service.recordEvent({
        automation_epoch: context.automation_epoch,
        command_id: `command-cap-${turn}`,
        conversation_id: context.conversation_id,
        event_id: `send-cap-${turn}`,
        event_type: 'message.send.requested',
        message: { text: `Resposta ${turn}`, type: 'text' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        source_revision: context.source_revision,
        technical: technical(`send-cap-${turn}`),
      });

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      for (const [id, name, disabled] of [
        ['user-seller-b', 'Marina Souza', false],
        ['user-seller-a', 'Edson Lima', false],
        ['user-seller-gone', 'Antigo Vendedor', true],
      ]) {
        await pool.query(
          `INSERT INTO crm.users (id, email, password_hash, name, disabled_at)
           VALUES ($1, $1 || '@example.test', '$argon2id$synthetic', $2, $3)`,
          [id, name, disabled ? NOW : null],
        );
        await pool.query(
          `INSERT INTO crm.user_functions (user_id, function_name)
           VALUES ($1, 'Vendedor')`,
          [id],
        );
      }

      const first = await inbound(1);
      assert.equal(first.automation_message_count, 0);
      assert.equal(first.automation_message_cap, 3);
      assert.deepEqual(first.sellers, [
        { id: 'user-seller-a', name: 'Edson' },
        { id: 'user-seller-b', name: 'Marina' },
      ]);
      assert.equal((await reply(first, 1)).send_authorized, true);

      const second = await inbound(2);
      assert.equal(second.automation_message_count, 1);
      assert.equal((await reply(second, 2)).send_authorized, true);

      // Two replies used, cap 3: the last slot belongs to the handoff notice.
      const third = await inbound(3);
      assert.equal(third.automation_message_count, 2);
      await assert.rejects(reply(third, 3), (error) => {
        assert.equal(/** @type {any} */ (error).code, 'AUTOMATION_MESSAGE_CAP');
        return true;
      });

      const handoffEvent = {
        automation_epoch: third.automation_epoch,
        conversation_id: third.conversation_id,
        event_id: 'handoff-cap',
        event_type: 'handoff.requested',
        handoff: {
          notice: {
            command_id: 'command-cap-notice',
            text: 'Vou encaminhar seu atendimento a um vendedor da Silmer.',
          },
          reason: 'iteration_limit',
          summary: 'Motivo: Limite de mensagens.',
        },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        source_revision: third.source_revision,
        technical: technical('handoff-cap'),
      };
      const handoff = await service.recordEvent(handoffEvent);
      assert.match(handoff.handoff_id, /^handoff-cap-/u);
      assert.deepEqual(handoff.notice, {
        command_id: 'command-cap-notice',
        send_authorized: true,
      });
      const replay = await service.recordEvent(handoffEvent);
      assert.equal(replay.duplicate, true);
      assert.deepEqual(replay.notice, {
        command_id: 'command-cap-notice',
        send_authorized: false,
      });

      await service.recordEvent({
        command_id: 'command-cap-notice',
        conversation_id: third.conversation_id,
        event_id: 'sent-cap-notice',
        event_type: 'message.sent',
        external_message_id: 'wamid.cap.notice',
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical('sent-cap-notice'),
      });
      const stored = await pool.query(
        `SELECT handoff.reason_code, message.status, message.author_kind,
                conversation.automation_state
         FROM crm.handoffs AS handoff
         JOIN crm.conversations AS conversation
           ON conversation.id = handoff.conversation_id
         JOIN crm.messages AS message
           ON message.conversation_id = conversation.id
          AND message.command_id = 'command-cap-notice'
         WHERE handoff.id = $1`,
        [handoff.handoff_id],
      );
      assert.deepEqual(stored.rows[0], {
        author_kind: 'assistant',
        automation_state: 'human',
        reason_code: 'iteration_limit',
        status: 'sent',
      });
      assert.equal((await inbound(4)).automation_message_count, 3);

      // With the cap already spent, a later handoff still happens but sends
      // no notice.
      await pool.query(
        `UPDATE crm.handoffs SET status = 'resolved',
                assigned_user_id = 'user-seller-a', resolved_at = $2
         WHERE id = $1`,
        [handoff.handoff_id, NOW],
      );
      await pool.query(
        `UPDATE crm.conversations SET automation_state = 'assistant'
         WHERE id = $1`,
        [third.conversation_id],
      );
      const fifth = await inbound(5);
      const spent = await service.recordEvent({
        ...handoffEvent,
        automation_epoch: fifth.automation_epoch,
        event_id: 'handoff-cap-spent',
        handoff: {
          notice: { command_id: 'command-cap-notice-2', text: 'Aviso' },
          reason: 'price_before_quote',
          summary: 'Motivo: Perguntou o valor.',
        },
        source_revision: fifth.source_revision,
        technical: technical('handoff-cap-spent'),
      });
      assert.match(spent.handoff_id, /^handoff-cap-/u);
      assert.deepEqual(spent.notice, {
        command_id: null,
        send_authorized: false,
      });
      assert.equal((await inbound(6)).automation_message_count, 3);

      await assert.rejects(
        service.recordEvent({
          ...handoffEvent,
          event_id: 'handoff-bad-notice',
          handoff: {
            notice: { command_id: 'x', text: '  ' },
            reason: 'urgency',
          },
          technical: technical('handoff-bad-notice'),
        }),
        /handoff\.notice\.text/u,
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL opens the pending order with the agent event that carries the ficha (ADR 014)', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 12 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    let sequence = 0;
    const contactEnvelopeKey = Buffer.alloc(32, 72);
    const envelopeKey = Buffer.alloc(32, 71);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    /** @param {any} ordersPort */
    const serviceWith = (ordersPort, databasePort = database) =>
      createN8nIntegrationService({
        clock: () => NOW,
        idFactory: (kind) => `${kind}-open-${++sequence}`,
        repository: new PostgresN8nIntegrationRepository({
          contactEnvelopeKey,
          contactLookupKey: Buffer.alloc(32, 73),
          database: databasePort,
          envelopeKey,
          messageEnvelopeKey: Buffer.alloc(32, 74),
          orders: ordersPort,
        }),
      });
    const service = serviceWith(orders);
    /** @param {string} id */
    const technical = (id) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${id}`,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: `request-${id}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion: 'mvp-simple-11',
    });
    /** @param {string} waId @param {number} turn @param {string} [name] */
    const inbound = (waId, turn, name = 'Synthetic') =>
      service.receiveInbound({
        channel: 'whatsapp',
        contact: { name, wa_id: waId },
        event_id: `wamid.${waId}.${turn}`,
        message: {
          external_id: `wamid.${waId}.${turn}`,
          text: `Mensagem ${turn}`,
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-account-open' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical(`inbound-${waId}-${turn}`),
      });
    /** @param {any} context @param {string} id @param {Record<string, unknown>} extra */
    const reservation = (context, id, extra) => ({
      automation_epoch: context.automation_epoch,
      command_id: `${context.conversation_id}:${context.source_revision}:ai-response`,
      conversation_id: context.conversation_id,
      event_id: `reserve:${id}`,
      event_type: 'message.send.requested',
      message: { text: 'Qual a cor da camisa?', type: 'text' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      source_revision: context.source_revision,
      technical: technical(`reserve-${id}`),
      ...extra,
    });
    /** @param {string} conversationId */
    const pendingOrders = async (conversationId) =>
      (
        await pool.query(
          `SELECT id FROM crm.orders
           WHERE conversation_id = $1 AND status = 'pendente'`,
          [conversationId],
        )
      ).rows.map((/** @type {any} */ row) => row.id);

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      // The workflow decides; without open_order a ficha point opens nothing.
      const quiet = await inbound('5527900000101', 1);
      const notAsked = await service.recordEvent(
        reservation(quiet, 'quiet-1', {
          briefing_patch: { product_model: 'camiseta comum' },
        }),
      );
      assert.equal(notAsked.send_authorized, true);
      assert.equal('order' in notAsked, false);
      assert.deepEqual(await pendingOrders(quiet.conversation_id), []);

      // First point of the ficha: the reservation opens exactly one order,
      // built from the briefing this same event merged, even when n8n
      // retries the request while the first attempt is still running.
      const first = await inbound('5527900000102', 1);
      const opening = reservation(first, 'first-1', {
        briefing_patch: {
          order_name: 'Formatura 2026',
          product_model: 'camiseta comum',
        },
        open_order: true,
      });
      const [opened, retried] = await allValues([
        service.recordEvent(opening),
        service.recordEvent(opening),
      ]);
      const [original, replay] = opened.duplicate
        ? [retried, opened]
        : [opened, retried];
      assert.equal(original.send_authorized, true);
      assert.equal(replay.send_authorized, false);
      assert.equal(original.order.opened, true);
      assert.equal(replay.order.opened, true);
      assert.equal(replay.order.id, original.order.id);
      assert.equal(replay.order.subject_id, original.order.subject_id);
      assert.deepEqual([original.order.created, replay.order.created].sort(), [
        false,
        true,
      ]);
      assert.deepEqual(await pendingOrders(first.conversation_id), [
        original.order.id,
      ]);
      const created = await orders.get(original.order.id);
      assert.equal(created.status, 'pendente');
      assert.equal(created.ficha.summary.nome, 'Formatura 2026');

      // The next turn keeps asking (the rule is sticky): the same order is
      // reused and receives the projection, as before ADR 014.
      const next = await inbound('5527900000102', 2);
      const reused = await service.recordEvent(
        reservation(next, 'first-2', {
          briefing_patch: { order_name: 'Formatura 2027', quantity: 30 },
          open_order: true,
        }),
      );
      assert.deepEqual(reused.order, {
        created: false,
        id: original.order.id,
        subject_id: original.order.subject_id,
        opened: true,
      });
      const projected = await orders.get(original.order.id);
      assert.equal(projected.ficha.summary.nome, 'Formatura 2027');
      assert.equal(projected.version, created.version + 1);
      assert.deepEqual(await pendingOrders(first.conversation_id), [
        original.order.id,
      ]);

      // A handoff has no next turn: it opens the order itself.
      const handedOff = await inbound('5527900000103', 1);
      const handoff = await service.recordEvent({
        automation_epoch: handedOff.automation_epoch,
        briefing_patch: { order_name: 'Time da escola', quantity: 30 },
        conversation_id: handedOff.conversation_id,
        event_id: `${handedOff.conversation_id}:1:handoff`,
        event_type: 'handoff.requested',
        handoff: {
          reason: 'negotiation',
          summary: 'Motivo: Perguntou o valor. Ficha: 1 de 8 (13%).',
        },
        occurred_at: NOW.toISOString(),
        open_order: true,
        schema_version: '1.0',
        source_revision: handedOff.source_revision,
        technical: technical('handoff-open-1'),
      });
      assert.match(handoff.handoff_id, /^handoff-/u);
      assert.equal(handoff.order.opened, true);
      assert.equal(handoff.order.created, true);
      const fromHandoff = await orders.get(handoff.order.id);
      assert.equal(fromHandoff.conversationId, handedOff.conversation_id);
      assert.equal(fromHandoff.ficha.summary.nome, 'Time da escola');

      // The orders side fails (an API ahead of its migration, as on
      // 30/09): the reply is still authorized, the failure is reported,
      // audited and logged without the customer's data.
      const logged = /** @type {unknown[][]} */ ([]);
      const originalError = console.error;
      console.error = (...args) => logged.push(args);
      let failed;
      let unavailable;
      try {
        const broken = serviceWith({
          async ensurePendingFromIntent() {
            throw Object.assign(
              new Error('relation "crm.orders" does not exist: Ana Horizonte'),
              { code: '42P01' },
            );
          },
          projectAgentBriefing: orders.projectAgentBriefing,
        });
        const customer = await inbound('5527911112222', 1, 'Ana Horizonte');
        failed = await broken.recordEvent(
          reservation(customer, 'broken-1', {
            briefing_patch: {
              customer_name: 'Ana Horizonte',
              quantity: 30,
            },
            open_order: true,
          }),
        );
        assert.equal(failed.accepted, true);
        assert.equal(failed.send_authorized, true);
        assert.deepEqual(failed.order, {
          error: 'ORDER_OPEN_FAILED',
          opened: false,
        });
        assert.deepEqual(await pendingOrders(customer.conversation_id), []);
        const audit = await pool.query(
          `SELECT actor_id, reason, target_type, target_id
           FROM crm.audit_events
           WHERE action = 'integration.n8n.order.open_failed'`,
        );
        assert.deepEqual(audit.rows, [
          {
            actor_id: 'AUTOMATION_EXECUTOR',
            reason: 'ORDER_OPEN_FAILED',
            target_id: customer.conversation_id,
            target_type: 'conversation',
          },
        ]);
        // The workflow then raises workflow.failed for the conversation; the
        // runbook finds it by its failure code.
        await broken.recordEvent({
          conversation_id: customer.conversation_id,
          event_id: 'order-open-failed:reserve:broken-1',
          event_type: 'workflow.failed',
          failure: {
            code: 'ORDER_OPEN_FAILED',
            event_type: 'message.send.requested',
            reason: 'ORDER_OPEN_FAILED',
          },
          occurred_at: NOW.toISOString(),
          schema_version: '1.0',
          technical: technical('order-open-failed-broken-1'),
        });
        const raised = await pool.query(
          `SELECT conversation_id FROM crm.n8n_events
           WHERE event_type = 'workflow.failed'
             AND outcome ->> 'failureCode' = 'ORDER_OPEN_FAILED'`,
        );
        assert.deepEqual(raised.rows, [
          { conversation_id: customer.conversation_id },
        ]);

        const noOrders = serviceWith(null);
        const other = await inbound('5527900000104', 1);
        unavailable = await noOrders.recordEvent(
          reservation(other, 'no-orders-1', {
            briefing_patch: { quantity: 12 },
            open_order: true,
          }),
        );
      } finally {
        console.error = originalError;
      }
      assert.deepEqual(unavailable.order, {
        error: 'ORDERS_RUNTIME_UNAVAILABLE',
        opened: false,
      });
      const trace = JSON.stringify(logged);
      assert.match(trace, /ORDER_OPEN_FAILED/u);
      for (const secret of ['Ana', '5527911112222', 'does not exist']) {
        assert.equal(trace.includes(secret), false, secret);
      }

      // A retry of the same event opens the order once the cause is gone.
      let failNext = true;
      const flaky = serviceWith({
        /** @param {any} input */
        async ensurePendingFromIntent(input) {
          if (failNext) {
            failNext = false;
            throw Object.assign(new Error('terminating connection'), {
              code: '57P01',
            });
          }
          return orders.ensurePendingFromIntent(input);
        },
        projectAgentBriefing: orders.projectAgentBriefing,
      });
      const retry = await inbound('5527900000105', 1);
      const retryEvent = reservation(retry, 'retry-1', {
        briefing_patch: { colors: 'azul marinho' },
        open_order: true,
      });
      console.error = () => {};
      let afterFailure;
      try {
        afterFailure = await flaky.recordEvent(retryEvent);
      } finally {
        console.error = originalError;
      }
      assert.equal(afterFailure.order.opened, false);
      const healed = await flaky.recordEvent(retryEvent);
      assert.equal(healed.duplicate, true);
      assert.equal(healed.order.opened, true);
      assert.equal(healed.order.created, true);
      assert.deepEqual(await pendingOrders(retry.conversation_id), [
        healed.order.id,
      ]);

      // A crash after the send fence and order creation but before subject
      // insertion is repaired by a replay. Replay never authorizes Meta again.
      let failSubjectInsert = true;
      const brokenSubjectDatabase = {
        ...database,
        transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
          withTransaction(pool, (client) =>
            work({
              query: (
                /** @type {string} */ sql,
                /** @type {unknown[]} */ values,
              ) => {
                if (
                  failSubjectInsert &&
                  sql.includes('INSERT INTO crm.conversation_subjects')
                ) {
                  failSubjectInsert = false;
                  throw Object.assign(
                    new Error('synthetic subject insert failure'),
                    { code: '57P01' },
                  );
                }
                return client.query(sql, values);
              },
            }),
          ),
      };
      const interrupted = serviceWith(orders, brokenSubjectDatabase);
      const crashContext = await inbound('5527900000106', 1);
      const crashEvent = reservation(crashContext, 'subject-crash-1', {
        briefing_patch: { product_type: 'camisa' },
        open_order: true,
      });
      console.error = () => {};
      let crashed;
      try {
        crashed = await interrupted.recordEvent(crashEvent);
      } finally {
        console.error = originalError;
      }
      assert.equal(crashed.send_authorized, true);
      assert.equal(crashed.order.opened, false);
      assert.equal(
        (await pendingOrders(crashContext.conversation_id)).length,
        1,
      );
      const recovered = await service.recordEvent(crashEvent);
      assert.equal(recovered.duplicate, true);
      assert.equal(recovered.send_authorized, false);
      assert.equal(recovered.order.opened, true);
      assert.equal(recovered.order.created, false);
      const persistedSubject = await pool.query(
        'SELECT id FROM crm.conversation_subjects WHERE conversation_id = $1 AND order_id = $2',
        [crashContext.conversation_id, recovered.order.id],
      );
      assert.equal(persistedSubject.rows[0]?.id, recovered.order.subject_id);
      const secondTurn = await inbound('5527900000106', 2);
      await assert.rejects(
        service.recordEvent({
          ...reservation(secondTurn, 'subject-second-turn', {
            briefing_patch: { quantity: 40 },
            open_order: true,
          }),
          target_contract: 'subject-v1',
        }),
        (error) =>
          /** @type {any} */ (error)?.code === 'SUBJECT_TARGET_REQUIRED',
      );

      // Older workflows still send order.intent_confirmed (deprecated).
      const key = Buffer.alloc(32, 91).toString('base64');
      const runtime = createN8nApiRuntime(database, {
        environment: {
          CONTACT_IDENTITY_ENVELOPE_KEY: key,
          CONTACT_IDENTITY_LOOKUP_KEY: key,
          INBOX_MESSAGE_ENVELOPE_KEY: key,
          N8N_INTEGRATION_ENVELOPE_KEY: key,
        },
        mediaVolume: /** @type {any} */ ({}),
        orders,
      });
      const legacyReuse = await runtime.recordOrderIntent({
        conversation_id: first.conversation_id,
        event_id: 'legacy-intent-1',
        technical: technical('legacy-intent-1'),
      });
      assert.equal(legacyReuse.order.status, 'awaiting_human');
      assert.equal(legacyReuse.order_id, null);
      const legacyNew = await runtime.recordOrderIntent({
        conversation_id: quiet.conversation_id,
        event_id: 'legacy-intent-2',
        technical: technical('legacy-intent-2'),
      });
      assert.equal(legacyNew.duplicate, false);
      assert.equal(legacyNew.order_id, null);
      assert.deepEqual(await pendingOrders(quiet.conversation_id), []);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('subject target fences two active orders, ambiguity, replay and cross-cycle projection', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 12 });
    const originalError = console.error;
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    const envelopeKey = Buffer.alloc(32, 81);
    const contactEnvelopeKey = Buffer.alloc(32, 82);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    let sequence = 0;
    let failProjection = true;
    let switchHumanTarget = false;
    let activeConversationId = '';
    const ordersPort = {
      ensurePendingFromIntent: orders.ensurePendingFromIntent,
      async projectAgentBriefing(/** @type {any} */ input) {
        if (failProjection) {
          failProjection = false;
          throw Object.assign(new Error('synthetic projection failure'), {
            code: 'PROJECTION_UNAVAILABLE',
          });
        }
        if (switchHumanTarget) {
          switchHumanTarget = false;
          await pool.query(
            `UPDATE crm.conversation_subjects SET is_current = false
             WHERE conversation_id = $1 AND is_current`,
            [activeConversationId],
          );
          await pool.query(
            `UPDATE crm.conversation_subjects
             SET is_current = true, selected_source = 'human', selected_by = 'seller-test',
                 selected_at = $1 WHERE id = 'subject-a'`,
            [NOW],
          );
        }
        return orders.projectAgentBriefing(input);
      },
    };
    const service = createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `${kind}-subjects-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 83),
        database,
        envelopeKey,
        messageEnvelopeKey: Buffer.alloc(32, 84),
        orders: ordersPort,
      }),
    });
    const technical = (/** @type {string} */ id) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${id}`,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: `request-${id}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion: 'mvp-simple-15',
    });
    const inbound = (/** @type {string} */ phone, /** @type {number} */ turn) =>
      service.receiveInbound({
        channel: 'whatsapp',
        contact: { wa_id: phone },
        event_id: `wamid.subjects.${phone}.${turn}`,
        message: {
          external_id: `wamid.subjects.${phone}.${turn}`,
          text: `Mensagem ${turn}`,
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-subjects' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical(`inbound-${phone}-${turn}`),
      });
    const reserve = (/** @type {any} */ context, /** @type {string} */ id) => ({
      automation_epoch: context.automation_epoch,
      briefing_patch: { order_name: `Pedido ${id}`, quantity: 12 },
      command_id: `${context.conversation_id}:${context.source_revision}:ai-response`,
      conversation_id: context.conversation_id,
      event_id: `reserve-subjects-${id}`,
      event_type: 'message.send.requested',
      message: { type: 'text', text: 'Qual a cor?' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      source_revision: context.source_revision,
      target_contract: 'subject-v1',
      subject_id: 'subject-b',
      technical: technical(`reserve-subjects-${id}`),
    });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const a = await inbound('5527900000201', 1);
      const b = await inbound('5527900000202', 1);
      const c = await inbound('5527900000203', 1);
      await pool.query(
        `UPDATE crm.contact_identities SET current_contact_id = $1
         WHERE id IN (SELECT contact_identity_id FROM crm.conversations
                      WHERE id = ANY($2::text[]))`,
        [a.contact_id, [b.conversation_id, c.conversation_id]],
      );
      const orderA = (
        await orders.ensurePendingFromIntent({
          conversationId: a.conversation_id,
          correlationId: 'create-a',
        })
      ).order;
      const orderB = (
        await orders.ensurePendingFromIntent({
          conversationId: b.conversation_id,
          correlationId: 'create-b',
        })
      ).order;
      activeConversationId = c.conversation_id;
      for (const { id, order, position, current } of [
        { id: 'subject-a', order: orderA, position: 1, current: false },
        { id: 'subject-b', order: orderB, position: 2, current: true },
      ]) {
        await pool.query(
          `INSERT INTO crm.conversation_subjects
             (id, conversation_id, contact_id, order_id, kind, position,
              is_current, selected_source, selected_by, selected_at,
              created_by, created_by_kind, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pedido', $5, $6, 'human', 'seller-test', $7,
                   'seller-test', 'human', $7, $7)`,
          [
            id,
            c.conversation_id,
            a.contact_id,
            order.id,
            position,
            current,
            NOW,
          ],
        );
      }
      const source = await pool.query(
        `SELECT id FROM crm.messages WHERE conversation_id = $1
           AND inbound_revision = 1`,
        [c.conversation_id],
      );
      for (const id of ['subject-a', 'subject-b']) {
        await pool.query(
          `INSERT INTO crm.message_subject_links
             (message_id, subject_id, conversation_id, assigned_by,
              assigned_by_kind, assigned_at)
           VALUES ($1, $2, $3, 'seller-test', 'human', $4)`,
          [source.rows[0].id, id, c.conversation_id, NOW],
        );
      }
      await assert.rejects(
        service.recordEvent({
          ...reserve(c, 'ambiguous'),
          order_id: orderB.id,
        }),
        (error) => /** @type {any} */ (error)?.code === 'SUBJECT_AMBIGUOUS',
      );
      await pool.query(
        `DELETE FROM crm.message_subject_links WHERE message_id = $1
           AND subject_id = 'subject-a'`,
        [source.rows[0].id],
      );
      const event = { ...reserve(c, 'chosen'), order_id: orderB.id };
      console.error = () => {};
      let first;
      try {
        first = await service.recordEvent(event);
      } finally {
        console.error = originalError;
      }
      assert.equal(first.send_authorized, true);
      assert.deepEqual(first.projection, {
        applied: false,
        error: 'PROJECTION_UNAVAILABLE',
      });
      // A later inbound advances the conversation revision but does not
      // change this subject's accepted briefing or the pending order.
      const laterInbound = await inbound('5527900000203', 2);
      assert.equal(laterInbound.source_revision, 2);
      const replay = await service.recordEvent(event);
      assert.equal(replay.send_authorized, false);
      assert.deepEqual(replay.projection, { applied: true });
      const after = await orders.get(orderB.id);
      assert.equal(after.ficha.summary.nome, 'Pedido chosen');
      assert.equal((await orders.get(orderA.id)).ficha.summary.nome, null);
      await service.recordEvent(event);
      assert.equal((await orders.get(orderB.id)).version, after.version);
      const next = await inbound('5527900000203', 3);
      assert.equal(
        next.subjects.find(
          (/** @type {any} */ subject) => subject.subject_id === 'subject-b',
        ).briefing.order_name,
        'Pedido chosen',
      );
      assert.equal(
        next.subjects.find(
          (/** @type {any} */ subject) => subject.subject_id === 'subject-b',
        ).order_number,
        orderB.number,
      );
      assert.equal(
        next.subjects.find(
          (/** @type {any} */ subject) => subject.subject_id === 'subject-b',
        ).order_status,
        'pendente',
      );
      assert.deepEqual(
        next.subjects.find(
          (/** @type {any} */ subject) => subject.subject_id === 'subject-a',
        ).briefing,
        {},
      );
      failProjection = true;
      const supersededEvent = {
        ...reserve(next, 'superseded'),
        order_id: orderB.id,
      };
      console.error = () => {};
      let supersededFirst;
      try {
        supersededFirst = await service.recordEvent(supersededEvent);
      } finally {
        console.error = originalError;
      }
      assert.deepEqual(supersededFirst.projection, {
        applied: false,
        error: 'PROJECTION_UNAVAILABLE',
      });
      const later = await inbound('5527900000203', 4);
      const latest = await service.recordEvent({
        ...reserve(later, 'latest'),
        order_id: orderB.id,
      });
      assert.deepEqual(latest.projection, { applied: true });
      const latestOrder = await orders.get(orderB.id);
      const staleReplay = await service.recordEvent(supersededEvent);
      assert.deepEqual(staleReplay.projection, {
        applied: false,
        error: 'SUBJECT_SUPERSEDED',
      });
      assert.equal((await orders.get(orderB.id)).version, latestOrder.version);
      const humanTurn = await inbound('5527900000203', 5);
      switchHumanTarget = true;
      const changed = await service.recordEvent({
        ...reserve(humanTurn, 'human-switch'),
        order_id: orderB.id,
      });
      assert.deepEqual(changed.projection, {
        applied: false,
        error: 'SUBJECT_TARGET_CONFLICT',
      });
      assert.equal((await orders.get(orderB.id)).version, latestOrder.version);
    } finally {
      console.error = originalError;
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('site claim stays isolated, immutable and permits a new synthetic order', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 12 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    const lookupKey = Buffer.alloc(32, 96);
    const envelopeKey = Buffer.alloc(32, 97);
    const contactEnvelopeKey = Buffer.alloc(32, 98);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    let sequence = 0;
    const service = createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `${kind}-site-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        contactEnvelopeKey,
        contactLookupKey: lookupKey,
        database,
        envelopeKey,
        messageEnvelopeKey: Buffer.alloc(32, 99),
        orders,
      }),
    });
    const inbound = (
      /** @type {string} */ syntheticId,
      /** @type {number} */ turn,
    ) => ({
      channel: 'site_chat',
      provider: 'site',
      contact: { external_id: syntheticId },
      event_id: `site-${syntheticId}-${turn}`,
      external_conversation_id: `session-${syntheticId}`,
      message: {
        external_id: `message-${syntheticId}-${turn}`,
        text: 'Preciso de camisetas',
        type: 'text',
      },
      metadata: { provider_account_id: 'silmer-site' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      site_contact: { name: 'Ana Sintetica', phone: '5527999991234' },
      technical: {
        actor: 'AUTOMATION_EXECUTOR',
        correlationId: `correlation-${syntheticId}-${turn}`,
        credentialVersion: 'current',
        executionId: `execution-${syntheticId}-${turn}`,
        idempotencyKey: `site-${syntheticId}-${turn}`,
        requestId: `request-${syntheticId}-${turn}`,
        workflowKey: 'site-chat-mvp',
        workflowVersion: 'mvp-simple-15',
      },
    });
    const siteId = (/** @type {number} */ ordinal) =>
      `999${(BigInt('0x123e4567e89b12d3a456426614174000') + BigInt(ordinal))
        .toString(10)
        .padStart(39, '0')}`;
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const withoutClaim = inbound(siteId(5), 1);
      delete (/** @type {any} */ (withoutClaim).site_contact);
      await assert.rejects(
        service.receiveInbound(withoutClaim),
        (error) => /** @type {any} */ (error)?.code === 'SITE_CONTACT_REQUIRED',
      );
      const firstPayload = inbound(siteId(0), 1);
      const first = await service.receiveInbound(firstPayload);
      const replay = await service.receiveInbound(firstPayload);
      assert.equal(first.site_contact_match, 'new');
      assert.deepEqual(first.site_contact, { name: 'Ana Sintetica' });
      assert.equal(first.briefing.customer_name, 'Ana Sintetica');
      assert.equal(replay.duplicate, true);
      assert.equal(replay.conversation_id, first.conversation_id);
      const claim = await pool.query(
        `SELECT version, details_envelope::text AS secret
         FROM crm.site_contact_claims WHERE conversation_id = $1`,
        [first.conversation_id],
      );
      assert.equal(Number(claim.rows[0].version), 1);
      assert.doesNotMatch(claim.rows[0].secret, /5527999991234|Ana Sintetica/u);
      const syntheticContact = await pool.query(
        'SELECT display_name, contact_phone_hash FROM crm.contacts WHERE id = $1',
        [first.contact_id],
      );
      assert.equal(syntheticContact.rows[0].display_name, 'Ana Sintetica');
      assert.equal(syntheticContact.rows[0].contact_phone_hash, null);
      const inbox = new PostgresInboxReadRepository({
        contactEnvelopeKey,
        database,
        messageEnvelopeKey: Buffer.alloc(32, 99),
      });
      const inboxList = await inbox.list({ archived: false, limit: 50 });
      const inboxItem = inboxList.items.find(
        (/** @type {any} */ item) => item.id === first.conversation_id,
      );
      assert.equal(inboxItem?.contact.phone, '5527999991234');
      assert.equal(inboxItem?.contact.phoneSource, 'site_unverified');
      const inboxDetail = await inbox.get(first.conversation_id);
      assert.equal(inboxDetail.conversation.contact.phone, '5527999991234');
      assert.equal(inboxDetail.conversation.contact.label, 'Ana Sintetica');
      const opened = await orders.ensurePendingFromIntent({
        conversationId: first.conversation_id,
        correlationId: 'site-order-first',
      });
      assert.equal(opened.created, true);
      assert.equal(opened.order.contactId, first.contact_id);
      const sameSession = await service.receiveInbound(inbound(siteId(0), 2));
      assert.equal(sameSession.source_revision, 2);
      await assert.rejects(
        service.receiveInbound({
          ...inbound(siteId(0), 3),
          site_contact: { name: 'Ana Sintetica', phone: '5527999990000' },
        }),
        (error) => /** @type {any} */ (error)?.code === 'SITE_CONTACT_CONFLICT',
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT version FROM crm.site_contact_claims WHERE conversation_id=$1',
              [first.conversation_id],
            )
          ).rows[0].version,
        ),
        1,
      );
      const secondSession = await service.receiveInbound(inbound(siteId(1), 1));
      assert.equal(secondSession.site_contact_match, 'new');
      assert.notEqual(secondSession.contact_id, first.contact_id);
      const secondOrder = await orders.ensurePendingFromIntent({
        conversationId: secondSession.conversation_id,
        correlationId: 'site-order-second',
      });
      assert.notEqual(secondOrder.order.id, opened.order.id);
      // A new cycle of the same synthetic session still cannot target a
      // pending order that belongs to its earlier conversation.
      const laterCycle = await service.receiveInbound({
        ...inbound(siteId(0), 4),
        external_conversation_id: `session-${siteId(0)}-next-cycle`,
      });
      assert.equal(laterCycle.contact_id, first.contact_id);
      await pool.query(
        `INSERT INTO crm.conversation_subjects
           (id, conversation_id, contact_id, order_id, kind, position,
            is_current, selected_source, selected_by, selected_at,
            created_by, created_by_kind, created_at, updated_at)
         VALUES ('site-old-order-target', $1, $2, $3, 'pedido', 1,
                 true, 'agent', 'AUTOMATION_EXECUTOR', $4,
                 'AUTOMATION_EXECUTOR', 'agent', $4, $4)`,
        [laterCycle.conversation_id, first.contact_id, opened.order.id, NOW],
      );
      await assert.rejects(
        service.recordEvent({
          automation_epoch: laterCycle.automation_epoch,
          briefing_patch: { quantity: 20 },
          command_id: 'site-old-order-command',
          conversation_id: laterCycle.conversation_id,
          event_id: 'site-old-order-event',
          event_type: 'message.send.requested',
          message: { type: 'text', text: 'Qual cor?' },
          occurred_at: NOW.toISOString(),
          order_id: opened.order.id,
          schema_version: '1.0',
          source_revision: laterCycle.source_revision,
          subject_id: 'site-old-order-target',
          target_contract: 'subject-v1',
          technical: inbound(siteId(0), 5).technical,
        }),
        (error) =>
          /** @type {any} */ (error)?.code === 'SUBJECT_TARGET_INVALID',
      );
      const phoneHash = contactPhoneHash('5527999991234', lookupKey);
      await pool.query(
        `INSERT INTO crm.contacts
           (id, provisional, version, created_at, updated_at, contact_phone_hash)
         VALUES ('known-site-1', false, 1, $1, $1, $2)`,
        [NOW, phoneHash],
      );
      const oneMatch = await service.receiveInbound(inbound(siteId(2), 1));
      assert.equal(oneMatch.site_contact_match, 'existing');
      assert.ok(!JSON.stringify(oneMatch).includes('known-site-1'));
      await pool.query(
        `INSERT INTO crm.contacts
           (id, provisional, version, created_at, updated_at, contact_phone_hash)
         VALUES ('known-site-2', false, 1, $1, $1, $2)`,
        [NOW, phoneHash],
      );
      const ambiguous = await service.receiveInbound(inbound(siteId(3), 1));
      assert.equal(ambiguous.site_contact_match, 'ambiguous');
      assert.ok(!JSON.stringify(ambiguous).includes('known-site-2'));
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('CP-12/CP-16: the agent records the subject of the turn it answered and asks only when unsure', async () => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 12 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    const envelopeKey = Buffer.alloc(32, 61);
    const contactEnvelopeKey = Buffer.alloc(32, 62);
    const orders = createOrderService({
      authorizeOwnership: async () => {},
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 73),
        database,
        envelopeKey,
      }),
      fabCode: 'FAB-TEST',
      repository: new PostgresOrderRepository({ database, envelopeKey }),
    });
    let sequence = 0;
    const service = createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `${kind}-cp12-${++sequence}`,
      repository: new PostgresN8nIntegrationRepository({
        contactEnvelopeKey,
        contactLookupKey: Buffer.alloc(32, 63),
        database,
        envelopeKey,
        messageEnvelopeKey: Buffer.alloc(32, 64),
        orders,
      }),
    });
    const subjectService = createSubjectService(database);
    const seller = {
      id: 'seller-cp12',
      kind: 'human',
      functionName: 'Vendedor',
    };
    const technical = (/** @type {string} */ id) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${id}`,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: `request-${id}`,
      workflowKey: 'whatsapp-mvp',
      workflowVersion: 'mvp-simple-15',
    });
    const inbound = (/** @type {string} */ phone, /** @type {number} */ turn) =>
      service.receiveInbound({
        channel: 'whatsapp',
        contact: { wa_id: phone },
        event_id: `wamid.cp12.${phone}.${turn}`,
        message: {
          external_id: `wamid.cp12.${phone}.${turn}`,
          text: `Mensagem sintética ${turn}`,
          type: 'text',
        },
        metadata: { phone_number_id: 'phone-cp12' },
        occurred_at: NOW.toISOString(),
        schema_version: '1.0',
        technical: technical(`inbound-cp12-${phone}-${turn}`),
      });
    /** @param {any} context @param {string} id @param {Record<string, unknown>} [extra] @returns {any} */
    const send = (context, id, extra = {}) => ({
      automation_epoch: context.automation_epoch,
      command_id: `${context.conversation_id}:${context.source_revision}:ai-response`,
      conversation_id: context.conversation_id,
      event_id: `send-cp12-${id}`,
      event_type: 'message.send.requested',
      message: { type: 'text', text: 'Qual a cor?' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      source_revision: context.source_revision,
      target_contract: 'subject-v1',
      technical: technical(`send-cp12-${id}`),
      ...extra,
    });
    /** @param {any} context @param {string} id @param {string} reason @param {Record<string, unknown>} [extra] */
    const handoff = (context, id, reason, extra = {}) => ({
      automation_epoch: context.automation_epoch,
      conversation_id: context.conversation_id,
      event_id: `handoff-cp12-${id}`,
      event_type: 'handoff.requested',
      handoff: { reason, summary: 'Resumo sintético' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      source_revision: context.source_revision,
      target_contract: 'subject-v1',
      technical: technical(`handoff-cp12-${id}`),
      ...extra,
    });
    /** Inbound links by revision, without message content. @param {string} conversationId */
    const inboundLinks = async (conversationId) =>
      (
        await pool.query(
          `SELECT message.inbound_revision AS revision, link.subject_id,
                  link.assigned_by_kind
           FROM crm.messages AS message
           JOIN crm.message_subject_links AS link ON link.message_id = message.id
           WHERE message.conversation_id = $1 AND message.direction = 'inbound'
           ORDER BY message.inbound_revision, link.subject_id`,
          [conversationId],
        )
      ).rows.map((/** @type {any} */ row) => [
        Number(row.revision),
        row.subject_id,
        row.assigned_by_kind,
      ]);
    /** @param {string} conversationId @param {number} revision @returns {Promise<string>} */
    const messageAt = async (conversationId, revision) =>
      (
        await pool.query(
          `SELECT id FROM crm.messages WHERE conversation_id = $1
             AND direction = 'inbound' AND inbound_revision = $2`,
          [conversationId, revision],
        )
      ).rows[0].id;
    /** @param {string} action */
    const audits = async (action) =>
      (
        await pool.query(
          `SELECT target_type, target_id, version, reason FROM crm.audit_events
           WHERE action = $1 ORDER BY occurred_at, id`,
          [action],
        )
      ).rows;
    /** @param {string} conversationId */
    const reviewCount = async (conversationId) =>
      (
        await pool.query(
          'SELECT 1 FROM crm.message_subject_reviews WHERE conversation_id = $1',
          [conversationId],
        )
      ).rows.length;
    /** @param {string} conversationId @param {Array<{id: string, order: any, position: number, current: boolean}>} subjects @param {string} contactId */
    const insertSubjects = async (conversationId, subjects, contactId) => {
      for (const { id, order, position, current } of subjects) {
        await pool.query(
          `INSERT INTO crm.conversation_subjects
             (id, conversation_id, contact_id, order_id, kind, position,
              is_current, selected_source, selected_by, selected_at,
              created_by, created_by_kind, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pedido', $5, $6,
                   CASE WHEN $6 THEN 'agent' END,
                   CASE WHEN $6 THEN 'AUTOMATION_EXECUTOR' END,
                   CASE WHEN $6 THEN $7::timestamptz END,
                   'seller-test', 'human', $7, $7)`,
          [id, conversationId, contactId, order.id, position, current, NOW],
        );
      }
    };
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await pool.query(
        `INSERT INTO crm.users (id, email, password_hash, name)
         VALUES ($1, 'seller-cp12@example.test', '$argon2id$synthetic',
                 'Vendedora Sintética')`,
        [seller.id],
      );
      const a = await inbound('5527900000301', 1);
      const b = await inbound('5527900000302', 1);
      const c = await inbound('5527900000303', 1);
      const e = await inbound('5527900000305', 1);
      const f = await inbound('5527900000306', 1);
      await pool.query(
        `UPDATE crm.contact_identities SET current_contact_id = $1
         WHERE id IN (SELECT contact_identity_id FROM crm.conversations
                      WHERE id = ANY($2::text[]))`,
        [
          a.contact_id,
          [
            b.conversation_id,
            c.conversation_id,
            e.conversation_id,
            f.conversation_id,
          ],
        ],
      );
      const orderA = (
        await orders.ensurePendingFromIntent({
          conversationId: a.conversation_id,
          correlationId: 'cp12-create-a',
        })
      ).order;
      const orderB = (
        await orders.ensurePendingFromIntent({
          conversationId: b.conversation_id,
          correlationId: 'cp12-create-b',
        })
      ).order;
      await insertSubjects(
        c.conversation_id,
        [
          { id: 'cp12-c-a', order: orderA, position: 1, current: false },
          { id: 'cp12-c-b', order: orderB, position: 2, current: true },
        ],
        a.contact_id,
      );

      // Turn range: revisions 1..3 were not answered yet. Revision 1 has a
      // human subject and revision 2 a human "no subject" decision; only
      // revision 3 is recorded under the turn's explicit target.
      await inbound('5527900000303', 2);
      const c3 = await inbound('5527900000303', 3);
      await pool.query(
        `INSERT INTO crm.message_subject_links
           (message_id, subject_id, conversation_id, assigned_by,
            assigned_by_kind, assigned_at)
         VALUES ($1, 'cp12-c-a', $2, 'seller-test', 'human', $3)`,
        [await messageAt(c.conversation_id, 1), c.conversation_id, NOW],
      );
      await pool.query(
        `INSERT INTO crm.message_subject_reviews
           (message_id, conversation_id, source_revision, reason,
            requested_at, resolved_at, resolved_by)
         VALUES ($1, $2, 2, 'human_review', $3, $3, 'seller-test')`,
        [await messageAt(c.conversation_id, 2), c.conversation_id, NOW],
      );
      const firstSend = send(c3, 'c3', {
        subject_id: 'cp12-c-b',
        order_id: orderB.id,
      });
      const accepted = await service.recordEvent(firstSend);
      assert.equal(accepted.send_authorized, true);
      assert.deepEqual(await inboundLinks(c.conversation_id), [
        [1, 'cp12-c-a', 'human'],
        [3, 'cp12-c-b', 'agent'],
      ]);
      assert.deepEqual(
        await audits('integration.n8n.message_subjects_inferred'),
        [
          {
            target_type: 'conversation_subject',
            target_id: 'cp12-c-b',
            version: '1',
            reason: 'AGENT_SUBJECT_ASSIGNMENT',
          },
        ],
      );
      // A replay writes nothing new.
      const replayed = await service.recordEvent(firstSend);
      assert.equal(replayed.duplicate, true);
      assert.equal((await inboundLinks(c.conversation_id)).length, 2);
      assert.equal(
        (await audits('integration.n8n.message_subjects_inferred')).length,
        1,
      );

      // Two unanswered inbound messages are both answered by the next turn.
      await inbound('5527900000303', 4);
      const c5 = await inbound('5527900000303', 5);
      await service.recordEvent(
        send(c5, 'c5', { subject_id: 'cp12-c-b', order_id: orderB.id }),
      );
      assert.deepEqual((await inboundLinks(c.conversation_id)).slice(2), [
        [4, 'cp12-c-b', 'agent'],
        [5, 'cp12-c-b', 'agent'],
      ]);

      // SUBJECT_AMBIGUOUS rolls back: the unlinked revision 6 stays unlinked.
      await inbound('5527900000303', 6);
      const c7 = await inbound('5527900000303', 7);
      const source7 = await messageAt(c.conversation_id, 7);
      for (const subjectId of ['cp12-c-a', 'cp12-c-b']) {
        await pool.query(
          `INSERT INTO crm.message_subject_links
             (message_id, subject_id, conversation_id, assigned_by,
              assigned_by_kind, assigned_at)
           VALUES ($1, $2, $3, 'seller-test', 'human', $4)`,
          [source7, subjectId, c.conversation_id, NOW],
        );
      }
      await assert.rejects(
        service.recordEvent(
          send(c7, 'c7-ambiguous', {
            subject_id: 'cp12-c-b',
            order_id: orderB.id,
          }),
        ),
        (error) => /** @type {any} */ (error)?.code === 'SUBJECT_AMBIGUOUS',
      );
      assert.equal(
        (await inboundLinks(c.conversation_id)).some(
          ([revision]) => revision === 6,
        ),
        false,
      );
      assert.equal(
        (await audits('integration.n8n.message_subjects_inferred')).length,
        2,
      );

      // A handoff with an explicit target records the same turn range.
      await pool.query(
        'DELETE FROM crm.message_subject_links WHERE message_id = $1',
        [source7],
      );
      const targeted = await service.recordEvent(
        handoff(c7, 'c7-target', 'briefing_complete', {
          subject_id: 'cp12-c-b',
          order_id: orderB.id,
        }),
      );
      assert.match(targeted.handoff_id, /^handoff-/u);
      assert.deepEqual((await inboundLinks(c.conversation_id)).slice(4), [
        [6, 'cp12-c-b', 'agent'],
        [7, 'cp12-c-b', 'agent'],
      ]);
      assert.equal(await reviewCount(c.conversation_id), 1);

      // CP-16: low confidence without a target only asks the seller.
      await insertSubjects(
        e.conversation_id,
        [
          { id: 'cp12-e-a', order: orderA, position: 1, current: true },
          { id: 'cp12-e-b', order: orderB, position: 2, current: false },
        ],
        a.contact_id,
      );
      const e2 = await inbound('5527900000305', 2);
      const versions = [
        (await orders.get(orderA.id)).version,
        (await orders.get(orderB.id)).version,
      ];
      const lowConfidence = handoff(e2, 'e2', 'low_confidence');
      const unsure = await service.recordEvent(lowConfidence);
      const reviews = await pool.query(
        `SELECT review.source_revision, review.reason, review.handoff_id,
                review.resolved_at, message.inbound_revision
         FROM crm.message_subject_reviews AS review
         JOIN crm.messages AS message ON message.id = review.message_id
         WHERE review.conversation_id = $1
         ORDER BY message.inbound_revision`,
        [e.conversation_id],
      );
      assert.deepEqual(
        reviews.rows.map((/** @type {any} */ row) => [
          Number(row.inbound_revision),
          row.reason,
          Number(row.source_revision),
          row.handoff_id,
          row.resolved_at,
        ]),
        [
          [1, 'subject_ambiguous', 2, unsure.handoff_id, null],
          [2, 'subject_ambiguous', 2, unsure.handoff_id, null],
        ],
      );
      assert.deepEqual(await inboundLinks(e.conversation_id), []);
      assert.deepEqual(
        [
          (await orders.get(orderA.id)).version,
          (await orders.get(orderB.id)).version,
        ],
        versions,
      );
      assert.deepEqual(
        await audits('integration.n8n.message_subject_review_requested'),
        [
          {
            target_type: 'handoff',
            target_id: unsure.handoff_id,
            version: '2',
            reason: 'AGENT_SUBJECT_AMBIGUOUS',
          },
        ],
      );
      assert.equal((await service.recordEvent(lowConfidence)).duplicate, true);
      assert.equal(await reviewCount(e.conversation_id), 2);
      const e1Message = await messageAt(e.conversation_id, 1);
      const e2Message = await messageAt(e.conversation_id, 2);
      assert.deepEqual(
        (await subjectService.list(e.conversation_id)).needsSubjectMessageIds,
        [e1Message, e2Message].sort(),
      );

      // The seller's decision resolves the review, keeps the handoff open
      // and the conversation with the human (ADR 015).
      await pool.query(
        'UPDATE crm.conversations SET assigned_user_id = $2 WHERE id = $1',
        [e.conversation_id, seller.id],
      );
      const automation = async () =>
        (
          await pool.query(
            `SELECT automation_state, automation_epoch FROM crm.conversations
             WHERE id = $1`,
            [e.conversation_id],
          )
        ).rows[0];
      const before = await automation();
      for (const [messageId, subjectIds] of /** @type {const} */ ([
        [e1Message, ['cp12-e-b']],
        [e2Message, []],
      ])) {
        await subjectService.tagMessage({
          actor: seller,
          conversationId: e.conversation_id,
          correlationId: `cp12-tag-${messageId}`,
          idempotencyKey: `cp12-tag-${messageId}`,
          messageId,
          subjectIds: [...subjectIds],
        });
      }
      const resolved = await pool.query(
        `SELECT resolved_by FROM crm.message_subject_reviews
         WHERE conversation_id = $1 AND resolved_at IS NOT NULL`,
        [e.conversation_id],
      );
      assert.deepEqual(
        resolved.rows.map((/** @type {any} */ row) => row.resolved_by),
        [seller.id, seller.id],
      );
      const afterTag = await subjectService.list(e.conversation_id);
      assert.deepEqual(afterTag.needsSubjectMessageIds, []);
      assert.deepEqual(afterTag.links, [
        {
          messageId: e1Message,
          subjectId: 'cp12-e-b',
          assignedByKind: 'human',
        },
      ]);
      const tagEvents = await pool.query(
        `SELECT payload FROM crm.domain_events
         WHERE aggregate_type = 'conversation' AND aggregate_id = $1
           AND event_type = 'conversation.subjects_changed'
         ORDER BY aggregate_version`,
        [e.conversation_id],
      );
      assert.deepEqual(
        tagEvents.rows.map((/** @type {any} */ row) => [
          row.payload.messageId,
          row.payload.reviewResolved,
          row.payload.previousLinks,
        ]),
        [
          [e1Message, true, []],
          [e2Message, true, []],
        ],
      );
      assert.deepEqual(await automation(), before);
      assert.equal(
        (
          await pool.query('SELECT status FROM crm.handoffs WHERE id = $1', [
            unsure.handoff_id,
          ])
        ).rows[0].status,
        'pending',
      );

      // 'unsupported' is not about the subject: no review is opened.
      await insertSubjects(
        f.conversation_id,
        [
          { id: 'cp12-f-a', order: orderA, position: 1, current: true },
          { id: 'cp12-f-b', order: orderB, position: 2, current: false },
        ],
        a.contact_id,
      );
      await service.recordEvent(handoff(f, 'f1', 'unsupported'));
      assert.equal(await reviewCount(f.conversation_id), 0);

      // open_order bootstrap: the only subject receives the opening turn.
      await inbound('5527900000307', 1);
      const g2 = await inbound('5527900000307', 2);
      const opening = send(g2, 'g2', {
        briefing_patch: { order_name: 'Pedido sintético', quantity: 20 },
        open_order: true,
      });
      delete opening.target_contract;
      const opened = await service.recordEvent(opening);
      assert.equal(opened.order.opened, true);
      assert.deepEqual(await inboundLinks(g2.conversation_id), [
        [1, opened.order.subject_id, 'agent'],
        [2, opened.order.subject_id, 'agent'],
      ]);
      const inferredAfterOpening = (
        await audits('integration.n8n.message_subjects_inferred')
      ).length;
      // CP-29: replaying a bootstrap that already succeeded reuses the
      // order and subject without a second link or audit row.
      const replayedOpening = await service.recordEvent(opening);
      assert.equal(replayedOpening.duplicate, true);
      assert.equal(replayedOpening.order.opened, true);
      assert.equal(replayedOpening.order.created, false);
      assert.equal(replayedOpening.order.subject_id, opened.order.subject_id);
      assert.deepEqual(await inboundLinks(g2.conversation_id), [
        [1, opened.order.subject_id, 'agent'],
        [2, opened.order.subject_id, 'agent'],
      ]);
      assert.equal(
        (await audits('integration.n8n.message_subjects_inferred')).length,
        inferredAfterOpening,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM crm.conversation_subjects WHERE conversation_id = $1',
            [g2.conversation_id],
          )
        ).rows.length,
        1,
      );
      const g3 = await inbound('5527900000307', 3);
      // The legacy contract still reuses the conversation's one order.
      const reused = send(g3, 'g3', {
        briefing_patch: { quantity: 25 },
        open_order: true,
        technical: {
          ...technical('send-cp12-g3'),
          workflowVersion: 'mvp-simple-11',
        },
      });
      delete reused.target_contract;
      assert.equal((await service.recordEvent(reused)).order.created, false);
      assert.deepEqual((await inboundLinks(g2.conversation_id)).at(-1), [
        3,
        opened.order.subject_id,
        'agent',
      ]);

      // CP-29: a low-confidence handoff that still opens the order creates
      // the subject, but the agent never links the turn it was unsure of.
      await inbound('5527900000308', 1);
      const h2 = await inbound('5527900000308', 2);
      const inferredBeforeUnsure = (
        await audits('integration.n8n.message_subjects_inferred')
      ).length;
      const unsureOpening = handoff(h2, 'h2', 'low_confidence', {
        briefing_patch: { order_name: 'Pedido sintético', quantity: 10 },
        open_order: true,
      });
      const unsureOpened = await service.recordEvent(unsureOpening);
      assert.match(unsureOpened.handoff_id, /^handoff-/u);
      assert.equal(unsureOpened.order.opened, true);
      assert.equal(unsureOpened.order.created, true);
      const unsureSubjects = await pool.query(
        `SELECT id, order_id, is_current FROM crm.conversation_subjects
         WHERE conversation_id = $1`,
        [h2.conversation_id],
      );
      assert.deepEqual(unsureSubjects.rows, [
        {
          id: unsureOpened.order.subject_id,
          order_id: unsureOpened.order.id,
          is_current: true,
        },
      ]);
      assert.deepEqual(await inboundLinks(h2.conversation_id), []);
      assert.equal(
        (await audits('integration.n8n.message_subjects_inferred')).length,
        inferredBeforeUnsure,
      );
      const unsureReplay = await service.recordEvent(unsureOpening);
      assert.equal(unsureReplay.duplicate, true);
      assert.equal(
        unsureReplay.order.subject_id,
        unsureOpened.order.subject_id,
      );
      assert.deepEqual(await inboundLinks(h2.conversation_id), []);
      assert.equal(
        (await audits('integration.n8n.message_subjects_inferred')).length,
        inferredBeforeUnsure,
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
}

/** @param {Promise<any>[]} promises */
async function allValues(promises) {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find(({ status }) => status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  return settled.map((result) =>
    result.status === 'fulfilled' ? result.value : undefined,
  );
}
