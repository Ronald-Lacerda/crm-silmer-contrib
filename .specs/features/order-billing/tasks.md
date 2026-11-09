# Cobranças InfinitePay — entrega

Contrato [COB-01–16](spec.md), RFC 049 / ADR 058.

## COB-DEL-01 — Implementar o fluxo aprovado

Entrega vertical atômica, com um commit/push. T01–04 da RFC são fronteiras
da implementação integrada; T05 distingue gates locais da ativação real.

- [x] Protótipo avaliado e implementação autorizada pelo proprietário.
- [x] COB-T01: ADR, contrato e fontes canônicas.
- [x] COB-T02: migração, ACL, saldo, quitação e recuperação.
- [x] COB-T03: fila/worker, reserva e workflow n8n importável.
- [x] COB-T04: pedido, revisão, compartilhamento e conciliação.
- [x] COB-T05 local: gates, PostgreSQL sintético, E2E/axe e QA independente.
- [x] Commit/push atômicos e limites operacionais documentados.

Evidências locais em Node 24.20.0/npm 11.19.0: `npm run validate` com
1.760 aprovados e 13 skips; nove suítes PostgreSQL 17 sintético serializadas
com 69/69 aprovados, incluindo concorrência com a loja e UUIDs em caixa
diferente; E2E completo com 520 aprovados e sete skips. A revisão independente
de segurança encerrou sem achados após corrigir repetição com resposta perdida;
a revisão de interface conferiu desktop, 390/320 px, claro/escuro, foco,
anúncios de atualização e alvos de 44 px. Detector sem achados. Auditoria sem
alta/crítica, mantendo uma baixa e cinco moderadas preexistentes. Nenhuma
dependência adicionada. Export/expressões n8n verificados com dados sintéticos.
Após o ajuste final de feedback, `validate` repetido com sucesso e os 11 E2E
de cobranças aprovados novamente; revisão final de interface com decisão ship.

## COB-REV-01 — Revisar a jornada da Inbox e do Pedido

COB-12/13, MSG-02/03, PCX-13 e UX-FUNC-01; revisão do proprietário em
05/11/2026. Evidências e limitações no
[relatório](../../../docs/qa/order-billing-journey-2026-11-05.md).

- [x] Comparar checkout do site e verificar a jornada com avaliações independentes.
- [x] Estabilizar o alvo Enviar no toque durante a saída do campo.
- [x] Preservar rascunhos na navegação Inbox → Pedido → Inbox, com descarte
      no reload/saída/troca de sessão, sem conteúdo em armazenamento persistente.
- [x] Bloquear compartilhamento normal em revisão, incerteza, reabertura,
      validade vencida ou leitura desatualizada; conservar conferência explícita.
- [x] Gates integrados, revisão final, commit e push das correções.

Gates: validate com 1.760 aprovados/13 skips; E2E completo com 534 aprovados/
sete skips, mais 16 cenários finais do Pedido. Typecheck/lint/format/diff check,
detector sem achados e revisão independente sem pendências. Esta fatia não
altera backend, migração, produção ou workflows remotos.

## COB-PLAN-01 — Revisar o plano de continuação do PR 298

COB-01/04/05/12–15 e preparação de COB-CHAT-01, revisão de 05/11/2026.

