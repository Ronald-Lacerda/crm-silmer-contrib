# Recebimentos externos e conferência de pagamentos

Contrato da [ADR067](../adr/067-recebimentos-externos-e-conciliacao-de-cobrancas.md)
e [BFIN-01–08](../../.specs/features/order-billing-completion/spec.md).
Complementa [cobranças](order-billing.v1.json) e
[intenções de envio](order-billing-chat.md). Rotas humanas usam sessão,
CSRF/origem, Idempotency-Key e versões atuais, com ACL sob lock. Não aceitam
Basic nem autoria/destino informado pelo navegador. Respostas são privadas.

Base: `/api/v1/orders/{orderId}/billing`.

| Operação                                      | Corpo                                                                                      | Resultado                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `POST /external-receipts`                     | `expectedVersion`, `expectedBillingVersion`, `amountCents`, `receivedOn`, `method`, `note` | Visão financeira atual com lançamento externo e totais recalculados |
| `POST /external-receipts/{receiptId}/reverse` | Versões, `reason`                                                                          | Visão financeira após reversão integral do registro                 |
| `POST /charges/{chargeId}/check-payment`      | Versões, `invoiceSlug`, `transactionNsu`                                                   | 202 com `checkId` e `state`; não confirma pagamento                 |

`amountCents` é inteiro seguro positivo, mínimo um centavo e limitado ao
saldo atual. `receivedOn` é data civil válida `YYYY-MM-DD`, não futura em
São Paulo. `method` aceita `cash`, `pix_external`, `bank_transfer` ou
`card_external`. `note` aceita texto vazio e até 500 caracteres. `reason`
exige texto não vazio, até 500 caracteres. Nota e motivo são cifrados no banco;
não aparecem em log nem em payload de auditoria. A UI não oferece devolução
de dinheiro por essa operação.

Registrar dinheiro externo exige pedido confirmado fora da loja, sem revisão
financeira pendente, responsabilidade atual/Admin ativo e saldo suficiente.
Repetição idêntica preserva o mesmo registro; payload divergente conflita.
Correção não edita nem apaga valor, método, data e autoria originais. Reverter
e lançar outro recebimento são ações humanas distintas com histórico.

Exemplo: pedido10000 + InfinitePay3000 + externo7000 = recebido10000/saldo0.
Pagamento parcial não preenche Pago em. Quitação considera recebimentos
aplicados e data efetiva, não apenas o horário do lançamento. Reversão,
reabertura ou revisão podem invalidar quitação e check financeiro.

## Consulta e proveniência

`GET /billing` acrescenta `payments`, `externalReceipts`, `paymentChecks` e
`chatSendEnabled` e `paymentCheckEnabled`. Pagamentos possuem origem explícita; nota/motivo e detalhes
privados respeitam a permissão de gestão. A interface consulta as duas telas
pela mesma API, não soma crédito a partir de uma página de histórico.

O histórico de intenções inclui eventos `external_receipt` e
`external_reversal`. `chargeId` é null nesses eventos; `externalReceiptId`
associa o registro externo. `source` distingue `external` e `infinitepay`.
Eventos `payment_check` registram tentativas e resultados da conferência;
o valor consultado nesse evento não é crédito nem recebimento.
Vínculos de correção/retry continuam sendo IDs persistidos, não inferência por
data ou valor. `canRetry` é indicação para revisar tentativa, não autorização
para repetir efeito sem passar novamente pelo comando e pelas guardas.

## Conferência verificada

Os identificadores `invoiceSlug` e `transactionNsu` aceitam letras, números,
underscore/hífen, de 1 a 128 caracteres. Eles são candidatos, nunca prova de
pagamento. Ficam cifrados e a consulta durável usa job `billing.payment.check`.
O worker envia `{schema_version:"1.0",check_id}` ao webhook privado configurado
por `ORDER_BILLING_CHECK_N8N_URL`, sem enviar dados financeiros arbitrários.
Essa configuração deve ser compartilhada pela API e pelo worker. Sem ela,
nova conferência é recusada com `BILLING_CHECK_DISABLED`, sem criar job;
recebimento externo permanece independente dessa disponibilidade.

O workflow dedicado autentica a chamada e consulta o candidato no CRM:

- `GET /api/v1/integrations/n8n/billing/payment-checks/{checkId}` com capacidade
  técnica `billing.checkout.read` e identidade de workflow financeiro.
- Consulta cobrança conhecida, chama `payment_check` e valida a resposta.
- Se pago, persiste primeiro pelo callback financeiro existente, com NSU único.
- `POST /api/v1/integrations/n8n/billing/payment-checks/{checkId}/result` com
  `{status:"paid"}` ou `{status:"not_paid"}`, capacidade `billing.payment.record`.
  Declarar paid sem o recebimento correspondente já persistido é recusado.

Repetir consulta é seguro: não gera checkout nem mensagem. Resultado não pago
pode ser rechecado a cada dez minutos, limitado a seis rodadas por candidato;
falhas de transporte têm tentativas limitadas próprias. A UI distingue fila,
não confirmado e falha/incerteza, sem transformar HTTP202 em crédito.

Quando o webhook não chega e os identificadores não são conhecidos, o operador
precisa conferi-los no provedor. Não há descoberta por nome/valor ou API de
listagem presumida. Não lançar pagamento InfinitePay pendente como externo.
Um link já enviado não é considerado cancelado quando o saldo é recebido
presencialmente: pagamento tardio/excesso permanece no histórico e exige revisão.

Consulta, recebimento e reversão autorizados continuam possíveis no modo de
recebimento; desligar emissão/envio não interrompe callbacks. Produção e seus
workflows/credenciais não são habilitados por esta implementação.
