# RFC 049 — Cobranças do pedido com InfinitePay

Data: 05/11/2026. Status: aprovada após protótipo. Responsável: Tech Lead.
Revisão: Integrações/Confiabilidade e QA, somente leitura.

Decisão: o proprietário avaliou o protótipo navegável e autorizou implementar
em 05/11/2026: “Gostei, faça”. Registro durável na
[ADR 058](../adr/058-cobrancas-do-pedido-com-infinitepay.md); contrato aprovado
[COB-01–16](../../.specs/features/order-billing/spec.md) e execução em
[COB-DEL-01](../../.specs/features/order-billing/tasks.md). O restante conserva
o contexto da proposta original, sem representar ativação real.

## Demanda e definições do proprietário

Integrar a geração de cobrança no CRM usando a InfinitePay, como na loja do
site da Silmer. O proprietário definiu:

- Condições de **0%, X% e 100%**.
- Pagamento por **Pix e cartão**.
- **100% significa pagamento integral do pedido, inclusive parcelado pela
  InfinitePay**. Após descrever como à vista, o proprietário esclareceu
  expressamente que permite parcelamento na InfinitePay. O pedido fica integralmente
  quitado com o pagamento integral aprovado pelo gateway, independentemente
  do parcelamento do comprador.

Parcelamento do cartão e sinal comercial são coisas diferentes. Um sinal
de 30% pago no cartão continua sendo somente 30% do pedido, mesmo que a
InfinitePay tenha aprovado integralmente aquela cobrança.

Esta RFC transforma a demanda em um fluxo revisável antes de mudar os
contratos vigentes. A integração foi solicitada; as escolhas técnicas e a
interpretação operacional de 0% abaixo são propostas. Não há implementação,
ativação ou cobrança real nesta entrega de análise, `COB-T00`.

## Evidência do estado atual

O grafo local de 04/10/2026 foi usado como mapa; a descoberta foi confirmada
nas fontes atuais do CRM, revisão `e77a286a`, e no checkout local do site:

