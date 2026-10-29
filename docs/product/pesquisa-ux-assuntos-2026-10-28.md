# Pesquisa de UX sintética: assuntos das mensagens na Caixa de Entrada (28/10/2026)

> **Método:** estudo de usabilidade sintético. Quatro personas fazem, em
> think-aloud simulado, quatro tarefas sobre a interface real de
> `apps/edge-web/src` (build de 28/10), com a API simulada por Playwright e
> dados sintéticos, em 1366×768 e 390×844. Depois vêm uma avaliação heurística
> (Nielsen, carga cognitiva e acessibilidade, severidade de 0 a 4) e a
> comparação de três alternativas com as mesmas tarefas.
> **Limite:** não substitui teste com vendedores reais da Silmer. Os tempos
> são estimativas de especialista (contagem de ações e de leitura), não
> medições. Os achados de severidade 4 e as escolhas de comportamento do
> agente precisam ser confirmados pelo PO antes de virar requisito.
> **Pedido do PO:** a marcação de assuntos é "funcional e técnica demais, mas
> não clara para o vendedor"; deve aparecer **só quando o agente não tiver
> certeza do assunto**, para o vendedor fazer a ligação.
> **Requisitos:** [CP-11 a CP-18](../../.specs/features/cliente-pedido-assuntos/spec.md),
> [ADR 032](../adr/032-separar-pedido-conversa-e-assunto.md),
> [ADR 015](../adr/015-conversa-nao-volta-para-o-bot.md).

## Estado do código no momento do estudo

- **Interface (commit `c6dac0c`):** cada mensagem ganha um `<details>`
  "Assuntos desta mensagem" com caixas de seleção e o botão "Salvar assuntos"
  sempre que a conversa tem um assunto ou mais e quem vê pode gerir a conversa
  (`InboxView.vue:2116-2148`, condição `canClose && subjectState.subjects.length`).
  Quem só pode ler vê "Assuntos: …" (`InboxView.vue:2149-2151`). O painel
  Detalhes › "Assuntos deste atendimento" lista, seleciona e cria assuntos
  (`InboxView.vue:2285-2361`).
- **Agente (n8n `k7tI6T4RhQPyJkn9`):** escolhe o alvo de forma determinística
  (`mvp-simple.sdk.js:893-901`). Se o texto pede pedido novo, há mais de um
  vínculo, conflito com a escolha do vendedor ou nenhum alvo, transfere com o
  gatilho `subject_ambiguous` e o motivo `low_confidence` (`:1362`, `:1377`).
  Ao cliente, diz "Para não misturar seus pedidos, vou pedir que um vendedor
  continue seu atendimento." (`:1400`). Hoje o agente só liga as próprias
  respostas.
- **Mudança em andamento, ainda não commitada (vista no worktree em 28/10):**
  migração `0045_message_subject_reviews.expand.sql`, `subject-service.js` e
  `openapi.v1.yaml` acrescentam `links[].assignedByKind` e
  `needsSubjectMessageIds`. Com isso, o agente passa a registrar o assunto das
  mensagens recebidas quando o alvo é inequívoco e marca para revisão as
  ambíguas. A decisão humana resolve a revisão e não devolve a conversa ao
  bot. Este estudo usa esse contrato nas recomendações e aponta uma lacuna
  nele (UXA-14).

## Personas

| Persona | Papel | Cenário | Dor principal com assuntos |
| --- | --- | --- | --- |
| Camila, 27 | Atendente/vendedora experiente | 8 h/dia na Caixa de Entrada, notebook 1366×768 | Quer responder rápido; cada linha a mais no histórico atrasa a leitura |
| Bruno, 22 | Vendedor na primeira semana | Celular 390×844 no balcão, notebook à tarde | Não sabe o que é "assunto"; tem medo de "salvar" algo errado e estragar o pedido |
| Sílvio, 52 | Dono/gestor (admin) | Celular entre visitas; entra na conversa quando o agente para | Quer entender em 5 s por que o agente parou e se precisa agir |
| Helena, 41 | Coordenadora comercial (admin), auditoria | Desktop, revisa conversas da semana | Precisa saber quem ligou cada mensagem a cada pedido, e quando |

## Cenários e tarefas

