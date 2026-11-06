import assert from 'node:assert/strict';
import test from 'node:test';
import { operationalSummary } from '../apps/edge-web/src/lib/operational-summary.js';

const now = Date.parse('2026-11-06T13:42:00Z');
const healthy = {
  status: 'ok',
  checkedAt: new Date(now).toISOString(),
  checks: { worker: 'ok', queue: 'ok', commands: 'ok' },
};

test('OPSUI-02: healthy summary has three meaningful signals and no investigation noise', () => {
  const result = operationalSummary(healthy, { now });
  assert.equal(result.state, 'healthy');
  assert.equal(result.title, 'Operação saudável');
  assert.deepEqual(
    result.signals.map((s) => s.value),
    ['Ativo', 'Sem atraso', 'Sem bloqueios'],
  );
  assert.deepEqual(result.guidance, []);
});

test('OPSUI-02: degraded snapshot preserves good signals and directs investigation', () => {
  const result = operationalSummary(
    {
      ...healthy,
      status: 'degraded',
      checks: { ...healthy.checks, queue: 'degraded' },
    },
    { now },
  );
  assert.equal(result.state, 'degraded');
  assert.deepEqual(
    result.signals.map((s) => s.state),
    ['ok', 'degraded', 'ok'],
  );
  assert.equal(result.signals[1].value, 'Atrasada');
  assert.deepEqual(result.guidance, [
    'Confira tarefas aguardando processamento há mais de 5 minutos.',
  ]);
});

test('OPSUI-02: stale, malformed, unavailable and failed reads never present healthy operation', () => {
  for (const data of [
    null,
    {},
    { status: 'unavailable' },
    { ...healthy, checkedAt: new Date(now - 120_001).toISOString() },
    { ...healthy, checkedAt: 'invalid' },
    { ...healthy, checks: { worker: 'ok' } },
    { ...healthy, status: 'other' },
    {
      ...healthy,
      status: 'ok',
      checks: { ...healthy.checks, worker: 'degraded' },
    },
  ]) {
    const result = operationalSummary(data, { now });
    assert.equal(result.state, 'unavailable');
    assert.equal(
      result.signals.every((s) => s.value === 'Sem leitura'),
      true,
    );
  }
  assert.equal(
    operationalSummary(healthy, { now, failed: true }).state,
    'unavailable',
  );
  assert.equal(
    operationalSummary(healthy, { now: now + 120_000 }).state,
    'healthy',
  );
});
