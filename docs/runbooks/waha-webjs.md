# WAHA com WEBJS — piloto da Inbox Silmer

Atualização: 29/10/2026, America/Sao_Paulo.
Decisão: [ADR 043](../adr/043-piloto-whatsapp-waha-webjs.md) e
[RFC 031](../rfc/031-piloto-whatsapp-waha-webjs.md).
Rastreabilidade: WAHA-01, INBOX-2/3, AGENTE-6, OPS-1, INT-1/2;
[ORC-01..08, INB-01 e MSG-01..04](../../.specs/features/crm-mvp/spec.md).

## Estado e escopo

O proprietário autorizou instalar WAHA com WEBJS no EasyPanel e conectar a
linha temporária ao n8n e à Inbox, preservando a integração existente.
As evidências observadas estão registradas abaixo. A criação do serviço e os
testes do adapter não comprovam sessão conectada, tráfego real, mídia homologada
ou recuperação.

Estado atual em 29/10: canal desconectado, em `SCAN_QR_CODE`, sem identidade
autenticada. A correção pontual da renovação do QR foi implantada e verificada,
mas a tentativa real posterior ainda falhou. WAHA-01F permanece aberta.
A prova de texto nos dois sentidos de 28/10 é histórica; não comprova a
recuperação atual. O registro mais recente ao final deste runbook prevalece
sobre os estados históricos de preparação abaixo.

O número e a identidade da conta esperada ficam na configuração privada do
ambiente. Não registrar telefone real, chave de API, QR code, código de
pareamento, credenciais n8n ou conteúdo de cliente neste documento.

WAHA é o transporte. Toda mutação oficial continua passando pela API do CRM;
o gateway não acessa PostgreSQL do CRM nem substitui IA, pedidos ou handoff.
O chat do site e o checkout da loja conservam seus contratos e webhooks.

## Evidência operacional em 27/10/2026

- O workflow original `k7tI6T4RhQPyJkn9` permaneceu publicado e preservado.
  A cópia `lwjMll33Beg2HQyU`, criada antes da alteração de transporte, permanece
  sem publicação. Uma cópia adicional do workflow foi salva por CLI no servidor,
  em `/home/node/.n8n/waha-pilot/before.json`, com acesso protegido. Esse backup
  não é exportação de credenciais nem de execuções.
- O serviço `schedule/silmer-waha` foi criado no EasyPanel e teve container
  iniciado. A imagem selecionada é
  `devlikeapro/waha:chrome-2026.9.2@sha256:d4c2b1da8373fa48c5022aa947c95a87480cf6e26a9d3c9b59721f96b044d223`,
  com engine WEBJS, volumes persistentes privados em `/app/.sessions` e
  `/app/.media`, limite de 1 CPU e 1536 MB. Não há domínio ou porta publicada.
- Foi configurada a chave da API em formato SHA-512 no gateway. Dashboard e
  Swagger estão desativados; logs estão limitados a erros e não imprimem QR code.
  Duas credenciais `httpHeaderAuth` exclusivas foram importadas no n8n e
  confirmadas, separando acesso à API do gateway e autenticação do webhook.
  `GET /api/sessions`, executado a partir do container n8n, retornou `401` sem
  chave e `200` com autenticação. A consulta listou zero sessões: nenhuma conta
  está pareada.
- O webhook foi configurado para o HTTPS já existente do n8n, no caminho
  `/webhook/silmer/waha-events`, com header de autenticação privado. O endereço
  interno com underscore foi recusado pelo validador de URL do WAHA; o destino
  do webhook foi corrigido para o HTTPS do n8n. Isso não comprova entrega real.
- O adapter passou em 14 testes focados e em 24 testes de contrato existentes,
  totalizando 38 aprovados, com revisão QA. A execução final de
  `npm run validate` passou fora do sandbox, incluindo build: 1.114 testes,
  1.111 aprovados, três ignorados e nenhuma falha. Os testes não substituem
  homologação do canal real.
- A configuração candidata não usa parâmetros `$env`; o bloqueio de acesso a
  variáveis de ambiente nos nós foi preservado. Após o redeploy, foi confirmado
  um novo container n8n em execução com imagem `2.43.7`, proteção SSRF habilitada
  e exceção de hostname restrita exatamente a `schedule_silmer-waha` no processo.
  A consulta autenticada de sessões acima confirmou o acesso interno ao gateway.
  Após esse redeploy, a UI continuou exibindo o workflow original como `Published`.
- A importação CLI de `WahaSilmerPilot01` foi concluída, com 93 nós. A UI exibiu
  `Silmer | Atendimento WAHA WEBJS (preparado)` e o botão `Publish`, confirmando
  que o candidato permanece inativo. Não foi registrado webhook de produção
  para ele e não houve cutover.
