import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'prettier';

import { NOT_APPLICABLE } from '../modules/orders/src/domain/ficha.js';
import {
  PRODUCTION_FIELDS,
  renderFichaHtml,
} from '../modules/orders/src/print/ficha-canonical-v2.js';
import {
  EXTRA_FIELDS,
  renderFichaHtmlV3,
} from '../modules/orders/src/print/ficha-canonical-v3.js';
import {
  TEMPLATE_V2,
  TEMPLATE_V3,
  TEMPLATE_V4,
  TEMPLATE_V5,
  TEMPLATE_V6,
  TEMPLATE_V7,
  TEMPLATE_V8,
  printSnapshot,
} from '../modules/orders/src/print/print-snapshot.js';
import { PRINT_TEMPLATE } from '../modules/orders/src/print/index.js';
import {
  fichaV4ApprovalStages,
  validateFichaReviewV4,
} from './ficha-pdf-review-v4.mjs';
import {
  fichaV5ApprovalStages,
  validateFichaReviewV5,
} from './ficha-pdf-review-v5.mjs';
import {
  fichaV6ApprovalStages,
  validateFichaReviewV6,
} from './ficha-pdf-review-v6.mjs';
import {
  fichaV7ApprovalStages,
  validateFichaReviewV7,
} from './ficha-pdf-review-v7.mjs';
import {
  fichaV8ApprovalStages,
  validateFichaReviewV8,
} from './ficha-pdf-review-v8.mjs';

const rootUrl = new URL('../', import.meta.url);
const snapshotUrl = new URL('docs/phase0/ficha-pdf-synthetic.json', rootUrl);
const gateUrl = new URL('docs/phase0/ficha-pdf-approval.json', rootUrl);
const snapshotV3Url = new URL(
  'docs/phase0/ficha-pdf-synthetic-v3.json',
  rootUrl,
);
const gateV3Url = new URL('docs/phase0/ficha-pdf-approval-v3.json', rootUrl);
const V3_ARTIFACT_PATH = 'output/pdf/ficha-canonica-sintetica-v3.pdf';
const V3_EVIDENCE_PATH = 'docs/phase0/ficha-pdf-approved-evidence-v3.json';
const V3_ADR_PATH = 'docs/adr/017-ficha-impressa-com-os-sete-pontos.md';
// ADR 017: the PO's provisional approval covers development and cloud-dev;
// the physical signature by Rose and Operação is required before production.
const V3_PROVISIONAL_SCOPE = 'development/cloud-dev';
const V3_FINAL_REQUIRED_BEFORE = 'production';
const V3_REQUIREMENTS = Object.freeze([
  'PIM-06',
  'PIM-07',
  'PIM-08',
  'PIM-09',
  'PIM-11',
  'PIM-12',
  'PLA-08',
]);

export { PRODUCTION_FIELDS };

const commercialOrderFields = Object.freeze([
  'numero',
  'fab',
  'vendedor',
  'data',
  'nome',
  'data_entrega_confirmada',
  'cliente',
  'aplicacao',
]);

const commercialItemFields = Object.freeze([
  'tipo',
  'modelo',
  'malhas',
  'cor_frente',
  'cor_costas',
  'cor_manga_direita',
  'cor_manga_esquerda',
  'vies_gola',
  'vies_mangas',
  'grade',
]);

