# Validação independente da proteção publicada e preparação inativa

**Verdict: PASS — somente T5/proteção publicada e T6/preparação sem ativação.**

Revisor: `billing_release_verifier`, independente do autor das operações e do
runbook. Conferência em09/11/2026. Requisitos BREL-06/07/04/05;
BAPI-07/09/10 e COB-OPS-01. Contexto documental: commit `6240f528` e runbook
T6 apresentado no worktree; runtime implantado continua sendo `87cbc435`.
Esta revisão acrescenta evidência à revisão histórica T1–T4, sem reatribuir
seus resultados, modificar seu texto ou declarar homologação financeira.

## Resultado por critério

| Critério | Resultado esperado e evidência | Veredito limitado |
| --- | --- | --- |
| BREL-06: preservar o atendimento existente | Comparador independente `var/billing-activation-preparation/independent-human-review.mjs:18` exige candidato exatamente igual ao resultado do patcher; `:22` compara integralmente cada um dos141 nós originais; `:36` compara todas as conexões com o candidato. Resultado em `independent-published-review-verifier.json:4`:141 originais exatos,144 nós totais. Inclui IDs, parâmetros, posições, referências de credencial e propriedades de webhook dos originais. | PASS estrutural |
| BREL-06: delta restrito e normalização | `independent-human-review.mjs:25` normaliza somente id/position dos três novos nós e GET omitido apenas no novo HTTP; `:39` exige sete arestas adicionadas e uma removida, com origem/destino da remoção exatos em `:40`. São cinco arestas normais e duas de erro. `:45` recusa alteração de metadados fora de versionId UUID gerado pelo save. Settings/identidade/credenciais originais permanecem iguais. | PASS estrutural |
| BREL-06: versão publicada | `independent-published-sensor.mjs:12` exige versionId `9157724a-1493-4d85-91f7-582af4d73a1c`; `:13` exige active=true e144 nós. A captura privada `human-published-version.jpg` foi inspecionada: título “Proteção de cobrança — flags desligadas” e entrada de09/11 às23:06:25 no histórico. A navegação/publicação foi feita pelo autor; o revisor inspecionou artefatos, sem operar produção. `docs/qa/order-billing-human-guard-2026-11-09.md:10` identifica essa revisão. | PASS para artefato publicado observado |
| BREL-06: autorização estrita e falhas fechadas | `ops/n8n/billing-send-preflight.mjs:19` aceita somente valid===true. `test/billing-send-workflow.test.js:85` exige false para resposta ausente, inválida ou negativa; `:154` executa expressão/código do workflow com respostas sintéticas e exige sends=1 somente no allow, zero nos demais casos, preservando code/phase/command_id da conclusão. `test/n8n-billing-preflight-routes.test.js:39`, `:60`, `:67`, `:78` cobrem identidade reservada, booleano estrito, erros e recusas de credencial/query/HEAD. | PASS sintético; não execução no engine de produção |
| BREL-06: falha anterior ao envio preservada | `independent-human-review.mjs:51` exige node code com MEDIA_PREFLIGHT_REJECTED e before_message_send; `:52` exige destino “CRM - Concluir falha anterior ao envio (MVP)”. Os nós originais, inclusive esse caminho de conclusão e o envio comum, foram comparados integralmente. `docs/qa/order-billing-human-guard-2026-11-09.md:42` registra o resultado. | PASS estrutural/sintético |
| BREL-04/07: flags continuam fechadas | Capturas `api-flags-health-after-publish.jpg` e `worker-flags-after-publish.jpg` inspecionadas: ORDER_BILLING_ENABLED, ORDER_BILLING_RECEIVE_ENABLED e ORDER_BILLING_CHAT_SEND_ENABLED explicitamente false nos processos API/worker. Captura API também mostra live/ready/edge200. `docs/qa/order-billing-human-guard-2026-11-09.md:63`–`:69` registra a observação. | PASS para observação após publicação |
| BREL-04/07: nenhuma atividade financeira observada | Captura privada `database-after-publish.jpg` inspecionada:71/71 expand, última0075, mismatches[], seis tabelas financeiras com zero registros, BILLING_QUEUE[] e heartbeat8s. `docs/qa/order-billing-human-guard-2026-11-09.md:70`–`:72`. Não houve checkout, pagamento, callback financeiro fabricado ou mensagem real pelo revisor. | PASS para estado observado; não auditoria universal de terceiros |
| BREL-05/07: workflows financeiros inativos e credenciais preservadas | Comparação independente em Node entre `issue-inactive-final.json` e `order-billing-release-final.json`, e entre `check-inactive-final.json` e `payment-check-release-final.json`: active=false,19/11 nós, id/nodes/connections/settings deepEqual. Todas as entradas de node.credentials contêm apenas chaves id/name. `var/billing-activation-preparation/financial-inactive-review.json:4` e `:13` registra activefalse. Cadastro pessoal da chave pertence à evidência T4; sua validade e conta perante o provedor não foram testadas. | PASS estrutural/inativo |
| BREL-07: sequência futura compatível | `docs/runbooks/order-billing-activation.md:38`–`:44` mantém estado atual todofalse, publica endpoints antes das flags, recebe antes de emitir e envia por último, com autorização específica e gates. Runtime: `apps/api/src/order-billing-runtime.js:116`–`:122` separa emissão/recebimento/consulta; `apps/api/src/order-billing-chat-runtime.js:70`–`:74` exige emissão+send para admissão de envio. | PASS do plano; sequência não executada |
| BREL-07: filas/worker e recuperação | `apps/worker/src/worker.js:589` define receivingOnly; `:607`–`:612` encerra checkout BILLING_DISABLED, sem retry, nesse modo; `:836`–`:839` só inicia worker receive-only com check endpoint configurado. Runbook `:27`–`:30` exige URLs, inventário das filas e alerta contra limpeza implícita/ausência de piloto técnico. Runbook `:70`–`:75` desliga envio/emissão, conserva recebimento se há links possíveis e proíbe retry cego, reversão de expand e reativação financeira sobre versão humana sem guard. | PASS do plano |
| BREL-04/05/07: limites e aviso prévio | Runbook `:3`–`:5`, `:23`–`:24`, `:58`–`:66` exige aviso/autorização específica, comprador controlado, pagamento pessoal e nenhum dado de cartão/segredo no chat. `:73` reconhece execuções antigas e `:74` reconhece links já emitidos. `:79` conserva a distinção entre preparação e ensaio financeiro. | PASS do plano |

