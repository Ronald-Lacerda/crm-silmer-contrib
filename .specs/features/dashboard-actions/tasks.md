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

## ACT-T04 — Refinamento do Dashboard por papel e métricas novas (05/11/2026)

Implementação autorizada pelo PO em 05/11/2026, **backend primeiro**: a
interface do redesenho espera a fatia de interface de outra sessão (ACT-T03)
chegar ao master. Componentes e práticas na §18–19 do
[design.md](../../../design.md). Decisões em
[RFC 048](../../../docs/rfc/048-metricas-de-expediente-perda-e-presenca.md) /
[ADR 061](../../../docs/adr/061-metricas-de-expediente-perda-e-presenca.md);
contrato em ACT-06 (72h) e MET-01–12 da [spec](spec.md). Vendedor vê só os
próprios números (PERF-07) e o crédito da venda é do responsável na
confirmação (PERF-01).

- [x] Componentes e práticas no design.md.
- [x] RFC 048 / ADR 061 e emenda da spec (este commit).
- [x] B — Métricas de expediente (MET-01–05) e retomada em 72h (ACT-06):
      migração 0061 e `GET /api/v1/dashboard/metrics/service`.
- [x] C — Lead perdido com motivo (MET-06–08): migração 0062,
      `/api/v1/conversations/:id/lead-outcome` e
      `GET /api/v1/dashboard/metrics/losses`.
- [ ] D — **Backlog** (adiada pelo PO em 05/11/2026; não implementar sem
      nova decisão). Presença e R$/hora (MET-09–11) com heartbeat no cliente:
      migração 0063, `POST /api/v1/presence/heartbeat`,
      `GET /api/v1/dashboard/metrics/presence`, flag desligada, teste de
      balanceamento e aviso à equipe antes de ligar.
- [x] E — Interface do desempenho da equipe e da fila de espera (PERF-01–05,
      MET-02–08): "Seu resultado" do vendedor, "Equipe nos últimos 7 dias" e
      "Esperando um vendedor" no Dashboard do gestor e a página
      `/dashboard/equipe`, sobre os endpoints de `dashboard-metrics-routes.js`.
      O lead perdido com motivo continua só na Caixa de Entrada
      (`useInboxOutcome.js`).
- [ ] Demais telas do redesenho, depois de ACT-T03 no master.
- [ ] Integrar saldo InfinitePay à central (COB-DASH-01): link vencido →
      “Gerar novo link”; “Resultado a conferir” → conferência humana.
- [ ] Quando Olist (ADR 057) chegar ao master: estado da exportação
      (uncertain/rejected) como ação para quem está “Habilitado Olist”.
