import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize } from '@crm-silmer/identity-access';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  FinanceError,
  financeQuery,
  financeVersions,
  PostgresFinanceRepository,
} from '@crm-silmer/orders';

/** Revalidate/lock the live principal even on an idempotent replay.
 * @param {any} client @param {string} id @param {string} action */
async function lockActor(client, id, action) {
  const { rows } = await client.query(
    `SELECT u.id, f.function_name
    FROM crm.users u JOIN crm.user_functions f ON f.user_id = u.id
    WHERE u.id = $1 AND u.disabled_at IS NULL FOR SHARE OF u, f`,
    [id],
  );
  if (!rows[0]) throw new FinanceError(403, 'FORBIDDEN');
  const grants = await client.query(
    `SELECT capability FROM crm.user_capabilities
    WHERE user_id = $1 FOR SHARE`,
    [id],
  );
  const actor = {
    id,
    kind: /** @type {const} */ ('human'),
    functionName: rows[0].function_name,
    capabilities: grants.rows.map((/** @type {any} */ row) => row.capability),
  };
  authorize(actor, action);
  return actor;
}

/** @param {string|undefined} value @param {string} name */
function key(value, name) {
  const decoded = Buffer.from(value ?? '', 'base64');
  if (decoded.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

/** @param {any} database @param {{access:any, environment?:Record<string,string|undefined>, clock?:()=>Date}} options */
export function createFinanceApiRuntime(database, options) {
  const environment = options.environment ?? process.env;
  const repository = new PostgresFinanceRepository({
    envelopeKey: key(
      environment.N8N_INTEGRATION_ENVELOPE_KEY,
      'N8N_INTEGRATION_ENVELOPE_KEY',
    ),
  });
  const idempotencyKey = key(
    environment.IDEMPOTENCY_ENVELOPE_KEY,
    'IDEMPOTENCY_ENVELOPE_KEY',
  );
  const clock = options.clock ?? (() => new Date());
  const access = options.access;
  return Object.freeze({
    /** @param {any} input */
    authorizeRead: (input) => access.authorizeRead(input),
    /** @param {any} input */
    authorizeWrite: (input) => access.authorizeWrite(input),
    /** @param {{actor:any, query?:unknown}} input */
    async list(input) {
      const filters = financeQuery(input.query);
      return database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor.id, 'finance.read');
        return repository.list(client, filters);
      });
    },
    /** @param {{actor:any, orderId:string}} input */
    async get(input) {
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await lockActor(client, input.actor.id, 'finance.read');
        const row = await repository.find(client, input.orderId);
        return {
          order: await repository.detail(
            client,
            row,
            actor.functionName === 'Financeiro',
          ),
        };
      });
    },
    /** @param {{action:'complete'|'reopen', actor:any, orderId:string, expectedVersion:number, expectedFinanceVersion:number, idempotencyKey:string, correlationId:string}} input */
    async change(input) {
      const versions = financeVersions(input);
      const action = `finance.${input.action}`;
      return database.transaction(async (/** @type {any} */ client) => {
        await lockActor(client, input.actor.id, action);
        const row = await repository.find(client, input.orderId, true);
        const boundDatabase = {
          query: client.query.bind(client),
          transaction: async (/** @type {any} */ work) => work(client),
        };
        const idempotency = new PostgresIdempotencyRecordStore({
          database: boundDatabase,
          envelopeKey: idempotencyKey,
        });
        const command = {
          orderId: input.orderId,
          action: input.action,
          ...versions,
        };
        return idempotency.execute(
          {
            scope: `${action}:${input.actor.id}`,
            key: input.idempotencyKey,
            fingerprint: fingerprintCommand(command),
            actor: input.actor.id,
            action,
            target: { type: 'order', id: input.orderId },
            version: `${versions.expectedVersion}:${versions.expectedFinanceVersion}`,
            reason:
              input.action === 'complete'
                ? 'FINANCE_ROUTINE_COMPLETED'
                : 'FINANCE_ROUTINE_REOPENED',
            correlationId: input.correlationId,
          },
          async () => {
            if (
              Number(row.version) !== versions.expectedVersion ||
              Number(row.finance_version) !== versions.expectedFinanceVersion
            ) {
              throw new FinanceError(409, 'VERSION_CONFLICT');
            }
            const saved = await repository.change(client, {
              row,
              action: input.action === 'complete' ? 'completed' : 'reopened',
              actorId: input.actor.id,
              correlationId: input.correlationId,
              now: clock(),
            });
            await new PostgresAuditTrail(client).append({
              actor: input.actor.id,
              action,
              target: { type: 'order', id: input.orderId },
              version: Number(saved.finance_version),
              reason:
                input.action === 'complete'
                  ? 'FINANCE_ROUTINE_COMPLETED'
                  : 'FINANCE_ROUTINE_REOPENED',
              correlationId: input.correlationId,
            });
            return { order: await repository.detail(client, saved, true) };
          },
        );
      });
    },
  });
}
