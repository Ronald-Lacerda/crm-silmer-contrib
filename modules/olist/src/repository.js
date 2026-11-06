import { randomUUID } from 'node:crypto';
import { OlistError, integer, text, object } from './errors.js';
import { seal, open, identityHash } from './crypto.js';
import { normalizeDocument } from './configuration.js';
import { lockOlistActor } from './access.js';
/** Shared canonical identity for read-only plans and durable reservations.
 * Existing valid identities keep exactly the same normalization and hashes.
 * Public audience is optional; a combination of fabrics is not truncated.
 * @param {Buffer} key @param {any} input */
export function olistResourceIdentityHash(key, input) {
  let identity;
  if (input.kind === 'customer') identity = normalizeDocument(input.identity);
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
    if (fields.some((field) => !Object.hasOwn(value, field)))
      throw new OlistError('INVALID_REQUEST', 400);
    identity = fields.map((field) => {
      const raw = value[field];
      const optionalAudience = field === 'audience' && raw === '';
      const normalized = optionalAudience
        ? ''
        : text(raw, field === 'fabric' ? 12000 : 200);
      return normalized.normalize('NFC').toLocaleLowerCase('pt-BR');
    });
  } else if (input.kind === 'variation')
    identity = [
      text(input.parentId, 36),
      text(input.identity, 200).normalize('NFC').toLocaleLowerCase('pt-BR'),
    ];
  else throw new OlistError('INVALID_REQUEST', 400);
  if (!/^[a-f0-9]{64}$/u.test(input.accountKey))
    throw new OlistError('INVALID_REQUEST', 400);
  return identityHash(key, input.kind, [input.accountKey, identity]);
}
/** Stable JSON protects complete server-owned plans without publishing their content.
 * @param {unknown} value @returns {any} */
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(/** @type {any} */ (value)[key])]),
    );
  throw new OlistError('INVALID_REQUEST', 400);
}
/** @param {unknown} value */
function requestPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OlistError('INVALID_REQUEST', 400);
  const normalized = canonical(value);
  if (Buffer.byteLength(JSON.stringify(normalized)) > 131072)
    throw new OlistError('INVALID_REQUEST', 400);
  return normalized;
}
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
  /** Final local command gate. It never performs HTTP and is also applied
   * before an existing operation is returned through a new idempotency key.
   * @param {any} client @param {any} input */
  async function exportCommandGuard(client, input) {
    await lockOlistActor(client, input, 'olist.export', clock());
    const connection = (
      await client.query(
        'SELECT c.*,a.creation_enabled,a.recovery_required FROM crm.olist_connections c JOIN crm.olist_accounts a USING(account_key) WHERE c.context_key=$1 AND c.account_key=$2 FOR SHARE OF c,a',
        [input.contextKey, input.accountKey],
      )
    ).rows[0];
    if (!connection?.creation_enabled || connection.recovery_required)
      throw new OlistError('OLIST_CREATION_DISABLED');
    if (
      connection.reconnect_required ||
      !connection.token_envelope ||
      connection.refresh_nonce ||
      connection.exchange_nonce ||
      !connection.expires_at ||
      new Date(connection.expires_at) <= clock() ||
      (input.connectionGeneration !== undefined &&
        Number(connection.generation) !== input.connectionGeneration) ||
      (input.connectionVersion !== undefined &&
        Number(connection.version) !== input.connectionVersion)
    )
      throw new OlistError('OLIST_CONNECTION_CHANGED');
    return connection;
  }
  /** @param {any} client @param {any} input @param {string} code @param {any} row */
  async function resourceAudit(client, input, code, row) {
    await event(
      client,
      input,
      code,
      Number(row.version),
      input.exportId ?? null,
      row.id,
    );
    await client.query(
      "INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES($1,$2,'olist.resource','olist-resource',$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        input.actor.id,
        row.id,
        String(row.version),
        code,
        text(input.correlationId, 128),
        clock(),
      ],
    );
  }
  /** Lock order/settings/export after the current effect guard. A snapshot from
   * another actor/account/configuration never authorizes an entity creation.
   * @param {any} client @param {any} input @param {boolean} effect */
  async function resolutionGuard(client, input, effect) {
    const connection = effect ? await effectGuard(client, input) : null;
    if (!effect) {
      await lockOlistActor(client, input, 'olist.export', clock());
      const current = (
        await client.query(
          'SELECT generation FROM crm.olist_connections WHERE account_key=$1 AND context_key=$2 FOR SHARE',
          [input.accountKey, input.contextKey],
        )
      ).rows[0];
      if (!current || Number(current.generation) !== input.connectionGeneration)
        throw new OlistError('OLIST_CONNECTION_CHANGED');
    }
    if (
      effect &&
      (Number(connection.version) !== input.connectionVersion ||
        connection.refresh_nonce ||
        connection.exchange_nonce ||
        new Date(connection.expires_at) <= clock())
    )
      throw new OlistError('OLIST_CONNECTION_CHANGED');
    const { rows } = await client.query(
      'SELECT * FROM crm.olist_exports WHERE id=$1 AND account_key=$2 AND context_key=$3 FOR SHARE',
      [input.exportId, input.accountKey, input.contextKey],
    );
    const operation = rows[0];
    if (
      !operation ||
      !['queued', 'resolving', 'ready'].includes(operation.state) ||
      operation.actor_id !== input.actor.id ||
      Number(operation.authorization_version) !== input.authorizationVersion ||
      Number(operation.connection_generation) !== input.connectionGeneration
    )
      throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    const order = await client.query(
      'SELECT version,contact_id,conversation_id FROM crm.orders WHERE id=$1 FOR SHARE',
      [operation.order_id],
    );
    const settings = await client.query(
      'SELECT version FROM crm.olist_settings WHERE account_key=$1 FOR SHARE',
      [input.accountKey],
    );
    if (
      Number(order.rows[0]?.version) !== Number(operation.order_version) ||
      Number(settings.rows[0]?.version) !==
        Number(operation.settings_version) ||
      (input.settingsVersion !== undefined &&
        Number(operation.settings_version) !== input.settingsVersion)
    )
      throw new OlistError('VERSION_CONFLICT');
    const snapshot = open(
      operation.snapshot_envelope,
      options.envelopeKey,
      'export-snapshot',
      input.accountKey,
      operation.id,
    );
    const versions = snapshot?.sourceVersions;
    if (versions !== undefined) {
      if (
        !versions ||
        !Number.isSafeInteger(versions.sourceRevision) ||
        versions.sourceRevision < 0 ||
        !(versions.contactId === null || typeof versions.contactId === 'string')
      )
        throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
      const currentOrder = order.rows[0];
      const currentContact =
        currentOrder.contact_id ??
        (currentOrder.conversation_id
          ? ((
              await client.query(
                'SELECT identity.current_contact_id FROM crm.conversations conversation JOIN crm.contact_identities identity ON identity.id=conversation.contact_identity_id WHERE conversation.id=$1 FOR SHARE OF conversation,identity',
                [currentOrder.conversation_id],
              )
            ).rows[0]?.current_contact_id ?? null)
          : null);
      if (currentContact !== versions.contactId)
        throw new OlistError('VERSION_CONFLICT');
      if (versions.contactId !== null) {
        const contact = (
          await client.query(
            'SELECT version FROM crm.contacts WHERE id=$1 FOR SHARE',
            [versions.contactId],
          )
        ).rows[0];
        if (!contact || Number(contact.version) !== versions.contactVersion)
          throw new OlistError('VERSION_CONFLICT');
      } else if (versions.contactVersion !== null)
        throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
      const currentRevision = (
        await client.query(
          'SELECT COALESCE(max(revision),0)::integer AS revision FROM crm.order_olist_source_revisions WHERE order_id=$1',
          [operation.order_id],
        )
      ).rows[0].revision;
      if (Number(currentRevision) !== versions.sourceRevision)
        throw new OlistError('VERSION_CONFLICT');
    }
    return operation;
  }
  /** @param {any} client @param {any} input @param {string} id @param {string} lock */
  async function linkedResource(client, input, id, lock = 'UPDATE') {
    const { rows } = await client.query(
      'SELECT r.* FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id AND e.account_key=r.account_key WHERE e.export_id=$1 AND r.id=$2 AND r.account_key=$3 FOR ' +
        lock +
        ' OF r',
      [input.exportId, id, input.accountKey],
    );
    if (!rows[0]) throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }
  /** @param {any} input */
  async function reserveResourceEffect(input) {
    integer(input.expectedVersion, true);
    integer(input.connectionVersion, true);
    const payload = requestPayload(input.requestPayload);
    const dependentIds = input.dependentResourceIds ?? [];
    if (
      !Array.isArray(dependentIds) ||
      dependentIds.length > 100 ||
      dependentIds.some((id) => typeof id !== 'string') ||
      new Set(dependentIds).size !== dependentIds.length ||
      dependentIds.includes(input.resourceId)
    )
      throw new OlistError('INVALID_REQUEST', 400);
    return database.transaction(async (/** @type {any} */ client) => {
      await resolutionGuard(client, input, true);
      const row = await linkedResource(client, input, input.resourceId);
      if (Number(row.version) !== input.expectedVersion)
        throw new OlistError('VERSION_CONFLICT');
      if (row.state !== 'pending' || !row.payload_hash)
        throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
      const previous = await client.query(
        'SELECT 1 FROM crm.olist_attempts WHERE resource_id=$1 LIMIT 1',
        [row.id],
      );
      if (previous.rows[0])
        throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      if (
        (dependentIds.length > 0 && row.kind !== 'product') ||
        (row.kind === 'product' && dependentIds.length === 0)
      )
        throw new OlistError('OLIST_PARENT_UNRESOLVED');
      const children = [];
      for (const id of [...dependentIds].sort()) {
        const child = await linkedResource(client, input, id);
        const attempts = await client.query(
          'SELECT 1 FROM crm.olist_attempts WHERE resource_id=$1 LIMIT 1',
          [id],
        );
        if (
          child.kind !== 'variation' ||
          child.parent_id !== row.id ||
          child.state !== 'pending' ||
          !child.payload_hash ||
          attempts.rows[0]
        )
          throw new OlistError('OLIST_PARENT_UNRESOLVED');
        children.push(child);
      }
      if (row.kind === 'variation') {
        const parent = await client.query(
          "SELECT id FROM crm.olist_resources WHERE id=$1 AND account_key=$2 AND state='confirmed' FOR SHARE",
          [row.parent_id, input.accountKey],
        );
        if (!parent.rows[0]) throw new OlistError('OLIST_PARENT_UNRESOLVED');
      }
      const attemptId = randomUUID(),
        fence = randomUUID();
      const requestHash = identityHash(options.hmacKey, 'resource-request', [
        input.accountKey,
        row.id,
        payload,
      ]);
      await client.query(
        'INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,request_envelope,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
        [
          attemptId,
          input.accountKey,
          row.id,
          row.kind,
          fence,
          input.connectionGeneration,
          JSON.stringify(
            seal(
              payload,
              options.envelopeKey,
              'resource-request',
              input.accountKey,
              attemptId,
            ),
          ),
          requestHash,
        ],
      );
      const tickets = [];
      for (const child of children) {
        const childAttempt = randomUUID(),
          childFence = randomUUID();
        await client.query(
          "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,parent_attempt_id) VALUES($1,$2,$3,'variation',$4,$5,$6)",
          [
            childAttempt,
            input.accountKey,
            child.id,
            childFence,
            input.connectionGeneration,
            attemptId,
          ],
        );
        await client.query(
          "UPDATE crm.olist_resources SET state='reserved',version=version+1,updated_at=$2 WHERE id=$1",
          [child.id, clock()],
        );
        await resourceAudit(client, input, 'OLIST_COMPOSITE_EFFECT_RESERVED', {
          ...child,
          version: Number(child.version) + 1,
        });
        tickets.push({
          resourceId: child.id,
          attemptId: childAttempt,
          fence: childFence,
        });
      }
      await client.query(
        "UPDATE crm.olist_resources SET state='reserved',version=version+1,updated_at=$2 WHERE id=$1",
        [row.id, clock()],
      );
      await resourceAudit(client, input, 'OLIST_RESOURCE_EFFECT_RESERVED', {
        ...row,
        version: Number(row.version) + 1,
      });
      return { attemptId, fence, requestHash, children: tickets };
    });
  }
  /** Late outcomes survive revocation: the durable ticket is the authority to
   * record, never authority to dispatch another effect.
   * @param {any} client @param {any} input */
  async function finishResult(client, input) {
    if (!['confirmed', 'uncertain', 'rejected'].includes(input.outcome))
      throw new OlistError('INVALID_REQUEST', 400);
    if (
      input.outcome === 'confirmed' &&
      !/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId))
    )
      throw new OlistError('INVALID_REQUEST', 400);
    const { rows } = await client.query(
      'SELECT * FROM crm.olist_attempts WHERE id=$1 AND account_key=$2 AND fence=$3 FOR UPDATE',
      [input.attemptId, input.accountKey, input.fence],
    );
    const attempt = rows[0];
    if (!attempt) throw new OlistError('OLIST_EFFECT_NOT_FOUND', 404);
    if (attempt.outcome !== 'reserved')
      return { outcome: attempt.outcome, replayed: true };
    const target = attempt.resource_id ? 'olist_resources' : 'olist_exports';
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
    const saved = (
      await client.query(
        'UPDATE crm.' +
          target +
          ' SET state=$2,remote_id=$3,version=version+1,updated_at=$4 WHERE id=$1 RETURNING *',
        [
          id,
          input.outcome,
          input.outcome === 'confirmed' ? String(input.remoteId) : null,
          clock(),
        ],
      )
    ).rows[0];
    if (attempt.resource_id)
      await resourceAudit(
        client,
        input,
        'OLIST_EFFECT_' + input.outcome.toUpperCase(),
        saved,
      );
    else
      await event(
        client,
        input,
        'OLIST_EFFECT_' + input.outcome.toUpperCase(),
        0,
        attempt.export_id,
        null,
      );
    return { outcome: input.outcome, replayed: false };
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
      const protectedIdentity = olistResourceIdentityHash(
        options.hmacKey,
        input,
      );
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
    /** Server-owned base data only: product base excludes the initial sizes so
     * two orders share one parent while their composed request remains frozen.
     * @param {any} input */
    async bindResource(input) {
      const protectedIdentity = olistResourceIdentityHash(
        options.hmacKey,
        input,
      );
      const payload = requestPayload(input.payload);
      if (input.kind === 'product' && Object.hasOwn(payload, 'variacoes'))
        throw new OlistError('INVALID_REQUEST', 400);
      const payloadHash = identityHash(options.hmacKey, 'resource-base', [
        input.accountKey,
        input.kind,
        protectedIdentity,
        payload,
      ]);
      return database.transaction(async (/** @type {any} */ client) => {
        await resolutionGuard(client, input, false);
        if (input.kind === 'variation') {
          const parent = await client.query(
            "SELECT id FROM crm.olist_resources WHERE id=$1 AND account_key=$2 AND kind='product' FOR SHARE",
            [input.parentId, input.accountKey],
          );
          if (!parent.rows[0]) throw new OlistError('OLIST_PARENT_UNRESOLVED');
        }
        const id = randomUUID();
        const inserted = await client.query(
          'INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,parent_id,payload_hash,snapshot_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(account_key,kind,identity_hash) DO NOTHING RETURNING *',
          [
            id,
            input.accountKey,
            input.kind,
            protectedIdentity,
            input.kind === 'customer'
              ? 'CRM-' + id
              : (input.kind === 'product' ? 'CRM-P-' : 'CRM-V-') +
                protectedIdentity,
            input.kind === 'variation' ? input.parentId : null,
            payloadHash,
            JSON.stringify(
              seal(
                payload,
                options.envelopeKey,
                'resource-base',
                input.accountKey,
                id,
              ),
            ),
          ],
        );
        let row = inserted.rows[0];
        if (!row) {
          row = (
            await client.query(
              'SELECT * FROM crm.olist_resources WHERE account_key=$1 AND kind=$2 AND identity_hash=$3 FOR UPDATE',
              [input.accountKey, input.kind, protectedIdentity],
            )
          ).rows[0];
          if (row.payload_hash && row.payload_hash !== payloadHash)
            throw new OlistError('OLIST_RESOURCE_DIVERGENT');
          if (!row.payload_hash) {
            if (!['pending', 'confirmed'].includes(row.state))
              throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
            row = (
              await client.query(
                'UPDATE crm.olist_resources SET payload_hash=$2,snapshot_envelope=$3::jsonb WHERE id=$1 RETURNING *',
                [
                  row.id,
                  payloadHash,
                  JSON.stringify(
                    seal(
                      payload,
                      options.envelopeKey,
                      'resource-base',
                      input.accountKey,
                      row.id,
                    ),
                  ),
                ],
              )
            ).rows[0];
          }
        }
        const attached = await client.query(
          'INSERT INTO crm.olist_export_resources(export_id,resource_id,account_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING resource_id',
          [input.exportId, row.id, input.accountKey],
        );
        if (inserted.rows[0] || attached.rows[0])
          await resourceAudit(client, input, 'OLIST_RESOURCE_BOUND', row);
        return row;
      });
    },
    /** @param {any} input */
    async readResource(input) {
      return database.transaction(async (/** @type {any} */ client) => {
        await resolutionGuard(client, input, false);
        const row = await linkedResource(
          client,
          input,
          input.resourceId,
          'SHARE',
        );
        const attempts = (
          await client.query(
            'SELECT * FROM crm.olist_attempts WHERE resource_id=$1 AND account_key=$2 ORDER BY created_at DESC,id DESC',
            [row.id, input.accountKey],
          )
        ).rows;
        const latestAttempt = attempts[0] ?? null;
        if (latestAttempt) {
          latestAttempt.requestPayload = latestAttempt.request_envelope
            ? open(
                latestAttempt.request_envelope,
                options.envelopeKey,
                'resource-request',
                input.accountKey,
                latestAttempt.id,
              )
            : null;
          latestAttempt.children = (
            await client.query(
              'SELECT id,resource_id,fence,outcome,observed_remote_id FROM crm.olist_attempts WHERE parent_attempt_id=$1 ORDER BY resource_id',
              [latestAttempt.id],
            )
          ).rows;
        }
        return {
          ...row,
          latestAttempt,
          payload: row.snapshot_envelope
            ? open(
                row.snapshot_envelope,
                options.envelopeKey,
                'resource-base',
                input.accountKey,
                row.id,
              )
            : null,
        };
      });
    },
    /** @param {any} input */
    async readExport(input) {
      return database.transaction(async (/** @type {any} */ client) => {
        const row = await resolutionGuard(client, input, false);
        return {
          ...row,
          snapshot: open(
            row.snapshot_envelope,
            options.envelopeKey,
            'export-snapshot',
            input.accountKey,
            row.id,
          ),
        };
      });
    },
    /** Record the identifier returned by POST before any subsequent GET, even
     * when that identifier is the parent rather than the requested variation.
     * @param {any} input */
    async recordObservedResourceId(input) {
      if (!/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId)))
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        const row = (
          await client.query(
            'SELECT * FROM crm.olist_attempts WHERE id=$1 AND account_key=$2 AND fence=$3 FOR UPDATE',
            [input.attemptId, input.accountKey, input.fence],
          )
        ).rows[0];
        if (!row || !row.resource_id)
          throw new OlistError('OLIST_EFFECT_NOT_FOUND', 404);
        if (
          row.observed_remote_id &&
          row.observed_remote_id !== String(input.remoteId)
        )
          throw new OlistError('OLIST_RESOURCE_DIVERGENT');
        if (row.outcome !== 'reserved')
          return {
            observedRemoteId: row.observed_remote_id ?? null,
            replayed: true,
          };
        if (!row.observed_remote_id) {
          await client.query(
            'UPDATE crm.olist_attempts SET observed_remote_id=$2 WHERE id=$1',
            [row.id, String(input.remoteId)],
          );
          await resourceAudit(client, input, 'OLIST_RESOURCE_ID_OBSERVED', {
            id: row.resource_id,
            version: 0,
          });
        }
        return {
          observedRemoteId: String(input.remoteId),
          replayed: Boolean(row.observed_remote_id),
        };
      });
    },
    /** @param {any} input */
    async recordResourceBatchResult(input) {
      if (
        !Array.isArray(input.results) ||
        !input.results.length ||
        input.results.length > 101
      )
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        const results = [];
        for (const value of input.results)
          results.push(
            await finishResult(client, {
              ...input,
              ...value,
              accountKey: input.accountKey,
              actor: input.actor,
              correlationId: input.correlationId,
            }),
          );
        return { results };
      });
    },
    reserveResourceEffect,
    reserveResourceBatchEffect: reserveResourceEffect,
    /** Only a validated GET can establish a no-effect binding. Uncertain or
     * reserved effects cannot be cleared through this lookup path.
     * @param {any} input */
    async confirmResourceLookup(input) {
      integer(input.expectedVersion, true);
      if (!/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId)))
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        await resolutionGuard(client, input, false);
        const row = await linkedResource(client, input, input.resourceId);
        if (
          row.state === 'confirmed' &&
          row.remote_id === String(input.remoteId)
        )
          return row;
        if (Number(row.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        const attempts = await client.query(
          'SELECT 1 FROM crm.olist_attempts WHERE resource_id=$1 LIMIT 1',
          [row.id],
        );
        if (row.state !== 'pending' || attempts.rows[0])
          throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        const saved = (
          await client.query(
            "UPDATE crm.olist_resources SET state='confirmed',remote_id=$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *",
            [row.id, String(input.remoteId), clock()],
          )
        ).rows[0];
        await resourceAudit(
          client,
          input,
          'OLIST_RESOURCE_LOOKUP_CONFIRMED',
          saved,
        );
        return saved;
      });
    },
    /** Positive reconciliation appends proof; an uncertain attempt is never
     * rewritten and zero matches cannot invoke this command.
     * @param {any} input */
    async reconcileResourceLookup(input) {
      integer(input.expectedVersion, true);
      if (!/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId)))
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        await resolutionGuard(client, input, false);
        const row = await linkedResource(client, input, input.resourceId);
        if (
          row.state === 'confirmed' &&
          row.remote_id === String(input.remoteId)
        )
          return row;
        if (Number(row.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        if (!['reserved', 'uncertain'].includes(row.state))
          throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        const latest = (
          await client.query(
            'SELECT * FROM crm.olist_attempts WHERE resource_id=$1 AND account_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',
            [row.id, input.accountKey],
          )
        ).rows[0];
        if (!latest || !['reserved', 'uncertain'].includes(latest.outcome))
          throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        if (latest.outcome === 'reserved')
          await finishResult(client, {
            ...input,
            attemptId: latest.id,
            fence: latest.fence,
            outcome: 'confirmed',
            response: { proof: 'verified_lookup' },
          });
        else {
          const saved = (
            await client.query(
              "UPDATE crm.olist_resources SET state='confirmed',remote_id=$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *",
              [row.id, String(input.remoteId), clock()],
            )
          ).rows[0];
          await resourceAudit(
            client,
            input,
            'OLIST_RESOURCE_RECONCILED',
            saved,
          );
        }
        return (
          await client.query('SELECT * FROM crm.olist_resources WHERE id=$1', [
            row.id,
          ])
        ).rows[0];
      });
    },
    /** Lock a logical command target before comparing a new preview receipt.
     * Server-only result includes its authenticated snapshot, never a public spread.
     * @param {any} input */
    async findExport(input) {
      text(input.orderId, 200);
      const work = async (/** @type {any} */ client) => {
        await exportCommandGuard(client, input);
        const order = await client.query(
          'SELECT id FROM crm.orders WHERE id=$1 FOR UPDATE',
          [input.orderId],
        );
        if (!order.rows[0]) throw new OlistError('ORDER_NOT_FOUND', 404);
        const row = (
          await client.query(
            'SELECT * FROM crm.olist_exports WHERE account_key=$1 AND order_id=$2',
            [input.accountKey, input.orderId],
          )
        ).rows[0];
        return row
          ? {
              ...row,
              snapshot: open(
                row.snapshot_envelope,
                options.envelopeKey,
                'export-snapshot',
                input.accountKey,
                row.id,
              ),
            }
          : null;
      };
      return input.transaction
        ? work(input.transaction)
        : database.transaction(work);
    },
    /** The caller may own the idempotency/audit transaction. The operation,
     * encrypted snapshot, queue publication and audit use that exact client.
     * @param {any} input */
    async prepareExport(input) {
      integer(input.orderVersion);
      integer(input.settingsVersion, true);
      integer(input.authorizationVersion, true);
      integer(input.connectionGeneration, true);
      if (input.connectionVersion !== undefined)
        integer(input.connectionVersion, true);
      const snapshot = requestPayload(input.snapshot);
      const fingerprint =
        input.snapshotFingerprint ??
        identityHash(options.hmacKey, 'export-command', [
          input.accountKey,
          input.contextKey,
          input.connectionGeneration,
          input.orderId,
          input.orderVersion,
          input.settingsVersion,
          snapshot,
        ]);
      if (
        typeof fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(fingerprint)
      )
        throw new OlistError('INVALID_REQUEST', 400);
      const work = async (/** @type {any} */ client) => {
        await exportCommandGuard(client, input);
        const order = await client.query(
          'SELECT version FROM crm.orders WHERE id=$1 FOR UPDATE',
          [input.orderId],
        );
        if (!order.rows[0]) throw new OlistError('ORDER_NOT_FOUND', 404);
        const existing = (
          await client.query(
            'SELECT * FROM crm.olist_exports WHERE account_key=$1 AND order_id=$2',
            [input.accountKey, input.orderId],
          )
        ).rows[0];
        if (existing) {
          if (existing.command_fingerprint !== fingerprint)
            throw new OlistError('OLIST_EXPORT_CONFLICT');
          return existing;
        }
        if (Number(order.rows[0].version) !== input.orderVersion)
          throw new OlistError('VERSION_CONFLICT');
        const settings = await client.query(
          'SELECT version FROM crm.olist_settings WHERE account_key=$1 FOR SHARE',
          [input.accountKey],
        );
        if (Number(settings.rows[0]?.version) !== input.settingsVersion)
          throw new OlistError('VERSION_CONFLICT');
        const id = randomUUID();
        const reference = 'CRM-' + id;
        const row = (
          await client.query(
            'INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope,command_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *',
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
                  snapshot,
                  options.envelopeKey,
                  'export-snapshot',
                  input.accountKey,
                  id,
                ),
              ),
              fingerprint,
            ],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,olist_export_id,status,queue,effect_policy,available_at,created_at,updated_at) VALUES($1,'olist.export',$2,$3,'pending','olist','queryable',$4,$4,$4)",
          [randomUUID(), id, id, clock()],
        );
        await event(client, input, 'OLIST_EXPORT_QUEUED', 1, id);
        await client.query(
          "INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES($1,$2,'olist.export.request','olist-export',$3,'1','OLIST_EXPORT_QUEUED',$4,$5)",
          [
            randomUUID(),
            input.actor.id,
            id,
            text(input.correlationId, 128),
            clock(),
          ],
        );
        return row;
      };
      return input.transaction
        ? work(input.transaction)
        : database.transaction(work);
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
      return database.transaction((/** @type {any} */ client) =>
        finishResult(client, input),
      );
    },
  });
}
