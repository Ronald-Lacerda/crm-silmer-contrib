# WPPConnect — piloto e pareamento privado

Rastreabilidade: [ADR 045](../adr/045-piloto-whatsapp-wppconnect.md),
[RFC 033](../rfc/033-pareamento-privado-com-wppconnect.md), WPP-01,
OPS-1/INT-1/2, ORC-01..08, INB-01 e MSG-01..04.

## Estado em 28/10/2026 — preparação pausada

O proprietário forneceu uma nova linha para atendimento na Inbox real do CRM
e autorizou sua configuração no n8n e geração de QR. O telefone esperado é
configuração privada. A opção por API não oficial foi reiterada após a
comparação com a API oficial.

WPPConnect Server 2.10.69, core 2.3.6, foi preparado, mas nunca pareado.
O Chromium falhou ao criar namespaces com `EPERM`; o serviço foi parado.
Não houve aprovação nem aplicação de `--no-sandbox` ou alteração do host
para contornar a falha. A [ADR 046](../adr/046-retomar-waha-para-atendimento-da-nova-linha.md)
e o [RFC 034](../rfc/034-retomar-waha-para-atendimento-da-nova-linha.md)
registram a pausa e a retomada do WAHA/WEBJS existente com volumes novos.
A ADR 045 permanece como registro da preparação. A conta anterior bloqueada
continua sem uso, com volumes preservados. Nenhuma taxa de bloqueio é inferida
da biblioteca ou das falhas de pareamento.

O transporte ativo escolhido é WAHA/WEBJS: identidade da nova linha confirmada
em `WORKING` e adapter publicado no mesmo ID principal n8n com 101 nós.
WPPConnect permanece parado, sem conta pareada. Texto real de entrada e
resposta humana pela Inbox foi verificado no WAHA; mídia e recuperação
permanecem sem homologação. Consultar o [estado WAHA](waha-webjs.md).

## Etapas e evidências

- [x] WPP-01A — preparar fonte/runtime fixados, configuração restrita,
      autenticação, volume privado, build e verificações da API privada.
      O navegador permaneceu impedido pela falha de namespace.
- [ ] WPP-01B — pareamento e identidade real: pausados, sem conta conectada.
- [x] WPP-01C — candidato `WppSilmerPilot01` salvo inativo, regenerado da
      fonte atual de 92 nós para 101 nós, sem publicação ou cutover.
- [ ] WPP-01D — homologação real, recuperação e takeover: pausados.

O build remoto confirmou Node 22.23.4, UID 1000 e arquivo de token com modo
`0600`. No perfil de pareamento, health retornou `200`, requisição sem
autenticação `401`, envio `404`, Manager `404` e Socket `403`. Essas provas
validam processo e restrição da API; não comprovam um navegador funcional.
O pacote oficial `chromium-sandbox` foi acrescentado à imagem; a falha
posterior de namespace permaneceu e nenhum pareamento WPPConnect ocorreu.

O utilitário QR manual `WppPairSilmer20261028` e duas credenciais exclusivas
foram importados no n8n com autorização do proprietário. Não houve QR válido,
conta vinculada ou envio. A exceção SSRF acrescentou somente o hostname
`schedule_silmer-wppconnect` à permissão existente do WAHA; o reinício n8n foi
autorizado e concluído, mantendo as outras variáveis e a proteção SSRF.

O adapter passou em 18 testes e o perfil restrito em nove. O gate completo
`npm run validate`, incluindo build, passou com 1.186 testes: 1.183 aprovados,
três ignorados e nenhuma falha. Esses checks não comprovam canal real.

Durante pareamento, manter webhook desativado e nenhum envio automático.
Não habilitar importação de histórico por tentativa. Segredos separados
para administração/API e entrega ao n8n; API sem porta ou domínio públicos.
QR somente em aba autenticada, sem impressão em log ou export versionado.

## Contratos de integração

O webhook exige header secreto próprio, conta real e sessão esperadas.
O gateway deve acrescentar `__wpp_received_at` antes do loop de retry e
preservá-lo, e `__wpp_own_jid` derivado da conta real do cliente. O `t` de
um ACK pertence à mensagem, não ao recibo. O CRM persiste antes do ACK HTTP.
Falhas HTTP 5xx e falhas de rede admitem retry limitado com o mesmo evento;
envio ao WhatsApp não admite repetição cega após resultado incerto.

Grupos, status e mensagens próprias não iniciam atendimento. LID exige
correlação fornecida pelo canal. Uma resposta HTTP 2xx de envio não prova
entrega ao telefone. A confirmação do comando humano permanece associada
à reserva original, sem inventar nova mensagem enviada a partir de ACK.

## Suspensão e rollback

Parar somente o gateway/candidato deste piloto. Conservar sessão, volume,
mensagens persistidas e resultados incertos. Reconciliar antes de reenvio.
O fluxo publicado e seu backup devem permanecer recuperáveis. A retomada do
WAHA para a nova linha segue a decisão explícita da ADR 046. A conta anterior
não deve ser reutilizada nem servir como fallback automático. Não repetir
comandos antigos ou ativar outro transporte automaticamente.

## Fontes

- [Release 2.10.69](https://github.com/wppconnect-team/wppconnect-server/releases/tag/v2.10.69).
- [Fonte fixada](https://github.com/wppconnect-team/wppconnect-server/tree/27d2b0e573870d8ac20e28ed4180a2e51c30c8ea).
- [Segurança do runtime Node 22.23.4](https://nodejs.org/en/blog/release/v22.23.4).
- [Contrato CRM/n8n](../integrations/n8n/README.md).
