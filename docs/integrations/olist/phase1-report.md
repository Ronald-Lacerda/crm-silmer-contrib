# Fase 1 Olist — resultado e limitação de leitura

OLIST-T02 / OLIST-03–17, 20, 26, 35–41. Fechamento das experiências autorizadas em
05/11/2026, na conta operacional escolhida pelo PO.
[RFC 044](../../rfc/044-geracao-assistida-de-pedidos-no-olist.md) ·
[ADR 057](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md) ·
[Resultados sanitizados](evidence/phase1-controlled-results.json).

**Experiências autorizadas concluídas; T02 e gate F1 continuam abertos por
F1-G01.** A UI permite comprovar cada linha destes casos, mas a leitura pública
v3 observada não fornece valores suficientes e consistentes para a futura
reconciliação monetária automática. Nenhuma inclusão confirmada foi repetida.
Não liberar T03/Fase 2 nem considerar este relatório uma mudança do contrato.

## Capacidades comprovadas nesta conta

- Cliente novo com dados fiscais reais aprovados: HTTP 200, tipo Cliente,
  situação B sem acesso; documento, razão social, endereço, IE e regime
  conferidos. Omitir somente `codigo`, após aprovação explícita, resolveu a
  rejeição anterior. O código permaneceu vazio; não foi atribuído pelo ERP.
- Produto pai V com M/G na inclusão composta: HTTP 201, SKUs/grade e IDs dos
  filhos conferidos. A prova não garante atomicidade de futuras inclusões.
- GG adicional: HTTP 201 retornou o ID do **pai**. A guarda interrompeu o lote;
  seis GETs confirmaram o filho canônico por pai/SKU/grade, mantendo M/G estáveis.
  O retorno original foi preservado e nenhum POST foi repetido.
- C02/C03/C04: três POSTs 201, origem exclusiva CRM e referências preservadas
  no detalhe e encontradas pela consulta. C01 permanece intacto, com sua perda
  original de referência registrada; não foi reenviado para corrigir isso.
- C03 preservou quatro linhas, inclusive duas do mesmo produto M e M de outro
  pai. A API reordena itens; posição do array não serve como identidade.
- Permissões de incluir/editar apenas em Contatos, Produtos e Pedidos; sem
  exclusão. A UI agrupa incluir e editar. Configuração da origem e gatilhos
  inspecionados; nenhuma configuração comercial global foi alterada.

O catálogo novo usa somente os valores explicitamente aprovados para a prova,
inclusive preço zero. Isso não define a política fiscal ou de preço do catálogo
real em produção. Nenhum CPF fictício foi gerado.

## Dinheiro: tela e API discordam

Valores abaixo são observações das respostas e da tela nativa, sem converter
um total global em prova das linhas. A data dos pedidos ficou congelada em
04/11/2026 conforme a autorização, mesmo com execução em 05/11.

| Caso | Unitários enviados, na ordem de origem               | Subtotais comprovados na UI        | Total UI | `valorTotalProdutos` API | `valorTotalPedido` API |
| ---- | ---------------------------------------------------- | ---------------------------------- | -------- | ------------------------ | ---------------------- |
| C02  | 3×0,3333; 3×0,6667                                   | R$ 1,00; R$ 2,00                   | R$ 3,00  | 3                        | 3                      |
| C03  | 0,005; 0,015; 1,025; 0,035, cada um com quantidade 1 | R$ 0,01; R$ 0,02; R$ 1,03; R$ 0,04 | R$ 1,10  | 1.08                     | 1.1                    |
| C04  | 1000×0,000010; 1×0,01                                | R$ 0,01; R$ 0,01                   | R$ 0,02  | 0.02                     | 0.01                   |

No C02 a API devolveu unitários 0.33 e 0.67. Multiplicá-los por três produz
99/201 centavos, embora a tela comprove 100/200. O total global igual não
identifica essa perda por linha. No C04 o unitário M voltou zero. No C03
os unitários voltaram 0.01/0.02/1.03/0.04, com linhas reordenadas, mas o total
de produtos voltou 1.08, diferente da soma dos subtotais visíveis e do total
da venda. No C04 é o total do pedido que diverge.

Portanto, **nenhum dos dois campos de total nem os unitários retornados pode
ser usado isoladamente como conferência automática fiel destes casos**. Não
corrigir a resposta localmente, ocultar a diferença, criar desconto, ratear
resíduo ou editar/recriar o pedido. A conferência nativa serve como evidência
manual da amostra; não implementa um leitor suportado para o worker.

O literal JSON `0.000010` foi preservado no envio. Ele contém seis posições
fracionárias, mas cinco casas significativas; não comprova escala máxima de
seis casas nem precisão interna de armazenamento. Os empates observados são
compatíveis com os centavos previamente esperados, sem provar uma regra
universal para todas as quantidades e valores.

## Recuperação, efeitos e limites

As duas rejeições anteriores do cliente permanecem registradas com reservas
próprias; a correção de `codigo` foi uma terceira tentativa explicitamente
aprovada, não um retry automático. A ambiguidade na leitura de C03 parou antes
de C04. A retomada conferiu a UI por linha e os resultados diagnósticos
previamente declarados, preservando expressamente a divergência do total de
produtos; não foi declarada fidelidade automática. Uma reconferência anterior
usou dois GETs e parou sem POST. C04 foi criado uma única vez, com o payload
original, após essa investigação somente leitura.

Checkpoint anterior à comparação v2 × v3 — lote adicional: **120 GETs autenticados, oito tentativas de POST (duas
rejeitadas e seis bem-sucedidas), um GET sem autenticação com 401**. Os tetos
aprovados estão esgotados. Incluindo as consultas anteriores e C01: 157 GETs,
nove tentativas de POST, 166 chamadas autenticadas; trocas OAuth não entram
nessa contagem. Um 401 OAuth ocorreu antes de qualquer chamada ERP e não criou
registro. O manifesto sanitizado discrimina todos os checkpoints.

