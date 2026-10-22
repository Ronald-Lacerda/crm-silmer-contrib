/**
 * @typedef {'COMMERCIAL_ADMIN'} Capability
 * @typedef {'Vendedor'|'Financeiro'} OperationalFunction
 * @typedef {{
 *   query: (
 *     sql: string,
 *     values?: unknown[],
 *   ) => Promise<{rows: Array<Record<string, unknown>>, rowCount?: number | null}>
 * }} Queryable
 */

/**
 * Creates the ACL repository over a PoolClient supplied by the command unit of
 * work. The adapter never owns transaction boundaries.
 *
 * @param {Queryable} database
 */
export function createPostgresAccessRepository(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('A PostgreSQL queryable is required');
  }

  return Object.freeze({
    /** @param {string} id */
    async findUser(id) {
      const result = await database.query(
        `SELECT
           u.id,
           f.function_name,
           COALESCE(
             array_agg(c.capability ORDER BY c.capability)
               FILTER (WHERE c.capability IS NOT NULL),
             ARRAY[]::text[]
           ) AS capabilities
         FROM crm.users AS u
         JOIN crm.user_functions AS f ON f.user_id = u.id
         LEFT JOIN crm.user_capabilities AS c ON c.user_id = u.id
         WHERE u.id = $1 AND u.disabled_at IS NULL
         GROUP BY u.id, f.function_name`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        capabilities: /** @type {Capability[]} */ (row.capabilities),
        functionName: /** @type {OperationalFunction} */ (row.function_name),
        id: /** @type {string} */ (row.id),
      };
    },

    /** @param {string} id @param {Capability} capability @param {string} grantedBy */
    async grant(id, capability, grantedBy) {
      await database.query(
        'SELECT id FROM crm.users WHERE id = $1 FOR UPDATE',
        [id],
      );
      await database.query(
        `INSERT INTO crm.user_capabilities
           (user_id, capability, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, capability) DO NOTHING`,
        [id, capability, grantedBy],
      );
    },

    /** @param {string} id @param {Capability} capability */
    async revoke(id, capability) {
      await database.query(
        'SELECT id FROM crm.users WHERE id = $1 FOR UPDATE',
        [id],
      );
      await database.query(
        `DELETE FROM crm.user_capabilities
         WHERE user_id = $1 AND capability = $2`,
        [id, capability],
      );
    },

    /** @param {string} id @param {string} occurredAt */
    async revokePrivilegedSessions(id, occurredAt) {
      await database.query(
        `UPDATE crm.sessions
         SET revoked_at = $2::timestamptz
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [id, occurredAt],
      );
    },
  });
}
