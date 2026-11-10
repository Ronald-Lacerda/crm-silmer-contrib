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

## Atualização de credenciais em09/11/2026 — COB-OPS-PREP-03

Após autorização explícita do proprietário para reutilizar as Basic, os dois
rascunhos foram atualizados pela interface do n8n. O estado anterior descrito
acima permanece como histórico da preparação de08/11.

- Cada workflow conserva um gatilho Basic com `Silmer CRM para n8n Basic DEV`.
- As quatro chamadas CRM de cada workflow usam agora `Silmer n8n para CRM Basic DEV`, a mesma identidade já referenciada na loja e no atendimento.
- O campo User da primeira corresponde a N8N_COMMAND_CLIENT_ID do worker; o da segunda corresponde a CRM_AUTOMATION_CLIENT_ID da API. Somente identificadores foram comparados; senhas não foram reveladas, alteradas ou comparadas.
- Novas exportações comprovaram activefalse, quatro bindings de saída e um de entrada por workflow, parâmetros/conexões/settings iguais aos anteriores. Retenção de execuções permanece desligada.

O sufixo DEV é o nome existente, não uma classificação verificada de ambiente.
O vínculo foi conferido; autenticação ponta a ponta dos novos endpoints
financeiros permanece pendente da implantação compatível. Não houve Publish,
Execute, nova cobrança, mensagem, pagamento, troca de segredo ou mudança de flags.

Provas privadas: `basic-reuse-review.json`, `order-billing-basic-reused.json`,
`payment-check-basic-reused.json` e `basic-reuse.jpg` no mesmo diretório ignorado.
O comparador assertou ambos workflows e todas as dez referências Basic,
preservando os exports anteriores. Esta atualização não altera código runtime.

A API Key InfinitePay continua pendente. Conforme a documentação oficial
consultada em09/11, é criada na Conta Web ou App, em Configurações do Checkout,
após ativar Checkout Integrado. Começa com inchk_ e aparece uma vez. Deve ser
cadastrada diretamente em uma credencial Header Auth no n8n, com Name
X-Api-Key e nome descritivo InfinitePay Checkout API Key, na mesma conta da
InfiniteTag. Não colocar chave no chat, código ou JSON do workflow.

Handle continua suficiente para criar link básico. Nesta feature as options
single_payment e valid_until exigem API Key; sem ela não há evidência das
garantias de uso único e vencimento do provedor. Slug de fatura é outro
identificador, usado na conferência de pagamento, não uma credencial.

## Implantação e vínculo da chave em09/11/2026 — BREL-04/05, T4

Esta atualização sucede as pendências históricas acima. O proprietário
preencheu e salvou pessoalmente a credencial `InfinitePay Checkout API Key`
no n8n, Header Auth com nome `X-Api-Key`. O valor não foi lido pelo agente,
copiado para o chat ou incluído nos exports. A vinculação usou somente a
referência da credencial existente, sem nova entrada ou rotação de segredo.

Os dois nós InfinitePay do workflow de emissão/aviso e o nó do workflow de
conferência agora referenciam essa credencial. Cada workflow mantém uma Basic
de entrada e quatro de saída, reaproveitadas conforme a autorização anterior.
O sufixo DEV dos nomes existentes não foi alterado nem usado como evidência
de homologação financeira.

Novas exportações ao final da implantação confirmaram:

| Workflow | Nós | Estado | Basic | Header Auth InfinitePay |
| --- | --- | --- | --- | --- |
| Cobranças InfinitePay, YI75ZEo33RsVbW4r |19| activefalse |5|2|
| Conferir pagamentos, t5wxOAz2c8OUl9Hf |11| activefalse |5|1|

Nós, parâmetros, conexões e settings coincidem com os candidatos privados
conferidos após o vínculo. Mantidas saveDataErrorExecution=none,
saveDataSuccessExecution=none, saveManualExecutions=false,
saveExecutionProgress=false e availableInMCPfalse. Não houve Publish ou Execute
dos workflows financeiros, chamada à InfinitePay, checkout ou pagamento real.

O atendimento conserva a versão **publicada** original
`7b78d0b9-80e0-41b5-a5ae-e4ff52cd96b3`, de06/11 às16:27:52. Foi conferida
clicando a versão Published no histórico; a URL apontou esse mesmo UUID do
export anterior. A tentativa de importar o guard pelo editor acrescentou
nós e depois recriou IDs; as alterações foram revertidas pelo histórico.
O export do rascunho final tem exatamente os141nós, conexões e settings do
original. Nenhuma versão alterada do atendimento foi publicada. O delta
offline de três nós ainda precisa ser aplicado/revisado antes de habilitar
envio de cobranças. A loja não foi alterada.

API/worker/edge foram implantados na release87cbc435, com migrações
0073–0075, três flagsfalse nos processos e saúde conferida. O relatório de
[implantação](order-billing-release-2026-11-09.md) registra os detalhes; as
numerações0063–0065 acima descrevem o estado anterior ao rebase e não foram
usadas na implantação atual.

Provas privadas em `var/billing-production-preparation/`:
`order-billing-release-final.json`, `payment-check-release-final.json`,
`release-final-review.json`, `human-final-restored.json` e
`human-restoration-review.json`. Capturas em `var/billing-release-key-bound.jpg`
e `var/billing-release-human-published-preserved.jpg` não contêm o valor da chave.

**Pendente para ativar/homologar:** aplicar o guard humano, revisar/publicar
os workflows compatíveis, coordenar flags e conferir autenticação/conta de
ponta a ponta. O proprietário deve ser avisado antes de qualquer teste com
checkout, pagamento ou mensagem reais e autorizar especificamente o ensaio.
A implantação desligada não encerra COB-OPS-01 nem comprova a validade da
API Key no provedor.

Atualização posterior em09/11, às23:06: proteção humana publicada na versão
9157724a, com141nós originais exatos e três novos. Comparação independente
pós-publicação aprovada. A pendência de aplicar essa guarda descrita acima
foi concluída; permanecem publicação dos workflows financeiros, ativação
coordenada e homologação autorizada. Ver [evidência](order-billing-human-guard-2026-11-09.md)
e [roteiro preparado](../runbooks/order-billing-activation.md). As três flags
continuamfalse, os dois workflows financeiros inativos e nenhum teste real
foi executado.
