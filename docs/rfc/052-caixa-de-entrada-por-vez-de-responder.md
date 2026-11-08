# RFC 052 — Caixa de Entrada organizada por "de quem é a vez"

Data: 06/11/2026. Status: decidida pela [ADR 065](../adr/065-caixa-de-entrada-por-vez-de-responder.md) em 08/11/2026.
Motivo: conversas esquecidas na Caixa de Entrada (relato do proprietário).
Relaciona: [ADR 009](../adr/009-regras-de-transferencia-e-teto-do-bot.md),
[ADR 015](../adr/015-conversa-nao-volta-para-o-bot.md),
[ADR 059](../adr/059-central-de-acoes-e-performance-comercial.md),
[ADR 061](../adr/061-metricas-de-expediente-perda-e-presenca.md),
[ADR 065](../adr/065-caixa-de-entrada-por-vez-de-responder.md),
[runbook de prioridades](../runbooks/inbox-prioridades.md) (INBOX-UX-02/05/06),
[ACT-05/06 e MET-07/08](../../.specs/features/dashboard-actions/spec.md).

## Problema

A lista hoje mistura três eixos diferentes num mesmo lugar: atalhos de fila
(Atender / Fechar pedidos / Todas), Situação (aguardando vendedor, com o
agente, com vendedor, arquivadas) e Responsável. Nenhum deles responde à
pergunta que o vendedor faz ao abrir a tela: **"quem está esperando a Silmer
responder?"**.

A ordem de urgência de Todas (`URGENCY_RANK` em
`modules/inbox-channels/src/adapters/postgres-inbox-read-repository.js`)
explica onde as conversas se perdem:

1. **Agente parado afunda.** Conversa com o agente cai no grupo 5, ordenada
   pela data de abertura da conversa, mesmo quando a última mensagem é do
   cliente e o agente não respondeu. O painel já conta esse caso
   (`assistant_stalled_count`), mas a lista não o destaca.
2. **Grupo 4 ordena por abertura, não por atividade.** Conversa humana sem
   espera registrada (legado, ou tomada sem evidência de início) fica atrás
   de conversas antigas, ainda que o cliente tenha escrito agora.
3. **Silêncio do cliente não tem lugar.** Quando a Silmer falou por último e
   o cliente sumiu, a conversa não aparece em nenhuma fila da inbox. A
   retomada de 72h (ACT-06) existe só na Central de ações.
4. **Perda declarada não tem lugar.** A perda com motivo (MET-07) é gravada,
   mas a inbox não separa os perdidos das conversas em andamento.

## Proposta

Cada conversa aberta pertence a **exatamente uma** aba, calculada pela
última mensagem efetiva e pelo estado de atendimento. As abas substituem os
atalhos atuais; Responsável vira um seletor independente.

| Aba                    | Regra (vez de quem)                                                                                                                                                          | Ordem                                    | Ação principal                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------- |
| **Responder**          | Vez da Silmer: última mensagem efetiva é do cliente, ou handoff pendente, ou falha/resultado incerto de envio, ou agente sem responder há mais de `ASSISTANT_STALL_MINUTES`. | Maior espera primeiro; falhas no topo.   | Assumir / Responder                 |
| **Aguardando cliente** | Vez do cliente: última saída efetiva é da Silmer (vendedor ou agente) há menos de 72h, ou agente ainda dentro da janela de resposta.                                         | Atividade mais recente primeiro.         | Abrir; Adiar (ACT-05)               |
| **Sem retorno**        | Vez do cliente há 72h ou mais (mesmo prazo da ACT-06), sem perda declarada.                                                                                                  | Silêncio mais antigo primeiro.           | Retomar · Adiar · Marcar perdido    |
| **Perdidos**           | Perda ativa em `crm.lead_outcome_events` (MET-07).                                                                                                                           | Declaração mais recente; chip de motivo. | Abrir; Corrigir (reabertura manual) |

Encerradas e Arquivadas saem das abas e ficam em "Mais › Encerradas /
Arquivadas", como consulta.

Regras que tornam as abas confiáveis:

