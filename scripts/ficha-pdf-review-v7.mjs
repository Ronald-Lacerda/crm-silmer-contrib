import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { AUDIENCES } from '../modules/orders/src/domain/audiences.js';
import { renderFichaHtmlV7 } from '../modules/orders/src/print/ficha-canonical-v7.js';
import {
  TEMPLATE_V6,
  TEMPLATE_V7,
  printSnapshot,
} from '../modules/orders/src/print/print-snapshot.js';

const rootUrl = new URL('../', import.meta.url);
const sampleUrl = new URL('docs/phase0/ficha-pdf-synthetic-v7.json', rootUrl);
const gateUrl = new URL('docs/phase0/ficha-pdf-approval-v7.json', rootUrl);
const ARTIFACT_PATH = 'output/pdf/ficha-canonica-sintetica-v7.pdf';
const REVIEW_PATH = 'docs/phase0/FICHA-PDF-REVIEW-V7.md';
const REQUIREMENTS = Object.freeze(['OLIST-49', 'OLIST-50', 'PIM-10']);
// RFC 050 (OLIST-T25): the PO reviews the v7 sample and the physical gates
// run before any order prints on it; until then the package is locked by
// hash, the review is pending and PRINT_TEMPLATE refuses v7.
const PROVISIONAL_STATUSES = Object.freeze(['pending-po-review', 'approved']);
const CRITERIA = Object.freeze([
  'legibility',
  'content',
  'order',
  'grade',
  'totals',
  'printing',
]);

