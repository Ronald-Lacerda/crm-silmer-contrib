# Topologia EasyPanel — CRM Silmer

## Transporte da nova linha — WAHA retomado; WPPConnect parado

A [ADR 046](docs/adr/046-retomar-waha-para-atendimento-da-nova-linha.md)
pausa `schedule/silmer-wppconnect`, preparado pela ADR 045 com API privada na
porta 21465 e volume `/data`. O build passou, mas o Chromium falhou em namespace
com `EPERM`; o serviço foi parado sem parear conta e sem `--no-sandbox`.
Fonte, configuração e volume foram preservados. O serviço existente
`schedule/silmer-waha` foi retomado com a imagem WEBJS já fixada abaixo e
volumes novos de sessão e mídia para a nova linha. Os volumes anteriores
continuam separados e preservados; a conta bloqueada não foi reutilizada.
Não foram publicados domínio ou porta para os gateways. O QR é manual e privado
no n8n. A sessão WAHA `default` está em `WORKING`, com identidade esperada
confirmada; o workflow principal foi atualizado no mesmo ID e publicado com
101 nós. Entrada real na Inbox e resposta humana entregue uma vez foram
verificadas; mídia, reentrega e recuperação continuam com gates abertos.
[Estado atual WAHA](docs/runbooks/waha-webjs.md) e
[evidências WPPConnect](docs/runbooks/wppconnect.md).

## Serviço adicional autorizado — piloto WAHA/WEBJS

A [ADR 043](docs/adr/043-piloto-whatsapp-waha-webjs.md) autoriza
`schedule/silmer-waha`, sem Redis ou banco adicional, com uma réplica WEBJS.
A imagem é `devlikeapro/waha:chrome-2026.9.2` fixada no digest
`sha256:d4c2b1da8373fa48c5022aa947c95a87480cf6e26a9d3c9b59721f96b044d223`.
Volumes privados: `/app/.sessions` e `/app/.media`; limites: 1 CPU e 1536 MB.
Sem domínio ou porta publicada. n8n usa `http://schedule_silmer-waha:3000`,
chave exclusiva e allowlist SSRF desse hostname, mantendo a proteção ativa.
O retorno usa o HTTPS existente do n8n com autenticação própria. Dashboard,
Swagger e impressão de QR em log ficam desativados. Estado de instalação,
pareamento e homologação são registrados no
[runbook](docs/runbooks/waha-webjs.md), sem antecipar readiness do canal.

> **Status:** manter o fluxo atual de deploy automático GitHub → EasyPanel; gate de produção pendente de checagem operacional
>
> **Data:** baseline de 31/08/2026; revisão operacional em 05/10/2026
>
> **Host:** Hostinger VPS com Ubuntu 24.04 e EasyPanel

## 1. Decisão

Usar o projeto EasyPanel compartilhado e duradouro `espectro-mvp`. Os serviços
do CRM recebem o prefixo `silmer-`, que define sua fronteira operacional dentro
do projeto. O desenvolvimento e os testes técnicos continuam locais ou no CI.

Em 05/10/2026, o proprietário determinou preservar o fluxo que já faz deploy
automático a partir do GitHub, conforme a
[ADR 022](docs/adr/022-manter-deploy-automatico-github-easypanel.md). O projeto
e os serviços abaixo são a baseline registrada; a associação entre o deploy
atual, sua fonte, SHA e imagem executada precisa de evidência do painel.
O [relatório de checagens](docs/runbooks/production-readiness-checks.md)
separa observações públicas, registros históricos e pendências do ambiente alvo.

A decisão elimina projetos separados de desenvolvimento, homologação e produção.
O risco de isolamento reduzido e de competição com serviços não relacionados foi
aceito para o piloto. A evolução para projeto ou host próprio passa a ser exigida
quando os gatilhos da seção 13 forem atingidos.

Não criar projeto de observabilidade dentro da mesma VPS: o monitor de uptime
precisa estar fora do domínio de falha do host. O n8n é obrigatório no MVP e
entra no projeto `espectro-mvp` com o prefixo `silmer-`, persistência própria,
sem acesso direto ao banco do CRM e com somente o webhook do canal publicado.

## 2. Serviços no projeto

| Serviço           | Tipo EasyPanel     | Imagem                                 |                 Público | Persistência                                  |
| ----------------- | ------------------ | -------------------------------------- | ----------------------: | --------------------------------------------- |
| `silmer-edge-web` | App                | GHCR por digest                        | Sim, 80/443 via domínio | Nenhuma                                       |
| `silmer-api`      | App                | GHCR por digest                        |                     Não | Volume de mídia leitura/escrita ao ativar T02 |
| `silmer-worker`   | App                | Mesma imagem runtime, comando distinto |                     Não | Volume de mídia leitura/escrita ao ativar T02 |
| `silmer-postgres` | PostgreSQL Service | Major fixada                           |                     Não | Volume EasyPanel + backup externo             |
| `silmer-n8n`      | App                | n8n por versão e digest fixados        |                     Não | Nenhuma; usa banco próprio                    |
| `silmer-n8n-db`   | PostgreSQL Service | Major fixada                           |                     Não | Volume EasyPanel + backup externo             |

`migrate` é um job curto executado pelo pipeline ou script salvo do EasyPanel;
não é serviço permanente.

O inventário em `ops/easypanel/topology.json` registra o provisionamento
histórico de quatro serviços e ainda não contém n8n. Seus digests, domínios
nulos e flags de workflow não descrevem automaticamente o ambiente atual.
Atualizá-lo exige configuração e prova live; este planejamento não comprova
a existência, ausência ou estado atual dos serviços do n8n.

