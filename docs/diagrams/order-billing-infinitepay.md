# Cobrança InfinitePay pelo chat

Fluxo do backend integrado à master em 08/11/2026. O botão no chat está em
protótipo local para avaliação. Flags reais permanecem desligadas.

```mermaid
flowchart TD
  seller["Vendedor no chat"] --> review["Botão Cobrança: revisar pedido, destino e valor"]
  review --> intent["CRM valida acesso e registra a intenção no PostgreSQL"]
  intent --> financialQueue["Fila financeira existente"]
  financialQueue --> billingWorkflow["n8n financeiro reserva a criação uma única vez"]
  billingWorkflow --> infinitePay["InfinitePay gera link de uso único com validade"]
  infinitePay --> saved["CRM salva link cifrado"]
  saved --> eligible{"Contexto ainda permite enviar?"}
  eligible -->|"Não"| blocked["Bloqueia envio e conserva link e histórico"]
  eligible -->|"Sim"| messageQueue["Grava mensagem humana e fila de envio na mesma transação"]
  messageQueue --> transport["Transporte humano reserva e revalida antes do envio"]
  transport --> customer["Cliente recebe o link na conversa"]
  customer --> checkout["Cliente paga no checkout InfinitePay"]
  checkout --> notice["InfinitePay avisa o n8n por webhook"]
  notice --> verified["n8n consulta payment_check e confere a cobrança"]
  verified --> receipt["CRM registra recebimento, deduplica e atualiza saldo"]
  receipt --> settlement{"Pagamento cobre o total do pedido?"}
  settlement -->|"Não"| balance["Mantém saldo para uma nova cobrança humana"]
  settlement -->|"Sim"| paid["Registra quitação integral"]
  balance --> review
```

## O que o vendedor acompanha

Gerando link → na fila → enviando → enviado → entregue são etapas do
transporte. Pagamento confirmado é um fato financeiro separado. Receber o
link ou abrir o checkout não quita o pedido.

Exemplo: pedido de R$ 1.200,00 com sinal de 30% gera R$ 360,00. Confirmado o
sinal, Cobrar saldo calcula R$ 840,00 no servidor, sem cobrar novamente o sinal.

## Correção, link anterior e falhas

```mermaid
flowchart TD
  previous["Cobrança anterior"] --> situation{"Qual é a situação?"}
  situation -->|"Link ainda válido ou efeito incerto"| hold["Aguardar ou conferir; não gerar substituta cegamente"]
  situation -->|"Vencida, encerrada e sem pagamento"| agreement["Pessoa confirma acordo e conferência no provedor"]
  agreement --> corrected["Nova cobrança pelo valor acordado, limitado ao saldo"]
  corrected --> history["Link e valor anteriores continuam no histórico"]
  situation -->|"Pagamento parcial confirmado"| remaining["Cobrar somente o saldo calculado"]
  situation -->|"Falha comprovada antes do envio"| retry["Nova tentativa humana com o mesmo link válido e novo comando"]
```

Corrigir não cancela o link anterior na InfinitePay. O backend exige
vencimento/encerramento e conserva recebimentos; pagamento tardio exige
conferência. Resultado incerto não autoriza retry automático. Se o pagamento
chegar durante um envio já em andamento, ambos os resultados são preservados.

## Conta e ativação

A credencial privada da conta fica no n8n como `X-Api-Key`, acompanhada da
InfiniteTag da mesma conta. O workflow financeiro cria links e verifica
pagamentos; o transporte humano envia a mensagem. n8n não acessa o banco CRM.

Preparação e ativação estão no [runbook](../runbooks/order-billing.md).
Contratos: [BAPI-01–10](../../.specs/features/order-billing/spec.md) e
[ADR 076](../adr/076-intencoes-de-cobranca-e-envio-transacional.md).
Diagrama conferido contra `order-billing-chat-runtime.js`,
`order-billing-runtime.js`, `billing-send-guard.js` e os workflows locais.
