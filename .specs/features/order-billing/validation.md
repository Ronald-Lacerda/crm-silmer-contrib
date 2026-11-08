# Order billing — validação independente do backend B01–B04

**Result**: PASS — rodada 2, achado P2 encerrado com regressão e sensor.

Data: 2026-11-06. Verifier independente, não autor da implementação.
Diff examinado: `5dec408..c67d81a6` (T1 `bf502a4`, T2 `24a37e2`,
T3 `ce474343`, T4 `867e85e8`, T5 `c67d81a6`). Escopo: BAPI-01–10 / COB-CHAT-B01–B04.
Frontend, redesign e COB-OPS-01 não são aprovados por este relatório.

## Resultado por critério

As expectativas abaixo foram derivadas de `spec.md:58`–`spec.md:67` e
comparadas às expressões de asserção, não apenas aos nomes dos testes.

| Critério | Resultado esperado e evidência                                                                                                                                                                                                                                                                                                                                                                                                       | Parecer |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| BAPI-01  | Cinco ações retornam 202 e projeção exata de intenção, sem declarar envio/pagamento: `test/order-billing-chat-routes.test.js:132` (`response.statusCode === 202`) e `:133` (`deepEqual(response.json(), INTENT)`); schemas publicados iguais aos executáveis em `:478`–`:484`.                                                                                                                                                       | PASS    |
| BAPI-02  | Entrada inválida recusa 400/INVALID_REQUEST e não chama serviço: `test/order-billing-chat-routes.test.js:179`–`:195`; corpo malformado, grande e tipo inválido em `:447`–`:468`.                                                                                                                                                                                                                                                     | PASS    |
| BAPI-03  | Sessão/CSRF/origem, recusa Basic e chave obrigatória antes de submit: `test/order-billing-chat-routes.test.js:198`–`:225`; Financeiro 403 e identidade/capacidade administrativas preservadas em `:308`–`:325`. Revalidação de posse, usuário e privilégio: `test/order-billing-chat-postgres-live.test.js:268`, `:280`, `:291` (`rejects(... FORBIDDEN)`).                                                                          | PASS    |
| BAPI-04  | Escrita desligada retorna 503/BILLING_DISABLED, zero submit e leitura privada 200: `test/order-billing-chat-routes.test.js:237`–`:252`; default omitido em `:283`–`:284`; composição do servidor em `test/order-billing-chat-wiring.test.js:110`–`:125`.                                                                                                                                                                             | PASS    |
| BAPI-05  | Projeções sem campos privados, erro seguro e paginação limitada: `test/order-billing-chat-routes.test.js:345`–`:368`, `:409`, `:437`–`:443`; desempate de cursor sem repetição e vínculo ao pedido em `test/order-billing-chat-postgres-live.test.js:553`–`:589`.                                                                                                                                                                    | PASS    |
| BAPI-06  | Replay concorrente produz uma intenção/efeito/auditoria e payload divergente é recusado: `test/order-billing-chat-postgres-live.test.js:189`–`:210`; concorrência com chaves distintas em `:247`–`:249`; rollback audit/idempotência em `:323`–`:336`; ACL sob lock em `:260`–`:296`; trava comum com alteração comercial em `:881`–`:882`.                                                                                          | PASS    |
| BAPI-07  | Callback duplicado gera uma mensagem/comando cifrados: `test/order-billing-send-postgres-live.test.js:272`–`:327`. Mudança de dono preserva link e bloqueia em `:403`–`:421`; preflight recusa pagamento/dono/acordo/validade em `:449`–`:461`; pagamento depois de preflight preserva envio real em andamento em `:478`–`:484`. Fence do caso zero-intents em `:900`–`:942`. Invalidação privada única e rollback em `:507`–`:570`. | PASS    |
| BAPI-08  | Saldo calculado no servidor 84000, recebido 120000 e saldo zero na quitação: `test/order-billing-send-postgres-live.test.js:581`–`:592`; correção preserva cobrança anterior fechada/36000 e link cifrado em `test/order-billing-chat-postgres-live.test.js:420`–`:457`; pagamento tardio permanece registrado e exige revisão em `:843`–`:858`.                                                                                     | PASS    |
| BAPI-09  | Falha comprovada antes de envio autoriza um novo comando para a mesma cobrança: `test/order-billing-send-postgres-live.test.js:617`–`:645`; incerteza mantém unknown, sem failure_stage e rejeita retry em `:660`–`:669`.                                                                                                                                                                                                            | PASS    |
| BAPI-10  | Flag desligada impede intenção/reserva, conserva callback financeiro e leitura: `test/order-billing-send-postgres-live.test.js:687`–`:749`; transporte sent/delivered não regride em `:349`–`:380`; inventário sem flag true em `test/order-billing-chat-wiring.test.js:402`–`:406`.                                                                                                                                                 | PASS    |

