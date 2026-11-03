# Melhor Envio — aplicação da migration 0050 em produção

T139 / MEVQ-01–08 / OPS-CHK-01. Evidência de 02/11/2026, horário de
São Paulo, após autorização explícita do proprietário para executar as
migrations necessárias à [PR #260](https://github.com/romulosutil/crm-silmer/pull/260).
Procedimento e rollback: [runbook Melhor Envio](melhor-envio.md).

## Alvo e pré-checagens

- Projeto `espectro-mvp`, aplicação `silmer-api`, banco `silmer-postgres`,
  database `crm_silmer`. Não foram usados bancos de outros projetos.
- API, edge-web e worker apontavam para a revisão mergeada
  `5637ac4bbed68ab1440958b6b8edf9043b1cc3f2` na configuração do EasyPanel.
  Os três containers estavam em execução e saudáveis. A consulta ao banco foi
  feita pelo console da instância da API, sem exportar credenciais.
- O ledger estava em 0049; somente 0050 constava como expand pendente, sem
  divergência de checksum. As duas tabelas novas ainda não existiam.
- A API respondia live 200 e readiness 503 antes da aplicação. A VPS tinha
  60,7 GB livres, com 36,6% de uso do disco.
- Backup `silmer-pre-mev-t139-0050` concluído com sucesso no PostgreSQL antes
  da alteração: 806 kB, Local Disk, em 02/11 às 23:33:25 de São Paulo
  (03/11 às 02:33:25 UTC). Esse resultado não comprova cópia externa ou drill
  de restauração. A configuração de backup existente foi preservada.

## Execução e resultado

No container `0d3ee68d5a49` da API, foi executado o migrador canônico:

```sh
node /app/modules/database/src/cli.js --phase=expand
```

Primeiro resultado:

```json
{ "applied_count": 1, "phase": "expand", "status": "ok" }
```

A repetição retornou `applied_count: 0`, com a mesma fase e status. A consulta
posterior confirmou ledger 0050, nenhuma expand pendente, nenhuma divergência
de checksum e existência de `crm.shipping_quotes` e
`crm.shipping_quote_commands`. Checksum 0050:

```text
0061219af0ee289b757c0493b667d97db1dac73a7ce1edb5afee3235e7bed4c5
```

O comando não executou migrations contract nem SQL manual sobre pedidos.
Não houve alteração de configuração, segredos, fonte ou reinício dos serviços
por esta operação.

## Verificação após a aplicação

- `GET /api/health/ready`: HTTP 200, `status=ready`.
- `GET /api/health/live`: HTTP 200, `status=ok`.
- `GET /healthz`: HTTP 200.
- API `0d3ee68d5a49`, edge `7f9e1fbd1f69` e worker `9c11e0a95e15`
  continuaram saudáveis, sem troca de instância.
- IDs das imagens executadas, construídas pelo EasyPanel (não são os digests
  publicados no GHCR): API/worker
  `sha256:9f721d2528473cc3b868303127f13a4b6205d79046a3a8be3ade74926303a1f8`;
  edge `sha256:3286d728d867a90de922c081765dbc3f37810c50dc1257383e696b044a41d9d6`.

Essa evidência confirma a aplicação e a recuperação do readiness. Não declara
homologação funcional da cotação em uma conversa real, envio de mensagem,
compra de etiqueta ou teste de recuperação do backup.
