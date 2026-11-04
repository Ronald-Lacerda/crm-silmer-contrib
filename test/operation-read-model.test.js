import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { createOperationReadService } from '../apps/api/src/operation-runtime.js';

function serviceHarness() {
  const calls = /** @type {Array<[string, any]>} */ ([]);
  const inboxRepository = {
    async get(/** @type {string} */ id) {
      calls.push(['get-inbox', id]);
      return { conversation: { id } };
    },
    async list(/** @type {any} */ input) {
      calls.push(['list-inbox', input]);
      return {
        hasMore: true,
        items: [
          {
            id: 'conversation-1',
            updatedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
        totalCount: 2,
      };
    },
  };
  const contactRepository = {
    async get(/** @type {string} */ id) {
      calls.push(['get-contact', id]);
      return { contact: { id } };
    },
    async list(/** @type {any} */ input) {
      calls.push(['list-contacts', input]);
      return {
        hasMore: true,
        items: [{ id: 'contact-1', updatedAt: '2026-09-08T11:00:00.000Z' }],
        totalCount: 3,
      };
    },
  };
  const handoffRepository = {
    async listOpen(/** @type {any} */ input) {
      calls.push(['list-handoffs', input]);
      return {
        hasMore: true,
        items: [
          {
            id: 'handoff-1',
            updatedAt: '2026-09-08T13:00:00.000Z',
          },
        ],
        totalCount: 2,
      };
    },
  };
  return {
    calls,
    service: createOperationReadService({
      contactRepository,
      cursorKey: Buffer.alloc(32, 77),
      handoffRepository,
      inboxRepository,
    }),
  };
}

test('binds signed Inbox cursors to closed filters', async () => {
  const { calls, service } = serviceHarness();
  const first = await service.listInbox({
    channel: 'whatsapp',
    limit: 20,
    state: 'requer_atencao',
    unassignedHumanHandoff: true,
  });
  assert.equal(first.totalCount, 2);
  assert.ok(first.nextCursor);
  assert.deepEqual(calls[0], [
    'list-inbox',
    {
      after: null,
      channel: 'whatsapp',
      limit: 20,
      state: 'requer_atencao',
      unassignedHumanHandoff: true,
    },
  ]);

  await service.listInbox({
    channel: 'whatsapp',
    cursor: first.nextCursor,
    limit: 20,
    state: 'requer_atencao',
    unassignedHumanHandoff: true,
  });
  assert.deepEqual(calls[1][1].after, {
    id: 'conversation-1',
    updatedAt: '2026-09-08T12:00:00.000Z',
  });
  await assert.rejects(
    service.listInbox({
      channel: 'instagram',
      cursor: first.nextCursor,
      state: 'requer_atencao',
      unassignedHumanHandoff: true,
    }),
    (error) => /** @type {any} */ (error).code === 'INVALID_CURSOR',
  );
});

test('accepts site chat as an Inbox filter without treating it as WhatsApp', async () => {
  const { calls, service } = serviceHarness();
  await service.listInbox({ channel: 'site_chat', limit: 20 });
  assert.equal(calls[0][1].channel, 'site_chat');
});

test('binds handoff cursors to the pending queue scope', async () => {
  const { calls, service } = serviceHarness();
  const first = await service.listOpenHandoffs({ limit: 20 });
  assert.equal(first.totalCount, 2);
  assert.ok(first.nextCursor);
  assert.deepEqual(calls[0], ['list-handoffs', { after: null, limit: 20 }]);

  await service.listOpenHandoffs({ cursor: first.nextCursor, limit: 20 });
  assert.deepEqual(calls[1], [
    'list-handoffs',
    {
      after: {
        id: 'handoff-1',
        updatedAt: '2026-09-08T13:00:00.000Z',
      },
      limit: 20,
    },
  ]);
  await assert.rejects(
    service.listInbox({ cursor: first.nextCursor }),
    (error) => /** @type {any} */ (error).code === 'INVALID_CURSOR',
  );
});

test('rejects unsupported Inbox filter values before persistence', async () => {
  const { calls, service } = serviceHarness();
  await assert.rejects(
    service.listInbox({ automationState: 'paused' }),
    (error) => /** @type {any} */ (error).code === 'INVALID_FILTER',
  );
  await assert.rejects(
    service.listInbox({ state: 'lost' }),
    (error) => /** @type {any} */ (error).code === 'INVALID_FILTER',
  );
  await assert.rejects(
    service.listInbox({ unassignedHumanHandoff: 'sometimes' }),
    (error) => /** @type {any} */ (error).code === 'INVALID_FILTER',
  );
  assert.deepEqual(calls, []);
});

test('uses a separate cursor scope for Contact pages', async () => {
  const { calls, service } = serviceHarness();
  const first = await service.listContacts({});
  assert.ok(first.nextCursor);
  assert.deepEqual(calls[0], ['list-contacts', { after: null, limit: 50 }]);
  await service.listContacts({ cursor: first.nextCursor, limit: 10 });
  assert.deepEqual(calls[1][1], {
    after: {
      id: 'contact-1',
      updatedAt: '2026-09-08T11:00:00.000Z',
    },
    limit: 10,
  });
  await assert.rejects(
    service.listInbox({ cursor: first.nextCursor }),
    (error) => /** @type {any} */ (error).code === 'INVALID_CURSOR',
  );
  const searched = await service.listContacts({ q: 'Cliente' });
  assert.deepEqual(calls[2][1], { after: null, limit: 50, q: 'Cliente' });
  await assert.rejects(
    service.listContacts({ cursor: searched.nextCursor, q: 'Outro' }),
    (error) => /** @type {any} */ (error).code === 'INVALID_CURSOR',
  );
});

test('PCX-17: urgency cursors bind rank, position, reader and explicit filters without filtering the universe', async () => {
  const calls = /** @type {any[]} */ ([]);
  const items = [
    { id: 'other-owner', updatedAt: '2026-11-04T12:00:00.000Z' },
    { id: 'assistant', updatedAt: '2026-11-04T11:00:00.000Z' },
    { id: 'closed', updatedAt: '2026-11-04T10:00:00.000Z' },
  ];
  const key = Buffer.alloc(32, 75);
  const service = createOperationReadService({
    contactRepository: {},
    handoffRepository: {},
    cursorKey: key,
    inboxRepository: {
      async list(/** @type {any} */ input) {
        calls.push(input);
        return {
          items,
          totalCount: 151,
          hasMore: true,
          nextPosition: { rank: 6, updatedAt: '2026-11-01T10:00:00.000Z' },
        };
      },
    },
  });
  const access = { actorId: 'reader-one' };
  const first = await service.listInbox(
    { sort: 'urgency', archived: false, limit: 3 },
    access,
  );
  assert.deepEqual(first.items, items);
  assert.equal(first.totalCount, 151);
  assert.deepEqual(calls[0], {
    after: null,
    sort: 'urgency',
    actorId: 'reader-one',
    archived: false,
    limit: 3,
  });
  assert.equal('nextPosition' in first, false);
  assert.ok(first.nextCursor);
  const encoded = JSON.parse(
    Buffer.from(first.nextCursor.split('.')[0], 'base64url').toString(),
  );
  assert.equal(encoded.rank, 6);
  assert.equal(encoded.updatedAt, '2026-11-01T10:00:00.000Z');
  await service.listInbox(
    { sort: 'urgency', archived: false, cursor: first.nextCursor },
    access,
  );
  assert.deepEqual(calls[1].after, {
    id: 'closed',
    rank: 6,
    updatedAt: '2026-11-01T10:00:00.000Z',
  });
  /** @type {Array<[Record<string, unknown>, string]>} */
  const incompatible = [
    [{ sort: 'urgency', archived: false }, 'reader-two'],
    [{ archived: false }, 'reader-one'],
    [{ sort: 'urgency', archived: true }, 'reader-one'],
    [
      { sort: 'urgency', archived: false, assignedUserId: 'another-owner' },
      'reader-one',
    ],
    [{ sort: 'urgency', archived: false, pendingHandoff: true }, 'reader-one'],
  ];
  for (const [input, actor] of incompatible) {
    await assert.rejects(
      service.listInbox(
        { ...input, cursor: first.nextCursor },
        { actorId: actor },
      ),
      { code: 'INVALID_CURSOR' },
    );
  }
  assert.equal(
    calls.length,
    2,
    'invalid cursors must not reach the repository',
  );
  for (const rank of [-1, 1.5, '2', null]) {
    const payload = Buffer.from(JSON.stringify({ ...encoded, rank })).toString(
      'base64url',
    );
    const signature = createHmac('sha256', key)
      .update(payload)
      .digest('base64url');
    await assert.rejects(
      service.listInbox(
        { sort: 'urgency', archived: false, cursor: `${payload}.${signature}` },
        access,
      ),
      { code: 'INVALID_CURSOR' },
    );
  }
  await assert.rejects(service.listInbox({ sort: 'recent' }, access), {
    code: 'INVALID_FILTER',
  });
  const legacy = await service.listInbox({});
  assert.ok(legacy.nextCursor);
  const legacyPayload = JSON.parse(
    Buffer.from(legacy.nextCursor.split('.')[0], 'base64url').toString(),
  );
  assert.equal('rank' in legacyPayload, false);
  await assert.rejects(
    service.listInbox({ sort: 'urgency', cursor: legacy.nextCursor }, access),
    { code: 'INVALID_CURSOR' },
  );
});
