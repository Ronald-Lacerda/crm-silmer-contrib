# Cobranças DEV — validação independente

**Result**: PASS — BDEV-01–07 e projeção BAPI-11 verificados nesta fatia local.

Data: 2026-11-08. Verifier independente, author != verifier.
Diff examinado: `5478bf22..270cfd7c`, incluindo T0 `3753e83f`, T1
`e083366c`, T6/API `e6fd494d`, T2 `0273e6bb` e T3 `270cfd7c`.
Nenhuma mudança de implementação ou teste foi feita pelo verificador.
Frontend/redesign, transporte humano, provedor e operação remota permanecem pendentes.

## Critérios e resultados esperados

| Critério   | Resultado definido na spec e evidência de valor/estado                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Resultado |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| BDEV-01    | Export padrão preservado: `test/billing-development-workflow.test.js:128` compara SHA256 `cbf8e5092e85bf741122ba67b613f685eeca1732f1fd2f28a481e38e6b75cce0`. Verificação independente importou em memória o gerador de `5478bf22` e comparou `JSON.stringify` byte a byte com HEAD, com igualdade. DEV inativo, grafo igual, IDs/paths distintos e credenciais próprias: `test/billing-development-workflow.test.js:145`, `:147`, `:150`, `:155`, `:157`, `:161`.                                                       | PASS      |
| BDEV-02    | Remoto, userinfo, expressão, host confuso e endpoint errado lançam erro: `test/billing-development-workflow.test.js:193`. Configuração adulterada falha antes de chamadas/ACK: `:223`–`:225`. A normalização financeira de produção é reutilizada, sem relaxar URLs de checkout/recibo (`ops/n8n/workflows/create-order-billing-workflow.mjs:123`).                                                                                                                                                                     | PASS      |
| BDEV-03    | Mesmo grafo e sequência reserve/links/created ou lookup/payment_check/payment: `test/billing-development-workflow.test.js:231`, `:259`. Payload financeiro tem preço, single_payment e webhook DEV em `:236`–`:238`. O ensaio independente importa/publica e executa esse export no n8n real via HTTP; `scripts/billing-development-smoke.mjs:267`–`:270` exige intenção waiting_link e mensagem persistida após worker.                                                                                                | PASS      |
| BDEV-04    | Rede Docker `--internal` própria (`scripts/billing-development-smoke.mjs:138`), PostgreSQL exclusivo e montagens isoladas; nenhuma porta publicada. HTTP ocorre por docker exec dentro da rede (`:508`). Cleanup remove containers e volumes (`:104`), confirma ausência (`:113`) e remove rede. Ensaio independente retornou `resourcesRemoved:true`; cancelamento SIGINT do autor também terminou com limpeza confirmada.                                                                                             | PASS      |
| BDEV-05    | Sinal: `scripts/billing-development-smoke.mjs:301`–`:305` exige 1 pagamento, recebido 3000, saldo 7000, paidOn null e Pix. Saldo: `:316`–`:325` exige 2 pagamentos, recebido 10000, saldo zero, 2 links, quitação presente, cartão e 3 parcelas. Parcelas permanecem atributo do recebimento; não há três cobranças comerciais.                                                                                                                                                                                         | PASS      |
| BDEV-06    | Replay criação: duplicate true e 1 link (`scripts/billing-development-smoke.mjs:291`–`:293`). Replay pagamento: 1 recebimento (`:298`–`:301`). Aviso desconhecido, não confirmado e 2999/3000 recusados sem crédito (`:334`–`:350`). Falha callback não recebe ACK de sucesso; reentrega registra exatamente 1 pagamento (`:354`–`:358`). Falha após efeito externo deixa unknown, nenhuma mensagem e exatamente 1 link novo; replay não recria (`:370`–`:379`).                                                        | PASS      |
| BDEV-07    | Comandos, isolamento e artefatos em `docs/runbooks/order-billing.md:75`–`:122`; distingue fixture/VM, motor n8n real, sessão sintética, composição da outbox, transporte humano e provedor. `docs/api/order-billing-frontend-integration.md:135`–`:153` explica vínculos, compatibilidade e limites da projeção. RFC047 mantém próximas entregas separadas, sem declarar prontidão operacional.                                                                                                                         | PASS      |
| BAPI-11/T6 | Correção retorna predecessor persistido, retry null e preserva relação após reload (`test/order-billing-chat-postgres-live.test.js:422`–`:430`); eventos também preservam relação (`:453`–`:462`). Retry retorna intenção anterior e predecessor null, inclusive reload/histórico (`:521`–`:537`). Serialização HTTP conserva ambos os campos e no-store (`test/order-billing-chat-routes.test.js:515`–`:517`). Campos opcionais preservam respostas legadas; comandos estritos e ACL continuam exercitados pela suíte. | PASS      |

## Gates e evidência reproduzida

