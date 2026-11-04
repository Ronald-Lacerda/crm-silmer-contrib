# Financeiro — Fila e detalhe

## Emenda Olist e cancelamento de 04/11/2026

[ADR 057](../../../docs/adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
/ [RFC 044](../../../docs/rfc/044-geracao-assistida-de-pedidos-no-olist.md),
OLIST-02/19/33/45–47 / OLIST-PLAN-02: contrato para implementar.

Habilitado Olist é capacidade ortogonal também ao perfil Financeiro: concede
somente projeção/operação Olist de Pedido completo, sem herdar Vendedor, Inbox,
edição geral ou administração. Sem checkbox, o perfil restrito atual continua.

Cancelamento local pré-exportação exclui Pedido da fila financeira ativa e
dos totais operacionais, preservando histórico, check e pagamento consultáveis
no escopo financeiro. Não estorna, apaga obrigação ou marca Nota criada.
Vínculo/envio Olist não declara quitação nem conclusão financeira. Novo total
calculado por subtotal preserva a regra de nova quitação em mudança comercial.

**Decisão de produto:** aprovada pelo PO em 21/10/2026 nesta conversa.
**Estado:** implementação autorizada em 22/10/2026; migrations, API, painel e
gestão de perfis entregues nesta fatia. Homologação e conta real são FINQ-T06.
**Decisão:** [ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md),
a partir do [RFC 028](../../../docs/rfc/028-financeiro-com-fila-e-check-manual.md).
**Complemento aprovado:** [ADR 041](../../../docs/adr/041-consulta-administrativa-do-financeiro.md)
e [RFC 029](../../../docs/rfc/029-consulta-administrativa-do-financeiro.md):
consulta administrativa e descarte do print como referência visual.
**Tarefas:** [FINQ-PLAN-01/02 e FINQ-T01–T06](tasks.md).
**Fontes:** [CRM MVP](../crm-mvp/spec.md), [RULES](../../../RULES.md),
[design vigente](../../../design.md), ADRs 006, 035 e 036.

## Objetivo e fronteira

Como pessoa do Financeiro, quero consultar os pedidos confirmados e
integralmente pagos, executar minha rotina manual no Olist e marcar
“Nota criada”, para saber o que ainda falta sem precisar acessar atendimento
ou administração comercial.

A composição escolhida é **Fila e detalhe**: fila à esquerda e consulta do
pedido à direita no desktop; adaptação no celular conforme o design vigente.
O desenho apresentado na conversa é referência de organização e interação,
mas o PO rejeitou explicitamente o visual do print: ele está descartado como
referência de aparência e não aprova CSS, cores, tipografia, shell, cards ou
botões. Somente a composição Fila e detalhe permanece aprovada, a ser montada
com os padrões e componentes já estabelecidos no CRM.
A alternativa “Conferência ampla” não faz parte da entrega.

## Requisitos rastreáveis

### Acesso e criação da conta

1. **FINQ-01 — Perfil restrito:** WHEN o administrador cria ou mantém uma
   conta Financeiro THEN o sistema SHALL atribuir acesso próprio para a rotina,
   sem herdar a função Vendedor nem conceder `COMMERCIAL_ADMIN`. Somente o
   administrador vigente gerencia contas; criação, alteração e desativação
   preservam os controles e a auditoria existentes. A desativação bloqueia
   leituras e mutações, e histórico financeiro impede exclusão destrutiva da conta.
2. **FINQ-02 — Entrada e navegação:** WHEN Financeiro entra no CRM THEN o
   destino SHALL ser seu painel, com apenas Financeiro e Minha conta disponíveis
   no shell existente. Um link para área não autorizada SHALL NOT liberar acesso.
   A navegação dos vendedores e o adiamento de PNL-04 permanecem inalterados.
3. **FINQ-03 — Autorização na API:** WHEN Financeiro consulta qualquer recurso
   THEN a API SHALL limitar listagens, contagens e detalhes ao universo autorizado.
   Inbox, mensagens, handoffs, cadastro geral de clientes, Dashboard comercial,
   administração de usuários, edição de pedido/preço/condição/datas, confirmação
   e reabertura comercial SHALL ser negados também por URL ou chamada direta.
   Vendedor isoladamente e `AUTOMATION_EXECUTOR` SHALL NOT concluir ou desfazer
   a rotina financeira. O perfil não participa das filas de handoff.

### Elegibilidade e filas

4. **FINQ-04 — Pedido pago e confirmado:** WHEN o painel calcula seu universo
   THEN ele SHALL incluir somente pedidos `confirmado`, com recebimento integral
   registrado e sem marca de teste. Sinal ou parcela não qualificam. “Pago em”
   (`paidOn`) SHALL representar a data em que o valor integral entrou; confirmação
   do pedido, prazo, produção pronta ou entrega não substituem esse registro.
   Antes da ativação, verificar o uso legado dessa data: não presumir quitação
   de registros que tenham sido usados para sinal. Não criar cálculo de saldo,
   parcelas ou conciliação bancária nesta entrega.
5. **FINQ-05 — Origens e responsáveis:** WHEN um pedido atende a FINQ-04 THEN
   ele SHALL ser considerado independentemente do vendedor, incluindo pedidos
   manuais, de atendimento e da loja do site. Na loja, o registro de pagamento
   confirmado pelo gateway continua sendo a fonte; o Financeiro não altera esse
   pedido travado. Nenhuma ficha ou dado comercial é destravado pelo novo controle.
6. **FINQ-06 — Aguardando e Concluídos:** WHEN a pessoa abre o painel THEN
   “Aguardando” SHALL listar elegíveis sem conclusão financeira ativa, ordenados
   pelo pagamento mais antigo e número como desempate. “Concluídos” SHALL listar
   elegíveis com conclusão ativa, pela conclusão mais recente e número como
   desempate. As contagens SHALL refletir o mesmo universo da API, sem apresentar
   falha de leitura como zero. Perder elegibilidade retira o pedido dessas listas
   sem apagar seu histórico. Reconfirmação com outro valor exige nova quitação
   e novo check, conforme FINQ-18.

### Consulta, conclusão e correção

7. **FINQ-07 — Fila e detalhe:** WHEN a pessoa seleciona um pedido THEN a tela
   SHALL mostrar sua identificação, cliente, origem, responsável, itens e
   quantidades/grade, valor total, data de pagamento, situação Confirmado e
   entrega prometida quando disponível. São dados de consulta do pedido; não
   habilitam busca no cadastro geral nem acesso às conversas ou arquivos de arte.
   Não exigir CPF/CNPJ, endereço fiscal, preço unitário ou número de nota para
   marcar a rotina, nem inventar valores por item a partir do total.
8. **FINQ-08 — Check manual:** WHEN Financeiro aciona “Marcar nota criada”
   depois de terminar sua rotina externa THEN o sistema SHALL registrar conclusão,
   autora e instante do servidor, exibido em America/Sao_Paulo, e mover o pedido
   de Aguardando para Concluídos. O check significa declaração humana de rotina
   concluída; não comprova emissão ou autorização Sefaz e não consulta o Olist.
9. **FINQ-09 — Desfazer com histórico:** WHEN Financeiro desfaz uma marcação
   ou usa “Voltar para aguardando” THEN o sistema SHALL desativar a conclusão e
   devolver o pedido elegível a Aguardando, registrando autora e instante da
   correção sem apagar a conclusão anterior. O histórico financeiro SHALL ser
   consultável no detalhe autorizado e não habilitar alteração de dados comerciais.
10. **FINQ-10 — Controle separado do pedido:** WHEN uma conclusão financeira
    é criada ou desfeita THEN o sistema SHALL preservar status comercial,
    snapshot, preço, pagamento, entrega, impressão/PDF e totais de vendas. Pedido
    continua tendo apenas `pendente` e `confirmado`. O controle manual também
    se aplica à loja sem modificar seu conteúdo travado ou reenviar efeitos ao n8n.
11. **FINQ-11 — Segurança, concorrência e auditoria:** WHEN um comando
    financeiro é recebido THEN a API SHALL revalidar ator ativo, perfil,
    elegibilidade e versão atual, exigir sessão/CSRF e idempotência e persistir
    alteração e auditoria na mesma transação. Repetição ou cliques concorrentes
    não duplicam a conclusão. Alteração concorrente de pagamento, confirmação
    ou marca de teste impede comando baseado em estado obsoleto. Auditoria
    registra ação, ator, alvo, versão e correlação sem PII de cliente ou segredo.

### Design, acessibilidade e estados

12. **FINQ-12 — Design existente obrigatório:** WHEN a interface for
    implementada THEN ela SHALL reutilizar shell, marca configurável, componentes,
    tokens semânticos, tipografia, seleção neutra, temas e padrões de jornada do
    CRM, conforme [design.md](../../../design.md) e ADRs 035/036. Não redesenhar
    as telas existentes, criar tema do Financeiro ou copiar o estilo do mockup.
    Desktop mantém a composição Fila e detalhe; tablet e celular seguem o shell
    responsivo atual, com acesso ao detalhe e retorno à fila sem perda da seleção.
    O print da conversa foi rejeitado como referência visual: não reproduzir sua
    aparência. A revisão futura deve comparar a tela às telas reais do CRM e
    aos seus componentes/tokens vigentes, nunca à imagem apresentada.
13. **FINQ-13 — Teclado e foco:** WHEN a pessoa percorre a fila, troca a lista,
    consulta detalhes, conclui ou desfaz THEN todas as ações SHALL funcionar por
    teclado, com rótulos e seleção anunciados. Remover a linha selecionada SHALL
    levar o foco ao próximo pedido ou ao título/estado vazio; oferecer Desfazer
    sem perder acesso à mensagem. Mudanças SHALL ser anunciadas por região viva.
    Alvos de toque e espaçamento seguem o contrato vigente de 44 px/8 px.
14. **FINQ-14 — Estados honestos:** WHEN houver carregamento, fila vazia,
    nenhum concluído, falha, salvamento ou conflito THEN a interface SHALL
    distinguir esses estados, oferecer recuperação apropriada e não confirmar
    conclusão sem resposta válida. Falha ou resultado incerto SHALL preservar
    contexto e exigir releitura/reconciliação antes de novo efeito. Um erro de
    leitura não pode dizer que não há pendências.
15. **FINQ-15 — Sem integração nesta fase:** WHEN esta entrega for planejada
    ou implementada THEN ela SHALL manter o trabalho no Olist inteiramente manual,
    sem API, OAuth, webhook, sincronização, emissão automática, credenciais ou
    nova infraestrutura. Integração futura exige outra definição e tarefas próprias.

### Consulta pelo administrador

16. **FINQ-16 — Admin consulta com menu completo:** WHEN uma pessoa ativa
    com `COMMERCIAL_ADMIN` acessa Financeiro THEN a interface e a API SHALL
    permitir consultar Aguardando, Concluídos, contagens, detalhes e histórico
    financeiro no mesmo universo de pedidos de FINQ-04–07, sem exigir o perfil
    Financeiro ou troca de perfil. A entrada Financeiro SHALL integrar seu menu
    completo existente, preservando as demais áreas, permissões e destino de
    login do administrador. A restrição a Financeiro/Minha conta de FINQ-02
    aplica-se somente ao perfil Financeiro. A autorização de consulta não concede
    concluir/desfazer a rotina: na tela administrativa essas ações SHALL ficar
    ausentes e a API SHALL negá-las para o Admin apenas por essa capacidade.
    O histórico é consultável, sem edição. Conta desativada e Vendedor sem
    `COMMERCIAL_ADMIN` SHALL NOT obter esse acesso adicional. As permissões
    comerciais administrativas já existentes continuam válidas nas demais áreas.

17. **FINQ-17 — Usuários e seleção de perfil:** WHEN Admin gerencia contas
    THEN a tela SHALL se chamar “Usuários” e oferecer Vendedor, Financeiro e
    Administrador na criação e edição. Administrador representa Vendedor +
    `COMMERCIAL_ADMIN`; Financeiro não combina essa capacidade. Mudança de
    perfil SHALL revogar sessões e ser auditada. O administrador não pode
    trocar o próprio perfil por essa tela; vínculos históricos não são apagados
    nem transferidos automaticamente.
18. **FINQ-18 — Novo valor exige nova quitação e check:** WHEN um pedido
    manual/de atendimento pago e concluído é reaberto e reconfirmado com valor
    diferente THEN o pagamento anterior SHALL ser limpo, a conclusão ativa
    invalidada e o histórico preservado. A volta ao Financeiro exige registrar
    novamente a quitação integral, mesmo se na mesma data, e novo check.
    Reabrir retira o pedido das filas enquanto pendente; reconfirmar pelo mesmo
    valor preserva pagamento e check. Alterações sem mudança do valor não
    invalidam a conclusão por mero incremento da versão. Correção administrativa
    da loja preserva o pagamento verificado pelo gateway e a exigência de que
    ele cubra o valor corrigido (ADR 038), mas invalida o check para nova revisão.
19. **FINQ-19 — Revisão explícita do legado:** WHEN uma data manual anterior
    à migration 0043 existe THEN ela SHALL permanecer visível, fora do Financeiro
    até Vendedor/Admin declarar explicitamente que o valor integral foi recebido.
    Salvar somente entrega, ou reenviar a mesma data sem essa declaração, SHALL
    manter o bloqueio. Não inferir quitação por edição de outros campos.

## Critérios de verificação

- Matriz: confirmado + pagamento integral + não teste entra; pendente pago,
  confirmado sem quitação, sinal e teste ficam fora. Cobrir as três origens.
- Dados legados de “Pago em” revisados antes da ativação; nenhuma inferência
  silenciosa de quitação, lançamento bancário ou backfill financeiro automático.
- Financeiro consulta pedidos de vendedores diferentes e conclui/desfaz;
  vendedor, ator n8n, conta desativada e acesso direto indevido são recusados.
- Admin consulta as duas filas, contagens, detalhes e histórico sem trocar de
  perfil; mantém menu completo e login atual. Não vê ações de concluir/desfazer,
  e tentativas diretas desses comandos são negadas. Cobrir também Admin desativado
  e Vendedor sem capacidade administrativa.
- Repetir, concorrer e mudar elegibilidade durante a ação; comprovar um efeito,
  conflito visível, preservação comercial e auditoria de conclusão e correção.
- Conferir desktop Fila e detalhe, celular 390×844, temas claro/escuro,
  teclado, foco, leitor de tela, falha de leitura e ausência de overflow.
  Comparar com o design real vigente do CRM; não usar o print rejeitado como aceite.
- Verificar que nenhuma chamada ao Olist é feita e que nenhum dado pessoal,
  conversa ou arquivo fora do contrato aparece nas respostas ou logs.

Decisões complementares em [RFC 030](../../../docs/rfc/030-perfis-e-requitacao-do-financeiro.md)
e [ADR 042](../../../docs/adr/042-perfis-e-requitacao-do-financeiro.md).
Evidências automatizadas e limites da homologação constam de [tasks.md](tasks.md)
e do [runbook](../../../docs/runbooks/financeiro.md).
