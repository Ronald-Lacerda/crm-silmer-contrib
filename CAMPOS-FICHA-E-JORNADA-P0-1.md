# Campos da Ficha e Jornada Conversacional — P0.1

> **Data:** 29/08/2026\
> **Status:** inventário original do P0.1, reconciliado em 05/10/2026 com ADRs 006, 016 e 020\
> **Fontes:** `ficha_exemplo.xlsx`, `PRODUCT-READINESS-TECH-LEAD.md` e `CRM-MVP-ESPECIFICACAO.md`\
> **Baseline atual:** coleta não linear, Pedido pendente/confirmado, técnica por item, arte do pedido e impressão v6 com público por item (ADR 025). Os grupos de perguntas não são estados nem colunas.
>
> **Rótulos v7 (OLIST-49):** a tela e a ficha v7 usam “Previsão de entrega” (antes “Entrega prometida”) e “Aplicação” no item (antes “Técnica”). As chaves `data_entrega_confirmada` e `tipo_servico` não mudam, e as fichas v2–v6 mantêm os rótulos históricos citados neste documento.

Este documento transforma a planilha de exemplo em um contrato de dados e em
uma jornada conversacional testável. Ele separa o que o cliente informa, o que
o CRM calcula, o que a operação comercial confirma e o que só é preenchido no
chão de fábrica.

## 1. Leitura técnica do arquivo

- Pasta de trabalho: `ficha_exemplo.xlsx`.
- Planilha: `OS Silmer 2013`.
- Área utilizada: `A1:O39`.
- A ficha possui uma linha de cabeçalho do pedido, até 21 linhas para itens e
  grade (`7:27`), cinco linhas de observação (`31:35`) e campos posteriores de
  produção (`36:39`).
- O total de peças em `K28` é calculado por `SUM(K7:K27)` e não deve ser
  digitado novamente.
- As células auxiliares `L3` e `L17` não possuem rótulo. Elas não entram no
  contrato até a operação explicar seu significado; o CRM não deve inventar
  campos para elas.
- As colunas ocultas `M` e `N` estão vazias e não contêm campos de negócio.

### Vocabulário de preenchimento

Cada campo aplicável possui um destes estados:

| Estado          | Significado                                   | Permite gerar?                             |
| --------------- | --------------------------------------------- | ------------------------------------------ |
| `preenchido`    | Valor válido e confirmado                     | Sim                                        |
| `nao_aplicavel` | Exceção prevista, com motivo registrado       | Sim                                        |
| `pendente`      | Falta resposta ou decisão                     | Não, se o campo for obrigatório para gerar |
| `divergente`    | Valores se contradizem ou falham na validação | Não                                        |

“Não sei”, “talvez” e “a definir” são respostas válidas na conversa, mas
viram `pendente`. O Vendedor Silmer pode continuar coletando outros dados, enquanto a pendência de geração permanece visível para cliente ou pessoa autorizada.

## 2. Inventário original dos campos da planilha

As tabelas preservam a leitura do arquivo de referência, inclusive obrigatoriedade original. O contrato atual de geração está na seção 4 e em Pedidos MVP; ele supersede exigências da planilha sem apagar dados antigos.

### 2.1 Identificação do pedido

| ID canônico                      | Rótulo original   | Célula/intervalo | Origem                | Obrigatório para gerar a Ficha | Regra                                                                                                                      |
| -------------------------------- | ----------------- | ---------------- | --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `pedido.numero`                  | `PEDIDO N°`       | `B2`             | Sistema               | Sim                            | Sequência global do namespace próprio: começa em `01-CRM`, usa sufixo `-CRM`, não reinicia e não depende de número legado. |
| `pedido.fab`                     | `FAB`             | `C2`             | Configuração/operação | Sim                            | Código controlado da unidade fabril; no piloto, valor fixo `01`, exibido como `FAB 01`.                                    |
| `pedido.vendedor`                | `Vendedor:`       | `F2:G2`          | CRM/operação          | Sim                            | Usuário responsável no momento do fechamento.                                                                              |
| `pedido.data`                    | `Data do Pedido:` | `J2:K2`          | Sistema               | Sim                            | Data da geração da versão aprovada.                                                                                        |
| `pedido.nome`                    | `Nome`            | `C3:G3`          | Cliente/operação      | Sim                            | Nome do evento, grupo ou referência reconhecível do pedido.                                                                |
| `pedido.data_entrega_confirmada` | `Data da Entrega` | `J3:K3`          | Operação              | Sim                            | Data confirmada, nunca apenas o desejo inicial do cliente.                                                                 |
| `pedido.cliente`                 | `Cliente`         | `C4:G4`          | Cliente/CRM           | Sim                            | Pessoa ou organização que contrata o pedido.                                                                               |
| `pedido.aplicacao`               | `Aplicação:`      | `J4:K4`          | Qualificação/operação | Sim                            | Técnica final, por exemplo `SUBLIMAÇÃO TOTAL`; `SEM APLICAÇÃO` é valor explícito.                                          |

