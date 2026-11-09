# Olist — Fase 5: validação e preparação operacional

## T14 — revisão adversarial e regressão integrada (08/11/2026)

OLIST-01–50 da [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md), sobre
as entregas T11–T13 e T25 da [Fase 4](olist-phase4.md). **T14 está em andamento**:
a revisão terminou e a maior parte dos achados foi corrigida (os dois altos de
liveness em 09/11/2026, ver [Invalidação administrativa e quota](#invalidação-administrativa-e-quota)); os itens abaixo marcados
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

| Achado                                                                                                                                                       | Sev.                 | Disposição                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Os GET `administration` e `reconciliations` respondiam sempre 403 na fiação real (ações fora de `OPERATIONAL_READ_ACTIONS`); a T13 só os exercitou com mocks | Alto                 | **Corrigido**; teste com o runtime de identidade real (Admin 200; Vendedor/Financeiro habilitado 403)                                                                                                                                                                                                                               |
| Dado remoto inválido (nome vazio, id inválido) virava `INVALID_REQUEST` 400 e derrubava a prévia de todos                                                    | Médio                | **Corrigido**: `OLIST_INVALID_RESPONSE` 502, mensagem fixa                                                                                                                                                                                                                                                                          |
| Códigos alcançáveis fora de `CODES` viravam 503                                                                                                              | Baixo                | **Corrigido**: cinco códigos mapeados em 409                                                                                                                                                                                                                                                                                        |
| `open()` sem `authTagLength` nem validação de IV/tag em envelope enviado pelo cliente                                                                        | Baixo                | **Corrigido**                                                                                                                                                                                                                                                                                                                       |
| Export que para antes do efeito (mudança de versão, de settings, reconexão, revogação, quota) fica sem saída e congela o Pedido                              | Alto                 | **Corrigido em 09/11/2026** (T27, [ADR 069](../adr/069-olist-invalidacao-administrativa-de-export.md)): comando administrativo local que invalida a geração sem tentativa de venda e libera o Pedido, mais retry pré-efeito. Evidência na [seção própria](#invalidação-administrativa-e-quota); gates integrados finais a registrar |
| Quota fixa de 30/min sem espera, compartilhada com a prévia: falha terminal e leitura pós-venda vira incerteza                                               | Alto                 | **Corrigido em 09/11/2026** (T28, [ADR 070](../adr/070-olist-quota-com-espera-de-leitura-e-folga.md)): espera somente de leitura e folga reservada para a leitura pós-venda. Evidência na [seção própria](#invalidação-administrativa-e-quota); gates integrados finais a registrar                                                 |
| Comprador (ou produto) recorrente fica bloqueado após mudança cadastral (`payload_hash` imutável)                                                            | Alto                 | **Risco aceito do piloto** (decisão de 08/11/2026): o primeiro caso é de cadastro novo; contorno manual no runbook T15; revisão de base fica no backlog                                                                                                                                                                             |
| Restore sem trava técnica (flags vivem no banco restaurado)                                                                                                  | Alto                 | **Risco aceito do piloto** (decisão de 08/11/2026): interlock procedural no runbook T15; marcador de época verificado no boot fica no backlog                                                                                                                                                                                       |
| Numeração colide com `origin/master` (migrations 0058/0061/0062, ADRs 059/060, RFC 044) e a master tem leitores que ignoram `cancelled_at`                   | Crítico (integração) | **Corrigido na integração de 08/11/2026** (seção [Integração com a master](#integração-com-a-master-08112026)): renumeração, replay linear e guardas `cancelled_at` com testes SQL                                                                                                                                                  |
| OLIST-48 (identidade privada da operadora piloto) sem mecanismo; `creationEnabled` fixo em `false`; sem fatia vertical UI→API→worker                         | Médio                | **Pendente** em T15/T17; a fatia vertical sintética precisa existir antes de fechar F5                                                                                                                                                                                                                                              |
| Sem rotação de chaves (`keyVersion` 1, HMAC de identidade determina a conta)                                                                                 | Médio                | Procedimento e limite documentados no runbook T15                                                                                                                                                                                                                                                                                   |
| Divergência de contrato: OpenAPI documenta 401 nos dois GET administrativos, o código devolve 403 (todas as rotas Olist)                                     | Baixo                | Registrada; decidir entre ajustar a documentação ou passar `authenticationFailureStatus: 401`                                                                                                                                                                                                                                       |

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
- Cenários SQL de liveness (export parado, quota esgotada na leitura pós-venda): **fechados em 09/11/2026**; restore segue aberto.
- Leitor de tela real e zoom: verificação manual, sem automação.

### Estado do gate F5

Aberto. Faltam: os gates integrados finais dos dois altos de liveness, já corrigidos (a integração com a master foi feita, aguardando o OK de push),
fatia vertical sintética, mecanismo de identidade do piloto (T15/T17), runbook
operacional (T15) e as lacunas de teste acima. Zero crítico/alto no backlog é
condição do gate; os dois altos aceitos como risco do piloto precisam constar
no aceite do proprietário.

## Invalidação administrativa e quota

Seção de 09/11/2026. Corrige os dois altos de liveness da revisão T14: export parado sem saída
(OLIST-T27, [ADR 069](../adr/069-olist-invalidacao-administrativa-de-export.md),
OLIST-51) e quota sem espera (OLIST-T28, [ADR 070](../adr/070-olist-quota-com-espera-de-leitura-e-folga.md),
OLIST-52), na [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Implementado no código local da branch `codex/olist-liveness`, ainda sem commit
de integração nesta data. Geração real desligada, sem deploy, conta,
credencial ou piloto; dados só sintéticos; PostgreSQL local não equivale ao
EasyPanel. Decisões D1, D2 e D5 da ADR 069 aguardam confirmação do proprietário.

### Evidência

| Verificação                                                                                                                                                 | Resultado                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL de invalidação (`olist-export-invalidation-postgres-live`), PostgreSQL 17.10 real                                                                       | 21/21 (20 subtestes: corrida, replay, ACL, triggers, reconciliar-e-invalidar, deadlock, lease vencido)                                                                                                                                                                                                                            |
| `test:olist:live` (inclui o SQL de invalidação, o do worker com fila, o upgrade da 0070 para a 0071 e o diagnóstico local com conexão quebrada)             | 236/236                                                                                                                                                                                                                                                                                                                           |
| `test:orders:live`                                                                                                                                          | 38/38                                                                                                                                                                                                                                                                                                                             |
| Unitários `olist-*` e `identity-olist-access` (quota com orçamento cumulativo da API, cliente, despachante, worker, progresso, venda, escritor, resolvedor) | 272/272, executados em 09/11/2026 após as correções da revisão independente                                                                                                                                                                                                                                                       |
| `npm run validate`                                                                                                                                          | Aprovado: 2361 testes, 2314 aprovados, 0 falhas, 47 pulados (suítes SQL, cobertas abaixo); tipos, lint, fronteiras, tokens, validadores e build                                                                                                                                                                                   |
| E2E integral (`npm run test:e2e`; spec novo `test/e2e/olist-liveness-invalidate.spec.js`)                                                                   | 787 aprovados, 7 pulados (`test.skip` literais em `crm-ui.spec.js`), 0 falhas, 0 flaky; 2 workers, porta 4196, build fresco; spec novo com 35 cenários e axe 320/390/1366                                                                                                                                                         |
| `test:identity:live`, `npm audit --audit-level=high`, `git diff --check` do conjunto integrado                                                              | `test:identity:live` 13/13; suítes SQL do CI em PostgreSQL 17.10 real (identity 13, webhook 1, worker 2, deal 40, finance 11, olist 236, orders 38, operation-read 15, database 15, database live 4, lista extra 214), 0 falhas; upgrade da master aplica 0063–0071; `npm audit` com 0 vulnerabilidades; `git diff --check` limpo |

Os números acima vêm dos trabalhadores de banco/dispatcher e da execução dos
unitários; os gates integrados finais serão registrados pelo Tech Lead.
Correções da revisão independente (A1, M1, M2, B1, M5): E2E parcial
`olist-liveness-invalidate`, `olist-t13-recovery` e `olist-t12` com 2 workers,
153/153; `test:orders:live` 38/38. Cada correção foi provada por mutação (a
reversão faz falhar o teste dedicado).

### Procedimento do admin

Somente `COMMERCIAL_ADMIN` (Vendedor com perfil de administração comercial);
Vendedor habilitado e Financeiro recebem 403. A ação aparece como "Invalidar
esta geração" no painel de recuperação do Pedido, ao lado de "Conferir" e
"Vincular", e só enquanto a geração não chegou à venda.

1. **Quando invalidar.** Geração parada em `queued`, `resolving` ou `ready`
   sem nenhuma tentativa de venda: job em `dead_letter` (oito tentativas
   esgotadas por quota, indisponibilidade ou renovação de token), ou causa
   terminal que o retry não resolve (versão do Pedido, das configurações ou do
   contato mudou; `generation` da conexão trocada; autorização revogada e
   reconcedida). Antes, leia o diagnóstico: a ação usa a geração e a versão que
   a tela mostrou.
2. **Reconciliar antes de invalidar.** Se há cadastro `reserved` ou
   `uncertain`, a invalidação é recusada: use "Conferir no Olist"
   (`/reconcile`) **nesse cadastro**, espere o resultado e só então invalide.
   Quando o cadastro fica `confirmed` (com ID remoto), a invalidação passa a ser
   aceita **mesmo que a tentativa antiga continue registrada como `uncertain`**:
   a tentativa é histórico imutável e um cadastro confirmado nunca é postado de
   novo. Tentativa de cadastro `reserved` bloqueia sempre (um POST pode estar em
   voo). Se há tentativa de
   venda de qualquer desfecho, número ou ID de venda, **não invalide**: a venda
   pode existir no Olist; use Conferir e, se for o caso, Vincular venda
   existente. Job em execução (`OLIST_EXPORT_IN_FLIGHT`): aguarde alguns
   segundos (o lease é de 30 s), atualize o diagnóstico e tente de novo.
3. **Motivo.** Obrigatório, de 1 a 1000 caracteres, sem dados pessoais do
   cliente; fica só em envelope cifrado. Em falha de rede (0 ou 5xx), a tela
   relê o diagnóstico; se a geração ainda estiver ativa, reenviar usa a mesma
   chave de idempotência e não duplica o registro.
4. **O que acontece.** A geração vira `invalidated` (histórico, nunca reabre),
   o job é encerrado sem reentrega e o item de reconciliação aberto do job é
   resolvido. **Cadastros já criados no Olist são preservados**: cliente,
   produto e variações confirmados permanecem e a próxima geração os reaproveita
   por identidade. Nada é apagado ou cancelado no Olist e nenhum vínculo é
   removido. Se já existe cadastro confirmado, o Pedido continua congelado
   para edição (D1); se a causa exigia corrigir a ficha, leve ao proprietário.
5. **Nova prévia.** Depois do sucesso, o foco vai a "Conferir prévia Olist".
   Gere a prévia, confira e exporte como de costume: é uma nova linha, com outra
   referência `CRM-…`; a antiga aparece como "invalidada antes de qualquer
   venda". Só pode haver uma geração ativa por Pedido e conta. Pedido
   cancelado não tem o que invalidar (`ORDER_CANCELLED`).

### Códigos de erro

Todos respondem 409 com `application/problem+json`, sem motivo, sem corpo
remoto e sem dados do cliente, exceto onde indicado.

| Código                                   | Significado                                                                                                                          | Ação do admin                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `OLIST_INVALIDATION_BLOCKED`             | Estado fora de `queued`/`resolving`/`ready`, ID ou número de venda, ou qualquer tentativa de venda.                                  | Não invalidar. Conferir no Olist e, se a venda existir, vincular. |
| `OLIST_EXPORT_IN_FLIGHT`                 | O worker segura o job agora (lease vivo; um lease vencido é órfão e não bloqueia). Nada foi alterado.                                | Aguardar alguns segundos, atualizar o diagnóstico e repetir.      |
| `OLIST_RESOURCE_RECONCILIATION_REQUIRED` | Cadastro `reserved`/`uncertain`, tentativa `reserved`, ou tentativa `uncertain` de cadastro ainda não confirmado. Nada foi alterado. | Conferir no Olist (`/reconcile`) o cadastro, esperar e invalidar. |
| `VERSION_CONFLICT`                       | `operationId` ou versão não são mais os atuais (o worker avançou a versão, outra aba, geração já substituída).                       | Atualizar o diagnóstico e decidir de novo.                        |
| `OLIST_EXPORT_UNAVAILABLE`               | O Pedido não tem geração a invalidar.                                                                                                | Atualizar o diagnóstico; se não há operação, gerar uma prévia.    |
| `ORDER_CANCELLED`                        | Pedido cancelado localmente (terminal, ADR 068).                                                                                     | Nada a fazer.                                                     |
| `FORBIDDEN` 403, `ORDER_NOT_FOUND` 404   | Sem perfil `COMMERCIAL_ADMIN`/sessão inválida, ou Pedido inexistente.                                                                | Usar uma conta admin.                                             |
| `OLIST_RATE_LIMITED` 429                 | Só na API de leitura (prévia, administração): a espera de 8 s não bastou. Não afeta a invalidação, que é local e não consome quota.  | Aguardar e repetir; não gerar tempestade de cliques.              |

Uma geração já invalidada devolve o recibo com `replayed: true` (qualquer chave
de idempotência), sem novo evento.

### Parâmetros de quota e retry

| Parâmetro                                            | Valor                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Limite da conta                                      | 30 chamadas por janela de 60 s, **inferido** (o limite real da conta piloto é desconhecido)                    |
| Espera de leitura do worker (despacho, sem ticket)   | até 90 s, teto 30 por janela                                                                                   |
| Espera de leitura com ticket em mãos (conferência)   | até 180 s, teto 30; toda a reconciliação do worker                                                             |
| Espera da API (prévia, consultas, administração)     | até 8 s **no total por requisição** (orçamento cumulativo do cliente), teto 24 por janela (seis ao worker)     |
| `verifyAccount` (após troca de token)                | até 15 s, teto 30                                                                                              |
| Fatia de sono e batimento                            | até 10 s mais jitter de 250 ms, com `heartbeat` do job (lease de 30 s); lease perdido aborta a espera          |
| Folga de escrita (leituras obrigatórias após o POST) | cliente 2, produto 2, variação 3, venda 2; sem folga, falha antes do ticket e do POST                          |
| Retry pré-efeito                                     | só `OLIST_RATE_LIMITED`, `OLIST_UNAVAILABLE` e `OLIST_REFRESH_IN_PROGRESS`, sem ticket e com `assertRetrySafe` |
| Backoff do job                                       | 15 s dobrando até 300 s, com jitter; `max_attempts` 8 (cerca de 17 minutos) e depois `dead_letter`             |
| 429 do provedor                                      | respeita `Retry-After` se vier; sem o cabeçalho, bloqueia a conta por 60 s                                     |

O diagnóstico administrativo (`GET .../olist/administration`) é local e responde
mesmo com a conexão quebrada (`reconnect_required`, token ausente), para que o
botão "Invalidar esta geração" apareça justamente nesse caso; `/reconcile`, vínculo
e prévia continuam exigindo conexão saudável.

Escrita nunca espera nem repete. Leitura pós-venda espera em vez de virar
incerteza. Um hook `prepare` renova o token antes do guard local do despacho.

### O que observar em produção

Não há telemetria Olist própria ainda (backlog); use consultas somente leitura,
sem PII, e a tela de diagnóstico do Pedido.

- **Jobs em `retry` ou `dead_letter`** da fila `olist` (`crm.outbox_jobs`,
  `job_type='olist.export'`): `status`, `attempt_count`/`max_attempts` e
  `last_error_code`. Um job `processing` com `locked_until` vencido é órfão (o
  worker morreu): a invalidação o retira. Um `dead_letter` por `OLIST_RATE_LIMITED`,
  `OLIST_UNAVAILABLE` ou `OLIST_REFRESH_IN_PROGRESS` pede a decisão do admin
  (invalidar ou aguardar); `outcome_unknown` pede antes conferir se há recurso ou venda incertos, e a
  invalidação só é aceita sem tentativa de venda e sem recurso `reserved`/`uncertain`.
- **Versão e código do export** (`crm.olist_exports.version`, `last_error_code`):
  a versão sobe quando o código de falha gravado muda, não a cada tentativa;
  quem leu a versão antiga recebe `VERSION_CONFLICT` e deve reler.
- **Itens de reconciliação abertos** (`crm.reconciliation_items`) e recursos
  `reserved`/`uncertain`: bloqueiam a invalidação.
- **Quota** (`crm.olist_quotas`): `used`, `remaining` e `blocked_until`. Um
  `blocked_until` frequente indica 429; esperas longas indicam janela cheia.
- **Invalidações**: evento `OLIST_EXPORT_INVALIDATED` em `crm.olist_events` e
  auditoria `olist.invalidate`; ambos sem motivo. Muitas invalidações no mesmo
  Pedido indicam causa que a nova geração não resolve.

### Rollback

- **Não fazer rollback de código depois da primeira invalidação.** A migração
  0071 só relaxa a unicidade para "uma operação ativa por Pedido/conta"; código
  anterior roda sobre ela, mas seus leitores usam `rows[0]` sem filtrar o estado
  e podem ler a geração arquivada como a atual. Antes da primeira invalidação, o
  rollback é seguro.
- Para parar o risco, **desligar a criação primeiro**: `OLIST_DISPATCH_ENABLED`
  desligado e `creation_enabled=false` na conta, drenando efeitos em voo; o
  comando de invalidação continua disponível porque é local.
- **Nunca apagar vínculo, cadastro, recibo de invalidação ou histórico** e nunca
  alterar SQL para liberar POST incerto ou reabrir uma geração `invalidated`
  (o banco recusa).
- A quota (ADR 070) não tem migração; voltar o código restaura o `reserve()`
  sem espera, com os riscos dos achados originais.

### Riscos aceitos do piloto: mitigação procedural

1. **Comprador ou produto recorrente com cadastro alterado.** O `payload_hash`
   do recurso é imutável: se o cadastro mudou depois da primeira criação, o
   export para no `OLIST_RESOURCE_DIVERGENT`, e a invalidação **não resolve**,
   porque a nova geração reaproveita o mesmo recurso por identidade e diverge de
   novo. Contorno manual: lançar a venda diretamente no Olist e usar "Vincular
   venda existente" (conferida por cliente, itens e total); nunca editar ou apagar
   o cadastro por fora para forçar a criação. O primeiro caso do piloto é de
   cadastro novo. A revisão de base fica no backlog.
2. **Restore.** Não há trava técnica no banco restaurado (as flags vivem nele).
   Antes de subir o worker: criação desligada (`OLIST_DISPATCH_ENABLED` e
   `creation_enabled=false`) e `recovery_required=true` na conta; reconciliar a
   janela de todos os recursos e vendas antes de religar, como no
   [runbook da fase 3](olist-phase3.md). Uma invalidação feita depois do backup
   pode não constar do banco restaurado: confira a geração ativa de cada Pedido
   antes de religar. O marcador de época verificado no boot fica no backlog.

### Limitações conhecidas

- O 429 não tem `Retry-After` documentado; o fim da janela de 60 s como momento
  de liberação também é premissa.
- O limite real da conta piloto é desconhecido (30 por 60 s inferido); conferir
  na ativação (T15).
- `verifyAccount` espera até 15 s; se a quota ficar bloqueada por mais tempo, a
  conexão ainda é invalidada (`reconnect_required`, `generation + 1`) apesar de o
  token novo ser válido e o refresh antigo já estar gasto; o admin reconecta (M3).
  Persistir o token e verificar depois exigiria um estado "instalado, não verificado"
  (migração) e deixaria um token possivelmente de outra conta utilizável; a mudança
  segura e pequena seria pré-reservar a unidade de leitura **antes** de gastar o
  refresh token e, se a espera estourar, liberar a reivindicação sem invalidar. Ver
  a [ADR 070](../adr/070-olist-quota-com-espera-de-leitura-e-folga.md).
- **Export com muitas variações (M4, mitigada).** A re-execução com todos os
  cadastros `confirmed` relia `4 + P + 2V` itens (P produtos, V variações): 30
  leituras para V=12 e P=2, e a venda (precisa de `used <= 27` no
  `reserveWrite`) era recusada nas oito tentativas, com `dead_letter` sem POST.
  Agora cada execução lê o cliente, cada pai e cada variação **uma vez**
  (`3 + P + V`: 17 leituras para V=12 e P=2, 9 para V=5 e P=1) e a venda
  encontra folga. A execução limpa não mudou (43 e 25 GETs). Invariantes: o
  cache vale só dentro de uma execução (nada entre jobs, execuções ou processos); leitura de conferência
  com ticket e leitura depois de POST **nunca** vêm do cache, e o POST descarta as
  entradas do recurso; erros e "não encontrado" não são cacheados; a primeira
  leitura de cada entidade continua comparando com o vínculo. Capacidade: V <= 22
  com dois produtos (V <= 23 com um); acima disso o job ainda pode ir a
  `dead_letter` sem POST da venda (cada tentativa recomeça numa janela vazia e lê
  mais de 27), e a saída continua sendo invalidar e dar mais janela. Ver a
  [ADR 070](../adr/070-olist-quota-com-espera-de-leitura-e-folga.md).
- **429 real do provedor numa leitura (B2)**: a leitura não é repetida depois do
  bloqueio da conta; sem ticket o retry pré-efeito do job cobre, com ticket o item
  vai à reconciliação. Repetir o GET fica no backlog.
- A prévia/consulta da API respeita 8 s **no total** por requisição (e não por
  leitura); estouro responde 429 com `retryAfterMs`.
- `max_attempts` é 8 (padrão da fila) e o backoff é fixo no código: cerca de 17
  minutos e depois `dead_letter`, sem alerta automático.
- Sem auto-invalidação ao esgotar os retries (D5): um job esgotado fica parado
  até o admin agir.
- A versão do export só muda quando o código de falha muda; a tela pode receber
  `VERSION_CONFLICT` quando o worker avança entre a leitura e o envio.
- Pedido com cadastro ERP confirmado segue congelado para edição (D1).
- `markEffectStarted` tardio ficou de fora (D3): a perda do lease depois do
  início do job continua tratada como possível efeito.
- Cache de catálogos da prévia não foi implementado; prévias repetidas consomem
  a quota da API.
- Causas como `generation + 1`, autorização revogada e reconcedida e mudança de
  versão do Pedido, configurações ou contato continuam terminais e dependem da
  invalidação.
- Código que presume uma única linha de export por Pedido está incorreto desde a
  0071: usar sempre a geração ativa (ou a mais recente invalidada para exibição).
- `OLIST_EXPORT_IN_FLIGHT` não espera: o admin repete a ação.

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
