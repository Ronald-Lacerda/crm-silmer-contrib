# Contrato HTTP de cobrança, COB-CHAT-B01

PASS para a fronteira HTTP injetável. Persistência e transporte não estão
integrados. Base da revisão: `5dec408` mais o patch de B01, requisitos
BAPI-01–05 e ADR 076. Frontend adiado; nenhum arquivo do frontend modificado.

## Critérios e evidências

Fonte das asserções: `test/order-billing-chat-routes.test.js`.

| Critério                     | Evidência                                                                                                                                    | Resultado esperado                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BAPI-01, cinco ações         | L132 `assert.equal(response.statusCode, 202)`; L133 `assert.deepEqual(response.json(), INTENT)`; L134 comparação do comando inteiro delegado | 202 com projeção da intenção do serviço; contexto/ator/idem/correlação preservados. Não prova execução financeira.                                                       |
| BAPI-02, formas estritas     | L179 status400; L192 status400 por campo removido; L195 `calls.length === 0`                                                                 | Recusar extras, campos ausentes, números inseguros/coercíveis, 0%, destinos/texto arbitrários e confirmação inválida antes do serviço.                                   |
| BAPI-03, sessão/CSRF/origem  | L214 status403 e L225 `calls.length === 0`                                                                                                   | Sessão e origem/CSRF delegados ao autorizador; Basic recusado.                                                                                                           |
| BAPI-03, Admin/Financeiro    | L325 `assert.deepEqual(calls[0].actor.capabilities, ['COMMERCIAL_ADMIN'])`; teste L287                                                       | Política real recusa Financeiro; identidade e capacidade administrativas preservadas. Admin na baseline é Vendedor com capacidade ortogonal, sem alterar o ator na rota. |
| BAPI-04, flag explícita      | L238 `denied.json().code === 'BILLING_DISABLED'`; L284 idem sem opção enabled                                                                | Escrita desligada por padrão, sem submit; leitura continua autorizada.                                                                                                   |
| BAPI-05, headers e leitura   | L250–252 comparações de cache-control/referrer-policy/vary; L249 comparação integral da projeção                                             | Respostas privadas, sem cache compartilhado.                                                                                                                             |
| BAPI-05, paginação           | Teste L328, status400 e comparação do input com limit50/cursor                                                                               | Apenas selectors conhecidos, limite de 1 a 50, sem silêncio/coerção de query duplicada.                                                                                  |
| BAPI-05, projeções/erros     | L409 `assert.doesNotMatch(response.body, /private-canary/)`; L443 sem private-canary/database; comparação integral do problem JSON           | Serializadores descartam dados privados; erros conhecidos mantêm código e desconhecidos viram503 seguro.                                                                 |
| BAPI-02/05, limites de corpo | Teste L447, status413/400/415 e L466 sem stack/SyntaxError                                                                                   | Rejeitar excesso, JSON malformado e tipo não suportado sem chamar serviço.                                                                                               |
| BAPI-01, publicação          | L482/L483 comparação de schemas Intent/History e comparação de SendIntentCommand no mesmo teste                                              | OpenAPI coincide com as formas executáveis.                                                                                                                              |

Mapeamento reverso: os dez testes acima correspondem somente a BAPI-01–05.
As verificações de interface do adapter não são usadas como prova de
idempotência ou de concorrência no banco. BAPI-06–10 permanecem para B02–B04.

## Gates

- `npm run validate`, Node 24.20.0/npm 11.19.0: 1.775 aprovados, 15 skips
  preexistentes, zero falhas; build, typecheck, lint e demais checks passaram.
- Após acrescentar o caso de política Admin/Financeiro: contrato 10/10,
  typecheck e lint dos arquivos novos passaram novamente. Asserções existentes
  foram preservadas; novo caso usa a política real de capacidades.
- Instalação offline pelo lockfile sem scripts: zero vulnerabilidades no
  relatório dessa instalação. Não é evidência operacional do ambiente remoto.
- Validador de tasks passou, com aviso de diagrama não parseável; sequência
  linear T1→T2→T3→T4 conferida com `Depends on`.
- QA independente de Backend/Segurança revisou a fronteira e executou os
  nove testes então presentes: sem achados bloqueantes, escopo e limites
  explícitos. O décimo caso acrescenta prova da capacidade real.

## Limites

Rotas ainda não registradas na API de produção. Não há serviço persistente,
nova migração, callback integrado ou mensagem externa nesta entrega. ACL viva
e idempotência durável, correção/saldo sob lock, callback/outbox e reserva final
precisam dos testes PostgreSQL de B02/B03. B04 integra a flag e o runtime.
O Verifier de encerramento da feature ocorrerá após a última tarefa backend.
