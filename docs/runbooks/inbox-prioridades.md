# Inbox — prioridades do vendedor

INBOX-UX-02, PCX-15a–f e PCX-03/04/13/14. Composição autorizada pelo proprietário
em 03/11/2026: quem atender, maior espera e pedidos disponíveis para revisão final.

## Comportamento

INBOX-UX-06 / PCX-18 (05/11/2026): Atender / Fechar pedidos / Todas ficam
nessa ordem em uma barra horizontal acima do workspace no desktop; a busca
continua na lista. No celular, a barra aparece na lista, sem consumir espaço
na conversa. Todas permanece selecionada na entrada sem query explícita.
Filtros abre a folha modal com Situação e Responsável. Editar opções não muda
a consulta até Ver resultados; Limpar prepara a remoção dos critérios no
rascunho. Fechar/Escape descarta edições não aplicadas e devolve foco ao botão.
Chips removem critérios já aplicados. A troca de apresentação não muda
urgência, totais, cursores, ACL, rascunhos ou comandos comerciais.

Todas é a entrada padrão sem filtro explícito (INBOX-UX-05 / PCX-17).
Inclui todos os atendimentos não arquivados autorizados: próprios, de outros
vendedores, com o agente e encerrados. Atender continua reunindo ações do
próprio vendedor e handoffs sem dono. Situação e Responsável refinam a lista
no painel Filtros; Arquivadas permanece uma escolha explícita. Fechar pedidos
usa um pedido elegível da conversa,
pendente não teste, com validação persistida sem campos faltantes e peças,
valor e condição válidos. Não representa probabilidade de venda. A confirmação
continua na página do pedido e revalida versão, campos e autorização.

Cada card tem identificação e espera na primeira linha; uma próxima ação na
segunda. Falha de envio ou resultado desconhecido prevalece sobre prontidão.
O canal e o responsável ficam no cabeçalho. Assumir atendimento é a única
primária antes do claim; seu resultado conserva o foco no campo de resposta.

O motivo da transferência fica abaixo do cabeçalho. O código unsupported
aparece como Agente não continuou, sem diagnóstico inventado. Seu resumo
original fica recolhido e pode ser aberto por teclado. Os demais resumos
mantêm a divulgação de avisos e dúvidas comerciais. Não renomear o código
persistido nem alterar o workflow para disfarçar o motivo.

## Contrato e limites

`GET /api/v1/inbox/conversations?workQueue=attention|closing` usa exclusivamente
o ator da sessão. Filtros, total e posição são calculados antes de LIMIT.
Cursores assinados não cruzam ator ou filtros. As queries anteriores continuam
válidas; `?fila=` e `?situacao=` continuam abrindo filtros antigos.

Projeções adicionais: waitingSince, queuePosition, deliveryIssue, reviewOrder,
assignedUser.name e order.readyForConfirmation. Nenhuma ficha é decifrada
para listar. Handoff pendente usa created_at. Para atendimento humano, a
primeira inbound depois da última resposta humana enviada com sucesso inicia
a espera; avisos automáticos não a encerram. Após claim, o início do handoff
é preservado até a primeira resposta humana. Tomada direta usa a auditoria
como limite, sem inventar espera quando essa evidência falta. A duração não é SLA nem alerta
de atraso arbitrário. O relógio visual atualiza a cada 30 segundos.

O alerta resume a última saída falha/incerta mesmo com inbound posterior;
uma saída posterior bem-sucedida deixa de sinalizá-la na fila. As ocorrências
anteriores continuam nas mensagens. A leitura não autoriza reenvio. Arquivos
indisponíveis preservam os avisos existentes junto ao arquivo. Nova não é
recibo de leitura do vendedor.

