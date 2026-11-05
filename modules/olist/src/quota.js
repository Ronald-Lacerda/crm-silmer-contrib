import { OlistError } from './errors.js';
/** Reservations survive failed calls; every process shares account scope.
 * @param {any} database @param {string} accountKey @param {number} [limit] */
export function createOlistQuota(database, accountKey, limit = 30) {
  if (
    !/^[a-f0-9]{64}$/u.test(accountKey) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 60
  )
    throw new OlistError('OLIST_NOT_CONFIGURED', 503);
  return Object.freeze({
    async reserve() {
      const result = await database.transaction(
        async (/** @type {any} */ client) => {
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
            return false;
          const newWindow =
            now.getTime() - new Date(row.window_started_at).getTime() >= 60_000;
          const used = newWindow ? 0 : Number(row.used);
          const remaining = newWindow ? null : row.remaining;
          if (used >= limit || remaining === 0) return false;
          await client.query(
            'UPDATE crm.olist_quotas SET window_started_at=$2,used=$3,remaining=$4 WHERE account_key=$1',
            [
              accountKey,
              newWindow ? now : row.window_started_at,
              used + 1,
              remaining === null ? null : Math.max(0, Number(remaining) - 1),
            ],
          );
          return true;
        },
      );
      if (!result) throw new OlistError('OLIST_RATE_LIMITED', 429);
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
