import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { AUDIENCES } from '../modules/orders/src/domain/audiences.js';
import { renderFichaHtmlV8 } from '../modules/orders/src/print/ficha-canonical-v8.js';
import {
  TEMPLATE_V6,
  TEMPLATE_V8,
  printSnapshot,
} from '../modules/orders/src/print/print-snapshot.js';

const rootUrl = new URL('../', import.meta.url);
const sampleUrl = new URL('docs/phase0/ficha-pdf-synthetic-v8.json', rootUrl);
const gateUrl = new URL('docs/phase0/ficha-pdf-approval-v8.json', rootUrl);
export const ARTIFACT_PATH_V8 = 'output/pdf/ficha-canonica-sintetica-v8.pdf';
export const REVIEW_PATH_V8 = 'docs/phase0/FICHA-PDF-REVIEW-V8.md';
export const REQUIREMENTS_V8 = Object.freeze([
  'FPI-01',
  'FPI-02',
  'FPI-03',
  'FPI-04',
  'FPI-05',
  'FPI-06',
  'FPI-07',
  'FPI-08',
  'FPI-09',
  'FPI-10',
]);
const PROVISIONAL_STATUSES = Object.freeze(['pending-po-review', 'approved']);
export const CRITERIA_V8 = Object.freeze([
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
export function sha256V8(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {any} sample */
export function validateFichaSnapshotV8(sample) {
  invariant(
    sample?.schemaVersion === 1 &&
      sample.task === 'FPI-T01' &&
      sample.adr === '078',
    'v8 sample must trace FPI-T01 and ADR 078',
  );
  invariant(
    sample.syntheticOnly === true &&
      sample.snapshotVersion === 'synthetic-order-v8' &&
      sample.templateVersion === TEMPLATE_V8,
    'v8 sample must be the synthetic v8 version',
  );
  invariant(
    Number.isFinite(Date.parse(sample.generatedAt)),
    'v8 sample needs a date',
  );
  const order = sample.order;
  invariant(
    /^\d{2,}-CRM$/u.test(order?.number) &&
      order.status === 'confirmado' &&
      nonEmpty(order.confirmedBy?.name) &&
      Number.isSafeInteger(order.version),
    'v8 sample needs a confirmed synthetic order with a version',
  );
  const items = order.ficha?.items;
  invariant(
    Array.isArray(items) &&
      JSON.stringify(
        items.map((/** @type {any} */ item) => item.publico).sort(),
      ) === JSON.stringify([...AUDIENCES].sort()),
    'v8 sample needs one item per audience',
  );
  let total = 0;
  let differs = false;
  for (const [index, item] of items.entries()) {
    for (const field of ['tipo', 'cor', 'estampa', 'tipo_servico', 'gola']) {
      invariant(nonEmpty(item[field]), `v8 item ${index + 1} needs ${field}`);
    }
    invariant(
      Array.isArray(item.grade) && item.grade.length > 0,
      `v8 item ${index + 1} needs a size grade`,
    );
    const sum = item.grade.reduce(
      (/** @type {number} */ acc, /** @type {any} */ line) =>
        acc + line.quantidade,
      0,
    );
    total += sum;
    if (item.quantidade_informada !== null && item.quantidade_informada !== sum)
      differs = true;
  }
  invariant(differs, 'v8 sample must print a quantity that differs from sizes');
  invariant(total === order.totalPieces, 'v8 sample total must match grades');
  invariant(
    items.some((/** @type {any} */ item) => item.grade.length >= 16),
    'v8 sample needs an item with sixteen sizes',
  );
  invariant(
    items.some((/** @type {any} */ item) => nonEmpty(item.modelo)),
    'v8 sample must print a model detail',
  );
  invariant(
    Array.isArray(order.ficha.observations) &&
      order.ficha.observations.length > 0 &&
      Object.keys(order.ficha.serviceData ?? {}).length > 0,
    'v8 sample needs observations and complementary service data',
  );
  invariant(
    !/R\$|pre[cç]o|subtotal|valor|payment|pagamento_/iu.test(
      JSON.stringify(order.ficha),
    ),
    'v8 sample must not carry money',
  );
  invariant(
    !/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(JSON.stringify(sample)),
    'v8 sample must not contain an email address',
  );
  return sample;
}

/** @param {any} sample */
export function buildFichaHtmlV8(sample) {
  validateFichaSnapshotV8(sample);
  return renderFichaHtmlV8(printSnapshot(sample.order, TEMPLATE_V8), {
    synthetic: true,
  });
}

/** @param {any} gate */
export function fichaV8ApprovalStages(gate) {
  return {
    provisional:
      gate?.provisionalApproval?.status === 'approved' &&
      gate.provisionalApproval.approved === true,
    final:
      gate?.approval?.status === 'approved' && gate.approval.approved === true,
  };
}

/** @param {any} gate */
export function fichaV8Approved(gate) {
  const stages = fichaV8ApprovalStages(gate);
  const provisional = gate?.provisionalApproval;
  return (
    stages.provisional &&
    nonEmpty(provisional?.reviewedBy?.name) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(provisional?.reviewedAt ?? '') &&
    provisional.snapshotSha256 === gate.snapshotSha256 &&
    provisional.renderedHtmlSha256 === gate.renderedHtmlSha256 &&
    provisional.artifactSha256 === gate.artifact?.sha256
  );
}

/** @param {{artifactBytes: Buffer, gate: any, renderedHtml: string, snapshotBytes: Buffer}} input */
export function validateFichaApprovalGateV8({
  artifactBytes,
  gate,
  renderedHtml,
  snapshotBytes,
}) {
  invariant(
    gate?.schemaVersion === 1 &&
      gate.task === 'FPI-T01' &&
      gate.adr === '078' &&
      gate.syntheticOnly === true &&
      JSON.stringify(gate.requirements) === JSON.stringify(REQUIREMENTS_V8),
    'v8 gate must trace FPI-T01, ADR 078 and FPI-01..10',
  );
  invariant(
    gate.snapshotVersion === 'synthetic-order-v8' &&
      gate.templateVersion === TEMPLATE_V8,
    'v8 gate must match the synthetic v8 package',
  );
  invariant(
    gate.snapshotSha256 === sha256V8(snapshotBytes) &&
      gate.renderedHtmlSha256 === sha256V8(renderedHtml),
    'v8 sample or rendered HTML changed after review',
  );
  invariant(
    artifactBytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
      artifactBytes.length > 10_000 &&
      gate.artifact?.path === ARTIFACT_PATH_V8 &&
      gate.artifact.sha256 === sha256V8(artifactBytes),
    'v8 review PDF changed after review',
  );
  const actualPages = (
    artifactBytes.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? []
  ).length;
  const plannedPages = (renderedHtml.match(/<article class="sheet/gu) ?? [])
    .length;
  invariant(
    Number.isInteger(gate.artifact.pageCount) &&
      gate.artifact.pageCount >= 2 &&
      actualPages === gate.artifact.pageCount &&
      plannedPages === gate.artifact.pageCount,
    'v8 synthetic PDF must have one A4 page per planned sheet',
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
      provisional.decisionRef === REVIEW_PATH_V8,
    'v8 provisional review by the PO must lock the sample, HTML and PDF',
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
        JSON.stringify(CRITERIA_V8) &&
      Object.values(approval.criteria).every((value) => value === null),
    'v8 physical signature by Rose and Operação must remain pending',
  );
  invariant(
    gate.versioning?.overwriteApprovedVersion === false &&
      gate.versioning?.correctionsRequireNewTemplateVersion === true &&
      gate.versioning?.supersedesTemplateVersion === TEMPLATE_V6,
    'v8 must preserve earlier approved versions',
  );
  return gate;
}

export async function validateFichaReviewV8() {
  const snapshotBytes = await readFile(sampleUrl);
  const sample = JSON.parse(snapshotBytes.toString('utf8'));
  const gate = JSON.parse(await readFile(gateUrl, 'utf8'));
  const artifactBytes = await readFile(new URL(ARTIFACT_PATH_V8, rootUrl));
  validateFichaApprovalGateV8({
    artifactBytes,
    gate,
    renderedHtml: buildFichaHtmlV8(sample),
    snapshotBytes,
  });
  return gate;
}
