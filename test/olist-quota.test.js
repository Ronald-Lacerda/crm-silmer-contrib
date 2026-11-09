import assert from 'node:assert/strict';
import test from 'node:test';
import { createOlistClient } from '../modules/olist/src/client.js';
import {
  createOlistQuota,
  olistReadWait,
  OLIST_READ_WAIT,
  OLIST_WRITE_READBACKS,
} from '../modules/olist/src/quota.js';

const ACCOUNT = 'a'.repeat(64);
const T0 = Date.parse('2026-11-05T12:00:00.000Z');

/** In-memory model of the single `crm.olist_quotas` row and of the exact
 * statements the quota issues. Time is the model's clock: it moves only when a
 * test (or the injected sleep) moves it, so nothing here really waits.
 * @param {{used?:number,remaining?:number|null,windowAgeMs?:number,blockedForMs?:number|null}} [initial] */
function model(initial = {}) {
  const state = {
    now: T0,
    windowStart: T0 - (initial.windowAgeMs ?? 0),
    used: initial.used ?? 0,
    remaining: initial.remaining ?? null,
    blockedUntil:
      initial.blockedForMs === undefined || initial.blockedForMs === null
        ? null
        : T0 + initial.blockedForMs,
    inTransaction: false,
    transactions: 0,
    sleeps: /** @type {number[]} */ ([]),
    beats: 0,
  };
  /** @param {string} sql @param {any[]} values */
  async function query(sql, values) {
    if (/pg_advisory_xact_lock/u.test(sql)) return { rows: [] };
    if (/^INSERT INTO crm\.olist_quotas/u.test(sql)) return { rows: [] };
    if (/^SELECT \*,now\(\)/u.test(sql))
      return {
        rows: [
          {
            database_now: new Date(state.now),
            window_started_at: new Date(state.windowStart),
            used: state.used,
            remaining: state.remaining,
            blocked_until:
              state.blockedUntil === null ? null : new Date(state.blockedUntil),
          },
        ],
      };
    if (/^UPDATE crm\.olist_quotas SET window_started_at/u.test(sql)) {
      state.windowStart = new Date(values[1]).getTime();
      state.used = values[2];
      state.remaining = values[3];
      return { rows: [] };
    }
    if (/SET remaining=LEAST/u.test(sql)) {
      state.remaining = Math.min(state.remaining ?? values[1], values[1]);
      return { rows: [] };
    }
    if (/SET blocked_until/u.test(sql)) {
      state.blockedUntil = Math.max(
        state.blockedUntil ?? state.now,
        state.now + values[1],
      );
      return { rows: [] };
    }
    throw new Error('unexpected SQL: ' + sql);
  }
  const database = {
    query,
    /** @param {(client:any)=>Promise<any>} work */
    async transaction(work) {
      assert.equal(state.inTransaction, false, 'no nested transaction');
      state.inTransaction = true;
      state.transactions += 1;
      try {
        return await work({ query });
      } finally {
        state.inTransaction = false;
      }
    },
  };
  /** The sleep that advances the model clock and proves no SQL transaction is
   * open while a read waits.
   * @param {()=>void} [onSleep] */
  const sleep = (onSleep) => async (/** @type {number} */ ms) => {
    assert.equal(
      state.inTransaction,
      false,
      'a wait must never hold an open SQL transaction',
    );
    state.sleeps.push(ms);
    state.now += ms;
    onSleep?.();
  };
  return { state, database, sleep };
}
const quotaOf = (/** @type {ReturnType<typeof model>} */ m, limit = 30) =>
  createOlistQuota(m.database, ACCOUNT, limit);

test('reserve keeps its contract: no wait, 429 code, retryAfterMs attached', async () => {
  const m = model({ used: 30, windowAgeMs: 20_000 });
  await assert.rejects(quotaOf(m).reserve(), (error) => {
    const value = /** @type {any} */ (error);
    assert.equal(value.code, 'OLIST_RATE_LIMITED');
    assert.equal(value.statusCode, 429);
    assert.equal(value.retryAfterMs, 40_000);
    return true;
  });
  assert.deepEqual(m.state.sleeps, []);
  assert.equal(m.state.used, 30, 'a refused reserve consumes nothing');
  const open = model({ used: 29 });
  await quotaOf(open).reserve();
  assert.equal(open.state.used, 30);
});

