# Runbook — pedido pago da loja do site

Decisão: [ADR 028](../adr/028-pedido-pago-da-loja-pelo-n8n.md) e
[RFC 016](../rfc/016-pedido-pago-da-loja-pelo-n8n.md), que supersedem em parte a
[ADR 027](../adr/027-venda-da-loja-do-site.md), e
[ADR 031](../adr/031-aviso-de-pedido-novo-do-site.md) /
[RFC 019](../rfc/019-aviso-de-pedido-novo-do-site.md) (aviso de pedido novo do
site). Requisitos `LOJ-15`–`LOJ-37` da
[spec](../../.specs/features/pedidos-mvp/spec.md); tarefas T110–T120 de
[tasks](../../.specs/features/pedidos-mvp/tasks.md).

A loja `silmer.com.br/loja` cobra pelo Checkout Integrado da InfinitePay, só
Pix. O workflow n8n "Silmer | Loja | Checkout InfinitePay" (id
`SbNSW5jwBcXM5Afj`) confirma o pagamento com `payment_check` e chama o CRM,
servidor a servidor, com a credencial de automação. O CRM cria um pedido
**Confirmado**, travado, sem conversa nem contato, e devolve o número
`NN-CRM`, o `LJ-…` e os links do pedido e da ficha. O Dashboard mostra o aviso
"N pedidos novos do site" até alguém imprimir a ficha (seção
[Pedido novo do site](#pedido-novo-do-site-adr-031)); não há WhatsApp
automático ao vendedor. O contrato exato do nó HTTP está no
[README do n8n](../integrations/n8n/README.md#pedido-pago-da-loja-adr-028) e no
OpenAPI (`recordStoreOrder`).

## URLs

| Ambiente                           | URL da rota                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Cloud-dev/piloto (único hoje)      | `https://espectro-mvp-silmer-edge-web.jicnzg.easypanel.host/api/v1/integrations/n8n/store-orders` |
| Produção, quando o domínio existir | `https://crm.<dominio>/api/v1/integrations/n8n/store-orders`                                      |
| Local (`npm run dev`)              | `http://127.0.0.1:4173/api/v1/integrations/n8n/store-orders`                                      |

A rota pública da ADR 027 (`/api/v1/public/loja/pedidos`) nunca foi publicada e
não existe mais; o site não chama o CRM.

## Variáveis da `silmer-api`

| Variável                                                   | Valor                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORE_ORDERS_HMAC_KEY` (nova)                             | 32 bytes aleatórios em base64url. Liga a rota e a busca do pedido pelo telefone. Segredo: nunca versionar nem reaproveitar de outra variável.                                               |
| `STORE_ORDERS_ACCEPT_TEST` (nova)                          | `true` enquanto o n8n testa (aceita `teste: true`, inclusive o Pix de R$ 1,00, e deixa o pedido fora do Dashboard); `false` quando só pedido real deve entrar (`422 TEST_REFUSED`).         |
| `APP_BASE_URL` (já no inventário; passa a ser lida)        | Onde as pessoas abrem o CRM, sem barra no fim. Cloud-dev: `https://espectro-mvp-silmer-edge-web.jicnzg.easypanel.host`. Sem ela, `pedido_url` e `ficha_url` voltam relativas.               |
| `FAB_CODE`, `N8N_INTEGRATION_ENVELOPE_KEY`                 | Já existem; o pedido usa as mesmas.                                                                                                                                                         |
| `CRM_AUTOMATION_CLIENT_ID`, `CRM_AUTOMATION_CLIENT_SECRET` | Já existem; a ação `store.order.record` entra na lista do `AUTOMATION_EXECUTOR` com a versão nova, sem credencial nova.                                                                     |
| Removidas                                                  | `STORE_ORDERS_ALLOWED_ORIGINS`, `STORE_ORDERS_MAX_PER_IP_HOUR`, `STORE_ORDERS_MAX_PER_PHONE_DAY` e `STORE_ORDERS_MAX_REQUESTS_PER_MINUTE` (nunca foram configuradas; se existirem, apagar). |

Sem `STORE_ORDERS_HMAC_KEY` a rota responde `404`. Com ela, `FAB_CODE` ausente,
chave malformada, `STORE_ORDERS_ACCEPT_TEST` diferente de `true`/`false` ou
`APP_BASE_URL` que não seja uma URL `https://…` única impedem a API de subir.
`APP_BASE_URL` é uma URL só, não uma lista como `APP_ORIGIN`: vírgula ou espaço
no valor reprovam.

Gerar a chave (fora do repositório, sem colar em chat ou log):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## Deploy, passo a passo

1. **Merge** da PR #155 no `master` (rebase, histórico linear). O deploy
   automático GitHub → EasyPanel publica `silmer-api`, `silmer-worker` e
   `silmer-edge-web` (ADR 022). Nada muda no n8n antes disso.
2. **Migration** `0029_store_orders.expand.sql` pelo job `migrate`. É expand:
   a API anterior continua funcionando com ela. Conferir em
   `crm_meta.schema_migrations` que a `0029` entrou.
3. **Variáveis** na `silmer-api`: `STORE_ORDERS_HMAC_KEY`,
   `STORE_ORDERS_ACCEPT_TEST=true` e `APP_BASE_URL`; apagar as quatro removidas
   se alguém as criou. Redeploy do serviço.
4. **Smoke** da seção seguinte, com pedido de teste.
5. **n8n**: no workflow da loja, o nó HTTP que chama o CRM segue o
   [contrato](../integrations/n8n/README.md#pedido-pago-da-loja-adr-028): URL do
   cloud-dev, credencial Basic do CRM, os cinco cabeçalhos e o corpo. Todo não
   `2xx` vira falha visível; `429` e `5xx` repetem a mesma chamada. Testar com
   `teste: true` e o Pix de R$ 1,00 antes de publicar.
6. Quando o Pix real começar: `STORE_ORDERS_ACCEPT_TEST=false` no CRM que
   recebe pedidos reais.

### Aviso de pedido novo do site (ADR 031)

A versão com o aviso lê as colunas novas de `crm.orders`. A ordem é:

1. **Migration** `0034_store_order_first_print.expand.sql` no console da
   `silmer-api` (`node modules/database/src/cli.js --phase=expand`; a imagem
   de produção não inclui `npm`), **antes ou junto** do deploy da imagem
   nova; conferir a `0034` em `crm_meta.schema_migrations`. É expand: a imagem
   anterior continua funcionando com ela. Sem a `0034`, a imagem nova responde
   `503` em todas as leituras de pedido.
2. **Merge** da PR no `master` e deploy automático.
3. **Smoke**: um pedido de teste não aparece no aviso (teste nunca conta); o
   aviso é conferido com o primeiro pedido real (seção seguinte).

Nenhuma variável nova. O contrato com o n8n não muda.

O CSP da rota de impressão (`docker/nginx.conf`) libera, por esta versão, o
hash do estilo novo da `ficha-loja-v1` e também o do anterior
(`sha256-u7y0wEJ…`), porque `edge-web` e `silmer-api` sobem separados. Na
versão seguinte, com as duas imagens novas no ar, remover o hash anterior e
voltar o `test/print-csp.test.js` para seis hashes.

## Smoke depois do deploy

### Correção administrativa de quantidade (ADR 038, T135)

Use somente após confirmação explícita da quantidade com o cliente. Confira
primeiro quantidade, subtotal das peças, frete e total da linha original do
checkout: pagamento maior que o subtotal não comprova mais peças. O comando
não cobra diferença nem altera o frete; confira a entrega separadamente.

1. Acesse o pedido na sessão de um administrador ativo e abra “Correção
   administrativa de quantidade”. Informe a quantidade confirmada. O CRM
   calcula o novo valor das peças pelo catálogo e exige cobertura pelo Pix
   existente. Produtos de kit fixo e pedidos de teste não usam este comando.
2. Registre a correção uma única vez. Em falha de rede, o formulário repete
   a mesma chave e o mesmo corpo. Versão desatualizada exige atualizar a
   página e conferir o pedido antes de outro comando.
3. Confira quantidade, fechamento e totais do Dashboard. Gere novamente a
   ficha: a primeira impressão anterior é preservada como histórico, e um
   PDF já baixado não muda sozinho.
4. Confira `store.order.quantity_corrected` na auditoria e
   `order.store_corrected` no stream, sem dados pessoais. O registro
   original da Data Table e `record_sha256` permanecem como lastro. Não
   reescreva a compra original nem reenvie um corpo diferente pelo n8n. O
   replay original retorna o pedido corrigido e não desfaz a ação humana.

Contrato: `POST /api/v1/orders/{orderId}/store-correction`, sessão humana,
origem válida, CSRF e `Idempotency-Key`; corpo fechado com `expectedVersion`,
`expectedQuantity`, `expectedAmountCents`, `quantity` e
`reason: "USER_CONFIRMED_QUANTITY"`. Somente administrador; autorização
revalidada na transação. Falha de auditoria/evento reverte toda a alteração.
Reversão operacional é outra correção autorizada, com versão atual e outra
chave; nunca restauração do banco ou outro pedido para o mesmo Pix.

Uma chamada sintética de teste (gere um UUID v4 novo; `numero_loja` é `LJ-` e
os 8 primeiros caracteres dele em maiúsculas; `pago_em` é agora, em UTC).
Primeira vez `201`; repetida, `200` com o mesmo `numero`:

```bash
ID=<uuid v4>; LJ="LJ-$(echo "$ID" | cut -c1-8 | tr a-f A-F)"; AGORA=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -si -X POST "https://espectro-mvp-silmer-edge-web.jicnzg.easypanel.host/api/v1/integrations/n8n/store-orders" \
  -u "$CRM_AUTOMATION_CLIENT_ID:$CRM_AUTOMATION_CLIENT_SECRET" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $ID" -H "X-Correlation-Id: $ID" \
  -H "X-Silmer-Workflow-Key: silmer-loja-checkout-infinitepay" -H "X-Silmer-Workflow-Version: smoke" -H "X-Silmer-Execution-Id: smoke-1" \
  --data "{\"schema_version\":\"1.0\",\"pedido_id\":\"$ID\",\"numero_loja\":\"$LJ\",\"teste\":true,\"produto\":{\"slug\":\"camisa-masculina-lisa\"},\"item\":{\"cor_id\":\"preta\",\"tamanho_id\":\"m\",\"quantidade\":10,\"prazo_dias\":10},\"valor_centavos\":100,\"cliente\":{\"nome\":\"Teste Sintetico\",\"telefone\":\"5527900000001\"},\"pagamento\":{\"gateway\":\"infinitepay\",\"forma\":\"pix\",\"transaction_nsu\":\"smoke-$ID\",\"invoice_slug\":\"smoke\",\"valor_pago_centavos\":100,\"pago_em\":\"$AGORA\",\"receipt_url\":null}}"
```

As credenciais vêm do gerenciador de segredos para variáveis do shell; nunca
digitadas na linha nem coladas em chat ou log. Depois:

- sem `-u` a resposta é `401`; com `"forma":"cartao"` e outro UUID, `422
PAYMENT_METHOD_UNSUPPORTED`;
- repetida com outro `pago_em` (um segundo depois), `200` com o mesmo
  `numero`: duas execuções do n8n podem carimbar instantes diferentes, e o
  pedido mantém o primeiro (`LOJ-37`);
- em Pedidos → "Loja do site", o pedido aparece em Confirmados com
  "Loja · LJ-…" e "Teste" e a situação "Confirmado pela loja do site · …"; a
  página mostra "Confirmado", está travada, tem o painel "Fechamento e
  pagamento" com "Pix" e "Baixar ficha" baixa `pedido-NN-CRM.html`;
- abrir o `pedido_url` numa janela anônima leva ao login e, depois dele, ao
  pedido;
- o Dashboard não muda e o aviso não aparece (teste não conta). O pedido de
  teste fica no CRM: não há exclusão.

## Respostas e diagnóstico

| Resposta                                               | O que olhar                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `404`                                                  | Rota desligada (falta `STORE_ORDERS_HMAC_KEY`) ou a API ainda é a versão anterior.                                                                                                                                 |
| `401`                                                  | Credencial do nó errada. A recusa fica auditada sem o segredo.                                                                                                                                                     |
| `400 INVALID_CORRELATION_ID`                           | `X-Correlation-Id` não é UUID: mandar o `pedido_id`.                                                                                                                                                               |
| `400 INVALID_IDEMPOTENCY_KEY`                          | `Idempotency-Key` ausente ou diferente do `pedido_id`.                                                                                                                                                             |
| `400 UNKNOWN_REQUEST_FIELD`, `INVALID_*`               | O nó mudou o corpo. Comparar com o README do n8n e o OpenAPI (`StoreOrderRecord`).                                                                                                                                 |
| `409 STORE_ORDER_CONFLICT`                             | O mesmo `pedido_id` com outros dados (ou outro comprovante), ou um `transaction_nsu` já usado. Só `pago_em` diferente não é conflito (`200`, `LOJ-37`). Ver o pedido existente pelo `LJ-…` antes de qualquer ação. |
| `422 STORE_CATALOG_MISMATCH`                           | Produto, cor, tamanho, quantidade, prazo ou valor diferentes de `modules/orders/src/domain/store-catalog.js`. Alinhar site, n8n e CRM; mudar o CRM primeiro.                                                       |
| `422 AMOUNT_BELOW_PRICE`, `PAYMENT_METHOD_UNSUPPORTED` | O `payment_check` aceitou o que o CRM não aceita: conferir o nó de confirmação.                                                                                                                                    |
| `422 TEST_REFUSED`                                     | `teste: true` num CRM com `STORE_ORDERS_ACCEPT_TEST=false`.                                                                                                                                                        |
| `429 RATE_LIMITED`                                     | Mais de 60 chamadas por minuto; repetir depois do `Retry-After`. Se acontecer sem motivo, procurar um loop no workflow ou credencial vazada.                                                                       |
| `503 SERVICE_UNAVAILABLE`                              | Falha interna; os logs da API trazem só o código, nunca nome, telefone, NSU ou link.                                                                                                                               |

Um `4xx` deixa um Pix pago sem pedido: alguém confere na InfinitePay, corrige
a causa e reenvia a mesma chamada (é idempotente pelo `pedido_id`).

## Conferência

O pagamento já vem confirmado pela InfinitePay: o pedido guarda valor pago,
`transaction_nsu`, `invoice_slug` e, quando houver, o link do comprovante. A
busca da lista acha o pedido por `LJ-…`, número `NN-CRM` ou telefone inteiro.
Frete, retirada ou qualquer ajuste combinado com o cliente no WhatsApp ficam
fora do pedido, que é travado; mudar isso exige decisão nova.

## Pedido novo do site (ADR 031)

Desde a [ADR 037](../adr/037-gerar-pdf-da-ficha-para-uso-mobile.md), o botão
**Gerar PDF** baixa a ficha como arquivo PDF; no celular compatível,
**Compartilhar PDF** abre o menu nativo para escolher o WhatsApp. A primeira
geração bem-sucedida retira o pedido do aviso e registra quem gerou a ficha.
Se o compartilhamento não abrir, use o PDF baixado. Falha na geração não
retira o pedido do aviso. A rota HTML antiga segue disponível para
compatibilidade operacional.

- **O que é**: pedido da loja, que não é teste, cuja ficha ninguém gerou em PDF
  ou abriu pela rota HTML antiga.
  Chega já **Confirmado**, como um pedido depois de "Gerar pedido".
- **Onde aparece**: no topo do Dashboard, "N pedidos novos do site", com o
  mais antigo; o aviso inteiro abre Pedidos já em "Loja do site". O menu
  "Pedidos" mostra o mesmo número. Na lista e na página, o selo "Ficha ainda
  sem PDF".
- **Como sai do aviso**: gerando o PDF pela primeira vez ("Gerar PDF",
  "Compartilhar PDF" ou "Baixar ficha em PDF") ou abrindo a rota HTML antiga.
  O CRM grava quem e quando ("PDF gerado por … · …"), uma vez só; gerar de novo
  não muda nada. Não há botão de desfazer: uma ficha gerada por engano tira o
  pedido do aviso, e o pedido continua na lista.
- **Produção**: a ficha da loja tem uma página — Produzir (produto, cor,
  tamanho, 10 peças, prazo da cor, quando o pedido entrou), Cliente (nome e
  WhatsApp) e Pagamento.
- **Avisar o cliente**: quando o kit fica pronto, alguém da equipe avisa o
  cliente **à mão, pelo WhatsApp** da ficha, e combina retirada (padrão) ou
  frete. Não há mensagem automática; automatizar isso é trabalho futuro.

## Rollback

- Desligar a rota: remover `STORE_ORDERS_HMAC_KEY` e fazer redeploy. A rota
  responde `404`; o workflow da loja precisa tratar isso como falha visível.
- Voltar a imagem da API: as migrations `0029` e `0034` são expand e a versão
  anterior continua lendo os pedidos de atendimento; os pedidos da loja já
  criados ficam no banco e voltam a aparecer completos quando a versão nova
  voltar. Sem a versão nova não há aviso; as impressões já registradas ficam
  guardadas.
- Nunca apagar `crm.store_order_receipts` nem pedidos da loja: são o lastro da
  venda e a chave da idempotência.

## Privacidade

Nome, telefone e link do comprovante ficam só dentro da ficha cifrada do
pedido. O recibo guarda o `pedido_id`, o HMAC do telefone e o hash dos dados
comparados, sem IP nem `Origin`. Nada disso vai para log ou auditoria; a
auditoria registra ator técnico, pedido, versão e correlação. A primeira
impressão audita `order.ficha.first_print` com o id da pessoa, o pedido e a
correlação, sem dado do cliente. A retenção é a do pedido (documento
comercial).
