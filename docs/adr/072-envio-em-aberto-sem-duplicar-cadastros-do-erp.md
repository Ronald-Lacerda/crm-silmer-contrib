# ADR 072 — Envio em aberto sem duplicar cadastros do ERP

Data: 09/11/2026. Status: adotada para o piloto individual.
Decisor de produto: proprietário, no chat, ao determinar Olist independente e
menos ações no CRM. Decisor técnico: Tech Lead.
Proposta: [RFC 056](../rfc/056-envio-simples-da-ficha-com-cadastros-no-olist.md).
Rastreabilidade: RFC 050, OLIST-07–08, 11–12, 16–20, 25, 30–32, OLIST-T15–T17.
Supersede a rotina de preenchimento fiscal/vencimento no CRM da
[ADR 071](071-vencimento-explicito-e-vinculo-historico-isolado-no-olist.md),
preservando seus modos anteriores para compatibilidade e seu vínculo histórico
isolado. Não muda os contratos de centavos exatos ou recuperação.

## Decisão

A operadora revisa e confirma o envio em dois gestos. A prévia e sua
revalidação são automáticas antes do diálogo; só a confirmação final autoriza
efeitos. Remover etapas e campos repetidos não remove os gates de servidor.

O modo `erp-existing-v1` usa comprador já existente, selecionado por uma
correspondência única de nome e telefone normalizados. Ativos documentados A/B
podem ser referenciados; inativo/excluído e busca incompleta são recusados.
A operação guarda somente ID, identidade mínima e hashes por conta, em
envelope cifrado. Nenhum cadastro fiscal é importado para Contact. Resolver e
dispatcher releem a referência antes dos efeitos e não reservam nem incluem
cliente nesse modo. A vinculação histórica confere o comprador da própria
venda, sem exigir duplicação do cadastro fiscal.

`paymentDuePolicy=erp` omite pagamento e parcelas; o vencimento pertence à
rotina do ERP. A condição da ficha é transmitida somente por texto fixo da
enumeração aprovada. Os modos `fixed_date` e `per_order` continuam compatíveis,
sem troca de valores no replay. Fiscal adiado é uma decisão server-owned,
congelada com o snapshot; omite os três campos opcionais no produto. Não é
classificação fiscal, preenchimento por default nem produto com status
“rascunho” inexistente. O pedido é incluído em aberto, situação 0.

## Consequências

Dados existentes do ERP não são sobrescritos. Cliente sem identificação segura
gera pendência, sem fallback criador. Dados completos já declarados no CRM
mantêm o caminho anterior; não mesclar fontes para completar lacunas.
NF, faturamento, pagamentos integrados, estoque e baixa seguem fora do envio.
Valores e identidades continuam conferidos no retorno; falhas não autorizam
inventar cadastro ou repetir um POST incerto.

O primeiro teste real deve observar a aceitação do produto sem a tripla fiscal
e a venda em aberto. Este é um limite da evidência, não justificativa para
recolocar formulários fiscais no CRM. O [runbook](../runbooks/olist-phase6.md)
registra o piloto e os gates de recuperação separados.
