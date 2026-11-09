# Arquitetura — baseline do CRM Silmer

## Recência em Responder (08/11/2026)

[ADR 066](docs/adr/066-responder-por-mensagem-mais-recente.md) /
[RFC 053](docs/rfc/053-responder-por-mensagem-mais-recente.md), PCX-19e e
INBOX-VEZ-08: Responder ordena pela última mensagem decrescente, sem fixar
falhas. SQL e cursor compartilham precisão em milissegundos; o fingerprint
recusa cursores antigos. O relógio de espera, classificação e demais abas
mantêm seus contratos. Sem migration ou infraestrutura nova.

## Triagem prioritária do Vendedor (06/11/2026)

A [ADR 063](docs/adr/063-triagem-prioritaria-do-vendedor.md), autorizada pelo
proprietário na RFC 051, encaminha dúvidas de mínimo/viabilidade e alternativas
de quantidade ao humano, sem inferir catálogo ou condições de um atendimento.
Prazo desejado inequívoco hoje/amanhã transfere antes da ficha completa;
campos já respondidos não são perguntados novamente. `mvp-simple-23`, tarefa
VND-L05/AGT-01–05/08, sem novo contrato ou infraestrutura. Publicação como
delta sobre Evolution e rollback no [runbook](docs/runbooks/vendedor-prioridades.md).

## Olist T13 — progresso, recuperação e cancelamento local (08/11/2026)

