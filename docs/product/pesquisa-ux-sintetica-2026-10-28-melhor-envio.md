# Pesquisa de UX com vendedores sintéticos: frete Melhor Envio (28/10/2026)

> **Método:** teste de conceito em think-aloud simulado, em duas rodadas,
> com seis personas sintéticas. Cada persona rodou num agente isolado, a
> partir de um briefing com fatos do código (`apps/edge-web`, `modules/orders`)
> e da API v2 do Melhor Envio (docs.melhorenvio.com.br, lidas em 28/10/2026).
> Foram 7 tarefas (T1–T7) e 9 conceitos (C0 = hipótese do PO). A rodada 2
> testou o fluxo composto que sobreviveu à rodada 1.
> **Limite:** as personas vêm do mesmo modelo, então os erros delas tendem a
> ser correlacionados. Isso **não substitui** teste com a equipe real da
> Silmer. Achados de severidade 4 e as decisões de política da seção 6 devem
> ser confirmados com o PO e com quem embala antes de virar requisito.
> **Uso:** base do [RFC 038](../rfc/038-frete-e-etiqueta-pelo-melhor-envio.md).

## 1. Pergunta e hipótese

**Hipótese do PO (C0):**

1. A vendedora pega o CEP e calcula o frete na Caixa de Entrada.
2. A vendedora adiciona o frete ao pedido para chegar ao valor completo.
3. Assim que o CEP entra na Caixa, o pedido já recebe um frete "base".
4. A etiqueta sai por um botão "PDF Melhor Envio".

**Pergunta:** qual experiência leva o frete da conversa até a etiqueta colada
na caixa com menos passos e sem perder dinheiro? Que alternativas existem ao
botão de PDF?

## 2. Restrições que o desenho precisa respeitar

| Fato | Fonte | Efeito no desenho |
| --- | --- | --- |
| O pedido tem só um "Valor final", digitado no Gerar. Não há campo de frete | `OrderClosingSection.vue`, RULES 13 | O frete separado pede um ADR que complemente o ADR 020 |
| Contato e conversa não têm endereço nem CEP. O bot guarda texto livre em `serviceData` | `modules/contacts`, `OrderInfoStrips.vue` | É preciso um endereço de entrega estruturado no pedido |
| O status é só `pendente → confirmado`. Não há "pronto" nem "postado" | `order.js` | É preciso um marco de expedição que não mude o status |
| O catálogo não tem peso nem medidas | `store-catalog.js` | Toda cotação é estimada. É preciso uma tabela de peso por peça e uma caixa padrão |
| O bot nunca fala preço nem frete e faz handoff `negotiation` | RULES 5, ADR 009 | Cotação do bot só como apoio interno |
| Editar ou gerar o pedido exige ser dono da conversa ou admin. Não existe papel de expedição | RULES 20, ADR 042 | Quem embala hoje não tem permissão |
| Correios, J&T e Loggi aceitam **um volume por etiqueta** | API `/me/cart` | 150 peças em 2 caixas = 2 etiquetas |
| A compra exige CPF/CNPJ, endereço com número e a lista de produtos (DC-e) | API `/me/cart` | Pendência de dados antes da expedição |
| A compra sai do saldo pré-pago. Cancelamento só antes da postagem, com estorno em até 12 h | API checkout/cancel | Permissão, auditoria e alertas de etiqueta parada |
| Webhooks `posted`/`delivered` trazem `tracking_url` | API webhooks | "Postado" vem do Melhor Envio, não de clique |
| Impressão em PDF, ZPL ou JPEG, por link privado ou público | API print | O PDF 10×15 resolve a térmica sem infraestrutura nova |

## 3. Personas

