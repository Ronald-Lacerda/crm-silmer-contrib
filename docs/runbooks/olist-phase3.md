# Olist — Fase 3: composição, prévia, comando, despacho e reconciliação Olist

OLIST-T20/T21/T26/T24/T06/T22/T07/T08/T09, composição, fontes, cadastros, venda e vínculo. Requisitos
OLIST-09–10, 29, 34, 40–44;
[ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).

## T09 — vínculo existente e reconciliação administrativa

OLIST-13–18, 25, 30, 32, 36–39. Somente Admin atual pode vincular ou reconciliar;
checkbox Olist de vendedor/Financeiro não concede esse poder, e Admin não precisa
do checkbox para estas ações. Sessão/CSRF/Origin são obrigatórios nos comandos.
Todo acesso revalida o Admin real, inclusive replay e gravação após GET remoto.
Não habilita criação, não permite URL arbitrária e não adivinha doc.view: a
projeção administrativa mostra o número ERP enquanto não houver URL confiável.

### Venda existente

POST /api/v1/orders/:orderId/olist/existing/previews recebe somente saleId, ID
positivo seguro em texto. Confere fonte comercial/cadastro atuais e parâmetros
centrais sem depender do status confirmado. GETs oficiais limitados verificam
comprador completo, pai, fiscal, descrição composta e grade/filho independente.
Cada linha precisa corresponder a produto, quantidade e unitário/subtotal exato;
ambos os totais devem coincidir. Sem referência/marcador em venda antiga, só
aceita bijeção inequívoca; marcador errado, referência de outro Pedido, fusão,
linha omitida/repetida ou compensação de valores bloqueiam. Ausência da referência
não dispensa origem, datas, situação aberta e demais condições conferíveis T08.

Recibo AES-GCM vincula Admin/sessão/Pedido/conta/contexto, fontes, versões,
parâmetros, ID/número e HMAC das leituras. Expira em 15 minutos e é limitado a
262144 caracteres; snapshot conserva limite de 128 KiB. POST /links recebe
previewToken e motivo, com Idempotency-Key. Reconsulta remoto fora de SQL e
revalida sessão/fontes/versões dentro da transação final. Snapshot/vínculos/
prova/motivo cifrados, evento, auditoria e recibo compartilham o mesmo client.
Duas prévias/chaves convergem para um vínculo; conflito de ID ou conteúdo não
sobrescreve histórico. Mesma chave/corpo retorna resposta original após TTL,
mas exige acesso atual; corpo/sessão/alvo divergentes conflitam.

As constraints por Pedido/conta e venda/conta são as mesmas da criação.
Qualquer tentativa de venda existente, inclusive incerta/reservada, nega o
modo legado. Operação prévia conserva snapshot/executor e só aceita semântica
igual; uma reserva que surgir durante GET vence o link. Worker de criação que
observar linked conclui sem POST. Nenhum link publica job de exportação.
Cadastros incertos também não são liberados pelo link de uma venda antiga.

SKU legado é verificado junto com ID/atributos/fiscal/grade e congelado em
verified_remote_sku, protegido contra mudança ou troca de ID. Prévia T06 e
resolvedor T22 só o reutilizam pelo ID já confirmado e igualdade com o SKU
conferido. Sem essa evidência, a referência determinística continua estrita.
Mudança remota posterior é divergência; nenhum cadastro ERP é atualizado.

### Reconciliação enfileirada

GET /administration fornece operação/recursos, versões para CAS, requests e
até 100 tentativas recentes, com indicação de truncamento. Só expõe IDs,
atores, estados, horários e códigos; motivo, snapshot e corpo ERP ficam cifrados.
POST /reconcile recebe stage, resourceId (null apenas em sale), expectedVersion
do alvo e motivo. Comando idempotente grava request/auditoria/job atomicamente,
sem HTTP. GET /reconciliations/:requestId acompanha queued/succeeded/blocked.

Fila PostgreSQL própria olist_reconcile usa job interno olist.reconcile e
requestId persistido; consumidor exige OLIST_ENABLED/configuração completa e
independe de OLIST_DISPATCH_ENABLED. Não importa dispatcher, resolvedor criador
ou writers. creation_enabled=false/recovery_required=true e executor original
revogado não impedem a leitura administrativa; Admin/época/conexão atuais e
heartbeat são verificados antes dos HTTP e da confirmação. Credenciais usam a
porta OAuth fixa; nenhuma chamada de inclusão/edição/exclusão ERP é feita.

