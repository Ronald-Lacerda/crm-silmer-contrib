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

/**
 * Motivo seguro e fixo para o código público da operação ou da tentativa.
 * Código desconhecido nunca vira texto livre.
 * @param {unknown} code @param {string} [state]
 */
export function olistOperationReason(code, state = '') {
  const value = String(code ?? '');
  const known = /** @type {Record<string,string>} */ ({
    OLIST_RESOURCE_OUTCOME_UNKNOWN:
      'O resultado do cadastro não pôde ser confirmado e ele pode existir no Olist.',
    OLIST_SALE_UNCERTAIN:
      'O resultado da venda não pôde ser confirmado e ela pode existir no Olist.',
    OLIST_SALE_RECONCILIATION_REQUIRED:
      'A venda exige conferência administrativa antes de qualquer outra ação.',
    OLIST_RESOURCE_RECONCILIATION_REQUIRED:
      'O cadastro exige conferência administrativa antes de qualquer outra ação.',
    OLIST_RECONCILIATION_REQUIRED:
      'A operação exige conferência administrativa antes de qualquer outra ação.',
    OLIST_AMBIGUOUS_MATCH:
      'Mais de um cadastro corresponde aos dados; nenhum foi escolhido automaticamente.',
    OLIST_INCOMPLETE_LOOKUP:
      'A consulta ao Olist ficou incompleta e não prova a ausência do cadastro.',
    OLIST_SALE_DIVERGENT:
      'A venda encontrada diverge do pedido e não foi aceita.',
    OLIST_RESOURCE_DIVERGENT:
      'Um cadastro encontrado diverge do pedido e não foi aceito.',
    OLIST_CUSTOMER_DIVERGENT:
      'O cadastro do comprador no Olist diverge dos dados do pedido.',
    OLIST_PRODUCT_DIVERGENT: 'O produto no Olist diverge dos dados do pedido.',
    OLIST_PRODUCT_FISCAL_DIVERGENT:
      'Os dados fiscais do produto no Olist divergem dos parâmetros conferidos.',
    OLIST_VARIATION_DIVERGENT:
      'A variação no Olist diverge do tamanho do pedido.',
    OLIST_SALE_READBACK_MISMATCH:
      'A venda lida depois do envio não confere com o pedido.',
    OLIST_SALE_REQUEST_CHANGED:
      'O pedido mudou depois da solicitação congelada da venda.',
    OLIST_SALE_REFERENCE_CONFLICT:
      'A referência da venda pertence a outro registro.',
    OLIST_UPSTREAM_REJECTED: 'O Olist recusou a solicitação desta etapa.',
    OLIST_UNAVAILABLE: 'O Olist estava indisponível nesta etapa.',
    OLIST_RATE_LIMITED: 'O limite de consultas do Olist foi atingido.',
    OLIST_AUTH: 'A conexão Olist precisa ser conferida por um administrador.',
    OLIST_RECONNECT_REQUIRED:
      'A conexão Olist precisa ser refeita por um administrador.',
    OLIST_NOT_CONFIGURED:
      'A integração Olist não está configurada para esta operação.',
    OLIST_ACCOUNT_MISMATCH:
      'A conta conectada não corresponde à conta da operação.',
    OLIST_CONNECTION_CHANGED: 'A conexão Olist mudou durante a operação.',
    OLIST_INVALID_RESPONSE: 'O Olist devolveu uma resposta inválida.',
    OLIST_CREATION_DISABLED: 'A geração de vendas está desativada.',
    ORDER_CANCELLED: 'O pedido foi cancelado antes da etapa de venda.',
    OLIST_EXPORT_INVALIDATED:
      'Invalidada por uma pessoa administradora antes de qualquer venda.',
  });
  if (known[value]) return known[value];
  if (state === 'rejected')
    return 'A etapa foi recusada. O detalhe do provedor não é exibido.';
  if (state === 'invalidated')
    return 'A operação foi invalidada antes de concluir.';
  if (
    /UNCERTAIN|UNKNOWN|RECONCILIATION|DIVERGENT|AMBIGUOUS/u.test(value) ||
    ['uncertain', 'outcome_unknown', 'divergent'].includes(state)
  )
    return 'O resultado desta etapa não pôde ser provado e exige conferência administrativa.';
  return '';
}

/**
 * Falha de uma ação administrativa de recuperação (conferir, vincular,
 * invalidar). Mensagem fixa em português; o corpo do provedor nunca é exibido.
 * @param {any} cause @param {'reconcile'|'preview'|'link'|'invalidate'|'read'|'load'} [action]
 */
