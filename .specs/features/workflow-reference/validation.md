# Validation: workflow-reference — PASS

Data: 06/11/2026. Verifier independente, distinto do autor.
PR: #301, SIL-36. Revisão executável validada:
`26975c705f9110d106792a9c07d764d971e2b2d4`.
Diff da implementação: `b0982c2..26975c7`; encerramento posterior somente documental.

**Result: PASS.** A reconciliação Git preserva a referência publicada, os
candidatos e suas pendências. A pendência de captura/reprodução sintética
Firefox foi resolvida em ambiente Linux reproduzível, sem alterar testes.
Não há findings bloqueantes no escopo revisado.

## Escopo e fontes

Fontes: `RULES.md`, `ABOUT.md`, `ARCHITECTURE.md`,
`.specs/features/crm-mvp/tasks.md:132`, requisitos ORC-03/05/08 e AGT-10
em `.specs/features/crm-mvp/spec.md:243`, `:245`, `:248` e `:289`;
T19 em `.specs/features/inbox-media-rustfs/tasks.md:341` e MED-09/10
em `.specs/features/inbox-media-rustfs/spec.md:90`.
O mapa de `graphify-out/2026-09-23/GRAPH_REPORT.md` foi consultado somente
para descoberta; os achados foram confirmados nos arquivos/Git atuais.

Este PASS cobre SIL-36, preservação dos contratos e o gate sintético de áudio.
Não recertifica integralmente a API, a operação remota de ORC/AGT, microfone
físico ou entrega WhatsApp. A origem remota e a transação READ ONLY da captura
são proveniência histórica registrada no manifesto, sem nova consulta remota
pelo Verifier. As issues do ledger foram verificadas como referências locais;
o estado remoto do Linear não foi consultado.

## Critérios e evidências

| Critério / resultado esperado                                                                              | Evidência e assertion                                                                                                                                                                                                                                     | Resultado           |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| SIL-36: referência da versão publicada, 141 nós únicos e topologia íntegra                                 | `test/n8n-production-reference.test.js:37`: versão/ID; `:40` e `:41`: referência inativa e não implantável; `:42`, `:56`, `:57`: exatamente 141 nós/nomes/IDs; `:49`: hashes de nós/conexões/settings/grupos; `:59` e `:63`: origens/destinos existentes  | PASS                |
| SIL-36 / privacidade: retirar vínculos privados sem destruir headers técnicos                              | `test/n8n-production-reference.test.js:76`: hosts permitidos; `:82`–`:88`: ausência de telefone literal e credentials/webhookId/pinData; `:98`: SHA256 exatamente `={{ $json.content_sha256 }}`; `:109`: headers de versão iguais ao manifesto            | PASS                |
| SIL-36 / preservação ORC-03: manter 29 artefatos anteriores e candidato de 115 nós                         | `test/n8n-production-reference.test.js:114`: SHA256 de cada arquivo; `:118`: 115 nós. Conferência independente dos objetos Git em `b0982c2` e `72702f0`: 29/29 hashes iguais ao manifesto em ambos                                                        | PASS                |
| SIL-36: manter 12 deltas separados, pendentes e vinculados ao código preservado                            | `test/n8n-production-reference.test.js:119`: 12 itens; `:120`: issues únicas; `:125`–`:134`: IDs SIL, status pending, fonte/SDK e nós existentes; `ops/n8n/workflows/pending-features.json:5`                                                             | PASS                |
| ORC-05/08 no export: cancelar somente o stale fence fechado; não ocultar falha técnica nem repetir reserva | `test/n8n-production-reference.test.js:142`: retryOnFail=false; `:143`–`:145`: resposta completa/modo; `:165`: stale produz []; `:167`: sucesso/duplicata mantém corpo e pairing; `:176` e `:177`: 401/500/outros conflitos/resposta inválida lançam erro | PASS                |
| SIL-36 / AGT-10: preservar complementos operacionais, sem aplicar extras pendentes silenciosamente         | `test/n8n-production-reference.test.js:184`: nove nós de mídia; `:190`: diagnóstico de identidade; `:194`: errorWorkflow; `:196`: wrapper AGENTE-OBS-03; `:200` e `:206`: handoff de falha/transcrição do candidato não aparecem como publicados          | PASS                |
| MED-09: microfone somente por ação explícita e apenas áudio                                                | `test/e2e/audio-recorder.spec.js:180`: requests=[] antes da ação; `:185`: foco previsível; `:190`: requests exatamente [{audio:true}]. Fonte `apps/edge-web/src/components/inbox/AudioRecorder.vue:69`                                                    | PASS na suíte final |
| MED-10 / T19: parar oferece prévia reproduzível e descarte, envio humano explícito                         | `test/e2e/audio-recorder.spec.js:196` e `:200`: sends=0; `:199`: Enviar habilitado; `:205`–`:206`: efeito após ação; `:443`: Chromium/Firefox nativos; `:515`–`:517`: MIME áudio, paused=false e erro=null; `:519`: prévia removida ao descartar          | PASS                |

