# ADR 049 — Aprendizados do Vendedor na Inbox real

Data: 28/10/2026. Status: aceita; itens aprovados pelo proprietário.
Proposta: [RFC 037](../rfc/037-aprendizados-do-vendedor-na-inbox-real.md).
Requisitos: [AGT-01..08, ORC-03 e CHAN-WA-01](../../.specs/features/crm-mvp/spec.md).
Tarefa: VND-L01 no [plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Complementa as ADRs 012, 024, 025 e 044; não as supersede.

## Decisão

1. **Pergunta do cliente primeiro.** Pergunta de viabilidade ou de fidelidade
   à referência recebe "Vou anotar para o vendedor confirmar isso." antes da
   próxima pergunta da ficha. Continua proibido responder sim ou não. O nó de
   decisão acrescenta o reconhecimento quando o modelo esquece.
2. **Modelo livre.** Resposta fora da lista de modelos é "outro" com as
   palavras do cliente. Camisa de futebol, futsal, vôlei, basquete, handebol,
   e-sports, esportiva e jersey são modelos de roupa. A mesma pergunta nunca
   se repete com as mesmas palavras. Sublimação total é só Dica ao vendedor.
3. **Referência do site.** A mensagem pronta "Vi no site a referência X e
   quero algo parecido" vira nota "Referência do site: X", é pedido do zero e
   nunca conta como pergunta ignorada. Como primeira mensagem, ela não abre
   Pedido (ADR 014) e fica só no histórico.
4. **Bandeira.** Bandeira, faixa, banner, estandarte e flâmula são um tipo
   próprio. O ponto de modelo pergunta o tamanho e o grava em `product_model`
   com o nome do produto ("bandeira 1 x 1,5 m"). Na Ficha o tamanho aparece em
   `items[].tipo`, coberto por teste que usa a projeção real do CRM. A estampa
   pergunta "de um lado só ou dos dois lados"; a gola é `NAO APLICAVEL`.
5. **Datas relativas.** O contexto informa a data de hoje em Brasília, pela
   hora da mensagem. `needed_by` guarda as palavras do cliente e a data
   calculada ("quarta-feira (04/11/2026)"). Data ambígua é confirmada uma
   única vez antes da transferência. Prazo continua sendo desejo do cliente.
6. **Cliente empresa.** Apresentação com marcador explícito de organização
   grava a empresa em `order_name`, se vazio, e uma Dica ao vendedor. Perfil
   de compra nunca é deduzido. Não há transferência antecipada.
7. **Fora do horário.** Toda mensagem de transferência enviada fora do horário
   comercial (segunda a sexta 9h–18h, sábado 9h–12h, horário de Brasília)
   informa o horário e quando o vendedor responde ("amanhã às 9h", "segunda-
   feira às 9h"). O horário espelha `business.ts` do site; feriados não são
   cobertos.
8. **Quantidade do item único.** Sem divisão por público e com um único
   produto, a quantidade dita sem dúvida ("18", "18 coletes") também preenche
   `quantidade_informada` do item. A grade continua obrigatória e o total de
   peças continua sendo a soma das grades (ADR 025, D4). `serviceData.quantity`
   preserva as palavras do cliente.

## Consequências

Os filtros são defesa adicional e não provam cobertura de toda paráfrase.
Falsos positivos conhecidos: "faixa" como produto e respostas soltas como
"jogo" ao perguntar o modelo. O fuso é UTC−3 fixo; se o horário de verão
voltar, a constante deve ser revista. A mudança do workflow está no
repositório e só vale em produção após publicação no n8n com backup e
verificação, conforme a ADR 044.