| Persona | Papel | Contexto | Lente no teste |
| --- | --- | --- | --- |
| Camila, 27 | Vendedora interna | Notebook 1366×768, 30–40 conversas | Velocidade, troca de aba |
| Diego, 34 | Representante externo | Só celular, 3G, pedidos de 200–600 peças | "Frete incluso", múltiplas caixas |
| Joana, 46 | Vendedora veterana | Zoom 125%, teclado, medo de gastar | Confiança em valor automático, jargão |
| Thiago, 22 | Vendedor novo | Loja do site + leads de fora, pressa | Erros por pressa, CEP errado |
| Sílvio, 52 | Dono (COMMERCIAL_ADMIN) | Celular, carrega o saldo | Margem, permissão, auditoria |
| Rose, 44 | PCP que embala e despacha | Tablet + desktop, vai à agência | Caixas, peso real, etiqueta física |

## 4. Rodada 1: nove conceitos

SEQ médio (1–7, maior é mais fácil) nas tarefas em que o conceito se aplica,
e posição média no ranking pessoal (1 = favorito, 9 = último).

| Conceito | SEQ | Ranking | Leitura |
| --- | --- | --- | --- |
| C8 Como o cliente recebe, decidido primeiro | **6,1** | **2,8** | Evita frete em pedido de retirada |
| C7 Rastreio automático para o cliente | **6,0** | 4,0 | Resolve "cadê meu pedido?" sem esforço |
| C3 Resposta pronta com as opções | 5,2 | 4,7 | Rápido, mas fica velho quando a grade muda |
| C4 Link de endereço para o cliente | 5,1 | 5,7 | Bom para o CPF; clientes mais velhas podem achar que é golpe |
| C2 Frete estimado vs. frete fechado | 5,0 | **3,3** | O único que separa peças de frete e dá nome ao frete grátis |
| C1 CEP detectado na mensagem | 4,8 | 4,0 | Favorito de quem vende; "a partir de" vira promessa |
| C6 Etiqueta na hora certa (pronto) | 4,2 | 5,7 | Favorito de quem embala; vendedor diz "não é meu serviço" |
| C5 Expedição em lote | 3,5 | 5,8 | Lista pedidos que ainda estão em produção |
| **C0 Hipótese do PO** | **2,2** | **9,0** | **Último para as seis personas** |

### Por que a hipótese literal falhou

1. **Frete base automático (sev. 4, 6/6 personas).** O frete fica velho
   quando a grade muda (T2). Continua no pedido quando o cliente decide
   retirar (T3). Some do controle quando a vendedora digita o "Valor final"
   já com frete, e o frete é cobrado em dobro (T4). *"Quem colocou esse valor
   aí? Eu não coloquei frete nenhum."* (Joana) · *"Ficou R$ 4.389 em vez de
   R$ 4.300?"* (Diego) · *"Número na tela vira promessa."* (Sílvio)
2. **"PDF Melhor Envio" esconde uma compra (sev. 4).** *"PDF é pra imprimir,
   né?"* / *"Não clico nisso nem amarrada."* (Joana). Thiago comprou duas vezes
   por clique repetido.
3. **Um pedido, uma etiqueta (sev. 4).** O pedido de 2 caixas sai com uma
   etiqueta. *"Quem sabe que virou duas caixas sou eu, e o botão nem me
   pergunta."* (Rose)
4. **CEP no painel Detalhes fica invisível.** A 1366×768 e com zoom de 125%,
   o painel fica recolhido, e no celular ele é outra tela.

**O que se confirma da hipótese:** cotar dentro da Caixa de Entrada (item 1)
e levar o frete ao pedido (item 2) são desejados por todos. O que falha é o
valor entrar **sozinho** no total (item 3) e a etiqueta virar um botão de PDF
(item 4).

## 5. Rodada 2: fluxo composto "Frete a lápis"

Fluxo testado: cotação a partir do chip do
CEP; "Como o cliente recebe?"; frete estimado com origem visível, que só entra
no total no Gerar; quatro opções de frete sem pré-seleção; marco "Pronto para
envio"; bancada de expedição com caixas e peso; compra idempotente com saldo
antes e depois; lote com separação; postado pelo webhook.