Dados sintéticos, cliente "Studio Malu (teste)", pedidos fictícios.

| Cenário | Conteúdo |
| --- | --- |
| **A** — 1 assunto | Pedido 14-CRM; 6 mensagens (cliente, agente e vendedora); o agente ligou suas 2 respostas ao 14-CRM |
| **B** — 2 pedidos + 1 geral | 14-CRM (camisetas), 15-CRM (bonés, "Atual" escolhido pela vendedora) e "Assunto sem pedido 3"; mensagens intercaladas, uma delas fala dos dois pedidos ("Nas camisetas, troca o M por G. E nos bonés a logo é bordada.") e outra é dúvida geral ("vocês emitem nota fiscal?") |
| **C** — depois de `subject_ambiguous` | 14-CRM pendente; o cliente diz "Agora também quero 30 bonés pro time."; o agente transfere. Visto pelo vendedor da fila, pelo admin e pela vendedora depois de assumir (C2) |

| Tarefa | Enunciado ao participante |
| --- | --- |
| T1 | "Responda o cliente." |
| T2 | "O cliente falou de dois pedidos na mesma mensagem. Garanta que o agente não misture." |
| T3 | "Esta mensagem foi ligada ao pedido errado. Corrija." |
| T4 | "Entenda por que o agente parou." |

### Capturas (não versionadas)

