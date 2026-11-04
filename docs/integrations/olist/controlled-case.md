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
conta dedicada não é mais a condição de ambiente. Posteriormente o PO aprovou explicitamente criar e conectar o aplicativo
privado somente leitura. Essa aprovação foi executada; não abrange cliente,
produto, variação, pedido, ampliação de acesso, parâmetros comerciais, serviço
pago, documento ou mensagem.

A inspeção inicial abaixo foi feita pela interface, sem chamar a API v3,
salvar parâmetros ou alterar registros ERP. Depois, o aplicativo autorizado
executou os oito GET da seção seguinte. Os valores abaixo foram lidos dos controles
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

| Consulta adicional                     | Resultado observado                                         | Consequência                                                                               |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Gestão de Aplicativos                  | Instalada GRÁTIS após aprovação do PO; confirmado INSTALADO | Aplicativos disponível; aplicativo somente leitura criado depois, com aprovação específica |
| Token API                              | Consta INSTALADO                                            | Não foi aberto/copiado segredo; não substitui prova de acesso v3                           |
| Reserva de estoque                     | Não instalada; disponível GRÁTIS                            | Nenhuma instalação; comportamento de efeitos externos ainda sujeito à prova                |
| Webhooks                               | Não instalada; catálogo exige UPGRADE                       | Não contratar upgrade; isso não prova ausência de toda integração externa                  |
| Painel de Automações: saída de estoque | Desabilitada                                                | Confirma parâmetro manual observado                                                        |
| Painel de Automações: emitir NF-e      | Desabilitada                                                | Sem geração automática nesse painel; comandos fiscais continuam fora do teste              |
| Painel de Automações: expedição        | Habilitada ao salvar nota fiscal                            | Não gerar/salvar nota; nenhum comando de expedição/etiqueta                                |
| Busca de comprador por teste           | Nenhum registro encontrado                                  | Limitado aos filtros atuais; não selecionar comprador real arbitrário                      |
| Busca de produto ativo por teste       | Nenhum resultado                                            | Ainda faltam duas variações exatas para congelar o caso                                    |
| TikTok: fluxo de produtos              | Importação não atualiza SKU; imagens como anexos            | Não trata de garantia de ausência de publicação; não publicar/vincular produtos            |

A busca de configurações por gatilho não encontrou item; o painel consolidado
foi localizado pela navegação de Vendas. O resultado negativo da busca não foi
usado como prova de ausência de gatilhos. São 36 observações sanitizadas no
JSON inicial; nenhum parâmetro comercial foi salvo. Oito GET autenticados
v3 foram executados depois, conforme evidência real abaixo.

## Acesso somente leitura executado

A extensão Gestão de Aplicativos foi instalada gratuitamente após aprovação.
O PO depois autorizou explicitamente criar e conectar o aplicativo privado
**CRM Silmer - prova F1 - somente leitura**, com callback local e sete módulos
somente Leitura. Nenhum Incluir/editar/Excluir foi habilitado.

[Oito GET reais](evidence/read-only-live-result.json) retornaram 200:
conta confirmada por /info; zero contatos/produtos com teste; zero pedidos da
referência proposta; sete vendedores; um depósito; dez itens na primeira página
de cada forma de pagamento/recebimento. A quota de leitura observada foi de
30/minuto. Contagens de página não são totais; zero não prova unicidade nem
autoriza repetir POST incerto. O OAuth aceitou o callback HTTP de loopback.

O coletor foi encerrado, sem persistir tokens. O aplicativo permanece cadastrado
somente leitura; o segredo foi ocultado novamente na UI. Capturas locais sem
segredo em var/olist-phase1/, fora do Git.
[Configuração e limites da prova](read-only-access.md).

## Seleção do caso pela interface

