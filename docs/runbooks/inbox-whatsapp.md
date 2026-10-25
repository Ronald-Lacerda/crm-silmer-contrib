# Inbox WhatsApp — ativação e diagnóstico

Rastreabilidade: INBOX-1..4, OPS-1, INT-1..2, INB-01, ORC-01..08 e MSG-01..04.
Data: 24/10/2026, America/Sao_Paulo.

## Evidência observada

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

## Próximos passos no ambiente

1. O proprietário deve regularizar a credencial de envio no n8n, usando um
   token válido com acesso à conta Silmer e o `Business Account ID` da conta
   selecionada no WhatsApp Manager. Inserir o segredo diretamente na interface
   de credenciais e testar a conexão; nunca enviá-lo por chat ou commit.
2. Conferir que o telefone comercial está registrado e online na Cloud API.
   Resolver eventual verificação/PIN na interface oficial, com o proprietário.
3. Manter o app Meta publicado e conferir o callback e a assinatura de
   `messages`. A publicação foi concluída nesta sessão; a aprovação da
   permissão, isoladamente, não demonstrava esse estado.
4. Conferir na versão publicada do workflow o OAuth do trigger, a credencial
   de envio, o remetente humano e os nós de mídia. A variável
   `SILMER_WHATSAPP_PHONE_NUMBER_ID` ainda precisa ser reconciliada com o
   telefone comercial; não presumir que o valor antigo representa essa conta.
   O n8n bloqueia `$env` nos nós: validar a resolução efetiva antes de liberar
   mídia e não alterar essa proteção para contornar configuração pendente.
5. Receber uma mensagem real de um número de homologação autorizado. Conferir
   mensagem única, contato correto, resposta ou handoff e atualização da Inbox.
6. Assumir essa conversa, enviar um texto de teste e verificar a mesma mensagem
   uma única vez no telefone e no CRM, com confirmação do canal. Validar
   takeover durante a resposta, status e replay antes de concluir OPS-1.

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
