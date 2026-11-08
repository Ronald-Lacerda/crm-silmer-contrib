import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderFichaHtmlV6 } from '../modules/orders/src/print/ficha-canonical-v6.js';
import {
  PRINT_TEMPLATE,
  renderOrderFicha,
  TEMPLATE_V2,
  TEMPLATE_V3,
  TEMPLATE_V4,
  TEMPLATE_V5,
  TEMPLATE_V6,
  TEMPLATE_V7,
} from '../modules/orders/src/print/index.js';
import { printSnapshot } from '../modules/orders/src/print/print-snapshot.js';
import {
  buildFichaHtmlV3,
  validateFichaPrintSwitch,
} from '../scripts/ficha-pdf-review.mjs';
import { validateFichaReviewV4 } from '../scripts/ficha-pdf-review-v4.mjs';
import { validateFichaReviewV5 } from '../scripts/ficha-pdf-review-v5.mjs';
import { validateFichaReviewV6 } from '../scripts/ficha-pdf-review-v6.mjs';
import {
  buildFichaHtmlV7,
  fichaV7ApprovalStages,
  validateFichaApprovalGateV7,
  validateFichaReviewV7,
  validateFichaSnapshotV7,
} from '../scripts/ficha-pdf-review-v7.mjs';

/** @param {string} path */
async function json(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const sampleBytes = await readFile(
  new URL('../docs/phase0/ficha-pdf-synthetic-v7.json', import.meta.url),
);
const reviewSample = JSON.parse(sampleBytes.toString('utf8'));
const v6Sample = await json('../docs/phase0/ficha-pdf-synthetic-v6.json');
const gate = await json('../docs/phase0/ficha-pdf-approval-v7.json');
const pdfBytes = await readFile(
  new URL('../output/pdf/ficha-canonica-sintetica-v7.pdf', import.meta.url),
);
const v3Gate = await json('../docs/phase0/ficha-pdf-approval-v3.json');
const v4Gate = await json('../docs/phase0/ficha-pdf-approval-v4.json');
const v5Gate = await json('../docs/phase0/ficha-pdf-approval-v5.json');
const v6Gate = await json('../docs/phase0/ficha-pdf-approval-v6.json');

test('v7 names point 4 "Aplicação" and the summary date "Previsão de entrega" (OLIST-49)', () => {
  const html = renderOrderFicha(reviewSample.order, TEMPLATE_V7);
  // Point 4 keeps the value of each item's own service, per item.
  const applications = [
    ...html.matchAll(
      /4<\/b> Aplicação<\/span><div class="point-value">([^<]+)</gu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    applications,
    reviewSample.order.ficha.items.map(
      (/** @type {any} */ item) => item.tipo_servico,
    ),
    'one Aplicação per item, from tipo_servico',
  );
  assert.deepEqual(
    [...new Set(applications)].sort(),
    ['BORDADO', 'SILK'],
    'the groups keep their own application',
  );
  assert.match(
    html,
    /Previsão de entrega<\/span><strong>30\/10\/2026</u,
    'the value is still data_entrega_confirmada',
  );
  assert.doesNotMatch(html, /Técnica|Entrega prometida/u);
  assert.doesNotMatch(html, /echnique|prometida/iu);
  // The rest of the document is v6: audience, point 5, quantity said.
  assert.match(html, /5<\/b> Modelo de malha<\/span>/u);
  assert.match(html, /<em class="audience">Feminino<\/em>/u);
  assert.match(html, /Quantidade informada <strong>12<\/strong>/u);

  const v6 = renderOrderFicha(reviewSample.order, TEMPLATE_V6);
  assert.match(v6, /4<\/b> Técnica<\/span>/u);
  assert.match(v6, /Entrega prometida<\/span>/u);
  assert.doesNotMatch(v6, /Aplicação|Previsão de entrega/u);
});

test('v7 does not revive the order-wide summary.aplicacao', () => {
  const order = structuredClone(reviewSample.order);
  order.ficha.summary.aplicacao = 'APLICAÇÃO GLOBAL SINTÉTICA';
  const html = renderOrderFicha(order, TEMPLATE_V7);
  assert.doesNotMatch(html, /GLOBAL SINTÉTICA/u);
  assert.equal(
    html,
    renderOrderFicha(reviewSample.order, TEMPLATE_V7),
    'summary.aplicacao changes nothing on the paper',
  );
});

test('v7 prints no money (OLIST-50)', () => {
  const order = structuredClone(reviewSample.order);
  // Even if the order carried prices, the ficha has no place to print them.
  order.finalAmountCents = 482000;
  order.paymentCondition = 'pix';
  order.ficha.summary.valor_total = '4.820,00';
  const html = renderOrderFicha(order, TEMPLATE_V7);
  assert.doesNotMatch(
    html,
    /R\$|4\.820|482000|pix|subtotal|preço|pre&ccedil;o|valor|pagamento:|condição/iu,
  );
  assert.doesNotMatch(html, /null|undefined/u);
  assert.equal(
    html,
    renderOrderFicha(reviewSample.order, TEMPLATE_V7),
    'money on the order changes nothing on the paper',
  );
});

test('v7 differs from v6 only in the two labels and shares its stylesheet', () => {
  const v6 = renderFichaHtmlV6(printSnapshot(v6Sample.order, TEMPLATE_V6), {
    synthetic: true,
  });
  const v7 = buildFichaHtmlV7(reviewSample);
  assert.equal(
    v7,
    v6
      .replaceAll('4</b> Técnica</span>', '4</b> Aplicação</span>')
      .replace('Entrega prometida', 'Previsão de entrega'),
  );
  const style = (/** @type {string} */ html) =>
    /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1];
  assert.equal(style(v7), style(v6));
});

test('v7 reads an order stored before ADR 025 and a synthetic render keeps its band', () => {
  const order = structuredClone(reviewSample.order);
  for (const item of order.ficha.items) {
    delete item.publico;
    delete item.quantidade_informada;
  }
  const html = renderOrderFicha(order, TEMPLATE_V7);
  assert.doesNotMatch(html, /class="audience"|Quantidade informada|undefined/u);
  assert.doesNotMatch(
    html,
    /<span class="synthetic">|<div class="review-box">|<div class="signatures">/u,
  );
  assert.match(
    buildFichaHtmlV7(reviewSample),
    /Amostra sintética — não produzir/u,
  );
});

test('the v7 sample is synthetic, has every audience once and carries no money', () => {
  assert.doesNotThrow(() => validateFichaSnapshotV7(reviewSample));
  assert.equal(reviewSample.order.ficha.summary.aplicacao, null);
  const twice = structuredClone(reviewSample);
  twice.order.ficha.items[3].publico = 'masculino';
  assert.throws(() => validateFichaSnapshotV7(twice), /every audience once/u);
  const priced = structuredClone(reviewSample);
  priced.order.ficha.items[0].preco = 'R$ 10,00';
  assert.throws(() => validateFichaSnapshotV7(priced), /money/u);
  const global = structuredClone(reviewSample);
  global.order.ficha.summary.aplicacao = 'SILK';
  assert.throws(() => validateFichaSnapshotV7(global), /order-wide/u);
});

test('v2 to v6 keep their approved hashes untouched (OLIST-50)', async () => {
  const v3Sample = await json('../docs/phase0/ficha-pdf-synthetic-v3.json');
  assert.equal(sha256(buildFichaHtmlV3(v3Sample)), v3Gate.renderedHtmlSha256);
  assert.deepEqual(await validateFichaReviewV4(), v4Gate);
  assert.deepEqual(await validateFichaReviewV5(), v5Gate);
  assert.deepEqual(await validateFichaReviewV6(), v6Gate);
  // A template named by the order keeps its own renderer.
  for (const template of [TEMPLATE_V2, TEMPLATE_V3, TEMPLATE_V4, TEMPLATE_V5]) {
    const html = renderOrderFicha(v6Sample.order, template);
    assert.doesNotMatch(html, /Aplicação|Previsão de entrega/u, template);
  }
  assert.doesNotThrow(() => printSnapshot(reviewSample.order, TEMPLATE_V7));
});

test('v7 package is locked by hash and its approval stays pending', async () => {
  assert.equal(gate.provisionalApproval.status, 'pending-po-review');
  assert.equal(gate.provisionalApproval.approved, false);
  assert.equal(gate.provisionalApproval.reviewedBy.name, null);
  assert.equal(gate.approval.status, 'pending-human-approval');
  assert.equal(gate.versioning.supersedesTemplateVersion, TEMPLATE_V6);
  assert.deepEqual(fichaV7ApprovalStages(gate), {
    final: false,
    provisional: false,
  });
  assert.deepEqual(await validateFichaReviewV7(), gate);
  const input = {
    artifactBytes: pdfBytes,
    gate,
    renderedHtml: buildFichaHtmlV7(reviewSample),
    snapshotBytes: sampleBytes,
  };
  assert.doesNotThrow(() => validateFichaApprovalGateV7(input));
  assert.throws(
    () =>
      validateFichaApprovalGateV7({
        ...input,
        renderedHtml: `${input.renderedHtml} `,
      }),
    /HTML changed/u,
  );
  assert.throws(
    () =>
      validateFichaApprovalGateV7({
        ...input,
        artifactBytes: Buffer.concat([pdfBytes, Buffer.from('change')]),
      }),
    /PDF changed/u,
  );
  const invented = structuredClone(gate);
  invented.provisionalApproval.status = 'approved';
  invented.provisionalApproval.approved = true;
  assert.throws(
    () => validateFichaApprovalGateV7({ ...input, gate: invented }),
    /review by the PO/u,
  );
  const falseSignature = structuredClone(gate);
  falseSignature.approval.approved = true;
  assert.throws(
    () => validateFichaApprovalGateV7({ ...input, gate: falseSignature }),
    /signature/u,
  );
});

test('v7 is addressable but not selected: the switch refuses it without approval (OLIST-50, PIM-10)', () => {
  assert.equal(PRINT_TEMPLATE, TEMPLATE_V6);
  assert.notEqual(PRINT_TEMPLATE, TEMPLATE_V7);
  const switchTo = (/** @type {any} */ gateV7, template = TEMPLATE_V7) =>
    validateFichaPrintSwitch({
      gate: v3Gate,
      gateV4: v4Gate,
      gateV5: v5Gate,
      gateV6: v6Gate,
      gateV7,
      printTemplate: template,
    });
  assert.throws(() => switchTo(gate), /before its approval is recorded/u);
  assert.throws(() => switchTo(undefined), /before its approval is recorded/u);
  // The current selection stays valid with v7 pending.
  assert.doesNotThrow(() => switchTo(gate, TEMPLATE_V6));
  // Only a recorded approval would let a later change select v7: the test
  // fakes it on a copy; nothing real is approved.
  const approvedCopy = structuredClone(gate);
  approvedCopy.provisionalApproval.status = 'approved';
  approvedCopy.provisionalApproval.approved = true;
  assert.doesNotThrow(() => switchTo(approvedCopy));
});
