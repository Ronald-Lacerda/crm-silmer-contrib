# Contribuindo com o CRM Silmer

## Antes de alterar

1. Leia `README.md`, `RULES.md`, `ARCHITECTURE.md` e `AGENTS.md`.
2. Escolha um item em `.specs/features/crm-mvp/tasks.md` e identifique os
   critérios correspondentes em `.specs/features/crm-mvp/spec.md`.
3. Consulte o contexto existente com `graphify query`.
4. Verifique o worktree e não misture alterações de outras tarefas.

Uma mudança sem requisito rastreável deve ser classificada como correção de
documentação, manutenção interna ou nova decisão. Mudanças de arquitetura,
stack ou escopo exigem aprovação explícita e atualização da fonte canônica.

### ADRs e RFCs

- Salve propostas relevantes ainda não decididas em `docs/rfc/`.
- Salve decisões arquiteturais tomadas em `docs/adr/`.
- Use numeração sequencial de três dígitos e o formato
  `NNN-titulo-em-kebab-case.md`; consulte os READMEs de cada pasta antes de
  criar um documento.
- Atualize o RFC durante a revisão. Após a decisão, preserve o histórico e
  crie um ADR vinculado quando a decisão for arquitetural e durável.
- Relacione o documento a requisitos, issues e PRs. Documentação não substitui
  aprovação humana nem evidência operacional.

## Governança do repositório público

- Contribuições externas entram por fork e pull request; não há push externo na
  branch `master`.
- `@romulosutil` é o único mantenedor com permissão de escrita, integração e
  administração de acessos. Somente ele adiciona colaboradores e integra PRs.
- Pull requests do próprio mantenedor não exigem autoaprovação, porque o GitHub
  proíbe aprovar o próprio PR; checks e resolução de conversas continuam
  obrigatórios.
- Workflows enviados por qualquer contribuidor externo exigem aprovação manual
  do mantenedor antes de consumir runners.
- Nunca publique segredo ou dado pessoal em issue, discussion, commit, log ou
  pull request. Vulnerabilidades são reportadas pelo advisory privado descrito
  em `.github/SECURITY.md`.

## Durante a implementação

- Prefira uma fatia vertical pequena, observável e reversível.
- Mantenha o frontend em Vue 3 com SFCs pequenos, CSS e módulos JavaScript ESM; não adicione store global sem decisão registrada.
- Trate acessibilidade, autorização, privacidade e idempotência no primeiro
  patch.
- Não adicione dependência sem justificar necessidade, risco, licença e impacto
  operacional.
- Não use dados reais de clientes em desenvolvimento ou testes.
- Atualize documentação e contratos no mesmo trabalho que muda comportamento.

## Validação

Use Node.js `24.20.0` e npm `11.19.0`. Para instalar exatamente o lockfile e
executar o gate local completo:

```powershell
npm ci
npm run validate
npm run test:e2e
npm audit --audit-level=high
```

O gate agrega formatação, JSDoc/checkJs, ESLint, fronteiras do monólito, testes
`node:test` e build reproduzível. E2E/axe-core e auditoria de dependências são
gates separados e obrigatórios. Durante a implementação, os mesmos passos
podem ser executados separadamente pelos scripts documentados no `README.md`.

Para falha de inicialização do Firefox no Windows, use o
[roteiro de áudio em Linux local](docs/runbooks/playwright-audio-local.md).
Ele mantém a versão do Playwright e as assertions existentes, com cópia
isolada do commit e áudio sintético. Não substituir o gate de gravação real
por skip ou mock para contornar a falha do executável do host.

Mudanças de topologia ou recovery também executam `npm run validate:topology`
e `npm run test:recovery:mocks`. O plano revisável por uma segunda pessoa é
gerado por `npm run recovery:plan`; ele é offline e nunca substitui o
provisionamento ou o drill autorizado.

Mudanças na matriz de providers ou no envelope de carga executam
`npm run validate:external-spikes` e `npm run test:external-spikes`. Evidência
local não pode ser registrada como aceite de Privacidade, Operação, Rose ou
como teste live de provider.

Mudanças no threat model, catálogo de dados ou retenção executam
`npm run validate:security-catalog` e `npm run test:security-catalog`. Nenhum
gate automatizado substitui a revisão pendente de Tech Lead e do Responsável de
Privacidade.

Mudanças nos defaults de domínio, papéis ou capacidades executam
`npm run validate:phase0-decisions` e `npm run test:phase0-decisions`. Um gate
local nunca substitui as aprovações de Produto, Operação e Privacidade.

Mudanças em logs, IDs de tracing, métricas, health checks ou imagens executam
`npm run validate:observability` e `npm run test:observability`. Use somente
canários sintéticos e nunca inclua mensagem, prompt, telefone ou segredo.

Antes de publicar, execute também `git diff --check` e `git status --short`.

## Atualização de branches de pull request

Configure uma vez o Git do ambiente para que `pull` atualize branches por
rebase, inclusive quando a instalação do Git for Windows definir merge como
padrão:

```powershell
git config --global pull.rebase true
```

Para atualizar uma branch de PR, rebaseie sobre a ponta remota de `master` e
publique a história reescrita somente com proteção por lease:

```powershell
git fetch origin --prune
git rebase origin/master
git push --force-with-lease
```

Não incorpore `master` com `git merge` em uma branch de PR. O CI rejeita
commits de merge na faixa exclusiva da PR, pois o repositório exige histórico
linear e aceita apenas integração por rebase. Resolva conflitos funcionais por
composição.

## Commits e publicação

- Um commit representa uma tarefa ou uma mudança mecânica claramente isolada.
- Use Conventional Commits, por exemplo `docs: add contributor and agent base`.
- Registre no handoff os checks executados e qualquer risco residual.
- Faça push do commit concluído e confirme que o worktree ficou limpo.
- `graphify-out/` não é versionado: só o Hermes, no worker Ubuntu, gera o grafo
  (a cada push e toda noite) e ele volta pelo Syncthing. Não rode
  `graphify update` nem commite o grafo.

O Definition of Done completo permanece em
`.specs/features/crm-mvp/tasks.md`; este guia não o substitui.
