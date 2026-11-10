# Validação independente da compatibilidade Basic financeira

**Verdict: PASS — exclusivamente para o patch local de T8/BREL-09.**

Data:10/11/2026. Revisor independente: `billing_release_verifier`, autor ≠
verificador. Base da revisão: HEAD `10dcc41a6553090b9e7d2c7e2fc81a70805baa35`
mais o diff de dois clientes financeiros e o novo teste de credenciais.
Requisitos BREL-09/04. O veredito libera o patch para commit/CI; não comprova
implantação deste patch nem encerra T7/recebimento em produção. Nenhuma
credencial real, navegador, console ou ambiente de produção foi acessado.

## Critérios rederivados e assertions

| Critério | Resultado exigido e evidência literal | Resultado |
| --- | --- | --- |
| Senha legada de13 caracteres funciona nos dois clientes | `test/billing-worker-credentials.test.js:30`: `assert.equal(BASE.clientSecret.length, 13)`; o loop CLIENTS executa checkout e payment-check. `:56` exige `deepEqual(await handler(...), { outcome: 'sent', providerExternalId: ID })`; `:60` exige requests=1. Não há valor de credencial real na fixture. | PASS |
| Basic conserva o conteúdo original, sem trim ou rotação | `test/billing-worker-credentials.test.js:48` exige header igual a ``Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}``; `:31`–`:35` inclui usuário/senha com espaços e senha com dois-pontos. Implementação conserva interpolação original em `modules/integration-reliability/src/billing-command-worker.js:49` e `billing-payment-check-worker.js:64`. O patch não altera credencial, configuração ou referência remota. | PASS |
| Limites inclusivos256/1024; sem mínimo32 | `test/billing-worker-credentials.test.js:33` usa exatamente256 e1024 e exige sucesso/transporte exato. `:64`–`:92` exige TypeError literal “Valid billing workflow credentials are required” para maximum+1 em cada campo. Predicados em `billing-command-worker.js:33`–`:40` e `billing-payment-check-worker.js:20`–`:27` não possuem mínimo32. | PASS |
| Recusar tipo inválido, vazio/branco, CR/LF e colon no usuário | `test/billing-worker-credentials.test.js:67`–`:76` enumera undefined/null/número/vazio/branco/CR/LF/excesso e usuário com dois-pontos; `:78` exige `assert.throws` com nome e mensagem exatos. A fixture de transporte em `:84` contém `assert.fail('invalid credentials must not reach transport')`. Senha com colon permanece válida no cenário positivo. | PASS |
| HTTPS, endpoint privado e timeout preservados | `test/billing-worker-credentials.test.js:96`–`:106` exige TypeError para HTTP remoto, URL com userinfo/query/fragment e timeout0/-1/fracionário/60001. `:44`–`:47` exige URL exata, POST, redirect=error e AbortSignal. O diff de implementação não toca essas guardas. | PASS |
| Falha de autenticação não vira sucesso e mantém política de retry | `test/billing-worker-credentials.test.js:110`–`:149` exercita401/403/302; `:123` exige os objetos completos:401/403 failed com código AUTH_REJECTED do cliente e retryable/retrySafe=false.302 checkout permanece outcome_unknown sem retry;302 check permanece indisponível com retry seguro. | PASS |
| BREL-04: receive-only não admite checkout com emissão/envio false | `test/billing-worker-credentials.test.js:154` usa ENABLED=false, CHAT_SEND=false e RECEIVE=true com Basic sintética13. `:180` falha se houver reserva irreversível; `:190` exige payload somente de check; `:199` exige dois jobs processados, `:200` requests=1, `:201` checkout failed, `:202` BILLING_DISABLED, `:203` retryable=false e `:204` check sent. `apps/worker/src/worker.js:589` e `:607` mantêm essa separação; o arquivo de runtime não foi alterado pelo patch. | PASS sintético |

A comparação com o cliente existente foi feita na fonte:
`modules/integration-reliability/src/n8n-outbound-client.js:57`–`:65` usa os
mesmos máximos256/1024 e `:79` preserva bytes no Basic. Seu helper `:371`
recusa comprimento zero, excesso e CR/LF; os clientes financeiros conservam
adicionalmente a recusa de branco após trim, exigida expressamente por
BREL-09. Portanto, os máximos/transporte se alinham, sem alegar que todos os
predicados do helper existente sejam idênticos.

