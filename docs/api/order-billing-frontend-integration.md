# Cobranças — handoff para o frontend

COB-READY-01 / COB-API-READY, requisitos COB-01–16 e BAPI-01–11 da
[especificação](../../.specs/features/order-billing/spec.md),
[RFC 047](../rfc/047-enviar-cobranca-pela-conversa.md) e
[ADR 066](../adr/066-intencoes-de-cobranca-e-envio-transacional.md).

Este documento descreve como consumir os contratos existentes após o redesign.
Não aprova o visual, implementa componentes, amplia a API ou declara homologação.
O backend B01–B05 está integrado; o novo fluxo da interface continua pendente.
O [protótipo](../prototypes/README.md) compartilha fixtures entre chat e Pedido;
esses dados não substituem o contrato real.

## Pontos de integração

- Inbox: acrescentar a ação de cobrança à composição de ações da conversa em
  `apps/edge-web/src/views/InboxView.vue`, junto à entrada de cotação de frete.
  A referência atual é `ConversationShippingQuote`; reutilizar shell, tokens
  e padrões de foco vigentes quando o redesign estiver pronto. O botão abre
  revisão, não submete um comando financeiro ao ser aberto.
- Pedido: integrar a mesma operação na seção financeira existente
  `apps/edge-web/src/components/order/OrderBillingSection.vue`, usada por
  `apps/edge-web/src/views/OrderView.vue`. Compartilhar lógica de comandos e
  leitura entre as duas entradas sem introduzir store global ou estado em
  `window`. A seção atual continua oferecendo compartilhamento manual.
- HTTP: usar `request` e `commandKey` de
  `apps/edge-web/src/lib/api-client.js`; formatar centavos e validar links com
  `apps/edge-web/src/lib/order-billing.js`. Não colocar mensagem, link ou dados
  do cliente em armazenamento persistente, query string ou log.

Um pedido pode existir sem conversa elegível: manter geração/compartilhamento
manual disponível conforme o contrato vigente, sem inventar destinatário ou
vínculo por nome/telefone. Com vários pedidos elegíveis, exigir seleção explícita.
Consultar o pedido confirmado e os vínculos de Assunto/Pedido do ciclo atual;
o backend continua decidindo elegibilidade sob lock.

## Leituras que alimentam as duas telas

Base: `/api/v1/orders/{orderId}/billing`.

| Leitura                            | Conteúdo e uso                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET` na base                      | Retorna `{billing}`: `enabled`, `managed`, `canManage`, `version`, `orderVersion`, `percent`, totais em centavos, `blockedReason`, `reviewRequired` e `charges`. A versão do plano nesta resposta chama-se `version`.                            |
| `GET /history?limit=20&cursor=...` | Totais atuais, `orderVersion`, `billingVersion`, `items` e `nextCursor`; limite 1–50. Cada evento tem `id`, `kind`, `chargeId`, `intentId`, `amountCents`, `status`, `occurredAt`. Não soma nem substitui o livro financeiro a partir da página. |
| `GET /send-intents/{intentId}`     | Estado atual, `version`, `action`, `chargeId`, `conversationId`, `amountCents`, `blockedReason`, `messageId` e `commandId`. Não contém URL nem corpo da mensagem.                                                                                |

Cada item de `charges` contém `id`, `kind`, `amountCents`, `status`,
`checkoutUrl`, `receiptUrl`, `method`, `installments`, `createdAt`, `validUntil`,
`paidAt`, `refundedAmountCents`, `refundableAmountCents` e `transactionNsu`.
Links e referência privada podem ser nulos: não assumir sua presença nem
ampliar acesso no frontend. `canManage` controla a projeção privada no servidor.
Conferir sempre o [OpenAPI financeiro](order-billing.v1.json) e o
[contrato de intenções](order-billing-chat.md).

As duas telas consultam os mesmos recursos; após comando ou invalidação da
Inbox, atualizar intenção, resumo e histórico pertinentes. A stream existente
não carrega valor, URL ou mensagem financeira: recarregar a projeção autorizada.
Cancelar leituras ao trocar pedido/conversa e ignorar respostas de alvos antigos.
Preservar o rascunho já existente na Inbox ao ir ao Pedido e voltar.

O histórico é decrescente por data e ID; cursor é opaco e vinculado ao pedido.
Deduplicar páginas por `id` e recarregar o início quando houver mudança, pois
a paginação não promete um snapshot congelado. Eventos de intenção, inclusive
`correction`, representam transições de envio; não interpretá-los como vários
recebimentos. Não criar evento de pagamento por sucesso no POST.

## Revisão e envio humano

Antes de confirmar, mostrar pedido, conversa/destino autorizados, valor da
cobrança, recebido, saldo após o pagamento e cobrança vigente. Pix, cartão e
parcelamento são escolhas do comprador no checkout; o CRM não oferece QR Pix
nem promete uma modalidade exclusiva. O texto final é composto pelo backend.

`POST /send-intents` exige campos comuns `action`, `conversationId`,
`expectedVersion` do pedido, `expectedBillingVersion` do plano e
`expectedConversationVersion`. Enviar versões da leitura revisada; plano ausente
usa zero. Autor, telefone, destino externo e texto livre não pertencem ao corpo.

| Ação            | Campos específicos                                                                   | Condição para oferecer                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue`         | `percent` inteiro 1–100                                                              | Sinal ou integral do acordo válido, sem pagamento prévio ou cobrança ativa. 0% usa `POST /plan` e não gera cobrança ou intenção.              |
| `send_existing` | `chargeId`                                                                           | Mesma cobrança elegível, com link válido e aguardando pagamento. Não cria outro link.                                                         |
| `balance`       | Nenhum                                                                               | Recebimento parcial confirmado e nenhuma cobrança ativa; o servidor calcula o restante. Nunca enviar valor calculado no navegador.            |
| `correct`       | `chargeId`, `amountCents`, `confirmedAgreement:true`, `confirmedProviderReview:true` | Cobrança anterior vencida, encerrada sem pagamento após conferência; valor humano entre R$ 1 e saldo disponível, respeitando residual mínimo. |
| `retry`         | `intentId`, `expectedIntentVersion`                                                  | Falha comprovadamente anterior ao efeito, após nova revisão humana; mesmo link válido, novo comando.                                          |

