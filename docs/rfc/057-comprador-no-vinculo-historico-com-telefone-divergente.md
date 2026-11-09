# RFC 057 — Comprador no vínculo histórico com telefone divergente

Data: 09/11/2026. Decisão na [ADR 073](../adr/073-comprador-no-vinculo-historico-com-telefone-divergente.md).
Complementa a [RFC 056](056-envio-simples-da-ficha-com-cadastros-no-olist.md),
OLIST-T16; [PR 330](https://github.com/romulosutil/crm-silmer/pull/330).

A venda antiga selecionada pode ter o mesmo comprador comercial com telefone
diferente do Contato do CRM. Não importar cadastro fiscal nem corrigir telefone
por suposição. Propor confirmação explícita no vínculo histórico já existente,
com aviso de divergência, nome exato e comprador ativo derivado da própria
venda. Usar prova privada própria por conta/venda, congelada no recibo e relida
na confirmação, replay e reconferência. Nunca produzir referência reutilizável
para novos envios, recurso compartilhado, job criador ou escrita no ERP.

Projeção pública restrita:
`buyerReview={mode:'legacy-sale-buyer-review-v1',phoneMismatch:true,reusable:false,code:'OLIST_LEGACY_BUYER_PHONE_MISMATCH'}`.
O recibo e a confirmação/motivo existentes autorizam somente essa associação.
A rotina de dois gestos e a correspondência automática nome+telefone de novos
pedidos permanecem iguais. Nenhum telefone ou documento aparece no alerta.
