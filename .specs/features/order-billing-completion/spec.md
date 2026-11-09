# Cobranças: recebimentos externos, conciliação e interface integrada

Autorizado em 08/11/2026 pelo proprietário. Esta entrega continua as ADRs
058/066 e o ensaio DEV validado; o redesign da master está liberado para
integração real. Mesma worktree, sem produção, pagamentos ou envios reais.

## Problem Statement

O CRM ainda não registra valores recebidos fora da InfinitePay. Avisos
perdidos precisam de consulta verificável ao provedor, sem inventar crédito.
O novo fluxo da Inbox/Pedido existe só no protótipo, e o ensaio financeiro
DEV não executa o transporte nem fica disponível para navegação interativa.

## User Stories

- Como responsável, quero registrar recebimento presencial e ver o saldo
  correto junto aos pagamentos InfinitePay, com autoria e histórico.
- Como responsável, quero conferir pagamento não refletido no CRM e recuperar
  o aviso sem lançar o mesmo dinheiro como recebimento externo.
- Como vendedor, quero gerar/enviar cobrança pelo chat ou pedido, corrigir
  após conferência e cobrar somente o saldo, usando o design atual.
- Como desenvolvedor, quero executar a jornada completa sem provedores reais
  e navegar no CRM DEV autenticado para avaliá-la.

## Assumptions & Open Questions

| Assumption             | Chosen default                                                             | Rationale                                                                              |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Redesign               | Master remota 15edc73b já contida; reutilizar Vue/tokens/componentes       | Usuário liberou frontend e pediu versão mais recente                                   |
| Recebimento externo    | Livro próprio associado ao pedido, sem NSU ou cobrança fictícia            | Fonte externa não pode fingir ser InfinitePay                                          |
| Métodos externos       | cash, pix_external, bank_transfer, card_external                           | Diferencia provedor e forma do recebimento                                             |
| Valor externo          | Inteiro em centavos, mínimo 1, máximo saldo atual                          | Recebimento pode conter centavos; mínimo de emissão não se aplica ao dinheiro recebido |
| Correção de lançamento | Reversão integral auditada com motivo; novo lançamento explícito           | Preserva histórico e não movimenta dinheiro                                            |
| Conciliação            | Identificadores da fatura/transação conhecidos ou informados pelo operador | payment_check exige os quatro identificadores; não há descoberta presumida             |
| Produção               | Flags e credenciais reais permanecem desligadas/intocadas                  | Autorização cobre implementação e DEV, não go-live                                     |

Open questions: none for this implementation. Dados de conta/provedor real
e autorização de transação permanecem no gate operacional independente.

## Requisitos financeiros

- BFIN-01: WHEN um recebimento externo é registrado, THE API SHALL exigir
  responsável atual/Admin ativo, sessão, CSRF/origem, chave idempotente e
  versões sob lock; negar outro vendedor, Financeiro, agente, pedido pendente
  ou da loja e valores inválidos, futuros ou acima do saldo.
- BFIN-02: WHEN 3000 centavos InfinitePay e 7000 externos cobrem pedido de
  10000, THE CRM SHALL manter dois recebimentos com fontes distintas,
  recebido10000/saldo0/quitado, sem criar transação ou link fictício. Data
  efetiva, registro e autoria são distintos; nota privada não aparece em log.
- BFIN-03: WHEN há replay ou concorrência de recebimento/reversão, THE backend
  SHALL produzir um efeito por chave, recusar payload divergente e manter
  saldo, quitação, auditoria e bloqueio de envio na mesma transação.
- BFIN-04: WHEN um lançamento externo é revertido, THE CRM SHALL conservar
  valor/origem/autoria originais, motivo e autor da reversão, recomputar saldo
  e invalidar quitação/check quando necessário, sem movimentar dinheiro.
- BFIN-05: WHEN acordo muda ou chega pagamento tardio de link já enviado,
  THE CRM SHALL conservar recebimentos de ambas as fontes, exigir revisão
  quando houver excesso/acordo antigo e nunca apresentar saldo negativo ou
  prometer cancelamento do link no provedor.
- BFIN-06: WHEN o humano pede conferência, THE API SHALL persistir uma consulta
  com identificadores cifrados e retornar 202/queued; somente n8n/provedor
  podem confirmar pagamento. Ausência de identificadores não significa não
  pago nem autoriza outro link ou lançamento externo substitutivo.
- BFIN-07: WHEN consulta ou reentrega é executada, THE worker/n8n SHALL chamar
  payment_check, verificar cobrança/conta/valor/método/parcelas e persistir
  recebimento idempotente antes do sucesso; paid:false registra não confirmado
  sem crédito. Repetição de consulta é segura e não cria checkout/mensagem.
