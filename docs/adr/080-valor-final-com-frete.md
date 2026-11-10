# ADR 080 — Valor final com frete

Data: 10/11/2026. Status: aceita. Registro documental, sem runtime.
Decisores: proprietário do produto, em 10/11/2026, decidiu que o frete compõe
o total, que o vendedor o informa, que a cotação é só sugestão, que o frete
congela na confirmação e que o Dashboard não separa peças e frete. Tech Lead
fechou o desenho técnico abaixo; o proprietário confirmou os pontos P1–P3 em
10/11/2026.
Proposta: [RFC 062](../rfc/062-valor-final-com-frete.md).
Requisitos [OLC-05a–j](../../.specs/features/olist-confirmed/spec.md#frete-no-total-do-pedido);
tarefa [OLC-T01](../../.specs/features/olist-confirmed/tasks.md#olc-t01-dados-do-pedido-e-autorização)
(com OLC-T02–T04 e T06 para Olist e interface). Entrega documental
OLIST-PLAN-03, [PR #340](https://github.com/romulosutil/crm-silmer/pull/340).
Sem issue específica.

Complementa a [ADR 020](020-tecnica-por-item-e-arte-do-pedido.md) quanto ao
valor final exigido para gerar (RULES 13) e a
[ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
itens 4 e 6. Detalha a decisão 9 da
[ADR 079](079-olist-a-partir-do-pedido-confirmado.md). Supersede parcialmente as
ADRs [053](053-conexao-e-cotacao-administrativa-melhor-envio.md) e
[054](054-cotacao-na-conversa-vinculada-ao-pedido.md) apenas no ponto em que a
estimativa não altera o total e a composição peças + frete fica fora de
escopo; conexão, cotação, permissões, persistência e desatualização da
estimativa continuam como estão. Atualiza por referência a
[RFC 038](../rfc/038-frete-e-etiqueta-pelo-melhor-envio.md): resolve D4 e D5,
adota proposta conservadora para D3 e não altera as demais decisões e fatias.
Nenhuma dessas fontes é reescrita.

## Contexto

Na master, o valor final é a soma dos subtotais por linha de tamanho; a
cotação do Melhor Envio é estimativa persistida, separada do total; cobrança,
quitação e Dashboard leem o valor final persistido; e o Olist exige
`valorFrete` zero. A RFC 062 descreve o estado atual e as alternativas.

## Decisão

1. **Valor final = peças + frete.** Em Pedido novo, o backend calcula o valor
   final como a soma dos subtotais por linha de tamanho mais o frete do
   Pedido. Não há total digitado; `amountCents` informado na confirmação
   precisa igualar essa soma.
2. **Frete do Pedido.** Dado próprio do Pedido em centavos inteiros não
   negativos, sem ponto flutuante, aditivo (migração expand), default zero,
   versionado com o Pedido e auditado sem PII. Zero ou ausente é "sem frete" e
   não é pendência. Valor negativo, fração, texto ambíguo ou acima do limite
   monetário do domínio é recusado sem arredondar. A origem é registrada:
   informado pelo vendedor ou aplicado de cotação (referência da cotação e do
   serviço, valor cotado, autor, instante). Nomes de campo, coluna e rota: a
   definir na implementação (OLC-T01).
3. **Quem informa.** Somente o vendedor responsável pelo Pedido (dono da
   conversa ou, em Pedido manual sem conversa, seu vendedor responsável,
   RULES 20), humano ativo, com a autorização comercial atual. Admin não
   recebe o comando por herança; só o usa se for o próprio responsável. A
   automação e o agente nunca informam frete (RULES 5). Admin pode confirmar o
   Pedido pela regra atual, mas a confirmação congela o frete que o vendedor
   informou, sem alterá-lo.
4. **Quando.** Só com o Pedido `pendente`, até a confirmação. A confirmação
   congela frete e total. Nenhum comando altera o frete de Pedido
   confirmado. A reabertura existente (RULES 9) segue a mesma regra do total:
   devolve a edição ao vendedor e a reconfirmação recalcula com as proteções
   atuais; continua bloqueada onde já é (Pedido da loja; Pedido com operação
   Olist reservada ou concluída, OLC-10). Diferença entre custo real e cotado
   de etiqueta futura não muda o total (RFC 038 MEV-10).
5. **Cotação como sugestão.** Aplicar a cotação envia só a identidade da
   cotação persistida e do serviço; o servidor lê o preço, exige o mesmo
   Pedido, serviço selecionado e cotação não desatualizada pela regra atual da
   ADR 054, e grava o valor no frete. O navegador nunca envia preço de
   cotação. O vendedor pode informar outro valor; esse valor é declaração dele.
6. **Precedência.** O frete gravado é a única fonte do total. Nova cotação,
   nova seleção ou desatualização posterior não mudam o frete. A tela mostra
   peças, frete com origem e total; se a cotação selecionada atual diferir do
   frete ou estiver desatualizada, mostra aviso e a ação de aplicá-la. A regra
   de desatualização da cotação (versão do Pedido) não muda.
7. **Recálculo e concorrência.** Subtotal, quantidade e frete alteram o total
   derivado; quantidade continua exigindo revisão do subtotal e não mexe no
   frete. Informar ou aplicar frete é comando com `expectedVersion`, chave de
   idempotência e auditoria, que incrementa a versão; conflito não grava nada.
   A confirmação recalcula com o Pedido travado e registra peças, frete,
   origem e total junto de autor, horário e condição (RULES 10).
8. **Legado.** Pedido confirmado antes da entrega fica com frete zero e valor
   final, snapshot, ficha, PDF, cobrança, quitação e Dashboard intocados;
   nenhum frete é inferido da cotação ou do total. A regra de cálculo usada
   fica identificável por Pedido (com ou sem frete) para nunca recalcular
   histórico. Pedido pendente existente começa com frete zero.
9. **Loja.** Checkout, gateway, travas e adapter não mudam. O total do Pedido
   da loja é o preço pago, com frete zero, sem rateio; o CEP segue como
   observação. No Olist, `valorFrete` zero.
10. **Cobrança e quitação.** Sem regra nova: cobrança InfinitePay, plano,
    recebimentos externos e quitação continuam lendo o valor final, que inclui
    o frete em Pedido novo. Como o total só muda por reconfirmação, aplicam-se
    as proteções vigentes (quitação anterior não prova o novo valor, plano em
    revisão, correção limitada ao saldo pela
    [ADR 076](076-intencoes-de-cobranca-e-envio-transacional.md), ADRs
    [058](058-cobrancas-do-pedido-com-infinitepay.md) e
    [077](077-recebimentos-externos-e-conciliacao-de-cobrancas.md)).
11. **Dashboard.** O "vendido" usa o total único com frete, sem separar peças
    e frete. A proposta da RFC 038 de que o frete não conte como venda não é
    adotada. Histórico não é reprocessado.
12. **Ficha e PDF.** Nesta entrega a ficha não mostra frete: sem versão de
    impressão nova e com `PRINT_TEMPLATE` inalterado (ADR 057 item 11; ADR 078).
13. **Olist.** O snapshot de exportação congela o frete confirmado, que integra
    a revisão comercial exportável. A venda leva `valorFrete` igual a ele, fora
    dos unitários, com `valorDesconto` e `valorOutrasDespesas` zero. Sucesso
    exige total do ERP = linhas + `valorFrete` e `valorFrete` = frete do
    Pedido; `valorFrete` ausente só equivale a zero quando o frete do Pedido é
    zero. Divergência preserva IDs e exige conferência
    ([ADR 062](062-olist-exportacao-com-unitario-exato-em-centavos.md) integral).
14. **Contrato e rollback.** OpenAPI aditivo: leitura do Pedido expõe peças,
    frete com origem e total; comando de frete com `expectedVersion`; cotação
    inalterada. Rollback de código não remove o dado (expand) e não pode
    recalcular sem frete o total de Pedido que o tem: a implementação
    documenta como bloquear reconfirmação nessa condição.

### Pontos P1–P3, confirmados pelo PO em 10/11/2026

- **P1:** sem alçada nesta entrega para frete zero, "já no preço" ou abaixo do
  cotado (RFC 038 D3); a auditoria registra cotado e informado.
- **P2:** cotação de origem desatualizada após mudança de grade só gera aviso;
  não bloqueia a confirmação nem altera o frete.
- **P3:** a performance comercial por responsável (ADR 059), que soma o valor
  final, herda o frete como o Dashboard.

## Alternativas

Cotação somando automaticamente, preço enviado pelo navegador, frete editável
após confirmar, total digitado, Painel separado e rateio do total da loja
foram descartados (RFC 062, seção 3). Atualizar só a RFC 038 foi descartado
porque ela segue em revisão com D1–D9; esta decisão precisava de registro
próprio, como a RFC 038 pede para o Valor final.

## Consequências e verificação

OLC-T01 implementa dado, comando, cálculo, leitura e testes antes do Olist;
OLC-T02 trata `valorFrete` no adapter e no inspector; OLC-T03 congela e confere;
OLC-T04 mostra peças, frete e total no detalhe; OLC-T06 confere no piloto.
Testes: frete positivo, zero e ausente; centavos inválidos e overflow; vendedor
autorizado e negados (Admin não responsável, outro vendedor, automação, Pedido
confirmado, loja); sugestão de cotação válida, desatualizada, de outro Pedido e
preço vindo do navegador; concorrência por versão e idempotência; confirmação
com `amountCents` divergente; reabertura e reconfirmação com cobrança e
quitação; legado preservado; Dashboard; ficha/PDF sem mudança; Olist com
`valorFrete` igual, divergente e ausente. Forma de entrega, etiqueta e D1–D9
seguem na RFC 038.
