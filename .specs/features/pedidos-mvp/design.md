# Pedidos MVP — Arquitetura

**Spec:** [`spec.md`](spec.md) · **Decisões:** [`context.md`](context.md)
**Status:** implementado; síntese atualizada em 05/10/2026
**Base:** PR 142 integrada, ADR 020; versões e evidências anteriores preservadas.

---

## Refinamento ADR 020

Técnica (tipo_servico) é ponto obrigatório por item; Estampa (referência) é adicional. Arte (artwork) pertence ao pedido e exige origem para gerar. Aplicação geral antiga permanece guardada sem uso na v5. Bot preenche técnica/origem inequívocas ainda vazias. O modelo SQL abaixo mostra as migrations originais; defaults e projeções atuais devem ser confirmados nas fontes, não deduzidos do snapshot.

## Visão geral

Um módulo novo, `modules/orders`, dono do agregado **Pedido**. Ele não reutiliza
`deals-pipeline`, `qualification` nem as tabelas `crm.deals*` (ADR 004). A API
expõe rotas de pedido no mesmo estilo das rotas de conversa; o n8n usa um
tipo de evento para criar o pendente; o feed ao vivo usa um tipo de evento
de pedido. No front, duas telas (lista e página), uma gaveta no inbox e a
troca do filtro "Situação" pelo filtro "Estado".

```mermaid
graph TD
  subgraph n8n
    WF[Workflow MVP]
  end
  subgraph API[apps/api]
    NR[n8n-routes<br/>order.intent_confirmed<br/>briefing_patch]
    OR[order-routes<br/>list · get · create · patch · confirm · reopen · print]
    CR[conversation-routes<br/>takeover · transfer · archive]
    OPR[operation-runtime<br/>listInbox + filtro pendingHandoff<br/>readLiveEvents]
    AUTH[identity-runtime<br/>OPERATIONAL_ACTIONS]
  end
  subgraph orders[modules/orders]
    SVC[OrderService]
    DOM[Order domain<br/>status · número · validação · totais]
    PRINT[ficha-canonical-v5 renderer]
    PG[PostgresOrderRepository]
  end
  subgraph db[(PostgreSQL)]
    TORD[crm.orders]
    TEV[crm.domain_events]
    TCONV[crm.conversations<br/>briefing_envelope]
    THAND[crm.handoffs]
  end
  subgraph web[apps/edge-web]
    INBOX[InboxView + OrderDrawer]
    LIST[OrdersView /pedidos]
    PAGE[OrderView /pedidos/:id]
  end

  WF --> NR --> SVC
  OR --> AUTH
  OR --> SVC
  SVC --> DOM
  SVC --> PG --> TORD
  PG --> TEV
  NR -. lê pré-ficha .-> TCONV
  OPR --> THAND
  OPR --> TEV
  INBOX --> OPR
  INBOX --> OR
  LIST --> OR
  PAGE --> OR
  OR --> PRINT
```

---

## Reuso de código

### O que aproveitar

| Existente                                                                       | Onde                                                                                                                                     | Como usar                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Estrutura de módulo `domain/ application/ ports/ adapters/`                     | `modules/inbox-channels/src/`                                                                                                            | Copiar a organização para `modules/orders/src/`.                                                             |
| Registro de rotas + `respond()` + `rejectUnknownKeys` + `authorizeHumanCommand` | `apps/api/src/conversation-routes.js`                                                                                                    | Mesmo formato para `order-routes.js`; posse = dono da conversa ou admin.                                     |
| Allowlist única de ações                                                        | `modules/identity-access/src/authorization.js` (`OPERATIONAL_ACTIONS`)                                                                   | Adicionar as ações `order.*` só aqui; `identity-runtime.js` já importa.                                      |
| Envelope cifrado JSON com AAD                                                   | `modules/n8n-integration/src/crypto.js` (`encryptJson`/`decryptJson`) e o uso local em `inbox-channels/.../postgres-inbox-repository.js` | Mesmo padrão para o conteúdo da ficha (tem nome, endereço, telefone).                                        |
| Pré-ficha do agente                                                             | `modules/n8n-integration/src/postgres-repository.js` (`#readBriefing`, `#mergeBriefing`)                                                 | Fonte para criar o pendente e para a projeção enquanto a conversa está com o agente.                         |
| Feed ao vivo por `crm.domain_events`                                            | `apps/api/src/operation-runtime.js` (`readLiveEvents`) + `live-event-dispatcher.js`                                                      | Gravar evento com `aggregate_type = 'order'` e mapear para `inbox.order.changed`.                            |
| Filtros do inbox no servidor                                                    | `apps/api/src/operation-runtime.js` (`listInbox`)                                                                                        | `automationState` já existe (Com o agente / Com vendedor). Adicionar `pendingHandoff` (Aguardando vendedor). |
| Idempotência de comandos                                                        | `commandKey` em `apps/edge-web/src/lib/api-client.js` e `Idempotency-Key` nas rotas                                                      | Criar, confirmar e reabrir são comandos idempotentes.                                                        |
| Template aprovado v2                                                            | `scripts/ficha-pdf-review.mjs` (`buildFichaHtml`)                                                                                        | Extrair para `modules/orders/src/print/` sem mudar a saída (teste golden).                                   |
| Tokens, `.surface`, `.data-table`, `.badge`, `button.primary`, `command-dialog` | `apps/edge-web/src/tokens.css`, `styles.css`, `screen-styles.css`                                                                        | Todas as telas novas usam só esses tokens (`npm run check:design-tokens`).                                   |
| Motivos de handoff                                                              | `crm.handoffs.reason_code` (migration `0013`)                                                                                            | Rótulos do motivo da parada no inbox (`context.md` A03).                                                     |

