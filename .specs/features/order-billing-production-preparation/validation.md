# Validação da preparação técnica de produção

**Verdict: PASS** — preparação inativa aprovada. Ativação, deploy e homologação financeira permanecem bloqueados pelos gates operacionais descritos abaixo.

Data: 2026-11-08. Verificador independente: subagente `production_prep_verifier` (author ≠ verifier).
Fonte congelada: `8966f71d..bbeb4fbdaa1b47cc7dcdf5fc72823cd3429a86a0`.
Spec: `.specs/features/order-billing-production-preparation/spec.md`.

## Aceite ancorado na especificação

| Requisito / Tarefa | Resultado esperado | Evidência e verificação | Resultado |
| --- | --- | --- | --- |
| PPREP-01 / T1 | Dois candidatos financeiros inativos; preservar loja/atendimento; sem efeitos financeiros reais | `docs/qa/order-billing-production-preparation-2026-11-08.md:4` e `docs/qa/order-billing-production-preparation-2026-11-08.md:18` registram limites e preservação observados pelo orquestrador na sessão. Leitura independente dos exports privados `var/billing-production-preparation/order-billing-persisted.json:1` e `var/billing-production-preparation/payment-check-persisted.json:1`: `assert.equal(w.active, false)`, 19 e 11 nós. `human-preflight.json` coincide integralmente com `patchBillingSendPreflight(human-before).workflow`; todos os 141 nós originais iguais, 144 no candidato. Envelope separado inativo mantém nós/conexões iguais. | PASS |
| PPREP-02 / T1 | GET omitido/expresso aceito; novo GET explícito; fonte, credenciais, headers e ramos preservados; métodos inválidos/drift recusados; idempotência | `test/billing-send-workflow.test.js:99`: fonte imutável (`assert.deepEqual(before, snapshot)`), originais iguais, `assert.equal(request.parameters.method, 'GET')` na linha 109, URL/headers/credenciais iguais e `assert.deepEqual(patchBillingSendPreflight(workflow).changedNodeNames, [])`; laço de métodos inválidos exige `assert.throws(... /BILLING_PREFLIGHT_CONTEXT_MISMATCH/)`. `test/billing-send-workflow.test.js:49` cobre GET expresso, conexões, retry/redirect; teste final cobre drift/patch parcial/IDs em colisão. | PASS |
| PPREP-03 / T1 | Diagnóstico separar disponibilidade, flags, banco, release e credenciais; nenhuma homologação inferida | `docs/qa/order-billing-production-preparation-2026-11-08.md:11` limita HTTP 200 a disponibilidade; linhas 12–16 distinguem flags/URLs ausentes, migrações 0063–0065 ausentes e configuração sem digest comprovado. Linha 36 identifica credenciais não homologadas e linha 71 mantém COB-OPS-01 aberta. Código confirma defaults desligados: `apps/api/src/order-billing-runtime.js:115`, `apps/api/src/order-billing-chat-runtime.js:70` e `apps/worker/src/worker.js:770`, comparações estritas a `'true'`. Exports privados confirmam apenas uma credencial vinculada por candidato, com nome DEV; demais bindings ausentes. | PASS |
| PPREP-04 / T1 | Reexportação persistida comprovar inatividade e quatro controles de retenção desligados | `docs/qa/order-billing-production-preparation-2026-11-08.md:29` e exports privados acima: assertions independentes `saveDataErrorExecution === 'none'`, `saveDataSuccessExecution === 'none'`, `saveManualExecutions === false`, `saveExecutionProgress === false`, `active === false`; `availableInMCP === false`. | PASS |

Quatro de quatro requisitos cobertos, sem lacuna de precisão identificada. T1 completa para preparação; nenhuma conclusão adicional de COB-OPS-01.

