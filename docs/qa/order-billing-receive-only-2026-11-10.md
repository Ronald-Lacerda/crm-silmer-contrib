# Recebimento e conferência financeiros, 10/11/2026

BREL-08/09/04, tarefas T7/T8. Recebimento/conferência habilitados; emissão e
envios desligados. O escopo não inclui homologação de pagamento real nem go-live
de emissão. O proprietário será avisado antes de qualquer teste financeiro real.

## Fonte e verificações

O [PR334](https://github.com/romulosutil/crm-silmer/pull/334), SHA08feacd1cf6663852256be3f68dc71e0f62c9613,
foi integrado pelo mantenedor por rebase na master631909ea43f9b53ba876b87e870987f89b361c1f.
Comparação entre as duas árvores sem diferença. Os cinco checks do
[CI42747175641](https://github.com/romulosutil/crm-silmer/actions/runs/42747175641)
passaram, incluindo build/análise de runtime e edge-web.

- Local: validate2427 aprovados,52skips condicionais preexistentes,0falhas;
  tipos/lint/build/formatação e audit sem vulnerabilidades.
- Focais:37/37; revisão independente28/28 e sensor9/9 regressões detectadas.
- CI: PostgreSQL693/693 sem skips; Playwright853 aprovados,7skips preexistentes.

O piso local de32caracteres impedia a inicialização do cliente de conferência
com a Basic legada. O worker foi recuperado temporariamente com RECEIVEfalse.
A correção aceita a credencial existente sem alterar seus bytes e recusa branco,
CR/LF, usuário com dois-pontos e limites superiores256/1024. HTTPS, autorização,
redirect, timeout, idempotência e gates financeiros permanecem preservados.
Nenhuma credencial foi alterada; a chave InfinitePay continua privada no n8n.

## Workflows publicados

| Workflow | ID | Versão publicada | Nós |
| --- | --- | --- | --- |
| Emissão/recebimento | YI75ZEo33RsVbW4r | 71a6a9d3-4bc7-4450-a43d-0296af733e52 | 19 |
| Conferência | t5wxOAz2c8OUl9Hf | d774f29e-cc66-4f57-a41d-d67a3e27de3e | 11 |
| Atendimento com preflight | k7tI6T4RhQPyJkn9 | 9157724a-1493-4d85-91f7-582af4d73a1c | 144 |

Exports finais comparados integralmente com os baselines por revisão independente:
IDs, versões, nós, conexões, settings e referências de credenciais exatos.
Retenção de sucesso/erro none; execuções manuais e progresso sem salvamento.
Publicação do endpoint create não habilita emissão: os gates do CRM continuamfalse.

## Processos efetivos

| Serviço | Container | Processo | RECEIVE | ENABLED | CHAT_SEND |
| --- | --- | --- | --- | --- | --- |
| API | xbat6plqxobrhkh450gchf5ui | api, PID6 | true | false | false |
| Worker | nva64559ld004ru9pr95i81sn | worker, PID7 | true | false | false |

Papel e flags foram lidos de `/proc` do processo Node correto, sem imprimir
valores de credenciais. Hashes de server.js, worker.js e dos dois clientes
financeiros coincidiram com a fonte aprovada em ambos os containers.
O worker permaneceu no mesmo container/PID durante as leituras; processo
clamd presente. O cliente de conferência inicializou com a configuração real,
sem invocar transporte, antes de habilitar RECEIVE. A única edição de ambiente
foi RECEIVEfalse→true no worker; a API já estava em modo de recebimento.

Imagem observada no build do worker:
`sha256:f84600498551c5d6bdb34c5fb9d539bed507ff4f5303f0814621b742c9f80419`.
A identidade da API foi conferida por container e hashes de fonte; não foi
obtida nesta janela uma prova independente do seu image ID completo.

## Saúde, autorização e ausência de efeitos

- API live200, ready200 e edge health200 após a atualização.
- GET técnico de conferência com UUID comprovadamente ausente:404 BILLING_NOT_FOUND
  com Basic;401 INVALID_AUTOMATION_CREDENTIALS sem Basic.
- GET técnico de lookup da cobrança ausente:404 BILLING_CHARGE_NOT_FOUND com
  Basic;401 INVALID_AUTOMATION_CREDENTIALS sem Basic.
- Transações read-only antes/depois:71expand aplicadas, última0075, checksums
  exatos, nenhuma migração executada nesta janela. Contracts antigos0012/0018
  continuam fora dessa conferência expand e não foram executados.
- As seis tabelas de cobranças, pagamentos, estornos, intenções de envio,
  recebimentos externos e conferências permaneceram com contagem0. Fila billing
  vazia. Heartbeat global4s na leitura final; não é heartbeat dedicado de billing.

Esses GETs usam autenticação técnica dentro do container e comprovam a fronteira
da API, sem persistir registro financeiro. Não comprovam, isoladamente, que os
valores cadastrados no n8n sejam válidos perante CRM/InfinitePay. Nenhuma
consulta ao provedor, checkout, pagamento, callback fabricado ou mensagem foi
executada como probe. O ensaio financeiro real continua pendente de aviso e
autorização específica do proprietário.

## Evidências e recuperação

Artefatos privados e ignorados em `var/billing-receive-completion/`: exports
JSON/review, database-before.jpg, worker-patch-init.jpg, api-source-flags.jpg,
api-health.jpg, api-read-probes.jpg, worker-receive-flags.jpg,
worker-database-after.jpg e worker-final-proof.jpg. As imagens de console
contêm apenas comandos públicos, hashes, flags, códigos e contagens.

Em falha, manter emissão e enviofalse. Se não houver efeito financeiro,
RECEIVE pode voltarfalse no worker após conferir filas e registros, como na
recuperação anterior. Havendo link emitido ou pagamento possível, preservar
recebimento/conciliação para tratar os resultados pendentes. Não apagar filas,
histórico ou migrações e não repetir operações incertas. Fonte anterior87cbc435
e imagem runtime anterior80b27ae9 permanecem referências históricas do rollback,
cuja execução não fez parte desta janela.
