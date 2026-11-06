# Olist — Fase 3: composição, prévia e cadastros

OLIST-T20/T21/T26/T24/T06/T22, composição, fontes, prévia e cadastros. Requisitos
OLIST-09–10, 29, 34, 40–44;
[ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).

## T22 — resolução e criação segura de cadastros

OLIST-07–08, 12–17, 27, 35–39. `createOlistResourceResolver` é uma porta interna:
recebe exportId e autoridade atual, carrega o snapshot cifrado/imutável do export
e ignora qualquer plano comercial fornecido pelo caller. Não existe rota pública
para cadastros nem handler de worker ativo. T07 ainda precisa aceitar/congelar o
comando humano e T08 despachar a sequência/venda. Criação real continua desligada.

### Snapshot e parâmetros

Snapshot exige policy exact-cent-v1, customer pela allowlist oficial, commercial
com grupos/linhas, quantidades/subtotais/unitários/total exatos e sourceVersions
(contactId/contactVersion/sourceRevision), preservados no recibo da T06 para T07.
Validação integral antecede bindings e HTTP: IDs opacos, somas BigInt, ausência
de frações, tamanhos e atributos válidos. Mais de 100 tamanhos distintos para
uma identidade de pai é pendência, inclusive em grupos repetidos do Pedido.
Não dividir produto ou compensar valores para contornar esse limite.

Settings admite productFiscal opcional/nulo, cifrado e versionado com os demais
parâmetros: ncm (oito dígitos), origin (inteiro 0–8) e unit (1–6 caracteres
alfanuméricos maiúsculos). Nenhum valor é escolhido automaticamente. Omissão na
substituição integral mantém o contrato antigo, sem uma política inferida.
Produto ausente sem política válida bloqueia antes do primeiro POST de cliente.
Um pai encontrado é conferido fiscalmente quando a política está presente;
origem remota ausente ou vazia não significa zero. Valores/gatilhos reais da
conta e sua suficiência fiscal permanecem sob homologação T15.

### Descoberta, reservas e resultados

Cliente usa CPF/CNPJ verificável, busca completa pelas situações A/B/I/E e
formatos normalizado/mascarado; produto usa código/SKU exato em A/I/E, com
paginação completa e deduplicação de IDs. A listagem oficial informa sku,
enquanto a criação pode retornar codigo. Ausência de identidade na listagem,
ambiguidade, inatividade e divergência bloqueiam, sem nome aproximado. Cliente
novo omite codigo (limitação comprovada em T02) e usa situação B sem acesso ao
sistema. Não existe criação de funcionário, PATCH de cadastro ou exclusão.

Base por cliente/documento, pai/atributos e variação/pai/tamanho é reservada
localmente uma vez por conta e ligada aos exports. Base e request ficam em
AES-GCM com AAD por entidade/tentativa e HMAC de conteúdo; conflito de base exige
análise humana. Lista inicial de tamanhos não faz parte da base do pai: outro
Pedido compartilha o pai vencedor e cria apenas seus tamanhos adicionais.

Para pai V, todos os filhos do lote inicial recebem tickets antes do POST
composto. Variação adicional tem reserva própria. Credenciais e quota são
obtidas antes da reserva final; a reserva revalida versão/geração da conexão,
usuário/sessão/checkbox, conta/restore, parâmetros, Pedido, comprador e revisão
suplementar. Não há HTTP dentro de SQL. Só o ticket reservado autoriza o POST
fechado, sem retry ou lease que expire permitindo recriação.

O ID devolvido é persistido antes de qualquer GET ou próximo efeito. A API pode
retornar o ID do pai ao incluir variação: esse ID fica como evidência observada;
o vínculo do tamanho exige GET do pai com SKU/grade e GET independente do filho.
Preços/estoque/tributação extra não são inventados nem atualizados. Cada subtotal
comercial permanece no snapshot, sem depender do preço do catálogo.

Timeout, 4xx/5xx, corpo inválido, resposta parcial, quota/commit falho ou falha de
leitura após inclusão deixam tickets incertos/reservados para reconciliação.
Sucesso anterior, ID observado e filhos confirmados são preservados. Zero em
busca não libera POST; match positivo verificado pode confirmar a entidade e
adicionar auditoria sem reescrever a tentativa incerta histórica. Depois de
revogar o usuário, o resultado iniciado ainda pode ser persistido pelo ticket;
o próximo efeito exige autoridade atual. Não há compensação destrutiva.

### Migração, limites e rollback

