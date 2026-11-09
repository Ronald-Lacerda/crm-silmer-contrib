# Protótipo de envio de cobrança

## Versão atual — Inbox da master de 08/11/2026

O protótipo atual usa **o App, a Inbox, os componentes e os tokens reais** da
master `15edc73b`. Um servidor Vite local acrescenta o botão de cobrança ao
lado de **Cotar frete**, somente em memória; nenhum arquivo da aplicação é
alterado para habilitar essa prévia.

Na raiz do repositório, execute:

```powershell
rtk proxy node docs/prototypes/billing-chat-preview.mjs
```

Abra **http://127.0.0.1:4189/inbox/billing-preview**. O endereço HTML antigo
redireciona para essa versão. O servidor deve permanecer aberto durante a
avaliação. Para encerrar, use Ctrl+C. `BILLING_PREVIEW_PORT` permite outra
porta, caso necessário.

1. No chat, escreva um rascunho e clique no botão de cartão **Gerar e enviar
   cobrança**, ao lado do caminhão **Cotar frete**.
2. Confira pedido/destino, escolha sinal ou integral e revise valor, saldo e
   mensagem. Confirme e acompanhe geração, fila, envio e entrega simulados.
   Fechar o diálogo preserva o rascunho e não interrompe a simulação.
3. Em **Controles da avaliação**, escolha **Link existente**. **Corrigir
   cobrança** explica o bloqueio enquanto o link está válido. Simule vencimento
   e encerramento, informe R$ 240 e declare o acordo e a conferência para
   revisar a correção. O histórico conserva o link anterior de R$ 360.
4. Simule o pagamento de R$ 240. **Saldo restante** oferece R$ 960, calculado
   a partir do recebido. A quitação bloqueia novas cobranças.
5. Compare **Falha comprovada antes do envio** (mesmo link, nova tentativa)
   com **Resultado do envio incerto** (sem retry). O cenário de sinal pago
   demonstra recebido R$ 360 e saldo R$ 840.
6. Verifique tema claro/escuro, celular e Tab/Shift+Tab/Enter/Escape; fechar
   devolve o foco ao botão do chat.

## Pedido e histórico compartilhado

Abra o link **Pedido 24-CRM** no cabeçalho do chat ou vá diretamente para
http://127.0.0.1:4189/pedidos/billing-preview-order?conversa=billing-preview#cobrancas.
A tela usa o `OrderView` e os componentes atuais; o servidor de preview troca
somente a seção de cobranças em memória, sem alterar a aplicação publicada.

- **Cobranças e pagamentos** mostra total, recebido, saldo, links/validade,
  correções e estado do envio separado do pagamento.
- **Pagamentos confirmados** mostra valor, meio, parcelas e confirmação.
  **Ver comprovante** abre os detalhes fictícios e devolve o foco ao fechar.
- O histórico registra criação, correção, fila, envio, entrega e recebimento.
  O link anterior permanece disponível para conferência.
- **Gerenciar cobranças** abre o mesmo diálogo do chat. **Voltar à conversa**
  conserva o rascunho ao navegar na mesma aba.
- Chat e Pedido consultam o mesmo estado em memória, inclusive em duas abas
  abertas. Simule um pagamento no chat e acompanhe recebido e saldo no Pedido,
  sem precisar recarregar ou registrar o pagamento novamente.

Exemplo: cobrar e receber R$ 360 deixa saldo R$ 840. Ao corrigir uma cobrança
vencida de R$ 360 para R$ 240, o histórico conserva ambas; confirmar o pagamento
de R$ 240 deixa saldo R$ 960. O total comercial continua R$ 1.200.

As rotas `/api/v1` são atendidas exclusivamente por fixtures locais. Escritas
reais são recusadas e rotas desconhecidas devolvem 404, sem proxy/fallback.
Links `pagamento.exemplo.test` são fictícios. Não há n8n, InfinitePay, WhatsApp,
banco, credencial, flag real ou persistência externa. Todo estado fica no
processo do preview; trocar cenário/reiniciar o servidor reinicia a simulação.

Verificação reproduzível, com servidor próprio em porta aleatória:

```powershell
rtk proxy node node_modules/@playwright/test/cli.js test --config docs/prototypes/billing-chat.playwright.config.mjs
```

## Histórico do protótipo anterior

O roteiro abaixo documenta a versão HTML anterior, substituída pela prévia
Vue acima. Não representa o estado atual do backend ou do design.

COB-CHAT-P01, preparação de COB-CHAT-01 / COB-12, [RFC 047](../rfc/047-enviar-cobranca-pela-conversa.md).

Abra `billing-chat.html` por um servidor local iniciado na raiz do repositório:

```powershell
rtk proxy python -m http.server 4188 --bind 127.0.0.1
```

Endereço: http://127.0.0.1:4188/docs/prototypes/billing-chat.html.

## Roteiro de avaliação

