# Implantação de cobranças com emissão desligada

BREL-02/03/04, T2/T3. Conferência em09/11/2026, America/Sao_Paulo.
Ambiente EasyPanel `espectro-mvp`.

**Implantado, migrado e saudável, com cobrança desligada.** Este resultado não
equivale à homologação financeira nem à ativação da feature para vendedores.

## Release e imagens

[PR333](https://github.com/romulosutil/crm-silmer/pull/333) integrado por rebase
em87cbc4351801087faf2ada798c5946f66a1976d9, às21:44:43. Os cinco checks da
[CI42729101945](https://github.com/romulosutil/crm-silmer/actions/runs/42729101945)
passaram no HEADe5e65af9; árvores sem diferenças. Gates e revisões estão em
[validation-release.md](../../.specs/features/order-billing-release/validation-release.md).

O EasyPanel manteve a fonte GitHub/master e os Dockerfiles existentes. O
deploy automático iniciou após o merge. Logs de build indicam sucesso às
21:46:05 para API/worker e21:46:04 para edge.

| Serviço | Image ID local registrado no build |
| --- | --- |
| API e worker | `sha256:80b27ae9b1d804d28fb0ee5c71adde7a20bdf0962391dd8233b1c818dd71b478` |
| Edge | `sha256:4b6682766613f4d4756fb24bce81b0c8b819ac60fc99e59d64199d6c10e3e5ac` |

São image IDs locais, não digests de registro com pull validado. O scan do CI
valida as imagens construídas no CI; não foi apresentado como scan do rebuild
do EasyPanel. Os arquivos executados e os assets servidos foram comparados
separadamente com a fonte/build aprovados.

## Backup e recuperação

Antes do deploy, banco na migração0072 e35,67MiB; filesystem com63431MiB livres.
Backup manual pela configuração Local Disk existente do PostgreSQL:

- Nome: `pre-billing-0073-0075-20261109`.
- Arquivo: `espectro-mvp/silmer-postgres/2026-11-10T00:00:56.759Z.sql.gz`.
- Resultado: Success,2,6MB; conclusão09/11 às21:00:58 locais.
- Retenção existente: sete backups. Não houve restauração nem cópia offsite verificada.

Fonte anterior recuperável:0ed44bd38171276f0b0a7ef6a5319f802bec55fd. O histórico
do build anterior da API registra image ID
`sha256:8c3ead130d4d08846cb22ebab7070f693bdc8aaf629ee0ebb5dfa3c0a0d325c2`.
O comando original da API foi preservado antes da mudança e restaurado ao fim.
Recuperação de runtime usa a fonte anterior compatível com o schema expandido;
não envolve DROP, downgrade ou restore automático. Disponibilidade do backup
não é evidência de restauração testada.

## Migração transacional

O comando temporário da API executou
`node modules/database/src/cli.js --phase=expand` antes do servidor, sob
`sh -ec`, mantendo Zero Downtime. O novo processo só iniciou após sucesso do
migrador. Resultado observado: `applied_count:3`, `phase:expand`, `status:ok`.

Aplicadas0073_order_billing_send_intents,0074_billing_send_transport e
0075_billing_external_receipts_and_checks. SELECT em transação READ ONLY,
encerrada com ROLLBACK, comparou version/name/phase/checksum com os arquivos
expand da própria release: **71 aplicadas/71 esperadas, última0075, zero
divergências ou pendências**. A repetição do CLI retornou applied_count0/ok.

As duas contract0012_remove_mfa e0018_remove_invitations não pertencem ao plano
expand e não foram executadas. Os70SQL publicados na master foram preservados
byte a byte na integração; isso não significa70expand aplicadas no banco.

Após a migração, o comando original foi restaurado exatamente e salvo no
EasyPanel. Novo deploy da mesma fonte concluiu; no processo final,
STARTUP_HAS_MIGRATORfalse. Nenhuma rotina permanente de migração foi adicionada.

## Estado final observado

| Conferência | Resultado |
| --- | --- |
| API final | Instância `g4bed9p91ncv9uv7756fgsh9t`, NodePID8 |
| Worker final | Instância `xi05iinun2es53reijg5nlfuw`, NodePID7 |
| Fonte runtime | Sete arquivos críticos, incluindo servidor, worker, rotas/runtime billing e0073–0075: hashes SHA-256 correspondem à fonte aprovada em ambos os serviços |
| Flags nos processos Node | ORDER_BILLING_ENABLED=false, ORDER_BILLING_CHAT_SEND_ENABLED=false, ORDER_BILLING_RECEIVE_ENABLED=false em API/worker |
| URLs | Emissão `/webhook/silmer/order-billing/create` e conferência `/webhook/silmer/order-billing/check` no n8n de produção, em ambos os processos |
| Startup | Migrador ausente do comando da API e do worker |
| Saúde | API `/api/health/live`200, `/api/health/ready`200, edge `/healthz`200 |
| Worker | Heartbeat observado com8s e ping do scannertrue |
| Efeitos billing | Charges, payments, refunds, send_intents, external_receipts e payment_checks: todas com zero registros |

Os três totais preexistentes (charges/payments/refunds) já eram zero antes do
deploy. Não foi criada cobrança, mensagem, pagamento ou fixture no banco de
produção. As leituras não incluíram dados pessoais ou payloads de pedidos.

## Frontend efetivamente servido

SHA-256 dos arquivos no container edge coincide com o build local da árvore
aprovada. GET público do HTML devolveu o mesmo hash do arquivo index.html.

| Arquivo | SHA-256 |
| --- | --- |
| index.html | `9aac2bc9ebf3c49bf66c2991ad3172068ffc5651e51d343797032e5ce73c4ba7` |
| assets/index-DS0nDRTS.js | `20f07345dffc821a36900f59b4c61064a84c91185d2bd3a6727b0fee6a2c9993` |
| assets/index-BU5MVC0_.css | `9aab54cb4dea0c3b8bfacbf07dbc3152e3cb3178632bd83d681b7b8efe6475db` |

O teste de UI em produção com feature ativada não foi executado. A validação
funcional da interface permanece a dos gates sintéticos do PR.

## Limites e próxima etapa

Os dois workflows financeiros permanecem inativos. Credenciais e preservação
do atendimento são registradas na atualização de09/11 do
[relatório de preparação](order-billing-production-preparation-2026-11-08.md).

Antes da homologação real: aplicar o guard de cobrança no workflow humano,
revisar/publicar controladamente os workflows compatíveis e coordenar flags
de emissão, recebimento e envio. A tentativa de importação do guard foi
revertida: o rascunho foi restaurado e comparado com o original. A versão
publicada do atendimento continua a original de06/11; nenhum teste foi
executado por esse workflow durante a intervenção.

O proprietário deve ser avisado antes de qualquer ensaio com checkout,
pagamento ou mensagem reais, obtendo-se autorização específica. As Basic
reutilizadas e a API Key vinculada não foram consideradas homologadas por
mera presença da referência. Conectividade/autenticação financeira ponta a
ponta ainda não foi exercitada.

## Evidências privadas e revisão

Os artefatos permanecem em `var/`, ignorado pelo Git. Não versionar exports
remotos ou segredos. Provas principais:

- `billing-release-backup.jpg`, `billing-release-api-before-build.txt` e logs `billing-release-{api,worker,edge}-build.txt`.
- `billing-release-api-migrations.jpg`, `billing-release-schema-replay-health-first.jpg`.
- `billing-release-api-final-flags-health.jpg`, `billing-release-api-final-source-schema.jpg`, `billing-release-worker-final.jpg`.
- `billing-release-edge-public.jpg`, `billing-release-human-published-preserved.jpg`.
- `billing-production-preparation/release-final-review.json` e `human-restoration-review.json`.

Revisão independente DevOps: PASS para implantação desabilitada. O revisor
inspecionou capturas, relatórios, logs de imagem, CI/PR, igualdade das árvores
e hashes dos assets locais. Não executou teste financeiro nem restauração.
O UUID publicado do atendimento deriva da conferência DOM do responsável;
a captura confirma a publicação original separada das alterações de rascunho.
