# Imagens recebidas na Inbox

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

| Serviço | Subdiretório da origem base | Destino | Acesso |
| --- | --- | --- | --- |
| API | `inbound-media` | `/tmp/crm-silmer-media` | leitura/escrita |
| worker | `inbound-media` | `/tmp/crm-silmer-media` | leitura/escrita, retenção |
| API | `inbound-scanner-socket` | `/tmp/crm-clamd` | leitura/escrita; conexão ao socket privado |
| worker | `inbound-scanner-socket` | `/tmp/crm-clamd` | leitura/escrita |
| API | `inbound-signatures` | `/var/lib/clamav` | leitura/escrita |
| worker | `inbound-signatures` | `/var/lib/clamav` | leitura/escrita |

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