> **Supersedido em parte em 02/10/2026 pela
> [ADR 016](docs/adr/016-itens-com-os-sete-pontos-da-ficha.md).** No Pedido,
> nome não bloqueia gerar; cliente acompanha o Contato no pendente e é congelado na confirmação (ADR 018). Aplicação geral deixa de ser escrita, editada ou impressa na v5 (ADR 020); o valor antigo é preservado. Entrega prometida é exigida para gerar.

### 2.2 Itens, partes da peça e grade

Os campos abaixo se repetem nas linhas `7:27`. O CRM deve modelá-los como
itens e linhas de grade, não como posições fixas da planilha.

| ID canônico                  | Rótulo original | Coluna | Origem           | Obrigatoriedade                | Regra                                                              |
| ---------------------------- | --------------- | ------ | ---------------- | ------------------------------ | ------------------------------------------------------------------ |
| `itens[].tipo`               | `Ítem`          | `A`    | Cliente/operação | Obrigatório por item           | Tipo de peça.                                                      |
| `itens[].modelo`             | `Modelo`        | `B`    | Cliente/operação | Obrigatório por item           | Modelo confirmado a partir do catálogo ou decisão assistida.       |
| `itens[].malhas[]`           | `Malha`         | `C`    | Cliente/operação | Obrigatório por item           | Aceita mais de uma especificação, como ocorre nas linhas `C7:C8`.  |
| `itens[].cor_frente`         | `Frente`        | `D`    | Cliente/operação | Obrigatório ou `nao_aplicavel` | Cor/material da frente da peça.                                    |
| `itens[].cor_costas`         | `Costa`         | `E`    | Cliente/operação | Obrigatório ou `nao_aplicavel` | Nome canônico usa “costas”; a exportação preserva o rótulo legado. |
| `itens[].cor_manga_direita`  | `Manga Direita` | `F`    | Cliente/operação | Obrigatório ou `nao_aplicavel` | Não inferir que as duas mangas são iguais.                         |
| `itens[].cor_manga_esquerda` | `Manga Esq`     | `G`    | Cliente/operação | Obrigatório ou `nao_aplicavel` | Não inferir que as duas mangas são iguais.                         |
| `itens[].vies_gola`          | `VIÉS Gola`     | `H`    | Cliente/operação | Obrigatório ou `nao_aplicavel` | Pode conter tipo e cor; o exemplo usa `OLIMPICA` e `VERDE`.        |
| `itens[].vies_mangas`        | `Viés Mangas`   | `I`    | Cliente/operação | Obrigatório ou `nao_aplicavel` | Registrar acabamento e cor quando houver.                          |
| `itens[].grade[].tamanho`    | `TAM`           | `J`    | Cliente/operação | Obrigatório por linha de grade | Valor do catálogo ou tamanho especial preservado como informado.   |
| `itens[].grade[].quantidade` | `Qtd.`          | `K`    | Cliente/operação | Obrigatório por linha de grade | Inteiro maior que zero.                                            |
| `pedido.quantidade_total`    | `Total`         | `K28`  | Sistema          | Sim                            | Soma das quantidades da grade de todos os itens.                   |

Validações obrigatórias:

1. Cada item possui ao menos uma linha de grade.
2. Não existem tamanhos repetidos no mesmo item sem justificativa explícita.
3. A soma da grade é igual à quantidade total confirmada.
4. Item, modelo e malha nunca são recuperados apenas de texto livre no momento
   da emissão: precisam estar estruturados.

> **Supersedido em parte em 02/10/2026 pela
> [ADR 016](docs/adr/016-itens-com-os-sete-pontos-da-ficha.md).** No Pedido, o
> item ganha `itens[].cor`, `itens[].estampa` e `itens[].gola`. Os principais
> passam, pela ADR 020, a tipo, cor, quantidade (soma da grade), técnica, malhas, grade e gola, e
> gerar o pedido exige todos em cada item; modelo, cor de cada parte e viés
> passam a adicionais, que não bloqueiam. A regra 3 vira aviso: a soma da grade
> diferente da quantidade informada não bloqueia.

### 2.3 Observações do pedido

