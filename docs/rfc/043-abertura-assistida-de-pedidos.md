# RFC 043 — Abertura assistida de pedidos

Data: 03/11/2026. Status: aprovada pelo proprietário nesta conversa;
decidida na [ADR 056](../adr/056-abertura-de-pedido-com-confirmacao-humana.md).
Responsável: Tech Lead. Requisitos OA-01–12, tarefa OA-T01.

## Problema

A ADR 014 abre um pedido quando surge o primeiro dado da ficha. Uma pessoa
que pergunta por uma camiseta e depois descobre que o serviço desejado não é
atendido deixa um pendente numerado sem compra. Orçamento, espera e desistência
também não comprovam intenção de fechar. O proprietário solicitou interromper
essa criação e acompanhar inclusive o atendimento humano para sugerir o momento
adequado, sempre com decisão do vendedor.

## Proposta aprovada

O agente coleta na conversa. Uma análise interna procura confirmação explícita
de fechamento do cliente, considerando o contexto e as mensagens do vendedor.
Ela pode sugerir “Criar pedido?” com produto e mensagem de evidência. O responsável
ou administrador cria o pendente, adia ou recusa com motivo. Gerar e confirmar
comercialmente permanecem comandos separados. Pedido pago da loja segue seu
contrato específico.

Uma ramificação limitada do n8n analisa entradas também em atendimento humano,
sem responder ao cliente, consumir a reserva de envio ou retomar o bot.
O PostgreSQL do CRM guarda observações, sugestões e decisões. APIs autenticadas
mantêm a fronteira existente: n8n nunca acessa o banco do CRM.

A avaliação mede análises, falhas, sugestões, decisões, atrasos, criação humana
sem sugestão e omissões anotadas pelo vendedor. Ausência de sugestão não prova
ausência de intenção. Não apresentamos recall ou acurácia sem amostra rotulada.

## Alternativas

- Abrir por completude da ficha ainda produz pedidos de orçamento e desistência.
- Deixar o modelo abrir ao detectar compra preserva o risco de falso positivo.
- Analisar só enquanto o bot atende perde o fechamento negociado com o vendedor.
- Salvar execuções completas do n8n duplica dados pessoais; a retenção permanece
  `none`, com conteúdo necessário cifrado no CRM e agregados sem texto.
- Reutilizar tabelas de estágio/Negócio aposentado contraria a ADR 004.

## Rastreabilidade

- [Requisitos e aceite](../../.specs/features/order-assistance/spec.md).
- [Entrega OA-T01](../../.specs/features/order-assistance/tasks.md).
- [Operação e rollback](../runbooks/order-assistance.md).
- ADRs 006, 014, 015, 032 e 052; [ADR 056](../adr/056-abertura-de-pedido-com-confirmacao-humana.md).
- Issue/PR: vinculados na entrega GitHub desta mudança; nenhuma conversa real
  ou identificador de cliente é incluído no repositório público.
