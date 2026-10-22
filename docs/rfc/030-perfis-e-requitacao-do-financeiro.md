# RFC 030 — Perfis e nova quitação no Financeiro

Estado: decidido em 22/10/2026 pela [ADR 042](../adr/042-perfis-e-requitacao-do-financeiro.md).
Requisitos: [FINQ-17–19](../../.specs/features/financeiro/spec.md).
Tarefas: [FINQ-T01/T02/T05](../../.specs/features/financeiro/tasks.md).
Antecedente documental: [PR 214](https://github.com/romulosutil/crm-silmer/pull/214).

O PO autorizou a implementação do painel e pediu renomear Vendedores para
Usuários, com seleção Vendedor, Financeiro e Administrador. Na decisão
explícita sobre reconfirmar um pedido com outro valor, respondeu: “Sim,
exigir nova quitação e novo check”.

Adotar um seletor que traduz o perfil para função/capacidade existentes evita
criar uma terceira função Administrador e preserva o modelo ortogonal. Trocas
de perfil removem capacidades anteriores e revogam sessões. Não transferem
atendimentos existentes: o Admin continua podendo redistribuí-los.

Reconfirmar outro valor limpa o pagamento manual e invalida a conclusão
ativa, com evento próprio. Preservar a conclusão nesse caso confundiria a
revisão do preço anterior com a nova rotina. Reconfirmar o mesmo valor
preserva ambos; versões de impressão e entrega não invalidam o check.

Para o legado, preservar datas com uma marca de revisão pendente evita
concluir que sinais antigos eram quitação. A liberação exige declaração
explícita, inclusive quando a data não muda. Para loja, manter o pagamento
gateway da ADR 038 e invalidar o check quando a correção muda o valor.

Não há integração Olist, conciliação, parcelamento ou infraestrutura nova.
