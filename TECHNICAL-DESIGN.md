# TDD — CRM Silmer MVP

## OLIST-T17 — envio simples em aberto (09/11/2026)

[ADR 072](docs/adr/072-envio-em-aberto-sem-duplicar-cadastros-do-erp.md) e
[RFC 056](docs/rfc/056-envio-simples-da-ficha-com-cadastros-no-olist.md).
A revisão faz prévia/check automaticamente e a confirmação autoriza o envio.
`buyerSource.mode=erp-existing-v1` congela ID, nome/telefone normalizados,
documentHash opcional e digest HMAC da conta, em envelope cifrado. Não escreve
cadastro CRM, não inclui cliente e não cria seu recurso compartilhado. Resolver
e dispatcher relêem a identidade antes de reservar cada efeito, sem HTTP sob
lock ou entre reserva de quota de escrita e POST. Mapeamentos exigem ID do
comprador igual à referência congelada; demais recursos mantêm seus locks.

`productFiscalDeferred=true` só vem do servidor e omite integralmente os campos
fiscais opcionais. `paymentDuePolicy=erp` omite pagamento/parcelas e transmite
apenas a condição enum da ficha por frase fixa em observações, sem chat/PII.
Venda continua em situação 0. Check/export não aceitam substituir essas
decisões e os modos anteriores seguem compatíveis. Endereço e cadastro fiscal
do comprador continuam sob responsabilidade do Olist.

## OLIST-T16 — comprador histórico com telefone divergente

[ADR 073](docs/adr/073-comprador-no-vinculo-historico-com-telefone-divergente.md) / [RFC 057](docs/rfc/057-comprador-no-vinculo-historico-com-telefone-divergente.md): prova privada própria por conta e venda, nome exato e comprador ativo derivado da venda selecionada. A projeção pública informa a divergência sem expor telefones; confirmação e motivo existentes se aplicam somente ao vínculo histórico. Releitura no commit, replay e reconferência preserva a identidade congelada, sem referência reutilizável, recurso compartilhado, job ou POST ERP. O fluxo automático de novos envios continua exigindo nome e telefone.

## OLIST-T16 — retirada local com venda conhecida

[ADR 075](docs/adr/075-retirada-local-de-vinculo-historico-sem-liberar-duplicata.md) / [RFC 059](docs/rfc/059-retirada-local-de-vinculo-historico-no-olist.md): o comando administrativo existente pode retirar somente o vínculo legado isolado e sem efeitos. A API autentica os modos dos envelopes cifrados; o guard SQL confere estado anterior, IDs preservados, evento legado da mesma operação e ausência de recursos, tentativas, jobs e leituras em voo. O estado terminal `legacy_review_required` mantém os índices ativos, unicidade e bloqueios comerciais do pedido. Não usar `invalidated` comum, reconciliar para reativar ou anunciar replay como vínculo ativo. A retirada serializa export e jobs em ordem estável; inserts/reparentamento de claims cercam o export, mas atualizações normais de status da fila não adquirem a trava inversa. O teste concorrente cobre claim e retirada, sem HTTP dentro da transação. Não alterar ERP nem ampliar ACL; novos pedidos não herdam a pendência.

## OLIST-T16/T17 — vencimento e vínculo histórico (09/11/2026)

[ADR 071](docs/adr/071-vencimento-explicito-e-vinculo-historico-isolado-no-olist.md),
[RFC 055](docs/rfc/055-vencimento-por-pedido-e-vinculo-historico-no-olist.md).
`paymentDuePolicy=per_order` exige `paymentDueOn` na prévia; a data resolvida
fica cifrada no snapshot e participa da assinatura comercial. Check e export
recuperam o valor congelado; export continua token-only. A política ausente
preserva a data central fixa anterior.

`existing/legacy/previews` recebe IDs de pai/filho e a posição de cada item;
`existing/legacy/links` exige recibo, declaração e motivo. A trilha exclusiva
`legacy-sale-only-v1` relê e confere a correspondência completa antes do commit,
sem publicar recursos compartilhados, reservas ou jobs. Operações incertas e
vínculos canônicos mantêm seus verificadores anteriores. Autorização, sessão,
versões, idempotência e unicidade da venda permanecem obrigatórias.
O leitor histórico confere os valores exatos e congela metadados reais do ERP;
não usa defaults fiscais ou de origem das novas vendas para simular o passado.

## OLIST-T27/T28 — invalidação administrativa e quota (09/11/2026)

