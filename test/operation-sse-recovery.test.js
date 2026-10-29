import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerOperationRoutes } from '../apps/api/src/operation-routes.js';

/** @param {(input: {after:number}) => Promise<any>} readLiveEvents */
function streamHarness(readLiveEvents) {
  /** @type {any} */
  let streamHandler;
  const api = {
    get(
      /** @type {string} */ path,
      /** @type {any} */ options,
      /** @type {any} */ handler,
    ) {
      if (path === '/api/v1/events') streamHandler = handler ?? options;
    },
    post() {},
    put() {},
  };
  registerOperationRoutes(
    /** @type {any} */ (api),
    {
      authorizeRead: async () => ({ actor: { id: 'operator-1' } }),
      readLiveEvents,
    },
    () => ({ correlationId: 'test', requestId: 'test' }),
  );
  /** @type {string[]} */
  const writes = [];
  const request = {
    headers: { 'last-event-id': '500' },
    query: { after: '0', topic: 'inbox' },
    raw: new EventEmitter(),
  };
  const reply = {
    hijack() {},
    raw: Object.assign(new EventEmitter(), {
      write(/** @type {string} */ chunk) {
        writes.push(chunk);
      },
      writeHead() {},
    }),
  };
  return { reply, request, streamHandler, writes };
}

test('SSE sends a restore reset and then accepts a lower new event on the same connection', async () => {
  /** @type {number[]} */
  const reads = [];
  const { reply, request, streamHandler, writes } = streamHarness(
    async ({ after }) => {
      reads.push(after);
      if (after === 500) return { cursor: 100, events: [], reset: true };
      return {
        cursor: 101,
        events: [
          {
            cursor: 101,
            payload: { orderId: 'order-1' },
            type: 'inbox.order.changed',
          },
        ],
        reset: false,
      };
    },
  );
  try {
    await streamHandler(request, reply);
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.deepEqual(reads, [500, 100]);
    assert.match(writes.join(''), /id: 100\nevent: stream\.reset/u);
    assert.match(writes.join(''), /id: 101\nevent: inbox\.order\.changed/u);
    assert.ok(
      writes.findIndex((chunk) => chunk.includes('event: stream.reset')) <
        writes.findIndex((chunk) =>
          chunk.includes('event: inbox.order.changed'),
        ),
    );
  } finally {
    request.raw.emit('close');
  }
});

test('SSE does not reset a valid browser cursor when the API process is new', async () => {
  /** @type {number[]} */
  const reads = [];
  const { reply, request, streamHandler, writes } = streamHarness(
    async ({ after }) => {
      reads.push(after);
      return after === 0
        ? { cursor: 500, events: [], reset: true }
        : { cursor: after, events: [], reset: false };
    },
  );
  try {
    await streamHandler(request, reply);
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.deepEqual(reads, [500, 500]);
    assert.deepEqual(writes, [': connected\n\n']);
  } finally {
    request.raw.emit('close');
  }
});
