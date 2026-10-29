# RFC 039 — Evolution/Baileys como ponte do WhatsApp

Data: 29/10/2026. Status: decidida na [ADR 050](../adr/050-evolution-baileys-como-ponte-do-whatsapp.md).
Decisor: proprietário, autorização explícita nesta conversa.
Requisitos: ORC-01..08, INB-01, MSG-01..04; tarefa EVOL-01 / OPS-1 / INT-1/2.
Issue/PR: não foi criada uma issue específica; entrega na branch `codex/evolution-baileys`.

## Problema e alternativas

O proprietário relatou dois números bloqueados em menos de 24 horas com o
transporte WAHA. A causa dos bloqueios não foi determinada. A API oficial está
em aprovação; foi solicitada uma ponte temporária Evolution API com Baileys,
integrada ao n8n e à Inbox, e a limpeza dos artefatos WAHA e candidatos perdidos.
O fluxo da Meta deve ser preservado.

WPPConnect continua dependendo de Chromium, cujo namespace falhou no ambiente.
WAHA/GOWS dispensaria o navegador, mas conservaria o gateway anterior.
Evolution/Baileys muda essa implementação e oferece REST/eventos; não há
evidência de menor taxa de bloqueio. Sua persistência exige banco exclusivo.

## Proposta aprovada

- Evolution fixada por digest, API privada e banco PostgreSQL exclusivo,
  separados do CRM e do n8n; cache local, sem Redis.
- Manter jornada, IA, reservas, takeover, webhooks comerciais e API do CRM.
  Trocar somente a fronteira do transporte, com candidato inativo antes do cutover.
- Suprimir logs brutos, QR e segredos; webhook autenticado com destino fixo.
  Mensagens de transporte expiram após sete dias, com expurgo horário.
- Exportar backups privados antes da limpeza, selecionar recursos por identidade
  e referências, e preservar fluxos/credenciais Meta e terceiros.
- Não conectar conta bloqueada por tentativa nem declarar entrega antes de
  pareamento, identidade real e homologação. Outro número depende do proprietário.

## Fontes

- [Evolution — fonte 2.3.7](https://github.com/evolution-foundation/evolution-api/tree/cd800f2976e1e5b682fbf86a01ee4d85ae61f370).
- [Baileys](https://github.com/WhiskeySockets/Baileys).
- [Perfil versionado](../../ops/evolution/README.md) e [runbook](../runbooks/evolution-baileys.md).
