# Execução INBOX-MEDIA-1

## T25: regressão de altura ao anexar imagem (29/10/2026)

Requisitos MED-01/25/31. O composer crescia sem limite dentro da conversa
com altura fixa; imagem, legenda e toolbar ultrapassavam a borda inferior.
O CSS da Inbox limita a composição a 65% do painel e permite redução quando
o cabeçalho ocupa mais espaço. Somente a revisão tem rolagem, preservando
histórico e ações; sem alteração de upload, autorização ou envio.

Regressão integrada com PNG sintético 1200×1800 e nome longo em 1366×768,
1090×689, 390×667 e 390×440: os quatro cenários falharam antes da correção
por toolbar fora do painel e passaram após o patch. Conferem histórico com
ao menos 48px, geometria sem sobreposição/overflow horizontal, controles de
44px, legenda → anexar → gravar → enviar por teclado e remoção restaurando
foco e altura do histórico, sem envio automático. Capturas anexadas ao
resultado Playwright. A revisão independente confirmou a causa e a lacuna
dos testes anteriores, que mediam apenas o composer de texto.

Gates finais: `npm run validate` aprovado (1429 testes, 5 skips, build e
checks); `npm run test:e2e -- --workers=4` aprovado (346 testes, 7 skips);
regressão focal 4/4 após salvar capturas, com inspeção visual em 1090×689 e
390×440; Prettier, ESLint e `git diff --check` aprovados. A execução inicial
no sandbox bloqueou hard links temporários com EPERM; o gate completo passou
fora dele. `npm audit --audit-level=high` aprovado, com 1 ocorrência baixa e
2 moderadas preexistentes; nenhuma dependência alterada. Evidência local
sintética, sem alterar os gates externos de T24.

## T32: pipeline remoto para testes internos

Premissas confirmadas pelo operador: somente testes internos n8n; autorizados
bucket DEV privado, IAM separado, spool compartilhado e helper temporário.
Arquivos: runbook RustFS, tasks/spec/STATE, este registro e relatório independente.
Aceite: PUT/GET/DELETE e negativas, spool privado nos dois processos, schema,
scanner/health, upload/validação e leitura dos três tipos; sem SEND a clientes.

Configuração real em10/10/2026: bucket `crm-silmer-chat-media-dev` sem expiração;
API GetObject, worker Get/Put/Delete somente nesse bucket, sem root herdado.
Endpoint HTTPS existente e quota1GiB; flags true/aliaschat-dev somente para o
ensaio interno. Segredos não versionados. Configurações anteriores preservadas.

Helper `silmer-chat-spool-init` sem exposição/secrets; VolumeMount
chat-media-spool inicializado1000:1000/0700. Host path comprovado pelo mountinfo:
`/etc/easypanel/projects/espectro-mvp/silmer-chat-spool-init/volumes/chat-media-spool`.
Bind igual para API/worker em `/var/lib/crm-chat-media`. Helper parado; definição
e volume retidos. Proposta de bind `/var/lib/crm-silmer/chat-media` falhou por
path inexistente, sem criação ali. EasyPanel reaplicou0777; wrappers persistidos
nos dois serviços restauram0700 e verificam owner antes de exec node UID1000.
Probes confirmaram1000/1000/700 e flagtrue nos dois. Marcador worker lido pela
API; cleanup alcançou somente esse marcador sintético. Janela transitória0777
continua risco para promoção operacional, registrada no runbook.

Provas S3 reais: workerPUT/GET iguais e bucket alheio403; APIGet igual, Put403 e bucket alheio403;
GET anônimo403; Delete do próprio canário e Head404. Schema0030–0033 com
checksums/phase iguais, readiness do banco e `/api/health/ready` aprovados;
worker PONG, freshness genuína <=36h sem futuro e health aprovado.

PR157 merged rebase após7checks da revisão710ebff, masterd9e3a70.
Deployments EasyPanel18:01:02→18:01:11UTC registraram imagem runtime API/worker
`sha256:c30b13fab7c027118bdea0241c8d6d2123ec1725e135fa78011ba4c27a28f9d4`,
edge `sha256:0d894085e6705d967e576544a361b66c223c0ec5b16856c8c3eeb3bec485cbbd`.
Headers HTTPS observados18:03UTC: microphone(self), imgblob e mediablob. PNG16px decodificada;
MP3/MP4 de2s readyState4 sem error e ready/clean com Enviar anexo habilitado.
Operador permitiu microfone; tela iniciou/parou gravação, revisão ready, saída
OGG/Opus clean. Captura real observada não fecha todos os cenários T24.

Imagem/vídeo abriram pela rota HTTPS autenticada; imagem sem sessão401.
Conteúdo dos três tipos lido pelo runtime real da API/repository/store, para o
uploader: status200, tamanho e SHA256 iguais aos metadados; ator alheio403 nos
três. Navegação direta de áudio bloqueada pelo cliente do navegador Codex;
não alegar playback HTTP de áudio a partir dessa tentativa. Nenhuma sessão
criada nem mensagem enviada; drafts permanecem sob cleanup próprio >24h.

Provas locais ignoradas: var/T32-image-ready-proof.jpg, T32-audio-ready-proof.jpg,
T32-video-ready-proof.jpg, T32-recording-ready-proof.jpg, T32-api-iam-proof.jpg,
T32-worker-runtime-proof.jpg, T32-content-acl-proof.jpg, T32-api-schema-spool-proof.jpg,
T32-worker-put-get-marker-proof.jpg, T32-api-shared-marker-proof.jpg e
T32-worker-cleanup-health-proof.jpg e T32-worker-foreign-bucket-proof.jpg.
T32-api-spool-proof.jpg mostra estados do
banco; a prova de permissões está nas imagens schema-spool/shared-marker.
Essas imagens são evidência remota, não testes Docker locais. Rollback explícito
no runbook preserva leitura, bucket, spool, credenciais e vínculos. Antes de
SEND verificar workflow DEV publicado: bucket DEV sozinho não seleciona n8n.
T24, privacyP1, Meta e backup/restore continuam abertos; sem Verified global.

## T31: Incidente do edge e da ativação remota

Produção10/10/2026 servia microphone=() e CSP sem blob; tela preservava arquivo
após upload404. EasyPanel confirmou ausência de flag, spool e configuração S3
na API/worker; worker sem mounts. Nenhum segredo foi exposto na inspeção.

Patch local do edge: microfone self, blob somente img-src/media-src, upload17MiB
somente coleção `/api/v1/conversations/:id/media`, streaming sem ampliar outras
rotas. Configuração e regressões13/13; revisão independente e sensor3/3.
Suíte serial1010total/1007pass/0fail/3skips e build/tipos/lint/format exit0.
Primeira suíte concorrente teve timeout de3s em teste multipart preexistente;
reexecução serial passou sem alterar timeout/assertions/testes.

Docker Desktop local não iniciou; gate Nginx real promovido ao CI com bases
fixadas por digest e recursos descartáveis exclusivos. Runtime real e promoção
remota permanecem pendentes antes do fechamento. Plano de configuração separado
no runbook; não foi ligada flag sozinha nem reutilizada credencial de arte.

CI38072637559 falhou no pull ECR por rate limit, antes de executar Nginx.
O gate agora tenta ECR, cache GCR e Docker Hub, sempre com o mesmo digest
imutável. Falha de todas as fontes mantém o gate bloqueado. Incremental:
16/16 testes focais, tipos/lint/format e revisão independente aprovados;
sensor total5/5 detectados. Nenhuma assertion ou limite foi relaxado.

CI38073260116, job114274864563: Nginx real8/8, headers e sintaxe PASS;
upload16778240bytes200, limite17825793bytes413, subrotas/API comum1048577bytes413,
arte10486784bytes200 e11534337bytes413. Unit1013total/1010pass/3skips,
PostgreSQL e E2E210pass/7skips, build e scans das duas imagens aprovados.
T31 concluída; publicação do edge e configuração remota DEV permanecem
verificações distintas. Evidência remota:
https://github.com/romulosutil/crm-silmer/actions/runs/38073260116.

## T30: Segurança dos scripts locais no PR156

MED-20/23: limite de120requisições/minuto aplicado antes do hook de banco,
identidade do workflow local comparada a literal antes do uso, download validado
por hash/tamanho/MIME e OGG/Opus em memória. Prova JSON preserva somente hashes,
enums e números validados; não persiste DTOs arbitrários nem áudio recebido.
Artefatos históricos existentes permanecem preservados.

Validação completa `npm run validate` exit0, incluindo build, lint, tipos e
suíte unitária. Log ignorado var/pr156-security-gates.log.
Testes focais11/11 e revisão independente com sensor3/3. Evidência específica
em [validation-pr-security.md](validation-pr-security.md). Alert18 do CodeQL
é falso positivo documentado: chave sintética persistida pelo bootstrap enviada
intencionalmente ao IAM do RustFS no endpoint fixo loopback, redirect:error.
Classificação registrada no GitHub em10/10/2026 às16:32:48UTC, somente alerta18.
Nenhuma regra foi suprimida; checks remotos da nova revisão serão exigidos antes
do merge por rebase autorizado pelo usuário. T24 permanece pendente.

## T29: Clamd persistente no worker

Usuário autorizou clamd em10/10. Premissas: Docker local, worker existente,
1CPU/2GiB e contratos MED-06/14/26/30 preservados. Fronteiras alteradas:
scanner, daemon/supervisão, atualização de assinaturas, composição worker,
health, Docker/config, seus testes/helper e registros da entrega.
Resultado esperado: motor carregado uma vez por ciclo, menor espera pela
tela, malware/indisponibilidade/stale ainda bloqueados e marcador coerente.

O scan agora usa clamdscan/fdpass no socket privado, com data capturada antes
da execução. A atualização encerra o motor anterior, aguarda o novo e publica
o marcador. Health exige PONG. Queda recupera sob supervisão; SIGTERM encerra
os serviços e o daemon. Texto inicia antes do motor/CDN. Sem alteração de SQL,
API de mídia, frontend, n8n, storage, ACL, quota, idempotência ou retenção.

Gates: 13checks+build0; fullunit996total/993pass/zero fail/três skips antigos;
scanner/normalizador Linux reais2/2PASS, seis formatos, EICAR, MIME/codec,
gravação Chromium e limites300/301s. Scan final7/10ms vs9326ms anterior;
validação completa82/86ms. Pela tela quatro uploads prontos em1116–1163ms,
seguidos de sent/attached/completed, uma reserva/uma tentativa DEV15 cada.
Paridade byte a byte da imagem final confirmada após detectar e corrigir
imagem inicial anterior ao último import de timers. Nenhum bypass foi usado.

Ensaio de indisponibilidade: scan rejeitado scanner_unavailable, health1,
recuperação11271ms e health0. A primeira asserção do helper ignorado esperava
processing_failed; foi corrigida para o contrato existente scanner_unavailable.
Fonte da aplicação permaneceu igual. Pico1209327616bytes, abaixo2GiB.

Matriz de adequação:

| Critério | Teste / resultado | Necessidade |
| --- | --- | --- |
| MED-26: vírus e transporte | clamav-media-scanner.test.js:127 e :144, cleanfalse e rejeição | Obrigatória; não substituir por sucesso de chamada |
| MED-26: freshness coerente | clamav-signature-refresh.test.js:154 e :158, erro preserva marcador | Obrigatória; motor confirmado antes de atualização |
| MED-14: duas inspeções | recorded-audio-normalizer.test.js:119, saída Opus mono e duas validações | Regressão da normalização existente |
| T29: health/recuperação | clamav-daemon.test.js:26 e :151; smoke real health1→0 e novo scan | Critério explícito de operação |
| MED-30: pronto e envio explícito | navegador1116–1163ms e quatro callbacks sent | Confirma o resultado percebido pelo vendedor |

A relação inversa de cada asserção com seu requisito está no relatório
independente [validation-clamd.md](validation-clamd.md). Tests seguem AGENTS.md
e CONTRIBUTING.md. Não houve exclusão/skip novo nem enfraquecimento de teste;
expectativas clamscan foram migradas para o transporte clamdscan autorizado.
Revisão independente e sensor3/3 integram o fechamento desta tarefa.
T24/microfone físico, privacidade operacional, Meta e recovery externo pendem.

## T28: Validação sem repetição na mesma tentativa

UAT reportou demora, com envio já funcional. Medição sanitizada de quatro uploads
sem retry:24,20–28,86s atéready, fila0,55–0,96s. Scanner usa clamscan novo por
chamada, carregando a base; benchmark /dev/null levou10,31s mas exit2 (arquivo
especial), portanto prova de overhead, não scan limpo. Handler repetia validação
dos mesmos bytes antes prepare e antes PUT. Sem conteúdo pessoal inspecionado.

T28 mantém resultado completo apenas na variável local da mesma tentativa.
Metadados persistidos em retry nunca substituem validação nova. Gravação continua
validando entrada e saída normalizada. Metadados preparados devem corresponder à
validação; lstat garante arquivo regular/tamanho; store real verifica SHA/tamanho
no streaming, checksum S3 e HEAD. Lease, cleanup, quota e CAS preservados.
Nenhum scanner, assinatura36h, política de retenção ou infraestrutura alterados.

Gates: Fullunit serial878total/875pass/zero fail/três skips antigos;
13prechecks+type/lint/build0, Node heap128/semi4 por pressão de memória do host.
Focal independente67/67 e build0. Sensor: retry sem validação, stream com hash
ignorado e comparação MIME corrompida morreram por assertions; scratch físico e
cleanup isolados. [Relatório específico](validation-performance.md).
Logs ignorados: var/media-T28-unit-serial.log e media-T28-project-gates.log.

Worker atualizado localmente somente após fila idle e build canonical0:
imagem sha256:d12e8e175b023881c74f0bbba0485bf569b4078aafa26ac01f515e4e1de8d2f4.
EnvDigest/user/1CPU/2GiB/network/mounts iguais; API/n8n/RustFS/DBs não recriados.
Startup refresh ClamAV genuíno, sem reset de defs/volumes/chaves. Rollbackguard
para24f30677…0b8a disponível em var/media-T28-runtime.mjs; proof runtime-proof.json.

Browser real: mesma PNG117bytes via filechooser, SHA igual confirmado por SQL
boolean sem imprimir hash. Antes20,401s; depois15,481/13,509s atéready. UI botão
habilitado em16,645/14,531s; redução observada24,1%/33,8%, sem promessa universal.
Primeiro envio explícito resultou sent/DEV/reserva única/callback único; segundo
ficou ready sem mensagem. Rascunho do usuário estava ausente antes do envio teste.
Provas: var/media-T28-browser-final-dom.txt e browser-final-comparison-proof.json.

| Critério | Assertion localizada em test/chat-media-process-worker.test.js | Outcome definido | Coberto |
| --- | --- | --- | --- |
| MED-06/26/30: uma validação de anexo nesta tentativa | :220 `assert.equal(f.calls.validations,1)`; :219 bytes BYTES; :221 ready1; :222 SHA; :223 size; :224 MIME | Mesmo conteúdo aprovado e pronto após integridade, sem scan redundante | Sim |
| MED-14/26: entrada e saída de gravação | :236 validations2; :238 ready1; :239 audio/ogg; :240 bytes BYTES; :284 ready0/:285 infected | Saída aprovada preservada; saída infectada bloqueada | Sim |
| MED-06/26: retry preparado rescana | :249 validations1; :252 ready1/:253 SHA; :372 validations1; :374 ready0/:375 reason | Mesmo hash íntegro; scanner negativo bloqueia retry | Sim |
| MED-26: mutações pós-prepare | :358 puts0; :359 ready0; :360 reserva; :361 `assert.deepEqual(f.calls.failures,[reason])` | Arquivo, tamanho, hash ou MIME divergentes não publicam ready | Sim |

| Assertions / cenários | Âncora | Manter |
| --- | --- | --- |
| :219–225 e :249–253; anexo novo e retry | MED-06/26/30, Done when T28 | Sim |
| :236–240, :262–268 e :282–285; gravação nova/variante recuperada/infectada | MED-14/26, Done when T28 | Sim |
| :357–361 e :372–375; mutações/scanner negativo | MED-26, edge cases e Done when T28 | Sim |

Adequação específica PASS: outcomes e payload conferidos em store/normalizer
reais com dependências externas sintéticas, sem negativas removidas/enfraquecidas.
Diretório/junction negativo prova bloqueio, não scan físico. Testes seguem
convenções Node/test e RULES.md. T28 concluída; T24 física e PrivacyP1 permanecem.

## T27: Recuperação de validação e diagnóstico de microfone

UAT de 10/10 reproduzida pela tela do navegador integrado: arquivo
unavailable/stale_signatures impedia Enviar anexo; iniciar gravação retornava
NotFoundError. Windows enumerou somente saída LG ULTRAWIDE, sem entrada de
microfone. A mensagem antiga genérica ocultava essa distinção. Não houve
captura física bem-sucedida nem simulação de dispositivo na prova Browser.

Atualização legítima ClamAvSignatureRefresh.refresh() no worker built terminou
exit0, atualizando marker de07/10 00:35UTC para10/10 14:04UTC e definições
28145→28149. O mesmo rascunho virou ready/clean pelo retry natural, ainda sem
mensagem. Não foram alterados scanner, limite36h, IAM, dados ou volumes.
Doze attached tiveram HEAD200; os oito lost anteriores eram rascunhos com
cleanupintent, reservation0 e spoolNULL, expirados legitimamente após24h.
Não há evidência para atribuir o atraso do refresh a CDN ou suspensão do host.

MediaComposer oferece Atualizar validação somente para unavailable com quatro
motivos públicos; consulta a mesma mediaId, mantém preview/legenda e não
reenvia upload. Lost/rejected/motivo desconhecido continuam bloqueados.
AudioRecorder usa mensagens locais para NotFound/NotReadable/Security/Abort/
NotSupported, preservando foco e anexos. Cause.message e reason arbitrário não
são expostos. Doze E2Es novos; assertion de encoder antigo foi fortalecida.

Browser real, sem headless ou mock de API: Anexar arquivo abriu filechooser e
selecionou fixtures PNG/M4A/MP4 locais; ready liberou Enviar anexo; cada clique
explícito resultou em mensagem no histórico identificada DEV: envio simulado.
PNG e MP4 usaram legenda; áudio mostrou player. Provas ignoradas:
var/media-T27-browser-final-dom.txt, -browser-final.jpg, -browser-proof.jpg,
var/media-clam-refresh-safe-proof.json, var/media-storage-safe-inspect-proof.json.
A aba original foi recarregada somente após confirmar ausência de rascunhos
de arquivo/texto; a aba de prova mantém os anexos enviados e diagnóstico físico.

Gates: typecheck, lint, build, 13 prechecks, audit e diffcheck exit0; unit
serial865total/862pass/zero fail/três skips antigos. Focal inicial80/80. Focal final81casos:80pass e um crash do browser em AxeBuilder; rerun exato1/1pass. FullUI
195pass/sete skips antigos/três falhas em fixtures existentes; exact --last-failed
passou3/3 sem alterar assertions/timeouts. Não declarar FullUI clean198.
Logs: var/media-T27-unit-serial.log, -focal.log, -final-focal-corrected.log, -final-focal-rerun.log, -full-ui.log,
-full-ui-rerun.log, -format.log e -prechecks.log.

Invocação adicional final-focal.log usou variável Firefox incorreta e omitiu
inbox-media:66pass/1launchfail. Corrigida a invocação, nenhum teste foi alterado
para passar. Preservados todos os logs, sem alegar suite integral limpa81.

Revisão de adequação: resultados definidos pelas ACs, sem novas rotas ou
contratos de persistência. Assertions existentes preservadas; nenhuma negativa
removida, enfraquecida ou ignorada. Convenções de test/e2e e RULES.md mantidas.

| Critério / AC | Assertion localizada | Resultado definido | Coberto |
| --- | --- | --- | --- |
| MED-11/25: causa pública, foco e anexo disponível | test/e2e/audio-recorder.spec.js:240 `toHaveText(message)`; :243 `toBeFocused()`; :244 `toBeEnabled()` | Mensagem local exata; foco em Gravar; arquivo habilitado | Sim |
| MED-11: nenhuma mensagem por falha de captura | test/e2e/audio-recorder.spec.js:245 `toHaveLength(0)`; :246 `toHaveLength(0)` | Zero upload e zero envio | Sim |
| MED-11/13: encoder e liberação | test/e2e/audio-recorder.spec.js:259 `toHaveText(...)`; :267 `toBe(1)` | Erro seguro exato; track parada | Sim |
| MED-06/19/26/32: falha temporária recuperável | test/e2e/media-composer.spec.js:187 `toHaveText(message)`; :190 `toBeDisabled()`; :191 `toBeVisible()` | Motivo público; envio bloqueado; prévia preservada | Sim |
| MED-06/32: mesma mídia e legenda; envio explícito | test/e2e/media-composer.spec.js:198 `toHaveValue('Legenda preservada')`; :199 `toHaveLength(1)`; :200 `toHaveLength(0)`; :205 `toEqual({mediaId: 'media-1', caption: 'Legenda preservada'})` | Um upload, zero envio antes do clique, payload exato após clique | Sim |
| MED-19/26/32: terminal ou motivo desconhecido | test/e2e/media-composer.spec.js:223 `toHaveText(...)`; :228 `toBeDisabled()`; :231 `toHaveCount(0)`; :232 `toHaveLength(1)`; :233 `toHaveLength(0)` | Mensagem pública; bloqueio; sem retry ou envio | Sim |
| MED-06/32: legenda digitada antes da resposta unavailable | test/e2e/media-composer.spec.js:831 `toHaveValue('Legenda antes da falha')`; :836 `toBeDisabled()`; :839 `toBeEnabled()`; :840 `toHaveLength(1)`; :841 `toHaveLength(0)` | Texto preservado; um upload; nenhum envio; retry disponível | Sim |
| T27: runtime e tela | var/media-clam-refresh-safe-proof.json; var/media-T27-browser-final-dom.txt | Refresh legítimo; PNG/M4A/MP4 enviados DEV; captura real falha por ausência de entrada | Sim, captura bem-sucedida permanece T24 |

| Assertions / cenários | Âncora | Manter |
| --- | --- | --- |
| audio-recorder.spec.js:240–246; cinco erros de captura | MED-11/25, edge cases de captura da T27 | Sim |
| audio-recorder.spec.js:259–267; encoder existente fortalecido | MED-11/13, liberação de recursos | Sim |
| media-composer.spec.js:187–208; quatro motivos públicos | MED-06/19/26/32, edge cases unavailable da T27 | Sim |
| media-composer.spec.js:831–841; status bloqueado até preencher legenda | MED-06/32, preservação antes da primeira resposta de falha | Sim |
| media-composer.spec.js:223–233; lost e motivo desconhecido | MED-19/26/32, edge cases terminais da T27 | Sim |

Adequação PASS específico: outcomes e payload conferidos, sem assertions rasas
ou testes fora do escopo. Verifier independente em validation-ux-recovery.md:
baseline80/80 na repetição, cinco faults mortos por assertions reais e isolamento
completo. Timeout inicial, faults não qualificáveis e limites físicos registrados.
Iteração2 acrescenta teste determinístico de legenda anterior à falha:1/1pass,
M6 original morto pela assertion exata:831; gap de cobertura resolvido,
isolamento e cleanup novamente comprovados. Nenhuma fonte de produto mudou.

T24 permanece pendente do dispositivo físico e avaliação humana. PrivacyP1
n8n, WhatsApp/Meta e recuperação operacional continuam gates separados.

## T26: Recusas conhecidas de envio — finding MED-32

O Verifier independente revisou86ab0a1: baseline59/59, unit862/0/3, cinco
faults comportamentais mortos por assertions e isolamento do scratch comprovado.
Verdict restrito T25 foi FAIL porque403/409 conhecidos de envio recebiam texto
genérico de resultado incerto. T26 corrige esse finding sem alterar API/SQL.

Somente MediaComposer e seu E2E mudam no produto. Uma recusa é classificada
apenas por ApiError, accepted=false, código público em allowlist e status
conhecido. Nenhum cause.message/problem.detail é exibido. Recusas recuperáveis
preservam anexo, preview, legenda, payload e chave originais para retry explícito.
400/404/409/413/422 que exigem revisão bloqueiam retry cego e mantêm remover
disponível;409 não inventa um subtipo, pois o contrato INBOX_CONFLICT agrega
mudança da conversa, mídia e chave. Rede,5xx e código desconhecido continuam
tratados como resultado incerto, sem nova chave automática ou duplicação.

RED403 reproduzido antes do fix. Focal37/37 passou depois (27 casos anteriores
e10 novos), sem skips ou relaxar assertions, além de types/lint/format.
Matriz das oito recusas em test/e2e/media-composer.spec.js:643 exige texto
correspondente, preview/legenda preservados, ausência de canária privada,
payload/key iguais no retry e remoção/foco nos bloqueados. Dois casos incertos
em:705 preservam tentativa original para503 e409 com código desconhecido.
O relatório validation-ux.md é atualizado pelo Verifier somente após novo
commit e reexecução de baseline/sensor; T24 e aceite humano seguem pendentes.

FullUI T26 passou187/187, sete skips preexistentes, zero falhas/retries efetivos
(var/media-T26-e2e.log; workers1, retries1 disponível mas não acionado).
O runner reconstruiu o frontend final; não houve alteração de timeout ou
assertions para obter esse resultado. Unit/backend862/0/3 e prova real da T25
permanecem aplicáveis, pois a mudança T26 restringe-se ao tratamento de recusas
da UI e seus testes. Referências históricas de adequação T25 abaixo correspondem
ao commit86ab0a1; o relatório independente final cita as posições do novo HEAD.

## T25: Correção da UAT do composer

Os cinco problemas reportados na UI4183 originaram MED-30..32. A demo anterior
permitia gravar/revisar, mas tinha admissão de mídia desativada; por isso a etapa
manual Preparar falhava e Enviar anexo não habilitava. A ponte local agora usa
API3013/Origin4183 e o perfil completo com worker Linux, ClamAV, RustFS privado
e n8n DEV. Origin4193 continua recusado403; CSRF não foi relaxado. DB15434,
volumes/chaves e assets históricos foram preservados.

MediaComposer inicia upload/validação ao selecionar ou parar a gravação; mantém
prévia e legenda editável, sem criar mensagem até a confirmação explícita.
Picker nativo fica oculto atrás de botão temático operável por teclado. Inbox
e AudioRecorder compõem a mesma toolbar, um envio contextual e ferramentas
separadas por gap; envio fica à direita mesmo quando há quebra de linha.
HTTP401/403/404/413/429/503 explicam recuperação, conservando arquivo e chave.
READY em background não rouba foco do player/legenda. Retry incerto preserva
o payload imutável e a chave original; ACL, abort e descarte continuam cobertos.

O smoke da nova UI com backend real encontrou GET200 state=uploaded antes de
o worker mudar para processing/ready. O polling anterior aceitava somente
processing e encerrava com MEDIA_INVALID_STATE, embora o objeto terminasse
READY no banco. T25 corrige a espera para ambos os estados transitórios,
sem habilitar envio antes de ready; a regressão cobre uploaded→processing→ready.
Não houve mudança de API, autorização, CSRF, worker ou contrato de estados.

### Gates T25

Prechecks de validate (format, typecheck, lint, boundaries, tokens, topologia,
recovery/catálogos) passaram. O runner unit paralelo esgotou memória nativa;
os mesmos testes com `node --test --test-concurrency=1 test/*.test.js` passaram:
862 pass, zero fail e três skips antigos (var/media-T25-unit-serial.log).
Build passou (var/media-T25-build.log); os runners E2E reconstruíram a UI final.
27/27 media-composer focais passaram, incluindo uploaded→processing→ready.

FullUI final, workers1:176 pass, sete skips antigos e um timeout durante axe
do player áudio inalterado. `--last-failed --workers=1` repetiu exatamente esse
caso sem alterar fonte/assertions e passou em926ms, exit0. Não houve mudança
de timeout, skip novo ou redução de assertions. Logs: var/media-T25-e2e-closure.log
e var/media-T25-e2e-retry.log. npm audit:zero vulnerabilidades. Spec/tasks strict:
zero erros/avisos. As provas de banco e scanner anteriores permanecem válidas;
T25 altera somente composição/frontend e configuração da demo local.

Smoke final da nova Vue na UI4183: login pela tela, conversa sintética atribuída,
seleção PNG99bytes, legenda digitada, upload/validação automática, sends0 antes
do clique e botão habilitado após ready. Clique único gerou POSTmessage202,
callback real sent/dev e legenda no histórico. GET privado200 e Range206
conferiram bytes/hash exatos. Prova var/media-T25-real-ui-proof.json, log
var/media-T25-real-ui-smoke.log, screenshots ready/sent. Leituras finais usam
fetch do próprio navegador sintético com sessão e headers normais; helper HTTP
separado não compartilhou a autenticação esperada e foi substituído, sem mudar
guard de autorização. Nenhuma voz/hardware físico foi automatizado.

Snapshot4183 contém JS index-D3qsyGDq.js e CSS index-WPE6QDnE.css, HTTP200 e
bytes iguais ao build; indexSHA256
0a0c7ccef7f804eb96cef559032a1332891c92028dbd638e2c83b03c7ca89b0e.
Inspeção no in-app Browser confirmou toolbar e foco no tema claro/escuro,
mensagem sintética DEV no histórico e controles separados. T24 permanece
pendente de nova UAT humana; a revisão T25 não declara toda a feature Verified.

### Adequação T25

| Teste/assertion                                                                                                                                    | Resultado exigido                                       | Rastreabilidade |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------- |
| `test/e2e/media-composer.spec.js:446`: uploads length1, sends length0, caption mantém valor/foco e payload final                                   | Upload automático sem envio implícito, legenda editável | MED-30/31       |
| `test/e2e/media-composer.spec.js:500`: player focused após ready, sends length0                                                                    | Validação não interrompe revisão                        | MED-25/30       |
| `test/e2e/media-composer.spec.js:524`: mensagem específica, preview visible, send disabled, keys iguais nas duas tentativas                        | Falha recuperável sem perda/duplicação                  | MED-32/06       |
| `test/e2e/media-composer.spec.js:551`: hidden input, Enter abre picker, botões44px, scrollWidth<=innerWidth, axe=[]                                | Picker temático, teclado, tela estreita                 | MED-25/31       |
| `test/e2e/inbox-media.spec.js:493`: único envio contextual, text draft restaurado, distância2D>=8px, dimensões>=44px, envio à direita em1280/390px | Composição familiar e espaçamento responsivo            | MED-31          |

Teste novo de gap inicialmente assumiu uma única linha horizontal. A screenshot
mostrou wrap legítimo e gap vertical12px; corrigido para distância entre
retângulos em dois eixos, mantendo mínimo8px e falha em sobreposição. A mudança
de interações Preparar→validação automática deriva da UAT explicitamente pedida,
sem remover/skip/relaxar casos negativos, segurança, idempotência ou lifecycle.

