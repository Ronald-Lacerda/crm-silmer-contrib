# Gerar venda Olist a partir de pedido confirmado

Decisão do proprietário em 10/11/2026: no detalhe de um Pedido confirmado,
acionar **Gerar no Olist** e acompanhar a criação da venda na mesma página.
Contrato vigente da revisão 3 da [RFC 050](../../../docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md),
registrado na [ADR 079](../../../docs/adr/079-olist-a-partir-do-pedido-confirmado.md).
Tarefas em [tasks.md](tasks.md); execução em blocos no
[documento de prompts](../../../docs/integrations/olist/prompts-pedido-confirmado.md).

O recorte substitui os requisitos anteriores apenas onde indicado abaixo.
OLIST-PLAN-03 registra esta especificação; as tarefas OLC-T01–T06 são de
implementação e operação, ainda não concluídas. A prova F1 de centavos exatos
e o código puro de cálculo/conferência existentes são insumos reutilizáveis.

## Decisões do PO em 10/11/2026

1. **Refatoração.** O Olist passa por refatoração conforme os blocos 1–6 do
   documento de prompts. Este pacote OLC é a direção vigente e prevalece sobre
   o que a master já tem de Olist onde houver divergência; o runtime existente
   é ponto de partida e de reaproveitamento.
2. **Total do Pedido.** Vale a regra da ADR 057 (itens 4 e 6): o vendedor
   informa o subtotal de cada linha de tamanho e o valor final é a soma dos
   subtotais, calculada pelo backend, mais o frete quando existir no Pedido.
   Não há regra de que a composição por tamanho iguale um total confirmado em
   Pedido novo; a igualdade com o total existente vale só para enriquecer
   Pedido antigo ou da loja que possui apenas total.
3. **Cancelamento local** só para Pedido não confirmado (`pendente`);
   supersede parcialmente a ADR 068. A restrição do código já entregue é
   OLC-F03, em tarefa própria. Os filtros de cancelamento seguem como gate de
   liberação.
4. **Financeiro.** A remoção da feature (código, mantendo tabelas e dados) foi
   aprovada e segue em FINQ-DEPREC-01, independente de OLC-T01–T06.

## Jornada e interface

1. A pessoa entra em Pedidos e usa **Abrir pedido**, ou chega ao mesmo detalhe
   por um acesso comercial já autorizado.
2. O cabeçalho mantém o número CRM e **Confirmado**. Um bloco Olist exibe
   pendências, processamento ou resultado, sem mudar o status comercial.
3. Havendo dados faltantes, o bloco indica campo, peça/tamanho e ação possível.
   A pessoa corrige pelos comandos autorizados de origem e salva. Se não pode
   corrigir, vê o responsável pela correção, sem ganhar acesso adicional.
4. Sem pendências e com conexão/autorizações válidas, **Gerar no Olist** aceita
   a operação diretamente. A validação prévia é interna ao comando; não há
   tela de prévia, assistente ou confirmação adicional obrigatória.
5. A mesma página mostra **Processando…**, com a etapa atual, e depois
   **Gerado no Olist · Venda nº …**, junto ao número do Pedido CRM.
   Recarregar a página recupera o estado persistido.

O botão existente **Gerar pedido** continua sendo a confirmação comercial.
**Gerar PDF** continua gerando a ficha. O novo botão não reutiliza nenhum
desses comandos nem exige que o PDF já tenha sido gerado ou baixado.

## Requisitos e aceite