Os valores esperados acima vêm dos critérios SIL-36 e MED-09/10; não foram
relaxados para coincidir com a implementação. ORC/AGT identificam os contratos
que a reconciliação deve preservar, sem converter testes de snapshot em
evidência de homologação operacional.

## Gates e integridade dos testes

Os 12 testes focais e o sensor foram executados pelo Verifier. O orquestrador
executou os gates integrais e forneceu os resultados abaixo; o Verifier
conferiu os caminhos de código/assertions e a configuração de retries.

| Comando / ambiente                                                                                               | Resultado                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test test/n8n-production-reference.test.js test/n8n-ai-stale-reservation.test.js`, checkout real         | 12 aprovados, 0 falhas, 0 skips                                                                                                        |
| `npm run validate`, Linux isolado                                                                                | 1.757 aprovados, 16 skips, 0 falhas, 0 cancelamentos; formatação/tipos/lint/fronteiras/validadores e build aprovados                   |
| `playwright test test/e2e/audio-recorder.spec.js --grep "actual .* synthetic device" --workers=1`, Linux isolado | 2/2 aprovados: Chromium e Firefox; 0 skips                                                                                             |
| `playwright test --workers=2`, primeira execução Linux                                                           | 504 aprovados, 7 skips e 1 timeout no caso anterior de 16 MiB (`test/e2e/audio-recorder.spec.js:438`); os dois browsers reais passaram |
| `playwright test --last-failed --workers=1`                                                                      | Caso de 16 MiB aprovado, 1/1                                                                                                           |
| `playwright test --workers=2 --retries=2`, execução integral final Linux                                         | **505 aprovados, 7 skips, 0 falhas**, exit 0; sem flaky ou retry consumido na execução final                                           |
| `npm audit --audit-level=high`                                                                                   | Exit 0; seis avisos low/moderate existentes, zero high/critical                                                                        |
| `git diff --check`                                                                                               | Aprovado                                                                                                                               |

A política de dois retries já existe para CI em `playwright.config.js:10`;
nenhum teste ou configuração foi alterado para obter o resultado.
A falha transitória inicial e sua repetição foram mantidas no registro.

Integridade: o diff original adiciona somente
`test/n8n-production-reference.test.js` (212 linhas, cinco testes); não
remove nem altera testes anteriores. A contagem focal passa de sete testes
anteriores para 12 (+5), todos executados. A suíte unitária atual totaliza
1.773 casos; a contagem pré-PR inferida do diff é 1.768, sem alegar nova
execução integral dessa baseline. Os 512 casos E2E são os mesmos anteriores
à PR. Nenhum candidato, referência ou assertion de áudio foi modificado.

### Skips anteriores, justificados

Os 16 skips unitários exigem `TEST_DATABASE_URL`, ausente no container
descartável desta validação. Não são regressões ou exclusões novas:

| Fonte                                                                  | Casos |
| ---------------------------------------------------------------------- | ----- |
| `test/dashboard-checkpoint-postgres-live.test.js:14`                   | 1     |
| `test/dashboard-postgres-live.test.js:36`                              | 1     |
| `test/finance-postgres-live.test.js:204`                               | 1     |
| `test/health-errors-postgres-live.test.js:62`, `:395`, `:898`, `:1389` | 4     |
| `test/health-errors-retention.test.js:101`                             | 1     |
| `test/operation-read-postgres-live.test.js:1219`                       | 1     |
| `test/operational-signals-postgres-live.test.js:80`                    | 1     |
| `test/order-assistance-postgres-live.test.js:22`                       | 1     |
| `test/postgres-webhook-inbox-live.test.js:80`                          | 1     |
| `test/shipping-postgres-live.test.js:55`                               | 1     |
| `test/store-order-correction-postgres-live.test.js:201`                | 1     |
| `test/vendedor-evolucao-postgres-live.test.js:1726`                    | 1     |
| `test/work-management-postgres-live.test.js:198`                       | 1     |

Os sete skips E2E estão em `test/e2e/crm-ui.spec.js:777`, `:3725`,
`:3748`, `:3785`, `:3794`, `:3813` e `:3825`: são testes legados de
Kanban/Negócio, aposentados por ADR 004 e `RULES.md`. Os casos novos e a
gravação Firefox/Chromium não têm skips. A suíte PostgreSQL com banco real
permanece um gate próprio, fora desta execução sem banco.

## Ambiente de áudio e limites

Cópia produzida por `git archive` de `26975c7`, extraída em container local
sem mounts, portas publicadas, .env ou dados de produção. Imagem oficial
`mcr.microsoft.com/playwright:v1.62.1-noble`, digest
`sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`.
Node 24.20.0, npm 11.19.0, Playwright 1.62.1; instalação com npm ci.
PulseAudio/null sink segue o preparo sintético do CI.

O caso real em `test/e2e/audio-recorder.spec.js:443` usa .launch() nativo
Linux e as APIs reais getUserMedia/MediaRecorder. Não chama o setup que
instala FakeRecorder; `PW_FIREFOX_WS_ENDPOINT` não foi utilizado na execução
final. A mídia produzida pelo browser foi reproduzida pelo player real.

No Windows, o Firefox continua bloqueado por WinError 14001/SideBySide
(`mozglue`), inclusive após reinstalação oficial. O gate passou no ambiente
compatível; não se declara o executável Windows reparado. Tentativas remotas
intermediárias de configuração não foram usadas como evidência de aprovação.
Receita em `docs/runbooks/playwright-audio-local.md:15`.

## Sensor de discriminação

Cópias temporárias de arquivos, sem stash, checkout ou mutação no trabalho
real. O baseline do scratch passou 5/5. Para impedir que só a divergência de
hash matasse a mutação, o fingerprint de nós do manifesto foi recalculado
nas cópias de cada tentativa.

| Mutação semântica                                                | Assertion discriminante                                                         | Resultado                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| Remover o valor do header de integridade X-Silmer-Content-SHA256 | `test/n8n-production-reference.test.js:98`: valor exato da expressão de hash    | Morta: 4 aprovados / 1 falha, exit 1 |
| Propagar stale fence como corpo válido em vez de cancelar        | `test/n8n-production-reference.test.js:165`: resultado exatamente []            | Morta: 4 aprovados / 1 falha, exit 1 |
| Ocultar HTTP 401, convertendo-o em cancelamento silencioso       | `test/n8n-production-reference.test.js:176`: assert.throws AI_RESERVATION_HTTP_ | Morta: 4 aprovados / 1 falha, exit 1 |

**Sensor semântico: 3/3 mortos, zero sobreviventes.**
Uma guarda estrutural adicional foi sondada renomeando um nó para o nome
do handoff pendente: `test/n8n-production-reference.test.js:200` também
falhou. Essa sonda não substitui nenhuma das três mutações semânticas.

Isolamento confirmado antes/depois da limpeza: no checkout inicial a saída
`git status --porcelain=v1` foi vazia em ambos; no worktree isolado, na
terceira mutação semântica, foi exatamente
`?? docs/runbooks/playwright-audio-local.md` em ambos. Todos os temporários
foram removidos. A troca posterior do checkout original para outra tarefa
foi detectada sem alterá-lo; o encerramento usa exclusivamente o worktree
`pr301-firefox-validation/crm-silmer`. Mudanças documentais do orquestrador
foram preservadas; o Verifier escreveu somente este relatório.

## Qualidade e fechamento

Patch de referência/documentação, sem mudança de framework, infraestrutura
operacional, API, domínio, migration ou autorização. Os 29 artefatos anteriores
continuam byte a byte preservados; o ledger mantém os extras separados.
Casos negativos de autenticação/conflito/resposta inválida permanecem
discriminantes. Não há sinal de falha ou lacuna de precisão no escopo
validado que exija nova lesson.

A revisão documental de encerramento inclui
`CONTRIBUTING.md`, `.specs/features/crm-mvp/tasks.md`,
`ops/n8n/workflows/README.md` e o runbook de áudio. Os gates executáveis
acima correspondem ao commit fixo informado, pois o encerramento não altera
o código ou os testes.

SIL-36 e o gate sintético T19/MED-09/10 estão verificados neste escopo.
Merge, deploy, publicação/execução de workflows, produção e encerramento
das pendências SIL-8/SIL-39–49 não fazem parte deste PASS.

Gate determinístico: `python C:/Users/Ronal/.codex/skills/tlc-spec-driven/scripts/validate_state.py workflow-reference` aprovado com zero erros.
