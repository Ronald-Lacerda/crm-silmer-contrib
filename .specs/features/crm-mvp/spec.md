# CRM Silmer MVP — Requisitos Rastreáveis

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
2. **INB-02:** WHEN o agente recebe dados da ficha que indicam pedido THEN o n8n SHALL solicitar criação ou atualização de um único Pedido pendente por conversa, conforme ADRs 006 e 014.
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
REV-06 continuam valendo. Nada aqui muda API, contrato de dados ou migração: o
Painel usa os resumos que já lê. Tarefas T130 e T131 em
[Pedidos MVP](../pedidos-mvp/tasks.md).

**Critérios de aceite:**

1. **PNL-01:** WHEN um vendedor ou um gestor abre o Painel THEN o topo SHALL
   mostrar um único cartão "Próximo passo", com uma frase e um link para a
   lista já filtrada, escolhido pela primeira condição verdadeira na ordem do
   papel. Vendedor: conversas suas a responder → conversas aguardando vendedor
   para assumir → seus pedidos pendentes a completar → entregas atrasadas →
   "Nada urgente agora", sem link. Gestor: conversas fora do SLA (Esperando
   vendedor) → entregas atrasadas → agente parado → pedidos a confirmar. WHEN
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

| Grupo              | IDs             | Status                                                                                   |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| Orquestração n8n   | ORC-01 a ORC-09 | WhatsApp implementado; homologação pendente; ORC-09 em CANAL-2                           |
| Inbox e conversão  | INB-01 a INB-04 | Implementada no contrato n8n v1                                                          |
| Agente vendedor    | AGT-01 a AGT-08 | Implementado; publicação pendente                                                        |
| Pedido             | ORD-01 a ORD-05 | Pedido e impressão v5 implementados; encaminhamento e assinatura física pendentes        |
| Mensagens e canais | MSG-01 a MSG-04 | WhatsApp: homologação pendente; Instagram em CANAL-2                                     |
| Financeiro         | FIN-01 a FIN-03 | Confirmados e valor vendido implementados; UAT pendente                                  |
| Privacidade        | PRV-01 a PRV-03 | Coberta no contrato; homologação pendente                                                |
| PIX e boas-vindas  | PAY-01 a PAY-05 | Diferidos pela ADR 006; datas manuais não implementam cobrança                           |
| Painel por papel   | PNL-01 a PNL-04 | PNL-01..03 cobertos em `ux/jornadas` (T130, `069ae76`); PNL-04 adiado pelo PO (D3, T131) |

**Cobertura:** 45 IDs preservados, incluindo 5 PAY diferidos e o PNL-04 adiado; implementação, homologação e aprovação externa têm estados distintos. Essa cobertura não representa aprovação humana dos gates operacionais. A decomposição em tarefas pertence ao Tech Lead.

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
