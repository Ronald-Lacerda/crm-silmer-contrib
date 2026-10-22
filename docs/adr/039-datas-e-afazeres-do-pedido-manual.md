# ADR 039 — Datas e afazeres do Pedido manual

Status: aceita em 21/10/2026. Decisor de produto: PO, solicitação desta sessão.
RFC: [027](../rfc/027-datas-e-afazeres-do-pedido-manual.md).
Requisitos: [PLA-02, PLA-04, PLA-10–PLA-12](../../.specs/features/pedidos-mvp/spec.md).
Tarefa: [T136](../../.specs/features/pedidos-mvp/tasks.md).
Supersede parcialmente a [ADR 008](008-lastro-de-datas-do-pedido.md) para
Pedidos manuais sem conversa; complementa a [ADR 032](032-separar-pedido-conversa-e-assunto.md).
Issue/PR: vinculados na entrega quando existentes; não há issue específica.

## Contexto

Sem conversa, o Pedido manual ficava sem Primeiro contato. Digitar a data de
entrega não representa a pergunta operacional pedida pelo PO ao responsável.

## Decisão

1. Primeiro contato do manual sem conversa é o mesmo instante da criação.
   Legados nulos recebem `created_at`, sem reescrever snapshots confirmados.
2. Só pagamento é digitável nesses pedidos. O PATCH preserva a entrega e
   rejeita sua digitação. Pedidos de conversa e loja mantêm seus contratos.
3. Os afazeres do Dashboard são derivados dos pedidos manuais confirmados,
   não teste, sem entrega e do responsável autenticado; incluem pedidos sem
   prazo ou com prazo futuro, ordenados por prazo e número. Não se reutiliza
   o domínio de tarefas do Negócio aposentado nem se cria scheduler.
4. Marcar “O pedido NN-CRM já foi entregue?” envia comando humano com ACL,
   versão, idempotência e auditoria. O servidor registra o dia de São Paulo,
   preservando pagamento, status e snapshot. O afazer desaparece e o foco vai
   ao próximo ou ao título da seção. Falhas e conflitos ficam explícitos.
5. A entrega registrada não pode ser substituída por repetição. Não há novo
   status, alteração dos templates, envio de mensagem ou infraestrutura.

## Consequências

O próprio pedido continua sendo a fonte da entrega. O vendedor declara o
recebimento e o relógio do servidor determina a data registrada; não se permite
retroagir ou limpar essa data no formulário. Datas anteriores são preservadas.
Rollback não apaga auditoria nem datas e exige compatibilidade do PATCH entre
frontend e API. [TECHNICAL-DESIGN.md](../../TECHNICAL-DESIGN.md) descreve as rotas.