### Pontos de integração

| Sistema      | Integração                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| n8n          | Novo evento `order.intent_confirmed` em `POST /api/v1/integrations/n8n/events` (ação `order.intent`). `briefing_patch` segue igual; o CRM projeta no pendente. |
| Conversa     | `crm.orders.conversation_id` → `crm.conversations.id`. A posse vem de `conversations.assigned_user_id` + capability `COMMERCIAL_ADMIN`.                        |
| Contato      | Nome do cliente vem do contato atual da conversa (`contact_identities.current_contact_id`).                                                                    |
| Configuração | FAB de `FAB_CODE` (`.env.example:63`).                                                                                                                         |
| Feed ao vivo | `crm.domain_events` com `aggregate_type = 'order'`.                                                                                                            |

---

## Componentes

### Backend

#### `modules/orders/src/domain/order.js`

- **Propósito:** regras puras do Pedido.
- **Interfaces:**
  - `ORDER_STATUSES = ['pendente', 'confirmado']`
  - `PAYMENT_CONDITIONS = ['pix', 'cartao_credito', 'cartao_debito']`
  - `formatOrderNumber(sequence: number): string` → `01-CRM`, `12-CRM`, `105-CRM`
  - `confirmOrder(order, {amountCents, paymentCondition, actorId, now}): Order`
  - `reopenOrder(order, {actorId, now}): Order`
  - `recordMilestones(order, {paidOn, deliveredOn, now}): Order` — ADR 008;
    dia válido e não futuro em São Paulo, qualquer status (PLA-04, PLA-05)
  - `missingForConfirmation(order): string[]`
- **Depende de:** nada.

#### `modules/orders/src/domain/money.js`

- `parseBrlAmount(text: string): number` (centavos; recusa formato inválido)
- `formatBrlAmount(cents: number): string`

#### `modules/orders/src/domain/ficha.js`

- **Propósito:** forma e validação das seções impressas.
- `validateSummary(input)`, `validateItems(input)`, `validateObservations(input)`
- `itemTotal(item): number`, `orderTotal(items): number`
- `briefingToFicha(briefing): FichaDraft` — mapeia a pré-ficha do agente para
  as seções; campos desconhecidos vão para `serviceData` (só leitura).

#### `modules/orders/src/ports/contracts.js` + `adapters/in-memory-order-repository.js`

- Porta `OrderRepository`: `createPending`, `findById`, `findPendingByConversation`,
  `listByConversation`, `list({status, query, cursor, limit})`, `saveSection`,
  `saveStatus`, `saveMilestones`, `projectBriefing` — todas com
  `expectedVersion`. `createPending` recebe `firstContactAt` (ADR 008).

#### `modules/orders/src/application/order-service.js`

- `ensurePendingFromIntent({conversationId, correlation})` — idempotente (PCL-01..03)
- `createManual({conversationId, actor})` (PCL-10, PCL-11)
- `patchSection({orderId, section, value, expectedVersion, actor})` (PFI-06)
- `confirm({orderId, amountText, paymentCondition, expectedVersion, actor})` (PCL-04..09)
- `reopen({orderId, expectedVersion, actor})` (PCL-07, PCL-12)
- `recordMilestones({orderId, paidOn, deliveredOn, expectedVersion, actor})` (PLA-04..07)
- `projectAgentBriefing({conversationId, briefing, automationState})` (PAG-01, PAG-02)
- `get(orderId)`, `list(filters)`, `currentForConversation(conversationId)`