Os arquivos do pedido ([ADR 023](docs/adr/023-arquivos-da-arte-no-rustfs.md))
usam o serviço `rustfs` já existente no projeto EasyPanel `schedule`, fora do
`espectro-mvp` (seção 5). Ele aparece em `sharedServices` de
`ops/easypanel/topology.json` com status `existing-with-gaps`, e o
`objectStorageGate` de `ops/easypanel/provisioning-gate.json` fica
`pending-external` até cada lacuna ser fechada com evidência.

Não subir no MVP:

- Redis ou BullMQ;
- MinIO (o object storage dos arquivos do pedido é o RustFS da ADR 023);
- Elasticsearch ou Meilisearch;
- Grafana, Prometheus ou Loki próprios;
- banco/admin UI permanentemente habilitado.

## 3. Rede e domínios

```text
Internet e Meta
      |
   HTTPS 443
      |
silmer-edge-web (único serviço público)
   |-- /                         bundle estático da SPA Vue
   |-- /api/*                    silmer-api:3000
   |-- /webhook/meta/*           silmer-n8n:5678
   `-- /api/v1/events            silmer-api:3000 (SSE)
          |                              |
          |                       silmer-postgres privado
          |                              |
          |                       silmer-worker privado
          |
          |                       schedule_rustfs:9000 (projeto schedule;
          |                       só silmer-api; lacunas na seção 5)
          |
   silmer-n8n privado --------> silmer-api privada
          |
   silmer-n8n-db privado
          |
   Meta / OpenAI
```

Domínios propostos, substituindo `<dominio>` pelo domínio aprovado:

O endpoint histórico `espectro-mvp-silmer-edge-web.jicnzg.easypanel.host`
respondeu às checagens públicas em 05/10/2026. É a referência do cloud-dev;
essa observação não aprova o domínio final nem os controles privados da VPS.

| Finalidade   | Domínio               | Proteção adicional                                  |
| ------------ | --------------------- | --------------------------------------------------- |
| CRM          | `crm.<dominio>`       | Login da aplicação, HSTS e rate limiting            |
| webhook Meta | `hooks.crm.<dominio>` | Público somente na rota WhatsApp do n8n             |
| EasyPanel    | `ops.<dominio>`       | VPN/allowlist, MFA obrigatório e contas individuais |

VPN, allowlist ou Basic Auth não podem bloquear o callback público da Meta. O
host `hooks.crm.<dominio>` roteia somente o caminho publicado do webhook do
n8n; editor, API administrativa e demais rotas retornam `404`. Assinatura,
verify token, limite de corpo e rate limit permanecem no workflow e no proxy.
O n8n acessa o CRM somente pela API privada e não recebe rota ou credencial para
`silmer-postgres`.

O pedido pago da loja do site também chega pelo n8n: o workflow do checkout
da InfinitePay chama `POST /api/v1/integrations/n8n/store-orders` com a mesma
credencial Basic de automação
([ADR 028](docs/adr/028-pedido-pago-da-loja-pelo-n8n.md)). Não há escrita
pública sem autenticação. Variáveis (`STORE_ORDERS_HMAC_KEY`,
`STORE_ORDERS_ACCEPT_TEST`, `APP_BASE_URL`) e verificação no
[runbook da loja](docs/runbooks/loja-do-site.md).

### Firewall Hostinger

- `80/443`: público.
- `22`: somente IP administrativo ou VPN.
- Painel EasyPanel: somente VPN/allowlist.
- PostgreSQL e portas internas: nunca publicados. O RustFS do projeto
  `schedule` ainda tem domínios públicos padrão (seção 5); isso é lacuna
  aberta, não exceção aprovada.
- Remover qualquer porta de teste depois do diagnóstico.

## 4. Sizing inicial

Baseline recomendada: **Hostinger KVM 4, com 4 vCPU, 16 GB RAM e 200 GB NVMe**.
Ela é a hipótese inicial para o CRM e o n8n junto dos demais serviços do
projeto, desde que o envelope agregado seja novamente validado e os jobs do
worker tenham concorrência limitada. A aprovação anterior da issue
`#8` não mediu o n8n e, portanto, não prova esse novo envelope.

Essa recomendação só vale para o envelope de carga da seção 13 do TDD.
T07.1 bloqueia o piloto se a carga aprovada não atingir os SLOs ou se a previsão
de negócio exceder o envelope sem novo sizing.

Licença EasyPanel mínima: **Hobby**, porque backups agendados e domínio próprio
são controles operacionais do piloto. Usar **Growth** se mais de uma pessoa
precisar acessar o painel com controles adicionais.

Os valores abaixo são **limites máximos**, não reservas somáveis:

| Serviço           | Limite máximo do piloto |
| ----------------- | ----------------------: |
| `silmer-postgres` |       4–5 GB, até 2 CPU |
| `silmer-api`      |     1–1,5 GB, até 1 CPU |
| `silmer-worker`   |       2 GB, até 1,5 CPU |
| `silmer-edge-web` |        256 MB, 0,25 CPU |
| `silmer-n8n`      |       1,5 GB, até 1 CPU |
| `silmer-n8n-db`   |       1,5 GB, até 1 CPU |

Na auditoria autenticada de 05/10/2026, API, worker, edge e PostgreSQL exibiram
reservas e limites de CPU/memória em 0, descritos como **unlimited**. Os valores da tabela
continuam sendo a hipótese de sizing; não são a configuração observada.
O worker mostrou uma réplica, comando `node apps/worker/src/worker.js` e nenhuma
entrada na seção de portas publicadas. Heartbeat e hardening continuam gates
independentes.