## Gates executados

Node fixado24.20.0. Comando independente:

```text
node --test test/billing-worker-credentials.test.js test/billing-integration-worker.test.js test/order-billing-payment-check-worker.test.js test/order-billing-chat-wiring.test.js
28 aprovados;0 falhas;0 skips.
```

São nove testes novos de credenciais e19 regressões de worker, consulta e
wiring. Log: `var/billing-verifier-credential-focal.log`, exit0 registrado em
`var/billing-verifier-credential-focal.exit`. Typecheck independente:
`node node_modules/typescript/bin/tsc --project jsconfig.json`, exit0;
`var/credential-verifier-typecheck.log` e `.exit`.

O gate completo do autor foi inspecionado em
`var/billing-receive-completion/local-validate.log:4906`:2479 testes,
2427 aprovados,52 skips condicionais,0 falhas; inclui formato, typecheck,
lint e build. É evidência do autor, não uma segunda execução completa pelo
verificador. Nenhum teste preexistente foi removido ou enfraquecido neste diff.

## Sensor de discriminação comportamental

Sensor em cópia isolada do HEAD com overlay dos dois arquivos modificados e
do novo teste; node_modules por junction. Fontes/testes reais nunca foram
mutados; não houve git stash. Somente na cópia, a fixture receive-only recebeu
também uma URL de checkout sintética válida para que a mutação da flag
atingisse a guarda de efeito em vez de falhar por configuração ausente.
Todas as assertions originais foram mantidas. Baseline dessa cópia:9/9 PASS.

| Mutação na cópia | Falha discriminante observada |
| --- | --- |
| Checkout volta a exigir mínimo32 | Credencial válida13 recusada; teste de sucesso falha. |
| Payment-check volta a exigir mínimo32 | Credencial válida13 recusada; teste de sucesso falha. |
| Checkout aplica trim antes de codificar Basic | Header difere do esperado; resultado deixa de ser sent e deepEqual falha. |
| Payment-check aplica trim antes de codificar Basic | Header difere do esperado; resultado deixa de ser sent e deepEqual falha. |
| Checkout deixa de recusar senha branca | Missing expected exception(TypeError) em `:78`. |
| Payment-check deixa de recusar senha branca | Missing expected exception(TypeError) em `:78`. |
| Checkout deixa de limitar senha a1024 | Missing expected exception(TypeError) em `:78`. |
| Payment-check deixa de limitar senha a1024 | Missing expected exception(TypeError) em `:78`. |
| Worker trata receive-only como emissão permitida | Tenta reservar efeito de checkout; fixture recusa; código resultante BILLING_WORKFLOW_NOT_STARTED difere de BILLING_DISABLED em `:202`. |

**Resultado:9/9 mutações mortas,0 sobreviventes.** Todos os exits1 foram
inspecionados para falha esperada, sem erro de setup/import. Logs separados em
`var/credential-verifier-*.log`; resumo e hashes em
`var/credential-verifier-sensor.json`. Script privado reproduzível:
`var/credential-verifier-sensor.mjs`. Hashes SHA-256 dos dois fontes e teste
reais ficaram idênticos; porcelain antes/depois do sensor permaneceu igual.
Scratch, junction e zip foram removidos, após conferir o caminho absoluto
dentro de var. O relatório foi criado somente depois dessa conferência.

## Limites e fechamento

Nenhum finding bloqueante ou sobrevivente. Não foi registrada nova lição,
pois não houve sinal de falha. O patch é estreito, aceita a credencial legada
autorizada e não transforma falha de autenticação ou emissão desabilitada em
sucesso. A validação não impõe rotação nem comprova a credencial real por
chamada externa; somente preserva o contrato de transporte e suas guardas.

T7 continua pendente até commit/CI/implantação autorizada e conferência dos
processos. Esta revisão não habilitou RECEIVE, emissão ou envio, não publicou
workflow, não criou checkout e não registrou pagamento/mensagem. A ausência
de operação de emissão/envio é verificada por fixtures, não por nova leitura
de produção. A validação histórica e os demais arquivos de documentação
permaneceram intocados pelo verificador.
