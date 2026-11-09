# ADR 071 — Vencimento explícito e vínculo histórico isolado no Olist

Data: 09/11/2026. Status: decisão técnica adotada para concluir OLIST-T15–T17.
Decisor técnico: Tech Lead. Regra comercial de vencimento: proprietário,
explicitamente no chat. Proposta: [RFC 055](../rfc/055-vencimento-por-pedido-e-vinculo-historico-no-olist.md).
Requisitos OLIST-12, 17–20, 25, 30–32 da [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Complementa as ADRs 057, 062 e 067; não altera a precisão monetária aprovada.

## Contexto e decisão

O vencimento informado pela operadora pertence à revisão do pedido enviada ao
ERP. A política central pode exigir `per_order`; configurações antigas seguem
`fixed_date`. A data explícita, validada como dia de calendário, fica congelada
na prévia cifrada e na assinatura comercial. Nenhum relógio, forma de pagamento
ou texto livre calcula esse prazo. Alterar a data exige nova prévia; o comando
de exportação continua recebendo somente seu token.

Na ausência de cadastro fiscal central, a decisão explícita do proprietário
permite à operadora informar NCM, origem e unidade na prévia. Os campos ficam
vazios até a declaração humana e seguem o validador estrito existente; todos
os itens daquela prévia usam a mesma classificação. O valor fica cifrado e
assinado, sem alterar os parâmetros centrais ou o ERP. Não substitui uma
política central já existente nem permite mudar o cadastro no check/export.
Enquanto incompleto, o pedido permanece no CRM e nenhuma inclusão é autorizada.

Uma venda antiga pode comprovar correspondência histórica sem comprovar a
identidade canônica de produtos para novos pedidos. O modo administrativo
`legacy-sale-only-v1` guarda essa correspondência isoladamente, com IDs e
posição de cada item, valores exatos, releitura e declaração humana auditada
dos atributos livres. Não registra `olist_resources` ou
`olist_export_resources`, não agenda despacho e não resolve tentativas incertas.
Os parâmetros de criação atuais não representam a configuração de uma venda
manual passada. Origem, ordem de compra, vencimento e campos fiscais observados
ficam como metadados históricos cifrados, apresentados ao administrador e
reconsultados antes do commit. Ausência de NCM/unidade não comprova classificação
fiscal e permanece explícita; nenhum cadastro, fiscal ou comercial, pode ser
reutilizado na geração automática por esse vínculo.
O vínculo continua bloqueando uma nova exportação daquele pedido e a captura
da mesma venda por outro pedido.

## Alternativas rejeitadas e consequências

Inferir o vencimento de “Pix” ou usar a data da venda inventaria regra comercial.
Mudar produtos históricos no ERP, aceitar nome como identidade ou publicar uma
equivalência canônica enfraqueceria a deduplicação. Essas alternativas foram
rejeitadas. O caminho novo exige mais conferência administrativa, deliberadamente
restrita ao legado, e preserva todos os caminhos automáticos estritos.

Rollback desliga criação e preserva os envelopes e o vínculo histórico. Código
anterior não deve operar um vínculo marcado com modo desconhecido. Testes e
evidência operacional ficam no [runbook](../runbooks/olist-phase6.md); implantação
não equivale a aceite ou ampliação do piloto.
