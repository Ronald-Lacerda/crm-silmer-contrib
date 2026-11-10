# Implementação local — subtotais por tamanho

## Plano vigente em 10/11/2026

[ADR 079](../../adr/079-olist-a-partir-do-pedido-confirmado.md), revisão 3 da
[RFC 050](../../rfc/050-geracao-assistida-de-pedidos-no-olist.md): a entrega
vigente é **Pedido confirmado → Gerar no Olist**, no detalhe atual.
Contrato [OLC-01–16](../../../.specs/features/olist-confirmed/spec.md),
[tarefas OLC-T01–T06](../../../.specs/features/olist-confirmed/tasks.md) e
[prompts por blocos](prompts-pedido-confirmado.md).

Os núcleos descritos abaixo são reaproveitados: o valor final é a soma dos
subtotais por linha de tamanho (mais frete, quando existir no Pedido) e a
composição aditiva, para Pedido antigo ou da loja que só tem total, preserva o
total/snapshot confirmado. A prova F1 continua restrita a centavos
exatos; o estado integrado das fases já entregues consta nos runbooks
`olist-phase3`/`olist-phase4` e na RFC 050. A atualização é documental. Referências
antigas a T03/T20/T21 não substituem o plano OLC; Financeiro, cancelamento,
busca/prévia ampliadas e ficha nova não são dependências da geração.

## Entregas anteriores e evidências

OLIST-T20a/T21a, preparação parcial de T20/T21. Requisitos OLIST-09–10,
40, 42–43, [ADR 057](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../../rfc/050-geracao-assistida-de-pedidos-no-olist.md).

Em 05/11/2026, após a comparação v2/v3, o PO pediu foco na implementação.
Nenhuma mensagem foi enviada ao suporte. A investigação externa foi encerrada;
a [limitação remota comprovada](evidence/monetary-readback-live-result.json)
continua registrada. Preparar este código local não fecha F1, libera T03 ou
ativa a geração ERP. Não há alteração de contrato monetário.

## Código entregue

O [núcleo de domínio](../../../modules/orders/src/domain/size-pricing.js) é
exportado pelo módulo Orders e opera somente sobre estado de propriedade do
servidor. Não é parser de payload HTTP nem permissão para o navegador informar
IDs, revisão humana ou totais.

- Cria IDs UUID de grupo e linha no servidor, sem inferir preços do catálogo
  ou dividir o valor final de pedidos antigos.
- Preserva IDs na alteração de quantidade e na reordenação. O mesmo tamanho
  em duas peças continua com identidades e subtotais separados.
- Duplica grupo com IDs novos, conservando o subtotal como valor para revisão,
  sem herdar sua aprovação.
- Aceita subtotal inteiro positivo em centavos; `null` representa ausência.
  Soma grupos e pedido com `BigInt`, rejeitando overflow antes de converter
  para o número inteiro seguro utilizado pelo domínio atual.
- Uma mudança de quantidade mantém o subtotal informado e invalida a revisão.
  Voltar à quantidade anterior não restaura a revisão automaticamente.
- Com preço ausente ou revisão pendente, o total do pedido é `null` e as
  pendências apontam os IDs das linhas. Não apresenta soma parcial como total.
- Rejeita coerção de strings, valores fracionários em centavos, zero/negativo,
  IDs repetidos, tamanhos repetidos no grupo, campos desconhecidos e arrays
  esparsos. Transições de preço/duplicação também recusam somas com overflow.

Os limites estruturais seguem o máximo atual de 50 grupos e 200 caracteres
para tamanho. Quantidades são inteiros positivos seguros, sem derivar do
campo de quantidade informada. O rótulo é aparado, sem normalização comercial
de catálogo nesta camada.

## Integração ainda necessária

T20/T21 permanecem desmarcadas. Ainda faltam persistência/migração dos IDs,
comandos autorizados com versão e auditoria, vínculo com a grade da ficha,
API e interface. Os futuros comandos humanos devem revalidar autorização e
versão, usar as transições de domínio e calcular o total antes da gravação
transacional. Nenhum endpoint deve importar `subtotalReviewed` do cliente.

