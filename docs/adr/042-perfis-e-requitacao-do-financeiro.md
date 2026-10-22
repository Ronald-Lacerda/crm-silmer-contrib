# ADR 042 — Perfis e nova quitação no Financeiro

- Estado: aceita pelo PO em 22/10/2026.
- Proposta: [RFC 030](../rfc/030-perfis-e-requitacao-do-financeiro.md).
- Requisitos: [FINQ-01–19](../../.specs/features/financeiro/spec.md).
- Tarefas: [FINQ-T01–T06](../../.specs/features/financeiro/tasks.md).
- Antecedente: [PR 214](https://github.com/romulosutil/crm-silmer/pull/214), ADRs 040/041.

## Decisão

Implementar Fila e detalhe no design atual do CRM. Usuários substitui o
rótulo Vendedores, com seletor Vendedor/Financeiro/Administrador. Os perfis
persistem como Vendedor sem capacidade, Financeiro sem capacidade e Vendedor
com COMMERCIAL_ADMIN. Trocar perfil revoga sessões e audita a alteração;
autoalteração do perfil administrativo é bloqueada.

Uma reconfirmação manual/de atendimento com outro valor limpa `paid_on` e
invalida a conclusão financeira ativa, exigindo novo registro de quitação e
novo check. O histórico permanece imutável. Reconfirmação pelo mesmo valor
preserva os registros; enquanto pendente o pedido fica fora das filas.
Correção administrativa da loja mantém o pagamento gateway que cobre o novo
valor, mas invalida a conclusão para nova revisão, preservando ADR 038.

Datas manuais legadas recebem revisão pendente e não qualificam a fila.
A declaração explícita de quitação integral pelo Vendedor/Admin libera a
data; salvar entrega ou reenviar a data antiga não basta.

Estado, versão e histórico financeiros são próprios. Comandos bloqueiam o
pedido e o ator vigente e persistem alteração, auditoria e idempotência na
mesma transação. Admin somente consulta, preservando menu completo.

## Consequências

Migrations 0042/0043 são expansivas; rollback da aplicação preserva tabelas,
histórico e datas marcadas para revisão. Contas com história financeira não
podem ser excluídas. A atribuição comercial anterior é preservada quando um
usuário muda de perfil; o Admin pode redistribuí-la.

Homologação com a pessoa do Financeiro e criação de conta real são etapas
operacionais distintas. Não incluir credenciais, chamadas Olist ou novos jobs.
