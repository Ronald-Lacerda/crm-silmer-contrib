# Validação da integração da release

BREL-02/04, tarefa T2. Data:09/11/2026, America/Sao_Paulo.

**PASS para integrar a release com cobranças desligadas.**

- [PR333](https://github.com/romulosutil/crm-silmer/pull/333): merge por rebase pelo mantenedor romulosutil, em09/11 às21:44:43. SHA final87cbc4351801087faf2ada798c5946f66a1976d9.
- [CI42729101945](https://github.com/romulosutil/crm-silmer/actions/runs/42729101945): cinco jobs aprovados no HEADe5e65af9f5603fbb27f01b711e9714212966bde2. Static/E2E, PostgreSQL, agregador e builds/scans runtime/edge aprovados.
- Validate:2418 aprovados,52 skips,0 falhas. E2E:853 aprovados,7 skips,0 falhas. PostgreSQL:693 aprovados nas sete execuções serializadas,0 skips/falhas. Audit:0 vulnerabilidades.
- `git diff e5e65af9 origin/master` vazio e nenhum merge commit no intervalo0ed44bd3..87cbc435. A árvore integrada coincide com a árvore dos checks.

## Revisão independente

A [revisão de integração](validation-integration.md) permanece vinculada à
fonte congelada16b01ad3:99 PostgreSQL,62 unitários/HTTP/ACL,20 E2E e cinco
mutações detectadas. Não foi reescrita para simular revisão de outro SHA.

Addenda posteriores, verificados por billing_release_verifier:

- As correções apply/replay do ensaio histórico Olist foram revistas; execução real PostgreSQL23/23 em59eca3c5, sem skips. Evidência privada: `var/billing-verifier-59eca-fixture-upgrade.log` e `.exit=0`.
- e5e65af9 altera somente o teste da sequência de Tab: acrescenta Cobranças antes de Frete. Nenhuma assertion anterior removida ou alteração de runtime. Quatro viewports falham antes e passam depois, sem retries/skips; revisão independente PASS. Evidências privadas: `var/billing-release-toolbar-before.log` e `var/billing-release-toolbar-after.log`.

## Recuperação identificada

Fonte anterior recuperável:0ed44bd38171276f0b0a7ef6a5319f802bec55fd.
Histórico de build da API no EasyPanel registra image ID local
`sha256:8c3ead130d4d08846cb22ebab7070f693bdc8aaf629ee0ebb5dfa3c0a0d325c2`.
A referência é um image ID local, não um digest de registro com pull provado.
Log privado: `var/billing-release-api-before-build.txt`.

O retorno de código usa a fonte anterior compatível com o schema expandido.
Não executar downgrade/DROP nem restauração automática do banco. Backup,
aplicação das migrações e verificações remotas pertencem a T3; este relatório
não substitui essas evidências nem autoriza teste financeiro ou go-live.
