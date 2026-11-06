# ADR 063 — Triagem prioritária do Vendedor

Data: 06/11/2026. Status: aceita pela solicitação explícita do proprietário.
Proposta: [RFC 051](../rfc/051-triagem-prioritaria-sem-inferir-regras-comerciais.md).
Requisitos: AGT-01–05/08, ORC-03/05/07; tarefa VND-L05 no
[plano](../../.specs/features/crm-mvp/tasks.md).
Complementa ADRs 049/052/056 e supersede somente a continuação da coleta após
pergunta de capacidade da ADR 049, item 1, e a exigência de ficha completa
para urgência hoje/amanhã da ADR 051, item 7.

## Decisão

1. Pergunta explícita sobre quantidade mínima ou capacidade de produzir,
   aceitar material/peça ou reproduzir referência interrompe a coleta e
   solicita handoff sem dono com `human_requested`. O gatilho interno é
   `commercial_question`; o resumo cifrado conserva a dúvida e as pendências.
   Não há resposta sim/não, sugestão de quantidade mínima nem catálogo novo.
   Pedido de orçamento simples e nome de produto isolado não são esse gatilho.
   A regra específica de pedido de criação de arte permanece vigente.
2. Opções explícitas de quantidade para orçamento ficam em `notes`, sem
   escolher, somar ou substituir uma quantidade anterior. O vendedor avalia
   as opções pelo mesmo handoff comercial. Uma grade confirmada e uma correção
   inequívoca continuam sendo dados válidos, não alternativas presumidas.
3. Prazo desejado inequívoco hoje/amanhã transfere com `urgency` mesmo com
   nome, cor, tecido ou arte faltantes. Data ambígua mantém sua confirmação;
   enviar arte ou pagar hoje/amanhã não define entrega. Não se promete prazo
   de produção, disponibilidade ou atendimento imediato.
4. Perguntas geradas sobre campos já preenchidos são substituídas pela pergunta
   do próximo campo faltante. Receber imagem continua sem confirmar origem,
   qualidade ou aprovação da arte. Campos válidos e escolhas humanas permanecem.
5. Desistência, categorias excluídas, alvo ambíguo, pedido de pessoa e
   reclamação preservam seus guardas e motivos. Nenhum caminho retoma bot em
   atendimento humano, cria pedido ou altera condição comercial. Reservas,
   epoch, revisão, idempotência, ACL e auditoria continuam obrigatórios.

## Implementação e operação

`mvp-simple-23` no SDK e snapshots principal/DEV/local. Sem banco, dependência,
novo campo de API ou infraestrutura. A detecção textual é uma proteção para
casos explícitos, não cobertura de toda paráfrase. Nome de produto isolado
não prova disponibilidade nem indisponibilidade; catálogo para o agente
continua exigindo decisão própria.

O [runbook](../runbooks/vendedor-prioridades.md) distingue implementação local
e publicação sobre o export vivo Evolution. Não sobrescrever wrappers da
telemetria, guardrail, mídia ou abertura humana com o snapshot canônico.
Rollback usa a versão anterior efetivamente publicada, preservando ADR 056.
