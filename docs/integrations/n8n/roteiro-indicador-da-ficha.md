# Roteiro do indicador da ficha

Mensagens para testar o bot à mão e medir a meta da
[ADR 013](../../adr/013-pedido-do-zero-e-meta-de-meia-ficha.md): em pedido do
zero, o bot preenche pelo menos **50% da ficha** antes de transferir.

Desde a [ADR 024](../../adr/024-atendimento-comeca-pelo-produto.md), o bot
pede o nome e o que o cliente quer personalizar na saudação e, depois,
pergunta só o que o produto precisa. Desde a VND-L02 (conversas reais de
29/10/2026), ele também pergunta o tecido, só para roupa, e se o cliente já tem
a arte, sem nunca oferecer criá-la:

| Produto                             | Pontos que o bot pergunta                                                       | Ficha |
| ----------------------------------- | ------------------------------------------------------------------------------- | ----- |
| Ainda não informado                 | produto, cor, quantidade, onde vai a estampa, arte, para quando                 | 7     |
| Roupa                               | produto, modelo, cor, quantidade, tecido, onde vai a estampa, arte, para quando | 9     |
| Boné                                | produto, modelo, cor, quantidade, onde vai a estampa, arte, para quando         | 8     |
| Bandeira, faixa ou banner           | produto, tamanho, cor, quantidade, onde vai a estampa, arte, para quando        | 8     |
| Outro produto (caneca, chaveiro...) | produto, cor, quantidade, onde vai a estampa, arte, para quando                 | 7     |

