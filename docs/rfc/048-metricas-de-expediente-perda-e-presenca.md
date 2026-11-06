# RFC 048 — Métricas de expediente, perda declarada e presença

Data: 05/11/2026. Status: **aceito em 05/11/2026 pelo PO** e registrado na
[ADR 061](../adr/061-metricas-de-expediente-perda-e-presenca.md).
Complementa a [RFC 044](044-performance-comercial-e-central-de-acoes.md) e a
[ADR 059](../adr/059-central-de-acoes-e-performance-comercial.md).
Contrato: [ACT-06 emendado e MET-01–12](../../.specs/features/dashboard-actions/spec.md).
Tarefa: [ACT-T04](../../.specs/features/dashboard-actions/tasks.md).
Responsável: Tech Lead.

## Demanda

A RFC 044 deixou expediente, intervalo de retomada, índices de tempo e
critérios de perda como decisões abertas (PERF-06). No refinamento do
Dashboard por papel (ACT-T04, §18–19 do `design.md`), o PO pediu:

- tempo até a primeira resposta e tempo para assumir, contados só no
  expediente;
- quantas conversas ficaram “sem resposta”, agora e no período;
- retomada sugerida após 3 dias, não 48h;
- marcar um lead como perdido com motivo obrigatório e auditável;
- tempo online ativo e R$ por hora online para o gestor.

Premissa do negócio: **todo contato é lead**, porque o contato acontece
sempre por iniciativa do cliente. Não existe triagem de “não lead”.

## Proposta aceita

### Expediente versionado

Política `expediente-v1`: segunda a sexta, 09:00–12:00 e 13:00–18:00,
America/Sao_Paulo, sem feriados por enquanto. A contagem de minutos úteis
vive em uma função SQL versionada, `crm.business_minutes_v1(from, to)`,
fonte única para API, Dashboard e testes. Mudar a política (feriados,
sábado, outro horário) cria `_v2`; a `_v1` não é reescrita, e a resposta
da API informa a versão usada.

### Métricas de atendimento por vendedor

Janela PERF-02: 7 ou 30 dias civis até hoje em São Paulo.

| Medida                   | Regra                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tempo para assumir       | Do pedido de atendimento (handoff) até a tomada, em minutos de expediente. Crédito a quem assumiu. Pedido ainda sem tomada aparece como aberto, com idade, nunca omitido.                    |
| Tempo até a 1ª resposta  | Até a primeira resposta humana efetiva (enviada, não queued/failed/unknown) do vendedor no ciclo, em minutos de expediente. Crédito a quem assumiu. Espera sem resposta aparece como aberta. |
| Apresentação dos tempos  | Mediana e p90, com quantidade de amostras. p90 nulo com menos de 5 amostras; sem amostra é nulo, não zero.                                                                                   |
| Sem resposta — agora     | Conversas do vendedor em modo humano com mensagem do cliente sem resposta humana efetiva há mais de 15 minutos de expediente. Retrato do instante, no Dashboard.                             |
| Sem resposta — episódios | Total de períodos de espera que passaram de 15 minutos de expediente no período, na tabela da equipe. Cada período de espera conta uma vez, mesmo com várias mensagens do cliente.           |

Definições operacionais que a implementação deve explicitar em teste e
confirmar na revisão do PO:

- O início da “1ª resposta” é o instante da tomada ou, se não houver mensagem
  do cliente pendente nesse momento, a primeira mensagem do cliente posterior.
  A espera anterior à tomada já é medida pelo tempo para assumir.
- Tomada direta (takeover sem pedido de atendimento) não gera amostra de
  tempo para assumir.
- Um período de espera termina na primeira resposta humana efetiva. Bot,
  notificações administrativas e saídas sem envio confirmado não encerram a
  espera (PERF-03).

### Retomada em 72h

A sugestão de retomada da ACT-06 passa de 48h para **72h** sem resposta à
última saída humana enviada. O resto da ACT-06 segue: o sistema nunca infere
perda, desinteresse ou compromisso; dispensar não encerra nada. As 72h são
corridas, como as 48h eram; só as métricas de tempo usam o expediente.

### Lead perdido por declaração explícita

Perda é uma **declaração humana** do responsável da conversa ou de um
administrador, nunca uma inferência do sistema.

- Motivo obrigatório de lista fechada: `preco`, `prazo`, `concorrente`,
  `silencio`, `indisponivel`, `outro`. Em `outro`, texto obrigatório de
  1–140 caracteres, cifrado em repouso e fora de logs, auditoria e
  agregações; métricas usam só o código do motivo.
- Registro em tabela própria e imutável de desfechos de lead
  (`crm.lead_outcome_events`), versionada por conversa. Não altera o estado
  nem o encerramento da conversa, nem o status de pedido; não usa Negócio.
  Por isso não é “novo status comercial” no sentido da spec.
- Marcar perdido **não encerra** a conversa: encerrar continua sendo o
  comando separado `concluido`/`sem_pedido`.
