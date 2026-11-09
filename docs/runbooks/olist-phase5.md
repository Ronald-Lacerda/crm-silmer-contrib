# Olist — Fase 5: validação e preparação operacional

## T14 — revisão adversarial e regressão integrada (08/11/2026)

OLIST-01–50 da [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md), sobre
as entregas T11–T13 e T25 da [Fase 4](olist-phase4.md). **T14 está em andamento**:
a revisão terminou e parte dos achados foi corrigida; os itens abaixo marcados
como pendentes bloqueiam o gate F5. Geração real segue desligada, sem deploy,
conta habilitada, credencial ou piloto.

### Método

Quatro verificações independentes sobre `codex/olist-phase4-t11` em `baf7a884`,
três somente leitura e uma de execução, todas com dados sintéticos:

| Frente                                        | Escopo                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Segurança, privacidade, ACL, OAuth, front-end | OLIST-02–05, 12, 25–27, 32–33, 48                                                               |
| Concorrência, recuperação e integridade       | OLIST-13–17, 28–30, 36–41, 45–47                                                                |
| Rastreabilidade e regressão integrada         | Matriz OLIST-01–50 × teste, tabela de 30 cenários da RFC, Usuários/Pedido/Financeiro/loja/ficha |
| Execução SQL real                             | PostgreSQL 17.10, concorrência 1, banco recriado antes de cada suíte, `npm audit`               |

### Evidência executada

| Verificação                           | Resultado                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `test:olist:live`                     | 175/175, zero falhas, cancelados ou pulados                                                       |
| `test:orders:live`                    | 38/38                                                                                             |
| `test:finance:live`                   | 11/11                                                                                             |
| `test:identity:live`                  | 13/13                                                                                             |
| `test:operation-read:live`            | 2/2                                                                                               |
| painel e assistência de pedido (live) | 12/12                                                                                             |
| `npm audit --audit-level=high`        | Zero altas/críticas; uma baixa (`fastify`) e cinco moderadas (`eslint`, `fast-uri`, `ip-address`) |

PostgreSQL local não equivale a EasyPanel. Nada aqui comprova operação real.

### Achados e disposição

Nenhum crítico de duplicação de efeito, de dinheiro ou de cancelamento contra o
worker: reserva commitada antes de cada POST, incerteza sem repetição, soma em
inteiros e comparação por linha e total estão cobertas por testes SQL.

