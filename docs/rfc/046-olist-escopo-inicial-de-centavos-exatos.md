# RFC 046 — Escopo inicial Olist de centavos exatos

Data: 05/11/2026. Proposta aceita pelo PO na [ADR 059](../adr/059-olist-exportacao-com-unitario-exato-em-centavos.md).
Complementa a [RFC 044](044-geracao-assistida-de-pedidos-no-olist.md),
OLIST-09–10/14–17/40–43, T02/T06a/T08. Não altera os demais contratos de ACL,
cadastros, cancelamento, legado, loja ou impressão.

## Problema e alternativa escolhida

V2 e v3 não forneceram leitura monetária fiel nos casos fracionários C02–C04.
O PO escolheu seguir a implementação sem depender de suporte: restringir a
exportação automática ao unitário exato em centavos e provar esse subconjunto.
Mantêm-se os subtotais negociados e a validade do Pedido no CRM.

| Exemplo               | Decisão de exportação                      |
| --------------------- | ------------------------------------------ |
| 10 peças / R$ 180,00  | Elegível: R$ 18,00 por unidade             |
| 3 peças / R$ 0,03     | Elegível: R$ 0,01 por unidade              |
| 3 peças / R$ 1,00     | Bloqueada: divisão exige fração de centavo |
| 1.000 peças / R$ 0,01 | Bloqueada: unitário inferior a um centavo  |

Elegível não significa enviado nem autorização humana. ACL, versões, conta,
configuração, completude e reserva durável continuam obrigatórias nas etapas
posteriores. O núcleo local usa BigInt e snapshots congelados; não aceita
subtotais remotos declarados por metadata como comprovação independente.

## Prova controlada autorizada

Mesma conta, comprador e três variações existentes da prova anterior; sem
novo cliente/produto ou alteração de catálogo. Pedidos abertos em 05/11/2026,
origem CRM exclusiva e referências C05–C07 novas, ausência conferida antes do
POST. Não há lançamento fiscal, estoque, contas, cobrança ou mensagem.

| Caso | Linhas (quantidade × unitário)                                          | Total   |
| ---- | ----------------------------------------------------------------------- | ------- |
| C05  | M 3 × R$ 0,01; G 3 × R$ 0,02                                            | R$ 0,09 |
| C06  | M 1 × R$ 0,01; M 1 × R$ 0,02; M de outro pai 1 × R$ 0,03; G 1 × R$ 0,04 | R$ 0,10 |
| C07  | M 500 × R$ 0,01; G 1 × R$ 0,01                                          | R$ 5,01 |

Limites cumulativos: três tentativas de POST, 14 GETs, R$ 5,20 nominal.
Account/buyer/produtos conferidos antes das inclusões; uma troca OAuth não
entra no orçamento ERP. Cada POST é reservado antes da rede. ID confirmado
vai ao journal privado antes da conferência; toda falha para a sequência.
O mesmo journal impede novo orçamento por restart. Não apagar registros.

## Aceite para fechar F1 restrito

- Bloqueio dos fracionários antes do envio comprovado offline; CRM continua válido.
- JSON enviado preserva literalmente o unitário de duas casas, sem perda binária.
- Todos os marcadores de linha voltam íntegros/únicos, inclusive produto repetido.
- Produto, quantidade, unitário, cada subtotal calculado e ambos os totais iguais.
- Origem/referência e comprador corretos, três pedidos abertos identificados.
- Tela nativa confirma linhas e total; nenhuma emissão/lançamento é acionada.
- Negativos de divergência, perda de marcador, timeout, quota e restart passam.
- Limitações documentadas. Fase 1 completa não significa piloto/deploy liberado.

## Estado

Mudança de escopo aprovada; implementação e testes locais em andamento.
Prova remota pendente. F1 permanece aberto até evidência real consistente.
