import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PRODUCTION_FIELDS_V8,
  renderFichaHtmlV8,
} from '../modules/orders/src/print/ficha-canonical-v8.js';
import {
  planFicha,
  splitNotes,
  textLines,
} from '../modules/orders/src/print/ficha-v8-pages.js';
import {
  PRINT_TEMPLATE,
  TEMPLATE_V6,
  TEMPLATE_V7,
  TEMPLATE_V8,
  renderOrderFicha,
} from '../modules/orders/src/print/index.js';
import { printSnapshot } from '../modules/orders/src/print/print-snapshot.js';
import {
  fichaV8Approved,
  validateFichaReviewV8,
} from '../scripts/ficha-pdf-review-v8.mjs';
import { validateFichaPrintSwitch } from '../scripts/ficha-pdf-review.mjs';

const root = new URL('../', import.meta.url);
/** @param {string} path */
const read = async (path) =>
  JSON.parse(await readFile(new URL(path, root), 'utf8'));
const sample = await read('docs/phase0/ficha-pdf-synthetic-v8.json');
const shortOrder = () => {
  const order = structuredClone(sample.order);
  order.ficha.items = order.ficha.items.slice(0, 3);
  order.totalPieces = 80;
  order.ficha.observations = order.ficha.observations.slice(0, 3);
  delete order.ficha.serviceData;
  return order;
};
/** @param {string} html */
const sheets = (html) => html.split(/(?=<article class="sheet)/u).slice(1);
/** @param {string} html */
const visible = (html) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/gu, '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ');

test('FPI-01: each item gets one sheet, with the order data repeated', () => {
  const html = renderOrderFicha(shortOrder(), TEMPLATE_V8);
  const pages = sheets(html);
  assert.equal(pages.length, 3);
  for (const [index, page] of pages.entries()) {
    const text = visible(page);
    assert.ok(text.includes(`Item ${index + 1} de 3`));
    assert.ok(text.includes('128-CRM'));
    assert.ok(text.includes('Associação Atlética Exemplo'));
    assert.ok(text.includes('Uniformes temporada 2027'));
    assert.ok(text.includes('20/11/2026'));
    assert.ok(text.includes('30/10/2026'));
    assert.ok(text.includes('Controle de produção'));
    assert.ok(text.includes(`Folha ${index + 1} de 3`));
  }
  assert.doesNotMatch(html, /Lastro do pedido/u);
});

test('FPI-05/06: the item points use Modelo and the old field is the model detail', () => {
  const order = shortOrder();
  order.ficha.items[0].tipo = 'TIPO_SENTINELA';
  order.ficha.items[0].modelo = 'DETALHE_SENTINELA';
  const text = visible(renderOrderFicha(order, TEMPLATE_V8));
  assert.match(text, /1 ?Modelo TIPO_SENTINELA/u);
  assert.match(text, /Detalhe do modelo DETALHE_SENTINELA/u);
  assert.doesNotMatch(text, /Tipo de roupa/u);
  assert.match(text, /5 ?Modelo de malha/u);
});

test('FPI-07: only the seven production fields stay, blank', () => {
  const order = shortOrder();
  order.ficha.items = order.ficha.items.slice(0, 1);
  const html = renderOrderFicha(order, TEMPLATE_V8);
  assert.equal(
    (html.match(/campo-producao-vazio/gu) ?? []).length,
    PRODUCTION_FIELDS_V8.length,
  );
  assert.equal(PRODUCTION_FIELDS_V8.length, 7);
  const snapshot = printSnapshot(order, TEMPLATE_V8);
  assert.deepEqual(Object.keys(snapshot.producao), [...PRODUCTION_FIELDS_V8]);
  assert.ok(Object.values(snapshot.producao).every((value) => value === ''));
  assert.doesNotMatch(html, /Cores da arte|cores_frente|Total das partes/u);
  for (const label of [
    'Conferido para arrematar',
    'Arrematado',
    'Conferido / Embalado',
    'OBS arremate',
  ]) {
    assert.ok(html.includes(label), label);
  }
  // The stored production keys of older templates are unchanged.
  assert.equal(
    Object.keys(printSnapshot(order, TEMPLATE_V6).producao).length,
    14,
  );
});

test('FPI-03: the grade has a blank count row and each point its own check box', () => {
  const order = shortOrder();
  order.ficha.items = order.ficha.items.slice(0, 1);
  const html = renderOrderFicha(order, TEMPLATE_V8);
  assert.equal((html.match(/class="check"/gu) ?? []).length, 7);
  assert.match(
    html,
    /<tr class="k"><th scope="row">Conferido<\/th>(<td><\/td>)+/u,
  );
  assert.ok(html.includes('Escrever a contagem em Conferido'));
});

test('FPI-03: sixteen short sizes stay in one block, more open another', () => {
  const order = shortOrder();
  order.ficha.items = [structuredClone(sample.order.ficha.items[3])];
  const one = renderOrderFicha(order, TEMPLATE_V8);
  assert.equal((one.match(/<tr class="k">/gu) ?? []).length, 1);
  order.ficha.items[0].grade.push({ tamanho: '18', quantidade: 1 });
  const two = renderOrderFicha(order, TEMPLATE_V8);
  assert.equal((two.match(/<tr class="k">/gu) ?? []).length, 2);
  assert.equal(sheets(two).length >= 1, true);
});

test('FPI-04: a quantity that differs from the sizes is flagged', () => {
  const html = renderOrderFicha(shortOrder(), TEMPLATE_V8);
  const [first, second] = sheets(html);
  assert.ok(visible(first).includes('Informada 42'));
  assert.ok(
    visible(first).includes(
      'Quantidade divergente: informada 42, grade soma 40. Confirmar antes de produzir.',
    ),
  );
  assert.ok(!visible(second).includes('Quantidade divergente'));
});

test('FPI-02/10: every sheet carries notes and overflow goes to a full, numbered extra sheet', () => {
  const order = structuredClone(sample.order);
  const html = renderOrderFicha(order, TEMPLATE_V8);
  const pages = sheets(html);
  assert.equal(pages.length, 5);
  for (const page of pages.slice(0, 4)) {
    const kept = (page.match(/<li value=/gu) ?? []).length;
    assert.ok(kept > 0, 'each item sheet keeps at least one observation');
    assert.ok(
      visible(page).includes(
        `Continua na folha de observações (folha 5 de 5): mais ${14 - kept} observações`,
      ),
    );
  }
  const extra = pages[4];
  assert.ok(extra.includes('class="sheet extra'));
  assert.ok(visible(extra).includes('Observações do pedido'));
  assert.equal((extra.match(/<li value=/gu) ?? []).length, 14);
  for (const note of order.ficha.observations) {
    assert.ok(visible(extra).includes(note), note);
  }
  assert.ok(visible(extra).includes('informação complementar do atendimento'));
  assert.ok(visible(extra).includes('Anotações (continuação)'));
  assert.ok(visible(pages[0]).includes('Anotações (continua na folha 5 de 5)'));
  assert.ok(visible(extra).includes('Folha 5 de 5'));
});

test('FPI-02: a short order needs no extra sheet', () => {
  const html = renderOrderFicha(shortOrder(), TEMPLATE_V8);
  assert.ok(!html.includes('sheet extra'));
  assert.ok(!html.includes('Continua na folha de observações'));
});

test('FPI-10: long notes keep every character, split between sheets', () => {
  const notes = [
    'Á'.repeat(2500),
    'linha\n'.repeat(45),
    ...Array.from({ length: 40 }, (_, i) => `Instrução ${i}: conferir tudo.`),
  ];
  const pieces = splitNotes(notes);
  assert.equal(pieces.join(''), notes.join(''));
  const order = shortOrder();
  order.ficha.observations = notes;
  const html = renderOrderFicha(order, TEMPLATE_V8);
  const pages = sheets(html);
  assert.ok(pages.length > 4);
  const extras = pages.filter((page) => page.includes('sheet extra'));
  const printed = extras.flatMap((page) =>
    [...page.matchAll(/<li value="(\d+)">([\s\S]*?)<\/li>/gu)].map((match) =>
      Number(match[1]),
    ),
  );
  assert.deepEqual(
    printed,
    Array.from({ length: pieces.length }, (_, index) => index + 1),
  );
});

test('FPI-10: an item too long for its sheet continues with a printed notice', () => {
  const order = shortOrder();
  const huge = 'Texto longo do item no limite do campo '
    .repeat(6)
    .slice(0, 200);
  const [base] = order.ficha.items;
  order.ficha.items = [
    {
      ...base,
      tipo: huge,
      cor: huge,
      estampa: huge,
      tipo_servico: huge,
      malhas: [huge],
      gola: huge,
      vies_gola: huge,
      vies_mangas: huge,
      modelo: huge,
      cor_frente: huge,
      cor_costas: huge,
      cor_manga_direita: huge,
      cor_manga_esquerda: huge,
    },
  ];
  order.ficha.summary.cliente = huge;
  order.ficha.summary.nome = huge;
  const html = renderOrderFicha(order, TEMPLATE_V8);
  const pages = sheets(html);
  assert.ok(pages.length >= 2);
  assert.ok(visible(pages[0]).includes('Parte dos dados deste item continua'));
  assert.ok(
    pages.slice(1).some((page) => page.includes('Item 1 · continuação')),
  );
  assert.equal((html.match(/class="check"/gu) ?? []).length, 7);
});

test('FPI-09: money, billing and payment day stay off the paper', () => {
  const order = structuredClone(sample.order);
  Object.assign(order, {
    finalAmountCents: 99887766,
    paymentCondition: 'FINANCEIRO_SECRETO',
    paidOn: '2024-01-31',
    billing: { url: 'COBRANCA_SECRETA' },
    olist: { id: 'ERP_SECRETO' },
  });
  order.ficha.serviceData.billing = { amount: 'COBRANCA_SECRETA' };
  order.ficha.items[0].grade[0].subtotalCents = 88776655;
  const html = renderOrderFicha(order, TEMPLATE_V8);
  assert.doesNotMatch(
    html,
    /99887766|88776655|FINANCEIRO_SECRETO|COBRANCA_SECRETA|ERP_SECRETO|31\/01\/2024|Pago em/u,
  );
  assert.equal(
    /** @type {any} */ (printSnapshot(order, TEMPLATE_V8).pedido.lastro)
      .pagamento,
    undefined,
  );
});

test('FPI-09: explicit financial text blocks the paper with 422', () => {
  for (const note of [
    'Separar etiquetas. R$ 500',
    'Valor pago: 500',
    'Cobrança no Pix',
    '500 reais',
    'Pagamento parcelado',
  ]) {
    const order = shortOrder();
    order.ficha.observations = [note];
    assert.throws(() => renderOrderFicha(order, TEMPLATE_V8), {
      code: 'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED',
      statusCode: 422,
    });
    assert.deepEqual(order.ficha.observations, [note]);
  }
});

test('FPI-09: free text is escaped and unknown service data is dropped', () => {
  const order = shortOrder();
  order.ficha.observations = ['OBS <img src=x onerror=alert(1)>'];
  order.ficha.items[0].tipo = '<script>alert(1)</script>';
  order.ficha.serviceData = {
    notes: ['NOTA & <b>x</b>', null, 3, { private: 'SECRET' }],
    purchase_profile: 'PERFIL_PRIVADO',
    unknown: 'DESCONHECIDO',
  };
  const html = renderOrderFicha(order, TEMPLATE_V8);
  assert.doesNotMatch(
    html,
    /<script>|<img|<b>x|SECRET|PERFIL_PRIVADO|DESCONHECIDO|\[object Object\]/u,
  );
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('NOTA &amp;'));
});

