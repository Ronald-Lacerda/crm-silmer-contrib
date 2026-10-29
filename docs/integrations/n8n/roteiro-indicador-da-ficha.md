# Roteiro do indicador da ficha

Mensagens para testar o bot à mão e medir a meta da
[ADR 013](../../adr/013-pedido-do-zero-e-meta-de-meia-ficha.md): em pedido do
zero, o bot preenche pelo menos **50% da ficha** antes de transferir.

Desde a [ADR 024](../../adr/024-atendimento-comeca-pelo-produto.md), o bot
pede o nome e o que o cliente quer personalizar na saudação e, depois,
pergunta só o que o produto precisa:

| Produto                             | Pontos que o bot pergunta                                          | Ficha |
| ----------------------------------- | ------------------------------------------------------------------ | ----- |
| Ainda não informado                 | produto, cor, quantidade, onde vai a estampa, para quando          | 6     |
| Roupa, boné, mochila ou bolsa       | produto, modelo, cor, quantidade, onde vai a estampa, para quando  | 7     |
| Bandeira, faixa ou banner           | produto, tamanho, cor, quantidade, onde vai a estampa, para quando | 7     |
| Outro produto (caneca, chaveiro...) | produto, cor, quantidade, onde vai a estampa, para quando          | 6     |

A ficha é o nome mais os pontos. O nome sai da conta depois de pedido duas
vezes sem resposta (na saudação e logo em seguida). "Definir com o vendedor"
não conta. Conta o que o workflow grava sozinho: o modelo quando o produto já
o diz ("abadás", "camisas polo", "ecobags") e a cor dos kits (abadá e
sublimação total gravam "branca"). Arte, técnica, tecido, tamanhos, gola,
personalização individual e divisão por público nunca são perguntados nem
contam: o bot só grava o que o cliente disser. A exceção é a bandeira (faixa,
banner ou estandarte), cujo modelo é o tamanho: ele vai em `product_model` com
o nome do produto ("bandeira 1 x 1,5 m") e aparece no tipo do item da Ficha,
nunca na grade de tamanhos.

## Como rodar

- Use o workflow DEV `dev-mvp-simple-14` ou mais novo, com o CRM que aceita
  `audiences` (ADR 025). Cada roteiro precisa de
  uma conversa independente: abra outra sessão isolada do navegador no chat
  manual ou use o webhook DEV com um `wa_id` sintético inédito. Recarregar a
  página não garante um novo `sessionId` e pode continuar a conversa no CRM.
- Mande as mensagens na ordem, uma por vez, e espere a resposta. Se o bot
  perguntar outra coisa, responda com o fato do roteiro que couber.
- Depois da transferência, mande a última mensagem do roteiro: o bot deve ficar
  calado, porque a conversa está com um vendedor.
- Na Inbox do CRM, abra a transferência e confira o motivo, o resumo com
  "Ficha: X de N (Y%)", as linhas "Atenção" e "Dica" quando o roteiro pedir,
  e o Pedido pendente. O webhook DEV também devolve `ficha_filled` e
  `ficha_total`.
- O Pedido pendente abre na primeira mensagem que preenche um ponto da ficha
  ou um campo que o bot só grava, em geral a que diz o produto; o nome
  sozinho e "Definir com o vendedor" não abrem
  ([ADR 014](../../adr/014-pedido-abre-no-primeiro-ponto-da-ficha.md)). O
  webhook DEV devolve `open_order` e a resposta `order` do CRM;
  `opened: false` é uma falha, registrada como `ORDER_OPEN_FAILED`, e deve ser
  anotada.
- O indicador da rodada é a média da coluna "Ficha" dos roteiros KPI na hora
  da transferência, menos o KPI-05; a meta é cada um chegar a 50% ou mais. O
  KPI-05 e os roteiros EXT são transferidos pela regra do pedido do zero e
  ficam fora da conta.
- Em todos os roteiros, anote como falha: pergunta de camisa para quem não
  pediu roupa, pergunta sobre arte, tecido, técnica, tamanho ou gola, oferta
  de criar a arte, termo técnico que o cliente não usou e o nome pedido mais
  de duas vezes.

## Pedido do zero

A coluna "Ficha" é o preenchimento esperado depois da mensagem, com o total
da ficha naquele momento.

### KPI-01 — Cliente que responde uma coisa por vez