Pasta: `C:\Users\sutil\AppData\Local\Temp\claude\C--Users-sutil-dev-Pessoal-crm-silmer\aadfb897-fea8-4ca8-b69a-87b850c8ce3c\scratchpad\ux-subjects\shots\`

| Arquivo | O que mostra |
| --- | --- |
| `A-vendedor-desk-1-thread.png`, `A-vendedor-mob-1-thread.png` | Conversa com 1 assunto: "Assuntos desta mensagem" em todas as 6 mensagens |
| `B-vendedor-desk-1-thread.png`, `B-vendedor-mob-1-thread.png` | Rótulo de pedido só nas mensagens do agente/vendedora; as do cliente sem rótulo |
| `B-vendedor-desk-2-details-open.png`, `B-vendedor-mob-2-details-open.png` | Formulário aberto: "Marque todos os assuntos mencionados", "Assunto sem pedido 3" |
| `B-vendedor-desk-3-panel.png`, `B-vendedor-mob-3-panel.png` | Painel "Assuntos deste atendimento" com 4 caminhos de ação |
| `B-vendedor-desk-5-after-save-200.png` | Depois de "Salvar assuntos": nenhuma confirmação visível |
| `C-vendedor-desk-1-thread.png`, `C-vendedor-mob-1-thread.png` | Parada por ambiguidade vista pelo vendedor: "Agente sem confiança" |
| `C-admin-desk-1-thread.png`, `C-admin-desk-2-details-open.png` | Mesma parada vista pelo admin: controles completos em toda mensagem |
| `C2-vendedor-desk-2-details-open.png` | Depois de assumir: a mensagem dos bonés só oferece "Pedido 14-CRM" |

Roteiros: `…\scratchpad\ux-subjects\capture.mjs`, `measure.mjs`,
`feedback.mjs`, `mobpanel.mjs`. O selo "Reconectando…" nas capturas vem do
mock de SSE, que fecha o fluxo, e não é achado. A caixa que volta desmarcada
em `B-…-5-after-save` também vem do mock estático.

## Walkthroughs (think-aloud simulado)

### T1 — "Responda o cliente"

- **Camila (desktop, B):** "Tem 'Assuntos desta mensagem' embaixo de tudo,
  até da minha própria mensagem. Ignoro." Lê, responde e envia. Ela pula o
  ruído, mas cada balão fica 28 px mais alto e a conversa mostra 3 mensagens
  em vez de 4 acima do composer (`B-vendedor-desk-1-thread.png`). Pelo
  teclado, cada mensagem acrescenta uma parada de Tab: 7 antes de chegar ao
  campo de resposta. **Tempo estimado:** 25–40 s (sem os controles: 20–30 s).
- **Bruno (celular, A):** "Assuntos desta mensagem… preciso preencher isso
  antes de responder?" Abre o primeiro e vê uma única caixa "Pedido 14-CRM",
  desmarcada. "Se está desmarcada, a mensagem não é do pedido? Marco?" Marca,
  salva e não vê confirmação. Só então responde. **Erro:** classificou uma
  mensagem sem necessidade, em conversa de um pedido só. **Tempo:** 90–150 s.
- **Sílvio (celular, C):** vê o aviso no lugar do composer e responde depois
  de "Assumir atendimento". Os assuntos não atrapalham, porque como vendedor
  da fila ele não vê o controle. Como admin, vê 4 controles abertos em uma
  conversa que ainda não assumiu (`C-admin-desk-1-thread.png`).

### T2 — "O cliente falou de dois pedidos; garanta que o agente não misture"

- **Camila (desktop, C2, depois de assumir):** abre "Assuntos desta mensagem"
  na mensagem dos bonés e só encontra "Pedido 14-CRM"
  (`C2-vendedor-desk-2-details-open.png`). "Cadê o pedido dos bonés?" Abre
  Detalhes e vê "Novo assunto sem pedido", "Buscar pedido pelo número",
  "Vincular pedido" e "Criar assunto do pedido" (desabilitado). "Os bonés
  ainda não têm pedido… então é 'sem pedido'?" Cria "Assunto sem pedido 2",
  volta à mensagem, reabre o `<details>`, marca e salva. **Ações:** cerca de
  12. **Tempo:** 2–4 min.
  - **Interpretação errada:** acha que salvar "devolve" a conversa ao agente
    já separada. Não devolve (ADR 015): o agente já parou e não volta.
    "Garantir que o agente não misture" já estava garantido pela parada; o
    trabalho dela serviu ao histórico, e a interface não diz isso.
- **Bruno (celular, B):** na mensagem "Nas camisetas, troca o M por G. E nos
  bonés a logo é bordada." lê "Marque todos os assuntos mencionados". "Todos?
  Então marco os três?" Marca 14, 15 e "Assunto sem pedido 3". **Erro:** o
  "3" parece "o terceiro assunto mencionado", e não a posição do assunto na
  conversa (`InboxView.vue:1221`). As caixas têm 13 px e a linha clicável,
  21 px: duas tentativas para acertar no celular. **Tempo:** 60–120 s, com
  erro.
- **Helena (desktop, B):** faz certo (14 + 15), mas pergunta: "o agente vai
  usar isso ou só eu?" A tela não responde.

### T3 — "Corrija um vínculo errado"

- **Camila (desktop, B):** a resposta do agente "O pedido 14-CRM está com a
  vendedora…" está ligada ao 14-CRM, mas o cliente falava dos bonés. Ela
  abre o `<details>` da mensagem do agente, desmarca 14, marca 15 e salva.
  Não vê confirmação: o aviso "Assuntos da mensagem salvos." fica no painel
  Detalhes, que está fechado (verificado: `aside[hidden]`, mensagem
  invisível). O foco cai no `<body>`, porque o botão é desabilitado durante o
  envio. Ela salva de novo "por garantia". **Tempo:** 40–70 s.
- **Bruno (celular):** tenta corrigir pelo painel com "Selecionar" ao lado de
  "Pedido 15-CRM", achando que muda a mensagem. Muda o "Atual" da conversa,
  que é outra coisa: decide qual pedido o agente usa (regra 2 do alvo).
  **Erro de modelo mental**, sem aviso do efeito colateral.
- **Sílvio (celular):** desiste. "Não vou mexer nisso pelo celular."

### T4 — "Entenda por que o agente parou"

- **Sílvio (celular, C):** lê "Agente sem confiança · Esperando vendedor há
  14min" (`C-vendedor-mob-1-thread.png`). "Sem confiança em quê? Deu pau?"
  Precisa ler a última mensagem do agente ao cliente ("Para não misturar seus
  pedidos…") para deduzir. O motivo exato que o workflow grava, "Mensagem
  pede outro pedido ou tem alvo indefinido" (`mvp-simple.sdk.js:1411`,
  `:1481`), fica criptografado no handoff, e nenhuma tela o mostra (`/handoffs`
  redireciona para `/inbox`, `router.js:34-36`). **Tempo:** 20–40 s, com
  dedução incerta. Taxa de acerto estimada: baixa para Bruno, média para
  Sílvio.
- **Helena (auditoria, B):** quer saber se o vínculo 14-CRM da mensagem b2 foi
  do agente ou da Camila. A tela não distingue (a mudança em andamento expõe
  `assignedByKind` na API, mas não diz quem nem quando). **Falha** na tarefa.

## Achados (severidade 0–4)

| ID | Sev. | Heurística | Achado | Evidência |
| --- | --- | --- | --- | --- |
| UXA-03 | **4** | Visibilidade do estado; correspondência com o mundo real | A parada por ambiguidade aparece como "Agente sem confiança", igual a "não entendeu duas vezes" ou "cliente ignorou". O vendedor não sabe que o problema é qual pedido, e "sem confiança" soa como defeito. O resumo específico existe, mas não é exibido. | `order-format.js:31`; `mvp-simple.sdk.js:1377`, `:1411`, `:1481`; `router.js:34-36`; `C-vendedor-*-1-thread.png` |
| UXA-01 | 3 | Estética e minimalismo; carga cognitiva | Um controle de classificação em **toda** mensagem, inclusive em conversa de um assunto só (A), onde não há decisão a tomar. Cada balão cresce 28 px; uma parada de Tab por mensagem (7 em B). | `InboxView.vue:2116-2117`; `A-*-1-thread.png`; medição em `measure.mjs` |
| UXA-02 | 3 | Correspondência; prevenção de erro | Hoje os rótulos de pedido aparecem só nas mensagens do agente e da vendedora, e as do cliente, que são as que importam, ficam vazias. Uma caixa desmarcada lê como "não é deste pedido". | `InboxView.vue:2121-2124`; `B-*-1-thread.png` |
| UXA-04 | 3 | Linguagem do usuário; consistência | "Assunto" não está no glossário. "Marque todos os assuntos mencionados" pede um julgamento ("mencionado"?). "Salvar assuntos" não diz o efeito. "Assunto sem pedido 3" usa a posição na conversa e parece contagem. "Atual" e "Selecionar" não dizem que mudam o pedido que o agente usa. | `InboxView.vue:1218-1222`, `:2127`, `:2146`, `:2298-2308`; `docs/product/GLOSSARIO.md` (sem a entrada) |
| UXA-05 | 3 | Visibilidade do estado; a11y (WCAG 4.1.3, 2.4.3) | O sucesso e o erro de "Salvar assuntos" são escritos no painel Detalhes, que fica oculto por padrão abaixo de 1440 px: nem quem enxerga nem o leitor de tela recebem a mensagem. O foco cai em `<body>`, porque o botão é desabilitado durante o envio. | `InboxView.vue:2143`, `:2263`, `:2289-2290`, `:1193-1204`; `B-vendedor-desk-5-after-save-200.png`; `feedback.mjs` |
| UXA-06 | 3 | Flexibilidade; controle do usuário | A tarefa "dois pedidos na mesma mensagem" não se resolve na mensagem, porque ela só oferece assuntos que já existem. Separar o pedido novo exige ir a Detalhes, escolher entre 4 caminhos, voltar e reabrir: cerca de 12 ações. | `InboxView.vue:2128-2139`, `:2311-2356`; `C2-vendedor-desk-2-details-open.png` |
| UXA-12 | 3 | Prevenção de erro (agente) | O regex de pedido novo dispara com "também quero"/"agora quero" mesmo dentro do mesmo pedido ("também quero a logo nas costas"), gerando transferências desnecessárias. Além disso, a parte "pergunta" do CP-16 nunca acontece: o agente sempre transfere. | `mvp-simple.sdk.js:893`, `:1358`, `:1362`, `:1400` |
| UXA-14 | 3 | Cobertura do caso principal | No contrato em andamento, `needsSubjectMessageIds` só é preenchido com **dois ou mais** assuntos. O cenário C (um pedido + "também quero bonés"), que é o gatilho mais provável de `subject_ambiguous`, nunca faria a pergunta ao vendedor. | `openapi.v1.yaml` (diff local, `ConversationSubjects.needsSubjectMessageIds`); `subject-service.js` (diff local, `subjects.rows.length >= 2`) |
| UXA-08 | 3 (celular) / 1 (desktop) | A11y: alvo de toque | Caixa de seleção de 13×13 px e linha clicável de 21 px de altura, abaixo da meta de 44 px no celular; o `summary` tem 28 px no desktop (`min-block-size: 0`). No celular o `summary` perde o triângulo e parece texto solto. | `70-inbox.css:654-677`; medição em `measure.mjs`; `B-vendedor-mob-1-thread.png` |
| UXA-07 | 2 | Minimalismo; reconhecimento | O painel tem quatro caminhos sem hierarquia (Novo assunto sem pedido / Buscar / Vincular / Criar assunto do pedido). "Criar assunto do pedido" fica desabilitado sem dizer o porquê, e buscar exige Buscar → escolher → Criar. | `InboxView.vue:2311-2360`; `B-*-3-panel.png` |
| UXA-09 | 2 | Auditoria; visibilidade | A interface não mostra se um vínculo é do agente ou de uma pessoa, nem quem fez e quando (CP-12 pede auditoria). | `InboxView.vue:1225-1236`; `0037_conversation_subjects.expand.sql:44-55` |
| UXA-10 | 2 | Consistência entre papéis | Na mesma parada, o vendedor da fila vê só "Assuntos: Pedido 14-CRM", sem pista de que terá de decidir, e o admin vê os controles completos em todas as mensagens antes de assumir. | `InboxView.vue:316-320`, `:2149-2151`; `C-vendedor-*` vs `C-admin-*` |
| UXA-11 | 2 | Modelo mental | O cabeçalho mostra um único "Pedido 15-CRM" (`active.order`) mesmo com dois pendentes na conversa, o que reforça "uma conversa, um pedido" e contradiz a lista de assuntos. | `InboxView.vue:1868-1880`; `B-vendedor-desk-1-thread.png` |
| UXA-13 | 2 | Agente: contexto | Com dois assuntos ou mais, o agente recebe o histórico recente vazio e pode repetir perguntas já respondidas. | `mvp-simple.sdk.js:907` |

## Alternativas comparadas

### (a) Pergunta inline só na mensagem marcada

```
┌ Studio Malu (teste) · Cliente ─────────────── 22:05 ┐
│ Depois te passo. Agora também quero 30 bonés pro    │
│ time.                                               │
│ ┌ ? A qual pedido esta mensagem se refere? ───────┐ │
│ │ O agente parou aqui para não misturar pedidos.  │ │
│ │ [14-CRM · Camisetas escola] [Um pedido novo]    │ │
│ │ [Mais de um]  [Nenhum pedido]                   │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### (b) Chip discreto com o pedido usado e "Corrigir"