## Achado da rodada 1 — resolvido na rodada 2

1. **P2 resolvido — publicar invalidação da Inbox ao bloquear uma mensagem já enfileirada.**
   `modules/n8n-integration/src/billing-send-guard.js:202`–`:230`
   muda a mensagem para failed e o comando para failed quando pagamento,
   mudança de contexto ou flag impede o envio. O caminho não publica
   `conversation.message_delivery_changed`, ao contrário de
   `modules/n8n-integration/src/postgres-command-store.js:349`–`:350`.
   O trigger em `modules/database/migrations/0064_billing_send_transport.expand.sql:27`
   registra estado/auditoria da intenção, mas também não publica invalidação
   da conversa. Assim o backend pode deixar a Inbox aberta exibindo queued
   até outra atualização/reabertura, apesar de a consulta já retornar failed.
   Refere-se à composição/recuperação integrada de T3/T4; não exige construir
   o frontend adiado. Corrigir no backend: emitir o evento mínimo seguro
   na mesma transação somente quando uma mensagem muda efetivamente;
   testar pagamento antes da reserva e bloqueio pelo worker, repetição,
   ausência de mensagem e rollback. Sem PII/URL no payload.

T5 (`c67d81a6`) atende essa correção em
`modules/n8n-integration/src/billing-send-guard.js:224`–`:249`: UPDATE com
RETURNING identifica mudança efetiva e evento determinístico da conversa é
publicado no mesmo client/transação, contendo somente conversationId.
`test/order-billing-send-postgres-live.test.js:507` verifica um evento,
`:508` verifica o payload exato e `:520`–`:527` impede duplicação.
Fault trigger em `:534`–`:537` impede commit do evento e asserções em
`:538`–`:554` comprovam rollback de intenção, mensagem e pagamento;
`:561`–`:570` comprovam recuperação via nova entrega do callback.
O bloqueio pelo worker desabilitado também emite um evento em `:698`–`:705`;
o caso bloqueado antes de criar mensagem não emite evento (`:423`–`:430`).
Não restam achados classificados nesta revisão.

## Gates e integridade

- Gate Full repetido pelo Verifier com Node 24.20.0/npm 11.19.0:
  `npm run validate`, exit 0; **1801 aprovados, 0 falhas, 17 skips**,
  incluindo format/typecheck/lint/fronteiras/inventários/build.
  Log: `var/verifier-billing-validate.log` (ignorado pelo Git).
- Os skips são gates condicionais de PostgreSQL/integrações locais sem
  TEST_DATABASE_URL no gate geral; não representam aprovação operacional.
  A suíte de transporte foi executada separadamente contra PostgreSQL17
  sintético dedicado: **13/13 na rodada 1 e 15/15 na rodada 2, zero skips**,
  baselines independentes do sensor.
- Depois do commit T5, gate Full repetido pelo autor com sucesso:
  **1801 aprovados, 0 falhas, 17 skips e build exit 0**;
  `var/billing-b04-invalidation-validate.log` foi inspecionado na rodada 2.