O Advanced da API mostrou uma réplica, Zero Downtime marcado, comando sem
override e nenhuma entrada de porta publicada. Domains do edge confirmou
HTTPS do host conhecido → `http://espectro-mvp_silmer-edge-web:8080/`. Essas
telas comprovam a configuração ali exibida; não substituem firewall ou
identificação da revisão executada.

Regras operacionais:

- manter ao menos 30% do disco livre;
- conferir o custo do build Git do fluxo EasyPanel atual no envelope da VPS e
  vincular a imagem realmente executada à revisão e aos gates de supply chain;
- limitar concorrência dos jobs e do scanner no worker;
- reservar 3 GB para Ubuntu, EasyPanel, Traefik, logs, métricas, backup e
  manutenção do PostgreSQL;
- incluir os serviços não relacionados no orçamento agregado de CPU, RAM e disco;
- contar o volume do `schedule/rustfs` na regra de disco livre, porque ele é
  compartilhado com outros apps do projeto `schedule`.

## 5. Armazenamento de arquivos

### Mídia enviada do chat (implementada; ativação remota pendente)

A [ADR 029](docs/adr/029-midia-do-chat-no-rustfs.md) escolhe o RustFS já
existente e preserva mídia enviada do chat sem TTL de sete dias nem expurgo
ao encerrar. Buckets próprios privados do CRM são separados de
`hermes-backups`; leitura usa autorização do CRM. Configuração observada,
limites da evidência e gates de backup/restore estão no
[contexto](.specs/features/inbox-media-rustfs/context.md) e no
[plano](.specs/features/inbox-media-rustfs/design.md). Compatibilidade, API,
worker, Inbox e cleanup têm implementação/evidência local; nenhum bucket,
credencial, upgrade ou deploy remoto foi executado nesta entrega. Perfil local
opt-in `npm run dev:media` usa DB/volumes próprios, API/worker/n8n construídos e
HTTP interno somente loopback por namespace compartilhado do RustFS. API e
worker têm 2GiB/1CPU cada, n8n2GiB/1CPU, RustFS1GiB/1CPU; os valores são orçamento
do perfil local, sem substituir medição/sizing do deployment remoto. Worker
consome uma conversão por vez; API admite dois pipelines no máximo por bucket.
Spool privado e definições ClamAV UID1000 persistem; API monta definições readonly.
Backup externo e restore isolado permanecem gates sem evidência operacional.
As subseções seguintes descrevem o runtime transitório legado e a opção
R2 futura, não a retenção da nova mídia enviada do chat.

### Piloto interno sem custo incremental

Imagens e arquivos de canal ainda não promovidos a registro comercial válido
usam um volume privado `silmer-media` na VPS. O volume não possui domínio,
porta pública nem backup. API e worker montam leitura/escrita: a API recebe,
valida e publica uploads seguros, enquanto o worker executa expurgo e
reconciliação. Bytes são entregues apenas por rota autenticada/autorizada,
nunca como caminho de filesystem ou URL pública.

Cada objeto usa chave opaca, arquivo parcial separado, hash e `expires_at` no
PostgreSQL. O vencimento é o menor entre sete dias do recebimento/envio e o
evento terminal da jornada. O evento agenda a limpeza imediata e um sweeper
diário cobre falhas. A quota é configurada conforme o espaço real do host e
falha fechada para novos uploads antes de ameaçar PostgreSQL e serviços
compartilhados; texto e reconciliação continuam operacionais. O volume fica
fora de backup e restore.

Arquivo inválido é apagado e nunca sai da quarentena. Arquivo válido é
anexado pelo operador ao pedido, que o guarda no RustFS; hash, operador,
timestamp e resultado ficam registrados no CRM. Não há promoção automática a
partir do canal. Falha ou limitação fica visível para reconciliação, mas não
prolonga o TTL da cópia transitória.
Pedido, Ficha, orçamento aprovado, comprovante PIX válido, eventos comerciais,
auditoria, tombstones e backups não usam essa retenção curta.

Perda do volume torna a mídia transitória `lost/unavailable` e é risco aceito
do piloto interno. Não há promessa de restauração desses bytes.

### Arquivos do pedido no RustFS

A [RFC 011](docs/rfc/011-arquivos-da-arte-no-rustfs.md) e a
[ADR 023](docs/adr/023-arquivos-da-arte-no-rustfs.md) guardam os arquivos da
arte em RustFS S3-compatible. O PO indicou uma instância já existente, não um
serviço novo do CRM. Fatos observados no EasyPanel em 05/10/2026, somente
leitura:

- serviço `rustfs` no projeto `schedule`, compartilhado com n8n, redis,
  postgres-pgvector, project-hub, tecnolar e food-helper-migrations;
- host interno `schedule_rustfs`, API S3 na porta 9000 e console na 9001;
- endpoint da API do CRM: `OBJECT_STORAGE_ENDPOINT=http://schedule_rustfs:9000`,
  pela rede overlay entre projetos do EasyPanel, ainda sem smoke que confirme
  o alcance a partir de `silmer-api`.

O contrato do CRM continua o mesmo:

- só `silmer-api` fala com o RustFS, pelo host interno; edge, worker e n8n não
  recebem rota nem credencial;
- o bucket `crm-silmer-arquivos` é privado;
- upload e download passam pela API, sem URL pré-assinada nem link público. A
  API aplica allowlist de formato por assinatura de conteúdo, SHA-256,
  auditoria e idempotência;
- cada pedido aceita até cinco arquivos da arte de até 10 MB e uma arte final
  fora dessa conta. Envio e remoção exigem pedido pendente e permissão de
  edição; download exige leitura do pedido;
