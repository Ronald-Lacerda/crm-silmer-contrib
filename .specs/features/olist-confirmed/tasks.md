# Entrega Olist pelo pedido confirmado

Contrato [OLC-01–16](spec.md), revisão 3 da
[RFC 050](../../../docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md) e
[ADR 079](../../../docs/adr/079-olist-a-partir-do-pedido-confirmado.md).
Prompts por bloco em [prompts-pedido-confirmado.md](../../../docs/integrations/olist/prompts-pedido-confirmado.md).

## Estado e ordem

OLIST-PLAN-03 é a atualização documental de 10/11/2026, não a implementação.
F1/T02 continuam concluídos somente para `exact-cent-v1`; núcleos de preço e
conferência já existem. As tarefas abaixo começam desmarcadas.

**Ordem:** OLC-T01 → OLC-T02 → OLC-T03 → OLC-T04 → OLC-T05 → OLC-T06.
Cada tarefa é uma entrega atômica com evidência, commit e push. Não concluir
tarefa posterior apenas porque houve prova isolada ou mock de interface.
FINQ-DEPREC-01 e OLC-F01–F04 não são predecessoras de nenhuma OLC-T.

Decisões do PO em 10/11/2026 (ADR 079): o Olist é refatorado conforme os blocos
1–6 dos prompts, com este pacote prevalecendo sobre o runtime Olist da master
onde divergirem (a master é ponto de partida e de reaproveitamento); o valor
final do Pedido é a soma dos subtotais por linha de tamanho, calculada pelo
backend, mais o frete (funcionalidade nova, ainda não implementada: a master
não tem o campo; contrato fechado na ADR 080 e implementado em OLC-T01, com o
vendedor informando o frete, a cotação como sugestão, congelamento na
confirmação e Dashboard sem separar peças e frete); o cancelamento local vale
só para Pedido não confirmado (OLC-F03); a remoção do Financeiro foi aprovada.

## OLC-T01 Dados do pedido e autorização

Requisitos OLC-01–06/09/10/14 (com OLC-05a–j). Dono Backend/Dados com
revisão QA.

- [ ] Implementar checkbox default falso, gestão Admin e política que combina
      usuário ativo, habilitação, leitura comercial do Pedido e piloto privado;
      Admin não herda geração e Financeiro não ganha entrada/projeção nova.
- [ ] Persistir composição monetária aditiva por tamanho com IDs estáveis,
      revisão humana, versão e auditoria, reutilizando o núcleo existente.
      Derivar grade/IDs no servidor e exigir correspondência 1:1 com grupos,
      tamanhos/quantidades confirmados. Pedido novo: reaproveitar os subtotais
      por linha de tamanho já existentes; o valor final é a soma calculada no
      backend (ADR 057 itens 4 e 6), mais o frete do Pedido (item seguinte),
      sem igualar outro total. A composição aditiva serve a Pedido antigo ou da
      loja que só tem total: a soma deve igualar exatamente esse total
      existente (ADR 057 item 6). Sem rateio automático nem alteração de
      grade/atributo pelo enriquecimento.
