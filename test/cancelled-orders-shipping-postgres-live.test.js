import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createConversationShippingRuntime } from '../apps/api/src/conversation-shipping-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';

// OLIST-45/46, ADR 068: freight can be quoted or selected only for an active
// order of the conversation. A cancelled order refuses with 409 ORDER_CANCELLED
// before any provider call, while its stored quote stays readable by order id.
const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-08T12:00:00Z');
const KEY = Buffer.alloc(32, 93);
const SELLER = { id: 'cancelled-shipping-seller', kind: 'human' };
const PACKAGE = {
  fromPostalCode: '01001000',
  toPostalCode: '20040020',
  weightGrams: 800,
  widthCm: 15,
  heightCm: 10,
  lengthCm: 20,
  insuranceValueCents: 10000,
};

if (!connectionString) {
  test(
    'Cancelled order shipping PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(
    new URL(connectionString).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    'Only a dedicated synthetic database may be reset',
  );
  const pool = new Pool({ connectionString, max: 6 });
  const database = {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
  let calculations = 0;
  const runtime = createConversationShippingRuntime(database, {
    key: KEY,
    clock: () => NOW,
    requireConfigured: () => {},
    contextKey: 'synthetic-context',
    environment: 'sandbox',
    calculate: async () => {
      calculations += 1;
      return {
        services: [
          {
            id: 1,
            name: 'PAC',
            company: 'Correios',
            priceCents: 2250,
            deliveryDays: 5,
          },
        ],
        unavailable: [],
      };
    },
  });
  let sequence = 0;

  /** A conversation owned by the seller, one pending order and its subject. */
  async function seed() {
    sequence += 1;
    const key = `cancelled-shipping-${sequence}`;
    const ids = {
      contact: `${key}-contact`,
      identity: `${key}-identity`,
      conversation: `${key}-conversation`,
      order: `${key}-order`,
      subject: `${key}-subject`,
    };
    await pool.query(
      'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES ($1,$2,$2)',
      [ids.contact, NOW],
    );
    await pool.query(
      `INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,created_at,updated_at)
      VALUES ($1,$2,'meta','synthetic-shipping','whatsapp',$3,'phone','confirmed',$4::jsonb,$5,$5)`,
      [
        ids.identity,
        ids.contact,
        String(sequence).padStart(64, 'e'),
        JSON.stringify(encryptJson({ phone: 'synthetic' }, ids.identity, KEY)),
        NOW,
      ],
    );
    await pool.query(
      `INSERT INTO crm.conversations(id,contact_identity_id,provider,provider_account_id,external_conversation_id,cycle_number,assigned_user_id,automation_state,opened_at,last_message_at)
      VALUES ($1,$2,'meta','synthetic-shipping',$1,1,$3,'human',$4,$4)`,
      [ids.conversation, ids.identity, SELLER.id, NOW],
    );
    await pool.query(
      `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,status,fab_code,ficha_envelope,total_pieces,created_by_kind,created_by,created_at,updated_at)
      VALUES ($1,nextval('crm.order_number_seq'),$2,$3,$4,'pendente','01','{}'::jsonb,4,'user',$5,$6,$6)`,
      [
        ids.order,
        `${String(sequence).padStart(2, '0')}-CRM`,
        ids.conversation,
        ids.contact,
        SELLER.id,
        NOW,
      ],
    );
    await pool.query(
      `INSERT INTO crm.conversation_subjects(id,conversation_id,contact_id,order_id,kind,position,created_by,created_by_kind,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'pedido',1,$5,'human',$6,$6)`,
      [ids.subject, ids.conversation, ids.contact, ids.order, SELLER.id, NOW],
    );
    return ids;
  }

  /** @param {string} orderId */
  async function cancel(orderId) {
    await pool.query(
      `UPDATE crm.orders SET cancelled_at=$2,cancelled_by=$3,cancellation_reason_envelope=$4::jsonb,version=version+1,updated_at=$2 WHERE id=$1`,
      [
        orderId,
        NOW,
        SELLER.id,
        JSON.stringify(
          encryptJson('Motivo sintético', `order-cancellation:${orderId}`, KEY),
        ),
      ],
    );
  }

  /** @param {any} ids @param {number} version @param {string} key */
  function quoteInput(ids, version, key) {
    return {
      actor: SELLER,
      conversationId: ids.conversation,
      correlationId: 'synthetic-cancelled-shipping',
      idempotencyKey: key,
      body: {
        subjectId: ids.subject,
        orderId: ids.order,
        orderVersion: version,
        ...PACKAGE,
      },
    };
  }

  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      "INSERT INTO crm.users(id,email,password_hash,name) VALUES ($1,$2,'$argon2id$synthetic','Pessoa sintética')",
      [SELLER.id, `${SELLER.id}@example.test`],
    );
    await pool.query(
      "INSERT INTO crm.user_functions(user_id,function_name) VALUES ($1,'Vendedor')",
      [SELLER.id],
    );
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });

  test('an active order is quoted and selected; after cancellation both are refused with 409 ORDER_CANCELLED and the stored quote stays readable', async () => {
    const ids = await seed();
    const { quote } = await runtime.quote(quoteInput(ids, 1, 'active-quote'));
    assert.equal(quote.orderId, ids.order);
    assert.equal(quote.services[0].priceCents, 2250);
    assert.equal(calculations > 0, true);
    const selected = await runtime.select({
      ...quoteInput(ids, 1, 'active-select'),
      quoteId: quote.id,
      body: {
        subjectId: ids.subject,
        orderId: ids.order,
        orderVersion: 1,
        serviceId: 1,
      },
    });
    assert.equal(selected.quote.selectedServiceId, 1);

    await cancel(ids.order);
    const rejected = { statusCode: 409, code: 'ORDER_CANCELLED' };
    const calls = calculations;
    // Both the fresh version and the stale one are refused as cancelled.
    await assert.rejects(
      runtime.quote(quoteInput(ids, 2, 'cancelled-quote')),
      rejected,
    );
    await assert.rejects(
      runtime.quote(quoteInput(ids, 1, 'cancelled-quote-stale')),
      rejected,
    );
    await assert.rejects(
      runtime.select({
        ...quoteInput(ids, 2, 'cancelled-select'),
        quoteId: quote.id,
        body: {
          subjectId: ids.subject,
          orderId: ids.order,
          orderVersion: 2,
          serviceId: 1,
        },
      }),
      rejected,
    );
    assert.equal(calculations, calls, 'the provider is never contacted');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS n FROM crm.shipping_quotes WHERE order_id=$1',
          [ids.order],
        )
      ).rows[0].n,
      1,
    );

    // History by order id is untouched: quote and its selection stay visible.
    const read = await runtime.read({ actor: SELLER, orderId: ids.order });
    assert.equal(read.quote.id, quote.id);
    assert.equal(read.quote.selectedServiceId, 1);
  });

  test('a cancelled order that never had a quote still answers the read with no quote, and a new quote is refused', async () => {
    const ids = await seed();
    await cancel(ids.order);
    const read = await runtime.read({ actor: SELLER, orderId: ids.order });
    assert.equal(read.quote, null);
    await assert.rejects(runtime.quote(quoteInput(ids, 2, 'never-quoted')), {
      statusCode: 409,
      code: 'ORDER_CANCELLED',
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS n FROM crm.shipping_quotes WHERE order_id=$1',
          [ids.order],
        )
      ).rows[0].n,
      0,
    );
  });
}
