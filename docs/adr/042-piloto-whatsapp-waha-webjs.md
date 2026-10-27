# ADR 042 — Piloto WhatsApp com WAHA e WEBJS

Status: aceita em 27/10/2026; implantação e homologação exigem evidência própria.
Decisor: proprietário, autorização explícita nesta conversa.
RFC: [030](../rfc/030-piloto-whatsapp-waha-webjs.md).
Requisitos: [ORC-01..08, INB-01 e MSG-01..04](../../.specs/features/crm-mvp/spec.md).
Tarefa: WAHA-01, vinculada a INBOX-2/3, AGENTE-6, OPS-1 e INT-1/2 no
[plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR: nenhum vínculo específico informado nesta etapa.

## Contexto

O proprietário escolheu WAHA com WEBJS para conectar uma linha temporária à
Inbox da Silmer e autorizou sua instalação no EasyPanel. Ele pediu preservar o
workflow n8n já construído. A escolha é uma exceção explícita à exigência de
API oficial para o transporte WhatsApp do primeiro MVP.

## Decisão

1. Usar WAHA com o motor WEBJS como gateway dedicado da linha temporária.
   Instalar no EasyPanel com imagem identificada, sessão persistente privada,
   autenticação e comunicação interna entre serviços. Não adicionar Redis,
   outro banco ou outro sistema de atendimento por essa decisão.
2. Manter o percurso WhatsApp → WAHA → n8n → API do CRM → Inbox e o retorno
   CRM → n8n → WAHA → WhatsApp. O CRM continua sendo a fonte oficial; WAHA
   não acessa seu banco nem decide regras comerciais. Preservar IA, pedidos,
   chat do site, handoff, autorização, idempotência e auditoria existentes.
3. Preservar a versão anterior e uma cópia de segurança do workflow antes da
   adaptação. Publicar somente uma rota de processamento/envio para essa linha.
   Não migrar ou alterar a conta comercial anterior nem o onboarding Meta dela.
4. Validar sessão e conta recebidas. Ignorar mensagens próprias, grupos e
   status de transmissão como entradas de atendimento; tratar confirmação de
   entrega separadamente. Não deduzir telefone de `@lid`, nome ou conteúdo.
   Correlação de identidade exige evidência verificável.
5. Conservar a reserva de uso único `message.send.requested`, com
   `automation_epoch` e `source_revision`, antes de qualquer envio pelo gateway.
   Timeout posterior vira resultado incerto; replay não autoriza novo envio.
   Não usar o caminho Meta como fallback silencioso.
6. Limitar o piloto ao atendimento solicitado pelo cliente. Não implementar
   disparos em massa, prospecção fria, troca de identidade ou mecanismos para
   contornar restrições. Não prometer menor taxa de banimento ou ausência de
   bloqueio. Instalação e pareamento não equivalem a homologação.

## Relação com decisões anteriores

Esta decisão supersede, exclusivamente para a linha temporária desse piloto,
a exigência de API oficial descrita em `RULES.md`, ORC-02 e MSG-04. Preserva
as fronteiras das [ADRs 003](003-adotar-integracao-n8n-mvp-simples.md),
[015](015-conversa-nao-volta-para-o-bot.md),
[021](021-adotar-openai-no-mvp.md) e
[022](022-manter-deploy-automatico-github-easypanel.md).
Não altera as regras de Pedido, as permissões humanas ou os gates de
privacidade, mídia, impressão e recuperação.

## Consequências

A operação passa a depender também da sessão do WhatsApp Web e de alterações
do protocolo. Bloqueio ou desconexão do canal devem ser visíveis e não podem
ser apresentados como mensagens recuperadas. A API do gateway e seus arquivos
de sessão são recursos sensíveis; chaves, QR codes e conteúdo de conversas não
entram em commits ou logs de diagnóstico.

O [runbook](../runbooks/waha-webjs.md) define instalação, homologação e rollback.
Voltar à versão anterior exige pausar a rota WAHA e reconciliar efeitos incertos;
não restaura banco, reenvia comandos antigos ou reativa uma conta automaticamente.
