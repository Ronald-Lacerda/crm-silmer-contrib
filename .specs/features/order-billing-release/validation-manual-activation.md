# Validação independente da ativação para teste manual posterior

**Verdict: PASS — somente T9/BREL-10, ativação autorizada; sem homologação financeira.**

Revisor: `billing_release_verifier`, independente do autor das operações.
Data:10/11/2026. Base documental `d8200857ef98d155b907b11cb43b7f7479703654`
e alterações locais de spec/tasks/runbook apresentadas para T9. O proprietário
autorizou ligar todas as funções para testar pessoalmente depois; essa
autorização de flags não autoriza o agente a criar checkout, pagamento ou
mensagem de teste. Distinção expressa em
`.specs/features/order-billing-release/spec.md:18` e `:25` (BREL-04/10) e em
`docs/runbooks/order-billing-activation.md:4`–`:9`, `:80`–`:83`.

## Critérios e evidências

As seis capturas JPG existentes em `var/billing-manual-activation/` foram
abertas pelo revisor com view_image. A solicitação mencionava oito capturas;
há seis arquivos, que cobrem os oito resultados abaixo. Não foram inventadas
capturas adicionais nem executado comando no ambiente remoto.

| Resultado exigido | Evidência inspecionada e vínculo com a fonte | Avaliação |
| --- | --- | --- |
| 1. Configuração anterior compatível, sem probe financeiro | `worker-before-config.jpg`: flagsfalse/true/false antes da mudança, FINANCIAL_CLIENTS_INIT ok; no transport invoked. `api-before-config.jpg`: três verificações de envelope true e API_N8N_INTEGRATION_ENABLED true. `apps/api/src/server.js:354`–`:364` exige banco, autorização e outbox para send. `apps/worker/src/worker.js:546`–`:562` cria cliente de entrega com Basic/URL; `modules/n8n-integration/src/postgres-command-store.js:239`–`:248` usa a chave N8N e flags financeiras. As duas chaves específicas da API ausentes no worker e N8N_INTEGRATION_ENABLED=false no worker não são requisitos dessa composição; não foram copiadas desnecessariamente. | PASS de configuração/inicialização |
| 2. Backlog financeiro vazio antes da ativação | `database-before.jpg` e parte superior de `worker-before-config.jpg`: charges/payments/refunds/send_intents/external_receipts/payment_checks=0; BILLING_QUEUE[]. Migrações71/71, última0075, mismatches[]. Heartbeat anterior9s, global. Inventariar backlog antecede ligar consumidor, conforme `docs/runbooks/order-billing-activation.md:62`–`:63`. | PASS para snapshot anterior |
| 3. Worker efetivo com três flags true | `worker-all-enabled.jpg`: container `r60d7vmshnrux2e9lzdaipvfp`, PID9, roleworker, enabled=true, receive=true, send=true, checkUrlMatches=true; scanner running=true. `apps/worker/src/worker.js:589`–`:615` seleciona emissão quando ENABLED=true; `:836`–`:847` compõe consumidor. `modules/n8n-integration/src/postgres-command-store.js:246` exige ENABLED e CHAT_SEND para entrega financeira. | PASS para processo observado |
| 4. API efetiva com três flags true | `api-all-enabled-health.jpg`: container `u2ex6472of57elrzwdar6s9v4`, PID6, roleapi, enabled=true, receive=true, send=true, checkUrlMatches=true. `apps/api/src/order-billing-chat-runtime.js:70`–`:74` deriva emissão/envio/recebimento; `apps/api/src/server.js:354` mantém os requisitos de startup. | PASS para processo observado |
| 5. Saúde depois da troca | `api-all-enabled-health.jpg`: live200, ready200 e edge health200. `worker-all-enabled.jpg`: scanner presente; `database-after.jpg`: heartbeat5s. Esse heartbeat é global, não dedicado ao consumidor billing. Health e processo vivo não são prova de pagamento nem autenticação externa. | PASS limitado |
| 6. Fontes críticas preservadas | Capturas finais API/worker mostram PATCH_SOURCE files=4,matches=true,mismatches[]. Os quatro arquivos são server.js, worker.js e os dois clientes financeiros usados na prova anterior. Revisor confirmou `git diff --exit-code 631909ea..d8200857` sem diferenças nesses arquivos, nos runtimes billing, billing-send-guard e command-store. Há outras mudanças de produto na master; não se afirma igualdade de todo o repositório ou de toda a imagem. | PASS para fontes billing relevantes |
| 7. Workflows e guard humano preservados | Revisor comparou diretamente human/issue/check.json com os baselines de `var/billing-receive-completion/`: active=true,144/19/11 nós e `deepEqual` de id/versionId/nodes/connections/settings; todos passaram. Referências de credencial conservam somente id/name. `workflow-review.json:5`, `:13`, `:21` registra active=true; `:8`, `:16`, `:24` registra exact=true. Versões9157724a/71a6a9d3/d774f29e mantidas. `modules/n8n-integration/src/billing-send-guard.js:113`–`:187` preserva guardas de flag, ator, dono, conversa e acordo; `apps/api/src/order-billing-chat-runtime.js:253`, `:704`, `:743` conserva autorização, replay e elegibilidade. | PASS estrutural |
| 8. Ausência de registros/efeitos financeiros na conferência posterior | `database-after.jpg`: mesmas71 migrations, última0075, mismatches[]; seis contagens financeiras0 e BILLING_QUEUE[]. Sem migração, rotação de credencial, checkout, consulta ao provedor, pagamento, callback fabricado ou mensagem executados como teste pelo revisor. A ausência de registros corrobora o relato operacional do autor, mas não é auditoria universal de serviços externos. | PASS para estado observado |

