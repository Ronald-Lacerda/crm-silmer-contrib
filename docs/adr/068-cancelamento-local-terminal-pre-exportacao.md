# ADR 068 — Cancelamento local terminal pré-exportação

Data: 06/11/2026. Status: decisão técnica adotada para OLIST-T23, no escopo
autorizado da [ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md).
Decisores: proprietário do produto, pelo escopo aprovado na
[RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md), e Tech Lead,
pela implementação. Requisitos OLIST-19, 21, 30 e 45–47; tarefa OLIST-T23 no
[plano](../../.specs/features/crm-mvp/tasks.md). Entrega na branch `codex/olist-t23`,
com [diff de revisão](https://github.com/romulosutil/crm-silmer/compare/codex%2Folist-phase3...codex%2Folist-t23).
Complementa a ADR 057 e preserva os dois status da [ADR 006](006-pedido-dois-status.md).

## Contexto

Um Pedido pode deixar de seguir comercialmente antes de existir venda no ERP,
inclusive quando já foi pago ou tem a rotina financeira concluída. Reabrir ou
excluir não representa esse fato: altera o ciclo comercial ou destrói a
evidência necessária para consultar pagamento, ficha e ações anteriores.
O cancelamento também disputa a reserva de venda com o worker; uma leitura
anterior sem lock não garante que nenhum efeito externo tenha começado.

## Decisão

1. Usar marcador terminal `cancelled_at`, `cancelled_by` e
   `cancellation_reason_envelope` separado de `status`. O Pedido mantém
   `pendente` ou `confirmado`; a projeção `effectiveStatus` mostra `cancelado`.
   Não há restauração ou reabertura de cancelado nesta entrega.
2. Exigir motivo humano aparado de 1 a 1000 caracteres, sem caracteres de
   controle. O motivo usa o envelope AES-256-GCM existente, com AAD
   `order-cancellation:{orderId}`. Auditoria, evento e observabilidade carregam
   código e identificadores, sem motivo livre ou dados pessoais em claro.
3. Autorizar pela ACL comercial atual: responsável humano ativo pela conversa
   ou pelo Pedido manual, ou Admin ativo; Pedido da loja exige Admin ativo.
   Perfil Financeiro, automação e checkbox Olist não concedem cancelamento
   comercial. Validar função, grants e posse antes do replay e sob lock.
4. Executar `POST /orders/{orderId}/cancel` com sessão, Origin, CSRF,
   Idempotency-Key, `expectedVersion` e `reason`. Marcador, incremento da
   versão, invalidação das exportações ainda canceláveis, eventos, auditoria e
   recibo idempotente compartilham o mesmo client transacional. Falha em
   qualquer parte desfaz o conjunto. Mesma chave/corpo retorna o recibo;
   divergência conflita. Outra chave não cria novo cancelamento.
5. Ordenar locks por autoridade atual, conversa quando existir, Pedido e
   exportações em todas as contas, com ordem determinística. O worker reserva
   a venda sob o mesmo lock de Pedido. O cancelamento só vence antes da
   reserva; depois dela responde `ORDER_CANCELLATION_BLOCKED`.
6. Bloquear se houver venda exportada/vinculada, ID remoto observado,
   operação `reserved`, `uncertain`, `confirmed` ou `linked`, ou tentativa de
   venda cujo resultado não seja rejeitado. Não interpretar ausência de ID
   como prova de ausência de efeito. Recursos de cliente/produto/variação já
   criados ou em reconciliação permanecem, sem compensação destrutiva.
7. Proteger no banco a terminalidade e a preservação dos demais dados no
   cancelamento. Não alterar número, ficha, snapshots, confirmação, preço,
   pagamento, checkout, entrega, Nota criada ou seu histórico. Não excluir o
   Pedido nem criar outro automaticamente. O comando não tem porta de rede
   para cancelar ERP, gateway, estoque ou documento fiscal.
8. Excluir cancelados antes de contagens, somas e paginação dos universos
   ativos: vendas, valor vendido, peças, pendências, produção/entrega e
   Financeiro. O filtro comercial `cancellation` aceita `active` (padrão),
   `cancelled` e `all`, independente de status. Recalcular cada universo pela
   mesma seleção; não subtrair o cancelamento novamente de totais já filtrados.
9. Manter detalhe e histórico comerciais no escopo anterior. Financeiro
   consulta por ID os cancelados que satisfazem sua elegibilidade anterior,
   com `cancelledAt` e `canManage: false`; suas listas e comandos os excluem.
   Cancelar pago/loja não declara estorno, devolução, baixa ou quitação de
   obrigação fiscal e não modifica a InfinitePay.

## Alternativas e consequências

Um terceiro status foi rejeitado para preservar o contrato comercial aprovado.
Exclusão física perde rastreabilidade; reabrir conserva uma pendência ativa e
permite edição incompatível. Cancelar no ERP exige outro fluxo de negócio e
fica fora do escopo autorizado. O marcador separado exige filtros explícitos
nos leitores ativos e guardas nas mutações, com testes de paginação,
concorrência e preservação financeira.

A migration é aditiva no PostgreSQL existente, sem serviço, dependência ou
infraestrutura nova. Rollback preserva os marcadores, envelopes, históricos e
guardas; uma versão anterior só pode voltar se continuar respeitando a
terminalidade. T10 mantém a integração das demais guardas; UI, deploy e piloto
possuem gates próprios e não são comprovados por testes locais.

Contrato em [OpenAPI](../api/openapi.v1.yaml); operação e evidências no
[runbook da fase 3](../runbooks/olist-phase3.md). A RFC 050 registra a proposta
e o acompanhamento da entrega; esta decisão registra o desenho técnico da T23.