[ADR 069](docs/adr/069-olist-invalidacao-administrativa-de-export.md) e
[ADR 070](docs/adr/070-olist-quota-com-espera-de-leitura-e-folga.md), OLIST-51/52.
`POST /api/v1/orders/:orderId/olist/invalidate` (ação `olist.invalidate`, só Admin,
200 síncrono) revalida o ator sob lock, trava conexão, conversa, Pedido, export,
recursos e job na ordem existente e recusa com qualquer tentativa de venda,
recurso `reserved`/`uncertain` ou job em execução. A migração 0071 troca a
unicidade por `UNIQUE(account_key, order_id) WHERE state <> 'invalidated'`, cria
o recibo append-only (motivo só em envelope AES-GCM) e três triggers. Quota:
`attempt` único sob advisory lock; `reserveRead` espera fora de transação
(worker 90 s, conferência 180 s, API 8 s e teto 24/30, `verifyAccount` 15 s),
`reserveWrite` exige folga para as leituras do POST e nunca espera. Retry
pré-efeito de `OLIST_RATE_LIMITED`, `OLIST_UNAVAILABLE` e
`OLIST_REFRESH_IN_PROGRESS` com backoff de 15 s a 300 s e 8 tentativas.
Sem rollback de código depois da primeira invalidação.
[Runbook](docs/runbooks/olist-phase5.md#invalidação-administrativa-e-quota).

## Ordem de Responder — INBOX-VEZ-08 (08/11/2026)

[ADR 066](docs/adr/066-responder-por-mensagem-mais-recente.md), PCX-19e:
o repositório da Inbox ordena Responder pela última mensagem e ID decrescentes.
`sort_position` trunca `last_message_at` a milissegundos e alimenta SQL e cursor;
`turn_since` continua exclusivo do início da espera e das ordens das demais abas.
O fingerprint versiona somente Responder com `latest-message-v1`, recusando
cursores da antiga ordem. Classificação, alertas e consultas legadas permanecem.

## Contrato de intenção de cobrança, COB-CHAT-B01 (06/11/2026)

[ADR 076](docs/adr/076-intencoes-de-cobranca-e-envio-transacional.md) e
[API](docs/api/order-billing-chat.md): POST de intenção discriminada, GET de
intenção e histórico privado paginado. Fronteira injetável e escrita false
por padrão. B02 implementa contexto/versões,
idempotência e histórico sob transação na migração expand 0073, preservando
as filas existentes e a identidade do ator. B03 compõe callback,
mensagem/outbox/auditoria na mesma transação e reserva final; migração 0074
projeta estados reais, sem retry de efeito incerto. O transporte humano
revalida comandos `billing_send:true` pelo preflight autenticado antes do HTTP
externo. B04 integra rotas, serviço e flags na API/worker sem interromper
recebimento. Nenhuma flag habilitada nem workflow remoto publicado. Frontend adiado.

## Triagem prioritária do Vendedor — VND-L05 (06/11/2026)

[ADR 063](docs/adr/063-triagem-prioritaria-do-vendedor.md), AGT-01–05/08:
o normalizador `mvp-simple-23` trata dúvida explícita de mínimo/viabilidade
e alternativas de quantidade com `commercial_question`/`human_requested`.
Notas e resumo existentes preservam contexto sem novo campo de API. Não há
catálogo inferido ou mínimo fixo. Prazo desejado inequívoco hoje/amanhã gera
`urgency` antes da ficha completa; enviar arte, pagar ou pedir orçamento para
essas datas não define entrega. Data ambígua mantém confirmação. Pergunta
gerada de campo preenchido segue para o próximo ponto faltante.
Publicação exige delta revisado do prompt/normalizador, preservando overlays,
guardrail, abertura humana, transporte, reservas, epoch e revisão; preparação
offline recusa drift e dados fixados. Sem migração ou infraestrutura nova.
[Operação e rollback](docs/runbooks/vendedor-prioridades.md).

## OLIST-T11 — interface administrativa Olist (07/11/2026)

OLIST-03–05, 11, 22–25 e 48: `/olist` oferece conexão/reconexão/desconexão,
parâmetros comerciais/fiscais completos e consultas limitadas de referências
e mapeamentos por recurso. Administração depende de `COMMERCIAL_ADMIN`, sem
herdar ou conceder habilitação de geração. Código/estado OAuth são removidos
da URL antes do shell, consumidos uma vez e não persistidos no navegador.

A edição captura a versão original, preserva vencimento/recebimento/fiscal
e trata conflito sem sobrescrever rascunho; refresh não abre edição obsoleta.
Respostas tardias não restauram consultas após mudança de conexão ou revogação.
Sem transporte criador, migration, dependência ou infraestrutura nova; geração
real permanece desligada. [Contrato, evidências e rollback](docs/runbooks/olist-phase4.md).
T11 inicia F4; T12/T13/T25 e gates operacionais F5/F6 continuam pendentes.

## OLIST-T10 — guardas comerciais e recuperação (06/11/2026)

OLIST-02, 06, 16, 19, 21, 27–30, 39, 45–47: toda escrita de ficha,
projeção automática, reabertura, arte e correção de quantidade da loja consulta
o ledger Olist sob o mesmo lock do Pedido usado por exportação/cancelamento.
Reserva ativa ou efeito/ID remoto sobrevivente bloqueia alterações, inclusive
se a operação foi invalidada/rejeitada. Fontes suplementares usam a mesma guarda.

Pendente exportado/vinculado só confirma com ficha, total, quantidade e condição
idênticos; preserva os bytes do envelope e o snapshot Olist, sem seguir o nome
atual do Contato. Confirmação mantém sua autoria/data humanas. Operação em curso
ou incerta exige aguardar/reconciliar. Pagamento/entrega continuam comandos
independentes; exportação não os declara nem altera o check financeiro.

Cadastros compartilhados preservam resultados de efeitos iniciados após
cancelamento/revogação, sem liberar dependentes. Restore mantém criação desligada
com recovery_required; consultas administrativas continuam separadas. Nenhum
lease vencido ou resultado ausente autoriza novo POST. Sem migration adicional,
dependência ou infraestrutura. [Contrato e evidências](docs/runbooks/olist-phase3.md#t10--guardas-comerciais-e-recuperação).

## OLIST-T09 — vínculo e reconciliação por leitura (06/11/2026)

OLIST-13–18, 25, 30, 32, 36–39: Admin atual, sem herdar checkbox, confere venda
existente por ID e vincula com recibo cifrado de 15 minutos, motivo e idempotência.
GETs verificam comprador, fiscal, pai/grade e cada linha/total; legado sem
referência/marcadores só passa com correspondência inequívoca. Referência de
outro Pedido bloqueia. Link reconsulta fora de SQL e grava snapshot, recursos,
prova, auditoria e recibo atomicamente, com as constraints da criação.

Migration expand 0069 congela SKU remoto conferido e publica requests cifrados
na fila interna olist_reconcile. Consumidor administrativo separado usa somente
leituras do ERP e funciona com criação desligada/executor original revogado.
Revalida Admin/época/conexão/lease; incerteza nunca libera POST nem dependentes.
Snapshot/request/IDs e história anteriores são preservados. Diagnóstico expõe
IDs/estados/versões/tentativas mínimos; mostrar número ERP, sem URL inferida.
[Contrato, evidências e rollback](docs/runbooks/olist-phase3.md#t09--vínculo-existente-e-reconciliação-administrativa).
Próximos T23/T10; F3 aberto, despacho real/deploy/piloto permanecem desligados.

## OLIST-T08 — despacho reservado e comparação exata (06/11/2026)

OLIST-13–17, 20, 25–27, 36–41: consumidor dedicado opt-in da fila olist lê
somente exportId e usa snapshot cifrado e executor/época originais. Cada etapa
revalida autorização, versões e conexão; cada efeito tem ticket durável antes
do HTTP e exige lease válido. Migration expand 0068 congela mapping, request,
ID/número observado e prova cifrada do GET. Retomada compara os bytes reservados
e só consulta. Confirmação exige cada linha e ambos os totais exatos, sem Number
monetário; incerteza nunca libera novo POST.

paymentDueOn explícito define uma parcela do total, sem dedução pelo texto de
prazo ou confirmação de pagamento. OLIST_DISPATCH_ENABLED e conta seguem
desligados por padrão. [Contrato e rollback](docs/runbooks/olist-phase3.md#t08--despacho-reservado-e-comparação-remota).
Próximos T23/T10; F3 aberto, sem ERP real, deploy ou piloto nesta entrega.

## OLIST-T07 — comando idempotente com snapshot e job (06/11/2026)

OLIST-01–02, 06, 11–15, 30, 33: POST /api/v1/orders/:id/olist/export recebe
somente previewToken, com sessão/CSRF/Origin/Idempotency-Key e checkbox atual.
A primeira aceitação revalida a fonte na mesma transação que grava snapshot
cifrado, operação única por Pedido/conta, job, evento, auditoria e recibo.
Request divergente com a mesma chave é conflito; prévias/chaves do mesmo plano
convergem sem duplicar operação ou trocar executor/data. Migration expand 0067
protege o fingerprint semântico imutável e preserva os snapshots antigos.

A data ERP é congelada no comando sem confirmar ou mudar datas do Pedido.
Gates atuais são obrigatórios inclusive no replay; T08 acrescenta consumidor
opt-in. Conta e despacho seguem desligados por padrão, sem
acesso real ao ERP, deploy ou piloto. [Contrato e rollback](docs/runbooks/olist-phase3.md#t07--comando-idempotente-snapshot-e-job).

## OLIST-T22 — resolução e criação segura de cadastros (06/11/2026)

OLIST-07–08, 12–17, 27, 35–39: resolvedor interno carrega somente o snapshot
cifrado do export, valida todo o plano antes dos efeitos e compartilha cliente,
pai e tamanhos por identidade. Migration expand 0066 congela base da entidade,
request por tentativa, relação pai/filhos e ID observado antes das leituras.
Pai V reserva o lote inicial inteiro antes de um único POST; demais tamanhos
usam seu próprio ticket. Resultado incerto nunca libera recriação por tempo ou
busca vazia. Reconciliação positiva preserva o histórico anterior.

Política fiscal opcional productFiscal nos parâmetros centrais é explícita e
versionada, sem default. Prévia conhece a política e confirma situação/SKU nos
catálogos; cliente não recebe codigo nem acesso ao ERP. Nenhuma rota criadora
genérica foi habilitada; T08 acrescenta worker dedicado opt-in.
UI, operação e piloto continuam pendentes. [Contrato e rollback](docs/runbooks/olist-phase3.md#t22--resolução-e-criação-segura-de-cadastros).

## OLIST-T06 — prévia completa sem escrita ERP (06/11/2026)

OLIST-06–12, 34–44: API dedicada com checkbox/sessão/CSRF lê fontes atuais,
legado T26 e loja T24, revalida cadastro/ficha/subtotais/total independentemente
de status e planeja cliente/pai/tamanhos por identidade verificável. Frações,
ambiguidades, divergência remota, falta fiscal e incerteza bloqueiam exportação.
GETs são limitados e executados fora de SQL; não há reserva, snapshot/job ou
escrita ERP. Recibo AES-GCM vinculado à sessão e versões expira em 15 minutos;
qualquer fonte alterada exige nova conferência. Criação permanece desligada.
Natureza/origem/gatilhos e parâmetros fiscais reais continuam em T15/T22.
[Contrato, limites e rollback](docs/runbooks/olist-phase3.md#t06--prévia-completa-sem-escrita-erp).

## OLIST-T24 — complementos da loja preservam o snapshot

Adaptador da loja concluído no domínio/API conforme ADR 067/RFC 054: a única
linha validada recebe o total persistido, sem rateio ou catálogo atual.
Admin comercial fornece previsão, Aplicação e cadastro fiscal explícitos no
suplemento cifrado; pendências não são inventadas e não há criação de Contato.
Checkout, gateway, recibo, impressão, ficha e travas originais são preservados.
Correção comercial invalida a fonte, com rebase explícito e novos IDs. A fonte
interna para T06 é transitória; pricing.complete sozinho não prova cadastro ou
completude ERP. T06 está descrita acima; UI e sequência externa seguem pendentes.
[Contrato e evidências](docs/runbooks/olist-phase3.md).

## OLIST-T26 — enriquecimento histórico separado da ficha

[ADR 067](docs/adr/067-fontes-comerciais-suplementares-sem-reescrever-ficha.md)
/ RFC 054: revisões suplementares cifradas e append-only preservam o envelope,
o valor e os pagamentos históricos. Comando comercial humano com versão e
ACL atual, lote por identidade e soma exata ao total, mesma transação de evento,
auditoria e idempotência. HMAC da fonte invalida composição obsoleta; rebase é
explícito. Reserva Olist em qualquer conta bloqueia mudanças. Reconfirmação
legada usa prova fresca sem mesclá-la à ficha. T24 está concluída acima; T06 está descrita acima; UI e sequência externa seguem
pendentes. [Runbook](docs/runbooks/olist-phase3.md).

## OLIST-T21 — total calculado e confirmação

T20/T21 concluídas no domínio/API: subtotais revisados determinam total/grupos,
gravação cifrada e coluna monetária na mesma escrita. Confirmação recalcula e
exige composição completa; amountText antigo só por igualdade, sem fallback.
Preço ausente/revisão deixam total null; mudança invalida quitação/check e
preserva histórico. Reabertura adotada mantém IDs; legado/loja usam os adapters T26/T24 acima.
A API expõe pricing derivado no escopo existente do Pedido. UI/Fase 4 e prévia T06
são gates de rollout: não voltar à API antiga com mutações comerciais liberadas.
[Contrato, evidências e rollback](docs/runbooks/olist-phase3.md).

## OLIST-T20 — composição e edição por identidade

Comandos por identidade completam edição de atributos, grupos e linhas,
inclusão/remoção, alteração de tamanho e reordenação. Grade e preços viajam na
mesma escrita cifrada com ACL comercial, versão e idempotência. Mudança real
exige revisão; reordenação e atualização sem mudança preservam aprovação.
Legado/loja continuam sem reescrita e a UI pertence à Fase 4. T20 concluída no
domínio/API; a confirmação T21 está descrita acima. [Contrato](docs/runbooks/olist-phase3.md).

## OLIST-T20b — composição persistida opt-in (histórico)

OLIST-09, 29, 42–44: `ficha.sizePricing` opcional guarda grupos/linhas com IDs
UUID e revisão humana no mesmo envelope AES-GCM da grade; alterações usam
`sections/size-pricing`, ACL comercial, versão, idempotência e auditoria
existentes. Reordenação move peça e grupo juntos; duplicação cria IDs novos;
quantidade invalida revisão. Limite agregado de peças é o integer PostgreSQL.
Sem migração inferida ou total histórico dividido. Após adesão, items legado,
projeção automática e confirmação livre não escrevem. Naquela entrega, T20/T21 e adapters
T24/T26 ainda estavam abertos. [Runbook](docs/runbooks/olist-phase3.md).

## Olist — fundação da Fase 2 (05/11/2026)

OLIST-F2 / OLIST-T03/T04/T19/T05 implementa dados expand, checkbox ortogonal
com revisão, projeção mínima por número/UUID, conexão OAuth e parâmetros
centrais cifrados. API/adapter usam conta esperada, quota compartilhada no
PostgreSQL, refresh reservado e fencing de disconnect/revogação. HTTP nunca
mantém transação SQL aberta. Eventos, snapshots e reservas preservam recuperação.
A geração continua desligada; não há ativação de conta real, piloto ou
handler de exportação nesta fase. [Runbook e limites](docs/runbooks/olist-phase2.md).

## Olist — escopo inicial de centavos exatos (05/11/2026)

A [ADR 062](docs/adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) /
[RFC 046](docs/rfc/046-olist-escopo-inicial-de-centavos-exatos.md), aprovada pelo PO,
restringe a exportação automática inicial a subtotal em centavos divisível pela
quantidade sem arredondamento. Frações permanecem válidas no CRM e bloqueiam
somente exportação; nenhuma inclusão parcial ou compensação entre linhas.
Identificador opaco em `infoAdicional`, produto e quantidade devem voltar
corretos; multiplicação exata do unitário retornado confere a linha, e ambos
os totais devem coincidir. F1 só fecha para esse subconjunto após prova API/UI;
os gates de conexão/ACL/runtime/piloto continuam separados. Sem nova infraestrutura.

Prova C05–C07 concluída em 05/11: [API e tela nativa consistentes](docs/integrations/olist/evidence/exact-cent-proof-result.json),
14 GETs, três pedidos/R$ 5,20. F1/T02 fechados somente para `exact-cent-v1`;
Implementação segue OLC-T01–T06 pelo recorte de 10/11 abaixo. Integração do fluxo OLC,
piloto e ativação continuam pendentes; frações bloqueadas antes do envio.

## OLIST-T23 — marcador terminal de cancelamento local

[ADR 068](docs/adr/068-cancelamento-local-terminal-pre-exportacao.md), OLIST-19,
21, 30, 45–47. A migration expand 0070 adiciona `cancelled_at`, `cancelled_by` e
`cancellation_reason_envelope` à tabela de Pedidos, sem terceiro status. O motivo
usa AES-256-GCM com AAD por Pedido. `POST /api/v1/orders/:id/cancel` exige ACL
comercial humana ativa, sessão/CSRF/Origin, Idempotency-Key, versão e motivo;
loja exige Admin. A autorização transacional antecede até a consulta ao recibo.
Pedido/evento/invalidação Olist/auditoria/recibo usam o mesmo client.

Locks seguem autoridade → conversa → Pedido → exportações. Recursos já
reservados podem concluir reconciliação; nenhuma nova etapa do cancelado é
autorizada. Reserva de venda, incerteza, ID observado ou vínculo impedem cancelar.
Trigger protege terminalidade e os campos comerciais/financeiros originais.
O índice de pendente considera apenas ativos, sem criar substituto automático.
Filtros `cancellation=active|cancelled|all` precedem contagem e paginação;
Financeiro mantém detalhe histórico no escopo anterior e nega comandos.
API de arte revalida terminalidade sob lock e impressão histórica não grava
primeira impressão. [Operação e rollback](docs/runbooks/olist-phase3.md#t23--cancelamento-local-terminal).
T10 e interface F4 seguem separados; nenhum cancelamento ERP ou estorno.

## Olist pelo pedido confirmado em 10/11/2026

[ADR 079](docs/adr/079-olist-a-partir-do-pedido-confirmado.md) e revisão 3 da
[RFC 050](docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md), OLIST-PLAN-03:
[OLC-01–16](.specs/features/olist-confirmed/spec.md) e
[OLC-T01–T06](.specs/features/olist-confirmed/tasks.md) são o contrato vigente.
O recorte substitui os trechos incompatíveis da ADR 057; o runtime já entregue
nas fases anteriores segue como insumo reaproveitável.

- Acesso: humano ativo, leitura comercial existente, checkbox default false
  gerido por Admin e piloto privado. Não criar nova entrada de perfil restrito.
- Pedido: somente `confirmado`, com comando **Gerar no Olist** no detalhe.
  Valor final = soma dos subtotais por linha de tamanho, calculada pelo
  backend (ADR 057 itens 4 e 6), mais o frete; não há total digitado. Composição ERP aditiva, para Pedido antigo ou da loja que só
  tem total, deriva identidade/grade no servidor, liga cada linha ao
  tamanho/quantidade confirmado e soma exatamente o `finalAmountCents`
  existente. Preservar total, confirmação, snapshot e PDF; nenhum rateio
  automático ou alteração de grade pelo comando de enriquecimento. Loja tem
  adapter próprio. Decisão do PO de 10/11/2026: o frete compõe o total (ADR 079,
  decisão 9; critérios OLC-05a–j), na venda ERP em `valorFrete` conferido em
  centavos exatos. É funcionalidade nova, ainda não implementada: na master o
  frete é estimativa separada do total (ADR 054; `modules/shipping`; migration 0050) e o Olist exige `valorFrete` ausente ou zero. Campo, migração,
  versionamento, recálculo e relação com a cotação são desenho de OLC-T01.
- Conexão: credenciais cifradas, renovação serializada, conta esperada e
  configuração central versionada. API oficial no monólito/worker/PostgreSQL.
- Processamento: validação interna antes de qualquer inclusão, snapshot/reserva/
  auditoria/job transacionais, unicidade conta/Pedido e recursos por identidade.
  Resolver cliente → produtos/variações → venda; persistir cada ID confirmado.
- Consistência: serializar com comandos incompatíveis, inclusive reabertura e
  correção de quantidade da loja. Conferir revisão/fingerprint do conteúdo
  comercial exportável; mudança compatível de pagamento/entrega não invalida
  envio apenas por incremento de `orders.version`. Não relaxar verificação de
  status, conta, parâmetros ou habilitação. Após sucesso, bloquear edição.
- Dinheiro/recuperação: manter ADR 062, núcleo exato e conferência de conta,
  referências, identidade de linhas/produtos e totais exatos. Incerteza bloqueia
  dependentes e exige recuperação administrativa mínima, sem POST repetido.
- UI: bloco no detalhe com pendências, botão e progresso persistido; sem
  previewId ou prévia obrigatória. Não usar PDF, pagamento ou check financeiro
  como entrada/gate. Runbook e gate operacional próprios antes de ativar.

FINQ-DEPREC-01 (remoção do código Financeiro, aprovada pelo PO em 10/11/2026;
tabelas e dados ficam), OLC-F01–F04 e FPI-T01–T04 são trilhas separadas, não
predecessoras de OLC-T01–T06. Não remover Financeiro, restringir o cancelamento
(OLC-F03: só Pedido não confirmado, supersede em parte a ADR 068), reformar
preços globalmente ou trocar template nesta integração. O Olist é refatorado
conforme os blocos 1–6 dos prompts, prevalecendo este recorte sobre o runtime
Olist da master onde divergirem. Publicação GitHub → EasyPanel permanece vigente.

### Contrato de 04/11/2026 preservado

Contrato da ADR 057 já adotado; permanece vigente, sem enfraquecimento, nos pontos
em que OLC-01–16 não o supersede expressamente. Pelas decisões do PO de
10/11/2026, o total derivado dos subtotais, agora mais o frete (ainda não
implementado), segue valendo e o texto de 04/11 sobre cancelar Pedido pago ou confirmado foi
superado: o cancelamento local vale só para Pedido não confirmado (ADR 079).

- Identidade/acesso: checkbox default false gerido por Admin, autorização
  ortogonal antes das negações por perfil e sem posse. Projeção Olist mínima
  para qualquer Pedido; revogação verificada antes de toda inclusão remota.
- Pedido: IDs estáveis de grupo/linha, subtotal em centavos, revisão após
  quantidade, soma backend, enriquecimento de legado sem alterar snapshot/total.
  Loja usa adapter/complemento próprio sem modificar pagamento/checkout.
- Integração: recursos compartilhados por conta/documento e identidade de
  produto/variação, com HMAC/envelopes, reserva/fencing e outbox transacional.
  Resolver/criar cliente, pai, tamanhos e venda; persistir cada resultado antes
  de avançar. Timeout de cadastro bloqueia dependentes, sem POST novo ou delete.
- Dinheiro ERP: representação derivada e precisão provada por linha. Comparar
  subtotais remotos/total, bloquear só exportação inexata; não atualizar catálogo
  encontrado, inventar desconto ou compensar diferenças entre tamanhos.
- Cancelamento: marcador terminal separado dos dois status, adotado na ADR 068,
  motivo/versão/auditoria e exclusão das métricas/filas ativas antes de paginar;
  preservar histórico/pagamento/check. Só pré-exportação, serializado com worker;
  restrito a Pedido não confirmado pela ADR 079 (ajuste em OLC-F03).
- UI/ficha: Aplicação por grupo e Previsão de entrega preservam chaves. Nova
  ficha v7/selector/snapshot/amostra; templates v2–v6 intactos. Sem preço novo
  na impressão. Configuração ERP central versionada, piloto por ID privado.

Contrato/precisão fiscal e detalhes DDL têm evidências em T02/T03/T23 no runbook;
flags permanecem desligadas. Sem novo serviço/store/infra; publicação GitHub → EasyPanel.

Já existem `size-pricing.js`, `olist-exact-cent.js` e F1/T02 fechado para
`exact-cent-v1`; o que falta integrar ao fluxo OLC consta nas tarefas OLC-T01–T06.
[Estado e evidências](docs/integrations/olist/implementation-progress.md).

## Cobranças InfinitePay — COB-DEL-01 (05/11/2026)

[ADR 058](docs/adr/058-cobrancas-do-pedido-com-infinitepay.md) /
[COB-01–16](.specs/features/order-billing/spec.md): a migração expand 0055
mantém plano, cobranças, recebimentos e consumo global de transação no
PostgreSQL existente. API humana usa sessão/CSRF, propriedade viva, versão
do pedido/plano e idempotência. Outbox `billing.checkout.create`, fila
`billing`, entrega ao workflow n8n dedicado. Reserva de uso único antecede
`/links`; confirmação usa `payment_check` e callback autenticado. Links
cifrados, principal separado de taxas, sinal sem `paid_on`, revisão comercial
e conciliação/devolução auditadas. Triggers protegem a verdade da quitação
inclusive contra comandos legados. Flags separam emissão e recebimento no
rollback; [runbook](docs/runbooks/order-billing.md).

## Melhor Envio — T139 (02/11/2026)

[ADR 054](docs/adr/054-cotacao-na-conversa-vinculada-ao-pedido.md), MEVQ-01–08:
`POST /api/v1/conversations/:conversationId/shipping-quotes` calcula para
`subjectId`, `orderId`, `orderVersion` e embalagem explícita;
`POST /api/v1/conversations/:conversationId/shipping-quotes/:quoteId/select`
seleciona um serviço retornado, com os mesmos alvos/versionamento.
`GET /api/v1/orders/:orderId/shipping-quote` consulta a estimativa autorizada.
A ação operacional `shipping.quote` é independente de `shipping.manage`.
O servidor confere dono, modo humano, conversa aberta, vínculo e versão antes
e depois do efeito remoto. Resultados e CEPs persistidos são cifrados com
contexto por cotação; auditoria e idempotência não guardam PII em claro.
Uma versão posterior do pedido exige nova consulta. Não há mudança de valor
comercial, status, pagamento ou envio automático. O fluxo administrativo T138
abaixo conserva seu contrato independente.

## Melhor Envio — T138 (01/11/2026)

Conforme [ADR 053](docs/adr/053-conexao-e-cotacao-administrativa-melhor-envio.md),
`modules/shipping` é composto por `shipping-runtime.js` e `shipping-routes.js`
na API. `/api/v1/shipping/melhor-envio/{status,authorize,complete,quote,disconnect}`
exige ação administrativa `shipping.manage`, sessão humana e CSRF nas escritas.
Migration expand 0049 adiciona conexão cifrada e estado OAuth de uso único
por usuário/sessão, com reserva durável e fencing para renovação. A UI Vue
`/melhor-envio` remove o callback da URL e cota uma embalagem com medidas/peso
explícitos. Nenhum dado do destinatário, frete ou preço é gravado no pedido.
Configuração/rollback e evidências no [runbook](docs/runbooks/melhor-envio.md).

## Transporte aprovado — Evolution/Baileys (29/10/2026)

A [ADR 050](docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md) autoriza
Evolution/Baileys como ponte até a API oficial: API privada, PostgreSQL exclusivo,
cache local, sem Redis. O perfil fixado em `ops/evolution/` protege logs e
webhook e expurga mensagens de transporte anteriores a sete dias. O gerador
`ops/n8n/workflows/create-evolution-workflow.mjs` preserva a jornada atual e
restaura somente a fronteira do transporte quando a fonte já usa WAHA.
Persistência antes do ACK, reservas, epoch, resultado incerto e Inbox mantêm
seus contratos. Meta e terceiros são preservados. Preparação, pareamento,
cutover e homologação são gates distintos no
[runbook](docs/runbooks/evolution-baileys.md), EVOL-01. Estado WAHA abaixo é histórico.
Em 29/10, identidade da nova conta e publicação do principal foram confirmadas;
texto de entrada, handoff e resposta humana pela Inbox chegaram ao WhatsApp Web
uma vez. Os sete workflows Meta foram preservados. Recibos `delivered`/`read`,
mídia e recuperação permanecem pendentes em EVOL-01D.

## Transporte anterior da nova linha — WAHA/WEBJS; WPPConnect pausado (histórico)

A [ADR 046](docs/adr/046-retomar-waha-para-atendimento-da-nova-linha.md)
pausa o WPPConnect preparado pela ADR 045: API privada e build verificados,
mas Chromium falhou em namespace com `EPERM`; não houve pareamento ou aplicação
de `--no-sandbox`. Fonte e volume permanecem preservados, com serviço parado.
O WAHA/WEBJS existente foi retomado com volumes novos de sessão e mídia,
separados da conta anterior bloqueada, para a nova linha da Inbox real.
O adapter de 101 nós foi regenerado do principal atual de 92 nós, preservando
jornada, site, notas, domínio, IDs, webhooks e contratos CRM. A sessão `default`
está em `WORKING` e sua identidade corresponde exatamente à configuração
privada. O principal foi despublicado, importado no mesmo ID e publicado como
“WAHA-01D · Nova linha na Inbox”, com backup protegido da versão anterior.
Fila e execuções em andamento foram conferidas antes da troca; replay permanece
desabilitado. Entrada real, transferência, takeover e resposta humana foram
observados. O adapter normaliza somente um `+` inicial do destinatário E.164
nos envios humanos de texto e mídia; a correção de dois nós foi publicada como
“WAHA-01D · Envio humano E.164”. Resultado incerto anterior foi preservado,
sem replay. Mídia e recuperação continuam sem homologação real.
Não há domínio de teste ou banco/Redis adicional.
[Estado WAHA](docs/runbooks/waha-webjs.md) e
[preparação WPPConnect](docs/runbooks/wppconnect.md).

## Exceção de transporte — WAHA/WEBJS

A [ADR 043](docs/adr/043-piloto-whatsapp-waha-webjs.md) autoriza o piloto da
linha temporária via WAHA/WEBJS. O adaptador em
`ops/n8n/workflows/create-waha-workflow.mjs` transforma uma exportação do fluxo
existente sem alterar a fonte: conserva nós de domínio, contratos CRM, site,
painel, reservas e tratamento de resultado incerto. O candidato fica inativo;
a publicação exige pareamento, identidade verificada e homologação. A API do
WAHA fica privada, autenticada por credencial própria; o webhook do n8n exige
outra credencial. [Runbook e evidências](docs/runbooks/waha-webjs.md).

## Financeiro — implementação autorizada em 22/10/2026

> **Tela retirada em 09/11/2026.** A [ADR 074](docs/adr/074-retirada-da-pagina-financeiro.md)
> retirou `/financeiro`, sua rota e o menu. Rotas `/api/v1/finance/*`, domínio,
> repositório, permissões `finance.*`, migrations e dados seguem preservados;
> o que abaixo se refere à composição da tela é histórico.

A [ADR 040](docs/adr/040-financeiro-com-fila-e-check-manual.md) e o
[RFC 028](docs/rfc/028-financeiro-com-fila-e-check-manual.md), de 21/10/2026,
definem o perfil Financeiro sem permissões herdadas de Vendedor. A
política central e as constraints de identidade permitem o novo perfil
sem abrir as ações comerciais ou alterar o handoff exclusivo de Vendedor.
Admin mantém a gestão de contas. Requisitos [FINQ-01–19](.specs/features/financeiro/spec.md);
evidências e homologação cancelada pela ADR 074 em [FINQ-T01–T07](.specs/features/financeiro/tasks.md).

O servidor filtra listagem, contagens e detalhe por confirmado, pagamento
integral registrado e não teste, abrangendo todas as origens/responsáveis.
“Pago em” (`paidOn`) representa quitação integral; revisar registros legados
antes da ativação. Conclusão e reversão financeiras são estado próprio e
auditável, sem alterar snapshot, status, preço, datas ou travas da loja. Os
comandos usam sessão/CSRF, versão, idempotência, transação e revalidação
de elegibilidade. Rotas GET /finance/orders e /finance/orders/{id}, POST
/complete e /reopen sob /api/v1 estão no [OpenAPI](docs/api/openapi.v1.yaml).
Migrations 0042/0043 acrescentam função, revisão de pagamento legado,
order_finance e order_finance_events. Cada comando bloqueia ator vigente e
pedido; idempotência, estado, eventos e auditoria compartilham a transação.

O login do Financeiro abre `/olist`, com habilitação Olist, ou `/conta`, com
navegação restrita a esses itens no shell existente (FINQ-20). Reutilizar componentes, tokens semânticos,
marca, tipografia, temas e padrões de acessibilidade de [design.md](design.md)
e ADRs 035/036. A referência da conversa não autoriza copiar seu CSS ou
redesenhar o CRM. Olist permanece manual e sem credenciais, chamadas ou jobs.
Complemento [ADR 042](docs/adr/042-perfis-e-requitacao-do-financeiro.md): seletor
de perfis em Usuários, revogação de sessões na troca, pagamento/check novos
quando a reconfirmação muda o valor e revisão explícita de datas legadas.
Versão financeira é independente da comercial; esta última só participa do
controle de concorrência. Uma trigger no preço invalida o check ativo e limpa
pagamento manual; loja preserva gateway com cobertura do total (ADR 038).

Complemento [ADR 041](docs/adr/041-consulta-administrativa-do-financeiro.md),
[RFC 029](docs/rfc/029-consulta-administrativa-do-financeiro.md) e FINQ-16:
leituras da API financeira aceitam Financeiro ou Admin ativo (`COMMERCIAL_ADMIN`),
com o mesmo universo de pedidos elegíveis. Admin mantém
login e permissões atuais, sem trocar perfil. A capacidade administrativa
não concede os comandos financeiros; a API deve negá-los. FINQ-T01/T03/T05 cobrem essa distinção. O print foi
rejeitado como referência visual: FINQ-12 exige comparar com as telas e
componentes reais do CRM, sem copiar sua aparência.

Baseline técnica atualizada em 05/10/2026 após a PR #142. Esta síntese
substitui o desenho anterior que ainda tratava Kanban, Negócio e pagamentos
como runtime do lançamento. Decisões e aprovações históricas permanecem nos
ADRs e no Git. Esta revisão não cria evidência de produção.

Tech Lead e responsável de privacidade: `silmer:romulo.sutil`, conforme
T00.6. A exceção solo é restrita ao piloto interno; não comprova infraestrutura
ou recuperação. Fontes: [RULES](RULES.md), [spec CRM](.specs/features/crm-mvp/spec.md),
[spec Pedidos](.specs/features/pedidos-mvp/spec.md) e
[topologia](EASYPANEL-TOPOLOGY.md).

## 1. Escopo e processos

O monólito modular usa JavaScript ESM, Vue 3/Vue Router/Vite no frontend,
Fastify na API e PostgreSQL para domínio e filas. Node.js `24.20.0` e npm
`11.19.0` são fixados. Outros frameworks, store global, microserviços e Redis
não fazem parte da baseline.

| Processo | Responsabilidade                                          |
| -------- | --------------------------------------------------------- |
| edge-web | SPA compilada, headers, proxy API/SSE; TLS pelo EasyPanel |
| api      | Sessão, ACL, REST, comandos, consultas e eventos          |
| worker   | Outbox CRM→n8n, jobs internos, retenção e reconciliação   |
| postgres | Dados oficiais, auditoria e jobs persistentes             |
| n8n      | WhatsApp, OpenAI, coleta guiada e handoff; banco próprio  |

O produto inclui Inbox, Clientes, Pedidos, Dashboard, Usuários e Conta, conforme ACL.
Pedido/Ficha já existem. Negócio/Kanban estão aposentados pela ADR 004;
Instagram é fase posterior. Cobrança PIX, envio automático da Ficha, arquivos
duráveis e interface do cancelamento comercial seguem como fronteiras pendentes;
o comando local pré-exportação foi entregue em OLIST-T23.

## 2. Caminho de runtime

```mermaid
flowchart LR
    client[Cliente] --> meta[WhatsApp oficial]
    meta --> n8n[n8n: canal e coleta]
    n8n --> ai[OpenAI]
    n8n -->|API autorizada| api[CRM API]
    api --> pg[PostgreSQL]
    ui[Inbox, Clientes e Pedidos] --> edge[edge-web]
    edge -->|REST e SSE| api
    worker[worker: outbox e jobs] --> pg
    worker -->|comandos humanos| n8n
    n8n -->|envio reservado| meta
```

Toda mensagem válida inicia o workflow; a UI não dispara o bot. O n8n nunca
acessa o banco do CRM. O CRM determina autorização, gates e versão atual.
Falhas n8n/Meta/IA ficam visíveis. Não há fallback silencioso Meta→CRM.

## 3. Fronteiras e dados

| Módulo ativo            | Responsabilidade                                                   |
| ----------------------- | ------------------------------------------------------------------ |
| identity-access         | Contas, função Vendedor, capacidades, sessões e revogação          |
| contacts                | Contato e identidades de canal; associação verificável             |
| inbox-channels          | Conversas, mensagens, handoffs e operação humana                   |
| n8n-integration         | Eventos canônicos, briefing, reserva e comandos                    |
| orders                  | Pedido pendente/confirmado, ficha, snapshot e impressão            |
| integration-reliability | Idempotência, fila, efeito incerto e reconciliação                 |
| audit-privacy           | Auditoria e retenção de mídia; demais controles com gates próprios |
| configuration/catalog   | Configuração e catálogo versionados existentes                     |

Tabelas centrais incluem usuários/sessões, contatos/identidades, conversas,
mensagens, handoffs e `crm.orders`, com ficha e snapshot em colunas JSONB.
Também existem `audit_events`, `n8n_events`, `n8n_commands`, idempotência e jobs.
A numeração do Pedido usa a sequência `crm.order_number_seq` (migração 0023).
Conferir a migration específica antes de alterar SQL.

Migrations até `0048_message_transcript_delivery_code.expand.sql` estão versionadas.
Isso não prova aplicação no ambiente alvo. Tabelas/módulos de Negócio,
qualificação e execução antiga permanecem por compatibilidade com migrations
publicadas; não orientam novas telas. Remoção exige contract separado,
análise dos dados e compatibilidade de rollback.

O domínio usa transações, unicidade, locking e versões otimistas. JSONB é
restrito a payloads e snapshots adequados. Ledger externo de tombstones e
reaplicação no restore têm gate T06.3/issue #3; auditoria não os substitui.

## 4. API e automação

INBOX-UX-05 / PCX-17: a Inbox abre Todas e pede
`GET /api/v1/inbox/conversations?archived=false&sort=urgency`.
A API autoriza conversation.read, ordena o universo antes de LIMIT e emite
cursor HMAC vinculado à ordenação, filtros e ator; ordenar não filtra por dono.
A posição composta do cursor permanece privada. Sem sort, as ordenações e
cursores anteriores permanecem válidos. A UI percorre nextCursor com
Ver mais conversas, invalida páginas em trânsito ao trocar filtros/atualizar,
e preserva lista, foco e rascunho após falha de página adicional.
Contrato e rollback: [inbox-prioridades](docs/runbooks/inbox-prioridades.md).

REST `/api/v1` segue o OpenAPI versionado. Os três endpoints n8n são inbound,
attachment e events. Usam Basic Auth de serviço com `AUTOMATION_EXECUTOR`,
idempotência, correlação e identificação de workflow. Credenciais n8n→CRM e
CRM→n8n são distintas, sem sessão humana nem acesso administrativo.

No contrato legado do n8n, briefing pertence à Conversa. O contrato por
Assunto da ADR 032 ainda requer adaptação do agente e do workflow. O CRM
confere epoch/revisão antes do efeito.
`message.send.requested` reserva um único envio antes da Meta.
`send_authorized: false` em replay não permite novo envio. Timeout após o
ponto de não retorno vira `message.send.unknown`, sem retry cego.
Status confirmados não regridem; entrega publica SSE na mesma transação.

Handoff é reivindicado por CAS, com um vencedor. Takeover invalida decisões
antigas. Conversa transferida não volta ao bot (ADR 015).

ADR 052 / RFC 041 (implementado, aguardando implantação):

- `automation.stall.sweep` no worker, a cada `ASSISTANT_STALL_SWEEP_INTERVAL_MS`
  (padrão 60000). Pega a conversa em modo assistente, aberta e sem handoff
  ativo cuja revisão de entrada mais recente não teve resposta efetiva:
  `inbound_revision > claimed_revision`, ou revisão consumida por resposta
  `failed`/`outcome_unknown` ou presa em `sending` há mais de
  `ASSISTANT_SENDING_GRACE_MINUTES` (2, constante no código desta versão). A
  última mensagem do cliente precisa ser mais antiga que
  `ASSISTANT_STALL_MINUTES` (padrão 5; 2..60 com clamp; valor não numérico
  impede a subida) e das últimas 24 h, por `created_at`. Sob lock e na mesma
  transação: handoff sem dono `automation_failure` com resumo fixo cifrado
  com `N8N_INTEGRATION_ENVELOPE_KEY` (o worker precisa dela), modo humano,
  `requer_atencao`, epoch novo, histórico e auditoria. O lote é resiliente
  por candidato e registra `automation_stall_sweep_completed` (`candidates`,
  `handed_off`, `failed`). É idempotente e não envia mensagem ao cliente. A
  API usa a mesma regra e a mesma env no cartão do painel inicial (antes, 10
  minutos fixos) e no `stalled_now`.
- Migração `0046_handoff_reasons_preferred_seller.expand.sql`: motivos
  `automation_failure` e `partnership`; `crm.handoffs.preferred_user_id text`
  com FK para `crm.users` (que usa id `text`). `requested_seller_id` fora dos
  Vendedores ativos é ignorado e auditado (`PREFERRED_SELLER_NOT_ACTIVE`).
  Encerrar a conversa resolve o handoff ativo com `conversation_closed` no
  histórico; sem dono, recebe quem encerrou, pelo CHECK da 0013.
- Migração `0047_automation_turns.expand.sql`: `crm.automation_turns`, uma
  linha por evento n8n aceito, só códigos, contagens e tempos, com CHECK em
  cada campo; índice parcial de auditoria `integration.n8n.stale_fence`.
- Migração `0048_message_transcript_delivery_code.expand.sql`: transcrição do
  áudio de entrada em `crm.messages` (envelope AES-256-GCM com a chave das
  mensagens, ou código de falha), `delivery_failure_code` e o evento
  `message.transcribed`.
- `GET /api/v1/inbox/assistant/performance?days=1..90` (padrão 7): agregados
  do agente, `private, no-store`, ação `assistant.performance.read`
  (`COMMERCIAL_ADMIN`); tela `/dashboard/agente`, só para administrador.
- `GET /api/v1/inbox/conversations/:id/assistant-context`: último turno e
  mensagens do bot contra o teto, `conversation.read`, `no-store`.
- Inbound: `subject_ids` em `recent_messages`, áudio transcrito como texto e
  `contact_context` só com `previous_cycles`, `previous_orders_count` (0..99,
  sem teste nem desta conversa) e `last_closed_at`. Read model da Inbox:
  `handoff.preferredSellerFirstName` na lista, `preferred_seller` ao lado de
  `handoff` no detalhe, `transcript` no áudio e código de falha do bot.
- Workflow `mvp-simple-20` só envia os campos novos quando o inbound traz
  `contact_context`; contra CRM antigo, mantém o contrato da `mvp-simple-19`.

As migrações são expand-only, compatíveis com a release atual, e vão num PR
próprio, implantado e aplicado à mão no console da API antes do PR do código:
o inbound novo lê colunas da 0048. Depois vem a publicação do workflow. Passo a passo:
[runbook da VND-L03](docs/runbooks/vendedor-l03-implantacao.md). Teste com
PostgreSQL real: `node --test --test-concurrency=1 test/vendedor-evolucao-postgres-live.test.js`.

Contrato, diagnóstico e rollout: [n8n](docs/integrations/n8n/README.md) e
[ator técnico](docs/runbooks/automation-executor.md).

ADR 028: `POST /api/v1/integrations/n8n/store-orders` recebe do workflow da
loja o pedido pago, depois do `payment_check` da InfinitePay. Mesmo contrato
das rotas n8n (Basic do `AUTOMATION_EXECUTOR`, ação `store.order.record`,
`Idempotency-Key` igual a `pedido_id`, correlação, identidade do workflow,
problem+json), corpo até 16 KB e 60 chamadas por minuto. A idempotência é pela
chave natural `pedido_id` (recibo com o hash dos dados comparados); o
comprovante que chega depois é gravado; divergência e NSU repetido são `409`.
Desligada sem `STORE_ORDERS_HMAC_KEY`; as URLs da resposta usam
`APP_BASE_URL`. Contrato do nó: [n8n](docs/integrations/n8n/README.md);
variáveis e implantação: [loja do site](docs/runbooks/loja-do-site.md).

## 5. Pedido, impressão e métricas

Pedido tem `pendente` e `confirmado` (ADR 006). A ADR 056 supersede a abertura
pelo primeiro ponto: a API bloqueia criação automática, preserva o briefing
da conversa e somente comando humano autorizado cria o pendente após intenção
de fechamento. Observações n8n durante bot/humano não enviam mensagens;
tabelas aditivas `order_assistance_*` guardam evidência cifrada e decisões.
Aceite, criação e auditoria usam a mesma transação; epoch/revisão/versões e
alvo explícito protegem concorrência. Agregados e omissões humanas alimentam
Desempenho, sem alegar recall completo (OA-01–12).
O número é reservado na criação do Pedido. O vendedor responsável completa e
confirma; a confirmação fixa pessoa, horário e snapshot. Reabertura preserva
o número e a rastreabilidade. Nome do pendente acompanha
o Contato; o confirmado preserva seu snapshot (ADR 018).

Pedido manual sem conversa (ADR 032) guarda Contato e vendedor responsável,
usa a mesma ficha, numeração, versão e autorização do Pedido de atendimento.

ADR 039 / T136: Primeiro contato do Pedido manual sem conversa é o instante
de criação. A migration `0041_manual_order_first_contact.expand.sql` preenche
somente datas nulas desses pedidos com `created_at`, preservando snapshots.
`GET /api/v1/orders/delivery-tasks` deriva `{items}` dos pedidos manuais
confirmados, não teste, sem entrega e do responsável autenticado, ordenados
por prazo e número; não depende de scheduler nem das tabelas de tarefas legadas.
`POST /api/v1/orders/:orderId/delivery-confirmation`, com `expectedVersion` e
Idempotency-Key, exige responsável ou administrador humano, grava o dia de
São Paulo e preserva pagamento/status/snapshot. A ADR 059 / ACT-04 amplia esse
comando para pedidos de atendimento confirmados e não teste com ou sem
conversa; a leitura legada `delivery-tasks` continua restrita aos manuais.
`POST /api/v1/orders/:orderId/payment-confirmation` exige versão, idempotência,
data válida até hoje em São Paulo e `receivedInFull: true`; preserva entrega e
só libera revisão legada mediante declaração explícita de quitação integral.
O PATCH de milestones aceita somente `paidOn` para manuais; pedidos por
conversa mantêm o contrato anterior.
Rollback de aplicação exige compatibilizar esse PATCH antes de voltar o
frontend; não apaga datas nem auditoria. O backfill não exige reversão.
A identidade do canal permanece ausente até correlação verificável. O fluxo
legado n8n continua restrito a um pendente por Conversa até Assuntos e alvo
explícito serem implantados em CRM e workflow.

A [ADR 059](docs/adr/059-central-de-acoes-e-performance-comercial.md),
[ACT-01–12, PERF-01–08 e CHK-01–08](.specs/features/dashboard-actions/spec.md)
e ACT-T01 acrescentam `GET /api/v1/dashboard/actions`, decisões pessoais em
`POST /api/v1/dashboard/actions/:actionId/decision` e desempenho em
`GET /api/v1/dashboard/performance?days=7|30`. A API revalida pessoa ativa,
função e capacidades na transação; decisões conferem posse, versão do alvo,
revisão da mensagem e versão própria, com recibo idempotente cifrado e auditoria.
O formulário captura versão/valor sem substituição silenciosa por SSE.
`0056_dashboard_actions` guarda decisões e captura o responsável comercial na
confirmação, separado do executor; não preenche atribuição histórica sem
prova. Loja e sem atribuição reconciliam separadamente com o total.

`0057_dashboard_checkpoints` guarda snapshot cifrado imutável do relatório e
estado mínimo por destinatário. O preview/status humano exige administrador;
os comandos `prepare`, `reserve` e `complete` sob
`/api/v1/integrations/n8n/dashboard/checkpoint/` exigem a capacidade técnica
`dashboard.checkpoint.execute`. n8n agenda às 08h em São Paulo, para o dia
civil anterior, e transporta somente após reserva exclusiva; replay nunca
relibera envio. Telefones vêm de configuração privada, não do browser nem do
Git. Resultado incerto exige reconciliação, e aceitação do provider não prova
entrega. A flag é desativada por padrão; ACT-T02 e o
[runbook](docs/runbooks/dashboard-central.md) separam configuração, publicação
e homologação real da evidência local.

O contrato `subject-v1` (CP-T04) devolve os Assuntos e seus briefings cifrados
por Assunto no inbound. Toda alteração posterior à abertura leva
`subject_id` e `order_id` no evento n8n; o CRM valida Contato, Pedido, seleção
humana, epoch, revisão e idempotência antes de projetar na ficha. O primeiro
`open_order` cria/recupera Assunto junto ao Pedido e retorna ambos os IDs;
replay não autoriza novo envio. O workflow legado mantém seu briefing na
Conversa até a troca, feita somente após instalar o CRM.

Novo cadastro manual exige nome e telefone; e-mail é opcional (ADR 033).
Novo Pedido manual exige telefone no Contato, inclusive se legado, mas a
consulta e a correção do legado permanecem disponíveis. A busca por telefone
usa números normalizados das identidades confirmadas e do cadastro manual;
duplicatas são apresentadas para escolha humana sem união automática.

Cadastro completo do cliente (ADR 047, CP-25..28): a migration
`0044_contact_registration.expand.sql` adiciona `registration_envelope`
(AES-256-GCM, AAD `crm.contacts.registration.v1`) e
`registration_fields_complete`. `PUT /api/v1/contacts/:id/registration`, com
`expectedVersion` e Idempotency-Key, substitui o cadastro, incrementa a versão
do Contato e audita sem valores pessoais; erro de campo responde
`{error: {code, field}}`. Só o detalhe devolve `registration`; lista e busca
devolvem `registrationStatus`, completo quando os campos obrigatórios, o
celular e o e-mail existem. `POST /api/v1/postal-codes/lookup` recebe o CEP no
corpo, fora de URL e logs de proxy, consulta o ViaCEP pela API (HTTPS, 3 s,
16 KB, sem redirect, 30/min) e responde 404/503 para cair no preenchimento
manual. A idempotência guarda só id, versão e estado, e respostas com cadastro
usam `no-store`. Rollback de aplicação ignora as colunas novas.

Encerrar Conversa usa comando humano com versão e chave idempotente. A
transação registra `state = encerrada`, `terminal_at`, `closed_by`, motivo
`concluido`/`sem_pedido`, auditoria e comando de fechamento ao n8n. Com Pedido
pendente criado na Conversa ou vinculado por Assunto, a API exige
reconhecimento explícito, sem alterar o Pedido. A reserva de novos pedidos na
Conversa rejeita ciclo terminal; uma
nova mensagem válida abre o próximo ciclo pela chave da identidade.

Assuntos da Conversa são gravados em `crm.conversation_subjects` (migração
0037), com Pedido opcional do Contato corrente e um alvo atual por ciclo.
`crm.message_subject_links` aceita múltiplos Assuntos por Mensagem; a
atribuição pode ser corrigida. Comandos humanos de criação, seleção e
atribuição são idempotentes, autorizados ao responsável ou administrador e
auditados. A Inbox consulta até 100 Pedidos por vez, com filtro por trecho do
número; a API confirma o vínculo Pedido/Contato. O vínculo de Assunto com
Pedido manual não altera o dono nem a ficha do Pedido.

ADR 048 / CP-29..31: quando um evento do agente com alvo explícito é aceito,
as mensagens de entrada do turno (revisão maior que `claimed_revision` lida
antes da cerca e até `source_revision`) recebem vínculo
`assigned_by_kind='agent'`, sem sobrescrever vínculo existente nem revisão
humana resolvida; o primeiro `open_order` liga o turno enquanto houver um só
Assunto. Handoff `subject-v1` de `low_confidence` sem alvo, com Assunto na
Conversa, abre linhas em `crm.message_subject_reviews` (migração 0045) para as
mensagens sem vínculo. A leitura de Assuntos devolve `assignedByKind` e
`needsSubjectMessageIds` (revisão aberta e sem vínculo); a atribuição humana
resolve a revisão, inclusive com lista vazia, sem tocar handoff, epoch ou
`automation_state`. Auditoria só com IDs e contagens
(`AGENT_SUBJECT_ASSIGNMENT`, `AGENT_SUBJECT_AMBIGUOUS`). Instalar a 0045 antes
da API; não há backfill.

ADR 020 / PR #142 define Técnica por item (`tipo_servico`) e Arte por pedido.
Gerar exige pontos obrigatórios dos itens, arte e entrega prometida. A edição
parcial é permitida. `summary.aplicacao`, `modelo` e campos antigos seguem
preservados para compatibilidade, sem criar novos critérios de geração.

ADR 025: cada item tem `publico` (masculino, feminino, infantil, unissex) e
`quantidade_informada` opcionais, que não bloqueiam gerar. A divisão dita ao
bot (`audiences`) vira um item por público quando o domínio a lê sem dúvida
(`modules/orders/src/domain/audiences.js`); "Tecido" passa a "Modelo de
malha". O bot pergunta pelo produto, com kits e pontos passivos (ADR 024).

`GET /api/v1/orders/:orderId/print` exige sessão de leitura autorizada e
Pedido confirmado. Retorna HTML imprimível da v6 (público de cada item e
"Modelo de malha"), escolhida em `modules/orders/src/print/index.js` e
aprovada provisoriamente pelo PO em 06/10/2026. PDF sintético e hashes são
artefatos de aprovação, sem prova de envio externo. V2 a v5 não são
sobrescritas. Assinatura física de Rose/Operação na v6 segue obrigatória
antes da produção.

`GET /api/v1/orders/:orderId/pdf` usa a mesma permissão e a mesma ficha,
renderizada no Chromium headless incluído na imagem do runtime (ADR 037).
Responde `application/pdf` como anexo privado sem cache; pendente responde 409.
O renderer desliga JavaScript, bloqueia requisições externas, limita duas
renderizações simultâneas e a rota limita dez requisições por minuto. O PDF
não é persistido. A Web Share API compartilha o arquivo quando disponível;
o WhatsApp é escolhido pela pessoa no aparelho. Na loja, o registro de
primeiro acesso ocorre após renderização bem-sucedida; `HEAD` não registra.

Pedido da loja (ADRs 027 e 028): `origin = loja`, sem conversa, nasce
confirmado pelo ator `system:loja-do-site` ao preço de
`modules/orders/src/domain/store-catalog.js` (R$ 180,00, prazo por cor), com
`paid_on` no dia em que a InfinitePay confirmou e as colunas do gateway
(`payment_source`, `payment_confirmed_at`, `paid_amount_cents`,
`payment_transaction_nsu` único, `payment_invoice_slug`), `store_number` e
`lead_time_business_days`; o link do comprovante fica na ficha cifrada.
Qualquer escrita humana depois é `409 ORDER_LOCKED`. Imprime `ficha-loja-v1`
na mesma rota, com `?download=1` para anexo; teste (`is_test`) fica fora das
métricas.

Dashboard/listas usam read models autorizados. Vendido/vendas contam
confirmados e não representam recebimentos. SSE usa IDs e metadados mínimos.
Reconexão recupera estado; conflito preserva rascunho até atualização.
Teclado, foco e ARIA fazem parte do aceite.

### Métricas de expediente, perda e presença — ACT-T04

Presença, heartbeat e R$ por hora (MET-09–11, migração 0063) estão em
backlog desde 05/11/2026 e não existem no código.

[ADR 061](docs/adr/061-metricas-de-expediente-perda-e-presenca.md) e
[ACT-06/MET-01–12](.specs/features/dashboard-actions/spec.md). Endpoints
novos, sem alterar `/dashboard/performance` nem o checkpoint (PERF-08):

| Contrato                                            | Uso                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/v1/dashboard/metrics/service?days=7\|30`  | Tempo para assumir e 1ª resposta (mediana, p90, amostras, abertos) e “sem resposta”.          |
| `GET /api/v1/dashboard/metrics/losses?days=7\|30`   | Perdas declaradas por motivo, sem texto livre; correções manuais fora da contagem.            |
| `GET /api/v1/dashboard/metrics/presence?days=7\|30` | Minutos online, cobertura e R$ por hora online; indisponível com a flag desligada.            |
| `GET`/`POST /api/v1/conversations/:id/lead-outcome` | Ler/declarar perda ou corrigir; Idempotency-Key, CSRF, versão esperada; `409 LEAD_HAS_ORDER`. |
| `POST /api/v1/presence/heartbeat`                   | Sem corpo; no máximo uma linha por usuário/minuto pelo relógio do servidor.                   |

Migrações expand: `0061` cria `crm.business_minutes_v1(from, to)`
(`expediente-v1`: seg–sex, 09–12h e 13–18h, America/Sao_Paulo) e índices
das consultas; `0062` cria `crm.lead_outcome_events`, imutável, versionada
por conversa, com texto de `outro` cifrado; `0063` cria
`crm.user_presence_minutes` sem IP, user-agent ou rota, com expurgo após 90
dias. `DASHBOARD_PRESENCE_ENABLED` é desligada por padrão. Autorização como
PERF-07 (admin vê equipe, vendedor só a própria linha, Financeiro sem acesso).
A sugestão de retomada (`DASHBOARD_FOLLOWUP_HOURS`) passa a 72h.

## 6. OpenAI, acesso e privacidade

OpenAI é o provedor do MVP ([ADR 021](docs/adr/021-adotar-openai-no-mvp.md)).
O workflow usa `gpt-5.6-luna` via Responses API, parser estruturado e
validação CRM. Um segundo provedor é evolução, sem fallback automático.
Spikes Gemini são históricos; seus testes não aprovam OpenAI.

Modelo implantado, billing, chave, request real, persistência/cache, DPA,
retenção, região e ZDR precisam de evidências do projeto efetivo.
`store: false` não comprova ZDR. Produção com PII segue condicionada à
política aprovada. A fonte do nó não explicita esse parâmetro; não presumir
seu valor no request. [Checklist OpenAI](docs/integrations/openai/README.md).

Função humana: Vendedor, capacidades ortogonais e deny-by-default.
MFA saiu do CRM pela migration 0012; proteção do EasyPanel é distinta.
Cookie seguro, CSRF, revogação e ACL no servidor continuam obrigatórios.
Auditoria de negócio difere de log técnico. Logs não contêm mensagem,
prompt, resposta completa, comprovante ou segredo. Retenção/acesso/exclusão
seguem P0.6. Aprovar threat model não comprova implantação dos controles.

## 7. Mídia e documentos duráveis

Mídia de canal é privada e temporária. Bytes expiram no fim da jornada ou
em sete dias. Quarentena, limites, MIME/hash e scan precedem acesso.
Worker trata retenção; detalhes em [TRANSIENT-MEDIA](docs/phase0/TRANSIENT-MEDIA.md).

A nova classe de mídia enviada no chat usa RustFS existente, sem exclusão
automática por sete dias ou encerramento (ADR 023). A implementação mantém registro
persistente separado do contrato transitório, leitura privada por conversa,
processamento no worker, normalização OGG/Opus e reserva n8n por referência
imutável. Rascunhos órfãos usam intenção durável e guardas de writer antes de
DELETE/quota. API admite no máximo dois pipelines por bucket; decoder é serial
no worker. Homologação construída e migração de cópias legadas disponíveis estão pendentes
no [plano INBOX-MEDIA-1](.specs/features/inbox-media-rustfs/design.md). O storage
R2 futuro não é dependência dessa entrega; backup externo/restore têm gate próprio.

O pipeline falha fechado: scan e definições vigentes precedem `ready` e
envio. O worker supervisiona um `clamd` persistente, com socket Unix privado
e health por PING. `clamdscan --fdpass` conserva limites e rejeição de malware.
Freshclam reinicia o motor sem carregamento concorrente; o marcador só muda
após readiness. Cada scan conserva a freshness anterior à execução
([ADR 030](docs/adr/030-antivirus-persistente-no-worker.md)).
Recuperar validação temporariamente indisponível reutiliza a mesma
mídia, sem upload ou envio automático. Testes sintéticos DEV não substituem
captura com microfone físico (T24) nem homologação WhatsApp. Persistência de
dados de execução n8n continua condicionada à minimização e ao expurgo
registrados no gate de privacidade da feature.

Perda da única cópia resulta em `lost/unavailable`. Arquivos válidos são
anexados ao pedido. Os arquivos da arte (5 de até 10 MB e a arte final) ficam
no RustFS interno, só pela API, com catálogo cifrado, assinatura do conteúdo,
auditoria e idempotência ([ADR 023](docs/adr/023-arquivos-da-arte-no-rustfs.md)).
O RustFS divide a VPS com o PostgreSQL; o risco é aceito com o bucket no
backup off-host e no drill. S3/R2 externo segue diferido na issue #29; isso
não dispensa backup de bancos/documentos duráveis. Pedidos/Fichas e auditoria
não herdam a retenção curta de mídia.

## 8. Deploy, recuperação e observabilidade

OPSH-01–05 / OPS-HEALTH-T01: heartbeat e progresso por fila no PostgreSQL;
amostragem a cada 60s, snapshot com validade120s. GET /api/health/operations
lê somente memória e responde200/503 com status técnicos. Não usar para restart.
Consultas indexadas, lock_timeout100ms, statement_timeout1s e execução única.
Nenhuma coleta automática de incidentes. Ver ADR060 e runbook de Saúde e erros.

A central **Saúde e erros** (ADR 055, OPS-ERR-T01) usa o shell Vue e o
PostgreSQL existentes. A API exige a conta humana operadora designada,
ativa e com `COMMERCIAL_ADMIN`, inclusive na consulta e no replay de uma
triagem. Captura 5xx e ingestão idempotente dos estados de falha de
jobs/comandos n8n produzem grupos por origem e código controlado, sem
payload ou erro livre. A triagem usa versão, CSRF, idempotência e auditoria;
recorrências reabrem grupos resolvidos. Retenção técnica de 14 dias (ADR 060), com limpeza diária fora da consulta e
rollback expand-only no [runbook](docs/runbooks/saude-erros.md).

Manter deploy automático GitHub→EasyPanel
([ADR 022](docs/adr/022-manter-deploy-automatico-github-easypanel.md)).
Auditar origem/ref, gatilho, SHA implantado, build/imagem, saúde e rollback.
CI publica GHCR por SHA/digest com scan, SBOM e provenance; isso não comprova
consumo da imagem nem vínculo do deploy externo com CI. Se o deploy antecede
os gates, registrar e corrigir no fluxo escolhido antes do go-live.

Migrations seguem expand/contract e precedem workflows dependentes de campos
novos. Rollback recupera release anterior compatível, pausa automação e
preserva efeitos incertos. Restore de banco é último recurso, com ledger
de exclusões reaplicado antes de readiness.

Backup externo de CRM e n8n, chave de credenciais recuperável e escrow são
obrigatórios. Drills isolados demonstram RPO ≤ 60 minutos e RTO ≤ 240 minutos
do conjunto. Mocks não comprovam esses objetivos.
[Runbook recovery](ops/recovery/RUNBOOK.md), issue #3 e topologia detalham gates.

Monitor off-host, alertas API/worker/jobs/n8n/backup, roteamento e drills
permanecem issue #11. Hardening deve ser comprovado no container implantado.
Health público não substitui monitor off-host.
[Relatório atual](docs/runbooks/production-readiness-checks.md).

## 9. Verificação e rastreabilidade

Gates oficiais: `npm ci`, `npm run validate`, `npm run test:e2e` e
`npm audit --audit-level=high`. CI acrescenta PostgreSQL real serializado,
scan obrigatório e artefatos de release. Migrations, ACL, disputa/replay,
PII, timeout e efeitos incertos têm cenários negativos pertinentes.

Carga T07.1 usa envelope aprovado na issue #8, sem presumir SLOs medidos.
UAT valida atendimento, Pedido/Ficha, acessibilidade e falhas. Liberar
tráfego exige evidências de WhatsApp, privacidade, assinatura física,
backup, alertas e recuperação.

Tarefas: [CRM](.specs/features/crm-mvp/tasks.md) e
[Pedidos](.specs/features/pedidos-mvp/tasks.md). Entrega de 05/10:
OPS-DOC-01, OPS-CI-01, OPS-CHK-01 e OPS-AI-01. Relatórios distinguem checks
concluídos de lacunas externas; documentação não autoriza go-live.

## Correção administrativa de quantidade da loja (ADR 038)

`POST /api/v1/orders/:orderId/store-correction` usa a sessão humana de
`order.edit` e exige adicionalmente `COMMERCIAL_ADMIN`. O comando contém
versão, quantidade e valor anteriores esperados, nova quantidade e motivo
técnico fechado. Não aceita cliente, produto ou dados de pagamento.

O serviço limita a produtos unitários de catálogo com um item e uma grade;
recalcula o subtotal e exige Pix InfinitePay inteiro suficiente. O repositório
revalida administrador ativo sob lock, bloqueia pedido/recibo, compara a
versão e grava envelope, peças, subtotal, evento e auditoria juntos. Um
marcador técnico derivado do comando reconhece repetição após commit com
resposta perdida. O executor mantém a proteção de mesma chave/outro corpo.
O fingerprint original não muda, e o replay n8n lê o pedido já corrigido.
Confirmação, pagamento, primeira impressão e número ficam preservados.
Contrato detalhado no OpenAPI e operação no runbook da loja; LOJ-39–LOJ-41,
T135 e [RFC 026](docs/rfc/026-correcao-administrativa-quantidade-loja.md).

## CHAN-WA-01 — Fronteira de atendimento

Conforme ADR 044, o CTA público leva ao WhatsApp sem formulário. O trigger
antigo do chat encadeia somente resposta fixa, sem CRM/IA/upload. Os nós
legados ficam sem entrada pública para compatibilidade histórica. Preservar
o guard publicado, IDs de webhook e credenciais ao implantar. Pedido de
mochila/bolsa ou dois pedidos explicitamente separados transfere sem patch.
