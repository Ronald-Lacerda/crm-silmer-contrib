# CRM Silmer MVP — Requisitos Rastreáveis

## Emenda Olist — centavos exatos (05/11/2026)

[ADR 062](../../../docs/adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) e
[RFC 046](../../../docs/rfc/046-olist-escopo-inicial-de-centavos-exatos.md), aprovadas
pelo PO: exportação automática inicial somente com unitário exato em centavos,
sem arredondamento. Subtotais não divisíveis pela quantidade continuam válidos
no CRM e bloqueiam a exportação inteira antes de qualquer inclusão. Identidade
por linha e conferência exata de valores retornados/totais são obrigatórias;
F1 restrito depende da prova API e tela. Demais regras de produto preservadas.

## Cobranças do pedido — extensão aprovada (05/11/2026)

Após aprovação do protótipo, [ADR 058](../../../docs/adr/058-cobrancas-do-pedido-com-infinitepay.md)
e [COB-01–16](../order-billing/spec.md) autorizam geração de cobranças e
recebimentos de pedidos confirmados fora da loja, com 0%, X% e 100%, Pix e
cartão parcelado. Essa fronteira emenda FIN-01–03 quanto a recebimento/saldo
somente de pedidos geridos pela integração; não reativa PAY-01–05 antigos.
Sinal não quita, pagamento não confirma pedido e Financeiro mantém seu check.
Entrega [COB-DEL-01](../order-billing/tasks.md).

## Filtros horizontais da Inbox — PCX-18 (05/11/2026)

Tarefa INBOX-UX-06, autorizada pelo proprietário no chat com a captura local
como referência. Emenda PCX-16a e a ordem visual de PCX-17f; preserva o
restante de PCX-15/16/17 e UX-FUNC-01.

- **PCX-18a:** Atender / Fechar pedidos / Todas SHALL aparecer nessa ordem,
  em grupo horizontal acima da lista e da conversa no desktop, com contagens
  oficiais e botão textual Filtros. A busca SHALL permanecer na lista.
  Todas continua a entrada padrão sem filtro explícito, por urgência oficial;
  posição visual SHALL NOT modificar consulta, paginação ou permissões.
- **PCX-18b:** Filtros SHALL abrir a folha modal existente com Situação e
  Responsável. Seleções editam um rascunho; Ver resultados aplica, Limpar
  prepara a remoção e Escape/fechar descartam mudanças não aplicadas.
  O foco SHALL ficar contido e voltar ao acionador no fechamento. Critérios
  aplicados continuam removíveis pelos chips e Limpar filtros.
- **PCX-18c:** claro/escuro, teclado, toque e larguras desde 320 px SHALL
  preservar controles legíveis, sem rolagem horizontal da página. No celular,
  a barra pertence à lista; abrir uma conversa preserva o espaço do histórico
  e compositor. Ampliar a conversa no desktop preserva filtros e rascunhos.
- **PCX-18d:** a entrega SHALL partir da versão atual de produção, publicar
  somente esta fatia e alinhar o checkout/build local à revisão publicada.
  Trabalho local anterior SHALL ser preservado separadamente. Igualdade de
  código SHALL NOT copiar dados, credenciais ou integrações de produção para
  desenvolvimento, nem executar mensagens/comandos comerciais para validar UI.

## UX-FUNC-01 — Componentes com função explícita (04/11/2026)

Implementação autorizada pelo proprietário no chat. Complementa PCX-13/14/15,
MSG-02/03, PLI-09/10 e a fundação das ADRs 035/036; não altera ACL ou estados
comerciais.

- O rascunho textual SHALL pertencer à Conversa em memória da Inbox. Trocar
  de cliente não transporta texto; voltar recupera o rascunho. Sair da Inbox
  ou recarregar descarta os rascunhos, sem persistir conteúdo em storage do navegador.
- Sucesso de envio SHALL limpar somente o texto submetido da conversa alvo;
  falha preserva o texto. Resposta atrasada não altera rascunho, foco ou feedback
  de outra conversa nem apaga uma edição mais recente.
- Filtros de Pedidos SHALL explicitar a visualização exclusiva de PLI-09,
  conservar aplicação consciente, Escape e retorno do foco; o filtro aplicado
  pode ser removido por chip nomeado, preservando busca e links do Painel.
- Vazio por filtro ou busca SHALL distinguir a causa e oferecer a recuperação
  correspondente. Buscar fora da visão de entrega informa a mudança de escopo;
  o alcance da busca nas conversas carregadas fica visível na Inbox; o total
  carregado e a paginação seguem PCX-17, sem limite global implícito de 100.
- Ação primária, continuidade, utilidade e navegação SHALL ter ênfases distintas;
  seleção, edição, prontidão, atenção e erro não dependem apenas de cor.
- Sombra SHALL indicar sobreposição funcional; controles em repouso ficam planos.
  Temas, alvos de toque, teclado, foco e orçamentos da ADR 036 permanecem.

Entrega e evidências: [tarefa](tasks.md), [design](../../../design.md).

## Inbox aberta em Todas — PCX-17 (04/11/2026)

Tarefa INBOX-UX-05, solicitação do proprietário no chat. Emenda a entrada
padrão de PCX-15a; as filas pessoais e capacidades permanecem existentes.

- **PCX-17a:** sem filtro explícito na URL, a Caixa SHALL abrir em Todas,
  sem restrição de responsável, agente ou situação. Inclui conversas de
  outros vendedores e encerradas não arquivadas, respeitando conversation.read.
  Arquivadas continuam no filtro próprio; links com fila/situação explícita
  preservam a intenção. Todas/Atender/Fechar pedidos continuam refinamentos.
- **PCX-17b:** Todas SHALL pedir `sort=urgency` à API, sem ordenar apenas a
  página no navegador. A prioridade SHALL ser: falha/incerteza de envio;
  transferência por urgência ainda aguardando atendimento/resposta; espera
  humana/transferência pendente; pedido pronto para revisão; demais ativas
  humanas; agente; terminais/arquivadas. Dentro do grupo, posição operacional
  mais antiga e ID desempatarão. Encerradas/arquivadas não sobem por falha antiga.
  Não inferir prazo por texto livre, pré-ficha ou dados ausentes.
- **PCX-17c:** ordenação SHALL anteceder LIMIT; cursor assinado SHALL vincular
  ordenação, filtros e ator autenticado. Total oficial SHALL contar o universo
  filtrado sem transformar ordenação em fila pessoal. Chamadas sem sort
  preservam ordem/cursor anteriores, inclusive Atender/Fechar pedidos.
