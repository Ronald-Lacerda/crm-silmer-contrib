# Cobranças InfinitePay — operação e recuperação

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

O runtime atual usa compartilhamento manual. O novo comando **Gerar e enviar
cobrança** solicitado após a revisão da jornada está proposto na
[RFC 047](../rfc/047-enviar-cobranca-pela-conversa.md), com protótipo em
avaliação; ainda não foi integrado ao envio real da Inbox.

Links em revisão, de pedido reaberto, vencidos ou com leitura desatualizada
não são oferecidos para compartilhamento normal. O acesso ao link anterior
fica explicitamente na conferência; isso não cancela o link no gateway.

A conta da loja é reaproveitada, mas o workflow e os IDs das cobranças do CRM
são próprios. Não apontar essa rotina para `store-orders`, reutilizar a Data
Table da loja ou publicar mudanças no workflow de atendimento.

## Configuração

| Processo | Variável                                                   | Uso                                                                            |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| API      | `ORDER_BILLING_ENABLED=true`                               | Configuração e novas emissões; implica receber callbacks.                      |
| API      | `ORDER_BILLING_RECEIVE_ENABLED=true`                       | Mantém leitura, callbacks e conciliação quando emissão está desligada.         |
| Worker   | `ORDER_BILLING_ENABLED=true`                               | Inicia consumidor da fila `billing`.                                           |
| Worker   | `ORDER_BILLING_N8N_URL`                                    | URL HTTPS privada do webhook de emissão do workflow dedicado.                  |
| API      | `N8N_INTEGRATION_ENVELOPE_KEY`, `IDEMPOTENCY_ENVELOPE_KEY` | Chaves existentes, válidas, de 32 bytes em base64. Nunca versionar.            |
| API      | `CRM_AUTOMATION_CLIENT_ID/SECRET`                          | Credencial Basic existente do n8n → CRM, com capacidades técnicas específicas. |
| Worker   | `N8N_COMMAND_CLIENT_ID/SECRET`                             | Credencial Basic existente do CRM → n8n.                                       |

Sem flags, as rotas e a seção ficam desabilitadas. Não habilitar emissão
sem ter configurado e conferido o workflow/conta. Em desenvolvimento somente,
o worker admite HTTP de loopback quando `N8N_COMMAND_ALLOW_INSECURE_LOCAL=true`.
Produção exige HTTPS e não segue redirects no transporte financeiro.

## Workflow n8n — preparar antes de ativar

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
2. Aplicar migração expand `0055_order_billing` no ambiente alvo **antes de
   habilitar flags**; conferir checksum e readiness. Não editar migrações
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
importação/execução no n8n real. Registros de gates e pendências ficam em
[tasks](../../.specs/features/order-billing/tasks.md).
