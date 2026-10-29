# RFC 038 — Frete e etiqueta pelo Melhor Envio

Status: em revisão desde 29/10/2026.
Responsável: Tech Lead. Aprovador: proprietário (PO). O contador valida a
decisão fiscal (D6).
Requisitos propostos: MEV-01 a MEV-16 (seção 5). Ainda não estão em
[Pedidos MVP](../../.specs/features/pedidos-mvp/spec.md).
Pesquisa: [pesquisa sintética de 28/10/2026](../product/pesquisa-ux-sintetica-2026-10-28-melhor-envio.md).
Protótipo: canvas "Etiqueta pronta" (artefato privado do PO).
Issue/PR específica: não criada nesta etapa.

## 1. Contexto

Hoje a Silmer cota frete fora do CRM. A vendedora abre o site do Melhor
Envio, chuta o peso e cola o valor no WhatsApp. A etiqueta é comprada à mão.
No CRM:

- o pedido tem só um "Valor final" digitado no Gerar (RULES 13), sem frete
  separado;
- o contato não tem endereço estruturado;
- o status é só `pendente` e `confirmado`, sem marco de expedição;
- o catálogo não tem peso nem medidas;
- o pedido da loja do site é de retirada, e o CEP opcional vira observação
  (LOJ-21).

A pesquisa com seis vendedores sintéticos, em duas rodadas, rejeitou a
hipótese inicial: o frete "base" entrava sozinho no total e a etiqueta saía
por um botão "PDF Melhor Envio". Ela levou ao fluxo "frete a lápis". Depois,
o PO definiu quatro direções:

1. A etiqueta sai pronta, como na Shopee, assim que o pedido é embalado.
2. Peso e medidas de cada embalagem ficam no pedido.
3. Nem toda venda usa o Melhor Envio. Por enquanto existem só **retirada na
   loja** e **transportadora pelo Melhor Envio**.
4. A integração ganha um menu próprio, **Melhor Envio**, e não uma tela de
   "Configurações". Isso deixa espaço para a integração crescer como módulo.

## 2. Proposta

### 2.1 Forma de entrega

Todo pedido responde a "Como o cliente recebe?" com **Retirada na loja** ou
**Transportadora pelo Melhor Envio**. Nenhuma das duas vem marcada num pedido
novo. O pedido da loja do site continua nascendo com retirada (ADR 027).

Só a segunda opção mostra cotação, endereço completo, embalagens, etiqueta e
rastreio. Retirada termina no marco "Pronto para retirar".

### 2.2 Cotação na conversa

Um CEP na mensagem do cliente vira um botão focável por teclado. O botão abre
a cotação por cima da conversa, com:

- cidade e UF em destaque;
- "Quantas peças?", preenchido pela grade quando já existe pedido;
- PAC e SEDEX com valor e prazo.

O peso é estimado pela tabela de peso por peça e pela embalagem padrão, as
duas definidas no menu Melhor Envio.

"Escrever resposta com o frete" coloca no campo de resposta o texto com a
quantidade e a validade da cotação. Quem envia é a vendedora. O agente não
cota nem fala de frete (RULES 5, ADR 009).

### 2.3 Frete no pedido ("a lápis")

A cotação fica no pedido como **frete estimado**, com origem visível: quem
cotou, quando, qual serviço e para quantas peças. A estimativa não entra no
total.

No "Gerar o pedido", a vendedora informa o **valor das peças** e escolhe uma
opção de frete, sem nenhuma pré-marcada: cobrar o valor cotado, "já está no
preço das peças", frete grátis (a empresa paga) ou valor combinado. A tela
mostra a conta "Peças + Frete = Valor final". O Valor final continua sendo o
total confirmado (RULES 10 e 13). Frete grátis, "já está no preço" e valor
abaixo do cotado seguem a mesma alçada.

### 2.4 Embalagens, peso e medidas

O pedido ganha a seção **Embalagem**. Cada embalagem tem:

- o tipo, escolhido entre os cadastrados no menu Melhor Envio (saco ou caixa,
  com medidas);
- o peso da balança;
- o que vai dentro, tirado da grade;
- o valor declarado, que é o rateio do valor das peças.

A soma das embalagens precisa bater com a grade. O pedido guarda a leitura
**estimada** (na cotação) e a **pesada** (na embalagem), com quem e quando.
A etiqueta usa sempre a pesada.

### 2.5 Etiqueta pronta ao embalar

