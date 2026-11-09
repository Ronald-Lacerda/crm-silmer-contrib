import { randomUUID } from 'node:crypto';
import { lockOlistActor } from './access.js';
import { OlistError, integer, text } from './errors.js';
import { open, seal, identityHash } from './crypto.js';
import { olistResourceIdentityHash } from './repository.js';
import { buildCustomerPayload } from './resource-payloads.js';
import { buildOlistSalePayload } from './sale-payload.js';

/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
/** @param {any} value */
const normalize = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('pt-BR');
/** @param {any} value */
function remote(value) {
  if (!/^[1-9][0-9]{0,18}$/u.test(String(value)))
    throw new OlistError('INVALID_REQUEST', 400);
  return String(value);
}
/** @param {any} snapshot */
function semantic(snapshot) {
  return canonical(
    Object.fromEntries(
      [
        'policy',
        'customer',
        'commercial',
        'sourceVersions',
        'productFiscal',
        'settings',
      ].map((key) => [key, snapshot?.[key] ?? null]),
    ),
  );
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE = new Set([
  'FORBIDDEN',
  'OLIST_JOB_LEASE_LOST',
  'OLIST_RESOURCE_NOT_FOUND',
  'OLIST_RESOURCE_DIVERGENT',
  'OLIST_CUSTOMER_DIVERGENT',
  'OLIST_PRODUCT_DIVERGENT',
  'OLIST_PRODUCT_FISCAL_DIVERGENT',
  'OLIST_VARIATION_DIVERGENT',
  'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
  'OLIST_SALE_UNCERTAIN',
  'OLIST_SALE_REQUEST_CHANGED',
  'OLIST_SALE_REFERENCE_CONFLICT',
  'OLIST_SALE_READBACK_MISMATCH',
  'OLIST_SALE_DIVERGENT',
  'OLIST_INCOMPLETE_LOOKUP',
  'OLIST_AMBIGUOUS_MATCH',
  'OLIST_RECONNECT_REQUIRED',
  'OLIST_CONNECTION_CHANGED',
  'OLIST_AUTH',
  'OLIST_UNAVAILABLE',
  'OLIST_RATE_LIMITED',
  'OLIST_INVALID_RESPONSE',
  'OLIST_RECONCILIATION_REQUIRED',
  'OLIST_RECONCILE_FAILED',
  'VERSION_CONFLICT',
]);
/** Administrative persistence has no effect reservation or HTTP port. It uses
 * current administrative authority, independently of an exporter's grant.
 * @param {any} database @param {{envelopeKey:Buffer,hmacKey:Buffer,clock?:()=>Date}} options */
export function createOlistAdminRepository(database, options) {
  const clock = options.clock ?? (() => new Date());
  /** @param {any} input @param {(client:any)=>Promise<any>} work */
  const transaction = async (input, work) => {
    try {
      return await (input.transaction
        ? work(input.transaction)
        : database.transaction(work));
    } catch (error) {
      // Shared identity and sale uniqueness races are conflicts; PostgreSQL
      // details can contain private identities and never cross this boundary.
      if (/** @type {any} */ (error).code === '23505')
        throw new OlistError('VERSION_CONFLICT');
      throw error;
    }
  };
  /** @param {any} value @param {string} purpose @param {string} account @param {string} id */
  const encrypted = (value, purpose, account, id) =>
    JSON.stringify(seal(value, options.envelopeKey, purpose, account, id));
  /** Local-only variant for commands/reads that never call the ERP (the
   * administrative diagnostic): the human actor, session, ACL and
   * authorization version are revalidated under lock and the account/context
   * connection row must exist and be locked FOR SHARE, but a broken, expired
   * or refreshing connection (reconnect_required, no token, exchange/refresh
   * nonce, other generation/version) is NOT an error: the administrator must be
   * able to read the state and invalidate while the ERP is disconnected.
   * Every command that makes HTTP keeps using `guard`.
   * @param {any} tx @param {any} input @param {string} [action] */
  async function guardLocal(tx, input, action = 'olist.reconcile') {
    const actor = await lockOlistActor(tx, input, action, clock());
    const connection = (
      await tx.query(
        'SELECT * FROM crm.olist_connections WHERE context_key=$1 AND account_key=$2 FOR SHARE',
        [input.contextKey, input.accountKey],
      )
    ).rows[0];
    if (!connection) throw new OlistError('OLIST_CONNECTION_CHANGED');
    return { actor, connection };
  }
  /** @param {any} tx @param {any} input @param {string} [action] */
  async function guard(tx, input, action = 'olist.link') {
    const actor = await lockOlistActor(tx, input, action, clock());
    const connection = (
      await tx.query(
        'SELECT * FROM crm.olist_connections WHERE context_key=$1 AND account_key=$2 FOR SHARE',
        [input.contextKey, input.accountKey],
      )
    ).rows[0];
    if (
      !connection ||
      connection.reconnect_required ||
      !connection.token_envelope ||
      connection.exchange_nonce ||
      connection.refresh_nonce ||
      (input.connectionGeneration !== undefined &&
        Number(connection.generation) !== input.connectionGeneration) ||
      (input.connectionVersion !== undefined &&
        Number(connection.version) !== input.connectionVersion)
    )
      throw new OlistError('OLIST_CONNECTION_CHANGED');
    return { actor, connection };
  }
  /** One ACTIVE generation per order/account (migration 0071). The active row
   * always wins; an archived (`invalidated`) generation is returned only for a
   * cancelled order, with `input.includeInvalidated`, or when pinned by id, so
   * the order reads as "no operation" after an administrative invalidation.
   * @param {any} tx @param {any} input @param {boolean} [exclusive] @param {string|null} [pinnedExportId] */
  async function operation(
    tx,
    input,
    exclusive = false,
    pinnedExportId = null,
  ) {
    let order = (
      await tx.query(
        'SELECT id,number,version,conversation_id FROM crm.orders WHERE id=$1',
        [input.orderId],
      )
    ).rows[0];
    if (!order) throw new OlistError('ORDER_NOT_FOUND', 404);
    if (exclusive && order.conversation_id)
      await tx.query('SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE', [
        order.conversation_id,
      ]);
    order = (
      await tx.query(
        'SELECT id,number,version,conversation_id,cancelled_at FROM crm.orders WHERE id=$1 FOR ' +
          (exclusive ? 'UPDATE' : 'SHARE'),
        [order.id],
      )
    ).rows[0];
    let row =
      (
        await tx.query(
          "SELECT * FROM crm.olist_exports WHERE order_id=$1 AND account_key=$2 AND context_key=$3 AND ($4::uuid IS NULL OR id=$4) ORDER BY (state='invalidated'),created_at DESC,id DESC LIMIT 1 FOR " +
            (exclusive ? 'UPDATE' : 'SHARE'),
          [order.id, input.accountKey, input.contextKey, pinnedExportId],
        )
      ).rows[0] ?? null;
    if (
      row?.state === 'invalidated' &&
      !pinnedExportId &&
      !order.cancelled_at &&
      input.includeInvalidated !== true
    )
      row = null;
    return { order, row };
  }
  /** @param {any} tx @param {any} row */
  async function decodeOperation(tx, row) {
    if (!row) return null;
    const attempt =
      (
        await tx.query(
          "SELECT * FROM crm.olist_attempts WHERE export_id=$1 AND account_key=$2 AND stage='sale' ORDER BY created_at DESC,id DESC LIMIT 1",
          [row.id, row.account_key],
        )
      ).rows[0] ?? null;
    const mapping = row.resource_mapping_envelope
      ? open(
          row.resource_mapping_envelope,
          options.envelopeKey,
          'sale-resources',
          row.account_key,
          row.id,
        )
      : null;
    const verifiedParents = (
      await tx.query(
        "SELECT r.remote_id AS id,COALESCE(r.verified_remote_sku,r.reference) AS sku FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id AND e.account_key=r.account_key WHERE e.export_id=$1 AND r.account_key=$2 AND r.kind='product' AND r.state='confirmed' ORDER BY r.id LIMIT 1001",
        [row.id, row.account_key],
      )
    ).rows;
    if (verifiedParents.length > 1000)
      throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
    return {
      ...row,
      verifiedParents: verifiedParents.map((/** @type {any} */ parent) => ({
        remoteId: parent.id,
        sku: parent.sku,
      })),
      resourceMapping: mapping,
      resources: mapping,
      snapshot: open(
        row.snapshot_envelope,
        options.envelopeKey,
        'export-snapshot',
        row.account_key,
        row.id,
      ),
      actor: { id: row.actor_id, kind: 'human' },
      authorizationVersion: Number(row.authorization_version),
      connectionGeneration: Number(row.connection_generation),
      settingsVersion: Number(row.settings_version),
      accountKey: row.account_key,
      contextKey: row.context_key,
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
  }
  /** @param {any} tx @param {any} row */
  async function decodeResource(tx, row) {
    const attempt =
      (
        await tx.query(
          'SELECT * FROM crm.olist_attempts WHERE resource_id=$1 AND account_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
          [row.id, row.account_key],
        )
      ).rows[0] ?? null;
    if (attempt)
      attempt.requestPayload = attempt.request_envelope
        ? open(
            attempt.request_envelope,
            options.envelopeKey,
            'resource-request',
            row.account_key,
            attempt.id,
          )
        : null;
    return {
      ...row,
      payload: row.snapshot_envelope
        ? open(
            row.snapshot_envelope,
            options.envelopeKey,
            'resource-base',
            row.account_key,
            row.id,
          )
        : null,
      latestAttempt: attempt,
    };
  }
  /** @param {any} tx @param {any} input @param {string} code @param {any} row @param {string|null} [resourceId] */
  async function audit(tx, input, code, row, resourceId = null) {
    await tx.query(
      'INSERT INTO crm.olist_events(id,account_key,export_id,resource_id,actor_id,event_code,version,correlation_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        input.accountKey,
        row.export_id ?? row.id,
        resourceId,
        input.actor.id,
        code,
        Number(row.version),
        text(input.correlationId, 128),
        clock(),
      ],
    );
    await tx.query(
      "INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES($1,$2,'olist.administrative.read','olist-export',$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        input.actor.id,
        row.export_id ?? row.id,
        String(row.version),
        code,
        text(input.correlationId, 128),
        clock(),
      ],
    );
  }
  /** @param {any} tx @param {any} input @param {any} exportRow @param {any} snapshot @param {any} mapping */
  async function bindMapping(tx, input, exportRow, snapshot, mapping) {
    if (
      mapping?.resolved !== true ||
      !Array.isArray(mapping.groups) ||
      mapping.groups.length !== snapshot.commercial.groups.length
    )
      throw new OlistError('OLIST_RESOURCE_DIVERGENT');
    /** @param {string} kind @param {any} identity @param {any} payload @param {any} remoteId @param {string|null} [parentId] @param {string|null} [verifiedSku] */
    async function bind(
      kind,
      identity,
      payload,
      remoteId,
      parentId = null,
      verifiedSku = null,
    ) {
      const identityKey = olistResourceIdentityHash(options.hmacKey, {
        accountKey: input.accountKey,
        kind,
        identity,
        parentId,
      });
      const base = canonical(payload);
      const payloadHash = identityHash(options.hmacKey, 'resource-base', [
        input.accountKey,
        kind,
        identityKey,
        base,
      ]);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,parent_id,payload_hash,snapshot_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(account_key,kind,identity_hash) DO NOTHING',
        [
          id,
          input.accountKey,
          kind,
          identityKey,
          kind === 'customer'
            ? 'CRM-' + id
            : (kind === 'product' ? 'CRM-P-' : 'CRM-V-') + identityKey,
          parentId,
          payloadHash,
          encrypted(base, 'resource-base', input.accountKey, id),
        ],
      );
      let row = (
        await tx.query(
          'SELECT * FROM crm.olist_resources WHERE account_key=$1 AND kind=$2 AND identity_hash=$3 FOR UPDATE',
          [input.accountKey, kind, identityKey],
        )
      ).rows[0];
      if (row.payload_hash && row.payload_hash !== payloadHash)
        throw new OlistError('OLIST_RESOURCE_DIVERGENT');
      if (!row.payload_hash)
        row = (
          await tx.query(
            'UPDATE crm.olist_resources SET payload_hash=$2,snapshot_envelope=$3::jsonb WHERE id=$1 RETURNING *',
            [
              row.id,
              payloadHash,
              encrypted(base, 'resource-base', input.accountKey, row.id),
            ],
          )
        ).rows[0];
      const expected = remote(remoteId);
      if (row.state === 'confirmed' && row.remote_id !== expected)
        throw new OlistError('OLIST_RESOURCE_DIVERGENT');
      if (row.state !== 'confirmed') {
        const prior = (
          await tx.query(
            'SELECT 1 FROM crm.olist_attempts WHERE resource_id=$1 LIMIT 1',
            [row.id],
          )
        ).rows[0];
        if (row.state !== 'pending' || prior)
          throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        row = (
          await tx.query(
            "UPDATE crm.olist_resources SET state='confirmed',remote_id=$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *",
            [row.id, expected, clock()],
          )
        ).rows[0];
      }
      if (
        kind === 'product' &&
        verifiedSku !== null &&
        verifiedSku !== undefined
      ) {
        const sku = text(verifiedSku, 100);
        if (row.verified_remote_sku && row.verified_remote_sku !== sku)
          throw new OlistError('OLIST_RESOURCE_DIVERGENT');
        if (!row.verified_remote_sku)
          row = (
            await tx.query(
              'UPDATE crm.olist_resources SET verified_remote_sku=$2 WHERE id=$1 RETURNING *',
              [row.id, sku],
            )
          ).rows[0];
      }
      await tx.query(
        'INSERT INTO crm.olist_export_resources(export_id,resource_id,account_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [exportRow.id, row.id, input.accountKey],
      );
      return row;
    }
    await bind(
      'customer',
      snapshot.customer.cpfCnpj,
      buildCustomerPayload(snapshot.customer, 'CRM-customer'),
      mapping.customerId,
    );
    const seen = new Set();
    for (const group of snapshot.commercial.groups) {
      const found = mapping.groups.filter(
        (/** @type {any} */ entry) => entry.groupId === group.groupId,
      );
      if (
        found.length !== 1 ||
        seen.has(group.groupId) ||
        !Array.isArray(found[0].lines) ||
        found[0].lines.length !== group.lines.length
      )
        throw new OlistError('OLIST_RESOURCE_DIVERGENT');
      seen.add(group.groupId);
      const attrs = Object.fromEntries(
        Object.entries(group.attributes).map(([key, value]) => [
          key,
          normalize(value),
        ]),
      );
      const parent = await bind(
        'product',
        attrs,
        { attributes: attrs, fiscal: snapshot.productFiscal ?? null },
        found[0].productId,
        null,
        found[0].verifiedSku ?? null,
      );
      for (const line of group.lines) {
        const candidates = found[0].lines.filter(
          (/** @type {any} */ value) => value.lineId === line.lineId,
        );
        if (candidates.length !== 1)
          throw new OlistError('OLIST_RESOURCE_DIVERGENT');
        await bind(
          'variation',
          normalize(line.size),
          { size: normalize(line.size) },
          candidates[0].productId,
          parent.id,
        );
      }
    }
    return {
      resolved: true,
      customerId: String(mapping.customerId),
      groups: snapshot.commercial.groups.map((/** @type {any} */ group) => {
        const source = mapping.groups.find(
          (/** @type {any} */ entry) => entry.groupId === group.groupId,
        );
        return {
          groupId: group.groupId,
          productId: String(source.productId),
          lines: group.lines.map((/** @type {any} */ line) => ({
            lineId: line.lineId,
            productId: String(
              source.lines.find(
                (/** @type {any} */ entry) => entry.lineId === line.lineId,
              ).productId,
            ),
          })),
        };
      }),
    };
  }
  /** @param {any} row */
  function requestView(row) {
    return {
      id: row.id,
      requestId: row.id,
      exportId: row.export_id,
      resourceId: row.resource_id,
      stage: row.stage,
      status: row.status,
      version: Number(row.version),
      ...(row.safe_code ? { code: row.safe_code } : {}),
    };
  }
  return Object.freeze({
    /** @param {any} input @param {string} [action] */
    guard: (input, action = 'olist.link') =>
      transaction(input, (/** @type {any} */ tx) => guard(tx, input, action)),
    /** @param {any} input */
    readOperation(input) {
      return transaction(input, async (/** @type {any} */ tx) => {
        await guard(tx, input, input.action ?? 'olist.link');
        const { row } = await operation(tx, input);
        if (
          input.expectedVersion !== undefined &&
          Number(row?.version ?? 0) !== input.expectedVersion
        )
          throw new OlistError('VERSION_CONFLICT');
        return decodeOperation(tx, row);
      });
    },
    /** @param {any} input */
    readResource(input) {
      return transaction(input, async (/** @type {any} */ tx) => {
        await guard(tx, input, input.action ?? 'olist.reconcile');
        const { row } = await operation(tx, input);
        if (!row || (input.exportId && row.id !== input.exportId))
          throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
        const resource = (
          await tx.query(
            'SELECT r.* FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id AND e.account_key=r.account_key WHERE e.export_id=$1 AND r.id=$2 AND r.account_key=$3 FOR SHARE OF r',
            [row.id, input.resourceId, input.accountKey],
          )
        ).rows[0];
        if (!resource) throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
        const result = await decodeResource(tx, resource);
        if (resource.parent_id) {
          const parent = (
            await tx.query(
              'SELECT * FROM crm.olist_resources WHERE id=$1 AND account_key=$2 FOR SHARE',
              [resource.parent_id, input.accountKey],
            )
          ).rows[0];
          result.parent = await decodeResource(tx, parent);
        }
        return result;
      });
    },
    /** @param {any} input */
    commitLink(input) {
      text(input.reason, 1000);
      remote(input.remoteId);
      remote(input.number);
      if (Buffer.byteLength(JSON.stringify(input.snapshot ?? null)) > 131072)
        throw new OlistError('OLIST_PREVIEW_TOO_LARGE', 422);
      integer(input.expectedOperationVersion, true);
      integer(input.expectedOrderVersion);
      integer(input.expectedSettingsVersion, true);
      return transaction(input, async (/** @type {any} */ tx) => {
        const { actor, connection } = await guard(tx, input, 'olist.link');
        const locked = await operation(tx, input, true);
        const order = locked.order;
        if (order.cancelled_at) throw new OlistError('ORDER_CANCELLED');
        let row = locked.row;
        if (row && ['linked', 'confirmed'].includes(row.state)) {
          if (
            row.remote_id !== String(input.remoteId) ||
            row.remote_number !== String(input.number)
          )
            throw new OlistError('OLIST_SALE_DIVERGENT');
          return row;
        }
        if (row && !['queued', 'resolving', 'ready'].includes(row.state))
          throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        if (
          Number(row?.version ?? 0) !== input.expectedOperationVersion ||
          Number(order.version) !== input.expectedOrderVersion
        )
          throw new OlistError('VERSION_CONFLICT');
        const settings = (
          await tx.query(
            'SELECT version FROM crm.olist_settings WHERE account_key=$1 FOR SHARE',
            [input.accountKey],
          )
        ).rows[0];
        if (Number(settings?.version ?? 0) !== input.expectedSettingsVersion)
          throw new OlistError('VERSION_CONFLICT');
        if (
          !input.proof?.matched ||
          !input.snapshot ||
          input.proof.totalCents !== input.snapshot.commercial.totalCents ||
          input.proof.lineCount !==
            input.snapshot.commercial.groups.reduce(
              (/** @type {number} */ n, /** @type {any} */ g) =>
                n + g.lines.length,
              0,
            )
        )
          throw new OlistError('OLIST_SALE_DIVERGENT');
        if (row) {
          if (
            (
              await tx.query(
                "SELECT 1 FROM crm.olist_attempts WHERE export_id=$1 AND stage='sale' LIMIT 1",
                [row.id],
              )
            ).rows[0]
          )
            throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
          const previous = open(
            row.snapshot_envelope,
            options.envelopeKey,
            'export-snapshot',
            input.accountKey,
            row.id,
          );
          if (
            JSON.stringify(semantic(previous)) !==
            JSON.stringify(semantic(input.snapshot))
          )
            throw new OlistError('VERSION_CONFLICT');
        } else {
          const id = input.exportId ?? randomUUID();
          row = (
            await tx.query(
              'INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *',
              [
                id,
                input.accountKey,
                input.contextKey,
                Number(connection.generation),
                order.id,
                Number(order.version),
                input.expectedSettingsVersion,
                actor.id,
                actor.olistAuthorizationVersion,
                'CRM-' + id,
                encrypted(
                  input.snapshot,
                  'export-snapshot',
                  input.accountKey,
                  id,
                ),
              ],
            )
          ).rows[0];
        }
        const mapping = await bindMapping(
          tx,
          input,
          row,
          input.snapshot,
          input.resources,
        );
        const mappingHash = identityHash(options.hmacKey, 'sale-resources', [
          input.accountKey,
          row.id,
          mapping,
        ]);
        if (
          row.resource_mapping_hash &&
          row.resource_mapping_hash !== mappingHash
        )
          throw new OlistError('OLIST_RESOURCE_DIVERGENT');
        const evidence = {
          ...input.proof,
          remoteId: String(input.remoteId),
          number: String(input.number),
          reason: input.reason,
        };
        row = (
          await tx.query(
            "UPDATE crm.olist_exports SET state='linked',stage='complete',remote_id=$2,remote_number=$3,observed_sale_id=COALESCE(observed_sale_id,$2),observed_sale_number=COALESCE(observed_sale_number,$3),resource_mapping_hash=COALESCE(resource_mapping_hash,$4),resource_mapping_envelope=COALESCE(resource_mapping_envelope,$5::jsonb),readback_envelope=$6::jsonb,last_error_code=NULL,version=version+1,updated_at=$7 WHERE id=$1 RETURNING *",
            [
              row.id,
              String(input.remoteId),
              String(input.number),
              mappingHash,
              encrypted(mapping, 'sale-resources', input.accountKey, row.id),
              encrypted(evidence, 'sale-readback', input.accountKey, row.id),
              clock(),
            ],
          )
        ).rows[0];
        await audit(tx, input, 'OLIST_EXISTING_SALE_LINKED', row);
        return row;
      });
    },
    /** @param {any} input */
    createReadRequest(input) {
      integer(input.expectedVersion, true);
      text(input.reason, 1000);
      if (
        !['customer', 'product', 'variation', 'sale'].includes(input.stage) ||
        (input.stage === 'sale') !==
          (input.resourceId === null || input.resourceId === undefined)
      )
        throw new OlistError('INVALID_REQUEST', 400);
      return transaction(input, async (/** @type {any} */ tx) => {
        const { actor, connection } = await guard(tx, input, 'olist.reconcile');
        const { row } = await operation(tx, input, true);
        if (!row) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
        let target = row;
        if (input.resourceId) {
          target = (
            await tx.query(
              'SELECT r.* FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id AND e.account_key=r.account_key WHERE e.export_id=$1 AND r.id=$2 AND r.account_key=$3 FOR UPDATE OF r',
              [row.id, input.resourceId, input.accountKey],
            )
          ).rows[0];
          if (!target || target.kind !== input.stage)
            throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
        }
        if (Number(target.version) !== input.expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        const id = input.requestId ?? randomUUID();
        const created = (
          await tx.query(
            'INSERT INTO crm.olist_read_requests(id,account_key,context_key,export_id,resource_id,actor_id,authorization_version,connection_generation,expected_version,stage,request_envelope,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *',
            [
              id,
              input.accountKey,
              input.contextKey,
              row.id,
              input.resourceId ?? null,
              actor.id,
              actor.olistAuthorizationVersion,
              Number(connection.generation),
              input.expectedVersion,
              input.stage,
              encrypted(
                { reason: input.reason },
                'administrative-read',
                input.accountKey,
                id,
              ),
              clock(),
            ],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,olist_export_id,status,queue,effect_policy,available_at,created_at,updated_at) VALUES($1,'olist.reconcile',$2,$3,'pending','olist_reconcile','internal',$4,$4,$4)",
          [randomUUID(), id, row.id, clock()],
        );
        await audit(
          tx,
          input,
          'OLIST_RECONCILIATION_QUEUED',
          { ...created, id: row.id, export_id: row.id },
          input.resourceId ?? null,
        );
        return requestView(created);
      });
    },
    /** Server-owned worker lookup only; loaded actor is reauthorized before HTTP.
     * @param {any} input */
    loadReadRequest(input) {
      return transaction(input, async (/** @type {any} */ tx) => {
        const row = (
          await tx.query(
            'SELECT r.*,e.order_id FROM crm.olist_read_requests r JOIN crm.olist_exports e ON e.id=r.export_id AND e.account_key=r.account_key WHERE r.id=$1 AND r.account_key=$2 AND r.context_key=$3',
            [input.requestId, input.accountKey, input.contextKey],
          )
        ).rows[0];
        if (!row) throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
        return {
          ...row,
          actor: { id: row.actor_id, kind: 'human' },
          authorizationVersion: Number(row.authorization_version),
          connectionGeneration: Number(row.connection_generation),
          orderId: row.order_id,
          exportId: row.export_id,
          resourceId: row.resource_id,
          expectedVersion: Number(row.expected_version),
          payload: open(
            row.request_envelope,
            options.envelopeKey,
            'administrative-read',
            input.accountKey,
            row.id,
          ),
        };
      });
    },
    /** @param {any} input */
    readRequest(input) {
      return transaction(input, async (/** @type {any} */ tx) => {
        await guard(tx, input, 'olist.reconcile');
        const row = (
          await tx.query(
            'SELECT r.* FROM crm.olist_read_requests r JOIN crm.olist_exports e ON e.id=r.export_id AND e.account_key=r.account_key WHERE r.id=$1 AND r.account_key=$2 AND r.context_key=$3 AND e.order_id=$4',
            [
              input.requestId,
              input.accountKey,
              input.contextKey,
              input.orderId,
            ],
          )
        ).rows[0];
        if (!row) throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
        return requestView(row);
      });
    },
    /** @param {any} input */
    completeReadRequest(input) {
      return transaction(input, async (/** @type {any} */ tx) => {
        const request = (
          await tx.query(
            'SELECT r.*,e.order_id FROM crm.olist_read_requests r JOIN crm.olist_exports e ON e.id=r.export_id AND e.account_key=r.account_key WHERE r.id=$1 AND r.account_key=$2 AND r.context_key=$3 FOR UPDATE OF r',
            [input.requestId, input.accountKey, input.contextKey],
          )
        ).rows[0];
        if (
          !request ||
          request.actor_id !== input.actor.id ||
          Number(request.authorization_version) !==
            input.authorizationVersion ||
          Number(request.connection_generation) !== input.connectionGeneration
        )
          throw new OlistError('FORBIDDEN', 403);
        if (request.status !== 'queued') return requestView(request);
        // A frozen request is authority only to record a bounded negative
        // outcome after grant/lease loss. Positive evidence still needs the
        // current administrator and connection, below, before target writes.
        if (input.matched === true) await guard(tx, input, 'olist.reconcile');
        // The frozen request belongs to ONE generation: never re-target it at
        // a newer export of the same order after an invalidation.
        const { row } = await operation(
          tx,
          { ...input, orderId: request.order_id },
          true,
          request.export_id,
        );
        let target = row;
        if (request.resource_id)
          target = (
            await tx.query(
              'SELECT * FROM crm.olist_resources WHERE id=$1 AND account_key=$2 FOR UPDATE',
              [request.resource_id, input.accountKey],
            )
          ).rows[0];
        let code =
          input.matched === true
            ? 'OLIST_RECONCILIATION_CONFIRMED'
            : SAFE.has(input.code)
              ? input.code
              : 'OLIST_RECONCILE_FAILED';
        let matched = input.matched === true;
        if (Number(target?.version) !== Number(request.expected_version)) {
          matched = false;
          code = 'VERSION_CONFLICT';
        }
        if (matched) {
          const id = remote(input.remoteId);
          if (input.proof?.matched !== true)
            throw new OlistError('OLIST_RECONCILIATION_REQUIRED');
          if (request.resource_id) {
            if (target.state === 'confirmed' && target.remote_id !== id)
              throw new OlistError('OLIST_RESOURCE_DIVERGENT');
            const attempt = (
              await tx.query(
                'SELECT * FROM crm.olist_attempts WHERE resource_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',
                [target.id],
              )
            ).rows[0];
            if (
              attempt?.observed_remote_id &&
              attempt.observed_remote_id !== id &&
              !(
                target.kind === 'variation' &&
                input.proof.parentRemoteId === attempt.observed_remote_id &&
                id !== attempt.observed_remote_id
              )
            )
              throw new OlistError('OLIST_RESOURCE_DIVERGENT');
            if (target.kind === 'variation') {
              const parent = (
                await tx.query(
                  'SELECT remote_id FROM crm.olist_resources WHERE id=$1 AND account_key=$2 FOR SHARE',
                  [target.parent_id, input.accountKey],
                )
              ).rows[0];
              if (
                !parent?.remote_id ||
                parent.remote_id === id ||
                (input.proof.parentRemoteId &&
                  input.proof.parentRemoteId !== parent.remote_id)
              )
                throw new OlistError('OLIST_VARIATION_DIVERGENT');
            }
            if (
              !['pending', 'reserved', 'uncertain', 'confirmed'].includes(
                target.state,
              )
            )
              throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
            if (target.state !== 'confirmed')
              await tx.query(
                "UPDATE crm.olist_resources SET state='confirmed',remote_id=$2,version=version+1,updated_at=$3 WHERE id=$1",
                [target.id, id, clock()],
              );
            if (attempt?.outcome === 'reserved')
              await tx.query(
                "UPDATE crm.olist_attempts SET outcome='confirmed',finished_at=$2,safe_code='OLIST_RESOURCE_RECONCILED',response_envelope=$3::jsonb WHERE id=$1",
                [
                  attempt.id,
                  clock(),
                  encrypted(
                    { remoteId: id, proof: input.proof },
                    'effect-response',
                    input.accountKey,
                    attempt.id,
                  ),
                ],
              );
          } else {
            if (['invalidated', 'rejected'].includes(row.state))
              throw new OlistError('OLIST_RECONCILIATION_REQUIRED');
            const decoded = await decodeOperation(tx, row);
            const mapping = decoded.resources;
            if (
              !mapping ||
              input.proof.totalCents !==
                decoded.snapshot.commercial.totalCents ||
              input.proof.lineCount !==
                decoded.snapshot.commercial.groups.reduce(
                  (/** @type {number} */ n, /** @type {any} */ g) =>
                    n + g.lines.length,
                  0,
                )
            )
              throw new OlistError('OLIST_SALE_DIVERGENT');
            const plan = buildOlistSalePayload({
              snapshot: decoded.snapshot,
              resolved: mapping,
              reference: row.reference,
            });
            const attempt = decoded.saleAttempt;
            if (attempt && attempt.requestPayload?.encoded !== plan.encoded)
              throw new OlistError('OLIST_SALE_REQUEST_CHANGED');
            const observed = attempt?.observedRemoteId ?? row.observed_sale_id;
            if (observed && observed !== id)
              throw new OlistError('OLIST_SALE_DIVERGENT');
            const number = remote(input.number);
            const observedNumber =
              attempt?.observedNumber ?? row.observed_sale_number;
            if (observedNumber && observedNumber !== number)
              throw new OlistError('OLIST_SALE_DIVERGENT');
            if (
              ['confirmed', 'linked'].includes(row.state) &&
              (row.remote_id !== id || row.remote_number !== number)
            )
              throw new OlistError('OLIST_SALE_DIVERGENT');
            if (!['confirmed', 'linked'].includes(row.state)) {
              if (attempt?.outcome === 'reserved')
                await tx.query(
                  "UPDATE crm.olist_attempts SET outcome='confirmed',finished_at=$2,safe_code='OLIST_SALE_RECONCILED',response_envelope=$3::jsonb WHERE id=$1",
                  [
                    attempt.id,
                    clock(),
                    encrypted(
                      { remoteId: id, number, proof: input.proof },
                      'effect-response',
                      input.accountKey,
                      attempt.id,
                    ),
                  ],
                );
              await tx.query(
                "UPDATE crm.olist_exports SET state=$2,stage='complete',remote_id=$3,remote_number=$4,observed_sale_id=COALESCE(observed_sale_id,$3),observed_sale_number=COALESCE(observed_sale_number,$4),readback_envelope=$5::jsonb,last_error_code=NULL,version=version+1,updated_at=$6 WHERE id=$1",
                [
                  row.id,
                  attempt ? 'confirmed' : 'linked',
                  id,
                  number,
                  encrypted(
                    { remoteId: id, number, ...input.proof },
                    'sale-readback',
                    input.accountKey,
                    row.id,
                  ),
                  clock(),
                ],
              );
            }
          }
        }
        const proof = {
          matched,
          code,
          ...(matched
            ? {
                remoteId: String(input.remoteId),
                ...(input.number ? { number: String(input.number) } : {}),
                proof: input.proof,
              }
            : {}),
        };
        const saved = (
          await tx.query(
            'UPDATE crm.olist_read_requests SET status=$2,safe_code=$3,result_envelope=$4::jsonb,completed_at=$5,version=version+1 WHERE id=$1 RETURNING *',
            [
              request.id,
              matched ? 'succeeded' : 'blocked',
              code,
              encrypted(
                proof,
                'administrative-read-result',
                input.accountKey,
                request.id,
              ),
              clock(),
            ],
          )
        ).rows[0];
        await audit(
          tx,
          input,
          code,
          { ...saved, export_id: request.export_id },
          request.resource_id,
        );
        return requestView(saved);
      });
    },
    /** Administrative L1 invalidation (ADR 069): archives a pre-sale export
     * generation as `invalidated` so a NEW generation can be prepared. Purely
     * local: zero HTTP, no health check of the ERP connection, nothing in the
     * ERP is touched. One transaction; lock order is the existing one (actor,
     * connection SHARE, conversation SHARE, order UPDATE, export UPDATE,
     * resources SHARE, job UPDATE), so it serializes against the dispatcher.
     *
     * Input has the same shape as `reconcile`/`linkExisting` plus the command:
     * `{actor:{id,kind:'human'}, sessionBinding, authorizationVersion?,
     *   accountKey, contextKey, orderId, correlationId, transaction?,
     *   operationId, expectedVersion, reason}`. `operationId` is the export id
     * (diagnostic `operation.id`), `expectedVersion` its version. The actor is
     * revalidated under lock for `olist.invalidate` (Vendedor + COMMERCIAL_ADMIN),
     * also on replay. `reason` is sealed (AES-GCM) and never logged.
     *
     * Resolves `{operationId, orderId, state:'invalidated', version, replayed?}`
     * (never the reason). Errors: FORBIDDEN 403, ORDER_NOT_FOUND 404,
     * INVALID_REQUEST 400, ORDER_CANCELLED, OLIST_EXPORT_UNAVAILABLE (order has
     * no operation), VERSION_CONFLICT (stale/unknown operationId or version),
     * OLIST_INVALIDATION_BLOCKED (state not queued/resolving/ready, any sale
     * attempt, remote/observed sale ID), OLIST_RESOURCE_RECONCILIATION_REQUIRED
     * (a resource reserved/uncertain, or a reserved attempt, or an uncertain
     * attempt whose resource is not yet confirmed: /reconcile that resource first), OLIST_EXPORT_IN_FLIGHT
     * (job processing with a LIVE lease; an expired lease is retired).
     * @param {any} input */
    invalidateExport(input) {
      text(input.orderId, 200);
      const correlationId = text(input.correlationId, 128);
      const reason = text(input.reason, 1000);
      const exportId = text(input.operationId, 36);
      if (!UUID.test(exportId)) throw new OlistError('INVALID_REQUEST', 400);
      const expectedVersion = integer(input.expectedVersion);
      return transaction(input, async (/** @type {any} */ tx) => {
        const actor = await lockOlistActor(
          tx,
          input,
          'olist.invalidate',
          clock(),
        );
        // Only the lock: invalidation is local and must work with a broken or
        // reconnecting ERP connection (OLIST_CONNECTION_CHANGED, reconnect).
        await tx.query(
          'SELECT 1 FROM crm.olist_connections WHERE context_key=$1 AND account_key=$2 FOR SHARE',
          [input.contextKey, input.accountKey],
        );
        const found = (
          await tx.query(
            'SELECT id,conversation_id FROM crm.orders WHERE id=$1',
            [input.orderId],
          )
        ).rows[0];
        if (!found) throw new OlistError('ORDER_NOT_FOUND', 404);
        if (found.conversation_id)
          await tx.query(
            'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
            [found.conversation_id],
          );
        const order = (
          await tx.query(
            'SELECT id,cancelled_at FROM crm.orders WHERE id=$1 FOR UPDATE',
            [found.id],
          )
        ).rows[0];
        if (order.cancelled_at) throw new OlistError('ORDER_CANCELLED');
        // FOR NO KEY UPDATE, not FOR UPDATE: it still conflicts with every
        // FOR SHARE / FOR UPDATE / FOR NO KEY UPDATE taker (the dispatch and
        // resolution guards, trigger (a)/(c), cancel), so the sale race stays
        // serialized, but it does NOT conflict with the FOR KEY SHARE that an
        // `olist_events` INSERT (FK to the export) takes. A resource-result
        // writer (attempt FOR UPDATE -> resource UPDATE -> event INSERT) and
        // this command (export lock -> resources FOR SHARE) could otherwise
        // wait on each other forever.
        const row = (
          await tx.query(
            'SELECT * FROM crm.olist_exports WHERE id=$1 AND order_id=$2 AND account_key=$3 AND context_key=$4 FOR NO KEY UPDATE',
            [exportId, order.id, input.accountKey, input.contextKey],
          )
        ).rows[0];
        if (!row) {
          // A stale id of an order that still has operations is a version
          // conflict (the UI must reload); an order with none is unavailable.
          const known = (
            await tx.query(
              'SELECT 1 FROM crm.olist_exports WHERE order_id=$1 AND account_key=$2 AND context_key=$3 LIMIT 1',
              [order.id, input.accountKey, input.contextKey],
            )
          ).rows[0];
          throw new OlistError(
            known ? 'VERSION_CONFLICT' : 'OLIST_EXPORT_UNAVAILABLE',
          );
        }
        if (row.state === 'invalidated') {
          const receipt = (
            await tx.query(
              'SELECT id FROM crm.olist_export_invalidations WHERE export_id=$1 AND account_key=$2',
              [row.id, row.account_key],
            )
          ).rows[0];
          if (receipt)
            return {
              operationId: row.id,
              orderId: order.id,
              state: 'invalidated',
              version: Number(row.version),
              replayed: true,
            };
        }
        if (Number(row.version) !== expectedVersion)
          throw new OlistError('VERSION_CONFLICT');
        if (!['queued', 'resolving', 'ready'].includes(row.state))
          throw new OlistError('OLIST_INVALIDATION_BLOCKED');
        if (
          row.remote_id ||
          row.observed_sale_id ||
          (
            await tx.query(
              "SELECT 1 FROM crm.olist_attempts WHERE export_id=$1 AND stage='sale' LIMIT 1",
              [row.id],
            )
          ).rows[0]
        )
          throw new OlistError('OLIST_INVALIDATION_BLOCKED');
        const resources = (
          await tx.query(
            'SELECT r.id,r.state FROM crm.olist_resources r JOIN crm.olist_export_resources x ON x.resource_id=r.id AND x.account_key=r.account_key WHERE x.export_id=$1 AND r.account_key=$2 ORDER BY r.id FOR SHARE OF r',
            [row.id, row.account_key],
          )
        ).rows;
        // A `reserved` attempt always blocks (a POST may be in flight). An
        // `uncertain` attempt is immutable history: it blocks only while its
        // RESOURCE is not confirmed with a remote ID. Once /reconcile (or a
        // verified lookup) made the resource `confirmed`, that resource is never
        // posted again (the resolver and `reserveResourceEffect` only create a
        // `pending` resource with no attempt at all), so the old attempt is no
        // longer a reason to keep the generation alive. The resources above are
        // locked FOR SHARE, so their states cannot change under this check.
        if (
          resources.some((/** @type {any} */ resource) =>
            ['reserved', 'uncertain'].includes(resource.state),
          ) ||
          (resources.length > 0 &&
            (
              await tx.query(
                `SELECT 1 FROM crm.olist_attempts a JOIN crm.olist_resources r ON r.id=a.resource_id AND r.account_key=a.account_key
                 WHERE a.account_key=$1 AND a.resource_id=ANY($2::uuid[])
                   AND (a.outcome='reserved'
                     OR (a.outcome='uncertain' AND NOT (r.state='confirmed' AND r.remote_id IS NOT NULL))) LIMIT 1`,
                [
                  row.account_key,
                  resources.map((/** @type {any} */ resource) => resource.id),
                ],
              )
            ).rows[0])
        )
          throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
        const job = (
          await tx.query(
            "SELECT id,status,locked_until FROM crm.outbox_jobs WHERE olist_export_id=$1 AND job_type='olist.export' FOR UPDATE",
            [row.id],
          )
        ).rows[0];
        const now = clock();
        // In flight only while the lease is alive; an expired `processing`
        // lease is an orphaned job (its worker died) and is retired like any
        // other queued job. The effect guards above already exclude a possible
        // POST, and a late worker is refused by the export lock/state.
        if (
          job?.status === 'processing' &&
          job.locked_until &&
          new Date(job.locked_until).getTime() >= now.getTime()
        )
          throw new OlistError('OLIST_EXPORT_IN_FLIGHT');
        const saved = (
          await tx.query(
            "UPDATE crm.olist_exports SET state='invalidated',last_error_code='OLIST_EXPORT_INVALIDATED',version=version+1,updated_at=$2 WHERE id=$1 RETURNING *",
            [row.id, now],
          )
        ).rows[0];
        // Retire the queued job without redelivery: the claim only takes
        // pending/retry, and the open reconciliation item is settled with it.
        if (job) {
          await tx.query(
            "UPDATE crm.outbox_jobs SET status='completed',locked_by=NULL,locked_until=NULL,heartbeat_at=NULL,updated_at=greatest(updated_at,$2),completed_at=$2,last_error_code=COALESCE(last_error_code,'OLIST_EXPORT_INVALIDATED') WHERE id=$1 AND status IN ('pending','retry','dead_letter','outcome_unknown','processing')",
            [job.id, now],
          );
          await tx.query(
            "UPDATE crm.reconciliation_items SET status='resolved',resolved_at=greatest(created_at,$2) WHERE job_id=$1 AND status='open'",
            [job.id, now],
          );
        }
        const invalidationId = randomUUID();
        await tx.query(
          'INSERT INTO crm.olist_export_invalidations(id,account_key,export_id,actor_id,authorization_version,expected_version,reason_envelope,correlation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
          [
            invalidationId,
            row.account_key,
            row.id,
            actor.id,
            actor.olistAuthorizationVersion,
            expectedVersion,
            encrypted(
              reason,
              'export-invalidation',
              row.account_key,
              invalidationId,
            ),
            correlationId,
            now,
          ],
        );
        await tx.query(
          "INSERT INTO crm.olist_events(id,account_key,export_id,resource_id,actor_id,event_code,version,correlation_id,occurred_at) VALUES($1,$2,$3,NULL,$4,'OLIST_EXPORT_INVALIDATED',$5,$6,$7)",
          [
            randomUUID(),
            row.account_key,
            row.id,
            actor.id,
            Number(saved.version),
            correlationId,
            now,
          ],
        );
        await tx.query(
          "INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES($1,$2,'olist.invalidate','olist-export',$3,$4,'OLIST_EXPORT_INVALIDATED',$5,$6)",
          [
            randomUUID(),
            actor.id,
            row.id,
            String(saved.version),
            correlationId,
            now,
          ],
        );
        return {
          operationId: saved.id,
          orderId: order.id,
          state: 'invalidated',
          version: Number(saved.version),
        };
      });
    },
    /** @param {any} input */
    diagnostic(input) {
      return transaction(input, async (/** @type {any} */ tx) => {
        // Reads only the database (zero HTTP): works with a broken connection.
        await guardLocal(tx, input, 'olist.reconcile');
        const { row } = await operation(tx, input);
        if (!row)
          return {
            operation: null,
            resources: [],
            requests: [],
            attempts: [],
            attemptHistoryTruncated: false,
          };
        const resources = (
          await tx.query(
            'SELECT r.id,r.kind,r.state,r.version,r.remote_id,r.parent_id FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id AND e.account_key=r.account_key WHERE e.export_id=$1 AND r.account_key=$2 ORDER BY r.kind,r.id LIMIT 1001',
            [row.id, input.accountKey],
          )
        ).rows;
        if (resources.length > 1000)
          throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
        const requests = (
          await tx.query(
            'SELECT * FROM crm.olist_read_requests WHERE export_id=$1 AND account_key=$2 ORDER BY created_at DESC,id DESC LIMIT 100',
            [row.id, input.accountKey],
          )
        ).rows;
        const attempts = (
          await tx.query(
            'SELECT id,resource_id,stage,outcome,observed_remote_id,safe_code,created_at,finished_at FROM crm.olist_attempts WHERE account_key=$1 AND (export_id=$2 OR resource_id IN (SELECT resource_id FROM crm.olist_export_resources WHERE export_id=$2 AND account_key=$1)) ORDER BY created_at DESC,id DESC LIMIT 101',
            [input.accountKey, row.id],
          )
        ).rows;
        return {
          operation: {
            id: row.id,
            actorId: row.actor_id,
            version: Number(row.version),
            state: row.state,
            stage: row.stage,
            number: row.remote_number ?? null,
            ...(row.last_error_code ? { errorCode: row.last_error_code } : {}),
          },
          resources: resources.map((/** @type {any} */ r) => ({
            id: r.id,
            kind: r.kind,
            state: r.state,
            version: Number(r.version),
            remoteId: r.remote_id,
            parentId: r.parent_id,
          })),
          requests: requests.map((/** @type {any} */ request) => ({
            ...requestView(request),
            actorId: request.actor_id,
          })),
          attempts: attempts
            .slice(0, 100)
            .map((/** @type {any} */ attempt) => ({
              id: attempt.id,
              resourceId: attempt.resource_id,
              stage: attempt.stage,
              outcome: attempt.outcome,
              observedRemoteId: attempt.observed_remote_id,
              code: attempt.safe_code,
              createdAt: attempt.created_at,
              finishedAt: attempt.finished_at,
            })),
          attemptHistoryTruncated: attempts.length > 100,
        };
      });
    },
  });
}
