import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { createConversationHandoffRuntime } from '../apps/api/src/conversation-handoff-runtime.js';
import { createOperationReadService } from '../apps/api/src/operation-runtime.js';
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
import {
  PostgresAutomationStallSweeper,
  PostgresN8nIntegrationRepository,
  STALL_HANDOFF_SUMMARY,
  countStalledConversations,
  createN8nIntegrationService,
} from '../modules/n8n-integration/src/index.js';
import { encryptJson } from '../modules/n8n-integration/src/crypto.js';
import { PostgresHandoffReadRepository } from '../modules/work-management/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;

const N8N_KEY = Buffer.alloc(32, 81);
const CONTACT_KEY = Buffer.alloc(32, 82);
const LOOKUP_KEY = Buffer.alloc(32, 83);
const MESSAGE_KEY = Buffer.alloc(32, 84);
const HANDOFF_KEY = Buffer.alloc(32, 85);

const SELLER = Object.freeze({
  functionName: 'Vendedor',
  id: 'seller-ana-live',
  kind: 'human',
});
const OTHER_SELLER = Object.freeze({
  functionName: 'Vendedor',
  id: 'seller-carla-live',
  kind: 'human',
});
const DISABLED_SELLER_ID = 'seller-bia-disabled-live';
const ATTENDANT_ID = 'attendant-live';

/** @param {string} url */
function assertTestDatabase(url) {
  assert.match(
    new URL(url).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9_]+)?$/u,
  );
}

/**
 * One fresh schema and every service the Vendedor evolution touches, wired
 * as production wires them, with synthetic data only.
 *
 * @param {Pool} pool
 */
async function setup(pool) {
  const database = {
    query: pool.query.bind(pool),
    transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
      withTransaction(pool, work),
  };
  // Real time: the inbound read keeps the last 24 hours by the server clock.
  const clock = { now: new Date(Date.now() - 3 * 60 * 60_000) };
  const advance = (/** @type {number} */ minutes) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
    return clock.now;
  };
  let sequence = 0;
  const repository = new PostgresN8nIntegrationRepository({
    contactEnvelopeKey: CONTACT_KEY,
    contactLookupKey: LOOKUP_KEY,
    database,
    envelopeKey: N8N_KEY,
    messageEnvelopeKey: MESSAGE_KEY,
  });
  const n8n = createN8nIntegrationService({
    clock: () => clock.now,
    idFactory: (kind) => `${kind}-${++sequence}-${randomUUID()}`,
    repository,
  });
  const auditPort = {
    async append(/** @type {any} */ event, context = /** @type {any} */ ({})) {
      await (context.transaction ?? database).query(
        `INSERT INTO crm.audit_events
          (id, actor_id, action, target_type, target_id, version, reason,
           correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          event.actor,
          event.action,
          event.target.type,
          event.target.id,
          String(event.version),
          event.reason,
          event.correlationId,
          clock.now,
        ],
      );
    },
  };
  const inbox = createInboxService({
    auditPort,
    clock: () => clock.now,
    repository: new PostgresInboxRepository({
      database,
      envelopeKey: MESSAGE_KEY,
      outboundMessageOutbox: { enqueueChannelMessage: async () => {} },
    }),
  });
  const reads = createOperationReadService({
    clock: () => clock.now,
    countStalled: (now) => countStalledConversations(database, now, 5),
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 86),
    database,
    handoffRepository: new PostgresHandoffReadRepository({
      contactEnvelopeKey: CONTACT_KEY,
      database,
      handoffEnvelopeKey: HANDOFF_KEY,
      n8nEnvelopeKey: N8N_KEY,
    }),
    inboxRepository: new PostgresInboxReadRepository({
      contactEnvelopeKey: CONTACT_KEY,
      database,
      messageEnvelopeKey: MESSAGE_KEY,
    }),
  });
  const handoffs = createConversationHandoffRuntime(database, {
    environment: {
      IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 87).toString('base64url'),
    },
  });

  await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
  await migrate(pool, { migrations: await loadMigrations() });
  for (const [id, name, functionName, disabled] of [
    [SELLER.id, 'Ana Sintética Teste', 'Vendedor', false],
    [OTHER_SELLER.id, 'Carla Sintética', 'Vendedor', false],
    [DISABLED_SELLER_ID, 'Bia Sintética', 'Vendedor', true],
    [ATTENDANT_ID, 'Davi Sintético', 'Financeiro', false],
  ]) {
    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name, disabled_at)
       VALUES ($1, $2, '$argon2id$synthetic', $3, $4)`,
      [id, `${id}@example.test`, name, disabled ? new Date() : null],
    );
    await pool.query(
      'INSERT INTO crm.user_functions (user_id, function_name) VALUES ($1, $2)',
      [id, functionName],
    );
  }

  /** @param {string} executionId @param {string} [idempotencyKey] @param {string} [workflowVersion] */
  const technical = (
    executionId,
    idempotencyKey = executionId,
    workflowVersion = 'mvp-simple-14',
  ) => ({
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: `correlation-${executionId}`,
    credentialVersion: 'current',
    executionId,
    idempotencyKey,
    requestId: `request-${executionId}`,
    workflowKey: 'whatsapp-mvp',
    workflowVersion,
  });

  /**
   * A synthetic WhatsApp inbound message; `phone` picks the contact.
   * @param {string} phone @param {string} externalId @param {Record<string, any>} [message]
   */
  const receive = (phone, externalId, message = undefined) =>
    n8n.receiveInbound({
      channel: 'whatsapp',
      contact: { wa_id: phone },
      event_id: externalId,
      message: message ?? {
        external_id: externalId,
        text: `mensagem sintética ${externalId}`,
        type: 'text',
      },
      metadata: { phone_number_id: 'phone-account-live' },
      occurred_at: clock.now.toISOString(),
      schema_version: '1.0',
      technical: technical(`inbound-${externalId}`),
    });

  /**
   * @param {any} inbound @param {string} eventId @param {Record<string, any>} handoff
   * @param {Record<string, any>} [extra]
   */
  const requestHandoff = (inbound, eventId, handoff, extra = {}) =>
    n8n.recordEvent({
      automation_epoch: inbound.automation_epoch,
      conversation_id: inbound.conversation_id,
      event_id: eventId,
      event_type: 'handoff.requested',
      handoff,
      occurred_at: clock.now.toISOString(),
      schema_version: '1.0',
      source_revision: inbound.source_revision,
      technical: technical(eventId),
      ...extra,
    });

  /**
   * @param {any} inbound @param {string} eventId @param {Record<string, any>} [extra]
   */
  const reply = (inbound, eventId, extra = {}) =>
    n8n.recordEvent({
      automation_epoch: inbound.automation_epoch,
      command_id: `command-${eventId}`,
      conversation_id: inbound.conversation_id,
      event_id: eventId,
      event_type: 'message.send.requested',
      message: { text: 'Resposta sintética do assistente', type: 'text' },
      occurred_at: clock.now.toISOString(),
      schema_version: '1.0',
      source_revision: inbound.source_revision,
      technical: technical(eventId),
      ...extra,
    });

  /**
   * The provider accepted the reply reserved by `reply(inbound, eventId)`.
   * @param {any} inbound @param {string} eventId
   */
  const sent = (inbound, eventId) =>
    n8n.recordEvent({
      command_id: `command-${eventId}`,
      conversation_id: inbound.conversation_id,
      event_id: `sent-${eventId}`,
      event_type: 'message.sent',
      external_message_id: `wamid.out.${eventId}`,
      occurred_at: clock.now.toISOString(),
      schema_version: '1.0',
      technical: technical(`sent-${eventId}`),
    });

  /** @param {string} conversationId */
  const version = async (conversationId) =>
    Number(
      (
        await pool.query('SELECT version FROM crm.conversations WHERE id=$1', [
          conversationId,
        ])
      ).rows[0].version,
    );

  const sweeper = new PostgresAutomationStallSweeper({
    clock: () => clock.now,
    database,
    envelopeKey: N8N_KEY,
    idFactory: (kind) => `${kind}-${++sequence}-${randomUUID()}`,
    stallMinutes: 5,
  });

  return {
    advance,
    clock,
    sweeper,
    database,
    handoffs,
    inbox,
    n8n,
    reads,
    receive,
    reply,
    repository,
    requestHandoff,
    sent,
    technical,
    version,
  };
}

