# F1-G01 — diagnóstico dividido em entregas

OLIST-T02 / OLIST-09–10, 14–17, 40–42. Continuação autorizada pelo PO em
05/11/2026: comparador local e prova limitada v2 × v3 nos pedidos já existentes.
Preserva [ADR 057](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 050](../../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Não altera o runtime, o modelo monetário ou a sequência de liberação de T03.

## Entregas e condição de passagem

| Entrega                                        | Estado                                        | Evidência / próximo passo                                                                                                          |
| ---------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A — comparador decimal local                   | Implementada e verificada offline             | [Comparador](monetary-comparator.mjs), testes e [reprodução histórica](evidence/monetary-comparison-historical.json)               |
| B — leituras dos pedidos existentes            | Concluída: seis resultados em sete tentativas | [Prova remota](evidence/monetary-readback-live-result.json); três GETs v3 e quatro POSTs de leitura v2, zero mutações de negócio   |
| C — avaliar leitor / esclarecer com fornecedor | V2 insuficiente; pergunta atualizada          | V2 reproduz as divergências v3. [Pergunta técnica pronta](monetary-readback-question.md); envio ao fornecedor ainda não autorizado |
| D — encerrar F1-G01 / T02                      | Bloqueada                                     | Regra suportada de precisão/arredondamento, identidade por linha, subtotais e total comprovados; então liberar T03                 |

As credenciais Olist expostas foram renovadas pelo PO antes da prova.
As dependências acessíveis foram revisadas e a conta conferida contra o plano
privado. O executor exige declaração de renovação; não realiza a troca nem
recupera segredos de saídas anteriores. Callback e permissões foram preservados.
A execução e os limites da auditoria estão registrados abaixo.

## O que o comparador resolve

- Usa os lexemas decimais retornados e BigInt, sem aritmética monetária binária.
  Aceita notação científica limitada e mantém zero diferente de campo ausente.
- C02: detecta 99/201 contra 100/200 centavos, apesar do mesmo total global.
- C03: conserva a divergência de total de produtos e a ambiguidade das duas
  linhas do mesmo produto/quantidade. Compara multiconjuntos por produto e
  quantidade, sem escolher linha pelo preço esperado ou posição na resposta.
- C04: preserva o unitário zero, o subtotal diagnóstico zero e o total divergente.
- Separa hipótese de arredondamento positivo half-up, identidade de linha,
  conferência de total e subtotal independente. Nenhum resultado local, mock
  ou remoto deste executor marca F1 como aprovado.

O histórico sanitizado já contém associação diagnóstica por linha de origem;
reprocessá-lo não é uma nova leitura independente do ERP. A v2 pode preservar
mais casas, mas isso sozinho não comprova regra de cálculo nem identidade para
as linhas repetidas. Se o retorno não resolver essas dimensões, B termina com
diagnóstico útil e D continua bloqueada.

## Preparação e execução da prova B

As rotas consultadas em 05/11/2026 são oficiais:
[obter pedido v3](https://api-docs.erp.olist.com/api-reference/pedidos/obter-pedido)
e [obter pedido v2](https://api-docs.erp.olist.com/api-v2/pedidos/obter-pedido).
A v2 usa POST `https://api.tiny.com.br/api2/pedido.obter.php`, com somente
`token`, `formato=json` e `id`; é consulta, sem inclusão/alteração.

1. `--prepare` lê os journals duráveis e a prova nativa já existentes em diretório
   privado ignorado pelo Git. Resolve exatamente C02–C04, os três produtos e o
   comprador. Rejeita IDs ambíguos ou criação sem reconciliação; não faz rede.
   Guarda plano privado e digest, sem copiar endereço, nome ou corpo fiscal.
2. Após renovação, obter credenciais atuais por canal privado e sessão da conta
   operacional verificada. O transporte deste diagnóstico recebe access token
   v3 já obtido e token v2; não implementa OAuth/refresh nem consulta `/info`.
   A identidade da conta precisa ter sido verificada na sessão de obtenção.
   Sem isso, parar; uma consulta auxiliar adicional requer orçamento explícito.
3. Fornecer via stdin JSON privado com `v3AccessToken`, `v2Token`,
   `credentialsRenewed: true` e `verifiedAccountDocument`. Não colocar valores
   na linha de comando, em chat, documentação ou arquivos versionados. O
   documento declarado deve corresponder à conta do plano; essa declaração
   não substitui a verificação operacional da sessão do passo anterior.
4. `--live` usa o plano preparado e cria exclusivamente um journal de seis
   leituras. Ordem: C02 v3/v2, C03 v3/v2, C04 v3/v2. Reserva e sincroniza cada
   tentativa antes do HTTP. Falha, timeout, 401, quota, redirect, identidade
   divergente, JSON inválido ou resposta excessiva interrompem sem retry.
   Divergência monetária válida é registrada para comparar os demais casos.
5. O journal não pode ser reaproveitado ou apagado para renovar orçamento.
   Em interrupção, revisar o consumido e obter novo orçamento antes de outra
   prova. O CLI não imprime respostas ou credenciais; resultados detalhados
   permanecem privados, somente com aliases e projeções monetárias. Publicar
   evidência exige revisão da projeção, nunca cópia integral do retorno.

Comandos a partir da raiz do worktree (diretório privado como argumento):

```text
node docs/integrations/olist/monetary-comparator.mjs --historical
node docs/integrations/olist/monetary-readback-probe.mjs --prepare <diretorio-privado-f1>
node docs/integrations/olist/monetary-readback-probe.mjs --live <diretorio-privado-f1>
```

O último comando espera o JSON privado no stdin. Não iniciá-lo com valores
antigos ou sem a sessão verificada. O plano privado foi preparado localmente;
o estado atual de execução está na seção de retomada operacional abaixo.

## Verificação

Testes offline incluem divergência por linha com total igual, identidade
repetida, precisão/overflow, credenciais não renovadas, conta divergente,
concorrência, persistência da reserva antes do HTTP, timeout, erro v2 em HTTP
200, quota, redirect, JSON/tipo/tamanho inválidos e privacidade do journal.
Mocks usam somente identidades inválidas/sintéticas, sem chamadas externas.

Evidências de 05/11/2026, Node 24.20.0:

- 26/26 testes novos aprovados, zero skips, incluindo cancelamento do body
  rejeitado antes de interromper a prova.
- Regressão dos sete arquivos de testes Olist: 96/96 aprovados, zero skips,
  antes do último ajuste de liberação de conexão. Depois desse ajuste, os
  26 testes novos foram repetidos e passaram. Sessões antigas foram executadas
  sequencialmente por compartilharem a porta de loopback; acesso remoto ERP
  permaneceu mockado. O sandbox inicialmente negou conexões de loopback;
  repetição fora do sandbox confirmou o conjunto.
- QA especializada sem finding bloqueante no escopo diagnóstico; a melhoria
  de cancelamento do body foi incorporada e testada.
- Preparação com journals privados reais concluída offline, sem consumir
  orçamento remoto. JSON público contém somente reprodução histórica sanitizada.
- Formatação, links locais e `git diff --check` conferidos no fechamento.

Não se aplicam build de UI, E2E ou banco live: não houve mudança em runtime,
dependências, migrations, permissões ou componentes do produto. A entrega é
uma ferramenta diagnóstica de T02, não a conclusão de T02 ou homologação ERP.

## Retomada operacional — renovação autorizada em 05/11

O PO renovou e salvou as chaves do aplicativo e renovou o token legado,
que permaneceu renovado após recarregar a página. Callback e permissões foram
preservados. A conta ERP foi conferida contra o plano privado. A auditoria
não identificou consumidor do token legado no runtime do CRM, nos ambientes
dos 44 serviços acessíveis nem nos corpos dos três workflows publicados do
n8n (250 nós; sem chamadas de subworkflow). Foram conferidos 12 nomes de
workflows não arquivados e 20 nomes de credenciais. A conta ERP lista Shopee,
TikTok Shop e o aplicativo de prova. Isso delimita o escopo verificado;
não comprova ausência de consumidores externos ou workflows arquivados.
A exportação do Checkout InfinitePay foi concluída manualmente pelo PO.

A [projeção sanitizada de prontidão](evidence/monetary-readback-readiness.json)
registra a renovação, o escopo da auditoria e as sete tentativas realizadas.
A primeira autenticação usou o valor de um campo oculto, que não correspondia
ao segredo revelado pelo controle Exibir; falhou antes de ler pedidos.
A captura correta, seguida de Ocultar, permitiu a troca OAuth.

O journal original registra C02/v3 comparado e C02/v2 HTTP 200 interrompido
por `INVALID_CONTENT_TYPE`, antes de interpretar o corpo. Foram consumidas
**duas das seis tentativas** nessa execução inicial. Não há resposta v2
recuperável dessa tentativa. O tipo MIME exato não foi registrado pelo leitor
anterior. O diagnóstico C02/v3 mantém 0,33 × 3 e 0,67 × 3: soma R$ 3,00,
mas subtotais calculados R$ 0,99/R$ 2,01 divergem da UI R$ 1,00/R$ 2,00.

O leitor atualizado aceita JSON v2 rotulado como `text/plain` ou `text/html`
no endpoint PHP fixo, com parse estrito, limite de tamanho e validação de
identidade preservados. HTML real continua rejeitado; v3 exige JSON.
O MIME é registrado apenas como enumeração segura.

O PO autorizou explicitamente as cinco leituras da retomada em 05/11,
com sete tentativas no total. A execução concluiu C02/v2, C03/v3, C03/v2,
C04/v3 e C04/v2, todas HTTP 200. As três respostas v2 eram JSON rotulado
`text/html`; as duas v3 eram `application/json`. O arquivo privado de aprovação
foi ativado somente após a resposta, e o SHA-256 do journal original permaneceu
igual. O journal de continuação é exclusivo, sem reinício ou retry.
A sessão foi encerrada após a coleta; nenhum token foi persistido em claro.

A [evidência remota sanitizada](evidence/monetary-readback-live-result.json)
contém seis comparações válidas em sete tentativas. O probe não realizou
mutações de pedidos, cadastros, fiscal, estoque ou financeiro; as duas
rotações autorizadas de credenciais são registradas separadamente.
V2 e v3 produziram os mesmos diagnósticos nos três casos:

| Caso | Resultado das duas APIs                                           | Limite observado                                                                            |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C02  | Unitários 0,33/0,67; total R$ 3,00                                | Multiplicação retorna R$ 0,99/2,01 contra R$ 1,00/2,00 na UI                                |
| C03  | Produtos R$ 1,08; pedido R$ 1,10                                  | Total de produtos diverge; duas linhas do mesmo produto continuam sem identidade inequívoca |
| C04  | Unitário 0,00 para mil unidades; produtos R$ 0,02; pedido R$ 0,01 | Perda de precisão e total do pedido divergente da UI R$ 0,02                                |

O fallback v2 foi testado e **não resolve F1-G01**. Não há base para repetir
as mesmas leituras esperando recuperar precisão nem para fechar T02.
A próxima dependência é uma rota/contrato suportado que preserve os valores e
identidade por linha. A [pergunta ao fornecedor](monetary-readback-question.md)
está atualizada com a comparação v2/v3, sem envio. A autorização de investigar
e concluir F1 não altera por si só o contrato monetário aprovado.

Os comandos abaixo documentam sessões já consumidas, não instruem repetir:

```text
node docs/integrations/olist/monetary-readback-session.mjs <diretorio-privado-f1>/monetary-readback --continue-five
```

Foi acrescentada [sessão OAuth específica](monetary-readback-session.mjs),
sem os oito GETs do coletor antigo. Ela importa um envelope RSA-OAEP/SHA-256
cifrado de 512 bytes, valida a declaração de renovação dos dois segredos e
o documento conferido na sessão ERP, troca uma vez o código OAuth e entrega
o access token em memória ao executor da agenda aprovada. Não há `/info`,
refresh, retry ou criação ERP implícitos. Callback de uso único limpa a URL;
fechamento/falha descartam credenciais. Não executar o coletor de leitura ou
de lote antigo para obter o access token desta prova.

```text
node docs/integrations/olist/monetary-readback-session.mjs <diretorio-privado-f1>/monetary-readback
```

O comando informa somente URL local e caminhos da chave pública/envelope.
O envelope privado contém `clientId`, `clientSecret`, `v2Token`,
`verifiedAccountDocument` e `credentialsRenewed: true`; a chave privada fica
em memória. Só gerar/importar esse envelope após renovação real e revisão
das dependências. Nunca colocar os valores em chat, argumentos de shell,
capturas ou arquivos em claro. Não há coletor real ativo; a sessão de continuação foi encerrada após a coleta.

Validação atual: 40/40 testes offline aprovados em Node 24.20.0, sem
skips, incluindo OAuth mockado + exatamente seis consultas, callback forjado,
credenciais não renovadas, fechamento durante importação do envelope,
aprovação separada da continuação e exatamente cinco leituras com OAuth mockado.
Regressão completa dos oito arquivos Olist: **111/111**, sem skips; QA da
continuação sem finding bloqueante. A prova remota registrou sete tentativas,
seis comparações válidas e zero escrita ERP; os testes usam rede simulada.
QA identificou uma corrida de descarte na importação; a guarda de fechamento
e o descarte em `finally` foram incorporados antes da publicação.

Incidente de coleta: a saída inicial do inventário de infraestrutura foi
emitida sem projeção e incluiu configurações com segredos. O usuário foi
informado; valores não foram copiados para arquivos versionados. Um registro
privado sanitizado de acompanhamento foi criado fora do Git, sem os valores.
A revisão de revogação/rotação dos demais serviços afetados está pendente e
não foi executada como parte da autorização restrita a Olist. As consultas
posteriores projetaram somente nomes/contagens/conclusões; não reemitir nem
publicar o inventário integral.

## Direção do PO após a comparação

Em 05/11/2026, o PO esclareceu que quer focar na implementação. A investigação
externa foi encerrada e a pergunta ao suporte permanece sem envio. A prova
negativa de leitura permanece registrada; não há fechamento artificial de F1
nem mudança dos critérios monetários. A preparação de código local pode
avançar desativada, com validação sintética e falha fechada para geração ERP.
Conexão real, inclusões e ativação continuam sujeitas aos gates próprios.
