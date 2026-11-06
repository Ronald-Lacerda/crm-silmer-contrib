# RFC 047 — Enviar cobrança pela conversa

Status: proposta de interação em avaliação no protótipo. Data: 05/11/2026.
Requisitos existentes: COB-01–16, MSG-02/03, PCX-13, UX-FUNC-01.
Tarefas: COB-REV-01 e COB-CHAT-01 em
[Cobranças](../../.specs/features/order-billing/tasks.md).
Complementa a [RFC 049](049-cobrancas-do-pedido-com-infinitepay.md) e a
[ADR 058](../adr/058-cobrancas-do-pedido-com-infinitepay.md). A decisão
arquitetural do envio integrado será registrada em novo ADR após a avaliação;
não reescrever a decisão anterior nem tratar esta proposta como runtime pronto.

## Problema e direção solicitada

O proprietário rejeitou a ponte de copiar/colar entre Pedido e Caixa de Entrada.
Solicitou um botão para enviar cobrança no chat ou pedido, selecionar quanto e
como, gerar o pagamento e enviá-lo na própria conversa. Escolheu expressamente
“Link enviado direto no chat, com Pix e cartão” para a primeira entrega.
O pedido anterior de avaliar o protótipo antes da implementação permanece.
Dashboard está fora desta fatia; sua entrega separada deve ser preservada.
Para a integração posterior, o proprietário definiu que o saldo deve continuar
como pendência enquanto houver valor a receber, até a quitação, sem mensagens
automáticas ao cliente por esse lembrete.

## Sequência proposta

1. **Enviar cobrança**, na conversa ou no pedido vinculado. Havendo mais de um
   pedido elegível na conversa, selecionar o pedido explicitamente.
2. Escolher integral, sinal percentual ou saldo disponível. A condição 0%
   continua significando sem entrada, nunca emissão de cobrança de valor zero.
3. Revisar pedido, cliente/conversa de destino, valor da cobrança, saldo após
   pagamento e formato: link InfinitePay, Pix ou cartão inclusive parcelado.
4. **Gerar e enviar cobrança** autoriza uma intenção humana específica. O
   sistema reserva e gera o link e o enfileira como mensagem na conversa certa.
   Não exige copiar/colar nem um segundo envio no compositor.
5. Mostrar geração, fila e resultado do transporte separadamente. Só afirmar
   enviado/entregue após o respectivo feedback real. Gerar/enviar não é pagar.
6. Sinal confirmado mantém saldo. Quitação depende do recebimento verificado
   pela InfinitePay e não muda os dois status comerciais existentes.

O texto contém identificação do pedido, sinal/saldo/integral, valor exato e
link. O rascunho livre já existente na Inbox permanece separado e preservado.
Para pedido sem conversa, não inferir destinatário por nome/telefone: exigir
vínculo elegível e explícito antes de oferecer envio.

## Fronteiras técnicas a decidir na implementação

- Persistir a intenção de envio junto à emissão, com cobrança, conversa, ator,
  owner/ciclo observados e identidade determinística do comando de mensagem.
- Callback de criação salva URL cifrada e enfileira mensagem/outbox/auditoria
  atomicamente pela infraestrutura humana da Inbox. Não enviar diretamente
  pelo workflow financeiro nem invocar API pública depois de um commit parcial.
- Revalidar usuário, responsável, conversa humana ativa, ciclo, acordo, saldo
  e validade antes do enfileiramento e na reserva final do transporte. A
  transferência atual não altera epoch: comparar responsável explicitamente.
- Callback repetido, resposta perdida e retomada não duplicam mensagem nem
  cobrança. Falha conhecida no envio pode oferecer o mesmo link; resultado
  incerto exige conferência, sem reemitir cobrança ou reenviar cegamente.
- Conversa encerrada/transferida ou acordo alterado bloqueia a intenção antiga;
  não migrar silenciosamente o envio para outro responsável ou novo atendimento.
- Autorização de administrador precisa ser explícita no serviço de mensagem;
  não simular função Vendedor para contornar a validação atual.
- Usar nova migration expand com numeração coordenada com as entregas em curso;
  não alterar 0055 nem colidir com migrations da central de ações.

## InfinitePay e limites

A [documentação oficial](https://www.infinitepay.io/checkout-documentacao)
informa que QR Pix/copia e cola aparecem no checkout do comprador e não são
devolvidos pela API. Não criar QR de URL e apresentá-lo como QR Pix. Cartão
permanece habilitado no checkout; não oferecer seleção “somente Pix”.
Uso único e validade exigem API Key privada para `options`; a conta da chave
e a InfiniteTag devem coincidir. O site existente usar checkout por handle
não comprova que essa credencial privada está configurada no n8n.

## Prova necessária

Revisão do protótipo; teste transacional de callback duplicado/concorrente e
rollback; transferência/fechamento/desativação/expiração/mudança de preço antes
do link e da reserva final; pagamento antes do envio; falhas conhecidas e
incertas sem duplicação; Admin/Vendedor/outro responsável; pedido sem conversa;
teclado e toque 320/390 px; preservação do rascunho. Homologação remota e
pagamento real autorizado continuam gates separados em COB-OPS-01.
