# ADR 078 — Ficha impressa por item

Data: 09/11/2026. Status: aceita.
Decisores: proprietário do produto, em 09/11/2026, definiu a folha por item, os
rótulos, os campos que saem e o visual. Tech Lead definiu o template novo e a
ordem de ativação.
Proposta: [RFC 061](../rfc/061-ficha-impressa-por-item.md).
Requisitos [FPI-01 a FPI-10](../../.specs/features/ficha-por-item/spec.md);
tarefas [FPI-T01 a FPI-T04](../../.specs/features/ficha-por-item/tasks.md). Sem
issue específica.
Supersede em parte as ADRs [012](012-ficha-de-sete-pontos-e-ritmo-fixo.md),
[016](016-itens-com-os-sete-pontos-da-ficha.md),
[017](017-ficha-impressa-com-os-sete-pontos.md),
[019](019-ficha-espelhada-e-sinais-operacionais.md),
[020](020-tecnica-por-item-e-arte-do-pedido.md) e
[025](025-itens-por-publico.md), somente no que tratam de rótulos da peça,
campos de produção e layout impresso.

## Contexto

A ficha impressa é hoje um documento único do pedido, em A4 paisagem, com um
controle de produção para o pedido todo, e uma folha não acompanha um item
sozinha. O proprietário decidiu trocar o formato por uma folha por item e
ajustar o vocabulário e os campos da ficha.

## Decisão

1. **Uma folha por item.** O novo template `ficha-canonical-v8` imprime uma
   folha A4 retrato por item. Cada folha traz, nesta ordem: cabeçalho (Pedido,
   Previsão de entrega e etiqueta "Item N de M" com o público); dados do pedido
   (Cliente, Nome do pedido, Vendedor, Data do pedido, Primeiro contato,
   Entregue em, FAB e Arte do pedido); observações; item; e Controle de
   produção. O título "Lastro do pedido" deixa de aparecer, e os campos
   continuam, exceto a data de pagamento (item 9).
2. **Observações em todas as folhas.** O que não couber vai para uma folha extra
   com a lista completa, com aviso impresso em cada folha. Nada é descartado sem
   aviso.
3. **Conferência à mão.** A grade tem uma linha "Conferido" em branco para a
   contagem, e o item tem sete caixas de conferência, uma por ponto.
4. **Divergência visível.** Quantidade informada diferente da soma da grade
   aparece em estado de atenção, sem bloquear. A soma da grade continua sendo a
   quantidade.
5. **"Tipo de roupa" passa a "Modelo".** Muda só o rótulo, e a chave `item.tipo`
   continua. "Tipo de roupa informado" vira "Modelo informado". "Modelo de
   malha" não muda.
6. **"Detalhe do modelo".** O campo antigo `item.modelo` passa a se chamar
   "Detalhe do modelo" na ficha. A chave e os dados históricos não mudam.
7. **Cores da arte sai da ficha.** Saem 7 dos 14 campos de produção:
   `cores_frente`, `cores_costas`, `cores_manga_direita`,
   `cores_manga_esquerda`, `total_cores_partes`, `observacao_cores` e
   `quantidade_total_cores`. Ficam 7: Conferido para arrematar e Data, Arrematado
   e Data, OBS arremate, Conferido / Embalado e Data. "Arte do pedido" e as
   cores do tecido continuam.
8. **Design system do CRM.** Poppins, tokens, painéis, grade de 4 px e 12
   colunas, e nenhum texto abaixo de 13 px. Anotações manuais pautadas ocupam o
   espaço que sobra.
9. **Conteúdo de fábrica.** Valor, condição, cobrança, Olist e data de pagamento
   ficam fora do papel. A v8 imprime também as instruções complementares do
   atendimento. Só observação editável com indicação financeira explícita
   bloqueia a geração, sem apagar o texto; nome do cliente e campos do item não
   bloqueiam, e linha do atendimento com valor sai mascarada, com aviso para
   conferir no CRM (conteúdo aprovado em FIP-02 e FIP-05, hoje só na branch
   `origin/codex/ficha-informacoes-producao`, com esta restrição do bloqueio).
