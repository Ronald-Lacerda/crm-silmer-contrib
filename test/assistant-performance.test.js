import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countOf,
  durationLabel,
  performanceDays,
  performanceSummary,
  performanceTitle,
  ratioLabel,
  windowLabel,
} from '../apps/edge-web/src/lib/assistant-performance.js';

// AGENTE-OBS-01 (RFC 041): aggregates only, synthetic numbers.
const ANSWER = Object.freeze({
  window: {
    days: 7,
    from: '2026-10-23T03:00:00.000Z',
    to: '2026-10-30T15:00:00.000Z',
  },
  conversations_with_assistant: 42,
  assistant_replies: 310,
  handoffs: {
    total: 20,
    by_reason: [
      { reason_code: 'briefing_complete', count: 9 },
      { reason_code: 'price_before_quote', count: 3 },
      { reason_code: 'negotiation', count: 2 },
      { reason_code: 'automation_failure', count: 4 },
      { reason_code: 'partnership', count: 2 },
      { reason_code: 'urgency', count: 0 },
    ],
  },
  ficha_at_handoff: { avg_ratio: 0.625, samples: 20 },
  time_to_claim_minutes: { median: 12, p90: 95, samples: 18 },
  time_to_resolve_minutes: { median: 1500, samples: 11 },
  failures: {
    workflow_failed: 2,
    send_unknown: 1,
    send_failed: 0,
    stale_fence: 3,
    transcription_failed: 1,
    automation_failure_handoffs: 4,
  },
  by_workflow_version: [
    { workflow_version: 'mvp-simple-12', turns: 280, handoffs: 17 },
    { workflow_version: 'mvp-simple-13', turns: 1, handoffs: 1 },
  ],
  stalled_now: 2,
});

test('names the page after the brand assistant', () => {
  assert.equal(performanceTitle(), 'Desempenho do agente');
});

test('reads durations in plain words, never 0 min for a missing measure', () => {
  assert.equal(durationLabel(null), '');
  assert.equal(durationLabel(undefined), '');
  assert.equal(durationLabel('x'), '');
  assert.equal(durationLabel(-3), '');
  assert.equal(durationLabel(0.2), 'menos de 1 min');
  assert.equal(durationLabel(12), '12 min');
  assert.equal(durationLabel(60), '1 h');
  assert.equal(durationLabel(95), '1 h 35 min');
  assert.equal(durationLabel(1440), '1 dia');
  assert.equal(durationLabel(1500), '1 dia 1 h');
  assert.equal(durationLabel(3 * 1440 + 120), '3 dias 2 h');
});

test('reads a ratio as a whole percentage, or nothing out of range', () => {
  assert.equal(ratioLabel(0.625), '63%');
  assert.equal(ratioLabel(0), '0%');
  assert.equal(ratioLabel(1), '100%');
  assert.equal(ratioLabel(null), '');
  assert.equal(ratioLabel(1.4), '');
  assert.equal(ratioLabel('NaN'), '');
});

test('counts only non-negative integers', () => {
  assert.equal(countOf(3), 3);
  assert.equal(countOf('4'), 4);
  assert.equal(countOf(0), 0);
  assert.equal(countOf(null), null);
  assert.equal(countOf(undefined), null);
  assert.equal(countOf(-1), null);
  assert.equal(countOf(1.5), null);
});

test('names the window the numbers belong to, from the answer', () => {
  assert.equal(windowLabel(ANSWER.window), 'Últimos 7 dias, de 23/10 a 30/10');
  assert.equal(windowLabel(null, 14), 'Últimos 14 dias');
  assert.equal(windowLabel({ days: 1 }), 'Último dia');
});

test('accepts only the offered periods', () => {
  assert.equal(performanceDays(14), 14);
  assert.equal(performanceDays('30'), 30);
  assert.equal(performanceDays(90), 7);
  assert.equal(performanceDays(undefined), 7);
});

