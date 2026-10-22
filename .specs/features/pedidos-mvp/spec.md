# Pedidos MVP — Especificação

**Status:** implementação integrada; UAT e aprovação física de produção pendentes
**Atualizado em:** 05/10/2026 — PR 142
**Data:** 12/09/2026
**Decisões de produto:** [`context.md`](context.md)
**Arquitetura:** [`design.md`](design.md) · **Tasks:** [`tasks.md`](tasks.md)
**Lastro de datas (29/09/2026):** [ADR 008](../../../docs/adr/008-lastro-de-datas-do-pedido.md) · história P1-10
**Abertura no primeiro ponto da ficha (02/10/2026):** [ADR 014](../../../docs/adr/014-pedido-abre-no-primeiro-ponto-da-ficha.md) · história P1-1 (PAB-01..04)
**Itens com os sete pontos (02/10/2026):** [ADR 016](../../../docs/adr/016-itens-com-os-sete-pontos-da-ficha.md) · história P1-11
**Ficha impressa com os sete pontos (02/10/2026):** [ADR 017](../../../docs/adr/017-ficha-impressa-com-os-sete-pontos.md) · P1-5 (PIM-06..10) e PLA-08
**Cliente acompanha o contato (03/10/2026):** [ADR 018](../../../docs/adr/018-cliente-do-pedido-acompanha-o-contato.md) · história P1-12
**Jornadas com menos botões (15/10/2026):** [ADR 036](../../../docs/adr/036-padroes-de-jornada.md) · [RFC 024](../../../docs/rfc/024-jornadas-com-menos-botoes.md) · PFI-15..20, PCX-10..14, PLI-09..10 (T121–T133)
**PDF da ficha no celular (16/10/2026):** [ADR 037](../../../docs/adr/037-gerar-pdf-da-ficha-para-uso-mobile.md) · [RFC 025](../../../docs/rfc/025-ficha-em-pdf-para-uso-mobile.md) · PIM-13..14 e LOJ-38 (T134)
**Mockups:** `.design/mesa-de-trabalho/` (canvas "Mesa de Trabalho Silmer")

## Baseline vigente

O código atual seleciona ficha-canonical-v5 (ADR 020 / TEC-01..08), com aprovação provisória do PO; assinatura física de Rose e Operação é gate separado. TEC supersede PFI/PIM/REV nos pontos de Técnica, origem da arte, Estampa (referência) e rótulos. As seções de verificação datadas abaixo são histórico de entregas e não comprovam homologação, deploy ou aceite externo atuais.

## Problema original e resultado

O Kanban e o Negócio foram aposentados (ADR 004) porque o preenchimento da
ficha não é linear: o cliente responde fora de ordem, o agente preenche o que
consegue e o vendedor completa o resto quando assume a conversa. O módulo entregue oferece registro, confirmação humana, impressão e triagem das conversas que aguardam vendedor. A homologação desses fluxos no ambiente alvo continua pendente.

## Objetivos

- Todo pedido do zero em que o cliente informa um ponto da ficha vira um
  pedido pendente, sem trabalho manual de criação (ADR 014).
- O vendedor responsável completa, confirma e imprime um pedido sem sair
  das telas Caixa de Entrada e Pedidos.
- Nenhum pedido é impresso sem confirmação humana registrada (autor e
  horário).
- A ficha impressa reproduz os blocos e campos da v5, com aprovação provisória e gate físico antes da produção.

## Fora do escopo

| Item                                                          | Motivo                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Cobrança PIX, conferência de comprovante, status de pagamento | Toda confirmação é humana no MVP; sem automação de pagamento.                                  |
| Produção, entrega, pedido perdido ou cancelado                | Não existem como status no MVP. O lastro (P1-10) guarda só datas.                              |
| Tela Mesa de Trabalho, marcos visuais, anel de completude     | Cortados na revisão de escopo; a Caixa de Entrada faz a triagem.                               |
| Histórico de quem preencheu cada campo (UI)                   | P2. A trilha fica gravada; só não aparece.                                                     |
| Ampliações comerciais no detalhe do cliente                   | Evolução posterior; KPIs de confirmados já estão no Dashboard.                                 |
| Edição campo a campo                                          | Edição é por seção.                                                                            |
| Impressão no template legado v1                               | v1 é referência documental; o MVP imprime v5.                                                  |
| Validação de modelo contra catálogo                           | Sem catálogo autorizado no MVP.                                                                |
| Reaproveitar tabelas e módulos de Negócio                     | Proibido pela ADR 004.                                                                         |
| Remover rotas mortas de Kanban/Negócio do OpenAPI             | Caminhos aposentados removidos na reconciliação de 05/10/2026; schemas históricos preservados. |

---

## Histórias

### P1-1: Agente cria o pedido pendente ⭐ MVP

**História:** Como vendedor, quero que o pedido já exista quando o cliente
começa a descrever o que quer, para não redigitar o que o agente coletou.

Desde a [ADR 014](../../../docs/adr/014-pedido-abre-no-primeiro-ponto-da-ficha.md),
o agente pede a abertura com `open_order` na reserva de envio ou no handoff
(PAB-01..03); o evento `order.intent_confirmed` continua aceito, obsoleto,
para workflows antigos.

**Aceite:**

1. **PCL-01** WHEN o agente pede a abertura do pedido numa conversa sem
   pedido pendente THEN o sistema SHALL criar exatamente um pedido `pendente`
   vinculado à conversa e ao contato, com número `NN-CRM` reservado.
2. **PCL-02** WHEN já existe pedido pendente na conversa THEN um novo pedido
   de abertura SHALL reutilizar o pedido existente (operação idempotente).
3. **PCL-03** WHEN a conversa só tem pedidos confirmados e o agente pede
   nova abertura THEN o sistema SHALL criar um novo pedido pendente.
4. **PAG-01** WHEN o agente envia `briefing_patch` e a conversa está com o
   agente e tem pedido pendente THEN os campos da ficha SHALL ser projetados no
   pedido pendente.
5. **PAG-02** WHEN a conversa está com um vendedor (`automation_state = human`)
   THEN patches do agente SHALL ser ignorados para o pedido.
6. **PAG-03** WHEN o patch do agente traz valor, condição de pagamento ou
   status THEN o sistema SHALL rejeitar esses campos, como já faz hoje.
7. **PAB-01** WHEN a ficha da conversa (briefing anterior unido ao patch da
   rodada) passa a ter, pela primeira vez, um valor real em um dos sete
   pontos (tipo de roupa, cor, quantidade, estampa, tecido, tamanhos, gola)
   THEN o workflow SHALL enviar `open_order: true` na reserva de envio ou no
   handoff dessa rodada e de todas as seguintes. "Definir com o vendedor" e o
   nome sozinho SHALL NOT abrir o pedido, e `order_intent_confirmed` do modelo
   SHALL ser ignorado.
8. **PAB-02** WHEN a rodada não é pedido do zero (ADR 013) THEN o workflow
   SHALL NOT abrir pedido, salvo um já aberto; WHEN o handoff, de qualquer
   motivo, inclusive arquivo ou áudio, acontece com um ponto na ficha THEN ele
   SHALL levar `open_order: true`.
9. **PAB-03** WHEN `message.send.requested` ou `handoff.requested` traz
   `open_order: true` THEN o CRM SHALL, depois de aplicar o evento, criar ou
   reutilizar o pedido pendente pela ficha unida (PCL-01..03) e responder
   `order: {opened: true, id, created}`; replay ou evento repetido SHALL NOT
   criar um segundo pedido. `open_order` em outro evento ou com valor não
   booleano SHALL ser recusado com 400.
10. **PAB-04** WHEN o CRM não consegue abrir o pedido THEN o evento SHALL ser
    aceito mesmo assim (a resposta ao cliente sai), a resposta SHALL trazer
    `order: {opened: false, error}`, o CRM SHALL registrar log sem dados
    pessoais e a auditoria `integration.n8n.order.open_failed`, e o workflow
    SHALL enviar `workflow.failed` com `ORDER_OPEN_FAILED` para a conversa.

**Teste independente:** numa conversa nova do workflow DEV, mandar uma
mensagem com um ponto da ficha (ex.: "quero camisetas brancas") e ver o pedido
pendente na lista de Pedidos e na gaveta da conversa.

---

### P1-2: Vendedor cria o pedido manualmente ⭐ MVP

**História:** Como vendedor, quero criar o pedido quando o agente não chegou a
detectar a intenção (ex.: o cliente pediu uma pessoa logo no início).

**Aceite:**

1. **PCL-10** WHEN o dono da conversa ou um administrador aciona "Criar
   pedido" numa conversa sem pedido pendente THEN o sistema SHALL criar o
   pedido pendente pré-preenchido com a pré-ficha atual da conversa.
2. **PCL-11** WHEN a conversa já tem pedido pendente THEN a ação "Criar
   pedido" SHALL não aparecer e a API SHALL responder com o pedido existente.

**Teste independente:** assumir uma conversa sem pedido, criar e abrir o
pedido.

---

### P1-3: Vendedor completa o pedido por seção ⭐ MVP

**História:** Como vendedor responsável, quero editar o pedido em blocos que
batem com a ficha impressa, para garantir que o que imprimo está certo.

**Aceite:**

1. **PFI-01** WHEN o pedido é aberto THEN a página SHALL mostrar, nesta ordem:
   Resumo do pedido, Itens e especificações, Observações do pedido, Controle
   de produção (informativo), Dados do atendimento (não impresso), Fechamento
   e pagamento. Desde a ADR 008, o Lastro do pedido entra logo depois do
   Resumo (PLA-01). Emendado por PFI-18 e PFI-20 (RFC 024): "Controle de
   produção" sai da tela, o lastro aparece como "Datas do pedido" e, no
   celular, as seções viram acordeão.
2. **PFI-02** Resumo SHALL conter: cliente (vindo do contato, bloqueado; só
   nome confirmado desde a ADR 016, PIT-11; acompanha o contato enquanto o
   pedido está pendente desde a ADR 018, PCT-01),
   entrega prometida, total de peças (calculado), tipo de serviço,
   evento/nome, vendedor (dono da conversa), data do pedido (definida na
   confirmação) e FAB (configuração `FAB_CODE`). Desde 30/09/2026 a tela diz
   "Entrega prometida" e "Tipo de serviço"; os campos continuam
   `data_entrega_confirmada` e `aplicacao`, e a ficha v2 impressa, travada por
   hash, mantém "Entrega confirmada" e "Aplicacao".
3. **PFI-03** Cada item SHALL conter: tipo, modelo, malhas (1 ou mais), cor da
   frente, costas, manga direita, manga esquerda, viés gola, viés mangas e
   grade (tamanho + quantidade inteira > 0, ao menos uma linha). Desde a ADR
   016 (02/10/2026), o item tem os principais e os adicionais de PIT-01 e
   PIT-02 e pode ser salvo incompleto (PIT-03); a linha de tamanho continua
   com tamanho e quantidade inteira > 0.
4. **PFI-04** Total do item e total do pedido SHALL ser calculados a partir da
   grade e nunca digitados.
5. **PFI-05** Observações SHALL aceitar de 0 a 5 linhas de texto.
6. **PFI-06** WHEN o vendedor clica "Editar" numa seção THEN a seção SHALL
   virar formulário com Salvar e Cancelar; salvar grava a seção inteira de uma
   vez. Só uma seção fica em edição por vez. Emendado por PFI-17 (RFC 024):
   o botão nomeia a seção ("Editar itens") e, com outra seção em edição, os
   demais ficam com `aria-disabled` e o motivo.
7. **PFI-07** Cores de manga e viés SHALL aceitar o valor explícito "Não
   aplicável".
8. **PFI-08** "Dados do atendimento" (arte, locais, logística, finalidade,
   perfil de compra) SHALL ser exibidos em modo leitura a partir da pré-ficha e
   marcados como "não saem na ficha impressa". Desde a ADR 016, ali ficam
   também a quantidade, os tamanhos e a estampa ditos pelo cliente que não
   viraram campo do pedido ("Quantidade informada", "Tamanhos informados",
   "Estampa desejada") e todo ponto deixado para o vendedor. Emendado por
   PFI-18 (RFC 024): no celular, a seção fica dentro do acordeão.
9. **PFI-09** O banner do topo SHALL listar o que falta para confirmar. Desde
   a ADR 016, lista só o que impede gerar (PIT-05, PIT-06); campo em branco
   que não bloqueia não é listado. Emendado por PFI-15 (RFC 024): o banner
   vira o progresso real "Para gerar o pedido: N de 3" no topo.
10. **PAU-01** WHEN quem não é dono da conversa nem administrador abre o pedido
    THEN a página SHALL ser somente leitura e a API SHALL recusar edições com 403.
11. **PFI-10** WHEN o pedido está confirmado THEN todas as seções SHALL ficar
    em modo leitura; para alterar é preciso reabrir. Exceção: o Lastro do
    pedido (PLA-04).
12. **PFI-14** Os campos do Resumo e dos itens SHALL ser texto digitado à mão,
    sem lista de opções, até o catálogo de opções ser aprovado (decisão do PO
    em 30/09/2026). A amostra de cor ao lado de uma cor digitada continua.

**Teste independente:** editar a grade de um item e ver o total do item, do
pedido e da lista de Pedidos atualizados.

---

### P1-4: Vendedor confirma o pedido ⭐ MVP

**História:** Como vendedor responsável, quero confirmar o pedido registrando
valor e forma de pagamento, para liberar a impressão.

**Aceite:**

1. **PCL-04** WHEN o dono da conversa ou um administrador aciona "Confirmar
   pedido" com valor final e condição válidos THEN o status SHALL virar
   `confirmado`, gravando valor, condição, autor, horário e data do pedido.
   Desde a ADR 016, a tela diz "Gerar pedido" e "Forma de pagamento", e cada
   item também precisa dos sete pontos principais (PIT-05).
2. **PFI-11** Valor final SHALL ser digitado como texto em reais (ex.:
   `4.820,00`) com prefixo fixo `R$` e armazenado em centavos inteiros > 0.
3. **PFI-12** Condição de pagamento SHALL ser uma entre: Pix, Cartão de
   crédito, Cartão de débito. Desde a ADR 016, a tela diz "Forma de
   pagamento"; o campo da API continua `paymentCondition`.
4. **PCL-05** WHEN valor ou condição está ausente ou inválido, ou o pedido não
   tem ao menos um item com grade THEN a confirmação SHALL ser recusada (422)
   com mensagem por campo e o status SHALL continuar `pendente`. Desde a ADR
   016, também quando algum item não tem um dos sete pontos principais; o 422
   `ORDER_NOT_CONFIRMABLE` nomeia cada um (PIT-06), e quando falta a entrega
   prometida (PIT-12).
5. **PCL-06** WHEN outro usuário tenta confirmar THEN a API SHALL responder 403
   e a interface SHALL não exibir o botão.
6. **PCL-09** WHEN duas confirmações concorrem sobre a mesma versão THEN uma
   SHALL vencer e a outra SHALL receber 409.
7. **PCL-08** Nenhum status SHALL mudar por pagamento, produção, tempo ou
   agente — só por Confirmar e Reabrir.
8. **PFI-13** "Confirmar pedido" SHALL ser o único botão primário da página.
   Emendado por PFI-16 e PFI-19 (RFC 024): a única primária passa a ser a do
   próximo passo ou, com tudo pronto, "Gerar pedido", que abre o diálogo com
   valor final e forma de pagamento.

**Teste independente:** preencher valor e condição, confirmar e ver o pedido
em Confirmados com "Confirmado por <nome> · <data hora>".