Quem tem a permissão Expedição marca **Embalado**. O CRM então faz uma
chamada de carrinho para cada embalagem (Correios, J&T e Loggi aceitam um
volume por item), faz o checkout com o saldo, pede a geração e espera o
evento `order.generated`. A geração é assíncrona, com consulta periódica de
reserva. Depois baixa o PDF ou o ZPL de cada etiqueta.

**Imprimir etiquetas** gera um PDF único com, para cada embalagem:

- a etiqueta da transportadora (layout do Melhor Envio; o número do pedido
  vai em `options.reminder`, impresso fora da área de recorte);
- a etiqueta de conteúdo da Silmer (pedido, embalagem n de N, peso, medidas,
  tamanhos e quantidades, QR do pedido);
- a DACE, quando o pedido é sem NF-e.

A compra para em **Etiqueta pendente**, sem afetar os outros pedidos, nos
casos abaixo.

| Motivo | Saída |
| --- | --- |
| Falta dado do destinatário | Aviso à vendedora dona da conversa |
| Pedido marcado com NF-e, sem a chave | "Informar chave da NF-e" |
| Compra recusada por saldo | Aviso ao gestor para recarregar (Pix pela API) |
| Custo real acima da tolerância | Decisão do gestor antes de comprar |

### 2.6 Nota fiscal

Por padrão, a nota é **decidida em cada pedido**. Sem nota, o Melhor Envio
gera a declaração de conteúdo eletrônica (DC-e/DACE). Com nota, a chave da
NF-e entra antes de embalar.

O menu tem a opção "Sempre com NF-e" para quando a Silmer passar a emitir em
toda venda. O CRM não emite nota nem decide a regra fiscal.

### 2.7 Rastreio

"Postado" e "entregue" chegam pelo webhook, com HMAC em `x-me-signature`,
nunca por clique. O código de rastreio vira uma mensagem sugerida na
conversa, enviada com um toque. O envio automático fica desligado por
padrão. "Entregue" sugere o "Entregue em", que ainda pede confirmação humana
(ADR 039).

### 2.8 Menu Melhor Envio

O menu lateral ganha a entrada **Melhor Envio**, só para o gestor
(`COMMERCIAL_ADMIN`). Ela tem estas seções:

- **Nos pedidos:** liga ou desliga a opção.
- **Conta:** conexão OAuth, renovação e "Adicionar saldo por Pix". A API não
  informa o saldo.
- **Remetente:** razão social, CNPJ, IE, endereço e telefone, enviados em
  cada chamada.
- **Nota fiscal**.
- **Embalagens:** tipo, medidas, peso da embalagem, carga máxima e "cabe em",
  com os limites lidos de `/me/shipment/services`.
- **Peso por peça**.
- **Etiqueta:** PDF do Melhor Envio ou ZPL; etiqueta de conteúdo ligada ou
  não.
- **Transportadoras**.
- **Regras:** quem tem Expedição e a tolerância de diferença.

## 3. Arquitetura proposta

- **Módulo próprio**, `modules/shipping-melhor-envio` (nome a confirmar). Ele
  concentra o domínio de envio (forma de entrega, embalagens, cotação,
  etiquetas, eventos) e um adapter HTTP do Melhor Envio. Pedidos conhece só a
  forma de entrega e o frete, por contrato. A fronteira entra em
  `scripts/check-boundaries.mjs`.
- **Sem infraestrutura nova.** Usa o Postgres, a API e o worker que já
  existem. O webhook entra na API com verificação HMAC e a caixa de entrada
  idempotente de webhooks que já existe. A espera pela geração e o download
  dos arquivos rodam no worker. Sem Redis e sem serviço separado.
- **Idempotência.** A chave de compra é pedido + embalagem + versão da
  embalagem. A compra registra o id do item do Melhor Envio antes do
  checkout, e uma nova tentativa nunca compra duas vezes. `tags` leva o id do
  pedido para reconciliar.
- **Segredos e dados pessoais.** Client secret, tokens (acesso de 30 dias e
  refresh de 45) e o segredo do webhook ficam nas variáveis do EasyPanel e no
  catálogo de segurança. CPF, CNPJ e endereço do destinatário são
  criptografados como a logística da qualificação. A tela mostra o documento
  mascarado para quem não tem Expedição. Nada disso vai para log.
- **Auditoria.** Registra quem marcou Embalado, cada compra (valor cotado ×
  real), cada cancelamento, cada diferença absorvida e cada decisão do
  gestor.
