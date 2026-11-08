# Intenções de envio de cobrança, contrato v1

COB-CHAT-B01 / BAPI-01–10, [RFC 047](../rfc/047-enviar-cobranca-pela-conversa.md),
[ADR 066](../adr/066-intencoes-de-cobranca-e-envio-transacional.md),
[OpenAPI](order-billing-chat.v1.json). Backend autorizado em 06/11/2026.
Frontend adiado para o redesign. O contrato independe de tela e compositor.

## Disponibilidade desta entrega

B01 implementa a fronteira HTTP injetável. B02 acrescenta serviço PostgreSQL
injetável e migração expand 0063, com intenção, reserva financeira, histórico
e auditoria transacionais. Ainda não há registro em `server.js` ou envio de mensagem.
`registerOrderBillingChatRoutes` exige injeção explícita e escrita habilitada
explicitamente; o default é escrita desligada. Não habilitar em produção com
um serviço simulado. B03/B04 compõem a Inbox e integram runtime/recuperação.
Os testes HTTP com serviço sintético não comprovam transações. As provas de
B02 usam PostgreSQL local dedicado. Callback, reserva final de transporte e
ativação de BAPI-07/09/10 continuam pendentes.

Em B02, `send_existing` e `retry` também ficam em `waiting_link`: a URL pode
estar salva, mas a composição da mensagem ainda não existe. `queued` somente
será usado em B03 após persistir mensagem/outbox da Inbox. A outbox financeira
é criada junto à nova cobrança; não é criada outra para link existente ou
retry. Não conectar o serviço ao runtime/worker antes das guardas de B03/B04.

As cinco ações do serviço exigem `ORDER_BILLING_ENABLED=true` e
`ORDER_BILLING_CHAT_SEND_ENABLED=true` explicitamente; testes injetam esses
valores somente no processo sintético. A leitura também é mantida com
`ORDER_BILLING_RECEIVE_ENABLED=true`. Nenhuma configuração remota é alterada.

## Operações

Base `/api/v1/orders/{orderId}/billing`:

| Método e caminho                   | Resultado                                                       |
| ---------------------------------- | --------------------------------------------------------------- |
| POST `/send-intents`               | 202 com intenção durável, nunca confirmação de envio/pagamento. |
| GET `/send-intents/{intentId}`     | 200 com projeção atual da intenção vinculada a esse pedido.     |
| GET `/history?limit=20&cursor=...` | 200 com totais atuais e página de eventos; limite 1–50.         |

Mutações exigem sessão humana, origem/CSRF válidos e `Idempotency-Key` de
1–255 caracteres ASCII visíveis sem espaços. Requisições Basic são recusadas,
inclusive quando coexistem com cookie. Autor e destino externo nunca vêm do
corpo. Acesso usa `billing.manage` ou `billing.read`; o serviço revalida
capacidade ativa e propriedade viva sob lock. Leitura não concede emissão.

Todos os comandos exigem `action`, `conversationId`, `expectedVersion`
(pedido), `expectedBillingVersion` e `expectedConversationVersion`. Versões
são inteiros seguros positivos, exceto plano ausente que usa versão zero.
Todos os campos da variante são obrigatórios; campos extras, coerção de
strings numéricas, destinos arbitrários e texto livre são recusados com 400.

