# ADR 040 — Financeiro com fila e check manual

Status: aceita em 21/10/2026; implementação futura, não iniciada nesta entrega.
Decisor de produto: PO, aprovação explícita nesta conversa.
RFC: [028](../rfc/028-financeiro-com-fila-e-check-manual.md).
Requisitos: [FINQ-01–15](../../.specs/features/financeiro/spec.md).
Tarefas: [FINQ-PLAN-01, FINQ-T01–T06](../../.specs/features/financeiro/tasks.md).
Issue/PR: não há vínculo específico nesta etapa documental.
Complementa ADRs 006, 035 e 036; o runtime atual continua usando a baseline
de identidade até a implementação da evolução descrita abaixo.

## Contexto

A rotina financeira é feita manualmente no Olist. A pessoa precisa saber
quais pedidos confirmados e integralmente pagos aguardam sua conclusão.
Dar-lhe Vendedor concederia acesso excessivo. Conclusão financeira não é
outro estado comercial nem pode ser inferida da autorização de uma nota fiscal.

## Decisão

1. Introduzir o perfil humano restrito Financeiro, com autorização própria
   no servidor, sem herdar Vendedor ou capacidade administrativa. Handoff
   continua exclusivo de Vendedor. Admin mantém a gestão de contas.
2. Derivar o universo dos pedidos confirmados, integralmente pagos e não teste,
   de qualquer vendedor e origem, usando “Pago em” para a quitação integral.
   A ativação exige revisar a semântica dos registros legados dessa data.
3. Usar a composição **Fila e detalhe**, Aguardando/Concluídos, com consulta
   dos dados necessários do pedido. O login do Financeiro abre seu painel;
   só Financeiro e Minha conta ficam disponíveis no shell existente.
4. Registrar “Nota criada” e reversão como controle financeiro separado,
   preservando autora, instante e histórico. Toda mutação aplica autorização,
   elegibilidade, versão, idempotência e auditoria transacional. Não muda
   snapshot, status, preço, pagamento, entrega ou travas da loja.
5. Manter o design atual: shell, componentes, tokens, marca configurável,
   tipografia, seleção neutra, temas e acessibilidade das ADRs 035/036 e de
   design.md. O mockup é referência funcional, não novo padrão visual.
6. Adiar toda integração Olist. A conclusão é declarada pela pessoa; não
   depende de API, nota autorizada na Sefaz, OAuth ou webhook.

## Consequências

A implementação futura amplia a identidade humana e as constraints
planejadas em ROLE-01/02/04 e USR-02, mantendo ROLE-03 (handoff Vendedor).
Requer contratos e testes próprios para leitura mínima e comandos financeiros;
não se pode liberar as rotas comerciais gerais ao novo perfil.

Pedido continua apenas pendente/confirmado; não há módulo de cobrança,
saldo, parcelas, conciliação ou nova infraestrutura. O histórico não é
apagado quando o pedido deixa de ser elegível. A política de pagamento/check
após reabertura, reconfirmação ou mudança comercial deve ser definida com
Produto na FINQ-T02 antes da implementação; não presumir quitação ou conclusão
válida para novo valor/revisão. Correções manuais mantêm toda a trilha.

O escopo aprovado é registrado agora. Código, migrations, contas e implantação
ficam nas tarefas abertas. As sínteses canônicas marcam essa distinção para
não apresentar o planejamento como capacidade já entregue.