| Persona | T1 | T2 | T3 | T4 | T5 | T6 | T7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Camila | 5 | 5 | 6 | 5 | 6 | 4 | 6 |
| Diego | 4 | 4 | 7 | 5 | 4 | 3 | 5 |
| Joana | 4 | 5 | 7 | 6 | 5 | 4 | 6 |
| Thiago | 5 | 5 | 7 | 4 | 3 | 4 | 6 |
| Sílvio (confiança 1–5) | 6/4 | 6/4 | 6/3 | 5/3 | 5/4 | 4/3 | 6/4 |
| Rose | 5 | 6 | 5 | 5 | 5 | 6 | 7 |

- **Segurança:** os erros graves de dinheiro dos vendedores caíram de cerca
  de 9 para 3. Sílvio e Rose deixaram de ver o fluxo como risco.
- **Custo:** o SEQ dos vendedores caiu de 5,6 (melhor conceito isolado) para
  5,0. A T1 (responder o frete em menos de 1 minuto) só foi cumprida pela
  Camila (40–55 s). Diego e Joana levaram de 70 a 110 s, porque o chip abre o
  Detalhes e pede a quantidade por tipo de peça.

### Achados residuais e ajustes

| # | Sev. | Achado | Ajuste para a versão 3 |
| --- | --- | --- | --- |
| R1 | 4 | A bancada não fecha com os papéis atuais: Rose não é dona da conversa, e "Comprar etiquetas" não existe | Capacidades novas: **Expedição** (embalar, caixas, imprimir; sem preço) e **Compra de etiquetas**, ambas dadas pelo admin. Lote aprovável pelo celular |
| R2 | 4 | Mexer no frete depois de confirmado esbarra na reabertura (RULES 9) e na quitação (ADR 042) | Diferença tem só três saídas: absorver (até o teto ou com aprovação), trocar o serviço se couber no prazo, ou segurar o envio. O Valor final confirmado não muda |
| R3 | 3 | T1 lento: Detalhes abre outra tela e pede quantidade por tipo | Popover sobre a própria conversa, com uma pergunta ("Quantas peças?") e o valor ali. "Como calculei" fica recolhido |
| R4 | 3 | "Incluso" não pede aprovação e "por conta da empresa" pede, então todos escolhem "incluso" | A mesma regra para as duas. Com "incluso", o rótulo vira "Valor total (frete já dentro)" |
| R5 | 3 | "Enviar valor do frete" só preenche o composer | "Escrever resposta com o frete", com foco no campo |
| R6 | 3 | "Avisar vendedora" não leva a nada | Aviso na Inbox de quem é dono da conversa, com "Pedir ao gestor para absorver" e "Vou cobrar do cliente". Uma regra só: o menor entre R$ 20 e 10% |
| R7 | 3 | "Desatualizado" só dispara com pedido, e o bloqueio parece travamento | O rascunho diz "Cotado para 150 peças às 10:42". Aviso `aria-live` com "Recalcular" e "Enviar assim mesmo" no lugar do bloqueio |
| R8 | 3 | "Cliente escolheu: PAC" é opcional, mas a expedição depende dele | Sem a marcação, o Gerar lista os serviços cotados como opções |
| R9 | 3 | A declaração de conteúdo pede valor por item, mas o CRM só tem o total | Regra de rateio explícita. DC ou NF-e decididos com o contador |
| R10 | 3 | Sexta física: ZPL exige agente local, caixa sem medidas, sábado sem coleta | PDF 10×15, tipo de caixa P/M/G com medidas, "postar até" em dia útil |

### Rótulos

| Antes | Depois |
| --- | --- |
| PDF Melhor Envio | **Comprar etiquetas** e, depois, **Imprimir etiquetas** (duas ações) |
| Envio pelo Melhor Envio | Envio por transportadora (Correios, Loggi…) |
| Frete incluso no preço / Por conta da empresa | Já está no preço das peças / Frete grátis (empresa paga) |
| inclui folga de 10% | valor com margem para variação de peso (sem %) |
| Avisar vendedora | Frete subiu: decidir com o gestor |
| Cotado pelo Agente, revise | Cotado pelo robô para N peças: confira a quantidade |
| Fila "Para enviar" / marco "Pronto para envio" | Fila **Expedição** / marco **Embalado** (não confunde com "Prontos para produção") |
| Cabem no saldo (4) + Comprar 7 etiquetas | 4 pedidos · 7 etiquetas cabem no saldo |
| sujeito ao peso final (no texto ao cliente) | para 150 peças · válido até 31/10 |
| carteira, volume, serviço, cotação | saldo do frete, caixa, transportadora, valor do frete |

