# ADR 073 — Comprador no vínculo histórico com telefone divergente

Data: 09/11/2026. Status: adotada para OLIST-T16.
Proposta: [RFC 057](../rfc/057-comprador-no-vinculo-historico-com-telefone-divergente.md).
Rastreabilidade: RFC 050, OLIST-T16, OLIST-16–20 e 30–32; [PR 330](https://github.com/romulosutil/crm-silmer/pull/330).
Complementa as ADRs 071/072 somente na conferência humana de venda histórica.

## Decisão

O vínculo isolado de uma venda histórica explicitamente selecionada pode
aceitar telefone diferente quando o nome normalizado é exato e o comprador
remoto está ativo (A/B). Seu ID vem exclusivamente da própria venda. A prévia
avisa a divergência e a confirmação já existente declara que o vínculo vale
somente para essa venda. Não acrescentar campos à rotina de novos envios.

Congelar uma prova própria `legacyBuyerProof`, com IDs e hashes das identidades,
por conta e venda; não produzir `buyerSource=erp-existing-v1`. Releitura e
comparação da prova continuam obrigatórias na confirmação, replay e
reconferência. O recibo com validade, revisão, sessão e motivo preserva o
consentimento específico; prova privada não é input livre do navegador.

Nenhum dado de Contato é copiado ou alterado. Não criar vínculo compartilhado
de cliente/produto, job criador ou POST no ERP. Preservar os demais controles
de valores, itens, datas, identidade da venda, NF e efeitos financeiros.
Novos envios continuam exigindo a correspondência única de nome e telefone;
a exceção histórica nunca autoriza reutilização automática do comprador.

## Motivo e limite

Os cadastros dos sistemas podem conter telefones diferentes. Exigir a cópia
fiscal ou a alteração de um deles apenas para registrar uma venda já existente
expande o fluxo pedido pelo proprietário. A conferência humana explícita,
restrita à venda e protegida por prova imutável, evita essa duplicação sem
transformar nome isolado em identificação automática para novas vendas.
