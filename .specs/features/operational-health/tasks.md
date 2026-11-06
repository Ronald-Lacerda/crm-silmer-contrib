# Plano de execução

## Task Breakdown

### T1: OPS-HEALTH-T01 — Sinais e saúde operacional

- [x] Entregar a fronteira operacional completa OPSH-01–05.
- Depends on: none.
- Files: migration expand 0058; adaptador em modules/database; worker;
  novo runtime de health operacional e wiring da API; runtime e rótulos da
  central; testes; OpenAPI; RFC/ADR e sínteses/runbook.
  Allowlist dos logs técnicos, CI serial e fixture do webhook isolada do
  sampler também integram a fronteira. Nenhuma asserção de segurança foi reduzida.
Tests: heartbeat/progresso, fila vazia/futura/atrasada, n8n expirado;
  cold start, snapshot vencido, falha e recuperação, requests sem queries;
  sobreposição/stop; fronteira 14 dias, deduplicação e expurgo limitado.
Gate: `npm run validate`, testes PostgreSQL dedicados, E2E da central,
  `npm audit --audit-level=high`, `git diff --check` e Verifier independente.
- Done when: OPSH-01–05 comprovados; nenhuma nova infraestrutura, segredo,
  coleta em segundo plano ou mudança do contrato de restart. Uma entrega,
  commit e push conforme AGENTS.md. Deploy/migration remotos fora do escopo.

## Execution Plan

1. Definir contratos, índices e critérios de aceite.
2. Implementar sinais e snapshot operacional; integrar retenção diária.
3. Validar com banco sintético, regressões e revisão independente.

Uma tarefa integrada preserva o contrato conjunto entre schema, produtores,
consumidor e janela de retenção. Sem publicação parcial de componentes.

## Test Coverage Matrix

| Requisito | Evidência planejada |
| --- | --- |
| OPSH-01 | Heartbeat/progresso e fila em testes unitários e PostgreSQL |
| OPSH-02/03 | Snapshot, rota sem I/O, limites e concorrência |
| OPSH-04 | Janela 14 dias, limpeza e preservação das fontes |
| OPSH-05 | Coleta manual, sem recursão no healthcheck |

## Gate Check Commands

- quick: `node --test test/operational-health.test.js test/health-errors-retention.test.js`
- build: `npm run validate`
- full: `npm run test:e2e -- test/e2e/health-errors.spec.js`

## Evidências

- `npm ci` e `npm run validate`: 1.750 aprovados, 16 ignorados por gates
  condicionais; format, tipos, lint, boundaries, validadores e build aprovados.
- Novos testes complementares de heartbeat/drain e limite de limpeza: suíte
  operacional com 8 aprovados. Tipos e lint repetidos após esses testes.
- PostgreSQL 17 dedicado em Docker: 15 aprovados, zero ignorados; inclui
  migration 0058, sinais, EXPLAIN, timeout, retenção, ACL, disputa e replay.
- E2E da central: 16 aprovados, incluindo teclado e acessibilidade.
- `npm audit --audit-level=high`: aprovado; alertas existentes baixos/moderados.
- Verifier independente PASS; duas mutações rejeitadas; ver validation.md.
- `git diff --check`: aprovado. Sem aplicação de migration ou deploy remoto.
- Ambiente local: Node 24.14.1/npm 11.12.1; projeto/CI continuam fixados em
  Node 24.20.0/npm 11.19.0. Execução local não substitui o CI fixado.
