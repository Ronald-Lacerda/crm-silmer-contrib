import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createDashboardCheckpointRuntime } from '../apps/api/src/dashboard-checkpoint-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
test(
  'CHK PostgreSQL: concurrent immutable snapshot, independent destinations and single transport permission',
  { skip: !connectionString },
  async (t) => {
    assert.match(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 8 });
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const now = new Date('2026-11-05T11:00:00Z');
    const technical = {
      actor: { id: 'AUTOMATION_EXECUTOR', kind: 'AUTOMATION_EXECUTOR' },
    };
    const environment = {
      DAILY_CHECKPOINT_ENABLED: 'true',
      IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 81).toString('base64'),
      DAILY_CHECKPOINT_RECIPIENTS_JSON: JSON.stringify([
        { id: 'partner-a', label: 'Sócio sintético A', phone: '+15555550101' },
        { id: 'partner-b', label: 'Sócio sintético B', phone: '+15555550102' },
      ]),
    };
    let sold = 50000;
    let reads = 0;
    const readPerformance = async () => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        from: '2026-11-04',
        to: '2026-11-04',
        scope: 'team',
        timeZone: 'America/Sao_Paulo',
        totals: { soldAmountCents: sold, confirmedCount: 1 },
        rows: [],
        store: { soldAmountCents: 0, confirmedCount: 0 },
        unattributed: { soldAmountCents: 0, confirmedCount: 0 },
        coverage: {
          basis: 'owner_captured_at_confirmation',
          historicalAttribution: 'unattributed_without_evidence',
          unattributedConfirmedCount: 0,
        },
      };
    };
    const options = {
      access: {},
      environment,
      clock: () => now,
      readPerformance,
    };
    const runtime = createDashboardCheckpointRuntime(database, options);
    const command = { technical, correlationId: 'checkpoint-synthetic' };
    await assert.rejects(
      runtime.prepare({
        ...command,
        technical: { actor: { id: 'human', kind: 'human' } },
      }),
      { code: 'FORBIDDEN' },
    );
    for (const day of ['2026-11-05', '2026-10-28', '2026-02-30'])
      await assert.rejects(runtime.prepare({ ...command, day }), {
        code: 'INVALID_CHECKPOINT_DAY',
      });
    const prepared = await Promise.all([
      runtime.prepare(command),
      runtime.prepare(command),
    ]);
    assert.equal(prepared[0].checkpointId, prepared[1].checkpointId);
    const checkpointId = prepared[0].checkpointId;
    const snapshot = (
      await pool.query('SELECT * FROM crm.dashboard_checkpoint_snapshots')
    ).rows;
    assert.equal(snapshot.length, 1);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /1555555010|Sócio sintético|Vendido/u);
    await assert.rejects(
      pool.query(
        'UPDATE crm.dashboard_checkpoint_snapshots SET sold_amount_cents=1 WHERE id=$1',
        [checkpointId],
      ),
      { code: '23514' },
    );
    sold = 99999;
    const readsBeforeReplay = reads;
    await runtime.prepare(command);
    assert.equal(reads, readsBeforeReplay, 'replay uses frozen report');
    const reservations = await Promise.all(
      [1, 2].map(() =>
        runtime.reserve({ ...command, checkpointId, recipientId: 'partner-a' }),
      ),
    );
    assert.equal(reservations.filter((r) => r.authorized).length, 1);
    const first = reservations.find((r) => r.authorized);
    assert.match(first.text, /500,00/u);
    assert.doesNotMatch(first.text, /999,99/u);
    const second = await runtime.reserve({
      ...command,
      checkpointId,
      recipientId: 'partner-b',
    });
    assert.equal(second.authorized, true);
    assert.notEqual(first.phone, second.phone);
    const accepted = {
      ...command,
      checkpointId,
      recipientId: 'partner-a',
      reservationId: first.reservationId,
      status: 'sent',
      code: 'PROVIDER_ACCEPTED',
      providerMessageId: 'synthetic-provider-a',
    };
    assert.deepEqual(await runtime.complete(accepted), {
      recorded: true,
      status: 'sent',
    });
    assert.deepEqual(await runtime.complete(accepted), {
      recorded: false,
      status: 'sent',
    });
    await assert.rejects(
      runtime.complete({ ...accepted, providerMessageId: ' ' }),
      { code: 'INVALID_REQUEST' },
    );
    const unknown = {
      ...command,
      checkpointId,
      recipientId: 'partner-b',
      reservationId: second.reservationId,
      status: 'outcome_unknown',
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    };
    await runtime.complete(unknown);
    assert.equal(
      (
        await runtime.reserve({
          ...command,
          checkpointId,
          recipientId: 'partner-b',
        })
      ).authorized,
      false,
    );
    await assert.rejects(
      runtime.complete({
        ...unknown,
        status: 'sent',
        code: 'PROVIDER_ACCEPTED',
        providerMessageId: 'synthetic-provider-b',
      }),
      { code: 'CHECKPOINT_RESULT_CONFLICT' },
    );
    await runtime.complete({
      ...unknown,
      status: 'sent',
      code: 'PROVIDER_ACCEPTED',
      providerMessageId: 'synthetic-provider-b',
      reconciled: true,
    });
    await assert.rejects(
      pool.query(
        'UPDATE crm.dashboard_checkpoint_deliveries SET result_code=NULL WHERE checkpoint_id=$1',
        [checkpointId],
      ),
      { code: '23514' },
    );
    const disabled = createDashboardCheckpointRuntime(database, {
      ...options,
      environment: { ...environment, DAILY_CHECKPOINT_ENABLED: 'false' },
    });
    await assert.rejects(disabled.prepare(command), {
      code: 'CHECKPOINT_DISABLED',
    });
    assert.equal(
      (await disabled.complete(accepted)).recorded,
      false,
      'record/reconcile in-flight outcome remains possible while disabled',
    );
    const changed = createDashboardCheckpointRuntime(database, {
      ...options,
      environment: {
        ...environment,
        DAILY_CHECKPOINT_RECIPIENTS_JSON:
          environment.DAILY_CHECKPOINT_RECIPIENTS_JSON.replace(
            '15555550101',
            '15555550103',
          ),
      },
    });
    await assert.rejects(
      changed.reserve({ ...command, checkpointId, recipientId: 'partner-a' }),
      { code: 'CHECKPOINT_RECIPIENT_CHANGED' },
    );
    const admin = { id: 'checkpoint-admin', kind: 'human' };
    const seller = { id: 'checkpoint-seller', kind: 'human' };
    for (const actor of [admin, seller]) {
      await pool.query(
        "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic','Usuário sintético')",
        [actor.id, actor.id + '@example.test'],
      );
      await pool.query(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
        [actor.id],
      );
    }
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
      [admin.id],
    );
    await assert.rejects(runtime.preview({ actor: seller }));
    const preview = await runtime.preview({ actor: admin });
    assert.equal(preview.snapshot, true);
    assert.equal(preview.totals.soldAmountCents, 50000);
    assert.equal(
      preview.recipients.every((/** @type {any} */ r) => r.status === 'sent'),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(preview),
      /1555555010|fingerprint|ciphertext/u,
    );
    const audit = JSON.stringify(
      (await pool.query('SELECT * FROM crm.audit_events')).rows,
    );
    assert.doesNotMatch(audit, /1555555010|Sócio sintético|Resumo comercial/u);
  },
);
