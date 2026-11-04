# Inbox — conversa compacta e mídia

INBOX-UX-03; INBOX-4, PCX-10/12/13/15, CP-07..10, IMG-12/13 e
MED-01..03/09..13/16/19/25. Apresentação autorizada pelo proprietário em
03/11/2026 após revisão do protótipo clicável. A emenda está em
[pedidos-mvp](../../.specs/features/pedidos-mvp/spec.md) e os gates em
[tasks](../../.specs/features/crm-mvp/tasks.md).

## Uso da conversa

O cabeçalho concentra o nome e o contexto essencial. O nome abre o cadastro
em painel sobreposto; Detalhes abre Atendimento, com Pedidos e assuntos e
Resumo. Fechar pelo botão ou Escape devolve o foco ao acionador. O painel
sobrepõe a conversa e preserva o espaço do histórico em notebooks menores.
O pedido canônico e as filas/prioridades de INBOX-UX-02 continuam os mesmos.

O compositor reúne texto, anexar, cotar frete, gravar e enviar. Ícones têm
nome acessível e dica por hover/foco; a dica de envio não ocupa uma linha
permanente. Enter envia e Shift + Enter insere nova linha. Os alvos permanecem
com 40 px no ponteiro fino e 44 px no toque. Avatares menores não substituem
autoria e estado por iniciais sem contexto. A identificação de IA permanece
visível nas mensagens automáticas.

Assumir atendimento continua no cabeçalho, autorizado pela API, com foco no
compositor após o claim. Quem não pode atuar vê o motivo e não recebe ações
de envio ativas. Cotar mantém Assunto/Pedido explícitos e apenas sugere uma
mensagem para revisão humana; não envia, confirma pedido ou compra etiqueta.

## Imagens e áudio

A foto aparece em miniatura limpa e abre ampliada por clique ou teclado.
Baixar e anexar ao pedido são ações compactas por ícone, com dicas e nomes
acessíveis. A seleção e a confirmação do pedido de destino só aparecem
quando o vendedor pede para anexar, sem ocupar espaço sob toda foto.
O alvo é escolhido explicitamente; a interface não usa o último pendente
nem o texto da mensagem para decidir a qual pedido anexar.

Download continua autenticado e entrega os bytes originais, com extensão
validada pelo MIME raster permitido. Anexar reutiliza a API de arquivos do
pedido, com autorização, limites e a mesma chave idempotente em nova tentativa
após resposta perdida. Erro, perda e indisponibilidade ficam junto à mídia.
Trocar de conversa ou sair fecha a ampliação e cancela operações pendentes
conforme o ciclo existente. Não há URL pública nem leitura direta do storage.

O player de áudio usa reprodução, posição, duração e volume reais; não
apresenta uma onda sonora inventada como se descrevesse a gravação. A
transcrição automática já existente fica em Atendimento › Resumo, no disclosure
Transcrições automáticas, incluindo estados de indisponibilidade. O componente
e as APIs são preservados; texto e link saem da trilha de chat. Gravar só pede
microfone por ação explícita; parar oferece revisão, descarte e envio humano.
Saída, troca de conversa e descarte liberam microfone e URLs de prévia.
Formatos, tamanhos, validação, retenção e homologação permanecem nos contratos
de [mídia enviada](../../.specs/features/inbox-media-rustfs/spec.md).

## Encerrar, arquivar e pedidos

Encerrar fecha o ciclo de atendimento, registra autor/horário/motivo e
preserva os pedidos, seus dados e status. Pedido pendente continua pendente;
pedido confirmado continua confirmado. A próxima mensagem válida abre outro
ciclo, preservando histórico e pedidos anteriores. Não há reativação do agente
no ciclo encerrado.

Arquivar retira a conversa da fila sem encerrar o ciclo. Uma nova mensagem
faz a conversa reaparecer. Arquivar não confirma, cancela, apaga nem reabre
pedidos; é uma ação independente do encerramento.

