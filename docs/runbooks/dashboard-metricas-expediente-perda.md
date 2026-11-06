# Runbook — Métricas de expediente e lead perdido (ACT-T04)

Decisão: [ADR 061](../adr/061-metricas-de-expediente-perda-e-presenca.md).
Requisitos: MET-01–08 e MET-12 em
[dashboard-actions/spec.md](../../.specs/features/dashboard-actions/spec.md).
Presença e R$ por hora (MET-09–11) estão em backlog e não fazem parte desta
entrega.

## O que entra

- Migração `0061_business_hours_metrics.expand.sql`: funções
  `crm.business_minutes_v1` e `crm.business_deadline_v1` (expediente-v1:
  seg–sex, 09–12 e 13–18, America/Sao_Paulo) e índices
  `messages_human_reply_clock_idx` e `handoffs_*`.
- Migração `0062_lead_outcomes.expand.sql`: tabela imutável
  `crm.lead_outcome_events`.
- Endpoints: `GET /api/v1/dashboard/metrics/service`,
  `GET /api/v1/dashboard/metrics/losses`,
  `POST|GET /api/v1/conversations/:id/lead-outcome`.
- A central de ações sugere retomada após 72h (antes 48h) e deixa de mostrar
  retomada e lembrete de conversa com perda ativa.

A interface ainda não consome os endpoints novos; ela chega numa fatia
posterior.

## Aplicar em produção

1. Escolha um horário fora do pico de atendimento. Os `CREATE INDEX` da 0061
   não usam `CONCURRENTLY` (o executor roda cada migração numa transação) e
   bloqueiam escrita em `crm.messages` e `crm.handoffs` enquanto o índice é
   criado: mensagens recebidas e envios esperam alguns segundos.
2. Depois do deploy do `master`, no console do `silmer-api`, rode
   `node modules/database/src/cli.js` e confira `applied_count` igual a 2.
   Sem isso, Dashboard e Pedidos respondem "indisponível" (erro `42P01`).
3. Verifique com uma sessão de administrador:
   - `GET /api/v1/dashboard/metrics/service?days=7` responde 200 com
     `scope: "team"` e `businessHours.policy: "expediente-v1"`;
   - `GET /api/v1/dashboard/metrics/losses?days=7` responde 200 com
     `totals`;
   - com uma sessão de vendedor, as duas respostas trazem `scope: "self"` e
     uma única linha.

## Sinais de problema

- 503 em `metrics/service`: a consulta passou do limite de 5 s
  (`statement_timeout`). Meça o volume de `crm.messages` e avise o time;
  o resto do Dashboard continua funcionando.
- 409 `LEAD_AWAITING_REPLY` frequente: o vendedor tenta marcar perda com
  mensagem do cliente sem resposta. É o comportamento esperado; oriente a
  responder antes de marcar.

## Reverter

As migrações são só de expansão. Para reverter, volte o deploy do código: os
endpoints somem e a central volta a 48h. As funções, os índices e a tabela
podem ficar no banco sem efeito. Não apague `crm.lead_outcome_events`: ela é
histórico auditável e tem bloqueio de `UPDATE`, `DELETE` e `TRUNCATE`.

## Privacidade

O texto livre do motivo "outro" é cifrado com `N8N_INTEGRATION_ENVELOPE_KEY`
e nunca aparece em logs, auditoria, idempotência ou agregações. Só o
responsável atual pela conversa e administradores o leem, pelo `GET` de
detalhe.
