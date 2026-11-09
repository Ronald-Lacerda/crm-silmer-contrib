# Preparação técnica de produção

## Execution Plan

Uma entrega atômica prepara os candidatos, confere o ambiente e corrige a
compatibilidade do patch offline. Revisão independente encerra a etapa.

## Test Coverage Matrix

| Task | Criteria    | Evidence                                                                                         |
| ---- | ----------- | ------------------------------------------------------------------------------------------------ |
| T1   | PPREP-01–04 | exports privados persistidos, consoles read-only, health, regressão do patch e relatório técnico |

## Gate Check Commands

- Preparation: testes billing-send-workflow/integration-workflow/development-check, typecheck, lint, prettier e git diff check; revisão de exports e diagnóstico sem segredos.

## Task Breakdown

### T1: Preparar produção com emissão e envio desligados (COB-OPS-PREP-02)

Depends on: none
Where: ops/n8n/billing-send-preflight.mjs
Tests: PPREP-01–04, regressão sintética para GET omitido, preservação/idempotência/recusa, export persistido e inspeção read-only de flags/migrações.
Gate: Preparation
Done when: candidatos inativos preparados e conferidos, diagnóstico distingue pendências de implantação e não executa pagamento/envio real.
Status: Complete

Dois workflows financeiros salvos inativos na instância remota e reexportados;
retenção de payload desligada explicitamente. Patch offline do atendimento
preserva141 nós e acrescenta3 guardas; não foi aplicado ao publicado. API e
worker sem flags/URLs de cobrança; banco sem0063–0065 e imagem worker sem
esses arquivos. Health200 não encerra go-live. Evidências no relatório técnico;
verificação independente em validation.md após commit desta entrega.