```
│ Nas camisetas, troca o M por G.                     │
│ ⌁ 14-CRM · pelo agente   [Corrigir]                 │
```

### (c) Faixa única na conversa quando o agente parou

```
┌──────────────────────────────────────────────────────┐
│ O cliente falou de outro pedido                      │
│ O agente parou para não misturar com o 14-CRM.       │
│ Esperando vendedor há 14 min.  [Assumir atendimento] │
└──────────────────────────────────────────────────────┘
```

### Avaliação com as mesmas tarefas (estimativa)

| Tarefa | Atual | (a) inline | (b) chip | (c) faixa | **Recomendada (c + a, com b só quando há 2 ou mais)** |
| --- | --- | --- | --- | --- | --- |
| T1 responder | 25–40 s; ruído em todas as mensagens; Bruno classifica sem necessidade | 20–30 s; nada a ver se não há dúvida | 22–35 s; um chip por mensagem com 2 ou mais pedidos | 20–30 s | **20–30 s**, sem ruído com 0 ou 1 assunto |
| T2 dois pedidos | ~12 ações, 2–4 min; Bruno erra | 1–3 toques, 10–20 s; "Um pedido novo" resolve o caso C | Não resolve: não sabe qual mensagem precisa de decisão | Diz o porquê, mas não onde decidir | **1–3 toques**, com o porquê já lido na faixa |
| T3 corrigir | 4 ações, sem confirmação; Bruno usa "Selecionar" por engano | Não cobre mensagens já classificadas | 2–3 toques, com confirmação ao lado | Não cobre | **2–3 toques via chip** (só com 2 ou mais pedidos); com 1 pedido, não há o que corrigir |
| T4 por que parou | Deduz pela mensagem ao cliente; "sem confiança" engana | Parcial (só ao rolar até a mensagem) | Não cobre | **5 s**, motivo explícito | **5 s** |
| Auditoria (Helena) | Falha | Parcial | "pelo agente/por Camila" + data no detalhe | Não cobre | **Cobre** pelo chip e pelo detalhe |

