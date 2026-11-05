import { AccessControlError } from './authorization.js';

const bootstrapAdvisoryLock = 0x49414d31;

/**
 * @typedef {'COMMERCIAL_ADMIN'} IdentityCapability
 * @typedef {'Vendedor'|'Financeiro'} OperationalFunction
 * @typedef {{
 *   capabilities: IdentityCapability[],
 *   capabilityGrantedBy?: string,
 *   canDelete?: boolean,
 *   createdAt?: string | null,
 *   disabledAt?: string | null,
 *   email: string,
 *   functionName: OperationalFunction,
 *   id: string,
 *   name: string,
 *   olistEnabled?: boolean,
 *   olistAuthorizationVersion?: number,
 *   passwordHash: string,
 * }} IdentityUser
 * @typedef {{
 *   email?: string,
 *   capabilities?: IdentityCapability[],
 *   functionName?: OperationalFunction,
 *   capabilityGrantedBy?: string,
 *   name?: string,
 *   olistEnabled?: boolean,
 *   expectedOlistAuthorizationVersion?: number,
 *   passwordHash?: string,
 *   revokeSessionsAt?: string,
 * }} IdentityUserPatch
 * @typedef {{
 *   absoluteExpiresAt: string,
 *   csrfHash: string,
 *   createdAt: string,
 *   lastSeenAt: string,
 *   revokedAt: string | null,
 *   tokenHash: string,
 *   userId: string,
 * }} IdentitySession
 * @typedef {{
 *   query: (
 *     sql: string,
 *     values?: unknown[],
 *   ) => Promise<{rows: any[]}>
 * }} Queryable
 */

const userSelect = `
  SELECT
    u.id,
    u.email,
    u.name,
    u.password_hash,
    u.created_at,
    u.disabled_at,
    u.olist_enabled,
    u.olist_authorization_version,
    f.function_name,
    COALESCE(
      (
        SELECT array_agg(c.capability ORDER BY c.capability)
        FROM crm.user_capabilities AS c
        WHERE c.user_id = u.id
      ),
      ARRAY[]::text[]
    ) AS capabilities
    ,(
      NOT EXISTS (
        SELECT 1
        FROM crm.conversations AS conversation
        WHERE conversation.assigned_user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.handoffs AS handoff
        WHERE handoff.assigned_user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.handoff_history AS history
        WHERE history.assigned_user_id = u.id OR history.actor_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.tasks AS task
        WHERE task.assigned_user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.task_history AS history
        WHERE history.actor_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.deals AS deal
        WHERE deal.assigned_user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.deal_assignment_history AS history
        WHERE history.previous_user_id = u.id
          OR history.assigned_user_id = u.id
          OR history.actor_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.user_capabilities AS capability
        WHERE capability.granted_by = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.configuration_versions AS configuration
        WHERE configuration.created_by = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.catalog_versions AS catalog
        WHERE catalog.created_by = u.id OR catalog.published_by = u.id
      )
      AND NOT crm.identity_has_finance_history(u.id)
    ) AS can_delete
  FROM crm.users AS u
  JOIN crm.user_functions AS f ON f.user_id = u.id
`;

const sessionReturning = `
  s.token_hash,
  s.user_id,
  s.csrf_hash,
  s.created_at,
  s.last_seen_at,
  s.absolute_expires_at,
  s.revoked_at
`;

/**
 * Creates an adapter over a queryable PostgreSQL client. Callers must pass a
 * transaction-bound PoolClient for mutations that form one domain command.
 * The adapter deliberately never issues BEGIN, COMMIT, or ROLLBACK.
 *
 * @param {Queryable} database
 */
