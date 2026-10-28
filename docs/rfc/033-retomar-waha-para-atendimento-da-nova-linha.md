# RFC 033 — Retomar WAHA para atendimento da nova linha

Status: decidida em 28/10/2026 na
[ADR 045](../adr/045-retomar-waha-para-atendimento-da-nova-linha.md).
Responsável: Tech Lead. Objetivo confirmado pelo proprietário: nova linha no
atendimento real da Caixa de Entrada, preservando o fluxo n8n existente.
Requisitos: [ORC-01..08, INB-01 e MSG-01..04](../../.specs/features/crm-mvp/spec.md).
Tarefas: WAHA-01D / WPP-01 / OPS-1 no
[plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR específica: não criada nesta etapa.

## Contexto e alternativas

O WPPConnect preparado pela RFC 032/ADR 044 passou pelo build e pelas checagens
da API privada, mas o Chromium falhou em namespaces com `EPERM`. A instalação
do helper oficial de sandbox não comprovou browser operacional. Não houve
pareamento WPPConnect nem aprovação ou aplicação de `--no-sandbox`.

As alternativas eram continuar investigando essa fronteira de namespaces ou
retomar o WAHA/WEBJS existente para a nova linha. A escolha operacional foi
retomar WAHA, mantendo WPPConnect parado e sem alterar o host ou seus controles.
O proprietário esclareceu que a linha deve atender na Inbox real; o utilitário
privado de QR é somente preparação desse canal, não um atendimento paralelo.

## Resultado e ações

Retomar o serviço WAHA existente com volumes novos de sessão e mídia e manter
os volumes anteriores preservados. A conta bloqueada anterior continua sem uso.
O candidato inativo `WahaSilmerPilot01` foi atualizado da fonte atual de 92 nós
para 101, com o número esperado em configuração privada. O principal publicado
`k7tI6T4RhQPyJkn9` permaneceu intacto, sem cutover.

O utilitário manual privado `WahaPairSilmerNew01` exibiu QR. O celular recusou
a tentativa com “não foi possível conectar o dispositivo” duas vezes. O
screenshot autenticado mostrou QR expirado, embora a sessão ainda retornasse
`SCAN_QR_CODE`, sem identidade. A sessão nova vazia foi reiniciada e um QR novo
obtido; a resposta do proprietário está pendente. Esses estados não comprovam identidade,
recebimento na Inbox ou entrega de resposta e não identificam a causa da recusa.

Manter WAHA-01D aberta até confirmar conta, entrada e resposta reais, status,
handoff/takeover e idempotência. Conservar reservas e API do CRM e não publicar
o candidato em paralelo nos mesmos webhooks. A nova decisão não autoriza
reativar a conta bloqueada ou testar envios por tentativa. Estado e recuperação
nos [runbooks WAHA](../runbooks/waha-webjs.md) e
[WPPConnect](../runbooks/wppconnect.md).
