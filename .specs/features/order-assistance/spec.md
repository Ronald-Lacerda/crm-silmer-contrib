# Abertura assistida de pedidos — OA-01–12

Decisão de 03/11/2026: [RFC 043](../../../docs/rfc/043-abertura-assistida-de-pedidos.md)
e [ADR 056](../../../docs/adr/056-abertura-de-pedido-com-confirmacao-humana.md).
Supersede abertura automática de INB-02 / PAB-01–03; preserva o restante dos
contratos de Pedidos, Assuntos, reserva de envio e atendimento humano.

| ID | Critério de aceite |
| --- | --- |
| OA-01 | API publicada não cria Pedido de atendimento por `open_order` ou `order.intent_confirmed`, mesmo de workflow antigo. Coleta mantém a pré-ficha na conversa, sem reservar número. Loja paga preserva sua exceção. |
| OA-02 | Análise observa entradas com bot ou humano e considera histórico cliente/vendedor. Não envia mensagem, não reserva envio, não muda modo nem devolve atendimento ao bot. |
| OA-03 | Confirmação explícita de fechamento do cliente pode originar sugestão interna com produto e mensagem de evidência. Produto isolado, orçamento, preço, espera, desistência, serviço não atendido, fala apenas do vendedor ou alvo ambíguo não criam pedido. |
| OA-04 | Sugestões são idempotentes por evidência, não repetem alerta recusado/adiado sem nova evidência e têm histórico. Mensagem de outro contato/conversa não é evidência válida. |
| OA-05 | Responsável ou administrador humano escolhe Criar pedido, Ainda não ou Não vai seguir. Adiar/recusar exige motivo de lista fechada. Leitura não concede decisão. |
| OA-06 | Aceite usa versão da sugestão, versão da conversa, epoch, revisão e alvo válidos; pedido/decisão/auditoria são transacionais. Retry e concorrência não criam dois pedidos. Atualização obsoleta retorna conflito revisável. |
| OA-07 | Pedido criado nasce pendente, numerado, com pré-ficha da conversa/alvo correto. Preserva escolhas humanas existentes; revisão/geração comercial continuam separadas. Mais de um assunto sem alvo inequívoco exige correção. |
| OA-08 | Vendedor pode registrar Já deveria ter sugerido apontando mensagem do cliente, mesmo sem sugestão. Isso não cria pedido nem representa avaliação automática de venda perdida. |
| OA-09 | Timeout/parser/falha de análise são observáveis sem impedir o atendimento. Resultado awaiting_human não vira falha técnica de abertura. Ausência de análise não aparece como resultado negativo analisado. |
| OA-10 | Conteúdo necessário é cifrado no CRM e sujeito às ACLs existentes. Logs, auditoria e agregados não levam mensagens, resumos, telefone ou segredos. n8n continua sem persistir execuções e sem acesso direto ao banco CRM. |
| OA-11 | Administrador consulta janela de 1–90 dias com observações/falhas, sugestões, aceite/adiamento/recusa, tempos, criação manual sem sugestão e omissões anotadas. A tela explica limites e não apresenta recall/acurácia sem rotulagem independente. |
| OA-12 | Inbox e painel seguem Vue/tokens vigentes; teclado, foco, estado ocupado, erro, conflito, atualização/troca de conversa e avisos ARIA são verificados. Publicação acompanha CI, GitHub, migração e saúde/versão EasyPanel. |

Teste independente: conversa sintética coleta produto sem Pedido; cliente
confirma fechamento durante atendimento humano; aparece sugestão interna;
dois aceites concorrentes criam um pendente com a ficha correta. Outra conversa
sem sugestão recebe marcação de omissão. Métricas refletem ambas sem PII.