---

### P1-5: Vendedor imprime o pedido confirmado ⭐ MVP

**Aceite:**

1. **PIM-01** WHEN o pedido está pendente THEN o botão "Imprimir" SHALL
   aparecer desabilitado, com cadeado e o motivo "Disponível depois de
   confirmar o pedido".
2. **PIM-02** WHEN o pedido está confirmado THEN "Imprimir" SHALL abrir o
   documento no template `ficha-canonical-v2` (A4 paisagem, 2 páginas), com os
   dados do pedido, controle de produção em branco e sem valor ou condição de
   pagamento.
3. **PIM-03** WHEN a impressão de um pedido pendente é pedida direto à API
   THEN o servidor SHALL recusar com 409.
4. **PIM-04** O documento impresso SHALL não conter a faixa "Amostra sintética
   - não produzir".
5. **PIM-05** Qualquer usuário operacional autenticado SHALL poder imprimir um
   pedido confirmado.

**Teste independente:** confirmar e imprimir; comparar o documento com
`output/pdf/ficha-canonica-sintetica-v2.pdf`.

**Ficha v3 com os sete pontos (ADR 017, 02/10/2026).** Desde a T74
(03/10/2026, aprovação provisória do PO), "Imprimir" abre o documento no
template `ficha-canonical-v3` (A4 paisagem, duas páginas ou mais), com o
resto de PIM-02 igual; PIM-03 a PIM-05 valem para os dois templates. A v2
continua no repositório, travada por hash.

6. **PIM-06** No template `ficha-canonical-v3`, cada item SHALL trazer os sete
   pontos numerados, nesta ordem e com estes rótulos: Tipo de roupa (`tipo`),
   Cor (`cor`), Quantidade, Estampa (`estampa`), Tecido (`malhas` unidas por
   " / "), Tamanhos (blocos de tamanho e quantidade da `grade`) e Gola
   (`gola`). Quantidade SHALL ser a soma da grade, nunca um campo gravado.
7. **PIM-07** Os adicionais (Modelo, Cor frente, Cor costas, Manga direita,
   Manga esquerda, Viés gola e Viés mangas) SHALL sair num bloco "Adicionais"
   do item só quando ao menos um estiver preenchido, só os preenchidos e nessa
   ordem; o valor gravado "NAO APLICAVEL" é preenchido e SHALL sair.
8. **PIM-08** WHEN a ficha foi gravada antes dos sete pontos (sem `cor`,
   `estampa` e `gola`) THEN a v3 SHALL imprimir "—" nesses pontos e manter no
   papel todos os campos da v2.
9. **PIM-09** O Resumo da v3 SHALL usar os rótulos da tela, "Tipo de serviço"
   (`aplicacao`) e "Entrega prometida" (`data_entrega_confirmada`), e manter
   Cliente, Evento / Nome, Data do pedido, Vendedor, FAB e Total de peças, sem
   valor final nem forma de pagamento (D12); campo vazio SHALL sair como "—".
   A página 2 SHALL manter os 14 campos de produção em branco da v2; a faixa
   de amostra e a caixa de aprovação SHALL sair só na amostra de revisão.
10. **PIM-10** A impressão SHALL continuar no template v2 até uma aprovação
    da v3 ficar registrada; a troca SHALL acontecer num único ponto
    (`PRINT_TEMPLATE`), e a validação SHALL recusar a v3 nesse ponto sem
    aprovação. A aprovação provisória do PO vale para desenvolvimento e
    cloud-dev; a produção SHALL exigir a aprovação final, a assinatura física
    de Rose e Operação na amostra impressa (gate de go-live).
11. **PIM-11** Todo rótulo impresso da v3, nas duas páginas e na faixa de
    amostra, SHALL ter os acentos do português. O valor gravado
    "NAO APLICAVEL" SHALL sair como "NÃO APLICÁVEL" sem mudar o dado gravado;
    o texto digitado por pessoas SHALL sair como foi digitado.
12. **PIM-12** WHEN os itens não cabem na página 1 THEN cada página de
    continuação SHALL repetir o cabeçalho com o número do pedido e trazer
    "Página N · continuação dos itens"; item SHALL não se dividir entre
    páginas e SHALL manter o número; observações e total SHALL fechar a última
    página de itens; o controle de produção SHALL vir por último, com o seu
    cabeçalho.

13. **PIM-13** WHEN o Pedido está confirmado THEN “Gerar PDF” SHALL baixar
    `pedido-NN-CRM.pdf` com o template aprovado, sem exigir a janela de impressão.
    No aparelho compatível, “Compartilhar PDF” SHALL oferecer o arquivo à folha
    nativa para a pessoa escolher o WhatsApp ou outro destino. Sem suporte ao
    compartilhamento, o download SHALL continuar disponível.
14. **PIM-14** A rota PDF SHALL exigir sessão e `order.print`, recusar Pedido
    pendente com 409 e retornar anexo `application/pdf` privado sem cache.
    Falhas e `HEAD` SHALL não contar como primeira ficha da loja. O servidor
    SHALL não enviar automaticamente nem guardar uma cópia do PDF.

**Teste independente (v3):** abrir `output/pdf/ficha-canonica-sintetica-v3.pdf`
e conferir os sete pontos, os adicionais e o lastro na página 1, com o roteiro
de `docs/phase0/FICHA-PDF-REVIEW-V3.md`.

---

### P1-6: Vendedor reabre um pedido confirmado ⭐ MVP

**Aceite:**

1. **PCL-07** WHEN o dono da conversa ou um administrador aciona "Reabrir
   pedido" THEN o status SHALL voltar a `pendente`, mantendo número, valor e
   condição já gravados, registrando autor e horário da reabertura e
   bloqueando a impressão.
2. **PCL-12** WHEN o pedido reaberto é confirmado de novo THEN autor, horário e
   data do pedido SHALL ser os da nova confirmação.

---

### P1-7: Lista de Pedidos ⭐ MVP

**Aceite:**

1. **PLI-01** O menu lateral SHALL ter "Pedidos" logo após "Caixa de Entrada",
   levando a `/pedidos`.
2. **PLI-02** A lista SHALL ter filtro Todos · Confirmados · Pendentes e busca
   por número, cliente ou telefone. Emendado por PLI-09 e PLI-10 (RFC 024):
   três chips (Todos, Meus pendentes, Prontos para produção) e o botão
   "Filtros" com os demais filtros; a busca continua.
3. **PLI-03** Os pedidos SHALL aparecer agrupados em Confirmados e Pendentes,
   com contagem em cada grupo.
4. **PLI-04** Colunas: Pedido, Cliente (com evento e vendedor), Peças, Valor,
   Situação e ações.
5. **PLI-05** Situação SHALL mostrar, no pendente, o que falta e há quanto
   tempo o pedido não muda; no confirmado, "Confirmado por <nome> ·
   <data hora>".
6. **PLI-06** Ações: confirmado → "Imprimir" (primária) e "Abrir"; pendente →
   "Continuar", que abre a página do pedido.
7. **PLI-07** A lista SHALL paginar com "Ver mais".
8. **PLI-08** WHEN um pedido é criado, editado, confirmado ou reaberto THEN a
   lista e a gaveta abertas SHALL refletir a mudança sem recarregar.
9. **PGE-01** A página do pedido SHALL pertencer a Pedidos: item de menu ativo
   "Pedidos" e rastro "← Pedidos / NN-CRM", com a origem quando aberta a partir
   de uma conversa.

---

### P1-8: Caixa de Entrada por quem precisa agir ⭐ MVP

**Aceite:**

1. **PCX-01** O filtro "Situação" atual (estados da conversa) e o bloco
   "Sugestão pendente da IA" SHALL ser removidos.
2. **PCX-02** O inbox SHALL ter o filtro "Estado" com: Todas · Aguardando
   vendedor · Com o agente · Com vendedor. Emendado por PCX-14 (RFC 024): os
   estados passam para Situação, na folha "Filtros", e a fila mostra os
   atalhos Todas · Aguardando · Minhas com contagem.
3. **PCX-03** WHEN a conversa tem handoff pendente THEN SHALL mostrar o motivo
   da parada (a partir do `reason_code`) e há quanto tempo está parada.
4. **PCX-04** WHEN "Aguardando vendedor" está selecionado THEN a lista SHALL
   ordenar por tempo parado, do maior para o menor.
5. **PCX-05** SHALL continuar funcionando como hoje: fila Todas/Minhas/Sem
   responsável, Arquivar e ver arquivadas, Repassar atendimento, Assumir,
   Editar nome e Ver contato. A Caixa de Entrada SHALL NOT oferecer
   "Devolver à IA": a conversa com uma pessoa não volta para o bot (ADR 015).
   Emendado por PCX-13 e PCX-14 (RFC 024): a fila Todas/Minhas/Sem
   responsável vira o filtro Responsável da folha "Filtros", "Assumir
   atendimento" ocupa o lugar do campo de mensagem e "Encerrar conversa" vai
   para "Mais"; as demais ações continuam.

---

### P1-9: Gaveta do pedido na conversa ⭐ MVP

Superado por PCX-10 a PCX-12 (RFC 024, ADR 036): o botão "Pedido" e a gaveta
dão lugar ao link do pedido no cabeçalho e ao resumo em Detalhes › Pedido.
A T126 foi entregue em `ux/jornadas` (`c1a9023`), que removeu
`OrderDrawer.vue`; PCX-06 a PCX-09 ficam abaixo como histórico e deixam de
valer quando `ux/jornadas` chegar ao `master`.

**Aceite:**

1. **PCX-06** O cabeçalho da conversa SHALL ter um botão "Pedido" com o status
   atual (Pendente, Confirmado ou Sem pedido). Superado por PCX-10 (RFC 024).
2. **PCX-07** WHEN o botão é acionado THEN uma gaveta lateral SHALL abrir com
   número, status, o que falta, itens (tipo, modelo, peças), total de peças,
   valor (quando houver) e o botão "Abrir pedido". A gaveta não edita.
   Superado por PCX-12 (RFC 024).
3. **PCX-08** WHEN não há pedido pendente e o usuário é dono ou administrador
   THEN a gaveta SHALL oferecer "Criar pedido" (PCL-10). Superado por PCX-11
   (RFC 024).
4. **PCX-09** A gaveta SHALL fechar com Esc e com clique fora, devolvendo o
   foco ao botão que a abriu. Superado por PCX-10 e PCX-12 (RFC 024): sem
   gaveta, o pedido abre por link.

---

### P1-10: Lastro de datas do pedido ⭐ MVP

**História:** Como dono da operação, quero ver em cada pedido quando o cliente
chegou, quando fechou, quando pagou, quando prometemos entregar e quando de
fato entregamos, na ficha digital e na impressa.

**Aceite:**

1. **PLA-01** WHEN o pedido é aberto THEN a página SHALL mostrar a seção
   "Lastro do pedido" logo depois do Resumo, com cinco datas nesta ordem:
   Primeiro contato, Pedido fechado, Pagamento, Entrega prometida e Entrega
   realizada, e quantas delas já existem. Emendado por PFI-20 (RFC 024): na
   tela a seção se chama "Datas do pedido"; a ficha impressa mantém "Lastro
   do pedido".
2. **PLA-02** Primeiro contato SHALL ser a abertura da conversa que originou o
   pedido, copiada na criação e nunca digitada; pedidos criados antes da
   migração SHALL recebê-la da conversa. No Pedido manual sem conversa, SHALL
   ser o instante de criação do pedido; legados sem a data SHALL receber
   `created_at` sem reescrever snapshots confirmados (ADR 039).
3. **PLA-03** Pedido fechado SHALL ser a data do pedido (PCL-04, PCL-12) e
   Entrega prometida SHALL ser a entrega prometida do Resumo (campo
   `data_entrega_confirmada`); nenhuma das duas é editada no lastro.
4. **PLA-04** WHEN o dono da conversa ou um administrador informa "Pago em" e
   "Entregue em" THEN o sistema SHALL gravar as duas datas juntas, em pedido
   pendente ou confirmado, sem reabrir; campo vazio limpa a data. Para Pedido
   manual sem conversa, apenas “Pago em” SHALL ser digitável, preservando a
   entrega existente. “Entregue em” SHALL vir da confirmação PLA-11 (ADR 039).
5. **PLA-05** WHEN uma data não é um dia válido ou é depois de hoje (horário de
   São Paulo) THEN a interface SHALL mostrar o erro junto ao campo e a API
   SHALL recusar com 422 `INVALID_DATE` nomeando os campos.
6. **PLA-06** Nenhuma data do lastro SHALL mudar o status, bloquear a
   confirmação, entrar no que falta ou mudar a impressão (PCL-08). Desde a
   ADR 016, a entrega prometida é a exceção: é exigida para gerar e entra no
   que falta (PIT-12); pagamento e entrega realizada continuam sem
   bloquear.
7. **PLA-07** WHEN quem não é dono nem administrador tenta gravar THEN a
   interface SHALL não exibir "Editar" no lastro e a API SHALL responder 403;
   uma versão desatualizada SHALL receber 409. Emendado por PFI-17 (RFC
   024): o botão de quem pode gravar se chama "Editar datas".
8. **PLA-08** A ficha impressa SHALL trazer as cinco datas do lastro na
   página 1 do template `ficha-canonical-v3` com os sete pontos (ADR 017, que
   supera a v3 por produto), cada uma uma vez só: Data do pedido e Entrega
   prometida no Resumo; Primeiro contato, Pagamento e Entrega realizada na
   faixa "Lastro do pedido". Dia ainda não registrado SHALL sair como "—".
9. **PLA-09** Enquanto a v2 imprime, a entrega confirmada SHALL sair como
   dd/mm/aaaa, igual à amostra aprovada.

10. **PLA-10** O Dashboard SHALL mostrar “Meus afazeres de entrega”, com a
    pergunta “O pedido NN-CRM já foi entregue?” para cada pedido manual sem
    conversa, confirmado, não teste, sem entrega e do responsável autenticado.
    SHALL incluir pedidos sem prazo e com prazo futuro, ordenados por prazo e
    número, sem criar tarefas no domínio legado. Lista vazia e falha de leitura
    SHALL ser estados distintos; eventos de pedido SHALL atualizar a lista.
11. **PLA-11** WHEN o vendedor marca a entrega THEN a API SHALL exigir pessoa
    humana responsável ou administrador e versão atual, registrar o dia de São
    Paulo no servidor e retirar o afazer. Pagamento, status, número e snapshot
    SHALL permanecer inalterados. Pedido pendente, teste, loja ou de conversa
    SHALL ser recusado nesse comando. A entrega SHALL ser auditada e
    idempotente; repetição não SHALL mudar a data já registrada.
12. **PLA-12** A confirmação SHALL operar por teclado, indicar andamento,
    anunciar sucesso/erro e mover foco ao próximo afazer ou ao título da seção
    após sucesso. Falha SHALL manter o afazer, sem simular entrega; conflito de
    versão SHALL exigir atualização antes de nova tentativa. A API SHALL
    recusar data de entrega enviada pelo cliente para Pedido manual.

**Teste independente:** criar pedido manual e ver Primeiro contato preenchido;
editar apenas pagamento; confirmar o pedido e marcar sua entrega no Dashboard.
Ver “Entregue em” preenchido sem mudar pagamento, status ou ficha já gerada.

---

### P1-11: Itens com os sete pontos da ficha ⭐ MVP

