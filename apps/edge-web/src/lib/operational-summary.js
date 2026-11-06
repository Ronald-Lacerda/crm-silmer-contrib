const SIGNALS = [
  {
    key: 'worker',
    label: 'Worker',
    ok: 'Ativo',
    degraded: 'Sem resposta',
    guidance: 'Confira o worker e o último processamento concluído.',
  },
  {
    key: 'queue',
    label: 'Fila de tarefas',
    ok: 'Sem atraso',
    degraded: 'Atrasada',
    guidance: 'Confira tarefas aguardando processamento há mais de 5 minutos.',
  },
  {
    key: 'commands',
    label: 'Automação n8n',
    ok: 'Sem bloqueios',
    degraded: 'Comandos travados',
    guidance:
      'Confira comandos com processamento expirado, sem reenviar mensagens.',
  },
];

/** Safe presentation of a snapshot at the last explicit read, never a live monitor.
 * @param {any} data
 * @param {{now?:number,failed?:boolean}} [options]
 */
export function operationalSummary(
  data,
  { now = Date.now(), failed = false } = {},
) {
  const at =
    typeof data?.checkedAt === 'string' ? Date.parse(data.checkedAt) : NaN;
  const validChecks = SIGNALS.every((signal) =>
    ['ok', 'degraded'].includes(data?.checks?.[signal.key]),
  );
  const allOk =
    validChecks && SIGNALS.every((signal) => data.checks[signal.key] === 'ok');
  const valid =
    !failed &&
    validChecks &&
    Number.isFinite(at) &&
    at <= now + 5000 &&
    now - at <= 120_000 &&
    ((data.status === 'ok' && allOk) || (data.status === 'degraded' && !allOk));
  const state = valid ? (allOk ? 'healthy' : 'degraded') : 'unavailable';
  return {
    state,
    title:
      state === 'healthy'
        ? 'Operação saudável'
        : state === 'degraded'
          ? 'Operação precisa de atenção'
          : 'Saúde operacional indisponível',
    checkedAt: Number.isFinite(at) ? data.checkedAt : null,
    signals: SIGNALS.map((signal) => ({
      key: signal.key,
      label: signal.label,
      state: valid ? data.checks[signal.key] : 'unknown',
      value: valid
        ? signal[data.checks[signal.key] === 'ok' ? 'ok' : 'degraded']
        : 'Sem leitura',
    })),
    guidance: !valid
      ? [
          'Use Atualizar para consultar novamente. As ocorrências continuam disponíveis abaixo.',
        ]
      : SIGNALS.filter((signal) => data.checks[signal.key] === 'degraded').map(
          (signal) => signal.guidance,
        ),
  };
}
