# ADR 041 — Consulta administrativa do Financeiro

Status: aceita em 21/10/2026; somente documentação, sem implementação.
Decisor: PO, complemento explícito nesta conversa.
RFC: [029](../rfc/029-consulta-administrativa-do-financeiro.md).
Requisitos: [FINQ-12 e FINQ-16](../../.specs/features/financeiro/spec.md).
Tarefas: [FINQ-PLAN-02, FINQ-T01/T03/T05](../../.specs/features/financeiro/tasks.md).
Complementa a [ADR 040](040-financeiro-com-fila-e-check-manual.md) sem reescrevê-la;
preserva ADRs 035/036. Issue/PR: não há vínculo específico nesta etapa.

## Contexto

A definição anterior explicitava somente a entrada do perfil Financeiro.
O PO aprovou que o administrador também consulte a tela com o menu completo.
O PO rejeitou o visual do print por diferir do CRM; a composição Fila e detalhe
continua sendo a opção escolhida, sem autorização para redesign.

## Decisão

1. Permitir ao Admin ativo (`COMMERCIAL_ADMIN`) consultar as duas filas,
   contagens, detalhes e histórico no mesmo universo de pedidos elegíveis,
   sem trocar de perfil. Manter menu completo, áreas existentes e login atual;
   acrescentar a entrada Financeiro pelos padrões de navegação vigentes.
2. A aprovação é de consulta. Ela não concede marcar “Nota criada”, desfazer
   ou editar histórico financeiro ao Admin por essa capacidade. Esconder essas
   ações na consulta administrativa e negar comandos diretos na API. O Financeiro
   mantém suas ações próprias; permissões comerciais anteriores do Admin permanecem.
3. Descartar o print como referência visual. Reutilizar o shell, componentes,
   tokens, marca, tipografia, temas e padrões existentes do CRM. A revisão visual
   compara a implementação futura às telas reais atuais, não ao mockup rejeitado.
4. Registrar o complemento nos requisitos e nas tarefas abertas; não implementar
   código, migrations, conta, novo visual ou integração Olist nesta entrega.

## Consequências

O acesso de leitura aceita Financeiro ou Admin ativo, sem ampliar as permissões
de Vendedor isoladamente. Conclusão e reversão continuam exigindo o perfil
Financeiro; a consulta administrativa não muda dados. FINQ-T01/T03/T05 devem
cobrir o acesso no servidor, o menu completo e os testes negativos de comandos.
FINQ-12 exige o design real do CRM; nenhuma aparência nova foi aprovada.
