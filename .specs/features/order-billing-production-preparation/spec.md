# Preparação técnica de cobranças em produção

## Problem Statement

Os fluxos do CRM estão validados em DEV; produção ainda usa apenas o checkout
da loja. É necessário preparar a implantação sem iniciar efeitos reais.

## Escopo

Autorização do proprietário: conferir tecnicamente e preparar workflows de
produção com envios desligados; avisar antes de teste com pagamento real.
Esta etapa não inclui merge, deploy geral, migração remota, ativação ou pagamento.
Rastreia COB-OPS-01 e BAPI-07/09/10 sem declarar homologação financeira concluída.

## Out of Scope

Pagamento/envio real, troca de credenciais, publicação dos novos webhooks,
implantação da aplicação e alteração do checkout da loja.

## Assumptions & Open Questions

O usuário abriu acesso autenticado ao n8n e EasyPanel. Não há autorização de
teste financeiro. Bindings e release remotos precisam de conferência posterior.

## User Stories

Como operador, quero conferir os pré-requisitos e preparar candidatos inativos
para decidir a implantação antes de movimentar dinheiro ou enviar mensagens.

## Requirements

- PPREP-01: WHEN a preparação terminar, THE SYSTEM SHALL manter os novos workflows financeiros inativos, sem execução manual, cobrança ou mensagem real, preservando os workflows publicados da loja e atendimento.
- PPREP-02: WHEN o n8n exportar um preflight HTTP com método GET omitido, THE SYSTEM SHALL preparar a guarda de cobrança com GET explícito, preservando fonte, credenciais, headers e demais ramos, rejeitando métodos diferentes e drift.
- PPREP-03: WHEN o estado remoto for registrado, THE SYSTEM SHALL distinguir health, flags observadas, migrações aplicadas, versão disponível e credenciais pendentes, sem divulgar segredos nem inferir homologação a partir de health200.
- PPREP-04: WHEN os candidatos financeiros forem importados pela interface do n8n, THE SYSTEM SHALL conferir por nova exportação a inatividade e a retenção desligada de execuções de sucesso, erro, manuais e progresso.

## Acceptance criteria

- Dois workflows financeiros persistidos e exportados novamente com activefalse e quatro opções de retenção desligadas; sem ação Publish ou Execute.
- Patch sintético aceita GET omitido/explicitamenteGET e rejeita POST/HEAD/DELETE/null/vazio/expressão; patch repetido não altera o resultado.
- Diagnóstico documenta ausência das migrações0063–0065, flags/URLs ausentes e credenciais não homologadas como bloqueios para ativação.
- Pagamento real permanece dependente de aviso e autorização; COB-OPS não é concluída por esta preparação.

## Requirement Traceability

| ID       | Task                 | Evidence                                          |
| -------- | -------------------- | ------------------------------------------------- |
| PPREP-01 | T1 / COB-OPS-PREP-02 | exports inativos e fluxos publicados preservados  |
| PPREP-02 | T1 / BAPI-07/09/10   | billing-send-workflow.test.js e candidato privado |
| PPREP-03 | T1 / COB-OPS-01      | relatório técnico de produção                     |
| PPREP-04 | T1 / COB-OPS-PREP-02 | nova exportação persistida e settings conferidos  |
