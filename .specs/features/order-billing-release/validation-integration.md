# Validação independente da integração de cobranças

Data: 2026-11-09. Verificador independente: billing_release_verifier (autor ≠ verificador).
Fonte congelada: `16b01ad38bbe63ef2c4005a6c11bed3dcc032865`.
Diff: `0ed44bd3..16b01ad38bbe63ef2c4005a6c11bed3dcc032865`;
ponte anterior: `codex/billing-before-production-rebase-20261109`.

**Veredito T1 / integração: PASS.** BREL-01 e a parte local de BREL-04
foram verificados. Este documento não aprova a release inteira, o deploy,
credenciais, flags remotas nem homologação financeira. T2–T4 permanecem
fora desta verificação. Nenhuma chamada de produção, checkout, pagamento ou
mensagem real foi executada pelo verificador.

## Critérios e resultados observáveis

| Critério                                 | Resultado esperado e evidência independente                                                                                                                                                                                                                                                                                                                                                                                                                                             | Resultado                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| BREL-01: migrations publicadas           | Comparação binária dos 70 SQL existentes em `0ed44bd3` com os arquivos atuais: todos idênticos; `var/billing-verifier-audit.log`. O upgrade compara também version/name/phase/checksum com o histórico pré-billing em `test/order-billing-upgrade-postgres-live.test.js:87` (`deepEqual(rows, history)`).                                                                                                                                                                               | PASS                            |
| BREL-01: novas versões livres            | `test/order-billing-upgrade-postgres-live.test.js:86`: `deepEqual(upgraded.applied, ['0073', '0074', '0075'])`; segunda migração aplica `[]` em `test/order-billing-upgrade-postgres-live.test.js:153`.                                                                                                                                                                                                                                                                                 | PASS                            |
| BREL-01: jobs Olist preservados          | Upgrade insere `olist.export` e `olist.reconcile` antes de migrar; `test/order-billing-upgrade-postgres-live.test.js:96` compara IDs, tipos, destino, fila e política completos após upgrade. `modules/database/migrations/0075_billing_external_receipts_and_checks.expand.sql:102` compõe as expressões instaladas de constraints, sem substituir os contratos Olist.                                                                                                                 | PASS                            |
| BREL-01: novo target financeiro restrito | `test/order-billing-upgrade-postgres-live.test.js:125` aceita payment-check válido; `:135`, `:145` e `:149` exigem SQLSTATE23514 para target Olist no check, fila errada e reconcile em billing.                                                                                                                                                                                                                                                                                        | PASS                            |
| BREL-01: admissão após cancelamento      | `test/order-billing-completion-postgres-live.test.js:169` exige `ORDER_CANCELLED` para novo intent; `:180`, `:183`, `:190` cobrem recibo externo, estorno e consulta; `:201` compara pedido inteiro inalterado; `:206` em diante exige zero intents/reversals/checks e preservação do recibo anterior. Guarda em `apps/api/src/order-billing-chat-runtime.js:381` antecede conflito de versão.                                                                                          | PASS                            |
| BREL-01: checkout ainda não reservado    | `test/order-billing-send-postgres-live.test.js:267` exige `allowed=false`; `:278` exige intent blocked/AGREEMENT_CHANGED, sem mensagem e sem execution_id.                                                                                                                                                                                                                                                                                                                              | PASS                            |
| BREL-01: cancelamento após reserva       | Controle positivo de preflight precede cancelamento; `test/order-billing-send-postgres-live.test.js:300` exige `valid=false`, blocked/AGREEMENT_CHANGED, mensagem sem ID externo e pedido inteiro preservado. Guarda em `modules/n8n-integration/src/billing-send-guard.js:178`.                                                                                                                                                                                                        | PASS                            |
| BREL-01: callback financeiro tardio      | `test/order-billing-send-postgres-live.test.js:328` exige reviewRequired=true; `:329` compara pedido imutável; `:341` exige application_valid=false e applied_amount_cents=0; `:343` exige intent bloqueado e mensagem failed. `apps/api/src/order-billing-runtime.js:1149` evita refresh do pedido cancelado e `:1150` conserva paymentRecorded. O teste master `test/cancelled-orders-billing-postgres-live.test.js:285` verifica recibo preservado, replay e controle não cancelado. | PASS                            |
| BREL-01: UI cancelada conserva leitura   | `test/e2e/billing-chat-real.spec.js:943` usa canManage=true com pedido cancelado; `:978` exige aviso; `:981`–`:1000` exige emissão, recebimento, consulta e estorno desabilitados; `:1002` conserva link histórico; `:1019` conserva nota; `:1042` conserva comprovante; `:1062` exige zero writes. Fluxos Chat e Pedido verificados.                                                                                                                                                   | PASS                            |
| BREL-01: trava Olist não é cancelamento  | `test/e2e/billing-chat-real.spec.js:1065` exige recebimento externo operável em pedido olistLocked. `apps/edge-web/src/components/order/OrderBillingWorkspace.vue:86` deriva cancelamento de cancelledAt/ORDER_CANCELLED; `:91` separa mutabilidade de leitura privada (`:100`).                                                                                                                                                                                                        | PASS                            |
| BREL-01: retirada do Financeiro          | `test/e2e/olist-phase2.spec.js:255`, `:281`, `:305`: Financeiro sem Olist vai a Conta, habilitado vai a Olist, admin em /financeiro vai ao Dashboard; sem link/página retirada nem request finance disparado. Router atual idêntico à master; dados/API/permissões continuam exercitados pelos testes de autorização em `test/identity-finance-access.test.js:25`.                                                                                                                      | PASS                            |
| BREL-04 local: default fechado           | `test/order-billing-chat-wiring.test.js:101` testa flags ausente/vazia/false: POST503 BILLING_DISABLED, zero chamadas ao port; GET200 privado sem cache. `:142` rejeita valores malformados; `:154` recusa send habilitado sem financeiro. `:414` exige flag vazia no exemplo; `:426` impede true no inventário. Não confundir com inspeção dos processos remotos.                                                                                                                      | PASS local                      |
| BREL-04: limites desta execução          | Banco sintético dedicado em15445, E2E interceptando HTTP local em4177; nenhum ambiente DEV existente ou serviço remoto foi usado. Flags remotas e nós n8n inativos são responsabilidade das provas T3/T4.                                                                                                                                                                                                                                                                               | Preservado; remoto não avaliado |

