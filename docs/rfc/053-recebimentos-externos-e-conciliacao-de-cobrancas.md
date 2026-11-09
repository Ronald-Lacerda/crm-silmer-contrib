# RFC 053: recebimentos externos e conciliação de cobranças

Status: aceita pelo proprietário em 08/11/2026. Decisão na
[ADR 067](../adr/067-recebimentos-externos-e-conciliacao-de-cobrancas.md).
Continuação do [PR 298](https://github.com/romulosutil/crm-silmer/pull/298),
da RFC047 e da entrega DEV. Critérios e tarefas em
[order-billing-completion](../../.specs/features/order-billing-completion/spec.md).

O pedido precisa refletir pagamento misto e recuperar confirmação ausente.
Alterar apenas Pago em perderia valor, fonte e auditoria. Registrar dinheiro
presencial como transação InfinitePay fabricaria identidade e prejudicaria a
deduplicação. O livro externo pertence ao pedido e participa do mesmo saldo.

Responsável/Admin registra valor, data efetiva e método externo. Correção usa
reversão integral do lançamento com motivo e novo registro explícito, sem
estorno de dinheiro pelo CRM. Notas/motivos são privados, protegidos como os
demais dados comerciais. Reabertura, excesso, quitação e Financeiro conservam
os controles existentes, agora considerando as duas fontes.

Conferir pagamento é uma consulta durável, não uma declaração humana de que
o gateway pagou. Candidato fica cifrado; worker envia somente check_id ao
n8n privado. O n8n consulta a cobrança conhecida e o payment_check, persiste
recebimento pelo callback financeiro existente e registra resultado antes do
sucesso. A consulta pode ser repetida com segurança; não cria link ou mensagem.

A documentação oficial exige handle, order_nsu, transaction_nsu e slug para
[payment_check](https://www.infinitepay.io/checkout-documentacao). Sem os
identificadores necessários, o CRM solicita conferência no provedor em vez
de presumir que não houve pagamento. Consultas conhecidas não pagas terão
rechecagem limitada; não se promete descoberta por listagem não documentada.

O proprietário liberou implementar a interface no redesign atual. A ação
fica junto às ações da Inbox, com diálogo compartilhado e histórico no Pedido.
O ambiente DEV interativo usa os contratos reais com dados e provedores
sintéticos, complementando o ensaio n8n existente. Ativação remota, dinheiro
e mensagens reais continuam fora desta autorização.

Alternativas rejeitadas: editar data de quitação diretamente, criar NSU fake,
escrever no banco pelo n8n, consultar identificadores presumidos e misturar
checkout da loja com cobrança de pedido existente.