| Achado                                                                                                                                                       | Sev.                 | Disposição                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Os GET `administration` e `reconciliations` respondiam sempre 403 na fiação real (ações fora de `OPERATIONAL_READ_ACTIONS`); a T13 só os exercitou com mocks | Alto                 | **Corrigido**; teste com o runtime de identidade real (Admin 200; Vendedor/Financeiro habilitado 403)                                                                     |
| Dado remoto inválido (nome vazio, id inválido) virava `INVALID_REQUEST` 400 e derrubava a prévia de todos                                                    | Médio                | **Corrigido**: `OLIST_INVALID_RESPONSE` 502, mensagem fixa                                                                                                                |
| Códigos alcançáveis fora de `CODES` viravam 503                                                                                                              | Baixo                | **Corrigido**: cinco códigos mapeados em 409                                                                                                                              |
| `open()` sem `authTagLength` nem validação de IV/tag em envelope enviado pelo cliente                                                                        | Baixo                | **Corrigido**                                                                                                                                                             |
| Export que para antes do efeito (mudança de versão, de settings, reconexão, revogação, quota) fica sem saída e congela o Pedido                              | Alto                 | **Pendente, decidido em 08/11/2026**: comando administrativo que invalida export sem tentativa de venda e libera o Pedido (ADR/RFC próprios)                              |
| Quota fixa de 30/min sem espera, compartilhada com a prévia: falha terminal e leitura pós-venda vira incerteza                                               | Alto                 | **Pendente, decidido em 08/11/2026**: espera/backoff somente leitura e folga reservada para a leitura pós-venda                                                           |
| Comprador (ou produto) recorrente fica bloqueado após mudança cadastral (`payload_hash` imutável)                                                            | Alto                 | **Risco aceito do piloto** (decisão de 08/11/2026): o primeiro caso é de cadastro novo; contorno manual no runbook T15; revisão de base fica no backlog                   |
| Restore sem trava técnica (flags vivem no banco restaurado)                                                                                                  | Alto                 | **Risco aceito do piloto** (decisão de 08/11/2026): interlock procedural no runbook T15; marcador de época verificado no boot fica no backlog                             |
| Numeração colide com `origin/master` (migrations 0058/0061/0062, ADRs 059/060, RFC 044) e a master tem leitores que ignoram `cancelled_at`                   | Crítico (integração) | **Corrigido na integração de 08/11/2026** (seção [Integração com a master](#integração-com-a-master)): renumeração, replay linear e guardas `cancelled_at` com testes SQL |
| OLIST-48 (identidade privada da operadora piloto) sem mecanismo; `creationEnabled` fixo em `false`; sem fatia vertical UI→API→worker                         | Médio                | **Pendente** em T15/T17; a fatia vertical sintética precisa existir antes de fechar F5                                                                                    |
| Sem rotação de chaves (`keyVersion` 1, HMAC de identidade determina a conta)                                                                                 | Médio                | Procedimento e limite documentados no runbook T15                                                                                                                         |
| Divergência de contrato: OpenAPI documenta 401 nos dois GET administrativos, o código devolve 403 (todas as rotas Olist)                                     | Baixo                | Registrada; decidir entre ajustar a documentação ou passar `authenticationFailureStatus: 401`                                                                             |

Backlog menor, sem bloqueio de F5: dedupe de produto só por SKU determinístico,
retenção/expurgo de envelopes, congelamento comercial só na aplicação (sem trigger),
`context_key` ao trocar o aplicativo OAuth, classificação de 4xx de POST como
rejeitado, prévia que hasheia todos os recursos da conta, unicidade de ID remoto
entre produto e variação, telemetria Olist inexistente, e os baixos listados na
revisão.

### Lacunas de teste a fechar

- Isolamento por conta (OLIST-05) com duas contas no mesmo banco.
- Cancelados em `openDeliveries`, `storeNew`, `recordFirstPrint`, Inbox, assistência,
  n8n/assunto e cotação de frete; recibo tardio de loja cancelada.
- Metadado de trava de leitura contra PostgreSQL (hoje só com banco falso).
- Rate limit de `order-lookup`, prévia e exportação; composição de workers.
- Projeção Olist e lookup sem o estado cancelado (limite já registrado na T13).
- Cenários SQL de liveness e restore (export parado, quota esgotada na leitura pós-venda).
- Leitor de tela real e zoom: verificação manual, sem automação.

### Estado do gate F5

Aberto. Faltam: correção dos dois altos de liveness (a integração com a master foi feita, aguardando o OK de push),
fatia vertical sintética, mecanismo de identidade do piloto (T15/T17), runbook
operacional (T15) e as lacunas de teste acima. Zero crítico/alto no backlog é
condição do gate; os dois altos aceitos como risco do piloto precisam constar
no aceite do proprietário.

## Integração com a master (08/11/2026)

Sessão própria de integração, conforme a decisão de 08/11/2026: o trabalho das
Fases 2–4 e da T14 parcial (branch `codex/olist-phase4-t11`, HEAD `6fa6fe12`,
45 commits sobre `d7607c40`) foi reaplicado, com histórico linear, sobre a
`origin/master` (`455f80d7`, com INBOX-VEZ-08) na branch `codex/olist-integracao`.
A branch de origem não foi alterada. As Fases 0–1 já existiam na master
(renumeradas: RFC 046/050, ADR 057/062); só os 20 commits posteriores à Fase 1
(F2 → T14) foram reaplicados, um por tarefa, mais cinco commits de integração.
Geração real continua desligada: nenhuma conta, credencial, flag ou deploy foi
tocado; dados só sintéticos.

### Mapa de renumeração

| Tipo      | Antes (branch) | Depois (master integrada) | Observação                                          |
| --------- | -------------- | ------------------------- | --------------------------------------------------- |
| Migration | 0058           | 0063                      | `olist_user_authorization`                          |
| Migration | 0059           | 0064                      | `olist_foundation`                                  |
| Migration | 0060           | 0065                      | `order_olist_sources`                               |
| Migration | 0061           | 0066                      | `olist_resource_resolution`                         |
| Migration | 0062           | 0067                      | `olist_export_command`                              |
| Migration | 0063           | 0068                      | `olist_sale_dispatch`                               |
| Migration | 0064           | 0069                      | `olist_administrative_reads`                        |
| Migration | 0065           | 0070                      | `order_cancellation`                                |
| ADR       | 057            | 057                       | já na master; só uma linha de rastreio mudou        |
| ADR       | 059 (centavos) | 062                       | já na master; sem novo arquivo                      |
| ADR       | 060 (fontes)   | 067                       | 066 foi ocupada pela master (INBOX-VEZ-08)          |
| ADR       | 064 (cancel.)  | 068                       | 064 ficou como lacuna da master, não reutilizada    |
| RFC       | 044 (geração)  | 050                       | já na master; 044 da master é performance comercial |
| RFC       | 046 (centavos) | 046                       | já na master                                        |
| RFC       | 047 (fontes)   | 054                       | 047 da master é cobrança pela conversa; 053 ocupada |

Migrations: o runner aceita lacunas (0059/0060 não existem na master) e recusa
versão duplicada; as Olist ficam depois da última da master (0062), mantendo a
ordem relativa. A renumeração foi aplicada de modo consistente em **todos** os
commits (SQL, testes como `identity-olist-postgres-live` e
`olist-upgrade-compat`, docs, runbooks e comentários), não só no fim, para que
cada commit compile. **Numeração é lida da `origin/master` no momento da
integração**: a master avançou durante o trabalho (ADR 066/RFC 053 chegaram) e
os números de ADR/RFC foram refeitos uma vez. Se avançar de novo antes do merge,
repetir a checagem de ADR/RFC/migration.

### Conflitos e resolução

- `.env.example`, `ops/easypanel/topology.json`: mantidas as variáveis da master
  (checkpoint, cobrança) e as `OLIST_*`; comentário do despacho atualizado.
- `.github/workflows/ci.yml`: a master separou o PostgreSQL em job próprio; a
  chamada `npm run test:olist:live` foi levada para o novo job.
- `ARCHITECTURE.md`, `TECHNICAL-DESIGN.md`, `tasks.md`, índices ADR/RFC: blocos da
  master e do Olist mantidos (master primeiro; índices reordenados por data).
- `docs/api/openapi.v1.yaml`: inserções simultâneas no mesmo ponto; aplicado o
  patch da master sobre a versão Olist e provado que o multiconjunto de linhas é
  exatamente ours + theirs − base; a descrição de `/orders/summary` combinou
  `daily` (master) e cancelados (Olist).
- `apps/worker/src/worker.js`: união de `billingWorker` e dos workers Olist
  (despacho e reconciliação) em tipos, partida e parada.
- `modules/orders/src/adapters/postgres-order-repository.js` (`summary`):
  parâmetros `dailyFrom/dailyTo` da master mais `cancelled_at IS NULL`, inclusive
  no subselect `daily`; `test/order-routes.test.js`: os dois testes preservados.
- `OrderClosingSection`, `OrderMilestonesSection`, `OrderView`: mantidos o estilo
  `quiet`, a regra de cobrança somente leitura e a guarda `canReopen`/`cancelledAt`.

### Leitores da master que ignoravam `cancelled_at`

Regra: pedido cancelado sai de vendas ativas, receita, afazeres, filas, cobrança e
de "pendente" elegível; histórico, pagamento, check e snapshots seguem por ID.

| Leitor                                                                             | Correção                                                                                                                      | Teste SQL novo (`test/cancelled-orders-*`) |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `dashboard-runtime` CTE `sales`                                                    | `cancelled_at IS NULL` (receita, vendas, ticket, checkpoint)                                                                  | `dashboard`                                |
| `dashboard-runtime` afazeres e `decide`                                            | cancelado não gera afazer; adiar/retomar recusa 409 `ACTION_NOT_AVAILABLE`                                                    | `dashboard`                                |
| `lead-outcome-runtime` `has_order`                                                 | cancelado não bloqueia "perdido"; substituto ativo bloqueia                                                                   | `lead-outcome`                             |
| `order-billing-runtime`                                                            | 409 `ORDER_CANCELLED` em emissão, comandos e reserva; recebimento já devido preservado em revisão                             | `billing` (+ teste de rota)                |
| `conversation-shipping-runtime`                                                    | 409 `ORDER_CANCELLED` em cotar/selecionar, sem chamar o provedor                                                              | `shipping` (+ teste de rota)               |
| `PostgresOrderRepository` `summary`, `daily`, `openDeliveries`, `recordFirstPrint` | corretos após a integração (o subselect `daily`, novo na master, foi corrigido)                                               | `orders-repository`                        |
| `postgres-order-conversation-port`                                                 | sem mudança: devolve só IDs de conversa para a lista, que já filtra por `cancellation`                                        | `orders-repository`                        |
| n8n (`ensureSubjectForOrder`, alvo explícito, `previous_orders_count`, payload)    | cancelado não é pendente elegível nem compra anterior; `order_status: "cancelado"`; alvo explícito → `SUBJECT_TARGET_INVALID` | `n8n`                                      |
| `subject-service` (listar/criar assunto, seletor)                                  | `orderStatus: "cancelado"` (rotulado na UI); seletor ordena ativos antes; vínculo por ID preservado                           | `inbox-subject`                            |
| Inbox (repositórios, chip "Pedido pronto", fechamento) e assistência               | já protegidos pela T23; agora cobertos por teste                                                                              | `inbox-subject`                            |

Decisões de produto a confirmar pelo proprietário:

1. Emitir, estornar ou reconciliar cobrança de pedido cancelado é recusado. Um
   recebimento posterior ao cancelamento fica em revisão sem tela de resolução,
   porque o pedido é imutável (ADR 068); fluxo explícito de estorno
   pós-cancelamento exigiria decisão nova.
2. Um assunto de conversa que aponta para pedido cancelado leva o bot a
   `SUBJECT_TARGET_REQUIRED` até o humano escolher outro assunto, como já ocorre
   com pedido confirmado.
3. O seletor de assunto da Inbox ainda mostra o `status` comercial preservado
   (Pendente) para um pedido cancelado; só o `orderStatus` do resumo diz
   "Cancelado". Ajuste de interface fora do escopo desta integração.

### Verificação da integração

Executada em 08/11/2026 sobre a branch integrada, Node 24.20.0, PostgreSQL 17.10
real (`embedded-postgres`, porta 54330, banco `crm_silmer_test` recriado limpo
antes de cada suíte), dados sintéticos:

- `git diff --check`: limpo.
- `npm run validate`: aprovado; 2.288 testes, 2.243 aprovados, 0 falhas, 45 skips
  (as suítes SQL pulam sem banco).
- `npm run test:e2e -- --workers=2`: 758 aprovados, 7 ignorados previstos, 0 falhas.
- `npm audit --audit-level=high`: 0 vulnerabilidades.
- SQL live (testes aprovados/falhos/ignorados): identity 13/0/0, webhook 1/0/0,
  worker 2/0/0, deal 40/0/0, finance 11/0/0, **olist 195/0/0** (inclui as sete
  suítes `cancelled-orders-*`, o teste de migrações do zero e o de upgrade),
  lista serializada do job PostgreSQL do CI da master (cobrança, Inbox, n8n,
  frete, painel, saúde, dashboard, lead-outcome etc.) 214/0/0, orders 38/0/0,
  operation-read 15/0/0.
- Upgrade da master: `olist-upgrade-compat-postgres-live` agora parte exatamente do
  esquema da master (tudo antes de `0063_olist_user_authorization`), insere jobs de
  cobrança e aplica 0063–0070 sem alterar linhas nem predicados existentes.
- Migrações do zero: `migrations-live` (dentro de `test:identity:live`) aplica as
  68 migrations (versões até 0070; lacunas 0059/0060 herdadas da master) em banco vazio; sem versão duplicada.
- Nenhum teste da master foi alterado; o único quebrado pela integração
  (`orders-summary`, forma do predicado do subselect `daily`) foi corrigido no
  código. `test/order-cancellation-*` ganharam `dailyFrom/dailyTo` (tipagem).
