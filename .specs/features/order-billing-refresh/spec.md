# Atualização da cobrança e protótipo na Inbox atual

Autorizado em 08/11/2026. Escopo: atualizar a worktree com a master, resolver
conflitos, explicar a integração InfinitePay por diagrama e preparar protótipo
local acionado no chat pelo padrão do Melhor Envio. Preserva BAPI-01–10.

## Problem Statement

A worktree tem backend de cobrança pronto, mas antecede a nova Inbox. O
protótipo anterior usa composição visual antiga e não representa a entrada
por botão do chat atual. Integrar as fontes antes de avaliar o frontend.

## User Stories

- Como responsável, quero abrir a cobrança pelas ações do chat e revisar
  destino, pedido e valor antes de confirmar o envio.
- Como responsável, quero ver recebido, saldo, tentativas e link anterior
  para corrigir sem perder histórico ou cobrar novamente um pagamento.
- Como proprietário, quero avaliar o protótipo e entender a integração sem
  ativar cobranças reais.

## Assumptions & Open Questions

- A master de referência é a obtida do remoto origin no início da entrega.
- A aparência segue os componentes e tokens dessa versão, sem tema paralelo.
- Protótipo local usa fixtures em memória; nenhuma credencial é necessária.
- Não há pergunta bloqueante: botão no chat e padrão Melhor Envio foram
  definidos explicitamente pelo proprietário.

Open questions: none.

## Requisitos e critérios de aceite

- REFRESH-01: WHEN a atualização termina, THE branch SHALL conter a master
  atual como ancestral, preservar as capacidades novas da Inbox e os hooks
  financeiros/transacionais, sem conflitos ou alteração de flags reais.
- REFRESH-02: WHEN o usuário abre a conversa no protótipo, THE chat SHALL
  apresentar botão de cobrança no mesmo contexto de ações do Melhor Envio,
  usando a aparência e componentes da versão atual.
- REFRESH-03: WHEN o botão é acionado, THE prototype SHALL permitir revisar
  pedido/destino/valor, gerar e enviar, consultar histórico, corrigir cobrança
  e cobrar saldo, com dados sintéticos e sem chamadas financeiras reais.
- REFRESH-04: WHEN há correção, pagamento parcial ou falha, THE prototype
  SHALL explicar o destino do link anterior, preservar recebimentos e separar
  geração, envio, entrega e pagamento, incluindo resultado incerto sem retry cego.
- REFRESH-05: WHEN a jornada é operada por teclado ou em tela estreita, THE
  prototype SHALL manter foco previsível, Escape, rótulos acessíveis, rascunho
  preservado e ausência de overflow horizontal.
- REFRESH-06: WHEN o diagrama é apresentado, THE diagram SHALL refletir
  intenção humana, persistência/fila, emissão no n8n/InfinitePay, reserva de
  transporte e confirmação de recebimento, sem afirmar ativação real.
- REFRESH-07: WHEN o pedido de demonstração é aberto, THE prototype SHALL
  reutilizar a tela atual do Pedido e apresentar total, recebido, saldo,
  cobranças, validade, links e pagamentos confirmados com comprovantes fictícios.
- REFRESH-08: WHEN cobrança, correção ou pagamento muda no protótipo, THE chat
  and order SHALL refletir os mesmos registros e valores, inclusive ao navegar
  entre telas ou mantê-las abertas simultaneamente, sem duplicar recebimentos.
- REFRESH-09: WHEN o histórico do pedido é consultado, THE prototype SHALL
  mostrar criação, correção, envio e pagamento como eventos distintos, conservar
  a cobrança e o link anteriores e oferecer retorno à conversa vinculada.
- REFRESH-10: WHEN o pedido é usado por teclado ou em tela estreita, THE
  prototype SHALL preservar foco, rótulos, contraste e leitura sem overflow,
  mantendo dados sintéticos e bloqueio de comandos financeiros reais.

## Requirement Traceability

| Critério   | Tarefa | Fronteira                                             |
| ---------- | ------ | ----------------------------------------------------- |
| REFRESH-01 | T1     | integração, CI e preservação do backend BAPI-01–10    |
| REFRESH-02 | T2     | botão e aparência da Inbox atual                      |
| REFRESH-03 | T2     | operações simuladas e revisão                         |
| REFRESH-04 | T2     | histórico, saldo, correção e recuperação              |
| REFRESH-05 | T2     | teclado, foco e telas estreitas                       |
| REFRESH-06 | T3     | diagrama do fluxo conferido contra o código           |
| REFRESH-07 | T4     | detalhes financeiros na tela real do Pedido           |
| REFRESH-08 | T4     | estado e registros compartilhados entre chat e Pedido |
| REFRESH-09 | T4     | histórico, correções, comprovantes e retorno ao chat  |
| REFRESH-10 | T4     | acessibilidade e isolamento da tela do Pedido         |

## Out of Scope

Protótipo para avaliação; não ativa as rotas reais na interface nem publica
workflows ou credenciais. A branch publicada anterior fica preservada.
Dashboard, Olist e homologação financeira remota continuam em suas frentes.
