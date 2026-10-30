# Conferência de falhas de envio na Inbox

Rastreabilidade: INBOX-DELIVERY-01, OPS-INBOX-ACK-01, MSG-02/03, ORC-08,
INBOX-3 e INT-2. O contrato de reserva e idempotência permanece vigente.

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
