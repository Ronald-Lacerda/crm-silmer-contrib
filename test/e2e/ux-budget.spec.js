import { expect, test } from '@playwright/test';

import {
  mockOrders,
  confirmedOrder,
  extraPending,
  pendingOrder,
} from './support/orders-mock.js';
import { mockPainel } from './support/painel-mock.js';
import {
  MAIN,
  NOTEBOOK,
  PHONE,
  expectBudget,
  expectOnePrimaryPerRegion,
  listControls,
  mockInbox,
} from './support/ux-budget.js';

// T132 (RFC 024, ADR 036, design.md §16 "Metas de controles na primeira
// tela"): o orçamento de controles por região, em 390×844 com toque e em
// 1366×768, com dados sintéticos. Quem quebrar um orçamento recebe a lista
// dos controles contados; aumente o limite só com uma decisão registrada.

const TODAY = new Date('2026-10-15T12:00:00-03:00');
// O mesmo instante das filas sintéticas: os tempos de espera ("há 25 min")
// não mudam a quebra de linha e, com ela, o que cabe na primeira tela.
const QUEUE_TIME = new Date('2026-10-15T15:00:00.000Z');

/**
 * Registra o que foi medido no relatório do teste.
 *
 * @param {string} label @param {string[]} controls @param {number} budget
 */
function record(label, controls, budget) {
  test.info().annotations.push({
    description: `${controls.length} de ${budget}: ${controls.join('; ')}`,
    type: label,
  });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} label @param {import('./support/ux-budget.js').Measure} measure
 * @param {number} budget
 */
async function budget(page, label, measure, budget) {
  const controls = await expectBudget(page, label, measure, budget);
  record(label, controls, budget);
  return controls;
}

// Orçamentos: as metas do RFC 024 (design.md §16). Medido em 15/10/2026 sobre
// `ux/jornadas`, com estes dados, entre parênteses: tudo ficou dentro da
// meta, então vale a meta do RFC. O Painel não tem meta no RFC: o limite é o
// medido + 1 (PNL-01, "mantém o medido ±1").
const SCREENS = [
  {
    budgets: {
      caixaPrimeiraTela: 15, // (10)
      conversaAntes: 9, // (3)
      // INBOX-UX-03: approved name→Cadastro action plus order/takeover,
      // details and More; secondary actions remain on demand in both sizes.
      conversaCabecalho: 4,
      conversaDepois: 12, // (7)
      editar: 1, // (1)
      // ACT-01: four filters + five interactive queue objects, no inline commands.
      painel: { gestor: 11, vendedor: 9 },
      pedidoPrimeiraTela: 12, // (5; documento com 1.646 px)
      pedidosPrimeiraTela: 12, // (7)
    },
    name: 'celular 390×844',
    phone: true,
  },
  {
    budgets: {
      caixaPrimeiraTela: 24, // (17)
      conversaAntes: 24, // (12)
      // INBOX-UX-03: the same four compact header actions as on the phone.
      conversaCabecalho: 4,
      conversaDepois: 24, // (17)
      editar: 5, // (5)
      // ACT-01: queue 9 + selected detail 3 + performance period/expander 2.
      painel: { gestor: 12, vendedor: 14 },
      pedidoPrimeiraTela: 16, // (6)
      pedidosPrimeiraTela: 19, // (10)
    },
    name: 'notebook 1366×768',
    phone: false,
  },
];

