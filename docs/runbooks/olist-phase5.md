# Olist — Fase 5: validação e preparação operacional

## T14 — revisão adversarial e regressão integrada (08/11/2026)

OLIST-01–50 da [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md), sobre
as entregas T11–T13 e T25 da [Fase 4](olist-phase4.md). **T14 está em andamento**:
a revisão terminou e parte dos achados foi corrigida; os itens abaixo marcados
como pendentes bloqueiam o gate F5. Geração real segue desligada, sem deploy,
conta habilitada, credencial ou piloto.

### Método

Quatro verificações independentes sobre `codex/olist-phase4-t11` em `baf7a884`,
três somente leitura e uma de execução, todas com dados sintéticos:

| Frente                                        | Escopo                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Segurança, privacidade, ACL, OAuth, front-end | OLIST-02–05, 12, 25–27, 32–33, 48                                                               |
| Concorrência, recuperação e integridade       | OLIST-13–17, 28–30, 36–41, 45–47                                                                |
| Rastreabilidade e regressão integrada         | Matriz OLIST-01–50 × teste, tabela de 30 cenários da RFC, Usuários/Pedido/Financeiro/loja/ficha |
| Execução SQL real                             | PostgreSQL 17.10, concorrência 1, banco recriado antes de cada suíte, `npm audit`               |

### Evidência executada

| Verificação                           | Resultado                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `test:olist:live`                     | 175/175, zero falhas, cancelados ou pulados                                                       |
| `test:orders:live`                    | 38/38                                                                                             |
| `test:finance:live`                   | 11/11                                                                                             |
| `test:identity:live`                  | 13/13                                                                                             |
| `test:operation-read:live`            | 2/2                                                                                               |
| painel e assistência de pedido (live) | 12/12                                                                                             |
| `npm audit --audit-level=high`        | Zero altas/críticas; uma baixa (`fastify`) e cinco moderadas (`eslint`, `fast-uri`, `ip-address`) |

PostgreSQL local não equivale a EasyPanel. Nada aqui comprova operação real.

### Achados e disposição

Nenhum crítico de duplicação de efeito, de dinheiro ou de cancelamento contra o
worker: reserva commitada antes de cada POST, incerteza sem repetição, soma em
inteiros e comparação por linha e total estão cobertas por testes SQL.

| Achado                                                                                                                                                       | Sev.                 | Disposição                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Os GET `administration` e `reconciliations` respondiam sempre 403 na fiação real (ações fora de `OPERATIONAL_READ_ACTIONS`); a T13 só os exercitou com mocks | Alto                 | **Corrigido**; teste com o runtime de identidade real (Admin 200; Vendedor/Financeiro habilitado 403)                                                   |
| Dado remoto inválido (nome vazio, id inválido) virava `INVALID_REQUEST` 400 e derrubava a prévia de todos                                                    | Médio                | **Corrigido**: `OLIST_INVALID_RESPONSE` 502, mensagem fixa                                                                                              |
| Códigos alcançáveis fora de `CODES` viravam 503                                                                                                              | Baixo                | **Corrigido**: cinco códigos mapeados em 409                                                                                                            |
| `open()` sem `authTagLength` nem validação de IV/tag em envelope enviado pelo cliente                                                                        | Baixo                | **Corrigido**                                                                                                                                           |
| Export que para antes do efeito (mudança de versão, de settings, reconexão, revogação, quota) fica sem saída e congela o Pedido                              | Alto                 | **Pendente, decidido em 08/11/2026**: comando administrativo que invalida export sem tentativa de venda e libera o Pedido (ADR/RFC próprios)            |
| Quota fixa de 30/min sem espera, compartilhada com a prévia: falha terminal e leitura pós-venda vira incerteza                                               | Alto                 | **Pendente, decidido em 08/11/2026**: espera/backoff somente leitura e folga reservada para a leitura pós-venda                                         |
| Comprador (ou produto) recorrente fica bloqueado após mudança cadastral (`payload_hash` imutável)                                                            | Alto                 | **Risco aceito do piloto** (decisão de 08/11/2026): o primeiro caso é de cadastro novo; contorno manual no runbook T15; revisão de base fica no backlog |
| Restore sem trava técnica (flags vivem no banco restaurado)                                                                                                  | Alto                 | **Risco aceito do piloto** (decisão de 08/11/2026): interlock procedural no runbook T15; marcador de época verificado no boot fica no backlog           |
| Numeração colide com `origin/master` (migrations 0063/0066/0067, ADRs 062/067, RFC 050) e a master tem leitores que ignoram `cancelled_at`                   | Crítico (integração) | **Pendente**: sessão de integração própria (decidido em 08/11/2026), antes de qualquer outro trabalho nesta branch                                      |
| OLIST-48 (identidade privada da operadora piloto) sem mecanismo; `creationEnabled` fixo em `false`; sem fatia vertical UI→API→worker                         | Médio                | **Pendente** em T15/T17; a fatia vertical sintética precisa existir antes de fechar F5                                                                  |
| Sem rotação de chaves (`keyVersion` 1, HMAC de identidade determina a conta)                                                                                 | Médio                | Procedimento e limite documentados no runbook T15                                                                                                       |
| Divergência de contrato: OpenAPI documenta 401 nos dois GET administrativos, o código devolve 403 (todas as rotas Olist)                                     | Baixo                | Registrada; decidir entre ajustar a documentação ou passar `authenticationFailureStatus: 401`                                                           |

Backlog menor, sem bloqueio de F5: dedupe de produto só por SKU determinístico,
retenção/expurgo de envelopes, congelamento comercial só na aplicação (sem trigger),
`context_key` ao trocar o aplicativo OAuth, classificação de 4xx de POST como
rejeitado, prévia que hasheia todos os recursos da conta, unicidade de ID remoto
entre produto e variação, telemetria Olist inexistente, e os baixos listados na
revisão.

### Lacunas de teste a fechar

- Isolamento por conta (OLIST-05) com duas contas no mesmo banco.
- Cancelados em `openDeliveries`, `storeNew`, `recordFirstPrint`, Inbox, assistência,
  n8n/assunto e cotação de frete; recibo tardio de loja cancelada.
- Metadado de trava de leitura contra PostgreSQL (hoje só com banco falso).
- Rate limit de `order-lookup`, prévia e exportação; composição de workers.
- Projeção Olist e lookup sem o estado cancelado (limite já registrado na T13).
- Cenários SQL de liveness e restore (export parado, quota esgotada na leitura pós-venda).
- Leitor de tela real e zoom: verificação manual, sem automação.

### Estado do gate F5

Aberto. Faltam: correção dos dois altos de liveness, integração com a master,
fatia vertical sintética, mecanismo de identidade do piloto (T15/T17), runbook
operacional (T15) e as lacunas de teste acima. Zero crítico/alto no backlog é
condição do gate; os dois altos aceitos como risco do piloto precisam constar
no aceite do proprietário.
