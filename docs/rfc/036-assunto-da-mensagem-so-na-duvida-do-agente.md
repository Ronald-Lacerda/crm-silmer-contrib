# RFC 036 — Assunto da mensagem só na dúvida do agente

Status: decidida em 28/10/2026 na
[ADR 048](../adr/048-assunto-da-mensagem-so-na-duvida-do-agente.md) quanto ao
CRM; itens do workflow n8n seguem em proposta até decisão do PO.
Responsável: Tech Lead. Pedido do PO: o controle “Assuntos desta mensagem” é
técnico e pouco claro; deve aparecer só quando o agente não tem certeza.
Requisitos: [CP-12, CP-14, CP-16 e CP-29..31](../../.specs/features/cliente-pedido-assuntos/spec.md).
Tarefa: CP-T09. Evidência:
[pesquisa de UX de 28/10/2026](../product/pesquisa-ux-assuntos-2026-10-28.md).
Issue/PR específica: não criada nesta etapa.

## Problema

Toda mensagem da conversa trazia “Assuntos desta mensagem”, com “Marque todos
os assuntos mencionados” e “Salvar assuntos”, mesmo com um único pedido. As
mensagens do cliente só ganhavam vínculo quando o vendedor marcava à mão,
embora o workflow já escolhesse o Assunto por regras (vínculo humano, seleção
do vendedor, número citado, único pendente) e transferisse quando não
conseguia. Quando transferia, a Inbox dizia apenas “Agente sem confiança”,
o mesmo texto de outras paradas.

## Alternativas avaliadas

1. **Manter o controle em toda mensagem, só com textos melhores.** Rejeitada:
   continua pedindo trabalho que o agente já fez e soma paradas de Tab.
2. **Chip discreto em toda mensagem com “Corrigir”.** Parcialmente adotada:
   só com dois ou mais Assuntos, quando o vínculo informa algo.
3. **Pergunta na mensagem marcada pelo agente + motivo claro na faixa de
   assumir.** Adotada para o CRM.
4. **Agente retomar após a resposta do vendedor.** Fora: ADR 015 mantém a
   conversa com a pessoa; exigiria um estado de pausa que não é handoff.

## Proposta para o CRM (decidida)

- Vínculo do agente nas mensagens de entrada do turno com alvo explícito.
- Revisão aberta (`crm.message_subject_reviews`) quando o handoff `subject-v1`
  de `low_confidence` não tem alvo e a conversa já tem Assunto.
- `GET .../subjects` devolve `links[].assignedByKind` e
  `needsSubjectMessageIds`; `PUT .../messages/:id/subjects` resolve a revisão.
- Inbox: pergunta só nas mensagens marcadas, faixa “O agente parou para não
  misturar pedidos.”, chip com origem só com dois ou mais Assuntos e painel
  “Pedidos e assuntos desta conversa”.

## Proposta para o workflow n8n (aguarda PO)

- Motivo próprio para a parada por Assunto, separado de `low_confidence`.
- Estreitar o gatilho de pedido novo (“também quero” sozinho não basta).
- Perguntar uma vez ao cliente quando a dúvida for entre pedidos existentes,
  pelo nome do pedido, antes de transferir (CP-16 permite).
- Dizer ao cliente o que foi anotado ao transferir por pedido novo.

## Questões para o PO

As oito perguntas estão no fim do estudo de UX; as que mudam escopo são: o
agente pode perguntar ao cliente, “Um pedido novo” deve criar o Pedido na
hora e o termo “Assunto” sai da tela do vendedor.