10. **Imutabilidade e ativação.** As fichas v2 a v7 e seus hashes não mudam.
    `PRINT_TEMPLATE` continua em v6 até a aprovação provisória do PO vinculada
    ao hash das amostras v8. A assinatura física de Rose e Operação continua
    sendo gate de produção.

## O que muda nas decisões anteriores

| ADR | Deixa de valer na v8 e no vocabulário vigente                                                                  | Continua valendo                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 012 | O nome "tipo de roupa" para o primeiro ponto.                                                                  | Os sete pontos, `product_model`, a ordem e o ritmo das perguntas do bot.                              |
| 016 | Rótulo "Tipo de roupa" de `tipo`, inclusive no cabeçalho do item, e rótulo "Modelo" de `modelo` na ficha.      | Forma do item, chaves, regras para gerar e projeção do bot.                                           |
| 017 | Página 1 com resumo, lastro e itens, páginas de continuação, 14 campos de produção e faixa "Lastro do pedido". | Template novo a cada mudança, "—" em campo vazio, acentos, seletor único e assinatura física.         |
| 019 | "Tipo de roupa" e a ausência de `modelo` na nova ficha (item 2); layout e 14 campos preservados (item 4).      | Serviço por item, definição da gola, `modelo` fora da edição, métricas, sinais e leitura acessível.   |
| 020 | Rótulo "Tipo de roupa", "Cores da arte" com "Nº de cores" e "Pago em" no papel (item 5).                       | Técnica por item, arte do pedido, estampa como referência e demais rótulos.                           |
| 025 | Layout e paginação herdados pela impressão v6 (item 7).                                                        | Público por item, junto da etiqueta do item, "Modelo de malha", quantidade informada como referência. |

Os corpos dessas ADRs e de suas RFCs não são editados. A
[ADR 036](036-padroes-de-jornada.md) e a RFC 024 não são superadas: dizem que a
ficha impressa mantém "Lastro" em seus templates, e isso continua verdadeiro
para v2 a v7. A [ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
continua valendo para "Aplicação" e "Previsão de entrega", que a v8 usa.

## Alternativas descartadas

- **Manter o formato paisagem da v7 e só acrescentar conteúdo:** resolve o
  conteúdo, mas a folha continua sem poder acompanhar um item.
- **Manter o total de cores do pedido na folha 1:** o bloco saiu por inteiro, e o
  total ficaria sem as parcelas que o compõem.
- **Observações do pedido só na folha 1:** uma folha pode ser separada das
  demais, e quem ficar com outro item não veria a instrução.
- **Preto puro em vez do design system:** o proprietário decidiu pelo visual do
  CRM. O estado de divergência não depende de cor, e a legibilidade é conferida
  na impressora real.

## Consequências

- Um pedido de M itens imprime pelo menos M folhas, e mais uma quando as
  observações ou instruções não couberem. O consumo de papel aumenta em pedidos
  com vários itens.
- Cada folha repete os dados do pedido e pode ser separada das demais.
- Não há migração. `item.tipo` e `item.modelo` seguem iguais na API, nos
  snapshots e no bot.
- A tela passa a dizer "Modelo". Até a ativação da v8, o papel vigente (v6) ainda
  diz "Tipo de roupa", e tela e papel divergem nesse intervalo.
- Pedidos novos saem com "—" em "Detalhe do modelo", pois a tela não edita esse
  campo desde a REV-01.
- As cores da arte deixam de ter lugar no papel. Rose e Operação confirmam em
  FPI-T03 se essa informação precisa de outro registro; criá-lo exige nova
  decisão.
- Reverter é manter `PRINT_TEMPLATE` em v6 ou voltar a ele, sem migração. Os
  rótulos da tela são revertidos com o PR.