test('summarizes a week of the agent with human reasons and times', () => {
  const summary = performanceSummary(ANSWER, 7);
  assert.equal(summary.empty, false);
  assert.equal(summary.windowLabel, 'Últimos 7 dias, de 23/10 a 30/10');
  assert.deepEqual(
    summary.totals.map((metric) => [metric.label, metric.value]),
    [
      ['Conversas com o agente', '42'],
      ['Respostas', '310'],
      ['Transferências', '20'],
      ['Paradas agora', '2'],
    ],
  );
  assert.equal(summary.totals[3].tone, 'warning');
  // Two codes with one label read as one line; a zero count is left out.
  assert.deepEqual(
    summary.reasons.map((reason) => [reason.label, reason.count, reason.share]),
    [
      ['Pré-ficha completa', 9, '45%'],
      ['Perguntou o valor', 5, '25%'],
      ['Agente falhou', 4, '20%'],
      ['Parceria ou revenda', 2, '10%'],
    ],
  );
  const [ficha, claim, resolve] = summary.timing;
  assert.equal(ficha.value, '63%');
  assert.equal(
    ficha.detail,
    'Média da ficha preenchida ao transferir (20 transferências)',
  );
  assert.equal(claim.value, '12 min');
  assert.equal(
    claim.detail,
    'Metade foi assumida em até 12 min; 9 em cada 10, em até 1 h 35 min (18 transferências)',
  );
  assert.equal(resolve.value, '1 dia 1 h');
  assert.equal(
    resolve.detail,
    'Metade foi encerrada em até 1 dia 1 h (11 conversas)',
  );
  assert.equal(summary.failureTotal, 11);
  assert.deepEqual(
    summary.failures.map((failure) => failure.count),
    [2, 0, 1, 3, 1, 4],
  );
  assert.deepEqual(
    summary.versions.map((version) => [version.version, version.detail]),
    [
      ['mvp-simple-12', '280 turnos · 17 transferências'],
      ['mvp-simple-13', '1 turno · 1 transferência'],
    ],
  );
});

test('an empty window says there are no samples, never NaN or null', () => {
  const summary = performanceSummary(
    {
      window: { days: 30 },
      conversations_with_assistant: 0,
      assistant_replies: 0,
      handoffs: { total: 0, by_reason: [] },
      ficha_at_handoff: { avg_ratio: null, samples: 0 },
      time_to_claim_minutes: { median: null, p90: null, samples: 0 },
      time_to_resolve_minutes: { median: null, samples: 0 },
      failures: {
        workflow_failed: 0,
        send_unknown: 0,
        send_failed: 0,
        stale_fence: 0,
        transcription_failed: 0,
        automation_failure_handoffs: 0,
      },
      by_workflow_version: [],
      stalled_now: 0,
    },
    30,
  );
  assert.equal(summary.empty, true);
  assert.equal(summary.windowLabel, 'Últimos 30 dias');
  assert.deepEqual(summary.reasons, []);
  assert.deepEqual(summary.versions, []);
  assert.equal(summary.failureTotal, 0);
  for (const metric of summary.timing) {
    assert.equal(metric.value, 'Sem amostras no período');
    assert.equal(metric.empty, true);
    assert.equal(metric.detail, '');
  }
  const visible = [
    summary.windowLabel,
    ...[...summary.totals, ...summary.timing].flatMap((metric) => [
      metric.label,
      metric.value,
      metric.detail,
    ]),
  ].join(' ');
  assert.doesNotMatch(visible, /NaN|null|undefined/u);
});

test('an older API without the fields reads a dash, not zero', () => {
  const summary = performanceSummary({}, 14);
  assert.equal(summary.windowLabel, 'Últimos 14 dias');
  assert.deepEqual(
    summary.totals.map((metric) => metric.value),
    ['—', '—', '—', '—'],
  );
  assert.equal(summary.failureTotal, null);
  assert.deepEqual(summary.reasons, []);
  // A version name outside the contract never reaches the page.
  assert.deepEqual(
    performanceSummary({
      by_workflow_version: [{ workflow_version: '<b>x</b>', turns: 1 }],
    }).versions,
    [],
  );
});