Aplicar 0066_olist_resource_resolution.expand.sql antes do código. Acrescenta
base/envelope imutável de recurso, request/envelope imutável de tentativa,
parent_attempt_id, observed_remote_id e índices; não altera ficha, gateway,
preços, tabelas financeiras ou snapshots antigos. Operações antigas sem o novo
contrato completo não são inferidas nem executadas pelo resolvedor.

Manter conta de produção e criadores desligados até T07/T08 e os demais gates.
Consultas completas podem esgotar quota em planos grandes: parar e retomar por
leitura, preservando os tickets. Não aumentar automaticamente limites, limpar
reservas, expirar tentativas ou refazer POST após uma falha. Proteção local não
promete exactly-once do provedor nem elimina corrida com inclusão manual externa.

Rollback desliga novas inclusões antes de pausar handlers futuros. Preservar
0066, envelopes/chaves, vínculos, tentativas, IDs e auditoria; sem down, exclusão
ERP ou restauração como primeira ação. Código anterior só retorna mantendo
criadores desligados e sem liberar recursos reservados/incertos. Recovery de
backup com janela externa exige reconciliar cada entidade antes de retomar.

## T06 — prévia completa sem escrita ERP

OLIST-06–12, 34–44. `POST /api/v1/orders/:id/olist/preview` recebe somente `{}`.
Exige humano ativo com checkbox Olist, sessão, CSRF e Origin, inclusive para
Financeiro e Pedido de outro responsável. Não concede edição comercial. O GET
mínimo anterior conserva o escopo comercial próprio quando o checkbox está
inativo: responsável ou administrador, sem acesso alheio pelo fallback.

A fonte é lida sob locks curtos de autorização, conexão, parâmetros, Pedido e
comprador. Usa composição gerenciada ou revisão suplementar fresca T26/T24;
status confirmado e missingFields vazio não comprovam completude. Ficha,
previsão, arte, condição, cadastro fiscal com documento verificável/endereço/IE
quando aplicável, grade/subtotais revisados e total são validados novamente.
Uma fração unitária bloqueia toda a exportação, mantendo a validade comercial
CRM. Nenhum preço, cadastro, conta ou total é recebido do navegador na prévia.

Cliente comprador, produto pai e tamanhos são descobertos por identidade
verificável e GETs oficiais limitados, fora de transação SQL. Vínculos antigos
não dispensam conferir o detalhe atual: divergência fiscal, SKU, atributos,
tamanho/pai, inatividade, ambiguidade ou enumeração incompleta bloqueiam.
Recursos reservados/incertos/rejeitados exigem reconciliação, sem concluir
que uma ausência autoriza outra inclusão. O mesmo M em dois grupos conserva
suas identidades. Nome sozinho não associa produto. Preço de catálogo remoto
não é sobrescrito nem usado para recalcular a negociação.

A resposta mostra grupos/linhas, quantidades, subtotais e unitários exatos,
plano reuse/create/blocked, pendências e revisões. Documento completo, endereço,
telefone, mensagens, notas, arquivos e conteúdo de IA não são publicados. Nome
fiscal e últimos quatro caracteres do documento identificam o comprador.
Nenhum recurso, reserva, evento de exportação, snapshot, recibo idempotente ou
job é criado. Quota e eventual renovação OAuth usam o contrato F2 existente.

Quando elegível, a resposta inclui previewToken AES-GCM com propósito/AAD
próprios, ligado a ator/sessão/Pedido/conta/contexto, versões de autorização,
Pedido, fonte, comprador, configuração e conexão e hash dos conteúdos/vínculos.
Expira inclusivamente em 15 minutos. `POST .../olist/preview/check` recebe
somente `{previewToken}` e revalida autorização/fontes locais; adulteração,
troca de sessão/Pedido ou mudança de fonte pede nova conferência. Não faz GET
remoto nem autoriza efeito. Token acima de 262144 caracteres não é emitido.

Sem orderDate, a data exibida é proposta do dia de São Paulo, sem salvar ou
confirmar o Pedido. Virar o dia invalida a proposta. T07 deve congelar o dia do
comando aceito e a fonte/conferência correspondente; replay não poderá mudá-lo.
T07/T22 precisam revalidar o remoto antes dos efeitos e reservar cada criação.

