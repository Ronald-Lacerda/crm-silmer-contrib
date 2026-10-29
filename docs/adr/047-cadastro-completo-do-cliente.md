# ADR 047 — Cadastro completo do cliente

Status: aceita em 28/10/2026 para o CRM.

RFC: [035](../rfc/035-cadastro-completo-do-cliente.md).
Requisitos: [CP-25..28](../../.specs/features/cliente-pedido-assuntos/spec.md).
Tarefa: [CP-T08](../../.specs/features/cliente-pedido-assuntos/tasks.md).
Relacionados: [ADR 033](033-telefone-no-cadastro-e-roteamento.md),
[RULES.md](../../RULES.md). Issues e PRs serão ligados à tarefa.

## Decisão

1. O Contato ganha um cadastro opcional com tipo de pessoa, CPF/CNPJ, nome ou
   razão social, @ do Instagram, inscrição estadual, CEP, cidade, UF,
   endereço, bairro, número e complemento. Celular e e-mail continuam no
   cadastro de contato da ADR 033 e contam para o cadastro completo.
2. O cadastro não bloqueia Contato, Conversa nem Pedido. A interface mostra
   “Cadastro completo” ou “Cadastro incompleto” conforme a regra da CP-26.
3. Os dados ficam em envelope AES-256-GCM próprio, aparecem só no detalhe do
   Contato e são alterados por comando versionado, idempotente e auditado.
   Auditoria, eventos, logs e a lista não carregam valores do cadastro.
4. CPF/CNPJ são validados por dígito verificador (CNPJ numérico ou
   alfanumérico) e não são chave única nem critério de união de Contatos.
5. A API consulta o ViaCEP enviando apenas o CEP. A sugestão é editável e a
   indisponibilidade mantém o preenchimento manual.

## Consequências

Uma migration expand adiciona o envelope e o estado do cadastro. O ViaCEP é
uma dependência externa sem SLA, tratada como opcional; nenhum dado além do
CEP sai do CRM. Uso fiscal (nota, validação de inscrição estadual por UF) fica
fora deste escopo e exige decisão própria.