O PO escolheu usar a própria Silmer. A busca por fantasia encontrou um cadastro
SILMER com CNPJ estruturalmente válido, IE e endereço preenchidos na UI. Seu
documento **difere** da empresa configurada na conta; a confirmação do PO sobre
qual pessoa jurídica usar permanece pendente. A busca por nome não substitui
a identidade fiscal: a seleção final exige GET por documento/ID, em canal
privado, sem atualizar o cadastro existente.

Uma tentativa de busca pelo documento foi mascarada na leitura protegida do
navegador e foi descartada como evidência de ausência. A busca subsequente pelo
nome exibiu o cadastro acima. Não alegar que o comprador está ausente.

Foi localizado um pai de camisa PV com oito variações, grade Tamanho,
incluindo M/G/GG com SKUs distintos. A UI mostra unidade, origem e NCM; os
valores ficam na conferência privada. M/G são candidatas para a primeira venda,
sem editar preço, cadastro ou saldo. Essa leitura não prova ainda o vínculo,
filtro de SKU ou fiscal aceito pela API.

## Caso C01 preparado — ainda sem autorização de escrita

Usar o comprador SILMER após confirmação da pessoa jurídica pelo PO e as
variações M/G do pai de camisa PV conferido. IDs, documentos e SKUs reais ficam
somente na evidência privada. Não criar cliente/produto para viabilizar C01.

| Campo / limite         | Proposta concreta                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Referência             | CRM-F1-20261104-C01; consultar novamente antes da escrita; não tratar a referência como chave única                                                                                 |
| Comprador              | Cadastro existente confirmado pelo PO e conferido por documento/ID; nunca por nome sozinho                                                                                          |
| Linhas                 | M: quantidade 1, valorUnitario 1,00; G: quantidade 1, valorUnitario 2,00; subtotais 1,00 e 2,00; total 3,00                                                                         |
| Situação               | situacao 0, Aberta, conforme enum oficial; nenhuma transição posterior                                                                                                              |
| Data                   | Dia de São Paulo congelado na execução aprovada; não inventar data de entrega                                                                                                       |
| Referência API         | ecommerce.numeroPedidoEcommerce; omitir ecommerce.id, sem vincular marketplace; aceitação ainda a provar                                                                            |
| Campos omitidos        | Pagamento/parcelas/pagamentosIntegrados, vendedor, depósito e naturezaOperacao, que não são required no schema; se a conta exigir, parar e revisar o campo central, sem inventar ID |
| Valores omitidos       | Frete, desconto e outras despesas, sem ajustes para compensar diferença; conferir tributos calculados                                                                               |
| Limite                 | Até 1 POST /pedidos e até 30 GET delimitados por conta/documento/IDs/códigos/referência; sem retry automático                                                                       |
| Permissão necessária   | Ampliar somente Pedidos para Incluir e editar, que a UI agrupa; Excluir e demais escritas continuam desmarcados. O executor deve recusar PUT/PATCH/DELETE e POST fora do caso       |
| Efeitos reais          | Consome número sequencial, cria histórico, pode aparecer em relatórios e receber marcador de primeira venda; registro permanece no ERP                                              |
| Operações fora do caso | Nota fiscal, estoque/balanço, contas/baixa/estorno, cobrança, expedição, publicação, mensagens, atualização de cadastros e cancelamento/exclusão                                    |
| Falha ou divergência   | Parar; preservar IDs/resposta privada; consultar para reconciliar; zero resultados não libera segundo POST                                                                          |

A autorização de leitura não libera C01 nem a ampliação de Pedidos. A próxima
aprovação precisa abranger expressamente a permissão agrupada e esse POST único,
depois de confirmar o comprador. O aplicativo deve receber nome que reflita a
permissão ampliada; não manter somente leitura no nome após conceder escrita.

Antes de executar, conferir conta/identidades/ausência da referência por API,
quota atual e correspondência do payload com a aprovação. Se houver cobrança,
scope extra, identidade divergente ou campo central obrigatório sem fonte,
interromper. A inclusão deve ser feita uma vez e seguida de detalhe por ID e
conferência de cada subtotal na UI, pois o schema de resposta não expõe um
subtotal independente por item. Total global igual não basta.

