# RFC 055 — Vencimento por pedido e vínculo histórico no Olist

Data: 09/11/2026. Decisão técnica na [ADR 071](../adr/071-vencimento-explicito-e-vinculo-historico-isolado-no-olist.md).
Complementa a [RFC 050](050-geracao-assistida-de-pedidos-no-olist.md), OLIST-12,
17–20, 25, 30–32 e tarefas OLIST-T15–T17. Origem: validação real da fase 6,
sem registrar identidades ou conteúdo privado. Entrega de catálogos relacionada:
[PR 327](https://github.com/romulosutil/crm-silmer/pull/327).

## Problemas observados

O proprietário definiu no chat que a operadora informa o vencimento em cada
pedido. Uma data central fixa não expressa essa regra. Texto como “Pix” ou
“na entrega” não autoriza inferir datas.

O proprietário também determinou preservar a configuração do ERP e deixar o
cadastro fiscal para preenchimento humano na hora. Quando a política fiscal
central está ausente, a operadora pode informar NCM, origem e unidade na prévia;
os campos começam vazios e a geração permanece pendente até a validação. Não
existe produto “rascunho” presumido nem classificação fiscal inventada.

A venda histórica escolhida para T16 contém produtos com SKU vazio e descrição
livre. O vínculo canônico os recusa corretamente, pois não demonstram a
identidade comercial dos cadastros automáticos. Alterar o ERP ou relaxar a
identidade compartilhada contaminaria pedidos futuros.

## Proposta adotada

- Política central explícita `fixed_date` ou `per_order`; ausência preserva o
  comportamento anterior. Em `per_order`, a data vem no comando de prévia,
  validada e congelada no snapshot cifrado e no vínculo da prévia. Conferência,
  exportação e replay usam esse valor; exportar não permite trocá-lo.
- Cadastro fiscal explícito na prévia somente se a política central estiver
  ausente. Validação existente, cifra e assinatura congelam os três campos; não
  podem ser substituídos no check/export ou sobrescrever política central atual.
  O mesmo cadastro vale para todos os itens daquela prévia.
- Trilha administrativa separada `legacy-sale-only-v1`, com seleção explícita
  de IDs de pai, filho e posição de cada item remoto. Cliente, parentesco,
  tamanho, quantidade, datas comerciais, unitário, subtotais e totais continuam
  conferidos. Os atributos não codificados no ERP exigem declaração humana e
  motivo. Origem, ordem de compra, vencimento e fiscal são metadados históricos
  observados, apresentados na revisão e congelados sem substituir os parâmetros
  de novas vendas. Fiscal vazio permanece ausente, sem classificação inventada.
- Releitura remota antes do commit, recibo vinculado à sessão, versões e fontes
  atuais, idempotência e unicidade da venda. O vínculo não publica nenhum
  cadastro compartilhado nem reserva efeito ou job. Não é reconciliação de
  tentativa incerta e não aceita substituição automática do caminho canônico.

## Aceite

Testar data ausente/inválida, troca depois da prévia, replay e payload/readback;
no legado, cobertura integral 1:1 de itens e linhas, rejeição de ambiguidades,
diferenças comerciais, mudança nos metadados observados e concorrência. Comprovar zero POSTs criadores e
zero inserções em recursos/tentativas/jobs. UI por teclado, foco e axe.
O [runbook](../runbooks/olist-phase6.md) mantém evidência local e real separadas.
Esta decisão não fecha os gates de backup, T16 ou T17 por si só.
