# Protótipo do resumo operacional

## Problem Statement

A central tem explicações longas e não apresenta os sinais operacionais já
calculados pela API. OPS-HEALTH-UI01 organiza a leitura sem mudar o design.
Protótipo local para revisão, sem PR, merge ou deploy nesta entrega.

## Out of Scope

Polling, SSE para saúde, novos endpoints, mudanças em triagem ou permissões,
nova infraestrutura, novos tokens de marca e expansão dos sinais disponíveis.

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale |
| --- | --- | --- |
| Visual | Shell, Poppins e tokens existentes | Pedido explícito |
| Conteúdo | Estado, três sinais e instante em uma superfície; orientação só quando necessário | Reduzir ruído |
| Atualização | Mount e botão Atualizar, em paralelo à consulta de incidentes | Sem carga automática adicional |
| Precisão | Estado se refere à última consulta; snapshot válido por 120s na leitura | Não prometer monitoramento em tempo real |
| Falha | Mostrar indisponível, sem esconder incidentes ou exibir verde antigo | Diagnóstico independente |

Open questions: none.

## User Stories

Como operador, quero reconhecer o estado da operação e saber onde investigar,
mantendo os registros e ações existentes acessíveis.

Acceptance Criteria:
1. WHEN a central é aberta ou Atualizar é acionado THEN a UI SHALL ler o resumo uma vez; filtros, triagem, eventos e passagem do tempo SHALL não gerar leituras de saúde.
2. WHEN o resumo válido chega THEN a UI SHALL apresentar estado, worker, fila, comandos e instante de São Paulo; 503 com corpo válido degradado SHALL preservar os sinais; dados vencidos, malformados, indisponíveis ou falha de rede SHALL nunca mostrar estado saudável.
3. WHEN a sessão perde acesso ou a página é abandonada THEN a UI SHALL remover o resumo e cancelar requisições; falha isolada da saúde SHALL preservar consulta/triagem de incidentes e foco.
4. WHEN o operador usa teclado ou viewport de 390px THEN a UI SHALL manter rótulos, contraste e conteúdo sem overflow; explicações secundárias SHALL ficar sob divulgação progressiva, com tokens e identidade atuais.

## Requirement Traceability

| ID | Critério | Tarefa | Status |
| --- | --- | --- | --- |
| OPSUI-01 | Atualização somente explícita | OPS-HEALTH-UI01 | verified |
| OPSUI-02 | Estados honestos e orientação | OPS-HEALTH-UI01 | verified |
| OPSUI-03 | ACL, aborto e isolamento | OPS-HEALTH-UI01 | verified |
| OPSUI-04 | Design compacto e acessível | OPS-HEALTH-UI01 | verified |

## Plano

Uma entrega atômica: helper de apresentação, view e CSS atuais, fixtures e
testes de estados/interações; capturas desktop/mobile com dados sintéticos.
Gate: testes de helper, E2E/axe da central, format/tipos/lint/tokens/build,
diff check e revisão independente. Branch codex/health-summary-prototype.

## Evidências da entrega

- npm run validate: aprovado; 1755 testes passaram, 16 condicionais ignorados, build concluído.
- E2E da central: 20 testes passaram, incluindo teclado, axe, cancelamento e atualização explícita.
- Helper: 3 testes passaram; revisão independente e sensor registrados em validation.md.
- Capturas sintéticas desktop, mobile (390px) e estado degradado em var/health-summary-*.png.
- Sem mudanças no backend, polling ou publicação em produção.

## Correção do gate do PR — OPS-HEALTH-UI02

O CI do PR 303 revelou um defeito preexistente em ACT-12: o teste PostgreSQL
do dashboard usava fixture de 05/11/2026, mas a composição de pedidos lia Date
real para a entrega. Fixar apenas Date no escopo desse teste mantém as
asserções de data, concorrência, replay e autorização sem alterar produção.
Gate: mesma falha reproduzida em PostgreSQL 17 dedicado antes da correção;
mesmo teste aprovado após a correção (1 teste, sem skips). CI completo exigido
antes do merge.
