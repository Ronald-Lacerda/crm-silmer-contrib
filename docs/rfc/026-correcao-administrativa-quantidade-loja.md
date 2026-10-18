# RFC 026 — Correção administrativa de quantidade da loja

- Data: 18/10/2026
- Estado: aceita; [ADR 038](../adr/038-correcao-administrativa-quantidade-loja.md)
- Requisitos: LOJ-39–LOJ-41; tarefa T135 em pedidos-mvp.

## Problema e autorização

O responsável confirmou que uma compra paga deveria produzir duas peças,
embora o checkout tivesse registrado uma peça e frete. Alterar o cálculo
global a partir do valor pago quebraria compras legítimas com frete e
sobrepagamento. Reenviar um pedido diferente também viola a idempotência.
O PO autorizou expressamente a correção emergencial da quantidade e do valor
das peças, preservando a cobrança existente.

## Proposta aceita

Uma ação humana dedicada na API e na página do pedido permite corrigir
somente a quantidade de um produto unitário da loja. Exige administrador
ativo, sessão, CSRF, origem, chave de idempotência e versão esperada. O
catálogo calcula o novo valor das peças; o pagamento existente precisa
cobri-lo. O operador confirma previamente a quantidade com o cliente.

O pedido, número, confirmação, pagamento, recibo e primeira impressão são
preservados. Grade, total de peças, valor das peças, versão e atualização
mudam juntos com auditoria e evento, numa transação. O hash do registro
original permanece como lastro: seu replay retorna o pedido corrigido sem
revertê-lo. A linha original do checkout não é reescrita para simular outra
compra. Frete deve ser conferido separadamente na operação.

## Alternativas rejeitadas

- Inferir peças pelo Pix: confunde frete e sobrepagamento com produtos.
- Alterar o banco do CRM pelo n8n: ignora o contrato e a autorização da API.
- Reabrir ou editar livremente a loja: amplia a fronteira além do incidente.
- Criar outro pedido: duplica venda e pagamento.

## Validação

Exigir testes de admin, versão, pagamento insuficiente, quantidade inválida,
repetição e preservação dos campos, além de operação por teclado. Gerar a
ficha novamente depois da correção; a primeira geração continua histórica.
O commit da T135 vincula esta proposta à implementação e às evidências.