Limites: até 64 GETs reais por prévia; dez requests/minuto e no máximo 1000
vínculos de conta na consulta conservadora atual. Mais vínculos pedem nova
consulta especializada, sem assumir ausência. Vendedor, depósito, forma de
pagamento e lista de preços, quando informada, são conferidos nos catálogos
fechados suportados. Natureza/origem e gatilhos reais da conta continuam no
gate operacional T15: esta entrega valida sua presença/formato/revisão, sem
alegar homologação. Produto ausente mostra criação planejada e exige productFiscal explícito na
revisão central, conforme T22 acima. Não inventa NCM/unidade/origem/preço de
cadastro; T15 homologa os valores reais antes de qualquer criação.

Criação continua `false`, sem endpoint de envio. Recibo não é reserva nem
prova de imutabilidade futura do ERP. Não houve acesso real ao ERP, deploy,
ativação ou piloto. Rollback remove as novas rotas e mantém composição,
fontes, locks e guardas comerciais anteriores; não exige down ou compensação.

## T24 — fonte suplementar da loja

T24 concluída no domínio/API, OLIST-01, 06–12, 19, 29, 34–35, 44, usando a
migration 0065 e os mesmos locks/envelopes da [ADR 067](../adr/067-fontes-comerciais-suplementares-sem-reescrever-ficha.md).
GET/POST price-breakdown exigem Admin comercial atual para loja; habilitação
Olist, função Financeiro ou automação não concedem edição nem leitura comercial.
A autoridade é revalidada inclusive antes de servir replay idempotente.

initialize verifica o snapshot pago: origem/status, uma grade, quantidade/total,
comprador e pagamento InfinitePay válidos. A única linha recebe exatamente o
finalAmountCents armazenado, sem rateio ou consulta ao catálogo atual. O total
pago pelo gateway não substitui o total comercial após correção autorizada.
Não aceita set_subtotals nem permite edição, reabertura ou confirmação genérica.

set_store_details exige deliveryOn, applications (groupId/application para cada
grupo) e registration, permitindo null/rascunho. Previsão deve ser data real;
Aplicação deve ser texto válido; cadastro usa o normalizador fiscal existente,
CPF/CNPJ por dígito verificador e endereço explícito. Empresa incompleta sem IE
fica pendente; ISENTO só vale quando declarado. Nome/telefone permanecem os do
checkout. Não inferir dados, criar Contato nem substituir campo original presente.
Não incluir documento/endereço em logs, eventos ou auditoria.

A projeção store inclui details, buyer e issues. pricing.complete informa apenas
composição monetária: previsão, Aplicação, atributos/tecidos, arte ou cadastro
incompletos ainda bloqueiam a fonte interna. OrderService.sourceForOlist fornece
uma cópia transitória apenas quando a fonte está fresca e sem essas pendências.
T06 ainda deve validar comprador/conta/configuração, schema oficial e precisão
exact-cent-v1; esse método não libera geração nem cria endpoint para Financeiro.

O HMAC da loja inclui também previsão e flags de arte originais; impressão e
recibo não o alteram. Correção autorizada de quantidade torna a revisão obsoleta;
initialize explícito emite IDs novos, sem reciclar preço/revisão anteriores.
Revisão do complemento e correção disputam a mesma versão/lock; reserva Olist
bloqueia novas revisões. Checkout, ficha/envelope, gateway, fingerprint de ingestão,
recibo e primeira impressão permanecem byte a byte, exceto a versão/data técnica.
Rollback mantém 0065 e revisões; não libera mutações pela API antiga.

Evidências locais: domínio da loja 11/11, API com ACL real 5/5 e suíte PostgreSQL
integrada legado/loja 13/13 sem skips. Incluem kit, unitário e pedido de teste,
rascunho fiscal, campos forjados, sessão revogada, PII cifrada, concorrência com
correção, reserva Olist, rebase e autenticação do envelope por revisão.

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
usa T26 acima. Pendente nunca confirmado pode initialize/revisar. Não inferir
subtotal nem modificar checkout/gateway. T24/T26 acima cuidam dessas origens.

**Não liberar esta branch como rollout operacional antes da prévia T06 e da
UI/Fase 4.** A UI antiga não registra subtotais: confirmação sem
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