export function olistRecoveryFailure(cause, action = 'load') {
  const status = Number(cause?.status);
  const code = String(cause?.code ?? '');
  if ([401, 403].includes(status))
    return 'Seu acesso mudou ou sua sessão expirou. Entre novamente com uma conta de administrador.';
  // Sem resposta ou 5xx: o comando pode ter sido gravado. A tela relê o
  // diagnóstico e diz isso, sem oferecer nada que crie.
  if ((status === 0 || status >= 500) && action === 'link')
    return 'O resultado do vínculo é incerto e pode ter sido gravado. O diagnóstico foi atualizado: confira o progresso antes de tentar de novo.';
  if ((status === 0 || status >= 500) && action === 'reconcile')
    return 'O resultado da solicitação é incerto e pode ter sido registrado. O diagnóstico foi atualizado: confira Conferências solicitadas antes de tentar de novo.';
  // Invalidar é um comando local e idempotente: nada é lido nem escrito no
  // Olist, e reenviar com a mesma chave é seguro.
  if ((status === 0 || status >= 500) && action === 'invalidate')
    return 'Não foi possível confirmar a invalidação: ela pode não ter sido registrada. O diagnóstico foi atualizado. Se a geração continuar ativa, envie de novo; o reenvio não duplica o registro.';
  if (action === 'invalidate') {
    if (code === 'OLIST_INVALIDATION_BLOCKED')
      return 'Esta geração não pode ser invalidada: ela já passou da preparação ou teve uma tentativa de venda. Nada foi alterado. Use Conferir no Olist para esclarecer a venda.';
    if (code === 'OLIST_EXPORT_IN_FLIGHT')
      return 'A geração está em execução agora. Aguarde alguns instantes, atualize o diagnóstico e tente invalidar de novo. Nada foi alterado.';
    if (code === 'OLIST_RESOURCE_RECONCILIATION_REQUIRED')
      return 'Há um cadastro ainda sem resultado confirmado. Use Conferir no Olist nesse cadastro; quando ele ficar confirmado, a geração poderá ser invalidada. Nada foi alterado.';
    if (code === 'OLIST_EXPORT_UNAVAILABLE')
      return 'Esta geração não está mais disponível. Atualize o diagnóstico antes de continuar.';
  }
  if (status === 429 || code === 'OLIST_RATE_LIMITED')
    return 'Limite de consultas atingido. Aguarde um momento antes de tentar de novo.';
  if (code === 'VERSION_CONFLICT')
    return 'O estado da etapa mudou desde o diagnóstico. Atualize o diagnóstico e confira novamente.';
  if (code === 'OLIST_RECONCILIATION_REQUIRED')
    return 'Esta operação já tem venda ou cadastro reservado ou incerto, então o vínculo manual não é permitido. Use Conferir no Olist.';
  if (code === 'OLIST_EXPORT_UNAVAILABLE')
    return 'Não há operação Olist neste pedido para conferir.';
  if (code === 'OLIST_PREVIEW_EXPIRED')
    return 'A conferência expirou. Confira a venda novamente.';
  if (
    [
      'OLIST_PREVIEW_STALE',
      'OLIST_PREVIEW_INVALID',
      'OLIST_CONNECTION_CHANGED',
      'OLIST_SALE_REQUEST_CHANGED',
    ].includes(code)
  )
    return 'O pedido, o cadastro ou a configuração mudou desde a conferência. Confira a venda novamente.';
  if (
    [
      'OLIST_SALE_REFERENCE_CONFLICT',
      'OLIST_EXPORT_CONFLICT',
      'OLIST_SALE_DIVERGENT',
      'OLIST_SALE_READBACK_MISMATCH',
      'OLIST_CUSTOMER_DIVERGENT',
      'OLIST_PRODUCT_DIVERGENT',
      'OLIST_PRODUCT_FISCAL_DIVERGENT',
      'OLIST_VARIATION_DIVERGENT',
      'OLIST_RESOURCE_DIVERGENT',
    ].includes(code)
  )
    return 'A venda encontrada não corresponde a este pedido, ou já está vinculada a outro registro. Nenhum vínculo foi criado.';
  if (['OLIST_INCOMPLETE_LOOKUP', 'OLIST_AMBIGUOUS_MATCH'].includes(code))
    return 'A consulta ao Olist ficou incompleta ou ambígua. Nenhum vínculo foi criado.';
  if (['IDEMPOTENCY_RECORD_PENDING', 'IDEMPOTENCY_KEY_REUSED'].includes(code))
    return 'Esta solicitação já está em processamento. Aguarde e atualize o diagnóstico.';
  if (
    [
      'OLIST_NOT_CONFIGURED',
      'OLIST_RECONNECT_REQUIRED',
      'OLIST_AUTH',
      'OLIST_ACCOUNT_MISMATCH',
    ].includes(code)
  )
    return 'A conexão Olist precisa ser conferida em Conexão da empresa.';
  if (code === 'OLIST_ORDER_INCOMPLETE' || code === 'OLIST_PREVIEW_TOO_LARGE')
    return 'O pedido ainda não está completo para conferir uma venda existente.';
  if (code === 'ORDER_CANCELLED')
    return 'Este pedido foi cancelado. A ação está bloqueada.';
  if (status === 404)
    return action === 'preview'
      ? 'Venda não encontrada no Olist para este pedido. Confira o ID informado.'
      : 'Recurso ou pedido não encontrado. Atualize o diagnóstico.';
  if (status === 422)
    return 'Os dados não permitem esta ação. Confira o pedido e a venda informada.';
  if (
    status === 400 &&
    (action === 'reconcile' || action === 'link' || action === 'invalidate')
  )
    return 'Confira os dados informados. O motivo não pode ter quebra de linha nem caracteres de controle: escreva em uma linha só e tente de novo.';
  if (status === 400) return 'Confira os dados informados e tente novamente.';
  if (status === 409)
    return 'O estado da operação mudou ou exige conferência. Atualize o diagnóstico antes de continuar.';
  return action === 'load'
    ? 'Não foi possível carregar o diagnóstico administrativo agora.'
    : 'Não foi possível concluir agora. Atualize o diagnóstico antes de tentar de novo.';
}