A ficha é o nome mais os pontos. O nome sai da conta depois de pedido duas
vezes sem resposta (na saudação e logo em seguida). "Definir com o vendedor"
não conta. Conta o que o workflow grava sozinho: o modelo quando o produto já
o diz ("abadás", "camisas polo"), a cor e o tecido dos kits (abadá e
sublimação total gravam "branca" e "poliéster"), o tecido que o cliente já
disse ("camisa em dry fit") e a arte de peça lisa ("sem aplicação"). A arte é
gravada como "cliente envia a arte", "Silmer cria a arte" (só quando o cliente
pede) ou "sem estampa"; "ainda não tenho" fica "Definir com o vendedor", com a
nota "Cliente ainda não tem a arte". Técnica, tamanhos, gola, personalização
individual e divisão por público nunca são perguntados nem contam: o bot só
grava o que o cliente disser. A bandeira (faixa, banner ou estandarte) tem como
modelo o tamanho: ele vai em `product_model` com o nome do produto ("bandeira 1
x 1,5 m") e aparece no tipo do item da Ficha, nunca na grade de tamanhos.

## Como rodar

- Use o workflow DEV `dev-mvp-simple-14` ou mais novo, com o CRM que aceita
  `audiences` (ADR 025). Cada roteiro precisa de
  uma conversa independente: abra outra sessão isolada do navegador no chat
  manual ou use o webhook DEV com um `wa_id` sintético inédito. Recarregar a
  página não garante um novo `sessionId` e pode continuar a conversa no CRM.
- Mande as mensagens na ordem, uma por vez, e espere a resposta. Desde a
  VND-L02, o bot espera cerca de 8 segundos depois de cada mensagem para
  juntar as que chegarem em sequência; mensagens mandadas juntas recebem uma
  resposta só. Se o bot perguntar outra coisa, responda com o fato do roteiro
  que couber.
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
  da transferência, menos o KPI-05 e o KPI-07; a meta é cada um chegar a 50%
  ou mais. O KPI-05, o KPI-07 e os roteiros EXT são transferidos por regras
  próprias e ficam fora da conta.
- Em todos os roteiros, anote como falha: pergunta de camisa para quem não
  pediu roupa, pergunta de tecido para boné, bandeira ou outro produto,
  pergunta sobre técnica, tamanho ou gola, oferta de criar a arte, elogio à
  escolha do cliente ("ótima escolha", "combinam bem"), termo técnico que o
  cliente não usou e o nome pedido mais de duas vezes.

## Pedido do zero

A coluna "Ficha" é o preenchimento esperado depois da mensagem, com o total
da ficha naquele momento.

### KPI-01 — Cliente que responde uma coisa por vez

| #   | Você manda                                                          | O bot deve                                                                                                                                         | Ficha  |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, boa tarde!                                                      | Apresentar-se como assistente virtual da Silmer e pedir o nome e o que você quer personalizar (camisetas ou outras roupas, bonés ou outro produto) | 0/7    |
| 2   | Sou a Carla. Queria fazer uns uniformes pro time de vôlei da escola | Reagir bem e perguntar o modelo: camiseta comum, manga longa, polo, regata, abadá, baby look ou outro. O produto abre o Pedido pendente            | 2/9    |
| 3   | Camiseta comum, com estampa                                         | Perguntar a cor; "com estampa" fica gravado como técnica                                                                                           | 3/9    |
| 4   | Azul marinho                                                        | Perguntar a quantidade                                                                                                                             | 4/9    |
| 5   | 25                                                                  | Perguntar o tecido: algodão, poliéster ou dry fit, ou outro                                                                                        | 5/9 ✅ |
| 6   | Qual a diferença entre algodão e dry fit?                           | Explicar em palavras simples, sem dizer que a Silmer tem, e perguntar o tecido de novo; não transfere                                              | 5/9    |
| 7   | Dry fit                                                             | Perguntar onde vai a estampa: só na frente, ou também nas costas ou na manga?                                                                      | 6/9    |
| 8   | Na frente, com a logo da escola                                     | Perguntar "Você já tem a arte (ou logo) pronta?", sem oferecer criar                                                                               | 7/9    |
| 9   | Já tenho, mando depois                                              | Perguntar para quando você precisa                                                                                                                 | 8/9    |
| 10  | Preciso até 15 de novembro                                          | Dizer que anotou tudo e transferir (Pré-ficha completa)                                                                                            | 9/9    |
| 11  | Obrigada!                                                           | Ficar calado                                                                                                                                       | —      |

### KPI-02 — Cliente que manda quase tudo de uma vez

| #   | Você manda                                                                                    | O bot deve                                                                                                                        | Ficha  |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi! Me chamo Paulo, preciso de 40 regatas brancas de dry fit pra uma corrida, já tenho a arte | Gravar nome, regatas como produto e modelo, branca, 40, dry fit, arte e gola "regata" sem perguntar; perguntar onde vai a estampa | 7/9 ✅ |
| 2   | Na frente e nas costas                                                                        | Perguntar para quando                                                                                                             | 8/9    |
| 3   | Dia 8 de dezembro                                                                             | Dizer que anotou tudo e transferir (Pré-ficha completa)                                                                           | 9/9    |
| 4   | Valeu                                                                                         | Ficar calado                                                                                                                      | —      |

### KPI-03 — Cliente que pula o nome e deixa pontos para o vendedor

| #   | Você manda                                       | O bot deve                                                                                                                                | Ficha  |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Bom dia, quero fazer camisas polo pra minha loja | Apresentar-se e pedir o nome; não perguntar o modelo (polo já é o modelo)                                                                 | 2/9    |
| 2   | Preta                                            | Reagir ao que você contou e pedir só o nome ("Que legal que você quer camisas polo! Qual é o seu nome?")                                  | 3/9    |
| 3   | 20                                               | Não pedir mais o nome; perguntar o tecido. O nome sai da conta                                                                            | 4/8 ✅ |
| 4   | Tanto faz                                        | Aceitar sem insistir e perguntar onde vai a estampa                                                                                       | 4/8    |
| 5   | Bordado no peito, a logo eu mando depois         | Perguntar para quando                                                                                                                     | 6/8    |
| 6   | Isso o vendedor vê comigo                        | Aceitar sem insistir e transferir (Pré-ficha completa); no resumo, "Nome: não informado." e "Para o vendedor definir: fabrics, needed_by" | 6/8    |
| 7   | Ok                                               | Ficar calado                                                                                                                              | —      |

### KPI-04 — Abadá, com pergunta de preço

| #   | Você manda                                      | O bot deve                                                                                                                                          | Ficha  |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, queria ver uns abadás pro bloco de carnaval | Apresentar-se e pedir o nome; não perguntar modelo, cor nem tecido (abadá é sublimação total em poliéster branco, com gola regata)                  | 4/9    |
| 2   | Juliana                                         | Perguntar a quantidade                                                                                                                              | 5/9 ✅ |
| 3   | Umas 100. Quanto fica cada?                     | Não transferir: "Quem passa o valor é o vendedor, e pra ele já te mandar o preço certinho me conta: onde vai a estampa…"; a quantidade fica gravada | 6/9    |
| 4   | Mas quanto fica?                                | Dizer que os valores são com os vendedores e transferir (Perguntou o valor)                                                                         | 6/9    |
| 5   | Tá bom                                          | Ficar calado                                                                                                                                        | —      |

### KPI-05 — Cliente que começa do zero e depois cita o post

Este roteiro mede as duas regras juntas: a ficha começa, e a menção ao post
transfere na hora.

| #   | Você manda                                            | O bot deve                                                                                                                     | Ficha  |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Oi, sou a Bia, quero fazer camisetas pra minha equipe | Perguntar o modelo                                                                                                             | 2/9    |
| 2   | Camiseta comum, branca                                | Perguntar a quantidade                                                                                                         | 4/9    |
| 3   | 15                                                    | Perguntar o tecido                                                                                                             | 5/9 ✅ |
| 4   | Na verdade quero igual à que vocês postaram ontem     | Avisar que vai chamar um vendedor e transferir na hora; resumo "Não é um pedido do zero"; o Pedido pendente já aberto continua | 5/9    |
| 5   | Ok, obrigada                                          | Ficar calado                                                                                                                   | —      |

### KPI-06 — Boné

| #   | Você manda                               | O bot deve                                                                                                                            | Ficha  |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi! Queria fazer bonés pra minha empresa | Apresentar-se e pedir o nome; nada de camisa                                                                                          | 1/8    |
| 2   | Marcos                                   | Perguntar o modelo do boné: trucker (com tela atrás), aba curva, aba reta ou outro                                                    | 2/8    |
| 3   | Trucker                                  | Perguntar a cor do boné                                                                                                               | 3/8    |
| 4   | Preto com a tela branca                  | Perguntar quantas unidades                                                                                                            | 4/8 ✅ |
| 5   | 50                                       | Perguntar onde vai a personalização: na frente, na lateral ou atrás; nunca o tecido                                                   | 5/8    |
| 6   | Na frente, bordado                       | Perguntar se você já tem a arte (ou logo) pronta                                                                                      | 6/8    |
| 7   | Sim, tenho a logo                        | Perguntar para quando                                                                                                                 | 7/8    |
| 8   | Para o fim do mês                        | Transferir (Pré-ficha completa). No Pedido: tipo "bonés trucker" e gola "NÃO APLICÁVEL"; no resumo, "Dica: boné costuma ser bordado." | 8/8    |
| 9   | Valeu                                    | Ficar calado                                                                                                                          | —      |

### KPI-07 — Ecobag

Mochilas, bolsas e similares estão fora da coleta automática (CHAN-WA-01): o
roteiro confere que o bot transfere sem oferecer opções e fica fora do
indicador.

| #   | Você manda                                                 | O bot deve                                                         | Ficha |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ----- |
| 1   | Boa tarde, sou a Lia. Preciso de 200 ecobags pra um evento | Transferir na hora (Conteúdo não suportado), sem perguntar a ficha | —     |
| 2   | Obrigada                                                   | Ficar calado                                                       | —     |

### KPI-08 — Outro produto

| #   | Você manda                                  | O bot deve                                                                                                                                                          | Ficha  |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, sou o Davi. Vocês personalizam canecas? | Não dizer que a Silmer faz: dizer que anota para o vendedor confirmar, e perguntar a cor (sem modelo nem tecido)                                                    | 2/7    |
| 2   | Brancas, umas 30                            | Perguntar onde vai a estampa                                                                                                                                        | 4/7 ✅ |
| 3   | De um lado só                               | Perguntar se você já tem a arte (ou logo) pronta                                                                                                                    | 5/7    |
| 4   | Ainda não tenho                             | Não gravar "Silmer cria a arte"; perguntar para quando                                                                                                              | 5/7    |
| 5   | Dia 20 de novembro                          | Transferir (Pré-ficha completa); no resumo, "Dica: caneca, squeeze, garrafa e mouse pad costumam ser sublimação; cliente ainda não tem a arte: combinar quem cria." | 6/7    |
| 6   | Ok                                          | Ficar calado                                                                                                                                                        | —      |

### KPI-09 — Sublimação em peça escura

| #   | Você manda                                                    | O bot deve                                                                                                                                                               | Ficha  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Oi, sou o Léo. Quero 40 camisetas pretas com sublimação total | Perguntar o modelo, sem comentar a técnica com o cliente; o tecido fica "poliéster" pela técnica                                                                         | 5/9 ✅ |
| 2   | Comum                                                         | Perguntar onde vai a estampa                                                                                                                                             | 6/9    |
| 3   | Na frente toda                                                | Perguntar se você já tem a arte (ou logo) pronta                                                                                                                         | 7/9    |
| 4   | Vou mandar a arte                                             | Perguntar para quando                                                                                                                                                    | 8/9    |
| 5   | Fim do mês                                                    | Transferir (Pré-ficha completa); no resumo, "Atenção: sublimação em peça escura: a sublimação pede peça branca ou clara."; a cor continua "pretas", como o cliente disse | 9/9    |
| 6   | Ok                                                            | Ficar calado                                                                                                                                                             | —      |

### KPI-10 — Divisão por público e nome e número

| #   | Você manda                                                                                               | O bot deve                                                                                                                                                                                                                                                          | Ficha  |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Oi, sou o Rafa, quero 25 camisetas pro time: 10 masculinas, 10 femininas e 5 infantis, com nome e número | Perguntar o modelo; não perguntar tamanhos nem a divisão                                                                                                                                                                                                            | 3/9    |
| 2   | Comum, azul                                                                                              | Perguntar o tecido                                                                                                                                                                                                                                                  | 5/9 ✅ |
| 3   | Poliéster                                                                                                | Perguntar onde vai a estampa                                                                                                                                                                                                                                        | 6/9    |
| 4   | Escudo na frente e nome e número nas costas                                                              | Perguntar se você já tem a arte (ou logo) pronta                                                                                                                                                                                                                    | 7/9    |
| 5   | O escudo eu tenho                                                                                        | Perguntar para quando                                                                                                                                                                                                                                               | 8/9    |
| 6   | Dia 5 de dezembro                                                                                        | Transferir (Pré-ficha completa); no resumo, "Dica: personalização individual: pedir a lista de nomes, números e tamanhos; divisão por público: cada público vira um item."; o Pedido pendente tem três itens (Masculino 10, Feminino 10 e Infantil 5), sem tamanhos | 9/9    |
| 7   | Valeu                                                                                                    | Ficar calado                                                                                                                                                                                                                                                        | —      |

## Aprendizados de 29/10/2026 (VND-L02)

Uma conversa nova por roteiro. Eles não entram no indicador; conferem as
regras novas.

| ID     | Você manda                                                                                       | O bot deve                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L02-01 | "Oi" e, logo em seguida, "Quero 20 camisetas" (as duas em menos de 8 segundos)                   | Responder uma vez só, considerando as duas: apresentar-se e pedir o nome                                                                                                                                 |
| L02-02 | Uma imagem sem legenda, depois de o bot perguntar a cor                                          | Responder "Recebi sua imagem, já deixei aqui para o vendedor ver." e perguntar a cor de novo; nunca "não consegui abrir" nem transferência por duas tentativas                                           |
| L02-03 | Duas imagens seguidas                                                                            | Uma resposta só, com o mesmo reconhecimento                                                                                                                                                              |
| L02-04 | Um áudio que não dá para ouvir                                                                   | Pedir com gentileza para escrever                                                                                                                                                                        |
| L02-05 | "Sou da Loja Sintética. Vocês fazem parceria? Qual o preço para revendedor? Emitem nota fiscal?" | Responder "Anotei suas perguntas para o vendedor responder uma a uma." e transferir (Pediu um vendedor); no resumo, as perguntas em tópicos e "Dica: Possível parceria/revenda"; nunca "Ótima pergunta!" |
| L02-06 | Ficha de camiseta completa e, por último, "Preciso para amanhã"                                  | Transferir com o aviso de urgência (motivo Urgência) e "Urgência: precisa para amanhã (dd/mm/aaaa)" no resumo                                                                                            |
| L02-07 | "Quero camisa em dry fit" no começo da conversa                                                  | Gravar "dry fit" e nunca perguntar o tecido                                                                                                                                                              |
| L02-08 | Qualquer transferência numa quarta-feira às 17h45                                                | O aviso diz que o horário está perto de acabar e que, se não der tempo hoje, um vendedor responde a partir de amanhã às 9h                                                                               |
| L02-09 | "Camisa Streetwar, preta"                                                                        | Gravar com as palavras do cliente, sem repetir o erro de digitação nem elogiar a escolha                                                                                                                 |

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

| ID      | Você manda                                                        | O bot deve                                                                                                               |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| ZERO-01 | Oi, vi vocês no Instagram e quero fazer 20 camisetas pro meu time | Apresentar-se, pedir o nome e seguir a ficha                                                                             |
| ZERO-02 | Vim pelo anúncio. Vocês fazem camisa personalizada?               | Seguir sem afirmar que a Silmer faz; dizer que o vendedor confirma                                                       |
| ZERO-03 | Preciso das camisas prontas até dia 20                            | Seguir; a data é desejo, não prazo, e não é pronta entrega                                                               |
| ZERO-04 | Quero 50 camisetas com nome e número nas costas                   | Seguir a ficha                                                                                                           |
| ZERO-05 | Quanto custa uma camiseta?                                        | Não transferir na primeira pergunta de preço: dizer que o vendedor passa o valor e pedir o nome e o que vai personalizar |

## Registro

Para cada roteiro, anote: motivo da transferência, "Ficha: X de N" do resumo,
as linhas "Atenção" e "Dica", se o Pedido pendente foi criado (só nos KPI), e
qualquer resposta fora do esperado (veja a lista em "Como rodar").
