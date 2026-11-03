# Ativação de mídia do chat no RustFS

## T23: operação implementada e gates de ativação

### Diagnóstico do edge e da ativação

O merge da feature não ativa automaticamente mídia na API/worker. Em10/10/2026,
o Inbox remoto mostrou upload404 e gravação negada; o edge servia
`Permissions-Policy: microphone=()` e CSP sem prévias blob. T31 corrige o edge:
microfone same-origin, blob apenas em img-src/media-src e limite17MiB somente
no POST `/api/v1/conversations/:id/media`, suficiente para16MiB mais multipart.
O limite de1MiB das outras APIs e11MiB da arte permanecem.

Após publicar a imagem do edge, confirmar os headers HTTPS e a permissão do
navegador. Permitir `microphone=(self)` não dispensa consentimento do usuário
nem prova disponibilidade de dispositivo físico. Se a rota ainda responder404,
conferir revisão executada e `CHAT_MEDIA_ENABLED` na API, além de spool, secrets,
bucket privado e configuração correspondente no worker antes de ativar.
Não habilitar só a flag nem reutilizar bucket/credencial de arte por conveniência.
O pipeline e os gates externos abaixo permanecem exigidos.

Inspeção de10/10/2026 no EasyPanel confirmou ausência de `CHAT_MEDIA_ENABLED`,
`CHAT_MEDIA_SPOOL_ROOT` e `MEDIA_S3_*` na API/worker. O worker estava sem mounts.
Já existe endpoint HTTPS S3 para a porta9000 do RustFS; não é necessário criar
domínio novo nem atualizar o serviço compartilhado.

Plano concreto para homologação remota, antes de liberar arquivos de clientes:

1. Criar bucket privado `crm-silmer-chat-media-dev`, sem lifecycle de expiração,
   e duas identidades IAM exclusivas. API recebe somente GetObject; worker
   GetObject/PutObject/DeleteObject, restritos aos objetos desse bucket. Essa
   criação de acesso exige autorização do operador; nunca usar root no CRM.
2. Preparar diretório privado de spool no host, proprietário1000:1000 e0700,
   montado na API/worker em `/var/lib/crm-chat-media`, separado do spool legado.
   Preservar mounts e arquivos existentes; validar visibilidade entre processos.
3. Injetar secrets sem impressão/versionamento: endpoint HTTPS S3 existente,
   região, bucket DEV e a identidade correspondente em cada serviço. Configurar
   `CHAT_MEDIA_SPOOL_ROOT`, alias `chat-dev`, quota inicial1GiB e flag inicialmente
   desligada. A chave de envelope da API existente permanece preservada.
4. Confirmar schema0030–0033, revisões executadas, clamd/assinaturas/health,
   capacidade, usuário/mounts e configuração DEV do n8n. Ativar flag na API/worker
   somente para prova sintética autorizada; subir PNG, gravação sintética e vídeo,
   confirmar ready e leitura autorizada. Não enviar mensagens a clientes no teste.
5. Resolver os gates de privacidade/backup/restore abaixo antes de promover o
   bucket operacional. Rollback desliga admissão/consumo mantendo leitura e
   todos os arquivos/chaves/vínculos; não apaga volumes nem resultados incertos.

#### T32: configuração remota DEV em 10/10/2026

O operador autorizou o bucket, duas identidades restritas e o helper; confirmou
que o CRM hospedado será usado somente em testes internos com n8n. API e worker
ficaram com `CHAT_MEDIA_ENABLED=true`, alias `chat-dev`, quota de1GiB e bucket
`crm-silmer-chat-media-dev`, privado e sem lifecycle de expiração. Endpoint:
`https://s3-schedule-rustfs.jicnzg.easypanel.host`, região `us-east-1`.
As credenciais próprias ficam somente no ambiente de cada serviço. A API tem
GetObject; o worker GetObject/PutObject/DeleteObject, somente nos objetos desse
bucket, sem herdar a política root. Configurações e mounts anteriores preservados.

#### Preparação sem SSH (executada)

O console do worker observado no EasyPanel executa UID1000 e não prepara
diretórios do host. Se não houver terminal administrativo, usar um helper
temporário `silmer-chat-spool-init`, sem domínio, portas publicadas, secrets
ou acesso ao banco, somente após autorização específica para esse serviço.
O bind proposto `/var/lib/crm-silmer/chat-media` não iniciou porque o host path
não existia. Nenhum diretório foi criado ali. O helper recebeu um VolumeMount
EasyPanel chamado `chat-media-spool` em `/spool`. O diretório
montado deve estar vazio; o helper recusa arquivos ou symlink, ajusta apenas
esse diretório, sem operações recursivas, e permanece ocioso para conferência.
O helper confirmou1000:1000/0700 e foi parado. Sua definição e seu volume
devem permanecer: o spool persistente pertence a esse serviço. Não destruir
o helper nem remover seu volume enquanto API/worker usarem o diretório.

Dockerfile aplicado (mesma base imutável do runtime):

```dockerfile
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
USER root
CMD ["sh", "-ec", "test -d /spool && test ! -L /spool && test -z \"$(find /spool -mindepth 1 -maxdepth 1 -print -quit)\" && chown 1000:1000 /spool && chmod 0700 /spool && stat -c '%u:%g %a' /spool && sleep infinity"]
```

Não montar socket Docker, raiz do host, volumes RustFS ou outros diretórios.
O host path foi lido em `/proc/self/mountinfo`, sem supor caminho Docker:
`/etc/easypanel/projects/espectro-mvp/silmer-chat-spool-init/volumes/chat-media-spool`.
API/worker recebem bind desse mesmo path em `/var/lib/crm-chat-media`, que também
é `CHAT_MEDIA_SPOOL_ROOT`. O helper não executa aplicação como root; API/worker
continuam UID1000. O domínio criado automaticamente pelo painel foi removido
antes do deploy do helper, que ficou sem domínio, portas ou secrets.

