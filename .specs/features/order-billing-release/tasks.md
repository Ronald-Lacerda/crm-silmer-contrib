# Implantação de cobranças

## Execution Plan

T1 integra e valida a master. T2 abre/revisa PR, acompanha CI e integra pelo
mantenedor antes da release. T3 confere recuperação, implanta e migra com
flags desligadas. T4 vincula a chave cadastrada pelo usuário e encerra as
leituras técnicas, sem ensaio financeiro. Falhas não autorizam bypass de gate.

## Test Coverage Matrix

| Task | Criteria   | Evidence                                                      |
| ---- | ---------- | ------------------------------------------------------------- |
| T1   | BREL-01/04 | upgrade PG, filas Olist, cancelamento, E2E real/ACL, validate |
| T2   | BREL-02/04 | PR/CI/merge e fonte recuperável                               |
| T3   | BREL-03/04 | backup, checksums, health e flags remotas                     |
| T4   | BREL-04/05 | credencial privada, referências e estado inativo              |

## Gate Check Commands

- Integration: npm run validate, PostgreSQL billing/cancelamento/Olist/upgrade, E2E billing/Pedido/Inbox, npm audit e git diff check.
- Release: checks do PR, histórico linear, revisão independente e versão anterior recuperável.
- Deployment: backup/space/flags, CLI expand da release, SELECT read-only de versões/checksums, health live/ready e UI privada sem comandos financeiros.
- Credentials: export privado sem valores de segredo, referências corretas, emissão/envios desligados e entrada pessoal do proprietário.

## Task Breakdown

### T1: Integrar feature com a master vigente (COB-REL-01)

Depends on: none
Where: modules/database/migrations/0075_billing_external_receipts_and_checks.expand.sql
Tests: BREL-01/04, upgrade master→billing, constraints preservadas, cancelamento antes da admissão/reserva/callback e histórico readonly, E2E/gates integrados.
Gate: Integration
Done when: código preserva master e provas demonstram compatibilidade antes de qualquer implantação.
Status: Complete

Rebase sobre0ed44bd3 concluído, com cópia local recuperável da branch anterior.
Migrações inéditas0073–0075 e ADR076/077/RFC060 eliminam colisões sem modificar
os70arquivosSQL da master. Constraints da fila preservam jobsOlist. Pedidos
cancelados recusam novas cobranças/preflight e mantêm recibos/histórico em
leitura; travaOlist não bloqueia recebimento externo.

Gates: PostgreSQL64/64 zero skips, E2E55/55 zero skips, validate2418 aprovados
com52skips condicionais e0falhas; typecheck/lint/formato/build aprovados.
CI inclui as suítes completion e upgrade. Revisão independente de integração
é registrada em validation-integration.md antes da decisão de merge.

### T2: Integrar PR e identificar a release recuperável

Depends on: T1
Where: .github/workflows/ci.yml
Tests: BREL-02/04; checks, revisão independente, merge linear e identificação da imagem/fonte anterior.
Gate: Release
Done when: release aprovada e caminho de recuperação concreto registrados.
Status: Complete

PR333 integrado pelo mantenedor com rebase em87cbc435, após cinco checks
aprovados no HEADe5e65af9. As árvores são idênticas. A fonte anterior0ed44bd3
e o image ID anterior registrado no EasyPanel estão identificados em
validation-release.md. Não houve bypass dos gates nem merge commit.

### T3: Implantar a aplicação e executar migrações expand

Depends on: T2
Where: docs/runbooks/order-billing.md
Tests: BREL-03/04; backup/capacidade, migrações da release/checksums, health e flags nos processos.
Gate: Deployment
Done when: versão compatível e banco conferidos em produção, sem emissão/envio.
Status: Pending

### T4: Vincular credencial InfinitePay e fechar conferência técnica

Depends on: T2, T3
Where: docs/qa/order-billing-production-preparation-2026-11-08.md
Tests: BREL-04/05; usuário cadastra segredo, referências privadas corretas, leituras autorizadas sem efeitos financeiros.
Gate: Credentials
Done when: referências conferidas e pendência exclusiva do ensaio real explicitada antes de pedir autorização específica.
Status: Pending