Lista e detalhe passam a informar `conversation.hasPendingOrder`. O booleano
é verdadeiro se há pedido pendente ligado diretamente à conversa ou por
qualquer Assunto, inclusive Assunto fora de foco ou pedido de outro ciclo.
Ele não expõe a ficha e não substitui `order` ou `reviewOrder`. Um vínculo
somente com pedido confirmado não deve exigir ciência de pendente.

O diálogo de encerramento pede confirmação consciente quando esse sinal ou
o contexto carregado indica pendente. A API continua conferindo os vínculos
sob transação: uma mudança concorrente pode responder 409. Atualize o contexto
e obtenha nova ciência humana; não transforme uma tentativa sem aceite em
`acknowledgePending: true` automaticamente. A confirmação não concede escrita
no pedido e não transfere sua responsabilidade.

## Verificação

Use somente dados sintéticos e sessão com as capacidades adequadas:

- Em 1366 × 768 e larguras menores, conferir compositor, alinhamento,
  nomes longos, claro/escuro e ausência de rolagem horizontal.
- Por teclado, abrir nome e detalhes, alternar as seções, fechar por
  Escape e verificar retorno do foco. Assumir deve levar foco à resposta.
- Na imagem, ampliar, fechar, baixar e abrir vínculo sob demanda. Conferir
  pedido-alvo, negativa de permissão, arquivo indisponível e retry sem duplicar.
- No áudio, reproduzir/pausar, buscar posição, ajustar volume e verificar
  erro real; gravar, revisar, descartar e enviar sem captura involuntária.
  Conferir a transcrição em Atendimento › Resumo › Transcrições automáticas,
  sem texto ou link redundante na trilha de chat.
- Encerrar com pendente direto, pendente somente por Assunto e múltiplos
  Assuntos fora de foco: exigir ciência, preservar pedidos e tratar 409.
  Pedido confirmado sem outros pendentes não deve exigir essa ciência.
- Arquivar deve preservar ciclo e pedidos. Outra pessoa sem capacidade
  continua impedida de encerrar, enviar ou anexar ao pedido.

Gates: `npm run validate`, `npm run test:e2e` com axe, auditoria de dependências,
revisão independente e `git diff --check`. A suíte PostgreSQL real de
`test/operation-read-postgres-live.test.js` cobre as projeções de pendente direto,
somente por Assunto e vínculo confirmado. Ela exige banco sintético dedicado;
sem `TEST_DATABASE_URL`, o skip não comprova o comportamento SQL. Resultados
consolidados ficam no bloco INBOX-UX-03 de tasks. Testes sintéticos não substituem
observação de vendedores nem homologação remota de mídia/microfone.

## Publicação e rollback

Frontend e API devem corresponder ao mesmo commit para compartilhar
`hasPendingOrder`. Não há migration, dependência, framework ou infraestrutura
nova. A leitura antiga tem fallback conservador na interface; a validação
transacional da API continua obrigatória durante qualquer combinação de versões.

O deploy segue o fluxo GitHub → EasyPanel existente. Depois dele, conferir
SHA/health, os painéis, as permissões e a apresentação das mídias, sem enviar
mensagens, anexar arquivos ou encerrar atendimentos reais só para validar layout.
Uma prova operacional de mutação exige contexto sintético autorizado próprio.

Rollback reimplanta o commit/imagens anteriores de API e frontend em conjunto.
Não restaura banco, não apaga arquivos nem desfaz pedidos, mensagens, claims
ou encerramentos já registrados. O booleano novo é uma projeção calculada;
remover sua leitura não exige migração de dados. Preserve o guard de pendentes
do backend e não faça retry de envio para tentar corrigir aparência.

## Refinamento aprovado em 04/11/2026 — INBOX-UX-04

