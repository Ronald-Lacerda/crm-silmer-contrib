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

## Preparação INBOX-AUDIO-01 — 29/10/2026

INBOX-AUDIO-01 · AUD-IN-01..04 · EVOL-01D · INB-01 · MSG-01..04.
Registro da correção do workflow que antecedeu o aceite operacional acima.

### Causa e correção

A mensagem afetada aparecia como `Áudio`, sem player. O workflow registrava
o inbound, mas seu ramo independente de anexos filtrava somente imagens.
Download/transcrição no caminho da IA não salva um anexo reproduzível e esse
caminho não executa depois da tomada humana.

A API e o componente já suportam áudio privado OGG/MP3. O patch offline
`ops/n8n/patch-evolution-inbound-audio.mjs` altera somente o filtro e a medição
dos nós históricos `Inbox - Imagem recebida - Filtrar/Medir`. Os nomes e IDs
ficam preservados. Áudio aceita até 16 MiB; imagem conserva 5 MiB. Tipo e MIME
do evento devem coincidir com o MIME binário. Hash, scanner, vínculo, replay,
retenção e falha sanitizada continuam no contrato existente.

O edge precisa aceitar o multipart correspondente: `docker/nginx.conf`
reserva 17 MiB somente para POST na rota exata
`/api/v1/integrations/n8n/conversations/:id/attachments`, sem buffering de
request e sem alterar autenticação da API. O limite genérico continua 1 MiB.
Esse limite foi implantado em INBOX-AUDIO-PROXY-01 (PR 242), acima.

### Publicação observada

Exportação anterior privada: revisão `d53b60a6-a4d2-4c87-8689-6a78e94adca3`,
110 nós e `active=true`. Backup e revisão preparada estão em
`var/inbox-audio/`, ignorado pelo Git. Nunca publicar esses exports, que
podem conter configuração privada.

A edição pela interface foi exportada e comparada ao patch offline com
igualdade estrutural: somente dois nós modificados; demais nós, conexões e
settings iguais. A revisão `15d9ba9a-77e8-429b-bd43-e6dc2349ec5f` foi publicada
como **INBOX-AUDIO-01 · Persistir áudios recebidos**. A interface confirmou
`Published`. Não foram alterados workflows Meta, webhook ou credenciais.

### Evidências locais da preparação

76 testes focados passaram: patch Evolution, cadeia de imagem preservada,
API de anexos, conteúdo privado/Range, retenção, volume e política do edge.
Revisão independente de Backend/QA sem bloqueantes nos arquivos da entrega.
Gate completo `npm run validate`: 1.434 testes, 1.429 aprovados, cinco skips,
zero falhas, tipos, lint e build. A auditoria `npm audit --audit-level=high`
passou, com três avisos existentes (um baixo e dois moderados), sem alterar
dependências. Esses testes não comprovam WhatsApp real; a implantação do edge,
a recuperação do áudio anterior e o teste nos dois sentidos estão no aceite
operacional acima.

### Aplicação do patch e rollback do workflow

```powershell
node ops/n8n/patch-evolution-inbound-audio.mjs <export-atual.json> <review-novo.json>
```

O comando é offline, recusa contexto inesperado e exige saída nova. Reaplicar
o patch à mesma revisão retorna zero alterações. Comparar o export vivo antes
de publicar; nunca substituir o principal por um snapshot Meta antigo. O
export vivo atual também inclui o patch de imagens de INBOX-IMG-RELEASE-03;
comparar cada delta com a revisão publicada antes de publicar.

Rollback de workflow restaura somente filtro/medição da revisão anterior,
preservando mensagens e anexos já vinculados. Não restaurar banco nem
reenviar comandos como consequência de rollback.
