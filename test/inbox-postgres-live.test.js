import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  PostgresContactIdentityRepository,
  createContactIdentityService,
} from '../modules/contacts/src/index.js';
import {
  InboxValidationError,
  PostgresInboxRepository,
  createChannelEventHandler,
  createChannelEventJobHandler,
  createInboxService,
  createSubjectService,
} from '../modules/inbox-channels/src/index.js';
import {
  PostgresOutboundMessageOutbox,
  PostgresWebhookInbox,
} from '../modules/integration-reliability/src/index.js';
import { PostgresN8nCommandOutbox } from '../modules/n8n-integration/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-09-02T12:00:00.000Z');
const ATTENDANT = Object.freeze({
  functionName: 'Vendedor',
  id: 'user-attendant-live',
  kind: 'human',
});

/** @param {Pool} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}

/**
 * The attendant must exist as an operator: taking a conversation over writes
 * its id to conversations.assigned_user_id, which references crm.users.
 * @param {Pool} pool
 */
async function seedAttendant(pool) {
  await pool.query(
    `INSERT INTO crm.users (id, email, password_hash, name)
     VALUES ($1, $2, '$argon2id$synthetic', 'Atendente Sintética')`,
    [ATTENDANT.id, `${ATTENDANT.id}@example.test`],
  );
  await pool.query(
    `INSERT INTO crm.user_functions (user_id, function_name)
     VALUES ($1, $2)`,
    [ATTENDANT.id, ATTENDANT.functionName],
  );
}

/** @param {Pool} pool @param {{outboundMessageOutbox?: {enqueueChannelMessage: (input: any, context: {transaction: any}) => Promise<void>}}} [options] */
function servicesFor(pool, options = {}) {
  const database = databaseFor(pool);
  const outboundMessageOutbox =
    options.outboundMessageOutbox ?? new PostgresOutboundMessageOutbox();
  const auditPort = {
    async append(/** @type {any} */ event, context = /** @type {any} */ ({})) {
      const queryable = context.transaction ?? database;
      await queryable.query(
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
          NOW,
        ],
      );
    },
  };
  return {
    contacts: createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: Buffer.alloc(32, 42),
        lookupKey: Buffer.alloc(32, 43),
      }),
    }),
    inbox: createInboxService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: Buffer.alloc(32, 41),
        outboundMessageOutbox,
      }),
    }),
  };
}

/** @param {string} runId @param {string} [providerAccountId] */
function identityInput(runId, providerAccountId = `account-${runId}`) {
  return {
    channel: 'instagram',
    correlationId: `correlation-identity-${runId}`,
    displayHandle: `@synthetic_${runId.slice(0, 8)}`,
    externalIdentityId: `identity-${runId}`,
    identityKind: 'handle',
    occurredAt: NOW.toISOString(),
    phoneStatus: 'pending',
    provider: 'meta',
    providerAccountId,
  };
}

/** @param {string} runId @param {any} resolved @param {Record<string, any>} [overrides] */
function inboundInput(runId, resolved, overrides = {}) {
  return {
    contactId: resolved.contact.id,
    correlationId: `correlation-message-${runId}`,
    externalConversationId: `conversation-${runId}`,
    externalMessageId: `message-${runId}`,
    identityId: resolved.identity.id,
    message: {
      content: { text: `PII-canary-${runId}` },
      type: 'text',
    },
    occurredAt: NOW.toISOString(),
    provider: 'meta',
    providerAccountId: `account-${runId}`,
    ...overrides,
  };
}

/** @param {string} runId */
function canonicalWebhookEvent(runId) {
  const scope = (/** @type {string} */ externalId) => ({
    externalId,
    key: JSON.stringify(['meta', `account-${runId}`, externalId]),
    provider: 'meta',
    providerAccountId: `account-${runId}`,
  });
  return {
    channel: 'whatsapp',
    direction: 'inbound',
    externalConversationId: scope(`conversation-${runId}`),
    externalEventId: scope(`event-${runId}`),
    externalMessageId: scope(`message-${runId}`),
    identity: {
      automaticMergeAllowed: false,
      displayHandle: null,
      externalId: scope(`identity-${runId}`),
      kind: 'phone',
      mergePolicy: 'verified-evidence-only',
      phoneStatus: 'confirmed',
    },
    message: { content: { text: `PII-chain-${runId}` }, type: 'text' },
    occurredAt: NOW.toISOString(),
    origin: 'channel',
    provider: 'meta',
    providerAccountId: `account-${runId}`,
    schemaVersion: 1,
    visibility: 'inbox',
  };
}

