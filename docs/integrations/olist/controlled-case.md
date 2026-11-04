# Olist — consultas da conta atual e caso controlado

OLIST-T02 / OLIST-03–17, 20, 26, 35–41. Inspeção em 04/11/2026.
Dono: Tech Lead/Integrações (Codex nesta execução).
[RFC 044](../../rfc/044-geracao-assistida-de-pedidos-no-olist.md) ·
[Prova de capacidades](capabilities.md) ·
[Observações sanitizadas](evidence/account-inspection.json).

## Autorização e resultado

O PO confirmou que a conta aberta no Chrome é operacional e decidiu usá-la
para consultas, conferência de gatilhos e preparação de caso controlado.
Qualquer criação depende de aprovação posterior. A preferência anterior por
conta dedicada não é mais a condição de ambiente. Não há autorização nesta
etapa para criar aplicativo/credencial, cliente, produto, variação ou pedido,
alterar parâmetros, contratar serviço, emitir documento ou enviar mensagem.

Inspeção autenticada pela interface, sem chamar a API v3, salvar parâmetros
ou alterar registros ERP. Os valores abaixo foram lidos dos controles
selecionados; não são inferência da documentação pública ou teste de efeito.

## Gatilhos observados

| Área                            | Valor atual observado                                                                                          | Consequência para o caso                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Contas a receber                | Automático ao autorizar a nota fiscal                                                                          | Não gerar/autorizar NF; não chamar lançar contas; salvar pedido não é o gatilho observado   |
| Contas a pagar                  | Manual                                                                                                         | Nenhum comando financeiro                                                                   |
| Estorno de contas               | Automático ao cancelar pedido                                                                                  | Cancelamento não é limpeza segura nem rollback autorizado                                   |
| Estoque, entradas e saídas      | Manual                                                                                                         | Nenhum lançamento/balanço/saldo inicial pelo teste                                          |
| Estoque, contratação adicional  | Contratação automática do limite adicional de sincronização habilitada                                         | Nenhuma sincronização; risco de custo se ela for acionada                                   |
| Estoque, aviso de mínimo        | E-mail desabilitado                                                                                            | Não cobre outros avisos/webhooks                                                            |
| Estoque via API                 | Sincronizar anúncios ao gerar balanço habilitado                                                               | Não usar endpoint de balanço ou estoque                                                     |
| Cobrança por e-mail             | Não avisar                                                                                                     | Não criar contas, boletos ou cobranças                                                      |
| Emissão de boletos              | Manual                                                                                                         | Não gerar boleto, código Pix ou link de cobrança                                            |
| Pedido, impostos                | Calcular impostos nas vendas habilitado                                                                        | Comparar composição/total e possíveis impostos; isso não comprova emissão automática        |
| Pedido, primeira venda          | Marcador automático habilitado                                                                                 | Novo comprador pode receber marcador; considerar nos efeitos do cadastro/venda              |
| Pedido, vendedor pela API       | Não aceita se vendedor não existe                                                                              | Validar ID central; não criar vendedor ou inferir responsável                               |
| Pedido, numeração               | Sequencial                                                                                                     | Uma inclusão consumirá número real, sem apagamento/reutilização posterior                   |
| Pedido, aprovação por pagamento | Desabilitada                                                                                                   | Sem pagamento/baixa/pagamento integrado e sem alteração de situação                         |
| Shopee                          | Conectada; sincronização automática de pedidos ativa; saldo em Não atualizar; lançamento segue padrão da conta | Não associar pedido/produto de prova à integração                                           |
| TikTok Shop                     | Conectada; sincronização automática de pedidos ativa; Enviar saldo físico; lançamento segue padrão da conta    | Não publicar/vincular produto de prova ao canal nem movimentar saldo                        |
| Dados fiscais dos dois canais   | Envio de NFe automático ao autorizar nota                                                                      | Não emitir/autorizar NF; esse envio não equivale a criar NF                                 |
| Rastreamento dos dois canais    | Enviar ao mudar para enviado desabilitado                                                                      | Manter situação em aberto e não criar expedição/etiqueta                                    |
| Envio de documentos de venda    | Formato configurado para link, com modelo de mensagem                                                          | Modelo de mensagem não prova envio automático nem ausência dele; não compartilhar documento |

A sessão expirou ao abrir Loja de extensões. Tela de login deixada para o PO.
Ainda não foi possível conferir Gestão de Aplicativos/API v3, gatilhos gerais,
webhooks, reserva de estoque ou publicação automática de produtos. Não concluir
que essas funções estão desabilitadas porque as telas anteriores são manuais.

