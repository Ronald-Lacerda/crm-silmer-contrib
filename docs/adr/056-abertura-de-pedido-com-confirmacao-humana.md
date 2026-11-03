# ADR 056 — Abertura de pedido com confirmação humana

Data: 03/11/2026. Status: aceita pelo proprietário nesta conversa.
Proposta: [RFC 043](../rfc/043-abertura-assistida-de-pedidos.md).
Requisitos OA-01–12 / tarefa OA-T01: [spec](../../.specs/features/order-assistance/spec.md)
e [tarefas](../../.specs/features/order-assistance/tasks.md).

## Decisão

1. A confirmação explícita do cliente de que quer fechar a compra permite
   sugerir a criação. Somente humano responsável ou administrador cria o
   Pedido do atendimento. Dados da ficha, consulta de preço, orçamento,
   silêncio e disponibilidade presumida não autorizam criação automática.
2. O n8n acompanha as entradas durante o bot e o atendimento humano como
   analista interno, sem enviar mensagem nem retomar automação após takeover.
   O histórico continua vindo da API do CRM, sem memória paralela.
3. A sugestão identifica produto, origem e mensagem de evidência do cliente.
   Aceitar cria um `pendente` com a pré-ficha aplicável. Adiar ou recusar
   registra motivo. Pedido `confirmado` continua exigindo revisão comercial
   existente; loja paga preserva a exceção da ADR 028.
4. Epoch, revisão de entrada, versão da conversa, alvo e versão da sugestão
   impedem decisão obsoleta. API valida posse/admin, CSRF e idempotência;
   decisão, criação e auditoria compartilham transação. Alvo ambíguo exige
   esclarecimento humano; nunca mistura briefings de assuntos.
5. Observações e decisões ficam no PostgreSQL existente; conteúdo necessário
   é cifrado, e telemetria agrega códigos, contagens e tempos. Execuções n8n
   continuam sem persistência. Não usar tabelas de Negócio/estágio aposentado.
6. A Inbox permite marcar “Já deveria ter sugerido” com mensagem de evidência.
   Métricas separam sugestões, aceite, adiamento, recusa, demora, pedidos
   humanos sem sugestão, omissões anotadas e falhas de análise. Nenhuma dessas
   contagens isoladamente representa todas as oportunidades perdidas.
7. `open_order` e `order.intent_confirmed` antigos não contornam o comando
   humano no runtime publicado. A resposta `awaiting_human` é resultado de
   negócio, separado de `ORDER_OPEN_FAILED` técnico, sem interromper respostas
   nem transferências do atendimento.

## Relação com decisões anteriores

Supersede a ADR 014 quanto ao marco e à autoria da abertura e PAB-01–03 /
PCL-01–03 nos comportamentos de criação automática. Conserva idempotência,
briefing, estados da ADR 006 e confirmação comercial humana. Complementa
ADRs 015, 032 e 052 sem permitir retorno ao bot ou inferência de alvo ambíguo.
Histórico e pedidos já existentes não são apagados ou reclassificados.

## Implantação

Migração aditiva, API/interface e workflow, nessa ordem. A aplicação anuncia a
capacidade ao n8n. Rollback deve preservar a barreira humana ou suspender a
criação pelo workflow antes de restaurar aplicação antiga. Evidências de
CI, versão publicada e saúde pertencem ao fechamento da entrega e ao
[runbook](../runbooks/order-assistance.md), não à aprovação desta decisão.