| ID     | Critério                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OLC-01 | Somente Pedido com status `confirmado` pode iniciar geração. `pendente` é recusado também pela API e pelo worker, inclusive em replay ou mudança concorrente. O status é o mesmo que habilita comercialmente o PDF; não exigir geração anterior, bytes do PDF, primeira impressão ou aprovação de novo template para integrar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| OLC-02 | A entrada é o detalhe existente, sem novo menu/listagem/busca Olist. Geração exige humano ativo, acesso comercial existente ao Pedido e checkbox **Habilitado Olist** ativo, default falso e gerido por Admin. Admin também precisa do checkbox. Preservar piloto por ID privado. Não conceder Inbox, edição geral ou nova projeção ao perfil Financeiro.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| OLC-03 | Não exigir quitação, check Nota criada ou conclusão do Financeiro. Não confirmar pedido, registrar pagamento, emitir nota, movimentar estoque, enviar mensagem ou mudar métricas comerciais como efeito da exportação. InfinitePay e Financeiro preservam seus contratos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| OLC-04 | Compor os dados estruturados do Pedido confirmado, comprador e configuração central da conta. Validar explicitamente cadastro exigido pelo ERP e itens/grade, independentemente de `missingFields` vazio. Não ler o PDF nem enviar arte, anexos ou conversa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OLC-05 | Preservar `finalAmountCents`, confirmação, número e snapshot/ficha históricos. Derivar IDs e grade no servidor e vincular a composição 1:1 aos grupos/tamanhos/quantidades confirmados, sem permitir que o enriquecimento altere grade ou atributos. Cada linha de tamanho precisa de subtotal revisado. Pedido novo: o valor final é a soma dos subtotais calculada no backend (ADR 057 itens 4 e 6), mais o frete quando existir no Pedido; não há total digitado nem exigência de igualar outro total. Pedido antigo ou da loja que só tem total: se faltam subtotais, permitir composição humana autorizada no detalhe, por comando específico versionado/auditado, sem reabrir ou reprecificar o Pedido; essa composição deve somar exatamente o total existente (ADR 057 item 6). Diferença bloqueia; não ratear automaticamente. |
| OLC-06 | Reutilizar `size-pricing.js` e `olist-exact-cent.js`. Subtotal positivo em centavos e quantidade inteira positiva; unitário derivado exato, sem arredondamento. Uma linha inexata bloqueia a operação inteira antes de inclusões. Não compensar linhas, alterar negociação ou aceitar soma parcial como total. Mudança de quantidade exige nova revisão.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OLC-07 | Resolver/reutilizar cliente comprador, produto pai e variações corretos; criar ausentes com dados válidos e reservas compartilhadas por identidade/conta. Persistir IDs por etapa. Não sobrescrever cadastros encontrados nem criar usuário de acesso do comprador. Essa resolução automática integra a entrega mínima.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| OLC-08 | Conexão/configuração central administrada com sessão, CSRF, conta esperada, credenciais cifradas e renovação serializada. Parâmetros comerciais explícitos/versionados; não inferir vendedor ERP pelo responsável CRM nem inventar dados fiscais. Revalidar permissões antes de cada efeito.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OLC-09 | Aceitação transacional congela versão/snapshot/configuração, reserva a operação e grava auditoria/job no PostgreSQL existente. Uma operação por conta/Pedido; referência estável e unicidade do ID remoto. Duplo clique, duas abas, chaves diferentes e reload não criam segunda venda. Usar API/worker existentes, sem nova infraestrutura.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OLC-10 | Antes de cada inclusão, revalidar status confirmado, revisão/fingerprint do conteúdo comercial exportável, configuração, conexão, habilitação e piloto. Mudança compatível de pagamento/entrega não invalida exportação apenas por incremento da versão global; revalidar conteúdo ou usar revisão relevante própria, sem ignorar divergência comercial. Alterações incompatíveis/reabertura serializam com a reserva: se ocorreram antes, invalidar o comando; após reserva, bloquear o comando comercial incompatível. Após sucesso, não reabrir para editar nem corrigir quantidade da loja por outro endpoint. Pagamento e entrega conservam suas ações independentes quando compatíveis.                                                                                                                                           |
| OLC-11 | Após resultado possivelmente remoto, timeout/crash/5xx/resposta sem ID não autoriza repetir inclusão. Persistir `outcome_unknown` e bloquear dependentes. Recuperação mínima administrativa por Pedido/recurso faz leituras e associa resultado comprovado; zero em busca não prova ausência. Não exigir painel amplo ou vínculo de vendas antigas para fechar esta entrega.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OLC-12 | Só declarar sucesso após conferir conta, referência, comprador, identidade das linhas/produtos, quantidades, unitários e totais exatos (o total do Pedido, soma dos subtotais mais frete quando existir, contra os totais retornados pelo ERP). Divergência preserva ID e exige conferência, sem segunda venda. Manter histórico de etapas/atores sem PII ou segredo em log/auditoria.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| OLC-13 | UI e API expõem os estados abaixo, próxima ação e motivo seguro. Pendências identificam a origem; teclado, foco, labels, ARIA, temas e celular seguem os componentes atuais. Duplo clique é prevenido na UI e no servidor. Falha de leitura nunca aparece como sucesso ou ausência de operação.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OLC-14 | Loja e legados não são excluídos genericamente. Usar snapshot/adapter próprio, sem mudar checkout, pagamento, ficha original ou inventar Contato. Complemento necessário à exportação é aditivo/autorizado e restrito aos dados ERP. Sem dados suficientes, bloquear com pendência legível. Não condicionar Olist a uma reforma global de preços.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OLC-15 | Testes negativos/concorrentes e regressão cobrem PDF, confirmação/reabertura, composição monetária, loja, permissões, billing e Financeiro preservados. Deploy exige conta/configuração, digest, migrations, health e ensaio de recuperação, além dos filtros de cancelamento (cancelados fora dos universos ativos) validados como gate de liberação; piloto real requer caso e efeitos concretos autorizados, conferência linha a linha e aceite operacional.                                                                                                                                                                                                                                                                                                                                                                         |
| OLC-16 | Remoção do Financeiro (aprovada pelo PO em 10/11), restrição do cancelamento local a Pedido não confirmado (OLC-F03), busca/menu Olist, prévia detalhada obrigatória, vínculo genérico de vendas antigas, reforma global de preços e troca de ficha/rótulos são trilhas independentes. Nenhuma bloqueia OLC-T01–T06. Permanece obrigatória a recuperação mínima de efeitos incertos da própria operação.                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Estados visíveis e ações

