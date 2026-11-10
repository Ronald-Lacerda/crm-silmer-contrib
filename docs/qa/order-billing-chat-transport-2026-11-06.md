# Composição e transporte de cobranças — COB-CHAT-B03

Backend implementado na worktree `codex/billing-chat-plan-review`, conforme
BAPI-07–10, RFC 047 e ADR 076. Frontend e ativação real continuam separados.

## Resultado

Callback financeiro preserva a URL cifrada e, com intenção válida, grava uma
mensagem humana, comando, outbox, auditoria e evento da Inbox na mesma
transação. Contexto inválido conserva o link e registra bloqueio. O transporte
reutiliza a fila humana existente e revalida a intenção na entrega, reserva
única e preflight imediatamente anterior ao HTTP externo.

Migração expand 0064 projeta estados reais em eventos append-only. Entrega
confirmada não regride por incerteza tardia. Retry humano exige falha provada
antes do efeito, sem ID externo, mesmo link válido e comando novo; efeito
incerto não autoriza outra tentativa. Nenhuma atribuição de responsável,
mudança de epoch ou função simulada é introduzida pela composição.

## Evidências locais

- PostgreSQL 17 dedicado e sintético, Node 24.20.0: 13/13 cenários novos de
  composição/reserva/preflight/recuperação, em
  `test/order-billing-send-postgres-live.test.js`.
- Regressão B02 16/16, emissão financeira 15/15 e Financeiro 10/10: junto
  dos 12 cenários iniciais novos, a execução serializada teve 53/53 aprovados.
  O cenário adicional de interleaving passou na rodada final de 13/13.
- HTTP preflight: 10/10, incluindo autenticação, identidade técnica,
  projeção estrita, erro seguro e recusa de seletores/HEAD.
- Workflow offline: cinco cenários novos e 48 regressões Evolution,
  53/53 aprovados. Command store/stream: 28/28 aprovados.
- Regressão PostgreSQL adicional de Inbox, n8n, command store, migrações e
  pedidos da loja: 32/32 aprovados. Somada à matriz financeira e ao novo
  interleaving, são 86 cenários PostgreSQL distintos aprovados.
- Correção B05 posterior à revisão: 15/15 na suíte de transporte, incluindo
  invalidação única e privada da Inbox e falha do evento com rollback de
  pagamento/mensagem/intenção e reentrega bem-sucedida. Total atualizado: 88.
- Gate integrado na worktree: `npm run validate` passou com 1.801 aprovados,
  17 skips condicionais, typecheck, lint, boundaries, inventários e build.
  Skips não substituem a execução PostgreSQL acima. O aviso de chunk do
  frontend é preexistente; nenhum arquivo de interface foi alterado.

Logs locais ignorados em `var/billing-b03-*.log`. Não são prova operacional
de EasyPanel, n8n remoto ou conta InfinitePay.

## Revisão adversarial

Revisão Backend/QA independente identificou e encerrou:

- Pagamento durante envio: bloquear proativamente apenas `waiting_link` e
  `queued`; envio em andamento mantém seu resultado reconciliável. Teste
  confirma pagamento após preflight seguido de callback real `sent`.
- Descoberta de nova intenção após locks financeiros: trava transacional por
  pedido antecede descoberta, inclusive com zero intenções, e admissão usa a
  mesma trava. Teste força o interleaving, verifica espera em `pg_locks` e
  termina sem deadlock ou mensagem depois do pagamento.
- Mensagem sem contexto: composição inclui número do pedido, natureza,
  valor e link. Todos permanecem cifrados no armazenamento.
- Falha de entrega não prova falha anterior ao envio: contrato explicita a
  diferença e backend mantém a prova necessária para retry.

Revisão de transporte confirmou execução original em callbacks tardios,
monotonia e recusa de texto no endpoint de mídia. Verificador final do
backend B01–B04 identificou a ausência de invalidação em bloqueios proativos;
B05 acrescenta `conversation.message_delivery_changed` somente quando a
mensagem muda efetivamente, na mesma transação. Nova verificação independente
aprovou 15/15 cenários e detectou a remoção dessa publicação em uma cópia
isolada. Relatório final em [validação](../../.specs/features/order-billing/validation.md),
com os seis mutantes detectados e a árvore real preservada.

## Limites

Não houve chamada de envio ou pagamento real, publicação de workflow,
alteração de ambiente remoto ou habilitação de flag. CLI de patch gera
somente candidato local e preserva credenciais privadas. Frontend será
retomado após o redesign. Homologação real continua em COB-OPS-01.
