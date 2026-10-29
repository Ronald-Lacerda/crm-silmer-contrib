# Mídia do vendedor no chat — Tasks

Design: [design.md](design.md). Spec: [spec.md](spec.md).
Status: Executing. Tarefa guarda-chuva: INBOX-MEDIA-1.
32 tarefas planejadas; T1 a T23 e T25 a T32 concluídas; T32 homologa upload/validação/leitura no pipeline remoto interno. T24 aguarda UAT completa e envio/callback DEV remoto. Evidência em [execution.md](execution.md).

## Execution Protocol

Implementar com a skill **tlc-spec-driven**, ativada por nome, seguindo Execute
e suas Critical Rules. Se não puder ativá-la, parar e informar o usuário.
Cada tarefa: critérios → testes da spec → gate → marcar conclusão → commit
atômico. Push segue autorização vigente e AGENTS.md. Publicação, criação de
acesso e deploy exigem escopo explícito no momento da execução; planejamento
não executa infraestrutura. Nunca gerar ou atualizar Graphify localmente.
Docker local foi autorizado explicitamente pelo usuário para desenvolvimento e testes.

Após a última tarefa, Verifier independente obrigatório, com evidência por AC
e sensor de discriminação em scratch isolado; validation.md não é criado vazio.
Se houver achados, criar tarefas de correção e repetir no limite da skill.
As quatro fases originais têm seis tarefas; a fase 4 inclui T25 solicitada
durante UAT, T26 decorrente da revisão independente, T27 de recuperação, T28/T29 de desempenho, T30 do CI e T31 do edge, passando a treze tarefas. Na execução, oferecer delegação conforme a
skill antes de despachar workers. Arquivos têm um único dono por tarefa.

## Test Coverage Matrix

Gerada do código, CONTRIBUTING.md, AGENTS.md, package.json,
.github/workflows/ci.yml, spec.md e amostras de test/private-media-volume.test.js,
test/conversation-routes.test.js, test/inbox-domain.test.js,
test/inbox-postgres-live.test.js, test/n8n-command-store-postgres-live.test.js,
test/n8n-dev-workflow.test.js e test/e2e/crm-ui.spec.js.
Matriz proposta para confirmar antes de Execute; testes não imitam o patch.

