# CobranÃ§as: conclusÃ£o integrada

## Execution Plan

T0 registra critÃ©rios e decisÃ£o. T1 entrega backend e contrato da consulta;
T2 entrega o workflow dedicado. T3 pode comeÃ§ar com contrato estabilizado;
T2/T4/T5 compartilham dono DEV. Cada arquivo
tem um dono. Tech Lead integra, documenta, executa gates e commit/push por
tarefa. T6 fecha a integraÃ§Ã£o, seguida de verificaÃ§Ã£o independente e sensor.

## Test Coverage Matrix

| Task | Criteria    | Evidence                                                                             |
| ---- | ----------- | ------------------------------------------------------------------------------------ |
| T0   | Todos       | spec/ADR/RFC consistentes com a autorizaÃ§Ã£o                                          |
| T1   | BFIN-01â€“08  | HTTP/PG real sintÃ©tico, ACL/replay/concurrency/rollback/saldo/Financeiro e consultas |
| T2   | BFIN-06â€“08  | Jobs, HTTP tÃ©cnico, n8n/worker e simulador, sem pagamento forjado                    |
| T3   | BFUI-01â€“06  | E2E real componentes/API, contratos, teclado/mobile/axe/draft                        |
| T4   | BDEV2-01/02 | n8n real transporte com sink e PostgreSQL dedicado                                   |
| T5   | BDEV2-03/04 | Subida/saÃºde/login/UI/cleanup do DEV interativo                                      |
| T6   | Todos       | validate, PostgreSQL, navegador, real n8n e revisÃ£o independente                     |

## Gate Check Commands

- Documents: validate_spec/validate_tasks, links e `git diff --check`.
- Backend: testes unit/HTTP e suÃ­ties PostgreSQL afetadas em banco sintÃ©tico exclusivo; typecheck/lint/schema OpenAPI.
- Frontend: Playwright das novas jornadas e regressÃ£o Inbox/Pedido, axe claro/escuro desktop/390/320.
- Development: smoke real n8n financeiro/transporte e up/status/stop do DEV, sem skips no gate explÃ­cito.
- Full: `npm run validate`, gates anteriores e verificador independente com sensor em cÃ³pias isoladas.

## Task Breakdown

### T0: Registrar contrato e decisÃµes da entrega

Depends on: none
Where: docs/adr/067-recebimentos-externos-e-conciliacao-de-cobrancas.md
Tests: validadores de spec/tasks, revisÃ£o das fontes, links/diff check.
Gate: Documents
Done when: critÃ©rios distinguem origem dos recebimentos, consulta verificada e autorizaÃ§Ã£o do frontend/DEV sem go-live.
Status: Complete

Master remota conferida (15edc73b, jÃ¡ ancestral), grafo ausente e fontes
confirmadas com rg. ADR067/RFC053 registram a autorizaÃ§Ã£o e os limites.
validate_spec/validate_tasks sem erros, links locais e diff check aprovados.

### T1: Registrar recebimentos externos e consultas de pagamento transacionalmente

Depends on: T0
Where: apps/api/src/order-billing-runtime.js
Tests: BFIN-01â€“08 HTTP/PG/worker; R$30 gateway+R$70 externos quita R$100; replay, concorrÃªncia, auditrollback, reabertura, excesso, consulta verificada e autorizaÃ§Ã£o.
Gate: Backend
Done when: livro externo, guardas financeiras e consultas durÃ¡veis preservam saldo, histÃ³rico e quitaÃ§Ã£o nas duas fontes, com worker seguro.
Status: Complete

MigraÃ§Ã£o0065 e backend completos. Gates do autor: 59/59 PostgreSQL e19/19
HTTP/worker; integrador: 69/69 PostgreSQL incluindo Financeiro e30/30
HTTP/worker/contratos, zero skips. Typecheck global, lint e diff check PASS.
Registros externos/reversÃµes/candidatos/resultado sÃ£o durÃ¡veis; notas e
identificadores cifrados. Receive-only e endpoint de consulta configurado
sÃ£o independentes da emissÃ£o. Sem mutaÃ§Ã£o operacional remota.

### T2: Gerar workflow dedicado para conferÃªncia de pagamento

Depends on: T1
Where: ops/n8n/workflows/create-order-billing-check-workflow.mjs
Tests: BFIN-06â€“08; query sem efeito financeiro novo, pago/nÃ£o pago, falsificaÃ§Ã£o, replay, falhas, agendamento limitado e flag de recebimento.
Gate: Backend
Done when: n8n verifica candidatos pelo contrato de T1, sem confiar em evento/usuÃ¡rio nem gerar link duplicado, com perfil DEV prÃ³prio.
Status: Complete

