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
