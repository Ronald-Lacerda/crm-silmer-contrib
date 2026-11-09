# Cobranças — preparação técnica de produção

Escopo COB-OPS-PREP-02 / PPREP-01–04. Conferência em08/11/2026,
America/Sao_Paulo. Nenhum pagamento,
checkout, envio, publicação, deploy, merge ou migração remota executado.

## Estado observado

| Item                | Evidência                                                                         | Resultado                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Edge/API            | GET healthz, api/health/live e api/health/ready                                   | 200; disponibilidade somente                                                                                            |
| API em execução     | Console do serviço, leitura de process.env                                        | ORDER_BILLING_ENABLED, CHAT_SEND_ENABLED e RECEIVE_ENABLED ausentes; defaultfalse; URLs de emissão/conferência ausentes |
| Worker em execução  | Mesmo diagnóstico, sem consultas de domínio                                       | mesmas flags/URLs ausentes; diretório da imagem sem migrações0063/0064/0065                                             |
| Banco               | SELECT version,name,checksum em transação BEGIN READ ONLY, encerrada por ROLLBACK | 0055 aplicada;0063/0064/0065 ausentes; checksum0055 coincide com o repositório                                          |
| Fonte API no painel | GitHub romulosutil/crm-silmer, master, docker/runtime.Dockerfile                  | configuração observada; não equivale a digest ou SHA implantado                                                         |
| Git remoto          | origin/master455f80d7; ancestralidade do commit financeiroc1815a08 recusada       | backend novo ainda não incorporado à master consultada                                                                  |
| Loja                | workflowLu5dpTCA25Fe2Xfh publicado, export privado34nós                           | preservado                                                                                                              |
| Atendimento         | workflowk7tI6T4RhQPyJkn9 publicado, export privado141nós                          | preservado                                                                                                              |

## Candidatos preparados no n8n

- [Cobranças InfinitePay](https://schedule-n8n.jicnzg.easypanel.host/workflow/YI75ZEo33RsVbW4r):19nós, activefalse.
- [Conferir pagamentos](https://schedule-n8n.jicnzg.easypanel.host/workflow/t5wxOAz2c8OUl9Hf):11nós, activefalse.

Configuração pública deriva da URL CRM do fluxo existente e da InfiniteTag
silmer2025 observada na loja. Callback próprio em
`/webhook/silmer/order-billing/paid`, separado de `/loja/infinitepay`.
Não houve requisição à InfinitePay nem registro dos novos webhooks como ativos.

A importação pela UI não preservou automaticamente os settings do JSON.
As quatro opções foram desligadas pela tela e conferidas por nova exportação:
saveDataErrorExecution=none, saveDataSuccessExecution=none,
saveManualExecutions=false, saveExecutionProgress=false. AvailableInMCPfalse.
Timezone usa o padrão observado America/Sao_Paulo.

As credenciais continuam **não homologadas**. A importação associou o webhook
à credencial existente `Silmer CRM para n8n Basic DEV`; o nome não prova que
seja uma conta de produção nem sua autorização financeira. As credenciais
CRM de saída e InfinitePay Checkout API Key não estão vinculadas no export
persistido. Nenhuma credencial foi criada, revelada ou alterada. Validar
identidade, capacidades checkout.read/payment.record e workflowkey
silmer-order-billing na implantação. Não publicar com bindings incompletos.

## Patch offline do transporte

O export real omite parameters.method no preflight de mídia, representando
o defaultGET do nó HTTP Request. O patch passou a aceitar esse formato e
explicita GET na nova guarda. Continua recusando outros métodos, contexto
parcial e drift. Os141nós existentes são preservados; acrescentam-se3nós e
altera-se somente a conexão do ramo de texto humano antes do provedor.

O candidato privado original herda active:true do export. Um envelope
separado `human-preflight-inactive.json` remove metadados de publicação,
pinData/staticData e fixa activefalse. Nenhum dos dois foi importado sobre o
atendimento em produção. Reexportar e reaplicar o patch contra a versão
vigente antes da futura publicação; não sobrescrever alterações posteriores.

## Pendências para a homologação

1. Integrar a feature e construir release compatível, identificando SHA/digest
   e versão recuperável. Master/deploy automático não foram alterados aqui.
2. Conferir backup e aplicar as migrações expand da release, incluindo0063–0065,
   verificando checksums e health. Não copiar SQL isolado para imagem antiga.
3. Vincular credenciais corretas, conferir conta InfinitePay e cadastrar URLs
   de emissão/conferência na API/worker, mantendo ENABLED e CHAT_SEND_ENABLEDfalse.
4. Revisar/publicar os workflows compatíveis e o delta de transporte somente
   após esses gates; receber callbacks exige runtime compatível e RECEIVE_ENABLED.
5. Avisar o proprietário antes de qualquer teste com cobrança, pagamento ou
   mensagem reais e obter autorização específica para o ensaio.

COB-OPS-01 permanece aberta. Não foi comprovada conectividade autenticada
n8n→novo contrato CRM ou InfinitePay: o backend novo ainda não está implantado
e os bindings não estão prontos. Nenhum ACK ou sucesso financeiro foi inferido.

## Evidência local privada

`var/billing-production-preparation/` contém backups da loja/atendimento,
candidatos, exports persistidos, health e capturas dos consoles. O diretório
é ignorado pelo Git; exports remotos nunca devem ser commitados. O relatório
`persisted-review.json` comprova inatividade e settings dos dois candidatos.
Captura `production-drafts.jpg` mostra os candidatos na instância remota.

Regressão do patch6/6 sem skips, typecheck global, lint e Prettier aprovados.
Referências: [runbook](../runbooks/order-billing.md),
[spec](../../.specs/features/order-billing-production-preparation/spec.md),
[default GET oficial do n8n](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/HttpRequest/V3/Description.ts),
[contrato InfinitePay](https://www.infinitepay.io/checkout-documentacao).
