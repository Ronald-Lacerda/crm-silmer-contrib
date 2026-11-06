import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import {
  confirmOrder,
  recordMilestones,
  reopenOrder,
} from '../modules/orders/src/domain/order.js';
import { assertOrderRepositoryContract } from '../modules/orders/src/ports/contracts.js';
import { fixturePricing } from './fixtures/size-pricing.js';

/**
 * @typedef {{
 *   repository: any,
 *   newConversationId: () => Promise<string>,
 *   readEvents: (orderId: string) => Promise<Array<{eventType: string, aggregateVersion: number, payload: Record<string, unknown>}>>,
 *   close?: () => Promise<void>,
 * }} OrderRepositoryHarness
 */

const BASE_TIME = Date.parse('2026-09-12T12:00:00.000Z');
const FIRST_CONTACT_AT = '2026-09-01T13:05:00.000Z';
const CONTRACT_ACTOR = Object.freeze({
  id: 'seller-contract',
  kind: 'human',
  capabilities: [],
});
let tick = 0;
/** Distinct, increasing timestamps keep the updated_at ordering deterministic. */
function nextNow() {
  tick += 1;
  return new Date(BASE_TIME + tick * 1000);
}

/** @returns {import('../modules/orders/src/domain/ficha.js').Ficha} */
function draftFicha() {
  return {
    artwork: {
      feito_pela_silmer: false,
      feito_pelo_cliente: true,
      files: [],
      sem_estampa: false,
    },
    items: [
      {
        cor: 'AZUL',
        cor_costas: 'AZUL',
        cor_frente: 'AZUL',
        cor_manga_direita: 'NAO APLICAVEL',
        cor_manga_esquerda: 'NAO APLICAVEL',
        estampa: 'Arte do cliente',
        gola: 'GOLA REDONDA',
        grade: [{ quantidade: 5, tamanho: 'M' }],
        malhas: ['DRY FIT'],
        modelo: 'TRADICIONAL',
        publico: 'masculino',
        quantidade_informada: 5,
        tipo: 'CAMISA',
        tipo_servico: 'SUBLIMAÇÃO',
        vies_gola: 'OLIMPICA',
        vies_mangas: 'NAO APLICAVEL',
      },
    ],
    observations: [],
    serviceData: { purpose: 'campeonato' },
    summary: {
      aplicacao: null,
      cliente: 'Cliente Sintetico',
      data_entrega_confirmada: '2026-10-24',
      nome: 'Evento Sintetico',
    },
  };
}

/** @param {string} conversationId @param {Record<string, unknown>} [overrides] */
function pendingInput(conversationId, overrides = {}) {
  return {
    conversationId,
    correlationId: `correlation-${randomUUID()}`,
    createdBy: null,
    createdByKind: /** @type {const} */ ('automation'),
    fabCode: '01',
    ficha: draftFicha(),
    firstContactAt: FIRST_CONTACT_AT,
    id: randomUUID(),
    missingFields: ['finalAmount', 'paymentCondition'],
    now: nextNow(),
    totalPieces: 5,
    ...overrides,
  };
}

/** @param {any} repository @param {any} order */
async function confirm(repository, order) {
  const now = nextNow();
  return repository.saveStatus(
    confirmOrder(
      { ...order, ficha: fixturePricing(order.ficha, 150000) },
      {
        actorId: 'seller-contract',
        amountCents: 150000,
        now,
        paymentCondition: 'pix',
      },
    ),
    {
      actor: CONTRACT_ACTOR,
      correlationId: `correlation-${randomUUID()}`,
      expectedVersion: order.version,
    },
  );
}

/**
 * The persistence contract every OrderRepository must honour. T13 runs the
 * same suite against PostgreSQL.
 *
 * @param {string} name
 * @param {() => Promise<OrderRepositoryHarness>} setup
 */
