import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { PostgresAuditTrail } from '../modules/audit-privacy/src/index.js';
import { PostgresIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import {
  PostgresContactIdentityRepository,
  createContactIdentityService,
} from '../modules/contacts/src/index.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  PostgresInboxRepository,
  createInboxService,
} from '../modules/inbox-channels/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { InMemoryObjectStorage } from '../modules/orders/src/adapters/in-memory-order-files.js';
import { PostgresOrderFileRepository } from '../modules/orders/src/adapters/postgres-order-file-repository.js';
import { S3ObjectStorage } from '../modules/orders/src/adapters/s3-object-storage.js';
import { createOrderFileService } from '../modules/orders/src/application/order-file-service.js';
import { PostgresOrderConversationPort } from '../modules/orders/src/adapters/postgres-order-conversation-port.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { defineOrderRepositoryContract } from './orders-repository-contract.test.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';
import { syntheticItems } from './fixtures/order-items.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-09-12T12:00:00.000Z');
const ENVELOPE_KEY = Buffer.alloc(32, 61);
const CONTACT_KEY = Buffer.alloc(32, 65);

/** @param {Pool} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}

/** @param {Pool} pool */
function channelServices(pool) {
  const database = databaseFor(pool);
  const auditPort = { append: async () => undefined };
  return {
    contacts: createContactIdentityService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresContactIdentityRepository({
        database,
        envelopeKey: CONTACT_KEY,
        lookupKey: Buffer.alloc(32, 63),
      }),
    }),
    inbox: createInboxService({
      auditPort,
      clock: () => NOW,
      repository: new PostgresInboxRepository({
        database,
        envelopeKey: Buffer.alloc(32, 64),
        outboundMessageOutbox: { enqueueChannelMessage: async () => undefined },
      }),
    }),
  };
}

/**
 * Creates a conversation through the channel services, so its identity
 * envelope is real and the order search can decrypt it.
 *
 * @param {Pool} pool
 * @param {{channel?: 'instagram'|'whatsapp', externalIdentityId?: string}} [options]
 */
async function seedConversation(pool, options = {}) {
  const runId = randomUUID().replaceAll('-', '');
  const whatsapp = options.channel === 'whatsapp';
  const { contacts, inbox } = channelServices(pool);
  const resolved = await contacts.resolveInboundIdentity({
    channel: whatsapp ? 'whatsapp' : 'instagram',
    correlationId: `correlation-identity-${runId}`,
    displayHandle: whatsapp ? null : `@orders_${runId.slice(0, 8)}`,
    externalIdentityId: options.externalIdentityId ?? `identity-${runId}`,
    identityKind: whatsapp ? 'phone' : 'handle',
    occurredAt: NOW.toISOString(),
    phoneStatus: whatsapp ? 'confirmed' : 'pending',
    provider: 'meta',
    providerAccountId: `account-orders-${runId}`,
  });
  // Order creation now requires a callable phone. The order suite uses a
  // synthetic manual alias when it seeds a non-WhatsApp channel.
  await pool.query(
    `INSERT INTO crm.contact_phone_lookup
       (contact_id, identity_id, phone_hash, source)
     VALUES ($1, $2, $3, $4)`,
    [
      resolved.contact.id,
      whatsapp ? resolved.identity.id : null,
      runId.padEnd(64, '0'),
      whatsapp ? 'whatsapp' : 'manual',
    ],
  );
  const { conversation } = await inbox.receiveInbound({
    contactId: resolved.contact.id,
    correlationId: `correlation-message-${runId}`,
    externalConversationId: `conversation-${runId}`,
    externalMessageId: `message-${runId}`,
    identityId: resolved.identity.id,
    message: { content: { text: 'Quero orçamento' }, type: 'text' },
    occurredAt: NOW.toISOString(),
    provider: 'meta',
    providerAccountId: `account-orders-${runId}`,
  });
  return /** @type {string} */ (conversation.id);
}

