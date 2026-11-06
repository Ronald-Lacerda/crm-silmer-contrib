# RFC 051 — Triagem prioritária sem inferir regras comerciais

Status: decidida em 06/11/2026 na [ADR 063](../adr/063-triagem-prioritaria-do-vendedor.md).
Autorização: solicitação do proprietário para implementar as prioridades da
revisão da Inbox, preservando as regras comerciais e suas exceções.
Requisitos: AGT-01–05/08, ORC-03/05/07; tarefa VND-L05 no
[plano](../../.specs/features/crm-mvp/tasks.md).

## Problema e proposta

A revisão de 53 históricos das 58 conversas exibidas encontrou dúvidas sobre
mínimo e viabilidade seguidas de coleta longa, prazo urgente retido por campos
faltantes e alternativas de orçamento tratadas como quantidade escolhida.
Cinco testes foram excluídos pela lista e quatro pelos históricos; 49 conversas
sem identificação de teste orientaram a análise qualitativa. Não há cópia de
conversas, identificadores ou dados pessoais neste documento ou nas fixtures.
Essa amostra não mede conversão ou acurácia do modelo.

Encaminhar a dúvida comercial para uma pessoa, antecipar urgência inequívoca,
preservar alternativas como notas e impedir perguntas de campos preenchidos.
Não construir catálogo ou política de mínimo/preço a partir das respostas de
um atendimento. Detalhes e limites estão na ADR 063.

## Alternativas

- Apenas reforçar o prompt: insuficiente para erros já observados; acrescentar
  proteções determinísticas no normalizador e testes dos nós reais.
- Fixar mínimo de dez ou excluir modelos citados na amostra: rejeitado;
  as conversas contêm condições e exceções que não são regras gerais.
- Publicar o snapshot canônico sobre o Evolution: rejeitado; somente delta
  revisado, com backup e preservação de mídia, abertura humana e telemetria.

Referências: ADRs 049/051/052/056 e
[revisão VND-L04](../integrations/n8n/revisao-2026-11-03.md).
