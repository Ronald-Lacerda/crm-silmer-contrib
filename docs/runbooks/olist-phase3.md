# Olist — Fase 3: composição e total calculado

OLIST-T20/T21, composição persistida e confirmação calculada. Requisitos
OLIST-09–10, 29, 34, 40–44;
[ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).

## T26 — fonte histórica suplementar

T26 implementada conforme [ADR 067](../adr/067-fontes-comerciais-suplementares-sem-reescrever-ficha.md)
/ [RFC 054](../rfc/054-fontes-suplementares-para-olist.md), OLIST-29, 42–44.
A migration expand 0065 acrescenta order_olist_source_revisions append-only,
com envelope AES-GCM separado por Pedido/revisão. Aplicar a migration antes
da API. Não há backfill, rateio ou reescrita de pedidos antigos.

GET/POST /api/v1/orders/:id/price-breakdown usam leitura comercial e mutação
order.edit, com sessão/CSRF/Origin/Idempotency-Key. Revalidar humano ativo,
função Vendedor e posse/Admin antes do replay e dentro da transação. A revisão,
o incremento de order.version, evento, auditoria e recibo usam o mesmo client;
falha de auditoria não deixa preço, versão ou recibo parcialmente gravados.

initialize em legado confirmado ou reaberto emite IDs de grupo/linha e preços
null. set_subtotals recebe todas as linhas emitidas (groupId/lineId/centavos
positivos ou null), sem importar grade/review/total. Completo deve somar o valor
histórico; diferença é recusada sem gravar. Incompleto permanece pendência.
IDs sobrevivem às revisões e à releitura. O autor e a versão são persistidos.

A fonte é autenticada por HMAC dos campos comerciais canonicalizados.
Impressão, recibo e datas de pagamento não pedem rebase. Alterar atributos,
quantidade ou valor torna o suplemento obsoleto; initialize explícito inicia
nova composição para a fonte alterada e mantém todas as revisões anteriores.
Não regenerar IDs silenciosamente nem reaproveitar preços da fonte anterior.

O legado completo/fresco pode ser reconfirmado após reabrir, apenas por seu
comando humano e com o mesmo total. A prova interna não é aceita do navegador,
não é publicada por spread e não entra na ficha. Reabertura/reconfirmação com
essa prova preserva inclusive o envelope original. Correção comercial por
seção items remove a prova transitória e invalida o suplemento, em vez de
impedir a edição ou confirmar com preço antigo.

Reserva/snapshot Olist em qualquer conta e tentativas de venda ou recursos
ligados em estado reservado/confirmado/incerto bloqueiam o complemento. A
reserva e o complemento serializam no mesmo lock de Pedido. Não limpar vínculo
ou tentativas para liberar edição. Geração real continua desligada.

Rollback: código anterior continua lendo a ficha/colunas antigas; manter 0065,
revisões e chaves. Não executar down, modificar revisão antiga nem remover o
guard T21 de preço calculado. API antiga exige mutações comerciais bloqueadas.

Evidência T26: domínio/API 14/14 e PostgreSQL dedicado 8/8 sem skips. Incluem
preservação de ficha/total/quitação/check, duas revisões concorrentes, replay
revogado, falha de auditoria, envelope copiado, rebase após correção e disputa
com reserva de snapshot. Testes locais não homologam ambiente remoto.

## Contrato entregue

Adoção explícita via `PATCH /api/v1/orders/:id/sections/size-pricing`, com
`expectedVersion` e `value`. Exige sessão humana, ação `order.edit`, CSRF,
Origin e Idempotency-Key; a ACL é comercial (responsável/admin), independente
do checkbox Olist. O repositório revalida posse e versão sob lock. Comando,
idempotência e auditoria seguem a infraestrutura atual; auditoria/eventos
contêm somente IDs, versão e código fixo, nunca subtotais ou cadastro.

`initialize` em pendente nunca confirmado gera IDs UUID de grupo e linha no
servidor, com subtotais ausentes e revisão falsa. `ficha.sizePricing` é opcional
e vive no envelope cifrado existente, junto da grade; não há migration nem
reescrita de fichas antigas. A leitura preserva os mesmos IDs após reinício.

Ações posteriores, sempre com IDs já emitidos:

- `review_subtotal`: groupId, lineId e subtotalCents inteiro positivo ou null;
  a ação humana define a revisão, sem aceitar booleano fornecido pelo cliente.
