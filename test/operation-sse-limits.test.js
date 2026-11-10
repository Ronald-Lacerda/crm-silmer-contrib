import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { registerOperationRoutes } from '../apps/api/src/operation-routes.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

// Written out on purpose: changing either limit must fail here.
const STREAMS_PER_MINUTE = 60;
const STREAM_CAPACITY = 30;

function forbidden() {
  return Object.assign(new Error('FORBIDDEN'), {
    code: 'FORBIDDEN',
    statusCode: 403,
  });
}

/** Route handler with no rate limiter, so only the capacity rule applies. */
function capacityHarness() {
  /** @type {any} */
  let handler;
  let allowed = true;
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
        if (!allowed) throw forbidden();
        return { actor: { id: 'operator-1' } };
      },
      async readLiveEvents() {
        return { cursor: 0, events: [], reset: false };
      },
    },
    () => ({ correlationId: 'test', requestId: 'test' }),
  );
  /** @type {ReturnType<typeof attempt>[]} */
  const attempts = [];

  function attempt() {
    const state = {
      /** @type {unknown} */
      body: undefined,
      /** @type {Record<string, string>} */
      headers: {},
      hijacked: false,
      /** @type {number|undefined} */
      statusCode: undefined,
      /** @type {number|undefined} */
      streamStatus: undefined,
    };
    const request = {
      headers: {},
      query: { after: '0', topic: 'inbox' },
      raw: new EventEmitter(),
    };
    const reply = {
      /** @param {number} statusCode */
      code(statusCode) {
        state.statusCode = statusCode;
        return reply;
      },
      hijack() {
        state.hijacked = true;
      },
      /** @param {string} name @param {string} value */
      header(name, value) {
        state.headers[name] = value;
        return reply;
      },
      raw: Object.assign(new EventEmitter(), {
        end() {},
        write() {},
        /** @param {number} statusCode */
        writeHead(statusCode) {
          state.streamStatus = statusCode;
        },
      }),
      /** @param {unknown} body */
      send(body) {
        state.body = body;
        return reply;
      },
    };
    return { reply, request, state };
  }

  return {
    allow() {
      allowed = true;
    },
    deny() {
      allowed = false;
    },
    /** Ends every stream so no heartbeat or poll timer outlives the test. */
    closeAll() {
      for (const stream of attempts) stream.request.raw.emit('close');
    },
    async open() {
      const stream = attempt();
      attempts.push(stream);
      await handler(stream.request, stream.reply);
      return stream;
    },
  };
}

/** @param {{state: {hijacked: boolean, streamStatus?: number}}} stream */
function assertStreaming(stream) {
  assert.equal(stream.state.hijacked, true);
  assert.equal(stream.state.streamStatus, 200);
}

/** @param {{state: any}} stream */
function assertCapacityRejected(stream) {
  assert.equal(stream.state.statusCode, 429);
  assert.deepEqual(stream.state.body, {
    error: { code: 'SSE_CAPACITY_EXCEEDED' },
  });
  assert.equal(stream.state.headers['retry-after'], '1');
  assert.equal(stream.state.hijacked, false);
  assert.equal(stream.state.streamStatus, undefined);
}

/** @param {ReturnType<typeof capacityHarness>} harness @param {number} count */
async function openStreams(harness, count) {
  const streams = [];
  for (let index = 0; index < count; index += 1) {
    const stream = await harness.open();
    assertStreaming(stream);
    streams.push(stream);
  }
  return streams;
}

test('the real rate limiter refuses the 61st stream opening of a minute', async () => {
  let authorizations = 0;
  const api = createApi(
    {},
    {
      logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      operations: {
        // A hijacked reply never finishes under inject, so these openings are
        // refused by authorization, which runs after the limiter has counted.
        async authorizeRead() {
          authorizations += 1;
          throw forbidden();
        },
      },
    },
  );
  try {
    /** @param {string} remoteAddress */
    const open = (remoteAddress) =>
      api.inject({
        method: 'GET',
        remoteAddress,
        url: '/api/v1/events?after=0&topic=inbox',
      });

    for (let index = 0; index < STREAMS_PER_MINUTE; index += 1) {
      const allowed = await open('198.51.100.10');
      assert.equal(allowed.statusCode, 403, `opening ${index + 1}`);
    }
    const limited = await open('198.51.100.10');
    assert.equal(limited.statusCode, 429);
    assert.equal(
      limited.headers['x-ratelimit-limit'],
      String(STREAMS_PER_MINUTE),
    );
    assert.equal(limited.headers['x-ratelimit-remaining'], '0');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.notEqual(limited.json().error?.code, 'SSE_CAPACITY_EXCEEDED');
    assert.equal(authorizations, STREAMS_PER_MINUTE);

    const otherClient = await open('198.51.100.11');
    assert.equal(otherClient.statusCode, 403);
  } finally {
    await api.close();
  }
});

test('the 31st concurrent stream is refused without taking over the reply', async () => {
  const harness = capacityHarness();
  try {
    await openStreams(harness, STREAM_CAPACITY);
    assertCapacityRejected(await harness.open());
  } finally {
    harness.closeAll();
  }
});

for (const side of /** @type {const} */ (['request', 'reply'])) {
  test(`closing the ${side} side of a stream frees its slot`, async () => {
    const harness = capacityHarness();
    try {
      const streams = await openStreams(harness, STREAM_CAPACITY);
      assertCapacityRejected(await harness.open());

      streams[0]?.[side].raw.emit('close');

      assertStreaming(await harness.open());
      assertCapacityRejected(await harness.open());
    } finally {
      harness.closeAll();
    }
  });
}

test('a stream closed on both sides frees only one slot', async () => {
  const harness = capacityHarness();
  try {
    const streams = await openStreams(harness, STREAM_CAPACITY);

    streams[0]?.request.raw.emit('close');
    streams[0]?.reply.raw.emit('close');

    assertStreaming(await harness.open());
    assertCapacityRejected(await harness.open());
  } finally {
    harness.closeAll();
  }
});

test('refused readers consume no stream capacity', async () => {
  const harness = capacityHarness();
  try {
    harness.deny();
    for (let index = 0; index <= STREAM_CAPACITY; index += 1) {
      await assert.rejects(harness.open(), { code: 'FORBIDDEN' });
    }

    harness.allow();
    await openStreams(harness, STREAM_CAPACITY);
    assertCapacityRejected(await harness.open());
  } finally {
    harness.closeAll();
  }
});

test('a refused reader learns nothing about a full stream pool', async () => {
  const harness = capacityHarness();
  try {
    await openStreams(harness, STREAM_CAPACITY);

    harness.deny();
    await assert.rejects(harness.open(), { code: 'FORBIDDEN' });
  } finally {
    harness.closeAll();
  }
});
