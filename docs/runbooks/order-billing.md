# Cobranças InfinitePay — operação e recuperação

Preparação técnica de produção em08/11/2026:
[diagnóstico, candidatos inativos e pendências de implantação](../qa/order-billing-production-preparation-2026-11-08.md).
API/worker permanecem com emissão/envio desligados. A preparação não conclui
COB-OPS-01 nem autoriza teste financeiro real.

## Continuação de 08/11/2026

Recebimentos externos, conferência de pagamento e interface real no redesign
foram autorizados na [ADR067](../adr/067-recebimentos-externos-e-conciliacao-de-cobrancas.md).
Contrato em [pagamentos](../api/order-billing-payments.md); ambiente local em
[DEV interativo](billing-development.md); requisitos e evidências em
[order-billing-completion](../../.specs/features/order-billing-completion/spec.md).
As seções históricas abaixo descrevem as entregas anteriores. Nenhuma delas
nem a nova implementação habilitam produção ou transações reais.

## Backend do envio integrado, B01–B05 (06/11/2026)

Migração expand `0063_order_billing_send_intents` cria intenções, snapshots
de autorização/acordo e eventos append-only. A migração expand 0064 acompanha
o estado real do transporte. API e worker integram as filas existentes com
mensagem, comando, auditoria e invalidação da Inbox na mesma transação.
Não alterar migrações anteriores; aplicar todas as migrações da versão antes
de futura ativação, incluindo as entregas da master incorporadas em 08/11/2026.

O backend foi validado com PostgreSQL e dados sintéticos; emissão e envio real
continuam desligados. Não configurar `ORDER_BILLING_CHAT_SEND_ENABLED=true`
no ambiente remoto antes da homologação. A interface integrada ainda depende
do protótipo/design; contrato e implementação estão na
[ADR 066](../adr/066-intencoes-de-cobranca-e-envio-transacional.md) e na
[API de intenções](../api/order-billing-chat.md).

`waiting_link` aguarda a composição; link existente válido/retry seguro podem
compor imediatamente. Emissão cria o job financeiro na mesma transação;
link existente/retry não criam outro job de checkout. O n8n financeiro não
envia mensagens: a entrega usa a reserva humana e o preflight da Inbox.

Rollback é por flag, preservando tabelas/URLs/recebimentos. Aplique a orientação
financeira ao final deste runbook e mantenha recebimento/reconciliação dos
links existentes. Não usar DROP ou apagar intenções/eventos para desfazer
uma operação comercial. Banco local sintético não comprova deploy ou recovery
remotos. Evidências de B02 no relatório de QA da entrega.

[ADR 058](../adr/058-cobrancas-do-pedido-com-infinitepay.md),
[RFC 049](../rfc/049-cobrancas-do-pedido-com-infinitepay.md),
[COB-01–16](../../.specs/features/order-billing/spec.md) e
[COB-DEL-01/COB-OPS-01](../../.specs/features/order-billing/tasks.md).
Contrato HTTP: [OpenAPI das cobranças](../api/order-billing.v1.json).

## Fluxo e limites

Responsável/admin abre pedido confirmado, escolhe 0%, X% ou 100%, revisa
valor e gera link. 0% salva sem emitir; X% permite sinal e depois saldo;
100% cobra integral. O cliente escolhe Pix/cartão e parcelas na InfinitePay.
Compartilhamento é humano. “Pago parcialmente” não muda o status comercial
nem qualifica quitação do Financeiro. A interface real não tem simulação.

A interface existente usa compartilhamento manual. O backend do comando
**Gerar e enviar cobrança**, definido na
[RFC 047](../rfc/047-enviar-cobranca-pela-conversa.md), está integrado com
flags desligadas. Protótipo atualizado da entrada pelo chat precede a
implementação da interface e não habilita envio real.

Links em revisão, de pedido reaberto, vencidos ou com leitura desatualizada
não são oferecidos para compartilhamento normal. O acesso ao link anterior
fica explicitamente na conferência; isso não cancela o link no gateway.

A conta da loja é reaproveitada, mas o workflow e os IDs das cobranças do CRM
são próprios. Não apontar essa rotina para `store-orders`, reutilizar a Data
Table da loja ou publicar mudanças no workflow de atendimento.

## Configuração

