# Olist — Fase 4: interface administrativa

## T11 — conexão, parâmetros centrais e mapeamentos

Tarefa OLIST-T11, requisitos OLIST-03–05, 11, 22–25 e 48 da
[RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md), sobre as
[guardas da Fase 3](olist-phase3.md#t10--guardas-comerciais-e-recuperação).
T11 iniciou a Fase 4; T12 concluída na continuação abaixo. T13/T25 pendentes. A geração real
permanece desligada. Não há deploy, habilitação de operadora, conexão real,
cadastro, venda ou piloto como parte desta entrega.

### Contrato e operação

A rota `/olist` mantém o shell Vue, tokens e controles atuais. A capacidade
`COMMERCIAL_ADMIN` concede a administração independentemente do checkbox
Olist; esse checkbox continua obrigatório para a projeção de pedidos e não
concede administração. A API conserva a revalidação de sessão, CSRF,
capacidade, conta e idempotência existentes. Admin sem checkbox não recebe
geração nem autoelevação.

- **Conexão:** estado configurado/desconectado/conectado/reconexão, ambiente
  de produção e validade do acesso em horário de São Paulo. Autorizar usa
  somente o destino OAuth oficial permitido; desconectar envia a versão
  observada. A conta da empresa é conferida no backend. Credenciais, documentos
  da empresa e identidade da operadora não são exibidos ou editados na tela.
- **Callback:** código/estado removidos da URL antes das requisições do shell,
  consumo único em memória do módulo, sem localStorage/sessionStorage. Erro,
  campos ausentes ou duplicados não completam a conexão. Reload não repete
  a troca; retorno recusado exige iniciar nova conexão.
- **Configuração privada incompleta:** informa a pendência e impede conectar,
  editar parâmetros ou iniciar consultas sem a integração configurada.
- **Parâmetros comerciais:** leitura seguida de Editar/Salvar/Cancelar. Campos
  completos: vendedor ERP, natureza de operação, depósito, meio de pagamento,
  forma de recebimento, lista de preços, origem CRM, vencimento explícito,
  prazo textual e ordem de compra. Política fiscal para novos produtos exige
  NCM/origem/unidade completos ou os três vazios; não há defaults fiscais nem
  vencimento calculado pelo texto do prazo. Origem fiscal `0` é preservada.
- **Versão:** capturada ao abrir a edição, não no envio. A edição impede
  refresh/reconectar/desconectar; refresh impede iniciar nova edição.
  Conflito 409 mantém o rascunho, foca a explicação e bloqueia novo save.
  Cancelar carrega a versão atual; abrir Editar novamente exige revisão humana.
- **Referências comerciais:** consulta explícita de vendedores, depósitos,
  formas de pagamento/recebimento e listas de preços. A API faz somente GETs
  remotos limitados, sem endpoint arbitrário, autoplay ou polling. Natureza de
  operação e origem CRM são conferidas diretamente no Olist. Desconexão impede
  consulta remota; vazio e consulta incompleta são estados diferentes.
- **Mapeamento:** consulta exata por UUID do recurso CRM, restrita à conta;
  exibe tipo, estado e ID remoto confirmado. Funciona sobre o ledger local
  mesmo com a conexão desconectada. Não há remapeamento livre, sobrescrita de
  cadastro ou botão de repetir criação em resultado incerto. A UI de vínculo,
  histórico e recuperação por Pedido pertence à T13.
- **Respostas tardias:** troca de categoria/identificador, conexão, refresh,
  parâmetros, saída da rota ou perda de capacidade aborta/invalida consultas.
  401/403 administrativo remove os dados visíveis e direciona para nova sessão.
  Retorno atrasado não restaura dados de outra conexão ou de acesso revogado.

Erros usam mensagens fixas; conteúdo do provedor não vira mensagem de erro,
HTML ou log da UI. Nomes das referências são interpolados como texto. Nenhum
estado de domínio é salvo em `window` ou storage. Esta fatia não altera
`creationEnabled: false`, flags, jobs, runtime, transportes ou endpoints de
exportação. Também não modifica schema, dependências ou infraestrutura.

### Acessibilidade e evidências

Formulários têm labels explícitos; disclosures nativos funcionam por teclado.
Editar foca o primeiro campo; Cancelar retorna ao acionador; resultados e erros
recebem foco, com carregamento anunciado. O painel de parâmetros permanece
aberto ao recarregar após conflito. Layout de uma coluna no celular e duas
colunas nos parâmetros no desktop, com tokens dos temas claro/escuro.

Node 24.20.0/npm 11.19.0, exclusivamente com dados/provedor sintéticos:

| Gate                                                                  | Resultado                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate` final                                              | Aprovado; 1977 testes, 26 skips condicionais, zero falhas; formatação, tipos, lint, fronteiras, validadores e build                                     |
| `npm run test:e2e -- --workers=1`                                     | 502 aprovados, 7 skips previstos, zero falhas; regressão integral da implementação principal                                                            |
| `npm run test:e2e -- test/e2e/olist-phase2.spec.js --workers=2` final | 28/28, zero skips; inclui os últimos refinamentos de configuração incompleta/alinhamento e os três cenários adicionais de reconexão, limites e validade |
| `npm audit --audit-level=high`                                        | Aprovado; zero altas/críticas, 1 baixa e 5 moderadas preexistentes; dependências intactas                                                               |
| axe / visual / reflow                                                 | Zero violações nos cenários exercitados; capturas conferidas em desktop 1366, celular 390 e tema escuro 320; largura equivalente a zoom 200% exercitada |
| Revisão independente QA                                               | Sem finding material pendente; correções de foco após conflito e corrida de edição durante refresh cobertas por E2E                                     |
| Detector visual / `git diff --check`                                  | Nenhum finding mecânico no painel/tela; patch sem erro de whitespace                                                                                    |

A suíte específica cobre preservação integral dos parâmetros e origem fiscal
zero, fiscal parcial recusado, conflito e revisão explícita, refresh durante
edição, catálogos/vazio e incerteza, UUID inválido/404/429/reconexão/403,
revogação com resposta tardia, desconexão versionada, callback inválido,
nomes contendo HTML tratados como texto, reconexão por Enter no OAuth oficial
interceptado, configuração incompleta e overflow numérico. Nenhum comando
criador é adicionado ou exercitado. As guardas de API/ACL existentes continuam
cobertas pelo gate Node; não houve alteração de backend/schema nem novo ensaio
PostgreSQL live nesta fatia de UI.

Capturas e logs sintéticos ficam em `var/olist-t11-*` e
`var/olist-admin-*.png`, ignorados pelo Git. Nenhuma evidência local representa
homologação de ERP/EasyPanel. Entrega atômica OLIST-T11 na branch
`codex/olist-phase4-t11`; commit/push registrados no fechamento da tarefa.

### Rollback e continuidade

O patch pode ser revertido como uma entrega única de frontend/documentação,
sem down migration, exclusão de vínculo ou alteração de credencial. Preserve
os parâmetros já persistidos e a geração desligada; a UI antiga não deve
salvar configuração completa, pois seu formulário omite fiscal/vencimento/
recebimento. Desconectar é ação administrativa separada e versionada.

Próxima tarefa: T12, fluxo e grade por Pedido. Depois T13 e T25; gates de QA,
operação e piloto das Fases 5–6 continuam obrigatórios. Nada nesta tela libera
inclusões reais, amplia usuários ou troca o template da ficha.

## T12 — composição e conferência por Pedido (08/11/2026)

OLIST-01–12, 21–24, 33–35 e 40–44. Implementação na mesma worktree/branch
`codex/olist-phase4-t11`, preservando as Fases 2–3 e T11. Sem habilitação de
usuário, alteração de flags/credenciais, migrations, acesso ERP ou deploy.

### Contrato entregue

- Pedido novo adota explicitamente a composição por tamanho. IDs são emitidos
  pelo servidor; comandos de atributos/grupos/linhas, reordenação, duplicação,
  quantidade e revisão de subtotal referenciam esses IDs. Não substituir o
  grafo de preços nem enviar flags de revisão ou um total arbitrário.
- Grade apresenta tamanho, quantidade, subtotal e subtotal do grupo/total do
  backend. Quantidade, atributos ou nome do tamanho alterados exigem revisão
  humana separada. Subtotal vazio salva rascunho; total incompleto aparece como
  indisponível, sem soma parcial ou arredondamento no navegador.
- Composição gerenciada e legado enriquecido confirmam com total calculado
  somente leitura e condição de pagamento. A versão é capturada ao abrir o
  editor/diálogo. 409 conserva o rascunho e exige cancelar/rever, sem troca
  silenciosa da versão. Contrato de resposta legado sem pricing é preservado
  para compatibilidade; pendências reais de composição levam a Itens.
- Legado usa `/price-breakdown`: composição suplementar por IDs, nenhum valor
  inferido do total histórico. Loja oferece somente complemento autorizado de
  entrega, técnica e cadastro; preços vêm da projeção oficial, sem mudar
  checkout, pagamento, ficha ou travas. Habilitação Olist não concede escrita
  comercial; loja exige administrador.
- `/olist?pedido=<UUID>` usa somente a projeção Olist e permite conferir a prévia
  de qualquer origem/status/dono ao humano habilitado, inclusive Financeiro,
  sem ler pedido comercial, lista irrestrita, contatos ou Inbox. Busca por
  número/UUID segue a mesma sintaxe do backend. No detalhe comercial há painel
  equivalente; Admin sem checkbox não ganha conferência/geração.
- Prévia usa `{}` e validação usa somente `{previewToken}`. Dados, plano de
  cadastros, pendências, valores e expiração são projetados pelo servidor;
  recibo existe só na memória do componente. Navegação, edição, mudança de
  versão/acesso e eventos invalidam a prévia. Nenhum polling ERP.
- Em 08/11/2026 o proprietário autorizou explicitamente conectar a ação humana
  a `/export`, mantendo flags reais desligadas, sem deploy e sem criar cadastros
  ou vendas reais no Olist. Essa autorização resolve a restrição da primeira
  entrega `a8d99fef`; a ação foi implementada e exercitada somente com mocks.
- Gerar venda exige checkbox atual, nenhuma operação/tentativa pendente, prévia
  elegível com token vigente e `creationEnabled === true` tanto na projeção
  quanto na prévia. O acionamento faz `/preview/check`; somente `valid: true`
  e nova liberação positiva abrem o diálogo. Um segundo gesto humano confirma.
  Diálogo é invalidado por versão, edição, sessão/habilitação, evento ou TTL.
- O POST `/export` envia somente `{previewToken}`, CSRF e uma chave idempotente
  capturada para a confirmação. O envio é único mesmo com acionamento duplicado.
  Nenhum endpoint arbitrário, preço, total, conta ou autoridade vem do navegador.
  A resposta `number` identifica o Pedido CRM, nunca o número da venda ERP.
- Timeout, resposta inválida, rejeição ou interrupção depois de iniciado o POST
  não oferecem repetição criadora. Leituras seguintes não restauram a ação nem
  limpam a incerteza se a operação estiver ausente; conferência/reconciliação
  administrativa é necessária. Aceitação mostra a operação sem novo envio;
  reload lê o ledger. T13/recuperação detalhada e T25/ficha v7 continuam separadas.
- Geração real permanece desativada: `configuration`, `project`, `preview` e
  `checkPreview` reais continuam com `creationEnabled: false`; defaults/flags
  de dispatcher não mudaram. Nenhuma conta, credencial, migration ou runtime
  real foi modificado. Não executar as provas antigas para ativar esta UI.
- Leitura comercial expõe somente `olistLocked` e
  `olistConfirmationAllowed`, calculados por todas as contas no ledger.
  Vendedor sem checkbox/revogado continua sem editar/reabrir pedido exportado.
  Pendente só confirma com conteúdo igual quando todas as travas estão em
  `confirmed`/`linked`; resultado incerto em outra conta impede essa exceção.
  Pagamento e entrega conservam sua ACL independente. Guardas de escrita e
  infraestrutura não mudam.

### Verificação e limites

Os números desta seção registram a primeira entrega `a8d99fef`. Os gates da
continuação com a ação humana estão no fechamento abaixo.

Fixtures e provedores exclusivamente sintéticos. Execução com Node 24.20.0 e
npm 11.19.0 (`fnm exec --using 24.20.0 npm.cmd ...`), servidor de preview em
porta dedicada 4189, sem builds concorrentes.

| Gate                           | Resultado                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate` final       | Aprovado: 1982 testes, zero falhas/cancelamentos, 26 skips condicionais; formatação, tipos, lint, fronteiras, tokens, validadores e build aprovados |
| E2E completo                   | 545 aprovados, 7 skips previstos, zero falhas/flakes; dois workers                                                                                  |
| T12 final após refinamentos    | 41/41 aprovados, zero skips; um worker; inclui duas abas e evento SSE de outro pedido sem perda do rascunho                                         |
| Contrato/runtime e preço exato | 53/53 rotas/mídia isolados e 49/49 domínio de formatação/runtime; testes mínimos da trava multi-conta e fronteira de inteiro seguro                 |
| axe/teclado/visual             | Zero violações nos cenários exercitados, capturas conferidas em 320 escuro, 390 claro e 1366 desktop; reflow e foco/erro associados                 |
| Detector visual mecânico       | Nenhum finding nos arquivos examinados                                                                                                              |
| `npm audit --audit-level=high` | Zero altas/críticas; uma baixa e cinco moderadas preexistentes, dependências preservadas                                                            |
| Links e `git diff --check`     | Aprovados                                                                                                                                           |

A primeira E2E integral teve três falhas de foco na loja: a consulta inicial
secundária capturava foco do título. Corrigido sem alterar asserções; a rodada
integral seguinte passou. O contrato explícito de chaves Order foi ampliado
para os dois metadados documentados. Um teste de mídia excedeu seu timeout de três segundos na
primeira execução paralela e passou isolado; o validate completo final passou sem
mudar testes ou limites. O último refinamento remove duplicação visual e
invalida a prévia em evento global sem fechar rascunho comercial; validate e
os 41 cenários T12 foram repetidos sobre esse código.

Não houve novo ensaio PostgreSQL live: as leituras reutilizam o helper SQL de
locks existente; o agrupamento entre contas e contrato público têm testes
sintéticos. Não se declara homologação operacional a partir dessas evidências.
Build mantém o aviso preexistente de chunk maior que 500 kB.

Logs/capturas em `var/olist-t12-*`, fora do Git. Nenhum teste local equivale a
homologação no ERP, EasyPanel, aprovação da ficha ou piloto.

### Rollback T12

Reverter a entrega de frontend e metadados de leitura em conjunto. Não apagar
composição/subtotais/complementos já persistidos nem alterar ledger/flags para
liberar escrita. Escritas continuam protegidas pelo backend T10. Nenhuma down
migration, exclusão de cadastro ou cancelamento ERP faz parte do rollback.

### Fechamento da ação humana T12 — 08/11/2026

Continuação autorizada sobre `a8d99fef`, na mesma branch. Testes do caminho
liberado usam respostas sintéticas e interceptam integralmente `/export`;
nenhuma chamada alcança API real, worker ou ERP. O teste de duplo acionamento
usa seletor estável durante o estado Solicitando, preservando a asserção de um
único comando, sem alterar asserções ou timeouts. Revisão QA/Segurança somente
leitura sem finding bloqueante.

| Gate da continuação              | Resultado                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate`               | 1982 aprovados, zero falhas/cancelamentos, 26 skips condicionais; tipos/lint/contratos/fronteiras/tokens/build aprovados                                             |
| E2E focado T11 + T12             | 89/89, zero skips; inclui os 61 cenários T12, confirmação humana, duplo acionamento, TTL, revogação, SSE durante POST e resposta 202 inválida                        |
| E2E integral sobre o build final | 566 aprovados, 7 skips previstos, zero falhas/flakes; dois workers, porta isolada 4189                                                                               |
| axe/teclado/visual               | Diálogo conferido em 390 e 1366, sem violações; foco inicial no retorno seguro, Escape sem envio, acionamento único                                                  |
| Detector mecânico                | Nenhum finding no painel e na rota examinados                                                                                                                        |
| `npm audit --audit-level=high`   | Zero altas/críticas; uma baixa e cinco moderadas preexistentes, sem mudança de dependências                                                                          |
| Links e `git diff --check`       | Aprovados                                                                                                                                                            |
| Preservação operacional          | Nenhum diff em `.env.example`, configuração Olist, preview/check/project reais ou dispatcher; nenhuma chamada ERP, conta habilitada, credencial, migration ou deploy |

Node 24.20.0/npm 11.19.0. Logs `var/olist-t12-export-*` e capturas
`var/olist-t12-export-dialog-*.png`, ignorados pelo Git. Não houve novo ensaio
SQL live: esta continuação altera somente interface, testes e documentação.
As verificações negativas e de concorrência da API/worker existentes foram
preservadas. Nenhum teste sintético comprova piloto, operação real ou ampliação.

T12 concluída no código; F4 continua aberta para T13/T25.
Flags reais desligadas, sem deploy, cadastros/vendas reais, piloto ou ampliação.
