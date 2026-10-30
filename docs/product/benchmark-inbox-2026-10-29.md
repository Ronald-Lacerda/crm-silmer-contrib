# Benchmark e ajustes da Caixa de Entrada — 29/10/2026

Tarefa: INBOX-UX-01, complemento de INBOX-4 e PCX-10/12/13/14
([plano](../../.specs/features/crm-mvp/tasks.md), [design](../../design.md)).
Escopo autorizado: Detalhes com texto visível e painel recolhível, menu
compacto com preferência salva e revisão de labels/headers. Sem mudança de
domínio, autorização, estados comerciais ou infraestrutura.

## Natureza da evidência

Os dez perfis discutidos no chat são uma simulação, não entrevistas reais.
O benchmark é uma comparação de organização visual e descrições dos autores;
não comprova preferência, desempenho ou usabilidade com vendedores Silmer.
As imagens das referências foram inspecionadas no navegador. A aparência da
marca Silmer e os componentes/tokens existentes continuam canônicos.

## Comparação

| Referência                                                                                                                  | Organização observada ou descrita pelo autor                                                                                                             | Aplicação na Silmer                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Trengo — Integration Sidebar, Rob Scholten](https://dribbble.com/shots/23396106-Trengo-Integration-Sidebar)                | Conversa junto a painel lateral com fechamento, dados do contato e informações agrupadas de integrações. O autor descreve evolução da lateral existente. | Preservar chat e contexto lado a lado quando couber, com controle de abertura claro e fechamento reversível. Não adicionar integrações.                 |
| [Customer Support Inbox Web App Design, Purrweb](https://dribbble.com/shots/27681874-Customer-Support-Inbox-Web-App-Design) | A imagem prioriza fila e área da conversa; a descrição apresenta painel do cliente e operação por teclado.                                               | Manter fila, identidade e pedido em contexto; testar foco e recuperação do painel sem sair da resposta. Não importar SLA, command palette ou templates. |

Nenhuma dessas referências comprova persistência do menu ou um breakpoint
ideal. O menu compacto com escolha salva deriva da hipótese de área útil e da
autorização do proprietário. Preservamos a baseline responsiva do painel.

## Comportamento implementado

- Na Inbox, o menu começa compacto sem preferência válida. Fora dela, mantém
  o padrão anterior: completo no desktop e compacto no tablet. A escolha manual
  Expandir/Recolher prevalece entre rotas e recargas, no mesmo navegador.
- Somente a escolha manual é gravada em `crm.sidebar.compact`; nenhum dado
  de cliente, conta ou domínio é persistido com essa preferência. Storage
  indisponível não impede o uso. O celular mantém a navegação inferior.
- O menu conserva destinos, ACL, contadores e indicação de página atual.
  Ícones têm nomes acessíveis e dicas visíveis no hover e no foco por teclado.
- Detalhes mostra texto no botão desktop/tablet; no celular continua disponível
  no menu Mais. O painel mantém preferência e breakpoints anteriores, foco no
  título ao abrir, Escape para fechar e retorno ao controle que o abriu.
- Header do painel: Detalhes do atendimento. Seção: Pedidos e assuntos do atendimento;
  seleção: O agente usa este. O cabeçalho da conversa conserva cliente, pedido,
  status, canal e responsável.
- Atalhos: Todas, Aguardando vendedor e Meus atendimentos. O filtro por
  responsável continua separado; critérios, parâmetros e contagens não mudam.
- Ação, formulário e confirmação usam Transferir atendimento / Confirmar
  transferência. Arquivar e Encerrar permanecem ações de efeitos distintos.
- No celular os atalhos podem ocupar duas linhas, sem truncamento ou scroll
  horizontal, preservando alvos e espaçamento de toque.

## Integração na master

A integração de INBOX-UX-01 parte da master atual e aplica somente o commit
de UX. Preserva as correções posteriores de mídia e o fluxo CP-T09/UXA de
classificação de mensagens por pedido. A indicação `O agente usa este` foi
conservada por descrever o efeito operacional; o header agrupa Pedidos e
assuntos do atendimento. As demais frentes da branch original ficam fora
deste release.

## Validação e reversão

Regressões em `test/e2e/crm-ui.spec.js`: ganho de largura, teclado, dicas,
persistência entre rotas/recarga, transição para celular, storage inválido ou
bloqueado, Detalhes, filtros, autorização e axe. O gate completo e seus limites
são registrados em INBOX-UX-01 no plano do MVP.

Gate local: validate aprovado (1.429 testes e cinco skips), E2E completo
aprovado (349 e sete skips) e, após a correção final de Escape/hover das dicas,
74 testes de Inbox/shell/orçamento aprovados e sete skips. Tipos, lint, tokens
e diff conferidos após o patch final. Auditoria npm passou no nível high:
um aviso low e dois moderate preexistentes; dependências não foram alteradas.
Ambiente de execução local: Node 24.22.1 e npm 11.19.1; pins do repositório
permanecem 24.20.0 e 11.19.0. Isso não é evidência de deploy remoto.

Reversão: reverter o commit da tarefa. A chave visual pode permanecer sem
efeito em versões anteriores; não há migration, alteração de API ou recovery
de dados. Preferências são do navegador compartilhado, sem sincronização
entre aparelhos. Homologação com vendedores reais continua necessária para
medir produtividade ou decidir uma evolução posterior do padrão.
