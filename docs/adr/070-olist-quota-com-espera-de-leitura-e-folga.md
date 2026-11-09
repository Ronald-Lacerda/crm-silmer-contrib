# ADR 070 — Olist: quota com espera de leitura e folga para a leitura pós-venda

Data: 09/11/2026. Status: decisão técnica adotada para OLIST-T28, no escopo
autorizado da [ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md).
Decisor técnico: Tech Lead. Proposta e acompanhamento: [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Requisitos OLIST-16, 17, 26 e OLIST-52; tarefa OLIST-T28 no
[plano](../../.specs/features/crm-mvp/tasks.md). Achado de origem: o alto de
liveness da revisão T14 sobre a quota, no
[runbook da fase 5](../runbooks/olist-phase5.md). Sem issue/PR específica;
implementação local na branch `codex/olist-liveness`. Complementa a ADR 057 e a
[ADR 069](069-olist-invalidacao-administrativa-de-export.md) (retry pré-efeito e
invalidação); não supersede nenhuma.

## Contexto

A quota por conta é de 30 chamadas por janela de 60 s, no PostgreSQL, e é
compartilhada por prévia, administração, worker de despacho e reconciliação. O
`reserve()` original não esperava: sem unidade livre, a chamada falhava na hora
com `OLIST_RATE_LIMITED`. Duas consequências ruins, ambas altas na revisão T14:

1. Uma prévia ou um clique do admin podia consumir a janela e o worker, que só
   precisava de uma leitura, terminava com falha terminal.
2. Pior: depois de um POST bem-sucedido, a leitura de conferência
   (cliente, produto, variação, venda) que falhasse por quota virava
   incerteza do efeito, e o efeito incerto exige reconciliação humana, embora a
   venda tivesse sido criada e bastasse esperar alguns segundos para lê-la.

Adicionalmente, `verifyAccount` (conferência da conta logo depois da troca de
token) reservava quota sem esperar; uma janela cheia no pior momento caía no
`finishToken`, que invalida a conexão (`reconnect_required`, `generation + 1`).

## Decisão

1. **Escrita nunca espera e nunca repete.** `reserve()` mantém a assinatura e o
   comportamento (sem espera) e passa a anexar `retryAfterMs` ao erro. Um POST
   incerto continua virando incerteza, como antes.
2. **Folga para a leitura pós-venda (`reserveWrite`).** Antes de reservar o
   ticket de um POST, o escritor exige uma unidade para ele **mais** as leituras
   que o resultado obriga: `used + 1 + leituras <= 30` e `remaining >= 1 +
leituras`. Leituras exigidas: cliente 2, produto 2, variação 3, venda 2. Sem
   folga, falha com `OLIST_RATE_LIMITED` **antes** de qualquer ticket e de
   qualquer POST; o job é adiado pelo retry pré-efeito (ADR 069). Aplicado em
   `sale-writer.js` e `resource-writer.js`.
3. **Só leitura espera (`reserveRead`).** Laço sobre o núcleo `attempt` (uma
   transação curta sob o advisory lock da conta, que devolve `ok` ou
   `waitMs`): dorme fora de qualquer transação, em fatias de até 10 s mais
   jitter de até 250 ms, chamando `beat()` antes de cada fatia (o lease do job
   é de 30 s); `beat` devolvendo `false` aborta com `OLIST_JOB_LEASE_LOST`. Se a
   espera não couber em `maxWaitMs`, falha na hora com `OLIST_RATE_LIMITED` e
   `retryAfterMs`. A espera mínima reportada é de 250 ms. Quando a janela está
   cheia e nada bloqueia, a espera é até o fim da janela de 60 s, **premissa
   inferida**, não confirmada pelo provedor.
4. **Parâmetros (D4).**

   | Perfil    | Espera máxima | Teto por janela | Quem usa                                      |
   | --------- | ------------- | --------------- | --------------------------------------------- |
   | `worker`  | 90 s          | 30              | despacho e leituras sem ticket em mãos        |
   | `patient` | 180 s         | 30              | leituras de conferência com ticket em mãos    |
   | `api`     | 8 s no total  | 24              | prévia, consultas e administração, por pedido |
   | `verify`  | 15 s          | 30              | `verifyAccount`                               |

   Limite da conta 30 (nunca elevado; o chamador só pode baixar o teto). O
   teto 24 da API reserva seis unidades por janela ao worker. **Os 8 s da API são
   um orçamento cumulativo por requisição, não por leitura**: o perfil `api`
   carrega `cumulative: true` e o cliente (um por requisição de prévia, consulta
   ou administração) soma a espera já gasta e entrega a cada leitura só o saldo
   (`min(espera da leitura, 8 s − gasto)`); estourado o saldo, a leitura falha
   na hora com `OLIST_RATE_LIMITED` e `retryAfterMs`, sem dormir o resto. Sem
   isso uma prévia com várias leituras (até cinco catálogos e suas páginas)
   podia esperar 8 s por leitura. Os perfis do worker (`worker`, `patient`)
   continuam por leitura, e o orçamento pertence ao cliente: outra requisição
   começa com os 8 s inteiros. A reconciliação
   do worker usa o perfil `patient` em todas as leituras, porque cada uma
   pertence a um export que já tem ticket durável.

5. **`verifyAccount` espera.** Usa `reserveRead` com 15 s, abaixo do limite de
   60 s do refresh abandonado da conexão: 15 s de espera mais uma requisição de
   15 s ficam sob esse limite. Só uma espera que não cabe ainda falha e
   reconecta.
6. **Retry pré-efeito (com a ADR 069).** `OLIST_RATE_LIMITED`,
   `OLIST_UNAVAILABLE` e `OLIST_REFRESH_IN_PROGRESS` antes de qualquer ticket,
   com `assertRetrySafe` verdadeiro, voltam como falha repetível; backoff de
   15 s a 300 s e oito tentativas (cerca de 17 minutos) antes de `dead_letter`.
   Depois de um ticket de venda, ou com `assertRetrySafe` falso, o tratamento é o
   de antes. A leitura pós-venda do despachante (`findOrder`, `orderRaw`) passa a
   ser `patient` e **espera** em vez de virar `OLIST_SALE_UNCERTAIN`.

## Alternativas descartadas

- **Espera de escrita** (aguardar quota para o POST): o POST seguraria o lease
  e, ao expirar, produziria justamente a incerteza que se quer evitar; a folga
  antes do ticket resolve o mesmo problema sem esperar.
- **Elevar o limite para além de 30:** o limite real da conta piloto é
  desconhecido (30 por 60 s é o valor já adotado desde a fase 2, não confirmado
  por execução na conta), e elevar seria apostar contra o provedor.
- **Reserva rígida por consumidor** (fatia fixa para o worker): desperdiça
  capacidade quando só a API trabalha; o teto 24 da API já garante o que o
  worker precisa.
- **Retry cego de 429 em escrita:** contraria OLIST-16; só leitura e
  pré-ticket esperam ou repetem.
- **Cache de catálogos da prévia** (TTL de 5 min): considerado, **não
  implementado** nesta entrega; fica no backlog.

## Consequências

- Uma janela cheia deixa de produzir falha terminal no worker nem incerteza
  pós-venda: o worker espera (com o lease vivo) ou o job é adiado sem efeito.
- Uma requisição da API pode demorar até 8 s a mais; passada essa espera responde
  429 (`OlistThrottled`) e a pessoa tenta de novo. Nunca repete sozinha.
- O número de leituras por etapa passa a importar: a folga reserva `leituras`
  unidades por POST, então o pior caso é pausar a criação por até uma janela.
- **429 sem `Retry-After` documentado.** O transporte respeita o cabeçalho
  quando presente; sem ele, bloqueia a conta por 60 s (`quota.block`). O
  provedor não documenta o cabeçalho, e a espera de 60 s também é premissa.
- **Risco residual de `verifyAccount` (M3, avaliado, não alterado).** Se a quota
  ficar bloqueada por mais de 15 s no momento da troca de token, a espera estoura
  (`OLIST_RATE_LIMITED`), o erro cai no `catch` de `finishToken` e a conexão é
  invalidada (`reconnect_required`, `generation + 1`) mesmo com o token novo
  **válido** e o refresh token antigo já gasto; a pessoa reconecta. Exemplo: janela
  cheia aos 10 s de idade pede 50 s de espera, acima dos 15 s do perfil `verify`.
  Reduzido, não eliminado. Persistir o token novo e verificar depois **não é uma
  mudança pequena**: o token só é instalado depois de `ACCOUNT_MISMATCH` ser
  descartado, e instalá-lo antes deixaria um token possivelmente de **outra conta**
  utilizável por outras requisições; exigiria um estado "instalado, não
  verificado" (hoje inexistente; provavelmente coluna nova e migração) que
  `credentials()` recuse. A mudança pequena e segura seria **pré-reservar a unidade
  de leitura antes de gastar o refresh token**: esperar a unidade (com o orçamento
  do perfil) _antes_ de `exchange()`, fazer a verificação com a unidade já paga e,
  se a espera estourar, **liberar a reivindicação sem invalidar** (nada foi gasto).
  O risco residual passa a ser só a falha do próprio GET de verificação (5xx ou
  429 do provedor). Fica no backlog, com a janela de 60 s do refresh abandonado
  (espera + troca + verificação) como restrição.
- A espera ocupa uma conexão de banco só durante cada tentativa curta; nenhuma
  transação fica aberta enquanto se dorme.
- A observação do cabeçalho `x-ratelimit-remaining` nunca aumenta a quota
  disponível (resposta fora de ordem não libera chamadas).

## Limitações conhecidas e medidas

### M4 — releituras de recursos já confirmados consomem a janela antes da venda (mitigada)

**Estado: mitigada** por deduplicação de leituras idênticas dentro da mesma
execução (mitigação 1, abaixo). A re-execução com tudo confirmado passou de
`4 + P + 2V` para `3 + P + V` leituras (V=12, P=2: de 30 para 17; V=5, P=1: de 15
para 9) e o `reserveWrite` da venda encontra folga. A execução limpa não mudou
(43 e 25 GETs). O que ainda vale está em "Capacidade que resta" e nas invariantes
do cache, mais abaixo. O texto seguinte registra a medição **antes** da correção.

Medido em 09/11/2026 com o cliente real (contagem de GETs, inclusive páginas), a
quota real (`attempt`, `reserveRead`, `reserveWrite`, relógio virtual), o
resolvedor real e um repositório e ERP falsos, sem rede, simulando `findOrder`,
a resolução e a reserva de folga da venda (leituras obrigatórias da venda: 2, ou
seja `used + 1 + 2 <= 30`, isto é `used <= 27` ao reservar). O script de contagem
fica fora do repositório (relatório da correção).

Cada execução do despachante repete, para recursos já `confirmed`, a releitura de
verificação: cliente 2 leituras (`contact` do ID observado e de novo o mesmo ID),
produto 1 por produto, variação 2 por variação (`product(pai)` mais o detalhe da
variação, **com o pai relido a cada filha**), mais dois `findOrder` (antes e depois
da resolução). Total na re-execução com tudo confirmado: **`4 + P + 2V` leituras**
(P produtos, V variações).

| Cenário                           | Execução limpa (nada criado)                                                            | Re-execução, tudo `confirmed`                                               |
| --------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2 grupos × 6 tamanhos (V=12, P=2) | 43 GETs até a venda (esperou uma janela, 60 s); `used`=16 ao reservar a venda: folga ok | **30 leituras**, `used`=30: sem folga; o `reserveWrite` da venda **recusa** |
| 1 grupo × 5 tamanhos (V=5, P=1)   | 25 GETs; `used`=27 ao reservar a venda: folga ok, no limite                             | 15 leituras, `used`=15: folga ok                                            |

No cenário V=12, a re-execução com tudo confirmado falha **de forma determinística**
nas oito tentativas (cada uma recomeça numa janela vazia, lê 30 e deixa `used`=30):
o job termina em `dead_letter` sem chegar ao POST da venda, e a saída é a
invalidação do admin (que, com os cadastros confirmados, reaproveita-os e repete o
mesmo custo). A execução limpa de V=12 chegou à venda em todas as dez posições
iniciais de janela testadas (`used` inicial de 0 a 27), com zero ou um adiamento
por folga numa escrita de cadastro e retry bem-sucedido; a execução limpa de V=12
consome 43 leituras e passa por alinhamento de janela. O limiar da re-execução é
`4 + P + 2V <= 27`: **V >= 11 com dois produtos (V >= 12 com um) já estoura**.

Mitigações avaliadas (da de menor risco para a maior). Só a 1 foi implementada:

1. _Deduplicar GETs idênticos dentro da mesma execução_ (**implementada**, ver
   abaixo): ler o cliente uma vez só (a segunda leitura é do mesmo ID), cada
   produto pai uma vez e cada variação uma vez. Não perde detecção de divergência
   (a primeira leitura de cada entidade continua indo ao ERP e comparando com o
   vínculo local). Com V=12 e P=2 a re-execução passa de 30 para 17 leituras
   (`3 + P + V`), e a capacidade vai de V <= 10 para V <= 22.
2. _Esperar a folga da venda antes do ticket_ (sem POST): quebra o laço
   determinístico (a escrita esperaria o fim da janela e recomeçaria com `used`
   baixo). Risco médio: altera o invariante "escrita nunca espera" no trecho sem
   ticket e alarga em até 60 s o intervalo entre o segundo `findOrder` e o POST (uma
   venda manual da mesma referência nesse intervalo só seria pega pelo POST do ERP).
3. _Não reverificar recurso `confirmed` na re-execução_: custo mínimo (só os dois
   `findOrder`), mas **perde** a detecção de divergência entre execuções (cadastro
   editado, produto inativado ou variação removida no ERP): a falha apareceria
   depois, no POST da venda, e não antes.
4. _Reservar a folga da escrita antes das leituras de reverificação_: não é
   implementável com o contador atual (sem primitivo de reserva); exigiria coluna e
   migração em `olist_quotas`, com expiração.

Recomendação: (1) agora; (2) só se (1) não bastar; (3) e (4) descartadas.

#### Deduplicação implementada

Medida de novo com o mesmo método (cliente real, quota real com relógio virtual,
resolvedor real), agora também como teste do repositório
(`test/olist-resource-resolver.test.js`, "M4 capacity"):

| Cenário                           | Re-execução, tudo `confirmed`: antes | Depois                                     | Execução limpa: antes e depois |
| --------------------------------- | ------------------------------------ | ------------------------------------------ | ------------------------------ |
| 2 grupos × 6 tamanhos (V=12, P=2) | 30 leituras; venda recusada          | **17 leituras** (`used`=17); venda reserva | 43 GETs, `used`=16 (igual)     |
| 1 grupo × 5 tamanhos (V=5, P=1)   | 15 leituras                          | **9 leituras** (`used`=9); venda reserva   | 25 GETs, `used`=27 (igual)     |

Onde fica e como é escopada: `createOlistExecutionReads`, em
`modules/olist/src/resource-resolver.js`, criada **dentro de cada chamada de
`resolve()`** e descartada com ela. Não é memória do processo, do job nem da
fábrica do resolvedor, e duas execuções seguidas do mesmo resolvedor não
compartilham nada. O despachante não tem cache: seus dois `findOrder` e o
`orderRaw` da prova da venda sempre vão ao cliente. Só `contact` e `product`
(detalhe) passam pelo cache; buscas por documento ou SKU nunca.

Invariantes do cache (cada uma tem teste, e foi provada por mutação):

1. **Leitura de conferência nunca vem do cache.** Toda leitura com ticket em mãos
   (`patient`: recurso recém-criado ou tentativa `reserved`/`uncertain` em
   recuperação) vai à rede e não lê nem preenche o cache. As conferências depois de
   um POST usam o cliente direto. Depois de um POST de cliente, as entradas de
   `contact` são descartadas; depois de um POST de produto ou de variação, as
   entradas de `product` (pai e filhas) são descartadas, mesmo que a resposta do
   POST tenha se perdido.
2. **Erros e "não encontrado" não são cacheados**: uma leitura que falhou (quota,
   5xx, 4xx) ou que devolveu vazio é refeita. Zero numa busca nunca autoriza criação
   (isso não mudou e a busca nem passa pelo cache).
3. **Guarda cópia, nunca objeto compartilhado**: o valor é copiado ao guardar e ao
   servir; um valor que não se copia simplesmente não é cacheado.
4. **A detecção de divergência continua**: a primeira leitura de cada entidade na
   execução vai ao ERP e é comparada com o vínculo; só a repetição idêntica e não
   invalidada é servida da memória, e é verificada de novo sobre a sua própria cópia.
5. Nenhuma mudança em `reserveWrite`, tickets, ordem dos POSTs, retries ou
   `readonly-inspector` (o digest de evidência da reconciliação não usa o cache).

Como o ticket desliga o cache, a execução limpa (que cria o pai e deixa as filhas
com ticket) não economiza nem gasta leituras a mais; o ganho é da re-execução com
tudo `confirmed`, que é o caso do laço sem cura.

#### Capacidade que resta

A re-execução custa `3 + P + V` (dois `findOrder`, um cliente, P pais, V variações)
e a venda exige `used <= 27`: `V <= 24 - P`, ou seja **V <= 22 com dois produtos
(V <= 23 com um)**, calculado a partir da fórmula medida em V=12 e V=5. Acima disso
o comportamento é o descrito antes da correção: cada tentativa recomeça numa janela
vazia, lê mais de 27 e o job termina em `dead_letter` sem POST da venda; a saída
continua sendo a invalidação do admin e uma janela mais folgada (ou a mitigação 2,
se o caso aparecer na prática). Pedido com tantas variações num único export não é
esperado no piloto.

### B2 — o 429 do provedor numa leitura não é repetido

Um 429 real devolvido pelo provedor a uma leitura propaga `OLIST_RATE_LIMITED` e
bloqueia a conta (`Retry-After` ou 60 s); a **leitura em si não é repetida** depois
do bloqueio (só a quota local espera). No worker, o retry pré-efeito cobre o caso
sem ticket; com ticket, a leitura de conferência (`patient`) falha e o recurso ou a
venda fica incerto para reconciliação. Decisão: não implementar a repetição do GET
agora; backlog.

## Invariantes

1. Escrita nunca espera, nunca repete e só começa com folga para suas leituras.
2. POST incerto nunca é repetido; zero em busca não autoriza criação.
3. Espera só em leitura, fora de transação, com `beat` e abortada se o lease
   se perder.
4. A API nunca passa de 24/30 por janela, nem espera mais de 8 s no total por
   requisição; nenhum chamador excede o limite da conta.
5. Retry pré-efeito só sem ticket de venda, sem tentativa de venda e sem
   recurso `reserved` ou `uncertain`.

## Riscos aceitos

- O limite real da conta piloto é **desconhecido**: 30 por 60 s é inferido, e o
  fim da janela como instante de liberação também. Verificar na ativação (T15)
  e ajustar `OLIST_QUOTA_LIMIT` se o contrato da conta divergir.
- Os custos de leitura por etapa (2, 2, 3, 2) vêm do desenho do resolvedor; se
  o resolvedor mudar, a tabela precisa mudar junto.
- `verifyAccount` ainda pode invalidar a conexão em bloqueio longo (M3, acima).
- Export com muitas variações (V >= 23 com dois produtos, V >= 24 com um) ainda
  pode esgotar as oito tentativas na re-execução, sem POST da venda (M4, mitigada
  por deduplicação de leituras idênticas por execução; acima).
- O 429 do provedor numa leitura não é repetido (B2, acima).
- Sem o cache de catálogos, prévias repetidas consomem a quota da API.

Contrato em [OpenAPI](../api/openapi.v1.yaml) (`OlistThrottled`); operação, o
que observar e limitações no
[runbook da fase 5](../runbooks/olist-phase5.md#invalidação-administrativa-e-quota).
Geração real continua desligada, sem deploy, conexão homologada ou piloto; a
evidência local não equivale a operação no EasyPanel.