Recurso usa base e tentativa imutáveis, documento/SKU/ID observados e confirmação
independente de pai/grade/filho. ID-pai observado em POST de variação continua
preservado e só permite confirmar o filho canônico provado pela grade. Venda
com tentativa exige bytes do request congelado iguais e comparação T08 estrita,
sem exceção legada nem troca de ID/número observado. Vínculo legado já aprovado
pode ser reconferido somente pelo mesmo ID/número, mapping de comprador/pai/filhos
e SKUs congelados; a ausência de referência não é reinterpretada como novo efeito. Zero/múltiplos/divergência
conservam reserva e bloqueiam dependentes. Resultado positivo atualiza somente
o alvo pedido e ledger; não avança nem publica novas inclusões. Tentativa incerta
anterior não é reescrita quando chega prova positiva. Snapshot e executor não
são substituídos por configuração ou pessoa atuais.

Revogação/lease/conexão perdida antes da confirmação só registra erro seguro no
ledger do request autenticado; nunca confirma alvo. Jobs de leitura não fazem
retry automático por resultado; eventual recuperação de lease repete somente
GETs e CAS. Nova análise exige novo comando administrativo, nunca liberar POST
por consulta vazia, tempo decorrido ou reset da fila.

### Migração e rollback

Aplicar 0069_olist_administrative_reads.expand.sql após 0068 e antes do código.
Ela congela SKU/ID conferidos, adiciona requests cifrados imutáveis e compõe
constraints de outbox preservando os tipos/targets anteriores. Nenhuma nova
infraestrutura, dependência externa, conta habilitada ou URL compartilhável.

Rollback pausa a fila olist_reconcile e comandos novos, drena leituras e conserva
requests/jobs/recibos, chaves/envelopes, mapping, SKUs, reservas, observações e
auditoria. Não apagar vínculo, limpar tentativa ou executar down destrutivo.
Despacho real segue desligado; T23/T10 e gates operacionais ainda abertos.

## T08 — despacho reservado e comparação remota

OLIST-13–17, 20, 25–27, 36–41. O consumidor dedicado da fila olist exige
OLIST_DISPATCH_ENABLED=true e configuração completa; ausente, vazio ou false
não consulta banco, fila ou HTTP. Conta continua exigindo creation_enabled=true,
recovery_required=false e conexão válida. Defaults permanecem desligados.
Esta entrega não autoriza ativação real, deploy ou piloto.

### Sequência e reserva

Job olist.export fornece somente exportId; snapshot cifrado e executor/época
originais governam o despacho. Preflight integral precede até a criação do
cliente. Exige política exact-cent-v1 e paymentDueOn explícito e válido para
uma parcela do total inteiro. paymentTerms é descritivo: não infere vencimento,
parcelamento nem pagamento. receivingMethodId é opcional e validado em catálogo.
Snapshot antigo sem vencimento bloqueia antes de qualquer cadastro; configuração
real de natureza/origem/gatilhos permanece no gate T15.

Cliente, pais e variações usam tickets T22. Cada etapa revalida executor/checkbox/
época, conta, conexão, parâmetros, Pedido e fonte. Ready exige todos os vínculos
confirmados na mesma conta e mapping congelado cifrado/HMAC. Reserva final
revalida tudo e persiste request cifrado/ticket antes de um único POST /pedidos.
A referência remota é consultada antes dos cadastros e novamente após ready,
imediatamente antes da reserva da venda.
Credenciais são atuais; heartbeat precede cada HTTP, inclusive refresh. Perder
lease depois da reserva conserva incerteza e não autoriza repetição.

Venda aberta usa datas congeladas, IDs verificados e marcador opaco por linha.
ID e número retornados são observados antes do GET, inclusive se falhar quota
ou a resposta secundária. Não confirma pagamento nem altera o Pedido comercial;
não chama emissão fiscal, baixa/estoque adicional, exclusão ou cancelamento ERP.

### Comparação e recuperação

GET bruto limitado preserva lexemas numéricos sem Number monetário. Confirma
comprador/documento, origem/referência, situação e datas, depois exige bijeção
de linhas por marcador, produto, quantidade, unitário e subtotal exatos. Ambos
os totais retornados devem coincidir com snapshot. Reordenação é aceita; linhas
fundidas, repetidas, omitidas ou compensadas são recusadas mesmo com total global
igual. Prova mínima cifrada e vínculo confirmado são persistidos juntos.

