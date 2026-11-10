# RFC 061 — Ficha impressa por item

Data: 09/11/2026. Status: aceita pelo proprietário em 09/11/2026.
Responsável pela proposta: Tech Lead. Aprovador: proprietário do produto.
Decisão: [ADR 078](../adr/078-ficha-impressa-por-item.md).
Requisitos [FPI-01 a FPI-10](../../.specs/features/ficha-por-item/spec.md);
tarefas [FPI-T01 a FPI-T04](../../.specs/features/ficha-por-item/tasks.md). Sem
issue específica.
Antecedentes: RFCs [007](007-revisao-da-ficha-e-leitura-operacional.md),
[008](008-rotulos-da-ficha-tecnica-e-arte.md) e
[013](013-itens-por-publico.md).

## Contexto

A ficha impressa é um documento único do pedido, em A4 paisagem: os itens
ocupam a página 1 e as continuações, e o controle de produção fica numa página
própria, no fim. Uma folha não acompanha um item sozinha: quem lida com um item
consulta o documento do pedido e registra a conferência num controle que vale
para o pedido todo. O pedido recebido foi de uma folha por item, com os dados do
cliente, o item e o controle de produção juntos.

Em 09/11/2026, o proprietário decidiu trocar esse formato por uma folha para
cada item, e ajustou duas coisas no vocabulário e nos campos: "Tipo de roupa"
passa a se chamar "Modelo", e "Cores da arte" sai da ficha.

No mesmo dia, a correção de conteúdo da ficha (FIP-02 e FIP-05) definiu o que a
fábrica precisa ler e o que não pode sair no papel. Esse conteúdo ainda só
existe na branch `origin/codex/ficha-informacoes-producao`, em
`.specs/features/ficha-informacoes/spec.md`. A v8 o incorpora, e a
[spec](../../.specs/features/ficha-por-item/spec.md) repete o contrato para não
depender da integração daquela branch.

## Proposta

Criar o template `ficha-canonical-v8`, com uma folha A4 retrato por item.

| Bloco da folha       | Conteúdo                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Cabeçalho            | Pedido, Previsão de entrega e etiqueta "Item N de M" com o público                                         |
| Dados do pedido      | Cliente, Nome do pedido, Vendedor, Data do pedido, Primeiro contato, Entregue em, FAB e Arte do pedido     |
| Observações          | Observações do pedido em todas as folhas                                                                   |
| Item                 | Sete pontos, grade com linha "Conferido", sete caixas de conferência, adicionais e estado de divergência   |
| Controle de produção | Sete campos: Conferido para arrematar e Data, Arrematado e Data, OBS arremate, Conferido / Embalado e Data |
| Anotações            | Linhas pautadas no espaço que sobra                                                                        |

O título "Lastro do pedido" deixa de aparecer, e os campos continuam nos dados
do pedido. "Pago em" é a exceção: a data de pagamento fica fora do papel.

Observações que não couberem na folha vão para uma folha extra com a lista
completa, e cada folha imprime o aviso. Nada é descartado sem aviso.

"Tipo de roupa" vira "Modelo" e "Tipo de roupa informado" vira "Modelo
informado". Muda só o rótulo: a chave `item.tipo`, a API, os snapshots e o bot
continuam iguais. O campo antigo `item.modelo` passa a se chamar "Detalhe do
modelo" na ficha, para que a mesma folha não tenha dois rótulos "Modelo".

Saem 7 dos 14 campos de produção: `cores_frente`, `cores_costas`,
`cores_manga_direita`, `cores_manga_esquerda`, `total_cores_partes`,
`observacao_cores` e `quantidade_total_cores`. "Arte do pedido" e as cores do
tecido continuam.

O visual segue o design system do CRM: Poppins, tokens, painéis, grade de 4 px e
12 colunas, sem texto abaixo de 13 px.

A v8 imprime também as instruções complementares do atendimento. Só observação
editável com indicação financeira explícita bloqueia a geração; dado do
atendimento com valor sai mascarado, com aviso para conferir no CRM. Valor,
condição, cobrança, Olist e data de pagamento ficam fora do papel.

## Premissas

- O vendedor continua sem editar `item.modelo` na tela (REV-01). Pedidos novos
  sairão com "—" em "Detalhe do modelo".
- Os campos de Cores da arte só existem nos templates, nos scripts de revisão,
  nos testes e nos documentos. Não há domínio, API nem migração envolvidos.
- A impressora da fábrica é laser e a folha será preenchida à caneta. Isso é
  verificado no teste físico de FPI-T03.

## Critérios de decisão

- A folha precisa acompanhar um item sozinha, com tudo que a produção precisa.
- Nenhuma instrução do pedido pode sumir sem aviso.
- Fichas já aprovadas continuam imprimindo como foram aprovadas.
- A troca segue o gate de sempre: aprovação provisória por hash e assinatura
  física antes da produção.

## Alternativas

1. **Manter o formato paisagem da v7 e só acrescentar conteúdo.** Rejeitada. É
   o caminho mínimo da correção FIP e resolve o conteúdo, mas mantém itens
   agrupados e um único controle de produção por pedido. A folha continuaria
   sem poder acompanhar um item.
2. **Manter o total de cores do pedido na folha 1.** Rejeitada. O proprietário
   retirou o bloco Cores da arte por inteiro. O total ficaria sem as parcelas
   que o compõem e daria à folha 1 um papel diferente das demais.
3. **Observações do pedido só na folha 1.** Rejeitada. Uma folha pode ser
   separada das demais, e quem ficar com outro item não veria a instrução.
4. **Preto puro em vez do design system.** Rejeitada. O proprietário decidiu
   pelo visual do CRM. O preto puro reduziria o risco em impressora
   monocromática; por isso o estado de divergência não depende de cor, e a
   legibilidade é conferida na impressora real em FPI-T03.

## Impacto

| Área             | Efeito                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Ficha impressa   | Template novo. `PRINT_TEMPLATE` continua em v6 até a aprovação provisória das amostras v8.     |
| Fichas v2 a v7   | Sem mudança, inclusive hashes e rótulos antigos.                                               |
| Tela             | "Tipo de roupa" passa a "Modelo" no formulário, nos dados do atendimento e nas pendências.     |
| Caixa de Entrada | O resumo do pedido passa a dizer "Modelo".                                                     |
| API e banco      | Sem mudança de contrato nem migração. Só a descrição de `FichaItem` no OpenAPI muda.           |
| Bot              | Sem mudança no CRM. FPI-T04 confere se os workflows do n8n usam "tipo de roupa" nas mensagens. |
| ADRs anteriores  | 012, 016, 017, 019, 020 e 025 superadas só em rótulos, campos de produção e layout impresso.   |

Fora de escopo: a ficha da loja (`ficha-loja-v1`), a impressão dos nomes dos
anexos (FIP-03) e um novo lugar para registrar as cores da arte.

## Ações e resultado

A proposta foi aceita pelo proprietário em 09/11/2026 e registrada na
[ADR 078](../adr/078-ficha-impressa-por-item.md). A execução segue
[FPI-T01 a FPI-T04](../../.specs/features/ficha-por-item/tasks.md).