| Processo   | Variável                                                   | Uso                                                                                                                     |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| API        | `ORDER_BILLING_ENABLED=true`                               | Configuração e novas emissões; implica receber callbacks.                                                               |
| API        | `ORDER_BILLING_RECEIVE_ENABLED=true`                       | Mantém leitura, callbacks e conciliação quando emissão está desligada.                                                  |
| Worker     | `ORDER_BILLING_ENABLED=true`                               | Inicia consumidor da fila `billing`.                                                                                    |
| Worker     | `ORDER_BILLING_N8N_URL`                                    | URL HTTPS privada do webhook de emissão do workflow dedicado.                                                           |
| API/Worker | `ORDER_BILLING_CHECK_N8N_URL`                              | URL privada da conferência; publicar o workflow dedicado e configurar nas duas aplicações antes de oferecer a consulta. |
| API        | `N8N_INTEGRATION_ENVELOPE_KEY`, `IDEMPOTENCY_ENVELOPE_KEY` | Chaves existentes, válidas, de 32 bytes em base64. Nunca versionar.                                                     |
| API        | `CRM_AUTOMATION_CLIENT_ID/SECRET`                          | Credencial Basic existente do n8n → CRM, com capacidades técnicas específicas.                                          |
| Worker     | `N8N_COMMAND_CLIENT_ID/SECRET`                             | Credencial Basic existente do CRM → n8n.                                                                                |

Sem flags, as rotas e a seção ficam desabilitadas. Não habilitar emissão
sem ter configurado e conferido o workflow/conta. Em desenvolvimento somente,
o worker admite HTTP de loopback quando `N8N_COMMAND_ALLOW_INSECURE_LOCAL=true`.
Produção exige HTTPS e não segue redirects no transporte financeiro.

## Workflow n8n — preparar antes de ativar

### Desenvolvimento isolado antes da produção

O perfil de desenvolvimento usa o mesmo gerador/grafo financeiro com caminhos
`silmer/order-billing-dev/create` e `silmer/order-billing-dev/paid`, credenciais
sintéticas e destinos HTTP locais validados. Gerar export inativo:

```powershell
node ops/n8n/workflows/create-order-billing-dev-workflow.mjs var/billing-dev-workflow.json
```

O comando recusa sobrescrever o destino. Não importar esse arquivo no n8n de
produção nem vincular credenciais reais. A exportação de produção abaixo
continua independente e inativa por padrão. A configuração DEV não aceita
domínio remoto, InfiniteTag real, expressão ou credencial embutida.

O ensaio completo da fronteira financeira roda em containers exclusivos:

```powershell
$env:RUN_BILLING_LOCAL_SMOKE = 'yes'
node scripts/billing-development-smoke.mjs
```

Requer Docker local, dependências do projeto e a versão Node fixada em
`.node-version`. Usa n8n 2.38.7, runtime/rotas/worker financeiros reais e
PostgreSQL 17 dedicado. A rede Docker é interna, sem saída externa; nenhuma
porta é publicada. O runner controla HTTP por `docker exec` dentro da rede
isolada e cria seus próprios recursos. Não reaproveita nem reseta o banco DEV
persistente ou containers existentes.
O estado do n8n é descartável e separado do n8n de atendimento.

O simulador HTTP verifica os pedidos de `/links` e `/payment_check`; o
pagamento só muda quando o roteiro de teste o confirma. As URLs devolvidas
são fixtures no formato HTTPS aceito pelo domínio financeiro, não checkouts
locais nem links para abrir. Nenhuma chamada InfinitePay ou WhatsApp real
pertence a esse roteiro. Relatórios sintéticos ficam em
`var/billing-development-*/report.json`; verificar o veredito e os cenários,
não apenas a subida dos containers. Recursos Docker próprios são removidos
ao final, inclusive em falha; os artefatos de diagnóstico locais permanecem.

O ensaio não é um servidor DEV permanente nem prova de login/sessão ou UI.
O adaptador de sessão humana é sintético; autenticação técnica, rotas,
reserva, persistência e worker financeiro usam a implementação do projeto.
Mensagem na outbox comprova composição, não execução do transporte. O ensaio
do workflow humano/preflight/envio simulado, a matriz completa de correção e
a interface pós-redesign continuam no plano da RFC 047. Homologação real
segue COB-OPS-01. Não habilitar flags remotas por ter aprovado o simulador.

### Exportação para o candidato de produção

Gerador reproduzível, sem segredos, produz um export **inativo**:

```powershell
node ops/n8n/workflows/create-order-billing-workflow.mjs <destino-privado.json> [config-publica.json]
```

