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
} from '../modules/inbox-channels/src/index.js';
import { encryptJson } from '../modules/n8n-integration/src/crypto.js';
import { PostgresHandoffReadRepository } from '../modules/work-management/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-09-08T12:00:00.000Z');
const CONTACT_KEY = Buffer.alloc(32, 42);
const MESSAGE_KEY = Buffer.alloc(32, 41);

if (connectionString) {
  test('PostgreSQL projects paginated Inbox and Contact data without exposing envelopes', async () => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
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
        lookupKey: Buffer.alloc(32, 43),
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
      contactRepository: new PostgresContactReadRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 43),
      }),
      cursorKey: Buffer.alloc(32, 44),
      handoffRepository: new PostgresHandoffReadRepository({
        contactEnvelopeKey: CONTACT_KEY,
        database,
        handoffEnvelopeKey: Buffer.alloc(32, 45),
        n8nEnvelopeKey: Buffer.alloc(32, 46),
      }),
      inboxRepository: new PostgresInboxReadRepository({
        contactEnvelopeKey: CONTACT_KEY,
        database,
        messageEnvelopeKey: MESSAGE_KEY,
      }),
    });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const resolved = await contacts.resolveInboundIdentity(
        identityInput(runId, 'primary'),
      );
      await contacts.resolveInboundIdentity(identityInput(runId, 'secondary'));
      const received = await inbox.receiveInbound({
        contactId: resolved.contact.id,
        correlationId: `correlation-message-${runId}`,
        externalConversationId: `conversation-${runId}`,
        externalMessageId: `message-${runId}`,
        identityId: resolved.identity.id,
        message: { content: { text: `PII-canary-${runId}` }, type: 'text' },
        occurredAt: NOW.toISOString(),
        provider: 'meta',
        providerAccountId: `account-primary-${runId}`,
      });

      const inboxPage = await reads.listInbox({
        channel: 'instagram',
        state: 'nova',
      });
      assert.equal(inboxPage.totalCount, 1);
      assert.equal(
        inboxPage.items[0].contact.label,
        `@primary_${runId.slice(0, 8)}`,
      );
      assert.equal(
        inboxPage.items[0].lastMessage.preview,
        `PII-canary-${runId}`,
      );
      const unassignedPage = await reads.listInbox({
        unassignedHumanHandoff: true,
      });
      assert.equal(unassignedPage.totalCount, 1);
      assert.equal(unassignedPage.items[0].id, received.conversation.id);
      const conversation = await reads.getConversation({
        conversationId: received.conversation.id,
      });
      assert.equal(conversation.messages[0].preview, `PII-canary-${runId}`);

      const firstContacts = await reads.listContacts({ limit: 1 });
      assert.equal(firstContacts.totalCount, 2);
      assert.ok(firstContacts.nextCursor);
      const secondContacts = await reads.listContacts({
        cursor: firstContacts.nextCursor,
        limit: 1,
      });
      assert.equal(secondContacts.items.length, 1);
      assert.notEqual(secondContacts.items[0].id, firstContacts.items[0].id);
      const contact = await reads.getContact({
        contactId: resolved.contact.id,
      });
      assert.equal(contact.conversations[0].id, received.conversation.id);
      assert.equal(
        contact.identities[0].externalId,
        `identity-primary-${runId}`,
      );

      const stored = await pool.query(
        `SELECT identity_envelope::text envelope FROM crm.contact_identities
         UNION ALL
         SELECT content_envelope::text envelope FROM crm.messages`,
      );
      assert.equal(stored.rows.length, 3);
      assert.ok(
        stored.rows.every(
          (row) => !row.envelope.includes(`PII-canary-${runId}`),
        ),
      );
      assert.ok(
        stored.rows.every(
          (row) => !row.envelope.includes(`identity-primary-${runId}`),
        ),
      );

      // Pedidos MVP (T20): who must act, why the agent stopped, the order.
      const sellerId = `seller-inbox-${runId}`;
      await pool.query(
        `INSERT INTO crm.users (id, email, password_hash, name)
         VALUES ($1, $2, '$argon2id$synthetic', 'Vendedora Inbox')`,
        [sellerId, `${sellerId}@example.test`],
      );
      await pool.query(
        `INSERT INTO crm.user_functions (user_id, function_name)
         VALUES ($1, 'Vendedor')`,
        [sellerId],
      );
      /** @param {string} suffix @param {string} occurredAt */
      const openConversation = async (suffix, occurredAt) => {
        const identity = await contacts.resolveInboundIdentity(
          identityInput(runId, suffix),
        );
        const opened = await inbox.receiveInbound({
          contactId: identity.contact.id,
          correlationId: `correlation-${suffix}-${runId}`,
          externalConversationId: `conversation-${suffix}-${runId}`,
          externalMessageId: `message-${suffix}-${runId}`,
          identityId: identity.identity.id,
          message: { content: { text: `Mensagem ${suffix}` }, type: 'text' },
          occurredAt,
          provider: 'meta',
          providerAccountId: `account-${suffix}-${runId}`,
        });
        return opened.conversation.id;
      };
      // The oldest waiting conversation has the most recent message, so the
      // waiting order cannot be mistaken for the last-message order.
      const waitingOld = await openConversation(
        'waitingold',
        '2026-09-08T12:30:00.000Z',
      );
      const waitingNew = await openConversation(
        'waitingnew',
        '2026-09-08T12:10:00.000Z',
      );
      const primary = received.conversation.id;
      /** @param {string} id @param {string} conversationId @param {string} reason @param {string} createdAt @param {'pending'|'accepted'} status */
      const insertHandoff = (id, conversationId, reason, createdAt, status) =>
        pool.query(
          `INSERT INTO crm.handoffs
             (id, conversation_id, assigned_user_id, status, version,
              reason_code, summary_envelope, due_at, sla_minutes,
              sla_policy_version, created_at, updated_at, target_role)
           VALUES ($1, $2, $3, $4, 1, $5,
                   '{"algorithm":"AES-256-GCM","version":"1"}'::jsonb,
                   $6::timestamptz + interval '30 minutes', 30, 'v1', $6, $6,
                   'Vendedor')`,
          [
            `handoff-${id}-${runId}`,
            conversationId,
            status === 'accepted' ? sellerId : null,
            status,
            reason,
            createdAt,
          ],
        );
      await insertHandoff(
        'old',
        waitingOld,
        'price_before_quote',
        '2026-09-08T08:00:00.000Z',
        'pending',
      );
      await insertHandoff(
        'new',
        waitingNew,
        'customer_requested_human',
        '2026-09-08T10:00:00.000Z',
        'pending',
      );
      await insertHandoff(
        'claimed',
        primary,
        'briefing_complete',
        '2026-09-08T07:00:00.000Z',
        'accepted',
      );
      await pool.query(
        `UPDATE crm.conversations
         SET assigned_user_id = $2, automation_state = 'human'
         WHERE id = $1`,
        [primary, sellerId],
      );
      /** @param {number} sequence @param {string} conversationId @param {'pendente'|'confirmado'} status */
      const insertOrder = (sequence, conversationId, status) =>
        pool.query(
          `INSERT INTO crm.orders
             (id, number_sequence, number, conversation_id, contact_id, status, fab_code,
              ficha_envelope, created_by_kind, created_at, updated_at,
              final_amount_cents, payment_condition, order_date, confirmed_at,
              confirmed_by)
           VALUES ($1, $2::bigint, lpad($2::bigint::text, 2, '0') || '-CRM',
                   $3, (SELECT identity.current_contact_id
                        FROM crm.conversations conversation
                        JOIN crm.contact_identities identity
                          ON identity.id = conversation.contact_identity_id
                        WHERE conversation.id = $3), $4, '01',
                   '{"algorithm":"AES-256-GCM"}'::jsonb, 'user', $5, $5,
                   $6, $7, $8, $9, $10)`,
          [
            `order-${sequence}-${runId}`,
            sequence,
            conversationId,
            status,
            NOW,
            status === 'confirmado' ? 1000 : null,
            status === 'confirmado' ? 'pix' : null,
            status === 'confirmado' ? '2026-09-08' : null,
            status === 'confirmado' ? NOW : null,
            status === 'confirmado' ? sellerId : null,
          ],
        );
      await insertOrder(1, primary, 'confirmado');
      await insertOrder(2, primary, 'pendente');
      await insertOrder(3, waitingOld, 'confirmado');

      const waiting = await reads.listInbox({ pendingHandoff: true });
      assert.equal(waiting.totalCount, 2);
      assert.deepEqual(
        waiting.items.map((/** @type {any} */ item) => item.id),
        [waitingOld, waitingNew],
        'Aguardando vendedor lists the longest wait first',
      );
      assert.equal(waiting.items[0].handoff.reasonCode, 'price_before_quote');
      assert.equal(
        waiting.items[0].handoff.createdAt,
        '2026-09-08T08:00:00.000Z',
      );
      assert.deepEqual(waiting.items[0].order, {
        id: `order-3-${runId}`,
        number: '03-CRM',
        status: 'confirmado',
      });
      assert.equal(waiting.items[1].order, null);

      const firstWaiting = await reads.listInbox({
        limit: 1,
        pendingHandoff: true,
      });
      assert.equal(firstWaiting.items[0].id, waitingOld);
      const secondWaiting = await reads.listInbox({
        cursor: firstWaiting.nextCursor,
        limit: 1,
        pendingHandoff: true,
      });
      assert.deepEqual(
        secondWaiting.items.map((/** @type {any} */ item) => item.id),
        [waitingNew],
      );
      assert.equal(secondWaiting.nextCursor, null);

      const notWaiting = await reads.listInbox({ pendingHandoff: false });
      assert.deepEqual(
        notWaiting.items.map((/** @type {any} */ item) => item.id),
        [primary],
      );
      assert.deepEqual(notWaiting.items[0].order, {
        id: `order-2-${runId}`,
        number: '02-CRM',
        status: 'pendente',
      });
      assert.equal(notWaiting.items[0].handoff.reasonCode, 'briefing_complete');
      assert.equal(notWaiting.items[0].handoff.status, 'accepted');

      // Existing filters keep working, alone and combined with the new one.
      const withSeller = await reads.listInbox({ automationState: 'human' });
      assert.deepEqual(
        withSeller.items.map((/** @type {any} */ item) => item.id),
        [primary],
      );
      const withAgent = await reads.listInbox({
        automationState: 'assistant',
      });
      assert.deepEqual(
        withAgent.items.map((/** @type {any} */ item) => item.id),
        [waitingOld, waitingNew],
        'the default order is still the last message',
      );
      const mine = await reads.listInbox({ assignedUserId: sellerId });
      assert.deepEqual(
        mine.items.map((/** @type {any} */ item) => item.id),
        [primary],
      );
      const unassigned = await reads.listInbox({
        unassignedHumanHandoff: true,
      });
      assert.deepEqual(
        unassigned.items.map((/** @type {any} */ item) => item.id).sort(),
        [waitingNew, waitingOld].sort(),
      );
      assert.equal(
        (
          await reads.listInbox({
            assignedUserId: sellerId,
            pendingHandoff: true,
          })
        ).totalCount,
        0,
      );
      await pool.query(
        'UPDATE crm.conversations SET archived_at = $2 WHERE id = $1',
        [waitingNew, NOW],
      );
      const archived = await reads.listInbox({ archived: true });
      assert.deepEqual(
        archived.items.map((/** @type {any} */ item) => item.id),
        [waitingNew],
      );
      assert.deepEqual(
        (await reads.listInbox({ pendingHandoff: true })).items.map(
          (/** @type {any} */ item) => item.id,
        ),
        [waitingOld],
      );
      const detail = await reads.getConversation({ conversationId: primary });
      assert.deepEqual(detail.conversation.order, {
        id: `order-2-${runId}`,
        number: '02-CRM',
        status: 'pendente',
      });
      assert.equal(detail.conversation.handoff.reasonCode, 'briefing_complete');

      // INBOX-HANDOFF-01: the summary the n8n agent stored, as it stores it.
      const summarized = await openConversation(
        'summarized',
        '2026-09-08T12:20:00.000Z',
      );
      const summary =
        'Motivo: Perguntou o valor. Ficha: 5 de 9 (56%). Dica: Possível parceria/revenda.';
      await pool.query(
        `INSERT INTO crm.handoffs
           (id, conversation_id, status, version, reason_code,
            summary_envelope, due_at, sla_minutes, sla_policy_version,
            created_at, updated_at, target_role)
         VALUES ($1, $2, 'pending', 1, 'price_before_quote', $3::jsonb,
                 $4::timestamptz + interval '4 hours', 240, 'n8n-mvp-1',
                 $4, $4, 'Vendedor')`,
        [
          `handoff-summarized-${runId}`,
          summarized,
          JSON.stringify(
            encryptJson(
              summary,
              `${summarized}:handoff:summary`,
              Buffer.alloc(32, 46),
            ),
          ),
          '2026-09-08T11:00:00.000Z',
        ],
      );
      const open = await reads.getConversationHandoff({
        conversationId: summarized,
      });
      assert.equal(open.handoff.id, `handoff-summarized-${runId}`);
      assert.equal(open.handoff.status, 'pending');
      assert.equal(open.handoff.summary, summary);
      const withoutHandoff = await openConversation(
        'nohandoff',
        '2026-09-08T12:25:00.000Z',
      );
      assert.deepEqual(
        await reads.getConversationHandoff({ conversationId: withoutHandoff }),
        { handoff: null, preferred_seller: null },
      );
      await pool.query(
        `UPDATE crm.handoffs SET status = 'resolved', assigned_user_id = $2,
             resolved_at = updated_at
         WHERE id = $1`,
        [`handoff-summarized-${runId}`, sellerId],
      );
      assert.deepEqual(
        await reads.getConversationHandoff({ conversationId: summarized }),
        { handoff: null, preferred_seller: null },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
} else {
  test('PostgreSQL operation read test requires TEST_DATABASE_URL', {
    skip: true,
  });
}

/** @param {string} runId @param {string} suffix */
function identityInput(runId, suffix) {
  return {
    channel: 'instagram',
    correlationId: `correlation-${suffix}-${runId}`,
    displayHandle: `@${suffix}_${runId.slice(0, 8)}`,
    externalIdentityId: `identity-${suffix}-${runId}`,
    identityKind: 'handle',
    occurredAt: NOW.toISOString(),
    phoneStatus: 'pending',
    provider: 'meta',
    providerAccountId: `account-${suffix}-${runId}`,
  };
}
