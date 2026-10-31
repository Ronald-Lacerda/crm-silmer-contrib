# Implantação do Vendedor VND-L03

Decisão: [ADR 052](../adr/052-vendedor-mensuravel-e-com-mais-contexto.md)
([RFC 041](../rfc/041-vendedor-mensuravel-e-com-mais-contexto.md)).
Tarefas: AGENTE-FAIL-01, AGENTE-OBS-01, INBOX-HANDOFF-02,
INBOX-AUDIO-TRANSCRIPT-01, VND-CTX-01, INBOX-DELIVERY-02 e VND-L03 no
[plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Contrato: [integração n8n](../integrations/n8n/README.md), seções "Campos da
ADR 052" e "VND-L03".

A implantação tem três etapas, nesta ordem:

1. **Migrações.** Um PR só com as migrações 0046, 0047 e 0048: merge, deploy
   e aplicação no console.
2. **Código.** O PR da API, do worker e da Inbox.
3. **Workflow.** Publicação do `mvp-simple-20` no n8n.

A ordem não muda. O código novo lê colunas da 0048 já no inbound: se a API
nova subir antes da migração, mensagens de clientes se perdem. As migrações
são expand-only e compatíveis com a release atual, então podem entrar antes
do código sem efeito para quem usa o CRM. O workflow publicado hoje (VND-L02,
versão `cd0de4e8`) funciona com o CRM novo.

Registre em cada passo só SHA, versão, contagens e códigos. Nunca registre
texto de cliente, nome, telefone, chave ou URL com token.

## Antes de começar

- Os dois PRs prontos e rebaseados sobre `master`, com o CI verde: o PR das
  migrações e o PR do código.
- Gates locais executados, inclusive `node --test --test-concurrency=1 test/vendedor-evolucao-postgres-live.test.js` (PostgreSQL
  real, dados sintéticos).
- Autorização do proprietário para publicar o workflow principal.
- Backup do export vivo do workflow principal no n8n (113 nós, adaptado ao
  Evolution).
- Janela fora do pico: as migrações não usam `NOT VALID` nem
  `CONCURRENTLY`, o que é aceito pelo volume do piloto.

## Etapa 1 — Migrações 0046–0048

1. Mergear o PR das migrações em `master`. Anotar o SHA.
2. Conferir no EasyPanel que `silmer-api`, `silmer-worker` e
   `silmer-edge-web` estão nesse SHA (ADR 022). A API já esteve com Auto
   Deploy desligado ([topologia](../../EASYPANEL-TOPOLOGY.md), "Merge e
   promoção"); se ela não subiu sozinha, implantar à mão.
3. No console do `silmer-api`:
   - `ls modules/database/migrations | tail -3` deve listar
     `0046_handoff_reasons_preferred_seller.expand.sql`,
     `0047_automation_turns.expand.sql` e
     `0048_message_transcript_delivery_code.expand.sql`. Se não listar, o
     container ainda é o antigo.
   - Rodar `node modules/database/src/cli.js`.
   - Esperar `{"applied_count":3,"phase":"expand","status":"ok"}`. Registrar
     a saída.
4. Conferir que a Inbox, o painel e o bot (VND-L02) seguem normais.

As três são expand-only: novos motivos de handoff e `preferred_user_id`
(0046), tabela `crm.automation_turns` e índice de auditoria (0047), colunas de
transcrição e `delivery_failure_code` em `crm.messages` e o evento
`message.transcribed` (0048). Não reescrevem dados. A release atual não lê
nem escreve nada disso.

## Etapa 2 — Código

### Envs antes do deploy

No `silmer-worker`:

- `N8N_INTEGRATION_ENVELOPE_KEY` precisa existir, com o mesmo valor da API: a
  varredura cifra o resumo do handoff.
- `ASSISTANT_STALL_MINUTES` é opcional. Padrão 5; fora de 2..60 é levado ao
  limite; valor não numérico impede o worker de subir.
- `ASSISTANT_STALL_SWEEP_INTERVAL_MS` é opcional. Padrão 60000 (mínimo 1000).

Na `silmer-api`, `ASSISTANT_STALL_MINUTES` é lida para o cartão do painel
inicial e o `stalled_now` do desempenho. Use o mesmo valor nos dois serviços.

A tolerância para resposta presa em `sending` é de 2 minutos
(`ASSISTANT_SENDING_GRACE_MINUTES`, fixa no código desta versão).

### Merge e deploy

1. Mergear o PR do código em `master`. Anotar o SHA.
2. Conferir os três serviços nesse SHA, como na etapa 1.
3. No log do `silmer-worker`, conferir a subida e, a cada intervalo, a linha
   `automation_stall_sweep_completed` com `candidates`, `handed_off` e
   `failed`. `failed` maior que zero vem junto de `worker_job_failed` com
   `job_type` `automation.stall.sweep` e o código do erro; a falha de uma
   conversa não interrompe o lote.

A varredura transfere a conversa em modo assistente, aberta, sem handoff
ativo, cuja revisão de entrada mais recente não teve resposta efetiva. Isso
acontece quando a revisão não foi consumida ou foi consumida por resposta
`failed`, `outcome_unknown` ou presa em `sending`. A última mensagem do
cliente precisa ser mais antiga que `ASSISTANT_STALL_MINUTES` e das últimas
24 h.

### Smoke da API

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

## Etapa 3 — Publicar o workflow `mvp-simple-20`

Publicar como **delta sobre o export vivo**. Nunca importar o snapshot do
repositório: o vivo usa o Evolution, tem a URL do CRM escrita nos nós HTTP
(o n8n 2 bloqueia `$env`) e patches de mídia que o snapshot não tem.

1. Ler o histórico do workflow no n8n logo antes. Confirmar que a versão
   ativa é `cd0de4e8` e salvar o JSON vivo como backup.
2. Comparar o snapshot anterior com o novo
   (`ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json`, 95 nós)
   e aplicar no vivo só o que mudou:
   - os 5 nós novos: `Áudio não lido? (MVP)`,
     `CRM aceita a transcrição? (MVP)`,
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
3. A resposta do `CRM - Registrar inbound (MVP)` e do `CRM - Reler conversa
(MVP)` precisa chegar aos nós seguintes com a chave `contact_context`. Os
   campos novos só saem quando ela existe; sem ela, o workflow fica no modo
   da `mvp-simple-19`. O gerador do Evolution precisa copiar os 5 nós novos e
   preservar essa chave.
4. Não tocar nos nós do Evolution, de mídia nem nos settings.
5. Reler o `jsCode` gravado de cada nó alterado: o conector MCP transforma
   `\uXXXX` literal no próprio caractere.

### Verificação

- Os nós fora do delta, os settings e as demais conexões iguais ao backup.
- O modelo com `timeout` 30000 e `maxRetries` 1; a transcrição com 30000;
  `executionTimeout` 120.
- Publicar a versão verificada e anotar o `versionId`.
- Mandar mensagens de teste pelo número da equipe:
  - texto: o bot responde e o turno aparece no painel;
  - áudio: a transcrição aparece abaixo do áudio na Inbox;
  - pedido de um vendedor pelo nome: o primeiro nome aparece na fila;
  - encerrar a conversa: o handoff fica `resolved`.
- Nas horas seguintes, acompanhar no painel os handoffs por motivo,
  `automation_failure` e `stalled_now`, e no worker a linha
  `automation_stall_sweep_completed`.

## Rollback

- **Workflow:** publicar no n8n a versão anterior `cd0de4e8`. Não reenviar
  parâmetros à mão.
- **Código:** voltar a imagem da API e do worker para o SHA da etapa 1. A
  varredura sai junto, porque o worker anterior não a tem.
- **Migrações:** são expand-only e ficam. A release anterior não lê nem
  escreve as colunas e a tabela novas.
- Handoffs criados pela varredura ficam na fila como os outros; a conversa não
  volta ao bot (ADR 015).

## Diagnóstico

| Sintoma                                            | Causa provável                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Worker não sobe                                    | `ASSISTANT_STALL_MINUTES` não numérico ou chave n8n ausente no worker          |
| `failed` > 0 em `automation_stall_sweep_completed` | Erro numa conversa do lote (por exemplo, lock); ver `worker_job_failed`        |
| Turnos não aparecem no painel após publicar        | Inbound vivo sem `contact_context`: o workflow está no modo da `mvp-simple-19` |
| `409 TRANSCRIPT_ALREADY_RECORDED`                  | Reenvio de transcrição de um áudio já transcrito; esperado, sem efeito         |
| Muitos `automation_failure` no painel              | Provedor de IA lento ou fora; conferir o n8n e a OpenAI                        |
