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

Após novo login feito pelo PO, a inspeção prosseguiu e confirmou:

| Consulta adicional                     | Resultado observado                                         | Consequência                                                                    |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Gestão de Aplicativos                  | Instalada GRÁTIS após aprovação do PO; confirmado INSTALADO | Aplicativos disponível; nenhum aplicativo/credencial criado                     |
| Token API                              | Consta INSTALADO                                            | Não foi aberto/copiado segredo; não substitui prova de acesso v3                |
| Reserva de estoque                     | Não instalada; disponível GRÁTIS                            | Nenhuma instalação; comportamento de efeitos externos ainda sujeito à prova     |
| Webhooks                               | Não instalada; catálogo exige UPGRADE                       | Não contratar upgrade; isso não prova ausência de toda integração externa       |
| Painel de Automações: saída de estoque | Desabilitada                                                | Confirma parâmetro manual observado                                             |
| Painel de Automações: emitir NF-e      | Desabilitada                                                | Sem geração automática nesse painel; comandos fiscais continuam fora do teste   |
| Painel de Automações: expedição        | Habilitada ao salvar nota fiscal                            | Não gerar/salvar nota; nenhum comando de expedição/etiqueta                     |
| Busca de comprador por teste           | Nenhum registro encontrado                                  | Limitado aos filtros atuais; não selecionar comprador real arbitrário           |
| Busca de produto ativo por teste       | Nenhum resultado                                            | Ainda faltam duas variações exatas para congelar o caso                         |
| TikTok: fluxo de produtos              | Importação não atualiza SKU; imagens como anexos            | Não trata de garantia de ausência de publicação; não publicar/vincular produtos |

A busca de configurações por gatilho não encontrou item; o painel consolidado
foi localizado pela navegação de Vendas. O resultado negativo da busca não foi
usado como prova de ausência de gatilhos. São 36 observações sanitizadas no
JSON; nenhum parâmetro foi salvo e nenhuma chamada autenticada v3 foi feita.

## Extensão instalada e próxima aprovação

O PO aprovou a instalação gratuita com prossiga após a solicitação específica.
A extensão Gestão de Aplicativos foi instalada, com GRÁTIS e depois INSTALADO
confirmados na tela. Não houve cobrança/upgrade, mudança de gatilho ou criação
de cadastro/venda. A tela Aplicativos está acessível e a lista estava vazia.
O formulário novo foi inspecionado, sem preencher ou salvar: chaves só são
geradas após definir permissões e salvar.

Próxima proposta: [aplicativo privado somente leitura e coletor temporário](read-only-access.md),
com nome, callback local, sete módulos de leitura e oito GET fixos definidos.
O coletor foi preparado e testado offline, sem conectar à conta real. Essa
criação/conexão ainda não foi aprovada. Não há novo app ou credencial remoto.
A captura da instalação está localmente em
`var/olist-phase1/gestao-aplicativos-instalada.jpg` no checkout principal,
fora do Git. A captura anterior documenta a tela antes de instalar.

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

1. Aprovar a [proposta exata de acesso somente leitura](read-only-access.md)
   antes de criar aplicativo ou credenciais. A extensão já foi instalada com
   autorização. Conferir conta, permissões e quotas pela API; a UI não
   substitui prova autenticada do contrato v3. Endpoint de Gatilhos não foi
   localizado no snapshot público; não inventar rota/escopo.
2. Conferir comprador/variações e vendedor/natureza/depósito/pagamento no alvo,
   mantendo IDs/documentos fora do Git. Confirmar que o PO pode autorizar o
   uso dessas identidades; não selecionar por nome parecido.
3. Confirmar referência independente do marketplace, composição tributária,
   ausência de efeito financeiro/estoque/notificação e impacto em relatórios.
4. Apresentar o payload final em visão privada, com valor/contagem/IDs
   selecionados, plano de leitura/retencão e efeitos concretos; só então pedir
   aprovação do POST único. Aprovação de consulta não autoriza essa criação.

## Comprador fictício e CPF gerado

O PO sugeriu criar um fictício e usar gerador de CPF se não houvesse cadastro
para reutilizar. Nenhum CPF foi gerado ou enviado e nenhum comprador foi criado.
Número com dígitos verificadores válidos não comprova identidade e pode coincidir
com titular real; na conta operacional, a proposta permanece pendente de dados
apropriados para teste e de aprovação do caso completo.

Para a prova fiscal, preferir comprador existente autorizado/da própria empresa
com cadastro válido ou identidade de testes aceita pelo Olist. Um cadastro
meramente técnico sem documento, se aceito pelo ERP e aprovado para teste,
não comprovará OLIST-35 nem substituirá a exigência de cadastro completo da
integração. Não atualizar o contrato de produção para aceitar dado inventado
com base em um experimento. Nenhum dado pessoal/fiscal é incluído neste arquivo.

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