O EasyPanel reaplicou0777 ao bind no deploy. Os comandos Advanced dos dois
serviços verificam o dono e restauram0700 antes de iniciar a aplicação:

```sh
# silmer-api
sh -ec 'test "$(stat -c %u:%g /var/lib/crm-chat-media)" = 1000:1000; chmod 0700 /var/lib/crm-chat-media; exec node apps/api/src/server.js'
# silmer-worker
sh -ec 'test "$(stat -c %u:%g /var/lib/crm-chat-media)" = 1000:1000; chmod 0700 /var/lib/crm-chat-media; exec node apps/worker/src/worker.js'
```

Probes após os dois deployments confirmaram UID/dono/grupo1000, modo0700 e
flagtrue. Um marcador sintético criado pelo worker foi lido pela API e removido
após a prova. A reaplicação transitória de0777 pelo painel permanece risco a
resolver antes de dados operacionais; não ampliar permissões para contorná-la.

Provas remotas: worker PUT/GET com bytes iguais e DELETE seguido de HEAD404;
API GET aprovado, PUT e GET de bucket estrangeiro negados403; worker também
recebeu403 no GET de bucket estrangeiro. GET anônimo do
canário negado403. Nenhum objeto alheio foi modificado. Schema0030–0033 e
checksums correspondem às migrations; readiness da API aprovado. Worker com
clamd PONG e marcador genuíno recente, dentro de36h e sem timestamp futuro.

PR157 foi integrado por rebase emmaster `d9e3a70` após sete checks aprovados.
Deployments EasyPanel iniciados18:01:02UTC concluíram18:01:11UTC: API/worker
registraram imagem `sha256:c30b13fab7c027118bdea0241c8d6d2123ec1725e135fa78011ba4c27a28f9d4`;
edge `sha256:0d894085e6705d967e576544a361b66c223c0ec5b16856c8c3eeb3bec485cbbd`.
HTTPS passou a servir `microphone=(self)`, img-src com blob e media-src self/blob.
Na conversa sintética, PNG, MP3 e MP4 chegaram a ready/clean, com prévias
decodificadas e Enviar anexo habilitado. Após o operador permitir o microfone,
a tela iniciou/parou uma gravação e chegou à revisão ready; saída normalizada
audio/ogg. Nenhuma mensagem foi enviada a clientes. Captura/revisão observadas
não encerram a matriz completa T24 nem homologam Meta, privacidade ou recovery.

Leitura: imagem e vídeo privados abriram pela rota HTTPS autenticada, com
decodificação válida; a mesma rota de imagem sem sessão respondeu401. A leitura
de conteúdo no runtime real da API, usando repository/store reais e o ator
uploader, passou nos três tipos com status200, tamanho e SHA256 iguais ao banco;
ator sintético alheio foi recusado403 em todos. Não foi criada sessão nem
alterada ACL. Navegação direta a áudio no navegador do Codex foi bloqueada pelo
cliente (`ERR_BLOCKED_BY_CLIENT`); essa navegação não é prova de playback HTTP
de áudio. A prévia de áudio/gravador na tela carregou; playback pós-envio e
callback DEV continuam no aceite completo T24, sem contornar o navegador.

Rollback: API com `CHAT_MEDIA_ENABLED=false` e `CHAT_MEDIA_READ_ENABLED=true`;
worker com `CHAT_MEDIA_ENABLED=false`. Preservar endpoint, credenciais, bucket,
envelope, binds, volume/helper parado, arquivos e vínculos. O flagtrue permanece
exclusivamente para os testes internos autorizados; bucket DEV não seleciona
automaticamente workflow n8n DEV. Antes de qualquer SEND, verificar o workflow
e seus efeitos simulados, além dos gates abaixo.

Inbox aceita imagem, áudio anexado ou gravado e vídeo; upload/preparo/envio são
ações explícitas. API valida sessão, CSRF, ownership e versão, worker valida
bytes e normaliza gravações, RustFS mantém variante privada, n8n reserva por
referência imutável e confirma por callback. Mídia attached permanece salva;
cleanup automático somente alcança rascunhos sem message_id com mais de24h.
Pipeline construído local homologado por provas automatizadas T24; captura e
revisão físicas remotas observadas emT32, matriz completa permanece pendente.
A matriz e as fronteiras estão em
[chat-media-uat.md](chat-media-uat.md). Configuração local não comprova operação
remota, backup ou entrega real Meta. P1: execução inicial n8n PostgreSQL persiste
recipient/caption/header Basic mesmo savesnone. Bloquear dados/credenciais
operacionais até minimização/redação e expurgo/readiness comprovados; soft-delete
não comprova apagamento seguro. Evidências não incluem valores de headers.

### Perfil Docker local opt-in

`rtk npm run dev:media` constrói a imagem runtime existente e inicia somente
`crm-silmer-media-local`, com DB e volumes nomeados próprios. O dev de texto
continua `npm run dev`, com mídia desligada. Endereços do perfil: CRM4193,
API3013, n8n5688 e S321920, sempre127.0.0.1. Dados, chaves e arquivos persistem
ao fechar o processo; nenhum comando do startup remove volumes ou arquivos.
Configuração e secrets locais ficam em var/media-local, ignorado pelo Git e
Docker. Perda de secrets.json com volume persistente bloqueia startup antes de
gerar novas chaves/env: restaurar o arquivo original do backup protegido.
Backup do estado inclui secrets.json, encryption key n8n, DBs e objetos;
separar acesso às chaves e não imprimir env/secrets em logs.