test('reserve honours an active block and reports the block as the wait', async () => {
  const m = model({ blockedForMs: 12_345 });
  await assert.rejects(quotaOf(m).reserve(), {
    code: 'OLIST_RATE_LIMITED',
    retryAfterMs: 12_345,
  });
  assert.equal(m.state.used, 0);
});

test('reserve treats upstream remaining=0 as exhausted until the window ends', async () => {
  const m = model({ used: 3, remaining: 0, windowAgeMs: 45_000 });
  await assert.rejects(quotaOf(m).reserve(), {
    code: 'OLIST_RATE_LIMITED',
    retryAfterMs: 15_000,
  });
});

test('attempt: minimum wait, fresh window reset and caller ceiling can only lower the limit', async () => {
  const m = model({ used: 30, windowAgeMs: 59_900 });
  assert.deepEqual(await quotaOf(m).attempt({ cost: 1 }), {
    ok: false,
    waitMs: 250,
  });
  m.state.now += 200;
  assert.deepEqual(await quotaOf(m).attempt({ cost: 1 }), { ok: true });
  assert.equal(m.state.used, 1);
  assert.equal(m.state.remaining, null);
  const over = model({ used: 30 });
  const refused = await quotaOf(over).attempt({ cost: 1, ceiling: 1000 });
  assert.equal(refused.ok, false, 'the account limit of 30 is never raised');
  for (const bad of [
    { cost: 0 },
    { cost: 1.5 },
    { headroom: -1 },
    { ceiling: 0 },
  ])
    await assert.rejects(quotaOf(model()).attempt(bad), {
      code: 'INVALID_REQUEST',
    });
});

test('reserveWrite never waits and requires headroom for its readbacks', async () => {
  // used+1+readbacks<=30
  const edge = model({ used: 26 });
  await quotaOf(edge).reserveWrite({ readbacks: 3 });
  assert.equal(edge.state.used, 27, 'only the POST unit is consumed');
  const short = model({ used: 27 });
  await assert.rejects(quotaOf(short).reserveWrite({ readbacks: 3 }), {
    code: 'OLIST_RATE_LIMITED',
  });
  assert.equal(short.state.used, 27, 'a refused write consumes nothing');
  // remaining>=1+readbacks
  const upstream = model({ used: 1, remaining: 3 });
  await assert.rejects(quotaOf(upstream).reserveWrite({ readbacks: 3 }), {
    code: 'OLIST_RATE_LIMITED',
  });
  upstream.state.remaining = 4;
  await quotaOf(upstream).reserveWrite({ readbacks: 3 });
  assert.equal(upstream.state.remaining, 3);
  // a read-sized unit still fits where the write does not
  await quotaOf(short).reserve();
  assert.equal(short.state.used, 28);
  assert.deepEqual(short.state.sleeps, []);
  // blocked: no write either, and no wait
  const blocked = model({ blockedForMs: 5_000 });
  await assert.rejects(quotaOf(blocked).reserveWrite({ readbacks: 2 }), {
    code: 'OLIST_RATE_LIMITED',
    retryAfterMs: 5_000,
  });
  assert.deepEqual(blocked.state.sleeps, []);
  for (const readbacks of [-1, 11, 1.5, Number.NaN])
    await assert.rejects(quotaOf(model()).reserveWrite({ readbacks }), {
      code: 'INVALID_REQUEST',
    });
  assert.deepEqual(OLIST_WRITE_READBACKS, {
    customer: 2,
    product: 2,
    variation: 3,
    sale: 2,
  });
});

test('reserveRead waits until blocked_until in <=10 s slices, beating each slice, outside any transaction', async () => {
  const m = model({ blockedForMs: 25_000 });
  const beats = /** @type {number[]} */ ([]);
  const result = await quotaOf(m).reserveRead({
    maxWaitMs: 90_000,
    beat: async () => {
      beats.push(m.state.now - T0);
    },
    sleep: m.sleep(),
    random: () => 0,
  });
  assert.deepEqual(m.state.sleeps, [10_000, 10_000, 5_000]);
  assert.deepEqual(beats, [0, 10_000, 20_000]);
  assert.equal(result.waitedMs, 25_000);
  assert.equal(m.state.used, 1);
});

test('reserveRead jitter stays bounded and the slice never exceeds 10 s plus jitter', async () => {
  const m = model({ blockedForMs: 30_000 });
  await quotaOf(m).reserveRead({
    maxWaitMs: 90_000,
    sleep: m.sleep(),
    random: () => 0.999,
  });
  for (const slice of m.state.sleeps) assert.ok(slice <= 10_250, String(slice));
  assert.ok(m.state.sleeps.length >= 3);
});