O autor informou alteração remota somente de ENABLED/CHAT_SEND false→true
na API/worker, preservando RECEIVEtrue, com worker antes da API. A sequência
é compatível com `docs/runbooks/order-billing-activation.md:82`–`:83`; as
capturas demonstram estados anteriores/finais, não uma linha do tempo
independente de todas as ações no painel.

## Gates aplicáveis e limites

Não há código novo de billing em T9. Os gates e sensores anteriores continuam
aplicáveis às fontes preservadas: T8 executou independentemente28 focais,
typecheck e nove mutações comportamentais detectadas, incluindo mínimo32,
alteração de Basic, credencial inválida e checkout com flagfalse. Evidência:
`validation-credential-compatibility.md`; testes literais em
`test/billing-worker-credentials.test.js:30`, `:48`, `:78`, `:180`, `:202`.
Não foram repetidos testes custosos nem injetadas falhas em produção. O sensor
estrutural do guard publicado6/6 e a preservação dos141 nós originais estão
na revisão T5/T6; os exports atuais permanecem iguais ao baseline aprovado.

Nenhuma credencial ou valor secreto foi impresso por esta revisão. Os booleans
de chave e a construção dos clientes não provam que a chave InfinitePay ou as
credenciais dos webhooks sejam aceitas pelos sistemas externos. O teste manual
do proprietário permanece pendente, assim como confirmação de conta, crédito
financeiro e entrega WhatsApp. Não há prova de image digest completo de
d8200857; a evidência de fonte é restrita aos quatro arquivos, container/role
e processo observados. Não foi ensaiado restore.

BREL-04 atualizado foi preservado: flags ligadas têm autorização expressa;
nenhum ensaio financeiro foi executado pelo agente. A decisão do proprietário
substitui a ordem proposta anteriormente de homologar antes de ligar send,
sem remover autenticação, ACL, reserva, preflight ou idempotência. A ativação
alcança os operadores autorizados existentes; não foi criado um piloto técnico
restrito por usuário/pedido. Operação incerta continua exigindo conferência,
sem repetição cega. Flags não cancelam links já emitidos.

Sem finding bloqueante para encerrar T9 como **funções habilitadas para teste
manual posterior**, sem declarar o teste aprovado. Nenhuma lição nova, pois
não houve sinal de falha. Esta revisão modificou somente este relatório;
spec/tasks/runbook do autor foram preservados. Não houve navegador, comando
remoto, commit/push, checkout temporário ou nova execução de efeito.