Configuração opcional contém somente `crmBaseUrl`, `handle` e `webhookUrl`.
Sem ela, preencher os dois nós “Configurar…” após importar. Esses campos
ficam em Edit Fields/Set, sem depender de custom variables de plano pago.
`crmBaseUrl` é a base HTTPS do CRM, sem `/api/v1`; `handle` é a InfiniteTag
da conta conferida; `webhookUrl` é o endereço publicado do webhook de aviso
`silmer/order-billing/paid`. Não usar endereços `webhook-test`.

Vincular pelas credenciais privadas do n8n:

- `Silmer CRM para n8n Basic`: credencial recebida pelo webhook de emissão,
  igual à usada pelo worker.
- `Silmer n8n para CRM Basic`: credencial do ator técnico da API.
- `InfinitePay Checkout API Key`: Header Auth com nome `X-Api-Key`. Cadastrar
  pela interface privada; nunca copiar para export, config pública ou chat.

Conferir ambos os nós de configuração e todos os vínculos de credencial.
Export mantém execuções sem payload salvo em sucesso/erro/manual. Confirmar
também política global de logging/retenção do n8n; não registrar corpos,
links, cabeçalhos de autenticação ou respostas completas do provedor.

O webhook privado `silmer/order-billing/create` recebe somente
`{schema_version:"1.0",charge_id:"<UUID da cobrança>"}`. A reserva na API
devolve `allowed:true` uma vez por cobrança. Só essa execução cria `/links`,
sem retry; a configuração fixa `single_payment` e validade de 24h. Não
confundir HTTP recebido pelo n8n com link salvo no CRM.

O webhook de aviso é público: seus identificadores são candidatos, não
prova. O workflow consulta a cobrança conhecida na API, chama `payment_check`
com a conta configurada, confere principal/meio/parcelas e persiste callback
autenticado antes do ACK. Falha não deve virar resposta 200 de sucesso.