A lista carrega páginas de até 100 resultados e informa o total oficial.
Ver mais conversas permite percorrer o restante em ordem, sem duplicar IDs;
a busca é limitada às conversas já carregadas e comunica esse alcance.
Erro na próxima página preserva as conversas anteriores e oferece retry.
Cursor inválido ou repetido oferece Atualizar lista, que reinicia sem cursor;
se a atualização falhar, a ação e os dados anteriores permanecem disponíveis.
Troca de filtro/escopo ou atualização invalida páginas antigas em trânsito. Múltiplos assuntos usam
reviewOrder como alvo explícito pronto; order canônico permanece preservado.
O header, link e resumo apontam ao mesmo alvo. Um pedido de outro ciclo só
qualifica quando o responsável é o mesmo; nunca inferir alvo pelo texto.

## Ordem de Todas — INBOX-UX-05

`GET /api/v1/inbox/conversations?archived=false&sort=urgency` não aplica
workQueue nem filtro oculto de responsável. A sessão autoriza a leitura e
vincula o cursor, sem excluir atendimentos dos demais vendedores. Filtrar
Responsável em Todas mantém a ordenação; Atender/Fechar pedidos e chamadas
sem sort mantêm seus critérios anteriores.

Prioridades: falha/incerteza de envio ainda efetiva; transferência por urgência
que aguarda atendimento/resposta; espera humana/handoff pendente; pedido pronto
para revisão; demais humanas; agente; terminais/arquivadas. A posição operacional
mais antiga e ID desempatarão. Terminais/arquivadas não ganham prioridade por
alerta histórico. Nenhum prazo é deduzido de resumo livre ou ficha cifrada.

A ordenação é SQL antes de LIMIT. O cursor assinado de urgência transporta
posição composta privada, vinculada a filtros/ordem/ator. Não reutilizar cursor
após mudar escopo. O total continua global para o filtro; ordenar não altera
permissões, estados nem inicia comandos.

Rollback exige frontend e API compatíveis: o frontend anterior não pede sort e
a API nova mantém esse contrato. Voltar primeiro o frontend; só depois a API.
Uma UI nova sobre API antiga pode receber INVALID_REQUEST por sort; não retirar
validação nem ocultar a falha. Não há migration nem decisões a desfazer.

## Validação sintética

- Handoff sem dono: assumir e espera desde handoff; bot posterior não muda ordem.
- Próprio atendimento: responder; resposta humana bem-sucedida encerra espera.
- Outro dono: fora da fila pessoal; nome em Todas e comandos proibidos intactos.
- Automação/Nova: sem falso não lido ou pedido de intervenção humana.
- Pedido completo: revisar; confirmado, campos ausentes, valor/condição
  faltantes ou flag ausente não viram prontidão pela pré-ficha.
- Falha/incerteza: alerta acima do fechamento; nova inbound não esconde falha;
  consulta e filtros não emitem comandos de envio.
- Unsupported com texto: apresentação neutra, original por Enter/Espaço,
  foco mantido e aviso sem inferir motivo.
- Contagens maiores que a página, cursor de outro ator/filtro, datas inválidas,
  fila vazia, atualização, nomes longos, 320px, claro/escuro e axe.

Testes: inbox-priority.test.js, inbox-priorities-read.test.js,
operation-runtime/operation-read-api/operation-read-postgres-live e
E2E inbox-priorities, crm-ui, inbox-handoff-summary, ux-budget e demais suítes.
Esses testes são funcionais sintéticos, sem pesquisa com usuários reais.

Gates locais de 03/11/2026: validate com 1.629 aprovados e oito skips; E2E/axe
completo com 434 aprovados e sete skips; auditoria sem high/critical e revisão
independente sem bloqueantes. Node 24.20.0/npm 11.19.0. PostgreSQL real não
está instalado nesta máquina (Docker/WSL também indisponíveis); a suíte
operation-read-postgres-live integra o gate serial do CI e deve passar antes
da integração. As evidências locais não substituem esse gate.

## Caixa por vez de responder (RFC 052)

