# Validação independente da implantação de cobranças

**Verdict: PASS — exclusivamente para implantação com cobrança desligada.**

Revisor: `billing_release_devops_review`, independente do autor das operações.
Conferência em 09/11/2026, America/Sao_Paulo. Fonte implantada:
`87cbc4351801087faf2ada798c5946f66a1976d9`, árvore idêntica ao HEAD aprovado
`e5e65af9f5603fbb27f01b711e9714212966bde2`. O resultado não declara a feature
homologada nem disponível operacionalmente para vendedores.

## Critérios e rastreabilidade

| Critério | Tarefa | Evidência e avaliação | Resultado |
| --- | --- | --- | --- |
| BREL-01 — integração preserva contratos publicados | T1 | `.specs/features/order-billing-release/validation-integration.md:20` registra upgrade/Olist e preservação dos SQL; `:22` a `:28` cobrem cancelamento, callbacks, leitura e retirada do Financeiro; `:40` e `:45` registram os gates independentes e os 70 SQL preservados. Addenda em `.specs/features/order-billing-release/validation-release.md:20` e `:21` identificam as correções posteriores de fixtures/teclado e suas verificações, sem atribuir a revisão original a outro SHA. | PASS |
| BREL-02 — integração aprovada e fonte recuperável | T2 | `.specs/features/order-billing-release/validation-release.md:7`, `:8`, `:10` e `:25` identificam merge linear pelo mantenedor, CI, igualdade das árvores e fonte anterior. O revisor consultou diretamente PR333 e CI42729101945 via CLI: MERGED, SHA87cbc435 e cinco jobs success no HEADe5e65af9; comparou as árvores com git diff, sem diferenças. Logs de build inspecionados registram os image IDs descritos em `docs/qa/order-billing-release-2026-11-09.md:23`. | PASS |
| BREL-03 — backup, expand, checksums e saúde | T3 | `docs/qa/order-billing-release-2026-11-09.md:33` registra capacidade anterior; `:37` e `:38` identificam backup/sucesso. `:56` a `:60` registram 0073–0075, 71/71 expand e replay zero; `:66` a `:68` registram restauração do comando original. Screenshots inspecionados confirmam esses resultados, migrador ausente do startup, API live/ready e edge200, heartbeat8s e scannertrue, conforme `:76` a `:82`. Os três hashes de assets em `:95` a `:97` foram recalculados pelo revisor e coincidem com o container; HTML público coincide com index.html. | PASS |
| BREL-04 — ausência de habilitação e efeitos reais | T1–T4 | `docs/qa/order-billing-release-2026-11-09.md:77` e `:82` registram três flags false nos processos API/worker e seis tabelas billing vazias. As respectivas capturas foram inspecionadas. `var/billing-production-preparation/release-final-review.json:4` e `:16` confirmam os dois workflows financeiros inativos. A captura do histórico humano mostra a versão publicada original de06/11 às16:27:52, separada das alterações atuais; restauração do export141nós foi conferida em `var/billing-production-preparation/human-restoration-review.json:2`. Nenhum pagamento, checkout ou mensagem real foi usado como probe nesta revisão. | PASS para o escopo desligado |
| BREL-05 — credencial privada e referências | T4 | `docs/qa/order-billing-production-preparation-2026-11-08.md:124` registra cadastro/salvamento pessoal pelo proprietário; `:130` registra os três nós vinculados somente por referência. O autor não forneceu o valor ao revisor. O relatório privado inspecionado `var/billing-production-preparation/release-final-review.json:10` e `:11` registra cinco bindings Basic e dois Header Auth na emissão; `:22` e `:23` registra cinco Basic e um Header Auth na conferência. Os relatórios registram estrutura/conexões/settings iguais e activefalse. A entrada pessoal é evidência declarada pelo proprietário, não observação do segredo pelo revisor; não foi executada chamada ao provedor para validar a chave. | PASS para cadastro/referências, sem homologação financeira |

## Método e evidências independentes

Esta revisão inspecionou os relatórios versionados, os dois JSONs privados
sanitizados de comparação e as capturas `billing-release-api-final-flags-health`,
`api-final-source-schema`, `schema-replay-health-first`, `worker-final`,
`edge-public`, `backup` e `human-published-preserved`, sob `var/` e com prefixo
`billing-release-`. Não abriu exports privados completos nem valores secretos.
Também consultou GitHub em modo somente leitura, leu os logs de build e
recalculou SHA-256 dos três assets locais via Python.

Não houve alteração de produção, publicação n8n ou execução financeira pelo
revisor. Os testes de integração e o sensor comportamental são os registrados
pelo verificador de integração, incluindo cinco mutações detectadas em
`.specs/features/order-billing-release/validation-integration.md:61`.
Esta revisão de fechamento não repete esses testes nem apresenta resultados
do autor como novas execuções independentes.

## Limites e pendências anteriores à habilitação

- Guard de cobrança do workflow humano ainda precisa ser aplicado e revisto;
  os workflows compatíveis precisam de publicação controlada e flags
  coordenadas antes da homologação. A versão publicada original foi preservada;
  não há aprovação de go-live implícita. Evidência:
  `docs/qa/order-billing-release-2026-11-09.md:108`.
- Teste real de pagamento, checkout, callback e envio não foi executado. O
  proprietário deve ser avisado antes do ensaio, conforme o escopo autorizado.
- Backup Local Disk disponível não comprova restauração testada nem cópia
  offsite: `docs/qa/order-billing-release-2026-11-09.md:39` e `:46`.
- Os identificadores dos builds são image IDs locais, não registry digests com
  pull validado. O scan aprovado do CI não constitui scan do rebuild executado
  pelo EasyPanel: `docs/qa/order-billing-release-2026-11-09.md:26`.
- Tabelas vazias, flags false e workflows inativos corroboram ausência de
  efeitos de cobrança neste rollout; não são auditoria universal de todos os
  serviços externos. A chave foi vinculada, mas sua validade perante o provedor
  permanece sem ensaio real.

Nenhum finding bloqueante para encerrar T1–T4 no escopo de implantação
desligada. As pendências acima bloqueiam declarar homologação completa ou
liberar a operação financeira para vendedores.

## Addendum — proteção publicada e preparação inativa (09/11/2026)

A revisão histórica T1–T4 acima permanece inalterada. A proteção humana foi
publicada posteriormente e sua preparação de ativação foi revisada de forma
independente em [validation-activation-preparation.md](validation-activation-preparation.md).
O novo veredito é PASS somente para T5/proteção publicada e T6/preparação
inativa; atualiza a pendência histórica do guard, sem declarar ativação,
execução financeira, homologação InfinitePay ou entrega WhatsApp. As três
flags continuam false e os dois workflows financeiros permanecem inativos
nas evidências inspecionadas.

## Addendum — recebimento e conferência habilitados (10/11/2026)

O estado histórico acima é atualizado pelas revisões independentes
[T8/compatibilidade Basic](validation-credential-compatibility.md) e
[T7/recebimento](validation-receive-only.md), ambas PASS em seus escopos.
Os workflows financeiros estão publicados e API/worker executam RECEIVEtrue,
ENABLEDfalse e CHAT_SENDfalse. Nenhuma credencial foi alterada e nenhum teste
financeiro real foi executado. Isso encerra T7/T8/BREL-08/09, preservando os
vereditos históricos e os limites sobre autenticação externa, image ID completo
da API, heartbeat dedicado, homologação InfinitePay e entrega WhatsApp.