- Evidência complementar do autor, inspecionada mas não reexecutada nesta
  rodada: `var/billing-b03-postgres.log` e
  `var/billing-b03-transport-postgres.log`; não confundir esses logs com as
  execuções independentes acima. O autor documenta 86 cenários PG distintos.
- A superfície acrescenta quatro arquivos de testes e amplia regressões;
  não houve redução de testes observada no diff da fatia. Testes HTTP
  exercitam valores/status/ausência de efeitos; PG cobre persistência real,
  concorrência, locks, rollback e cifra. Nenhum teste foi removido/relaxado
  durante esta verificação.
- T1–T5 estão marcadas Complete; o achado P2 está encerrado.
  Não houve alteração de ambiente de produção, workflow remoto,
  habilitação de flag, cobrança real ou envio real.

## Sensor de discriminação — profundidade financeira ampliada

Arquivos copiados para `var/verifier-billing-sensor/`, com runtime/contrato
isolados e os imports da suíte PG apontando explicitamente para a cópia.
Todas as demais dependências apontaram ao código real, somente leitura.
Mesmo banco PostgreSQL sintético dedicado, execuções serializadas.

| Mutante | Origem                                                  | Falha comportamental observada                                                                                                    | Resultado                  |
| ------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| M1      | `apps/api/src/order-billing-chat-runtime.js:94`         | Ignorar reason de compose faz callback com dono alterado ficar queued em vez de blocked.                                          | KILLED, 12 passam/1 falha  |
| M2      | `apps/api/src/order-billing-chat-runtime.js:88`         | Remover guarda waiting_link tenta inserir novamente a mesma mensagem no callback duplicado e viola PK.                            | KILLED, 12 passam/1 falha  |
| M3      | `apps/api/src/order-billing-chat-runtime.js:441`        | Inverter condição de failed recusa retry comprovadamente seguro com BILLING_RETRY_UNSAFE.                                         | KILLED, 12 passam/1 falha  |
| M4      | `apps/api/src/order-billing-chat-runtime.js:519`        | Subtrair R$1 do saldo produz 83900 em vez dos 84000 devidos.                                                                      | KILLED, 12 passam/1 falha  |
| M5      | `apps/api/src/order-billing-chat-runtime.js:666`        | Incluir sending no bloqueio por pagamento muda envio em andamento para blocked em vez de conservar sending e aceitar callback.    | KILLED, 12 passam/1 falha  |
| M6      | `modules/n8n-integration/src/billing-send-guard.js:234` | Omitir publicação da invalidação faz contagem retornar zero e deixa callback confirmar sem sofrer a falha injetada na publicação. | KILLED, 13 passam/2 falhas |

**Sensor: 6 injetados, 6 mortos, 0 sobreviventes.** M1–M5 na rodada 1;
M6 na rodada 2, com guard e runtime copiados e import da guarda redirecionado
explicitamente para a cópia. Não houve falha de import
ou descoberta usada como prova. Logs individuais em
`var/verifier-sensor-*.log`, resumo em `var/verifier-sensor-results.json`.
Scratch descartado; `git status --porcelain` vazio antes e depois do sensor,
antes da escrita deste relatório. Sem stash nem mutação na árvore real.
Na rodada 2, o baseline porcelain continha somente este relatório e os dois
artefatos de lições; a comparação programática antes/depois foi idêntica
(`var/verifier-sse-porcelain-before.txt` e `var/verifier-sse-porcelain-after.txt`).
Scratch da rodada 2 removido; resumo em `var/verifier-sensor-sse-results.json`.
Banco dedicado liberado ao orquestrador depois da última execução de cada rodada.

## Limites e fechamento

Backend financeiro/transporte mantém URL cifrada, autoria humana, transação,
ACL, idempotência e separação entre recebimento e entrega conforme os testes
citados. Achado P2 corrigido e regressão discriminante aprovada; backend
B01–B04 validado, incluindo T5 de recuperação/invalidação. A lição L-008
permanece candidate, documentando a falha real encontrada na primeira rodada.
Frontend, homologação remota, aplicação de migrations e ativação real
continuam gates próprios, fora desta validação.
