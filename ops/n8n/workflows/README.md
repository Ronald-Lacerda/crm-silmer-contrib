# Workflows: referência publicada e candidatos

## Referência operacional

O workflow publicado é a fonte da verdade desta reconciliação (SIL-36;
ORC-03/05/08 e AGT-10). O índice
[`production-reference.json`](production-reference.json) aponta para
[`k7tI6T4RhQPyJkn9-published.sanitized.json`](k7tI6T4RhQPyJkn9-published.sanitized.json):
141 nós da versão `4becba96-a3eb-4ef3-9b6c-9762537d84f2`.

O export foi lido de `workflow_history` pela `activeVersionId` da entidade,
em transação `READ ONLY`, sem execuções nem pin data. A releitura final
confirmou versão, nós, conexões e settings inalterados. As configurações
globais vêm da entidade atual: o histórico do n8n não mantém settings próprios.
Os fingerprints sanitizados foram calculados antes da transferência, no
mesmo processo em memória, e são conferidos pelos testes do repositório.

A sanitização remove `credentials`, `webhookId` e `pinData`; troca o número
da conta por `__SILMER_OWN_NUMBER__` e os hosts privados por
`https://crm.invalid` e `http://evolution.invalid:8080`. Headers técnicos,
inclusive versões distintas por ramo e `X-Silmer-Content-SHA256`, permanecem. Valores de headers fora
da lista técnica permitida recebem `__CREDENTIAL_HEADER_VALUE__`.
Nenhum código de negócio, posição, ID de nó ou conexão foi substituído.
O arquivo de referência tem `active: false`: é evidência para comparação,
não um artefato de implantação com credenciais operacionais.

O publicado mantém os nove nós `Inbox - Imagem recebida` (também tratam
áudio), o validador da reserva da IA, os diagnósticos controlados, wrappers
de telemetria, observador OA, preflight de destinatário e recibos Evolution.
Publicado e rascunho possuem o mesmo código e conexões. O rascunho só muda
posições em oito nós e omite `runOnceForAllItems`, que é o default instalado,
no validador da reserva. Não há delta funcional a publicar desse rascunho.

## Alterações preservadas para reaplicação

[`k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json`](k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json)
continua sendo o candidato de jornada com fronteira Meta, com 115 nós.
Esse arquivo, SDK, adaptadores, preparadores e snapshots DEV/local foram
preservados byte a byte do commit `72702f0`; o manifesto registra os 29
fingerprints anteriores. Os testes existentes continuam verificando o
candidato, sem declarar suas funcionalidades como publicadas.

[`pending-features.json`](pending-features.json) associa cada delta à issue
do Linear, aos requisitos e aos nós onde o código foi preservado:

| Issue                                                    | Delta pendente                                  |
| -------------------------------------------------------- | ----------------------------------------------- |
| [SIL-8](https://linear.app/marfimsolucoes/issue/SIL-8)   | Perguntas de imagem, saudações e textos VND-L04 |
| [SIL-39](https://linear.app/marfimsolucoes/issue/SIL-39) | Registro da transcrição do áudio do cliente     |
| [SIL-40](https://linear.app/marfimsolucoes/issue/SIL-40) | Handoff por falha do agente/normalizador        |
| [SIL-41](https://linear.app/marfimsolucoes/issue/SIL-41) | Calendário de feriados                          |
| [SIL-42](https://linear.app/marfimsolucoes/issue/SIL-42) | Cliente recorrente                              |
| [SIL-43](https://linear.app/marfimsolucoes/issue/SIL-43) | Histórico por assunto                           |
| [SIL-44](https://linear.app/marfimsolucoes/issue/SIL-44) | Vendedor solicitado pelo nome                   |
| [SIL-45](https://linear.app/marfimsolucoes/issue/SIL-45) | Motivo de parceria                              |
| [SIL-46](https://linear.app/marfimsolucoes/issue/SIL-46) | Correções de interpretação                      |
| [SIL-47](https://linear.app/marfimsolucoes/issue/SIL-47) | Reconciliação da telemetria integrada           |
| [SIL-48](https://linear.app/marfimsolucoes/issue/SIL-48) | Decisão sobre Responses API, retries e timeout  |
| [SIL-49](https://linear.app/marfimsolucoes/issue/SIL-49) | Revisão de gatilhos legados, headers e defaults |

As duas últimas são revisões técnicas: a diferença no JSON não autoriza
trocar o valor operacional, reativar entradas legadas ou retirar o fence.

## Uso dos preparadores

`create-evolution-workflow.mjs` adapta fontes Meta para candidatos inativos e
testes. Seu resultado não reproduz todos os complementos publicados.
`prepare-vendedor-update.mjs` é um preparador histórico que substitui os
dois códigos de contexto/decisão e o prompt inteiros; ele não demonstra
preservação dos wrappers atuais nesses nós. Não é o procedimento de
reaplicação dos deltas acima. Nenhum desses programas foi executado contra
o principal nesta reconciliação.

Cada pendência deve produzir um delta restrito sobre a referência publicada,
com fixtures sintéticas e comparação de conexões/settings. Uma futura
mudança intencional nos candidatos deve atualizar a rastreabilidade e os
fingerprints de preservação; não remover testes para contornar divergência.
Export operacional privado, backup, revisão e autorização de publicação
pertencem à futura release. Importação, ativação e publicação não fazem parte
da SIL-36.

## Verificação da reconciliação

Após rebase sobre a master, `npm run validate` aprovou 1.757 testes, com 16 ignorados, nenhuma falha e
build. Após preservar o header técnico `X-Silmer-Content-SHA256`, os 12
testes focados da referência/reserva passaram novamente; revisão
independente sem achados pendentes. O sensor da revisão detectou quatro
regressões em cópias temporárias, sem alterar o checkout.

E2E teve 500 aprovados e sete ignorados; quatro casos com crash/timeout do
navegador passaram na repetição com dois workers. O único caso restante é
gravação sintética Firefox: o executável não inicia no host (`spawn UNKNOWN`),
mesmo com o navegador do Playwright instalado. A integração deve conferir
esse gate no CI/ambiente compatível. A auditoria de dependências passou no
limiar high, com seis avisos low/moderate existentes. Nenhuma dependência
foi alterada por esta fatia.