**História:** Como vendedor, quero que o item do pedido traga os sete pontos
que o bot coletou (tipo de roupa, cor, quantidade, estampa, tecido, tamanhos e
gola), para completar só o que falta e gerar um pedido que a fábrica consegue
produzir.

Decisão: [ADR 016](../../../docs/adr/016-itens-com-os-sete-pontos-da-ficha.md),
que substitui a regra A01 do [contexto](context.md).

**Aceite:**

1. **PIT-01** Cada item SHALL mostrar os principais nesta ordem: Tipo de
   roupa (`tipo`), Cor (`cor`), Quantidade (soma dos tamanhos, nunca
   digitada), Estampa (`estampa`), Tecido (`malhas`), Tamanhos (`grade`) e
   Gola (`gola`), com o cabeçalho "Item N · <tipo de roupa ou —> ·
   <quantidade> peças".
2. **PIT-02** Modelo, Cor frente, Cor costas, Manga direita, Manga esquerda,
   Viés gola e Viés mangas SHALL ficar num bloco recolhível "Adicionais (não
   obrigatórios)", fechado ao abrir a página, que o teclado abre e fecha
   (`aria-expanded`, foco no botão). Mangas e viés mantêm "Não aplicável".
3. **PIT-03** WHEN o vendedor salva os itens com campos em branco, sem tecido
   ou sem tamanhos THEN o sistema SHALL aceitar; cada linha de tamanho
   continua exigindo tamanho e quantidade inteira > 0, tecido não tem linha em
   branco, e valem os limites de 200 caracteres por texto e 50 itens.
4. **PIT-04** WHEN o pedido foi gravado antes da ADR 016 THEN o sistema SHALL
   lê-lo com cor, estampa e gola em branco e recalcular o que falta pela regra
   nova, sem migração; por uma versão, o `PATCH` dos itens SHALL aceitar item
   sem essas três chaves e gravá-las em branco.
5. **PIT-05** Gerar o pedido SHALL exigir ao menos um item, em cada item os
   sete principais (tipo, cor, estampa, ao menos um tecido, ao menos uma linha
   de tamanho e gola), a entrega prometida (PIT-12), o valor final e a forma
   de pagamento. Nada mais SHALL bloquear nem ser listado como faltando: nem
   os adicionais, nem o resto do resumo.