**Conclusão:** nenhuma alternativa sozinha cobre as quatro tarefas. (c)
explica a parada, (a) é o único lugar em que o vendedor decide, e (b) é
necessária só para corrigir e auditar quando há mais de um pedido.

## Recomendação

### Regras de exibição

1. **Nenhum controle por mensagem por padrão.** O `<details>` atual sai de
   todas as mensagens.
2. **Conversa com 0 ou 1 assunto e sem revisão aberta:** nada aparece nas
   mensagens. **Nunca perguntar** quando o agente teve certeza: com um pedido
   só, tudo é dele. O painel mostra só o pedido.
3. **Revisão aberta** (mensagem em `needsSubjectMessageIds`): a pergunta
   inline (a) aparece **só nessa mensagem do cliente** e só para quem pode
   gerir a conversa (dono ou admin). **Vale também com 1 assunto** quando o
   motivo for pedido novo (corrige UXA-14), porque "Um pedido novo" é a
   resposta esperada.
4. **Antes de assumir (handoff pendente):** a faixa (c) explica a parada; a
   pergunta não aparece para quem ainda não assumiu, nem para o admin
   (consistência entre papéis, UXA-10). Texto de apoio na faixa: "Ao assumir,
   indique a qual pedido a mensagem se refere."
5. **Dois assuntos ou mais:** um chip discreto (b) aparece nas mensagens **do
   cliente** que têm vínculo, com "Corrigir". Mensagens do agente e do
   vendedor não mostram chip: o pedido delas já é o da conversa naquele
   momento.
