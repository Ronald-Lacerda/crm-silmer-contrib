# ADR 060: Saúde operacional e retenção técnica

Status: aceita pelo proprietário em 05/11/2026.

## Decisão

Adotar [RFC 045](../rfc/045-saude-operacional-e-retencao-tecnica.md),
[OPSH-01–05 / OPS-HEALTH-T01](../../.specs/features/operational-health/spec.md)
e issue #11. Supersede somente retenção de 30 dias da ADR 055: diagnósticos
da central passam a 14 dias, com expurgo diário em lotes. Auditoria e fontes
originais preservam políticas próprias. PR será vinculado quando existir.

O worker publica progresso e heartbeat por fila; a API amostra sinais leves
a cada minuto. Endpoint público retorna snapshot limitado a status/instantes,
sem acesso a banco por request. Snapshot ausente, vencido ou falha produz 503.
Não usar esse endpoint para restart de containers. Coleta de incidentes
permanece somente na consulta autorizada da central. Nenhum novo serviço.

## Consequências

Índices parciais e timeouts limitam trabalho; amostragem não disputa locks de
domínio. Falha total da VPS continua exigindo monitor externo. Aplicar migration
expand antes de atualizar API/worker; rollback da aplicação mantém tabelas.
