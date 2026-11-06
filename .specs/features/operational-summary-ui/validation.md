# Validação independente — OPS-HEALTH-UI01

Resultado: **PASS**, sem achados bloqueantes no protótipo revisado.
Verifier: agente `review_summary_ui`, distinto do autor. Revisão do worktree
da branch `codex/health-summary-prototype`, baseada em `b0982c2`.

## Critérios e evidências

| Critério | Resultado | Evidência e assertiva verificável |
| --- | --- | --- |
| OPSUI-01 — atualização explícita | PASS | `apps/edge-web/src/views/HealthErrorsView.vue:138`, `:320` e `:343`: saúde é solicitada pelo mount e Atualizar; filtros e triagem chamam `load` sem `refreshOperations`. `test/e2e/health-errors.spec.js:602`: `operationalReads` permanece em 1 após filtro, triagem e avanço de 180s; passa a 2 após Atualizar. Eventos não solicitam saúde (`HealthErrorsView.vue:314`). |
| OPSUI-02 — estados honestos | PASS | `apps/edge-web/src/lib/operational-summary.js`: valida os três sinais, coerência do estado e timestamp na leitura; falhas resultam em `unavailable`. `test/operational-summary-ui.test.js:14`, `:32` e `:59`: asserts de `healthy`, `degraded` e `unavailable`; `:60` exige todos os sinais como `Sem leitura` no caso inválido. `HealthErrorsView.vue:113` aceita corpo 503 estruturado. `test/e2e/health-errors.spec.js:648` exige atenção, fila atrasada e orientação; `:660` exige indisponível após falha de rede, sem saudável. Instante e atualização manual explícitos na view `:374`. |
| OPSUI-03 — ACL, aborto e isolamento | PASS | `HealthErrorsView.vue:77` limpa dados e aborta requisições ao perder acesso; `:117` impede escrita tardia; `:299` aborta e limpa ao sair. `test/e2e/health-errors.spec.js:662` mantém ocorrência consultável após falha da saúde; `:664` confirma triagem; `:667` exige ausência do resumo após negação de acesso. Teste `:670` mantém a requisição realmente pendente, observa `requestfailed` após navegar e exige ausência do resumo em `:708`. Foco inicial e de retorno da triagem continuam cobertos pelos cenários existentes. |
| OPSUI-04 — UI compacta e acessível | PASS | `HealthErrorsView.vue:350` mantém uma superfície com estado textual, três sinais e orientação condicional; `:399` usa `details/summary` para notas. `apps/edge-web/src/styles/screens/99-health-errors.css:162` usa tokens atuais; `:250` organiza os sinais em uma coluna no mobile. `test/e2e/health-errors.spec.js:724` opera disclosure por Enter; `:732` exige `scrollWidth <= clientWidth` em 390px; `:743` exige zero violações axe. Capturas desktop, mobile e degradado conferidas visualmente: rótulos legíveis, foco visível, notas recolhidas e sinal degradado distinguido por texto e ícone. |

## Execução

- Verifier: `rtk proxy node --test test/operational-summary-ui.test.js` — 3 passes, zero falhas ou skips.
- Verifier: `rtk git diff --check` — sem erros.
- Autor, evidência comunicada ao Verifier: `npm run validate` — exit 0,
  1755 passes, 16 skips, zero falhas; build concluído.
- Autor, evidência comunicada ao Verifier: E2E da central — 20 passes.
  O Verifier não iniciou execução concorrente contra a mesma porta.
- Inspeção visual: `var/health-summary-desktop.png`,
  `var/health-summary-mobile.png`, `var/health-summary-degraded.png`.

## Sensor de discriminação

Executado pelo Verifier em diretório temporário fora do repositório, usando
cópias do helper e do teste real, alterando somente o caminho de importação.

| Variante | Resultado | Conclusão |
| --- | --- | --- |
| Baseline | Exit 0; 3 passes, 0 falhas | Cópia reproduz o teste real |
| Aceitar timestamp vencido | Exit 1; 2 passes, 1 falha | Mutante morto |
| Ignorar fila degradada | Exit 1; 2 passes, 1 falha | Mutante morto |

Zero mutantes sobreviventes. Cópias temporárias removidas; fontes reais não
foram alteradas pelo sensor.

## Limites e riscos residuais

O estado representa a última consulta explícita. A validade de 120s é aferida
na leitura; a tela não reclassifica nem consulta automaticamente com o tempo,
conforme a especificação e o rótulo de atualização manual. Falha de saúde tem
timeout de 10s. Evidência limitada ao protótipo local com dados sintéticos;
não valida produção, deploy ou disponibilidade real dos serviços.