- **PCX-17d:** próximo cursor SHALL permitir Ver mais conversas até esgotar
  o universo acessível, com ordem preservada, sem repetir IDs. Filtros,
  recarregamento e troca de escopo SHALL invalidar páginas antigas em trânsito.
  Falha de página adicional preserva lista, rascunho e retry; busca identifica
  que alcança apenas conversas carregadas. Teclado e foco continuam utilizáveis.
- **PCX-17e:** ler, filtrar e paginar SHALL NOT assumir, enviar, reenviar,
  criar pedido, alterar estado ou ampliar permissões de mutação. Os critérios
  de pedido pronto e espera humana de PCX-15 permanecem oficiais.
- **PCX-17f:** os botões de refinamento SHALL distinguir seleção, rótulo e
  contagem oficial, sem depender só de cor. Todas lidera o grupo; contagens
  ficam alinhadas e o estado do botão Filtros indica abertura/filtro aplicado.
  Toque, foco visível, temas e leitura até 320 px permanecem utilizáveis.
## Olist e melhorias comerciais aprovadas em 04/11/2026

[ADR 057](../../../docs/adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../../../docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md)
são a emenda OLIST-01–50. OLIST-PLAN-02 prepara T01–T26; implementação pendente.

Os critérios OLIST prevalecem sobre posse obrigatória na geração ERP,
cadastro remoto apenas existente, total digitado e ausência de cancelamento:
checkbox por usuário, qualquer Pedido completo, criação/vínculo de cliente/
produto/tamanhos, subtotal por linha e total backend, cancelamento CRM terminal
pré-exportação para métricas/filas. Não conceder edição geral pelo checkbox.

Aplicação é o campo 4 por item/grupo; Previsão de entrega é o novo rótulo.
Ficha v7 preserva histórico. Loja/legados, Financeiro e perfil restrito seguem
adapters/escopos explícitos, sem inventar preço/dado fiscal ou apagar história.

## Inbox orientada ao vendedor — PCX-15 (03/11/2026)

Autorizada pelo proprietário no chat; tarefa INBOX-UX-02. Complementa INBOX-4,
AGT-03/05 e emenda PCX-03/13/14 de
[pedidos-mvp](../pedidos-mvp/spec.md). Não cria estados comerciais ou de leitura.

- **PCX-15a:** Atender SHALL reunir handoffs sem responsável
  e ações pendentes do próprio vendedor. Outro vendedor SHALL ficar fora dessa
  fila, inclusive quando quem consulta é administrador; Todas e os filtros de
  Situação/Responsável preservam a consulta e as capacidades anteriores.
- **PCX-15b:** cada card SHALL priorizar identificação, espera alinhada à
  direita e uma única próxima ação. Falha ou resultado incerto de envio SHALL
  prevalecer sobre fechamento. Nova é estado da conversa e SHALL NOT representar
  mensagem não lida. Canal, preview automático e pills técnicas saem do card.
- **PCX-15c:** Atender e Fechar pedidos SHALL filtrar, contar e ordenar na API
  antes da paginação, pela maior espera. O cursor SHALL ser vinculado ao ator
  autenticado e filtros. Handoff usa sua criação; resposta humana bem-sucedida
  encerra a sequência de inbound aguardando. Novas mensagens e avisos do bot
  SHALL NOT reiniciar a espera. Sem instante válido, SHALL NOT inventar duração.
- **PCX-15d:** Fechar pedidos SHALL usar um pedido elegível pendente não teste,
  a validação persistida sem campos faltantes e dados comerciais válidos. Uma
  pré-ficha completa SHALL NOT bastar. A ação Revisar pedido apenas navega;
  confirmação continua humana, autorizada e validada pela API do pedido.
  Havendo vários pedidos/Assuntos, SHALL expor um alvo explícito em reviewOrder
  sem esconder o pronto porque o pedido corrente está incompleto. Um pedido
  ligado a outro ciclo só qualifica se pertencer ao mesmo responsável atual;
  sem responsável, apenas pedido da própria conversa com handoff pendente.
- **PCX-15e:** o cabeçalho SHALL concentrar identidade, canal, responsável e
  Assumir atendimento quando permitido. O motivo fica abaixo dele. Para
  unsupported, SHALL dizer Agente não continuou sem inferir falha técnica,
  abuso ou tipo inválido; o resumo original fica acessível por disclosure,
  inicialmente recolhido nesse caso. Demais resumos preservam avisos comerciais.
- **PCX-15f:** falhas de envio e arquivos indisponíveis SHALL permanecer junto
  dos elementos afetados. Consultar fila, resumo ou pedido SHALL NOT reenviar
  mensagens. Teclado, foco após claim, mobile e temas SHALL manter acessibilidade.

Critérios e evidências sintéticas no
[runbook](../../../docs/runbooks/inbox-prioridades.md). Testes sintéticos não
substituem observação de vendedores reais ou homologação do canal.

## Inbox refinada — PCX-16 (04/11/2026)

Apresentação aprovada pelo proprietário após revisão do protótipo, tarefa
INBOX-UX-04. Complementa PCX-14/15 e OA-12; não muda contratos REST, regras,
ACL, filas, contagens, estados comerciais ou comandos de envio.

- **PCX-16a:** busca, Atender/Fechar pedidos/Todas e filtros SHALL ficar na
  coluna da lista. Filtros SHALL abrir junto ao acionador, com Situação e
  Responsável aplicados imediatamente pelos mesmos parâmetros oficiais.
  Escape e clique externo fecham sem desfazer seleções; foco permanece no
  campo durante atualização e retorna ao acionador ao fechar por Escape.
- **PCX-16b:** Mais ações SHALL abrir painel ancorado em camada superior,
  com nomes, ícones e encerramento em cor semântica de erro. Capacidades,
  confirmações, versões, ciência de pedido pendente e efeitos atuais permanecem.
- **PCX-16c:** sugestão pendente SHALL aparecer aberta fora da trilha de
  mensagens, com evidência e Criar pedido/Ainda não/Não vai seguir. Recolher
  SHALL preservar formulário, motivo e estado em andamento. O componente
  SHALL existir uma vez por conversa; histórico, bloqueios e omissão ficam
  em Atendimento sob demanda, preservando OA-03–10/12.
