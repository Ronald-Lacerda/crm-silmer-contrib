# ADR 052 — Vendedor mensurável e com mais contexto

Data: 30/10/2026. Status: aceita; contrato fixado pelo Tech Lead em
30/10/2026.
Proposta: [RFC 041](../rfc/041-vendedor-mensuravel-e-com-mais-contexto.md).
Requisitos: [AGT-01..10, ORC-07..08 e MSG-01..02](../../.specs/features/crm-mvp/spec.md).
Tarefas: AGENTE-FAIL-01, AGENTE-OBS-01, INBOX-HANDOFF-02,
INBOX-AUDIO-TRANSCRIPT-01, VND-CTX-01, INBOX-DELIVERY-02, VND-L03 e
DOC-VND-03 no [plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Complementa as ADRs 009, 015, 049 e 051; não as supersede.

## Decisão

1. **Campos novos opcionais e ordem de implantação.** Todo campo novo é
   opcional, e o schema continua estrito: campo desconhecido é recusado. O
   workflow publicado hoje (VND-L02) continua funcionando com o CRM novo.
   A implantação tem duas etapas antes do n8n: primeiro um PR só com as
   migrações 0046, 0047 e 0048, implantado e aplicado no console; depois o PR
   do código, que lê as colunas da 0048 já no inbound. Por último, a
   publicação do workflow. As migrações são expand-only e compatíveis com a
   release atual.
   O workflow só envia os campos novos (`turn`, `requested_seller_id`,
   `automation_failure`, `partnership` e `message.transcribed`) quando a
   resposta do inbound traz a chave `contact_context`. Contra um CRM antigo
   ele volta ao comportamento da `mvp-simple-19`, e o bot continua
   respondendo.
2. **Motivos novos de handoff (migração 0046).** `reason_code` ganha
   `automation_failure` e `partnership`, no padrão expand-only da 0025.
   `crm.handoffs` ganha `preferred_user_id`, nulo, com FK para usuários; é
   `text` porque `crm.users.id` é `text`.
3. **Falha vira handoff (AGENTE-FAIL-01).**
   - No workflow, erro do modelo, do parser ou do agente segue pela saída de
     erro do nó e vira `handoff.requested` com `automation_failure`, epoch e
     revisão do inbound e um aviso fixo ao cliente. O modelo tem timeout de
     30 s e um retry; a transcrição, timeout de 30 s. O pior caso cabe nos
     120 s da execução.
   - No worker, o job `automation.stall.sweep` roda a cada 60 s. Ele pega a
     conversa em modo `assistant`, aberta e não arquivada, sem handoff ativo,
     cuja revisão de entrada mais recente não teve resposta efetiva: ainda
     não foi consumida (`inbound_revision > claimed_revision`) ou foi
     consumida por resposta `failed`, `outcome_unknown` ou presa em `sending`
     há mais de 2 minutos. A última mensagem do cliente precisa ser mais
     antiga que `ASSISTANT_STALL_MINUTES` (padrão 5, de 2 a 60) e das
     últimas 24 h, pela hora em que o CRM a recebeu.
   - A falha de uma conversa não interrompe o lote. O worker registra
     `automation_stall_sweep_completed` com `candidates`, `handed_off` e
     `failed`. O cartão do painel inicial usa a mesma regra e a mesma env.
   - Para cada uma, na mesma transação e com lock da conversa: handoff sem
     dono com `automation_failure` e o resumo cifrado "O assistente não
     respondeu a tempo. Confira a última mensagem do cliente."; modo humano;
     estado `requer_atencao`; epoch incrementado; histórico do handoff e
     auditoria. O epoch novo descarta resposta atrasada do bot pelo fence.
   - Esse caminho não avisa o cliente. Repetir a varredura não cria outro
     handoff.
4. **Telemetria por turno (AGENTE-OBS-01, migração 0047).**
   - `message.send.requested` e `handoff.requested` aceitam o objeto
     opcional e estrito `turn`: `asked_field`, `answer_status`,
     `ficha_filled`, `ficha_total`, `trigger`, `model`, `latency_ms` e
     `media_kind`. `ficha_filled` e `ficha_total` são obrigatórios dentro de
     `turn`. Cada campo tem padrão ou faixa fechada; chave desconhecida dá
     `400`.
   - O CRM grava em `crm.automation_turns`, uma linha por evento do n8n
     (`n8n_event_id` único), com versão do workflow e motivo do handoff.
     Replay não duplica.
   - `GET /api/v1/inbox/assistant/performance?days=7` (1 a 90) devolve só
     agregados: conversas e respostas do bot, handoffs por motivo, ficha no
     handoff, tempo até assumir e até resolver, falhas por tipo, turnos por
     versão do workflow e conversas paradas agora. `null` quando não houver
     amostra. Sem cache. Exige a ação nova `assistant.performance.read`
     (`COMMERCIAL_ADMIN`). A recusa pelo fence (`stale_fence`) é contada pela
     auditoria.
   - `GET /api/v1/inbox/conversations/:id/assistant-context` devolve o último
     turno e as mensagens do bot contra o teto, com `conversation.read` e sem
     cache.
   - Nenhum campo de telemetria carrega texto do cliente, nome, telefone ou
     conteúdo. Só códigos, contagens e tempos.
5. **Handoff completo (INBOX-HANDOFF-02).**
   - Todo caminho que encerra a conversa (`concluido`, `sem_pedido` ou outro
     que preencha `terminal_at`) leva o handoff ativo a `resolved`, com
     `resolved_at` e histórico (`conversation_closed`), na mesma transação.
     Handoff sem dono fica com quem encerrou como responsável, porque o CHECK
     da 0013 exige dono em `resolved`.
   - `handoff.requested` aceita `requested_seller_id`. Se ele estiver entre os
     vendedores ativos que o inbound devolve, o CRM grava em
     `preferred_user_id`; se não, ignora, registra e cria o handoff mesmo
     assim, com a auditoria `PREFERRED_SELLER_NOT_ACTIVE`. A lista da Inbox
     mostra o primeiro nome em `handoff.preferredSellerFirstName`; a leitura
     do handoff devolve `preferred_seller` ao lado de `handoff`.
   - O motivo `partnership` substitui `human_requested` para parceria e
     revenda (ADR 051, item 7).
6. **Transcrição no CRM (INBOX-AUDIO-TRANSCRIPT-01, migração 0048).**
   - Evento novo `message.transcribed`, com `status` `ok` e texto de até 4000
     caracteres, ou `failed` e um código (`TRANSCRIPTION_FAILED`,
     `TRANSCRIPTION_EMPTY` ou `AUDIO_TOO_LARGE`). Só vale para mensagem de
     entrada, de áudio e da mesma conversa, achada pelo `external_message_id`
     do inbound. É idempotente; a mesma chave com outro payload dá conflito.
     Um `failed` pode virar `ok`; um `ok` não é substituído.
   - O texto tem a mesma proteção e retenção do texto das mensagens de
     entrada: cifrado com a chave das mensagens.
   - No histórico do agente, o áudio transcrito vem como texto com
     `transcribed: true`. Na Inbox, a mensagem de áudio mostra a transcrição.
7. **Mais contexto (VND-CTX-01).**
   - Cada item de `recent_messages` traz `subject_ids`, vazio quando não
     houver vínculo, para o workflow filtrar pelo Assunto sem zerar o
     histórico.
   - O inbound devolve `contact_context` só com `previous_cycles`,
     `previous_orders_count` (0 a 99, sem pedidos de teste nem os desta
     conversa) e `last_closed_at` (data em São Paulo). Lista de pedidos e
     desfecho saíram por minimização (RULES 8 e 13). O prompt recebe só
     "Cliente recorrente: já foi atendido pela Silmer antes."
8. **Código de falha do bot (INBOX-DELIVERY-02).** `crm.messages` ganha
   `delivery_failure_code` (migração 0048). `message.failed` e
   `message.send.unknown` aceitam `failure.code`; código ausente ou fora do
   padrão vira `SEND_FAILED` no `message.failed` e `SEND_OUTCOME_UNKNOWN` no
   `message.send.unknown`. Um `sent` ou `delivered` posterior limpa o código.
   Mensagens do bot usam esse código na Inbox; as humanas continuam com o
   código do comando.
9. **Workflow (VND-L03).** O workflow consome os itens acima, reduz os falsos
   positivos de transferência (e-mail, telefone ou link; "loja"; "Sim" na
   pergunta da arte; contar que passou pelo Instagram), transfere pedido
   repetido ("igual da última vez"), tira "Ótima pergunta!" do aviso de preço
   e inclui feriados no aviso de horário.

O catálogo para o agente fica fora desta decisão e terá RFC própria. Agente
com ferramentas e memória no n8n também ficam fora (RFC 041).

## O que não muda

- A conversa transferida não volta ao bot (ADR 015). A varredura também só
  leva para o humano.
- O handoff nasce sem dono. O claim continua atômico para qualquer Vendedor;
  o vendedor pedido é só preferência.
- O n8n não acessa o banco do CRM nem guarda memória paralela (ADRs 002 e
  003). Tudo passa pelos endpoints autenticados e idempotentes.
- O CRM não envia mensagem ao cliente sem a reserva de envio do n8n.
- Execuções do n8n de produção continuam sem salvar dados.

## Consequências

- O CRM passa a medir o bot sem guardar conversa fora dele. Comparar versões
  do workflow vira leitura do painel.
- Falha do modelo ou do n8n deixa de ser silenciosa: vira handoff pelo
  workflow ou, no limite, pela varredura do worker.
- A fila humana pode crescer com `automation_failure` quando o provedor
  oscila; o motivo aparece separado no painel.
- A transcrição passa a ser dado pessoal guardado no CRM, com a política das
  mensagens de entrada.
- A implantação tem duas etapas no CRM (migrações, depois código) e só então
  a publicação do workflow VND-L03, com backup e verificação (ADR 044).
- Encerrar uma conversa com handoff sem dono deixa como dono quem encerrou,
  sem a checagem de elegibilidade do claim. O tempo até assumir usa só
  handoffs `accepted`.
- O caminho `failed` → `ok` da transcrição existe no CRM, mas o workflow
  atual não o percorre: a chave do evento é fixa por mensagem.
- Follow-up: o retry do inbound que recebe `duplicate: true` não continua o
  turno; hoje a varredura cobre esse caso. As migrações não usam `NOT VALID`
  nem `CONCURRENTLY`, aceito pelo volume do piloto; rodar fora do pico.
- O transporte do WhatsApp pelo Evolution (ADR 050) está em integração em
  outro PR e não altera este contrato.
