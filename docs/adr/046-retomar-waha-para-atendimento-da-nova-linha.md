# ADR 046 — Retomar WAHA para atendimento da nova linha

Status: aceita em 28/10/2026; pareamento e homologação pendentes.
Decisão técnica: Tech Lead, executando a orientação do proprietário de conectar
a nova linha ao atendimento real da Inbox, preservando o fluxo existente.
RFC: [034](../rfc/034-retomar-waha-para-atendimento-da-nova-linha.md).
Requisitos: [ORC-01..08, INB-01 e MSG-01..04](../../.specs/features/crm-mvp/spec.md).
Tarefas: WAHA-01D / WPP-01 / OPS-1 no
[plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR específica: não criada nesta etapa.

## Contexto

O proprietário esclareceu que a nova linha será usada na Caixa de Entrada real
da Silmer, não em um atendimento de teste separado. O WPPConnect foi preparado
conforme a [ADR 045](045-piloto-whatsapp-wppconnect.md), mas seu Chromium falhou
ao criar namespaces com `EPERM`. O serviço foi parado antes de parear qualquer
conta. Não houve aprovação ou aplicação de `--no-sandbox`.

O WAHA/WEBJS já instalado foi retomado para a nova linha com volumes novos de
sessão e mídia. Os volumes da conta anterior bloqueada foram preservados e
essa conta não voltou ao atendimento. A falha de pareamento da nova linha não
comprova o mesmo bloqueio nem identifica sua causa.

## Decisão

1. Pausar o trabalho operacional WPP-01 e manter `schedule/silmer-wppconnect`
   parado, preservando fonte, configuração, volume e evidências. Não ampliar
   privilégios, alterar o host ou desligar o sandbox para prosseguir por tentativa.
2. Retomar `schedule/silmer-waha` com WEBJS para conectar a nova linha à Inbox
   real. Usar volumes novos de sessão e mídia, mantendo separados os volumes e
   a condição externa da conta anterior. O número esperado continua privado.
3. Regenerar o candidato inativo a partir do workflow principal atual,
   preservando domínio, jornada, site, notas, credenciais e webhooks existentes.
   O principal publicado continua intacto até a confirmação da conta e os gates
   de cutover. Não ativar dois consumidores ou duas rotas de envio da mesma linha.
4. Usar somente o utilitário manual privado de QR para pareamento. QR não é
   webhook público nem dispara CRM, IA ou envios. O celular recusou duas
   tentativas; a API ainda informava `SCAN_QR_CODE`, mas o screenshot nativo
   mostrou QR expirado. A sessão nova vazia foi reiniciada e um QR novo obtido,
   aguardando resposta do proprietário. Não declarar a
   conta conectada ou a integração concluída com base na exibição do QR.
5. Manter n8n obrigatório, API do CRM como fonte oficial, autenticação,
   correlação verificável de identidade, reservas de uso único, epoch/revisão,
   idempotência, handoff e tratamento de resultado incerto. Não fazer fallback
   silencioso para WPPConnect, Meta ou a conta anterior.

## Relação com decisões anteriores

Esta ADR supersede a escolha e a proibição de retomada do serviço WAHA da
ADR 045 somente para a nova linha autorizada; o registro da ADR 045 permanece
imutável. Retoma a fronteira de transporte da
[ADR 043](043-piloto-whatsapp-waha-webjs.md), sem reativar a conta bloqueada.
Não cria Inbox paralela, domínio de teste, novo banco ou Redis. O objetivo é
atendimento real, e sua liberação continua dependendo de evidência operacional.

## Consequências e aceite

WAHA-01D permanece aberta: confirmar a identidade real, receber uma nova
mensagem na Inbox, responder pelo fluxo, validar handoff/takeover, status,
replay e resultado incerto antes de concluir o cutover. A alternativa de
transporte não comprova menor taxa de bloqueio nem garante estabilidade futura.
O [runbook WAHA](../runbooks/waha-webjs.md) registra o estado atual; o
[runbook WPPConnect](../runbooks/wppconnect.md) preserva a preparação suspensa.
