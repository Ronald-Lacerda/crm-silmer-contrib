# Pedidos MVP — Contexto e decisões

**Coletado em:** 09/09 a 12/09/2026, em revisão de design com o PO
**Spec:** [`spec.md`](spec.md)
**Atualizado em:** 05/10/2026 — PR 142 integrada
**Status:** implementado; homologação e assinatura física da ficha pendentes

---

## Limite da feature

Um pedido nasce da conversa (pelo agente ou pelo vendedor), é completado de
forma não linear, tem só dois status — **Pendente** e **Confirmado** — e só
pode ser impresso depois de uma confirmação humana. A Caixa de Entrada ganha a
triagem por quem precisa agir e uma gaveta com o resumo do pedido. A lista de
Pedidos substitui o que seria o Kanban.

---

## Decisões de implementação

### Ciclo de vida

- **D01** Dois status: `pendente` e `confirmado`. Única transição humana de ida:
  "Confirmar pedido". Única volta: "Reabrir pedido".
- **D02** O **agente cria** o pedido pendente quando confirma a intenção de
  compra. Isso muda a regra atual do contrato n8n ("nenhuma informação inferida
  vira Pedido oficial"). Reconciliação: **Pendente é rascunho não oficial;
  oficial é Confirmado**, e confirmar continua sendo humano. A ADR
  006 registra essa decisão e supersede o trecho "Pedido será uma decisão posterior" da ADR 004.
- **D03** O vendedor (dono) ou um admin também pode **criar manualmente** quando
  o agente não detectou a intenção. Sem isso a conversa ficaria sem saída.
- **D04** **Vários pedidos por conversa, um pendente por vez.** Nova intenção
  com pendente aberto reaproveita o pendente.
- **D05** **Toda confirmação é humana.** Nada muda o status sozinho: nem
  pagamento, nem produção, nem tempo, nem o agente (exceto criar).
- **D06** **Reabrir existe no MVP**: dono da conversa ou admin; volta a
  Pendente, preserva número, bloqueia impressão de novo e registra quem
  reabriu.

### Posse e permissões

- **D07** **Confirmar**: dono da conversa + admin (não reutiliza as ações
  admin-only `order-form.approve`, `quote.approve`, `sale.approve`).
- **D08** **Editar pedido pendente segue o dono da conversa.** Outro vendedor
  retoma usando "Repassar atendimento" ou assumindo conversa sem responsável.
  Não existe posse própria de pedido.
- **D09** **Imprimir**: qualquer usuário operacional, desde que o pedido esteja
  confirmado.

### Campos e documento

D10/D11/D15 foram refinadas pelas ADRs 016–020, preservando seus IDs e dados antigos.

- **D10** Campos atuais seguem os requisitos TEC-01..08 e a impressão ficha-canonical-v5 (ADR 020). V2–v4 e hashes preservam o histórico.
- **D11** Arte pertence ao pedido e é impressa nas páginas comerciais da v5; locais são Estampa (referência) do item. Logística, finalidade e perfil continuam em Dados do atendimento, sem criar estados de Pedido.
- **D12** Valor final: texto em reais com prefixo `R$`, formato brasileiro,
  guardado em centavos. Condição: Pix, Cartão de crédito, Cartão de débito.
  Valor e condição **não aparecem** no documento impresso.
- **D13** Cliente vem do contato da conversa e fica bloqueado no pedido.
- **D14** Número `NN-CRM` é reservado **na criação** do pedido (a lista mostra
  número em pendentes). Data do pedido é definida **na confirmação**.
- **D15** PRINT_TEMPLATE seleciona v5 com aprovação provisória do PO. Assinatura física de Rose e Operação continua obrigatória antes da produção. Versões anteriores são referências preservadas.

### Vocabulário e navegação

- **D16** "Pedido" é o termo único na interface. "Ficha" só aparece como nome
  do documento impresso interno ("FICHA DE PEDIDO").
- **D17** A página do pedido pertence a **Pedidos** (menu ativo "Pedidos"),
  com rastro "← Pedidos / NN-CRM" e origem quando aberta de uma conversa. Dois
  caminhos de entrada: lista de Pedidos e gaveta da conversa.
- **D18** Item "Pedidos" entra no menu logo após "Caixa de Entrada".

### Caixa de Entrada

- **D19** O filtro "Situação" atual (Nova, Em análise, Em atendimento, Requer
  atenção, Atendimento concluído, Atendimento encerrado) **não faz sentido e
  sai**. Entra o filtro "Estado" do design novo: **Todas · Aguardando vendedor
  · Com o agente · Com vendedor**, com motivo da parada e ordenação por tempo
  parado.
- **D20** Ficam como estão: fila **Todas / Minhas / Sem responsável**,
  **Arquivar / ver arquivadas**, **Repassar atendimento**, Assumir, Devolver à
  IA, Editar nome, Ver contato.
  Superado pela ADR 015 (02/10/2026) só quanto a "Devolver à IA": a ação saiu,
  porque a conversa com uma pessoa não volta para o bot.
- **D21** Sai o bloco **"Sugestão pendente da IA"**.
- **D22** Pedido na conversa aparece numa **gaveta lateral sob demanda**, só
  **resumo + "Abrir pedido"** (e "Criar pedido" quando cabe). Edição acontece
  só na página do pedido.
- **D23** Na lista de Pedidos, a coluna **"Situação"** do design novo fica
  (pendente: o que falta + tempo parado; confirmado: quem e quando).

### Agente e n8n online

- **D25** A criação do pedido pelo agente fica **automática em produção**: o
  Grupo D também publica o fluxo no n8n online (T40), primeiro no workflow DEV
  e depois no de produção, com rollback pela versão anterior.
- **D26** A publicação só acontece depois do deploy do CRM que aceita
  `order.intent_confirmed` e com aprovação explícita do responsável logo antes
  de publicar produção. O nó do evento nunca bloqueia a resposta ao cliente.

### Escopo cortado

- **D24** Sem cobrança/comprovante/status de pagamento, produção, entrega,
  perdido/cancelado, Mesa de Trabalho, marcos, anel de completude, histórico
  visível, artboard mobile dedicado. Revisto em 29/09/2026 por D27–D31: os dias
  de pagamento e de entrega passam a ser registrados, sem virar status.

### Lastro de datas (ADR 008, 29/09/2026)

- **D27** O pedido guarda cinco datas, nesta ordem: primeiro contato, pedido
  fechado, pagamento, entrega prometida e entrega realizada. Aparecem na ficha
  digital e na impressa.
- **D28** Primeiro contato é a abertura da conversa que originou o pedido
  (primeira mensagem recebida no atendimento), copiada na criação. Pedido
  fechado é a data do pedido; entrega prometida é a entrega confirmada do
  resumo.
- **D29** Pagamento é manual: o CRM não registra pagamento e não presume que
  gerar o pedido é pagar. Entrega realizada é 100% manual.
  - **Emenda (21/10/2026, ADR 039):** no Pedido manual sem conversa,
    Primeiro contato é a criação e a entrega recebe o dia do servidor quando
    o responsável marca o afazer no Dashboard. Apenas pagamento é digitável.
    Pedidos de conversa mantêm o comportamento anterior.
- **D30** Pagamento e entrega realizada são informados pelo dono da conversa ou
  por um admin, pendente ou confirmado, sem reabrir. Nenhuma das datas muda
  status nem bloqueia a confirmação.
- **D31** A v2 impressa não muda (travada por hash). O lastro entra na v3
  antes da aprovação de Rose e Operação; a v2 só passa a imprimir a entrega
  confirmada em dd/mm/aaaa.
  - **Nota (02/10/2026, ADR 017):** a v3 que leva o lastro é a ficha com os
    sete pontos, não mais a v3 por produto. Na página 1, Data do pedido e
    Entrega prometida saem só no Resumo, e a faixa do lastro traz Primeiro
    contato, Pagamento e Entrega realizada, com "—" no dia ainda não
    registrado. A aprovação tem duas etapas (03/10/2026): o PO aprovou a v3
    para desenvolvimento e cloud-dev; antes da produção, Rose e Operação
    assinam à mão a amostra impressa e o Tech Lead registra a aprovação final,
    confirmada pelo PO. D15 deixou de valer em 03/10/2026: desde a T74 a
    impressão usava a v3. Desde a PR 142, a v5 está selecionada com aprovação provisória (ADR 020), sem dispensar assinatura física para produção.

---

## Discrição do agente (validar na revisão da spec)

- **A01** Gerar exige ao menos um item com Modelo (`item.tipo`, FPI-05), Cor, Quantidade calculada, Técnica, Tecido, Tamanhos e Gola; origem da arte, entrega prometida, valor final e condição (ADR 020). Adicionais e nome do pedido não bloqueiam. Pago em não bloqueia nem altera status; o CRM não afirma pagamento por gerar o pedido.
- **A02** "Tempo parado": no inbox, desde a criação do handoff pendente; na
  lista de Pedidos, desde a última alteração do pedido.
- **A03** Rótulos de motivo a partir de `handoffs.reason_code`:
  `price_before_quote`/`negotiation` → "Perguntou o valor";
  `customer_requested_human`/`human_requested` → "Pediu um vendedor";
  `briefing_complete` → "Pré-ficha completa"; `unresolved_blocker` →
  "Dado divergente"; `low_confidence` → "Agente sem confiança";
  `complaint` → "Reclamação"; `urgency` → "Urgência";
  `unsupported` → "Conteúdo não suportado".
- **A04** Impressão por página HTML do template v5 com `window.print()` no
  navegador, sem Chromium no container da API.

---

## Referências específicas

- Canvas de design: `.design/mesa-de-trabalho/` — quadros "Escopo dos status",
  "Pedidos", "Caixa de Entrada + Pedido" e "Pedido".
- Documento aprovado: `output/pdf/ficha-canonica-sintetica-v2.pdf`, gate em
  `docs/phase0/ficha-pdf-approval.json` (não sobrescrever versão aprovada).
- Contrato atual do agente: `docs/integrations/n8n/README.md`.

---

## Ideias adiadas

- Ampliações das consultas comerciais e do detalhe do Cliente; KPIs de pedidos confirmados já existem no Dashboard.
- Linha do tempo de preenchimento por campo.
- Mesa de Trabalho como visão de portfólio.
- Remoção do módulo deals-pipeline órfão e schemas históricos exige fatia própria; os caminhos aposentados já foram retirados da OpenAPI.
- Rever a coluna "Situação" do Cliente e o KPI "Requerem atenção" do Dashboard,
  que ainda usam os estados antigos da conversa.

## Baseline da PR 142 — ADR 020

- Técnica é do item e substitui Estampa como ponto principal; Estampa (referência) é adicional opcional.
- Arte é do pedido: cliente envia, Silmer cria ou Sem estampa, exclusiva das outras opções. Origem é obrigatória para gerar.
- Bot só projeta técnica/origem inequívocas em campos vazios, preservando escolhas humanas.
- Aplicação geral antiga e modelo continuam guardados, sem edição ou impressão na v5.
- PRINT_TEMPLATE usa ficha-canonical-v5; v2–v4 e hashes não mudam. Aprovação provisória registrada em docs/phase0/ficha-pdf-approval-v5.json; assinatura física antes da produção continua pendente.