A T13 completa a interface da Fase 4 sobre os contratos já existentes, sem
mudança de backend: linha do tempo de etapas (cliente, produto/variações, venda)
lida da projeção do CRM, com releitura limitada e sem polling do ERP; histórico,
conferência (reconciliação só leitura) e vínculo de venda existente apenas para
`COMMERCIAL_ADMIN`; e a ação **Cancelar pedido** local e terminal, bloqueada
por qualquer trava Olist. Incerteza nunca oferece repetição criadora. Geração
real segue desligada. [Contrato, gates e limites](docs/runbooks/olist-phase4.md#t13--progresso-recuperação-e-cancelamento-local-08112026).

## Olist T12 — interface de composição e prévia (08/11/2026)

A T12 aplica os contratos existentes das ADRs 057/062/067/068 à interface:
composição por IDs, subtotais e total backend, revisão após alterações e
complementos autorizados de legado/loja. `/olist?pedido=<UUID>` permite
projeção/prévia ao habilitado sem abrir edição comercial ou Inbox. Metadados
booleanos de trava na leitura comercial consideram todas as contas e não
concedem capacidade Olist; pagamento e entrega conservam autorização própria.

Após autorização explícita do proprietário em 08/11/2026, a T12 conecta a
confirmação humana a `/export`: projeção e prévia liberadas, conferência fresca
com liberação e diálogo explícito. O corpo é somente `previewToken`, com chave
idempotente. Mudança/expiração/revogação invalida a revisão; envio incerto impede
retry cego e remete à conferência administrativa. T12 concluída localmente;
T13 e os gates posteriores continuam separados. Geração real permanece
desligada; flags/defaults/runtime reais não foram alterados. [Contrato, verificação e rollback](docs/runbooks/olist-phase4.md#t12--composição-e-conferência-por-pedido-08112026).
Sem mudança de flags, migrações, credenciais, infraestrutura ou deploy.

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
T11 iniciou F4; T12 foi concluída na continuação acima. T25 trouxe os rótulos
Previsão de entrega/Aplicação e a `ficha-canonical-v7`, preparada e não
selecionada (`PRINT_TEMPLATE` segue na v6). T13 foi concluída (seção acima); os gates operacionais F5/F6
continuam pendentes.

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

## OLIST-T23 — cancelamento local terminal (06/11/2026)

A [ADR 068](docs/adr/068-cancelamento-local-terminal-pre-exportacao.md) concretiza
OLIST-19, 21, 30, 45–47: marcador separado dos dois status, motivo cifrado e ACL
comercial atual, com loja restrita a Admin. Versão, evento, auditoria, invalidação
das exportações canceláveis e recibo compartilham a mesma transação.
O lock de Pedido serializa cancelamento com reservas de venda e vínculo; efeito
reservado/incerto/exportado/vinculado ou ID observado impede o cancelamento.
Histórico, pagamento, checkout e Nota criada permanecem, enquanto os universos
ativos excluem cancelados antes de contar/paginar. Sem chamada de cancelamento
ERP, estorno ou substituição automática. Migration expand 0070, guardas de
terminalidade e [runbook](docs/runbooks/olist-phase3.md#t23--cancelamento-local-terminal).
Próximo T10; F3 aberto, sem despacho real, deploy ou piloto.

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

## Olist — início da Fase 3 (histórico T20b)

OLIST-T20b persiste composição opcional no envelope da ficha, sem migration
ou reescrita de legado. Comandos humanos por ID geram/preservam identidades,
revisam subtotal, alteram quantidade, reordenam grupos e duplicam com revisão
invalidada. ACL comercial, versão e idempotência existentes protegem a escrita.
Cliente antigo/projeção automática não podem substituir composição adotada.
Naquela entrega, confirmação calculada, adapters loja/legado e UI
ainda estavam pendentes; T20/T21/F3 não estavam concluídos. [Contrato/limites e rollback](docs/runbooks/olist-phase3.md).

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
T03 pode iniciar. Runtime integrado, ACL, banco, UI e piloto seguem nas tarefas
posteriores; frações continuam bloqueadas antes do envio.

## Olist por habilitação e subtotal por tamanho em 04/11/2026

[ADR 057](docs/adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md) / [RFC 050](docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md), OLIST-PLAN-02. Desenho
aprovado para implementar, sem runtime ou ativação entregues nesta revisão.

API oficial no monólito/worker/PostgreSQL existentes. Checkbox ortogonal ao
perfil/posse autoriza projeção e geração Olist de qualquer Pedido completo,
sem conferir Inbox/edição geral. Parâmetros por conta centralizados; piloto
individual por ID privado. Cada cliente/produto/variação/venda tem reserva e
reconciliação próprias, compartilhadas por identidade entre Pedidos.

Grupo/item CRM tem linhas de tamanho com IDs estáveis e subtotais; backend
calcula total e adapter deriva unitário ERP sem alterar subtotal. Compatibilidade
de legado/loja é explícita. Cancelamento local terminal pré-exportação filtra
universos ativos preservando história; exportado não reabre para editar nem
cancela ERP. Rótulos Aplicação/Previsão de entrega exigem ficha v7, sem mudar
v2–v6. N8n e Financeiro mantêm fronteiras próprias, com emendas da nova capacidade.

Preparação local em 05/11 (T20a/T21a): o domínio Orders contém o núcleo de
IDs e subtotais por tamanho, cálculo exato e revisão após quantidade.
[Implementação e limites](docs/integrations/olist/implementation-progress.md).
Ainda sem persistência/API/UI e sem geração ERP; o gate monetário F1 permanece.

## Cobranças do pedido — InfinitePay (05/11/2026)

A [ADR 058](docs/adr/058-cobrancas-do-pedido-com-infinitepay.md), após aprovação
do protótipo da RFC 049, acrescenta plano, cobranças e recebimentos ao
PostgreSQL existente. Responsável/admin emite pelo pedido confirmado;
worker/n8n dedicados usam reserva de efeito antes da InfinitePay e callback
autenticado após verificação no provedor. Sinal, saldo, taxas e quitação são
distintos; transação não pode ser consumida também pela loja. Reabertura,
resultado incerto e devolução têm conciliação explícita. Não altera os dois
status comerciais, checkout da loja ou bot. Contrato
[COB-01–16](.specs/features/order-billing/spec.md), entrega COB-DEL-01 e
[operação/rollback](docs/runbooks/order-billing.md).

## Abertura assistida de pedidos (03/11/2026)

A [ADR 056](docs/adr/056-abertura-de-pedido-com-confirmacao-humana.md)
supersede a abertura pelo primeiro dado da ADR 014. O agente coleta na
conversa; quando o cliente confirma fechamento, sugere internamente ao
vendedor criar o pendente. A decisão humana é autorizada, versionada,
idempotente e transacional. Observações no n8n também acompanham atendimento
humano sem mensagens externas ou retorno ao bot. Sugestões, motivos, omissões
anotadas e métricas ficam no PostgreSQL existente (OA-01–12 / OA-T01).

## Saúde e erros — acesso operacional restrito (02/11/2026)

A [ADR 055](docs/adr/055-central-de-erros-restrita-a-conta-operadora.md)
autoriza o menu Saúde e erros somente para a conta operadora designada e
ativa, com capacidade administrativa, validada na API e no shell Vue.
Ocorrências técnicas agrupadas e triagem versionada/auditada ficam no
PostgreSQL existente. O recorte inicial cobre 5xx da API e falhas persistidas
de jobs e comandos n8n, sem payloads ou reenvios. Contrato OPS-ERR-01–08,
tarefa OPS-ERR-T01 e [runbook](docs/runbooks/saude-erros.md). Monitor externo
e notificações da issue #11 continuam com seus gates independentes.

## Melhor Envio — cotação na conversa e no pedido (02/11/2026)

A [ADR 054](docs/adr/054-cotacao-na-conversa-vinculada-ao-pedido.md)
complementa a ADR 053: T139 permite ao responsável humano ou administrador
cotar na conversa para Assunto/Pedido explícitos e guardar o serviço escolhido
como estimativa cifrada. A ação `shipping.quote` não concede administração da
conta. Entradas físicas são explícitas; mudanças do pedido invalidam a
estimativa por versão. A resposta é sugerida no composer, com envio humano.
O Valor final e a ficha permanecem sob seus comandos comerciais existentes.
Contrato MEVQ-01–08 e rollout no runbook do Melhor Envio.

## Melhor Envio — conexão e cotação administrativa (01/11/2026)

A [ADR 053](docs/adr/053-conexao-e-cotacao-administrativa-melhor-envio.md)
liga T137 à API e ao menu Melhor Envio, exclusivos de administrador. OAuth
mínimo permite cálculo e transportadoras. Tokens cifrados ficam no PostgreSQL,
com renovação reservada e estado de uso único por sessão. Cotação manual não
muda pedido nem compra etiqueta. Decisões comerciais/fiscais e Expedição da
RFC 038 permanecem abertas. [Contrato](.specs/features/melhor-envio/spec.md)
e [ativação](docs/runbooks/melhor-envio.md), tarefa T138.

## Ponte aprovada — Evolution/Baileys (29/10/2026)

A [ADR 050](docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md) substitui
a escolha WAHA abaixo por Evolution/Baileys enquanto a API oficial está em
aprovação. Gateway e PostgreSQL exclusivos ficam no EasyPanel, privados e sem
Redis. n8n, jornada, reservas e Inbox continuam nas fronteiras atuais.
O fluxo Meta e terceiros são preservados; limpeza exige backup e análise de
referências. Em 29/10, a nova conta foi pareada, sua identidade confirmada e o
principal publicado: entrada na Inbox, handoff e resposta humana recebida no
WhatsApp Web foram observados uma vez. Os sete fluxos Meta ficaram intactos.
Mídia, recibos e recuperação seguem como gates no
[runbook Evolution](docs/runbooks/evolution-baileys.md), tarefa EVOL-01D.
As seções WAHA/WPPConnect abaixo registram a situação anterior.

## Transporte anterior da nova linha — WAHA/WEBJS (histórico)

A [ADR 046](docs/adr/046-retomar-waha-para-atendimento-da-nova-linha.md)
pausa a preparação WPPConnect da ADR 045 após falha de namespace do Chromium,
sem pareamento e sem aplicação de `--no-sandbox`. O serviço WPPConnect está
parado. WAHA/WEBJS foi retomado com volumes novos para a nova linha destinada
ao atendimento real da Inbox; a conta anterior bloqueada permanece sem uso e
seus volumes foram preservados. A sessão `default` está em `WORKING`, com
identidade exatamente igual à configuração privada esperada. O transporte foi
publicado no mesmo workflow principal, agora com 101 nós, preservando IDs,
webhooks e notas da fonte de 92 nós e seu backup protegido. Mensagem nova,
persistência na Inbox, transferência, takeover e resposta humana entregue
uma vez foram observados. WAHA-01D segue aberta para os gates restantes de
mídia, falhas, reentrega e recuperação.
Não há Inbox paralela, Redis ou banco adicional.
[Estado WAHA e gates históricos](docs/runbooks/waha-webjs.md);
[preparação WPPConnect preservada](docs/runbooks/wppconnect.md).

## Piloto autorizado — WAHA com WEBJS

A [ADR 043](docs/adr/043-piloto-whatsapp-waha-webjs.md), vinculada à
[RFC 031](docs/rfc/031-piloto-whatsapp-waha-webjs.md), autoriza em 27/10/2026 o
transporte da linha temporária por WhatsApp → WAHA → n8n → API CRM → Inbox.
O retorno conserva a reserva de efeito único antes do WAHA. O serviço dedicado
não acessa o banco do CRM, não adiciona Redis e não substitui regras de IA,
pedido, site ou handoff. A versão original e seu backup permanecem preservados;
o [runbook](docs/runbooks/waha-webjs.md) distingue instalação, pareamento e
homologação. Esta exceção prevalece sobre referências à API oficial abaixo
somente no piloto autorizado.

## Financeiro — implementação de 22/10/2026

Em 21/10/2026 o PO aprovou [ADR 040](docs/adr/040-financeiro-com-fila-e-check-manual.md)
e [RFC 028](docs/rfc/028-financeiro-com-fila-e-check-manual.md): perfil Financeiro
com autorização própria, consulta mínima aos pedidos confirmados, integralmente
pagos e não teste de todos os vendedores/origens e conclusão manual “Nota criada”.
Conclusão/reversão ficam separadas do estado comercial, com auditoria; Pedido
mantém dois status e a loja permanece travada. O perfil não herda Vendedor,
não recebe handoffs e não acessa atendimento ou administração comercial.

Fila e detalhe é composta no shell Vue e no design vigente, sem redesign,
novas dependências ou infraestrutura. Integração Olist fica diferida.
[FINQ-01–19](.specs/features/financeiro/spec.md) definem o aceite;
[FINQ-T01–T06](.specs/features/financeiro/tasks.md) distinguem implementação e
homologação/ativação real, que permanece pendente.

A [ADR 041](docs/adr/041-consulta-administrativa-do-financeiro.md) complementa
o planejamento com FINQ-16: Admin ativo consulta o mesmo painel/universo,
mantendo menu completo e login atual, sem comandos financeiros por essa
capacidade. FINQ-12 descarta o print como referência visual e exige os
componentes e padrões reais do CRM.

[ADR 042](docs/adr/042-perfis-e-requitacao-do-financeiro.md) registra a seleção
de perfis em Usuários e a nova quitação/check quando a reconfirmação muda o
valor. As tabelas order_finance/order_finance_events mantêm estado e histórico
próprios; comandos usam o mesmo cliente transacional para idempotência,
auditoria e atualização. A migration marca pagamentos manuais legados para
revisão explícita. Operação e rollback no [runbook](docs/runbooks/financeiro.md).

Reconciliada com a master em 10/10/2026; ficha v6, arte no RustFS, loja paga, chat do site e mídia do vendedor. Detalhes em
[TECHNICAL-DESIGN.md](TECHNICAL-DESIGN.md) e
[EASYPANEL-TOPOLOGY.md](EASYPANEL-TOPOLOGY.md).

## Produto e autoridade

O CRM é um monólito modular. PostgreSQL guarda Contato, Conversa, Mensagem,
Handoff, Pedido, auditoria e jobs. A interface Vue 3 oferece Dashboard,
Caixa de Entrada, Clientes, Pedidos, Financeiro, Usuários e Conta, conforme ACL. Negócio/Kanban
foram aposentados pela [ADR 004](docs/adr/004-aposentar-kanban-e-negocio.md).

Novo Contato manual e novo Pedido manual exigem telefone. Nome identifica a
pessoa na interface, e-mail é opcional e Contatos anteriores sem telefone
continuam disponíveis para correção. A busca considera números associados a
identidades de canal; duplicatas exigem escolha humana
([ADR 033](docs/adr/033-telefone-no-cadastro-e-roteamento.md)).

O n8n recebe/envia WhatsApp e o chat do site, chama OpenAI (texto, imagem e
transcrição de áudio) e orquestra a coleta
([ADR 026](docs/adr/026-midia-e-chat-do-site-no-bot.md)). Nunca acessa
o banco do CRM. Toda mutação oficial passa pela API autenticada,
autorizada, idempotente e auditada. A mensagem inicia a automação; a UI
observa ou assume o atendimento. Instagram é CANAL-2, posterior ao piloto.

## Contratos ativos

- Integração n8n MVP: três endpoints de inbound, attachment e events,
  Basic Auth com `AUTOMATION_EXECUTOR`, briefing legado na Conversa e outbox
  CRM→n8n ([ADR 003](docs/adr/003-adotar-integracao-n8n-mvp-simples.md)).
  O contrato `subject-v1` optativo isola briefing por Assunto e exige IDs de
  Assunto e Pedido nas alterações posteriores à abertura. O CRM deve ser
  implantado antes do workflow que usa esse contrato (CP-T04).
- `message.send.requested` reserva um único efeito antes da Meta, usando
  `automation_epoch` e `source_revision`. Replay não autoriza novo envio;
  resultado incerto exige reconciliação, sem retry cego.
- Handoff começa sem responsável. Claim por CAS tem um vencedor. Takeover,
  handoff, fechamento e desligamento invalidam decisões obsoletas por epoch.
- A função humana vigente é `Vendedor`; capacidades adicionais são
  ortogonais. Sessão opaca, cookie seguro e CSRF protegem as mutações.
  A migration `0012_remove_mfa.contract.sql` retirou MFA do CRM;
  proteção do painel de infraestrutura é um controle distinto.
- Conversa transferida não retorna ao bot
  ([ADR 015](docs/adr/015-conversa-nao-volta-para-o-bot.md)).
- Loja do site: o workflow n8n do checkout da InfinitePay registra o pedido
  pago em `POST /api/v1/integrations/n8n/store-orders`, com o contrato das
  rotas n8n e a ação `store.order.record`, idempotente pelo `pedido_id` e
  auditada ([ADR 028](docs/adr/028-pedido-pago-da-loja-pelo-n8n.md)). Não
  há escrita pública sem autenticação.

## Pedido e ficha

Pedido tem `pendente` e `confirmado`, confirmação/reabertura humanas e
numeração global `NN-CRM`. Abre por ação humana após confirmação de fechamento
do cliente (ADR 056); até lá, o agente preenche o briefing da conversa.
Um pendente acompanha o Contato; a confirmação congela o snapshot.

A [ADR 032](docs/adr/032-separar-pedido-conversa-e-assunto.md) separa o
Contato da Conversa para que o vendedor crie Pedido manual em Pedidos, sem
simular WhatsApp. O contrato legado do agente conserva um pendente por
Conversa; vários assuntos e pendentes na mesma Conversa exigem alvo explícito
e implantação posterior do contrato por Assunto.

No Pedido manual sem conversa, Primeiro contato recebe o instante de criação;
legados sem a data recebem `created_at`. Só pagamento é digitável nesse
contrato (ADR 039). A [ADR 059](docs/adr/059-central-de-acoes-e-performance-comercial.md)
evolui o Dashboard para uma fila pessoal de conversas e pedidos, com detalhe
por seleção, sem reutilizar tarefas de Negócio. A confirmação de entrega passa
a alcançar pedidos de atendimento confirmados, não teste, com ou sem conversa,
do responsável ou administrador; grava o dia de São Paulo sem alterar a
quitação, o status ou o snapshot. A confirmação de pagamento exige declaração
explícita de recebimento integral e preserva a entrega.

[ACT-01–12, PERF-01–08 e CHK-01–08](.specs/features/dashboard-actions/spec.md)
(ACT-T01) definem lembretes pessoais com versão/revisão, sugestão de retomada
após 72h de saída humana enviada (ADR 061) e navegação para a Inbox real.
Não há envio pelo Dashboard ou retorno ao bot. Atribuição comercial é congelada para o
responsável na confirmação, separada do executor; legado sem evidência fica
sem atribuição. A mesma consulta apura desempenho e checkpoint diário das 08h,
referente ao dia anterior em São Paulo. n8n agenda e transporta com capacidade
técnica dedicada, snapshot cifrado imutável e reserva única por destino privado.
Replay ou resultado incerto não autorizam novo envio. A flag fica desativada
até configuração e homologação operacional (ACT-T02).

A [ADR 061](docs/adr/061-metricas-de-expediente-perda-e-presenca.md)
(MET-01–12, ACT-T04) mede atendimento em minutos de expediente pela função
SQL versionada `crm.business_minutes_v1`: tempo para assumir, 1ª resposta e
“sem resposta” acima de 15 minutos úteis. Lead perdido é declaração humana
com motivo, em `crm.lead_outcome_events`, sem encerrar a conversa nem mudar
pedido. Presença (`crm.user_presence_minutes`, flag desligada, 90 dias), em backlog desde 05/11/2026,
alimenta o R$ por hora online; vendedor vê só a própria linha.

O responsável ou administrador encerra explicitamente um ciclo de Conversa
como `concluido` ou `sem_pedido`; a hora e o autor ficam registrados. Pedido
pendente exige confirmação consciente e permanece pendente. Arquivar continua
independente. A próxima mensagem válida da identidade abre outro ciclo.

Dentro do ciclo, Assuntos distinguem pedidos do mesmo Contato e temas sem
pedido. Um pedido pode reaparecer em outro ciclo; uma mensagem pode apontar
para vários Assuntos. A Inbox deixa o vendedor criar, selecionar e corrigir
esses vínculos com auditoria. O alvo atual é explícito; o workflow antigo do
agente ainda não usa esses IDs e conserva sua restrição de um pendente por
Conversa até a atualização do workflow. O contrato novo valida o alvo antes
de projetar na ficha e pergunta ou transfere quando a mensagem é ambígua.

O template selecionado é `ficha-canonical-v6` (ADR 025).
Técnica pertence ao item e origem da arte ao pedido. Impressão exige Pedido
confirmado e autorização de leitura. A API devolve HTML imprimível; o PDF
sintético de aprovação é um artefato de revisão. Assinatura física de Rose
e Operação continua pendente para produção. Versões v2 a v5 são preservadas.

A [ADR 037](docs/adr/037-gerar-pdf-da-ficha-para-uso-mobile.md) acrescenta
`GET /api/v1/orders/:orderId/pdf` para baixar a ficha real em PDF e
compartilhá-la pelo recurso nativo do celular. O PDF usa o mesmo HTML aprovado;
a rota HTML segue disponível. Não há envio automático pelo WhatsApp.

Arquivos da arte (até 5 de 10 MB e a arte final) são enviados e baixados
pela página do pedido e ficam no RustFS interno, só pela API
([ADR 023](docs/adr/023-arquivos-da-arte-no-rustfs.md)). Aviso a Rose e
automação PIX não são assumidos como entregues pelo ciclo atual de Pedido. Vendido conta
somente confirmados; não equivale a recebimentos.

O pedido da loja do site (`origin = loja`) nasce confirmado, sem conversa nem
Contato, ao preço do catálogo do CRM, com o Pix confirmado pela InfinitePay
(valor pago, NSU, comprovante), o número `LJ-…` e o prazo da cor; é travado,
conta como venda normal (teste não conta) e imprime a ficha simplificada
`ficha-loja-v1` ([ADRs 027](docs/adr/027-venda-da-loja-do-site.md) e
[028](docs/adr/028-pedido-pago-da-loja-pelo-n8n.md)). Até a primeira
impressão da ficha, que registra quem e quando, ele é um "pedido novo do
site" no aviso do Dashboard e no menu; o status continua Confirmado
([ADR 031](docs/adr/031-aviso-de-pedido-novo-do-site.md)).

## Baseline técnica

A [ADR 038](docs/adr/038-correcao-administrativa-quantidade-loja.md) acrescenta
uma correção administrativa de quantidade de produto unitário da loja,
somente por humano administrador, pela API autorizada e idempotente.
Preserva o checkout e o pagamento originais; quantidade e valor das peças
mudam com auditoria e evento transacionais, sem reabrir o pedido.

| Fronteira    | Implementação                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| Frontend     | Vue 3, Vue Router, JavaScript ESM, CSS e Vite; sem store global                                                     |
| API          | Node.js/Fastify, REST `/api/v1`, OpenAPI e SSE                                                                      |
| Persistência | PostgreSQL, SQL e migrations versionadas                                                                            |
| Assíncrono   | Inbox/outbox e jobs transacionais; sem Redis                                                                        |
| Runtime CRM  | `silmer-edge-web`, `silmer-api`, `silmer-worker`, `silmer-postgres`; arquivos no RustFS `schedule/rustfs` (ADR 023) |
| Automação    | n8n externo obrigatório, persistência e credenciais próprias                                                        |
| IA           | OpenAI no workflow; [ADR 021](docs/adr/021-adotar-openai-no-mvp.md)                                                 |
| Deploy       | Fluxo automático GitHub→EasyPanel existente; [ADR 022](docs/adr/022-manter-deploy-automatico-github-easypanel.md)   |

Nova mídia enviada pelo vendedor no chat usa RustFS privado e fica salva
até nova decisão de retenção, sem expurgo por sete dias ou encerramento
([ADR 029](docs/adr/029-midia-do-chat-no-rustfs.md)). A implementação inclui
imagem, áudio anexado/gravado e vídeo, ACL privada, Range e cleanup apenas de
rascunhos sem vínculo. Homologação do pipeline construído, microfone físico,
ativação e recovery remotos permanecem gates independentes em
[INBOX-MEDIA-1](.specs/features/inbox-media-rustfs/tasks.md).

O envio só é liberado após validação de conteúdo e antivírus com definições
vigentes. O motor `clamd` permanece no worker e recebe arquivos por socket
Unix privado, conforme [ADR 030](docs/adr/030-antivirus-persistente-no-worker.md).
Sua atualização confirma o novo motor antes de publicar freshness. Indisponibilidade
temporária preserva o rascunho sem autorizar envio.
Evidência sintética no chat DEV não homologa microfone físico nem
WhatsApp. A minimização e o expurgo dos dados de execução n8n identificados
na revisão de privacidade permanecem um gate de produção.

Mídia de canal legada fica em volume privado da VPS por até sete dias ou fim da
jornada. Arquivos válidos são anexados ao pedido e guardados no RustFS.
Perda da única cópia produz `lost/unavailable`. Esse prazo não se aplica a
Pedidos, Fichas, documentos comerciais ou auditoria. Storage externo é uma
evolução na issue #29; backups e tombstones têm gates próprios.

Os módulos/tabelas legados continuam onde migrations já publicadas exigem
compatibilidade. Não são uma segunda fonte de estado nem autorizam retomar
Kanban. Remoção física depende de migration contract.

## Prontidão operacional

OpenAI é escolhido; DPA, retenção, ZDR e request real ainda precisam de
evidência específica do projeto. Spikes Gemini anteriores não liberam o
provedor ativo ([runbook](docs/integrations/openai/README.md)).

Manter o deploy automático não comprova seu vínculo com CI, SHA ou imagem.
Esses checks, saúde, rede e configurações observadas estão no
[relatório operacional](docs/runbooks/production-readiness-checks.md).

Go-live exige homologação WhatsApp, aprovação física da v6, monitor off-host,
backup externo e drills com RPO de uma hora/RTO de quatro horas. Aplicar
CRM/migrations compatíveis antes do workflow que depende do contrato novo.
Rollback pausa a automação e preserva resultados incertos; não reativa o
webhook direto da Meta nem restaura banco como primeiro recurso.

Decisões anteriores continuam em `docs/adr/`; o histórico não substitui
`RULES.md` e as specs atuais. Rastreabilidade e pendências em
[tasks](.specs/features/crm-mvp/tasks.md).

## CHAN-WA-01 — Encaminhamento para WhatsApp

A [ADR 044](docs/adr/044-atendimento-comercial-concentrado-no-whatsapp.md)
supersede o chat comercial ativo do site dos ADRs 026/034. Site/linktree
usam link direto; o webhook antigo responde orientação estática antes de
CRM/IA. A loja e dados históricos mantêm seus contratos. Configuração do
perfil/Direct Instagram e publicação n8n exigem evidência própria.

## Saúde operacional — OPS-HEALTH-T01

A [ADR 060](docs/adr/060-saude-operacional-e-retencao-tecnica.md) define
heartbeat/progresso por fila e snapshot operacional público200/503 atualizado
a cada minuto, sem I/O por request. Diagnósticos da central têm14dias de
retenção e limpeza diária limitada, fora da leitura. Coleta segue manual.
Sem nova infraestrutura ou alteração do healthcheck de restart.
