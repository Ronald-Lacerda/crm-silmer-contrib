/** Safe, fixed feedback; never render provider messages or request details.
 * @param {unknown} cause */
export function olistAdminFailure(cause) {
  if (/** @type {any} */ (cause)?.code === 'OLIST_RECOVERY_BLOCKED')
    return 'Desative a geração e conclua a conferência das operações pendentes ou divergentes antes de registrar a recuperação.';
  const error = /** @type {any} */ (cause);
  if (error?.status === 401 || error?.status === 403)
    return 'Seu acesso mudou ou sua sessão expirou. Entre novamente com uma conta de administrador.';
  if (error?.code === 'OLIST_ACCOUNT_MISMATCH')
    return 'A empresa autorizada não corresponde à conta configurada. Reconecte usando a empresa correta.';
  if (['OLIST_RECONNECT_REQUIRED', 'OLIST_AUTH'].includes(error?.code))
    return 'Reconecte a conta Olist para continuar as consultas.';
  if (error?.code === 'OLIST_REFRESH_IN_PROGRESS')
    return 'A conexão está sendo renovada. Aguarde um momento e atualize a conexão.';
  if (error?.code === 'OLIST_NOT_CONFIGURED')
    return 'A operação precisa concluir a configuração privada da integração.';
  if (error?.code === 'OLIST_INCOMPLETE_LOOKUP')
    return 'A consulta não pôde ser concluída dentro dos limites da conta. Nenhum resultado parcial foi utilizado.';
  if (error?.status === 429 || error?.code === 'OLIST_RATE_LIMITED')
    return 'Limite de consultas atingido. Aguarde um momento antes de consultar novamente.';
  if (error?.status === 404)
    return 'Mapeamento não encontrado nesta conta. Confira o identificador do recurso.';
  if (error?.status === 409)
    return 'A conexão ou configuração mudou. Atualize a conexão e revise os dados antes de tentar novamente.';
  if (error?.status === 400 || error?.status === 422)
    return 'Confira os dados informados e tente novamente.';
  return 'Não foi possível concluir agora. Tente novamente em instantes.';
}
