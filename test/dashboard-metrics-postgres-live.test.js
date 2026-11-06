import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Pool } from 'pg';

import {
  createDashboardMetricsRuntime,
  readServiceMetrics,
} from '../apps/api/src/dashboard-metrics-runtime.js';
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

const connectionString = process.env.TEST_DATABASE_URL;
const CONTACT_KEY = Buffer.alloc(32, 111);
const MESSAGE_KEY = Buffer.alloc(32, 112);
/** São Paulo wall clock (UTC-03:00, no daylight saving since 2019). */
const sp = (/** @type {string} */ local) => `${local}:00-03:00`;
/** Thursday 05/11/2026 15:00 in São Paulo. */
const NOW = new Date(sp('2026-11-05T15:00'));

test(
  'MET PostgreSQL: business minutes, claim and first response, unanswered now and episodes',
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

    /** @param {string} from @param {string} to */
    const minutes = async (from, to) =>
      Number(
        (
          await pool.query('SELECT crm.business_minutes_v1($1,$2) AS m', [
            from,
            to,
          ])
        ).rows[0].m,
      );
    // Friday 17:50 -> Monday 09:05: ten minutes on Friday, five on Monday.
    assert.equal(
      await minutes(sp('2026-10-30T17:50'), sp('2026-11-02T09:05')),
      15,
    );
    // Lunch is not business time.
    assert.equal(
      await minutes(sp('2026-11-04T11:55'), sp('2026-11-04T13:05')),
      10,
    );
    assert.equal(
      await minutes(sp('2026-10-31T08:00'), sp('2026-11-01T20:00')),
      0,
    );
    // Monday 08:00 -> Wednesday 20:00: three full business days.
    assert.equal(
      await minutes(sp('2026-11-02T08:00'), sp('2026-11-04T20:00')),
      1440,
    );
    assert.equal(
      await minutes(sp('2026-11-05T09:11'), sp('2026-11-04T17:55')),
      0,
    );
    assert.equal(
      await minutes(sp('2026-11-04T17:55'), sp('2026-11-05T09:11')),
      16,
    );
    assert.equal(
      await minutes(sp('2026-11-04T17:55'), sp('2026-11-05T09:09')),
      14,
    );
    const deadline = await pool.query(
      `SELECT crm.business_deadline_v1($1,15) AS friday,
              crm.business_deadline_v1($2,15) AS lunch`,
      [sp('2026-10-30T17:50'), sp('2026-11-04T11:55')],
    );
    assert.equal(
      deadline.rows[0].friday.toISOString(),
      new Date(sp('2026-11-02T09:05')).toISOString(),
    );
    assert.equal(
      deadline.rows[0].lunch.toISOString(),
      new Date(sp('2026-11-04T13:10')).toISOString(),
    );

    const runId = randomUUID().slice(0, 8);
    /** @param {string} label @param {string} functionName @param {boolean} [admin] */
    async function user(label, functionName, admin = false) {
      const actor = {
        id: `${label}-metrics-${runId}`,
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
    const sellerA = await user('a', 'Vendedor');
    const sellerB = await user('b', 'Vendedor');
    const sellerC = await user('c', 'Vendedor');
    const sellerD = await user('d', 'Vendedor');
    const sellerE = await user('e', 'Vendedor');
    const sellerF = await user('f', 'Vendedor');
    const sellerG = await user('g', 'Vendedor');
    const admin = await user('admin', 'Vendedor', true);
    const financial = await user('finance', 'Financeiro');

    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 113),
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
    let sequence = 0;
    /** Opens a cycle with a customer message, in human mode.
     * @param {string} local @param {string|null} owner */
    async function conversation(local, owner) {
      const openedAt = new Date(local).toISOString();
      const label = `c${(sequence += 1)}`;
      const identity = await contacts.resolveInboundIdentity({
        channel: 'instagram',
        correlationId: `contact-${runId}-${label}`,
        displayHandle: `@synthetic_${label}`,
        externalIdentityId: `identity-${runId}-${label}`,
        identityKind: 'handle',
        occurredAt: openedAt,
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
        occurredAt: openedAt,
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      await pool.query(
        `UPDATE crm.conversations SET automation_state='human',assigned_user_id=$2 WHERE id=$1`,
        [opened.conversation.id, owner],
      );
      return /** @type {string} */ (opened.conversation.id);
    }
    /** @param {string} conversationId @param {string} at @param {{kind?:'contact'|'human'|'assistant'|'system',author?:string,status?:string,delivery?:string|null}} [options] */
    async function message(conversationId, at, options = {}) {
      const kind = options.kind ?? 'contact';
      const inbound = kind === 'contact';
      const id = `message-${runId}-${(sequence += 1)}`;
      const status = inbound ? 'received' : (options.status ?? 'sent');
      await pool.query(
        `INSERT INTO crm.messages
           (id,conversation_id,provider,provider_account_id,external_message_id,
            command_id,direction,author_kind,author_id,message_type,
            content_envelope,key_version,status,delivery_status,delivery_status_at,sent_at,occurred_at,created_at)
         SELECT $1,id,provider,provider_account_id,$3,$4,$5,$6,$7,'text',$8::jsonb,
                1,$9,$10,CASE WHEN $10::text IS NULL THEN NULL ELSE $12::timestamptz END,$11,$12,$12
         FROM crm.conversations WHERE id=$2`,
        [
          id,
          conversationId,
          inbound ? id : null,
          inbound ? null : id,
          inbound ? 'inbound' : 'outbound',
          kind,
          options.author ?? 'synthetic',
          JSON.stringify(
            encryptJson(
              { text: 'Texto sintético' },
              `message:${id}`,
              MESSAGE_KEY,
            ),
          ),
          status,
          inbound
            ? null
            : (options.delivery ?? (status === 'sent' ? 'sent' : null)),
          !inbound && status === 'sent' ? at : null,
          at,
        ],
      );
      await pool.query(
        'UPDATE crm.conversations SET last_message_at=greatest(last_message_at,$2) WHERE id=$1',
        [conversationId, at],
      );
    }
    /** @param {string} conversationId @param {string} actorId @param {string} at */
    const reply = (conversationId, actorId, at) =>
      message(conversationId, at, { kind: 'human', author: actorId });
    /** @param {string} action @param {string} conversationId @param {string} actorId @param {string} at @param {string} [reason] */
    const audit = (
      action,
      conversationId,
      actorId,
      at,
      reason = 'Motivo sintético',
    ) =>
      pool.query(
        `INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at)
         VALUES($1,$2,$3,'conversation',$4,'1',$5,$6,$7)`,
        [
          `audit-${runId}-${(sequence += 1)}`,
          actorId,
          action,
          conversationId,
          reason,
          `correlation-${runId}`,
          at,
        ],
      );
    /** @param {string} conversationId @param {string} createdAt @param {{by:string,at:string}} [claim] */
    async function handoff(conversationId, createdAt, claim) {
      const id = `handoff-${runId}-${(sequence += 1)}`;
      await pool.query(
        `INSERT INTO crm.handoffs
           (id,conversation_id,assigned_user_id,status,version,reason_code,summary_envelope,
            due_at,sla_minutes,sla_policy_version,created_at,updated_at,target_role)
         VALUES($1,$2,NULL,'pending',1,'customer_requested_human',
                '{"algorithm":"AES-256-GCM","version":"1"}'::jsonb,
                $3::timestamptz + interval '30 minutes',30,'v1',$3,$3,'Vendedor')`,
        [id, conversationId, createdAt],
      );
      await pool.query(
        `INSERT INTO crm.handoff_history(handoff_id,resulting_version,from_status,to_status,
           assigned_user_id,target_role,actor_id,reason_code,correlation_id,occurred_at)
         VALUES($1,1,NULL,'pending',NULL,'Vendedor','n8n','handoff_requested',$2,$3)`,
        [id, `correlation-${runId}`, createdAt],
      );
      if (!claim) return id;
      await pool.query(
        `UPDATE crm.handoffs SET status='accepted',assigned_user_id=$2,version=2,updated_at=$3 WHERE id=$1`,
        [id, claim.by, claim.at],
      );
      await pool.query(
        `INSERT INTO crm.handoff_history(handoff_id,resulting_version,from_status,to_status,
           assigned_user_id,target_role,actor_id,reason_code,correlation_id,occurred_at)
         VALUES($1,2,'pending','accepted',$2,'Vendedor',$2,'handoff_claimed',$3,$4)`,
        [id, claim.by, `correlation-${runId}`, claim.at],
      );
      return id;
    }

    // Seller A: five claimed requests with known waits. Bot, system, failed
    // and unknown sends before the reply do not end the wait (PERF-03).
    const claimWaits = [1, 2, 3, 4, 10];
    const replyWaits = [5, 10, 15, 18, 25];
    for (const [index, claimAfter] of claimWaits.entries()) {
      const id = await conversation(sp('2026-11-04T08:50'), sellerA.id);
      await handoff(id, sp('2026-11-04T09:00'), {
        by: sellerA.id,
        at: sp(`2026-11-04T09:${String(claimAfter).padStart(2, '0')}`),
      });
      if (index === 0) {
        await message(id, sp('2026-11-04T09:02'), { kind: 'assistant' });
        await message(id, sp('2026-11-04T09:03'), {
          kind: 'human',
          author: sellerA.id,
          status: 'failed',
        });
        await message(id, sp('2026-11-04T09:04'), {
          kind: 'human',
          author: sellerA.id,
          delivery: 'outcome_unknown',
        });
        await message(id, sp('2026-11-04T09:04'), {
          kind: 'human',
          author: sellerA.id,
          status: 'outcome_unknown',
        });
        await message(id, sp('2026-11-04T09:04'), { kind: 'system' });
      }
      await reply(
        id,
        sellerA.id,
        sp(`2026-11-04T09:${String(replyWaits[index]).padStart(2, '0')}`),
      );
    }

    // Seller B: lunch is discounted; one request still open, one closed
    // without reply.
    const b1 = await conversation(sp('2026-11-04T11:50'), sellerB.id);
    await handoff(b1, sp('2026-11-04T11:55'), {
      by: sellerB.id,
      at: sp('2026-11-04T12:30'),
    });
    await reply(b1, sellerB.id, sp('2026-11-04T13:05'));
    const b2 = await conversation(sp('2026-11-05T13:50'), sellerB.id);
    await handoff(b2, sp('2026-11-05T14:00'), {
      by: sellerB.id,
      at: sp('2026-11-05T14:05'),
    });
    const b3 = await conversation(sp('2026-11-05T10:00'), sellerB.id);
    await handoff(b3, sp('2026-11-05T10:05'), {
      by: sellerB.id,
      at: sp('2026-11-05T10:10'),
    });
    await pool.query(
      `UPDATE crm.conversations SET state='encerrada',terminal_at=$2,closure_outcome='sem_pedido',closed_by=$3 WHERE id=$1`,
      [b3, sp('2026-11-05T10:20'), sellerB.id],
    );

    // Nobody claimed this request yet: a team-level fact, not a seller's.
    const unclaimed = await conversation(sp('2026-11-05T14:30'), null);
    await handoff(unclaimed, sp('2026-11-05T14:30'));

    // Direct takeover: no claim sample. The customer writes at 17:55 and is
    // answered only the next morning at 11:00.
    const takeover = await conversation(sp('2026-11-04T10:00'), sellerA.id);
    await audit(
      'conversation.takeover',
      takeover,
      sellerA.id,
      sp('2026-11-04T10:01'),
    );
    await reply(takeover, sellerA.id, sp('2026-11-04T10:05'));
    await message(takeover, sp('2026-11-04T17:55'));
    await reply(takeover, sellerA.id, sp('2026-11-05T11:00'));

    // Episodes: two waits over 15 minutes (two customer messages in the
    // first) and one answered in 10 minutes in the same conversation.
    const episodes = await conversation(sp('2026-11-03T08:30'), sellerA.id);
    await audit(
      'conversation.takeover',
      episodes,
      sellerA.id,
      sp('2026-11-03T09:00'),
    );
    await message(episodes, sp('2026-11-03T09:10'));
    await message(episodes, sp('2026-11-03T09:12'));
    await reply(episodes, sellerA.id, sp('2026-11-03T09:40'));
    await message(episodes, sp('2026-11-03T10:00'));
    await reply(episodes, sellerA.id, sp('2026-11-03T10:10'));
    await message(episodes, sp('2026-11-03T14:00'));
    await reply(episodes, sellerA.id, sp('2026-11-03T14:30'));

    // Credit follows the owner at the crossing instant, not today's owner.
    const transferred = await conversation(sp('2026-11-03T08:30'), sellerB.id);
    await audit(
      'conversation.takeover',
      transferred,
      sellerA.id,
      sp('2026-11-03T09:00'),
    );
    await reply(transferred, sellerA.id, sp('2026-11-03T09:05'));
    await message(transferred, sp('2026-11-03T15:00'));
    await audit(
      'conversation.transferred',
      transferred,
      sellerA.id,
      sp('2026-11-03T15:10'),
      `Motivo sintético (repasse para ${sellerB.id})`,
    );
    await reply(transferred, sellerB.id, sp('2026-11-03T15:40'));
    const laterTransfer = await conversation(
      sp('2026-11-03T08:30'),
      sellerB.id,
    );
    await audit(
      'conversation.takeover',
      laterTransfer,
      sellerA.id,
      sp('2026-11-03T09:00'),
    );
    await reply(laterTransfer, sellerA.id, sp('2026-11-03T09:05'));
    await message(laterTransfer, sp('2026-11-03T16:00'));
    await reply(laterTransfer, sellerA.id, sp('2026-11-03T16:40'));
    await audit(
      'conversation.transferred',
      laterTransfer,
      sellerA.id,
      sp('2026-11-03T17:00'),
      `Motivo sintético (repasse para ${sellerB.id})`,
    );

    // Claim and first response never overlap (RFC 048). Pending customer
    // message at the claim: request 10:00, claim 10:20, reply 10:25.
    const pendingAtClaim = await conversation(
      sp('2026-11-04T09:55'),
      sellerE.id,
    );
    await handoff(pendingAtClaim, sp('2026-11-04T10:00'), {
      by: sellerE.id,
      at: sp('2026-11-04T10:20'),
    });
    await reply(pendingAtClaim, sellerE.id, sp('2026-11-04T10:25'));
    // Nothing pending at the claim (already answered): the first response
    // starts at the next customer message, 10:30, answered at 10:34.
    const answeredBefore = await conversation(
      sp('2026-11-04T09:40'),
      sellerF.id,
    );
    await reply(answeredBefore, sellerF.id, sp('2026-11-04T09:45'));
    await handoff(answeredBefore, sp('2026-11-04T09:55'), {
      by: sellerF.id,
      at: sp('2026-11-04T10:00'),
    });
    await message(answeredBefore, sp('2026-11-04T10:30'));
    await reply(answeredBefore, sellerF.id, sp('2026-11-04T10:34'));

    // Episodes follow the human history, not today's state: one wait over 15
    // minutes before the conversation went back to the bot, another before it
    // was closed.
    const backToBot = await conversation(sp('2026-11-02T08:30'), sellerG.id);
    await audit(
      'conversation.takeover',
      backToBot,
      sellerG.id,
      sp('2026-11-02T09:00'),
    );
    await reply(backToBot, sellerG.id, sp('2026-11-02T09:05'));
    await message(backToBot, sp('2026-11-02T10:00'));
    await reply(backToBot, sellerG.id, sp('2026-11-02T10:30'));
    await pool.query(
      `UPDATE crm.conversations SET automation_state='assistant',assigned_user_id=NULL WHERE id=$1`,
      [backToBot],
    );
    const closedLater = await conversation(sp('2026-11-02T13:30'), sellerG.id);
    await audit(
      'conversation.takeover',
      closedLater,
      sellerG.id,
      sp('2026-11-02T14:00'),
    );
    await reply(closedLater, sellerG.id, sp('2026-11-02T14:05'));
    await message(closedLater, sp('2026-11-02T14:10'));
    await reply(closedLater, sellerG.id, sp('2026-11-02T14:40'));
    await pool.query(
      `UPDATE crm.conversations SET state='encerrada',terminal_at=$2,closure_outcome='concluido',closed_by=$3 WHERE id=$1`,
      [closedLater, sp('2026-11-02T15:00'), sellerG.id],
    );
    // A request still pending on a conversation someone already took over
    // directly is never omitted from the team view (MET-02).
    const ownedPending = await conversation(sp('2026-11-05T14:35'), sellerG.id);
    await audit(
      'conversation.takeover',
      ownedPending,
      sellerG.id,
      sp('2026-11-05T14:36'),
    );
    await reply(ownedPending, sellerG.id, sp('2026-11-05T14:38'));
    await handoff(ownedPending, sp('2026-11-05T14:40'));

    // Seller C answered and was later disabled: authorship is preserved.
    const inactive = await conversation(sp('2026-11-03T10:00'), sellerC.id);
    await handoff(inactive, sp('2026-11-03T10:00'), {
      by: sellerC.id,
      at: sp('2026-11-03T10:02'),
    });
    await reply(inactive, sellerC.id, sp('2026-11-03T10:06'));
    await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
      sellerC.id,
      sp('2026-11-04T08:00'),
    ]);

    // Period limits are São Paulo days: 29/10 23:30 in São Paulo is already
    // 30/10 in UTC, but stays out of a window that starts on 30/10.
    for (const createdAt of ['2026-10-29T23:30', '2026-10-30T00:30']) {
      const id = await conversation(sp(createdAt), sellerD.id);
      await handoff(id, sp(createdAt), {
        by: sellerD.id,
        at: sp('2026-10-30T09:00'),
      });
      await reply(id, sellerD.id, sp('2026-10-30T09:01'));
    }

    /** @param {Date} now @param {string} from @param {string} to */
    const report = (now, from = '2026-10-30', to = '2026-11-05') =>
      readServiceMetrics(database, {
        from,
        to,
        actorId: admin.id,
        manager: true,
        now,
      });
    const team = await report(NOW);
    /** @param {{id:string}} actor */
    const row = (actor) =>
      team.rows.find((/** @type {any} */ item) => item.userId === actor.id);

    assert.deepEqual(row(sellerA).claim, {
      samples: 5,
      medianMinutes: 3,
      p90Minutes: 7.6,
    });
    // From the claim: 4, 8, 12, 14 and 15 minutes.
    assert.deepEqual(row(sellerA).firstResponse, {
      samples: 5,
      medianMinutes: 12,
      p90Minutes: 14.6,
      openCount: 0,
      oldestOpenMinutes: null,
      closedWithoutReply: 0,
    });
    assert.deepEqual(row(sellerA).unansweredNow, {
      count: 0,
      oldestWaitingMinutes: null,
    });
    // Takeover overnight (1), two in the same conversation (2) and the one
    // crossed before the later transfer (1).
    assert.equal(row(sellerA).unansweredEpisodes.count, 4);

    assert.deepEqual(row(sellerB).claim, {
      samples: 3,
      medianMinutes: 5,
      p90Minutes: null,
    });
    // 12:30 -> 13:05 is 5 business minutes; the open one waits since 14:05.
    assert.deepEqual(row(sellerB).firstResponse, {
      samples: 1,
      medianMinutes: 5,
      p90Minutes: null,
      openCount: 1,
      oldestOpenMinutes: 55,
      closedWithoutReply: 1,
    });
    assert.deepEqual(row(sellerB).unansweredNow, {
      count: 1,
      oldestWaitingMinutes: 55,
    });
    // The open request (crossed 14:20) and the wait transferred before 15:15.
    assert.equal(row(sellerB).unansweredEpisodes.count, 2);

    assert.equal(row(sellerC).active, false);
    assert.equal(row(sellerC).claim.samples, 1);
    assert.equal(row(sellerC).firstResponse.medianMinutes, 4);
    assert.deepEqual(row(sellerE).claim, {
      samples: 1,
      medianMinutes: 20,
      p90Minutes: null,
    });
    assert.equal(row(sellerE).firstResponse.samples, 1);
    assert.equal(row(sellerE).firstResponse.medianMinutes, 5);
    assert.equal(row(sellerF).claim.medianMinutes, 5);
    assert.equal(row(sellerF).firstResponse.samples, 1);
    assert.equal(row(sellerF).firstResponse.medianMinutes, 4);
    assert.equal(row(sellerF).unansweredEpisodes.count, 0);
    assert.equal(row(sellerG).unansweredEpisodes.count, 2);
    assert.deepEqual(row(sellerG).unansweredNow, {
      count: 0,
      oldestWaitingMinutes: null,
    });
    assert.equal(row(sellerG).claim.samples, 0);
    assert.equal(row(sellerD).claim.samples, 1);
    assert.equal(row(sellerD).claim.medianMinutes, 0);
    assert.equal(row(sellerD).firstResponse.medianMinutes, 1);
    assert.equal(row(admin).claim.samples, 0);
    assert.equal(row(admin).claim.medianMinutes, null);
    assert.equal(row(financial), undefined);
    assert.deepEqual(team.team, {
      unclaimedHandoffs: { count: 2, oldestWaitingMinutes: 30 },
    });

    // The 29/10 request belongs to a window that includes that São Paulo day.
    assert.equal(
      (await report(NOW, '2026-10-29', '2026-10-29')).rows.find(
        (/** @type {any} */ item) => item.userId === sellerD.id,
      ).claim.samples,
      1,
    );

    // Unanswered now: 17:55 -> 09:11 is 16 business minutes, 09:09 is 14.
    const at0911 = await report(new Date(sp('2026-11-05T09:11')));
    assert.deepEqual(
      at0911.rows.find((/** @type {any} */ item) => item.userId === sellerA.id)
        .unansweredNow,
      { count: 1, oldestWaitingMinutes: 16 },
    );
    const at0909 = await report(new Date(sp('2026-11-05T09:09')));
    assert.deepEqual(
      at0909.rows.find((/** @type {any} */ item) => item.userId === sellerA.id)
        .unansweredNow,
      { count: 0, oldestWaitingMinutes: null },
    );

    // Scope is decided by the database role, never by the caller.
    const runtime = createDashboardMetricsRuntime(database, {
      access: {},
      clock: () => NOW,
    });
    const own = await runtime.service({
      actor: { ...sellerA, capabilities: ['COMMERCIAL_ADMIN'] },
    });
    assert.equal(own.scope, 'self');
    assert.equal(own.team, undefined);
    assert.deepEqual(
      own.rows.map((/** @type {any} */ item) => item.userId),
      [sellerA.id],
    );
    assert.equal(own.businessHours.policy, 'expediente-v1');
    const managed = await runtime.service({ actor: admin, days: 30 });
    assert.equal(managed.scope, 'team');
    assert.equal(managed.from, '2026-10-07');
    assert.equal(managed.team.unclaimedHandoffs.count, 2);
    await assert.rejects(runtime.service({ actor: financial }), {
      statusCode: 403,
    });
    await assert.rejects(runtime.service({ actor: sellerC }), {
      statusCode: 403,
    });
  },
);