- Em modo de teste do webhook genérico do candidato, um evento sintético
  `session.status` com status `STOPPED`, sem identidade da conta ou PII, foi
  executado com sucesso na UI. A chamada sem autenticação retornou `403`; a
  autenticada retornou `200`. A guarda ignorou o evento, sem chamar CRM, IA
  ou envio WhatsApp. Isso verifica somente autenticação e transporte no-op em
  modo de teste; o `200` genérico não é confirmação de aceite de domínio nem
  demonstra resposta ou entrega no canal real.
- O proprietário informou que a linha temporária ainda não foi ativada no
  WhatsApp do celular. Registro no aplicativo, QR code, identidade da conta,
  teste ponta a ponta e cutover permanecem pendentes. Não iniciar o atendimento
  ou declarar a linha conectada com base na instalação do gateway.

## Evidência operacional em 28/10/2026

O proprietário informou ter ativado o WhatsApp no celular, escaneado o QR code
exibido pelo fluxo de pareamento no n8n e observado sucesso. A consulta seguinte
`GET /api/sessions/default` retornou HTTP `200`, mas a sessão estava em `FAILED`,
com `paired: false` e sem `me`. Portanto, o relato de sucesso no celular não foi
confirmado pela identidade da conta no gateway.

Uma retomada controlada, preservando o volume da sessão, voltou ao estado
`SCAN_QR_CODE`, ainda sem identidade confirmada. Não houve publicação do
candidato WAHA nem cutover. O workflow principal atual foi preservado e um
export adicional foi salvo em arquivo protegido
`before-cutover-20261028.json`, sem exportar credenciais ou execuções.

A sessão está configurada com identificação de cliente Silmer CRM/Chrome,
`ignore.groups`, `ignore.status` e `ignore.channels` habilitados, além de
`webjs.tagsEventsOn=true`. O cgroup observado mantém limite de memória de
1536 MiB, com contadores `oom=0` e `oom_kill=0`; o volume existe. Esses sinais
não determinam a causa de `FAILED`, não comprovam falha de memória e não
explicam eventual bloqueio da conta. Não apagar ou recriar o volume por tentativa.

### Bloqueio da conta e suspensão do serviço

Posteriormente, o proprietário enviou foto do WhatsApp Business mostrando
“Esta conta não pode usar o WhatsApp”, com referência a 28/10 e o botão
“Pedir análise”. A tela comprova o bloqueio apresentado pelo aplicativo; não
informa sua causa. Não atribuir o bloqueio ao WAHA, ao pareamento, à memória
ou a outro componente sem evidência específica, nem prometer resultado da análise.

As tentativas foram interrompidas. `POST /api/sessions/default/stop` retornou
HTTP `201`; a consulta seguinte confirmou `STOPPED` e `paired: false`.
Em seguida, `stopAppService` para `schedule/silmer-waha` pelo conector EasyPanel
confirmou sucesso. A consulta de containers retornou lista vazia para o serviço,
e a UI exibiu o botão `Start` com memória de `0.0 B`, confirmando a suspensão.
Volumes, sessão e backups foram preservados. Não houve conexão de outra conta,
nova publicação WAHA ou cutover. O artefato local temporário do QR code foi
removido; a foto do aplicativo enviada pelo proprietário não foi copiada para
o repositório.

O bloqueio é um impedimento externo à conclusão de WAHA-01D. A disponibilidade
do botão “Pedir análise” não significa pedido enviado ou conta liberada.
Enquanto o bloqueio persistir, manter o gateway suspenso e não repetir
pareamentos, criar sessões substitutas ou reenviar mensagens por tentativa.

### Correções do candidato e limites das evidências

A fonte publicada do workflow principal evoluiu desde 27/10, incluindo
encaminhamento do site para WhatsApp, jornada e notas. O candidato foi regenerado
e importado a partir da fonte atual de 92 nós, versão
`91eaff25-87f6-4f13-9a27-382fcd958abe`, com 101 nós no resultado. Os IDs do
workflow principal e dos webhooks do site e as notas foram preservados; o
candidato permanece inativo, com `errorWorkflow` apontando para ele próprio.
Não substituir essa fonte pelo export de ontem em uma futura retomada.

Foram concluídas no adapter:

- Ignorar `message.ack` com valor `1`; conservar a confirmação síncrona do
  envio como responsável pelo registro de `sent`, evitando recibo concorrente.
- Usar o timestamp do envelope do ACK para o instante do recibo, em vez do
  horário original da mensagem presente no payload.
- Responder ao webhook WAHA somente após a gravação durável pelo CRM, com
  filtro que exclui a entrada do site dessa resposta.
- Preservar o tratamento de erro existente e configurar o vínculo ao próprio
  workflow quando aplicável, mantendo os dados de falha sanitizados e sem
  salvar conteúdo de execução.

