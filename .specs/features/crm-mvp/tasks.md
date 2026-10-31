# CRM Silmer MVP — Plano de prontidão

## INBOX-IMG-VIEW-01 — ampliar e baixar fotos na Inbox (30/10/2026)

IMG-12/13, MED-16/19/25 e regra técnica 3. Correção solicitada pelo operador;
somente interface, sem alteração de API, retenção ou fluxo n8n.

- [x] Clique ou Enter/Espaço na foto abre diálogo responsivo nomeado, com
      foco contido, fechamento por Escape/botão e retorno à foto.
- [x] Baixar imagem na conversa e na ampliação usa leitura autenticada,
      bytes originais e extensão do MIME raster permitido, com nome sintético.
- [x] Erro de acesso, expiração e indisponibilidade são anunciados sem salvar
      resposta de erro; troca/saída da conversa aborta download pendente.
- [x] Preservar anexar ao pedido e seus retries idempotentes.
- [x] Gates integrados: Node 24.20.0/npm 11.19.0; `npm run validate`
      passou (1.483 testes aprovados, cinco ignorados), E2E/axe completo
      passou (377 aprovados, sete ignorados), incluindo 27 cenários de mídia.
      E2E isolado na porta 4197, sem alterar configuração versionada.
      Auditoria sem high/critical (um alerta baixo e dois moderados existentes);
      revisão independente sem findings e `git diff --check` aprovado.
- [ ] Conferir em produção depois do deploy.

## INBOX-HANDOFF-01 — resumo da transferência na Inbox (29/10/2026)

AGT-03, AGT-05 e PCX-03; item "Exibir o resumo do handoff na Inbox" de
VND-L02 (ADR 051). Não muda o n8n nem o banco.

- [x] `GET /api/v1/inbox/conversations/{id}/handoff` com `handoff.read`:
      handoff pendente ou aceito da conversa com o resumo decifrado só depois
      da autorização, `private, no-store`, sem query e `null` sem handoff.
- [x] Resumo do n8n lido como texto (o envelope guarda JSON) e resumo do
      Deal pela AAD do Deal, também na fila `GET /api/v1/inbox/handoffs`.
- [x] "Resumo da transferência" acima do histórico: uma linha por frase
      (Motivo, Atenção, Ficha, Dica…), perguntas do cliente em lista, aberto
      enquanto pendente e recolhido depois de aceito; botão dentro do título
      com `aria-expanded`, foco não muda ao carregar, some sem permissão.
- [x] Testes: API positiva e negativas (Financeiro, assistente, query),
      repositório com cifra real dos dois escritores, PostgreSQL 17 real e
      E2E com mock (teclado, axe, troca de conversa, 403, nada em URL/storage).
- [ ] Conferir em produção com um handoff real depois do deploy.

### INBOX-HANDOFF-01-FIX — chave de leitura do resumo (30/10/2026)

AGT-03, AGT-05 e PCX-03. O n8n cifra o resumo com
`N8N_INTEGRATION_ENVELOPE_KEY`; a leitura usava `HANDOFF_ENVELOPE_KEY` e
falhava quando as chaves eram distintas. O leitor seleciona chave e AAD pelo
escritor: sem Deal usa n8n; com Deal preserva o contrato humano legado.
Não muda os envelopes existentes nem exige migração ou reenvio do handoff.

- [x] Runtime injeta a chave n8n na leitura do resumo e da fila.
- [x] Regressão com chaves distintas, runtime real e fila; chave incorreta
      e AAD de outra conversa continuam rejeitadas, com ACL antes da leitura.
- [x] `npm run validate`: 1.483 aprovados, cinco ignorados, nenhuma falha;
      tipos, lint, contratos e build passaram. E2E completo: 364 aprovados,
      sete ignorados, nenhuma falha, incluindo teclado e axe do resumo.
      `npm audit --audit-level=high` passou (um alerta baixo e dois moderados
      existentes). Revisão independente sem bloqueantes; `git diff --check`
      passou. Testes executados fora do sandbox após bloqueio local de arquivos
      temporários. PostgreSQL live não executado nesta correção.
- [ ] Conferir a correção no ambiente implantado com handoff real.

## INBOX-UX-01 — área útil e clareza da Inbox (29/10/2026)

Complementa INBOX-4, PCX-10/12/13/14 e preserva contexto de AGT-03/05.
Autorização do proprietário no chat em 29/10/2026. Benchmark e limites em
[registro de produto](../../../docs/product/benchmark-inbox-2026-10-29.md).

- [x] Comparar referências de inbox no Dribbble, sem tratar inspiração visual
      ou dez perfis simulados como pesquisa com usuários reais.
- [x] Texto visível em Detalhes, painel recolhível e headers explícitos,
      preservando teclado, foco, preferências e regras de domínio.
- [x] Menu compacto na Inbox por padrão, escolha manual salva entre rotas e
      recargas, dicas por foco/hover e fallback sem storage.
- [x] Atalhos Aguardando vendedor / Meus atendimentos e linguagem consistente
      de transferência; nomes completos no celular sem scroll horizontal.
