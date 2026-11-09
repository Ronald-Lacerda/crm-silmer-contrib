/**
 * OLIST-T13: progresso por etapa, alvos de conferência e histórico seguro.
 *
 * Funções puras sobre a projeção mínima (`operation`) e o diagnóstico
 * administrativo (`resources`, `attempts`). Nada aqui lê rede, relógio ou
 * armazenamento; todo texto é fixo ou vem de uma allowlist, nunca do
 * provedor. Um estado incerto nunca produz ação criadora: apenas conferência.
 */
import { olistOperationReason } from './olist-feedback.js';

/** Etapas visíveis. Produto e variações compartilham uma linha do tempo. */
export const OLIST_STEPS = Object.freeze([
  { key: 'customer', label: 'Cliente' },
  { key: 'product', label: 'Produto e variações' },
  { key: 'sale', label: 'Venda' },
]);

/** Releitura limitada do CRM (nunca do ERP) enquanto a operação anda. */
export const OLIST_FOLLOW_DELAYS_MS = Object.freeze([
  4000, 8000, 15000, 30000, 60000,
]);

/** Releitura do resultado persistido de uma conferência (somente CRM). */
export const OLIST_RECONCILE_FOLLOW_MS = Object.freeze([3000, 6000, 12000]);

const STAGE_INDEX = /** @type {Record<string, number>} */ ({
  customer: 0,
  product: 1,
  variation: 1,
  sale: 2,
  complete: 3,
});
const STAGE_LABEL = /** @type {Record<string, string>} */ ({
  customer: 'Cliente',
  product: 'Produto',
  variation: 'Variação',
  sale: 'Venda',
  complete: 'Concluída',
});
const STATUS_LABEL = /** @type {Record<string, string>} */ ({
  done: 'Concluída',
  active: 'Em andamento',
  waiting: 'Aguardando',
  blocked: 'Bloqueada por incerteza',
  rejected: 'Rejeitada',
  invalidated: 'Invalidada',
  review_required: 'Conferência pendente',
});
const OUTCOME_LABEL = /** @type {Record<string, string>} */ ({
  reserved: 'Reservada',
  uncertain: 'Incerta',
  confirmed: 'Confirmada',
  rejected: 'Rejeitada',
});
const RESOURCE_STATE_LABEL = /** @type {Record<string, string>} */ ({
  pending: 'Pendente',
  reserved: 'Reservado',
  confirmed: 'Vinculado',
  uncertain: 'Incerto',
  rejected: 'Rejeitado',
});
const REQUEST_STATUS_LABEL = /** @type {Record<string, string>} */ ({
  queued: 'Na fila',
  succeeded: 'Leitura concluída',
  blocked: 'Sem prova do resultado',
});
const UNCERTAIN_STATES = [
  'uncertain',
  'outcome_unknown',
  'divergent',
  'reconciliation_required',
];
const UNCERTAIN_CODE =
  /OUTCOME_UNKNOWN|UNCERTAIN|RECONCILIATION_REQUIRED|DIVERGENT|AMBIGUOUS/u;
const IN_PROGRESS = ['queued', 'resolving', 'reserved', 'ready'];
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_REMOTE_ID = /^[A-Za-z0-9._:-]{1,64}$/u;
/** Código que o servidor grava ao invalidar uma geração por decisão de um
 * administrador (antes de qualquer venda). */
export const OLIST_INVALIDATED_CODE = 'OLIST_EXPORT_INVALIDATED';
export const OLIST_LEGACY_REVIEW_GUIDANCE =
  'Vínculo local retirado; a venda existente no Olist aguarda conferência. Novo envio bloqueado para evitar duplicidade.';

/** This historical hold is not an invalidation that permits a new send.
 * @param {any} operation */
export function isLegacyReviewRequired(operation) {
  return operation?.state === 'legacy_review_required';
}

