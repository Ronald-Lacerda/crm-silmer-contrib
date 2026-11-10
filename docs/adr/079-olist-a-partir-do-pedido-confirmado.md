# ADR 079 Olist a partir do pedido confirmado

Data: 10/11/2026. Status: aceita pelo proprietário na solicitação de atualização
da especificação e das tarefas e complementada pelas decisões dele no mesmo dia
sobre refatoração, total do Pedido, cancelamento local e Financeiro. Registro
documental, sem ativação de runtime.

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
3. Usar dados estruturados, não o PDF. O valor final do Pedido segue a regra
   da [ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
   (itens 4 e 6): o vendedor informa o subtotal de cada linha de tamanho e o
   backend calcula o valor final como a **soma dos subtotais**, mais o **frete
   quando existir no Pedido**. Não há total final digitado nem regra de que a
   composição por tamanho deva igualar um total confirmado em Pedido novo. A
   igualdade exata com o total existente vale só para o enriquecimento de
   Pedido antigo ou da loja que possui apenas total (ADR 057 item 6), por
   composição aditiva, sem rateio. Em qualquer caso, preservar ficha, snapshot,
   pagamento e confirmação; derivar grade/IDs no servidor e conferir
   correspondência 1:1, sem edição de grade/atributos pelo enriquecimento. Não
   inferir composição histórica nem exigir adoção global de um modelo novo de
   preços antes da exportação.
4. Reutilizar o núcleo de preços/conferência e manter integralmente a
   [ADR 062](062-olist-exportacao-com-unitario-exato-em-centavos.md): centavos
   exatos, nenhuma compensação/envio parcial, conferência de linhas e totais.
5. Resolver comprador/produtos/tamanhos, criar ausentes, reservar e persistir
   cada efeito no monólito/worker/PostgreSQL existentes. Duplicidade, falhas,
   recuperação administrativa mínima, proteção de dados e bloqueio de edição
   incompatível continuam parte da entrega, mesmo com interface simples.
6. A remoção da feature Financeiro (fila, check "Nota criada", perfil
   Financeiro, rotas `/api/v1/finance/*` e código `finance.*`) foi **aprovada
   pelo PO em 10/11/2026** como FINQ-DEPREC-01, com execução independente dos
   blocos 1–6 e sem ser predecessora de OLC-T01–T06. Remove-se o código e
   mantêm-se as tabelas e os dados históricos (migrações 0042/0043, sem
   migração destrutiva); quitação (`paid_on`,
   `finance_payment_review_required`), cobranças InfinitePay e Dashboard não são
   alterados. A decisão que supersede as ADRs 040/041/042 será registrada na
   execução. Melhorias OLC-F01–F04 e ficha FPI-T01–T04 seguem separadas e
   nenhuma é predecessora de OLC-T01–T06. Olist não altera billing.
7. **Cancelamento local só para Pedido não fechado** (não confirmado, isto é,
   `pendente`). Supersede parcialmente a
   [ADR 068](068-cancelamento-local-terminal-pre-exportacao.md), que permite
   cancelar qualquer Pedido antes da exportação, inclusive confirmado ou pago;
   a ADR 068 não é reescrita. Restringir o código já entregue (rota, UI, testes e
   métricas) é mudança de comportamento, feita em tarefa própria (OLC-F03) e
   nunca de forma silenciosa. Os filtros de cancelamento (cancelados fora dos
   universos ativos) seguem como gate de liberação, conforme a
   [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
8. **Refatoração do Olist.** O Olist passa por refatoração conforme os blocos
   1–6 do [documento de prompts](../integrations/olist/prompts-pedido-confirmado.md).
   O pacote OLC é a direção vigente e prevalece sobre o que a master já tem de
   Olist onde houver divergência; o runtime existente é ponto de partida e de
   reaproveitamento. Prévia obrigatória e entrada própria (menu/busca) são
   tratadas nesses blocos e em OLC-F01/F04, como já descrito.

## Precedência e alternativas

Supersede parcialmente a ADR 057 quanto à exportação de qualquer status,
entrada/projeção própria, prévia obrigatória e acoplamento de cancelamento,
ficha e reforma global de preços ao primeiro envio; mantém dela o cálculo do
valor final pela soma dos subtotais (itens 4 e 6). Supersede parcialmente a
ADR 068 quanto ao Pedido cancelável (decisão 7). A habilitação sem posse
continua válida dentro do acesso comercial já existente, sem ampliar edição.
A remoção do Financeiro (decisão 6) é trilha própria que supersederá as ADRs
040–042 em registro feito na sua execução; esta ADR não as substitui nem toca
as decisões independentes de billing e impressão.

Manter a jornada ampla foi descartado para a primeira entrega. Reutilizar os
scripts de prova como runtime foi descartado porque não fornece persistência,
autorização e recuperação integradas. Um botão sem composição de preços ou
controle de duplicidade também não atende ao aceite.

## Consequências e verificação

Implementar OLC-T01–T06; antigas tarefas OLIST-T são referência para reaproveito,
não um checklist cumulativo obrigatório. O Financeiro é removido por trilha
própria, não como parte da integração. Acesso centralizado, vínculo antigo,
restrição do cancelamento local e revisão ampliada evoluem por tarefas
independentes (OLC-F01–F04).

Conferir critérios positivos, negativos, concorrentes, teclado/ARIA e regressão
de PDF/billing/loja, executar gates do projeto e homologar o caso real antes
de declarar a geração operacional. Atualizar as sínteses canônicas na mesma
entrega documental, sem reescrever ADRs anteriores ou regenerar o grafo.