- [x] Gate integrado: validate (1.429 aprovados, cinco skips), E2E/axe
      (349 aprovados, sete skips), regressão final de Inbox/shell (74
      aprovados, sete skips), audit sem high/critical e diff sem whitespace.
      Auditoria informa um aviso low e dois moderate em dependências existentes.
- [x] Entrega atômica preparada com documentação e regressões; commit e push
      seguem o protocolo 1:1:1:1 desta tarefa.
- [ ] Homologação com vendedores reais: medir descoberta e produtividade;
      não é substituída por este benchmark ou pelos testes sintéticos.

## INBOX-IMG-RELEASE-03 — implantação da imagem para pedido

IMG-01/02/06–11, ARQ-02/04, PRV-03. Solicitação de 29/10/2026.

- [x] Preparar release restrito sobre a baseline publicada `a94b5be`, preservando
      CP-T09, demais telas e migrações.
- [x] Portar botão, escolha explícita do pedido e retry idempotente; 36 E2E
      focados aprovados, incluindo GIF, teclado, limite e indisponibilidade.
- [x] Preparar suporte privado a JPEG/PNG/WebP/GIF e documento raster, sem
      alterar tipo canônico, autorização, retenção, scanner ou infraestrutura.
- [x] Preparar patch offline do ramo Evolution e regressões de decoder,
      filtro, preservação e prioridade; seis testes aprovados.
- [x] Gate integrado, PostgreSQL sintético e CI aprovados.
- [x] Integrar e implantar frontend/API; conferir revisão, saúde e rollback.
- [x] Publicar patch mínimo do n8n sobre export atual preservado.
- [x] Provar imagem na Inbox → botão → arquivo do pedido → hash original.

