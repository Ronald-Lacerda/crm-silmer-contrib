# RFC 044 — Performance comercial, checkpoint e central de ações

Data: 05/11/2026. Status: decidida no recorte aprovado do protótipo refinado,
registrado na [ADR 059](../adr/059-central-de-acoes-e-performance-comercial.md).
Contrato de implementação: [ACT/PERF/CHK](../../.specs/features/dashboard-actions/spec.md).
Responsável: Tech Lead. ACT-T02 mantém ativação e homologação separadas.

## Demanda e decisões já informadas

O proprietário pediu desempenho por vendedor, cruzamento de vendas com
atendimento e evolução do Dashboard para uma central de ações. Pediu também
um resumo de vendas do dia anterior para os dois sócios pelo WhatsApp da
Inbox. Confirmou envio às **08h, todos os dias, America/Sao_Paulo**, e exibição
separada de atendimentos encerrados e conversas que geraram venda.

Destinatários e telefones foram informados privadamente na conversa de
trabalho. Devem ficar em configuração privada, fora do repositório, fixtures,
logs e exemplos. Nenhum envio ou agendamento foi ativado nesta proposta.

O proprietário confirmou que a venda conta para o **vendedor responsável
pelo pedido**, inclusive quando um administrador executa a confirmação.
Proposta de implementação: preservar o responsável comercial no momento da
confirmação e, separadamente, quem executou o comando.

