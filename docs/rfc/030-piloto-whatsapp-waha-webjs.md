# RFC 030 — Piloto WhatsApp com WAHA e WEBJS

Status: decidida em 27/10/2026 na
[ADR 042](../adr/042-piloto-whatsapp-waha-webjs.md).
Responsável: Tech Lead. Decisor: proprietário, autorização explícita nesta conversa.
Requisitos: [ORC-01..08, INB-01 e MSG-01..04](../../.specs/features/crm-mvp/spec.md).
Tarefa: WAHA-01, vinculada a INBOX-2/3, AGENTE-6, OPS-1 e INT-1/2 no
[plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Issue/PR: nenhum vínculo específico informado nesta etapa.

## Contexto

O proprietário escolheu uma linha temporária para o Vendedor Silmer e autorizou
instalar WAHA com o motor WEBJS no EasyPanel, conectando-a ao n8n e à Inbox.
Essa decisão substitui, somente nesse piloto, a exigência de transporte pela
API oficial. O cadastro dessa linha na Meta não integra a solução escolhida.
O atendimento anterior e a integração já construída devem ser preservados.

As regras do CRM continuam vigentes: n8n orquestra a jornada, o CRM autoriza e
audita efeitos, confirmações comerciais são humanas e handoff não volta ao bot.
A mudança de transporte não autoriza substituir essas fronteiras por recursos
de chatbot ou armazenamento de domínio do gateway.

## Alternativas consideradas

| Alternativa                           | Avaliação para esta decisão                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Continuar o onboarding da API oficial | É a baseline anterior; o proprietário escolheu interromper esse caminho para a linha temporária. |
| Evolution API                         | API pronta considerada pelo proprietário; não foi a opção escolhida.                             |
| whatsapp-web.js diretamente           | Biblioteca utilizada pelo WEBJS; exigiria construir e operar a camada HTTP.                      |
| WAHA com WEBJS                        | Opção escolhida: API HTTP e eventos conectados ao n8n, com sessão do WhatsApp Web.               |

Estrelas e relatos em issues não fornecem taxas comparáveis de banimento.
Não se afirma que WAHA ou WEBJS tenha menor taxa de bloqueio que as demais
alternativas; o piloto não recebe garantia de continuidade do canal.

## Resultado e limites

Adotar WAHA com WEBJS como gateway dedicado da linha temporária, em serviço
separado no EasyPanel, com armazenamento persistente privado para a sessão.
O n8n recebe eventos autenticados e envia pelo gateway, conservando o contrato
atual com o CRM, o chat do site, a IA, as reservas de envio e o handoff.

Preservar a versão anterior e o backup do workflow antes de publicar a adaptação.
Não criar dois consumidores ativos de uma mesma mensagem ou duas rotas ativas
de envio para a linha. Não migrar a conta comercial anterior, importar seu
histórico, desvincular seus dispositivos ou alterar seu cadastro Meta.

O adapter aceita somente a sessão e a conta configuradas. Mensagens próprias,
grupos, listas e status de transmissão não iniciam atendimento. Eventos de
confirmação de entrega são tratados separadamente; um `@lid` só pode representar
um telefone após correlação verificável, nunca por nome ou inferência.

Sem autenticação, identidade comprovada, reserva de envio ou suporte de mídia
homologado, a operação deve falhar de forma explícita e sem envio alternativo.
Um timeout posterior ao envio conserva resultado incerto, sem retry cego.

## Evidências necessárias

WAHA-01 exige imagem identificada, saúde e autenticação verificadas, sessão
persistente, pareamento da conta esperada, recebimento único na Inbox, resposta
de IA/handoff e resposta humana, confirmações do canal, duplicidade/replay,
takeover e rollback. Reiniciar o serviço deve preservar a sessão.

Este documento registra a escolha. A instalação, o pareamento e os testes
reais dependem de evidência operacional; a aprovação da proposta não os comprova.
Sequência, checklist e recuperação estão no
[runbook](../runbooks/waha-webjs.md).

## Referências

- [WAHA — instalação](https://waha.devlike.pro/docs/how-to/install/).
- [WAHA — motores](https://waha.devlike.pro/docs/how-to/engines/).
- [WAHA — eventos](https://waha.devlike.pro/docs/how-to/events/).
- [WAHA — segurança](https://waha.devlike.pro/docs/how-to/security/).
- [WAHA — n8n](https://waha.devlike.pro/docs/integrations/n8n/).
- [whatsapp-web.js — projeto e limitações](https://github.com/wwebjs/whatsapp-web.js).