#### `modules/orders/src/adapters/postgres-order-repository.js`

- Implementa a porta; cifra `ficha_envelope`; grava `crm.domain_events`
  (`aggregate_type = 'order'`) na mesma transação de cada escrita.

#### `modules/orders/src/print/ficha-canonical-v2.js`

- `renderFichaHtml(snapshot, {synthetic: boolean}): string` — extraído de
  `scripts/ficha-pdf-review.mjs`; `synthetic:false` remove a faixa de amostra
  (PIM-04). O script de revisão passa a importar daqui.

#### `apps/api/src/order-routes.js` + `order-runtime.js`

| Método | Rota                                           | Ação                       | Req.                   |
| ------ | ---------------------------------------------- | -------------------------- | ---------------------- |
| GET    | `/api/v1/orders?status=&q=&cursor=&limit=`     | `order.read`               | PLI-02..07             |
| GET    | `/api/v1/orders/:orderId`                      | `order.read`               | PFI-01                 |
| GET    | `/api/v1/conversations/:conversationId/order`  | `order.read`               | PCX-06, PCX-07         |
| POST   | `/api/v1/conversations/:conversationId/orders` | `order.create` (posse)     | PCL-10, PCL-11         |
| PATCH  | `/api/v1/orders/:orderId/sections/:section`    | `order.edit` (posse)       | PFI-06                 |
| POST   | `/api/v1/orders/:orderId/confirm`              | `order.confirm` (posse)    | PCL-04..06, PCL-09     |
| POST   | `/api/v1/orders/:orderId/reopen`               | `order.reopen` (posse)     | PCL-07                 |
| PATCH  | `/api/v1/orders/:orderId/milestones`           | `order.milestones` (posse) | PLA-04..07             |
| GET    | `/api/v1/orders/:orderId/print`                | `order.print`              | PIM-02, PIM-03, PIM-05 |

`section ∈ {summary, items, observations}`. Escritas exigem `expectedVersion`
e `Idempotency-Key`.

#### Mudanças em arquivos existentes

- `modules/identity-access/src/authorization.js`: `order.read`, `order.create`,
  `order.edit`, `order.confirm`, `order.reopen`, `order.print` e, desde a ADR
  008, `order.milestones`; automação: `order.intent`.
- `apps/api/src/n8n-routes.js`: `EVENT_ACTIONS['order.intent_confirmed'] = 'order.intent'`.
- `modules/n8n-integration/src/postgres-repository.js`: depois de `#mergeBriefing`,
  chamar a projeção do pedido quando `automation_state = 'assistant'`.
- `apps/api/src/operation-runtime.js`: `listInbox` aceita `pendingHandoff`;
  o item da lista inclui `handoff.reasonCode`, `handoff.createdAt` e
  `order: {id, number, status} | null`; `readLiveEvents` mapeia
  `aggregate_type = 'order'` → `inbox.order.changed` com `{orderId, conversationId}`.
- `apps/api/src/app.js`: `registerOrderRoutes(api, runtime.orders, contextFor)`.

### Frontend (`apps/edge-web/src`)

