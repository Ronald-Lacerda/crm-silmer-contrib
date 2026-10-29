import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerOperationRoutes } from '../apps/api/src/operation-routes.js';

function streamHarness() {
  /** @type {any} */
  let handler;
  /** @type {(value: any) => void} */
  let releaseRead = () => {};
  const pendingRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let allowed = true;
  let ended = false;
  /** @type {string[]} */
  const writes = [];
  registerOperationRoutes(
    /** @type {any} */ ({
      /** @param {string} path @param {any} options @param {any} routeHandler */
      get(path, options, routeHandler) {
        if (path === '/api/v1/events') handler = routeHandler ?? options;
      },
      post() {},
      put() {},
    }),
    {
      async authorizeRead() {
        if (!allowed) throw new Error('FORBIDDEN');
        return { actor: { id: 'operator-1' } };
      },
      async readLiveEvents() {
        return pendingRead;
      },
    },
    () => ({ correlationId: 'test', requestId: 'test' }),
  );
  const request = {
    headers: {},
    query: { after: '0', topic: 'inbox' },
    raw: new EventEmitter(),
  };
  const reply = {
    hijack() {},
    raw: Object.assign(new EventEmitter(), {
      end() {
        ended = true;
      },
      /** @param {string} chunk */
      write(chunk) {
        writes.push(chunk);
      },
      writeHead() {},
    }),
  };
  return {
    deny() {
      allowed = false;
    },
    ended: () => ended,
    handler,
    releaseRead,
    reply,
    request,
    writes,
  };
}

test('revoked session closes SSE before another order identifier is sent', async () => {
  const stream = streamHarness();
  try {
    await stream.handler(stream.request, stream.reply);
    stream.deny();
    stream.releaseRead({
      cursor: 1,
      events: [
        {
          cursor: 1,
          payload: { orderId: 'order-1' },
          type: 'inbox.order.changed',
        },
      ],
      reset: false,
    });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(stream.ended(), true);
    assert.match(stream.writes.join(''), /event: session\.expired/u);
    assert.doesNotMatch(stream.writes.join(''), /order-1/u);
  } finally {
    stream.request.raw.emit('close');
  }
});

test('a change to the signed-in user ends SSE before other domain events', async () => {
  const stream = streamHarness();
  try {
    await stream.handler(stream.request, stream.reply);
    stream.releaseRead({
      cursor: 2,
      events: [
        {
          cursor: 1,
          payload: { userId: 'operator-1' },
          type: 'identity.user.changed',
        },
        {
          cursor: 2,
          payload: { orderId: 'order-2' },
          type: 'inbox.order.changed',
        },
      ],
      reset: false,
    });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(stream.ended(), true);
    assert.match(stream.writes.join(''), /id: 1\nevent: session\.expired/u);
    assert.doesNotMatch(stream.writes.join(''), /order-2/u);
  } finally {
    stream.request.raw.emit('close');
  }
});
