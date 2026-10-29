# Imagens recebidas na Inbox

## Ampliar e baixar — INBOX-IMG-VIEW-01 (30/10/2026)

Clique na foto ou use Enter/Espaço em **Ampliar imagem**. A visualização maior
oferece **Fechar imagem** e **Baixar imagem**; Escape fecha e devolve o foco
à foto. **Baixar imagem** também está disponível diretamente na conversa,
mesmo sem pedido editável. O arquivo conserva os bytes originais e recebe
nome sintético com a extensão do MIME validado. Não altera a retenção.

Expiração, falta de permissão e falha de leitura mostram aviso e permitem
tentar novamente; uma resposta de erro não é salva como imagem. Ao trocar
ou sair da conversa, downloads ainda pendentes são cancelados. A perda do
arquivo fecha a ampliação e direciona o foco ao aviso do histórico.

Depois do deploy do frontend, conferir com imagem sintética disponível:
abrir por teclado, fechar por Escape, baixar de ambos os locais, comparar
SHA256 e verificar **Anexar ao pedido**. Rollback: restaurar a revisão
anterior do edge; não exige alteração da API, banco, storage ou workflow.
Testes locais não comprovam essa conferência em produção.

## INBOX-IMG-RELEASE-03 — implantação solicitada em 29/10/2026

Release preparado sobre `a94b5be` e atualizado sobre a revisão publicada
`83560c0` antes da integração, com CP-T09, layout e migrações preservados. Não implantar a branch Evolution divergente inteira. A autorização
do proprietário inclui implantar e testar a ação direta da imagem para o pedido.

O botão **Anexar ao pedido** exige escolha explícita de pedido pendente
vinculado à conversa, pessoa responsável ou administrador e conversa aberta.
Usa a leitura privada e o upload existente da arte, com CSRF e chave estável
em retry. A ação não envia WhatsApp. Após sucesso, abrir o pedido e baixar o
arquivo em **Arte do pedido → Arquivos da arte**, comparando os bytes/SHA256.

Imagens JPEG, PNG, WebP e GIF de até cinco MB usam o mesmo pipeline, inclusive
as enviadas como documento. O scanner e a detecção do conteúdo continuam
obrigatórios; documentos mantêm o tipo histórico. A cópia ao pedido preserva
o limite de cinco referências e dez MB por arquivo. Nenhuma URL do provedor
ou caminho de disco é exposto. Arquivo ausente, inválido ou expirado gera aviso.
Documentos antigos sem MIME nem anexo não permitem inferir se eram imagens.

`ops/n8n/patch-evolution-inbound-images.mjs` prepara somente o filtro da Inbox,
decoder, medição GIF, prioridade do filtro e continuação após erro do relatório.
Exige export Evolution compatível, scheduler v1, cadeia e credenciais já
vinculadas. Preserva a condição e o decoder existentes para áudio, inclusive
o suporte publicado em paralelo por INBOX-AUDIO-01; acrescenta somente o caso
raster. Não altera os caminhos de IA/envio, o tipo da mensagem ou conexões.
O scheduler ordena destinos por `(y,x)`; a imagem passa primeiro para que uma
falha posterior de IA não suprima a persistência. Trata-se de execução sequencial:
timeouts e retries de mídia podem atrasar o caminho comercial e o recibo.
Guardar export/revisão anterior, comparar cada delta e publicar pelo editor;
não importar o principal ativo pela CLI, que pode desativar os webhooks.

Histórico desta sessão: dezoito imagens antigas foram recuperadas com autorização
e conferidas na Inbox; quatro foram copiadas pelo upload existente ao pedido
21-CRM e tiveram existência/tamanho/hash conferidos no RustFS. Isso não substitui
a prova do novo botão nem de uma nova imagem do canal. O export imediatamente
anterior ao release foi `15d9ba9a-77e8-429b-bd43-e6dc2349ec5f`, com 110 nós
e o suporte INBOX-AUDIO-01 preservado.

Preparação local: gate `validate` aprovado com 1.436 testes, cinco skips e zero
falhas, incluindo tipos, lint, fronteiras e build; 36 E2E de interface aprovados
e cinco testes do patch offline (estes últimos integram a contagem do gate).
CI passou a executar também o teste PostgreSQL dedicado de mídia recebida.

### Implantação e prova operacional — 29/10/2026