- `change_quantity`: groupId, lineId e quantity; altera também a grade, mantém
  subtotal e invalida revisão. Voltar à quantidade anterior exige nova revisão.
- `reorder_groups`: groupIds, permutação completa dos IDs; move grupo/peça
  juntos. Tamanho M em duas peças conserva suas identidades e preços próprios.
- `duplicate_group`: groupId; copia a peça com IDs novos e revisão falsa.
- `add_group`/`remove_group`: cria peça a partir de item validado, com IDs novos
  e subtotais ausentes, ou remove pelo groupId.
- `update_group`: groupId e attributes parciais, sem grade/IDs/preços; mudança
  real de atributos invalida revisão de todas as linhas, sem perder IDs.
- `add_line`/`remove_line`: groupId mais size/quantity ou lineId; inclusão
  recebe novo ID e preço ausente, remoção não reaproveita identidades.
- `rename_line`: groupId, lineId e size; preserva ID e exige revisão se mudar.
- `reorder_lines`: groupId e lineIds, permutação completa; grade e preços
  permanecem alinhados, sem invalidar revisão por mera reordenação.

Campos extras, identidade alheia, coerção, centavos fracionários, somas com
overflow e total de peças acima de 2147483647 são recusados antes da escrita.
Subtotal 100/quantidade 3 é comercialmente válido; esta fatia não chama ERP.

## Confirmação, total e compatibilidade

T20/T21 concluídas no domínio/API. A API publica `pricing` somente no pedido
adotado, com total, soma por grupo e pendências por identidade; os subtotais
continuam em `ficha.sizePricing`. A mesma soma inteira exata é persistida em
`finalAmountCents` junto da ficha. Preço ausente ou revisão pendente deixa o
total null: soma parcial nunca vira valor oficial.

Confirmar recalcula a composição, valida alinhamento/grade e exige todos os
campos principais, arte, previsão, condição e subtotais revisados. O navegador
pode omitir `amountText`; se declarar valor pelo contrato antigo, só igualdade
exata é aceita. Divergência é `SIZE_PRICING_AMOUNT_MISMATCH`, composição ausente
ou incompleta é `ORDER_NOT_CONFIRMABLE`. Não há fallback de total livre,
rateio histórico, alteração de quantidade nem compensação entre linhas.
Subtotal 100/quantidade 3 confirma comercialmente; somente a futura exportação
bloqueia representação unitária fracionária (ADR 062).

Uma mudança de total conhecido, inclusive para null após invalidar revisão,
limpa quitação manual e invalida o check financeiro pelo trigger existente,
preservando eventos/histórico. A memória reproduz a regra. Voltar ao preço
antigo não restaura quitação/check. Reabrir sem mudar o total conserva a
quitação; confirmação comercial continua separada de pagamento.

A substituição antiga de items segue recusada (`SIZE_PRICING_ITEMS_MANAGED`)
no pedido adotado; usar comandos por identidade. A projeção automática retorna
applied=false/reason=size_pricing_managed antes de escrever. Outras seções
humanas preservam a composição. Reabertura de pedido já adotado permite a
edição por identidade; não remove as revisões necessárias.

Loja permanece `ORDER_LOCKED`. Confirmados legados seguem legíveis com total e
snapshot intactos; reaberto sem composição não pode adotá-la genericamente e
depende de T26. Pendente nunca confirmado pode initialize/revisar. Não inferir
subtotal nem modificar checkout/gateway. T24/T26 cuidam dessas origens.

**Não liberar esta branch como rollout operacional antes da UI/Fase 4 e dos
adapters T24/T26.** A UI antiga não registra subtotais: confirmação sem
composição é recusada mesmo que ela envie amountText. Não há exportação,
conexão real homologada, deploy ou piloto nesta entrega; gate F3 continua aberto.

## Verificação e rollback

Use Node 24.20.0/npm 11.19.0. SQL exige TEST_DATABASE_URL de banco dedicado
crm_silmer_test; os testes removem apenas schemas sintéticos nesse banco.

```powershell
node --test test/orders-service-commands.test.js test/order-runtime.test.js test/order-routes.test.js test/store-order-service.test.js
node --test --test-concurrency=1 test/orders-postgres-live.test.js
npm run validate
npm run test:e2e
npm audit --audit-level=high
git diff --check
```