- o volume do RustFS fica no mesmo host que o PostgreSQL. Esse domínio de
  falha comum só é aceito se o bucket entrar no backup off-host e no drill de
  recuperação junto com o PostgreSQL (seção 10). Para arquivos do pedido, isso
  supersede a rejeição de MinIO na mesma VPS do TDD.

Lacunas abertas, registradas em `gaps` do `topology.json`. Cada uma bloqueia o
`objectStorageGate`, e o validador recusa gate aprovado enquanto existir
qualquer uma delas:

| Lacuna                                 | Situação observada                                                    |
| -------------------------------------- | --------------------------------------------------------------------- |
| `public-s3-and-console-domains`        | Domínios públicos padrão do EasyPanel para S3 (9000) e console (9001) |
| `cross-project-endpoint-smoke-pending` | Alcance de `schedule_rustfs:9000` a partir de `silmer-api` sem smoke  |
| `image-digest-not-confirmed`           | Imagem, tag e digest da instância não confirmados                     |
| `dedicated-bucket-credential-pending`  | Política `crm-silmer-arquivos-rw` criada; usuário e chaves pendentes  |
| `off-host-backup-not-evidenced`        | Backup off-host do volume sem evidência                               |

O bucket privado `crm-silmer-arquivos` foi criado pelo console em 05/10/2026
(sem versionamento, bloqueio de objeto ou cota); o console mostrava RustFS
`v1.0.0-alpha.99`, diferente do `1.0.1` do ambiente local.

Os hostnames dos domínios públicos não são versionados. O digest
`rustfs/rustfs:1.0.1@sha256:1803…` vale só para o `docker-compose.dev.yml`; ele
não descreve a instância do `schedule` enquanto a imagem não for confirmada.

A ativação em produção segue o runbook
[ativacao-arquivos-da-arte](docs/runbooks/ativacao-arquivos-da-arte.md).

Recomendações para fechar as lacunas:

1. Remover os dois domínios públicos. Se o console precisar ficar acessível,
   restringi-lo por autenticação e allowlist de IP. O domínio S3 público nunca
   é endpoint do CRM e não pode continuar publicado para fechar a lacuna.
2. Criar no RustFS um usuário com a policy `crm-silmer-arquivos-rw` (já
   criada em 06/10/2026, só para `crm-silmer-arquivos`) e
   usar essa credencial em `OBJECT_STORAGE_ACCESS_KEY_ID` e
   `OBJECT_STORAGE_SECRET_ACCESS_KEY`. As chaves root da instância nunca vão
   para o CRM.
3. ~~Criar o bucket privado~~: feito em 05/10/2026.
4. Incluir o volume do RustFS no backup off-host e restaurar só o bucket do
   CRM no drill, sem sobrescrever dados dos outros apps do projeto `schedule`.
5. Executar o smoke de `silmer-api` para `schedule_rustfs:9000` e registrar a
   imagem e o digest em execução.
6. ~~Aceitar o compartilhamento do projeto `schedule`~~: aceito pelo PO em
   05/10/2026 na ADR 023, com credencial e restore restritos ao bucket.

### Object storage futuro

O contrato S3-compatible externo permanece versionado para arquivo durável,
backups e tombstones quando os gatilhos da issue `#29` ocorrerem. Ele não
substitui o RustFS dos arquivos do pedido sem nova decisão. Cloudflare R2
Standard não está autorizado nem provisionado nesta fase. O fallback com
residência explícita no Brasil continua AWS S3 `sa-east-1`.

Buckets/prefixos separados por finalidade:

- `crm-silmer-data`;
- `crm-silmer-backups`;
- `crm-silmer-tombstones`.

Controles:

- nenhuma ACL pública;
- credencial distinta por finalidade e menor privilégio;
- chave opaca sem nome, telefone ou número de documento;
- URL assinada de operação/objeto único, com no máximo 300 segundos, nunca
  registrada em log/evidência e entregue pela aplicação com
  `Cache-Control: no-store`;
- criptografia em trânsito e repouso;
- metadados e autorização no PostgreSQL;
- lifecycle destrutivo do provedor somente para backups; abort de multipart e
  transições não destrutivas são permitidos, retenções dependentes de evento e
  `legal_hold` ficam no worker P0.6, e tombstones ficam sob Bucket Lock;
- backups e objetos temporários expiram em até 35 dias;
- dados reais nunca entram em teste local, CI ou drill não autorizado.

As credenciais são separadas por função:

- `crm-silmer-data`: runtime lê/escreve objetos do domínio, sem acesso a
  backups ou tombstones;
- `crm-silmer-backups`: somente o mecanismo de backup escreve; runtime não
  recebe credencial;
- `crm-silmer-tombstones`: o token R2 de escrita é restrito ao bucket, mas como
  o provedor não oferece permissão IAM create-only, o job também usa chave
  imutável, `If-None-Match: *` e Bucket Lock; o restore usa credencial read-only
  mantida fora do runtime normal.

O bucket de tombstones usa **Cloudflare R2 Bucket Lock** no prefixo
`tombstones/`, por pelo menos 36 dias e até expirar a última cópia relacionada,
o que for maior, com criação
condicional e cópia independente sob outra credencial. R2 não implementa S3
Object Lock, seus headers nem versionamento de bucket; esses mecanismos nunca
são usados como prova de imutabilidade. A credencial que altera Bucket Lock fica
fora do runtime, protegida por MFA e auditoria, e qualquer mudança exige
aprovação de Privacidade/DevOps. O gate testa overwrite e exclusão, mas não
representa Bucket Lock como equivalente a AWS Object Lock compliance mode.

Os controles desta subseção são uma rota futura e não provam buckets,
credenciais, DPA, localização ou recuperação live. Até a issue `#29`, mídia
transitória pode existir somente no volume da VPS conforme o risco aceito;
documentos duráveis não podem depender dele.

