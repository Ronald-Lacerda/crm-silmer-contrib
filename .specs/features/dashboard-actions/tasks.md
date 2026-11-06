# Central de ações — entrega

## ACT-T01 — Central, desempenho e checkpoint

ACT-01–12, PERF-01–08, CHK-01–08; aprovação do protótipo pelo proprietário
em 05/11/2026. RFC 044 / ADR 059.

- [x] Implementar fila/detalhe Vue nos tokens e shell existentes.
- [x] Implementar leitura autorizada e decisões com revisão/versionamento.
- [x] Conectar pagamento integral e entrega independentes, preservando Financeiro.
- [x] Capturar atribuição e expor desempenho próprio/equipe com histórico honesto.
- [x] Implementar snapshot, reserva por destino e workflow dedicado do checkpoint.
- [x] Validar API, concorrência PostgreSQL e teclado/temas/responsividade.
- [x] Fechar revisão QA, gates completos, documentação, commit e push atômicos.

Evidências e limitações: [QA de 05/11](../../../docs/qa/dashboard-central-2026-11-05.md).

## ACT-T02 — Homologação operacional

- [ ] Implantar migrations/imagens compatíveis antes do workflow novo.
- [ ] Configurar privadamente os dois destinos, credenciais e flag do checkpoint.
- [ ] Validar identidade da conta remetente e reconhecimento dos destinatários.
- [ ] Publicar workflow dedicado; conferir fuso/08h, retenção e reserva.
- [ ] Confirmar entrega real independente aos dois destinos e registrar evidência
      privada, sem mensagens ou dados reais no Git.

Essa segunda tarefa distingue código entregue de ativação/homologação; não
autoriza restauração de banco ou alteração de workflows comerciais existentes.

## ACT-T04 — Refinamento do Dashboard por papel (proposta de design, 05/11/2026)

Proposta de design; não autoriza implementação. Componentes e regras na §18
do [design.md](../../../design.md). Decisões do PO em 05/11/2026, registradas
como contexto:

- Vendedor vê só os próprios números (já coberto por PERF-07).
- Expediente das 9h às 18h; “sem resposta” conta só dentro do expediente.
- Retomada sugerida após 3 dias; hoje são 48h (`DASHBOARD_FOLLOWUP_HOURS`,
  ACT-06).
- Todo contato é lead: o contato acontece sempre por iniciativa do cliente.
- Marcar lead como perdido exige motivo obrigatório e auditável. Hoje está
  fora de escopo: a spec proíbe inferir perda (ACT-06) e não cria status
  novo; aqui é declaração explícita do vendedor, por isso precisa de RFC.
- Crédito da venda é do último responsável no momento da confirmação
  (compatível com PERF-01).
- Métricas novas para o gestor: “tempo online ativo” (CRM aberto com uso
  nos últimos 10 min) e “R$ por hora online”.

- [x] Componentes e regras no design.md (este commit).
- [ ] RFC complementar ao RFC 044: expediente, follow-up de 72h, motivo de
      perda obrigatório, tempo online ativo e R$/hora, tempo de 1ª resposta
      e “sem resposta” no expediente.
- [ ] Integrar saldo InfinitePay à central (COB-DASH-01): link vencido →
      “Gerar novo link”; “Resultado a conferir” → conferência humana.
- [ ] Quando Olist (ADR 057) chegar ao master: estado da exportação
      (uncertain/rejected) como ação para quem está “Habilitado Olist”.
