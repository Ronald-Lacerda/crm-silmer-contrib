# ADR 044 — Atendimento comercial concentrado no WhatsApp

Data: 27/10/2026. Status: aprovada pelo proprietário nesta solicitação.
Proposta: [RFC 032](../rfc/032-atendimento-comercial-concentrado-no-whatsapp.md).
Rastreabilidade: CHAN-WA-01, AGT-01..08, ORC-01..08 e tarefa CHAN-WA-01
em [.specs/features/crm-mvp/tasks.md](../../.specs/features/crm-mvp/tasks.md).

## Decisão

O atendimento comercial automatizado acontece no WhatsApp. Site e Instagram
encaminham para esse canal, sem pré-venda, perguntas, coleta de nome/telefone,
chamada de IA ou abertura de pedido. A loja e seu checkout mantêm o contrato.
Esta decisão supersede o atendimento ativo do site dos ADRs 026 e 034;
os dados históricos e os contratos de consulta não são apagados.

O site oferece um link acessível “Falar no WhatsApp”, usando o destino público
comercial vigente. A rota antiga do chat mostra a mesma orientação; o webhook
antigo responde com mensagem fixa antes de CRM/IA, protegendo páginas em cache.
O visitante precisa enviar a mensagem no WhatsApp para iniciar atendimento.
Não se transfere automaticamente identidade, histórico ou conteúdo entre canais.

O linktree do Instagram mantém o mesmo destino. Botão do perfil e resposta
fixa de Direct dependem da configuração da conta; não se cria um adapter de
Direct nem se declara essa configuração publicada sem evidência.

Mochilas, bolsas e similares deixam de ser oferecidos/coletados pelo agente.
Pedido espontâneo dessas categorias vai para humano, sem abrir ou projetar
rascunho; registros anteriores permanecem disponíveis.

## Confiabilidade

Preservar o guard de segurança adicional observado no workflow publicado.
Bloquear também promessas comerciais explícitas que escapavam desse guard,
e transferir dois pedidos explicitamente separados antes de agregar dados,
inclusive na primeira mensagem. Os filtros são defesa adicional; não provam
compreensão perfeita do modelo ou cobertura de toda paráfrase.

## Alternativas e efeitos

Manter dois atendimentos foi rejeitado pelo proprietário. Redirecionamento
automático sem clique foi descartado para preservar escolha e previsibilidade.
O botão informa o destino, funciona sem JavaScript e não cria atendimento
fictício quando a pessoa fecha o WhatsApp sem enviar a mensagem.

Publicação n8n deve preservar IDs/webhooks/credenciais e configurações privadas,
com backup anterior e verificação posterior. O candidato WAHA permanece sem
cutover implícito. Evidências e limites ficam no [relatório](../integrations/n8n/auditoria-vendedor-2026-10-27.md).
