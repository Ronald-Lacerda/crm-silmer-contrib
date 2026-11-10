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
backend, mais o frete quando existir no Pedido; o cancelamento local vale só
para Pedido não confirmado (OLC-F03); a remoção do Financeiro foi aprovada.

## OLC-T01 Dados do pedido e autorização

Requisitos OLC-01–06/09/10/14. Dono Backend/Dados com revisão QA.

- [ ] Implementar checkbox default falso, gestão Admin e política que combina
      usuário ativo, habilitação, leitura comercial do Pedido e piloto privado;
      Admin não herda geração e Financeiro não ganha entrada/projeção nova.
- [ ] Persistir composição monetária aditiva por tamanho com IDs estáveis,
      revisão humana, versão e auditoria, reutilizando o núcleo existente.
      Derivar grade/IDs no servidor e exigir correspondência 1:1 com grupos,
      tamanhos/quantidades confirmados. Pedido novo: reaproveitar os subtotais
      por linha de tamanho já existentes; o valor final é a soma calculada no
      backend (ADR 057 itens 4 e 6), mais o frete quando existir no Pedido, sem
      igualar outro total. A composição aditiva serve a Pedido antigo ou da loja
      que só tem total: a soma deve igualar exatamente esse total existente
      (ADR 057 item 6). Sem rateio automático nem alteração de grade/atributo
      pelo enriquecimento.
- [ ] **Ponto de conferência: frete no total.** Na master o frete não integra o
      total do Pedido: a cotação é estimativa separada do Valor final
      (ADR 054; `modules/shipping`; migration 0050), a composição peças + frete
      está fora das ADRs 053/054 e o contrato Olist atual exige `valorFrete`
      ausente ou zero na leitura (`modules/olist/src/sale-payload.js`). Antes de
      implementar, confirmar se e onde o frete existe no Pedido e como ele entra
      no total e na venda ERP, sem inventar contrato; até lá, escrever
      "frete, quando existir no Pedido".
- [ ] Compor cadastro e adapter da loja/legado; comando específico de
      enriquecimento não reabre, não reprecifica, não altera snapshot/PDF.
- [ ] Definir operação/recursos compartilhados/etapas, referências protegidas,
      unicidades, snapshot cifrado e contratos versionados em OpenAPI.
- [ ] Preparar guardas de alteração incompatível em todos os comandos
      comerciais relevantes, incluindo reabertura e correção da loja.
- [ ] Verificar migration expand, autorização negativa, aritmética, revisão,
      concorrência e compatibilidade de leitura. Documentar rollback.

Não remover campo/tabela do Financeiro nem alterar o cálculo do valor final já vigente (soma dos subtotais).

## OLC-T02 Conexão e adapter Olist

Requisitos OLC-04/06–08/11/12/14. Depende OLC-T01.
Dono Integrações com Backend e QA.

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
      total livre na exportação ou edição geral liberada pelo checkbox.
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
      (soma dos subtotais, mais frete quando existir) e os totais da venda.
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
      linha de tamanho (mais frete, quando existir) já vigente.
      Retoma a amplitude de OLIST-10/22/40–44/T20–21 após validação de produto;
      a composição mínima para exportação permanece em OLC-T01/T04.

FPI-T01–T04 são uma entrega própria já existente. Preservar suas versões,
amostras e gates; não duplicar tarefa de ficha/rótulos no caminho Olist.