As correções passaram em 18 testes focados. A execução de `npm run validate`
passou com checks e build: 1.168 testes, 1.165 aprovados, três ignorados e
nenhuma falha. Esses testes locais não comprovam WhatsApp real.

No candidato atualizado, o smoke remoto em modo de teste retornou `403` sem
autenticação e `200` para um evento autenticado de status ignorado, sem chamar
CRM, IA ou envio. Isso comprova apenas autenticação e transporte no-op em TEST.
As provas remotas de falha na resolução de `@lid`, resposta durável `202`
após CRM e reentrega continuam pendentes devido à suspensão do canal. O `200`
do evento ignorado não substitui essas provas. Pareamento, identidade da conta
e testes WhatsApp ponta a ponta não foram concluídos; WAHA-01D permanece aberta.

## WAHA-01 — sequência de execução

- [x] WAHA-01A — preservar workflow anterior e registrar versão/identificador
      do backup, sem exportar credenciais ou dados de execução.
- [x] WAHA-01B — instalar o serviço WEBJS com imagem identificada, volume
      privado persistente, autenticação, limites e isolamento de rede. Instalação,
      acesso interno e recusa sem chave verificados. A conta anterior bloqueada
      continua sem uso; a nova conta tem identidade confirmada em `WORKING`.
- [x] WAHA-01C — preparar e testar o adapter de eventos, identidade, envios e
      confirmações mantendo reservas, epoch, revisão, correlação e ACKs do CRM.
      Correções de ACK de 28/10 passaram em 18 testes focados; candidato de
      101 nós regenerado da fonte atual e importado inativo. Smoke remoto
      autenticado no-op em TEST passou; falha `@lid`, resposta durável `202`,
      reentrega e mídia continuam sem prova remota. A prova posterior de texto
      real e a correção E.164 estão registradas ao final deste runbook.
- [x] WAHA-01D (texto operacional) — recebimento real, persistência na Inbox,
      transferência, takeover e resposta humana entregue uma vez verificados.
      Nova linha pareada com identidade confirmada em
      `WORKING`; principal publicado no mesmo ID com 101 nós. Volumes da conta
      anterior bloqueada e backups preservados, sem uso daquela conta. Prova
      real registrada na seção final, sem versionar conteúdo ou captura.
- [ ] WAHA-01D (homologação restante) — mídia, matriz de status/falhas,
      reentrega e reinício/reconexão ainda pendentes. Instalação, publicação,
      texto bem-sucedido e no-op HTTP não homologam esses cenários.
- [x] WAHA-01E — registrar evidências sanitizadas, limites de mídia e recovery,
      atualizar fontes canônicas, executar checks, commit e push da entrega.
      A entrega inclui texto real de ida e volta; a homologação restante
      permanece explicitamente aberta em WAHA-01D.

## Instalação no EasyPanel

1. Inspecionar os serviços existentes antes de criar outro. Usar um gateway
   dedicado ao piloto, sem alterar serviços e credenciais de terceiros.
   Selecionar uma versão oficial do WAHA com WEBJS e registrar o digest
   observado. Não considerar `latest` uma identificação reproduzível.
2. Configurar `WHATSAPP_DEFAULT_ENGINE=WEBJS`. Persistir a sessão em volume
   privado conforme o caminho suportado pela imagem escolhida. Os arquivos
   autenticam a conta: restringir acesso, proteger backup e não copiá-los para
   o repositório. O diretório de mídia temporária não recebe a retenção de
   documentos comerciais do CRM.
3. Configurar chave exclusiva na API. Usar credencial protegida do n8n para
   `X-Api-Key`; não embutir o valor nos nós, JSON versionado, URL ou query string.
   Separar a chave de acesso ao gateway da autenticação WAHA → webhook n8n.
4. Preferir a rede interna e o DNS do serviço para tráfego n8n → WAHA. Não
   publicar porta diretamente na VPS. Se o painel de pareamento precisar de
   acesso HTTPS, protegê-lo antes de expor qualquer sessão, QR code ou API.
   Desativar superfícies que não forem necessárias. Não desativar autenticação
   ou proteções do n8n para resolver conectividade.
5. Definir recursos e política de reinício compatíveis com Chromium. Verificar
   saúde e versão no container real; observar consumo durante o piloto.
   Não acrescentar Redis ou nova persistência por tentativa.
6. Confirmar que a chamada sem chave é recusada e que a chamada autenticada
   responde. Guardar somente código HTTP, serviço, imagem, engine e horário.
   Não registrar headers, corpo de mensagem ou dados da sessão no diagnóstico.

## Preparação do workflow

