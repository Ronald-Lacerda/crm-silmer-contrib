# ADR 058 — Cobranças do pedido com InfinitePay

Status: aceita. Data: 05/11/2026. Decisor: proprietário do produto.

Após definir 0%, X% e 100%, Pix e cartão inclusive parcelado, o proprietário
avaliou o protótipo e autorizou: “Gostei, faça”. Seus valores são sintéticos,
não configuram preço ou cobrança real.

RFC: [049](../rfc/049-cobrancas-do-pedido-com-infinitepay.md).
Contrato: [COB-01–16](../../.specs/features/order-billing/spec.md).
Entrega: [COB-DEL-01](../../.specs/features/order-billing/tasks.md).
Issue/PR: vincular na publicação da entrega.

## Decisão

- Cobranças pertencem ao pedido confirmado, manual ou de atendimento. 0%
  salva sem entrada; X% cobra sinal e depois saldo por ação humana; 100%
  cobra integral. Pix/cartão e parcelas são escolhas do comprador no checkout.
- Percentual inteiro, sinal arredondado ao centavo e saldo por subtração.
  Cada parte tem mínimo de R$ 1,00. Preço/condição e envio do link são humanos.
- Workflow n8n dedicado, mesma infraestrutura; CRM é fonte oficial de plano,
  cobrança, recebimento e saldo. Não usar `store-orders`, Data Table como
  livro financeiro ou reservas de mensagens para efeitos financeiros.
- Reserva e outbox transacionais; uso único antes da criação externa.
  Timeout posterior é desconhecido, sem retry cego. n8n verifica pagamento
  por `payment_check` antes do callback autenticado/idempotente.
- Consumo de transação comum à loja e ao atendimento. Principal separado
  de taxas; sinal não preenche `paid_on`. Só quitação integral conciliada
  qualifica a data e o Financeiro. Parcelas do cartão não são dívida comercial.
- Reabertura/mudança do acordo preserva recebimentos, exigindo reaplicação
  humana explícita. Devolução feita no provedor é registrada e auditada,
  sem estorno pelo CRM. APIs de datas não contornam falta de cobertura.
- Responsável atual/admin configura, emite e concilia com sessão, CSRF,
  versões e idempotência. Financeiro e agente não ganham essas capacidades.
  Links privados só são apresentados a quem gerencia o pedido.
- Links de uso único e validade de 24h com API Key no n8n; preservar taxas
  da conta/loja. Flags separam emissão do recebimento/reconciliação no rollback.

## Precedência e operação

Emenda ADRs 006/008 e 040/042 apenas para pedidos geridos pela integração.
Pedido conserva dois status; Financeiro mantém check humano de nota. Não
reativa o fluxo PAY de chave Pix, comprovante manual ou boas-vindas. Loja
da ADR 028 permanece no contrato próprio.

Sem framework, store global, Redis ou infraestrutura nova. Migração expand
precede habilitação. Configuração da conta, pagamento real e recovery são
gates operacionais próprios; mocks não os comprovam. Ver
[runbook](../runbooks/order-billing.md).