| Estado persistido ou condição                 | Texto na interface                          | Ação                                                                                                 |
| --------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Pendente                                      | Disponível após confirmar o pedido          | Sem geração; confirmação segue o fluxo comercial atual                                               |
| Confirmado e não exportado, apto              | Ainda não gerado no Olist                   | **Gerar no Olist**                                                                                   |
| Confirmado com dados/composição ausentes      | Complete os dados para gerar no Olist       | Correção autorizada no contexto; geração bloqueada                                                   |
| Subtotal inexato                              | Valor do tamanho não representável no Olist | Identificar linha; não ajustar automaticamente                                                       |
| Sem conexão ou configuração                   | Integração Olist indisponível               | Administrador corrige conexão; preservar Pedido                                                      |
| `queued`                                      | Aguardando processamento                    | Consultar estado; sem novo envio                                                                     |
| `resolving_customer`                          | Processando… Cliente                        | Consultar progresso                                                                                  |
| `resolving_products`                          | Processando… Produtos e tamanhos            | Consultar progresso por variação                                                                     |
| `sending`                                     | Processando… Venda                          | Sem edição incompatível ou novo envio                                                                |
| `succeeded`                                   | Gerado no Olist · Venda nº …                | Consultar número e histórico; sem novo envio                                                         |
| `failed_safe`                                 | Não foi possível concluir esta etapa        | Corrigir/revalidar; **Retomar geração** só com prova de ausência de efeito e reutilizando a operação |
| `outcome_unknown` / `reconciliation_required` | Conferência necessária                      | Mostrar etapa; sem **Tentar novamente** criador; recuperação administrativa                          |
| Falha ao carregar estado                      | Não foi possível consultar a integração     | **Atualizar situação** apenas relê o CRM; não cria venda                                             |

Revogação ou mudança concorrente mostra motivo seguro e interrompe o próximo
efeito; um efeito iniciado continua exigindo reconciliação. Desbloqueio de
edição só após prova de ausência de efeitos incompatíveis, nunca por timeout.

## Separação de entregas

- **Entrega principal:** OLC-T01–T06 em [tasks.md](tasks.md).
- **Remoção independente:** FINQ-DEPREC-01 em
  [Financeiro](../financeiro/tasks.md), aprovada pelo PO em 10/11/2026: remove
  o código, mantém tabelas e dados; preservar dependências e histórico.
- **Futuro sem dependência reversa:** OLC-F01–F04 em [tasks.md](tasks.md).
- **Preservar trabalho atual:** FPI-T01–T04 em
  [ficha-por-item](../ficha-por-item/tasks.md). Olist não altera o seletor
  de impressão nem redefine aprovação da amostra.

## Cenários mínimos de aceite

1. Confirmado completo e habilitado gera uma venda e mostra ambos os números;
   pendente e usuário sem checkbox são negados pela API, sem inclusão remota.
2. Confirmado sem documento ou, se for Pedido antigo/da loja, sem subtotais
   aponta pendências; a composição correta fecha com o total histórico sem
   alterar PDF, e divergência/fração bloqueia tudo. Pedido novo usa a soma dos
   subtotais (mais frete quando existir), sem igualar total digitado.
3. Mesmo comprador/produto em dois pedidos usa reservas compartilhadas;
   tamanho M em dois grupos mantém identidade própria e valores corretos.
4. Duas abas, duplo clique e resposta perdida recuperam a mesma operação;
   falha após criar cliente/variação preserva IDs, sem recriação.
5. Timeout, criação remota com falha local e retorno divergente exigem
   conferência; recuperação não faz novo POST por ausência em uma busca.
6. Reabertura/correção da loja e revogação concorrentes têm ordem verificável;
   não enviam conteúdo obsoleto nem permitem alterar Pedido já exportado.
7. Recarregar, teclado, leitor de tela e celular mantêm progresso e foco;
   sucesso só aparece após conferência exata. Financeiro/billing/PDF continuam
   funcionando sem remoção de módulo ou ativação de ficha nova.