## Gates executados pelo verificador

Node fixado24.20.0. PostgreSQL17 em container exclusivo
`crm-billing-release-verifier-db`, banco `crm_silmer_test`, porta15445.
Todos os cenários financeiros usaram fixtures sintéticas.

| Gate independente                                                                                                                            | Resultado                   | Log local                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------- |
| PG billing clássico/chat/send/completion/upgrade + canceled-orders-billing + cancellation + Olist guards, `node --test --test-concurrency=1` | 99 aprovados;0falhas;0skips | `var/billing-verifier-pg.log`         |
| Domínio billing, chat HTTP/wiring, completion HTTP, payment-check worker, preflight HTTP, integration worker, workflow                       | 51 aprovados;0falhas;0skips | `var/billing-verifier-unit.log`       |
| Billing HTTP (inclui409 ORDER_CANCELLED) + autorização Financeiro                                                                            | 11 aprovados;0falhas;0skips | `var/billing-verifier-contract.log`   |
| Playwright `billing-chat-real.spec.js`, build próprio                                                                                        | 17 aprovados;0falhas;0skips | `var/billing-verifier-ui.log`         |
| Playwright `olist-phase2.spec.js --grep=FINQ-20`, build próprio                                                                              | 3 aprovados;0falhas;0skips  | `var/billing-verifier-finance-ui.log` |
| Auditoria binária das migrations e ausência de teste deletado contra master                                                                  | PASS,70/70 idênticas        | `var/billing-verifier-audit.log`      |
| `git diff --check 0ed44bd3 HEAD`                                                                                                             | exit0                       | execução independente                 |

Nota de execução: a primeira tentativa PG usou banco com sufixo `_verifier`,
rejeitado pelos guards de nome de quatro suites legadas. O banco correto foi
criado no mesmo container novo e o gate completo foi repetido sem skips.
Essa tentativa não foi contada como evidência de aprovação.

