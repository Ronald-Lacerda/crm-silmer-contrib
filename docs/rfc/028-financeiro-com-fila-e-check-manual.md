# RFC 028 — Financeiro com fila e check manual

Status: decidida em 21/10/2026 na
[ADR 040](../adr/040-financeiro-com-fila-e-check-manual.md).
Responsável: Tech Lead. Decisor de produto: PO, nesta conversa.
Requisitos: [FINQ-01–15](../../.specs/features/financeiro/spec.md).
Tarefas: [FINQ-PLAN-01, FINQ-T01–T06](../../.specs/features/financeiro/tasks.md).
Issue/PR: não há vínculo específico nesta etapa documental.

## Contexto e opções avaliadas

A pessoa do Financeiro executa sua rotina manualmente no ERP Olist, antigo
Tiny, plano Crescer. O CRM atual aceita Vendedor como única função operacional;
criar uma conta de vendedor para ela abriria atendimento e ações fora do escopo.
O pedido comercial continua tendo apenas pendente e confirmado.

Foram discutidos check manual, envio assistido do pedido ao Olist e emissão
via API. O PO escolheu começar somente com fila e check manual; integração
fica para outra fase. Também escolheu a composição **Fila e detalhe**, em vez
da alternativa Conferência ampla, e determinou preservar o design já existente.
O desenho da conversa aprova organização/interação, não um redesign do produto.

## Resultado aprovado

- Pedido pago significa valor integral recebido; também precisa estar
  confirmado e fora dos testes. A fila abrange todos os vendedores e origens.
- “Nota criada” é a declaração humana de rotina concluída, com autoria e
  horário; não é confirmação automática da Sefaz ou do Olist.
- Financeiro abre sua própria fila, com Aguardando/Concluídos e detalhe de
  consulta; apenas Financeiro e Minha conta aparecem em seu shell.
- Conclusão e reversão são separadas do status comercial e preservam auditoria.
- O perfil tem autorização própria na API, sem acesso herdado de Vendedor.
- Shell, marca, temas, tokens, tipografia e componentes atuais são obrigatórios,
  conforme design.md e ADRs 035/036; a lista lateral é adaptada no celular.

## Impacto, premissas e ações

Especificar a evolução de identidade e constraints sem alterar a política
vigente nesta entrega. Reutilizar “Pago em” como registro de quitação integral,
com revisão do significado dos dados legados antes da ativação. Comandos
financeiros precisam de sessão, CSRF, versão, idempotência, auditoria transacional
e revalidação de elegibilidade. Não criar conciliação, parcelas, novo status de
pedido, infraestrutura ou acesso n8n para concluir a rotina.

A aceitação é materializada nos requisitos FINQ e em tarefas abertas de
schema/ACL, domínio/API, composição visual, interação acessível, QA e ativação.
O pedido atual autoriza **apenas documentação**; nenhum código, migração,
conta real ou integração é implementado por este registro.
