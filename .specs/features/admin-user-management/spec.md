# Gestão de Usuários pelo Administrador — Requisitos Rastreáveis

## Emenda planejada — Financeiro (21/10/2026)

A [ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md) aprova
[FINQ-01–03](../financeiro/spec.md), sem implementar o perfil nesta entrega.
Na futura [FINQ-T01](../financeiro/tasks.md), ROLE-01/02/04 e USR-02 passam a
admitir Financeiro com autorização própria, sem herdar Vendedor nem conceder
`COMMERCIAL_ADMIN`. Admin continuará criando e mantendo contas; histórico
financeiro impedirá exclusão destrutiva. ROLE-03 não muda: somente Vendedor é
alvo ou participante elegível de handoff. Não reintroduzir Atendimento ou
capacidades de privacidade aposentadas.

Até essa implementação, as constraints e a política executáveis continuam
com a função única Vendedor descrita abaixo. O registro desta evolução não
concede acesso nem cria conta real, e não autoriza redesenhar a gestão de
usuários: usar o design e os componentes vigentes.

## Problema

O acesso ao CRM hoje depende de um fluxo de convite em duas etapas: o administrador emite um convite e a pessoa convidada resgata o token para criar a própria senha. Para a operação atual da Silmer isso é cerimônia sem contrapartida — não há e-mail transacional para entregar o token, o convite expira, e o administrador não tem visibilidade de quem existe no sistema. O modelo de papéis também carrega funções que a operação não usa (`Atendimento`) e capacidades de privacidade que nenhum código chama.

O que a operação precisa é direto: um administrador criado fora da aplicação, uma tela onde ele cria e mantém contas de vendedores com nome, e-mail e senha, e um bloco pronto para copiar e entregar a credencial.

## Objetivos

- Substituir o convite por criação direta de conta pelo administrador.
- Reduzir o modelo de papéis a dois: administrador (`COMMERCIAL_ADMIN`) e vendedor (`Vendedor`).
- Dar ao administrador visão geral e edição de todas as contas, a qualquer momento.
- Permitir exclusão permanente apenas de vendedores sem histórico operacional;
  contas com histórico permanecem disponíveis para desativação.
- Manter a autoridade de autorização no backend: a UI esconde controles, a política continua sendo o `authorize`.

## Fora de escopo

Registrados explicitamente para não voltarem como suposição durante a implementação:

- Autoatendimento de senha ("esqueci minha senha") e e-mail transacional.
- MFA e políticas rígidas de senha (comprimento, complexidade, expiração, histórico).
- Revogação de sessões ao trocar a senha — ver **USR-10**.
- Convite ou auto-cadastro em qualquer forma.

## P1.0 Papel único de operação

**User story:** Como operação, quero que exista uma única função operacional para que autorização, handoff e fila de trabalho não dependam de uma distinção que a Silmer não pratica.

**Critérios de aceite:**

1. **ROLE-01:** WHEN um usuário humano é criado por qualquer caminho THEN o sistema SHALL atribuir a função `Vendedor`, única função operacional aceita.
2. **ROLE-02:** WHEN uma linha de `crm.user_functions` é gravada com função diferente de `Vendedor` THEN o banco SHALL rejeitar a escrita por constraint.
3. **ROLE-03:** WHEN um handoff é criado pelo n8n ou por uma pessoa THEN seu `target_role` SHALL ser `Vendedor`, e `crm.handoffs` e `crm.handoff_history` SHALL rejeitar qualquer outro valor.
4. **ROLE-04:** WHEN a autorização operacional avalia um ator humano THEN ela SHALL exigir `functionName === 'Vendedor'`, sem aceitar `Atendimento`.
5. **ROLE-05:** WHEN o mapa de capacidades é consultado THEN ele SHALL conter somente `COMMERCIAL_ADMIN`; `PRIVACY_OFFICER`, `TECHNICAL_PRIVACY_EXECUTOR` e as ações `privacy.legal-hold.authorize` e `privacy.retention.execute` SHALL ter sido removidos do domínio, do schema e do contrato.

