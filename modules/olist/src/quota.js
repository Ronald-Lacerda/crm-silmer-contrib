import { OlistError } from './errors.js';

/** Provider window: 30 calls per rolling 60 s per account. Never raised. */
export const OLIST_QUOTA_LIMIT = 30;
const WINDOW_MS = 60_000;
/** Smallest wait ever reported, so callers never spin on a sub-tick answer. */
const MIN_WAIT_MS = 250;
/** Longest uninterrupted sleep: shorter than the 30 s job lease, and every
 * slice calls `beat()` so a waiting worker keeps its lease alive. */
export const OLIST_WAIT_SLICE_MS = 10_000;
const JITTER_MS = 250;

/** Reads that a successful POST obliges the caller to issue afterwards
 * (customer: confirm + detail; product: parent + children; variation: parent
 * re-read + child detail + parent; sale: find + raw). A write is only started
 * when this headroom is still free in the shared window, so its own readback
 * is never starved into an "uncertain" effect.
 * @type {Readonly<Record<'customer'|'product'|'variation'|'sale', number>>} */
export const OLIST_WRITE_READBACKS = Object.freeze({
  customer: 2,
  product: 2,
  variation: 3,
  sale: 2,
});

/** Named wait profiles. Only reads wait; writes never do.
 * - `worker`: dispatch/reconciliation jobs (lease kept alive by `beat`).
 * - `patient`: confirmation reads while a durable ticket is in hand.
 * - `api`: one HTTP request; capped at 24/30 so 6 units per window stay
 *   reserved to the worker. `cumulative`: the 8 s is a budget for ALL the reads
 *   of the client built for that request (one client per request), not a limit
 *   per read; a request that makes several reads can never wait longer than 8 s
 *   in total.
 * - `verify`: the account check right after a token exchange; must stay under
 *   the 60 s abandoned-refresh limit of the connection.
 * @type {Readonly<Record<'worker'|'patient'|'api'|'verify', Readonly<{maxWaitMs:number,ceiling:number,cumulative?:boolean}>>>} */
export const OLIST_READ_WAIT = Object.freeze({
  worker: Object.freeze({ maxWaitMs: 90_000, ceiling: 30 }),
  patient: Object.freeze({ maxWaitMs: 180_000, ceiling: 30 }),
  api: Object.freeze({ maxWaitMs: 8_000, ceiling: 24, cumulative: true }),
  verify: Object.freeze({ maxWaitMs: 15_000, ceiling: 30 }),
});

/** Builds the `readWait` option of `createOlistClient` for a profile.
 * @param {'worker'|'api'} profile
 * @param {{beat?:()=>Promise<unknown>|unknown,sleep?:(ms:number)=>Promise<unknown>}} [hooks] */
export function olistReadWait(profile, hooks = {}) {
  const base = OLIST_READ_WAIT[profile];
  if (!base) throw new OlistError('INVALID_REQUEST', 400);
  return Object.freeze({
    maxWaitMs: base.maxWaitMs,
    patientMaxWaitMs: OLIST_READ_WAIT.patient.maxWaitMs,
    ceiling: base.ceiling,
    ...(base.cumulative === true ? { cumulative: true } : {}),
    ...(hooks.beat ? { beat: hooks.beat } : {}),
    ...(hooks.sleep ? { sleep: hooks.sleep } : {}),
  });
}

/** @param {number} ms */
const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** @param {number} waitMs */
function rateLimited(waitMs) {
  return Object.assign(new OlistError('OLIST_RATE_LIMITED', 429), {
    retryAfterMs: Math.max(MIN_WAIT_MS, Math.ceil(waitMs)),
  });
}

/** Reservations survive failed calls; every process shares account scope.
 * `attempt` is the only place that touches the counters; each call is one short
 * transaction under the account advisory lock, and no wait ever happens inside
 * it. `reserve` (no wait), `reserveWrite` (no wait, keeps headroom) and
 * `reserveRead` (waits outside any transaction) are built on it.
 * @param {any} database @param {string} accountKey @param {number} [limit] */