## T24: Evidência automatizada built; UAT física pendente

MED-01..29: matriz completa e fronteiras em docs/runbooks/chat-media-uat.md.
T24 permanece In Progress/Done desmarcado, sem Verified ou validationPASS.
Microfone físico ainda aguarda resposta humana na demo4183; Verifier final e
sensor somente após esse fechamento. Produto/SQL/UI permanecem no snapshot
4fa0ec1; esta entrega adiciona ferramentas opt-in e documentação de evidência.

Whole pipeline local: API multipart→worker construído/ClamAV/normalizer→RustFS
privado→binding/reserva→n8n DEV real→callback ao CRM. PNG/MP3/MP4/recording sent;
nenhum ready semeado e nenhum hosthandler substituto. Inbound setup usa endpoint
real e atribuição sintética de vendedor. Original auto-stop300s com relógio real
e hardware fake decodifica299970ms; normalizado GET OGG1543526bytes, Opusmono48k,
FFprobe299.976500s/padding, FFmpegdecode0. Original301008ms rejeitado invalid_format,
send409. Replay mantém uma mensagem/comando/mídia/reserva. Timestamp sintético8dias
mais fechamento e scheduler built65s conservam quatro attached/hashes.

### Adequação T24

| Requisito/caso | Fonte/assertion atual | Discrimina |
| --- | --- | --- |
| MED-01/02/03/05/23 | scripts/media-built-local-smoke.mjs:133 upload202; :196 deliveryMode dev; :212 contagens unitárias; :221 GET bytes exatos | Ready seed/handler host, callback fictício, duplicação |
| MED-12/14 | mesmo script:230 SELECT duration/MIME/origin/hash; :241 duração não nula e assertions seguintes; var/media-T24-built-pipeline-proof.json e GET normalizado/FFprobe | Number(null)=0 aceito, formato/sha variante incorreto |
| MED-06/16/17/18/15 | mesmo script replay/401/403/206/416 e retenção final; media-T24-full-built-final.log exit0 | ACL ausente, bytes Range incorretos, expurgo attached |
| MED-21/24 | scripts/media-built-local-fault-smoke.mjs:280 failed/outcome_unknown; :291/292 flags false; :294 código preflight; replay e contagens subsequentes | Efeito após preflight recusado ou retry cego após unknown |
| MED-23/restauração | mesmo script:83/84 active+published; :144 export fault diferente; :375 finally compara digest restaurado | Fault não efetivo/importer canônico, workflow deixado alterado |
| MED-17/playback | var/media-T24-playback-codecs.mjs/proof/log, oito pares e Range206/seek/play | Browser não decodifica ou cache mascara fixture; UI HTTPfixture separada da API real |
| MED-20/gate produção | var/media-T24-privacy-inventory.mjs/proof/log, categorias sem valores | Savesnone interpretado como ausência de persistência inicial |

Logs/provas ignorados preservados: media-T24-full-built-final.log (fonte principal
permanente exit0), media-T24-fault-callbacks-final.log (código funcional ignorado
promovido com guard/JSDoc/format), media-T24-playback-codecs-final.log (probe
observacional real ChromeWindows/FirefoxLinux). Runtime API/worker digest
24f30677faab7d95739ab66f7cc0f8d9bb3dc177cf08a5ddf482a50942eb0b8a.
Fault efetivamente ativo provado; export nodes/connections/settings antes=depois
5f4275e77151cc79dfb600ed7809acb53ee57bede0caf5839f7226ef1e45e395.
Expectativa inicial errada MEDIA_PREFLIGHT_REJECTED ajustada somente na nova
fixture ao branch canônico MEDIA_PREFLIGHT_UNAVAILABLE; contrato preservado.
Primeiro fault restaurado automaticamente pelo importer foi diagnóstico de fixture.
403 usa ator autenticado sem função operacional e restaura finally: baseline
permite vendedor ativo ler attached do Inbox, não foi alterada.

P1 externo confirmado: execution_data n8n PostgreSQL persiste recipient20,
caption16 e header Basic21 em23 linhas soft-deleted. Categorias de bytes/binary,
filename/objectkey0; logs do ensaio sem canárias nas categorias examinadas.
Nenhum valor de Basic foi impresso/salvo na evidência. Soft-delete/pruning não
comprovam expurgo seguro/WAL. Bloqueada ativação com dados/credenciais operacionais
até minimização/redação+expurgo/readiness reais; DEV sintético não elimina gate.
Matriz/runbook distinguem testes efetivos, fixtures, browsers e pendências.

Gates de produto preservados no snapshot4fa0ec1: Live131/131 zero skips,
UI166pass/7skips antigos(total173), Quick862pass/3skips antigos(total865).
Gates finais do patch de evidência: formatcheck/types/lint/boundaries/tokens/build
exit0, var/media-T24-structural.log; git diff --check0, ConventionalCommit checker0.
Spec strict0errors/0warnings; tasks strict inicialmente0errors/1warning T23
(exit1): interrompido antes de commit. Fronteira T23 refinada para seu resultado
único operacional e entrypoint Where scripts/dev-media.mjs, com lista completa
dos outros18arquivos em Supporting files e racional no GranularityCheck.
Histórico4fa0ec1/ADRs/escopo preservados; rerun strict0errors/0warnings exit0.
Sem repetir Live/UI por produto intacto.
Primeiro lint dos novos harnesses encontrou globals Node24 e variável ready
não usada: declarados via globalThis, await preservado e sem relaxar assertions.
Inicialização state agora independente de arquivo T23 dispensável; assertions e
caminho inbound permanecem os mesmos. Hashes dos artefatos em
var/media-T24-proof-hashes.json. Nenhum gate externo é inferido desses checks.
Demo4183 intacta e perfil4193 restaurado/disponível; evitar login humano4193
enquanto sessão4183 pendente (cookies por host compartilham portas).

## T23: Perfil operacional local, capacidade e recovery

MED-15/19/20/28: startup opt-in `dev:media` constrói API/worker existentes em
perfil Docker isolado crm-silmer-media-local, com DBs, objetos, chaves, spool e
definições persistentes. Endpoints HTTP internos são loopback por namespace
RustFS compartilhado; papéis mínimos distintos, sem root em API/worker/n8n.
Build context exclui var/tmp (tooling, capturas e secrets locais). Secrets
persistentes são reutilizados; ausência com volumes existentes falha antes de
gerar arquivos/chaves/up. README canônico de texto e política legada preservados.

API limita dois pipelines por bucket sob quota lock, incluindo sessões distintas.
Receiving recente3min/guard futuro e job pending/retry/processing/guard futuro
ocupam slot; ready sem guard libera. Estado terminal não prova writer fechado.
Receiving órfão com grace expirada libera slot, mantendo quota/bytes até cleanup
confirmado >24h. Runtime fixa capacidade2; fixture da prova antiga de bytequota
usa capacidade12 explicitamente para isolar aquele limite, preservando assertions.
Replays aceitos passam com quota/capacidade cheia sem novo slot/reserva.

Reds reais novos: terceiro pipeline aceito e três admissões concorrentes aceitas
antes do guard; receiving antiga bloqueava global429 mesmo após grace segura.
Casos passam após enforcement. Fixture HTTP de rollback assumiu upload403,
mas contrato existente desabilita a rota (app.js275), logo404; corrigida a
fixture sem alterar esse contrato. Também provou novo POSTmessage-media403.

### Adequação e operação T23

| Cenário/requisito | Evidência/resultado nativo | Discrimina |
| --- | --- | --- |
| Capacidade MED-28 | test/chat-media-upload-postgres-live.test.js:129/130 terceiro429 e quota igual; :152/153 exatamente2admitidas/1rejeitada | Ausência de contador e corrida entre sessões |
| Writer terminal/replay MED-28 | mesmo arquivo:183 guard futuro429; :189/190 replay mesmoID, counts iguais com quota cheia | Liberar slot apenas por status job; dupla cobrança |
| Receiving órfão MED-28 | mesmo arquivo:214 guard futuro429; :218/223/227 reserva2x→3x e três ledgers receiving após grace | Bloquear24h sem processamento; apagar quota indevidamente |
| Chaves originais | test/media-development-profile.test.js:14/20 missingkey+volume rejeita e root continua vazio; :69/70 restart conserva e estado incompleto rejeita | Regeneração silenciosa de AES/N8N/root |
| Papéis/config privada MED-20 | mesmo arquivo:56/61/62/64 papéis diferentes e nenhum root/secretS3 no n8n; :47/48/52 somente loopback | Sharedroot ou hostnameHTTP indevido |
| Roots/flags | mesmo arquivo:32/36/40 entradaoff/readon; :77/78/79 roots isolados; :91/92 nativebinarydefault/concurrency1 | Rollback perder leitura, raiz transitória compartilhada |
| IAM alpha99 real | var/media-T23-head-missing.mjs: API/worker bucketCRM UUID ausente404, bucket estranho403, quatro respostas | 403 interpretado como missing; ampliar permissões sem prova |
| Startup/restart built | var/media-T23-startup.log / media-T23-restart.log / media-T23-reactivate.log: migrations, API/worker/n8n saudáveis; API3013/edge4193/n8n5688 HTTP200 | Hosthandler ou reset de DB/volume/chave |
| Definições/spool | Docker inspect/stat: UID1000 roots0700, API clamav RW=false, main.cvd/daily.cld/bytecode.cvd e fresh marker real | Volume vazio mascarando baseline; writer sem permissões |
| Rollback funcional MED-15/19 | var/media-T23-profile-smoke.mjs e media-T23-rollback.log: upload202→builtworker/scanner→RustFS→binding202; off mantém attached200 e Range206 exato, upload404 e novo send403 | Ler histórico exigir entrada ligada; falso ready sem worker |
| Texto durante429 MED-28 | var/media-T23-capacity-http.mjs/log: dois uploads202, terceiro429 sem quota mudar, texto202; somente worker dedicado pausado<1s para pending determinístico e retomado | Saturação mídia bloquear texto/reservar terceiro |

Runtime local reconstruído usado na prova:
sha256:24f30677faab7d95739ab66f7cc0f8d9bb3dc177cf08a5ddf482a50942eb0b8a.
API/worker2GiB/1CPU, n8n2GiB/1CPU/concurrency1, RustFS1GiB/1CPU;
decoder serial. Pico de startup observado worker814784512bytes e n8n882589696;
isso mede startup, não stress de gravação300s. Prova built de PNG não confirma
callback: workflow estava inativo e entrega não é alegada. Wholeworker/normalizer,
DEV callback, browsers/codecs e microfone físico permanecem T24.

Gates: validate862pass/3skips antigos(total865), UI166pass/7skips antigos(total173)
workers1/FirefoxLinux disponível; Live integral131/131, zero skips,88,8s;
upload focal19/19 (15antigos+4novos). Topology/recovery14/14 mocks mantêm oito
blockers, Privacycatálogo4/4 e validadores verdes, audit0. Logs ignorados
media-T23-{validate,e2e,live,capacity}.log. UI antes do ajuste final de receiving
antiga; fontes/componentes UI intactos, SQL/HTTP real e Live cobrem esse ajuste.
Validate final posterior confirma source atual; contagens sem skips novos.

Runbook e sínteses RULES/ARCHITECTURE/ABOUT/TECHNICAL-DESIGN/EASYPANEL distinguem
classe preservada implementada da política legada sete dias/fim da jornada.
Plano de migração exige copiar/scan/hash/vínculo antes de cancelar DELETE por
item. Inventário/migração remotos, IAM/digest/capacidade do alvo, backup externo,
restore isolado, PII inicial n8n e Meta/DPA são gates pendentes explícitos;
nenhum upgrade/deploy/mutação remota, nenhum recovery por mocks, nenhum Verified.
Commit T23 atualizado para feat(ops), refletindo runtime/enforcement entregue.

## T22: Cleanup de rascunhos com writers protegidos

MED-15/27: o worker existente inicia scheduler de rascunhos, sem expurgar mídia
vinculada. Rascunhos sem message_id e com mais de 24h são congelados unavailable
por intenção durável antes de qualquer DELETE. Remoção e quota são confirmadas
em etapa posterior; rollback depois do DELETE não restaura ready vinculável.
Falha de spool, intermediário, objeto ou SQL conserva a reserva para retry.
Migration expand 0030 adiciona intenção e prazos, sem alterar migrations antigas.

Upload tem deadline de 120s; lease advisory de sessão não mantém BEGIN durante
streaming. Fecha writer antes de liberar conexão e executar complete/release,
inclusive com pool de uma conexão. Worker guarda decoder/PUT pela mesma chave;
perda de heartbeat ou conexão aborta e espera fechamento físico. Prazo persistido
de três minutos no upload e quinze no processamento protege a perda da sessão;
ambas etapas do cleanup revalidam o prazo. Fila real recupera job expirado antes
de cleanup; status terminal isolado não prova writer encerrado.

Intermediários do normalizer usam UUID da variante no nome do diretório.
Cleanup valida UUID, sufixo e caminho absoluto antes de rm recursivo; conserva
outras variantes e diretórios desconhecidos. Diretórios legados sem UUID
precisam de reconciliação operacional em T23. Pool worker padrão dez, mínimo
dois para guarda e consultas/heartbeat; somente upload provou pool de uma.

Reds discriminantes: deadline inexistente deixava upload pendente; composição
não iniciava cleanup; heartbeat perdido permitia DELETE enquanto decoder ainda
vivia; intenção não durável permitia restaurar ready após DELETE/rollback.
Helper Linux inicial usando AbortSignal nativo ignorava killSignal no abort e
travava filho resistente a TERM. Helper próprio agora usa SIGKILL, espera close
e remove listener, preservando erro original quando não cancelado. Linux real
Node24.20.0 passou 2/2 (abort 67ms, timeout 1022ms) em container próprio sem rede,
256MiB/1CPU/UID1000; nenhum timeout publicado foi ampliado.

Primeiro Live integral deu 126/127: a fixture chamava recovery enquanto heartbeat
SQL podia manter lock; SKIP LOCKED corretamente não recuperava naquela rodada.
Fixture agora aguarda heartbeat real negar lease e exige dead_letter, sem mudar
o cleanup. Acrescentou spool real presente durante decoder vivo e ENOENT depois.
Mock novo de normalização omitia audioCodec; corrigido fiel ao contrato Opus,
sem relaxar validação. Esses dois erros eram da fixture, não defeitos atribuídos
ao código de produção. Contagens finais dos gates são registradas abaixo.

### Adequação dos testes T22

Referências ao snapshot desta entrega. `live` é
`test/chat-media-cleanup-postgres-live.test.js`; todos os cenários usam PG real
sintético, sem contar ausência de TEST_DATABASE_URL como aprovação Live.
DELETE S3 usa adapter de efeitos injetado; transporte RustFS real continua T24.

| Cenário/requisito | Assertion discriminante | Resultado exigido |
| --- | --- | --- |
| Rascunho jovem MED-27 | live:235/236/237 state ready, reserva100, efeitos[] | Sem DELETE precoce |
| Órfão antigo/retry MED-27 | live:246/255/256/260 reserva durante DELETE, lost, replay inerte | Quota só após remoção |
| Attached oito dias/legado MED-15 | live:274/275/276/277 vínculo, attached, used100, efeitos[] | Sweeper antigo não expurga |
| Corrida attach MED-15 | live:334/338/339 efeitos[] e message_id | Vencedor mantém bytes |
| Falha spool/S3 MED-27 | live:351/352/354/365/367 reserva100/unavailable, retry0 | Cobrança conservada |
| Decoder vivo sem heartbeat MED-27 | live:531/532/533/540/542 efeitos[], reserva33554532, access, depois0/ENOENT | Recovery não autoriza remover FD vivo |
| DELETE seguido de rollback MED-15/27 | live:569/570/571/572/573/578 unavailable, intent, reserva100, send409, zero mensagens | Nunca restaurar ready vinculável |
| Guardas duráveis e tombstone MED-27 | live:669/670/676/693/698/699/700/718/725 | Guard nas duas etapas; acquire não limpa intent |
| Crash do encoder MED-27 | live:764/766/770/776/777/778/782 | rm falho conserva; UUID próprio removido, outros intactos |
| Pool e morte de conexão MED-27 | live:821/822/827/883/893/894/895 | Dois uploads distintos; stream destruído e reserva0 |
| Deadline/FD antes quota MED-27 | test/chat-media-upload-lifetime.test.js:42/53/54/55/84/165/167 | close/rm precedem release; HTTP503 limitado |
| Filho Linux resistente TERM MED-27 | test/media-command.test.js:26/42/64/71 | ABORT_ERR e timeout SIGKILL; PID inexistente após await |
| Intermediário identificável MED-27 | test/recorded-audio-normalizer.test.js:90/102 | UUID no prefixo, nenhum temporário após sucesso |

Nenhum requisito marcado Verified. Pipeline built completo, UAT físico e gates
de ativação remota permanecem pendentes; Final Verifier independente após T24.

Gates T22: validate/Quick/Build 855 aprovados, três skips antigos, total858;
Live integral serial 127/127, zero skips, 87,1s, dez arquivos de migrations,
Inbox, comandos, schema, processamento, upload, binding, operação, integração
n8n e cleanup. Novo manifest `test:chat-media:cleanup:live` contém19casos reais.
Privacy explícito: validate:security-catalog, test:security-catalog4/4 e
validate:media-retention verdes; este último mantém política legada intacta.
Logs ignorados `var/media-T22-validate.log` e `var/media-T22-live.log` guardam
contagens; helper Linux executado com bind readonly dos dois arquivos atuais
e package.json na imagem crm-silmer-media-test-runtime, Node24.20.0.

Probe sintético independente do root usou componente AudioRecorder real,
Chrome151 e relógio real, sem clicar Parar: arquivo ignorado
`var/chat-media-chromium-autostop-300s.webm`, 4838047bytes, SHA256
98efa5465f58fb3a51aba3fdfa0bb0ee76e00ab6c2d462f26ab683dc2c46536f.
FFmpeg Linux decodificou299970ms com exit0; ffprobe Opus mono48k, WebM streaming
sem duração no header. Proof JSON adjacente e script media-boundary-autostop.mjs
preservados. Isso prova autostop original dentro300000ms; não substitui passar
essa fixture pelo built normalizer em T24. Limite301s negativo permanece.

## T21: Mídia integrada à Inbox

MED-01..03/08..13/25: Inbox compõe seleção, gravação e histórico no contexto
da conversa ativa. Upload/envio permanecem ações explícitas. Resposta antiga
de detalhe não substitui conversa nova; SSE de encerramento/transferência
invalida o draft. Captura e prévia são liberadas ao trocar a conversa. O modo
DEV aparece somente quando o DTO persistido informa deliveryMode=dev.

Reds factuais: revisão gravada seguida de imagem mantinha botão Descartar e
anúncio de gravação; resposta de detalhe já recebida, mas atrasada na resolução
de fetch, substituía a nova conversa. O teste de corrida retém a resposta real
e remove AbortSignal para discriminar o guard de controller/id, sem depender
apenas de AbortController. Corrigidos sem reduzir assertions publicadas.

| Critério / mapeamento inverso | Evidência file:line e assertion | Resultado exigido |
| --- | --- | --- |
| MED-01/02/03 conversa e envio explícito | test/e2e/inbox-media.spec.js:218/225 zero uploads/envios; :233 rota conv1; :236 payload expectedVersion/type/mediaId; :241 CSRF | Cada tipo usa conversa/versão/origem corretas, sem envio automático |
| MED-08 ownership | :250/253 controles disabled; :254 histórico visível | Outra pessoa não prepara/envia, histórico legível |
| MED-08 troca durante upload | :272 heading conv2; :273 preview ausente; :279 sends zero | Upload antigo não envia na conversa nova |
| MED-08 close/transfer por SSE | :300 input disabled; :303 botão enviar ausente; :304 sends zero | Mudança humana invalida draft stale |
| MED-09/13 troca durante captura | :322 tracks.stop=1; :325 Parar ausente; :326/327 uploads/envios zero | Captura encerrada sem envio |
| MED-10 revisão seguida de anexo | :343 imagem presente; :346 Descartar ausente; :352 anúncio ausente; :354 input focado | Imagem preservada, estado de gravação liberado |
| MED-25 texto/foco/axe | :370 reply focado; :371 payload texto; :382 input focado; :383 violations=[] | Texto conservado e foco acessível |
| MED-08 detalhe antigo | :436 heading conv2 após liberar resposta velha; :444 upload rota conv2 | Guard protege contexto mesmo se abort não impedir resolução |
| MED-01/10 origem após revisão | :462 imagem; :474 multipart attachment; :478 payload image/mediaId | Troca de origem preserva arquivo realmente selecionado |
| MED-08 envio pendente | :498 textarea disabled; :501 texto disabled; :504 Gravar disabled; :506 reabilitado; :508 type=image | Não permite texto/captura concorrentes ao comando |

Adequação: treze casos cobrem estado/payload/rota e foco, todos vinculados acima;
SSE usa EventSource real, backend e dispositivo são fixtures sintéticas. Permissão
negada/codecs reais continuam cobertos por T19, não são alegados por essa fixture.
Focal12/12 e caso adicional1/1; UI integral166pass/7skips anteriores(total173),
workers1, incluindo Firefox Linux T19. Quick/Build847pass/3skips(total850),
typecheck/lint/format/boundaries/catalog/topology verdes. Nenhum SQL mudou.
Logs locais ignorados: var/media-T21-validate.log e var/media-T21-e2e.log.
Demo persistente usa banco/volumes próprios e assets copiados em var/media-demo:
login200, Inbox200/human1 e frontend200 verificados; UAT físico root pendente,
sem pedir microfone automaticamente. Sem preparar/enviar enquanto MEDIA=false.
Nenhum requisito Verified; pipeline completo e ativação remota continuam T23/T24.

## Correção T20: Foco do player removido

MED-25: revisão independente encontrou foco perdido ao remover player por lost
ou erro HTTP. Dois testes novos falharam com status inactive em toBeFocused.
MediaMessage detecta foco dentro do player antes da troca, espera nextTick e
foca o aviso tabindex=-1. Foco externo permanece onde estava.

| Critério / mapeamento inverso | Evidência file:line e assertion | Resultado exigido |
| --- | --- | --- |
| MED-25 lost remove player focado | test/e2e/media-message.spec.js:189 `expect(page.getByRole('status')).toBeFocused()` | Foco previsível no aviso |
| MED-25 erro503 remove player focado | test/e2e/media-message.spec.js:209 `expect(page.getByRole('status')).toBeFocused()` | Foco previsível no aviso |
| MED-25 foco externo preservado | test/e2e/media-message.spec.js:266 `toBeFocused()` no botão; :267 `violations.toEqual([])` | Não roubar foco fora da mídia |

Adequação: as duas novas assertions matam o comportamento anterior; caso publicado
de foco externo permanece intacto. Focal11/11; UI integral153pass/7skips anteriores
(total160), workers1; typecheck/lint verdes. WIP T21 não publicado foi guardado
em var durante este gate e será restaurado após commit, sem pular teste publicado.
As linhas da seção T20 abaixo referem-se ao snapshot ffdcaa5; o Verifier final
rederiva evidência no HEAD vigente. Nenhum requisito Verified.

## T20: Histórico com reprodução privada

MED-17/19/25: MediaMessage renderiza imagem e controles nativos de áudio/vídeo
com preload metadata e sem autoplay. Aceita somente rota relativa de conteúdo
do CRM. Lost preserva a mensagem sem pedir bytes; erro de leitura mostra estado
acessível unavailable, sem anunciar entrega. Metadados do DTO permanecem a fonte
de estado; não há GET S3 adicional no componente.

Premissas: T16 fornece mediaId/kind/state/contentUrl autorizado. Arquivos desta
entrega: componente, fixture Vue, áudio AAC sintético de 3s, nove E2E e registros
T20. A fixture M4A anterior tem 0,2s, insuficiente para seek em 0,5s; o primeiro
focal passou 6/7 e acusou currentTime=0,2. A nova fixture preserva a assertion
de seek/playback. Não houve alteração de testes publicados, skips ou timeouts.

| Critério / AC | Evidência file:line e assertion | Resultado da spec | Coberto |
| --- | --- | --- | --- |
| MED-17 imagem privada | test/e2e/media-message.spec.js:127 `toBeGreaterThan(0)`; :128 `expect(reads[0].cookie).toContain('crm_session=synthetic-media-reader')`; :129 `toBe(200)` | PNG real decodificado com sessão | Sim |
| MED-17 áudio/vídeo e seek | test/e2e/media-message.spec.js:164 `toBeGreaterThan(0.5)`; :172 `expect(ranged?.range).toBe('bytes=0-')`; :173 `expect(ranged?.contentRange).toBe(...)` | Playback e seek sobre bytes reais 206/Content-Range exato | Sim |
| T20 sem autoplay | test/e2e/media-message.spec.js:138 `toHaveAttribute('controls', '')`; :139 `toHaveAttribute('preload', 'metadata')`; :140 `not.toHaveAttribute('autoplay', /.*/)`; :152 `toBe(true)` | Controles nativos, início pausado | Sim |
| MED-19 lost | test/e2e/media-message.spec.js:183 `toHaveText('Arquivo perdido. O histórico da mensagem foi preservado.')`; :186 `toHaveCount(0)`; :187 `expect(reads).toHaveLength(0)` | Histórico sem bytes inventados | Sim |
| MED-19 falha RustFS | test/e2e/media-message.spec.js:197 `toHaveText('Arquivo indisponível no momento.')`; :200 `toHaveCount(0)`; :201 `getByText('Mensagem enviada').toHaveCount(0)` | Falha acessível, sem anúncio de entrega | Sim |
| Fronteira privada MED-16/19 | test/e2e/media-message.spec.js:217 `expect(external).toHaveLength(0)`; :218 `expect(reads).toHaveLength(0)` | URL externa não é usada | Sim |
| MED-25 lost por teclado | test/e2e/media-message.spec.js:233 `toBeFocused()`; :234 `violations.toEqual([])` | Foco permanece previsível, axe limpo | Sim |
| MED-25 controles por teclado | test/e2e/media-message.spec.js:256 `activeElement.toBe(true)`; :264 `paused.toBe(false)`; :265 `violations.toEqual([])` | Tab e Espaço operam os players reais; axe com player presente | Sim |

| Teste / assertion | Mapeamento inverso | Necessário |
| --- | --- | --- |
| :127..129 imagem, naturalWidth/cookie/status | T20 imagem autenticada/MED-17 | Sim |
| :138..173 áudio e vídeo, controls/preload/paused/currentTime/error/206 | T20 reprodução/seek/MED-17/25 | Sim |
| :183..187 lost, status/nodes/reads | MED-19 | Sim |
| :197..201 503, status/nodes/delivery | MED-19 | Sim |
| :214..218 URL externa, status/requests | MED-16/19 | Sim |
| :227..234 transição lost, status/foco/axe | MED-19/25 | Sim |
| :249..265 áudio/vídeo por teclado, ready/foco/play/axe | MED-25 | Sim |

Adequação: critérios cobertos por valores/estados e bytes reais, sem assertions
rasas; todos os nove casos têm requisito. Segue CONTRIBUTING.md e matriz UI/axe
de tasks.md. Texto exato dos avisos é escolha de UI, a spec exige estado acessível.
Focal9/9 e UI completo151pass/7skips anteriores(total158), workers1, Node24.20.0.
Typecheck/lint verdes. Nenhum SQL alterado. Chromium mediu PNG/AAC/H.264; Firefox
recording foi medido em T19, pares de codecs anexados ficam explícitos em T24.
Microfone físico, worker completo e operação remota continuam pendentes.

## T19: Gravação com revisão explícita

MED-09..13/25: AudioRecorder standalone pede getUserMedia({audio:true}) apenas
por ação explícita, negocia MIME suportado, usa relógio monotônico e interrompe
captura em 300s ou 16MiB. Stop oferece revisão sem upload; preparar e enviar
continuam ações separadas. Negação/indisponibilidade/erro do encoder preservam
anexos. Descarte, troca e unmount liberam tracks e URL, inclusive permissão tardia.

Red factual adicional: nova captura e descarte continuavam habilitados durante
POSTmessages pendente. O teste de envio pendente falhou em toBeDisabled; composer
passa sending-change ao recorder, que bloqueia ações e Escape nesse estado.
Green mantém uma única requisição de upload e uma de envio.

| Critério / mapeamento inverso    | Evidência file:line                              | Resultado assertado                                                                              |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| MED-09/10/25 ação explícita      | test/e2e/audio-recorder.spec.js:165              | sem pedido inicial, teclado inicia áudio, stop não envia, origin recording e content sem caption |
| MED-11 fallback                  | test/e2e/audio-recorder.spec.js:206              | denied/unavailable/encoderFailure deixam anexo habilitado                                        |
| MED-13 captura e resposta tardia | test/e2e/audio-recorder.spec.js:227 e :246       | discard/switch/unmount fecham tracks sem upload e sem iniciar capture tardia                     |
| MED-12 duração/tamanho           | test/e2e/audio-recorder.spec.js:275, :287 e :379 | 300s e 16MiB param tracks, excedente rejeita, limite exato revisa sem enviar                     |
| MED-10 áudio vazio               | test/e2e/audio-recorder.spec.js:304              | alerta e nenhuma prévia enviável                                                                 |
| MED-13/25 revisão acessível      | test/e2e/audio-recorder.spec.js:315              | URL revogada, foco devolvido, axe sem violações                                                  |
| MED-06 envio pendente            | test/e2e/audio-recorder.spec.js:335              | botões desabilitados, Escape conserva revisão, upload/send únicos                                |
| MED-09/10 codec real             | test/e2e/audio-recorder.spec.js:396              | Chromium/Firefox reais: MIME áudio, playback não pausado, nenhum MediaError                      |

Gates em Node24.20.0: validate Quick847pass/3skips existentes(total850), build,
typecheck e lint verdes; E2E completo142pass/7skips existentes(total149), workers1.
18 novos casos passaram; Firefox real também passou3repetições consecutivas.
Fixtures sintéticas geradas foram preservadas apenas em var ignorado; FFmpeg
decodificou áudio Firefox com exit0 em container readonly/networknone.

Firefox Windows1538 falhou SideBySide (mozglue), mesmo após instalação oficial
--force. Prova Firefox usa Linux real: imagem Playwright1.62.1 com digest pinado,
servidor loopback31927, sem dispositivos/segredos/mounts do host. PulseAudio
privado/nullsink resolveu MediaError3/OnMediaSinkAudioError observado nas três
repetições iniciais; assertions de playback foram mantidas. CI instala ambos
os browsers e cria nullsink; execução remota de CI ainda não observada.

