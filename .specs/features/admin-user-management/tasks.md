# Gestão de Usuários pelo Administrador — Tarefas

## Evolução aprovada, ainda não implementada — Financeiro

A evolução de ROLE-01/02/04 e USR-02 para admitir Financeiro sem herdar
permissões de Vendedor está em [FINQ-T01](../financeiro/tasks.md), ligada a
[FINQ-01–03](../financeiro/spec.md) e à
[ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md).
A tarefa permanece aberta; as tarefas AUM e evidências históricas abaixo não
comprovam a existência do novo perfil. Preservar ROLE-03 e o handoff Vendedor,
os controles administrativos e o design já estabelecido.

> **Branch:** `feat/admin-user-management`
> **Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)
> **Atualizado em:** 09/09/2026

`[P]` marca tarefas que podem correr em paralelo com as suas irmãs do mesmo bloco.
Gate padrão de qualquer tarefa: `npm run lint && npm run typecheck`. Os gates
específicos abaixo se somam a esse.

## Bloco 1 — Banco

### AUM-01 — Migration expand do papel único

- **O quê:** coluna `name` em `crm.users`, migração de `Atendimento` para `Vendedor` em `user_functions`, `handoffs` e `handoff_history`, remoção das capacidades de privacidade e troca das constraints.
- **Onde:** `modules/database/migrations/0017_identity_single_role.expand.sql`
- **Depende de:** —
- **Reutiliza:** o padrão de drop/recreate do trigger `handoff_history_immutable` do `0013_n8n_integration.expand.sql`.
- **Pronto quando:** a migration aplica em banco com dados legados de `Atendimento` e de capacidades de privacidade, e uma tentativa de inserir `Atendimento` é rejeitada.
- **Atenção:** conferir os nomes reais das constraints do `0002` antes de escrever cada `DROP CONSTRAINT` — várias foram declaradas inline e receberam nome automático.
- **Testes:** `test/phase1-schema-live.test.js` cobre as novas constraints.
- **Gate:** `npm run test:database` e, com `TEST_DATABASE_URL`, `npm run test:phase1-schema:live`
- **Requisitos:** ROLE-01, ROLE-02, ROLE-03, ROLE-05

## Bloco 2 — Domínio

### AUM-02 — Reduzir papéis e capacidades

- **O quê:** `CAPABILITIES` fica só com `COMMERCIAL_ADMIN`; remover as entradas `privacy.legal-hold.authorize` e `privacy.retention.execute` de `actionCapabilities`; teste de função operacional vira `actor.functionName === 'Vendedor'`; `FUNCTIONS` vira `Set(['Vendedor'])`; atualizar os `@typedef` nos quatro arquivos do módulo.
- **Onde:** `modules/identity-access/src/{authorization.js,index.js,postgres.js,postgres-access.js,postgres-operational-user-port.js}`
- **Depende de:** AUM-01
- **Pronto quando:** nenhum arquivo de `modules/identity-access/src/` menciona `Atendimento`, `PRIVACY_OFFICER` ou `TECHNICAL_PRIVACY_EXECUTOR`.
- **Testes:** unitários de `authorize` — ator `Vendedor` passa nas ações operacionais; ator com capacidade inexistente é negado.
- **Gate:** `npm test`
- **Requisitos:** ROLE-04, ROLE-05

### AUM-03 — Remover o convite do domínio

- **O quê:** apagar `createInvitation` e `acceptInvitation` do serviço, `createInvitation`/`consumeInvitation` do port `IdentityRepository` e o `Map` de invitations do repositório em memória; remover o `@typedef IdentityInvitation`.
- **Onde:** `modules/identity-access/src/index.js`, `postgres.js`
- **Depende de:** AUM-02
- **Pronto quando:** `grep -rn "nvitation" modules/` não retorna nada.
- **Testes:** os testes existentes que exercitam convite são removidos nesta tarefa, não adaptados.
- **Gate:** `npm test`
- **Requisitos:** INV-03

### AUM-04 — Senha sem comprimento mínimo `[P]`

- **O quê:** `hashPassword` deixa de exigir 16 caracteres e passa a rejeitar apenas valor que não seja string não vazia.
- **Onde:** `modules/identity-access/src/index.js`
- **Depende de:** AUM-02
- **Pronto quando:** `hashPassword('a')` produz um hash Argon2id válido e `hashPassword('')` lança.
- **Testes:** unitário do par hash/verify com senha de 1 caractere.
- **Gate:** `npm test`
- **Requisitos:** USR-05

