# ADR 075 — Retirada local de vínculo histórico sem liberar duplicata

Data: 09/11/2026. Status: adotada para o piloto.
Decisor de produto: proprietário, ao reservar a conferência histórica à operadora.
Decisor técnico: Tech Lead. Proposta: [RFC 059](../rfc/059-retirada-local-de-vinculo-historico-no-olist.md).
Rastreabilidade: RFC 050, OLIST-T16/T17, OLIST-18–20 e 30–32; [PR 332](https://github.com/romulosutil/crm-silmer/pull/332).
Complementa as ADRs 069/071: retirada local não é invalidação comum nem cancelamento ERP.

## Decisão

O comando administrativo versionado, idempotente e auditado de invalidação pode
retirar somente a afirmação local de um vínculo `legacy-sale-only-v1`, sem
recursos compartilhados, tentativas criadoras, jobs ou leituras em andamento.
A retirada exige os modos legados concordantes no snapshot, mapping e vínculo.
Não aplicar a vendas criadas pelo CRM nem a efeitos incertos ou em andamento.

Usar o estado terminal `legacy_review_required`, preservando IDs remotos,
unicidade, snapshot, mapping, readback, recibos e eventos. A venda continua
existindo no ERP. O pedido mantém o bloqueio de criação, edição, reabertura e
cancelamento comercial: retirar o aceite local não autoriza repetir uma venda
conhecida. O estado continua ativo para os locks e índices que impedem duplicata.
Não usar `invalidated`, pois esse estado permite uma nova geração.

A interface informa conferência histórica pendente e proteção contra nova
criação. Não oferece envio, reconciliação que reative o vínculo ou replay que
anuncie vínculo ativo. Não ampliar permissões da operadora nem criar fluxo de
reconfirmação implícita. Novos pedidos continuam na rotina de revisar e enviar.
Nenhuma chamada, alteração ou cancelamento é executado no ERP.

## Operação

A migração amplia somente os CHECKs de estado/identidade e o guard estrito do
recibo de retirada. A API autentica os três modos cifrados; o guard SQL independente exige o evento legado da mesma operação, IDs conservados e ausência de efeitos. A API mantém sessão atual, ACL administrativa, CSRF, versão,
motivo e idempotência. A persistência conserva o histórico anterior e acrescenta
a retirada; não apagar ou editar provas para simular que o vínculo nunca existiu.
Uma pendência humana conhecida e sem efeitos em andamento não habilita esse
pedido, mas também não bloqueia o teste de novos pedidos do piloto restrito.
