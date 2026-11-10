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
Status: Complete

API/worker/edge implantados pelo EasyPanel a partir de87cbc435. Backup local
conferido antes;0073–0075 aplicadas,71/71expand sem divergência, replay0.
Comando original da API restaurado e redeploy conferido. Flags3false nos
processos Node de API/worker; health200, heartbeat e scanner saudáveis.
Evidências, image IDs e limites em docs/qa/order-billing-release-2026-11-09.md.

### T4: Vincular credencial InfinitePay e fechar conferência técnica

Depends on: T2, T3
Where: docs/qa/order-billing-production-preparation-2026-11-08.md
Tests: BREL-04/05; usuário cadastra segredo, referências privadas corretas, leituras autorizadas sem efeitos financeiros.
Gate: Credentials
Done when: referências conferidas e condições restantes de ativação e ensaio real explicitadas antes de pedir autorização específica.
Status: Complete

O proprietário cadastrou/salvou a chave pessoalmente. Os três nós do provedor
usam a mesma credencial Header Auth, e cada workflow conserva cinco Basic.
Export final comprova19/11nós inativos, parâmetros/conexões/settings exatos e
retenção desligada. Atendimento publicado conserva versão7b78d0b9 de06/11;
rascunho restaurado com141nós exatos. Guard humano, publicação coordenada e
homologação real permanecem condições da futura ativação, fora do veredito de
implantação desligada. Não houve ensaio financeiro nem prova de autenticação
ponta a ponta por simples vínculo de credenciais. Ver validation.md e relatório
de preparação atualizado em09/11.

### T5: Publicar a proteção no workflow humano

Depends on: T4
Where: ops/n8n/billing-send-preflight.mjs
Tests: BREL-06/04, BAPI-07/09/10; patch focal, comparação independente do export real,141nós originais exatos, três novos nós e grafo de falhas, versão publicada e flagsfalse.
Gate: HumanPreflight
Done when: proteção publicada no atendimento, artefato reexportado conferido e nenhum ensaio financeiro executado.
Status: Complete

Publicada versão9157724a do atendimento às23:06:25 de09/11.141nós originais
inteiramente exatos e três novos; comparação independente do export publicado
PASS, sete arestas adicionadas/uma removida.24testes focais aprovados e seis
mutações perigosas recusadas pelo comparador. Flagsfalse antes/depois em
API/worker; health200, tabelas/fila billing vazias. Sem execução financeira.
Evidência em docs/qa/order-billing-human-guard-2026-11-09.md.

### T6: Preparar a ativação coordenada sem habilitá-la

Depends on: T5
Where: docs/runbooks/order-billing-activation.md
Tests: BREL-07/04/05; sequência de publicação/recebimento/emissão/envio, filas pendentes, rollback sem apagar histórico, flags efetivasfalse e workflows financeiros inativos.
Gate: ActivationPreparation
Done when: runbook e revisão independente registram prontidão técnica limitada e condições anteriores ao ensaio real, sem efetuar a ativação.
Status: Complete

Runbook order-billing-activation.md preparado e revisto independentemente
contra API/worker: webhooks antes das flags, recebimento antes da emissão e
envio por último, com autorização própria. Inclui filas pendentes, limite do
piloto operacional, receive-only e recuperação sem apagar histórico. Flags
continuamfalse; workflows financeiros19/11nós inativos e sem drift. Veredito
T5/T6 PASS limitado em validation-activation-preparation.md; nenhuma ativação
ou homologação financeira foi inferida.
