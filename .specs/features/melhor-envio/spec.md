# Melhor Envio — conexão e cotação administrativa

Baseline: [ADR 053](../../../docs/adr/053-conexao-e-cotacao-administrativa-melhor-envio.md).
T138, continuidade T137/ME-0 e MEV-13 parcial da RFC 038.

| ID      | Critério de aceite                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MEVC-01 | Menu e API exclusivos de administrador humano ativo com `COMMERCIAL_ADMIN`; vendedor, Financeiro, automação e anônimo não acessam a conexão.                                                                             |
| MEVC-02 | OAuth pede somente cálculo e transportadoras. Estado aleatório expira em dez minutos, pertence ao usuário/sessão e só pode ser usado uma vez. Callback exige sessão, origem e CSRF e remove parâmetros sensíveis da URL. |
| MEVC-03 | Client secret e chave de envelope são privados da API. Tokens cifrados persistem no PostgreSQL, separados por ambiente/aplicativo/callback; nunca chegam à UI, log ou auditoria.                                         |
| MEVC-04 | Renovação entre réplicas tem reserva durável antes do efeito e persiste o par de tokens. Revogação ou resultado incerto pede reconexão, sem retry cego nem logout do CRM.                                                |
| MEVC-05 | Cotação exige CEPs, peso em gramas, medidas em centímetros e valor segurado em centavos. Há limites de payload e frequência; não há proxy de corpo/URL arbitrários.                                                      |
| MEVC-06 | UI apresenta transportadora, serviço, preço e previsão, com estados vazio, indisponível, erro e carregamento. Mudança de entrada invalida resultado. Cotação não compra, envia mensagem nem altera pedido.               |
| MEVC-07 | Conexão e desconexão são auditadas sem segredos. Desconectar apaga tokens ativos e invalida estados pendentes; operações anteriores não reativam a conta. Reconectar exige novo consentimento.                           |
| MEVC-08 | Teclado, labels, foco, anúncios e layout responsivo seguem o shell/tokens existentes. Desativado/incompleto é um estado explícito, sem quebrar startup.                                                                  |

MEV-01–12 e MEV-14–16 da RFC não são declarados atendidos por esta entrega.
Dados fiscais, compra e mudanças comerciais dependem das decisões da RFC.

## Cotação na conversa e no pedido — T139

Autorização do proprietário em 02/11/2026, registrada na
[ADR 054](../../../docs/adr/054-cotacao-na-conversa-vinculada-ao-pedido.md).
Atende MEV-02–04 parcialmente: tabela de peso por peça, cidade/UF automática
e validade comercial da cotação continuam dependentes de definição própria.

| ID      | Critério de aceite                                                                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEVQ-01 | Humano ativo responsável pela conversa ou administrador pode cotar na conversa aberta em atendimento humano. Financeiro, automação, anônimo e outro vendedor são recusados. A conexão continua administrativa.                                             |
| MEVQ-02 | Assunto e Pedido são explícitos e vinculados na conversa. A API confere os alvos e a versão antes e depois da consulta remota; troca de dono, encerramento e mudança concorrente não gravam resultado indevido.                                            |
| MEVQ-03 | Cotação exige CEPs, peso em gramas, medidas em centímetros e seguro em centavos explícitos. CEP reconhecido na mensagem oferece atalho focável. Não há peso padrão inventado.                                                                              |
| MEVQ-04 | Resultado apresenta serviços, transportadoras, preços e previsões projetados da API. Seleção aceita apenas serviço retornado e grava estimativa vinculada, com autor, instante, quantidade e versão do pedido. Nunca aceita preço arbitrário do navegador. |
| MEVQ-05 | Conversa e página do pedido mostram a estimativa separada do valor comercial. Mudança do pedido/grade ou das entradas exige nova consulta. Respostas tardias não substituem outro alvo.                                                                    |
| MEVQ-06 | Escrever resposta com frete preenche somente o composer para revisão humana, sem envio nem sobrescrita silenciosa de rascunho. Informa data e natureza estimada, sem prometer validade comercial ainda não aprovada.                                       |
| MEVQ-07 | CEPs e resultado persistidos ficam cifrados, inclusive em respostas idempotentes persistidas. Mutação usa sessão, origem, CSRF, idempotência, ACL revalidada e auditoria sem PII. Dados da cotação não entram em logs.                                     |
| MEVQ-08 | UI segue shell/tokens atuais, teclado, labels, foco, anúncios e responsividade, com loading, vazio, erro e recuperação. Consultar/selecionar não altera total, ficha, pagamento ou status, não compra etiqueta e não envia mensagem.                       |
