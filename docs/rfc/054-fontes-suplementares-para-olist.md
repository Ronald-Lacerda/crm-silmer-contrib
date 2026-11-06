# RFC 054 — Fontes suplementares para legado e loja no Olist

Data: 05/11/2026. Decisão técnica na [ADR 067](../adr/067-fontes-comerciais-suplementares-sem-reescrever-ficha.md).
Continuação autorizada de T26/T24 da [RFC 050](050-geracao-assistida-de-pedidos-no-olist.md)
e [ADR 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md).
Requisitos OLIST-01, 06–12, 19, 29, 34–35, 42–44. Sem issue/PR específica.

## Problema e alternativas

Legado não contém subtotais; a loja também carece de aplicação, previsão e
cadastro fiscal estruturado. Escrever esses campos em ficha.sizePricing
mudaria o envelope histórico e faria T21 tratar o suplemento como valor
comercial editável. Repartir total ou consultar catálogo atual inventaria a
composição histórica. Rejeitamos ambas as alternativas.

## Proposta adotada

Guardar revisões cifradas append-only fora da ficha, com IDs emitidos pelo
servidor, autor/data, versão de Pedido e HMAC da fonte comercial. O comando
humano dedicado usa ACL comercial, versão e idempotência; o checkbox Olist
não concede correção comercial. Na loja, o complemento exige Admin ativo.

O lote legado identifica todas as linhas persistidas e soma exatamente o
total preservado; não importa grade, flags de revisão ou total independente.
A loja usa o valor validado de sua única linha do snapshot, sem dividir nem
consultar catálogo atual. Complementos fiscais/previsão/aplicação continuam
explícitos, com pendências por campo em vez de dados inventados.

O mesmo client PostgreSQL deve escrever revisão, versão, evento, auditoria e
recibo. Uma reserva/efeito Olist em qualquer conta impede enriquecimento
incompatível. Mudança comercial invalida a fonte; rebase humano explícito
emite novas identidades e mantém as revisões anteriores.

## Evidência e operação

[Runbook](../runbooks/olist-phase3.md), OpenAPI e tarefas registram o estado
real de cada entrega. T26/T24 não liberam envio, piloto ou rollout sem a UI e
os demais gates. Rollback preserva tabelas e bloqueia mutações se a API antiga
não garantir T21; jamais recupera preço livre.