test('reserveRead waits for the end of an exhausted window and then reserves', async () => {
  const m = model({ used: 30, windowAgeMs: 10_000 });
  const result = await quotaOf(m).reserveRead({
    maxWaitMs: 90_000,
    sleep: m.sleep(),
    random: () => 0,
  });
  assert.equal(result.waitedMs, 50_000);
  assert.equal(m.state.used, 1, 'the next window starts with this unit');
});

test('reserveRead respects maxWaitMs: a wait that cannot fit fails at once with retryAfterMs', async () => {
  const api = model({ blockedForMs: 60_000 });
  await assert.rejects(
    quotaOf(api).reserveRead({
      ...OLIST_READ_WAIT.api,
      sleep: api.sleep(),
    }),
    { code: 'OLIST_RATE_LIMITED', statusCode: 429, retryAfterMs: 60_000 },
  );
  assert.deepEqual(api.state.sleeps, [], 'no useless wait before failing');
  assert.equal(api.state.used, 0);
  const fits = model({ blockedForMs: 5_000 });
  await quotaOf(fits).reserveRead({
    ...OLIST_READ_WAIT.api,
    sleep: fits.sleep(),
  });
  assert.equal(fits.state.used, 1);
  // a block that grows while waiting is re-evaluated on every slice
  const grows = model({ blockedForMs: 5_000 });
  await assert.rejects(
    quotaOf(grows).reserveRead({
      maxWaitMs: 8_000,
      random: () => 0,
      sleep: grows.sleep(() => {
        grows.state.blockedUntil = grows.state.now + 600_000;
      }),
    }),
    { code: 'OLIST_RATE_LIMITED', retryAfterMs: 600_000 },
  );
  assert.equal(grows.state.sleeps.length, 1);
  const zero = model({ blockedForMs: 1_000 });
  await assert.rejects(
    quotaOf(zero).reserveRead({ maxWaitMs: 0, sleep: zero.sleep() }),
    { code: 'OLIST_RATE_LIMITED' },
  );
});

test('reserveRead on the API profile stops at 24/30 so six units stay with the worker', async () => {
  const m = model({ used: 24 });
  await assert.rejects(
    quotaOf(m).reserveRead({ ...OLIST_READ_WAIT.api, sleep: m.sleep() }),
    { code: 'OLIST_RATE_LIMITED' },
  );
  assert.equal(m.state.used, 24);
  // the worker profile still takes the reserved units
  await quotaOf(m).reserveRead({ ...OLIST_READ_WAIT.worker, sleep: m.sleep() });
  assert.equal(m.state.used, 25);
});

test('reserveRead beat returning false aborts the wait as a lost lease and never consumes quota', async () => {
  const m = model({ blockedForMs: 20_000 });
  await assert.rejects(
    quotaOf(m).reserveRead({
      maxWaitMs: 90_000,
      beat: async () => false,
      sleep: m.sleep(),
    }),
    { code: 'OLIST_JOB_LEASE_LOST' },
  );
  assert.deepEqual(m.state.sleeps, []);
  assert.equal(m.state.used, 0);
  const throws = model({ blockedForMs: 20_000 });
  await assert.rejects(
    quotaOf(throws).reserveRead({
      maxWaitMs: 90_000,
      beat: async () => {
        throw Object.assign(new Error('x'), { code: 'OLIST_JOB_LEASE_LOST' });
      },
      sleep: throws.sleep(),
    }),
    { code: 'OLIST_JOB_LEASE_LOST' },
  );
});

test('observe never raises remaining and block keeps the longest block', async () => {
  const m = model({ remaining: 5 });
  const quota = quotaOf(m);
  await quota.observe(new globalThis.Headers({ 'x-ratelimit-remaining': '9' }));
  assert.equal(m.state.remaining, 5);
  await quota.observe(new globalThis.Headers({ 'x-ratelimit-remaining': '2' }));
  assert.equal(m.state.remaining, 2);
  await quota.observe(new globalThis.Headers({ 'x-ratelimit-remaining': 'x' }));
  assert.equal(m.state.remaining, 2);
  await quota.block(30_000);
  await quota.block(10_000);
  assert.equal(m.state.blockedUntil, T0 + 30_000);
  await quota.block(1);
  assert.equal(
    m.state.blockedUntil,
    T0 + 30_000,
    'floor of 1 s, never shorter',
  );
  // a Retry-After block is respected by a read that cannot wait that long
  await assert.rejects(
    quota.reserveRead({ maxWaitMs: 8_000, sleep: m.sleep() }),
    { code: 'OLIST_RATE_LIMITED', retryAfterMs: 30_000 },
  );
});