Reprodução local: docker build -f docker/playwright-firefox.Dockerfile -t
crm-silmer-playwright-firefox:local .; executar imagem com --memory=1g --cpus=1
-p 127.0.0.1:31927:31927. Definir PW_FIREFOX_WS_ENDPOINT como
ws://127.0.0.1:31927/media-recorder-firefox e executar test:e2e -- --workers=1.
Sem variável, usa Firefox instalado localmente. --unsafe é restrito ao servidor
de teste isolado para preferências de dispositivo sintético, sem infraestrutura
de produção. Microfone físico/UAT e pipeline completo continuam T24; nenhum
requisito Verified. O root assumiu T19 após erro terminal de quota do autor.

## Correção T18: retry após bloqueio transitório

Premissa: cancelar HTTP não prova rollback do envio. Fronteira: MediaComposer,
fixture e E2E; MED-06/25 exige preservar a operação original. Red factual:
`test/e2e/media-composer.spec.js:287` `expect(retry).toBeEnabled()` falhou
porque disabled=true mudou sending para error e manteve sendAttempt.
Correção conserva ready quando há tentativa, com disabled ainda impedindo envio.
Green focal 1/1, Node24.20.0. Nenhum envio automático ao reabilitar.

Primeiro Full: 123 pass, 7 skips existentes, 1 fail. Diagnóstico foundation179:
após reload, getByRole(status) encontrou Dashboard Carregando indicadores e
região global ainda vazia; strict mode encerrou a assertion Sessão restaurada.
Nenhum arquivo de login/Dashboard/teste baseline mudou. Reexecução integral
mantém as mesmas assertions e timeouts: 124 pass/7 skips(total131), zero falhas.

Adequação A/C bidirecional (diretrizes AGENTS/CONTRIBUTING): cada assertion
abaixo corresponde exclusivamente ao cenário MED-06/25, sem teste especulativo.

| Critério / mapeamento inverso  | file:line + assertion                                                                                                                                                                                  | Resultado da spec                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| bloqueio continua seguro       | `test/e2e/media-composer.spec.js:284` `expect(retry).toBeDisabled()`                                                                                                                                   | nenhum efeito enquanto bloqueado         |
| reabilitar não envia           | `test/e2e/media-composer.spec.js:288` `expect(sends).toHaveLength(1)`                                                                                                                                  | envio só por ação explícita              |
| mesma operação                 | `test/e2e/media-composer.spec.js:295` `expect(sends).toHaveLength(2)` e `:299` `expect(sends[0].postDataJSON()).toEqual(sends[1].postDataJSON())`                                                      | retry conserva payload original          |
| conversa/version/caption/media | `test/e2e/media-composer.spec.js:303` `expect(sends[1].postDataJSON()).toEqual({expectedVersion:4,messageType:'image',content:{mediaId:'media-1',caption:'Original'},reason:'Envio humano de anexo'})` | valores congelados na primeira tentativa |
| chave original                 | `test/e2e/media-composer.spec.js:296` `expect(sends[0].headers()['idempotency-key']).toEqual(sends[1].headers()['idempotency-key'])`                                                                   | mesma identidade no retry                |

Check A/B/C/D: payload completo e chave/contexto assertados, teclado Enter,
prévia preservada, nenhuma assertion/skip/teste publicado reduzido.
Quick/Build847pass+3skips(total850), audit0; Verifier final continua após T24.

## T18: Composer de anexos

MED-01/02/03/04/06/07/08/25: composer standalone com seleção única, revisão, upload explícito e envio apenas ready; áudio sem caption, aliases M4A e MIME vazio como hint, bytes validados no worker. Preview/identidades/version mantidos em retry, abort e generation impedem resposta antiga entre conversas. Legenda conta 1024 code points (emoji), não UTF16. Prazo polling600s inclui GET pendente e delay; refresh conserva mediaId sem reupload. Build/Quick847pass+3skips(total850), UI123pass+7skips(total130)workers1, novos16cenários E2E; validator real ClamAV/libmagic/codec1/1(113s) com fixture Chromium original, audit zero, diff e spec/tasks strict verdes. Nenhum cenário/assertion/skip/timeout publicado reduzido. Fase3 completa; próximoT19, nenhum Verified.

Red antes do código: os ACs foram escritos antes do componente; a primeira
tentativa de E2E não montou o harness e não conta como red funcional. Harness
Vite isolado corrigido, 11 cenários iniciais verdes. Sensor discriminante
Unicode substituiu temporariamente Array.from(caption).length por caption.length:
1024 emoji falharam; fonte restaurada e caso verde. Novo red factual com clock
350000 demonstrou deadline300s negar pipeline válido após orçamento local340s;
patch600s verde. Timer durante delay discriminado599000+runFor1000; GET pendente
também termina600000, conserva preview e permite refresh (uploads=1).

API dos E2E é mockada: prova componente/contrato, não whole worker. Validator
Docker real preserva todos os casos antigos e adiciona texto inválido renomeado
PNG; primeira execução sem CHAT_MEDIA_CHROMIUM_FIXTURE falhou a assertion antiga,
nova execução com fixture original passou sem relaxar teste. Comando:
`docker exec -e RUN_CHAT_MEDIA_RUNTIME_TESTS=yes -e CHAT_MEDIA_CHROMIUM_FIXTURE=/workspace/var/tooling/chromium-media-recorder.webm crm-silmer-media-test-runtime-pipeline sh -c 'cd /workspace && node --test test/chat-media-validation-runtime.test.js'`.
Build/Quick `npm run validate`, UI `npm run test:e2e -- --workers=1`, audit
`npm audit --audit-level=high`; todos prefixados rtk/PATH Node24.20.0.
Baseline UI114=107pass+7skips preservado; agora130=123pass+7skips,16novos.
Quick850=847pass+3skips preservado. Build62módulos mantém componente standalone;
integração Inbox e recorder pertencemT21/T19. Browser nativo inspecionou preview,
ações, foco ao remover e screenshot sintético `var/media-composer-review.png`.

Reparo incidental autorizado: OpenAPI HumanMessageCommand.type tinha indentação
inválida desde T11(b9ecd8ba); somente dois espaços corrigidos, sem mudar contrato.
Nenhum schema/ADR/infra remota mudou. Privacy produção T23 (recipient/caption
inicial n8n), homologação Meta T23 e wholebuiltworker T24 permanecem pendentes;
o autor não cria validation.md nem declara requisito Verified.

### Adequação bidirecional

Check A/B/C/D: cada cenário parte do AC no nome e cada assertion abaixo aponta
de volta ao requisito/cenário. Nenhuma assertion de comportamento foi removida.

