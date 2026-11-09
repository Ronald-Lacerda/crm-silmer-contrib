import { randomUUID } from 'node:crypto';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  createOlistAdminRepository,
  createOlistReadonlyInspector,
  createOlistClient,
  olistReadWait,
  identityHash,
  seal,
  open,
  lockOlistActor,
  OlistError,
  olistBuyerRegistrationEmpty,
} from '@crm-silmer/olist';
import { normalizeContactPhone } from '@crm-silmer/contacts';
import { buildOlistPreviewPlan } from './olist-preview-plan.js';
import { prepareExactCentExport } from '@crm-silmer/orders';

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
      // One request waits at most 8 s for quota and stays under 24/30 per
      // window; past that it fails as OLIST_RATE_LIMITED (429).
      readWait: olistReadWait('api'),
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
      binding.paymentDueOn ?? null,
      binding.productFiscalHash ?? null,
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
  /** Reuse every CRM/buyer/commercial check, excluding only the enumerated
   * future-creation settings that cannot describe a historical manual sale.
   * No settings, fiscal identity or date is synthesized to pass a creator gate.
   * @param {any} current @param {any} input */
  function legacySourcePlan(current, input) {
    const existingBuyer = olistBuyerRegistrationEmpty(
      current.buyer?.registration,
    );
    const plan = buildOlistPreviewPlan({
      source: current.source,
      buyer: current.buyer,
      settings: current.settings,
      now: clock(),
      paymentDueOn: input.paymentDueOn,
    });
    const irrelevant = new Set([
      'settings.sellerId',
      'settings.operationNatureId',
      'settings.warehouseId',
      'settings.paymentMethodId',
      'settings.originId',
      'settings.paymentDueOn',
      'settings.paymentTerms',
      'settings.receivingMethodId',
      'settings.priceListId',
      'settings.purchaseOrder',
    ]);
    const blocked = plan.issues.filter(
      (issue) =>
        !(
          (existingBuyer &&
            issue.field.startsWith('buyer.registration.') &&
            issue.code === 'OLIST_BUYER_REQUIRED') ||
          (existingBuyer &&
            issue.field === 'buyer.email' &&
            issue.code === 'OLIST_BUYER_INVALID') ||
          (['OLIST_SETTINGS_REQUIRED', 'OLIST_SETTINGS_INVALID'].includes(
            issue.code,
          ) &&
            irrelevant.has(issue.field)) ||
          (['OLIST_PAYMENT_DUE_REQUIRED', 'OLIST_SETTINGS_INVALID'].includes(
            issue.code,
          ) &&
            issue.field === 'commercial.paymentDueOn')
        ),
    );
    if (blocked.length || (!plan.customer && !existingBuyer))
      throw new OlistError('OLIST_ORDER_INCOMPLETE', 422);
    const order = current.source.order,
      prepared = prepareExactCentExport(order.ficha.sizePricing);
    if (!prepared.eligible || prepared.totalCents !== order.finalAmountCents)
      throw new OlistError('OLIST_ORDER_INCOMPLETE', 422);
    const groups = order.ficha.sizePricing.map(
      (/** @type {any} */ group, /** @type {number} */ index) => {
        const item = order.ficha.items[index];
        return {
          groupId: group.id,
          attributes: {
            garment: item.tipo,
            color: item.cor,
            fabric: JSON.stringify(item.malhas),
            application: item.tipo_servico,
            collar: item.gola,
            audience: item.publico ?? '',
          },
          lines: prepared.lines
            .filter((line) => line.groupId === group.id)
            .map((line) => ({
              ...line,
              size: group.lines.find(
                (/** @type {any} */ entry) => entry.id === line.lineId,
              ).size,
            })),
        };
      },
    );
    return {
      customer: existingBuyer
        ? {
            nome: current.buyer.name,
            celular: normalizeContactPhone(current.buyer.phone),
          }
        : plan.customer,
      buyer: existingBuyer ? current.buyer : null,
      commercial: {
        ...plan.commercial,
        groups,
        orderDate: order.orderDate ?? null,
        paymentDueOn: null,
      },
    };
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
  function readReceipt(input, legacy = false) {
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
        legacy ? 'legacy-existing-review' : 'existing-review',
        config.accountKey,
        entity(input),
      );
    } catch {
      throw new OlistError('OLIST_PREVIEW_INVALID');
    }
    if (
      receipt.accountKey !== config.accountKey ||
      receipt.contextKey !== config.contextKey ||
      (legacy && receipt.mode !== 'legacy-sale-only-v1') ||
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
    const chosenFiscal =
      receipt.mode !== 'legacy-sale-only-v1' &&
      (receipt.snapshot?.settings?.productFiscal === null ||
        receipt.snapshot?.settings?.productFiscal === undefined) &&
      receipt.snapshot?.productFiscal;
    if (chosenFiscal) {
      // Compare the central revision before rehydrating a reviewed override.
      // A newly configured central policy invalidates the receipt rather than
      // being interpreted as a fresh user attempt to override that policy.
      const current = await currentSource(input);
      if (current.binding.settingsVersion !== receipt.expectedSettingsVersion)
        throw new OlistError('OLIST_PREVIEW_STALE');
    }
    const current = await currentSource({
      ...input,
      ...(receipt.mode === 'legacy-sale-only-v1' &&
      receipt.paymentDueOn !== undefined
        ? { paymentDueOn: receipt.paymentDueOn }
        : {}),
      ...(receipt.snapshot?.settings?.paymentDuePolicy === 'per_order'
        ? { paymentDueOn: receipt.snapshot.commercial.paymentDueOn }
        : {}),
      ...(chosenFiscal
        ? { productFiscal: receipt.snapshot.productFiscal }
        : {}),
    });
    if (sourceFence(current) !== receipt.sourceFence)
      throw new OlistError('OLIST_PREVIEW_STALE');
    return current;
  }
  /** @param {any} input @param {string} name @param {string} action @param {any} command @param {{local?:boolean, version?:number}} [options] `local`: the command makes no ERP call, so it must NOT require a healthy connection (`repository.guard` throws OLIST_CONNECTION_CHANGED); the human actor, session, ACL and authorization version are still revalidated under lock, replay included. */
  function storeFor(input, name, action, command, options = {}) {
    if (
      typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)
    )
      throw new OlistError('INVALID_REQUEST', 400);
    const scoped = {
      query: database.query.bind(database),
      transaction: (/** @type {any} */ work) =>
        database.transaction(async (/** @type {any} */ tx) => {
          if (options.local) await lockOlistActor(tx, input, action, clock());
          else await repository.guard({ ...input, transaction: tx }, action);
          if (['link', 'legacy-link'].includes(name)) {
            const order = (
              await tx.query(
                'SELECT conversation_id FROM crm.orders WHERE id=$1',
                [input.orderId],
              )
            ).rows[0];
            if (order?.conversation_id)
              await tx.query(
                'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
                [order.conversation_id],
              );
            await tx.query('SELECT id FROM crm.orders WHERE id=$1 FOR UPDATE', [
              input.orderId,
            ]);
            const held = (
              await tx.query(
                "SELECT 1 FROM crm.olist_exports WHERE account_key=$1 AND order_id=$2 AND state='legacy_review_required' FOR SHARE",
                [config.accountKey, input.orderId],
              )
            ).rows[0];
            if (held) throw new OlistError('OLIST_LEGACY_REVIEW_REQUIRED');
          }
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
        version: options.version ?? 0,
        reason:
          name === 'link'
            ? 'OLIST_EXISTING_LINK'
            : name === 'legacy-link'
              ? 'OLIST_LEGACY_SALE_LINKED'
              : name === 'invalidate'
                ? 'OLIST_EXPORT_INVALIDATED'
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
    /** Explicit legacy correspondence, with a purpose-isolated receipt.
     * @param {any} raw */
    async legacyExistingPreview(raw) {
      const input = base(raw);
      if (
        typeof input.saleId !== 'string' ||
        !/^[1-9][0-9]{0,15}$/u.test(input.saleId) ||
        !Number.isSafeInteger(Number(input.saleId))
      )
        throw new OlistError('INVALID_REQUEST', 400);
      await repository.legacyLinkAvailable(input);
      const before = await currentSource(input);
      const plan = legacySourcePlan(before, input);
      const snapshot = {
        policy: 'legacy-sale-only-v1',
        linkMode: 'legacy-sale-only-v1',
        customer: plan.customer,
        commercial: plan.commercial,
        sourceVersions: before.sourceVersions,
        acceptedAt: clock().toISOString(),
      };
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 131072)
        throw new OlistError('OLIST_PREVIEW_TOO_LARGE', 422);
      const exportId = randomUUID(),
        reference = 'CRM-' + exportId;
      const checked = await inspector(input, 'olist.link').legacyExistingSale({
        snapshot,
        reference,
        remoteId: input.saleId,
        mapping: input.mapping,
        paymentDueOn: input.paymentDueOn,
        buyer: plan.buyer,
      });
      if (checked.buyerSource)
        Object.assign(snapshot, {
          buyerSource: checked.buyerSource,
          customer: checked.customer,
        });
      if (checked.legacyBuyerProof)
        Object.assign(snapshot, {
          legacyBuyerProof: checked.legacyBuyerProof,
          customer: checked.customer,
        });
      snapshot.commercial = checked.commercial;
      /** @type {any} */ (snapshot).historicalMetadata =
        checked.historicalMetadata;
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 131072)
        throw new OlistError('OLIST_PREVIEW_TOO_LARGE', 422);
      const after = await currentSource(input);
      if (sourceFence(before) !== sourceFence(after))
        throw new OlistError('OLIST_PREVIEW_STALE');
      const createdAt = clock().toISOString(),
        expiresAt = new Date(clock().getTime() + TTL).toISOString();
      const receipt = {
        mode: 'legacy-sale-only-v1',
        ...(input.paymentDueOn !== undefined
          ? { paymentDueOn: input.paymentDueOn }
          : {}),
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
        expectedOperationVersion: 0,
        connectionGeneration: after.binding.connectionGeneration,
        connectionVersion: after.binding.connectionVersion,
        remoteId: checked.remoteId,
        number: checked.number,
        remoteDigest: checked.remoteDigest,
        mapping: checked.resources.legacyCorrespondence,
      };
      const token = Buffer.from(
        JSON.stringify(
          seal(
            receipt,
            config.envelopeKey,
            'legacy-existing-review',
            config.accountKey,
            entity(input),
          ),
        ),
      ).toString('base64url');
      if (token.length > 262144)
        throw new OlistError('OLIST_PREVIEW_TOO_LARGE', 422);
      return {
        orderId: input.orderId,
        mode: 'legacy-sale-only-v1',
        eligible: true,
        sale: { id: checked.remoteId, number: checked.number },
        mapping: receipt.mapping,
        commercial: snapshot.commercial,
        historicalMetadata: checked.historicalMetadata,
        versions: {
          order: receipt.expectedOrderVersion,
          operation: 0,
          settings: receipt.expectedSettingsVersion,
          connection: receipt.connectionVersion,
          authorization: after.binding.authorizationVersion,
        },
        expiresAt,
        previewToken: token,
        creationEnabled: false,
        ...(!checked.legacyBuyerProof
          ? { buyerSourceHint: checked.buyerSource?.mode ?? 'crm-registration' }
          : {}),
        ...(checked.legacyBuyerProof
          ? {
              buyerReview: {
                mode: 'legacy-sale-buyer-review-v1',
                phoneMismatch: true,
                reusable: false,
                code: 'OLIST_LEGACY_BUYER_PHONE_MISMATCH',
              },
            }
          : {}),
      };
    },
    /** @param {any} raw */
    async linkLegacyExisting(raw) {
      const input = base(raw),
        reason = text(input.reason, 1000);
      if (input.confirmed !== true)
        throw new OlistError('INVALID_REQUEST', 400);
      await repository.guard(input, 'olist.link');
      if (
        (await repository.readOperation(input))?.state ===
        'legacy_review_required'
      )
        throw new OlistError('OLIST_LEGACY_REVIEW_REQUIRED');
      const { store, identity } = storeFor(input, 'legacy-link', 'olist.link', [
        input.previewToken,
        input.confirmed,
        reason,
      ]);
      const receipt = readReceipt(input, true);
      if (await store.get(identity)) {
        if (receipt.snapshot?.legacyBuyerProof) {
          const before = await currentSource(input);
          if (sourceFence(before) !== receipt.sourceFence)
            throw new OlistError('OLIST_PREVIEW_STALE');
          const observed = await inspector(
            input,
            'olist.link',
          ).legacyExistingSale({
            snapshot: receipt.snapshot,
            reference: receipt.reference,
            remoteId: receipt.remoteId,
            mapping: receipt.mapping,
            paymentDueOn: receipt.snapshot.commercial.paymentDueOn,
          });
          const after = await currentSource(input);
          if (
            sourceFence(before) !== sourceFence(after) ||
            observed.remoteDigest !== receipt.remoteDigest ||
            observed.remoteId !== receipt.remoteId ||
            observed.number !== receipt.number
          )
            throw new OlistError('OLIST_PREVIEW_STALE');
        }
        return store.execute(identity, async () => {
          throw new OlistError('IDEMPOTENCY_RECORD_PENDING');
        });
      }
      await assertFresh(input, receipt);
      await repository.legacyLinkAvailable(input);
      const checked = await inspector(input, 'olist.link').legacyExistingSale({
        snapshot: receipt.snapshot,
        reference: receipt.reference,
        remoteId: receipt.remoteId,
        mapping: receipt.mapping,
        paymentDueOn: receipt.snapshot.commercial.paymentDueOn,
      });
      if (
        checked.remoteDigest !== receipt.remoteDigest ||
        checked.remoteId !== receipt.remoteId ||
        checked.number !== receipt.number
      )
        throw new OlistError('OLIST_PREVIEW_STALE');
      return store.execute(identity, async (tx) => {
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
        return {
          ...linked(
            await repository.commitLegacyLink({
              ...input,
              transaction: tx,
              ...receipt,
              confirmed: true,
              reason,
              resources: checked.resources,
              proof: checked.proof,
            }),
          ),
          mode: 'legacy-sale-only-v1',
        };
      });
    },
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
      if (operation?.state === 'legacy_review_required')
        throw new OlistError('OLIST_LEGACY_REVIEW_REQUIRED');
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
      if (olistBuyerRegistrationEmpty(before.buyer?.registration)) {
        const resolved = await inspector(
          input,
          'olist.link',
        ).resolveExistingBuyer(before.buyer);
        before.buyerSource = resolved.buyerSource;
      }
      const plan = buildOlistPreviewPlan({
        source: before.source,
        buyer: before.buyer,
        settings: before.settings,
        now: clock(),
        paymentDueOn: input.paymentDueOn,
        buyerSource: before.buyerSource,
      });
      if (!plan.eligible) throw new OlistError('OLIST_ORDER_INCOMPLETE', 422);
      const snapshot = {
        policy: 'exact-cent-v1',
        customer: plan.customer,
        ...(before.buyerSource ? { buyerSource: before.buyerSource } : {}),
        commercial: {
          ...plan.commercial,
          orderDate:
            operation?.snapshot.commercial.orderDate ??
            plan.commercial.orderDate,
        },
        sourceVersions: before.sourceVersions,
        productFiscal:
          before.productFiscal ?? before.settings?.productFiscal ?? null,
        productFiscalDeferred: before.productFiscalDeferred === true,
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
            productFiscalDeferred: value.productFiscalDeferred === true,
            buyerSource: value.buyerSource ?? null,
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
        buyerSourceHint: before.buyerSource?.mode ?? 'crm-registration',
        productFiscal: snapshot.productFiscal,
        productFiscalDeferred: snapshot.productFiscalDeferred === true,
        productFiscalRequired:
          before.productFiscalRequired ??
          (before.settings?.productFiscal === null ||
            before.settings?.productFiscal === undefined),
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
      if (Object.hasOwn(input, 'productFiscal'))
        throw new OlistError('INVALID_REQUEST', 400);
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
    /** L1: retire one export generation before any sale attempt. Local and
     * synchronous: zero HTTP, no `repository.guard` (works with a changed or
     * disconnected ERP connection), actor/session/ACL revalidated under lock.
     * The receipt is allowlisted here so the reason never leaves the sealed
     * envelope and no repository field can leak into the response.
     * @param {any} raw */
    async invalidate(raw) {
      const input = base(raw);
      const reason = text(input.reason, 1000);
      if (
        typeof input.operationId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          input.operationId,
        ) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1
      )
        throw new OlistError('INVALID_REQUEST', 400);
      const { store, identity } = storeFor(
        input,
        'invalidate',
        'olist.invalidate',
        [input.operationId, input.expectedVersion, reason],
        { local: true, version: input.expectedVersion },
      );
      return store.execute(identity, async (tx) => {
        const receipt = await repository.invalidateExport({
          ...input,
          reason,
          transaction: tx,
        });
        return {
          operationId: receipt.operationId,
          orderId: receipt.orderId,
          state:
            receipt.state === 'legacy_review_required'
              ? 'legacy_review_required'
              : 'invalidated',
          version: receipt.version,
          ...(receipt.replayed === true ? { replayed: true } : {}),
        };
      });
    },
    /** @param {any} raw */
    async administration(raw) {
      const input = base(raw),
        diagnostic = await repository.diagnostic(input);
      if (diagnostic.operation)
        return { ...diagnostic, legacyLinkContext: null };
      try {
        await repository.legacyLinkAvailable(input);
        const current = await currentSource(input),
          order = current.source?.order;
        const groups = order?.ficha?.sizePricing,
          items = order?.ficha?.items;
        if (
          current.source.issues.length ||
          !Array.isArray(groups) ||
          !Array.isArray(items) ||
          !groups.length ||
          groups.length > 50 ||
          groups.length !== items.length
        )
          return { ...diagnostic, legacyLinkContext: null };
        return {
          ...diagnostic,
          legacyLinkContext: {
            paymentDuePolicy: 'fixed_date',
            historicalDueReadOnly: true,
            groups: groups.map((group, index) => {
              const item = items[index];
              return {
                groupId: group.id,
                attributes: {
                  garment: item.tipo,
                  color: item.cor,
                  fabric: JSON.stringify(item.malhas),
                  application: item.tipo_servico,
                  collar: item.gola,
                  audience: item.publico ?? '',
                },
                lines: group.lines.map((/** @type {any} */ line) => ({
                  lineId: line.id,
                  size: line.size,
                  quantity: line.quantity,
                  subtotalCents: line.subtotalCents,
                })),
              };
            }),
          },
        };
      } catch (error) {
        if (
          [
            'OLIST_CONNECTION_CHANGED',
            'OLIST_RECONCILIATION_REQUIRED',
            'ORDER_CANCELLED',
            'OLIST_ORDER_INCOMPLETE',
            'OLIST_NOT_CONFIGURED',
          ].includes(/** @type {any} */ (error).code)
        )
          return { ...diagnostic, legacyLinkContext: null };
        throw error;
      }
    },
    /** @param {any} raw */
    readReconciliation: (raw) => repository.readRequest(base(raw)),
  });
}
