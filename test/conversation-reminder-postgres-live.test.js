import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import { createApi } from '../apps/api/src/app.js';
import { createConversationReminderRuntime } from '../apps/api/src/conversation-reminder-runtime.js';
import { createDashboardRuntime } from '../apps/api/src/dashboard-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import {
  createContactIdentityService,
  PostgresContactIdentityRepository,
} from '../modules/contacts/src/index.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  createInboxService,
  PostgresInboxRepository,
} from '../modules/inbox-channels/src/index.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const CONTACT_KEY = Buffer.alloc(32, 131);
const MESSAGE_KEY = Buffer.alloc(32, 132);
const ORDER_KEY = Buffer.alloc(32, 133);
const IDEMPOTENCY_KEY = Buffer.alloc(32, 134);
/** São Paulo wall clock (UTC-03:00). Thursday 05/11/2026 15:00. */
const NOW = new Date('2026-11-05T15:00:00-03:00');
const DAY = 86_400_000;
const EVENT = 'conversation.reminder_set';

test(
  'INBOX-VEZ-01 PostgreSQL: personal conversation reminder, Central compatibility, idempotency and SSE event',
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

    const clock = NOW;
    const runId = randomUUID().slice(0, 8);
    /** @param {string} label @param {string} functionName */
    async function user(label, functionName) {
      const actor = {
        id: `${label}-rem-${runId}`,
        kind: 'human',
        functionName,
        capabilities: /** @type {string[]} */ ([]),
      };
      await pool.query(
        `INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic',$3)`,
        [actor.id, `${actor.id}@example.test`, `Pessoa ${label}`],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [actor.id, functionName],
      );
      return actor;
    }
    const seller = await user('seller', 'Vendedor');
    const other = await user('other', 'Vendedor');
    const financial = await user('finance', 'Financeiro');

    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => clock,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 135),
      }),
    });
    const inbox = createInboxService({
      auditPort,
      clock: () => clock,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: MESSAGE_KEY,
        outboundMessageOutbox: { enqueueChannelMessage: async () => undefined },
      }),
    });

    let sequence = 0;
    /** @param {{owner:string|null,automation?:string,state?:string,archived?:boolean}} options */
    async function conversation(options) {
      const label = `c${(sequence += 1)}`;
      const at = new Date(NOW.getTime() - 3_600_000 + sequence * 1000);
      const identity = await contacts.resolveInboundIdentity({
        channel: 'instagram',
        correlationId: `contact-${runId}-${label}`,
        displayHandle: `@synthetic_${label}`,
        externalIdentityId: `identity-${runId}-${label}`,
        identityKind: 'handle',
        occurredAt: at.toISOString(),
        phoneStatus: 'pending',
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const opened = await inbox.receiveInbound({
        contactId: identity.contact.id,
        correlationId: `inbound-${runId}-${label}`,
        externalConversationId: `external-${runId}-${label}`,
        externalMessageId: `inbound-${runId}-${label}`,
        identityId: identity.identity.id,
        message: { content: { text: 'Mensagem sintética' }, type: 'text' },
        occurredAt: at.toISOString(),
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const id = /** @type {string} */ (opened.conversation.id);
      await pool.query(
        `UPDATE crm.conversations SET automation_state=$2,assigned_user_id=$3,
           state=$4,version=version+1,
           closure_outcome=CASE WHEN $4='encerrada' THEN 'concluido' END,
           closed_by=CASE WHEN $4='encerrada' THEN $3 END,
           archived_at=CASE WHEN $5::boolean THEN $7::timestamptz END,
           terminal_at=CASE WHEN $6::boolean OR $4 IN ('encerrada','sem_lead') THEN $7::timestamptz END
         WHERE id=$1`,
        [
          id,
          options.automation ?? 'human',
          options.owner,
          options.state ?? 'em_atendimento',
          options.archived === true,
          false,
          NOW.toISOString(),
        ],
      );
      return id;
    }
    /** @param {string} id */
    const conversationVersion = async (id) =>
      Number(
        (
          await pool.query(
            'SELECT version FROM crm.conversations WHERE id=$1',
            [id],
          )
        ).rows[0].version,
      );
    /** @param {string} userId @param {string} id */
    const decisionRow = async (userId, id) =>
      (
        await pool.query(
          'SELECT * FROM crm.dashboard_action_decisions WHERE user_id=$1 AND action_id=$2',
          [userId, `conversation:${id}`],
        )
      ).rows[0];
    /** @param {string} id @param {string} [type] */
    const eventCount = async (id, type = EVENT) =>
      Number(
        (
          await pool.query(
            `SELECT count(*) AS n FROM crm.domain_events
             WHERE aggregate_type='conversation' AND aggregate_id=$1 AND event_type=$2`,
            [id, type],
          )
        ).rows[0].n,
      );
    const inDays = (/** @type {number} */ days) =>
      new Date(NOW.getTime() + days * DAY).toISOString();

    const reminders = createConversationReminderRuntime(database, {
      access: {},
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => clock,
    });
    const dashboard = createDashboardRuntime(database, {
      access: {},
      orderEnvelopeKey: ORDER_KEY,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => clock,
    });
    /** @param {any} actor @param {string} id @param {Record<string,unknown>} body @param {string} [key] */
    const set = (actor, id, body, key = randomUUID()) =>
      reminders.set({
        actor,
        conversationId: id,
        body,
        idempotencyKey: `rem-${key}`,
        correlationId: `correlation-${runId}`,
      });
    /** @param {string} id @param {string} [remindAt] */
    const body = async (id, remindAt = inDays(3)) => ({
      remindAt,
      expectedVersion: await conversationVersion(id),
    });

    // The owner, another seller and an unowned conversation all succeed.
    const owned = await conversation({ owner: seller.id });
    const ownedBody = await body(owned);
    const first = await set(seller, owned, ownedBody, 'owned');
    assert.deepEqual(first, {
      conversationId: owned,
      remindAt: ownedBody.remindAt,
      decisionVersion: 1,
    });
    assert.equal(await eventCount(owned), 1);

    // The saved row is valid for the Central: same target version and the
    // exact source revision it computes, and the item turns into a reminder.
    const saved = await decisionRow(seller.id, owned);
    assert.equal(saved.decision, 'schedule');
    assert.equal(saved.target_type, 'conversation');
    assert.equal(saved.target_id, owned);
    assert.equal(
      Number(saved.target_version),
      await conversationVersion(owned),
    );
    const central = (
      await pool.query(
        `SELECT d.target_version = c.version AS version_matches,
                d.source_revision = 'message:' || coalesce(last_message.message_id,'none') || ':' ||
                  coalesce(last_message.last_status,'none') || ':' ||
                  coalesce(last_message.last_delivery_status,'none') AS source_matches
         FROM crm.conversations c
         LEFT JOIN LATERAL (
           SELECT m.id AS message_id, m.status AS last_status, m.delivery_status AS last_delivery_status
           FROM crm.messages m WHERE m.conversation_id = c.id
           ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1) last_message ON true
         JOIN crm.dashboard_action_decisions d ON d.user_id=$2 AND d.action_id='conversation:' || c.id
         WHERE c.id=$1`,
        [owned, seller.id],
      )
    ).rows[0];
    assert.deepEqual(central, { version_matches: true, source_matches: true });
    const item = (await dashboard.actions({ actor: seller })).items.find(
      (/** @type {any} */ candidate) => candidate.conversationId === owned,
    );
    assert.equal(item.kind, 'reminder');
    assert.equal(item.remindAt, ownedBody.remindAt);
    assert.equal(item.deferred, true);
    assert.equal(item.decisionVersion, 1);

    // Another seller, without being the owner, decides only for itself and
    // the owner's own row is left untouched.
    const ownerRowBefore = await decisionRow(seller.id, owned);
    const bySomeoneElse = await set(other, owned, await body(owned, inDays(5)));
    assert.equal(bySomeoneElse.decisionVersion, 1);
    assert.equal(bySomeoneElse.remindAt, inDays(5));
    assert.deepEqual(await decisionRow(seller.id, owned), ownerRowBefore);
    assert.equal((await decisionRow(other.id, owned)).user_id, other.id);
    assert.equal(await eventCount(owned), 2);

    // A seller's own earlier row is replaced (version grows); the other's row
    // seeded for the same action is not touched.
    const shared = await conversation({ owner: other.id });
    await pool.query(
      `INSERT INTO crm.dashboard_action_decisions
         (user_id,action_id,target_type,target_id,target_version,source_revision,decision,remind_at,version,created_at,updated_at)
       VALUES ($1,$2,'conversation',$3,1,'message:x:sent:none','snooze',$4,3,$5,$5)`,
      [
        other.id,
        `conversation:${shared}`,
        shared,
        inDays(2),
        NOW.toISOString(),
      ],
    );
    const otherBefore = await decisionRow(other.id, shared);
    await set(seller, shared, await body(shared, inDays(4)));
    assert.deepEqual(await decisionRow(other.id, shared), otherBefore);
    const again = await set(seller, shared, await body(shared, inDays(6)));
    assert.equal(again.decisionVersion, 2);

    // No owner and a conversation handled by the agent also accept it.
    const unowned = await conversation({ owner: null, automation: 'human' });
    assert.equal(
      (await set(seller, unowned, await body(unowned))).decisionVersion,
      1,
    );
    const withAgent = await conversation({
      owner: null,
      automation: 'assistant',
    });
    assert.equal(
      (await set(seller, withAgent, await body(withAgent))).decisionVersion,
      1,
    );
    assert.equal(await eventCount(withAgent), 1);

    // Idempotency: same key and body replays the answer without a second
    // decision, audit or event; another body with the key is a conflict.
    const replayId = await conversation({ owner: seller.id });
    const replayBody = await body(replayId, inDays(7));
    const one = await set(seller, replayId, replayBody, 'replay');
    const two = await set(seller, replayId, replayBody, 'replay');
    assert.deepEqual(two, one);
    assert.equal(await eventCount(replayId), 1);
    assert.equal((await decisionRow(seller.id, replayId)).version, '1');
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) AS n FROM crm.audit_events WHERE target_id=$1 AND action='conversation.reminder.set'`,
            [replayId],
          )
        ).rows[0].n,
      ),
      1,
    );
    await assert.rejects(
      set(seller, replayId, { ...replayBody, remindAt: inDays(8) }, 'replay'),
      { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    assert.equal(await eventCount(replayId), 1);

    // Version and availability.
    const fresh = await conversation({ owner: seller.id });
    await assert.rejects(
      set(seller, fresh, {
        remindAt: inDays(3),
        expectedVersion: (await conversationVersion(fresh)) - 1,
      }),
      { statusCode: 409, code: 'VERSION_CONFLICT' },
    );
    const closed = await conversation({ owner: seller.id, state: 'encerrada' });
    await assert.rejects(set(seller, closed, await body(closed)), {
      statusCode: 409,
      code: 'ACTION_NOT_AVAILABLE',
    });
    const archived = await conversation({ owner: seller.id, archived: true });
    await assert.rejects(set(seller, archived, await body(archived)), {
      statusCode: 409,
      code: 'ACTION_NOT_AVAILABLE',
    });
    const terminal = await conversation({
      owner: seller.id,
      state: 'sem_lead',
    });
    await assert.rejects(set(seller, terminal, await body(terminal)), {
      statusCode: 409,
      code: 'ACTION_NOT_AVAILABLE',
    });
    await assert.rejects(
      set(seller, 'conversation-missing', {
        remindAt: inDays(3),
        expectedVersion: 1,
      }),
      { statusCode: 404, code: 'CONVERSATION_NOT_FOUND' },
    );
    for (const id of [fresh, closed, archived, terminal]) {
      assert.equal(await decisionRow(seller.id, id), undefined);
      assert.equal(await eventCount(id), 0);
    }

    // Dates: past, no offset and beyond 90 days.
    for (const remindAt of [
      new Date(NOW.getTime() - 60_000).toISOString(),
      NOW.toISOString(),
      '2026-11-10T10:00:00',
      inDays(90.01),
    ])
      await assert.rejects(set(seller, fresh, await body(fresh, remindAt)), {
        statusCode: 422,
        code: 'INVALID_REMINDER_DATE',
      });
    assert.equal(await eventCount(fresh), 0);
    assert.equal(
      (await set(seller, fresh, await body(fresh, inDays(90)))).decisionVersion,
      1,
    );
    assert.equal(await eventCount(fresh), 1);

    // Strict body, invalid key and role.
    for (const extra of [{ note: 'livre' }, { userId: other.id }])
      await assert.rejects(
        set(seller, owned, { ...(await body(owned)), ...extra }),
        { statusCode: 400, code: 'INVALID_REQUEST' },
      );
    await assert.rejects(
      reminders.set({
        actor: seller,
        conversationId: owned,
        body: await body(owned),
        idempotencyKey: '',
        correlationId: 'c',
      }),
      { statusCode: 400, code: 'INVALID_IDEMPOTENCY_KEY' },
    );
    await assert.rejects(set(financial, owned, await body(owned)), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(
      set({ ...seller, id: 'ghost-user' }, owned, await body(owned)),
      { code: 'FORBIDDEN' },
    );

    // HTTP: CSRF and key are required; the audit holds symbols only.
    /** @type {string[]} */
    const logs = [];
    const access = {
      authorizeWrite: async (/** @type {any} */ input) => {
        authorize(/** @type {any} */ (seller), input.action);
        if (input.csrfToken !== 'synthetic-csrf')
          throw Object.assign(new Error('forbidden'), {
            statusCode: 403,
            code: 'CSRF_INVALID',
          });
        return { actor: seller };
      },
    };
    const http = createConversationReminderRuntime(database, {
      access,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => clock,
    });
    const api = createApi(
      {},
      {
        conversationReminders: http,
        logger: createSafeLogger({
          service: 'crm-silmer-api',
          sink: (/** @type {any} */ line) => logs.push(JSON.stringify(line)),
        }),
      },
    );
    t.after(() => api.close());
    const viaHttp = await conversation({ owner: seller.id });
    const payload = await body(viaHttp, inDays(2));
    const headers = {
      cookie: 'crm_session=synthetic',
      origin: 'https://crm.example.test',
      'x-csrf-token': 'synthetic-csrf',
      'idempotency-key': `http-${runId}`,
    };
    const url = `/api/v1/conversations/${viaHttp}/reminder`;
    const noCsrf = await api.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'x-csrf-token': '' },
      payload,
    });
    assert.equal(noCsrf.statusCode, 403);
    const noKey = await api.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'idempotency-key': '' },
      payload,
    });
    assert.equal(noKey.statusCode, 400);
    assert.equal(await eventCount(viaHttp), 0);
    const posted = await api.inject({ method: 'POST', url, headers, payload });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.headers['cache-control'], 'private, no-store');
    assert.deepEqual(posted.json(), {
      conversationId: viaHttp,
      remindAt: payload.remindAt,
      decisionVersion: 1,
    });
    const replayed = await api.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    assert.equal(replayed.statusCode, 200);
    assert.deepEqual(replayed.json(), posted.json());
    assert.equal(await eventCount(viaHttp), 1);
    const audit = (
      await pool.query(
        `SELECT action,reason,version,target_type FROM crm.audit_events WHERE target_id=$1`,
        [viaHttp],
      )
    ).rows;
    assert.deepEqual(audit, [
      {
        action: 'conversation.reminder.set',
        reason: 'INBOX_REMINDER_SET',
        version: '1',
        target_type: 'conversation',
      },
    ]);
    assert.ok(logs.length > 0);
  },
);