PR [#240](https://github.com/romulosutil/crm-silmer/pull/240) integrada; API e
edge publicados na revisão `ad3001f52a6d14048f58125f3ee0ae33f95c567c`.
CI da PR e da revisão de produção aprovados, incluindo PostgreSQL dedicado,
358 E2E aprovados e sete skips. O patch offline terminou com seis testes.
Containers saudáveis, `/api/health/live` e `/api/health/ready` com HTTP 200;
source, env, mounts, portas, build e deploy preservados.

Docker ImageIDs observados (não são RepoDigests do registry):

| Serviço | Publicado                                                                 | Anterior, revisão `83560c0`                                               |
| ------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| API     | `sha256:002395b8da4e9bf140dc625a137a81e1d0c15b6f7967842ffba855451cbebd74` | `sha256:9b54b165c2f2d0644ec4c6e608d042719410c77d9e9deb260278a5747573e023` |
| edge    | `sha256:866c81b80a66c1f2fa5149307def6c8c213d46addfa304c69f1b2d07cc1f1cc9` | `sha256:7718f5156d3dba424816dec91ff781161c8fc5d8e56f137e57ccd795c5f8b02c` |

n8n publicado pelo editor na revisão `8cd3ccf7-95e0-485c-bc38-34b65c2bc02c`,
ativo, com 110 nós. Comparação com o export anterior confirmou somente quatro
nós alterados; IDs, credenciais, conexões, settings e ramo de áudio preservados.
Filtro de imagem em `(0,-976)`, antes de recibo e comercial no scheduler v1.
Arquivo temporário de autenticação removido após o teste. Rollback preparado:
retornar primeiro à revisão n8n anterior preservada e restaurar ambos os serviços
na revisão `83560c0`, sem alterar configurações; não foi necessário executá-lo.

Prova autorizada com quatro imagens sintéticas 20×20, JPEG/PNG como `image` e
WebP/GIF como `document`: quatro entradas HTTP 200 e quatro anexos HTTP 201.
As quatro miniaturas carregaram na Inbox. Pelo novo botão, cada arquivo foi
anexado ao pedido pendente **28-CRM**, do contato **Teste de anexos — sintético**.
Repetir o primeiro clique manteve quatro referências. Leitura dos quatro objetos
RustFS confirmou existência, tamanho, hash armazenado e SHA256 dos bytes originais.
Consulta somente leitura confirmou zero comandos e zero mensagens de saída.
O pedido permanece pendente, identificado como teste, para conferência.

Um workflow separado, manual e inativo, `SilmerImageRelease240`, executou os nós
reais de decoder, SHA256 e multipart contra os mesmos quatro anexos sintéticos:
quatro replays idempotentes, sem duplicação, IA ou WhatsApp. Ele usa resposta
sintética do gateway; não comprova um novo evento real do provedor WhatsApp após
a publicação. Não foi ativado, não possui webhook público nem caminho de envio.

A garantia de exibição cobre JPEG/PNG/WebP/GIF válidos até cinco MB, inclusive
como documento, após scanner e dentro da retenção. Arquivo indisponível é
sinalizado na Inbox. Não implica recuperar bytes expirados ou renderizar todo
formato arbitrário como imagem.

## INBOX-IMG-EVOL-02 — correção publicada em 29/10/2026

O corpo JSON da consulta de mídia Evolution continha `}}` dentro da
expressão. O parser do n8n encerrava o trecho nesse ponto e recusava o
parâmetro com `invalid syntax`, antes da chamada HTTP. O teste anterior
avaliava o JavaScript removendo somente os delimitadores externos e não
detectava esse truncamento. A consulta de identidade apresentava o mesmo
defeito.

O gerador agora usa objetos entre parênteses e espaços entre fechamentos
internos. O principal publicado recebeu a correção em três `jsonBody`:
consulta de mídia da IA, consulta da Inbox e resolução de identidade.
A versão `4581279c-3960-4ee9-af83-9923bc360727` foi publicada como
**INBOX-IMG-EVOL-02 · Corrigir sintaxe de mídia**. A leitura do export
confirmou `active=true`, revisão atual igual à publicada e os 110 nós.

Gate final `npm run validate` aprovado: 1.426 testes, 1.421 aprovados,
cinco skips, zero falhas, tipos, lint e build. A regressão cobre os dois
corpos antigos inválidos e os três corpos gerados com a fronteira do parser.

A comparação preservou IDs de nós, credenciais, conexões e settings.
O editor omitiu defaults explícitos (`json`, `runOnceForAllItems` e
`disabled=false`) e alinhou coordenadas à grade. A comparação normalizada
confirmou somente os três corpos como delta funcional; a ordem `(y,x)` dos
destinos de todos os fanouts permaneceu igual. A versão publicada anterior
`48c1bc53-a57c-4d08-8550-04df116a49dd` continua disponível para rollback.

Um workflow manual isolado, inativo e sem nós de IA ou envio reproduziu
o erro no HTTP original. Com somente o corpo corrigido, passou por download,
decodificação, tamanho, hash, multipart e upload, com replay de uma imagem
já recuperada. Dados de execução manual/sucesso/erro não foram persistidos.
O diagnóstico permanece inativo; as cópias temporárias de credenciais
decriptadas foram removidas. Nenhuma credencial do serviço foi alterada.

Recuperação pontual autorizada: dez imagens em duas conversas (quatro e
seis) foram vinculadas às mensagens originais pelo endpoint de anexos,
com scanner, hash, retenção original e idempotência. As dez imagens foram
observadas carregadas na Inbox. Quatro originais foram enviados pelo botão
existente de arquivos ao pedido 21-CRM; a interface confirmou **4 de 5**, e
a leitura dos quatro objetos RustFS confirmou existência, tamanho e SHA256.
Não houve reexecução de IA, confirmação comercial ou envio de WhatsApp.

Após autorização específica adicional do proprietário, as oito imagens
restantes em duas outras conversas também foram recuperadas: seis e duas
respostas `201`, com vínculo às mensagens originais e sem duplicatas.
A conferência na Inbox selecionou somente imagens recebidas e confirmou
**6/6** e **2/2** carregadas (`complete` e `naturalWidth > 0`), além de uma
imagem enviada pelo vendedor que já existia na primeira conversa.
O total recuperado nesta operação chegou a dezoito imagens em quatro
conversas. O identificador de uma conversa e uma impressão digital tinham
erro de transcrição; foram conferidos por consulta somente leitura aos
registros canônicos antes da gravação. Todas as correspondências foram
validadas antes do primeiro upload. As cópias temporárias de credenciais
foram removidas no encerramento, inclusive nas tentativas sem correspondência.
Não houve IA, envio de WhatsApp ou alteração comercial nessa recuperação.

O teste de POST sem autenticação ao webhook foi recusado pela revisão
automática; a verificação de publicação usou somente leitura. Não declarar um novo
evento de canal homologado com o replay isolado. A próxima imagem recebida
deve ser observada para concluir esse gate. Não houve deploy do CRM nesta
operação: o atalho novo da imagem para o pedido ainda não estava implantado
(entrou depois em INBOX-IMG-RELEASE-03, acima); o upload
existente foi o controle usado na comprovação operacional.

INBOX-IMG-01: INBOX-2/3, INB-01..05, MSG-01/02 e PRV-03.
Critérios em [spec](../../.specs/features/inbound-media-inbox/spec.md).

## Diagnóstico de 28/10/2026

A Inbox publicada exibia duas mensagens como `Imagem`, sem elemento `img`.
A leitura consultava apenas `crm.chat_media`, usado pela mídia enviada pelo
vendedor. O contrato de entrada registra o tipo e a referência da imagem,
mas o arquivo precisa ser enviado separadamente ao endpoint de anexos.

O operador confirmou WAHA como transporte temporário. A inspeção de leitura
do n8n mostrou adaptação de identidade e URLs privadas do WAHA no workflow
implantado. O snapshot Meta versionado não representa essa implantação.
Não substituir o workflow vivo pelo snapshot. A lista de execuções estava
vazia; isso não prova perda dos arquivos no WAHA.

A inspeção somente leitura da API implantada confirmou UID/GID `1000:1000`,
`PRIVATE_MEDIA_ROOT=/tmp/crm-silmer-media` e
`CHAT_MEDIA_SPOOL_ROOT=/var/lib/crm-chat-media`. O diretório transitório,
`/tmp/crm-clamd/clamd.sock` e `/var/lib/clamav/.freshclam-verified` estavam
ausentes. A tela Storage da API e do worker exibia somente o bind do spool
de chat em `/var/lib/crm-chat-media`. Isso bloqueia a ativação do upload
legado; não foi alterado nenhum mount ou serviço durante a inspeção.

No worker, o socket e o marcador existiam, ambos com modo `0600`, sob o
mesmo UID/GID `1000:1000`; o spool tinha modo `0700`. Uma consulta SQL com
sessão `default_transaction_read_only=on` confirmou duas mensagens de imagem
e zero mensagens com anexo vinculado na conversa afetada. Foram retornadas
somente contagens, sem conteúdo, identificadores de mídia ou credenciais.

## Correção preparada

A API projeta anexos transitórios vinculados à mensagem como mídia da Inbox.
A mesma rota privada `/api/v1/conversations/:id/media/:mediaId/content`
entrega os bytes após sessão/capacidade, vínculo, validação, retenção e
integridade. O componente existente renderiza a imagem. URLs do provedor e
caminhos do volume ficam fora do DTO da interface.

O patch offline acrescenta um ramo independente ao workflow WAHA exportado.
Ele preserva os nós e as conexões de atendimento, baixa imagens JPEG/PNG/WebP
da origem já validada pelo adaptador, calcula SHA256 e usa o endpoint
autenticado de anexos. Também funciona no modo humano. Replay conserva a
identidade da mensagem e a chave idempotente. Erros geram `workflow.failed`
com código fixo, sem conteúdo ou detalhes de credencial.

Falhas transitórias conhecidas permitem nova tentativa com inspeção obrigatória.
Quarentena por assinaturas antigas reutiliza e revalida a mesma cópia; não
libera o arquivo nem consome outra quota enquanto o scanner não aprovar.
`rejected`, `deleted` e `lost` permanecem bloqueados. O ingresso serializa
snapshot, scan e vínculo por mensagem na instância atual da API. Esse controle
pressupõe o piloto com um processo de API; antes de escalar réplicas ou
processos, implementar coordenação durável equivalente e testar a concorrência
entre instâncias. A fila de arquivos isoladamente não protege esse fluxo.

```powershell
node ops/n8n/patch-waha-inbound-images.mjs <export-atual.json> <patch-revisao.json>
```

O comando somente lê e escreve arquivos locais. A saída exige arquivo novo.
Não importa, publica, executa ou ativa o workflow. Exportação e resultado
podem conter credenciais embutidas no workflow original: mantenha ambos em
diretório privado ignorado pelo Git; não anexe ao PR ou a logs. O script
rejeita adaptador Meta, nomes ambíguos e aplicação repetida do patch.
Aceita a URL HTTPS literal ou a expressão constante de duas strings JSON
concatenadas observada no inbound atual; não executa código da exportação e
rejeita URLs dependentes de variáveis. A URL do nó antigo permanece intacta.

## Aplicação controlada, pendente

Plano de mounts para revisão, sem aplicação: a origem base é o bind privado
já existente, `/etc/easypanel/projects/espectro-mvp/silmer-chat-spool-init/volumes/chat-media-spool`.
Os subdiretórios abaixo devem nascer pelo worker atual, UID/GID `1000:1000`,
com modo `0700`, antes de configurar os binds. Copiar as definições ClamAV
atuais para `inbound-signatures` antes de cobrir `/var/lib/clamav` com o mount;
o diretório vazio ocultaria as definições da imagem. O processo de atualização
vigente continua responsável por publicar freshness após confirmar o motor.

| Serviço | Subdiretório da origem base | Destino                 | Acesso                                     |
| ------- | --------------------------- | ----------------------- | ------------------------------------------ |
| API     | `inbound-media`             | `/tmp/crm-silmer-media` | leitura/escrita                            |
| worker  | `inbound-media`             | `/tmp/crm-silmer-media` | leitura/escrita, retenção                  |
| API     | `inbound-scanner-socket`    | `/tmp/crm-clamd`        | leitura/escrita; conexão ao socket privado |
| worker  | `inbound-scanner-socket`    | `/tmp/crm-clamd`        | leitura/escrita                            |
| API     | `inbound-signatures`        | `/var/lib/clamav`       | leitura/escrita                            |
| worker  | `inbound-signatures`        | `/var/lib/clamav`       | leitura/escrita                            |

O EasyPanel 2.38 inspecionado oferece apenas origem e destino para binds,
sem opção de somente leitura. Além disso, a API já monta a origem completa
do spool com escrita: aliases somente leitura não isolariam os mesmos
arquivos acessíveis por `/var/lib/crm-chat-media/inbound-*`. API e worker
compartilham UID 1000; `0700`/`0600` restringem outros usuários, mas não
protegem esses arquivos contra um processo de API comprometido. Não alegar
isolamento entre esses dois serviços nem adicionar privilégios ou TCP.

Conservar o mount atual do spool e os modos `0600` do socket/marcador, sem
chmod/chown recursivo no spool. O painel pode reaplicar `0777` no diretório
raiz de um bind: os comandos de partida devem conferir UID/GID `1000:1000`
e restaurar `0700` em cada diretório específico antes de iniciar o processo;
confirmar novamente depois do deploy. Testar `fdpass` com uma imagem sintética a
partir da API; sem essa prova, não ativar o workflow de anexos. Uma cópia
com o worker ativo é apenas preparação: exigir ausência de freshclam e
igualdade dos hashes, metadados e marcador antes/depois. Rejeitar qualquer
divergência. Após montar, exigir atualização confirmada pelo próprio worker,
marcador posterior ao reinício e scan real antes de aceitar anexos.

O worker usa uma réplica e tinha Zero Downtime marcado. Desmarcar esse
modo para impedir sobreposição de daemons no socket compartilhado. Antes do
merge, controlar o autodeploy durante a troca; restaurar a política após
validar a revisão implantada. Verificar filas sem jobs em processamento e
shutdown gracioso. Health/PING sozinho não comprova frescor nem scan.
Preparar/reiniciar primeiro o worker e confirmar seu health antes de implantar
a API. Os diretórios são exclusivos desta mídia e não substituem o spool ou
os buckets existentes. Esse plano precisa de validação operacional antes da
execução; não é evidência de provisionamento ou de recovery remoto.

1. Registrar a revisão atual do CRM e exportar a versão ativa do n8n em
   armazenamento privado. Confirmar que o webhook e as credenciais WAHA
   continuam os mesmos. Gerar o patch dessa exportação atual.
2. Verificar na API o volume transitório e o scanner reais. O scanner usa
   `clamdscan --fdpass`, o socket privado e o marcador de assinaturas. O
   daemon reside no worker. O compose local não compartilha o socket com a
   API; não presumir que o painel remoto o disponibiliza. Sem scan limpo,
   o upload deve permanecer bloqueado. Não desativar antivírus para ativar
   esta correção. Qualquer ajuste de mounts exige revisão operacional própria.
   Preparar um diretório privado persistente para o volume transitório e
   compartilhar apenas o socket e as assinaturas do daemon existente com a
   API, sob o mesmo UID e sem expor TCP. Conferir os diretórios no worker antes
   de escolher os binds; preservar os arquivos de chat já existentes. Não
   implantar o workflow enquanto esses recursos estiverem ausentes.
3. Implantar primeiro o CRM compatível. Confirmar readiness e a leitura de
   mídia do vendedor. Não há migration nova neste patch.
4. Revisar o diff do workflow: nós antigos e seus parâmetros intactos,
   somente um ramo novo de persistência ligado ao inbound. Testar uma imagem
   sintética com o fluxo comercial isolado. Validar bytes, hash, ACL, replay
   e uma mensagem em modo humano. Conferir timeout, URL e redirects fechados.
5. Publicar a alteração somente após autorização do operador e com a revisão
   anterior disponível para rollback. Confirmar que uma nova imagem aparece
   como imagem na Inbox, sem novos envios ou handoffs indevidos.

## Recuperação pontual dos anexos anteriores

Consultar somente as mensagens afetadas, usando os IDs canônicos do CRM e
a identidade de chat verificada pelo adaptador. A documentação do WAHA prevê
`GET /api/{session}/chats/{chatId}/messages/{messageId}?downloadMedia=true`
para consultar uma mensagem e obter sua mídia, quando disponível
([fonte oficial](https://waha.devlike.pro/docs/how-to/chats/#get-message-by-id)).
Usar a credencial WAHA existente em ambiente privado; não publicar o serviço
nem levar essa credencial ao navegador do CRM.

Baixar a URL privada validada e enviar exclusivamente os bytes ao endpoint
de anexos, com `external_id` da mensagem original, MIME, SHA256 e chave
idempotente estável. Não reenviar o webhook de entrada, executar o workflow
comercial, reservar envio ou mandar mensagem à cliente. O upload mantém o
prazo a partir do recebimento original e rejeita jornada encerrada ou prazo
vencido. Se o arquivo já não existe no provedor, registrar indisponibilidade;
o texto da mensagem não permite reconstruir a imagem.

Após recuperar, confirmar na conversa original que ambas as imagens carregam
e verificar que mensagens, revisão comercial e atendimentos não foram
duplicados. Recuperação e exibição reais continuam sem evidência até executar
esse procedimento autorizado em produção.

## Rollback

Restaurar a revisão anterior do workflow, sem replay de eventos ou envios.
Preservar os anexos já vinculados e seus prazos de retenção. O rollback da
interface/API pode voltar a mostrar a descrição textual; não apagar registros
nem restaurar o banco para desfazer uma mudança de exibição.
