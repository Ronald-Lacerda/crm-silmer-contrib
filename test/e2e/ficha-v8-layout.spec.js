/* global document, getComputedStyle */
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  TEMPLATE_V8,
  renderOrderFicha,
} from '../../modules/orders/src/print/index.js';

// FPI-08/10: the paper as Chromium prints it, with no script, for the common
// order, the longest realistic order and the limits of every field.
test.use({ javaScriptEnabled: false, viewport: { height: 1123, width: 794 } });

const { order: sample } = JSON.parse(
  await readFile(
    new URL('../../docs/phase0/ficha-pdf-synthetic-v8.json', import.meta.url),
    'utf8',
  ),
);

/** @param {string} text @param {number} [size] */
const ceiling = (text, size = 200) =>
  text.repeat(Math.ceil(size / text.length)).slice(0, size);

function commonOrder() {
  const order = structuredClone(sample);
  order.ficha.items = order.ficha.items.slice(0, 3);
  order.totalPieces = 80;
  order.ficha.observations = order.ficha.observations.slice(0, 3);
  delete order.ficha.serviceData;
  return order;
}

function worstOrder() {
  const order = structuredClone(sample);
  order.ficha.items = [order.ficha.items[3]];
  order.totalPieces = 92;
  order.ficha.observations = Array.from({ length: 5 }, (_, index) =>
    ceiling(`Observação ${index + 1} com instrução completa para a produção. `),
  );
  return order;
}

function limitOrder() {
  const order = structuredClone(sample);
  order.ficha.summary.cliente = ceiling(
    'RAZÃO SOCIAL MUITO EXTENSA DO CLIENTE ',
  );
  order.ficha.summary.nome = ceiling('Nome do pedido sem abreviação ');
  order.confirmedBy.name = ceiling('Nome composto da vendedora ');
  order.fabCode = ceiling('FAB 01 lote ');
  const long = ceiling('CAMPO NO LIMITE DO CONTRATO ');
  order.ficha.items = [
    {
      ...sample.ficha.items[0],
      tipo: long,
      cor: long,
      estampa: long,
      tipo_servico: long,
      malhas: [long],
      gola: long,
      vies_gola: long,
      vies_mangas: long,
      modelo: long,
      cor_frente: long,
      cor_costas: long,
      cor_manga_direita: long,
      cor_manga_esquerda: long,
      grade: [
        { quantidade: 4, tamanho: ceiling('TAMANHO COM RÓTULO LONGO ') },
        { quantidade: 6, tamanho: 'G' },
        { quantidade: 2, tamanho: 'GG' },
      ],
      quantidade_informada: 99,
    },
  ];
  order.totalPieces = 12;
  order.ficha.observations = Array.from({ length: 5 }, (_, index) =>
    ceiling(`Observação ${index + 1} no teto do campo. `),
  );
  order.ficha.serviceData = {
    customizations: ceiling('Personalização enorme ', 800),
    notes: ['Á'.repeat(1400), 'linha\n'.repeat(45)],
    numbers: ceiling('Numeração ', 400),
  };
  return order;
}

function manyItemsOrder() {
  const order = structuredClone(sample);
  order.ficha.items = Array.from(
    { length: 50 },
    (_, index) => sample.ficha.items[index % 4],
  );
  order.totalPieces = order.ficha.items
    .flatMap((/** @type {any} */ item) => item.grade)
    .reduce(
      (/** @type {number} */ sum, /** @type {any} */ line) =>
        sum + line.quantidade,
      0,
    );
  return order;
}

/** @param {import('@playwright/test').Page} page @param {any} order */
async function open(page, order) {
  await page.setContent(
    renderOrderFicha(order, TEMPLATE_V8, {
      printedAt: new Date('2026-11-09T17:20:00.000Z'),
    }),
    { waitUntil: 'load' },
  );
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.fonts.ready);
}

/** @param {import('@playwright/test').Page} page */
async function printedPages(page) {
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  return (pdf.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? []).length;
}

