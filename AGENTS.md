# Agentes do CRM Silmer

## Escopo e missão

Estas instruções valem para todo o repositório. A equipe deve entregar o MVP
como um monólito modular confiável, acessível e operável, preservando os
contratos de produto, segurança, privacidade e recuperação já aprovados.

## Precedência das fontes

Quando houver conflito, use esta ordem:

1. `RULES.md` — invariantes que não podem ser quebradas.
2. `.specs/features/crm-mvp/spec.md` — requisitos e critérios de aceite.
3. `CRM-MVP-ESPECIFICACAO.md` — escopo e comportamento do produto.
4. `TECHNICAL-DESIGN.md` e `EASYPANEL-TOPOLOGY.md` — implementação e operação.
5. `ARCHITECTURE.md` — resumo das decisões.
6. `.specs/features/crm-mvp/tasks.md` — sequência de entrega.
7. `ABOUT.md`, `README.md` e `CODEX.md` — navegação e contexto.

`historico-datacrazy/` nunca supera uma fonte acima.

## Padrão de decisões e propostas

- ADRs devem ser salvos em `docs/adr/`, com numeração sequencial de três
  dígitos e nome `NNN-titulo-em-kebab-case.md`. Eles registram decisões
  arquiteturais tomadas e não devem ser reescritos; uma mudança cria um novo
  ADR que supersede o anterior.
- RFCs devem ser salvos em `docs/rfc/`, usando a mesma convenção de nome e
  numeração. Eles registram propostas relevantes antes da decisão e podem ser
  atualizados durante a revisão.
- Toda decisão arquitetural durável deve vincular o RFC ao ADR correspondente
  e manter links para requisitos, issues e PRs relacionados.
- `ARCHITECTURE.md` e `TECHNICAL-DESIGN.md` continuam sendo fontes canônicas
  de síntese e implementação; ADR/RFC registram o contexto, as alternativas e
  o motivo da decisão.

## Protocolo obrigatório

1. **Pesquisa por intenção:** para perguntas arquiteturais, relações entre
   código e documentação ou descoberta inicial de uma área, consulte os diagramas e grafos pré-existentes
   em `graphify-out/`. Para localizar texto, símbolo, header,
   arquivo ou mudança local, use `rg` como busca primária.
2. **Grafo não é worktree:** trate o Graphify como mapa de descoberta, não como
   fonte da versão atual. Antes de decidir ou editar, confirme os achados no
   arquivo de origem e com `rg`; isso é obrigatório quando o grafo anteceder o
   último commit ou houver alterações locais relevantes.
3. **Contexto mínimo:** leia `ABOUT.md`, `ARCHITECTURE.md` e `RULES.md`; depois
   carregue somente requisitos e seções técnicas relevantes.
4. **Rastreabilidade:** associe a mudança a um ID de requisito e a uma tarefa.
5. **Patch estreito:** altere apenas a fronteira necessária e preserve mudanças
   locais de terceiros.
6. **A11y e segurança:** trate teclado, foco, ARIA, autorização, PII,
   idempotência e auditoria como parte da implementação, não como revisão tardia.
7. **1:1:1:1:** uma tarefa concluída gera uma entrega atômica, um commit e um push.
   O grafo (`graphify-out/`) não é versionado: só o Hermes, no worker Ubuntu do
   Rômulo, o gera (a cada push e toda noite) e ele volta pelo Syncthing. Nenhum
   agente roda `graphify update` nem commita o grafo; máquina sem o grafo usa `rg`.

Não introduza outro framework de frontend, store global, estado de domínio em
`window`, Redis, microserviços ou nova infraestrutura sem autorização explícita
e decisão registrada. Vue 3 e Vue Router são a baseline aprovada no ADR-001.

## Checkout único e branches curtos

Na máquina do Rômulo existe **um só checkout de trabalho**: `crm-silmer`. O
sócio trabalha como preferir na máquina dele; esta regra vale para o checkout
do Rômulo e para todos os agentes (Codex e Claude).

- **Sem pastas irmãs:** não crie `crm-silmer-*` ao lado do repositório nem
  worktrees persistentes (`.claude/worktrees/`, `~/.codex/worktrees/`). Um clone
  ou worktree extra só é aceitável como temporário, para uma tarefa isolada, e
  deve ser removido com `git worktree remove` antes do handoff, confirmando com
  `git worktree list` que ficou limpo. Nunca aponte `node_modules` de um
  worktree para outro checkout por junction ou symlink.
- **Um agente por vez:** só uma sessão altera o checkout principal. Outra
  sessão não troca de branch nem reescreve arquivos ali; se precisar de
  paralelismo, aguarde ou use um worktree temporário conforme o item acima.