Preservar o workflow principal e sua versão publicada antes de qualquer
atualização. A cópia de segurança deve ficar sem publicação, para não registrar
webhooks concorrentes. Alterar a fronteira do canal conservando IDs e caminhos
dos webhooks do painel e do site, as credenciais CRM/OpenAI e os nós de domínio.

O webhook WAHA deve exigir autenticação antes da normalização e aceitar somente
a sessão e a conta configuradas. Os IDs originais da mensagem sustentam a
idempotência; não usar instante da execução ou ID aleatório como identidade de
replay. Manter identidade de workflow, versão publicada, execução, epoch e revisão
nos comandos oficiais, sem gravar o corpo pessoal em logs de observabilidade.

Aplicar estas regras de entrada:

- Mensagem individual recebida do cliente pode iniciar a jornada existente.
- `fromMe` não inicia a IA nem cria novo inbound; isso inclui ecos dos envios
  feitos pelo n8n. Não prometer espelhar envios feitos diretamente pelo aplicativo
  se essa capacidade não tiver sido implementada e homologada.
- Grupos, listas, newsletters e status de transmissão não iniciam atendimento.
- ACK de entrega/leitura não vira mensagem do cliente; deve atualizar somente
  a mensagem conhecida e correlacionada, sem criar conversa por conta própria.
- Sessão/conta diferente é rejeitada. `@lid` sem correlação verificável com um
  telefone não é convertido, concatenado ou ligado a um Contato por inferência.
- Payload inválido, identidade não resolvida e falha externa conservam estado
  explícito de erro/pendência; não alegar que chegaram à Inbox quando descartados.

No retorno, preservar `message.send.requested` antes do envio ao WAHA. Exigir ID
válido do canal antes de registrar envio concluído; HTTP 200 isolado não prova
entrega ao destinatário. Timeout após o envio continua desconhecido, sem retry
automático e sem fallback para a Meta. Conservar o ACK do comando do painel com
`accepted` e o `command_id` correspondente.

### Preparação e importação por CLI

O helper versionado
[`create-waha-workflow.mjs`](../../ops/n8n/workflows/create-waha-workflow.mjs)
recebe três caminhos: export do workflow de origem, JSON candidato de saída e
JSON de configuração privada. Preparar esses arquivos em diretório protegido,
sem imprimir seus conteúdos. A configuração seleciona os IDs das credenciais
`httpHeaderAuth` já importadas, conta esperada, sessão e URL interna do gateway;
não deve embutir o valor das chaves no candidato. O helper gera `active: false`
e remove dados fixados de execução.

Importar o JSON candidato com `n8n import:workflow --input=<arquivo-protegido>`
no runtime correto. Importação não equivale a publicação nem a webhook pronto:
confirmar o retorno e depois ler o workflow salvo, suas referências de
credenciais, configurações de retenção, IDs e estado inativo. Não confirmar
conclusão com base apenas no início do comando. Não publicar o candidato junto
com a origem usando os mesmos webhooks do site e do painel.

Credenciais exclusivas do gateway e do webhook podem ser provisionadas por CLI
com o mecanismo de importação do n8n. Não exportar credenciais existentes para
recuperar seu conteúdo, não registrar arquivos de importação no Git e restringir
os artefatos transitórios de segredo ao processo operacional autorizado.
Depois de confirmar a importação, remover somente os arquivos transitórios que
contenham segredos; manter o backup protegido do workflow e seus metadados de
recuperação. Não remover arquivos por nome genérico ou glob.

Conservar `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`. Se a proteção SSRF precisar
autorizar o gateway privado, limitar a exceção ao hostname exato e verificar a
configuração efetiva após o reinício; não liberar toda a rede privada. Um valor
salvo no EasyPanel sem reinício não comprova seu uso pelos processos existentes.

Mídia exige download autenticado de origem permitida, limites e validação de
conteúdo, preservação das referências privadas do CRM e envio após reserva e
preflight aplicáveis. Não baixar URL arbitrária de um webhook ou reutilizar o
endpoint Meta para mídia da sessão WAHA. Se alguma classe de mídia não estiver
homologada, tornar a limitação visível e aplicar o handoff/erro existente sem
afirmar suporte. Não fazer retry cego de upload/envio incerto.

## Pareamento e ativação

O proprietário conecta a conta esperada pelo recurso de aparelhos conectados
do WhatsApp. Não parear outro número como substituto e não alterar senha ou PIN
da conta. Exibir QR/código somente em superfície autenticada; ele é uma credencial
temporária e não deve ser salvo em documentação pública ou artefato versionado.

Antes de publicar, conferir a identidade da conta conectada no runtime e comparar
com a configuração privada esperada. Sessão em `WORKING` comprova a conexão
observada, mas não recebimento ou envio. Ativar uma única rota da linha no n8n;
não manter Meta e WAHA processando a mesma entrada por tentativa.