const approvalCriteria = Object.freeze([
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
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {string} value */
export function containsPersonalContact(value) {
  return (
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(value) ||
    /(?<![\p{L}\p{N}_-])(?:\+55\s*)?(?:\(\d{2}\)|\d{2})\s*9?\d{4}[- ]?\d{4}(?![\p{L}\p{N}_-])/u.test(
      value,
    )
  );
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** @param {unknown} value */
function display(value) {
  return escapeHtml(String(value));
}

/** @param {any} snapshot */
export function validateFichaSnapshot(snapshot) {
  invariant(snapshot?.schemaVersion === 1, 'Snapshot schema version must be 1');
  invariant(snapshot?.task === 'T00.4', 'Snapshot must trace to T00.4');
  invariant(snapshot?.issue === 7, 'Snapshot must trace to issue 7');
  invariant(
    snapshot?.syntheticOnly === true,
    'Snapshot must be synthetic only',
  );
  invariant(
    snapshot?.snapshotVersion === 'synthetic-order-v1' &&
      snapshot?.templateVersion === 'ficha-canonical-v2',
    'Snapshot and template versions must be explicit',
  );
  invariant(
    Number.isFinite(Date.parse(snapshot.generatedAt)),
    'Snapshot generation time must be ISO 8601',
  );

  const order = snapshot?.pedido;
  for (const field of commercialOrderFields) {
    invariant(
      nonEmptyString(order?.[field]),
      `Commercial field pedido.${field} is required`,
    );
  }
  invariant(order.numero === '01-CRM', 'Synthetic first order must be 01-CRM');
  invariant(order.fab === '01', 'Synthetic FAB must use controlled code 01');
  invariant(
    Array.isArray(order.itens) && order.itens.length > 0,
    'At least one synthetic item is required',
  );

  let gradeTotal = 0;
  for (const [itemIndex, item] of order.itens.entries()) {
    for (const field of commercialItemFields) {
      const value = item?.[field];
      invariant(
        field === 'malhas' || field === 'grade'
          ? Array.isArray(value) && value.length > 0
          : nonEmptyString(value),
        `Commercial field pedido.itens[${itemIndex}].${field} is required`,
      );
    }
    invariant(
      item.malhas.every(nonEmptyString),
      `Item ${itemIndex + 1} malhas must be explicit`,
    );
    const sizes = new Set();
    for (const [gradeIndex, grade] of item.grade.entries()) {
      invariant(
        nonEmptyString(grade?.tamanho),
        `Item ${itemIndex + 1} grade ${gradeIndex + 1} needs a size`,
      );
      invariant(
        Number.isInteger(grade.quantidade) && grade.quantidade > 0,
        `Item ${itemIndex + 1} grade ${gradeIndex + 1} needs a positive integer quantity`,
      );
      invariant(
        !sizes.has(grade.tamanho),
        `Item ${itemIndex + 1} cannot repeat size ${grade.tamanho}`,
      );
      sizes.add(grade.tamanho);
      gradeTotal += grade.quantidade;
    }
  }

  invariant(
    Number.isInteger(order.quantidade_total) &&
      order.quantidade_total === gradeTotal,
    'Order total must equal the sum of every grade quantity',
  );
  invariant(
    Array.isArray(order.observacoes) &&
      order.observacoes.length > 0 &&
      order.observacoes.every(nonEmptyString),
    'Ordered synthetic observations are required',
  );
  invariant(
    JSON.stringify(Object.keys(snapshot.producao ?? {})) ===
      JSON.stringify(PRODUCTION_FIELDS),
    'Every production field must be present in canonical order',
  );
  invariant(
    Object.values(snapshot.producao).every((value) => value === ''),
    'Every production field must start blank',
  );
  invariant(
    !containsPersonalContact(JSON.stringify(snapshot)),
    'Synthetic snapshot must not contain email addresses or phone numbers',
  );

  return { gradeTotal };
}

/**
 * @param {{artifactBytes: Buffer, evidence?: any, gate: any, legacyArtifactBytes: Buffer, reviewPageHtml: string, snapshotBytes: Buffer}} input
 */
export function validateFichaApprovalGate({
  artifactBytes,
  evidence = null,
  gate,
  legacyArtifactBytes,
  reviewPageHtml,
  snapshotBytes,
}) {
  invariant(
    gate?.schemaVersion === 1,
    'Approval gate schema version must be 1',
  );
  invariant(gate?.task === 'T00.4', 'Approval gate must trace to T00.4');
  invariant(gate?.issue === 7, 'Approval gate must trace to issue 7');
  invariant(
    gate?.syntheticOnly === true,
    'Approval gate must be synthetic only',
  );
  invariant(
    JSON.stringify(gate.requirements) ===
      JSON.stringify(['ORD-01', 'ORD-02', 'ORD-03', 'ORD-04', 'ORD-05']),
    'Approval gate must trace ORD-01..05',
  );
  invariant(
    gate.snapshotVersion === 'synthetic-order-v1' &&
      gate.templateVersion === 'ficha-canonical-v2',
    'Approval gate versions must match the review package',
  );
  invariant(
    gate.snapshotSha256 === sha256(snapshotBytes),
    'Snapshot SHA-256 does not match the versioned snapshot',
  );
  invariant(
    artifactBytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
      artifactBytes.length > 10_000,
    'Review artifact must be a non-empty PDF',
  );
  invariant(
    gate.artifact?.path === 'output/pdf/ficha-canonica-sintetica-v2.pdf' &&
      gate.artifact.downloadLabel === 'Baixar nova ficha',
    'Review artifact path must be stable',
  );
  invariant(
    gate.artifact.sha256 === sha256(artifactBytes),
    'Artifact SHA-256 does not match the versioned PDF',
  );
  invariant(
    Number.isInteger(gate.artifact.pageCount) &&
      gate.artifact.pageCount >= 2 &&
      gate.artifact.pageCount === countPdfPages(artifactBytes),
    'Review artifact page count must match a PDF with at least two pages',
  );
  invariant(
    legacyArtifactBytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
      legacyArtifactBytes.length > 10_000,
    'Legacy artifact must be a non-empty PDF',
  );
  invariant(
    gate.legacyArtifact?.templateVersion === 'ficha-legacy-v1' &&
      gate.legacyArtifact.path ===
        'output/pdf/ficha-canonica-sintetica-v1.pdf' &&
      gate.legacyArtifact.downloadLabel === 'Download ficha legada',
    'Legacy artifact metadata must identify the stable fallback',
  );
  invariant(
    gate.legacyArtifact.sha256 === sha256(legacyArtifactBytes),
    'Legacy artifact SHA-256 does not match the versioned PDF',
  );
  invariant(
    Number.isInteger(gate.legacyArtifact.pageCount) &&
      gate.legacyArtifact.pageCount >= 2 &&
      gate.legacyArtifact.pageCount === countPdfPages(legacyArtifactBytes),
    'Legacy artifact page count must match a PDF with at least two pages',
  );
  invariant(
    gate.artifact.path !== gate.legacyArtifact.path &&
      gate.artifact.sha256 !== gate.legacyArtifact.sha256,
    'Canonical and legacy artifacts must be distinct',
  );
  invariant(
    gate.reviewPage?.path === 'output/pdf/revisao-ficha.html' &&
      gate.reviewPage.primaryLabel === 'Baixar nova ficha' &&
      gate.reviewPage.legacyLabel === 'Download ficha legada' &&
      reviewPageHtml === buildReviewPageHtml(gate),
    'Review page must expose the canonical and legacy downloads',
  );

  const approval = gate.approval;
  const criteria = Object.values(approval?.criteria ?? {});
  invariant(
    JSON.stringify(Object.keys(approval?.criteria ?? {})) ===
      JSON.stringify(approvalCriteria),
    'Ficha approval must record every canonical review criterion in order',
  );
  const pending =
    approval?.status === 'pending-human-approval' &&
    approval.approved === false &&
    approval.reviewedBy?.rose === null &&
    approval.reviewedBy?.operation === null &&
    approval.reviewedAt === null &&
    approval.evidenceRef === null &&
    criteria.length === 6 &&
    criteria.every((value) => value === null);
  const approved =
    approval?.status === 'approved' &&
    approval.approved === true &&
    nonEmptyString(approval.reviewedBy?.rose) &&
    nonEmptyString(approval.reviewedBy?.operation) &&
    Number.isFinite(Date.parse(approval.reviewedAt)) &&
    criteria.length === 6 &&
    criteria.every((value) => value === true) &&
    /^docs\/phase0\/ficha-pdf-approved-evidence-v\d+\.json$/u.test(
      approval.evidenceRef,
    );
  invariant(
    pending || approved,
    'Ficha human approval must be wholly pending or wholly approved',
  );
  if (approved) validateFichaApprovalEvidence(evidence, gate);
  invariant(
    gate.versioning?.overwriteApprovedVersion === false &&
      gate.versioning?.correctionsRequireNewTemplateVersion === true &&
      gate.versioning?.supersedesTemplateVersion === 'ficha-canonical-v1',
    'Approved Ficha versions must never be overwritten',
  );

  return gate;
}

/** @param {any} evidence @param {any} gate */
export function validateFichaApprovalEvidence(evidence, gate) {
  invariant(
    evidence?.schemaVersion === 1 &&
      evidence.task === 'T00.4' &&
      evidence.issue === 7 &&
      evidence.syntheticOnly === true,
    'Approved evidence must be synthetic and trace to T00.4/issue 7',
  );
  invariant(
    evidence.templateVersion === gate.templateVersion &&
      evidence.snapshotVersion === gate.snapshotVersion &&
      evidence.snapshotSha256 === gate.snapshotSha256 &&
      evidence.artifactSha256 === gate.artifact.sha256,
    'Approved evidence must identify the exact snapshot, template, and artifact',
  );
  invariant(
    evidence.reviewedAt === gate.approval.reviewedAt &&
      JSON.stringify(evidence.reviewedBy) ===
        JSON.stringify(gate.approval.reviewedBy) &&
      JSON.stringify(evidence.criteria) ===
        JSON.stringify(gate.approval.criteria),
    'Approved evidence must match the human review recorded in the gate',
  );
  invariant(
    Array.isArray(evidence.visualEvidence) &&
      evidence.visualEvidence.length > 0 &&
      evidence.visualEvidence.every(
        (/** @type {any} */ item) =>
          item?.containsPii === false &&
          ['git', 'silmer'].includes(item.type) &&
          new RegExp(`^${item.type}:[a-zA-Z0-9._-]+$`, 'u').test(item.ref),
      ),
    'Approved evidence needs at least one PII-free git or Silmer visual reference',
  );
  invariant(
    !containsPersonalContact(JSON.stringify(evidence)),
    'Approved evidence must not contain email addresses or phone numbers',
  );
  return evidence;
}

/**
 * The synthetic review package: the approved renderer plus the T00.4 gate over
 * the snapshot. The sample band stays because this document is a review
 * artifact, never a printed order.
 *
 * @param {any} snapshot
 */
export function buildFichaHtml(snapshot) {
  validateFichaSnapshot(snapshot);
  return renderFichaHtml(snapshot, { synthetic: true });
}

/** @param {any} snapshot */
export function buildLegacyFichaHtml(snapshot) {
  validateFichaSnapshot(snapshot);
  const rows = snapshot.pedido.itens.flatMap(
    (/** @type {any} */ item, /** @type {number} */ itemIndex) =>
      item.grade.map(
        (/** @type {any} */ grade, /** @type {number} */ gradeIndex) => `
        <tr>
          <td>${gradeIndex === 0 ? display(itemIndex + 1) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.tipo) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.modelo) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.malhas.join(' / ')) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.cor_frente) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.cor_costas) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.cor_manga_direita) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.cor_manga_esquerda) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.vies_gola) : ''}</td>
          <td>${gradeIndex === 0 ? display(item.vies_mangas) : ''}</td>
          <td>${display(grade.tamanho)}</td>
          <td class="numero">${display(grade.quantidade)}</td>
        </tr>`,
      ),
  );
  const productionFields = [
    ['Conferido para arrematar por:', 'conferido_arremate_por'],
    ['Data:', 'conferido_arremate_em'],
    ['Arrematado:', 'arrematado_por'],
    ['Data:', 'arrematado_em'],
    ['OBS:', 'observacao_arremate'],
    ['Conferido / Embalado por:', 'conferido_embalado_por'],
    ['Data:', 'conferido_embalado_em'],
    ['Cores Frente:', 'cores_frente'],
    ['Costas:', 'cores_costas'],
    ['Manga Direita:', 'cores_manga_direita'],
    ['Manga Esq:', 'cores_manga_esquerda'],
    ['Total:', 'total_cores_partes'],
    ['OBS:', 'observacao_cores'],
    ['Qtd total de cores do pedido:', 'quantidade_total_cores'],
  ];

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <title>Ficha de Pedido ${display(snapshot.pedido.numero)}</title>
    <style>
      @page { size: A4 landscape; margin: 10mm 9mm 12mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #172033; font-family: Arial, Helvetica, sans-serif; font-size: 9px; }
      h1, h2, p { margin: 0; }
      header { align-items: center; border-bottom: 3px solid #7226ff; display: flex; justify-content: space-between; margin-bottom: 8px; padding-bottom: 6px; }
      h1 { font-size: 21px; letter-spacing: .06em; }
      h2 { color: #3a246d; font-size: 14px; margin-bottom: 7px; }
      .marca { color: #7226ff; font-size: 14px; font-weight: 800; letter-spacing: .08em; }
      .synthetic { background: #fff2cc; border: 1px solid #b97900; border-radius: 4px; color: #6b4300; font-size: 8px; font-weight: 700; padding: 4px 7px; text-transform: uppercase; }
      .metadata { border: 1px solid #aeb7c7; display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 8px; }
      .field { border-bottom: 1px solid #d5dae3; border-right: 1px solid #d5dae3; min-height: 38px; padding: 5px 7px; }
      .field:nth-child(4n) { border-right: 0; }
      .field:nth-last-child(-n + 4) { border-bottom: 0; }
      .label { color: #596579; display: block; font-size: 7px; font-weight: 700; letter-spacing: .06em; margin-bottom: 3px; text-transform: uppercase; }
      .value { font-size: 10px; font-weight: 700; }
      table { border-collapse: collapse; table-layout: fixed; width: 100%; }
      th, td { border: 1px solid #69758a; padding: 3px 2px; text-align: left; vertical-align: top; }
      th { background: #ede8ff; color: #24164a; font-size: 6.8px; letter-spacing: .02em; text-transform: uppercase; }
      tbody tr:nth-child(even) { background: #f8f9fc; }
      .numero { text-align: right; }
      .total td { background: #27203c; color: white; font-size: 11px; font-weight: 800; padding: 6px; }
      .observacoes { border: 1px solid #69758a; margin-top: 8px; padding: 7px; }
      .observacoes ol { margin: 5px 0 0; padding-left: 18px; }
      .observacoes li { margin: 2px 0; }
      .page-break { break-before: page; }
      .production-note { background: #eef7ff; border-left: 4px solid #1474b8; margin-bottom: 10px; padding: 8px 10px; }
      .production-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .production-field { border: 1px solid #69758a; min-height: 52px; padding: 7px; }
      .production-field.wide { grid-column: span 2; }
      .campo-producao-vazio { border-bottom: 1px solid #172033; display: block; height: 23px; margin-top: 7px; }
      .review-box { border: 2px dashed #b97900; margin-top: 12px; padding: 9px; }
      .review-box strong { color: #6b4300; }
    </style>
  </head>
  <body>
    <header>
      <div><div class="marca">SILMER</div><h1>FICHA DE PEDIDO</h1></div>
      <div class="synthetic">Amostra sintetica - nao produzir</div>
    </header>
    <section class="metadata">
      <div class="field"><span class="label">Pedido No.</span><span class="value">${display(snapshot.pedido.numero)}</span></div>
      <div class="field"><span class="label">FAB</span><span class="value">FAB ${display(snapshot.pedido.fab)}</span></div>
      <div class="field"><span class="label">Vendedor</span><span class="value">${display(snapshot.pedido.vendedor)}</span></div>
      <div class="field"><span class="label">Data do Pedido</span><span class="value">${display(snapshot.pedido.data)}</span></div>
      <div class="field"><span class="label">Nome</span><span class="value">${display(snapshot.pedido.nome)}</span></div>
      <div class="field"><span class="label">Cliente</span><span class="value">${display(snapshot.pedido.cliente)}</span></div>
      <div class="field"><span class="label">Data da Entrega</span><span class="value">${display(snapshot.pedido.data_entrega_confirmada)}</span></div>
      <div class="field"><span class="label">Aplicacao</span><span class="value">${display(snapshot.pedido.aplicacao)}</span></div>
    </section>
    <h2>Itens, especificacoes e grade</h2>
    <table>
      <thead><tr><th style="width:3%">#</th><th style="width:7%">Item</th><th style="width:8%">Modelo</th><th style="width:13%">Malha</th><th style="width:9%">Frente</th><th style="width:9%">Costas</th><th style="width:9%">Manga direita</th><th style="width:9%">Manga esquerda</th><th style="width:10%">Vies gola</th><th style="width:9%">Vies mangas</th><th style="width:7%">Tam</th><th style="width:7%">Qtd.</th></tr></thead>
      <tbody>${rows.join('')}<tr class="total"><td colspan="11">TOTAL DE PECAS</td><td class="numero">${display(snapshot.pedido.quantidade_total)}</td></tr></tbody>
    </table>
    <section class="observacoes"><strong>Observacoes do pedido</strong><ol>${snapshot.pedido.observacoes.map((/** @type {string} */ note) => `<li>${display(note)}</li>`).join('')}</ol></section>

    <section class="page-break">
      <header>
        <div><div class="marca">SILMER</div><h1>CONTROLE DE PRODUCAO</h1></div>
        <div><div class="synthetic">Campos intencionalmente vazios</div><p style="margin-top:5px;text-align:right">Pedido ${display(snapshot.pedido.numero)}</p></div>
      </header>
      <p class="production-note">Estes campos pertencem a producao e arte. Eles devem sair vazios na Ficha aprovada pelo comercial e ser preenchidos somente pela equipe responsavel.</p>
      <div class="production-grid">
        ${productionFields
          .map(
            ([label, field]) =>
              `<div class="production-field${field.includes('observacao') ? ' wide' : ''}"><strong>${display(label)}</strong><span class="campo-producao-vazio">${display(snapshot.producao[field])}</span></div>`,
          )
          .join('')}
      </div>
      <div class="review-box"><strong>Gate humano pendente.</strong> Rose e Operacao devem revisar legibilidade, conteudo, ordem, grade, totais e impressao. Correcoes geram nova versao; este arquivo nao registra aprovacao.</div>
    </section>
  </body>
</html>`;
}

/** @param {any} gate */
export function buildReviewPageHtml(gate) {
  const canonicalFile = gate.artifact.path.split('/').at(-1);
  const legacyFile = gate.legacyArtifact.path.split('/').at(-1);
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Revisao da Ficha - Silmer</title>
    <style>
      :root { color-scheme: light; --canvas: #f7f6fb; --surface: #fff; --raised: #f0eef8; --text: #1b1530; --muted: #625b75; --border: #d8d4e4; --accent: #ff5b01; --deep: #0c042d; --link: #5b3fd1; }
      * { box-sizing: border-box; }
      body { align-items: center; background: var(--canvas); color: var(--text); display: flex; font-family: Poppins, Arial, sans-serif; justify-content: center; margin: 0; min-height: 100vh; padding: 32px 20px; }
      main { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 18px 50px rgba(12, 4, 45, .08); max-width: 720px; padding: 36px; width: 100%; }
      .eyebrow { color: var(--link); font-size: .75rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
      h1 { color: var(--deep); font-size: clamp(1.8rem, 5vw, 2.75rem); letter-spacing: -.04em; line-height: 1.05; margin: 8px 0 14px; }
      p { color: var(--muted); line-height: 1.6; margin: 0; }
      .notice { background: #fff0e7; border-left: 4px solid var(--accent); border-radius: 0 8px 8px 0; color: #5b280a; margin: 24px 0; padding: 14px 16px; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; }
      .button { border: 2px solid transparent; border-radius: 10px; display: inline-flex; font-weight: 800; justify-content: center; min-height: 48px; padding: 13px 18px; text-decoration: none; }
      .button:focus-visible { outline: 3px solid #ffb88f; outline-offset: 3px; }
      .button-primary { background: var(--accent); color: #241006; }
      .button-primary:hover { background: #e94f00; color: white; }
      .button-secondary { background: var(--raised); border-color: var(--border); color: var(--deep); }
      .button-secondary:hover { border-color: var(--link); color: var(--link); }
      .legacy-note { font-size: .85rem; margin-top: 18px; }
      @media (max-width: 540px) { main { padding: 26px 20px; } .button { width: 100%; } }
    </style>
  </head>
  <body>
    <main>
      <span class="eyebrow">Issue #7 · T00.4</span>
      <h1>Escolha a Ficha para revisao</h1>
      <p>A nova Ficha organiza o pedido por blocos operacionais e preserva todos os campos comerciais e de producao.</p>
      <p class="notice"><strong>Gate humano pendente.</strong> Os arquivos usam somente dados sinteticos e nao representam aprovacao de Rose ou Operacao.</p>
      <div class="actions">
        <a class="button button-primary" href="./${display(canonicalFile)}" download>${display(gate.artifact.downloadLabel)}</a>
        <a class="button button-secondary" href="./${display(legacyFile)}" download>${display(gate.legacyArtifact.downloadLabel)}</a>
      </div>
      <p class="legacy-note">A ficha legada preserva temporariamente a visualizacao tabular anterior como opcao de contingencia.</p>
    </main>
  </body>
</html>`;
}

// ficha-canonical-v3 (ADR 017): the same review discipline as v2 for the
// sheet with the seven points. The sample is an order in the public Order
// contract, so the reviewed PDF goes through the same `printSnapshot` the
// print route uses; only the sample band and the review box are added.

/** @param {unknown} value */
function isIsoDay(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  );
}

/** @param {any} item */
function itemExtras(item) {
  return EXTRA_FIELDS.map(({ field }) => item[field]).filter(nonEmptyString);
}

/**
 * The v3 review sample: synthetic, complete in the seven points, and built to
 * show the PO every rule the paper follows (an item with and one without
 * extras, "NAO APLICAVEL", a long text, six or more sizes, the delivery that
 * happened not recorded yet and a continuation page).
 *
 * @param {any} sample
 */
export function validateFichaSnapshotV3(sample) {
  invariant(sample?.schemaVersion === 1, 'v3 sample schema version must be 1');
  invariant(
    sample.task === 'T63' && sample.adr === '017',
    'v3 sample must trace to T63 and ADR 017',
  );
  invariant(sample.syntheticOnly === true, 'v3 sample must be synthetic only');
  invariant(
    sample.snapshotVersion === 'synthetic-order-v3' &&
      sample.templateVersion === TEMPLATE_V3,
    'v3 sample and template versions must be explicit',
  );
  invariant(
    Number.isFinite(Date.parse(sample.generatedAt)),
    'v3 sample generation time must be ISO 8601',
  );

  const order = sample.order;
  invariant(
    typeof order?.number === 'string' && /^\d{2,}-CRM$/u.test(order.number),
    'v3 sample needs an NN-CRM number',
  );
  invariant(
    order.fabCode === '01',
    'v3 sample FAB must use controlled code 01',
  );
  invariant(order.status === 'confirmado', 'Only a confirmed order prints');
  invariant(
    nonEmptyString(order.confirmedBy?.name),
    'v3 sample needs who confirmed it',
  );
  invariant(
    isIsoDay(order.orderDate) &&
      Number.isFinite(Date.parse(order.firstContactAt)),
    'v3 sample needs the order date and the first contact',
  );
  for (const field of ['paidOn', 'deliveredOn']) {
    invariant(
      order[field] === null || isIsoDay(order[field]),
      `v3 sample ${field} must be an ISO day or null`,
    );
  }
  // ADR 017: for now generating the order implies payment, so the sample
  // records it; the delivery that happened comes after the sale and shows
  // how the paper marks a day not recorded yet.
  invariant(
    order.deliveredOn === null,
    'v3 sample must show the delivery that happened not recorded yet',
  );

  const summary = order.ficha?.summary;
  for (const field of ['cliente', 'nome', 'aplicacao']) {
    invariant(
      nonEmptyString(summary?.[field]),
      `Summary field ${field} is required`,
    );
  }
  invariant(
    isIsoDay(summary.data_entrega_confirmada),
    'v3 sample needs the promised delivery day',
  );

  const items = order.ficha.items;
  invariant(
    Array.isArray(items) && items.length >= 3,
    'v3 sample needs at least three items',
  );
  let gradeTotal = 0;
  for (const [itemIndex, item] of items.entries()) {
    for (const field of ['tipo', 'cor', 'estampa', 'gola']) {
      invariant(
        nonEmptyString(item?.[field]),
        `Principal point items[${itemIndex}].${field} is required`,
      );
    }
    invariant(
      Array.isArray(item.malhas) &&
        item.malhas.length > 0 &&
        item.malhas.every(nonEmptyString),
      `Principal point items[${itemIndex}].malhas is required`,
    );
    for (const { field } of EXTRA_FIELDS) {
      invariant(
        typeof item[field] === 'string',
        `Extra items[${itemIndex}].${field} must be text, even when blank`,
      );
    }
    invariant(
      Array.isArray(item.grade) && item.grade.length > 0,
      `Item ${itemIndex + 1} needs a grade`,
    );
    const sizes = new Set();
    for (const [gradeIndex, grade] of item.grade.entries()) {
      invariant(
        nonEmptyString(grade?.tamanho) &&
          Number.isInteger(grade.quantidade) &&
          grade.quantidade > 0,
        `Item ${itemIndex + 1} grade ${gradeIndex + 1} needs a size and a positive integer quantity`,
      );
      invariant(
        !sizes.has(grade.tamanho),
        `Item ${itemIndex + 1} cannot repeat size ${grade.tamanho}`,
      );
      sizes.add(grade.tamanho);
      gradeTotal += grade.quantidade;
    }
  }
  invariant(
    items.some((/** @type {any} */ item) => itemExtras(item).length === 0) &&
      items.some((/** @type {any} */ item) => itemExtras(item).length > 0),
    'v3 sample needs an item without extras and one with extras',
  );
  invariant(
    items.some((/** @type {any} */ item) =>
      itemExtras(item).includes(NOT_APPLICABLE),
    ),
    `v3 sample needs an extra marked ${NOT_APPLICABLE}`,
  );
  invariant(
    items.some((/** @type {any} */ item) => item.grade.length >= 6),
    'v3 sample needs an item with six or more sizes',
  );
  invariant(
    items.some((/** @type {any} */ item) =>
      ['tipo', 'cor', 'estampa', 'gola'].some(
        (field) => item[field].length >= 80,
      ),
    ),
    'v3 sample needs a long principal text',
  );
  invariant(
    order.totalPieces === gradeTotal,
    'Order total must equal the sum of every grade quantity',
  );
  invariant(
    Array.isArray(order.ficha.observations) &&
      order.ficha.observations.length > 0 &&
      order.ficha.observations.every(nonEmptyString),
    'Ordered synthetic observations are required',
  );
  invariant(
    !containsPersonalContact(JSON.stringify(sample)),
    'Synthetic snapshot must not contain email addresses or phone numbers',
  );
  return { gradeTotal };
}

/**
 * The v3 review document: the order goes through the print snapshot and the
 * v3 template exactly as a printed order does, with the sample band and the
 * review box on.
 *
 * @param {any} sample
 */
export function buildFichaHtmlV3(sample) {
  validateFichaSnapshotV3(sample);
  const html = renderFichaHtmlV3(printSnapshot(sample.order, TEMPLATE_V3), {
    synthetic: true,
  });
  invariant(
    html.includes('<section class="page-break continuation">'),
    'v3 sample needs a continuation page',
  );
  return html;
}

/**
 * The pages the v3 template planned: page 1, each continuation page and the
 * production control. A PDF with another count broke a page by itself.
 *
 * @param {string} html
 */
export function plannedPages(html) {
  return (html.match(/<section class="page-break/gu) ?? []).length + 1;
}

/**
 * The v3 gate mirrors v2: hashes of the sample, of the rendered HTML (which a
 * different machine reproduces byte for byte, unlike the PDF) and of the PDF,
 * and a human approval by Rose and Operação that is wholly pending or wholly
 * approved. They sign the printed sample by hand; the Tech Lead records the
 * day, the reviewers and where the signed paper is kept once the PO confirms
 * the signature.
 *
 * @param {{artifactBytes: Buffer, evidence?: any, gate: any, renderedHtml: string, snapshotBytes: Buffer}} input
 */
export function validateFichaApprovalGateV3({
  artifactBytes,
  evidence = null,
  gate,
  renderedHtml,
  snapshotBytes,
}) {
  invariant(gate?.schemaVersion === 1, 'v3 gate schema version must be 1');
  invariant(
    gate.task === 'T63' && gate.adr === '017',
    'v3 gate must trace to T63 and ADR 017',
  );
  invariant(gate.syntheticOnly === true, 'v3 gate must be synthetic only');
  invariant(
    JSON.stringify(gate.requirements) === JSON.stringify(V3_REQUIREMENTS),
    `v3 gate must trace ${V3_REQUIREMENTS.join(', ')}`,
  );
  invariant(
    gate.snapshotVersion === 'synthetic-order-v3' &&
      gate.templateVersion === TEMPLATE_V3,
    'v3 gate versions must match the review package',
  );
  invariant(
    gate.snapshotSha256 === sha256(snapshotBytes),
    'v3 sample SHA-256 does not match the versioned sample',
  );
  invariant(
    gate.renderedHtmlSha256 === sha256(renderedHtml),
    'v3 rendered HTML SHA-256 does not match: the template changed after the PDF',
  );
  invariant(
    artifactBytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
      artifactBytes.length > 10_000,
    'v3 review artifact must be a non-empty PDF',
  );
  invariant(
    gate.artifact?.path === V3_ARTIFACT_PATH,
    'v3 review artifact path must be stable',
  );
  invariant(
    gate.artifact.sha256 === sha256(artifactBytes),
    'v3 artifact SHA-256 does not match the versioned PDF',
  );
  invariant(
    Number.isInteger(gate.artifact.pageCount) &&
      gate.artifact.pageCount >= 2 &&
      gate.artifact.pageCount === countPdfPages(artifactBytes),
    'v3 artifact page count must match a PDF with at least two pages',
  );
  invariant(
    gate.artifact.pageCount === plannedPages(renderedHtml),
    'v3 PDF pages must be the pages the template planned',
  );

  const approval = gate.approval;
  const criteria = Object.values(approval?.criteria ?? {});
  invariant(
    JSON.stringify(Object.keys(approval?.criteria ?? {})) ===
      JSON.stringify(approvalCriteria),
    'Ficha approval must record every canonical review criterion in order',
  );
  // As in v2, Rose and Operação review; in v3 they sign the printed sample
  // by hand, and the record says where that paper is kept.
  invariant(
    JSON.stringify(Object.keys(approval?.reviewedBy ?? {})) ===
      JSON.stringify(['rose', 'operation']) &&
      approval.signature === 'physical',
    'v3 approval is a physical signature by Rose and Operação',
  );
  const pending =
    approval?.status === 'pending-human-approval' &&
    approval.approved === false &&
    approval.reviewedBy.rose === null &&
    approval.reviewedBy.operation === null &&
    approval.reviewedAt === null &&
    approval.signedPaperKeptAt === null &&
    approval.evidenceRef === null &&
    criteria.every((value) => value === null);
  const approved =
    approval?.status === 'approved' &&
    approval.approved === true &&
    nonEmptyString(approval.reviewedBy.rose) &&
    nonEmptyString(approval.reviewedBy.operation) &&
    Number.isFinite(Date.parse(approval.reviewedAt)) &&
    nonEmptyString(approval.signedPaperKeptAt) &&
    criteria.every((value) => value === true) &&
    approval.evidenceRef === V3_EVIDENCE_PATH;
  invariant(
    pending || approved,
    'Ficha human approval must be wholly pending or wholly approved',
  );
  if (approved) validateFichaApprovalEvidenceV3(evidence, gate);
  invariant(
    approval.requiredBefore === V3_FINAL_REQUIRED_BEFORE,
    'The physical signature by Rose and Operação is required before production',
  );
  validateFichaProvisionalApprovalV3(gate);
  invariant(
    gate.versioning?.overwriteApprovedVersion === false &&
      gate.versioning?.correctionsRequireNewTemplateVersion === true &&
      gate.versioning?.supersedesTemplateVersion === TEMPLATE_V2,
    'Approved Ficha versions must never be overwritten',
  );
  return gate;
}

/**
 * ADR 017 (PO, 03/10/2026): the first of the two approval stages. The PO
 * approves the v3 for development and cloud-dev, locking the sample, the
 * rendered HTML and the PDF he approved; the final approval, the physical
 * signature by Rose and Operação, stays required before production.
 *
 * @param {any} gate
 */
export function validateFichaProvisionalApprovalV3(gate) {
  const provisional = gate?.provisionalApproval;
  invariant(
    provisional?.scope === V3_PROVISIONAL_SCOPE &&
      provisional.decisionRef === V3_ADR_PATH,
    `v3 provisional approval covers ${V3_PROVISIONAL_SCOPE} only and traces to ADR 017`,
  );
  const pending =
    provisional.status === 'pending-human-approval' &&
    provisional.approved === false &&
    provisional.reviewedBy === null &&
    provisional.reviewedAt === null &&
    provisional.snapshotSha256 === null &&
    provisional.renderedHtmlSha256 === null &&
    provisional.artifactSha256 === null;
  const approved =
    provisional.status === 'approved' &&
    provisional.approved === true &&
    provisional.reviewedBy?.role === 'PO' &&
    nonEmptyString(provisional.reviewedBy?.name) &&
    Number.isFinite(Date.parse(provisional.reviewedAt));
  invariant(
    pending || approved,
    'v3 provisional approval must be wholly pending or wholly approved',
  );
  if (approved) {
    invariant(
      provisional.snapshotSha256 === gate.snapshotSha256 &&
        provisional.renderedHtmlSha256 === gate.renderedHtmlSha256 &&
        provisional.artifactSha256 === gate.artifact?.sha256,
      'v3 provisional approval locks the sample, HTML and PDF the PO approved',
    );
  }
  return provisional;
}

/** @param {any} gate the v3 record: which approvals hold, stage by stage */
export function fichaV3ApprovalStages(gate) {
  return {
    final: gate?.approval?.status === 'approved' && gate.approval.approved,
    provisional:
      gate?.provisionalApproval?.status === 'approved' &&
      gate.provisionalApproval.approved === true,
  };
}

/** @param {any} evidence @param {any} gate */
export function validateFichaApprovalEvidenceV3(evidence, gate) {
  invariant(
    evidence?.schemaVersion === 1 &&
      evidence.task === 'T63' &&
      evidence.adr === '017' &&
      evidence.syntheticOnly === true,
    'Approved evidence must be synthetic and trace to T63/ADR 017',
  );
  invariant(
    evidence.templateVersion === gate.templateVersion &&
      evidence.snapshotVersion === gate.snapshotVersion &&
      evidence.snapshotSha256 === gate.snapshotSha256 &&
      evidence.renderedHtmlSha256 === gate.renderedHtmlSha256 &&
      evidence.artifactSha256 === gate.artifact.sha256,
    'Approved evidence must identify the exact snapshot, template, and artifact',
  );
  invariant(
    evidence.reviewedAt === gate.approval.reviewedAt &&
      JSON.stringify(evidence.reviewedBy) ===
        JSON.stringify(gate.approval.reviewedBy) &&
      JSON.stringify(evidence.criteria) ===
        JSON.stringify(gate.approval.criteria) &&
      evidence.signature === 'physical' &&
      evidence.signedPaperKeptAt === gate.approval.signedPaperKeptAt,
    'Approved evidence must match the human review recorded in the gate',
  );
  invariant(
    Array.isArray(evidence.visualEvidence) &&
      evidence.visualEvidence.length > 0 &&
      evidence.visualEvidence.every(
        (/** @type {any} */ item) =>
          item?.containsPii === false &&
          ['git', 'silmer'].includes(item.type) &&
          new RegExp(`^${item.type}:[a-zA-Z0-9._-]+$`, 'u').test(item.ref),
      ),
    'Approved evidence needs at least one PII-free git or Silmer visual reference',
  );
  invariant(
    !containsPersonalContact(JSON.stringify(evidence)),
    'Approved evidence must not contain email addresses or phone numbers',
  );
  return evidence;
}

/**
 * PIM-10 (ADR 017): `PRINT_TEMPLATE` may name v3 only once an approval of v3
 * is recorded: the PO's provisional one (development and cloud-dev) or the
 * final physical signature by Rose and Operação. Without either, every
 * printed order stays on the approved v2. Production also needs the final
 * signature: that is a go-live gate (EASYPANEL-TOPOLOGY.md, section 12).
 *
 * ADR 020: v5 likewise needs the PO's provisional approval of its sample,
 * and so does v6 (ADR 025). OLIST-50 (RFC 050): v7 is addressable but not
 * selected; the validator refuses PRINT_TEMPLATE = v7 until its approval is
 * recorded. ADR 078: v8 follows the same rule.
 *
 * @param {{gate: any, gateV4?: any, gateV5?: any, gateV6?: any, gateV7?: any, gateV8?: any, printTemplate: string}} input
 */
export function validateFichaPrintSwitch({
  gate,
  gateV4,
  gateV5,
  gateV6,
  gateV7,
  gateV8,
  printTemplate,
}) {
  invariant(
    [
      TEMPLATE_V2,
      TEMPLATE_V3,
      TEMPLATE_V4,
      TEMPLATE_V5,
      TEMPLATE_V6,
      TEMPLATE_V7,
      TEMPLATE_V8,
    ].includes(printTemplate),
    'PRINT_TEMPLATE must name a known ficha template',
  );
  const stages = fichaV3ApprovalStages(gate);
  invariant(
    printTemplate !== TEMPLATE_V3 ||
      (gate?.templateVersion === TEMPLATE_V3 &&
        (stages.provisional || stages.final)),
    'PRINT_TEMPLATE selects ficha-canonical-v3 before its approval is recorded',
  );
  const v4Stages = fichaV4ApprovalStages(gateV4);
  invariant(
    printTemplate !== TEMPLATE_V4 ||
      (gateV4?.templateVersion === TEMPLATE_V4 &&
        (v4Stages.provisional || v4Stages.final)),
    'PRINT_TEMPLATE selects ficha-canonical-v4 before its approval is recorded',
  );
  const v5Stages = fichaV5ApprovalStages(gateV5);
  invariant(
    printTemplate !== TEMPLATE_V5 ||
      (gateV5?.templateVersion === TEMPLATE_V5 &&
        (v5Stages.provisional || v5Stages.final)),
    'PRINT_TEMPLATE selects ficha-canonical-v5 before its approval is recorded',
  );
  const v6Stages = fichaV6ApprovalStages(gateV6);
  invariant(
    printTemplate !== TEMPLATE_V6 ||
      (gateV6?.templateVersion === TEMPLATE_V6 &&
        (v6Stages.provisional || v6Stages.final)),
    'PRINT_TEMPLATE selects ficha-canonical-v6 before its approval is recorded',
  );
  const v7Stages = fichaV7ApprovalStages(gateV7);
  invariant(
    printTemplate !== TEMPLATE_V7 ||
      (gateV7?.templateVersion === TEMPLATE_V7 &&
        (v7Stages.provisional || v7Stages.final)),
    'PRINT_TEMPLATE selects ficha-canonical-v7 before its approval is recorded',
  );
  const v8Stages = fichaV8ApprovalStages(gateV8);
  invariant(
    printTemplate !== TEMPLATE_V8 ||
      (gateV8?.templateVersion === TEMPLATE_V8 &&
        (v8Stages.provisional || v8Stages.final)),
    'PRINT_TEMPLATE selects ficha-canonical-v8 before its approval is recorded',
  );
}

/** @param {Buffer} bytes */
function countPdfPages(bytes) {
  return (bytes.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? []).length;
}

async function readPackage() {
  const snapshotBytes = await readFile(snapshotUrl);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  const gate = JSON.parse(await readFile(gateUrl, 'utf8'));
  return { gate, snapshot, snapshotBytes };
}

async function generate() {
  const { chromium } = await import('@playwright/test');
  const { gate, snapshot, snapshotBytes } = await readPackage();
  invariant(
    gate.approval?.status === 'pending-human-approval' &&
      gate.approval.approved === false,
    'Approved PDF versions cannot be regenerated or overwritten',
  );
  const artifactUrl = new URL(gate.artifact.path, rootUrl);
  const artifactPath = fileURLToPath(artifactUrl);
  const legacyArtifactUrl = new URL(gate.legacyArtifact.path, rootUrl);
  const reviewPageUrl = new URL(gate.reviewPage.path, rootUrl);
  await mkdir(dirname(artifactPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(buildFichaHtml(snapshot), { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      displayHeaderFooter: true,
      footerTemplate: `<div style="box-sizing:border-box;color:#657086;display:flex;font-family:Arial,sans-serif;font-size:7px;justify-content:space-between;padding:0 9mm;width:100%"><span>Template ${display(snapshot.templateVersion)} | Snapshot ${display(snapshot.snapshotVersion)} | Issue #7 | T00.4</span><span>Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`,
      format: 'A4',
      headerTemplate: '<div></div>',
      landscape: true,
      path: artifactPath,
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }

  const artifactBytes = await readFile(artifactUrl);
  const legacyArtifactBytes = await readFile(legacyArtifactUrl);
  gate.snapshotSha256 = sha256(snapshotBytes);
  gate.artifact.sha256 = sha256(artifactBytes);
  gate.artifact.pageCount = countPdfPages(artifactBytes);
  gate.legacyArtifact.sha256 = sha256(legacyArtifactBytes);
  gate.legacyArtifact.pageCount = countPdfPages(legacyArtifactBytes);
  const reviewPageHtml = buildReviewPageHtml(gate);
  await writeFile(reviewPageUrl, reviewPageHtml);
  await writeFile(
    gateUrl,
    await format(JSON.stringify(gate), { parser: 'json' }),
  );
  validateFichaApprovalGate({
    artifactBytes,
    gate,
    legacyArtifactBytes,
    reviewPageHtml,
    snapshotBytes,
  });
  console.log(
    `Ficha review PDFs ready: ${gate.artifact.path} (new) and ${gate.legacyArtifact.path} (legacy).`,
  );
}

async function validate() {
  const { gate, snapshot, snapshotBytes } = await readPackage();
  validateFichaSnapshot(snapshot);
  const artifactBytes = await readFile(new URL(gate.artifact.path, rootUrl));
  const legacyArtifactBytes = await readFile(
    new URL(gate.legacyArtifact.path, rootUrl),
  );
  const reviewPageHtml = await readFile(
    new URL(gate.reviewPage.path, rootUrl),
    'utf8',
  );
  const evidence = gate.approval.evidenceRef
    ? JSON.parse(
        await readFile(new URL(gate.approval.evidenceRef, rootUrl), 'utf8'),
      )
    : null;
  validateFichaApprovalGate({
    artifactBytes,
    evidence,
    gate,
    legacyArtifactBytes,
    reviewPageHtml,
    snapshotBytes,
  });
  console.log(
    `Ficha PDF review gate valid: ${gate.approval.status}; Rose/Operation approval remains explicit.`,
  );
}

async function readPackageV3() {
  const snapshotBytes = await readFile(snapshotV3Url);
  const sample = JSON.parse(snapshotBytes.toString('utf8'));
  return { sample, snapshotBytes };
}

/** @param {any} gate */
export function refuseApprovedRegeneration(gate) {
  invariant(
    gate?.approval?.status !== 'approved' &&
      gate?.approval?.approved !== true &&
      gate?.provisionalApproval?.status !== 'approved' &&
      gate?.provisionalApproval?.approved !== true,
    'Approved PDF versions cannot be regenerated or overwritten',
  );
}

async function generateV3() {
  const { chromium } = await import('@playwright/test');
  const current = await readFile(gateV3Url, 'utf8').then(
    (text) => JSON.parse(text),
    () => null,
  );
  refuseApprovedRegeneration(current);
  const { sample, snapshotBytes } = await readPackageV3();
  const renderedHtml = buildFichaHtmlV3(sample);
  const artifactUrl = new URL(V3_ARTIFACT_PATH, rootUrl);
  const artifactPath = fileURLToPath(artifactUrl);
  await mkdir(dirname(artifactPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(renderedHtml, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      displayHeaderFooter: true,
      footerTemplate: `<div style="box-sizing:border-box;color:#657086;display:flex;font-family:Arial,sans-serif;font-size:7px;justify-content:space-between;padding:0 9mm;width:100%"><span>Template ${display(sample.templateVersion)} | Snapshot ${display(sample.snapshotVersion)} | ADR 017 | T63</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`,
      format: 'A4',
      headerTemplate: '<div></div>',
      landscape: true,
      path: artifactPath,
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }

  const artifactBytes = await readFile(artifactUrl);
  const gate = {
    schemaVersion: 1,
    task: 'T63',
    adr: '017',
    requirements: V3_REQUIREMENTS,
    syntheticOnly: true,
    snapshotVersion: sample.snapshotVersion,
    templateVersion: sample.templateVersion,
    snapshotSha256: sha256(snapshotBytes),
    renderedHtmlSha256: sha256(renderedHtml),
    artifact: {
      path: V3_ARTIFACT_PATH,
      sha256: sha256(artifactBytes),
      pageCount: countPdfPages(artifactBytes),
    },
    provisionalApproval: {
      status: 'pending-human-approval',
      approved: false,
      scope: V3_PROVISIONAL_SCOPE,
      reviewedBy: null,
      reviewedAt: null,
      snapshotSha256: null,
      renderedHtmlSha256: null,
      artifactSha256: null,
      decisionRef: V3_ADR_PATH,
    },
    approval: {
      status: 'pending-human-approval',
      approved: false,
      requiredBefore: V3_FINAL_REQUIRED_BEFORE,
      signature: 'physical',
      reviewedBy: { rose: null, operation: null },
      reviewedAt: null,
      signedPaperKeptAt: null,
      criteria: Object.fromEntries(
        approvalCriteria.map((criterion) => [criterion, null]),
      ),
      evidenceRef: null,
    },
    versioning: {
      overwriteApprovedVersion: false,
      correctionsRequireNewTemplateVersion: true,
      supersedesTemplateVersion: TEMPLATE_V2,
    },
  };
  validateFichaApprovalGateV3({
    artifactBytes,
    gate,
    renderedHtml,
    snapshotBytes,
  });
  await writeFile(
    gateV3Url,
    await format(JSON.stringify(gate), { parser: 'json' }),
  );
  console.log(
    `Ficha v3 review PDF ready: ${V3_ARTIFACT_PATH} (${gate.artifact.pageCount} pages); approval pending.`,
  );
}

async function validateV3() {
  const { sample, snapshotBytes } = await readPackageV3();
  const gate = JSON.parse(await readFile(gateV3Url, 'utf8'));
  const artifactBytes = await readFile(new URL(gate.artifact.path, rootUrl));
  const evidence = gate.approval?.evidenceRef
    ? JSON.parse(
        await readFile(new URL(gate.approval.evidenceRef, rootUrl), 'utf8'),
      )
    : null;
  validateFichaApprovalGateV3({
    artifactBytes,
    evidence,
    gate,
    renderedHtml: buildFichaHtmlV3(sample),
    snapshotBytes,
  });
  const gateV4 = await validateFichaReviewV4();
  const gateV5 = await validateFichaReviewV5();
  const gateV6 = await validateFichaReviewV6();
  const gateV7 = await validateFichaReviewV7();
  const gateV8 = await validateFichaReviewV8();
  validateFichaPrintSwitch({
    gate,
    gateV4,
    gateV5,
    gateV6,
    gateV7,
    gateV8,
    printTemplate: PRINT_TEMPLATE,
  });
  const stages = fichaV3ApprovalStages(gate);
  console.log(
    `Ficha v3 PDF review gate valid: provisional ${gate.provisionalApproval.status} (${gate.provisionalApproval.scope}); final ${gate.approval.status}${stages.final ? '' : ' (physical signature by Rose and Operação required before production)'}; v4 provisional ${gateV4.provisionalApproval.status}; v4 final ${gateV4.approval.status}; v5 provisional ${gateV5.provisionalApproval.status}; v5 final ${gateV5.approval.status}; v6 provisional ${gateV6.provisionalApproval.status}; v6 final ${gateV6.approval.status}; v7 provisional ${gateV7.provisionalApproval.status}; v7 final ${gateV7.approval.status}; v8 provisional ${gateV8.provisionalApproval.status}; v8 final ${gateV8.approval.status}; orders print on ${PRINT_TEMPLATE}.`,
  );
}

async function main() {
  const command = process.argv[2];
  const v3 = process.argv.slice(3).includes('--v3');
  if (command === '--generate') return v3 ? generateV3() : generate();
  if (command === '--validate') {
    await validate();
    return validateV3();
  }
  throw new Error('Use --generate [--v3] or --validate');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Ficha PDF review failed: ${error.message}`);
    process.exitCode = 1;
  });
}
