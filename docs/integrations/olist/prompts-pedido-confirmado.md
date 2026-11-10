# Prompts para gerar venda Olist pelo pedido confirmado

O resultado esperado é abrir um Pedido **Confirmado**, clicar em **Gerar no
Olist**, acompanhar na mesma página e receber o número da venda ERP conferida.
Os dados vêm do Pedido estruturado; o PDF não é enviado nem interpretado.

Use os blocos 1 a 6 em ordem. Cada bloco corresponde a uma tarefa com entrega,
evidência, commit e push próprios. Os blocos 7 e 8 são trilhas separadas e não
precisam ser executados para concluir a geração. Estes prompts orientam o
trabalho futuro; não indicam que a implementação já foi feita.

Contrato: [OLC-01–16](../../../.specs/features/olist-confirmed/spec.md).
Tarefas: [OLC-T01–T06 e OLC-F01–F04](../../../.specs/features/olist-confirmed/tasks.md).
Decisão: [ADR 079](../../adr/079-olist-a-partir-do-pedido-confirmado.md).
O planejamento documental OLIST-PLAN-03 está na
[lista principal](../../../.specs/features/crm-mvp/tasks.md).

## Regras para todos os blocos

Trabalhe no checkout adequado, seguindo AGENTS.md e a precedência das fontes.
Leia o estado atual antes de editar; preserve mudanças locais de terceiros.
Consulte o grafo existente somente para descoberta, confirme com `rg` e fontes
atuais e nunca gere ou versione Graphify no Windows. Use somente infraestrutura
existente, dados sintéticos e os componentes Vue atuais.

A entrega principal não inclui remoção Financeiro, exportação de pendentes,
menu/busca Olist, prévia obrigatória, cancelamento local ou troca de ficha.
Mantenha a habilitação individual e a autorização de leitura comercial sem
acrescentar edição geral. Não exigir pagamento integral ou check Nota criada.
Não invente preços, rateie total histórico, arredonde centavos nem repita uma
inclusão de resultado incerto. Não execute scripts de prova como produção.

Ao encerrar cada bloco, informe: tarefa/requisitos, arquivos alterados,
comportamento, verificações/resultados, migração/rollback, commit/push e riscos.
Só marque tarefas realmente concluídas. Código/teste local não comprova deploy
ou efeito real no ERP. Nunca inclua PII, credencial ou link privado na evidência.

## Bloco 1 Dados e autorização

```text
Implemente OLC-T01 de .specs/features/olist-confirmed/tasks.md, atendendo
OLC-01–06/09/10/14. Leia primeiro a spec correspondente, a ADR 079 e as regras
gerais deste documento. Objetivo: preparar Pedido confirmado e dados ERP sem
alterar sua confirmação, total, ficha/PDF, cobrança ou pagamento históricos.

Pode editar módulos Orders, Contacts e Identity Access, rotas/runtimes API
correspondentes, migrations expand, OpenAPI e testes. Não edite Financeiro
para removê-lo, templates de impressão ou a jornada n8n. Preserve alterações
locais de terceiros e confirme nomes/caminhos atuais com rg antes de editar.

Implemente Habilitado Olist default falso, gerido por Admin, com autorização
explícita na API: humano ativo + leitura comercial do Pedido + checkbox + piloto.
Admin precisa do checkbox. Não acrescente projeção/entrada ao perfil Financeiro.

Reutilize size-pricing.js e olist-exact-cent.js. Persista IDs estáveis e composição
por tamanho por comando aditivo versionado/auditado. Derive grade/IDs no servidor
e vincule 1:1 aos grupos/tamanhos/quantidades confirmados, sem editar grade ou
atributos pelo enriquecimento. Soma backend deve igualar finalAmountCents
confirmado. Ausência exige preenchimento humano, sem rateio.
Trate loja/legados por adapter e complemento ERP aditivo, sem destravar checkout.
Não substitua globalmente o campo de valor final nem reescreva snapshot/PDF.

Defina registros de operação, recursos compartilhados e tentativas, snapshot
cifrado, referências estáveis e unicidades por conta/Pedido/identidade. Prepare
contratos e guardas de alteração incompatível, inclusive reabertura e correção
administrativa da loja, para a reserva serializada do bloco 3.

Verifique autorização positiva/negativa, preço ausente/inexato/divergente,
quantidade alterada, identidades de linhas, overflow e migrations no PostgreSQL
dedicado com dados sintéticos. Use comandos existentes do projeto; documente
rollback e evidências. Não ative conta nem crie cadastros/vendas reais.
```