/** @param {unknown} condition @param {string} message */
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {Buffer | string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {any} sample */
export function validateFichaSnapshotV7(sample) {
  invariant(
    sample?.schemaVersion === 1 &&
      sample.task === 'OLIST-T25' &&
      sample.rfc === '044',
    'v7 sample must trace OLIST-T25 and RFC 050',
  );
  invariant(
    sample.syntheticOnly === true &&
      sample.snapshotVersion === 'synthetic-order-v7' &&
      sample.templateVersion === TEMPLATE_V7,
    'v7 sample must be the synthetic v7 version',
  );
  invariant(
    Number.isFinite(Date.parse(sample.generatedAt)),
    'v7 sample needs a date',
  );
  const order = sample.order;
  invariant(
    /^\d{2,}-CRM$/u.test(order?.number) &&
      order.status === 'confirmado' &&
      nonEmpty(order.confirmedBy?.name),
    'v7 sample needs a confirmed synthetic order',
  );
  invariant(
    /^\d{4}-\d{2}-\d{2}$/u.test(order.orderDate) &&
      Number.isFinite(Date.parse(order.firstContactAt)) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(order.paidOn) &&
      order.deliveredOn === null &&
      /^\d{4}-\d{2}-\d{2}$/u.test(
        order.ficha?.summary?.data_entrega_confirmada,
      ),
    'v7 sample must distinguish the two summary dates from the three trail dates',
  );
  invariant(
    order.ficha.summary.aplicacao === null,
    'v7 sample must not carry an order-wide application',
  );
  const items = order.ficha?.items;
  invariant(
    Array.isArray(items) && items.length === AUDIENCES.length,
    'v7 sample needs one item per audience',
  );
  invariant(
    JSON.stringify(
      items.map((/** @type {any} */ item) => item.publico).sort(),
    ) === JSON.stringify([...AUDIENCES].sort()),
    'v7 sample must print every audience once',
  );
  const artwork = order.ficha.artwork;
  invariant(
    artwork?.feito_pelo_cliente === true &&
      artwork?.feito_pela_silmer === true &&
      artwork?.sem_estampa === false &&
      Array.isArray(artwork.files) &&
      artwork.files.length === 0,
    'v7 sample needs both art origins and no stored files',
  );
  let total = 0;
  let differs = false;
  for (const [index, item] of items.entries()) {
    for (const field of ['tipo', 'cor', 'estampa', 'tipo_servico']) {
      invariant(nonEmpty(item[field]), `v7 item ${index + 1} needs ${field}`);
    }
    invariant(
      Array.isArray(item.malhas) &&
        item.malhas.length > 0 &&
        item.malhas.every(nonEmpty) &&
        nonEmpty(item.gola || item.vies_gola),
      `v7 item ${index + 1} needs fabric model and collar`,
    );
    invariant(
      Array.isArray(item.grade) && item.grade.length > 0,
      `v7 item ${index + 1} needs a size grade`,
    );
    const sizes = new Set();
    let itemTotal = 0;
    for (const grade of item.grade) {
      invariant(
        nonEmpty(grade.tamanho) &&
          !sizes.has(grade.tamanho) &&
          Number.isInteger(grade.quantidade) &&
          grade.quantidade > 0,
        `v7 item ${index + 1} has an invalid grade`,
      );
      sizes.add(grade.tamanho);
      itemTotal += grade.quantidade;
    }
    invariant(
      item.quantidade_informada === null ||
        (Number.isInteger(item.quantidade_informada) &&
          item.quantidade_informada > 0),
      `v7 item ${index + 1} has an invalid quantity said`,
    );
    if (
      item.quantidade_informada !== null &&
      item.quantidade_informada !== itemTotal
    ) {
      differs = true;
    }
    total += itemTotal;
  }
  invariant(
    differs,
    'v7 sample must print a quantity said that differs from the sizes',
  );
  invariant(total === order.totalPieces, 'v7 sample total must match grades');
  invariant(
    !/R\$|pre[cç]o|subtotal|valor|payment|pagamento_/iu.test(
      JSON.stringify(order.ficha),
    ),
    'v7 sample must not carry money',
  );
  invariant(
    !/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(JSON.stringify(sample)),
    'v7 sample must not contain an email address',
  );
  return sample;
}

/** @param {any} sample */
export function buildFichaHtmlV7(sample) {
  validateFichaSnapshotV7(sample);
  return renderFichaHtmlV7(printSnapshot(sample.order, TEMPLATE_V7), {
    synthetic: true,
  });
}

/** @param {any} gate */
export function fichaV7ApprovalStages(gate) {
  return {
    provisional:
      gate?.provisionalApproval?.status === 'approved' &&
      gate.provisionalApproval.approved === true,
    final:
      gate?.approval?.status === 'approved' && gate.approval.approved === true,
  };
}

/** @param {{artifactBytes: Buffer, gate: any, renderedHtml: string, snapshotBytes: Buffer}} input */
export function validateFichaApprovalGateV7({
  artifactBytes,
  gate,
  renderedHtml,
  snapshotBytes,
}) {
  invariant(
    gate?.schemaVersion === 1 &&
      gate.task === 'OLIST-T25' &&
      gate.rfc === '044' &&
      gate.syntheticOnly === true &&
      JSON.stringify(gate.requirements) === JSON.stringify(REQUIREMENTS),
    'v7 gate must trace OLIST-T25, RFC 050 and OLIST-49/50/PIM-10',
  );
  invariant(
    gate.snapshotVersion === 'synthetic-order-v7' &&
      gate.templateVersion === TEMPLATE_V7,
    'v7 gate must match the synthetic v7 package',
  );
  invariant(
    gate.snapshotSha256 === sha256(snapshotBytes) &&
      gate.renderedHtmlSha256 === sha256(renderedHtml),
    'v7 sample or rendered HTML changed after review',
  );
  invariant(
    artifactBytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
      artifactBytes.length > 10_000 &&
      gate.artifact?.path === ARTIFACT_PATH &&
      gate.artifact.sha256 === sha256(artifactBytes),
    'v7 review PDF changed after review',
  );
  const actualPages = (
    artifactBytes.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? []
  ).length;
  const plannedPages =
    (renderedHtml.match(/<section class="page-break/gu) ?? []).length + 1;
  invariant(
    Number.isInteger(gate.artifact.pageCount) &&
      gate.artifact.pageCount >= 2 &&
      actualPages === gate.artifact.pageCount &&
      plannedPages === gate.artifact.pageCount,
    'v7 synthetic PDF must have the planned number of A4 pages',
  );
  const provisional = gate.provisionalApproval;
  const reviewed = provisional?.status === 'approved';
  invariant(
    PROVISIONAL_STATUSES.includes(provisional?.status) &&
      provisional.approved === reviewed &&
      provisional.scope === 'development/cloud-dev' &&
      provisional.reviewedBy?.role === 'PO' &&
      (reviewed
        ? nonEmpty(provisional.reviewedBy.name) &&
          /^\d{4}-\d{2}-\d{2}$/u.test(provisional.reviewedAt)
        : provisional.reviewedBy.name === null &&
          provisional.reviewedAt === null) &&
      provisional.snapshotSha256 === gate.snapshotSha256 &&
      provisional.renderedHtmlSha256 === gate.renderedHtmlSha256 &&
      provisional.artifactSha256 === gate.artifact.sha256 &&
      provisional.decisionRef === REVIEW_PATH,
    'v7 provisional review by the PO must lock the sample, HTML and PDF',
  );
  const approval = gate.approval;
  invariant(
    approval?.status === 'pending-human-approval' &&
      approval.approved === false &&
      approval.requiredBefore === 'production' &&
      approval.signature === 'physical' &&
      approval.reviewedBy?.rose === null &&
      approval.reviewedBy?.operation === null &&
      approval.reviewedAt === null &&
      approval.signedPaperKeptAt === null &&
      approval.evidenceRef === null &&
      JSON.stringify(Object.keys(approval.criteria ?? {})) ===
        JSON.stringify(CRITERIA) &&
      Object.values(approval.criteria).every((value) => value === null),
    'v7 physical signature by Rose and Operação must remain pending',
  );
  invariant(
    gate.versioning?.overwriteApprovedVersion === false &&
      gate.versioning?.correctionsRequireNewTemplateVersion === true &&
      gate.versioning?.supersedesTemplateVersion === TEMPLATE_V6,
    'v7 must preserve earlier approved versions',
  );
  return gate;
}

export async function validateFichaReviewV7() {
  const snapshotBytes = await readFile(sampleUrl);
  const sample = JSON.parse(snapshotBytes.toString('utf8'));
  const gate = JSON.parse(await readFile(gateUrl, 'utf8'));
  const artifactBytes = await readFile(new URL(ARTIFACT_PATH, rootUrl));
  validateFichaApprovalGateV7({
    artifactBytes,
    gate,
    renderedHtml: buildFichaHtmlV7(sample),
    snapshotBytes,
  });
  return gate;
}