- **Mensagem efetiva** é outbound com `sent|delivered|read` e autoria humana
  ou, em atendimento pelo agente, a resposta do agente. Em atendimento humano
  só a resposta humana muda a vez (mesma regra de INBOX-UX-02); `system` nunca
  conta, e aviso automático não tem marca própria. Inbound do cliente não é
  efetiva: é ela que pede a vez da Silmer. Falha ou resultado incerto mantém a
  vez com a Silmer e prevalece sobre qualquer outra aba.
- **Mensagem nova do cliente** leva a conversa para Responder, inclusive de
  Sem retorno e de Perdidos (a reabertura de perda já é derivada pela MET-07).
- **Sem retorno não é perda.** O sistema continua sem inferir perda
  (ADR 061); só a declaração humana move para Perdidos.
- **Adiar** (lembrete ACT-05) é por pessoa (D2): tira a conversa de Sem retorno
  só de quem adiou, que a vê em Aguardando até o prazo. Para os demais ela
  segue em Sem retorno, com o selo "Lembrete". O lembrete vencido a devolve.
  Adiar nunca esconde conversa em Responder.

### Responsável e "Pedido pronto"

- Seletor **Todos · Minhas · Sem dono**, salvo por navegador, aplicado a
  todas as abas e aos contadores. Padrão: Todos, preservando a decisão de
  22/10/2026 (todos veem tudo; quem responde primeiro vira dono; demais
  bloqueados).
- **Fechar pedidos** deixa de ser fila e vira o chip "Pedido pronto",
  combinável com qualquer aba, mais o selo no card. O critério de prontidão
  não muda.

### Card

Linha 1: nome, canal e há quanto tempo a vez é de quem — em minutos de
expediente via `crm.business_minutes_v1` (ADR 061). Em Responder o tempo fica
em destaque de alerta acima de 15 minutos de expediente, o mesmo limiar de
"sem resposta" das métricas. Acima de 24 h corridas, o tempo aparece em dias
corridos ("2 d"), e o tempo de expediente fica só abaixo disso (D4). Com 0 min
de expediente fora do expediente, aparece "fora do expediente" no lugar de
"0 min" (D3). O alerta não depende do formato exibido e segue nos 15 min de
expediente. O cliente só projeta o avanço do relógio entre recargas da lista,
a partir do instante do cálculo; a função SQL `crm.business_minutes_v1` continua
sendo a referência (ADR 061). Linha 2: prévia da última mensagem (já
decifrada pela leitura atual da lista) e um selo de contexto: Agente parou,
Falha de envio, Urgente, Pedido pronto, dono.

### Por que não "mais recente primeiro" em tudo

Ordenar a fila de resposta pela mensagem mais recente (como o WhatsApp) faz
cada mensagem nova empurrar para baixo quem espera há mais tempo, e é
exatamente assim que uma conversa é esquecida. Em Responder a ordem é pela
espera; nas abas em que a vez é do cliente, a atividade recente é a ordem
natural.

## Contrato e implementação

- `GET /api/v1/inbox/conversations?bucket=respond|awaiting|silent|lost`
  com `owner=all|mine|unassigned` e `orderReady=true` opcional. Filtros,
  ordem e total são calculados em SQL antes de LIMIT; cursor assinado
  vinculado a ator, aba, responsável e ordem (mesmo padrão de INBOX-UX-05).
- `GET /api/v1/inbox/buckets?owner=…` devolve as quatro contagens num único
  snapshot, para os contadores e para o SSE topic `inbox` invalidar.
- A aba é derivada em leitura, sem novo estado de conversa (alternativa
  rejeitada na ADR 061). Primeira fatia reutiliza os `LATERAL` existentes
  (`human_reply`, `successful_outbound`, `last_outbound`) e a última inbound.
  Se o p95 da lista passar de 300 ms no volume real, uma migration expand
  desnormaliza `last_inbound_at` e `last_effective_outbound_at` em
  `crm.conversations` com índice parcial para conversas abertas, gravados na
  mesma transação da mensagem e com backfill. Numerar a migration a partir de
  `origin/master` (0063 está reservada). A migration de desnormalização
  continua condicionada ao p95 no volume real; a fatia INBOX-VEZ-01 não tem
  migration ([ADR 065](../adr/065-caixa-de-entrada-por-vez-de-responder.md)).