Sessão humana, origem, CSRF e `Idempotency-Key` são obrigatórios nas mutações.
Criar uma chave por intenção confirmada e conservá-la com o mesmo corpo para
recuperar uma resposta perdida. Não gerar outra chave automaticamente por
timeout. Não reutilizar chave com corpo diferente. O backend revalida ACL,
versões e condições; controles visuais não substituem essa verificação.
Responsável autorizado e Admin podem gerir; leitura não concede gestão,
e outro vendedor, Financeiro, agente ou usuário desativado não herdam envio.

## Estados financeiros e de mensagem

| Fonte/estado                               | Exibição e recuperação                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intenção `waiting_link`                    | Gerando link; 202 ainda não significa enviado.                                                                                                                                                    |
| Intenção `queued`                          | Mensagem persistida na fila; preservar rascunho livre.                                                                                                                                            |
| Intenção `sending`                         | Envio reservado; aguardar retorno, sem reenvio.                                                                                                                                                   |
| Intenção `sent` / `delivered`              | Enviado / entregue somente pelo transporte; não afirmar pagamento.                                                                                                                                |
| Intenção `failed`                          | Mostrar falha; só oferecer `retry` após prova anterior ao envio e revisão, nunca apenas pelo nome do estado.                                                                                      |
| Intenção `unknown`                         | Resultado a conferir; bloquear reenvio e nova emissão cegos.                                                                                                                                      |
| Intenção `blocked`                         | Mostrar motivo (`OWNER_CHANGED`, `ACTOR_DISABLED`, `CONVERSATION_CLOSED`, `AGREEMENT_CHANGED`, `CHARGE_EXPIRED`, `PAYMENT_CONFIRMED`, `INBOUND_CHANGED` ou `SENDING_DISABLED`) e atualizar dados. |
| Cobrança `queued` / `creating` / `waiting` | Emissão pendente / em criação / aguardando pagamento. `unknown` financeiro também impede recriar link cegamente.                                                                                  |
| Cobrança `paid` / `review` / `closed`      | Recebimento verificado / precisa de conferência / encerrada localmente. Pagamento parcial mantém saldo; estado `closed` não prova cancelamento externo.                                           |