Decidida pela [ADR 065](../adr/065-caixa-de-entrada-por-vez-de-responder.md) em
08/11/2026. Requisitos PCX-19a–j; tarefa INBOX-VEZ-01 (somente API). Sem migration.

### Regra das abas

- Cada conversa aberta (não arquivada, sem `terminal_at`, fora de
  `convertida_em_lead`, `sem_lead` e `encerrada`) está em exatamente uma aba:
  Responder (`bucket=respond`), Aguardando cliente (`awaiting`), Sem retorno
  (`silent`) ou Perdidos (`lost`). Encerradas e arquivadas ficam fora, em
  `terminal=true` ou `archived=true`.
- Precedência: falha de envio vai para Responder, mesmo com perda; perda ativa
  vai para Perdidos; handoff pendente vai para Responder; com a vez do cliente,
  agente dentro da janela vai para Aguardando e os demais para Responder;
  silêncio da Silmer de 72 h corridas ou mais vai para Sem retorno, salvo
  lembrete próprio ativo (Aguardando); o restante fica em Aguardando.
- Mensagem efetiva é saída `sent|delivered|read` de autoria humana ou, em
  atendimento pelo agente, do agente. `system` nunca conta; em atendimento
  humano, aviso automático não muda a vez.
- Responsável: `owner=all` (padrão), `mine` ou `unassigned`. `bucket` não combina
  com `workQueue`, `sort`, `archived=true`, `state`, `terminal`,
  `pendingHandoff`, `unassignedHumanHandoff` nem `automationState`: 400
  `INVALID_FILTER`.

### Ordem de deploy e rollback

- INBOX-VEZ-08 / ADR 066: Responder usa a última mensagem mais recente,
  desempate por ID decrescente, sem fixar falhas no topo. O início da espera
  continua em `turnSince`. Publicar API e frontend juntos mantém o rótulo
  "Mais recentes primeiro" coerente com o servidor. Não há migration.
  Cursor antigo de Responder retorna `INVALID_CURSOR`: atualizar a lista.
  Outras abas e `sort=urgency` mantêm suas ordens e cursores. Verificar uma
  segunda mensagem recente elevando a conversa e a navegação entre páginas.
  Rollback reverte API/frontend deste delta; recarregar Responder para renovar
  o cursor, preservando mensagens, classificação e alertas de envio.
- Publicar a API antes do frontend. A API nova mantém `workQueue`,
  `sort=urgency` e os cursores das consultas legadas, então o frontend anterior continua
  funcionando. Antes do frontend, conferir health/readiness e uma chamada
  autenticada de `GET /inbox/buckets` no alvo.
- `POST lead-outcome` agora publica o evento SSE `conversation` na mesma
  transação. O corpo da resposta não mudou; quem já assina o tópico recebe a
  invalidação da lista.
- Rollback volta o frontend primeiro, porque o frontend novo depende de
  `bucket` e `owner`. Depois, se preciso, volta a API. A API nova aceita o
  contrato anterior, e não há migration a desfazer.

### Parâmetros

- 72 h: `SILENT_AFTER_HOURS` em `modules/inbox-channels/src/turn-policy.js`.
  `dashboard-runtime.js` importa essa constante e continua exportando
  `DASHBOARD_FOLLOWUP_HOURS`.
- `stallMinutes`: valor vivo que `operation-runtime.js` passa a `summary()`,
  limitado como antes. Usado só para `assistantStalled` na lista, sem corte de
  24 h. O contador do painel continua vindo do sweeper.
- Alerta de expediente: 15 min de expediente, no front.
- Lembrete: `POST /conversations/{id}/reminder` com `Idempotency-Key`, CSRF e
  `Origin`; `remindAt` ISO com offset, futuro e até 90 dias (422
  `INVALID_REMINDER_DATE`); 30 comandos por minuto por ator.

### Medir o p95 da lista no volume real