O candidato preparado conserva os caminhos do painel e do site. Não publicá-lo
em paralelo com o principal. Antes do cutover, verificar a fila CRM → n8n e
reconciliar comandos antigos ou incertos; o contrato atual não informa a conta
remetente e um comando anterior não pode ser enviado pela nova linha. Aplicar a
versão validada no fluxo principal preservado, com seus IDs e credenciais, em uma
troca controlada. Não criar guardas por horário inferido: o envelope atual não
possui data de emissão estável que autorize essa distinção.

Não reprocessar execuções antigas. Realizar o teste com uma nova mensagem de
homologação do proprietário, sem usar histórico ou conversas de clientes.

## Matriz de homologação

| Cenário                                 | Evidência esperada                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Chamada sem autenticação                | Recusa; nenhum evento ou envio oficial.                                                               |
| Sessão ou conta diferente               | Recusa explícita antes de chamar CRM ou IA.                                                           |
| Mensagem real nova                      | Um Contato/Conversa corretos e mensagem única na Inbox, com atualização em tempo real.                |
| IA e handoff                            | Resposta ou transferência segundo a mesma jornada; nenhum preço ou pedido confirmado automaticamente. |
| Resposta humana pela Inbox              | Reserva única, envio único no telefone, ID correlacionado, ACK correto e status observado.            |
| `fromMe`, grupo e status de transmissão | Nenhuma rodada de IA ou novo inbound.                                                                 |
| `@lid` sem mapeamento comprovado        | Nenhum telefone inventado ou união de históricos.                                                     |
| Webhook repetido                        | Nenhum contato, mensagem, pedido, handoff ou envio duplicado.                                         |
| Takeover durante a IA                   | Epoch antigo recusado, sem resposta obsoleta.                                                         |
| Timeout após chamada de envio           | Resultado incerto visível, sem segundo envio automático.                                              |
| Reinício do gateway                     | Sessão preservada; saúde e identidade verificadas novamente.                                          |
| Chat do site e pedido da loja           | Contratos e webhooks anteriores preservados.                                                          |
| Mídia de entrada/saída                  | Testes próprios por classe; limitações explicitadas quando não homologadas.                           |

Testes sintéticos e mocks verificam o adapter, não comprovam WhatsApp real,
disponibilidade futura, menor taxa de banimento ou restauração do volume.
Evidência deve conter apenas metadados técnicos mínimos, sem PII ou segredo.

## Operação e recuperação

Monitorar disponibilidade do gateway, estado da sessão, último evento recebido e
falhas de entrega, sem registrar conteúdo pessoal. Desconexão deve aparecer como
falha do canal; não inventar um fallback que bypassa o n8n ou a reserva do CRM.
Usar o piloto para atendimento iniciado pelo cliente, sem disparo em massa ou
prospecção fria. Não criar contas substitutas ou mecanismos para contornar bloqueios.

Backup da sessão e backup do CRM/n8n são fronteiras distintas. Confirmar retenção,
acesso, armazenamento externo e drill antes de afirmar recuperação. Proteger as
chaves do WAHA e do n8n separadamente dos artefatos versionados. Restaurar uma
sessão em dois gateways ativos não é estratégia de disponibilidade.

Para rollback:

1. Pausar a entrada e os novos envios do piloto, preservando jobs, eventos e
   resultados incertos. Registrar o último estado observado.
2. Reconciliar envios que podem ter sido aceitos pelo WAHA. Não reenviar por
   mudar de versão, reiniciar serviço ou publicar novamente o workflow.
3. Restaurar a versão preservada somente após conferir suas credenciais e seus
   efeitos. A versão anterior pode continuar sem canal real disponível; publicar
   não autoriza registro/migração automática da conta comercial na Meta.
4. Manter apenas uma rota ativa e validar site/painel. Não restaurar banco como
   primeira tentativa, apagar histórico ou remover a sessão para testar.

## Referências de operação

