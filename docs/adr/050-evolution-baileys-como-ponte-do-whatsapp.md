# ADR 050 — Evolution/Baileys como ponte do WhatsApp

Status: aceita em 29/10/2026 para preparação e integração; homologação real pendente.
Decisor: proprietário, por autorização explícita nesta conversa.
RFC: [039](../rfc/039-evolution-baileys-como-ponte-do-whatsapp.md).
Requisitos: ORC-01..08, INB-01, MSG-01..04; tarefa EVOL-01 / OPS-1 / INT-1/2.
Issue/PR: não foi criada uma issue específica; entrega na branch `codex/evolution-baileys`.

## Decisão

1. Preparar `schedule/silmer-evolution` com Evolution API/Baileys como ponte
   temporária até aprovação da API oficial. A imagem upstream é fixada por
   digest e recebe perfil de privacidade e runtime Node atualizado.
2. Autorizar o PostgreSQL dedicado `schedule/silmer-evolution-db`, banco e
   usuário `silmer_evolution`, sem conexão com o banco CRM. Cache local substitui
   Redis. API sem domínio nem porta pública, uma réplica, usuário não root.
3. Manter WhatsApp → Evolution → n8n → API CRM → Inbox. Reservas antes do envio,
   epoch, revisão, idempotência, persistência antes do ACK e resultado incerto
   sem retry cego continuam obrigatórios. Nenhuma IA ou regra comercial migra
   para o gateway.
4. Criar candidato a partir da jornada atual, preservando alterações posteriores
   ao WAHA. Restaurar somente os nós de transporte de uma baseline Meta quando
   necessário, sem importar essa baseline sobre o fluxo da Meta.
5. Limpar workflows/candidatos WAHA e WPPConnect e diagnósticos obsoletos apenas
   após backup privado e verificação de referências. Preservar todos os fluxos
   Meta e terceiros. Credencial compartilhada não é órfã. Não apagar histórico
   comercial, conversas, pedidos, sessões antigas ou volumes como tentativa.
6. Desativar telemetria e logs brutos; manter autenticação distinta para API e
   webhook. Preservar mensagens necessárias à consulta de mídia/LID somente como
   dados de transporte por sete dias, com expurgo inicial e horário, sem apagar
   instância ou sessão. Esse banco não é fonte oficial de clientes/pedidos.
7. Pareamento exige uma conta disponível e identidade comprovada pelo canal.
   Não comprar número nem conectar conta substituta sem o proprietário. A
   preparação não comprova entrega, estabilidade futura ou menor risco de bloqueio.

Esta decisão supersede a escolha de transporte da ADR 046. As ADRs anteriores
permanecem imutáveis como histórico. A integração oficial em aprovação continua
preservada. Estado operacional e gates no [runbook](../runbooks/evolution-baileys.md).
