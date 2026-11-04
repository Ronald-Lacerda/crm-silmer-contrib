# Conferência de falhas de envio na Inbox

Rastreabilidade: INBOX-DELIVERY-01, OPS-INBOX-ACK-01, MSG-02/03, ORC-08,
INBOX-3 e INT-2. O contrato de reserva e idempotência permanece vigente.

## Resposta humana após confirmar pedido — 04/11/2026

OPS-INBOX-SEND-07 / MSG-02/03, ORC-08 e INT-2. Duas respostas humanas do
período da tarde falharam no nó `CRM - Reservar envio humano (MVP)`, antes do
transporte. As consultas individuais encontraram comandos e mensagens
`outcome_unknown`, `N8N_COMMAND_REMOTE_UNAVAILABLE`, sem ID externo ou evento
n8n associado. A conversa estava humana e aberta, com Assunto ligado a pedido
confirmado e nenhum pedido pendente. Não exportar conteúdo, destino ou IDs de
clientes para a evidência versionada.

O guard legado compara o pedido do Assunto atual ao pedido pendente antes de
reservar respostas do agente. Ele também alcançava comandos humanos, recusando
o envio depois da confirmação comercial com `SUBJECT_TARGET_REQUIRED`.
O erro do webhook era registrado como indisponibilidade remota; o enum também
cobre HTTP 408, 425, 429 e 5xx, sem comprovar queda de todo o n8n.

A API agora identifica o comando persistido antes desse guard. Somente a
reserva humana segue para seu fence próprio: autor e conversa correspondentes,
estado humano aberto, epoch e revisão atuais, mensagem queued, comando
processing e conteúdo igual ao envelope. Nenhum campo enviado pelo workflow
concede a exceção. Briefing continua proibido; replay não autoriza novo efeito.
O guard do agente e o tratamento de falha tardia do preflight de destinatário
permanecem intactos. Não há migration ou mudança de workflow.

Antes da recuperação autorizada, conferir novamente cada original, sua falha
anterior ao transporte e ausência de reserva/ID externo. Reconciliar como
`failed`, sem retry, pelo core `reconcileN8nCommandOutcome`, registrando operador,
motivo e correlação na auditoria. Concluir a pendência de fila conhecida como
falha e sua reconciliação na mesma operação, sem apagar nem reescrever
tentativas. Enviar o conteúdo autorizado como nova operação humana pela API/UI,
com outra chave idempotente. Nunca marcar o original como enviado nem resetar
mensagem/comando/job para simular uma primeira tentativa.

Gates: regressão PostgreSQL sintética para pedido confirmado, reserva automática
recusada, briefing, epoch/conteúdo/autoria inválidos, autorização única e replay;
validate, E2E/axe, audit e revisão independente. Publicar a API somente após o CI
com banco. Conferir release, health e cada confirmação do novo envio; `sent`
não equivale a `delivered` ou `read`. Rollback: republicar a imagem anterior da
API, preservando histórico e sem repetir mensagens já enviadas.

## Destinatário não reconhecido — 04/11/2026

OPS-INBOX-SEND-06 / MSG-02/03, ORC-08 e PRV-01. Às 08h20 de Brasília,
consultas somente leitura encontraram três comandos humanos incertos criados
entre 07h56 e 08h12, em duas conversas. Todos tinham reserva e evento
`message.send.unknown` com `EVOLUTION_SEND_OUTCOME_UNKNOWN`, em menos de
cinco segundos e sem ID externo. Outros 70 comandos de envio dos dois dias
anteriores estavam `sent`; isso não equivale a recibo de entrega.

A consulta autenticada `chat/whatsappNumbers` retornou `exists:false` para
os dois destinos originais. Não havia mensagem outbound persistida nos
instantes das três tentativas. O upstream rejeita `exists:false` antes de
`sendMessageWithTyping` enviar. Essa evidência explica a recusa atual e é
compatível com o incidente; como a resposta HTTP original não foi retida,
não autoriza reclassificar os resultados antigos nem afirmar ausência
definitiva da conta. Nenhum telefone, conteúdo ou ID pessoal foi exportado
para esta evidência; não houve envio de teste nem correção heurística do 9.

O patch offline `ops/n8n/evolution-recipient-preflight.mjs` atua somente no
ramo WhatsApp após a reserva humana. Texto e mídia consultam o número
original, com timeout de quatro segundos, sem retry/redirect. `fullResponse`
preserva o array do provider num único item n8n; o validador devolve somente
um booleano. Um registro de mesmo número com `exists:true` libera o fluxo.
`false` gera `EVOLUTION_RECIPIENT_NOT_FOUND`; erro HTTP, timeout ou formato
inesperado geram `EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE`, sem chegar ao
transporte. O retorno de rejeição é HTTP 422, depois do recibo CRM, e nunca
declara envio aceito. O texto na Inbox orienta conferir o telefone.