if (connectionString) {
  test('PostgreSQL live: Vendedor evolution on the CRM side', async (t) => {
    assertTestDatabase(connectionString);
    const pool = new Pool({ connectionString, max: 8 });
    try {
      const env = await setup(pool);

      await t.test(
        'INBOX-HANDOFF-02: partnership reason, preferred seller, open claim and resolution on close',
        async () => {
          const inbound = await env.receive('5527990000001', 'wamid.pref.1');
          const result = await env.requestHandoff(inbound, 'handoff-pref-1', {
            reason: 'partnership',
            requested_seller_id: SELLER.id,
            summary: 'Cliente quer revender. Pediu a Ana.',
          });
          const stored = (
            await pool.query(
              `SELECT reason_code, preferred_user_id, assigned_user_id, status
               FROM crm.handoffs WHERE id=$1`,
              [result.handoff_id],
            )
          ).rows[0];
          assert.deepEqual(stored, {
            assigned_user_id: null,
            preferred_user_id: SELLER.id,
            reason_code: 'partnership',
            status: 'pending',
          });

          const open = await env.reads.getConversationHandoff({
            conversationId: inbound.conversation_id,
          });
          assert.deepEqual(open.preferred_seller, {
            first_name: 'Ana',
            id: SELLER.id,
          });
          assert.equal(open.handoff.reasonCode, 'partnership');
          assert.equal('preferredSeller' in open.handoff, false);
          const listed = await env.reads.listInbox({ pendingHandoff: true });
          const item = listed.items.find(
            (/** @type {any} */ candidate) =>
              candidate.id === inbound.conversation_id,
          );
          assert.equal(item.handoff.preferredSellerFirstName, 'Ana');

          // RULES.md rule 20: the preference is a hint; any Vendedor claims.
          const claimed = await env.handoffs.claimHandoff({
            actor: OTHER_SELLER,
            correlationId: 'correlation-claim-pref-1',
            expectedHandoffVersion: 1,
            handoffId: result.handoff_id,
            idempotencyKey: 'claim-pref-1',
          });
          assert.equal(claimed.handoff.assignedUserId, OTHER_SELLER.id);

          const closeCommand = {
            acknowledgePending: false,
            actor: OTHER_SELLER,
            conversationId: inbound.conversation_id,
            correlationId: 'correlation-close-pref-1',
            expectedVersion: await env.version(inbound.conversation_id),
            idempotencyKey: 'close-pref-1',
            outcome: 'concluido',
            reason: 'Encerramento: concluido',
          };
          const closed = await env.inbox.closeConversation(closeCommand);
          assert.equal(closed.state, 'encerrada');
          const resolved = (
            await pool.query(
              `SELECT status, resolved_at IS NOT NULL AS has_resolved_at,
                      assigned_user_id, version
               FROM crm.handoffs WHERE id=$1`,
              [result.handoff_id],
            )
          ).rows[0];
          assert.deepEqual(resolved, {
            assigned_user_id: OTHER_SELLER.id,
            has_resolved_at: true,
            status: 'resolved',
            version: '3',
          });
          const history = await pool.query(
            `SELECT from_status, to_status, reason_code, actor_id
             FROM crm.handoff_history WHERE handoff_id=$1
             ORDER BY resulting_version`,
            [result.handoff_id],
          );
          assert.deepEqual(history.rows.at(-1), {
            actor_id: OTHER_SELLER.id,
            from_status: 'accepted',
            reason_code: 'conversation_closed',
            to_status: 'resolved',
          });
          assert.deepEqual(
            await env.reads.getConversationHandoff({
              conversationId: inbound.conversation_id,
            }),
            { handoff: null, preferred_seller: null },
          );
          // A replayed close does not resolve twice.
          await env.inbox.closeConversation(closeCommand);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS total FROM crm.handoff_history WHERE handoff_id=$1',
                [result.handoff_id],
              )
            ).rows[0].total,
            3,
          );
        },
      );

      await t.test(
        'INBOX-HANDOFF-02: an inactive or unknown seller is ignored and audited; the handoff still opens',
        async () => {
          for (const [index, requested] of [
            DISABLED_SELLER_ID,
            ATTENDANT_ID,
            'seller-that-does-not-exist',
          ].entries()) {
            const inbound = await env.receive(
              `552799000010${index}`,
              `wamid.ignored.${index}`,
            );
            const result = await env.requestHandoff(
              inbound,
              `handoff-ignored-${index}`,
              { reason: 'human_requested', requested_seller_id: requested },
            );
            const stored = (
              await pool.query(
                'SELECT reason_code, preferred_user_id FROM crm.handoffs WHERE id=$1',
                [result.handoff_id],
              )
            ).rows[0];
            assert.deepEqual(stored, {
              preferred_user_id: null,
              reason_code: 'customer_requested_human',
            });
            const audit = await pool.query(
              `SELECT reason FROM crm.audit_events
               WHERE action='integration.n8n.handoff.preferred_seller_ignored'
                 AND target_id=$1`,
              [inbound.conversation_id],
            );
            assert.deepEqual(
              audit.rows.map((/** @type {any} */ row) => row.reason),
              ['PREFERRED_SELLER_NOT_ACTIVE'],
            );
          }
          // The current workflow, without the new field, is unchanged.
          const legacy = await env.receive('5527990000110', 'wamid.legacy.1');
          const result = await env.requestHandoff(legacy, 'handoff-legacy-1', {
            reason: 'briefing_complete',
            summary: 'Resumo sintético',
          });
          assert.ok(result.handoff_id);
          await assert.rejects(
            env.requestHandoff(legacy, 'handoff-legacy-bad', {
              reason: 'briefing_complete',
              requested_seller_id: 42,
            }),
            { name: 'N8nValidationError' },
          );
        },
      );

      await t.test(
        'INBOX-HANDOFF-02: a direct takeover with an unclaimed handoff resolves it on close in the closer name',
        async () => {
          const inbound = await env.receive('5527990000201', 'wamid.direct.1');
          const result = await env.requestHandoff(inbound, 'handoff-direct-1', {
            reason: 'complaint',
          });
          const owned = await env.inbox.takeover({
            actor: SELLER,
            conversationId: inbound.conversation_id,
            correlationId: 'correlation-takeover-direct-1',
            expectedVersion: await env.version(inbound.conversation_id),
            idempotencyKey: 'takeover-direct-1',
            reason: 'Assumir',
          });
          await env.inbox.closeConversation({
            acknowledgePending: false,
            actor: SELLER,
            conversationId: inbound.conversation_id,
            correlationId: 'correlation-close-direct-1',
            expectedVersion: owned.version,
            idempotencyKey: 'close-direct-1',
            outcome: 'sem_pedido',
            reason: 'Encerramento: sem_pedido',
          });
          const resolved = (
            await pool.query(
              'SELECT status, assigned_user_id FROM crm.handoffs WHERE id=$1',
              [result.handoff_id],
            )
          ).rows[0];
          assert.deepEqual(resolved, {
            assigned_user_id: SELLER.id,
            status: 'resolved',
          });
          const last = (
            await pool.query(
              `SELECT from_status, to_status FROM crm.handoff_history
               WHERE handoff_id=$1 ORDER BY resulting_version DESC LIMIT 1`,
              [result.handoff_id],
            )
          ).rows[0];
          assert.deepEqual(last, {
            from_status: 'pending',
            to_status: 'resolved',
          });
          const summary = await env.reads.summarizeInbox({
            actorId: SELLER.id,
          });
          assert.equal(summary.waitingHandoff.count, await waitingCount(pool));
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::integer AS total FROM crm.handoffs handoff
                 JOIN crm.conversations conversation
                   ON conversation.id=handoff.conversation_id
                 WHERE conversation.terminal_at IS NOT NULL
                   AND handoff.status IN ('pending','accepted')`,
              )
            ).rows[0].total,
            0,
          );
        },
      );

      await t.test(
        'AGENTE-FAIL-01: the sweep hands a stalled conversation to a seller once and fences the late reply',
        async () => {
          const inbound = await env.receive('5527990000301', 'wamid.stall.1');
          env.advance(4);
          assert.equal((await env.sweeper.sweep()).handedOff, 0);
          env.advance(2);
          assert.equal(
            await countStalledConversations(env.database, env.clock.now, 5),
            1,
          );
          const first = await env.sweeper.sweep();
          assert.deepEqual(first, {
            candidates: 1,
            errorCodes: [],
            failed: 0,
            handedOff: 1,
          });
          assert.deepEqual(await env.sweeper.sweep(), {
            candidates: 0,
            errorCodes: [],
            failed: 0,
            handedOff: 0,
          });
          const conversation = (
            await pool.query(
              `SELECT automation_state, state, automation_epoch,
                      claimed_revision, inbound_revision, assigned_user_id
               FROM crm.conversations WHERE id=$1`,
              [inbound.conversation_id],
            )
          ).rows[0];
          assert.deepEqual(conversation, {
            assigned_user_id: null,
            automation_epoch: String(inbound.automation_epoch + 1),
            automation_state: 'human',
            claimed_revision: String(inbound.source_revision),
            inbound_revision: String(inbound.source_revision),
            state: 'requer_atencao',
          });
          const handoffs = await pool.query(
            `SELECT id, reason_code, status, assigned_user_id, target_role
             FROM crm.handoffs WHERE conversation_id=$1`,
            [inbound.conversation_id],
          );
          assert.equal(handoffs.rows.length, 1);
          const { id: handoffId, ...handoff } = handoffs.rows[0];
          assert.deepEqual(handoff, {
            assigned_user_id: null,
            reason_code: 'automation_failure',
            status: 'pending',
            target_role: 'Vendedor',
          });
          const open = await env.reads.getConversationHandoff({
            conversationId: inbound.conversation_id,
          });
          assert.equal(open.handoff.summary, STALL_HANDOFF_SUMMARY);
          const trail = await pool.query(
            `SELECT action, reason FROM crm.audit_events
             WHERE target_id=$1 AND action='automation.stall.handoff_created'`,
            [inbound.conversation_id],
          );
          assert.deepEqual(trail.rows, [
            {
              action: 'automation.stall.handoff_created',
              reason: 'ASSISTANT_STALLED',
            },
          ]);
          const history = await pool.query(
            'SELECT to_status, reason_code FROM crm.handoff_history WHERE handoff_id=$1',
            [handoffId],
          );
          assert.deepEqual(history.rows, [
            { reason_code: 'automation_failure', to_status: 'pending' },
          ]);
          // The assistant's late answer arrives after the sweep: refused.
          await assert.rejects(env.reply(inbound, 'late-reply-stall-1'), {
            code: 'STALE_AUTOMATION_FENCE',
          });
          await assert.rejects(
            env.requestHandoff(inbound, 'late-handoff-stall-1', {
              reason: 'automation_failure',
            }),
            { code: 'STALE_AUTOMATION_FENCE' },
          );
          // The CRM never writes a customer message on this path.
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::integer AS total FROM crm.messages
                 WHERE conversation_id=$1 AND direction='outbound'`,
                [inbound.conversation_id],
              )
            ).rows[0].total,
            0,
          );
        },
      );

      await t.test(
        'AGENTE-FAIL-01: answered, recent, archived, old and handed-off conversations are left alone',
        async () => {
          const answered = await env.receive('5527990000401', 'wamid.ok.1');
          await env.reply(answered, 'reply-ok-1');
          await env.sent(answered, 'reply-ok-1');
          const archived = await env.receive('5527990000402', 'wamid.arch.1');
          await pool.query(
            'UPDATE crm.conversations SET archived_at=$2 WHERE id=$1',
            [archived.conversation_id, env.clock.now],
          );
          const ancient = await env.receive('5527990000403', 'wamid.old.1');
          await pool.query(
            `UPDATE crm.messages SET created_at = created_at - interval '2 days',
                 occurred_at = occurred_at - interval '2 days'
             WHERE conversation_id=$1`,
            [ancient.conversation_id],
          );
          const escalated = await env.receive('5527990000404', 'wamid.esc.1');
          await env.requestHandoff(escalated, 'handoff-esc-1', {
            reason: 'negotiation',
          });
          env.advance(10);
          const recent = await env.receive('5527990000405', 'wamid.recent.1');
          const swept = await env.sweeper.sweep();
          assert.equal(swept.handedOff, 0);
          for (const inbound of [answered, archived, ancient, recent]) {
            const row = (
              await pool.query(
                'SELECT automation_state FROM crm.conversations WHERE id=$1',
                [inbound.conversation_id],
              )
            ).rows[0];
            assert.equal(row.automation_state, 'assistant');
          }
          // A new customer message after the reply makes it a candidate again.
          env.advance(1);
          const again = await env.receive('5527990000401', 'wamid.ok.2');
          assert.equal(again.conversation_id, answered.conversation_id);
          env.advance(6);
          const later = await env.sweeper.sweep();
          assert.equal(later.handedOff, 2);
          assert.equal(
            (
              await pool.query(
                'SELECT reason_code FROM crm.handoffs WHERE conversation_id=$1',
                [answered.conversation_id],
              )
            ).rows[0].reason_code,
            'automation_failure',
          );
        },
      );

      await t.test(
        'AGENTE-FAIL-01: a sweep racing the assistant reply leaves exactly one winner',
        async () => {
          for (let round = 0; round < 6; round += 1) {
            const inbound = await env.receive(
              `55279900005${String(round).padStart(2, '0')}`,
              `wamid.race.${round}`,
            );
            env.advance(6);
            const [swept, replied] = await Promise.allSettled([
              env.sweeper.sweep(),
              env.reply(inbound, `reply-race-${round}`),
            ]);
            assert.equal(swept.status, 'fulfilled');
            const handoffs = Number(
              (
                await pool.query(
                  'SELECT count(*)::integer AS total FROM crm.handoffs WHERE conversation_id=$1',
                  [inbound.conversation_id],
                )
              ).rows[0].total,
            );
            const sent = Number(
              (
                await pool.query(
                  `SELECT count(*)::integer AS total FROM crm.messages
                   WHERE conversation_id=$1 AND author_kind='assistant'`,
                  [inbound.conversation_id],
                )
              ).rows[0].total,
            );
            if (replied.status === 'fulfilled') {
              assert.deepEqual([handoffs, sent], [0, 1]);
            } else {
              assert.equal(
                /** @type {any} */ (replied.reason).code,
                'STALE_AUTOMATION_FENCE',
              );
              assert.deepEqual([handoffs, sent], [1, 0]);
            }
          }
        },
      );

      await t.test(
        'AGENTE-FAIL-01: the workflow error branch hands off with automation_failure',
        async () => {
          const inbound = await env.receive('5527990000601', 'wamid.fail.1');
          const result = await env.requestHandoff(inbound, 'handoff-fail-1', {
            notice: {
              command_id: 'notice-fail-1',
              text: 'Vou chamar uma pessoa da equipe para continuar.',
            },
            reason: 'automation_failure',
          });
          assert.equal(result.notice.send_authorized, true);
          const open = await env.reads.getConversationHandoff({
            conversationId: inbound.conversation_id,
          });
          assert.equal(open.handoff.reasonCode, 'automation_failure');
          assert.match(open.handoff.summary, /assistente falhou/u);
        },
      );

      await t.test(
        'AGENTE-OBS-01: turns are stored once per receipt, fence refusals are counted and the panel aggregates them',
        async () => {
          const turnReply = {
            answer_status: 'answered',
            asked_field: 'colors',
            ficha_filled: 2,
            ficha_total: 8,
            latency_ms: 5400,
            media_kind: 'text',
            model: 'gpt-5.6-luna',
            trigger: null,
          };
          const first = await env.receive('5527990000701', 'wamid.obs.1');
          const event = {
            automation_epoch: first.automation_epoch,
            command_id: 'command-obs-1',
            conversation_id: first.conversation_id,
            event_id: 'reply-obs-1',
            event_type: 'message.send.requested',
            message: { text: 'Quais cores você quer?', type: 'text' },
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
            source_revision: first.source_revision,
            technical: env.technical('reply-obs-1'),
            turn: turnReply,
          };
          const [accepted, replayed] = await Promise.all([
            env.n8n.recordEvent(event),
            env.n8n.recordEvent(event),
          ]);
          assert.deepEqual([accepted.duplicate, replayed.duplicate].sort(), [
            false,
            true,
          ]);
          await assert.rejects(
            env.n8n.recordEvent({
              ...event,
              turn: { ...turnReply, latency_ms: 1 },
            }),
            { code: 'IDEMPOTENCY_CONFLICT' },
          );
          const turns = await pool.query(
            `SELECT event_type, asked_field, ficha_filled, ficha_total,
                    workflow_version, handoff_reason
             FROM crm.automation_turns WHERE conversation_id=$1`,
            [first.conversation_id],
          );
          assert.deepEqual(turns.rows, [
            {
              asked_field: 'colors',
              event_type: 'message.send.requested',
              ficha_filled: 2,
              ficha_total: 8,
              handoff_reason: null,
              workflow_version: 'mvp-simple-14',
            },
          ]);
          // A late duplicate turn for the same revision is fenced and counted.
          await assert.rejects(
            env.reply(first, 'reply-obs-stale', {
              command_id: 'command-obs-stale',
              turn: turnReply,
            }),
            { code: 'STALE_AUTOMATION_FENCE' },
          );
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::integer AS total FROM crm.audit_events
                 WHERE action='integration.n8n.stale_fence' AND target_id=$1`,
                [first.conversation_id],
              )
            ).rows[0].total,
            1,
          );

          env.advance(1);
          const second = await env.receive('5527990000701', 'wamid.obs.2');
          const handoffAt = env.clock.now.toISOString();
          const handoff = await env.requestHandoff(
            second,
            'handoff-obs-1',
            { reason: 'briefing_complete', summary: 'Ficha completa.' },
            {
              turn: {
                answer_status: 'answered',
                asked_field: null,
                ficha_filled: 6,
                ficha_total: 8,
                trigger: 'briefing_complete',
              },
            },
          );
          env.advance(12);
          const claim = await env.handoffs.claimHandoff({
            actor: SELLER,
            correlationId: 'correlation-claim-obs-1',
            expectedHandoffVersion: 1,
            handoffId: handoff.handoff_id,
            idempotencyKey: 'claim-obs-1',
          });
          assert.equal(claim.handoff.status, 'accepted');

          const context = await env.reads.getAssistantContext({
            conversationId: second.conversation_id,
          });
          assert.deepEqual(context, {
            assistant_message_cap: 15,
            assistant_messages: 1,
            last_turn: {
              answer_status: 'answered',
              asked_field: null,
              ficha_filled: 6,
              ficha_total: 8,
              occurred_at: handoffAt,
              trigger: 'briefing_complete',
            },
          });
          assert.deepEqual(
            await env.reads.getAssistantContext({
              conversationId: (
                await env.receive('5527990000702', 'wamid.obs.none')
              ).conversation_id,
            }),
            {
              assistant_message_cap: 15,
              assistant_messages: 0,
              last_turn: null,
            },
          );
          await assert.rejects(
            env.reads.getAssistantContext({ conversationId: 'missing' }),
            { code: 'CONVERSATION_NOT_FOUND', statusCode: 404 },
          );

          const performance = await env.reads.assistantPerformance({ days: 1 });
          assert.equal(performance.window.days, 1);
          assert.equal(
            Date.parse(performance.window.to) -
              Date.parse(performance.window.from),
            24 * 60 * 60_000,
          );
          const reasons = Object.fromEntries(
            performance.handoffs.by_reason.map((/** @type {any} */ row) => [
              row.reason_code,
              row.count,
            ]),
          );
          const stored = await pool.query(
            `SELECT reason_code, count(*)::integer AS total FROM crm.handoffs
             GROUP BY reason_code`,
          );
          assert.deepEqual(
            reasons,
            Object.fromEntries(
              stored.rows.map((/** @type {any} */ row) => [
                row.reason_code,
                row.total,
              ]),
            ),
          );
          assert.equal(
            performance.handoffs.total,
            stored.rows.reduce(
              (/** @type {number} */ sum, /** @type {any} */ row) =>
                sum + row.total,
              0,
            ),
          );
          assert.deepEqual(performance.ficha_at_handoff, {
            avg_ratio: 0.75,
            samples: 1,
          });
          assert.ok(performance.time_to_claim_minutes.samples >= 2);
          assert.equal(
            typeof performance.time_to_claim_minutes.median,
            'number',
          );
          assert.equal(typeof performance.time_to_claim_minutes.p90, 'number');
          assert.ok(performance.time_to_resolve_minutes.samples >= 2);
          assert.ok(performance.failures.stale_fence >= 1);
          assert.equal(
            performance.failures.automation_failure_handoffs,
            reasons.automation_failure,
          );
          assert.deepEqual(
            performance.by_workflow_version.find(
              (/** @type {any} */ row) =>
                row.workflow_version === 'mvp-simple-14',
            ),
            { handoffs: 1, turns: 2, workflow_version: 'mvp-simple-14' },
          );
          assert.ok(performance.assistant_replies >= 1);
          assert.ok(performance.conversations_with_assistant >= 2);
          assert.equal(
            performance.stalled_now,
            await countStalledConversations(env.database, env.clock.now, 5),
          );
          // Aggregates only: no conversation, phone, name or message text.
          assert.doesNotMatch(
            JSON.stringify(performance),
            /5527|conversation-|Ana|Quais cores|Ficha completa/u,
          );
          const empty = await env.reads.assistantPerformance({ days: 1 });
          assert.equal(typeof empty.window.from, 'string');
          await assert.rejects(env.reads.assistantPerformance({ days: 0 }), {
            code: 'INVALID_DAYS',
          });
          await assert.rejects(env.reads.assistantPerformance({ days: 91 }), {
            code: 'INVALID_DAYS',
          });
        },
      );

      await t.test(
        'INBOX-AUDIO-TRANSCRIPT-01: the transcript is sealed, idempotent, read by the agent and shown in the Inbox',
        async () => {
          const phone = '5527990000801';
          /** @param {string} id */
          const audio = (id) =>
            env.receive(phone, id, {
              attachment: { external_id: `media-${id}` },
              external_id: id,
              type: 'audio',
            });
          const first = await audio('wamid.audio.1');
          const transcribed = {
            conversation_id: first.conversation_id,
            event_id: 'transcribed-audio-1',
            event_type: 'message.transcribed',
            external_message_id: 'wamid.audio.1',
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
            technical: env.technical('transcribed-audio-1'),
            transcript: {
              status: 'ok',
              text: 'Quero vinte camisas azuis para o time',
            },
          };
          const [accepted, replayed] = await Promise.all([
            env.n8n.recordEvent(transcribed),
            env.n8n.recordEvent(transcribed),
          ]);
          assert.deepEqual([accepted.duplicate, replayed.duplicate].sort(), [
            false,
            true,
          ]);
          await assert.rejects(
            env.n8n.recordEvent({
              ...transcribed,
              transcript: { status: 'ok', text: 'outro texto' },
            }),
            { code: 'IDEMPOTENCY_CONFLICT' },
          );
          await assert.rejects(
            env.n8n.recordEvent({
              ...transcribed,
              event_id: 'transcribed-audio-1-again',
              technical: env.technical('transcribed-audio-1-again'),
            }),
            { code: 'TRANSCRIPT_ALREADY_RECORDED' },
          );
          const stored = (
            await pool.query(
              `SELECT transcript_status, transcript_code,
                      transcript_envelope::text AS envelope
               FROM crm.messages WHERE external_message_id='wamid.audio.1'`,
            )
          ).rows[0];
          assert.equal(stored.transcript_status, 'ok');
          assert.equal(stored.transcript_code, null);
          assert.doesNotMatch(stored.envelope, /camisas|azuis/u);
          assert.match(stored.envelope, /AES-256-GCM/u);

          // A failed attempt, then a successful one, on a second audio.
          env.advance(1);
          const second = await audio('wamid.audio.2');
          const failed = {
            ...transcribed,
            event_id: 'transcribed-audio-2-failed',
            external_message_id: 'wamid.audio.2',
            technical: env.technical('transcribed-audio-2-failed'),
            transcript: { code: 'AUDIO_TOO_LARGE', status: 'failed' },
          };
          await env.n8n.recordEvent(failed);
          const detailFailed = await env.reads.getConversation({
            conversationId: second.conversation_id,
          });
          const failedMessage = detailFailed.messages.find(
            (/** @type {any} */ message) =>
              message.type === 'audio' &&
              message.transcript?.status === 'failed',
          );
          assert.deepEqual(failedMessage.transcript, {
            status: 'failed',
            text: null,
          });
          env.advance(1);
          const third = await env.receive(phone, 'wamid.text.after-audio');
          const agentView = third.recent_messages.filter(
            (/** @type {any} */ message) => message.type === 'audio',
          );
          assert.deepEqual(
            agentView.map((/** @type {any} */ message) => [
              message.external_id,
              message.text,
              message.transcribed,
            ]),
            [
              ['wamid.audio.1', 'Quero vinte camisas azuis para o time', true],
              ['wamid.audio.2', '', false],
            ],
          );
          assert.equal(
            third.recent_messages.find(
              (/** @type {any} */ message) =>
                message.external_id === 'wamid.text.after-audio',
            ).transcribed,
            false,
          );
          await env.n8n.recordEvent({
            ...failed,
            event_id: 'transcribed-audio-2-ok',
            technical: env.technical('transcribed-audio-2-ok'),
            transcript: { status: 'ok', text: 'Tamanhos P e M' },
          });
          const detail = await env.reads.getConversation({
            conversationId: second.conversation_id,
          });
          const audios = detail.messages.filter(
            (/** @type {any} */ message) => message.type === 'audio',
          );
          assert.deepEqual(
            audios.map((/** @type {any} */ message) => message.transcript),
            [
              { status: 'ok', text: 'Quero vinte camisas azuis para o time' },
              { status: 'ok', text: 'Tamanhos P e M' },
            ],
          );
          assert.equal(
            detail.messages.find(
              (/** @type {any} */ message) => message.type === 'text',
            ).transcript,
            null,
          );

          // Only an inbound audio of the same conversation.
          await assert.rejects(
            env.n8n.recordEvent({
              ...transcribed,
              event_id: 'transcribed-text',
              external_message_id: 'wamid.text.after-audio',
              technical: env.technical('transcribed-text'),
            }),
            { code: 'TRANSCRIPT_TARGET_INVALID' },
          );
          const elsewhere = await env.receive('5527990000802', 'wamid.other');
          await assert.rejects(
            env.n8n.recordEvent({
              ...transcribed,
              conversation_id: elsewhere.conversation_id,
              event_id: 'transcribed-elsewhere',
              technical: env.technical('transcribed-elsewhere'),
            }),
            { statusCode: 404 },
          );
          for (const transcript of [
            { status: 'ok', text: '' },
            { status: 'ok', text: 'x'.repeat(4001) },
            { code: 'TRANSCRIPTION_FAILED', status: 'ok', text: 'a' },
            { status: 'failed', text: 'a' },
            { code: 'OTHER', status: 'failed' },
            { status: 'pending' },
          ]) {
            await assert.rejects(
              env.n8n.recordEvent({
                ...transcribed,
                event_id: 'transcribed-invalid',
                technical: env.technical('transcribed-invalid'),
                transcript,
              }),
              { name: 'N8nValidationError' },
            );
          }
          const performance = await env.reads.assistantPerformance({ days: 1 });
          assert.equal(performance.failures.transcription_failed, 1);
        },
      );

      await t.test(
        'INBOX-DELIVERY-02: the assistant send failure code is bounded, stored and shown',
        async () => {
          const inbound = await env.receive('5527990000901', 'wamid.del.1');
          await env.reply(inbound, 'reply-del-1');
          await env.n8n.recordEvent({
            command_id: 'command-reply-del-1',
            conversation_id: inbound.conversation_id,
            event_id: 'unknown-del-1',
            event_type: 'message.send.unknown',
            failure: { code: 'META_SEND_OUTCOME_UNKNOWN' },
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
            technical: env.technical('unknown-del-1'),
          });
          /** @param {string} conversationId */
          const botMessage = async (conversationId) =>
            (await env.reads.getConversation({ conversationId })).messages.find(
              (/** @type {any} */ message) =>
                message.authorKind === 'assistant',
            );
          let message = await botMessage(inbound.conversation_id);
          assert.equal(message.deliveryStatus, 'outcome_unknown');
          assert.equal(message.deliveryErrorCode, 'META_SEND_OUTCOME_UNKNOWN');

          env.advance(1);
          const next = await env.receive('5527990000901', 'wamid.del.2');
          await env.reply(next, 'reply-del-2', {
            command_id: 'command-reply-del-2',
          });
          // The workflow published today may omit the failure.
          await env.n8n.recordEvent({
            command_id: 'command-reply-del-2',
            conversation_id: next.conversation_id,
            event_id: 'unknown-del-2',
            event_type: 'message.send.unknown',
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
            technical: env.technical('unknown-del-2'),
          });
          assert.equal(
            (
              await pool.query(
                'SELECT delivery_failure_code FROM crm.messages WHERE command_id=$1',
                ['command-reply-del-2'],
              )
            ).rows[0].delivery_failure_code,
            'SEND_OUTCOME_UNKNOWN',
          );

          // Sent, then failed with a code outside the pattern, then delivered.
          const other = await env.receive('5527990000902', 'wamid.del.3');
          await env.reply(other, 'reply-del-3', {
            command_id: 'command-reply-del-3',
          });
          const base = {
            conversation_id: other.conversation_id,
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
          };
          await env.n8n.recordEvent({
            ...base,
            command_id: 'command-reply-del-3',
            event_id: 'sent-del-3',
            event_type: 'message.sent',
            external_message_id: 'wamid.out.del.3',
            technical: env.technical('sent-del-3'),
          });
          await assert.rejects(
            env.n8n.recordEvent({
              ...base,
              event_id: 'failed-del-3-extra',
              event_type: 'message.failed',
              external_message_id: 'wamid.out.del.3',
              failure: { code: 'META_131047', detail: 'Cliente 5527...' },
              technical: env.technical('failed-del-3-extra'),
            }),
            { name: 'N8nValidationError' },
          );
          await env.n8n.recordEvent({
            ...base,
            event_id: 'failed-del-3',
            event_type: 'message.failed',
            external_message_id: 'wamid.out.del.3',
            failure: { code: 'erro do cliente 5527990000902' },
            technical: env.technical('failed-del-3'),
          });
          const failedRow = (
            await pool.query(
              'SELECT delivery_failure_code, delivery_status FROM crm.messages WHERE command_id=$1',
              ['command-reply-del-3'],
            )
          ).rows[0];
          assert.deepEqual(failedRow, {
            delivery_failure_code: 'SEND_FAILED',
            delivery_status: 'failed',
          });
          message = await botMessage(other.conversation_id);
          assert.equal(message.deliveryErrorCode, 'SEND_FAILED');
          await env.n8n.recordEvent({
            ...base,
            event_id: 'delivered-del-3',
            event_type: 'message.delivered',
            external_message_id: 'wamid.out.del.3',
            technical: env.technical('delivered-del-3'),
          });
          message = await botMessage(other.conversation_id);
          assert.equal(message.deliveryStatus, 'delivered');
          assert.equal(message.deliveryErrorCode, null);
          assert.equal(
            (
              await pool.query(
                'SELECT delivery_failure_code FROM crm.messages WHERE command_id=$1',
                ['command-reply-del-3'],
              )
            ).rows[0].delivery_failure_code,
            null,
          );
        },
      );

      await t.test(
        'VND-CTX-01: recent messages keep every subject and a returning customer gets a bounded context',
        async () => {
          const phone = '5527990001001';
          const first = await env.receive(phone, 'wamid.ctx.1');
          assert.deepEqual(first.contact_context, {
            last_closed_at: null,
            previous_cycles: 0,
            previous_orders_count: 0,
          });
          const contactId = first.contact_id;
          /** @param {string} id @param {string|null} conversationId @param {string} status @param {string} kind @param {string} createdAt */
          const order = async (id, conversationId, status, kind, createdAt) => {
            const confirmed = status === 'confirmado';
            await pool.query(
              `INSERT INTO crm.orders
                 (id, number_sequence, number, conversation_id, status,
                  fab_code, ficha_envelope, final_amount_cents,
                  payment_condition, order_date, confirmed_at, confirmed_by,
                  created_by_kind, created_by, created_at, updated_at,
                  contact_id, manual_owner_id, manual_create_key)
               SELECT $1, sequence, lpad(sequence::text, 2, '0') || '-CRM', $2,
                      $3, 'FAB-TEST', $4::jsonb, $5, $6, $7, $8, $9, 'user',
                      $9, $10, $10, $11, $12, $13
               FROM (SELECT nextval('crm.order_number_seq') AS sequence) next`,
              [
                id,
                conversationId,
                status,
                JSON.stringify(
                  encryptJson(
                    {
                      items: [{ tipo: kind }],
                      summary: { cliente: 'Cliente Sintética' },
                    },
                    `order-ficha:${id}`,
                    N8N_KEY,
                  ),
                ),
                confirmed ? 123_45 : null,
                confirmed ? 'pix' : null,
                confirmed ? createdAt.slice(0, 10) : null,
                confirmed ? createdAt : null,
                SELLER.id,
                createdAt,
                contactId,
                conversationId ? null : SELLER.id,
                conversationId ? null : `manual-${id}`,
              ],
            );
          };
          await order(
            'order-ctx-1',
            first.conversation_id,
            'confirmado',
            'Camisa polo',
            '2026-07-10T15:00:00.000Z',
          );
          await order(
            'order-ctx-2',
            first.conversation_id,
            'confirmado',
            'Uniforme de futebol',
            '2026-08-10T15:00:00.000Z',
          );
          await order(
            'order-ctx-3',
            first.conversation_id,
            'confirmado',
            'Regata',
            '2026-09-10T15:00:00.000Z',
          );
          await order(
            'order-ctx-4',
            null,
            'confirmado',
            'x'.repeat(120),
            '2026-10-01T15:00:00.000Z',
          );

          const owned = await env.inbox.takeover({
            actor: SELLER,
            conversationId: first.conversation_id,
            correlationId: 'correlation-takeover-ctx',
            expectedVersion: await env.version(first.conversation_id),
            idempotencyKey: 'takeover-ctx',
            reason: 'Assumir',
          });
          await env.inbox.closeConversation({
            acknowledgePending: false,
            actor: SELLER,
            conversationId: first.conversation_id,
            correlationId: 'correlation-close-ctx',
            expectedVersion: owned.version,
            idempotencyKey: 'close-ctx',
            outcome: 'concluido',
            reason: 'Encerramento: concluido',
          });

          env.advance(1);
          const second = await env.receive(phone, 'wamid.ctx.2');
          assert.notEqual(second.conversation_id, first.conversation_id);
          await order(
            'order-ctx-current',
            second.conversation_id,
            'pendente',
            'Moletom',
            '2026-10-29T15:00:00.000Z',
          );
          const closedDay = (
            await pool.query(
              `SELECT to_char(terminal_at AT TIME ZONE 'America/Sao_Paulo',
                              'YYYY-MM-DD') AS day
               FROM crm.conversations WHERE id=$1`,
              [first.conversation_id],
            )
          ).rows[0].day;

          // Two subjects; the customer message refers to both.
          for (const [position, subjectId] of [
            'subject-ctx-a',
            'subject-ctx-b',
          ].entries()) {
            await pool.query(
              `INSERT INTO crm.conversation_subjects
                 (id, conversation_id, contact_id, order_id, kind, position,
                  is_current, selected_source, selected_by, selected_at,
                  created_by, created_by_kind, version, created_at, updated_at)
               VALUES ($1, $2, $3, NULL, 'geral', $4, $5, $6, $7, $8,
                       $7, 'human', 1, $8, $8)`,
              [
                subjectId,
                second.conversation_id,
                contactId,
                position + 1,
                position === 0,
                position === 0 ? 'human' : null,
                SELLER.id,
                env.clock.now,
              ],
            );
          }
          const linked = (
            await pool.query(
              `SELECT id FROM crm.messages
               WHERE conversation_id=$1 AND external_message_id='wamid.ctx.2'`,
              [second.conversation_id],
            )
          ).rows[0].id;
          for (const subjectId of ['subject-ctx-b', 'subject-ctx-a']) {
            await pool.query(
              `INSERT INTO crm.message_subject_links
                 (message_id, subject_id, conversation_id, assigned_by,
                  assigned_by_kind, assigned_at)
               VALUES ($1, $2, $3, $4, 'human', $5)`,
              [
                linked,
                subjectId,
                second.conversation_id,
                SELLER.id,
                env.clock.now,
              ],
            );
          }
          env.advance(1);
          const third = await env.receive(phone, 'wamid.ctx.3');
          assert.equal(third.conversation_id, second.conversation_id);
          assert.deepEqual(
            third.recent_messages.map((/** @type {any} */ message) => [
              message.external_id,
              message.subject_ids,
            ]),
            [
              ['wamid.ctx.2', ['subject-ctx-a', 'subject-ctx-b']],
              ['wamid.ctx.3', []],
            ],
          );
          // RULES.md 8/13: counts and one date only. Four earlier orders
          // (one manual, three of the closed cycle); the current one is out.
          assert.deepEqual(third.contact_context, {
            last_closed_at: closedDay,
            previous_cycles: 1,
            previous_orders_count: 4,
          });
          // No amount, address, payment or customer name.
          assert.doesNotMatch(
            JSON.stringify(third.contact_context),
            /12345|pix|Cliente Sintética|Moletom|Camisa|Regata|CRM|confirmado|concluido/u,
          );
        },
      );

      await t.test(
        'AGENTE-FAIL-01: a reply that failed, ended unknown or is stuck sending does not count as an answer',
        async () => {
          /** @param {string} suffix */
          const answeredWith = async (suffix) => {
            const inbound = await env.receive(
              `55279900011${suffix}`,
              `wamid.m1.${suffix}`,
            );
            await env.reply(inbound, `reply-m1-${suffix}`);
            return inbound;
          };
          const failed = await answeredWith('01');
          await env.sent(failed, 'reply-m1-01');
          await env.n8n.recordEvent({
            conversation_id: failed.conversation_id,
            event_id: 'failed-m1-01',
            event_type: 'message.failed',
            external_message_id: 'wamid.out.reply-m1-01',
            failure: { code: 'META_131047' },
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
            technical: env.technical('failed-m1-01'),
          });
          const unknown = await answeredWith('02');
          await env.n8n.recordEvent({
            command_id: 'command-reply-m1-02',
            conversation_id: unknown.conversation_id,
            event_id: 'unknown-m1-02',
            event_type: 'message.send.unknown',
            occurred_at: env.clock.now.toISOString(),
            schema_version: '1.0',
            technical: env.technical('unknown-m1-02'),
          });
          const stuck = await answeredWith('03');
          const delivered = await answeredWith('04');
          await env.sent(delivered, 'reply-m1-04');
          // A delivery receipt that ended unknown is not an answer either.
          const deliveredUnknownStatus = await answeredWith('05');
          await env.sent(deliveredUnknownStatus, 'reply-m1-05');
          await pool.query(
            `UPDATE crm.messages SET delivery_status='outcome_unknown'
             WHERE command_id='command-reply-m1-05'`,
          );
          // The customer wrote long ago, but the reply went out a minute ago
          // and is still sending: within the 2-minute grace, an answer.
          const freshSending = await env.receive(
            '5527990001106',
            'wamid.m1.06',
          );
          const handedOff = async (/** @type {any} */ inbound) =>
            Number(
              (
                await pool.query(
                  `SELECT count(*)::integer AS total FROM crm.handoffs
                   WHERE conversation_id=$1 AND reason_code='automation_failure'`,
                  [inbound.conversation_id],
                )
              ).rows[0].total,
            );
          env.advance(6);
          await env.reply(freshSending, 'reply-m1-06');
          env.advance(1);
          await env.sweeper.sweep();
          assert.deepEqual(
            await Promise.all(
              [
                failed,
                unknown,
                stuck,
                delivered,
                deliveredUnknownStatus,
                freshSending,
              ].map(handedOff),
            ),
            [1, 1, 1, 0, 1, 0],
          );
        },
      );

      await t.test(
        'AGENTE-FAIL-01: the sweep follows the revision fence, not the clock order of the rows',
        async () => {
          // A new customer revision whose receive time reads earlier than the
          // reply to the previous revision is still unanswered.
          const first = await env.receive('5527990001201', 'wamid.b1.1');
          await env.reply(first, 'reply-b1-1');
          await env.sent(first, 'reply-b1-1');
          const second = await env.receive('5527990001201', 'wamid.b1.2');
          assert.equal(second.source_revision, 2);
          await pool.query(
            `UPDATE crm.messages SET created_at = created_at - interval '1 minute',
                    occurred_at = occurred_at - interval '1 minute'
             WHERE external_message_id='wamid.b1.2'`,
          );
          // A reply to the latest revision that reads earlier than its
          // inbound (clock taken before the lock) is still an answer.
          const other = await env.receive('5527990001202', 'wamid.b1.3');
          await env.reply(other, 'reply-b1-3');
          await env.sent(other, 'reply-b1-3');
          await pool.query(
            `UPDATE crm.messages SET created_at = created_at - interval '1 minute',
                    occurred_at = occurred_at - interval '1 minute'
             WHERE command_id='command-reply-b1-3'`,
          );
          env.advance(6);
          await env.sweeper.sweep();
          const reasons = await pool.query(
            `SELECT conversation_id FROM crm.handoffs
             WHERE conversation_id = ANY($1) AND reason_code='automation_failure'`,
            [[first.conversation_id, other.conversation_id]],
          );
          assert.deepEqual(
            reasons.rows.map((/** @type {any} */ row) => row.conversation_id),
            [first.conversation_id],
          );
        },
      );

      await t.test(
        'AGENTE-FAIL-01: one failing conversation does not abort the batch',
        async () => {
          const blocked = await env.receive('5527990001301', 'wamid.b2.1');
          const free = await env.receive('5527990001302', 'wamid.b2.2');
          env.advance(6);
          const holder = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM crm.conversations WHERE id=$1 FOR UPDATE',
              [blocked.conversation_id],
            );
            const result = await env.sweeper.sweep();
            assert.ok(result.failed >= 1);
            assert.ok(result.errorCodes.includes('55P03'));
            assert.ok(result.handedOff >= 1);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
          const states = await pool.query(
            `SELECT id, automation_state FROM crm.conversations
             WHERE id = ANY($1) ORDER BY id`,
            [[blocked.conversation_id, free.conversation_id]],
          );
          assert.deepEqual(
            Object.fromEntries(
              states.rows.map((/** @type {any} */ row) => [
                row.id,
                row.automation_state,
              ]),
            ),
            {
              [blocked.conversation_id]: 'assistant',
              [free.conversation_id]: 'human',
            },
          );
          // The next run hands the blocked one off.
          assert.ok((await env.sweeper.sweep()).handedOff >= 1);
          assert.equal(
            (
              await pool.query(
                'SELECT automation_state FROM crm.conversations WHERE id=$1',
                [blocked.conversation_id],
              )
            ).rows[0].automation_state,
            'human',
          );
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
} else {
  test('PostgreSQL Vendedor evolution test requires TEST_DATABASE_URL', {
    skip: true,
  });
}

/** @param {Pool} pool */
async function waitingCount(pool) {
  return Number(
    (
      await pool.query(
        `SELECT count(*)::integer AS total FROM crm.handoffs handoff
         JOIN crm.conversations conversation ON conversation.id=handoff.conversation_id
         WHERE handoff.status='pending' AND conversation.archived_at IS NULL
           AND conversation.state NOT IN ('convertida_em_lead','sem_lead','encerrada')`,
      )
    ).rows[0].total,
  );
}