| ID canônico            | Rótulo original           | Célula/intervalo | Origem           | Obrigatoriedade | Regra                                                                                                   |
| ---------------------- | ------------------------- | ---------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `pedido.observacoes[]` | `Observações:` linhas 1–5 | `B31:K35`        | Cliente/operação | Condicional     | Lista ordenada de instruções que não cabem nos campos estruturados. Não substitui um campo obrigatório. |

### 2.4 Campos posteriores de produção

Estes campos fazem parte do arquivo lido, mas não são perguntas da jornada
comercial e não bloqueiam a criação do pedido. Eles começam vazios na Ficha e
são preenchidos por pessoas da produção. No primeiro MVP, o CRM apenas os
preserva no documento.

| ID canônico                       | Rótulo original                 | Célula/intervalo | Responsável   | Momento                   |
| --------------------------------- | ------------------------------- | ---------------- | ------------- | ------------------------- |
| `producao.conferido_arremate_por` | `Conferido para arrematar por:` | `D36`            | Produção      | Conferência para arremate |
| `producao.conferido_arremate_em`  | `Data:`                         | `F36`            | Produção      | Conferência para arremate |
| `producao.arrematado_por`         | `Arrematado:`                   | `H36:I36`        | Produção      | Arremate                  |
| `producao.arrematado_em`          | `Data:`                         | `K36`            | Produção      | Arremate                  |
| `producao.observacao_arremate`    | `OBS:`                          | `A37:E37`        | Produção      | Arremate                  |
| `producao.conferido_embalado_por` | `Conferido / Embalado por:`     | `H37:I37`        | Produção      | Embalagem                 |
| `producao.conferido_embalado_em`  | `Data:`                         | `K37`            | Produção      | Embalagem                 |
| `producao.cores_frente`           | `Cores Frente:`                 | `C38`            | Produção/arte | Separação de cores        |
| `producao.cores_costas`           | `Costas:`                       | `E38`            | Produção/arte | Separação de cores        |
| `producao.cores_manga_direita`    | `Manga Direita:`                | `G38`            | Produção/arte | Separação de cores        |
| `producao.cores_manga_esquerda`   | `Manga Esq:`                    | `I38`            | Produção/arte | Separação de cores        |
| `producao.total_cores_partes`     | `Total:`                        | `K38`            | Produção/arte | Soma das cores por parte  |
| `producao.observacao_cores`       | `OBS:`                          | `A39:G39`        | Produção/arte | Separação de cores        |
| `producao.quantidade_total_cores` | `Qtd total de cores do pedido:` | `K39`            | Produção/arte | Total final validado      |

## 3. Campos complementares e evolução

Contato, qualificação, logística e auditoria sustentam o atendimento atual. Orçamento versionado, cobrança PIX e onboarding na tabela abaixo são o inventário da evolução original, diferida pela ADR 006; não representam API ou fluxo entregue.

| Grupo        | Campos mínimos                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contato      | `contato.nome`, `contato.whatsapp`, `contato.id_externo`, `canal`                                                                                                   |
| Qualificação | `intencao_comercial`, `arte.status`, `arte.arquivos[]`, `estampa.locais[]`, `finalidade`, `perfil_compra`                                                           |
| Logística    | `prazo_desejado`, `modalidade_entrega`, `cidade`, `endereco` quando entrega, `retirada_local` quando retirada                                                       |
| Negociação   | `orcamento.versao`, `valor_proposto`, `valor_final`, `condicao`, `validade`, `aprovado_por`, `aprovado_em`, `motivo_perda`                                          |
| PIX          | `pagamento.status`, `pagamento.valor`, `pix.chave_id`, `pix.chave_mascarada`, `pix.enviado_em`, `pix.mensagem_id`, `comprovante`, `confirmado_por`, `confirmado_em` |
| Boas-vindas  | `onboarding.template_versao`, `onboarding.enviado_em`, `onboarding.mensagem_id`, `onboarding.status`                                                                |
| Auditoria    | autor, origem, valor anterior, valor novo, timestamp e motivo de cada alteração                                                                                     |

## 4. Contrato vigente de Pedido

A coleta é progressiva e não linear. Caixa de Entrada mantém o atendimento;
Pedido pendente é um rascunho que pode ser criado pelo agente ou por pessoa.
Existe no máximo um pendente por conversa e a numeração é reservada na
criação. Não há Kanban, Negócio, avanço de card nem retorno de etapa.

Gerar por dono da conversa ou administrador exige:

- ao menos um item com Tipo de roupa, Cor, Quantidade calculada, Técnica,
  Tecido, Tamanhos e Gola;