A API deve ser implantada antes do workflow: aceita os dois motivos no
contrato `workflow.failed / before_message_send`, persiste o código da
mensagem e valida a reserva original. Uma conclusão tardia por timeout do
worker exige execução, versão, epoch, revisão, autoria e recibos originais,
ambos os registros incertos e sem ID externo ou evento de incerteza do
transporte. A fila termina como falha sem retry somente com essa prova.
Timeout após tentativa de envio continua incerto. A consulta não muda a
identidade, o destino, o conteúdo ou o hash do comando.

Rollout: conferir CI, implantar API/worker/edge compatíveis, guardar export
privado do workflow atual e inventário dos demais, aplicar o helper sobre
esse export e revisar o delta de sete nós adicionados/uma conexão alterada.
Publicar a versão revisada pela UI, conferir versão ativa e fingerprints
preservados e acompanhar envios naturais. Não executar mensagens ou
callbacks antigos para testar. A preparação usa dados sintéticos nos gates;
consulta de produção somente leitura não é homologação de entrega.

Rollback: restaurar o export privado anterior somente no principal e
publicá-lo novamente. Reverter o commit da aplicação se necessário; não há
migration nem mudança de identidade, pareamento ou transporte. Preservar
todos os resultados incertos e as marcas de arquivo do WAHA. O auxiliar de
diagnóstico autenticado deve ser removido ao encerrar a verificação.

## Diagnóstico de 30/10/2026

O incidente apresentado pelo proprietário envolve duas mensagens humanas de
29/10 às 06h28 (São Paulo). Consultas somente leitura no CRM confirmaram:

- Criação às 06h28m37s e 06h28m43s; timeout aproximadamente 11 segundos depois.
- Ambos os comandos em `outcome_unknown`, `N8N_COMMAND_TIMEOUT`, sem ID externo,
  com `retryable=false` e `retry_safe=false`.
- Um evento `message.send.requested` para cada tentativa, no transporte
  `waha-webjs-1`; nenhum callback posterior de resultado nem tentativa de
  entrega registrada. A reserva comprova chegada ao workflow, não envio externo.
- Nenhuma execução do workflow preservada na tabela de execuções consultada
  no n8n. Essa ausência limita a análise; não comprova que o workflow não rodou.

