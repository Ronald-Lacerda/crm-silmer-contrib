# Jornada site/Instagram → WhatsApp → CRM — 28/10/2026

Requisitos/tarefas: CHAN-WA-01, WAHA-01D, OPS-1, INB-01 e MSG-01..04.

## Resultado

Encaminhamento e entrega no WhatsApp aprovados nos dois caminhos públicos.
A jornada completa até Inbox e resposta do Vendedor **não foi homologada**.
O proprietário informou que ainda não ativou o WhatsApp no n8n; a inspeção
ao vivo confirmou o candidato `WahaSilmerPilot01`, “Silmer | Atendimento
WAHA WEBJS (preparado)”, com `Publish`, sem `Published`.

## Procedimento e evidências observadas

Foi usado o navegador conectado do proprietário para enviar duas mensagens
rotuladas como homologação, para o destino comercial aprovado do CRM.
O cabeçalho da conversa mostrou o destinatário correto, sem indicação de
conversa consigo mesmo. Não foi usada injeção sintética de webhook como
substituto da mensagem real.

| Caminho executado                                                                                 | Resultado observado                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `silmer.com.br/chat` → “Falar no WhatsApp” → página WhatsApp → WhatsApp Web                       | Destino correto e “Olá! Vim pelo site.” preenchido. Mensagem `TESTE-SITE-20261028-001` enviada às 00:06 e exibida como `Entregue`.           |
| Perfil público `@silmeroficial` → links → “atendimento” → `/instagram` → CTA geral → WhatsApp Web | Destino correto e “Olá! Vim pelo Instagram.” preenchido. Mensagem `TESTE-INSTAGRAM-20261028-001` enviada às 00:10 e exibida como `Entregue`. |
| Inbox autenticada → busca dos marcadores de teste                                                 | “Nenhuma conversa encontrada”. Filtros de situação e responsável estavam em “Todas”.                                                         |
| Conversa WhatsApp após os testes                                                                  | Nenhuma mensagem posterior aos testes foi observada durante a conferência; sem resposta do Vendedor.                                         |
| Serviço `schedule/silmer-waha`                                                                    | Container em execução. Isso não confirma sessão pareada, identidade da sessão ou entrega de eventos.                                         |
| Workflow preparado da nova linha                                                                  | Sem publicação. Nenhuma ativação, novo pareamento ou troca de transporte foi feita nesta rodada.                                             |

Horários da interface em America/Sao_Paulo. A mensagem do site usou nome
fictício e intenção comercial sintética, com aviso de que não era compra
real. Nenhuma mensagem a clientes foi enviada. Não foram criados pedidos ou
conversas pela API para simular sucesso. A busca vazia é evidência da UI,
não uma auditoria completa do banco ou de todas as execuções do n8n.

Capturas locais em `output/jornada-crm-2026-10-28/`: mensagem do site entregue,
busca vazia da Inbox e workflow não publicado. Contato pessoal do remetente,
QR, segredos e histórico de outros contatos não integram este documento.

## Limites e condição para continuar

- Esta rodada testou o link geral da bio, não o botão nativo do perfil nem
  a entrega da resposta automática do Direct a outra conta Instagram.
- Os links explicitamente nomeados de vendedores continuam com destinos
  próprios; o caminho geral testado chega ao WhatsApp do CRM.
- “Entregue” no WhatsApp não comprova chegada ao gateway, execução do n8n,
  registro na Inbox ou resposta da IA.
- Falta verificar/realizar o pareamento da linha do CRM, conferir identidade
  da sessão e preparar/publicar uma única rota que processe essa linha.
  Não publicar o candidato antigo sem conferir também as guardas e o
  comportamento vigente do Vendedor.
- Depois da ativação, enviar mensagens novas de homologação por outra
  conta e verificar uma entrada única, identidade correta, resposta no
  WhatsApp/Inbox e coleta progressiva. Não reexecutar os testes antigos
  como se fossem novos eventos reais, nem duplicar efeitos de envio.

Referências: [runbook WAHA](../../runbooks/waha-webjs.md),
[ativação da Inbox](../../runbooks/inbox-whatsapp.md) e
[auditoria/encaminhamento](auditoria-vendedor-2026-10-27.md).
