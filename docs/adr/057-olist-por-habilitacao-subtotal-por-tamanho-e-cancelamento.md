# ADR 057 — Olist por habilitação e subtotal por tamanho

Data: 04/11/2026. Status: decisões de produto aceitas pelo proprietário no chat.
Proposta e contrato de execução:
[RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Requisitos: OLIST-01–50. Tarefas: OLIST-PLAN-02 e OLIST-T01–T26 na RFC e no
[plano macro](../../.specs/features/crm-mvp/tasks.md).
Issue/PR específica: não criada nesta etapa documental.

## Contexto

A redigitação de vendas pode ser substituída por geração sob demanda. O PO
revisou o plano inicial: não será exclusivo do responsável nem limitado a
cadastros existentes; preços passam a ser subtotais por tamanho no CRM.
Também solicitou cancelamento para higiene/métricas e novos rótulos na ficha.

Há dois níveis distintos: item do CRM é o grupo da peça com atributos comuns;
linha de tamanho é tamanho/quantidade/subtotal e corresponde ao item comercial
da venda Olist. Não achatar esses conceitos ou trocar o significado de items.

## Decisões

1. Cada usuário possui checkbox **Habilitado Olist**, gerido administrativamente,
   default falso. Humano ativo habilitado pode gerar em qualquer Pedido completo,
   independentemente de perfil, dono, origem ou status comercial. Admin não
   herda geração sem checkbox. A capacidade concede projeção/operação Olist,
   sem Inbox, edição comercial geral ou administração ERP implícitas. A entrada
   Olist localiza Pedido por número/ID exatos sem depender da fila Financeiro.
2. Ficha/cadastro completos são o gate de geração, verificados por validador
   próprio. Confirmado ou missingFields vazio não prova que cadastro, dinheiro
   e novos campos estão completos. Cancelado/enviado/vinculado/incerto não
   autoriza nova geração. Exportar não confirma automaticamente Pedido CRM.
   Como regra técnica, usar orderDate existente na venda ERP ou, se ausente,
   dia operacional de São Paulo do comando aceito, congelado entre tentativas.
3. Ao gerar, buscar cliente comprador e produto/variações/tamanhos; criar
   ausentes com dados válidos do CRM e parâmetros explícitos. “Usuário” na
   busca do comprador significa cliente, não conta de acesso ao ERP. Guardar
   vínculos por conta/identidade; não selecionar por nome parecido ou fabricar
   dados fiscais. Conectar todos os atributos verificáveis, sem sobrescrever
   cadastro existente por divergência silenciosa.
4. O vendedor informa **subtotal por linha de tamanho**, para permitir desconto
   conforme quantidade. Quantidade × preço unitário não é o modelo de entrada.
   Total do grupo soma linhas; total do Pedido soma grupos, calculado pelo
   backend. Não há total final independente digitado na confirmação ou no Olist.
   Mudança de quantidade exige revisão humana do subtotal.
5. Unitário ERP é uma derivação de subtotal/quantidade, com precisão e
   arredondamento comprovados por linha. Se não representável, bloquear apenas
   exportação e manter validade comercial CRM. Não mudar subtotal/quantidade,
   inventar desconto, repartir resíduos, dividir linha artificialmente ou
   compensar diferença entre linhas. Não atualizar preço de catálogo encontrado.
6. Pedidos antigos preservam total/snapshot. Sem composição por tamanho,
   enriquecimento humano autorizado/versionado precisa fechar com o total
   existente; não inferir subtotais dividindo o total. Loja preserva checkout,
   gateway e travas, usando adapter/complemento específico para dados faltantes.
7. A operação comercial ERP começa centralizada na operadora designada, com
   parâmetros por conta, versionados e auditados, preparada para múltiplos
   operadores futuramente. Não inferir vendedor/comissão ERP pelo dono CRM.
   IDs/natureza/vencimento/situação reais e efeitos da conta são verificados
   na preparação operacional; não são valores definidos por este registro.
8. Após envio, não há edição/sincronização/reabertura para editar nem
   cancelamento remoto nesta entrega. Confirmação posterior de pendente só
   congela conteúdo idêntico. Cancelamento no CRM é anterior à exportação,
   terminal, motivado/auditado e sem exclusão física, destinado à higiene,
   métricas e filas. Não é estorno, devolução ou cancelamento fiscal/ERP.
9. Cancelados saem dos universos ativos de vendas/valor vendido, afazeres,
   produção/entrega e Financeiro, preservando dados, snapshots, pagamento,
   check e auditoria consultáveis no escopo autorizado. Checkbox não concede
   cancelamento de qualquer Pedido: permanece a autorização comercial própria.
   A representação técnica proposta usa marcador terminal separado dos dois
   status comerciais; T23 deve validar schema e contratos antes do código.
10. O piloto tem **uma única conta operadora**, identificada pelo PO neste
    chat. Validar conta CRM ativa e guardar ID em configuração privada mais
    checkbox. Nome/e-mail não são constantes versionadas nem critérios de
    autorização permanentes. Esta decisão não habilita conta real por si só.
11. **Entrega prometida** passa a **Previsão de entrega**; **Técnica**, campo 4
    por grupo, passa a **Aplicação**. Preservar chaves/data/semântica por item,
    sem reativar summary.aplicacao legado. UI, mensagens, ARIA e ficha mudam.
    Criar ficha-canonical-v7/amostra/seleção próprias; v2–v6 e hashes são
    imutáveis. Não acrescentar valores monetários à impressão por inferência.

## Desenho técnico e alternativas

Tech Lead mantém a API oficial no monólito, worker e PostgreSQL existentes.
Alternativas n8n dedicado e MCP acrescentariam um contrato/camada desnecessário
ao botão; n8n continua obrigatório para canais, IA e jornada, sem banco direto.
Não há nova infraestrutura, framework ou store global.

Cada cliente, produto pai, variação e venda é um efeito externo independente.
Reservas por identidade são compartilhadas entre Pedidos. Snapshot, auditoria
e publicação do trabalho são atômicos localmente; incerteza de um recurso
bloqueia dependentes, sem recriação ou compensação destrutiva. Revogar checkbox
impede o próximo efeito, mas não dispensa persistir/reconciliar efeito iniciado.

## Relação com decisões anteriores

Supersede o adiamento Olist das ADRs 040/042 e a recomendação original da RFC
044 de cadastro apenas existente, preço unitário na prévia e posse do Pedido.
Emenda PFI-11/PFI-19 e contratos de valor digitado para o novo modelo calculado.
Preserva dados legados e trilha de confirmação; não reescreve ADRs anteriores.

Complementa ADR 006 com cancelamento terminal sem exigir terceiro status;
complementa ADR 032 com capacidade Olist entre responsáveis, sem edição geral.
Emenda apenas os rótulos das ADRs 020/025 e sua seleção futura de ficha, com
versões históricas intactas. Regras da loja/gateway continuam preservadas.

## Implantação e gates

Registro documental concluído não comprova implementação. As 26 tarefas da
RFC cobrem dados/checkbox, subtotal/legado/loja, cadastros/venda, cancelamento,
UI/ficha v7, QA e piloto individual. Faltam prova de contrato fiscal/precisão,
parâmetros reais, retenção operacional, amostra v7 e evidências do ambiente.

Deploy automático GitHub → EasyPanel permanece. Desabilitar criação/cadastros
como primeiro rollback; preservar vínculos e reconciliar recursos da janela.
Não cancelar ERP ou apagar cliente/produto/venda como rollback técnico.
Código anterior só retorna se conservar novas guardas e compatibilidade de dados.
