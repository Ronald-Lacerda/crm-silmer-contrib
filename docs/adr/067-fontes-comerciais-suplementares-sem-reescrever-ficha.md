# ADR 067 — Fontes comerciais suplementares sem reescrever a ficha

Data: 05/11/2026. Status: decisão técnica adotada para implementar T26/T24,
no escopo já autorizado da ADR 057. Proposta: [RFC 054](../rfc/054-fontes-suplementares-para-olist.md).
Contrato: [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md),
OLIST-01, 06–12, 19, 29, 34–35 e 42–44. Tarefas T26/T24 no
[plano](../../.specs/features/crm-mvp/tasks.md). Sem issue/PR específica.
Complementa a ADR 057; não a supersede e não autoriza novo efeito ERP.

## Decisão

1. Revisões suplementares são append-only e cifradas no PostgreSQL existente,
   separadas de ficha_envelope e dos valores/pagamentos comerciais. Guardam
   revisão, autor/data, versão base e HMAC da composição da fonte. AAD inclui
   finalidade, Pedido e revisão; chave de digest deriva da chave existente por
   contexto próprio. Não publicar hash simples de cadastro pessoal.
2. A fonte inclui origem, itens/grade, total e comprador/produto da loja.
   Impressão, recibo e datas de quitação não alteram a identidade comercial.
   Uma mudança relevante exige rebase humano; revisões anteriores permanecem.
3. Inicialização legado emite IDs sem preços. Lote por identidade exige
   cobertura exata e, quando completo, soma igual ao total histórico. A linha
   única da loja usa o valor armazenado validado no checkout, nunca o catálogo
   atual ou o valor excedente pago. Nada é rateado ou inferido.
4. Complemento usa ACL comercial existente e comando dedicado; loja exige
   Admin ativo. Autoridade atual é verificada antes de replay e sob lock.
   Checkbox e perfil Financeiro não concedem edição comercial da loja.
5. Ordem de locks: usuário/função/grant, conversa quando existir, Pedido e
   revisão. Enriquecimento e reserva de exportação compartilham o lock de
   Pedido. Qualquer snapshot/efeito de venda ou cadastro ligado, em qualquer
   conta, bloqueia alteração incompatível; futuras transições também devem
   respeitar essa ordem.
6. Revisão, incremento da versão do Pedido, evento, auditoria e recibo
   idempotente compartilham o client transacional. Falha ao persistir qualquer
   parte desfaz o conjunto.
7. Leitura pode entregar uma projeção adaptada, sem persistir a combinação na
   ficha. Prova de preço legado para reconfirmação é interna, fresca, completa
   e igual ao total histórico; não aceita campo do navegador nem regrava o
   envelope original ao reabrir/reconfirmar esse contrato.

## Consequências

A alternativa de modificar ficha.sizePricing foi rejeitada porque mudaria
snapshot e acionaria o contrato monetário T21. O custo é uma tabela/revisão
aditiva e leituras de fontes; não há serviço, segredo ou infraestrutura nova.
Complementos obsoletos não são usados como válidos. A UI, a prévia, a conexão,
o sequenciamento externo e o piloto mantêm seus gates próprios.

[Runbook e validação](../runbooks/olist-phase3.md). Rollback preserva envelopes,
revisões e guardas T21; não remove dado histórico nem libera preço livre.
