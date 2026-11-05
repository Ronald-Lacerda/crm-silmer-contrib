# Central de ações e desempenho comercial

Status: implementação autorizada em 05/11/2026 após aprovação do protótipo
refinado. [RFC 044](../../../docs/rfc/044-performance-comercial-e-central-de-acoes.md)
e [ADR 059](../../../docs/adr/059-central-de-acoes-e-performance-comercial.md).
Complementa FIN-01–03, PNL-01–04, PLA-04–12 e FINQ-04/18/19.

## Central do vendedor — ACT-01–12

1. **ACT-01 — Universo:** API fornece objetos reais do responsável autenticado:
   conversas humanas abertas a responder, handoffs disponíveis, pedidos próprios
   a completar e confirmados de atendimento não teste com quitação/entrega sem
   confirmação. Um pedido com duas conferências conta uma vez; contagens
   refletem objetos do filtro, sem limite silencioso ou total inventado.
   Na primeira dobra sintética de 5 objetos, orçamento de controles do vendedor:
   9 a 390×844 e 14 a 1366×768; inclui os 4 filtros e os próprios objetos
   selecionáveis. Substitui o orçamento anterior do painel informacional.
2. **ACT-02 — Composição:** fila compacta e detalhe por seleção no shell Vue
   vigente; no celular, uma região por vez e volta previsível à fila. Identidade,
   contexto, motivo e espera/prazo orientam a ação. Marca, tokens e temas atuais
   permanecem. Não há seletor de perfil ou dados de demonstração no produto.
3. **ACT-03 — Evidência:** falta de registro não comprova inadimplência ou
   ausência física de entrega. Mostrar perguntas de conferência e prazo
   prometido, quando existir; não declarar pagamento vencido sem prazo.
4. **ACT-04 — Confirmações:** quitação exige declaração literal de recebimento
   integral e data válida até hoje em São Paulo. Entrega recebe o dia de São
   Paulo no servidor. Ambas exigem confirmado de atendimento, não teste, humano
   responsável/admin, versão, idempotência e auditoria. Uma preserva a outra;
   não muda valor, status, snapshot ou quantidade de vendas. Entrega passa a
   cobrir pedidos de conversa e manuais, emendando PLA-10/11 e ADR 039.
5. **ACT-05 — Lembretes:** snooze/schedule/resume/dismiss persistem por pessoa e
   objeto no PostgreSQL existente, com versão própria, versão do alvo e revisão
   da mensagem. Transferência, fechamento ou nova demanda invalidam decisão
   obsoleta; adiado vencido volta à fila. Adiar não resolve obrigação do pedido.
6. **ACT-06 — Retomada:** após 48h sem resposta à última saída humana enviada,
   pode aparecer sugestão em conversa própria humana, aberta e não arquivada.
   Não inventar compromisso, perda ou desinteresse. Saída falha/desconhecida
   não fundamenta sugestão nem pode esconder cliente que ainda espera. Retorno
   agendado exige decisão humana; não inferir promessa do conteúdo do chat.
7. **ACT-07 — Atendimento:** responder/preparar abre Inbox real, sem composer
   paralelo, autoenvio ou retorno ao bot. Assumir usa autorização/versões atuais.
   Dispensar só remove sugestão daquela revisão; não encerra conversa/pedido.
8. **ACT-08 — A11y:** teclado, nomes/estados acessíveis, contraste claro/escuro,
   toque de 44 px, reflow a 320 px e foco previsível em seleção/volta/erro/sucesso.
9. **ACT-09 — Falhas:** erro fica na região afetada com retry; sem dados não há
   falso zero ou nada urgente. Dados antigos são identificados como possivelmente
   desatualizados. Falha de comando mantém contexto e rascunho, sem falso sucesso.
10. **ACT-10 — Papéis:** vendedor vê sua fila/desempenho; admin consulta equipe
    e indicadores anteriores. Aviso da loja, acesso ao agente e login vigente
    permanecem. Financeiro não herda acesso; actorId forjado é recusado na API.
11. **ACT-11 — Atualização:** SSE/retorno de comandos atualizam sem trocar a
    versão/valor capturados por formulário aberto. Valor novo após abrir quitação
    exige revisão consciente; não aproveita checkbox antigo. 409 pede atualizar.