Gerador prÃ³prio de conferÃªncia com perfis produÃ§Ã£o/DEV inativos; export da
emissÃ£o permanece byte a byte preservado. Gate3/3 com comandos estritos,
consulta paga/nÃ£o paga, valor insuficiente e falha de persistÃªncia sem ACK.
Typecheck/lint aprovados. ExecuÃ§Ã£o integrada no motor real Ã© gateT5/T6.

### T3: Integrar cobranÃ§a no chat e pedido com o redesign atual

Depends on: T1, T2
Where: apps/edge-web/src/components/order/OrderBillingSection.vue
Tests: BFUI-01â€“06, cinco aÃ§Ãµes, seleÃ§Ã£o/revisÃ£o, recebimento externo/conferÃªncia/histÃ³rico, foco/draft/axe/mobile/temas.
Gate: Frontend
Done when: as duas entradas usam contratos reais compartilhados e seguem os componentes atuais, sem fixtures em produÃ§Ã£o.
Status: Complete

Workspace financeiro real compartilhado na Inbox/Pedido. Gate HEAD51/51
aprovado (13 novos,17 Pedido,8 rascunho,13 frete), sem skips. Temas reais
claro/escuro,1440/390/320, axe, CTA legÃ­vel, foco/teclado/Escape e rascunho
verificados. RevisÃ£o independente preliminar corrigiu reconsulta apÃ³s409 e
reversÃ£o de externo em revisÃ£o. Loading/foco de sucesso tÃªm cenÃ¡rio prÃ³prio.
Typecheck/lint/design-tokens PASS. Sem fixture no runtime da aplicaÃ§Ã£o.

### T4: Executar transporte simulado completo no n8n

Depends on: T0
Where: scripts/billing-development-smoke.mjs
Tests: BDEV2-01/02; reserva/preflight/sink/callback, duplicidade, mudanÃ§a de contexto, recebido antes/depois, safe retry vs unknown e flagoff.
Gate: Development
Done when: mensagem nÃ£o Ã© considerada enviada apenas por estar na outbox; transporte n8n/sink Ã© comprovado.
Status: Complete

Motor n8n real aprovou17 cenÃ¡rios financeiros/transporte no relatÃ³rio
`var/billing-development-M5xsI8/report.json`, com `resourcesRemoved:true`.
Reserva/preflight/sent/delivered e sink local, cinco aÃ§Ãµes, saldo enviado,
retry seguro, unknown sem retry, proprietÃ¡rio/pagamento alterados, flag off
e correÃ§Ã£o com recebimento tardio foram exercitados. Nenhum WhatsApp real.

### T5: Disponibilizar ambiente DEV interativo isolado

Depends on: T1, T2, T4
Where: scripts/billing-development-interactive.mjs
Tests: BDEV2-03/04, API/login/UI sintÃ©ticos, rotas n8n/simulator, saÃºde, isolamento, stop e reset explÃ­cito.
Gate: Development
Done when: usuÃ¡rio pode navegar na jornada real local sem provedor/cliente real, com comandos de operaÃ§Ã£o documentados.
Status: Complete

DEV interativo disponÃ­vel em127.0.0.1:4180 e editor n8n5685; contas sintÃ©ticas
com sessÃ£o/CSRF reais. Probe de emissÃ£o/entrega/conciliaÃ§Ã£o sem webhook,
externo7000/reversÃ£o PASS (`var/billing-interactive-smoke-result.json`).
Stop/up preservou banco, simulador e workflows; reentrega nÃ£o duplicou crÃ©dito
(`var/billing-interactive-restart-result.json`). Unit DEV15/15, typecheck/lint
e formato PASS. Reset exige flag explÃ­cita e projeto fixo; nÃ£o foi executado
sobre o ambiente mantido para avaliaÃ§Ã£o. Nenhum recurso de outro projeto alterado.

### T6: Validar e documentar a jornada integrada

Depends on: T1, T2, T3, T4, T5
Where: docs/runbooks/order-billing.md
Tests: gate Full, regressÃ£o, browser/PG/n8n e revisÃ£o independente com sensor.
Gate: Full
Done when: critÃ©rios atendidos e evidÃªncias distinguem implementaÃ§Ã£o/DEV de operaÃ§Ã£o remota; trabalho commitado e enviado sem ativaÃ§Ã£o real.
Status: Pending

### T7: Corrigir seleção de pedido direto e foco após recebimento

Depends on: T3
Where: apps/edge-web/src/components/inbox/ConversationBillingAction.vue
Tests: BFUI-01/06, pedido diretamente vinculado sem Assunto, seleção explícita, vazio real e foco após POST.
Gate: Frontend
Done when: vínculo direto participa da seleção sem inferência de destino, foco aguarda fechamento nativo e texto de quitação inclui as duas origens.
Status: Complete

Gate atualizado: 15/15 novos E2E e38/38 regressões Pedido/rascunho/frete, sem skips; typecheck/lint/diff aprovados. Jornada real local confirmou recuperação sem webhook e quitação mista30+70, sem provedor externo.
