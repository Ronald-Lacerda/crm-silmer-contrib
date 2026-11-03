import { countOf, durationLabel } from './assistant-performance.js';

export const ORDER_ASSISTANCE_REASONS = Object.freeze([
  { value: 'not_ready', label: 'Cliente ainda não decidiu fechar' },
  { value: 'withdrawn', label: 'Cliente desistiu' },
  { value: 'unsupported', label: 'Produto ou serviço não atendido' },
  { value: 'wrong_product', label: 'Produto ou assunto incorreto' },
  { value: 'other', label: 'Outro motivo' },
]);

const STATES = Object.freeze({
  pending: 'Aguardando decisão',
  accepted: 'Pedido criado',
  deferred: 'Adiado pelo vendedor',
  rejected: 'Não vai seguir',
  obsolete: 'Conversa mudou; sugestão substituída',
  missed: 'Omissão registrada',
});

/** @param {unknown} status */
export function orderAssistanceStatus(status) {
  return Object.hasOwn(STATES, String(status))
    ? STATES[/** @type {keyof typeof STATES} */ (String(status))]
    : 'Decisão registrada';
}

/** @param {unknown} reason */
export function orderAssistanceReason(reason) {
  if (reason === 'ready') return 'Cliente confirmou o fechamento';
  return (
    ORDER_ASSISTANCE_REASONS.find((item) => item.value === reason)?.label ?? ''
  );
}

/** Only customer messages can ground a missed purchase confirmation.
 * @param {any[]} messages
 */
export function orderAssistanceEvidence(messages) {
  return messages
    .filter(
      (message) =>
        typeof message?.id === 'string' &&
        (message.direction === 'inbound' || message.sender_type === 'customer'),
    )
    .map((message) => ({
      id: message.id,
      text: String(
        message.text ??
          message.preview ??
          message.content?.text ??
          message.transcript?.text ??
          '',
      )
        .trim()
        .slice(0, 500),
      occurredAt: message.occurredAt ?? message.occurred_at ?? null,
    }));
}

/** Missing measurements must stay unknown instead of turning into zero.
 * @param {Record<string, any>} value
 */
export function orderAssistanceMetrics(value) {
  const number = new Intl.NumberFormat('pt-BR');
  const count = (/** @type {unknown} */ field) => {
    const parsed = countOf(field);
    return parsed === null ? '—' : number.format(parsed);
  };
  const elapsed = (/** @type {unknown} */ seconds) => {
    if (seconds === undefined || seconds === null || seconds === '')
      return 'Sem amostras no período';
    const parsed = Number(seconds);
    return Number.isFinite(parsed) && parsed >= 0
      ? durationLabel(parsed / 60)
      : 'Sem amostras no período';
  };
  return [
    { label: 'Sugestões feitas', value: count(value.suggestions) },
    { label: 'Aguardando decisão', value: count(value.pending) },
    { label: 'Pedidos criados pela sugestão', value: count(value.accepted) },
    { label: 'Adiadas', value: count(value.deferred) },
    { label: 'Não vão seguir', value: count(value.rejected) },
    { label: 'Omissões marcadas pelo vendedor', value: count(value.missed) },
    {
      label: 'Pedidos manuais sem sugestão',
      value: count(value.manualWithoutSuggestion),
    },
    {
      label: 'Tempo médio até a decisão',
      value: elapsed(value.averageDecisionSeconds),
    },
    {
      label: 'Tempo médio até criar o pedido',
      value: elapsed(value.averageCreationSeconds),
    },
    { label: 'Análises realizadas', value: count(value.observations) },
    { label: 'Análises que falharam', value: count(value.observationFailures) },
  ];
}