/** @param {string|undefined} stage */
export function olistStageLabel(stage) {
  return STAGE_LABEL[stage ?? ''] ?? 'Etapa';
}
/** @param {string|undefined} outcome */
export function olistOutcomeLabel(outcome) {
  return OUTCOME_LABEL[outcome ?? ''] ?? 'Sem resultado';
}
/** @param {string|undefined} state */
export function olistResourceStateLabel(state) {
  return RESOURCE_STATE_LABEL[state ?? ''] ?? 'Sem estado';
}
/** @param {string|undefined} status */
export function olistRequestStatusLabel(status) {
  return REQUEST_STATUS_LABEL[status ?? ''] ?? 'Sem resultado';
}
/** Código público seguro ou nulo; nunca texto livre.
 * @param {unknown} code */
export function safeCode(code) {
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : null;
}
/** ID remoto observado, somente se parecer um identificador.
 * @param {unknown} id */
export function safeRemoteId(id) {
  return typeof id === 'string' && SAFE_REMOTE_ID.test(id) ? id : null;
}

/** Geração invalidada por um administrador: a operação fica arquivada e o
 * Pedido volta a poder gerar uma nova prévia (ADR 069).
 * @param {any} operation */
export function isAdminInvalidated(operation) {
  return (
    operation?.state === 'invalidated' &&
    operation?.errorCode === OLIST_INVALIDATED_CODE
  );
}

/** @param {any} operation */
export function isOperationUncertain(operation) {
  if (!operation) return false;
  if (['confirmed', 'linked'].includes(operation.state)) return false;
  return (
    UNCERTAIN_STATES.includes(operation.state) ||
    UNCERTAIN_CODE.test(String(operation.errorCode ?? ''))
  );
}
/** Operação ainda andando: vale a releitura limitada do CRM.
 * @param {any} operation */
export function isOperationInProgress(operation) {
  return (
    Boolean(operation) &&
    IN_PROGRESS.includes(operation.state) &&
    !isOperationUncertain(operation)
  );
}

/** Rótulo curto da operação; preserva os textos da T12.
 * @param {any} operation */
export function olistOperationHeadline(operation) {
  const state = operation?.state;
  if (isLegacyReviewRequired(operation))
    return 'Venda histórica aguarda conferência';
  if (state === 'confirmed' || state === 'linked')
    return 'Venda Olist conferida';
  if (isOperationUncertain(operation))
    return 'Operação bloqueada para conferência administrativa';
  if (state === 'rejected') return 'Operação Olist rejeitada';
  if (state === 'invalidated') return 'Operação Olist invalidada';
  return 'Operação Olist em acompanhamento';
}

/**
 * @param {number} done @param {number} total
 * @param {[string,string]} nouns singular e plural, já com o particípio
 */
function countPhrase(done, total, nouns) {
  return `${done} de ${total} ${total === 1 ? nouns[0] : nouns[1]}`;
}
const NOUNS = {
  customer: /** @type {[string,string]} */ ([
    'cliente vinculado',
    'clientes vinculados',
  ]),
  product: /** @type {[string,string]} */ ([
    'produto vinculado',
    'produtos vinculados',
  ]),
  variation: /** @type {[string,string]} */ ([
    'variação vinculada',
    'variações vinculadas',
  ]),
};

/** Contagem de cadastros concluídos a partir do diagnóstico administrativo.
 * @param {any[]|null|undefined} resources */
export function countResources(resources) {
  if (!Array.isArray(resources)) return null;
  const counts = {
    customer: { done: 0, total: 0 },
    product: { done: 0, total: 0 },
    variation: { done: 0, total: 0 },
  };
  for (const resource of resources) {
    const bucket = /** @type {any} */ (counts)[resource?.kind];
    if (!bucket) continue;
    bucket.total += 1;
    if (resource.state === 'confirmed') bucket.done += 1;
  }
  return counts;
}

/**
 * @param {ReturnType<typeof countResources>} counts
 * @param {string} key
 */