## 6. Recomendação: "Frete a lápis" v3

1. **Cotar na conversa.**
   - O chip no CEP da mensagem (focável por teclado) ou o campo CEP abre um
     popover sobre a conversa com a cidade/UF em destaque, "Quantas peças?"
     (pré-preenchido pela grade quando há pedido) e PAC e SEDEX com valor e
     prazo.
   - "Escrever resposta com o frete" põe o texto no composer, com quantidade
     e validade.
   - O robô não cota no MVP.
2. **Pedido.**
   - "Como o cliente recebe?" (Retira · Transportadora · Entrega própria),
     sem pré-seleção.
   - O frete entra no pedido como **Estimado**, com origem e quantidade. É o
     "frete base" da hipótese, só que a lápis: aparece no pedido assim que é
     cotado, **sem entrar no total**.
   - No Gerar, "Valor das peças" + uma opção de frete (cobrar o cotado · já
     está no preço · frete grátis · valor combinado), nenhuma pré-marcada, e
     a soma visível.
   - Frete grátis, "já está no preço" e valor abaixo do cotado seguem a mesma
     alçada.
3. **Dados de entrega.**
   - Pendência "Para a etiqueta falta: CPF ou CNPJ, número" visível desde a
     confirmação.
   - Um só botão "Pedir dados de entrega". O formulário público fica para
     depois da decisão de privacidade.
4. **Expedição, no lugar do botão de PDF.**
   - Marco **Embalado** (não muda o status) e fila **Expedição**. Para cada
     pedido: transportadora escolhida em destaque, caixas por tipo com peso e
     pendências.
   - **Comprar etiquetas** com o saldo antes e depois e o valor cotado ao
     lado. Compra idempotente por pedido e caixa, com auditoria.
   - **Imprimir etiquetas** em PDF 10×15 ou A4, com "Caixa n/N · Pedido" e
     a declaração de conteúdo.
   - Lote de sexta com "N pedidos · M etiquetas cabem no saldo" e os
     bloqueados ao lado.
   - Alertas: etiqueta parada há 3 dias e pedido que virou retirada com
     etiqueta comprada (com "Cancelar etiqueta").
5. **Rastreio.**
   - "Postado" e "entregue" vêm do webhook.
   - Sugestão de mensagem com o rastreio na conversa, enviada com um toque.
     O envio automático fica desligado por padrão.
   - "Entregue" sugere o "Entregue em", com confirmação humana (ADR 039).

### Alternativas ao botão "PDF Melhor Envio" avaliadas

| Alternativa | Veredito | Por quê |
| --- | --- | --- |
| Separar **Comprar** de **Imprimir** | MVP | Resolve a compra escondida (sev. 4) e a compra duplicada |
| Fila Expedição com marco Embalado | MVP | Só compra etiqueta do que já foi embalado; quem embala sabe as caixas |
| Lote de sexta com separação por saldo/pendência | MVP | O dia de expedição real; PDF único agrupado por pedido |
| Etiqueta por caixa "n/N" + declaração junto | MVP | Exigência física e da API (um volume por etiqueta) |
| Postado/entregue pelo webhook + rastreio sugerido | MVP | Elimina o "Marcar postados" manual, que era clicado cedo demais |
| Aprovação do lote pelo celular do gestor | MVP, se a política exigir aprovação | Evita gargalo na sexta às 16h |
| Térmica direta (ZPL) | Depois | Exige agente de impressão local (infra nova); PDF 10×15 cobre |
| Link para o celular/tablet de quem embala | Depois | PII em aparelho pessoal; precisa de link privado curto do CRM |
| Conferência por câmera ao colar | Cortado | 18 leituras num lote de 6; "Caixa n/N · Pedido" impresso basta |
| Janela de coleta Loggi | Cortado | Só "postar até" em dia útil |
| Postagem sem etiqueta (QR) | Não existe | Não confirmado em nenhuma transportadora pela API |

