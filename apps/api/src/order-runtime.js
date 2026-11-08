import { createHash } from 'node:crypto';

import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize, CAPABILITIES } from '@crm-silmer/identity-access';
import {
  createIdempotentCommandExecutor,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  createOrderFileService,
  createOrderService,
  sizePricingSummary,
  createStoreOrderCorrectionService,
  ORDER_FILE_LIMITS,
  OrderConflictError,
  OrderForbiddenError,
  OrderInputError,
  OrderNotFoundError,
  PostgresOrderConversationPort,
  PostgresOrderFileRepository,
  PostgresOrderRepository,
  StoreOrderError,
  STORE_ACTOR_ID,
  STORE_ACTOR_NAME,
} from '@crm-silmer/orders';

/**
 * @typedef {{
 *   authorizeRead(input: Record<string, unknown>): Promise<{actor: any}>,
 *   authorizeWrite(input: Record<string, unknown>): Promise<{actor: any}>,
 * }} OrderAccess
 * @typedef {{
 *   readAssignment(conversationId: string): Promise<{assignedUserId: string|null, version: number}|null>,
 *   readAssignments(conversationIds: string[]): Promise<Map<string, string|null>>,
 *   readLatestMessageStates(conversationIds: string[]): Promise<Map<string, {direction: string, occurredAt: string, sentAt: string|null, deliveryStatus: string|null, status: string}>>,
 *   readOrderContexts(conversationIds: string[]): Promise<Map<string, any>>,
 *   readContactNames?(contactIds: string[]): Promise<Map<string, string|null>>,
 *   readUserNames(userIds: string[]): Promise<Map<string, string|null>>,
 *   searchConversationIds(query: string): Promise<string[]>,
 *   searchContactIds?(query: string): Promise<string[]>,
 *   listAssignedOrderConversationIds?(userId: string): Promise<string[]>,
 * }} OrderConversationPort
 * @typedef {{id: string, kind: string, capabilities?: readonly string[]}} OrderActor
 * @typedef {{actor: OrderActor, correlationId: string, idempotencyKey: string}} OrderCommand
 */

/**
 * Composes the order service with the ownership rule of ADR 006: only the
 * conversation owner or a COMMERCIAL_ADMIN changes an order. The owner is read
 * from the conversation on every command, so "Repassar atendimento" moves the
 * order with the conversation and there is no separate order ownership.
 *
 * Every human command runs under its Idempotency-Key: a retry with the same
 * key and body replays the first response, another body is refused. The
 * record and the audit event share one transaction, while the order write
 * commits in the repository's own transaction; if the process dies between
 * them the retry re-runs and the optimistic version turns it into a 409, so a
 * command never applies twice.
 *
 * @param {{
 *   access: OrderAccess,
 *   auditTrail: any,
 *   conversations: OrderConversationPort,
 *   fabCode: string,
 *   idempotencyStore: {execute: (identity: any, operation: (transaction?: unknown) => Promise<unknown>, beforeExecute?: (transaction?: unknown) => Promise<unknown>) => Promise<unknown>},
 *   repository: any,
 *   files?: {repository: any, storage: any},
 *   phoneDigestsFor?: (query: string) => string[],
 *   clock?: () => Date,
 *   idFactory?: () => string,
 *   withMilestoneTransaction?: (method:'confirmPayment'|'confirmDelivery',input:any)=>Promise<any>,
 * }} options
 */