if (connectionString) {
  test('OPS-INBOX-SEND-08: PostgreSQL refuses test accounts before message, audit, command or outbox writes', async () => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 4 });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await seedAttendant(pool);
      const { contacts, inbox } = servicesFor(pool, {
        outboundMessageOutbox: new PostgresN8nCommandOutbox({
          envelopeKey: Buffer.alloc(32, 44),
          messageEnvelopeKey: Buffer.alloc(32, 41),
          contactEnvelopeKey: Buffer.alloc(32, 42),
        }),
      });
      for (const providerAccountId of [
        'dev-phone-number',
        'synthetic-ux-longitudinal',
      ]) {
        const runId = randomUUID().replaceAll('-', '');
        const identity = await contacts.resolveInboundIdentity(
          identityInput(runId, providerAccountId),
        );
        const received = await inbox.receiveInbound(
          inboundInput(runId, identity, { providerAccountId }),
        );
        const command = {
          actor: ATTENDANT,
          content: { text: 'Mensagem sintética' },
          conversationId: received.conversation.id,
          correlationId: `blocked-${runId}`,
          expectedVersion: received.conversation.version,
          idempotencyKey: `blocked-${runId}`,
          messageType: 'text',
          reason: 'Resposta',
        };
        const snapshot = async () =>
          (
            await pool.query(
              `SELECT to_jsonb(conversation) AS conversation,
          (SELECT count(*)::integer FROM crm.messages) AS messages,
          (SELECT count(*)::integer FROM crm.audit_events) AS audits,
          (SELECT count(*)::integer FROM crm.inbox_commands) AS commands,
          (SELECT count(*)::integer FROM crm.n8n_commands) AS n8n_commands,
          (SELECT count(*)::integer FROM crm.domain_events) AS events,
          (SELECT count(*)::integer FROM crm.outbox_jobs) AS jobs
          FROM crm.conversations conversation WHERE id=$1`,
              [received.conversation.id],
            )
          ).rows[0];
        const before = await snapshot();
        for (const messageType of ['text', 'image', 'audio', 'video'])
          for (let attempt = 0; attempt < 2; attempt++)
            await assert.rejects(
              inbox.sendHumanMessage({
                ...command,
                messageType,
                content:
                  messageType === 'text'
                    ? command.content
                    : { mediaId: '11111111-1111-4111-8111-111111111111' },
              }),
              { code: 'NON_PRODUCTION_CONVERSATION', statusCode: 403 },
            );
        assert.deepEqual(await snapshot(), before);
        const productionId = `${runId}-production`;
        const productionAccount = `account-${productionId}`;
        const productionIdentity = await contacts.resolveInboundIdentity(
          identityInput(productionId, productionAccount),
        );
        const production = await inbox.receiveInbound(
          inboundInput(productionId, productionIdentity, {
            providerAccountId: productionAccount,
          }),
        );
        const allowed = {
          ...command,
          conversationId: production.conversation.id,
          expectedVersion: production.conversation.version,
        };
        const sent = await inbox.sendHumanMessage(allowed);
        assert.equal(sent.status, 'queued');
        assert.deepEqual(await inbox.sendHumanMessage(allowed), sent);
        const queued = (
          await pool.query(
            `SELECT count(*)::integer AS count FROM crm.n8n_commands WHERE command_id=$1`,
            [command.idempotencyKey],
          )
        ).rows[0];
        assert.equal(queued.count, 1);
      }
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL coalesces concurrent inbound into one anchored identity, contact, cycle and message', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 24 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const { contacts, inbox } = servicesFor(pool);
      const identities = await Promise.all(
        Array.from({ length: 20 }, () =>
          contacts.resolveInboundIdentity(identityInput(runId)),
        ),
      );
      assert.equal(
        new Set(identities.map(({ contact }) => contact.id)).size,
        1,
      );
      assert.equal(
        new Set(identities.map(({ identity }) => identity.id)).size,
        1,
      );
      const received = await Promise.all(
        Array.from({ length: 20 }, () =>
          inbox.receiveInbound(inboundInput(runId, identities[0])),
        ),
      );
      assert.equal(
        new Set(received.map(({ conversation }) => conversation.id)).size,
        1,
      );
      assert.equal(new Set(received.map(({ message }) => message.id)).size, 1);
      const laterInput = inboundInput(runId, identities[0], {
        externalMessageId: `message-later-${runId}`,
        occurredAt: '2026-09-02T12:01:00.000Z',
      });
      const later = await inbox.receiveInbound(laterInput);
      const laterReplay = await inbox.receiveInbound(laterInput);
      assert.equal(
        later.conversation.version,
        received[0].conversation.version + 1,
      );
      assert.equal(later.conversation.updatedAt, laterInput.occurredAt);
      assert.deepEqual(laterReplay, later);

      const counts = await pool.query(
        `SELECT
          (SELECT count(*)::integer FROM crm.contacts) AS contacts,
          (SELECT count(*)::integer FROM crm.contact_identities) AS identities,
          (SELECT count(*)::integer FROM crm.conversations) AS conversations,
          (SELECT count(*)::integer FROM crm.messages) AS messages`,
      );
      assert.deepEqual(counts.rows[0], {
        contacts: 1,
        conversations: 1,
        identities: 1,
        messages: 2,
      });
      const raw = await pool.query(
        `SELECT row_to_json(m)::text AS stored FROM crm.messages m LIMIT 1`,
      );
      assert.doesNotMatch(
        raw.rows[0].stored,
        new RegExp(`PII-canary-${runId}`),
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL isolates provider accounts and creates one cycle after terminal state under concurrency', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const { contacts, inbox } = servicesFor(pool);
      const left = await contacts.resolveInboundIdentity(identityInput(runId));
      const right = await contacts.resolveInboundIdentity(
        identityInput(runId, `account-other-${runId}`),
      );
      assert.notEqual(left.identity.id, right.identity.id);
      assert.notEqual(left.contact.id, right.contact.id);

      const first = await inbox.receiveInbound(inboundInput(runId, left));
      const terminal = await inbox.transitionConversation({
        actor: ATTENDANT,
        conversationId: first.conversation.id,
        correlationId: `correlation-terminal-${runId}`,
        expectedVersion: first.conversation.version,
        idempotencyKey: `terminal-${runId}`,
        reason: 'Sem oportunidade comercial sintética',
        state: 'sem_lead',
      });
      assert.equal(terminal.state, 'sem_lead');

      const [second, third] = await Promise.all([
        inbox.receiveInbound(
          inboundInput(runId, left, {
            externalMessageId: `message-second-${runId}`,
          }),
        ),
        inbox.receiveInbound(
          inboundInput(runId, left, {
            externalMessageId: `message-third-${runId}`,
          }),
        ),
      ]);
      assert.equal(second.conversation.id, third.conversation.id);
      assert.notEqual(second.conversation.id, first.conversation.id);
      assert.equal(second.conversation.cycleNumber, 2);

      const cycles = await pool.query(
        `SELECT cycle_number, state
         FROM crm.conversations
         WHERE provider = 'meta' AND provider_account_id = $1
         ORDER BY cycle_number`,
        [`account-${runId}`],
      );
      assert.deepEqual(cycles.rows, [
        { cycle_number: 1, state: 'sem_lead' },
        { cycle_number: 2, state: 'nova' },
      ]);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL records neutral closure and opens the next cycle without changing the prior one', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await seedAttendant(pool);
      const { contacts, inbox } = servicesFor(pool);
      const identity = await contacts.resolveInboundIdentity(
        identityInput(runId),
      );
      const first = await inbox.receiveInbound(inboundInput(runId, identity));
      const owned = await inbox.takeover({
        actor: ATTENDANT,
        conversationId: first.conversation.id,
        correlationId: `correlation-takeover-${runId}`,
        expectedVersion: first.conversation.version,
        idempotencyKey: `takeover-${runId}`,
        reason: 'Atendimento sintético',
      });
      const closeCommand = {
        acknowledgePending: false,
        actor: ATTENDANT,
        conversationId: owned.id,
        correlationId: `correlation-close-${runId}`,
        expectedVersion: owned.version,
        idempotencyKey: `close-${runId}`,
        outcome: 'concluido',
        reason: 'Encerramento: concluido',
      };
      const closed = await inbox.closeConversation(closeCommand);
      assert.equal(closed.state, 'encerrada');
      assert.equal(closed.closedBy, ATTENDANT.id);
      assert.equal(closed.closureOutcome, 'concluido');
      assert.deepEqual(await inbox.closeConversation(closeCommand), closed);
      const next = await inbox.receiveInbound(
        inboundInput(runId, identity, {
          externalMessageId: `message-new-cycle-${runId}`,
          occurredAt: '2026-09-03T12:00:00.000Z',
        }),
      );
      assert.equal(next.conversation.cycleNumber, 2);
      assert.equal(next.conversation.previousConversationId, closed.id);
      const rows = await pool.query(
        'SELECT state, closure_outcome, closed_by FROM crm.conversations WHERE id=$1',
        [closed.id],
      );
      assert.deepEqual(rows.rows[0], {
        state: 'encerrada',
        closure_outcome: 'concluido',
        closed_by: ATTENDANT.id,
      });
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL keeps two active orders and a general topic distinct within one conversation', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await seedAttendant(pool);
      const { contacts, inbox } = servicesFor(pool);
      const identity = await contacts.resolveInboundIdentity(
        identityInput(runId),
      );
      const received = await inbox.receiveInbound(
        inboundInput(runId, identity),
      );
      const owned = await inbox.takeover({
        actor: ATTENDANT,
        conversationId: received.conversation.id,
        correlationId: `correlation-takeover-${runId}`,
        expectedVersion: received.conversation.version,
        idempotencyKey: `takeover-${runId}`,
        reason: 'Atendimento sintético',
      });
      const contactId = identity.contact.id;
      const insertOrder = async (
        /** @type {string} */ orderId,
        /** @type {string} */ key,
        /** @type {string} */ ownerContactId = contactId,
      ) => {
        await pool.query(
          `WITH numbered AS (SELECT nextval('crm.order_number_seq') AS sequence)
           INSERT INTO crm.orders
             (id, number_sequence, number, conversation_id, contact_id,
              manual_owner_id, manual_create_key, status, fab_code,
              ficha_envelope, created_by_kind, created_by, created_at, updated_at)
           SELECT $1, numbered.sequence,
                  lpad(numbered.sequence::text,2,'0') || '-CRM',
                  NULL, $2, $3, $4, 'pendente', '01', '{}'::jsonb,
                  'user', $3, now(), now()
           FROM numbered`,
          [orderId, ownerContactId, ATTENDANT.id, key],
        );
      };
      await insertOrder(`order-a-${runId}`, `manual-a-${runId}`);
      await insertOrder(`order-b-${runId}`, `manual-b-${runId}`);
      const unrelated = await contacts.resolveInboundIdentity(
        identityInput(`unrelated-${runId}`),
      );
      await insertOrder(
        `unrelated-order-${runId}`,
        `unrelated-manual-${runId}`,
        unrelated.contact.id,
      );
      const subjects = createSubjectService(databaseFor(pool));
      const command = (
        /** @type {string|null} */ orderId,
        /** @type {string} */ key,
      ) => ({
        actor: ATTENDANT,
        conversationId: owned.id,
        correlationId: `correlation-${key}`,
        idempotencyKey: key,
        orderId,
      });
      const first = await subjects.create(
        command(`order-a-${runId}`, `subject-a-${runId}`),
      );
      const second = await subjects.create(
        command(`order-b-${runId}`, `subject-b-${runId}`),
      );
      const general = await subjects.create(
        command(null, `subject-general-${runId}`),
      );
      assert.notEqual(first.subject.id, second.subject.id);
      assert.equal(general.subject.kind, 'geral');
      assert.deepEqual(
        await subjects.create(
          command(`order-a-${runId}`, `subject-a-${runId}`),
        ),
        first,
      );
      await assert.rejects(
        subjects.create(
          command(`order-a-${runId}`, `subject-duplicate-${runId}`),
        ),
        { code: 'SUBJECT_EXISTS' },
      );
      await assert.rejects(
        subjects.create(
          command(`unrelated-order-${runId}`, `subject-other-contact-${runId}`),
        ),
        { code: 'ORDER_CONTACT_MISMATCH' },
      );
      await assert.rejects(
        subjects.create({
          ...command(null, `subject-wrong-owner-${runId}`),
          actor: { ...ATTENDANT, id: 'other-seller' },
        }),
        { code: 'FORBIDDEN' },
      );
      const target = await subjects.select({
        actor: ATTENDANT,
        conversationId: owned.id,
        correlationId: `correlation-select-${runId}`,
        idempotencyKey: `select-${runId}`,
        subjectId: first.subject.id,
      });
      assert.equal(target.currentSubjectId, first.subject.id);
      // CP-31: "separar como novo assunto" creates a subject that does not
      // become the current one, so the agent keeps its target.
      const separated = await subjects.create({
        ...command(null, `subject-separated-${runId}`),
        select: false,
      });
      assert.equal(separated.subject.isCurrent, false);
      assert.equal(separated.subject.selectedSource, null);
      const afterSeparate = await subjects.list(owned.id);
      assert.equal(afterSeparate.currentSubjectId, first.subject.id);
      assert.deepEqual(
        afterSeparate.subjects
          .filter((/** @type {{isCurrent: boolean}} */ row) => row.isCurrent)
          .map((/** @type {{id: string}} */ row) => row.id),
        [first.subject.id],
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT is_current, selected_source, selected_by, selected_at
             FROM crm.conversation_subjects WHERE id = $1`,
            [separated.subject.id],
          )
        ).rows[0],
        {
          is_current: false,
          selected_source: null,
          selected_by: null,
          selected_at: null,
        },
      );
      await assert.rejects(
        subjects.create(command(null, `subject-separated-${runId}`)),
        { code: 'IDEMPOTENCY_KEY_REUSED' },
      );
      // CP-16: an open agent review asks the seller until a person decides.
      await pool.query(
        `INSERT INTO crm.message_subject_reviews
           (message_id, conversation_id, source_revision, reason, requested_at)
         VALUES ($1, $2, 1, 'subject_ambiguous', now())`,
        [received.message.id, owned.id],
      );
      assert.deepEqual((await subjects.list(owned.id)).needsSubjectMessageIds, [
        received.message.id,
      ]);
      const tagged = await subjects.tagMessage({
        actor: ATTENDANT,
        conversationId: owned.id,
        correlationId: `correlation-tag-${runId}`,
        idempotencyKey: `tag-${runId}`,
        messageId: received.message.id,
        subjectIds: [first.subject.id, general.subject.id],
      });
      assert.equal(tagged.subjectIds.length, 2);
      const read = await subjects.list(owned.id);
      assert.equal(read.subjects.length, 4);
      assert.equal(read.orders.length, 2);
      assert.equal(read.links.length, 2);
      assert.equal(read.currentSubjectId, first.subject.id);
      assert.deepEqual(read.needsSubjectMessageIds, []);
      assert.deepEqual(
        read.links.map(
          (/** @type {{assignedByKind: string}} */ link) => link.assignedByKind,
        ),
        ['human', 'human'],
      );
      const review = await pool.query(
        `SELECT resolved_by, resolved_at IS NOT NULL AS resolved
         FROM crm.message_subject_reviews WHERE message_id = $1`,
        [received.message.id],
      );
      assert.deepEqual(review.rows[0], {
        resolved_by: ATTENDANT.id,
        resolved: true,
      });
      await subjects.tagMessage({
        actor: ATTENDANT,
        conversationId: owned.id,
        correlationId: `correlation-retag-${runId}`,
        idempotencyKey: `retag-${runId}`,
        messageId: received.message.id,
        subjectIds: [second.subject.id],
      });
      const correction = await pool.query(
        `SELECT payload FROM crm.domain_events
         WHERE aggregate_type='conversation' AND aggregate_id=$1
           AND event_type='conversation.subjects_changed'
         ORDER BY aggregate_version DESC LIMIT 1`,
        [owned.id],
      );
      assert.deepEqual(
        correction.rows[0].payload.previousSubjectIds,
        [first.subject.id, general.subject.id].sort(),
      );
      assert.deepEqual(correction.rows[0].payload.subjectIds, [
        second.subject.id,
      ]);
      assert.deepEqual(
        correction.rows[0].payload.previousLinks,
        [first.subject.id, general.subject.id]
          .sort()
          .map((subjectId) => ({ subjectId, assignedByKind: 'human' })),
      );
      assert.equal(correction.rows[0].payload.reviewResolved, false);
      assert.deepEqual(
        (await subjects.list(owned.id)).links.map(
          (/** @type {{subjectId: string}} */ link) => link.subjectId,
        ),
        [second.subject.id],
      );
      const closeWithLinkedPending = {
        acknowledgePending: false,
        actor: ATTENDANT,
        conversationId: owned.id,
        correlationId: `correlation-close-subject-${runId}`,
        expectedVersion: owned.version,
        idempotencyKey: `close-subject-${runId}`,
        outcome: 'concluido',
        reason: 'Encerramento sintético',
      };
      await assert.rejects(
        inbox.closeConversation(closeWithLinkedPending),
        /Pending order requires acknowledgement/u,
      );
      await inbox.closeConversation({
        ...closeWithLinkedPending,
        acknowledgePending: true,
        idempotencyKey: `close-subject-acknowledged-${runId}`,
      });
      const resumed = await inbox.receiveInbound(
        inboundInput(runId, identity, {
          externalMessageId: `message-resumed-${runId}`,
          occurredAt: '2026-09-03T12:00:00.000Z',
        }),
      );
      const nextOwner = await inbox.takeover({
        actor: ATTENDANT,
        conversationId: resumed.conversation.id,
        correlationId: `correlation-resume-takeover-${runId}`,
        expectedVersion: resumed.conversation.version,
        idempotencyKey: `resume-takeover-${runId}`,
        reason: 'Retomada sintética',
      });
      const reused = await subjects.create({
        ...command(`order-a-${runId}`, `subject-resumed-${runId}`),
        conversationId: nextOwner.id,
      });
      assert.equal(reused.subject.orderId, `order-a-${runId}`);
      assert.notEqual(reused.subject.id, first.subject.id);
      await contacts.mergeIdentity({
        actor: ATTENDANT,
        correlationId: `correlation-subject-merge-${runId}`,
        expectedVersion: identity.identity.version,
        idempotencyKey: `subject-merge-${runId}`,
        identityId: identity.identity.id,
        reason: 'Correlação sintética verificada',
        targetContactId: unrelated.contact.id,
      });
      const afterCorrelation = await subjects.list(nextOwner.id);
      assert.equal(
        afterCorrelation.orders.some(
          (/** @type {{id: string}} */ order) =>
            order.id === `order-a-${runId}`,
        ),
        true,
      );
      assert.equal(
        (
          await subjects.select({
            actor: ATTENDANT,
            conversationId: nextOwner.id,
            correlationId: `correlation-reselect-${runId}`,
            idempotencyKey: `reselect-${runId}`,
            subjectId: reused.subject.id,
          })
        ).currentSubjectId,
        reused.subject.id,
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL atomically takes over, queues one human message and replays the persisted command', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await seedAttendant(pool);
      const { contacts, inbox } = servicesFor(pool);
      const identity = await contacts.resolveInboundIdentity(
        identityInput(runId),
      );
      const received = await inbox.receiveInbound(
        inboundInput(runId, identity),
      );
      const command = {
        actor: ATTENDANT,
        content: { text: `PII-human-${runId}` },
        conversationId: received.conversation.id,
        correlationId: `correlation-send-${runId}`,
        expectedVersion: received.conversation.version,
        idempotencyKey: `send-${runId}`,
        messageType: 'text',
        reason: 'Resposta humana sintética',
      };

      const [sent, replay] = await Promise.all([
        inbox.sendHumanMessage(command),
        inbox.sendHumanMessage(command),
      ]);
      assert.deepEqual(replay, sent);
      assert.equal(sent.status, 'queued');

      const state = await pool.query(
        `SELECT c.automation_state, c.automation_epoch, c.assigned_user_id,
                c.state, count(DISTINCT m.id)::integer AS messages,
                count(DISTINCT j.id)::integer AS jobs,
                min(j.effect_policy) AS effect_policy,
                count(DISTINCT a.id)::integer AS audits,
                string_agg(m.content_envelope::text, ' ') AS stored_content
         FROM crm.conversations c
         JOIN crm.messages m ON m.conversation_id = c.id
         LEFT JOIN crm.outbox_jobs j ON j.message_id = m.id
         LEFT JOIN crm.audit_events a
           ON a.target_id = c.id
          AND a.action = 'conversation.human_message_queued'
         WHERE c.id = $1
         GROUP BY c.id`,
        [received.conversation.id],
      );
      assert.deepEqual(
        {
          assigned_user_id: state.rows[0].assigned_user_id,
          audits: state.rows[0].audits,
          automation_epoch: Number(state.rows[0].automation_epoch),
          automation_state: state.rows[0].automation_state,
          effect_policy: state.rows[0].effect_policy,
          jobs: state.rows[0].jobs,
          messages: state.rows[0].messages,
          state: state.rows[0].state,
        },
        {
          assigned_user_id: ATTENDANT.id,
          audits: 1,
          automation_epoch: 1,
          automation_state: 'human',
          effect_policy: 'manual',
          jobs: 1,
          messages: 2,
          state: 'em_atendimento',
        },
      );
      assert.doesNotMatch(state.rows[0].stored_content, /PII-human/u);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL never hands a taken-over conversation back to the agent (ADR 015)', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await seedAttendant(pool);
      // The production outbox: takeover and close notify n8n through it.
      const outboundMessageOutbox = new PostgresN8nCommandOutbox({
        envelopeKey: Buffer.alloc(32, 44),
      });
      const { contacts, inbox } = servicesFor(pool, { outboundMessageOutbox });
      const identity = await contacts.resolveInboundIdentity(
        identityInput(runId),
      );
      const received = await inbox.receiveInbound(
        inboundInput(runId, identity),
      );
      const taken = await inbox.takeover({
        actor: ATTENDANT,
        conversationId: received.conversation.id,
        correlationId: `correlation-takeover-${runId}`,
        expectedVersion: received.conversation.version,
        idempotencyKey: `takeover-${runId}`,
        reason: 'Assumir atendimento sintético',
      });
      assert.equal(taken.automationState, 'human');
      assert.equal('reactivateAgent' in inbox, false);

      const repository = new PostgresInboxRepository({
        database: databaseFor(pool),
        envelopeKey: Buffer.alloc(32, 41),
        outboundMessageOutbox,
      });
      await assert.rejects(
        repository.mutateConversation(
          'reactivate',
          {
            actor: ATTENDANT,
            conversationId: taken.id,
            correlationId: `correlation-reactivate-${runId}`,
            expectedVersion: taken.version,
            idempotencyKey: `reactivate-${runId}`,
            reason: 'Devolver à IA',
          },
          {
            appendAudit: async () => assert.fail('no audit is written'),
            clock: () => NOW,
            idFactory: (/** @type {string} */ kind) => `${kind}-${runId}`,
          },
        ),
        InboxValidationError,
      );

      const state = await pool.query(
        `SELECT c.automation_state, c.automation_epoch, c.assigned_user_id,
                c.version,
                (SELECT count(*)::integer FROM crm.inbox_commands
                 WHERE operation = 'reactivate') AS reactivations,
                (SELECT count(*)::integer FROM crm.audit_events
                 WHERE action = 'conversation.assistant_reactivated')
                  AS reactivation_audits,
                (SELECT count(*)::integer FROM crm.domain_events
                 WHERE event_type = 'conversation.assistant_reactivated')
                  AS reactivation_events,
                (SELECT string_agg(action, ',' ORDER BY created_at)
                 FROM crm.n8n_commands
                 WHERE conversation_id = c.id) AS panel_commands
         FROM crm.conversations c
         WHERE c.id = $1`,
        [taken.id],
      );
      assert.deepEqual(
        {
          ...state.rows[0],
          automation_epoch: Number(state.rows[0].automation_epoch),
          version: Number(state.rows[0].version),
        },
        {
          assigned_user_id: ATTENDANT.id,
          automation_epoch: taken.automationEpoch,
          automation_state: 'human',
          panel_commands: 'take_over',
          reactivation_audits: 0,
          reactivation_events: 0,
          reactivations: 0,
          version: taken.version,
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL rolls back conversation, message, audit, command and job when outbox enqueue fails', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await seedAttendant(pool);
      const { contacts, inbox } = servicesFor(pool, {
        outboundMessageOutbox: {
          /** @param {any} _input @param {{transaction: any}} context */
          async enqueueChannelMessage(_input, { transaction }) {
            assert.equal(typeof transaction?.query, 'function');
            throw new Error('synthetic outbox failure');
          },
        },
      });
      const identity = await contacts.resolveInboundIdentity(
        identityInput(runId),
      );
      const received = await inbox.receiveInbound(
        inboundInput(runId, identity),
      );

      await assert.rejects(
        inbox.sendHumanMessage({
          actor: ATTENDANT,
          content: { text: `PII-human-rollback-${runId}` },
          conversationId: received.conversation.id,
          correlationId: `correlation-send-rollback-${runId}`,
          expectedVersion: received.conversation.version,
          idempotencyKey: `send-rollback-${runId}`,
          messageType: 'text',
          reason: 'Falha sintética de outbox',
        }),
        /synthetic outbox failure/u,
      );

      const state = await pool.query(
        `SELECT c.automation_state, c.automation_epoch, c.assigned_user_id,
                c.state, c.version,
                (SELECT count(*)::integer FROM crm.messages
                 WHERE conversation_id = c.id) AS messages,
                (SELECT count(*)::integer FROM crm.audit_events
                 WHERE target_id = c.id
                   AND action = 'conversation.human_message_queued') AS audits,
                (SELECT count(*)::integer FROM crm.inbox_commands
                 WHERE idempotency_key = $2) AS commands,
                (SELECT count(*)::integer FROM crm.outbox_jobs
                 WHERE idempotency_key = $2) AS jobs
         FROM crm.conversations c
         WHERE c.id = $1`,
        [received.conversation.id, `send-rollback-${runId}`],
      );
      assert.deepEqual(
        {
          ...state.rows[0],
          automation_epoch: Number(state.rows[0].automation_epoch),
          version: Number(state.rows[0].version),
        },
        {
          assigned_user_id: null,
          audits: 0,
          automation_epoch: 0,
          automation_state: 'assistant',
          commands: 0,
          jobs: 0,
          messages: 1,
          state: 'nova',
          version: received.conversation.version,
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL persists reversible identity links and one audit per idempotent command', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const { contacts } = servicesFor(pool);
      const source = await contacts.resolveInboundIdentity(
        identityInput(runId),
      );
      const target = await contacts.resolveInboundIdentity(
        identityInput(`target${runId}`, `target-account-${runId}`),
      );
      const mergeCommand = {
        actor: ATTENDANT,
        correlationId: `correlation-merge-${runId}`,
        expectedVersion: source.identity.version,
        idempotencyKey: `merge-${runId}`,
        identityId: source.identity.id,
        reason: 'Vínculo sintético confirmado por operador',
        targetContactId: target.contact.id,
      };
      const [merged, mergeReplay] = await Promise.all([
        contacts.mergeIdentity(mergeCommand),
        contacts.mergeIdentity(mergeCommand),
      ]);
      assert.deepEqual(mergeReplay, merged);
      assert.equal(merged.identity.contactId, target.contact.id);

      const unmergeCommand = {
        actor: ATTENDANT,
        correlationId: `correlation-unmerge-${runId}`,
        expectedVersion: merged.identity.version,
        idempotencyKey: `unmerge-${runId}`,
        linkId: merged.link.id,
        reason: 'Vínculo sintético revertido por operador',
      };
      const [unmerged, unmergeReplay] = await Promise.all([
        contacts.unmergeIdentity(unmergeCommand),
        contacts.unmergeIdentity(unmergeCommand),
      ]);
      assert.deepEqual(unmergeReplay, unmerged);
      assert.equal(unmerged.identity.contactId, source.contact.id);
      assert.equal(unmerged.link.status, 'reverted');

      const evidence = await pool.query(
        `SELECT l.status, l.source_contact_id, l.target_contact_id,
                count(DISTINCT a.id)::integer AS audits
         FROM crm.identity_links l
         LEFT JOIN crm.audit_events a ON a.target_id = l.contact_identity_id
         WHERE l.id = $1
         GROUP BY l.id`,
        [merged.link.id],
      );
      assert.deepEqual(evidence.rows[0], {
        audits: 2,
        source_contact_id: source.contact.id,
        status: 'reverted',
        target_contact_id: target.contact.id,
      });
      await assert.rejects(
        pool.query(
          `UPDATE crm.identity_links
           SET merge_reason = 'tentativa de alteração histórica'
           WHERE id = $1`,
          [merged.link.id],
        ),
        /immutable/u,
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL links webhook media to the inbox message once across replay', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(databaseName, 'crm_silmer_test');
    const pool = new Pool({ connectionString, max: 16 });
    const runId = randomUUID().replaceAll('-', '');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const database = databaseFor(pool);
      const eventStore = new PostgresWebhookInbox({
        database,
        envelopeKey: Buffer.alloc(32, 31),
      });
      const event = /** @type {any} */ (canonicalWebhookEvent(runId));
      const externalMediaId = `media-${runId}`;
      event.message = {
        content: {
          attachmentId: externalMediaId,
          caption: `PII-caption-${runId}`,
        },
        type: 'image',
      };
      const media = /** @type {any[]} */ ([
        {
          declaredMimeType: 'image/png',
          externalMediaId,
          mediaType: 'image',
          providerSha256: null,
        },
      ]);
      await eventStore.persistBatch({
        correlationId: `correlation-chain-${runId}`,
        events: [{ disposition: 'process', event, media }],
        rawBody: Buffer.from(`{"synthetic":"${runId}"}`),
        receivedAt: NOW.toISOString(),
      });
      const selectedJob = await pool.query(
        `SELECT channel_event_id FROM crm.outbox_jobs
         WHERE job_type = 'channel_event.process'`,
      );
      const { contacts, inbox } = servicesFor(pool);
      const processEvent = createChannelEventJobHandler({
        channelEventHandler: createChannelEventHandler({
          contactIdentityService: contacts,
          inboxService: inbox,
        }),
        eventStore,
      });

      assert.deepEqual(
        await processEvent({
          channelEventId: selectedJob.rows[0].channel_event_id,
        }),
        { outcome: 'sent' },
      );
      assert.deepEqual(
        await processEvent({
          channelEventId: selectedJob.rows[0].channel_event_id,
        }),
        { outcome: 'sent' },
      );
      const state = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM crm.contacts) AS contacts,
           (SELECT count(*)::integer FROM crm.conversations) AS conversations,
           (SELECT count(*)::integer FROM crm.messages) AS messages,
           (SELECT count(*)::integer FROM crm.attachments) AS attachments,
           (SELECT channel_event_id FROM crm.messages LIMIT 1) AS linked_event,
           (SELECT content_envelope::text FROM crm.messages LIMIT 1) AS stored_content`,
      );
      assert.deepEqual(
        {
          attachments: state.rows[0].attachments,
          contacts: state.rows[0].contacts,
          conversations: state.rows[0].conversations,
          linked_event: state.rows[0].linked_event,
          messages: state.rows[0].messages,
        },
        {
          attachments: 1,
          contacts: 1,
          conversations: 1,
          linked_event: selectedJob.rows[0].channel_event_id,
          messages: 1,
        },
      );
      assert.doesNotMatch(state.rows[0].stored_content, /PII-chain/u);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
}
