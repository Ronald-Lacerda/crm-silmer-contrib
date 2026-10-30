# Áudio recebido e enviado pela Inbox

## Aceite operacional — 29/10/2026

INBOX-AUDIO-PROXY-01 e INBOX-AUDIO-OPS-01; INB-01, MSG-01/02 e PRV-03.
O proprietário autorizou implantação, recuperação do áudio indicado e teste
real de envio/recebimento. Usou-se a conversa de teste já existente e um tom
sintético OGG/Opus de cinco segundos; nenhum conteúdo de cliente foi reenviado.

### Implantação do proxy

[PR 242](https://github.com/romulosutil/crm-silmer/pull/242), integrada por
rebase na revisão `7ee78734fa08a9bd01fb8dd75418d6944cd8475c`. O Auto Deploy
existente do serviço `espectro-mvp/silmer-edge-web` publicou essa revisão.
Container saudável, uma réplica, imagem em execução
`sha256:606668fe8eda4c5237c33c1c6a8138cdcb0646aaba1e5fc3276cac7063c2d7e8`.
`GET /healthz` respondeu 200.

Somente `POST /api/v1/integrations/n8n/conversations/:id/attachments` ganhou
orçamento de 17 MiB para multipart de arquivo de até 16 MiB. As demais rotas,
autorização, scanner, retenção e idempotência mantêm seus contratos.

Os CIs da [PR](https://github.com/romulosutil/crm-silmer/actions/runs/40976100717)
e do [master](https://github.com/romulosutil/crm-silmer/actions/runs/40977269773)
passaram. Incluem Nginx real com 14 casos de rota/tamanho e negativas de método,
além dos gates de qualidade e imagens. Probes remotos sem escrita comprovaram:

| Requisição sintética                                 | Resultado observado                         |
| ---------------------------------------------------- | ------------------------------------------- |
| Multipart de 2 MiB no endpoint exato, sem credencial | 401 `INVALID_AUTOMATION_CREDENTIALS` da API |
| Corpo de 18 MiB no endpoint exato                    | 413 do proxy                                |
| Corpo de 2 MiB em outra rota n8n de inbound          | 413 do proxy                                |

O primeiro caso comprova a passagem do limite antigo de 1 MiB e a preservação
da autenticação. Não equivale a upload autenticado; este foi exercitado pelo
canal real e pela recuperação abaixo.

### Recuperação pontual

O utilitário manual **Silmer | Recuperar audio antigo autorizado** consultou
somente o contato e o minuto do áudio indicado pelo proprietário, exigindo
exatamente uma mensagem recebida do tipo áudio. A consulta foi limitada a cinco
registros; zero ou múltiplos candidatos interrompem a seleção. Downloads usaram
o identificador do provedor, sem seguir redirects nem retry cego.

O decoder validou MIME, base64 e limite, preservou os bytes e calculou SHA256.
O upload usou a API autenticada existente, com scanner e chave idempotente
baseada na mensagem original. Não houve novo inbound, reenvio ao WhatsApp,
chamada de IA ou alteração comercial. Revisão independente e fixture sintética
conferiram seleção única, rejeição de ambiguidade e preservação de bytes/chave.

Uma execução manual concluiu os dez nós. A mensagem original de 17:05 passou
a exibir player na mesma conversa. O elemento nativo confirmou duração de
6,5065 segundos, `currentTime === duration`, `ended: true` e `error: null`.

O utilitário permanece inativo, sem webhook público, sem acesso MCP e sem salvar
execuções manuais, sucessos, falhas ou progresso. Os dados temporários do editor
foram limpos após o aceite. Exportações privadas e screenshots ficam fora do Git.

### Teste real nos dois sentidos

| Caminho                 | Evidência observada                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox → WhatsApp, 20:56 | Upload pronto, envio aceito e uma mensagem de voz de 0:05 recebida no WhatsApp. Screenshot mostra reprodução em 0:03, com waveform avançada e botão Pausar; depois voltou a Reproduzir, sem erro de áudio no console. |
| WhatsApp → Inbox, 21:06 | Um envio do mesmo OGG recebido com player na Inbox. Duração 5,0065 segundos, `currentTime === duration`, `ended: true`, `error: null`.                                                                                |
| Áudio antigo → Inbox    | Player na mensagem original e reprodução completa de 6,5065 segundos sem erro.                                                                                                                                        |

Horários em America/Sao_Paulo. O atendimento permaneceu humano e a atribuição
original foi preservada. O aceite se refere a arquivo OGG/Opus.

### Recuperação de falhas e rollback

Se um áudio futuro não mostrar player, conferir primeiro se existe anexo
persistido na mensagem. Metadata do tipo áudio, sozinha, não contém os bytes.
No n8n, preservar o ramo independente de mídia de áudio ao editar filtros e
decoders de imagem. Não publicar exports privados nem salvar base64 em execução.

Para recuperação, delimitar contato, minuto, direção e tipo; exigir candidato
único e reutilizar identificador/chave do anexo original. Não repetir o caminho
comercial nem reenviar mensagem para tentar recuperar mídia.

Para reverter somente o proxy, reverter a PR 242 pelo fluxo normal de CI e
Auto Deploy. Isso restaura o limite anterior e volta a bloquear anexos maiores
que 1 MiB; não remove os anexos já recuperados. Não reverter a branch Evolution
acumulada ou configurações independentes do atendimento.