- [Instalação](https://waha.devlike.pro/docs/how-to/install/),
  [motores](https://waha.devlike.pro/docs/how-to/engines/) e
  [segurança](https://waha.devlike.pro/docs/how-to/security/) do WAHA.
- [Sessões](https://waha.devlike.pro/docs/how-to/sessions/) e
  [eventos](https://waha.devlike.pro/docs/how-to/events/) do WAHA.
- [Integração n8n do WAHA](https://waha.devlike.pro/docs/integrations/n8n/).
- [Contrato CRM ↔ n8n](../integrations/n8n/README.md).
- [Histórico de ativação Meta e confirmação de comandos](inbox-whatsapp.md).

## Retomada inicial em 28/10/2026 — nova linha para a Inbox real

A [ADR 046](../adr/046-retomar-waha-para-atendimento-da-nova-linha.md) e o
[RFC 034](../rfc/034-retomar-waha-para-atendimento-da-nova-linha.md) registram
a pausa do WPPConnect e a retomada do WAHA/WEBJS para a nova linha destinada
ao atendimento real na Inbox do CRM. A suspensão e o bloqueio descritos
anteriormente pertencem à conta anterior, que continua sem uso e com seus
volumes preservados. Eles não descrevem o estado atual da nova linha.

WPPConnect foi construído e teve a API privada verificada, mas nunca pareado.
O serviço foi parado após falha `EPERM` de namespace do Chromium; não houve
aprovação nem aplicação de `--no-sandbox` ou alteração do host para contornar
a falha. O serviço existente `schedule/silmer-waha` foi retomado com a mesma
imagem WEBJS fixada e volumes novos de sessão e mídia, separados dos anteriores.

O candidato `WahaSilmerPilot01` foi atualizado da fonte atual de 92 nós para
101 nós, com número esperado em configuração privada, e permanece inativo.
O principal `k7tI6T4RhQPyJkn9` continua publicado e preservado. Não houve
cutover nem publicação do candidato de atendimento WAHA.

O utilitário manual privado `WahaPairSilmerNew01` exibiu QR. O telefone
recusou duas tentativas com “não foi possível conectar o dispositivo”. Uma
consulta autenticada a `/api/screenshot?session=default` mostrou a tela nativa
do WhatsApp Web com QR expirado e “Select to reload QR code”, enquanto a API
de sessão ainda retornava `SCAN_QR_CODE`, com `me: null`. Essa divergência
permite que o QR retornado esteja vencido; não comprova a causa das recusas.
A sessão nova ainda vazia foi reiniciada por `POST /api/sessions/default/restart`
e um QR novo foi obtido; a resposta do proprietário está pendente. Nenhuma identidade foi confirmada e não
há evidência de bloqueio dessa nova conta.

O utilitário salvo foi corrigido para usar `POST /api/sessions/default/restart`
na etapa de iniciar conexão. A leitura `GET /api/default/auth/qr` tem no máximo
cinco tentativas, com intervalo de 5.000 ms, para aguardar a inicialização.
Somente essa leitura admite retry; não se aplica a mensagens. A execução
manual completa gerou um PNG novo com sucesso. O export confirmou quatro nós,
estado inativo e retenção de execuções manuais, sucesso e erro desabilitada.
Executar o fluxo completo com o celular pronto para a leitura; a imagem
exibida não se atualiza sozinha. Uma leitura GET isolada não renova um QR
que já venceu no navegador. Não executar o pareamento como rotina de saúde
de uma conta em atendimento.

A verificação por export confirmou o principal publicado com 92 nós e versão
`91eaff25-87f6-4f13-9a27-382fcd958abe`; o candidato WAHA tem 101 nós,
`active: false` e nenhuma versão ativa. A configuração privada corresponde
à nova linha esperada. Isso não comprova identidade pareada.

WAHA-01D permanece aberta: confirmar identidade real, entrada e resposta na
Inbox, mídia, takeover, status, reentrega e reconexão com efeito único antes
do cutover. Falha `@lid`, ACK HTTP durável e reentrega também continuam sem
prova remota. O smoke autenticado que ignorou status sem efeito de domínio
não substitui essas verificações. Manter QR, telefone e tokens fora do Git;
não reutilizar a conta anterior nem repetir comandos antigos como fallback.

## Estado atual em 28/10/2026 — identidade confirmada e principal publicado

A sessão WAHA `default` retornou `WORKING`. A identidade observada foi
comparada exatamente com a configuração privada da nova linha esperada.
Isso confirma o pareamento observado; não substitui mensagem real na Inbox,
resposta, homologação de mídia ou recuperação. A conta anterior bloqueada
continua sem uso, com seus volumes preservados. WPPConnect continua parado.

Antes da troca, a leitura da fila CRM mostrou oito comandos enviados e oito
jobs concluídos; zero pendentes, em processamento, aguardando retry ou com
resultado incerto. A consulta ao banco próprio do n8n mostrou `inflight=[]`
para o principal. Não foi usado acesso do n8n ao banco CRM. O backup da fonte
de 92 nós, versão `91eaff25-87f6-4f13-9a27-382fcd958abe`, foi preservado em
`/home/node/.n8n/wpp-pilot/before-waha-live-cutover.json`, protegido e sem
exportar credenciais ou execuções. Manter `replaySafe=false`; não repetir
comandos anteriores pela nova conta.

Na UI, o principal `k7tI6T4RhQPyJkn9` foi despublicado. O adapter de 101 nós
foi importado no mesmo ID, inicialmente com `active: false`, e publicado como
“WAHA-01D · Nova linha na Inbox”. Foram preservados os IDs da fonte atual,
webhooks, notas e contratos; o redirect estático do site acompanha o destino
da configuração privada pela factory. Candidatos separados permanecem
inativos. A publicação foi concluída; a prova posterior de texto está abaixo,
com os gates restantes de canal explicitamente abertos.

No TEST do workflow completo, origem inválida retornou `500` antes de CRM.
O teste anterior somente do listener retornava `200` e não comprovava essa
fronteira. Em produção, a chamada sem autenticação retornou `403`; evento
autenticado de status ignorado retornou `200` sem efeito de domínio. Nenhum
desses casos comprova ACK HTTP durável após CRM, entrada real, IA ou envio.
Após a correção posterior de E.164, os 39 testes focados WAHA/WPP passaram
(21 WAHA e 18 WPP). O novo `npm run validate` completo passou com build:
1.189 testes, 1.186 aprovados, três ignorados e nenhuma falha.

O site e o link da bio foram publicados pela
[PR 40](https://github.com/romulosutil/silmer-web/pull/40), merge
`49262dba31ebffc403643cf75032431c74d35d59`. O deploy Production `7390013140`
concluiu com sucesso. Home, `/instagram` e `/chat` retornaram HTTP `200`, com
links para a nova linha e nenhuma ocorrência da anterior no HTML. Contatos
institucionais, vendedores e pós-pagamento mantiveram seus destinos próprios.
Na Meta, resposta automática e ausência foram salvas com o novo destino;
a leitura das sete respostas salvas confirmou sete destinos novos e zero
antigos. A bio aponta ao site atualizado. Telefone comercial do Instagram e
telefone da página Facebook estavam sem telefone, sem destino antigo nesses
campos. Autorização e solicitação de análise do app não foram alteradas.

### Prova real de texto e takeover em 28/10/2026

Uma mensagem nova, enviada pelo WhatsApp Web autorizado do proprietário,
persistiu na Inbox. O bot transferiu o atendimento e sua resposta chegou ao
WhatsApp Web às 12:53, horário de São Paulo. A conversa de homologação foi
assumida por uma pessoa no CRM, comprovando o takeover observado.

A primeira resposta humana falhou antes do HTTP: o CRM entregava destinatário
E.164 com `+` e o adapter aceitava somente dígitos. O registro
`OUTCOME_UNKNOWN` foi preservado e não reexecutado. O adapter passou a
normalizar somente um `+` inicial nos envios humanos de texto e mídia. Apenas
os dois nós correspondentes foram atualizados no mesmo workflow e publicados
como “WAHA-01D · Envio humano E.164”. Não houve replay do comando anterior.

Uma nova resposta humana, com texto diferente e outro comando, foi enviada
pela Inbox e chegou uma vez ao WhatsApp Web às 13:05. Isso confirma texto
real nos dois sentidos, persistência, transferência e takeover no cenário
executado. A captura permanece privada e fora do Git; conteúdo da mensagem,
números pessoais e número comercial não integram esta evidência versionada.

WAHA-01D tem a parte de texto operacional cumprida; os gates restantes
continuam abertos. Mídia, matriz de status/falhas, falha `@lid`, ACK durável,
reentrega e reinício/reconexão exigem suas próprias evidências. O resultado
de texto não comprova a matriz inteira, recuperação ou segurança de replay.

### Metadados finais de conferência

O export final confirmou `active: true`, 101 nós e
`versionId = activeVersionId = a107910d-9668-4962-be06-199feb852b78` no
principal preservado. O diff remoto da correção E.164 alterou exatamente dois
nós: `Preparar mensagem Meta de midia (MVP)` e
`WhatsApp - Enviar texto humano (MVP)`. A sessão WAHA permaneceu `WORKING`,
com `expectedAccount: true`.

O último comando humano de homologação ficou em `sent`,
`last_error_code: null`, com ID externo presente, `retryable: false` e
`retry_safe: false`. O job terminou em `completed`, com `attempt_count: 1`.
Esses metadados pertencem à nova resposta bem-sucedida e não alteram o
`OUTCOME_UNKNOWN` anterior preservado. UUIDs de comando, telefones e conteúdo
não foram versionados.

A conferência final das configurações de ausência e resposta automática Meta
mostrou o novo destino persistido, botão de salvar desabilitado e os dois
canais selecionados. Não houve alteração na autorização ou na solicitação
de análise do app.

### Incidente de autenticação e correção pontual em 29/10/2026

Rastreabilidade: WAHA-01F, WAHA-01D, MSG-01..04, INBOX-2/3, OPS-1 e INT-1/2.

A Inbox passou a exibir `N8N_COMMAND_TIMEOUT` para novos envios humanos.
O gateway estava em `FAILED`, inicialmente ainda com a identidade esperada.
A retomada preservando o perfil passou a exigir autenticação. Pareamento por
QR e por código não concluiu; gerar o artefato não comprovou conexão. Nenhum
comando de resultado incerto foi reexecutado.

A inspeção limitada do navegador interno confirmou Chrome `152.0.7977.82`,
WhatsApp Web `2.3000.105207594`, documento carregado, `Debug.VERSION`
disponível e Socket em `UNPAIRED`. Cache efetivo `none`, sem override de
versão ou proxy; os contadores `oom` e `oom_kill` permaneceram zerados.
Esses sinais não comprovam a causa original da desconexão nem bloqueio da
conta. A mensagem de timeout após navegação continua sendo um sinal distinto.

Foi confirmado um defeito de compatibilidade: a biblioteca tenta executar
`WAWebCmd.Cmd.refreshQR`, ausente no Web carregado, enquanto
`WAWebLaunchSocketUtils.refreshQR` existe e já é usada pela própria biblioteca
em outra operação de pareamento. A correção altera somente essa chamada
no ramo `UNPAIRED_IDLE`; não altera reservas, envios, autenticação do webhook,
engine, sessão, volumes ou identidade esperada.

A imagem derivada é autocontida em
[`ops/waha/Dockerfile.inline`](../../ops/waha/Dockerfile.inline), sobre o mesmo
digest original. O build exige o SHA256 observado do `Client.js`
`2b047b691a7aca07581302daae041f8199802925447cd2bb9264fdb7de59dd5e`, uma única
ocorrência no contexto esperado e sintaxe válida antes e depois. Divergência
impede o build. O script versionado e o inline são verificados pelo mesmo teste.

Antes do build, a sessão foi parada (`STOPPED`). Uma cópia do perfil foi
validada no próprio volume privado, em
`/app/.sessions/.silmer-recovery/20261029-before-qr-fix.tar.gz`, com arquivo
`0600` e diretório `0700`; nenhum byte da sessão foi exportado ao repositório.
A configuração anterior da fonte foi preservada. O rollback da imagem é
retornar a fonte ao digest original registrado na instalação e implantar
novamente, preservando os volumes. Restaurar o perfil é uma ação separada,
com serviço parado e validação do alvo, sem remover a única cópia.

Gate local: `npm run validate` passou com 1.411 testes aprovados, cinco
ignorados e nenhuma falha, incluindo seis regressões da correção; build do CRM
e `git diff --check` passaram. A máquina usou Node `24.22.1` e npm `11.19.1`,
diferentes dos pins do projeto; a imagem candidata conserva o runtime da
base original. O build Docker e o pareamento real têm evidências independentes.

O build remoto concluiu com sucesso em 29/10 às 12:12:33 UTC. A imagem em
execução tem ID `sha256:ad2f713ca9f2222a5fcc70ec414443c4605d4c98784cea50225881f23dc448e5`;
o `Client.js` implantado tem SHA256
`b660cf97f4816ed250e11590baac6344f3028e4b2a8f124ac490981f13aee44f`.
Fonte, ambiente, mounts, recursos e política de deploy foram comparados;
apenas a fonte da imagem mudou para o Dockerfile derivado.

No navegador real, Web `2.3000.1052208262`, o callback do ramo corrigido
executou sem a função ausente e alterou a referência do QR. Essa prova foi
feita antes de obter o novo QR para a tentativa humana. A revisão independente
não encontrou problemas no patch; os seis testes focados passaram novamente.

A execução E2E geral terminou com 341 aprovados, sete ignorados e duas falhas
fora dos arquivos alterados: `audio-recorder.spec.js:294` não encontrou o botão
Gravar áudio dentro do timeout; `crm-ui.spec.js:967` usou um seletor de texto que
resolveu em dois elementos. Não foi feita uma execução da base para atribuir
essas falhas, portanto o gate E2E geral permanece reprovado. O audit não
apontou vulnerabilidades altas (uma baixa e duas moderadas existentes).

Estado após a tentativa humana com a imagem corrigida: o proprietário relatou
novo erro de conexão. A API respondeu `SCAN_QR_CODE`, sem identidade, e o
navegador permaneceu `UNPAIRED`, sem aviso de versão não suportada. O monitor
limitado não registrou transição de estado nem falha de request nesse intervalo;
isso não exclui falhas anteriores ou de WebSocket. A causa do pareamento ainda
não está demonstrada. O próximo discriminante é testar a mesma linha no
WhatsApp Web oficial em janela anônima, sem alterar o gateway nem gerar outro
QR antes do resultado.

A correção da renovação do QR não comprova recuperação da autenticação,
estabilidade ou entrega. Confirmar `WORKING` e identidade esperada antes de
testar entrada e resposta novas, uma vez, sem replay dos comandos anteriores.
