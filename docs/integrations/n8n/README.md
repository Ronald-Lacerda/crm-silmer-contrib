# Integração CRM Silmer ↔ n8n — MVP simples

## Cobranças do pedido — ADR 058 (05/11/2026)

O fluxo aprovado da [RFC 049](../../rfc/049-cobrancas-do-pedido-com-infinitepay.md)
usa workflow dedicado, reserva financeira de uso único e callbacks
autenticados, separados da Inbox e de `store-orders`. Estado oficial no CRM,
sem acesso direto ao banco. Contrato COB-01–16 e
[operação/configuração/rollback](../../runbooks/order-billing.md).
O gerador offline está em `ops/n8n/workflows/create-order-billing-workflow.mjs`.

## Abertura assistida — ADR 056 (03/11/2026)

A [ADR 056](../../adr/056-abertura-de-pedido-com-confirmacao-humana.md)
supersede a criação automática descrita nas seções históricas abaixo.
O inbound anuncia `order_opening_policy: human_confirmation` e
`order_assistance.enabled`. O workflow conserva a coleta na conversa e
envia `open_order: false`; a API também neutraliza `open_order: true` e o
evento legado `order.intent_confirmed`, respondendo `awaiting_human` como
resultado de negócio, sem `ORDER_OPEN_FAILED` falso.

O evento `order.assistance.observed`, autenticado por
`integration.n8n.event.create`, leva `automation_epoch`, `source_revision`
e `observation: {signal, product_summary?, evidence_message_id?, briefing_patch?, subject_id?}`.
`signal` é `purchase_confirmed`, `not_ready`, `withdrawn`, `unsupported`,
`uncertain` ou `analysis_failed`; campos desconhecidos são recusados. Não
autoriza envio nem abre pedido. O observador usa histórico cliente/vendedor
também em modo humano e só propõe internamente. Evidência deve apontar mensagem
do cliente da conversa; revisões obsoletas são descartadas. Falhas do modelo
são mensuradas sem bloquear a resposta ou mudar o atendimento.

A Inbox lê `GET /api/v1/inbox/conversations/:conversationId/order-assistance`
e decide em `POST .../order-assistance/decisions`, com sessão, CSRF,
Idempotency-Key e versões/revisão. Aceitar cria pendente transacionalmente;
adiar/recusar registra motivo, e `missed` registra omissão humana. O painel
admin lê `GET /api/v1/inbox/order-assistance/metrics?days=30`, sem PII.
Aceite detalhado em [OA-01–12](../../../.specs/features/order-assistance/spec.md)
e publicação/rollback no [runbook](../../runbooks/order-assistance.md).

> **Decisão vigente:** [RFC 002](../../rfc/002-simplificar-integracao-n8n-para-o-mvp.md)
> e [ADR 003](../../adr/003-adotar-integracao-n8n-mvp-simples.md). RFC 001 e
> ADR 002 são histórico da alternativa mais robusta. O Pedido criado pelo
> agente segue a [ADR 006](../../adr/006-pedido-dois-status.md) e abre como
> manda a [ADR 014](../../adr/014-pedido-abre-no-primeiro-ponto-da-ficha.md).

## Objetivo e limite

OpenAI é o provedor do MVP, conforme a
[ADR 021](../../adr/021-adotar-openai-no-mvp.md). O workflow versionado
usa Responses API com `gpt-5.6-luna`; confirmação do modelo implantado e
controles de privacidade ficam no [checklist OpenAI](../openai/README.md).
Spikes Gemini não são dependência do lançamento. Deploy preserva o fluxo
GitHub → EasyPanel existente ([ADR 022](../../adr/022-manter-deploy-automatico-github-easypanel.md)).

O n8n recebe o evento do WhatsApp pelo transporte em uso, registra a mensagem
no CRM, usa o contexto devolvido pelo CRM, decide entre resposta de IA e
handoff e pede ao CRM uma autorização de uso único antes de enviar a resposta.
PostgreSQL continua sendo a fonte da verdade. O n8n não acessa o banco e não
mantém cópia paralela de cliente, conversa, briefing ou memória curta.

## Pré-ficha guiada antes do handoff

Em cada mensagem de texto, a IA extrai somente fatos confirmados para o
`briefing_patch` criptografado da Conversa e pergunta pelo próximo ponto da
ficha (ADR 012, ADR 024). A saudação pede o nome e o que o cliente quer
personalizar, nunca "qual camisa"; se o cliente não disser o nome, a resposta
seguinte reage ao que ele contou e pede só o nome, e depois o bot não insiste.
Os pontos, nesta ordem, são: produto (`product_type`), modelo
(`product_model`, só para roupa, boné ou bandeira), cor (`colors`),
quantidade (`quantity`), tecido (`fabrics`, só para roupa sem kit que o
defina), onde vai a estampa (`artwork_locations`), se o cliente já tem a arte
(`artwork_status`) e para quando o cliente precisa (`needed_by`, desejo do
cliente, nunca prazo confirmado); tecido e arte entram no ritmo pela
[ADR 051](../../adr/051-vendedor-aprende-com-os-atendentes-humanos.md).
Técnica, tamanhos, gola, personalização individual e divisão por público
nunca são perguntados: o bot grava o que o cliente disser e o vendedor
completa. A divisão por público vai em
`audiences` ("4 masculinas, 3 femininas e 3 infantis"), e o CRM a transforma
em um item por público quando a lê sem dúvida (ADR 025). O bot nunca oferece criar a arte e, de
tecido, só fala de algodão, poliéster e dry fit. Os demais campos
(identificação do pedido, finalidade, perfil de compra, logística e
anotações) também só são gravados quando o cliente fala deles. A retirada é
sempre na "Loja da Silmer".

Sem perguntar, o workflow grava o que já está definido (`KITS`): abadá é
sublimação total em poliéster branco com gola regata; sublimação total pede
poliéster branco; regata tem gola "regata", polo tem "gola polo", e boné e
bandeira têm gola `NAO APLICAVEL`. Também grava o produto a partir do
modelo dito ("30 regatas"), o modelo quando o produto já o nomeia ("abadás")
e o nome do produto no modelo de boné e bandeira ("bonés trucker").
Mochila, bolsa e similares (sacochila, ecobag, sacola, necessaire, pochete e
estojo) não entram na ficha: o nó de decisão transfere na hora com
`unsupported`, sem gravar o briefing do turno nem abrir Pedido (ADR 044). O
grupo `bolsa` continua nas tabelas do SDK só para reconhecer esse produto.
Só preenche campo vazio, e o que preenche não é perguntado. O resumo da
transferência traz "Atenção" (`ALERTS`: sublimação em algodão ou em peça
escura, bordado com foto) e "Dica" (`HINTS`: técnica usual do produto,
personalização individual, divisão por público), só para o vendedor.

O workflow escolhe o próximo ponto pela constante `FICHA_RHYTHM` do SDK, o
primeiro ponto do produto ainda vazio, um por mensagem, e calcula de forma
determinística os pontos pendentes depois de unir o patch ao briefing atual.
O nó de contexto diz ao modelo o produto reconhecido e como perguntar o
próximo ponto (`POINT_QUESTIONS`). Ele só emite `briefing_complete` quando os
pontos do produto e o nome estiverem presentes; o nome pedido duas vezes sem
resposta deixa de ser exigido. Os grupos de produto ficam em `PRODUCT_KINDS`
e `NAMED_MODELS`. Para preparar uma mudança de ordem ou acrescentar um kit, edite
`ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sdk.js`, atualize o snapshot
candidato da jornada com os nós gerados por `render-mvp-workflow.mjs` e rode
`npm run generate:n8n-dev-workflow` e `npm run generate:n8n-local-workflow`.
O candidato guarda a jornada com a fronteira Meta e não contém o
ramo de mídia da Inbox aplicado no n8n por `patch-evolution-inbound-images.mjs`
e `patch-evolution-inbound-audio.mjs`. O principal publicado usa Evolution
([ADR 050](../../adr/050-evolution-baileys-como-ponte-do-whatsapp.md)): não
importe o snapshot nem um candidato gerado dele sobre o principal, pois isso
devolveria o transporte à Meta ou perderia o ramo de mídia. Leve mudanças da
jornada como delta sobre o export vivo, comparando nós, conexões e settings.
`create-evolution-workflow.mjs` converte uma fonte para Evolution e serve para
candidatos inativos e testes; ver o [runbook Evolution](../../runbooks/evolution-baileys.md).

A referência operacional versionada é agora o [export publicado de 141 nós](../../../ops/n8n/workflows/k7tI6T4RhQPyJkn9-published.sanitized.json),
selecionado pelo [manifesto de produção](../../../ops/n8n/workflows/production-reference.json).
O publicado é a fonte da verdade. O candidato Meta de 115 nós, SDK,
geradores e snapshots DEV/local permanecem preservados. As funcionalidades
que diferem da produção têm [pendências separadas](../../../ops/n8n/workflows/README.md)
no Linear. `prepare-vendedor-update.mjs` substitui códigos inteiros e não é
procedimento seguro para reaplicar esses deltas sem revisão dos wrappers.
O alinhamento SIL-36 não importou, executou ou publicou workflows.

Os gatilhos de transferência da ADR 009 são
aplicados pelo nó de decisão, não só pelo prompt: pergunta de preço, frete ou
pagamento repetida (a primeira é adiada, ADR 051); pedido de pessoa ou de vendedor pelo nome; nome fora do CRM pedido
duas vezes; conversa que não é pedido do zero (camisa ou boné do post, "quero
essa camisa", pedido de contato por e-mail, WhatsApp ou telefone, algo já
combinado com a Silmer; ADR 013); duas respostas incompreensíveis ou indecisas
para o mesmo item; reclamação; urgência; conteúdo não suportado; e o teto de
15 mensagens. O resumo de todo handoff traz "Ficha: X de N (Y%)", o indicador
da meta de 50% da ficha, com N igual ao nome, enquanto o bot o pede, mais os
pontos do produto (9 para roupa; 8 para boné ou bandeira; 7 para outro
produto ou produto não dito; ADR 051); o
[roteiro do indicador da ficha](roteiro-indicador-da-ficha.md) tem as
mensagens para testá-lo.
`briefing_status` e `next_required_field` guardam o estado desses gatilhos e
não vão para a Ficha. Nenhuma informação inferida vira Pedido oficial,
catálogo, preço, prazo garantido ou pagamento. O agente pode criar um Pedido
`pendente`, que é rascunho não oficial, na rodada em que a ficha ganha o
primeiro dos seus pontos ou um campo que ele só grava, em geral o produto
(ADR 014); oficial é o Pedido `confirmado`, e a confirmação permanece humana
(ADR 006).

