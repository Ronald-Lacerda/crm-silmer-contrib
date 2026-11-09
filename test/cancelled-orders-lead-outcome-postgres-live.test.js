import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

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
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { encryptJson as encryptOrder } from '../modules/orders/src/adapters/envelope.js';
import { formatOrderNumber } from '../modules/orders/src/domain/order.js';

const connectionString = process.env.TEST_DATABASE_URL;
const CONTACT_KEY = Buffer.alloc(32, 151);
const MESSAGE_KEY = Buffer.alloc(32, 152);
const ORDER_KEY = Buffer.alloc(32, 153);
const IDEMPOTENCY_KEY = Buffer.alloc(32, 154);
const NOTE_KEY = Buffer.alloc(32, 155);
/** São Paulo wall clock (UTC-03:00). Thursday 05/11/2026 15:00. */
const NOW = new Date('2026-11-05T15:00:00-03:00');

test(
  'OLIST-19/45 PostgreSQL: a cancelled order does not block declaring a lead lost, an active one still does',
  { skip: !connectionString },
  async (t) => {
    assert.match(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 4 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });

    let clock = NOW;
    const tick = () => {
      clock = new Date(clock.getTime() + 60_000);
      return clock.toISOString();
    };
    const runId = randomUUID().slice(0, 8);
    const seller = {
      id: `seller-clead-${runId}`,
      kind: 'human',
      functionName: 'Vendedor',
      capabilities: /** @type {string[]} */ ([]),
    };
    const admin = { ...seller, id: `admin-clead-${runId}` };
    for (const actor of [seller, admin]) {
      await pool.query(
        `INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic',$3)`,
        [actor.id, `${actor.id}@example.test`, 'Pessoa Sintética'],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [actor.id, 'Vendedor'],
      );
    }

    const auditPort = { append: async () => undefined };
    const contacts = createContactIdentityService({
      auditPort,
      clock: () => clock,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 156),
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
    /** A human-mode cycle opened by a customer message and already answered. */
    async function conversation() {
      const label = `c${(sequence += 1)}`;
      const at = tick();
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
      const opened = await inbox.receiveInbound({
        contactId: identity.contact.id,
        correlationId: `inbound-${runId}-${label}`,
        externalConversationId: `external-${runId}-${label}`,
        externalMessageId: `inbound-${runId}-${label}`,
        identityId: identity.identity.id,
        message: { content: { text: 'Mensagem sintética' }, type: 'text' },
        occurredAt: at,
        provider: 'meta',
        providerAccountId: `account-${runId}`,
      });
      const id = /** @type {string} */ (opened.conversation.id);
      await pool.query(
        `UPDATE crm.conversations SET automation_state='human',assigned_user_id=$2,
           state='em_atendimento',version=version+1 WHERE id=$1`,
        [id, seller.id],
      );
      // The seller answered the customer: nothing is awaiting a reply.
      const sentAt = tick();
      const messageId = `message-${runId}-${(sequence += 1)}`;
      await pool.query(
        `INSERT INTO crm.messages
           (id,conversation_id,provider,provider_account_id,external_message_id,
            command_id,direction,author_kind,author_id,message_type,
            content_envelope,key_version,status,delivery_status,delivery_status_at,sent_at,occurred_at,created_at)
         SELECT $1,id,provider,provider_account_id,NULL,$1,'outbound','human',$3,'text',$4::jsonb,
                1,'sent','sent',$5::timestamptz,$5,$5,$5
         FROM crm.conversations WHERE id=$2`,
        [
          messageId,
          id,
          seller.id,
          JSON.stringify(
            encryptJson(
              { text: 'Resposta sintética' },
              `message:${messageId}`,
              MESSAGE_KEY,
            ),
          ),
          sentAt,
        ],
      );
      await pool.query(
        `UPDATE crm.conversations SET version=version+1,last_message_at=greatest(last_message_at,$2) WHERE id=$1`,
        [id, sentAt],
      );
      return id;
    }
    /** @param {string} id @param {boolean} confirmed */
    async function order(id, confirmed) {
      const orderId = `order-clead-${randomUUID()}`;
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
      return orderId;
    }
    /** @param {string} id */
    async function cancel(id) {
      await pool.query(
        `UPDATE crm.orders SET cancelled_at=$2,cancelled_by=$3,cancellation_reason_envelope=$4::jsonb,
           version=version+1,updated_at=$2 WHERE id=$1`,
        [
          id,
          clock,
          admin.id,
          JSON.stringify(
            encryptOrder(
              'Duplicidade sintética',
              `order-cancellation:${id}`,
              ORDER_KEY,
            ),
          ),
        ],
      );
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

    const leads = createLeadOutcomeRuntime(database, {
      access: {
        authorizeRead: async () => ({ actor: seller }),
        authorizeWrite: async () => ({ actor: seller }),
      },
      noteEnvelopeKey: NOTE_KEY,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => clock,
    });
    /** @param {string} id @param {string} outcome */
    const record = async (id, outcome) =>
      leads.record({
        actor: seller,
        conversationId: id,
        body: {
          outcome,
          ...(outcome === 'lost' ? { reasonCode: 'preco' } : {}),
          expectedConversationVersion: await conversationVersion(id),
          expectedOutcomeVersion: await outcomeVersion(id),
        },
        idempotencyKey: `lead-${randomUUID()}`,
        correlationId: `correlation-${runId}`,
      });
    const lose = (/** @type {string} */ id) => record(id, 'lost');
    const orders = new PostgresOrderRepository({
      database,
      envelopeKey: ORDER_KEY,
    });

    // An active pending or confirmed order blocks; cancelling it frees the loss.
    for (const confirmed of [false, true]) {
      const id = await conversation();
      const orderId = await order(id, confirmed);
      await assert.rejects(lose(id), { code: 'LEAD_HAS_ORDER' });
      await cancel(orderId);
      const lost = await lose(id);
      assert.equal(lost.outcome, 'lost');
      assert.equal(lost.outcomeVersion, 1);
      // The cancelled order is history, still readable by id with its status.
      const found = await orders.findById(orderId);
      assert.equal(found?.status, confirmed ? 'confirmado' : 'pendente');
      assert.ok(found?.cancelledAt);
      assert.equal(found?.conversationId, id);
      // The loss can be reopened as usual.
      assert.equal((await record(id, 'reopened')).outcome, 'reopened');
    }

    // A cancelled order beside a replacement that is active still blocks.
    const replaced = await conversation();
    const first = await order(replaced, false);
    await cancel(first);
    await order(replaced, false);
    await assert.rejects(lose(replaced), { code: 'LEAD_HAS_ORDER' });
    const confirmedReplacement = await conversation();
    await cancel(await order(confirmedReplacement, true));
    await order(confirmedReplacement, true);
    await assert.rejects(lose(confirmedReplacement), {
      code: 'LEAD_HAS_ORDER',
    });
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) AS n FROM crm.lead_outcome_events
             WHERE conversation_id = ANY($1::text[])`,
            [[replaced, confirmedReplacement]],
          )
        ).rows[0].n,
      ),
      0,
    );
  },
);
