import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresN8nCommandStore } from '../modules/n8n-integration/src/postgres-command-store.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');

/** @param {Record<string, any>} [overrides] */
function fixture(overrides = {}) {
  /** @type {any} */
  const state = {
    command: {
      action: 'send_message',
      command_id: 'command-1',
      conversation_id: 'conversation-1',
      locked_by: 'attempt-1',
      locked_until: new Date(NOW.getTime() + 60_000),
      message_id: 'message-1',
      status: 'processing',
      ...overrides,
    },
    events: [],
    failEvent: false,
    message: { id: 'message-1', status: 'queued', delivery_status: null },
    reconciliationCount: 0,
    queueStatus: null,
  };
  const database = {
    async query() {
      throw new Error('Store must use its transaction client');
    },
    async transaction(/** @type {(client: any) => Promise<any>} */ work) {
      const snapshot = structuredClone(state);
      const client = {
        async query(
          /** @type {string} */ sql,
          /** @type {any[]} */ values = [],
        ) {
          if (
            sql.includes('SELECT order_id FROM crm.order_billing_charges') ||
            sql.includes('FROM crm.order_billing_send_intents')
          ) {
            return { rows: [] };
          }
          if (
            sql.includes(
              'FROM crm.n8n_commands WHERE command_id = $1 FOR UPDATE',
            )
          ) {
            return { rows: [{ ...state.command }] };
          }
          if (
            sql.includes("SET status = 'outcome_unknown'") &&
            sql.includes('locked_until <= $2')
          ) {
            const expired =
              state.command.status === 'processing' &&
              state.command.locked_until <= values[1];
            if (expired) state.command.status = 'outcome_unknown';
            return { rows: expired ? [{ ...state.command }] : [] };
          }
          if (sql.includes('UPDATE crm.n8n_commands AS command')) {
            const unknown =
              state.queueStatus === 'outcome_unknown' &&
              ['pending', 'processing', 'failed'].includes(
                state.command.status,
              );
            if (unknown) state.command.status = 'outcome_unknown';
            return { rows: unknown ? [{ ...state.command }] : [] };
          }
          if (
            sql.includes(
              'SELECT command_id, fingerprint, payload_envelope, status',
            )
          ) {
            return { rows: [{ ...state.command }] };
          }
          if (sql.includes('SELECT command.command_id, command.action')) {
            return {
              rows: [
                {
                  ...state.command,
                  current_epoch: 1,
                  automation_state: 'human',
                  terminal_at: null,
                },
              ],
            };
          }
          if (
            sql.includes('UPDATE crm.n8n_commands') &&
            sql.includes('SET status = $2')
          ) {
            state.command.status = values[1];
            state.command.locked_by = null;
            state.command.locked_until = null;
            return { rows: [] };
          }
          if (
            sql.includes('UPDATE crm.messages') &&
            sql.includes('external_message_id')
          ) {
            const confirmed =
              state.message.status === 'sent' ||
              state.message.external_message_id ||
              ['sent', 'delivered', 'read'].includes(
                state.message.delivery_status,
              );
            if (values[2] === 'sent' || !confirmed) {
              state.message.status = values[2];
              if (
                !['delivered', 'read'].includes(state.message.delivery_status)
              )
                state.message.delivery_status = values[3];
            }
            return { rows: [] };
          }
          if (
            sql.includes('UPDATE crm.messages') &&
            sql.includes("status = 'outcome_unknown'")
          ) {
            const changed = ['queued', 'sending', 'failed'].includes(
              state.message.status,
            );
            if (changed) {
              state.message.status = 'outcome_unknown';
              state.message.delivery_status = 'outcome_unknown';
            }
            return { rows: changed ? [{ id: state.message.id }] : [] };
          }
          if (sql.includes('INSERT INTO crm.reconciliation_items')) {
            state.reconciliationCount += 1;
            return { rows: [] };
          }
          if (sql.includes('FOR UPDATE OF conversation')) {
            return { rows: [{ id: state.command.conversation_id }] };
          }
          if (sql.includes('INSERT INTO crm.domain_events')) {
            if (state.failEvent) throw new Error('event stream unavailable');
            state.events.push({
              aggregateType: 'conversation',
              aggregateId: values[1],
              eventType: 'conversation.message_delivery_changed',
              payload: JSON.parse(values[2]),
              correlationId: values[3],
              occurredAt: values[4],
            });
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
      try {
        return await work(client);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };
  return {
    state,
    store: new PostgresN8nCommandStore({
      database,
      envelopeKey: Buffer.alloc(32),
    }),
  };
}

test('worker uncertainty preserves a confirmed provider delivery', async () => {
  for (const status of ['sent', 'delivered', 'read']) {
    const { state, store } = fixture();
    state.message.status = 'sent';
    state.message.delivery_status = status;
    state.message.external_message_id = 'provider-confirmed';
    await store.markOutcomeUnknown('command-1', {
      attemptId: 'attempt-1',
      now: NOW,
    });
    assert.equal(state.message.status, 'sent');
    assert.equal(state.message.delivery_status, status);
  }
});

test('worker acknowledgement preserves a stronger provider receipt', async () => {
  const { state, store } = fixture();
  state.message.status = 'sent';
  state.message.delivery_status = 'read';
  await store.markDelivered('command-1', { attemptId: 'attempt-1', now: NOW });
  assert.equal(state.message.delivery_status, 'read');
});

test('human send failure publishes one identifier-only event on a real transition', async () => {
  const { state, store } = fixture();
  const context = {
    attemptId: 'attempt-1',
    errorCode: 'REMOTE_DOWN',
    now: NOW,
  };
  assert.equal(await store.markFailed('command-1', context), true);
  assert.equal(await store.markFailed('command-1', context), true);
  assert.equal(state.message.delivery_status, 'failed');
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0].payload, {
    conversationId: 'conversation-1',
  });
  assert.equal(state.events[0].correlationId, 'n8n-command:command-1');
  assert.ok(!JSON.stringify(state.events).includes('REMOTE_DOWN'));
});

test('unknown outcome and manual reconciliation each publish once', async () => {
  const { state, store } = fixture();
  const context = { attemptId: 'attempt-1', now: NOW };
  assert.equal(await store.markOutcomeUnknown('command-1', context), true);
  assert.equal(await store.markOutcomeUnknown('command-1', context), true);
  assert.equal(
    await store.markOutcomeUnknown('command-1', {
      reconciledBy: 'operator-1',
      now: NOW,
    }),
    true,
  );
  assert.equal(state.message.delivery_status, 'outcome_unknown');
  assert.equal(state.events.length, 1);
  assert.equal(
    await store.markDelivered('command-1', {
      reconciledBy: 'operator-1',
      now: NOW,
    }),
    true,
  );
  assert.equal(
    await store.markDelivered('command-1', {
      reconciledBy: 'operator-1',
      now: NOW,
    }),
    true,
  );
  assert.equal(state.message.delivery_status, 'sent');
  assert.equal(state.events.length, 2);
});

test('expired command lease updates the message and emits once during recovery', async () => {
  const { state, store } = fixture({
    locked_until: new Date(NOW.getTime() - 1),
  });
  assert.equal(await store.loadForDelivery('command-1', { now: NOW }), null);
  assert.equal(await store.loadForDelivery('command-1', { now: NOW }), null);
  assert.equal(state.message.delivery_status, 'outcome_unknown');
  assert.equal(state.events.length, 1);
  assert.equal(state.reconciliationCount, 1);
});

test('unknown queue result updates a failed message once and preserves a confirmed send', async () => {
  const failed = fixture({
    locked_by: null,
    locked_until: null,
    status: 'failed',
  });
  failed.state.message.status = 'failed';
  failed.state.queueStatus = 'outcome_unknown';
  assert.equal(
    await failed.store.loadForDelivery('command-1', { now: NOW }),
    null,
  );
  assert.equal(
    await failed.store.loadForDelivery('command-1', { now: NOW }),
    null,
  );
  assert.equal(failed.state.message.delivery_status, 'outcome_unknown');
  assert.equal(failed.state.events.length, 1);

  const sent = fixture({ locked_by: null, locked_until: null, status: 'sent' });
  sent.state.message.status = 'sent';
  sent.state.queueStatus = 'outcome_unknown';
  assert.equal(
    await sent.store.loadForDelivery('command-1', { now: NOW }),
    null,
  );
  assert.equal(sent.state.command.status, 'sent');
  assert.equal(sent.state.events.length, 0);
});

test('non-message command and stale worker do not emit message events', async () => {
  const panel = fixture({ action: 'take_over', message_id: null });
  assert.equal(
    await panel.store.markFailed('command-1', {
      attemptId: 'attempt-1',
      now: NOW,
    }),
    true,
  );
  assert.equal(panel.state.events.length, 0);

  const stale = fixture();
  assert.equal(
    await stale.store.markFailed('command-1', { attemptId: 'other', now: NOW }),
    false,
  );
  assert.equal(stale.state.events.length, 0);
});

test('event failure rolls back the command and message transition', async () => {
  const { state, store } = fixture();
  state.failEvent = true;
  await assert.rejects(
    store.markFailed('command-1', { attemptId: 'attempt-1', now: NOW }),
    /event stream unavailable/u,
  );
  assert.equal(state.command.status, 'processing');
  assert.equal(state.message.status, 'queued');
  assert.equal(state.events.length, 0);
});