- [ ] **Implementar o contrato do frete no Pedido** (decisão do PO de
      10/11/2026, ADR 079 decisão 9; desenho fechado na
      [ADR 080](../../../docs/adr/080-valor-final-com-frete.md) /
      [RFC 062](../../../docs/rfc/062-valor-final-com-frete.md); critérios
      OLC-05a–j). É funcionalidade **nova**: na master o frete não integra o
      total (ADR 054; `modules/shipping`;
      `apps/api/src/conversation-shipping-runtime.js`; migration 0050) e o
      Olist exige `valorFrete` ausente ou zero. Nomes de campo, coluna e rota:
      a definir na implementação, sem nova infraestrutura. Entregáveis, com
      evidência e testes:
  - **Dado:** frete do Pedido em centavos inteiros não negativos, aditivo
    (migration expand), default zero, versionado e auditado sem PII, com
    origem (informado pelo vendedor ou aplicado de cotação: referência da
    cotação e do serviço, valor cotado, autor, instante) e a regra de cálculo
    identificável por Pedido para nunca recalcular histórico.
  - **Quem e quando:** comando só para o vendedor responsável (RULES 20),
    humano ativo, com Pedido `pendente`; Admin não responsável, outro
    vendedor, automação e Pedido confirmado são negados na API. Admin pode
    confirmar pela regra atual sem alterar o frete.
  - **Sugestão da cotação:** aplicar envia só a identidade da cotação e do
    serviço; o servidor lê o preço, exige mesmo Pedido, serviço selecionado e
    cotação não desatualizada (regra da ADR 054 inalterada). O vendedor pode
    informar outro valor. Cotação nova ou desatualizada não altera o frete; a
    leitura expõe origem e aviso de divergência.
  - **Recálculo e concorrência:** comando com `expectedVersion` e
    idempotência; subtotal, quantidade e frete mudam o total derivado; a
    quantidade não mexe no frete. A confirmação calcula
    `finalAmountCents` = soma dos subtotais + frete no servidor, recusa
    `amountCents` divergente e registra peças, frete, origem e total.
  - **Congelamento:** nenhum comando altera o frete de Pedido confirmado; a
    reabertura existente segue a regra do total, com as proteções atuais de
    quitação e cobrança, e segue bloqueada para loja e Pedido com operação
    Olist reservada ou concluída. O frete integra a revisão comercial
    exportável.
  - **Leituras:** cobrança InfinitePay, plano, recebimentos e quitação seguem
    lendo o valor final, sem regra nova; Dashboard "vendido" soma o total
    único, sem separar peças e frete; histórico não é reprocessado.
  - **Loja e legado:** loja com frete zero, sem mudar checkout, gateway,
    travas ou adapter; Pedido confirmado legado com frete zero e tudo
    intocado; Pedido pendente existente começa com frete zero.
  - **Ficha/PDF:** sem frete nesta entrega, sem versão de impressão nova.
  - **OpenAPI e testes:** contrato aditivo (leitura com peças, frete, origem e
    total; comando de frete; cotação inalterada); testes de frete positivo,
    zero, ausente, inválido e overflow, autorização positiva e negativa,
    sugestão válida, desatualizada, de outro Pedido e preço vindo do
    navegador, conflito de versão, idempotência, confirmação divergente,
    reabertura com cobrança/quitação, legado, loja, Dashboard e ficha.
  - **Rollback:** sem remover o dado; documentar como impedir que código
    anterior recalcule sem frete o total de Pedido que o tem.
  - **Confirmado pelo PO em 10/11/2026** (pontos P1–P3 da ADR 080): sem alçada para frete zero, "já no preço" ou
    abaixo do cotado; cotação de origem desatualizada só como aviso, sem
    bloquear a confirmação; performance por responsável (ADR 059) com o
    mesmo total com frete.
- [ ] Compor cadastro e adapter da loja/legado; comando específico de
      enriquecimento não reabre, não reprecifica, não altera snapshot/PDF.
- [ ] Definir operação/recursos compartilhados/etapas, referências protegidas,
      unicidades, snapshot cifrado e contratos versionados em OpenAPI.
- [ ] Preparar guardas de alteração incompatível em todos os comandos
      comerciais relevantes, incluindo reabertura e correção da loja.
- [ ] Verificar migration expand, autorização negativa, aritmética, revisão,
      concorrência e compatibilidade de leitura. Documentar rollback.

Não remover campo/tabela do Financeiro nem alterar total, snapshot ou cobrança de
Pedido existente: o frete vale para Pedido novo, não é retroativo.

## OLC-T02 Conexão e adapter Olist

Requisitos OLC-04/06–08/11/12/14 (e OLC-05f/g para o frete). Depende OLC-T01.
Dono Integrações com Backend e QA.

- [ ] **Tratar `valorFrete` no adapter e no inspector** (`modules/olist/src/`
      `sale-payload.js` e `readonly-inspector.js`) em vez de exigir zero:
      enviar o frete do Pedido em centavos exatos, fora dos unitários, manter
      `valorDesconto` e `valorOutrasDespesas` zero e conferir na leitura que o
      `valorFrete` retornado iguala o do Pedido e que o total do ERP é a soma
      das linhas mais o frete (ADR 062 integral); `valorFrete` ausente só vale
      como zero se o frete do Pedido for zero (ADR 080). Fixtures sintéticas:
      frete zero/ausente, positivo, divergente e fracionário.
