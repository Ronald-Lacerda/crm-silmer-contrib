# RFC 059 — Retirada local de vínculo histórico no Olist

Data: 09/11/2026. Decisão na [ADR 075](../adr/075-retirada-local-de-vinculo-historico-sem-liberar-duplicata.md).
Complementa as RFCs 050/055–057, OLIST-T16/T17; [PR 332](https://github.com/romulosutil/crm-silmer/pull/332).

Quando a operação reserva a conferência histórica à operadora, deve ser
possível retirar uma associação local legada sem apagar auditoria ou permitir
criação duplicada no ERP. Uma invalidação comum é inadequada, pois libera uma
nova geração e não admite venda remota já observada.

Propor um ramo estrito do comando administrativo existente: somente vínculo
legado isolado, sem recursos, tentativas, jobs ou leituras em andamento. Exigir
concordância dos modos e conservar IDs remotos e evidências. O estado terminal
`legacy_review_required` mantém unicidade e todos os bloqueios do pedido que
já tem venda conhecida. Replays e reconciliação não podem reativar o vínculo.
Novos pedidos e as permissões existentes permanecem iguais. A operação não
altera o ERP; o motivo e a retirada ficam auditados com sessão, versão e recibo.