- **Branch curto por tarefa:** parta de `origin/master`, abra um PR, mescle
  com histórico linear e apague o branch (o GitHub já apaga o branch remoto ao
  mesclar; apague o local com `git branch -d`). Branches `backup/*`, `*-wip` e
  `*-pre-rebase` não são permanentes: promova a PR ou apague.
- **Nada solto antes de trocar de branch:** commit, ou descarte consciente com
  o patch guardado fora do repositório. Não deixe trabalho só no disco, em
  stash ou em worktree.
- **A `master` não recebe push direto:** ela segue para produção e exige PR
  com os gates do CI. Antes de começar, `git switch master && git pull --ff-only`.

## Equipe por responsabilidade

Ative somente os papéis necessários para a fatia. O Tech Lead continua dono da
integração e da decisão final; especialistas entregam evidência, não decisões
silenciosas.

| Papel                        | Quando ativar                            | Responsabilidade                                                          | Evidência de saída                                 |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Tech Lead / Orquestrador     | Sempre                                   | Escopo, dependências, contratos, integração e fechamento                  | Plano, decisões, diff integrado e gate final       |
| Produto / Domínio            | Regra ambígua, fluxo ou aceite           | Mapear comportamento para PRD/spec e impedir expansão de escopo           | IDs atendidos, exemplos e dúvidas bloqueantes      |
| Frontend / Acessibilidade    | HTML, CSS, JS de interface               | Semântica, teclado, foco, estados, ARIA e composição responsiva           | Cenários por teclado e estados verificados         |
| Backend / Dados              | API, domínio, SQL ou autenticação        | Transações, constraints, ACL, migrações e contratos REST                  | Testes positivos, negativos e concorrentes         |
| Integrações / Confiabilidade | Meta, IA, storage, worker ou PDF         | Adapters, assinatura, idempotência, retry, reconciliação e falhas         | Fixtures, matriz de efeitos e casos de recuperação |
| QA / Segurança / Privacidade | Toda fatia de risco                      | Revisão adversarial, regressão, PII, abuso, autorização e observabilidade | Findings priorizados e critérios executados        |
| DevOps / Release             | CI, imagem, EasyPanel, backup ou go-live | Build reproduzível, digest, segredos, health, rollback e recovery         | Logs de pipeline, digest e runbook validado        |

### Composição eficiente por tipo de tarefa

- UI: Tech Lead + Frontend/A11y + QA.
- API ou domínio: Tech Lead + Backend/Dados + QA.
- Canal, IA, worker ou documento: Tech Lead + Backend + Integrações + QA.
- CI/deploy/recovery: Tech Lead + DevOps + QA; Privacidade participa quando há
  dados, backup, logs ou operador externo.
- Documentação ou configuração estreita: Tech Lead executa sozinho e chama
  revisão especializada apenas se alterar contrato.

## Contrato de delegação e handoff

Cada trabalho delegado deve informar:

- objetivo e critério de aceite;
- requisito/tarefa associados;
- arquivos que o papel pode editar;
- arquivos, decisões e mudanças locais que deve preservar;
- comandos de verificação esperados;
- formato do retorno: achados, mudanças, evidências, riscos e bloqueios.

Divida trabalho apenas quando as partes forem independentes. Um único papel é
dono de cada arquivo; investigação é somente leitura; revisão não reescreve o
patch sem combinar a posse. O Tech Lead integra, executa os gates completos e
responde pelo resultado ponta a ponta.

## Definition of Done resumida

- Critérios rastreáveis atendidos, incluindo cenários negativos.
- Autorização validada na API e na interface quando aplicável.
- Operação completa por teclado e foco previsível em toda UI alterada.
- Nenhuma PII ou segredo em log, fixture, diff ou artefato.
- Migração, idempotência, falha externa e rollback cobertos conforme o risco.
- Documentação e runbook atualizados junto com a mudança.
- `git diff --check`, checks do projeto, commit e push concluídos.

### Architectural Context (Graphify)

- READ ONLY: Always inspect and read existing graphs, AST maps, and architecture diagrams directly from:
  `dev/graphify-out/` (or relative path to graphify-out/)
- NEVER run graphify build, parse, or indexing commands locally on the Windows host.
- Graph updates are handled automatically in the background by the Ubuntu Worker on git push and nightly schedules.

### Infraestrutura de desenvolvimento

- Docker local está autorizado nesta máquina para desenvolvimento e testes.
- Use containers e bancos dedicados com dados sintéticos; não confunda testes
  locais com evidência operacional do EasyPanel ou do RustFS remoto.
- Não há dependência obrigatória do alias `dell-worker` nem de mounts remotos.
