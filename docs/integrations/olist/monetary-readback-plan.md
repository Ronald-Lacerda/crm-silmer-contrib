# F1-G01 — diagnóstico dividido em entregas

OLIST-T02 / OLIST-09–10, 14–17, 40–42. Continuação autorizada pelo PO em
05/11/2026: comparador local e prova limitada v2 × v3 nos pedidos já existentes.
Preserva [ADR 057](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [RFC 044](../../rfc/044-geracao-assistida-de-pedidos-no-olist.md).
Não altera o runtime, o modelo monetário ou a sequência de liberação de T03.

## Entregas e condição de passagem

| Entrega                                        | Estado                                       | Evidência / próximo passo                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — comparador decimal local                   | Implementada e verificada offline            | [Comparador](monetary-comparator.mjs), testes e [reprodução histórica](evidence/monetary-comparison-historical.json)                                                |
| B — até seis leituras dos pedidos existentes   | Executor preparado; execução remota pendente | [Probe](monetary-readback-probe.mjs); três GETs v3 e três POSTs de consulta v2, zero mutações ERP                                                                   |
| C — avaliar leitor / esclarecer com fornecedor | Depende dos resultados B                     | Se v2 for fiel, especificar o leitor complementar; se divergir, completar a [pergunta preparada](monetary-readback-question.md). Envio ao fornecedor não autorizado |
| D — encerrar F1-G01 / T02                      | Bloqueada                                    | Regra suportada de precisão/arredondamento, identidade por linha, subtotais e total comprovados; então liberar T03                                                  |

O usuário informou que **as credenciais expostas ainda não foram trocadas**.
Não houve chamada autenticada nesta entrega. O executor recusa credenciais
sem declaração de renovação. O segredo do aplicativo deve ser renovado antes
de novo OAuth; revisar dependências antes de revogar/trocar o token legado.
A prova não realiza rotação, não recupera valores de saídas anteriores e não
altera aplicativos ou permissões da conta.

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
nenhuma reserva de leitura remota foi consumida.

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

O PO autorizou explicitamente renovar as credenciais, conferir dependências
do token legado e executar as seis consultas. A inspeção encontrou sessão
Olist expirada; o login foi solicitado ao usuário. Não houve renovação,
revogação ou chamada autenticada ao ERP. O journal remoto ainda não existe:
seis leituras permanecem disponíveis, e F1-G01/T02 continuam abertos.

A [projeção sanitizada de prontidão](evidence/monetary-readback-readiness.json)
registra os limites da revisão de dependências:

- Nenhuma referência Olist/Tiny nas fronteiras de runtime/configuração
  rastreadas do CRM consultadas.
- As configurações de ambiente dos 44 serviços acessíveis foram verificadas
  sem encontrar variável com nome/referência Olist/Tiny/API v2.
- Na UI n8n foram observados 12 nomes de workflows não arquivados e 20 nomes
  de credenciais sem identificação Olist/Tiny. Isso não verifica tokens
  embutidos nos corpos dos workflows, credenciais genéricas ou fluxos arquivados.
- As integrações da conta ERP não foram verificadas nesta retomada por falta
  de sessão autenticada. **Ausência de dependência não está comprovada**;
  não revogar o token legado com base apenas nessas buscas.

Foi acrescentada [sessão OAuth específica](monetary-readback-session.mjs),
sem os oito GETs do coletor antigo. Ela importa um envelope RSA-OAEP/SHA-256
cifrado de 512 bytes, valida a declaração de renovação dos dois segredos e
o documento conferido na sessão ERP, troca uma vez o código OAuth e entrega
o access token em memória ao executor das seis leituras. Não há `/info`,
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
capturas ou arquivos em claro. Não há coletor real iniciado nesta etapa.

Validação da retomada: 31/31 testes offline aprovados em Node 24.20.0, sem
skips, incluindo OAuth mockado + exatamente seis consultas, callback forjado,
credenciais não renovadas e fechamento durante importação do envelope.
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
