# RFC 062 — Valor final com frete

Data: 10/11/2026. Status: decidida na
[ADR 080](../adr/080-valor-final-com-frete.md), com as respostas do
proprietário de 10/11/2026, que também confirmou as propostas técnicas P1–P3
(seção 5). Responsável pela proposta: Tech Lead. Aprovador: proprietário do
produto.
Requisitos [OLC-05a–j](../../.specs/features/olist-confirmed/spec.md#frete-no-total-do-pedido);
tarefa [OLC-T01](../../.specs/features/olist-confirmed/tasks.md#olc-t01-dados-do-pedido-e-autorização).
Entrega documental OLIST-PLAN-03,
[PR #340](https://github.com/romulosutil/crm-silmer/pull/340). Sem issue
específica.
Antecedentes: [RFC 038](038-frete-e-etiqueta-pelo-melhor-envio.md) (seção 2.3,
D3–D5, fatia ME-2), que não é reescrita;
[RFC 050 revisão 3](050-geracao-assistida-de-pedidos-no-olist.md) e
[ADR 079](../adr/079-olist-a-partir-do-pedido-confirmado.md), decisão 9.

## 1. Contexto

Em 10/11/2026 o PO decidiu que o frete compõe o total do Pedido: Valor final =
soma dos subtotais por linha de tamanho, calculada pelo backend
([ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
itens 4 e 6), mais o frete. A ADR 079 registrou a regra e deixou em OLC-T01 as
perguntas de desenho. Na master:

- o Pedido não tem frete; `confirmOrder` calcula o valor final só pela soma
  dos subtotais e recusa `amountCents` divergente
  (`modules/orders/src/domain/order.js`);
- a cotação de `modules/shipping` é persistida cifrada por Pedido, com versão
  do Pedido, e fica desatualizada quando essa versão muda
  (`apps/api/src/conversation-shipping-runtime.js`, migration 0050). É
  estimativa separada do Valor final, que "não altera ficha, total, pagamento
  ou status" ([ADR 054](../adr/054-cotacao-na-conversa-vinculada-ao-pedido.md));
  a composição peças + frete está fora das
  [ADRs 053](../adr/053-conexao-e-cotacao-administrativa-melhor-envio.md) e 054;
- cobrança InfinitePay, plano de cobrança, quitação e Dashboard leem o valor
  final persistido (`order-billing-runtime.js`, `dashboard-runtime.js`), e a
  reconfirmação com outro valor já limpa a quitação e pede revisão (FINQ-18,
  [ADR 058](../adr/058-cobrancas-do-pedido-com-infinitepay.md),
  [ADR 076](../adr/076-intencoes-de-cobranca-e-envio-transacional.md),
  [ADR 077](../adr/077-recebimentos-externos-e-conciliacao-de-cobrancas.md));
- o Pedido da loja nasce confirmado ao preço do catálogo, travado, com CEP
  opcional só como observação (RULES 21, ADR 027);
- as fichas canônicas não imprimem valor; só a ficha da loja mostra "Valor
  pago" ([ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
  item 11: sem valor monetário por inferência);
- o adapter e o inspector Olist exigem `valorFrete` ausente ou zero
  (`modules/olist/src/sale-payload.js`, `readonly-inspector.js`).

Respostas do PO em 10/11/2026 às perguntas de OLC-T01:

1. Quem informa o frete é o **Vendedor**: o responsável humano comercial do
   Pedido, com a autorização comercial atual. Admin não informa por herança.
2. A cotação de `modules/shipping` entra como **sugestão**: propõe o valor, o
   vendedor revisa e confirma. O navegador nunca envia preço (ADR 054 e RULES
   permanecem); a cotação persistida é só leitura de origem.
3. O frete **não** muda em Pedido confirmado: é definido até a confirmação e
   congela com ela, pela mesma regra do total e do snapshot. Pedido confirmado
   legado fica com frete zero, intocado.
4. O Dashboard **não** separa peças e frete: o "vendido" usa o total único.

## 2. Proposta

1. **Dado.** O Pedido ganha um frete próprio em centavos inteiros não
   negativos, aditivo, com default zero ("sem frete"), versionado com o
   Pedido e auditado. Guarda a origem do valor: informado pelo vendedor ou
   aplicado de uma cotação persistida (referência da cotação e do serviço,
   valor cotado, autor e instante). Nomes de campo, coluna e rota: a definir
   na implementação (OLC-T01).
2. **Quem e quando.** Só o vendedor responsável pelo Pedido (dono da
   conversa ou, em Pedido manual sem conversa, seu vendedor responsável,
   RULES 20) informa ou altera o frete, e só com o Pedido `pendente`. O perfil
   Admin não ganha esse comando; Admin que seja o próprio responsável usa a
   autorização de responsável. A automação nunca informa frete (RULES 5).
3. **Sugestão da cotação.** "Usar a cotação" envia apenas a identidade da
   cotação persistida e do serviço escolhido; o backend lê o preço da
   cotação, exige que ela seja do mesmo Pedido, não desatualizada (regra atual
   da ADR 054) e com serviço selecionado, e grava o valor no frete do Pedido
   com origem "cotação". O vendedor pode, em vez disso, informar o valor
   combinado (origem "informado"). Valor digitado é declaração do vendedor,
   como o subtotal por tamanho, e nunca é aceito como "preço da cotação".
4. **Precedência.** O frete gravado no Pedido é a única fonte do total. A
   cotação nunca altera o frete por si só: nova cotação, nova seleção ou
   cotação desatualizada depois da aplicação não mudam o valor. A tela mostra
   o frete com sua origem e, quando a cotação selecionada atual diferir do
   frete gravado ou estiver desatualizada, um aviso com a ação "Usar esta
   cotação"; nada muda sem comando do vendedor.
5. **Cálculo.** Enquanto pendente, o backend apresenta peças (soma dos
   subtotais), frete e o total derivado. Na confirmação, o backend calcula o
   valor final = soma dos subtotais + frete, persiste-o como hoje e registra a
   composição (peças, frete, origem) junto de autor, horário, valor e
   condição (RULES 10). `amountCents` informado na confirmação, se houver,
   precisa igualar essa soma; divergência recusa, como hoje.
6. **Concorrência.** Informar ou aplicar frete é comando versionado com
   `expectedVersion`, idempotente e auditado sem PII, que incrementa a versão
   do Pedido. Conflito retorna conflito de versão, sem gravação parcial. A
   confirmação recalcula no servidor com a versão travada.
7. **Congelamento.** Depois de confirmado, nenhum comando altera o frete. A
   reabertura existente (volta a `pendente`, RULES 9) segue a mesma regra do
   total: reabre a edição do frete pelo vendedor e a reconfirmação recalcula o
   total com as proteções atuais de quitação e cobrança. Reabertura continua
   bloqueada onde já é (loja travada; Pedido com operação Olist reservada ou
   concluída, OLC-10). Diferença entre custo real e cotado de etiqueta futura
   não altera o total (RFC 038 MEV-10).
8. **Legado e loja.** Pedido confirmado antes da entrega fica com frete zero e
   valor final, snapshot, cobrança e quitação intocados; nada é inferido da
   cotação ou do total. Pedido pendente existente começa com frete zero e pode
   recebê-lo antes de confirmar. Pedido da loja: checkout, gateway, travas e
   adapter não mudam; o total é o preço pago, com frete zero e sem rateio.
9. **Cobrança e quitação.** Como o total só muda em confirmação, a cobrança
   InfinitePay, o plano, os recebimentos externos e a quitação continuam a
   ler o valor final, que passa a incluir o frete em Pedido novo. Nenhuma
   regra nova de billing: a reconfirmação com outro total aciona as proteções
   já existentes (quitação anterior não prova pagamento do novo valor; plano
   em revisão; correção limitada ao saldo pela ADR 076).
10. **Dashboard.** O "vendido" soma o valor final, que inclui o frete, sem
    separar peças e frete; histórico não é reprocessado.
11. **Ficha e PDF.** Nesta entrega a ficha **não** mostra frete: nenhuma
    versão de impressão nova e `PRINT_TEMPLATE` inalterado. Exibir frete
    exigirá decisão e versão próprias.
12. **Olist.** O snapshot de exportação congela o frete confirmado; a venda
    ERP leva `valorFrete` igual a ele, fora dos unitários, com
    `valorDesconto` e `valorOutrasDespesas` zero; a conferência exige total
    do ERP = linhas + `valorFrete` e `valorFrete` = frete do Pedido
    ([ADR 062](../adr/062-olist-exportacao-com-unitario-exato-em-centavos.md)
    integral). `valorFrete` ausente no retorno só equivale a zero quando o
    frete do Pedido é zero. O frete integra a revisão comercial exportável.

## 3. Alternativas

- **Cotação compõe o total automaticamente.** Rejeitada pelo PO (sugestão) e
  pela RFC 038: fica velha quando a grade muda e esconde a decisão humana.
- **Navegador envia o valor cotado.** Rejeitada: viola a ADR 054; a origem da
  cotação só é provada lendo a cotação persistida no servidor.
- **Frete editável depois de confirmado** (RFC 038 D5, comando próprio).
  Rejeitada pelo PO: o frete congela com o total.
- **Total digitado com frete embutido.** Rejeitada: contraria ADR 057 item 4
  e impede conferir `valorFrete` no Olist.
- **Separar peças e frete no Painel** (RFC 038 seção 4, D4). Rejeitada pelo PO.
- **Ratear frete do total da loja.** Rejeitada: inferência sem dado de origem.
- **Atualizar só a RFC 038.** Descartada: ela segue em revisão com D1–D9 e
  outras fatias; o Valor final com frete precisa de decisão própria que
  complemente a ADR 020 (que, pela RULES 13, exige o valor final), como a
  própria RFC 038 pede (seção 4 e fatia ME-2).

## 4. Impacto nas decisões existentes

| Fonte                          | Impacto                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| ADR 020 / RULES 13             | Complementada: o valor final exigido para gerar passa a ser peças + frete                 |
| ADR 057 itens 4 e 6            | Mantidos; o total calculado ganha a parcela de frete                                      |
| ADRs 053 e 054                 | Superseded só no ponto "estimativa não altera o total / composição fora de escopo"        |
| RFC 038                        | Atualizada por referência: D4 e D5 resolvidas, D3 com proposta; demais pontos seguem nela |
| RULES 16 (proposta da RFC 038) | "Frete não conta como venda" não é adotado: o vendido usa o total único                   |
| RULES 20                       | Mantida para o Pedido; o comando de frete é restrito ao vendedor responsável, sem Admin   |
| ADR 062, ADR 079 decisão 9     | Mantidas; `valorFrete` conferido em centavos exatos                                       |
| ADRs 058, 076, 077             | Sem regra nova; o valor final com frete é a base de cobrança e quitação de Pedido novo    |
| ADR 057 item 11 / ADR 078      | Sem frete na impressão nesta entrega                                                      |

## 5. Propostas técnicas P1–P3, confirmadas pelo PO em 10/11/2026

Sem precedente nas decisões existentes; a ADR 080 as adotou de forma
conservadora e o proprietário as confirmou:

- **P1 — Sem alçada nesta entrega** (RFC 038 D3): frete zero, "já no preço"
  ou abaixo do cotado não exige aprovação do gestor; a auditoria registra
  origem, valor cotado e valor informado.
- **P2 — Cotação desatualizada só avisa:** se a grade/quantidade mudar
  depois de aplicar uma cotação, o frete gravado permanece e a tela avisa que
  a cotação de origem está desatualizada; a confirmação não é bloqueada.
- **P3 — Performance comercial com o mesmo total:** as métricas de valor da
  central de performance (ADR 059), que leem o valor final capturado na
  confirmação, herdam o frete como o Dashboard.

Forma de entrega (RFC 038 MEV-01), etiqueta, alçadas e demais decisões D1–D9
continuam fora desta proposta.
