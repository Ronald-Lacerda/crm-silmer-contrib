# RFC 037 — Aprendizados do Vendedor na Inbox real

Status: decidida em 28/10/2026 na
[ADR 049](../adr/049-aprendizados-do-vendedor-na-inbox-real.md).
Responsável: Tech Lead, com aprovação item a item do proprietário.
Requisitos: [AGT-01..08, ORC-03 e CHAN-WA-01](../../.specs/features/crm-mvp/spec.md).
Tarefa: VND-L01 no [plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR específica: não criada nesta etapa.

## Contexto

Em 28/10/2026 cinco conversas reais chegaram pela nova linha do WhatsApp e
foram transferidas a vendedor. A leitura das conversas e das pré-fichas
mostrou falhas do agente que não aparecem nos cenários sintéticos:

- pergunta de viabilidade ("vocês fazem bandeira?", "conseguem fazer igual?")
  ficou sem reconhecimento e o cliente pediu atendente;
- resposta livre de modelo ("Futebol") foi gravada como finalidade, a mesma
  pergunta se repetiu e a transferência saiu como "não respondeu duas vezes";
- a mensagem pronta do botão de referência do site contou como pergunta
  ignorada;
- bandeira caiu em "outro produto" e o tamanho, que define o orçamento, nunca
  foi perguntado;
- prazos relativos ("quarta feira", "dentro de 20 dias") ficaram sem data;
- a empresa com que o cliente se apresentou não foi registrada;
- a transferência às 20h não avisou que o vendedor só responde no dia seguinte;
- a quantidade dita para um único produto não chegava ao item da Ficha.

A classificação de imagem de referência como arte está em outra frente e fica
fora desta proposta.

## Proposta

Corrigir no prompt e, como rede determinística, no nó de decisão do workflow
principal; corrigir a projeção da quantidade no domínio de Pedidos. Detalhes
e limites estão na ADR 049.

## Alternativas

- Só reforçar o prompt: rejeitado, porque os casos do dia já eram cobertos
  por regras do prompt que o modelo não seguiu.
- Transferir cedo todo cliente empresa: adiado, sem decisão do proprietário.
- Somar a quantidade dita ao total de peças: rejeitado pela ADR 025 (D4); a
  grade continua obrigatória.