6. **PIT-06** "Falta para gerar" SHALL nomear cada ponto em palavras simples
   ("cor do item 1", "tamanhos do item 2", "entrega prometida", "valor
   final", "forma de pagamento"), a partir de `missingFields`: `items`,
   `items[N].tipo`, `items[N].cor`, `items[N].estampa`, `items[N].malhas`,
   `items[N].grade`, `items[N].gola`, `summary.data_entrega_confirmada`,
   `finalAmount` e `paymentCondition`, nesta ordem. O que se preenche em
   outra seção SHALL dizer onde ("Informar no Resumo" abre o resumo na
   entrega prometida). A Situação da lista de Pedidos e a gaveta da conversa
   SHALL usar a mesma lista. Emendado por PFI-15 e PFI-19 (RFC 024): na
   página do pedido, "Falta para gerar" nomeia os passos do topo (Entrega
   prometida, Itens, Arte do pedido) e o botão do próximo passo diz o verbo
   ("Informar a entrega prometida"); valor final e forma de pagamento saem da
   lista da página e passam a ser digitados no diálogo "Gerar o pedido". A
   API e `missingFields` não mudam.
7. **PIT-07** WHEN o bot projeta a pré-ficha THEN o item 1 SHALL receber:
   `product_model` (ou, sem ele, `product_type`) em Tipo de roupa; `colors` em
   Cor; `artwork_status` em Estampa, com os locais de `artwork_locations`
   depois de " · " e "sem aplicação" como "Sem estampa"; `fabrics` em Tecido;
   `collar` em Gola. `artwork_technique` SHALL ir para Tipo de serviço só
   quando nomeia uma técnica (silk/serigrafia, sublimação, DTF, DTG, bordado,
   transfer ou "sem aplicação"). "Definir com o vendedor" SHALL nunca virar
   valor do pedido: o campo fica vazio e o texto fica em Dados do atendimento.
8. **PIT-08** WHEN os tamanhos chegam como texto THEN eles SHALL virar
   Tamanhos só quando cada parte é um tamanho conhecido (PP, P, M, G, GG, XG,
   XGG, EG, EGG, G1–G5, XX, JEGÃO) com uma quantidade inteira > 0, na mesma
   ordem em todo o texto ("5 P, 10 M", "P5 M10", "25 M e 25G", "M: 15; G:
   15"); o que deixar dúvida SHALL ficar com Tamanhos vazio e o texto em
   "Tamanhos informados".
9. **PIT-09** A quantidade que o cliente informou SHALL aparecer ao lado de
   "Total de peças"; WHEN há tamanhos e a soma difere THEN a tela SHALL
   mostrar, sem bloquear, "A soma dos tamanhos (X) é diferente da quantidade
   informada (Y)"; sem tamanhos, a Quantidade do item 1 SHALL mostrar "—
   (cliente informou Y)".
10. **PIT-10** A tela SHALL dizer "Forma de pagamento", "Tamanhos", "Tecido" e
    "Tipo de roupa"; em Dados do atendimento, `sizes` é "Tamanhos informados"
    e `artwork_technique` é "Estampa desejada".
11. **PIT-11** O cliente do pedido SHALL ser um nome confirmado: o nome do
    contato dado por uma pessoa ou promovido do `customer_name` do bot; senão
    o `customer_name` do briefing; senão vazio. O identificador do canal e o
    nome do perfil do WhatsApp SHALL nunca ser o cliente.
12. **PIT-12** Do lastro (ADR 008), só a entrega prometida SHALL ser exigida
    para gerar, como um dia de calendário (`AAAA-MM-DD`, como o seletor de
    data grava); texto livre SHALL continuar bloqueando. Pagamento ("Pago
    em") SHALL não bloquear nem ser preenchido sozinho: até o CRM tratar
    pagamento, gerar o pedido subentende o pagamento feito. Entrega
    realizada (pós-venda), primeiro contato (copiado da conversa) e pedido
    fechado (definido ao gerar) SHALL não bloquear.

**Teste independente:** projetar no pedido um briefing com os sete pontos e
"tamanhos: 10 P, 15 M e 15 G", ver o item 1 completo com 40 peças, deixar a
gola em branco e ver "Falta para gerar: gola do item 1, entrega prometida,
valor final e forma de pagamento"; informar a gola e a entrega prometida e
gerar sem "Pago em".

---

### P1-12: Cliente do pedido acompanha o contato ⭐ MVP

**História:** Como vendedor, quero que o pedido pendente mostre o cliente com
o nome que o contato tem agora, para não gerar a ficha em branco ou com o nome
antigo depois de corrigir o nome na conversa.

Decisão: [ADR 018](../../../docs/adr/018-cliente-do-pedido-acompanha-o-contato.md),
do PO em 03/10/2026, que promove o caso de borda "WHEN o contato muda de nome".

**Aceite:**

1. **PCT-01** WHEN o contato de um pedido pendente é renomeado por uma pessoa,
   recebe o nome que o cliente deu ao bot ou tem o nome apagado THEN o
   detalhe, a lista e a gaveta da conversa SHALL mostrar, na próxima leitura,
   o cliente pela regra da PIT-11 com o contato atual, e a busca pelo nome
   novo SHALL achar o pedido. O renomear SHALL NOT mudar a versão nem a data
   da última mudança do pedido, nem publicar evento de pedido.
2. **PCT-02** WHEN o pedido é gerado THEN o cliente mostrado nesse momento
   SHALL ficar gravado no pedido; renomear o contato depois SHALL NOT mudar o
   cliente do pedido gerado no detalhe, na lista, na gaveta nem na ficha
   impressa.
3. **PCT-03** WHEN o pedido gerado é reaberto THEN o cliente SHALL voltar a
   acompanhar o contato (PCT-01), e gerar de novo SHALL gravar o nome desse
   momento.

**Teste independente:** com um pedido pendente, renomear o contato em "Editar
nome" e ver o nome novo no pedido, na lista (também buscando por ele) e na
gaveta; gerar, renomear de novo e ver o pedido e a impressão com o nome da
geração; reabrir e ver o nome atual.

---

### P2 (fora deste corte)

- Pedidos no detalhe do Cliente.
- KPIs de pedidos no Dashboard.
- Linha do tempo de preenchimento (quem preencheu o quê).

---

## Casos de borda

- WHEN um pedido confirmado é reaberto e gerado de novo THEN Pedido fechado
  SHALL passar à nova data do pedido (PCL-12), e Pagamento e Entrega
  realizada SHALL continuar como estavam.
- WHEN a conversa é repassada THEN o novo dono SHALL poder informar Pagamento e
  Entrega realizada; o antigo SHALL perder essa ação.

- WHEN a conversa é arquivada com pedido pendente THEN o pedido SHALL
  continuar em Pendentes.
- WHEN a conversa é repassada THEN o novo dono SHALL poder editar, confirmar e
  reabrir o pedido; o antigo SHALL perder essas ações.
- WHEN a conversa passa para uma pessoa (handoff ou "Assumir atendimento")
  THEN ela SHALL seguir com uma pessoa até o encerramento, sem ação, rota ou
  comando que a devolva ao agente, e o pedido pendente SHALL NOT voltar a
  receber a projeção dos patches do agente (ADR 015).
- WHEN uma conversa encerrada como `Sem lead` recebe uma mensagem nova do
  cliente THEN o ciclo novo SHALL começar com o bot, como para qualquer cliente
  novo: a regra da ADR 015 vale dentro de um ciclo de atendimento (PO,
  03/10/2026).
- WHEN a grade tem quantidade 0, negativa ou não inteira THEN o salvamento
  SHALL ser recusado com mensagem na linha.
- WHEN o valor digitado tem formato inválido (ex.: `4,820.00`, texto) THEN o
  campo SHALL mostrar erro e não enviar.
- WHEN a seção é salva sobre uma versão desatualizada THEN a API SHALL
  responder 409 e a interface SHALL pedir para recarregar a seção.
- WHEN o pedido não tem itens THEN o banner SHALL indicar "Nenhum item" e a
  confirmação SHALL ficar bloqueada.
- WHEN o contato muda de nome THEN o cliente do pedido pendente SHALL refletir
  o nome atual; o pedido confirmado SHALL manter o nome da confirmação. Desde a
  ADR 018 (03/10/2026), é requisito: PCT-01..03.

---

## Rastreabilidade

Verificado no Grupo H (T39) em 13/09/2026. Evidência = teste automatizado
que falha se o requisito for quebrado.

Desde a T133 (RFC 024, 15/10/2026), os testes E2E (`test/e2e/`) e os de
`test/order-format.test.js` são citados pelo arquivo e pelo título do teste,
que não muda quando o arquivo cresce; os números de linha antigos já não
batiam depois das fatias do RFC 024 e da separação da lista de Pedidos em
`orders-list.spec.js` (S3, `6fb9fbb`). Os demais testes unitários continuam
com o `arquivo:linha` da verificação original.

| ID     | História | Evidência                                                                                                                                                                                                                                                               | Status                |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| PCL-01 | P1-1     | `test/orders-service-create.test.js:78`                                                                                                                                                                                                                                 | Verified              |
| PCL-02 | P1-1     | `test/orders-service-create.test.js:132`                                                                                                                                                                                                                                | Verified              |
| PCL-03 | P1-1     | `test/orders-service-create.test.js:162`                                                                                                                                                                                                                                | Verified              |
| PAG-01 | P1-1     | `test/orders-service-create.test.js:243`; `test/n8n-integration-postgres-live.test.js:116`                                                                                                                                                                              | Verified              |
| PAG-02 | P1-1     | `test/orders-service-create.test.js:279` (ramo `ignored`)                                                                                                                                                                                                               | Verified              |
| PAG-03 | P1-1     | `test/orders-repository-contract.test.js:287`                                                                                                                                                                                                                           | Verified              |
| PCL-10 | P1-2     | `test/orders-service-create.test.js:198`; `crm-ui.spec.js` “PCX-11: offers "Criar pedido" in the header only to the owner and creates it there”                                                                                                                         | Verified              |
| PCL-11 | P1-2     | `crm-ui.spec.js` “PCX-11: offers "Criar pedido" in the header only to the owner and creates it there”                                                                                                                                                                   | Verified              |
| PFI-01 | P1-3     | `orders.spec.js` “keeps the sections in the order of the printed ficha (PFI-01, PLA-01)” e “opens the order page inside Pedidos, with the trail and the sections in order”                                                                                              | Verified              |
| PFI-02 | P1-3     | `orders.spec.js` “reads the order summary and marks the customer as locked (PFI-02)”                                                                                                                                                                                    | Verified              |
| PFI-03 | P1-3     | `orders.spec.js` “reads each item with the seven points in order and the extras closed (PFI-03, PIT-01, PIT-02)”                                                                                                                                                        | Verified              |
| PFI-04 | P1-3     | `orders.spec.js` “edits the grade and recomputes every total from it (PFI-04)” e “refuses a quantity that is not a whole piece, on the line (PFI-04)”                                                                                                                   | Verified              |
| PFI-05 | P1-3     | `orders.spec.js` “edits the observations and stops at five lines (PFI-05)” e “drops a blank observation instead of storing an empty line”                                                                                                                               | Verified              |
| PFI-06 | P1-3     | `orders.spec.js` “edits the summary and saves the whole section at once (PFI-06)”, “opens one section at a time (PFI-06)” e “keeps the other "Editar" focusable but unavailable, with the reason, while one section is open (PFI-17, PFI-06)”                           | Verified              |
| PFI-07 | P1-3     | `orders.spec.js` “accepts "Não aplicável" on sleeves and viés (PFI-07)”                                                                                                                                                                                                 | Verified              |
| PFI-08 | P1-3     | `orders.spec.js` “leaves production to the printed ficha and shows service data as not printed (PFI-08, PFI-20)”                                                                                                                                                        | Verified              |
| PFI-09 | P1-3     | `orders.spec.js` “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)”; `order-format.test.js` “names each point missing to generate in plain words (PIT-06)”                                                    | Verified              |
| PFI-10 | P1-3     | `orders.spec.js` “keeps a confirmed order in reading mode until it is reopened (PFI-10)”                                                                                                                                                                                | Verified              |
| PFI-14 | P1-3     | `orders.spec.js` “keeps every summary and item field as text typed by hand (PFI-14)”                                                                                                                                                                                    | Verified              |
| PAU-01 | P1-3     | `orders.spec.js` “shows the order read-only to whoever does not own the conversation (PAU-01)”                                                                                                                                                                          | Verified              |
| PCL-04 | P1-4     | `test/orders-service-commands.test.js:260` (bloco `confirmed`)                                                                                                                                                                                                          | Verified              |
| PCL-05 | P1-4     | `test/orders-service-commands.test.js:260,313`                                                                                                                                                                                                                          | Verified              |
| PCL-06 | P1-4     | `test/orders-service-commands.test.js:173`; `orders.spec.js` “hides Gerar and Reabrir from whoever does not own the conversation”                                                                                                                                       | Verified              |
| PCL-08 | P1-4     | `test/orders-service-commands.test.js:336`                                                                                                                                                                                                                              | Verified              |
| PCL-09 | P1-4     | `test/orders-postgres-live.test.js:457`                                                                                                                                                                                                                                 | Verified              |
| PFI-11 | P1-4     | `test/orders-service-commands.test.js:260`; `order-format.test.js` “parses the typed amount in Brazilian format into integer cents”                                                                                                                                     | Verified              |
| PFI-12 | P1-4     | `test/orders-service-commands.test.js:260,336`; `modules/orders/src/domain/order.js:107`                                                                                                                                                                                | Verified              |
| PFI-13 | P1-4     | `orders.spec.js` “keeps "Gerar pedido" as the only primary button of the page (PFI-13)” e “makes the next step the only primary while one is missing (PFI-13, PFI-16)”                                                                                                  | Verified              |
| PIM-01 | P1-5     | `orders.spec.js` “locks printing while the order is pending and says why (PIM-01)”; `order-format.test.js` “states why printing is locked while the order is pending (PIM-01)”                                                                                          | Verified              |
| PIM-02 | P1-5     | `test/order-routes.test.js:884`; `test/identity-operational-read.test.js` (T75)                                                                                                                                                                                         | Verified              |
| PIM-03 | P1-5     | `test/order-routes.test.js:917`                                                                                                                                                                                                                                         | Verified              |
| PIM-04 | P1-5     | `test/order-routes.test.js:889`                                                                                                                                                                                                                                         | Verified              |
| PIM-05 | P1-5     | `orders.spec.js` “hides Gerar and Reabrir from whoever does not own the conversation” e “prints a confirmed order from its page”                                                                                                                                        | Verified              |
| PCL-07 | P1-6     | `orders.spec.js` “confirms the order, frees printing, reopens it and locks printing again”; `test/orders-service-commands.test.js:336`                                                                                                                                  | Verified              |
| PCL-12 | P1-6     | `test/order-routes.test.js:753`; `test/orders-domain.test.js:169`                                                                                                                                                                                                       | Verified              |
| PLI-01 | P1-7     | `foundation.spec.js` “keeps Pedidos in the menu after Caixa de Entrada, active across its pages”                                                                                                                                                                        | Verified              |
| PLI-02 | P1-7     | `orders-list.spec.js` “filters by status and searches by number, customer or phone” e “PLI-09/PLI-10: the "Filtros" sheet works by keyboard and names the filter it applies” (emenda)                                                                                   | Verified              |
| PLI-03 | P1-7     | `orders-list.spec.js` “groups orders by status with counts, columns and actions” e “puts pending orders and exceptions first, with the delivery deadline”                                                                                                               | Verified              |
| PLI-04 | P1-7     | `orders-list.spec.js` “groups orders by status with counts, columns and actions”                                                                                                                                                                                        | Verified              |
| PLI-05 | P1-7     | `order-format.test.js` “summarises what is missing for the Situação column (PLI-05)”                                                                                                                                                                                    | Verified              |
| PLI-06 | P1-7     | `orders-list.spec.js` “groups orders by status with counts, columns and actions”                                                                                                                                                                                        | Verified              |
| PLI-07 | P1-7     | `orders-list.spec.js` “pages the list with "Ver mais"”                                                                                                                                                                                                                  | Verified              |
| PLI-08 | P1-7     | `orders-list.spec.js` “refreshes the list when an order changes elsewhere (PLI-08)”; `crm-ui.spec.js` “PCX-10: updates the order link when the order changes elsewhere”                                                                                                 | Verified              |
| PGE-01 | P1-7     | `foundation.spec.js` “keeps Pedidos in the menu after Caixa de Entrada, active across its pages”; `orders.spec.js` “opens the order page inside Pedidos, with the trail and the sections in order” e “keeps the trail without an origin when the list opened the order” | Verified              |
| PCX-01 | P1-8     | `crm-ui.spec.js` “drops the pending AI suggestion block from the conversation” e “PCX-14: filters the Inbox with three shortcuts with totals and the "Filtros" sheet”                                                                                                   | Verified              |
| PCX-02 | P1-8     | `crm-ui.spec.js` “PCX-14: filters the Inbox with three shortcuts with totals and the "Filtros" sheet” (emendado por PCX-14)                                                                                                                                             | Verified              |
| PCX-03 | P1-8     | `crm-ui.spec.js` “names the stop reason and waits, oldest first, when the seller is due” e “claims a pending handoff from its conversation in the Caixa de Entrada”                                                                                                     | Verified              |
| PCX-04 | P1-8     | `crm-ui.spec.js` “names the stop reason and waits, oldest first, when the seller is due”                                                                                                                                                                                | Verified              |
| PCX-05 | P1-8     | `crm-ui.spec.js` “never offers to hand the conversation back to the AI and keeps the actions on the keyboard” e “labels human and AI service distinctly and only permits transfer after takeover” (emendado por PCX-13 e PCX-14)                                        | Verified              |
| PCX-06 | P1-9     | Superado por PCX-10 (T126, `c1a9023`); os testes da gaveta saíram com ela                                                                                                                                                                                               | Superado pelo RFC 024 |
| PCX-07 | P1-9     | Superado por PCX-12 (T126, `c1a9023`)                                                                                                                                                                                                                                   | Superado pelo RFC 024 |
| PCX-08 | P1-9     | Superado por PCX-11 (T126, `c1a9023`)                                                                                                                                                                                                                                   | Superado pelo RFC 024 |
| PCX-09 | P1-9     | Superado por PCX-10 e PCX-12 (T126, `c1a9023`)                                                                                                                                                                                                                          | Superado pelo RFC 024 |

**Cobertura:** 52 requisitos · 52 verificados · 0 sem evidência · 0 lacunas.
Revisão da T133 (15/10/2026): PCX-06 a PCX-09 deixaram de valer com a T126
(RFC 024); os outros 48 continuam verificados pelos testes acima.

**Gate desta verificação:**

| Comando                            | Resultado                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate`                 | ✅ passou (format, typecheck, lint, boundaries, design-tokens, topology, r2, external-spikes, media-retention, security-catalog, ficha-pdf-review, phase0-decisions, observability, 477 unit tests, build) |
| `npm run test:orders:live`         | ✅ passou — 16/16 (PostgreSQL, `crm_silmer_test`)                                                                                                                                                          |
| `npm run test:operation-read:live` | ✅ passou — 1/1 (PostgreSQL, `crm_silmer_test`)                                                                                                                                                            |
| `npm run test:e2e`                 | ✅ passou — 69 passed, 7 skipped (Playwright)                                                                                                                                                              |

Os 7 testes e2e pulados são cenários de Kanban já aposentados (ADR 004,
`test/e2e/crm-ui.spec.js:602,1215,1238,1275,1284,1303,1315`, linhas de
13/09/2026; hoje são os `test.skip` do mesmo arquivo) — não pertencem à
Pedidos MVP e não contam como lacuna.

### Lastro de datas (ADR 008)

Verificado em T46, 29/09/2026.

| ID     | História | Evidência                                                                                                                                                                                                                                                                         | Status                   |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| PLA-01 | P1-10    | `orders.spec.js` “keeps the sections in the order of the printed ficha (PFI-01, PLA-01)” e “shows the three trail dates without repeating the summary (PLA-01..03, PLA-08)”; `order-format.test.js` “shows each business date once across summary and trail (PLA-01..03, PLA-08)” | Verified                 |
| PLA-02 | P1-10    | `test/orders-service-create.test.js:97`; `test/orders-postgres-live.test.js:334`; `test/migrations-live.test.js:270`                                                                                                                                                              | Verified                 |
| PLA-03 | P1-10    | `order-format.test.js` “shows each business date once across summary and trail (PLA-01..03, PLA-08)”; `orders.spec.js` “shows the three trail dates without repeating the summary (PLA-01..03, PLA-08)”                                                                           | Verified                 |
| PLA-04 | P1-10    | `test/orders-domain.test.js:214`; `test/orders-repository-contract.test.js:341`; `test/order-routes.test.js:778`; `orders.spec.js` “records payment and delivery on a confirmed order without reopening it (PLA-04, PLA-06)”                                                      | Verified                 |
| PLA-05 | P1-10    | `test/orders-domain.test.js:250`; `test/order-routes.test.js:833`; `orders.spec.js` “clears a recorded day and refuses a day after today, next to the field (PLA-05)” e “names the day the server refused as invalid”                                                             | Verified                 |
| PLA-06 | P1-10    | `test/orders-domain.test.js:214`; `test/order-routes.test.js:799`; `orders.spec.js` “records payment and delivery on a confirmed order without reopening it (PLA-04, PLA-06)”                                                                                                     | Verified                 |
| PLA-07 | P1-10    | `test/order-routes.test.js:858`; `test/orders-service-commands.test.js:419`; `orders.spec.js` “shows the order read-only to whoever does not own the conversation (PAU-01)” e “heads each section with its state in words and "Editar" naming the section (PFI-17)”               | Verified                 |
| PLA-08 | P1-10    | Ver "Ficha impressa com os sete pontos (ADR 017)" abaixo                                                                                                                                                                                                                          | Verified · PDF a aprovar |
| PLA-09 | P1-10    | `test/order-routes.test.js:1059`                                                                                                                                                                                                                                                  | Verified                 |

**Cobertura:** 9 requisitos · 9 verificados · PLA-08 sai no papel depois da
aprovação do PDF da v3 (ADR 017).

| Comando                        | Resultado                                              |
| ------------------------------ | ------------------------------------------------------ |
| `npm run validate`             | ✅ passou (498 testes: 495 ok, 3 pulados; build)       |
| `npm run test:e2e`             | ✅ passou — 73 passed, 7 skipped (os mesmos do Kanban) |
| `npm run test:orders:live`     | ✅ passou — 17/17 (PostgreSQL, `crm_silmer_test`)      |
| `test/migrations-live.test.js` | ✅ passou — backfill de `0024` entre as migrations     |

### Abertura no primeiro ponto da ficha (ADR 014)

Verificado na T53, 02/10/2026.

| ID     | História | Evidência                                                                                                                                                                       | Status   |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PAB-01 | P1-1     | `test/n8n-workflow-contract.test.js:2102` (2106, 2114, 2147); `test/n8n-workflow-contract.test.js:469,874`                                                                      | Verified |
| PAB-02 | P1-1     | `test/n8n-workflow-contract.test.js:2169,2177,2209`; `test/n8n-workflow-contract.test.js:213`                                                                                   | Verified |
| PAB-03 | P1-1     | `test/n8n-integration-postgres-live.test.js:755,766,800,821,975`; `test/n8n-integration-domain.test.js:250`; `test/n8n-api-contract.test.js:126`; `test/n8n-routes.test.js:172` | Verified |
| PAB-04 | P1-1     | `test/n8n-integration-postgres-live.test.js:846,894,939`; `test/n8n-workflow-contract.test.js:305`; `test/n8n-api-contract.test.js:184`; `test/n8n-dev-workflow.test.js:111`    | Verified |

**Cobertura:** 4 requisitos · 4 verificados. PCL-01..03 mantêm a evidência do
serviço de pedidos; a abertura pelo `open_order` usa o mesmo
`ensurePendingFromIntent` (`test/n8n-integration-postgres-live.test.js:663`).

| Comando                                                                       | Resultado                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run validate`                                                            | ✅ passou na T53                                         |
| `node --test --test-concurrency=1 test/n8n-integration-postgres-live.test.js` | ✅ passou — 4/4 (PostgreSQL, `crm_silmer_test_abertura`) |

### Itens com os sete pontos (ADR 016)

Verificado em T66, 03/10/2026. Os trechos da ADR 016 em PFI-03, PFI-08,
PFI-09, PFI-12, PCL-04, PCL-05 e PLA-06 têm a evidência de PIT-01, PIT-10,
PIT-06, PIT-10, PIT-05, PIT-06 e PIT-12.

| ID     | História | Evidência                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status   |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PIT-01 | P1-11    | `orders.spec.js` “reads each item with the seven points in order and the extras closed (PFI-03, PIT-01, PIT-02)” e “edits the seven points and the extras of an item (PIT-01, PIT-02, PIT-03)”; `order-format.test.js` “heads each item with its type and the pieces of its sizes (PIT-01)”                                                                                                                                                                                       | Verified |
| PIT-02 | P1-11    | `orders.spec.js` “reads each item with the seven points in order and the extras closed (PFI-03, PIT-01, PIT-02)”, “opens and closes the extras with the keyboard, keeping the focus (PIT-02)” e “edits the seven points and the extras of an item (PIT-01, PIT-02, PIT-03)”                                                                                                                                                                                                       | Verified |
| PIT-03 | P1-11    | `test/orders-ficha.test.js:79,90,105,131`; `test/orders-service-commands.test.js:351`; `test/order-routes.test.js:523`; `orders.spec.js` “edits the seven points and the extras of an item (PIT-01, PIT-02, PIT-03)”                                                                                                                                                                                                                                                              | Verified |
| PIT-04 | P1-11    | `test/orders-ficha.test.js:54,147`; `test/orders-service-read.test.js:206`; `test/orders-postgres-live.test.js:783`; `test/order-routes.test.js:523`                                                                                                                                                                                                                                                                                                                              | Verified |
| PIT-05 | P1-11    | `test/orders-domain.test.js:103`; `test/orders-postgres-live.test.js:612`; `test/order-routes.test.js:744`                                                                                                                                                                                                                                                                                                                                                                        | Verified |
| PIT-06 | P1-11    | `test/orders-domain.test.js:369`; `order-format.test.js` “names each point missing to generate in plain words (PIT-06)” e “names an unmapped missing field instead of hiding it”; `orders.spec.js` “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)” e “names each blocker the server refused the confirmation with”; `crm-ui.spec.js` “PCX-12: summarises the order in Detalhes, opened and closed from the keyboard” | Verified |
| PIT-07 | P1-11    | `test/orders-ficha.test.js:267,326,339,368,400,440,496,527`; `test/orders-service-create.test.js:101`                                                                                                                                                                                                                                                                                                                                                                             | Verified |
| PIT-08 | P1-11    | `test/orders-sizes.test.js:11,51,57,102`; `test/orders-ficha.test.js:464`                                                                                                                                                                                                                                                                                                                                                                                                         | Verified |
| PIT-09 | P1-11    | `order-format.test.js` “compares the sizes with the quantity the customer said, without blocking (PIT-09)”; `orders.spec.js` “warns when the sizes differ from what the customer said, without repeating it beside the total (PIT-09, TEC-06)”                                                                                                                                                                                                                                    | Verified |
| PIT-10 | P1-11    | `orders.spec.js` “names the fields the way the PO asked (PIT-10)”                                                                                                                                                                                                                                                                                                                                                                                                                 | Verified |
| PIT-11 | P1-11    | `test/orders-postgres-live.test.js:352`                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verified |
| PIT-12 | P1-11    | `test/orders-domain.test.js:190`; `test/orders-postgres-live.test.js:612`; `order-format.test.js` “reads days the way the operation does, on São Paulo time” e “names the promised delivery and tells it apart from the amount and payment method”; `orders.spec.js` “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)”                                                                                                 | Verified |

**Cobertura:** 12 requisitos · 12 verificados.

| Comando                                                      | Resultado                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `npm run validate`                                           | ✅ passou (546 testes: 543 ok, 3 pulados; build)                    |
| `npx playwright test` (config da porta 4275, não versionada) | ✅ passou — 82 passed, 7 skipped (os mesmos do Kanban)              |
| `npm run test:orders:live`                                   | ✅ passou — 20/20 (PostgreSQL, `crm_silmer_test_itens`)             |
| `test/n8n-integration-postgres-live.test.js`                 | ✅ passou — 3/3 (cópia local apontada para `crm_silmer_test_itens`) |

### Ficha impressa com os sete pontos (ADR 017)