- **PCX-16d:** resumo SHALL iniciar compacto, preservar acesso ao texto
  completo e deixar avisos comerciais e vendedor solicitado perceptíveis.
  Ficha/preenchimento do agente SHALL ser identificado como dados coletados,
  sem afirmar prontidão ou confirmação comercial.
- **PCX-16e:** ampliar conversa SHALL liberar o espaço da lista sem remontar
  o histórico, trocar endereço, apagar rascunho ou alterar filtros. Reflow
  móvel SHALL preservar a navegação lista/conversa e o compositor disponível.
- **PCX-16f:** controle de expandir/recolher navegação SHALL usar só ícone,
  nome acessível, dica e estado. Preferência manual continua persistida; na
  Inbox expandida a navegação sobrepõe a lista sem estreitar a conversa.
- **PCX-16g:** atenção/pendência, informação/sugestão, sucesso e erro SHALL
  usar tokens semânticos atuais com texto/ícone, sem depender só de cor.
  Laranja permanece reservado às ações primárias; seleção continua neutra.
- **PCX-16h:** teclado, foco, claro/escuro, toque de 44 px e reflow SHALL
  manter compositor e histórico utilizáveis com resumo, evidência e várias
  sugestões longas. Fechar Atendimento durante decisão não cancela nem repete
  o comando; feedback tardio aparece fora do painel fechado sem reabri-lo.

## Exceção vigente — ponte Evolution/Baileys

A [ADR 050](../../../docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md)
autoriza ORC-02 e MSG-04 por Evolution/Baileys enquanto a API oficial está em
aprovação. Substitui a escolha WAHA anterior e preserva ORC-01..08, INB-01,
MSG-01..04, a integração Meta, reservas, identidade comprovada, idempotência
e handoff. EVOL-01 exige evidência de instalação, limpeza por referências,
pareamento e homologação separadas; testes do adapter não comprovam canal real.

## Exceção autorizada — transporte do piloto WAHA

A [ADR 043](../../../docs/adr/043-piloto-whatsapp-waha-webjs.md) autoriza em
27/10/2026 que ORC-02 e MSG-04 sejam atendidos pelo transporte WAHA com WEBJS
somente na linha temporária. Permanecem normalização, contratos versionados,
idempotência, autorização, reserva anterior ao envio e handoff. ORC-01..08,
INB-01 e MSG-01..04 exigem homologação própria no canal pareado; testes do
adaptador não a substituem. A exceção prevalece sobre referências ao WhatsApp
oficial neste documento exclusivamente no piloto.

## Evolução aprovada — Financeiro, Fila e detalhe

Em 21/10/2026 o PO aprovou o perfil Financeiro e a composição Fila e detalhe,
somente com fila e check manual, exigindo o design existente do CRM. Decisão
na [ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md), com
[RFC 028](../../../docs/rfc/028-financeiro-com-fila-e-check-manual.md).

Os [requisitos FINQ-01–19](../financeiro/spec.md) são o refinamento rastreável
desta evolução: acesso mínimo, entrada no painel, pedidos confirmados e
integralmente pagos (sinal não qualifica), não teste, de todos os vendedores e
origens; Aguardando/Concluídos; consulta mínima; “Nota criada” e correção
humanas, com auditoria, idempotência e preservação do estado comercial.
Design, componentes e tokens atuais são obrigatórios. Integração Olist fica
diferida; não reabre PAY-01–05 nem transforma FIN-01–03 em conciliação financeira.

A [ADR 041](../../../docs/adr/041-consulta-administrativa-do-financeiro.md)
complementa a decisão: Admin ativo consulta filas, contagens, detalhes e
histórico, mantendo menu completo e login atual, sem receber comandos
financeiros por essa autorização. FINQ-12 descarta o print como referência
visual; a aparência seguirá as telas e componentes reais do CRM.

**Estado:** implementação autorizada em 22/10/2026. Migrations, API, painel e
seletor em Usuários seguem [ADR 042](../../../docs/adr/042-perfis-e-requitacao-do-financeiro.md).
Novo valor exige nova quitação/check; datas manuais legadas exigem declaração
explícita. [FINQ-T01–T06](../financeiro/tasks.md) registram evidências e mantêm
homologação e conta real pendentes. PNL-04 continua adiado para os vendedores;
o destino de login próprio aplica-se ao perfil Financeiro.

## Problema

As conversas comerciais chegam por canais de mensagem, mas nem toda conversa é uma oportunidade. A Silmer precisa organizar atendimento e pedidos pendentes, automatizar a qualificação sem perder a autoridade do domínio e transformar o resultado em uma Ficha de Pedido válida para produção e operação.

## Objetivos

- Conduzir o caminho feliz do WhatsApp oficial até a Ficha de Pedido; adicionar
  Instagram em uma fase posterior sobre o mesmo domínio.
- Disparar automaticamente o n8n a cada mensagem recebida, sem botão na UI.
- Usar o Vendedor Silmer no n8n para conversar, coletar dados, criar ou completar pedido pendente e transferir para uma pessoa quando necessário.
- Manter o CRM como fonte da verdade, com APIs autorizadas, rastreabilidade, tomada humana e reconciliação de falhas.
- Medir as vendas originadas no CRM.

## Baseline vigente — 05/10/2026

ADRs 004, 006 e 020 supersedem funil linear e gates antigos de Ficha. OpenAI é a baseline da [ADR 021](../../../docs/adr/021-adotar-openai-no-mvp.md); deploy automático permanece conforme [ADR 022](../../../docs/adr/022-manter-deploy-automatico-github-easypanel.md). IDs preservados não comprovam homologação; estados de entrega estão na rastreabilidade.

## P1 — MVP

### P1.0 n8n como motor obrigatório

**User story:** Como operação, quero que toda mensagem recebida inicie automaticamente a jornada no n8n para que canais, IA e etapas comerciais funcionem sem depender de um botão na interface.

**Critérios de aceite:**

1. **ORC-01:** WHEN uma mensagem recebida é validada pelo canal THEN ela SHALL disparar automaticamente o n8n, sem ação da UI.
2. **ORC-02:** WHEN o n8n recebe ou envia uma mensagem pelo WhatsApp oficial
   THEN ele SHALL normalizar o evento e registrar seu resultado no CRM por
   contrato versionado; o adapter futuro do Instagram SHALL reutilizar esse
   contrato sem criar outro domínio.
