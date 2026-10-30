# ADR 051 — Vendedor aprende com os atendentes humanos

Data: 29/10/2026. Status: aceita; itens aprovados pelo proprietário.
Proposta: [RFC 040](../rfc/040-vendedor-aprende-com-os-atendentes-humanos.md).
Requisitos: [AGT-01..05 e ORC-03](../../.specs/features/crm-mvp/spec.md);
[PRD-02, PRD-03 e PRD-06](../../.specs/features/pedidos-mvp/spec.md).
Tarefa: VND-L02 no [plano do MVP](../../.specs/features/crm-mvp/tasks.md).
Supersede a ADR 009 no item 4 (preço) e a ADR 024 no item 3 quanto a origem
da arte e tecido. Complementa as ADRs 012, 013, 026 e 049.

## Decisão

1. **Preço adiado na primeira pergunta.** A AGT-04 manda transferir quando o
   cliente insiste. Na primeira pergunta de preço, frete ou pagamento o bot
   responde que o vendedor passa o valor e faz a próxima pergunta da ficha.
   A segunda transfere com `negotiation`. Se a ficha completar antes, o
   motivo é `briefing_complete` e o resumo diz "Perguntou o valor.". O estado
   fica em `briefing_status` (marcador `price_`), sem chave nova no briefing;
   sem pedido aberto, o histórico serve de reserva. Nenhum valor sai do bot.
2. **Arte perguntada.** `artwork_status` entra no ritmo com "Você já tem a
   arte (ou logo) pronta?", sem oferecer criação (PRD-03). O bot grava só
   "cliente envia a arte", "Silmer cria a arte" (quando o cliente pede) ou
   "sem estampa", frases que a Ficha já lê. "Não tenho" e respostas evasivas
   gravam "Definir com o vendedor", com nota e Dica. Foto de referência não é
   arte do cliente.
3. **Tecido perguntado.** `fabrics` entra no ritmo só para roupa sem kit que
   o defina, com algodão, poliéster ou dry fit. O tecido já dito é gravado com
   as palavras do cliente, abaixo de 200 caracteres. Respostas evasivas gravam
   "Definir com o vendedor". Ordem: produto, modelo, cor, quantidade, tecido,
   onde vai a estampa, arte, prazo. "Ficha: X de N" passa a 9 para roupa, 8
   para boné, bolsa ou bandeira e 7 para outro produto. O teto de 15 mensagens
   continua.
4. **Imagem não é falha.** Imagem, lida ou não, recebe "Recebi sua imagem, já
   deixei aqui para o vendedor ver." e a próxima pergunta, e nunca conta como
   tentativa falha nem pergunta ignorada. Áudio que não abre continua pedindo
   texto.
5. **Rajada agrupada.** Depois de registrar o inbound, o workflow espera 8 s e
   reenvia o mesmo inbound ao CRM, que devolve o estado atual sem efeito novo.
   Só segue se nenhuma mensagem nova chegou; a execução mais nova responde a
   todas as mensagens desde a última resposta. A confirmação do evento ao
   provedor continua antes da espera.
6. **Urgência pelo prazo.** Ficha completa com prazo hoje ou amanhã, em
   Brasília, transfere com `urgency` e o prazo no resumo.
7. **Parceria e revenda.** Pedido de parceria, revenda, atacado, nota fiscal,
   envio direto ao cliente final ou fotos das peças transfere com
   `human_requested`, aviso "Anotei suas perguntas…" e resumo com as perguntas
   em tópicos e a Dica "Possível parceria/revenda". Perfil de compra só com
   palavra explícita do cliente.
8. **Tom.** Sem elogio à escolha do cliente e sem repetir erro de digitação.
   O nó de decisão remove os elogios e mantém a pergunta.
9. **Perto do fechamento.** O aviso de horário da ADR 049 vale também nos
   últimos 30 minutos do expediente (segunda a sexta 17h30, sábado 11h30).

O pedido mínimo ficou fora: a regra variou nas conversas e depende do
proprietário.

## Consequências

- Nenhuma mudança no CRM: chaves de briefing e motivos de handoff já aceitos.
- Com arte e tecido preenchidos pelo bot, os bloqueios desses campos somem da
  Ficha. Gerar o Pedido continua exigindo entrega, valor e condição digitados
  por pessoa, e o vendedor corrige depois do handoff.
- O resumo do handoff (Dica, perguntas, "Ficha: X de N") ainda não aparece na
  tela da Inbox; exibi-lo é tarefa separada do CRM.
- Toda resposta do bot ganha cerca de 8 s de latência.
- Falsos positivos conhecidos: "Sim" sozinho na pergunta da arte vira
  "cliente envia a arte"; "loja" ou "fotos das peças" podem disparar
  parceria; prazo lido pela última data dd/mm.
- A mudança só vale em produção depois da publicação no n8n com backup e
  verificação (ADR 044).
