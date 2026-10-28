# RFC 032 — Pareamento privado com WPPConnect

Status: decidida em 28/10/2026 pela [ADR 044](../adr/044-piloto-whatsapp-wppconnect.md).
Requisitos: ORC-01..08, INB-01 e MSG-01..04; tarefa WPP-01, vinculada a
OPS-1, INT-1/2 e INBOX-2/3. Issue/PR específica: não criada nesta etapa.

O proprietário manteve a exigência de API não oficial por QR e, após a
recomendação do WPPConnect, forneceu outra linha e pediu sua configuração
no n8n e a geração do QR. O número é configuração privada de operação.
O piloto WAHA anterior permanece suspenso; seu bloqueio não teve causa
confirmada. A mudança de biblioteca não comprova menor risco de bloqueio.

A proposta é um serviço WPPConnect dedicado, sem Redis ou banco adicional,
com API interna autenticada, sessão persistente privada e pareamento manual
em workflow separado e inativo. A versão publicada do atendimento e seus
backups permanecem preservados. A primeira etapa não habilita webhook,
importação de histórico, resposta automática ou testes de envio.

Foram consideradas Evolution API 2.3.7, sua linha 2.4 em pré-lançamento e
WPPConnect Server 2.10.69. A manutenção estável recente e a operação sem
novos bancos favorecem WPPConnect para o próximo teste. Existem limitações
de autenticação/retry do webhook e configuração padrão que exigem correção
local auditável. Nenhuma comparação consultada estabelece taxas confiáveis
de banimento. A API oficial foi considerada e o proprietário reiterou QR.

O aceite do pareamento exige QR privado atual, confirmação da identidade
real da sessão e separação explícita da homologação de envio/recebimento.
O aceite da integração exige persistência antes do ACK, identidade/LID
verificável, replay sem duplicação, resultado incerto sem retry cego e
tomada humana preservada. Ver [runbook](../runbooks/wppconnect.md).