function stepCountDetail(counts, key) {
  if (!counts) return '';
  if (key === 'customer')
    return counts.customer.total
      ? countPhrase(counts.customer.done, counts.customer.total, NOUNS.customer)
      : '';
  if (key === 'product')
    return [
      counts.product.total
        ? countPhrase(counts.product.done, counts.product.total, NOUNS.product)
        : '',
      counts.variation.total
        ? countPhrase(
            counts.variation.done,
            counts.variation.total,
            NOUNS.variation,
          )
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
  return '';
}

/**
 * @typedef {{
 *   key: string, label: string, status: string, statusLabel: string,
 *   detail: string
 * }} OlistStep
 * @typedef {{
 *   signature: string, kind: string, headline: string, steps: OlistStep[],
 *   blockedLabel: string|null, reason: string, guidance: string[],
 *   saleNumber: string|null, origin: string|null, done: boolean,
 *   counts: ReturnType<typeof countResources>, countSignature: string
 * }} OlistProgress
 */

/**
 * @param {any} operation projeção mínima: {state, stage, number, errorCode?}
 * @param {any[]|null} [resources] diagnóstico administrativo, quando houver
 * @returns {OlistProgress|null}
 */
export function deriveOlistProgress(operation, resources = null) {
  if (!operation || typeof operation !== 'object') return null;
  const state = String(operation.state ?? '');
  const legacyReview = isLegacyReviewRequired(operation);
  const complete = state === 'confirmed' || state === 'linked';
  const uncertain = isOperationUncertain(operation);
  const current = complete ? 3 : (STAGE_INDEX[operation.stage] ?? 0);
  const counts = countResources(resources);
  const reason = olistOperationReason(operation.errorCode, state);
  const kind = legacyReview
    ? 'legacy_review_required'
    : complete
      ? 'done'
      : uncertain
        ? 'blocked'
        : state === 'rejected'
          ? 'rejected'
          : state === 'invalidated'
            ? 'invalidated'
            : state === 'queued' || state === 'ready'
              ? 'waiting'
              : 'active';
  const currentLabel = OLIST_STEPS[Math.min(current, 2)].label;
  const steps = OLIST_STEPS.map((step, index) => {
    /** @type {string} */
    let status = 'waiting';
    let detail = '';
    if (legacyReview) status = 'review_required';
    else if (complete || current > index) status = 'done';
    else if (index === current) {
      if (uncertain) status = 'blocked';
      else if (state === 'rejected') status = 'rejected';
      else if (state === 'invalidated') status = 'invalidated';
      else if (['resolving', 'reserved'].includes(state)) status = 'active';
      else status = 'waiting';
      if (status === 'waiting')
        detail =
          state === 'ready' ? 'Pronta para a venda.' : 'Na fila para iniciar.';
      if (status === 'active' && state === 'reserved')
        detail = 'Envio em andamento; aguarde o resultado sem repetir.';
      if (['blocked', 'rejected', 'invalidated'].includes(status))
        detail = reason;
    } else if (kind === 'blocked') {
      detail = `Aguarda a conferência da etapa ${currentLabel}.`;
    } else if (kind === 'rejected' || kind === 'invalidated') {
      detail = 'Não iniciada.';
    }
    const countDetail = stepCountDetail(counts, step.key);
    if (countDetail && status !== 'waiting')
      detail = detail ? `${detail} ${countDetail}.` : `${countDetail}.`;
    return {
      key: step.key,
      label: step.label,
      status,
      statusLabel: STATUS_LABEL[status],
      detail,
    };
  });
  /** @type {string[]} */
  const guidance = [];
  if (legacyReview) guidance.push(OLIST_LEGACY_REVIEW_GUIDANCE);
  if (kind === 'blocked')
    guidance.push(
      'A etapa pode já existir no Olist. Não repita a geração: uma pessoa administradora deve conferir a operação.',
    );
  if (kind === 'rejected')
    guidance.push(
      'A solicitação foi recusada nesta etapa. O CRM não oferece repetir a geração nem vincular uma venda a este pedido; leve o caso a quem cuida da integração.',
    );
  if (kind === 'invalidated')
    guidance.push(
      isAdminInvalidated(operation)
        ? 'Esta geração foi invalidada antes de qualquer venda. Gere uma nova prévia; cadastros já criados no Olist foram preservados.'
        : 'A operação foi invalidada antes de concluir. Nenhum cadastro já criado foi removido; peça a conferência administrativa.',
    );
  const saleNumber =
    typeof operation.number === 'string' && operation.number
      ? operation.number
      : null;
  return {
    signature: `${state}:${operation.stage ?? ''}:${operation.errorCode ?? ''}`,
    kind,
    headline: olistOperationHeadline(operation),
    steps,
    blockedLabel: kind === 'blocked' ? currentLabel : null,
    reason: ['blocked', 'rejected', 'invalidated'].includes(kind) ? reason : '',
    guidance,
    saleNumber,
    origin: state === 'linked' ? 'linked' : null,
    done: complete,
    counts,
    countSignature: counts
      ? [counts.customer, counts.product, counts.variation]
          .map((entry) => `${entry.done}/${entry.total}`)
          .join(' ')
      : '',
  };
}

/**
 * Anúncio curto da mudança relevante; vazio quando nada mudou. Nunca repete a
 * lista inteira de etapas.
 * @param {OlistProgress|null} previous @param {OlistProgress|null} next
 */
export function progressAnnouncement(previous, next) {
  if (!previous || !next) return '';
  const stateChanged = previous.signature !== next.signature;
  // The first arrival of the admin counts is not a change worth announcing.
  const countChanged =
    previous.countSignature !== '' &&
    next.countSignature !== '' &&
    previous.countSignature !== next.countSignature;
  if (!stateChanged && !countChanged) return '';
  if (next.kind === 'legacy_review_required')
    return OLIST_LEGACY_REVIEW_GUIDANCE;
  if (next.kind === 'done')
    return next.saleNumber
      ? `Operação concluída. Venda Olist ${next.saleNumber}.`
      : 'Operação concluída.';
  const focus =
    next.steps.find((step) =>
      ['blocked', 'rejected', 'invalidated', 'active'].includes(step.status),
    ) ??
    next.steps.find((step) => step.status === 'waiting') ??
    next.steps[0];
  if (next.kind === 'blocked')
    return `Etapa ${focus.label} bloqueada por incerteza. Não repita a geração; peça a conferência administrativa.`;
  const counts = countChanged ? stepCountDetail(next.counts, focus.key) : '';
  return `Etapa ${focus.label}: ${focus.statusLabel.toLowerCase()}.${counts ? ` ${counts}.` : ''}`;
}

/**
 * Alvos de "Conferir no Olist": recursos reservados, incertos ou rejeitados e a
 * venda quando a operação está reservada ou incerta. A versão esperada é a do
 * alvo.
 * @param {any} administration
 */
export function reconcileTargets(administration) {
  const operation = administration?.operation;
  if (!operation || isLegacyReviewRequired(operation)) return [];
  /** @type {Array<{key:string, stage:string, resourceId:string|null, expectedVersion:number, label:string, stateLabel:string, remoteId:string|null}>} */
  const targets = [];
  /** @type {Record<string, number>} */
  const seen = {};
  const total = /** @type {Record<string, number>} */ ({});
  for (const resource of administration.resources ?? [])
    total[resource.kind] = (total[resource.kind] ?? 0) + 1;
  for (const resource of administration.resources ?? []) {
    seen[resource.kind] = (seen[resource.kind] ?? 0) + 1;
    if (!['reserved', 'uncertain', 'rejected'].includes(resource.state))
      continue;
    targets.push({
      key: resource.id,
      stage: resource.kind,
      resourceId: resource.id,
      expectedVersion: Number(resource.version),
      label: resourceLabel(resource, seen[resource.kind], total[resource.kind]),
      stateLabel: olistResourceStateLabel(resource.state),
      remoteId: safeRemoteId(resource.remoteId),
    });
  }
  // Venda rejeitada ou invalidada não tem conferência: o servidor responde
  // OLIST_RECONCILIATION_REQUIRED (admin-repository.js, resolução da leitura);
  // o painel só informa.
  if (
    operation.stage === 'sale' &&
    ['reserved', 'uncertain'].includes(operation.state)
  )
    targets.push({
      key: 'sale',
      stage: 'sale',
      resourceId: null,
      expectedVersion: Number(operation.version),
      label: 'Venda',
      stateLabel: olistOperationHeadline(operation),
      remoteId: null,
    });
  return targets;
}

/** @param {any} resource @param {number} index @param {number} total */
export function resourceLabel(resource, index = 1, total = 1) {
  const suffix = String(resource.id ?? '').slice(-6);
  const kind = /** @type {Record<string,string>} */ ({
    customer: 'Cliente',
    product: 'Produto',
    variation: 'Variação',
  })[resource.kind];
  const base = kind ?? 'Cadastro';
  return total > 1 ? `${base} ${index} de ${total} (final ${suffix})` : base;
}

/** Vínculo manual só é aceito sem operação ou com operação ainda não
 * reservada (queued, resolving, ready): commitLink recusa qualquer outro
 * estado com OLIST_RESOURCE_RECONCILIATION_REQUIRED, e a prévia recusa
 * reservada, incerta e invalidada. Rejeitada não oferece ação, e uma operação
 * incerta por código também não, mesmo com outro estado. Uma geração invalidada
 * por um administrador conta como sem operação ativa.
 * @param {any} operation */
export function canOfferLink(operation) {
  return (
    !operation ||
    isAdminInvalidated(operation) ||
    (['queued', 'resolving', 'ready'].includes(operation.state) &&
      !isOperationUncertain(operation))
  );
}

/** A invalidação administrativa só é oferecida enquanto a geração ainda não
 * chegou à venda: operação em queued, resolving ou ready, nenhuma tentativa de
 * venda (qualquer desfecho) e nenhum cadastro reservado ou incerto. O servidor
 * é a autoridade e repete cada regra sob lock; aqui só se evita oferecer o que
 * será recusado. Sem `id` e `version` do diagnóstico não há comando possível.
 * @param {{operation: any, attempts?: any[]|null, resources?: any[]|null, cancelled?: boolean}} input */
export function canOfferInvalidate({
  operation,
  attempts,
  resources,
  cancelled = false,
}) {
  if (canWithdrawLegacyLink({ operation, attempts, resources, cancelled }))
    return true;
  if (cancelled || !operation) return false;
  if (!['queued', 'resolving', 'ready'].includes(operation.state)) return false;
  if (typeof operation.id !== 'string' || !operation.id) return false;
  if (!Number.isInteger(Number(operation.version)) || !operation.version)
    return false;
  if (
    (Array.isArray(attempts) ? attempts : []).some(
      (attempt) => attempt?.stage === 'sale',
    )
  )
    return false;
  return !(Array.isArray(resources) ? resources : []).some((resource) =>
    ['reserved', 'uncertain'].includes(resource?.state),
  );
}

/** The server flags only an isolated historical link. Missing diagnostics,
 * any effect, a canonical link or a protected hold never offer withdrawal.
 * @param {{operation:any,attempts?:any[]|null,resources?:any[]|null,cancelled?:boolean}} input */
export function canWithdrawLegacyLink({
  operation,
  attempts,
  resources,
  cancelled = false,
}) {
  return (
    !cancelled &&
    operation?.state === 'linked' &&
    operation.canWithdrawLegacyLink === true &&
    typeof operation.id === 'string' &&
    operation.id !== '' &&
    Number.isSafeInteger(Number(operation.version)) &&
    Number(operation.version) > 0 &&
    Array.isArray(attempts) &&
    attempts.length === 0 &&
    Array.isArray(resources) &&
    resources.length === 0
  );
}

/** Histórico seguro: somente campos allowlisted, nenhum texto remoto.
 * @param {any[]|undefined} attempts */
export function safeAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).map((attempt) => ({
    id: String(attempt.id),
    stage: olistStageLabel(attempt.stage),
    outcome: olistOutcomeLabel(attempt.outcome),
    outcomeKey: String(attempt.outcome ?? ''),
    code: safeCode(attempt.code),
    reason: attempt.code ? olistOperationReason(attempt.code, '') : '',
    remoteId: safeRemoteId(attempt.observedRemoteId),
    createdAt: attempt.createdAt ?? null,
    finishedAt: attempt.finishedAt ?? null,
  }));
}

/** @param {unknown} value */
export function olistTime(value) {
  const stamp = Date.parse(String(value ?? ''));
  return Number.isFinite(stamp)
    ? new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'America/Sao_Paulo',
      }).format(stamp)
    : 'Sem horário';
}
