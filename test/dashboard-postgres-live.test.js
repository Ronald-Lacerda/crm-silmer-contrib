import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import {
  createDashboardRuntime,
  readDashboardPerformance,
} from '../apps/api/src/dashboard-runtime.js';
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
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { formatOrderNumber } from '../modules/orders/src/domain/order.js';
import { createOrderApiRuntime } from '../apps/api/src/order-runtime.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-05T15:00:00.000Z');
const CONTACT_KEY = Buffer.alloc(32, 101);
const MESSAGE_KEY = Buffer.alloc(32, 102);
const ORDER_KEY = Buffer.alloc(32, 103);
const IDEMPOTENCY_KEY = Buffer.alloc(32, 104);

test(
  'ACT/PERF PostgreSQL: fenced reminders, concurrent replay and frozen commercial attribution',
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
    const migrations = await loadMigrations();
    await migrate(pool, {
      migrations: migrations.filter((m) => Number(m.version) < 56),
    });
    const runId = randomUUID().slice(0, 8);
    const owner = {
      id: `seller-dashboard-${runId}`,
      kind: 'human',
      functionName: 'Vendedor',
      capabilities: [],
    };
    const other = { ...owner, id: `other-dashboard-${runId}` };
    const admin = {
      ...owner,
      id: `admin-dashboard-${runId}`,
      capabilities: ['COMMERCIAL_ADMIN'],
    };
    const financial = {
      ...owner,
      id: `finance-dashboard-${runId}`,
      functionName: 'Financeiro',
    };
    for (const [actor, name] of /** @type {Array<[typeof owner,string]>} */ ([
      [owner, 'Vendedor Sintético'],
      [other, 'Outro Sintético'],
      [admin, 'Admin Sintético'],
      [financial, 'Financeiro Sintético'],
    ])) {
      await pool.query(
        `INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic',$3)`,
        [actor.id, `${actor.id}@example.test`, name],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [actor.id, actor.functionName],
      );
    }
    await pool.query(
      `INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')`,
      [admin.id],
    );
    const contactId = `manual-dashboard-${runId}`;
    await pool.query(
      `INSERT INTO crm.contacts(id,provisional,display_name,display_name_source,created_at,updated_at)
      VALUES($1,false,'Contato Sintético','manual',$2,$2)`,
      [contactId, NOW],
    );

    /** @param {{conversationId?:string,confirmed?:boolean,promised?:string,amount?:number}} [options] */
    async function order(options = {}) {
      const id = `order-dashboard-${randomUUID()}`;
      const seq = Number(
        (await pool.query(`SELECT nextval('crm.order_number_seq') AS number`))
          .rows[0].number,
      );
      const ficha = {
        summary: {
          cliente: 'Contato Sintético',
          data_entrega_confirmada: options.promised ?? '2026-11-20',
        },
        items: [],
        artwork: {},
      };
      await pool.query(
        `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,
        status,fab_code,ficha_envelope,total_pieces,missing_fields,final_amount_cents,payment_condition,order_date,confirmed_at,
        confirmed_by,created_by_kind,created_by,created_at,updated_at,origin,is_test)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'01',$9::jsonb,20,'{}',$10,$11,$12,$13,$14,'user',$15,$16,$16,'atendimento',false)`,
        [
          id,
          seq,
          formatOrderNumber(seq),
          options.conversationId ?? null,
          contactId,
          options.conversationId ? null : owner.id,
          options.conversationId ? null : `create-${id}`,
          options.confirmed ? 'confirmado' : 'pendente',
          JSON.stringify(encryptJson(ficha, `order-ficha:${id}`, ORDER_KEY)),
          options.confirmed ? (options.amount ?? 100000) : null,
          options.confirmed ? 'pix' : null,
          options.confirmed ? '2026-11-05' : null,
          options.confirmed ? NOW : null,
          options.confirmed ? admin.id : null,
          owner.id,
          NOW,
        ],
      );
      return id;
    }
    // Existing confirmed history must stay unattributed after migration.
    const legacyId = await order({ confirmed: true });
    await migrate(pool, { migrations });
    assert.equal(
      (
        await pool.query('SELECT sales_owner_id FROM crm.orders WHERE id=$1', [
          legacyId,
        ])
      ).rows[0].sales_owner_id,
      null,
    );
    await pool.query(
      "UPDATE crm.orders SET status='pendente',version=version+1 WHERE id=$1",
      [legacyId],
    );
    await pool.query(
      "UPDATE crm.orders SET status='confirmado',version=version+1 WHERE id=$1",
      [legacyId],
    );
    const legacyAfterReconfirmation = (
      await pool.query(
        'SELECT sales_owner_id,sales_owner_captured_at,sales_owner_capture_attempted FROM crm.orders WHERE id=$1',
        [legacyId],
      )
    ).rows[0];
    assert.equal(legacyAfterReconfirmation.sales_owner_id, null);
    assert.equal(legacyAfterReconfirmation.sales_owner_captured_at, null);
    assert.equal(legacyAfterReconfirmation.sales_owner_capture_attempted, true);

    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 105),
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
    /** @param {string} label */
    async function conversation(label) {
      const identity = await contacts.resolveInboundIdentity({
        channel: 'instagram',
        correlationId: `contact-${runId}-${label}`,
        displayHandle: `@synthetic_${label}`,
        externalIdentityId: `identity-${runId}-${label}`,
        identityKind: 'handle',
        occurredAt: '2026-11-01T12:00:00.000Z',
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
        occurredAt: '2026-11-01T12:00:00.000Z',
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      };
      const opened = await inbox.receiveInbound(input);
      await pool.query(
        `UPDATE crm.conversations SET assigned_user_id=$2,automation_state='human' WHERE id=$1`,
        [opened.conversation.id, owner.id],
      );
      return { id: opened.conversation.id, input };
    }
    const reply = await conversation('reply');
    const follow = await conversation('follow');
    const sent = await inbox.sendHumanMessage({
      actor: owner,
      conversationId: follow.id,
      content: { text: 'Resposta sintética' },
      correlationId: `outbound-${runId}`,
      expectedVersion: Number(
        (
          await pool.query(
            'SELECT version FROM crm.conversations WHERE id=$1',
            [follow.id],
          )
        ).rows[0].version,
      ),
      idempotencyKey: `send-${runId}`,
      messageType: 'text',
      reason: 'Synthetic reply',
    });
    await pool.query(
      `UPDATE crm.messages SET status='sent',occurred_at='2026-11-02T14:00:00Z',sent_at='2026-11-02T14:00:00Z' WHERE id=$1`,
      [sent.id],
    );
    const confirmedId = await order({
      conversationId: reply.id,
      confirmed: true,
    });
    assert.equal(
      (
        await pool.query('SELECT sales_owner_id FROM crm.orders WHERE id=$1', [
          confirmedId,
        ])
      ).rows[0].sales_owner_id,
      owner.id,
    );
    const runtime = createDashboardRuntime(database, {
      access: {},
      orderEnvelopeKey: ORDER_KEY,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => NOW,
    });
    const actions = await runtime.actions({ actor: owner });
    const replyItem = actions.items.find(
      (/** @type {any} */ item) => item.targetId === reply.id,
    );
    const followItem = actions.items.find(
      (/** @type {any} */ item) => item.targetId === follow.id,
    );
    assert.equal(replyItem.kind, 'reply');
    assert.equal(followItem.kind, 'followup');

    /** @param {any} item @param {Record<string,any>} [extra] */
    const command = (item, extra = {}) => ({
      actor: owner,
      actionId: item.id,
      decision: 'snooze',
      expectedVersion: item.targetVersion,
      sourceRevision: item.sourceRevision,
      expectedDecisionVersion: item.decisionVersion,
      remindAt: '2026-11-06T12:00:00Z',
      idempotencyKey: `command-${randomUUID()}`,
      correlationId: `decision-${runId}`,
      ...extra,
    });
    const snooze = command(replyItem);
    const [first, replay] = await Promise.all([
      runtime.decide(snooze),
      runtime.decide(snooze),
    ]);
    assert.deepEqual(first, replay);
    assert.equal(first.decisionVersion, 1);
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) FROM crm.audit_events WHERE action='dashboard.action.decided' AND target_id=$1`,
            [reply.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    await assert.rejects(
      runtime.decide({ ...snooze, idempotencyKey: `different-${runId}` }),
      { code: 'VERSION_CONFLICT' },
    );
    await assert.rejects(runtime.decide({ ...snooze, decision: 'schedule' }), {
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    assert.equal(
      (await runtime.actions({ actor: owner })).items.find(
        (/** @type {any} */ item) => item.targetId === reply.id,
      ).deferred,
      true,
    );

    // A scheduled return cannot be dismissed as a mere silence suggestion.
    await runtime.decide(command(followItem, { decision: 'schedule' }));
    const scheduled = (await runtime.actions({ actor: owner })).items.find(
      (/** @type {any} */ item) => item.targetId === follow.id,
    );
    assert.equal(scheduled.kind, 'reminder');
    await assert.rejects(
      runtime.decide(
        command(scheduled, { decision: 'dismiss', remindAt: undefined }),
      ),
      { code: 'ACTION_NOT_AVAILABLE' },
    );

    // New inbound supersedes the source fence, not just the timer.
    await inbox.receiveInbound({
      ...reply.input,
      externalMessageId: `new-inbound-${runId}`,
      occurredAt: '2026-11-05T14:50:00Z',
    });
    const changed = (await runtime.actions({ actor: owner })).items.find(
      (/** @type {any} */ item) => item.targetId === reply.id,
    );
    assert.equal(changed.deferred, false);
    await assert.rejects(
      runtime.decide({ ...snooze, idempotencyKey: `stale-${runId}` }),
      { code: 'VERSION_CONFLICT' },
    );

    await pool.query(
      `UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=$1`,
      [reply.id, other.id],
    );
    await assert.rejects(runtime.decide(snooze), { code: 'FORBIDDEN' });
    assert.equal(
      (await runtime.actions({ actor: owner })).items.some(
        (/** @type {any} */ item) => item.targetId === reply.id,
      ),
      false,
    );
    assert.equal(
      (await runtime.actions({ actor: admin })).items.some(
        (/** @type {any} */ item) => item.targetId === reply.id,
      ),
      false,
    );
    // Reopen/reconfirm preserves the first credit, even after a transfer.
    await pool.query(
      `UPDATE crm.orders SET status='pendente',version=version+1 WHERE id=$1`,
      [confirmedId],
    );
    await pool.query(
      `UPDATE crm.orders SET status='confirmado',confirmed_by=$2,version=version+1 WHERE id=$1`,
      [confirmedId, admin.id],
    );
    assert.equal(
      (
        await pool.query('SELECT sales_owner_id FROM crm.orders WHERE id=$1', [
          confirmedId,
        ])
      ).rows[0].sales_owner_id,
      owner.id,
    );
    await assert.rejects(
      pool.query('UPDATE crm.orders SET sales_owner_id=$2 WHERE id=$1', [
        confirmedId,
        other.id,
      ]),
      { code: '23514' },
    );

    const report = await runtime.performance({ actor: admin, days: 7 });
    const seller = report.rows.find(
      (/** @type {any} */ row) => row.userId === owner.id,
    );
    assert.equal(seller.confirmedCount, 1);
    assert.equal(seller.attendedCount, 1);
    assert.equal(report.unattributed.confirmedCount, 1);
    assert.equal(
      report.totals.soldAmountCents,
      report.rows.reduce(
        (/** @type {number} */ n, /** @type {any} */ row) =>
          n + row.soldAmountCents,
        0,
      ) +
        report.store.soldAmountCents +
        report.unattributed.soldAmountCents,
    );
    const self = await runtime.performance({
      actor: { ...owner, capabilities: ['COMMERCIAL_ADMIN'] },
      days: 7,
    });
    assert.equal(self.scope, 'self');
    assert.deepEqual(
      self.rows.map((/** @type {any} */ row) => row.userId),
      [owner.id],
    );
    await assert.rejects(runtime.performance({ actor: financial }), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(runtime.actions({ actor: financial }), {
      code: 'FORBIDDEN',
    });
    // A receipt failure after an accepted send returns to resolution, not follow-up.
    await pool.query(
      `UPDATE crm.messages SET delivery_status='failed',delivery_status_at=$2 WHERE id=$1`,
      [sent.id, NOW],
    );
    const failed = (await runtime.actions({ actor: owner })).items.find(
      (/** @type {any} */ item) => item.targetId === follow.id,
    );
    assert.equal(failed.reason, 'send_failure');
    assert.equal(failed.deferred, false);
    assert.equal(
      (
        await readDashboardPerformance(pool, {
          from: '2026-11-01',
          to: '2026-11-05',
          manager: true,
        })
      ).rows.find((/** @type {any} */ row) => row.userId === owner.id)
        .attendedCount,
      0,
    );

    // Priority is computed globally from all own eligible orders, not the first 101 SQL rows.
    for (let i = 0; i < 103; i += 1)
      await order({ confirmed: true, promised: '2026-11-30' });
    const lateId = await order({ confirmed: true, promised: '2026-11-01' });
    const capped = await runtime.actions({ actor: owner });
    assert.equal(capped.hasMore, true);
    assert.equal(capped.items.length, 100);
    assert.equal(
      capped.items.find(
        (/** @type {any} */ item) => item.targetType === 'order',
      ).targetId,
      lateId,
    );

    // ACT-12: milestone writes and receipts share the target lock and live ACL.
    const orders = createOrderApiRuntime(database, {
      access: {
        authorizeRead: async () => ({ actor: owner }),
        authorizeWrite: async () => ({ actor: owner }),
      },
      environment: {
        N8N_INTEGRATION_ENVELOPE_KEY: ORDER_KEY.toString('base64'),
        IDEMPOTENCY_ENVELOPE_KEY: IDEMPOTENCY_KEY.toString('base64'),
        CONTACT_IDENTITY_ENVELOPE_KEY: CONTACT_KEY.toString('base64'),
        CONTACT_IDENTITY_LOOKUP_KEY: Buffer.alloc(32, 105).toString('base64'),
        FAB_CODE: '01',
      },
    });
    const milestoneId = await order({
      conversationId: follow.id,
      confirmed: true,
    });
    await pool.query(
      'UPDATE crm.orders SET finance_payment_review_required=true WHERE id=$1',
      [milestoneId],
    );
    const payment = {
      actor: owner,
      orderId: milestoneId,
      expectedVersion: 1,
      paidOn: '2026-11-05',
      receivedInFull: true,
      idempotencyKey: `payment-${runId}`,
      correlationId: `milestones-${runId}`,
    };
    const delivery = {
      actor: owner,
      orderId: milestoneId,
      expectedVersion: 1,
      idempotencyKey: `delivery-${runId}`,
      correlationId: `milestones-${runId}`,
    };
    const race = await Promise.allSettled([
      orders.confirmPayment(payment),
      orders.confirmDelivery(delivery),
    ]);
    assert.equal(
      race.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      race.filter((result) => result.status === 'rejected').length,
      1,
    );
    const firstMilestone = (
      await pool.query(
        'SELECT paid_on,delivered_on,version,finance_payment_review_required FROM crm.orders WHERE id=$1',
        [milestoneId],
      )
    ).rows[0];
    assert.equal(
      Boolean(firstMilestone.paid_on) !== Boolean(firstMilestone.delivered_on),
      true,
    );
    if (firstMilestone.paid_on)
      await orders.confirmDelivery({
        ...delivery,
        expectedVersion: 2,
        idempotencyKey: `delivery-retry-${runId}`,
      });
    else
      await orders.confirmPayment({
        ...payment,
        expectedVersion: 2,
        idempotencyKey: `payment-retry-${runId}`,
      });
    const bothMilestones = (
      await pool.query(
        'SELECT paid_on::text,delivered_on::text,version,finance_payment_review_required FROM crm.orders WHERE id=$1',
        [milestoneId],
      )
    ).rows[0];
    assert.equal(bothMilestones.paid_on, '2026-11-05');
    assert.equal(bothMilestones.delivered_on, '2026-11-05');
    assert.equal(bothMilestones.finance_payment_review_required, false);
    assert.equal(bothMilestones.version, 3);
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=$1',
      [follow.id, other.id],
    );
    await assert.rejects(
      race[0].status === 'fulfilled'
        ? orders.confirmPayment(payment)
        : orders.confirmDelivery(delivery),
      { code: 'FORBIDDEN' },
    );
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=$1',
      [follow.id, owner.id],
    );
    await pool.query(
      "UPDATE crm.user_functions SET function_name='Financeiro' WHERE user_id=$1",
      [owner.id],
    );
    await assert.rejects(
      orders.confirmPayment({
        ...payment,
        expectedVersion: 3,
        idempotencyKey: `revoked-payment-${runId}`,
      }),
      { statusCode: 403 },
    );
    await pool.query(
      "UPDATE crm.user_functions SET function_name='Vendedor' WHERE user_id=$1",
      [owner.id],
    );
    await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
      owner.id,
      NOW,
    ]);
    await assert.rejects(
      orders.confirmDelivery({
        ...delivery,
        expectedVersion: 3,
        idempotencyKey: `disabled-delivery-${runId}`,
      }),
      { code: 'FORBIDDEN' },
    );
    assert.equal(
      (
        await pool.query('SELECT version FROM crm.orders WHERE id=$1', [
          milestoneId,
        ])
      ).rows[0].version,
      3,
    );
  },
);