for (const screen of SCREENS) {
  test.describe(screen.name, () => {
    test.use(
      screen.phone
        ? { hasTouch: true, viewport: PHONE }
        : { viewport: NOTEBOOK },
    );

    test('PCX-14: a Caixa cabe no orçamento da barra de filtros e da primeira tela', async ({
      page,
    }) => {
      await page.clock.setFixedTime(QUEUE_TIME);
      await mockInbox(page);
      await page.goto('/inbox');
      await expect(
        page
          .locator('.inbox-list')
          .getByRole('button', { name: /Cliente Sintético 1/u }),
      ).toBeVisible();
      await expect(page.locator('.inbox-list-summary')).not.toHaveText(
        'Carregando conversas…',
      );
      // No notebook a primeira conversa abre ao lado da fila, com a resposta.
      if (!screen.phone)
        await expect(
          page.getByLabel('Responder', { exact: true }),
        ).toBeVisible();

      await budget(
        page,
        'Caixa: barra de filtros',
        { selector: '.inbox-toolbar, .inbox-search' },
        // RFC 052: quatro abas, a busca e Filtros.
        6,
      );
      await budget(
        page,
        'Caixa: primeira tela',
        { firstScreen: true, selector: MAIN },
        screen.budgets.caixaPrimeiraTela,
      );
      await expectOnePrimaryPerRegion(page);
    });

    test('PCX-13: antes de assumir, a conversa tem só "Assumir atendimento" como primária', async ({
      page,
    }) => {
      await page.clock.setFixedTime(QUEUE_TIME);
      await mockInbox(page);
      for (const state of ['handoff', 'agent']) {
        await page.goto(`/inbox/conversation-${state}`);
        const takeOver = page
          .locator('.conv-actions')
          .getByRole('button', { name: 'Assumir atendimento' });
        await expect(takeOver).toBeVisible();

        const primaries = await expectOnePrimaryPerRegion(page);
        expect(primaries.main).toEqual(['button "Assumir atendimento"']);
        await budget(
          page,
          `Conversa (${state}): cabeçalho`,
          { exclude: '.conv-back', selector: '.conv-head' },
          screen.budgets.conversaCabecalho,
        );
        await budget(
          page,
          `Conversa (${state}): primeira tela antes de assumir`,
          { firstScreen: true, selector: MAIN },
          screen.budgets.conversaAntes,
        );
      }
    });

    test('PCX-13: com o vendedor dono, a única primária é "Enviar resposta"', async ({
      page,
    }) => {
      await page.clock.setFixedTime(QUEUE_TIME);
      await mockInbox(page);
      for (const state of ['owner', 'owner-order']) {
        await page.goto(`/inbox/conversation-${state}`);
        await expect(
          page.getByLabel('Responder', { exact: true }),
        ).toBeVisible();
        await expect(
          page
            .locator('.conv-head')
            .getByRole(state === 'owner' ? 'button' : 'link', {
              name: state === 'owner' ? 'Criar pedido' : /Abrir pedido 21-CRM/u,
            }),
        ).toBeVisible();

        const primaries = await expectOnePrimaryPerRegion(page);
        expect(primaries.main).toEqual(['button "Enviar resposta"']);
        await budget(
          page,
          `Conversa (${state}): cabeçalho`,
          { exclude: '.conv-back', selector: '.conv-head' },
          screen.budgets.conversaCabecalho,
        );
        await budget(
          page,
          `Conversa (${state}): primeira tela depois de assumir`,
          { firstScreen: true, selector: MAIN },
          screen.budgets.conversaDepois,
        );
      }
    });

    test('PLI-09/PLI-10: Pedidos cabe no orçamento da barra de filtros e da primeira tela', async ({
      page,
    }) => {
      await page.clock.setFixedTime(TODAY);
      await mockOrders(page, {
        orders: [pendingOrder, extraPending, confirmedOrder],
      });
      await page.goto('/pedidos');
      const first = page.locator('.order-table tbody tr').first();
      await expect(first).toBeVisible();
      await expect(page.locator('.filter-summary')).not.toBeEmpty();

      await budget(
        page,
        'Pedidos: barra de filtros',
        { selector: '.orders-filter-bar' },
        5,
      );
      await budget(
        page,
        'Pedidos: primeira tela',
        { firstScreen: true, selector: MAIN },
        screen.budgets.pedidosPrimeiraTela,
      );
      await expectOnePrimaryPerRegion(page);

      if (screen.phone) {
        // O primeiro cartão inteiro acima da barra inferior.
        const card = await first.boundingBox();
        const bar = await page
          .getByRole('navigation', { name: 'Navegação móvel' })
          .boundingBox();
        expect((card?.y ?? 0) + (card?.height ?? Infinity)).toBeLessThanOrEqual(
          bar?.y ?? 0,
        );
      }
    });

    test('PFI-15 a PFI-19: o pedido pendente com um item cabe no orçamento', async ({
      page,
    }) => {
      await page.clock.setFixedTime(TODAY);
      await mockOrders(page, { orders: [pendingOrder] });
      await page.goto('/pedidos/order-pendente');
      await expect(
        page.getByRole('heading', { name: 'Pedido 07-CRM' }),
      ).toBeFocused();
      const progress = page.getByRole('region', {
        name: 'Para gerar o pedido',
      });
      await expect(progress.getByRole('status')).toHaveText(
        /Tudo pronto para gerar/u,
      );
      if (screen.phone) {
        await expect(
          page
            .getByRole('region', { name: 'Resumo do pedido' })
            .getByRole('button', { name: /^Resumo do pedido/u }),
        ).toHaveAttribute('aria-expanded', 'true');
      }

      const buttons = await listControls(page, {
        outsideDialogs: true,
        selector: MAIN,
        within: 'button',
      });
      const edits = buttons.filter((name) => /^button "Editar/u.test(name));
      record('Pedido: botões "Editar"', edits, screen.budgets.editar);
      expect(
        edits.length,
        `"Editar" visíveis: ${edits.join('; ')}`,
      ).toBeLessThanOrEqual(screen.budgets.editar);

      await budget(
        page,
        'Pedido: primeira tela',
        { firstScreen: true, selector: MAIN },
        screen.budgets.pedidoPrimeiraTela,
      );
      const primaries = await expectOnePrimaryPerRegion(page);
      expect(primaries.main).toEqual(['button "Gerar pedido"']);

      if (screen.phone) {
        const height = await page.evaluate(
          () => globalThis.document.documentElement.scrollHeight,
        );
        record('Pedido: altura do documento', [`${height} px`], 1800);
        expect(height).toBeLessThanOrEqual(1800);
      }

      // PFI-19: o diálogo "Gerar o pedido" é outra região, com uma primária.
      await page
        .getByRole('button', { name: 'Gerar pedido' })
        .and(page.locator(':visible'))
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Gerar o pedido 07-CRM?',
      });
      await expect(dialog).toBeVisible();
      const withDialog = await expectOnePrimaryPerRegion(page);
      expect(Object.values(withDialog)).toEqual([
        ['button "Gerar pedido"'],
        ['button "Confirmar e gerar ficha"'],
      ]);
    });

    for (const manager of [false, true]) {
      test(`ACT-01/PNL-01: a central do ${manager ? 'gestor' : 'vendedor'} mantém ações sob demanda`, async ({
        page,
      }) => {
        await page.clock.setFixedTime(QUEUE_TIME);
        await mockPainel(page, { manager });
        await page.goto('/dashboard');
        if (manager) {
          await expect(
            page.getByRole('region', { name: 'Desempenho da equipe' }),
          ).toBeVisible();
          await budget(
            page,
            'Painel: Próximo passo',
            { selector: '.next-step' },
            1,
          );
        } else {
          const actions = page.getByRole('region', {
            name: 'O que precisa de você',
          });
          await expect(
            actions.getByRole('button', { name: 'Tudo 5', exact: true }),
          ).toBeVisible();
          await expect(
            actions.getByRole('button', {
              name: 'Registrar pagamento',
              exact: true,
            }),
          ).toHaveCount(0);
          await budget(
            page,
            'Painel: filtros da central',
            { selector: '.dashboard-action-filters' },
            4,
          );
        }
        await budget(
          page,
          'Painel: primeira tela',
          { firstScreen: true, selector: MAIN },
          screen.budgets.painel[manager ? 'gestor' : 'vendedor'],
        );
        await expectOnePrimaryPerRegion(page);
      });
    }
  });
}
