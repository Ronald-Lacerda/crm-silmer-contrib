// OPS-ERR-01: the capability alone never opens this operational console.
/** @param {Record<string, any>|null|undefined} user */
export function canReadHealthErrors(user) {
  return Boolean(
    user &&
    user.kind !== 'assistant' &&
    !user.disabledAt &&
    user.functionName === 'Vendedor' &&
    user.capabilities?.includes('COMMERCIAL_ADMIN') &&
    typeof user.email === 'string' &&
    user.email.trim().toLowerCase() === 'admin@crm-silmer.local',
  );
}

export const HEALTH_ERROR_STATUSES = Object.freeze([
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Novos' },
  { value: 'investigating', label: 'Em análise' },
  { value: 'resolved', label: 'Resolvidos' },
]);

/** @param {string} value */
export function healthErrorStatus(value) {
  const labels = /** @type {Record<string, string>} */ ({
    new: 'Novo',
    investigating: 'Em análise',
    resolved: 'Resolvido',
  });
  return labels[value] ?? 'Não informado';
}

/** @param {string} value */
export function healthErrorSource(value) {
  const labels = /** @type {Record<string, string>} */ ({
    api: 'CRM',
    worker: 'Processamento',
    n8n: 'Automação n8n',
  });
  return labels[value] ?? 'Serviço';
}

/** @param {string} code */
export function healthErrorTitle(code) {
  const labels = /** @type {Record<string, string>} */ ({
    API_5XX: 'Falha na API',
    API_NOT_READY: 'CRM indisponível',
    WORKER_RETRY: 'Tarefa aguardando nova tentativa',
    WORKER_DEAD_LETTER: 'Tarefa precisa de intervenção',
    WORKER_OUTCOME_UNKNOWN: 'Resultado de tarefa desconhecido',
    N8N_FAILED: 'Falha no comando n8n',
    N8N_OUTCOME_UNKNOWN: 'Resultado do envio desconhecido',
    N8N_PROCESSING_EXPIRED: 'Comando n8n sem conclusão',
  });
  return labels[code] ?? 'Falha registrada';
}

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

/** @param {unknown} value */
export function healthErrorInstant(value) {
  if (typeof value !== 'string' || !value) return 'Não informado';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Não informado' : dateTime.format(date);
}

/** @param {string} code */
export function healthErrorGuidance(code) {
  if (/UNKNOWN|UNSAFE_RETRY/u.test(code))
    return 'Confira o resultado no serviço de destino antes de qualquer nova tentativa. O envio pode ter sido concluído.';
  if (/MEDIA|STORAGE|CLAM/u.test(code))
    return 'Confira o armazenamento e o processamento do arquivo antes de retomar a operação.';
  return 'Confira o serviço de origem e use a referência técnica para investigar a causa antes de retomar a operação.';
}
