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