## Bloco 2 Conexão e comunicação com Olist

```text
Implemente OLC-T02 após conferir a conclusão e o contrato de OLC-T01.
Requisitos OLC-04/06–08/11/12/14. Leia a spec OLC, a ADR 079, regras gerais
deste documento e phase1-report.md; preserve o escopo exact-cent-v1.

Pode editar adapter/runtime de integração na API/worker/módulos existentes,
configuração, migrations compatíveis, OpenAPI, testes e runbook relacionado.
Não crie serviço, Redis, store global ou acesso n8n direto ao banco. Preserve
Financeiro, billing e impressão. Não ligue scripts de prova ao runtime.

Implemente conexão administrativa central com sessão/CSRF, conta esperada,
tokens cifrados, renovação serializada, desconexão e parâmetros comerciais
explícitos/versionados. Não use usuário CRM para inferir vendedor ERP.

Implemente adapter limitado para resolver e criar comprador/produto/variação,
criar venda e ler resultados. Confira identidade fiscal/comercial, conta,
referência, produtos, quantidades, marcadores e valores exatos. Não altere
cadastro remoto encontrado nem peça escopos fiscais/estoque/baixa desnecessários.

Reaproveite fixtures e descobertas das provas, sem IDs de casos reais,
credenciais, journals ou digests antigos. Teste quota, expiração, falha de
renovação, resposta sem ID, timeout e divergência com fixtures sintéticas.
Nenhuma escrita real é autorizada por este bloco. Entregue configuração e
runbook sem segredos, contratos, testes, limitações e rollback.
```

## Bloco 3 Geração e recuperação

```text
Implemente OLC-T03 após OLC-T01/T02. Requisitos OLC-01/03/07–12/14.
Leia a spec OLC, ADR 079, regras gerais e contratos entregues nos blocos anteriores.
Objetivo: um comando por Pedido confirmado cria uma única venda conferida.

Pode editar aplicação/repositórios Orders e integração, API/worker, migrations
compatíveis, OpenAPI, testes de concorrência e runbook. Preserve Financeiro,
InfinitePay, templates e comandos comerciais não relacionados. Não crie
prévia obrigatória ou vínculo genérico de vendas antigas como dependência.

O comando valida status confirmado, ator/checkbox/piloto, cadastro e todas as
linhas/valores antes de inclusões. Congele conteúdo/configuração e grave reserva,
snapshot, auditoria e job numa transação. Duas abas, chaves distintas e replay
devem retornar a mesma operação sem segunda venda.

Execute cliente → produtos/variações → venda. Reserve cada recurso compartilhado
por conta/identidade, persista IDs e revalide acesso/versões antes de cada efeito.
Serialize com reabertura e correção da loja; bloqueie alterações incompatíveis
durante envio e após sucesso. Não declare pagamento nem mude status comercial.
Use revisão/fingerprint do conteúdo comercial relevante ou revalide esse
conteúdo quando a versão global mudar só por pagamento/entrega compatíveis;
essas ações não devem invalidar envio cujo conteúdo continua idêntico.

Implemente estado persistido, conferência exata e recuperação administrativa
mínima da própria operação. Resultado incerto bloqueia criação e dependentes;
busca vazia não permite reenviar. Retomada criadora exige ausência de efeito
comprovada e revalidação. Divergência preserva ID e pede conferência.

Verifique PostgreSQL com conexões/processos independentes, falha após cada
cadastro, crash, resposta perdida, commit falho após sucesso remoto, revogação,
reabertura concorrente e replay. Use dados sintéticos, sem POST real ao Olist.
Documente restauração/rollback preservando vínculos e efeitos externos.
```