## 6. Variáveis e segredos

Segredos usam o escopo `silmer` no projeto e não entram em `.env` versionado:

```text
APP_ENV
APP_BASE_URL
DATABASE_URL
SESSION_SECRET
ENCRYPTION_KEY
META_APP_ID
META_APP_SECRET
META_VERIFY_TOKEN
META_WEBHOOK_PAYLOAD_ENVELOPE_KEY
META_WHATSAPP_BUSINESS_ACCOUNT_ID
META_WHATSAPP_PHONE_NUMBER_ID
META_INSTAGRAM_ACCOUNT_ID
META_ACCESS_TOKEN
AI_PROVIDER
AI_MODEL_PRIMARY
OPENAI_API_KEY
S3_ENDPOINT
S3_REGION
S3_DATA_BUCKET
S3_DATA_ACCESS_KEY_ID
S3_DATA_SECRET_ACCESS_KEY
S3_BACKUP_BUCKET
S3_BACKUP_ACCESS_KEY_ID
S3_BACKUP_SECRET_ACCESS_KEY
TOMBSTONE_BUCKET
TOMBSTONE_WRITE_ACCESS_KEY_ID
TOMBSTONE_WRITE_SECRET_ACCESS_KEY
TOMBSTONE_READ_ACCESS_KEY_ID
TOMBSTONE_READ_SECRET_ACCESS_KEY
PIX_KEY_ID
PIX_KEY_VALUE
PIX_KEY_DISPLAY_MASKED
FICHA_RECIPIENT_E164
FAB_CODE
STORE_ORDERS_HMAC_KEY
STORE_ORDERS_ACCEPT_TEST
N8N_ENCRYPTION_KEY
N8N_HOST
N8N_EDITOR_BASE_URL
WEBHOOK_URL
DB_TYPE
DB_POSTGRESDB_HOST
DB_POSTGRESDB_DATABASE
DB_POSTGRESDB_USER
DB_POSTGRESDB_PASSWORD
CRM_API_BASE_URL
CRM_AUTOMATION_CLIENT_ID
CRM_AUTOMATION_CLIENT_SECRET
CRM_AUTOMATION_PREVIOUS_CLIENT_SECRET
N8N_INTEGRATION_ENABLED
N8N_INTEGRATION_ENVELOPE_KEY
CONTACT_IDENTITY_ENVELOPE_KEY
CONTACT_IDENTITY_LOOKUP_KEY
INBOX_MESSAGE_ENVELOPE_KEY
N8N_COMMAND_URL
N8N_COMMAND_CLIENT_ID
N8N_COMMAND_CLIENT_SECRET
N8N_COMMAND_TIMEOUT_MS
N8N_COMMAND_REPLAY_SAFE
PRIVATE_MEDIA_ROOT
PRIVATE_MEDIA_MAX_BYTES
PRIVATE_MEDIA_MAX_FILE_BYTES
MEDIA_RETENTION_SCAN_INTERVAL_MS
OBJECT_STORAGE_ENDPOINT
OBJECT_STORAGE_REGION
OBJECT_STORAGE_BUCKET
OBJECT_STORAGE_ACCESS_KEY_ID
OBJECT_STORAGE_SECRET_ACCESS_KEY
```

Regras:

- tokens Meta, buckets, banco e chaves não são compartilhados com outros
  serviços do projeto;
- tokens Meta e chave do provedor de IA ficam somente no n8n; a credencial
  `CRM_AUTOMATION_*` não concede administração nem acesso ao banco do CRM;
- `CRM_AUTOMATION_PREVIOUS_CLIENT_SECRET` existe somente durante a janela
  curta de rotação e deve ser removida depois do smoke com o segredo novo;
- `CRM_AUTOMATION_*` identifica n8n→CRM; `N8N_COMMAND_CLIENT_*` é outra
  credencial Basic, exclusiva para CRM→n8n, e os valores nunca são exportados;
- `CONTACT_IDENTITY_*` e `INBOX_MESSAGE_ENVELOPE_KEY` devem reutilizar as
  chaves dos respectivos módulos canônicos; `N8N_INTEGRATION_ENVELOPE_KEY`
  protege briefing, payload de comando, filename e resumo;
- `N8N_COMMAND_REPLAY_SAFE=true` só é permitido depois que a reserva remota
  anterior à Meta foi comprovada em homologação; até lá, timeout produz
  `outcome_unknown` e reconciliação;
- `N8N_ENCRYPTION_KEY` é obrigatória, fica em escrow operacional e deve ser
  restaurável junto do banco próprio do n8n;
- `OBJECT_STORAGE_*` existe somente em `silmer-api`: endpoint
  `http://schedule_rustfs:9000`, região `us-east-1`, bucket
  `crm-silmer-arquivos` e credencial dedicada com policy restrita ao bucket.
  As chaves root do RustFS (`RUSTFS_ACCESS_KEY` e `RUSTFS_SECRET_KEY`) ficam
  somente no serviço do projeto `schedule` e nunca entram no CRM;
- `PIX_KEY_VALUE` fica disponível somente ao runtime que monta a mensagem e
  não aparece em log, frontend ou variável de build;
- `secret://crm/order-recipient-phone` é resolvido somente no runtime para
  `FICHA_RECIPIENT_E164`; o telefone não aparece em código, documentação, log
  ou artefato de build;
- rotação trimestral e imediata após incidente ou saída de operador;
- o workflow versionado do GitHub Actions recebe somente a credencial de
  publicação no GHCR; a configuração efetiva do deploy automático EasyPanel
  deve preservar a separação dos segredos de runtime e ser conferida no painel;
