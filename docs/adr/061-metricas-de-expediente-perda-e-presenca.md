# ADR 061 — Métricas de expediente, perda declarada e presença

Data: 05/11/2026. Status: aceita pelo PO em 05/11/2026.
Proposta: [RFC 048](../rfc/048-metricas-de-expediente-perda-e-presenca.md),
complementar à [RFC 044](../rfc/044-performance-comercial-e-central-de-acoes.md).
Contrato: [ACT-06 emendado e MET-01–12](../../.specs/features/dashboard-actions/spec.md).
Tarefa: ACT-T04.

**Supersede em parte a [ADR 059](059-central-de-acoes-e-performance-comercial.md)
somente no intervalo da sugestão de retomada (48h → 72h).** Emenda a
fronteira “novo status comercial” da spec para admitir a perda declarada
abaixo. Todo o resto da ADR 059 continua valendo.

## Decisão

Medir tempo de atendimento em **minutos de expediente** pela política
`expediente-v1` (segunda a sexta, 09:00–12:00 e 13:00–18:00,
America/Sao_Paulo, sem feriados), calculados só pela função SQL versionada
`crm.business_minutes_v1(from, to)`. Mudança de política cria `_v2`.

Por vendedor, na janela PERF 7/30 dias: tempo até a 1ª resposta humana
efetiva e tempo para assumir (pedido de atendimento → tomada), com mediana,
p90 (nulo com menos de 5 amostras) e amostras; crédito a quem assumiu;
esperas abertas aparecem como abertas. “Sem resposta” é mensagem do cliente,
em conversa do vendedor em modo humano, sem resposta humana efetiva por mais
de 15 minutos de expediente: retrato atual no Dashboard e episódios no
período na tabela da equipe, cada espera contada uma vez.

A sugestão de retomada da ACT-06 passa a **72h**. O sistema continua sem
inferir perda.

Todo contato é lead. Perda é declaração explícita do responsável ou de um
administrador, com motivo de lista fechada (`preco`, `prazo`, `concorrente`,
`silencio`, `indisponivel`, `outro` + texto de 1–140 caracteres cifrado,
fora de logs, auditoria e agregações). Fica em `crm.lead_outcome_events`,
imutável e versionada, sem alterar estado ou encerramento da conversa nem
status de pedido, e sem Negócio. Não encerra a conversa. Exige conversa
aberta, com dono, em modo humano, e é recusada com `409 LEAD_HAS_ORDER`
quando o ciclo tem pedido pendente ou confirmado. Mensagem nova do cliente
reabre de forma derivada, preservando o histórico; reabertura manual é
correção e sai da contagem. Perda ativa retira retomada, resposta e
lembretes da central; falhas de envio permanecem.

Presença: “online” é CRM aberto, aba visível e interação nos últimos 10
minutos, em `crm.user_presence_minutes` (uma linha por usuário por minuto,
relógio do servidor, sem IP, user-agent ou rota), alimentada por
`POST /api/v1/presence/heartbeat` sem corpo, atrás de
`DASHBOARD_PRESENCE_ENABLED` desligada por padrão e com retenção de 90
dias. Finalidade de gestão comercial, não controle de jornada; legítimo
interesse com teste de balanceamento registrado e aviso à equipe antes de
ligar a flag; vendedor vê os próprios dados. R$ por hora online é o vendido
atribuído (PERF-01) dividido por todas as horas online do período, nulo
abaixo de 60 minutos, só para vendedores, com início ajustado à cobertura.

Admin vê a equipe, vendedor só a própria linha (PERF-07) e Financeiro não
tem acesso. Endpoints novos sob `/api/v1/dashboard/metrics/{service,losses,presence}`
e `/api/v1/conversations/:id/lead-outcome`, sem alterar
`/dashboard/performance` nem o checkpoint (PERF-08). Migrações expand
`0061` (expediente e índices), `0062` (desfechos de lead) e `0063` (presença).

## Consequências e alternativas

Uma fonte única de minutos úteis evita divergência entre API, painel e
testes; versionar a política preserva leituras passadas. A perda em tabela
própria mantém pedido, conversa e encerramento intactos e permite rollback
de código sem restaurar banco. A presença cria um dado pessoal novo de baixo
detalhe, condicionado a flag, aviso e retenção curta.

Rejeitados: reutilizar `deal.lose`/Negócio (RULES §3 e acoplamento), novo
status de conversa (fronteira da spec e mistura com encerramento), sessão ou
login como tempo online (sessões duram dias e inflam o indicador) e cálculo
de minutos úteis em JavaScript (duas fontes de verdade).

A branch `codex/olist-phase3` já usa ADR 060 e migração 0060; por isso esta decisão
usa ADR 061 e 0061–0063. Quem chegar depois ao master confere a numeração antes do merge.