## Caso proposto para revisão — não liberado para execução

Começar pela menor prova, usando **um comprador válido já existente** e
**duas variações já existentes**, escolhidos em conferência privada com o PO.
Não usar cliente real arbitrário, documento fictício ou o caso privado já
lançado como destino de uma nova venda. Essa etapa prova venda; não comprova
criação automática de cliente/produto/variação exigida para fechar F1.

| Campo / limite       | Proposta                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Referência exclusiva | `CRM-F1-20261104-C01`, após consulta que confirme ausência e prova de filtro; zero após incerteza não autoriza repetir                            |
| Comprador            | Existente, válido, autorizado pelo PO para o teste; ID/documento ficam somente na evidência privada                                               |
| Produtos             | Duas variações existentes validadas, com grade e identidade distintas; sem editar preço/cadastro/estoque de catálogo                              |
| Linhas               | M: 1 unidade, subtotal R$ 1,00; G: 1 unidade, subtotal R$ 2,00; total de produtos R$ 3,00                                                         |
| Dinheiro             | Preço da venda somente, unitários R$ 1,00/R$ 2,00; sem frete/desconto/outras despesas inventados; provar tributos e total final antes de executar |
| Situação             | Em aberto, sem aprovar/enviar/faturar; confirmar código aceito no contrato e parâmetros do alvo                                                   |
| Origem/referência    | Referência em numeroPedidoEcommerce; nenhum ID Shopee/TikTok ou ordem de compra reaproveitada; suporte sem ecommerce.id ainda pendente            |
| Escritas propostas   | No máximo 1 POST pedido nesta etapa; zero cliente/produto/variação/credencial/configuração                                                        |
| Leituras propostas   | Até 30 GET v3 por execução autorizada, limit até 100, páginas limitadas; respeitar quota real compartilhada                                       |
| Operações excluídas  | Fiscal, estoque/balanço, contas/baixa/estorno, cobrança, expedição, publicação, mensagens, atualização de cadastro e exclusão/cancelamento        |
| Resultado incerto    | Interromper; consultar por ID/referência e preservar evidência, sem retry criador                                                                 |
| Retenção             | Registro real permanecerá no ERP; classificação/filtro e prazo de retenção a combinar, sem prometer exclusão de métricas                          |

O valor baixo reduz a contaminação monetária, mas não torna a venda fictícia:
pode aparecer em relatórios, consumir numeração, gerar histórico e disparar
qualquer automação ainda não inspecionada. Se não houver isolamento verificável
dos gatilhos, a criação permanece bloqueada, mesmo após aprovação desse valor.
Não alterar configuração global da operação para viabilizar a prova.

## Pendências para tornar a aprovação executável

1. Restabelecer sessão e terminar consultas de Aplicativos/escopos/gatilhos,
   fiscal, reserva e publicação. Se não houver acesso v3 existente, preparar
   pedido de aprovação separado para aplicativo/escopos/callback concretos;
   não criar acesso persistente sob autorização de consulta.
2. Conferir comprador/variações e vendedor/natureza/depósito/pagamento no alvo,
   mantendo IDs/documentos fora do Git. Confirmar que o PO pode autorizar o
   uso dessas identidades; não selecionar por nome parecido.
3. Confirmar referência independente do marketplace, composição tributária,
   ausência de efeito financeiro/estoque/notificação e impacto em relatórios.
4. Apresentar o payload final em visão privada, com valor/contagem/IDs
   selecionados, plano de leitura/retencão e efeitos concretos; só então pedir
   aprovação do POST único. Aprovação de consulta não autoriza essa criação.

## Cobertura restante de T02

Depois da prova mínima, criar propostas específicas, cada uma com dados válidos,
efeitos/limites explícitos e autorização antes de qualquer escrita:

- Comprador ausente: entidade de teste validamente identificada e escolhida
  pelo PO; não reaproveitar CPF/CNPJ alheio nem fabricar documento na conta real.
- Pai com M/G iniciais e variação GG posterior: SKU próprio, fiscal/unidade
  aprovados, sem estoque, catálogo/canal existente preservado; prova de lote
  e recuperação não destrutiva por pai/filho.
- Precisão: quantidade não divisível, escala/empate e produto repetido, com
  orçamento de pedidos separado; sem alterar subtotal/quantidade para passar.

Mock, leitura de dados existentes ou a primeira venda exata não concluem
cadastros automáticos, arredondamento, rejeições ou recuperação real. T02 e
gate F1 continuam abertos; T03 não foi liberada por esta inspeção.
