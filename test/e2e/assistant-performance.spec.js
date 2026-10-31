import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { mockPainel } from './support/painel-mock.js';

// AGENTE-OBS-01 (RFC 041): "Desempenho do agente", opened from the agent's
// card of the manager's Dashboard. Aggregates only; synthetic numbers.

/** @param {number} days */
function performance(days) {
  return {
    window: {
      days,
      from:
        days === 7 ? '2026-10-08T03:00:00.000Z' : '2026-10-01T03:00:00.000Z',
      to: '2026-10-15T15:00:00.000Z',
    },
    conversations_with_assistant: days * 6,
    assistant_replies: days * 40,
    handoffs: {
      total: 10,
      by_reason: [
        { reason_code: 'briefing_complete', count: 5 },
        { reason_code: 'automation_failure', count: 3 },
        { reason_code: 'partnership', count: 2 },
      ],
    },
    ficha_at_handoff: { avg_ratio: 0.7, samples: 10 },
    time_to_claim_minutes: { median: 14, p90: 70, samples: 9 },
    time_to_resolve_minutes: { median: null, samples: 0 },
    failures: {
      workflow_failed: 1,
      send_unknown: 0,
      send_failed: 2,
      stale_fence: 0,
      transcription_failed: 0,
      automation_failure_handoffs: 3,
    },
    by_workflow_version: [
      { workflow_version: 'mvp-simple-12', turns: 120, handoffs: 10 },
    ],
    stalled_now: 1,
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{manager?: boolean, answer?: (days: number, call: number) => {status?: number, body: unknown}}} [options]
 */
async function setup(page, options = {}) {
  const mock = await mockPainel(page, { manager: options.manager ?? true });
  /** @type {number[]} */
  const requests = [];
  // Registered last, so it answers before the Painel mock.
  await page.route('**/api/v1/inbox/assistant/performance**', (route) => {
    const days = Number(
      new URL(route.request().url()).searchParams.get('days'),
    );
    requests.push(days);
    const { status = 200, body } = options.answer?.(days, requests.length) ?? {
      body: performance(days),
    };
    return route.fulfill({
      body: JSON.stringify(body),
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      status,
    });
  });
  return { ...mock, requests };
}

test('the manager opens the agent performance from its card, by keyboard', async ({
  page,
}) => {
  const { requests } = await setup(page);
  await page.goto('/dashboard');
  const link = page.getByRole('link', { name: 'Ver desempenho do agente' });
  await expect(link).toBeVisible();
  // The card stays one link of its own; the new link is not inside it.
  await expect(
    page.getByRole('link', { name: /^Assistente Pede atenção/u }),
  ).toBeVisible();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/dashboard/agente');

  const heading = page.getByRole('heading', {
    level: 1,
    name: 'Desempenho do agente',
  });
  await expect(heading).toBeFocused();
  const main = page.locator('#main-content');
  await expect(main).toContainText('Últimos 7 dias, de 08/10 a 15/10');
  await expect(main).toContainText('Conversas com o agente');
  await expect(main).toContainText('42');
  const reasons = page.getByRole('region', {
    name: 'Transferências por motivo',
  });
  await expect(reasons.getByRole('listitem')).toHaveText([
    'Pré-ficha completa 5 · 50%',
    'Agente falhou 3 · 30%',
    'Parceria ou revenda 2 · 20%',
  ]);
  const timing = page.getByRole('region', { name: 'Ficha e tempos' });
  await expect(timing).toContainText('70%');
  await expect(timing).toContainText('14 min');
  await expect(timing).toContainText('9 em cada 10, em até 1 h 10 min');
  await expect(timing).toContainText('Sem amostras no período');
  await expect(page.getByRole('region', { name: 'Falhas' })).toContainText(
    'Envios que falharam 2',
  );
  await expect(
    page.getByRole('region', { name: 'Versões do workflow' }),
  ).toContainText('mvp-simple-12 120 turnos · 10 transferências');
  await expect(main).not.toContainText(/NaN|null|undefined/u);

  // The period changes by keyboard and the focus stays on the option.
  const period = page.getByRole('group', { name: 'Período' });
  await expect(period.getByRole('button', { name: '7 dias' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const fourteen = period.getByRole('button', { name: '14 dias' });
  await fourteen.focus();
  await page.keyboard.press('Enter');
  await expect(main).toContainText('Últimos 14 dias, de 01/10 a 15/10');
  await expect(fourteen).toHaveAttribute('aria-pressed', 'true');
  await expect(fourteen).toBeFocused();
  await expect(main.getByRole('status')).toHaveText(
    'Últimos 14 dias, de 01/10 a 15/10: desempenho atualizado.',
  );
  expect(requests).toEqual([7, 14]);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('a failed change of period keeps the numbers and names their window', async ({
  page,
}) => {
  let fail = true;
  await setup(page, {
    answer: (days) =>
      days === 30 && fail
        ? { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
        : { body: performance(days) },
  });
  await page.goto('/dashboard/agente');
  const main = page.locator('#main-content');
  await expect(main).toContainText('Últimos 7 dias, de 08/10 a 15/10');
  await page
    .getByRole('group', { name: 'Período' })
    .getByRole('button', { name: '30 dias' })
    .click();
  const alert = main.getByRole('alert');
  await expect(alert).toContainText(
    'Não foi possível atualizar para 30 dias. Os números abaixo continuam sendo de últimos 7 dias, de 08/10 a 15/10.',
  );
  await expect(main).toContainText('42');
  fail = false;
  await alert.getByRole('button', { name: 'Tentar novamente' }).press('Enter');
  await expect(main.getByRole('alert')).toHaveCount(0);
  await expect(main).toContainText('Últimos 30 dias');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Desempenho do agente' }),
  ).toBeFocused();
});

test('an empty window and a first failure read in plain words', async ({
  page,
}) => {
  let call = 0;
  await setup(page, {
    answer: (days) => {
      call += 1;
      if (call === 1) return { status: 503, body: {} };
      return {
        body: {
          window: { days },
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
      };
    },
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/dashboard/agente');
  const main = page.locator('#main-content');
  await expect(
    main.getByRole('heading', { level: 2, name: 'Desempenho indisponível' }),
  ).toBeVisible();
  await main.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(main).toContainText(
    'Últimos 7 dias · Nenhuma conversa com o agente neste período.',
  );
  await expect(main).toContainText('Nenhuma transferência no período.');
  await expect(main).toContainText('Nenhuma falha no período.');
  await expect(main).toContainText(
    'Nenhuma versão registrou turnos no período.',
  );
  await expect(main.getByText('Sem amostras no período')).toHaveCount(3);
  await expect(main).not.toContainText(/NaN|null|undefined/u);
  // Mobile-first (ADR 035): nothing scrolls sideways on a phone.
  const overflow = await page.evaluate(
    () =>
      globalThis.document.documentElement.scrollWidth >
      globalThis.document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('a seller does not see the agent performance', async ({ page }) => {
  const { requests } = await setup(page, { manager: false });
  await page.goto('/dashboard/agente');
  await expect(page).toHaveURL('/dashboard');
  await expect(
    page.getByRole('link', { name: 'Ver desempenho do agente' }),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
});
