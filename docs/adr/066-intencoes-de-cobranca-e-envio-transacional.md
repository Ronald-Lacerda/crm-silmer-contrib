# ADR 066 — Intenções de cobrança e envio transacional

Status: aceita para implementação de backend. Data: 06/11/2026.
Decisor: proprietário do produto, que aprovou o plano revisado e autorizou
seguir pelo backend nesta worktree. Frontend adiado até o redesign.

RFC: [047](../rfc/047-enviar-cobranca-pela-conversa.md).
Requisitos: [BAPI-01–10](../../.specs/features/order-billing/spec.md), COB-01–16.
Tarefas: [COB-CHAT-B01–B04](../../.specs/features/order-billing/tasks.md).
Base: [PR 298](https://github.com/romulosutil/crm-silmer/pull/298).
Complementa a ADR 058; não altera sua decisão nem o fluxo da loja.

## Decisão

O CRM persiste a intenção humana de gerar/enviar e compõe a fila financeira
com a fila de mensagens existente. A aba aberta não é necessária para
continuar o processamento. n8n financeiro não envia mensagens e não recebe
acesso ao banco. Não há fila, processo ou infraestrutura novos.

O [contrato HTTP](../api/order-billing-chat.md) distingue emitir, enviar link
existente, cobrar saldo calculado no servidor, corrigir e tentar novamente.
Estados de intenção, cobrança e recebimento são independentes. Admin atua
com capacidade real, mantendo o responsável atual e a autoria humana.

Corrigir conserva pedido, valor comercial total, links e recebimentos. Nova
cobrança por valor humano exige acordo explícito, anterior encerrada sem
pagamento, vencimento e conferência. Permite novo valor de cobrança em
centavos limitado ao saldo, como exceção explícita ao sinal percentual da
ADR 058, sem reescrever a cobrança original nem mudar preço comercial.
O provedor não cancela o link pela API. Pagamento tardio exige revisão.

Uma transação salva a URL e, conforme elegibilidade, enfileira mensagem ou
persiste bloqueio. Reserva final revalida contexto vivo. Resultado incerto
nunca autoriza repetição automática. Falha comprovadamente anterior ao envio
permite outra intenção humana para o mesmo link válido, com novo comando.

A implementação será entregue em fronteira HTTP, persistência, composição
com Inbox/reserva e integração operacional. Escrita permanece desativada por
padrão. Leitura, callbacks e conciliação permanecem disponíveis no rollback.
Nenhuma etapa de backend depende da aprovação visual do protótipo.

## Alternativas e consequências

Coordenar pelo frontend perde continuidade ao fechar a aba. Enviar pelo
workflow financeiro duplicaria as reservas e ACL da Inbox. Persistir no CRM
exige migration expand e composição transacional interna, mas mantém
idempotência, auditoria e recuperação nas fronteiras existentes.

As etapas ainda não entregues ficam pendentes nos tasks. Testes de contrato
com serviço sintético não comprovam comportamento PostgreSQL ou transporte.
Frontend/redesign, ativação remota e pagamentos reais têm gates separados.
