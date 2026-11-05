import { randomUUID } from 'node:crypto';
import { OlistError, integer, text, object } from './errors.js';
import { seal, identityHash } from './crypto.js';
import { normalizeDocument } from './configuration.js';
import { lockOlistActor } from './access.js';
/** Server-only persistence port. Every returned ID is account scoped.
 * @param {any} database @param {{envelopeKey:Buffer,hmacKey:Buffer,clock?:()=>Date}} options */
export function createOlistRepository(database, options) {
  const clock = options.clock ?? (() => new Date());
  /** @param {any} client @param {any} input @param {string} code @param {number} version @param {string|null} [exportId] @param {string|null} [resourceId] */
  async function event(
    client,
    input,
    code,
    version,
    exportId = null,
    resourceId = null,
  ) {
    await client.query(
      'INSERT INTO crm.olist_events(id,account_key,export_id,resource_id,actor_id,event_code,version,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        input.accountKey,
        exportId,
        resourceId,
        input.actor.id,
        code,
        version,
        text(input.correlationId),
      ],
    );
  }
  /** @param {any} client @param {any} input */
  async function effectGuard(client, input) {
    await lockOlistActor(client, input, 'olist.export', clock());
    const { rows } = await client.query(
      'SELECT c.*,a.creation_enabled,a.recovery_required FROM crm.olist_connections c JOIN crm.olist_accounts a USING(account_key) WHERE c.context_key=$1 AND c.account_key=$2 FOR SHARE OF c,a',
      [input.contextKey, input.accountKey],
    );
    const connection = rows[0];
    if (!connection?.creation_enabled || connection.recovery_required)
      throw new OlistError('OLIST_CREATION_DISABLED');
    if (
      connection.reconnect_required ||
      !connection.token_envelope ||
      Number(connection.generation) !== input.connectionGeneration
    )
      throw new OlistError('OLIST_CONNECTION_CHANGED');
    return connection;
  }
  return Object.freeze({
    /** Identity values are normalized at this boundary and never stored in clear.
     * @param {any} input */
    async ensureResource(input) {
      if (
        !['customer', 'product', 'variation'].includes(input.kind) ||
        !/^[a-f0-9]{64}$/u.test(input.accountKey)
      )
        throw new OlistError('INVALID_REQUEST', 400);
      let identity;
      if (input.kind === 'customer')
        identity = normalizeDocument(input.identity);
      else if (input.kind === 'product') {
        const fields = [
          'garment',
          'color',
          'fabric',
          'application',
          'collar',
          'audience',
        ];
        const value = object(input.identity, fields);
        if (fields.some((key) => !Object.hasOwn(value, key)))
          throw new OlistError('INVALID_REQUEST', 400);
        identity = fields.map((key) =>
          text(value[key], 200).normalize('NFC').toLocaleLowerCase('pt-BR'),
        );
      } else
        identity = [
          text(input.parentId, 36),
          text(input.identity, 200).normalize('NFC').toLocaleLowerCase('pt-BR'),
        ];
      const protectedIdentity = identityHash(options.hmacKey, input.kind, [
        input.accountKey,
        identity,
      ]);
      return database.transaction(async (/** @type {any} */ client) => {
        await lockOlistActor(client, input, 'olist.export', clock());
        if (input.kind === 'variation') {
          const parent = await client.query(
            "SELECT id FROM crm.olist_resources WHERE id=$1 AND account_key=$2 AND kind='product' AND state='confirmed' FOR SHARE",
            [input.parentId, input.accountKey],
          );
          if (!parent.rows[0]) throw new OlistError('OLIST_PARENT_UNRESOLVED');
        }
        const id = randomUUID();
        const inserted = await client.query(
          'INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,parent_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_key,kind,identity_hash) DO NOTHING RETURNING *',
          [
            id,
            input.accountKey,
            input.kind,
            protectedIdentity,
            'CRM-' + id,
            input.kind === 'variation' ? input.parentId : null,
          ],
        );
        if (inserted.rows[0]) {
          await event(client, input, 'OLIST_RESOURCE_RESERVED', 0, null, id);
          return inserted.rows[0];
        }
        const existing = await client.query(
          'SELECT * FROM crm.olist_resources WHERE account_key=$1 AND kind=$2 AND identity_hash=$3',
          [input.accountKey, input.kind, protectedIdentity],
        );
        return existing.rows[0];
      });
    },
    /** This is not exposed by F2 HTTP. New effects require the account recovery gate.
     * @param {any} input */
    async prepareExport(input) {
      integer(input.orderVersion);
      integer(input.settingsVersion, true);
      integer(input.authorizationVersion, true);
      return database.transaction(async (/** @type {any} */ client) => {
        await effectGuard(client, input);
        const order = await client.query(
          'SELECT version FROM crm.orders WHERE id=$1 FOR UPDATE',
          [input.orderId],
        );
        if (Number(order.rows[0]?.version) !== input.orderVersion)
          throw new OlistError('VERSION_CONFLICT');
        const settings = await client.query(
          'SELECT version FROM crm.olist_settings WHERE account_key=$1 FOR SHARE',
          [input.accountKey],
        );
        if (Number(settings.rows[0]?.version) !== input.settingsVersion)
          throw new OlistError('VERSION_CONFLICT');
        const id = randomUUID();
        const reference = 'CRM-' + id;
        const { rows } = await client.query(
          'INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(account_key,order_id) DO NOTHING RETURNING *',
          [
            id,
            input.accountKey,
            input.contextKey,
            input.connectionGeneration,
            input.orderId,
            input.orderVersion,
            input.settingsVersion,
            input.actor.id,
            input.authorizationVersion,
            reference,
            JSON.stringify(
              seal(
                input.snapshot,
                options.envelopeKey,
                'export-snapshot',
                input.accountKey,
                id,
              ),
            ),
          ],
        );
        if (!rows[0]) {
          const current = await client.query(
            'SELECT * FROM crm.olist_exports WHERE account_key=$1 AND order_id=$2',
            [input.accountKey, input.orderId],
          );
          return current.rows[0];
        }
        await client.query(
          "INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,olist_export_id,status,queue,effect_policy,available_at,created_at,updated_at) VALUES($1,'olist.export',$2,$3,'pending','olist','queryable',$4,$4,$4)",
          [randomUUID(), id, id, clock()],
        );
        await event(client, input, 'OLIST_EXPORT_QUEUED', 1, id);
        return rows[0];
      });
    },
    /** One globally reserved effect per shared resource or sale. No HTTP under locks.
     * @param {any} input */
    async reserveEffect(input) {
      integer(input.expectedVersion, true);
      if (Boolean(input.resourceId) === Boolean(input.exportId))
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        await effectGuard(client, input);
        const resource = Boolean(input.resourceId);
        const target = resource ? 'olist_resources' : 'olist_exports';
        const id = resource ? input.resourceId : input.exportId;
        const { rows } = await client.query(
          'SELECT * FROM crm.' +
            target +
            ' WHERE id=$1 AND account_key=$2 FOR UPDATE',
          [id, input.accountKey],
        );
        const row = rows[0];
        if (!row || Number(row.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        if (
          resource
            ? !['pending', 'rejected'].includes(row.state)
            : row.state !== 'ready'
        )
          throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
        const attemptId = randomUUID();
        const fence = randomUUID();
        const stage = resource ? row.kind : 'sale';
        await client.query(
          'INSERT INTO crm.olist_attempts(id,account_key,export_id,resource_id,stage,fence,generation) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            attemptId,
            input.accountKey,
            resource ? null : id,
            resource ? id : null,
            stage,
            fence,
            input.connectionGeneration,
          ],
        );
        await client.query(
          'UPDATE crm.' +
            target +
            " SET state='reserved',version=version+1,updated_at=$2 WHERE id=$1",
          [id, clock()],
        );
        await event(
          client,
          input,
          'OLIST_EFFECT_RESERVED',
          input.expectedVersion + 1,
          resource ? null : id,
          resource ? id : null,
        );
        return { attemptId, fence };
      });
    },
    /** Effect results must survive user revocation; this recovery port cannot create.
     * @param {any} input */
    async recordResult(input) {
      if (!['confirmed', 'uncertain', 'rejected'].includes(input.outcome))
        throw new OlistError('INVALID_REQUEST', 400);
      if (
        input.outcome === 'confirmed' &&
        !/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId))
      )
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        const { rows } = await client.query(
          'SELECT * FROM crm.olist_attempts WHERE id=$1 AND account_key=$2 AND fence=$3 FOR UPDATE',
          [input.attemptId, input.accountKey, input.fence],
        );
        const attempt = rows[0];
        if (!attempt) throw new OlistError('OLIST_EFFECT_NOT_FOUND', 404);
        if (attempt.outcome !== 'reserved')
          return { outcome: attempt.outcome, replayed: true };
        const target = attempt.resource_id
          ? 'olist_resources'
          : 'olist_exports';
        const id = attempt.resource_id ?? attempt.export_id;
        await client.query(
          'UPDATE crm.olist_attempts SET outcome=$2,response_envelope=$3::jsonb,safe_code=$4,finished_at=$5 WHERE id=$1',
          [
            attempt.id,
            input.outcome,
            JSON.stringify(
              seal(
                input.response ?? null,
                options.envelopeKey,
                'effect-response',
                input.accountKey,
                attempt.id,
              ),
            ),
            input.outcome === 'confirmed'
              ? 'OLIST_CONFIRMED'
              : input.outcome === 'uncertain'
                ? 'OLIST_OUTCOME_UNKNOWN'
                : 'OLIST_REJECTED',
            clock(),
          ],
        );
        await client.query(
          'UPDATE crm.' +
            target +
            ' SET state=$2,remote_id=$3,version=version+1,updated_at=$4 WHERE id=$1',
          [
            id,
            input.outcome,
            input.outcome === 'confirmed' ? String(input.remoteId) : null,
            clock(),
          ],
        );
        await event(
          client,
          input,
          'OLIST_EFFECT_' + input.outcome.toUpperCase(),
          0,
          attempt.export_id,
          attempt.resource_id,
        );
        return { outcome: input.outcome, replayed: false };
      });
    },
  });
}
