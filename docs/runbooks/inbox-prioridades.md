# Inbox — prioridades do vendedor

INBOX-UX-02, PCX-15a–f e PCX-03/04/13/14. Composição autorizada pelo proprietário
em 03/11/2026: quem atender, maior espera e pedidos disponíveis para revisão final.

## Comportamento

Atender é a entrada padrão e reúne as ações do próprio vendedor e os handoffs
sem dono. Todas mantém a consulta aos demais atendimentos; Situação e Responsável
continuam na folha Filtros. Fechar pedidos usa um pedido elegível da conversa,
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

A lista carrega até 100 resultados e informa o total oficial quando maior;
a busca continua limitada às conversas carregadas. Múltiplos assuntos usam
reviewOrder como alvo explícito pronto; order canônico permanece preservado.
O header, link e resumo apontam ao mesmo alvo. Um pedido de outro ciclo só
qualifica quando o responsável é o mesmo; nunca inferir alvo pelo texto.

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

## Publicação e rollback

API e frontend devem corresponder ao mesmo commit. Não há migration nova nem
ação remota de teste. O deploy segue o fluxo GitHub → EasyPanel existente.
Após deploy, conferir SHA/health, fila pessoal vs Todas, totais, resumo e
pedido com dados autorizados; não enviar mensagens só para conferir layout.

Rollback reimplanta a imagem anterior de API/frontend em conjunto. Não exige
restaurar banco, reabrir conversa, desfazer claim ou repetir envio. A causa de
um handoff unsupported real é investigação própria do workflow/telemetria.
