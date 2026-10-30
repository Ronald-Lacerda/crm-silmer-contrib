# Design do CRM Silmer

> **Status:** direção visual e contrato de interface para o MVP  
> **Referência de marca:** [silmer.com.br](https://silmer.com.br/), inspecionado em 29/08/2026  
> **Escopo:** produto web responsivo em Vue 3, HTML semântico, CSS e JavaScript ESM

## 1. Objetivo

O CRM Silmer deve transmitir a mesma personalidade da marca pública — roxo profundo, laranja, tipografia Poppins e linguagem direta — sem reproduzir a intensidade visual de uma página promocional dentro de uma ferramenta de trabalho.

O produto é usado para triar conversas, acompanhar oportunidades, revisar dados e concluir pedidos. Portanto, a interface deve priorizar:

1. **clareza operacional:** o próximo passo e o estado atual devem ser reconhecidos sem interpretação;
2. **baixa sobrecarga cognitiva:** cada região possui uma ação principal, informações secundárias aparecem sob demanda e elementos decorativos não competem com dados;
3. **confiança:** ações automáticas, alterações, falhas e responsáveis permanecem visíveis e auditáveis;
4. **consistência:** o mesmo componente, estado e termo têm a mesma aparência em todo o produto;
5. **acessibilidade:** light e dark são equivalentes, navegação por teclado é completa e cor nunca é o único indicador de significado.

## 2. Tradução da marca para o produto

### Elementos preservados

- Poppins como família tipográfica principal.
- Laranja `#ff5b01` como cor de ação prioritária e assinatura da marca.
- Roxo escuro `#0c042d` como base do tema dark.
- Roxos intermediários para foco, links e estados selecionados.
- Cantos arredondados, com raio menor e mais funcional do que no site institucional.
- Texto direto, humano e orientado à ação.

### Adaptações intencionais

- O CRM não usa títulos promocionais gigantes, faixas animadas, brilhos ou grandes áreas laranja.
- Gradientes, fotografias e efeitos de glow ficam restritos a autenticação, onboarding ou comunicação institucional; nunca aparecem atrás de dados operacionais.
- Pills são usadas apenas para status, filtros compactos e contadores. Containers, tabelas e formulários usam raios moderados.
- A profundidade vem primeiro de contraste entre superfícies e bordas; sombras são discretas e raras.
- A densidade é moderada: mais compacta que o site, mas sem transformar todas as telas em tabelas densas.

## 3. Princípios de baixa carga cognitiva

### Hierarquia previsível

- Cada página possui um único `h1`, uma descrição opcional e uma ação primária.
- A ordem visual é sempre: contexto → estado → conteúdo → ação.
- A navegação principal não muda de posição entre módulos.
- Ações destrutivas ficam separadas das ações de continuidade.
- Métricas usam rótulo, valor e contexto; não dependem de ícone ou cor para serem entendidas.

### Divulgação progressiva

- Mostrar primeiro o necessário para decidir; histórico, metadados e auditoria ficam em painéis expansíveis ou drawer.
- Formulários longos da Ficha são divididos por grupos da jornada, não por conveniência técnica.
- Filtros frequentes permanecem visíveis; filtros avançados abrem em popover ou drawer.
- Cards do Kanban exibem apenas identificação, valor/contexto essencial, responsável, próxima pendência e tempo no estágio.

### Uma ação principal por região

- A ação mais importante usa botão `primary` laranja.
- Ações alternativas usam `secondary` ou `ghost`.
- Uma mesma região não deve exibir dois botões `primary`.
- Links dentro de texto continuam parecendo links; não viram botões sem necessidade.

### Estados explícitos

- Todo carregamento, vazio, erro, sucesso, indisponibilidade e falta de permissão possui tratamento próprio.
- No MVP, a atuação do Vendedor Silmer informa `o que respondeu`, `o que sugeriu`, `quando` e `em nome de qual regra`; alterações oficiais continuam humanas.
- Estado de sincronização e envio usa texto curto mais ícone; nunca somente uma bolinha colorida.

## 4. Temas e tokens semânticos

Os componentes consomem somente tokens semânticos. Cores brutas não devem ser usadas diretamente fora da definição do tema.

### Implementação canônica e regra de evolução

- `apps/edge-web/src/tokens.css` é a única fonte para valores de cor, tipografia, espaçamento, raios, sombras, foco e movimento do produto.
- `apps/edge-web/src/main.js` o importa antes de `styles.css`; CSS de tela e componente consome somente `var(--token-semântico)`, inclusive para foco, overlay e estados.
- Novos valores brutos de cor (`#...`, `rgb()`, `hsl()` ou cores nomeadas) só podem ser declarados em `tokens.css`. Se um papel ainda não existe, criar ou evoluir o token semântico antes de usá-lo.
- `npm run check:design-tokens` é o guardrail executável dessa regra e integra `npm run validate`; uma alteração de frontend não está pronta se ele falhar.

### Camadas de token e whitelabel (RFC 022)

O produto é whitelabel e a Silmer é o piloto. `tokens.css` tem três camadas:

1. **Marca** — as únicas entradas por empresa:

| Entrada | Silmer | Papel |
|---|---|---|
| `--brand-primary` | `#ff5b01` | assinatura: logotipo, faixas, ícone ativo |
| `--brand-primary-strong` | `#c94300` | preenchimento de ação; branco sobre ele passa 4.78:1 |
| `--brand-ink` | `#0c042d` | texto, neutros, superfícies escuras e tema escuro |
| `--brand-secondary` / `-light` | `#6544ee` / `#b2a1f7` | link, foco e seleção (claro / escuro) |
| `--brand-font` | Poppins | família única |
| `--brand-radius` | `0.5rem` | raio base; `sm`, `lg` e `xl` derivam dele |

2. **Semânticos** — derivados da marca com `color-mix()`; componentes só usam
   estes. Os neutros são a tinta misturada ao branco em poucas porcentagens, por
   isso trocar `--brand-ink` re-tinge canvas, bordas, texto e sombras.

| Papel | Light | Dark | Uso |
|---|---|---|---|
| `--color-canvas` | tinta 5% | tinta + preto | fundo do shell e da navegação |
| `--color-page` | tinta 1.5% | tinta | painel de trabalho (inset) |
| `--color-surface` | branco | branco 5% | cards, campos, botões secundários |
| `--color-surface-raised` | tinta 4% | branco 9% | hover e segundo nível |
| `--color-surface-active` | tinta 8% | branco 14% | pressionado |
| `--color-text` | tinta | branco 94% | texto principal (≥ 16:1) |
| `--color-text-muted` | tinta 64% | branco 68% | texto secundário (≥ 5.5:1) |
| `--color-border` / `-strong` / `-subtle` | tinta 14% / 30% / 8% | branco 16% / 30% / 10% | limites; `strong` em campos (3:1) |
| `--color-accent` | primária | primária | faixa, ícone ativo, assinatura |
| `--color-accent-solid` | primária forte | primária forte | botão primário (texto branco) |
| `--color-link` / `--color-focus` | secundária | secundária clara | links, anel e halo de foco |
| `--color-selected` | secundária 9% | secundária 22% | chip ou linha selecionada |

3. **Componentes** — `--control-height` (40 px; 44 px em `pointer: coarse`),
   `--target-min`, `--sidebar-inline-size`, `--sidebar-rail-size`,
   `--topbar-block-size`.

Regras para uma nova marca: `--brand-ink` escura (luminância < 5%) e
`--brand-primary-strong` com contraste ≥ 4.5:1 com branco. Nome da empresa,
nome do produto, slogan e logotipo ficam em `apps/edge-web/src/brand/index.js`;
`BrandMark.vue` desenha o logotipo oficial. Nenhum componente escreve o nome da
empresa.

### Cores semânticas

| Estado | Light: fundo / texto | Dark: fundo / texto |
|---|---|---|
| sucesso | `#e7f6ed` / `#146c43` | `#123a2a` / `#8fe3b3` |
| atenção | `#fff4d6` / `#7a4a00` | `#4a2e00` / `#ffd17a` |
| erro | `#fdecec` / `#a12a2a` | `#491a22` / `#ffb4c0` |
| informação | `#eaf2ff` / `#205aa7` | `#152f56` / `#a8caff` |

Cada estado combina cor, ícone e rótulo. Os nomes dos tokens devem expressar função, nunca a cor: `--status-error-text`, não `--red-700` dentro de componentes.

### Aplicação do tema

- O modo claro é a aparência inicial quando não existe preferência salva ou a preferência legada for inválida.
- A escolha manual oferece `Claro` e `Escuro`; a preferência do sistema não é usada.
- Aplicar `data-theme="light|dark"` no elemento `html` e declarar `color-scheme` correspondente.
- Persistir somente a preferência de tema, sem estado global em `window`.
- Aplicar o tema antes da primeira pintura para evitar flash entre temas.
- Nenhuma informação, ação ou ilustração pode existir apenas em um dos temas.

A tinta da marca é texto no modo claro, não fundo de navegação. Laranja nunca
marca seleção (chip, segmentado, aba): seleção é neutra ou usa
`--color-selected`; o laranja fica para a ação primária e a assinatura.

## 5. Tipografia

**Família:** `Poppins, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.

Uma única família reduz ruído e custo de carregamento. Pesos permitidos: `400`, `500`, `600` e `700`; `800` fica reservado à autenticação ou comunicação institucional.

| Token | Tamanho / linha | Peso | Uso |
|---|---:|---:|---|
| `--text-xs` | `0.8125rem / 1.5` | 500 | metadados, legendas e rótulos (piso do produto) |
| `--text-sm` | `0.875rem / 1.5` | 400–600 | controles compactos e tabelas |
| `--text-base` | `1rem / 1.5` | 400 | texto e campos |
| `--text-lg` | `1.125rem / 1.4` | 600 | título de painel |
| `--text-xl` | `1.25rem / 1.35` | 600 | seção |
| `--text-2xl` | `1.5rem / 1.25` | 600 | título de página (h1) |
| `--text-3xl` | `2rem / 1.2` | 700 | estados especiais e autenticação |

- Texto corrido não ultrapassa aproximadamente 75 caracteres por linha.
- Não usar caixa alta nem eyebrow acima de títulos; rótulos ficam em caixa normal, peso 500 e cor secundária.
- Nenhum texto abaixo de `--text-xs` (13 px).
- Números financeiros usam `font-variant-numeric: tabular-nums`.
- Placeholder é dica, nunca substituto de `label`.

## 6. Espaçamento, forma e elevação

### Escala de espaçamento

Base de `4px`: `4`, `8`, `12`, `16`, `20`, `24`, `32`, `40`, `48`, `64`.

- `4–8px`: relação entre ícone e rótulo ou metadados.
- `12–16px`: padding interno de controles e grupos compactos.
- `20–24px`: padding de painéis e distância entre grupos.
- `32–48px`: separação entre seções de página.

### Raios

| Token | Valor | Uso |
|---|---:|---|
| `--radius-sm` | `6px` | badge, item compacto, segmento |
| `--radius-md` | `8px` | inputs, botões e menus |
| `--radius-lg` | `12px` | cards, painéis e dialogs |
| `--radius-xl` | `16px` | painel de trabalho e tela de acesso |
| `--radius-pill` | `999px` | chips, contadores e avatar |

### Elevação

- `level-0`: canvas, sem sombra.
- `level-1`: superfície + borda sutil.
- `level-2`: popover, menu e sticky header com borda e sombra curta.
- `level-3`: dialog, com overlay e sombra moderada.
- No tema dark, elevação é indicada principalmente por uma superfície mais clara e borda; glow não é elevação padrão.

## 7. Estrutura da aplicação

### App shell

**Mobile-first (15/10/2026):** os vendedores operam pelo celular. Toda tela é
desenhada primeiro para 390×844.

- **Celular (≤ 768 px):** topo de 56 px com o logotipo e o estado da conexão;
  barra inferior fixa de `--mobile-nav-block-size` (64 px + safe-area) com
  Início, Caixa, Pedidos, Clientes e Mais. "Mais" abre uma folha inferior com
  conta, Vendedores (admin), Conta, aparência e Sair; Escape fecha e devolve o
  foco. As telas reservam a barra no fim da rolagem e acima de rodapés fixos.
  Campos usam 16 px para o iOS não dar zoom.

- Sidebar de `248px` no canvas, sem borda; item ativo é um cartão branco com
  sombra curta e ícone na cor da marca. Recolhe para rail de `72px` entre 769 e
  1199 px, com o monograma da marca. A Inbox começa com menu compacto quando
  não há preferência; `Expandir menu` / `Recolher menu` preserva a escolha
  no navegador para todas as telas desktop/tablet. No celular permanece a barra inferior.
  Ícones compactos mantêm nomes acessíveis e rótulos no hover e no foco.
- O trabalho fica num painel inset (`--color-page`, raio `xl`) com topbar de
  `56px`: trilha "Empresa › Tela", função, estado da conexão e tema.
- Uma lista de rotas alimenta a sidebar, a barra inferior e a folha "Mais";
  todos oferecem os mesmos destinos, inclusive Vendedores (admin) e Sair.
- Cabeçalho de página: h1 de 24 px (20 px no celular), uma linha de contexto e
  a ação primária da tela, que no celular ocupa a largura toda. Sem eyebrow.
- Conexão: verde discreto quando ativa, atenção durante reconexão, erro só
  quando indisponível.
- Títulos recebem foco programático na navegação sem desenhar anel; controles
  sempre mostram o anel.

### Responsividade

- `>= 1200px`: navegação completa e layouts list/detail lado a lado.
- `768–1199px`: sidebar recolhida; painéis secundários abrem em drawer.
- `< 768px`: navegação em drawer, uma coluna e ações primárias fixadas apenas quando isso reduz rolagem.
- Kanban no mobile usa colunas navegáveis com nome e contagem sempre visíveis; não comprime todas as colunas na tela.
- Tabelas priorizam colunas essenciais e oferecem detalhe por linha; rolagem horizontal não é a única forma de acessar informação.

## 8. Biblioteca de componentes

### Primitivos obrigatórios

| Componente | Variantes ou responsabilidades |
|---|---|
| `Button` | secundário por padrão; `.primary` (uma por região), `.quiet`, `.danger`, `.link-button`; `.button-link` para links com cara de botão; loading e disabled |
| `IconButton` | alvo mínimo de `44×44px`, tooltip e nome acessível |
| `Field` | label, descrição, input/select/textarea, erro e estado obrigatório |
| `Checkbox` / `Radio` / `Switch` | label clicável, foco visível e estado indeterminado quando necessário |
| `SearchField` | limpeza, atalho opcional e anúncio de resultados |
| `Badge` / `Status` | texto + ícone; nunca somente cor |
| `Panel` / `Card` | estrutura visual; não deve embutir regra de domínio |
| `Tabs` | setas entre abas, `Home/End` e associação `tab`/`tabpanel` |
| `Menu` / `Popover` | foco gerenciado, Escape e retorno de foco |
| `Dialog` / `Drawer` | título, descrição, foco contido, Escape e ação explícita |
| `Toast` | feedback breve; erros persistentes também aparecem junto ao contexto |
| `EmptyState` | motivo, ação recuperável e sem ilustração excessiva |
| `Skeleton` | mesma geometria do conteúdo; respeita reduced motion |
| `DataTable` / `DataList` | cabeçalhos reais, seleção, ordenação e alternativa responsiva |
| `Tooltip` | apoio curto; nunca guarda informação necessária para concluir tarefa |
| `ThemeSwitcher` | `Claro`, `Escuro`, com rótulo acessível |

### Composição de domínio

Componentes de domínio devem compor os primitivos acima, sem duplicar estilo ou interação:

- `ConversationListItem`, `ConversationPanel` e `LeadConversionAction`;
- `KanbanColumn`, `OpportunityCard` e `StageChangeDialog`;
- `AgentActivity`, `HandoffSummary` e `AuditTimeline`;
- `OrderSheetSection`, `OrderValidationSummary` e `OrderSendStatus`;
- `SalesKpi`, `SalesFilterBar` e `SalesDataTable`.

Cada componente precisa documentar: propósito, anatomia, variantes, estados, comportamento responsivo, teclado, ARIA e exemplos de uso/não uso.

## 9. Padrões por superfície do CRM

> Desde o [ADR 036](docs/adr/036-padroes-de-jornada.md) (RFC 024, 15/10/2026),
> os padrões de jornada da §16 prevalecem sobre esta seção onde divergirem.
> O texto abaixo foi alinhado na T133 ao que as fatias entregaram em
> `ux/jornadas`: filtros e cabeçalho da Caixa de Entrada, link do pedido no
> lugar da gaveta, "Assumir atendimento" no composer e a página do pedido.

### Caixa de Entrada

Workspace de altura fixa para a atendente (pesquisa UX de 15/10/2026, achado 1):
a página ocupa exatamente a altura abaixo da barra superior e nunca rola; cada
coluna rola por dentro.

- **Colunas:** lista | conversa | contexto. O contexto (Detalhes do atendimento › Pedido,
  assuntos, cliente) é recolhível pelo botão com texto visível `Detalhes` do cabeçalho; abre por
  padrão a partir de 1440 px e a última escolha da pessoa vale naquele
  navegador. No tablet o contexto cobre a conversa; no celular aparece um
  painel por vez. Detalhes aberto pelo teclado leva o foco ao título; Esc
  fecha e devolve o foco a quem abriu.
- **Celular primeiro (ADR 035):** desenhada para 390×844 e ampliada. Lista e
  conversa são telas separadas, com voltar; o cabeçalho mantém só o voltar,
  o link do pedido quando há pedido, `Criar pedido` quando cabe (ver
  "Cabeçalho da conversa") e `Mais`, que abre uma folha
  inferior acima da barra de navegação (Detalhes do atendimento, Criar pedido
  quando não cabe no cabeçalho, Transferir atendimento, Arquivar/Desarquivar, Encerrar). A
  resposta fica acima da barra; ao digitar, a barra sai e a resposta encosta
  no teclado (`interactive-widget=resizes-content`). Alvos de 44 px; nada
  depende de hover.
- **Endereço:** `/inbox/:conversationId` abre a conversa direto (Pedido,
  Clientes e Dashboard linkam assim). A conversa aberta pelo endereço continua
  aberta mesmo fora do filtro, arquivada ou além das 100 carregadas; trocar de
  conversa muda o endereço sem recarregar a lista, a busca ou os filtros. No
  celular o endereço decide entre a lista e a conversa (voltar = `Conversas`).
- **Filtros (PCX-14):** a busca no topo da lista, três atalhos com contagem
  e seleção neutra (`Todas · Aguardando vendedor · Meus atendimentos`) e o botão `Filtros`, que
  abre a folha "Filtrar conversas" com Situação
  (`Todas · Aguardando vendedor · Com o agente · Com vendedor · Arquivadas`)
  e Responsável (`Todas · Minhas · Sem responsável`). Um par fora dos atalhos aparece no
  resumo "Filtro:", cada filtro com botão de remover e `Limpar filtros`
  quando há dois. Os links `?situacao=` e `?fila=` do Painel abrem com o
  atalho marcado ou com o resumo. Vazio por filtro ("Nenhuma conversa com
  esse filtro" + `Limpar filtros`) é diferente do vazio inicial. As abas de
  estado e o seletor "Fila" deixaram de existir.
- **Lista:** nome, horário curto (hora hoje, dia no ano, data antes; a data
  completa no tooltip), trecho de uma linha, canal, estado, motivo e tempo
  parado. O item aberto usa `--color-selected`, sem borda lateral colorida.
- **Cabeçalho da conversa:** compacto, nome, o link do pedido e uma linha de
  identidade; sem ação primária (ela fica no composer). Com pedido, o link
  "Pedido NN-CRM" com o status em selo de texto abre `/pedidos/:id?conversa=`
  e acompanha `inbox.order.changed` (PCX-10); sem pedido, nada aparece.
  `Criar pedido` fica no cabeçalho só para o dono de conversa humana, sem
  handoff pendente e sem pedido; os outros casos que a API aceita
  (administrador, agente ainda atendendo, pedido já confirmado) vão para
  `Mais` (PCX-11). Depois vêm `Mais` (Repassar, Arquivar/Desarquivar,
  Encerrar conversa em todas as larguras, PCX-13) e o botão `Detalhes`.
  `Mais` abre pelo teclado no primeiro item e Esc devolve o foco. A gaveta do
  pedido e o botão "Pedido · status" foram removidos (T126).
- **Detalhes › Pedido (PCX-12):** número, status, "Falta para gerar",
  itens, total, valor e `Abrir pedido`, só para leitura, com carregando, erro
  com `Tentar novamente` e "Sem pedido nesta conversa." uma vez só.
- **Histórico:** abre na última mensagem e acompanha as novas, salvo quando a
  pessoa rolou para ler algo antigo; conversa curta fica junto da resposta.
- **Assumir no lugar do composer (PCX-13):** enquanto ninguém assumiu e quem
  abre pode agir, o rodapé mostra o motivo da parada e o tempo parado
  (PCX-03), ou que o agente está atendendo e não volta depois (ADR 015), com
  `Assumir atendimento` como única primária da conversa. Depois de assumir,
  o campo de resposta aparece com `Enviar resposta` como única primária e
  recebe o foco; o resultado é anunciado em `role="status"`. Quem não pode
  agir vê o composer desabilitado com o motivo.
- **Resposta:** visível no rodapé da conversa assim que alguém a assume. Enter envia, Shift+Enter
  quebra a linha; em teclado de toque Enter só quebra a linha. Sem espaço,
  Anexar e Gravar ficam só com ícone (nome acessível mantido) e Enviar continua
  na mesma linha.
- Conversa encerrada usa `Sem lead`; nunca reutilizar o estado visual `Perdido` do Kanban.

### Kanban Comercial

- Backlog não aparece como coluna.
- Cabeçalho de coluna exibe nome, contagem e limite quando existir.
- O drag-and-drop é um acelerador, não o único mecanismo: cada card possui ação de mover acessível por teclado.
- Antes de mover, a UI informa campos pendentes ou regra de passagem.
- `Fechado` e `Perdido` são resultados explícitos; `Perdido` exige motivo.

### Conversa e atuação do Vendedor Silmer

- Mensagens humanas, do cliente e do agente são visualmente distintas, mas permanecem legíveis nos dois temas.
- A área de composição mantém uma ação principal de envio e torna anexos/ações extras secundários; antes de alguém assumir, `Assumir atendimento` ocupa o lugar dela (PCX-13).
- Mensagens, sugestões e handoffs do agente aparecem em uma linha do tempo auditável, agrupada por etapa.
- Sugestões como `Transformar em lead` e `Avançar etapa` exigem confirmação humana explícita no MVP; a interface nunca representa a sugestão como ação já executada.
- A chave pós-MVP `vendedor_silmer_autonomia_comercial` não aparece como controle operacional do MVP.
- Handoff mostra motivo, resumo, responsável e ação para assumir; não depende de toast.
- Reversão identifica impacto antes de confirmar.

### Ficha de Pedido

A página do pedido (`/pedidos/:id`) segue a ordem da ficha impressa, com as
palavras da tela (PFI-01, PFI-20): Resumo do pedido, Datas do pedido, Itens e
especificações, Arte do pedido, Observações do pedido, Dados do atendimento
(não impresso) e Fechamento e pagamento. O bloco "Controle de produção" não
aparece na tela; ele só existe na ficha impressa, que mantém "Lastro do
pedido" e os mesmos templates e hashes.

- **Progresso real no topo (PFI-15):** "Para gerar o pedido: N de 3", com os
  passos Entrega prometida, Itens e Arte do pedido, lidos só de
  `missingFields`; só o próximo passo tem botão, com verbo e objeto
  ("Informar a entrega prometida", "Completar os itens", "Marcar quem faz a
  arte"). Uma pendência que a tela não conhece vira o passo "Revisar
  pendências" e o total passa a 4, nunca um falso "3 de 3". Com os três
  passos feitos, o progresso vira uma linha só ("Tudo pronto para gerar · 3
  de 3"), com o mesmo título e o mesmo `role="status"`. Não aparece para
  quem não edita, para pedido confirmado nem para pedido da loja.
- **Cabeçalho de seção (PFI-17):** título, estado em texto com ícone
  ("Entrega 20/11/2026", "Falta: cor do item 1", "1 item · 150 peças", "1 de
  3 datas") e o botão `Editar resumo`, `Editar datas`, `Editar itens`,
  `Editar arte` ou `Editar observações`, com 44 px. Com uma seção em edição,
  os outros ficam com `aria-disabled` e o motivo "Salve ou cancele a edição
  aberta.".
- **Acordeão no celular (PFI-18):** até 768 px, uma seção aberta por vez,
  Dados do atendimento inclusive; acima disso, tudo aberto e empilhado.
- **Arte do pedido (PFI-20):** quem faz a arte ("A {empresa} cria a arte" com
  `brand.companyName`), arte final ("A versão aprovada que vai para a
  produção.") e arquivos da arte ("Referências e rascunhos; não vão para a
  produção."), com um só controle de adicionar arquivo por vez.
- **Rodapé e diálogo (PFI-16, PFI-19):** no celular o rodapé fixo leva o
  próximo passo enquanto houver pendência e `Gerar pedido` só sem pendência;
  `Gerar pedido` abre o diálogo "Gerar o pedido" com a revisão, `Valor final`
  e `Forma de pagamento`. O painel "Fechamento e pagamento" do pedido
  pendente mostra só "Falta para gerar" e `Gerar pedido`.
- Erros aparecem no campo; a pendência que o servidor recusar fecha o
  diálogo e leva ao próximo passo.
- Gerar e imprimir são ações distintas; estado, autor e horário da
  confirmação permanecem visíveis.

### Financeiro comercial

- O topo apresenta total vendido, quantidade de vendas e ticket médio no período.
- Toda métrica mostra período, unidade e regra de inclusão.
- Gráficos são complementares; valores exatos continuam disponíveis em texto/tabela.
- Cancelamentos permanecem no histórico e não somem silenciosamente.
- Formatação monetária usa `pt-BR` e valores alinhados por casas decimais.

## 10. Interação e movimento

- Hover/foco: `120–160ms`.
- Expansão, drawer e popover: `180–240ms`.
- Dialog: até `240ms`.
- Movimento serve para explicar mudança de estado, não para decorar.
- Não animar continuamente cards, métricas, badges ou indicadores de automação.
- Respeitar `prefers-reduced-motion: reduce` e remover transições não essenciais.
- Nunca atrasar uma ação crítica para concluir uma animação.

## 11. Acessibilidade

- Texto normal: contraste mínimo `4.5:1`; texto grande e limites de controles: `3:1`.
- Alvo mínimo de toque: `44×44px`.
- Todos os controles funcionam por teclado e possuem foco visível de pelo menos `2px` com offset.
- Ordem de foco acompanha a ordem visual e não atravessa regiões escondidas.
- Dialogs, drawers, menus, tabs, comboboxes e Kanban mantêm ARIA dinâmica conforme o estado.
- Mudanças assíncronas relevantes usam região `aria-live`; mensagens não devem ser repetidas excessivamente.
- Ícones decorativos usam `aria-hidden="true"`; botões apenas com ícone recebem nome acessível.
- Drag-and-drop sempre possui alternativa por botão/teclado.
- Zoom a `200%`, reflow a `320px` e preferências de contraste/movimento não podem bloquear tarefas.
- Status combina texto, forma/ícone e cor.

## 12. Linguagem e conteúdo

- Usar português brasileiro direto e termos já definidos pelo domínio.
- Botões começam com verbo: `Transformar em lead`, `Aprovar Ficha`, `Tentar envio novamente`.
- Confirmações descrevem consequência: “A conversa será encerrada como Sem lead. O histórico será preservado.”
- Evitar “OK”, “Confirmar” ou “Erro inesperado” quando uma ação ou recuperação específica puder ser nomeada.
- Datas, valores, telefone e quantidade seguem formatação local consistente.
- Dados pessoais não aparecem em notificações globais ou superfícies sem necessidade operacional.

## 13. Arquitetura de implementação visual

- CSS organizado por camadas: `tokens.css` concentra `tokens`; `styles.css` concentra `base`, `layout`, `components` e poucas `utilities`.
- Tokens de tema ficam em `:root` e seletores `[data-theme]`; componentes não conhecem valores hexadecimais.
- Componentes interativos são módulos ESM ou classes isoladas e não registram estado em `window`.
- HTML semântico é a base; ARIA complementa o comportamento que o HTML nativo não cobre.
- Regras de domínio ficam fora dos componentes visuais. Primitivos recebem estado e eventos; composições coordenam o fluxo.
- Utilitários devem ser poucos e semânticos. Evitar uma classe nova para cada valor arbitrário.
- Ícones usam um único conjunto de SVGs de traço consistente; não misturar emoji, ícones preenchidos e outline como linguagem principal.

## 14. Critérios de aceite do design system

Uma tela ou componente só está pronto quando:

- usa tokens semânticos e funciona em light, dark e preferência do sistema;
- possui estados default, hover, focus, active, disabled, loading, empty e error quando aplicáveis;
- pode ser operado integralmente por teclado;
- mantém nome, papel, valor e mudanças de estado compreensíveis para tecnologia assistiva;
- funciona a `320px`, `768px`, `1200px` e com zoom de `200%`;
- não depende somente de cor, hover, drag-and-drop ou toast;
- reutiliza um primitivo existente antes de criar nova estrutura;
- mantém uma única ação primária por região;
- expõe erros perto da origem e oferece recuperação clara;
- não adiciona animação, sombra, gradiente ou container sem função perceptível.

## 15. Antipadrões proibidos

- Copiar a estética promocional do site para todas as telas operacionais.
- Usar o laranja como grande área de fundo ou para múltiplas ações concorrentes.
- Criar cards para todo agrupamento de texto.
- Esconder ações essenciais apenas em hover ou menu de três pontos.
- Usar modal sobre modal.
- Usar placeholder como label.
- Exibir status somente como ponto colorido.
- Criar um novo estilo de botão, input, badge ou panel dentro de uma feature.
- Truncar conteúdo crítico sem alternativa para leitura completa.
- Usar drag-and-drop como única forma de alterar etapa.

## 16. Padrões de jornada

Decisão: [ADR 036](docs/adr/036-padroes-de-jornada.md), a partir do
[RFC 024](docs/rfc/024-jornadas-com-menos-botoes.md), aprovado pelo PO em
15/10/2026. Requisitos: PFI-15 a PFI-20, PCX-10 a PCX-14 e PLI-09 a PLI-10
em [Pedidos MVP](.specs/features/pedidos-mvp/spec.md); PNL-01 a PNL-04 em
[CRM MVP](.specs/features/crm-mvp/spec.md). Valem para toda tela nova ou
alterada e completam a §3 (baixa carga cognitiva) e a §11 (acessibilidade).

### Orçamento de ações por região

- No máximo uma ação primária e duas secundárias visíveis por região; o resto
  vai para "Mais".
- Rótulo de botão é verbo + objeto: "Assumir atendimento", "Editar itens",
  "Limpar filtro"; nunca só "Assumir" ou "Editar".
- Alvos de toque de 44 px ou mais, com 8 px entre eles. Como entregue: nos
  atalhos e chips das listas, o contrato de 44 px e 8 px vale no celular e em
  toda tela de toque (`pointer: coarse`, tablet incluído); com mouse no
  notebook eles seguem a altura de controle (`--control-height`, 40 px). Na
  folha "Filtros", opções e botões têm 44 px (`--target-min`) em qualquer
  largura e ponteiro, notebook com mouse inclusive (P1, `fb7e932`).
- Abas só de 2 a 7, com 1 a 3 palavras cada; mais que isso vira atalho com
  contagem ou filtro em folha.

### Próximo passo único, com progresso real

- Quando uma tarefa tem passos, a tela mostra quantos estão feitos ("Para
  gerar o pedido: 1 de 3") e dá botão só ao próximo passo pendente.
- O progresso é honesto: cada passo é uma pendência real lida do domínio
  (`missingFields`), o total não muda no meio e visitar ou abrir uma seção não
  conta como feito. Sem leitura, não há número.
- Pendência que a tela não conhece vira um passo a mais ("Revisar
  pendências", total "N de 4") que leva ao painel de fechamento; nunca um
  falso "3 de 3" com a ação final bloqueada.
- Com todos os passos feitos, o progresso encolhe para uma linha ("Tudo
  pronto para gerar · 3 de 3"), com o mesmo título e o mesmo `role="status"`;
  a lista volta assim que houver pendência (P2, `3351c33`).
- O rodapé fixo do celular leva a mesma ação primária do próximo passo; a
  ação final ("Gerar pedido") só vira primária quando não há pendência.
- O preenchimento continua progressivo e não linear (`RULES.md`, regra 4):
  nada de assistente em páginas separadas.

### Ação indisponível

- Ação indisponível mas relevante usa `aria-disabled="true"`, continua
  focável e mostra o motivo ao lado ou na descrição acessível ("Salve ou
  cancele a edição aberta", "Falta: entrega prometida").
- Ativá-la não executa nada nem perde dado; nunca some sem explicação.

### Filtros em folha

- Na lista: busca, até três atalhos com contagem e o botão "Filtros".
- "Filtros" abre uma folha (painel que sobe sobre a tela no celular) com os
  grupos de filtro; Esc fecha e devolve o foco ao botão.
- Os filtros ativos aparecem num resumo, cada um com botão de remover;
  filtro fora dos atalhos aparece nomeado com "Limpar filtro".
- A contagem do resultado fica junto da lista, em região
  `aria-live="polite"`.
- Links profundos por query string abrem a lista com o filtro já no resumo.
- Vazio por filtro é diferente do vazio inicial: diz que nada atende ao filtro
  e oferece "Limpar filtro".

### Acordeão no celular

- Até 768 px, páginas longas de seções viram acordeão de uma seção aberta por
  vez; acima disso, as seções ficam abertas e empilhadas.
- O cabeçalho de cada seção é um botão com `aria-expanded` e `aria-controls`
  e mostra o estado em texto ("Completo", "Falta a cor do item 2"), que entra
  no nome acessível.
- A seção inicial vem do hash da URL (por exemplo `#itens`), senão do
  primeiro passo pendente, senão do Resumo; uma seção em edição não fecha até
  Salvar ou Cancelar, e o rascunho sobrevive a redimensionar a tela.
- Abrir uma seção grava o hash na URL sem navegar (`history.replace` do
  router), para não remontar a view, que o shell identifica pela `fullPath`,
  e perder foco e rascunho.
- O botão "Editar" + seção fica fora do botão do cabeçalho (irmão do `h2`) e
  só aparece na seção aberta; com uma seção em edição, os outros cabeçalhos
  ficam com `aria-disabled` e o motivo.

### Um só modelo de edição

- Todo dado editável fica atrás de "Editar" + seção → Salvar/Cancelar ou do
  diálogo da ação; nunca num bloco sempre aberto ao lado de seções em
  leitura.
- O diálogo da ação final (por exemplo, "Gerar o pedido") revisa o que vai
  acontecer, pede só o que falta, foca o primeiro campo e devolve o foco com
  Esc ou "Voltar" ao botão que o abriu (no pedido, o do trilho ou o do
  rodapé do celular).
- Como entregue no diálogo "Gerar o pedido" (T125): revisão com cliente,
  itens e peças, entrega prometida e arte do pedido; erro no campo sem enviar
  nada; envio único mesmo com Enter duplo (`aria-busy`/`aria-disabled`); 422
  com pendência fora do diálogo fecha, relê o pedido e leva o foco ao próximo
  passo; 409 e queda de conexão mantêm o diálogo aberto com a mensagem
  focada; campos, opções e botões com 44 px.

### Estados desenhados

- Carregando, vazio, erro e sem permissão têm desenho próprio em toda região.
- Erro de leitura nunca vira "0" nem faz a seção sumir: o número mostra "—"
  com "Tentar novamente".
- Sem permissão, a ação não aparece; a API continua autorizando.

### Metas de controles na primeira tela

Contagem fora da navegação do app, com dados sintéticos, em 390×844 e
1366×768. A T132 transforma as metas em teste; as medições registradas pelas
fatias estão no "Resultado" do
[RFC 024](docs/rfc/024-jornadas-com-menos-botoes.md).

| Tela             | Celular                                                      | Notebook |
| ---------------- | ------------------------------------------------------------ | -------- |
| Pedido aberto    | ≤ 12; documento ≤ 1.800 px; ≤ 1 "Editar" visível; 1 primária | ≤ 16     |
| Conversa         | ≤ 9 antes de assumir; ≤ 12 depois; cabeçalho ≤ 2             | ≤ 24     |
| Caixa de Entrada | ≤ 15; barra de ferramentas de 7 para 5                       | ≤ 24     |
| Pedidos          | ≤ 12, com o 1º cartão inteiro acima da barra inferior        | ≤ 19     |

---

Este documento define a direção visual. Etapas do Kanban, permissões, campos obrigatórios da Ficha e vocabulário financeiro estão resolvidos nos documentos canônicos e prontos para especificação e implementação pelo Tech Lead.
