# Saúde e erros — operação e recuperação

Data: 02/11/2026. OPS-ERR-01–08 / OPS-ERR-T01;
[ADR 055](../adr/055-central-de-erros-restrita-a-conta-operadora.md),
[RFC 042](../rfc/042-central-de-saude-e-erros.md) e
[issue #11](https://github.com/romulosutil/crm-silmer/issues/11).

## Acesso e uso

O item **Saúde e erros** abre `/saude-erros` no menu existente, inclusive no
celular. Só a conta humana `admin@crm-silmer.local`, ativa, com função
Vendedor e capacidade `COMMERCIAL_ADMIN`, pode consultar ou alterar a triagem.
Outros administradores, Financeiro, vendedores e credenciais de automação
não recebem acesso. A API consulta a identidade atual no banco; trocar
permissões ou desativar a conta impede novas requisições.

Use o filtro para ver Novos, Em análise, Resolvidos ou Todos. **Atualizar**
consulta os dados e coleta novos registros de falha das fontes persistidas.
Se houver coleta pendente, atualize novamente até concluir os lotes. O
horário da última consulta aparece no fuso de São Paulo. Ausência de
ocorrências não confirma saúde dos provedores ou da infraestrutura.

### Ativas, histórico e transporte descontinuado

O recorte inicial **Ativas** usa os estados atuais das fontes, excluindo
comandos arquivados operacionalmente. **Histórico** conserva as ocorrências
deduplicadas dos últimos 30 dias, incluindo revisões anteriores da mesma fonte.
Uma mesma operação pode aparecer em Processamento e Automação n8n; não some
essas contagens como se fossem envios distintos. Datas ativas e históricas são
apresentadas separadamente. Um grupo sem fonte ativa pode continuar em análise
no histórico: isso não confirma entrega nem resolve seu resultado original.

**Arquivar pendências do WAHA** está restrito à conta operadora, com os mesmos
controles de sessão, CSRF, origem, auditoria e idempotência. A revisão congela
quantidade e fingerprint do manifesto. O servidor confere novamente, sob lock,
comandos incertos com reserva autenticada `message.send.requested` da versão
`waha-webjs-1`, da mesma mensagem e conversa. Mudança do manifesto exige nova
consulta (409). Evolution não faz parte desse conjunto.

O arquivo operacional fica em `crm.n8n_command_operational_archives`; não muda
status, erros ou horários de comandos/jobs/mensagens, não fecha reconciliações,
não habilita retry e não apaga recibos ou tentativas. Confirmações tardias ainda
podem reconciliar o resultado pelo contrato existente. A marca acompanha a vida
do comando, independentemente da retenção de 30 dias da central.

Na operação de 03/11/2026, o manifesto esperado é de **12 comandos WAHA**;
o comando Evolution permanece em análise, projetado em worker e n8n. Conferir
essa quantidade antes de confirmar; divergência exige investigação. A migration
`0052_legacy_command_operational_archive.expand.sql` é necessária antes da API.

O desempenho do agente mantém a contagem de `workflow.failed` no período e
mostra última ocorrência e recorrência recente com referência ao relógio da
API. Esses eventos não equivalem a mensagens que falharam nem a uma fila de
pendências. Ausência de novos eventos não comprova correção do workflow.

### Diagnóstico de workflow.failed sem reter execuções

Em 03/11/2026, a leitura de sete dias encontrou 961 eventos: 943 com código
genérico `WORKFLOW_FAILED` e 18 `INBOUND_MEDIA_STORE_FAILED`. Havia 273 eventos
genéricos nas últimas 24 horas e três na última hora; a última ocorrência era
13:55:33 UTC (10:55:33 de Brasília). Portanto, a reconciliação de comandos
antigos não comprova que a causa das falhas recentes foi sanada.

O workflow publicado usa `saveDataErrorExecution: none` e
`saveDataSuccessExecution: none`. Os IDs recentes já não tinham dados de
execução consultáveis. Não habilitar retenção de payloads para esse diagnóstico.
O helper offline `ops/n8n/patch-workflow-failure-diagnostics.mjs` aceita somente
um export atual e altera exclusivamente o nó **Preparar workflow.failed (MVP)**.
Ele deriva um código controlado `WORKFLOW_NODE_<hash>` de cada nome de nó
existente; nomes desconhecidos ficam genéricos. Não encaminha mensagem, stack
ou payload do erro. A API continua guardando somente `failureCode`.

Antes de publicar, guardar export privado, checksum, mapa código/nó e revisão
do delta; comparar nós, conexões, configurações e referências de credenciais.
Preservar todos os demais workflows e publicar somente o principal já ativo.
Depois, observar eventos novos naturais e correlacionar o código com o mapa.
Não repetir execuções, webhooks ou comandos antigos para produzir evidência.
Sem um novo evento ou evidência técnica equivalente, a causa continua aberta.

Diagnóstico publicado pela interface n8n em 03/11/2026 na versão
`28354382-1e4b-4bd6-a9cf-4c559a281da2`, ativa com 113 nós. Conferência após
publicar: somente o Code node de diagnóstico mudou; os 40 outros workflows
mantiveram nós, conexões, configurações e versão ativa. Backup privado e mapa
ficam em `/home/node/.n8n/silmer-recovery/20261103-failure-diagnostics/`.
SHA-256 do export anterior:
`55a19a1f2bdb82fcd9d8a1417cc55b4a10c8643fc03b9566813909ccefc188eb`.

Na continuação de 03/11, seis eventos novos foram correlacionados ao conversor
Evolution e ao motivo `EVOLUTION_IDENTITY_UNRESOLVED`. Os quatro arquivos do
event bus disponíveis cobriam 927 falhas do principal entre 29/10 às
15:31:31.248 UTC e 03/11 às 15:17:36.964 UTC: 648 de identidade, 267 com
mensagem exata de sintaxe e 12 de outras causas. Essa cobertura difere da
janela de sete dias do CRM; não subtrair as contagens nem atribuir todos os
eventos antigos à mesma causa. Nenhum payload foi habilitado ou reexecutado.

OPS-INBOX-ACK-05 publicou a correção do contrato de recibos LID e motivos
controlados no principal, versão `11f17d0b-448a-4b0b-9717-7214fbde858e`,
com três nós alterados e 40 outros workflows preservados. Contrato, backup,
gates e limite da evidência no [runbook Evolution](evolution-baileys.md#recibos-com-lid--03112026).
Somente recibo natural novo pode validar o caminho completo. O histórico de
falhas permanece e o comando Evolution antigo continua incerto/em análise;
publicar a correção não é confirmação de entrega desse comando.

Cada grupo reúne uma origem e um código técnico controlado, com contagem,
primeira e última ocorrência e histórico. **Em análise** registra que a conta
operadora assumiu a investigação. **Resolver** encerra a triagem; **Reabrir**
devolve o grupo a Novo. Uma nova falha reabre automaticamente um grupo
resolvido. A conta autorizada é a responsável única, sem atribuição a outros
usuários ou texto livre. Resolver uma ocorrência não corrige o serviço.

Em caso de conflito ou resposta incerta ao salvar a triagem, atualize antes
de tentar novamente. O servidor valida versão e idempotência e mantém
auditoria transacional. Nenhum desses comandos reexecuta jobs, envia
mensagens, confirma pedidos ou altera o comando n8n de origem.

## Cobertura e diagnóstico

| Origem | Códigos                                                        | Como investigar                                                                                     |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| API    | `API_5XX`, `API_NOT_READY`                                     | Conferir readiness, release/migrations e logs técnicos do EasyPanel pela referência opaca.          |
| Worker | `WORKER_RETRY`, `WORKER_DEAD_LETTER`, `WORKER_OUTCOME_UNKNOWN` | Conferir fila, tentativas e runbook da integração, preservando o efeito original.                   |
| n8n    | `N8N_FAILED`, `N8N_OUTCOME_UNKNOWN`, `N8N_PROCESSING_EXPIRED`  | Conferir comando e execução no ambiente autorizado, sem copiar payload ou credencial para o painel. |

Captura de 5xx começa com a implantação desta versão; não reconstrói logs
antigos. Coleta das filas consulta estados de falha registrados no CRM nos
últimos 30 dias, em lotes limitados e deduplicados. Não é o histórico completo
de execuções n8n, heartbeat de todos os serviços ou monitor direto de IA,
WhatsApp e storage. Uma mudança de estado/código da fonte pode produzir
outra ocorrência; repetir a mesma coleta não incrementa a contagem.

Diagnósticos guardam códigos fixos, contagens, horários e identificadores
opacos, sem stack, corpo, mensagem ou dado de cliente. Não acrescente detalhes
livres, nomes, telefone ou credenciais aos registros e evidências. Dados
técnicos seguem uma janela de 30 dias, incluindo a contagem e a primeira
ocorrência dos grupos ativos. A API limpa os registros na inicialização, a
cada hora e durante a consulta; a consulta filtra a janela mesmo se a
limpeza estiver atrasada. Com o processo parado, o expurgo físico aguarda o
retorno da API. Auditoria e respostas idempotentes conservam suas políticas
próprias, sem transportar diagnósticos livres.

Resultado desconhecido exige conferir o destino e reconciliar conforme o
runbook da integração. Não reenviar às cegas: a mensagem pode ter chegado.
O painel não oferece esse reenvio.

## Implantação e rollback

O gate PostgreSQL de OPS-ERR-T01/OPS-ERR-05 consulta `view=history` após a
disputa entre Novo e Resolvido: qualquer transição pode vencer, e a visão
Ativas exclui o grupo resolvido da API. A regressão também verifica que o
grupo resolvido sai de Ativas e permanece no Histórico com a mesma versão,
independentemente do vencedor. Isso evita a falha intermitente identificada
no CI pós-merge de 04/11/2026, sem mudar a triagem ou a aplicação.

1. Validar a migration `0051_operational_incidents.expand.sql` no banco
   dedicado de testes, com dados sintéticos e os testes de ACL/triagem.
2. Aplicar migrations expand no ambiente alvo com o procedimento existente:
   `node /app/modules/database/src/cli.js --phase=expand`. Conferir checksum e
   readiness. O painel depende das novas tabelas.
3. Implantar a API e o edge-web pelo fluxo GitHub → EasyPanel vigente.
4. Com a conta designada, conferir menu, leitura e triagem de um canário
   sintético; com outra conta administrativa, conferir menu ausente e API403.
   Não provocar indisponibilidade real ou envio de WhatsApp para esse teste.
5. Conferir persistência após reiniciar a API e ausência de PII no retorno e
   nos logs. Registre SHA/digest e evidências operacionais sanitizadas.

Rollback restaura a versão anterior da aplicação e mantém as tabelas expand,
sem apagar auditoria, jobs, comandos ou banco. Não executar migration
destrutiva como primeira resposta. A implementação local não comprova que a
migration foi aplicada em produção.

## Alertas externos

Esta entrega oferece consulta e triagem dentro do CRM. Monitor off-host,
destinos de notificação, operador, retenção e drills continuam em
[T00.7](../../ops/observability/README.md) e no gate `pending-external` da
issue #11. Se API ou banco estiverem indisponíveis, o painel também pode
ficar indisponível. Não registrar essa tela como comprovação de monitor ou
entrega de alertas externos.
