import { randomUUID } from 'node:crypto';

import {
  OrderConflictError,
  OrderForbiddenError,
  OrderInputError,
  OrderNotFoundError,
} from '../domain/errors.js';
import {
  briefingToFicha,
  normalizeFicha,
  orderClient,
  orderTotal,
  projectBriefingOntoFicha,
  validateItems,
  validateArtwork,
  validateObservations,
  validateSummary,
} from '../domain/ficha.js';
import { parseBrlAmount } from '../domain/money.js';
import {
  confirmOrder,
  missingForConfirmation,
  operationalDay,
  promisedDeliveryOn,
  recordMilestones,
  reopenOrder,
  shiftDay,
  summaryPeriod,
} from '../domain/order.js';
import { requireUnlocked } from '../domain/store-order.js';
import {
  MAX_ORDER_PAGE_SIZE,
  assertOrderRepositoryContract,
} from '../ports/contracts.js';

/**
 * `openedAt` is when the first inbound message opened the conversation.
 *
 * @typedef {import('../domain/order.js').Order} Order
 * @typedef {import('../domain/ficha.js').Ficha} Ficha
 * @typedef {{id: string, kind: string, capabilities?: readonly string[]}} OrderActor
 * @typedef {{briefing: Record<string, unknown>|null, customerName: string|null, openedAt?: string|null}} OrderConversationContext
 * @typedef {{
 *   repository: import('../ports/contracts.js').OrderRepository,
 *   conversations: {
 *     readOrderContexts(conversationIds: string[]): Promise<Map<string, OrderConversationContext>>,
 *     readContactNames?(contactIds: string[]): Promise<Map<string, string|null>>,
 *     searchConversationIds(query: string): Promise<string[]>,
 *     searchContactIds?(query: string): Promise<string[]>,
 *     listAssignedOrderConversationIds?(userId: string): Promise<string[]>,
 *   },
 *   authorizeOwnership(input: {actor: OrderActor, conversationId: string}): Promise<void>,
 *   authorizeManualOwnership?(input: {actor: OrderActor, ownerId: string}): Promise<void>,
 *   fabCode: string,
 *   phoneDigestsFor?: (query: string) => string[],
 *   clock?: () => Date,
 *   idFactory?: () => string,
 * }} OrderServiceOptions
 */

/** @param {unknown} value @param {string} name */
function requireId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

export const ORDER_SECTIONS = Object.freeze(
  /** @type {const} */ (['summary', 'items', 'observations', 'artwork']),
);
export const DEFAULT_ORDER_PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 120;
const LIST_KEYS = new Set([
  'status',
  'origin',
  'q',
  'cursor',
  'limit',
  'delivery',
  'ownerId',
]);
// Painel: "Entrega atrasada" (promised day before today) and "Próximas
// entregas" (today and the six days after), on São Paulo days.
const DELIVERY_FILTERS = new Set(['overdue', 'due_soon']);
const DUE_SOON_DAYS = 7;
// "12", "012" or "12-CRM" name order 12; anything else is a customer search.
const ORDER_NUMBER_QUERY = /^0*(\d{1,15})(?:-crm)?$/iu;
// ADR 028: "LJ-5B0C77ED", "lj5b0c77ed" or "#LJ-5B0C77ED" name a store order.
const STORE_NUMBER_QUERY = /^#?lj-?([0-9a-f]{8})$/iu;

/**
 * Keeps the columns the list reads without decrypting in step with the ficha.
 *
 * @template {Pick<Order, 'ficha'|'status'|'finalAmountCents'|'paymentCondition'>} T
 * @param {T} order
 * @returns {T & {totalPieces: number, missingFields: string[]}}
 */
function withDerivedFields(order) {
  return {
    ...order,
    missingFields: missingForConfirmation(order),
    totalPieces: orderTotal(order.ficha.items),
  };
}