export function createOrderRuntime(options) {
  const { access, conversations } = options;
  if (
    typeof access?.authorizeRead !== 'function' ||
    typeof access.authorizeWrite !== 'function'
  ) {
    throw new TypeError('order access guards are required');
  }
  for (const method of [
    'readAssignment',
    'readAssignments',
    'readLatestMessageStates',
    'readUserNames',
  ]) {
    if (typeof (/** @type {any} */ (conversations)?.[method]) !== 'function') {
      throw new TypeError(`the conversation port must implement ${method}`);
    }
  }
  const execute = createIdempotentCommandExecutor({
    auditTrail: options.auditTrail,
    idempotencyStore: options.idempotencyStore,
  });

  /** @param {OrderActor} actor @param {string} conversationId */
  async function ownConversation(actor, conversationId) {
    const assignment = await conversations.readAssignment(conversationId);
    if (!assignment) {
      throw new OrderNotFoundError(
        'Conversation was not found',
        'CONVERSATION_NOT_FOUND',
      );
    }
    if (
      !(actor.capabilities ?? []).includes(CAPABILITIES.COMMERCIAL_ADMIN) &&
      assignment.assignedUserId !== actor.id
    ) {
      throw new OrderForbiddenError();
    }
    return assignment;
  }

  /** @param {OrderActor} actor @param {string} ownerId */
  async function ownManualOrder(actor, ownerId) {
    if (
      actor.kind !== 'human' ||
      !actor.id ||
      (actor.id !== ownerId &&
        !(actor.capabilities ?? []).includes(CAPABILITIES.COMMERCIAL_ADMIN))
    ) {
      throw new OrderForbiddenError();
    }
  }

  const service = createOrderService({
    /** @param {{actor: OrderActor, conversationId: string}} input */
    async authorizeOwnership({ actor, conversationId }) {
      await ownConversation(actor, conversationId);
    },
    authorizeManualOwnership: async ({ actor, ownerId }) =>
      ownManualOrder(actor, ownerId),
    clock: options.clock,
    conversations,
    fabCode: options.fabCode,
    idFactory: options.idFactory,
    phoneDigestsFor: options.phoneDigestsFor,
    repository: options.repository,
  });

  const storeCorrection = createStoreOrderCorrectionService({
    repository: options.repository,
    clock: options.clock,
  });

  // ADR 023: without object storage the art files stay off and their routes
  // answer 503, while the rest of the order keeps working.
  const fileService = options.files
    ? createOrderFileService({
        async authorizeOwnership({ actor, order }) {
          if (order.conversationId) {
            await ownConversation(actor, order.conversationId);
          } else {
            if (!order.manualOwnerId) throw new OrderForbiddenError();
            await ownManualOrder(actor, order.manualOwnerId);
          }
        },
        clock: options.clock,
        files: options.files.repository,
        orders: options.repository,
        storage: options.files.storage,
      })
    : undefined;

  /**
   * Shapes stored orders into the public Order contract: people are named,
   * the seller is the conversation's current owner and internal columns
   * (sequence, creator) stay out of the response. ADR 027: a store order
   * has no conversation, so no seller or last message; "Loja do site"
   * confirmed it and it is `locked`. ADR 028: it carries the shop's number,
   * the lead time of its colour and the payment InfinitePay confirmed, with
   * the receipt link kept in its ficha.
   *
   * @param {any[]} orders
   */
  async function present(orders) {
    if (orders.length === 0) return [];
    // T12: commercial readers need the same cross-account freeze as writers.
    // Only booleans cross this boundary; no ERP identity or grant is exposed.
    const olistMetadata = options.repository.readOlistCommercialMetadata
      ? await options.repository.readOlistCommercialMetadata(orders)
      : new Map(
          [
            ...((await options.repository.readFrozenOrderIds?.(orders)) ?? []),
          ].map((id) => [id, { locked: true, confirmationAllowed: false }]),
        );
    const conversationIds = [
      ...new Set(
        orders
          .map((order) => order.conversationId)
          .filter((id) => typeof id === 'string'),
      ),
    ];
    const [owners, latestMessageStates] =
      conversationIds.length === 0
        ? [new Map(), new Map()]
        : await Promise.all([
            conversations.readAssignments(conversationIds),
            conversations.readLatestMessageStates(conversationIds),
          ]);
    const people = new Set();
    for (const order of orders) {
      for (const id of [
        order.confirmedBy,
        order.cancelledBy,
        order.reopenedBy,
        order.fichaFirstPrintedBy,
        owners.get(order.conversationId),
        order.manualOwnerId,
      ]) {
        if (id && id !== STORE_ACTOR_ID) people.add(id);
      }
    }
    const names = await conversations.readUserNames([...people]);
    /** @param {string|null|undefined} id */
    const person = (id) => {
      if (!id) return null;
      if (id === STORE_ACTOR_ID) return { id, name: STORE_ACTOR_NAME };
      return { id, name: names.get(id) ?? '' };
    };
    return orders.map((order) => ({
      cancelledAt: order.cancelledAt ?? null,
      cancelledBy: person(order.cancelledBy),
      cancellationReason: order.cancellationReason ?? null,
      effectiveStatus: order.cancelledAt ? 'cancelado' : order.status,
      confirmedAt: order.confirmedAt,
      confirmedBy: person(order.confirmedBy),
      conversationId: order.conversationId,
      createdAt: order.createdAt,
      deliveredOn: order.deliveredOn,
      fabCode: order.fabCode,
      ficha: order.ficha,
      ...(order.ficha.sizePricing === undefined && !order.legacySizePricing
        ? {}
        : {
            pricing: sizePricingSummary(
              order.legacySizePricing
                ? { ...order.ficha, sizePricing: order.legacySizePricing }
                : order.ficha,
            ),
          }),
      // ADR 031: who printed a store order's ficha first, and when.
      fichaFirstPrintedAt: order.fichaFirstPrintedAt ?? null,
      fichaFirstPrintedBy: person(order.fichaFirstPrintedBy),
      finalAmountCents: order.finalAmountCents,
      firstContactAt: order.firstContactAt,
      gatewayPayment: order.gatewayPayment
        ? {
            ...order.gatewayPayment,
            receiptUrl: order.ficha?.loja?.comprovanteUrl ?? null,
          }
        : null,
      id: order.id,
      isTest: order.isTest === true,
      lastMessage: latestMessageStates.get(order.conversationId) ?? null,
      leadTimeBusinessDays: order.leadTimeBusinessDays ?? null,
      locked: order.origin === 'loja' || Boolean(order.cancelledAt),
      olistLocked: olistMetadata.get(order.id)?.locked === true,
      olistConfirmationAllowed:
        order.status === 'pendente' &&
        !order.cancelledAt &&
        olistMetadata.get(order.id)?.locked === true &&
        olistMetadata.get(order.id)?.confirmationAllowed === true,
      missingFields: order.missingFields,
      number: order.number,
      orderDate: order.orderDate,
      origin: order.origin ?? 'atendimento',
      paidOn: order.paidOn,
      paymentReviewRequired: order.paymentReviewRequired ?? false,
      paymentCondition: order.paymentCondition,
      reopenedAt: order.reopenedAt,
      reopenedBy: person(order.reopenedBy),
      seller: person(order.manualOwnerId ?? owners.get(order.conversationId)),
      status: order.status,
      storeNumber: order.storeNumber ?? null,
      totalPieces: order.totalPieces,
      updatedAt: order.updatedAt,
      version: order.version,
    }));
  }

  /** @param {any} order */
  async function presentOne(order) {
    return (await present([order]))[0];
  }

  /**
   * The public OrderFiles contract: names of who uploaded, storage keys and
   * hashes kept inside the API.
   *
   * @param {{final: any, references: any[]}} files
   */
  async function presentFiles(files) {
    const all = [files.final, ...files.references].filter(Boolean);
    const names = await conversations.readUserNames([
      ...new Set(all.map((file) => file.uploadedBy)),
    ]);
    /** @param {any} file */
    const one = (file) =>
      file && {
        contentType: file.contentType,
        extension: file.extension,
        id: file.id,
        name: file.name,
        sizeBytes: file.sizeBytes,
        slot: file.slot,
        thumbnail: file.thumbnailKey !== null,
        uploadedAt: file.uploadedAt,
        uploadedBy: {
          id: file.uploadedBy,
          name: names.get(file.uploadedBy) ?? '',
        },
      };
    return {
      final: one(files.final),
      limits: ORDER_FILE_LIMITS,
      references: files.references.map(one),
    };
  }

  function requireFiles() {
    if (!fileService) {
      throw Object.assign(new Error('Order files are not configured'), {
        code: 'FILE_STORAGE_UNAVAILABLE',
        statusCode: 503,
      });
    }
    return fileService;
  }

  /**
   * @template T
   * @param {OrderCommand} input
   * @param {{action: string, target: {type: string, id: string}, expectedVersion: unknown, command: unknown}} request
   * @param {(transaction?: unknown) => Promise<T>} effect
   * @param {(transaction?: unknown) => Promise<unknown>} [beforeExecute]
   * @returns {Promise<T>}
   */
  function run(input, request, effect, beforeExecute) {
    return /** @type {Promise<T>} */ (
      execute(
        {
          action: request.action,
          actor: input.actor?.id,
          command: request.command,
          correlationId: input.correlationId,
          key: input.idempotencyKey,
          reason: request.action,
          target: request.target,
          version: String(request.expectedVersion),
        },
        effect,
        beforeExecute,
      )
    );
  }

  return Object.freeze({
    /** @param {OrderCommand & {orderId:string, expectedVersion:number, reason:unknown}} input */
    async cancel(input) {
      await service.assertCancellationAccess(input);
      if (
        typeof input.reason !== 'string' ||
        !input.reason.trim() ||
        input.reason.trim().length > 1000 ||
        /[\u0000-\u001f\u007f]/u.test(input.reason)
      )
        throw new OrderInputError('A cancellation reason is required', [
          'reason',
        ]);
      const command = {
        ...input,
        expectedVersion: requireVersion(input.expectedVersion),
        reason: input.reason.trim(),
      };
      return run(
        command,
        {
          action: 'order.cancel',
          command: { reason: command.reason },
          expectedVersion: command.expectedVersion,
          target: { type: 'order', id: command.orderId },
        },
        async (transaction) =>
          presentOne(await service.cancel(command, transaction)),
        async (transaction) =>
          options.repository.assertCancellationAccess(command, transaction),
      );
    },
    /** @param {OrderCommand & {orderId: string, expectedVersion: number, expectedQuantity: number, expectedAmountCents: number, quantity: number, reason: string}} input */
    async correctStoreOrder(input) {
      if (
        input.actor?.kind !== 'human' ||
        !(input.actor.capabilities ?? []).includes(
          CAPABILITIES.COMMERCIAL_ADMIN,
        )
      )
        throw new OrderForbiddenError();
      if (input.reason !== 'USER_CONFIRMED_QUANTITY')
        throw new StoreOrderError(400, 'INVALID_CORRECTION_REASON');
      for (const value of [
        input.expectedQuantity,
        input.expectedAmountCents,
        input.quantity,
      ]) {
        if (!Number.isSafeInteger(value) || value < 1)
          throw new StoreOrderError(400, 'INVALID_REQUEST');
      }
      const expectedVersion = requireVersion(input.expectedVersion);
      return run(
        input,
        {
          action: 'order.store.correct',
          command: {
            expectedQuantity: input.expectedQuantity,
            expectedAmountCents: input.expectedAmountCents,
            quantity: input.quantity,
            reason: input.reason,
          },
          expectedVersion,
          target: { type: 'order', id: input.orderId },
        },
        async () => presentOne(await storeCorrection.correct(input)),
      );
    },
    authorizeRead: access.authorizeRead,
    authorizeWrite: access.authorizeWrite,
    ensurePendingFromIntent: service.ensurePendingFromIntent,
    projectAgentBriefing: service.projectAgentBriefing,
    summary: service.summary,

    /**
     * PCL-10/PCL-11 behind the conversation version the seller saw; an
     * existing pending order is answered with `created: false`.
     *
     * @param {OrderCommand & {conversationId: string, expectedVersion: number}} input
     */
    async createManual(input) {
      const expectedVersion = requireVersion(input.expectedVersion);
      return run(
        input,
        {
          action: 'order.create',
          command: { conversationId: input.conversationId, expectedVersion },
          expectedVersion,
          target: { id: input.conversationId, type: 'conversation' },
        },
        async () => {
          const assignment = await ownConversation(
            input.actor,
            input.conversationId,
          );
          if (Number(assignment.version) !== expectedVersion) {
            throw new OrderConflictError(
              `Expected conversation version ${expectedVersion}, current version is ${assignment.version}`,
            );
          }
          const result = await service.createManual(input);
          return {
            created: result.created,
            order: await presentOne(result.order),
          };
        },
      );
    },

    /** CP-03: an attendance order whose contact is known but chat is absent. */
    /** @param {OrderCommand & {contactId: string}} input */
    async createForContact(input) {
      return run(
        input,
        {
          action: 'order.create',
          command: { contactId: input.contactId },
          expectedVersion: 'new',
          target: { id: input.contactId, type: 'contact' },
        },
        async () => presentOne(await service.createForContact(input)),
      );
    },

    priceBreakdown: service.priceBreakdown,
    /** @param {OrderCommand & {orderId: string, value: unknown, expectedVersion: number}} input */
    async savePriceBreakdown(input) {
      await service.assertPriceBreakdownAccess(input);
      return run(
        input,
        {
          action: 'order.price_breakdown.edit',
          command: input.value,
          expectedVersion: requireVersion(input.expectedVersion),
          target: { type: 'order', id: input.orderId },
        },
        (transaction) => service.savePriceBreakdown(input, transaction),
      );
    },

    /** @param {OrderCommand & {orderId: string, section: string, value: unknown, expectedVersion: number}} input */
    async patchSection(input) {
      return run(
        input,
        {
          action: 'order.edit',
          command: { section: input.section, value: input.value },
          expectedVersion: input.expectedVersion,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentOne(await service.patchSection(input)),
      );
    },

    /** @param {OrderCommand & {orderId: string, amountText?: unknown, paymentCondition: unknown, expectedVersion: number}} input */
    async confirm(input) {
      return run(
        input,
        {
          action: 'order.confirm',
          // The fingerprint is canonical JSON, which has no undefined.
          command: {
            amountText: input.amountText ?? null,
            paymentCondition: input.paymentCondition ?? null,
          },
          expectedVersion: input.expectedVersion,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentOne(await service.confirm(input)),
      );
    },

    /** @param {OrderCommand & {orderId: string, expectedVersion: number}} input */
    async reopen(input) {
      return run(
        input,
        {
          action: 'order.reopen',
          command: {},
          expectedVersion: input.expectedVersion,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentOne(await service.reopen(input)),
      );
    },

    /** @param {OrderCommand & {orderId: string, paidOn: unknown, deliveredOn?: unknown, paymentReviewed?:boolean, expectedVersion: number}} input */
    async recordMilestones(input) {
      return run(
        input,
        {
          action: 'order.milestones',
          command: {
            ...(Object.hasOwn(input, 'deliveredOn')
              ? { deliveredOn: input.deliveredOn }
              : {}),
            paidOn: input.paidOn,
            paymentReviewed: input.paymentReviewed === true,
          },
          expectedVersion: input.expectedVersion,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentOne(await service.recordMilestones(input)),
      );
    },

    /** @param {{actor: OrderActor}} input */
    async deliveryTasks(input) {
      return { items: await present(await service.deliveryTasks(input)) };
    },

    /** @param {OrderCommand & {orderId:string,paidOn:unknown,receivedInFull:unknown,expectedVersion:number}} input */
    async confirmPayment(input) {
      if (options.withMilestoneTransaction)
        return options.withMilestoneTransaction('confirmPayment', input);
      return run(
        input,
        {
          action: 'order.payment.confirm',
          command: {
            paidOn: input.paidOn,
            receivedInFull: input.receivedInFull,
          },
          expectedVersion: input.expectedVersion,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentOne(await service.confirmPayment(input)),
      );
    },

    /** @param {OrderCommand & {orderId: string, expectedVersion: number}} input */
    async confirmDelivery(input) {
      if (options.withMilestoneTransaction)
        return options.withMilestoneTransaction('confirmDelivery', input);
      return run(
        input,
        {
          action: 'order.delivery.confirm',
          command: {},
          expectedVersion: input.expectedVersion,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentOne(await service.confirmDelivery(input)),
      );
    },

    /** @param {string} orderId */
    async listFiles(orderId) {
      return presentFiles(await requireFiles().list(orderId));
    },

    /**
     * ADR 023: the command fingerprint carries the content hashes, so a
     * retry with the same key and bytes replays the first answer and other
     * bytes under that key are refused.
     *
     * @param {OrderCommand & {orderId: string, slot: unknown, name: unknown, content: Buffer, thumbnail: Buffer|null}} input
     */
    async uploadFile(input) {
      const files = requireFiles();
      const contentSha256 = sha256Hex(input.content);
      return run(
        input,
        {
          action: 'order.file.upload',
          command: {
            contentSha256,
            name: typeof input.name === 'string' ? input.name : null,
            slot: typeof input.slot === 'string' ? input.slot : null,
            thumbnailSha256: input.thumbnail
              ? sha256Hex(input.thumbnail)
              : null,
          },
          expectedVersion: contentSha256,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentFiles((await files.upload(input)).files),
      );
    },

    /** @param {OrderCommand & {orderId: string, fileId: string}} input */
    async removeFile(input) {
      const files = requireFiles();
      return run(
        input,
        {
          action: 'order.file.remove',
          command: { fileId: input.fileId, orderId: input.orderId },
          expectedVersion: input.fileId,
          target: { id: input.orderId, type: 'order' },
        },
        async () => presentFiles((await files.remove(input)).files),
      );
    },

    /**
     * A download is audited like a command (who read which file), without
     * an idempotency record: reading twice is harmless.
     *
     * @param {{actor: OrderActor, correlationId: string, orderId: string, fileId: string}} input
     */
    async openFileContent(input) {
      const opened = await requireFiles().openContent(
        input.orderId,
        input.fileId,
      );
      await options.auditTrail.append({
        action: 'order.file.download',
        actor: input.actor.id,
        correlationId: input.correlationId,
        reason: 'order.file.download',
        target: { id: input.orderId, type: 'order' },
        version: input.fileId,
      });
      return opened;
    },

    /** @param {string} orderId @param {string} fileId */
    async openFileThumbnail(orderId, fileId) {
      return requireFiles().openThumbnail(orderId, fileId);
    },

    /**
     * ADR 031: the print route calls this before it sends a store order's
     * ficha. Reading twice is harmless, so there is no idempotency record;
     * the repository writes the first print, its event and its audit in one
     * transaction and ignores every later one.
     *
     * @param {{actor: OrderActor, correlationId: string, orderId: string}} input
     */
    async recordFirstPrint(input) {
      const { recorded } = await service.recordFirstPrint(input);
      return { recorded };
    },

    /** @param {string} orderId */
    async get(orderId) {
      return { order: await presentOne(await service.get(orderId)) };
    },

    /** @param {Parameters<typeof service.list>[0]} [filters] */
    async list(filters) {
      const page = await service.list(filters);
      return {
        counts: page.counts,
        items: await present(page.items),
        nextCursor: page.nextCursor,
      };
    },

    /**
     * The pending order, else the latest confirmed one, else null; a
     * conversation that does not exist is a 404 rather than "no order".
     *
     * @param {string} conversationId
     */
    async currentForConversation(conversationId) {
      const order = await service.currentForConversation(conversationId);
      if (order) return { order: await presentOne(order) };
      if (!(await conversations.readAssignment(conversationId))) {
        throw new OrderNotFoundError(
          'Conversation was not found',
          'CONVERSATION_NOT_FOUND',
        );
      }
      return { order: null };
    },
  });
}

/** @param {Buffer} content */
function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** @param {unknown} value */
function requireVersion(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new OrderInputError('expectedVersion is required', [
      'expectedVersion',
    ]);
  }
  return Number(value);
}

/**
 * PostgreSQL wiring. The session guards come from the operation runtime so
 * order routes share the Inbox read (session) and write (session + CSRF) rules.
 *
 * @param {any} database
 * @param {{access: OrderAccess, environment?: Record<string, string|undefined>, storage?: any, phoneDigestsFor?: (query: string) => string[], milestoneTransactions?:boolean}} options
 */
export function createOrderApiRuntime(database, options) {
  const environment = options.environment ?? process.env;
  const envelopeKey = readEnvelopeKey(
    environment.N8N_INTEGRATION_ENVELOPE_KEY,
    'N8N_INTEGRATION_ENVELOPE_KEY',
  );
  return createOrderRuntime({
    // ACT-12: these declarations and their encrypted receipts share one
    // transaction. Replays revalidate live access before opening the receipt.
    withMilestoneTransaction:
      options.milestoneTransactions === false
        ? undefined
        : (method, input) =>
            database.transaction(async (/** @type {any} */ client) => {
              if (input.actor?.kind !== 'human' || !input.actor.id)
                throw new OrderForbiddenError();
              const principal = (
                await client.query(
                  `SELECT u.id,f.function_name FROM crm.users u JOIN crm.user_functions f ON f.user_id=u.id WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f`,
                  [input.actor.id],
                )
              ).rows[0];
              if (!principal) throw new OrderForbiddenError();
              const grants = await client.query(
                'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
                [input.actor.id],
              );
              const actor = {
                id: input.actor.id,
                kind: /** @type {const} */ ('human'),
                functionName: principal.function_name,
                capabilities: grants.rows.map(
                  (/** @type {any} */ row) => row.capability,
                ),
              };
              authorize(actor, 'order.milestones');
              const reference = (
                await client.query(
                  'SELECT conversation_id FROM crm.orders WHERE id=$1',
                  [input.orderId],
                )
              ).rows[0];
              if (!reference) throw new OrderNotFoundError();
              let conversation;
              if (reference.conversation_id)
                conversation = (
                  await client.query(
                    'SELECT assigned_user_id FROM crm.conversations WHERE id=$1 FOR UPDATE',
                    [reference.conversation_id],
                  )
                ).rows[0];
              const current = (
                await client.query(
                  'SELECT conversation_id,manual_owner_id,origin,is_test,status FROM crm.orders WHERE id=$1 FOR UPDATE',
                  [input.orderId],
                )
              ).rows[0];
              if (
                !current ||
                current.conversation_id !== reference.conversation_id
              )
                throw new OrderNotFoundError();
              const owner = current.conversation_id
                ? conversation?.assigned_user_id
                : current.manual_owner_id;
              if (
                owner !== actor.id &&
                !actor.capabilities.includes(CAPABILITIES.COMMERCIAL_ADMIN)
              )
                throw new OrderForbiddenError();
              if (
                current.origin !== 'atendimento' ||
                current.is_test ||
                current.status !== 'confirmado'
              )
                throw new OrderConflictError(
                  'Only confirmed attendance orders support declarations',
                  'ORDER_STATUS_CONFLICT',
                );
              const bound = {
                query: client.query.bind(client),
                transaction: async (/** @type {any} */ work) => work(client),
              };
              return createOrderApiRuntime(bound, {
                ...options,
                milestoneTransactions: false,
              })[method]({ ...input, actor });
            }),
    access: options.access,
    auditTrail: new PostgresAuditTrail(database),
    conversations: new PostgresOrderConversationPort({
      contactEnvelopeKey: readEnvelopeKey(
        environment.CONTACT_IDENTITY_ENVELOPE_KEY,
        'CONTACT_IDENTITY_ENVELOPE_KEY',
      ),
      contactLookupKey: readEnvelopeKey(
        environment.CONTACT_IDENTITY_LOOKUP_KEY,
        'CONTACT_IDENTITY_LOOKUP_KEY',
      ),
      database,
      envelopeKey,
    }),
    fabCode: required(environment.FAB_CODE, 'FAB_CODE'),
    phoneDigestsFor: options.phoneDigestsFor,
    idempotencyStore: new PostgresIdempotencyRecordStore({
      database,
      envelopeKey: readEnvelopeKey(
        environment.IDEMPOTENCY_ENVELOPE_KEY,
        'IDEMPOTENCY_ENVELOPE_KEY',
      ),
    }),
    files: options.storage
      ? {
          repository: new PostgresOrderFileRepository({
            database,
            envelopeKey,
          }),
          storage: options.storage,
        }
      : undefined,
    repository: new PostgresOrderRepository({ database, envelopeKey }),
  });
}

/** @param {string|undefined} value @param {string} name */
function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required for the orders runtime`);
  }
  return value.trim();
}

/** @param {string|undefined} value @param {string} name */
function readEnvelopeKey(value, name) {
  const encoded = required(value, name);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(encoded)) {
    throw new Error(`${name} must use base64 or base64url`);
  }
  const key = Buffer.from(
    encoded,
    encoded.includes('-') || encoded.includes('_') ? 'base64url' : 'base64',
  );
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return key;
}
