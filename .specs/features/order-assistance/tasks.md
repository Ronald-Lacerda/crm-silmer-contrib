# Abertura assistida — entrega OA-T01

Requisitos: [OA-01–12](spec.md). Decisão: RFC 043 / ADR 056.

## OA-T01 — Fluxo completo e publicação

- [x] Migração aditiva, observações, sugestões, decisões e métricas implementadas.
- [x] Barreira API aos dois caminhos automáticos; briefing preservado.
- [x] Observador n8n durante atendimento humano, com falhas visíveis e sem envio.
- [x] Inbox: evidência, aceite, adiamento, recusa e omissão com ACL/versão.
- [x] Painel: agregados e limites da avaliação.
- [ ] Testes negativos/concorrentes, acessibilidade, checks e build.
- [ ] Commit/push, PR/checks GitHub, migração e deploy EasyPanel verificados.

Responsabilidades: Tech Lead integra; Backend/Dados cuida da transação e
contratos; Integrações do workflow; Frontend/A11y da interação; gate final
inclui revisão de QA/segurança. Alterações locais anteriores em outras tarefas
não pertencem a esta entrega. Homologação comercial real não é substituída
por cenários sintéticos.

Os gates de teste e publicação são fechados pelas evidências do PR e do handoff
operacional. A aplicação da migração e a publicação do workflow não são
inferidas da presença do código neste commit.