6. **Somem:** a pergunta, assim que respondida, quando a conversa é
   encerrada, ou quando uma pessoa já ligou a mensagem (CP-14: decisão humana
   vence e não volta a ser perguntada). O chip some se a conversa voltar a ter
   um assunto só.
7. **Somente leitura:** quem não pode gerir vê o chip sem "Corrigir" e, na
   mensagem marcada, "Aguardando o vendedor indicar o pedido."

### Microcopy (PT-BR)

**Faixa da parada (substitui "Agente sem confiança" quando o gatilho é `subject_ambiguous`):**

| Situação | Título | Detalhe |
| --- | --- | --- |
| Pedido novo na conversa | O cliente pediu outro pedido | O agente parou para não misturar com o {14-CRM}. Esperando vendedor há {14 min}. |
| Mais de um pedido na mesma mensagem | O cliente falou de mais de um pedido | O agente parou para não misturar. Esperando vendedor há {14 min}. |
| Conflito com a escolha do vendedor / sem alvo | O agente não sabe a qual pedido responder | Esperando vendedor há {14 min}. |
| Linha final, antes de assumir | — | Ao assumir, indique a qual pedido a mensagem se refere. |

Selo na lista de conversas: **"Pedido indefinido"**, no lugar de "Agente sem
confiança", só para esse gatilho.

**Pergunta inline (mensagem marcada, depois de assumir):**

- Título (`legend`): **"A qual pedido esta mensagem se refere?"**
- Apoio: **"O agente parou aqui para não misturar pedidos. Sua resposta
  organiza o histórico de cada pedido."**
- Escolha única, um toque por opção:
  - **"{14-CRM} · {nome do pedido}"**, um por pedido da conversa, com o nome
    do evento da ficha quando houver ("Camisetas escola"); sem nome, só o
    número.
  - **"Um pedido novo"**: cria o assunto e oferece "Criar pedido" logo em
    seguida (ver questão aberta 3).
  - **"Mais de um"**: abre caixas com os pedidos e o botão **"Ligar aos
    pedidos marcados"**.
  - **"Nenhum pedido"**: dúvida geral; resolve a revisão sem vínculo (o
    contrato em andamento já trata a lista vazia como decisão).
- Confirmação no lugar da pergunta, com `role="status"` **ao lado da
  mensagem** e não no painel: **"Ligada ao 14-CRM por você · Desfazer"**. O
  foco vai para "Desfazer" (corrige UXA-05).
