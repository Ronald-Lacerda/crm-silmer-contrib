# Cobranças: execução local e preparação da integração

## Execution Plan

T1 e a investigação de T2 podem ocorrer em paralelo; T2 integra a interface
final de T1. T3 documental é independente de T1/T2. Um dono por arquivo.
Root integra, executa gates e faz um commit/push por tarefa. Revisão final
independente com sensor em cópias isoladas, sem stash.

## Test Coverage Matrix

| Task | Criteria   | Evidence                                                                            |
| ---- | ---------- | ----------------------------------------------------------------------------------- |
| T1   | BDEV-01–03 | Gerador padrão preservado, configuração negativa, grafo DEV e expressões            |
| T2   | BDEV-03–06 | n8n real, HTTP local, API/runtime real, PostgreSQL sintético, valores/replay/falhas |
| T3   | BDEV-07    | Contrato conferido nas rotas; comandos e evidências do gate; revisão de links       |

## Gate Check Commands

- Workflow: `node --test test/billing-development-workflow.test.js test/billing-integration-workflow.test.js` e typecheck/lint/formatação.
- Runtime: testes de `billing-development` e comando local documentado com Docker, sem skips no ensaio explícito; asserts do saldo, parcelas, unicidade, recusa e recuperação.
- Documentation: conferência de links/contratos, `git diff --check`; gate integrado `npm run validate` após T1/T2 e revisão independente.

## Task Breakdown

### T0: Registrar plano de conclusão e critérios do ambiente DEV

Depends on: none
Where: docs/rfc/047-enviar-cobranca-pela-conversa.md
Tests: validate_spec, validate_tasks e revisão de fontes e dependências.
Gate: Documentation
Done when: plano distingue backend concluído, DEV, projeção API, redesign, transporte e operação real.
Status: Complete

### T1: Gerar perfil DEV do workflow financeiro compartilhado

Depends on: none
Where: ops/n8n/workflows/create-order-billing-workflow.mjs
Tests: test/billing-development-workflow.test.js e regressão do gerador padrão; recusa de destino remoto/expressões, export inativo, credenciais e paths próprios.
Gate: Workflow
Done when: BDEV-01–03 têm perfil explícito e isolado do mesmo grafo, sem relaxar produção.
Status: Complete

15/15 cenários de workflow aprovados (10 regressões e 5 DEV). Hash do export
padrão de produção preservado byte a byte. Typecheck global, lint focal e
formatação aprovados. O CLI DEV gera export inativo sem sobrescrever arquivo.
O gate de T1 executa expressões; o motor n8n real é evidência própria de T2.

### T2: Executar n8n real contra simulador e persistência financeira

Depends on: T1
Where: scripts/billing-development-smoke.mjs
Tests: n8n real/HTTP/rotas e banco, sinal3000/saldo7000, Pix/cartão3x, duplicidade, pagamento forjado/menor e falha de callback com reentrega; cleanup isolado.
Gate: Runtime
Done when: BDEV-03–06 comprovados com execução reproduzível local e fronteiras não exercitadas declaradas.
Status: Complete

Ensaio real n8n 2.38.7/rotas/runtime/worker/PostgreSQL dedicado: 9 cenários
aprovados em `var/billing-development-HlZNQJ/report.json`, com
`resourcesRemoved:true`. Sinal3000/saldo7000, Pix/cartão3x e quitação corretos;
replay sem duplicar link/pagamento, aviso não confirmado, pagamento menor,
callback com falha/reentrega e criação com resposta perdida preservada incerta.
Logs sem credenciais/URLs sintéticas; rede interna sem portas publicadas.
Cancelamento SIGINT durante startup também removeu recursos próprios
(`var/billing-development-Nhhi3j/report.json`). Unit do simulador4/4,
typecheck/lint/formatação aprovados. O transporte WhatsApp não é executado.

### T3: Preparar integração frontend e registrar operação de desenvolvimento

Depends on: none
Where: docs/api/order-billing-frontend-integration.md
Tests: contrato conferido nos handlers; links e comandos locais; evidência das tarefas técnicas após integração; revisão independente e sensor.
Gate: Documentation
Done when: BDEV-07 atendido, documentação obsoleta corrigida, plano completo e evidências distinguem entrega local de ativação e redesign.
Status: Pending