export function createPostgresIdentityRepository(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('A PostgreSQL queryable is required');
  }

  /** @param {IdentityUser} user */
  async function insertUser(user) {
    await database.query(
      `INSERT INTO crm.users (id, email, name, password_hash, olist_enabled, olist_authorization_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        user.email,
        user.name,
        user.passwordHash,
        user.olistEnabled === true,
        user.olistAuthorizationVersion ?? 0,
      ],
    );
    await database.query(
      `INSERT INTO crm.user_functions (user_id, function_name)
       VALUES ($1, $2)`,
      [user.id, user.functionName],
    );
    for (const capability of user.capabilities) {
      await database.query(
        `INSERT INTO crm.user_capabilities
           (user_id, capability, granted_by)
         VALUES ($1, $2, $3)`,
        [user.id, capability, user.capabilityGrantedBy ?? null],
      );
    }
  }

  return Object.freeze({
    /** @param {string} tokenHash @param {string} touchedAt @param {string} idleExpiresBefore */
    async authenticateSession(tokenHash, touchedAt, idleExpiresBefore) {
      const result = await database.query(
        `UPDATE crm.sessions AS s
         SET last_seen_at = $2
         FROM crm.users AS u
         WHERE s.token_hash = $1
           AND u.id = s.user_id
           AND u.disabled_at IS NULL
           AND s.revoked_at IS NULL
           AND s.absolute_expires_at > $2::timestamptz
           AND s.last_seen_at > $3::timestamptz
         RETURNING ${sessionReturning}`,
        [tokenHash, touchedAt, idleExpiresBefore],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    },

    /** @param {IdentitySession} session */
    async createSession(session) {
      await database.query(
        `INSERT INTO crm.sessions
           (token_hash, user_id, csrf_hash, created_at, last_seen_at,
             absolute_expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.tokenHash,
          session.userId,
          session.csrfHash,
          session.createdAt,
          session.lastSeenAt,
          session.absoluteExpiresAt,
          session.revokedAt,
        ],
      );
    },

    /** @param {IdentityUser} user */
    async createUser(user) {
      await insertUser(user);
    },

    /** @param {string} id */
    async deleteUser(id) {
      const result = await database.query(
        `DELETE FROM crm.users AS user_account
         WHERE user_account.id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM crm.user_capabilities AS capability
             WHERE capability.user_id = user_account.id
               AND capability.capability = 'COMMERCIAL_ADMIN'
           )
         RETURNING user_account.id`,
        [id],
      );
      return result.rows.length > 0;
    },

    /** @param {string} tokenHash */
    async findSession(tokenHash) {
      const result = await database.query(
        `SELECT
           token_hash,
           user_id,
           csrf_hash,
           created_at,
           last_seen_at,
            absolute_expires_at,
            revoked_at
         FROM crm.sessions
         WHERE token_hash = $1`,
        [tokenHash],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    },

    /** @param {string} email */
    async findUserByEmail(email) {
      const result = await database.query(
        `${userSelect}
         WHERE lower(u.email) = lower($1)
           AND u.disabled_at IS NULL`,
        [email],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    /** @param {string} id */
    async findUserById(id) {
      const result = await database.query(`${userSelect} WHERE u.id = $1`, [
        id,
      ]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async hasUsers() {
      const result = await database.query(
        `SELECT EXISTS (SELECT 1 FROM crm.users) AS has_users`,
      );
      return result.rows[0]?.has_users === true;
    },

    /** @param {IdentityUser} user */
    async insertInitialUser(user) {
      await database.query('SELECT pg_advisory_xact_lock($1)', [
        bootstrapAdvisoryLock,
      ]);
      const existing = await database.query(
        `SELECT EXISTS (SELECT 1 FROM crm.users) AS has_users`,
      );
      if (existing.rows[0]?.has_users === true) return false;
      await insertUser(user);
      return true;
    },

    async inspect() {
      const [users, sessions] = await Promise.all([
        database.query(`${userSelect} ORDER BY u.id`),
        database.query(
          `SELECT token_hash, user_id, csrf_hash, created_at, last_seen_at,
              absolute_expires_at, revoked_at
           FROM crm.sessions
           ORDER BY token_hash`,
        ),
      ]);
      return {
        sessions: sessions.rows.map(mapSession),
        users: users.rows.map(mapUser),
      };
    },

    async listUsers() {
      const result = await database.query(
        `${userSelect} ORDER BY u.name, u.email`,
      );
      return result.rows.map(mapUser);
    },

    /** @param {string} tokenHash @param {string} revokedAt */
    async revokeSession(tokenHash, revokedAt) {
      await database.query(
        `UPDATE crm.sessions
         SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
         WHERE token_hash = $1`,
        [tokenHash, revokedAt],
      );
    },

    /** @param {string} id @param {string | null} disabledAt */
    async setUserDisabled(id, disabledAt) {
      const result = await database.query(
        `UPDATE crm.users
         SET disabled_at = $2::timestamptz,
             olist_authorization_version = olist_authorization_version +
               CASE WHEN disabled_at IS DISTINCT FROM $2::timestamptz THEN 1 ELSE 0 END
         WHERE id = $1
         RETURNING id`,
        [id, disabledAt],
      );
      return result.rows[0] ? reloadUser(database, id) : null;
    },

    /** @param {string} tokenHash @param {string} touchedAt */
    async touchSession(tokenHash, touchedAt) {
      await database.query(
        `UPDATE crm.sessions
         SET last_seen_at = $2
         WHERE token_hash = $1
           AND revoked_at IS NULL`,
        [tokenHash, touchedAt],
      );
    },

    /** @param {string} id @param {IdentityUserPatch} patch */
    async updateUser(id, patch) {
      const target = await database.query(
        'SELECT id, olist_enabled, olist_authorization_version FROM crm.users WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!target.rows[0]) return null;
      if (patch.olistEnabled !== undefined) {
        const current = target.rows[0];
        if (
          current.olist_authorization_version !==
          patch.expectedOlistAuthorizationVersion
        )
          throw new AccessControlError(
            409,
            'VERSION_CONFLICT',
            'Olist authorization changed',
          );
        if (current.olist_enabled !== patch.olistEnabled) {
          await database.query(
            `UPDATE crm.users SET olist_enabled = $2,
               olist_authorization_version = olist_authorization_version + 1
             WHERE id = $1`,
            [id, patch.olistEnabled],
          );
        }
      }
      if (patch.functionName !== undefined) {
        await database.query(
          'DELETE FROM crm.user_capabilities WHERE user_id = $1',
          [id],
        );
        await database.query(
          'UPDATE crm.user_functions SET function_name = $2, assigned_at = now() WHERE user_id = $1',
          [id, patch.functionName],
        );
        for (const capability of patch.capabilities ?? []) {
          await database.query(
            `INSERT INTO crm.user_capabilities (user_id, capability, granted_by) VALUES ($1, $2, $3)`,
            [id, capability, patch.capabilityGrantedBy ?? null],
          );
        }
        await database.query(
          `UPDATE crm.sessions SET revoked_at = $2::timestamptz WHERE user_id = $1 AND revoked_at IS NULL`,
          [id, patch.revokeSessionsAt ?? new Date().toISOString()],
        );
      }
      /** @type {string[]} */
      const assignments = [];
      /** @type {unknown[]} */
      const values = [id];
      /** @type {Array<[string, string | undefined]>} */
      const columns = [
        ['email', patch.email],
        ['name', patch.name],
        ['password_hash', patch.passwordHash],
      ];
      for (const [column, value] of columns) {
        if (value === undefined) continue;
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }
      if (assignments.length === 0) return reloadUser(database, id);
      const result = await database.query(
        `UPDATE crm.users
         SET ${assignments.join(', ')}
         WHERE id = $1
         RETURNING id`,
        values,
      );
      return result.rows[0] ? reloadUser(database, id) : null;
    },

    /** @param {string} tokenHash @param {string} csrfHash @param {string} touchedAt @param {string} idleExpiresBefore */
    async validateCsrfSession(
      tokenHash,
      csrfHash,
      touchedAt,
      idleExpiresBefore,
    ) {
      const result = await database.query(
        `UPDATE crm.sessions AS s
         SET last_seen_at = $3
         FROM crm.users AS u
         WHERE s.token_hash = $1
           AND s.csrf_hash = $2
           AND u.id = s.user_id
           AND u.disabled_at IS NULL
           AND s.revoked_at IS NULL
           AND s.absolute_expires_at > $3::timestamptz
           AND s.last_seen_at > $4::timestamptz
         RETURNING ${sessionReturning}`,
        [tokenHash, csrfHash, touchedAt, idleExpiresBefore],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    },
  });
}

/** @param {Queryable} database @param {string} id */
async function reloadUser(database, id) {
  const result = await database.query(`${userSelect} WHERE u.id = $1`, [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

/** @param {Record<string, unknown>} row @returns {IdentityUser} */
function mapUser(row) {
  return {
    capabilities: /** @type {IdentityCapability[]} */ (row.capabilities),
    canDelete:
      row.can_delete === undefined ? undefined : Boolean(row.can_delete),
    createdAt: toIsoString(row.created_at),
    disabledAt: toIsoString(row.disabled_at),
    email: /** @type {string} */ (row.email),
    functionName: /** @type {OperationalFunction} */ (row.function_name),
    id: /** @type {string} */ (row.id),
    name: /** @type {string} */ (row.name),
    olistEnabled: row.olist_enabled === true,
    olistAuthorizationVersion: Number(row.olist_authorization_version ?? 0),
    passwordHash: /** @type {string} */ (row.password_hash),
  };
}

/** @param {Record<string, unknown>} row @returns {IdentitySession} */
function mapSession(row) {
  return {
    absoluteExpiresAt: requireIsoString(row.absolute_expires_at),
    createdAt: requireIsoString(row.created_at),
    csrfHash: /** @type {string} */ (row.csrf_hash),
    lastSeenAt: requireIsoString(row.last_seen_at),
    revokedAt: toIsoString(row.revoked_at),
    tokenHash: /** @type {string} */ (row.token_hash),
    userId: /** @type {string} */ (row.user_id),
  };
}

/** @param {unknown} value */
function toIsoString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new TypeError('PostgreSQL timestamp has an invalid type');
}

/** @param {unknown} value */
function requireIsoString(value) {
  const timestamp = toIsoString(value);
  if (timestamp === null) {
    throw new TypeError('PostgreSQL timestamp must not be null');
  }
  return timestamp;
}