- Erro no mesmo lugar: **"Não deu para salvar. A pergunta continua aqui;
  tente de novo."** Em 409: **"Outra pessoa já respondeu. Veja a escolha
  atual."**

**Chip (2 ou mais pedidos):** texto visível **"14-CRM"**; nome acessível
**"Pedido 14-CRM, ligado pelo agente"** ou **"…, ligado por Camila em 28/10 às
14:05"**; ação **"Corrigir"**, que abre as mesmas opções da pergunta, com a
atual marcada.

**Painel Detalhes:**

| Hoje | Proposto |
| --- | --- |
| Assuntos deste atendimento | Pedidos nesta conversa |
| Atual (selo) | O agente usa este |
| Selecionar | Usar este |
| Assunto sem pedido 3 | Outro assunto (sem pedido) — com data: "Outro assunto · 28/10" |
| Novo assunto sem pedido | Separar outro assunto |
| Buscar pedido pelo número + Vincular pedido + Criar assunto do pedido | Um campo só: **"Ligar um pedido existente"** (busca com lista), botão **"Ligar"** |
| Ainda não há assunto classificado. As mensagens permanecem no histórico. | Ainda não há pedido nesta conversa. |

Acrescentar **Assunto** ao `GLOSSARIO.md` como termo técnico: na interface do
vendedor se diz "pedido" ou "outro assunto"; evitar "assunto" sozinho,
"classificar", "tag" e "vincular".

### O que acontece depois que o vendedor responde

- **Com o ADR 015 vigente (recomendado agora):** a resposta grava o vínculo
  humano, resolve a revisão e, se for um pedido, torna esse pedido o que o
  agente usa ("Usar este") para o próximo ciclo. **O agente não volta a esta
  conversa**, e a interface não deve sugerir o contrário. O ganho é o
  histórico e o briefing de cada pedido corretos (CP-12, CP-15) e a auditoria.
- **Se o PO quiser que o agente continue depois da resposta** (o que o pedido
  original sugere): é preciso um novo estado, "agente pausado aguardando o
  vendedor indicar o pedido", que **não** seja handoff. O vendedor responde
  pela pergunta inline sem assumir, e o agente retoma no mesmo ciclo. Isso
  supersede em parte o ADR 015 e exige RFC e ADR novos, novo `reason`/estado,
  SLA e uma mensagem de espera ao cliente. Ver questão aberta 1.

### Agente × vendedor

- Vínculo do agente: chip neutro (contorno), texto "pelo agente".
- Vínculo de pessoa: chip preenchido, "por {nome}".
- Revisão aberta: pergunta com borda de atenção (`--status-warning`), nunca
  vermelha: é uma decisão, não um erro.
- A decisão humana nunca é sobrescrita pelo agente (já garantido no contrato
  em andamento) e nunca volta a ser perguntada.

### Acessibilidade obrigatória da solução

- A pergunta é um `fieldset` com `legend`; as opções de escolha única são
  `radio` estilizados ou botões em grupo com `aria-pressed`. Alvos de 44 px
  ou mais no celular e de 32 px ou mais no desktop.
- Uma parada de Tab por **mensagem marcada**, e não por mensagem.
- Atalho a partir da faixa: **"Ir para a mensagem"** leva o foco ao `legend`
  da pergunta.
- Confirmação e erro em `role="status"`/`role="alert"` dentro do balão. O foco
  nunca fica em controle desabilitado: usar `aria-disabled` e manter o foco
  no botão, como já faz "Assumir atendimento".

## Mudanças de comportamento do agente

1. **Registrar, não só transferir.** Ligar as mensagens recebidas quando o
   alvo é inequívoco e abrir revisão quando não é (o contrato em andamento já
   faz isso). Gravar também o **motivo** da revisão como código
   (`new_order`, `multiple_orders`, `conflict_with_seller`, `no_target`) para
   a faixa escolher o texto certo. Sem texto da mensagem nem PII.
2. **Perguntar ao cliente antes de transferir (CP-16, "pergunta").** Quando a
   dúvida é entre **pedidos que já existem** e têm nome reconhecível, o agente
   pergunta uma vez:
   > "Só para eu não misturar: você está falando do pedido das **camisetas da
   > escola** ou de outro pedido?"

   Se a resposta resolver (número, nome ou "esse mesmo"), o agente segue. Se
   não, transfere. Nunca perguntar com um pedido só e sem sinal de pedido
   novo. Usar o nome do evento da ficha, e não "14-CRM", que o cliente não
   conhece.