### AUM-05 — Operações de usuário no serviço

- **O quê:** `createOperationalUser`, `updateUser`, `listUsers`, `setUserDisabled`, todas exigindo `COMMERCIAL_ADMIN` do ator e emitindo auditoria na mesma transação; as queries correspondentes no repositório PostgreSQL e no repositório em memória.
- **Onde:** `modules/identity-access/src/index.js`, `postgres.js`
- **Depende de:** AUM-03, AUM-04
- **Reutiliza:** `PostgresAuditTrail`, o padrão de `freezeUser`, o índice `users_email_lower_unique`.
- **Pronto quando:** as quatro operações funcionam contra o repositório em memória e contra PostgreSQL; `updateUser` sem `password` preserva o hash atual; o evento de auditoria não contém senha nem hash.
- **Testes:** unitários das quatro operações, incluindo negação para ator sem capacidade e atualização parcial.
- **Gate:** `npm test`
- **Requisitos:** USR-01, USR-02, USR-04, USR-06, USR-07, USR-09

## Bloco 3 — Consumidores

### AUM-06 — Propagar `Vendedor` nos módulos consumidores

- **O quê:** trocar toda comparação `['Atendimento','Vendedor']` por `'Vendedor'` e fixar `targetRole` de handoff em `'Vendedor'`.
- **Onde:** `deals-pipeline/src/application/{deal-command-service.js:215,deal-conversion-service.js:146}`, `qualification/src/qualification-service.js:346`, `inbox-channels/src/application/inbox-service.js:161`, `contacts/src/domain/identity.js:8`, `work-management/src/{in-memory-work-management-repository.js,postgres-work-management-repository.js}`, `n8n-integration/src/postgres-repository.js:977`
- **Depende de:** AUM-01
- **Pronto quando:** `grep -rn "Atendimento" --exclude-dir=node_modules --exclude-dir=graphify-out .` só retorna documentação histórica (`docs/phase0/`, `.specs/features/crm-mvp/`) e nenhum arquivo executável.
- **Testes:** suítes existentes de deals, qualification, inbox e work-management passam sem adaptação de papel.
- **Gate:** `npm test` e, com `TEST_DATABASE_URL`, `npm run test:deal:live`
- **Requisitos:** ROLE-03, ROLE-04

## Bloco 4 — API

### AUM-07 — Rotas de gestão de usuários

- **O quê:** `GET /api/v1/users`, `POST /api/v1/users`, `PATCH /api/v1/users/:id`, `POST /api/v1/users/:id/disable`, `POST /api/v1/users/:id/enable`, com os métodos correspondentes no runtime.
- **Onde:** `apps/api/src/identity-routes.js`, `identity-runtime.js`
- **Depende de:** AUM-05
- **Reutiliza:** `requireAuthenticatedCommand`, `executeIdempotent`, `respond`, `publicErrorCode`.
- **Pronto quando:** as cinco rotas respondem; não-admin recebe `403`; a mesma `idempotency-key` repetida não aplica o efeito duas vezes; nenhuma resposta contém a senha em claro; e-mail duplicado retorna `409` distinguível de reuso de chave de idempotência.
- **Testes:** `test/identity-api.test.js` e `test/identity-api-live.test.js`.
- **Gate:** `npm test` e, com `TEST_DATABASE_URL`, `npm run test:identity:live`
- **Requisitos:** USR-01 a USR-04, USR-06 a USR-09, USR-11

### AUM-08 — Remover as rotas de convite e exigir `name` no bootstrap

- **O quê:** apagar `POST /api/v1/invitations` e `POST /api/v1/invitations/accept` e os métodos `createInvitation`/`acceptInvitation` do runtime; `bootstrap` passa a exigir `name`.
- **Onde:** `apps/api/src/identity-routes.js`, `identity-runtime.js`
- **Depende de:** AUM-07
- **Pronto quando:** as duas rotas antigas respondem `404` e o bootstrap recusa requisição sem `name`.
- **Testes:** `test/identity-api.test.js`.
- **Gate:** `npm test`
- **Requisitos:** INV-01, BOOT-03

## Bloco 5 — Frontend

### AUM-09 — Tela de acesso sem convite `[P]`