## 7. Decisões que o PO precisa tomar

1. **Quem compra e cancela etiquetas** e quem tem Expedição. Há teto quando a
   compra é delegada? Isso pede um ADR que complemente o ADR 042.
2. **Uma tolerância só** para a diferença real × cotado (proposta: o menor
   entre R$ 20 e 10%) e quem aprova acima dela.
3. **Alçada** para frete grátis, "já está no preço" e valor abaixo do cotado.
4. **O Valor final passa a ser Peças + Frete calculado?** Isso pede um ADR
   que complemente o ADR 020. O Painel mostra vendas com ou sem frete (frete
   não é venda)?
5. **Mudar o frete depois de confirmado** nunca reabre o pedido (proposta) ou
   reabre?
6. **DC ou NF-e** e a regra de rateio do valor por item, com o contador.
7. **Validade da cotação** no texto ao cliente e se o valor pode ser editado.
8. **Tabela de peso** por tipo de peça e caixas padrão: quem mantém?
9. **CPF:** retenção, quem vê sem máscara e se o formulário público entra
   (RULES 17).

## 8. Fatias sugeridas

| Fatia | Conteúdo | Depende de |
| --- | --- | --- |
| ME-0 | Conta, app OAuth (sandbox), adapter de cotação com token renovável, tabela de peso/caixa | Decisão 8 |
| ME-1 | Popover de cotação na conversa + "Escrever resposta com o frete" | ME-0 |
| ME-2 | "Como o cliente recebe?" + frete a lápis + Gerar com peças + frete | ME-1, decisões 3–5 |
| ME-3 | Dados de entrega estruturados (endereço, CPF/CNPJ mascarado) | Decisão 9 |
| ME-4 | Marco Embalado, fila Expedição, caixas, compra/impressão, lote, auditoria | ME-2, ME-3, decisões 1, 2, 6 |
| ME-5 | Webhook com HMAC, linha do tempo do envio, rastreio sugerido, alertas | ME-4 |

## 9. Próximo passo de pesquisa

Validar com pessoas reais da Silmer, de 20 a 30 minutos cada: uma vendedora
na T1/T2 com um protótipo do popover, quem embala na T5/T6 com a fila
Expedição em papel e o Sílvio nas decisões 1–5. Medir o tempo da T1 e se a
pessoa entende que "Comprar etiquetas" gasta saldo.

## 10. Revisão do PO (28/10/2026): etiqueta pronta e embalagem no pedido

Depois da síntese, o PO trouxe duas direções da Silmer. Elas mudam a seção 6.

1. **"Como na Shopee, a etiqueta sai pronta."** Ninguém monta carrinho nem
   compra etiqueta por etiqueta.
   - Quem embala toca em **Marcar como embalado**. Nesse momento o CRM
     compra no Melhor Envio com o saldo, gera uma etiqueta por caixa e junta
     tudo num PDF. Sobra só **Imprimir etiquetas**.
   - Isso não traz de volta o botão escondido da rodada 1 (sev. 4). O próprio
     botão avisa a compra: "Ao marcar, o CRM compra 3 etiquetas PAC (cerca de
     R$ 281 do saldo do frete)".
   - A compra automática para em **Etiqueta pendente** em três casos, e os
     outros pedidos seguem:
     - falta dado do destinatário (aviso à vendedora na conversa);
     - falta saldo (pedido de recarga ao gestor);
     - frete real acima do limite da decisão 2 (decisão com o gestor).
   - Abaixo do limite, a diferença é absorvida e registrada.
   - Por caixa saem duas etiquetas: a da transportadora, no layout do Melhor
     Envio, e a da Silmer com o conteúdo da caixa (tamanhos, quantidades,
     peso, medidas e QR do pedido).
   - Essa direção substitui "Comprar etiquetas" como ação separada, mas
     mantém a impressão separada. A decisão 1 deixa de ser "quem clica em
     comprar" e passa a ser "quem pode marcar como embalado".