| action          | Campos específicos                                                                   | Semântica transacional exigida                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue`         | `percent` inteiro 1–100                                                              | Emitir sinal ou integral do acordo autorizado e persistir intenção. 0% configura sem entrada pela rota `/plan` existente; não cria intenção de envio.                                                                                                    |
| `send_existing` | `chargeId`                                                                           | Vincular à mesma cobrança válida, conhecida e aguardando pagamento; nunca recriar link.                                                                                                                                                                  |
| `balance`       | Nenhum                                                                               | Calcular no servidor total menos recebimentos aplicados válidos; não aceitar valor do navegador. Exigir recebimento parcial prévio e ausência de outra cobrança ativa.                                                                                   |
| `correct`       | `chargeId`, `amountCents`, `confirmedAgreement:true`, `confirmedProviderReview:true` | Cobrança anterior encerrada sem pagamento pelo comando de conciliação existente, prazo vencido e conferência explícita. Nova cobrança pelo valor humano entre R$ 1 e saldo atual; novo vínculo ao acordo de cobrança, preservando valor total comercial. |
| `retry`         | `intentId`, `expectedIntentVersion`                                                  | Nova tentativa humana apenas após falha comprovadamente anterior ao envio. Usar mesmo link ainda válido, novo comando, sem reutilizar reserva consumida.                                                                                                 |

Exemplo para cobrar saldo:

```json
{
  "action": "balance",
  "conversationId": "conversation-example",
  "expectedVersion": 2,
  "expectedBillingVersion": 1,
  "expectedConversationVersion": 3
}
```

## Respostas e estados

Intenção contém `id`, `version`, `action`, `chargeId`, `conversationId`,
`amountCents`, `state`, `blockedReason`, `messageId` e `commandId`.
IDs de mensagem/comando são nulos antes de serem reservados. Valor e IDs
financeiros da intenção não mudam para reinterpretar uma cobrança já emitida.
Replay do POST retorna a mesma identidade e o mesmo resultado persistido;
GET fornece o estado atual. Replay revalida ACL, mas não exige que versões
antigas coincidam com o estado já avançado pela própria execução. Mesma chave
com payload/ator divergente conflita. Idempotência não dispensa unicidade
transacional de emissão e de tentativa, inclusive sob chaves diferentes.

| state          | Significado                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| `waiting_link` | Intenção e cobrança reservadas duravelmente; aguardam URL.                  |
| `queued`       | URL preservada, mensagem e outbox persistidos na mesma transação.           |
| `sending`      | Reserva única de transporte consumida.                                      |
| `sent`         | Transporte confirmou envio. Não afirma entrega.                             |
| `delivered`    | Recibo real confirmou entrega. Não afirma pagamento.                        |
| `failed`       | Falha conhecida de transporte/entrega; retry exige prova anterior ao envio. |
| `unknown`      | Efeito incerto. Nenhum retry ou novo link automático.                       |
| `blocked`      | Contexto deixou de autorizar envio; motivo mínimo explícito.                |

Motivos de bloqueio: `OWNER_CHANGED`, `ACTOR_DISABLED`, `CONVERSATION_CLOSED`,
`AGREEMENT_CHANGED`, `CHARGE_EXPIRED`, `PAYMENT_CONFIRMED`, `INBOUND_CHANGED`,
`SENDING_DISABLED`. Pagamento pode bloquear uma mensagem ainda não reservada;
nunca regredir uma mensagem já enviada ou apagar um recebimento.

Histórico contém `orderId`, `orderVersion`, `billingVersion`, totais em
centavos, `items` e `nextCursor`. Eventos possuem `id`, `kind`
(`charge`, `receipt`, `intent`, `correction`, `refund`), `chargeId`, `intentId`
opcional nulo, `amountCents`, `status`, `occurredAt` UTC ISO 8601. Ordenação
decrescente por data e ID, cursor opaco vinculado ao pedido e à posição.
Paginação não promete snapshot congelado; itens podem mudar de estado entre
leituras. Não reconstruir saldo somando os valores da página: os totais
representam o livro financeiro atual sob leitura consistente.

O cursor de B02 é autenticado por HMAC com a chave de envelope existente,
vinculado ao pedido, e preserva microssegundos da posição no PostgreSQL.
Não contém telefone, URL privada ou payload financeiro. O serviço exige
responsável atual do pedido e do destino, ou capacidade administrativa real.
Pedido manual ou de outro ciclo exige Assunto ligado explicitamente ao pedido;
contato deve coincidir ou ter correlação verificada ativa. Nomes/telefones não
participam da descoberta do destino. Replay revalida também esse vínculo.

As novas projeções nunca devolvem telefone, URL privada, corpo da mensagem,
payload/credenciais de provedor ou envelopes. Consulta privada dos links
continua na rota de cobranças vigente com suas permissões próprias. Todas as
respostas e erros usam `private, no-store`, `Vary: Cookie, Origin` e
`Referrer-Policy: no-referrer`. Erros são `application/problem+json`, sem
detalhes internos. O corpo aceita até 8 KiB e cada rota limita 60 req/min.

## Falhas e invariantes

| HTTP / código                                              | Quando                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 400 `INVALID_REQUEST`                                      | Formato/campos/identificador inválidos.                                                  |
| 401 `INVALID_SESSION`                                      | Sessão ausente/inválida conforme autorizador vigente.                                    |
| 403 `FORBIDDEN` / `CSRF_INVALID`                           | Sem capacidade/propriedade/origem/CSRF; Basic não autorizado.                            |
| 404 `ORDER_NOT_FOUND` / `BILLING_NOT_FOUND`                | Alvo não pertence ao pedido ou não existe, após autorização.                             |
| 409 `VERSION_CONFLICT`                                     | Estado observado mudou antes de nova intenção.                                           |
| 409 `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_CONFLICT`      | Mesma chave com outra intenção.                                                          |
| 409 `ORDER_NOT_CONFIRMED` / `BILLING_ACTIVE_CHARGE`        | Pedido inelegível ou cobrança anterior ativa.                                            |
| 409 `BILLING_LINK_STILL_VALID` / `BILLING_REVIEW_REQUIRED` | Correção sem vencimento/conferência ou recebimento que exige revisão.                    |
| 409 `BILLING_ALREADY_PAID` / `BILLING_PAYMENT_MISMATCH`    | Saldo quitado ou recebimento incompatível.                                               |
| 409 `BILLING_RETRY_UNSAFE` / `BILLING_TARGET_CONFLICT`     | Tentativa incerta/consumida ou conversa/Assunto/Pedido sem vínculo explícito.            |
| 422 `BILLING_INVALID_AMOUNT`                               | Valor menor que R$ 1, acima do saldo ou parte residual inválida sob o acordo.            |
| 413 / 415 / 429                                            | Corpo excessivo, tipo não suportado, limite excedido.                                    |
| 503 `BILLING_DISABLED` / `SERVICE_UNAVAILABLE`             | Emissão desligada ou dependência indisponível; não tratar como falha anterior ao efeito. |

Correção não cancela link na InfinitePay nem altera cobrança/recebimento
originais. A verificação não é provada pelos booleans do cliente: prazo,
estado e saldo são conferidos novamente sob lock. Callback tardio fica em
revisão; não cria saldo negativo nem quitação duplicada. Sinal confirmado
mantém saldo e somente cobertura integral preenche a quitação, sem novos
status comerciais ou atalho pelas APIs legadas de datas.

Callback `created` financeiro permanece no contrato existente. Salva
a URL e enfileira a mensagem ou persiste bloqueio na mesma transação.
Bloqueio de negócio não provoca perda da URL. Falha técnica causa rollback e
reentrega do mesmo callback. Reserva final revalida ator, responsável/ciclo,
epoch/revisão, acordo, saldo e validade; não atribui conversa ao autor nem
simula função Vendedor. Mensagem nova não nasce do callback sem intenção humana.

`ORDER_BILLING_CHAT_SEND_ENABLED` separa novas intenções/reservas
do recebimento e da leitura, na API e no worker. Default false. Desligamento preserva callbacks,
livro financeiro e reconciliação dos links existentes. Integração com canais
e pagamentos reais exige homologação independente; esta API não a realiza.

## Reserva e transporte

A mensagem humana usa o pedido, a natureza da cobrança, o valor e a URL
validada; corpo e comando ficam cifrados com as chaves existentes. Composição
atualiza a atividade da conversa e publica `conversation.message_queued` com
identificadores somente. Não muda responsável, epoch ou revisão inbound.
Repetir callback confirma a mesma mensagem/comando. A migração expand 0064
sincroniza estados de transporte e histórico sem declarar pagamento.

O workflow humano recebe `billing_send:true` apenas nesses comandos. Depois
da reserva única `message.send.requested`, consulta
`GET /api/v1/integrations/n8n/commands/:commandId/preflight` imediatamente
antes do HTTP externo. Usa Basic técnico e headers de workflow/versão/execução
da reserva; capacidade existente `integration.n8n.command.media.read`.
Somente `{valid:true}` libera envio; erro, timeout ou qualquer outra resposta
interrompem o fluxo. Consulta não cria outra reserva. O endpoint de mídia
mantém seu contrato e continua recusando comandos de texto.

Pagamento enquanto a intenção aguarda link/fila bloqueia a mensagem. Uma
reserva em andamento continua sujeita ao preflight; depois dele, alterações
concorrentes não provam cancelamento do HTTP externo. O resultado real ou
incerto continua reconciliável. Confirmação tardia autenticada não regride
entrega já conhecida. Falha de entrega com ID externo não autoriza retry.
Somente falha comprovada antes do efeito permite nova intenção humana, novo
comando e a mesma cobrança/link ainda válidos; nunca retry automático.
