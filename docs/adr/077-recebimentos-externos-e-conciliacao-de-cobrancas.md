# ADR 077: recebimentos externos e conciliação de cobranças

Data: 08/11/2026. Status: aceita por autorização explícita do proprietário.
RFC: [060](../rfc/060-recebimentos-externos-e-conciliacao-de-cobrancas.md).
Requisitos: [BFIN-01–08, BFUI-01–06, BDEV2-01–04](../../.specs/features/order-billing-completion/spec.md).
Tarefas: [T0–T6](../../.specs/features/order-billing-completion/tasks.md).
Relacionada ao [PR 298](https://github.com/romulosutil/crm-silmer/pull/298).

## Decisão

Acrescentar livro de recebimentos externos por pedido no PostgreSQL atual,
sem fabricar transações/cobranças InfinitePay. As duas fontes compõem o saldo,
a quitação, o histórico e as guardas de envio. Autor/data efetiva/registro são
distintos. Reversão integral auditada corrige o lançamento sem movimentar
dinheiro. Acesso segue responsável/Admin ativo; Financeiro não herda gestão.

Consultas de pagamento têm intenção durável e candidato cifrado no CRM.
Worker/n8n verificam payment_check e usam callback financeiro idempotente.
Consulta/reentrega nunca cria checkout nem mensagem. Rechecagem periódica é
limitada a candidatos conhecidos; identificadores ausentes exigem conferência
no provedor. n8n continua sem acesso direto ao banco CRM.

Implementar a UI real no redesign já existente, compartilhando operação entre
Inbox/Pedido. DEV interativo e transporte n8n simulado precedem homologação.
Não ativar flags, workflow, pagamento ou envio de produção nesta entrega.

## Contexto e consequências

Complementa ADRs058/066 e supersede sua limitação de crédito apenas pelo
gateway para pedidos geridos. Mantém os dois status comerciais, separação
pagamento/transporte, autoria, ACL, idempotência e auditoria. Alterações de
acordo invalidam aplicação de ambas as fontes; recebimentos tardios/excedentes
requerem revisão sem saldo negativo. Links enviados não são considerados
cancelados ao registrar dinheiro externo. O checkout da loja é preservado.

Um novo livro e seu agregado exigem migração expand e revisão de todas as
guardas de saldo/Financeiro. A alternativa de mudar Pago em não oferece lastro;
NSU fictício mistura proveniência. Nenhuma nova infraestrutura de produção.

Registro renumerado de067 para077 na integração de09/11/2026 com a master; conteúdo decisório preservado. A migração inédita relacionada passa a0075 e a proposta paraRFC060.
