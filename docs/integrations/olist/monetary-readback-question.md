# Rascunho — precisão de leitura dos pedidos na API v3

OLIST-T02 / F1-G01. Preparado em 05/11/2026. **Não enviado.**
Somente dados dos casos sintéticos aprovados; sem identificadores da conta,
dados fiscais, compradores, IDs de recursos, tokens ou credenciais.

Assunto: leitura por linha e totais de pedidos com unitário fracionário

Precisamos conferir automaticamente cada subtotal e o total de pedidos abertos,
sem gerar nota fiscal, movimentar estoque/financeiro ou editar a venda.
Após inclusão via API v3, observamos:

| Caso | Quantidades e unitários enviados    | Subtotais na UI         | Totais na UI | valorTotalProdutos / valorTotalPedido no GET v3   |
| ---- | ----------------------------------- | ----------------------- | ------------ | ------------------------------------------------- |
| A    | 3×0.3333 e 3×0.6667                 | 1.00 e 2.00             | 3.00         | 3 / 3, mas unitários retornados 0.33 e 0.67       |
| B    | 1×0.005, 1×0.015, 1×1.025 e 1×0.035 | 0.01, 0.02, 1.03 e 0.04 | 1.10         | 1.08 / 1.1                                        |
| C    | 1000×0.000010 e 1×0.01              | 0.01 e 0.01             | 0.02         | 0.02 / 0.01, com primeiro unitário retornado zero |

Os valores acima são lexemas das respostas, sem formatação monetária local.
No caso B há duas linhas do mesmo produto com preços distintos e uma linha de
outro produto com o mesmo tamanho. A UI mantém as quatro linhas; o GET as
reordena. Não houve desconto, frete ou outras despesas nos casos.

1. Qual rota pública suportada retorna subtotal independente e identidade por
   linha, preservando linhas repetidas, além do total efetivo mostrado na UI?
2. Qual a semântica de valorTotalProdutos e valorTotalPedido nesses casos e
   por que divergem entre si ou da UI? Há correção ou versão específica?
3. Qual a escala efetivamente aceita/preservada no unitário e qual a regra de
   arredondamento por linha/total, inclusive empates e quantidades altas?
4. A configuração de casas decimais afeta a leitura API ou somente entrada/
   exibição? Existe parâmetro de leitura que dispense mudar configurações globais?
5. Se a solução for API v2 ou exportação, quais campos, precisão, autenticação,
   limites e garantias de suporte permitem essa conferência automática?

Há pedidos existentes para a validação de uma solução; não precisamos criar
novos. Os identificadores só deverão ser fornecidos por canal privado após
aprovação específica, caso necessários. Este rascunho não autoriza seu envio.