Tentativa existente exige igualdade byte a byte com o request reservado e segue
somente por leitura. ID conhecido usa GET; sem ID, busca completa confirma a
referência em ecommerce.numeroPedidoEcommerce antes do GET bruto. Zero, múltiplos
ou divergência mantêm bloqueio sem outro POST. Venda preexistente sem ticket
exige T09, sem vínculo automático. ID/número de até 19 dígitos observados no POST
são preservados como texto; ID acima de MAX_SAFE_INTEGER fica incerto porque a
porta GET atual exige inteiro seguro; número acima desse limite também impede
confirmar readback na porta atual. Nunca arredondar ou repetir inclusão.

O job marca efeito antes do dispatcher e não faz retry automático. Erros expõem
somente códigos seguros; GET Olist pode projetar errorCode sem request, resposta
remota ou PII. Reconciliação administrativa completa está em T09 acima; guardas posteriores/
restore são T10. A fase 3 permanece aberta.

### Migração e rollback

Aplicar 0068_olist_sale_dispatch.expand.sql depois de 0067 e antes do código.
Acrescenta mapping, ID/número observado, erro e prova cifrada, protegidos por
triggers imutáveis; não habilita conta/worker. Upgrade/reapply preservam jobs e
reservas anteriores. Sem infraestrutura ou dependência externa nova.

Rollback desliga OLIST_DISPATCH_ENABLED e comandos novos; drena efeitos em voo
e preserva filas, reservas, chaves/envelopes, observações e auditoria. Não apagar
reserva ou restaurar backup para liberar POST. Sem down destrutivo. Resultado
já iniciado é preservado após revogação; próxima inclusão exige autorização
atual novamente.

## T07 — comando idempotente, snapshot e job

OLIST-01–02, 06, 11–15, 30, 33. `POST /api/v1/orders/:id/olist/export` recebe
somente `{previewToken}`. Exige humano ativo com checkbox Olist (incluindo
Financeiro/Pedido alheio), sessão, CSRF, Origin e Idempotency-Key opaca válida.
Não aceita conta, preço, total, vendedor, versões, cadastro ou payload ERP do
navegador. A resposta 202 expõe somente operationId, orderId, number, state,
stage e creationEnabled:false. Ela reconhece a operação local e não comprova
qualquer inclusão ou despacho no provedor. Usar o GET Olist para estado atual.

### Aceitação e concorrência

O comando bloqueia autoridade atual, conversa antes do Pedido e Pedido desde a
primeira leitura exclusiva, evitando upgrade SHARE→UPDATE entre duas abas.
A prévia é autenticada por AAD de ator/sessão/Pedido/conta/contexto. Sua primeira
aceitação revalida expiração, fontes e sourceVersions completos (inclusive
identidade do Contato), parâmetros e conexão na mesma transação do comando.
A prévia T07 passou a conter os parâmetros centrais cifrados para congelamento;
recibo antigo/obsoleto exige nova conferência antes de uma primeira operação.
Não há GET nem POST ao ERP nesse comando.

Snapshot, reserva lógica por Pedido/conta, publicação outbox, evento, auditoria
olist.export.request e conclusão do recibo idempotente compartilham exatamente
o client da transação do PostgresIdempotencyRecordStore. Falha em qualquer uma
dessas escritas reverte todas. O job carrega somente olist_export_id, na fila
olist. A configuração/versões e os dados comerciais mínimos ficam no envelope
AES-GCM do snapshot, sem sessão, ficha, arte, anexos, IA ou notas de atendimento.

A chave é escopada por ator/contexto/ação e o fingerprint do request inclui
Pedido, token e sessão. Preserve a mesma chave e token no retry. Mesma chave
com outro corpo, sessão ou alvo é conflito. Chaves ou tokens de prévia distintos
do mesmo plano convergem para a operação única, sem duplicar job/evento/auditoria
ou mudar executor/época originais. O fingerprint semântico é HMAC de dados e
versões oficiais, excluindo IV, tempo da prévia, sessão, ator e observações de
recursos. Divergência real retorna OLIST_EXPORT_CONFLICT.

### Replay, data e gates

Replay da mesma chave retorna a resposta original mesmo após o token expirar,
mas revalida sessão, usuário/checkbox/época, configuração e gates atuais antes
de ler o recibo persistido. Nova chave para operação existente autentica o token
e compara a semântica antes de devolver o vínculo; não recria, não exige fontes
antigas ainda iguais e não recalcula o snapshot. Retorno de operação existente
não renova a autorização do executor ou as versões congeladas para a T08.