- 72h e `ASSISTANT_STALL_MINUTES` vêm das constantes já usadas pela Central
  de ações e pelo painel; uma fonte por limiar.
- Compatibilidade: `workQueue`, `sort=urgency`, `?fila=` e `?situacao=`
  continuam aceitos e são mapeados (attention → Responder com Minhas + Sem
  dono; closing → chip Pedido pronto). Rollback volta o frontend primeiro.

## Acessibilidade

Abas com `role="tablist"`, setas para navegar, contador no nome acessível
("Responder, 12 conversas"). Troca de aba mantém o rascunho e devolve o foco
à lista. No celular as quatro abas cabem em duas linhas a 320px, sem rolagem
horizontal. Ações de Sem retorno são botões reais com rótulo; Marcar perdido
abre o diálogo existente de motivo obrigatório.

## Fora de escopo

Inferir perda, prazo ou interesse pelo texto; voltar conversa ao agente
(ADR 015); mudar a regra de posse (ADR 009); SLA com alerta sonoro;
presença (MET-09, backlog); nova infraestrutura.

## Fatias sugeridas

1. **INBOX-VEZ-01 — API:** `bucket`, `owner`, contagens, testes unitários e
   live PostgreSQL (agente parado, falha após inbound, 72h exatos, perda
   reaberta por inbound, cursor por aba/ator).
2. **INBOX-VEZ-02 — UI:** abas, seletor de responsável, card novo, chip
   Pedido pronto, mapeamento das URLs antigas, E2E e axe.
3. **INBOX-VEZ-03 — Sem retorno e Perdidos:** Retomar, Adiar e Marcar
   perdido dentro da inbox, reaproveitando ACT-05 e MET-07.

## Como medir

Antes e depois, por semana: conversas em Responder há mais de 15 minutos de
expediente (retrato e episódios da MET), maior espera aberta, conversas em
Sem retorno sem decisão por mais de 24h e conversas com agente parado. Sem
pesquisa com vendedores reais, o ganho de usabilidade continua hipótese.

## Decisões do PO (08/11/2026)

Recomendações aceitas pelo PO:

- **D1.** `?situacao=atender` abre Responder com Responsável Todos.
- **D2.** Lembrete é por pessoa. Adiar tira a conversa de Sem retorno só de quem
  adiou (ela vai para Aguardando até o prazo). Para os demais segue em Sem
  retorno, com o selo "Lembrete".
- **D3.** Em Responder, 0 min de expediente fora do expediente mostra "fora do
  expediente" no lugar de "0 min". O alerta segue nos 15 min de expediente.
- **D4.** Acima de 24 h corridas, o tempo aparece em dias corridos ("2 d"); o
  tempo de expediente fica só abaixo disso.
- **D5.** Selo de dono: "Com {nome}" só para conversa de outra pessoa; "Sem dono"
  só sem dono e fora do agente.
- **D6.** Celular: abas 2×2 mantidas; botão Filtros na mesma linha da busca.
- **D7.** Encerradas usa `terminal=true`, implementado em INBOX-VEZ-01.
- **D8.** Selo "Assumir" (tom `warning`) quando há transferência pendente sem
  dono. O sinal "Nova" do master passa a ser esse mesmo selo.
- **D9.** Reabrir abre um diálogo curto de confirmação rotulado "Corrigir perda".
- **D10.** `?situacao=agente` abre Aguardando; `?situacao=aguardando` abre Responder.

## Decisões pedidas ao PO

1. Aceitar as quatro abas e a retirada de Fechar pedidos como fila.
2. Padrão do seletor de responsável: Todos (proposto) ou Minhas + Sem dono.
3. Limiar de Sem retorno: 72h corridas (igual ACT-06, proposto) ou em
   horas de expediente.