3. **ORC-03:** WHEN o Vendedor Silmer atualiza briefing, cria ou completa Pedido pendente ou solicita handoff THEN o n8n SHALL usar API autenticada, autorizada, idempotente e auditável do CRM e nunca acessar diretamente o banco.
4. **ORC-04:** WHEN um workflow executa THEN o CRM SHALL correlacionar `workflow_key`, versão publicada, `execution_id`, mensagem, `automation_epoch` e resultado sem armazenar segredo.
5. **ORC-05:** WHEN eventos são repetidos, concorrentes ou chegam fora de ordem THEN CRM e n8n SHALL produzir no máximo um efeito oficial e expor divergências para reconciliação.
6. **ORC-06:** WHEN o workflow chama OpenAI, provedor escolhido para produção, THEN ele SHALL preservar o schema estruturado, segurança, privacidade e avaliação; um provedor alternativo exige nova decisão e homologação.
7. **ORC-07:** WHEN uma pessoa assume a conversa ou a automação é desligada THEN o CRM SHALL incrementar o `automation_epoch` e rejeitar comandos e envios de execuções antigas.
8. **ORC-08:** WHEN n8n, canal ou provedor de IA fica indisponível ou retorna resultado incerto THEN o sistema SHALL tornar a pendência visível e retomável, sem avançar silenciosamente a jornada.
9. **ORC-09:** WHEN a fase posterior CANAL-2 executa migração de canal THEN o sistema SHALL associar @instagram e telefone ao mesmo Contato somente após correlação verificável e auditável, preservando os históricos.

O contrato executável de ORC-01–08 é a OpenAPI v1: três endpoints n8n→CRM,
Basic Auth como `AUTOMATION_EXECUTOR`, idempotência com hash e o fence de uso
único `message.send.requested`, validado por `automation_epoch` e
`source_revision`. Resultado desconhecido exige reconciliação e nunca retry
cego à Meta. Não há claim, lease ou token de rodada no MVP simples.

**Teste independente:** receber uma mensagem realista, comprovar o disparo automático do n8n, executar a jornada com OpenAI, repetir eventos e assumir a conversa durante uma execução sem duplicar ou aplicar efeito atrasado.

### P1.1 Caixa de Entrada e conversão

**User story:** Como Vendedor, quero observar conversas e os pedidos pendentes correspondentes para assumir o atendimento quando necessário.

**Critérios de aceite:**

1. **INB-01:** WHEN uma mensagem válida chega THEN o sistema SHALL resolver Contato e Conversa na Caixa de Entrada sem confirmar uma venda automaticamente.
2. **INB-02:** WHEN o cliente confirma que quer fechar a compra THEN o agente SHALL sugerir internamente a criação e o vendedor responsável ou administrador SHALL decidir a abertura do pendente. Até essa ação, os dados SHALL permanecer na conversa. Acompanhamento humano, evidência, decisão e métricas seguem [OA-01–12](../order-assistance/spec.md), ADR 056, supersedendo a abertura automática da ADR 014.
3. **INB-03:** WHEN o atendimento não representa oportunidade THEN o sistema SHALL permitir encerramento auditável da Conversa sem exigir Pedido.
4. **INB-04:** WHEN criação automática ou manual é repetida THEN o sistema SHALL retornar o pendente existente sem duplicar Contato ou Pedido.

Para INB-01–04, Cliente é Contact + ContactIdentity; Pedido é rascunho até confirmação humana. Kanban e Negócio estão aposentados pela ADR 004, com Pedido vigente pela ADR 006.

**Teste independente:** receber duas conversas, completar dados da ficha na comercial e repetir eventos sem duplicar Contato, Conversa ou Pedido pendente.

### P1.2 Atendimento assistido pelo Vendedor Silmer

**User story:** Como operação, quero que o Vendedor Silmer converse, colete informações e conduza automaticamente os passos permitidos, preservando os gates humanos explícitos.

**Critérios de aceite:**

1. **AGT-01:** WHEN existe conversa ativa THEN o agente SHALL consultar histórico e campos já respondidos antes de perguntar.
2. **AGT-02:** WHEN o cliente informa dados em qualquer ordem THEN o agente SHALL validar e persistir respostas inequívocas e perguntar pelo próximo dado faltante, sem exigir avanço linear.
3. **AGT-03:** WHEN o cliente pede uma pessoa da Silmer THEN o agente SHALL interromper sua atuação e criar handoff com resumo, motivo e papel-alvo, inicialmente sem responsável.
4. **AGT-04:** WHEN o cliente insiste em valor antes de existir orçamento humano aprovado THEN o agente SHALL transferir sem calcular, negociar ou inventar valor.
5. **AGT-05:** WHEN o agente encontra bloqueio não resolvível THEN ele SHALL registrar o motivo e transferir sem descartar o contexto.
6. **AGT-06:** WHEN o agente envia mensagem, decide, altera estado ou transfere atendimento THEN um usuário autorizado SHALL conseguir auditar o evento e sua correlação com a execução do n8n.
7. **AGT-07:** WHEN todos os campos obrigatórios atuais da ficha estão válidos THEN o sistema SHALL permitir que dono da conversa ou administrador gere o Pedido; o agente SHALL preservar essa confirmação humana.
8. **AGT-08:** WHEN um campo obrigatório está ausente ou divergente THEN o sistema SHALL impedir geração, indicar pendências e permitir salvar rascunho sem apagar dados e histórico.
9. **AGT-09:** WHEN o agente falha ou não responde em `ASSISTANT_STALL_MINUTES` a uma mensagem do cliente das últimas 24 h THEN o sistema SHALL criar handoff sem dono com motivo `automation_failure` e invalidar respostas atrasadas pelo epoch (ADR 052).
10. **AGT-10:** WHEN o agente responde ou transfere THEN o CRM SHALL registrar a telemetria do turno só com códigos, contagens e tempos, sem texto do cliente, nome ou telefone, e expor apenas agregados (ADR 052).

O contexto do agente vem de `recent_messages` e do snapshot de briefing da
Conversa; não existe memória comercial paralela no n8n. `briefing_patch` ignora
nulos, aceita somente campos de qualificação e altera apenas esse snapshot até sua projeção autorizada no Pedido pendente; o agente não sobrescreve escolhas humanas.

**Teste independente:** coletar dados fora de ordem, preencher pedido pendente, preservar preço, condição e confirmação humana e repetir com os três cenários de handoff.

### P1.3 Ficha de Pedido