12. **ACT-12 — Segurança:** leitura privada/no-store; sessão/CSRF/origem nas
    mutações; revalidar autorização/fences sob transação, efeito único e auditoria
    sem conteúdo pessoal. Sem Negócio, store global ou domínio em window. Não
    oferecer undo financeiro genérico: correções seguem o detalhe autorizado.

## Desempenho — PERF-01–08

1. **PERF-01:** capturar responsável comercial na confirmação, separado do
   executor. Preservar em transferência/reconfirmação. Histórico sem evidência
   fica sem atribuição; não reconstruir vendas com o dono atual da conversa.
2. **PERF-02:** 7/30 dias civis até hoje em São Paulo. Receita/pedidos/ticket
   usam confirmados não teste pela data comercial. Reabertura retira do total
   atual; reconfirmação não duplica. Não calcular recebimento ou lucro.
3. **PERF-03:** contar ciclos distintos com resposta humana efetivamente
   enviada, tomadas humanas claim/takeover, encerramentos por autor/instante
   e ciclos com ao menos uma venda elegível. Encerramento não prova venda;
   mensagens e múltiplos pedidos não inflam conversas. Queued/failed/unknown,
   bot e notificações administrativas não contam como atendimento humano.
4. **PERF-04:** preservar autoria de contas inativas. Uma conversa pode contar
   na atividade de duas pessoas; não somar isso como total único da empresa.
5. **PERF-05:** loja e sem atribuição ficam separados; soma financeira reconcilia
   com total. Mostrar cobertura histórica e limites da atribuição.
6. **PERF-06:** sem nota única/ranking punitivo/conversão por denominador de
   outra coorte. Coortes, expediente e índices calibrados seguem como evolução.
7. **PERF-07:** API permite apenas linha própria ao vendedor e conjunto ao
   administrador ativo, mesmo se URL/parâmetros forem manipulados.
8. **PERF-08:** painel e checkpoint usam a mesma apuração, datas e critérios,
   com provas de limite de período, reabertura e reconciliação.

## Checkpoint — CHK-01–08

1. **CHK-01:** workflow n8n dedicado às 08h todos os dias, America/Sao_Paulo,
   referente ao dia civil anterior. Dia sem vendas gera resumo com zero.
2. **CHK-02:** API calcula totais e valores por vendedor, loja e sem atribuição;
   n8n não acessa banco nem usa IA para somar/escrever valores.
3. **CHK-03:** preparar persiste snapshot cifrado imutável com data, versão e
   corte; alterações posteriores não reescrevem enviado. Preview sem snapshot
   é identificado como prévia atual.
4. **CHK-04:** os dois destinos autorizados ficam em configuração privada.
   Telefone não aparece no Git, logs ou resposta humana. Só reserva técnica
   libera destino necessário; sem clientes/comprovantes/pedidos individuais.
5. **CHK-05:** capacidade técnica dedicada dashboard.checkpoint.execute, Basic
   Auth e esquema estrito. Preview/status humano só admin; flag off nega envio.
6. **CHK-06:** reserva transacional única por snapshot/destino antes do efeito.
   Replay não concede autorização; resultado desconhecido não permite retry
   cego. Falha de um destino não repete o envio do outro.
7. **CHK-07:** resultado guarda referência/status mínimo, sem payloads do
   provider. Aceitação não prova entrega. Timeout ambíguo exige reconciliação;
   falha de consulta de destinatário bloqueia antes do envio.
8. **CHK-08:** UI mostra configuração, resultado por destino e preview autorizado.
   Workflow não salva execuções com dados pessoais. Configuração/publicação e
   entrega real são gates operacionais separados dos testes locais.

## Verificação e fronteiras

Cobrir positivos, negativos e concorrentes: pagamento×entrega, legado, novo
valor, transferência×decisão, nova mensagem, fechamento, replay, snooze vencido,
prazo ausente, loja, teste, outra conta, Financeiro, CSRF, snapshot repetido,
falha parcial e timeout. Testes live usam somente dados sintéticos.
Não inclui cobrança InfinitePay da RFC 045, novo status comercial, coortes ou
follow-up automático. PNL-01–03 ganham a composição desta central; PNL-04 não
altera o destino atual do login.