Legado e loja dependem dos adapters/enriquecimento de T26/T24: snapshots,
valor confirmado e gateway atuais não são reescritos ou inferidos. Não há
chamada ao Olist, conexão, worker ou inclusão remota nesta fatia. Subtotais
válidos no CRM continuam válidos mesmo quando não representáveis no ERP.

## Evidências

[Testes](../../../test/orders-size-pricing.test.js), Node 24.20.0:

- 11 cenários novos de domínio; revisão independente encontrou um caso de
  array esparso que foi corrigido e coberto antes do fechamento.
- Regressão de pedidos e domínio/formatação de loja: 144/144, zero skips.
- ESLint do patch, fronteiras modulares, formatação e `git diff --check`.
- Typecheck do projeto com resolução dos pacotes para esta worktree. Os links
  de workspace compartilhados apontam para o checkout principal e causavam
  conflito nominal numa classe privada de mídia; um arquivo temporário em
  `var/` mapeou os pacotes locais, sem mudar a configuração versionada.
- Build de produção aprovado. O aviso de chunk frontend maior que 500 kB
  permanece, sem alteração de interface nesta entrega.

Não há mudança de banco ou superfície HTTP a validar em ambiente remoto.
Rollback desta preparação remove os exports e o arquivo novo; nenhum dado
persistido depende deles. Publicação do código não equivale a deploy ou piloto.

## Ampliação autorizada — bloqueio exato de exportação

A [ADR 062](../../adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) /
[RFC 046](../../rfc/046-olist-escopo-inicial-de-centavos-exatos.md) registra a
escolha posterior do PO pelo subconjunto exato. O módulo
[olist-exact-cent.js](../../../modules/orders/src/domain/olist-exact-cent.js)
usa o núcleo de subtotais e bloqueia a preparação inteira quando uma divisão
exige fração de centavo. O Pedido CRM permanece válido. O plano elegível é
copiado/congelado; sua conferência exige marcador único, quantidade, unitário
retornado e ambos os totais exatos, sem arredondamento ou compensação.

O [executor da prova](exact-cent-proof.mjs) chama a mesma guarda antes dos
POSTs e confere produto/SKU, conta, comprador, referência e identidade opaca.
O [modo OAuth](monetary-readback-session.mjs) exige aprovação/digest próprios
e guarda os limites 3 POSTs/14 GETs/R$ 5,20 em journal exclusivo. Timeout,
divergência e quota interrompem sem criar pedidos dependentes ou repetir POST.
ID confirmado é preservado antes da etapa seguinte. Não há rota de produção
ou UI habilitada: esta entrega implementa a fronteira usada pela prova e a
futura geração, sem afirmar que todos os fluxos CRM já estão integrados.

Validação atual: 160/160 testes de domínio/pedidos/loja e 126/126 testes Olist,
sem skips (conjuntos separados). Typecheck local, lint do patch com globals
Node das ferramentas de prova, fronteiras e build aprovados. QA independente:
29/29 testes de domínio/executor, sem finding bloqueante para a prova limitada.
A prova real C05–C07 foi concluída: 14 GETs, três POSTs e R$ 5,20 nominal.
[API e tela nativa coincidiram](evidence/exact-cent-proof-result.json), com
marcadores únicos preservados pela API. Coletor encerrado; F1/T02 fechados
apenas para o subconjunto exato, sem ativação de piloto/produção.


## Início da Fase 3 — T20b

Composição opt-in persistida e comandos humanos por identidade integrados à
API, com guardas de versão, ACL e idempotência. A preparação de domínio agora
possui uma primeira integração cifrada, sem concluir T20/T21. O trecho
“Integração ainda necessária” acima registra a entrega anterior; o estado
atual e as restrições estão no [runbook da Fase 3](../../runbooks/olist-phase3.md).


## T20/T21 concluídas no domínio/API

T20 completa a edição por identidade de grupos/linhas. T21 publica e persiste
somas exatas e confirma somente composição completa/revisada, com igualdade
para a declaração antiga. Não há rateio de legado ou preço livre. Mudança de
valor invalida quitação/check, preservando história. O estado atual, os gates
de UI/legado/loja e as evidências estão no [runbook](../../runbooks/olist-phase3.md).