- **O quê:** remover a aba de convite, o `role="tablist"`, `selectTab`, `handleTabKey` e `submitInvite`; deixar só o formulário de login e tirar o `minlength` do campo de senha.
- **Onde:** `apps/edge-web/src/components/AuthPanel.vue`
- **Depende de:** AUM-08
- **Pronto quando:** a tela pública mostra só o login e o painel mantém o cabeçalho acessível apontando para o título visível.
- **Testes:** `test/e2e/foundation.spec.js`.
- **Gate:** `npm run check:design-tokens && npm run lint`
- **Requisitos:** INV-02, USR-05

### AUM-10 — Tela de usuários

- **O quê:** `UsersView.vue` com visão geral em tabela, formulário de criação na coluna lateral, painel de entrega com bloco markdown e botão copiar, diálogo de edição e ações de desativar/reativar; rota `/usuarios`; item de navegação e rota condicionados a `COMMERCIAL_ADMIN`.
- **Onde:** `apps/edge-web/src/views/UsersView.vue`, `router.js`, `App.vue`, `screen-styles.css`
- **Depende de:** AUM-07
- **Reutiliza:** `.surface`, `.data-table`, `.badge`, `.page-heading`, `.button-row` e os tokens de `tokens.css`; as pranchas do artefato "Usuários do CRM Silmer" são a referência visual.
- **Pronto quando:** um administrador cria, edita, desativa e reativa contas pela tela; o markdown é montado no cliente; um não-admin não vê o item de navegação e é redirecionado ao acessar `/usuarios` direto.
- **Testes:** `test/e2e/foundation.spec.js` cobrindo criar vendedor, copiar o bloco e entrar com a conta criada.
- **Gate:** `npm run check:design-tokens && npm run test:e2e`
- **Requisitos:** USR-01 a USR-04, USR-06, USR-08

## Bloco 6 — Scripts e contrato

### AUM-11 — Script de criação do administrador `[P]`

- **O quê:** `scripts/create-admin.mjs` recebendo nome, e-mail e senha, gravando direto no PostgreSQL com hash Argon2id, função `Vendedor` e capacidade `COMMERCIAL_ADMIN`.
- **Onde:** `scripts/create-admin.mjs`
- **Depende de:** AUM-01
- **Reutiliza:** `hashPassword` de `@crm-silmer/identity-access`, a conexão de `@crm-silmer/database`.
- **Pronto quando:** cria o administrador em banco vazio e falha com mensagem clara para e-mail já existente, sem alterar a conta existente.
- **Testes:** teste de integração live que roda o script duas vezes.
- **Gate:** `npm run lint` e, com `TEST_DATABASE_URL`, o teste live do script
- **Requisitos:** BOOT-01, BOOT-02

### AUM-12 — Seed de desenvolvimento sem convite `[P]`

- **O quê:** reescrever o seed para criar as contas locais pela rota de criação de usuário; remover as contas de atendimento e de privacidade da lista.
- **Onde:** `scripts/seed-dev-users.mjs`
- **Depende de:** AUM-07
- **Pronto quando:** `npm run dev` roda duas vezes seguidas sem erro e sem duplicar contas.
- **Testes:** execução manual dupla.
- **Gate:** `npm run lint`
- **Requisitos:** INV-04

### AUM-13 — Contrato OpenAPI `[P]`

- **O quê:** remover os caminhos de convite e seus schemas; adicionar os cinco caminhos de `/users`; enums viram `[Vendedor]` e `[COMMERCIAL_ADMIN]`; `name` entra no schema de bootstrap.
- **Onde:** `docs/api/openapi.v1.yaml`
- **Depende de:** AUM-08
- **Pronto quando:** o arquivo não menciona convite, `Atendimento` nem as capacidades de privacidade, e descreve as cinco rotas novas.
- **Gate:** `npm run validate:security-catalog`
- **Requisitos:** ROLE-05, INV-01

## Bloco 7 — Fechamento

### AUM-14 — Suíte de testes

- **O quê:** reescrever os testes que exercitam convite ou `Atendimento` e acrescentar a cobertura nova listada no design.
- **Onde:** `test/identity-api.test.js`, `identity-api-live.test.js`, `identity-session.test.js`, `identity-postgres-live.test.js`, `phase1-schema-live.test.js`, `test/e2e/foundation.spec.js`
- **Depende de:** AUM-10, AUM-12, AUM-13
- **Pronto quando:** `npm run validate` passa inteiro.
- **Gate:** `npm run validate` e, com `TEST_DATABASE_URL`, `npm run test:identity:live`
- **Requisitos:** todos