export function createOlistQuota(
  database,
  accountKey,
  limit = OLIST_QUOTA_LIMIT,
) {
  if (
    !/^[a-f0-9]{64}$/u.test(accountKey) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 60
  )
    throw new OlistError('OLIST_NOT_CONFIGURED', 503);
  /** @param {{cost?:number,ceiling?:number,headroom?:number}} [input]
   * @returns {Promise<{ok:true}|{ok:false,waitMs:number}>} */
  async function attempt({ cost = 1, ceiling = limit, headroom = 0 } = {}) {
    if (
      !Number.isSafeInteger(cost) ||
      cost < 1 ||
      !Number.isSafeInteger(headroom) ||
      headroom < 0 ||
      !Number.isSafeInteger(ceiling) ||
      ceiling < 1
    )
      throw new OlistError('INVALID_REQUEST', 400);
    // A caller can only lower the account ceiling, never exceed it.
    const cap = Math.min(ceiling, limit);
    return database.transaction(async (/** @type {any} */ client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['olist-quota:' + accountKey],
      );
      await client.query(
        'INSERT INTO crm.olist_quotas(account_key) VALUES($1) ON CONFLICT DO NOTHING',
        [accountKey],
      );
      const { rows } = await client.query(
        'SELECT *,now() AS database_now FROM crm.olist_quotas WHERE account_key=$1 FOR UPDATE',
        [accountKey],
      );
      const row = rows[0];
      const now = new Date(row.database_now);
      if (row.blocked_until && new Date(row.blocked_until) > now)
        return {
          ok: false,
          waitMs: Math.max(
            MIN_WAIT_MS,
            new Date(row.blocked_until).getTime() - now.getTime(),
          ),
        };
      const windowAge =
        now.getTime() - new Date(row.window_started_at).getTime();
      const newWindow = windowAge >= WINDOW_MS;
      const used = newWindow ? 0 : Number(row.used);
      const remaining = newWindow ? null : row.remaining;
      const need = cost + headroom;
      if (used + need > cap || (remaining !== null && Number(remaining) < need))
        // Only the end of the current window frees capacity (when nothing
        // is blocked); that the window really ends there is an assumption.
        return {
          ok: false,
          waitMs: Math.max(MIN_WAIT_MS, WINDOW_MS - windowAge),
        };
      await client.query(
        'UPDATE crm.olist_quotas SET window_started_at=$2,used=$3,remaining=$4 WHERE account_key=$1',
        [
          accountKey,
          newWindow ? now : row.window_started_at,
          used + cost,
          remaining === null ? null : Math.max(0, Number(remaining) - cost),
        ],
      );
      return { ok: true };
    });
  }
  return Object.freeze({
    limit,
    attempt,
    /** Immediate, never waits (legacy contract). Failure carries `retryAfterMs`.
     * @returns {Promise<void>} */
    async reserve() {
      const result = await attempt({ cost: 1, ceiling: limit });
      if (!result.ok) throw rateLimited(result.waitMs);
    },
    /** One unit for a POST, only if `readbacks` more units are still free in
     * this window (`used+1+readbacks<=limit` and `remaining>=1+readbacks`).
     * Never waits: a write that would not leave room for its own readbacks is
     * deferred before any ticket exists.
     * @param {{readbacks?:number}} [input]
     * @returns {Promise<void>} */
    async reserveWrite({ readbacks = 0 } = {}) {
      if (!Number.isSafeInteger(readbacks) || readbacks < 0 || readbacks > 10)
        throw new OlistError('INVALID_REQUEST', 400);
      const result = await attempt({
        cost: 1,
        ceiling: limit,
        headroom: readbacks,
      });
      if (!result.ok) throw rateLimited(result.waitMs);
    },
    /** Waits (outside any SQL transaction) for a unit to become free, in slices
     * of at most 10 s plus jitter, calling `beat()` before each slice. A wait
     * that cannot fit in `maxWaitMs` fails at once with `retryAfterMs`.
     * `beat` returning `false` means the job lease is lost.
     * @param {{maxWaitMs?:number,ceiling?:number,cost?:number,beat?:()=>Promise<unknown>|unknown,sleep?:(ms:number)=>Promise<unknown>,random?:()=>number}} [input]
     * @returns {Promise<{waitedMs:number}>} */
    async reserveRead({
      maxWaitMs = OLIST_READ_WAIT.worker.maxWaitMs,
      ceiling = limit,
      cost = 1,
      beat,
      sleep = defaultSleep,
      random = Math.random,
    } = {}) {
      if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0)
        throw new OlistError('INVALID_REQUEST', 400);
      let waitedMs = 0;
      for (;;) {
        const result = await attempt({ cost, ceiling });
        if (result.ok) return { waitedMs };
        if (waitedMs + result.waitMs > maxWaitMs)
          throw rateLimited(result.waitMs);
        const slice =
          Math.min(OLIST_WAIT_SLICE_MS, result.waitMs) +
          Math.floor(random() * JITTER_MS);
        if ((await beat?.()) === false)
          throw new OlistError('OLIST_JOB_LEASE_LOST');
        await sleep(slice);
        waitedMs += slice;
      }
    },
    /** Never increase quota from an out-of-order response.
     * @param {Headers} headers */
    async observe(headers) {
      const raw = headers.get('x-ratelimit-remaining');
      if (raw === null || !/^\d{1,9}$/u.test(raw)) return;
      await database.query(
        'UPDATE crm.olist_quotas SET remaining=LEAST(COALESCE(remaining,$2),$2) WHERE account_key=$1',
        [accountKey, Number(raw)],
      );
    },
    /** @param {number} [retryAfterMs] */
    async block(retryAfterMs = 60_000) {
      const bounded = Math.max(1000, Math.min(3_600_000, retryAfterMs));
      await database.query(
        "UPDATE crm.olist_quotas SET blocked_until=GREATEST(COALESCE(blocked_until,now()),now()+($2 * interval '1 millisecond')) WHERE account_key=$1",
        [accountKey, bounded],
      );
    },
  });
}