Com orderDate existente, o snapshot a preserva; sem ela, congela o dia de São
Paulo do primeiro comando aceito. Virar o dia antes da primeira aceitação exige
nova prévia. No fingerprint a data proposta ausente permanece null, permitindo
consultar a mesma reserva em outro dia sem alterar a data efetiva congelada.
Não altera status, quitação, Nota criada, datas, total, ficha ou métricas CRM.

Conta exige creation_enabled=true e recovery_required=false, conexão atual
válida e sem renovação/troca em curso. Esses controles continuam desligados por
padrão e nenhum valor real foi modificado. T08 acrescenta consumidor separado
opt-in e revalidação por efeito; o worker padrão não consome essa fila.
Não ativar o piloto só porque o comando local devolveu 202.

### Migração e rollback

Aplicar 0067_olist_export_command.expand.sql antes do código. Acrescenta
command_fingerprint imutável ao snapshot. Linhas antigas continuam com null;
não são reinterpretadas, preenchidas ou substituídas para autorizar outra venda.
Comando novo sobre reserva antiga sem fingerprint pede análise explícita.
Não há nova infraestrutura ou dependência.

Rollback desliga comandos novos e preserva fila/snapshots, chaves/envelopes,
0066/0067, fingerprints, vínculos e auditoria. Não apagar operação, limpar job,
restaurar backup ou excluir cadastro ERP para liberar outra tentativa. A ordem
de locks de leitura Contacts/identidades ainda pode disputar com merge legado;
um deadlock reverte o comando local inteiro, sem efeito externo. Nenhum retry
cego de efeito ERP foi introduzido por esse tratamento.

## T22 — resolução e criação segura de cadastros

OLIST-07–08, 12–17, 27, 35–39. `createOlistResourceResolver` é uma porta interna:
recebe exportId e autoridade atual, carrega o snapshot cifrado/imutável do export
e ignora qualquer plano comercial fornecido pelo caller. Não existe rota pública
para cadastros. T08 compõe o resolvedor em worker dedicado opt-in acima.
Criação real continua desligada.

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

## Fechamento T07 — 06/11/2026

Comando idempotente e migration expand 0067 entregues. Uma operação por
Pedido/conta, snapshot/job/evento/auditoria/recibo na mesma transação, com
comando HTTP estrito e autoridade/época atuais inclusive antes do replay.
Nenhum acesso autenticado ao ERP, despacho, deploy, habilitação ou piloto.
Snapshot local é limitado a 128 KiB; falha de limite/persistência não publica
artefatos parciais. Não há nova dependência ou infraestrutura.

- `npm run validate`: aprovado, 1886 testes/20 skips explícitos, incluindo
  tipos, lint, fronteiras, formatação, validadores e build.
- SQL do comando/API: 12/12 aprovados, zero skips; confirma duas prévias/chaves/
  runtimes, replay após expiração/dia seguinte, fontes obsoletas, revogação,
  configuração ausente e rollback em três fronteiras de persistência.
- SQL do repositório T07: 8/8 aprovados, zero skips; cobre conexões concorrentes,
  plano divergente, outro executor, outer transaction sem nested commit e legado.
- Regressão SQL ampliada Pedidos/Loja/Olist: 133/133 aprovados, zero skips.
- API de fronteira: 15/15 aprovados; OpenAPI atualizado.
- `npm audit --audit-level=high`: aprovado, zero altas/críticas; um baixo/cinco
  moderados preexistentes, sem atualização de dependências.
- Revisão independente Backend/QA sem findings altos/críticos restantes.

E2E com seis workers teve 484 aprovados/7 skips e timeout de 30 segundos no
mesmo dispositivo sintético Firefox, em duas execuções. O caso isolado passou
1/1, sem alteração de teste, timeout ou código. A execução integral final usa
dois workers e terminou com 485 aprovados/7 skips previstos, sem falhas e sem
alterar testes ou limites de tempo. Log var/olist-t07-e2e-workers2.log.

Logs sintéticos em var/olist-t07-*.log, fora do versionamento. As duas novas
suítes PostgreSQL também entram em test:olist:live; os skips do gate unitário
foram executados separadamente em banco dedicado. Entrega atômica OLIST-T07 na
branch codex/olist-phase3. Próximo item T08; gate F3 permanece aberto.

## Fechamento T08 — 06/11/2026

