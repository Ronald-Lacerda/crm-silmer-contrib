# ADR 065 — Caixa por vez de responder

Data: 08/11/2026. Status: aceita pelo PO com as decisões D1–D10 da RFC 052.
Proposta: [RFC 052](../rfc/052-caixa-de-entrada-por-vez-de-responder.md).
Requisitos: PCX-19a–j no [spec](../../.specs/features/crm-mvp/spec.md); tarefa
INBOX-VEZ-01 no [plano](../../.specs/features/crm-mvp/tasks.md).
Complementa ADR 061 (expediente, `turnAsOf`, perda declarada) e ADR 059
(lembrete ACT-05 e retomada de 72 h). Não altera ADR 009 (posse) nem ADR 015
(conversa não volta ao agente). Numerada 065 porque 064 está reservada em
branch da integração Olist.

## Decisão

1. **Abas derivadas em leitura.** Cada conversa do universo aberto (não
   arquivada, sem `terminal_at`, fora de `convertida_em_lead`, `sem_lead` e
   `encerrada`) pertence a exatamente uma das quatro abas, `respond`,
   `awaiting`, `silent` ou `lost`, pela precedência: (1) falha de envio
   (`DELIVERY_ISSUE`), que prevalece até sobre perda; (2) perda ativa;
   (3) handoff pendente; (4) vez do cliente, em que o agente dentro da
   janela de resposta vai para `awaiting` e os demais para `respond`;
   (5) silêncio da Silmer por 72 h ou mais vai para `silent`, salvo lembrete
   próprio ativo; (6) demais casos em `awaiting`. Não há novo estado de
   conversa persistido.
2. **Mensagem efetiva.** Conta a saída `sent|delivered|read` de autoria humana
   ou, em atendimento pelo agente (`automation_state='assistant'`), a do
   agente. `system` nunca conta. Em atendimento humano só a resposta humana
   muda a vez, como em INBOX-UX-02.
3. **Seletor de responsável com padrão Todos** (`owner=all`), com `mine` e
   `unassigned` como alternativas. Vale para as abas, para as contagens e
   para `archived` e `terminal`. `orderReady=true` é filtro combinável, não aba.
4. **72 h corridas, inclusive.** A constante `SILENT_AFTER_HOURS` fica em
   `modules/inbox-channels/src/turn-policy.js`. `dashboard-runtime.js` a
   importa e continua exportando `DASHBOARD_FOLLOWUP_HOURS`.
5. **Lembrete por pessoa (D2).** Adiar grava só a decisão do próprio ator em
   `crm.dashboard_action_decisions` (`action_id='conversation:'||id`,
   `decision='schedule'`, `target_version`). Só o lembrete do ator muda a aba,
   que passa de `silent` para `awaiting` até o prazo. Lembrete de outra pessoa
   aparece como `reminder.mine=false`, sem mudar a aba. O comando usa
   `source_revision` no formato da Central de ações, reaproveitando o helper,
   para que a decisão continue válida lá.
6. **`turnAsOf` e expediente.** `turnAsOf` é o `now` do servidor, único por
   resposta e passado como parâmetro. `turnBusinessMinutes` vem de
   `crm.business_minutes_v1` (ADR 061). O cliente só projeta o avanço do
   relógio entre recargas. O SQL da função continua como referência.
7. **Agente parado na lista.** Regra por linha, mais simples que
   `STALLED_CONVERSATIONS`: `assistantStalled` é verdadeiro quando o agente
   está no comando, não há handoff aberto, a vez é do cliente e a última
   inbound passou de `stallMinutes`. Não tem corte de 24 h. O contador do painel
   continua vindo do sweeper, que segue como fonte única dele.
8. **Encerradas e arquivadas** saem das abas e usam `terminal=true` ou
   `archived=true` como consulta (D7).

## Alternativas rejeitadas

- **Novo estado de conversa persistido** (com sweep ou trigger). Repete o
  motivo da ADR 061, exige migration e backfill, e a regra cabe em leitura com
  o que já existe.
- **Reutilizar `STALLED_CONVERSATIONS` por linha.** Tem corte de 24 h e é o
  contador do painel. Usá-lo na lista misturaria as duas coisas.
- **Marcador novo para aviso automático.** As colunas `author_kind` e
  `automation_state` já separam a autoria. Um marcador novo exigiria migration
  e mudança no envio.

## Consequências

- **Sem migration nesta fatia**, sem dependência nova e sem infraestrutura.
  Entram três contratos: `GET /inbox/conversations` com `bucket`, `owner`,
  `orderReady` e `terminal`; `GET /inbox/buckets` em um snapshot; e
  `POST /conversations/{id}/reminder`. `POST lead-outcome` passa a publicar o
  evento SSE `conversation` na mesma transação, sem mudar a resposta.
- **Medição sintética** (5.000 conversas abertas e 100.000 mensagens): p95 de
  793 ms a 887 ms na aba sem filtro de responsável, 160 ms com `owner=mine` e
  749 ms nas contagens. As listas anteriores ficaram entre 1,0 s e 1,4 s no
  mesmo volume. Como a aba padrão é Todos, ela fica acima do limiar de 300 ms nesse
  volume sintético. Por isso a decisão sobre a migration depende da medição no
  volume real, não da estimativa.
- **Critério para a migration.** Se o p95 real da lista passar de 300 ms, abre-se
  uma migration expand que desnormaliza `last_inbound_at` e
  `last_effective_outbound_at` com índice parcial, nova ADR. Nesta fatia ela não
  existe.
- **Rollback.** Volta primeiro o frontend, depois a API. A API nova mantém
  `workQueue`, `sort=urgency` e os fingerprints de cursor anteriores.

## Implementação e operação

Detalhes de deploy, parâmetros e medição do p95 estão no
[runbook](../runbooks/inbox-prioridades.md), seção "Caixa por vez de responder".