- [ADR 028](../adr/028-pedido-pago-da-loja-pelo-n8n.md),
  [contrato n8n](../integrations/n8n/README.md#pedido-pago-da-loja-adr-028)
  e [runbook da loja](../runbooks/loja-do-site.md): o checkout usa n8n,
  verifica o pagamento no servidor e só depois registra um pedido da loja.
- No repositório irmão `silmer-web`, `INFINITEPAY-SETUP.md` e
  `docs/superpowers/specs/2026-10-10-loja-contrato-checkout-v3.md` documentam
  criação do link, confirmação por webhook/retorno e repetição da criação
  de links. São referências locais de descoberta, não novos contratos do CRM
  nem prova da versão atualmente publicada.
- [Serviço do pedido](../../modules/orders/src/application/order-service.js)
  e [runtime](../../apps/api/src/order-runtime.js): confirmação comercial
  humana, proprietário do pedido/conversa e comandos versionados.
- [Migration 0029](../../modules/database/migrations/0029_store_orders.expand.sql):
  campos atuais de gateway são exclusivos de pedidos `origin = loja`;
  há unicidade do NSU dentro dessa tabela.
- [Repositório financeiro](../../modules/orders/src/adapters/postgres-finance-repository.js):
  pedidos fora da loja podem qualificar por `paid_on`, sem comparação com um
  livro de recebimentos. Um sinal não pode preencher esse campo.
- [Migration 0043](../../modules/database/migrations/0043_order_finance.expand.sql)
  e [ADR 042](../adr/042-perfis-e-requitacao-do-financeiro.md): mudança do valor
  na reconfirmação invalida a quitação e o check financeiro anteriores.

Cobrança do atendimento continua diferida em
[PAY-01–05](../../.specs/features/crm-mvp/spec.md#p21-pix-e-boas-vindas--diferido),
nas ADRs 006/008 e na regra de produto 16. A exceção da loja não autoriza
reutilizar `store-orders` para cobrar um pedido que já existe.

## Fluxo comercial proposto

Começar na página do **pedido confirmado**, manual ou de atendimento, com
valor final e condição aprovados por pessoa autorizada. O pedido da loja
continua no checkout existente. A condição aparece em Cobranças, junto do
total, recebido confirmado e saldo daquele pedido.

| Condição | Comportamento proposto                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0%       | Sem entrada. Registrar a condição sem criar um link de valor zero. Quando o vendedor escolher cobrar, gerar a cobrança do valor integral ainda devido.                                         |
| X%       | Calcular a entrada escolhida sobre o valor final, mostrar reais antes da emissão e gerar somente a cobrança do sinal. Após a confirmação desse pagamento, permitir ao vendedor cobrar o saldo. |
| 100%     | Gerar uma cobrança pelo valor integral ainda devido. Pix ou cartão, inclusive parcelado pela InfinitePay, quitam o pedido quando o gateway confirmar o pagamento integral dessa cobrança.      |

Recomendação inicial: X inteiro entre 1 e 99; valores sempre em centavos;
arredondar o sinal para o centavo mais próximo e obter o saldo por subtração.
Exemplo sintético: R$ 100,01 com 30% → sinal R$ 30,00 e saldo R$ 70,01.
Validar o mínimo de R$ 1,00 do gateway tanto para o sinal quanto para o saldo
futuro; se a divisão produzir parte abaixo disso, recusar com orientação
para ajustar a condição ou cobrar integral. Não criar vencimentos, parcelas
comerciais sucessivas ou recorrência nesta primeira entrega.

Emitir exige ação consciente: escolher a condição, revisar percentual e
valor em reais e acionar **Gerar cobrança**. O CRM retorna o link salvo para
copiar ou abrir; não envia mensagens automaticamente. Na Inbox, o vendedor
pode compartilhar pelo fluxo humano já existente. Gerar um link não prova
envio; clicar no link não prova pagamento.

A cobrança do saldo é outra ação humana, depois do sinal confirmado. Em 0%,
o CRM não decide sozinho se deve cobrar na produção, retirada ou entrega.
Preços e condições continuam humanos; o agente não emite nem escolhe valores.

## Integração recomendada

Reaproveitar a conta e o Checkout Integrado, mantendo o caminho
**CRM → n8n → InfinitePay → n8n → API do CRM**. Usar fluxo dedicado de
cobranças de pedidos existentes, separado do checkout público da loja e do
workflow de atendimento. Não exigir nova infraestrutura ou acesso do n8n ao
banco do CRM.

1. A API autoriza e reserva a cobrança, seu snapshot comercial e o comando
   de emissão na mesma transação, com auditoria.
2. O worker entrega o comando ao n8n. Antes da chamada externa, uma reserva
   de uso único no CRM autoriza aquela tentativa; reentregar o comando não
   autoriza outra criação de link.
3. O n8n cria o checkout usando o ID da cobrança como `order_nsu` e devolve
   o resultado à API autenticada. A UI consulta o resultado persistido.
4. O webhook recebe apenas candidatos a pagamento. O n8n verifica com o
   gateway e registra o resultado na API, autenticado e idempotente.
5. O CRM aplica o recebimento à cobrança certa e calcula o saldo. Somente
   quitação integral do acordo comercial vigente pode preencher `paid_on`.

Esses são novos comandos de integração a especificar; a reserva de mensagem
da Inbox não deve ser reutilizada para um efeito financeiro. Encerrar ou
transferir uma conversa não pode apagar cobranças ou impedir confirmação de
pagamentos de links já compartilhados.

### Limites do provedor verificados em 05/11/2026

A [documentação oficial da InfinitePay](https://www.infinitepay.io/checkout-documentacao)
informa: o webhook não tem assinatura; confirmar cada aviso por
`payment_check`, com os identificadores da transação e da fatura, além da
cobrança. Não há garantia documentada de idempotência de criação nem consulta
de link apenas por `order_nsu`. `single_payment` e `valid_until` exigem API
Key. `assured_installments` define absorção de taxas, não limite de parcelas.
Cancelamento/estorno são operações no painel ou aplicativo. O mínimo de
pagamento é R$ 1,00.

Recomendação: links de uso único e validade explícita, inicialmente 24h,
com API Key somente no servidor/n8n. Preservar as condições de taxas da conta
até decisão comercial específica. Não inventar desconto, juros ou repasse;
apresentar o valor comercial separado do total eventualmente pago com taxas.
Verificar as configurações atuais da conta antes da homologação, sem alterar
as condições do checkout da loja.

## Modelo e invariantes propostos

Manter cobranças e recebimentos em entidades próprias, ligadas ao pedido.
Não escrever nas colunas exclusivas da loja nem criar outro status comercial.
O estado de uma cobrança não é o status do pedido.

Cada cobrança conserva ID, pedido, finalidade (integral/sinal/saldo),
percentual, principal em centavos, revisão comercial, autor, horário,
validade, tentativa externa e resultado. URLs privadas de checkout e
comprovante ficam cifradas; tokens e dados de cartão nunca entram no CRM.

O snapshot comercial precisa identificar a confirmação e suas condições;
não basta comparar a versão global, que também muda em operações sem impacto
financeiro. O recebimento conserva identificadores do gateway, principal
aplicado, total pago, método, parcelas, primeira verificação e revisão.
Taxas do cartão não viram crédito extra ou saldo negativo do pedido.

- Apenas uma cobrança não resolvida por pedido nesta primeira fatia. Repetir
  o comando retorna a mesma cobrança; outra chave não autoriza segunda
  cobrança concorrente pelo mesmo valor devido.
- Resultado externo desconhecido exige reconciliação; não recriar o link
  automaticamente. A reserva ocorre antes da chamada, inclusive em retries
  do n8n e após reinício do worker.
- Pagamento duplicado é um recebimento só. Impedir reutilização da mesma
  transação entre cobranças e pedidos da loja, com guarda transacional comum;
  dois índices únicos isolados não bastam.
- Alteração/reabertura preserva todo o histórico. Link antigo pago depois
  disso fica em revisão e não quita silenciosamente outro acordo. Não
  emitir outra cobrança enquanto o risco do link anterior não for resolvido.
- Invalidar ou expirar localmente não comprova cancelamento no gateway.
  Receber confirmação tardia continua obrigatório; registrar e reconciliar
  pagamento acima do devido, sem descartá-lo ou devolver dinheiro sozinho.
- Datas manuais legadas não se convertem em recebimentos de valor presumido.
  Pedido já marcado pago exige conciliação antes de entrar nesse fluxo.
  Para pedidos geridos pela integração, a edição manual de `paid_on` não
  pode contornar a prova de quitação, inclusive pela API antiga.
- Pagamento não confirma pedido nem libera impressão de pendente. O
  Financeiro mantém seu perfil e check humano de nota; o sinal não entra
  em sua fila como quitação integral.
- Devolução conhecida exige conciliação auditada, total ou parcial,
  preservando o recebimento original e invalidando quitação e elegibilidade
  financeira quando não houver cobertura. A primeira entrega pode usar
  registro humano autorizado após conferência no provedor, com orientação
  explícita no runbook; não prometer detecção automática de todo estorno.

## Critérios propostos — ainda sujeitos à decisão desta RFC

| ID     | Critério verificável                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| COB-01 | Responsável atual pelo pedido/conversa ou administrador pode configurar e emitir; usuário desativado, outro vendedor, perfil Financeiro e agente são recusados. Revalidar ACL sob lock, inclusive no replay.                               |
| COB-02 | 0% não emite link de zero; X% exibe sinal e saldo corretos; 100% cobra o integral. Valores inválidos, acima de 100%, parte abaixo de R$ 1,00, ausência de preço e pedido pendente são recusados; R$ 1,00 com sinal de 50% é caso negativo. |
| COB-03 | Pix e cartão são reconhecidos; parcelamento do cartão não gera parcelas comerciais no CRM nem altera o preço aprovado.                                                                                                                     |
| COB-04 | Sessão, CSRF, origem, idempotência e revisão protegem emissão; duas ações concorrentes produzem uma única reserva de cobrança.                                                                                                             |
| COB-05 | Repetição idêntica devolve o mesmo resultado; corpo divergente conflita; timeout após início do efeito permanece desconhecido, sem novo link automático.                                                                                   |
| COB-06 | Webhook/retorno forjado não quita. Conta, cobrança conhecida, fatura, NSU, método e valor são verificados no servidor; cobrança menor ou de outro pedido é recusada.                                                                       |
| COB-07 | Webhooks repetidos ou concorrentes com consulta de confirmação geram um único recebimento; comprovante tardio não duplica crédito nem muda o primeiro horário.                                                                             |
| COB-08 | O mesmo NSU não pode quitar loja e atendimento, ou duas cobranças. Recebimento, deduplicação, aplicação e auditoria compartilham transação.                                                                                                |
| COB-09 | Sinal confirmado mantém saldo e não preenche `paid_on`; somente o integral conciliado permite quitação. Taxas não aumentam o crédito comercial.                                                                                            |
| COB-10 | Reabertura, mudança de preço e pagamento tardio conservam histórico e exigem revisão do acordo anterior. O trigger financeiro vigente não é contornado.                                                                                    |
| COB-11 | APIs antigas de datas não podem declarar quitado um pedido gerido pela integração com saldo pendente. Migração preserva datas legadas sem inventar recebimentos.                                                                           |
| COB-12 | UI reutiliza design e componentes atuais, com teclado, foco, nomes acessíveis, celular e anúncios de processamento, pagamento, falha e resultado desconhecido.                                                                             |
| COB-13 | URLs somente HTTPS e hosts autorizados; credenciais, payloads, URLs privadas e PII ficam fora de log/auditoria. Consulta respeita o acesso ao pedido; não há tela financeira pública por ID.                                               |
| COB-14 | Reentrega, falha entre reserva e resposta, falha de auditoria e callbacks tardios são recuperáveis. Confirmar recebimento só após persistência durável ou deixar falha para reentrega.                                                     |
| COB-15 | Rollback impede novas emissões, mas mantém confirmação e reconciliação dos links existentes. Desligar a UI não interrompe o recebimento desses eventos.                                                                                    |
| COB-16 | Devolução conhecida, total ou parcial, é conciliada por comando humano autorizado, versionado e auditado; preserva o pagamento original e invalida quitação/check financeiro quando afetados. Repetição não duplica abatimento.            |

## Alternativas

- **Reutilizar o endpoint da loja:** rejeitado como proposta. Ele cria outro
  pedido confirmado e usa catálogo próprio, em vez de cobrar o pedido
  existente; há travas e campos exclusivos que precisam ser preservados.
- **Gerar diretamente pela API do CRM:** possível, mas cria outro caminho
  de integração com a InfinitePay. Preferir reaproveitar a experiência do
  n8n da loja com reservas oficiais no CRM e fluxo dedicado.
- **Copiar a Data Table e os retries da loja:** insuficiente para sinal,
  saldo e concorrência. Estado oficial e consumo de efeito precisam ficar
  no CRM; a Data Table não é fonte de recebimentos ou saldo.

## Rastreabilidade e entregas

Base: PAY-01–05 diferidos, ORD-01–05, FIN-01–03 e PRV-01–03 da
[spec principal](../../.specs/features/crm-mvp/spec.md),
[FINQ-01–19](../../.specs/features/financeiro/spec.md),
ADRs [006](../adr/006-pedido-dois-status.md),
[008](../adr/008-lastro-de-datas-do-pedido.md),
[028](../adr/028-pedido-pago-da-loja-pelo-n8n.md) e
[042](../adr/042-perfis-e-requitacao-do-financeiro.md).

| Tarefa  | Entrega e evidência esperadas                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COB-T00 | Investigar checkout existente, consolidar definições do PO e preparar esta RFC com revisão de confiabilidade/QA; sem runtime ou ativação.                                                           |
| COB-T01 | Decidir esta RFC, publicar spec e ADR vinculados; emendar explicitamente RULES, PRD, spec principal, ARCHITECTURE e TECHNICAL-DESIGN para o novo recebimento de pedidos fora da loja.               |
| COB-T02 | Modelo, migrações expand, ACL, transações, livro de recebimentos, unicidade global e proteção dos comandos legados. Testes reais em PostgreSQL sintético, incluindo concorrência com loja e edição. |
| COB-T03 | Comandos, reserva de efeito e workflow dedicado; criação e verificação InfinitePay, replay, timeout incerto, persistência de callbacks, falhas e reconciliação.                                     |
| COB-T04 | Cobranças na página do pedido e compartilhamento humano pelo link; verificar teclado, foco, estados, temas e celular, com testes E2E/axe.                                                           |
| COB-T05 | Gates completos, runbook, segredos, homologação na conta correta, publicação ordenada e rollback com links ativos. Evidência local não substitui pagamento real autorizado.                         |

Issue/PR: ainda não criadas para esta proposta; vincular na entrega
respectiva. ADR correspondente: pendente da decisão. Requisitos COB e tarefas
de implementação acima são propostos, não capacidade entregue.

## Pontos para a decisão

Confirmar o fluxo proposto de 0% (sem entrada, cobrança integral posterior por
ação humana), X% (sinal e depois saldo) e 100% (integral, com Pix ou cartão
inclusive parcelado); a primeira fatia em pedidos confirmados; e o fluxo
dedicado no n8n com estado oficial no CRM. A condição do cartão já foi
esclarecida pelo proprietário; não voltar a exigir 1x.

Após a decisão, a implementação precisa manter recebimentos, saldo e
quitação coerentes com o Financeiro e a reconfirmação. A RFC não transforma
as regras antigas de chave Pix, comprovante manual e boas-vindas de PAY-01–05
em requisitos automaticamente aprovados desta integração.