| #   | Você manda                                                          | O bot deve                                                                                                                                                             | Ficha  |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, boa tarde!                                                      | Apresentar-se como assistente virtual da Silmer e pedir o nome e o que você quer personalizar (camisetas ou outras roupas, bonés, mochilas e bolsas, ou outro produto) | 0/6    |
| 2   | Sou a Carla. Queria fazer uns uniformes pro time de vôlei da escola | Reagir bem e perguntar o modelo: camiseta comum, manga longa, polo, regata, abadá, baby look ou outro. O produto abre o Pedido pendente                                | 2/7    |
| 3   | Camiseta comum, com estampa                                         | Perguntar a cor; "com estampa" fica gravado, sem pergunta sobre a arte                                                                                                 | 3/7    |
| 4   | Azul marinho                                                        | Perguntar a quantidade                                                                                                                                                 | 4/7 ✅ |
| 5   | 25                                                                  | Perguntar onde vai a estampa: só na frente, ou também nas costas ou na manga?                                                                                          | 5/7    |
| 6   | Na frente, com a logo da escola                                     | Perguntar para quando você precisa                                                                                                                                     | 6/7    |
| 7   | Qual a diferença entre algodão e dry fit?                           | Explicar em palavras simples, sem dizer que a Silmer tem, e perguntar a data de novo; não transfere                                                                    | 6/7    |
| 8   | Dry fit. Preciso até 15 de novembro                                 | Dizer que anotou tudo e transferir (Pré-ficha completa); o tecido fica gravado                                                                                         | 7/7    |
| 9   | Obrigada!                                                           | Ficar calado                                                                                                                                                           | —      |

### KPI-02 — Cliente que manda quase tudo de uma vez

| #   | Você manda                                                                                    | O bot deve                                                                                                                        | Ficha  |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi! Me chamo Paulo, preciso de 40 regatas brancas de dry fit pra uma corrida, já tenho a arte | Gravar nome, regatas como produto e modelo, branca, 40, dry fit, arte e gola "regata" sem perguntar; perguntar onde vai a estampa | 5/7 ✅ |
| 2   | Na frente e nas costas                                                                        | Perguntar para quando                                                                                                             | 6/7    |
| 3   | Dia 8 de dezembro                                                                             | Dizer que anotou tudo e transferir (Pré-ficha completa)                                                                           | 7/7    |
| 4   | Valeu                                                                                         | Ficar calado                                                                                                                      | —      |

### KPI-03 — Cliente que pula o nome e deixa a data para o vendedor

| #   | Você manda                                       | O bot deve                                                                                                                       | Ficha  |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Bom dia, quero fazer camisas polo pra minha loja | Apresentar-se e pedir o nome; não perguntar o modelo (polo já é o modelo)                                                        | 2/7    |
| 2   | Preta                                            | Reagir ao que você contou e pedir só o nome ("Que legal que você quer camisas polo! Qual é o seu nome?")                         | 3/7    |
| 3   | 20                                               | Não pedir mais o nome; perguntar onde vai a estampa. O nome sai da conta                                                         | 4/6 ✅ |
| 4   | Bordado no peito, a logo eu mando depois         | Perguntar para quando                                                                                                            | 5/6    |
| 5   | Isso o vendedor vê comigo                        | Aceitar sem insistir e transferir (Pré-ficha completa); no resumo, "Nome: não informado." e "Para o vendedor definir: needed_by" | 5/6    |
| 6   | Ok                                               | Ficar calado                                                                                                                     | —      |

### KPI-04 — Abadá, com pergunta de preço

| #   | Você manda                                      | O bot deve                                                                                                                 | Ficha  |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, queria ver uns abadás pro bloco de carnaval | Apresentar-se e pedir o nome; não perguntar modelo nem cor (abadá é sublimação total em poliéster branco, com gola regata) | 3/7    |
| 2   | Juliana                                         | Perguntar a quantidade                                                                                                     | 4/7 ✅ |
| 3   | Umas 100. Quanto fica cada?                     | Dizer que os valores são com os vendedores e transferir (Perguntou o valor); a quantidade fica gravada                     | 5/7    |
| 4   | Tá bom                                          | Ficar calado                                                                                                               | —      |

### KPI-05 — Cliente que começa do zero e depois cita o post