Gate completo de integração do autor inspecionado: `var/billing-release-validate.exit`
contém0; `var/billing-release-validate.log:4896` reporta2470 testes,
2418 aprovados,52 skips condicionais e0falhas; formato, typecheck, lint,
boundaries, tokens e build completos. `var/billing-release-migration-audit.log`
registra64/64 PG e `var/billing-release-ui-e2e.log` registra o gate afetado do
autor. Esses números não são apresentados como nova execução independente.
CI exige completion e upgrade em `.github/workflows/ci.yml:152`.

## Sensor de discriminação

Cinco mutações comportamentais em cópia isolada do HEAD obtida com git archive,
com node_modules por junction. Nenhuma fonte ou teste real foi mutado. Os testes
foram executados contra a cópia; cada arquivo foi restaurado na cópia entre
casos. Não houve git stash. Logs: `var/billing-verifier-sensor-*.log`;
resultados: `var/billing-verifier-sensor-results.json`.

| Mutação                                       | Fronteira                                                                              | Discriminação observada                                                                    | Resultado |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------- |
| Remover guarda de admissão cancelada          | `apps/api/src/order-billing-chat-runtime.js:381`                                       | Completion `:169` recebe BILLING_ACTIVE_CHARGE em vez de ORDER_CANCELLED; assertion falha. | Morta     |
| Remover canceled_at do preflight              | `modules/n8n-integration/src/billing-send-guard.js:178`                                | Send `:300` recebe valid=true em vez de false após cancelamento.                           | Morta     |
| Trocar OR por AND na composição de tipos      | `modules/database/migrations/0075_billing_external_receipts_and_checks.expand.sql:113` | Upgrade falha23514 ao tentar manter jobs Olist pré-existentes.                             | Morta     |
| Omitir exigência queue=billing do novo target | `modules/database/migrations/0075_billing_external_receipts_and_checks.expand.sql:118` | Upgrade `:145` falha Missing expected rejection no check com fila Olist.                   | Morta     |
| Permitir mutable em pedido cancelado          | `apps/edge-web/src/components/order/OrderBillingWorkspace.vue:94`                      | E2E cancelado `:986` falha toBeDisabled: botão recebido enabled.                           | Morta     |

**Sensor:5/5 mortas,0sobreviventes.** Cada exit1 foi inspecionado para
confirmar falha esperada, sem falha de setup/import/browser. Scratch e arquivo
zip descartados; junction removida antes da exclusão recursiva. Container PG
exclusivo removido. Porcelain real antes e depois do sensor/cleanup: vazio.
Somente este relatório foi criado depois dessa conferência.

## Integridade e limites da conclusão

- Domínio comercial, money, size-pricing, size-pricing-composition,
  olist-exact-cent, billingSplit e configuration-catalog não diferem da master
  na auditoria `git diff --exit-code`. `modules/orders/src/domain/billing.js:20`
  conserva cálculo BigInt em centavos; `test/order-billing.test.js:9` testa
  0/X/100 e mínimos. A integração não substituiu o cálculo comercial por valor
  digitado ou arredondamento ERP.
- Não há deleção de testes no diff master→HEAD. A alteração de assertion de
  migração0063 para0073 na suite chat acompanha o novo índice, sem afrouxar
  o contrato. A retirada de finance-panel no diff da ponte antiga já pertence
  à master/ADR074; os três cenários FINQ-20 foram repetidos independentemente.
- Índices novos de decisões ADR076/077 e RFC060 estão livres na master e
  mantêm a decisão de intenção humana/recebimentos; não constituem nova
  autorização operacional. O contrato de não ativação segue RULES e BREL-04.
- Autorização, idempotência, audit rollback, concorrência, recibos tardios e
  cancelamento terminal foram exercitados nos99 testes PG. Links e recibos são
  sintéticos; nenhuma credencial de produção foi lida neste trabalho.
- Build/E2E emitiram aviso de tamanho do bundle já existente; sem erro de build.
  Isso não é bloqueador funcional desta integração.

Nenhum finding de implementação ou sobrevivente foi encontrado neste escopo;
nenhuma lição nova foi registrada. O fechamento determinístico geral
`validate_state.py order-billing-release` foi executado e retornou1 porque
`validation.md` da release completa ainda não existe. Isso é consistente com
T2–T4 pendentes: este relatório parcial não foi renomeado nem usado para
declarar a feature inteira concluída. A revisão libera T1 para o gate de PR;
checks remotos, backup/deploy/migrations remotas, flags e referências privadas
continuam exigindo suas evidências próprias.