**Teste independente:** aplicar as migrations em um banco com dados de `Atendimento` e capacidades de privacidade, confirmar que as linhas existentes migraram para `Vendedor`, que as capacidades de privacidade sumiram e que uma tentativa de gravar `Atendimento` é rejeitada pelo banco.

## P1.1 Origem do administrador

**User story:** Como responsável técnico, quero criar o primeiro administrador fora da aplicação para que o acesso administrativo não dependa de nenhuma tela pública.

**Critérios de aceite:**

1. **BOOT-01:** WHEN o script de criação de administrador é executado com nome, e-mail e senha THEN ele SHALL gravar o usuário diretamente no PostgreSQL com hash Argon2id, função `Vendedor` e capacidade `COMMERCIAL_ADMIN`, sem passar pela API.
2. **BOOT-02:** WHEN o script é executado para um e-mail que já existe THEN ele SHALL falhar com mensagem clara e não alterar a conta existente.
3. **BOOT-03:** WHEN `POST /api/v1/bootstrap/identity` é chamado THEN ele SHALL continuar disponível, exigir `name` além dos campos atuais e permanecer restrito ao primeiro usuário do sistema.
4. **BOOT-04:** WHEN um administrador precisa promover outro THEN `POST /api/v1/capabilities/grant` SHALL continuar sendo o caminho, concedendo `COMMERCIAL_ADMIN`.

**Teste independente:** em um banco vazio, criar o administrador pelo script, entrar na aplicação com ele e confirmar que a tela de usuários aparece; repetir o script com o mesmo e-mail e confirmar a falha limpa.

## P1.2 Gestão de usuários pelo administrador

**User story:** Como administrador comercial, quero criar, revisar e editar as contas de vendedores em uma tela só para que eu controle o acesso ao CRM sem depender de ninguém.

**Critérios de aceite:**

1. **USR-01:** WHEN um administrador abre a tela de usuários THEN o sistema SHALL listar todas as contas com nome, e-mail, tipo de acesso, situação e data de criação, incluindo as desativadas.
2. **USR-02:** WHEN um administrador submete nome, e-mail e senha THEN o sistema SHALL criar uma conta com função `Vendedor` e sem capacidades.
3. **USR-03:** WHEN a conta é criada THEN a interface SHALL apresentar um bloco markdown com nome, e-mail, senha e endereço de acesso, montado no cliente a partir dos dados digitados, e a senha em claro SHALL NOT constar do corpo de nenhuma resposta da API.
4. **USR-04:** WHEN um administrador edita uma conta THEN ele SHALL poder alterar nome, e-mail e senha isoladamente ou em conjunto, a qualquer momento, e um campo de senha vazio SHALL manter a senha atual.
5. **USR-05:** WHEN uma senha é definida ou alterada THEN o sistema SHALL aceitar qualquer valor não vazio, sem regra de comprimento mínimo, complexidade ou histórico.
6. **USR-06:** WHEN um administrador desativa uma conta THEN o sistema SHALL registrar `disabled_at`, negar o login e as leituras operacionais dessa conta, e SHALL permitir a reativação pela mesma tela.
7. **USR-07:** WHEN o e-mail informado já pertence a outra conta, comparado sem diferenciar maiúsculas THEN o sistema SHALL recusar a operação e preservar a conta existente.
8. **USR-08:** WHEN um usuário sem `COMMERCIAL_ADMIN` chama qualquer rota de gestão de usuários THEN o sistema SHALL responder `403 FORBIDDEN`, e a interface SHALL omitir a entrada de navegação para ele.
9. **USR-09:** WHEN qualquer criação, edição, desativação ou reativação ocorre THEN o sistema SHALL registrar o evento na trilha de auditoria, na mesma transação, com ator, alvo, motivo e `correlationId`, e SHALL NOT gravar a senha nem seu hash no evento.
10. **USR-10:** WHEN a senha de uma conta é alterada THEN as sessões já abertas dessa conta SHALL permanecer válidas até expirarem pela janela normal; a nova senha vale a partir do próximo login.
11. **USR-11:** WHEN uma rota de mutação de usuário é chamada duas vezes com a mesma `idempotency-key` THEN o sistema SHALL retornar o resultado da primeira execução sem aplicar o efeito de novo.
12. **USR-12:** WHEN um administrador consulta as contas THEN o sistema SHALL indicar quais vendedores não têm histórico operacional e podem ser excluídos; `DELETE /users/:id` SHALL recusar com `409 USER_HAS_HISTORY` uma conta com histórico e SHALL sempre recusar uma conta com `COMMERCIAL_ADMIN`.