- [ ] Implementar conexão/configuração administrativa central, tokens cifrados,
      renovação serializada, conta esperada e parâmetros comerciais versionados.
- [ ] Implementar busca/criação e leitura conferida de comprador, produto pai,
      variações e venda, reaproveitando achados da prova F1 sem executar seus
      scripts como runtime ou reutilizar seus IDs/digests/credenciais.
- [ ] Validar identidade fiscal/comercial, referência, quota, erro seguro,
      precisão e ausência de sobrescrita de cadastros encontrados.
- [ ] Testar adapter com fixtures sintéticas e falhas por fronteira; nenhuma
      inclusão real ou ativação de conta é autorizada por este checklist.

## OLC-T03 Comando e processamento recuperável

Requisitos OLC-01/03/07–12/14. Depende OLC-T01/T02. Dono Backend/Integrações.

- [ ] Implementar comando por Pedido confirmado, sem endpoint/previewId
      obrigatório de prévia; validar antes de inclusões e aceitar com operação.
- [ ] Gravar reserva, snapshot, auditoria e job transacionalmente; executar
      cliente → produtos/variações → venda com reservas por identidade.
- [ ] Congelar o frete no snapshot e conferir, antes de qualquer inclusão, que o
      total do Pedido é a soma dos subtotais mais o frete; divergência bloqueia
      a aceitação (OLC-05e). Conferir após a venda o total e o `valorFrete`
      retornados pelo ERP contra o total e o frete do Pedido (OLC-05g).
- [ ] Revalidar status/versões/conta/checkbox/piloto antes de cada efeito;
      serializar com reabertura/correção e preservar cadastros confirmados.
      Usar revisão/fingerprint comercial relevante ou revalidar conteúdo se
      a versão global mudou só por pagamento/entrega compatíveis.
- [ ] Implementar leitura persistida, conferência exata, falha sem efeito,
      incerteza e recuperação administrativa mínima por recurso/Pedido.
      Retomada criadora só com ausência de efeito comprovada; sem retry cego.
- [ ] Testar processos/conexões independentes, duplo clique, replay revogado,
      crash, resposta perdida e falha de commit após sucesso remoto.

## OLC-T04 Botão e estados no detalhe atual

Requisitos OLC-01–06/10/13/14/16. Depende OLC-T01–T03.
Dono Frontend/A11y com QA.

- [ ] Adicionar bloco e **Gerar no Olist** no detalhe existente; preservar
      **Gerar pedido**, **Gerar PDF**, billing, loja e shell atuais.
- [ ] Integrar pendências por origem e composição monetária autorizada, sem
      total livre na exportação ou edição geral liberada pelo checkbox. Exibir
      peças, frete (com origem e aviso da cotação sugerida) e total conforme a
      ADR 080, também no Pedido pendente e em **Gerar pedido**; editar o
      frete e usar a cotação sugerida só para o vendedor responsável em Pedido
      pendente, por teclado e com erro associado; Confirmado mostra o frete
      somente leitura.
- [ ] Exibir etapas, ambos os números, erro seguro, falha de consulta e
      conferência necessária; recuperar após reload e impedir novo envio.
- [ ] Conectar checkbox em Usuários e administração mínima de conexão usando
      padrões atuais. Sem menu/lista/busca Olist ou assistente de prévia.
- [ ] Verificar teclado/foco/ARIA/axe, temas, 320/390 px, desktop, duas abas,
      perda de conexão e revogação. Não declarar integração por mock.

## OLC-T05 QA e preparação operacional

Requisitos OLC-01–16. Depende OLC-T01–T04. Dono QA/Tech Lead com DevOps.

- [ ] Executar os cenários de aceite e regressão com PostgreSQL dedicado e
      dados sintéticos; confirmar Financeiro, InfinitePay e PDF preservados.
- [ ] Executar `git diff --check`, `npm run validate`, `npm run test:e2e`,
      `npm audit --audit-level=high` e suítes live/gates afetados do projeto.
