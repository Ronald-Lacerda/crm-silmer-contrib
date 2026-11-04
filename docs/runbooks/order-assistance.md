# Abertura assistida de pedidos

Contrato: [OA-01–12](../../.specs/features/order-assistance/spec.md),
[ADR 056](../adr/056-abertura-de-pedido-com-confirmacao-humana.md).

O pedido de atendimento é criado somente pelo vendedor responsável/admin,
após confirmação de fechamento. A coleta anterior permanece na conversa.
Pedido já existente não é apagado nem cancelado por esta mudança.

## Implantação e verificação

1. Aplicar `0053_order_assistance.expand.sql` pelo migrador existente antes
   de subir a API que consulta as tabelas novas. Não alterar migrações aplicadas.
2. Publicar a aplicação GitHub → EasyPanel, preservando credenciais, volumes,
   domínios e configuração operacional. Confirmar CI, commit/imagem, migration,
   `/healthz` e `/api/health/ready` nos serviços existentes.
3. Exportar o workflow principal ativo para backup privado; aplicar somente
   o patch de abertura assistida. Preservar IDs, credenciais, transporte
   Evolution, webhooks e nós de outras integrações. Não publicar export sanitizado
   inteiro sobre produção. Revisar diff antes de importar/publicar.
4. Confirmar no inbound `order_opening_policy = human_confirmation` e
   `order_assistance.enabled = true`. A atualização do workflow só usa a nova
   análise quando a API anuncia suporte. Execuções mantêm retenção `none`.
5. Em conversa sintética isolada, produto/preço não criam Pedido. Compra
   explicitamente confirmada durante atendimento humano sugere internamente.
   Aceitar cria um pendente; repetir a ação não duplica. Não enviar canário a
   cliente real. Confirmar adiamento, recusa, omissão e métricas administrativas.

## Diagnóstico

Na Inbox, revisar a evidência antes de decidir. Nova mensagem, mudança de
responsável/epoch ou alteração da sugestão pode exigir atualização. Um conflito
nunca deve ser contornado com retries cegos. Mais de um assunto exige alvo
correto; não escolher o último pedido automaticamente.

No painel Desempenho, distinguir análises recebidas, falhas e sugestões. Zero
sugestões sem análises não comprova que o agente avaliou todas as conversas.
Se o observador chega ao nó de registro e não há análises, verificar o status
da API antes de recarregar o workflow. A autenticação real entrega
`technical.actor` como objeto com `id = AUTOMATION_EXECUTOR`; o serviço aceita
esse principal e a representação legada em string. O teste OA-T02 atravessa
Basic real, rota, runtime n8n e serviço para impedir regressão de `403`.
Conferir metadados de nós e códigos de resposta sem persistir payloads nem
habilitar retenção de execuções com dados de clientes.
Se a análise existe, mas a mensagem não aparece na lista, conferir o ciclo
aberto e `archived_at`. Uma entrada nova via n8n remove o arquivamento no
mesmo commit da mensagem; replay não desfaz arquivamento posterior. Conversas
afetadas antes dessa correção precisam de desarquivamento humano autorizado
ou de nova mensagem; não alterar estado diretamente no banco para repará-las.
Pedidos manuais sem sugestão são candidatos a revisão, não falsos negativos
comprovados. “Já deveria ter sugerido” é rotulagem humana. Janela e limites
permanecem explícitos; conteúdo da conversa não entra em agregados/logs.

## Rollback

Preservar tabelas, envelopes e decisões. Restaurar o workflow a partir do
backup privado é possível com a API nova: pedidos antigos continuam bloqueados
pela política humana e recebem `awaiting_human`, sem falso ORDER_OPEN_FAILED.
Antes de voltar uma API anterior à ADR 056, suspender a criação automática
no workflow ou manter o guard de confirmação humana. Não reintroduzir pedidos
fantasmas como efeito colateral de rollback. Não restaurar o banco por este
motivo nem apagar pedidos ou registros de avaliação.
