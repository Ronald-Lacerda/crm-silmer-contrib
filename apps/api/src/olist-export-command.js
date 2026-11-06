import {
  PostgresIdempotencyRecordStore,
  fingerprintCommand,
} from '@crm-silmer/integration-reliability';
import {
  createOlistRepository,
  lockOlistActor,
  identityHash,
  OlistError,
  olistSettings,
} from '@crm-silmer/olist';
import { operationalDay } from '@crm-silmer/orders';

/** Local human command only. T08 owns dispatch. Current authority, receipt,
 * snapshot, outbox, audit and idempotency completion share one SQL client.
 * @param {any} database @param {{config:any,preview:any,environment:Record<string,string|undefined>,clock:()=>Date}} options */
export function createOlistExportCommand(
  database,
  { config, preview, environment, clock },
) {
  const key = Buffer.from(
    environment.IDEMPOTENCY_ENVELOPE_KEY ?? '',
    'base64url',
  );
  const repository = createOlistRepository(database, {
    envelopeKey: config.envelopeKey,
    hmacKey: config.hmacKey,
    clock,
  });
  /** Tokens carry only server-owned data. Random IVs, actors, sessions and
   * preview time are excluded from the logical operation's fingerprint.
   * @param {any} input @param {any} receipt */
  function operationFingerprint(input, receipt) {
    if (
      receipt.policy !== 'exact-cent-v1' ||
      !receipt.sourceVersions ||
      !receipt.customer ||
      !receipt.commercial ||
      !receipt.settings
    )
      throw new OlistError('OLIST_PREVIEW_INVALID', 409);
    const settings = olistSettings(receipt.settings);
    return identityHash(
      config.hmacKey,
      'export-semantic',
      fingerprintCommand({
        account: config.accountKey,
        context: config.contextKey,
        orderId: input.orderId,
        orderVersion: receipt.binding.orderVersion,
        sourceVersions: receipt.sourceVersions,
        settingsVersion: receipt.binding.settingsVersion,
        settings,
        policy: receipt.policy,
        customer: receipt.customer,
        productFiscal: receipt.productFiscal ?? null,
        commercial: {
          ...receipt.commercial,
          orderDate: receipt.binding.proposedDay
            ? null
            : receipt.commercial.orderDate,
        },
      }),
    );
  }
  /** @param {any} row @param {string} number */
  function response(row, number) {
    return {
      operationId: row.id,
      orderId: row.order_id,
      number,
      state: row.state,
      stage: row.stage,
      creationEnabled: false,
    };
  }
  return Object.freeze({
    /** @param {any} input */
    async exportOrder(input) {
      if (!config.configured || key.length !== 32)
        throw new OlistError('OLIST_NOT_CONFIGURED', 503);
      if (
        typeof input.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey) ||
        typeof input.orderId !== 'string' ||
        input.orderId.length < 1 ||
        input.orderId.length > 200 ||
        typeof input.previewToken !== 'string' ||
        input.previewToken.length > 262144 ||
        !/^[A-Za-z0-9_-]+$/u.test(input.previewToken)
      )
        throw new OlistError('INVALID_REQUEST', 400);
      /** @type {any} */
      let existing;
      let number = '';
      const base = {
        ...input,
        accountKey: config.accountKey,
        contextKey: config.contextKey,
      };
      const scoped = {
        query: database.query.bind(database),
        transaction: (/** @type {any} */ work) =>
          database.transaction(async (/** @type {any} */ tx) => {
            const actor = await lockOlistActor(
              tx,
              input,
              'olist.export',
              clock(),
            );
            // Orders mutations lock conversation before order. Prelock it here
            // so snapshot reads never invert that order or upgrade a shared lock.
            const order = (
              await tx.query(
                'SELECT number,conversation_id FROM crm.orders WHERE id=$1',
                [input.orderId],
              )
            ).rows[0];
            if (!order) throw new OlistError('ORDER_NOT_FOUND', 404);
            if (order.conversation_id)
              await tx.query(
                'SELECT id FROM crm.conversations WHERE id=$1 FOR SHARE',
                [order.conversation_id],
              );
            existing = await repository.findExport({
              ...base,
              transaction: tx,
            });
            if (
              existing &&
              existing.actor_id === actor.id &&
              Number(existing.authorization_version) !==
                actor.olistAuthorizationVersion
            )
              throw new OlistError('FORBIDDEN', 403);
            number = order.number;
            const locked = (
              await tx.query(
                'SELECT conversation_id FROM crm.orders WHERE id=$1',
                [input.orderId],
              )
            ).rows[0];
            if (locked.conversation_id !== order.conversation_id)
              throw new OlistError('OLIST_PREVIEW_STALE', 409);
            return work(tx);
          }),
      };
      const store = new PostgresIdempotencyRecordStore({
        database: scoped,
        envelopeKey: key,
      });
      return store.execute(
        {
          scope:
            'olist:' + config.contextKey + ':' + input.actor.id + ':export',
          key: input.idempotencyKey,
          fingerprint: identityHash(config.hmacKey, 'export-request', [
            input.actor.id,
            input.sessionBinding,
            input.orderId,
            input.previewToken,
          ]),
          actor: input.actor.id,
          action: 'olist.export.request',
          target: { type: 'order', id: input.orderId },
          version: 0,
          reason: 'OLIST_EXPORT_REQUESTED',
          correlationId: input.correlationId,
        },
        async (tx) => {
          const receipt = preview.readReceipt(input);
          const semantic = operationFingerprint(input, receipt);
          if (existing) {
            if (existing.command_fingerprint !== semantic)
              throw new OlistError('OLIST_EXPORT_CONFLICT', 409);
            return response(existing, number);
          }
          const current = await preview.assertFreshReceipt(
            { ...input, transaction: tx },
            receipt,
          );
          const acceptedAt = clock();
          const proposedDay = receipt.binding.proposedDay;
          if (proposedDay && proposedDay !== operationalDay(acceptedAt))
            throw new OlistError('OLIST_PREVIEW_STALE', 409);
          // Explicit allowlist: no binding/session data, ficha, notes, AI or file.
          const snapshot = {
            policy: receipt.policy,
            customer: structuredClone(receipt.customer),
            commercial: {
              ...structuredClone(receipt.commercial),
              orderDate:
                current.source.order.orderDate ?? operationalDay(acceptedAt),
            },
            sourceVersions: structuredClone(current.sourceVersions),
            productFiscal: structuredClone(receipt.productFiscal ?? null),
            settings: olistSettings(current.settings),
            registrations: structuredClone(receipt.registrations),
            acceptedAt: acceptedAt.toISOString(),
          };
          const row = await repository.prepareExport({
            ...base,
            transaction: tx,
            orderVersion: current.binding.orderVersion,
            settingsVersion: current.binding.settingsVersion,
            authorizationVersion: current.binding.authorizationVersion,
            connectionGeneration: current.binding.connectionGeneration,
            connectionVersion: current.binding.connectionVersion,
            snapshot,
            snapshotFingerprint: semantic,
          });
          return response(row, number);
        },
      );
    },
  });
}
