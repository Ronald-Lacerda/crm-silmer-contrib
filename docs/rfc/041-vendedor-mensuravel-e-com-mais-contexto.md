# RFC 041 — Vendedor mensurável e com mais contexto

Status: decidida em 30/10/2026 na
[ADR 052](../adr/052-vendedor-mensuravel-e-com-mais-contexto.md).
Responsável: Tech Lead.
Requisitos: [AGT-01..10, ORC-07..08 e MSG-01..02](../../.specs/features/crm-mvp/spec.md).
Tarefas: AGENTE-FAIL-01, AGENTE-OBS-01, INBOX-HANDOFF-02,
INBOX-AUDIO-TRANSCRIPT-01, VND-CTX-01, INBOX-DELIVERY-02, VND-L03 e
DOC-VND-03 no [plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR específica: a do PR desta mudança.

## Contexto

Em 30/10/2026 o Tech Lead revisou o Vendedor publicado (VND-L02, ADR 051)
e o que o CRM sabe sobre ele. O workflow principal tem 113 nós. Não usa
ferramentas nem memória: as decisões de ritmo, transferência e tom ficam em
nós de código determinísticos, e o modelo só extrai a ficha e escreve a
resposta. Nessa revisão apareceram estes problemas:

- **Ninguém mede o bot.** O n8n de produção não salva execuções, por
  privacidade (`saveDataSuccessExecution` e `saveDataErrorExecution` em
  `none`). O CRM também não registra, por turno, o que o bot perguntou, quanto
  da ficha tinha e por que transferiu. Não dá para saber se uma mudança
  melhorou ou piorou o atendimento.
- **Falha silenciosa.** Quando o modelo, o parser ou o agente falham, ou a
  execução estoura o tempo, o cliente fica sem resposta. O `workflow.failed`
  chega ao CRM com `conversation_id` nulo e não vira handoff. A conversa
  continua em modo assistente sem ninguém atender.
- **Áudio sem texto no CRM.** A transcrição só existe dentro da execução do
  n8n. A Inbox mostra o áudio, mas não o que o bot entendeu, e o histórico
  do próximo turno não traz o texto.
- **Histórico curto demais.** O inbound devolve as últimas 20 mensagens de
  24 horas. Quando a conversa tem mais de um Assunto, o filtro zera o
  histórico. O bot também não sabe se o cliente já comprou antes.
- **Vendedor pedido pelo nome.** O nome só aparece no texto do resumo. O CRM
  não guarda quem foi pedido, e a Inbox não destaca.
- **Handoff que nunca termina.** Encerrar a conversa não muda o handoff para
  `resolved`. A fila e qualquer métrica de tempo ficam erradas.
- **Falha de envio do bot sem código.** A Inbox mostra o código de falha das
  mensagens humanas, mas não o das mensagens do bot.
- **Falsos positivos de transferência** (já listados na ADR 051): e-mail,
  telefone ou link no texto tratados como pedido de contato por outro canal;
  "loja" disparando parceria; "Sim" sozinho na pergunta da arte.
- **Tom.** "Ótima pergunta!" ainda escapa no aviso de preço.
- **Horário.** O aviso de horário comercial ignora feriados (ADR 049).

## Proposta

A proposta é o contrato fixado pelo Tech Lead em 30/10/2026. O CRM muda
primeiro e aceita campos novos, todos opcionais. O workflow só passa a enviá-los
depois. O schema do CRM continua estrito: campo desconhecido é recusado.

1. **Falha vira handoff (AGENTE-FAIL-01).** No workflow, erro do modelo, do
   parser ou do agente vai para a saída de erro do nó e vira
   `handoff.requested` com motivo novo `automation_failure`, epoch e revisão
   do inbound e um aviso fixo ao cliente. O modelo ganha timeout de 30 s e um
   retry; a transcrição, timeout de 30 s. O pior caso cabe nos 120 s da
   execução. No CRM, um job do worker varre conversas paradas a cada 60 s:
   modo assistente, abertas, com a última mensagem do cliente sem resposta do
   bot há mais de `ASSISTANT_STALL_MINUTES` (padrão 5, de 2 a 60) e sem
   handoff ativo. Cada uma ganha, na mesma transação, handoff sem dono com
   `automation_failure`, resumo fixo do CRM, modo humano, estado
   `requer_atencao`, epoch incrementado, histórico e auditoria. Esse caminho
   não avisa o cliente, porque o CRM não envia mensagens sozinho. Rodar duas
   vezes não cria dois handoffs.
2. **Telemetria por turno (AGENTE-OBS-01).** `message.send.requested` e
   `handoff.requested` aceitam o objeto opcional `turn`, só com códigos,
   contagens e tempos: ponto perguntado, como o cliente respondeu, pontos da
   ficha, gatilho, modelo, latência e tipo de mídia. O CRM grava em
   `crm.automation_turns`, sem duplicar no replay. Um painel do administrador
   ("Desempenho do agente") lê só agregados de uma janela de 1 a 90 dias. A conversa ganha
   uma leitura do último turno para a Inbox.
3. **Handoff completo (INBOX-HANDOFF-02).** Encerrar a conversa resolve o
   handoff ativo na mesma transação. `handoff.requested` aceita
   `requested_seller_id`, validado contra os vendedores ativos; o CRM grava em
   `preferred_user_id` e a Inbox mostra o primeiro nome. O handoff continua
   sem dono. Parceria e revenda ganham o motivo próprio `partnership`.
4. **Transcrição no CRM (INBOX-AUDIO-TRANSCRIPT-01).** Evento novo
   `message.transcribed`, com texto ou código de falha. O texto tem a mesma
   proteção e retenção das mensagens de entrada. A Inbox mostra a
   transcrição, e o histórico do agente usa o texto no lugar do áudio.
5. **Mais contexto (VND-CTX-01).** Cada mensagem do histórico traz os
   `subject_ids` em vez de ser filtrada por Assunto. O inbound devolve
   `contact_context` do cliente recorrente: ciclos anteriores, último
   desfecho e até 3 pedidos anteriores, sem valores, endereço, financeiro ou
   arquivos.
6. **Código de falha do bot (INBOX-DELIVERY-02).** `message.failed` e
   `message.send.unknown` aceitam `failure.code`. O CRM grava o código na
   mensagem, e a Inbox o usa para mensagens do bot.
7. **Workflow (VND-L03).** Consome os itens acima, reduz os falsos positivos,
   tira "Ótima pergunta!" do aviso de preço e inclui feriados no aviso de
   horário.

Os detalhes de campos, limites e códigos estão na ADR 052.

## Alternativas consideradas

- **Salvar execuções no n8n:** rejeitado. A execução guarda texto, nome,
  telefone e mídia do cliente fora do CRM, sem a retenção e o controle de
  acesso do CRM. A telemetria por turno mede o mesmo sem PII.
- **Memória do LangChain no agente:** rejeitada. O n8n não mantém cópia
  paralela de conversa nem memória curta (ADRs 002 e 003); o histórico vem
  sempre do CRM.
- **Agente com ferramentas (tools):** adiado. Daria autonomia ao modelo, mas
  pede uma avaliação própria, e as decisões determinísticas atuais têm testes.
  A telemetria desta rodada é a base para comparar.
- **Catálogo para o agente:** adiado para RFC própria. Os kits atuais
  funcionam e têm testes.
- **Só alertar a equipe, sem handoff, na falha:** rejeitado. A conversa
  continuaria em modo assistente, e a Inbox não a mostraria na fila de
  transferências.
- **CRM enviar o aviso ao cliente na varredura:** rejeitado. O CRM não envia
  mensagens sozinho; toda mensagem passa pela reserva de envio do n8n.

## Riscos

- Ordem de implantação: se o workflow novo for publicado antes do CRM, os
  campos novos dão `400` e o bot para de responder. Mitigação: CRM e
  migração antes da publicação; cada campo é opcional.
- A varredura pode transferir uma conversa que o bot ainda responderia
  devagar. O epoch incrementado descarta a resposta atrasada pelo fence.
- `automation_failure` aumenta a fila humana quando o provedor oscila. O
  painel mostra esse motivo separado.
- A transcrição é dado pessoal novo no banco. Ela segue a proteção e a
  retenção do texto das mensagens de entrada.
- A telemetria pode ganhar texto livre por engano. Mitigação: objeto estrito,
  padrões fechados para cada campo e teste de recusa.

## Plano de implantação

1. Merge do CRM (API, worker e Inbox) com os campos novos opcionais.
2. Migração manual das 0046, 0047 e 0048 no console da API, logo depois do
   deploy.
3. Conferir que o workflow publicado (VND-L02) continua funcionando com o CRM
   novo.
4. Conferir o worker com `N8N_INTEGRATION_ENVELOPE_KEY` e, se o padrão não
   servir, `ASSISTANT_STALL_MINUTES`.
5. Publicar o workflow VND-L03 no n8n com backup, verificação e versão de
   rollback, autorizado pelo proprietário (ADR 044).
6. Observar as primeiras conversas pelo painel "Desempenho do agente"
   (`/dashboard/agente`).

O passo a passo está no
[runbook da VND-L03](../runbooks/vendedor-l03-implantacao.md).

O Evolution como transporte do WhatsApp (ADR 050 / RFC 039) está em
integração em outro PR e não muda este contrato.