Referências oficiais: [InfinitePay](https://www.infinitepay.io/checkout-documentacao)
e [limites do n8n Community](https://docs.n8n.io/deploy/host-n8n/community-edition-features/).

## Publicação ordenada

O registro global de transações normaliza caixa somente para NSUs no formato
UUID canônico; identificadores opacos preservam caixa. A migração falha se o
histórico já contiver o mesmo UUID em caixas diferentes: conferir a origem e
resolver a duplicidade antes de prosseguir, sem descartar recebimentos.

1. Gates locais/CI, revisão e commit da entrega. Confirmar imagem/digest da
   versão aprovada; o push de branch por si só não comprova publicação.
2. Aplicar as migrações da versão, incluindo expand `0055_order_billing`,
   `0063_order_billing_send_intents`, `0064_billing_send_transport` e
   `0065_billing_external_receipts_and_checks`, no ambiente
   alvo **antes de habilitar flags**; conferir checksum e readiness. Não editar migrações
   anteriores nem copiar um banco sintético para o remoto.
3. Publicar API/worker/edge da mesma entrega, inicialmente sem emissão.
4. Importar o workflow dedicado, preencher configuração não secreta,
   vincular credenciais e conferir a conta da loja. Preservar checkout e
   atendimento existentes. Só então publicar o workflow.
5. Configurar recebimento na API, URL do worker e emissão em ambos; conferir
   health e a seção Cobranças no pedido autorizado.
6. Homologar pagamento real de baixo valor previamente autorizado; testar
   reentrega, cartão/parcelas quando aplicável, saldo, conciliação e retorno.
   Não cobrar cliente real nem executar transação de teste sem autorização.

## Conferência e recuperação

`queued` aguarda o worker; `creating` tem reserva consumida; `waiting` tem
link salvo e aguarda pagamento. `unknown` pode existir depois de timeout ou
reserva parada: **não recriar outro link**. Conferir o pedido/cobrança e o
painel da InfinitePay. Callbacks tardios podem completar o resultado.

Reabertura/mudança de preço ou condição invalida aplicação ao acordo atual,
preservando pagamentos. Em Conferir cobrança, `apply_current` exige declarar
a conferência no provedor e reaplica recebimentos existentes ao acordo
vigente; não recebe dinheiro nem inventa nova transação. Cobertura insuficiente
continua com saldo; acima do devido exige revisão/devolução.

`close_unpaid` exige validade vencida, ausência de pagamento e conferência
explícita no painel. Não cancela o link no gateway nem ignora callback tardio:
um recebimento posterior fica em revisão. Não usar encerramento da conversa
ou troca de vendedor como descarte de cobrança.

Registrar devolução só depois de fazê-la/conferi-la na InfinitePay. Informar
valor devolvido no comando da cobrança, com idempotência e versões; isso
reduz o crédito aplicado, preserva o original e invalida quitação/check quando
necessário. Resultado HTTP incerto deve repetir a mesma intenção/chave,
sem abrir outra devolução enquanto a primeira não for resolvida.

“Pago em” é derivado do livro de recebimentos nos pedidos geridos. Uma data
manual antiga não prova valor recebido; conferir e corrigir o lastro antes
da primeira emissão. Não contornar a API com SQL de ajuste em produção.

## Rollback

### Envio integrado pela conversa (COB-CHAT-B03/B04)

Aplicar as migrações expand 0063, 0064 e 0065 antes da imagem compatível; conferir
checksums. `ORDER_BILLING_CHAT_SEND_ENABLED` permanece ausente/false por
padrão na API e no worker e exige também `ORDER_BILLING_ENABLED=true`.
Configuração true sem banco, autorização ou outbox funcional impede startup
da API. A chave `INBOX_MESSAGE_ENVELOPE_KEY` cifra a mensagem; as chaves
financeira e da identidade mantêm seus contextos separados.

Antes de futura ativação, preparar uma cópia da exportação privada do
workflow humano existente, preservando credenciais e IDs:

```powershell
node ops/n8n/billing-send-preflight.mjs <export-privado.json> <review-novo.json>
```

O patch local é idempotente, recusa drift/contexto parcial e não sobrescreve
arquivos nem publica o workflow. O gerador Evolution histórico permanece
intacto; aplique o patch explicitamente sobre o candidato inativo ou sobre
uma exportação privada conferida. Conferir Basic técnico, os headers de execução e o nó
preflight imediatamente anterior ao envio de texto humano marcado
`billing_send:true`. Só `{valid:true}` permite envio. O fluxo financeiro
continua criando links e recebendo callbacks, sem enviar WhatsApp diretamente.

O desligamento da flag na API e no worker impede novas intenções/reservas e
bloqueia mensagens ainda elegíveis, preservando link, histórico e recebimentos.
Envio comum da Inbox permanece independente. Consulta e recebimento exigem
`ORDER_BILLING_ENABLED=true` ou `ORDER_BILLING_RECEIVE_ENABLED=true` na API.
Não apagar migrações/envelopes durante rollback. Intenções bloqueadas não
voltam automaticamente à fila ao religar a flag.

`waiting_link`/`queued` podem ser bloqueadas por pagamento/contexto alterado.
`sending` precisa de preflight vigente; uma mudança depois do preflight não
prova que o HTTP externo foi interrompido. Aguardar confirmação ou registrar
incerteza. `unknown` exige conferência e não admite retry. `failed` só permite
nova intenção humana quando há prova de falha anterior ao envio e link válido;
falha de entrega com ID externo não satisfaz essa condição. Callback tardio
da execução original pode completar o resultado sem duplicar o recebimento.

Nenhuma publicação remota, flag real ou transação financeira foi executada
por esta entrega. Frontend integrado ao redesign na continuação de 08/11/2026;
homologação segue COB-OPS-01.

### Emissão financeira

Desligar `ORDER_BILLING_ENABLED` na API e no worker; manter
`ORDER_BILLING_RECEIVE_ENABLED=true` na API e o workflow de callbacks ativo.
Não excluir tabelas, chaves, credenciais, URLs ou histórico enquanto houver
links/pagamentos em circulação. A seção conserva consulta e conciliação.
Reverter para imagem anterior sem suporte a callbacks requer manter uma
instância compatível até concluir todos os recebimentos pendentes.

## Evidência

Os testes de domínio/rotas, PostgreSQL real sintético, worker/workflow e
E2E/axe distinguem implementação local de estado operacional. A fixture
executa código e expressões do export com respostas sintéticas; não comprova
importação/execução no n8n real. O runner de desenvolvimento acrescenta essa
prova local: importa/publica exclusivamente no container efêmero e percorre
o motor n8n por HTTP, com simulador e PostgreSQL dedicados. Isso não comprova
transporte WhatsApp, login/UI ou operação remota. Registros de gates e pendências ficam em
[tasks](../../.specs/features/order-billing/tasks.md).