- Node fixado 24.20.0; gate focal independente: `node --test test/billing-development-workflow.test.js test/billing-integration-workflow.test.js test/order-billing-chat-routes.test.js test/billing-development-smoke.test.js` — 30/30, zero falhas/skips. Antes desta fatia, os dois arquivos de regressão continham 20 testes; acréscimo de 10, sem remoção.
- PostgreSQL independente: `node --test test/order-billing-chat-postgres-live.test.js` — 16/16, zero skips, em container novo `crm-billing-verifier-79a6b162`, porta dinâmica apenas loopback, banco sintético dedicado. Container/volume removidos ao final. Nenhum banco existente foi resetado.
- Ensaio independente: `RUN_BILLING_LOCAL_SMOKE=yes node scripts/billing-development-smoke.mjs` — 9 cenários, exit 0. Evidência local `var/billing-development-GMhD2k/report.json`: verdict PASS, resourcesRemoved true. Logs do runner em `var/billing-verifier-independent-smoke.log`; nenhum container próprio permaneceu.
- Ensaio do autor também conferido: `var/billing-development-HlZNQJ/report.json`, 9 cenários PASS e resourcesRemoved true. Cancelamento: `var/billing-development-Nhhi3j/report.json`, erro esperado BILLING_DEVELOPMENT_INTERRUPTED e resourcesRemoved true.
- Gate integrado do root conferido em `var/billing-development-validate.log:3992`–`:3997` e `.exit`: npm run validate, exit 0, 2026 testes, 2002 aprovados, 24 condicionais, zero falhas; build concluído. O aviso existente de chunk maior que 500 kB não falha o build.
- Os 24 skips do gate geral são suítes live condicionais sem TEST_DATABASE_URL; não foram convertidos em aprovação de banco. As três suítes de cobrança foram executadas separadamente pelo root, 46/46; o verificador reproduziu os 16 testes da projeção alterada e o ensaio n8n/CRM/PostgreSQL sem skips.

### Skips condicionais do gate integrado

Todos abaixo requerem banco dedicado explícito; referências são linhas do log
`var/billing-development-validate.log`. Preservados sem alterar testes ou apontar
o gate geral para um banco existente.

| Suíte                         | Linha |
| ----------------------------- | ----- |
| INBOX-VEZ lembrete pessoal    | 702   |
| CHK snapshot concorrente      | 863   |
| MET métricas de conversa      | 895   |
| MET volume                    | 896   |
| ACT/PERF lembretes/atribuição | 897   |
| Financeiro                    | 1063  |
| OPS-ERR                       | 1086  |
| OPS-INBOX-ACK-04              | 1087  |
| OPS-INBOX-SEND-08 concluídos  | 1088  |
| OPS-INBOX-SEND-08 disposições | 1089  |
| OPSH-04 retenção              | 1093  |
| INBOX-VEZ abas                | 1182  |
| MET-06–08                     | 1288  |
| Leitura operacional           | 1962  |
| OPSH-01/03                    | 1991  |
| OA-T01                        | 2018  |
| Billing send persistence      | 2031  |
| Order billing PostgreSQL      | 2051  |
| Billing send transport        | 2057  |
| Coalescência de webhook       | 3022  |
| Shipping                      | 3168  |
| Store correction              | 3174  |
| Vendedor evolution            | 3781  |
| Work-management               | 3969  |

## Sensor de discriminação

Profundidade ampliada para integridade financeira: cinco mutações de comportamento,
uma por vez em cópias temporárias; nenhuma alteração da fonte real e nenhum stash.

| Mutação isolada                              | Local da falha inserida                                                                  | Asserção que a matou                                                                      | Resultado                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| Aceitar destino DEV sem validação            | `ops/n8n/workflows/create-order-billing-workflow.mjs:83`, retorno antecipado em localUrl | `test/billing-development-workflow.test.js:193`, throws obrigatório para destino inválido | KILLED, exit 1                       |
| Reutilizar credencial CRM de produção em DEV | `ops/n8n/workflows/create-order-billing-workflow.mjs:400`, sufixo DEV removido           | `test/billing-development-workflow.test.js:155`, nome deve terminar em DEV                | KILLED, exit 1                       |
| Aceitar transação forjada no simulador       | `scripts/billing-development-service.mjs:91`, condição da transaction_nsu removida       | `test/billing-development-smoke.test.js:48`, paid deve ser false                          | KILLED, exit 1                       |
| Descartar predecessor na serialização HTTP   | `apps/api/src/order-billing-chat-contract.js:97`, propriedade removida                   | `test/order-billing-chat-routes.test.js:516`, deepEqual conserva charge-predecessor       | KILLED, exit 1                       |
| Retornar null para predecessor persistido    | `apps/api/src/order-billing-chat-runtime.js:58`, retorno substituído por null            | `test/order-billing-chat-postgres-live.test.js:422`, predecessor deve ser first.chargeId  | KILLED, exit 1; 15 passaram/1 falhou |

Resultado: **5/5 mortos, zero sobreviventes**. Logs preservados em
`var/billing-verifier-sensor/`. Duas tentativas iniciais com dependência ausente
foram descartadas, sem contá-las como mutações mortas; ambos os casos foram
repetidos após baseline válido. A restauração das cópias preservou os bytes da
fonte original; o baseline final com Node fixado passou 30/30.

Baseline da árvore real antes do sensor: porcelain vazio, HEAD 270cfd7c.
Depois de remover scratch e container/volume próprios: porcelain novamente vazio,
idêntico ao baseline. Só estes relatórios foram escritos depois dessa comparação.

## Parecer e limites

Nenhum gap de aceite pendente nesta fatia. Os achados preliminares de cobertura,
volume anônimo e corrida de cancelamento foram corrigidos antes do freeze e
conferidos na revisão final. Sem mutante sobrevivente ou desvio final; nenhuma
nova lição foi registrada para este PASS.

O motor financeiro n8n, a autenticação técnica e a persistência local foram
exercitados; sessão humana é adaptador sintético. Mensagem na outbox não comprova
preflight/transporte humano, WhatsApp ou entrega. Não houve pagamento/link real,
publicação remota, alteração de produção, acesso a segredo remoto ou redesign.
T0–T3 e T6/BAPI-11 estão verificados no escopo descrito; a feature operacional
completa continua sujeita aos gates próprios da RFC047/COB-OPS-01.