2. **Peso e medidas fazem parte do pedido, não só da cotação.**
   - Nova seção **Embalagem** no pedido. Cada caixa tem tamanho padrão (P
     30×20×15, M 40×30×25, G 50×40×35 cm, ou outra medida), peso da balança e
     o que vai dentro, tirado da grade.
   - O pedido guarda duas leituras: o **estimado** na cotação (tabela de peso
     por peça × grade) e o **pesado** na embalagem, com quem e quando. A
     etiqueta usa sempre o pesado.
   - A soma das caixas precisa bater com a grade ("220 de 220 peças").
   - Esses dados também viram a etiqueta de conteúdo e a declaração de
     conteúdo, e servem para contestar uma cobrança por divergência de peso.

Protótipo: canvas "Etiqueta pronta", com a visão geral, o pedido com
Embalagem, a tela de embalar no celular, o pedido com etiqueta pronta e as
etiquetas impressas. O canvas não foi testado com as personas; uma rodada
curta na T5/T6 com quem embala confirmaria a compra automática.

## 11. Menu Melhor Envio e conferência com a API (28–29/10/2026)

**Pedido do PO:** a configuração das **embalagens** (não "caixas": também
há sacos) e a da **etiqueta** ficam fora do pedido, só para o gestor.

Primeiro esse lugar se chamou "Configurações › Envio". Em 29/10 o PO o
renomeou para o menu próprio **Melhor Envio**, para a integração poder
crescer como módulo. Nas linhas abaixo, "Configurações" quer dizer esse
menu. A tela tem estas seções:

- Conta Melhor Envio;
- Remetente;
- Nota fiscal;
- Embalagens (tipo, medidas, peso da embalagem, carga máxima e
  transportadoras em que cabe);
- Peso por peça;
- Etiqueta (formato, etiqueta de conteúdo e anotação);
- Transportadoras;
- Regras (quem marca como embalado e a diferença absorvida).

O pedido e a tela de embalar só escolhem entre as embalagens cadastradas.

**Conferência com a documentação oficial** (docs.melhorenvio.com.br e o
blog do Melhor Envio, lidos em 28/10/2026):

| Ponto do desenho | Resultado | Ajuste |
| --- | --- | --- |
| Etiqueta automática (carrinho → compra → geração) | Possível só por API com saldo. **A geração é assíncrona** (a doc recomenda aguardar) | Estados "Comprada" e "Gerada". O PDF é baixado quando chega o webhook `order.generated`, com consulta periódica de reserva |
| Uma etiqueta por embalagem | Confirmado para Correios, J&T e Loggi. Jadlog aceita vários volumes | Um item de carrinho por embalagem |
| Peso e medidas | `volumes` (cm, kg) e `products` (nome, quantidade, valor) são **obrigatórios por item**; `insurance_value` obrigatório, com teto por serviço (PAC R$ 3.000) | Cada embalagem leva o que vai dentro e o valor declarado (rateio do valor das peças) |
| Limites | Correios: até 30 kg, lados de 16–105 × 11–105 × 2–105 cm, soma 200 cm. Formatos caixa, rolo e envelope (até 0,5 kg), sem campo de formato no carrinho | Limites lidos de `/me/shipment/services` em tempo de execução. "Cabe em" calculado por embalagem |
| A4 ou 10×15 | **Não se escolhe pela API.** O PDF vem no formato do Melhor Envio; ZPL para térmica | Configuração: "PDF do Melhor Envio" ou "Térmica direta (ZPL)". Testar o PDF no sandbox |
| Declaração de conteúdo | O Melhor Envio gera a DC-e e a DACE sozinho, **só para PF ou PJ não contribuinte de ICMS**. Envio comercial exige a chave da NF-e e a IE | **Bloqueante:** se a Silmer é contribuinte, a chave da NF-e entra no pedido antes de embalar. Decisão com o contador |
| Texto próprio na etiqueta | `options.reminder` imprime fora da área de recorte; `tags` só rastreia | O número do pedido vai no `reminder`. A etiqueta de conteúdo da Silmer continua necessária |
| Remetente | `from` obrigatório em cada chamada | Remetente guardado nas Configurações do CRM |
| Saldo | **Não há leitura de saldo.** Recarga por API gera Pix ou boleto, e alguém precisa pagar | Sai "saldo antes → depois". Compra recusada vira pendência "recarregar". Configurações tem "Adicionar saldo por Pix" |
| Rastreio | Por etiqueta, via webhook com HMAC (`x-me-signature`); 5 tentativas | Mantido |
| Coleta | Sem endpoint. Só a Coleta Loggi, agendada sozinha ao gerar | Só "postar até" e Loggi automática |