API/worker/n8n compartilham namespace do RustFS do perfil. Assim endpoints
internos S39000, n8n5678 e callbackAPI3000 são loopback; HTTP para hostname
rustfs/n8n/host.docker.internal continua proibido pelos adapters. Banco usa DNS
Docker e não faz HTTP. RustFS alpha99 está fixado por digest; papéis locais API
GetObject e worker Get/Put/Delete limitados ao bucket CRM-dev. Bootstrap root
existe somente no RustFS/setup local; API/worker/n8n não recebem root. Na alpha99
HEAD de UUID ausente retorna404 para ambos papéis mínimos e bucket estrangeiro
403; não foi necessário permitir ListBucket.

Volumes chat-spool e legacy-spool têm roots distintos, UID/GID1000 e0700;
UUIDs são relativos e arquivos são privados. Volume signatures é preenchido
pela base genuína da imagem, API readonly e worker read/write para refresh.
Não montar diretório vazio sobre a base, nem fabricar marker. Scanner falha
fechado sem base ou com verificação stale; refresh em background mantém texto
disponível. `main.cvd`, `daily.cld` e `bytecode.cvd` foram observados no perfil.
Health worker atual prova processo; base/queue/DB exigem probes específicos.

Budget do perfil: API2GiB/1CPU (scanner legado coexistente), worker2GiB/1CPU,
n8n2GiB/1CPU/concurrency1 e RustFS1GiB/1CPU. Decoder é serial, threads1. API
admite dois pipelines por bucket sob quota lock: receiving recente (três minutos)
ou com guard futuro, e mídia com job
pending/retry/processing ou guarda futura contam. Saturação429 antecede reserva
e bytes; estado terminal com writer ainda protegido também conta. Ready sem
guarda libera capacidade. Replay aceito não cria slot/reserva e passa com quota
cheia. Após grace segura de recebimento expirada, writer órfão não ocupa slot,
mas reserva/bytes permanecem até cleanup confirmado >24h. Quota DEV padrão1GiB,
limite12admissões/min por sessão; texto mantém seu
contrato. Testes de quota usam capacidade independente explicitamente maior
para preservar a prova do limite de bytes, sem alterar runtime2.

### Cleanup e rollback sem perda de arquivos enviados

Streaming tem deadline120s e lease advisory de sessão sem BEGIN; FD fechado
precede release de conexão e quota. Upload funciona com pool1; processamento
requer pool>=2 (padrão10). Handler mantém guarda até fechar decoder/PUT, aborta
por heartbeat/conexão perdida, SIGKILL no cancelamento/timeout e awaitclose.
Guardas persistidas3min/15min protegem perda da sessão; job terminal sozinho
não prova morte do writer. Fila real recupera attempt expirado antes do cleanup.

Cleanup confirma intenção unavailable antes do DELETE, sob lock/recheck de
job/mídia/writer. Só a etapa posterior remove spool/intermediários/S3 e libera
quota; revalida guard nas duas etapas. Rollback após DELETE conserva intent e
cobrança, nunca restaura ready vinculável. Retry é idempotente. Diretórios
`.recording-<UUID variante>-<sufixo6>` pertencem àquela variante; somente eles
são removidos. Diretórios legados sem UUID e arquivos desconhecidos não são
apagados automaticamente: inventariar por hash/proveniência e contabilizar
ocupação física antes de reconciliar com autorização. Lease expirada isolada
não autoriza quota0 nem rm de decoder vivo.

Rollback local `rtk npm run dev:media -- --read-only` mantém chaves/bucket/spool
e CHAT_MEDIA_READ_ENABLED=true, desliga nova admissão e consumo de mídia.
Upload novo responde404 por rota desabilitada; novo envio humano com mídia403.
Texto/outbox existente continuam; ready/attached seguem consultáveis. Resultado
unknown permanece para reconciliação; nunca reenviar automaticamente. Reativar
com o mesmo secrets.json e volumes. No alvo, aplicar flags com mesma configuração
DB/auth/storage; não usar rollback para apagar dados ou alterar retenção.

### Migração legada, backup e gates externos

Inventário local: volumes separados postgres-data, n8n-postgres-data, n8n-data,
rustfs-data, chat-spool, legacy-spool e signatures no projeto dedicado. Inventário
remoto permanece gate: contexto existente registrou RustFS sem domínio/backup
comprovado; mapear mount absoluto, capacidade, bucketCRM e cópias legadas por
UUID/hash/tamanho/estado. `hermes-backups` não participa desse inventário.
Política legada sete dias/fim da jornada permanece até promoção confirmada.

Para cada cópia legada disponível, bloquear expurgo do item durante migração,
scan/quarentena, copiar para chaveCRM imutável e confirmar HEAD+GET+SHA+tamanho.
Persistir vínculo novo e provenance em transação; somente depois marcar promoção
e cancelar DELETE legado daquele item. Registrar source/target/hash e CAS,
repetição sem novo objeto; cópia ausente vira lost/unavailable, não ready.
Não cancelar sweeper global antes de confirmar todas as cópias e vínculos.
Disponibilidade dessas cópias e execução da migração no alvo estão pendentes.

Backup exige destino externo independente da VPS, criptografia, chave separada,
inventário de objetos/hash e dump consistente DB/vínculos/quota. Snapshot/volume
local é preservação, não recuperação. Restore isolado deve recuperar DB+objetos+
chaves, medir RPO/RTO e confirmar leitura autorizada/Range/SHA de amostra,
attached antigo intacto e unknown sem reenvio. Isolar n8n/Meta durante restore;
reconciliar quota física, usada e reservada antes de reabrir admissão. Falha de
integridade deixa indisponível e preserva metadata; sem falso sucesso.