| Componente                                      | Local   | Propósito                                                                                 | Req.                           |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| `lib/order-format.js`                           | novo    | Rótulos de status/condição/motivo, `parseBrl`/`formatBrl`, "o que falta", tempo parado.   | PFI-11, PCX-03, A03            |
| `router.js`                                     | alterar | `/pedidos` e `/pedidos/:orderId` (prop `from` opcional com `conversationId`).             | PLI-01, PGE-01                 |
| `App.vue`                                       | alterar | Item "Pedidos" após "Caixa de Entrada" na sidebar e no menu móvel; ativo em `/pedidos/*`. | PLI-01, PGE-01                 |
| `views/OrdersView.vue`                          | novo    | Lista agrupada, filtro, busca, "Ver mais", ações, SSE.                                    | PLI-02..08                     |
| `views/OrderView.vue`                           | novo    | Rastro, cabeçalho, banner do que falta, Imprimir travado, orquestra seções, SSE.          | PFI-01, PFI-09, PIM-01, PGE-01 |
| `components/order/OrderSummarySection.vue`      | novo    | Resumo leitura/edição; cliente bloqueado.                                                 | PFI-02                         |
| `components/order/OrderMilestonesSection.vue`   | novo    | Lastro: cinco datas; "Pago em" e "Entregue em" editáveis em qualquer status (ADR 008).    | PLA-01..07                     |
| `components/order/OrderItemsSection.vue`        | novo    | Cartões de item + editor de grade + totais.                                               | PFI-03, PFI-04, PFI-07         |
| `components/order/OrderObservationsSection.vue` | novo    | 0..5 linhas.                                                                              | PFI-05                         |
| `components/order/OrderClosingSection.vue`      | novo    | Valor R$, condição, Confirmar pedido (CTA), Reabrir.                                      | PCL-04..07, PFI-11..13         |
| `components/order/OrderInfoStrips.vue`          | novo    | Faixas "Controle de produção" e "Dados do atendimento".                                   | PFI-01, PFI-08                 |
| `components/order/OrderDrawer.vue`              | novo    | Gaveta no inbox: resumo, Abrir pedido, Criar pedido.                                      | PCX-07..09                     |
| `views/InboxView.vue`                           | alterar | Remove "Situação" e "Sugestão"; filtro "Estado"; motivo + tempo parado; botão "Pedido".   | PCX-01..06                     |
| `screen-styles.css`                             | alterar | Estilos das telas novas com tokens existentes.                                            | —                              |

A seção em edição é controlada pela view (`editingSection`), garantindo uma de
cada vez (PFI-06).

**Removido/superado pelo RFC 024 ([ADR 036](../../../docs/adr/036-padroes-de-jornada.md),
15/10/2026).** A tabela acima é o desenho original e fica como histórico:

- O bloco "Controle de produção" saiu da página do pedido (PFI-20, T123
  `a25cba7`); ele só existe na ficha impressa. "Dados do atendimento" continua
  e, no celular, fica dentro do acordeão (PFI-18).
- A gaveta (`OrderDrawer.vue`) e o botão "Pedido" saíram (PCX-10 a PCX-12,
  T126 `c1a9023`): o cabeçalho da conversa mostra o link "Pedido NN-CRM" com
  o status, o resumo fica em Detalhes › Pedido
  (`ConversationOrderSummary`) e "Criar pedido" fica no cabeçalho ou em
  "Mais".
- O filtro "Estado" virou os atalhos Todas · Aguardando · Minhas e a folha
  "Filtros" (PCX-14, T128 `f3935a9`).
- O banner do que falta virou o progresso real "Para gerar o pedido: N de 3"
  (`OrderProgress`, PFI-15) e valor final e forma de pagamento passaram ao
  diálogo "Gerar o pedido" (PFI-19, T125 `6a56687`).
- `screen-styles.css` virou um índice de `@import` dos arquivos de
  `styles/screens/` (S2, `e19fa2c`).

---

## Modelo de dados

### Migration `0023_orders.expand.sql`

```sql
CREATE SEQUENCE crm.order_number_seq START 1;

CREATE TABLE crm.orders (
  id                  uuid PRIMARY KEY,
  number_sequence     bigint NOT NULL UNIQUE,
  number              text   NOT NULL UNIQUE,          -- '01-CRM'
  conversation_id     uuid   NOT NULL REFERENCES crm.conversations(id),
  status              text   NOT NULL CHECK (status IN ('pendente','confirmado')),
  fab_code            text   NOT NULL,
  ficha_version       integer NOT NULL DEFAULT 0,
  ficha_envelope      jsonb  NOT NULL,                 -- summary, items, observations, serviceData (cifrado)
  total_pieces        integer NOT NULL DEFAULT 0 CHECK (total_pieces >= 0),
  missing_fields      text[] NOT NULL DEFAULT '{}',    -- inclui técnica por item e artwork; lista sem decifrar
  final_amount_cents  bigint CHECK (final_amount_cents > 0),
  payment_condition   text   CHECK (payment_condition IN ('pix','cartao_credito','cartao_debito')),
  order_date          date,
  confirmed_at        timestamptz,
  confirmed_by        uuid,
  reopened_at         timestamptz,
  reopened_by         uuid,
  created_by_kind     text   NOT NULL CHECK (created_by_kind IN ('automation','user')),
  created_by          uuid,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CONSTRAINT orders_confirmed_fields CHECK (
    status <> 'confirmado'
    OR (final_amount_cents IS NOT NULL AND payment_condition IS NOT NULL
        AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND order_date IS NOT NULL)
  )
);

CREATE UNIQUE INDEX orders_one_pending_per_conversation
  ON crm.orders (conversation_id) WHERE status = 'pendente';
CREATE INDEX orders_status_updated ON crm.orders (status, updated_at DESC);
```