Este roteiro mede as duas regras juntas: a ficha começa, e a menção ao post
transfere na hora.

| #   | Você manda                                            | O bot deve                                                                                                                     | Ficha  |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Oi, sou a Bia, quero fazer camisetas pra minha equipe | Perguntar o modelo                                                                                                             | 2/7    |
| 2   | Camiseta comum, branca                                | Perguntar a quantidade                                                                                                         | 4/7 ✅ |
| 3   | 15                                                    | Perguntar onde vai a estampa                                                                                                   | 5/7    |
| 4   | Na verdade quero igual à que vocês postaram ontem     | Avisar que vai chamar um vendedor e transferir na hora; resumo "Não é um pedido do zero"; o Pedido pendente já aberto continua | 5/7    |
| 5   | Ok, obrigada                                          | Ficar calado                                                                                                                   | —      |

### KPI-06 — Boné

| #   | Você manda                               | O bot deve                                                                                                                            | Ficha  |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi! Queria fazer bonés pra minha empresa | Apresentar-se e pedir o nome; nada de camisa                                                                                          | 1/7    |
| 2   | Marcos                                   | Perguntar o modelo do boné: trucker (com tela atrás), aba curva, aba reta ou outro                                                    | 2/7    |
| 3   | Trucker                                  | Perguntar a cor do boné                                                                                                               | 3/7    |
| 4   | Preto com a tela branca                  | Perguntar quantas unidades                                                                                                            | 4/7 ✅ |
| 5   | 50                                       | Perguntar onde vai a personalização: na frente, na lateral ou atrás                                                                   | 5/7    |
| 6   | Na frente, bordado                       | Perguntar para quando                                                                                                                 | 6/7    |
| 7   | Para o fim do mês                        | Transferir (Pré-ficha completa). No Pedido: tipo "bonés trucker" e gola "NÃO APLICÁVEL"; no resumo, "Dica: boné costuma ser bordado." | 7/7    |
| 8   | Valeu                                    | Ficar calado                                                                                                                          | —      |

### KPI-07 — Ecobag

| #   | Você manda                                                 | O bot deve                                                             | Ficha  |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| 1   | Boa tarde, sou a Lia. Preciso de 200 ecobags pra um evento | Perguntar a cor; não perguntar o modelo, porque "ecobag" já é o modelo | 4/7 ✅ |
| 2   | Cru                                                        | Perguntar onde vai a estampa                                           | 5/7    |
| 3   | Só de um lado                                              | Perguntar para quando                                                  | 6/7    |
| 4   | Dia 30                                                     | Dizer que anotou tudo e transferir (Pré-ficha completa)                | 7/7    |
| 5   | Obrigada                                                   | Ficar calado                                                           | —      |

### KPI-08 — Outro produto

| #   | Você manda                                  | O bot deve                                                                                                        | Ficha  |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, sou o Davi. Vocês personalizam canecas? | Não dizer que a Silmer faz: dizer que anota para o vendedor confirmar, e perguntar a cor (sem modelo)             | 2/6    |
| 2   | Brancas, umas 30                            | Perguntar onde vai a estampa                                                                                      | 4/6 ✅ |
| 3   | Logo de um lado só                          | Perguntar para quando                                                                                             | 5/6    |
| 4   | Semana que vem                              | Transferir (Pré-ficha completa); no resumo, "Dica: caneca, squeeze, garrafa e mouse pad costumam ser sublimação." | 6/6    |
| 5   | Ok                                          | Ficar calado                                                                                                      | —      |

### KPI-09 — Sublimação em peça escura

| #   | Você manda                                                    | O bot deve                                                                                                                                                               | Ficha  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Oi, sou o Léo. Quero 40 camisetas pretas com sublimação total | Perguntar o modelo, sem comentar a técnica com o cliente                                                                                                                 | 4/7 ✅ |
| 2   | Comum                                                         | Perguntar onde vai a estampa                                                                                                                                             | 5/7    |
| 3   | Na frente toda                                                | Perguntar para quando                                                                                                                                                    | 6/7    |
| 4   | Fim do mês                                                    | Transferir (Pré-ficha completa); no resumo, "Atenção: sublimação em peça escura: a sublimação pede peça branca ou clara."; a cor continua "pretas", como o cliente disse | 7/7    |
| 5   | Ok                                                            | Ficar calado                                                                                                                                                             | —      |