test(
  'MET PostgreSQL volume: 1000 human conversations x 30 messages stay within budget',
  { skip: !connectionString },
  async (t) => {
    assert.match(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 4 });
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    const seller = 'seller-volume';
    await pool.query(
      `INSERT INTO crm.users(id,email,password_hash,name)
       VALUES($1,'seller-volume@example.test','$argon2id$synthetic','Pessoa Volume')`,
      [seller],
    );
    await pool.query(
      `INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')`,
      [seller],
    );
    const contacts = createContactIdentityService({
      auditPort: { append: async () => undefined },
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database: {
          query: pool.query.bind(pool),
          transaction: (/** @type {any} */ work) => withTransaction(pool, work),
        },
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 114),
      }),
    });
    const identity = await contacts.resolveInboundIdentity({
      channel: 'instagram',
      correlationId: 'contact-volume',
      displayHandle: '@synthetic_volume',
      externalIdentityId: 'identity-volume',
      identityKind: 'handle',
      occurredAt: '2026-10-01T12:00:00.000Z',
      phoneStatus: 'pending',
      provider: 'meta',
      providerAccountId: 'account-volume',
    });
    // Fifteen customer messages and fifteen replies a day apart, 1 to 40
    // minutes later, so some waits cross the threshold inside the window.
    const base = sp('2026-10-15T09:00');
    await pool.query(
      `INSERT INTO crm.conversations
         (id,contact_identity_id,provider,provider_account_id,external_conversation_id,
          cycle_number,state,automation_state,assigned_user_id,opened_at,last_message_at)
       SELECT 'volume-' || g, $1, 'meta', 'account-volume', 'volume-external-' || g, 1,
              'em_atendimento', 'human', $2, $3::timestamptz - interval '1 hour',
              $3::timestamptz + interval '15 days'
       FROM generate_series(1, 1000) g`,
      [identity.identity.id, seller, base],
    );
    await pool.query(
      `INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at)
       SELECT 'volume-takeover-' || g, $1, 'conversation.takeover', 'conversation',
              'volume-' || g, '1', 'Motivo sintético', 'volume',
              $2::timestamptz - interval '30 minutes'
       FROM generate_series(1, 1000) g`,
      [seller, base],
    );
    await pool.query(
      `INSERT INTO crm.messages
         (id,conversation_id,provider,provider_account_id,external_message_id,command_id,
          direction,author_kind,author_id,message_type,content_envelope,key_version,status,
          delivery_status,delivery_status_at,sent_at,occurred_at,created_at)
       SELECT 'volume-message-' || g || '-' || k, 'volume-' || g, 'meta', 'account-volume',
              CASE WHEN k % 2 = 0 THEN 'volume-external-' || g || '-' || k END,
              CASE WHEN k % 2 = 1 THEN 'volume-command-' || g || '-' || k END,
              CASE WHEN k % 2 = 0 THEN 'inbound' ELSE 'outbound' END,
              CASE WHEN k % 2 = 0 THEN 'contact' ELSE 'human' END,
              CASE WHEN k % 2 = 0 THEN 'contact-volume' ELSE $1 END, 'text',
              '{"algorithm":"AES-256-GCM","keyVersion":1,"version":1}'::jsonb, 1,
              CASE WHEN k % 2 = 0 THEN 'received' ELSE 'sent' END,
              CASE WHEN k % 2 = 1 THEN 'sent' END, CASE WHEN k % 2 = 1 THEN clock.at END,
              CASE WHEN k % 2 = 1 THEN clock.at END, clock.at, clock.at
       FROM generate_series(1, 1000) g CROSS JOIN generate_series(0, 29) k
       CROSS JOIN LATERAL (
         SELECT $2::timestamptz + (k / 2) * interval '1 day' + (g % 300) * interval '1 minute'
                + CASE WHEN k % 2 = 1 THEN (1 + (g + k) % 40) * interval '1 minute'
                       ELSE interval '0' END AS at
       ) clock`,
      [seller, base],
    );
    await pool.query(
      `INSERT INTO crm.handoffs
         (id,conversation_id,assigned_user_id,status,version,reason_code,summary_envelope,
          due_at,sla_minutes,sla_policy_version,created_at,updated_at,target_role)
       SELECT 'volume-handoff-' || g, 'volume-' || g, $1, 'accepted', 2,
              'customer_requested_human', '{"algorithm":"AES-256-GCM","version":"1"}'::jsonb,
              $2::timestamptz + interval '30 minutes', 30, 'v1', $2, $2, 'Vendedor'
       FROM generate_series(1, 1000) g`,
      [seller, sp('2026-10-28T10:00')],
    );
    await pool.query(
      `INSERT INTO crm.handoff_history(handoff_id,resulting_version,from_status,to_status,
         assigned_user_id,target_role,actor_id,reason_code,correlation_id,occurred_at)
       SELECT 'volume-handoff-' || g, 2, 'pending', 'accepted', $1, 'Vendedor', $1,
              'handoff_claimed', 'volume', $2::timestamptz + (g % 20) * interval '1 minute'
       FROM generate_series(1, 1000) g`,
      [seller, sp('2026-10-28T10:00')],
    );
    await pool.query('ANALYZE');

    /** @type {{sql:string,values:unknown[]}[]} */
    const captured = [];
    const capturing = {
      query: (
        /** @type {string} */ sql,
        /** @type {unknown[]} */ values = [],
      ) => {
        captured.push({ sql, values });
        return pool.query(sql, values);
      },
    };
    const input = {
      from: '2026-10-07',
      to: '2026-11-05',
      actorId: seller,
      manager: true,
      now: NOW,
    };
    /** @type {number[]} */
    const durations = [];
    /** @type {any} */
    let report;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      report = await readServiceMetrics(capturing, input);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const row = report.rows.find(
      (/** @type {any} */ item) => item.userId === seller,
    );
    assert.equal(row.claim.samples, 1000);
    assert.ok(row.unansweredEpisodes.count > 0);
    const median = durations[1];
    t.diagnostic(`service metrics median ${median.toFixed(0)} ms`);
    assert.ok(median < 1500, `service metrics took ${median.toFixed(0)} ms`);
    const statement = /** @type {{sql:string,values:unknown[]}} */ (
      captured.at(-1)
    );
    const plan = (
      await pool.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`,
        statement.values,
      )
    ).rows[0]['QUERY PLAN'];
    /** @param {any} node @returns {any[]} */
    const nodes = (node) => [
      node,
      ...(node.Plans ?? []).flatMap((/** @type {any} */ child) => nodes(child)),
    ];
    const looped = nodes(plan[0].Plan).filter(
      (node) => node['Node Type'] === 'CTE Scan' && node['Actual Loops'] > 1,
    );
    assert.deepEqual(
      looped.map((node) => `${node['CTE Name']} x${node['Actual Loops']}`),
      [],
    );
  },
);
