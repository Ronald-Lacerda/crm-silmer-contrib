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