Existem agora um cliente, um pai, três variações e quatro pedidos contando
C01: nove registros de negócio, criados por sete operações HTTP bem-sucedidas.
C02–C04 somam **R$ 4,12 na UI**, dentro do teto aprovado de R$ 10,00; com C01,
R$ 7,12. Permanecem no ERP, consomem números reais e incluem mil unidades de
M nos relatórios. Não houve limpeza, edição de registros existentes, repetição
de criação confirmada ou comando fiscal, de estoque, financeiro, cobrança,
expedição ou mensagem. A UI observada mostra pedidos abertos e lançamentos de
estoque/contas não realizados; isso não certifica todos os efeitos assíncronos
possíveis do provedor. Coletores encerrados; reservas/IDs privados preservados.

## Decisão do PO e investigação

Em 05/11/2026, o PO escolheu **manter bloqueado e buscar leitura confiável**.
Não foram adotadas a restrição a duas casas nem a conferência humana como
substituto. A [investigação pública](monetary-readback-research.md) não comprovou
um leitor monetário automático fiel. A pergunta técnica ao fornecedor está
preparada, sem envio. Na investigação pública inicial, anterior à comparação
v2 × v3 descrita abaixo, não houve novo GET autenticado ou efeito ERP.

Mantém-se F1-G01 aberto até comprovar um meio suportado de ler
subtotais e total com fidelidade. Não é necessário novo pedido para apresentar
o problema ao fornecedor. Preparar dúvida técnica não autoriza enviá-la nem
compartilhar credenciais, IDs ou dados fiscais. Novas consultas autenticadas
exigiam novo orçamento, posteriormente concedido para a prova v2 × v3.
O orçamento dessa prova também foi consumido: sete tentativas; não autoriza
reiniciar os coletores com os mesmos journals.

Alternativas não escolhidas, que exigiriam decisão explícita e registro do contrato:

1. Restringir geração automática aos unitários derivados exatos com até duas
   casas, mantendo os demais Pedidos válidos no CRM e bloqueados para Olist.
   Reduz o escopo de representabilidade aprovado; a precisão desse subconjunto
   ainda deve ser delimitada e validada, sem prometer que elimina todo problema.
2. Exigir conferência humana por linha na tela para casos fracionários.
   Acrescenta fluxo operacional e estados de revisão; não equivale a conciliação
   automática nem está autorizado por este relatório.

A decisão escolhida preserva T02 desmarcada até prova nova. F1-G02 e a
parte de roundtrip de F1-G04 foram comprovados na amostra; G03 tem um conjunto
fiscal real aceito, não uma validação fiscal universal. OAuth/refresh/PKCE,
concorrência, quotas compartilhadas e falhas de runtime continuam nos gates
T03/T04/T08/T09/T14/T15 correspondentes; mocks não são evidência remota.

Continuação em 05/11: o PO autorizou comparador local, renovação e retomada
de cinco leituras, sete tentativas no total. As duas credenciais foram renovadas
após auditoria no escopo acessível. A [prova v2 × v3](evidence/monetary-readback-live-result.json)
concluiu os seis resultados caso/versão; a tentativa v2 original consumiu um slot
sem parse por MIME, e sua substituição autorizada retornou JSON como `text/html`.
Journal original preservado, sete tentativas totais, seis comparações, zero
mutação de negócio pelo probe e coletor encerrado. As duas rotações de
credenciais autorizadas foram concluídas separadamente. V2 reproduz as divergências v3 em C02–C04:

| Caso | Resultado comum v2/v3                            | Consequência                                                       |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------ |
| C02  | Unitários 0,33/0,67; total 3,00                  | Subtotais calculados 0,99/2,01 contra UI 1,00/2,00                 |
| C03  | Produtos 1,08; pedido 1,10                       | Total produtos divergente e identidade de linhas repetidas ambígua |
| C04  | Unitário zero × 1000; produtos 0,02; pedido 0,01 | Perde a linha de um centavo e total pedido diverge da UI 0,02      |

**F1-G01/T02 continuam abertos.** O fallback v2 está descartado como solução
para estes casos. O próximo desbloqueio depende de rota e contrato suportados
pelo fornecedor, seguidos de prova nos pedidos existentes. O [rascunho técnico](monetary-readback-question.md)
foi atualizado, sem envio. Não houve decisão de reduzir precisão, aceitar só
total global ou trocar conciliação automática por conferência humana.

## Verificação e segurança

Os 25 testes do executor do lote passaram: 24 de guardas/retomada e um transporte OAuth
mockado em loopback. Nenhuma chamada externa foi feita pelos testes. Os hashes
em [evidência offline](evidence/controlled-batch-offline-result.json) identificam
os fontes atuais; os hashes do checkpoint corrigido são preservados à parte.
As evidências anteriores são históricas, inclusive propostas com `approval:
false` e `sendable: false`; não são instrução para reexecutar os casos.

Falha de mascaramento: saídas de ferramentas exibiram o segredo do aplicativo
e o token legado da conta sem máscara. Os valores não foram incluídos nos
arquivos versionados. Não repetir os valores. O PO renovou o segredo do aplicativo e o token legado após auditoria
das dependências acessíveis. Isso não modifica os registros criados.
O escopo e o acompanhamento da exposição de outros serviços estão no
[plano de retomada](monetary-readback-plan.md).

A revisão automática recusou uma cópia integral de resultados privados para
artefato público. A alternativa aceita exporta somente contagens inteiras
permitidas e conclusões explícitas; não copia corpos privados. Nenhum dado
sensível foi publicado por essa tentativa recusada.
