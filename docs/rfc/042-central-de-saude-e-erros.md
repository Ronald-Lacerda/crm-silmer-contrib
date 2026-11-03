# RFC 042 — Central de saúde e erros

Data: 02/11/2026. Status: aprovada pelo proprietário nesta conversa e decidida
na [ADR 055](../adr/055-central-de-erros-restrita-a-conta-operadora.md).

## Problema e proposta

Os logs e estados de falha já existem, mas a pessoa responsável precisa
localizar os problemas e acompanhar seu tratamento dentro do CRM. O
proprietário solicitou um novo item de menu e restringiu a visualização à
conta operacional designada, mesmo entre administradores.

Adicionar **Saúde e erros** ao shell Vue vigente, com ocorrências técnicas
agrupadas por origem e código, contagens, horários e estados Novo, Em análise
e Resolvido. A API valida a identidade atual da sessão e a capacidade
administrativa; esconder o menu é apenas a apresentação dessa autorização.

O PostgreSQL existente guarda as ocorrências e o histórico de triagem. O
primeiro recorte captura respostas 5xx da API e importa falhas duráveis de
jobs e comandos n8n. Código, contagem e IDs opacos substituem corpos,
mensagens, nomes de clientes, credenciais e erros livres. Nova ocorrência
reabre um grupo resolvido. Triagem não executa novamente nenhum efeito.

## Alternativas e limites

Dar acesso a todos os administradores contraria a restrição solicitada.
Expor logs brutos ou payloads aumenta a exposição sem ajudar a triagem.
Criar infraestrutura de monitoramento não é necessário para esta tela.

Notificações externas, indisponibilidade total da VPS e um coletor universal
dos provedores continuam na issue #11 e nos gates operacionais existentes.
O painel informa sua cobertura e não representa evidência de monitor ativo.

## Rastreabilidade

- [OPS-ERR-01–08 / spec](../../.specs/features/crm-mvp/spec.md).
- [OPS-ERR-T01 / tarefas](../../.specs/features/crm-mvp/tasks.md).
- [ADR 055](../adr/055-central-de-erros-restrita-a-conta-operadora.md).
- [Runbook](../runbooks/saude-erros.md).
- [Issue #11](https://github.com/romulosutil/crm-silmer/issues/11).
- PR: referência registrada no fechamento da entrega.