- BFIN-08: WHILE há candidatos conhecidos pendentes, THE recovery SHALL permitir
  consulta repetida/agendada com limites e histórico de resultado; falhas
  mantêm incerteza verificável. Desativar emissão não interrompe recebimento
  ou consulta autorizada. Nunca assumir API de listagem não documentada.

## Requisitos da interface

- BFUI-01: WHEN a conversa elegível é aberta, THE Inbox SHALL oferecer ação de
  cobrança junto às ações atuais; o diálogo compartilhado exige pedido e
  destino explícitos e revisão do valor, sem disparar efeito ao abrir.
- BFUI-02: WHEN o humano confirma issue/send_existing/balance/correct/retry,
  THE UI SHALL usar o contrato real e versões/idempotência, refletir estados
  de intenção separados de pagamento e impedir retry cego em unknown.
- BFUI-03: WHEN o Pedido ou chat consulta finanças, THE UI SHALL mostrar os
  mesmos totais, cobranças/links anteriores, pagamentos por origem, método,
  parcelas/comprovante disponível e histórico paginado por IDs persistidos.
- BFUI-04: WHEN recebimento externo, reversão ou conferência é solicitado,
  THE UI SHALL revisar valor/data/método ou motivo/identificadores, mostrar
  resultado real e atualizar saldo/histórico, sem alterar apenas Pago em.
- BFUI-05: WHEN flags/permissões/contexto impedem escrita, THE UI SHALL recusar
  operação, preservar consulta autorizada e recarregar versões após conflito;
  respostas de pedido anterior não podem substituir o pedido atual.
- BFUI-06: WHEN usado por teclado, toque, mobile320/390 ou temas claro/escuro,
  THE UI SHALL preservar rascunho, navegação, foco, Escape, nomes acessíveis,
  anúncios de estado e ausência de overflow, com componentes/tokens atuais.

## Requisitos de desenvolvimento

- BDEV2-01: WHEN o transporte DEV executa a mensagem financeira, THE n8n SHALL
  percorrer reserva/preflight/callbacks reais usando sink local, sem WhatsApp;
  duplicidade, contexto alterado e pagamento antes do efeito não geram envio.
- BDEV2-02: WHEN há falha segura ou resultado incerto, THE DEV tests SHALL
  verificar nova tentativa humana do mesmo link somente no caso seguro,
  nenhuma repetição cega, correção após vencimento e callback tardio em revisão.
- BDEV2-03: WHEN o ambiente interativo inicia, THE runner SHALL criar API,
  frontend, PostgreSQL, n8n e simuladores dedicados, permitir login sintético e
  navegação em loopback, sem credenciais ou saída para provedores reais.
- BDEV2-04: WHEN o ambiente para/falha ou o operador pede reset explícito,
  THE runner SHALL controlar somente recursos próprios, manter estados
  consultáveis e remover os recursos descartáveis com comandos reproduzíveis.

## Requirement Traceability

| ID       | Task | Contrato existente        |
| -------- | ---- | ------------------------- |
| BFIN-01  | T1   | COB-01/04/13              |
| BFIN-02  | T1   | COB-03/09/11              |
| BFIN-03  | T1   | COB-04/07/08 e BAPI-06/07 |
| BFIN-04  | T1   | COB-10/16                 |
| BFIN-05  | T1   | COB-10/14/15 e BAPI-08    |
| BFIN-06  | T2   | COB-06/14                 |
| BFIN-07  | T2   | COB-06/07/08/14           |
| BFIN-08  | T2   | COB-14/15                 |
| BFUI-01  | T3   | COB-12 e BAPI-01–05       |
| BFUI-02  | T3   | BAPI-06–10                |
| BFUI-03  | T3   | BAPI-05/11                |
| BFUI-04  | T3   | BFIN-01–08                |
| BFUI-05  | T3   | COB-01/13 e BAPI-03/04/10 |
| BFUI-06  | T3   | COB-12 e REFRESH-05/10    |
| BDEV2-01 | T4   | BAPI-07/09/10             |
| BDEV2-02 | T4   | COB-10/14/15              |
| BDEV2-03 | T5   | BDEV-01–07                |
| BDEV2-04 | T5   | BDEV-04/07                |

## Out of Scope

Não publicar workflow remoto, habilitar produção, cobrar cliente ou realizar
transação/devolução. Não mudar checkout/contrato da loja, dashboard, transporte
real ou infraestrutura de produção. Comprovante externo não cria novo serviço
de upload; nota e referência de lançamento bastam nesta entrega. Estornar
registro não devolve dinheiro. Testes locais não homologam InfinitePay real.