- arte do pedido: cliente envia, Silmer cria ou sem estampa; a última é
  exclusiva das outras duas;
- entrega prometida, valor final e condição de pagamento.

Nome do pedido, estampa de referência, cores específicas das partes e viés
são adicionais; não bloqueiam gerar. Técnica pertence ao item e aplicação
geral antiga permanece guardada sem uso na v5. Bot só preenche respostas
inequívocas ainda vazias e não substitui escolha humana (ADR 020).

Confirmar muda de pendente para confirmado e libera impressão v6. Reabrir
preserva número, volta a pendente e bloqueia impressão. Pago em e Entregue em
são datas manuais que não alteram status e não implementam cobrança ou
comprovante. Valor e condição não saem no papel; produção permanece vazia.

## 5. Grupos de perguntas

Os grupos Produto, Especificação, Estampa e Logística orientam perguntas,
sem impor ordem ou gates intermediários. Extrair resposta espontânea, não
repetir dado já conhecido e perguntar quando houver ambiguidade.

1. Acolher e identificar o cliente/pedido pelo contexto autorizado.
2. Coletar tipo de roupa, quantidade, tecido, cor, tamanhos e gola.
3. Perguntar técnica e origem da arte; Sem estampa é resposta explícita.
4. Registrar locais como referência, finalidade, perfil e prazo desejado,
   sem prometer disponibilidade ou viabilidade.
5. Entregar resumo e pendências à pessoa quando briefing estiver completo,
   houver pedido de humano, negociação ou bloqueio não resolvível.

O vendedor completa valor, condição e entrega prometida e gera quando todos
os campos atuais estiverem válidos. Handoff/takeover segue com pessoa até
encerrar (ADR 015), sem devolver ao bot.

## 6. PIX e boas-vindas — evolução diferida

Cobrança, comprovante estruturado, confirmação de pagamento e onboarding
automáticos do desenho P0.1 foram retirados do MVP pela ADR 006. PAY-01..05
mantêm a rastreabilidade futura. Gerar Pedido não dispara esses efeitos e
receber imagem/PDF não prova pagamento. Um fluxo futuro exigirá contrato,
idempotência, autorização e homologação próprios.

## 7. Ficha e operação

PRINT_TEMPLATE seleciona ficha-canonical-v6 (ADR 025). Aprovação provisória do PO vale
para desenvolvimento; Rose e Operação assinam a amostra física antes da
produção. V2–v5 e hashes são imutáveis. Arquivos da arte são enviados e
baixados pela página do pedido e ficam no RustFS (ADR 023); encaminhamento e
aviso automáticos a Rose ainda dependem de contrato e homologação próprios.

## 8. Rastreabilidade do P0.1

Os IDs originais permanecem rastreáveis com interpretação atual ou
diferimento explícito; não são checklist de implementação antiga.

| ID     | Contrato vigente ou situação                                                     | Refinamento                 |
| ------ | -------------------------------------------------------------------------------- | --------------------------- |
| JRN-01 | Encerrar conversa sem exigir Pedido                                              | INB-03 / ADR 004            |
| JRN-02 | Criar ou reutilizar um único Pedido pendente, nunca Negócio                      | INB-02..04 / ADRs 006 e 014 |
| JRN-03 | Campo obrigatório ausente bloqueia gerar, sem bloquear salvar rascunho           | AGT-08 / PFI / TEC          |
| JRN-04 | Geração humana quando campos atuais são válidos; sem avanço linear               | AGT-07 / ADR 006            |
| JRN-05 | Total é calculado pela grade; diferença do relato é aviso                        | PFI / ADR 016               |
| JRN-06 | Cobrança PIX diferida                                                            | PAY-01..02 / ADR 006        |
| JRN-07 | Comprovante estruturado diferido; arquivo recebido não confirma pagamento        | PAY-03 / ADR 006            |
| JRN-08 | Confirmar e imprimir independem de status PIX; boas-vindas automáticas diferidas | ORD / PAY-04..05 / ADR 006  |
| JRN-09 | Corrigir rascunho preserva dados e auditoria; sem retorno de etapa               | AGT-08 / PFI                |

## 9. Fontes atuais

Use RULES.md, CRM-MVP-ESPECIFICACAO.md e os requisitos de CRM/Pedidos MVP.
ADRs 004, 006, 008, 014, 015, 016, 018 e 020 registram os refinamentos.
PRODUCT-READINESS-TECH-LEAD.md preserva o fechamento original do P0 e não
deve ser usado para reintroduzir estados aposentados ou alegar go-live.
