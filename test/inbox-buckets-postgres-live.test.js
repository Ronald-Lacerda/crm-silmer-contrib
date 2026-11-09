import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
/** Sunday 08/11/2026 12:00 in São Paulo: outside business hours. */
const NOW = new Date('2026-11-08T15:00:00.000Z');
const CONTACT_KEY = Buffer.alloc(32, 52);
const MESSAGE_KEY = Buffer.alloc(32, 51);
const STALL_MINUTES = 5;
const HOUR = 60;

/** @param {number} minutes minutes before NOW */
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000);

test(
  'INBOX-VEZ-01 PostgreSQL: tabs by whose turn it is, counts, order, cursor, filters and detail',
  { skip: !connectionString },
  async (t) => {
    assert.match(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
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

    const runId = randomUUID().slice(0, 8);
    const lookupKey = Buffer.alloc(32, 53);
    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey,
      }),
    });
    const inbox = createInboxService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: MESSAGE_KEY,
        outboundMessageOutbox: { enqueueChannelMessage: async () => undefined },
      }),
    });
    const reads = createOperationReadService({
      clock: () => NOW,
      contactRepository: new PostgresContactReadRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey,
      }),
      cursorKey: Buffer.alloc(32, 54),
      handoffRepository: new PostgresHandoffReadRepository({
        contactEnvelopeKey: CONTACT_KEY,
        database,
        handoffEnvelopeKey: Buffer.alloc(32, 55),
        n8nEnvelopeKey: Buffer.alloc(32, 56),
      }),
      inboxRepository: new PostgresInboxReadRepository({
        contactEnvelopeKey: CONTACT_KEY,
        database,
        messageEnvelopeKey: MESSAGE_KEY,
      }),
      stallMinutes: STALL_MINUTES,
    });

    /** @param {string} label */
    async function seller(label) {
      const id = `${label}-vez-${runId}`;
      await pool.query(
        `INSERT INTO crm.users (id, email, password_hash, name)
         VALUES ($1, $2, '$argon2id$synthetic', $3)`,
        [id, `${id}@example.test`, `Pessoa ${label}`],
      );
      await pool.query(
        `INSERT INTO crm.user_functions (user_id, function_name)
         VALUES ($1, 'Vendedor')`,
        [id],
      );
      return id;
    }
    const A = await seller('a');
    const B = await seller('b');
    const OWNER = /** @type {Record<string, string|null>} */ ({
      A,
      B,
      none: null,
    });

    /** @type {Map<string, string>} */
    const labelById = new Map();
    /** @type {Map<string, any>} */
    const firstInbound = new Map();
    /** Fixture timestamps, independent of the repository's SQL projections.
     * @type {Map<string, number>} */
    const latestMessageMinutesAgo = new Map();
    let sequence = 0;

    /** A fresh conversation with its first customer message.
     * @param {string} label @param {number} inboundMinutesAgo */
    async function open(label, inboundMinutesAgo) {
      const when = ago(inboundMinutesAgo).toISOString();
      const identity = await contacts.resolveInboundIdentity({
        channel: 'instagram',
        correlationId: `contact-${runId}-${label}`,
        displayHandle: `@vez_${label}`,
        externalIdentityId: `identity-${runId}-${label}`,
        identityKind: 'handle',
        occurredAt: when,
        phoneStatus: 'pending',
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const input = {
        contactId: identity.contact.id,
        correlationId: `inbound-${runId}-${label}`,
        externalConversationId: `external-${runId}-${label}`,
        externalMessageId: `inbound-${runId}-${label}-0`,
        identityId: identity.identity.id,
        message: { content: { text: 'Mensagem sintética' }, type: 'text' },
        occurredAt: when,
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      };
      const received = await inbox.receiveInbound(input);
      const id = /** @type {string} */ (received.conversation.id);
      labelById.set(id, label);
      firstInbound.set(id, input);
      latestMessageMinutesAgo.set(id, inboundMinutesAgo);
      return id;
    }
    /** Another customer message, through the real inbound path.
     * @param {string} id @param {number} minutesAgo */
    async function customer(id, minutesAgo) {
      await inbox.receiveInbound({
        ...firstInbound.get(id),
        externalMessageId: `inbound-${runId}-${(sequence += 1)}`,
        occurredAt: ago(minutesAgo).toISOString(),
      });
      latestMessageMinutesAgo.set(
        id,
        Math.min(latestMessageMinutesAgo.get(id) ?? Infinity, minutesAgo),
      );
    }
    /** @param {string} id */
    async function lastInboundId(id) {
      return (
        await pool.query(
          `SELECT id FROM crm.messages
           WHERE conversation_id=$1 AND direction='inbound'
           ORDER BY occurred_at DESC, id DESC LIMIT 1`,
          [id],
        )
      ).rows[0].id;
    }
    /** @param {string} id @param {{minutesAgo: number, author?: 'human'|'assistant'|'system', status?: 'sent'|'delivered'|'read'|'failed'|'outcome_unknown'|'queued'}} options */
    async function outbound(
      id,
      { minutesAgo, author = 'human', status = 'sent' },
    ) {
      const messageId = `message-${runId}-${(sequence += 1)}`;
      const at = ago(minutesAgo).toISOString();
      const ok = ['sent', 'delivered', 'read'].includes(status);
      const failed = ['failed', 'outcome_unknown'].includes(status);
      await pool.query(
        `INSERT INTO crm.messages
           (id,conversation_id,provider,provider_account_id,external_message_id,
            command_id,direction,author_kind,author_id,message_type,
            content_envelope,key_version,status,delivery_status,delivery_status_at,
            sent_at,occurred_at,created_at)
         SELECT $1,id,provider,provider_account_id,NULL,$1,'outbound',$3,$4,'text',$5::jsonb,
                1,$6,$7::text,CASE WHEN $7::text IS NULL THEN NULL ELSE $8::timestamptz END,
                CASE WHEN $6='sent' THEN $8::timestamptz END,$8,$8
         FROM crm.conversations WHERE id=$2`,
        [
          messageId,
          id,
          author,
          author === 'human' ? A : `${author}-synthetic`,
          JSON.stringify(
            encryptJson(
              { text: 'Resposta sintética' },
              `message:${messageId}`,
              MESSAGE_KEY,
            ),
          ),
          ok ? 'sent' : status,
          ok || failed ? status : null,
          at,
        ],
      );
      // Real outbound writes advance the conversation's message timestamp.
      await pool.query(
        `UPDATE crm.conversations
         SET last_message_at=greatest(last_message_at, $2::timestamptz)
         WHERE id=$1`,
        [id, at],
      );
      latestMessageMinutesAgo.set(
        id,
        Math.min(latestMessageMinutesAgo.get(id) ?? Infinity, minutesAgo),
      );
      return messageId;
    }
    /** @param {string} id @param {'pending'|'accepted'} status @param {number} minutesAgo */
    async function handoff(id, status, minutesAgo) {
      await pool.query(
        `INSERT INTO crm.handoffs
           (id, conversation_id, assigned_user_id, status, version, reason_code,
            summary_envelope, due_at, sla_minutes, sla_policy_version,
            created_at, updated_at, target_role)
         VALUES ($1, $2, $3, $4, 1, 'customer_requested_human',
                 '{"algorithm":"AES-256-GCM","version":"1"}'::jsonb,
                 $5::timestamptz + interval '30 minutes', 30, 'v1', $5, $5,
                 'Vendedor')`,
        [
          `handoff-${runId}-${(sequence += 1)}`,
          id,
          status === 'accepted' ? A : null,
          status,
          ago(minutesAgo).toISOString(),
        ],
      );
    }
    /** @param {string} id @param {{version: number, minutesAgo: number, outcome?: 'lost'|'reopened', reason?: string, over?: string|null}} options */
    async function outcome(
      id,
      { version, minutesAgo, outcome = 'lost', reason = 'preco', over },
    ) {
      await pool.query(
        `INSERT INTO crm.lead_outcome_events
           (id, conversation_id, version, outcome, reason_code, owner_id,
            actor_id, last_inbound_message_id, correlation_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
        [
          `outcome-${runId}-${(sequence += 1)}`,
          id,
          version,
          outcome,
          outcome === 'lost' ? reason : null,
          A,
          outcome === 'lost' ? (over ?? (await lastInboundId(id))) : null,
          `correlation-${runId}-${sequence}`,
          ago(minutesAgo).toISOString(),
        ],
      );
    }
    /** @param {string} id @param {string} user @param {{minutesAhead: number, version?: number, decision?: 'schedule'|'snooze'}} options */
    async function reminder(
      id,
      user,
      { minutesAhead, version, decision = 'schedule' },
    ) {
      const current = Number(
        (
          await pool.query(
            'SELECT version FROM crm.conversations WHERE id=$1',
            [id],
          )
        ).rows[0].version,
      );
      await pool.query(
        `INSERT INTO crm.dashboard_action_decisions
           (user_id, action_id, target_type, target_id, target_version,
            source_revision, decision, remind_at, version, created_at, updated_at)
         VALUES ($1,$2,'conversation',$3,$4,'message:synthetic:sent:sent',$5,$6,1,$7,$7)`,
        [
          user,
          `conversation:${id}`,
          id,
          version ?? current,
          decision,
          new Date(NOW.getTime() + minutesAhead * 60_000).toISOString(),
          ago(1).toISOString(),
        ],
      );
    }
    /** @param {string} id */
    async function readyOrder(id) {
      const number = (sequence += 1);
      await pool.query(
        `INSERT INTO crm.orders
           (id, number_sequence, number, conversation_id, contact_id, status,
            fab_code, ficha_envelope, created_by_kind, created_at, updated_at,
            total_pieces, missing_fields, final_amount_cents, payment_condition)
         SELECT $1, $2::bigint, lpad($2::bigint::text, 2, '0') || '-CRM', c.id,
                identity.current_contact_id, 'pendente', '01',
                '{"algorithm":"AES-256-GCM"}'::jsonb, 'user', $3, $3,
                20, '{}', 100000, 'pix'
         FROM crm.conversations c
         JOIN crm.contact_identities identity ON identity.id=c.contact_identity_id
         WHERE c.id=$4`,
        [`order-${runId}-${number}`, number, NOW.toISOString(), id],
      );
    }

    /**
     * What each fixture must read as. `since` is minutes before NOW; the
     * conversation is created by `build`, which finishes with the mode,
     * owner and state the case needs.
     * @type {Array<{label: string, owner?: 'A'|'B'|'none', mode?: 'human'|'assistant', state?: string, archived?: boolean, orderReady?: boolean, build: (id: string) => Promise<void>, inboundMinutesAgo: number, expect: {bucket: string|null, rank?: number, since?: number|string, stalled?: boolean, reminder?: {mine: boolean}|null, lost?: boolean}}>}
     */
    const cases = [
      // --- Responder: the customer wrote last
      {
        label: 'respond_old',
        owner: 'A',
        inboundMinutesAgo: 300,
        build: async () => {},
        expect: { bucket: 'respond', rank: 1, since: 300 },
      },
      {
        label: 'respond_other_owner',
        owner: 'B',
        inboundMinutesAgo: 100,
        build: async () => {},
        expect: { bucket: 'respond', rank: 1, since: 100 },
      },
      {
        label: 'respond_new_unowned',
        owner: 'none',
        inboundMinutesAgo: 20,
        build: async () => {},
        expect: { bucket: 'respond', rank: 1, since: 20 },
      },
      {
        // Friday 06/11 17:00 in São Paulo: one business hour before the weekend.
        label: 'respond_friday',
        owner: 'A',
        inboundMinutesAgo: 2580,
        build: async () => {},
        expect: { bucket: 'respond', rank: 1, since: 2580 },
      },
      {
        // The first unanswered message dates the wait, not the last one.
        label: 'respond_second_inbound',
        owner: 'A',
        inboundMinutesAgo: 900,
        build: async (id) => {
          await customer(id, 30);
        },
        expect: { bucket: 'respond', rank: 1, since: 900 },
      },
      {
        // A reply ends the sequence; the wait starts at the next message.
        label: 'respond_after_reply',
        owner: 'A',
        inboundMinutesAgo: 1500,
        build: async (id) => {
          await outbound(id, { minutesAgo: 1400 });
          await customer(id, 700);
          await customer(id, 650);
        },
        expect: { bucket: 'respond', rank: 1, since: 700 },
      },
      {
        // The automatic notice (assistant, system) never moves a human turn.
        label: 'respond_notices_ignored',
        owner: 'A',
        inboundMinutesAgo: 400,
        build: async (id) => {
          await outbound(id, { minutesAgo: 390, author: 'assistant' });
          await outbound(id, { minutesAgo: 380, author: 'system' });
        },
        expect: { bucket: 'respond', rank: 1, since: 400 },
      },
      {
        // An unsent (queued) reply is not a reply.
        label: 'respond_queued_not_reply',
        owner: 'A',
        inboundMinutesAgo: 500,
        build: async (id) => {
          await outbound(id, { minutesAgo: 490, status: 'queued' });
        },
        expect: { bucket: 'respond', rank: 1, since: 500 },
      },
      // --- Responder: send failures stay visible without a pinned position
      {
        label: 'failure_after_inbound',
        owner: 'A',
        inboundMinutesAgo: 2000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 1900 });
          await customer(id, 600);
          await outbound(id, { minutesAgo: 500, status: 'failed' });
        },
        expect: { bucket: 'respond', rank: 0, since: 500 },
      },
      {
        // An active loss does not hide a send failure after the customer wrote.
        label: 'failure_over_loss',
        owner: 'A',
        inboundMinutesAgo: 3000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 2900 });
          await outcome(id, { version: 1, minutesAgo: 2800 });
          await outbound(id, { minutesAgo: 2700, status: 'outcome_unknown' });
        },
        expect: { bucket: 'respond', rank: 0, since: 2700, lost: true },
      },
      {
        // A later effective send clears the failure.
        label: 'failure_cleared_by_send',
        owner: 'A',
        inboundMinutesAgo: 800,
        build: async (id) => {
          await outbound(id, { minutesAgo: 790, status: 'failed' });
          await outbound(id, { minutesAgo: 780 });
        },
        expect: { bucket: 'awaiting', rank: 0, since: 780 },
      },
      // --- The agent
      {
        label: 'agent_stalled',
        mode: 'assistant',
        owner: 'none',
        inboundMinutesAgo: 10,
        build: async () => {},
        expect: { bucket: 'respond', rank: 1, since: 10, stalled: true },
      },
      {
        // Exactly the window: the stall rule is inclusive.
        label: 'agent_stalled_boundary',
        mode: 'assistant',
        owner: 'none',
        inboundMinutesAgo: STALL_MINUTES,
        build: async () => {},
        expect: {
          bucket: 'respond',
          rank: 1,
          since: STALL_MINUTES,
          stalled: true,
        },
      },
      {
        label: 'agent_inside_window',
        mode: 'assistant',
        owner: 'none',
        inboundMinutesAgo: STALL_MINUTES - 1,
        build: async () => {},
        expect: {
          bucket: 'awaiting',
          rank: 0,
          since: STALL_MINUTES - 1,
          stalled: false,
        },
      },
      {
        // In assistant mode the agent's own reply is an effective reply.
        label: 'agent_replied',
        mode: 'assistant',
        owner: 'none',
        inboundMinutesAgo: 100,
        build: async (id) => {
          await outbound(id, { minutesAgo: 90, author: 'assistant' });
        },
        expect: { bucket: 'awaiting', rank: 0, since: 90, stalled: false },
      },
      {
        // An open handoff means the agent is no longer alone with the customer.
        label: 'agent_with_accepted_handoff',
        mode: 'assistant',
        owner: 'none',
        inboundMinutesAgo: 2,
        build: async (id) => {
          await handoff(id, 'accepted', 60);
        },
        expect: { bucket: 'respond', rank: 1, since: 2, stalled: false },
      },
      // --- Handoff
      {
        label: 'handoff_pending',
        owner: 'none',
        inboundMinutesAgo: 400,
        build: async (id) => {
          await outbound(id, { minutesAgo: 300 });
          await handoff(id, 'pending', 25);
        },
        expect: { bucket: 'respond', rank: 1, since: 25 },
      },
      {
        label: 'handoff_pending_older_inbound',
        owner: 'none',
        inboundMinutesAgo: 450,
        build: async (id) => {
          await handoff(id, 'pending', 50);
        },
        expect: { bucket: 'respond', rank: 1, since: 450 },
      },
      // --- Aguardando cliente / Sem retorno: 72 h
      {
        label: 'awaiting_71h59',
        owner: 'A',
        inboundMinutesAgo: 5000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 72 * HOUR - 1 });
        },
        expect: { bucket: 'awaiting', rank: 0, since: 72 * HOUR - 1 },
      },
      {
        label: 'awaiting_recent_reply',
        owner: 'B',
        inboundMinutesAgo: 600,
        build: async (id) => {
          await outbound(id, { minutesAgo: 60, status: 'delivered' });
        },
        expect: { bucket: 'awaiting', rank: 0, since: 60 },
      },
      {
        // Exactly 72 h is already silent.
        label: 'silent_exact_72h',
        owner: 'A',
        inboundMinutesAgo: 5000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 72 * HOUR, status: 'read' });
        },
        expect: { bucket: 'silent', rank: 0, since: 72 * HOUR },
      },
      {
        label: 'silent_old',
        owner: 'A',
        orderReady: true,
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 100 * HOUR });
          await readyOrder(id);
        },
        expect: { bucket: 'silent', rank: 0, since: 100 * HOUR },
      },
      // --- Reminders (D2)
      {
        label: 'reminder_own',
        owner: 'A',
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 80 * HOUR });
          await reminder(id, A, { minutesAhead: 600 });
        },
        expect: {
          bucket: 'awaiting',
          rank: 0,
          since: 80 * HOUR,
          reminder: { mine: true },
        },
      },
      {
        label: 'reminder_snoozed_own',
        owner: 'A',
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 81 * HOUR });
          await reminder(id, A, { minutesAhead: 60, decision: 'snooze' });
        },
        expect: {
          bucket: 'awaiting',
          rank: 0,
          since: 81 * HOUR,
          reminder: { mine: true },
        },
      },
      {
        label: 'reminder_other_person',
        owner: 'A',
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 82 * HOUR });
          await reminder(id, B, { minutesAhead: 600 });
        },
        expect: {
          bucket: 'silent',
          rank: 0,
          since: 82 * HOUR,
          reminder: { mine: false },
        },
      },
      {
        label: 'reminder_expired',
        owner: 'A',
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 83 * HOUR });
          await reminder(id, A, { minutesAhead: -30 });
        },
        expect: { bucket: 'silent', rank: 0, since: 83 * HOUR, reminder: null },
      },
      {
        // The conversation changed after the reminder was set.
        label: 'reminder_stale_version',
        owner: 'A',
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 84 * HOUR });
          await reminder(id, A, { minutesAhead: 600, version: 999 });
        },
        expect: { bucket: 'silent', rank: 0, since: 84 * HOUR, reminder: null },
      },
      {
        // Both set one: the reader's own wins even if the other is nearer.
        label: 'reminder_both',
        owner: 'A',
        inboundMinutesAgo: 12_000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 85 * HOUR });
          await reminder(id, B, { minutesAhead: 100 });
          await reminder(id, A, { minutesAhead: 900 });
        },
        expect: {
          bucket: 'awaiting',
          rank: 0,
          since: 85 * HOUR,
          reminder: { mine: true },
        },
      },
      {
        // A reminder never hides a conversation the customer is waiting on.
        label: 'reminder_on_respond',
        owner: 'A',
        inboundMinutesAgo: 200,
        build: async (id) => {
          await reminder(id, A, { minutesAhead: 600 });
        },
        expect: {
          bucket: 'respond',
          rank: 1,
          since: 200,
          reminder: { mine: true },
        },
      },
      // --- Perdidos
      {
        label: 'lost_active',
        owner: 'A',
        inboundMinutesAgo: 4000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 3900 });
          await outcome(id, { version: 1, minutesAgo: 3000, reason: 'preco' });
        },
        expect: { bucket: 'lost', rank: 0, since: 3000, lost: true },
      },
      {
        label: 'lost_newer',
        owner: 'B',
        inboundMinutesAgo: 4000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 3900 });
          await outcome(id, { version: 1, minutesAgo: 1000, reason: 'prazo' });
        },
        expect: { bucket: 'lost', rank: 0, since: 1000, lost: true },
      },
      {
        // A new customer message reopens the loss by derivation.
        label: 'lost_reopened_by_inbound',
        owner: 'A',
        inboundMinutesAgo: 4000,
        build: async (id) => {
          await outcome(id, { version: 1, minutesAgo: 3000 });
          await customer(id, 120);
        },
        expect: { bucket: 'respond', rank: 1, since: 4000 },
      },
      {
        // A manual reopening, then the plain reading by messages.
        label: 'lost_manual_reopen',
        owner: 'A',
        inboundMinutesAgo: 9000,
        build: async (id) => {
          await outbound(id, { minutesAgo: 90 * HOUR });
          await outcome(id, { version: 1, minutesAgo: 80 * HOUR });
          await outcome(id, {
            version: 2,
            minutesAgo: 70 * HOUR,
            outcome: 'reopened',
          });
        },
        expect: { bucket: 'silent', rank: 0, since: 90 * HOUR },
      },
      // --- Edge cases
      {
        label: 'no_messages',
        owner: 'A',
        inboundMinutesAgo: 500,
        build: async (id) => {
          await pool.query(
            'DELETE FROM crm.messages WHERE conversation_id=$1',
            [id],
          );
        },
        // No message at all: the wait starts when the conversation opened.
        expect: { bucket: 'awaiting', rank: 0, since: 500 },
      },
      // --- Outside the open universe
      {
        label: 'archived',
        owner: 'A',
        archived: true,
        inboundMinutesAgo: 300,
        build: async () => {},
        expect: { bucket: null },
      },
      {
        label: 'closed',
        owner: 'A',
        state: 'encerrada',
        inboundMinutesAgo: 300,
        build: async () => {},
        expect: { bucket: null },
      },
      {
        // Converted to a lead keeps terminal_at empty: still not open.
        label: 'converted',
        owner: 'B',
        state: 'convertida_em_lead',
        inboundMinutesAgo: 300,
        build: async () => {},
        expect: { bucket: null },
      },
      {
        label: 'no_lead',
        owner: 'none',
        state: 'sem_lead',
        inboundMinutesAgo: 300,
        build: async () => {},
        expect: { bucket: null },
      },
      {
        label: 'order_ready_respond',
        owner: 'A',
        orderReady: true,
        inboundMinutesAgo: 30,
        build: async (id) => {
          await readyOrder(id);
        },
        expect: { bucket: 'respond', rank: 1, since: 30 - 123 / 60_000 },
      },
    ];

    /** @type {Map<string, string>} */
    const idByLabel = new Map();
    for (const item of cases) {
      const id = await open(item.label, item.inboundMinutesAgo);
      idByLabel.set(item.label, id);
      await item.build(id);
      await pool.query(
        `UPDATE crm.conversations
         SET automation_state=$2, assigned_user_id=$3, state=$4,
             terminal_at=CASE WHEN $4 IN ('sem_lead','encerrada')
               THEN $5::timestamptz END,
             closure_outcome=CASE WHEN $4='encerrada' THEN 'concluido' END,
             closed_by=CASE WHEN $4='encerrada' THEN $3 END,
             archived_at=CASE WHEN $6 THEN $5::timestamptz END
         WHERE id=$1`,
        [
          id,
          item.mode ?? 'human',
          OWNER[item.owner ?? 'none'],
          item.state ?? 'em_atendimento',
          NOW.toISOString(),
          item.archived === true,
        ],
      );
    }
    // Opposite sub-millisecond timestamps and id order: sorting raw timestamps
    // would disagree with the cursor's millisecond precision.
    const tiedResponseIds = ['respond_second_inbound', 'order_ready_respond']
      .map((label) => /** @type {string} */ (idByLabel.get(label)))
      .sort();
    const tiedMillis = ago(30).getTime() + 123;
    for (const [index, id] of tiedResponseIds.entries()) {
      const timestamp = new Date(tiedMillis)
        .toISOString()
        .replace('Z', `${index === 0 ? '789' : '456'}Z`);
      await pool.query(
        'UPDATE crm.messages SET occurred_at=$2, created_at=$2 WHERE id=$1',
        [await lastInboundId(id), timestamp],
      );
      await pool.query(
        'UPDATE crm.conversations SET last_message_at=$2 WHERE id=$1',
        [id, timestamp],
      );
      latestMessageMinutesAgo.set(id, (NOW.getTime() - tiedMillis) / 60_000);
    }
    const caseOf = (/** @type {string} */ id) =>
      cases.find((item) => item.label === labelById.get(id));
    const idsOf = (/** @type {any[]} */ items) =>
      items.map((/** @type {any} */ item) => item.id);
    const labelsOf = (/** @type {any[]} */ items) =>
      items.map((/** @type {any} */ item) => labelById.get(item.id));
    const BUCKETS = ['respond', 'awaiting', 'silent', 'lost'];

    /** The order a tab promises, from the fixtures alone. */
    function expectedOrder(
      /** @type {string} */ bucket,
      /** @type {typeof cases} */ pool_,
    ) {
      const members = pool_.filter((item) => item.expect.bucket === bucket);
      const key = (/** @type {any} */ item) =>
        item.expect.since === 'opened_at' ? 0 : item.expect.since;
      return members
        .sort((left, right) => {
          if (bucket === 'respond') {
            const leftId = /** @type {string} */ (idByLabel.get(left.label));
            const rightId = /** @type {string} */ (idByLabel.get(right.label));
            return (
              /** @type {number} */ (latestMessageMinutesAgo.get(leftId)) -
                /** @type {number} */ (latestMessageMinutesAgo.get(rightId)) ||
              rightId.localeCompare(leftId)
            );
          }
          // since is minutes ago: bigger = older.
          return bucket === 'silent'
            ? key(right) - key(left)
            : key(left) - key(right);
        })
        .map((item) => item.label);
    }
    /** @param {{owner?: string, orderReady?: boolean, assignedUserId?: string}} [filter] */
    const matching = (filter = {}) =>
      cases.filter(
        (item) =>
          (filter.owner === undefined ||
            filter.owner === 'all' ||
            (filter.owner === 'mine' && item.owner === 'A') ||
            (filter.owner === 'unassigned' &&
              (item.owner ?? 'none') === 'none')) &&
          (!filter.orderReady || item.orderReady === true) &&
          (filter.assignedUserId === undefined ||
            OWNER[item.owner ?? 'none'] === filter.assignedUserId),
      );
    const list = (/** @type {Record<string, any>} */ query, actor = A) =>
      reads.listInbox(query, { actorId: actor });
    const fullList = async (
      /** @type {Record<string, any>} */ query,
      actor = A,
    ) => {
      /** @type {any[]} */
      const items = [];
      let cursor;
      let total = 0;
      for (let page = 0; page < 20; page += 1) {
        const result = await list({ ...query, limit: 3, cursor }, actor);
        items.push(...result.items);
        total = result.totalCount;
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return { items, total };
    };

    await t.test(
      'every open conversation reads in exactly one tab, in order',
      async () => {
        const seen = new Map();
        for (const bucket of BUCKETS) {
          const result = await list({ bucket, limit: 100 });
          assert.deepEqual(
            labelsOf(result.items),
            expectedOrder(bucket, cases),
            `${bucket} order`,
          );
          assert.equal(result.totalCount, result.items.length);
          for (const item of result.items) {
            assert.equal(
              seen.has(item.id),
              false,
              `${labelById.get(item.id)} twice`,
            );
            seen.set(item.id, bucket);
            assert.equal(item.bucket, bucket);
            const expected = /** @type {any} */ (caseOf(item.id)).expect;
            assert.equal(item.bucket, expected.bucket, labelById.get(item.id));
          }
        }
        const open = cases.filter((item) => item.expect.bucket !== null);
        assert.equal(seen.size, open.length);
      },
    );

    await t.test(
      'INBOX-VEZ-08: latest message moves an old wait ahead of older failures; ties use id',
      async () => {
        const { items } = await list({ bucket: 'respond', limit: 100 });
        const labels = labelsOf(items);
        assert.ok(
          labels.indexOf('respond_second_inbound') <
            labels.indexOf('respond_other_owner'),
          'a recent second inbound outranks an older last message',
        );
        assert.ok(
          labels.indexOf('respond_new_unowned') <
            labels.indexOf('failure_after_inbound'),
          'an old send failure does not pin itself ahead of a recent customer',
        );
        const repeated = items.find(
          (/** @type {any} */ item) =>
            labelById.get(item.id) === 'respond_second_inbound',
        );
        assert.equal(repeated.turnSince, ago(900).toISOString());
        assert.equal(repeated.updatedAt, new Date(tiedMillis).toISOString());
        const tieIds = [...tiedResponseIds].reverse();
        assert.deepEqual(
          items
            .filter((/** @type {any} */ item) => tieIds.includes(item.id))
            .map((/** @type {any} */ item) => item.id),
          tieIds,
        );
        const { items: paged } = await fullList({ bucket: 'respond' });
        assert.deepEqual(idsOf(paged), idsOf(items));
        assert.equal(new Set(idsOf(paged)).size, items.length);
        let cursor;
        const oneByOne = [];
        for (let index = 0; index < items.length; index += 1) {
          const page = await list({ bucket: 'respond', limit: 1, cursor });
          oneByOne.push(...idsOf(page.items));
          cursor = page.nextCursor;
        }
        assert.deepEqual(oneByOne, idsOf(items));
      },
    );

    await t.test(
      'item fields: turnSince, business minutes, as-of, stall, loss and reminder',
      async () => {
        for (const bucket of BUCKETS) {
          const { items } = await list({ bucket, limit: 100 });
          for (const item of items) {
            const label = /** @type {string} */ (labelById.get(item.id));
            const expected = /** @type {any} */ (caseOf(item.id)).expect;
            const sinceMinutes = expected.since;
            if (sinceMinutes === 'opened_at') {
              const opened = (
                await pool.query(
                  `SELECT date_trunc('milliseconds', opened_at) at
                 FROM crm.conversations WHERE id=$1`,
                  [item.id],
                )
              ).rows[0].at;
              assert.equal(item.turnSince, opened.toISOString(), label);
            } else {
              assert.equal(
                item.turnSince,
                ago(sinceMinutes).toISOString(),
                label,
              );
            }
            const reference = (
              await pool.query(
                `SELECT floor(crm.business_minutes_v1($1::timestamptz, $2::timestamptz))::integer minutes`,
                [item.turnSince, NOW.toISOString()],
              )
            ).rows[0].minutes;
            assert.equal(item.turnBusinessMinutes, reference, label);
            assert.equal(item.turnAsOf, NOW.toISOString());
            assert.equal(
              item.assistantStalled,
              expected.stalled === true,
              label,
            );
            assert.equal(
              item.lostOutcome !== null,
              expected.lost === true || bucket === 'lost',
              label,
            );
            assert.deepEqual(
              item.reminder === null ? null : { mine: item.reminder.mine },
              expected.reminder ?? null,
              label,
            );
          }
        }
        const byLabel = async (
          /** @type {string} */ label,
          bucket = 'respond',
        ) =>
          (await list({ bucket, limit: 100 })).items.find(
            (/** @type {any} */ item) => item.id === idByLabel.get(label),
          );
        // Friday 17:00-18:00 is the only business time before Sunday noon.
        assert.equal((await byLabel('respond_friday')).turnBusinessMinutes, 60);
        assert.equal(
          (await byLabel('respond_new_unowned')).turnBusinessMinutes,
          0,
        );
        const lost = await byLabel('lost_active', 'lost');
        assert.deepEqual(lost.lostOutcome, {
          occurredAt: ago(3000).toISOString(),
          reasonCode: 'preco',
          version: 1,
        });
        assert.doesNotMatch(JSON.stringify(lost), /note|envelope/u);
        const own = await byLabel('reminder_own', 'awaiting');
        assert.equal(own.reminder.mine, true);
        assert.equal(
          own.reminder.remindAt,
          new Date(NOW.getTime() + 600 * 60_000).toISOString(),
        );
        // Reminder precedence: the reader's own, then the nearest.
        const both = await byLabel('reminder_both', 'awaiting');
        assert.equal(
          both.reminder.remindAt,
          new Date(NOW.getTime() + 900 * 60_000).toISOString(),
        );
        // The other seller reads the same conversation as theirs-not-mine.
        const asOther = (
          await list({ bucket: 'silent', limit: 100 }, B)
        ).items.find(
          (/** @type {any} */ item) =>
            item.id === idByLabel.get('reminder_own'),
        );
        assert.equal(asOther.reminder.mine, false, "A reminder is A's alone");
        const bothAsB = (
          await list({ bucket: 'awaiting', limit: 100 }, B)
        ).items.find(
          (/** @type {any} */ item) =>
            item.id === idByLabel.get('reminder_both'),
        );
        assert.equal(bothAsB.reminder.mine, true, 'B reads their own reminder');
      },
    );

    await t.test('buckets endpoint equals the total of each tab', async () => {
      for (const filter of [
        {},
        { owner: 'mine' },
        { owner: 'unassigned' },
        { owner: 'all', orderReady: true },
        { owner: 'mine', orderReady: true },
        { assignedUserId: B },
        { owner: 'all', assignedUserId: A },
      ]) {
        const counts = await reads.countInboxBuckets(filter, { actorId: A });
        assert.deepEqual(Object.keys(counts), BUCKETS);
        for (const bucket of BUCKETS) {
          const result = await list({ bucket, limit: 1, ...filter });
          assert.equal(
            counts[bucket],
            result.totalCount,
            `${bucket} ${JSON.stringify(filter)}`,
          );
          assert.equal(
            counts[bucket],
            matching(filter).filter((item) => item.expect.bucket === bucket)
              .length,
            `${bucket} ${JSON.stringify(filter)} by fixtures`,
          );
        }
      }
      // The count follows the reader for `mine`.
      const asB = await reads.countInboxBuckets(
        { owner: 'mine' },
        { actorId: B },
      );
      assert.equal(
        asB.respond,
        cases.filter(
          (item) => item.owner === 'B' && item.expect.bucket === 'respond',
        ).length,
      );
    });

    await t.test(
      'owner, orderReady and assignedUserId narrow list and total',
      async () => {
        for (const filter of [
          { owner: 'mine' },
          { owner: 'unassigned' },
          { owner: 'all' },
          { owner: 'mine', orderReady: true },
          { orderReady: true },
          { assignedUserId: B },
        ]) {
          for (const bucket of BUCKETS) {
            const result = await list({ bucket, limit: 100, ...filter });
            assert.deepEqual(
              labelsOf(result.items),
              expectedOrder(bucket, matching(filter)),
              `${bucket} ${JSON.stringify(filter)}`,
            );
            assert.equal(result.totalCount, result.items.length);
          }
        }
        const ready = await list({
          bucket: 'silent',
          limit: 10,
          orderReady: true,
        });
        assert.deepEqual(labelsOf(ready.items), ['silent_old']);
        assert.ok(
          ready.items[0].reviewOrder,
          'the chip shows the order to review',
        );
      },
    );

    await t.test(
      'cursor walks each tab and each owner without gaps or repeats',
      async () => {
        for (const filter of [{}, { owner: 'mine' }, { owner: 'unassigned' }]) {
          for (const bucket of BUCKETS) {
            const { items, total } = await fullList({ bucket, ...filter });
            assert.deepEqual(
              labelsOf(items),
              expectedOrder(bucket, matching(filter)),
              `${bucket} ${JSON.stringify(filter)}`,
            );
            assert.equal(total, items.length);
            assert.equal(new Set(idsOf(items)).size, items.length);
          }
        }
      },
    );

    await t.test(
      'a cursor is bound to reader, tab, owner, order-ready and seller',
      async () => {
        const page = await list({ bucket: 'respond', limit: 2 });
        assert.ok(page.nextCursor);
        const payload = JSON.parse(
          Buffer.from(page.nextCursor.split('.')[0], 'base64url').toString(
            'utf8',
          ),
        );
        assert.deepEqual(Object.keys(payload).sort(), [
          'fingerprint',
          'id',
          'rank',
          'scope',
          'updatedAt',
        ]);
        assert.equal(
          payload.fingerprint,
          createHash('sha256')
            .update(
              JSON.stringify({
                actorId: A,
                bucket: 'respond',
                owner: 'all',
                orderReady: false,
                orderVersion: 'latest-message-v1',
              }),
            )
            .digest('hex'),
        );
        const second = await list({
          bucket: 'respond',
          limit: 2,
          cursor: page.nextCursor,
        });
        assert.equal(second.items.length, 2);
        for (const [
          query,
          actor,
        ] of /** @type {Array<[Record<string, any>, string]>} */ ([
          [{ bucket: 'awaiting' }, A],
          [{ bucket: 'respond' }, B],
          [{ bucket: 'respond', owner: 'mine' }, A],
          [{ bucket: 'respond', owner: 'unassigned' }, A],
          [{ bucket: 'respond', orderReady: true }, A],
          [{ bucket: 'respond', assignedUserId: B }, A],
          [{ sort: 'urgency' }, A],
          [{}, A],
        ])) {
          await assert.rejects(
            list({ ...query, limit: 2, cursor: page.nextCursor }, actor),
            { code: 'INVALID_CURSOR' },
            JSON.stringify(query),
          );
        }
        // And the other way: an old cursor never opens a tab.
        const urgency = await list({ sort: 'urgency', limit: 2 });
        await assert.rejects(
          list({ bucket: 'respond', limit: 2, cursor: urgency.nextCursor }),
          { code: 'INVALID_CURSOR' },
        );
      },
    );

    await t.test(
      'terminal=true lists the closed, including a conversion with no terminal_at',
      async () => {
        const result = await list({ terminal: true, limit: 100 });
        assert.deepEqual(labelsOf(result.items).sort(), [
          'closed',
          'converted',
          'no_lead',
        ]);
        assert.equal(result.totalCount, 3);
        for (const item of result.items) {
          assert.equal(item.bucket, null);
          assert.equal(item.turnSince, null);
          assert.equal(item.turnBusinessMinutes, null);
          assert.equal(item.turnAsOf, null);
          assert.equal(item.assistantStalled, false);
        }
        const converted = result.items.find(
          (/** @type {any} */ item) => item.id === idByLabel.get('converted'),
        );
        assert.equal(converted.terminalAt, null);
        // Default order: the most recent message first.
        const times = result.items.map(
          (/** @type {any} */ item) => item.updatedAt,
        );
        assert.deepEqual(times, [...times].sort().reverse());
        // owner applies to the consultations too.
        const mine = await list({ terminal: true, owner: 'mine', limit: 100 });
        assert.deepEqual(labelsOf(mine.items), ['closed']);
        const unassigned = await list({
          terminal: true,
          owner: 'unassigned',
          limit: 100,
        });
        assert.deepEqual(labelsOf(unassigned.items), ['no_lead']);
        const archived = await list({
          archived: true,
          owner: 'mine',
          limit: 100,
        });
        assert.deepEqual(labelsOf(archived.items), ['archived']);
        assert.equal(archived.items[0].bucket, null);
        assert.equal(
          (await list({ archived: true, owner: 'unassigned', limit: 100 }))
            .totalCount,
          0,
        );
        // Cursor of the consultation walks it.
        const walked = await fullList({ terminal: true });
        assert.equal(walked.items.length, 3);
      },
    );

    await t.test('invalid combinations are refused', async () => {
      for (const query of [
        { bucket: 'respond', workQueue: 'attention' },
        { bucket: 'respond', sort: 'urgency' },
        { bucket: 'respond', archived: true },
        { bucket: 'respond', terminal: true },
        { bucket: 'respond', state: 'nova' },
        { bucket: 'respond', pendingHandoff: true },
        { bucket: 'respond', unassignedHumanHandoff: true },
        { bucket: 'respond', automationState: 'human' },
        { bucket: 'invented' },
        { owner: 'everyone' },
        { owner: 'mine', assignedUserId: B },
        { bucket: 'respond', owner: 'unassigned', assignedUserId: B },
        { orderReady: true },
        { terminal: true, workQueue: 'attention' },
        { terminal: true, state: 'encerrada' },
        { terminal: true, archived: true },
      ]) {
        await assert.rejects(
          list(query),
          { code: 'INVALID_FILTER' },
          JSON.stringify(query),
        );
      }
      await assert.rejects(
        reads.countInboxBuckets(
          { owner: 'mine', assignedUserId: B },
          { actorId: A },
        ),
        { code: 'INVALID_FILTER' },
      );
      await assert.rejects(
        reads.countInboxBuckets({ bucket: 'respond' }, { actorId: A }),
        {
          code: 'INVALID_FILTER',
        },
      );
    });

    await t.test(
      'the detail carries the same turn fields as the list',
      async () => {
        for (const bucket of BUCKETS) {
          const { items } = await list({ bucket, limit: 100 });
          for (const item of items) {
            const detail = await reads.getConversation(
              { conversationId: item.id },
              { actorId: A },
            );
            const label = labelById.get(item.id);
            for (const field of [
              'bucket',
              'turnSince',
              'turnBusinessMinutes',
              'turnAsOf',
              'assistantStalled',
              'lostOutcome',
              'reminder',
            ]) {
              assert.deepEqual(
                detail.conversation[field],
                item[field],
                `${label} ${field}`,
              );
            }
          }
        }
        const closed = await reads.getConversation(
          { conversationId: /** @type {string} */ (idByLabel.get('closed')) },
          { actorId: A },
        );
        assert.equal(closed.conversation.bucket, null);
        assert.equal(closed.conversation.turnAsOf, null);
        // The reminder in the detail follows the reader.
        const asOther = await reads.getConversation(
          {
            conversationId: /** @type {string} */ (
              idByLabel.get('reminder_own')
            ),
          },
          { actorId: B },
        );
        assert.equal(asOther.conversation.bucket, 'silent');
        assert.equal(asOther.conversation.reminder.mine, false);
      },
    );

    await t.test(
      'older filters keep their cursor fingerprint and gain the turn fields',
      async () => {
        const fingerprint = (/** @type {unknown} */ value) =>
          createHash('sha256').update(JSON.stringify(value)).digest('hex');
        const decode = (/** @type {string|null} */ cursor) =>
          JSON.parse(
            Buffer.from(String(cursor).split('.')[0], 'base64url').toString(
              'utf8',
            ),
          );
        const urgency = await list({ sort: 'urgency', limit: 2 });
        assert.equal(
          decode(urgency.nextCursor).fingerprint,
          fingerprint({ sort: 'urgency', actorId: A }),
        );
        const attention = await list({ workQueue: 'attention', limit: 1 });
        assert.equal(
          decode(attention.nextCursor).fingerprint,
          fingerprint({ workQueue: 'attention', actorId: A }),
        );
        const plain = await list({ limit: 1 });
        assert.equal(decode(plain.nextCursor).fingerprint, fingerprint({}));
        const archivedPage = await list({ archived: true, limit: 100 });
        assert.deepEqual(labelsOf(archivedPage.items), ['archived']);

        // sort=urgency is the same order as before: failures, then the waits.
        const everything = await fullList({ sort: 'urgency' });
        // Everything but the archived one, which the default view leaves out.
        assert.equal(everything.items.length, cases.length - 1);
        const rankOf = (/** @type {any} */ item) =>
          item.deliveryIssue ? 0 : null;
        const failures = everything.items.filter((item) => rankOf(item) === 0);
        assert.deepEqual(
          labelsOf(everything.items.slice(0, failures.length)).sort(),
          labelsOf(failures).sort(),
          'send failures lead the urgency order',
        );
        assert.deepEqual(
          labelsOf(everything.items.slice(-3)).sort(),
          ['closed', 'converted', 'no_lead'].sort(),
          'closed conversations trail the urgency order',
        );
        // The old queues are untouched and their items carry the new fields.
        const queue = await fullList({ workQueue: 'attention' });
        assert.ok(queue.items.length > 0);
        for (const item of queue.items) {
          const expected = /** @type {any} */ (caseOf(item.id)).expect;
          assert.equal(item.bucket, expected.bucket, labelById.get(item.id));
          assert.equal(item.assistantStalled, expected.stalled === true);
          assert.equal(item.turnAsOf, NOW.toISOString());
        }
        const closing = await fullList({ workQueue: 'closing' });
        assert.deepEqual(
          labelsOf(closing.items).sort(),
          ['order_ready_respond', 'silent_old'].sort(),
        );
        // Every item of an old list reads the same turn as its tab.
        for (const bucket of BUCKETS) {
          const tab = await list({ bucket, limit: 100 });
          for (const item of tab.items) {
            const old = everything.items.find(
              (candidate) => candidate.id === item.id,
            );
            for (const field of [
              'bucket',
              'turnSince',
              'turnBusinessMinutes',
              'reminder',
              'lostOutcome',
            ]) {
              assert.deepEqual(
                old[field],
                item[field],
                `${labelById.get(item.id)} ${field}`,
              );
            }
          }
        }
      },
    );
    await t.test(
      'INBOX-VEZ-08: a new inbound lifts a conversation without resetting its wait',
      async () => {
        const id = /** @type {string} */ (idByLabel.get('respond_old'));
        const before = await list({ bucket: 'respond', limit: 100 });
        const waiting = before.items.find(
          (/** @type {any} */ item) => item.id === id,
        );
        assert.notEqual(before.items[0].id, id);
        await customer(id, 0.25);
        const after = await list({ bucket: 'respond', limit: 100 });
        assert.equal(after.items[0].id, id);
        assert.equal(after.items[0].turnSince, waiting.turnSince);
        assert.equal(
          after.items[0].turnBusinessMinutes,
          waiting.turnBusinessMinutes,
        );
        const { items: paged } = await fullList({ bucket: 'respond' });
        assert.deepEqual(idsOf(paged), idsOf(after.items));
      },
    );
  },
);
