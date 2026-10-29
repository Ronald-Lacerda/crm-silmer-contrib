# Evolution/Baileys — perfil privado de transporte

Rastreabilidade: EVOL-01, OPS-1/INT-1/2, ORC-01..08, INB-01 e MSG-01..04.
O proprietário autorizou Evolution como ponte para a Inbox enquanto a API
oficial da Meta é aprovada. O workflow Meta permanece preservado. Este perfil
prepara o serviço; build, autenticação HTTP, pareamento e entrega real exigem
evidências independentes do operador.

## Fonte e imagem

- Evolution API `v2.3.7`, tag fonte `2.3.7`, commit
  `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.
- Baileys `7.0.0-rc.9` é a dependência fixada dessa versão da Evolution.
- Base oficial `evoapicloud/evolution-api:v2.3.7`, índice OCI
  `sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`.
- Manifest Linux amd64
  `sha256:456b4104b0ddffbb092d6b3c0560a4ae86fc3e014e885b882aca4b1b371dfc81`.
- Metadados oficiais registram a mesma revisão e Node `24.11.1`/Alpine 3.23.
  O wrapper substitui somente o binário Node por `24.22.1` da imagem oficial
  `node:24.22.1-alpine3.23`, índice
  `sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2`.
  Mantém a major Node e a distribuição Alpine; não atualiza as bibliotecas
  ou dependências da Evolution. O build exige a versão Node exata, Alpine
  3.23 e import funcional de Baileys, Sharp e Prisma Client.

`Dockerfile.inline` é autossuficiente para a fonte inline do EasyPanel. É
gerado por `node ops/evolution/render-dockerfile.mjs`; editar as fontes
`privacy.cjs`/`retention.cjs`, não somente a cópia gerada. O wrapper mantém o
protocolo Baileys, executa como UID/GID `1000:1000`, não instala Chromium,
não usa container privilegiado e não expõe domínio ou porta pública.

## EasyPanel e persistência

Serviços: `schedule/silmer-evolution`, porta interna `8080`, uma réplica, e
`schedule/silmer-evolution-db`, PostgreSQL privado dedicado. Banco e role:
`silmer_evolution`; nenhuma credencial ou conexão com o banco do CRM/n8n.
Volume de sessão previsto: `/evolution/instances`, proprietário `1000:1000`.
A sessão criptográfica também depende das tabelas do PostgreSQL; recuperar
somente o volume não comprova recuperação da conta.

Usar `environment.env.example` como inventário. Preencher valores secretos
somente no EasyPanel/credenciais n8n: chave administrativa, senha do banco e
token exclusivo de webhook. Chave e token devem ser distintos, aleatórios e
ter no mínimo 32 caracteres. O wrapper falha antes das migrations se o perfil
não corresponder ao banco exclusivo, cache local e integrações restritas.

Redis fica desativado; o `LocalCache` upstream é selecionado explicitamente.
Não há backend de filas, Chatwoot, IA ou agente paralelo na Evolution.
`N8N_ENABLED=false` desliga o chatbot interno da Evolution, sem impedir o
webhook para o workflow n8n existente.
`TZ=UTC` fixa o timestamp sem offset emitido pelo upstream no mesmo referencial
UTC usado pelo adapter; não reutilizar o default São Paulo da imagem base.
`CORS_ORIGIN=*` com `CORS_CREDENTIALS=false` é necessário no upstream fixado
para chamadas sem header Origin, inclusive n8n e health. A API continua
exclusivamente privada e exige chave; CORS não substitui autenticação.

## Privacidade e webhook

O entrypoint upstream imprime a URL do banco. O wrapper descarta stdout/stderr
das migrations e publica apenas `EVOLUTION_DATABASE_READY/FAILED`. Não ativa
`NODE_OPTIONS` global; npm/Prisma usam seu comportamento original sem o
preload da API.

Na API, `privacy.cjs` substitui chunks de stdout/stderr por códigos fixos.
Isso inclui logs do logger, Baileys e QR em terminal. Diagnóstico não depende
de mensagens privadas; consultar health/estado HTTP e códigos fixos. Essa
minimização reduz detalhes dos erros disponíveis no log.

O preload intercepta as instâncias Axios que enviam envelopes de evento,
remove `apikey`/`api_key` do corpo, desabilita redirects e aceita somente o
destino HTTPS exato `SILMER_EVOLUTION_WEBHOOK_URL`, com header protegido
`X-Silmer-Evolution-Token`. Eventos autorizados: `messages.upsert`,
`messages.update`, `connection.update`; QR e histórico são recusados. A
integração deve configurar `webhook.byEvents=false`, `webhook.base64=false`
e os três eventos equivalentes em maiúsculas, com autenticação no n8n.
O hook é específico ao Axios externo da fonte fixada, cuja configuração
tsup conserva dependências externas; atualizar a imagem exige rever esse gate.

Nenhum webhook global é habilitado. Somente o operador autenticado deve
criar/configurar a instância `silmer` com integração `WHATSAPP-BAILEYS`.
Começar sem QR e sem conta pareada; habilitar mensagens somente com rota n8n
publicada e identidade real confirmada. O serviço privado continua tendo APIs
administrativas upstream: a chave administrativa não pode chegar ao público.

## Retenção de transporte

`DATABASE_SAVE_DATA_NEW_MESSAGE=true` é necessário para consulta de mídia por
ID e correlação LID estritamente vinculada à mensagem no adapter. Não importa
histórico nem mantém cadastros comerciais na Evolution. Contatos, chats,
labels, histórico e atualizações de mensagem em banco ficam desativados.

`retention.cjs` usa o Prisma Client gerado da própria imagem para remover
somente `Message` da instância configurada com `messageTimestamp` anterior a
sete dias. `Media` e `MessageUpdate` seguem os `onDelete: Cascade` do schema
oficial. Instância, sessão, autenticação e dados do CRM não são alvos.

Há expurgo inicial obrigatório após migrations e antes da API, depois uma
execução por hora, sem sobreposição. Uma falha inicial impede a subida; falha
periódica emite `EVOLUTION_RETENTION_FAILED` e a próxima rodada tenta de novo.
O cutoff usa o timestamp de mensagem definido pelo canal, não uma nova coluna
local de recebimento. Expurgo periódico depende do runtime ativo e pode ter
atraso até a próxima execução; monitorar o código de falha e não prometer um
prazo exato de eliminação durante indisponibilidade.

## Verificação

```text
node ops/evolution/render-dockerfile.mjs
node --test ops/evolution/profile.test.mjs
```

O teste local usa apenas valores sintéticos e mocks. Gates remotos: build
confirmado, processo sem root, versão de runtime, migrations somente no banco
dedicado, health privado, resposta sem chave `401`, ausência de porta pública,
remoção da chave do webhook, header obrigatório e destino fixo, expurgo sem
atingir mensagem recente/sessão, nenhuma modificação no workflow Meta.
Pareamento, estado `open`, identidade, inbound persistido, mídia, resposta
humana, ACK, restart e resultado incerto precisam de conta disponível e
homologação própria. HTTP `2xx` não comprova entrega ao WhatsApp.

## Fontes primárias verificadas

- [Release](https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7).
- [Imagem Docker publicada](https://hub.docker.com/r/evoapicloud/evolution-api/tags?name=v2.3.7).
- [Configuração da versão fixada](https://github.com/evolution-foundation/evolution-api/blob/cd800f2976e1e5b682fbf86a01ee4d85ae61f370/.env.example).
- [Env/cache](https://github.com/evolution-foundation/evolution-api/blob/cd800f2976e1e5b682fbf86a01ee4d85ae61f370/src/cache/cacheengine.ts).
- [Webhook e retries](https://github.com/evolution-foundation/evolution-api/blob/cd800f2976e1e5b682fbf86a01ee4d85ae61f370/src/api/integrations/event/webhook/webhook.controller.ts).
- [Schema PostgreSQL](https://github.com/evolution-foundation/evolution-api/blob/cd800f2976e1e5b682fbf86a01ee4d85ae61f370/prisma/postgresql-schema.prisma).
- [Migrations upstream](https://github.com/evolution-foundation/evolution-api/blob/cd800f2976e1e5b682fbf86a01ee4d85ae61f370/Docker/scripts/deploy_database.sh).
- [Node 24.22.1 — release de segurança](https://nodejs.org/en/blog/release/v24.22.1).