A evidência do template vale para a v3. O PDF tem as páginas que o template
planejou (PIM-12). A aprovação, em `docs/phase0/ficha-pdf-approval-v3.json`,
tem duas etapas: a provisória do PO (03/10/2026, desenvolvimento e cloud-dev),
registrada e presa aos hashes do PDF, e a final, assinatura física de Rose e
Operação na amostra impressa, pendente e obrigatória antes da produção
(PIM-10).

| ID     | História | Evidência                                                                                                                              | Status                    |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| PIM-06 | P1-5     | `test/ficha-print-v3.test.js:168,200`; `test/ficha-pdf-review-v3.test.js:91`                                                           | Verified · PDF a aprovar  |
| PIM-07 | P1-5     | `test/ficha-print-v3.test.js:224`; `test/ficha-pdf-review-v3.test.js:91,110`                                                           | Verified · PDF a aprovar  |
| PIM-08 | P1-5     | `test/ficha-print-v3.test.js:251`                                                                                                      | Verified · PDF a aprovar  |
| PIM-09 | P1-5     | `test/ficha-print-v3.test.js:282,309,375`                                                                                              | Verified · PDF a aprovar  |
| PIM-10 | P1-5     | `test/ficha-print-switch.test.js:145,155,209,216,234,248`; `test/ficha-pdf-review-v3.test.js:313`; `npm run validate:ficha-pdf-review` | Verified · v3 desde a T74 |
| PIM-11 | P1-5     | `test/ficha-print-v3.test.js:429,454`; `test/ficha-pdf-review-v3.test.js:147`                                                          | Verified · PDF a aprovar  |
| PIM-12 | P1-5     | `test/ficha-print-v3.test.js:471,479,516,526`; `test/ficha-pdf-review-v3.test.js:162`                                                  | Verified · PDF a aprovar  |
| PLA-08 | P1-10    | `test/ficha-print-v3.test.js:339,569`; `test/ficha-pdf-review-v3.test.js:162`                                                          | Verified · PDF a aprovar  |

O gate do pacote (hashes da amostra, do HTML e do PDF, aprovação inteira ou
pendente, recusa de regerar a versão aprovada) está em
`test/ficha-pdf-review-v3.test.js:162,244,313,365` e em
`npm run validate:ficha-pdf-review`.

### Cliente acompanha o contato (ADR 018)

Verificado em T72, 03/10/2026. Nenhuma tela mudou, então não há e2e novo.

| ID     | História | Evidência                                                                                                                                                          | Status   |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| PCT-01 | P1-12    | `test/orders-service-client.test.js:127,153,242`; `test/order-routes.test.js:1126`; `test/orders-postgres-live.test.js:528,554`                                    | Verified |
| PCT-02 | P1-12    | `test/orders-service-client.test.js:187`; `test/orders-repository-contract.test.js:344`; `test/order-routes.test.js:1135`; `test/orders-postgres-live.test.js:558` | Verified |
| PCT-03 | P1-12    | `test/orders-service-client.test.js:207`; `test/order-routes.test.js:1155`; `test/orders-postgres-live.test.js:616`                                                | Verified |

**Cobertura:** 3 requisitos · 3 verificados.

| Comando                                      | Resultado                                                 |
| -------------------------------------------- | --------------------------------------------------------- |
| `npm run validate`                           | ✅ passou (562 testes: 559 ok, 3 pulados; build)          |
| `npm run test:orders:live`                   | ✅ passou — 22/22 (PostgreSQL, `crm_silmer_test_cliente`) |
| `test/n8n-integration-postgres-live.test.js` | ✅ passou — 4/4 (PostgreSQL, `crm_silmer_test_cliente`)   |

## Roteiro de UAT

Desde o RFC 024 (ADR 036), onde o roteiro diz "gaveta" leia o link "Pedido
NN-CRM" no cabeçalho da conversa e Detalhes › Pedido (PCX-10 a PCX-12); o
filtro "Estado" → "Aguardando vendedor" é o atalho "Aguardando" da Caixa de
Entrada (PCX-14); valor e forma de pagamento são digitados no diálogo "Gerar
o pedido" (PFI-19); e o "Lastro do pedido" da tela se chama "Datas do
pedido" (PFI-20).

1. Como cliente no workflow DEV, mandar numa conversa nova uma mensagem com um
   ponto da ficha (ADR 014) → pedido pendente `NN-CRM` aparece na gaveta da
   conversa e em Pedidos/Pendentes.
2. Assumir a conversa como vendedor na Caixa de Entrada.
3. Abrir o pedido pela gaveta ("Abrir pedido").
4. Editar a seção "Itens e especificações": ajustar os tamanhos, salvar e
   conferir total recalculado; abrir "Adicionais (não obrigatórios)" pelo
   teclado.
5. Editar "Observações do pedido" (até 5 linhas) e salvar.
6. Preencher Técnica por item, origem da arte do pedido e entrega prometida; confirmar com valor (ex. `1.180,00`) e forma de pagamento (Pix);
   checar status "Confirmado por <nome> · <data hora>".
7. Imprimir o pedido confirmado; validar template `ficha-canonical-v5` (ADR 020), sem valor/condição e sem faixa de amostra; assinatura física precede produção.
8. Reabrir o pedido; confirmar que a impressão trava de novo e número/valor
   são preservados.
9. Na Caixa de Entrada, aplicar o filtro "Estado" → "Aguardando vendedor" e
   checar ordenação por tempo parado e motivo da parada.
10. Abrir a gaveta de uma conversa nesse filtro e confirmar resumo (itens,
    peças, valor) sem opção de editar ali.
11. Num pedido gerado, abrir o Lastro do pedido: primeiro contato, pedido
    fechado e entrega prometida já aparecem. Informar "Pago em", salvar e
    conferir que o pedido continua confirmado e a impressão liberada.
12. Tentar "Entregue em" com data de amanhã e ver o erro junto ao campo;
    informar a data de hoje e salvar.
13. Com um pedido pendente, renomear o contato em "Editar nome" na Caixa de
    Entrada e abrir de novo o pedido, a lista (buscando pelo nome novo) e a
    gaveta: o cliente é o nome novo. Gerar, renomear de novo e conferir que o
    pedido e a impressão mantêm o nome da geração (ADR 018).

## Critérios de sucesso

- [ ] Um pedido sai da intenção de compra até a impressão com uma única ação
      de confirmação humana.
- [ ] 100% dos pedidos impressos têm autor e horário de confirmação.
- [ ] O documento impresso passa pelos seis critérios do gate da ficha
      (legibilidade, conteúdo, ordem, grade, totais, impressão).

## Revisão da ficha e leitura operacional (ADR 019, 03/10/2026)

Esta seção registra a decisão de 03/10/2026, refinada pela ADR 020. A coleta do bot continua com os sete
pontos da ADR 016; o vendedor completa as escolhas operacionais antes de
**Gerar pedido**. A revisão original partiu da v3 e preparou a v4, conforme [RFC 007](../../../docs/rfc/007-revisao-da-ficha-e-leitura-operacional.md).

| ID     | Critério de aceite                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REV-01 | A tela e a nova ficha usam **Tipo de roupa** para `item.tipo`, sem editar ou imprimir `modelo`; dados históricos de modelo continuam preservados.                                                                                                                        |
| REV-02 | O ponto 7 aparece como **Definição da gola**, usa `item.gola` e lê `vies_gola` antigo quando aquele estiver vazio; salvar outro campo não apaga essa definição.                                                                                                          |
| REV-03 | Cada item tem `tipo_servico`. É possível salvar um rascunho sem ele, mas **Gerar pedido** informa qual item falta; itens do mesmo pedido podem ter serviços diferentes. Gerados antigos seguem legíveis.                                                                 |
| REV-04 | O vendedor autorizado marca separadamente **Feito pelo cliente** e **Feito pela Silmer**. A automação não define a origem. O upload informa os formatos, mas fica desativado até haver armazenamento durável e validação (ativado pela ADR 023; ver ARQ-01–ARQ-09).      |
| REV-05 | A revisão impressa candidata preserva lastro, paginação e 14 campos vazios de produção; mostra serviço por item, origem da estampa e definição da gola. V2, v3 e seus hashes não mudam. A troca do template depende de aprovação própria.                                |
| REV-06 | Dashboard mostra número de vendas confirmadas e valor final vendido, com período e universo explícitos; análises derivadas não contam pendentes como venda nem valor recebido.                                                                                           |
| REV-07 | Linhas de Pedidos e Clientes abrem ao clicar na área não interativa e mantêm link, foco e operação por teclado. Tabela larga rola dentro de região focável no celular.                                                                                                   |
| REV-08 | Pedidos diferencia **Cliente sem resposta** (última saída enviada há pelo menos 48 horas) de **Pedido sem movimentação** (`updatedAt`); envio falho/incerto não acende o sinal. Nenhuma probabilidade de fechamento é inventada.                                         |
| REV-09 | Páginas observam eventos seguros do CRM e atualizam sem botão normal de atualização. Edição em andamento preserva rascunho; conflito de versão permite recuperar a leitura atual após cancelar. Nova tentativa manual continua para falha real.                          |
| REV-10 | O [glossário](../../../docs/product/GLOSSARIO.md) fixa termos e verbos; a [revisão heurística](../../../docs/product/REVISAO-HEURISTICA.md) documenta achados e verificação. Aviso a Rose por n8n ou e-mail é proposta para fluxo conjunto, sem implantação nesta etapa. |

## Técnica por item e arte do pedido (ADR 020, 03/10/2026)

O PO revisou as labels da ficha por seção ([RFC 008](../../../docs/rfc/008-rotulos-da-ficha-tecnica-e-arte.md))
e decidiu um nome por conceito. A coleta do bot e o indicador da ficha não
mudam; muda onde o CRM grava cada resposta e como a tela e o papel a chamam.
Estes critérios superam REV-02–REV-05 onde divergem.

| ID     | Critério de aceite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEC-01 | `items[].tipo_servico` aparece como **Técnica**, ponto 4 do item, na tela e no papel; é obrigatória para gerar. O bot preenche o primeiro item quando o cliente nomeia uma técnica (silk, sublimação, DTF, DTG, bordado, transfer) ou diz que a peça é lisa (“Sem estampa”); outra descrição fica em Dados do atendimento como “Técnica informada”.                                                                                                                                                 |
| TEC-02 | `summary.aplicacao` não é escrita pelo bot, editada nem impressa a partir da v5. O valor antigo continua guardado e a API aceita a chave de um cliente antigo sem usá-la.                                                                                                                                                                                                                                                                                                                           |
| TEC-03 | **Estampa e arquivos** oferece **O cliente envia a arte**, **A Silmer cria a arte** e **Sem estampa**. As duas primeiras coexistem; “Sem estampa” exclui as outras (a API recusa a combinação). **Gerar pedido** exige uma marcação (`artwork` em `missingFields`). O bot projeta a origem a partir de `artwork_status` só quando a resposta é inequívoca; o vendedor corrige. Emendado por PFI-20 (RFC 024): na tela a seção se chama **Arte do pedido**.                                          |
| TEC-04 | `items[].estampa` deixa os pontos principais, não bloqueia e aparece como **Estampa (referência)** nos adicionais. O bot grava ali só os locais da estampa.                                                                                                                                                                                                                                                                                                                                         |
| TEC-05 | Pontos do item: Tipo de roupa, Cor, Quantidade, Técnica, Tecido, Tamanhos e **Gola**. Adicionais: Estampa (referência), **Cor do tecido — frente/costas/manga direita/manga esquerda** e **Viés das mangas**. “Tipo de peça” do bot aparece como “Tipo de roupa informado”; o aviso do `modelo` antigo sai da tela, e o valor continua guardado.                                                                                                                                                    |
| TEC-06 | Lastro com **Pago em** e **Entregue em** na tela e no papel; resumo com **Nome do pedido**; a dica da entrega prometida diz “A data combinada com o cliente.”; o total de peças não mostra “cliente informou N” (o aviso de diferença continua).                                                                                                                                                                                                                                                    |
| TEC-07 | `ficha-canonical-v5`: resumo com Cliente, Entrega prometida e Total de peças; apoio com Nome do pedido, Vendedor, Data do pedido e FAB; lastro com Primeiro contato, Pago em e Entregue em; **Arte do pedido** em toda página comercial; itens com os pontos de TEC-05; produção com **Cores da arte** e **Nº de cores — …**. V2–v4, PDFs e hashes intactos. `PRINT_TEMPLATE` muda para v5 só após a aprovação provisória do PO; a assinatura física de Rose e Operação continua antes da produção. |
| TEC-08 | O [glossário](../../../docs/product/GLOSSARIO.md) fixa Técnica, Arte do pedido, Estampa (referência), Cor do tecido, Cores da arte, Nome do pedido, Pago em e Entregue em.                                                                                                                                                                                                                                                                                                                          |

## Arquivos da arte no RustFS (ADR 023, 05/10/2026)

O PO ativou “Adicionar arquivos da arte” com armazenamento no RustFS
([RFC 011](../../../docs/rfc/011-arquivos-da-arte-no-rustfs.md)) e aprovou o
[design](../../../docs/design/arquivos-da-arte.html). Estes critérios superam
REV-04 onde divergem.

| ID     | Critério de aceite                                                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARQ-01 | **Estampa e arquivos** mostra **Arte final** e **Arquivos da arte** (contador “N de 5”, formatos e limite). Sem arquivos, quem edita vê uma área para arrastar e o botão **Adicionar arquivos da arte**; quem só lê vê “Nenhum arquivo anexado.” Nenhuma menção ao Dropbox.                                                                                                 |
| ARQ-02 | O dono da conversa ou um administrador envia até 5 arquivos da arte por pedido pendente, um de cada vez, com progresso, cancelamento e nova tentativa com a mesma Idempotency-Key.                                                                                                                                                                                          |
| ARQ-03 | Cada arquivo tem até 10 MB e extensão PNG, JPEG, WebP, CDR, PDF, SVG, AI, EPS, PSD, TIFF, ZIP ou RAR com conteúdo correspondente. A página recusa antes de enviar o que passa do tamanho, do formato ou das vagas e diz qual arquivo e por quê; a API recusa de novo (`FILE_TOO_LARGE` 413, `FILE_TYPE_NOT_ALLOWED`/`FILE_CONTENT_MISMATCH` 422, `FILE_LIMIT_REACHED` 409). |
| ARQ-04 | A **arte final** é um arquivo por pedido, não conta nos 5, mostra quem enviou e quando, e **Substituir** troca o arquivo anterior.                                                                                                                                                                                                                                          |
| ARQ-05 | PNG, JPEG e WebP aparecem em miniatura (WebP gerado no navegador); os demais formatos, inclusive SVG, mostram o ícone da extensão. **Baixar** entrega o original como anexo. Remover pede confirmação no próprio arquivo, com foco em Cancelar, Esc para desistir e foco no próximo arquivo depois.                                                                         |
| ARQ-06 | Pedido gerado e leitor sem permissão só baixam: sem enviar, substituir ou remover. A API recusa mudança fora do pedido pendente (`ORDER_STATUS_CONFLICT`) e de quem não é dono nem administrador (403).                                                                                                                                                                     |
| ARQ-07 | Os bytes ficam no RustFS interno, sem link público nem URL pré-assinada; a chave do objeto é opaca e o nome original fica cifrado no banco. O download sai com `Content-Disposition: attachment`, `nosniff` e CSP `sandbox`.                                                                                                                                                |
| ARQ-08 | Envio, remoção e download entram na auditoria; envio e remoção são idempotentes. Sem `OBJECT_STORAGE_*` as rotas respondem 503 e o resto do pedido funciona.                                                                                                                                                                                                                |
| ARQ-09 | O bucket entra no backup off-host, no drill e no restore com o PostgreSQL; o handoff manual de mídia válida do canal anexa o arquivo ao pedido.                                                                                                                                                                                                                             |

