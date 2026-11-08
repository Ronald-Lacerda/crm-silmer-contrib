# Cobranças do pedido — contrato aprovado

Decisão: [ADR 058](../../../docs/adr/058-cobrancas-do-pedido-com-infinitepay.md)
e [RFC 049](../../../docs/rfc/049-cobrancas-do-pedido-com-infinitepay.md).
Protótipo aprovado pelo proprietário em 05/11/2026, seguido de autorização
expressa para implementar.

## Fronteira

Pedidos confirmados fora da loja. 0% salva sem entrada e a cobrança integral
é posterior, humana; X% gera sinal e depois saldo por nova ação humana; 100%
quita integralmente, permitindo cartão parcelado pela InfinitePay.
Percentual inteiro, sinal arredondado ao centavo, saldo por subtração e mínimo
de R$ 1,00 em cada parte. Os valores do protótipo são fictícios.

## Critérios de aceite

| ID     | Critério verificável                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| COB-01 | Responsável atual pelo pedido/conversa ou administrador pode configurar e emitir; usuário desativado, outro vendedor, perfil Financeiro e agente são recusados. Revalidar ACL sob lock, inclusive no replay.                               |
| COB-02 | 0% não emite link de zero; X% exibe sinal e saldo corretos; 100% cobra o integral. Valores inválidos, acima de 100%, parte abaixo de R$ 1,00, ausência de preço e pedido pendente são recusados; R$ 1,00 com sinal de 50% é caso negativo. |
| COB-03 | Pix e cartão são reconhecidos; parcelamento do cartão não gera parcelas comerciais no CRM nem altera o preço aprovado.                                                                                                                     |
| COB-04 | Sessão, CSRF, origem, idempotência e revisão protegem emissão; duas ações concorrentes produzem uma única reserva de cobrança.                                                                                                             |
| COB-05 | Repetição idêntica devolve o mesmo resultado; corpo divergente conflita; timeout após início do efeito permanece desconhecido, sem novo link automático.                                                                                   |
| COB-06 | Webhook/retorno forjado não quita. Conta, cobrança conhecida, fatura, NSU, método e valor são verificados no servidor; cobrança menor ou de outro pedido é recusada.                                                                       |
| COB-07 | Webhooks repetidos ou concorrentes com consulta de confirmação geram um único recebimento; comprovante tardio não duplica crédito nem muda o primeiro horário.                                                                             |
| COB-08 | O mesmo NSU não pode quitar loja e atendimento, ou duas cobranças. Recebimento, deduplicação, aplicação e auditoria compartilham transação.                                                                                                |
| COB-09 | Sinal confirmado mantém saldo e não preenche `paid_on`; somente o integral conciliado permite quitação. Taxas não aumentam o crédito comercial.                                                                                            |
| COB-10 | Reabertura, mudança de preço e pagamento tardio conservam histórico e exigem revisão do acordo anterior. O trigger financeiro vigente não é contornado.                                                                                    |
| COB-11 | APIs antigas de datas não podem declarar quitado um pedido gerido pela integração com saldo pendente. Migração preserva datas legadas sem inventar recebimentos.                                                                           |
| COB-12 | UI reutiliza design e componentes atuais, com teclado, foco, nomes acessíveis, celular e anúncios de processamento, pagamento, falha e resultado desconhecido.                                                                             |
| COB-13 | URLs somente HTTPS e hosts autorizados; credenciais, payloads, URLs privadas e PII ficam fora de log/auditoria. Consulta respeita o acesso ao pedido; não há tela financeira pública por ID.                                               |
| COB-14 | Reentrega, falha entre reserva e resposta, falha de auditoria e callbacks tardios são recuperáveis. Confirmar recebimento só após persistência durável ou deixar falha para reentrega.                                                     |
| COB-15 | Rollback impede novas emissões, mas mantém confirmação e reconciliação dos links existentes. Desligar a UI não interrompe o recebimento desses eventos.                                                                                    |
| COB-16 | Devolução conhecida, total ou parcial, é conciliada por comando humano autorizado, versionado e auditado; preserva o pagamento original e invalida quitação/check financeiro quando afetados. Repetição não duplica abatimento.            |

## Estados e recuperação