E2E T26: 485 aprovados/7 skips previstos, sem falhas. Entrega atômica em
[3b72aa0a](https://github.com/romulosutil/crm-silmer/commit/3b72aa0abb226d00cee5f1f1a0cb48b1adaeef45), com push na branch codex/olist-phase3.

## Fechamento T24 — 05/11/2026

`npm run validate` aprovado: 1829 testes aprovados/16 skips explícitos, tipos,
lint, formatação, fronteiras, validadores e build. `npm audit --audit-level=high`
aprovado: zero altas/críticas, mantendo um baixo/cinco moderados existentes.
O comando `npm run test:olist:live` inclui agora as fontes suplementares para
que a suíte SQL não seja omitida nos próximos gates. O teste de upgrade verifica
0064 e 0065 com jobs e constraints anteriores preservados e replay sem reapply.
Logs sintéticos em var/olist-t24-*.log, fora do versionamento.

Regressão SQL integrada Pedidos/Loja/Olist/fontes: 87/87 aprovados, zero skips,
incluindo os 13 cenários de fontes. E2E completo: 485 aprovados/7 skips previstos,
sem falhas, em servidor dedicado na porta 4187 (4173 já ocupada por outro serviço).
A revisão independente não encontrou finding bloqueante. PostgreSQL 18.6 local
com dados sintéticos encerrado ao fim dos testes. Sem acesso ao ERP ou deploy.

## Fechamento T06 — 06/11/2026

T06 concluída no domínio/API, com OpenAPI e sínteses canônicas atualizados.
A revisão independente de Backend/Integrações/QA confirmou correções de
revalidação fiscal/atributos remotos, escopo comercial da projeção alternativa,
comprador WhatsApp, configuração e virada do dia, sem findings altos/críticos
restantes. Fonte de legado e loja completas/obsoletas foram exercitadas com
revisões cifradas reais; snapshots e gateway preservados.

- `npm run validate`: aprovado, 1855 testes/17 skips explícitos, incluindo
  tipos, lint, fronteiras, formatação, validadores e build. A nova suíte SQL
  omitida sem TEST_DATABASE_URL foi executada separadamente, sem skips.
- Domínio/plano de recursos: 26/26 aprovados, sem skips.
- PostgreSQL T06: 15/15 aprovados, sem skips, incluindo sessão/checkbox,
  expiração/adulteração, mudanças de todas as fontes e parâmetros durante GET.
- Regressão SQL integrada Pedidos/Loja/Olist/fontes: 102/102 aprovados, zero skips.
- E2E completo: 485 aprovados/7 skips previstos, porta dedicada 4187.
- Auditoria npm aprovada, zero altas/críticas; um baixo/cinco moderados existentes.

Logs sintéticos em var/olist-t06-*.log, fora do versionamento. Entrega atômica
identificada por OLIST-T06 na branch codex/olist-phase3; sem acesso autenticado
ao ERP, deploy, migração adicional ou piloto. Próximas tarefas T22/T07; gate F3
permanece aberto até sequência confiável e guardas posteriores.

## Fechamento T22 — 06/11/2026

Resolvedor, builders e writer internos entregues com migration expand 0066.
Sem rota criadora ou handler ativo: o comando/snapshot humano e a integração de
worker/venda seguem T07/T08. Nenhum acesso autenticado ao ERP, deploy,
habilitação ou piloto ocorreu. Nenhuma dependência externa foi adicionada;
Olist reutiliza o módulo Contacts existente para validar o comprador.

- `npm run validate`: aprovado, 1884 testes/18 skips explícitos, incluindo
  tipos, lint, formatação, fronteiras, validadores e build.
- Resolver adversarial: 14/14; transporte reservado/builders: 11/11.
- SQL T22: 11/11 sem skips, incluindo resolver/writer/PostgreSQL reais com
  provedor HTTP sintético, concorrência M/G vs G/P, timeout, falha de commit,
  revogação/configuração e recuperação sem novo POST.
- Regressão SQL ampliada Pedidos/Loja/Olist: 113/113 aprovados, zero skips.
- E2E completo: 485 aprovados/7 skips previstos, porta dedicada 4187.
- `npm audit --audit-level=high`: aprovado, zero altas/críticas; um baixo e
  cinco moderados preexistentes, sem atualização de dependências.
- Revisão independente Backend/Integrações/QA sem findings altos/críticos após
  corrigir a coerção de origem fiscal ausente para zero e validar o negativo.

A suíte `test:olist:live` inclui os testes SQL de recursos; o skip novo no gate
unitário é executado separadamente com TEST_DATABASE_URL dedicado. O teste de
upgrade confirma todas as expansões posteriores à fundação, inclusive 0066,
preservando jobs antigos e reapply vazio. As fixtures de listagem foram
corrigidas para sku, conforme schema oficial, sem aceitar codigo como prova.

Logs sintéticos em var/olist-t22-*.log, não versionados. Entrega atômica OLIST-T22
na branch codex/olist-phase3. Próximo item T07; gate F3 permanece aberto.