A [perda de autenticação do WAHA registrada em 29/10](waha-webjs.md#incidente-de-autenticação-e-correção-pontual-em-29102026)
é compatível com a falha, mas não há evidência preservada suficiente para
atribuir a causa exata dessas duas tentativas. Não foi feito replay, alteração
de status, reinício, novo pareamento nem envio ao cliente durante o diagnóstico.

Na conferência atual, Evolution estava habilitado e WAHA desabilitado. Nas
12 horas anteriores à consulta, o CRM registrava 17 comandos `sent` e um
timeout incerto novo, sem evento de reserva associado. Isso não comprova
entrega/leitura no destinatário nem estabilidade contínua. O timeout novo
permanece separado do incidente antigo; não se atribui automaticamente ao WAHA.
Conteúdo, telefones, IDs pessoais, UUIDs dos registros e segredos ficam fora
desta evidência versionada.

## Reconciliação da fila após confirmação tardia — 03/11/2026

OPS-INBOX-ACK-02 / MSG-02–03, ORC-08 e INT-2. Consultas somente leitura no
console da API no EasyPanel, sem conteúdo ou destinatários, encontraram:

- 14 jobs `n8n.command.deliver` em `outcome_unknown`, todos com timeout HTTP.
- 12 desses jobs vinculados a comandos ainda incertos; outro comando incerto
  não tinha job nesse estado. Total: 13 comandos sem confirmação conclusiva.
- Dois jobs vinculados a comandos e mensagens `sent`, com ID externo e evento
  autenticado `message.sent`. O mais recente recebeu a confirmação cerca de
  0,45 segundo após o timeout de 10 segundos. O outro é de 29/10.

O callback já reconciliava comando e mensagem. A fila conservava o estado
incerto como histórico e não voltava a examiná-lo. Isso explica o alerta do
worker mais recente sem um novo comando n8n incerto; não demonstra falha de
entrega desse envio. Os 13 comandos restantes continuam exigindo evidência
individual do destino. Não atribuir todos eles ao transporte atual ou ao
mesmo motivo. As referências de Saúde e erros agrupam origem/código e não
são IDs de job, comando ou mensagem.

O workflow principal estava ativo no n8n, com 113 nós, e a tabela consultada
não preservava execuções dele. Isso limita a investigação dos envios antigos;
não comprova ausência de execução nem permite concluir que o envio falhou.

O poll agora reconcilia até 100 jobs incertos da própria fila, após recuperar
leases expiradas. A prova exige comando `send_message` em `sent`, mensagem
`sent` da mesma conversa e comando, ID externo não nulo e igual nos dois
registros e evento imutável `message.sent` da mesma mensagem/conversa.
Somente o job é bloqueado, com `SKIP LOCKED`; callback ainda não confirmado
fica para o poll seguinte. Na mesma transação, o job passa a `completed` e o
item aberto a `resolved`, preservando motivo e criação. Não muda comandos,
mensagens, tentativas, eventos nem contagem histórica de incidentes.

Nenhum handler de envio é chamado por essa reconciliação. Jobs sem prova,
outra fila, falhas de outro tipo e IDs divergentes permanecem intactos.
O histórico de timeout continua consultável nas tentativas; `completed`
significa confirmação conhecida do envio, não leitura pelo destinatário.
Marcar o grupo resolvido no painel continua sendo triagem humana separada.

Não aumentar o timeout para 30 segundos sem considerar o lease de 30 segundos
e a renovação efetiva do job: o heartbeat geral do worker só publica métrica.
Esse ajuste não faz parte desta correção. O workflow vivo e os efeitos incertos
não devem ser reexecutados para testar a mudança.

Validação: cenários SQL de confirmação tardia, prova ausente/inconsistente,
concorrência, bloqueio temporário e repetição, com dados sintéticos no banco
dedicado; gates gerais do projeto. Não usar o banco CRM real nesses testes.
Gate local com Node 24.20.0/npm 11.19.0: `npm run validate` aprovado,
1.630 testes aprovados e oito ignorados. Auditoria no nível alto aprovada;
nove achados baixos/moderados preexistentes, sem mudança de dependências.
Os dez cenários novos de PostgreSQL exigem `TEST_DATABASE_URL` e rodam no CI;
o gate local sem banco não os executa. Revisão Backend/QA sem bloqueantes.
Rollback: publicar o worker anterior, mantendo jobs já reconciliados e todo
o histórico. Sem migration, restauração de banco ou replay de mensagens.

## Atendimento e investigação

**Ainda não conseguimos confirmar o envio** informa resultado incerto.
**O envio encontrou um problema** informa falha registrada, sem concluir que
não houve efeito externo. **Verificar envio** consulta o estado atual da mesma
mensagem na API; não consulta diretamente o WhatsApp nem dispara reconciliação
no provedor. Se o estado não mudar, o aviso permanece.

Em **Detalhes para suporte**, a referência é o ID da mensagem já acessível
na conversa autenticada. O suporte autorizado correlaciona essa referência
com `crm.messages.id`, `crm.n8n_commands.message_id`,
`crm.n8n_events.message_id` e `crm.message_delivery_attempts.message_id`.
Selecionar somente metadados necessários: status, erro, instantes, existência
de ID externo, versão/execução e eventos. Não extrair envelopes, conteúdo,
destinatário, headers ou credenciais para logs/artefatos.

Quando a consulta falha, **Tentar novamente** repete somente o GET. Histórico,
referência e rascunho são preservados. O resultado é anunciado por região de
status ou alerta; uma confirmação que remove o botão devolve foco ao histórico
se o foco estava no controle removido. Trocar de conversa cancela a consulta.

Antes de qualquer reenvio, reconciliar o comando original com evidência do
provedor e o contrato autenticado. `failed` e o texto do código, isoladamente,
não autorizam criar outro comando. Repetir o POST original apenas consulta o
resultado idempotente; não é uma funcionalidade de retry humano.

Rollback da interface: reverter somente o commit desta entrega e publicar
edge novamente. Sem migration, alteração de workflow, status de comandos ou
configuração de transporte.

## Verificação da entrega

Node `24.20.0` e npm `11.19.0`. O gate `npm run validate` passou com
1.488 testes: 1.483 aprovados, cinco ignorados e nenhuma falha, além de
formatação, tipos, lint, fronteiras, contratos e build. A execução inicial
restrita falhou por `EPERM` de hardlinks em testes existentes de áudio;
o gate completo passou com permissões locais adequadas.

Cinco cenários focados passaram: texto de falha com referência, timeout sem
POST, falha do GET preservando rascunho/histórico e nova consulta, confirmação
tardia com foco e bloqueio de clique duplicado/troca de conversa. Incluem
teclado e axe. O E2E completo passou com 371 aprovados, sete skips e zero
falhas, usando servidor loopback dedicado na porta 4187 porque a porta 4173
estava ocupada. Configuração temporária e logs ficam em `var/`, fora do Git;
assertions, skips e timeouts publicados foram preservados.

`npm audit --audit-level=high` passou, com uma vulnerabilidade baixa e duas
moderadas existentes, sem novas dependências. `git diff --check` aprovado.
Revisões de Frontend/A11y e QA/Segurança sem bloqueantes. Esta evidência é de
código/local: a nova interface depende de integração/publicação do edge.