PCX-16a–h complementa os contratos acima sem alterar APIs ou dados. Busca,
atalhos e filtros ficam na lista; Situação e Responsável aplicam imediatamente,
preservando parâmetros, contagens, autorização e links. Escape fecha sem
reverter a escolha; fechar por clique externo respeita o destino do clique.
Ações abrem junto ao botão, inclusive no celular, com ícones e encerramento
semântico. As confirmações e guardas de arquivar/encerrar continuam existentes.

Sugestões pendentes aparecem abertas entre histórico e compositor, com
confirmação do cliente, evidência e as três decisões oficiais. Recolher não
perde motivo nem cancela requisição. Histórico, bloqueios e omissão ficam em
Atendimento › Pedidos e assuntos; uma única instância/consulta atende os dois
lugares. O destino do conteúdo permanece montado quando o painel fecha.
Fechar durante o registro de omissão não repete o comando nem reabre o painel:
feedback tardio aparece na conversa, e o resultado permanece consultável.

O resumo inicia compacto; avisos comerciais e vendedor solicitado continuam
visíveis e o original completo pode ser aberto. Dados coletados da pré-ficha
não comprovam prontidão para confirmar pedido. Atenção/pendente usa âmbar,
sugestão usa informação, sucesso usa verde e falha/encerramento usa erro, sempre
com texto ou ícone. Apenas os tokens atuais determinam as cores de cada tema.

Ampliar conversa esconde a lista sem remontar histórico, alterar URL, apagar
rascunho ou trocar filtros. O botão volta a mostrar a lista. No celular,
navegação por endereço e voltar continuam valendo. Identidade e ações ocupam
linhas separadas para preservar o nome do contato até em 320 px. Arquivar a
última conversa ampliada restaura a lista vazia. O menu lateral tem botão
apenas por ícone, mantendo nome acessível e preferência persistida; expandir
na Inbox sobrepõe a lista para não estreitar o chat. Outras telas preservam
sua composição anterior.

Verificar dados sintéticos em 1366×657, 1366×768, 390×844 e reflow a 320 px,
claro/escuro, toque e teclado. Abrir filtros, mudar seleções enquanto carrega,
fechar por Escape/clique externo e confirmar parâmetros e foco. Abrir ações,
confirmar suas permissões e retornar o foco. Recolher sugestão com motivo já
selecionado; testar 403/404, 409 e resposta perdida com a mesma chave. Fechar
Atendimento durante resposta tardia deve preservar resultado sem reabertura.
Verificar múltiplas sugestões, evidência/resumo longos, compositor e rolagem
interna, inclusive após ampliar e redimensionar.

Rollback desta fatia restaura o frontend anterior. Não há migration ou mudança
na API, nem reversão de decisões, pedidos, mensagens ou claims já registrados.
O push segue GitHub → EasyPanel; CI e observação de SHA/health no alvo são
necessários para declarar a versão implantada.


Validação local desta entrega: `npm run validate` aprovado (1.691 testes,
1.681 aprovados e 10 ignorados), `npm run test:e2e -- --workers=4` com
476 aprovados e 7 ignorados pela configuração existente, incluindo axe e
permissões. Os 18 cenários focais INBOX-UX-04 passaram. Após o último ajuste
móvel, formatação, lint, tokens, diff-check e E2E foram conferidos novamente.
`npm audit --audit-level=high` passou: zero alta/crítica; uma baixa e oito
moderadas preexistentes, sem alteração de dependências.

Revisões independentes de frontend/acessibilidade e QA sem bloqueantes.
Conferência visual no bundle real com fixtures sintéticas em 1366×768,
390×844 e 320×700, claro/escuro, filtros, ações e ampliação: sem erro de
runtime nem mutações durante a inspeção. Testes adicionais cobrem 1366×657,
390×440, teclado, conteúdos longos, foco, conflito e resposta tardia.
Isso comprova apresentação e contratos locais; não é evidência de canal,
zoom físico, dispositivo real ou publicação no EasyPanel.
