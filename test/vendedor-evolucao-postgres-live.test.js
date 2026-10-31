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
  PostgresN8nIntegrationRepository,
  createN8nIntegrationService,
} from '../modules/n8n-integration/src/index.js';
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
  const clock = { now: new Date(Date.now() - 60 * 60_000) };
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

  /** @param {string} conversationId */
  const version = async (conversationId) =>
    Number(
      (
        await pool.query('SELECT version FROM crm.conversations WHERE id=$1', [
          conversationId,
        ])
      ).rows[0].version,
    );

  return {
    advance,
    clock,
    database,
    handoffs,
    inbox,
    n8n,
    reads,
    receive,
    reply,
    repository,
    requestHandoff,
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