- alterações de segredo geram registro operacional e smoke test.

## 7. Health checks

| Serviço            | Endpoint/check          | Critério                                            |
| ------------------ | ----------------------- | --------------------------------------------------- |
| edge               | `GET /healthz`          | Nginx responde 200                                  |
| API live           | `GET /api/health/live`  | event loop/processo saudável                        |
| API ready          | `GET /api/health/ready` | banco acessível e schema compatível                 |
| worker local       | processo/loop local     | processo responde sem consultar dependência externa |
| worker operacional | heartbeat no PostgreSQL | idade inferior a 120 s                              |
| postgres           | `pg_isready`            | conexão aceita                                      |
| n8n live           | health interno          | processo saudável sem publicar editor               |
| n8n operacional    | workflow sintético      | webhook, banco próprio e API do CRM correlacionados |
| n8n postgres       | `pg_isready`            | conexão aceita somente na rede privada              |

Dependências Meta, IA e storage possuem diagnóstico separado e não derrubam o
container. Docker `HEALTHCHECK`: intervalo 30 s, timeout 5 s, start period 20 s
e três falhas. O monitor externo consulta `/api/health/ready` através do edge,
não apenas `/healthz`. Falha de banco alerta o worker, mas não cria loop de
restart contínuo.

Com `N8N_INTEGRATION_ENABLED=true`, o gate de ativação também exige schema
0013, volume privado gravável e scanner com assinatura de até 36 horas. A rota
direta da Meta no CRM retorna indisponível; isso é comportamento de corte, não
fallback.

### Hardening dos containers

- usuário não-root e capabilities removidas;
- filesystem read-only quando possível;
- temporários em tmpfs/volume limitado e descartável;
- imagens-base fixadas por digest;
- `clamscan` com concorrência 1, timeout e limite de memória;
- assinatura-base ClamAV na imagem e `freshclam` em tmpfs no startup e a cada
  24 horas; idade acima de 36 horas bloqueia liberação do anexo e gera alerta.

## 8. CI/CD

O branch canônico atual é `master`.

### Pull request

1. lint e `checkJs`;
2. unitários e integração com PostgreSQL;
3. contratos e evals da IA;
4. E2E e acessibilidade;
5. validação e diff dos exports versionados de workflows n8n;
6. build das duas imagens;
7. scan de dependências e imagem;
8. `git diff --check`.

### Merge e promoção

1. Merge em `master` executa os gates do workflow versionado e publica
   `edge-web` e `runtime` no GHCR com SHA e digest.
2. O fluxo GitHub → EasyPanel existente permanece como mecanismo de deploy
   escolhido. A auditoria confirmou API e worker com fonte Git
   `romulosutil/crm-silmer`, branch `master`, build path `/` e Dockerfile
   `docker/runtime.Dockerfile`. O edge usa o mesmo Git/branch/path com
   `docker/edge-web.Dockerfile`. Edge e worker têm Auto Deploy ativo; a API está
   com Auto Deploy desativado. Esta divergência precisa ser resolvida no fluxo
   escolhido antes de depender de deploy automático coordenado em produção.
   Em 06/10/2026 a API recebeu deploy do `5a0391d` minutos após o merge da
   PR #150, como o edge; o gatilho desse deploy não foi
   verificado. A imagem local produzida pelo painel não comprova consumo do digest GHCR
   escaneado pelo CI.
3. Registrar projeto/serviço, branch, gatilho, SHA implantado, referência da
   imagem atual e anterior e resultado da última execução, sem URLs com token.
4. Conferir o comportamento de migrations e a ordem API/worker/edge; migrations
   usam advisory lock e expand/contract. A existência do gatilho automático não
   comprova que a migration foi aplicada.
5. Publicação de workflows n8n exige versão compatível e homologada, com CRM
   compatível implantado antes do workflow e versão anterior para rollback.
6. Executar health/readiness, heartbeat e smoke WhatsApp → n8n → CRM → Inbox;
   registrar a aprovação operacional antes de liberar tráfego real.

A `.github/workflows/ci.yml` atual testa, escaneia e publica imagens, mas não
chama a API administrativa do EasyPanel. Isso não exclui um gatilho configurado
diretamente no painel ou integração GitHub externa ao workflow. Não expor essa
API para completar a checagem. A promoção manual deixa de ser o fluxo obrigatório;
rollback, backup e rastreabilidade por SHA/imagem permanecem gates próprios.

A produção exige imagem identificável e referência anterior recuperável.
Não usar `latest` como evidência de versão; um status verde de CI ou um endpoint
saudável isolado não identifica o código executado.

## 9. Migração e rollback

Sequência de deploy do contrato n8n v1:

1. verificar backup e espaço livre;
2. ativar manutenção quando necessário;
3. aplicar migration expand-only com `N8N_INTEGRATION_ENABLED=false`;
4. implantar API e worker e configurar duas credenciais Basic distintas;
5. atualizar o workflow `k7tI6T4RhQPyJkn9` ainda inativo;
6. executar contrato, banco, scanner e smoke WhatsApp de homologação;
7. publicar o workflow, transferir o webhook Meta para o n8n e habilitar a
   integração, tornando a rota direta do CRM indisponível;
8. implantar edge, verificar live, ready, heartbeat e monitorar 30 minutos.

A versão de workflow a implantar vem do export/SDK versionado em
`ops/n8n/workflows/` e deve ser comparada com a versão publicada no painel.
O ID de rascunho e os 42 nós preservados no inventário histórico não provam a
versão atual. Credenciais Basic distintas e homologação WhatsApp continuam
gates; Instagram entra depois em `CANAL-2`.

