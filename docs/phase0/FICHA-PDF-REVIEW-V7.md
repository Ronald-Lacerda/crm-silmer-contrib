# Revisão visual da ficha v7

Rastreabilidade: [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md),
`OLIST-49`, `OLIST-50`, `OLIST-T25`. O pacote usa só dados sintéticos.

## Estado

**Preparada, não selecionada, com a revisão do PO pendente.** O registro
[`ficha-pdf-approval-v7.json`](ficha-pdf-approval-v7.json) trava os hashes da
amostra, do HTML e do PDF com `provisionalApproval.status`
`pending-po-review` e a assinatura física de Rose e Operação pendente.
`PRINT_TEMPLATE` continua `ficha-canonical-v6`: a v7 é endereçável e testável
(`renderOrderFicha(order, TEMPLATE_V7)`), mas nenhum pedido imprime nela. O
validador (`validateFichaPrintSwitch`) recusa `PRINT_TEMPLATE` igual à v7
enquanto a aprovação não estiver registrada. A v2, a v3, a v4, a v5, a v6,
seus PDFs, amostras, aprovações e hashes não foram alterados.

## O que mudou da v6 para a v7

| Onde                     | v6                | v7                  |
| ------------------------ | ----------------- | ------------------- |
| Ponto 4 de cada item     | Técnica           | Aplicação           |
| Data do resumo do pedido | Entrega prometida | Previsão de entrega |

Só os dois rótulos mudam. Os valores são os mesmos: o ponto 4 continua vindo do
`tipo_servico` do próprio item (a aplicação é por item; `summary.aplicacao` não
é reativado) e a previsão continua vindo de `data_entrega_confirmada`. Nenhum
valor em dinheiro entra na ficha (sem preço, subtotal, total ou condição de
pagamento). O público, o "Modelo de malha", a quantidade informada, o lastro,
a arte do pedido, a paginação e o controle de produção são os da v6. A folha de
estilos é a da v6, byte a byte; por isso a v7 usa o mesmo hash já admitido na
CSP da impressão (`docker/nginx.conf`).

## Pacote sintético

- [`ficha-pdf-synthetic-v7.json`](ficha-pdf-synthetic-v7.json): o mesmo pedido
  sintético da v6, dividido em quatro públicos (camiseta masculina, baby look
  feminina com quantidade informada diferente da soma dos tamanhos, camiseta
  infantil com tamanhos numéricos e boné trucker unissex com gola "NÃO
  APLICÁVEL"), com aplicações por item (SILK e BORDADO) e as duas origens da
  arte. Só dados sintéticos, sem contato pessoal.
- [`../../output/pdf/ficha-canonica-sintetica-v7.pdf`](../../output/pdf/ficha-canonica-sintetica-v7.pdf):
  três páginas A4 paisagem, como a v6: duas comerciais e o controle de produção
  com os 14 campos vazios e as linhas de assinatura da amostra.
- `scripts/ficha-pdf-preview-v7.mjs` gera a amostra enquanto a revisão está
  pendente e se recusa a sobrescrever o PDF depois da aprovação. O PDF do
  Chromium não é reproduzível byte a byte (carimbos de data); por isso qualquer
  nova geração exige atualizar o hash do PDF no registro antes da revisão.
- `scripts/ficha-pdf-review-v7.mjs` valida amostra, HTML, PDF, revisão do PO
  pendente e assinatura física pendente; `test/ficha-print-v7.test.js` cobre os
  rótulos novos, a ausência dos antigos e de dinheiro, a v6 e as anteriores
  intactas, a seleção recusada sem aprovação e `PRINT_TEMPLATE` na v6.

## Como aprovar (pendente)

Nada foi aprovado nem assinado. Quando o PO revisar a amostra, ele registra em
`ficha-pdf-approval-v7.json` o `status` `approved`, `approved: true`, o nome e
a data em `provisionalApproval`; só então um commit à parte pode trocar
`PRINT_TEMPLATE` para `ficha-canonical-v7`, junto dos gates físicos vigentes
(Rose e Operação assinam a amostra impressa antes da produção). Qualquer
correção do layout antes da aprovação regenera o pacote; depois, exige uma
nova versão.

```bash
node --test test/ficha-print-v7.test.js
npm run validate:ficha-pdf-review
```