**Teste independente:** entrar como administrador, criar um vendedor sem histórico, excluí-lo e confirmar que desapareceu da lista; para um vendedor com atendimento ou handoff, confirmar que a ação disponível é desativar e que a API recusa a exclusão.

## P1.3 Remoção do convite

**User story:** Como responsável técnico, quero que o convite desapareça inteiro para que não sobre nenhuma porta alternativa de criação de conta.

**Critérios de aceite:**

1. **INV-01:** WHEN `POST /api/v1/invitations` ou `POST /api/v1/invitations/accept` é chamado THEN a API SHALL responder `404`, por não existirem mais.
2. **INV-02:** WHEN a tela pública de acesso é aberta THEN ela SHALL apresentar somente o formulário de login, sem abas nem campo de código de convite.
3. **INV-03:** WHEN as migrations de contração são aplicadas THEN `crm.invitations` SHALL ter sido removida, e o domínio SHALL NOT expor `createInvitation` nem `acceptInvitation`.
4. **INV-04:** WHEN o seed de desenvolvimento roda THEN ele SHALL criar as contas locais pela rota de criação de usuário, sem emitir nem resgatar convite.

**Teste independente:** subir a aplicação, confirmar que a tela de acesso não oferece convite, chamar as duas rotas antigas e receber `404`, e rodar o seed de desenvolvimento duas vezes sem erro.

## Rastreabilidade

| Requisito        | Camada principal                 | Artefato                                               |
| ---------------- | -------------------------------- | ------------------------------------------------------ |
| ROLE-01, ROLE-02 | Banco + domínio                  | migration expand, `identity-access`                    |
| ROLE-03          | Banco + n8n                      | migration expand, `n8n-integration`, `work-management` |
| ROLE-04          | Domínio + API                    | `authorization.js`, `identity-runtime.js`              |
| ROLE-05          | Banco + domínio + contrato       | migration expand, `authorization.js`, OpenAPI          |
| BOOT-01, BOOT-02 | Script                           | `scripts/create-admin.mjs`                             |
| BOOT-03, BOOT-04 | API                              | `identity-routes.js`, `identity-runtime.js`            |
| USR-01 a USR-04  | API + frontend                   | rotas `/api/v1/users`, `UsersView.vue`                 |
| USR-05           | Domínio                          | `hashPassword`                                         |
| USR-06           | Domínio + API                    | `postgres.js`, rotas de disable/enable                 |
| USR-07           | Banco                            | `users_email_lower_unique`                             |
| USR-08           | Domínio + API + frontend         | `authorize`, guardas de rota, navegação                |
| USR-09           | Domínio                          | `PostgresAuditTrail`                                   |
| USR-10           | Decisão                          | nenhuma mudança de código; registrada aqui             |
| USR-11           | API                              | `PostgresIdempotencyRecordStore`                       |
| INV-01 a INV-04  | API + frontend + banco + scripts | rotas, `AuthPanel.vue`, migration contract, seed       |

## Decisões que fecham áreas cinzentas

Tomadas com o usuário antes desta especificação:

- `Atendimento` sai de todo o sistema, não apenas da tela de criação — inclusive do `target_role` dos handoffs, com o custo de refatoração que isso traz.
- As capacidades de privacidade saem por completo; as duas ações que dependiam delas não têm chamador algum hoje.
- O administrador tem duas origens: o script direto no banco e o endpoint de bootstrap existente.
- A tela cobre criar, listar, editar e desativar/reativar. Não cobre gerar senha automaticamente.
- Sem regra de comprimento mínimo de senha, por decisão explícita do usuário.
- Trocar a senha não derruba sessões abertas, por decisão explícita do usuário.
