import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubjectService } from '../modules/inbox-channels/src/application/subject-service.js';

const seller = { id: 'seller-1', kind: 'human', functionName: 'Vendedor' };
const command = {
  actor: seller,
  conversationId: 'conversation-1',
  correlationId: 'correlation-1',
  idempotencyKey: 'command-1',
  orderId: 'order-from-another-contact',
};

function serviceWith(/** @type {{closed?: boolean}} */ options = {}) {
  /** @type {string[]} */
  const queries = [];
  const database = {
    /** @param {string} sql */
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM crm.subject_commands')) return { rows: [] };
      if (sql.includes('FROM crm.conversations')) {
        return {
          rows: [
            {
              assigned_user_id: seller.id,
              contact_id: 'contact-1',
              contact_identity_id: 'identity-1',
              terminal_at: options.closed ? new Date() : null,
            },
          ],
        };
      }
      if (sql.includes('FROM crm.orders')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      return work(database);
    },
  };
  return { service: createSubjectService(database), queries };
}

test('subject commands reject a different contact before any subject or audit write', async () => {
  const { service, queries } = serviceWith();
  await assert.rejects(service.create(command), {
    code: 'ORDER_CONTACT_MISMATCH',
  });
  assert.equal(
    queries.some((sql) => sql.includes('INSERT INTO')),
    false,
  );
});

