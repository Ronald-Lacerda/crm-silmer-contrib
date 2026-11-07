# Olist — Fase 4: interface administrativa

## T11 — conexão, parâmetros centrais e mapeamentos

Tarefa OLIST-T11, requisitos OLIST-03–05, 11, 22–25 e 48 da
[RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md), sobre as
[guardas da Fase 3](olist-phase3.md#t10--guardas-comerciais-e-recuperação).
T11 inicia a Fase 4; T12, T13 e T25 continuam pendentes. A geração real
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
