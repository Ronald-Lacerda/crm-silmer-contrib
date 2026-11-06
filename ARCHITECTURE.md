# Arquitetura — baseline do CRM Silmer

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