test('subject commands require the conversation owner and an open cycle', async () => {
  const wrongOwner = serviceWith();
  await assert.rejects(
    wrongOwner.service.create({
      ...command,
      actor: { ...seller, id: 'another-seller' },
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(
    wrongOwner.queries.some((sql) => sql.includes('FROM crm.orders')),
    false,
  );

  const closed = serviceWith({ closed: true });
  await assert.rejects(closed.service.create(command), {
    code: 'CONVERSATION_CLOSED',
  });
});

/**
 * @param {{subjects: number, reviews?: string[]}} options
 */
function listService(options) {
  const database = {
    /** @param {string} sql */
    async query(sql) {
      if (sql.includes('FROM crm.conversations')) {
        return {
          rows: [
            { contact_id: 'contact-1', contact_identity_id: 'identity-1' },
          ],
        };
      }
      if (sql.includes('FROM crm.conversation_subjects')) {
        return {
          rows: Array.from({ length: options.subjects }, (_, index) => ({
            id: `subject-${index + 1}`,
            is_current: index === 0,
            kind: 'pedido',
            order_id: `order-${index + 1}`,
            position: index + 1,
            selected_source: 'agent',
            version: 1,
          })),
        };
      }
      if (sql.includes('FROM crm.orders')) return { rows: [] };
      if (sql.includes('FROM crm.message_subject_reviews')) {
        assert.match(sql, /resolved_at IS NULL/u);
        assert.match(sql, /NOT EXISTS/u);
        return {
          rows: (options.reviews ?? []).map((id) => ({ message_id: id })),
        };
      }
      if (sql.includes('FROM crm.message_subject_links')) {
        return {
          rows: [
            {
              message_id: 'message-1',
              subject_id: 'subject-1',
              assigned_by_kind: 'agent',
            },
            {
              message_id: 'message-2',
              subject_id: 'subject-2',
              assigned_by_kind: 'human',
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      return work(database);
    },
  };
  return createSubjectService(database);
}

test('CP-12/CP-16: links say who assigned them and only open unlinked reviews ask the seller', async () => {
  const two = await listService({
    subjects: 2,
    reviews: ['message-3'],
  }).list('conversation-1');
  assert.deepEqual(two.links, [
    { messageId: 'message-1', subjectId: 'subject-1', assignedByKind: 'agent' },
    { messageId: 'message-2', subjectId: 'subject-2', assignedByKind: 'human' },
  ]);
  assert.deepEqual(two.needsSubjectMessageIds, ['message-3']);
  // UXA-14: one order plus "I also want another" still asks the seller.
  const one = await listService({ subjects: 1, reviews: ['message-3'] }).list(
    'conversation-1',
  );
  assert.deepEqual(one.needsSubjectMessageIds, ['message-3']);
  const none = await listService({ subjects: 3 }).list('conversation-1');
  assert.deepEqual(none.needsSubjectMessageIds, []);
});

/** @param {{review: null | {reason: string, resolved_at: Date|null}}} options */
function tagService(options) {
  /** @type {Array<{sql: string, values: unknown[]}>} */
  const queries = [];
  const database = {
    /** @param {string} sql @param {unknown[]} values */
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('FROM crm.subject_commands')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM crm.conversations')) {
        return {
          rows: [
            {
              assigned_user_id: seller.id,
              contact_id: 'contact-1',
              contact_identity_id: 'identity-1',
              terminal_at: null,
            },
          ],
        };
      }
      if (sql.startsWith('SELECT id FROM crm.messages')) {
        return { rows: [{ id: 'message-1' }] };
      }
      if (sql.includes('FROM crm.conversation_subjects subject')) {
        return { rows: [{ id: 'subject-1' }] };
      }
      if (sql.includes('FROM crm.message_subject_links')) {
        return {
          rows: [{ subject_id: 'subject-2', assigned_by_kind: 'agent' }],
        };
      }
      if (sql.includes('SELECT reason, resolved_at')) {
        return { rows: options.review ? [options.review] : [] };
      }
      if (/^\s*(INSERT|DELETE|UPDATE)/u.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      return work(database);
    },
  };
  return { service: createSubjectService(database), queries };
}

const tagCommand = {
  actor: seller,
  conversationId: 'conversation-1',
  correlationId: 'correlation-tag',
  idempotencyKey: 'tag-1',
  messageId: 'message-1',
};

test('CP-12: a human tag replaces agent links and resolves the review in one transaction', async () => {
  const open = tagService({
    review: { reason: 'subject_ambiguous', resolved_at: null },
  });
  assert.deepEqual(
    await open.service.tagMessage({ ...tagCommand, subjectIds: ['subject-1'] }),
    { messageId: 'message-1', subjectIds: ['subject-1'] },
  );
  const resolved = open.queries.find(({ sql }) =>
    sql.includes('UPDATE crm.message_subject_reviews'),
  );
  assert.ok(resolved, 'the open review is resolved');
  assert.match(resolved.sql, /resolved_at=now\(\), resolved_by=\$2/u);
  assert.deepEqual(resolved.values, ['message-1', seller.id]);
  const event = open.queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.domain_events'),
  );
  const payload = JSON.parse(String(event?.values[2]));
  assert.deepEqual(payload.previousLinks, [
    { subjectId: 'subject-2', assignedByKind: 'agent' },
  ]);
  assert.equal(payload.reviewResolved, true);
  // The seller's decision never resolves the handoff nor wakes the bot.
  for (const { sql } of open.queries) {
    assert.doesNotMatch(
      sql,
      /crm\.handoffs|automation_state|automation_epoch/u,
    );
  }

  // A message without a review gets a resolved human one, even for [].
  const fresh = tagService({ review: null });
  await fresh.service.tagMessage({ ...tagCommand, subjectIds: [] });
  const inserted = fresh.queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.message_subject_reviews'),
  );
  assert.ok(inserted, 'a resolved human review is inserted');
  assert.match(inserted.sql, /'human_review', now\(\), now\(\)/u);
  assert.deepEqual(inserted.values, ['message-1', 'conversation-1', seller.id]);
  const freshEvent = fresh.queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.domain_events'),
  );
  assert.equal(JSON.parse(String(freshEvent?.values[2])).reviewResolved, false);
});

/** @param {{stored?: {fingerprint: string, result: any}}} [options] */
function createService(options = {}) {
  /** @type {Array<{sql: string, params: any[]}>} */
  const queries = [];
  const database = {
    /** @param {string} sql @param {any[]} [params] */
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM crm.subject_commands')) {
        return { rows: options.stored ? [options.stored] : [] };
      }
      if (sql.includes('FROM crm.conversations')) {
        return {
          rows: [
            {
              assigned_user_id: seller.id,
              contact_id: 'contact-1',
              contact_identity_id: 'identity-1',
              terminal_at: null,
            },
          ],
        };
      }
      if (sql.includes('COALESCE(max(position)')) {
        return { rows: [{ next: 3 }] };
      }
      if (sql.startsWith('UPDATE crm.conversation_subjects')) {
        return { rows: [{ id: 'subject-current' }] };
      }
      return { rows: [] };
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      return work(database);
    },
  };
  return { service: createSubjectService(database), queries };
}

test('CP-31: select false creates the subject without moving the current one', async () => {
  const { service, queries } = createService();
  const result = await service.create({
    ...command,
    idempotencyKey: 'separate-1',
    orderId: null,
    select: false,
  });
  assert.equal(result.subject.isCurrent, false);
  assert.equal(result.subject.selectedSource, null);
  assert.equal(typeof result.subject.id, 'string');
  assert.equal(
    queries.some(({ sql }) =>
      sql.startsWith('UPDATE crm.conversation_subjects'),
    ),
    false,
  );
  const insert = queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.conversation_subjects'),
  );
  assert.equal(insert?.params[8], false);
  const event = queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.domain_events'),
  );
  assert.equal(JSON.parse(event?.params[2]).previousSubjectId, null);

  // The default keeps the original behaviour: the new subject is current.
  const selected = createService();
  const current = await selected.service.create({
    ...command,
    idempotencyKey: 'create-1',
    orderId: null,
  });
  assert.equal(current.subject.isCurrent, true);
  assert.equal(current.subject.selectedSource, 'human');
  assert.equal(
    selected.queries.some(({ sql }) =>
      sql.startsWith('UPDATE crm.conversation_subjects'),
    ),
    true,
  );
  assert.equal(
    selected.queries.find(({ sql }) =>
      sql.includes('INSERT INTO crm.conversation_subjects'),
    )?.params[8],
    true,
  );
});

test('CP-31: select is part of the idempotency fingerprint and must be boolean', async () => {
  const first = createService();
  await first.service.create({ ...command, orderId: null, select: true });
  const stored = first.queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.subject_commands'),
  );
  const fingerprint = stored?.params[2];
  // An omitted select is the same command as select: true...
  const replay = createService({
    stored: { fingerprint, result: { subject: { id: 'subject-1' } } },
  });
  assert.deepEqual(await replay.service.create({ ...command, orderId: null }), {
    subject: { id: 'subject-1' },
  });
  // ...while select: false under the same key is a different command.
  await assert.rejects(
    replay.service.create({ ...command, orderId: null, select: false }),
    { code: 'IDEMPOTENCY_KEY_REUSED' },
  );
  const invalid = createService();
  await assert.rejects(
    invalid.service.create({ ...command, orderId: null, select: 'no' }),
    { code: 'INVALID_REQUEST' },
  );
  assert.equal(invalid.queries.length, 0);
});