> Status (08/11/2026): medição dispensada por decisão do proprietário, porque a
> produção tem cerca de 50 conversas abertas. Execute os passos abaixo somente
> se a equipe relatar lentidão na Caixa ou se o volume crescer de forma
> relevante.

1. Em horário comercial, por dois dias, medir o tempo de resposta de
   `GET /api/v1/inbox/conversations` com `bucket=respond|awaiting|silent|lost`,
   `owner=all` e `owner=mine`, pelo log de acesso do edge ou por cronômetro do
   cliente. Mínimo de 50 requisições por aba e por owner.
2. Registrar só o percentil 95 de cada combinação. Não copiar payloads, IDs,
   nomes, textos de mensagem nem cabeçalhos de sessão para o registro.
3. Para diagnóstico, `EXPLAIN ANALYZE` somente leitura em réplica ou janela
   autorizada, sem PII.
4. Se o p95 real passar de 300 ms na aba padrão (Todos) ou em `owner=mine`, abrir
   uma ADR nova para a migration expand que desnormaliza `last_inbound_at` e
   `last_effective_outbound_at` com índice parcial. Antes disso, não criar migration.

Referência sintética (5.000 conversas abertas e 100.000 mensagens, ADR 065):
p95 de 793 ms a 887 ms em aba sem filtro de responsável; 160 ms com
`owner=mine`; 749 ms nas contagens; listas anteriores de 1,0 s a 1,4 s no mesmo
volume. A medição sintética não substitui a real.

## Publicação e rollback

### Filtros no topo e ambiente de desenvolvimento — INBOX-UX-06

Esta fatia muda somente apresentação/estado temporário de filtros e testes.
Preserva o contrato REST, migrations e runtime de domínio da baseline publicada;
uma API da baseline anterior permanece compatível. Conferir SHA do edge no
EasyPanel e os hashes dos assets públicos contra o build local, além de health
e readiness. O worker segue seu deploy automático existente; não habilitar
autoDeploy nem alterar configuração da API para uma mudança de filtros.

O checkout Windows anterior e suas alterações pendentes foram preservados
em branch/stash, fora da entrega. Ao final, os checkouts Windows e `mel`
devem apontar à revisão integrada de `master`, com o mesmo bundle do edge.
Dados, credenciais e integrações de produção não são copiados.

No `mel`, a porta 3000 pertence a outro projeto e o PostgreSQL CRM antigo
usa 5434. O ambiente sincronizado usa `COMPOSE_PROJECT_NAME=crm-silmer-synced-dev`,
PostgreSQL sintético em 5436, API em 3002, RustFS em 9000 e frontend em 4173,
todos em loopback. Um override Compose ignorado em `tmp/` troca somente a porta
do PostgreSQL; validar com `docker compose config --quiet` antes de subir apenas
`postgres` e `rustfs`. `DATABASE_URL` explícita e
`SEED_DEVELOPMENT_USERS=true` habilitam as contas sintéticas documentadas no
README; `OBJECT_STORAGE_ENDPOINT` explícito impede subir o projeto padrão.
Usar Node/npm fixados e `N8N_LOCAL_ENABLED=false`: o CRM tem API e banco reais
de desenvolvimento, sem configurar transporte WhatsApp ou credenciais de IA.

O frontend é acessado pelo túnel SSH `127.0.0.1:4173` → `mel:127.0.0.1:4173`.
Encerrar a prévia sintética antiga libera essa porta. O proxy do frontend
encaminha `/api/*` para a API do próprio ambiente; não aponta para produção.
Conferir health/readiness, login sintético e SSE sem executar atendimento real.
Rollback de desenvolvimento para o processo e o projeto dedicado, preservando
volumes; não parar serviços, remover dados ou restaurar o banco de outros projetos.

