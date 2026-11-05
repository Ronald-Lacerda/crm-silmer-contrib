# QA — Central de ações e desempenho comercial

Data: 05/11/2026. Tarefa: ACT-T01. Branch: `codex/dashboard-central-actions`.
Base isolada: `origin/master` em `5bc36118`.

Contrato: [ACT-01–12, PERF-01–08 e CHK-01–08](../../.specs/features/dashboard-actions/spec.md),
[ADR 059](../adr/059-central-de-acoes-e-performance-comercial.md) e
[RFC 044](../rfc/044-performance-comercial-e-central-de-acoes.md).

## Parecer e limites

A revisão estática atual não mantém finding bloqueante aberto. As correções
foram examinadas nos fontes, e os resultados confirmados estão registrados
abaixo. O fechamento depende dos gates completos do integrador, sem extrapolar
um resultado parcial para aprovação de release ou homologação externa.

A revisão cobre autorização real, PII, mutações independentes de pagamento e
entrega, fences de lembretes, atribuição comercial e reserva do checkpoint.
Não houve uso de banco remoto, dados reais, envio WhatsApp, publicação/ativação
de workflow ou alteração de infraestrutura de produção.

## Bancada local

Foi preparado PostgreSQL Windows portátil 17.11 a partir da cadeia oficial
[PostgreSQL](https://www.postgresql.org/download/windows/) →
[EDB](https://www.enterprisedb.com/download-postgresql-binaries). Foram extraídos
somente binários, bibliotecas e arquivos de suporte para diretório local
ignorado pelo Git, sem instalar serviço Windows, Docker, WSL ou modificar o SO.
O cluster escuta somente loopback, tem autenticação por senha e usa bancos
exclusivos de teste separados para QA, Backend e integrador. A versão e a
conexão local foram confirmadas por `postgres --version` e `psql`.

Credenciais, URLs de conexão, logs e scripts de lifecycle permanecem privados
sob `.local/`; `git check-ignore` confirmou a exclusão do arquivo de conexões.
O SHA256 do arquivo baixado foi registrado localmente como proveniência; não
é checksum independente publicado pela EDB, e o executável não tem assinatura
Authenticode. Nenhum segredo ou dado do ambiente local integra esta evidência.

## Findings corrigidos

| Prioridade | Achado                                                                                                                               | Correção revisada e evidência                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1         | Última saída queued/sending/failed/unknown escondia atendimento ainda pendente.                                                      | `dashboard-runtime.js` projeta resolução de envio com motivos distintos; não afirma silêncio do cliente nem reenvia. Unitários de API cobrem os estados e falha posterior de receipt; live do Backend cobre retorno à fila e exclusão do atendimento efetivo.                                                                             |
| P1         | Novas declarações podiam aproveitar ator autorizado antes de downgrade/desativação, e replay podia abrir receipt após transferência. | `createOrderApiRuntime` envolve somente pagamento/entrega numa transação: relê pessoa ativa/função/capacidades, autoriza, bloqueia conversa→pedido, valida posse antes do receipt e vincula serviço/repositório/idempotência/auditoria ao mesmo client. Backend confirmou live com downgrade, desativação e replay transferido recusados. |
| P2         | Dismiss avaliava sugestão sem anexar a decisão existente e podia dispensar retorno agendado.                                         | A validação de comando usa a decisão atual com os fences; live cobre `ACTION_NOT_AVAILABLE` para dismiss do retorno agendado.                                                                                                                                                                                                             |
| P2         | Handoff de outro papel ou automação não humana podia aparecer como disponível.                                                       | Query e projeção exigem papel-alvo Vendedor, pendente e modo humano; unitários cobrem exclusões.                                                                                                                                                                                                                                          |
| P2         | Lembrete aceitava instante sem fuso explícito ou dia civil normalizado pelo parser.                                                  | Validação exige ISO com timezone e dia civil real, futuro e dentro de 90 dias; unitários negativos passaram.                                                                                                                                                                                                                              |
| P2         | Limite SQL antes de ordenar pedidos podia ocultar entrega atrasada mais recente.                                                     | Prioridade dos pedidos é calculada sobre os próprios elegíveis antes do corte da resposta; live cobre pedido urgente após mais de 100 itens. UI declara limites e contadores carregados, com acesso às listas completas.                                                                                                                  |
| P2         | Refresh após conflito podia apagar data/hora digitada ou reaproveitar consentimento de quitação com valor novo.                      | Formulário captura alvo/versão/valor; SSE não o substitui; drafts por ação conservam data/hora; checkbox de recebimento integral reinicia na reabertura. Conflito permanece até atualização explícita. Frontend confirmou E2E negativos de rascunho, 403/409 e novo valor.                                                                |
| P2         | Prepare concorrente em REPEATABLE READ com advisory lock podia falhar com 23505 por snapshot anterior ao commit vencedor.            | QA reproduziu em PostgreSQL real: segundo SELECT viu zero linhas e INSERT lançou 23505. Retry foi limitado à constraint única de `report_day`; suíte live de checkpoint passou com prepare concorrente convergindo para um snapshot.                                                                                                      |
| P2         | Cabeçalhos da tabela mobile eram removidos da árvore acessível por `display:none`.                                                   | Frontend preservou thead com clip visual, papéis de tabela explícitos e associações `headers`; nova asserção mobile/axe em validação final pelo responsável.                                                                                                                                                                              |

A migração também preserva a ausência histórica de atribuição em
reabertura/reconfirmação por marcador de tentativa de captura; o Backend
acrescentou cenário live específico. O Backend confirmou o último rerun PostgreSQL após esse acréscimo; o cenário
passou mantendo o legado sem atribuição.

## Critérios de aceite e evidências

| Critérios            | Verificação                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACT-01–03, ACT-05–07 | Objetos próprios, handoffs elegíveis, estado comercial separado, sugestão de 48h com envio humano efetivo, decisões pessoais com versão/revisão, nova mensagem invalidando snooze, transferência e replay recusados. Projeção unitária, revisão de SQL e live do Backend.              |
| ACT-04, ACT-12       | Quitação literal integral, dia válido de São Paulo, entrega pelo dia do servidor, loja/teste recusados, posse e principal atuais, idempotência/auditoria na mesma transação. Backend confirmou corrida real pagamento×entrega: um conflito e retry preservando ambas as datas/revisão. |
| ACT-08–09, ACT-11    | Semântica, foco de seleção/volta/erro, móvel com uma região por vez, falhas sem falso zero, rascunho e valor congelados, checkbox renovada. Revisão estática e E2E do Frontend; gate completo abaixo.                                                                                  |
| ACT-10, PERF-07      | Financeiro recusado, escopo/actorId forjados recusados, vendedor limitado à própria linha/fila e admin autorizado à equipe. Unitários e live do Backend.                                                                                                                               |
| PERF-01–06, PERF-08  | Crédito distinto do executor e congelado, legado sem inferência, ciclos distintos sem inflação por mensagens/pedidos, dias civis de São Paulo, totais conciliáveis com loja/sem atribuição, mesma apuração para UI/checkpoint. SQL único revisado e unitários/live.                    |
| CHK-01–05            | Agendamento inativo às 08h São Paulo para ontem, apuração oficial, snapshot cifrado/AAD, destinatários privados, preview admin e capacidade técnica estreita. Unitários/template e live do checkpoint.                                                                                 |
| CHK-06–08            | Uma autorização de transporte por destino, replay sem nova permissão, destinos independentes, desconhecido sem retry cego, reconciliação explícita, aceitação sem alegar entrega. Unitários/template e live do checkpoint.                                                             |

Buscas nos arquivos versionáveis não encontraram os telefones reais dos
sócios nem nomes usados como configuração privada. Componentes novos não
introduzem chamada Clarity ou unmask. Esta base isolada não incorpora a
instalação concorrente de Clarity; a compatibilidade futura continua exigindo
mascaramento dos dados pessoais e ausência de conteúdo de chat em telemetria.

## Comandos e resultados confirmados

Executados diretamente pelo papel QA:

- `node --test test/dashboard-api.test.js test/dashboard-actions-format.test.js test/dashboard-format.test.js`: **24 passaram**, zero falhas/skips.
- `node --test test/dashboard-checkpoint.test.js test/dashboard-checkpoint-workflow.test.js`: **8 passaram**, zero falhas/skips; sem efeito externo.
- `node --test --test-concurrency=1 test/dashboard-checkpoint-postgres-live.test.js`, com conexão privada do banco QA: **1 passou**, zero falhas/skips. Cobre concorrência, snapshot congelado/cifrado, reserva exclusiva, destinos independentes, resultado desconhecido/reconciliação, configuração alterada e preview autorizado.
- Reprodutor SQL isolado da corrida RR/advisory: segundo SELECT retornou zero; INSERT retornou SQLSTATE 23505 antes da correção.
- Prettier e `git diff --check` nos quatro documentos canônicos delegados: passaram.

Resultados comunicados e confirmados pelos responsáveis, separados da execução QA:

- Backend: suíte live de dashboard passou com decisões concorrentes/CAS, fonte invalidada, ACL e atribuição; execução ampliada passou com pagamento×entrega, retry preservando datas, replay transferido, downgrade e desativação. O último rerun também passou com legado reconfirmado sem atribuição; 74 testes unitários/API/workflow, ESLint focado e typecheck do Backend passaram.
- Integrador: live de checkpoint passou sem skip; regressões live Financeiro/migrations **14/14 passaram** no banco sintético dedicado.
- Frontend: regressões focadas **34/34 passaram** antes do último hardening; **10/10 passaram** após hardening de conflitos, incluindo período/race, cinco larguras e tema escuro. Ajuste final de semântica da tabela mobile e gate integrado ainda não considerados concluídos neste registro.

## Gate final do integrador

Resultados finais do integrador no diff integrado:

- [x] Último rerun live do dashboard, incluindo legado reaberto/reconfirmado (confirmado pelo Backend).
- [x] Regressões Orders/Store concluídas: 37 passaram, zero falhas/skips,
      incluindo checkpoint; Financeiro/migrations: 14 passaram, zero falhas/skips.
- [x] E2E integrado: 505 passaram, 7 skips declarados. Após o último ajuste de
      cabeçalhos, roles e orçamento: mais 17 passaram, zero falhas/skips.
      Capturas em 320/390/768/1024/1440 e temas claro/escuro inspecionadas pelo
      integrador; teclado, associações da tabela e axe passaram.
- [x] `npm run validate` concluído: formato, TypeScript, lint, fronteiras,
      tokens, validadores operacionais, testes e build. Suíte geral: 1.741
      passaram, zero falhas, 14 skips live/condicionais; provas PostgreSQL
      acima foram executadas separadamente, com conexão dedicada.
- [x] `npm audit --audit-level=high` e `git diff --check` finais passaram.
      Audit registra 1 baixa e 5 moderadas, zero altas/críticas. São da árvore
      herdada: package.json e package-lock.json permanecem sem alterações.
      Não aplicar downgrade/atualizações amplas de dependência nesta fatia.
      Build mantém aviso de chunk acima de 500 kB; geração concluída.
- [x] Diff final revisado e entrega atômica na branch
      `codex/dashboard-central-actions`; commit/push verificáveis no Git.

Ativação real do checkpoint permanece ACT-T02, conforme
[runbook](../runbooks/dashboard-central.md). Testes locais e aceite visual não
comprovam destinatários configurados, workflow publicado ou mensagem entregue.
Após os testes, o integrador deve parar o cluster portátil pelo script privado
de lifecycle; não há serviço instalado que exija mudança no sistema.