Dispatcher, consumidor dedicado opt-in e migration expand 0068 entregues. O
snapshot governa a sequência cliente/pais/variações/venda; cada efeito tem
revalidação e ticket. Mapping/request/prova são imutáveis, ID/número antecedem
GET e a comparação lossless exige cada linha e total, inclusive contra
compensação entre linhas. Nenhuma dependência externa ou infraestrutura nova.

- npm run validate: aprovado, 1922 testes/21 skips explícitos, incluindo tipos,
  lint, formatação, fronteiras, validadores e build.
- Regressão SQL ampliada Pedidos/Loja/Olist: 146/146, sem skips. A suíte T08
  integrada foi repetida após a última guarda de referência: 13/13 aprovados.
- Dispatcher final: 15/15; worker: 6/6; transporte/codec: 14/14. Cenários incluem
  concorrência, timeout, falhas de commit, revogação/configuração, precisão,
  total compensado, request congelado divergente e identidade extensa.
- npm audit --audit-level=high: aprovado, zero altas/críticas; um baixo/cinco
  moderados preexistentes, sem atualização de dependências.
- E2E completo: 485 aprovados/7 skips previstos, dois workers, porta dedicada
  4187; nenhuma alteração em assertions, timeout ou testes de interface.
- Revisão independente Backend/Integrações/QA sem findings altos/médios após
  correções de referência oficial, request reservado e observação de IDs.
  Núcleo final (client/dispatcher/worker/transporte): 63/63, sem skips.

A suíte test:olist:live inclui agora o SQL da venda. Os skips sem banco no gate
unitário foram executados separadamente com TEST_DATABASE_URL dedicado. O
PostgreSQL sintético 18.6 foi encerrado após os gates SQL. Logs sintéticos em
var/olist-t08-*.log, fora do versionamento. Despacho e conta continuam desligados
por padrão, sem acesso real ao ERP, deploy ou piloto. Entrega atômica OLIST-T08
na branch codex/olist-phase3. Próximos T09/T23/T10; gate F3 permanece aberto.


## Fechamento T09 — 06/11/2026

Vínculo existente e reconciliação administrativa concluídos no domínio/API e
worker isolado, com migration expand 0069 e OpenAPI atualizado. Admin sem
checkbox pode conferir/vincular, sem herdar geração. Venda legada sem referência
usa prova completa e bijeção inequívoca; efeito iniciado continua estrito.
Mapping, SKU/ID, número, snapshot, tentativas e ledger conservam sua história.
Não há POST adicional de cadastro/venda, atualização ou exclusão ERP, avanço
automático de dependentes ou configuração real alterada.

- npm run validate: aprovado, 1962 testes/23 skips explícitos, incluindo tipos,
  lint, formatação, fronteiras, validadores e build.
- PostgreSQL integrado Pedidos/Loja/Olist: 178/178 aprovados, zero skips. Inclui
  16 testes do repositório administrativo e 16 da vertical API/comando/fila/worker.
- Inspector final: 25/25; worker isolado: 6/6; fronteira API: 8/8. Cobertos
  legado/ausência, zero/múltiplos/divergência, soma compensada, revogação, fonte
  obsoleta, adulteração/expiração, concorrência, rollback e perda de lease.
- Regressão T06 preserva SKU determinístico sem evidência legada; provas novas
  congelam SKU e ID e recusam mudança posterior. Vínculo legado já aprovado
  reconcilia só os mesmos comprador/pai/filhos/SKU/número, sem novo POST.
- E2E completo: 485 aprovados/7 skips previstos, dois workers e porta 4187,
  sem alterar assertions, timeouts ou código da interface.
- npm audit --audit-level=high: aprovado, zero altas/críticas; um baixo/cinco
  moderados preexistentes, sem atualização de dependências.
- Revisão independente Backend/Integrações/QA sem findings altos/médios após os
  fechamentos de SKU, reconferência de vínculo legado, pai por grupo e número
  em corrida. git diff --check aprovado.

Os skips SQL do gate unitário foram executados separadamente em banco dedicado;
as duas suítes administrativas entram em test:olist:live. PostgreSQL 18.6
sintético encerrado após a regressão final. Logs em var/olist-t09-*.log, fora do
versionamento. Nenhuma nova dependência externa ou infraestrutura. Entrega
atômica OLIST-T09 na branch codex/olist-phase3; despacho real/deploy/piloto
continuam desligados. Próximos T23/T10; gate F3 permanece aberto.