### KPI-10 — Divisão por público e nome e número

| #   | Você manda                                                                                               | O bot deve                                                                                                                                                                                                                                                          | Ficha  |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, sou o Rafa, quero 25 camisetas pro time: 10 masculinas, 10 femininas e 5 infantis, com nome e número | Perguntar o modelo; não perguntar tamanhos nem a divisão                                                                                                                                                                                                            | 3/7    |
| 2   | Comum, azul                                                                                              | Perguntar onde vai a estampa                                                                                                                                                                                                                                        | 5/7 ✅ |
| 3   | Escudo na frente e nome e número nas costas                                                              | Perguntar para quando                                                                                                                                                                                                                                               | 6/7    |
| 4   | Dia 5 de dezembro                                                                                        | Transferir (Pré-ficha completa); no resumo, "Dica: personalização individual: pedir a lista de nomes, números e tamanhos; divisão por público: cada público vira um item."; o Pedido pendente tem três itens (Masculino 10, Feminino 10 e Infantil 5), sem tamanhos | 7/7    |
| 5   | Valeu                                                                                                    | Ficar calado                                                                                                                                                                                                                                                        | —      |

## Não é pedido do zero: transferência imediata

Cada linha é uma conversa nova com uma única mensagem, seguida de "ok". O bot
não pergunta nada da ficha, avisa "Claro! Vou chamar um dos nossos vendedores
para te ajudar com isso, e o atendimento continua aqui mesmo." e transfere. Na
Inbox, o motivo é "Pediu uma pessoa", o resumo começa com "Não é um pedido do
zero" e nenhum Pedido pendente novo aparece. O "ok" seguinte não tem resposta.

| ID     | Você manda                                                                   | O que testa                             |
| ------ | ---------------------------------------------------------------------------- | --------------------------------------- |
| EXT-01 | Quero a camisa do post                                                       | Peça postada                            |
| EXT-02 | Quero essa camisa                                                            | Peça mostrada                           |
| EXT-03 | Oi! Pode me enviar o catálogo por e-mail?                                    | Outro canal: e-mail                     |
| EXT-04 | Me chama no WhatsApp, por favor                                              | Outro canal: WhatsApp                   |
| EXT-05 | Vi no story a camisa do Outubro Rosa, ainda tem?                             | Peça postada, com pergunta de estoque   |
| EXT-06 | Tem pronta entrega?                                                          | Peça pronta                             |
| EXT-07 | Já falei com a moça da loja sobre as camisas do time, queria saber como está | Algo já combinado                       |
| EXT-08 | Quero repetir o pedido do ano passado, as mesmas 30 camisas                  | Pedido anterior; só o modelo identifica |
| EXT-09 | https://www.instagram.com/p/exemplo quero essa                               | Link                                    |
| EXT-10 | Pode me ligar? Prefiro resolver por telefone                                 | Outro canal: ligação                    |
| EXT-11 | Quero 10 da camisa do Outubro Rosa que vocês postaram                        | Intenção de compra não abre Pedido      |
| EXT-12 | Quero esse boné                                                              | Boné mostrado                           |

## Pedido do zero: o bot segue a ficha

Também uma conversa nova por linha. O bot não transfere; segue a ficha com a
próxima pergunta.

| ID      | Você manda                                                        | O bot deve                                                         |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| ZERO-01 | Oi, vi vocês no Instagram e quero fazer 20 camisetas pro meu time | Apresentar-se, pedir o nome e seguir a ficha                       |
| ZERO-02 | Vim pelo anúncio. Vocês fazem camisa personalizada?               | Seguir sem afirmar que a Silmer faz; dizer que o vendedor confirma |
| ZERO-03 | Preciso das camisas prontas até dia 20                            | Seguir; a data é desejo, não prazo, e não é pronta entrega         |
| ZERO-04 | Quero 50 camisetas com nome e número nas costas                   | Seguir a ficha                                                     |
| ZERO-05 | Vocês fazem mochila com a logo da escola?                         | Seguir sem afirmar que a Silmer faz; pedir o nome                  |

## Registro

Para cada roteiro, anote: motivo da transferência, "Ficha: X de N" do resumo,
as linhas "Atenção" e "Dica", se o Pedido pendente foi criado (só nos KPI), e
qualquer resposta fora do esperado (veja a lista em "Como rodar").
