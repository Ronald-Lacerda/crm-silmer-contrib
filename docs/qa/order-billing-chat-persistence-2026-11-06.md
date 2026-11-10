# Persistência de intenções de cobrança, COB-CHAT-B02

PASS para T2. Migração 0063 e serviço PostgreSQL injetável implementados.
Frontend, callback da Inbox e envios reais permanecem fora desta entrega.
Base `bf502a4` mais o patch B02. Requisitos BAPI-05/06/08 e guardas iniciais
de BAPI-07/09, RFC 047 / ADR 076.

## Comportamento entregue

- Intenção, cobrança, job financeiro quando necessário, evento e auditoria
  compartilham a mesma transação e o registro de idempotência cifrado.
- Replay revalida usuário, capacidades, proprietário do pedido/destino e
  vínculo atual. Chave por pedido e ator no fingerprint impedem reutilização
  silenciosa por outro ator. Versões só são exigidas para a nova operação.
- Unicidade de cobrança ativa, intenção raiz, correção e filho de retry
  impede duplicidade mesmo com chaves diferentes. FKs compostas prendem
  cobrança/pedido e retry/cobrança; valor e identidade da intenção são imutáveis.
- Sinal, saldo e correção conservam livro financeiro e histórico. Link anterior
  permanece fechado/conferido; callback tardio fica em revisão. O saldo vem dos
  recebimentos aplicados, com aritmética integral e mínimo nas duas partes.
- Histórico privado junta cobranças, recebimentos, devoluções e eventos de
  intenção. Cursor HMAC por pedido preserva microssegundos e ordenação estável.

## Rastreabilidade das provas

Fonte: `test/order-billing-chat-postgres-live.test.js`. Cada cenário deriva
de BAPI-05/06/08 ou da guarda de admissão de BAPI-07/09, sem provar transporte.

| Critério                                    | Evidência localizada e asserção                                                                 | Resultado                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Replay concorrente e corpo/ator divergentes | L179, L188 `amountCents === 36000`, L189 comparação integral de counts e rejects no mesmo teste | Uma intenção, cobrança, plano, evento, job, idem e auditoria; replay original após avanço de versão.                             |
| Chaves concorrentes diferentes              | L237, L246 comparação integral de counts                                                        | Um vencedor e nenhuma linha de idempotência de comando recusado.                                                                 |
| ACL viva no replay                          | L257, asserts rejects FORBIDDEN após transferência, desativação e remoção de capacidade         | Sem novo efeito ou vazamento da intenção antiga.                                                                                 |
| Rollback atômico                            | L296, L324 `assert.deepEqual(await counts(...), {...zero})`                                     | Falha de auditoria ou de completar idempotência desfaz todos os efeitos; chave pode ser reutilizada após rollback.               |
| Saldo e quitação                            | L341, L349 `balance.amountCents === 84000`                                                      | Sinal36000 + saldo84000, recebido120000, saldo0; quitação bloqueia nova emissão e conserva status comercial.                     |
| Correção                                    | L379, L417 valor24000, L426 anterior36000                                                       | Exige anterior vencida/fechada/sem pagamento; conserva URL e total comercial, rejeita resíduo menor que100.                      |
| Retry                                       | L460, asserts de um fulfilled, mesma charge e contagens de jobs/intents                         | Só falha `before_send`; unknown é recusado; uma retomada por falha e nenhuma nova emissão financeira.                            |
| Link existente                              | L508, contagens de job e cobrança iguais a1                                                     | Uma intenção sobre o mesmo link, sem novo checkout.                                                                              |
| Paginação/privacidade                       | L531, comparação das páginas com o conjunto completo e rejects do cursor                        | Empates de data não perdem eventos; assinatura adulterada e outro pedido são recusados; sem URL/payload privado.                 |
| Guardas no banco                            | L591, rejects23514 e L631 rejects23503                                                          | Identidade/eventos não podem ser apagados/reescritos; retry não pode apontar para outra cobrança.                                |
| Desligamento                                | L635, rejects BILLING_DISABLED e leituras por identidade                                        | Default e false negam submit; leitura autorizada permanece; nenhuma mensagem/comando n8n é criado.                               |
| Vínculo/destino                             | L678, rejects BILLING_TARGET_CONFLICT e comparação do responsável                               | Assunto explícito e contato compatível/verificado; Admin não toma a conversa ao emitir.                                          |
| Estados e valores negativos                 | L747, rejects VERSION_CONFLICT e L800 código422                                                 | Rejeita versões antigas, IA/conversa fechada, pendente, Financeiro, sinal abaixo do mínimo e saldo sem recebimento prévio.       |
| Correção versus pagamento                   | L810, L844 principal36000 e application_valid false                                             | Um recebimento conservado em revisão, sem quitação silenciosa nem nova cobrança de saldo.                                        |
| Mutação comercial concorrente               | L858, L874 rejects VERSION_CONFLICT e L875 counts zero                                          | Lock comum evita admissão sobre acordo alterado.                                                                                 |
| Reversão de identidade concorrente          | L890, L958 `Promise.all([admission,reversal])` e state waiting_link                             | Interleaving sintético reproduz ordem link→identidade do writer legado sem deadlock. A reversão do fixture termina com rollback. |

Mapeamento reverso: os 16 testes se limitam aos critérios acima. Não são
testes de Meta/n8n nem do fluxo visual. Os updates de `failed/unknown` no
fixture preparam estados de recuperação; a origem segura desses estados
ainda deve ser entregue e comprovada na integração de transporte de B03.

## Revisão independente

Revisão Backend/QA somente leitura detectou uma inversão de locks com o
unmerge de Contatos: a intenção travava identidade e depois o link, enquanto
o writer antigo faz link→identidade. O patch mantém a identidade sob lock e
lê os links sem adquirir outro lock. Writers oficiais precisam daquela
identidade para alterar a correlação. O cenário concorrente acima comprova
progresso. Reavaliação independente encerrou sem pendências bloqueantes de T2.
As lacunas de prova de retry cruzado e adulteração de cursor foram cobertas.

## Gates e limites operacionais

- Node 24.20.0/npm 11.19.0, PostgreSQL 17 dedicado local, banco sintético
  `crm_silmer_test`, loopback15439. Nenhum serviço externo foi invocado.
- 16/16 testes novos de persistência; matriz serial com cobrança legada,
  Financeiro e loja: **49/49, zero skips/falhas**.
- Migrações live: **4/4**, incluindo instalação, atualização, concorrência,
  readiness e rollback da aplicação. Nova migração também é reaplicada sem
  duplicidade no fixture B02. Migrações antigas foram preservadas.
- `npm run validate`: **1.776 aprovados, 16 skips condicionais, zero falhas**,
  incluindo build, typecheck, lint e checks do projeto. A suíte nova exige
  TEST_DATABASE_URL no gate geral e foi executada sem skips no gate live.
- CI PostgreSQL passou a incluir o novo arquivo na matriz serial existente.
  A execução remota desse CI só poderá ser afirmada depois do push e do run.
- `git diff --check` e validação estrutural de tasks. Aviso preexistente de
  diagrama não parseável: sequência linear T1→T2→T3→T4 conferida manualmente.

Não houve integração em `server.js`, mudança de flags remotas ou consumidor
externo. A outbox financeira existe apenas no banco sintético dos testes.
B03 deve compor mensagem/outbox da Inbox e reserva final. B04 integra o
backend inicialmente desligado. Não promover B02 isoladamente para emissão:
`waiting_link` em link existente/retry ainda aguarda essa composição.
O frontend e o redesign permanecem independentes e adiados.