- [x] Reconciliar PR, checks, código e tarefas em worktree separada.
- [x] Comparar alternativas e registrar sequência, recuperação e limites na
      [revisão da RFC 047](../../../docs/rfc/047-enviar-cobranca-pela-conversa.md#revisão-do-plano--05112026).
- [x] Conferir links locais dos documentos alterados e `git diff --check`.

Entrega documental; não aprova o protótipo nem conclui o envio integrado.
Preserva as alterações locais de saúde operacional e a implementação do PR.

## COB-CHAT-01 — Novo fluxo solicitado: gerar e enviar na conversa

### COB-CHAT-P01 — Preparar protótipo para avaliação

- [x] Protótipo isolado de conversa/pedido com revisão compartilhada,
      estados simulados e dados fictícios.
- [x] Cenários de sinal, saldo, integral, 0%, link existente e recuperação.
- [x] Conferência de teclado, foco, responsividade e axe claro/escuro.

Artefato e roteiro: [protótipo](../../../docs/prototypes/README.md).
Entrega do protótipo não significa avaliação ou aprovação pelo proprietário.

### COB-CHAT-P02 — Prototipar correção e cobrança do saldo

- [x] Histórico nas duas entradas com links, valores, recebido e saldo.
- [x] Correção bloqueada com link válido, vencimento/conferência simulados,
      revisão do novo valor e preservação do link anterior.
- [x] Cobrar somente o restante após recebimento confirmado; preservar
      pagamentos e bloquear nova cobrança após quitação.
- [x] Cenários de navegador, axe, revisão QA e ajustes de foco/estado.

Roteiro em [protótipo](../../../docs/prototypes/README.md).
Aguardando avaliação humana; nenhuma integração real implementada.

### COB-CHAT-P03 — Alinhar o protótipo ao design atual

- [x] Conferir shell e telas nas fontes atuais e na master remota.
- [x] Reutilizar CSS base/do Pedido e marca oficial; alinhar Inbox, seções da
      ficha, fechamento lateral e navegação/acordeão no celular.
- [x] Preservar correção/saldo, conferir navegador e axe claro/escuro.

Entrega de fidelidade visual do protótipo, sem alteração no runtime do CRM.

### Implementação integrada

Proposta em [RFC 047](../../../docs/rfc/047-enviar-cobranca-pela-conversa.md).
O proprietário escolheu link direto no chat com Pix e cartão; não QR Pix.
Frontend adiado até o redesign. Autorização de backend em 06/11/2026 permite
as tarefas B01–B04 sem depender da avaliação visual do protótipo.
Ordem e critérios refinados na revisão COB-PLAN-01 da RFC 047; a URL gerada
deve ser preservada mesmo quando o envio ficar bloqueado, e o envio deve
reutilizar a transação/outbox da Inbox sem mudar o responsável da conversa.

- [ ] Avaliar interface após redesign; manter revisão de destino/valor.
- [x] Decidir contrato/ADR e implementar intenção transacional, mensagem única,
      guardas no enfileiramento/reserva e retorno real do transporte.
- [x] Cobrir concorrência, falhas e conversa alterada no backend B01–B04.
- [ ] Verificar operação por teclado/toque após a implementação do redesign.

O backend B01–B04 acrescenta composição durável ao runtime de COB-DEL-01;
a interface entregue anteriormente continua com compartilhamento manual até
o redesign integrar o novo contrato. Dashboard foi retirado do foco
desta fatia e sua entrega paralela deve ser preservada.

Pendências preservadas para fatias próprias:

- [ ] COB-DASH-01: integrar o saldo à nova central enquanto houver valor a
      receber até a quitação, sem lembretes automáticos ao cliente; foco diferido
      expressamente pelo proprietário para priorizar Inbox e Pedido.
- [ ] COB-STORE-01: decidir/corrigir a divergência entre cartão habilitado no
      checkout da loja e domínio CRM limitado a Pix, preservando pagamentos.

## COB-OPS-01 — Ativação e homologação reais

- [ ] Aplicar e conferir todas as migrações da versão, incluindo 0055, 0063
      e 0064, antes de habilitar flags; preservar checksums anteriores.
- [ ] Conferir conta/credenciais, workflow privado, URLs e flags.
- [ ] Observar pagamento real autorizado, duplicidade e recuperação;
      preservar taxas e conferir devolução do teste.
- [ ] Rollback mantém callbacks dos links emitidos.

Gates locais não comprovam conta remota, deploy ou pagamento real. Evidências
e passo a passo no [runbook](../../../docs/runbooks/order-billing.md).

## Continuação autorizada em 08/11/2026

Plano de conclusão e dependências na
[RFC 047](../../../docs/rfc/047-enviar-cobranca-pela-conversa.md#plano-de-conclusão-revisado-em-08112026).
O workflow publicado da loja foi inspecionado; sua existência não homologa
cobranças sobre pedido existente. Manter conta/instância n8n e separar rotas
e IDs financeiros, sem alterar o checkout atual.

- [x] COB-DEV-01/02: perfil DEV, simulador e n8n real contra API/PostgreSQL
      sintéticos, conforme [tarefas DEV](../order-billing-development/tasks.md).
- [x] COB-READY-01: contrato frontend atualizado e limites de teste registrados.
- [ ] COB-DEV-03: ensaio integrado do transporte DEV, cinco comandos,
      correção e callbacks tardios, incluindo recuperação e rollback por flag.
- [x] COB-API-READY: projetar IDs de correção/retry antes de reproduzir a
      associação explícita entre cobranças do protótipo na UI real.
- [ ] COB-CHAT-UI/QA: frontend definitivo após redesign e jornada integrada.
- [ ] COB-OPS-01: publicação e homologação reais continuam abertas.

Nenhuma autorização nova para cobranças/envios reais ou publicação remota.

## Execution Plan

Backend autorizado em 06/11/2026. Frontend adiado até o redesign de outra
frente. A autorização de backend substitui a dependência de aprovação visual
para estas tarefas; não significa aprovação do design do protótipo.
Sequência: T1 → T2 → T3 → T4. Cada tarefa tem commit e push próprios.
O verificador final acrescentou T5, correção de propagação de bloqueio na
Inbox, dependente de T4; não amplia o escopo de frontend.

## Test Coverage Matrix

| Tarefa            | Critérios     | Camada / prova                                                                                                       |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| T1 / COB-CHAT-B01 | BAPI-01–05    | Contrato HTTP: exemplos válidos e inválidos, sessão/CSRF, comandos estritos, respostas privadas e escrita desligada. |
| T2 / COB-CHAT-B02 | BAPI-06–08    | PostgreSQL sintético: intenção, vínculo, idempotência, saldo/correção, locks, unicidade, rollback e auditoria.       |
| T3 / COB-CHAT-B03 | BAPI-07–10    | Callback/reserva: duplicidade, mudança de responsável/acordo, pagamento antes do envio, falhas conhecidas/incertas.  |
| T4 / COB-CHAT-B04 | BAPI-01–10    | Integração API/worker, flags/rollback, histórico e regressão de cobranças, Inbox e Financeiro.                       |
| T5 / COB-CHAT-B05 | BAPI-06/07/10 | Invalidação privada e única ao bloquear; falha do evento reverte a transação e conserva a reentrega.                 |

## Gate Check Commands

- Contract: `node --test test/order-billing-chat-routes.test.js` e `npm run typecheck`, `npm run lint`, `npm run format:check`, `git diff --check`.
- Database: `node --test --test-concurrency=1 test/order-billing-postgres-live.test.js` com PostgreSQL sintético dedicado e os novos testes transacionais da tarefa.
- Full: `npm run validate` e os testes PostgreSQL específicos das tarefas.

## Task Breakdown

### T1: Contrato HTTP de intenção e consulta (COB-CHAT-B01)

Depends on: none
Where: apps/api/src/order-billing-chat-routes.js
Tests: test/order-billing-chat-routes.test.js, exemplos válidos/negativos e privacidade; OpenAPI consistente com os comandos.
Gate: Contract
Done when: contrato normativo, OpenAPI e fronteira HTTP testada, sem runtime persistente nem frontend habilitado.
Status: Complete

Evidência: [contrato e QA](../../../docs/qa/order-billing-chat-contract-2026-11-06.md).
Fronteira HTTP 10/10 e validate integrado com 1.775 aprovados/15 skips na
rodada com nove testes de contrato; novo teste de capacidades/typecheck/lint
repetidos após a rodada integrada. Não há runtime persistente habilitado.

### T2: Persistência transacional (COB-CHAT-B02)

Depends on: T1
Where: apps/api/src/order-billing-chat-runtime.js
Tests: intenção/versão/deduplicação, correção sem cancelamento, saldo, concorrência e rollback em PostgreSQL sintético.
Gate: Database
Done when: comandos e histórico duráveis no banco existente, migração expand nova, auditoria na mesma transação.
Status: Complete

Escopo B02: migração 0063, serviço PostgreSQL injetável e testes dedicados.
Frontend, composição de mensagens e registro em server.js ficam adiados.
Evidências: [QA de persistência](../../../docs/qa/order-billing-chat-persistence-2026-11-06.md).
Gates: 16 cenários novos; matriz financeira PostgreSQL49/49, migrações4/4;
validate1776 aprovados/16 skips condicionais e zero falhas. Revisão QA
independente encerrada após corrigir a inversão de locks com unmerge.

### T3: Composição com a Inbox e reserva final (COB-CHAT-B03)

Depends on: T2
Where: modules/n8n-integration/src/postgres-repository.js
Tests: callback duplicado, responsável/ciclo/acordo alterados, usuário desativado, vencimento, recebimento antecipado e resultados incertos.
Gate: Database
Done when: callback conserva URL e resolve intenção atomicamente; reserva final impede efeito obsoleto sem alterar responsável ou forjar função.
Status: Complete

Evidências: [QA de composição/transporte](../../../docs/qa/order-billing-chat-transport-2026-11-06.md).
PostgreSQL novo 13/13, B02 16/16, callbacks concorrentes, preflight, retry
seguro/incerto e pagamento durante envio. Migração expand 0064, patch offline
do workflow humano e guardas na fila existente; sem frontend ou envio real.

### T4: Integrar backend e recuperação (COB-CHAT-B04)

Depends on: T3
Where: apps/api/src/server.js
Tests: flags separadas, leitura no rollback, integração de rotas/worker e revisão QA independente.
Gate: Full
Done when: backend integrado e validado, emissão inicialmente desligada, runbook atualizado; frontend e homologação remota continuam separados.
Status: Complete

Evidências: [QA de integração](../../../docs/qa/order-billing-chat-integration-2026-11-06.md).
Servidor/flags 8/8, validate 1.801 aprovados/17 skips condicionais e matriz
PostgreSQL sintética de 86 cenários distintos aprovados. Flag inventariada
sem valor habilitado; runbook inclui patch offline e rollback. Verificador
final registra o fechamento de B01–B04, sem concluir frontend/COB-OPS-01.

### T5: Propagar bloqueio na Inbox transacionalmente (COB-CHAT-B05)

Depends on: T4
Where: modules/n8n-integration/src/billing-send-guard.js
Tests: evento de invalidação privado e único ao bloquear mensagem; falha do evento reverte pagamento/mensagem/intenção e permite reentrega do callback.
Gate: Full
Done when: bloqueio proativo atualiza a Inbox existente pela stream durável na mesma transação, sem duplicar evento ou expor conteúdo.
Status: Complete

Correção identificada pelo verificador independente de BAPI-06/07/10; frontend
permanece adiado. Evidência final no relatório de validação do backend.
Gate integrado repetido: 1.801 aprovados/17 skips; suíte PostgreSQL de
transporte 15/15, incluindo bloqueio pelo worker, ausência de mensagem,
evento único e falha com rollback/reentrega. Sem nova implementação de UI.

### T6: Projetar origem de correção e retry para o histórico (COB-API-READY)

Depends on: T5
Where: apps/api/src/order-billing-chat-runtime.js
Tests: correção e retry persistidos continuam vinculados após nova leitura; eventos projetam origem correta, demais registros null, schema/OpenAPI e privacidade.
Gate: Full
Done when: BAPI-11 atendido sem migration, alteração de comandos, frontend ou efeito remoto.
Status: Complete

Campos opcionais `supersedesChargeId` e `retryOfIntentId` projetados das
relações já persistidas, inclusive na timeline. Testes de releitura em
PostgreSQL e serialização HTTP preservam vínculo de correção/retry e null
nos demais registros. Gate HTTP 11/11, matriz PostgreSQL 46/46 e validate
integrado 2.002 aprovados/24 skips condicionais, zero falhas e build aprovado.
Sem migração ou alteração do frontend; homologação remota continua aberta.
