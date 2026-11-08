# Atualização e protótipo de cobranças

## Execution Plan

T1 integra a master. T2 e T3 podem ocorrer em paralelo depois da integração.
Nova branch com histórico linear preserva a branch anterior já publicada.

## Test Coverage Matrix

| Tarefa | Critérios     | Evidência                                                        |
| ------ | ------------- | ---------------------------------------------------------------- |
| T1     | REFRESH-01    | ancestralidade, typecheck/lint/build, regressão API e PostgreSQL |
| T2     | REFRESH-02–05 | interação, teclado, responsividade, captura visual e axe         |
| T3     | REFRESH-06    | diagrama conferido contra contratos e código atual               |

## Gate Check Commands

- Integration: `npm run validate` e suítes PostgreSQL sintéticas afetadas.
- Prototype: teste navegador com fixtures locais, axe e `git diff --check`.
- Diagram: conferência de vínculos, semântica e `git diff --check`.

## Task Breakdown

### T1: Atualizar a worktree com a master

Depends on: none
Where: apps/api/src/server.js
Tests: preservação das rotas atuais e de billingChat; suíte financeira e cenários de transporte existentes; ancestralidade da master e ausência de conflitos.
Gate: Integration
Done when: master integrada em histórico linear, conflitos resolvidos e gates aprovados, sem habilitar envios reais.
Status: Complete

Base `origin/master` 15edc73b, branch `codex/billing-chat-current-inbox`.
Branch publicada anterior preservada. Conflitos resolvidos, ADR de cobrança
renumerada para 066 e RFC financeira alinhada à 049 sem alterar decisões da
master. Aplicação Vue da Inbox coincide com a master; protótipo é isolado.
Gate: validate 1.992 aprovados/24 skips condicionais, build aprovado e 79
cenários PostgreSQL sintéticos. Gerador histórico n8n preservado byte a byte;
patch de cobrança continua explícito e offline. Nenhuma flag real habilitada.

### T2: Prototipar cobrança no chat atual

Depends on: T1
Where: docs/prototypes/
Tests: botão abre revisão no chat; gerar/enviar, saldo, correção e histórico; foco, Escape, preservação do rascunho, mobile e axe.
Gate: Prototype
Done when: protótipo local avaliável reutiliza design atual e fixtures isoladas, sem integrar efeitos reais.
Status: Pending

### T3: Mostrar o funcionamento da InfinitePay

Depends on: T1
Where: docs/diagrams/order-billing-infinitepay.md
Tests: conferência do fluxo contra API, outboxes, workflow e callbacks; separar transporte e pagamento.
Gate: Diagram
Done when: diagrama disponível no projeto e apresentado ao usuário, com limites de ativação claros.
Status: Complete

Diagrama em `docs/diagrams/order-billing-infinitepay.md`, preparado para
exibição em Mermaid. Fluxo e recuperação conferidos contra os serviços,
guardas e workflows locais: geração, transporte e pagamento separados;
saldo/correção conservam histórico e recebimentos. Flags reais desligadas.