1. Na Caixa de Entrada, mantenha ou edite o rascunho e clique em Enviar cobrança.
2. Escolha sinal ou integral, confira valor/destino/mensagem e confirme.
3. Acompanhe geração, fila, envio e entrega simulados; feche e reabra o diálogo.
4. Abra o Pedido e repita pela seção Cobranças. Volte à conversa: o rascunho permanece.
5. Use o seletor de cenários para saldo, 0%, link existente, falha anterior ao
   envio, resultado incerto, troca de responsável, pagamento antecipado e bloqueios.
6. Na falha conhecida, revise e envie o mesmo link. Resultado incerto não oferece reenvio.
7. Confira em celular e com teclado: Tab, Shift+Tab, Enter e Escape; alterne o tema.

## Corrigir cobrança e cobrar o restante

Na conversa ou no pedido, o histórico mostra cada link, valor e situação,
além do total recebido e do saldo. No cenário **Link já gerado**, clique em
**Corrigir cobrança**. Enquanto o link anterior estiver válido ou sem
conferência, a nova emissão fica bloqueada. O diálogo explica que apagar a
mensagem ou corrigir no CRM não cancela o link na InfinitePay.

Expanda **Controles da avaliação** e simule o vencimento/conferência sem
pagamento. Defina outro valor (exemplo: R$ 240), confirme o acordo com o
cliente e revise a nova mensagem. O link anterior fica no histórico como
vencido e conferido; a correção recebe outro link. O total comercial não muda.
Um pagamento tardio exige conferência. Esses passos são uma proposta de
interação para revisão; não alteram os contratos financeiros aprovados.

Em **Controles da avaliação** no histórico, simule o recebimento do link.
O recebimento é preservado e **Cobrar saldo** passa a oferecer somente o
restante. Exemplo: recebido R$ 240 → saldo R$ 960. No cenário **Sinal pago →
cobrar saldo**, o restante é R$ 840. O novo link aparece como outra cobrança,
sem reaproveitar o link pago. Cobrança em aberto bloqueia outra cobrança de
saldo; a quitação bloqueia novas emissões. Cobrança paga não permite mudar
o valor recebido; a correção orienta saldo ou conferência de devolução.

Verificação adicional: link válido bloqueado, valor fora do saldo recusado,
link anterior preservado, correção 360 → 240, recebimento 240, saldo 960 e
quitação 1.200; proteção de cobrança paga e conferência axe claro/escuro nas
novas telas. A revisão QA independente identificou e motivou ajustes do
estado após recebimento, bloqueio na quitação e identificação do novo link.

O exemplo tem total de R$ 1.200,00, sinal de 30% (R$ 360,00) e saldo de
R$ 840,00. No cenário de saldo, o sinal já está confirmado. Sem entrada permite
salvar sem emitir; gerar integral é outra ação humana. Os valores são fictícios.

## Fronteira

### Alinhamento visual ao projeto atual

COB-CHAT-P03 corrige o shell genérico inicial. `billing-layout.css` importa
diretamente `styles.css` e `40-order.css` do produto; tokens, marca SVG e
Poppins vêm das fontes atuais. Referências: `App.vue`, `InboxView.vue`,
`OrderView.vue` e `OrderSheetHead.vue`, conferidas contra `origin/master`
em `72702f0` e a composição de cobranças do PR 298.

A Inbox usa menu compacto, topbar, atalhos horizontais e painel contextual de
cobranças que pode ser recolhido. Pedido usa seções da ficha no corpo principal,
incluindo Cobranças, e fechamento na lateral. Em celular há navegação inferior
e seções recolhíveis, com Cobranças aberta inicialmente para avaliação. O shell
continua sendo um recorte navegável, sem login, busca ou demais módulos reais.

HTML/JavaScript isolado, sem bibliotecas de interface adicionais, APIs, storage
persistente ou chamadas ao n8n/InfinitePay/WhatsApp. Reutiliza os tokens reais
do CRM e Poppins local sob a licença incluída em `assets/`. Os timers simulam
as respostas externas; enviado e entregue são etapas diferentes. Reload ou
troca de cenário apaga a simulação. A durabilidade real será implementada no
backend após avaliação; o protótipo não a comprova.

O shell e o conteúdo da ficha são recortes para contextualizar a avaliação,
não uma substituição das telas do CRM. Seleção entre vários pedidos confirmados,
reconciliação operacional e pagamento no checkout real não são reproduzidos.
O seletor demonstra um pedido confirmado e outro pendente indisponível.

## Verificação

Navegação automatizada no Chromium: as duas entradas, revisão de R$ 360/R$ 840,
rascunho preservado, Escape com retorno de foco, percentual inválido bloqueado,
oito trajetórias assíncronas, reenvio do mesmo link após falha conhecida e quatro
bloqueios. Conferência de overflow em 1440/390/320 px e axe em claro/escuro.
Screenshots inspecionadas pelo autor. Essas evidências são do protótipo local;
não são testes da integração financeira ou prova de envio/pagamento real.

Revisão QA independente encontrou duas inconsistências corrigidas antes da
entrega: contexto de responsável após transferência/sem permissão e tipo da
cobrança após pagamento antecipado. Tipo e valor ficam preservados na intenção
simulada. A limitação de múltiplos pedidos elegíveis permanece explícita acima.