### AUM-15 — Migration contract

- **O quê:** `DROP TABLE crm.invitations`.
- **Onde:** `modules/database/migrations/0018_remove_invitations.contract.sql`
- **Depende de:** AUM-14
- **Pronto quando:** aplicada com `npm run db:migrate -- --phase contract` e a tabela não existe mais.
- **Gate:** `npm run test:phase1-schema:live`
- **Requisitos:** INV-03

### AUM-16 — Fechamento do repositório

- **O quê:** commit atômico por bloco, push da branch, PR, e `graphify update .` para o grafo refletir o estado novo.
- **Depende de:** AUM-15
- **Gate:** `npm run validate`

### AUM-17 — Exclusão segura de contas sem histórico

- **O quê:** expor `canDelete` na lista de contas e adicionar `DELETE /api/v1/users/:id`, protegido por sessão, CSRF, idempotência e `COMMERCIAL_ADMIN`. A conta é excluída somente quando não tem histórico operacional; administradores nunca podem ser excluídos. A tela usa menu de ações e confirma a exclusão destrutiva.
- **Onde:** `modules/identity-access/src/{index.js,postgres.js}`, `apps/api/src/{identity-routes.js,identity-runtime.js}`, `apps/edge-web/src/views/UsersView.vue`, `docs/api/openapi.v1.yaml`.
- **Pronto quando:** vendedor novo pode ser removido; vendedor ligado a atendimento, handoff ou histórico recebe `409 USER_HAS_HISTORY`; administrador não recebe ação de exclusão nem pode ser excluído por chamada direta.
- **Testes:** `test/identity-session.test.js`, `test/identity-api.test.js`, `test/e2e/users-admin.spec.js`.
- **Gate:** `npm run validate`.
- **Requisitos:** USR-12.

## Rastreabilidade

| Requisito        | Tarefas                                                |
| ---------------- | ------------------------------------------------------ |
| ROLE-01, ROLE-02 | AUM-01                                                 |
| ROLE-03          | AUM-01, AUM-06                                         |
| ROLE-04          | AUM-02, AUM-06                                         |
| ROLE-05          | AUM-01, AUM-02, AUM-13                                 |
| BOOT-01, BOOT-02 | AUM-11                                                 |
| BOOT-03          | AUM-08                                                 |
| BOOT-04          | nenhuma — comportamento preservado, coberto por AUM-14 |
| USR-01 a USR-04  | AUM-05, AUM-07, AUM-10                                 |
| USR-05           | AUM-04, AUM-09                                         |
| USR-06           | AUM-05, AUM-07, AUM-10                                 |
| USR-07           | AUM-05, AUM-07                                         |
| USR-08           | AUM-05, AUM-07, AUM-10                                 |
| USR-09           | AUM-05                                                 |
| USR-10           | nenhuma — decisão de não fazer, registrada na spec     |
| USR-11           | AUM-07                                                 |
| USR-12           | AUM-17                                                 |
| INV-01           | AUM-08, AUM-13                                         |
| INV-02           | AUM-09                                                 |
| INV-03           | AUM-03, AUM-15                                         |
| INV-04           | AUM-12                                                 |

## Situação

| Tarefa          | Situação                                        |
| --------------- | ----------------------------------------------- |
| AUM-01 a AUM-15 | Concluída                                       |
| AUM-16          | Commits e `graphify update` feitos; PR pendente |
| AUM-17          | Concluída                                       |

### O que ainda não foi executado contra um banco real

`npm run validate` passa inteiro (formatação, tipos, lint, fronteiras, tokens,
os 13 validadores, 395 testes e o build) e os 21 testes Playwright passam. O que
**não** foi verificado nesta máquina, por falta de `TEST_DATABASE_URL`:

- As migrations `0017` (expand) e `0018` (contract) nunca foram aplicadas.
- As suítes live: `npm run test:identity:live`, `npm run test:deal:live`,
  `npm run test:phase1-schema:live`.

Antes de promover, rodar contra um banco com dados legados de `Atendimento` e
capacidades de privacidade — é exatamente o caminho que o `0017` migra, e o
único jeito de confirmar que os nomes das constraints derrubadas conferem.

### Perda de cobertura assumida

Duas asserções de `test/work-management.test.js` foram removidas em vez de
adaptadas: cobriam handoff para papel incompatível e claim por papel
incompatível. Com `Vendedor` como única função operacional, o cenário deixou de
ser construível.
