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