- Só em conversa aberta, com dono, em modo humano. Bloqueado com
  `409 LEAD_HAS_ORDER` se o ciclo tiver pedido pendente ou confirmado.
- Mensagem nova do cliente reabre o lead automaticamente. A reabertura é
  derivada das mensagens, sem apagar o evento de perda; o histórico fica
  preservado. Reabertura manual é correção: a perda corrigida sai da contagem.
- Perda ativa tira da central as sugestões de retomada, o “responder” e os
  lembretes da conversa. Falhas de envio continuam visíveis, porque exigem
  resolver o envio.
- Comando com `Idempotency-Key`, CSRF, versão esperada e auditoria sem o
  texto livre.

### Presença e R$ por hora online

“Online” significa: CRM aberto, aba visível e interação do usuário nos
últimos 10 minutos. O cliente envia um heartbeat sem corpo
(`POST /api/v1/presence/heartbeat`) apenas nessa condição; o servidor grava
no máximo uma linha por usuário por minuto (`crm.user_presence_minutes`),
com o relógio do servidor. Não grava IP, user-agent nem rota.

- Flag `DASHBOARD_PRESENCE_ENABLED`, desligada por padrão; sem flag, nada é
  gravado e as métricas de presença aparecem como indisponíveis.
- Retenção de 90 dias, com expurgo dos minutos mais antigos.
- R$ por hora online = vendido atribuído ao vendedor (PERF-01) ÷ todas as
  horas online no período, dentro ou fora do expediente. Nulo com menos de
  60 minutos online. Só vendedores; loja e sem atribuição ficam fora.
- Cobertura parcial: se a coleta começou depois do início da janela, a
  janela do indicador começa no início da cobertura, e a resposta informa
  isso.

LGPD: finalidade de **gestão comercial**, não controle de jornada ou ponto.
Base legal: legítimo interesse, com teste de balanceamento registrado antes
de ligar a flag. A equipe recebe aviso antes da ativação, e cada vendedor vê
os próprios dados de presença.

### Visibilidade

Administrador ativo vê a equipe; vendedor vê só a própria linha (PERF-07),
mesmo com parâmetros manipulados. Financeiro não tem acesso. Todas as
leituras são privadas e `no-store`.

### Contrato técnico

Endpoints novos, sem alterar `GET /api/v1/dashboard/performance` nem o
checkpoint (PERF-08 segue com a mesma apuração de vendas):

- `GET /api/v1/dashboard/metrics/service?days=7|30`
- `GET /api/v1/dashboard/metrics/losses?days=7|30`
- `GET /api/v1/dashboard/metrics/presence?days=7|30`
- `POST /api/v1/conversations/:id/lead-outcome` e
  `GET /api/v1/conversations/:id/lead-outcome`
- `POST /api/v1/presence/heartbeat`

Migrações expand: `0061` (função de expediente e índices), `0062`
(desfechos de lead) e `0063` (presença).

## Alternativas consideradas

| Alternativa                                         | Motivo da rejeição                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reutilizar `deal.lose` / Negócio                    | RULES §3 e ADR 004 aposentam Negócio; acoplaria a central a tabelas históricas.                                                                     |
| Novo status ou desfecho de encerramento da conversa | Cruza a fronteira da spec (“sem novo status comercial”) e mistura perda com encerramento; perder um lead não deve fechar o atendimento nem o ciclo. |
| Sessão/login como tempo online                      | Sessões duram dias; inflaria a presença e o denominador do R$/hora.                                                                                 |
| Minutos úteis calculados em JavaScript              | Duas fontes de verdade (API e testes/consultas) divergiriam em virada de dia, almoço e fuso; a função SQL versionada é fonte única e auditável.     |
| Manter 48h para a retomada                          | Decisão do PO em 05/11/2026: retomada sugerida após 3 dias.                                                                                         |

## Riscos e mitigação

- **Leitura punitiva:** tempos e presença viram ranking. Mitigação: PERF-06
  continua (sem nota única ou ranking), amostras visíveis e linguagem de
  fato (“7 conversas sem resposta no expediente”), conforme §19 do
  `design.md`.
- **Privacidade da presença:** coleta mínima, flag desligada, aviso prévio,
  retenção de 90 dias e acesso do próprio vendedor.
- **Perda escondendo cliente:** mensagem nova reabre automaticamente;
  falhas de envio continuam na central.
- **Numeração:** a branch `codex/olist-phase3` já usa ADR 060 e a
  migração 0060; esta decisão usa ADR 061 e 0061–0063. Quem chegar depois ao master confere a numeração antes do merge.

## Rastreabilidade

Spec: ACT-06 (emendada) e MET-01–12 em
[dashboard-actions](../../.specs/features/dashboard-actions/spec.md).
Base: PERF-01–08, ACT-01–12, RULES §3–4, ADRs
[004](../adr/004-aposentar-kanban-e-negocio.md),
[015](../adr/015-conversa-nao-volta-para-o-bot.md),
[032](../adr/032-separar-pedido-conversa-e-assunto.md) e 059.
Entrega: ACT-T04, backend primeiro; a interface aguarda ACT-T03 no master.