| Critério / requisito | file:line + assertion | Resultado da spec |
| --- | --- | --- |
| T18/MED-04/29: bytes renomeados | `test/chat-media-validation-runtime.test.js:78` `await assert.rejects(validator.validate({path: renamed, kind: 'image', origin: 'attachment', declaredMimeType: 'image/png'}), error => error instanceof Error && 'reason' in error && error.reason === 'invalid_format')` | Extensão/MIME declarados não autorizam bytes inválidos; processamento real rejeita antes de ready |
| isolamento | `test/e2e/media-composer.spec.js:132` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:148` `await expect(       page.getByRole('button', { name: 'Enviar anexo', exact: true }),     ).toBeDisabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:151` `expect(uploads).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:152` `expect(sends).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:155` `await expect(page.getByLabel('Legenda')).toHaveCount(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:157` `expect(sends).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:161` `await expect(       page.getByText('Mensagem enviada', { exact: true }),     ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:164` `expect(uploads).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:165` `expect(sends).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:166` `expect(uploads[0].headers()['content-type']).toContain(       'multipart/form-data` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test(T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart, async ({ | `test/e2e/media-composer.spec.js:169` `expect(sends[0].postDataJSON()).toEqual({       expectedVersion: 4,       messageType: kind,       content:         kind === 'audio'           ? { mediaId: 'media-1' }           : { mediaId: 'media-1', caption: 'Revisão explícita' },       reason: 'Envio humano de anexo',     })` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: empty MIME is a hint and renamed invalid bytes are rejected by processing', async ({ | `test/e2e/media-composer.spec.js:185` `await expect(page.getByRole('alert')).toContainText('Formato inválido')` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: empty MIME is a hint and renamed invalid bytes are rejected by processing', async ({ | `test/e2e/media-composer.spec.js:186` `await expect(     page.getByRole('img', { name: 'Prévia do anexo' }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: empty MIME is a hint and renamed invalid bytes are rejected by processing', async ({ | `test/e2e/media-composer.spec.js:189` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeDisabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: empty MIME is a hint and renamed invalid bytes are rejected by processing', async ({ | `test/e2e/media-composer.spec.js:192` `expect(uploads).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: empty MIME is a hint and renamed invalid bytes are rejected by processing', async ({ | `test/e2e/media-composer.spec.js:193` `expect(sends).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-01/04: approved empty-MIME file can complete byte validation and send', async ({ | `test/e2e/media-composer.spec.js:202` `await expect(     page.getByText('Mensagem enviada', { exact: true }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-01/04: approved empty-MIME file can complete byte validation and send', async ({ | `test/e2e/media-composer.spec.js:205` `expect(sends).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: caption counts Unicode code points including 1024 emoji', async ({ | `test/e2e/media-composer.spec.js:215` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeDisabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: caption counts Unicode code points including 1024 emoji', async ({ | `test/e2e/media-composer.spec.js:219` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: caption counts Unicode code points including 1024 emoji', async ({ | `test/e2e/media-composer.spec.js:223` `await expect(     page.getByText('Mensagem enviada', { exact: true }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: caption counts Unicode code points including 1024 emoji', async ({ | `test/e2e/media-composer.spec.js:226` `expect([...sends[0].postDataJSON().content.caption]).toHaveLength(1024)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:234` `await expect(page.getByRole('alert')).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:235` `await expect(     page.getByRole('img', { name: 'Prévia do anexo' }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:239` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:242` `expect(uploads).toHaveLength(2)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:243` `expect(uploads[0].headers()['idempotency-key']).toEqual(     uploads[1].headers()['idempotency-key'],   )` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:246` `expect(uploads[0].postData()).toContain('sample.png')` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({ | `test/e2e/media-composer.spec.js:247` `expect(uploads[1].postData()).toContain('name="expectedVersion"\r\n\r\n4')` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:257` `await expect(page.getByRole('alert')).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:258` `await expect(     page.getByRole('img', { name: 'Prévia do anexo' }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:261` `await expect(page.getByLabel('Legenda')).toBeDisabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:263` `await expect(     page.getByText('Mensagem enviada', { exact: true }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:266` `expect(sends).toHaveLength(2)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:267` `expect(sends[0].headers()['idempotency-key']).toEqual(     sends[1].headers()['idempotency-key'],   )` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({ | `test/e2e/media-composer.spec.js:270` `expect(sends[0].postDataJSON()).toEqual(sends[1].postDataJSON())` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-25: remove and reselect by keyboard restores focus and clears the previous draft', async ({ | `test/e2e/media-composer.spec.js:280` `await expect(page.getByLabel('Arquivo para anexar')).toBeFocused()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-25: remove and reselect by keyboard restores focus and clears the previous draft', async ({ | `test/e2e/media-composer.spec.js:281` `await expect(page.getByRole('img', { name: 'Prévia do anexo' })).toHaveCount(     0,   )` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-25: remove and reselect by keyboard restores focus and clears the previous draft', async ({ | `test/e2e/media-composer.spec.js:287` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-25: remove and reselect by keyboard restores focus and clears the previous draft', async ({ | `test/e2e/media-composer.spec.js:290` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeFocused()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: switch or unmount cancels stale upload and cannot send it in another conversation', async ({ | `test/e2e/media-composer.spec.js:301` `await expect(page.getByRole('img', { name: 'Prévia do anexo' })).toHaveCount(     0,   )` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: switch or unmount cancels stale upload and cannot send it in another conversation', async ({ | `test/e2e/media-composer.spec.js:305` `expect(sends).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: switch or unmount cancels stale upload and cannot send it in another conversation', async ({ | `test/e2e/media-composer.spec.js:310` `expect(sends).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-08/25: blocked composer has no upload action and passes axe with a ready draft', async ({ | `test/e2e/media-composer.spec.js:318` `expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-08/25: blocked composer has no upload action and passes axe with a ready draft', async ({ | `test/e2e/media-composer.spec.js:320` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeDisabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-08/25: blocked composer has no upload action and passes axe with a ready draft', async ({ | `test/e2e/media-composer.spec.js:323` `expect(uploads).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-08/25: blocked composer has no upload action and passes axe with a ready draft', async ({ | `test/e2e/media-composer.spec.js:324` `expect(sends).toHaveLength(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: delayed original upload cannot replace the new conversation draft', async ({ | `test/e2e/media-composer.spec.js:340` `await expect(     page.getByText('Mensagem enviada', { exact: true }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: delayed original upload cannot replace the new conversation draft', async ({ | `test/e2e/media-composer.spec.js:343` `expect(uploads).toHaveLength(2)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: delayed original upload cannot replace the new conversation draft', async ({ | `test/e2e/media-composer.spec.js:344` `expect(sends).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: delayed original upload cannot replace the new conversation draft', async ({ | `test/e2e/media-composer.spec.js:345` `expect(new URL(sends[0].url()).pathname).toBe(     '/api/v1/conversations/conversation-2/messages',   )` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-07/08: delayed original upload cannot replace the new conversation draft', async ({ | `test/e2e/media-composer.spec.js:348` `expect(sends[0].postDataJSON().content.mediaId).toBe('media-2')` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: valid local pipeline beyond 340 seconds remains eligible before polling budget expires', async ({ | `test/e2e/media-composer.spec.js:357` `await expect(page.getByRole('status')).toContainText('Validando arquivo')` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: valid local pipeline beyond 340 seconds remains eligible before polling budget expires', async ({ | `test/e2e/media-composer.spec.js:359` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04: valid local pipeline beyond 340 seconds remains eligible before polling budget expires', async ({ | `test/e2e/media-composer.spec.js:362` `await expect(page.getByRole('alert')).toHaveCount(0)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling timeout preserves media ID and a status retry can observe the eventual ready state', async ({ | `test/e2e/media-composer.spec.js:372` `await expect(page.getByRole('status')).toContainText('Validando arquivo')` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling timeout preserves media ID and a status retry can observe the eventual ready state', async ({ | `test/e2e/media-composer.spec.js:377` `await expect(page.getByRole('alert')).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling timeout preserves media ID and a status retry can observe the eventual ready state', async ({ | `test/e2e/media-composer.spec.js:378` `await expect(     page.getByRole('img', { name: 'Prévia do anexo' }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling timeout preserves media ID and a status retry can observe the eventual ready state', async ({ | `test/e2e/media-composer.spec.js:383` `await expect(     page.getByRole('button', { name: 'Enviar anexo', exact: true }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling timeout preserves media ID and a status retry can observe the eventual ready state', async ({ | `test/e2e/media-composer.spec.js:386` `expect(uploads).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling budget aborts a pending status GET without losing the draft', async ({ | `test/e2e/media-composer.spec.js:399` `await expect(page.getByRole('alert')).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling budget aborts a pending status GET without losing the draft', async ({ | `test/e2e/media-composer.spec.js:400` `await expect(     page.getByRole('img', { name: 'Prévia do anexo' }),   ).toBeVisible()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling budget aborts a pending status GET without losing the draft', async ({ | `test/e2e/media-composer.spec.js:403` `await expect(     page.getByRole('button', { name: 'Atualizar validação' }),   ).toBeEnabled()` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| test('T18/MED-04/06: polling budget aborts a pending status GET without losing the draft', async ({ | `test/e2e/media-composer.spec.js:406` `expect(uploads).toHaveLength(1)` | Resultado exato do AC indicado no cenário; mapeamento inverso explícito |
| T18/MED-04/29: extensão não prova bytes | `test/chat-media-validation-runtime.test.js:76` `const renamed = join(root, 'renamed-invalid.png');` | Arquivo renomeado inválido rejeitado pelo validador real, mantendo formatos genuínos |
| T18/MED-04/29: extensão não prova bytes | `test/chat-media-validation-runtime.test.js:88` `error.reason === 'invalid_format',` | Arquivo renomeado inválido rejeitado pelo validador real, mantendo formatos genuínos |
| T18/MED-04/29: extensão não prova bytes | `test/chat-media-validation-runtime.test.js:175` `error.reason === 'invalid_format',` | Arquivo renomeado inválido rejeitado pelo validador real, mantendo formatos genuínos |
| T18/MED-04/29: extensão não prova bytes | `test/chat-media-validation-runtime.test.js:205` `error.reason === 'invalid_format',` | Arquivo renomeado inválido rejeitado pelo validador real, mantendo formatos genuínos |

## T17: Multipart autenticado e cancelamento nativo

MED-04/06/08: red FormData enviadoJSON e cancelamento proxy parcial/SSE ausente; green9 HTTP/socket reais (7client+2proxy), bytes/boundary nativos sem Content-Type manual, CSRF e key preservados, JSON304 intactos, AbortSignal upload/status/preabort e erros saneados. Proxyaborted/responsecloseincompleto encerraupstream, Range206normal preservado. Quick847pass/3skips(total850), FullUI107pass/7skips(total114)workers1, type-lint-diff e strictspec/tasks verdes. SemSQL ou migração; nenhum Verified; proximoT18standalone.

### Adequação bidirecional

Os testes derivam dos ACs indicados nos nomes dos cenários. Cada assertion abaixo
associa critério → resultado exato e resultado → requisito. Assert de fixture
comprova isolamento. Nenhum cenário/skip/timeout publicado foi removido ou
enfraquecido; Check A/B/C/D passa dentro da fronteira desta tarefa.

| Critério / requisito (mapeamento inverso) | file:line + assertion | Resultado da spec |
| --- | --- | --- |
| test(T17/MED-04/06/08: native FormData preserves binary/boundary, CSRF and original command key, async () | `test/media-api-client.test.js:44` `assert.match(         req.headers['content-type'],         /^multipart\/form-data;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-04/06/08: native FormData preserves binary/boundary, CSRF and original command key, async () | `test/media-api-client.test.js:48` `assert.equal(req.headers['x-csrf-token'], 'synthetic csrf');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-04/06/08: native FormData preserves binary/boundary, CSRF and original command key, async () | `test/media-api-client.test.js:49` `assert.equal(req.headers['idempotency-key'], 'upload/a?#%');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-04/06/08: native FormData preserves binary/boundary, CSRF and original command key, async () | `test/media-api-client.test.js:50` `assert.ok(body.includes(Buffer.from([0, 255, 9, 7])));` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-04/06/08: native FormData preserves binary/boundary, CSRF and original command key, async () | `test/media-api-client.test.js:51` `assert.ok(body.includes(Buffer.from('name="origin"')));` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-04/06/08: native FormData preserves binary/boundary, CSRF and original command key, async () | `test/media-api-client.test.js:72` `assert.equal(result.data.state, 'processing');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: JSON request remains encoded with CSRF and same idempotency key, async () | `test/media-api-client.test.js:79` `assert.equal(req.headers['content-type'], 'application/json');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: JSON request remains encoded with CSRF and same idempotency key, async () | `test/media-api-client.test.js:80` `assert.equal(req.headers['x-csrf-token'], 'synthetic csrf');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: JSON request remains encoded with CSRF and same idempotency key, async () | `test/media-api-client.test.js:81` `assert.equal(req.headers['idempotency-key'], 'original');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: JSON request remains encoded with CSRF and same idempotency key, async () | `test/media-api-client.test.js:82` `assert.deepEqual(JSON.parse((await bytes(req)).toString()), {         expectedVersion: 1,         content: { mediaId: 'id' },       });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: JSON request remains encoded with CSRF and same idempotency key, async () | `test/media-api-client.test.js:89` `assert.equal(         (           await request(url, {             method: 'POST',             body: { expectedVersion: 1, content: { mediaId: 'id' } },             idempotencyKey: 'original',           })         ).data,;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: native status polling forwards AbortSignal and stops pending read, async () | `test/media-api-client.test.js:109` `await assert.rejects(         pending,         (error) => /** @type {any} */ (error).name === 'AbortError',       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: native multipart request stops on abort, async () | `test/media-api-client.test.js:133` `await assert.rejects(         pending,         (error) => /** @type {any} */ (error).name === 'AbortError',       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: pre-aborted request performs no HTTP work, async () | `test/media-api-client.test.js:150` `await assert.rejects(         request(url, { signal: controller.signal }),         (error) => /** @type {any} */ (error).name === 'AbortError',       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: pre-aborted request performs no HTTP work, async () | `test/media-api-client.test.js:154` `assert.equal(calls, 0);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-04: processing rejection problem retains sanitized status/code/detail, async () | `test/media-api-client.test.js:168` `await assert.rejects(         request(url),         (error) =>           error instanceof ApiError &&           error.status === 422 &&           error.code === 'CHAT_MEDIA_INVALID_FORMAT' &&           error.message === 'Formato inválido',       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: GET 304 retains ETag and emits no body or CSRF, async () | `test/media-api-client.test.js:182` `assert.equal(req.headers['content-type'], undefined);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: GET 304 retains ETag and emits no body or CSRF, async () | `test/media-api-client.test.js:183` `assert.equal(req.headers['x-csrf-token'], undefined);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-06: GET 304 retains ETag and emits no body or CSRF, async () | `test/media-api-client.test.js:187` `assert.deepEqual(await request(url), {         data: null,         etag: '"v1"',         notModified: true,       });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: normal Range response completes and a closed SSE consumer stops the upstream response, async () | `test/media-dev-proxy.test.js:104` `assert.equal(req.headers.range, 'bytes=0-2');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: normal Range response completes and a closed SSE consumer stops the upstream response, async () | `test/media-dev-proxy.test.js:121` `assert.equal(range.status, 206);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: normal Range response completes and a closed SSE consumer stops the upstream response, async () | `test/media-dev-proxy.test.js:122` `assert.equal(await range.text(), 'abc');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T17/MED-08: normal Range response completes and a closed SSE consumer stops the upstream response, async () | `test/media-dev-proxy.test.js:123` `assert.equal(range.headers.get('content-range'), 'bytes 0-2/6');` | Resultado explícito da assertion; necessário ao AC no cenário |

## T16: DTO persistente do historico

MED-15/19/20: red novos casos retornaram media/deliveryMode undefined; green oito SQL live cobrem imagem/audio/video, lost, legado, DEVfailed/unknown e prefixo externo sem autoridade. Historico e resumo consultam binding persistido na mesma snapshot; get3SELECT/list2SELECT sem storage, sem nome/chave/hash/bytes. media.contentUrl so rota relativa CRM autorizada para attachedclean; lostnull. deliveryMode vem do unico recibo original message.send.requested n8n_events, nunca prefixo de mensagem; SSE IDs tecnicos preservados. Quick838pass/3skips(total841), Live65/65=bind54+operationRead1+inbox7+migrations3; type-lint-diff e validadores estritos verdes. Nenhuma Verified; proximoT17.

### Adequação bidirecional

Os testes derivam dos ACs indicados nos nomes dos cenários. Cada assertion abaixo
associa critério → resultado exato e resultado → requisito. Assert de fixture
comprova isolamento. Nenhum cenário/skip/timeout publicado foi removido ou
enfraquecido; Check A/B/C/D passa dentro da fronteira desta tarefa.

| Critério / requisito (mapeamento inverso) | file:line + assertion | Resultado da spec |
| --- | --- | --- |
| test(T16/MED-15/19/20: history and summary project safe ${kind} metadata in one snapshot, async () | `test/chat-media-bind-postgres-live.test.js:556` `assert.equal(         queries.filter((sql) => sql.trim().startsWith('SELECT')).length,         3,       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15/19/20: history and summary project safe ${kind} metadata in one snapshot, async () | `test/chat-media-bind-postgres-live.test.js:561` `assert.deepEqual(media, {         mediaId: f.id,         kind,         state: 'attached',         mimeType:           kind === 'image'             ? 'image/png'             : kind === 'audio';` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15/19/20: history and summary project safe ${kind} metadata in one snapshot, async () | `test/chat-media-bind-postgres-live.test.js:575` `assert.equal(detail.messages[0].deliveryMode, null);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15/19/20: history and summary project safe ${kind} metadata in one snapshot, async () | `test/chat-media-bind-postgres-live.test.js:576` `assert.deepEqual(         (await reads.list({ limit: 20 })).items.find(           (/** @type {any} */ row) => row.id === 'bind-conversation',         ).lastMessage.media,         media,       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15/19/20: history and summary project safe ${kind} metadata in one snapshot, async () | `test/chat-media-bind-postgres-live.test.js:582` `assert.equal(         queries.filter((sql) => sql.trim().startsWith('SELECT')).length,         5,       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15/19/20: history and summary project safe ${kind} metadata in one snapshot, async () | `test/chat-media-bind-postgres-live.test.js:595` `assert.equal(serialized.includes(forbidden), false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15: lost media retains message metadata without offering bytes, async () | `test/chat-media-bind-postgres-live.test.js:609` `assert.equal(media.mediaId, f.id);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15: lost media retains message metadata without offering bytes, async () | `test/chat-media-bind-postgres-live.test.js:610` `assert.equal(media.state, 'lost');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-15: lost media retains message metadata without offering bytes, async () | `test/chat-media-bind-postgres-live.test.js:611` `assert.equal(media.contentUrl, null);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-19: legacy text/media without persistent binding preserve preview and have no fabricated media route, async () | `test/chat-media-bind-postgres-live.test.js:621` `assert.equal(message.media, null);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-19: legacy text/media without persistent binding preserve preview and have no fabricated media route, async () | `test/chat-media-bind-postgres-live.test.js:622` `assert.equal(message.preview, f.payload.message.text);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-19: legacy text/media without persistent binding preserve preview and have no fabricated media route, async () | `test/chat-media-bind-postgres-live.test.js:627` `assert.equal(       (await reads.get('bind-conversation')).messages[0].media,       null,     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-19/23/24: DEV ${status} is identified from original reservation, independent of external ID, async () | `test/chat-media-bind-postgres-live.test.js:647` `assert.equal(         (await reads.get('bind-conversation')).messages[0].deliveryMode,         'dev',       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-19/20: external DEV prefix cannot replace official reservation provenance and SSE stays technical, async () | `test/chat-media-bind-postgres-live.test.js:664` `assert.equal(       (await reads.get('bind-conversation')).messages[0].deliveryMode,       'official',     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T16/MED-19/20: external DEV prefix cannot replace official reservation provenance and SSE stays technical, async () | `test/chat-media-bind-postgres-live.test.js:679` `assert.equal(stream.includes(forbidden), false);` | Resultado explícito da assertion; necessário ao AC no cenário |

## T15: Simulador DEV com bytes reais e importer por digest

Evidência nativa sintética: `npm run smoke:n8n:media:local`, perfil ignorado
retido após parada; não apagou registros nem desabilitou pruning. Os dez
cenários iniciais, três replays e dois envios após restart totalizaram 15.
Novas expectativas erradas (200/completed/count0) foram corrigidas, com
aprovação do Tech Lead, para contratos 202/sent e lifecycle soft-deleted;
nenhum teste publicado ou cenário foi removido. O gate produção T23 permanece
sem PASS por recipient/caption iniciais; a prova limita-se a bytes/refs e DEV.

Os snapshots em HEAD anterior tinham 61 nós DEV/local; a regeneração real
passa a 77, acrescentando 16 nomes sem remover nenhum. A expectativa unitária
do generator já era 77 desde T14; este gate cobre agora também igualdade
snapshot→generator. O inventário canônico continua 68. O timeout gerado
passa a refletir os 240 segundos do canônico. O transporte completo do worker
(timeout local N8N_COMMAND_TIMEOUT_MS=10000) deve ser avaliado em T24;
este ensaio reserva/aciona o workflow diretamente e não prova esse orçamento.

| AC / requisito inverso | file:line + assertion | Resultado exigido |
| --- | --- | --- |
| MED-23 bytes reais/tipos/falhas | `scripts/n8n-media-local-smoke.mjs:546` cenários e `:505` status exato | PNG/OGG/MP4 e failed/unknown discriminados |
| MED-06 replay/reserva | `scripts/n8n-media-local-smoke.mjs:541` counts deepEqual 1/1 | Replay não repete efeito |
| MED-21 antes/depois efeito | `scripts/n8n-media-local-smoke.mjs:513` counts e `:527` retry flags | Download/hash/size 0/0; upload/epoch 1/0; unknown 1/1 sem retry |
| MED-23 publicação atual | `scripts/n8n-media-local-smoke.mjs:623` version diferente; `:624` activeVersionId igual; `:522` ID atualizado | Nova publicação efetivamente executada |
| MED-23 preservação/idempotência | `scripts/n8n-media-local-smoke.mjs:628` referência; `:629` credentials; `:630` users; `:655` deepEqual após reimport | Versão e estado local preservados |
| MED-23 recursos | `scripts/n8n-media-local-smoke.mjs:648` pico >16MiB e <2GiB | Medido1467297792 bytes; default/concurrency1 |
| MED-20 lifecycle sem bytes | `scripts/n8n-media-local-smoke.mjs:673` rows15; `:674` softdeleted15; `:675` binary0; `:676` refs0; `:677` runData0; `:678` stack inicial | Registros iniciais até pruning, sem resultados binários |
| MED-20 resíduo raw/base64 | `scripts/n8n-media-local-smoke.mjs:663` ambos logs; `:692` todos arquivos | Canários dos bytes válidos ausentes em DB/WAL/FS/stdout/stderr |
| Limite Privacy produção | `scripts/inspect-n8n-execution-privacy.py:77` categorias sem valores | recipient/caption observados: T23 pendente, sem alegar zero PII |

MED-06/21/22/23/24: red settings all/all, ausencia default e botfilter403 Node; green n8n2.38.7 real PNG/OGG/MP4, success/failed/unknown/missing/replay/epoch/hash/size/16MiB, 15 execucoes. Pico1467297792 bytes(1.37GiB), default concorrencia1 limite2GiB/1CPU; somente Meta simulado, sem prova multipart Graph producao. Atualizacao publicada realmente executada e reimport idempotente preservam versao/users/credencial OpenAI sintetica/referencia/volume. Perfil parado15/15 soft-deleted, stack inicialONLY, zero binary/refs/runData/canarios raw-base64 DB-WAL-FS-stdout-stderr; categorias recipient/caption presentes: gate Privacy producao T23 NAO atendido. Seed ready manual/SHA RustFS; wholebuiltworker T24 pendente. Quick838pass/3skips(total841), T15unit11/11; UI107pass/7skips(total114)workers1, type-lint-diff-spec-tasks estritos verdes. Nenhuma Verified ou ADR reescrito; proximoT16.

### Adequação bidirecional

Os testes derivam dos ACs indicados nos nomes dos cenários. Cada assertion abaixo
associa critério → resultado exato e resultado → requisito. Assert de fixture
comprova isolamento. Nenhum cenário/skip/timeout publicado foi removido ou
enfraquecido; Check A/B/C/D passa dentro da fronteira desta tarefa.

| Critério / requisito (mapeamento inverso) | file:line + assertion | Resultado da spec |
| --- | --- | --- |
| test(T15/MED-23: importer assigns native node IDs once and preserves them by name across SDK regeneration, () | `test/n8n-dev-media.test.js:14` `assert.match(initial.nodes[0].id, /^[a-f0-9-]{36}$/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: importer assigns native node IDs once and preserves them by name across SDK regeneration, () | `test/n8n-dev-media.test.js:15` `assert.equal(     prepareLocalWorkflow(incoming, initial).nodes[0].id,     initial.nodes[0].id,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: importer assigns native node IDs once and preserves them by name across SDK regeneration, () | `test/n8n-dev-media.test.js:19` `assert.equal(Reflect.get(incoming.nodes[0], 'id'), undefined);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: localhost technical webhook accepts the real Node client user agent, () | `test/n8n-dev-media.test.js:35` `assert.equal(panel.parameters.authentication, 'none');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: localhost technical webhook accepts the real Node client user agent, () | `test/n8n-dev-media.test.js:36` `assert.equal(panel.parameters.options.ignoreBots, false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: canonical and deployed technical webhook preserve Basic while accepting Node command workers, () | `test/n8n-dev-media.test.js:47` `assert.equal(panel.parameters.options.ignoreBots, false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: canonical and deployed technical webhook preserve Basic while accepting Node command workers, () | `test/n8n-dev-media.test.js:48` `assert.equal(panel.parameters.authentication, 'basicAuth');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: canonical and deployed technical webhook preserve Basic while accepting Node command workers, () | `test/n8n-dev-media.test.js:51` `assert.equal(     deployment.nodes.find(       (/** @type {any} */ node) =>         node.name === 'Painel - Receber comando (MVP)',     ).credentials.httpBasicAuth.name,     'Silmer CRM para n8n Basic DEV',   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-21/23: DEV upload validates actual buffer and can exercise known pre-message failure, async () | `test/n8n-dev-media.test.js:85` `assert.equal((await simulate(name, 3, {})).json.simulated, true);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-21/23: DEV upload validates actual buffer and can exercise known pre-message failure, async () | `test/n8n-dev-media.test.js:86` `await assert.rejects(simulate(name, 2, {}), /DEV_MEDIA_UPLOAD_INVALID/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-21/23: DEV upload validates actual buffer and can exercise known pre-message failure, async () | `test/n8n-dev-media.test.js:87` `await assert.rejects(     simulate(name, 3, { simulate_media_upload_failed: true }),     /DEV_MEDIA_UPLOAD_FAILED/u,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-24: DEV message uncertainty throws after effect boundary with no external HTTP, async () | `test/n8n-dev-media.test.js:94` `assert.equal(     (await simulate(name, 3, {})).json.messages[0].id,     'dev-human-media-synthetic',   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-24: DEV message uncertainty throws after effect boundary with no external HTTP, async () | `test/n8n-dev-media.test.js:98` `await assert.rejects(     simulate(name, 3, { simulate_send_unknown: true }),     /DEV_SIMULATED_SEND_OUTCOME_UNKNOWN/u,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20/23: local=${local} saves neither bytes nor execution data, () | `test/n8n-dev-media.test.js:106` `assert.deepEqual(       [         dev.settings.saveDataSuccessExecution,         dev.settings.saveDataErrorExecution,         dev.settings.saveExecutionProgress,         dev.settings.saveManualExecutions,       ],       ['none', 'none', false, false],;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20/23: local=${local} saves neither bytes nor execution data, () | `test/n8n-dev-media.test.js:115` `assert.equal(       dev.nodes.some(         (/** @type {any} */ n) => n.type === 'n8n-nodes-base.wait',       ),       false,     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20/23: local=${local} saves neither bytes nor execution data, () | `test/n8n-dev-media.test.js:121` `assert.equal(dev.pinData, undefined);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20/23: local=${local} saves neither bytes nor execution data, () | `test/n8n-dev-media.test.js:122` `assert.equal(dev.staticData, undefined);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20: digest import preserves local OpenAI credential and publication state, never CRM or Meta credentials, () | `test/n8n-dev-media.test.js:152` `assert.deepEqual(result.nodes[0].credentials, existing.nodes[0].credentials);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20: digest import preserves local OpenAI credential and publication state, never CRM or Meta credentials, () | `test/n8n-dev-media.test.js:153` `assert.equal(result.nodes[1].credentials, undefined);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20: digest import preserves local OpenAI credential and publication state, never CRM or Meta credentials, () | `test/n8n-dev-media.test.js:154` `assert.equal(result.active, true);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20: digest import preserves local OpenAI credential and publication state, never CRM or Meta credentials, () | `test/n8n-dev-media.test.js:155` `assert.equal(incoming.active, false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-20: digest import preserves local OpenAI credential and publication state, never CRM or Meta credentials, () | `test/n8n-dev-media.test.js:156` `assert.equal(JSON.stringify(result).includes('old-private'), false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: local instance explicitly uses native default binary mode and bounded resources, async () | `test/n8n-dev-media.test.js:163` `assert.match(compose, /N8N_DEFAULT_BINARY_DATA_MODE: .default./u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: local instance explicitly uses native default binary mode and bounded resources, async () | `test/n8n-dev-media.test.js:164` `assert.match(compose, /N8N_CONCURRENCY_PRODUCTION_LIMIT: .1./u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: local instance explicitly uses native default binary mode and bounded resources, async () | `test/n8n-dev-media.test.js:165` `assert.match(compose, /mem_limit: 2g/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: local instance explicitly uses native default binary mode and bounded resources, async () | `test/n8n-dev-media.test.js:166` `assert.match(compose, /import-local-workflow.mjs/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: local instance explicitly uses native default binary mode and bounded resources, async () | `test/n8n-dev-media.test.js:167` `assert.doesNotMatch(compose, /touch .*marker/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: regenerated local=${local} snapshot preserves actual media path, async () | `test/n8n-dev-media.test.js:182` `assert.deepEqual(snapshot, createDevTestWorkflow(source, { local }));` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: regenerated local=${local} snapshot preserves actual media path, async () | `test/n8n-dev-media.test.js:183` `assert.equal(snapshot.nodes.length, 77);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T15/MED-23: regenerated local=${local} snapshot preserves actual media path, async () | `test/n8n-dev-media.test.js:184` `assert.equal(       JSON.stringify(snapshot).includes('graph.facebook.com'),       false,     );` | Resultado explícito da assertion; necessário ao AC no cenário |

## T14: Workflow humano por ID Meta

MED-06/21/22/24: red oito cenarios novos falharam por ausencia do caminho de midia; green preserva reserva, bytes nativos medidos antes Crypto v2 e referencia pareada restaurada, SHA/tamanho, URL command_id textual encodeURIComponent, multipart formBinaryData, Meta por ID, preflight real imediatamente antes messages, falha conhecida antes efeito versus unknown depois sem retry. Quick827pass/3skips publicados(total830), contrato especifico8/8 mais DEV8/8 e E2E107pass/7skips publicados(total114) workers1; typecheck/lint/diff verdes. Inventario aprovado canonic51para68 e DEV60para77, mantendo assertions funcionais e cenarios removidos proibidos. Suporte minimo generator necessario ao contrato T14 simula somente upload/messages Meta e impede HTTP externo receber Basic CRM; persistencia/importer/prova runtime n8n continuam T15. API/limites/voice Meta atuais nao demonstrados por endpoints oficiais inacessiveis; ativacao failclosed exige homologated+versao explicita+phone numerico e gate externo T23. Fonte n8n2.38.7 confirmado; nenhum schema ou ADR mudou; nenhuma Verified; proximo T15.

### Adequação bidirecional

Os testes derivam dos ACs indicados nos nomes dos cenários. Cada assertion abaixo
associa critério → resultado exato e resultado → requisito. Assert de fixture
comprova isolamento. Nenhum cenário/skip/timeout publicado foi removido ou
enfraquecido; Check A/B/C/D passa dentro da fronteira desta tarefa.

| Critério / requisito (mapeamento inverso) | file:line + assertion | Resultado da spec |
| --- | --- | --- |
| test(T14/MED-21: original true reservation gates both sends; replay reaches no effect, () | `test/n8n-human-media-workflow.test.js:66` `assert.deepEqual(targets('Envio humano autorizado? (MVP)'), [     'Mensagem humana tem midia? (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: original true reservation gates both sends; replay reaches no effect, () | `test/n8n-human-media-workflow.test.js:69` `assert.deepEqual(targets('Envio humano autorizado? (MVP)', 1), [     'Responder comando sem envio (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: original true reservation gates both sends; replay reaches no effect, () | `test/n8n-human-media-workflow.test.js:72` `assert.deepEqual(targets('Mensagem humana tem midia? (MVP)'), [     'CRM - Baixar midia reservada (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: original true reservation gates both sends; replay reaches no effect, () | `test/n8n-human-media-workflow.test.js:75` `assert.deepEqual(targets('Mensagem humana tem midia? (MVP)', 1), [     'WhatsApp - Enviar texto humano (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-22: technical URL encodes command as one segment, no redirect or Meta credential, () | `test/n8n-human-media-workflow.test.js:85` `assert.ok(n, name);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-22: technical URL encodes command as one segment, no redirect or Meta credential, () | `test/n8n-human-media-workflow.test.js:86` `assert.match(n.parameters.url, /encodeURIComponent/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-22: technical URL encodes command as one segment, no redirect or Meta credential, () | `test/n8n-human-media-workflow.test.js:92` `assert.equal(       result,       'http://crm.test/api/v1/integrations/n8n/commands/send%2Fa%3Fb%3D%23c%2520/media' +         (name.includes('Preflight') ? '?preflight=true' : ''),     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-22: technical URL encodes command as one segment, no redirect or Meta credential, () | `test/n8n-human-media-workflow.test.js:97` `assert.equal(n.parameters.options.redirect.redirect.followRedirects, false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-22: technical URL encodes command as one segment, no redirect or Meta credential, () | `test/n8n-human-media-workflow.test.js:98` `assert.equal(n.parameters.genericAuthType, 'httpBasicAuth');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/22: ${type} measures bytes before hash and restores paired binary for multipart, async () | `test/n8n-human-media-workflow.test.js:117` `assert.equal(measured.json.media_size_bytes, bytes.length);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/22: ${type} measures bytes before hash and restores paired binary for multipart, async () | `test/n8n-human-media-workflow.test.js:118` `assert.equal(measured.binary.data, input.binary.data);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/22: ${type} measures bytes before hash and restores paired binary for multipart, async () | `test/n8n-human-media-workflow.test.js:127` `assert.equal(restored.binary.data, input.binary.data);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/22: ${type} measures bytes before hash and restores paired binary for multipart, async () | `test/n8n-human-media-workflow.test.js:128` `assert.equal(restored.json.media_sha256, command(type).message.sha256);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/22: ${type} measures bytes before hash and restores paired binary for multipart, async () | `test/n8n-human-media-workflow.test.js:129` `assert.equal(       targets('Medir midia reservada (MVP)')[0],       'Crypto - SHA256 midia (MVP)',     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/22: ${type} measures bytes before hash and restores paired binary for multipart, async () | `test/n8n-human-media-workflow.test.js:133` `assert.equal(       targets('Crypto - SHA256 midia (MVP)')[0],       'Validar hash e restaurar midia (MVP)',     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: hash/size mismatch fails before upload or messages, async () | `test/n8n-human-media-workflow.test.js:141` `await assert.rejects(     code('Medir midia reservada (MVP)', input, {       [reserve]: {         json: { command: { ...c, message: { ...c.message, size_bytes: 1 } } },       },     }),     /MEDIA_INTEGRITY_MISMATCH/u,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: hash/size mismatch fails before upload or messages, async () | `test/n8n-human-media-workflow.test.js:149` `await assert.rejects(     code(       'Validar hash e restaurar midia (MVP)',       {         json: { media_size_bytes: bytes.length, media_sha256: 'b'.repeat(64) },       },       { [reserve]: { json: { command: c } } },     ),;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: hash/size mismatch fails before upload or messages, async () | `test/n8n-human-media-workflow.test.js:159` `assert.deepEqual(targets('Validar hash e restaurar midia (MVP)', 1), [     'Falha de integridade da midia (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:164` `assert.deepEqual(targets('Meta - Upload midia humana (MVP)'), [     'CRM - Preflight midia reservada (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:167` `assert.deepEqual(targets('CRM - Preflight midia reservada (MVP)'), [     'Preparar mensagem Meta de midia (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:170` `assert.deepEqual(targets('Preparar mensagem Meta de midia (MVP)'), [     'Meta - Enviar midia humana (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:173` `assert.deepEqual(targets('Meta - Enviar midia humana (MVP)', 1), [     'Preparar envio humano desconhecido (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:176` `assert.equal(     nodes.get('Meta - Enviar midia humana (MVP)').retryOnFail,     false,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:180` `assert.equal(     nodes.get('Meta - Upload midia humana (MVP)').retryOnFail,     false,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:184` `assert.match(     nodes.get('Meta - Upload midia humana (MVP)').parameters.url,     /SILMER_META_MEDIA_HOMOLOGATED/u,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-24: upload precedes read-only preflight; message effect never retries and failure becomes unknown, () | `test/n8n-human-media-workflow.test.js:188` `assert.equal(     nodes.get('Crypto - SHA256 midia (MVP)').parameters.binaryData,     true,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:212` `assert.deepEqual(JSON.parse(JSON.stringify(prepared.json.meta_message)), {     messaging_product: 'whatsapp',     to: c.to,     type: 'audio',     audio: { id: 'meta-media-id' },   });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:218` `await assert.rejects(     code(       'Preparar mensagem Meta de midia (MVP)',       { json: { ...preflight, valid: false } },       upstream,     ),     /MEDIA_PREFLIGHT_REJECTED/u,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:231` `assert.equal(failure.json.payload.failure.phase, 'before_message_send');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:232` `assert.equal(failure.json.payload.failure.code, 'MEDIA_PREFLIGHT_REJECTED');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:233` `assert.equal(failure.json.payload.command_id, c.command_id);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:234` `assert.equal(failure.json.payload.conversation_id, c.conversation_id);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21/24: failed preflight emits known failure; only valid metadata becomes message ID payload, async () | `test/n8n-human-media-workflow.test.js:235` `assert.deepEqual(targets('CRM - Preflight midia reservada (MVP)', 1), [     'Preflight da midia indisponivel (MVP)',   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:238` `assert.equal(download?.type, 'n8n-nodes-base.httpRequest');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:239` `assert.equal(hash?.type, 'n8n-nodes-base.crypto');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:240` `assert.equal(preflight?.type, 'n8n-nodes-base.httpRequest');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:241` `assert.equal(upload?.type, 'n8n-nodes-base.code');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:242` `assert.equal(send?.type, 'n8n-nodes-base.code');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:243` `assert.match(upload.parameters.jsCode, /getBinaryDataBuffer/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:244` `assert.match(send.parameters.jsCode, /simulate_send_unknown/u);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:245` `assert.deepEqual(dev.connections[upload.name].main[0], [     { node: preflight.name, type: 'main', index: 0 },   ]);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:248` `assert.equal(     nodes.some((node) => node.parameters?.url?.includes('graph.facebook.com')),     false,   );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight, async () | `test/n8n-dev-workflow.test.js:252` `assert.equal(     nodes.some((node) => node.credentials?.whatsAppApi),     false,   );` | Resultado explícito da assertion; necessário ao AC no cenário |

## Fix T13: texto reservado não permite leitura técnica de mídia

MED-22: revisão intermediária encontrou caminho text sem bound row. Red SQL
mostrou undefined aceito e HTTP GET503; reader agora exige image/audio/video
e bound row existente, retornando409 no GET e preflight, sem S3 ou mutação.
`test/chat-media-bind-postgres-live.test.js:838` assert.equal(response.statusCode,409)
para as duas representações e `:842` assert.rejects(repo.readReservedMedia(...),
{statusCode:409}) cobrem o critério. `:849` assert.deepEqual(await effects(),before)
prova ausência de mutações. Inversamente cada assertion corresponde a MED-22;
nenhum caso publicado removido ou enfraquecido. Fixture monta reserva real SQL
e transporte Fastify; texto normal preservado pelos cenários T12. Quick818/3
skips antigos; bindSQL46/46 (45 anteriores+1 novo); transporte8/8,
typecheck/lint/diff verdes. Fix isolado; testes novos T14 ainda red foram
preservados em var apenas durante este gate e serão restaurados. Nenhum Verified.

## T13: Endpoint tecnico e preflight por reserva

MED-16/20/21/22/24: red inicial demonstrou metodo de leitura ausente e abort de outra execucao aceito. GET valida Basic/capacidade minima, comando processing/mensagem sending, identidade original do recibo n8n_events, variante bound e fence human/nonterminal/epoch/revision. Preflight JSON nao acessa S3 nem renova/reserva; HEAD e seletores estrangeiros negados. workflow.failed before_message_send conclui sob CAS original e allowlist, mesmo com epoch invalidado, sem retry nem regressao final. SQL60/60=45bind(38baseline+7T13)+7inbox+3migrations+1command-store+4n8n-integration, zero skips; comandos node --test --test-concurrency=1 com esses cinco arquivos, TEST_DATABASE_URL dedicada. Quick818pass/3skips antigos; transporte8/8; E2E107/7skips antigos com workers1; typecheck/lint/diff e spec/tasks strict verdes. Sem schema novo; proviniencia em events, nao commands. Prova dos ramos preMeta fica em T14/T15; Meta/recovery externos T23 e Verifier final pendentes. Proximo T14;11 tarefas restantes; nenhuma Verified.

### Adequação bidirecional

Os testes derivam dos ACs indicados nos nomes dos cenários. Cada assertion abaixo
associa critério → resultado exato e resultado → requisito. Assert de fixture
comprova isolamento. Nenhum cenário/skip/timeout publicado foi removido ou
enfraquecido; Check A/B/C/D passa dentro da fronteira desta tarefa.

| Critério / requisito (mapeamento inverso) | file:line + assertion | Resultado da spec |
| --- | --- | --- |
| test(T13/MED-22: bytes use reserved command and exact workflow identity, async (t) | `test/n8n-command-media-routes.test.js:66` `assert.equal(response.statusCode, 200);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: bytes use reserved command and exact workflow identity, async (t) | `test/n8n-command-media-routes.test.js:67` `assert.equal(response.body, 'PNG');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: bytes use reserved command and exact workflow identity, async (t) | `test/n8n-command-media-routes.test.js:68` `assert.equal(calls[0].commandId, 'command');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: bytes use reserved command and exact workflow identity, async (t) | `test/n8n-command-media-routes.test.js:69` `assert.deepEqual(calls[0].technical, {     workflowKey: 'workflow',     workflowVersion: 'version',     executionId: 'execution',   });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: bytes use reserved command and exact workflow identity, async (t) | `test/n8n-command-media-routes.test.js:74` `assert.equal(response.headers['cache-control'], 'private, no-store');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-21: preflight has safe metadata and zero content reads, async (t) | `test/n8n-command-media-routes.test.js:82` `assert.equal(response.statusCode, 200);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-21: preflight has safe metadata and zero content reads, async (t) | `test/n8n-command-media-routes.test.js:83` `assert.deepEqual(response.json(), {     valid: true,     media_id: 'media',     type: 'image',     sha256: 'a'.repeat(64),     mime_type: 'image/png',     size_bytes: 3,   });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-21: preflight has safe metadata and zero content reads, async (t) | `test/n8n-command-media-routes.test.js:91` `assert.equal(calls.length, 1);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16/22: denied ${status} exposes no bytes or private data, async (t) | `test/n8n-command-media-routes.test.js:100` `assert.equal(response.statusCode, status);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16/22: denied ${status} exposes no bytes or private data, async (t) | `test/n8n-command-media-routes.test.js:101` `assert.equal(response.body.includes('private-key-canary'), false);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16/22: denied ${status} exposes no bytes or private data, async (t) | `test/n8n-command-media-routes.test.js:102` `assert.equal(response.headers['cache-control'], 'private, no-store');` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16: missing Basic or execution identity cannot read; HEAD and foreign selectors refused, async (t) | `test/n8n-command-media-routes.test.js:110` `assert.equal(     (       await api.inject({         url: '/api/v1/integrations/n8n/commands/command/media',         headers: missingAuth,       })     ).statusCode,     401,;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16: missing Basic or execution identity cannot read; HEAD and foreign selectors refused, async (t) | `test/n8n-command-media-routes.test.js:119` `assert.equal(     (       await api.inject({         url: '/api/v1/integrations/n8n/commands/command/media',         headers: missingExecution,       })     ).statusCode,     400,;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16: missing Basic or execution identity cannot read; HEAD and foreign selectors refused, async (t) | `test/n8n-command-media-routes.test.js:128` `assert.equal(     (       await api.inject({         method: 'HEAD',         url: '/api/v1/integrations/n8n/commands/command/media',         headers,       })     ).statusCode,;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16: missing Basic or execution identity cannot read; HEAD and foreign selectors refused, async (t) | `test/n8n-command-media-routes.test.js:138` `assert.equal(     (       await api.inject({         url: '/api/v1/integrations/n8n/commands/command/media?conversation_id=other',         headers,       })     ).statusCode,     400,;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-16: missing Basic or execution identity cannot read; HEAD and foreign selectors refused, async (t) | `test/n8n-command-media-routes.test.js:147` `assert.equal(calls.length, 0);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-21/22: stale or inconsistent variant denies read ${mutation.split(SET )[1]}, async () | `test/chat-media-bind-postgres-live.test.js:817` `await assert.rejects(         repo.readReservedMedia({           commandId: f.row.command_id,           technical: event.technical,         }),         { statusCode: 409 },       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-21/22: stale or inconsistent variant denies read ${mutation.split(SET )[1]}, async () | `test/chat-media-bind-postgres-live.test.js:824` `assert.deepEqual(await effects(), before);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:836` `await assert.rejects(repo.readReservedMedia(input), { statusCode: 409 });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:839` `assert.equal((await repo.readReservedMedia(input)).id, f.id);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:840` `assert.equal(       (await f.integration.recordEvent(event)).send_authorized,       false,     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:844` `assert.equal(       (await repo.readReservedMedia(input)).content_sha256,       'b'.repeat(64),     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:848` `assert.deepEqual(await effects(), before);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:850` `await assert.rejects(         repo.readReservedMedia({           ...input,           technical: { ...input.technical, [key]: 'other' },         }),         { statusCode: 409 },       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:861` `await assert.rejects(repo.readReservedMedia(input), { statusCode: 409 });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:871` `assert.deepEqual(       (         await pool.query(           'SELECT status,retryable,retry_safe,locked_by,locked_until FROM crm.n8n_commands WHERE command_id=$1',           [f.row.command_id],         )       ).rows[0],       {;` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:886` `assert.equal(       (         await pool.query('SELECT status FROM crm.messages WHERE id=$1', [           f.sent.id,         ])       ).rows[0].status,       'failed',     );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:895` `assert.equal((await f.integration.recordEvent(failure)).duplicate, true);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-22: reserved media is read-only and bound to original execution, async () | `test/chat-media-bind-postgres-live.test.js:896` `assert.deepEqual(await effects(), after);` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-24: before-send failure cannot regress ${terminal} or another execution, async () | `test/chat-media-bind-postgres-live.test.js:910` `await assert.rejects(         f.integration.recordEvent({           ...failure,           technical: { ...failure.technical, executionId: 'other' },         }),         { statusCode: 409 },       );` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-24: before-send failure cannot regress ${terminal} or another execution, async () | `test/chat-media-bind-postgres-live.test.js:926` `await assert.rejects(f.integration.recordEvent(failure), {         statusCode: 409,       });` | Resultado explícito da assertion; necessário ao AC no cenário |
| test(T13/MED-24: before-send failure cannot regress ${terminal} or another execution, async () | `test/chat-media-bind-postgres-live.test.js:929` `assert.deepEqual(await effects(), before);` | Resultado explícito da assertion; necessário ao AC no cenário |

## T12: Outbox e fence de variante imutavel

MED-06/20/21/24: testes antes do codigo demonstraram ausencia de metadata exata e hash/MIME/size/caption divergentes aceitos. Outbox deriva referencia exclusivamente de chat_media attached/clean bound ao autor/mensagem/conversa; message plana identifica media_id, sha256, mime_type, size_bytes, type, caption e text, mantendo filename/media_url null e texto legado identico. Fence reconsulta variante/legenda sob lock e cobre aliases contraditorios, epoch/source, uso unico e replay send_authorized=false. Red adicional mostrou callbacks sent/unknown com conversation_id contraditorio aceitos; resolucao canonica reutiliza UNION comandos/mensagens apenas nesses callbacks, antes de efeitos, e UPDATEs exigem conversa. Snapshot integral de mensagens/comandos/auditoria/SSE/recibos permanece identico no 409. Red de reconciliacao mostrou comando outcome_unknown apos sent e erro residual OUTCOME_UNKNOWN: confirmacao conhecida agora limpa erro, move para sent e conserva retryable/retry_safe=false. Jobs/itens open preexistentes ficam intactos como historico para revisao operacional, sem retry/reagendamento. Nenhuma implementacao T13. Campo caption e validacao400 pertencem a /messages; upload multipart mantem422.

### Adequação bidirecional

Cada cenário da spec está ligado às assertions discriminantes abaixo. A coluna
cenário faz a associação suficiente; a coluna fonte/assertion faz a associação
inversa de cada teste ao contrato, incluindo expansões por arrays parametrizados.
Nenhuma assertion/timeouts/skips publicada foi enfraquecida.

| Critério / requisito | file:line + assertion | Resultado |
| --- | --- | --- |
| test(T12/MED-06/21: canonical comparison covers reference/hash/MIME/size/caption/type, () => { | `test/chat-media-outbox-fence.test.js:27` `assert.notDeepEqual(comparableOutbound({ ...media, ...change }), original);` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: retained media forbids alias ${alias}, () => { | `test/chat-media-outbox-fence.test.js:31` `assert.throws( () => comparableOutbound({ ...media, [alias]: 'different' }), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: contradictory legacy aliases cannot be silently selected, () => { | `test/chat-media-outbox-fence.test.js:37` `assert.throws( () => comparableOutbound({ type: 'text', text: 'Synthetic', attachment_id: 'one', media_id: 'two', }), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-16/21: arbitrary media metadata ${JSON.stringify(extra)} is refused, () => { | `test/chat-media-outbox-fence.test.js:56` `assert.throws(() => comparableOutbound({ ...media, ...extra }), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T12/MED-06: text comparison preserves baseline shape semantics, () => { | `test/chat-media-outbox-fence.test.js:61` `assert.deepEqual( comparableOutbound({ type: 'text', text: 'Synthetic' }), comparableOutbound({ type: 'text', text: 'Synthetic', filename: null, media_url: null, }), );` | Resultado explícito discriminante da assertion |
| test(T12/MED-06: text comparison preserves baseline shape semantics, () => { | `test/chat-media-outbox-fence.test.js:70` `assert.notDeepEqual( comparableOutbound({ type: 'text', text: 'Changed' }), comparableOutbound({ type: 'text', text: 'Synthetic' }), );` | Resultado explícito discriminante da assertion |
| T12: isolamento/fixture | `test/chat-media-bind-postgres-live.test.js:34` `assert.equal(new URL(connectionString).pathname, '/crm_silmer_test');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:176` `assert.equal((await snapshot()).automation, 'assistant');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:181` `assert.equal(row.state, 'attached');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:182` `assert.equal(row.message_id, message.id);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:183` `assert.equal(Number(row.reservation_bytes), 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:184` `assert.deepEqual(await snapshot(), { messages: 1, commands: 1, audits: 1, reserved: '0', used: '100', automation: 'human', });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:192` `assert.equal((await inbox.sendHumanMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:193` `assert.deepEqual(await snapshot(), { messages: 1, commands: 1, audits: 1, reserved: '0', used: '100', automation: 'human', });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:201` `assert.equal( Number( (await pool.query(`SELECT count(*) AS count FROM crm.domain_events`)) .rows[0].count, ), 1, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:216` `assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:217` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:218` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/08: invalid bind ${JSON.stringify(options)} rolls back,  | `test/chat-media-bind-postgres-live.test.js:229` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: options.actorId ? 403 : 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/08: invalid bind ${JSON.stringify(options)} rolls back,  | `test/chat-media-bind-postgres-live.test.js:232` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T10/MED-08: admin read capability cannot bind another actor media,  | `test/chat-media-bind-postgres-live.test.js:236` `await assert.rejects( service().sendHumanMessage( command(id, { actor: { ...actor, capabilities: ['COMMERCIAL_ADMIN'] }, }), ), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-08: admin read capability cannot bind another actor media,  | `test/chat-media-bind-postgres-live.test.js:244` `assert.equal((await snapshot()).automation, 'assistant');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: second message cannot reuse attached media,  | `test/chat-media-bind-postgres-live.test.js:250` `await assert.rejects( inbox.sendHumanMessage(command(id, { expectedVersion: 2 })), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: second message cannot reuse attached media,  | `test/chat-media-bind-postgres-live.test.js:254` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:260` `await assert.rejects( service({ [failure]: true }).sendHumanMessage(command(id)), /synthetic-/u, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:264` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:265` `assert.equal( (await pool.query('SELECT state FROM crm.chat_media WHERE id=$1', [id])) .rows[0].state, 'ready', );` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:282` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:285` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:286` `assert.equal((await snapshot()).reserved, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: message kind and validated MIME must agree,  | `test/chat-media-bind-postgres-live.test.js:290` `await assert.rejects( service().sendHumanMessage( command(id, { messageType: 'audio', content: { mediaId: id } }), ), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: message kind and validated MIME must agree,  | `test/chat-media-bind-postgres-live.test.js:296` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: ready ${kind} binds validated kind,  | `test/chat-media-bind-postgres-live.test.js:308` `assert.equal(sent.type, kind);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: ready ${kind} binds validated kind,  | `test/chat-media-bind-postgres-live.test.js:309` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: MIME ${mime} outside approved formats cannot bind,  | `test/chat-media-bind-postgres-live.test.js:318` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: MIME ${mime} outside approved formats cannot bind,  | `test/chat-media-bind-postgres-live.test.js:321` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: image above five MiB cannot bind despite a ready row,  | `test/chat-media-bind-postgres-live.test.js:334` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: image above five MiB cannot bind despite a ready row,  | `test/chat-media-bind-postgres-live.test.js:337` `assert.equal((await snapshot()).reserved, String(size));` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: disabled admission replays accepted send and blocks new send without mutation,  | `test/chat-media-bind-postgres-live.test.js:354` `assert.equal((await disabled.sendMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: disabled admission replays accepted send and blocks new send without mutation,  | `test/chat-media-bind-postgres-live.test.js:355` `await assert.rejects( disabled.sendMessage(command(id, { expectedVersion: 2 })), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: disabled admission replays accepted send and blocks new send without mutation,  | `test/chat-media-bind-postgres-live.test.js:359` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:410` `assert.equal(first.statusCode, 202);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:412` `assert.equal(second.statusCode, 202);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:413` `assert.equal(second.json().id, first.json().id);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:414` `assert.notEqual(traces[0], traces[1]);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:415` `assert.equal( (await post('Synthetic', 'crm_session=seller', true)).statusCode, 202, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:419` `assert.equal((await post('Different')).statusCode, 409);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:420` `assert.equal( (await post('Synthetic', 'crm_session=other')).statusCode, 409, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:424` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:425` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: legacy fingerprint replays same original trace but cannot reconstruct a changed trace,  | `test/chat-media-bind-postgres-live.test.js:455` `assert.equal((await inbox.sendHumanMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: legacy fingerprint replays same original trace but cannot reconstruct a changed trace,  | `test/chat-media-bind-postgres-live.test.js:456` `await assert.rejects( inbox.sendHumanMessage({ ...input, correlationId: randomUUID() }), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: legacy fingerprint replays same original trace but cannot reconstruct a changed trace,  | `test/chat-media-bind-postgres-live.test.js:460` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:535` `assert.equal(f.payload.message.media_id, f.id);` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:536` `assert.equal(f.payload.message.sha256, 'b'.repeat(64));` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:537` `assert.equal(f.payload.message.mime_type, 'image/png');` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:538` `assert.equal(f.payload.message.size_bytes, 100);` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:539` `assert.equal(f.payload.message.caption, 'Synthetic caption');` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:540` `assert.equal(f.payload.message.type, 'image');` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:541` `assert.equal(JSON.stringify(f.payload).includes('object_key'), false);` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:543` `assert.equal( (await f.integration.recordEvent(event)).send_authorized, true, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:547` `assert.equal( (await f.integration.recordEvent(event)).send_authorized, false, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:551` `await assert.rejects( f.integration.recordEvent(f.event('already-sending')), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:555` `assert.equal( ( await pool.query('SELECT status FROM crm.messages WHERE id=$1', [ f.sent.id, ]) ).rows[0].status, 'sending', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: outbox identifies exact bound variant and replay never reauthorizes,  | `test/chat-media-bind-postgres-live.test.js:563` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: variant or alias mismatch ${JSON.stringify(change)} never reserves,  | `test/chat-media-bind-postgres-live.test.js:576` `await assert.rejects( f.integration.recordEvent( f.event('mismatch', { message: { ...f.payload.message, ...change } }), ), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: variant or alias mismatch ${JSON.stringify(change)} never reserves,  | `test/chat-media-bind-postgres-live.test.js:582` `assert.equal( ( await pool.query('SELECT status FROM crm.messages WHERE id=$1', [ f.sent.id, ]) ).rows[0].status, 'queued', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: variant or alias mismatch ${JSON.stringify(change)} never reserves,  | `test/chat-media-bind-postgres-live.test.js:590` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: epoch/source fence ${JSON.stringify(change)} never reserves,  | `test/chat-media-bind-postgres-live.test.js:595` `await assert.rejects( f.integration.recordEvent(f.event('stale', change)), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: epoch/source fence ${JSON.stringify(change)} never reserves,  | `test/chat-media-bind-postgres-live.test.js:599` `assert.equal( ( await pool.query('SELECT status FROM crm.messages WHERE id=$1', [ f.sent.id, ]) ).rows[0].status, 'queued', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: drift of bound variant after outbox is refused,  | `test/chat-media-bind-postgres-live.test.js:614` `await assert.rejects(f.integration.recordEvent(f.event('drift')), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T12/MED-21: drift of bound variant after outbox is refused,  | `test/chat-media-bind-postgres-live.test.js:617` `assert.equal( ( await pool.query('SELECT status FROM crm.messages WHERE id=$1', [ f.sent.id, ]) ).rows[0].status, 'queued', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:629` `assert.equal( (await f.integration.recordEvent(reservation)).send_authorized, true, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:654` `assert.deepEqual(unknown, { status: 'outcome_unknown', retryable: false, retry_safe: false, });` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:675` `assert.equal( (await f.integration.recordEvent(reservation)).send_authorized, false, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:679` `await assert.rejects( f.integration.recordEvent(f.event('new-reservation')), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:688` `assert.deepEqual( ( await pool.query( 'SELECT status,retryable,retry_safe,last_error_code FROM crm.n8n_commands WHERE command_id=$1', [f.row.command_id], ) ).rows[0], { status: 'sent', retryable: false, retry_safe: false, last_error_code: null, }, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:702` `assert.deepEqual(await history(), unknownHistory);` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:718` `assert.equal( ( await pool.query( 'SELECT delivery_status FROM crm.messages WHERE id=$1', [f.sent.id], ) ).rows[0].delivery_status, 'read', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-24: unknown Meta outcome has no blind retry and callbacks remain monotonic,  | `test/chat-media-bind-postgres-live.test.js:727` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T12/MED-06: text outbox wire shape and reservation stay compatible,  | `test/chat-media-bind-postgres-live.test.js:731` `assert.deepEqual(f.payload.message, { filename: null, media_url: null, text: 'Synthetic text', type: 'text', });` | Resultado explícito discriminante da assertion |
| test(T12/MED-06: text outbox wire shape and reservation stay compatible,  | `test/chat-media-bind-postgres-live.test.js:737` `assert.equal( (await f.integration.recordEvent(f.event('text-reserve'))) .send_authorized, true, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-06: text outbox wire shape and reservation stay compatible,  | `test/chat-media-bind-postgres-live.test.js:742` `assert.equal((await snapshot()).used, '0');` | Resultado explícito discriminante da assertion |
| test(T12/MED-21/24: contradictory callback conversation ${eventType} has no effect,  | `test/chat-media-bind-postgres-live.test.js:775` `await assert.rejects(f.integration.recordEvent(callback), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T12/MED-21/24: contradictory callback conversation ${eventType} has no effect,  | `test/chat-media-bind-postgres-live.test.js:778` `assert.deepEqual(await effects(), before);` | Resultado explícito discriminante da assertion |
| test(T12/MED-21/24: contradictory callback conversation ${eventType} has no effect,  | `test/chat-media-bind-postgres-live.test.js:779` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: exact ${type} variant reserves with appropriate caption,  | `test/chat-media-bind-postgres-live.test.js:784` `assert.equal(f.payload.message.media_id, f.id);` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: exact ${type} variant reserves with appropriate caption,  | `test/chat-media-bind-postgres-live.test.js:785` `assert.equal(f.payload.message.type, type);` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: exact ${type} variant reserves with appropriate caption,  | `test/chat-media-bind-postgres-live.test.js:786` `assert.equal( f.payload.message.mime_type, type === 'audio' ? 'audio/ogg' : 'video/mp4', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: exact ${type} variant reserves with appropriate caption,  | `test/chat-media-bind-postgres-live.test.js:790` `assert.equal( f.payload.message.caption, type === 'audio' ? null : 'Synthetic caption', );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: exact ${type} variant reserves with appropriate caption,  | `test/chat-media-bind-postgres-live.test.js:794` `assert.equal( (await f.integration.recordEvent(f.event(`${type}-reserve`))) .send_authorized, true, );` | Resultado explícito discriminante da assertion |
| test(T12/MED-20/21: exact ${type} variant reserves with appropriate caption,  | `test/chat-media-bind-postgres-live.test.js:799` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |

Gates: unit 11/11; SQL final 50/50 sem skips (38 bind/media incluindo 17 T12, 7 inbox, 4 n8n integration, 1 command store); validate 810 pass/3 skips antigos/813 total com build; E2E exclusivo 107 pass/7 skips antigos/114 total; npm audit zero vulnerabilidades; diff --check e validadores spec/tasks strict sem erros. validate_state de fechamento permanece esperado pendente por ausencia de validation.md final, conforme fase incompleta e author != verifier. Autor não é Verifier; requisitos permanecem In Progress.


## T11: Contrato humano e replay semantico

MED-04..08: testes antes de codigo para content={mediaId,caption?}, captionUnicode1024 somente image/video, audio sem caption, nenhum key/URL/alias e texto preservado. Full inicialmente passou18 novos. Revisao corrigiu gate para apos replay; red demonstrou flagfalse bloqueando repeticao aceita, trace HTTP novo409 e ordem invertida409. Fingerprint novo exclui correlationId e usa JSON canonico sem dependencia ciclica; actor/conv/version/type/content/reason continuam cobertos. Fallback hashJson(input) preserva replay legado com mesma identificacao original; trace legado novo nao e recuperavel sem payload original e permanece409 documentado. Gateflagfalse consulta comando antes de negar newsend403 e antes de lock/mutacao de dominio, sem impedir replay exato. SQL3 novos comprovam replay sem header de correlacao, chaves invertidas, caption/ator diferentes409, flagfalse e fallback legado. Fixtures unpublished ajustadas para novo contrato de porta mediaEnabled e leitura idempotente, mantendo assertions sem efeito e autorizacao.

### Adequação bidirecional

Cada cenário da spec está ligado às assertions discriminantes abaixo. A coluna
cenário faz a associação suficiente; a coluna fonte/assertion faz a associação
inversa de cada teste ao contrato, incluindo expansões por arrays parametrizados.
Nenhuma assertion/timeouts/skips publicada foi enfraquecida.

| Critério / requisito | file:line + assertion | Resultado |
| --- | --- | --- |
| test(T11/MED-04: canonical ${kind} reference accepted,  | `test/chat-media-send-contract.test.js:55` `assert.deepEqual(result.content, { mediaId: id });` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: canonical ${kind} reference accepted,  | `test/chat-media-send-contract.test.js:56` `assert.equal(result.type, kind);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: canonical ${kind} reference accepted,  | `test/chat-media-send-contract.test.js:57` `assert.equal(h.calls.length, 1);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: ${kind} caption counts Unicode codepoints,  | `test/chat-media-send-contract.test.js:63` `assert.equal( (await h.send(kind, { mediaId: id, caption })).content.caption, caption, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: ${kind} caption counts Unicode codepoints,  | `test/chat-media-send-contract.test.js:67` `await assert.rejects( h.send(kind, { mediaId: id, caption: caption + '😀' }), { code: 'INBOX_INVALID', statusCode: 400 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: audio caption is forbidden ${JSON.stringify(content)},  | `test/chat-media-send-contract.test.js:78` `await assert.rejects(h.send('audio', content), { code: 'INBOX_INVALID', statusCode: 400, });` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: audio caption is forbidden ${JSON.stringify(content)},  | `test/chat-media-send-contract.test.js:82` `assert.equal(h.calls.length, 0);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/16: reject arbitrary reference/payload ${JSON.stringify(content)},  | `test/chat-media-send-contract.test.js:94` `await assert.rejects(h.send('image', content), { code: 'INBOX_INVALID', statusCode: 400, });` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/16: reject arbitrary reference/payload ${JSON.stringify(content)},  | `test/chat-media-send-contract.test.js:98` `assert.equal(h.calls.length, 0);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: unsupported document type is rejected,  | `test/chat-media-send-contract.test.js:101` `await assert.rejects(harness().send('document', { mediaId: id }), { code: 'INBOX_INVALID', statusCode: 400, });` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: text content retains existing behavior with media admission disabled,  | `test/chat-media-send-contract.test.js:109` `assert.deepEqual((await h.send('text', text)).content, text);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: text content retains existing behavior with media admission disabled,  | `test/chat-media-send-contract.test.js:110` `await assert.rejects(h.send('image', { mediaId: id }), { statusCode: 403 });` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: text content retains existing behavior with media admission disabled,  | `test/chat-media-send-contract.test.js:111` `assert.equal(h.calls.length, 1);` | Resultado explícito discriminante da assertion |
| test(T11/MED-08: non-human and non-Vendedor remain forbidden,  | `test/chat-media-send-contract.test.js:118` `await assert.rejects( harness().service.sendHumanMessage({ actor: invalid }), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/08: HTTP boundary forwards canonical media, reports predictable payload and ACL errors,  | `test/chat-media-send-contract.test.js:131` `assert.equal(input.action, 'conversation.message.send');` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/08: HTTP boundary forwards canonical media, reports predictable payload and ACL errors,  | `test/chat-media-send-contract.test.js:160` `assert.equal( (await post({ mediaId: id, caption: 'Caption' })).statusCode, 202, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/08: HTTP boundary forwards canonical media, reports predictable payload and ACL errors,  | `test/chat-media-send-contract.test.js:164` `assert.equal( (await post({ mediaId: id, url: 'https://example.test' })).statusCode, 400, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/08: HTTP boundary forwards canonical media, reports predictable payload and ACL errors,  | `test/chat-media-send-contract.test.js:168` `assert.equal( (await post({ mediaId: id, url: 'https://example.test' })).json().error .code, 'INBOX_INVALID', );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/08: HTTP boundary forwards canonical media, reports predictable payload and ACL errors,  | `test/chat-media-send-contract.test.js:173` `assert.equal( (await post({ mediaId: id }, 'crm_session=forbidden')).statusCode, 403, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04/08: HTTP boundary forwards canonical media, reports predictable payload and ACL errors,  | `test/chat-media-send-contract.test.js:177` `assert.equal(h.calls.length, 1);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: production runtime checks replay then blocks new media before domain mutation while preserving text,  | `test/chat-media-send-contract.test.js:212` `await assert.rejects( runtime.sendMessage({ ...command, messageType: 'image', content: { mediaId: id }, }), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: production runtime checks replay then blocks new media before domain mutation while preserving text,  | `test/chat-media-send-contract.test.js:220` `assert.equal(queries, 2);` | Resultado explícito discriminante da assertion |
| test(T11/MED-04: production runtime checks replay then blocks new media before domain mutation while preserving text,  | `test/chat-media-send-contract.test.js:221` `assert.equal( statements.some((sql) => /crm.conversations|UPDATE|INSERT/u.test(sql)), false, );` | Resultado explícito discriminante da assertion |
| statements.some((sql) => /crm.conversations/UPDATE/INSERT/u.test(sql)), | `test/chat-media-send-contract.test.js:225` `await assert.rejects( runtime.sendMessage({ ...command, messageType: 'text', content: { text: 'Synthetic' }, }), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| statements.some((sql) => /crm.conversations/UPDATE/INSERT/u.test(sql)), | `test/chat-media-send-contract.test.js:233` `assert.ok(queries > 0);` | Resultado explícito discriminante da assertion |
| T11: isolamento/fixture | `test/chat-media-bind-postgres-live.test.js:34` `assert.equal(new URL(connectionString).pathname, '/crm_silmer_test');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:176` `assert.equal((await snapshot()).automation, 'assistant');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:181` `assert.equal(row.state, 'attached');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:182` `assert.equal(row.message_id, message.id);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:183` `assert.equal(Number(row.reservation_bytes), 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:184` `assert.deepEqual(await snapshot(), { messages: 1, commands: 1, audits: 1, reserved: '0', used: '100', automation: 'human', });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:192` `assert.equal((await inbox.sendHumanMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:193` `assert.deepEqual(await snapshot(), { messages: 1, commands: 1, audits: 1, reserved: '0', used: '100', automation: 'human', });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:201` `assert.equal( Number( (await pool.query(`SELECT count(*) AS count FROM crm.domain_events`)) .rows[0].count, ), 1, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:216` `assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:217` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:218` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/08: invalid bind ${JSON.stringify(options)} rolls back,  | `test/chat-media-bind-postgres-live.test.js:229` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: options.actorId ? 403 : 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/08: invalid bind ${JSON.stringify(options)} rolls back,  | `test/chat-media-bind-postgres-live.test.js:232` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T10/MED-08: admin read capability cannot bind another actor media,  | `test/chat-media-bind-postgres-live.test.js:236` `await assert.rejects( service().sendHumanMessage( command(id, { actor: { ...actor, capabilities: ['COMMERCIAL_ADMIN'] }, }), ), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-08: admin read capability cannot bind another actor media,  | `test/chat-media-bind-postgres-live.test.js:244` `assert.equal((await snapshot()).automation, 'assistant');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: second message cannot reuse attached media,  | `test/chat-media-bind-postgres-live.test.js:250` `await assert.rejects( inbox.sendHumanMessage(command(id, { expectedVersion: 2 })), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: second message cannot reuse attached media,  | `test/chat-media-bind-postgres-live.test.js:254` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:260` `await assert.rejects( service({ [failure]: true }).sendHumanMessage(command(id)), /synthetic-/u, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:264` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:265` `assert.equal( (await pool.query('SELECT state FROM crm.chat_media WHERE id=$1', [id])) .rows[0].state, 'ready', );` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:282` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:285` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:286` `assert.equal((await snapshot()).reserved, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: message kind and validated MIME must agree,  | `test/chat-media-bind-postgres-live.test.js:290` `await assert.rejects( service().sendHumanMessage( command(id, { messageType: 'audio', content: { mediaId: id } }), ), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: message kind and validated MIME must agree,  | `test/chat-media-bind-postgres-live.test.js:296` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: ready ${kind} binds validated kind,  | `test/chat-media-bind-postgres-live.test.js:308` `assert.equal(sent.type, kind);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: ready ${kind} binds validated kind,  | `test/chat-media-bind-postgres-live.test.js:309` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: MIME ${mime} outside approved formats cannot bind,  | `test/chat-media-bind-postgres-live.test.js:318` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: MIME ${mime} outside approved formats cannot bind,  | `test/chat-media-bind-postgres-live.test.js:321` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: image above five MiB cannot bind despite a ready row,  | `test/chat-media-bind-postgres-live.test.js:334` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: image above five MiB cannot bind despite a ready row,  | `test/chat-media-bind-postgres-live.test.js:337` `assert.equal((await snapshot()).reserved, String(size));` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: disabled admission replays accepted send and blocks new send without mutation,  | `test/chat-media-bind-postgres-live.test.js:354` `assert.equal((await disabled.sendMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: disabled admission replays accepted send and blocks new send without mutation,  | `test/chat-media-bind-postgres-live.test.js:355` `await assert.rejects( disabled.sendMessage(command(id, { expectedVersion: 2 })), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: disabled admission replays accepted send and blocks new send without mutation,  | `test/chat-media-bind-postgres-live.test.js:359` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:410` `assert.equal(first.statusCode, 202);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:412` `assert.equal(second.statusCode, 202);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:413` `assert.equal(second.json().id, first.json().id);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:414` `assert.notEqual(traces[0], traces[1]);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:415` `assert.equal( (await post('Synthetic', 'crm_session=seller', true)).statusCode, 202, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:419` `assert.equal((await post('Different')).statusCode, 409);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:420` `assert.equal( (await post('Synthetic', 'crm_session=other')).statusCode, 409, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:424` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: HTTP replay with fresh trace preserves semantic identity, changed caption or actor conflicts,  | `test/chat-media-bind-postgres-live.test.js:425` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: legacy fingerprint replays same original trace but cannot reconstruct a changed trace,  | `test/chat-media-bind-postgres-live.test.js:455` `assert.equal((await inbox.sendHumanMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: legacy fingerprint replays same original trace but cannot reconstruct a changed trace,  | `test/chat-media-bind-postgres-live.test.js:456` `await assert.rejects( inbox.sendHumanMessage({ ...input, correlationId: randomUUID() }), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T11/MED-06: legacy fingerprint replays same original trace but cannot reconstruct a changed trace,  | `test/chat-media-bind-postgres-live.test.js:460` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |

Gates: Full validate799 aprovados/3 skips antigos; SQL28/28 (21 novos+7 inbox), zero skips; E2E107/7 skips antigos114total; types/lint/format/diff/validators verdes. Autor não é Verifier; requisitos permanecem In Progress.


## Fix T10/MED-08: Permissão de uploader usa403

Revisão independente exigiu distinguir outro uploaded_by (403 de permissão)
de estado/conversa/versão (409 de conflito). Assertions de outro ator/admin
foram corrigidas explicitamente pelo integrador para403 antes do código; red
mostrou InboxConflictError409 onde403 era obrigatório. Negativa foi fortalecida
sem retirar cenário nem efeito esperado. Repository agora lança
InboxForbiddenError para mídia desta conversa pertencente a outro uploader.
Admin continua sem autorização de bind de arquivo alheio. Estado/conversa/
versão conservam409. Assertions `test/chat-media-bind-postgres-live.test.js:229`
rejects403 para actorId, :232 snapshot igual; :236 rejects403 admin e :244
automation assistant demonstram ausência de efeito. Live18/18, Quick types/lint/
format/diff verdes. Autor não é Verifier.

## T10: Vinculo atomico e conservacao de quota

MED-05..08/15/28: criterios e arquivos comunicados antes do patch. Novo teste SQL escrito primeiro reproduziu ready sem bind e negativas sem rejeicao. Fixtures iniciais corrigidas para respeitar auditoria imutavel (schema sintetico recriado por caso) e metadata ready size_bytes real; outcomes/assertions preservados. Bind valida mesmo autor/conversa/ready/clean/tipo/SHA/MIME/limite/reserva sob locks antes do takeover. Mensagem/vinculo/quota/outbox/audit/SSE/command usam a transacao existente; reserva vira used apenas nela. Replay hidrata antes do bind; concorrencia tem um vencedor, mesma midia nao liga a segunda mensagem. Admin read nao autoriza bind de outro ator. Allowlist coincide com T4, imagem5MiB e audio/video16MiB. Texto preservado.

### Adequação bidirecional

Cada cenário da spec está ligado às assertions discriminantes abaixo. A coluna
cenário faz a associação suficiente; a coluna fonte/assertion faz a associação
inversa de cada teste ao contrato, incluindo expansões por arrays parametrizados.
Nenhuma assertion/timeouts/skips publicada foi enfraquecida.

| Critério / requisito | file:line + assertion | Resultado |
| --- | --- | --- |
| T10: isolamento/fixture | `test/chat-media-bind-postgres-live.test.js:34` `assert.equal(new URL(connectionString).pathname, '/crm_silmer_test');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:176` `assert.equal((await snapshot()).automation, 'assistant');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:181` `assert.equal(row.state, 'attached');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:182` `assert.equal(row.message_id, message.id);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:183` `assert.equal(Number(row.reservation_bytes), 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:184` `assert.deepEqual(await snapshot(), { messages: 1, commands: 1, audits: 1, reserved: '0', used: '100', automation: 'human', });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:192` `assert.equal((await inbox.sendHumanMessage(input)).id, message.id);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:193` `assert.deepEqual(await snapshot(), { messages: 1, commands: 1, audits: 1, reserved: '0', used: '100', automation: 'human', });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: bind/message/outbox/audit/takeover and quota commit together; replay charges once,  | `test/chat-media-bind-postgres-live.test.js:201` `assert.equal( Number( (await pool.query(`SELECT count(*) AS count FROM crm.domain_events`)) .rows[0].count, ), 1, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:216` `assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:217` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: concurrent sends of one media have one winner,  | `test/chat-media-bind-postgres-live.test.js:218` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/08: invalid bind ${JSON.stringify(options)} rolls back,  | `test/chat-media-bind-postgres-live.test.js:229` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: options.actorId ? 403 : 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/08: invalid bind ${JSON.stringify(options)} rolls back,  | `test/chat-media-bind-postgres-live.test.js:232` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T10/MED-08: admin read capability cannot bind another actor media,  | `test/chat-media-bind-postgres-live.test.js:236` `await assert.rejects( service().sendHumanMessage( command(id, { actor: { ...actor, capabilities: ['COMMERCIAL_ADMIN'] }, }), ), { statusCode: 403 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-08: admin read capability cannot bind another actor media,  | `test/chat-media-bind-postgres-live.test.js:244` `assert.equal((await snapshot()).automation, 'assistant');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: second message cannot reuse attached media,  | `test/chat-media-bind-postgres-live.test.js:250` `await assert.rejects( inbox.sendHumanMessage(command(id, { expectedVersion: 2 })), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: second message cannot reuse attached media,  | `test/chat-media-bind-postgres-live.test.js:254` `assert.equal((await snapshot()).messages, 1);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:260` `await assert.rejects( service({ [failure]: true }).sendHumanMessage(command(id)), /synthetic-/u, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:264` `assert.deepEqual(await snapshot(), before);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05/28: ${failure} preserves ready reservation,  | `test/chat-media-bind-postgres-live.test.js:265` `assert.equal( (await pool.query('SELECT state FROM crm.chat_media WHERE id=$1', [id])) .rows[0].state, 'ready', );` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:282` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:285` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-07: ${scenario} after upload prevents stale send,  | `test/chat-media-bind-postgres-live.test.js:286` `assert.equal((await snapshot()).reserved, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: message kind and validated MIME must agree,  | `test/chat-media-bind-postgres-live.test.js:290` `await assert.rejects( service().sendHumanMessage( command(id, { messageType: 'audio', content: { mediaId: id } }), ), { statusCode: 409 }, );` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: message kind and validated MIME must agree,  | `test/chat-media-bind-postgres-live.test.js:296` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: ready ${kind} binds validated kind,  | `test/chat-media-bind-postgres-live.test.js:308` `assert.equal(sent.type, kind);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: ready ${kind} binds validated kind,  | `test/chat-media-bind-postgres-live.test.js:309` `assert.equal((await snapshot()).used, '100');` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: MIME ${mime} outside approved formats cannot bind,  | `test/chat-media-bind-postgres-live.test.js:318` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: MIME ${mime} outside approved formats cannot bind,  | `test/chat-media-bind-postgres-live.test.js:321` `assert.equal((await snapshot()).messages, 0);` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: image above five MiB cannot bind despite a ready row,  | `test/chat-media-bind-postgres-live.test.js:334` `await assert.rejects(service().sendHumanMessage(command(id)), { statusCode: 409, });` | Resultado explícito discriminante da assertion |
| test(T10/MED-05: image above five MiB cannot bind despite a ready row,  | `test/chat-media-bind-postgres-live.test.js:337` `assert.equal((await snapshot()).reserved, String(size));` | Resultado explícito discriminante da assertion |

Gates: Quick: types/lint/format/diff e npm test781 aprovados/3 skips antigos; Live25/25 (18 novos+7 regressao inbox), zero skips. Autor não é Verifier; requisitos permanecem In Progress.


## Fix T6/MED-19: Integridade da admissão até a variante

Achado independente: prepare substituía o SHA original persistido por T7,
permitindo um spool alterado válido de mesmo tamanho. Testes escritos primeiro
falharam: unit não registrou invalid_format e SQL retornou linha/hash substituído
onde o contrato exigia null. Worker agora compara originalSha256 da validação
com o original previamente admitido antes de prepare/PUT; divergência é rejected
invalid_format, sem PUT/ready. SQL prepare preserva original por COALESCE e CAS
exige original null ou idêntico e content_sha256 null. Variante preparada nunca
é substituída. Seeds legados com original null continuam preenchidos pela
validação. Nenhuma migration publicada alterada, nenhum teste enfraquecido.

| Critério / requisito ↔ assertion | Evidência necessária |
| --- | --- |
| Mesmo tamanho não autoriza troca, MED-19 | `test/chat-media-process-worker.test.js:307` `assert.equal(Buffer.byteLength('different'),BYTES.length)`; :310 failures invalid_format; :311 prepared0; :312 puts0; :313 ready0; :314 original SHA preservado |
| SQL/worker rejeita sem cobrança liberada | `test/chat-media-process-postgres-live.test.js:688` original SHA; :689 contentnull; :690 rejected; :691 invalid_format; :692 puts0; :693 reserved igual; :694 used0 |
| Hash original e variante imutáveis | `test/chat-media-process-postgres-live.test.js:707` prepare divergente null; :714 originalSHA; :715 contentnull; :717 originalSHA; :718 contentSHA; :719 segundo prepare divergente null; :726 contentSHA preservado |

Adequação inversa: assertions307–314 ligadas à divergência antes do efeito;
assertions680–694 ligadas à conservação SQL/quota; assertions707–726 ligadas
à CAS/hash e variante, incluindo preenchimento da linha legítima. Testes
anteriores de pipeline/retry/lease conservados. Gates: unit17/17, SQL15/15;
types/lint/diff verdes. Pipeline16/16 com scanner/normalizer da imagem construída
sha256:d372430897763a95b471898d349af004525ae234003fb350e7f5538fbaaf1655 e
RustFS local alpha.99, 58.9s, zero skips. Handler/SQL/SDK no host e ferramentas
da imagem por helper; não prova worker process completo nem n8n, que seguem T24.
Autor não é Verifier.

## T9: Conteúdo privado com Range e recuperação

Critérios e arquivos comunicados antes do patch: content route/runtime, app/server,
repository CAS de lost, testes API/SQL, OpenAPI e runbook. Testes escritos primeiro:
primeira execução falhou ERR_MODULE_NOT_FOUND no endpoint ausente. Depois passaram
18 casos de API (cinco Ranges válidos, cinco inválidos, retenção e ACL, recuperação,
metadata divergente, 16 MiB em chunks e rollback de admissão), mais SQL CAS real.
HEAD/GET verificam variante SHA/MIME/tamanho antes de bytes; contador do stream
impede resposta maior/truncada. Timeout503 nunca substitui durable ready/attached.
MissingObject marca lost410 por CAS version/key/hash, sem tocar quota. Leitura
usa private,no-store/nosniff. CHAT_MEDIA_READ_ENABLED preserva histórico ao
desligar CHAT_MEDIA_ENABLED. Nenhum vínculo ou objeto é removido pelo rollback.

### Adequação suficiente e inversa

Cada assertion abaixo liga a exigência ao resultado, e cada cenário de T9 tem
assertions listadas. Arrays de Range expandem para cinco casos positivos e cinco
negativos; assertions dentro deles valem para todas as entradas documentadas.

| Critério / requisito | file:line + assertion | Resultado necessário |
| --- | --- | --- |
| test(MED-15/17: full retained attached bytes remain readable with private headers,  | `test/chat-media-content-routes.test.js:111` `assert.equal(response.statusCode, 200);` | Valor esperado explícito na assertion |
| test(MED-15/17: full retained attached bytes remain readable with private headers,  | `test/chat-media-content-routes.test.js:112` `assert.equal(response.body, 'abcdefghij');` | Valor esperado explícito na assertion |
| test(MED-15/17: full retained attached bytes remain readable with private headers,  | `test/chat-media-content-routes.test.js:113` `assert.equal(response.headers['cache-control'], 'private, no-store');` | Valor esperado explícito na assertion |
| test(MED-15/17: full retained attached bytes remain readable with private headers,  | `test/chat-media-content-routes.test.js:114` `assert.equal(response.headers['x-content-type-options'], 'nosniff');` | Valor esperado explícito na assertion |
| test(MED-15/17: full retained attached bytes remain readable with private headers,  | `test/chat-media-content-routes.test.js:115` `assert.equal(response.headers['accept-ranges'], 'bytes');` | Valor esperado explícito na assertion |
| test(MED-15/17: full retained attached bytes remain readable with private headers,  | `test/chat-media-content-routes.test.js:116` `assert.equal(response.headers['content-length'], '10');` | Valor esperado explícito na assertion |
| test(MED-17: range ${range} returns exact 206,  | `test/chat-media-content-routes.test.js:127` `assert.equal(response.statusCode, 206);` | Valor esperado explícito na assertion |
| test(MED-17: range ${range} returns exact 206,  | `test/chat-media-content-routes.test.js:128` `assert.equal(response.body, expected);` | Valor esperado explícito na assertion |
| test(MED-17: range ${range} returns exact 206,  | `test/chat-media-content-routes.test.js:129` `assert.equal(response.headers['content-range'], contentRange);` | Valor esperado explícito na assertion |
| test(MED-17: range ${range} returns exact 206,  | `test/chat-media-content-routes.test.js:130` `assert.equal(Number(response.headers['content-length']), expected.length);` | Valor esperado explícito na assertion |
| test(MED-17: invalid range ${range} returns 416 without bytes,  | `test/chat-media-content-routes.test.js:141` `assert.equal(response.statusCode, 416);` | Valor esperado explícito na assertion |
| test(MED-17: invalid range ${range} returns 416 without bytes,  | `test/chat-media-content-routes.test.js:142` `assert.equal(response.headers['content-range'], 'bytes */10');` | Valor esperado explícito na assertion |
| test(MED-17: invalid range ${range} returns 416 without bytes,  | `test/chat-media-content-routes.test.js:143` `assert.equal(response.headers['cache-control'], 'private, no-store');` | Valor esperado explícito na assertion |
| test(MED-17: invalid range ${range} returns 416 without bytes,  | `test/chat-media-content-routes.test.js:144` `assert.equal(response.body.includes('abcdefghij'), false);` | Valor esperado explícito na assertion |
| test(MED-16: missing session and forbidden actor cannot read bytes,  | `test/chat-media-content-routes.test.js:147` `assert.equal((await harness(t).get({ cookie: '' })).statusCode, 401);` | Valor esperado explícito na assertion |
| test(MED-16: missing session and forbidden actor cannot read bytes,  | `test/chat-media-content-routes.test.js:148` `assert.equal( (await harness(t).get({ cookie: '' })).headers['cache-control'], 'private, no-store', );` | Valor esperado explícito na assertion |
| test(MED-16: missing session and forbidden actor cannot read bytes,  | `test/chat-media-content-routes.test.js:152` `assert.equal((await harness(t, { forbidden: true }).get()).statusCode, 403);` | Valor esperado explícito na assertion |
| test(MED-19: transient storage failure recovers without durable state replacement,  | `test/chat-media-content-routes.test.js:156` `assert.equal((await h.get()).statusCode, 503);` | Valor esperado explícito na assertion |
| test(MED-19: transient storage failure recovers without durable state replacement,  | `test/chat-media-content-routes.test.js:157` `assert.equal(h.row.state, 'attached');` | Valor esperado explícito na assertion |
| test(MED-19: transient storage failure recovers without durable state replacement,  | `test/chat-media-content-routes.test.js:158` `assert.equal((await h.get()).statusCode, 200);` | Valor esperado explícito na assertion |
| test(MED-19: confirmed missing object returns 410 and marks lost,  | `test/chat-media-content-routes.test.js:163` `assert.equal(response.statusCode, 410);` | Valor esperado explícito na assertion |
| test(MED-19: confirmed missing object returns 410 and marks lost,  | `test/chat-media-content-routes.test.js:164` `assert.equal(response.headers['cache-control'], 'private, no-store');` | Valor esperado explícito na assertion |
| test(MED-19: confirmed missing object returns 410 and marks lost,  | `test/chat-media-content-routes.test.js:165` `assert.equal(h.row.state, 'lost');` | Valor esperado explícito na assertion |
| test(MED-19: confirmed missing object returns 410 and marks lost,  | `test/chat-media-content-routes.test.js:166` `assert.equal(response.body.includes('secret-key'), false);` | Valor esperado explícito na assertion |
| test(MED-17/19: storage metadata mismatch and ignored Range fail before bytes,  | `test/chat-media-content-routes.test.js:169` `assert.equal((await harness(t, { badMime: true }).get()).statusCode, 503);` | Valor esperado explícito na assertion |
| test(MED-17/19: storage metadata mismatch and ignored Range fail before bytes,  | `test/chat-media-content-routes.test.js:170` `assert.equal( (await harness(t, { ignoredRange: true }).get({ range: 'bytes=1-2' })) .statusCode, 503, );` | Valor esperado explícito na assertion |
| test(MED-17: large object streams in bounded chunks,  | `test/chat-media-content-routes.test.js:178` `assert.equal(response.statusCode, 200);` | Valor esperado explícito na assertion |
| test(MED-17: large object streams in bounded chunks,  | `test/chat-media-content-routes.test.js:179` `assert.equal(response.rawPayload.length, 16 * 1024 * 1024);` | Valor esperado explícito na assertion |
| test(MED-17: large object streams in bounded chunks,  | `test/chat-media-content-routes.test.js:180` `assert.equal(response.rawPayload[response.rawPayload.length - 1], 7);` | Valor esperado explícito na assertion |
| test(MED-15: unvalidated content is blocked before storage read,  | `test/chat-media-content-routes.test.js:183` `assert.equal( ( await harness(t, { row: { state: 'rejected', validation_status: 'invalid_format' }, }).get() ).statusCode, 409, );` | Valor esperado explícito na assertion |
| test(MED-15/16: disabling admission preserves history routes,  | `test/chat-media-content-routes.test.js:216` `assert.equal( ( await api.inject({ method: 'POST', url: '/api/v1/conversations/c/media', headers, }) ).statusCode, 404, );` | Valor esperado explícito na assertion |
| test(MED-15/16: disabling admission preserves history routes,  | `test/chat-media-content-routes.test.js:226` `assert.equal( ( await api.inject({ method: 'GET', url: `/api/v1/conversations/c/media/${id}`, headers, }) ).statusCode, 200, );` | Valor esperado explícito na assertion |
| test(MED-15/16: disabling admission preserves history routes,  | `test/chat-media-content-routes.test.js:236` `assert.equal( ( await api.inject({ method: 'GET', url: `/api/v1/conversations/c/media/${id}/content`, headers, }) ).body, 'retained', );` | Valor esperado explícito na assertion |
| MED-19 / CAS e quota | `test/chat-media-upload-postgres-live.test.js:659` `assert.equal( await repository.markLost({ ...row, version: Number(row.version) + 1 }), false, );` | Versão stale não altera; lost preserva reserva |
| MED-19 / CAS e quota | `test/chat-media-upload-postgres-live.test.js:663` `assert.equal(await repository.markLost(row), true);` | Versão stale não altera; lost preserva reserva |
| MED-19 / CAS e quota | `test/chat-media-upload-postgres-live.test.js:664` `assert.equal(await repository.markLost(row), false);` | Versão stale não altera; lost preserva reserva |
| MED-19 / CAS e quota | `test/chat-media-upload-postgres-live.test.js:665` `assert.deepEqual(await counts(), quota);` | Versão stale não altera; lost preserva reserva |
| MED-19 / CAS e quota | `test/chat-media-upload-postgres-live.test.js:666` `assert.equal( ( await repository.readForActor({ mediaId: admission.id, conversationId: admission.conversationId, actor: admission.actor, }) ).state, 'lost', );` | Versão stale não altera; lost preserva reserva |
| MED-19 / CAS e quota | `test/chat-media-upload-postgres-live.test.js:676` `await assert.rejects( repository.readForActor({ mediaId: admission.id, conversationId: 'different', actor: admission.actor, }), { statusCode: 404 }, );` | Versão stale não altera; lost preserva reserva |

Gates: validate 779 aprovados / 3 skips antigos; SQL 15/15; E2E 107/7 skips antigos,114 total; diff/skill validators verdes. Autor não é Verifier; requisitos permanecem In Progress.


## T8: Status autorizado e erros de sessão

Premissas e arquivos comunicados ao integrador antes do patch. Fonte de ACL:
conversation.read canônica, sessão de Vendedor; draft restrito a autor/admin,
attached segue leitura já autorizada. Arquivos: status route/runtime, app/server,
repository readForActor, identity/operation runtime e código tipado INVALID_SESSION
no serviço existente, testes status/produção SQL, OpenAPI, estado/traceabilidade.
Erros401 são opt-in somente para mídia: outros leitores mantêm403 anterior.
DB não vira credencial inválida. Upload faz preflight autenticado antes do CSRF.
Roots equivalentes são normalizados e não podem coincidir com PRIVATE_MEDIA_ROOT.

18 unit/integration novos e um cenário SQL composto, incluindo sessão real,
Vendedor200, não Vendedor403, outro draft403, admin draft200, attached outro200,
ausente/inválida/revogada/expirada401, origem403, CSRF403, DB503 em GET/POST.
Nenhuma assertion publicada alterada; helpers de auth T7 ganharam authorizeRead
sem alterar resultados. Novo fixture de ação encaminhada corrigido de inbox.read
para conversation.read após falhar antes da autenticação; códigos esperados
401/403/503 preservados. Primeira expiração artificial falhou CHECK sessions;
fixture passou a manter created_at anterior à expiração, sem mudar assertion.

### Adequação suficiente

| Critério / AC | file:line + assertion | Resultado esperado | Coberto |
| --- | --- | --- | --- |
| Draft autor/admin, outro403 | `test/chat-media-status-runtime.test.js:48`: `assert.deepEqual(await harness()(),{mediaId:id,kind:'image',origin:'attachment',state:'ready',validationStatus:'clean',mimeType:'image/png',sizeBytes:100,durationMs:null})`; :61 `await assert.rejects(get({id:'other',capabilities:[]}),{statusCode:403})` | Metadata safe; somente autor/admin | Sim |
| Attached ACL | `test/chat-media-status-runtime.test.js:76`: `assert.equal(dto.state,state)`; :78 `assert.equal(JSON.stringify(dto).includes('secret-key'),false)` | Outro leitor autorizado acessa attached/lost metadata | Sim |
| MED29 formato reprovado | `test/chat-media-status-routes.test.js:79`: `assert.equal(response.statusCode,200)`; :80 `assert.equal(response.json().state,'rejected')`; :81 `assert.equal(response.json().reason,'invalid_format')` | Rejeição assíncrona200 com reason exato | Sim |
| DTO sem keys/filename/URL | `test/chat-media-status-runtime.test.js:48`: `assert.deepEqual(await harness()(),...)`; :92 `assert.equal(JSON.stringify(dto).includes('secret-filename'),false)` | Allowlist exata, nenhuma referência de storage | Sim |
| Estados e cache privado | `test/chat-media-status-routes.test.js:66`: `assert.equal(response.statusCode,200)`; :67 `assert.equal(response.json().state,state)`; :71 `assert.equal(response.headers['cache-control'],'private, no-store')` | uploaded/processing/ready/attached/unavailable/lost200 | Sim |
| Identidade production real | `test/chat-media-upload-postgres-live.test.js:508`: `assert.equal((await get()).statusCode,200)`; :546 `assert.equal((await get('crm_session=bogus')).statusCode,401)`; :555 e :560 `assert.equal((await get()).statusCode,401)` | Sessão real validada; inválida/revogada/expirada401 | Sim |
| Origem/capacidade/ownership/admin/attached | `test/chat-media-upload-postgres-live.test.js:513`: `assert.equal((await get('crm_session=other-synthetic-session')).statusCode,403)`; :520403; :527200 admin; :542200 attached | Bloqueios403, autorizações200 | Sim |
| CSRF e preflight upload | `test/chat-media-upload-postgres-live.test.js:584`: `assert.equal((await post('bogus')).statusCode,401)`; :585 `assert.equal((await post(undefined,'wrong')).statusCode,403)`; :586 `assert.equal((await post()).statusCode,202)` | Credencial distinta de CSRF, sem bypass | Sim |
| DB failure propagada, legado compatível | `test/chat-media-status-runtime.test.js:142`: `await assert.rejects(identity.authorizeOperationalRead({action:'conversation.read',sessionToken:'invalid'}),{statusCode:403})`; :170 `await assert.rejects(unavailable.authorizeOperationalRead(...),error=>error===failure)` | Default403 preservado; DB não mascarado | Sim |
| Spool distinto do legado | `test/chat-media-status-runtime.test.js:95`: `assert.throws(()=>requireMediaSpoolRoot({CHAT_MEDIA_SPOOL_ROOT:'var/private/../private',PRIVATE_MEDIA_ROOT:'var/private'}),/distinct CHAT_MEDIA_SPOOL_ROOT/u)` | resolve/case Windows fecham bypass de configuração | Sim |

Adequação: valores/códigos exatos e payload completo assertados. Testes sem
call-count como evidência; convenções CONTRIBUTING.md/node:test/checkJs.
Gates T8 concluídos: validate761 aprovados/3 skips antigos,764 total;
SQL conjunto25/25, teste composto final14/14 (13T7+1T8) com DB real, zero skips;
E2E exclusivo107 aprovados/7 skips antigos,114 total; types/lint/diff verdes.
DB503 foi comprovado também no POST com preflight, além do GET, em
`test/chat-media-upload-postgres-live.test.js:626`: `assert.equal((await failedApi.inject({...method:'POST'...})).statusCode,503)`.
Status T8 concluída; requisito MED16 permanece In Progress até T9/T13/Verifier.

## T7: Upload humano com admissão durável

Concluída com gates verdes. Premissas/arquivos/sucesso enviados ao integrador
antes do patch. Migration 0029 adiciona ledger de admissão sem reescrever
migrations publicadas; nenhum lock/transação SQL fica aberto durante bytes.
Arquivos: upload route/runtime/wiring app/server, repository/export, migration,
testes HTTP/SQL, OpenAPI, design, runbook, spec/tasks/STATE e esta evidência.
T8 continua responsável pelo status do processamento assíncrono.

Testes vieram de MED-04/06/07/08/20/26/28/29 e Done when T7 antes do código.
20 cenários HTTP e 13 SQL novos, sem alterar/remover/ignorar testes existentes.
Gates: validate 743 aprovados, três skips antigos, 746 total; SQL conjunto
24/24 sem skips; E2E exclusivo um worker 107 aprovados, sete skips antigos,
114 total; audit zero; git diff --check, validate_tasks/spec e types/lint verdes.
Node 24.20.0/npm 11.19.0 portátil, PostgreSQL sintético local dedicado.

Reserva antecede bytes: imagem/anexo 2×limite; gravação 3×16 MiB. Tamanho/hash
real ajusta reserva para 2×entrada ou entrada+32 MiB. Filename usa AES-GCM
com AAD UUID, verificado por decrypt autenticado. Empty 422 não cria metadados
fictícios. Campo/file/truncamento inválidos não enfileiram job. MIME/codec
invalidáveis depois do POST permanecem processamento após 202 (MED-29/T8).

Replay completo consome/hash bounded sem spool/reserva; também conta no limite
12/minuto por hash de crm_session canônico. Admissão receiving no mesmo scope
usa 409. Quota soma used+reserved. Transferência/close são revalidados antes
da conversão atômica ledger→mídia/job. Commit incerto consulta estado sob lock;
consumed ou consulta indisponível preservam spool. Remoção falha preserva
reserva. Discovery receiving >24h é contrato para T22, sem sweeper agora.

Correções durante implementação: handler multipart aguardava pipeline de um
source já destruído pelo parser; writer agora é fechado antes do cleanup.
QA encontrou bypass por cookies extras, commit perdido apagando spool e
replay sem throttle. Os três foram corrigidos e têm provas SQL/HTTP próprias.
Primeiro comando de teste expandiu PATH no shell externo; substituído por
Command com quoting simples antes dos gates. Fixtures SQL de hash de senha
e fechamento foram corrigidas antes de rodar; nenhuma assertion enfraquecida.

### Adequação suficiente

| Critério / AC | file:line + assertion | Resultado da spec | Coberto |
| --- | --- | --- | --- |
| 202 com ID opaco/state | `test/chat-media-upload-routes.test.js:120`: `assert.equal(response.statusCode, 202)`; :116 `assert.equal(response.json().state, 'processing')` | Upload aceito e ainda não enviado | Sim |
| Metadata byte-real/quota | `test/chat-media-upload-routes.test.js:124`: `assert.equal(saved.sizeBytes, 15)`; :121 `assert.equal(saved.reservationBytes, 30)` | Reserva 2×entrada medida | Sim |
| Reserva antes do job | `test/chat-media-upload-postgres-live.test.js:110`: `assert.deepEqual(await counts(), {media:0,jobs:0,reserved:String(row.reservationBytes)})` | Pior caso cobrado, zero mídia/job | Sim |
| Upload sem takeover | `test/chat-media-upload-postgres-live.test.js:120`: `assert.equal((await pool.query('SELECT automation_state,automation_epoch,version FROM crm.conversations')).rows[0].automation_state,'assistant')` | Upload não assume conversa | Sim |
| Replay exato / payload diverso | `test/chat-media-upload-routes.test.js:157`: `assert.deepEqual(replay.json(), first.json())`; :161 `assert.equal(response.statusCode, 409)` | Mesmo resultado, outro arquivo 409 | Sim |
| Auth/ACL/CSRF/status negativos | `test/chat-media-upload-routes.test.js:175`: `assert.equal(response.statusCode,statusCode)` para 403/409/429/503; :193 `assert.equal(response.statusCode,401)`; :200 `assert.equal(response.statusCode,403)` | Todas negativas imediatas do contrato | Sim |
| Excesso/truncamento/Content-Length | `test/chat-media-upload-routes.test.js:214`: `assert.equal(response.statusCode,413)`; :217 `assert.equal(response.statusCode,422)`; :220 `assert.deepEqual(await readdir(h.root),[])` | Limite real, nenhum job/parcial solto | Sim |
| Zero-byte / reprovação futura | `test/chat-media-upload-routes.test.js:243`: `assert.equal(response.statusCode,422)`; :246 `assert.equal(response.statusCode,202)` para SVG | Zero inválido antes do 202; tipo real assíncrono | Sim |
| Gravação/limite 16 MiB/cleanup falho | `test/chat-media-upload-routes.test.js:264`: `assert.equal([...h.records.values()][0].reservationBytes,15+32*1024*1024)`; :269 `assert.equal(response.statusCode,413)`; :283 `assert.equal(h.reservations.size,1)` | Reserva da conversão, limite e liberação só após cleanup | Sim |
| Concorrência / used+reserved | `test/chat-media-upload-postgres-live.test.js:183`: `assert.equal(results.filter(r=>r.status==='fulfilled').length,1)`; :214 `await assert.rejects(repository.admit(input()),{statusCode:429})` | Um vencedor; quota conservada | Sim |
| Replay throttle/cookies extras | `test/chat-media-upload-postgres-live.test.js:203`: `await assert.rejects(repository.admit({...row,id:randomUUID()}),{statusCode:429})`; :299 `assert.equal(response.statusCode,n<12?422:429)` | 13º request não passa usando mesmo token | Sim |
| Transfer/close e rollback job | `test/chat-media-upload-postgres-live.test.js:235`: `await assert.rejects(repository.complete(completed(row)),{statusCode:mutate.startsWith('assigned')?403:409})`; :325 `assert.deepEqual(await counts(),{media:0,jobs:0,reserved:String(row.reservationBytes)})` | Nunca publicar envio indevido ou meia transação | Sim |
| Commit perdido / DB indisponível | `test/chat-media-upload-postgres-live.test.js:404`: `assert.equal((await api.inject(request)).statusCode,503)`; :402 `assert.deepEqual(await counts(),{media:1,jobs:1,reserved:'30'})`; :410 `assert.equal(replay.json().mediaId,media.id)` | Spool preservado e replay único, sem falso sucesso | Sim |
| Discovery orphan e liberação uma vez | `test/chat-media-upload-postgres-live.test.js:439`: `assert.deepEqual(await repository.listAbandonedAdmissions(),[])`; :430 `assert.deepEqual(await counts(),{media:0,jobs:0,reserved:'0'})` | Não liberar sem confirmação nem cobrar duplamente | Sim |
| Erro previsível e privacidade | `test/chat-media-upload-routes.test.js:176`: `assert.equal(response.json().accepted,false)`; :182 `assert.equal(response.headers['content-type'],'application/problem+json; charset=utf-8')`; :145 `assert.equal(response.body.includes('private-canary'),false)` | Campos de erro estáveis, sem filename/plaintext | Sim |

Adequação: cada critério tem estado/valor assertado; assertions não se limitam
a call counts. Filename também autenticado por AES-GCM (:131). Convenções
CONTRIBUTING.md/node:test/checkJs seguidas. Requisitos seguem In Progress;
nenhum Verified ou validation.md final produzido.

## T6: Worker de processamento persistente

Premissas, arquivos e sucesso enviados ao integrador antes do patch: preservar
fila existente e efeitos Meta, nova migration 0028 sem reescrever 0027,
CAS/attempt vigente, persistir variante antes do PUT e confirmar cleanup antes
de ready. Arquivos: handler, repository, job queue, exports, worker, updater,
allowlists de observabilidade, migration, testes unit/live e documentação.
Nenhuma dependência nova. O fixture T2 passou a usar queue canônica chat_media,
sem mudar suas oito assertions/cenários. Requisitos MED-14/19/26/28/29 seguem
In Progress até verificação independente e integração das próximas fases.

Quick/Topology/Build: validate PASS, 722 aprovados, três skips antigos,
725 total, Node 24.20.0/npm 11.19.0. Novos unitários: 16 handler e quatro
composição/lifecycle. Suite SQL conjunta: 23/23 PASS (13 T6, oito schema T2,
dois queue legados), zero skips. Ciclo combinado final: 14/14 PASS, 54,16 s,
incluindo os 13 SQL e PNG + gravação WebM Chromium reais contra RustFS alpha.99,
SDK e banco dedicados. Hash original/final, tamanho, MIME, ready, quota e
spool vazio confirmados. Objetos sintéticos removidos pelo teste.

Imagem final construída com T6:
`sha256:d372430897763a95b471898d349af004525ae234003fb350e7f5538fbaaf1655`,
400961795 bytes. Container isolado com USER node/UID 1000, read-only,
2 GiB/1 CPU e tmpfs privado. Scanner e normalizador reais vieram dos módulos
`/app/modules` dessa imagem; handler/repository/SDK rodaram no host contra
DB e RustFS locais. A imagem T5 7105b14c contém somente T5 e anteriores.
Não alegamos worker completo remoto ou ativação operacional, pendentes T23/T24.

Falhas de desenvolvimento: FK do attempt inicialmente UUID contra coluna
TEXT existente; corrigida para TEXT antes da entrega. Harness de recovery
descartava um claim recém-criado, corrigido preservando o claim. Primeiro
replay na imagem usou helper relativo ao WORKDIR /app, corrigido para caminho
absoluto /workspace. Todos os cenários reexecutados; nenhum teste enfraquecido.
QA encontrou ACK terminal antes da persistência da rejeição; corrigido com
retrySafe em DB throw/CAS false e convergência comprovada no mesmo registro.

Contratos: queue chat_media/job chat_media.process/effect internal; claim
carrega chatMediaId. Heartbeat de 5 s acompanha scanner/encoder. PUT é efeito
interno imutável e reconciliável, sem marcar efeito Meta. prepare persiste
SHA/tamanho/MIME antes de PUT; HEAD divergente não sobrescreve. Cleanup
confirmado precede transação ready; reserva cobre spool/intermediários/objeto
e só reduz ao tamanho final após cleanup, used muda somente em T10. Falha de
cleanup ou rollback conserva reserva; replay após cleanup e DB crash usa
HEAD no mesmo registro, sem segunda conversão/PUT. Rejeitados conservam
reserva até cleanup T22. Freshclam inicia em background; stop/concurrent
start não recriam timer depois de shutdown. Mídia continua fail-closed.

### Adequação: suficiência e discriminação

Aliases: unit = test/chat-media-process-worker.test.js;
sql = test/chat-media-process-postgres-live.test.js;
composition = test/chat-media-worker-composition.test.js.
Referências abaixo são linhas concretas das assertions.

| Critério                        | Assertion concreta                          | Esperado                                          |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Replay e variante única         | unit:173/174/184/185; sql:303               | Um PUT e um prepare/ready                         |
| Variante preparada antes do PUT | unit:107/110                                | SHA presente, bytes exatos                        |
| Quota ready                     | sql:300/301/302/304                         | Reserva final, used zero, spool vazio             |
| Rollback após PUT e cleanup     | sql:326/330/331/332/337/338/339/340/341/342 | Mesmo registro, HEAD, sem novo PUT/scan           |
| Cleanup falho                   | sql:362/363/367/381/382/383/384             | Reserva integral até remover spool                |
| HEAD divergente                 | sql:398/399/400                             | Não sobrescrever nem liberar reserva              |
| Scanner e formato negados       | unit:210/211/212; sql:414/415/416           | Sem PUT/ready, rejeição persistida                |
| Rejeição com DB/CAS falho       | sql:462/463/477/482/490/491                 | Retry no mesmo registro antes de ACK              |
| Fencing e concorrência          | sql:281/291/510/512/513/515                 | Um owner, stale attempt não publica               |
| Lease durante subprocesso       | unit:244/245/246/254/255                    | Sem efeito perdido, heartbeat repetido            |
| Queue e integração              | sql:252/253/254; composition:22/23          | ID e handler na fila canônica                     |
| Texto e lifecycle               | composition:66/67/90/91                     | CDN pendente não bloqueia texto/timer             |
| Privacidade observável          | composition:38/39/40/41                     | Dimensões técnicas, sem canários privados         |
| Ciclo real na imagem            | sql:647/653/654/659/660/664                 | Ready, hash/tamanho/MIME, used zero e spool vazio |

Near misses discriminados: ready sem cleanup falha sql:304; liberar reserva
no rollback falha sql:326/340/341; confiar só no HEAD sem comparar SHA/MIME/size
falha sql:398/399; reprocessar gravação após PUT incerto falha unit:195;
ACK antes de persistir rejected falha sql:462/463/477/482; marcar efeito Meta
falha unit:154 e sql:311; aguardar CDN antes de texto falha composition:66;
timer recriado após stop falha composition:91. Veredito: suficiente e
discriminante para a fronteira T6, condicionado aos gates finais registrados
no fechamento desta seção. Verifier independente da feature ainda obrigatório.

Fechamento T6: E2E exclusivo com um worker PASS, 107 aprovados e sete skips
antigos, 114 cenários preservados (1,1 min). npm audit: zero vulnerabilidades.
git diff --check: PASS. Quick/Topology/Live/Build e adequação: PASS. Fase 1
concluída; próxima tarefa T7 pelo integrador, sem implementação antecipada.

## T5: Normalização de gravações e assinaturas

Premissas, arquivos e sucesso foram enviados ao integrador antes do patch:
entrada validada em T4, OGG/Opus mono a 48 kHz e saída escaneada, temporário
privado e publicação exclusiva. Arquivos: módulo, testes, export, Docker,
atualizador de assinaturas, composição do worker, runbook, spec e tasks.
Sem nova dependência JavaScript ou serviço. FFmpeg/ffprobe, freshclam e CA
suportam gravações e verificação genuína; os copyrights dos pacotes Debian
permanecem na imagem. O digest da base Node foi preservado.

Gates Quick, Topology e Build: PASS, 701 aprovados, três skips antigos, 704 total.
10 unitários do normalizador, quatro do atualizador e um de header enganoso;
tipos e lint verdes. Runtime explícito: um teste aprovado em 103,23 s.
WebM do Chromium, OGG/Opus e MP4/AAC viram OGG/Opus mono confirmado por
channels=1; OGG de 300 s retorna durationMs=300000, WebM de 301 s é rejeitado
sem saída. Sem skips ou assinaturas falsas. CPU: 87,93 s user e 15,03 s system;
RSS máximo: 989248 KiB, zero swaps. Medição por GNU time inclui subprocessos;
fixture sintética não substitui o teste de carga em T23.

Imagem runtime construída e executada localmente:
digest `sha256:7105b14c4563b8daeeed2b1eee1aa20f3bf873e0b965cfb13a7fe67c140fb8fd`,
400957267 bytes. USER node, UID 1000; assinatura-base daily 28144, main 63 e
bytecode 339 baixada e testada oficialmente durante o build. Verificação
executável na própria imagem confirmou baseline, freshclam genuíno e marcador
publicado. Runtime remoto, limites, mount de definições e backup continuam
como gates em T23.

O timeout de 120 s é do encoder; por arquivo, scan 60 s, libmagic 10 s,
probe 10 s e decodificação 30 s: limite somado de 340 s nas fases locais,
além de IO, DB e PUT. Escolha explícita no design e runbook; o handler em T6
renova lease. Recomenda-se limite de 2 GiB por worker, pela medição próxima
de 1 GiB, com conversão e scan sequenciais. Freshclam tem timeout de 180 s
no startup e a cada 24 h, com falha técnica observável. Marcador só depois
de freshclam com exit 0, por arquivo temporário e rename atômico; falha
preserva conteúdo e mtime anteriores. Base instalada é exigida; marcador
inválido, futuro ou stale impede liberação. O scanner legado da API deverá
compartilhar definições privadas com o worker em T23.

### Adequação: suficiência

Nesta seção, unit = test/recorded-audio-normalizer.test.js,
runtime = test/recorded-audio-normalizer-runtime.test.js,
refresh = test/clamav-signature-refresh.test.js e
validator = test/chat-media-validation.test.js. Números indicam linhas das
assertions atuais; valores de timeout estão em milissegundos.

| Critério                          | Assertion concreta                                                                                                   | Esperado                                | Coberto |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------- |
| Conversão MED-14                  | unit:72 channels=1, :73 codec=opus, :75 scans=2; runtime:51/52/53                                                    | Mono, OGG/Opus, scan de entrada e saída | Sim     |
| Bytes e vazio MED-04              | unit:89 rejects entrada vazia ou 16 MiB + 1; :97 diretório somente com entrada                                       | Entrada inválida não converte           | Sim     |
| Duração MED-12                    | unit:116 razão invalid_format em 300001 ms; runtime:93 durationMs=300000; :126 rejects 301 s; :134 ausência de saída | Teto útil inclusivo de 300 s            | Sim     |
| Header enganoso                   | validator:210 rejects header 1 s e timeline 301 s                                                                    | Não confiar no header                   | Sim     |
| Timeout e recursos                | unit:44 timeout=120000, :45 buffer=65536, :47 cap=301, :48 protocol=file; :116 processing_failed                     | Subprocesso limitado e erro sanitizado  | Sim     |
| Saída infectada ou estéreo MED-26 | unit:116 infected e não mono rejeitados; :127 cleanup                                                                | Saída falha fechado                     | Sim     |
| Cleanup                           | unit:76 diretório com entrada e saída; :127 somente entrada                                                          | Sem intermediário órfão                 | Sim     |
| Variante imutável                 | unit:137 EEXIST; :145 bytes originais preservados                                                                    | Não substituir saída existente          | Sim     |
| Refresh e cadência                | refresh:27 intervalo de 24 h, :29 uma chamada no startup, :31 timeout=180000, :32 buffer, :33 timestamp válido       | Refresh limitado                        | Sim     |
| Marcador após falha               | refresh:112 conteúdo anterior, :113 mtime anterior; :77 inválido/futuro/stale rejeitados                             | Falha não forja freshness               | Sim     |
| Concorrência                      | refresh:132 calls=1                                                                                                  | Um updater em curso                     | Sim     |

### Adequação: discriminação

| Near miss                                  | Assertion que falha            | Distinção                         |
| ------------------------------------------ | ------------------------------ | --------------------------------- |
| Encoder com -ac 1 sem provar mono          | runtime:51/98                  | Saída estéreo não passa           |
| Scan somente da entrada                    | unit:75/116                    | Saída deve ser escaneada          |
| Aceitar header curto ou truncar 301 s      | validator:210; runtime:126/134 | Timeline útil excedente rejeitada |
| Usar metadata OGG com padding para o teto  | runtime:93                     | 300 s úteis aceitos               |
| Deixar temporário após erro                | unit:127                       | Cleanup obrigatório               |
| Sobrescrever variante                      | unit:137/145                   | Publicação exclusiva              |
| Atualizar marcador quando freshclam falha  | refresh:112/113                | Conteúdo e mtime preservados      |
| Aceitar marcador inválido, futuro ou stale | refresh:77                     | Falha fechado                     |

Veredito: suficiente e discriminante; Quick, Topology, Build e runtime PASS.
Requisitos ainda dependentes de API, UI ou worker permanecem In Progress.

## T4: Validação de mídia

Premissas antes do patch: somente allowlist aprovada, scanner existente e
ffprobe no backend; declarado não substitui MIME real. Arquivos: módulo
`chat-media-validation.js`, export, dois testes e spec/tasks/execution.
Gerador sintético Chromium versionado adicionado após finding deQA, para
preservar reprodução de gravações streaming sem duration.
Sucesso: pelo menos12 cenários, fixtures reais para seis formatos, MIME/codec,
malware/stale e fronteiras de tamanho/legenda; Quick, runtime real e Build.

Quick/Build final:685 pass, três skips preexistentes,688 total, Node24.20.0;
types/lint verdes.16 testes unitários específicos. E2E não repetido nesta
tarefa sem mudançaUI; baseline integral107+7skips de T2 permanece histórico,
novo gate integral ao concluir a fase. Requisitos seguem In Progress.

Runtime isolado usa Node24.20.0 bookworm, FFmpeg5.1.9, ClamAV1.4.3 e libmagic.
Freshclam oficial atualizou daily28144/main63/bytecode339, verificou cada
database e terminou0. Primeiro download falhou por faltaCA; instalação
explícita de ca-certificates resolveu, requisito da imagem emT5. Nenhuma
assinatura sintética/fake usada. Aviso NotifyClamd semdaemon não impediu
update; T5 desabilitará essa opção. Runtime remoto permanece gateT23.

O scanner rejeita infecção, indisponibilidade e assinatura>36h. ffprobe
tem timeout10s/maxBuffer64KiB/probesize8MiB/maxalloc64MiB/protocolfile e MOV
sem refs externas. MP3 admite uma capa JPEG/PNG apenas com attached_pic=1.
Gravação streaming sem duration é decodificada por FFmpeg com threads1,
timeout30s, teto301s e progresso limitado; timeline>300s é rejeitada.
Não se aceita duration ausente por suposição. Erros são sanitizados.

### Adequação: suficiência

| Critério           | Evidência assertion                                                                                                           | Esperado                        | Coberto |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------- |
| MED01..03 formatos | `test/chat-media-validation.test.js:106` MIME exato; :107 tamanho15; :108 SHA64; seis fixtures; runtime:72 MIME/:73 tamanho   | Allowlist e bytes/codec válidos | Sim     |
| MED04 limites      | `test/chat-media-validation.test.js:230` limite exato; :238 throws status413 para+1                                           | Fronteira5/16MiB                | Sim     |
| Legenda            | `test/chat-media-validation.test.js:254`1024; :2621025throws; :274 áudio throws                                               | Limites aprovados               | Sim     |
| MIME/codec MED29   | `test/chat-media-validation.test.js:295` razão invalid_format; :344 rejects HEVC/MP3video/Vorbis; runtime:151/:181 rejects    | Disfarce/codec não ficam ready  | Sim     |
| Scanner MED26      | `test/chat-media-validation.test.js:367` razões infected/stale/scanner_unavailable e mensagem fixa; runtime:198 EICARinfected | Fail closed, sem dado privado   | Sim     |
| MP3 capa           | `test/chat-media-validation.test.js:160`audioCodec mp3/:162 vídeo comum rejects; runtime:99 capa real aceita                  | Capa embutida válida            | Sim     |
| WebM streaming     | `test/chat-media-validation.test.js:189`1200ms/:191301s rejects; runtime:134durationundefined/:145 timeline real1..2s         | Duração medida e limitada       | Sim     |
| Declaração300s     | `test/chat-media-validation.test.js:422`300000ms/:424300.001s rejects                                                         | Teto inclusivo                  | Sim     |
| Probe/empty        | `test/chat-media-validation.test.js:391`rejects                                                                               | Falha nunca ready               | Sim     |

### Adequação: discriminação

| Near miss                           | Assertion que falha  | Resultado incorreto distinguido                  |
| ----------------------------------- | -------------------- | ------------------------------------------------ |
| Aceitar MIME declarado sem detector | unit:295/runtime:151 | PNG declaradoJPEG aceito                         |
| Aceitar qualquer codecMP4/OGG       | unit:344/runtime:181 | HEVC/mpeg4/Vorbis aceitos                        |
| Fail open no scanner                | unit:367/runtime:198 | EICAR ou scanner erro aceito                     |
| Rejeitar MP3 com capa               | unit:160/runtime:99  | Arquivo permitido rejeitado                      |
| Supor duraçãoWebM ausente           | unit:189/runtime:145 | Gravação Chromium rejeitada ou duração inventada |
| Truncar gravação longa e aceitar    | unit:191             | 301s aceitos                                     |

Runtime final PASS: um teste, zero skips,111s; seis formatos reais, MP3capa,
WebMChromium com duração ausente e timeline medida, MIMEdisfarçado/codec/EICAR.
Reprodução: executar `node scripts/generate-chat-media-recording-fixture.mjs`
com PlaywrightChromium instalado; executar teste no container com
`RUN_CHAT_MEDIA_RUNTIME_TESTS=yes` e `CHAT_MEDIA_CHROMIUM_FIXTURE` apontando
para `var/tooling/chromium-media-recorder.webm` no mount. Gerador usa apenas
oscilador, não microfone; bytes/hash variam por serial/timestamps da gravação.
Pico clamscan observado750MiB; orçamento operacional medido emT5.

Veredito: suficiente e discriminante; Quick/runtime/Build PASS. Nenhum
requisito completo Verified, pois API/UI/worker ainda estão pendentes.

## T3: Adapter privado RustFS

PASS: nove unitários e um ciclo real do SDK na alpha.99 local. Gate Quick
668 pass, três skips preexistentes, 671 total; tipo/lint/audit verdes.
T3 não declara requisitos inteiros verificados, pois API/worker seguem pendentes.

### Antes do patch

- Premissas: source validada fornece SHA-256, tamanho e MIME; key UUID opaco;
  bucket CRM isolado; nenhuma URL assinada retornada para browser.
- Arquivos: `rustfs-media-store.js`, export `index.js`, manifest do módulo e
  lockfile, testes `rustfs-media-store.test.js` e `rustfs-media-store-live.test.js`,
  spec/tasks/execution. Nenhuma dependência frontend adicionada.
- Sucesso: pelo menos oito unitários, operações streaming e falhas parciais,
  mais ciclo real SDK em alpha.99; Quick, smoke T1, tipos/lint e audit.
- Dependência: T2 `b94e5f1`; correção de negativas T1 `cacb897`.

### Dependência e contrato

`@aws-sdk/client-s3` fixado em 3.1146.0 no módulo backend, 26 pacotes novos.
Metadados npm: Apache-2.0 e Node >=20, compatível com runtime 24.20.0.
Justificativa: assinatura/autenticação, streaming e operações S3 necessárias,
evitando implementar protocolo próprio no runtime. Risco: superfície de
dependências e defaults de checksum; lockfile, audit high e ciclo real
contra imagem exata fazem parte do gate.

[AWS checksum docs](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html)
confirma CRC32 automático desde 3.729.0. O adapter usa SHA256 precomputado,
ContentLength e settings WHEN_REQUIRED, path-style e maxAttempts=1.
`IfNoneMatch='*'` foi comprovado na alpha.99: replay 412 só retorna sucesso
se HEAD reconcilia o mesmo SHA/tamanho/MIME. Variante divergente não sobrescreve.
Erro de PUT preserva código MEDIA_STORAGE_UNAVAILABLE; não vira invalid_format.

Métodos: `putValidated({key,stream,sizeBytes,sha256,mimeType})`, `head(key)`,
`read(key,range?)`, `deleteDraft(key)`. Read retorna stream Node, tamanho,
SHA, MIME e Content-Range; não retorna URL/key/bucket/ETag. Delete exige que
o chamador bloqueie e revalide `message_id IS NULL` antes, implementado em T22.
Byte count/hash são verificados durante PUT; erros de read parcial são
sanitizados. Falhas 404/416/externa têm códigos distintos. SDK não retry cego.

Ciclo real em `rtk proxy node --test test/rustfs-media-store-live.test.js`,
com credencial DEV limitada e opt-in explícito: PUT streaming, HEAD hash/size,
GET bytes exatos, Range bytes exatos, replay condicional, rejeição de variante
divergente, GET original preservado, DELETE e HEAD404. Um teste passou, zero
skips. Warnings SDK de request streaming não retryable em 412 são genéricos;
nenhum segredo/chave/provider body vai para log ou DTO.
Smoke T1 atual `var/rustfs-local-alpha99-object-denial-evidence.json` passou
com 11 checks reais na mesma imagem/digest, após instalar o SDK.

### Adequação: suficiência

| Critério / requisito                  | Evidência assertion                                                                                                                                                                                                             | Resultado esperado                                        | Coberto |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------- |
| PUT streaming/hash/size               | `test/rustfs-media-store.test.js:43`: `assert.deepEqual(await collect(command.input.Body), BYTES)`; linha46 `assert.deepEqual(result,{sizeBytes:BYTES.length,sha256:SHA})`; linha38 assert checksum base64                      | Bytes exatos, digest/tamanho da variante                  | Sim     |
| HEAD                                  | `test/rustfs-media-store.test.js:57`: `assert.deepEqual(result,{sizeBytes:BYTES.length,sha256:SHA,mimeType:'image/jpeg'})`                                                                                                      | Metadata privada exata, sem ETag                          | Sim     |
| Reconciliação sem overwrite MED-15/19 | `test/rustfs-media-store.test.js:80`: `assert.deepEqual(await adapter.putValidated(upload()),{sizeBytes:BYTES.length,sha256:SHA})`; linha85 `assert.rejects` variante com código MEDIA_STORAGE_UNAVAILABLE                      | 412 igual reconcilia; diferente falha                     | Sim     |
| Range MED-17                          | `test/rustfs-media-store.test.js:106`: `assert.equal(result.contentRange,...)`; linha108 `assert.deepEqual(await collect(result.stream),BYTES.subarray(0,3))`                                                                   | Range e bytes exatos                                      | Sim     |
| Falhas MED-19/20                      | `test/rustfs-media-store.test.js:117`: `assert.rejects(...error.code===code&&!JSON.stringify(error).includes('secret'))`                                                                                                        | 404 missing/416 range/503 unavailable sanitizados         | Sim     |
| Timeout                               | `test/rustfs-media-store.test.js:134`: `assert.rejects(...error.code==='MEDIA_STORAGE_UNAVAILABLE')`                                                                                                                            | Deadline aborta request, não declara sucesso              | Sim     |
| Limite/hash incorreto                 | `test/rustfs-media-store.test.js:154` e `:158`: `assert.rejects(adapter.putValidated(...),/Unable to store private media/u)`                                                                                                    | Fonte divergente não vira PUT válido                      | Sim     |
| Stream parcial MED-19/20              | `test/rustfs-media-store.test.js:175`: `assert.rejects(collect(result.stream),...error.message==='Private media storage is unavailable')`                                                                                       | Falha sem URL/secret raw                                  | Sim     |
| Delete/key/bucket isolados            | `test/rustfs-media-store.test.js:189`: `assert.deepEqual(target,{Bucket:'crm-silmer-chat-media-dev',Key:KEY})`; linha190 `assert.rejects` key arbitrária; linha194 `assert.throws` Hermes                                       | Somente bucket CRM/key UUID                               | Sim     |
| SDK real                              | `test/rustfs-media-store-live.test.js:52`: `assert.deepEqual(await bytes(read.stream),body)`; linha55 Range bytes; linha74 `assert.deepEqual(await bytes(preserved.stream),body)`; linha78 `assert.rejects` missing após delete | Defaults SDK compatíveis com alpha.99 e bytes preservados | Sim     |

### Adequação: necessidade

| Teste / assertion                                                      | Origem                                                       | Manter |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| `test/rustfs-media-store.test.js:35–47`, output bytes/digest e sem key | T3 streaming + MED-15/20                                     | Sim    |
| `test/rustfs-media-store.test.js:57`, HEAD metadata                    | T3 HEAD                                                      | Sim    |
| `test/rustfs-media-store.test.js:80–85`, 412 igual/diferente           | Design PUT/DB desconhecido + MED-19                          | Sim    |
| `test/rustfs-media-store.test.js:97–108`, Range                        | MED-17                                                       | Sim    |
| `test/rustfs-media-store.test.js:117`, códigos/privacidade             | MED-19/20                                                    | Sim    |
| `test/rustfs-media-store.test.js:134`, deadline                        | T3 timeout                                                   | Sim    |
| `test/rustfs-media-store.test.js:154–158`, hash/size                   | T3 fonte válida/streaming                                    | Sim    |
| `test/rustfs-media-store.test.js:175`, read parcial                    | T3 falha parcial + MED-20                                    | Sim    |
| `test/rustfs-media-store.test.js:189–194`, Delete/key/bucket           | T3 acesso privado                                            | Sim    |
| `test/rustfs-media-store-live.test.js:42–78`, ciclo real               | T3 compatibilidade real, sem presumir smoke manual prova SDK | Sim    |

Verdict: critérios e falhas da camada cobertos em outputs e bytes, inclusive
contra runtime real. Testes seguem CONTRIBUTING/node:test/JSDoc; nenhum teste
preexistente alterado, ignorado ou removido. Nenhum cenário fora da spec.

## Correção T1: negar leitura de objeto conhecido fora do bucket

PASS em 2026-10-06T03:00:29.057Z. Uma revisão intermediária detectou que
HEAD de bucket testa ListBucket e não prova GetObject negado. O smoke agora
exige HEAD e GET de um canário sintético conhecido no bucket negado com 403.
O operador havia comprovado PUT/HEAD 200 e tamanho 48 bytes desse canário;
o smoke limitado não o cria ou remove. Nenhuma operação em Hermes.

Arquivos da correção: script/harness T1, runbook, tasks e execution.
T3 foi preservada em WIP e não entra neste commit. Credenciais administrativas
ficam fora do smoke e do runtime. Chave do canário não vai ao evidence JSON.

Evidência local atual: `var/rustfs-local-alpha99-object-denial-evidence.json`,
mesmo digest alpha.99 observado anteriormente. São 11 checks reais, incluindo
os novos `crossObjectHeadDenied=true` e `crossObjectGetDenied=true`.
Harness: 10/10 passaram, zero falhas/skips. Quick: 666 pass, três skips
preexistentes, 669 total; essa contagem inclui oito testes T3 ainda em WIP,
não entregues neste commit. Nenhuma assertion foi enfraquecida; a comparação
exata dos checks foi fortalecida com os dois campos novos.

| Critério / necessidade                     | Evidência assertion                                                                                                                      | Resultado da spec/gate                                             | Manter                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| Bucket HEAD403 não prova objeto GET negado | `test/rustfs-live-smoke.test.js:255`: `await assert.rejects(h.run(), /cross-bucket object GET/u)`                                        | GET200 de objeto fora do bucket impede PASS mesmo se HEADbucket403 | Sim, isolamento T1/MED-16 suporte |
| Falha sem evidência e cleanup próprio      | `test/rustfs-live-smoke.test.js:256`: `assert.equal(h.evidence(), undefined)`; linha257 `assert.equal(h.removed(), true)`                | Não declarar PASS; limpar somente canário próprio                  | Sim, T1/MED-19 suporte            |
| Resultado evidencia cada negativa real     | `test/rustfs-live-smoke.test.js:118`: `assert.deepEqual(result.checks, {...crossObjectHeadDenied: true, crossObjectGetDenied: true...})` | Checks distintos de bucket e de objeto                             | Sim, T1 isolamento                |

Verdict de adequação: cenários positivos e bypass real cobertos; teste
necessário para a policy por bucket; bytes e estados continuam assertados.
Tabela de T1 abaixo atualizada para as linhas atuais. Gates tipo/lint/diff
também passam; isto não é validação final independente da feature.

## T1: Compatibilidade RustFS

Status: concluída. Harness e smoke real passaram na alpha.99 local isolada.
Ativação remota continua pendente em T23. T2 foi concluída abaixo.

### Antes do patch

- Premissas: versão configurada `rustfs/rustfs:1.0.0-alpha.99`; buckets CRM
  distintos, privados e sem expiração; credencial limitada própria para o
  smoke. Nenhuma operação em `hermes-backups`.
- Arquivos: `docs/runbooks/rustfs-chat-media.md`,
  `scripts/rustfs-live-smoke.mjs`, `test/rustfs-live-smoke.test.js`,
  `package.json` (script somente), `tasks.md` e este relatório.
- Sucesso: pelo menos seis casos locais do harness; operações e negativas
  reais na imagem alpha.99 com digest observado; Topology e recovery mocks.
- Dependência: nenhuma. Task IDs de MED-16, MED-19, MED-23.

### Escolhas de implementação

O smoke usa transporte SigV4 pequeno para canário e não altera dependências.
O adapter runtime continua previsto com SDK fixado em T3. O processo limita
buckets a nomes CRM conhecidos, exige opt-in e HTTPS. HTTP é permitido
somente em loopback para ambiente isolado. Cleanup remove só a chave criada
pelo processo, mesmo após resultado desconhecido de PUT. Falha nunca grava
evidência PASS.

O usuário autorizou Docker local depois do planejamento, que originalmente
dependia de `dell-worker`. T1 comprova compatibilidade real na mesma versão
configurada usando container local. Seu digest não comprova o deployment
remoto. T23 permanece responsável por ativação, acesso e recovery no alvo.
Essa distinção foi registrada no critério de T1 antes de sua execução real.

### Gates locais executados

- `rtk proxy node --test test/rustfs-live-smoke.test.js`: 9 passaram, zero
  falhas/skips. Testes foram escritos antes do harness.
- `rtk npm run typecheck`: PASS.
- `rtk proxy npx eslint scripts/rustfs-live-smoke.mjs test/rustfs-live-smoke.test.js`:
  PASS.
- `rtk npm run validate:topology`: PASS; readiness continua blocked, com oito
  bloqueios preexistentes. Não é aprovação de recovery.
- `rtk npm run test:recovery:mocks`: 14 passaram, zero falhas/skips.
- `rtk git diff --check`: PASS.

### Smoke real e digest

`rtk npm run smoke:rustfs:live`, executado com Node 24.20.0 e credencial
local limitada, passou em 2026-10-06T02:48:15.360Z. Evidência sanitizada
local: `var/rustfs-local-alpha99-evidence.json`. A execução retornou os nove
checks `true`, incluindo 403 anônimo/cross-bucket, Range 206 com bytes
exatos, Range inválido 416 e HEAD 404 após DELETE 204. O bucket negado era
`crm-silmer-smoke-denied-local`, vazio e restrito ao teste em loopback.

`docker inspect crm-silmer-media-test-rustfs` e
`docker image inspect rustfs/rustfs:1.0.0-alpha.99` confirmaram o mesmo
digest da imagem/container em execução:
`sha256:103dd40b84d5aa3d5ab02f3a693797eb1d14cb842554b222dfbb589f364aa47f`.
Scope do JSON: `local-version-compatibility`; não há prova do digest remoto.

Foi detectada uma diferença real de IAM: alpha.99 rejeita
`s3:GetLifecycleConfiguration` como action inválida. Seu enum oficial usa
`s3:GetBucketLifecycle`; a policy sintética limitada foi corrigida para essa
action de leitura e aplicada com 200. Nenhuma configuração de lifecycle
foi modificada. O GET do próprio bucket retornou
404 `NoSuchLifecycleConfiguration`.

### Adequação dos testes do harness

Arquivos seguem `CONTRIBUTING.md`, `node:test`, `test/*.test.js` e JSDoc
checkJs. As negativas fazem implementações plausíveis incorretas falharem;
um transporte fake não comprova compatibilidade RustFS.

| Critério T1 / requisito                         | Evidência exata                                                                                                                                                                                                                                                                                                                | Resultado esperado                                       | Coberto                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------ |
| PUT/HEAD/GET/Range/DELETE e negativas           | `test/rustfs-live-smoke.test.js:118`: `assert.deepEqual(result.checks, { put: true, headHashAndSize: true, getHashAndSize: true, range: true, invalidRange: true, anonymousDenied: true, crossBucketDenied: true, crossObjectHeadDenied: true, crossObjectGetDenied: true, noExpiryLifecycle: true, deleteAndMissing: true })` | Cada check real precisa passar antes de emitir evidência | Sim; smoke real comprovado acima     |
| Digest real e dados sintéticos                  | `test/rustfs-live-smoke.test.js:132`: `assert.equal(result.runningImageDigest, env.RUSTFS_RUNNING_IMAGE_DIGEST)`; linha 133: `assert.equal(result.syntheticOnly, true)`                                                                                                                                                        | Preservar digest fornecido, sem alegar versão do alvo    | Sim; docker inspect comprovado acima |
| Isolamento Hermes                               | `test/rustfs-live-smoke.test.js:148`: `assert.throws(() => validateRustfsSmokeEnvironment({ ...env, MEDIA_S3_BUCKET: 'hermes-backups' }), /CRM bucket/u)`                                                                                                                                                                      | Recusar bucket alheio antes da rede                      | Sim                                  |
| Sem segredo/chave no relatório (MED-20 suporte) | `test/rustfs-live-smoke.test.js:135`: `assert.equal(serialized.includes(env.MEDIA_S3_SECRET_ACCESS_KEY), false)`; linha 136: `assert.equal(serialized.includes(env.MEDIA_S3_ACCESS_KEY_ID), false)`                                                                                                                            | Segredo e access key ausentes                            | Sim                                  |
| Acesso privado (MED-16 suporte)                 | `test/rustfs-live-smoke.test.js:195`: `await assert.rejects(h.run(), /anonymous access/u)`; linha 227: `await assert.rejects(h.run(), /cross-bucket access/u)`                                                                                                                                                                 | 200 anônimo/cross-bucket impede PASS                     | Sim                                  |
| Bytes/Range reais (MED-23 suporte)              | `test/rustfs-live-smoke.test.js:235`: `await assert.rejects(h.run(), /Range\|GET/u)`                                                                                                                                                                                                                                           | Bytes alterados ou 200 ignorando Range impedem PASS      | Sim                                  |
| Falha externa e cleanup (MED-19 suporte)        | `test/rustfs-live-smoke.test.js:243`: `await assert.rejects(h.run(), (error) => error instanceof Error && error.message === 'RustFS smoke failed at PUT; no live PASS recorded')`                                                                                                                                              | Falha de PUT sanitizada, sem PASS                        | Sim                                  |
| Preservação sem expiração                       | `test/rustfs-live-smoke.test.js:262`: `await assert.rejects(h.run(), /lifecycle/u)`                                                                                                                                                                                                                                            | Lifecycle com expiração impede PUT e PASS                | Sim                                  |

| Teste / assertion                                                                                   | Origem                                             | Manter |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------ |
| linhas 113–134, checks/digest/synthetic/sem segredos/sem Hermes                                     | T1 Done when + MED-16/19/23                        | Sim    |
| linhas 141–155, `assert.throws` bucket Hermes/duplicado                                             | T1 isolamento por bucket                           | Sim    |
| linhas 160–182, `assert.throws` opt-in/HTTPS/digest tag                                             | T1 gate explícito e digest real                    | Sim    |
| linhas 188–190 e 220–222, `assert.rejects` acesso anônimo/cross-bucket; cleanup e relatório ausente | T1 negativas / MED-16                              | Sim    |
| linhas 228–230, `assert.rejects` Range/GET; cleanup e relatório ausente                             | T1 bytes reais / MED-23                            | Sim    |
| linhas 236–243, `assert.rejects` PUT sanitizado; cleanup e relatório ausente                        | T1 falha externa / MED-19                          | Sim    |
| linhas 248–253, `assert.rejects` lifecycle; nenhum PUT e relatório ausente                          | T1 preservação de mídia sem alterações silenciosas | Sim    |

| Critério adicional                  | Evidência exata                                                                                                                                                                                                                                                                                                                                                                                     | Resultado / origem                                                                                                                 | Manter |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| HTTP apenas em homologação loopback | `test/rustfs-live-smoke.test.js:206`: `assert.equal(validateRustfsSmokeEnvironment(local).localLoopback, true)`; linha 207: `assert.throws(() => validateRustfsSmokeEnvironment({ ...local, MEDIA_S3_ENDPOINT: 'http://192.0.2.1:21900' }), /HTTPS/u)`; linha 215: `assert.throws(() => validateRustfsSmokeEnvironment({ ...local, MEDIA_S3_ENDPOINT: 'https://s3.example.test' }), /CRM bucket/u)` | DEV isolado permitido; endpoint externo inseguro/bucket canário local externo rejeitados. T1 isolamento + autorização Docker local | Sim    |

Verdict: critérios de T1 cobertos no harness e por smoke real, com digest
observado. Sem assertions rasas, testes desnecessários ou alterações de
testes existentes. Nenhum segredo ou dado real utilizado. T1 concluída;
T23 continua responsável por ativação e recovery no deployment remoto.

## T2: Schema persistente

Status: concluída, gates Live e Build passaram. Requisitos
MED-05/15/27/28 permanecem em progresso; schema não comprova envio ou UI.

### Antes do patch

- Premissas: último número real é 0026; IDs de conversas/usuários/mensagens
  permanecem text. A nova mídia usa UUID e não reutiliza transient_media.
- Arquivos: `modules/database/migrations/0030_chat_media.expand.sql`,
  `test/chat-media-schema-postgres-live.test.js`, `spec.md`, `tasks.md`,
  `execution.md`. Migrations publicadas ficam intactas.
- Sucesso: ao menos seis cenários live de replay, vínculo único, retenção
  independente e quota, com gates Live e Build. Banco exclusivo
  `crm_silmer_test`, sintético e sem dados reais.
- Dependência: T1 concluída em `7e388c8`.

### Implementação e gates

Criada `crm.chat_media` com vínculo único por mensagem, FK composta para a
mesma conversa, upload idempotente por ator/conversa, filename cifrado,
estados, metadados, reserva e CAS. Sem expires_at ou trigger de fim de
jornada. `crm.chat_media_quotas` separa bytes utilizados e reservados;
limites serão injetados e atualizados transacionalmente por API/worker.
Jobs ganham `chat_media_id` e `chat_media.process`, com unicidade e target
próprio. As quatro variantes legadas foram preservadas.

O teste live utiliza ciphertext AES-256-GCM sintético com iv/tag reais.
O CHECK do novo envelope é total (`IS TRUE`), negando campos ausentes,
metadata incompleta e plaintext. O CHECK valida estrutura; autenticação
criptográfica depende da aplicação, não da expressão SQL.

Nenhuma assertion existente foi alterada, removida ou ignorada. Uma falha
inicial no setup do teste (migrate exige options) foi corrigida; uma colisão
de nome de constraint na migration nova foi corrigida antes de aplicar.

- Live T2: 8/8 passaram, zero falhas/skips.
- Live do projeto + T2: 19/19 passaram, zero falhas/skips, com
  `node --test --test-concurrency=1 test/migrations-live.test.js test/inbox-postgres-live.test.js test/n8n-command-store-postgres-live.test.js test/chat-media-schema-postgres-live.test.js`.
- `npm run validate`: PASS com Node 24.20.0/npm 11.19.0, 657 pass,
  três skips preexistentes, 660 total. Inclui lint, tipos e build.
- `npm run test:e2e -- --workers=1`: 107 passaram, sete skips preexistentes,
  114 total. Assertions e contagem preservadas. A primeira execução com
  oito workers tinha 105 pass e duas falhas, incluindo Target crashed;
  o rerun completo com um worker confirmou a suíte sem alterar teste.
- `npm audit --audit-level=high`: zero vulnerabilidades.
- `git diff --check`, validate_spec e validate_tasks strict: PASS.

### Adequação

| Critério / requisito                           | `file:line` + assertion                                                                                                                                                                                                                                                                                                                                                                     | Resultado esperado                                                                  | Coberto |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------- |
| Migration aplica duas vezes                    | `test/chat-media-schema-postgres-live.test.js:102`: `assert.deepEqual(await migrate(pool, { migrations: await loadMigrations() }), { applied: [], phase: 'expand' })`; linha 109: `assert.equal(result.rows[0].count, 1)`                                                                                                                                                                   | Replay vazio, uma aplicação 0027                                                    | Sim     |
| Um arquivo por mensagem, mesma conversa MED-05 | `test/chat-media-schema-postgres-live.test.js:120` e 129: `await assert.rejects(media(...), /chat_media_message_id_key/u)` e `await assert.rejects(media(...), /chat_media_message_conversation_fk/u)`                                                                                                                                                                                      | Duplicate/FK rejeitam vínculo inválido                                              | Sim     |
| Upload idempotente por ator/conversa           | `test/chat-media-schema-postgres-live.test.js:142`: `await assert.rejects(media({ upload_command_id: first.upload_command_id }), /chat_media_upload_scope_key/u)`; linha 150: `assert.equal(other.upload_command_id, first.upload_command_id)`                                                                                                                                              | Mesmo scope duplicado rejeitado; outra conversa independente                        | Sim     |
| Preservação após oito dias/terminal MED-15     | `test/chat-media-schema-postgres-live.test.js:163`–164: `assert.equal(await repository.scheduleExpiredDeletions(), 0)` e `assert.equal(await repository.scheduleTerminalJourneyDeletions(), 0)`; linha 168: `assert.deepEqual(attached.rows, [{ state: 'attached', message_id: 'media-conversation-a-message' }])`; linha 174: `assert.equal(oldMedia.rows[0].older_than_eight_days, true)` | Media antiga permanece attached, nenhum job transitório                             | Sim     |
| Rascunho separado MED-27                       | `test/chat-media-schema-postgres-live.test.js:225`: `assert.equal(draft.message_id, null)`; linha 226: `assert.equal(draft.retention_class, 'chat_retained')`; linha 227: `assert.equal(draft.state, 'uploaded')`                                                                                                                                                                           | Rascunho sem vínculo, classe própria                                                | Sim     |
| Quota/reservas MED-28                          | `test/chat-media-schema-postgres-live.test.js:189`/195: `await assert.rejects(pool.query(...), /chat_media_quotas_capacity_check/u)` e `await assert.rejects(pool.query(...), /chat_media_quotas_nonnegative_check/u)`; linha 204: `assert.deepEqual(row.rows, [{ used_bytes: '600', reserved_bytes: '300' }])`                                                                             | Soma acima de limite e valores negativos rejeitados; counters separados preservados | Sim     |
| Ready requer metadata limpa                    | `test/chat-media-schema-postgres-live.test.js:208`–220: `await assert.rejects(media({ state: 'ready' }), /chat_media_ready_metadata_check/u)`; variante infected, linked sem attached e reserva negativa também rejeitadas                                                                                                                                                                  | Não publicar ready incompleta/infectada                                             | Sim     |
| Filename cifrado no schema                     | `test/chat-media-schema-postgres-live.test.js:237`: `await assert.rejects(media({ filename_envelope: JSON.stringify(invalid) }), /chat_media_filename_envelope_check/u)`; linha 243: `assert.equal(valid.filename_envelope.ciphertext, JSON.parse(envelope).ciphertext)`; linha 247: `assert.equal(JSON.stringify(valid.filename_envelope).includes('synthetic.jpg'), false)`               | Estrutura incompleta/plaintext rejeitados; ciphertext real preservado               | Sim     |
| Target/uniqueness job                          | `test/chat-media-schema-postgres-live.test.js:274`: `assert.deepEqual(job.rows, [{ job_type: 'chat_media.process', chat_media_id: draft.id }])`; linha 277: `await assert.rejects(insert(), /outbox_jobs_chat_media_process_key/u)`; linhas 278/282: `assert.rejects` target null/FK inexistente                                                                                            | Target persistente próprio, um job por mídia, FK válida                             | Sim     |

| Teste / assertion                                                                              | Origem                                         | Manter |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------ |
| `test/chat-media-schema-postgres-live.test.js:102`, replay e count                             | Done when T2 migration idempotente             | Sim    |
| `test/chat-media-schema-postgres-live.test.js:119–129`, vínculo positivo e negativas unique/FK | MED-05 + Done when T2 vínculo                  | Sim    |
| `test/chat-media-schema-postgres-live.test.js:142–150`, replay scope                           | Design `upload_command_id` + T2 constraints    | Sim    |
| `test/chat-media-schema-postgres-live.test.js:163–182`, sweeper/attached/date/sem expires/jobs | MED-15 + T2 sem sweeper transitório            | Sim    |
| `test/chat-media-schema-postgres-live.test.js:189–204`, capacidade e counters                  | MED-28 + T2 modelo de quota                    | Sim    |
| `test/chat-media-schema-postgres-live.test.js:208–228`, ready/binding/size/draft/object UUID   | MED-05/27 + modelo T2                          | Sim    |
| `test/chat-media-schema-postgres-live.test.js:237–247`, envelope inválido/ciphertext           | Design filename_envelope cifrado / privacidade | Sim    |
| `test/chat-media-schema-postgres-live.test.js:274–285`, jobtarget/unique/FK                    | T2 payload de job compatível                   | Sim    |

Verdict: suficiência por critério e necessidade por teste comprovadas em
SQL real. Assertions verificam valores persistidos e falhas de constraints,
sem substituir estado por call counts. Padrão `CONTRIBUTING.md`, node:test,
JSDoc/checkJs e banco dedicado. Sem alteração de migration publicada.

### Adequação necessária T7/T8 (mapeamento reverso atualizado)

| file:line + assertion | Origem / critério | Manter |
| --- | --- | --- |
| `test/chat-media-upload-routes.test.js:66`: `assert.ok(reservations.get(input.id) >= input.sizeBytes * 2);` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-upload-routes.test.js:120`: `assert.equal(response.statusCode, 202);` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:121`: `assert.equal(response.json().state, 'processing');` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:122`: `assert.match(response.json().mediaId, /^[a-f0-9-]{36}$/u);` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:124`: `assert.equal(saved.sizeBytes, 15);` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:125`: `assert.equal(saved.declaredMimeType, 'image/png');` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:126`: `assert.equal(saved.reservationBytes, 30);` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:127`: `assert.equal(saved.filenameEnvelope.algorithm, 'AES-256-GCM');` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:136`: `assert.deepEqual( JSON.parse( Buffer.concat([ decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final(), ]).toString('utf8'), ), { filename: 'private-canary.png' }, );` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:145`: `assert.equal( JSON.stringify(saved.filenameEnvelope).includes('private-canary'), false, );` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:149`: `assert.deepEqual(await readdir(h.root), [saved.id]);` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:150`: `assert.equal(response.body.includes('private-canary'), false);` | MED-01/20: accepted upload is private and leaves complete spool for one job | Sim |
| `test/chat-media-upload-routes.test.js:156`: `assert.equal(replay.statusCode, 202);` | MED-06: byte-identical replay preserves media ID and removes replay spool | Sim |
| `test/chat-media-upload-routes.test.js:157`: `assert.deepEqual(replay.json(), first.json());` | MED-06: byte-identical replay preserves media ID and removes replay spool | Sim |
| `test/chat-media-upload-routes.test.js:158`: `assert.equal(h.records.size, 1);` | MED-06: byte-identical replay preserves media ID and removes replay spool | Sim |
| `test/chat-media-upload-routes.test.js:159`: `assert.equal(h.reservations.size, 0);` | MED-06: byte-identical replay preserves media ID and removes replay spool | Sim |
| `test/chat-media-upload-routes.test.js:160`: `assert.equal((await readdir(h.root)).length, 1);` | MED-06: byte-identical replay preserves media ID and removes replay spool | Sim |
| `test/chat-media-upload-routes.test.js:166`: `assert.equal(response.statusCode, 409);` | MED-07: same command different bytes returns 409 and cleans failed spool | Sim |
| `test/chat-media-upload-routes.test.js:167`: `assert.equal(h.records.size, 1);` | MED-07: same command different bytes returns 409 and cleans failed spool | Sim |
| `test/chat-media-upload-routes.test.js:168`: `assert.equal(h.reservations.size, 0);` | MED-07: same command different bytes returns 409 and cleans failed spool | Sim |
| `test/chat-media-upload-routes.test.js:169`: `assert.equal((await readdir(h.root)).length, 1);` | MED-07: same command different bytes returns 409 and cleans failed spool | Sim |
| `test/chat-media-upload-routes.test.js:175`: `assert.equal(response.statusCode, statusCode);` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:176`: `assert.equal(response.json().accepted, false);` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:177`: `assert.equal(response.json().status, statusCode);` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:178`: `assert.equal( response.json().error.code, /** @type {Record<number,string>} */ ({ 403: 'FORBIDDEN', 409: 'MEDIA_CONFLICT', 429: 'MEDIA_RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE', })[statusCode], );` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:187`: `assert.equal( response.headers['content-type'], 'application/problem+json; charset=utf-8', );` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:191`: `assert.equal(h.records.size, 0);` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:192`: `assert.deepEqual(await readdir(h.root), []);` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:193`: `assert.equal(response.body.includes('private-canary'), false);` | MED-08/28: admission ${statusCode} writes no bytes | Sim |
| `test/chat-media-upload-routes.test.js:198`: `assert.equal(response.statusCode, 401);` | MED-16: absent session returns 401 before admission | Sim |
| `test/chat-media-upload-routes.test.js:199`: `assert.equal(h.records.size, 0);` | MED-16: absent session returns 401 before admission | Sim |
| `test/chat-media-upload-routes.test.js:200`: `assert.deepEqual(await readdir(h.root), []);` | MED-16: absent session returns 401 before admission | Sim |
| `test/chat-media-upload-routes.test.js:205`: `assert.equal(response.statusCode, 403);` | MED-08: CSRF mismatch returns 403 before bytes | Sim |
| `test/chat-media-upload-routes.test.js:206`: `assert.deepEqual(await readdir(h.root), []);` | MED-08: CSRF mismatch returns 403 before bytes | Sim |
| `test/chat-media-upload-routes.test.js:214`: `assert.equal(response.statusCode, 413);` | MED-04: image above 5 MiB returns 413 even with false Content-Length | Sim |
| `test/chat-media-upload-routes.test.js:215`: `assert.equal(h.records.size, 0);` | MED-04: image above 5 MiB returns 413 even with false Content-Length | Sim |
| `test/chat-media-upload-routes.test.js:216`: `assert.equal(h.reservations.size, 0);` | MED-04: image above 5 MiB returns 413 even with false Content-Length | Sim |
| `test/chat-media-upload-routes.test.js:217`: `assert.deepEqual(await readdir(h.root), []);` | MED-04: image above 5 MiB returns 413 even with false Content-Length | Sim |
| `test/chat-media-upload-routes.test.js:222`: `assert.equal(response.statusCode, 422);` | MED-04: truncated multipart never publishes job and confirms cleanup | Sim |
| `test/chat-media-upload-routes.test.js:223`: `assert.equal(h.records.size, 0);` | MED-04: truncated multipart never publishes job and confirms cleanup | Sim |
| `test/chat-media-upload-routes.test.js:224`: `assert.equal(h.reservations.size, 0);` | MED-04: truncated multipart never publishes job and confirms cleanup | Sim |
| `test/chat-media-upload-routes.test.js:225`: `assert.deepEqual(await readdir(h.root), []);` | MED-04: truncated multipart never publishes job and confirms cleanup | Sim |
| `test/chat-media-upload-routes.test.js:236`: `assert.equal(response.statusCode, 422);` | MED-04: invalid fields ${JSON.stringify(fields)} return 422 | Sim |
| `test/chat-media-upload-routes.test.js:237`: `assert.equal(h.records.size, 0);` | MED-04: invalid fields ${JSON.stringify(fields)} return 422 | Sim |
| `test/chat-media-upload-routes.test.js:238`: `assert.deepEqual(await readdir(h.root), []);` | MED-04: invalid fields ${JSON.stringify(fields)} return 422 | Sim |
| `test/chat-media-upload-routes.test.js:243`: `assert.equal(response.statusCode, 422);` | MED-29: zero bytes rejected before 202 without false metadata | Sim |
| `test/chat-media-upload-routes.test.js:244`: `assert.equal(h.records.size, 0);` | MED-29: zero bytes rejected before 202 without false metadata | Sim |
| `test/chat-media-upload-routes.test.js:245`: `assert.equal(h.reservations.size, 0);` | MED-29: zero bytes rejected before 202 without false metadata | Sim |
| `test/chat-media-upload-routes.test.js:246`: `assert.deepEqual(await readdir(h.root), []);` | MED-29: zero bytes rejected before 202 without false metadata | Sim |
| `test/chat-media-upload-routes.test.js:251`: `assert.equal(response.statusCode, 202);` | MED-29: complete invalid format is accepted for asynchronous inspection | Sim |
| `test/chat-media-upload-routes.test.js:252`: `assert.equal(response.json().state, 'processing');` | MED-29: complete invalid format is accepted for asynchronous inspection | Sim |
| `test/chat-media-upload-routes.test.js:253`: `assert.equal([...h.records.values()][0].sizeBytes, 6);` | MED-29: complete invalid format is accepted for asynchronous inspection | Sim |
| `test/chat-media-upload-routes.test.js:263`: `assert.equal(response.statusCode, 202);` | MED-14/28: recording reserves input plus 32 MiB after worst case admission | Sim |
| `test/chat-media-upload-routes.test.js:264`: `assert.equal( [...h.records.values()][0].reservationBytes, 15 + 32 * 1024 * 1024, );` | MED-14/28: recording reserves input plus 32 MiB after worst case admission | Sim |
| `test/chat-media-upload-routes.test.js:274`: `assert.equal(response.statusCode, 413);` | MED-04: audio above 16 MiB is interrupted before publishing media | Sim |
| `test/chat-media-upload-routes.test.js:275`: `assert.equal(h.records.size, 0);` | MED-04: audio above 16 MiB is interrupted before publishing media | Sim |
| `test/chat-media-upload-routes.test.js:276`: `assert.equal(h.reservations.size, 0);` | MED-04: audio above 16 MiB is interrupted before publishing media | Sim |
| `test/chat-media-upload-routes.test.js:277`: `assert.deepEqual(await readdir(h.root), []);` | MED-04: audio above 16 MiB is interrupted before publishing media | Sim |
| `test/chat-media-upload-routes.test.js:286`: `assert.equal(response.statusCode, 503);` | MED-28: failed spool removal retains charged admission and responds503 | Sim |
| `test/chat-media-upload-routes.test.js:287`: `assert.equal(h.records.size, 0);` | MED-28: failed spool removal retains charged admission and responds503 | Sim |
| `test/chat-media-upload-routes.test.js:288`: `assert.equal(h.reservations.size, 1);` | MED-28: failed spool removal retains charged admission and responds503 | Sim |
| `test/chat-media-upload-routes.test.js:289`: `assert.equal((await readdir(h.root)).length, 1);` | MED-28: failed spool removal retains charged admission and responds503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:44`: `assert.equal(new URL(connectionString).pathname, '/crm_silmer_test');` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-upload-postgres-live.test.js:110`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: String(row.reservationBytes), });` | MED-28: durable admission reserves worst case before any media/job exists | Sim |
| `test/chat-media-upload-postgres-live.test.js:115`: `assert.equal( (await pool.query('SELECT state FROM crm.chat_media_admissions')).rows[0] .state, 'receiving', );` | MED-28: durable admission reserves worst case before any media/job exists | Sim |
| `test/chat-media-upload-postgres-live.test.js:120`: `assert.equal( ( await pool.query( 'SELECT automation_state,automation_epoch,version FROM crm.conversations', ) ).rows[0].automation_state, 'assistant', );` | MED-28: durable admission reserves worst case before any media/job exists | Sim |
| `test/chat-media-upload-postgres-live.test.js:133`: `assert.deepEqual(result, { mediaId: row.id, duplicate: false });` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:134`: `assert.deepEqual(await counts(), { media: 1, jobs: 1, reserved: '200' });` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:136`: `assert.equal(media.input_size_bytes, '100');` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:137`: `assert.equal(media.declared_mime_type, 'image/png');` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:138`: `assert.equal(media.spool_key, row.id);` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:139`: `assert.equal(media.state, 'uploaded');` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:140`: `assert.deepEqual( ( await pool.query( 'SELECT state,reservation_bytes,media_id FROM crm.chat_media_admissions', ) ).rows, [{ state: 'consumed', reservation_bytes: '0', media_id: row.id }], );` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:148`: `assert.deepEqual( ( await pool.query( 'SELECT queue,job_type,effect_policy,chat_media_id FROM crm.outbox_jobs', ) ).rows, [ { queue: 'chat_media', job_type: 'chat_media.process', effect_policy: 'internal', chat_media_id: row.id, }, ], );` | MED-06/28: atomic completion moves reservation once and queues a complete upload | Sim |
| `test/chat-media-upload-postgres-live.test.js:172`: `assert.deepEqual(replay, { replay: { id: row.id, request_fingerprint: 'c'.repeat(64) }, });` | MED-06: accepted replay requires no reservation even when quota is full | Sim |
| `test/chat-media-upload-postgres-live.test.js:175`: `assert.deepEqual(await counts(), { media: 1, jobs: 1, reserved: '200' });` | MED-06: accepted replay requires no reservation even when quota is full | Sim |
| `test/chat-media-upload-postgres-live.test.js:183`: `assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);` | MED-06: concurrent same scope has one durable admission and active replay 409 | Sim |
| `test/chat-media-upload-postgres-live.test.js:184`: `assert.equal( /** @type {any} */ (results.find((r) => r.status === 'rejected')).reason .statusCode, 409, );` | MED-06: concurrent same scope has one durable admission and active replay 409 | Sim |
| `test/chat-media-upload-postgres-live.test.js:189`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: String(row.reservationBytes), });` | MED-06: concurrent same scope has one durable admission and active replay 409 | Sim |
| `test/chat-media-upload-postgres-live.test.js:201`: `assert.equal(replay.replay.id, row.id);` | MED-28: accepted replays and divergent hashes share 12/min throttle without extra quota | Sim |
| `test/chat-media-upload-postgres-live.test.js:203`: `await assert.rejects(repository.admit({ ...row, id: randomUUID() }), { statusCode: 429, });` | MED-28: accepted replays and divergent hashes share 12/min throttle without extra quota | Sim |
| `test/chat-media-upload-postgres-live.test.js:206`: `assert.deepEqual(await counts(), { media: 1, jobs: 1, reserved: '200' });` | MED-28: accepted replays and divergent hashes share 12/min throttle without extra quota | Sim |
| `test/chat-media-upload-postgres-live.test.js:214`: `await assert.rejects(repository.admit(input()), { statusCode: 429 });` | MED-28: quota includes used plus reserved and rejects excess atomically | Sim |
| `test/chat-media-upload-postgres-live.test.js:215`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: String(row.reservationBytes), });` | MED-28: quota includes used plus reserved and rejects excess atomically | Sim |
| `test/chat-media-upload-postgres-live.test.js:235`: `await assert.rejects(repository.complete(completed(row)), { statusCode: mutate.startsWith('assigned') ? 403 : 409, });` | MED-08: transfer or close during streaming prevents completion and preserves charged orphan | Sim |
| `test/chat-media-upload-postgres-live.test.js:238`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: String(row.reservationBytes), });` | MED-08: transfer or close during streaming prevents completion and preserves charged orphan | Sim |
| `test/chat-media-upload-postgres-live.test.js:244`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: '0' });` | MED-08: transfer or close during streaming prevents completion and preserves charged orphan | Sim |
| `test/chat-media-upload-postgres-live.test.js:253`: `await assert.rejects(repository.admit(input()), { statusCode: 429 });` | MED-28: one session allows 12 admissions per minute even after confirmed cleanup | Sim |
| `test/chat-media-upload-postgres-live.test.js:254`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: '0' });` | MED-28: one session allows 12 admissions per minute even after confirmed cleanup | Sim |
| `test/chat-media-upload-postgres-live.test.js:304`: `assert.equal(response.statusCode, n < 12 ? 422 : 429);` | MED-28: cookie order and unrelated cookies cannot bypass the 12/min session limit | Sim |
| `test/chat-media-upload-postgres-live.test.js:306`: `assert.equal( ( await pool.query( 'SELECT count(DISTINCT session_hash)::int AS count FROM crm.chat_media_admissions', ) ).rows[0].count, 1, );` | MED-28: cookie order and unrelated cookies cannot bypass the 12/min session limit | Sim |
| `test/chat-media-upload-postgres-live.test.js:314`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: '0' });` | MED-28: cookie order and unrelated cookies cannot bypass the 12/min session limit | Sim |
| `test/chat-media-upload-postgres-live.test.js:326`: `await assert.rejects( repository.complete(completed(row)), /synthetic job write failure/u, );` | MED-05/28: job insertion rollback leaves admission charged and no media published | Sim |
| `test/chat-media-upload-postgres-live.test.js:330`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: String(row.reservationBytes), });` | MED-05/28: job insertion rollback leaves admission charged and no media published | Sim |
| `test/chat-media-upload-postgres-live.test.js:335`: `assert.equal( (await pool.query('SELECT state FROM crm.chat_media_admissions')) .rows[0].state, 'receiving', );` | MED-05/28: job insertion rollback leaves admission charged and no media published | Sim |
| `test/chat-media-upload-postgres-live.test.js:404`: `assert.equal((await api.inject(request)).statusCode, 503);` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:406`: `assert.equal( await ( await import('node:fs/promises') ).readFile(join(root, media.spool_key), 'utf8'), 'synthetic-bytes', );` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:412`: `assert.deepEqual(await counts(), { media: 1, jobs: 1, reserved: '30' });` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:413`: `assert.equal( (await pool.query('SELECT state FROM crm.chat_media_admissions')) .rows[0].state, 'consumed', );` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:419`: `assert.equal(replay.statusCode, 202);` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:420`: `assert.equal(replay.json().mediaId, media.id);` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:421`: `assert.deepEqual(await counts(), { media: 1, jobs: 1, reserved: '30' });` | MED-19/28: commit response lost preserves accepted spool (reconciliation unavailable=${unavailable}) | Sim |
| `test/chat-media-upload-postgres-live.test.js:430`: `assert.deepEqual(await repository.listAbandonedAdmissions(), [ { id: orphan.id, bucket_alias: 'chat-dev', reservation_bytes: String(orphan.reservationBytes), }, ]);` | MED-27 support: orphan discovery preserves reservation until confirmed cleanup, consumed excluded | Sim |
| `test/chat-media-upload-postgres-live.test.js:439`: `assert.deepEqual(await repository.listAbandonedAdmissions(), []);` | MED-27 support: orphan discovery preserves reservation until confirmed cleanup, consumed excluded | Sim |
| `test/chat-media-upload-postgres-live.test.js:440`: `assert.deepEqual(await counts(), { media: 0, jobs: 0, reserved: '0' });` | MED-27 support: orphan discovery preserves reservation until confirmed cleanup, consumed excluded | Sim |
| `test/chat-media-upload-postgres-live.test.js:508`: `assert.equal((await get()).statusCode, 200);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:513`: `assert.equal( (await get('crm_session=other-synthetic-session')).statusCode, 403, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:520`: `assert.equal( (await get('crm_session=other-synthetic-session')).statusCode, 403, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:527`: `assert.equal( (await get('crm_session=other-synthetic-session')).statusCode, 200, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:542`: `assert.equal( (await get('crm_session=other-synthetic-session')).statusCode, 200, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:546`: `assert.equal((await get('crm_session=bogus')).statusCode, 401);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:547`: `assert.equal( (await get(undefined, 'https://denied.example.test')).statusCode, 403, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:555`: `assert.equal((await get()).statusCode, 401);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:560`: `assert.equal((await get()).statusCode, 401);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:584`: `assert.equal((await post('bogus')).statusCode, 401);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:585`: `assert.equal((await post(undefined, 'wrong')).statusCode, 403);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:586`: `assert.equal((await post()).statusCode, 202);` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:613`: `assert.equal( ( await failedApi.inject({ method: 'GET', url: \`/api/v1/conversations/upload-conversation/media/${row.id}\`, headers: { cookie: 'crm_session=valid-synthetic-session', origin: 'https://crm.example.test', }, }) ).statusCode, 503, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-upload-postgres-live.test.js:626`: `assert.equal( ( await failedApi.inject({ method: 'POST', url: '/api/v1/conversations/upload-conversation/media', payload, headers: { 'content-type': 'multipart/form-data; boundary=b', 'idempotency-key': 'failed-production-auth-upload', cookie: 'crm_session=valid-synthetic-session; crm_csrf=valid-synthetic-csrf', origin: 'https://crm.example.test', 'x-csrf-token': 'valid-synthetic-csrf', }, }) ).statusCode, 503, );` | T8 MED-16: production identity/read/write composition distinguishes401/403/200/503 | Sim |
| `test/chat-media-status-routes.test.js:16`: `assert.equal(input.action, 'conversation.read');` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-status-routes.test.js:27`: `assert.equal(input.conversationId, 'conversation');` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-status-routes.test.js:28`: `assert.equal(input.mediaId, id);` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-status-routes.test.js:66`: `assert.equal(response.statusCode, 200);` | MED-08/19: authorized status ${state} has safe metadata | Sim |
| `test/chat-media-status-routes.test.js:67`: `assert.equal(response.json().state, state);` | MED-08/19: authorized status ${state} has safe metadata | Sim |
| `test/chat-media-status-routes.test.js:68`: `assert.equal(response.json().mediaId, id);` | MED-08/19: authorized status ${state} has safe metadata | Sim |
| `test/chat-media-status-routes.test.js:69`: `assert.equal(response.body.includes('object_key'), false);` | MED-08/19: authorized status ${state} has safe metadata | Sim |
| `test/chat-media-status-routes.test.js:70`: `assert.equal(response.body.includes('private-canary'), false);` | MED-08/19: authorized status ${state} has safe metadata | Sim |
| `test/chat-media-status-routes.test.js:71`: `assert.equal(response.headers['cache-control'], 'private, no-store');` | MED-08/19: authorized status ${state} has safe metadata | Sim |
| `test/chat-media-status-routes.test.js:79`: `assert.equal(response.statusCode, 200);` | MED-29: invalid_format is HTTP200 rejected status | Sim |
| `test/chat-media-status-routes.test.js:80`: `assert.equal(response.json().state, 'rejected');` | MED-29: invalid_format is HTTP200 rejected status | Sim |
| `test/chat-media-status-routes.test.js:81`: `assert.equal(response.json().reason, 'invalid_format');` | MED-29: invalid_format is HTTP200 rejected status | Sim |
| `test/chat-media-status-routes.test.js:86`: `assert.equal(response.statusCode, status);` | MED-16: status auth failure ${status} exposes no metadata | Sim |
| `test/chat-media-status-routes.test.js:87`: `assert.equal(response.body.includes('image/png'), false);` | MED-16: status auth failure ${status} exposes no metadata | Sim |
| `test/chat-media-status-routes.test.js:91`: `assert.equal((await get({ cookie: '' })).statusCode, 401);` | MED-16: status requires session and refuses technical authorization | Sim |
| `test/chat-media-status-routes.test.js:92`: `assert.equal( (await get({ authorization: 'Basic synthetic' })).statusCode, 403, );` | MED-16: status requires session and refuses technical authorization | Sim |
| `test/chat-media-status-routes.test.js:99`: `assert.equal(response.statusCode, 403);` | MED-08: draft of other actor is forbidden | Sim |
| `test/chat-media-status-routes.test.js:100`: `assert.equal(response.body.includes('private-canary'), false);` | MED-08: draft of other actor is forbidden | Sim |
| `test/chat-media-status-runtime.test.js:31`: `assert.ok(sql.includes('conversation_id=$2'));` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-status-runtime.test.js:32`: `assert.deepEqual(values, [id, 'conversation']);` | T7/T8 isolamento / quota / DTO autorizado | Sim |
| `test/chat-media-status-runtime.test.js:48`: `assert.deepEqual(await harness()(), { mediaId: id, kind: 'image', origin: 'attachment', state: 'ready', validationStatus: 'clean', mimeType: 'image/png', sizeBytes: 100, durationMs: null, });` | MED-08/20: author sees draft DTO with only safe metadata | Sim |
| `test/chat-media-status-runtime.test.js:61`: `await assert.rejects(get({ id: 'other', capabilities: [] }), { statusCode: 403, });` | MED-08: administrator can inspect draft but another seller cannot | Sim |
| `test/chat-media-status-runtime.test.js:64`: `assert.equal( (await get({ id: 'admin', capabilities: ['COMMERCIAL_ADMIN'] })).mediaId, id, );` | MED-08: administrator can inspect draft but another seller cannot | Sim |
| `test/chat-media-status-runtime.test.js:76`: `assert.equal(dto.state, state);` | MED-16: attached and lost attached use authorized conversation read ACL | Sim |
| `test/chat-media-status-runtime.test.js:77`: `assert.equal(dto.mediaId, id);` | MED-16: attached and lost attached use authorized conversation read ACL | Sim |
| `test/chat-media-status-runtime.test.js:78`: `assert.equal(JSON.stringify(dto).includes('secret-key'), false);` | MED-16: attached and lost attached use authorized conversation read ACL | Sim |
| `test/chat-media-status-runtime.test.js:89`: `assert.equal(dto.state, 'rejected');` | MED-29: rejected real format remains 200 DTO state/reason, no key or name | Sim |
| `test/chat-media-status-runtime.test.js:90`: `assert.equal(dto.reason, 'invalid_format');` | MED-29: rejected real format remains 200 DTO state/reason, no key or name | Sim |
| `test/chat-media-status-runtime.test.js:91`: `assert.equal(dto.sizeBytes, null);` | MED-29: rejected real format remains 200 DTO state/reason, no key or name | Sim |
| `test/chat-media-status-runtime.test.js:92`: `assert.equal(JSON.stringify(dto).includes('secret-filename'), false);` | MED-29: rejected real format remains 200 DTO state/reason, no key or name | Sim |
| `test/chat-media-status-runtime.test.js:95`: `assert.throws( () => requireMediaSpoolRoot({ CHAT_MEDIA_SPOOL_ROOT: 'var/private/../private', PRIVATE_MEDIA_ROOT: 'var/private', }), /distinct CHAT_MEDIA_SPOOL_ROOT/u, );` | MED-20 support: configured spool cannot resolve to the legacy media root | Sim |
| `test/chat-media-status-runtime.test.js:104`: `assert.throws( () => requireMediaSpoolRoot({ CHAT_MEDIA_SPOOL_ROOT: 'VAR\\PRIVATE', PRIVATE_MEDIA_ROOT: 'var/private', }), /distinct CHAT_MEDIA_SPOOL_ROOT/u, );` | MED-20 support: configured spool cannot resolve to the legacy media root | Sim |
| `test/chat-media-status-runtime.test.js:112`: `assert.ok( requireMediaSpoolRoot({ CHAT_MEDIA_SPOOL_ROOT: 'var/chat-spool', PRIVATE_MEDIA_ROOT: 'var/private', }).endsWith('chat-spool'), );` | MED-20 support: configured spool cannot resolve to the legacy media root | Sim |
| `test/chat-media-status-runtime.test.js:134`: `await assert.rejects( identity.authorizeOperationalRead({ action: 'conversation.read', sessionToken: 'invalid', authenticationFailureStatus: 401, }), { statusCode: 401, code: 'INVALID_CREDENTIALS' }, );` | MED-16: opted-in read distinguishes invalid session401, capability403 and DB failure | Sim |
| `test/chat-media-status-runtime.test.js:142`: `await assert.rejects( identity.authorizeOperationalRead({ action: 'conversation.read', sessionToken: 'invalid', }), { statusCode: 403 }, );` | MED-16: opted-in read distinguishes invalid session401, capability403 and DB failure | Sim |
| `test/chat-media-status-runtime.test.js:149`: `await assert.rejects( identity.authorizeOperationalRead({ action: 'forbidden.action', sessionToken: 'invalid', authenticationFailureStatus: 401, }), { statusCode: 403 }, );` | MED-16: opted-in read distinguishes invalid session401, capability403 and DB failure | Sim |
| `test/chat-media-status-runtime.test.js:170`: `await assert.rejects( unavailable.authorizeOperationalRead({ action: 'conversation.read', sessionToken: 'invalid', authenticationFailureStatus: 401, }), (error) => error === failure, );` | MED-16: opted-in read distinguishes invalid session401, capability403 and DB failure | Sim |