test('wait profiles are named, frozen and match the approved limits', () => {
  assert.deepEqual(OLIST_READ_WAIT.worker, { maxWaitMs: 90_000, ceiling: 30 });
  assert.deepEqual(OLIST_READ_WAIT.patient, {
    maxWaitMs: 180_000,
    ceiling: 30,
  });
  assert.deepEqual(OLIST_READ_WAIT.api, {
    maxWaitMs: 8_000,
    ceiling: 24,
    cumulative: true,
  });
  assert.deepEqual(OLIST_READ_WAIT.verify, { maxWaitMs: 15_000, ceiling: 30 });
  assert.ok(
    Object.isFrozen(OLIST_READ_WAIT) && Object.isFrozen(OLIST_READ_WAIT.api),
  );
  const beat = async () => {};
  assert.deepEqual(olistReadWait('worker', { beat }), {
    maxWaitMs: 90_000,
    patientMaxWaitMs: 180_000,
    ceiling: 30,
    beat,
  });
  assert.deepEqual(olistReadWait('api'), {
    maxWaitMs: 8_000,
    patientMaxWaitMs: 180_000,
    ceiling: 24,
    cumulative: true,
  });
  assert.throws(() => olistReadWait(/** @type {any} */ ('x')), {
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => createOlistQuota({}, 'bad'), {
    code: 'OLIST_NOT_CONFIGURED',
  });
  assert.throws(() => createOlistQuota({}, ACCOUNT, 61), {
    code: 'OLIST_NOT_CONFIGURED',
  });
});

/** A client on the real quota + the in-memory model. Before every fetch the
 * model is blocked for `blockMs`, so the NEXT read has to wait that long.
 * @param {ReturnType<typeof model>} m @param {any} readWait @param {number} blockMs */
function clientWithBlockedReads(m, readWait, blockMs) {
  return createOlistClient({
    credentials: async () => ({ token: 'synthetic-access-token', version: 1 }),
    quota: quotaOf(m),
    readWait,
    fetch: async () => {
      m.state.blockedUntil = m.state.now + blockMs;
      return new globalThis.Response(JSON.stringify({ company: 'Synthetic' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('the API 8 s is one budget for all the reads of a request: three 3 s waits overrun it', async () => {
  const m = model({ blockedForMs: 3_000 });
  const client = clientWithBlockedReads(
    m,
    { ...olistReadWait('api'), sleep: m.sleep() },
    3_000,
  );
  await client.info();
  await client.info();
  const waitedBeforeThird = m.state.sleeps.reduce((a, b) => a + b, 0);
  assert.equal(m.state.sleeps.length, 2);
  assert.ok(waitedBeforeThird >= 6_000 && waitedBeforeThird < 8_000);
  // 3 s more cannot fit in what is left of the 8 s: it fails at once, with the
  // real wait as retryAfterMs, and without sleeping the remainder uselessly.
  await assert.rejects(client.info(), (error) => {
    const value = /** @type {any} */ (error);
    assert.equal(value.code, 'OLIST_RATE_LIMITED');
    assert.equal(value.statusCode, 429);
    assert.ok(value.retryAfterMs >= 250 && value.retryAfterMs <= 3_000);
    return true;
  });
  assert.equal(m.state.sleeps.length, 2, 'no sleep for the refused read');
});

test('the API budget belongs to one client: a new request starts with the full 8 s', async () => {
  const m = model({ blockedForMs: 3_000 });
  const first = clientWithBlockedReads(
    m,
    { ...olistReadWait('api'), sleep: m.sleep() },
    3_000,
  );
  await first.info();
  await first.info();
  await assert.rejects(first.info(), { code: 'OLIST_RATE_LIMITED' });
  m.state.blockedUntil = m.state.now + 3_000;
  const second = clientWithBlockedReads(
    m,
    { ...olistReadWait('api'), sleep: m.sleep() },
    3_000,
  );
  await second.info();
  await second.info();
});

test('the worker profile stays per read: the same three 3 s waits all succeed', async () => {
  const m = model({ blockedForMs: 3_000 });
  const client = clientWithBlockedReads(
    m,
    { ...olistReadWait('worker'), sleep: m.sleep() },
    3_000,
  );
  await client.info();
  await client.info();
  await client.info();
  assert.equal(m.state.sleeps.length, 3);
});