Emenda da RFC 024 (ADR 036) a ARQ-01: na tela a seção se chama **Arte do pedido** e mostra um só controle de adicionar arquivo por vez (PFI-20).

## O atendimento começa pelo produto (ADR 024, 05/10/2026)

O PO decidiu que o bot pergunta primeiro o nome e o que o cliente quer
personalizar, e não qual camisa, porque a Silmer personaliza camisas, bonés,
mochilas e muitos outros produtos. Arte, malha, técnica, tamanhos e gola
passam a ser do vendedor, e o que perguntar depende do produto e de kits
([RFC 012](../../../docs/rfc/012-atendimento-comeca-pelo-produto.md)). O
contrato com o CRM e a forma do item não mudam. Estes critérios superam, no
bot, os sete pontos da ADR 012.

| ID     | Critério de aceite                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PRD-01 | A saudação pede o nome e o que a pessoa quer personalizar (camisetas ou outras roupas, bonés, mochilas e bolsas, ou outro produto); o bot nunca pergunta "qual camisa" antes de saber o produto. Sem o nome, a resposta seguinte reage ao que o cliente contou e pede só o nome; depois de dois pedidos, o nome não é mais perguntado nem segura a ficha, e o resumo diz "Nome: não informado.". |
| PRD-02 | O ritmo é produto → modelo → cor → quantidade → onde vai a estampa → para quando. O modelo só é perguntado para roupa, boné, mochila ou bolsa, com as opções do produto; o prazo é desejo do cliente, nunca prazo confirmado.                                                                                                                                                                    |
| PRD-03 | Origem da arte, técnica, malha, tamanhos, gola, personalização individual e divisão por público nunca são perguntados: o bot grava o que o cliente disser. O bot nunca oferece criar a arte e, de tecido, só fala de algodão, poliéster e dry fit.                                                                                                                                               |
| PRD-04 | Os kits gravam, só em campo vazio e sem perguntar: abadá (sublimação total, poliéster, branca, gola regata), sublimação total (poliéster, branca), regata (gola regata), polo (gola polo), boné, mochila e bolsa (gola `NAO APLICAVEL`). O workflow também grava o produto a partir do modelo dito, o modelo quando o produto já o nomeia e o nome do produto no modelo de boné e bolsa.         |
| PRD-05 | O resumo da transferência traz "Atenção" (sublimação em algodão ou em peça escura, bordado com foto) e "Dica" (técnica usual do produto, personalização individual, divisão por público); o bot não fala disso com o cliente.                                                                                                                                                                    |
| PRD-06 | `briefing_complete` exige os pontos do produto e o nome enquanto o bot o pede; "Ficha: X de N" conta os mesmos campos (7 para roupa, boné ou bolsa; 6 para outro produto ou produto não dito).                                                                                                                                                                                                   |
| PRD-07 | Um boné do bot chega ao item 1 do pedido com o tipo ("bonés trucker"), a cor e a gola "NÃO APLICÁVEL"; malha, técnica, tamanhos e arte ficam para o vendedor, que continua obrigado a preenchê-los para gerar o pedido. "Quero esse boné" é peça já mostrada e transfere (ADR 013).                                                                                                              |
| PRD-08 | O workflow passa a `mvp-simple-12` (DEV `dev-mvp-simple-13`) sem ordem de implantação; o [roteiro do indicador da ficha](../../../docs/integrations/n8n/roteiro-indicador-da-ficha.md) cobre roupa, abadá, boné, ecobag, outro produto, sublimação em peça escura e divisão por público.                                                                                                         |

## Itens por público (ADR 025, 05/10/2026)

O PO definiu que gênero e idade criam itens, só quando o cliente divide a
quantidade, e aceitou as recomendações D1–D7 da
[RFC 013](../../../docs/rfc/013-itens-por-publico.md).

| ID     | Critério de aceite                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUB-01 | Cada item tem `publico` opcional (masculino, feminino, infantil, unissex ou vazio), editável por teclado num seletor com rótulo "Público" e mostrado no cabeçalho do item; não entra em `missingFields` nem bloqueia gerar. A API recusa outro valor.                             |
| PUB-02 | Cada item tem `quantidade_informada` opcional (inteiro de 1 a 100000), só de referência; com grade e soma diferente, o item mostra "A soma dos tamanhos (X) é diferente da quantidade informada (Y)"; sem grade, "— (cliente informou Y)".                                        |
| PUB-03 | O CRM aceita `audiences` no `briefing_patch` e lê a divisão só quando não há dúvida (inteiro positivo junto de masculino, feminino, infantil ou unissex, uma vez cada); quando não é lida, o texto fica em Dados do atendimento como "Divisão informada".                         |
| PUB-04 | Com duas ou mais partes lidas, o pedido pendente nasce com um item por parte, na ordem dita, cada um com público, quantidade informada e os mesmos pontos projetados do bot; a grade só é projetada com um item. Uma parte só marca o público e a quantidade informada do item 1. |
| PUB-05 | Enquanto a conversa está com o bot, uma divisão nova refaz os itens da divisão sem apagar a técnica do vendedor nem itens acrescentados por ele; depois do handoff, nada é reprojetado.                                                                                           |
| PUB-06 | "Duplicar item N" insere a cópia logo abaixo, sem grade nem quantidade informada, e leva o foco ao seletor de público do item novo; o leitor de tela anuncia o item criado.                                                                                                       |
| PUB-07 | "Tecido" passa a "Modelo de malha" na tela; `ficha-canonical-v6` imprime o público junto do número do item, o novo rótulo e a quantidade informada quando difere da soma; v2–v5 intactas; `PRINT_TEMPLATE` muda só após a aprovação provisória do PO.                             |
| PUB-08 | O workflow `mvp-simple-13` grava a divisão em `audiences`, nunca a pergunta, e vai ao ambiente depois do CRM que aceita o campo.                                                                                                                                                  |
| PUB-09 | Fichas gravadas antes são lidas com `publico` e `quantidade_informada` vazios; nenhuma migração SQL.                                                                                                                                                                              |

## Imagem, áudio e chat do site (ADR 026, 07/10/2026)

O PO pediu que o workflow principal fique igual ao DEV, leia imagens e áudios
e atenda no WhatsApp e no chat do site
([RFC 014](../../../docs/rfc/014-midia-e-chat-do-site-no-bot.md)). O contrato
com o CRM não muda.

| ID      | Critério de aceite                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MID-01  | Áudio do WhatsApp ou do site é transcrito e entra no contexto como a mensagem do cliente; as redes de preço, pessoa e pedido do zero leem a transcrição.                |
| MID-02  | Imagem do WhatsApp ou do site vai anexada ao agente; arte vira `artwork_status` "cliente enviou a arte por imagem", referência vai para `notes`, peça pronta transfere. |
| MID-03  | Mídia que não pôde ser baixada, preparada ou transcrita chega ao modelo como não lida e o bot pede para o cliente escrever; nunca derruba a execução.                   |
| MID-04  | Figurinha, localização, contato, reação, aviso de sistema e tipo desconhecido nunca geram `400` no inbound; documento, vídeo e tipo desconhecido transferem.            |
| MID-05  | O bot não descreve pessoas nem grava dados pessoais que aparecem na imagem.                                                                                             |
| SITE-01 | O chat do site é público só para as origens do site, aceita imagem e áudio e entra no CRM como identidade `999` + 12 dígitos estável por sessão do navegador.           |
| SITE-02 | A resposta da IA, o aviso de transferência e o "vendedor vai falar com você" aparecem no chat; a reserva e o `message.sent` usam o mesmo contrato do WhatsApp.          |
| SITE-03 | No chat, todo aviso de transferência pede o WhatsApp do visitante com DDD em vez de dizer que o atendimento continua ali.                                               |
| SITE-04 | O painel recusa com `422` mensagem humana para identidade `999`; nada sai para a Meta.                                                                                  |
| SITE-05 | DEV e LOCAL não publicam o chat público; o chat de teste aceita imagem e áudio.                                                                                         |
| SITE-06 | O workflow passa a `mvp-simple-14` (DEV `dev-mvp-simple-15`) sem mudança de contrato nem ordem de implantação com o CRM.                                                |

### Evolução do chat para o piloto de outubro (ADR 034)

Os critérios SITE-01..06 acima descrevem a entrega anterior da ADR 026.
Para o piloto com nome e telefone declarados, prevalecem [CP-21..22](../cliente-pedido-assuntos/spec.md),
[CP-T06](../cliente-pedido-assuntos/tasks.md) e a [ADR 034](../../../docs/adr/034-chat-do-site-com-telefone-declarado.md):
o formulário coleta os dados antes da primeira mensagem, o CRM os guarda como
declaração não confirmada da sessão, e o Pedido novo permanece isolado no
Contato sintético. O chat não recebe histórico ou Pedidos de outra identidade.
O CRM deve estar atualizado antes da nova versão do workflow. A confirmação
pelo WhatsApp e a eventual correlação auditada ficam para uma etapa posterior;
o piloto de chat funciona sem o canal WhatsApp disponível.

## Venda da loja do site (ADR 027, 07/10/2026)

O PO pediu que o aviso de Pix da loja do site vire um pedido travado e "Pago"
no CRM, aceitou as recomendações D1–D9 da
[RFC 015](../../../docs/rfc/015-venda-da-loja-do-site.md) e definiu que o
pedido da loja aparece no Dashboard como uma venda normal.

| ID     | Critério de aceite                                                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOJ-01 | `POST /api/v1/public/loja/pedidos` com o corpo do contrato v1 do site e `Origin` permitido cria um pedido e responde `201 {"numero":"NN-CRM"}`.                                                                                                                            |
| LOJ-02 | Mesma `Idempotency-Key` e mesmo corpo (JSON canônico) responde `200` com o mesmo número, sem novo pedido, mesmo acima dos limites; outro corpo responde `409 idempotency_conflict`; chave diferente de `pedido_id` é `400`.                                                |
| LOJ-03 | Corpo malformado ou acima de 8 KB, chave desconhecida ou faltando, `versao` diferente de `"1"`, nome (2–80) ou telefone (E.164 brasileiro sem `+`) inválidos respondem `400 {"erro": …}`.                                                                                  |
| LOJ-04 | Slug, cor, tamanho (com os ids do site), quantidade, valor ou campos descritivos do produto diferentes do catálogo do CRM respondem `422`; instante declarado fora de 7 dias antes a 5 minutos depois responde `422 horario_invalido`; o pedido grava o preço do catálogo. |
| LOJ-05 | Com `STORE_ORDERS_ACCEPT_TEST=false`, `teste: true` responde `422 teste_recusado`; com `true`, o pedido nasce `isTest` e fica fora do Dashboard.                                                                                                                           |
| LOJ-06 | O pedido da loja nasce `confirmado`, `origin = loja`, sem conversa, autor "Loja do site", condição Pix, `paidOn` e `paymentDeclaredAt` do aviso; nenhum contato, conversa ou pendente é criado ou alterado.                                                                |
| LOJ-07 | Editar seção, gerar, reabrir, lastro e arquivos num pedido da loja respondem `409 ORDER_LOCKED`; a página não mostra esses controles.                                                                                                                                      |
| LOJ-08 | Lista e página mostram o selo "Loja" e "Pago (informado pelo cliente em dd/mm/aaaa às hh:mm)"; a lista filtra "Loja do site" e acha o pedido pelo número e pelo telefone.                                                                                                  |
| LOJ-09 | O Dashboard conta os pedidos da loja que não são teste em Vendido, pedidos, ticket médio e peças, como qualquer venda, sem linha separada.                                                                                                                                 |
| LOJ-10 | "Baixar ficha" baixa a `ficha-loja-v1` (`pedido-NN-CRM.html`) com só os campos padrão; a mesma rota sem `download` abre para imprimir; o CSP do nginx libera só o estilo dela.                                                                                             |
| LOJ-11 | O preflight `OPTIONS` libera `POST`, `Content-Type` e `Idempotency-Key` só para as origens configuradas, com `Vary: Origin`; `POST` sem origem permitida responde `403 origem_nao_permitida`.                                                                              |
| LOJ-12 | Acima de 30 requisições/minuto por IP, 5 pedidos/hora por IP ou 5 pedidos/24 h por telefone, responde `429 rate_limited` com `Retry-After`.                                                                                                                                |
| LOJ-13 | Cada criação grava recibo (pedido, `pedido_id`, `Origin`, HMAC do IP e do telefone, hash do corpo) e auditoria na mesma transação do pedido; nome, telefone e IP nunca vão para log.                                                                                       |
| LOJ-14 | Toda a interface nova opera por teclado, com selos em texto e foco previsível.                                                                                                                                                                                             |

## Pedido pago da loja pelo n8n (ADR 028, 09/10/2026)

A loja passou ao Checkout Integrado da InfinitePay, só Pix. O PO decidiu que o
pedido pago entra no CRM automaticamente, enviado pelo n8n depois do
`payment_check`, com a ficha e o link do comprovante
([RFC 016](../../../docs/rfc/016-pedido-pago-da-loja-pelo-n8n.md)). A rota
pública saiu: `LOJ-01`–`LOJ-05` e `LOJ-11`–`LOJ-13` ficam substituídos por
`LOJ-15`–`LOJ-20` e `LOJ-25`; `LOJ-06`, `LOJ-08` e `LOJ-10` são emendados por
`LOJ-21`–`LOJ-23`; `LOJ-07`, `LOJ-09` e `LOJ-14` continuam.

