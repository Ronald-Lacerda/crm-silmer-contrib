# Validação independente: saúde operacional

## Verdict

PASS. OPSH-01–05 atendidos no patch revisado. Nenhum finding bloqueante.
Autor desta revisão: Verifier independente, sem autoria da implementação.

## Diff revisado

Base: `06836f73de04bcf72e84fe0ea411b49b63c2c79e` (`master`).
Destino: branch `codex/operational-health-signals`, incluindo arquivos novos
e mudanças do worktree inspecionados em 05/11/2026. O integrador registra
o commit final e o resultado dos gates completos na tarefa da entrega.

Escopo: runtime/scheduler/rota, adaptador PostgreSQL, migration 0058, worker,
retenção da central, rótulos de 14 dias, OpenAPI, CI e documentos associados.

## Evidências por requisito

| Requisito | Resultado esperado | Evidência e expressão verificada |
| --- | --- | --- |
| OPSH-01 | Progresso concluído por fila, idade real mesmo sem falhas; falha não zera amostra | `test/operational-health.test.js:158`, `assert.deepEqual(writes, [{queue: 'external_effects', pollCompletedAt: new Date(1_800_000_000_000)}])`; `:161` e `:163`, `assert.equal(metrics.snapshot().worker_oldest_job_age_seconds, 345)` antes/depois da falha |
| OPSH-01 | Poll falho não inventa progresso novo | `test/operational-health.test.js:234`, `assert.equal(writes[0].pollCompletedAt, null)`; `:242`, `assert.equal(writes[2].pollCompletedAt.getTime(), time - 130_000)` |
| OPSH-01/03 | Filas obrigatórias persistidas; heartbeat/progresso vencido degrada | `test/operational-signals-postgres-live.test.js:129`, total persistido `=== 3`; `:143`, `:149`, `:155`, `assert.equal((await signals.sample(queues)).worker, false)` para ausência de progresso, progresso vencido e heartbeat vencido |
| OPSH-02 | Cold start/falha/TTL produzem 503; recuperação produz 200; resposta não revela exceção | `test/operational-health.test.js:27` e `:52`, `assert.deepEqual(health.read(), {statusCode: 503, body: {status: 'unavailable'}})`; `:43`, `assert.equal(health.read().statusCode, 503)` após 120001ms; `:59`, retorno `200` após recuperação |
| OPSH-02 | Rota pública, no-store e sem consulta por request | `test/operational-health.test.js:107–113`, status `200`, header `no-store` e checks exatos; `:41`, `assert.equal(queries, 1)` após 1000 leituras. `apps/api/src/server.js:353–358` chama somente `operationalHealth.read()` |
| OPSH-03 | Amostragem não sobrepõe e stop drena | `test/operational-health.test.js:76`, `assert.equal(health.refresh(), first)`; `:82`, `assert.equal(stopped, false)` enquanto pendente; `:86`, `assert.equal(queries, 1)` após stop |
| OPSH-03 | Retry futuro/terminais não atrasam; pending/retry acima de 300s degradam | `test/operational-signals-postgres-live.test.js:166–174`, queue `true` e age `0`; `:181–185`, idade 290–300 e queue `true`; `:190`, `:199–200`, queue `false` e idade >=301 |
| OPSH-03 | Comando expirado >120s ou sem lease degrada | `test/operational-signals-postgres-live.test.js:216`, commands `true` com 110s; `:220` e `:307`, commands `false` com 121s e lease ausente |
| OPSH-03 | Consultas indexadas e timeout de lock | `test/operational-signals-postgres-live.test.js:251–253`, índices operacionais; `:269–270`, sem Seq Scan nas tabelas de domínio; `:289`, `assert.rejects(signals.sample(queues), {code: '55P03'})`. `modules/database/src/operational-signals.js:10–11` fixa 100ms/1s |
| OPSH-04 | Limpeza diária, não horária e sem disparar coleta | `test/operational-health.test.js:194`, `:197`, `:200`, cleanups `1`, `1`, `2` em boot/1h/24h; `:201`, collections `0` |
| OPSH-04 | Sem espera pelo lock de incidentes; lotes até 1000 e apenas tabelas técnicas | `test/health-errors-retention.test.js:31–42`, skip com deleted `0`, timeouts e nenhuma mutação; `:53–69`, deleted `3000`, batchFull `true`, três deletes com LIMIT1000 e nenhuma atualização |
| OPSH-04 | Janela14d correta antes/depois do expurgo; fronteira exata preservada | `test/health-errors-retention.test.js:149–159`, um grupo, occurrences/activeCount `2`, versão `7`, histórico recente e firstSeenAt exatamente now()-14d; `:161–185`, drenagem bounded em duas chamadas; `:187`, `assert.deepEqual((await runtime.list(input)).items, before.items)` |
| OPSH-05 | Central coleta só na consulta; health503 não cria incidente | `test/health-errors-retention.test.js:86–95`, sem DELETE/try-lock durante list e fontes limitadas; `test/operational-health.test.js:130–132`, 503 com corpo exato e `collected === 0`; `:201–203`, nenhum timer coleta e uma consulta chama list uma vez |
| OPSH-05 | Contratos anteriores preservados | `test/operational-health.test.js:115`, live200; `test/observability.test.js` cobre ready503/true/false/exception. `test/health-errors-postgres-live.test.js:184`, replay idêntico; `:197`, disputa200/409; `:230`, recorrência3; `:253`, rollback sem mudança. `scripts/runtime-healthcheck.mjs` e Dockerfile sem alteração |

## Execução independente

Comando: `node --test test/operational-health.test.js test/health-errors-retention.test.js test/health-errors.test.js test/observability.test.js`.
Resultado: 24 passaram, zero falhas, um teste live ignorado por ausência de
`TEST_DATABASE_URL` neste processo do Verifier. O integrador executa as suítes
live serialmente no banco dedicado, sem concorrência com esta revisão.
`git diff --check` passou.

## Discrimination sensor

Copiei `apps/api/src/operational-health.js` e o primeiro teste real de
`test/operational-health.test.js` para diretório temporário fora do repositório.
O teste foi executado com `node --test`, sem dependências de produção ou banco.

| Variante | Resultado |
| --- | --- |
| Baseline sem mutação | PASS, 1/1 |
| Remover expiração do snapshot | Morta: retorno200 em vez de503 no assert de TTL |
| Ignorar worker/fila na decisão de saúde | Morta: retorno200 em vez de503 no assert de sinal degradado |

As duas mutações foram rejeitadas pelas mesmas asserções da suíte. Nenhum
arquivo real foi alterado no sensor, nenhum stash foi usado e o scratch foi
descartado. Nenhum mutante sobrevivente ou lição corretiva a registrar.

## Limites e riscos operacionais

- Não houve inspeção nem alteração de produção, monitor externo ou envio real.
- Índices usados com `enable_seqscan=off` provam existência de caminho indexado;
  não constituem benchmark de carga ou garantia de latência de produção.
- `CREATE INDEX` padrão da migration 0058 pode bloquear escritas durante a
  criação. Medir tabelas e aplicar em janela apropriada; não prometer impacto
  zero na implantação.
- Limpeza pode deixar backlog após seu orçamento. Leitura já oculta dados
  vencidos; `OPERATIONAL_CLEANUP_INCOMPLETE` exige investigação operacional.
- Uma falha total da VPS continua exigindo monitor fora do host.
