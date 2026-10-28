# WAHA com WEBJS — piloto da Inbox Silmer

Atualização: 28/10/2026, America/Sao_Paulo.
Decisão: [ADR 042](../adr/042-piloto-whatsapp-waha-webjs.md) e
[RFC 030](../rfc/030-piloto-whatsapp-waha-webjs.md).
Rastreabilidade: WAHA-01, INBOX-2/3, AGENTE-6, OPS-1, INT-1/2;
[ORC-01..08, INB-01 e MSG-01..04](../../.specs/features/crm-mvp/spec.md).

## Estado e escopo

O proprietário autorizou instalar WAHA com WEBJS no EasyPanel e conectar a
linha temporária ao n8n e à Inbox, preservando a integração existente.
As evidências observadas estão registradas abaixo. A criação do serviço e os
testes do adapter não comprovam sessão conectada, tráfego real, mídia homologada
ou recuperação.

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
      acesso interno e recusa sem chave verificados; nenhuma identidade pareada
      confirmada. Serviço suspenso em 28/10 após o bloqueio da conta no aplicativo.
- [x] WAHA-01C — preparar e testar o adapter de eventos, identidade, envios e
      confirmações mantendo reservas, epoch, revisão, correlação e ACKs do CRM.
      Correções de ACK de 28/10 passaram em 18 testes focados; candidato de
      101 nós regenerado da fonte atual e importado inativo. Smoke remoto
      autenticado no-op em TEST passou; falha `@lid`, resposta durável `202`,
      reentrega e envio WhatsApp real continuam sem prova remota.
- [ ] WAHA-01D — parear a linha esperada e publicar a rota única; validar
      recebimento/resposta reais, handoff, takeover, replay e reinício. Ativação
      no celular e leitura do QR foram relatadas pelo proprietário em 28/10;
      o runtime retornou `FAILED` e depois `SCAN_QR_CODE`, sem identidade
      confirmada. Foto posterior mostrou a conta bloqueada no aplicativo.
      Impedida por esse bloqueio externo; gateway suspenso, sem publicação WAHA
      ou cutover. Volumes, sessão, backups e fluxo principal preservados.
- [x] WAHA-01E — registrar evidências sanitizadas, limites de mídia e recovery,
      atualizar fontes canônicas, executar checks, commit e push da entrega.
      A entrega registra a preparação; a homologação real permanece em WAHA-01D.

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
