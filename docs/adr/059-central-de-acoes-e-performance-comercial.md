# ADR 059 — Central de ações e performance comercial

Data: 05/11/2026. Status: aceita por aprovação explícita do protótipo refinado
e pedido de implementação. Proposta: [RFC 044](../rfc/044-performance-comercial-e-central-de-acoes.md).
Contrato: [ACT-01–12, PERF-01–08 e CHK-01–08](../../.specs/features/dashboard-actions/spec.md).
Tarefa: ACT-T01; ativação/homologação separadas em ACT-T02.
Entrega: [branch de implementação](https://github.com/romulosutil/crm-silmer/tree/codex/dashboard-central-actions)
e [evidência QA](../qa/dashboard-central-2026-11-05.md).
Numeração 057/058 reservada às entregas concorrentes existentes.

## Decisão

Evoluir o Dashboard para fila compacta e detalhe de providências reais do
vendedor, no shell Vue existente. Registrar pagamento integral e entrega são
decisões humanas distintas do fechamento comercial. Ampliar a confirmação de
entrega para pedidos de atendimento confirmados, não teste, manuais ou ligados
a conversa, do responsável ou administrador. Essa fronteira supersede a
restrição a manuais de PLA-10/11 e ADR 039; entrega continua com dia de São
Paulo no servidor e não altera pagamento/status/snapshot.

Lembretes pertencem à pessoa e ao objeto, no PostgreSQL existente, com versão,
revisão e auditoria. Sugestão após 48h sem resposta à última saída humana
enviada é rotulada como sugestão; retorno agendado exige ação humana. Não
adotar tarefa de Negócio, autoenvio, outro chat ou retorno ao bot.

Capturar no banco o responsável comercial da venda na confirmação, separado
do executor, preservando a atribuição futura e declarando histórico sem
evidência como sem atribuição. Receita e atividade usam universos explícitos;
não adotar nota única nem conversão sem coorte correspondente.

O checkpoint usa a mesma apuração oficial, com snapshot cifrado imutável,
reserva por destino e resultado mínimo persistidos antes/depois do efeito.
n8n agenda e transporta pelo WhatsApp da Inbox sem acesso ao PostgreSQL. Uma
capacidade técnica dedicada não abre pedidos/relatórios genéricos. Destinos
privados e feature flag controlam envio; replay e resultado desconhecido não
autorizam segunda tentativa. Aceitação do provider não comprova entrega.

## Consequências e alternativas

Reutiliza infraestrutura, autenticação, idempotência e comandos autorizados.
Migrações expand e estado próprio permitem rollback de código pausando envio,
sem restaurar banco. Atribuição histórica incompleta permanece visível.
Não há undo genérico financeiro; correções usam o pedido e suas regras vigentes.

Uma lista de indicadores apenas informativos não resolve providências. Inferir
pagamento/entrega pelo fechamento ou encerrar pelo silêncio produziria fatos
falsos. Um chat/composer paralelo duplicaria a fronteira da Inbox. Retry direto
do workflow após timeout pode duplicar notificação. Essas alternativas foram
rejeitadas em favor de decisões explícitas, contexto e reserva durável.

Operação e rollback no [runbook](../runbooks/dashboard-central.md). O aceite
visual não comprova homologação remota ou entrega WhatsApp.
