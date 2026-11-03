# Saúde e erros — migration 0051 em produção

OPS-ERR-T01 / OPS-CHK-01 / INT-3. Execução autorizada pelo proprietário em
03/11/2026, após a [PR #269](https://github.com/romulosutil/crm-silmer/pull/269).
Procedimento e rollback no [runbook Saúde e erros](saude-erros.md).

## Alvo e pré-checagens

- EasyPanel: projeto `espectro-mvp`, aplicação `silmer-api`, PostgreSQL
  `silmer-postgres`, database `crm_silmer`. Console da instância da API,
  container `0d3ee68d5a49`, sem exportar credenciais.
- A revisão configurada da API era `5637ac4bbed68ab1440958b6b8edf9043b1cc3f2`,
  anterior à central. O deploy automático estava desativado. Não houve
  alteração de fonte, ambiente, rede, scripts ou reinício nesta operação.
- O ledger e a imagem estavam em 0050, sem expand pendente daquela imagem
  nem divergência de checksum. As três tabelas e a sequência da 0051 ainda
  não existiam. Readiness da API: HTTP 200 antes da operação.
- Backup prévio `silmer-pre-ops-err-0051-2026-11-03`: **Success**, 807 kB,
  Local Disk, concluído em 03/11/2026 às 00:36:46 de São Paulo
  (`2026-11-03T03:36:46Z`). Configuração de retenção existente preservada.
  Não comprova cópia externa ou restauração.

## Execução isolada

A imagem antiga não continha o arquivo 0051. Por isso, o CLI genérico não
foi usado para presumir uma aplicação. O SQL validado da PR #269 foi
fornecido em memória ao migrador canônico `loadMigrations` / `migrate` da API,
com checksum conferido antes da conexão ao banco:

```text
82c1ef07df0a75eea8da5cfd13fd8184cdedc41bdfd23263c7e9b9fa7a1c835f
```

O plano preservou as migrations carregadas para validar todo o histórico e
acrescentou somente `0051_operational_incidents.expand.sql`. Guardas recusavam
outro database, divergência de histórico, objetos sem ledger ou qualquer
outra expand pendente. Limites da conexão: `lock_timeout=5000` e
`statement_timeout=15000`. DDL e ledger foram gravados na mesma transação,
sob o advisory lock do migrador.

```json
{
  "status": "ok",
  "applied": ["0051"],
  "repeatApplied": []
}
```

Ledger confirmado: versão `0051`, nome `operational_incidents`, fase `expand`,
checksum acima e aplicação em `2026-11-03T03:42:36.856Z`
(03/11/2026, 00:42:36.856 de São Paulo). A repetição não executou DDL.

## Verificação posterior e limite da evidência

- Confirmada a existência de `crm.operational_incidents`,
  `crm.operational_incident_receipts`, `crm.operational_incident_history` e
  `crm.operational_incident_version`.
- O papel da conexão da API tinha SELECT, INSERT, UPDATE e DELETE nas três
  tabelas e USAGE na sequência. Não houve concessão adicional de permissões.
- No acesso público `https://crm.silmer.com.br`, `/api/health/live`,
  `/api/health/ready` e `/healthz` responderam HTTP 200 após a aplicação.
  `/healthz` pertence ao edge: na porta interna da API respondeu 404,
  enquanto os dois endpoints internos da API responderam 200.
- Nenhuma migration contract, teste com DROP SCHEMA, preenchimento de canário,
  reenvio, alteração de pedido ou mutação de dados comerciais foi executada.

Esta entrega prepara o banco. A API e o edge ainda precisam receber a versão
da central para o menu aparecer e para conferir, no ambiente implantado, a
leitura pela conta designada e a negação das demais contas. A aplicação da
migration não comprova esse deploy nem o monitor externo da issue #11.