API e frontend devem corresponder ao mesmo commit. Não há migration nova nem
ação remota de teste. O deploy segue o fluxo GitHub → EasyPanel existente.
Após deploy, conferir SHA/health, fila pessoal vs Todas, totais, resumo e
pedido com dados autorizados; não enviar mensagens só para conferir layout.

Rollback reimplanta a imagem anterior de API/frontend em conjunto. Não exige
restaurar banco, reabrir conversa, desfazer claim ou repetir envio. A causa de
um handoff unsupported real é investigação própria do workflow/telemetria.

## Evidência local — INBOX-UX-05

`npm run validate` aprovado com 1.690 testes aprovados e 10 ignorados.
E2E completo: 484 aprovados, 7 ignorados pela configuração existente.
Após o ajuste de recuperação, `inbox-priorities.spec.js`: 21 aprovados,
incluindo INVALID_CURSOR → atualização503 → nova atualização bem-sucedida,
sem perder itens/rascunho/foco nem repetir o cursor inválido. A consulta não
executa comandos de domínio. Formatação, lint, typecheck, tokens e diff-check
passaram. Auditoria: zero alta/crítica; baixas/moderadas preexistentes.

Revisão independente backend/frontend/QA sem bloqueantes remanescentes.
Inspeção visual em 1366×768, 390×844 e 320×700, nos dois temas, com dados
sintéticos e sem erros de runtime/mutações; detector sem achados. Botões
usam seleção por marca/peso/superfície, contagens alinhadas e alvos de toque.

Sem PostgreSQL/Docker/WSL disponível localmente, o teste real adicionado em
`test/operation-read-postgres-live.test.js` depende do gate PostgreSQL do CI.
Ele cobre grupos e posições empatadas com microssegundos, paginação completa,
total global, outros responsáveis, agente, terminais e cursor por escopo/ator.
Não declarar implantação apenas com estes testes: publicar API compatível
antes do frontend e conferir CI, SHA/health e bundle servido no alvo.

## Caixa por vez de responder (RFC 052): ordem de deploy

- A API INBOX-VEZ-01 vai antes do front. Só depois do deploy da API o front
  novo deve ser publicado.
- Front novo com API antiga mostra um estado de erro na lista, no lugar das
  quatro abas. Isso é o esperado: a validação não deve ser removida para
  esconder a falha.
- Rollback volta o front primeiro e, depois, a API, como já consta na RFC 052.

### Comportamento do front (INBOX-VEZ-02/03)

- Chamadas da tela: `GET /inbox/conversations?bucket=…&owner=…[&orderReady=true]
[&assignedUserId=…]`, `GET /inbox/buckets` (mesmos filtros) e, nas consultas
  Encerradas/Arquivadas, `terminal=true`/`archived=true` sem `bucket`. O front
  nunca envia `orderReady` sem `bucket` (a API responde 400 `INVALID_FILTER`):
  "Só pedidos prontos" fica desabilitado nas consultas.
- Marcar perdido lê `GET /conversations/:id/lead-outcome` ao abrir o diálogo e
  envia `outcomeVersion` como `expectedOutcomeVersion` (maior que 0 se a perda já
  foi reaberta). A nota nunca é lida nem guardada pela tela. Conversa e versões
  ficam congeladas ao abrir; 403/409 fecham o diálogo, recarregam e mostram o
  motivo em português. A ação fica desabilitada, com o motivo escrito, quando a
  pessoa não é o dono (nem administrador), o agente atende, não há dono ou há
  pedido pendente/confirmado. "Lembrar depois" vale para qualquer vendedor.
- Lembrete: `remindAt` de agora a 90 dias (o campo limita o intervalo; 422
  `INVALID_REMINDER_DATE` tem mensagem própria).
- As abas e contadores são lidos de novo a cada 60 s, só com a aba do navegador
  visível, porque 72 h de silêncio, o fim de um lembrete e o agente parado não
  geram evento SSE. Com páginas de "Ver mais conversas" carregadas, só os
  contadores são relidos.