O bot atende só no WhatsApp e lê imagens e áudios
([ADR 026](../../adr/026-midia-e-chat-do-site-no-bot.md)). O site e o Instagram
só encaminham para o WhatsApp, sem IA nem coleta
([ADR 044](../../adr/044-atendimento-comercial-concentrado-no-whatsapp.md)).
O adapter direto Meta → CRM permanece apenas como fixture de desenvolvimento e
nunca é fallback silencioso.

**Transporte.** O SDK versionado
(`ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sdk.js`) ainda descreve os nós
da Graph API da Meta. O workflow publicado em 29/10/2026 já usa o Evolution
como transporte do WhatsApp; a ADR 050 (Evolution) está em integração em outro
PR. As seções sobre Meta, WAHA e chat do site abaixo são histórico ou
referência do SDK. A reserva de envio, o fence e os eventos do CRM valem para
qualquer transporte.

## Imagem, áudio e chat do site (ADR 026, chat do site encerrado pela ADR 044)

- **Imagem** (até 5 MB) vai anexada ao agente. **Áudio** (até 16 MB) é
  transcrito pela mesma conta OpenAI (`gpt-4o-mini-transcribe`) e entra como
  a mensagem do cliente. No WhatsApp, os nós `WhatsApp - Consultar mídia` e
  `WhatsApp - Baixar mídia` usam a credencial WhatsApp na Graph API `v23.0`
  (fixa no nó, porque o n8n 2 bloqueia `$env` nos nós por padrão); no site, o
  arquivo já chega com a mensagem.
- O que não pode ser consultado, baixado, preparado ou transcrito (por exemplo
  áudio AAC ou AMR) chega ao modelo como "não consegui abrir", e o bot pede
  para o cliente escrever. Imagem, lida ou não, recebe "Recebi sua imagem, já
  deixei aqui para o vendedor ver." e a próxima pergunta, e nunca conta como
  tentativa falha nem pergunta ignorada (ADR 051). Documento, vídeo e tipo desconhecido transferem.
- Figurinha é guardada como imagem e não vai ao modelo; localização e contato
  viram texto; reação e avisos de sistema são ignorados.
- **Chat do site:** `Site - Receber mensagem do chat (MVP)` é um Chat Trigger
  público em modo `webhook`, só para `https://silmer.com.br` e
  `https://www.silmer.com.br`, com upload de imagem e áudio. O widget
  `@n8n/chat` do site usa a URL de produção desse nó
  (`/webhook/<webhookId>/chat`); o `webhookId` não muda numa atualização do
  workflow. Cada sessão do navegador vira a identidade `999` + 39 dígitos
  sintética, que nunca é um número real. Nome e telefone informados antes da
  primeira mensagem entram como `site_contact`, declaração cifrada e não
  confirmada da sessão (CP-T06); não são `wa_id` nem unem históricos.
- No chat, resposta e aviso voltam no widget (`responseMode: lastNode`). O
  painel recusa com `422` uma mensagem humana para a identidade sintética;
  o encaminhamento humano do piloto precisa ser comunicado no aviso.

## Entidades que o fluxo cria ou altera

| Conceito de produto | Persistência oficial                    | Comportamento no fluxo                                                                                                            |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cliente             | `contacts` + `contact_identities`       | Criado provisoriamente na primeira identidade de canal; o site guarda telefone declarado à parte em `site_contact_claims`.        |
| Conversa            | `conversations`                         | Uma conversa aberta por identidade/canal; guarda modo, `automation_epoch` e revisão inbound.                                      |
| Mensagem            | `messages`                              | Inbound e outbound cifrados; identidade externa ou `command_id` impede duplicidade. O estado de entrega fica na própria mensagem. |
| Briefing            | `subject_briefings`                     | Um snapshot cifrado por Assunto; `briefing_patch` exige Assunto e Pedido explícitos no contrato novo. Não promove dado oficial.   |
| Handoff             | `handoffs`                              | Criado sem responsável para a função humana vigente `Vendedor`; uma pessoa compatível o reivindica atomicamente.                  |
| Pedido              | `orders`                                | Criado `pendente` pelo `open_order` da reserva ou do handoff (ADR 014), nunca pela chegada de mensagem. Confirmar é ação humana.  |
| Comando humano      | `n8n_commands` + `outbox_jobs`          | Estado oficial e outbox são gravados antes de o worker chamar o webhook do n8n.                                                   |
| Evidência técnica   | `n8n_events`, auditoria e reconciliação | Registra correlação, workflow, versão, execução e resultado sem conteúdo pessoal ou segredo técnico.                              |

As tabelas `ai_turns`, `automation_runs`, `conversation_briefing_versions` e
`message_delivery_attempts` foram criadas por migrações já publicadas, mas não
participam do runtime simplificado. Permanecem dormentes até uma migração
contract explícita e segura removê-las.

## Contrato n8n → CRM

Os três endpoints usam `Authorization: Basic`, `Idempotency-Key`,
`X-Correlation-Id`, `X-Silmer-Workflow-Key`, `X-Silmer-Workflow-Version` e
`X-Silmer-Execution-Id`. Upload também exige `X-Silmer-Content-SHA256`.