## Gates e sensor independentes

Executado sem build nem acesso à produção:

```text
node --test test/billing-send-workflow.test.js test/n8n-billing-preflight-routes.test.js test/order-billing-chat-wiring.test.js
24 testes aprovados;0 falhas;0 skips.
```

O gate executa o código/expressões com dados sintéticos, valida HTTP da API e
wiring. `test/billing-send-workflow.test.js:99` distingue GET default omitido
de POST, HEAD, null, vazio e método dinâmico; `:139` conserva identidade da
Basic. `test/order-billing-chat-wiring.test.js:101` exige503 e zero chamadas
para flags ausente/vazia/false, mantendo leitura privada; `:142` exige startup
fechado para combinações inválidas. Nenhum teste foi enfraquecido para o gate.

Comparação do export real após publicação foi executada novamente pelo revisor
com `independent-human-review.mjs human-published.json independent-published-review-verifier.json`.
Resultado PASS. Hash SHA-256 do export publicado:
`831133d63339f3aaeebdc8e1401b6970112eb2262e91d102021b923d73e06e62`.

Sensor adversarial do comparador, em cópias privadas isoladas, nunca no export
original ou no workflow remoto. Código em `independent-published-sensor.mjs:16`;
resultados em `independent-published-sensor.json`:

| Mutação estrutural perigosa | Resultado esperado/observado |
| --- | --- |
| Texto sem mídia ligado diretamente a SEND, contornando guard | BLOCK, exit1 |
| Erro da validação ligado a SEND | BLOCK, exit1 |
| Erro HTTP do preflight ligado a SEND | BLOCK, exit1 |
| Validação aceita truthy em vez de booleano true | BLOCK, exit1 |
| Retry automático habilitado no HTTP de preflight | BLOCK, exit1 |
| GET substituído por POST | BLOCK, exit1 |

**Sensor:6/6 detectadas;0 sobreviventes.** Isso comprova discriminação do
comparador estrutural, não execução dessas falhas no engine n8n. Cada cópia
mutante foi removida; hashes dos quatro exports originais foram conferidos
inalterados em `independent-published-sensor.mjs:35`. Nenhum git stash,
publicação, alteração de ambiente ou comando financeiro foi feito pelo revisor.

## Conclusão e limites

Sem finding bloqueante na proteção publicada ou no runbook T6 apresentado.
T6 pode ser encerrada como **preparação concluída**, mantendo a ativação e o
ensaio real pendentes. A conclusão não aprova operação financeira dos
vendedores, prova de autenticação InfinitePay, titularidade da chave,
checkout/pagamento real, entrega WhatsApp, comportamento de execuções n8n já
iniciadas ou restauração de backup. Capturas/exports são observações pontuais;
o runbook exige reler estado e filas no início da futura janela.

BREL-06/07 foram avaliados para o escopo autorizado. BREL-04/05 permanecem
preservados; nenhuma nova cópia de segredo foi solicitada ou escrita no
relatório. Não houve sinal de falha ou sobrevivente que justifique nova lição.
Os artefatos completos continuam privados em var; o relatório versionado
contém somente resultados sanitizados e referências. O revisor alterou apenas
este relatório e acrescentou o link de continuidade à validação histórica.
