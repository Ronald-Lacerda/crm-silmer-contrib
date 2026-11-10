# Desenvolvimento interativo de cobranças

Escopo: [BDEV2-01–04](../../.specs/features/order-billing-completion/spec.md),
ADR077/RFC060. Ambiente sintético da jornada real, separado de produção e dos
containers de desenvolvimento existentes. Não usar dados ou credenciais reais.

## Operação

Requer Docker Desktop, dependências instaladas e Node/npm fixados pelo projeto.

```powershell
npm run dev:billing
npm run dev:billing:status
npm run dev:billing:stop
```

CRM: `http://127.0.0.1:4180`. Editor n8n DEV:
`http://127.0.0.1:5685`. Controles sintéticos:
`http://127.0.0.1:4180/__billing-development`.

Contas exclusivas de desenvolvimento seguem o seed existente:
`admin@crm-silmer.local` e `vendedor@crm-silmer.local`, senha sintética
`Desenvolvimento!2026`. Esses valores não são credenciais operacionais.
O login é da API real; o transporte e a InfinitePay são simulados.

`stop` encerra a composição própria, preservando os dados DEV. Para apagar
somente os dados sintéticos desse projeto, usar explicitamente:

```powershell
npm run dev:billing:reset -- --confirm-synthetic-reset
```

O projeto Docker é `crm-silmer-billing-dev`. Nunca executar prune global,
apagar volumes por filtro genérico ou aplicar esse comando a outro projeto.
Não copiar banco DEV para produção. O status deve comprovar serviços e
endereços antes de declarar que a UI está disponível.

## Isolamento e fronteiras

API/worker, PostgreSQL, n8n e simuladores usam recursos próprios. A rede
financeira é interna; ingresso local controlado expõe a UI e o editor em
loopback, com destinos internos fixos. Nenhuma credencial de produção ou
mensagem/checkout real é necessária. URLs de checkout/comprovante sintéticas
mantêm formato aceito pelo domínio e não devem ser abertas no provedor.

O workflow financeiro cria links fictícios; o de conferência consulta
candidatos conhecidos; o transporte humano DEV percorre reserva, preflight,
sink local e callbacks. Sink não representa WhatsApp. Não confundir gravar
uma mensagem na outbox com executar o transporte, nem HTTP202 com pagamento.

O script financeiro de ensaio continua disponível separadamente:

```powershell
$env:RUN_BILLING_LOCAL_SMOKE = 'yes'
node scripts/billing-development-smoke.mjs
```

Esse runner sobe e descarta containers próprios. O ambiente interativo existe
para navegar e testar manualmente; o ensaio produz asserts e relatório
reproduzíveis. O sucesso de um não é inferido do outro.

## Roteiro da jornada

1. Entrar como vendedor sintético, abrir conversa/pedido de demonstração e
   revisar pedido, destinatário e valor antes de gerar/enviar cobrança.
2. Simular pagamento parcial na InfinitePay local; conferir recebido/saldo
   iguais no chat e no pedido e separar entrega da mensagem de pagamento.
3. Registrar recebimento externo do saldo, com data efetiva e método; conferir
   quitação e histórico de ambas as fontes. Reverter o registro apenas para
   corrigir o lançamento, sem simular devolução de dinheiro.
4. Recuperar candidato de pagamento por Conferir pagamento, incluindo não
   pago, reentrega, falha e idempotência. Ausência de identificadores exige
   conferência no provedor, não crédito manual como se fosse externo.
5. Conferir link antigo após pagamento/correção, bloqueios e resultado incerto.
   O registro externo não cancela o link InfinitePay anterior.

Evidências e limitações de cada gate ficam em
[tasks](../../.specs/features/order-billing-completion/tasks.md) e no relatório
de validação da entrega. Pagamento e WhatsApp reais, migração remota, segredo,
imagem de produção e rollback operacional continuam em COB-OPS-01.