- [ ] Publicar runbook por etapa com configuração, mínimos fiscais, quotas,
      retenção/PII, reconexão, restore, reconciliação e rollback conservador.
- [ ] Preparar ambiente com escrita desligada e conferir migrations, digest,
      health e compatibilidade; deixar aprovação/caso real para OLC-T06.

Gate: sem achados críticos/altos ou divergência monetária sem tratamento, com
os filtros de cancelamento (cancelados fora dos universos ativos) validados.
Não exigir remoção Financeiro, a restrição OLC-F03, busca ou ficha nova.

## OLC-T06 Piloto e aceite da geração

Requisitos OLC-02/08/11/12/15/16. Depende OLC-T05. Dono Operação/Tech Lead/PO.

- [ ] Confirmar conta ERP, parâmetros/gatilhos, ID privado da operadora ativa,
      checkbox e amostra/caso/efeitos autorizados antes de escrita real.
- [ ] Usar Pedido confirmado ainda não lançado no ERP; se já existe venda
      manual, excluir esse caso do piloto e encaminhar para conferência sem
      criar duplicata ou exigir o vínculo genérico OLC-F02.
- [ ] Observar clique no detalhe → processamento → venda conferida; conferir
      comprador, produtos/tamanhos, quantidades, cada valor, o total do Pedido
      (soma dos subtotais mais o frete), o `valorFrete` e os totais da venda.
- [ ] Verificar reload/replay sem duplicação, registrar evidência sanitizada,
      suporte e aceite. Ampliar operadores somente após decisão do PO.

## Remoção independente do Financeiro

[FINQ-DEPREC-01](../financeiro/tasks.md) é a tarefa de remoção, **aprovada pelo
PO em 10/11/2026**: remove a feature (fila, check Nota criada, perfil, rotas
`/api/v1/finance/*`, código `finance.*`) e mantém tabelas e dados históricos,
sem migração destrutiva. Depende de verificação da quitação conciliada e de suas
próprias migrações/compatibilidade, nunca da conclusão ou implementação de Olist.
Reciprocamente, OLC-T01–T06 não esperam essa remoção. Não usar check financeiro
ou pagamento como habilitador da exportação.

## Melhorias futuras independentes

Estas tarefas ficam diferidas; seus prompts não devem ser executados junto
da entrega principal sem escolha explícita da melhoria.

- [ ] **OLC-F01 — Operação centralizada.** Menu/busca exata/projeção própria e
      acesso de perfis restritos. Retoma OLIST-33/T12 de forma independente;
      exige decisão de acesso e testes contra vazamento.
- [ ] **OLC-F02 — Vínculo de venda antiga.** Prévia administrativa, conferência
      e vínculo justificado de venda manual anterior. Retoma OLIST-18/T09/T16;
      não substituir a recuperação mínima obrigatória de OLC-T03.
- [ ] **OLC-F03 — Cancelamento local só para Pedido não confirmado.**
      Decisão do PO em 10/11/2026, que supersede parcialmente a ADR 068:
      cancelar vale só para Pedido não fechado (`pendente`). Esta tarefa
      **restringe o cancelamento local a Pedido não confirmado, ajustando o já
      entregue** (rota, UI, testes e métricas). É mudança de comportamento do
      código existente (a master permite cancelar qualquer Pedido antes da
      exportação, inclusive confirmado ou pago): fazê-la aqui, em tarefa
      própria com migração/compatibilidade avaliadas, nunca silenciosamente
      nem dentro de OLC-T01–T06. Mantém motivo, estado terminal, sem estorno
      nem cancelamento ERP; os filtros de cancelamento seguem como gate.
      Retoma OLIST-45–47/T23; sem alterar exportados.
- [ ] **OLC-F04 — Revisão e preços ampliados.** Prévia detalhada optativa e
      eventuais ampliações do modelo de preços além da soma dos subtotais por
      linha de tamanho mais o frete (contrato do frete na ADR 080).
      Retoma a amplitude de OLIST-10/22/40–44/T20–21 após validação de produto;
      a composição mínima para exportação permanece em OLC-T01/T04.

FPI-T01–T04 são uma entrega própria já existente. Preservar suas versões,
amostras e gates; não duplicar tarefa de ficha/rótulos no caminho Olist.