| Gate alvo | Estado e evidência exigida antes da ativação |
| --- | --- |
| RustFS/IAM/digest | Pendente no remoto; bucketCRM privado, papéis mínimos, lifecycle sem expurgo, negativas anônimo/cross-bucket e digest real |
| Capacidade/inventário | Pendente no remoto; bytes usados/reservados mais intermediários/cópias, margem filesystem, concorrência2 e decoder1 medidos no sizing real |
| Legado | Pendente no alvo; inventário por item, cópia hash antes de cancelar DELETE e CAS/retry comprovados |
| Backup externo/restore | Pendente; destino separado, chaves protegidas, restore isolado e RPO/RTO/SHA/Range documentados |
| n8n privacidade | Não atendido em produção: registros iniciais soft-deleted continham recipient/caption no ensaio; pruning máximo30dias e minimização/expurgo precisam de prova operacional |
| Meta | Pendente; versão explícita e homologated, allowlist/limites/voice flag atuais, DPA e entrega real autorizada |
| UAT | Pipeline built e microfone físico em T24; dispositivos sintéticos não aprovam hardware humano |

Sem executar upgrade, deploy ou alteração remota. Revisar advisories/patches
do RustFS alpha99, Node e pacotes Debian antes de promover; npm audit cobre
dependências JS, não scanner/FFmpeg/SO. Config n8n global e workflow conservam
none/none/false/false; instância usa binarydefault, concorrência1 e pruning720h.
O export local mantém campo legado settings.binaryMode=separate, sem trocar a
configuração nativa da instância. Isso não remove os registros iniciais com PII
observados nem fecha gate externo.
Admin REST local usa SigV4 conforme [documentação IAM](https://docs.rustfs.com/en/security-compliance/iam/policies);
compatibilidade efetiva foi testada na alpha99, não presumida da documentação.

T18: composer standalone recebe contexto fixo conversationId/expectedVersion
e disabled; o chamador fase4 deve derivar disabled da autorização/admissão
atual e tratar sent para refresh. Não usar filename/MIME como prova de bytes.
Seleção → prévia → Preparar arquivo → ready → revisão → Enviar anexo.
Áudio sem caption; 1024 emoji são 1024 code points válidos. Erro mantém
prévia e retry usa contexto/chave originais; após tentativa de envio, legenda
fica congelada. Mudança de conversa/versão ou unmount aborta e ignora respostas
antigas. Polling termina em até 600 s, incluindo GET pendente, cobrindo os
340 s das fases locais mais I/O. Timeout conserva mediaId e preview; atualizar
validação consulta a mesma mídia sem repetir upload. Não renova lease nem reenvia por timer.
Teste UI/axe de T18 usa harness isolado e API mockada; T21 integra os componentes
na Inbox e tem E2E HTTP/SSE próprios. Pipeline built completo permanece T24.

T17: uploads usam FormData com boundary do browser; não definir Content-Type
manualmente. Reutilizar File/contexto/Idempotency-Key originais após resultado
ambíguo. Cancelar AbortController do upload/status ao descartar ou mudar de
conversa; o proxy dev encaminha o abandono da conexão para a API, preservando
JSON, resposta Range normal e streaming SSE.

T16: media.contentUrl é exclusivamente uma rota relativa CRM, protegida pela
ACL normal de leitura; lost preserva o histórico e retorna contentUrl=null.
deliveryMode=dev indica simulação pela reserva original, inclusive failed e
outcome_unknown. Não significa entrega WhatsApp. Histórico/lista não consultam
RustFS; a leitura dos bytes continua no endpoint autorizado e pode marcar lost.

### T15: ensaio local real e limite de privacidade

Executar `npm run smoke:n8n:media:local` com Node 24.20.0,
`RUN_N8N_MEDIA_LOCAL_SMOKE=yes` e `TEST_DATABASE_URL` do banco dedicado
crm_silmer_test. Exige RustFS sintético local, ffmpeg no container dedicado
e n8nio/n8n:2.38.7; nenhuma chamada Meta/OpenAI real. O comando elimina
somente seu container e suas chaves sintéticas, preservando o perfil local
ignorado para inspeção. Não executar junto de outros gates SQL.

O ensaio verifica PNG/OGG/MP4, replay, falhas anteriores ao efeito, unknown,
hash/tamanho e epoch; próximo de 16 MiB mede memory.peak com limite 2 GiB,
1 CPU e concorrência 1. Reimport usa digest, preserva referências OpenAI
locais e publica a versão atual antes de reiniciar. Healthz não comprova
ativação do webhook; exigir evento de ativação e callback real.

Inspecionar o perfil parado com inspect-n8n-execution-privacy.py, apenas
categorias. O n8n grava registros iniciais soft-deleted até pruning, contendo
recipient/caption: **privacidade de produção T23 não atendida**. Zero bytes
raw/base64 em SQLite/WAL/FS e ambos stdout/stderr não significa zero PII.
Nunca apagar esses registros ou desligar pruning para fazer o teste passar.
O smoke semeia mídia ready manualmente; worker/scanner construídos e o
transporte completo do dispatcher ficam pendentes em T24.

T13: leitura técnica exige Basic e integration.n8n.command.media.read,
command processing, message sending e variante bound attached/clean. A
identidade é workflow/version/execution do recibo de reserva em n8n_events;
GET não reserva nem renova. `?preflight=true` é JSON seguro sem S3/bytes,
após upload Meta e antes de mensagens; HEAD está desativado. Codificar o
command_id inteiro como um segmento. Nunca seguir redirecionamento com Basic.
Falhas conhecidas antes de Meta/messages usam workflow.failed com phase
before_message_send e allowlist OpenAPI. A conclusão CAS da reserva original
não exige epoch atual e nunca dá retry. Após invocar /messages, usar unknown;
ErrorTrigger genérico não conclui envio. Preflight reduz a janela de corrida,
sem alegar atomicidade CRM/Meta.

T12: outbox mantém message de texto sem alteração. Mídia leva na message plana
media_id,sha256,mime_type,size_bytes,type,text,caption (audio:null), e
filename/media_url null. Fonte é a chat_media bound attached/clean, com autor,
conversa e variante revalidados; nunca content/cliente para metadados binários.
O fence reconsulta vínculo/variante e legenda atual sob lock antes da reserva.
Referência/hash/MIME/size/caption/epoch/source divergentes409 não reservam.
Aliases attachment_id/attachmentId/mediaId são proibidos na mídia retida.
Replay retorna send_authorized=false, e sending nunca autoriza nova reserva.
Unknown Meta deixa outcome_unknown/retryable=false/retry_safe=false; somente
reconciliação/callback conhecido resolve. Callbacks preservam read contra
delivered/failed posterior, sem alterar mídia/quota. GET técnico de sending,
preflight e workflow real seguem T13/T14, sem implementação antecipada.
Callbacks message.sent/message.send.unknown resolvem a conversa do comando
pelas tabelas de comandos e mensagens. conversation_id contraditório retorna
409 antes de efeitos, auditoria, SSE e recibos; os UPDATEs também restringem
essa conversa canônica. Essa resolução preserva respostas automáticas que
possuem mensagem reservada sem linha na outbox humana.
Confirmação conhecida message.sent converte o comando outcome_unknown para
sent, limpa last_error_code e conserva retryable/retry_safe=false. O callback
não reabre nem agenda jobs. Desde OPS-INBOX-ACK-02, o próximo poll da fila
reconcilia até 100 jobs n8n.command.deliver em outcome_unknown: exige comando
send_message em sent, mensagem sent na mesma conversa/comando com ID externo
igual ao comando e evento imutável message.sent da mensagem/conversa.
Somente então o job vira completed e o item open vira resolved na mesma
transação. Tentativas, eventos, motivo e criação do item e ocorrências do
painel permanecem como histórico. Sem essa prova, nada é resolvido ou reenviado.
[Diagnóstico, validação e rollback](inbox-delivery-feedback.md#reconciliação-da-fila-após-confirmação-tardia--03112026).

Contrato T11 de envio humano: messageType=text/image/audio/video. Para mídia,
content é `{mediaId,caption?}`; caption somente image/video, no máximo1024
pontos Unicode (emoji conta um), audio não aceita nem caption vazio. Qualquer
URL, chave, filename, attachmentId ou campo extra é INBOX_INVALID400. A referência
UUID passa à transação T10, que revalida vínculo e propriedade. Desligar
CHAT_MEDIA_ENABLED nega novos envios de mídia403 depois de consultar replay e
antes de locks/mutações de domínio, preservando texto,
GET status e GET conteúdo se CHAT_MEDIA_READ_ENABLED continuar true. Upload não
assume conversa; takeover só no envio válido. Erros humanos mantêm schema
accepted:false,error.code,request_id. Prova unit/integration18/18.

Idempotência de comandos T11: fingerprint novo exclui correlationId e serializa
JSON canonicamente (ordem de chaves não altera identidade); continua cobrindo
ator, conversa, versão, tipo, conteúdo e reason. Replay exato já aceito funciona
com admissão desligada e não cobra novamente. Registros legados de inbox_commands
aceitam o hash antigo exato para a mesma identificação original; sem payload/
correlação persistidos não é possível reconstruir automaticamente um replay
legado com trace novo. Nesse caso409 é esperado, sem repetir a mensagem.

T10: reserva de ready continua charged até envio humano. Apenas a transação
existente de mensagem/bind/outbox/auditoria/SSE converte reserved→used, após
revalidar autor/conversa/ready/clean/tipo/SHA/MIME/tamanho. Outro administrador
pode ler draft, mas não enviá-lo como seu. Replay de envio hidrata o resultado
sem segundo bind/cobrança. Falhas de outbox ou auditoria revertem mensagem,
takeover e quota juntos. Transferring/close após upload impedem envio stale;
upload não muda automation. Prova SQL18/18 + regressão inbox7/7.

Integridade T6/MED-19: o SHA original admitido de bytes reais por T7 é
imutável. Worker compara resultado da validação antes de prepare/PUT e rejeita
invalid_format em divergência mesmo de igual tamanho. prepare SQL exige SHA
original null/idêntico e variante ainda não preparada; COALESCE permite seed
legado null sem sobrescrever admissão. Rejeição conserva spool/reserva até
cleanup confirmado de T22. Provas: process-worker17/17 e process-postgres15/15;
pipeline combinado16/16 (zero skips) mantém scanner/normalizer da imagem e
SDK/handler host; 58.9s na reprodução do fix. Digest da imagem:
sha256:d372430897763a95b471898d349af004525ae234003fb350e7f5538fbaaf1655.
Worker process completo e n8n permanecem gates de T24.

Leitura humana T9: GET `/api/v1/conversations/:conversationId/media/:mediaId/content`
exige sessão e conversation.read, com draft restrito a autor/admin. Serve200
completo ou206 por Range único fechado/aberto/sufixo; inválido416 traz
Content-Range `bytes */size`. Cache é private,no-store e nosniff obrigatório.
Attached permanece legível após oito dias e encerramento. HEAD e GET conferem
variante, tamanho, MIME e hash armazenados; leitura usa streams bounded.
Timeout/erro temporário503 conserva estado e quota e permite recuperação em
nova leitura. MissingObject usa CAS version/key/hash para lost410, sem liberar
quota. Erro após início dos bytes encerra a conexão, sem expor chave em log.

Rollback de entrada: CHAT_MEDIA_ENABLED=false impede POST novos uploads.
CHAT_MEDIA_READ_ENABLED=true mantém status/conteúdo do histórico com a mesma
configuração de DB/auth/spool/key e MEDIA_S3_*. A flag de leitura não habilita
admissão. Desligar ambas remove rotas; isso representa indisponibilidade da
leitura e não deve ser usado como rollback normal depois de anexos enviados.
T11 também aplica CHAT_MEDIA_ENABLED a novos envios humanos de mídia, mantendo
texto. Nenhuma flag remove vínculos, objetos ou cobrança retida.

Requisitos MED-16, MED-19, MED-23; tarefa T1 de
[INBOX-MEDIA-1](../../.specs/features/inbox-media-rustfs/tasks.md).
O smoke comprova operações na imagem testada. Não comprova backup, recovery
ou prontidão do deployment remoto. A promoção é gate de T23.

## Escopo e isolamento

Usar `crm-silmer-chat-media-dev` para bytes sintéticos e
`crm-silmer-chat-media` para operação. Ambos são privados e sem lifecycle de
expiração. Mídias enviadas permanecem salvas até nova decisão do usuário.
`hermes-backups` pertence a outro uso: não listar objetos, ler, gravar,
alterar policy, mover volumes ou armazenar backup do CRM nesse bucket.

A versão configurada observada no EasyPanel é
`rustfs/rustfs:1.0.0-alpha.99`. Testar essa imagem em ambiente local isolado,
conforme autorização posterior do usuário para Docker local. Registrar
digest real do container testado, origem do digest e versão. Tag de imagem
não comprova digest nem versão efetivamente executada em produção.
Não atualizar RustFS compartilhado como efeito do smoke.

## Acesso mínimo

Preparar identidade específica para cada ambiente. Não usar root no CRM.
O operador cria bucket e credencial sob autorização vigente. Guardar
segredos no gerenciador de secrets e injetá-los no processo; não imprimir
variáveis, copiar do painel para documentação ou versionar `.env`.

Policy de exemplo para a identidade DEV, sem acesso ao bucket operacional:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLifecycle"],
      "Resource": ["arn:aws:s3:::crm-silmer-chat-media-dev"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::crm-silmer-chat-media-dev/*"]
    }
  ]
}
```

O smoke faz HEAD no outro bucket CRM para exigir 403. No loopback local,
aceita também o bucket vazio sintético `crm-silmer-smoke-denied-local`.
Os dois buckets
devem existir, para o teste não confundir inexistência com isolamento.
Não usa objetos desse outro bucket. A API operacional e o worker terão
papéis próprios em T3/T23; esse exemplo é somente para homologação DEV.

HEAD de bucket verifica ListBucket, não GetObject. Antes do smoke, o operador
provisiona um canário sintético conhecido no bucket negado e comprova sua
existência com HEAD 200 usando acesso administrativo fora do CRM. Injetar
sua chave `compatibility-canary/UUID` em `RUSTFS_SMOKE_DENIED_OBJECT_KEY`.
O smoke exige HEAD e GET desse objeto com 403 pela credencial limitada,
sem criar ou excluir o canário negado. Seu operador faz cleanup após o teste.

A alpha.99 usa a action IAM `s3:GetBucketLifecycle`, conforme
[enum da versão](https://github.com/rustfs/rustfs/blob/1.0.0-alpha.99/crates/policy/src/policy/action.rs).
`s3:GetLifecycleConfiguration` foi rejeitada como action inválida nesse
runtime local. A operação HTTP continua `GET /{bucket}?lifecycle`.

## Execução

Injetar estas variáveis sem colocá-las na linha de comando ou logs:

| Variável                       | Valor/contrato                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| RUN_RUSTFS_LIVE_SMOKE          | `yes`, após revisar o escopo                                                          |
| MEDIA_S3_ENDPOINT              | Origin HTTPS S3, sem path/query/credenciais                                           |
| MEDIA_S3_REGION                | Região exigida pelo serviço, normalmente `us-east-1`                                  |
| MEDIA_S3_BUCKET                | Bucket CRM da identidade do teste                                                     |
| MEDIA_S3_ACCESS_KEY_ID         | Credencial limitada do ambiente                                                       |
| MEDIA_S3_SECRET_ACCESS_KEY     | Secret da credencial limitada                                                         |
| RUSTFS_SMOKE_DENIED_BUCKET     | O outro bucket CRM existente                                                          |
| RUSTFS_SMOKE_DENIED_OBJECT_KEY | Chave opaca compatibility-canary/UUID do canário sintético conhecido no bucket negado |
| RUSTFS_RUNNING_IMAGE_DIGEST    | `sha256:` mais 64 caracteres hex, observado no runtime testado                        |
| RUSTFS_SMOKE_EVIDENCE_PATH     | Caminho local novo; padrão `var/rustfs-live-evidence.json`                            |

HTTP é aceito somente para `localhost`, `127.0.0.1` ou `[::1]`, para
homologação isolada. Endpoints externos exigem HTTPS. Capturar o digest
com inspeção do container/imagem local. No alvo EasyPanel, capturar seu
digest separadamente antes da promoção; a imagem local não prova o remoto.

```powershell
rtk npm run smoke:rustfs:live
```

O script usa SigV4 com path-style para um canário pequeno e não instala
SDK. O adapter da aplicação em T3 usará SDK fixado. O smoke verifica:

1. Ausência de lifecycle de expiração, sem alterar configuração.
2. PUT de bytes sintéticos com metadata SHA-256.
3. HEAD com tamanho/hash corretos.
4. GET com bytes exatos e hash SHA-256 correto.
5. GET Range com 206, bytes exatos e Content-Range.
6. Range fora do objeto com 416.
7. GET anônimo negado com 403.
8. HEAD no outro bucket CRM negado com 403.
9. HEAD e GET do objeto sintético conhecido no bucket negado com 403.
10. DELETE do canário próprio com 204 e HEAD posterior 404.

Evidence JSON só é escrito após todos os checks. Contém data, digest,
bucket CRM e resultados; não contém chave do objeto, segredo, URL ou dados
de cliente. Caminho já existente impede sobrescrita. O arquivo em `var/`
é local e não vira evidência versionada automaticamente.

Falhas de transporte são sanitizadas. Após qualquer tentativa de PUT,
inclusive resultado desconhecido, o finally tenta remover somente a chave
do canário gerada pela execução. Falha de cleanup exige reconciliação pelo
operador; não repetir indiscriminadamente nem varrer bucket. Se precisar
localizar um canário restante, revisar exclusivamente o prefixo sintético
`compatibility-canary/` no bucket do teste com o operador autorizado.

## Gates e promoção

Upload humano T7 exige CHAT_MEDIA_ENABLED=true, CHAT_MEDIA_SPOOL_ROOT próprio,
CHAT_MEDIA_BUCKET_ALIAS=chat-dev ou chat-operational e CHAT_MEDIA_QUOTA_BYTES
(DEV padrão 1 GiB). Envelope usa INBOX_MESSAGE_ENVELOPE_KEY com AAD
chat-media-filename:UUID. API/worker compartilham UUID relativo; roots absolutos
podem ser distintos. Não usar PRIVATE_MEDIA_ROOT para esse spool.

0029 reserva antes de bytes e limita 12 admissões/minuto por hash do token
crm_session canônico. Cookies extras/ordem não mudam o contador. Multipart
exige kind, origin, expectedVersion antes de file; arquivo vazio usa 422.
Replay aceito mede hash sem novo spool/reserva. Recebimento ativo/incompleto
usa 409; crash não libera quota. Somente remoção confirmada de receiving
permite release; consumed permanece para worker. Conclusão DB incerta consulta
ledger sob lock antes de cleanup; consulta indisponível preserva spool/reserva.
T22 consome admissões >24h sob lock/recheck e confirma remoção antes de release,
com deadline/guardas/intenção durável descritos acima.

Novo live T7: `rtk proxy node --test --test-concurrency=1 test/chat-media-upload-postgres-live.test.js`.
T8 amplia esse live com identidade/sessões reais. Status e preflight do upload
usam conversation.read; sessão ausente/inválida/expirada/revogada401,
origem/capacidade/ownership negados403, falha DB503. O modo401 é específico
da fronteira de mídia; leitores antigos mantêm o contrato anterior.

```powershell
rtk proxy node --test test/rustfs-live-smoke.test.js
rtk npm run validate:topology
rtk npm run test:recovery:mocks
```

Testes com transporte fake comprovam o harness, não RustFS. Arquivo de
evidência de teste local deve indicar `local-version-compatibility`.
No deployment alvo executar novamente com credencial limitada e digest
real; registrar `target-deployment`. Gate operacional continua pendente
até comprovar acesso mínimo, quota, backup externo, restauração e rollback
de T23. Não atribuir esses resultados ao smoke de compatibilidade.

Fontes: [matriz S3 RustFS](https://docs.rustfs.com/en/reference/s3-compatibility)
e [SigV4 S3](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
A documentação atual não substitui o teste da versão alpha.99.

## Pipeline local e runtime de mídia

Imagem existente recebe FFmpeg/ffprobe, clamav-freshclam e ca-certificates;
sem serviço novo. Base Node 24.20.0 permanece fixada por digest. FFmpeg
Debian 5.1.9 e ClamAV 1.4.3 foram comprovados com bytes sintéticos reais.
As licenças dos binários permanecem em `/usr/share/doc/` na imagem; revisar
atualizações de segurança do SO no gate T23. npm audit não audita esses binários.

Build baixa e testa assinatura-base genuína via freshclam (timeout de 180 s).
Worker executa freshclam no startup e a cada 24 h, timeout de 180 s, maxBuffer de 64 KiB,
sem NotifyClamd. Falha gera código técnico CLAM_SIGNATURE_REFRESH_FAILED e
não atualiza marcador de verificação. `.freshclam-verified` é publicado por
rename atômico apenas depois de freshclam com exit0 e do daemon substituto
confirmado pronto; prova checagem recente
quando a base já estava atualizada sem mudar seu mtime. Scanner exige base
instalada; marcador inválido/futuro/stale falha fechado. Sem marcador, usa
mtime da base; mais de 36 h impede liberação. Config não aceita entrada humana.

Diretório `/var/lib/clamav`, UID/GID 1000 (node), gravável só pelo updater.
Perfil T23 monta definições privadas compartilhadas entre API (scanner legado)
e worker. Volume novo contém/copia a assinatura-base da imagem; tmpfs
vazio exige download genuíno no startup antes da primeira liberação. API
não recebe permissão de refresh, e não deve usar marker sem base. Validar
permissões/mounts/read-only no deployment; estes testes locais não ativam remoto.

Limites por fase: scanner 60 s e libmagic 10 s por arquivo, ffprobe 10 s,
decodificação de timeline 30 s; encoder 120 s, threads=1, maxalloc=64 MiB,
protocolos locais. Entrada e saída são escaneadas e sondadas; gravação tem
teto de 300 s e 16 MiB em ambas. Orçamento máximo das fases locais: 340 s
(inclui libmagic duas vezes), além de filesystem,
DB e PUT; worker renova lease durante processamento. Nenhum Promise.race
abandona encoder em execução. Conversões/scan sequenciais por worker.

Medição de sessão com `/usr/bin/time -v`: CPU 64,01 s user e 5,78 s system,
69,86 s elapsed, RSS máximo de 989180 KiB, zero swaps para três formatos e negativa
de 301 s. Com a fronteira OGG de 300 s: 103,23 s elapsed, CPU 87,93 s user e
15,03 s system, RSS máximo de 989248 KiB, zero swaps. Recomenda-se limite
operacional de 2 GiB por worker para evitar OOM próximo de 1 GiB; confirmar
sob carga em T23. A reserva transacional cobre conjuntamente spool e objeto,
sem quota física separada fictícia; rascunhos têm prazo de 24 h para T22;
anexos enviados seguem preservados. Não executar scanner paralelo para
elevar throughput sem revisar orçamento e controle de concorrência.

Reproduzir bytes Chromium com `node scripts/generate-chat-media-recording-fixture.mjs`
e executar testes runtime com `RUN_CHAT_MEDIA_RUNTIME_TESTS=yes` e
`CHAT_MEDIA_CHROMIUM_FIXTURE` apontando para o WebM no mount. Som sintético
oscilador, sem uso de microfone real. Testes OGG de 300 s e WebM de 301 s medem timeline
decodificada; pré-skip/padding ou cabeçalho curto não alteram teto útil.

Fontes: [FFmpeg opções](https://ffmpeg.org/ffmpeg.html),
[freshclam configuração](https://docs.clamav.net/manual/Usage/Configuration.html#freshclamconf).

## Worker e contrato de admissão T7

Ativação explícita: `CHAT_MEDIA_ENABLED=true`. Sem essa flag, a fila nova não
é consumida. Worker usa `DATABASE_URL`, `CHAT_MEDIA_SPOOL_ROOT` e
`MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION`, `MEDIA_S3_BUCKET`,
`MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`. Produção exige HTTPS;
HTTP é permitido somente para loopback em teste. Bucket canônico determina
alias `chat-dev` ou `chat-operational`; mídia de outro alias falha fechado.
API e worker compartilham o spool privado; os roots absolutos podem diferir
nos runtimes, mas `spool_key` e `object_key` são apenas UUIDs relativos.

Producer usa jobType `chat_media.process`, queue `chat_media`, effectPolicy
`internal` e `chat_media_id`, sem message_id ou transient_media_id. Migração
0028 exige essa combinação. Criar mídia e job atomicamente na admissão;
preencher declared_mime_type, input_size_bytes medido, envelope cifrado do
nome, upload_command_id/fingerprint, kind/origin, UUIDs, alias/backend e
reservation_bytes com quota reservada. Estado inicial uploaded/pending.
Antes de consumir bytes, reservar duas vezes o limite do tipo para anexos,
ou três vezes 16 MiB para gravação; ajustar pela entrada medida depois do
streaming, sem confiar em Content-Length. Worker exige pelo menos duas
vezes a entrada de anexo, ou entrada mais duas vezes 16 MiB de gravação.

PostgresChatMediaRepository expõe acquire(job), prepare(job,row,metadata),
ready(job,row) e fail(job,row,reason), todos com fencing do claim/attempt e
CAS. Metadados preparados precedem o PUT; HEAD confirma hash/tamanho/MIME.
Cleanup confirmado precede ready e redução da reserva ao objeto final;
used permanece zero até T10. DB rollback ou cleanup incompleto preserva
reserva e permite HEAD/retry no mesmo registro. T22 libera reserva somente
após DELETE confirmado. Lease é renovado a cada 5 s; processamento é
sequencial. Assinaturas atualizam em background sem atrasar texto/heartbeat.

Reprodução isolada do teste combinado: gerar a fixture Chromium acima,
iniciar a imagem runtime com mount do repositório em `/workspace`, UID 1000,
limite de 2 GiB/1 CPU e tmpfs privado em `/tmp`; manter o nome do container
no prefixo `crm-silmer-media-test-`. Configurar TEST_DATABASE_URL para o
banco dedicado `crm_silmer_test`, as variáveis S3 sintéticas locais acima,
RUN_RUSTFS_LIVE_SMOKE=yes, CHAT_MEDIA_RUNTIME_CONTAINER com esse nome e
CHAT_MEDIA_USE_BUILT_RUNTIME=yes. Executar:

```powershell
rtk proxy node --test --test-concurrency=1 test/chat-media-process-postgres-live.test.js
```

São 13 cenários SQL e um ciclo real com duas mídias. Scanner/normalizador
vêm de `/app/modules` na imagem; handler/repository/SDK executam no host
contra DB e RustFS locais. Não é teste do deployment remoto. A imagem final
T6 tem digest `sha256:d372430897763a95b471898d349af004525ae234003fb350e7f5538fbaaf1655`;
o digest 7105b14c registrado em T5 contém somente o código até T5.

### T14: transporte humano por ID Meta

A versão canônica mvp-simple-12-media mantém a reserva original e seleciona
texto ou mídia somente quando send_authorized=true. Download CRM usa o ID
textual como um segmento encodeURIComponent, Basic exclusivo CRM, sem
redirecionamentos. O helper binário mede uffer.length antes do Crypto v2
SHA256; depois do hash, o fluxo restaura a referência binária do item pareado
do download. O multipart n8n 2.38.7 usa ormBinaryData/inputDataFieldName=data.
Não interpretar inary.data.data como base64 nem persistir cópias em JSON.

Upload Meta precede preflight JSON no mesmo endpoint CRM. Preflight válido
precisa coincidir em media_id/type/SHA/MIME/tamanho; imediatamente depois,
Meta/messages recebe somente ID e legenda para image/video. Áudio não ganha
legenda nem flag voice presumida. Upload/messages não têm retry; qualquer
erro ou resposta sem ID após invocar messages vai para unknown. Falhas
comprovadamente anteriores usam workflow.failed/before_message_send e a
allowlist T13, sem liberar uma nova reserva. Replays alcançam resposta sem efeito.

Fontes primárias n8n fixadas no tag n8n@2.38.7: Crypto.node.ts (hash perde
binary; dataPropertyName recebe digest), HttpRequest/V3/Description.ts
(multipart formBinaryData) e HttpRequest/V3/HttpRequestV3.node.ts (buffer
nativo e resposta file). O renderer e testes verificam o contrato; o runtime
real e ausência de resíduos são a entrega T15. Inventário canônico 51→68
nós, DEV 60→77, sem nós Wait e sem retirar cenários de teste anteriores.

Ativação Meta exige SILMER_META_MEDIA_HOMOLOGATED=true, versão explícita
SILMER_META_GRAPH_VERSION e phone ID numérico. Os endpoints oficiais atuais
não ficaram acessíveis nesta sessão (429/Internal Error). Artigo oficial
histórico de 2022 não prova limites/versionamento/voice em 2026. Homologação
atual e configuração dessas variáveis ficam como gate externo T23, pendente;
DEV simula exclusivamente os dois efeitos Meta após download/hash reais,
com preflight CRM real. Essa evidência não confirma entrega real ao WhatsApp.