### Migration `0024_order_milestones.expand.sql` (ADR 008)

```sql
ALTER TABLE crm.orders
  ADD COLUMN first_contact_at timestamptz,  -- abertura da conversa, copiada na criação
  ADD COLUMN paid_on date,                  -- informado por uma pessoa
  ADD COLUMN delivered_on date;             -- informado por uma pessoa

UPDATE crm.orders SET first_contact_at = conversation.opened_at
FROM crm.conversations conversation
WHERE conversation.id = orders.conversation_id AND first_contact_at IS NULL;
```

As colunas são anuláveis porque a API anterior continua criando pedidos durante
a troca de versão. Não são dado pessoal e ficam fora do envelope.

ADR 039 / T136: a migration 0041 completa `first_contact_at` com `created_at`
somente para pedidos `origin = atendimento` sem conversa e com data nula.
Novos manuais usam um único instante para criação e primeiro contato. O PATCH
de milestones desses pedidos altera só `paidOn`; a entrega vem de
`POST /api/v1/orders/:orderId/delivery-confirmation` com `expectedVersion` e
Idempotency-Key. `GET /api/v1/orders/delivery-tasks` deriva os confirmados
manuais não teste, sem entrega, do próprio responsável. A lista inclui prazos
futuros e ausentes; o vendedor só marca quando o cliente recebeu. As duas
rotas novas usam as capacidades de pedido existentes e não criam outra fila
persistida. Snapshots de confirmação e templates não são reescritos.

O nome do cliente e demais dados pessoais ficam só dentro de `ficha_envelope`.
A busca por cliente/telefone da lista resolve pelo contato da conversa (mesmo
caminho que o inbox usa), não por texto aberto na tabela de pedidos.

### Tipos

