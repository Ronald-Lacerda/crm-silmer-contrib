# Inbox WhatsApp — ativação e diagnóstico

Rastreabilidade: INBOX-1..4, OPS-1, INT-1..2, INB-01, ORC-01..08 e MSG-01..04.
Data: 24/10/2026, America/Sao_Paulo.

## Evidência observada em 24/10/2026

- CRM autenticado acessível; Inbox carregou as conversas do chat do site.
- Workflow principal `Silmer | Atendimento WhatsApp IA` publicado.
- Na primeira inspeção, a permissão `whatsapp_business_messaging` estava
  aprovada, mas o app ainda não estava publicado. Após autorização explícita
  do proprietário, foi publicado e a Meta confirmou **“Seu app foi publicado
  com sucesso”**. A publicação permite webhooks de produção; não comprova
  registro do telefone ou validade da credencial de envio.
- O trigger ainda usava uma credencial OAuth de outro app. Foi selecionada a
  credencial já existente do app aprovado, com teste de conexão bem-sucedido,
  e publicada a versão `mvp-simple-18-whatsapp-app-approved`.
- Após essa publicação, a Meta mostrou o callback de produção do trigger
  registrado e `messages` assinado na versão `v26.0`.
- O exemplo oficial `Incoming Message` de `messages` foi enviado pelo painel
  Meta. A mensagem sintética apareceu na Inbox **sem recarregar a página**,
  com canal WhatsApp e handoff. Isso demonstra Meta → n8n → CRM → SSE → UI;
  não comprova envio ou recebimento pelo telefone comercial.
- O WhatsApp Manager da conta Silmer mostra o telefone comercial **Offline**.
- O remetente do nó `WhatsApp - Enviar texto humano (MVP)` tinha outro ID de
  telefone. Foi alinhado ao ID exibido no Manager da conta Silmer e publicada
  a versão `mvp-simple-18-whatsapp-business-number`.
- A tomada humana dessa conversa sintética foi concluída, com responsável
  atualizado e foco no campo de resposta. O contato foi identificado como
  teste e a conversa arquivada sem apagar histórico nem resultado incerto.
- A credencial `WhatsApp account`, usada para envio e mídia, falhou no teste
  de conexão, inclusive após `Retry`, e contém outra conta empresarial. A
  credencial OAuth do trigger e essa credencial de envio são distintas.
- O worker está configurado para `/webhook/silmer/panel-command`, sem replay
  automático. A API tem `N8N_INTEGRATION_ENABLED=true`. Isso não comprova a
  validade atual da autenticação Basic nem o envio ao canal real.

Nenhum token, segredo, ID de credencial, telefone ou conteúdo de cliente é
necessário nesta evidência. Não exportar credenciais ou execuções completas.

## Atualização operacional em 26/10/2026 — OPS-1 em andamento

- O proprietário atualizou o token diretamente no n8n e corrigiu o
  `Business Account ID`. A credencial foi salva e exibiu
  `Connection tested successfully`. O WhatsApp Manager passou a mostrar o
  telefone comercial como `Conectado`.
- O usuário de sistema recebeu, com autorização explícita do proprietário,
  acesso `Desenvolver app` somente ao app de atendimento. A Meta confirmou
  a atribuição, incluindo as capacidades derivadas de teste e insights.
- O trigger publicado usa o OAuth do app aprovado e a URL de produção;
  callback e assinatura de `messages` continuam alinhados. O health público
  do CRM retornou `200`; o webhook de comandos, sem autenticação, `401`.
- Uma mensagem real enviada pelo proprietário ao telefone comercial recebeu
  dois tiques no WhatsApp, mas não apareceu na Inbox. Isso ainda não comprova
  chegada ao n8n nem envio do aviso de handoff.
- Uma consulta isolada, manual e não publicada, com a mesma credencial de
  envio, recebeu `(#200) You do not have permission to access this field`
  em `GET /<WABA_ID>/subscribed_apps`. `GET /me/permissions` mostrou somente
  `whatsapp_business_messaging` e `public_profile`, ambas `granted`.
  O teste verde da credencial não comprova os escopos necessários.
- O Business Suite estava usando um perfil Instagram; o assistente de token
  mostrava `You are not an admin of this app`. Ao selecionar o perfil
  Facebook já conectado que administra o app, esse aviso desapareceu.
  Foi preparada, sem concluir a geração, uma solicitação com
  `whatsapp_business_messaging` e `whatsapp_business_management`, por 60 dias.
- O novo assistente também exigiu confirmação de conta. A Central de
  Segurança mostrou exigência de dois fatores `Ninguém` e de passkeys
  `No one`; a empresa consta como verificada. Consultar os controles de dois
  fatores do próprio perfil Facebook abriu outra confirmação por email;
  depois dela, o Facebook ofereceu ativar dois fatores.
  Nenhuma proteção foi desligada. Esses estados não demonstram que exista
  uma opção para suprimir a confirmação da ação de emitir token.
- O Graph API Explorer já tinha uma autorização de usuário com
  `whatsapp_business_management`. `GET /app?fields=id,name` confirmou o app
  de atendimento esperado; `GET /<WABA_ID>/subscribed_apps` retornou
  `data: []`, comprovando a ausência da assinatura da conta.
- Após autorização explícita do proprietário para encaminhar mensagens e
  status ao n8n/CRM, `POST /<WABA_ID>/subscribed_apps`, sem corpo, retornou
  `success: true`. A consulta seguinte listou o app de atendimento correto,
  sem `override_callback_uri` na resposta. Nenhuma assinatura foi removida.
  A autorização de gestão ficou no Explorer; não foi copiada para o n8n,
  e o token de envio não precisou ser substituído novamente.