O workflow da loja usa uma quarta rota com os mesmos cabeçalhos, só para o
pedido pago da loja (seção [Pedido pago da loja](#pedido-pago-da-loja-adr-028)).

1. `POST /api/v1/integrations/n8n/messages/inbound`
   cria ou resolve Cliente, Conversa e Mensagem e devolve `source_revision`,
   `automation_epoch`, modo, mensagens recentes, `subjects` e
   `source_subject_ids`.
2. `POST /api/v1/integrations/n8n/conversations/{id}/attachments`
   recebe uma mídia por streaming, valida tamanho, hash, MIME e malware e só a
   vincula depois da quarentena. O workflow ainda não envia a mídia por este
   endpoint: a IA a lê direto da Meta ou do chat (ADR 026).
   A correção INBOX-IMG-01 prepara um ramo de persistência para a implantação
   temporária WAHA, sem substituir esse snapshot Meta. Aplicação e recuperação
   dos anexos anteriores seguem o
   [runbook de imagens recebidas](../../runbooks/inbound-images-inbox.md).
3. `POST /api/v1/integrations/n8n/events`
   recebe reserva de envio, callbacks de entrega, handoff, abertura do Pedido
   pendente (`open_order` na reserva ou no handoff) e falha do workflow.

Eventos aceitos: `message.send.requested`, `message.sent`,
`message.delivered`, `message.read`, `message.failed`,
`message.send.unknown`, `message.transcribed` (migração 0048, ADR 052),
`handoff.requested`, `order.intent_confirmed` (obsoleto desde a ADR 014,
aceito para workflows antigos) e `workflow.failed`.

O retorno do inbound também traz `automation_message_count` (mensagens do
agente já reservadas na Conversa), `automation_message_cap` (15) e `sellers`
(vendedores ativos, só id e primeiro nome), conforme a ADR 009.

Erros usam `application/problem+json`. Replay da mesma chave com o mesmo
payload devolve o resultado idempotente; a mesma chave com payload diferente
retorna `409`.

### Campos da ADR 052 (migrações 0046–0048)

Todos são opcionais: um workflow que não os envia continua funcionando. O
schema segue estrito, e o CRM antigo recusa os campos novos com `400`. Por
isso o `mvp-simple-20` só os envia quando a resposta do inbound traz a chave
`contact_context`, que o CRM desta rodada sempre devolve (nula no primeiro
contato). Sem a chave, o workflow faz o que a `mvp-simple-19` fazia: sem
`turn`, sem id do vendedor (o nome segue no resumo), falha como `unsupported`,
parceria como `human_requested` e sem `message.transcribed`.

- **Motivos novos de handoff.** `handoff.reason` aceita `automation_failure`
  (falha do modelo, do parser, do agente ou da decisão) e `partnership`
  (parceria, revenda, atacado e nota fiscal). Sem `summary`, o handoff de
  `automation_failure` recebe um resumo fixo do CRM.
- **Vendedor pedido pelo nome.** `handoff.requested_seller_id` leva o id de
  um item de `sellers` (`^[A-Za-z0-9_-]{1,128}$`; os ids reais são
  `user-<hex>`). O CRM grava em `crm.handoffs.preferred_user_id`
  (`text`, porque `crm.users.id` é `text`). Id que não é Vendedor ativo é
  ignorado e auditado como `PREFERRED_SELLER_NOT_ACTIVE`; o handoff é criado
  mesmo assim, sem dono. A lista da Inbox mostra
  `handoff.preferredSellerFirstName`; `GET .../conversations/{id}/handoff`
  devolve `preferred_seller: {id, first_name}` ao lado de `handoff`.
- **Telemetria `turn`.** `message.send.requested` e `handoff.requested`
  aceitam um objeto estrito, só com códigos, contagens e tempos. Chave
  desconhecida dá `400`.

  | Campo           | Regra                                                                               |
  | --------------- | ----------------------------------------------------------------------------------- |
  | `ficha_filled`  | Obrigatório, inteiro de 0 a 64, até `ficha_total`                                   |
  | `ficha_total`   | Obrigatório, inteiro de 0 a 64                                                      |
  | `asked_field`   | `^[a-z_]{1,48}$` ou nulo                                                            |
  | `answer_status` | `answered`, `unclear`, `undecided`, `question`, `deferred`, `other`, `none` ou nulo |
  | `trigger`       | `^[a-z0-9_]{1,64}$` ou nulo                                                         |
  | `model`         | `^[a-z0-9._-]{1,64}$` ou nulo                                                       |
  | `latency_ms`    | Inteiro de 0 a 600000 ou nulo                                                       |
  | `media_kind`    | `text`, `image`, `audio`, `sticker` ou nulo                                         |

  O CRM grava uma linha por evento aceito em `crm.automation_turns`; replay
  não duplica. Reserva ou handoff recusado pelo fence não deixa linha e é
  contado pela auditoria `integration.n8n.stale_fence`.

- **Transcrição do áudio.** `message.transcribed` leva `conversation_id`,
  `external_message_id` (o mesmo `message.external_id` do inbound do áudio) e
  `transcript`: `{status: "ok", text}` com 1 a 4000 caracteres, ou
  `{status: "failed", code}` com `TRANSCRIPTION_FAILED`,
  `TRANSCRIPTION_EMPTY` ou `AUDIO_TOO_LARGE`. Mensagem que não existe na
  conversa dá `404`; mensagem que não é áudio de entrada dá `409
TRANSCRIPT_TARGET_INVALID`. Um `failed` pode virar `ok`; um `ok` gravado não
  é substituído (`409 TRANSCRIPT_ALREADY_RECORDED`). O texto é cifrado com a
  chave das mensagens e segue a retenção da mensagem.
- **Código de falha do bot.** `message.failed` e `message.send.unknown`
  aceitam `failure: {code}`, só com essa chave. Código fora de
  `^[A-Z0-9_]{1,64}$` ou ausente vira `SEND_FAILED` no `message.failed` e
  `SEND_OUTCOME_UNKNOWN` no `message.send.unknown`. O CRM grava em
  `crm.messages.delivery_failure_code`; um `sent` ou `delivered` posterior
  limpa o código. A Inbox explica os códigos conhecidos, inclusive
  `META_SEND_OUTCOME_UNKNOWN`.
- **Histórico com Assuntos.** Cada item de `recent_messages` traz
  `subject_ids` (vazio sem vínculo). Áudio com transcrição `ok` vem com o
  texto e `transcribed: true`. O workflow filtra pelo Assunto do turno só
  quando há mais de um.
- **Cliente recorrente.** O inbound devolve `contact_context` só com
  `previous_cycles`, `previous_orders_count` (0 a 99, sem pedidos de teste
  nem os desta conversa) e `last_closed_at` (data em São Paulo). Lista de
  pedidos e desfecho saíram por minimização (RULES 8 e 13). Quando uma das
  contagens é maior que zero, o prompt recebe só "Cliente recorrente: já foi
  atendido pela Silmer antes.", sem número, produto, pedido ou data.
- **Encerrar resolve o handoff.** Ao encerrar a conversa, o handoff ativo vai
  para `resolved` na mesma transação, com `reason_code='conversation_closed'`
  no histórico. Handoff sem dono recebe como `assigned_user_id` quem encerrou,
  porque o CHECK da 0013 exige dono em `resolved`.

## Fence de envio simplificado

Não existe claim, lease nem token de rodada. Para uma resposta automática, o
`message.send.requested` deve apresentar a revisão inbound e o epoch devolvidos
pelo CRM. A autorização só é concedida quando a conversa continua aberta e em
modo IA, o epoch é atual e a revisão ainda não foi consumida. O CRM grava a
Mensagem com estado `sending` e avança `claimed_revision` na mesma transação.

Somente `send_authorized: true` permite chamar a Meta. Replay sempre devolve
`send_authorized: false`. Timeout depois da autorização vira
`message.send.unknown`; não há retry cego. Callbacks tardios de uma reserva já
aceita podem concluir o estado mesmo após takeover.

### Teto e aviso de transferência (ADR 009, BOT-03)

O agente envia no máximo `automation_message_cap` (15) mensagens por Conversa,
contadas pelo CRM nas mensagens com autor `assistant`, inclusive envios
incertos. A última vaga é do aviso de transferência: com 14 mensagens, o CRM
recusa um `message.send.requested` normal com `409 AUTOMATION_MESSAGE_CAP`.

`handoff.requested` aceita `handoff.notice` (`command_id` e `text`). Na mesma
transação do handoff, o CRM reserva o aviso como mensagem do agente e responde
`notice.send_authorized: true`. Replay ou teto já gasto respondem `false`, e o
handoff acontece mesmo assim. O workflow só chama a Meta com `true` e depois
registra `message.sent` ou `message.send.unknown` pelo `command_id` do aviso.
O handoff pelo teto usa o motivo `iteration_limit` (migração 0025).

Takeover e handoff incrementam `automation_epoch`, invalidando decisões ainda
não reservadas. Status segue a ordem `sent < delivered < read` e nunca regride.

Uma mudança de entrega do comando de mensagem humana (`sent`, `failed` ou
`outcome_unknown`) atualiza a mensagem e publica um evento SSE na mesma
transação. O evento contém só o identificador da conversa; Inbox e Pedidos
reconsultam a API autorizada. A recuperação de lease ou fila incerta aplica o
mesmo sinal uma vez, sem rebaixar um envio já confirmado.

## Briefing, conversão e handoff

O agente recebe `recent_messages` e `briefing` na resposta inbound. Pode mandar
um `briefing_patch` junto de `message.send.requested` ou `handoff.requested`;
nulos são ignorados. Preço, pagamento, etapa e outros campos oficiais não são
aceitos nesse patch.

Inbound não cria Pedido. Na rodada em que a ficha ganha o primeiro dos sete
pontos, a reserva de envio ou o handoff leva `open_order: true` (ver "Pedido
criado pelo agente"). O bot não pergunta se pode montar o orçamento nem o nome
do pedido (ADR 010).
`convertida_em_lead` encerra a triagem, não a Conversa; ela só termina por
`Sem lead`, `Fechado` ou `Perdido` conforme as regras do domínio.

Todo handoff vai para Vendedor (ADR 009). O aviso ao cliente de que um
vendedor vai continuar vai junto do `handoff.requested` (`handoff.notice`),
conforme a ADR 009.

## Pedido criado pelo agente

### Abertura com `open_order` (ADR 014)

`message.send.requested` e `handoff.requested` aceitam o booleano opcional
`open_order`. O workflow o calcula pela regra da
[ADR 014](../../adr/014-pedido-abre-no-primeiro-ponto-da-ficha.md): `true` na
rodada em que a ficha (briefing anterior unido ao patch da rodada) ganha o
primeiro valor real de um dos pontos (ADR 024: o produto é o primeiro) e em
todas as seguintes; o nome sozinho e "Definir com o vendedor" não abrem, e o
que não é pedido do zero
(ADR 013) nunca abre. Um valor que não seja booleano, ou o campo em outro
evento, volta `400`. A autorização é a do próprio evento.

```json
{
  "schema_version": "1.0",
  "event_id": "reserve:<conversa>:<revisão>:ai-response",
  "event_type": "message.send.requested",
  "conversation_id": "<id da conversa>",
  "automation_epoch": 3,
  "source_revision": 7,
  "command_id": "<conversa>:<revisão>:ai-response",
  "message": { "type": "text", "text": "<resposta>" },
  "briefing_patch": { "quantity": 30 },
  "open_order": true,
  "occurred_at": "<ISO 8601>"
}
```

Depois que a transação do evento confirma, o CRM cria ou reutiliza o Pedido
pendente da conversa a partir da ficha já unida (sem pendente, cria um; com
pendente, reutiliza; só com pedidos confirmados, cria um novo: PCL-01..03) e
responde no mesmo corpo:

```json
{
  "accepted": true,
  "send_authorized": true,
  "order": {
    "opened": true,
    "id": "<pedido>",
    "subject_id": "<assunto>",
    "created": true
  }
}
```

- Um pedido que já existia recebe a projeção da pré-ficha (`created: false`);
  um pedido criado agora já nasce da ficha unida.
- Replay da mesma `Idempotency-Key` tenta de novo e devolve `order` do mesmo
  jeito, sem novo pedido: um retry depois de uma falha abre o pedido.
- Uma falha ao abrir não falha o evento: a reserva continua autorizada e o
  handoff acontece. A resposta traz
  `"order": { "opened": false, "error": "<CÓDIGO>" }`, com o código de domínio
  (por exemplo `CONVERSATION_NOT_FOUND`), `ORDER_OPEN_FAILED` para qualquer
  outro erro ou `ORDERS_RUNTIME_UNAVAILABLE` sem o módulo de pedidos. O CRM
  grava a auditoria `integration.n8n.order.open_failed` na conversa e um log
  sem dados pessoais (código, conversa, correlação e tipo do evento).
- Sem `open_order`, ou com `false`, a resposta não traz `order` e nada muda no
  Pedido além da projeção de antes.

### Evento `order.intent_confirmed` (obsoleto)

Obsoleto desde a ADR 014: os workflows a partir de `mvp-simple-11` usam
`open_order`. O CRM continua aceitando o evento para os workflows antigos,
com as mesmas regras de criação.

Enviado em `POST /api/v1/integrations/n8n/events` quando o agente identifica a
intenção de compra. Usa os mesmos cabeçalhos dos demais eventos:
`Authorization: Basic`, `Idempotency-Key`, `X-Correlation-Id`,
`X-Silmer-Workflow-Key`, `X-Silmer-Workflow-Version` e `X-Silmer-Execution-Id`.
A credencial precisa da ação de automação `order.intent`, que não existe para
usuários humanos.

```json
{
  "schema_version": "1.0",
  "event_id": "<id único do evento no workflow>",
  "event_type": "order.intent_confirmed",
  "conversation_id": "<id da conversa devolvido pelo inbound>",
  "occurred_at": "<ISO 8601>"
}
```

`briefing_patch` continua aceito somente em `message.send.requested` e
`handoff.requested`; ele não acompanha este evento.

Regras:

- Conversa sem pedido pendente: o CRM cria exatamente um pedido `pendente`
  vinculado à conversa e ao contato, com número `NN-CRM` reservado.
- Conversa com pedido pendente: o CRM reutiliza o pendente; nenhum pedido novo
  é criado.
- Conversa só com pedidos confirmados: o CRM cria um novo pedido `pendente`.
- Idempotência: replay da mesma `Idempotency-Key` com o mesmo payload devolve o
  resultado original; a mesma chave com payload diferente retorna `409`.
  Intenções repetidas com chaves diferentes também não duplicam o pendente.
- O evento nunca confirma, reabre nem altera valor ou condição de pagamento.

### Projeção da pré-ficha no pedido pendente

Depois de unir o `briefing_patch` ao briefing da conversa, o CRM projeta os
campos da ficha no pedido `pendente` da conversa:

- Conversa com o agente (`automation_state = assistant`) e com pedido
  pendente: os campos são projetados no pedido.
- Conversa com vendedor (`automation_state = human`): o patch é ignorado para o
  pedido e o fato fica registrado na auditoria. A conversa não volta para a IA
  (ADR 015), então o pendente não recebe mais a projeção: o vendedor completa
  o pedido.
- Pedido confirmado nunca recebe projeção.
- Preço, valor, condição de pagamento, status e outros campos oficiais
  continuam recusados no `briefing_patch`, como antes.

## Contrato por Assunto (CP-T04, CP-15..18)

Implantar esta versão do CRM e a migration `0039_subject_briefings` antes de
ativar o workflow novo. O inbound devolve `subjects` com `subject_id`,
`order_id`, `order_number`, `order_status`, `is_current`, `selected_source`, `briefing` e
`briefing_version` por Assunto, mais `source_subject_ids` da mensagem atual.
`order_status` é `pendente`, `confirmado` ou `cancelado` (cancelamento local do
Pedido, OLIST-19): cancelado nunca é Pedido pendente elegível, não conta em
`previous_orders_count` e como alvo explícito responde `SUBJECT_TARGET_INVALID`.
O briefing por Assunto é cifrado. O campo `briefing` no nível da Conversa
permanece para o workflow legado durante a transição.

Na primeira rodada de um Pedido da Conversa, quando ainda não há Assunto nem
Pedido pendente nela, `open_order: true` pode acompanhar o primeiro
`briefing_patch`, ainda sem IDs. O CRM reserva o envio, cria ou
reutiliza o único pendente legado da Conversa e cria ou recupera seu Assunto;
a resposta traz `order.id` e `order.subject_id`. O primeiro patch compõe a
Ficha e é copiado para o briefing do Assunto. Se a criação do Assunto falhar,
`order.opened` é `false`; repetir a mesma chave recupera o Assunto sem
autorizar outro envio. Esse bootstrap **reutiliza** um pendente existente na
Conversa e não cria um segundo pendente nela.

Nas alterações posteriores, o workflow envia `target_contract: "subject-v1"`
e o par `subject_id`/`order_id` no evento de reserva ou handoff. O CRM valida
ambos contra a Conversa e o Contato atual, Pedido pendente, seleção humana,
`automation_epoch`, `source_revision` e `Idempotency-Key`. A projeção usa o
Pedido indicado, inclusive quando ele nasceu em outro ciclo, e repete essas
validações após a reserva antes de gravar a Ficha. As versões
`mvp-simple-15+` e `dev-mvp-simple-16+` exigem o mesmo par para qualquer
`briefing_patch`, mesmo se `target_contract` for omitido.
Eventos explícitos com patch respondem também com
`projection: { "applied": true }` ou
`projection: { "applied": false, "error": "<CÓDIGO>" }`. Em falha transitória,
repetir a mesma chave tenta a projeção novamente sem autorizar outro envio;
uma projeção já concluída é reconhecida pelo ID do evento e não grava uma
segunda versão do Pedido. Uma mensagem posterior sem nova alteração do
Assunto permite reparar a projeção do evento aceito; o recibo fixa as versões
de Assunto e Pedido. Se o briefing, a Ficha, takeover ou seleção humana
invalidar a decisão, a projeção falha fechada (`SUBJECT_SUPERSEDED` ou
`ORDER_CHANGED_SINCE_EVENT`) e o workflow pede esclarecimento ou transfere.

```json
{
  "schema_version": "1.0",
  "event_id": "reserve:conv-7:2",
  "event_type": "message.send.requested",
  "conversation_id": "conv-7",
  "automation_epoch": 0,
  "source_revision": 2,
  "command_id": "conv-7:2:ai-response",
  "target_contract": "subject-v1",
  "subject_id": "subject-4",
  "order_id": "order-9",
  "briefing_patch": { "quantity": 30 },
  "message": { "type": "text", "text": "Qual a cor?" },
  "occurred_at": "2026-10-14T12:00:00.000Z"
}
```

Quando `source_subject_ids` contiver mais de um Assunto, ou a mensagem puder
referir-se a dois Pedidos, o workflow transfere sem patch (gatilho
`subject_ambiguous`, motivo `low_confidence`). Um envio sem alvo é recusado
com `SUBJECT_TARGET_REQUIRED` quando há mais de um pendente; perguntar ao
cliente antes de transferir é proposta da
[RFC 036](../../rfc/036-assunto-da-mensagem-so-na-duvida-do-agente.md). O CRM
marca as mensagens desse turno para o vendedor indicar o Pedido e, nos turnos
com alvo, liga sozinho as mensagens de entrada ao Assunto (ADR 048). Um alvo
incorreto ou uma seleção humana divergente retorna `409`
(`SUBJECT_AMBIGUOUS`, `SUBJECT_TARGET_INVALID` ou
`SUBJECT_TARGET_CONFLICT`); um evento legado inseguro retorna
`SUBJECT_TARGET_REQUIRED`. Não reenviar a mesma decisão após o conflito.
`source_subject_ids` pode incluir Assunto geral ou Pedido confirmado; o
workflow só altera quando o Assunto tem `kind: "pedido"` e
`order_status: "pendente"`. Outra reserva `open_order:true` sem IDs após
existir Assunto ou pendente recebe `SUBJECT_TARGET_REQUIRED`.
O workflow legado ainda opera sob o limite de um pendente por Conversa.
Criar um **segundo** pendente na mesma Conversa ainda não é um comando do
agente: `open_order: true` reaproveita o pendente legado. Pedidos adicionais
criados pela pessoa ou em outro ciclo podem ser vinculados como Assuntos e
receber atualizações pelo par explícito. Telefone informado no chat do site
serve só para busca interna; acesso ao histórico ou edição de Pedido anterior
dependem de confirmação pelo WhatsApp. Ele nunca vira `wa_id` confirmado por
inferência nem entra na identidade WhatsApp.
Mesmo com um único pendente, uma mensagem como "outro pedido" ou "agora quero
bonés" não herda esse alvo: o workflow transfere sem alterar o briefing ou a
Ficha. O vendedor responde na própria mensagem marcada a qual Pedido ela se
refere, ou cria o Assunto, antes de continuar.

## Ingresso do chat do site (CP-T06, CP-21..22)

Instalar as migrations `0038` a `0040` e este contrato no CRM antes de mudar o
workflow. O piloto do site usa `channel: "site_chat"`, `provider: "site"` e
`contact.external_id` com o identificador sintético de sessão `999` seguido
de 39 dígitos decimais do UUID da sessão. O workflow calcula
`999 + BigInt('0x' + uuidSemHifens).toString(10).padStart(39, '0')` e exige
UUID válido do Chat Trigger; o CRM rejeita o identificador legado de 12
dígitos neste contrato. Cada envio do widget inclui `site_contact` com o
mesmo nome e telefone informado no início da Conversa. O CRM também aceita
sua omissão após o primeiro inbound, mas o nó atual do n8n exige esses campos
em toda mensagem. Outro nome ou telefone na mesma Conversa recebe `409
SITE_CONTACT_CONFLICT`; a correção exigirá um fluxo humano auditado.
Cada envio do widget inclui `metadata.site_message_id` UUIDv4 novo e
`metadata.site_message_at` como instante ISO canônico da criação da mensagem.
Se a requisição for repetida após falha de rede, o widget reutiliza ambos.
Assim o `event_id` **e** `occurred_at` do CRM permanecem estáveis no replay,
mesmo que o n8n crie outra execução. O CRM inclui o instante no fingerprint de
idempotência; reutilizar apenas o ID causaria conflito. Duas mensagens
intencionalmente iguais usam IDs e instantes próprios. Clientes antigos sem
`site_message_at` ainda entram com o horário do servidor, mas não têm a mesma
garantia de replay tardio.

```json
{
  "schema_version": "1.0",
  "channel": "site_chat",
  "provider": "site",
  "contact": { "external_id": "999024249434048109030647017182301789831168" },
  "site_contact": { "name": "Ana Sintetica", "phone": "5527999991234" },
  "external_conversation_id": "session-synthetic-001",
  "event_id": "site-event-synthetic-001",
  "message": {
    "external_id": "site-message-synthetic-001",
    "type": "text",
    "text": "Quero um orçamento"
  },
  "metadata": { "provider_account_id": "silmer-site" },
  "occurred_at": "2026-10-14T12:00:00.000Z"
}
```

O CRM cifra o claim por Conversa, mantém o Contato e o Pedido novos na
identidade sintética e põe o nome no rótulo do Contato e no briefing inicial.
O inbound devolve `site_contact: {"name":"..."}` e
`site_contact_match: "new"|"existing"|"ambiguous"`. A classificação é apenas
sinal interno para a operação; não contém ID ou histórico de candidatos e
não deve ir ao prompt do agente nem à resposta do widget. O telefone declarado
não entra como alias WhatsApp confirmado. O novo Pedido dessa Conversa pode
ser criado com `open_order:true`, mas o agente não pode projetar alterações
num Pedido de outro ciclo do chat do site. O CRM recusa um primeiro inbound
sem claim (`SITE_CONTACT_REQUIRED`) e replay com payload diferente usa o
conflito de idempotência existente.
Na Inbox, o vendedor vê o telefone declarado com a indicação "telefone
informado no site"; o identificador técnico da sessão não aparece como
telefone. Esse número permanece não verificado e não une a identidade do
chat à identidade do WhatsApp.

O vendedor continua o atendimento transferido **na caixa de entrada do CRM**.
Uma resposta humana de texto no canal `site_chat` passa pelo comando autenticado
do painel, pela reserva idempotente e pelo evento `message.sent`. O widget do
site consulta `POST {CRM}/api/v1/site-chat/messages` com
`{"session_id":"<UUIDv4 da sessão>"}` e recebe apenas mensagens de texto
daquela sessão (até 100); a API exige `Origin: https://silmer.com.br` ou
`https://www.silmer.com.br`, limita requisições e desabilita cache. O UUID é
segredo de acesso da sessão; o telefone declarado não é usado para consultar
mensagens. O widget mantém o UUID no navegador durante a conversa, atualiza a
lista após enviar e periodicamente enquanto aberto, e deduplica por `id`.
Áudio e anexos enviados pelo vendedor estão desabilitados no `site_chat` até
existir um caminho de entrega de mídia ao navegador. O chat hospedado pelo n8n
não recebe respostas humanas assíncronas; o widget próprio do site usa essa
consulta para exibi-las.

Antes de homologar esse repasse, confira no **worker** que `N8N_COMMAND_URL`
aponta para a URL de produção do nó `Painel - Receber comando (MVP)` do workflow
publicado e que `N8N_COMMAND_CLIENT_ID`/`N8N_COMMAND_CLIENT_SECRET` correspondem
à credencial Basic vinculada a esse nó. A URL do workflow DEV e credenciais
locais não servem para o chat publicado. Use uma conversa **sintética**: assuma
o atendimento, envie uma resposta humana por texto, confira `Enviado` no CRM e
a mesma resposta uma única vez no widget. A Inbox mostra o código técnico ao
lado de `Falha no envio` ou `Envio aguardando confirmação` quando há um comando
associado. `N8N_COMMAND_REJECTED` indica que o webhook recusou o comando;
verifique destino e autenticação sem imprimir segredos nem reenviar o comando
com outra chave. O código só aparece na leitura autenticada da conversa; o
widget do visitante não o recebe.
Para tentativas novas, `N8N_COMMAND_HTTP_401` ou `_403` aponta para acesso
negado no webhook; `N8N_COMMAND_HTTP_404` ou `_405` aponta para a URL ou método
do endpoint publicado. Mensagens que falharam antes dessa distinção conservam
o código genérico.

HTTP `200`/`202` só confirma o comando quando o corpo contém
`accepted: true` e o mesmo `command_id`. Corpo vazio, JSON inválido ou resposta
genérica como `Workflow was started` produz `N8N_COMMAND_ACK_INVALID`;
outro identificador produz `N8N_COMMAND_ACK_MISMATCH`. Ambos preservam o
resultado como desconhecido, sem retry automático, mesmo quando replay está
habilitado. Confira o callback e o resultado externo antes de reconciliar;
não envie outra mensagem para tentar corrigir a falta de confirmação.

A preparação do WhatsApp após a aprovação do app, as verificações no ambiente
e os bloqueios restantes estão no [runbook da Inbox WhatsApp](../../runbooks/inbox-whatsapp.md).

O nó `Site - Receber mensagem do chat (MVP)` contém a opção **Custom Chat
Styling** com as cores Silmer para a página hospedada do n8n. O estilo do
widget incorporado está em
[`ops/n8n/site-chat/silmer-chat.css`](../../../ops/n8n/site-chat/silmer-chat.css).
O nó deve usar **Embedded Chat** quando o widget próprio do site estiver
publicado, pois esse modo expõe o webhook ao front. A página hospedada serve
só como prévia visual; não é o canal homologado para o repasse humano.

## Pedido pago da loja (ADR 028)

O workflow "Silmer | Loja | Checkout InfinitePay" (id `Lu5dpTCA25Fe2Xfh`) cria
o link do Checkout Integrado da InfinitePay (só Pix), recebe o webhook e
confirma o pagamento com `payment_check` (pago é `paid` com `amount` maior ou
igual ao valor do pedido). Só então chama o CRM, servidor a servidor, para
registrar o pedido pago ([ADR 028](../../adr/028-pedido-pago-da-loja-pelo-n8n.md)).
Não há WhatsApp automático ao vendedor: ele abre o pedido no CRM e atende pelo
WhatsApp dele.

```
POST {CRM}/api/v1/integrations/n8n/store-orders
```

No cloud-dev, `{CRM}` é
`https://espectro-mvp-silmer-edge-web.jicnzg.easypanel.host`. A rota responde
`404` enquanto `STORE_ORDERS_HMAC_KEY` não estiver configurada na API.

| Cabeçalho                   | Valor que o nó HTTP manda                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`             | Basic da credencial n8n → CRM que o workflow principal já usa (`CRM_AUTOMATION_CLIENT_ID`:`CRM_AUTOMATION_CLIENT_SECRET`), como credencial `httpBasicAuth`.    |
| `Content-Type`              | `application/json`                                                                                                                                             |
| `Idempotency-Key`           | O `pedido_id`, exatamente o mesmo texto do corpo.                                                                                                              |
| `X-Correlation-Id`          | O `pedido_id` também. Precisa ser um UUID (ou de 16 a 64 hexadecimais); um texto qualquer, como o id numérico da execução, volta `400 INVALID_CORRELATION_ID`. |
| `X-Silmer-Workflow-Key`     | `silmer-loja-checkout-infinitepay` (texto fixo, até 128 caracteres, sem espaço nas pontas).                                                                    |
| `X-Silmer-Workflow-Version` | Rótulo fixo da versão do workflow, até 64 caracteres, como `loja-checkout-1`; troque a cada versão publicada.                                                  |
| `X-Silmer-Execution-Id`     | `{{ $execution.id }}` (até 128 caracteres).                                                                                                                    |

Corpo (JSON até 16 KB; chaves do exemplo obrigatórias, exceto `entrega`;
nenhuma outra aceita):

```json
{
  "schema_version": "1.0",
  "pedido_id": "<uuid v4 do site = order_nsu da InfinitePay>",
  "numero_loja": "LJ-<8 primeiros hexadecimais do pedido_id, em maiúsculas>",
  "teste": false,
  "produto": { "slug": "camisa-masculina-lisa" },
  "item": {
    "cor_id": "preta",
    "tamanho_id": "m",
    "quantidade": 10,
    "prazo_dias": 10
  },
  "valor_centavos": 18000,
  "cliente": { "nome": "<nome>", "telefone": "55<DDD><número>" },
  "entrega": { "tipo": "envio", "cep": "69301-000" },
  "pagamento": {
    "gateway": "infinitepay",
    "forma": "pix",
    "transaction_nsu": "<transaction_nsu do payment_check>",
    "invoice_slug": "<invoice_slug do payment_check>",
    "valor_pago_centavos": 18000,
    "pago_em": "2026-10-09T19:40:59Z",
    "receipt_url": "<receipt_url da InfinitePay> ou null"
  }
}
```

- `cor_id`: `branca` (prazo 0, pronta entrega), `chumbo` ou `preta` (prazo
  10). `tamanho_id`: `pp`, `p`, `m`, `g`, `gg`, `eg`, `xg`, `xx`, `jeg`.
- `valor_centavos` é 18000; 100 só com `teste: true` num CRM com
  `STORE_ORDERS_ACCEPT_TEST=true`. `valor_pago_centavos` é o `amount` pago,
  maior ou igual ao valor.
- `pago_em` em ISO 8601 UTC com `Z`, até 5 minutos à frente do relógio do CRM
  e até 30 dias atrás. `telefone`: E.164 brasileiro sem `+`.
- `receipt_url`: `null` ou `https://` em `infinitepay.io`, `*.infinitepay.io`,
  `infinitepay.com.br` ou `*.infinitepay.com.br`, sem porta nem credencial.
- `entrega`: enviar apenas quando `entrega_tipo` da loja for `envio`, com o
  CEP coletado no checkout no formato `00000-000`. Omitir para retirada.
  O CRM grava em Observações do pedido: `Dados de envio — CEP: 69301-000.
Entrar em contato para pegar as informações de entrega.` O CEP fica na
  ficha criptografada, sem aparecer no recibo de idempotência ou na auditoria.

Respostas:

| Status | Quando                                                                                                                                                                                            | O que o workflow faz                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `201`  | Pedido criado.                                                                                                                                                                                    | Segue; guarda `numero`, `pedido_url`.                                        |
| `200`  | Já existia com os mesmos dados — ou só com outro `pagamento.pago_em` (o pedido mantém o primeiro; `LOJ-37`) —; ou o `receipt_url` que faltava foi gravado agora (`comprovante_registrado: true`). | Segue. Reenviar é seguro.                                                    |
| `400`  | `INVALID_REQUEST`, `UNKNOWN_REQUEST_FIELD`, `UNSUPPORTED_SCHEMA_VERSION`, `INVALID_STORE_NUMBER`, `INVALID_RECEIPT_URL`, `INVALID_PAID_AT`, `INVALID_CUSTOMER`, cabeçalhos inválidos.             | Não repetir igual: corrigir o nó. O Pix já foi pago — avisar uma pessoa.     |
| `401`  | Credencial ausente ou errada.                                                                                                                                                                     | Conferir a credencial; avisar uma pessoa.                                    |
| `403`  | `FORBIDDEN_AUTOMATION_ACTION`: credencial sem a ação `store.order.record`.                                                                                                                        | Avisar uma pessoa.                                                           |
| `404`  | Rota desligada (sem `STORE_ORDERS_HMAC_KEY`) ou CRM sem a versão nova.                                                                                                                            | Avisar uma pessoa.                                                           |
| `409`  | `STORE_ORDER_CONFLICT`: mesmo `pedido_id` com outros dados ou outro comprovante, ou `transaction_nsu` de outro pedido.                                                                            | Não repetir: avisar uma pessoa.                                              |
| `422`  | `STORE_CATALOG_MISMATCH`, `AMOUNT_BELOW_PRICE`, `TEST_REFUSED`, `PAYMENT_METHOD_UNSUPPORTED`. Nada é gravado.                                                                                     | Não repetir: o site, o n8n ou o catálogo do CRM divergem. Avisar uma pessoa. |
| `429`  | `RATE_LIMITED` (60 chamadas por minuto), com `Retry-After`.                                                                                                                                       | Repetir a mesma chamada depois do `Retry-After`.                             |
| `5xx`  | `503 SERVICE_UNAVAILABLE` (com `Retry-After`) ou CRM fora do ar.                                                                                                                                  | Repetir a mesma chamada com espera crescente; persistindo, avisar.           |

Resposta de sucesso:

```json
{
  "numero": "37-CRM",
  "numero_loja": "LJ-5B0C77ED",
  "pedido_id": "<id do pedido no CRM, diferente do pedido_id do site>",
  "criado": true,
  "comprovante_registrado": false,
  "pedido_url": "<APP_BASE_URL>/pedidos/<id>",
  "ficha_url": "<APP_BASE_URL>/api/v1/orders/<id>/print?download=1"
}
```

**Reenvio com outro `pago_em` (ADR 031, `LOJ-37`, emenda o `LOJ-17`).** O
`/status` do workflow chama `store-orders` assim que vê o pedido pago, em
paralelo ao webhook `/infinitepay`, e cada execução carimba o próprio
`pagamento.pago_em`. Duas chamadas do mesmo `pedido_id` que diferem **só**
nesse instante são o mesmo pedido: `200`, o mesmo `numero`, e o CRM mantém o
`pago_em` da primeira. Qualquer outra diferença (produto, cor, tamanho,
valores, cliente, `entrega.cep`, `transaction_nsu`, `invoice_slug`) continua `409
STORE_ORDER_CONFLICT`, que é erro permanente no workflow.

**Código do pedido para o site (`codigo_crm`).** O `numero` da resposta
(`NN-CRM`) é o código que o cliente vê. O `/status` do workflow passa a
devolvê-lo ao site como `codigo_crm` (guardado em `loja_pedidos.crm_numero`).
Isso é do workflow; o contrato do CRM não muda (ADR 031). O aviso no
Dashboard do CRM é consequência de o pedido ser criado: não há chamada de
"notificação" separada.

Sem `APP_BASE_URL` na API, as duas URLs voltam relativas (`/pedidos/<id>`).
As duas exigem sessão do CRM: quem abre sem sessão entra e volta ao pedido.
Erros vêm em `application/problem+json` (`error.code`), sem eco do corpo. Toda
resposta diferente de `2xx` é falha visível no workflow (RULES técnica 6): o
dinheiro já entrou, então o pedido não pode sumir em silêncio.

## Workflow e configuração

- Workflow: `k7tI6T4RhQPyJkn9` — `Silmer | Atendimento WhatsApp IA`.
- Workflow DEV: `0S5ZS1xeDCSoWovs` — `DEV | Silmer | Fluxo completo sem
WhatsApp`. Ele deriva da mesma definição do MVP, recebe eventos sintéticos por
  `silmer/dev-mvp-flow`, usa a API real do CRM e simula apenas os dois envios
  pelo WhatsApp. O webhook CRM→n8n isolado é `silmer/dev-panel-command`. A
  versão DEV aceita `scenario: message`, `handoff`, `send_unknown` e
  `delivery_status`; o cenário só muda o envelope sintético, nunca grava dados
  diretamente no PostgreSQL. Além do webhook, há um **Chat Trigger** hospedado,
  restrito ao usuário autenticado do n8n. Ele atravessa o mesmo caminho CRM → IA
  → handoff/reserva → callback simulado e mostra a resposta no chat. A identidade
  WhatsApp sintética deriva do `sessionId` do Chat Trigger. Recarregar pode
  limpar o histórico visível sem trocar esse identificador: nesse caso, o CRM
  continua a conversa anterior. Para isolar um novo teste, use outra sessão do
  navegador ou o webhook DEV com um `wa_id` sintético inédito; não interprete
  uma janela vazia como conversa nova. O resultado do webhook DEV devolve
  `route` (`ai_reply`,
  `handoff` ou `no_action`), `trigger`, `handoff_reason`, `turn`, o
  `briefing_patch` da rodada, `open_order` e a resposta `order` do CRM (ADR
  014), para testes automatizados de conversa.
- Baseline preservada: `98f96069-ede2-4900-aa5c-7fec0d3b80cb`.
- Rascunho simplificado validado: `fae803db-eef0-4074-a7ae-1a6bb786e203`,
  com 42 nós e sem avisos estruturais.
- O snapshot sanitizado permanece inativo. O workflow operacional foi ativado
  em 15/10/2026; o teste sintético do chat do site recebeu resposta após o
  vínculo da credencial n8n → CRM. O teste de resposta humana pelo CRM em
  15/10/2026 falhou porque o worker apontava para o webhook DEV com uma
  credencial diferente da vinculada ao workflow publicado; o repasse ao widget
  aguarda alinhamento do destino e da autenticação. A homologação completa de
  CP-T04 no canal ainda exige repetição, troca de assunto, dois pedidos ativos
  e retomada em outro ciclo.
- Vendedores do piloto: o nó `Montar contexto da IA (MVP)` usa a lista
  `sellers` do inbound. Diante de um CRM sem o BOT-03, ele lê os primeiros nomes
  da variável `SILMER_PILOT_SELLERS` do n8n, separados por vírgula, e conta o
  teto pelas mensagens do cliente. Os nomes não entram no repositório.
- São necessárias duas credenciais Basic distintas: n8n → CRM e CRM → n8n.
- O n8n 2 bloqueia `$env` nos nós por padrão (`N8N_BLOCK_ENV_ACCESS_IN_NODE`).
  Na implantação, o DEV e o principal gravam a URL do cloud-dev
  (`https://espectro-mvp-silmer-edge-web.jicnzg.easypanel.host`) direto nos
  nós do CRM; o snapshot do repositório mantém `$env.SILMER_PANEL_BASE_URL`.
  Troque a URL nos nós quando o CRM definitivo tiver domínio. Pelo mesmo
  motivo, o principal implantado grava no nó `WhatsApp - Enviar texto humano
(MVP)` o ID do número de origem (o da conta Silmer no WhatsApp Manager), no
  lugar de `$env.SILMER_WHATSAPP_PHONE_NUMBER_ID`.
- Segredos não entram em export, repositório, log, chat ou Data Table.
- Persistência de execuções manuais/sucesso e progresso deve ficar desabilitada;
  falhas são sanitizadas e têm expurgo técnico em até 30 dias.

Gere o snapshot sanitizado da variante DEV com
`npm run generate:n8n-dev-workflow` e a variante localhost com
`npm run generate:n8n-local-workflow`. Para preparar um JSON importável a partir
de um export autenticado do workflow principal, execute
`node ops/n8n/workflows/create-dev-test-workflow.mjs <origem.json>
<destino.json> --deployment`. O arquivo de implantação preserva credenciais não
WhatsApp já vinculadas e referencia, somente por nome, as duas credenciais
Basic DEV. **O importador CLI do n8n não resolve referências que contêm apenas
o nome da credencial**: antes de importar o workflow operacional, vincule o ID
da credencial n8n → CRM existente em todos os nós `CRM -` com
`node ops/n8n/bind-crm-credential.mjs <export.json> <preparado.json>
<id-da-credencial>`. O ID aparece na URL da credencial no n8n. O script exige
autenticação Basic nesses nós, preserva os demais vínculos e recusa um ID
divergente. Importe apenas `<preparado.json>`, publique o workflow e reinicie o
serviço n8n para a nova versão entrar em execução; confira que todos os nós
`CRM -` exportados têm `credentials.httpBasicAuth.id` antes de testar o canal.
Nenhum segredo ou ID de credencial deve ser salvo no repositório.

### Loop local completo

`npm run dev` inicia um n8n em `127.0.0.1:5678`, com banco PostgreSQL e volume
próprios, sem acesso ao PostgreSQL do CRM. Ele importa uma única vez o workflow
`LOCAL | Silmer | Fluxo completo sem WhatsApp`, que expõe
`/webhook/silmer/local-mvp-flow` e `/webhook/silmer/local-panel-command`. O
container alcança a API local por `host.docker.internal`; o worker local alcança
o webhook por loopback. HTTP só é aceito neste caminho quando
`APP_ENV=development`, a opção explícita está ativa e o host é `localhost`,
`127.0.0.1` ou `::1`; qualquer endpoint operacional continua exigindo HTTPS.

Na primeira execução, crie o proprietário do n8n, vincule a credencial OpenAI
local ao nó `OpenAI - Modelo do MVP` e ative o workflow. A autenticação n8n →
CRM é um header Basic efêmero gerado pelo processo local; a autenticação CRM →
n8n continua sendo enviada pelo worker, mas o webhook local não a valida porque
está publicado apenas no loopback. Isso é uma conveniência de desenvolvimento,
não um substituto das duas credenciais Basic distintas dos ambientes DEV ou
operacionais. A importação não é repetida automaticamente para não apagar a
credencial OpenAI local.

O n8n remoto precisa alcançar `SILMER_PANEL_BASE_URL`; uma API executada apenas
em `127.0.0.1` não é acessível pelo host remoto. Para testar uma branch local
sem o loop acima, use um endpoint HTTPS temporário autorizado ou um ambiente
DEV publicado e aponte o worker do CRM para
`/webhook/silmer/dev-panel-command`.

## Rollout e recuperação

O CRM sempre aceita um campo novo do `briefing_patch` antes de o workflow
enviá-lo, porque uma chave desconhecida volta como `400`. Para o `collar` da
ADR 012, o CRM com o campo vai ao cloud-dev antes do workflow `mvp-simple-7`
(DEV `dev-mvp-simple-8`). Pelo mesmo motivo, o CRM que aceita `open_order`
(ADR 014) vai antes do workflow `mvp-simple-11` (DEV `dev-mvp-simple-12`); o
workflow anterior continua funcionando com o CRM novo, que ainda aceita
`order.intent_confirmed`. O workflow `mvp-simple-12` (DEV
`dev-mvp-simple-13`, ADR 024) não muda o contrato e não tem ordem de
implantação: `product_type` e o valor `NAO APLICAVEL` da gola já eram aceitos.
O CRM que aceita `audiences` no `briefing_patch` e lê a divisão por público
(ADR 025) vai ao ambiente **antes** do workflow `mvp-simple-13` (DEV
`dev-mvp-simple-14`), que envia o campo; um CRM antigo recusa a chave com
`400`, e a resposta do bot não sai. O workflow anterior continua funcionando
com o CRM novo. O workflow `mvp-simple-14` (DEV `dev-mvp-simple-15`, ADR 026)
não muda o contrato e não tem ordem de implantação: imagem, áudio, documento,
vídeo e texto já eram tipos aceitos.
O CRM que implementa CP-T04, CP-T05 e CP-T06, inclusive as migrations `0038` a
`0040` e a consulta de mensagens do site, deve ser implantado e verificado
**antes** do workflow `mvp-simple-15`. O fluxo anterior permanece publicado até
esse gate. Depois, homologar em ambiente real os cenários de replay, dois
Pedidos ativos, troca de Assunto, retorno em outro ciclo, nome/telefone e
resposta humana do CRM chegando ao mesmo widget.
O workflow `mvp-simple-16` (DEV `dev-mvp-simple-16`) aceita
`metadata.site_message_at` do widget e deve ser publicado **antes** da versão
do site que passa a enviá-lo. Ele mantém fallback para clientes antigos; não
exige migração no CRM.
O workflow `mvp-simple-17` (DEV `dev-mvp-simple-17`) interrompe a IA e os
efeitos externos quando o CRM responde `duplicate: true` a um inbound. No chat
do site, o reenvio recebe uma confirmação breve. Publique esta revisão antes
de liberar o widget que reenvia o mesmo ID e instante; confirme com duas
requisições idênticas ao webhook, separadas no tempo, e uma única mensagem no
CRM.
O workflow `mvp-simple-18` (DEV `dev-mvp-simple-18`) exige alvo inequívoco
também quando há um Pedido pendente e outro confirmado. Sem vínculo da mensagem,
seleção humana ou número de Pedido explícito, ele transfere sem atualizar o
briefing. Um número confirmado ou que conflita com a seleção humana também
transfere; não redireciona silenciosamente para o único pendente. O teste do
contrato cobre esses casos antes da publicação e a homologação do canal deve
repeti-los após publicar a versão.

Em 15/10/2026, a versão `mvp-simple-18` foi publicada no workflow de produção.
Um POST sintético ao webhook do chat retornou `200` com resposta da IA; repetir
o mesmo `message_id` e corpo retornou `200` com confirmação breve, sem novo
inbound nem segunda resposta da IA na Inbox. O repasse humano CRM→site foi
retomado após corrigir `N8N_COMMAND_CLIENT_ID` no novo contêiner do worker:
uma chamada do próprio worker com comando vazio recebeu `400`, indicando que
a autenticação Basic passou. O operador confirmou que a resposta sintética
`QA-1510-06` saiu da Caixa de Entrada sem aviso de falha e apareceu uma única
vez no mesmo chat. Isso valida replay do chat e resposta humana por texto, mas
não substitui a homologação de dois Pedidos ativos, troca de Assunto e retomada
em outro ciclo no canal real. Não registrar o segredo nem repetir mensagens
anteriores marcadas como falhas sem reconciliação.

Na mesma data, uma sessão sintética do chat iniciou o Pedido `06-CRM` de 12
camisetas brancas. Ao receber "Agora quero outro pedido de bonés, separado das
camisetas", o agente transferiu para um vendedor sem alterar a Ficha: ela
continuou com apenas as camisetas, brancas e quantidade informada 12. Outra
sessão sintética abriu o Pedido `07-CRM` de 10 ecobags azuis. Repetir o mesmo
`site_message_id`, instante e corpo retornou `200` com "Recebi a sua
mensagem!"; a Inbox manteve uma única mensagem de entrada, uma resposta da IA
e um único Pedido nesse ciclo.

O ciclo do `07-CRM` foi encerrado com o Pedido pendente. Uma nova mensagem da
mesma sessão pedindo "outro pedido" abriu outra Conversa e foi transferida sem
criar Pedido nem alterar o `07-CRM`. Após encerrar esse atendimento sem Pedido,
uma nova mensagem, agora com pedido explícito de 20 bonés pretos, abriu outro
ciclo e criou o Pedido `08-CRM` para o mesmo Contato. O CRM mostrou ambos
pendentes e separados: `07-CRM` com ecobags azuis, quantidade informada 10;
`08-CRM` com bonés pretos, bordado e quantidade informada 20. O vendedor
vinculou o `07-CRM` como segundo Assunto da nova Conversa, tornando-o o
Assunto selecionado. A mensagem "Sobre o pedido 08-CRM, mude a quantidade de
bonés para 30 unidades" entrou em conflito com essa seleção. O agente
transferiu sem patch; as duas Fichas permaneceram com quantidades informadas
10 e 20, respectivamente. Isso cobre no chat do site replay, troca de
intenção, dois Pedidos ativos, seleção humana conflitante e retomada em outro
ciclo. O telefone do site permaneceu marcado como informado e não confirmado;
editar pelo agente um Pedido de ciclo anterior ou homologar o WhatsApp exige
confirmação da posse do número no canal aprovado.

Na ativação de 15/10/2026, a importação pelo CLI e o comando
`n8n publish:workflow` deixaram o workflow marcado como ativo, mas o webhook
do chat respondeu `404`. A publicação da versão importada em **Version
history → Current changes → Actions → Publish version** registrou novamente
os webhooks. Antes de liberar o site, confira o POST de produção do chat e o
POST sem credenciais do comando do painel: o primeiro deve chegar ao workflow;
o segundo deve responder `401`, comprovando que a rota existe e exige Basic.
Não trate `active: true` no export como prova de disponibilidade das rotas.

A versão `mvp-simple-17` foi publicada e duas chamadas com o mesmo
`site_message_id` e `site_message_at` retornaram `200`: a primeira com a
resposta da IA e a segunda somente com `Recebi a sua mensagem!`. O CRM exibiu
uma única mensagem do cliente e uma única resposta da IA. O site com horário
estável foi publicado em [silmer-web#23](https://github.com/romulosutil/silmer-web/pull/23).
Esse teste não substitui a homologação do repasse humano nem a do WhatsApp real.

1. Aplicar migrações com a integração desligada.
2. Implantar API e worker, configurar as duas credenciais Basic e conferir o
   destino e a autenticação do webhook de comandos do painel no worker.
3. Testar o workflow inativo com dados sintéticos e o número Meta de homologação.
4. Homologar inbound → contexto → IA/handoff → reserva → Meta → status.
5. Publicar o workflow, transferir o webhook da Meta e desabilitar a entrada direta.

Rollback pausa ou despublica o workflow e preserva mensagens, comandos e itens
incertos para reconciliação. A rota direta não é reativada automaticamente.

## Diagnóstico rápido

- erro ao carregar o resumo da transferência na Inbox: a API deve ler os
  resumos sem Deal com `N8N_INTEGRATION_ENVELOPE_KEY`, a mesma chave usada na
  gravação n8n. `HANDOFF_ENVELOPE_KEY` pertence ao handoff humano legado com
  Deal. Não igualar ou rotacionar chaves para contornar o erro; implantar a
  correção INBOX-HANDOFF-01-FIX na API, preservando os envelopes existentes.
- `401/403`: conferir credencial e capacidade do `AUTOMATION_EXECUTOR`.
- `409 STALE_AUTOMATION_FENCE`: a pessoa assumiu, chegou mensagem nova ou a
  revisão já foi respondida; não enviar.
- `409 SUBJECT_TARGET_REQUIRED`: o assunto atual não corresponde ao único
  pendente que o workflow antigo conhece, ou há vários pendentes na conversa.
  Não enviar nem repetir a mesma decisão; encaminhar para revisão humana até
  o workflow usar identificadores explícitos de Assunto e Pedido (CP-T04).
  Um handoff sem `briefing_patch` nem `open_order` continua permitido.
- `send_authorized: false`: replay; não chamar a Meta novamente.
- `message.send.unknown`: reconciliar pelo `command_id` antes de qualquer ação.
- `order.opened: false` na reserva ou no handoff: o Pedido pendente não abriu,
  mas a resposta saiu e o handoff aconteceu. O workflow registra
  `workflow.failed` com `ORDER_OPEN_FAILED`; onde ver e o que fazer estão no
  [runbook do ator técnico](../../runbooks/automation-executor.md).
- mídia em quarentena/indisponível: abrir handoff e não afirmar que os bytes
  foram recuperados.
- bot pedindo para o cliente escrever depois de um áudio ou imagem: a mídia
  não foi lida; ver o erro em `WhatsApp - Consultar mídia`, `Baixar mídia`,
  `Preparar mídia para a IA` ou `OpenAI - Transcrever áudio`.
- `422 site_chat_media_unsupported` no comando humano: o chat do site ainda
  entrega somente texto do vendedor. Responder por texto na caixa de entrada.

As próximas telas e a ordem de entrega estão em
[`docs/roadmap/PROXIMAS-FASES.md`](../../roadmap/PROXIMAS-FASES.md).

## AGENTE-OBS-03 — Coleta operacional de turnos (04/11/2026)

O export vivo ainda não continha a telemetria VND-L03 nos nós da jornada.
O [runbook de turnos por versão](../../runbooks/agente-turnos-versao.md)
registra a causa, o overlay mínimo e sua verificação. O gerador Evolution
passa a preservar a versão da fonte. Esta correção não equivale à implantação
integral da VND-L03 nem das melhorias de conversa da PR #280.

## CHAN-WA-01 — Atualização de 27/10/2026

A [ADR 044](../../adr/044-atendimento-comercial-concentrado-no-whatsapp.md)
supersede a qualificação no chat público descrita acima. Site/linktree
encaminham ao WhatsApp; trigger antigo termina em resposta fixa antes do
CRM/IA. Mochilas e bolsas saem da abordagem do agente. Consulte a
[auditoria](auditoria-vendedor-2026-10-27.md) para diferenças do publicado,
testes, limitações e implantação sem perder o guard de segurança adicional.

Destino de atendimento corrigido pelo proprietário: WhatsApp do CRM
`https://wa.me/5527936180599`. O telefone institucional da loja não deve ser
usado como fallback das entradas genéricas. Conservar contatos explicitamente
nomeados e o fluxo de pós-pagamento da loja na fronteira correspondente.

## VND-L05 — Triagem prioritária (06/11/2026)

`mvp-simple-23`, [ADR 063](../../adr/063-triagem-prioritaria-do-vendedor.md):
dúvidas explícitas de mínimo/viabilidade e opções de orçamento seguem ao
vendedor sem inventar catálogo, disponibilidade ou mínimo. Alternativas ficam
em notas sem substituir quantidade confirmada. Urgência inequívoca hoje/amanhã
transfere com ficha incompleta; perguntas não repetem campos preenchidos.
Mantém abertura humana, fences e contexto cifrado. Implementação preparada;
publicação no Evolution é etapa separada no [runbook](../../runbooks/vendedor-prioridades.md).

## VND-L04 — Revisão de 03/11/2026

[Revisão dos atendimentos e limites da amostra](revisao-2026-11-03.md):
35 conversas exibidas, 16 comerciais com atividade no dia. `mvp-simple-22`
prepara correções de perguntas e avisos sob as regras existentes; publicação
no n8n permanece separada. Decisões comerciais propostas e a ausência de
turnos por versão no painel estão registradas no relatório. Nunca importar
o snapshot Meta sobre o principal Evolution; aplicar delta ao export vivo.

## VND-L01 — Aprendizados da Inbox real (28/10/2026)

A [ADR 049](../../adr/049-aprendizados-do-vendedor-na-inbox-real.md) ajusta o
agente a partir de cinco conversas reais. Regras no SDK, cobertas por
`test/n8n-vendedor-aprendizados.test.js`:

- Pergunta de viabilidade ("vocês fazem…?", "conseguem fazer igual?") recebe
  "Vou anotar para o vendedor confirmar isso." antes da próxima pergunta; o nó
  de decisão acrescenta a frase quando o modelo esquece.
- Camisa de futebol, futsal, vôlei, basquete, handebol, e-sports, esportiva e
  jersey são modelos de roupa; resposta fora da lista é "outro" com as palavras
  do cliente, e a mesma pergunta não se repete com as mesmas palavras.
- A mensagem pronta "Vi no site a referência X e quero algo parecido" vira
  `notes` ("Referência do site: X") e não conta como pergunta ignorada.
- `bandeira` (faixa, banner, estandarte, flâmula) é tipo próprio: o ponto de
  modelo pergunta o tamanho, gravado em `product_model` com o nome do produto e
  exibido em `items[].tipo` da Ficha; gola `NAO APLICAVEL`.
- O contexto informa a data de hoje em Brasília pela hora da mensagem
  (`occurred_at` do evento normalizado). `needed_by` recebe a data calculada;
  data ambígua é confirmada uma vez.
- Empresa com marcador explícito de organização vai para `order_name` e para a
  Dica do resumo; perfil de compra não é deduzido.
- `BUSINESS_HOURS` (segunda a sexta 9h–18h, sábado 9h–12h, UTC−3, espelho de
  `business.ts` do site; sem feriados) acrescenta a todo aviso de transferência
  fora do horário quando o vendedor responde.

Publicado em 28/10/2026 no workflow principal: versão `799b0a92`, só os nós
"Montar contexto da IA", "Atendente virtual Silmer", "Normalizar decisão da IA"
e "Preparar handoff de conteúdo" alterados; os demais 97 nós e as conexões
conferidos iguais ao backup. Rollback: publicar a versão `a107910d`.

Armadilha do conector MCP: ao enviar parâmetros, um `\uXXXX` literal no código
chega ao n8n como o próprio caractere. Codifique a barra (`\\u005Cu200B`) e
confira o `jsCode` gravado; para rollback, prefira publicar a versão anterior.

## VND-L02 — Aprendizados com os atendentes humanos (29/10/2026)

A [ADR 051](../../adr/051-vendedor-aprende-com-os-atendentes-humanos.md) ajusta o
agente a partir de nove conversas reais e das respostas da vendedora. Regras no
SDK, cobertas por `test/n8n-vendedor-aprendizados-l02.test.js`:

- **Preço adiado.** A primeira pergunta de preço não transfere: o workflow
  responde "Quem passa o valor é o vendedor, e pra ele já te mandar o preço
  certinho me conta: …" com a próxima pergunta do ritmo e marca `price_` em
  `briefing_status` (sem chave nova no `briefing_patch`; sem pedido, o
  histórico é a reserva). A segunda transfere com `negotiation`. Ficha
  completa depois da pergunta transfere com `briefing_complete` e "Perguntou o
  valor." no resumo.
- **Arte** ("Você já tem a arte (ou logo) pronta?", sem oferecer criação) grava
  só "cliente envia a arte", "Silmer cria a arte" (pedido explícito) ou "sem
  estampa". "Não tenho" e respostas evasivas gravam "Definir com o vendedor",
  com nota e Dica; foto de referência não é arte do cliente.
- **Tecido** (só roupa sem kit) pergunta algodão, poliéster ou dry fit; o
  tecido já dito é gravado com as palavras do cliente, abaixo de 200
  caracteres; "tanto faz" e "vocês escolhem" gravam "Definir com o vendedor".
- **Rajada.** Depois de registrar o inbound, `Aguardar mensagens seguidas`
  espera 8 s e `CRM - Reler conversa` reenvia o mesmo inbound (mesma chave de
  idempotência; o CRM devolve o estado atual com `duplicate: true`). `Ainda é a
última mensagem?` só segue se `source_revision` não mudou; a execução mais
  nova responde a todas as mensagens desde a última resposta.
- **Prazo hoje ou amanhã** com ficha completa transfere com `urgency`.
- **Parceria, revenda, nota fiscal, envio direto ou fotos das peças** transfere
  com `human_requested`, aviso "Anotei suas perguntas…" e resumo com as
  perguntas em tópicos e a Dica "Possível parceria/revenda". O resumo do
  handoff aparece na conversa da Inbox desde a INBOX-HANDOFF-01.
- **Tom.** `withoutPraise` remove elogios à escolha do cliente.
- **Fechamento.** O aviso de horário vale também nos últimos 30 minutos do
  expediente (seg–sex 17h30, sáb 11h30).

Publicado em 29/10/2026 no workflow principal, já adaptado ao Evolution e às
mídias: versão `cd0de4e8`. Mudaram 6 nós ("Montar contexto da IA", "Validar
saída", "Atendente virtual Silmer", "Normalizar decisão da IA", "Preparar
handoff de conteúdo" e "Site - Responder no chat") e entraram 3 ("Aguardar
mensagens seguidas", "CRM - Reler conversa", com a mesma URL e credencial do
"CRM - Registrar inbound", e "Ainda é a última mensagem?"). Os outros 104 nós,
os settings e as conexões, exceto a religação prevista, foram conferidos iguais
ao backup; a confirmação ao provedor segue antes da espera. Rollback: publicar a
versão `8cd3ccf7`.

## VND-L03 — Vendedor mensurável e com mais contexto (30/10/2026)

Estado: **pronta, aguardando publicação.** Nada foi publicado no n8n.
A [ADR 052](../../adr/052-vendedor-mensuravel-e-com-mais-contexto.md) leva o
workflow principal a `mvp-simple-20`. Regras no SDK, cobertas por
`test/n8n-vendedor-l03.test.js`:

- **Falha vira handoff.** Erro do modelo, do parser, do agente ou da decisão
  segue a saída de erro e chega a `Preparar handoff de falha da IA (MVP)`, que
  pede `handoff.requested` com `automation_failure`, cercado pelo epoch e pela
  revisão do turno. Aviso ao cliente: "Recebi a sua mensagem! Um dos nossos
  vendedores vai continuar o seu atendimento aqui mesmo.", com o aviso de
  horário quando couber.
- **Tempos.** Modelo com timeout de 30 s e `maxRetries: 1`; transcrição com
  30 s. O pior caso, um áudio com as duas chamadas no limite, fica em cerca de
  112 s, abaixo do `executionTimeout` de 120 s.
- **Transcrição.** `Áudio não lido? (MVP)`, `CRM aceita a transcrição?
(MVP)`, `Preparar transcrição do áudio (MVP)` e `CRM - Registrar
transcrição do áudio (MVP)` mandam `message.transcribed` (ok ou falha) com
  chave fixa por mensagem, numa chamada de 5 s sem retry que não segura a
  resposta ao cliente.
- **CRM antigo.** Os campos novos só vão quando o inbound traz
  `contact_context` (seção "Campos da ADR 052"); contra um CRM antigo o bot
  continua respondendo como na `mvp-simple-19`.
- **Telemetria.** `turn` vai na reserva e nos handoffs, com latência do
  recebimento até a decisão e `media_kind`.
- **Contexto.** Histórico filtrado por `subject_ids` quando há mais de um
  Assunto; o áudio entra com o texto transcrito. Cliente recorrente
  (`contact_context` com contagem maior que zero) pode ouvir "Que bom falar
  com você de novo"; o pedido é tratado como novo.
- **Handoff.** `requested_seller_id` do vendedor pedido pelo nome. Parceria,
  revenda, atacado e nota fiscal usam `partnership`.
- **Falsos positivos corrigidos.** O próprio e-mail ou telefone do cliente,
  link de referência, "loja" sozinha e fotos das peças não transferem. Contar
  como conheceu a Silmer ou como vai responder também não: "passei pelo
  instagram", "respondo pelo celular", "gostei do atendimento pelo
  instagram". Continuam transferindo os pedidos de outro canal ("me passa os
  valores por e-mail", "prefiro falar pelo direct"). "Sim" só grava a arte
  logo depois da pergunta da arte. "Faixa etária" e "na faixa de" não são
  bandeira, e "jogo" sozinho não é modelo.
- **Pedido repetido** transfere: "repetir o pedido", "igual da última vez",
  "o mesmo do ano passado", "igual ao pedido anterior".
- **Tom e horário.** Aviso de preço sem "Ótima pergunta!". Os feriados
  nacionais de 2026 e 2027 (com Carnaval, Sexta-feira Santa e Corpus Christi)
  fecham o dia no aviso de horário. Feriados do ES e municipais não estão
  cobertos.

Mudanças sobre o snapshot anterior: 5 nós novos (95 no snapshot), que são os
quatro da transcrição e o handoff de falha. Mudam também o cabeçalho
`X-Silmer-Workflow-Version` (`mvp-simple-20`) nos nós HTTP do CRM, os nós do
Vendedor e as conexões dos nós novos e dos ramos de erro. Os settings não
mudam.

O gerador do Evolution precisa copiar os 5 nós novos e preservar
`contact_context` na resposta do `CRM - Registrar inbound` e do
`CRM - Reler conversa`; sem ele, o workflow vivo fica no modo da
`mvp-simple-19`.

Ordem de implantação: PR das migrações 0046–0048 (merge, deploy e aplicação
no console), depois PR do código, worker com as envs e só então a publicação
do workflow, como delta sobre o export vivo (Evolution). O passo a passo e o rollback estão
no [runbook da VND-L03](../../runbooks/vendedor-l03-implantacao.md).
