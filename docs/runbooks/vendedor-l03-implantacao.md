# Implantação do Vendedor VND-L03

Decisão: [ADR 052](../adr/052-vendedor-mensuravel-e-com-mais-contexto.md)
([RFC 041](../rfc/041-vendedor-mensuravel-e-com-mais-contexto.md)).
Tarefas: AGENTE-FAIL-01, AGENTE-OBS-01, INBOX-HANDOFF-02,
INBOX-AUDIO-TRANSCRIPT-01, VND-CTX-01, INBOX-DELIVERY-02 e VND-L03 no
[plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Contrato: [integração n8n](../integrations/n8n/README.md), seções "Campos da
ADR 052" e "VND-L03".

A ordem é fixa: CRM e migrações primeiro, workflow depois. O schema do CRM é
estrito: o workflow `mvp-simple-20` publicado antes das migrações recebe `400`
nos campos novos, e o bot para de responder. O workflow publicado hoje
(VND-L02, versão `cd0de4e8`) funciona com o CRM novo.

Registre em cada passo só SHA, versão, contagens e códigos. Nunca registre
texto de cliente, nome, telefone, chave ou URL com token.

## Antes de começar

- PR integrada em `master` por rebase, com o CI verde.
- Gates locais executados, inclusive `npm run test:vendedor:live` (PostgreSQL
  real, dados sintéticos).
- Autorização do proprietário para publicar o workflow principal.
- Backup do export vivo do workflow principal no n8n (113 nós, adaptado ao
  Evolution).

## 1. Merge

Integrar a PR em `master`. Anotar o SHA do merge.

## 2. Deploy automático

O fluxo GitHub → EasyPanel publica `silmer-edge-web`, `silmer-worker` e
`silmer-api` (ADR 022). Conferir no painel que os três serviços estão no SHA
do merge. A API já esteve com Auto Deploy desligado
([topologia](../../EASYPANEL-TOPOLOGY.md), "Merge e promoção"); se ela não
subiu sozinha, implantar à mão.

Até a migração do passo 3, telas que leem as colunas novas (Inbox, painel)
podem falhar com `42703`/`42P01`, e handoffs com motivo ou vendedor novos são
recusados. Faça o passo 3 logo em seguida.

## 3. Migrações 0046–0048

No console do `silmer-api`:

1. `ls modules/database/migrations | tail -3` deve listar
   `0046_handoff_reasons_preferred_seller.expand.sql`,
   `0047_automation_turns.expand.sql` e
   `0048_message_transcript_delivery_code.expand.sql`. Se não listar, o
   container ainda é o antigo.
2. Rodar `node modules/database/src/cli.js`.
3. Esperar `{"applied_count":3,"phase":"expand","status":"ok"}`. Registrar a
   saída.

As três são expand-only: novos motivos de handoff e `preferred_user_id`
(0046), tabela `crm.automation_turns` e índice de auditoria (0047), colunas de
transcrição e `delivery_failure_code` em `crm.messages` e o evento
`message.transcribed` (0048). Não reescrevem dados.

## 4. Worker

No `silmer-worker`:

- `N8N_INTEGRATION_ENVELOPE_KEY` precisa existir, com o mesmo valor da API: a
  varredura cifra o resumo do handoff.
- `ASSISTANT_STALL_MINUTES` é opcional. Padrão 5; valores fora de 2..60 são
  levados ao limite; valor não numérico impede o worker de subir.
- `ASSISTANT_STALL_SWEEP_INTERVAL_MS` é opcional. Padrão 60000 (mínimo 1000).

A API também lê `ASSISTANT_STALL_MINUTES` para o `stalled_now` do painel. Use
o mesmo valor nos dois serviços.

Depois de reimplantar o worker com as envs, conferir no log que ele subiu e
que o job `automation.stall.sweep` roda a cada intervalo, sem erro. A
varredura só olha mensagens do cliente das últimas 24 h, pela hora em que o
CRM as recebeu (`created_at`).

## 5. Smoke da API

Com um usuário administrador:

- `GET /api/health/ready` responde 200.
- `GET /api/v1/inbox/assistant/performance?days=7` responde 200, com
  `Cache-Control` sem cache e só agregados. A tela `/dashboard/agente`
  ("Desempenho do agente") abre pelo cartão do painel.
- Com um Vendedor, o mesmo endpoint responde 403 (`assistant.performance.read`
  exige `COMMERCIAL_ADMIN`), e a tela não aparece.
- `GET /api/v1/inbox/conversations/:id/assistant-context` numa conversa de
  teste responde 200 (`conversation.read`).
- A Inbox abre conversas e a fila de transferências sem erro.

Com o workflow VND-L02 ainda publicado, mandar uma mensagem de teste pelo
número da equipe e conferir que o bot responde como antes.

## 6. Publicar o workflow `mvp-simple-20`

Publicar como **delta sobre o export vivo**. Nunca importar o snapshot do
repositório: o vivo usa o Evolution, tem a URL do CRM escrita nos nós HTTP
(o n8n 2 bloqueia `$env`) e patches de mídia que o snapshot não tem.

1. Ler o histórico do workflow no n8n logo antes. Confirmar que a versão
   ativa é `cd0de4e8` e salvar o JSON vivo como backup.
2. Comparar o snapshot anterior com o novo
   (`ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json`) e
   aplicar no vivo só o que mudou:
   - os 4 nós novos: `Áudio não lido? (MVP)`,
     `Preparar transcrição do áudio (MVP)`,
     `CRM - Registrar transcrição do áudio (MVP)` e
     `Preparar handoff de falha da IA (MVP)`. O nó HTTP da transcrição usa a
     URL de eventos e a credencial dos nós HTTP do CRM vivos; o preparo de
     falha é código e segue para o `CRM - Registrar handoff (MVP)` existente;
   - os nós do Vendedor que mudaram (contexto, atendente, modelo, decisão,
     preparos de handoff, aviso e reserva);
   - `X-Silmer-Workflow-Version` = `mvp-simple-20` nos nós HTTP do CRM,
     mantendo a URL e a credencial vivas;
   - as conexões dos nós novos e das saídas de erro.
3. Não tocar nos nós do Evolution, de mídia nem nos settings.
4. Reler o `jsCode` gravado de cada nó alterado: o conector MCP transforma
   `\uXXXX` literal no próprio caractere.

## 7. Verificação

- Os nós fora do delta, os settings e as demais conexões iguais ao backup.
- O modelo com `timeout` 30000 e `maxRetries` 1; a transcrição com 30000;
  `executionTimeout` 120.
- Publicar a versão verificada e anotar o `versionId`.
- Mandar mensagens de teste pelo número da equipe: texto (resposta e
  `turn` no painel), áudio (transcrição abaixo do áudio na Inbox), pedido de
  um vendedor pelo nome (primeiro nome na fila) e encerrar a conversa (handoff
  `resolved`).
- Nas horas seguintes, acompanhar no painel os handoffs por motivo,
  `automation_failure` e `stalled_now`.

## Rollback

- **Workflow:** publicar no n8n a versão anterior `cd0de4e8`. Não reenviar
  parâmetros à mão.
- **CRM:** as migrações são expand-only e podem ficar. O CRM anterior não lê
  nem escreve as colunas e a tabela novas. Voltar a imagem da API e do worker
  só se o problema for do CRM, e então desligar a varredura junto (worker
  anterior não a tem).
- Handoffs criados pela varredura ficam na fila como os outros; a conversa não
  volta ao bot (ADR 015).

## Diagnóstico

| Sintoma                                         | Causa provável                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| Bot parou de responder logo após publicar       | Workflow publicado antes das migrações; o CRM responde `400` ou `500`  |
| Worker não sobe                                 | `ASSISTANT_STALL_MINUTES` não numérico ou chave n8n ausente no worker  |
| Inbox ou painel "indisponível" depois do deploy | Migração 0046–0048 pendente (`42703`/`42P01` no corpo da resposta)     |
| `409 TRANSCRIPT_ALREADY_RECORDED`               | Reenvio de transcrição de um áudio já transcrito; esperado, sem efeito |
| Muitos `automation_failure` no painel           | Provedor de IA lento ou fora; conferir o n8n e a OpenAI                |