export function defineOrderRepositoryContract(name, setup) {
  describe(`OrderRepository contract: ${name}`, () => {
    /** @type {OrderRepositoryHarness} */
    let harness;
    before(async () => {
      harness = await setup();
    });
    after(async () => {
      await harness?.close?.();
    });

    test('implements the port', () => {
      assert.doesNotThrow(() =>
        assertOrderRepositoryContract(harness.repository),
      );
    });

    test('creates a pending order with a reserved NN-CRM number and version 1', async () => {
      const { repository } = harness;
      const conversationId = await harness.newConversationId();
      const input = pendingInput(conversationId);
      const created = await repository.createPending(input);

      assert.equal(created.id, input.id);
      assert.equal(created.status, 'pendente');
      assert.equal(created.version, 1);
      assert.equal(created.conversationId, conversationId);
      assert.equal(created.fabCode, '01');
      assert.ok(Number.isSafeInteger(created.numberSequence));
      assert.equal(
        created.number,
        `${String(created.numberSequence).padStart(2, '0')}-CRM`,
      );
      assert.deepEqual(created.ficha, input.ficha);
      assert.equal(created.totalPieces, 5);
      assert.deepEqual(created.missingFields, [
        'finalAmount',
        'paymentCondition',
      ]);
      assert.equal(created.createdByKind, 'automation');
      assert.equal(created.createdAt, input.now.toISOString());
      assert.equal(created.updatedAt, input.now.toISOString());
      assert.equal(created.firstContactAt, FIRST_CONTACT_AT);
      for (const key of [
        'finalAmountCents',
        'paymentCondition',
        'paidOn',
        'deliveredOn',
        'orderDate',
        'confirmedAt',
        'confirmedBy',
        'reopenedAt',
        'reopenedBy',
        'createdBy',
      ]) {
        assert.equal(created[key], null, `${key} starts empty`);
      }

      assert.deepEqual(await repository.findById(created.id), created);
      assert.equal(await repository.findById(randomUUID()), null);

      const next = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      assert.ok(next.numberSequence > created.numberSequence);
    });

    test('refuses a second pending order in the same conversation', async () => {
      const { repository } = harness;
      const conversationId = await harness.newConversationId();
      const first = await repository.createPending(
        pendingInput(conversationId),
      );

      await assert.rejects(
        repository.createPending(pendingInput(conversationId)),
        { code: 'ORDER_PENDING_EXISTS', statusCode: 409 },
      );
      assert.deepEqual(
        await repository.findPendingByConversation(conversationId),
        first,
      );

      const results = await Promise.allSettled([
        repository.createPending(
          pendingInput(await harness.newConversationId()),
        ),
        repository.createPending(pendingInput(conversationId)),
      ]);
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
    });

    test('allows a new pending order once the previous one is confirmed', async () => {
      const { repository } = harness;
      const conversationId = await harness.newConversationId();
      const first = await repository.createPending(
        pendingInput(conversationId),
      );
      const confirmed = await confirm(repository, first);
      assert.equal(confirmed.status, 'confirmado');
      assert.equal(confirmed.version, 2);
      assert.equal(
        await repository.findPendingByConversation(conversationId),
        null,
      );

      const second = await repository.createPending(
        pendingInput(conversationId),
      );
      assert.equal(second.status, 'pendente');
      assert.deepEqual(
        (await repository.listByConversation(conversationId)).map(
          (/** @type {any} */ order) => order.id,
        ),
        [second.id, first.id],
      );
      assert.deepEqual(
        await repository.listByConversation(await harness.newConversationId()),
        [],
      );
    });

    test('saves a section only over the current version of a pending order', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      const ficha = draftFicha();
      ficha.observations = ['Separar por tamanho'];
      ficha.items[0].grade.push({ quantidade: 7, tamanho: 'G' });
      const now = nextNow();
      const saved = await repository.saveSection(
        {
          ...created,
          ficha,
          missingFields: ['finalAmount'],
          totalPieces: 12,
          updatedAt: now.toISOString(),
        },
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-section',
          expectedVersion: 1,
        },
      );
      assert.equal(saved.version, 2);
      assert.deepEqual(saved.ficha, ficha);
      assert.equal(saved.totalPieces, 12);
      assert.deepEqual(saved.missingFields, ['finalAmount']);
      assert.equal(saved.updatedAt, now.toISOString());
      assert.deepEqual(await repository.findById(created.id), saved);

      await assert.rejects(
        repository.saveSection(
          { ...saved, totalPieces: 1 },
          {
            actor: CONTRACT_ACTOR,
            correlationId: 'correlation-stale',
            expectedVersion: 1,
          },
        ),
        { code: 'VERSION_CONFLICT', statusCode: 409 },
      );
      await assert.rejects(
        repository.saveSection(
          { ...saved, id: randomUUID() },
          {
            actor: CONTRACT_ACTOR,
            correlationId: 'correlation-missing',
            expectedVersion: 2,
          },
        ),
        { code: 'ORDER_NOT_FOUND', statusCode: 404 },
      );
      assert.equal((await repository.findById(created.id)).totalPieces, 12);
    });

    test('never writes a section or a projection into a confirmed order', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      const confirmed = await confirm(repository, created);

      await assert.rejects(
        repository.saveSection(
          { ...confirmed, totalPieces: 99 },
          {
            actor: CONTRACT_ACTOR,
            correlationId: 'correlation-closed',
            expectedVersion: 2,
          },
        ),
        { code: 'ORDER_STATUS_CONFLICT', statusCode: 409 },
      );
      await assert.rejects(
        repository.projectBriefing(
          { ...confirmed, totalPieces: 99 },
          { correlationId: 'correlation-closed', expectedVersion: 2 },
        ),
        { code: 'ORDER_STATUS_CONFLICT', statusCode: 409 },
      );
      const stored = await repository.findById(created.id);
      assert.equal(stored.totalPieces, 5);
      assert.equal(stored.version, 2);
    });

    test('a projection cannot change status, amount or condition', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      const ficha = draftFicha();
      ficha.summary.nome = 'Evento Projetado';
      const projected = await repository.projectBriefing(
        /** @type {any} */ ({
          ...created,
          ficha,
          finalAmountCents: 1,
          paymentCondition: 'pix',
          status: 'confirmado',
        }),
        { correlationId: 'correlation-projection', expectedVersion: 1 },
      );
      assert.equal(projected.version, 2);
      assert.equal(projected.status, 'pendente');
      assert.equal(projected.finalAmountCents, null);
      assert.equal(projected.paymentCondition, null);
      assert.equal(projected.ficha.summary.nome, 'Evento Projetado');
    });

    test('confirms and reopens keeping number, amount and condition', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      const confirmed = await confirm(repository, created);
      assert.equal(confirmed.finalAmountCents, 150000);
      assert.equal(confirmed.paymentCondition, 'pix');
      assert.equal(confirmed.confirmedBy, 'seller-contract');
      assert.match(confirmed.orderDate, /^\d{4}-\d{2}-\d{2}$/u);
      assert.deepEqual(await repository.findById(created.id), confirmed);

      const reopened = await repository.saveStatus(
        reopenOrder(confirmed, { actorId: 'admin-contract', now: nextNow() }),
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-reopen',
          expectedVersion: 2,
        },
      );
      assert.equal(reopened.status, 'pendente');
      assert.equal(reopened.version, 3);
      assert.equal(reopened.number, created.number);
      assert.equal(reopened.finalAmountCents, 150000);
      assert.equal(reopened.reopenedBy, 'admin-contract');
      assert.deepEqual(await repository.findById(created.id), reopened);
    });

    test('generating writes down the client the order showed, and reopening keeps it (PCT-02)', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      // The service hands in the order with the client it reads now (ADR 018).
      const shown = structuredClone(created);
      shown.ficha.summary.cliente = 'Cliente Renomeado';
      const confirmed = await confirm(repository, shown);
      assert.equal(confirmed.ficha.summary.cliente, 'Cliente Renomeado');
      assert.deepEqual(confirmed.ficha.items, created.ficha.items);
      assert.deepEqual(
        (await repository.findById(created.id))?.ficha,
        confirmed.ficha,
      );

      const reopened = await repository.saveStatus(
        reopenOrder(confirmed, { actorId: 'admin-contract', now: nextNow() }),
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-reopen',
          expectedVersion: 2,
        },
      );
      assert.deepEqual(reopened.ficha, confirmed.ficha);
    });

    test('records the paid and delivered days in either status, touching nothing else', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      const paid = await repository.saveMilestones(
        recordMilestones(created, {
          deliveredOn: null,
          now: nextNow(),
          paidOn: '2026-09-10',
        }),
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-milestones',
          expectedVersion: 1,
        },
      );
      assert.equal(paid.version, 2);
      assert.equal(paid.paidOn, '2026-09-10');
      assert.equal(paid.deliveredOn, null);
      assert.equal(paid.status, 'pendente');
      assert.deepEqual(paid.ficha, created.ficha);

      const confirmed = await confirm(repository, paid);
      const delivered = await repository.saveMilestones(
        recordMilestones(confirmed, {
          deliveredOn: '2026-09-12',
          now: nextNow(),
          paidOn: '2026-09-10',
        }),
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-milestones',
          expectedVersion: 3,
        },
      );
      assert.equal(delivered.version, 4);
      assert.equal(delivered.deliveredOn, '2026-09-12');
      assert.equal(delivered.status, 'confirmado');
      assert.equal(delivered.orderDate, confirmed.orderDate);
      assert.equal(delivered.confirmedAt, confirmed.confirmedAt);
      assert.equal(delivered.firstContactAt, FIRST_CONTACT_AT);
      assert.deepEqual(await repository.findById(created.id), delivered);

      await assert.rejects(
        repository.saveMilestones(
          { ...delivered, paidOn: null },
          {
            actor: CONTRACT_ACTOR,
            correlationId: 'correlation-milestones',
            expectedVersion: 3,
          },
        ),
        { code: 'VERSION_CONFLICT' },
      );
    });

    test('concurrent confirmations over the same version: one wins, one conflicts', async () => {
      const { repository } = harness;
      const created = await repository.createPending(
        pendingInput(await harness.newConversationId()),
      );
      const results = await Promise.allSettled([
        confirm(repository, created),
        confirm(repository, created),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [
        'fulfilled',
        'rejected',
      ]);
      const rejected = /** @type {PromiseRejectedResult} */ (
        results.find((result) => result.status === 'rejected')
      );
      assert.equal(rejected.reason.code, 'VERSION_CONFLICT');
      assert.equal((await repository.findById(created.id)).version, 2);
    });

    test('lists by status, number or conversations with cursor pages and counts', async () => {
      const { repository } = harness;
      const conversationIds = [];
      /** @type {any[]} */
      const orders = [];
      for (let index = 0; index < 5; index += 1) {
        const conversationId = await harness.newConversationId();
        conversationIds.push(conversationId);
        orders.push(
          await repository.createPending(pendingInput(conversationId)),
        );
      }
      orders[1] = await confirm(repository, orders[1]);
      orders[3] = await confirm(repository, orders[3]);

      const all = await repository.list({ conversationIds, limit: 10 });
      assert.deepEqual(
        all.items.map((/** @type {any} */ order) => order.id),
        [orders[3].id, orders[1].id, orders[4].id, orders[2].id, orders[0].id],
        'most recently updated first',
      );
      assert.equal(all.nextCursor, null);
      assert.deepEqual(all.counts, { confirmado: 2, pendente: 3 });
      assert.deepEqual(all.items[0], orders[3]);

      const pending = await repository.list({
        conversationIds,
        limit: 10,
        status: 'pendente',
      });
      assert.deepEqual(
        pending.items.map((/** @type {any} */ order) => order.id),
        [orders[4].id, orders[2].id, orders[0].id],
      );
      assert.deepEqual(pending.counts, { confirmado: 2, pendente: 3 });

      const firstPage = await repository.list({ conversationIds, limit: 2 });
      assert.equal(firstPage.items.length, 2);
      assert.equal(typeof firstPage.nextCursor, 'string');
      const secondPage = await repository.list({
        conversationIds,
        cursor: firstPage.nextCursor,
        limit: 2,
      });
      const thirdPage = await repository.list({
        conversationIds,
        cursor: secondPage.nextCursor,
        limit: 2,
      });
      assert.equal(thirdPage.nextCursor, null);
      assert.deepEqual(
        [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
          (/** @type {any} */ order) => order.id,
        ),
        all.items.map((/** @type {any} */ order) => order.id),
      );

      const byNumber = await repository.list({
        limit: 10,
        numberSequence: orders[2].numberSequence,
      });
      assert.deepEqual(
        byNumber.items.map((/** @type {any} */ order) => order.id),
        [orders[2].id],
      );
      assert.deepEqual(byNumber.counts, { confirmado: 0, pendente: 1 });

      const numberOrConversation = await repository.list({
        conversationIds: [conversationIds[0]],
        limit: 10,
        numberSequence: orders[1].numberSequence,
      });
      assert.deepEqual(
        numberOrConversation.items.map((/** @type {any} */ order) => order.id),
        [orders[1].id, orders[0].id],
      );

      const nothing = await repository.list({ conversationIds: [], limit: 10 });
      assert.deepEqual(nothing, {
        counts: { confirmado: 0, pendente: 0 },
        items: [],
        nextCursor: null,
      });

      await assert.rejects(
        repository.list({ conversationIds, cursor: 'not-a-cursor', limit: 2 }),
        { code: 'ORDER_INVALID' },
      );
      await assert.rejects(repository.list({ conversationIds, limit: 0 }), {
        code: 'ORDER_INVALID',
      });
    });

    test('appends an identifier-only order event for every write', async () => {
      const { repository } = harness;
      const conversationId = await harness.newConversationId();
      const created = await repository.createPending(
        pendingInput(conversationId),
      );
      const sectioned = await repository.saveSection(
        { ...created, totalPieces: 6 },
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-events',
          expectedVersion: 1,
        },
      );
      const projected = await repository.projectBriefing(
        { ...sectioned, totalPieces: 7 },
        { correlationId: 'correlation-events', expectedVersion: 2 },
      );
      const confirmed = await confirm(repository, projected);
      const reopened = await repository.saveStatus(
        reopenOrder(confirmed, { actorId: 'admin-contract', now: nextNow() }),
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-events',
          expectedVersion: 4,
        },
      );
      await repository.saveMilestones(
        { ...reopened, paidOn: '2026-09-10' },
        {
          actor: CONTRACT_ACTOR,
          correlationId: 'correlation-events',
          expectedVersion: 5,
        },
      );
      await assert.rejects(
        repository.saveSection(
          { ...created, totalPieces: 8 },
          {
            actor: CONTRACT_ACTOR,
            correlationId: 'correlation-events',
            expectedVersion: 1,
          },
        ),
        { code: 'VERSION_CONFLICT' },
      );

      const events = await harness.readEvents(created.id);
      assert.deepEqual(
        events.map((event) => [event.eventType, event.aggregateVersion]),
        [
          ['order.created', 1],
          ['order.section_saved', 2],
          ['order.briefing_projected', 3],
          ['order.confirmed', 4],
          ['order.reopened', 5],
          ['order.milestones_saved', 6],
        ],
      );
      for (const event of events) {
        assert.deepEqual(event.payload, {
          conversationId,
          orderId: created.id,
        });
      }
    });
  });
}

if (import.meta.main) {
  defineOrderRepositoryContract('in-memory', async () => {
    const repository = new InMemoryOrderRepository();
    return {
      newConversationId: async () => `conversation-${randomUUID()}`,
      readEvents: async (orderId) => repository.eventsFor(orderId),
      repository,
    };
  });
}
