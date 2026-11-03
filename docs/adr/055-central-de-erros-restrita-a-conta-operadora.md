# ADR 055 — Central de erros restrita à conta operadora

Data: 02/11/2026. Status: aceita pelo proprietário nesta conversa.
Decisor: proprietário do CRM. Requisitos OPS-ERR-01–08; tarefa OPS-ERR-T01.
Decide a [RFC 042](../rfc/042-central-de-saude-e-erros.md).

## Contexto e decisão

O proprietário autorizou uma central de erros com novo item de menu e
limitou expressamente os dados à conta `admin@crm-silmer.local`. Trata-se
do identificador operacional aprovado, não de um destino de notificações.

O menu **Saúde e erros** e a rota `/saude-erros` exigem essa conta humana
ativa e a capacidade `COMMERCIAL_ADMIN`. A API aplica a mesma restrição a
partir da identidade atual no banco. A capacidade isolada não concede o
acesso a outros administradores, ao Financeiro ou ao executor n8n. A
interface impede montagem da tela para uma sessão sem acesso.

As ocorrências ficam no PostgreSQL existente, agrupadas por origem/código
controlados e com contagem, primeira/última ocorrência, versão e histórico
de triagem. O recorte inicial cobre respostas 5xx da API e falhas duráveis
de jobs e comandos CRM→n8n. Leituras não expõem corpos, mensagens, nomes,
telefones, credenciais ou stack traces livres. Logs técnicos e ocorrências
seguem a retenção operacional de 30 dias, separada da auditoria existente.

Novo, Em análise e Resolvido são estados do tratamento técnico. Alterações
exigem sessão, CSRF, origem, versão, idempotência e auditoria transacionais.
Uma recorrência reabre o grupo resolvido. Triagem não altera pedidos,
conversas, reservas de envio ou o resultado do comando de origem.

## Alternativas e consequências

Reutilizar a permissão genérica de administrador sem restringir a conta não
atenderia à decisão do proprietário. Exibir logs brutos criaria exposição
desnecessária. Um serviço adicional de observabilidade não é necessário
para o recorte entregue: preservam-se o monólito modular e a stack atual.

A central depende da API e do banco para funcionar. Não comprova saúde dos
provedores nem substitui o monitor off-host, notificações externas e os
drills da issue #11. Uma falha de coleta deve aparecer como indisponibilidade,
sem converter ausência de dados em confirmação de normalidade.

A migration é expand-only; a aplicação anterior pode ser restaurada sem
remover as tabelas. O histórico de triagem permanece técnico e separado
da auditoria e dos resultados incertos das integrações.

## Rastreabilidade

- [RFC 042](../rfc/042-central-de-saude-e-erros.md).
- [Contrato OPS-ERR-01–08](../../.specs/features/crm-mvp/spec.md).
- [Tarefa OPS-ERR-T01](../../.specs/features/crm-mvp/tasks.md).
- [Runbook](../runbooks/saude-erros.md).
- [Issue #11](https://github.com/romulosutil/crm-silmer/issues/11).
- PR: referência registrada no fechamento da entrega.
