# RFC 056 — Envio simples da ficha com cadastros no Olist

Data: 09/11/2026. Decisão na [ADR 072](../adr/072-envio-em-aberto-sem-duplicar-cadastros-do-erp.md).
Continua a [RFC 050](050-geracao-assistida-de-pedidos-no-olist.md), OLIST-T15–T17,
e revê a rotina de preenchimento proposta na [RFC 055](055-vencimento-por-pedido-e-vinculo-historico-no-olist.md).

## Diretriz do proprietário

O Olist continua independente, recebendo a ficha do pedido. Quanto menos
ações no CRM, melhor. O proprietário questionou a cópia do cadastro fiscal do
comprador e não autorizou essa importação. A alternativa anteriormente dada
para fiscal era deixar em aberto ou preencher na hora; adota-se o envio em
aberto para eliminar campos adicionais na rotina do CRM.

## Fluxo proposto

“Revisar envio” consulta e valida a prévia; o diálogo apresenta a ficha
comercial completa. “Enviar para o Olist” é a confirmação que autoriza o
comando. Sem campos fiscais adicionais, escolha manual de ID ou botão separado
de validação. Falhas e resultados incertos não oferecem repetição cega.

Quando falta cadastro fiscal no CRM, procurar o comprador já existente no
ERP por nome e telefone exatos e normalizados. A busca deve ser completa,
limitada e sem ambiguidade. Congelar referência e identidade mínima cifrada,
com HMAC por conta; reler o comprador antes de cada efeito. Não gravar
endereço, CNPJ/IE ou cadastro de contato no CRM, nem criar/editar o comprador
nesse modo. A venda histórica usa diretamente seu comprador remoto, com a
mesma conferência mínima. A [RFC 057](057-comprador-no-vinculo-historico-com-telefone-divergente.md) / ADR 073 acrescenta a exceção humana exclusiva da venda selecionada quando há telefone divergente, sem referência reutilizável. O caminho anterior com dados completos do CRM
continua isolado e não vira fallback após uma busca inconclusiva.

Na política `paymentDuePolicy=erp`, não enviar objeto de pagamento ou
parcelas. Rose ajusta vencimento no ERP. A condição da ficha pode ir apenas
em frase fixa de uma enumeração aprovada, nunca em notas livres ou conversa.
Cadastro fiscal central ausente gera `productFiscalDeferred=true`, vinculado
ao recibo/snapshot; omitir toda a tripla fiscal opcional no produto, sem
inventar classificação ou flag de “produto rascunho”. O pedido segue situação
0 e não aciona comandos de NF, estoque, recebimento ou baixa.

## Evidência e limites

O schema oficial exige SKU, tipo e descrição; o pai com variações conserva
grade e variações. NCM, origem e unidade são opcionais no request; omissão
parcial é recusada pelo adapter. A criação sem a tripla fiscal ainda exige
observação do primeiro caso na conta real; schema não comprova aceitação.
Pedido API anterior comprovou inclusão sem pagamento. Identidade, dinheiro
por linha, autorização, reservas, idempotência e recuperação permanecem gates.
