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
