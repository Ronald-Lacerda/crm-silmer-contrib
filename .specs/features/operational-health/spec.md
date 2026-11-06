# Saúde operacional do CRM

## Problem Statement

Heartbeat apenas em log e idade da fila atualizada somente em falhas não
comprovam operação. OPS-HEALTH-T01 corrige os sinais e oferece um endpoint
barato para futuro monitor externo. Complementa OPS-ERR-03/04/08 e T00.7.

## Out of Scope

Monitor externo, Grafana, Graylog, notificações, reenvios, coleta automática
de incidentes e atualização automática da página.

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale |
| --- | --- | --- |
| Amostragem | 60 segundos; snapshot vence após 120 segundos | Custo limitado independente dos acessos HTTP |
| Worker | Cada fila obrigatória publica heartbeat a cada 30 segundos; último poll concluído deve ter menos de 120 segundos | Timer sozinho não comprova poll útil |
| Fila atrasada | Maior espera desde available_at de pending/retry elegível, limite 300 segundos | Retry futuro não constitui atraso |
| Comando travado | Lease processing expirado há mais de 120 segundos, ou lease ausente | Separar atraso transitório de indisponibilidade |
| Retenção | 14 dias, limpeza a cada 24 horas e catch-up na inicialização | Autorização explícita do proprietário nesta conversa |
| Infraestrutura | API, worker e PostgreSQL existentes | Nenhum novo serviço |

Open questions: none.

## User Stories

Como operador, quero verificar saúde operacional sem abrir a central e sem
executar consultas em cada scrape. Quero manter a coleta de incidentes manual.

Acceptance Criteria:
1. WHEN o worker conclui polls THEN o sistema SHALL persistir por fila heartbeat e progresso com atraso real da fila mesmo sem falhas, sem sobrescrever a idade medida por zero em falha sem amostra.
2. WHEN o monitor consulta GET /api/health/operations THEN a API SHALL responder somente com snapshot em memória, sem acessar banco, com cache-control no-store, 200 saudável ou 503 degradado/indisponível; ausência, falha ou idade maior que 120 segundos SHALL resultar em 503.
3. WHEN a amostragem executa a cada 60 segundos THEN o sistema SHALL usar uma execução por vez, consultas indexadas e limites de lock de 100 ms e statement de 1 segundo; worker/progresso acima de 120 segundos, fila acima de 300 segundos ou comando expirado acima de 120 segundos SHALL degradar o resultado.
4. WHEN diagnósticos técnicos excedem 14 dias THEN a limpeza SHALL removê-los em lotes limitados, no máximo uma execução simultânea e cadência diária; leituras SHALL filtrar a janela e projetar contagens corretas antes do expurgo, sem limpar no carregamento da página ou tocar nas fontes originais.
5. WHEN ocorre load/refresh autorizado da central THEN a coleta de incidentes SHALL continuar deduplicada e restrita a essa consulta; amostragem operacional e seus 503 SHALL não coletar incidentes nem gerar loops; live/ready e healthchecks de restart SHALL manter contratos existentes.

## Requirement Traceability

| ID | Critério | Tarefa | Status |
| --- | --- | --- | --- |
| OPSH-01 | Sinais duráveis e progresso | OPS-HEALTH-T01 | verified |
| OPSH-02 | Endpoint público seguro e cacheado | OPS-HEALTH-T01 | verified |
| OPSH-03 | Amostragem limitada e limiares | OPS-HEALTH-T01 | verified |
| OPSH-04 | Retenção diária 14 dias | OPS-HEALTH-T01 | verified |
| OPSH-05 | Coleta manual e isolamento | OPS-HEALTH-T01 | verified |