test('FPI-08: the footer prints the version and the time only when given', () => {
  const order = shortOrder();
  const plain = renderOrderFicha(order, TEMPLATE_V8);
  assert.ok(visible(plain).includes('Folha 1 de 3 · versão 9'));
  assert.ok(!plain.includes('impresso em'));
  assert.equal(plain, renderOrderFicha(order, TEMPLATE_V8));
  const stamped = renderOrderFicha(order, TEMPLATE_V8, {
    printedAt: new Date('2026-11-09T17:20:00.000Z'),
  });
  assert.ok(stamped.includes('impresso em 09/11/2026 14:20'));
  assert.ok(!plain.includes('Amostra sintética'));
  assert.ok(
    renderFichaHtmlV8(printSnapshot(order, TEMPLATE_V8), {
      synthetic: true,
    }).includes('Amostra sintética — não produzir'),
  );
});

test('FPI-08: the sheet has a static stylesheet and no script or inline style', () => {
  const html = renderOrderFicha(shortOrder(), TEMPLATE_V8);
  assert.equal((html.match(/<style>/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /\sstyle=|<script/iu);
  assert.ok(html.includes('font-family: Poppins'));
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/u);
});

test('FPI-10: text estimates wrap, keep explicit breaks and break long tokens', () => {
  assert.equal(textLines('', 100, 14), 1);
  assert.equal(textLines('a\nb\r\nc', 500, 14, { preserve: true }), 3);
  assert.ok(textLines('M'.repeat(300), 100, 14) >= 40);
  assert.ok(textLines('palavra '.repeat(40), 100, 14) >= 20);
  const plan = planFicha({
    cliente: 'C',
    nome: 'N',
    vendedor: 'V',
    data: '—',
    primeiro: '—',
    entregue: '—',
    fab: '01',
    notes: [],
    items: [],
  });
  assert.deepEqual(plan, { items: [], extras: [] });
});

test('FPI-08: orders keep printing on v6 and earlier templates do not change', () => {
  const order = sample.order;
  assert.equal(PRINT_TEMPLATE, TEMPLATE_V6);
  assert.equal(
    renderOrderFicha(order),
    renderOrderFicha(order, TEMPLATE_V6),
    'the default stays v6',
  );
  assert.ok(!renderOrderFicha(order, TEMPLATE_V7).includes('sheet extra'));
  assert.ok(renderOrderFicha(order, TEMPLATE_V7).includes('Tipo de roupa'));
  assert.ok(renderOrderFicha(order, TEMPLATE_V6).includes('Tipo de roupa'));
});

test('FPI-08: the sample is locked by hash and its pending approval refuses the switch', async () => {
  const gate = await validateFichaReviewV8();
  assert.equal(gate.templateVersion, TEMPLATE_V8);
  assert.equal(gate.provisionalApproval.status, 'pending-po-review');
  assert.equal(gate.approval.status, 'pending-human-approval');
  assert.equal(fichaV8Approved(gate), false);
  assert.throws(
    () =>
      validateFichaPrintSwitch({
        gate: {},
        gateV8: gate,
        printTemplate: TEMPLATE_V8,
      }),
    /before its approval/u,
  );
  const fake = structuredClone(gate);
  fake.provisionalApproval.approved = true;
  fake.provisionalApproval.status = 'approved';
  assert.equal(fichaV8Approved(fake), false, 'a status alone is not approval');
  fake.provisionalApproval.reviewedBy.name = 'PO sintético';
  fake.provisionalApproval.reviewedAt = '2026-11-10';
  fake.snapshotSha256 = createHash('sha256').update('outra').digest('hex');
  assert.equal(
    fichaV8Approved(fake),
    false,
    'approval cannot refer to a changed sample',
  );
});

test('FPI-10: only editable observations block; identity and item fields print', () => {
  const order = shortOrder();
  order.ficha.summary.cliente = 'Pix Confecções Ltda';
  order.ficha.summary.nome = 'Equipe 10 Reais';
  order.ficha.items[0].estampa = 'Logo do pagamento rápido';
  const html = renderOrderFicha(order, TEMPLATE_V8);
  assert.ok(visible(html).includes('Pix Confecções Ltda'));
  assert.ok(visible(html).includes('Equipe 10 Reais'));
  for (const note of [
    'Pagamentos na entrega',
    'Já pago',
    'Boleto enviado',
    'NSU 1234',
    'Valor parcelado em duas vezes',
  ]) {
    const blocked = shortOrder();
    blocked.ficha.observations = [note];
    assert.throws(() => renderOrderFicha(blocked, TEMPLATE_V8), {
      code: 'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED',
      statusCode: 422,
    });
  }
  const visit = shortOrder();
  visit.ficha.observations = ['Colocar o cartão de visita na embalagem'];
  assert.doesNotThrow(() => renderOrderFicha(visit, TEMPLATE_V8));
});

test('FPI-10: financial service data prints masked and never stops the paper', () => {
  const order = shortOrder();
  order.ficha.serviceData = {
    notes: ['Cliente paga R$ 500 no Pix', 'Conferir a manga direita'],
    customizations: 'Nomes individuais',
  };
  const text = visible(renderOrderFicha(order, TEMPLATE_V8));
  assert.ok(
    text.includes(
      'Notas do atendimento — contém informação financeira; conferir no CRM',
    ),
  );
  assert.doesNotMatch(text, /R\$ 500|paga R/u);
  assert.ok(text.includes('Conferir a manga direita'));
  assert.ok(text.includes('Nomes individuais'));
});

test('FPI-10: the financial check reads the whole note, before it is split', () => {
  const order = shortOrder();
  order.ficha.observations = [`${'x '.repeat(299)}pagamento à vista`];
  assert.equal(splitNotes(order.ficha.observations).length, 2);
  assert.throws(() => renderOrderFicha(order, TEMPLATE_V8), {
    code: 'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED',
  });
});

test('FPI-01: a grade too long for the sheet continues with header and count rows', () => {
  const order = shortOrder();
  const [base] = order.ficha.items;
  order.ficha.items = [
    {
      ...base,
      quantidade_informada: null,
      grade: Array.from({ length: 60 }, (_, index) => ({
        quantidade: 1,
        tamanho: `Masculino adulto ${index + 1}`,
      })),
    },
  ];
  order.totalPieces = 60;
  const html = renderOrderFicha(order, TEMPLATE_V8);
  const pages = sheets(html);
  assert.ok(pages.length >= 2);
  assert.match(
    visible(pages[0]),
    /Os tamanhos deste item continuam na folha 2 de \d+\./u,
  );
  const continuation = pages.filter((page) =>
    page.includes('Tamanhos (continuação)'),
  );
  assert.ok(continuation.length >= 1);
  for (const page of continuation) {
    assert.ok(page.includes('>Conferido</th>'));
    assert.ok(page.includes('>Tamanho</th>'));
  }
  assert.equal((html.match(/>Total<\/th>/gu) ?? []).length, 1);
  const labels = Array.from(
    { length: 60 },
    (_, i) => `Masculino adulto ${i + 1}`,
  );
  for (const label of labels) assert.ok(html.includes(label), label);
});

test('FPI-06: not-applicable values print readable, also in combinations', () => {
  const order = shortOrder();
  order.ficha.items[0] = {
    ...order.ficha.items[0],
    cor: '',
    cor_frente: 'NAO APLICAVEL',
    cor_costas: 'AZUL',
    malhas: ['NAO APLICAVEL', 'DRY'],
    gola: '',
    vies_gola: 'VIES_NA_GOLA',
  };
  const text = visible(renderOrderFicha(order, TEMPLATE_V8));
  assert.ok(text.includes('NÃO APLICÁVEL / AZUL'));
  assert.ok(text.includes('NÃO APLICÁVEL / DRY'));
  assert.doesNotMatch(text, /NAO APLICAVEL/u);
  assert.match(text, /7 ?Gola VIES_NA_GOLA/u);
});