```ts
type OrderStatus = 'pendente' | 'confirmado';
type PaymentCondition = 'pix' | 'cartao_credito' | 'cartao_debito';

// ADR 016 (02/10/2026): principais na ordem da tela; a quantidade é a soma
// da grade. Pode ser salvo incompleto; gerar exige os principais.
interface FichaItem {
  tipo: string; // Modelo (FPI-05)
  cor: string;
  tipo_servico: string; // Técnica, obrigatória; ADR 020
  estampa: string; // Estampa (referência), adicional opcional
  malhas: string[]; // Tecido; sem linha em branco
  grade: { tamanho: string; quantidade: number }[]; // Tamanhos; inteiro > 0
  gola: string;
  // Adicionais (não obrigatórios)
  modelo: string; // Detalhe do modelo na ficha v8 (FPI-06)
  cor_frente: string;
  cor_costas: string;
  cor_manga_direita: string; // 'NAO APLICAVEL' permitido
  cor_manga_esquerda: string; // 'NAO APLICAVEL' permitido
  vies_gola: string; // 'NAO APLICAVEL' permitido
  vies_mangas: string; // 'NAO APLICAVEL' permitido
}

interface Ficha {
  summary: {
    cliente: string;
    data_entrega_confirmada: string | null;
    aplicacao: string | null; // legado preservado, sem edição ou impressão v5
    nome: string | null;
  };
  items: FichaItem[];
  observations: string[]; // 0..5
  artwork: {
    feito_pelo_cliente: boolean;
    feito_pela_silmer: boolean;
    sem_estampa: boolean;
    files: unknown[];
  }; // origem do pedido; Sem estampa é exclusiva
  serviceData: Record<string, unknown>; // só leitura, não impresso
}

interface Order {
  id: string;
  number: string;
  conversationId: string;
  status: OrderStatus;
  fabCode: string;
  ficha: Ficha;
  totalPieces: number;
  missingFields: string[]; // ADR 020: items, items[N].<principal>, artwork, summary.data_entrega_confirmada, finalAmount, paymentCondition
  finalAmountCents: number | null;
  paymentCondition: PaymentCondition | null;
  orderDate: string | null;
  confirmedAt: string | null;
  confirmedBy: { id: string; name: string } | null;
  reopenedAt: string | null;
  reopenedBy: { id: string; name: string } | null;
  seller: { id: string; name: string } | null; // dono atual da conversa
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

O snapshot de impressão monta o formato de `docs/phase0/ficha-pdf-synthetic.json`
a partir de `Order` (`vendedor` = quem confirmou; `data` = `orderDate`;
`quantidade_total` = `totalPieces`) e deixa `producao` em branco.

---

## Tratamento de erros

| Cenário                             | Resposta                                        | O usuário vê                                   |
| ----------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Não é dono nem admin                | 403 `FORBIDDEN`                                 | Página em leitura; botões de edição ocultos.   |
| Versão desatualizada                | 409 `VERSION_CONFLICT`                          | "Este pedido mudou. Recarregue a seção."       |
| Confirmação sem valor/condição/item | 422 `ORDER_NOT_CONFIRMABLE` + `fields[]`        | Erro em cada campo; status continua Pendente.  |
| Valor em formato inválido           | 422 `INVALID_AMOUNT` (e bloqueio no cliente)    | "Use o formato 4.820,00."                      |
| Grade com quantidade inválida       | 422 `INVALID_GRADE` + índice                    | Erro na linha da grade.                        |
| Imprimir pendente                   | 409 `ORDER_NOT_CONFIRMED`                       | Botão já vem travado; rota direta mostra erro. |
| Criar com pendente existente        | 200 com o pendente atual                        | Abre o pedido existente.                       |
| Intenção repetida do agente         | 200 idempotente                                 | Nada muda.                                     |
| Patch do agente com conversa humana | Ignorado para o pedido, registrado na auditoria | Nada muda no pedido.                           |
| Pedido inexistente                  | 404 `ORDER_NOT_FOUND`                           | "Pedido não encontrado" com link para Pedidos. |

---

## Decisões técnicas

| Decisão           | Escolha                                                                                    | Motivo                                                        |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Persistência      | Tabela nova `crm.orders`, não `crm.deals*`                                                 | ADR 004 proíbe reuso.                                         |
| Conteúdo da ficha | Um envelope cifrado JSON por pedido + colunas derivadas (`total_pieces`, `missing_fields`) | Mesmo padrão da pré-ficha; lista não precisa decifrar.        |
| Escrita por seção | `PATCH /sections/:section` com a seção inteira                                             | Casa com a UI "Editar seção"; um contrato por bloco do PDF.   |
| Concorrência      | `version` otimista em todas as escritas                                                    | Já é o padrão das conversas; PCL-09.                          |
| Número            | `SEQUENCE` global reservada na criação                                                     | `CAMPOS-FICHA-E-JORNADA-P0-1.md`: sequência que não reinicia. |
| Impressão         | HTML do template v5 selecionado por PRINT_TEMPLATE, servido pela API + `window.print()`    | Sem Chromium no container da API; mantém o template aprovado. |
| Tempo real        | Reusar `crm.domain_events` + dispatcher existente                                          | Sem canal novo; o SSE já tem rate limit.                      |
| Filtro "Estado"   | Derivado de `handoffs.status` e `automation_state`                                         | Nenhum estado novo de conversa; nada a migrar.                |

---

## Riscos e dívidas encontradas

- **Ordem de publicação no n8n online:** o fluxo que envia
  `order.intent_confirmed` só pode ir para o n8n online depois que o CRM de
  destino aceitar o evento; antes disso, cada intenção vira falha registrada.
  Mitigação: T40 roda após o deploy, testa no workflow DEV, guarda a versão
  anterior para rollback e o nó do evento não bloqueia a resposta ao cliente.

- **Contratos legados:** caminhos aposentados de Kanban/Negócio foram retirados da OpenAPI em 05/10/2026; schemas, tabelas e módulos históricos permanecem preservados e não autorizam novas capacidades.
- **README do n8n afirma endpoints que sumiram** ("usa os endpoints canônicos de
  conversão, campos e transição"). A ADR 006 e a atualização do README corrigem
  isso.
- **Módulo `deals-pipeline` órfão** e a ação `kanban.read` ainda existem.
  Não tocar; limpeza adiada.
- **Estados antigos da conversa** continuam em Clientes ("Situação") e no KPI
  "Requerem atenção" do Dashboard. Fora do escopo.
- **Gate da ficha:** v5 está selecionada com aprovação provisória do PO. Assinatura física de Rose e Operação continua exigida antes de produção. PDFs/templates v2–v4 e hashes não são reescritos.