if (connectionString) {
  const databaseName = new URL(connectionString).pathname.slice(1);
  // A branch may run its own copy (crm_silmer_test_<branch>) next to others.
  assert.match(
    databaseName,
    /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    'orders live test only resets a dedicated crm_silmer_test database',
  );
  const pool = new Pool({ connectionString, max: 6 });
  const repository = new PostgresOrderRepository({
    database: databaseFor(pool),
    envelopeKey: ENVELOPE_KEY,
  });

  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name)
       VALUES ('seller-contract', 'seller-contract@example.test',
               '$argon2id$synthetic', 'Vendedor Contrato')`,
    );
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });

  defineOrderRepositoryContract('PostgreSQL', async () => ({
    newConversationId: async () => {
      const id = await seedConversation(pool);
      await pool.query(
        `UPDATE crm.conversations SET assigned_user_id = 'seller-contract'
         WHERE id = $1`,
        [id],
      );
      return id;
    },
    readEvents: async (orderId) =>
      (
        await pool.query(
          `SELECT event_type, aggregate_version, payload
           FROM crm.domain_events
           WHERE aggregate_type = 'order' AND aggregate_id = $1
           ORDER BY stream_cursor`,
          [orderId],
        )
      ).rows.map((row) => ({
        aggregateVersion: Number(row.aggregate_version),
        eventType: row.event_type,
        payload: row.payload,
      })),
    repository,
  }));

  test('keeps every personal ficha field inside the encrypted envelope', async () => {
    const canary = `PII-canary-${randomUUID()}`;
    const conversationId = await seedConversation(pool);
    const service = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: {
        readOrderContexts: orderContextsFrom(() => ({
          briefing: {
            city_or_postal_code: `${canary}-cidade`,
            delivery_address: `${canary}-endereco`,
            order_name: `${canary}-evento`,
            product_type: 'camisa',
          },
          customerName: `${canary}-cliente`,
        })),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository,
    });
    const { order } = await service.ensurePendingFromIntent({
      conversationId,
      correlationId: 'correlation-pii',
    });
    assert.equal(order.ficha.summary.cliente, `${canary}-cliente`);
    assert.equal(
      order.ficha.serviceData.delivery_address,
      `${canary}-endereco`,
    );

    const raw = await pool.query(
      `SELECT to_jsonb(orders.*)::text AS row FROM crm.orders WHERE id = $1`,
      [order.id],
    );
    assert.doesNotMatch(raw.rows[0].row, new RegExp(canary, 'u'));
    const envelope = (
      await pool.query('SELECT ficha_envelope FROM crm.orders WHERE id = $1', [
        order.id,
      ])
    ).rows[0].ficha_envelope;
    assert.deepEqual(Object.keys(envelope).sort(), [
      'algorithm',
      'ciphertext',
      'iv',
      'keyVersion',
      'tag',
      'version',
    ]);
    const events = await pool.query(
      `SELECT payload::text AS payload FROM crm.domain_events
       WHERE aggregate_type = 'order' AND aggregate_id = $1`,
      [order.id],
    );
    assert.equal(events.rows.length, 1);
    assert.doesNotMatch(events.rows[0].payload, new RegExp(canary, 'u'));

    // The envelope is bound to its row: another key cannot read it.
    const otherKey = new PostgresOrderRepository({
      database: databaseFor(pool),
      envelopeKey: Buffer.alloc(32, 62),
    });
    await assert.rejects(otherKey.findById(order.id));
  });

  test('refuses an order for a conversation that does not exist', async () => {
    await assert.rejects(
      repository.createPending({
        conversationId: `conversation-missing-${randomUUID()}`,
        correlationId: 'correlation-missing',
        createdBy: null,
        createdByKind: 'automation',
        fabCode: '01',
        ficha: {
          items: [],
          observations: [],
          serviceData: {},
          summary: {
            aplicacao: null,
            cliente: '',
            data_entrega_confirmada: null,
            nome: null,
          },
        },
        firstContactAt: null,
        id: randomUUID(),
        missingFields: ['items'],
        now: NOW,
        totalPieces: 0,
      }),
      { code: 'CONVERSATION_NOT_FOUND', statusCode: 404 },
    );
  });

  test('reads owner, customer, pre-ficha and search matches from the conversation', async () => {
    const runId = randomUUID().replaceAll('-', '');
    const database = databaseFor(pool);
    const phone = `55119${runId.replace(/\D/gu, '').padEnd(8, '7').slice(0, 8)}`;
    const conversation = {
      id: await seedConversation(pool, {
        channel: 'whatsapp',
        externalIdentityId: phone,
      }),
    };
    const sellerId = `seller-port-${runId}`;
    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name)
       VALUES ($1, $2, '$argon2id$synthetic', 'Vendedora Sintetica')`,
      [sellerId, `${sellerId}@example.test`],
    );
    await pool.query(
      `INSERT INTO crm.user_functions (user_id, function_name)
       VALUES ($1, 'Vendedor')`,
      [sellerId],
    );
    await pool.query(
      `UPDATE crm.contacts contact SET display_name = 'Conceição Sintética'
       FROM crm.conversations conversation
       JOIN crm.contact_identities identity
         ON identity.id = conversation.contact_identity_id
       WHERE conversation.id = $1 AND contact.id = identity.current_contact_id`,
      [conversation.id],
    );
    await pool.query(
      `UPDATE crm.conversations
       SET assigned_user_id = $2, briefing_version = 3,
           briefing_envelope = $3::jsonb, briefing_updated_at = $4
       WHERE id = $1`,
      [
        conversation.id,
        sellerId,
        JSON.stringify(
          encryptJson(
            { order_name: 'Equipe Sintetica', product_type: 'camisa' },
            `n8n-briefing:${conversation.id}:3`,
            ENVELOPE_KEY,
          ),
        ),
        NOW,
      ],
    );
    const port = new PostgresOrderConversationPort({
      contactEnvelopeKey: CONTACT_KEY,
      contactLookupKey: Buffer.alloc(32, 66),
      database,
      envelopeKey: ENVELOPE_KEY,
    });

    const { version: conversationVersion } = (
      await pool.query('SELECT version FROM crm.conversations WHERE id = $1', [
        conversation.id,
      ])
    ).rows[0];
    assert.deepEqual(await port.readAssignment(conversation.id), {
      assignedUserId: sellerId,
      version: Number(conversationVersion),
    });
    assert.equal(await port.readAssignment(`missing-${runId}`), null);
    assert.deepEqual(
      await port.readAssignments([conversation.id, `missing-${runId}`]),
      new Map([[conversation.id, sellerId]]),
    );
    assert.deepEqual(await port.readAssignments([]), new Map());
    assert.deepEqual(
      await port.readUserNames([sellerId, `missing-${runId}`]),
      new Map([[sellerId, 'Vendedora Sintetica']]),
    );
    assert.deepEqual(await port.readUserNames([]), new Map());
    assert.deepEqual(
      await port.readOrderContexts([conversation.id, `missing-${runId}`]),
      new Map([
        [
          conversation.id,
          {
            briefing: {
              order_name: 'Equipe Sintetica',
              product_type: 'camisa',
            },
            customerName: 'Conceição Sintética',
            openedAt: NOW.toISOString(),
          },
        ],
      ]),
    );
    assert.deepEqual(await port.readOrderContexts([]), new Map());

    // Search only looks at conversations that already have orders.
    assert.deepEqual(await port.searchConversationIds('conceicao'), []);
    const service = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: port,
      fabCode: '01',
      repository,
    });
    const { order } = await service.ensurePendingFromIntent({
      conversationId: conversation.id,
      correlationId: `correlation-port-${runId}`,
    });
    // PLA-02: the order keeps the day its conversation opened.
    assert.equal(order.firstContactAt, NOW.toISOString());
    assert.deepEqual(await port.searchConversationIds('CONCEICAO sint'), [
      conversation.id,
    ]);
    assert.deepEqual(
      await port.searchConversationIds(
        `(${phone.slice(2, 4)}) ${phone.slice(4, 9)}`,
      ),
      [conversation.id],
    );
    assert.deepEqual(await port.searchConversationIds('ninguem'), []);
    // Fewer than four digits never match a phone; "#" never appears in a
    // seeded name or handle, so this checks only the digit rule.
    assert.deepEqual(await port.searchConversationIds('#12'), []);
  });

  test('names the customer only from a confirmed name, never the channel handle (ADR 016)', async () => {
    const database = databaseFor(pool);
    const port = new PostgresOrderConversationPort({
      contactEnvelopeKey: CONTACT_KEY,
      contactLookupKey: Buffer.alloc(32, 66),
      database,
      envelopeKey: ENVELOPE_KEY,
    });
    const service = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: port,
      fabCode: '01',
      repository,
    });
    /** @param {string} conversationId @param {Record<string, unknown>} briefing */
    const writeBriefing = (conversationId, briefing) =>
      pool.query(
        `UPDATE crm.conversations
         SET briefing_version = 2, briefing_envelope = $2::jsonb,
             briefing_updated_at = $3
         WHERE id = $1`,
        [
          conversationId,
          JSON.stringify(
            encryptJson(
              briefing,
              `n8n-briefing:${conversationId}:2`,
              ENVELOPE_KEY,
            ),
          ),
          NOW,
        ],
      );
    /** @param {string} conversationId @param {string} name @param {string} source */
    const nameContact = (conversationId, name, source) =>
      pool.query(
        `UPDATE crm.contacts contact
         SET display_name = $2, display_name_source = $3
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity
           ON identity.id = conversation.contact_identity_id
         WHERE conversation.id = $1 AND contact.id = identity.current_contact_id`,
        [conversationId, name, source],
      );

    // An Instagram contact with no name: the "@handle" is not a name.
    const unnamed = await seedConversation(pool);
    assert.equal(
      (await port.readOrderContexts([unnamed])).get(unnamed)?.customerName,
      null,
    );
    const blank = await service.ensurePendingFromIntent({
      conversationId: unnamed,
      correlationId: 'correlation-unnamed',
    });
    assert.equal(blank.order.ficha.summary.cliente, '');

    // Without a confirmed contact name, the name the customer gave the bot.
    const told = await seedConversation(pool, { channel: 'whatsapp' });
    await writeBriefing(told, { customer_name: 'Nome Dito Ao Bot' });
    const fromBriefing = await service.ensurePendingFromIntent({
      conversationId: told,
      correlationId: 'correlation-told',
    });
    assert.equal(fromBriefing.order.ficha.summary.cliente, 'Nome Dito Ao Bot');

    // A name promoted from the bot, or typed by a person, wins.
    const promoted = await seedConversation(pool);
    await nameContact(promoted, 'Nome Promovido', 'automation');
    await writeBriefing(promoted, { customer_name: 'Outro Nome' });
    assert.equal(
      (await port.readOrderContexts([promoted])).get(promoted)?.customerName,
      'Nome Promovido',
    );
    const renamed = await seedConversation(pool, { channel: 'whatsapp' });
    await nameContact(renamed, 'Nome Do Vendedor', 'manual');
    const byPerson = await service.ensurePendingFromIntent({
      conversationId: renamed,
      correlationId: 'correlation-renamed',
    });
    assert.equal(byPerson.order.ficha.summary.cliente, 'Nome Do Vendedor');
  });

  test('the client follows the renamed contact while pending and stays on the generated order (ADR 018)', async () => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 8);
    const port = new PostgresOrderConversationPort({
      contactEnvelopeKey: CONTACT_KEY,
      contactLookupKey: Buffer.alloc(32, 66),
      database: databaseFor(pool),
      envelopeKey: ENVELOPE_KEY,
    });
    const service = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: port,
      fabCode: '01',
      repository,
    });
    const actor = { capabilities: [], id: `seller-${tag}`, kind: 'human' };
    // An Instagram contact: its "@handle" must never become the client.
    const conversationId = await seedConversation(pool);
    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name)
       VALUES ($1, $2, '$argon2id$synthetic', 'Vendedor Nome')`,
      [actor.id, `${actor.id}@example.test`],
    );
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id = $2 WHERE id = $1',
      [conversationId, actor.id],
    );
    await pool.query(
      `UPDATE crm.conversations
       SET briefing_version = 1, briefing_envelope = $2::jsonb,
           briefing_updated_at = $3
       WHERE id = $1`,
      [
        conversationId,
        JSON.stringify(
          encryptJson(
            { customer_name: 'Nome Dito Ao Bot', product_type: 'camisa' },
            `n8n-briefing:${conversationId}:1`,
            ENVELOPE_KEY,
          ),
        ),
        NOW,
      ],
    );
    /** @param {string|null} name @param {'automation'|'manual'} source */
    const nameContact = (name, source) =>
      pool.query(
        `UPDATE crm.contacts contact
         SET display_name = $2, display_name_source = $3,
             version = contact.version + 1
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity
           ON identity.id = conversation.contact_identity_id
         WHERE conversation.id = $1 AND contact.id = identity.current_contact_id`,
        [conversationId, name, source],
      );
    /** @param {string} orderId */
    const shown = async (orderId) => {
      const listed = (await service.list({})).items.find(
        (/** @type {any} */ order) => order.id === orderId,
      );
      return {
        current: (await service.currentForConversation(conversationId))?.ficha
          .summary.cliente,
        detail: (await service.get(orderId)).ficha.summary.cliente,
        list: listed?.ficha.summary.cliente,
      };
    };
    /** @param {string} cliente */
    const everywhere = (cliente) => ({
      current: cliente,
      detail: cliente,
      list: cliente,
    });
    /** @param {string} orderId */
    const orderEvents = async (orderId) =>
      (
        await pool.query(
          `SELECT event_type FROM crm.domain_events
           WHERE aggregate_type = 'order' AND aggregate_id = $1
           ORDER BY stream_cursor`,
          [orderId],
        )
      ).rows.map((row) => row.event_type);

    const { order: created } = await service.ensurePendingFromIntent({
      conversationId,
      correlationId: `correlation-follow-${tag}`,
    });
    assert.equal(created.ficha.summary.cliente, 'Nome Dito Ao Bot');

    // PCT-01: the name the bot promoted, then the one a person typed, reach
    // the pending order on every read, and the search finds it by the new
    // name; the order itself does not change.
    await nameContact(`Cliente Promovida ${tag}`, 'automation');
    assert.deepEqual(
      await shown(created.id),
      everywhere(`Cliente Promovida ${tag}`),
    );
    await nameContact(`Cliente Renomeada ${tag}`, 'manual');
    assert.deepEqual(
      await shown(created.id),
      everywhere(`Cliente Renomeada ${tag}`),
    );
    const found = await service.list({ q: `renomeada ${tag}` });
    assert.deepEqual(
      found.items.map((/** @type {any} */ order) => [
        order.id,
        order.ficha.summary.cliente,
      ]),
      [[created.id, `Cliente Renomeada ${tag}`]],
    );
    const untouched = await repository.findById(created.id);
    assert.equal(untouched?.version, created.version);
    assert.equal(untouched?.updatedAt, created.updatedAt);
    assert.deepEqual(await orderEvents(created.id), ['order.created']);

    // A name cleared by a person falls back to the bot's, never the handle.
    await nameContact(null, 'manual');
    assert.deepEqual(await shown(created.id), everywhere('Nome Dito Ao Bot'));

    // PCT-02: generating writes down the name the order showed then.
    await nameContact(`Cliente Renomeada ${tag}`, 'manual');
    const promised = await service.patchSection({
      actor,
      correlationId: `correlation-follow-summary-${tag}`,
      expectedVersion: created.version,
      orderId: created.id,
      section: 'summary',
      value: {
        aplicacao: null,
        data_entrega_confirmada: '2026-10-24',
        nome: null,
      },
    });
    const ready = await service.patchSection({
      actor,
      correlationId: `correlation-follow-items-${tag}`,
      expectedVersion: promised.version,
      orderId: created.id,
      section: 'items',
      value: [
        {
          cor: 'AZUL',
          cor_costas: '',
          cor_frente: '',
          cor_manga_direita: '',
          cor_manga_esquerda: '',
          estampa: '',
          gola: 'GOLA REDONDA',
          grade: [{ quantidade: 3, tamanho: 'M' }],
          malhas: ['DRY FIT'],
          modelo: '',
          tipo: 'CAMISA',
          tipo_servico: 'Sem estampa',
          vies_gola: '',
          vies_mangas: '',
        },
      ],
    });
    const marked = await service.patchSection({
      actor,
      correlationId: `correlation-follow-artwork-${tag}`,
      expectedVersion: ready.version,
      orderId: created.id,
      section: 'artwork',
      value: {
        feito_pela_silmer: false,
        feito_pelo_cliente: false,
        sem_estampa: true,
      },
    });
    await nameContact(`Cliente Na Geracao ${tag}`, 'manual');
    const generated = await service.confirm({
      actor,
      amountText: '150,00',
      correlationId: `correlation-follow-confirm-${tag}`,
      expectedVersion: marked.version,
      orderId: created.id,
      paymentCondition: 'pix',
    });
    assert.equal(generated.ficha.summary.cliente, `Cliente Na Geracao ${tag}`);
    assert.equal(
      (await repository.findById(created.id))?.ficha.summary.cliente,
      `Cliente Na Geracao ${tag}`,
    );
    await nameContact(`Cliente Depois ${tag}`, 'manual');
    assert.deepEqual(
      await shown(created.id),
      everywhere(`Cliente Na Geracao ${tag}`),
    );

    // PCT-03: reopened, it follows the contact again.
    const reopened = await service.reopen({
      actor,
      correlationId: `correlation-follow-reopen-${tag}`,
      expectedVersion: generated.version,
      orderId: created.id,
    });
    assert.equal(reopened.ficha.summary.cliente, `Cliente Depois ${tag}`);
    assert.deepEqual(
      await shown(created.id),
      everywhere(`Cliente Depois ${tag}`),
    );
  });

  test('the orders runtime replays a command key and audits it once in PostgreSQL', async () => {
    const runId = randomUUID().replaceAll('-', '');
    const database = databaseFor(pool);
    const conversationId = await seedConversation(pool);
    const sellerId = `seller-runtime-${runId}`;
    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name)
       VALUES ($1, $2, '$argon2id$synthetic', 'Vendedor Runtime')`,
      [sellerId, `${sellerId}@example.test`],
    );
    await pool.query(
      `INSERT INTO crm.user_functions (user_id, function_name)
       VALUES ($1, 'Vendedor')`,
      [sellerId],
    );
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id = $2 WHERE id = $1',
      [conversationId, sellerId],
    );
    const conversationVersion = Number(
      (
        await pool.query(
          'SELECT version FROM crm.conversations WHERE id = $1',
          [conversationId],
        )
      ).rows[0].version,
    );
    const runtime = createOrderRuntime({
      access: {
        authorizeRead: async () => ({ actor: null }),
        authorizeWrite: async () => ({ actor: null }),
      },
      auditTrail: new PostgresAuditTrail(database),
      conversations: new PostgresOrderConversationPort({
        contactEnvelopeKey: CONTACT_KEY,
        contactLookupKey: Buffer.alloc(32, 66),
        database,
        envelopeKey: ENVELOPE_KEY,
      }),
      fabCode: '01',
      idempotencyStore: new PostgresIdempotencyRecordStore({
        database,
        envelopeKey: Buffer.alloc(32, 66),
      }),
      repository,
    });
    const actor = { capabilities: [], id: sellerId, kind: 'human' };

    const created = await runtime.createManual({
      actor,
      conversationId,
      correlationId: `correlation-create-${runId}`,
      expectedVersion: conversationVersion,
      idempotencyKey: `create-${runId}`,
    });
    assert.equal(created.created, true);
    assert.deepEqual(created.order.seller, {
      id: sellerId,
      name: 'Vendedor Runtime',
    });

    const patch = {
      actor,
      correlationId: `correlation-patch-${runId}`,
      expectedVersion: created.order.version,
      idempotencyKey: `patch-${runId}`,
      orderId: created.order.id,
      section: 'observations',
      value: ['Conferir arte'],
    };
    const [first, concurrent] = await Promise.all([
      runtime.patchSection(patch),
      runtime.patchSection({ ...patch }),
    ]);
    assert.deepEqual(concurrent, first);
    assert.equal(first.version, created.order.version + 1);
    const replay = await runtime.patchSection({ ...patch });
    assert.deepEqual(replay, first);
    await assert.rejects(runtime.patchSection({ ...patch, value: ['Outra'] }), {
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    });

    const stored = await pool.query(
      `SELECT status, response::text AS response FROM crm.idempotency_records
       WHERE idempotency_key = $1`,
      [`patch-${runId}`],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].status, 'completed');
    assert.doesNotMatch(stored.rows[0].response, /Conferir arte/u);
    const audits = await pool.query(
      `SELECT action FROM crm.audit_events
       WHERE target_id = $1 ORDER BY occurred_at`,
      [created.order.id],
    );
    assert.deepEqual(
      audits.rows.map((row) => row.action),
      ['order.edit'],
    );
    const events = await pool.query(
      `SELECT event_type FROM crm.domain_events
       WHERE aggregate_type = 'order' AND aggregate_id = $1
       ORDER BY stream_cursor`,
      [created.order.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      ['order.created', 'order.section_saved'],
    );

    // PCL-09: two confirmations race on one version in separate transactions.
    const promised = await runtime.patchSection({
      ...patch,
      expectedVersion: first.version,
      idempotencyKey: `summary-${runId}`,
      section: 'summary',
      value: {
        aplicacao: null,
        data_entrega_confirmada: '2026-10-24',
        nome: null,
      },
    });
    const withItems = await runtime.patchSection({
      ...patch,
      expectedVersion: promised.version,
      idempotencyKey: `items-${runId}`,
      section: 'items',
      value: [
        {
          cor: 'AZUL',
          cor_costas: 'AZUL',
          cor_frente: 'AZUL',
          cor_manga_direita: 'AZUL',
          cor_manga_esquerda: 'AZUL',
          estampa: 'Logo · frente',
          gola: 'GOLA V',
          grade: [{ quantidade: 3, tamanho: 'M' }],
          malhas: ['DRY FIT'],
          modelo: 'TRADICIONAL',
          tipo: 'CAMISA',
          tipo_servico: 'DTF',
          vies_gola: 'AZUL',
          vies_mangas: 'NAO APLICAVEL',
        },
      ],
    });
    const ready = await runtime.patchSection({
      ...patch,
      expectedVersion: withItems.version,
      idempotencyKey: `artwork-${runId}`,
      section: 'artwork',
      value: { feito_pela_silmer: false, feito_pelo_cliente: true },
    });
    const outcomes = await Promise.allSettled(
      ['one', 'two'].map((suffix) =>
        runtime.confirm({
          actor,
          amountText: '150,00',
          correlationId: `correlation-confirm-${runId}`,
          expectedVersion: ready.version,
          idempotencyKey: `confirm-${suffix}-${runId}`,
          orderId: ready.id,
          paymentCondition: 'pix',
        }),
      ),
    );
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
      'fulfilled',
      'rejected',
    ]);
    const lost = /** @type {PromiseRejectedResult} */ (
      outcomes.find((outcome) => outcome.status === 'rejected')
    );
    assert.equal(lost.reason.statusCode, 409);
    const confirmedRow = await pool.query(
      `SELECT status, final_amount_cents, version FROM crm.orders WHERE id = $1`,
      [ready.id],
    );
    assert.equal(confirmedRow.rows[0].status, 'confirmado');
    assert.equal(Number(confirmedRow.rows[0].version), ready.version + 1);
    const confirmAudits = await pool.query(
      `SELECT count(*)::integer AS total FROM crm.audit_events
       WHERE target_id = $1 AND action = 'order.confirm'`,
      [ready.id],
    );
    assert.equal(confirmAudits.rows[0].total, 1);
  });

  test('an order built on the seven points: from the briefing to generating it (ADR 016)', async () => {
    const runId = randomUUID().replaceAll('-', '');
    const conversationId = await seedConversation(pool);
    /** @type {Record<string, unknown>} */
    let briefing = {
      colors: 'preta',
      customer_name: 'Cliente Sete Pontos',
      product_model: 'camiseta comum',
      quantity: 30,
    };
    const service = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: {
        readOrderContexts: orderContextsFrom(() => ({
          briefing,
          customerName: null,
        })),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository,
    });
    const actor = { capabilities: [], id: `seller-${runId}`, kind: 'human' };
    await pool.query(
      `INSERT INTO crm.users (id, email, password_hash, name)
       VALUES ($1, $2, '$argon2id$synthetic', 'Vendedor Sete Pontos')`,
      [actor.id, `${actor.id}@example.test`],
    );
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id = $2 WHERE id = $1',
      [conversationId, actor.id],
    );

    // The bot opens the order on the first points it has.
    const { order: created } = await service.ensurePendingFromIntent({
      conversationId,
      correlationId: `correlation-intent-${runId}`,
    });
    assert.equal(created.ficha.summary.cliente, 'Cliente Sete Pontos');
    assert.equal(created.ficha.items[0].tipo, 'camiseta comum');
    assert.equal(created.ficha.items[0].cor, 'preta');
    assert.equal(created.ficha.serviceData.quantity, 30);
    assert.deepEqual(created.missingFields, [
      'items[0].tipo_servico',
      'items[0].malhas',
      'items[0].grade',
      'items[0].gola',
      'artwork',
      'summary.data_entrega_confirmada',
      'finalAmount',
      'paymentCondition',
    ]);

    // ...and projects the rest while it holds the conversation.
    briefing = {
      ...briefing,
      artwork_status: 'vai mandar a logo',
      artwork_technique: 'estampada',
      collar: 'Definir com o vendedor',
      fabrics: 'algodão',
      sizes: '10 P, 15 M e 5 G',
    };
    const projected = await service.projectAgentBriefing({
      automationState: 'assistant',
      briefing,
      conversationId,
      correlationId: `correlation-projection-${runId}`,
    });
    assert.equal(projected.applied, true);
    const order = /** @type {any} */ (projected.order);
    // ADR 020: who makes the art lands on the order; no place was said.
    assert.equal(order.ficha.items[0].estampa, '');
    assert.equal(order.ficha.artwork.feito_pelo_cliente, true);
    assert.deepEqual(order.ficha.items[0].malhas, ['algodão']);
    assert.equal(order.ficha.items[0].gola, '');
    assert.equal(order.ficha.summary.aplicacao, null);
    assert.equal(order.ficha.serviceData.artwork_technique, 'estampada');
    assert.equal(order.ficha.serviceData.collar, 'Definir com o vendedor');
    assert.equal(order.totalPieces, 30);
    assert.deepEqual(order.missingFields, [
      'items[0].tipo_servico',
      'items[0].gola',
      'summary.data_entrega_confirmada',
      'finalAmount',
      'paymentCondition',
    ]);
    const stored = await repository.findById(order.id);
    assert.deepEqual(stored?.missingFields, order.missingFields);

    // The seller saves a second item half filled.
    const [first] = order.ficha.items;
    const partial = await service.patchSection({
      actor,
      correlationId: `correlation-items-${runId}`,
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: [first, { ...first, cor: '', grade: [], tipo: 'regata' }],
    });
    assert.equal(partial.totalPieces, 30);

    /** @param {any} current @param {{amountText?: string, paymentCondition?: string}} body */
    const confirm = (current, body) =>
      service.confirm({
        actor,
        amountText: body.amountText,
        correlationId: `correlation-confirm-${runId}`,
        expectedVersion: current.version,
        orderId: current.id,
        paymentCondition: body.paymentCondition,
      });
    await assert.rejects(confirm(partial, {}), {
      code: 'ORDER_NOT_CONFIRMABLE',
      fields: [
        'items[0].tipo_servico',
        'items[0].gola',
        'items[1].cor',
        'items[1].tipo_servico',
        'items[1].grade',
        'items[1].gola',
        'summary.data_entrega_confirmada',
        'finalAmount',
        'paymentCondition',
      ],
    });

    const complete = await service.patchSection({
      actor,
      correlationId: `correlation-complete-${runId}`,
      expectedVersion: partial.version,
      orderId: order.id,
      section: 'items',
      value: [
        { ...first, gola: 'gola redonda', tipo_servico: 'Silk' },
        {
          ...first,
          cor: 'branca',
          gola: 'regata',
          grade: [{ quantidade: 4, tamanho: 'GG' }],
          tipo: 'regata',
          tipo_servico: 'DTF',
        },
      ],
    });
    assert.deepEqual(complete.missingFields, [
      'summary.data_entrega_confirmada',
      'finalAmount',
      'paymentCondition',
    ]);
    await assert.rejects(confirm(complete, { amountText: '980,00' }), {
      code: 'ORDER_NOT_CONFIRMABLE',
      fields: ['summary.data_entrega_confirmada', 'paymentCondition'],
    });

    // The promised delivery must be a real day, as the date picker stores it.
    /** @param {any} current @param {string} day */
    const promise = (current, day) =>
      service.patchSection({
        actor,
        correlationId: `correlation-promise-${runId}-${day}`,
        expectedVersion: current.version,
        orderId: current.id,
        section: 'summary',
        value: { aplicacao: null, data_entrega_confirmada: day, nome: null },
      });
    const typed = await promise(complete, '24/10/2026');
    await assert.rejects(
      confirm(typed, { amountText: '980,00', paymentCondition: 'pix' }),
      {
        code: 'ORDER_NOT_CONFIRMABLE',
        fields: ['summary.data_entrega_confirmada'],
      },
    );
    const ready = await promise(typed, '2026-10-24');
    assert.deepEqual(ready.missingFields, ['finalAmount', 'paymentCondition']);
    // Generating means the order is paid until the CRM handles payments: no
    // paid day is needed, and none is invented.
    assert.equal(ready.paidOn, null);
    const generated = await confirm(ready, {
      amountText: '980,00',
      paymentCondition: 'pix',
    });
    assert.equal(generated.status, 'confirmado');
    assert.equal(generated.totalPieces, 34);
    assert.equal(generated.paidOn, null);
    assert.equal(generated.deliveredOn, null);
    assert.deepEqual(generated.missingFields, []);
  });

  test('reads a ficha stored before ADR 016 with the new item fields blank', async () => {
    const conversationId = await seedConversation(pool);
    const legacy = await repository.createPending({
      conversationId,
      correlationId: 'correlation-legacy',
      createdBy: null,
      createdByKind: 'automation',
      fabCode: '01',
      ficha: /** @type {any} */ ({
        items: [
          {
            cor_costas: '',
            cor_frente: '',
            cor_manga_direita: '',
            cor_manga_esquerda: '',
            grade: [],
            malhas: [],
            modelo: 'camiseta comum, gola V',
            tipo: '',
            vies_gola: '',
            vies_mangas: '',
          },
        ],
        observations: [],
        serviceData: { colors: 'preta' },
        summary: {
          aplicacao: null,
          cliente: '',
          data_entrega_confirmada: null,
          nome: null,
        },
      }),
      firstContactAt: null,
      id: randomUUID(),
      missingFields: ['items', 'finalAmount', 'summary.cliente'],
      now: NOW,
      totalPieces: 0,
    });
    const service = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: {
        readOrderContexts: async () => new Map(),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository,
    });
    const read = await service.get(legacy.id);
    assert.deepEqual(
      [
        read.ficha.items[0].cor,
        read.ficha.items[0].estampa,
        read.ficha.items[0].gola,
      ],
      ['', '', ''],
    );
    assert.deepEqual(read.missingFields, [
      'items[0].tipo',
      'items[0].cor',
      'items[0].tipo_servico',
      'items[0].malhas',
      'items[0].grade',
      'items[0].gola',
      'artwork',
      'summary.data_entrega_confirmada',
      'finalAmount',
      'paymentCondition',
    ]);
  });

  test('rejects a key that is not 32 bytes', () => {
    assert.throws(
      () =>
        new PostgresOrderRepository({
          database: databaseFor(pool),
          envelopeKey: Buffer.alloc(16),
        }),
      TypeError,
    );
  });

  test('a transfer between the first owner check and the write rejects every human order mutation', async () => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const conversationId = await seedConversation(pool);
    const owner = { id: `seller-old-${tag}`, kind: 'human', capabilities: [] };
    const nextOwner = `seller-new-${tag}`;
    const admin = {
      id: `admin-${tag}`,
      kind: 'human',
      capabilities: ['COMMERCIAL_ADMIN'],
    };
    for (const [id, name] of [
      [owner.id, 'Vendedor Anterior'],
      [nextOwner, 'Vendedor Atual'],
      [admin.id, 'Admin Sintetico'],
    ]) {
      await pool.query(
        `INSERT INTO crm.users (id, email, password_hash, name)
         VALUES ($1, $2, '$argon2id$synthetic', $3)`,
        [id, `${id}@example.test`, name],
      );
    }
    await pool.query(
      `INSERT INTO crm.user_functions (user_id, function_name) VALUES ($1, 'Vendedor')`,
      [admin.id],
    );
    await pool.query(
      `INSERT INTO crm.user_capabilities (user_id, capability)
       VALUES ($1, 'COMMERCIAL_ADMIN')`,
      [admin.id],
    );
    const transfer = (/** @type {string} */ userId) =>
      pool.query(
        `UPDATE crm.conversations
         SET assigned_user_id = $2, version = version + 1
         WHERE id = $1`,
        [conversationId, userId],
      );
    await transfer(owner.id);

    const created = await repository.createPending({
      conversationId,
      correlationId: `correlation-race-create-${tag}`,
      createdBy: null,
      createdByKind: 'automation',
      fabCode: '01',
      ficha: {
        artwork: {
          feito_pelo_cliente: true,
          feito_pela_silmer: false,
          files: [],
          sem_estampa: false,
        },
        items: /** @type {any} */ (syntheticItems()),
        observations: [],
        serviceData: {},
        summary: {
          aplicacao: null,
          cliente: 'Cliente Sintetico',
          data_entrega_confirmada: '2026-10-24',
          nome: 'Evento Sintetico',
        },
      },
      firstContactAt: NOW.toISOString(),
      id: randomUUID(),
      missingFields: ['finalAmount', 'paymentCondition'],
      now: NOW,
      totalPieces: 32,
    });
    const port = new PostgresOrderConversationPort({
      contactEnvelopeKey: CONTACT_KEY,
      contactLookupKey: Buffer.alloc(32, 66),
      database: databaseFor(pool),
      envelopeKey: ENVELOPE_KEY,
    });
    /** @type {{checked: {promise: Promise<void>, resolve: () => void}, resume: {promise: Promise<void>, resolve: () => void}}|null} */
    let barrier = null;
    const service = createOrderService({
      async authorizeOwnership({ actor, conversationId: id }) {
        const assignment = await port.readAssignment(id);
        if (
          assignment?.assignedUserId !== actor.id &&
          !(actor.capabilities ?? []).includes('COMMERCIAL_ADMIN')
        ) {
          throw Object.assign(new Error('not the owner'), {
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }
        if (barrier) {
          const pending = barrier;
          barrier = null;
          pending.checked.resolve();
          await pending.resume.promise;
        }
      },
      clock: () => NOW,
      conversations: {
        readOrderContexts: orderContextsFrom(() => ({
          briefing: null,
          customerName: 'Cliente Sintetico',
        })),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository,
    });
    const eventCount = async () =>
      Number(
        (
          await pool.query(
            `SELECT count(*) AS total FROM crm.domain_events
             WHERE aggregate_type = 'order' AND aggregate_id = $1`,
            [created.id],
          )
        ).rows[0].total,
      );
    const deferred = () => {
      /** @type {() => void} */
      let resolve = () => {};
      /** @type {Promise<void>} */
      const promise = new Promise((done) => {
        resolve = () => done();
      });
      return { promise, resolve };
    };
    /** @param {() => Promise<unknown>} command */
    const loseOwnerBeforeWrite = async (command) => {
      const before = await repository.findById(created.id);
      const beforeEvents = await eventCount();
      barrier = { checked: deferred(), resume: deferred() };
      const pending = barrier;
      const result = command();
      await Promise.race([
        pending.checked.promise,
        result.then(
          () => {
            throw new Error('command ended before the ownership barrier');
          },
          (error) => {
            throw error;
          },
        ),
      ]);
      try {
        await transfer(nextOwner);
      } finally {
        pending.resume.resolve();
      }
      await assert.rejects(result, { code: 'FORBIDDEN', statusCode: 403 });
      assert.deepEqual(await repository.findById(created.id), before);
      assert.equal(await eventCount(), beforeEvents);
      await transfer(owner.id);
    };

    await loseOwnerBeforeWrite(() =>
      service.patchSection({
        actor: owner,
        correlationId: `correlation-race-section-${tag}`,
        expectedVersion: created.version,
        orderId: created.id,
        section: 'observations',
        value: [],
      }),
    );
    await loseOwnerBeforeWrite(() =>
      service.confirm({
        actor: owner,
        amountText: '150,00',
        correlationId: `correlation-race-confirm-${tag}`,
        expectedVersion: created.version,
        orderId: created.id,
        paymentCondition: 'pix',
      }),
    );
    const confirmed = await service.confirm({
      actor: owner,
      amountText: '150,00',
      correlationId: `correlation-race-ready-${tag}`,
      expectedVersion: created.version,
      orderId: created.id,
      paymentCondition: 'pix',
    });
    await loseOwnerBeforeWrite(() =>
      service.recordMilestones({
        actor: owner,
        correlationId: `correlation-race-milestones-${tag}`,
        deliveredOn: null,
        expectedVersion: confirmed.version,
        orderId: created.id,
        paidOn: '2026-09-12',
      }),
    );
    await loseOwnerBeforeWrite(() =>
      service.reopen({
        actor: owner,
        correlationId: `correlation-race-reopen-${tag}`,
        expectedVersion: confirmed.version,
        orderId: created.id,
      }),
    );

    // A stale capability claim cannot replace the locked database grant.
    await transfer(nextOwner);
    await assert.rejects(
      service.recordMilestones({
        actor: { ...owner, capabilities: ['COMMERCIAL_ADMIN'] },
        correlationId: `correlation-fake-admin-${tag}`,
        deliveredOn: null,
        expectedVersion: confirmed.version,
        orderId: created.id,
        paidOn: '2026-09-12',
      }),
      { code: 'FORBIDDEN', statusCode: 403 },
    );
    const grantedAdmin = await service.recordMilestones({
      actor: admin,
      correlationId: `correlation-real-admin-${tag}`,
      deliveredOn: null,
      expectedVersion: confirmed.version,
      orderId: created.id,
      paidOn: '2026-09-12',
    });
    assert.equal(grantedAdmin.paidOn, '2026-09-12');
  });

  // ADR 023: the file catalog takes the order locks, keeps the five-file
  // limit under concurrency and seals the original name. With
  // TEST_OBJECT_STORAGE_* set, the bytes go through a real RustFS/S3.
  test('order files keep five references under concurrency and seal their names', async () => {
    const canary = `PII-canary-${randomUUID()}`;
    const conversationId = await seedConversation(pool);
    await pool.query(
      `UPDATE crm.conversations SET assigned_user_id = 'seller-contract'
       WHERE id = $1`,
      [conversationId],
    );
    const owner = {
      capabilities: [],
      id: 'seller-contract',
      kind: 'human',
    };
    const orderService = createOrderService({
      authorizeOwnership: async () => {},
      clock: () => NOW,
      conversations: {
        readOrderContexts: orderContextsFrom(() => ({
          briefing: { order_name: 'Equipe Sintetica' },
          customerName: 'Cliente Sintetico',
        })),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository,
    });
    const { order } = await orderService.ensurePendingFromIntent({
      conversationId,
      correlationId: 'correlation-files',
    });
    const storage = process.env.TEST_OBJECT_STORAGE_ENDPOINT
      ? new S3ObjectStorage({
          accessKeyId: String(process.env.TEST_OBJECT_STORAGE_ACCESS_KEY_ID),
          bucket: String(process.env.TEST_OBJECT_STORAGE_BUCKET),
          endpoint: process.env.TEST_OBJECT_STORAGE_ENDPOINT,
          region: process.env.TEST_OBJECT_STORAGE_REGION ?? 'us-east-1',
          secretAccessKey: String(
            process.env.TEST_OBJECT_STORAGE_SECRET_ACCESS_KEY,
          ),
        })
      : new InMemoryObjectStorage();
    const files = createOrderFileService({
      authorizeOwnership: async () => {},
      files: new PostgresOrderFileRepository({
        database: databaseFor(pool),
        envelopeKey: ENVELOPE_KEY,
      }),
      orders: repository,
      storage,
    });
    const pdf = (/** @type {number} */ index) =>
      Buffer.from(`%PDF-1.7\n% synthetic ${index}\n`);

    const attempts = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7].map((index) =>
        files.upload({
          actor: owner,
          content: pdf(index),
          name: `${canary}-${index}.pdf`,
          orderId: order.id,
          slot: 'reference',
        }),
      ),
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === 'fulfilled').length,
      5,
    );
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') {
        assert.equal(attempt.reason.code, 'FILE_LIMIT_REACHED');
      }
    }

    const first = await files.upload({
      actor: owner,
      content: pdf(8),
      name: 'arte-final.pdf',
      orderId: order.id,
      slot: 'final',
    });
    const second = await files.upload({
      actor: owner,
      content: pdf(9),
      name: 'arte-final-v2.pdf',
      orderId: order.id,
      slot: 'final',
    });
    assert.equal(second.files.final?.name, 'arte-final-v2.pdf');
    assert.equal(second.files.references.length, 5);
    assert.equal(
      await storage.getObject(/** @type {any} */ (first.file).objectKey),
      null,
      'the replaced final art is gone from storage',
    );
    const opened = await files.openContent(order.id, second.file.id);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), pdf(9));

    const raw = await pool.query(
      `SELECT to_jsonb(order_files.*)::text AS row FROM crm.order_files
       WHERE order_id = $1`,
      [order.id],
    );
    assert.equal(raw.rows.length, 6);
    for (const row of raw.rows) {
      assert.doesNotMatch(row.row, new RegExp(canary, 'u'));
    }

    await assert.rejects(
      new PostgresOrderFileRepository({
        database: databaseFor(pool),
        envelopeKey: ENVELOPE_KEY,
      }).remove(order.id, second.file.id, {
        actor: { ...owner, id: 'seller-intruder' },
      }),
      { code: 'FORBIDDEN', statusCode: 403 },
    );
    const removed = await files.remove({
      actor: owner,
      fileId: second.file.id,
      orderId: order.id,
    });
    assert.equal(removed.files.final, null);
    assert.equal(await storage.getObject(second.file.objectKey), null);
  });

  test('manual delivery: PostgreSQL permits one concurrent confirmation and preserves payment', async () => {
    const conversationId = await seedConversation(pool, {
      channel: 'whatsapp',
    });
    const contactId = (
      await pool.query(
        `SELECT identity.current_contact_id
      FROM crm.conversations conversation JOIN crm.contact_identities identity
      ON identity.id = conversation.contact_identity_id WHERE conversation.id = $1`,
        [conversationId],
      )
    ).rows[0].current_contact_id;
    const actor = { id: 'seller-contract', kind: 'human', capabilities: [] };
    const now = new Date('2026-10-22T01:30:00.000Z');
    const service = createOrderService({
      authorizeOwnership: async () => undefined,
      authorizeManualOwnership: async ({ actor: principal, ownerId }) => {
        assert.equal(principal.id, ownerId);
      },
      clock: () => now,
      conversations: {
        readOrderContexts: async () => new Map(),
        readContactNames: async () =>
          new Map([[contactId, 'Cliente Sintético']]),
        searchConversationIds: async () => [],
      },
      fabCode: '01',
      repository,
    });
    let order = await service.createForContact({
      actor,
      contactId,
      correlationId: 'manual-delivery-create',
      idempotencyKey: randomUUID(),
    });
    assert.equal(order.firstContactAt, order.createdAt);
    for (const [section, value] of Object.entries({
      summary: {
        nome: 'Evento Sintético',
        data_entrega_confirmada: '2026-10-24',
      },
      items: syntheticItems(),
      artwork: { feito_pelo_cliente: true, feito_pela_silmer: false },
    })) {
      order = await service.patchSection({
        actor,
        correlationId: 'manual-delivery-edit',
        orderId: order.id,
        expectedVersion: order.version,
        section,
        value,
      });
    }
    order = await service.confirm({
      actor,
      correlationId: 'manual-delivery-confirm',
      orderId: order.id,
      expectedVersion: order.version,
      amountText: '100,00',
      paymentCondition: 'pix',
    });
    order = await service.recordMilestones({
      actor,
      correlationId: 'manual-delivery-paid',
      orderId: order.id,
      expectedVersion: order.version,
      paidOn: '2026-10-20',
    });
    assert.ok(
      (await service.deliveryTasks({ actor })).some(
        (item) => item.id === order.id,
      ),
    );
    const command = {
      actor,
      correlationId: 'manual-delivery-done',
      orderId: order.id,
      expectedVersion: order.version,
    };
    const results = await Promise.allSettled([
      service.confirmDelivery(command),
      service.confirmDelivery(command),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.reason.code, 'VERSION_CONFLICT');
    const delivered = await service.get(order.id);
    assert.equal(delivered.deliveredOn, '2026-10-21');
    assert.equal(delivered.paidOn, '2026-10-20');
    assert.equal(delivered.version, order.version + 1);
    assert.ok(
      !(await service.deliveryTasks({ actor })).some(
        (item) => item.id === order.id,
      ),
    );
    const events = await pool.query(
      `SELECT count(*)::integer AS count FROM crm.domain_events
      WHERE aggregate_id = $1 AND event_type = 'order.milestones_saved'`,
      [order.id],
    );
    assert.equal(events.rows[0].count, 2);
  });
}
