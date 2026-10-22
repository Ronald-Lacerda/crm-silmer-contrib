# Arquitetura — baseline do CRM Silmer

Reconciliada com a master em 10/10/2026; ficha v6, arte no RustFS, loja paga, chat do site e mídia do vendedor. Detalhes em
[TECHNICAL-DESIGN.md](TECHNICAL-DESIGN.md) e
[EASYPANEL-TOPOLOGY.md](EASYPANEL-TOPOLOGY.md).

## Produto e autoridade

O CRM é um monólito modular. PostgreSQL guarda Contato, Conversa, Mensagem,
Handoff, Pedido, auditoria e jobs. A interface Vue 3 oferece Dashboard,
Caixa de Entrada, Clientes, Pedidos, Vendedores e Conta. Negócio/Kanban
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
numeração global `NN-CRM`. Pode abrir a partir do primeiro ponto confirmado
da ficha; o bot preenche progressivamente, e o vendedor revisa/completa.
Um pendente acompanha o Contato; a confirmação congela o snapshot.

A [ADR 032](docs/adr/032-separar-pedido-conversa-e-assunto.md) separa o
Contato da Conversa para que o vendedor crie Pedido manual em Pedidos, sem
simular WhatsApp. O contrato legado do agente conserva um pendente por
Conversa; vários assuntos e pendentes na mesma Conversa exigem alvo explícito
e implantação posterior do contrato por Assunto.

No Pedido manual sem conversa, Primeiro contato recebe o instante de criação;
legados sem a data recebem `created_at`. Só pagamento é digitável. Os afazeres
do Dashboard são uma leitura dos pedidos manuais confirmados, sem entrega e
sem marca de teste, do próprio responsável. Confirmar entrega é um comando
autorizado, versionado e auditado que grava o dia de São Paulo; não cria outro
status nem reutiliza tarefas de Negócio (ADR 039).

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
