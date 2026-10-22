# RFC 029 — Consulta administrativa do Financeiro

Status: decidida em 21/10/2026 na
[ADR 041](../adr/041-consulta-administrativa-do-financeiro.md).
Responsável: Tech Lead. Decisor: PO, complemento explícito nesta conversa.
Requisitos: [FINQ-12 e FINQ-16](../../.specs/features/financeiro/spec.md).
Tarefas: [FINQ-PLAN-02, FINQ-T01/T03/T05](../../.specs/features/financeiro/tasks.md).
Relacionado ao [RFC 028](028-financeiro-com-fila-e-check-manual.md).
Issue/PR: não há vínculo específico nesta etapa documental.

## Contexto e alternativas

O acesso administrativo ao painel não estava explícito. Exigir a troca para
Financeiro reduziria o menu e confundiria a consulta de gestão com a rotina
operacional. O PO aprovou consulta pelo Admin mantendo o menu completo.
Não foi solicitado conceder conclusão/reversão ao administrador.

O print apresentado diferia do design real do CRM e foi rejeitado como
referência de aparência. Copiá-lo contrariaria a instrução de preservar o design.

## Resultado e ações

Autorizar Admin ativo a consultar Aguardando, Concluídos, contagens, detalhes
e histórico do mesmo universo elegível, mantendo perfil, menu completo,
permissões anteriores e login atual. Usar a autorização do servidor e não
conceder comandos financeiros por `COMMERCIAL_ADMIN`; incluir testes negativos.

Preservar apenas a composição Fila e detalhe do estudo. A aparência deve usar
os componentes e padrões reais do CRM, sem reproduzir o print. Registrar
FINQ-16 e reforçar FINQ-12; atualizar FINQ-T01/T03/T05 e fontes canônicas.
Todas as tarefas de código continuam abertas; esta entrega é somente documental.