Cobrança: `queued`, `creating`, `waiting`, `unknown`, `paid`, `review`,
`closed`; são estados financeiros, não novos status comerciais. Plano tem
versão própria. Vínculo comercial usa confirmação, valor e condição, sem
invalidar recebimentos por edição de observação.

Conciliação humana `apply_current` reaplica crédito existente ao acordo
vigente após conferência; `close_unpaid` encerra risco local só após validade
vencida e conferência explícita. Callback tardio continua em revisão. Não
permitir saldo negativo nem inferir valor recebido de datas legadas.
Devolução é registro de operação já feita no provedor, sem estorno pelo CRM.

## Backend do envio integrado, BAPI-01–10

Autorizado pelo proprietário em 06/11/2026; [ADR 066](../../../docs/adr/066-intencoes-de-cobranca-e-envio-transacional.md).
Frontend adiado até o redesign. Contrato de comandos/respostas e erros:
[API de intenções](../../../docs/api/order-billing-chat.md).

| ID      | Critério de aceite                                                                                                                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BAPI-01 | WHEN uma intenção válida é submetida, THE API SHALL retornar 202 com identidade/versão/estado da intenção, sem afirmar envio ou pagamento. Publicar os schemas das cinco ações e leituras.                                                                                                                 |
| BAPI-02 | WHEN corpo contém campo extra/ausente, tipo coercível, inteiro inseguro, 0% para emitir, correção abaixo de R$ 1 ou confirmação ausente, THE API SHALL recusar 400 antes de chamar o serviço. Saldo não aceita valor do cliente; texto/destino externo não são aceitos.                                    |
| BAPI-03 | WHEN uma operação é solicitada, THE API SHALL exigir sessão humana e capacidade de leitura/gestão; escrita exige origem, CSRF e Idempotency-Key. Basic é recusado. Ator vem da sessão e versões/ACL são revalidadas pelo serviço.                                                                          |
| BAPI-04 | WHILE escrita está desativada, THE API SHALL retornar 503 BILLING_DISABLED sem chamar submit e preservar leitura de intenção/histórico. Default da fronteira HTTP é escrita desativada.                                                                                                                    |
| BAPI-05 | WHEN ocorre leitura ou erro, THE API SHALL emitir headers privados e projeção sem PII/URLs privadas/payloads. Histórico aceita apenas cursor e limit 1–50, default20; erros usam problem JSON seguro.                                                                                                      |
| BAPI-06 | WHEN comandos concorrentes ou replay ocorrem, THE backend SHALL preservar uma intenção/efeito por ação autorizada, revalidar ACL sob lock e rejeitar divergência de payload/ator. Intenção, outbox e auditoria compartilham a transação.                                                                   |
| BAPI-07 | WHEN link é criado e o contexto mudou, THE backend SHALL preservar URL cifrada e bloquear envio; callback duplicado não cria nova mensagem. Reserva final revalida ator, responsável/ciclo, acordo, saldo, validade e revisão inbound, preservando o responsável.                                          |
| BAPI-08 | WHEN há correção ou cobrança do saldo, THE backend SHALL preservar recebimentos e links, calcular saldo no servidor, recusar outra cobrança ativa e bloquear emissão na quitação. Correção exige anterior vencida/encerrada sem pagamento e acordo/conferência explícitos; callback tardio requer revisão. |
| BAPI-09 | WHEN transporte fica incerto, THE backend SHALL bloquear retry cego. Falha conhecida antes do envio permite nova intenção humana para o mesmo link válido e comando novo, sem consumir outra vez uma reserva anterior.                                                                                     |
| BAPI-10 | WHILE emissão integrada está desligada, THE backend SHALL impedir novas intenções/reservas e conservar recebimento financeiro, consulta, conciliação e histórico. Transporte e recebimento mantêm estados independentes.                                                                                   |

B01 cobre a fronteira HTTP de BAPI-01–05. B02 implementa
admissão/idempotência durável, saldo/correção, locks e histórico, com testes
PostgreSQL de BAPI-05/06/08 e guardas iniciais de BAPI-07/09. B03 implementa
composição, callback e reserva/preflight finais de BAPI-07/09; B04 integra
rotas/flags e recuperação de BAPI-10. Evidências e limites nos relatórios de QA.
Não considerar
um teste com serviço sintético como evidência transacional.
