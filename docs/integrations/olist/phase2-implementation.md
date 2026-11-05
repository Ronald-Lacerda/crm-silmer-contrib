# Fase 2 Olist — implementação e handoff

05/11/2026. Entrega integrada OLIST-F2, responsável Tech Lead.
Base aprovada: c46a661e, F1/T02 concluída para exact-cent-v1.
[Contrato](../../rfc/050-geracao-assistida-de-pedidos-no-olist.md) ·
[ADR 057](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md) ·
[ADR 062](../../adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) ·
[Operação e rollback](../../runbooks/olist-phase2.md).

A confirmação do PO liberou esta fase. O RFC e o checkpoint permaneceram sem
alteração no commit de implementação, conforme a divisão de responsabilidade
informada no chat. A pedido posterior do PO, foram atualizados para registrar
o encerramento de T03/T04/T19/T05 e o
[checkpoint atual](../../../.specs/features/crm-mvp/tasks.md#olist-f2--fase-2-concluída-05112026).
Este relatório não substitui o histórico da Fase 1 nem declara implantação ou piloto.

## Escopo implementado

- [x] OLIST-T03: migrações expand 0063/0064, vínculos por conta/identidade,
      snapshots cifrados/imutáveis, tentativas duráveis, eventos append-only,
      constraints e publicação transacional de jobs contendo apenas IDs.
- [x] OLIST-T04: OAuth com estado de uso único por sessão/ator e dez minutos,
      conta esperada, tokens cifrados, refresh reservado entre réplicas,
      fencing, expiração, settings centrais versionados e disconnect.
- [x] OLIST-T19: checkbox em Usuários com default falso, CAS, auditoria,
      negação de auto-habilitação, autorização ortogonal e revogação efetiva.
      Entrada Olist para Financeiro habilitado e projeção mínima entre donos.
- [x] OLIST-T05: consultas oficiais fechadas, busca exata/ambígua/completa,
      paginação/tempo/corpo limitados, quota PostgreSQL por conta e métodos
      de criação fechados. Nenhuma rota HTTP genérica ou URL arbitrária.
- [x] Gate F2 local: conexão/ACL protegidas e criação desligada.

Nenhuma conta real foi habilitada. Não há exportação, prévia comercial,
cadastro remoto, handler gerador ou ativação de piloto nesta entrega.
As tarefas de subtotal integrado, legado/loja, completude, cancelamento,
resolução de cadastros e venda continuam na Fase 3. A validade comercial do
Pedido e os templates existentes permanecem preservados.

## Fronteiras e evidências

Dados e recuperação ficam em modules/olist e nas migrações expand.
A API integra as rotas /integrations/olist e a projeção /orders/:id/olist.
Usuários, sessão e o shell Vue compartilham a mesma autorização.
[OpenAPI](../../api/openapi.v1.yaml) publica os campos e os comandos, sem
permitir ator, conta, payload ERP ou total arbitrários no navegador.

As numerações 0063/0064 evitam colisões com migrações de outras entregas.
A extensão da outbox compõe os CHECKs instalados via pg_get_expr: preserva
tipos/alvos anteriores, inclusive billing.checkout.create, em vez de reconstruir
uma lista desatualizada. A regressão de upgrade prova jobs de cobrança antes e
depois da migração, rejeições anteriores, alvo/fila/política Olist e replay.

A revisão de QA também corrigiu CHECKs JSON que aceitavam NULL, FK do tipo
do pai, atomicidade da autorização/idempotência, identidade do detalhe ERP,
captura OAuth antes do Router, tratamento móvel/foco e proteção de logs/cache
do callback. A lista de catálogos contém somente as cinco rotas oficiais
conferidas; natureza de operação não ganha endpoint inferido.

## Validação local final

Node 24.20.0, npm 11.19.0, dados sintéticos:

| Gate                                             | Resultado                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| npm run validate                                 | Aprovado; formatação, tipos, lint, fronteiras, tokens, segurança, topologia, regressão e build |
| Testes do validate                               | 1.779 aprovados, zero falhas, 15 skips por gates/ambientes explícitos                          |
| npm run test:olist:live                          | 36/36, zero skips, PostgreSQL real dedicado                                                    |
| Regressão SQL de identidade                      | 13/13                                                                                          |
| Regressão SQL de worker/outbox                   | 2/2; repetida após compor os CHECKs                                                            |
| Regressão SQL de frete existente                 | 12/12                                                                                          |
| E2E completo, porta isolada 4187, quatro workers | 485 aprovados, zero falhas, 7 skips previstos                                                  |
| E2E específico Olist                             | 8/8, incluindo teclado, foco e axe em desktop/mobile                                           |
| npm audit --audit-level=high                     | Aprovado; zero altas/críticas, 1 baixa e 5 moderadas na baseline                               |
| OpenAPI                                          | YAML válido, referências locais verificadas                                                    |
| git diff --check                                 | Aprovado                                                                                       |

Os SQLs usam somente crm_silmer_test dedicado, com runner serial e concorrência
interna preservada nos cenários. PostgreSQL portátil 18.6 foi utilizado
localmente, sem serviço do Windows ou dependência nova no produto.
O runner foi incluído no CI existente, que usa PostgreSQL 17.
O aviso preexistente de bundle acima de 500 kB permanece.

A primeira passagem E2E apontou a expectativa antiga de navegação; o teste foi
alinhado à entrada Olist em desktop/mobile. O caso de foco no resize da Inbox
passou isoladamente e na repetição integral, sem mudar sua implementação.

## Publicação, operação e limites

Branch `codex/olist-phase2`, commit/push de implementação
[6a79cc8a](https://github.com/romulosutil/crm-silmer/commit/6a79cc8aecc3111dbfad5b8b14220f3b3df860aa).
O worktree principal e as mudanças dos
outros agentes foram preservados; grafo não foi gerado nem versionado.

Zero chamadas autenticadas ao ERP, zero efeitos remotos e zero deploy nesta
implementação. O controle de geração permanece fechado mesmo com variável de
ambiente tentando liberá-lo; novas contas também exigem recovery explícito.
As reservas/snapshots/vínculos não são apagados no rollback.

Docker não está instalado nesta máquina: nginx real, imagem/digest e smoke
do container dependem do CI/ambiente alvo. A proteção do callback no Traefik,
consentimento real, conta, parâmetros e ID privado da única operadora devem
ser conferidos antes da ativação posterior. Código/teste local não equivalem
a evidência operacional.

Próxima fronteira prevista no plano: Fase 3, começando pela integração
persistida de IDs/subtotais e completude, mantendo o bloqueio de frações de
centavo e as guardas de geração da ADR 062.