**A testar no sandbox antes de codificar:**

- se o carrinho exige `document` e `company_document` ao mesmo tempo;
- o layout e o tamanho de página do PDF;
- se `note` aparece impresso;
- os limites de Loggi e J&T (as fontes divergem).

**Resposta do PO (29/10/2026):** a Silmer emite NF-e só quando necessário e
pode passar a emitir sempre. O desenho fica assim:

- A seção Nota fiscal do menu Melhor Envio tem duas opções: **"Decide em cada
  pedido"** (padrão) e **"Sempre com NF-e"** (para quando a Silmer mudar).
- Por padrão, o pedido usa a **declaração de conteúdo eletrônica**, que o
  Melhor Envio gera sozinho, e a DACE sai no PDF, uma por embalagem.
- O pedido tem a ação "Este pedido tem NF-e". Quando marcada, a etiqueta só
  sai depois que alguém informa a chave. Jadlog fica restrita a pedidos com
  NF-e.
- **Risco fiscal a validar com o contador:** pelas regras do Melhor Envio, a
  declaração de conteúdo só vale para envio não comercial (pessoa física ou
  empresa não contribuinte de ICMS). O CRM não decide isso. A configuração
  mostra o aviso, e a escolha por pedido continua humana.

**Nem toda venda usa o Melhor Envio (PO, 29/10/2026).** Por enquanto a
pergunta "Como o cliente recebe?" tem **duas** respostas: retirada na loja
e transportadora pelo Melhor Envio. Entrega própria e outros envios
(ônibus, barco) ficam fora até nova decisão. O menu Melhor Envio tem a seção
"Nos pedidos", que liga ou desliga a opção. Outra forma de entrega teria o
seu próprio menu.

| | Retirada na loja | Transportadora pelo Melhor Envio |
| --- | --- | --- |
| Exemplo | Cliente busca em Boa Vista; padrão da loja do site | Correios, Loggi, Jadlog |
| Frete no valor | Não tem | Cotado na conversa |
| Endereço | Não pede | Completo, com CPF ou CNPJ |
| Embalagens e peso | Não pede | Obrigatório, por embalagem |
| Etiqueta | Conteúdo da Silmer, opcional (prateleira) | Transportadora + conteúdo, automática |
| Nota fiscal | Regra da Silmer, sem pedido do CRM | Declaração de conteúdo ou chave da NF-e |
| Último passo | "Pronto para retirar" e avisar o cliente | Postado e rastreio pelo webhook |

- Num pedido novo, nenhuma das duas vem marcada.
- A fila Expedição mostra cada pedido com a ação da sua forma de entrega.
- Cotação, embalagens, compra automática, saldo e webhooks só existem para
  o Melhor Envio.
- O marco "Pronto para retirar" é novo e, como o "Embalado", não muda o
  status `confirmado`.

## Artefatos

Ficaram no scratchpad da sessão e não são versionados: o briefing, nove
sessões (seis da R1 e três da R2) e o fluxo R2. Os números das tabelas acima
foram extraídos deles.
