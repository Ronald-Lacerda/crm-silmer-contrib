# Implementação local — subtotais por tamanho

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
