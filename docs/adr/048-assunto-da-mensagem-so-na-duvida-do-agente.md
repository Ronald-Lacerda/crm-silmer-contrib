# ADR 048 — Assunto da mensagem só na dúvida do agente

Status: aceita em 28/10/2026 ao atender o pedido do PO de mostrar o controle
somente quando o agente não tem certeza do assunto.
RFC: [036](../rfc/036-assunto-da-mensagem-so-na-duvida-do-agente.md).
Requisitos: [CP-12, CP-14, CP-16 e CP-29..31](../../.specs/features/cliente-pedido-assuntos/spec.md).
Tarefa: CP-T09 no
[plano de Cliente, Pedido e Assuntos](../../.specs/features/cliente-pedido-assuntos/tasks.md).
Complementa a [ADR 032](032-separar-pedido-conversa-e-assunto.md), sem
supersedê-la. Issue/PR específica: não criada nesta etapa.

## Contexto

O vendedor via e precisava preencher assuntos em toda mensagem, enquanto o
agente já escolhia o Assunto do turno ou transferia quando não conseguia.
O detalhe está na RFC 036 e no
[estudo de 28/10/2026](../product/pesquisa-ux-assuntos-2026-10-28.md).

## Decisão

1. Quando o CRM aceita um evento do agente com alvo explícito e válido, liga
   ao mesmo Assunto as mensagens de entrada do turno (revisão de entrada maior
   que a reivindicada e até `sourceRevision`), com
   `assigned_by_kind='agent'`. Mensagem com vínculo existente ou com revisão
   humana resolvida não é alterada. Abrir Pedido com um único Assunto liga o
   primeiro turno, exceto em handoff de baixa confiança. Rejeição não grava
   vínculo; replay só completa a abertura de Pedido que falhou.
2. `crm.message_subject_reviews` (migração `0045`, só expansão) marca a
   mensagem que o agente não soube atribuir: handoff de contrato `subject-v1`
   com `low_confidence`, sem alvo e com ao menos um Assunto. Não muda Pedido,
   ficha ou briefing (CP-16).
3. A Inbox pergunta “A qual pedido esta mensagem se refere?” somente nas
   mensagens com revisão aberta e sem vínculo, e só para quem pode gerir os
   Assuntos. Nas demais não há controle; com dois ou mais Assuntos, a
   mensagem vinculada mostra o pedido, quem ligou e “Corrigir”.
4. A resposta do vendedor resolve a revisão, inclusive “Nenhum pedido”, e é
   auditada como atribuição humana. Não resolve o handoff nem devolve a
   conversa ao agente (ADR 015). “Separar como novo assunto” cria o Assunto
   sem torná-lo o atual (`select: false`). Vínculos do agente são auditados
   com motivo próprio, só com IDs e códigos.

## Consequências

- O vínculo do agente passa a existir para as mensagens do cliente; a escolha
  do vendedor continua prevalecendo (CP-14).
- A derivação depende de o workflow mapear `subject_ambiguous` para
  `low_confidence` e omitir `subject_id` sem alvo; um teste de contrato fixa
  esse acoplamento.
- Não há reconstrução histórica: conversas anteriores ficam sem revisões.
- Fala ao cliente, gatilho “também quero” e motivo próprio do handoff ficam
  para decisão do PO (RFC 036).
- A numeração (migração 0045, RFC 036, ADR 048, CP-29..31, CP-T09) evita a do
  branch `codex/cadastro-completo-cliente`; conferir de novo ao integrar.