**User story:** Como Vendedor, quero gerar a Ficha com dados já coletados para encaminhar um pedido sem redigitação.

**Critérios de aceite:**

1. **ORD-01:** WHEN uma pessoa solicita gerar Pedido THEN o sistema SHALL validar os campos obrigatórios de PFI e TEC-01..08 em Pedidos MVP.
2. **ORD-02:** WHEN o primeiro Pedido é criado THEN o sistema SHALL reservar 01-CRM; seguintes SHALL usar sequência global NN-CRM; confirmar e reabrir SHALL preservar esse número (ADR 006).
3. **ORD-03:** WHEN o encaminhamento operacional da Ficha é homologado THEN ele SHALL alcançar Rose e registrar evidência de entrega; eventual envio automático é evolução própria, com telefone em secret://crm/order-recipient-phone e sem PII versionada.
4. **ORD-04:** WHEN o encaminhamento da Ficha falha THEN a operação SHALL preservar o Pedido confirmado e registrar retomada sem criar outro Pedido; automação desse efeito depende do contrato de ORD-03.
5. **ORD-05:** WHEN Pedido é gerado THEN o sistema SHALL registrar pessoa e horário, fixar nome do cliente, calcular peças pela grade e liberar impressão v5, deixando produção vazia; assinatura física de Rose e Operação SHALL preceder produção.
6. **ORD-06:** WHEN Pedido confirmado é aberto em celular THEN a pessoa SHALL poder gerar o PDF da ficha e, se o aparelho aceitar compartilhamento de arquivos, escolher manualmente o WhatsApp; a entrega automática a Rose continua dependente de ORD-03.

**Teste independente:** criar Pedido `01-CRM`, completar, gerar por pessoa autorizada, imprimir e reabrir sem duplicar Pedido ou consumir outro número; homologar encaminhamento a Rose separadamente.

### P1.4 Confiabilidade e canais

**User story:** Como Vendedor, quero saber quais mensagens foram processadas ou ficaram pendentes para que uma falha de integração não fique invisível.

**Critérios de aceite:**

1. **MSG-01:** WHEN um webhook é recebido mais de uma vez THEN o sistema SHALL processá-lo idempotentemente, sem duplicar mídia, validação ou handoff operacional.
2. **MSG-02:** WHEN o processamento falha ou a mídia temporária fica indisponível THEN o sistema SHALL colocar o evento em pendência visível com motivo e opção de retomada quando ainda possível.
3. **MSG-03:** WHEN o canal ou o volume temporário fica indisponível THEN o sistema SHALL exibir o estado e o último evento recebido sem afirmar que mensagens ou bytes não observados foram recuperados.
4. **MSG-04:** WHEN o primeiro MVP operacional é iniciado THEN WhatsApp
   Business SHALL estar operacional no n8n; WHEN a fase `CANAL-2` é iniciada
   THEN Instagram Direct SHALL reutilizar a mesma jornada, inclusive correlação
   de identidade e handoff.

O domínio comum preserva fronteiras neutras de canal, mas o contrato desta
entrega aceita somente WhatsApp. Instagram é uma fase posterior e não bloqueia
a validação do primeiro MVP operacional.

**OPS-INBOX-SEND-06 (MSG-02/03, ORC-08):** depois da reserva humana de uso
único e antes do transporte WhatsApp, a consulta autenticada do destinatário
deve retornar exatamente um registro, para o número solicitado, com `exists`
booleano. `false` conclui falha visível `EVOLUTION_RECIPIENT_NOT_FOUND`;
consulta indisponível, ambígua ou malformada conclui
`EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE`, sem chamar envio e sem retry.
O telefone e o hash do comando não mudam. A interface orienta conferir o
telefone sem afirmar inexistência permanente da conta. Resultado incerto
posterior ao transporte conserva reconciliação obrigatória, sem reenvio cego.
Uma conclusão tardia anterior ao envio exige a mesma reserva autenticada,
sem ID externo ou evento de resultado incerto do transporte; a fila só conclui
falha com comando, mensagem e recibos correspondentes. Históricos não são
reclassificados por uma consulta atual do destinatário.

**Teste independente:** repetir webhooks com mídia, induzir falha e perda da
cópia temporária, concluir o reprocessamento possível e comprovar que não há
duplicidade nem alegação falsa de recuperação e que a indisponibilidade do
um canal não corrompe o histórico do outro.

### P1.5 Financeiro comercial

**User story:** Como gestor, quero saber quanto o CRM vendeu para acompanhar o resultado comercial.

**Critérios de aceite:**

1. **FIN-01:** WHEN Pedido é confirmado THEN o sistema SHALL registrar valor, data e pessoa responsável e contabilizar a venda uma vez.
2. **FIN-02:** WHEN gestor consulta Dashboard THEN o sistema SHALL explicitar período e universo dos totais de confirmados, sem contar pendentes ou recebimentos. O seletor de período declara o que afeta (PNL-02).
3. **FIN-03:** WHEN Pedido é reaberto THEN o sistema SHALL preservar histórico e retirá-lo dos totais de confirmados; cancelamento/perda comercial permanecem fora do ciclo MVP (ADR 006).

**Teste independente:** confirmar, reabrir e consultar totais de pedidos em um universo conhecido; valores recebidos e saldo a receber não integram o cálculo do MVP.

### P1.6 Privacidade e acesso

**User story:** Como responsável pelo negócio, quero acesso controlado e tratamento previsível dos dados pessoais para operar o piloto com segurança.

**Critérios de aceite:**

1. **PRV-01:** WHEN uma pessoa ou o ator técnico do n8n acessa ou altera dados THEN o sistema SHALL aplicar as capacidades mínimas definidas no P0.7 e no contrato `AUTOMATION_EXECUTOR`, sem permitir autoatribuição ou acesso direto ao banco.
2. **PRV-02:** WHEN dados pessoais são alterados, exportados, anonimizados ou excluídos THEN o sistema SHALL registrar a operação conforme a política aprovada no P0.6.
3. **PRV-03:** WHEN o prazo de retenção é alcançado THEN o sistema SHALL aplicar a regra aprovada de descarte ou anonimização e permitir a execução pelo administrador técnico designado; para mídia transitória legada, o prazo SHALL ser o menor entre o encerramento da jornada e sete dias do recebimento ou envio. A nova mídia enviada do chat segue ADR 023 e MED-15: preservar até nova decisão de política, sem expurgo por sete dias ou encerramento; implementação pendente em INBOX-MEDIA-1.

