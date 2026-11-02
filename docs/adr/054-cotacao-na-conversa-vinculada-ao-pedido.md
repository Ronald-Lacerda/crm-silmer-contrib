# ADR 054 — Cotação na conversa vinculada ao pedido

Data: 02/11/2026. Status: aceita pelo proprietário, que autorizou seguir com
a cotação dentro da conversa e vinculada ao pedido. Complementa a ADR 053 e
a [RFC 038](../rfc/038-frete-e-etiqueta-pelo-melhor-envio.md), somente nesta
fatia. Tarefa T139; requisitos MEVQ-01–08.

## Contexto e decisão

A conexão OAuth e a cotação administrativa já existem. A vendedora precisa
consultar frete durante o atendimento, identificar a qual pedido ele pertence
e aproveitar o resultado na resposta ao cliente.

O CRM reutiliza o módulo shipping e a conta conectada. A ação operacional
`shipping.quote` é separada de `shipping.manage`: conectar e desconectar a
conta continuam exclusivos do administrador. Cotar e escolher um serviço
exigem humano ativo, conversa aberta em atendimento humano e autorização de
responsável ou administrador. Assunto e Pedido são alvos explícitos e seu
vínculo é validado na API, inclusive depois da consulta remota.

A consulta informa CEPs, peso, dimensões e valor segurado. A tabela real de
peso por peça e as embalagens padrão não estão definidas; a entrega usa
entradas explícitas e não inventa estimativas físicas. O CEP na mensagem
oferece um atalho, sem inferir qual dos pedidos receberá o frete.

A API guarda o resultado do provedor e o contexto de origem cifrados no
PostgreSQL. A seleção aceita somente um serviço daquele resultado, nunca
preço informado pelo navegador. Autor, instante, quantidade e versão do
pedido acompanham a estimativa. Alteração do pedido ou das entradas exige
nova consulta; a checagem conservadora por versão também alcança a grade.
Comandos persistidos são idempotentes e auditados sem CEP ou corpo comercial.

A estimativa aparece na conversa e na página do pedido, separada do Valor
final. Não altera a ficha confirmada, total, pagamento ou status. A sugestão
de resposta vai apenas para o campo de composição, com revisão e envio
humanos e proteção de rascunho existente. A data da consulta é explícita e
não se promete validade de três dias enquanto D7 permanecer aberta.

## Alternativas e consequências

Dar a vendedores a capacidade de administrar a conexão ampliaria a
autorização além do atendimento. Aceitar preço enviado pelo navegador não
garantiria a origem da cotação. Um vínculo implícito com o primeiro pedido
da conversa seria ambíguo quando houver vários Assuntos.

Não há novo serviço, dependência ou infraestrutura. Persistir a estimativa
introduz dados comerciais cifrados no backup existente; chave de envelope e
recuperação seguem o runbook. A automação não cota nem envia frete. Compra,
etiqueta, Expedição, composição peças + frete, dados fiscais, forma de entrega
e decisões D1–D9 continuam fora desta autorização.

## Rastreabilidade

- [Contrato MEVQ-01–08](../../.specs/features/melhor-envio/spec.md).
- [Pedidos MVP / T139](../../.specs/features/pedidos-mvp/tasks.md).
- [RFC 038 / MEV-02–04 parciais](../rfc/038-frete-e-etiqueta-pelo-melhor-envio.md).
- [Runbook](../runbooks/melhor-envio.md).
- [PR de implementação #260](https://github.com/romulosutil/crm-silmer/pull/260),
  empilhada sobre a entrega documental #259. Sem issue específica prévia.
