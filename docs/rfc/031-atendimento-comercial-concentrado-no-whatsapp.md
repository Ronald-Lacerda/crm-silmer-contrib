# RFC 031 — Atendimento comercial concentrado no WhatsApp

Data: 27/10/2026. Status: decidida na [ADR 043](../adr/043-atendimento-comercial-concentrado-no-whatsapp.md).

O proprietário pediu auditar o workflow publicado, retirar mochilas e bolsas,
testar conversas adversariais e concentrar o atendimento de site/Instagram no
WhatsApp. CHAN-WA-01 complementa AGT-01..08 e ORC-01..08.

A proposta adotada é um CTA único “Falar no WhatsApp”, com orientação curta,
sem formulário de identificação e sem iniciar qualificação fora do WhatsApp.
O webhook antigo do site tem resposta fixa sem tocar CRM/IA. A loja preserva
checkout e registro de pedido pago. Identidades não são unidas pelo link.

A pesquisa documental confrontou a interface publicada com documentação oficial
WhatsApp click-to-chat, conexão Instagram/WhatsApp, GOV.UK e WCAG. Não houve
estudo com participantes; hipóteses de conversão ainda exigem medição própria.
Fontes e resultados estão no relatório vinculado pela ADR.

Critérios: entrada por uma ação; rótulo explícito; teclado/foco; mobile e
desktop; sem JavaScript; nenhum request CRM/n8n no CTA; nenhum dado pessoal no
texto pré-preenchido; roteamento antigo não vende; remoção de categorias sem
apagar histórico; duas intenções separadas não viram um pedido agregado.

Issues/PRs externos: nenhum criado nesta solicitação. Commit e estado de
publicação são registrados no fechamento, sem inventar evidência de deploy.
