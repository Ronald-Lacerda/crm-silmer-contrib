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
      assert.equal(conversation.conversation.hasPendingOrder, false);

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
      assert.equal(
        (await reads.getConversation({ conversationId: primary })).conversation
          .hasPendingOrder,
        true,
      );
      assert.equal(
        (await reads.getConversation({ conversationId: waitingOld }))
          .conversation.hasPendingOrder,
        false,
      );

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
        readyForConfirmation: false,
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
        readyForConfirmation: false,
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
        readyForConfirmation: false,
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

      // INBOX-UX-02: a queue is filtered before count, limit and cursor.
      // Automatic notices do not erase the customer's wait for a person.
      /** @param {string} conversationId @param {string} suffix @param {'inbound'|'outbound'} direction @param {'contact'|'human'|'assistant'} authorKind @param {string} occurredAt @param {string} [status] */
      const addMessage = async (
        conversationId,
        suffix,
        direction,
        authorKind,
        occurredAt,
        status = 'sent',
      ) => {
        const id = `priority-${suffix}-${runId}`;
        await pool.query(
          `INSERT INTO crm.messages
             (id,conversation_id,provider,provider_account_id,external_message_id,
              command_id,direction,author_kind,author_id,message_type,
              content_envelope,key_version,status,occurred_at,created_at)
           SELECT $1,id,provider,provider_account_id,$3,$4,$5,$6,$7,'text',$8::jsonb,
                  1,$9,$10,$10 FROM crm.conversations WHERE id=$2`,
          [
            id,
            conversationId,
            direction === 'inbound' ? id : null,
            direction === 'outbound' ? id : null,
            direction,
            authorKind,
            authorKind === 'human' ? sellerId : 'synthetic',
            JSON.stringify(
              encryptJson(
                { text: 'Mensagem sintética de prioridade' },
                `message:${id}`,
                MESSAGE_KEY,
              ),
            ),
            direction === 'inbound' ? 'received' : status,
            occurredAt,
          ],
        );
        await pool.query(
          'UPDATE crm.conversations SET last_message_at=$2 WHERE id=$1',
          [conversationId, occurredAt],
        );
      };
      await addMessage(
        primary,
        'human-reply',
        'outbound',
        'human',
        '2026-09-08T12:40:00.000Z',
      );
      await addMessage(
        primary,
        'first-inbound',
        'inbound',
        'contact',
        '2026-09-08T13:00:00.000Z',
      );
      await addMessage(
        primary,
        'second-inbound',
        'inbound',
        'contact',
        '2026-09-08T13:05:00.000Z',
      );
      await addMessage(
        primary,
        'automatic-notice',
        'outbound',
        'assistant',
        '2026-09-08T13:07:00.000Z',
      );
      const attention = await reads.listInbox(
        { workQueue: 'attention', limit: 1 },
        { actorId: sellerId },
      );
      assert.equal(
        attention.totalCount,
        2,
        "only the unassigned handoff and this seller's unanswered client",
      );
      assert.equal(attention.items[0].id, waitingOld);
      assert.equal(attention.items[0].waitingSince, '2026-09-08T08:00:00.000Z');
      const attentionNext = await reads.listInbox(
        { workQueue: 'attention', limit: 1, cursor: attention.nextCursor },
        { actorId: sellerId },
      );
      assert.equal(attentionNext.items[0].id, primary);
      assert.equal(
        attentionNext.items[0].waitingSince,
        '2026-09-08T13:00:00.000Z',
      );
      assert.equal(attentionNext.nextCursor, null);
      assert.equal(attentionNext.items[0].assignedUser.name, 'Vendedora Inbox');
      await assert.rejects(
        reads.listInbox(
          { workQueue: 'attention', cursor: attention.nextCursor },
          { actorId: 'another-seller' },
        ),
        { code: 'INVALID_CURSOR' },
      );

      // An empty default array on an old/incomplete record is not enough.
      assert.equal(
        (await reads.listInbox({ workQueue: 'closing' }, { actorId: sellerId }))
          .totalCount,
        0,
      );

      await pool.query(
        `UPDATE crm.orders SET missing_fields='{}',total_pieces=1,
        final_amount_cents=1000,payment_condition='pix' WHERE id=$1`,
        [`order-2-${runId}`],
      );
      const closing = await reads.listInbox(
        { workQueue: 'closing' },
        { actorId: sellerId },
      );
      assert.equal(closing.totalCount, 1);
      assert.equal(closing.items[0].id, primary);
      assert.equal(closing.items[0].order.readyForConfirmation, true);
      await pool.query(
        "UPDATE crm.orders SET missing_fields=ARRAY['ficha.artwork'] WHERE id=$1",
        [`order-2-${runId}`],
      );
      assert.equal(
        (await reads.listInbox({ workQueue: 'closing' }, { actorId: sellerId }))
          .totalCount,
        0,
      );
      await pool.query(
        "UPDATE crm.orders SET missing_fields='{}' WHERE id=$1",
        [`order-2-${runId}`],
      );
      assert.equal(
        (
          await reads.listInbox(
            { workQueue: 'closing' },
            { actorId: 'another-seller' },
          )
        ).totalCount,
        0,
      );

      // An outbound failure remains visible after another client message.
      await addMessage(
        primary,
        'failed-human',
        'outbound',
        'human',
        '2026-09-08T13:10:00.000Z',
        'outcome_unknown',
      );
      await addMessage(
        primary,
        'after-failure',
        'inbound',
        'contact',
        '2026-09-08T13:11:00.000Z',
      );
      const failed = await reads.getConversation({ conversationId: primary });
      assert.equal(failed.conversation.deliveryIssue.status, 'outcome_unknown');
      assert.equal(
        failed.conversation.waitingSince,
        '2026-09-08T13:00:00.000Z',
      );
      await addMessage(
        primary,
        'queued-after-uncertain',
        'outbound',
        'human',
        '2026-09-08T13:12:00.000Z',
        'queued',
      );
      assert.equal(
        (await reads.getConversation({ conversationId: primary })).conversation
          .deliveryIssue.status,
        'outcome_unknown',
      );
      await addMessage(
        primary,
        'sending-after-uncertain',
        'outbound',
        'human',
        '2026-09-08T13:13:00.000Z',
        'sending',
      );
      assert.equal(
        (await reads.getConversation({ conversationId: primary })).conversation
          .deliveryIssue.status,
        'outcome_unknown',
      );
      await addMessage(
        primary,
        'resolved-human',
        'outbound',
        'human',
        '2026-09-08T13:15:00.000Z',
      );
      const answered = await reads.getConversation({ conversationId: primary });
      assert.equal(answered.conversation.waitingSince, null);
      assert.equal(answered.conversation.deliveryIssue, null);
      assert.equal(
        (
          await reads.listInbox(
            { workQueue: 'attention' },
            { actorId: sellerId },
          )
        ).totalCount,
        1,
      );
      assert.equal(
        (await reads.listInbox({ workQueue: 'closing' }, { actorId: sellerId }))
          .totalCount,
        1,
      );
      await pool.query(
        "UPDATE crm.conversations SET state='encerrada',terminal_at=$2,closure_outcome='concluido',closed_by=$3 WHERE id=$1",
        [primary, '2026-09-08T13:16:00.000Z', sellerId],
      );
      assert.equal(
        (await reads.listInbox({ workQueue: 'closing' }, { actorId: sellerId }))
          .totalCount,
        0,
      );

      // Claim preserves the handoff clock, not the much older bot message.
      const claimedCycle = await openConversation(
        'claimed-anchor',
        '2026-09-01T08:00:00.000Z',
      );
      await addMessage(
        claimedCycle,
        'old-bot',
        'outbound',
        'assistant',
        '2026-09-07T08:00:00.000Z',
      );
      await insertHandoff(
        'anchor',
        claimedCycle,
        'unsupported',
        '2026-09-08T09:00:00.000Z',
        'pending',
      );
      const beforeClaim = await reads.getConversation({
        conversationId: claimedCycle,
      });
      assert.equal(
        beforeClaim.conversation.waitingSince,
        '2026-09-08T09:00:00.000Z',
      );
      await pool.query(
        "UPDATE crm.handoffs SET status='accepted',assigned_user_id=$2 WHERE conversation_id=$1",
        [claimedCycle, sellerId],
      );
      await pool.query(
        "UPDATE crm.conversations SET assigned_user_id=$2,automation_state='human',state='em_atendimento' WHERE id=$1",
        [claimedCycle, sellerId],
      );
      assert.equal(
        (await reads.getConversation({ conversationId: claimedCycle }))
          .conversation.waitingSince,
        '2026-09-08T09:00:00.000Z',
      );
      await addMessage(
        claimedCycle,
        'first-claim-reply',
        'outbound',
        'human',
        '2026-09-08T09:10:00.000Z',
      );
      assert.equal(
        (await reads.getConversation({ conversationId: claimedCycle }))
          .conversation.waitingSince,
        null,
      );
      await addMessage(
        claimedCycle,
        'new-claim-inbound',
        'inbound',
        'contact',
        '2026-09-08T09:15:00.000Z',
      );
      assert.equal(
        (await reads.getConversation({ conversationId: claimedCycle }))
          .conversation.waitingSince,
        '2026-09-08T09:15:00.000Z',
      );

      // Direct takeover has its own audit anchor. Without that evidence no
      // duration is invented from messages the bot handled days earlier.
      const directCycle = await openConversation(
        'direct-anchor',
        '2026-09-01T08:00:00.000Z',
      );
      await addMessage(
        directCycle,
        'direct-old-bot',
        'outbound',
        'assistant',
        '2026-09-07T08:00:00.000Z',
      );
      await pool.query(
        "UPDATE crm.conversations SET assigned_user_id=$2,automation_state='human',state='em_atendimento' WHERE id=$1",
        [directCycle, sellerId],
      );
      assert.equal(
        (await reads.getConversation({ conversationId: directCycle }))
          .conversation.waitingSince,
        null,
      );
      await pool.query(
        `INSERT INTO crm.audit_events
        (id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at)
        VALUES ($1,$2,'conversation.takeover','conversation',$3,'2','human_takeover',$1,$4)`,
        [
          `takeover-${runId}`,
          sellerId,
          directCycle,
          '2026-09-08T10:00:00.000Z',
        ],
      );
      assert.equal(
        (await reads.getConversation({ conversationId: directCycle }))
          .conversation.waitingSince,
        '2026-09-08T10:00:00.000Z',
      );
      await addMessage(
        directCycle,
        'direct-first-reply',
        'outbound',
        'human',
        '2026-09-08T10:10:00.000Z',
      );
      assert.equal(
        (await reads.getConversation({ conversationId: directCycle }))
          .conversation.waitingSince,
        null,
      );

      // A newer, incomplete canonical order must not hide a ready order
      // linked from another cycle owned by this same seller.
      const readySource = await openConversation(
        'ready-source',
        '2026-09-08T09:00:00.000Z',
      );
      const linkedCycle = await openConversation(
        'linked-current',
        '2026-09-08T10:00:00.000Z',
      );
      await pool.query(
        `UPDATE crm.contact_identities current_identity
        SET current_contact_id=source_identity.current_contact_id
        FROM crm.conversations source,crm.contact_identities source_identity,
             crm.conversations current_cycle
        WHERE source.id=$1 AND source_identity.id=source.contact_identity_id
          AND current_cycle.id=$2 AND current_identity.id=current_cycle.contact_identity_id`,
        [readySource, linkedCycle],
      );
      await pool.query(
        "UPDATE crm.conversations SET assigned_user_id=$2,automation_state='human',state='em_atendimento' WHERE id=ANY($1::text[])",
        [[readySource, linkedCycle], sellerId],
      );
      await insertOrder(4, readySource, 'pendente');
      await insertOrder(5, linkedCycle, 'pendente');
      await pool.query(
        `UPDATE crm.orders SET total_pieces=1,final_amount_cents=1000,payment_condition='pix'
        WHERE id=$1`,
        [`order-4-${runId}`],
      );
      await pool.query(
        `INSERT INTO crm.conversation_subjects
        (id,conversation_id,contact_id,order_id,kind,position,is_current,created_by,created_by_kind,created_at,updated_at)
        SELECT $1,conversation.id,identity.current_contact_id,$3,'pedido',1,false,$4,'human',$5,$5
        FROM crm.conversations conversation JOIN crm.contact_identities identity ON identity.id=conversation.contact_identity_id
        WHERE conversation.id=$2`,
        [
          `subject-review-${runId}`,
          linkedCycle,
          `order-4-${runId}`,
          sellerId,
          NOW,
        ],
      );
      const linkedDetail = await reads.getConversation({
        conversationId: linkedCycle,
      });
      assert.equal(linkedDetail.conversation.order.id, `order-5-${runId}`);
      assert.equal(linkedDetail.conversation.order.readyForConfirmation, false);
      assert.deepEqual(linkedDetail.conversation.reviewOrder, {
        id: `order-4-${runId}`,
        number: '04-CRM',
        status: 'pendente',
        readyForConfirmation: true,
      });
      const readyQueue = await reads.listInbox(
        { workQueue: 'closing' },
        { actorId: sellerId },
      );
      assert.equal(readyQueue.totalCount, 2);
      assert.ok(
        readyQueue.items.some(
          (/** @type {any} */ item) =>
            item.id === linkedCycle &&
            item.reviewOrder.id === `order-4-${runId}`,
        ),
      );
      const otherSellerId = `other-seller-${runId}`;
      await pool.query(
        "INSERT INTO crm.users (id,email,password_hash,name) VALUES ($1,$2,'$argon2id$synthetic','Outro vendedor sintético')",
        [otherSellerId, `${otherSellerId}@example.test`],
      );
      await pool.query(
        'UPDATE crm.conversations SET assigned_user_id=$2 WHERE id=$1',
        [readySource, otherSellerId],
      );
      assert.equal(
        (await reads.getConversation({ conversationId: linkedCycle }))
          .conversation.reviewOrder,
        null,
      );
      assert.equal(
        (await reads.listInbox({ workQueue: 'closing' }, { actorId: sellerId }))
          .totalCount,
        0,
      );

      // CP-10 / INBOX-UX-03: an incomplete order from another cycle must
      // still require acknowledgement when it is linked only by a subject.
      // It is intentionally not an actionable reviewOrder or canonical order.
      const pendingSourceCycle = await openConversation(
        'subject-only-source',
        '2026-09-08T10:00:00.000Z',
      );
      const subjectOnlyCycle = await openConversation(
        'subject-only-pending',
        '2026-09-08T11:00:00.000Z',
      );
      await pool.query(
        `UPDATE crm.contact_identities target_identity
         SET current_contact_id=source_identity.current_contact_id
         FROM crm.conversations source,crm.contact_identities source_identity,
              crm.conversations target
         WHERE source.id=$1 AND source_identity.id=source.contact_identity_id
           AND target.id=$2 AND target_identity.id=target.contact_identity_id`,
        [pendingSourceCycle, subjectOnlyCycle],
      );
      await insertOrder(6, pendingSourceCycle, 'pendente');
      await pool.query(
        `INSERT INTO crm.conversation_subjects
         (id,conversation_id,contact_id,order_id,kind,position,is_current,created_by,created_by_kind,created_at,updated_at)
         SELECT $1,conversation.id,identity.current_contact_id,$3,'pedido',1,false,$4,'human',$5,$5
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity ON identity.id=conversation.contact_identity_id
         WHERE conversation.id=$2`,
        [
          `subject-pending-only-${runId}`,
          subjectOnlyCycle,
          `order-6-${runId}`,
          sellerId,
          NOW,
        ],
      );
      const subjectOnly = await reads.getConversation({
        conversationId: subjectOnlyCycle,
      });
      assert.equal(subjectOnly.conversation.order, null);
      assert.equal(subjectOnly.conversation.reviewOrder, null);
      assert.equal(subjectOnly.conversation.hasPendingOrder, true);
      const allConversations = await reads.listInbox({ limit: 100 });
      assert.equal(
        allConversations.items.find(
          (/** @type {any} */ item) => item.id === subjectOnlyCycle,
        ).hasPendingOrder,
        true,
      );
      await insertOrder(7, pendingSourceCycle, 'confirmado');
      await pool.query(
        'UPDATE crm.conversation_subjects SET order_id=$2 WHERE id=$1',
        [`subject-pending-only-${runId}`, `order-7-${runId}`],
      );
      assert.equal(
        (await reads.getConversation({ conversationId: subjectOnlyCycle }))
          .conversation.hasPendingOrder,
        false,
      );

      // PCX-17 / INBOX-UX-05: a global ranked read is ordered before LIMIT,
      // including other owners, agent conversations and closed cycles.
      const otherSeller = `urgency-other-${runId}`;
      await pool.query(
        `INSERT INTO crm.users (id,email,password_hash,name)
         VALUES ($1,$2,'$argon2id$synthetic','Outro vendedor sintético')`,
        [otherSeller, `${otherSeller}@example.test`],
      );
      await pool.query(
        "INSERT INTO crm.user_functions (user_id,function_name) VALUES ($1,'Vendedor')",
        [otherSeller],
      );
      const rankIds = /** @type {Record<string, string>} */ ({});
      /** @param {string} label @param {boolean} [human] */
      const rankedConversation = async (label, human = true) => {
        const id = await openConversation(
          `rank-${label}`,
          '2026-09-08T06:00:00.000Z',
        );
        rankIds[label] = id;
        if (human)
          await pool.query(
            "UPDATE crm.conversations SET automation_state='human',assigned_user_id=$2 WHERE id=$1",
            [id, otherSeller],
          );
        return id;
      };
      const delivery = await rankedConversation('delivery');
      await addMessage(
        delivery,
        'rank-failure',
        'outbound',
        'human',
        '2026-09-08T14:00:00.000Z',
        'outcome_unknown',
      );
      await addMessage(
        delivery,
        'rank-queued',
        'outbound',
        'human',
        '2026-09-08T14:01:00.000Z',
        'queued',
      );
      const urgent = await rankedConversation('urgent', false);
      await insertHandoff(
        'rank-urgent',
        urgent,
        'urgency',
        '2026-09-08T11:00:00.000Z',
        'pending',
      );
      const pendingA = await rankedConversation('pending-a', false);
      const pendingB = await rankedConversation('pending-b', false);
      for (const [label, id] of [
        ['a', pendingA],
        ['b', pendingB],
      ])
        await insertHandoff(
          `rank-pending-${label}`,
          id,
          'customer_requested_human',
          label === 'a'
            ? '2026-09-08T09:00:00.000111Z'
            : '2026-09-08T09:00:00.000999Z',
          'pending',
        );
      const legacyWait = await rankedConversation('legacy-wait');
      assert.equal(
        (await reads.getConversation({ conversationId: legacyWait }))
          .conversation.waitingSince,
        null,
      );
      const humanWait = await rankedConversation('human-wait');
      await addMessage(
        humanWait,
        'rank-human-answered',
        'outbound',
        'human',
        '2026-09-08T12:00:00.000Z',
      );
      await addMessage(
        humanWait,
        'rank-human-unanswered',
        'inbound',
        'contact',
        '2026-09-08T13:00:00.000Z',
      );
      await addMessage(
        humanWait,
        'rank-human-bot',
        'outbound',
        'assistant',
        '2026-09-08T15:00:00.000Z',
      );
      const ready = await rankedConversation('ready');
      await addMessage(
        ready,
        'rank-ready-answered',
        'outbound',
        'human',
        '2026-09-08T12:00:00.000Z',
      );
      await insertOrder(20, ready, 'pendente');
      await pool.query(
        "UPDATE crm.orders SET missing_fields='{}',total_pieces=1,final_amount_cents=1000,payment_condition='pix' WHERE id=$1",
        [`order-20-${runId}`],
      );
      const activeHuman = await rankedConversation('active-human');
      await addMessage(
        activeHuman,
        'rank-active-answered',
        'outbound',
        'human',
        '2026-09-08T12:00:00.000Z',
      );
      const urgentAnswered = await rankedConversation('urgent-answered');
      await insertHandoff(
        'rank-urgent-answered',
        urgentAnswered,
        'urgency',
        '2026-09-08T09:00:00.000Z',
        'accepted',
      );
      await addMessage(
        urgentAnswered,
        'rank-urgent-answered',
        'outbound',
        'human',
        '2026-09-08T12:00:00.000Z',
      );
      const agent = await rankedConversation('agent', false);
      const closed = await rankedConversation('closed');
      await addMessage(
        closed,
        'rank-closed-failure',
        'outbound',
        'human',
        '2026-09-08T16:00:00.000Z',
        'failed',
      );
      await pool.query(
        "UPDATE crm.conversations SET state='encerrada',terminal_at=$2,closure_outcome='concluido',closed_by=$3 WHERE id=$1",
        [closed, '2026-09-08T16:01:00.000Z', otherSeller],
      );
      const archivedFailure = await rankedConversation('archived');
      await addMessage(
        archivedFailure,
        'rank-archived-failure',
        'outbound',
        'human',
        '2026-09-08T16:00:00.000Z',
        'failed',
      );
      await pool.query(
        'UPDATE crm.conversations SET archived_at=$2 WHERE id=$1',
        [archivedFailure, NOW],
      );
      const urgencyInput = { sort: 'urgency', limit: 100 };
      const access = { actorId: sellerId };
      const ranked = await reads.listInbox(urgencyInput, access);
      const expectedRanked = [
        delivery,
        urgent,
        legacyWait,
        ...[pendingA, pendingB].sort(),
        humanWait,
        ready,
        ...[activeHuman, urgentAnswered].sort(),
        agent,
        closed,
      ];
      const newIds = new Set(Object.values(rankIds));
      assert.deepEqual(
        ranked.items
          .filter((/** @type {any} */ item) => newIds.has(item.id))
          .map((/** @type {any} */ item) => item.id),
        expectedRanked,
      );
      assert.equal(
        ranked.items.some(
          (/** @type {any} */ item) => item.id === archivedFailure,
        ),
        false,
      );
      assert.equal(
        ranked.items.find((/** @type {any} */ item) => item.id === delivery)
          .assignedUser.id,
        otherSeller,
      );
      assert.equal(ranked.totalCount, ranked.items.length);
      assert.equal(
        (await reads.listInbox({}, access)).totalCount,
        ranked.totalCount,
        'sort adds no hidden filter',
      );
      const seen = /** @type {string[]} */ ([]);
      let rankedCursor = /** @type {string|null} */ (null);
      do {
        const page = await reads.listInbox(
          {
            sort: 'urgency',
            limit: 1,
            ...(rankedCursor ? { cursor: rankedCursor } : {}),
          },
          access,
        );
        assert.equal(page.totalCount, ranked.totalCount);
        assert.equal(page.items.length, 1);
        seen.push(page.items[0].id);
        rankedCursor = page.nextCursor;
        assert.equal(
          new Set(seen).size,
          seen.length,
          'keyset must not repeat ties or previous groups',
        );
        assert.ok(seen.length <= ranked.totalCount);
      } while (rankedCursor);
      assert.deepEqual(
        seen,
        ranked.items.map((/** @type {any} */ item) => item.id),
        'limit=1 reaches every rank and equal-position tie',
      );
      const firstRanked = await reads.listInbox(
        { sort: 'urgency', limit: 1 },
        access,
      );
      assert.ok(firstRanked.nextCursor);
      for (const [
        input,
        actorId,
      ] of /** @type {Array<[Record<string, any>, string]>} */ ([
        [{}, sellerId],
        [{ sort: 'urgency' }, otherSeller],
        [{ sort: 'urgency', assignedUserId: otherSeller }, sellerId],
      ]))
        await assert.rejects(
          reads.listInbox(
            { ...input, cursor: firstRanked.nextCursor },
            { actorId },
          ),
          { code: 'INVALID_CURSOR' },
        );
      const archivedUrgency = await reads.listInbox(
        { sort: 'urgency', archived: true },
        access,
      );
      assert.ok(
        archivedUrgency.items.some(
          (/** @type {any} */ item) => item.id === archivedFailure,
        ),
      );
      assert.equal(
        archivedUrgency.totalCount,
        (await reads.listInbox({ archived: true })).totalCount,
      );
      const explicitOwner = await reads.listInbox(
        { sort: 'urgency', assignedUserId: otherSeller },
        access,
      );
      assert.equal(
        explicitOwner.totalCount,
        (await reads.listInbox({ assignedUserId: otherSeller })).totalCount,
      );
      assert.ok(
        explicitOwner.items.every(
          (/** @type {any} */ item) => item.assignedUser.id === otherSeller,
        ),
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
    displayHandle: `@${suffix.replaceAll('-', '_')}_${runId.slice(0, 8)}`,
    externalIdentityId: `identity-${suffix}-${runId}`,
    identityKind: 'handle',
    occurredAt: NOW.toISOString(),
    phoneStatus: 'pending',
    provider: 'meta',
    providerAccountId: `account-${suffix}-${runId}`,
  };
}