| ID     | Critério de aceite                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOJ-15 | `POST /api/v1/integrations/n8n/store-orders` com Basic do `AUTOMATION_EXECUTOR`, `Idempotency-Key` igual a `pedido_id`, os cabeçalhos técnicos do n8n e o corpo `schema_version` `1.0` cria o pedido pago e responde `201` com `numero`, `numero_loja`, `pedido_id` do CRM, `criado`, `comprovante_registrado`, `pedido_url` e `ficha_url`.         |
| LOJ-16 | Sem credencial ou com credencial errada responde `401`; a ação `store.order.record` só existe para o `AUTOMATION_EXECUTOR` (sem ela, `403 FORBIDDEN_AUTOMATION_ACTION`), nenhuma pessoa a recebe e nada é gravado.                                                                                                                                  |
| LOJ-17 | O mesmo `pedido_id` com os mesmos dados responde `200` com o mesmo resultado; com o comprovante que antes faltava, grava o link, audita `store.order.receipt_attached` e responde `200`; com dados diferentes ou outro comprovante, `409 STORE_ORDER_CONFLICT`; outro pedido com o mesmo `transaction_nsu`, `409`. O reenvio vem antes do catálogo. |
| LOJ-18 | Slug, `cor_id`, `tamanho_id`, quantidade diferente de 10, `prazo_dias` diferente do da cor ou `valor_centavos` diferente de 18000 (100 só num teste aceito) respondem `422 STORE_CATALOG_MISMATCH`; o pedido grava o preço do catálogo.                                                                                                             |
| LOJ-19 | `valor_pago_centavos` menor que o valor responde `422 AMOUNT_BELOW_PRICE`; `forma` diferente de `pix` ou `gateway` diferente de `infinitepay`, `422 PAYMENT_METHOD_UNSUPPORTED`; `teste: true` com `STORE_ORDERS_ACCEPT_TEST=false`, `422 TEST_REFUSED`.                                                                                            |
| LOJ-20 | Chave desconhecida responde `400 UNKNOWN_REQUEST_FIELD`; corpo malformado, `numero_loja` diferente de `LJ-` e os 8 primeiros hexadecimais do `pedido_id`, `receipt_url` fora de `https://` nos hosts da InfinitePay, `pago_em` fora de ISO UTC ou da janela (5 minutos à frente, 30 dias atrás), nome ou telefone inválidos respondem `400`.        |
| LOJ-21 | O pedido nasce `confirmado`, `origin = loja`, travado, sem conversa nem Contato, `created_by_kind = automation`, Pix, `paid_on` e data do pedido no dia de `pago_em` em São Paulo, com fonte, instante, valor pago, NSU e slug do gateway, `numero_loja` e prazo em dias úteis; a auditoria `store.order.create` não leva PII.                      |
| LOJ-22 | Lista, página e ficha mostram "Pago — confirmado pela InfinitePay em dd/mm/aaaa às hh:mm", valor pago, NSU, prazo ("Pronta entrega" ou "10 dias úteis"), `LJ-…` junto do `NN-CRM` e o link "Comprovante InfinitePay" quando houver.                                                                                                                 |
| LOJ-23 | A busca da lista acha o pedido da loja pelo `LJ-…`, além do número e do telefone.                                                                                                                                                                                                                                                                   |
| LOJ-24 | Um link profundo do CRM aberto sem sessão volta à rota pedida depois do login; só caminhos internos do app são aceitos.                                                                                                                                                                                                                             |
| LOJ-25 | `POST /api/v1/public/loja/pedidos` não existe; `STORE_ORDERS_ALLOWED_ORIGINS` e os limites por IP e telefone saem; sem `STORE_ORDERS_HMAC_KEY` a rota de automação responde `404`.                                                                                                                                                                  |

## Aviso de pedido novo do site (ADR 031, 10/10/2026)

