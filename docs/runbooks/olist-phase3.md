# Olist — início da Fase 3: composição persistida

OLIST-T20, composição persistida e edição completa por identidade. Requisitos OLIST-09, 29, 42–44;
[ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).

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

## Limites deliberados e próximo trabalho

T20 concluída no domínio/API; T21 e o gate F3 permanecem abertos. Não há UI de adoção, total monetário
autoritativo publicado, confirmação calculada ou exportação. A confirmação de
um pedido adotado responde `SIZE_PRICING_CONFIRMATION_PENDING` até T21.
`finalAmountCents`, snapshots confirmados, status, pagamentos e gateway não
são alterados por estes comandos.

Após adoção, a substituição antiga de items é recusada com
`SIZE_PRICING_ITEMS_MANAGED`. A edição completa usa os comandos por identidade acima.
Não adotar pedidos operacionais: a UI de grade ainda pertence a T12/Fase 4. A projeção automática retorna applied=false e
reason=size_pricing_managed antes de escrever, preservando a ficha humana.
Outras seções humanas permanecem editáveis e preservam a composição.

Loja é `ORDER_LOCKED`; confirmado é `ORDER_STATUS_CONFLICT`; reaberto que já
foi confirmado exige o adapter T26 (`SIZE_PRICING_LEGACY_REQUIRES_ADAPTER`).
Não há divisão de total histórico ou inferência de preços. T24/T26 cuidam das
origens específicas, e T21 ligará total calculado/pendências à confirmação.

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

Rollback: interromper comandos novos e projeção automática dos pedidos
adotados antes de voltar a uma versão antiga que desconhece sizePricing.
Preservar envelopes e backups; não apagar o campo nem regenerar IDs. Código
antigo de projeção reconstruiria a ficha e perderia os metadados. Os pedidos
sem adesão continuam no contrato anterior. Nenhum efeito externo exige
compensação: geração Olist, OAuth real, deploy e piloto não são executados.


## Evidência local de 05/11/2026

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