Os arquivos privados são ignorados e não integram este relatório. Comparação independente dos candidatos com os reexports confirmou códigos dos nós e conexões iguais; diferenças de parâmetros restringem-se à omissão dos defaults GET e contentType JSON pelo n8n. Nenhum valor de segredo ou código remoto integral foi transcrito. As observações dos consoles remotos e a ausência de ações Publish/Execute têm como fonte a inspeção do orquestrador nesta sessão e as capturas privadas; o verificador não repetiu operações remotas.

## Gate de preparação

Executados com Node fixado `v24.20.0`:

- `node --test test/billing-send-workflow.test.js test/billing-integration-workflow.test.js test/billing-development-check.test.js`: **19 passaram, 0 falharam, 0 skips**; a suíte modificada tem 6 testes.
- Baseline anterior: 5 testes na suíte modificada; atual: 6; delta +1, nenhum teste removido ou assertion enfraquecida no diff. As demais duas suítes não foram alteradas (total anterior 18, atual 19).
- `node node_modules/typescript/bin/tsc --project jsconfig.json`: PASS.
- ESLint global em apps/modules/scripts/test/config e no módulo offline alterado: PASS.
- Prettier nos seis arquivos da entrega: PASS.
- `git diff --check`: PASS; porcelain real vazio antes e depois dos sensores.

Uma tentativa inicial usou nome incorreto de arquivo de teste e executou somente 9 casos; foi descartada como gate. O comando correto acima executou os 19 casos. Uma tentativa inicial de sensor via argumento inline teve erro de quoting antes da execução; o sensor válido usou stdin e scratch isolado.

## Sensor de discriminação

Profundidade leve: dois defeitos na única mudança de comportamento, que é um patch offline de exportação; nenhum caminho financeiro real ou transporte foi alterado nesta entrega.

| Mutação em cópia isolada | Evidência da rejeição | Resultado |
| --- | --- | --- |
| `ops/n8n/billing-send-preflight.mjs:48`: aceitar POST além de GET/ausente | Teste `test/billing-send-workflow.test.js:99` falhou com `Missing expected exception` / ERR_ASSERTION, exit 1. | Killed |
| `ops/n8n/billing-send-preflight.mjs:88`: remover atribuição explícita `method: 'GET'` | Assertion de GET explícito do mesmo teste (`test/billing-send-workflow.test.js:109`) falhou com ERR_ASSERTION, exit 1. | Killed |

**2 injetados, 2 mortos, 0 sobreviventes.** Cópia temporária de ops/n8n e teste em diretório temporário; nunca git stash, nem alteração da implementação real. Scratch removido em finally; comparação de `git status --porcelain` antes/depois confirmou isolamento. Este relatório é a única escrita final do verificador no repositório.

## Qualidade e limites operacionais

Patch estreito, padrões existentes preservados, sem abstração ou infraestrutura adicional. Testes modificados correspondem a PPREP-02/BAPI-07/09/10; suites existentes cobrem guardas, reserva, callback e resultados negativos, sem chamadas reais ao provedor. Não houve UI de produto alterada nem UAT interativa necessária. Diretrizes: AGENTS.md, RULES.md e checklist independente tlc-spec-driven.

Liberação: registrar/entregar a preparação inativa. Bloqueios para ativar: integrar release compatível e comprovar SHA/digest recuperável; backup e migrações 0063–0065 com checksums; vincular e homologar credenciais corretas e capacidades; configurar URLs/flags no ambiente alvo; revisar e publicar workflows/delta apenas após esses gates; obter autorização específica antes de teste com cobrança, pagamento ou mensagem reais.

Health 200 não comprova conectividade autenticada n8n→CRM/InfinitePay. Não foram comprovados digest implantado, execução financeira, ACK, autorização das credenciais DEV ou prontidão operacional. O candidato humano original herda active:true; somente o envelope separado é inativo, e nenhum foi aplicado sobre o atendimento publicado. Reexportar a versão vigente antes da futura aplicação. Sem findings de implementação ou sobreviventes; nenhuma lesson acrescentada.