O pedido pago do site continua chegando Confirmado e travado (ADR 028). O PO
decidiu que o Dashboard avisa os pedidos novos do site e que um pedido deixa
de ser novo na primeira impressão da ficha
([RFC 019](../../../docs/rfc/019-aviso-de-pedido-novo-do-site.md)). A marca
"tirar" da jornada v3 foi considerada e rejeitada. `LOJ-22` é emendado por
`LOJ-33`–`LOJ-36` (a lista e a página deixam de mostrar o NSU e o selo "Pago —
confirmado pela InfinitePay", que fica só na ficha) e `LOJ-17` por `LOJ-37`.

| ID     | Critério de aceite                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOJ-26 | Pedido novo do site é o pedido da loja que não é teste e cuja ficha nunca foi impressa. `GET /api/v1/orders/summary` devolve `storeNewCount` e `storeNewOldestPaidAt` (Pix confirmado do mais antigo; nulo sem pedido novo); pedido de teste nunca conta.                                                                                                                                                             |
| LOJ-27 | A primeira vez que uma pessoa autenticada imprime ou baixa a ficha de um pedido da loja (`GET /api/v1/orders/{id}/print`, com ou sem `download=1`), o pedido grava `fichaFirstPrintedAt` e `fichaFirstPrintedBy` e sai do aviso; o contrato `Order` expõe os dois (`fichaFirstPrintedBy` com `{id, name}`).                                                                                                           |
| LOJ-28 | Só a primeira impressão grava: as seguintes, e duas impressões ao mesmo tempo, não mudam quem nem quando; sem sessão ou permissão a impressão é recusada como antes e nada é gravado; pedido do atendimento nunca grava; o banco exige os dois campos juntos, só em pedido da loja, de um usuário existente.                                                                                                          |
| LOJ-29 | A criação do pedido da loja e a primeira impressão gravam a linha `order` em `crm.domain_events` (ao vivo `inbox.order.changed`); a primeira impressão audita `order.ficha.first_print` com o usuário e o pedido, sem PII.                                                                                                                                                                                            |
| LOJ-30 | O contrato de `store-orders` com o n8n não muda; o reenvio (`200`) devolve o mesmo `numero`, também depois da impressão da ficha.                                                                                                                                                                                                                                                                                     |
| LOJ-31 | O Dashboard mostra, depois do título e antes dos indicadores, uma linha em tom de atenção que é um único link para `/pedidos?origem=loja`: "N pedidos novos do site" (ou "1 pedido novo do site"), o detalhe com o mais antigo ("DD/MM, HH:MM") e a orientação de imprimir, e "Ver pedidos"; some com N = 0, fica numa região `aria-live="polite"` e atualiza ao vivo.                                                |
| LOJ-32 | O item "Pedidos" do menu mostra o número de pedidos novos do site quando é maior que zero, com " pedidos novos do site" para leitor de tela; atualiza ao abrir e com `inbox.order.changed`.                                                                                                                                                                                                                           |
| LOJ-33 | Na lista, o pedido da loja segue em Confirmados com "Imprimir ficha" e "Abrir pedido"; junto do selo `Loja · LJ-…` aparece "Ficha não impressa" enquanto não impressa (exceto teste); a Situação diz "Confirmado pela loja do site · DD/MM/AAAA, HH:MM" e, depois da impressão, "Ficha impressa por {nome} · DD/MM/AAAA, HH:MM". `?origem=loja` abre a lista já filtrada.                                             |
| LOJ-34 | A página do pedido da loja tem status "Confirmado", os selos `Loja · LJ-…`, "Teste" e "Ficha não impressa", a barra "travado, sem edição" e o layout de duas colunas: à direita, "Fechamento e pagamento" confirmado (Valor final, "Pix", "Confirmado pela loja do site · …"), o cartão da ficha com a situação da impressão e, no lugar de "Reabrir pedido", a explicação de que o pedido da loja não é reaberto.    |
| LOJ-35 | A folha "Pedido da loja do site" mostra só Produto ("Camisa dry fit"), Cor, Tamanho, Quantidade ("10 peças"), Prazo da cor, Cliente, WhatsApp e Comprovante; o catálogo e o slug não mudam.                                                                                                                                                                                                                           |
| LOJ-36 | A ficha `ficha-loja-v1` (A4, uma página) traz o cabeçalho de sempre, a faixa "Pedido de teste — não produzir nem entregar" no teste e as seções Produzir (produto, cor, tamanho em destaque, quantidade, prazo, "Pedido em"), Cliente (nome, WhatsApp) e Pagamento (valor pago, Pix, a faixa da InfinitePay e o comprovante), sem tipo, público, malha, gola, NSU nem fatura; o CSP do nginx libera só o novo estilo. |
| LOJ-37 | Emenda o `LOJ-17`: o mesmo `pedido_id` com dados que diferem só em `pagamento.pago_em` (duas execuções do n8n) responde `200` com o mesmo `numero` e mantém o primeiro instante; qualquer outra diferença continua `409 STORE_ORDER_CONFLICT`.                                                                                                                                                                        |
| LOJ-38 | A primeira geração bem-sucedida do PDF da ficha da loja registra a mesma primeira impressão idempotente de LOJ-27..29 e tira o pedido do aviso; `HEAD`, erro de geração e acesso negado não registram. A interface passa a dizer “Ficha ainda sem PDF” e “PDF gerado por …”, preservando os nomes dos campos e eventos internos. |
| LOJ-39 | Exceção administrativa restrita a LOJ-07/34: humano administrador ativo pode corrigir quantidade de produto unitário da loja por `POST /api/v1/orders/{orderId}/store-correction`, com sessão, CSRF, origem, Idempotency-Key, versão e valores anteriores esperados. API e transação recusam pessoa sem capacidade, automação e estado/versão incompatíveis. |
| LOJ-40 | O catálogo calcula o novo valor das peças para quantidade inteira permitida e o pagamento existente precisa cobri-lo. Somente grade, peças, valor das peças, versão e atualização mudam, com evento e auditoria transacionais sem PII. Número, cliente, produto, cor, tamanho, pagamento completo, confirmação e primeira impressão permanecem; replay original do n8n retorna o corrigido sem reversão. Repetição do comando humano não cria segundo efeito, inclusive após resposta perdida. |
| LOJ-41 | A página oferece “Correção administrativa de quantidade” somente ao administrador de produto unitário da loja, em seção inicialmente recolhida, operável por teclado. Erros são anunciados; sucesso atualiza quantidade/valor e orienta gerar novamente a ficha. Correção não faz nova cobrança nem altera frete do checkout; a operação confere o envio separadamente. |

## Jornadas com menos botões (ADR 036, 15/10/2026)

O PO aprovou em 15/10/2026 o
[RFC 024](../../../docs/rfc/024-jornadas-com-menos-botoes.md) com as opções
recomendadas (pergunta D1) e a premissa D2: valor final e forma de pagamento
passam a ser digitados no diálogo "Gerar o pedido". A pergunta D3 (o vendedor
entra pela Caixa de Entrada em "Minhas" depois do login) ficou adiada: PNL-04
e a T131 não são implementadas. A decisão durável está no
[ADR 036](../../../docs/adr/036-padroes-de-jornada.md) e os padrões em
[`design.md`](../../../design.md) §16. O Painel (PNL-01 a PNL-04) fica na
[spec do CRM MVP](../crm-mvp/spec.md), junto de FIN-02.

Nenhum critério abaixo muda API, contrato de dados, migração, dependência ou a
ficha impressa: tudo usa `missingFields`, os filtros por query string e os
resumos que já existem. Onde divergem, estes critérios superam os anteriores;
cada critério emendado tem a nota no próprio texto e na tabela "Emendas".
Continuam valendo, sem mudança: PIT-05, PLA-04, TEC-08, PIM-01, PAU-01,
PCL-07, PCL-10, PCL-11, PCX-04, PLI-03, PLI-08, LOJ-07, LOJ-24, LOJ-31,
LOJ-33, LOJ-34, REV-06, REV-10 e FIN-02.

### Página do pedido

1. **PFI-15** WHEN quem pode editar o pedido (dono da conversa, vendedor
   responsável do Pedido manual ou administrador) abre um pedido pendente do
   atendimento THEN o topo da página SHALL mostrar "Para gerar o pedido: N de
   3", com três passos nesta ordem: Entrega prometida
   (`summary.data_entrega_confirmada`), Itens (`items` e `items[N].*`) e Arte
   do pedido (`artwork`). Um passo SHALL contar como feito só quando
   `missingFields` não traz nenhuma chave dele; o total SHALL ser sempre 3, e
   abrir, visitar ou salvar uma seção sem resolver a pendência SHALL NOT
   avançar a contagem. Só o primeiro passo pendente SHALL ter botão, com verbo
   e objeto ("Informar a entrega prometida", "Completar os itens", "Marcar
   quem faz a arte"), que abre a seção no ponto pendente; os outros passos
   mostram o estado em texto ("Completo", "Falta a cor do item 2").
   `finalAmount` e `paymentCondition` SHALL NOT entrar na contagem (PFI-19).
   WHEN quem abre não pode editar (PAU-01), o pedido está confirmado ou é da
   loja do site (LOJ-07, LOJ-34) THEN o progresso SHALL NOT aparecer. WHEN a
   leitura do pedido falha THEN a página SHALL mostrar o erro com "Tentar
   novamente" e SHALL NOT mostrar contagem nenhuma.
2. **PFI-16** O rodapé fixo da página SHALL mostrar o próximo passo de PFI-15
   como a única ação primária enquanto houver pendência e "Gerar pedido" só
   quando os três passos estão feitos. WHEN "Gerar pedido" aparece com
   pendência THEN ele SHALL ter `aria-disabled="true"`, continuar focável,
   descrever o que falta ("Falta: entrega prometida") e, ativado por clique,
   Enter ou Espaço, SHALL NOT abrir o diálogo nem chamar a confirmação. Quem
   não pode gerar continua sem o botão (PCL-06).
3. **PFI-17** Cada seção do pedido SHALL ter um cabeçalho com o título, o
   estado em texto ("Completo", "Falta: cor do item 2", "2 itens · 40
   peças", "Sem arquivos") e o botão com verbo e objeto: "Editar resumo",
   "Editar datas", "Editar itens", "Editar arte" e "Editar observações". WHEN
   uma seção está em edição THEN os outros "Editar" SHALL ficar com
   `aria-disabled="true"`, focáveis, com a descrição "Salve ou cancele a
   edição aberta", e ativá-los SHALL NOT abrir outra edição nem descartar a
   aberta (mantém PFI-06). Leitor sem permissão (PAU-01), pedido confirmado,
   salvo "Editar datas" (PFI-10, PLA-04), e pedido da loja (LOJ-07) SHALL NOT
   ver os botões "Editar".
4. **PFI-18** WHEN a tela tem até 768 px THEN as seções do pedido SHALL formar
   um acordeão com uma seção aberta por vez, Dados do atendimento inclusive
   (PFI-08). Cada cabeçalho SHALL ser um botão com `aria-expanded` e
   `aria-controls` cujo nome acessível traz o título e o estado ("Itens, falta
   a cor do item 2"); abrir uma seção fecha a outra, salvo a que está em
   edição, que SHALL continuar aberta até Salvar ou Cancelar. Ao carregar,
   SHALL abrir a seção do hash da URL (por exemplo `#itens`); sem hash, ou com
   um hash desconhecido, a do primeiro passo pendente de PFI-15; sem
   pendência, o Resumo. WHEN a tela tem mais de 768 px THEN todas as seções
   SHALL ficar abertas e empilhadas, sem acordeão.
5. **PFI-19** WHEN os três passos estão feitos e quem pode gerar aciona "Gerar
   pedido" THEN SHALL abrir o diálogo "Gerar o pedido" (`role="dialog"`,
   `aria-modal="true"`, foco contido) com a revisão do que vai ser gerado
   (cliente, entrega prometida, itens com peças e total, arte do pedido) e os
   campos "Valor final" (PFI-11) e "Forma de pagamento" (PFI-12). O bloco
   sempre aberto de valor final e forma de pagamento SHALL deixar de existir
   no pedido pendente: o diálogo é o único modelo de edição desses campos. O
   foco inicial SHALL ir para "Valor final"; Esc ou "Voltar" SHALL fechar
   sem gravar e devolver o foco a "Gerar pedido" (no trilho ou no rodapé do
   celular, conforme quem abriu). Pedido reaberto SHALL abrir
   o diálogo com o valor e a forma gravados (PCL-07). WHEN o valor é inválido
   ou falta a forma THEN o erro SHALL aparecer junto ao campo e nada SHALL ser
   enviado. WHEN a API responde 422 `ORDER_NOT_CONFIRMABLE` com pendência fora
   do diálogo THEN o diálogo SHALL fechar, o progresso SHALL ser relido e o
   foco SHALL ir para o botão do próximo passo; o status continua `pendente`
   (PCL-05). WHEN a API responde 409 de versão THEN o diálogo SHALL pedir para
   recarregar, sem gravar. Pedido confirmado e pedido da loja continuam com
   "Fechamento e pagamento" em leitura (LOJ-34). Premissa D2 aprovada pelo PO
   em 15/10/2026. Emenda da T133: o texto da S4 dizia "Cancelar"; o botão
   entregue na T125 (`6a56687`) é "Voltar", e este critério foi alinhado a
   ele.
6. **PFI-20** A página do pedido SHALL dizer "Arte do pedido" no lugar de
   "Estampa e arquivos" e "Datas do pedido" no lugar de "Lastro do pedido";
   o bloco "Controle de produção" SHALL sair da página. A ficha impressa
   SHALL NOT mudar: mantém "Lastro do pedido" e o controle de produção, com
   os mesmos templates e hashes (PIM-10, TEC-07). O nome da empresa na página
   (por exemplo, em "A Silmer cria a arte") SHALL vir de `brand`, nunca
   escrito no componente (ADR 035). A seção Arte do pedido SHALL mostrar um
   só controle de adicionar arquivo por vez; os limites e as regras de ARQ-02
   a ARQ-06 não mudam.

### Conversa e fila da Caixa de Entrada

7. **PCX-10** WHEN a conversa tem pedido THEN o cabeçalho SHALL mostrar o link
   "Pedido NN-CRM · <status>" (Pendente ou Confirmado) para o pedido que o
   botão "Pedido" mostrava (PCX-06), que abre a página do pedido com a origem
   (PGE-01) e acompanha mudanças sem recarregar (PLI-08). WHEN a conversa não
   tem pedido THEN o cabeçalho SHALL NOT mostrar status de pedido. O botão
   "Pedido" e a gaveta SHALL deixar de existir (supera PCX-06 a PCX-09).
8. **PCX-11** "Criar pedido" SHALL aparecer só para o dono da conversa ou um
   administrador, numa conversa sem pedido pendente (PCL-10, PCL-11). Outro
   vendedor SHALL NOT ver a ação, e a API continua autorizando: 403 para quem
   não pode e o pedido existente quando já há pendente.
9. **PCX-12** O resumo do pedido (número, status, o que falta pela lista de
   PIT-06, itens com tipo e peças, total de peças, valor quando houver e
   "Abrir pedido") SHALL ficar em Detalhes › Pedido, só para leitura. Sem
   pedido, a seção SHALL dizer "Sem pedido" uma vez e oferecer "Criar pedido"
   só a quem PCX-11 permite.
10. **PCX-13** WHEN a conversa ainda não tem uma pessoa responsável e quem a
    abre pode assumi-la THEN "Assumir atendimento" SHALL ocupar o lugar do
    campo de mensagem, com o motivo da parada e o tempo parado (PCX-03), como
    única ação primária da região; depois de assumir, o campo de mensagem
    SHALL aparecer com "Enviar resposta" como única primária e receber o
    foco. A reivindicação continua atômica (ADR 009). Quem não pode assumir
    SHALL NOT ver o botão ativo e SHALL ver o motivo em texto. "Encerrar
    conversa" SHALL ficar em "Mais" em todas as larguras (emenda PCX-05).
11. **PCX-14** A fila da Caixa de Entrada SHALL ter a busca, os atalhos Todas
    · Aguardando · Minhas, cada um com contagem e seleção neutra, e o botão
    "Filtros", que abre uma folha com Situação (Todas, Aguardando vendedor,
    Com o agente, Com vendedor, Arquivadas) e Responsável (Todas, Minhas, Sem
    responsável). Os filtros ativos SHALL aparecer num resumo, cada um com
    botão para removê-lo; Esc fecha a folha e devolve o foco a "Filtros".
    Aguardando continua ordenada por tempo parado (PCX-04). Os links
    `?fila=` e `?situacao=` SHALL abrir a lista com o filtro no resumo; valor
    desconhecido SHALL ser ignorado sem erro. As abas de estado e o seletor
    "Fila" SHALL deixar de existir (emenda PCX-02 e PCX-05).

### Lista de Pedidos

12. **PLI-09** A lista de Pedidos SHALL ter três chips (Todos, Meus
    pendentes, Prontos para produção) e o botão "Filtros", que abre uma folha
    com os oito filtros de hoje agrupados em Situação (Pendentes,
    Confirmados), Responsável (Meus pendentes), Origem (Loja do site),
    Entrega (Entrega atrasada, Próximas entregas) e Produção (Prontos para
    produção), além de Todos. A escolha continua única. Os grupos Confirmados
    e Pendentes continuam (PLI-03), e os links `?status=`, `?entrega=`,
    `?vendedor=eu` e `?origem=loja` continuam abrindo a lista filtrada
    (LOJ-31, LOJ-33). Emenda PLI-02.
13. **PLI-10** WHEN o filtro ativo não é um dos três chips (veio da folha ou
    de um link do Painel) THEN a lista SHALL mostrar o nome dele com o botão
    "Limpar filtro", que volta a Todos. A contagem do resultado ("12
    pedidos") SHALL substituir o resumo de filtro atual e ser anunciada em
    região `aria-live="polite"`. WHEN o filtro não acha nada THEN a lista
    SHALL dizer que nenhum pedido atende ao filtro e oferecer "Limpar
    filtro", diferente do vazio inicial sem pedidos.

### Emendas

| Critério        | Emendado ou superado por | O que muda                                                             | Evidência da emenda                                                                                                                                                                                                     |
| --------------- | ------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PFI-01          | PFI-18, PFI-20           | "Controle de produção" sai da tela; "Datas do pedido"; acordeão        | `orders.spec.js` “keeps the sections in the order of the printed ficha (PFI-01, PLA-01)” e “folds the sections into an accordion on a phone, by keyboard, with the state in each head (PFI-18)”                         |
| PFI-06          | PFI-17                   | "Editar" com objeto e `aria-disabled` com motivo                       | `orders.spec.js` “keeps the other "Editar" focusable but unavailable, with the reason, while one section is open (PFI-17, PFI-06)”                                                                                      |
| PFI-08          | PFI-18                   | Dados do atendimento dentro do acordeão no celular                     | `orders.spec.js` “leaves production to the printed ficha and shows service data as not printed (PFI-08, PFI-20)” e “folds the sections into an accordion on a phone, by keyboard, with the state in each head (PFI-18)” |
| PFI-09          | PFI-15                   | O banner do topo vira o progresso real                                 | `orders.spec.js` “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)”                                                                                           |
| PFI-13          | PFI-16, PFI-19           | A única primária é a do próximo passo ou "Gerar pedido"                | `orders.spec.js` “makes the next step the only primary while one is missing (PFI-13, PFI-16)” e “keeps "Gerar pedido" as the only primary button of the page (PFI-13)”                                                  |
| PIT-06          | PFI-15, PFI-19           | "Falta para gerar" nomeia os passos; valor e forma vão para o diálogo  | `orders.spec.js` “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)” e “closes the dialog on a blocker outside it and leads to the next step (PFI-19, PCL-05)” |
| PLA-01, PLA-07  | PFI-20, PFI-17           | "Datas do pedido" na tela; "Editar datas"                              | `orders.spec.js` “keeps the sections in the order of the printed ficha (PFI-01, PLA-01)” e “heads each section with its state in words and "Editar" naming the section (PFI-17)”                                        |
| TEC-03, ARQ-01  | PFI-20                   | "Arte do pedido" na tela; um só controle de adicionar arquivo por vez  | `orders.spec.js` “records who makes the art next to an empty file area (TEC-03, ARQ-01)” e “says "Arte do pedido" with one control to add files at ${width}px (PFI-20)”, em 390 e 1280 px                               |
| PCX-02, PCX-05  | PCX-13, PCX-14           | Atalhos com contagem e folha de filtros; "Encerrar conversa" em "Mais" | `crm-ui.spec.js` “PCX-14: filters the Inbox with three shortcuts with totals and the "Filtros" sheet” e “never offers to hand the conversation back to the AI and keeps the actions on the keyboard”                    |
| PCX-06 a PCX-09 | PCX-10 a PCX-12          | Superados: link no cabeçalho e Detalhes › Pedido no lugar da gaveta    | `crm-ui.spec.js` “PCX-10: links the conversation header to its order, with the status in words” e “PCX-12: summarises the order in Detalhes, opened and closed from the keyboard”                                       |
| PLI-02          | PLI-09, PLI-10           | Três chips e folha de filtros                                          | `orders-list.spec.js` “PLI-09/PLI-10: the "Filtros" sheet works by keyboard and names the filter it applies” e “filters by status and searches by number, customer or phone”                                            |

### Rastreabilidade das jornadas

Fechada na T133 (15/10/2026), na branch `ux/jornadas`. Cada fatia entregou
os seus testes no mesmo commit; "Coberto" quer dizer que o teste citado
existe na branch e falha se o critério for quebrado. O requisito passa a
"Verified" com o gate completo (`npm run validate` e `npm run test:e2e`) do
PR de `ux/jornadas` para o `master`. E2E em `test/e2e/`; unitários em
`test/`.

| ID     | Tarefa | Fatia (commit)  | Evidência                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Status                                |
| ------ | ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| PFI-15 | T121   | A1 (`d78f7ab`)  | `orders.spec.js` “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)”, “shows no progress to generate on a confirmed order or a store order (PFI-15, LOJ-34)”, “reaches and opens the next step by keyboard, and announces the count (PFI-15)”, “counts a blocker the screen does not know as a step that leads to the closing panel (PFI-15)” e “keeps a ready pending order within 1.800 px on a phone (RFC 024)”; `order-format.test.js` “derives the three steps to generate from missingFields only (PFI-15)”, “names what an item step lacks without inventing progress (PFI-15)”, “has no steps for a store order or an order without the list (PFI-15, LOJ-34)” e “turns a blocker the screen does not know into "Revisar pendências", never a false 3 de 3 (PFI-15)” | Coberto em `ux/jornadas`              |
| PFI-16 | T121   | A1 (`d78f7ab`)  | `orders.spec.js` “makes the next step the only primary while one is missing (PFI-13, PFI-16)”, “lists exactly what is missing to generate, point by point (PFI-09, PFI-15, PFI-16, PIT-05, PIT-06, TEC-03)” e “keeps the main action of the order in a fixed footer on a phone”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Coberto em `ux/jornadas`              |
| PFI-17 | T122   | A2a (`ab24ea4`) | `orders.spec.js` “heads each section with its state in words and "Editar" naming the section (PFI-17)”, “keeps the other "Editar" focusable but unavailable, with the reason, while one section is open (PFI-17, PFI-06)”, “opens the items from the next step by keyboard, through the section itself (PFI-15, PFI-17)” e “keeps the section heads readable and their buttons thumb sized, light and dark (PFI-17)”                                                                                                                                                                                                                                                                                                                                                                                                                  | Coberto em `ux/jornadas`              |
| PFI-20 | T123   | A4 (`a25cba7`)  | `orders.spec.js` “says "Arte do pedido" with one control to add files at ${width}px (PFI-20)” (390 e 1280 px), “no order component writes the company name itself (PFI-20, ADR 035)”, “leaves production to the printed ficha and shows service data as not printed (PFI-08, PFI-20)” e “keeps the sections in the order of the printed ficha (PFI-01, PLA-01)”                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Coberto em `ux/jornadas`              |
| PFI-18 | T124   | A2b (`5baadf5`) | `orders.spec.js` “folds the sections into an accordion on a phone, by keyboard, with the state in each head (PFI-18)”, “opens the section of the hash and of the next step, and never folds an edit (PFI-18)”, “keeps a confirmed order and a store order coherent in the accordion (PFI-18, PFI-10, LOJ-07)” e “keeps every section open and the heads plain on a wide screen (PFI-18)”                                                                                                                                                                                                                                                                                                                                                                                                                                              | Coberto em `ux/jornadas`              |
| PFI-19 | T125   | A3 (`6a56687`)  | `orders.spec.js` “reviews and generates the order by keyboard alone, giving the focus back on Esc (PFI-19)”, “asks for the payment method in the dialog, before the request (PFI-12, PFI-19)”, “refuses a malformed amount next to the field, before the request”, “sends one confirmation for a double Enter while it is on its way (PFI-19, PCL-09)”, “closes the dialog on a blocker outside it and leads to the next step (PFI-19, PCL-05)”, “keeps the dialog open with the message when the connection drops (PFI-19)”, “keeps the dialog open and asks to reload when the order changed (PFI-19, PCL-09)”, “keeps the dialog accessible and thumb sized, light and dark (PFI-19)” e “confirms the order, frees printing, reopens it and locks printing again” (pedido reaberto, PCL-07)                                        | Coberto em `ux/jornadas`; D2 aprovada |
| PCX-10 | T126   | B1 (`c1a9023`)  | `crm-ui.spec.js` “PCX-10: links the conversation header to its order, with the status in words”, “PCX-10: updates the order link when the order changes elsewhere” e “PCX-10: reaches the order page from the header with the keyboard alone”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Coberto em `ux/jornadas`              |
| PCX-11 | T126   | B1 (`c1a9023`)  | `crm-ui.spec.js` “PCX-11: offers "Criar pedido" in the header only to the owner and creates it there”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Coberto em `ux/jornadas`              |
| PCX-12 | T126   | B1 (`c1a9023`)  | `crm-ui.spec.js` “PCX-12: summarises the order in Detalhes, opened and closed from the keyboard” e “PCX-12: on a phone Detalhes › Pedido opens from "Mais" and Esc hands focus back”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Coberto em `ux/jornadas`              |
| PCX-13 | T127   | B2 (`accc1b0`)  | `crm-ui.spec.js` “PCX-13: takes the conversation from the composer by keyboard, once, and lands on the reply”, “claims a pending handoff from its conversation in the Caixa de Entrada” e “never offers to hand the conversation back to the AI and keeps the actions on the keyboard”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Coberto em `ux/jornadas`              |
| PCX-14 | T128   | B3 (`f3935a9`)  | `crm-ui.spec.js` “PCX-14: filters the Inbox with three shortcuts with totals and the "Filtros" sheet”, “PCX-14: on a 390 px phone the shortcuts fit, the sheet works by keyboard and the first screen keeps its budget”, “PCX-14: the shortcuts and "Filtros" are 44 px targets with 8 px between them (design.md §4)” (tablet com toque), “PCX-14: the Painel links open the Inbox with their shortcut pressed”, “PCX-14: an empty filter is not an empty Inbox and offers "Limpar filtros"”, “PCX-14: a total that fails to load is left out, never guessed” e “names the stop reason and waits, oldest first, when the seller is due” (PCX-04)                                                                                                                                                                                     | Coberto em `ux/jornadas`              |
| PLI-09 | T129   | C1 (`aeec878`)  | `orders-list.spec.js` “PLI-09/PLI-10: the "Filtros" sheet works by keyboard and names the filter it applies”, “PLI-09: on a phone the first order sits whole above the bottom bar, and "Filtros" is a bottom sheet” e “PLI-09: on a notebook the "Filtros" sheet keeps 44 px targets, 8 px apart, without scroll”; `store-orders.spec.js` “the list filters "Loja do site" by keyboard and labels the store order”                                                                                                                                                                                                                                                                                                                                                                                                                    | Coberto em `ux/jornadas`              |
| PLI-10 | T129   | C1 (`aeec878`)  | `orders-list.spec.js` “PLI-09/PLI-10: the "Filtros" sheet works by keyboard and names the filter it applies”, “PLI-10: a Painel filter in the address is named, combines with the search and leaves the address when cleared” e “filters by status and searches by number, customer or phone” (contagem do resultado); vazio por filtro só em “says the production queue is empty when every order was delivered”                                                                                                                                                                                                                                                                                                                                                                                                                     | Coberto em `ux/jornadas`, com lacuna  |

Lacuna conhecida: o vazio por filtro de PLI-10 ("nenhum pedido atende ao
filtro" com "Limpar filtro") só tem teste para "Prontos para produção"; os
outros filtros da folha não têm teste do estado vazio.

PNL-01 a PNL-04 têm a rastreabilidade na [spec do CRM MVP](../crm-mvp/spec.md).
