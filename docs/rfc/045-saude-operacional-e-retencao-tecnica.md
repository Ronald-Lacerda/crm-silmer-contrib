# RFC 045: Saúde operacional e retenção técnica

Decisão do proprietário em 05/11/2026: corrigir sinais, criar healthcheck e
limpar diagnósticos diariamente após 14 dias; coleta permanece manual.

Proposta aceita pela [ADR 060](../adr/060-saude-operacional-e-retencao-tecnica.md).
Requisitos [OPSH-01–05](../../.specs/features/operational-health/spec.md),
tarefa OPS-HEALTH-T01 e issue #11. PR será vinculado quando existir.

Usar PostgreSQL para heartbeat/progresso por fila e API para snapshot a cada
minuto, lido sem I/O em `/api/health/operations`. Alternativas: consultar banco
em cada request amplifica custo; monitorar o próprio worker somente pelo
worker não revela processo parado. Grafana/Graylog ficam fora desta entrega.