Migrações seguem expand/contract. Remover tabela/coluna ocorre somente quando o
digest anterior já não depender dela. Rollback normal reaponta para o digest
anterior; restore de banco é último recurso.

Triggers de rollback:

- 5xx acima de 5% por 5 minutos;
- perda ou duplicidade de efeito comercial;
- webhook não persistido;
- worker sem progresso ou dead-letter crescente;
- workflow n8n incompatível, em loop ou sem correlação com o CRM;
- violação de autorização ou exposição de dados;
- migration incompatível.

Rollback despublica/pausa o novo workflow e a automação, preserva comandos,
tentativas e reconciliações e reaponta apenas os runtimes compatíveis. Ele não
reativa silenciosamente a entrada direta da Meta.

## 10. Backups e disaster recovery

Na auditoria de 05/10/2026, `silmer-postgres` mostrou **Local Disk / Manual Run**
e uma entrada de backup anterior a migration. Isso não comprova cópia externa,
agendamento ou restore. A exposição do banco no painel estava em **Exposed
Port = 0**; firewall do host permanece uma checagem separada.

Produção:

- `pg_dump` horário, 48 cópias, para CRM e banco próprio do n8n;
- `pg_dump` diário, 35 cópias, para ambos os bancos;
- cópia do bucket `crm-silmer-arquivos` do `schedule/rustfs` no mesmo backup
  off-host, junto com os dumps do CRM, porque o volume divide o host com o
  PostgreSQL (ADR 023); hoje sem evidência;
- lifecycle apaga qualquer backup com mais de 35 dias;
- backup manual verificado antes de mudança destrutiva;
- restore mensal do banco em serviço temporário `postgres-restore-drill`,
  isolado, sem UI, worker, rota pública ou credenciais externas;
- drill trimestral de perda total em VPS limpa fora do host de produção;
- RPO alvo de até 1 hora e RTO alvo de até 4 horas para CRM e automação,
  condicionados a novo drill em host limpo que inclua n8n, workflows e sua
  chave de criptografia.

O agendamento usa o backup de PostgreSQL do EasyPanel com storage remoto e
licença compatível. O backup semanal/snapshot da Hostinger é proteção
terciária do host, não substitui os dumps externos.

Um kit off-host versionado, sem segredos em claro, mantém o runbook, versões do
Ubuntu/EasyPanel, topologia de projetos e serviços, regras de rede/DNS, digests,
ordem de migrations e inventário dos segredos. Os valores dos segredos e a
credencial read-only de tombstones ficam em escrow criptografado acessível a
duas pessoas designadas. O kit é validado a cada mudança de topologia.

### Drill mensal do PostgreSQL

1. Criar `postgres-restore-drill` temporário e rede isolada.
2. Restaurar o backup sem copiar o banco para homologação.
3. Restaurar somente o bucket `crm-silmer-arquivos` em RustFS temporário da
   mesma rede isolada.
4. Aplicar migrations e tombstones externos.
5. Validar contagens, constraints, leitura/escrita com mocks sem saída e o
   SHA-256 de uma amostra de arquivos do pedido contra o banco restaurado.
6. Registrar RPO/RTO e destruir os serviços temporários após a evidência.

O drill não interrompe produção e nunca envia WhatsApp, IA ou objetos externos.

### Drill trimestral de perda total da VPS

1. Provisionar uma VPS limpa, isolada e tratada como produção temporária, sem
   reutilizar o EasyPanel do host de produção.
2. Recriar painel, projeto, rede, domínios temporários e serviços pelo kit
   off-host.
3. Recuperar segredos do escrow, promover os digests registrados e manter todos
   os adapters externos em modo mock.
4. Restaurar os bancos do CRM e do n8n e o bucket `crm-silmer-arquivos`,
   aplicar migrations, recuperar workflows e chave de criptografia e reaplicar
   tombstones com a credencial read-only.
5. Validar acesso aos objetos existentes, recuperar uma versão apagada/corrompida
   e confirmar que objetos sujeitos a tombstone não reaparecem.
6. Executar smoke completo de login, inbox, Pedido, PIX, Ficha e reconciliação.
7. Testar troca de DNS em subdomínio de drill com o TTL documentado.
8. Registrar tempos por etapa, RPO/RTO, lacunas e responsáveis pela correção.
9. Destruir o host do drill após preservar evidências sem dados pessoais.

Somente esse drill comprova o RTO do CRM. O restore mensal comprova o backup do
banco, mas não a recuperação de uma perda do host.

### Restore de desastre real

1. Ativar manutenção e parar API/worker.
2. Restaurar o banco de produção e o bucket `crm-silmer-arquivos` em
   instâncias isoladas. Nunca restaurar o volume inteiro do `schedule/rustfs`
   sobre a produção: ele guarda dados de outros apps.
3. Aplicar migrations compatíveis.
4. Reaplicar o ledger externo de `deletion_tombstones`.
5. Excluir objetos que já haviam sido removidos.
6. Validar login, contagens, constraints e leitura/escrita.
7. Executar smoke com adapters externos em modo mock.
8. Registrar evidências do restore.
9. Liberar tráfego somente após aprovação do Administrador Técnico.

O ledger de tombstones é pseudonimizado, criptografado, versionado e armazenado
fora do backup restaurado. Cada entrada permanece pelo menos 36 dias após a
exclusão ou até expirar a última cópia relacionada, o que for maior. Restore de
snapshot/backup Hostinger passa pelo mesmo gate.

## 11. Observabilidade e alertas

Usar métricas/logs do EasyPanel e serviço externo para uptime. Erros e traces
podem usar Sentry ou equivalente após contrato de operador e retenção. Logs
técnicos ficam configurados em 30 dias; 90 dias é apenas o teto jurídico.