- **Permissões.** Duas capacidades novas complementam o ADR 042:
  - Expedição: embalar, pesar, imprimir e marcar "Pronto para retirar", sem
    acesso a preço;
  - menu Melhor Envio: `COMMERCIAL_ADMIN`.
- **Marcos novos.** "Embalado", "Comprada", "Gerada", "Postado" e "Pronto
  para retirar" são marcos do pedido e não mudam `pendente`/`confirmado`.

## 4. Impacto nas regras e decisões existentes

| Fonte | Impacto |
| --- | --- |
| RULES 5 / ADR 009 | Mantidas. O agente não cota, não fala de frete e não altera valor |
| RULES 10, 13 / ADR 020 | O Valor final passa a ter partes (peças + frete). Pede um ADR que complemente o ADR 020 |
| RULES 16 | O frete não conta como venda. O Painel mostra o valor das peças e o frete separados |
| RULES 20 / ADR 042 | Capacidade Expedição e menu Melhor Envio. Pede um ADR que complemente o ADR 042 |
| RULES 21 / ADR 027 | O pedido da loja continua com retirada e travado. Trocar para envio fica fora desta RFC |
| RULES 17 | CPF/CNPJ do destinatário: retenção e mascaramento a aprovar pelo Responsável de Privacidade |
| ADR 039 | "Entregue em" continua humano. O webhook só sugere |

## 5. Requisitos propostos

| ID | Requisito |
| --- | --- |
| MEV-01 | Todo pedido responde "Como o cliente recebe?" com Retirada na loja ou Transportadora pelo Melhor Envio, sem pré-seleção. A loja do site nasce com retirada |
| MEV-02 | Um CEP na mensagem do cliente vira um controle focável que abre a cotação sobre a conversa, com cidade/UF, quantidade de peças e serviços com valor e prazo |
| MEV-03 | "Escrever resposta com o frete" preenche o campo de resposta com quantidade e validade, sem enviar. O agente nunca cota nem envia frete |
| MEV-04 | A cotação fica no pedido como frete estimado com origem, e não entra no total. Ela fica desatualizada quando a grade ou o CEP mudam |
| MEV-05 | "Gerar o pedido" pede o valor das peças e uma opção de frete, sem pré-seleção, e mostra a soma. Grátis, "já no preço" e valor abaixo do cotado seguem a mesma alçada |
| MEV-06 | O pedido pelo Melhor Envio tem embalagens com tipo cadastrado, peso, conteúdo da grade e valor declarado. A soma bate com a grade |
| MEV-07 | Marcar Embalado (capacidade Expedição) compra, gera e baixa uma etiqueta por embalagem, sem passo humano no Melhor Envio, de forma idempotente |
| MEV-08 | A compra para em "Etiqueta pendente" com motivo e ação própria: dado faltando, chave da NF-e, saldo ou tolerância |
| MEV-09 | "Imprimir etiquetas" gera um PDF com a etiqueta da transportadora, a etiqueta de conteúdo da Silmer e a DACE (quando é sem NF-e), por embalagem |
| MEV-10 | A diferença entre real e cotado até a tolerância é absorvida e registrada. Acima dela, decide o gestor. O Valor final confirmado não muda |
| MEV-11 | "Postado" e "entregue" vêm só do webhook assinado. O rastreio vira mensagem sugerida, e "Entregue em" continua humano |
| MEV-12 | Há alerta para etiqueta gerada e não postada no prazo, e para pedido que mudou para retirada com etiqueta comprada, com "Cancelar etiqueta" |
| MEV-13 | O menu Melhor Envio (`COMMERCIAL_ADMIN`) tem as seções da 2.8, e os limites das transportadoras vêm da API |
| MEV-14 | A NF-e é decidida por pedido por padrão, com a opção "Sempre com NF-e". O CRM não emite nota |
| MEV-15 | CPF/CNPJ e endereço do destinatário ficam criptografados e mascarados fora da Expedição, e nunca vão para log ou fixture |
| MEV-16 | Toda compra, cancelamento, absorção e decisão fica auditada com autor, horário e valores |

## 6. Alternativas consideradas

- **Frete base automático no pedido.** Era a hipótese inicial. Foi
  rejeitado: ficou em último lugar para 6 de 6 personas, fica velho quando a
  grade muda, permanece em pedido de retirada e duplica com o Valor final.
- **Botão "PDF Melhor Envio" que compra.** Rejeitado porque esconde o gasto.
  A compra passa a ser consequência explícita de "Embalado", e o próprio
  botão avisa o valor.