## Bloco 4 Interface dentro do pedido

```text
Implemente OLC-T04 após OLC-T01–T03. Requisitos OLC-01–06/10/13/14/16.
Leia a spec OLC, ADR 079, regras gerais, design.md e contratos API atuais.
Objetivo: no detalhe existente de um Confirmado, clicar Gerar no Olist e
acompanhar o resultado na mesma página.

Pode editar OrderView e componentes/composables associados, UsersView para o
checkbox, configuração administrativa mínima, CSS pelos tokens atuais e E2E.
Confirme os caminhos com rg. Preserve Gerar pedido, Gerar PDF, billing,
FinanceView, loja, versões da ficha e mudanças locais de terceiros.

Adicione bloco Olist com pendências por campo/peça/tamanho e composição
monetária autorizada. Total confirmado permanece somente leitura e a soma
precisa coincidir. Usuário sem permissão de correção vê motivo/responsável.
Não crie menu/busca Olist, assistente ou tela de prévia obrigatória.

Ligue Gerar no Olist ao comando real. Mostre Aguardando processamento,
Processando… com etapa, Gerado no Olist · Venda nº … e o número CRM.
Recupere após reload; previna novo envio. Falha de consulta mostra Atualizar
situação, que só lê. Incerteza mostra Conferência necessária, sem retry criador.
Retomar geração só aparece se o servidor comprovar a ação segura.

Valide teclado, foco, erro associado, ARIA sem anúncios excessivos, axe,
claro/escuro, desktop e 320/390 px, duas abas, reconexão e revogação.
Teste integração UI/API/banco local sintética, além de mocks de falha;
não declare integração operacional com base apenas em mock.
```

## Bloco 5 Verificação e preparo de publicação

```text
Execute OLC-T05 após OLC-T01–T04, cobrindo OLC-01–16. Leia spec, ADR 079,
regras gerais, CONTRIBUTING.md e runbooks de integração/operação vigentes.
Objetivo: verificar a entrega integrada e preparar alvo com escrita desligada.

Pode editar testes, evidências sanitizadas e runbook. Em achado de código,
apresente a fronteira e coordene a correção antes de editar arquivos de outro
dono. Preserve Financeiro, pagamentos, PDF, loja e alterações locais.

Execute cenários positivos/negativos/concorrentes da spec e regressão de
confirmação/reabertura, correção da loja, billing e permissões. Rode
git diff --check, npm run validate, npm run test:e2e,
npm audit --audit-level=high e suítes live/gates pertinentes já existentes.
Não invente nome de script nem substitua gate externo por mock.

Prepare runbook de conta/credenciais, parâmetros fiscais/comerciais explícitos,
quotas, retenção/PII, recovery, reconexão e rollback. Verifique migrations,
compatibilidade, release/digest e health no alvo quando autorizado; criação
deve permanecer desligada até o piloto autorizado do bloco 6.

Entregue achados priorizados, evidências, riscos e pendências operacionais.
Não exija remover Financeiro, implementar cancelamento, busca ou trocar ficha.
Nenhuma venda real é criada neste bloco.
```

## Bloco 6 Piloto e aceite

```text
Execute OLC-T06 somente após o gate OLC-T05. Requisitos
OLC-02/08/11/12/15/16. Leia spec, ADR 079, regras gerais e runbook final.

Objetivo: comprovar Pedido confirmado → Gerar no Olist → venda conferida,
com a operadora piloto e a conta ERP corretas. Pode atualizar configuração
privada autorizada e evidências sanitizadas; não altere outros usuários,
gatilhos comerciais, estoque, notas ou cobranças fora do caso aprovado.

Primeiro prepare um caso concreto revisável: Pedido confirmado, identidade
privada validada, conta, parâmetros, comprador/produtos, valores e efeitos
esperados. Verifique se há venda manual anterior; nesse caso não crie outra
nem improvise vínculo genérico. Obtenha autorização explícita para os efeitos
reais se ela ainda não existir na sessão; este prompt não autoriza POST real.

Após autorização, habilite somente a conta piloto prevista e execute pelo
detalhe do CRM. Confira comprador, grade, quantidades, cada valor, ambos os
totais e número remoto. Observe reload/replay sem duplicidade e recuperação
conforme runbook, sem injetar falha destrutiva em dados reais.

Registre versão/digest, migrations, resultado sanitizado, suporte e aceite
do PO/Operação. Se houver incerteza, pare novas inclusões, preserve IDs e
reconcilie. Não apague cadastros nem cancele ERP como rollback técnico.
Ampliação de usuários depende de decisão própria após o aceite.
```

