import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import { createApi } from '../apps/api/src/app.js';
import { createDashboardMetricsRuntime } from '../apps/api/src/dashboard-metrics-runtime.js';
import { createDashboardRuntime } from '../apps/api/src/dashboard-runtime.js';
import { createLeadOutcomeRuntime } from '../apps/api/src/lead-outcome-runtime.js';
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
import { encryptJson } from '../modules/n8n-integration/src/crypto.js';
import { encryptJson as encryptOrder } from '../modules/orders/src/adapters/envelope.js';
import { formatOrderNumber } from '../modules/orders/src/domain/order.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const CONTACT_KEY = Buffer.alloc(32, 121);
const MESSAGE_KEY = Buffer.alloc(32, 122);
const ORDER_KEY = Buffer.alloc(32, 123);
const IDEMPOTENCY_KEY = Buffer.alloc(32, 124);
const NOTE_KEY = Buffer.alloc(32, 125);
/** São Paulo wall clock (UTC-03:00). Thursday 05/11/2026 15:00. */
const NOW = new Date('2026-11-05T15:00:00-03:00');
const NOTE = 'Cliente preferiu bordado da concorrência sintética';
const HTTP_NOTE = 'Orçamento sintético ficou para o ano que vem';

test(
  'MET-06–08 PostgreSQL: declared lead loss, derived reopening, privacy, losses and the action queue',
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

    let clock = NOW;
    /** Advances the clock one minute and returns it: every step is ordered. */
    const tick = () => {
      clock = new Date(clock.getTime() + 60_000);
      return clock.toISOString();
    };
    const runId = randomUUID().slice(0, 8);
    /** @param {string} label @param {string} functionName @param {boolean} [admin] */
    async function user(label, functionName, admin = false) {
      const actor = {
        id: `${label}-lead-${runId}`,
        kind: 'human',
        functionName,
        capabilities: admin ? ['COMMERCIAL_ADMIN'] : [],
      };
      await pool.query(
        `INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic',$3)`,
        [actor.id, `${actor.id}@example.test`, `Pessoa ${label}`],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [actor.id, functionName],
      );
      if (admin)
        await pool.query(
          `INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')`,
          [actor.id],
        );
      return actor;
    }
    const seller = await user('seller', 'Vendedor');
    const other = await user('other', 'Vendedor');
    const admin = await user('admin', 'Vendedor', true);
    const financial = await user('finance', 'Financeiro');

    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => clock,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 126),
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
    /** @type {Map<string, any>} */
    const inbound = new Map();
    /** A human-mode cycle opened by a customer message.
     * @param {string|null} owner @param {string} [at] */
    async function conversation(owner, at = tick()) {
      const label = `c${(sequence += 1)}`;
      const identity = await contacts.resolveInboundIdentity({
        channel: 'instagram',
        correlationId: `contact-${runId}-${label}`,
        displayHandle: `@synthetic_${label}`,
        externalIdentityId: `identity-${runId}-${label}`,
        identityKind: 'handle',
        occurredAt: at,
        phoneStatus: 'pending',
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const input = {
        contactId: identity.contact.id,
        correlationId: `inbound-${runId}-${label}`,
        externalConversationId: `external-${runId}-${label}`,
        externalMessageId: `inbound-${runId}-${label}`,
        identityId: identity.identity.id,
        message: { content: { text: 'Mensagem sintética' }, type: 'text' },
        occurredAt: at,
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      };
      const opened = await inbox.receiveInbound(input);
      const id = /** @type {string} */ (opened.conversation.id);
      inbound.set(id, input);
      await pool.query(
        `UPDATE crm.conversations SET automation_state='human',assigned_user_id=$2,
           state='em_atendimento',version=version+1 WHERE id=$1`,
        [id, owner],
      );
      return id;
    }
    /** A new customer message through the real inbound path (bumps the version).
     * @param {string} id @param {string} [at] */
    const customer = async (id, at = tick()) =>
      inbox.receiveInbound({
        ...inbound.get(id),
        externalMessageId: `inbound-${runId}-${(sequence += 1)}`,
        occurredAt: at,
      });
    /** A human send; `sent` is effective, `failed` is not.
     * @param {string} id @param {string} author @param {{at?:string,status?:string}} [options] */
    async function human(id, author, options = {}) {
      const at = options.at ?? tick();
      const status = options.status ?? 'sent';
      const messageId = `message-${runId}-${(sequence += 1)}`;
      await pool.query(
        `INSERT INTO crm.messages
           (id,conversation_id,provider,provider_account_id,external_message_id,
            command_id,direction,author_kind,author_id,message_type,
            content_envelope,key_version,status,delivery_status,delivery_status_at,sent_at,occurred_at,created_at)
         SELECT $1,id,provider,provider_account_id,NULL,$1,'outbound','human',$3,'text',$4::jsonb,
                1,$5,$6,CASE WHEN $6::text IS NULL THEN NULL ELSE $7::timestamptz END,
                CASE WHEN $5='sent' THEN $7::timestamptz END,$7,$7
         FROM crm.conversations WHERE id=$2`,
        [
          messageId,
          id,
          author,
          JSON.stringify(
            encryptJson(
              { text: 'Resposta sintética' },
              `message:${messageId}`,
              MESSAGE_KEY,
            ),
          ),
          status,
          status === 'sent' ? 'sent' : null,
          at,
        ],
      );
      await pool.query(
        `UPDATE crm.conversations SET version=version+1,last_message_at=greatest(last_message_at,$2) WHERE id=$1`,
        [id, at],
      );
      return messageId;
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
    /** @param {string} id */
    const outcomeVersion = async (id) =>
      Number(
        (
          await pool.query(
            'SELECT coalesce(max(version),0) AS v FROM crm.lead_outcome_events WHERE conversation_id=$1',
            [id],
          )
        ).rows[0].v,
      );
    /** @param {string} id @param {boolean} confirmed */
    async function order(id, confirmed) {
      const orderId = `order-lead-${randomUUID()}`;
      const seq = Number(
        (await pool.query(`SELECT nextval('crm.order_number_seq') AS n`))
          .rows[0].n,
      );
      await pool.query(
        `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,
           status,fab_code,ficha_envelope,total_pieces,missing_fields,final_amount_cents,payment_condition,
           order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at,origin,is_test)
         SELECT $1,$2,$3,c.id,identity.current_contact_id,$4,'01',$5::jsonb,20,'{}',$6,$7,$8,$9,$10,
                'user',$11,$12,$12,'atendimento',false
         FROM crm.conversations c JOIN crm.contact_identities identity ON identity.id=c.contact_identity_id
         WHERE c.id=$13`,
        [
          orderId,
          seq,
          formatOrderNumber(seq),
          confirmed ? 'confirmado' : 'pendente',
          JSON.stringify(
            encryptOrder(
              {
                summary: { cliente: 'Contato Sintético' },
                items: [],
                artwork: {},
              },
              `order-ficha:${orderId}`,
              ORDER_KEY,
            ),
          ),
          confirmed ? 100000 : null,
          confirmed ? 'pix' : null,
          confirmed ? '2026-11-05' : null,
          confirmed ? clock : null,
          confirmed ? admin.id : null,
          seller.id,
          clock,
          id,
        ],
      );
    }

    const access = {
      authorizeRead: async () => ({ actor: seller }),
      authorizeWrite: async () => ({ actor: seller }),
    };
    const leads = createLeadOutcomeRuntime(database, {
      access,
      noteEnvelopeKey: NOTE_KEY,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => clock,
    });
    const dashboard = createDashboardRuntime(database, {
      access: {},
      orderEnvelopeKey: ORDER_KEY,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => clock,
    });
    const metrics = createDashboardMetricsRuntime(database, {
      access: {},
      clock: () => clock,
    });
    /** @param {any} actor @param {string} id @param {Record<string,unknown>} body @param {string} [key] */
    const record = (actor, id, body, key = randomUUID()) =>
      leads.record({
        actor,
        conversationId: id,
        body,
        idempotencyKey: `lead-${key}`,
        correlationId: `correlation-${runId}`,
      });
    /** @param {any} actor @param {string} id @param {string} [reasonCode] @param {Record<string,unknown>} [extra] */
    const lose = async (actor, id, reasonCode = 'preco', extra = {}) =>
      record(actor, id, {
        outcome: 'lost',
        reasonCode,
        expectedConversationVersion: await conversationVersion(id),
        expectedOutcomeVersion: await outcomeVersion(id),
        ...extra,
      });
    /** @param {any} actor @param {string} id */
    const reopen = async (actor, id) =>
      record(actor, id, {
        outcome: 'reopened',
        expectedConversationVersion: await conversationVersion(id),
        expectedOutcomeVersion: await outcomeVersion(id),
      });
    /** @param {any} actor @param {string} id */
    const actionKinds = async (actor, id) =>
      (await dashboard.actions({ actor })).items
        .filter((/** @type {any} */ item) => item.conversationId === id)
        .map((/** @type {any} */ item) => item.kind);

    // The owner declares the loss; the conversation, its closure and version stay.
    const owned = await conversation(seller.id);
    await human(owned, seller.id);
    const before = (
      await pool.query(
        'SELECT state,closure_outcome,terminal_at,version,assigned_user_id FROM crm.conversations WHERE id=$1',
        [owned],
      )
    ).rows[0];
    const first = await lose(seller, owned, 'preco');
    assert.deepEqual(first, {
      conversationId: owned,
      outcome: 'lost',
      outcomeVersion: 1,
      reasonCode: 'preco',
      hasNote: false,
      ownerId: seller.id,
      markedBy: seller.id,
      markedAt: clock.toISOString(),
    });
    assert.deepEqual(
      (
        await pool.query(
          'SELECT state,closure_outcome,terminal_at,version,assigned_user_id FROM crm.conversations WHERE id=$1',
          [owned],
        )
      ).rows[0],
      before,
    );
    const detail = await leads.detail({ actor: seller, conversationId: owned });
    assert.equal(detail.state, 'lost');
    assert.equal(detail.reasonCode, 'preco');
    assert.equal(Object.hasOwn(detail, 'note'), false);
    await assert.rejects(
      lose(seller, owned, 'prazo', { expectedOutcomeVersion: 1 }),
      {
        code: 'LEAD_ALREADY_LOST',
      },
    );
    const audit = (
      await pool.query(
        `SELECT actor_id,version,reason FROM crm.audit_events WHERE action='lead.outcome.recorded' AND target_id=$1`,
        [owned],
      )
    ).rows;
    assert.deepEqual(audit, [
      { actor_id: seller.id, version: '1', reason: 'LEAD_LOST_PRECO' },
    ]);

    // The administrator marks for the seller: owner stays the seller, the actor is the admin.
    const forSeller = await conversation(seller.id);
    await human(forSeller, seller.id);
    const replayBody = {
      outcome: 'lost',
      reasonCode: 'outro',
      note: `  ${NOTE} `,
      expectedConversationVersion: await conversationVersion(forSeller),
      expectedOutcomeVersion: 0,
    };
    const adminMark = await record(
      admin,
      forSeller,
      replayBody,
      `replay-${runId}`,
    );
    assert.equal(adminMark.ownerId, seller.id);
    assert.equal(adminMark.markedBy, admin.id);
    assert.equal(adminMark.hasNote, true);
    assert.equal(JSON.stringify(adminMark).includes(NOTE), false);
    // Same key, same command: same answer and no second event.
    assert.deepEqual(
      await record(admin, forSeller, replayBody, `replay-${runId}`),
      adminMark,
    );
    assert.equal(await outcomeVersion(forSeller), 1);
    await assert.rejects(
      record(
        admin,
        forSeller,
        {
          outcome: 'lost',
          reasonCode: 'prazo',
          expectedConversationVersion: replayBody.expectedConversationVersion,
          expectedOutcomeVersion: 0,
        },
        `replay-${runId}`,
      ),
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    await assert.rejects(
      record(
        admin,
        forSeller,
        { ...replayBody, note: 'Outro texto sintético' },
        `replay-${runId}`,
      ),
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    for (const reader of [seller, admin]) {
      const read = await leads.detail({
        actor: reader,
        conversationId: forSeller,
      });
      assert.equal(read.note, NOTE);
      assert.equal(read.ownerId, seller.id);
      assert.equal(read.markedBy, admin.id);
    }
    await assert.rejects(
      leads.detail({ actor: other, conversationId: forSeller }),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(
      leads.detail({ actor: financial, conversationId: forSeller }),
      { code: 'FORBIDDEN' },
    );

    // Another seller and Financeiro are refused. A seller cannot tell a
    // missing conversation from someone else's (403); only an admin gets 404.
    const foreign = await conversation(seller.id);
    await human(foreign, seller.id);
    await assert.rejects(lose(other, foreign), { code: 'FORBIDDEN' });
    await assert.rejects(lose(financial, foreign), { code: 'FORBIDDEN' });
    const missingBody = {
      outcome: 'lost',
      reasonCode: 'preco',
      expectedConversationVersion: 1,
      expectedOutcomeVersion: 0,
    };
    await assert.rejects(record(seller, `missing-${runId}`, missingBody), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(
      leads.detail({ actor: seller, conversationId: `missing-${runId}` }),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(record(admin, `missing-${runId}`, missingBody), {
      code: 'CONVERSATION_NOT_FOUND',
    });
    await assert.rejects(
      leads.detail({ actor: admin, conversationId: `missing-${runId}` }),
      { code: 'CONVERSATION_NOT_FOUND' },
    );

    // Not eligible: no owner, bot, closed.
    const unowned = await conversation(null);
    await assert.rejects(lose(admin, unowned), { code: 'LEAD_NOT_ELIGIBLE' });
    const bot = await conversation(seller.id);
    await human(bot, seller.id);
    await pool.query(
      `UPDATE crm.conversations SET automation_state='assistant' WHERE id=$1`,
      [bot],
    );
    await assert.rejects(lose(seller, bot), { code: 'LEAD_NOT_ELIGIBLE' });
    const closed = await conversation(seller.id);
    await human(closed, seller.id);
    await pool.query(
      `UPDATE crm.conversations SET state='encerrada',terminal_at=$2,closure_outcome='sem_pedido',closed_by=$3 WHERE id=$1`,
      [closed, clock, seller.id],
    );
    await assert.rejects(lose(seller, closed), { code: 'LEAD_NOT_ELIGIBLE' });

    // A pending or confirmed order in the cycle blocks the loss.
    for (const confirmed of [false, true]) {
      const withOrder = await conversation(seller.id);
      await human(withOrder, seller.id);
      await order(withOrder, confirmed);
      await assert.rejects(lose(seller, withOrder), { code: 'LEAD_HAS_ORDER' });
    }

    // ACT-06: a customer who waits is answered before the loss; a failed
    // send does not answer.
    const waiting = await conversation(seller.id);
    await assert.rejects(lose(seller, waiting), {
      code: 'LEAD_AWAITING_REPLY',
    });
    await human(waiting, seller.id, { status: 'failed' });
    await assert.rejects(lose(seller, waiting), {
      code: 'LEAD_AWAITING_REPLY',
    });
    await human(waiting, seller.id);
    assert.equal((await lose(seller, waiting, 'silencio')).outcomeVersion, 1);

    // A customer message between opening and sending is a version conflict.
    const raced = await conversation(seller.id);
    await human(raced, seller.id);
    const stale = await conversationVersion(raced);
    await customer(raced);
    await assert.rejects(
      record(seller, raced, {
        outcome: 'lost',
        reasonCode: 'prazo',
        expectedConversationVersion: stale,
        expectedOutcomeVersion: 0,
      }),
      { code: 'VERSION_CONFLICT' },
    );

    // Two concurrent declarations of the same version: one wins.
    const contested = await conversation(seller.id);
    await human(contested, seller.id);
    const contestedBody = {
      outcome: 'lost',
      reasonCode: 'concorrente',
      expectedConversationVersion: await conversationVersion(contested),
      expectedOutcomeVersion: 0,
    };
    const raced2 = await Promise.allSettled([
      record(seller, contested, contestedBody),
      record(admin, contested, contestedBody),
    ]);
    assert.equal(
      raced2.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const lostRace = /** @type {PromiseRejectedResult} */ (
      raced2.find((result) => result.status === 'rejected')
    );
    assert.equal(lostRace.reason.code, 'VERSION_CONFLICT');
    assert.equal(await outcomeVersion(contested), 1);

    // A new customer message reopens by derivation, the reply returns to the
    // queue and the history stays; a new loss is version 2.
    const reopenedAt = tick();
    await customer(owned, reopenedAt);
    const derived = await leads.detail({
      actor: seller,
      conversationId: owned,
    });
    assert.equal(derived.state, 'reopened_by_customer');
    assert.equal(derived.reopenedAt, reopenedAt);
    assert.equal(derived.outcomeVersion, 1);
    assert.deepEqual(await actionKinds(seller, owned), ['reply']);
    await assert.rejects(reopen(seller, owned), { code: 'LEAD_NOT_LOST' });
    await assert.rejects(lose(seller, owned, 'prazo'), {
      code: 'LEAD_AWAITING_REPLY',
    });
    await human(owned, seller.id);
    const second = await lose(seller, owned, 'prazo');
    assert.equal(second.outcomeVersion, 2);
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM crm.lead_outcome_events WHERE conversation_id=$1',
            [owned],
          )
        ).rows[0].count,
      ),
      2,
    );
    // The customer also writes again on the admin-marked conversation.
    await customer(forSeller);

    // A manual reopening corrects the loss and takes it out of the count.
    const corrected = await conversation(seller.id);
    await human(corrected, seller.id);
    await lose(seller, corrected, 'indisponivel');
    const correction = await reopen(seller, corrected);
    assert.equal(correction.outcome, 'reopened');
    assert.equal(correction.outcomeVersion, 2);
    assert.equal(correction.reasonCode, null);
    const manual = await leads.detail({
      actor: seller,
      conversationId: corrected,
    });
    assert.equal(manual.state, 'reopened_manual');
    assert.equal(manual.reasonCode, 'indisponivel');
    await assert.rejects(reopen(seller, corrected), { code: 'LEAD_NOT_LOST' });

    // Old loss outside the 30-day window.
    const old = await conversation(seller.id);
    await pool.query(
      `INSERT INTO crm.lead_outcome_events(id,conversation_id,version,outcome,reason_code,owner_id,actor_id,
         last_inbound_message_id,correlation_id,occurred_at)
       SELECT $1,$2,1,'lost','preco',$3,$3,
              (SELECT id FROM crm.messages WHERE conversation_id=$2 AND direction='inbound' LIMIT 1),
              'correlation-old','2026-09-01T12:00:00Z'`,
      [`old-${runId}`, old, seller.id],
    );

    // The event log is immutable.
    for (const sql of [
      `UPDATE crm.lead_outcome_events SET reason_code='prazo' WHERE conversation_id='${owned}'`,
      `DELETE FROM crm.lead_outcome_events WHERE conversation_id='${owned}'`,
      'TRUNCATE crm.lead_outcome_events',
    ])
      await assert.rejects(pool.query(sql), { code: '55000' }, sql);
    await assert.rejects(
      pool.query(
        `INSERT INTO crm.lead_outcome_events(id,conversation_id,version,outcome,reason_code,owner_id,actor_id,correlation_id,occurred_at)
         VALUES($1,$2,9,'lost','outro',$3,$3,'c',now())`,
        [`shape-${runId}`, owned, seller.id],
      ),
      { code: '23514' },
    );

    // MET-08: an active loss removes follow-up and reminders; failures stay.
    const silent = await conversation(
      seller.id,
      new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
    );
    await human(silent, seller.id, {
      at: new Date(NOW.getTime() - 4 * 86_400_000).toISOString(),
    });
    assert.deepEqual(await actionKinds(seller, silent), ['followup']);
    await lose(seller, silent, 'silencio');
    assert.deepEqual(await actionKinds(seller, silent), []);

    const scheduled = await conversation(seller.id);
    const lastSent = await human(scheduled, seller.id);
    await dashboard.decide({
      actor: seller,
      actionId: `conversation:${scheduled}`,
      decision: 'schedule',
      expectedVersion: await conversationVersion(scheduled),
      sourceRevision: `message:${lastSent}:sent:sent`,
      expectedDecisionVersion: 0,
      remindAt: new Date(clock.getTime() + 86_400_000).toISOString(),
      idempotencyKey: `schedule-${runId}`,
      correlationId: `correlation-${runId}`,
    });
    assert.deepEqual(await actionKinds(seller, scheduled), ['reminder']);
    await lose(seller, scheduled, 'prazo');
    assert.deepEqual(await actionKinds(seller, scheduled), []);

    const failedSend = await conversation(seller.id);
    await human(failedSend, seller.id);
    await lose(seller, failedSend, 'concorrente');
    await human(failedSend, seller.id, { status: 'failed' });
    assert.deepEqual(await actionKinds(seller, failedSend), ['reply']);
    assert.equal(
      (await dashboard.actions({ actor: seller })).items.find(
        (/** @type {any} */ item) => item.conversationId === failedSend,
      ).reason,
      'send_failure',
    );

    // HTTP path: the note never reaches the logger, the answer or the audit.
    /** @type {string[]} */
    const logs = [];
    const api = createApi(
      {},
      {
        leadOutcomes: leads,
        logger: createSafeLogger({
          service: 'crm-silmer-api',
          sink: (/** @type {any} */ line) => logs.push(JSON.stringify(line)),
        }),
      },
    );
    t.after(() => api.close());
    const viaHttp = await conversation(seller.id);
    await human(viaHttp, seller.id);
    const httpBody = {
      outcome: 'lost',
      reasonCode: 'outro',
      note: HTTP_NOTE,
      expectedConversationVersion: await conversationVersion(viaHttp),
      expectedOutcomeVersion: 0,
    };
    const headers = {
      cookie: 'crm_session=synthetic',
      origin: 'https://crm.example.test',
      'x-csrf-token': 'synthetic-csrf',
      'idempotency-key': `http-${runId}`,
    };
    const posted = await api.inject({
      method: 'POST',
      url: `/api/v1/conversations/${viaHttp}/lead-outcome`,
      headers,
      payload: httpBody,
    });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.body.includes(HTTP_NOTE), false);
    const reused = await api.inject({
      method: 'POST',
      url: `/api/v1/conversations/${viaHttp}/lead-outcome`,
      headers,
      payload: { ...httpBody, note: `${HTTP_NOTE} alterado` },
    });
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.json().code, 'IDEMPOTENCY_KEY_REUSED');
    const read = await api.inject({
      url: `/api/v1/conversations/${viaHttp}/lead-outcome`,
      headers: { cookie: 'crm_session=synthetic' },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().note, HTTP_NOTE);
    assert.equal(read.json().state, 'lost');
    assert.ok(logs.length > 0);
    for (const text of [NOTE, HTTP_NOTE]) {
      assert.equal(
        logs.some((line) => line.includes(text)),
        false,
      );
      for (const table of [
        'crm.audit_events',
        'crm.idempotency_records',
        'crm.lead_outcome_events',
      ])
        assert.equal(
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM ${table} row WHERE position($1 in row_to_json(row)::text) > 0`,
                [text],
              )
            ).rows[0].count,
          ),
          0,
          `${table} must not hold the note`,
        );
    }

    // Losses: effective declared losses by owner and reason, in the window.
    const team = await metrics.losses({ actor: admin, days: 7 });
    assert.equal(team.scope, 'team');
    assert.equal(team.days, 7);
    const mine = team.rows.find(
      (/** @type {any} */ row) => row.userId === seller.id,
    );
    // owned (prazo, v2), forSeller (outro, reopened by customer), waiting
    // (silencio), contested (concorrente), silent (silencio), scheduled
    // (prazo), failedSend (concorrente), viaHttp (outro). Not: corrected
    // (manual reopening) and old (outside the window).
    assert.deepEqual(mine, {
      userId: seller.id,
      name: 'Pessoa seller',
      active: true,
      lostCount: 8,
      reopenedByCustomerCount: 1,
      byReason: {
        preco: 0,
        prazo: 2,
        concorrente: 2,
        silencio: 2,
        indisponivel: 0,
        outro: 2,
      },
    });
    assert.equal(
      team.rows.find((/** @type {any} */ row) => row.userId === other.id)
        .lostCount,
      0,
    );
    assert.deepEqual(team.totals, {
      lostCount: 8,
      reopenedByCustomerCount: 1,
      byReason: mine.byReason,
    });
    const month = await metrics.losses({ actor: admin, days: 30 });
    assert.equal(
      month.rows.find((/** @type {any} */ row) => row.userId === seller.id)
        .lostCount,
      8,
    );
    const self = await metrics.losses({ actor: other, days: 7 });
    assert.equal(self.scope, 'self');
    assert.equal(Object.hasOwn(self, 'totals'), false);
    assert.deepEqual(
      self.rows.map((/** @type {any} */ row) => row.userId),
      [other.id],
    );
    await assert.rejects(metrics.losses({ actor: financial, days: 7 }), {
      code: 'FORBIDDEN',
    });
    // The service snapshot still reads with the active-loss filter.
    const service = await metrics.service({ actor: admin, days: 7 });
    assert.equal(service.scope, 'team');

    // A replay of the same key after the seller lost the conversation is
    // refused, never answered from the cache.
    const transferred = await conversation(seller.id);
    await human(transferred, seller.id);
    const transferredBody = {
      outcome: 'lost',
      reasonCode: 'preco',
      expectedConversationVersion: await conversationVersion(transferred),
      expectedOutcomeVersion: 0,
    };
    await record(seller, transferred, transferredBody, `owned-${runId}`);
    await pool.query(
      `UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=$1`,
      [transferred, other.id],
    );
    await assert.rejects(
      record(seller, transferred, transferredBody, `owned-${runId}`),
      { code: 'FORBIDDEN' },
    );

    // A customer message racing the declaration never leaves a waiting
    // customer behind an active loss: either the command conflicts or the
    // loss is reopened by that message, and the reply is in the queue.
    for (let round = 0; round < 6; round += 1) {
      const racing = await conversation(seller.id);
      await human(racing, seller.id);
      const body = {
        outcome: 'lost',
        reasonCode: 'silencio',
        expectedConversationVersion: await conversationVersion(racing),
        expectedOutcomeVersion: 0,
      };
      const [declared] = await Promise.allSettled([
        record(seller, racing, body),
        customer(racing),
      ]);
      const state = (
        await leads.detail({ actor: seller, conversationId: racing })
      ).state;
      if (declared.status === 'fulfilled')
        assert.equal(state, 'reopened_by_customer');
      else {
        assert.ok(
          ['VERSION_CONFLICT', 'LEAD_AWAITING_REPLY'].includes(
            declared.reason.code,
          ),
          declared.reason.code,
        );
        assert.equal(state, 'open');
      }
      assert.deepEqual(await actionKinds(seller, racing), ['reply']);
    }
  },
);
