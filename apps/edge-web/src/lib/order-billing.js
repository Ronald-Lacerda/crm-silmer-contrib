const CURRENCY = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

/** Financial zero is a value, not an absent price. @param {unknown} cents */
export function billingMoney(cents) {
  return Number.isSafeInteger(cents) && Number(cents) >= 0
    ? CURRENCY.format(Number(cents) / 100)
    : '—';
}

/** Defense in depth for private checkout/receipt links. @param {unknown} value */
export function billingUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const allowed = ['infinitepay.io', 'infinitepay.com.br'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      allowed
      ? url.href
      : '';
  } catch {
    return '';
  }
}

/** @param {string|undefined} code */
export function billingReason(code) {
  return (
    {
      BILLING_DISABLED:
        'Novas cobranças estão desativadas. O histórico e a conferência dos pagamentos continuam disponíveis.',
      BILLING_ORDER_NOT_CONFIRMED:
        'Confirme o pedido antes de gerar uma cobrança.',
      BILLING_STORE_ORDER: 'Este pedido usa o checkout da loja.',
      BILLING_LEGACY_PAYMENT:
        'Este pedido já tem um pagamento manual. Confira esse registro antes de usar a cobrança integrada.',
      BILLING_REVIEW_REQUIRED:
        'Há um pagamento ou acordo anterior que precisa de conferência. Não gere outro link antes de resolver.',
      BILLING_ACTIVE_CHARGE:
        'Já existe uma cobrança em andamento para este pedido.',
      BILLING_ALREADY_PAID: 'O valor integral deste pedido já foi recebido.',
      FORBIDDEN:
        'Somente o responsável pelo pedido ou um administrador pode gerar cobranças.',
      BILLING_UNKNOWN:
        'Não foi possível confirmar o resultado da emissão. Atualize as cobranças antes de tentar novamente.',
    }[String(code ?? '')] ??
    'Não foi possível concluir a cobrança. Atualize os dados e tente novamente.'
  );
}

/** @param {any} cause */
export function billingError(cause) {
  const code = String(cause?.code ?? '');
  if (Number(cause?.status) === 409)
    return 'O pedido ou a cobrança mudou. Atualize as cobranças e revise antes de continuar.';
  if (Number(cause?.status) === 403) return billingReason('FORBIDDEN');
  if (code.startsWith('BILLING_')) return billingReason(code);
  if (Number(cause?.status) >= 500)
    return 'O serviço de cobranças está indisponível. Atualize os dados antes de tentar novamente.';
  return 'Não foi possível concluir a cobrança. Confira os valores e atualize os dados.';
}