Para diagnosticar a gestão, conferir os escopos efetivos da autorização usada
na consulta e a assinatura da WABA. Um token de envio autenticado não prova
acesso de gestão; essa operação pontual pode usar uma autorização de usuário
no Explorer, mantendo o token de envio do workflow. Segundo a
[documentação do WhatsApp Trigger do n8n](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.whatsapptrigger/),
publicar o trigger registra o callback no app, mas não assina o app na WABA.
O teste sintético da Meta também pode passar sem essa assinatura. A consulta
deve identificar o app esperado e eventuais overrides de callback; não remover
ou substituir assinaturas sem confirmar o alvo e os efeitos. A ausência de
override na assinatura da WABA não descarta override no telefone, que tem
precedência; investigá-lo se a mensagem pós-assinatura ainda não chegar.

Na geração de token, verificar o perfil ativo e as permissões antes de
concluir. A Meta pode mostrar simultaneamente uma solicitação aprovada antiga
e outra aguardando verificação; não presumir que o token copiado da aprovação
anterior inclui o novo escopo. Inserção e salvamento do segredo ficam com o
proprietário na interface; não exportar token, credencial ou execução completa.
Não confundir a exigência global de dois fatores com a autorização adicional
de ações sensíveis: a
[Meta documenta confirmações por dois fatores, email ou outra pessoa](https://about.fb.com/news/2023/05/how-meta-protects-businesses-from-malware/).
Se a confirmação perder os escopos ou reiniciar o assistente, interromper
novas emissões e diagnosticar a sessão ou encaminhar o erro ao suporte oficial;
não desligar proteções pessoais ou do portfólio por tentativa.
OPS-1 continua aberta até validar recebimento e resposta pelo canal real,
takeover, status e replay. Mídia, privacidade e recovery conservam seus gates.

## Próximos passos no ambiente

1. Receber uma nova mensagem real de um número de homologação autorizado após
   a assinatura da WABA. Conferir mensagem única, contato correto, resposta
   ou handoff e atualização da Inbox.
2. Assumir essa conversa, enviar um texto de teste e verificar a mesma mensagem
   uma única vez no telefone e no CRM, com confirmação do canal. Validar
   takeover durante a resposta, status e replay antes de concluir OPS-1.
3. Conferir a credencial de envio já salva no n8n e o `Business Account ID`
   da conta Silmer. Substituir o token somente diante de nova falha que exija
   a troca, com o proprietário inserindo e salvando o segredo diretamente na
   interface; nunca enviá-lo por chat ou commit. O escopo de gestão usado na
   assinatura pontual não exige nova troca do token de envio.
4. Conferir que o telefone comercial continua registrado e conectado na
   Cloud API. Se houver nova pendência de registro ou PIN, resolvê-la na
   interface oficial com o proprietário.
5. Manter o app Meta publicado e conferir callback, campo `messages` e
   assinatura da WABA. A aprovação da permissão, isoladamente, não demonstra
   esses estados.
6. Conferir na versão publicada do workflow o OAuth do trigger, a credencial
   de envio, o remetente humano e os nós de mídia. A variável
   `SILMER_WHATSAPP_PHONE_NUMBER_ID` ainda precisa ser reconciliada com o
   telefone comercial; não presumir que o valor antigo representa essa conta.
   O n8n bloqueia `$env` nos nós: validar a resolução efetiva antes de liberar
   mídia e não alterar essa proteção para contornar configuração pendente.

Não reenviar comandos anteriores falhos ou desconhecidos. Não usar conversas
de clientes para teste. Não declarar WhatsApp homologado com base apenas no
teste sintético do painel, no selo `Published` ou na conexão OAuth.

## Confirmação do comando CRM → n8n

O cliente exige HTTP `200`/`202`, `accepted: true` e `command_id` correspondente.
Ausência de confirmação estruturada gera `N8N_COMMAND_ACK_INVALID`; ID de
outro comando gera `N8N_COMMAND_ACK_MISMATCH`. A Inbox preserva o resultado
incerto para reconciliação e não autoriza retry cego. Resposta HTTP genérica
não comprova mensagem enviada. Os ACKs atuais de estado, callback e replay
continuam aceitos, sem exigir `message_id` nas ações que não o produzem.

## Verificação do patch OPS-INBOX-ACK-01

- Node `24.20.0` e npm `11.19.0`.
- `npm run validate`: aprovado, 1.100 testes, 1.097 passaram, três live
  ignorados e nenhuma falha; build, formatação, tipos, lint e gates passaram.
  Foi necessário executar fora do sandbox Windows porque os testes de mídia
  usam hard links temporários, bloqueados com `EPERM` no sandbox.
- `npm run test:e2e`: 302 aprovados e sete ignorados. A inicialização de
  navegador/servidor também exigiu execução fora do sandbox.
- Revisão QA independente aprovou a compatibilidade dos ACKs dos workflows
  MVP, DEV e LOCAL vigentes. Snapshots históricos não são a versão ativa.
- `git diff --check`: aprovado.
- `npm audit --audit-level=high`: bloqueio preexistente de dependências,
  quatro vulnerabilidades (uma alta em Vite, duas moderadas e uma baixa).
  Manifestos e lockfile não foram alterados nesta correção. O resultado não
  autoriza declarar o release pronto para produção.

## Recuperação

Preservar o histórico de versões do n8n. Se houver falha após a ativação,
interromper o processamento conforme o runbook da integração, preservar
comandos e resultados incertos e investigar antes de retomar. Não apontar o
worker para DEV, reativar entrada direta Meta → CRM ou restaurar o banco como
primeira tentativa. Os gates de privacidade, mídia e recovery continuam com
suas evidências próprias.