| Code Layer                 | Required Test Type       | Coverage Expectation                                                   | Location Pattern                                  | Run Command                         |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| Domínio/validação/codec    | unit                     | Cada AC e cenário negativo da camada; bytes, codec e estados reais     | test/*.test.js                                    | rtk npm test                        |
| Storage/worker             | unit + integration       | Contrato S3, PUT/DB incerto, scanner, range, cleanup e quota           | test/*.test.js; smoke isolado                     | rtk npm test; smoke T1              |
| API humana/técnica         | integration              | Happy + 401/403/409/413/416/422/429/503; sessão/CSRF e comando         | test/*routes.test.js                              | rtk npm test                        |
| PostgreSQL/repositório     | integration live         | Constraint, rollback, concorrência, CAS, replay; banco dedicado        | test/*postgres-live.test.js                       | Full com TEST_DATABASE_URL validada |
| Workflow n8n               | unit + integration       | Render/contrato e DEV com busca de bytes, callbacks, epoch e unknown   | test/n8n-*.test.js                                | rtk npm test; DEV T15               |
| UI/recorder                | e2e + axe                | Teclado/foco, seleção, playback, permissão, limites, troca de conversa | test/e2e/*.spec.js                                | rtk npm run test:e2e                |
| Documentação/config/schema | structural + integration | Contratos e gates existentes; migration executada em banco dedicado    | validadores existentes e test/migrations*.test.js | Build e Live                        |

## Gate Check Commands

Comandos extraídos do projeto. Comandos novos de smoke/integração devem ser
adicionados ao manifest na própria tarefa e identificados como novos.

| Gate Level | When to Use                           | Command                                                                                                                                                                                    |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quick      | Tarefa de domínio/adapter             | rtk npm test                                                                                                                                                                               |
| UI         | Componente ou integração de interface | rtk npm run test:e2e                                                                                                                                                                       |
| Live       | Migration/repositório                 | rtk proxy node --test --test-concurrency=1 test/migrations-live.test.js test/inbox-postgres-live.test.js test/n8n-command-store-postgres-live.test.js; incluir novos testes live da tarefa |
| Full       | API/workflow e fases de integração    | Quick + UI + Live quando altera SQL                                                                                                                                                        |
| Build      | Fim de fase e entrega                 | rtk npm run validate; rtk npm run test:e2e; rtk npm audit --audit-level=high; rtk git diff --check                                                                                         |
| Topology   | Storage/imagem/recovery               | rtk npm run validate:topology; rtk npm run test:recovery:mocks                                                                                                                             |
| Privacy    | Retenção/catálogo                     | rtk npm run validate:security-catalog; rtk npm run test:security-catalog; rtk npm run validate:media-retention                                                                             |

Live exige TEST_DATABASE_URL de banco crm_silmer_test dedicado, sem dados reais.
Não registrar PASS quando testes live não forem executados por falta de variável.
Containers e ferramentas de scanner/codec podem rodar no Docker local ou CI.
Contagem existente é capturada antes de cada tarefa; mínimos abaixo
são cenários novos planejados, não resultados de testes já executados.

## Execution Plan

Fases sequenciais. Dependências são de dados/contrato, não decoração do diagrama.
Dentro de cada fase, seguir dependências; T25 é uma correção posterior à
implementação e antecede o fechamento T24, preservando os IDs históricos.

### Phase 1: Storage e pipeline

T1..T6: comprovar RustFS, schema, adapter, validação, codec e processamento.

### Phase 2: API e envio transacional

T7..T12: upload, status, bytes, vínculo, validação de envio e outbox.

### Phase 3: Integração e composição

T13..T18: bytes técnicos, workflow, DEV, DTO, cliente HTTP e composer.

### Phase 4: Gravação, histórico e fechamento

T19..T23, T25, T26, T27, T28, T29, T30, T31, T32, T24: recorder, playback, integração Inbox, limpeza, rollout,
correção UX, recuperação de recusa conhecida e UAT.

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9 -> T10 -> T11 -> T12
T12 -> T13 -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20 -> T21 -> T22 -> T23 -> T25 -> T26 -> T27 -> T28 -> T29 -> T30 -> T31 -> T24
T23 -> T32 -> T24
```

## Task Breakdown

### Phase 1: Storage e pipeline

### T1: Runbook e smoke de compatibilidade RustFS

**What**: Definir e executar smoke isolado na versão instalada, antes de ativar mídia.
**Where**: docs/runbooks/rustfs-chat-media.md
**Depends on**: None
**Requirement**: MED-16, MED-19, MED-23
**Reuses**: Inspeção context.md; padrão de smoke R2 sem presumir equivalência.
**Tools**: tlc-spec-driven; Browser somente leitura; shell/Docker local para smoke autorizado.
**Done when**: [x] PUT/HEAD/GET/Range/DELETE e negativas de canário sintético passam na mesma versão configurada (alpha.99), em ambiente local isolado autorizado; bucket CRM isolado de hermes-backups; digest real do teste registrado; nenhuma alteração silenciosa do RustFS. Ativação e digest do deployment remoto permanecem gates de T23. Smoke real com HEAD/GET de objeto sintético conhecido negados e 10 testes do harness passaram; [evidência](execution.md#t1-compatibilidade-rustfs).
**Tests**: integration; mínimo 6 cenários de compatibilidade/negativa, sem objetos reais.
**Gate**: Topology e smoke explícito documentado; criação de credencial/bucket sob autorização de acesso vigente.
**Commit**: docs(storage): define rustfs chat media activation gate

### T2: Schema persistente de mídia e job de processamento

**What**: Criar migration expand de chat_media com vínculo único e payload de job compatível.
**Where**: modules/database/migrations/NNNN_chat_media.expand.sql
**Depends on**: T1
**Requirement**: MED-05, MED-15, MED-27, MED-28
**Reuses**: Migrations publicadas, FK de messages e jobs PostgreSQL; escolher próximo número real.
**Tools**: tlc-spec-driven; shell e banco dedicado Docker local/CI.
**Done when**: [x] Migration aplica duas vezes sem duplicar; constraints rejeitam vínculo duplicado; mídia attached não entra no sweeper transitório; modelo separa quota/rascunho. Oito cenários SQL live passaram; gates Live19/19 e Build verdes; [evidência](execution.md#t2-schema-persistente).
**Tests**: integration live; mínimo 6 casos, em testes co-localizados na entrega.
**Gate**: Live + Build; versões de migrations antigas preservadas.
**Commit**: feat(media): add retained chat media schema

### T3: Adapter privado do RustFS

**What**: Implementar operações S3 necessárias em streaming com chaves opacas e erros sanitizados.
**Where**: modules/integration-reliability/src/rustfs-media-store.js
**Depends on**: T2
**Requirement**: MED-15, MED-17, MED-19, MED-20
**Reuses**: Contrato verificado T1, hash/limites de private-media-volume; cliente S3 fixado.
**Tools**: tlc-spec-driven; shell; documentação oficial.
**Done when**: [x] PUT/HEAD/read/Range funcionam; timeout e missing distinguíveis; nenhuma chave/root/URL pública em DTO ou log. Nove testes unitários e ciclo real SDK alpha.99 passaram; evidência em execution.md.
**Tests**: unit + integration; mínimo 8 casos, incluindo streaming e falha parcial.
**Gate**: Quick + smoke T1; audit de dependência no Build.
**Commit**: feat(media): add private rustfs adapter

### T4: Validador de uploads de mídia

**What**: Validar allowlist, tamanho, MIME real, codec e legenda conforme a spec.
**Where**: modules/integration-reliability/src/chat-media-validation.js
**Depends on**: T3
**Requirement**: MED-01..04, MED-26, MED-29
**Reuses**: ClamAvMediaScanner, limites n8n-routes e libmagic.
**Tools**: tlc-spec-driven; scanner/ffprobe em Docker local/CI.
**Done when**: [x] Cada formato permitido tem fixture real válida; disfarce MIME, codec inválido, malware e assinatura stale impedem ready/envio.16 unitários e um runtime real (seis formatos, capaMP3, Chromium streaming, MIME/codec/EICAR) passaram; [evidência](execution.md#t4-validação-de-mídia).
**Tests**: unit + integration; mínimo 12 casos positivos, fronteira e negativos.
**Gate**: Quick + fixtures reais no runtime; Build.
**Commit**: feat(media): validate upload formats and codecs

### T5: Normalizador de áudio gravado

**What**: Converter gravação suportada para OGG/Opus mono com limites de recurso.
**Where**: modules/integration-reliability/src/recorded-audio-normalizer.js
**Depends on**: T4
**Requirement**: MED-04, MED-12, MED-14, MED-26, MED-29
**Reuses**: execFile e scanner; imagem runtime existente recebe FFmpeg/ffprobe como suporte da entrega.
**Tools**: tlc-spec-driven; Ubuntu/CI para encoder.
**Done when**: [x] WebM/Opus, OGG/Opus e MP4/AAC viram saída validada; entrada vazia, >300s, >16MiB e timeout falham; intermediários são removidos. Dez unitários, quatro de refresh, header enganoso e runtime real (300 s aceitos, 301 s rejeitados) passaram; imagem e assinaturas genuínas comprovadas. [Evidência](execution.md#t5-normalização-de-gravações-e-assinaturas).
**Tests**: unit + integration; mínimo 8 casos com arquivos sintéticos reproduzíveis.
**Gate**: Quick + Topology + Build; medir CPU/memória/timeout.
**Commit**: feat(media): normalize recorded audio for delivery

### T6: Worker de processamento de mídia

**What**: Processar chat_media com CAS, scan/codec, PUT e publicação de ready.
**Where**: modules/integration-reliability/src/chat-media-process-worker.js
**Depends on**: T5
**Requirement**: MED-14, MED-19, MED-26, MED-28, MED-29
**Reuses**: Jobs PostgreSQL e composição apps/worker/src/worker.js; suporte de wiring no mesmo commit.
**Tools**: tlc-spec-driven; shell/banco dedicado.
**Done when**: [x] Duas execuções do mesmo job produzem uma variante; PUT/DB incerto reconcilia; quota/concorrência limitadas; scanner falha fechado.
**Tests**: unit + integration live; mínimo 8 cenários, incluindo crash após PUT e rollback.
**Gate**: Quick + Live + Build.
**Commit**: feat(media): process chat media with existing worker

### Phase 2: API e envio transacional

### T7: Endpoint humano de upload

**What**: Receber um multipart autenticado e reservar quota/upload idempotente sem assumir conversa.
**Where**: apps/api/src/chat-media-upload-routes.js
**Depends on**: T6
**Requirement**: MED-01..04, MED-06..08, MED-20, MED-26, MED-28
**Reuses**: Sessão, CSRF, ACL/ownership e multipart n8n; composição de app na entrega.
**Tools**: tlc-spec-driven; shell.
**Done when**: [x] 202 inicia processamento; replay não cria upload; 401/403/409/413/422/429/503 imediatos cobertos; formato real fica para worker/status T8; truncamento e Content-Length falso não excedem quota. 20 HTTP e 13 SQL novos, Full/Build verdes; [evidência](execution.md#t7-upload-humano-com-admissão-durável).
**Tests**: integration + unit; mínimo 12 cenários API.
**Gate**: Full + Build ao concluir fase.
**Commit**: feat(api): accept private chat media uploads

### T8: Endpoint de status da mídia

**What**: Expor estado e metadados seguros do upload para polling.
**Where**: apps/api/src/chat-media-status-routes.js
**Depends on**: T7
**Requirement**: MED-08, MED-16, MED-19, MED-20, MED-29
**Reuses**: Problem JSON, ACL e DTO da mídia.
**Tools**: tlc-spec-driven; shell.
**Done when**: [x] Rascunho só é visível ao autor/admin; attached segue ACL de leitura; invalid_format retorna 200/state=rejected; DTO nunca inclui credencial/object_key.18 cenários e identidade/sessões SQL reais, Full verde; [evidência](execution.md#t8-status-autorizado-e-erros-de-sessão).
**Tests**: integration; mínimo 6 cenários de estados/permissão.
**Gate**: Quick + Full de integração.
**Commit**: feat(api): expose authorized media processing status

### T9: Endpoint de conteúdo com Range

**What**: Servir bytes da mídia privada sob autorização por conversa.
**Where**: apps/api/src/chat-media-content-routes.js
**Depends on**: T8
**Requirement**: MED-15..19
**Reuses**: Adapter S3, autenticação e streaming Fastify.
**Tools**: tlc-spec-driven; shell.
**Done when**: [x] 200/206/416 e Content-Range corretos; 401/403 impedem bytes; media attached continua legível após oito dias/encerramento; cache privado. 18 testes de conteúdo e CAS SQL aprovados; [evidência](execution.md#t9-conteúdo-privado-com-range-e-recuperação).
**Tests**: integration; mínimo 10 casos, Range aberto/sufixo, grande arquivo e indisponibilidade.
**Gate**: Full.
**Commit**: feat(api): stream authorized chat media content

### T10: Vínculo atômico de mídia ao envio humano

**What**: Estender transação de envio para consumir uma mídia ready de uso único.
**Where**: modules/inbox-channels/src/adapters/postgres-inbox-repository.js
**Depends on**: T9
**Requirement**: MED-05..08, MED-15
**Reuses**: Lock de conversa, command_id, audit/SSE/outbox atuais.
**Tools**: tlc-spec-driven; SQL em banco dedicado.
**Done when**: [x] Mensagem/vínculo/outbox são atômicos; concorrência tem um vencedor; mesmo ID não pode ser ligado a segunda mensagem; takeover só no envio. 18 casos SQL novos e 7 regressões passaram, incluindo auditoria/outbox rollback, quota, replay e tipo/MIME/size; evidência T10 em execution.md.
**Tests**: integration live; mínimo 8 casos incluindo transferência/close durante upload.
**Gate**: Quick + Live.
**Commit**: feat(inbox): bind retained media atomically to human messages

### T11: Contrato de envio humano com mídia

**What**: Validar messageType/content e encaminhar envio à transação existente.
**Where**: modules/inbox-channels/src/application/inbox-service.js
**Depends on**: T10
**Requirement**: MED-04..08
**Reuses**: conversation-routes, versão/idempotência e ações de envio existentes.
**Tools**: tlc-spec-driven; shell.
**Done when**: [x] Aceita text/image/audio/video nos formatos definidos; proíbe key/URL arbitrários; upload não liga bot; texto conserva comportamento; OpenAPI atualizado no suporte. 18 testes unit/integration e 3 provas SQL de replay/gate/legado, Full verde; evidência T11 em execution.md.
**Tests**: unit + integration; mínimo 8 casos de payload, replay e ACL.
**Gate**: Full.
**Commit**: feat(inbox): validate human media send commands

### T12: Outbox e fence com referência imutável

**What**: Incluir media_id/hash/tipo na outbox e comparação do comando reservado.
**Where**: modules/n8n-integration/src/postgres-command-outbox.js
**Depends on**: T11
**Requirement**: MED-06, MED-20..22, MED-24
**Reuses**: comparableOutbound/assertPanelSendFence e envelopes cifrados; mudanças do fence são suporte deste contrato único.
**Tools**: tlc-spec-driven; shell/SQL.
**Done when**: [x] Payload identifica variante exata; legenda/hash/referência/MIME/tamanho divergentes não reservam; texto compatível; callbacks preservam estados monotônicos, conversa canônica e confirmação conhecida sem retry. 11 testes unit e 17 SQL T12; conjunto SQL 50/50, Full + Build verdes; evidência T12 em execution.md. T13 não iniciado.
**Tests**: unit + integration live; mínimo 8 casos incluindo hash trocado e replay.
**Gate**: Full + Build.
**Commit**: feat(n8n): carry authorized media references in outbox

### Phase 3: Integração e composição

### T13: Endpoint técnico de bytes por comando

**What**: Permitir GET de mídia somente para o comando humano reservado vigente.
**Where**: apps/api/src/n8n-command-media-routes.js
**Depends on**: T12
**Requirement**: MED-16, MED-20..22
**Reuses**: Basic AUTOMATION_EXECUTOR, capacidade nova mínima, fence e adapter.
**Tools**: tlc-spec-driven; shell.
**Done when**: [x] Identidade técnica/command_id/mídia/epoch conferidos; antes de reserva, outro comando ou conversation_id não obtêm bytes; novo GET documentado no contrato.
**Tests**: integration; mínimo 8 cenários de autorização e reserva.
**Gate**: Full.
**Commit**: feat(api): authorize automation media reads by reserved command

### T14: Workflow de envio humano de mídia

**What**: Acrescentar rota image/audio/video com download restrito, upload Meta e envio por ID.
**Where**: ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sdk.js
**Depends on**: T13
**Requirement**: MED-06, MED-21, MED-22, MED-24
**Reuses**: Reserva humana, callbacks e renderer atuais; snapshot sanitizado regenerado no mesmo commit.
**Tools**: tlc-spec-driven; shell; documentação oficial n8n/Meta.
**Done when**: [x] Reserva precede efeito; fluxo preserva bytes sem logs; contrato n8n 2.38.7 confirmado no fonte oficial; allowlist/limites/voice flag/API version Meta atuais permanecem gate externo T23 antes da ativação; resultado incerto não reenvia.
**Tests**: unit + integration; mínimo 8 cenários com fixtures Meta; homologação real permanece gate externo.
**Gate**: Quick + contrato renderizado + Full.
**Commit**: feat(n8n): send human media through official channel flow

### T15: Simulador DEV com mídia real

**What**: Adaptar fluxo DEV para buscar e validar bytes e simular apenas efeitos Meta.
**Where**: ops/n8n/workflows/create-dev-test-workflow.mjs
**Depends on**: T14
**Requirement**: MED-06, MED-21..24
**Reuses**: Variantes DEV/local e nós de reserva/callback; sem tocar sessões/workflows reais durante planejamento.
**Tools**: tlc-spec-driven; n8n DEV/ssh autorizado.
**Done when**: [x] PNG/áudio/MP4 reais exercitam success, failed, unknown, missing, replay e epoch; evidência identifica simulação; snapshots regenerados sem credenciais.
**Tests**: unit + integration; mínimo 8 cenários, incluindo hash/tamanho divergentes.
**Gate**: Quick + DEV sintético + Full.
**Commit**: feat(n8n): exercise real media bytes in dev simulation

### T16: Histórico com DTO de mídia

**What**: Projetar metadados/estado/rota autorizada na leitura de mensagens.
**Where**: modules/inbox-channels/src/adapters/postgres-inbox-read-repository.js
**Depends on**: T15
**Requirement**: MED-15, MED-19, MED-20
**Reuses**: Query/mapMessage e preview existentes.
**Tools**: tlc-spec-driven; SQL.
**Done when**: [x] DTO expõe mediaId/tipo/status/tamanho e rota CRM; histórico sem N+1 S3; SSE contém somente IDs técnicos.
**Tests**: unit + integration live; mínimo 6 casos, incluindo legado e lost.
**Gate**: Quick + Live.
**Commit**: feat(inbox): project media metadata in message history

### T17: Cliente HTTP para multipart e polling

**What**: Suportar FormData/abort/status preservando CSRF e idempotência.
**Where**: apps/edge-web/src/lib/api-client.js
**Depends on**: T16
**Requirement**: MED-04, MED-06, MED-08
**Reuses**: ApiError, commandKey e request existentes.
**Tools**: tlc-spec-driven; shell.
**Done when**: [x] FormData não recebe JSON.stringify nem Content-Type manual; request JSON continua igual; abort e problemas API mapeados.
**Tests**: unit + integration; mínimo 6 casos.
**Gate**: Quick + Full.
**Commit**: feat(web): support authenticated media upload requests

### T18: Composer de anexos

Correção T18/MED-06/25: bloqueio de POST messages pendente conserva ready e
a tentativa imutável; reabilitar permite somente retry explícito. Cenário E2E
novo comprova duas requisições com mesma chave/body/contexto, um único upload.

**What**: Criar componente de seleção/prévia/legenda e envio explícito.
**Where**: apps/edge-web/src/components/inbox/MediaComposer.vue
**Depends on**: T17
**Requirement**: MED-01..04, MED-25
**Reuses**: Tokens, semântica de forms e cliente HTTP existentes.
**Tools**: tlc-spec-driven; Browser para UI; Playwright/axe.
**Done when**: [x] Um arquivo por mensagem; só enviar após ready; erro preserva prévia; remove/reseleciona; teclado e foco verificáveis.
**Tests**: e2e + axe; mínimo 8 cenários de tipos/erro/teclado.
**Gate**: UI + Build.
**Commit**: feat(web): compose image audio and video attachments

### Phase 4: Gravação, histórico e fechamento

### T19: Recorder acessível

**What**: Capturar áudio com revisão e liberação de recursos.
**Where**: apps/edge-web/src/components/inbox/AudioRecorder.vue
**Depends on**: T18
**Requirement**: MED-09..13, MED-25
**Reuses**: MediaComposer e APIs MediaRecorder/getUserMedia.
**Tools**: tlc-spec-driven; Browser e Playwright com dispositivo sintético.
**Done when**: [x] Solicitação só por clique; MIME negociado; limite de 300s/16MiB; stop/cancel/review; tracks liberadas; permissão negada não bloqueia anexos.
**Tests**: e2e + axe; mínimo 10 casos; teste de microfone real em T24.
**Gate**: UI.
**Commit**: feat(web): record and review audio in inbox

### T20: Mensagem com prévia e reprodução

**What**: Renderizar mídia e estados no histórico com controles nativos.
**Where**: apps/edge-web/src/components/inbox/MediaMessage.vue
**Depends on**: T19
**Requirement**: MED-17, MED-19, MED-25
**Reuses**: DTO T16 e endpoint Range; tokens atuais.
**Tools**: tlc-spec-driven; Browser/Playwright/axe.
**Done when**: [x] Imagem/audio/video renderizam com autenticação; sem autoplay; Range permite seek; arquivo indisponível tem mensagem acessível.
**Tests**: e2e + axe; mínimo 6 casos, playback e seek com arquivos reais.
**Gate**: UI.
**Commit**: feat(web): render private media in chat history

Correção MED-25: [x] Aviso recebe foco quando lost/erro remove player focado;
foco externo preservado. Dois testes discriminantes e gate UI integral em execution.md.

### T21: Integrar componentes à Caixa de Entrada

**What**: Conectar anexos, recorder e histórico ao fluxo da conversa ativa.
**Where**: apps/edge-web/src/views/InboxView.vue
**Depends on**: T20
**Requirement**: MED-01..03, MED-08..13, MED-25
**Reuses**: Envio humano, eventos e controles de ownership atuais.
**Tools**: tlc-spec-driven; Browser/Playwright/axe.
**Done when**: [x] Conversa certa recebe envio; troca de conversa aborta draft/captura; close/transfer bloqueiam envio stale; estados DEV reconhecíveis; texto sem regressão.
**Tests**: e2e + axe; mínimo 8 cenários incluindo SSE e concorrência.
**Gate**: UI + Full.
**Commit**: feat(inbox): integrate media sending and audio recording

### T22: Limpar rascunhos preservando mídia enviada

**What**: Implementar worker de órfãos com lock/recheck e impedir expurgo de attached.
**Where**: modules/integration-reliability/src/chat-media-draft-cleanup.js
**Depends on**: T21
**Requirement**: MED-15, MED-27
**Reuses**: Jobs, transações e scanner cleanup; não reutilizar sweeper transitório para attached.
**Tools**: tlc-spec-driven; SQL dedicado.
**Done when**: [x] >24h sem message_id é limpável; attach concorrente vence com bytes intactos; após oito dias/encerramento jobs antigos não removem mídia nova. Intenção durável impede vínculo após DELETE/rollback; writers ativos conservam quota até fechamento; intermediários de crash pertencem ao UUID da variante.
**Tests**: unit + integration live; mínimo 8 casos de relógio e corrida.
**Gate**: Quick + Live + Privacy.
**Commit**: feat(media): clean abandoned drafts without expiring sent files

Manifest novo: `rtk npm run test:chat-media:cleanup:live`, com TEST_DATABASE_URL
dedicada; dezenove casos PostgreSQL e filesystem reais, além de deadline/close
do upload e subprocesso Linux resistente a TERM. Evidência em execution.md.

### T23: Plano operacional de ativação, legado e recovery

**What**: Entregar um perfil local de mídia operável pelo entrypoint dev:media, com backpressure429 e rollback preservando leitura; seu runbook mantém migração/backup/restore remotos como gates explícitos.
**Where**: scripts/dev-media.mjs
**Supporting files**: docker-compose.media.yml; docker/runtime.Dockerfile; .dockerignore; apps/api/src/server.js; modules/integration-reliability/src/postgres-chat-media-upload-repository.js; package.json; docs/runbooks/rustfs-chat-media.md; test/chat-media-upload-postgres-live.test.js; test/media-development-profile.test.js; ABOUT.md; ARCHITECTURE.md; EASYPANEL-TOPOLOGY.md; RULES.md; TECHNICAL-DESIGN.md; .specs/STATE.md; .specs/features/inbox-media-rustfs/design.md; .specs/features/inbox-media-rustfs/execution.md; .specs/features/inbox-media-rustfs/tasks.md.
**Depends on**: T22
**Requirement**: MED-15, MED-19, MED-20, MED-28
**Reuses**: Recovery/topologia atuais; ADR 029; docs canônicos e catálogos executáveis são suporte da entrega.
**Tools**: tlc-spec-driven; Browser somente para operação autorizada; ssh/CI.
**Done when**: [x] Inventário local e plano de inventário/migração no alvo documentados; cópia por hash precede cancelamento de DELETE por item; quotas/capacidade ajustadas; backup externo/restore isolado e gates remotos explicitamente pendentes; rollback real preserva bytes/leitura e unknown.
**Tests**: structural + integration; mínimo 6 verificações operacionais; nunca marcar recovery por mocks.
**Gate**: Topology + Privacy + Build; gates externos têm estado próprio.
**Commit**: feat(ops): add isolated media profile and enforce processing capacity

### T25: Corrigir a experiência de composição e a demo da UAT

Correção de regressão em 29/10/2026 (MED-01/25/31): limitar a altura do
composer na Inbox, rolar somente a revisão do anexo e preservar histórico e
toolbar. Imagem grande, nome longo e teclado cobertos em 1366×768, 1090×689,
390×667 e 390×440; evidência em [execution.md](execution.md).

**What**: Disponibilizar composer integrado com validação automática e envio explícito no chat DEV habilitado, corrigindo os cinco problemas reportados pelo usuário.
**Where**: apps/edge-web/src/views/InboxView.vue
**Supporting files**: apps/edge-web/src/components/inbox/MediaComposer.vue; apps/edge-web/src/components/inbox/AudioRecorder.vue; test/e2e/media-composer.spec.js; test/e2e/inbox-media.spec.js; test/e2e/audio-recorder.spec.js; fixtures existentes de gravação; docs/runbooks/chat-media-uat.md; .specs/STATE.md; .specs/features/inbox-media-rustfs/spec.md; .specs/features/inbox-media-rustfs/context.md; .specs/features/inbox-media-rustfs/design.md; .specs/features/inbox-media-rustfs/execution.md; .specs/features/inbox-media-rustfs/validation-ux.md.
**Depends on**: T23
**Requirement**: MED-01..03, MED-06..13, MED-25, MED-30..32
**Reuses**: Componentes Vue3, tokens, API de mídia e perfil Docker existente; runtime e snapshots locais podem ser corrigidos sem apagar dados/chaves/volumes.
**Tools**: tlc-spec-driven; Browser; Playwright; Docker local autorizado.
**Done when**: [x] Seleção/parada inicia upload e validação sem Preparar manual e sem mensagem automática; preview/legenda e retry idempotente funcionam; toolbar contextual tem botões temáticos, 44px, foco e espaçamento responsivos; erro explica recusa; demo4183 permite preparar automaticamente/enviar pelo worker e callback DEV reais; nenhum teste de segurança ou ciclo de vida é removido ou enfraquecido.
**Tests**: e2e + axe + integração real; novos cenários para MED-30..32 e regressão das negativas/idempotência/abort/foco existentes.
**Gate**: Build + UI + smoke local pelo backend da demo4183; revisão independente da correção antes da nova UAT.
**Commit**: fix(inbox): simplify media composing and enable complete local testing

### T26: Explicar e recuperar recusas conhecidas de envio

**What**: Corrigir o finding MED-32 do Verifier da T25, distinguindo recusa conhecida de resultado incerto sem perder a idempotência.
**Where**: apps/edge-web/src/components/inbox/MediaComposer.vue
**Supporting files**: test/e2e/media-composer.spec.js; .specs/features/inbox-media-rustfs/spec.md; .specs/features/inbox-media-rustfs/context.md; .specs/features/inbox-media-rustfs/execution.md; .specs/features/inbox-media-rustfs/validation-ux.md; .specs/STATE.md; docs/runbooks/chat-media-uat.md.
**Depends on**: T25
**Requirement**: MED-06, MED-32
**Reuses**: ApiError status/code, contratos INBOX_INVALID/INBOX_FORBIDDEN/INBOX_CONFLICT e drafts existentes; nenhum detalhe arbitrário da API vai à interface.
**Tools**: tlc-spec-driven; Playwright; Verifier independente.
**Done when**: [x] Recusa conhecida explica motivo seguro; recuperáveis mantêm retry com chave/payload originais; recusas que exigem revisão bloqueiam retry cego e permitem remover/reselecionar; preview é preservado e nenhuma mensagem é automática; rede/5xx incertos mantêm comportamento existente e nenhum dado privado do erro é exibido.
**Tests**: e2e de motivos HTTP, preview, sends0, chave/payload, bloqueio/remover e canária de PII; regressão dos cenários existentes de resultado incerto.
**Gate**: Build + UI focal; Verifier independente reexecuta baseline e sensor no novo HEAD antes da nova UAT.
**Commit**: fix(inbox): explain known media send refusals safely

### T27: Recuperar validação temporária e identificar falhas de captura

**What**: Corrigir a nova falha UAT de 10/10, distinguindo indisponibilidade temporária da validação e ausência/falha de microfone.
**Where**: apps/edge-web/src/components/inbox/MediaComposer.vue
**Supporting files**: apps/edge-web/src/components/inbox/AudioRecorder.vue; test/e2e/media-composer.spec.js; test/e2e/audio-recorder.spec.js; .specs/features/inbox-media-rustfs/spec.md; .specs/features/inbox-media-rustfs/context.md; .specs/features/inbox-media-rustfs/execution.md; .specs/features/inbox-media-rustfs/validation-ux-recovery.md; .specs/STATE.md; docs/runbooks/chat-media-uat.md.
**Depends on**: T26
**Requirement**: MED-06, MED-11, MED-19, MED-25, MED-26, MED-32
**Reuses**: Motivos sanitizados existentes, polling e refresh legítimo ClamAV; sem ignorar scanner ou simular dispositivo de captura na UAT física.
**Tools**: tlc-spec-driven; Browser; Playwright; Docker local.
**Done when**: [x] Unavailable temporário conserva arquivo/legenda e permite consultar a mesma mídia sem novo upload/envio automático; lost/rejected continuam bloqueados; captura informa ausência/falha/permissão sem detalhe privado; demo usa assinaturas atualizadas legitimamente; reprodução pela tela identifica ausência real de microfone e envio completo do anexo. Imagem, áudio e vídeo enviados pelo navegador integrado no fluxo DEV; revisão específica PASS em [validation-ux-recovery.md](validation-ux-recovery.md). T24 permanece pendente.
**Tests**: E2E focal e regressão; assertions de motivo, foco, preview, legenda, um upload e envio explícito; smoke pelo pipeline real e revisão independente.
**Gate**: Build + UI + smoke local; Verifier específico antes da nova UAT.
**Commit**: fix(inbox): recover media validation and explain microphone failures

### T28: Evitar validação repetida na mesma tentativa

**What**: Reduzir latência do anexo reaproveitando a validação completa da saída na mesma tentativa, preservando integridade e retries.
**Where**: modules/integration-reliability/src/chat-media-process-worker.js
**Supporting files**: test/chat-media-process-worker.test.js; .specs/features/inbox-media-rustfs/spec.md; .specs/features/inbox-media-rustfs/design.md; .specs/features/inbox-media-rustfs/context.md; .specs/features/inbox-media-rustfs/execution.md; .specs/features/inbox-media-rustfs/validation-performance.md; .specs/STATE.md; docs/runbooks/chat-media-uat.md.
**Depends on**: T27
**Requirement**: MED-06, MED-14, MED-26, MED-30
**Reuses**: Resultado da mesma tentativa, lease, CAS, lstat, checksum do PUT e HEAD; sem cache entre jobs, nova infraestrutura ou bypass antivírus.
**Tools**: tlc-spec-driven; Node; Docker local; Browser.
**Done when**: [x] Anexo novo usa uma validação completa e publica ready só para os bytes validados; gravação conserva validação entrada/saída; retry preparado sem objeto valida novamente; alteração de arquivo/tamanho/hash ou metadados bloqueia ready; latência medida na demo antes/depois e revisão independente específica PASS. Mesma PNG:20,401s antes e15,481/13,509s depois; envio explícito DEV confirmado. [Revisão específica](validation-performance.md); T24 permanece pendente.
**Tests**: Unit worker, validator e store; corrupção pós-prepare, arquivo não regular, retry e lease; smoke sintético real e envio explícito pela tela.
**Gate**: Build + Full unit + smoke local; Verifier específico com sensor de integridade.
**Commit**: perf(media): reuse validated output within a processing attempt

### T29: Manter o antivírus carregado no worker com clamd

**Where**: modules/integration-reliability/src/clamav-daemon.js
**Supporting files**: scanner e signature-refresh; exports; worker; healthcheck; docker/runtime.Dockerfile; docker/clamd.conf; testes dessas fronteiras e helper de runtime; context/design/spec/execution/STATE/runbook, ARCHITECTURE.md e TECHNICAL-DESIGN.md, ADR/RFC com seus índices, lições geradas e relatório de validação desta tarefa.
**Depends on**: T28
**Requirement**: MED-06, MED-14, MED-26, MED-30
**Assumptions**: clamd permanece dentro do worker existente, sem porta TCP; Docker local está autorizado; limites de 1CPU/2GiB, arquivos e chaves existentes são preservados.
**What**: Carregar o motor uma vez, usar clamdscan por socket Unix privado e supervisionar inicialização, falha e parada. Confirmar carga das assinaturas antes de publicar sua atualização.
**Done when**: [x] Arquivo infectado, scanner indisponível e assinaturas antigas continuam bloqueados; leitura/envio só usam bytes validados; gravação valida entrada e saída; health detecta indisponibilidade; atualização não publica marcador antes do novo motor pronto; scan7–10ms vs9326ms e liberação pela tela1116–1163ms; quatro envios DEV confirmados. [Revisão independente](validation-clamd.md) PASS e sensor3/3 detectados. T24 permanece pendente.
**Tests**: unit + integração na imagem construída + navegador; cenários de infecção, indisponibilidade, atualização, recuperação, seis formatos e normalização.
**Gate**: Quick + Build + scanner/normalizador real e envio DEV; revisão independente específica antes do commit.
**Commit**: perf(media): keep antivirus engine loaded with clamd

### T30: Restringir os fluxos dos scripts locais apontados pelo CodeQL

**Where**: scripts/media-smoke-security.mjs
**Supporting files**: scripts/n8n-media-local-smoke.mjs; scripts/media-built-local-smoke.mjs; scripts/media-built-local-fault-smoke.mjs; test/media-smoke-security.test.js; tasks/spec/execution/STATE e validation-pr-security.md.
**Depends on**: T29
**Requirement**: MED-20, MED-23
**Assumptions**: Scripts são exclusivos do perfil sintético local; não alterar controles da aplicação nem enfraquecer checks.
**What**: Limitar taxa antes do hook de banco; exigir identidade fixa do workflow local; preservar apenas provas escalares validadas e hashes; rever fluxo intencional de provisionamento de credencial no RustFS loopback com evidência independente.
**Done when**: [x] Rajada não alcança banco; workflow diferente é recusado; nenhuma resposta arbitrária ou áudio de rede é escrito como artefato; limites e integridade são comprovados; cada alerta tem correção ou classificação independente documentada. Aprovação dos checks remotos permanece condição para o merge, verificada após o push.
**Tests**: unit + revisão independente e sensor isolado + CI completo do PR.
**Gate**: Build + Quick + revisão independente e sensor antes do commit; CodeQL e checks do PR antes do merge, sem dismiss de vulnerabilidade real ou supressão de regra.
**Commit**: fix(dev): constrain local media smoke data flows

### T31: Corrigir políticas e upload do chat no edge de produção

**Where**: docker/nginx.conf
**Supporting files**: test/edge-media-policy.test.js; scripts/check-edge-media-proxy.mjs; scripts/edge-media-image-pull.mjs; test/edge-media-image-pull.test.js; .github/workflows/ci.yml; tasks/spec/execution/STATE; docs/runbooks/rustfs-chat-media.md; validation-production-edge.md.
**Depends on**: T30
**Requirement**: MED-01..03, MED-09, MED-25
**Assumptions**: Origem HTTPS do CRM; nenhuma permissão de câmera/geolocalização ou origem externa; API e worker exigem ativação operacional própria.
**What**: Permitir microfone somente na própria origem, prévias blob de imagem/áudio/vídeo e multipart até17MiB somente na rota exata de upload do chat, sem buffering do request.
**Done when**: [x] Política não bloqueia microfone same-origin; CSP aceita prévias blob sem abrir script/connect externos; upload16MiB mais envelope passa pelo proxy; APIs comuns conservam1MiB e arte11MiB; revisão independente aprovada. Nginx real8/8 e CI38073260116 aprovados. Ativação remota e hardware seguem gates separados.
**Tests**: testes de configuração + Nginx real com bytes sintéticos + sensor independente.
**Gate**: Quick + Build + Nginx real; checks remotos antes de promoção.
**Commit**: fix(edge): allow chat media capture and bounded uploads

### T32: Configurar e homologar pipeline remoto DEV

**Where**: docs/runbooks/rustfs-chat-media.md
**Supporting files**: tasks/spec/execution/STATE; validation-production-runtime.md; configurações EasyPanel/RustFS sem segredos versionados.
**Depends on**: T23
**Requirement**: MED-16, MED-19, MED-20, MED-23, MED-26, MED-28
**Assumptions**: Autorização explícita do operador em10/10/2026 para bucket privado DEV, duas identidades restritas, spool e provas sintéticas; nenhum envio a clientes nem promoção operacional.
**What**: Configurar bucket DEV no RustFS existente, IAM separado API/worker, spool privado compartilhado e variáveis correspondentes; verificar schema, scanner, saúde e isolamento antes de ativar somente a prova sintética autorizada.
**Done when**: [x] PUT/GET/DELETE sintéticos e negativas de acesso passam; API e worker enxergam o mesmo spool0700/UID1000; PNG/áudio/vídeo chegam a ready e leitura autorizada; flags/configuração final e rollback registrados sem segredos ou mensagens a clientes. Revisão independente PASS, regressão18/18 e sensor3/3; limites HTTP áudio, T24, n8n, privacidade e recovery registrados em validation-production-runtime.md.
**Tests**: smoke remoto sintético, negativas IAM/ACL, schema/health/scanner e upload/leitura dos três tipos.
**Gate**: Evidência operacional remota + revisão independente; evidência local não substitui ambiente alvo.
**Commit**: docs(ops): record remote chat media development pipeline

### T24: Homologação da fatia e evidências

**What**: Executar UAT sintético ponta a ponta do CRM ao DEV e consolidar critérios para canal real.
**Where**: docs/runbooks/chat-media-uat.md
**Depends on**: T31, T32
**Requirement**: MED-01..32
**Reuses**: Todos os testes da fatia; handoff e reserva atuais.
**Tools**: tlc-spec-driven; Browser/Playwright; Verifier independente após commit final.
**Done when**: [ ] UAT com três arquivos reais e microfone; sucesso/falha/unknown/replay/ACL/teclado; retenção pós-oito dias demonstrada; Meta separado; nenhuma PII em evidência.
**Tests**: integration + e2e; matriz de 32 ACs após correção UAT, sem duplicar testes só para aumentar contagem.
**Gate**: Build + Full + smoke RustFS/DEV; Verifier e sensor após o commit final.
**Commit**: docs(qa): record end-to-end chat media acceptance

Entrega automatizada T24 registrada em docs/runbooks/chat-media-uat.md e execution.md:
quatro uploads built→DEV/callback, failed/unknown/restauração, replay/ACL/Range,
normalização300s/negação301s, retenção e playback oito pares. Done permanece
desmarcado por matriz UAT completa pendente, sem Verified; captura/revisão
físicas isoladas observadas emT32 não encerram essa matriz. Verifier/sensor
após fechamento. P1 de header Basic persistido no n8n bloqueia uso operacional.

## Task Granularity Check

T23 tem um resultado operacional único: perfil local de mídia iniciado por
scripts/dev-media.mjs, incluindo backpressure e rollback legível. Compose,
admission SQL, configuração runtime, documentação e testes são suporte acoplado
a esse perfil e estão integralmente enumerados em Supporting files. Entry point
é a fronteira primária de Where; não se omite escopo nem se criam tarefas
retroativas para reclassificar o commit4fa0ec1. Refinamento registrado em T24
após o sensor de granularidade detectar Where com múltiplos arquivos.

Cada Tn possui um único resultado: runbook (T1/T23/T24), migration (T2), adapter
(T3/T5), validador (T4), worker (T6/T22), endpoint (T7/T8/T9/T13), transação
(T10), contrato (T11/T12/T16/T17), workflow (T14/T15) ou componente (T18..T21).
Testes, exports, manifest, wiring, schemas e snapshots necessários pertencem
ao mesmo resultado e commit; nunca justificar ausência de teste por tarefa futura.
Migration NNNN é nome proposto: escolher número livre no momento da execução.

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1   | None                   | Raiz          | Match  |
| T2   | T1                     | T1 → T2       | Match  |
| T3   | T2                     | T2 → T3       | Match  |
| T4   | T3                     | T3 → T4       | Match  |
| T5   | T4                     | T4 → T5       | Match  |
| T6   | T5                     | T5 → T6       | Match  |
| T7   | T6                     | T6 → T7       | Match  |
| T8   | T7                     | T7 → T8       | Match  |
| T9   | T8                     | T8 → T9       | Match  |
| T10  | T9                     | T9 → T10      | Match  |
| T11  | T10                    | T10 → T11     | Match  |
| T12  | T11                    | T11 → T12     | Match  |
| T13  | T12                    | T12 → T13     | Match  |
| T14  | T13                    | T13 → T14     | Match  |
| T15  | T14                    | T14 → T15     | Match  |
| T16  | T15                    | T15 → T16     | Match  |
| T17  | T16                    | T16 → T17     | Match  |
| T18  | T17                    | T17 → T18     | Match  |
| T19  | T18                    | T18 → T19     | Match  |
| T20  | T19                    | T19 → T20     | Match  |
| T21  | T20                    | T20 → T21     | Match  |
| T22  | T21                    | T21 → T22     | Match  |
| T23  | T22                    | T22 → T23     | Match  |
| T25  | T23                    | T23 → T25     | Match  |
| T26  | T25                    | T25 → T26     | Match  |
| T27  | T26                    | T26 → T27     | Match  |
| T28  | T27                    | T27 → T28     | Match  |
| T29  | T28                    | T28 → T29     | Match  |
| T30  | T29                    | T29 → T30     | Match  |
| T31  | T30                    | T30 → T31     | Match  |
| T32  | T23                    | T23 → T32     | Match  |
| T24  | T31,T32                | T31 → T24; T32 → T24 | Match  |

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires             | Task Says              | Status |
| ---- | --------------------------- | --------------------------- | ---------------------- | ------ |
| T1   | Runbook/smoke               | structural/integration      | integration            | OK     |
| T2   | Schema                      | structural/integration live | integration live       | OK     |
| T3   | Storage                     | unit/integration            | unit/integration       | OK     |
| T4   | Validação                   | unit/integration            | unit/integration       | OK     |
| T5   | Codec                       | unit/integration            | unit/integration       | OK     |
| T6   | Worker                      | unit/integration            | unit/integration live  | OK     |
| T7   | API                         | integration                 | integration/unit       | OK     |
| T8   | API                         | integration                 | integration            | OK     |
| T9   | API                         | integration                 | integration            | OK     |
| T10  | Repositório                 | integration live            | integration live       | OK     |
| T11  | Domínio/API                 | unit/integration            | unit/integration       | OK     |
| T12  | Outbox                      | unit/integration live       | unit/integration live  | OK     |
| T13  | API técnica                 | integration                 | integration            | OK     |
| T14  | Workflow                    | unit/integration            | unit/integration       | OK     |
| T15  | Workflow                    | unit/integration            | unit/integration       | OK     |
| T16  | Leitura SQL                 | unit/integration live       | unit/integration live  | OK     |
| T17  | Cliente HTTP                | unit/integration            | unit/integration       | OK     |
| T18  | UI                          | e2e/axe                     | e2e/axe                | OK     |
| T19  | Recorder                    | e2e/axe                     | e2e/axe                | OK     |
| T20  | Playback                    | e2e/axe                     | e2e/axe                | OK     |
| T21  | Inbox                       | e2e/axe                     | e2e/axe                | OK     |
| T22  | Worker                      | unit/integration            | unit/integration live  | OK     |
| T23  | Operação                    | structural/integration      | structural/integration | OK     |
| T24  | UAT                         | integration/e2e             | integration/e2e        | OK     |
| T25  | Composer integrado          | e2e/axe + integração real   | e2e/axe + integração   | OK     |
| T26  | Recusa de envio             | e2e + sensor                | e2e + sensor           | OK     |
| T27  | Recuperação e captura       | e2e + smoke                 | e2e + smoke            | OK     |
| T28  | Worker e integridade        | unit + smoke                | unit + smoke           | OK     |
| T29  | Scanner persistente         | unit + integração + tela    | unit + integração + tela | OK   |
| T30  | Scripts locais e provas     | unit + CI + revisão         | unit + CI + revisão    | OK     |
| T31  | Proxy e políticas de mídia  | unit + Nginx + revisão      | unit + Nginx + revisão | OK     |
| T32  | Pipeline remoto DEV         | smoke + IAM/ACL + runtime   | smoke + IAM/ACL + runtime | OK  |

## Confirmação antes de Execute

Plano e matriz estão prontos para revisão. Aprovar detalhes propostos antes
de implementar; ferramentas recomendadas já estão em cada tarefa. Confirmar
delegação caso desejada; não criar workers automaticamente nesta etapa.
Aplicar a autorização explícita do usuário para RustFS/gravação/retenção;
não pedir essas decisões novamente. Criar acesso ou realizar deploy exige
identificar a ação exata quando a implementação chegar a esse ponto.