## Bloco 7 Remoção independente do Financeiro

Este bloco é FINQ-DEPREC-01. Pode ter cronograma próprio; não é requisito
para executar nenhum bloco 1 a 6.

```text
Trabalhe somente em FINQ-DEPREC-01 de .specs/features/financeiro/tasks.md.
Leia a emenda de separação, ADR 079, contratos de billing, AGENTS.md e regras
gerais deste documento. Não implemente nem modifique a entrega Olist.

Objetivo: retirar a rotina manual Financeiro sem perder histórico, contas,
quitação válida ou proteções contra reconfirmação com outro valor.
Primeiro confirme a disponibilidade da quitação conciliada e todas as
dependências reais, inclusive order-billing-runtime, repositório de pedidos,
finance_payment_review_required e triggers. Código de cobrança local entregue
não prova que o ambiente real já esteja habilitado.

Pode editar rota/menu/tela/CSS Financeiro, gestão de perfis, runtime/API,
repositórios/exports respectivos, testes, runbook e migração de retirada
compatível. Preserve dados históricos e identidades com autoria financeira;
não apague migrations já publicadas. Não remova paidOn, confirmação de
pagamento, InfinitePay ou regras comerciais apenas pelo nome Financeiro.

Registre a decisão específica que supersede ADRs 040/041/042 no alcance
necessário. Faça retirada em etapas compatíveis, trate sessões/contas e
referências, preserve ou arquive histórico conforme contrato aprovado e
substitua invariantes monetárias que ainda dependam do trigger antigo.

Se a quitação ou compatibilidade não estiver pronta, conclua o inventário
e descreva o bloqueio desta trilha; Olist continua seguindo seus próprios gates.
Valide PostgreSQL/migração/rollback, identidade, billing e reconfirmação,
mais gates do projeto. Não confunda ocultar menu com concluir a remoção.
```

## Bloco 8 Melhorias futuras por escolha explícita

Este bloco serve para escolher e detalhar uma melhoria, sem expandir a entrega
principal automaticamente. A ficha FIP já tem tarefas próprias e deve ser
preservada.

```text
Trabalhe apenas na melhoria OLC-F01, OLC-F02, OLC-F03 ou OLC-F04 escolhida
explicitamente pelo usuário em .specs/features/olist-confirmed/tasks.md.
Se nenhuma foi escolhida, entregue a comparação e o escopo proposto, sem
implementar todas. Leia spec OLC, ADR 079 e regras gerais deste documento.

OLC-F01: entrada/menu/busca exata e projeção mínima para operação centralizada,
inclusive perfil restrito, com decisão de acesso e testes contra vazamento.
OLC-F02: conferência administrativa e vínculo de venda manual antiga, sem
criação. Não adie para esta melhoria a recuperação de incerteza de OLC-T03.
OLC-F03: cancelamento local terminal e impactos em métricas/filas, sem
estorno, exclusão histórica ou cancelamento ERP; nunca alterar exportados.
OLC-F04: prévia detalhada e eventual modelo global de subtotais em novos
pedidos; preserve totais/snapshots antigos e valide a necessidade com produto.

Nesta etapa, pode editar somente contrato/tarefas/RFC/ADR da melhoria escolhida.
Informe arquivos de código candidatos, critérios positivos/negativos,
compatibilidade, migração/rollback e checks necessários antes da implementação.
Só edite código se a solicitação vigente também autorizar a implementação
da melhoria concreta. Nenhuma melhoria deve voltar a ser pré-requisito dos
blocos 1 a 6 nem remover suas garantias já entregues.
```
