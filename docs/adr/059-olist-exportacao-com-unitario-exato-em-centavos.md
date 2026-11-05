# ADR 059 — Exportação Olist com unitário exato em centavos

Data: 05/11/2026. Status: decisão de escopo aceita pelo proprietário no chat;
fechamento técnico F1 condicionado à prova controlada.

Supersede parcialmente o item 5 da [ADR 057 Olist](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md),
quanto à amplitude inicial da representabilidade e do critério de leitura.
Proposta: [RFC 046](../rfc/046-olist-escopo-inicial-de-centavos-exatos.md).
Contrato principal: [RFC 044](../rfc/044-geracao-assistida-de-pedidos-no-olist.md).
Requisitos OLIST-09–10, 14–17, 40–43; tarefas T02/T06a/T08. Entrega anterior:
[PR 295](https://github.com/romulosutil/crm-silmer/pull/295).

## Contexto

A comparação v2/v3 dos casos C02–C04 mostrou perda de precisão dos unitários
e divergências de totais. A investigação externa foi encerrada a pedido do PO.
Em seguida, o PO aprovou expressamente o escopo menor e solicitou registrar a
mudança, implementar o bloqueio fracionário e executar prova controlada.

## Decisão

1. O subtotal negociado por tamanho permanece autoridade em centavos no CRM.
   Total continua calculado no backend. A validade comercial do Pedido não
   depende de sua elegibilidade para exportação Olist.
2. O escopo automático inicial admite somente linhas cujo subtotal inteiro
   positivo em centavos seja divisível pela quantidade inteira positiva:
   `subtotalCents % quantity === 0`, usando BigInt. O unitário resultante é
   inteiro positivo em centavos, serializado como decimal exato sem Number
   monetário intermediário. Não basta arredondar uma divisão para duas casas.
3. Uma linha fracionária, incompleta ou sem revisão bloqueia a exportação
   inteira antes de qualquer inclusão dependente. Não há envio parcial,
   alteração do subtotal/quantidade, divisão artificial de linha, desconto
   compensatório ou redistribuição de resíduos.
4. Cada linha leva um identificador opaco único em `infoAdicional`. O retorno
   precisa preservar esse identificador e a identidade do produto. Posição,
   preço e texto de tamanho não identificam uma linha. Metadata serve apenas
   à correlação; o subtotal não é considerado comprovado por texto ecoado.
5. Para este subconjunto, conferir quantidade e unitário exatos retornados e
   multiplicá-los em centavos sem arredondamento comprova o subtotal técnico
   da linha. Ambos os totais retornados devem coincidir com a soma das linhas.
   Essa decisão substitui a exigência de um campo independente de subtotal
   para o subconjunto, não afirma que o Olist passou a oferecer esse campo.
6. Qualquer perda de marcador, fusão, duplicidade, produto/quantidade/valor
   divergente ou resultado incerto interrompe a sequência, preserva IDs e
   reservas e exige reconciliação. Não repetir POST automaticamente.
7. T02/F1 pode fechar somente para esse escopo se C05–C07 passarem pela prova
   API e tela nativa. Os resultados negativos C02–C04 permanecem verdadeiros
   e excluídos do envio automático. Flags de produção e piloto continuam nos
   gates posteriores; nenhuma conta é habilitada por este registro.

## O que fica de fora

- Subtotal de R$ 1,00 dividido entre três unidades; subtotal de R$ 0,01 para
  mil unidades; qualquer outro unitário com fração de centavo.
- Arredondar ou modificar negociação para fazer caber no ERP automaticamente.
- Tratar só o total global como sucesso, aceitar linhas ambíguas ou confiar
  apenas no HTTP 201.
- Corrigir os pedidos antigos, alterar configurações globais, emitir fiscal,
  lançar estoque/contas, cancelar ou limpar registros pela prova.
- Declaração de precisão universal para todas as contas, configurações e valores.

## Verificação e recuperação

A prova limitada cria até três pedidos abertos C05/C06/C07 com os cadastros
existentes aprovados, no total nominal de R$ 5,20; teto de 14 GETs e três POSTs,
mais uma troca OAuth separada. Journals exclusivos reservam cada efeito antes
do envio. Timeout/erro param sem retry; ID confirmado é persistido antes de
consultas seguintes, inclusive em quota esgotada. Evidência pública contém
somente aliases, quantidades/centavos sintéticos e conclusões sanitizadas.
Rollback do código mantém os pedidos criados e registros privados; não os apaga.