3. **Pedido novo: transferir com mensagem melhor.** Enquanto o agente não
   abre um segundo pedido na mesma conversa (CP-18), transferir com:
   > "Anotei que você também quer **bonés**! Para não misturar com o pedido
   > das camisetas, um vendedor vai continuar seu atendimento aqui mesmo."

   Se citar o produto for arriscado, usar a versão sem produto: "Anotei que
   você quer outro pedido! Para não misturar com o que já estamos fazendo, um
   vendedor vai continuar seu atendimento aqui mesmo." Trocar a frase atual
   ("Para não misturar seus pedidos, vou pedir que…"), que fala do problema
   interno e não do que o cliente pediu.
4. **Estreitar o gatilho de pedido novo** (`:893`): "também quero"/"agora
   quero" só contam com produto diferente do pedido em curso ou com "outro/
   novo pedido". Casos de teste: "também quero a logo nas costas" (não
   dispara), "também quero 30 bonés" com camisetas em curso (dispara),
   "quero outro pedido igual" (dispara).
5. **Motivo próprio para o vendedor.** O selo e a faixa precisam distinguir
   `subject_ambiguous` de `two_attempts`/`ignored_twice`, que hoje caem todos
   em `low_confidence`. Pode ser um novo `reason_code` (exige migração do
   CHECK das migrações 0013/0025) ou expor o `trigger`/código de revisão na
   leitura da conversa. A decisão técnica fica com o Tech Lead.
6. **Não zerar o contexto com dois assuntos ou mais** (`:907`): passar ao
   modelo as mensagens ligadas ao assunto-alvo, em vez de nenhuma.
7. **Respeitar a escolha humana (CP-14):** manter a regra atual (vínculo
   humano > "O agente usa este" > número citado > único pendente). A
   pergunta ao cliente nunca contraria uma escolha do vendedor.

## Questões abertas para o PO

1. **Depois que o vendedor indica o pedido, o agente volta a atender?** Hoje
   não volta (ADR 015). Se a resposta for sim, é preciso um estado "pausado
   para o vendedor indicar o pedido" que não seja handoff, com RFC e ADR
   novos que supersedam o ADR 015 em parte. Recomendação deste estudo: manter
   o ADR 015 agora e medir quantas paradas são por ambiguidade antes de
   decidir.
2. **O agente pode perguntar ao cliente antes de transferir?** No máximo uma
   vez, só entre pedidos que já existem (item 2 acima).
3. **"Um pedido novo" cria o pedido pendente na hora** ou só separa o assunto
   e deixa "Criar pedido" como passo seguinte?
4. **Corrigir vínculos antigos (chip "Corrigir")** fica para todo vendedor
   dono da conversa ou só para o admin?
5. **"Assunto" sai da interface do vendedor?** A proposta usa "pedido" e
   "outro assunto"; o termo continua no código, na API e no glossário técnico.
6. **"O agente usa este" vale para o próximo ciclo** da mesma conversa (CP-09)
   ou recomeça a cada ciclo?
7. **Vendedor da fila pode responder à pergunta sem assumir?** Hoje a regra é
   dono ou admin; a recomendação mantém "só depois de assumir".
8. **Classificação retroativa** das conversas antigas é necessária para a
   auditoria, ou vale só daqui em diante?

## Rastreabilidade

- Requisitos: CP-12 (mensagem pode ficar sem classificação; correção
  auditada), CP-14 (decisão humana vence), CP-15 (briefing por assunto),
  CP-16 (ambiguidade: perguntar ou transferir), CP-18 (contrato legado).
- Tarefa: CP-T03 (assuntos no CRM) e CP-T04 (contrato do agente), em
  `.specs/features/cliente-pedido-assuntos/tasks.md`.
- Estudo anterior: [pesquisa sintética de 15/10/2026](pesquisa-ux-sintetica-2026-10-15.md)
  (personas Camila e Sílvio) e [revisão heurística](REVISAO-HEURISTICA.md).