**Responsável de privacidade:** Rômulo Sutil Corrêa. A política do piloto foi aprovada após consulta jurídica.

**Teste independente:** validar acesso por função e executar o procedimento de
retenção em dados de teste com relógio controlado, cobrindo encerramento antes
de sete dias, teto de sete dias e documento comercial excluído da purga curta.

### P1.7 Painel por papel

**User story:** Como vendedor ou gestor, quero abrir o Painel e saber o que
fazer agora, sem ler todos os indicadores.

Decisão do PO de 15/10/2026 no [RFC 024](../../../docs/rfc/024-jornadas-com-menos-botoes.md),
registrada no [ADR 036](../../../docs/adr/036-padroes-de-jornada.md). FIN-02 e
REV-06 continuam valendo. PNL-01..04 não mudam API, contrato de dados ou
migração: o Painel usa os resumos que já lê. Tarefas T130 e T131 em
[Pedidos MVP](../pedidos-mvp/tasks.md). PNL-05 e PNL-06 (pedido do PO de
06/11/2026, tarefa PNL-T05) acrescentam `daily` ao resumo de pedidos e
`unanswered` ao resumo da Inbox, sem migração.

**Critérios de aceite:**

1. **PNL-01:** WHEN um vendedor ou um gestor abre o Painel THEN o topo SHALL
   mostrar um único cartão "Próximo passo", com uma frase e um link para a
   lista já filtrada, escolhido pela primeira condição verdadeira na ordem do
   papel. Vendedor: conversas suas a responder → conversas aguardando vendedor
   para assumir → seus pedidos pendentes a completar → entregas atrasadas →
   "Nada urgente agora", sem link. Gestor: conversas fora do SLA (Esperando
   vendedor) → vendedor com conversas sem resposta há mais de 15 min
   (PNL-06) → entregas atrasadas → agente parado → pedidos a confirmar. WHEN
   a fonte de uma condição falhou THEN o cartão SHALL NOT pular essa condição
   nem dizer "Nada urgente agora": SHALL dizer que não conseguiu ler aquela
   informação, com "Tentar novamente".
2. **PNL-02:** O seletor de período SHALL declarar em texto visível "Vale para
   Vendido"; trocar o período SHALL mudar só o indicador Vendido e anunciá-lo,
   sem mudar os demais (FIN-02).
3. **PNL-03:** WHEN a leitura da fila falha THEN a seção da fila (Atendimento
   do gestor, Minha fila do vendedor) SHALL continuar visível, com "—" no
   lugar de cada número e "Tentar novamente"; a seção SHALL NOT sumir e
   nenhum número SHALL aparecer como "0" sem leitura bem-sucedida. Os
   indicadores de pedidos continuam com os próprios valores.
4. **PNL-04:** Destino do login por papel (o vendedor entra em
   `/inbox?fila=minhas` em vez do Painel). **Adiado** pelo PO em 15/10/2026
   (pergunta D3 do RFC 024): não implementar; o login continua levando ao
   Painel ou à rota pedida (LOJ-24). A tarefa T131 fica sem implementação
   ativa até nova decisão.
5. **PNL-05:** WHEN o gestor abre o Painel THEN o sistema SHALL mostrar
   "Vendido por dia": uma barra por dia dos últimos 7 dias de São Paulo,
   terminando em hoje (destacado), com o valor confirmado de cada dia e o
   total da semana em valor e pedidos, no mesmo universo de FIN-02
   (confirmados, sem pedidos de teste, por data do pedido). O gráfico SHALL
   ter descrição textual com cada dia e valor. WHEN o resumo de pedidos
   falhou THEN SHALL dizer que não há dados, nunca mostrar zeros.
6. **PNL-06:** WHEN o gestor abre o Painel THEN o sistema SHALL mostrar
   "Atendimento agora" com três linhas, cada uma um link para a Inbox
   filtrada: esperando vendedor (com a espera da mais antiga), com o
   assistente (com a saúde dele) e conversas de um vendedor sem resposta há
   mais de 15 minutos (última mensagem do cliente), com a quebra por
   vendedor. A quebra por vendedor SHALL vir só para quem tem
   `COMMERCIAL_ADMIN`. No Próximo passo do gestor, a regra "<vendedor> tem N
   conversas sem resposta há mais de 15 minutos" entra logo depois das
   conversas fora do SLA e abre a Inbox com as conversas desse vendedor. Com a
   fila em falha valem as regras de PNL-03. O Painel do gestor deixa de
   mostrar o "Checkpoint dos sócios" e "Minhas providências".

**Teste independente:** como vendedor com uma conversa a responder, ver o
cartão apontar para "Minhas conversas"; derrubar a leitura da fila e ver "—"
com "Tentar novamente" no cartão e na seção; trocar o período e ver só Vendido
mudar.

### P2.1 PIX e boas-vindas — diferido

A ADR 006 retirou cobrança, comprovante e status de pagamento do MVP. PAY-01..05 são preservados como rastreabilidade da evolução; não descrevem capacidade entregue nem bloqueiam gerar o Pedido atual. Datas manuais da ADR 008 não implementam esse fluxo.

**User story:** Como cliente com venda aprovada, quero receber instruções PIX e uma confirmação clara do pedido para saber o que fazer e o que esperar.

**Critérios de aceite:**

1. **PAY-01:** WHEN uma pessoa autorizada registra a venda como aprovada THEN o sistema SHALL criar uma única cobrança com o valor final do orçamento humano aprovado e enviar a chave PIX configurada.
2. **PAY-02:** WHEN a instrução PIX é enviada THEN o sistema SHALL guardar chave mascarada, horário, identificador da mensagem e estado do envio sem duplicar a cobrança em retries.
3. **PAY-03:** WHEN um comprovante é recebido THEN o sistema SHALL anexá-lo ao pedido e solicitar conferência humana sem marcar o pagamento como confirmado.
4. **PAY-04:** WHEN uma pessoa autorizada confirma o pagamento THEN o sistema SHALL registrar autor e horário e liberar a geração da Ficha.
5. **PAY-05:** WHEN a Ficha é gerada THEN o sistema SHALL enviar boas-vindas com número do pedido, resumo, data confirmada, modalidade logística e contato de suporte de forma idempotente.

**Teste independente:** aprovar uma venda, enviar PIX, receber comprovante, confirmar manualmente e repetir os eventos sem duplicar cobrança, pedido ou boas-vindas.

