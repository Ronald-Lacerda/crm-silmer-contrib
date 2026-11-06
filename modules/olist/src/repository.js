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
    const target = (
      await client.query(
        'SELECT order_id FROM crm.olist_exports WHERE id=$1 AND account_key=$2 AND context_key=$3',
        [input.exportId, input.accountKey, input.contextKey],
      )
    ).rows[0];
    if (!target) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    const reference = (
      await client.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [
        target.order_id,
      ])
    ).rows[0];
    if (reference?.conversation_id)
      await client.query(
        'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
        [reference.conversation_id],
      );
    const lockedOrder = (
      await client.query(
        'SELECT cancelled_at FROM crm.orders WHERE id=$1 FOR SHARE',
        [target.order_id],
      )
    ).rows[0];
    if (!lockedOrder || lockedOrder.cancelled_at)
      throw new OlistError('ORDER_CANCELLED');
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
    if (
      attempt.stage === 'sale' &&
      attempt.request_hash &&
      input.outcome === 'confirmed'
    )
      throw new OlistError('OLIST_SALE_READBACK_REQUIRED');
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
  /** T08 dispatch lock order: current authority/connection, conversation, order,
   * then export. Never upgrade a shared export lock between competing workers.
   * @param {any} client @param {any} input */
  async function dispatchGuard(client, input) {
    await exportCommandGuard(client, input);
    const target = (
      await client.query(
        'SELECT order_id FROM crm.olist_exports WHERE id=$1 AND account_key=$2 AND context_key=$3',
        [input.exportId, input.accountKey, input.contextKey],
      )
    ).rows[0];
    if (!target) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    const order = (
      await client.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [
        target.order_id,
      ])
    ).rows[0];
    if (!order) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    if (order.conversation_id)
      await client.query(
        'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
        [order.conversation_id],
      );
    await client.query('SELECT id FROM crm.orders WHERE id=$1 FOR SHARE', [
      target.order_id,
    ]);
    const row = (
      await client.query(
        'SELECT * FROM crm.olist_exports WHERE id=$1 AND account_key=$2 FOR UPDATE',
        [input.exportId, input.accountKey],
      )
    ).rows[0];
    await resolutionGuard(client, input, false);
    return row;
  }
  /** @param {any} client @param {any} input @param {string} code @param {any} row */
  async function saleAudit(client, input, code, row) {
    await event(
      client,
      { ...input, actor: { id: row.actor_id } },
      code,
      Number(row.version),
      row.id,
    );
    await client.query(
      "INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES($1,$2,'olist.sale','olist-export',$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        row.actor_id,
        row.id,
        String(row.version),
        code,
        text(input.correlationId, 128),
        clock(),
      ],
    );
  }
  /** @param {any} client @param {any} input */
  async function saleTicket(client, input) {
    const attempt = (
      await client.query(
        "SELECT * FROM crm.olist_attempts WHERE id=$1 AND account_key=$2 AND fence=$3 AND stage='sale' AND export_id IS NOT NULL FOR UPDATE",
        [input.attemptId, input.accountKey, input.fence],
      )
    ).rows[0];
    if (!attempt) throw new OlistError('OLIST_EFFECT_NOT_FOUND', 404);
    const row = (
      await client.query(
        'SELECT * FROM crm.olist_exports WHERE id=$1 AND account_key=$2 FOR UPDATE',
        [attempt.export_id, input.accountKey],
      )
    ).rows[0];
    if (!row) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    return { attempt, row };
  }
  /** All required identities must still be confirmed and bound to this export.
   * The mapping is canonicalized by snapshot group/line identity, never position.
   * @param {any} client @param {any} input @param {any} row @param {any} raw */
  async function checkedMapping(client, input, row, raw) {
    const snapshot = open(
      row.snapshot_envelope,
      options.envelopeKey,
      'export-snapshot',
      input.accountKey,
      row.id,
    );
    if (
      !raw ||
      raw.resolved !== true ||
      !Array.isArray(raw.groups) ||
      !Array.isArray(snapshot.commercial?.groups) ||
      raw.groups.length !== snapshot.commercial.groups.length
    )
      throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
    const resources = (
      await client.query(
        'SELECT r.* FROM crm.olist_export_resources e JOIN crm.olist_resources r ON r.id=e.resource_id AND r.account_key=e.account_key WHERE e.export_id=$1 AND e.account_key=$2 ORDER BY r.id FOR SHARE OF r',
        [row.id, input.accountKey],
      )
    ).rows;
    if (resources.some((/** @type {any} */ r) => r.state !== 'confirmed'))
      throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
    /** @param {string} kind @param {string} hash @param {unknown} remoteId */
    function resource(kind, hash, remoteId) {
      if (typeof remoteId !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(remoteId))
        throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
      const found = resources.filter(
        (/** @type {any} */ r) =>
          r.kind === kind &&
          r.identity_hash === hash &&
          r.remote_id === remoteId,
      );
      if (found.length !== 1)
        throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
      return found[0];
    }
    resource(
      'customer',
      olistResourceIdentityHash(options.hmacKey, {
        accountKey: input.accountKey,
        kind: 'customer',
        identity: snapshot.customer?.cpfCnpj,
      }),
      raw.customerId,
    );
    const seenGroups = new Set();
    const groups = snapshot.commercial.groups.map(
      (/** @type {any} */ group) => {
        const selected = raw.groups.filter(
          (/** @type {any} */ candidate) => candidate.groupId === group.groupId,
        );
        if (
          selected.length !== 1 ||
          seenGroups.has(group.groupId) ||
          !Array.isArray(selected[0].lines) ||
          selected[0].lines.length !== group.lines.length
        )
          throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
        seenGroups.add(group.groupId);
        const mapping = selected[0];
        const parent = resource(
          'product',
          olistResourceIdentityHash(options.hmacKey, {
            accountKey: input.accountKey,
            kind: 'product',
            identity: group.attributes,
          }),
          mapping.productId,
        );
        const seenLines = new Set();
        const lines = group.lines.map((/** @type {any} */ line) => {
          const candidates = mapping.lines.filter(
            (/** @type {any} */ candidate) => candidate.lineId === line.lineId,
          );
          if (candidates.length !== 1 || seenLines.has(line.lineId))
            throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
          seenLines.add(line.lineId);
          const candidate = candidates[0];
          const variation = resource(
            'variation',
            olistResourceIdentityHash(options.hmacKey, {
              accountKey: input.accountKey,
              kind: 'variation',
              parentId: parent.id,
              identity: line.size,
            }),
            candidate.productId,
          );
          if (variation.parent_id !== parent.id)
            throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
          return { lineId: line.lineId, productId: candidate.productId };
        });
        return { groupId: group.groupId, productId: mapping.productId, lines };
      },
    );
    return { resolved: true, customerId: raw.customerId, groups };
  }
  return Object.freeze({
    /** Persist only a bounded safe classification. This is not effect authority.
     * @param {any} input */
    async recordDispatchStop(input) {
      const allowed = new Set([
        'ORDER_CANCELLED',
        'FORBIDDEN',
        'VERSION_CONFLICT',
        'OLIST_CREATION_DISABLED',
        'OLIST_CONNECTION_CHANGED',
        'OLIST_RECONNECT_REQUIRED',
        'OLIST_RATE_LIMITED',
        'OLIST_UNAVAILABLE',
        'OLIST_RESOURCE_UNCERTAIN',
        'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
        'OLIST_SALE_UNCERTAIN',
        'OLIST_SALE_READBACK_MISMATCH',
        'OLIST_SALE_DIVERGENT',
        'OLIST_RESOURCES_UNRESOLVED',
        'OLIST_RESOURCE_DIVERGENT',
        'OLIST_RESOURCE_UNAVAILABLE',
        'OLIST_RESOURCE_PERSISTENCE_FAILED',
        'OLIST_EXACT_CENT_READBACK_MISMATCH',
        'OLIST_EXPORT_UNAVAILABLE',
        'OLIST_PAYMENT_DUE_REQUIRED',
        'OLIST_SALE_PLAN_INVALID',
        'OLIST_SALE_EXACT_CENT_REQUIRED',
        'OLIST_SALE_ALREADY_EXISTS',
        'OLIST_SALE_REQUEST_CHANGED',
        'OLIST_JOB_LEASE_LOST',
        'OLIST_PERSISTENCE_FAILED',
        'OLIST_DISPATCH_FAILED',
      ]);
      const code = allowed.has(input.code)
        ? input.code
        : 'OLIST_DISPATCH_STOPPED';
      return database.transaction(async (/** @type {any} */ client) => {
        const row = (
          await client.query(
            'SELECT * FROM crm.olist_exports WHERE id=$1 AND account_key=$2 AND context_key=$3 FOR UPDATE',
            [input.exportId, input.accountKey, input.contextKey],
          )
        ).rows[0];
        if (!row) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
        if (
          ['confirmed', 'linked'].includes(row.state) ||
          (row.state === 'invalidated' &&
            row.last_error_code === 'ORDER_CANCELLED') ||
          row.last_error_code === code
        )
          return row;
        const saved = (
          await client.query(
            'UPDATE crm.olist_exports SET last_error_code=$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *',
            [row.id, code, clock()],
          )
        ).rows[0];
        await saleAudit(client, input, 'OLIST_DISPATCH_STOPPED', saved);
        return saved;
      });
    },
    /** Server-only worker lookup, deliberately independent of current grant.
     * It can recover known tickets, but is never authority for another POST.
     * @param {any} input */
    async loadDispatchContext(input) {
      return database.transaction(async (/** @type {any} */ client) => {
        const row = (
          await client.query(
            'SELECT * FROM crm.olist_exports WHERE id=$1 AND ($2::text IS NULL OR account_key=$2) AND ($3::text IS NULL OR context_key=$3) FOR SHARE',
            [
              input.exportId,
              input.accountKey ?? null,
              input.contextKey ?? null,
            ],
          )
        ).rows[0];
        if (!row) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
        const attempt =
          (
            await client.query(
              "SELECT * FROM crm.olist_attempts WHERE export_id=$1 AND account_key=$2 AND stage='sale' ORDER BY created_at DESC,id DESC LIMIT 1",
              [row.id, row.account_key],
            )
          ).rows[0] ?? null;
        const resourceMapping = row.resource_mapping_envelope
          ? open(
              row.resource_mapping_envelope,
              options.envelopeKey,
              'sale-resources',
              row.account_key,
              row.id,
            )
          : null;
        return {
          ...row,
          resourceMapping,
          actor: { id: row.actor_id, kind: 'human' },
          authorizationVersion: Number(row.authorization_version),
          connectionGeneration: Number(row.connection_generation),
          settingsVersion: Number(row.settings_version),
          accountKey: row.account_key,
          contextKey: row.context_key,
          snapshot: open(
            row.snapshot_envelope,
            options.envelopeKey,
            'export-snapshot',
            row.account_key,
            row.id,
          ),
          resources: row.resource_mapping_envelope
            ? open(
                row.resource_mapping_envelope,
                options.envelopeKey,
                'sale-resources',
                row.account_key,
                row.id,
              )
            : null,
          saleAttempt: attempt
            ? {
                ...attempt,
                attemptId: attempt.id,
                observedRemoteId:
                  attempt.observed_remote_id ?? row.observed_sale_id ?? null,
                observedNumber:
                  attempt.observed_remote_number ??
                  row.observed_sale_number ??
                  null,
                requestPayload: attempt.request_envelope
                  ? open(
                      attempt.request_envelope,
                      options.envelopeKey,
                      'sale-request',
                      row.account_key,
                      attempt.id,
                    )
                  : null,
              }
            : null,
        };
      });
    },
    /** @param {any} input */
    async validateDispatch(input) {
      return database.transaction((/** @type {any} */ client) =>
        dispatchGuard(client, input),
      );
    },
    /** @param {any} input */
    async updateStage(input) {
      const stages = ['customer', 'product', 'variation', 'sale'];
      if (
        !stages.includes(input.stage) ||
        (input.state !== undefined &&
          !['resolving', 'ready'].includes(input.state))
      )
        throw new OlistError('INVALID_REQUEST', 400);
      return database.transaction(async (/** @type {any} */ client) => {
        const row = await dispatchGuard(client, input);
        if (
          input.expectedVersion !== undefined &&
          Number(row.version) !== input.expectedVersion
        )
          throw new OlistError('VERSION_CONFLICT');
        if (stages.indexOf(input.stage) < stages.indexOf(row.stage)) return row;
        if (input.state === 'ready' || row.state === 'ready') {
          if (row.state === 'ready' && input.stage === 'sale') return row;
          throw new OlistError('OLIST_RESOURCES_UNRESOLVED');
        }
        if (row.stage === input.stage && row.state === 'resolving') return row;
        const saved = (
          await client.query(
            "UPDATE crm.olist_exports SET state='resolving',stage=$2,last_error_code=NULL,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *",
            [row.id, input.stage, clock()],
          )
        ).rows[0];
        await saleAudit(client, input, 'OLIST_STAGE_CHANGED', saved);
        return saved;
      });
    },
    /** @param {any} input */
    async markReady(input) {
      return database.transaction(async (/** @type {any} */ client) => {
        const row = await dispatchGuard(client, input);
        const mapping = await checkedMapping(
          client,
          input,
          row,
          input.resources,
        );
        const hash = identityHash(options.hmacKey, 'sale-resources', [
          input.accountKey,
          row.id,
          mapping,
        ]);
        if (row.resource_mapping_hash && row.resource_mapping_hash !== hash)
          throw new OlistError('OLIST_RESOURCE_DIVERGENT');
        if (row.state === 'ready') return { ...row, resources: mapping };
        const saved = (
          await client.query(
            "UPDATE crm.olist_exports SET state='ready',stage='sale',last_error_code=NULL,resource_mapping_hash=$2,resource_mapping_envelope=$3::jsonb,version=version+1,updated_at=$4 WHERE id=$1 RETURNING *",
            [
              row.id,
              hash,
              JSON.stringify(
                seal(
                  mapping,
                  options.envelopeKey,
                  'sale-resources',
                  input.accountKey,
                  row.id,
                ),
              ),
              clock(),
            ],
          )
        ).rows[0];
        await saleAudit(client, input, 'OLIST_SALE_READY', saved);
        return { ...saved, resources: mapping };
      });
    },
    /** @param {any} input */
    async reserveSaleEffect(input) {
      integer(input.connectionVersion, true);
      const payload = requestPayload(input.requestPayload);
      return database.transaction(async (/** @type {any} */ client) => {
        const row = await dispatchGuard(client, input);
        if (
          row.state !== 'ready' ||
          row.stage !== 'sale' ||
          !row.resource_mapping_envelope
        )
          throw new OlistError('OLIST_SALE_NOT_READY');
        if (
          input.expectedVersion !== undefined &&
          Number(row.version) !== input.expectedVersion
        )
          throw new OlistError('VERSION_CONFLICT');
        const attempts = await client.query(
          "SELECT 1 FROM crm.olist_attempts WHERE export_id=$1 AND stage='sale' LIMIT 1",
          [row.id],
        );
        if (attempts.rows[0])
          throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
        await checkedMapping(
          client,
          input,
          row,
          open(
            row.resource_mapping_envelope,
            options.envelopeKey,
            'sale-resources',
            input.accountKey,
            row.id,
          ),
        );
        const attemptId = randomUUID(),
          fence = randomUUID();
        await client.query(
          "INSERT INTO crm.olist_attempts(id,account_key,export_id,stage,fence,generation,request_envelope,request_hash) VALUES($1,$2,$3,'sale',$4,$5,$6::jsonb,$7)",
          [
            attemptId,
            input.accountKey,
            row.id,
            fence,
            input.connectionGeneration,
            JSON.stringify(
              seal(
                payload,
                options.envelopeKey,
                'sale-request',
                input.accountKey,
                attemptId,
              ),
            ),
            identityHash(options.hmacKey, 'sale-request', [
              input.accountKey,
              row.id,
              payload,
            ]),
          ],
        );
        const saved = (
          await client.query(
            "UPDATE crm.olist_exports SET state='reserved',stage='sale',last_error_code=NULL,version=version+1,updated_at=$2 WHERE id=$1 RETURNING *",
            [row.id, clock()],
          )
        ).rows[0];
        await saleAudit(client, input, 'OLIST_SALE_EFFECT_RESERVED', saved);
        return { attemptId, fence };
      });
    },
    /** @param {any} input */
    async persistSaleObservedId(input) {
      if (!/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId)))
        throw new OlistError('INVALID_REQUEST', 400);
      const number =
        input.remoteNumber === undefined || input.remoteNumber === null
          ? null
          : text(String(input.remoteNumber), 64);
      return database.transaction(async (/** @type {any} */ client) => {
        const { attempt, row } = await saleTicket(client, input);
        const observedId = attempt.observed_remote_id ?? row.observed_sale_id;
        const observedNumber =
          attempt.observed_remote_number ?? row.observed_sale_number;
        if (
          (observedId && observedId !== String(input.remoteId)) ||
          (number && observedNumber && number !== observedNumber)
        )
          throw new OlistError('OLIST_SALE_DIVERGENT');
        let changed = false;
        if (!row.observed_sale_id || (number && !row.observed_sale_number)) {
          await client.query(
            'UPDATE crm.olist_exports SET observed_sale_id=COALESCE(observed_sale_id,$2),observed_sale_number=COALESCE(observed_sale_number,$3) WHERE id=$1',
            [row.id, String(input.remoteId), number],
          );
          changed = true;
        }
        if (
          attempt.outcome === 'reserved' &&
          (!attempt.observed_remote_id ||
            (number && !attempt.observed_remote_number))
        ) {
          await client.query(
            'UPDATE crm.olist_attempts SET observed_remote_id=COALESCE(observed_remote_id,$2),observed_remote_number=COALESCE(observed_remote_number,$3) WHERE id=$1',
            [attempt.id, String(input.remoteId), number],
          );
          changed = true;
        }
        if (changed)
          await saleAudit(client, input, 'OLIST_SALE_ID_OBSERVED', row);
        return {
          observedRemoteId: String(input.remoteId),
          observedNumber: observedNumber ?? number,
          replayed: !changed,
        };
      });
    },
    /** @param {any} input */
    async markSaleUncertain(input) {
      return database.transaction(async (/** @type {any} */ client) => {
        const { attempt, row } = await saleTicket(client, input);
        if (row.state === 'confirmed' || row.state === 'linked')
          return { outcome: row.state, replayed: true };
        if (attempt.outcome === 'reserved')
          await client.query(
            "UPDATE crm.olist_attempts SET outcome='uncertain',safe_code='OLIST_SALE_UNCERTAIN',finished_at=$2,response_envelope=$3::jsonb WHERE id=$1",
            [
              attempt.id,
              clock(),
              JSON.stringify(
                seal(
                  { observedRemoteId: attempt.observed_remote_id ?? null },
                  options.envelopeKey,
                  'effect-response',
                  input.accountKey,
                  attempt.id,
                ),
              ),
            ],
          );
        if (row.state !== 'uncertain') {
          const saved = (
            await client.query(
              "UPDATE crm.olist_exports SET state='uncertain',stage='sale',last_error_code='OLIST_SALE_UNCERTAIN',version=version+1,updated_at=$2 WHERE id=$1 RETURNING *",
              [row.id, clock()],
            )
          ).rows[0];
          await saleAudit(client, input, 'OLIST_SALE_UNCERTAIN', saved);
        }
        return {
          outcome: 'uncertain',
          replayed: attempt.outcome !== 'reserved',
        };
      });
    },
    /** Positive readback is caller-verified and cannot authorize a POST. A
     * historical uncertain attempt remains immutable when proof arrives later.
     * @param {any} input */
    async finishSale(input) {
      if (
        input.matched !== true ||
        !/^[1-9][0-9]{0,18}$/u.test(String(input.remoteId))
      )
        throw new OlistError('INVALID_REQUEST', 400);
      if (
        (typeof input.number !== 'string' &&
          (!Number.isSafeInteger(input.number) || input.number < 1)) ||
        input.number === null
      )
        throw new OlistError('INVALID_REQUEST', 400);
      const number = text(String(input.number), 64);
      return database.transaction(async (/** @type {any} */ client) => {
        const { attempt, row } = await saleTicket(client, input);
        if (
          ((attempt.observed_remote_id ?? row.observed_sale_id) &&
            (attempt.observed_remote_id ?? row.observed_sale_id) !==
              String(input.remoteId)) ||
          ((attempt.observed_remote_number ?? row.observed_sale_number) &&
            (attempt.observed_remote_number ?? row.observed_sale_number) !==
              number)
        )
          throw new OlistError('OLIST_SALE_DIVERGENT');
        if (row.state === 'confirmed') {
          if (
            row.remote_id !== String(input.remoteId) ||
            row.remote_number !== number
          )
            throw new OlistError('OLIST_SALE_DIVERGENT');
          return { outcome: 'confirmed', replayed: true };
        }
        if (
          !['reserved', 'uncertain'].includes(row.state) ||
          !['reserved', 'uncertain'].includes(attempt.outcome)
        )
          throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
        const snapshot = open(
          row.snapshot_envelope,
          options.envelopeKey,
          'export-snapshot',
          input.accountKey,
          row.id,
        );
        const lineCount = snapshot.commercial.groups.reduce(
          (/** @type {number} */ sum, /** @type {any} */ group) =>
            sum + group.lines.length,
          0,
        );
        if (
          !input.proof ||
          input.proof.matched !== true ||
          input.proof.lineCount !== lineCount ||
          input.proof.totalCents !== snapshot.commercial.totalCents
        )
          throw new OlistError('OLIST_SALE_DIVERGENT');
        const proof = {
          matched: true,
          remoteId: String(input.remoteId),
          number,
          lineCount,
          totalCents: snapshot.commercial.totalCents,
        };
        if (attempt.outcome === 'reserved')
          await client.query(
            "UPDATE crm.olist_attempts SET observed_remote_id=COALESCE(observed_remote_id,$2),observed_remote_number=COALESCE(observed_remote_number,$3),outcome='confirmed',safe_code='OLIST_SALE_CONFIRMED',finished_at=$4,response_envelope=$5::jsonb WHERE id=$1",
            [
              attempt.id,
              String(input.remoteId),
              number,
              clock(),
              JSON.stringify(
                seal(
                  proof,
                  options.envelopeKey,
                  'effect-response',
                  input.accountKey,
                  attempt.id,
                ),
              ),
            ],
          );
        const saved = (
          await client.query(
            "UPDATE crm.olist_exports SET state='confirmed',stage='complete',last_error_code=NULL,remote_id=$2,remote_number=$3,observed_sale_id=COALESCE(observed_sale_id,$2),observed_sale_number=COALESCE(observed_sale_number,$3),readback_envelope=$4::jsonb,version=version+1,updated_at=$5 WHERE id=$1 RETURNING *",
            [
              row.id,
              String(input.remoteId),
              number,
              JSON.stringify(
                seal(
                  proof,
                  options.envelopeKey,
                  'sale-readback',
                  input.accountKey,
                  row.id,
                ),
              ),
              clock(),
            ],
          )
        ).rows[0];
        await saleAudit(
          client,
          input,
          attempt.outcome === 'uncertain'
            ? 'OLIST_SALE_RECONCILED'
            : 'OLIST_SALE_CONFIRMED',
          saved,
        );
        return { outcome: 'confirmed', replayed: false };
      });
    },
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
          'SELECT id,cancelled_at FROM crm.orders WHERE id=$1 FOR UPDATE',
          [input.orderId],
        );
        if (!order.rows[0]) throw new OlistError('ORDER_NOT_FOUND', 404);
        if (order.rows[0].cancelled_at) throw new OlistError('ORDER_CANCELLED');
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
          'SELECT version,cancelled_at FROM crm.orders WHERE id=$1 FOR UPDATE',
          [input.orderId],
        );
        if (!order.rows[0]) throw new OlistError('ORDER_NOT_FOUND', 404);
        if (order.rows[0].cancelled_at) throw new OlistError('ORDER_CANCELLED');
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
        if (!resource) {
          const targetOrder = (
            await client.query(
              'SELECT order_id FROM crm.olist_exports WHERE id=$1 AND account_key=$2',
              [id, input.accountKey],
            )
          ).rows[0];
          if (!targetOrder) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
          const referenceOrder = (
            await client.query(
              'SELECT conversation_id FROM crm.orders WHERE id=$1',
              [targetOrder.order_id],
            )
          ).rows[0];
          if (referenceOrder?.conversation_id)
            await client.query(
              'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
              [referenceOrder.conversation_id],
            );
          const activeOrder = (
            await client.query(
              'SELECT cancelled_at FROM crm.orders WHERE id=$1 FOR SHARE',
              [targetOrder.order_id],
            )
          ).rows[0];
          if (!activeOrder || activeOrder.cancelled_at)
            throw new OlistError('ORDER_CANCELLED');
        }
        const { rows } = await client.query(
          'SELECT * FROM crm.' +
            target +
            ' WHERE id=$1 AND account_key=$2 FOR UPDATE',
          [id, input.accountKey],
        );
        const row = rows[0];
        if (!resource && row?.resource_mapping_hash)
          throw new OlistError('OLIST_SALE_RESERVATION_REQUIRED');
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
