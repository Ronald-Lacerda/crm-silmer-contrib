# INBOX-DELIVERY-01 — Falhas de envio compreensíveis e rastreáveis

Requisitos: MSG-02/03, ORC-08 e INBOX-3/INT-2 do MVP.
Complementa OPS-INBOX-ACK-01, preservando o contrato de envio e a reserva única.
Solicitado pelo proprietário em 30/10/2026 após diagnóstico de timeout.

- [x] Substituir código técnico no texto principal por orientação humana.
- [x] Oferecer referência da mensagem e código técnico em detalhes para suporte.
- [x] Consultar a tentativa existente com GET autenticado em **Verificar envio**.
- [x] Quando a consulta falhar, preservar histórico/rascunho e oferecer
      **Tentar novamente**, repetindo somente a consulta.
- [x] Não criar mensagem, comando ou nova chave de envio nessa ação.
- [x] Tratar resultado incerto sem afirmar entrega, rejeição ou ausência do efeito.
- [x] Isolar respostas atrasadas por conversa e consulta; anunciar resultado e
      manter foco previsível quando uma confirmação remove o aviso.
- [x] Gates locais completos, revisão especializada, commit e push na branch
      `codex/inbox-delivery-feedback`.

Implementação: `MessageDeliveryNotice.vue` e `InboxView.vue`.
Verificação: cenários INBOX-DELIVERY-01 em `test/e2e/crm-ui.spec.js`.
Diagnóstico e procedimento: [runbook](../../../docs/runbooks/inbox-delivery-feedback.md).

Gates finais: `npm run validate` com 1.483 aprovados e cinco skips; E2E
completo com 371 aprovados e sete skips; cinco E2E focados aprovados;
`npm audit --audit-level=high` e `git diff --check` aprovados. Revisões de
Frontend/A11y e QA/Segurança sem bloqueantes após os ajustes de concorrência.

O status `failed` sozinho não autoriza criar outro envio: também pode indicar
replay seguro apenas do comando original. Um botão de reenvio exige contrato
autorizado e atômico que revalide estado, autoria, conteúdo, reserva e segurança
do replay. Esta entrega oferece retomada da consulta, sem inventar esse contrato.
