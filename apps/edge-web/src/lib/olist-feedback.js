/** Fixed messages only: provider payloads and receipts never become UI copy. */
/** @param {any} cause */
export function olistFailure(cause) {
  const status = Number(cause?.status);
  const code = String(cause?.code ?? '');
  if ([401, 403].includes(status))
    return 'Seu acesso mudou ou sua sessão expirou. Entre novamente para continuar.';
  if (code === 'OLIST_PREVIEW_EXPIRED')
    return 'A prévia expirou. Confira uma nova prévia antes de continuar.';
  if (
    [
      'OLIST_PREVIEW_STALE',
      'OLIST_PREVIEW_INVALID',
      'OLIST_CONNECTION_CHANGED',
    ].includes(code)
  )
    return 'O pedido, cadastro ou configuração mudou. Confira uma nova prévia.';
  if (code === 'ORDER_CANCELLED')
    return 'Este pedido foi cancelado. A geração Olist está bloqueada.';
  if (
    ['OLIST_NOT_CONFIGURED', 'OLIST_RECONNECT_REQUIRED', 'OLIST_AUTH'].includes(
      code,
    )
  )
    return 'A conexão Olist precisa ser conferida por um administrador.';
  if (status === 404)
    return 'Pedido não encontrado. Confira seu identificador.';
  if (status === 429)
    return 'Limite de consultas atingido. Aguarde antes de conferir novamente.';
  if (status === 409)
    return 'A preparação mudou ou exige conferência administrativa. Atualize os dados.';
  return 'Não foi possível conferir o Olist agora. Atualize a preparação antes de continuar.';
}
/** @param {string|undefined} action */
export function registrationAction(action) {
  const labels = /** @type {Record<string,string>} */ ({
    create: 'criação prevista, ainda não executada',
    reuse: 'cadastro existente conferido',
    blocked: 'conferência pendente',
  });
  return labels[action ?? 'blocked'] ?? 'conferência pendente';
}
/** @param {{code:string,field?:string}} issue @param {any[]} [groups] */
export function olistIssueLabel(issue, groups = []) {
  const field = issue.field ?? '';
  const groupIndex = groups.findIndex((group) => field.includes(group.groupId));
  const group = groups[groupIndex];
  const line = group?.lines?.find((/** @type {any} */ line) =>
    field.includes(line.lineId),
  );
  const ids =
    /^(?:sizePricing|priceBreakdown)\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/iu.exec(
      field,
    );
  const context = group
    ? `Item ${groupIndex + 1}${line ? `, tamanho ${line.size}` : ''}: `
    : ids
      ? `Grupo ${ids[1]}, linha ${ids[2]}: `
      : '';
  const code = issue.code;
  if (/FRACTION/u.test(code) || code === 'OLIST_EXACT_CENT_REQUIRED')
    return (
      context +
      'O subtotal exige fração de centavo por unidade. O pedido continua válido no CRM; a exportação inteira está bloqueada.'
    );
  if (/SUBTOTAL|REVIEW/u.test(code))
    return context + 'Informe e revise o subtotal por tamanho.';
  if (/BUYER|CUSTOMER_FISCAL/u.test(code))
    return 'Cadastro do comprador incompleto ou divergente. Uma pessoa autorizada deve conferir os dados de origem.';
  if (/SETTINGS|PRODUCT_FISCAL/u.test(code))
    return 'Parâmetros comerciais ou fiscais precisam de conferência administrativa.';
  if (/SOURCE|BREAKDOWN/u.test(code))
    return 'A composição de preços ou os dados complementares do pedido precisam de revisão autorizada.';
  if (/RECONNECT|AUTH|CONNECTION/u.test(code))
    return 'A conexão Olist precisa de conferência administrativa.';
  if (/AMBIGUOUS|DIVERGENT|UNCERTAIN|RECONCILIATION/u.test(code))
    return (
      context +
      'Cadastro ou venda exige conferência administrativa; não repita a criação.'
    );
  if (/RATE_LIMIT/u.test(code))
    return 'Limite de consultas atingido. Aguarde antes de conferir novamente.';
  if (/CREATION_DISABLED/u.test(code))
    return 'A geração Olist continua desativada.';
  if (/CANCELLED/u.test(code))
    return 'Pedido cancelado: geração Olist bloqueada.';
  const item = /^items\[(\d+)\]\./u.exec(field);
  if (item)
    return `Item ${Number(item[1]) + 1}: complete as especificações do pedido.`;
  if (field === 'paymentCondition')
    return 'Forma de pagamento pendente no pedido.';
  if (field === 'summary.data_entrega_confirmada')
    return 'Previsão de entrega pendente no pedido.';
  return (
    context +
    'Os dados do pedido ou do cadastro precisam de conferência antes da exportação.'
  );
}
