// OLIST-T13 (RFC 050, ADR 068): regras puras da ação "Cancelar pedido", sem
// DOM, para a tela e o teste unitário concordarem sobre motivo, aviso e erros.

/** Limite do contrato: motivo de 1 a 1000 caracteres, sem controle. */
export const CANCEL_REASON_MAX = 1000;

/** @param {string} character */
function isControl(character) {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

/**
 * O servidor recusa caractere de controle (inclusive quebra de linha e tab) em
 * todo motivo (cancelamento, conferência, vínculo). Como o campo é um texto de
 * várias linhas, cada sequência de controle e de espaço vira um único espaço, e
 * as pontas são aparadas, antes de validar e de enviar.
 *
 * @param {unknown} text
 */
export function normalizeReasonText(text) {
  let spaced = '';
  for (const character of String(text ?? '')) {
    spaced += isControl(character) ? ' ' : character;
  }
  return spaced.replace(/\s+/gu, ' ').trim();
}

/** @param {unknown} text */
export function normalizeCancelReason(text) {
  return normalizeReasonText(text);
}

/**
 * Mensagem junto ao campo, ou '' quando o motivo já é aceito.
 *
 * @param {string} normalized resultado de normalizeCancelReason
 */
export function validateCancelReason(normalized) {
  if (normalized === '') return 'Informe o motivo do cancelamento.';
  if (normalized.length > CANCEL_REASON_MAX) {
    return `Use até ${CANCEL_REASON_MAX} caracteres no motivo.`;
  }
  return '';
}

/**
 * Pedido pago (marco de pagamento ou pagamento do site) ou da loja: o aviso
 * extra de que cancelar não devolve dinheiro nem mexe em gateway/checkout.
 *
 * @param {{origin?: string, paidOn?: string|null, gatewayPayment?: unknown}|null|undefined} order
 */
export function needsPaymentNotice(order) {
  return Boolean(
    order && (order.origin === 'loja' || order.paidOn || order.gatewayPayment),
  );
}

/**
 * @typedef {'offline'|'unavailable'|'unauthorized'|'forbidden'|'not-found'|'blocked'|'already'|'stale'|'invalid'|'unknown'} CancelErrorKind
 */

/**
 * O que uma falha de POST /orders/{id}/cancel significa para quem cancela. A
 * mensagem é escolhida aqui pelo código e pelo status, nunca pelo corpo da
 * resposta.
 *
 * - `retryable`: o resultado é incerto (sem conexão ou 5xx); o mesmo comando
 *   (mesma chave idempotente) pode ser reenviado.
 * - `closes`: o diálogo se encerra e o estado persistido é relido, sem
 *   oferecer nova tentativa (recusa definitiva do servidor).
 *
 * @param {any} cause
 * @returns {{kind: CancelErrorKind, message: string, retryable: boolean, closes: boolean, refresh: boolean}}
 */
export function describeCancelError(cause) {
  const status = Number(cause?.status) || 0;
  const code = String(cause?.code ?? '');
  /** @param {CancelErrorKind} kind @param {string} message @param {{retryable?: boolean, closes?: boolean, refresh?: boolean}} [flags] */
  const outcome = (kind, message, flags = {}) => ({
    kind,
    message,
    retryable: flags.retryable === true,
    closes: flags.closes === true,
    refresh: flags.refresh === true,
  });
  if (status === 0) {
    return outcome(
      'offline',
      'Sem conexão com o servidor. Não sabemos se o cancelamento foi registrado; tente de novo para conferir.',
      { retryable: true },
    );
  }
  if (status >= 500) {
    return outcome(
      'unavailable',
      'Serviço indisponível no momento. Não sabemos se o cancelamento foi registrado; tente de novo para conferir.',
      { retryable: true },
    );
  }
  if (status === 401) {
    return outcome(
      'unauthorized',
      'Sua sessão expirou. Entre de novo e confira se o pedido foi cancelado.',
    );
  }
  if (status === 403) {
    // O servidor usa o mesmo código FORBIDDEN para permissão, sessão, CSRF e
    // origem (operation-runtime.js authorizeWrite), então a tela não pode
    // afirmar "sem permissão": mantém o diálogo e o motivo, relê o pedido e
    // pede para conferir a sessão.
    return outcome(
      'forbidden',
      'O servidor recusou o cancelamento: sua sessão pode ter expirado ou você pode não ter mais permissão para este pedido. O motivo foi mantido. Entre de novo se for preciso; só o responsável ou um administrador cancela, e pedido da loja exige administrador.',
      { refresh: true },
    );
  }
  if (status === 404) {
    return outcome('not-found', 'Este pedido não foi encontrado.', {
      closes: true,
      refresh: true,
    });
  }
  if (status === 409) {
    if (code === 'ORDER_CANCELLATION_BLOCKED') {
      return outcome(
        'blocked',
        'Este pedido já tem venda reservada, enviada, vinculada ou em conferência no Olist e não pode ser cancelado aqui. O estado atual foi recarregado.',
        { closes: true, refresh: true },
      );
    }
    if (code === 'ORDER_CANCELLED') {
      return outcome(
        'already',
        'Este pedido já foi cancelado. O estado atual foi recarregado.',
        { closes: true, refresh: true },
      );
    }
    return outcome(
      'stale',
      'Este pedido mudou depois que você abriu a confirmação. Volte, confira o pedido atualizado e abra Cancelar pedido de novo; o motivo digitado será mantido.',
      { refresh: true },
    );
  }
  if (status === 400 || status === 422) {
    return outcome(
      'invalid',
      `Informe o motivo com até ${CANCEL_REASON_MAX} caracteres.`,
    );
  }
  return outcome(
    'unknown',
    'Não foi possível cancelar o pedido. Atualize a página e confira o estado antes de tentar de novo.',
  );
}