Os gatilhos inspecionados não apontam nota/estoque/financeiro ao salvar pedido:
estoque manual, emissão automática de NFe desativada e contas a receber ao
autorizar NF. Expedição está ativa ao salvar NF. Isso não é garantia absoluta
de ausência de toda integração externa. Se surgir efeito não previsto, parar,
sem alterar parâmetros globais nem cancelar como limpeza.

## Provas adicionais necessárias para fechar F1

C01 prova apenas a venda exata com cadastros existentes. Não encerra T02.
As próximas propostas devem ser preparadas e aprovadas antes das respectivas
inclusões; o orçamento abaixo é planejamento, sem autorização:

| Caso                  | Dados e limite planejado                                                                                                                                                                        | Evidência exigida                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cliente novo          | Até 1 POST contato, com identidade válida ausente escolhida pelo PO; considerar a empresa configurada na conta, distinta do contato SILMER, se aprovada e ausente por documento                 | Obrigatórios fiscais/endereço, situacao B sem acesso ao sistema, ID e busca exata; se já existir, reutilizar e não criar duplicata para provar o caminho |
| Pai e filhos iniciais | Até 1 POST produto tipo V, grade Tamanho e M/G iniciais; prefixo CRM-F1-20261104-A, SKUs próprios; fiscal/unidade de modelo comercial aprovado, sem saldo/estoque inicial ou vínculo com canais | IDs do pai e de cada filho, vínculo/grade/SKU por readback; não assumir atomicidade                                                                      |
| Filho adicional       | Até 1 POST variação GG no pai novo, SKU próprio; parar e reconciliar qualquer incerteza                                                                                                         | Identidade/grade/vínculo; nenhum retry criador                                                                                                           |
| Terços                | Até 1 pedido: M 3 x 0,3333 e G 3 x 0,6667; expectativa diagnóstica 1,00 e 2,00 por linha                                                                                                        | Escala armazenada, cada subtotal e total, sem ajuste artificial                                                                                          |
| Empate e identidade   | Até 1 pedido diagnóstico: M novo 1 x 0,005; mesmo M novo 1 x 0,015; M existente 1 x 0,025; G novo 1 x 0,035; expectativa half-up hipotética 0,01/0,02/0,03/0,04                                 | Determinar regra real de empate; preservar quatro linhas, produto repetido e mesmo tamanho em grupos distintos                                           |
| Escala pequena        | Até 1 pedido: M 1000 x 0,000010 e G 1 x 0,01; expectativa diagnóstica 0,01/0,01                                                                                                                 | Escala aceita/rejeitada e subtotais; quantidade pode contaminar relatórios apesar de valor baixo                                                         |

As sondas de empate/escala são experimentos do contrato, não representam
payload de produção derivado de uma prévia CRM. A hipótese half-up não é
atribuída ao ERP antes da leitura real. Aceitação de seis casas comprova somente
a escala testada, não um máximo universal. Cada rejeição será registrada sem
repetir automaticamente a inclusão ou alterar valores para passar.

O conjunto C01 mais três sondas tem expectativa monetária hipotética de R$ 6,12
e teto de planejamento R$ 10,00. Esse teto não autoriza execução nem garante o
resultado antes de provar arredondamento. Todos os registros permaneceriam na
conta operacional e as quantidades poderiam aparecer em relatórios.

## CPF gerado e limites da prova fiscal

O PO sugeriu comprador fictício com CPF gerado e depois escolheu a própria
Silmer. Nenhum CPF foi gerado ou enviado. O gate F1 exige ausência de dado fiscal
inventado: dígitos verificadores válidos não comprovam identidade e podem
coincidir com titular real. Usar fontes válidas aprovadas pelo PO, sem mudar o
contrato de produção para contornar o teste.

Leituras existentes, mocks e C01 não substituem criação automática de
cliente/produto/variação, rejeições, precisão e recuperação. T02 e gate F1
continuam abertos; T03 não está liberada.