| Erro                                           | Tratamento da interface                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 / 422                                      | Manter revisão e explicar campo/valor inválido; não coercer tipos.                                                                                    |
| 401 / 403                                      | Aplicar recuperação de sessão ou acesso existente; impedir nova confirmação sem permissão válida.                                                     |
| 404                                            | Descartar alvo inelegível após atualizar o contexto; não procurar destinatário por dados pessoais.                                                    |
| 409 de versão/acordo/ativo                     | Recarregar pedido, conversa, resumo e histórico; exigir nova revisão. Não repetir o comando com versões substituídas silenciosamente.                 |
| 409 `BILLING_RETRY_UNSAFE` / resultado incerto | Exigir conferência; não criar outro link ou tentar envio automaticamente.                                                                             |
| 503 / falha de rede / resposta perdida         | Não afirmar ausência de efeito. Consultar intenção conhecida ou recuperar o mesmo POST com a mesma chave e corpo; respeitar flags e estado retornado. |
| 429                                            | Informar limite e aguardar nova tentativa; evitar loop agressivo de consulta.                                                                         |

Não alterar status comercial, `paid_on` ou check do Financeiro a partir do
estado de envio. O servidor aplica pagamentos e quitação pelo livro financeiro.
Ao desativar emissão/envio, conservar leitura e callbacks conforme flags do
[runbook](../runbooks/order-billing.md); a UI não habilita flags.

## Correção, links anteriores e limites da projeção atual

Correção não cancela o link na InfinitePay. Antes de `correct`, a cobrança
anterior precisa cumprir a regra de vencimento e ser encerrada pelo comando
existente `POST /reconcile`, decisão `close_unpaid`, com conferência explícita.
Essa operação exige `expectedVersion`, `expectedBillingVersion`, `decision` e
`confirmedProviderReview`, além da chave de idempotência e sessão. Depois dela,
reler versões e revisar o novo valor antes de submeter a correção.
Callback tardio da anterior continua sendo processado e pode exigir revisão;
não apagar cobrança, URL ou recebimento para ocultar esse risco.

Intenção e eventos do histórico podem devolver `supersedesChargeId` e
`retryOfIntentId`, campos opcionais nullable derivados dos vínculos persistidos.
Usar `supersedesChargeId` para identificar a cobrança anterior na lista obtida
de `GET /billing`; usar `retryOfIntentId` para relacionar tentativas. Os eventos
de intenção conservam os vínculos em todas as transições. Cobrança, recebimento
e devolução devolvem null nesses campos. A origem pode ser exibida após reload
sem depender do estado local do diálogo. Em respostas anteriores sem os campos,
conservar a lista/histórico e não deduzir a associação por posição ou valor.

O estado `failed` também não expõe um boolean de elegibilidade para retry.
Não presumir que toda falha ocorreu antes do envio: falha de entrega com ID
externo não libera outra tentativa. A futura UI deve definir uma projeção
compatível para essa capacidade, ou apresentar conferência seguida de comando
explicitamente sujeito à validação do backend, sem prometer que será aceito.

Também não existe endpoint de artefato/comprovante fictício na API real.
`receiptUrl`, método, parcelas e NSU são projetados por cobrança e podem faltar;
o histórico não fornece uma listagem completa de detalhes de cada pagamento.
Não transportar a API fictícia do protótipo para produção nem inventar recibos.

## Gate para a futura implementação

- Comandos e ACL: responsável, Admin, outro vendedor, Financeiro, conta
  desativada, pedido pendente/loja, conversa encerrada/transferida, vínculo
  ausente e vários pedidos elegíveis. Não inferir destino.
- Fluxo integrado no ambiente de desenvolvimento: sinal, saldo e integral,
  link existente, correção após vencimento/conferência, antigo link visível,
  callback tardio, quitação e bloqueio após pagamento.
- Falhas: POST com resposta perdida, callback duplicado, mudança de valor ou
  proprietário antes do link/reserva, pagamento antes do envio, falha segura,
  resultado incerto, desligamento de flags e retomada sem efeito duplicado.
- Leitura: ambas as telas e duas abas refletem os mesmos totais, paginação sem
  duplicidade, recarga preserva registros e não cria nova intenção; não somar
  saldo a partir da página nem exibir dados de pedido anteriormente aberto.
- UI após redesign: teclado, Escape, foco inicial/retorno, anúncios de estado,
  toque, 320/390 px, claro/escuro, axe e rascunho preservado. Reutilizar o
  componente aprovado, com loading/erro/vazio/permissão e confirmação explícita.

Esse gate depende da implementação real. Os testes do protótipo não concluem
o frontend nem COB-OPS-01 e não substituem homologação autorizada do provedor.
