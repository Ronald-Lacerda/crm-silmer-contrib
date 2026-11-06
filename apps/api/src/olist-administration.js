import { randomUUID } from 'node:crypto';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  createOlistAdminRepository,
  createOlistReadonlyInspector,
  createOlistClient,
  identityHash,
  seal,
  open,
  OlistError,
} from '@crm-silmer/olist';
import { buildOlistPreviewPlan } from './olist-preview-plan.js';

const TTL = 15 * 60_000;
/** @param {unknown} value @param {number} max */
function text(value, max) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return value.trim();
}
/** T09: HTTP never runs under a SQL transaction. Administrative receipts are
 * session-bound reviews, not permission to create or overwrite ERP entities.
 * @param {any} database @param {{config:any,connection:any,preview:any,environment:Record<string,string|undefined>,clock:()=>Date,fetch?:typeof fetch,timeoutMs?:number,repository?:any,inspector?:any}} options */
export function createOlistAdministration(database, options) {
  const { config, connection, preview, clock } = options;
  const key = Buffer.from(
    options.environment.IDEMPOTENCY_ENVELOPE_KEY ?? '',
    'base64url',
  );
  const repository =
    options.repository ??
    createOlistAdminRepository(database, {
      envelopeKey: config.envelopeKey,
      hmacKey: config.hmacKey,
      clock,
    });
  /** @param {any} input */
  function base(input) {
    text(input.orderId, 200);
    if (!config.configured || key.length !== 32)
      throw new OlistError('OLIST_NOT_CONFIGURED', 503);
    return {
      ...input,
      accountKey: config.accountKey,
      contextKey: config.contextKey,
    };
  }
  /** @param {any} input @param {string} action */
  function inspector(input, action) {
    if (options.inspector) return options.inspector;
    let reads = 0;
    const client = createOlistClient({
      credentials: () => connection.credentials(input, action),
      quota: connection.quota,
      timeoutMs: options.timeoutMs,
      fetch: async (url, init) => {
        if ((init?.method ?? 'GET') !== 'GET' || ++reads > 64)
          throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
        return (options.fetch ?? globalThis.fetch)(url, init);
      },
      onAuthFailure: (version) => connection.authFailure(input, version),
    });
    return createOlistReadonlyInspector({ client, config });
  }
  /** Exclude operation/resource observations from the source fence: two honest
   * links may converge, while the repository serializes their actual targets.
   * @param {any} current */
  function sourceFence(current) {
    const binding = current.binding;
    return identityHash(config.hmacKey, 'admin-source', [
      binding.actorId,
      binding.authorizationVersion,
      binding.session,
      binding.account,
      binding.context,
      binding.connectionVersion,
      binding.connectionGeneration,
      binding.settingsVersion,
      binding.orderVersion,
      binding.proposedDay,
      current.source,
      current.buyer,
      current.settings,
      current.sourceVersions,
    ]);
  }
  /** @param {any} input */
  async function currentSource(input) {
    return preview.snapshotForAdministration(input);
  }
  /** @param {any} input */
  function entity(input) {
    return identityHash(config.hmacKey, 'existing-review', [
      input.actor.id,
      input.sessionBinding,
      input.orderId,
    ]);
  }
  /** @param {any} input */
  function readReceipt(input) {
    if (
      typeof input.previewToken !== 'string' ||
      input.previewToken.length > 262144 ||
      !/^[A-Za-z0-9_-]+$/u.test(input.previewToken)
    )
      throw new OlistError('INVALID_REQUEST', 400);
    let receipt;
    try {
      receipt = open(
        JSON.parse(
          Buffer.from(input.previewToken, 'base64url').toString('utf8'),
        ),
        config.envelopeKey,
        'existing-review',
        config.accountKey,
        entity(input),
      );
    } catch {
      throw new OlistError('OLIST_PREVIEW_INVALID');
    }
    if (
      receipt.accountKey !== config.accountKey ||
      receipt.contextKey !== config.contextKey ||
      Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt) !== TTL ||
      !Number.isFinite(Date.parse(receipt.expiresAt)) ||
      Date.parse(receipt.createdAt) > clock().getTime()
    )
      throw new OlistError('OLIST_PREVIEW_INVALID');
    return receipt;
  }
  /** @param {any} input @param {any} receipt */
  async function assertFresh(input, receipt) {
    if (clock().getTime() >= Date.parse(receipt.expiresAt))
      throw new OlistError('OLIST_PREVIEW_EXPIRED');
    const current = await currentSource(input);
    if (sourceFence(current) !== receipt.sourceFence)
      throw new OlistError('OLIST_PREVIEW_STALE');
    return current;
  }
  /** @param {any} input @param {string} name @param {string} action @param {any} command */
  function storeFor(input, name, action, command) {
    if (
      typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)
    )
      throw new OlistError('INVALID_REQUEST', 400);
    const scoped = {
      query: database.query.bind(database),
      transaction: (/** @type {any} */ work) =>
        database.transaction(async (/** @type {any} */ tx) => {
          await repository.guard({ ...input, transaction: tx }, action);
          return work(tx);
        }),
    };
    return {
      store: new PostgresIdempotencyRecordStore({
        database: scoped,
        envelopeKey: key,
      }),
      identity: {
        scope: 'olist:' + config.contextKey + ':' + input.actor.id + ':' + name,
        key: input.idempotencyKey,
        fingerprint: identityHash(config.hmacKey, 'admin-command', [
          input.actor.id,
          input.sessionBinding,
          input.orderId,
          command,
        ]),
        actor: input.actor.id,
        action,
        target: { type: 'order', id: input.orderId },
        version: 0,
        reason:
          name === 'link'
            ? 'OLIST_EXISTING_LINK'
            : 'OLIST_RECONCILIATION_REQUESTED',
        correlationId: input.correlationId,
      },
    };
  }
  /** @param {any} row */
  function linked(row) {
    return {
      operationId: row.id,
      orderId: row.order_id,
      state: row.state,
      stage: row.stage,
      number: row.remote_number,
      creationEnabled: false,
    };
  }
  return Object.freeze({
    /** @param {any} raw */
    async existingPreview(raw) {
      const input = base(raw);
      if (
        typeof input.saleId !== 'string' ||
        !/^[1-9][0-9]{0,15}$/u.test(input.saleId) ||
        !Number.isSafeInteger(Number(input.saleId))
      )
        throw new OlistError('INVALID_REQUEST', 400);
      await repository.guard(input, 'olist.link');
      const before = await currentSource(input);
      const operation = await repository.readOperation(input);
      if (
        operation?.saleAttempt ||
        [
          'confirmed',
          'linked',
          'reserved',
          'uncertain',
          'invalidated',
        ].includes(operation?.state)
      )
        throw new OlistError('OLIST_RECONCILIATION_REQUIRED');
      const plan = buildOlistPreviewPlan({
        source: before.source,
        buyer: before.buyer,
        settings: before.settings,
        now: clock(),
      });
      if (!plan.eligible) throw new OlistError('OLIST_ORDER_INCOMPLETE', 422);
      const snapshot = {
        policy: 'exact-cent-v1',
        customer: plan.customer,
        commercial: {
          ...plan.commercial,
          orderDate:
            operation?.snapshot.commercial.orderDate ??
            plan.commercial.orderDate,
        },
        sourceVersions: before.sourceVersions,
        productFiscal: before.settings?.productFiscal ?? null,
        settings: before.settings,
        acceptedAt: clock().toISOString(),
      };
      if (operation) {
        const comparable = (/** @type {any} */ value) =>
          fingerprintCommand({
            policy: value.policy,
            customer: value.customer,
            commercial: value.commercial,
            sourceVersions: value.sourceVersions,
            productFiscal: value.productFiscal ?? null,
            settings: value.settings,
          });
        if (comparable(operation.snapshot) !== comparable(snapshot))
          throw new OlistError('OLIST_PREVIEW_STALE');
      }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 131072)
        throw new OlistError('OLIST_PREVIEW_TOO_LARGE', 422);
      const exportId = operation?.id ?? randomUUID();
      const reference = operation?.reference ?? 'CRM-' + exportId;
      const checked = await inspector(input, 'olist.link').existingSale({
        snapshot,
        reference,
        remoteId: input.saleId,
        allowLegacyReference: true,
      });
      const after = await currentSource(input);
      if (sourceFence(before) !== sourceFence(after))
        throw new OlistError('OLIST_PREVIEW_STALE');
      const createdAt = clock().toISOString();
      const expiresAt = new Date(clock().getTime() + TTL).toISOString();
      const receipt = {
        accountKey: config.accountKey,
        contextKey: config.contextKey,
        createdAt,
        expiresAt,
        sourceFence: sourceFence(after),
        exportId,
        reference,
        snapshot,
        expectedOrderVersion: after.binding.orderVersion,
        expectedSettingsVersion: after.binding.settingsVersion,
        expectedOperationVersion: Number(operation?.version ?? 0),
        connectionGeneration: after.binding.connectionGeneration,
        connectionVersion: after.binding.connectionVersion,
        remoteId: checked.remoteId,
        number: checked.number,
        remoteDigest: checked.remoteDigest,
      };
      const token = Buffer.from(
        JSON.stringify(
          seal(
            receipt,
            config.envelopeKey,
            'existing-review',
            config.accountKey,
            entity(input),
          ),
        ),
      ).toString('base64url');
      if (token.length > 262144)
        throw new OlistError('OLIST_PREVIEW_TOO_LARGE', 422);
      return {
        orderId: input.orderId,
        eligible: true,
        sale: { id: checked.remoteId, number: checked.number },
        versions: {
          order: receipt.expectedOrderVersion,
          operation: receipt.expectedOperationVersion,
          settings: receipt.expectedSettingsVersion,
          connection: receipt.connectionVersion,
          authorization: after.binding.authorizationVersion,
        },
        expiresAt,
        previewToken: token,
        creationEnabled: false,
      };
    },
    /** @param {any} raw */
    async linkExisting(raw) {
      const input = base(raw);
      const reason = text(input.reason, 1000);
      await repository.guard(input, 'olist.link');
      const { store, identity } = storeFor(input, 'link', 'olist.link', [
        input.previewToken,
        reason,
      ]);
      if (await store.get(identity))
        return store.execute(identity, async () => {
          throw new OlistError('IDEMPOTENCY_RECORD_PENDING');
        });
      const receipt = readReceipt(input);
      await assertFresh(input, receipt);
      const checked = await inspector(input, 'olist.link').existingSale({
        snapshot: receipt.snapshot,
        reference: receipt.reference,
        remoteId: receipt.remoteId,
        allowLegacyReference: true,
      });
      if (
        checked.remoteDigest !== receipt.remoteDigest ||
        checked.remoteId !== receipt.remoteId ||
        checked.number !== receipt.number
      )
        throw new OlistError('OLIST_PREVIEW_STALE');
      return store.execute(identity, async (tx) => {
        // Order mutation lock order is conversation -> order -> export.
        const order = (
          await tx.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [
            input.orderId,
          ])
        ).rows[0];
        if (!order) throw new OlistError('ORDER_NOT_FOUND', 404);
        if (order.conversation_id)
          await tx.query(
            'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
            [order.conversation_id],
          );
        await tx.query('SELECT id FROM crm.orders WHERE id=$1 FOR UPDATE', [
          input.orderId,
        ]);
        await assertFresh({ ...input, transaction: tx }, receipt);
        return linked(
          await repository.commitLink({
            ...input,
            transaction: tx,
            ...receipt,
            reason,
            resources: checked.resources,
            proof: checked.proof,
          }),
        );
      });
    },
    /** @param {any} raw */
    async reconcile(raw) {
      const input = base(raw);
      const reason = text(input.reason, 1000);
      if (
        !['customer', 'product', 'variation', 'sale'].includes(input.stage) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        (input.stage === 'sale'
          ? input.resourceId !== null
          : typeof input.resourceId !== 'string' ||
            !/^[a-f0-9-]{36}$/u.test(input.resourceId))
      )
        throw new OlistError('INVALID_REQUEST', 400);
      await repository.guard(input, 'olist.reconcile');
      const { store, identity } = storeFor(
        input,
        'reconcile',
        'olist.reconcile',
        [input.stage, input.resourceId, input.expectedVersion, reason],
      );
      return store.execute(identity, async (tx) =>
        repository.createReadRequest({ ...input, reason, transaction: tx }),
      );
    },
    /** @param {any} raw */
    administration: (raw) => repository.diagnostic(base(raw)),
    /** @param {any} raw */
    readReconciliation: (raw) => repository.readRequest(base(raw)),
  });
}