## P2 — Depois do piloto

- Canal próprio de atendimento do site; no MVP, o site apenas direciona para o WhatsApp.
- Escala do n8n em queue mode e Redis somente quando medições justificarem a infraestrutura adicional.
- Precificação automática baseada em política comercial futura; no MVP, o agente só comunica orçamento aprovado por uma pessoa.
- Valores recebidos e saldo a receber.

## Fora do escopo

- ERP contábil/fiscal.
- Estoque.
- Gestão completa da produção.
- App nativo.
- Pós-venda automatizado.

## Rastreabilidade

### Saúde e erros — OPS-ERR (02/11/2026)

Decisão do proprietário na [ADR 055](../../../docs/adr/055-central-de-erros-restrita-a-conta-operadora.md),
proposta [RFC 042](../../../docs/rfc/042-central-de-saude-e-erros.md),
tarefa OPS-ERR-T01. Complementa PRV-01 e a observabilidade da issue #11.

1. **OPS-ERR-01:** WHEN a sessão pertence à conta humana ativa
   `admin@crm-silmer.local` com `COMMERCIAL_ADMIN` THEN o shell SHALL oferecer
   o menu Saúde e erros; outras contas SHALL não visualizar o item nem montar
   a tela por acesso direto, inclusive outro administrador e Financeiro.
2. **OPS-ERR-02:** WHEN a API recebe leitura ou triagem THEN SHALL autenticar
   a sessão e conferir a identidade atual no banco e a capacidade, sem confiar
   em e-mail, ator ou permissão informados pelo cliente; automação SHALL ser
   negada e revogação/desativação SHALL impedir novo acesso.
3. **OPS-ERR-03:** WHEN uma falha coberta ocorre THEN a central SHALL manter
   ocorrência persistente agrupada por origem/código, contagem e primeira e
   última ocorrência. O recorte inicial SHALL cobrir 5xx da API e falhas
   duráveis de jobs/comandos n8n, com ingestão deduplicada.
4. **OPS-ERR-04:** WHEN a central mostra ou persiste diagnóstico THEN SHALL
   limitar os dados a códigos controlados, contagens, horários, versões e
   IDs opacos permitidos; corpos, mensagens, dados de cliente, credenciais e
   erros livres SHALL não aparecer. Retenção técnica SHALL ser de 14 dias, com limpeza diária conforme ADR 060 e OPSH-04.
5. **OPS-ERR-05:** WHEN o operador altera Novo, Em análise ou Resolvido THEN
   SHALL haver CSRF, origem, idempotência, versão e auditoria transacionais;
   conflito SHALL exigir atualização e histórico SHALL registrar as mudanças.
6. **OPS-ERR-06:** WHEN uma nova ocorrência chega a um grupo resolvido THEN
   SHALL reabrir o grupo; repetição da coleta SHALL não aumentar sua contagem.
   A triagem SHALL não reenviar mensagens nem alterar o efeito original.
7. **OPS-ERR-07:** WHEN o operador navega por teclado ou usa uma tela estreita
   THEN filtros, atualização, detalhes e triagem SHALL ser operáveis, com foco
   previsível e anúncios; vazio, carregamento, falha, conflito e perda de
   acesso SHALL ser explícitos e requisições SHALL ser canceladas ao sair.
8. **OPS-ERR-08:** WHEN a central apresenta seus dados THEN SHALL informar
   cobertura e instante da leitura, sem declarar monitor externo ou saúde
   universal; notificações externas e indisponibilidade da VPS continuam nos
   gates independentes da issue #11.
9. **OPS-ERR-09:** WHEN o transporte legado WAHA foi descontinuado e o
   operador arquiva suas pendências incertas THEN SHALL conferir um manifesto
   versionado de comandos com reserva autenticada `waha-webjs-1`, registrar
   autoria, horário e motivo e removê-los somente do recorte ativo. Comandos,
   mensagens, jobs, tentativas e ocorrências históricas SHALL conservar seus
   resultados e horários; arquivamento SHALL não resolver entrega nem reenviar.
   Pendências Evolution SHALL permanecer ativas, salvo disposição comprovada
   nos critérios de OPS-ERR-10/11. Ativas e Histórico SHALL
   distinguir contagens e datas, inclusive quando a mesma operação aparece
   nas projeções de worker e n8n.
10. **OPS-ERR-10:** WHEN uma pendência incerta não requer nova recuperação por
    ser conversa de teste comprovada ou por ter sido substituída por envio
    humano confirmado THEN SHALL exigir disposição auditada da conta operadora,
    motivo/versão controlados e prova verificável antes de sair de Ativas.
    Teste exige conta de canal persistida não produtiva; substituição exige
    destino e mensagem iguais, operação posterior distinta da mesma conversa,
    comando/mensagem enviados, ID externo concordante e recibo imutável.
    O resultado original SHALL continuar desconhecido, sem retry ou reenvio;
    histórico e tentativas SHALL permanecer preservados. Triagem sem essas
    provas SHALL não retirar resultado incerto de Ativas.
11. **OPS-ERR-11:** WHEN uma falha conclusiva foi tratada THEN SHALL sair somente
    da projeção ativa após verificar mensagem/comando failed, retry desabilitado,
    fila terminal, reconciliação resolvida e recusa autenticada anterior ao
    transporte ou auditoria específica de falha anterior à reserva. Recibos
    contraditórios ou ausência de prova SHALL manter a fonte ativa; coleta e
    histórico SHALL continuar sem alterar os efeitos originais.

| Grupo              | IDs                     | Status                                                                                                         |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Orquestração n8n   | ORC-01 a ORC-09         | WhatsApp implementado; homologação pendente; ORC-09 em CANAL-2                                                 |
| Inbox e conversão  | INB-01 a INB-04         | Implementada no contrato n8n v1                                                                                |
| Agente vendedor    | AGT-01 a AGT-10         | Implementado; AGT-09..10 aguardam implantação e publicação do `mvp-simple-20` (ADR 052)                        |
| Pedido             | ORD-01 a ORD-05         | Pedido e impressão v5 implementados; encaminhamento e assinatura física pendentes                              |
| Mensagens e canais | MSG-01 a MSG-04         | WhatsApp: homologação pendente; Instagram em CANAL-2                                                           |
| Financeiro         | FIN-01 a FIN-03         | Confirmados e valor vendido implementados; UAT pendente                                                        |
| Privacidade        | PRV-01 a PRV-03         | Coberta no contrato; homologação pendente                                                                      |
| PIX e boas-vindas  | PAY-01 a PAY-05         | Diferidos pela ADR 006; datas manuais não implementam cobrança                                                 |
| Painel por papel   | PNL-01 a PNL-06         | PNL-01..03 cobertos em `ux/jornadas` (T130, `069ae76`); PNL-04 adiado pelo PO (D3, T131); PNL-05..06 em PNL-T05 |
| Saúde e erros      | OPS-ERR-01 a OPS-ERR-11 | Central restrita à conta operadora; implementação e gates em OPS-ERR-T01, OPS-INBOX-ACK-04 e OPS-INBOX-SEND-08 |