/**
 * ADR 016: an order as the current rules read it. A ficha stored before the
 * seven-point item gets its new fields blank, and what is missing is worked
 * out again, so an order saved under the old rule never shows the old list.
 *
 * @param {Order} order
 * @returns {Order}
 */
function current(order) {
  return withDerivedFields({ ...order, ficha: normalizeFicha(order.ficha) });
}

/**
 * Application service for the Pedido (ADR 006). The conversation context and
 * the ownership rule are injected: the service decides what happens to an
 * order, the API runtime decides who owns the conversation.
 *
 * @param {OrderServiceOptions} options
 */
export function createOrderService(options) {
  const { authorizeOwnership, conversations, fabCode, repository } = options;
  assertOrderRepositoryContract(repository);
  if (
    typeof conversations?.readOrderContexts !== 'function' ||
    typeof conversations.searchConversationIds !== 'function'
  ) {
    throw new TypeError('a conversation context port is required');
  }
  if (typeof authorizeOwnership !== 'function') {
    throw new TypeError('an ownership check is required');
  }
  requireId(fabCode, 'fabCode');
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  /**
   * PCT-01 (ADR 018): a pending order reads its client from its conversation
   * again (PIT-11: the contact's confirmed name, else the bot's
   * `customer_name`, else blank), so renaming the contact reaches it without
   * writing the order: its version and the time it last changed stay as they
   * were. A confirmed order keeps the client written when it was generated
   * (PCT-02). One query covers every pending order handed in.
   *
   * @param {Order[]} orders
   * @returns {Promise<Order[]>}
   */
  async function withCurrentClient(orders) {
    // A pending order always has a conversation; a store order (ADR 027)
    // is born confirmed and never reads one.
    const pendingConversations = [
      ...new Set(
        orders
          .filter((order) => order.status === 'pendente')
          .map((order) => /** @type {string} */ (order.conversationId)),
      ),
    ];
    const pendingManualContacts = [
      ...new Set(
        orders
          .filter(
            (order) => order.status === 'pendente' && !order.conversationId,
          )
          .map((order) => order.contactId)
          .filter((id) => typeof id === 'string'),
      ),
    ];
    if (
      pendingConversations.length === 0 &&
      pendingManualContacts.length === 0
    ) {
      return orders;
    }
    const [contexts, contactNames] = await Promise.all([
      conversations.readOrderContexts(pendingConversations),
      pendingManualContacts.length && conversations.readContactNames
        ? conversations.readContactNames(
            /** @type {string[]} */ (pendingManualContacts),
          )
        : new Map(),
    ]);
    return orders.map((order) => {
      if (order.status !== 'pendente') return order;
      if (!order.conversationId && order.contactId) {
        return {
          ...order,
          ficha: {
            ...order.ficha,
            summary: {
              ...order.ficha.summary,
              cliente: contactNames.get(order.contactId) ?? '',
            },
          },
        };
      }
      const context = contexts.get(
        /** @type {string} */ (order.conversationId),
      );
      if (!context) return order;
      return {
        ...order,
        ficha: {
          ...order.ficha,
          summary: { ...order.ficha.summary, cliente: orderClient(context) },
        },
      };
    });
  }

  /**
   * Orders as people see them: under the current rules, with the current
   * client.
   *
   * @param {Order[]} orders
   */
  async function readAll(orders) {
    return (await withCurrentClient(orders)).map(current);
  }

  /** @param {Order} order */
  async function readOne(order) {
    const [read] = await readAll([order]);
    return read;
  }

  /** @param {OrderActor} actor @param {Order} order */
  async function requireOwner(actor, order) {
    if (
      actor?.kind !== 'human' ||
      typeof actor.id !== 'string' ||
      actor.id === ''
    ) {
      throw new OrderForbiddenError('A human actor is required');
    }
    if (order.conversationId) {
      await authorizeOwnership({ actor, conversationId: order.conversationId });
    } else if (order.manualOwnerId && options.authorizeManualOwnership) {
      await options.authorizeManualOwnership({
        actor,
        ownerId: order.manualOwnerId,
      });
    } else {
      throw new OrderForbiddenError();
    }
  }

  /**
   * Resolves and authorizes a human command on an existing order. Ownership
   * is checked before the version so a non-owner learns nothing about it; the
   * early version check keeps a stale screen from seeing a rule error that no
   * longer applies. The repository re-checks the version atomically.
   *
   * @param {{orderId: string, expectedVersion: number, actor: OrderActor, correlationId: string}} input
   */
  async function loadForCommand(input) {
    const orderId = requireId(input.orderId, 'orderId');
    requireId(input.correlationId, 'correlationId');
    if (!Number.isSafeInteger(input.expectedVersion)) {
      throw new OrderInputError('expectedVersion is required', [
        'expectedVersion',
      ]);
    }
    const order = await repository.findById(orderId);
    if (!order) throw new OrderNotFoundError();
    // ADR 027: a store order is locked for everyone, owner or not.
    requireUnlocked(order);
    await requireOwner(input.actor, order);
    if (order.version !== input.expectedVersion) {
      throw new OrderConflictError(
        `Expected order version ${input.expectedVersion}, current version is ${order.version}`,
      );
    }
    // A command works on the client the order shows now, so saving a
    // section writes it and generating keeps it (ADR 018).
    return readOne(order);
  }

  /**
   * @param {{conversationId: string, correlationId: string, createdByKind: 'automation'|'user', createdBy: string|null, actor?: OrderActor}} input
   * @returns {Promise<{created: boolean, order: Order}>}
   */
  async function ensurePending(input) {
    const existing = await repository.findPendingByConversation(
      input.conversationId,
    );
    if (existing) return { created: false, order: await readOne(existing) };

    const context = (
      await conversations.readOrderContexts([input.conversationId])
    ).get(input.conversationId);
    if (!context) {
      throw new OrderNotFoundError(
        'Conversation was not found',
        'CONVERSATION_NOT_FOUND',
      );
    }
    const ficha = briefingToFicha(context.briefing);
    ficha.summary.cliente = orderClient(context);
    const derived = withDerivedFields({
      finalAmountCents: null,
      ficha,
      paymentCondition: null,
      status: /** @type {const} */ ('pendente'),
    });
    try {
      const order = await repository.createPending({
        ...(input.actor ? { actor: input.actor } : {}),
        conversationId: input.conversationId,
        correlationId: input.correlationId,
        createdBy: input.createdBy,
        createdByKind: input.createdByKind,
        fabCode,
        ficha,
        // ADR 008: the order keeps when its conversation began.
        firstContactAt: context.openedAt ?? null,
        id: idFactory(),
        missingFields: derived.missingFields,
        now: clock(),
        totalPieces: derived.totalPieces,
      });
      return { created: true, order: current(order) };
    } catch (error) {
      // Two intents raced; the one that lost reuses the winner's order.
      if (/** @type {any} */ (error)?.code !== 'ORDER_PENDING_EXISTS') {
        throw error;
      }
      const winner = await repository.findPendingByConversation(
        input.conversationId,
      );
      if (!winner) throw error;
      return { created: false, order: await readOne(winner) };
    }
  }

  /**
   * The open deliveries with their promised day, earliest first. Orders
   * without a promised day (store orders, older fichas) are left out.
   *
   * @param {Date} now
   */
  async function promisedDeliveries(now) {
    const today = operationalDay(now);
    const dueSoonUntil = shiftDay(today, DUE_SOON_DAYS - 1);
    const deliveries = (await repository.openDeliveries())
      .map((order) => ({ day: promisedDeliveryOn(order), order }))
      .filter(
        /** @returns {entry is {day: string, order: Order}} */
        (entry) => entry.day !== null,
      )
      .sort(
        (left, right) =>
          left.day.localeCompare(right.day) ||
          left.order.numberSequence - right.order.numberSequence,
      );
    return {
      dueSoon: deliveries.filter(
        ({ day }) => day >= today && day <= dueSoonUntil,
      ),
      dueSoonUntil,
      overdue: deliveries.filter(({ day }) => day < today),
      today,
    };
  }

  return Object.freeze({
    /**
     * The Painel figures. The all-time totals stay as ADR 031 defined them;
     * `period` adds the confirmed sales of today, the last seven days or the
     * month so far, and `deliveries` the promised days that passed without
     * "Entregue em" and the ones due this week. Days are São Paulo days and
     * are worked out here, so every screen agrees on what "hoje" is.
     *
     * @param {{period?: unknown}} [input]
     */
    async summary(input = {}) {
      const now = clock();
      const period = summaryPeriod(
        /** @type {any} */ (input.period ?? 'hoje'),
        now,
      );
      const [totals, deliveries] = await Promise.all([
        repository.summary({ from: period.from, to: period.to }),
        promisedDeliveries(now),
      ]);
      return {
        ...totals,
        deliveries: {
          dueSoonCount: deliveries.dueSoon.length,
          dueSoonUntil: deliveries.dueSoonUntil,
          oldestOverdueOn: deliveries.overdue[0]?.day ?? null,
          overdueCount: deliveries.overdue.length,
        },
        period: { ...period, ...totals.period },
        today: deliveries.today,
      };
    },

    /**
     * ADR 031: a person printed or downloaded a store order's ficha. The
     * first print records who and when, and takes the order out of the
     * Dashboard notice; every later print, and any other order, changes
     * nothing. Printing is open to every seller (`order.print`), so there is
     * no ownership check, only a person.
     *
     * @param {{orderId: string, actor: OrderActor, correlationId: string}} input
     * @returns {Promise<{recorded: boolean, order: Order}>}
     */
    async recordFirstPrint(input) {
      const orderId = requireId(input.orderId, 'orderId');
      const correlationId = requireId(input.correlationId, 'correlationId');
      if (
        input.actor?.kind !== 'human' ||
        typeof input.actor.id !== 'string' ||
        input.actor.id === ''
      ) {
        throw new OrderForbiddenError('A human actor is required');
      }
      const result = await repository.recordFirstPrint({
        actorId: input.actor.id,
        correlationId,
        now: clock(),
        orderId,
      });
      return { order: await readOne(result.order), recorded: result.recorded };
    },
    /**
     * PCL-01..03: idempotent — a pending order is reused, a conversation with
     * only confirmed orders gets a new one.
     *
     * @param {{conversationId: string, correlationId: string}} input
     */
    async ensurePendingFromIntent(input) {
      return ensurePending({
        conversationId: requireId(input.conversationId, 'conversationId'),
        correlationId: requireId(input.correlationId, 'correlationId'),
        createdBy: null,
        createdByKind: 'automation',
      });
    },

    /**
     * PCL-10/PCL-11: the owner or an admin creates the order the agent never
     * detected; an existing pending order is returned instead.
     *
     * @param {{conversationId: string, correlationId: string, actor: OrderActor}} input
     */
    async createManual(input) {
      const conversationId = requireId(input.conversationId, 'conversationId');
      if (input.actor?.kind !== 'human' || !input.actor.id) {
        throw new OrderForbiddenError('A human actor is required');
      }
      await authorizeOwnership({ actor: input.actor, conversationId });
      return ensurePending({
        conversationId,
        correlationId: requireId(input.correlationId, 'correlationId'),
        createdBy: input.actor.id,
        createdByKind: 'user',
        actor: input.actor,
      });
    },

    /** CP-03: a seller opens a new draft for a contact without a chat. */
    /** @param {{contactId: string, idempotencyKey: string, correlationId: string, actor: OrderActor}} input */
    async createForContact(input) {
      const contactId = requireId(input.contactId, 'contactId');
      const manualCreateKey = requireId(input.idempotencyKey, 'idempotencyKey');
      if (
        input.actor?.kind !== 'human' ||
        !input.actor.id ||
        typeof conversations.readContactNames !== 'function'
      ) {
        throw new OrderForbiddenError();
      }
      const names = await conversations.readContactNames([contactId]);
      if (!names.has(contactId)) {
        throw new OrderNotFoundError(
          'Contact was not found',
          'CONTACT_NOT_FOUND',
        );
      }
      const ficha = briefingToFicha(null);
      ficha.summary.cliente = names.get(contactId) ?? '';
      const derived = withDerivedFields({
        finalAmountCents: null,
        ficha,
        paymentCondition: null,
        status: /** @type {const} */ ('pendente'),
      });
      const now = clock();
      const order = await repository.createPending({
        actor: input.actor,
        contactId,
        conversationId: null,
        correlationId: requireId(input.correlationId, 'correlationId'),
        createdBy: input.actor.id,
        createdByKind: 'user',
        fabCode,
        ficha,
        firstContactAt: now.toISOString(),
        id: idFactory(),
        manualCreateKey,
        manualOwnerId: input.actor.id,
        missingFields: derived.missingFields,
        now,
        totalPieces: derived.totalPieces,
      });
      return readOne(order);
    },

    /**
     * PAG-01/PAG-02: projects the merged pre-ficha into the pending order only
     * while the agent holds the conversation.
     *
     * @param {{conversationId: string, correlationId: string, briefing: Record<string, unknown>|null, automationState: string, orderId?: string|null, subjectId?: string|null, automationEpoch?: number|null, sourceRevision?: number|null, eventId?: string|null, eventType?: string|null, expectedSubjectVersion?: number|null, expectedOrderVersion?: number|null, recovery?: boolean}} input
     * @returns {Promise<{applied: boolean, order: Order|null, reason: string|null}>}
     */
    async projectAgentBriefing(input) {
      const conversationId = requireId(input.conversationId, 'conversationId');
      const correlationId = requireId(input.correlationId, 'correlationId');
      if (
        input.automationState !== 'assistant' &&
        input.eventType !== 'handoff.requested' &&
        !input.orderId
      ) {
        return { applied: false, order: null, reason: 'human' };
      }
      if (Boolean(input.orderId) !== Boolean(input.subjectId)) {
        throw new OrderInputError(
          'Explicit projection requires subject and order',
        );
      }
      const pending = input.orderId
        ? await repository.findById(requireId(input.orderId, 'orderId'))
        : await repository.findPendingByConversation(conversationId);
      if (!pending) {
        return { applied: false, order: null, reason: 'no_pending_order' };
      }
      if (
        input.orderId &&
        (pending.status !== 'pendente' || pending.origin !== 'atendimento')
      ) {
        throw new OrderConflictError(
          'The selected order is not pending',
          'ORDER_STATUS_CONFLICT',
        );
      }
      if (
        input.orderId &&
        (!Number.isSafeInteger(input.automationEpoch) ||
          !Number.isSafeInteger(input.sourceRevision) ||
          !Number.isSafeInteger(input.expectedSubjectVersion) ||
          !Number.isSafeInteger(input.expectedOrderVersion))
      ) {
        throw new OrderInputError(
          'Explicit projection requires epoch and revision',
        );
      }
      // The projection writes the client the order shows now (ADR 018).
      const [shown] = await withCurrentClient([pending]);
      const next = withDerivedFields({
        ...shown,
        ficha: projectBriefingOntoFicha(shown.ficha, input.briefing),
        updatedAt: clock().toISOString(),
      });
      const order = await repository.projectBriefing(next, {
        correlationId,
        expectedVersion: pending.version,
        ...(input.orderId
          ? {
              agentTarget: {
                conversationId,
                orderId: input.orderId,
                subjectId: /** @type {string} */ (input.subjectId),
                automationEpoch: /** @type {number} */ (input.automationEpoch),
                sourceRevision: /** @type {number} */ (input.sourceRevision),
                eventId: requireId(input.eventId, 'eventId'),
                eventType: requireId(input.eventType, 'eventType'),
                expectedSubjectVersion: /** @type {number} */ (
                  input.expectedSubjectVersion
                ),
                expectedOrderVersion: /** @type {number} */ (
                  input.expectedOrderVersion
                ),
                recovery: input.recovery === true,
              },
            }
          : {}),
      });
      return { applied: true, order: current(order), reason: null };
    },

    /** @param {string} orderId */
    async get(orderId) {
      const order = await repository.findById(requireId(orderId, 'orderId'));
      if (!order) throw new OrderNotFoundError();
      return readOne(order);
    },

    /**
     * PLI-02..07: status filter, number/customer/phone search and "Ver mais"
     * pages. Counts cover the search regardless of the status filter, so both
     * groups keep their totals while one is selected. ADR 027: `origin`
     * narrows to store orders, which the search finds by number, by the
     * HMAC of the whole phone or (ADR 028) by the shop's `LJ-…` number.
     *
     * Painel: `delivery` lists the confirmed orders whose promised day
     * passed (`overdue`) or comes this week (`due_soon`), earliest first.
     *
     * `ownerId` (Painel, "Meus pedidos") keeps one seller's orders.
     *
     * @param {{status?: string, origin?: string, q?: string, cursor?: string|null, limit?: number, delivery?: string, ownerId?: string}} [input]
     */
    async list(input = {}) {
      for (const key of Object.keys(input)) {
        if (!LIST_KEYS.has(key)) {
          throw new OrderInputError(`${key} is not allowed`, [key]);
        }
      }
      if (input.q !== undefined && typeof input.q !== 'string') {
        throw new OrderInputError('q must be text', ['q']);
      }
      const q = (input.q ?? '').trim();
      if (q.length > MAX_QUERY_LENGTH) {
        throw new OrderInputError('q is too long', ['q']);
      }
      if (input.delivery !== undefined) {
        // A delivery view is one short list in promised order: it does not
        // combine with the other filters or page with a cursor.
        if (
          !DELIVERY_FILTERS.has(/** @type {string} */ (input.delivery)) ||
          ['status', 'origin', 'q', 'cursor', 'ownerId'].some(
            (key) => /** @type {any} */ (input)[key] !== undefined,
          )
        ) {
          throw new OrderInputError('delivery is invalid', ['delivery']);
        }
        const deliveries = await promisedDeliveries(clock());
        const matching =
          input.delivery === 'overdue'
            ? deliveries.overdue
            : deliveries.dueSoon;
        return {
          counts: { confirmado: matching.length, pendente: 0 },
          items: await readAll(
            matching.slice(0, MAX_ORDER_PAGE_SIZE).map((entry) => entry.order),
          ),
          nextCursor: null,
        };
      }
      /** @type {import('../ports/contracts.js').OrderListQuery} */
      const query = {
        cursor: input.cursor ?? null,
        limit: input.limit ?? DEFAULT_ORDER_PAGE_SIZE,
        status: /** @type {any} */ (input.status),
      };
      if (input.origin !== undefined) {
        query.origin = /** @type {any} */ (input.origin);
      }
      if (input.ownerId !== undefined) {
        const userId = requireId(input.ownerId, 'ownerId');
        query.owner = {
          conversationIds:
            (await conversations.listAssignedOrderConversationIds?.(userId)) ??
            [],
          userId,
        };
      }
      if (q !== '') {
        const number = ORDER_NUMBER_QUERY.exec(q);
        if (number && Number(number[1]) > 0) {
          query.numberSequence = Number(number[1]);
        }
        query.conversationIds = await conversations.searchConversationIds(q);
        if (conversations.searchContactIds) {
          query.contactIds = await conversations.searchContactIds(q);
        }
        const phoneDigests = options.phoneDigestsFor?.(q) ?? [];
        if (phoneDigests.length > 0) query.phoneDigests = phoneDigests;
        const storeNumber = STORE_NUMBER_QUERY.exec(q);
        if (storeNumber) {
          query.storeNumber = `LJ-${storeNumber[1].toUpperCase()}`;
        }
      }
      const page = await repository.list(query);
      return { ...page, items: await readAll(page.items) };
    },

    /**
     * PCX-06/PCX-07: what the conversation drawer shows — the pending order,
     * otherwise the most recently confirmed one.
     *
     * @param {string} conversationId
     * @returns {Promise<Order|null>}
     */
    async currentForConversation(conversationId) {
      const orders = await repository.listByConversation(
        requireId(conversationId, 'conversationId'),
      );
      const pending = orders.find((order) => order.status === 'pendente');
      if (pending) return readOne(pending);
      const confirmed = orders
        .filter((order) => order.status === 'confirmado')
        .sort((left, right) =>
          String(right.confirmedAt).localeCompare(String(left.confirmedAt)),
        )[0];
      return confirmed ? readOne(confirmed) : null;
    },

    /**
     * PFI-06: a section is saved whole; totals and what is missing follow.
     * A confirmed order must be reopened first (PFI-10).
     *
     * @param {{orderId: string, section: string, value: unknown, expectedVersion: number, actor: OrderActor, correlationId: string}} input
     */
    async patchSection(input) {
      const section = /** @type {typeof ORDER_SECTIONS[number]} */ (
        input.section
      );
      if (!ORDER_SECTIONS.includes(section)) {
        throw new OrderInputError('section is invalid', ['section']);
      }
      const order = await loadForCommand(input);
      if (order.status !== 'pendente') {
        throw new OrderConflictError(
          'Reopen the order before editing it',
          'ORDER_STATUS_CONFLICT',
        );
      }
      const ficha = structuredClone(order.ficha);
      if (section === 'summary') {
        ficha.summary = {
          ...validateSummary(input.value),
          // ADR 020: the legacy order-wide technique is kept, never edited.
          aplicacao: ficha.summary.aplicacao ?? null,
          cliente: ficha.summary.cliente,
        };
      } else if (section === 'items') {
        ficha.items = validateItems(input.value);
      } else if (section === 'artwork') {
        ficha.artwork = {
          ...validateArtwork(input.value),
          files: ficha.artwork?.files ?? [],
        };
      } else {
        ficha.observations = validateObservations(input.value);
      }
      return current(
        await repository.saveSection(
          withDerivedFields({
            ...order,
            ficha,
            updatedAt: clock().toISOString(),
          }),
          {
            actor: input.actor,
            correlationId: input.correlationId,
            expectedVersion: order.version,
          },
        ),
      );
    },

    /**
     * PCL-04..06: a blank amount counts as missing (reported with the other
     * blockers); a malformed one is refused as INVALID_AMOUNT. The ficha is
     * written with the status, so the order keeps the client it showed when
     * it was generated, on screen and on paper (PCT-02, ADR 018).
     *
     * @param {{orderId: string, amountText: unknown, paymentCondition: unknown, expectedVersion: number, actor: OrderActor, correlationId: string}} input
     */
    async confirm(input) {
      const order = await loadForCommand(input);
      const amountCents =
        typeof input.amountText === 'string' && input.amountText.trim() !== ''
          ? parseBrlAmount(input.amountText)
          : 0;
      return current(
        await repository.saveStatus(
          confirmOrder(order, {
            actorId: input.actor.id,
            amountCents,
            now: clock(),
            paymentCondition:
              /** @type {import('../domain/order.js').PaymentCondition} */ (
                input.paymentCondition
              ),
          }),
          {
            actor: input.actor,
            correlationId: input.correlationId,
            expectedVersion: order.version,
          },
        ),
      );
    },

    /**
     * PCL-07: back to pending, keeping number, amount and condition. Pending
     * again, the order follows the contact's name again (PCT-03).
     *
     * @param {{orderId: string, expectedVersion: number, actor: OrderActor, correlationId: string}} input
     */
    async reopen(input) {
      const order = await loadForCommand(input);
      return readOne(
        await repository.saveStatus(
          reopenOrder(order, { actorId: input.actor.id, now: clock() }),
          {
            actor: input.actor,
            correlationId: input.correlationId,
            expectedVersion: order.version,
          },
        ),
      );
    },

    /**
     * PLA-04/PLA-05: the owner or an admin records when the customer paid and
     * when the order was delivered, in either status; both days travel in one
     * write and null clears one.
     *
     * @param {{orderId: string, paidOn: unknown, deliveredOn?: unknown, paymentReviewed?:boolean, expectedVersion: number, actor: OrderActor, correlationId: string}} input
     */
    async recordMilestones(input) {
      const order = await loadForCommand(input);
      const manual = order.conversationId === null;
      if (manual && Object.hasOwn(input, 'deliveredOn')) {
        throw new OrderInputError('Manual delivery requires confirmation');
      }
      return readOne(
        await repository.saveMilestones(
          recordMilestones(order, {
            deliveredOn: manual ? order.deliveredOn : input.deliveredOn,
            now: clock(),
            paidOn: input.paidOn,
          }),
          {
            paymentReviewed: input.paymentReviewed === true,
            actor: input.actor,
            correlationId: input.correlationId,
            expectedVersion: order.version,
          },
        ),
      );
    },

    /** PLA-10: derived afazeres, always scoped to their responsible seller.
     * @param {{actor: OrderActor}} input
     */
    async deliveryTasks(input) {
      if (input.actor?.kind !== 'human' || !input.actor.id) {
        throw new OrderForbiddenError('A human actor is required');
      }
      const orders = (await repository.openDeliveries())
        .filter(
          (order) =>
            order.conversationId === null &&
            order.manualOwnerId === input.actor.id,
        )
        .sort(
          (left, right) =>
            (promisedDeliveryOn(left) ?? '9999-12-31').localeCompare(
              promisedDeliveryOn(right) ?? '9999-12-31',
            ) || left.numberSequence - right.numberSequence,
        );
      return readAll(orders);
    },

    /** ACT-04: a payment declaration changes only payment, never delivery.
     * @param {{orderId:string,paidOn:unknown,receivedInFull:unknown,expectedVersion:number,actor:OrderActor,correlationId:string}} input
     */
    async confirmPayment(input) {
      const order = await loadForCommand(input);
      if (order.status !== 'confirmado' || order.isTest) {
        throw new OrderConflictError(
          'Only confirmed attendance orders can be paid',
          'ORDER_STATUS_CONFLICT',
        );
      }
      if (input.receivedInFull !== true || !input.paidOn) {
        throw new OrderInputError('Full payment and its day are required', [
          'paidOn',
        ]);
      }
      return readOne(
        await repository.saveMilestones(
          recordMilestones(order, {
            paidOn: input.paidOn,
            deliveredOn: order.deliveredOn,
            now: clock(),
          }),
          {
            actor: input.actor,
            correlationId: input.correlationId,
            expectedVersion: order.version,
            paymentReviewed: true,
          },
        ),
      );
    },

    /** ACT-04 / PLA-11: today's São Paulo day after human confirmation.
     * @param {{orderId: string, expectedVersion: number, actor: OrderActor, correlationId: string}} input
     */
    async confirmDelivery(input) {
      const order = await loadForCommand(input);
      if (order.status !== 'confirmado' || order.isTest) {
        throw new OrderConflictError(
          'Only confirmed attendance orders can be delivered',
          'ORDER_STATUS_CONFLICT',
        );
      }
      if (order.deliveredOn) return order;
      const now = clock();
      return readOne(
        await repository.saveMilestones(
          recordMilestones(order, {
            paidOn: order.paidOn,
            deliveredOn: operationalDay(now),
            now,
          }),
          {
            actor: input.actor,
            correlationId: input.correlationId,
            expectedVersion: order.version,
          },
        ),
      );
    },
  });
}
