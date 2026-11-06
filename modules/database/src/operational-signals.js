/** OPSH-01/03: bounded queries; never read payloads or change source state. */
export class PostgresOperationalSignals {
  /** @param {{database: {transaction: Function}}} options */
  constructor({ database }) {
    this.database = database;
  }

  /** @param {any} client */
  async bounds(client) {
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await client.query("SET LOCAL statement_timeout = '1s'");
  }

  /** @param {{queue: string, pollCompletedAt: Date|null}} input */
  async publish({ queue, pollCompletedAt }) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      await this.bounds(client);
      const result = await client.query(
        `INSERT INTO crm.operational_worker_health(queue,heartbeat_at,poll_completed_at)
         VALUES ($1,clock_timestamp(),$2)
         ON CONFLICT(queue) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,
           poll_completed_at=excluded.poll_completed_at
         RETURNING extract(epoch FROM heartbeat_at)::float8 AS heartbeat`,
        [queue, pollCompletedAt],
      );
      const age = await client.query(
        `SELECT coalesce((SELECT greatest(0,extract(epoch FROM (now()-available_at)))::float8
          FROM crm.outbox_jobs WHERE queue=$1 AND status IN ('pending','retry')
            AND available_at<=now() ORDER BY available_at LIMIT 1),0) AS age`,
        [queue],
      );
      return {
        heartbeat: Number(result.rows[0].heartbeat),
        age: Number(age.rows[0].age),
      };
    });
  }

  /** @param {string[]} queues */
  async sample(queues) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query('SET TRANSACTION READ ONLY');
      await this.bounds(client);
      const result = await client.query(
        `SELECT
          NOT EXISTS(SELECT 1 FROM unnest($1::text[]) expected(queue)
            LEFT JOIN crm.operational_worker_health h USING(queue)
            WHERE h.heartbeat_at IS NULL OR h.heartbeat_at<now()-interval '120 seconds'
              OR h.poll_completed_at IS NULL OR h.poll_completed_at<now()-interval '120 seconds'
              OR h.poll_completed_at>now()+interval '5 seconds') AS worker_ok,
          NOT EXISTS(SELECT 1 FROM crm.outbox_jobs
            WHERE status IN ('pending','retry') AND available_at<now()-interval '300 seconds') AS queue_ok,
          (NOT EXISTS(SELECT 1 FROM crm.n8n_commands WHERE status='processing'
            AND locked_until<now()-interval '120 seconds')
           AND NOT EXISTS(SELECT 1 FROM crm.n8n_commands WHERE status='processing'
            AND locked_until IS NULL)) AS commands_ok`,
        [queues],
      );
      const row = result.rows[0];
      return {
        worker: row.worker_ok === true,
        queue: row.queue_ok === true,
        commands: row.commands_ok === true,
      };
    });
  }
}
