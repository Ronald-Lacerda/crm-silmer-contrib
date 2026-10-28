# WPPConnect privado — preparação do piloto

Rastreabilidade: WPP-01 / OPS-1; ORC-08 e MSG-01..04. Este diretório prepara
um gateway distinto da sessão WAHA anterior. Não implanta, pareia contas,
publica workflow, envia mensagens ou modifica o serviço anterior.

## Fonte e build

- WPPConnect Server `v2.10.69`, commit
  `27d2b0e573870d8ac20e28ed4180a2e51c30c8ea`.
- Core WPPConnect `2.3.6`, fixado pelo `yarn.lock` upstream. O build verifica
  tanto o lock quanto a versão instalada. Não atualiza dependências.
- Node `22.23.4-bookworm-slim`, digest de índice OCI
  `sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`.
  A versão é a [release de segurança de 21/10/2026](https://nodejs.org/en/blog/release/v22.23.4).
- `yarn install --immutable`, Yarn `4.14.1`. Somente `prom-client` e
  `@babel/runtime` passam de dependências de desenvolvimento para runtime,
  conservando as mesmas versões já resolvidas no lock. São importados pelo
  servidor/Babel mesmo com as superfícies de métricas bloqueadas.
- APT instala Chromium e bibliotecas a partir do índice Debian vigente.
  Fonte, base e dependências JS estão fixadas; os pacotes APT não usam
  snapshot. O build é rastreável, mas não é garantido byte a byte idêntico.
  Registrar o digest final da imagem e a versão Chromium após o build.

`Dockerfile.inline` é autossuficiente para a fonte Dockerfile inline do EasyPanel.
Não precisa enviar arquivos locais como contexto. Ele é gerado a partir de
`runtime.cjs`, `webhook.cjs` e `patch-upstream.mjs` por:

```text
node ops/wppconnect/render-dockerfile.mjs
```

Não alterar apenas a cópia gerada. Aplicar mudanças nas fontes, testar e
regenerar. O patch recusa contexto upstream divergente. O runtime utiliza
usuário `node` e `tini`; não inclui Manager ou ferramentas de build.

## EasyPanel — configuração requerida

Serviço previsto: `schedule/silmer-wppconnect`, uma réplica, sem domínio nem
porta pública. A porta interna é `21465`. Persistir um volume dedicado em
`/data`, com proprietário UID/GID `1000:1000` e diretórios privados `0700`.
Ele contém a sessão Chromium, tokens do cliente e token de API. Não reutilizar
o volume ou as credenciais do WAHA anterior.

Começar com limite de 1 CPU e 1536 MiB, verificando consumo e OOM no runtime.
Esses valores são uma configuração inicial, não uma garantia de capacidade.
Não usar container privilegiado, socket Docker, rede do host ou `SYS_ADMIN`.
Aplicar `cap_drop: ALL` e `no-new-privileges` quando suportados pela fronteira
de deploy. Só o n8n e o operador autorizado devem alcançar a API privada.

| Variável                  | Configuração                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_KEY`              | Segredo exclusivo com no mínimo 32 caracteres, obrigatório, sem default.                                                                              |
| `WPP_SESSION`             | Nome técnico da nova sessão, somente letras, números, `_` e `-`; não usar telefone.                                                                   |
| `WPP_PHASE`               | `pair` na preparação; `integrated` somente após identidade comprovada e workflow preparado.                                                           |
| `WPP_SESSION_TOKEN`       | Opcional: hash bcrypt de `WPP_SESSION + SECRET_KEY`, custo 12, com `/`→`_` e `+`→`-`, como no formato upstream.                                       |
| `WPP_WEBHOOK_URL`         | Somente em `integrated`: URL HTTPS exata do webhook n8n, sem credenciais, query ou fragmento.                                                         |
| `WPP_WEBHOOK_TOKEN`       | Somente em `integrated`: segredo exclusivo de no mínimo 32 caracteres para `X-Silmer-WPP-Token`; distinto dos demais.                                 |
| `WPP_EXPECTED_OWN_JID`    | Somente em `integrated`: PN JID real previamente confirmado, em `@c.us` ou `@s.whatsapp.net`; nunca um `@lid` inferido.                               |
| `WPP_CHROMIUM_NO_SANDBOX` | Omitir inicialmente. `true` acrescenta apenas `--no-sandbox`, caso a indisponibilidade do sandbox seja comprovada e a exceção operacional registrada. |

Os demais valores da imagem, incluindo `MANAGER_ENABLED=false`, não exigem
segredo. O bootstrap valida o bcrypt fornecido antes de abrir o listener e
guarda o token em `/data/api/session.token` com modo `0600`. Se ele for omitido,
o bootstrap gera e persiste um hash de sessão privado. Não imprime esse valor.
Alterar o segredo e conservar um token incompatível faz a inicialização falhar.

O `SECRET_KEY` nunca entra em URL. A rota upstream `generate-token` e as
rotas que usam o segredo no caminho estão bloqueadas. O provisionamento
autorizado entrega o mesmo bearer ao n8n por credencial protegida; não imprimir
o token, exportar credenciais existentes ou escrevê-lo no JSON do workflow.

## Pareamento privado

Todas as chamadas de sessão exigem `Authorization: Bearer <token-da-sessão>`
e o nome técnico exato configurado. Tokens no caminho ou em query são recusados.
Não há painel aberto ou publicação de QR por webhook, log ou Socket.IO.

1. `GET /healthz` verifica apenas o processo HTTP, sem autenticar conta.
2. `POST /api/<sessão>/start-session`, com corpo `{}`, inicia somente a sessão
   configurada. O perfil remove parâmetros de telefone, proxy, webhook e espera
   indefinida enviados no corpo. Não inicia todas as sessões automaticamente.
3. `GET /api/<sessão>/qrcode-session` retorna PNG quando existe QR válido.
   Mostrar apenas ao proprietário pelo canal privado autorizado e descartar
   o artefato temporário após o uso; não guardar no repositório.
4. `GET /api/<sessão>/check-connection-session` e
   `GET /api/<sessão>/status-session` consultam o estado.
5. `GET /api/<sessão>/silmer-identity` exige `client.isConnected() === true` e
   retorna somente `connected` e o PN JID real de `client.getWid()`.
   Não devolve os tokens presentes no objeto completo
   de `host-device`. Sem PN JID comprovado, retorna `409` com `connected: false`.
6. `POST /api/<sessão>/close-session` fecha a sessão sem autorizar exclusão
   de dados ou logout por tentativa.

Em `pair`, não são instalados listeners de mensagem/ACK, o webhook é nulo,
envios e consultas de mídia/PN-LID estão bloqueados e não há download automático
de figurinhas. Esse isolamento permite preparar QR sem entregar conversas à IA
ou criar efeitos no CRM. O sucesso da leitura do QR não substitui a confirmação
da identidade e os testes reais.

## Integração e contrato de eventos

O perfil `integrated` acrescenta à allowlist somente envios por texto/base64,
consulta autenticada de mídia por ID e a consulta estrita
`GET /api/<sessão>/contact/pn-lid/<PN-ou-LID-encoded>`. Não permite `host-device`
completo, rotas de arquivos estáticos, Manager, Swagger, Socket.IO, métricas,
rota de encerramento do processo, upload por URL ou alteração de sessão.

`callWebHook` foi substituído por `webhook.cjs`, com estes limites:

- Encaminha apenas `onmessage` e `onack` da sessão configurada. Mensagens
  próprias, grupos, broadcast, QR e códigos de pareamento não são encaminhados.
- Obtém `client.getWid()` do core fixado. Sem PN JID real igual à identidade
  previamente configurada, recusa o evento; nunca substitui identidade por env.
- Sobrescreve `event`, `session`, `__wpp_own_jid` e `__wpp_received_at` depois
  do payload original. O timestamp é ISO UTC com milissegundos e é criado uma
  vez, antes dos retries. O mesmo envelope é usado em todas as tentativas.
- Envia `X-Silmer-WPP-Token` em header separado. Somente URL HTTPS exata
  configurada, sem redirecionamentos; não aceita outro destino no start-session.
- Faz no máximo três tentativas para erro de rede transitório ou HTTP `5xx`,
  com timeout de 30 segundos e espera de 5/10 segundos. Não repete HTTP `4xx`.
  Nunca aplica esse retry às APIs de envio WhatsApp.
- Após falha definitiva, emite apenas `WPP_WEBHOOK_DELIVERY_FAILED`. O logger
  upstream/core e `console` não imprimem corpos, QR, headers ou erros completos.
  Não há outbox durável nesse patch: falha final exige reconciliação e não
  permite afirmar recuperação automática. Reiniciar perde contadores em memória.

O n8n continua responsável pelo adapter, reserva no CRM antes do envio,
confirmação durável do inbound, idempotência, status e resultado incerto. Não
publicar o candidato em paralelo com o principal nos mesmos webhooks. Manter
configuração `pair` até os contratos e a conta nova estarem confirmados.

## Verificação e limites

```text
node --test ops/wppconnect/profile.test.mjs
node ops/wppconnect/verify-upstream.mjs
node ops/wppconnect/render-dockerfile.mjs
```

O segundo comando baixa somente arquivos públicos da fonte fixada, aplica o
patch em diretório temporário e o remove depois. Ele não conecta WhatsApp.
Testes unitários e esse smoke não comprovam compilação da imagem, compatibilidade
do Chromium no host, persistência remota ou entrega no canal. O build EasyPanel,
health, recusa HTTP `401`, QR privado, identidade, testes ponta a ponta e
rollback continuam sendo verificações operacionais do integrador.

O sandbox do Chromium e a validação TLS permanecem habilitados por padrão.
Não usar `--ignore-certificate-errors`, `--ignore-ssl-errors`,
`--disable-web-security` ou desativação de isolamento de sites. Se o ambiente
não suportar o sandbox, registrar a falha observada e manter os limites,
usuário não root, rede privada e restrições do container antes da exceção
estreita de `--no-sandbox`. Isso não restaura a proteção perdida do sandbox.

Fontes primárias:
[release do servidor](https://github.com/wppconnect-team/wppconnect-server/releases/tag/v2.10.69),
[commit fixado](https://github.com/wppconnect-team/wppconnect-server/tree/27d2b0e573870d8ac20e28ed4180a2e51c30c8ea),
[getWid do core](https://github.com/wppconnect-team/wppconnect/blob/v2.3.6/src/lib/wapi/functions/get-wid.js)
e [configuração de browser do core](https://github.com/wppconnect-team/wppconnect/blob/v2.3.6/src/config/puppeteer.config.ts).