Rollback: manter o guard T21 de confirmação calculada e os envelopes/IDs;
rollback de frontend não pode recuperar preço livre. Para voltar a uma API
anterior, bloquear antes todas as mutações comerciais (incluindo confirmação e
projeção automática) no ambiente alvo e manter manutenção até um forward-fix
compatível. Não basta desligar Olist: a confirmação pertence a Orders. Não
apagar composição, regenerar IDs ou restaurar banco como primeiro recurso.
Não há efeito remoto para compensar nesta entrega.

## Evidência histórica T20b — 05/11/2026

Node 24.20.0; revisão independente de Backend/QA sem finding bloqueante após
corrigir limite agregado de quantidade. Não é evidência de produção.

- Domínio/aplicação/runtime/API: 76/76, sem skips; regressão da trava de loja
  incluída também no gate completo.
- PostgreSQL portátil 18.6 dedicado: pedidos 26/26, sem skips, incluindo
  roundtrip cifrado, recriação do serviço, concorrência e mudança de posse.
- `npm run validate`: aprovado, 1788 testes/15 skips explícitos, sem falhas;
  inclui tipos, lint, fronteiras, formatação, validadores e build.
- Regressão SQL ampliada Olist/loja/Financeiro: 56/57. A exclusão de autor
  histórico foi recusada, mas o teste financeiro exige SQLSTATE 23503 e o
  PostgreSQL 18.6 retornou 23001/RESTRICT. Reproduzida em snapshot isolado do
  commit anterior 0787bc66: Financeiro 9/10 com a mesma falha. O gate SQL
  ampliado não é declarado integralmente aprovado; teste/constraint mantidos.
- E2E completo: 485 aprovados/7 skips previstos (configuração local na porta
  4187), incluindo teclado/axe dos fluxos existentes.
- `npm audit --audit-level=high`: aprovado, sem altas/críticas; seis avisos
  existentes (um baixo/cinco moderados), sem atualizar dependências.

Os logs sintéticos ficam em var/olist-phase3-*.log, fora do versionamento.


## Fechamento T20 — 05/11/2026

A composição vazia pode ser completada por comandos autorizados; IDs são
persistidos, emitidos somente pelo servidor e não são reconstruídos por
posição/conteúdo. Mudança sem alteração real não invalida revisão. A evolução
é aditiva no envelope, sem reescrever legado; enriquecer confirmado continua
em T26. As verificações incluem aplicação/API, roundtrip cifrado, concorrência
e grade/linhas reordenadas. Interface de edição e confirmação calculada não
são declaradas entregues por T20.


## Fechamento T21 — 05/11/2026

T20 foi publicada no commit 5528f4de (branch codex/olist-phase3). `validate`
aprovado: 1791 testes/15 skips. E2E: 484 aprovados, 7 skips e um timeout no
dispositivo sintético Firefox; o mesmo teste isolado passou (1/1), sem alteração
de frontend ou flexibilização de teste. SQL T20: 26/26.

T21 acrescenta confirmação omitida/igual/divergente, subtotais negociados não
uniformes, fração unitária válida no CRM, versões concorrentes e invalidação de
quitação/check sem apagar história. SQL de pedidos: 27/27, incluindo disputa
real confirmar/revisar e consistência entre total API e coluna PostgreSQL.
Revisão independente de Backend/QA não encontrou finding bloqueante. Fixtures
antigas foram migradas para preços sintéticos explícitos, sem inferência em
código de produção. A falha histórica financeira no SQLSTATE/PG18.6 registrada
acima permanece fora desta entrega.


Gate completo T21 aprovado: `npm run validate` com 1799 testes aprovados e
15 skips explícitos, incluindo tipos/lint/fronteiras/formatação/build.
Auditoria sem altas/críticas (um baixo/cinco moderados existentes). Regressão
SQL ampliada refeita: 56/57, somente a mesma divergência financeira de SQLSTATE
já reproduzida no baseline, sem regressão nova identificada.

E2E final T21: 485 aprovados/7 skips previstos, sem falhas; servidor estático na
porta 4187. Nenhum teste foi flexibilizado. `git diff --check` aprovado; o
PostgreSQL sintético iniciado para esta verificação foi encerrado.


Gate T26: `npm run validate` aprovado, 1813 testes/16 skips explícitos,
incluindo tipos, lint, fronteiras, formatação, validadores e build. O skip novo
é a suíte PostgreSQL que exige TEST_DATABASE_URL; ela foi executada separada
com 8/8 aprovados em banco dedicado.
