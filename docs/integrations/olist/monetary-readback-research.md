# Investigação da leitura monetária Olist

OLIST-T02 / F1-G01 / OLIST-09–10, 14–17, 40–42. Consulta pública em
05/11/2026. [Resultado dos casos](phase1-report.md) ·
[Manifesto do schema consultado](evidence/monetary-readback-research.json).

**Resultado: nenhum leitor monetário automático confiável foi comprovado.**
O PO escolheu manter F1 bloqueada e buscar leitura confiável. A investigação
preserva o contrato da ADR 057; não adota restrição a duas casas nem conferência
humana como substituto da conciliação automática. T02 permanece desmarcada e
T03/Fase 2 não liberadas. Trata-se da manutenção do gate aprovado, sem nova
decisão arquitetural ou mudança de runtime.

## Fontes e candidatos

| Candidato                                                                                          | O que a fonte comprova                                                                                                                              | Limite para F1-G01                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GET pedido v3](https://api-docs.erp.olist.com/api-reference/pedidos/obter-pedido)                 | Item retorna produto, quantidade, valorUnitario e infoAdicional. O detalhe tem dois totais. O único parâmetro documentado é idPedido no path.       | Não oferece subtotal independente nem parâmetro de precisão. Os valores observados divergiram da UI.                                                            |
| [Listar pedidos v3](https://api-docs.erp.olist.com/api-reference/pedidos/listar-pedidos)           | O modelo de listagem tem valor como string, sem itens.                                                                                              | Pode ser candidato para conferir um total; não prova cada linha. Não foi consultado novamente na conta.                                                         |
| [Obter pedido v2](https://api-docs.erp.olist.com/api-v2/pedidos/obter-pedido)                      | Leitura por POST em pedido.obter.php, com token legado, formato e ID. Expõe quantidade, valor_unitario e totais; os exemplos usam strings decimais. | Não documenta subtotal do item, escala preservada ou arredondamento. Tipo decimal/string sozinho não garante fidelidade. Não foi executada nem adotada.         |
| [Configuração de produtos](https://ajuda.olist.com/produtos/configuracoes-do-cadastro-de-produtos) | O preço pode ser exibido com duas casas enquanto o cálculo considera mais casas.                                                                    | Explica uma possível diferença de exibição, não demonstra a causa dos totais divergentes da API nem garante sua precisão. Configuração global não foi alterada. |
| [Exportar pedidos para planilha](https://ajuda.olist.com/pedidos/pedidos-de-venda-como-utilizar)   | Há exportação XLS/CSV pela interface.                                                                                                               | A fonte não especifica aqui precisão por linha ou um endpoint público automatizável. Nenhuma exportação foi executada.                                          |
| [Webhooks v3](https://api-docs.erp.olist.com/documentacao/webhooks/webhooks)                       | Notificam mudanças; configuração por URLs e indisponibilidade de webhook específico por aplicativo.                                                 | Essa página não promete um payload com subtotais exatos. Não fornece prova de leitura dos pedidos já existentes. Nenhum webhook foi ativado.                    |

O [índice oficial](https://api-docs.erp.olist.com/llms.txt) foi usado para
localizar as operações. No schema público revisado, os únicos GETs sob
`/pedidos` são detalhe, listagem e marcadores. Não foi encontrada nesse recorte
uma rota de item ou impressão de pedido. Isso descreve as fontes consultadas;
não afirma que inexiste outra capacidade disponibilizada pelo fornecedor.

Nota fiscal/XML não são atalhos para esta prova: exigiriam documento e efeitos
fora do caso aprovado. Automação de telas ou endpoint interno não documentado
não será tratada como API suportada. Alterar configuração global para tentar
mudar a resposta também não foi autorizado.

## Revisão do schema público

O schema consultado tem 847141 bytes, API info.version 3.1,
Last-Modified `Wed, 04 Nov 2026 19:22:03 GMT`, SHA-256:
`7afecea50e94f0e331f8678bcd4b7017e90ed0f8b9a032d6110d36bf77c510ec`.

O schema original da prova, de 844559 bytes e SHA-256 iniciado por
`107f8d039de2`, foi preservado com seu manifesto e sua projeção. A comparação
estrutural das propriedades de ItemPedidoResponseModel,
ObterPedidoModelResponse e ListagemPedidoModelResponse não encontrou adições,
remoções ou alterações. A existência de um schema novo não prova correção na
conta; não houve nova chamada autenticada.

## Critério para liberar o gate

Uma solução precisa identificar inequivocamente cada linha, inclusive produto
repetido e M de pais distintos, e obter valor que permita conferir seu subtotal
em centavos e o total. Precisa de contrato de precisão/arredondamento e prova
remota consistente, sem reconstruir a leitura a partir do valor enviado ou
aceitar apenas soma global. O leitor deve respeitar os mesmos limites de conta,
autorização, PII e recuperação do contrato vigente.

A próxima prova deve reutilizar os pedidos existentes C02–C04 por IDs privados,
sem incluir, editar, cancelar ou excluir. Antes de executá-la, definir a rota
suportada, a credencial necessária e um orçamento novo de leituras: o anterior
foi integralmente consumido. V2, caso selecionada, usa POST com semântica de
leitura e credencial diferente; não está coberta automaticamente pelos GETs v3
anteriores. O tratamento das credenciais expostas permanece pendente conforme
o relatório. Não reutilizar valores obtidos de saídas de ferramentas.

Foi preparado um [rascunho de pergunta ao fornecedor](monetary-readback-question.md),
sem envio, IDs, documentos fiscais, dados de compradores ou credenciais.
Enquanto não houver rota/contrato comprovados, o gate continua aberto e os
registros atuais permanecem intactos.

## Continuação em pequenas entregas

Em 05/11/2026, o PO autorizou prosseguir com comparador local e prova de até
seis leituras v2 × v3 nos pedidos existentes. O [plano dividido](monetary-readback-plan.md)
registra a implementação offline e o executor limitado. O PO informou que as
credenciais expostas ainda não foram trocadas; a execução remota não ocorreu.
O gate permanece aberto, inclusive se um candidato apenas reproduzir valores
sob hipótese de arredondamento sem identificar as linhas repetidas.

## Verificação da investigação pública original

Mudança somente documental. JSON, links locais, comparação dos três modelos,
formatação e git diff --check conferidos. Zero chamadas autenticadas, zero
mutações ERP, zero mensagens externas. Os 25 testes do executor da entrega
anterior continuam como evidência daquela versão; não foram repetidos por
esta investigação sem mudança de código.