/** @param {import('@playwright/test').Page} page */
function measure(page) {
  return page.evaluate(() => {
    const blocks =
      '.head,.panel,.pt,.row,.grade-head,.dt,.fld,.check,.cap,.foot,.alert,.free,.notes,.ctrl-head';
    return [...document.querySelectorAll('.sheet')].map((sheet) => {
      const box = sheet.getBoundingClientRect();
      let smallest = 999;
      let right = 0;
      for (const element of sheet.querySelectorAll('*')) {
        if (element.closest('svg') || element.closest('caption')) continue;
        if (element.classList.contains('sr')) continue;
        const rect = element.getBoundingClientRect();
        right = Math.max(right, rect.right - box.left);
        const hasText = [...element.childNodes].some(
          (node) => node.nodeType === 3 && node.textContent?.trim(),
        );
        if (hasText) {
          smallest = Math.min(
            smallest,
            Number.parseFloat(getComputedStyle(element).fontSize),
          );
        }
      }
      const offGrid = [...sheet.querySelectorAll(blocks)]
        .filter((element) => element.getBoundingClientRect().height > 0)
        .filter((element) => {
          const top = element.getBoundingClientRect().top - box.top;
          return Math.abs(top / 4 - Math.round(top / 4)) > 0.01;
        })
        .map((element) => element.className);
      return {
        family: getComputedStyle(sheet).fontFamily.split(',')[0],
        height: box.height,
        offGrid,
        right,
        smallest,
        width: box.width,
      };
    });
  });
}

/** @param {any[]} grade */
function gradeOrder(grade) {
  const order = structuredClone(sample);
  order.ficha.items = [
    { ...sample.ficha.items[0], grade, quantidade_informada: null },
  ];
  order.ficha.observations = ['Conferir a contagem.'];
  delete order.ficha.serviceData;
  order.totalPieces = grade.reduce((sum, line) => sum + line.quantidade, 0);
  return order;
}

/** @param {number} size */
const longLabels = (size) =>
  gradeOrder(
    Array.from({ length: size }, (_, index) => ({
      quantidade: 3,
      tamanho: `Masculino adulto ${index + 1}`,
    })),
  );

const shortSizes = () =>
  gradeOrder(
    Array.from({ length: 96 }, (_, index) => ({
      quantidade: 2,
      tamanho: String(index + 1),
    })),
  );

function manySections() {
  const order = structuredClone(sample);
  const words = ceiling('palavra longa de produto repetida ');
  order.ficha.items = Array.from({ length: 12 }, () => ({
    ...sample.ficha.items[0],
    tipo: words,
    cor: words,
    estampa: words,
    tipo_servico: words,
    malhas: [words],
    gola: words,
    vies_gola: words,
    vies_mangas: words,
    modelo: words,
    cor_frente: words,
    cor_costas: words,
    cor_manga_direita: words,
    cor_manga_esquerda: words,
  }));
  order.ficha.summary.cliente = ceiling('Cliente com nome muito extenso ');
  order.ficha.summary.nome = ceiling('Nome do pedido muito extenso ');
  order.totalPieces = 480;
  return order;
}

function wideTokens() {
  const order = structuredClone(sample);
  const token = 'W'.repeat(200);
  order.ficha.items = [
    {
      ...sample.ficha.items[0],
      tipo: token,
      cor: '@'.repeat(200),
      estampa: '—'.repeat(200),
      tipo_servico: '%'.repeat(200),
      malhas: ['😀'.repeat(100)],
      gola: 'M'.repeat(200),
      modelo: '漢'.repeat(200),
    },
  ];
  order.ficha.summary.cliente = token;
  order.ficha.observations = ['&'.repeat(600), '_'.repeat(600)];
  order.totalPieces = 40;
  return order;
}

for (const [name, build, onGrid] of /** @type {const} */ ([
  ['common order', commonOrder, true],
  ['longest realistic order', worstOrder, true],
  ['every field at its limit', limitOrder, false],
  ['fifty items', manyItemsOrder, true],
  ['fifteen long size labels', () => longLabels(15), false],
  ['sixty long size labels', () => longLabels(60), false],
  ['ninety-six short sizes', shortSizes, false],
  ['many continuation sections', manySections, false],
  ['wide tokens without spaces', wideTokens, false],
])) {
  test(`FPI-10: ${name} prints one A4 page per sheet`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, build());
    const sheets = await page.locator('.sheet').count();
    expect(sheets).toBeGreaterThan(0);
    expect(await printedPages(page)).toBe(sheets);
    const loaded = await page.evaluate(() =>
      document.fonts.check('600 14px Poppins'),
    );
    expect(loaded).toBe(true);
    for (const sheet of await measure(page)) {
      expect(sheet.height).toBeLessThanOrEqual(1122.6);
      expect(sheet.right).toBeLessThanOrEqual(sheet.width);
      expect(sheet.family.replaceAll('"', '')).toBe('Poppins');
      expect(sheet.smallest).toBeGreaterThanOrEqual(13);
      if (onGrid) expect(sheet.offGrid).toEqual([]);
    }
  });
}

test('FPI-07: annotations fill what is left of the sheet', async ({ page }) => {
  await open(page, commonOrder());
  const heights = await page
    .locator('.ruled')
    .evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height));
  expect(heights.length).toBe(3);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(5 * 28);
});