Alertas mínimos:

- API indisponível ou 5xx acima do limite;
- worker sem heartbeat;
- n8n indisponível, execução em loop ou versão divergente da publicada;
- reservas de envio obsoletas ou divergentes por epoch/revisão;
- comandos n8n em `processing` além do lease ou em `outcome_unknown`;
- job mais antigo acima de 5 minutos;
- dead-letter ou reconciliação crescente;
- último backup horário bem-sucedido acima de 75 minutos ou diário acima de 26 horas;
- disco 70/80/90% e memória acima de 80%;
- certificado próximo do vencimento;
- falhas repetidas Meta, IA, impressão da Ficha ou storage;
- consumo de tokens/custo da IA fora do esperado.

Audit trail comercial não depende de logs do EasyPanel.

## 12. Gates antes do piloto

- [ ] Domínios, DNS, SSL e firewall validados.
- [ ] Credenciais separadas e rotação testada.
- [ ] Basic n8n→CRM e CRM→n8n criados e vinculados sem HMAC/timestamp.
- [ ] PostgreSQL e serviços internos sem portas públicas.
- [ ] `schedule/rustfs` sem domínio S3 público, console removido ou restrito,
      bucket privado, credencial `OBJECT_STORAGE_*` dedicada só na API, smoke
      entre projetos, imagem confirmada e bucket restaurado no drill junto com
      o PostgreSQL (ADR 023).
- [ ] Editor e API administrativa do n8n sem rota pública; apenas webhook do canal publicado.
- [ ] Ator `AUTOMATION_EXECUTOR` sem acesso administrativo ou direto ao banco do CRM.
- [ ] Backup horário/diário executado e alerta configurado.
- [ ] Restore completo em serviço temporário isolado dentro do RTO.
- [ ] Perda total da VPS recuperada em host limpo dentro do RTO.
- [ ] Tombstones imutáveis, com credenciais separadas, reaplicados depois de restore antigo.
- [ ] Webhook repetido sem duplicar mensagem, Pedido ou job.
- [ ] Cada mensagem válida dispara o n8n sem botão da UI e registra versão, execução e epoch no CRM.
- [ ] Worker parado acumula jobs e recupera a fila ao voltar.
- [ ] Crash durante efeito externo produz `sent`, `failed` ou `outcome_unknown`, sem retry cego.
- [ ] Os sete caminhos de envio reservam `message.send.requested` antes da Meta.
- [ ] Digest promovido e revertido com sucesso.
- [ ] Takeover impede novos envios até o ponto de não retorno e reconcilia resultado incerto.
- [ ] Restore recupera banco, workflows e chave de criptografia do n8n em host limpo.
- [ ] Smoke WhatsApp oficial ponta a ponta aprovado antes da publicação.
- [ ] Instagram oficial e migração de canal aprovados na fase `CANAL-2`.
- [ ] Persistência de execução/manual do n8n desabilitada ou expurgada em até 30 dias, sem PII.
- [ ] Ficha confirmada pode ser impressa pelo navegador e a operação registra
      o encaminhamento externo; geração de PDF no worker não é gate do runtime atual.
- [ ] Ficha impressa v6 com aprovação final: assinatura física de Rose e
      Operação na amostra impressa registrada em
      `docs/phase0/ficha-pdf-approval-v6.json` (ADR 025). A aprovação provisória
      do PO vale só para desenvolvimento e cloud-dev.
- [ ] Monitor externo detecta parada da VPS.
- [ ] Responsável de Privacidade aprova storage, IA e observabilidade.

## 13. Riscos aceitos e evolução

Uma única VPS é ponto único de falha. O CRM compartilha projeto e host com
serviços não relacionados, sem isolamento de desenvolvimento, homologação e
produção. Essa estrutura foi aceita como duradoura para o piloto, mas não altera
os gates de backup externo, monitoramento e recovery drill em host limpo. O
risco específico de perder mídia transitória de até sete dias também foi aceito
para o uso interno; ele não amplia o RPO de PostgreSQL, Pedido, Ficha, PIX,
auditoria, backups ou tombstones. O RustFS dos arquivos do pedido divide o
domínio de falha com o PostgreSQL e o projeto `schedule` com outros apps; a
ADR 023 só aceita isso com o bucket no backup off-host e no drill, e as
lacunas da seção 5 seguem abertas. O
primeiro gatilho de evolução é mover o CRM ou o PostgreSQL para projeto ou
domínio de falha próprio quando qualquer condição ocorrer:

- disponibilidade exigida acima de 99,5%;
- uso sustentado acima de 70% de CPU/RAM/disco;
- janela de backup ou restore excede o SLO;
- operação 24x7 passa a depender do CRM;
- perda potencial de uma hora deixa de ser aceitável.

Redis só entra com evidência de mais de duas réplicas de API, necessidade real
de pub/sub, fila sustentada acima de 1.000 jobs ou atraso p95 acima de 5 s por
15 minutos. Mesmo nesse cenário, PostgreSQL continua fonte da verdade.

## 14. Referências verificadas

- <https://easypanel.io/docs/services>
- <https://easypanel.io/docs/services/app>
- <https://easypanel.io/docs/services/postgres>
- <https://easypanel.io/docs/backups/database>
- <https://easypanel.io/pricing>
- <https://www.hostinger.com/vps/easypanel-hosting>
- <https://www.hostinger.com/support/8703798-how-to-use-the-easypanel-vps-template-at-hostinger/>
- <https://support.hostinger.com/en/articles/1583232-how-to-back-up-or-restore-a-vps>
- <https://www.hostinger.com/support/4805502-how-to-set-up-a-firewall-at-vps/>
