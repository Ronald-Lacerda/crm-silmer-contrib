# Cobranças: conclusão integrada

## Execution Plan

T0 registra critérios e decisão. T1 entrega backend e contrato da consulta;
T2 entrega o workflow dedicado. T3 pode começar com contrato estabilizado;
T2/T4/T5 compartilham dono DEV. Cada arquivo
tem um dono. Tech Lead integra, documenta, executa gates e commit/push por
tarefa. T6 fecha a integração, seguida de verificação independente e sensor.

## Test Coverage Matrix

| Task | Criteria    | Evidence                                                                             |
| ---- | ----------- | ------------------------------------------------------------------------------------ |
| T0   | Todos       | spec/ADR/RFC consistentes com a autorização                                          |
| T1   | BFIN-01–08  | HTTP/PG real sintético, ACL/replay/concurrency/rollback/saldo/Financeiro e consultas |
| T2   | BFIN-06–08  | Jobs, HTTP técnico, n8n/worker e simulador, sem pagamento forjado                    |
| T3   | BFUI-01–06  | E2E real componentes/API, contratos, teclado/mobile/axe/draft                        |
| T4   | BDEV2-01/02 | n8n real transporte com sink e PostgreSQL dedicado                                   |
| T5   | BDEV2-03/04 | Subida/saúde/login/UI/cleanup do DEV interativo                                      |
| T6   | Todos       | validate, PostgreSQL, navegador, real n8n e revisão independente                     |

## Gate Check Commands

- Documents: validate_spec/validate_tasks, links e `git diff --check`.
- Backend: testes unit/HTTP e suíties PostgreSQL afetadas em banco sintético exclusivo; typecheck/lint/schema OpenAPI.
- Frontend: Playwright das novas jornadas e regressão Inbox/Pedido, axe claro/escuro desktop/390/320.
- Development: smoke real n8n financeiro/transporte e up/status/stop do DEV, sem skips no gate explícito.
- Full: `npm run validate`, gates anteriores e verificador independente com sensor em cópias isoladas.

## Task Breakdown

### T0: Registrar contrato e decisões da entrega

Depends on: none
Where: docs/adr/067-recebimentos-externos-e-conciliacao-de-cobrancas.md
Tests: validadores de spec/tasks, revisão das fontes, links/diff check.
Gate: Documents
Done when: critérios distinguem origem dos recebimentos, consulta verificada e autorização do frontend/DEV sem go-live.
Status: Complete

Master remota conferida (15edc73b, já ancestral), grafo ausente e fontes
confirmadas com rg. ADR067/RFC053 registram a autorização e os limites.
validate_spec/validate_tasks sem erros, links locais e diff check aprovados.

### T1: Registrar recebimentos externos e consultas de pagamento transacionalmente

Depends on: T0
Where: apps/api/src/order-billing-runtime.js
Tests: BFIN-01–08 HTTP/PG/worker; R$30 gateway+R$70 externos quita R$100; replay, concorrência, auditrollback, reabertura, excesso, consulta verificada e autorização.
Gate: Backend
Done when: livro externo, guardas financeiras e consultas duráveis preservam saldo, histórico e quitação nas duas fontes, com worker seguro.
Status: Complete

Migração0065 e backend completos. Gates do autor: 59/59 PostgreSQL e19/19
HTTP/worker; integrador: 69/69 PostgreSQL incluindo Financeiro e30/30
HTTP/worker/contratos, zero skips. Typecheck global, lint e diff check PASS.
Registros externos/reversões/candidatos/resultado são duráveis; notas e
identificadores cifrados. Receive-only e endpoint de consulta configurado
são independentes da emissão. Sem mutação operacional remota.

### T2: Gerar workflow dedicado para conferência de pagamento

Depends on: T1
Where: ops/n8n/workflows/create-order-billing-check-workflow.mjs
Tests: BFIN-06–08; query sem efeito financeiro novo, pago/não pago, falsificação, replay, falhas, agendamento limitado e flag de recebimento.
Gate: Backend
Done when: n8n verifica candidatos pelo contrato de T1, sem confiar em evento/usuário nem gerar link duplicado, com perfil DEV próprio.
Status: Complete

Gerador próprio de conferência com perfis produção/DEV inativos; export da
emissão permanece byte a byte preservado. Gate3/3 com comandos estritos,
consulta paga/não paga, valor insuficiente e falha de persistência sem ACK.
Typecheck/lint aprovados. Execução integrada no motor real é gateT5/T6.

### T3: Integrar cobrança no chat e pedido com o redesign atual

Depends on: T1, T2
Where: apps/edge-web/src/components/order/OrderBillingSection.vue
Tests: BFUI-01–06, cinco ações, seleção/revisão, recebimento externo/conferência/histórico, foco/draft/axe/mobile/temas.
Gate: Frontend
Done when: as duas entradas usam contratos reais compartilhados e seguem os componentes atuais, sem fixtures em produção.
Status: Pending

### T4: Executar transporte simulado completo no n8n

Depends on: T0
Where: scripts/billing-development-smoke.mjs
Tests: BDEV2-01/02; reserva/preflight/sink/callback, duplicidade, mudança de contexto, recebido antes/depois, safe retry vs unknown e flagoff.
Gate: Development
Done when: mensagem não é considerada enviada apenas por estar na outbox; transporte n8n/sink é comprovado.
Status: Pending

### T5: Disponibilizar ambiente DEV interativo isolado

Depends on: T1, T2, T4
Where: scripts/billing-development-interactive.mjs
Tests: BDEV2-03/04, API/login/UI sintéticos, rotas n8n/simulator, saúde, isolamento, stop e reset explícito.
Gate: Development
Done when: usuário pode navegar na jornada real local sem provedor/cliente real, com comandos de operação documentados.
Status: Pending

### T6: Validar e documentar a jornada integrada

Depends on: T1, T2, T3, T4, T5
Where: docs/runbooks/order-billing.md
Tests: gate Full, regressão, browser/PG/n8n e revisão independente com sensor.
Gate: Full
Done when: critérios atendidos e evidências distinguem implementação/DEV de operação remota; trabalho commitado e enviado sem ativação real.
Status: Pending
