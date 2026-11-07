# OPS-DEPS-01 — auditoria npm de 07/11/2026

Manutenção interna vinculada ao gate INT-3 / T00.2 e ao
[TDD §9](../../TECHNICAL-DESIGN.md#9-verificação-e-rastreabilidade).
O mantenedor autorizou corrigir os seis alertas sem downgrade do ESLint.

## Alterações

- ESLint permanece em **10.9.1**. Overrides específicos de `eslint` e
  `@eslint/config-array` fixam `minimatch` em **11.0.1**, corrigindo
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
  O override cruza uma versão principal transitiva; lint e descoberta de
  arquivos do projeto precisam passar antes da entrega. Remover os overrides
  quando ambos os consumidores declararem uma versão corrigida compatível.
- Fastify **5.12.5 → 5.12.8**, incluindo a correção de
  [validação de headers](https://github.com/advisories/GHSA-389g-gv7q-r4x8).
  Seu novo mínimo de `find-my-way` também atualiza o roteador e sua cadeia.
- `fast-uri` **3.1.8 → 3.1.9** e **4.2.1 → 4.2.3**, nas faixas dos
  consumidores existentes; `ip-address` **10.7.2 → 10.7.6**.

Nenhuma dependência direta nova. O matcher transitivo adicionado por minimatch,
`@isaacs/nonrecursive-glob-match`, usa BlueOak-1.0.0, como o próprio minimatch;
permanece restrito ao desenvolvimento. Sem mudança de infraestrutura ou domínio.

## Verificação

Executar com Node **24.20.0** e npm **11.19.0**:

```powershell
npm ci --no-audit
npm run validate
npm run test:e2e
npm audit --json
git diff --check
```

Na branch original, instalação reproduzível aprovada; auditoria completa sem
vulnerabilidades. `npm run validate` aprovado: formatação, tipos, lint com os overrides,
fronteiras, tokens, validadores, **1.980 testes aprovados, zero falhas e 26
skips**, além do build. O teste existente da versão exata do Fastify foi
atualizado junto com o manifesto. O build mantém o aviso de chunk acima de
500 kB, sem falha.

A primeira tentativa no sandbox bloqueou hardlinks, Bash e conexões locais;
a execução final fora do sandbox passou. Os 26 skips são suítes que
exigem `TEST_DATABASE_URL`. Na primeira validação não havia PostgreSQL
nem Docker disponível; a execução SQL manual sobre master está descrita abaixo.

E2E/axe aprovado: **555 testes passaram, sete skips, zero falhas** (3,2 minutos),
com quatro workers e configuração temporária ignorada pelo Git em
`.tmp/dependency-audit/playwright.config.mjs`: porta **43173**, pois
4173 já estava ocupada. A configuração importa a oficial e altera somente
URL/porta, diretório de saída e caminhos absolutos; preserva testes e asserts.
Comando: `npm run test:e2e -- --config=.tmp/dependency-audit/playwright.config.mjs --workers=4`.

`npm ls eslint minimatch fastify fast-uri ip-address`, formatação dos arquivos
alterados e `git diff --check` aprovados. Logs locais em
`.tmp/dependency-audit/`; somente evidências resumidas entram no commit.

## Integração sobre master

A correção foi isolada da branch Olist antes de abrir a PR: somente este commit
foi reposicionado sobre a master, com lockfile regenerado para seus workspaces.
Os números acima pertencem à validação da base original. Sem alteração de
contrato ou migration.

## CI manual autorizado — PR 309

O [workflow 774](https://github.com/romulosutil/crm-silmer/actions/runs/42422745872)
foi impedido de iniciar por cobrança/limite de gastos do GitHub. O mantenedor
autorizou explicitamente executar e aprovar o CI manual sem depender de Actions.
Nenhum workflow, requisito de proteção ou status remoto foi alterado para
simular sucesso.

Na correção isolada sobre master:

- `npm ci --no-audit` e `npm audit --json`: aprovados, zero vulnerabilidades.
- `npm run validate`: aprovado, **1.872 testes, zero falhas, 20 skips SQL**,
  incluindo formatação, tipos, lint, validadores e build reproduzível.
- E2E/axe completo: **538 aprovados, zero falhas, sete skips** (3,1 minutos),
  com a mesma configuração temporária de porta documentada acima.
- Gates PostgreSQL do workflow executados serialmente com PostgreSQL **17.11**
  portátil temporário, banco sintético `crm_silmer_test` em loopback:55439.
  **264 testes aprovados** nos seis blocos, sem falhas nem skips; cluster
  encerrado depois.
- Revisão manual dos seis arquivos: nenhuma dependência direta nova, ESLint
  preservado, overrides limitados aos dois consumidores afetados, licenças
  transitivas compatíveis com as já presentes. Lockfile sem módulos Olist.

Docker não está instalado nesta máquina: o teste do proxy em container e o
scan Trivy das imagens OCI não foram executados localmente. Dockerfiles e
imagens-base permanecem iguais. A aprovação manual desta correção registra
essa limitação; build e saúde dos serviços no EasyPanel serão acompanhados na
[PR 309](https://github.com/romulosutil/crm-silmer/pull/309), sem declarar os
checks de imagem do Actions aprovados nem prontidão geral de produção.

## Rollback

Reverter o commit desta manutenção e reinstalar com `npm ci`. Isso restaura
as versões vulneráveis anteriores e exige nova avaliação de segurança.
Nenhuma migration ou alteração de dados acompanha o patch.
