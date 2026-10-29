# ADR 045 — Piloto WhatsApp com WPPConnect

Status: aceita em 28/10/2026 para preparação e pareamento; homologação pendente.
Decisão técnica: Tech Lead, executando a autorização do proprietário para
continuar por QR com a nova linha fornecida nesta conversa.
RFC: [033](../rfc/033-pareamento-privado-com-wppconnect.md).
Requisitos: ORC-01..08, INB-01 e MSG-01..04; tarefa WPP-01/OPS-1/INT-1/2.
Issue/PR específica: não criada nesta etapa.

## Decisão

1. Preparar `schedule/silmer-wppconnect` como gateway privado dedicado,
   baseado no Server 2.10.69/core 2.3.6, com fonte fixada, runtime corrigido,
   segredos exclusivos, configuração restrita e sessão em volume privado.
   Não adicionar Redis, banco ou outro sistema de atendimento.
2. Usar somente a nova linha explicitamente fornecida pelo proprietário.
   Não reativar a conta anterior nem o serviço WAHA suspenso. Preservar seus
   volumes e backups. O número esperado é configuração privada, nunca fixture.
3. Gerar QR por utilitário manual privado no n8n, separado do atendimento.
   Não publicar webhook público de QR. A fase de pareamento não habilita
   webhook de mensagens, importação de histórico ou envios automáticos.
4. Manter a versão publicada do atendimento e sua cópia de segurança.
   Preparar um candidato inativo para WhatsApp → WPPConnect → n8n → API CRM
   → Inbox. Reservas, epoch, idempotência, resultado incerto e handoff
   permanecem obrigatórios. Não fazer fallback silencioso entre transportes.
5. Corrigir autenticação e reentrega do webhook, preservar timestamp do
   recebimento entre retries e acrescentar identidade real da sessão.
   Não deduzir telefone de LID ou aceitar o número configurado como prova
   da conta pareada. Logs, QR, tokens e conteúdo não integram artefatos Git.
6. Confirmar conta e homologar canal real antes de cutover. Conexão ou HTTP
   de sucesso não comprovam entrega. Não realizar disparos para testar
   bloqueio nem prometer que um período conectado prevê estabilidade futura.

Esta ADR supersede a escolha de transporte da ADR 043 somente para este novo
piloto. Mantém a exceção limitada à API oficial, n8n obrigatório e contratos
CRM. A conta anterior continua em sua própria condição externa de bloqueio.
O [runbook](../runbooks/wppconnect.md) registra os estados observados e rollback.