Produção em `ad3001f` (PR #240); prova sintética dos quatro formatos no pedido
28-CRM, quatro hashes originais e replay sem duplicação. Estado operacional no [runbook](../../../docs/runbooks/inbound-images-inbox.md).

## INBOX-AUDIO-PROXY-01 — limite de anexo recebido (29/10/2026)

INBOX-AUDIO-01 / AUD-IN-02, INB-01, MSG-01/02 e INT-3.

- [x] Backport isolado do proxy: multipart até 17 MiB somente no POST da
      coleção exata de anexos n8n; demais rotas mantêm orçamento anterior.
- [x] Cinco testes de política, formato, lint e diff aprovados; smoke Docker
      do CI ampliado a 14 casos de rota/tamanho e negativas de método.
- [x] CI com Nginx real, integração por rebase e Auto Deploy existente.
- [x] Conferir SHA/saúde remotos e POST sintético acima de 1 MiB.

Não altera API, banco, frontend, credenciais ou o workflow publicado.
Recuperação do áudio antigo e teste Inbox/WhatsApp são evidências próprias;
os testes do proxy não comprovam reprodução ou entrega de áudio.

## INBOX-AUDIO-OPS-01 — aceite operacional (29/10/2026)

INBOX-AUDIO-01, INB-01, MSG-01/02 e PRV-03.

- [x] Recuperar somente o áudio antigo autorizado, com seleção única no
      provedor, upload autenticado e vínculo à conversa original.
- [x] Conferir player e reprodução completa do áudio recuperado na Inbox.
- [x] Enviar OGG sintético pela Inbox, conferir recebimento e player no WhatsApp.
- [x] Enviar o mesmo OGG pelo WhatsApp, conferir player e reprodução completa
      na Inbox, sem alterar responsável ou atendimento humano.
- [x] Manter utilitário manual inativo, sem salvar payloads de execução, e
      limpar os dados temporários do editor após o aceite.

Implantação, limites e evidências no
[runbook de áudio](../../../docs/runbooks/inbound-audio-inbox.md).

## INBOX-AUDIO-01 — áudio recebido com player (29/10/2026)

Requisitos AUD-IN-01..04, EVOL-01D, INB-01 e MSG-01..04.

- [x] Diagnosticar mensagem sem bytes: filtro do ramo independente aceitava
      somente imagem; player e API já suportavam OGG/MP3 privados.
- [x] Patch offline idempotente de dois parâmetros, com testes de cadeia
      Evolution, modo humano, MIME, tamanho, hash e replay.
- [x] Preparar limite estrito de 17 MiB no POST de anexos inbound do edge;
      implementação e regressão de isolamento de rotas aprovadas.
- [x] Publicar workflow `15d9ba9a-77e8-429b-bd43-e6dc2349ec5f`, comparando
      exportações: somente filtro/medição; conexões/settings e demais nós iguais.
- [x] Gate local: 1.429 testes aprovados, cinco skips, tipos/lint/build;
      E2E 344 aprovados + dois aprovados na repetição isolada e sete skips;
      auditoria sem alertas high/critical e `git diff --check`.
- [x] Implantar e verificar o limite maior do edge no ambiente remoto
      (concluído em INBOX-AUDIO-PROXY-01, acima).
- [x] Observar áudio novo com player e recuperar o áudio anterior afetado
      (concluído em INBOX-AUDIO-OPS-01, acima).
- [x] Enviar pela Inbox e observar recebimento/reprodução no WhatsApp de teste
      (concluído em INBOX-AUDIO-OPS-01, acima).

Evidência e limites no [runbook](../../../docs/runbooks/inbound-audio-inbox.md).

## INBOX-IMG-EVOL-02 — sintaxe da consulta de mídia (29/10/2026)

Requisitos IMG-01/03/04, EVOL-01D, INB-01 e MSG-01/02.

- [x] Reproduzir `invalid syntax` no HTTP do ramo real do n8n, isolado de IA/envios.
- [x] Corrigir os dois corpos no gerador e o clone da Inbox, com regressão
      da fronteira dos delimitadores; download até upload observado no n8n real.
- [x] Publicar revisão `4581279c-3960-4ee9-af83-9923bc360727`, conferindo
      três deltas funcionais, credenciais/conexões/settings e ordem dos fanouts.
- [x] Gate final: tipos, lint, 1.421 testes aprovados, cinco skips, zero
      falhas, build e `git diff --check`.
- [x] Recuperar dez imagens autorizadas e conferir renderização; comprovar
      quatro uploads ao pedido 21-CRM com leitura e hash dos objetos RustFS.
- [x] Após autorização específica, recuperar oito imagens em duas outras
      conversas: oito respostas 201 e renderização de seis e duas imagens
      recebidas, todas carregadas na Inbox; sem IA ou envios.
- [ ] Observar novo evento de imagem do canal após a publicação; replay
      isolado e histórico recuperado não substituem essa homologação.

Evidência e limites no [runbook](../../../docs/runbooks/inbound-images-inbox.md).

## EVOL-01 — ponte Evolution/Baileys e limpeza do n8n

Autorizada em 29/10/2026 na [ADR 050](../../../docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md),
[RFC 039](../../../docs/rfc/039-evolution-baileys-como-ponte-do-whatsapp.md).
Requisitos ORC-01..08, INB-01 e MSG-01..04; OPS-1 / INT-1/2.

- [x] EVOL-01A — decisão, fonte fixada, perfil privado, banco exclusivo sem Redis,
      adapter e testes negativos; jornada atual preservada.
- [x] EVOL-01B (provisionamento) — gateway/banco EasyPanel criados, backup privado
      e inventário n8n por CLI sem outro servidor/consumidor.
- [x] EVOL-01B (verificação) — imagem/build, perfil não root, health privado `200`
      e recusa sem chave `401`; preparação concluída antes do pareamento.
- [x] EVOL-01C — candidato importado e principal convertido no mesmo ID,
      inicialmente inativo; seis candidatos WAHA/WPP e duplicado Evolution arquivados após
      verificar referências. Sete workflows Meta e terceiros preservados por
      fingerprints; volumes e credenciais dos arquivados permanecem recuperáveis.
- [x] EVOL-01D (pareamento e texto) — identidade privada confirmada, principal
      publicado, entrada única na Inbox, handoff, tomada humana e resposta
      recebida no WhatsApp Web. Sete fluxos Meta intactos; backlog antigo sem
      entrega automática elegível, resultados incertos preservados sem retry.
      Backups conferidos e auxiliares temporários removidos.
- [ ] EVOL-01D (homologação restante) — mídia, recibos `delivered`/`read`, replay,
      reconexão e recuperação. Recebimento visual não homologa recibos do provider.
- [x] EVOL-01D / CHAN-WA-01-PHONE (texto e IA, 29/10) — após encerrar o
      ciclo de teste humano com autorização, nova mensagem abriu ciclo com IA;
      duas respostas e coleta progressiva observadas na Inbox/WhatsApp Web.
      Site/bio/chat/pós-pagamento publicados com canal único; Facebook salvo.
      Telefone do perfil Instagram depende de verificação de acesso recusada
      pelo proprietário. Evidência e limites no runbook Evolution.

Estado e limites no [runbook Evolution](../../../docs/runbooks/evolution-baileys.md).

## WPP-01 — preparação WPPConnect pausada

Preparação: [ADR 045](../../../docs/adr/045-piloto-whatsapp-wppconnect.md).
Revisão do transporte: [ADR 046](../../../docs/adr/046-retomar-waha-para-atendimento-da-nova-linha.md).
Escolha de transporte supersedida pela [ADR 050](../../../docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md)
(EVOL-01); esta seção permanece como histórico.
Requisitos ORC-01..08, INB-01 e MSG-01..04; OPS-1, INT-1/2 e INBOX-2/3.
[Etapas e evidências](../../../docs/runbooks/wppconnect.md).

- [x] WPP-01A — construir gateway restrito e verificar API privada; navegador
      impedido por falha de namespace `EPERM`, sem pareamento.
- [ ] WPP-01B — confirmar pareamento e identidade real: pausado.
- [x] WPP-01C — salvar candidato de atendimento WPPConnect de 101 nós,
      a partir da fonte atual de 92 nós; permanece inativo e sem cutover.
- [ ] WPP-01D — homologar canal real, recuperação e takeover: pausado.

O proprietário forneceu nova linha para a Inbox real em 28/10 e pediu QR após
reiterar a opção não oficial. WPPConnect nunca foi pareado e seu serviço foi
parado, sem aplicação de `--no-sandbox`. Pela ADR 046, WAHA/WEBJS foi retomado
com volumes novos para essa linha; a conta anterior bloqueada segue sem uso,
com seus volumes preservados. Nenhuma taxa de bloqueio é inferida da biblioteca.

## WAHA-01 — piloto autorizado da linha temporária

Decisão: [ADR 043](../../../docs/adr/043-piloto-whatsapp-waha-webjs.md).
Requisitos: ORC-01..08, INB-01 e MSG-01..04; fronteiras INBOX-2/3, AGENTE-6,
OPS-1 e INT-1/2. [Runbook e evidências](../../../docs/runbooks/waha-webjs.md).
Escolha de transporte supersedida pela [ADR 050](../../../docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md)
(EVOL-01); itens abertos abaixo ficam como histórico do WAHA.

- [x] WAHA-01A — preservar fonte e backup do workflow anterior.
- [x] WAHA-01B — instalar e validar WEBJS privado com persistência e autenticação.
- [x] WAHA-01C — adaptar, testar e salvar candidato inativo no n8n; smoke TEST
      autenticado sem efeito de domínio, sem substituir homologação real.
      Correções de ACK concluídas em 28/10 com 18 testes focados; candidato de
      101 nós regenerado da fonte atual de 92 nós e importado inativo. Provas
      remotas de falha `@lid`, resposta durável `202` e reentrega ainda pendentes.
- [x] WAHA-01D (texto operacional) — mensagem nova pelo WhatsApp Web persistiu
      na Inbox, bot transferiu e sua resposta chegou ao remetente. Takeover
      humano observado; nova resposta pela Inbox chegou uma vez ao WhatsApp.
      A conta anterior permanece bloqueada e sem uso, com seus volumes
      preservados; o histórico está no runbook. Pela ADR 046, WAHA/WEBJS foi
      retomado com volumes novos para a nova linha da Inbox real. O candidato
      `WahaSilmerPilot01` foi atualizado da fonte atual de 92 nós para 101 nós,
      permanecendo inativo. Depois do pareamento privado, a sessão `default`
      passou a `WORKING` e sua identidade foi conferida exatamente com a
      configuração privada. O principal `k7tI6T4RhQPyJkn9` foi despublicado,
      atualizado no mesmo ID para 101 nós e publicado na UI como
      “WAHA-01D · Nova linha na Inbox”, preservando IDs, webhooks e notas.
      Backup anterior protegido e filas sem pendências foram conferidos;
      `replaySafe=false`. Dois nós de envio humano foram corrigidos para
      normalizar um `+` inicial do destinatário E.164 e publicados como
      “WAHA-01D · Envio humano E.164”. O primeiro comando que falhou antes do
      HTTP conserva `OUTCOME_UNKNOWN`, sem replay; a prova final usou outro
      comando com texto diferente. Conteúdo e capturas permanecem privados.
- [ ] WAHA-01D (homologação restante) — mídia, matriz de status/falhas,
      reentrega, resultado incerto e reinício/reconexão do canal ainda exigem
      evidências próprias; não declarar a matriz inteira homologada.
- [ ] WAHA-01F — recuperar a autenticação após o incidente de 29/10; corrigir a chamada de renovação de QR incompatível, validar a imagem e comprovar nova entrada/resposta sem replay. Evidências no runbook; gerar QR/código não conclui esta tarefa.
- [x] WAHA-01E — registrar evidências, checks e entrega atômica no Git.

O transporte WAHA está publicado no ID principal preservado; candidatos
separados continuam inativos. Não reprocessar comandos ou execuções antigas.
O smoke completo com origem inválida retornou `500` antes do CRM; o no-op
anterior `200` verificava somente transporte. Em produção, sem autenticação
retornou `403`; status autenticado ignorado retornou `200`. Nenhuma dessas
respostas comprova recebimento/resposta real; a prova real está registrada
separadamente acima. Após a correção E.164, 39 testes focados passaram
(21 WAHA e 18 WPP). `npm run validate` passou com build: 1.189 testes,
1.186 aprovados, três ignorados e nenhuma falha. Site e link da bio foram publicados pela PR 40,
com novo destino e ausência do anterior verificados por HTTP. Duas automações
Meta e sete respostas salvas foram conferidas com o novo destino. Bio aponta
ao site atualizado; telefone comercial do Instagram e telefone da página
Facebook estavam sem telefone, sem destino antigo nesses campos. Autorização
e solicitação de análise do app não foram alteradas.

Atualização de 28/10: o workflow principal evoluiu com encaminhamento
site → WhatsApp, jornada e notas. O candidato foi regenerado da fonte atual,
versão `91eaff25-87f6-4f13-9a27-382fcd958abe`, preservando IDs do principal,
site e notas; o export `before-cutover-20261028.json` permanece protegido.
Foram concluídos exclusão de ACK `1`, timestamp do ACK pelo envelope, resposta
ao webhook após persistência no CRM com filtro para o site e tratamento
sanitizado de erro pelo próprio candidato. `npm run validate` passou com checks
e build: 1.168 testes, 1.165 aprovados, três ignorados, nenhuma falha. No smoke
remoto TEST, a chamada sem autenticação retornou `403`; o status autenticado
ignorado retornou `200`, sem CRM, IA ou envio. Isso não comprova resposta durável
`202`, falha `@lid`, reentrega ou canal real; suas provas remotas continuam
pendentes. A suspensão e o bloqueio relatados nesse histórico referem-se à
conta anterior; o estado da nova linha consta em WAHA-01D e na ADR 046.
A sessão anterior usava cliente Silmer CRM/Chrome,
filtros de grupo/status/canais e `webjs.tagsEventsOn=true`; volume existente,
limite de memória de 1536 MiB e contadores OOM zerados não explicam a causa
da falha ou do bloqueio mostrado no aplicativo.

## Evolução aprovada — Financeiro (21/10/2026)

Requisitos [FINQ-01–19](../financeiro/spec.md), decisão
[ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md) /
[RFC 028](../../../docs/rfc/028-financeiro-com-fila-e-check-manual.md).

- [x] **FINQ-PLAN-01:** registrar Fila e detalhe, perfil restrito, pedido
      confirmado e integralmente pago, check manual e design vigente.
- [x] **FINQ-PLAN-02:** registrar consulta administrativa com menu completo e
      login preservados (FINQ-16), sem comandos financeiros, e descartar o print
      como referência visual (FINQ-12), conforme
      [ADR 041](../../../docs/adr/041-consulta-administrativa-do-financeiro.md).
- [x] **FINQ-T01:** identidade, seleção dos três perfis em Usuários e autorização mínima.
- [x] **FINQ-T02:** elegibilidade, semântica/legado de pagamento, persistência,
      consultas e comandos financeiros auditáveis.
- [x] **FINQ-T03:** login, navegação e Fila e detalhe nos componentes atuais;
      Admin mantém menu completo e acessa a tela em consulta.
- [x] **FINQ-T04:** conclusão, correção, teclado, foco e recuperação de falhas.
- [x] **FINQ-T05:** QA, segurança, regressão e gates completos da implementação.
- [ ] **FINQ-T06:** homologação, operação e ativação da conta real.

O [plano da fatia](../financeiro/tasks.md) define dependências, fronteiras e
verificações. O PO autorizou implementação em 22/10/2026, com design vigente.
Novo valor exige nova quitação/check; declaração explícita libera datas
manuais legadas. [ADR 042](../../../docs/adr/042-perfis-e-requitacao-do-financeiro.md).
Homologação/ativação real seguem separadas. Integração Olist é fase posterior.

> **Atualizado em:** 05/10/2026\
> **Baseline:** PR 142 integrada, Pedido v5, OpenAI e deploy automático GitHub → EasyPanel.\
> **Design:** `TECHNICAL-DESIGN.md`; **topologia:** `EASYPANEL-TOPOLOGY.md`.

Os três objetivos são CRM | Inbox Multicanal | Agente Vendedor Silmer no n8n e convergem em integração e lançamento.

Implementação e homologação têm estados distintos. T00..T07 preservam a
rastreabilidade das issues históricas; os IDs abaixo organizam o lançamento
atual. ADRs 004 e 006 substituem o plano de Negócio/Kanban por Pedido.
Tarefas históricas de Pedidos permanecem em sua própria spec; não reabrir
implementação entregue nem marcar aceite externo por testes locais.

## Premissas comuns

- n8n recebe/envia WhatsApp, chama OpenAI e usa somente a API do CRM.
- A UI observa ou assume o atendimento, sem botão para iniciar workflow.
- Contato, Conversa e Pedido pertencem ao CRM; Pedido tem dois status.
- Confirmação, preço e condição são humanos; handoff/takeover não voltam à IA.
- Um pendente por conversa, comandos idempotentes, epoch/revisão e auditoria.
- Em 02/09/2026, a T00.6 foi aprovada na issue `#10` e deixou de bloquear T02, T03 e T05.
- Evidência em `docs/phase0/T00.6-APPROVAL-EVIDENCE.md`, com `silmer:romulo.sutil` no gate aprovado; não satisfaz os gates externos atuais.
- Cada entrega termina com checks proporcionais, commit e push. Somente o
  Hermes no Ubuntu atualiza o grafo; agentes não o geram nem versionam.

## Objetivo 1 — CRM

### CRM-1 — Fundação e autorização

**Situação:** identidade, sessão, CSRF, capacidade mínima do ator n8n,
auditoria e idempotência implementados. Verificar em UAT as permissões atuais
de Pedido, sem depender das antigas ações de aprovação de Negócio.

**Aceite restante:** dono/admin cria, edita, gera e reabre; outro vendedor
consulta e imprime somente confirmado. Repetição e concorrência preservam
efeito único. Vincular a matriz da issue #13 ao contrato atual.

**Rastreabilidade:** PRV-01..03, ORC-03..05 e PCL/PAU em Pedidos MVP.

### CRM-2 — Clientes e dados comerciais

**Situação:** Clientes, identidades, histórico de conversas e Pedido a partir
do atendimento implementados. Kanban/Negócio aposentados; suas migrations
históricas não são reutilizadas.

**Aceite restante:** homologar nome projetado no pendente e congelado no
confirmado, acesso autorizado e um pendente por conversa sob concorrência.

**Rastreabilidade:** INB-01..04, ORC-09 e PCT-01..03.

### CRM-3 — Pedido e ficha v5

**Situação:** ciclo pendente/confirmado, edição por seção, geração humana,
reabertura, numeração, técnica por item, origem da arte e impressão v5
integrados. Implementação detalhada: T01..T87 de Pedidos MVP, com refinamentos
T76..T82 e T83..T87 (PR 142 / ADR 020).

**Aceite restante:** assinatura física de Rose e Operação para v5, UAT do
fluxo atual e procedimento durável dos arquivos/encaminhamento a Rose.
Upload automático e aviso a Rose não estão ativos; dependem de contrato próprio.

**Rastreabilidade:** ORD-01..05, PFI/PIM/TEC. PAY-01..05 são evolução diferida
pela ADR 006; não exigir cobrança PIX para gerar Pedido no ciclo atual.

### CRM-4 — Gestão e operação

**Situação:** usuários, Dashboard de confirmados, sinais observáveis e
atualização por eventos implementados. Relatórios adicionais, privacidade
operacional e recovery só são completos quando houver evidência própria.

**Aceite restante:** confirmar totais e reabertura; homologar retenção,
tombstones, backup externo e recuperação. Issues #3, #11 e #29 preservam seus
gates independentes; storage de mídia transitória pode seguir a exceção interna.

**Rastreabilidade:** FIN-01..03, PRV-02..03, REV-06..09 e T06.3/T07.3.
Painel por papel (RFC 024, ADR 036): PNL-01..03 na T130 e PNL-04, adiado pelo
PO, na T131, ambas em [Pedidos MVP](../pedidos-mvp/tasks.md).

## Objetivo 2 — Inbox Multicanal

### INBOX-MEDIA-1 — Mídia enviada pelo vendedor

**Situação:** implementação local com RustFS existente, imagem,
áudio anexado/gravado pelo microfone e vídeo. Mídia enviada será preservada
sem TTL de sete dias ou expurgo ao encerrar, conforme ADR 029.

**Entrega:** 28 tarefas em quatro fases; requisitos e critérios vigentes,
design, matriz de testes e gates em
[inbox-media-rustfs](../inbox-media-rustfs/tasks.md). T24 de UAT humana permanece
pendente. T1–T23 e T25–T28 entregues; DEV lê arquivos reais e simula apenas Meta;
homologação WhatsApp e backup/restore permanecem evidências externas.

**Rastreabilidade:** INBOX-3/4, MSG-01..03, PRV-01..03, T02/T06 e issue #29.

- [x] INBOX-MEDIA-PLAN-1 — especificação, contexto, design, 24 tarefas,
      ADR/RFC e revisão independente entregues; gates estruturais strict passaram.
      [Evidência](../inbox-media-rustfs/planning-review.md): validate passou;
      E2E e audit da baseline têm pendências. Este item conclui o planejamento,
      não a implementação nem a prontidão de release.

| Etapa                    | Implementação atual                                    | Homologação restante                                                              |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| INBOX-1 — Mensagens      | Contato, conversa, mensagem e envelope n8n persistidos | Repetição e eventos fora de ordem no canal real                                   |
| INBOX-2 — WhatsApp       | Fronteira Meta → n8n → CRM versionada                  | Credenciais distintas, webhook publicado e resposta humana                        |
| INBOX-3 — Confiabilidade | Reserva, status e resultado incerto                    | Falha real, reconciliação e mídia indisponível visíveis                           |
| INBOX-4 — Interface      | Inbox, handoff, takeover, transferência e eventos      | Teclado, foco, acesso entre vendedores e nenhuma retomada automática após handoff |
| CANAL-2 — Instagram      | Fase posterior                                         | Adapter, correlação explícita e UAT próprio                                       |

**Rastreabilidade:** INB/MSG, AGT-03..08, ORC-07..09, PRV-01 e ADR 015.

## Objetivo 3 — Agente Vendedor Silmer no n8n

| Etapa                      | Contrato ou capacidade                                           | Pendência                                                                                                   |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| AGENTE-1 — Runtime         | n8n com banco e criptografia próprios                            | Checar ambiente EasyPanel existente, editor protegido, backup e restauração                                 |
| AGENTE-2 — API             | Três endpoints, Basic, idempotência, correlação e epoch/revisão  | OPS-1 no ambiente real                                                                                      |
| AGENTE-3 — OpenAI          | Provedor escolhido; schema e regras determinísticas              | DPA e ZDR informados como entregues em 30/10/2026; retenção, logging e demais checagens do checklist OpenAI |
| AGENTE-4 — Coleta e Pedido | Briefing progressivo, projeção e criação idempotente do pendente | Jornada real com dados fora de ordem, técnica e origem da arte                                              |
| AGENTE-5 — Handoff         | Transferência e invalidar execuções antigas                      | Takeover durante resposta e claim concorrente                                                               |
| AGENTE-6 — Operação        | Workflows e contratos versionados                                | Health, alertas, rotação, custo e runbooks no ambiente alvo                                                 |

**Rastreabilidade:** ORC-01..08, AGT-01..08, PAG/TEC e PRV-01..03.
OpenAI é a baseline da [ADR 021](../../../docs/adr/021-adotar-openai-no-mvp.md);
um segundo provedor não é gate do MVP.

## N8N-MVP-1 e sequência de homologação

N8N-MVP-1A (contrato/modelo), N8N-MVP-1B (reserva por epoch/revisão) e
N8N-MVP-1C (workflow simples) são a baseline implementada da RFC 002 / ADR 003.

**OPS-1 permanece operacional:** verificar duas credenciais Basic distintas,
workflow e versão ativos, smoke sintético e WhatsApp real antes de declarar
canal homologado. CRM compatível deve estar implantado antes do workflow que
envia `order.intent_confirmed`; guardar versão anterior para rollback.

Inbox/Handoffs/Clientes e Pedido já existem; o próximo trabalho é UAT e
prontidão. Não há tela de runs, claims ou tentativas no MVP simples.
`docs/roadmap/PROXIMAS-FASES.md` detalha a ordem operacional.

## Integração e lançamento

### INT-1 — Jornada integrada

Ligar WhatsApp → n8n → CRM → Inbox e CRM → n8n → WhatsApp; completar um
Pedido, handoff, geração e impressão v5 com eventos em tempo real. Nenhum
workflow escreve no banco e nenhuma ação depende de botão para iniciar n8n.

### INT-2 — Falhas, acesso e acessibilidade

Repetir webhook, atrasar IA, provocar concorrência e takeover, trocar versão,
induzir falha externa e resultado incerto. Validar ACL, CSRF, assinatura Meta,
rotação, PII, teclado, foco e ARIA. Zero efeito duplicado, obsoleto ou acesso
indevido; resultado incerto exige reconciliação.

### INT-3 — Ambiente e release

Manter o deploy automático atual ([ADR 022](../../../docs/adr/022-manter-deploy-automatico-github-easypanel.md)).
Pipeline verde, imagem identificada por digest, migrations, HTTPS/isolamento,
health, segredos, backups externos, monitor off-host, rollback e recovery
devem ter evidência atual do EasyPanel. Código, docs e mocks não substituem
checagem do painel. Fechar gates aplicáveis das issues #1, #3, #5, #11, #13 e #29.

### INT-4 — UAT e go-live

Produto e Operação validam ORC/INB/AGT/MSG/ORD/FIN/PRV e PCL/PFI/PIM/TEC com
dados sintéticos; Rose e Operação assinam v5. Privacidade aprova OpenAI e seus
controles aplicáveis. Lançar só com canal real, agente controlável, rollback e
recovery demonstrados. Instagram e PAY diferidos têm UAT próprio posterior.

## Manutenção de prontidão — 05/10/2026

| ID         | Entrega                                                                  | Rastreabilidade                                 | Estado                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-DOC-01 | Reconciliar PR 142, docs ativos e rastreabilidade, preservando histórico | CRM-1..4, ORC/INB/AGT/ORD, TEC-01..08, T83..T87 | Entregue; contratos, links, validate e E2E passaram                                                                                       |
| OPS-CI-01  | Investigar e corrigir publicação de imagens                              | INT-3 / T00.2                                   | Em verificação                                                                                                                            |
| OPS-CHK-01 | Auditar deploy automático existente e checar ambiente alvo               | INT-3 / T00.3                                   | Auditoria dos quatro serviços registrada; gaps de produção pendentes ([evidência](../../../docs/runbooks/production-readiness-checks.md)) |
| OPS-AI-01  | Escolher OpenAI e reconciliar baseline documental                        | ORC-06, PRV-01..03, AGENTE-3 / INT-3            | Decisão técnica registrada; DPA e ZDR informados em 30/10/2026; demais checagens pendentes                                                |

## Confiabilidade da Inbox — 24/10/2026

- [x] **OPS-INBOX-ACK-01 — validar confirmação do comando CRM → n8n.**
      HTTP 200/202 exige `accepted: true` e `command_id` correspondente. Corpo
      ausente, inválido ou genérico e confirmação de outro comando preservam
      resultado desconhecido, sem retry cego. ACKs vigentes de estado, callback
      e replay continuam aceitos. Requisitos ORC-08, MSG-03 e INBOX-3/INT-2.
- [ ] **OPS-1 — homologação WhatsApp real.** Trigger alinhado à credencial
      existente do app aprovado; callback e `messages` registrados. O teste
      oficial sintético da Meta apareceu ao vivo na Inbox e a tomada humana foi
      verificada. App publicado após autorização do proprietário; telefone offline
      e credencial de envio inválida ainda impedem concluir
      homologação. [Evidência e procedimento](../../../docs/runbooks/inbox-whatsapp.md).

## CHAN-WA-01 — Auditoria e encaminhamento (27/10/2026)

- [x] Exportar publicado e comparar regras/nós sem expor configuração privada.
- [x] Remover categorias, preservar guard publicado e cobrir ambiguidades.
- [x] Criar CTA site/linktree e fallback estático do webhook sem CRM/IA.
- [x] Executar matriz de 35 cenários e pesquisa documental de UX/a11y.
- [x] Publicar e verificar n8n; executar modelo real em harness sintético sem CRM/envios.
- [x] Organizar canvas e notas; testar preservação de comportamento e layout.
- [x] Publicar site em produção; PR #37 em main e smoke remoto das três rotas aprovado.
- [x] Configurar e verificar resposta fixa Instagram/Messenger, bio e sete modelos salvos.
- [x] Corrigir destino para o WhatsApp do CRM `5527936180599`, conforme orientação do proprietário.
- [x] Testar envio real pelos caminhos site e bio Instagram; ambos entregues no WhatsApp ([evidência](../../../docs/integrations/n8n/jornada-canais-crm-2026-10-28.md)).
- [ ] Homologar chegada na Inbox e resposta do Vendedor após pareamento/ativação da linha do CRM (WAHA-01D/OPS-1).
- [ ] Opcional: adicionar link direto/botão WhatsApp pelo aplicativo Instagram (edição web indisponível).

Decisão ADR 044/RFC 032. Evidência em docs/integrations/n8n/auditoria-vendedor-2026-10-27.md.

## VND-L01 — Aprendizados do Vendedor na Inbox real (28/10/2026)

- [x] Analisar 5 conversas reais transferidas e as pré-fichas geradas.
- [x] Reconhecer pergunta de viabilidade antes da próxima pergunta (AGT-02).
- [x] Aceitar modelo livre e camisa esportiva; não repetir pergunta idêntica (AGT-02).
- [x] Tratar a mensagem de referência do site como nota de pedido do zero (AGT-02, CHAN-WA-01).
- [x] Bandeira como tipo próprio, tamanho em `items[].tipo` da Ficha (AGT-02, AGT-07).
- [x] Datas relativas com data calculada e confirmação única (AGT-02).
- [x] Empresa com marcador explícito em `order_name` e Dica ao vendedor (AGT-02).
- [x] Aviso de horário comercial em toda transferência fora do horário (AGT-03).
- [x] Quantidade dita para item único em `quantidade_informada` (AGT-07, AGT-08, ADR 025).
- [x] Atualizar `docs/integrations/n8n/README.md` (seção VND-L01).
- [x] Publicar no n8n com backup e verificação, autorizado pelo proprietário: versão `799b0a92`, rollback `a107910d`.
- [ ] Observar as primeiras conversas reais após a publicação (o principal não salva execuções).

Decisão ADR 049/RFC 037. Teste: `test/n8n-vendedor-aprendizados.test.js`.

## VND-L02 — Vendedor aprende com os atendentes humanos (29/10/2026)

- [x] Analisar 9 conversas reais de 29/10 e as respostas da vendedora.
- [x] Adiar a primeira pergunta de preço; transferir na insistência (AGT-04).
- [x] Perguntar arte e tecido com valores que a Ficha lê (AGT-02, PRD-02/03/06).
- [x] Imagem sem falha nem pergunta ignorada (AGT-02, AGT-05).
- [x] Agrupar mensagens seguidas antes de responder (AGT-01).
- [x] Prazo hoje ou amanhã transfere com urgência (AGT-03).
- [x] Parceria e revenda com perguntas no resumo (AGT-03, AGT-05).
- [x] Tom sem elogio e aviso perto do fechamento (ORC-03).
- [x] Publicar no n8n com backup e verificação, autorizado pelo proprietário: versão `cd0de4e8`, rollback `8cd3ccf7`.
- [ ] Observar as primeiras conversas reais após a publicação (rajada, preço adiado, arte e tecido).
- [x] Exibir o resumo do handoff na Inbox (INBOX-HANDOFF-01).

Decisão ADR 051/RFC 040. Teste: `test/n8n-vendedor-aprendizados-l02.test.js`.

## Correção de imagens recebidas — 28/10/2026

INBOX-IMG-01 (INBOX-2/3, INB-01..05, MSG-01/02, PRV-03): projetar e servir
anexos transitórios na Inbox e preparar patch offline do workflow WAHA atual,
preservando o atendimento existente. Critérios em
[spec](../inbound-media-inbox/spec.md), aplicação e recuperação pontual no
[runbook](../../../docs/runbooks/inbound-images-inbox.md).

Estado: implementação, gates e revisão independente aprovados no escopo
local; relatório em `../inbound-media-inbox/validation.md`. Nenhuma aplicação,
ativação, recuperação de dados ou alteração
operacional em produção concluída. Leitura do ambiente confirmou duas imagens
sem anexos e recursos do scanner indisponíveis para a API; o worker os possui.