- **Compra manual no painel do Melhor Envio.** É o estado atual. Rejeitado
  por não atender ao "pronto como na Shopee".
- **Integração pelo n8n.** Rejeitada: a compra gasta dinheiro e pede
  idempotência, auditoria e permissão no domínio do CRM.
- **Tela de Configurações genérica.** Substituída pelo menu Melhor Envio, por
  decisão do PO.
- **Térmica direta (ZPL) como padrão.** Adiada: exige um agente de impressão
  local. O PDF do Melhor Envio é o padrão.

## 7. Decisões em aberto

| # | Decisão | Proposta |
| --- | --- | --- |
| D1 | Quem tem Expedição. Há teto para compra delegada? | Gestor dá por nome; sem teto no MVP, com auditoria |
| D2 | Tolerância da diferença real × cotado | O menor entre R$ 20 e 10% do frete cobrado |
| D3 | Alçada para grátis, "já no preço" e abaixo do cotado | Aprovação do gestor acima de um valor a definir |
| D4 | O Valor final passa a ter partes. O Painel mostra peças e frete? | Sim, em ADR que complemente o ADR 020 |
| D5 | Mudar o frete depois de confirmado | Não reabre o pedido. Usa as saídas da MEV-10 |
| D6 | Declaração de conteúdo para venda com CNPJ contribuinte | Validar com o contador. O CRM só aplica a configuração |
| D7 | Validade da cotação no texto ao cliente | 3 dias corridos |
| D8 | Tabela de peso por peça e embalagens reais | A Silmer pesa 10 peças de cada tipo |
| D9 | Retenção do CPF/CNPJ do destinatário | A definir com o Responsável de Privacidade |

## 8. Fatias de entrega

| Fatia | Conteúdo | Depende de |
| --- | --- | --- |
| ME-0 | Conta sandbox, app OAuth, módulo e adapter de cotação, menu Melhor Envio (conta, remetente, embalagens, peso por peça) | D8 |
| ME-1 | Forma de entrega no pedido + cotação na conversa + "Escrever resposta com o frete" | ME-0 |
| ME-2 | Frete a lápis + Gerar com peças + frete | ME-1, D3–D5, ADR do Valor final |
| ME-3 | Destinatário estruturado e protegido + nota fiscal por pedido | D6, D9 |
| ME-4 | Embalagens no pedido, Expedição, compra/geração/impressão, pendências, auditoria | ME-2, ME-3, D1, D2, ADR de permissões |
| ME-5 | Webhook, rastreio sugerido, alertas, cancelamento | ME-4 |

**Antes da ME-0, testar no sandbox:**

- se o carrinho exige `document` e `company_document` ao mesmo tempo;
- o layout e o tamanho de página do PDF;
- se `note` aparece impresso;
- os limites de Loggi e J&T;
- os erros de saldo insuficiente no checkout.

## 9. Fatos da API usados

Fontes: documentação oficial (docs.melhorenvio.com.br) e o blog do Melhor
Envio, lidos em 28/10/2026.

- Cotação: `POST /api/v2/me/shipment/calculate`, 250 req/min por usuário.
- Compra: `/me/cart`, depois `/me/shipment/checkout` (saldo), depois
  `/me/shipment/generate` (assíncrono). Arquivos em
  `/me/imprimir/{pdf|zpl|jpeg}/{id}` e DACE em `/me/imprimir/dace/...`.
- Correios, J&T e Loggi aceitam um volume por item do carrinho. `products` e
  `insurance_value` são obrigatórios. Teto do PAC: R$ 3.000. Correios: até
  30 kg, lados até 105 cm, soma até 200 cm.
- Não há leitura de saldo. A recarga (`POST /me/balance`) gera Pix ou boleto.
- Não há parâmetro de A4 ou 10×15. Para térmica, ZPL.
- Envio comercial exige a chave da NF-e e a IE. A DC-e serve para pessoa
  física ou empresa não contribuinte de ICMS.
- Webhooks `order.*` com HMAC-SHA256 e 5 tentativas. Rastreio por etiqueta,
  e o código pode levar até 1 dia útil.
- Não há endpoint de coleta. A Coleta Loggi é agendada sozinha ao gerar.

## 10. Resultado

Pendente da revisão do PO e das decisões D1–D9. Depois da decisão, os ADRs
de Valor final (que complementa o ADR 020), permissões (que complementa o
ADR 042) e integração Melhor Envio registram o que for aprovado. Os
requisitos MEV entram então na spec de Pedidos.