O proprietário refinou a intenção do Dashboard: para o vendedor, priorizar
perguntas acionáveis após o fechamento ("O pedido já foi pago?", "Já foi
entregue?") e sugestões de retomada ("O cliente não respondeu; chamar de
novo?"). Pagamento e entrega continuam sendo declarações humanas independentes
do fechamento comercial; acompanhamento não termina na confirmação do pedido.

## Evidência do estado atual

O grafo local é de 04/10/2026, commit `c237200a`; a descoberta foi confirmada
nas fontes atuais, na revisão `5bc36118`:

- [DashboardView.vue](../../apps/edge-web/src/views/DashboardView.vue):
  composição por perfil, indicadores e próximo passo. Somente Vendido usa
  o período escolhido. Não há desempenho agregado de vendedores humanos.
- [Resumo de pedidos](../../modules/orders/src/adapters/postgres-order-repository.js):
  vendas por `order_date`, status confirmado e exclusão de testes; guarda
  `confirmed_by`, mas não um crédito comercial imutável separado do executor.
- [Porta de conversas](../../modules/orders/src/adapters/postgres-order-conversation-port.js):
  responsável da conversa é lido do estado atual, sujeito a transferências.
- [Tomada de handoff](../../apps/api/src/conversation-handoff-runtime.js):
  histórico e evento `handoff.claimed`, com vendedor e instante.
- [Repositório da Inbox](../../modules/inbox-channels/src/adapters/postgres-inbox-repository.js):
  mensagens com autor, tomadas diretas e transições auditadas.
- [Encerramento](../../modules/database/migrations/0036_neutral_conversation_closure.expand.sql):
  desfecho `concluido` ou `sem_pedido`, autor e instante terminal.
- [Pedido e Assunto](../adr/032-separar-pedido-conversa-e-assunto.md):
  um ciclo pode ter vários assuntos/pedidos; encerramento não comprova venda.
- [Afazeres de entrega](../../apps/edge-web/src/components/DeliveryTasks.vue)
  e [serviço de pedidos](../../modules/orders/src/application/order-service.js):
  já existe a pergunta de entrega, limitada a pedidos manuais sem conversa,
  confirmados, não teste e do responsável. O comando dedicado não aceita
  pedidos de conversa. Pagamento é registrado no detalhe do pedido, sem fila
  equivalente no Dashboard.

Existência desses registros não comprova cobertura histórica completa de
atribuição, entrega ou conversão. O backfill precisa validar as evidências;
lacunas aparecem como sem atribuição, nunca inferidas do dono atual.

## Métricas propostas

| Medida                      | Regra proposta                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valor vendido               | Mesmo universo comercial do Dashboard: pedidos confirmados, não teste, pela data comercial. Mostrar quantidade de pedidos e ticket médio. Não representa recebimento ou lucro.                                            |
| Atendimentos ativos         | Fotografia atual de conversas abertas atribuídas ao vendedor; separada das métricas de atividade no período.                                                                                                              |
| Conversas atendidas         | Ciclos distintos em que o vendedor enviou ao menos uma resposta humana no período; envio falho ou desconhecido não conta como atendimento efetivo. Não contar mensagens como conversas.                                   |
| Conversas assumidas         | Ciclos distintos em que o vendedor assumiu por claim ou tomada direta no período. Transferências recebidas aparecem separadamente. Repetir uma ação não aumenta a contagem.                                               |
| Atendimentos encerrados     | Ciclos encerrados no período, com autor do encerramento e desfecho. Não tratar `concluido` como venda.                                                                                                                    |
| Conversas com venda         | Ciclos distintos com ao menos um pedido elegível confirmado no período; três pedidos no mesmo ciclo são três pedidos e uma conversa com venda. Pedido manual sem conversa contribui para receita, não para essa contagem. |
| Carteira esperando resposta | Quantidade atual e idade da espera, por vendedor; separada de quem enviou a última resposta e do histórico comercial.                                                                                                     |

Uma conversa atendida por duas pessoas pode contar para ambas as atividades;
o total da empresa deve deduplicar os ciclos, não somar essa coluna. Uma
venda tem um único crédito principal, para o responsável pelo pedido. Vendas da
loja ficam em linha própria, sem vendedor humano inventado; registros sem
atribuição ficam em outra linha. A soma das linhas reconcilia com o total.

Fixar o crédito na confirmação evita que transferência posterior altere
vendas passadas. `confirmed_by` continua registrando o executor. Reabertura
retira o pedido do total corrente, conforme FIN-03; reconfirmação não pode
duplicá-lo. A política de manutenção ou correção do crédito na reconfirmação
precisa ser explicitada na decisão, com histórico preservado.

## Índices e interpretação

- **Ticket médio:** valor vendido dividido por pedidos confirmados elegíveis.
- **Conversão de oportunidades:** assuntos elegíveis recebidos pelo vendedor
  em uma mesma janela, com ao menos uma venda até a data de corte, divididos
  pelo total desses mesmos assuntos. Unidade, atribuição e janela de observação
  devem ser fixadas antes da implementação; assunto sem pedido também entra
  no denominador. Um assunto com vários pedidos conta uma vez no numerador.
- **Resposta dentro do prazo:** primeiras respostas humanas dentro do prazo
  acordado divididas pelos atendimentos elegíveis. Definir expediente antes
  de comparar tempos; fora do expediente não pode ser misturado silenciosamente.
- **Tempo de primeira resposta e espera para assumir:** apresentar mediana,
  percentil 90, quantidade de amostras e espera ainda aberta. Não avaliar
  somente quem já recebeu resposta, omitindo os abandonados na fila.

Divisão por zero ou falta de evidência produz sem amostra, não 0%. Vendas
de ontem divididas por atendimentos de ontem não são conversão: os pedidos
podem resultar de negociações anteriores. Para leitura diária, mostrar os
volumes lado a lado; para conversão, acompanhar as mesmas oportunidades.

Comparação inicial: 7 e 30 dias, com origem, volume e maturidade da amostra.
Conversas administrativas dos sócios e notificações internas não entram no
universo comercial. Não propor nota única ou ranking punitivo antes de
calibrar distribuição de oportunidades, sazonalidade e disponibilidade.

## Checkpoint diário proposto

Fluxo dedicado: Schedule Trigger no n8n → API autorizada de agregados do CRM
→ composição determinística do texto → reserva de envio por destinatário
→ transporte WhatsApp já utilizado pela Inbox → registro do resultado.

- Às 08h, apurar o dia civil anterior em São Paulo, da meia-noite inclusive
  à meia-noite seguinte exclusive. Enviar também em dias sem vendas.
- A mesma apuração alimenta painel e checkpoint. Não consultar o PostgreSQL
  diretamente pelo n8n nem usar IA para somar ou escrever os valores.
- Total vendido, pedidos confirmados, ticket médio e linhas por vendedor;
  loja e sem atribuição explícitos. Exibir data, corte e link autenticado
  para conferência. Não incluir clientes, pedidos individuais ou comprovantes.
- Guardar snapshot do relatório com data, instante de corte e versão da
  regra. Mudanças posteriores aparecem como ajuste; não editar silenciosamente
  o texto enviado nem prometer que uma consulta futura será idêntica ao corte.
- Nova capacidade técnica mínima para ler os agregados e executar a
  notificação; a credencial atual não recebe acesso irrestrito a relatórios.
- Reserva persistida no PostgreSQL do CRM, com chave por relatório/data e
  destinatário privado. A autorização independe de mensagem inbound comercial;
  não fabricar Conversa, Pedido ou `source_revision` para reutilizar o envio
  conversacional. Detalhar o contrato dedicado antes de ativar.
- Resultados independentes para os dois destinos. Não reenviar ao primeiro
  porque o segundo falhou. Resultado desconhecido exige reconciliação;
  retry cego do transporte é proibido. Registrar aceitação pelo provider
  separadamente de entrega confirmada.
- Configurar destinatários de forma privada e validar identidade e entrega
  para ambos. A mensagem inicial dos sócios ajuda a validar o canal, sem
  constituir evidência suficiente de entrega futura ou garantia contra bloqueio.
- Identificar o tráfego administrativo sem criar atendimento comercial ou
  resposta automática do vendedor. Respostas dos sócios não podem vazar o
  relatório nem contam como oportunidades comerciais.
- Mostrar última execução, resultado de cada envio e atraso do checkpoint
  aos administradores autorizados. Não ampliar o acesso à central técnica
  Saúde e erros, restrita pela ADR 055.

Exemplo **inteiramente sintético**:

> Resumo comercial — dia anterior
>
> Vendido: R$ 12.000,00 · 8 pedidos · Ticket médio: R$ 1.500,00
>
> Vendedor A: R$ 7.000,00 · 4 pedidos
>
> Vendedor B: R$ 4.000,00 · 3 pedidos
>
> Loja do site: R$ 1.000,00 · 1 pedido
>
> Sem atribuição: R$ 0,00 · 0 pedidos
>
> Valores de pedidos confirmados; recebimentos não incluídos.

O Schedule Trigger suporta o horário diário e o fuso do workflow; seu
agendamento depende da publicação. Referência: [documentação oficial](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/).
O tratamento de falhas deve manter o resultado persistido no CRM; um
[error workflow](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md)
é apoio e não substitui deduplicação e reconciliação.

## Dashboard como central de ações

Preservar shell Vue, marca, tokens, temas e componentes de `design.md`.
Operação por teclado, foco previsível e celular são critérios de composição.

1. **O que precisa de ação agora:** próximo passo único e fila curta de
   pendências reais, por prioridade, com objeto, responsável, motivo, idade
   e destino direto. Exemplos: responder cliente, assumir conversa,
   revisar sugestão de abertura, completar pendente e conferir entrega.
   Abertura continua humana; não criar pedido ao abrir uma pendência.
2. **Onde o gestor precisa intervir:** espera fora do prazo, desequilíbrio de
   carteira, negociações sem avanço e falhas do assistente. Mostrar uma
   ação possível na permissão existente. Uma taxa baixa leva a investigar
   a amostra, sem diagnóstico causal automático sobre a pessoa.
3. **Resultado e equipe:** vendas no período e resumo por vendedor abaixo
   das ações. No desktop, tabela; no celular, resumo por pessoa com detalhe
   progressivo. Administrador compara a equipe; vendedor vê o próprio
   desempenho, sem exposição adicional da carteira de colegas.

Separar filtros: **operação agora** é uma fotografia atual; **resultado no
período** tem intervalo explícito. O seletor atual continua valendo apenas
para Vendido até emenda aprovada a PNL-02. Cada indicador abre registros
elegíveis no mesmo universo; somas e links não podem discordar.

Começar com regras determinísticas e dados disponíveis. Sugestão de abertura
não significa pedido pronto para confirmar. Silêncio pode fundamentar uma
sugestão explícita de retomada humana, sem inventar compromisso de retorno,
desistência ou vencimento; detalhamento abaixo.
Não criar Kanban, status comercial, tarefas de Negócio ou fechamento em lote.
Encerrar atendimento e confirmar venda mantêm comandos separados e auditados.

## Minha próxima ação: acompanhamento antes e depois da venda

Para o vendedor, a unidade principal é uma providência concreta, ligada a
pedido ou conversa, com contexto e uma decisão possível. Indicadores e
comparações ficam abaixo. Um mesmo pedido pode precisar de conferência de
pagamento e de entrega; agrupar as perguntas sem esconder nenhuma delas.

| Pergunta proposta                                        | Evidência e interação                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O pedido de exemplo já foi pago integralmente?           | Confirmado, não teste, do responsável e sem quitação integral válida registrada. Mostrar data comercial e condição existentes. Oferecer registrar quitação com a data real, abrir pedido/conversa ou lembrar depois. Não usar ausência de registro como prova de inadimplência.              |
| O pedido de exemplo já foi entregue?                     | Confirmado, não teste, do responsável e sem entrega registrada. Mostrar prazo prometido, quando existir. Oferecer registrar entrega, abrir pedido/conversa ou lembrar depois. Prazo passado significa prazo previsto ultrapassado sem confirmação; não comprova que a mercadoria não chegou. |
| Sua última mensagem ficou sem resposta; retomar contato? | Mensagem humana enviada, sem resposta posterior do cliente, após intervalo a definir, em atendimento elegível sob responsabilidade do vendedor. Mostrar a mensagem/data que motivou a sugestão. Oferecer preparar mensagem, adiar ou dispensar esta sugestão.                                |
| Você combinou retornar hoje; abrir conversa?             | Compromisso explícito com data/hora registrado pelo vendedor. Prioridade distinta da sugestão por silêncio. Não inferir compromisso de uma mensagem sem resposta.                                                                                                                            |

As perguntas de pagamento e entrega são conferências internas. Clicar em
"Registrar pagamento" ou "Registrar entrega" não envia mensagem ao cliente.
Retomada abre o composer com contexto; qualquer texto sugerido é revisado e
enviado pela pessoa usando o contrato humano existente, sem automação de
cobrança, envio em lote ou retorno da conversa ao bot.

Pagamento significa **quitação integral**, conforme FINQ-04/18/19. Sinal ou
pagamento parcial não deve marcar o pedido como integralmente pago; não
introduzir saldo a receber ou controle de parcelas nesta fatia. Pedido da
loja já pago pelo gateway não recebe pergunta redundante de pagamento.
Revisão de pagamento legado deve ser nomeada como revisão, preservando a
declaração explícita exigida pelo contrato Financeiro.

A entrega manual atual grava o dia de São Paulo no servidor. A proposta não
autoriza alterar essa regra nem reutilizar silenciosamente seu comando para
pedido de conversa: ampliação exige emenda explícita a PLA-10/11, contrato
autorizado e versionado, preservação de pagamento e auditoria. Conferir
pagamento não deve sobrescrever uma entrega atualizada por outro operador.

"Ainda não" e "Lembrar depois" não registram pagamento/entrega nem apagam a
pendência. Adiamento guarda vencimento do lembrete separado da data comercial
e do prazo prometido. Dispensar uma sugestão de retomada não encerra conversa,
não declara perda e não elimina obrigações do pedido. O estado mínimo desses
lembretes precisa de contrato próprio no PostgreSQL existente, sem reutilizar
Negócio. Revalidar elegibilidade antes da ação; resposta nova do cliente,
registro do pagamento/entrega ou mudança de responsável atualizam a fila.

Intervalo de silêncio, expediente, limite de sugestões, duração do adiamento
e elegibilidade após encerramento permanecem decisões abertas. Falha ou
resultado desconhecido de envio exige resolver o envio, não sugerir cobrança
de resposta do cliente. Começar com retornos acordados e expor sugestões por
silêncio somente com motivo explícito e decisão humana, sem criar certeza
sobre intenção ou interesse do cliente.

Prioridade proposta: cliente esperando resposta e retorno acordado vencido;
conferências com prazo real ultrapassado; pedido pronto para ação; demais
conferências e sugestões de retomada. Não classificar pagamento como vencido
sem prazo registrado. Mostrar poucas providências por vez, com "Ver todas",
e manter uma ação principal por região. Cada item informa por que apareceu,
responsável, tempo e objeto; no celular, deve ser resolvido com poucos passos,
teclado/foco e retorno previsível após sucesso.

Medir impacto por redução de esperas e registros pendentes, retornos feitos
e vendas posteriores na mesma oportunidade; não por cliques em "Concluído",
quantidade de cobranças ou dispensas de sugestões. Confirmar pagamento ou
entrega não cria nova venda nem aumenta a conversão comercial.

## Rastreabilidade e entregas propostas

Base vigente: [FIN-01–03, PNL-01–04 e PRV-01–03](../../.specs/features/crm-mvp/spec.md),
[T130/T131](../../.specs/features/pedidos-mvp/tasks.md),
[OA-01–12](../../.specs/features/order-assistance/spec.md),
[PLA-04–12](../../.specs/features/pedidos-mvp/spec.md) e
[FINQ-04/18/19](../../.specs/features/financeiro/spec.md),
ADRs [032](../adr/032-separar-pedido-conversa-e-assunto.md),
[036](../adr/036-padroes-de-jornada.md) e
[055](../adr/055-central-de-erros-restrita-a-conta-operadora.md).

Os IDs abaixo preservam o planejamento inicial. O recorte aprovado é rastreado
em ACT-T01 e nos critérios ACT/PERF/CHK; nota única, coortes e reconstrução
histórica sem evidência continuam fora desta entrega:

| Tarefa     | Entrega e evidência esperadas                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC044-T00 | Análise e proposta deste documento; sem mudança de runtime ou ativação.                                                                                                                                     |
| PERF-T01   | Aprovar glossário, crédito comercial, reconfirmação, coortes, permissões e corte; publicar spec com IDs PERF-01 em diante e ADR vinculado se houver decisão arquitetural durável.                           |
| PERF-T02   | Apuração e rastreabilidade na API, crédito histórico e backfill validado; provas de soma, transferência, admin confirmando, reabertura, reconfirmação, loja, teste e ausência de amostra.                   |
| PERF-T03   | Desempenho da equipe e próprio, com filtros e detalhe; autorização na API, teclado, foco, temas, 320 px e estados de erro.                                                                                  |
| CHK-T01    | Contrato dedicado, snapshot e envio por destino, workflow n8n e runbook; provar virada do dia, zero vendas, concorrência, execução repetida, falha parcial, timeout desconhecido e retomada sem duplicação. |
| ACT-T01    | Central de ações baseada no domínio, com contagens e destinos consistentes; emendar requisitos PNL explicitamente, validar prioridades e ações negativas.                                                   |

Complemento de ACT-T01: especificar as conferências de pagamento/entrega e
separar lembrete acordado de sugestão de retomada. Critérios negativos incluem
sinal sem quitação, prazo ausente, mensagem falha, resposta posterior, pedido
da loja, adiamento que não resolve obrigação, mudança de responsável e
concorrência entre os registros de pagamento e entrega.

Ordem recomendada após o refinamento: regras das providências e atribuição →
central de ações com conferências e apuração comercial → checkpoint + resumo
da equipe → sugestões de retomada e índices calibrados. O checkpoint pode
preceder a interface completa depois que atribuição e apuração estiverem
corretas. Histórico sem evidência não recebe reconstrução inventada.

Entrega: [branch de implementação](https://github.com/romulosutil/crm-silmer/tree/codex/dashboard-central-actions).
ADR correspondente: 059.
Ativação requer contrato implementado, destinatários privados
validados e testes de entrega reais, além dos gates normais do projeto.
