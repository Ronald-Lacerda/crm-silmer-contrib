# ADR 079 Olist a partir do pedido confirmado

Data: 10/11/2026. Status: aceita pelo proprietário na solicitação de atualização
da especificação e das tarefas. Registro documental, sem ativação de runtime.

Proposta atualizada: [RFC 050 revisão 3](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Contrato: [OLC-01–16](../../.specs/features/olist-confirmed/spec.md).
Entrega documental: OLIST-PLAN-03. Implementação: OLC-T01–T06.
Sem issue/PR específica nesta etapa; registrar os vínculos de implementação
nas respectivas tarefas quando existirem.

## Contexto

O cliente quer abrir um pedido fechado, no mesmo status comercial que permite
gerar o PDF da ficha, e acionar um botão para criar a venda no ERP Olist.
A amplitude anterior incluía pendentes, entrada própria, prévia obrigatória,
cancelamento e mudanças globais do modelo de preços/ficha. Essas entregas
não são necessárias para essa jornada e dificultam sua conclusão.

## Decisão

1. Somente Pedido `confirmado` inicia a operação, pelo detalhe já existente,
   no botão **Gerar no Olist**. Validação ocorre internamente; pendências,
   processamento e resultado ficam na mesma página. Não exigir PDF prévio,
   quitação, check financeiro ou tela de prévia.
2. Preservar habilitação individual default falsa, gestão Admin e piloto por
   ID privado. Exigir acesso comercial existente ao Pedido; não criar entrada
   nem projeção Olist para perfil restrito nesta entrega. Admin não herda envio.
3. Usar dados estruturados, não o PDF. Composição por tamanho é aditiva ao
   Pedido confirmado e deve igualar exatamente seu total, preservando ficha,
   snapshot, pagamento e confirmação. Derivar grade/IDs no servidor e conferir
   correspondência 1:1, sem edição de grade/atributos pelo enriquecimento.
   Não inferir composição histórica nem
   exigir adoção global de um modelo novo de preços antes da exportação.
4. Reutilizar o núcleo de preços/conferência e manter integralmente a
   [ADR 062](062-olist-exportacao-com-unitario-exato-em-centavos.md): centavos
   exatos, nenhuma compensação/envio parcial, conferência de linhas e totais.
5. Resolver comprador/produtos/tamanhos, criar ausentes, reservar e persistir
   cada efeito no monólito/worker/PostgreSQL existentes. Duplicidade, falhas,
   recuperação administrativa mínima, proteção de dados e bloqueio de edição
   incompatível continuam parte da entrega, mesmo com interface simples.
6. Remoção Financeiro é FINQ-DEPREC-01, com verificação própria de quitação,
   dependências e histórico. Melhorias OLC-F01–F04 e ficha FPI-T01–T04 seguem
   separadas. Nenhuma é predecessora de OLC-T01–T06 e Olist não altera billing.

## Precedência e alternativas

Supersede parcialmente a ADR 057 quanto à exportação de qualquer status,
entrada/projeção própria, prévia obrigatória e acoplamento de cancelamento,
ficha e reforma global de preços ao primeiro envio. A habilitação sem posse
continua válida dentro do acesso comercial já existente, sem ampliar edição.
Não supersede as ADRs 040–042 para remover runtime Financeiro nesta entrega,
nem as decisões independentes de billing e impressão.

Manter a jornada ampla foi descartado para a primeira entrega. Reutilizar os
scripts de prova como runtime foi descartado porque não fornece persistência,
autorização e recuperação integradas. Um botão sem composição de preços ou
controle de duplicidade também não atende ao aceite.

## Consequências e verificação

Implementar OLC-T01–T06; antigas tarefas OLIST-T são referência para reaproveito,
não um checklist cumulativo obrigatório. Financeiro não é apagado como parte
da integração. Após aceite, acesso centralizado, vínculo antigo, cancelamento
e revisão ampliada podem evoluir por tarefas independentes.

Conferir critérios positivos, negativos, concorrentes, teclado/ARIA e regressão
de PDF/billing/loja, executar gates do projeto e homologar o caso real antes
de declarar a geração operacional. Atualizar as sínteses canônicas na mesma
entrega documental, sem reescrever ADRs anteriores ou regenerar o grafo.
