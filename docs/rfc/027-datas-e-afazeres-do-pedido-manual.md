# RFC 027 — Datas e afazeres do Pedido manual

Status: decidida em 21/10/2026 na [ADR 039](../adr/039-datas-e-afazeres-do-pedido-manual.md).
Responsável: Tech Lead. Decisor de produto: PO, solicitação desta sessão.
Requisitos: [PLA-02, PLA-04, PLA-10–PLA-12](../../.specs/features/pedidos-mvp/spec.md).
Entrega: [T136](../../.specs/features/pedidos-mvp/tasks.md). Issue/PR: vinculados
na entrega quando existentes; não há issue específica.

## Contexto e pedido aprovado

O Pedido manual sem conversa não recebe Primeiro contato e permite digitar a
entrega. O PO pediu preenchimento automático do primeiro contato na criação,
apenas pagamento editável e uma lista de afazeres perguntando ao vendedor
responsável se o pedido já foi entregue. Marcar deve preencher a entrega.

## Alternativas e decisão

Manter a data digitável não atende ao pedido. Criar tarefas persistidas no
domínio legado de Negócio introduziria uma segunda fonte de estado e viola a
baseline. A recomendação adotada deriva a lista dos próprios pedidos manuais
confirmados, não teste, ainda sem entrega e pertencentes ao leitor. Não se
presume que prazo vencido significa entrega: inclui prazos futuros e ausentes,
e a pessoa marca somente depois de o cliente receber.

O servidor registra o dia de São Paulo, sob ACL, versão e idempotência. Não há
novo status ou infraestrutura. O responsável vê seus afazeres; a autorização
administrativa do comando continua disponível. Pedidos por conversa e loja
mantêm contratos. Datas de entrega existentes são preservadas; não haverá
edição ou limpeza da entrega manual por esse formulário.

## Impacto e ações

Backfill preenche somente primeiro contato nulo do manual com `created_at`;
não altera snapshots impressos. Novos manuais reutilizam o instante da criação.
Frontend/API do PATCH manual passam a aceitar somente pagamento. Documentar
rotas no OpenAPI e comprovar ACL, dia de São Paulo, repetição, concorrência,
preservação de pagamento e fluxo por teclado. Rollback não apaga dados e
precisa compatibilizar o PATCH ao voltar frontend/API juntos.
