import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { createStoreOrderCorrectionService } from '../modules/orders/src/application/store-order-correction-service.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import { otherStoreOrderBody, STORE_NOW } from './fixtures/store-order.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString) {
  assert.match(
    new URL(connectionString).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
  );
  const pool = new Pool({ connectionString, max: 5 });
  const database = {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
  const repository = new PostgresOrderRepository({
    database,
    envelopeKey: Buffer.alloc(32, 61),
  });
  const store = createStoreOrderService({
    repository,
    fabCode: '01',
    hmacKey: Buffer.alloc(32, 27),
    acceptTest: false,
    clock: () => STORE_NOW,
  });
  const service = createStoreOrderCorrectionService({
    repository,
    clock: () => STORE_NOW,
  });
  const actor = {
    id: 'repair-admin-synthetic',
    kind: 'human',
    capabilities: ['COMMERCIAL_ADMIN'],
  };
  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,'repair@example.invalid','$argon2id$synthetic-only','Repair Synthetic')",
      [actor.id],
    );
    await pool.query(
      "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
      [actor.id],
    );
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
      [actor.id],
    );
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });
  /** @param {number} index */
  async function seed(index) {
    const body = otherStoreOrderBody(index, (body) => {
      body.produto.slug = 'bloquinho-22-completa';
      body.item = {
        cor_id: 'verde-amarela',
        prazo_dias: 1,
        quantidade: 1,
        tamanho_id: 'm',
      };
      body.valor_centavos = 4500;
      body.pagamento.valor_pago_centavos = 9000;
    });
    const record = store.parse(body);
    const { order } = await store.record({
      record,
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `seed-${index}`,
    });
    const receipt = (
      await pool.query(
        'SELECT * FROM crm.store_order_receipts WHERE order_id=$1',
        [order.id],
      )
    ).rows[0];
    const command = {
      actor,
      orderId: order.id,
      expectedVersion: order.version,
      expectedQuantity: 1,
      expectedAmountCents: 4500,
      quantity: 2,
      reason: 'USER_CONFIRMED_QUANTITY',
      idempotencyKey: `repair-${index}`,
      correlationId: `repair-${index}`,
    };
    return { record, order, command, receipt };
  }
  test('LOJ-39/40 live: row lock serializes repair, preserves lastro, and replay has one effect', async () => {
    const { record, order, command, receipt } = await seed(501);
    const [first, second] = await Promise.all([
      service.correct(command),
      service.correct(command),
    ]);
    assert.equal(first.totalPieces, 2);
    assert.equal(first.finalAmountCents, 9000);
    assert.equal(second.version, order.version + 1);
    assert.equal((await service.correct(command)).version, first.version);
    assert.deepEqual(first.gatewayPayment, order.gatewayPayment);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT * FROM crm.store_order_receipts WHERE order_id=$1',
          [order.id],
        )
      ).rows[0],
      receipt,
    );
    const replay = await store.record({
      record,
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: 'old-replay',
    });
    assert.equal(replay.order.totalPieces, 2);
    const audits = await pool.query(
      "SELECT reason FROM crm.audit_events WHERE target_id=$1 AND action='store.order.quantity_corrected'",
      [order.id],
    );
    assert.equal(audits.rows.length, 1);
    assert.match(
      audits.rows[0].reason,
      /^USER_CONFIRMED_QUANTITY:[a-f0-9]{64}$/u,
    );
    await assert.rejects(
      service.correct({ ...command, idempotencyKey: 'different' }),
      { code: 'VERSION_CONFLICT' },
    );
  });
  test('LOJ-41 live: revoked admin is checked inside the write transaction', async () => {
    const { order, command } = await seed(502);
    await pool.query(
      "DELETE FROM crm.user_capabilities WHERE user_id=$1 AND capability='COMMERCIAL_ADMIN'",
      [actor.id],
    );
    await assert.rejects(service.correct(command), { code: 'FORBIDDEN' });
    assert.deepEqual(await repository.findById(order.id), order);
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
      [actor.id],
    );
  });
  test('LOJ-41 live: audit failure rolls back quantity, amount, envelope and event', async () => {
    const { order, command, receipt } = await seed(503);
    await pool.query(
      `CREATE FUNCTION crm.reject_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'store.order.quantity_corrected' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER synthetic_repair_audit BEFORE INSERT ON crm.audit_events FOR EACH ROW EXECUTE FUNCTION crm.reject_repair_audit()',
    );
    try {
      await assert.rejects(
        service.correct(command),
        /synthetic audit failure/u,
      );
      assert.deepEqual(await repository.findById(order.id), order);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT * FROM crm.store_order_receipts WHERE order_id=$1',
            [order.id],
          )
        ).rows[0],
        receipt,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM crm.domain_events WHERE aggregate_id=$1 AND event_type='order.store_corrected'",
            [order.id],
          )
        ).rows.length,
        0,
      );
    } finally {
      await pool.query(
        'DROP TRIGGER synthetic_repair_audit ON crm.audit_events',
      );
      await pool.query('DROP FUNCTION crm.reject_repair_audit()');
    }
    assert.equal((await service.correct(command)).totalPieces, 2);
  });
} else {
  test(
    'store correction PostgreSQL live requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
}
