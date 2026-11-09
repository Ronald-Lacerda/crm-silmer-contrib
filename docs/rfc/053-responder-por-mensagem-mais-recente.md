# RFC 053 — Responder por mensagem mais recente

Data: 08/11/2026. Status: aprovada pelo proprietário nesta solicitação.
Decisão: [ADR 066](../adr/066-responder-por-mensagem-mais-recente.md).
Requisito PCX-19e; tarefa INBOX-VEZ-08 no [plano](../../.specs/features/crm-mvp/tasks.md).

A ordem por maior espera da RFC 052 deixa mensagens novas abaixo de pendências
antigas. O proprietário pediu a leitura familiar do WhatsApp: a conversa com
mensagem mais recente aparece primeiro, inclusive quando o cliente escreve
novamente enquanto espera resposta.

Proposta aceita: ordenar somente Responder pela última mensagem, decrescente,
com desempate pelo ID decrescente. Falhas e envios incertos continuam na aba,
com seus alertas, mas não ficam fixados no topo. O início da espera continua
independente da posição da conversa. Outras abas, classificação e ACL mantêm
os contratos atuais. SQL e cursor usam a mesma precisão em milissegundos;
cursores da ordenação antiga são recusados para exigir atualização da lista.

Não há migration, envio externo ou reconciliação de cadastros nesta entrega.
