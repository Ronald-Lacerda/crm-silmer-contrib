import { authorize } from '@crm-silmer/identity-access';
import { OlistError } from './errors.js';
/** Lock the real current user/session; a supplied actor or old job is never authority.
 * @param {any} client @param {any} input @param {string} action @param {Date} now */
export async function lockOlistActor(client, input, action, now) {
  if (input.actor?.kind !== 'human' || typeof input.actor?.id !== 'string')
    throw new OlistError('FORBIDDEN', 403);
  const { rows } = await client.query(
    'SELECT u.id,u.olist_enabled,u.olist_authorization_version,f.function_name FROM crm.users u JOIN crm.user_functions f ON f.user_id=u.id WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f',
    [input.actor.id],
  );
  const row = rows[0];
  if (!row) throw new OlistError('FORBIDDEN', 403);
  const grants = await client.query(
    'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
    [row.id],
  );
  const actor = {
    id: row.id,
    kind: /** @type {const} */ ('human'),
    functionName: row.function_name,
    capabilities: grants.rows.map(
      (/** @type {any} */ grant) => grant.capability,
    ),
    olistEnabled: row.olist_enabled === true,
    olistAuthorizationVersion: Number(row.olist_authorization_version),
  };
  authorize(actor, action);
  if (input.sessionBinding !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(input.sessionBinding))
      throw new OlistError('FORBIDDEN', 403);
    const session = await client.query(
      "SELECT token_hash FROM crm.sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND absolute_expires_at>$3 AND last_seen_at>$3::timestamptz-interval '30 minutes' FOR SHARE",
      [input.sessionBinding, actor.id, now],
    );
    if (!session.rows[0]) throw new OlistError('FORBIDDEN', 403);
  } else if (
    !['olist.export', 'olist.reconcile'].includes(action) ||
    !Number.isSafeInteger(input.authorizationVersion)
  )
    throw new OlistError('FORBIDDEN', 403);
  if (
    input.authorizationVersion !== undefined &&
    actor.olistAuthorizationVersion !== input.authorizationVersion
  )
    throw new OlistError('FORBIDDEN', 403);
  return actor;
}