**Cobertura:** 47 IDs preservados, incluindo 5 PAY diferidos e o PNL-04 adiado; implementação, homologação e aprovação externa têm estados distintos. Essa cobertura não representa aprovação humana dos gates operacionais. A decomposição em tarefas pertence ao Tech Lead.

### Evidência do Painel por papel (RFC 024, T133)

E2E em `test/e2e/dashboard-next-step.spec.js` e unitários em
`test/dashboard-format.test.js`, citados pelo título. "Coberto" quer dizer
que o teste existe em `ux/jornadas`; vira "Verified" com o gate completo do
PR para o `master`.

| ID     | Tarefa | Evidência                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| PNL-01 | T130   | `dashboard-next-step.spec.js` “the seller sees one next step on the phone and opens it by keyboard”, “the manager starts from the SLA and the period says it is for Vendido”, “with nothing pending the next step is calm text, without a link” e “the seller queue failure says the step could not be read”; `dashboard-format.test.js` “Painel: the seller next step follows the priority of the queue”, “Painel: the manager next step starts from the SLA”, “Painel: with the queue failing, the next step invents nothing” e “Painel: no next step link is named like an indicator” | Coberto, com divergência (ver abaixo) |
| PNL-02 | T130   | `dashboard-next-step.spec.js` “the manager starts from the SLA and the period says it is for Vendido”; `dashboard-roles.spec.js` “the manager reads the day first, with the period on the server”                                                                                                                                                                                                                                                                                                                                                                                        | Coberto em `ux/jornadas`              |
| PNL-03 | T130   | `dashboard-next-step.spec.js` “a failing queue keeps Atendimento with dashes and retries by keyboard” e “the seller queue failure says the step could not be read”                                                                                                                                                                                                                                                                                                                                                                                                                       | Coberto em `ux/jornadas`              |
| PNL-04 | T131   | Sem implementação: adiado pelo PO (D3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Adiado                                |
| PNL-05 | PNL-T05 | `orders-summary.test.js` “PNL-05: "Vendido por dia" is the last seven São Paulo days, today last, whatever the period”; `dashboard-format.test.js` “Painel: the week by day labels each day and speaks every value”, “Painel: a week without sales is a flat baseline, a failed read has no bars” e “Painel: bar values are compact reais”; `test:orders:live` | Coberto |
| PNL-06 | PNL-T05 | `operation-runtime.test.js` “PNL-06: only a COMMERCIAL_ADMIN reads who has conversations unanswered for 15 minutes”; `dashboard-format.test.js` “Painel: "Atendimento agora" links three rows into the Inbox”, “Painel: a failed queue reads "—" in every attendance row, never "0"” e “Painel: the manager hears about a late seller right after the SLA”; `dashboard-next-step.spec.js` “PNL-06: a seller with unanswered conversations opens the Inbox on their conversations”; `test:operation-read:live` | Coberto |

Divergência de PNL-01: com a fila em falha, o cartão do gestor pula as
condições que dependem da fila e mostra a próxima que conseguiu ler (por
exemplo, "Conferir 2 entregas atrasadas"), e o do vendedor sem outra
pendência diz "A fila não respondeu; tente de novo mais abaixo.", com o
"Tentar novamente" na seção da fila, não no cartão. O critério pede que o
cartão não pule a condição e traga "Tentar novamente". Nunca diz "Nada
urgente agora" sem ter lido a fila. Registrado como pendência no
[RFC 024](../../../docs/rfc/024-jornadas-com-menos-botoes.md#pendências-após-o-rfc-024),
para decisão do PO: emendar o critério ao comportamento entregue ou ajustar o
cartão.

## Critério de passagem

**GO de produto.** P0.1 a P0.7 estão resolvidos e rastreados em `PRODUCT-READINESS-TECH-LEAD.md`. O Tech Lead possui o caminho completo para produzir desenho técnico, tarefas e estimativas sem depender de nova decisão de produto. Esse GO não é um GO operacional e não libera fases sujeitas a gates humanos.

Em 02/09/2026, a T00.6 foi aprovada na issue `#10` e deixou de bloquear T02, T03 e T05.

A fonte humana está versionada em `docs/phase0/T00.6-APPROVAL-EVIDENCE.md`;
`docs/phase0/PHASE-0-APPROVAL-GATE.md` descreve o gate aprovado e
`docs/phase0/domain-decisions.json` é o espelho executável fail-closed. Os
papéis usam `silmer:romulo.sutil` e exceção de operação solo limitada ao piloto interno. Esse registro histórico não comprova controles de autenticação ou segregação do runtime atual.

Essa aprovação remove apenas o bloqueio da T00.6; os demais gates técnicos,
externos e operacionais continuam independentes.

## CHAN-WA-01 — Atendimento no WhatsApp

Aprovado pelo proprietário em 27/10/2026; ADR 044. Site/linktree Instagram
SHALL encaminhar por link acessível Falar no WhatsApp, sem formulário, IA ou
abertura de pedido. O webhook antigo SHALL retornar orientação fixa antes
do CRM/IA. O agente SHALL transferir mochilas/bolsas e duas intenções de
pedidos explicitamente separadas sem agregar/projetar dados. Guard de
segurança publicado SHALL ser preservado; confirmação segue humana.
A loja mantém checkout. Nenhum clique SHALL unir identidades/históricos.

A desistência explícita SHALL interromper a coleta e seguir para humano,
sem alegar encerramento/cancelamento executado ou criar/projetar rascunho.
Correções de produto/cor/quantidade não são desistência do atendimento.
O próximo campo SHALL seguir o ritmo do workflow mesmo quando o modelo
perguntar outro campo pendente ou já preenchido.
