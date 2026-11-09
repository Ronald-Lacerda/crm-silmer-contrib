# ADR 066 — Responder por mensagem mais recente

Data: 08/11/2026. Status: aceita pelo proprietário.
Proposta: [RFC 053](../rfc/053-responder-por-mensagem-mais-recente.md).
Requisito PCX-19e; tarefa INBOX-VEZ-08 no [plano](../../.specs/features/crm-mvp/tasks.md).
Supersede somente a ordem e o cursor de Responder na ADR 065.

## Decisão

- Responder usa `conversation.last_message_at DESC, conversation.id DESC`,
  com timestamp truncado a milissegundos antes da ordenação e paginação.
- Uma nova mensagem sobe a conversa. Falhas e resultados incertos conservam
  classificação e alertas, sem precedência na ordenação.
- `turnSince` e minutos de expediente continuam medindo o início da espera;
  não são recalculados para simular recência.
- O fingerprint do cursor de Responder inclui `orderVersion=latest-message-v1`.
  Cursores da ordem antiga recebem `INVALID_CURSOR`; atualizar a lista inicia
  a leitura pela nova ordem. Outras abas e consultas legadas mantêm o contrato.

## Consequências

A lista responde à atividade recente, como solicitado pelo proprietário.
Pendências antigas permanecem visíveis com seus tempos e alertas, mas podem
ficar abaixo das novas. Não há novo índice, migration ou estado persistido.
Operação e rollback no [runbook](../runbooks/inbox-prioridades.md).
