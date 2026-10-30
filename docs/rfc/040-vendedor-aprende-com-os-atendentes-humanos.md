# RFC 040 — Vendedor aprende com os atendentes humanos

Status: decidida em 29/10/2026 na
[ADR 051](../adr/051-vendedor-aprende-com-os-atendentes-humanos.md).
Responsável: Tech Lead, com aprovação item a item do proprietário.
Requisitos: [AGT-01..05 e ORC-03](../../.specs/features/crm-mvp/spec.md) e
[PRD-02, PRD-03 e PRD-06](../../.specs/features/pedidos-mvp/spec.md).
Tarefa: VND-L02 no [plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR específica: a do PR desta mudança.

## Contexto

Em 29/10/2026 nove conversas novas de clientes chegaram pela linha do
WhatsApp, já com o Vendedor da ADR 049. Quatro foram transferidas por pergunta
de preço, três com a ficha completa, uma por urgência e uma por falta de
confiança. Uma vendedora retomou também as conversas da véspera. Ler o que ela
respondeu mostrou o que a ficha não traz:

- a primeira pergunta dela, quando faltava, era "já tem a arte?";
- tecido aparece em quase todo orçamento (algodão 30.1, poliéster, dry fit) e
  os clientes citavam tecido sem que o bot gravasse;
- três transferências por preço aconteceram na primeira ou segunda mensagem,
  antes de qualquer ponto da ficha, e duas delas seguiam sem resposta à noite;
- imagem recebida virou "Não consegui abrir a imagem" e, na mensagem
  seguinte, transferência por falta de confiança;
- duas mensagens seguidas do cliente geraram duas respostas do bot, e o aviso
  de preço saiu como resposta a outra mensagem;
- prazo "hoje" passou como ficha completa comum;
- um estúdio que pediu parceria, revenda, nota fiscal e frete recebeu só o
  aviso de preço;
- o bot elogiou escolhas e repetiu um erro de digitação do cliente;
- uma transferência às 17h47 não avisou que o vendedor talvez só respondesse
  no dia seguinte.

O pedido mínimo variou entre as conversas (10 peças, 10 por cor, 4 peças
aceitas) e fica fora até o proprietário definir a regra.

## Proposta

Ajustar o prompt e, como rede determinística, os nós do workflow principal.
Nenhuma mudança no CRM: o bot usa chaves de briefing e motivos de handoff que
o CRM já aceita. Detalhes e limites estão na ADR 051.

## Alternativas

- Transferir em toda pergunta de preço (ADR 009, item 4): substituída, porque
  a AGT-04 pede transferência quando o cliente insiste e as transferências
  precoces ficaram sem ficha nem resposta.
- Motivo de handoff próprio para parceria e revenda: adiado; exige migração do
  CHECK de motivos e rótulo novo na Inbox.
- Oferecer a criação da arte na pergunta: rejeitado pela PRD-03; a criação é
  decisão comercial do vendedor.
