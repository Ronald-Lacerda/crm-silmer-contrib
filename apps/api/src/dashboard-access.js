import { authorize } from '@crm-silmer/identity-access';

import { DashboardError } from './dashboard-runtime.js';

/** Re-read the active role under the read transaction (PERF-07/ACT-10): the
 * session's cached actor never decides scope. An administrator sees the team;
 * any other Vendedor only its own row. Financeiro is refused by `authorize`.
 * @param {any} client @param {any} actor
 * @returns {Promise<{id:string,kind:'human',functionName:string,capabilities:string[],scope:'team'|'self'}>}
 */
export async function lockDashboardReader(client, actor) {
  if (actor?.kind !== 'human' || !actor.id) {
    throw new DashboardError(403, 'FORBIDDEN');
  }
  const result = await client.query(
    `SELECT u.id, f.function_name
     FROM crm.users u JOIN crm.user_functions f ON f.user_id = u.id
     WHERE u.id = $1 AND u.disabled_at IS NULL FOR SHARE OF u, f`,
    [actor.id],
  );
  const row = result.rows[0];
  if (!row) throw new DashboardError(403, 'FORBIDDEN');
  const grants = await client.query(
    `SELECT capability FROM crm.user_capabilities
     WHERE user_id = $1 FOR SHARE`,
    [actor.id],
  );
  const capabilities = grants.rows.map(
    (/** @type {any} */ grant) => grant.capability,
  );
  const live = {
    id: String(actor.id),
    kind: /** @type {const} */ ('human'),
    functionName: row.function_name,
    capabilities,
  };
  authorize(/** @type {any} */ (live), 'conversation.read');
  return {
    ...live,
    scope: capabilities.includes('COMMERCIAL_ADMIN') ? 'team' : 'self',
  };
}
