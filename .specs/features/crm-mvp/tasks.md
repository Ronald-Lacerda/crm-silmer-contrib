# CRM Silmer MVP — Plano de prontidão

## INBOX-VEZ-08 — Responder por mensagem mais recente (08/11/2026)

[RFC 053](../../../docs/rfc/053-responder-por-mensagem-mais-recente.md) /
[ADR 066](../../../docs/adr/066-responder-por-mensagem-mais-recente.md), PCX-19e,
solicitada pelo proprietário após observar mensagens novas no fim da fila.

- [x] Ordenar Responder pela última mensagem decrescente e ID decrescente,
      sem prioridade fixa para falhas e sem mudar o relógio de espera.
- [x] Alinhar cursor SQL, invalidar cursores da ordem anterior e atualizar
      o rótulo da interface, preservando classificação, ACL e outras abas.
- [x] Verificar banco, paginação, regressão e interface; revisão independente.
- [x] Commit e push da entrega atômica. Operação e rollback no runbook da Inbox.
- Evidência local: `npm run validate` passou (1.957 testes aprovados, 22 skips,
  zero falhas, com build); PostgreSQL isolado passou 15 testes sem skips,
  cobrindo Inbox, consultas e lembretes. E2E/axe completo: 588 aprovados,
  sete skips e uma corrida no teste preexistente de dispensar sugestão do
  Dashboard (`mock.writes` lido antes do callback); a repetição isolada passou.
  O cenário novo de recência/SSE/seleção/rascunho passou no gate completo.
  Auditoria npm sem vulnerabilidades; capturas sintéticas em 1366×768 e
  390×844 conferidas; detector visual sem findings e revisão independente sem
  bloqueantes. Publicação no ambiente permanece sujeita ao merge/deploy.

## OPS-CI-02 — E2E e PostgreSQL em paralelo (08/11/2026)

Manutenção interna de INT-3 / T00.2, autorizada pelo mantenedor.

- [x] Separar PostgreSQL do job de validação/E2E, mantendo a suíte de banco
      serializada e a mesma lista de testes.
- [x] Preservar o nome do check obrigatório e exigir sucesso dos dois jobs
      antes do build/scan das imagens, inclusive diante de falha ou skip.
- Operação e rollback em [Supply chain](../../../docs/phase0/SUPPLY-CHAIN.md).

## INBOX-VEZ-01 — Caixa por vez de responder: API (08/11/2026)

Fatia de API da [RFC 052](../../../docs/rfc/052-caixa-de-entrada-por-vez-de-responder.md)
e [ADR 065](../../../docs/adr/065-caixa-de-entrada-por-vez-de-responder.md),
requisitos PCX-19a–j. Sem migration e sem dependência nova. Branch de trabalho
`claude/inbox-vez-01`, a partir de `origin/master`.

- [x] Abas derivadas em SQL com a precedência da ADR 065 (PCX-19a/b/i).
- [x] `GET /inbox/conversations` com `bucket`, `owner`, `orderReady` e `terminal`;
      400 `INVALID_FILTER` nas combinações proibidas (PCX-19c/j).
- [x] Ordem e cursor por aba e ator, sem alterar `workQueue`, `sort=urgency`
      nem fingerprints atuais (PCX-19e).
- [x] `GET /inbox/buckets` num único snapshot (PCX-19d).
- [x] Campos novos no item e no detalhe, com `reminder.mine` (PCX-19f).
- [x] Tempo de expediente e `turnAsOf` do servidor; 72 h em `turn-policy.js` (PCX-19g).
- [x] `POST /conversations/:id/reminder` com idempotência, versão, auditoria sem
      texto livre e evento `conversation` (PCX-19h).
- [x] `POST lead-outcome` publica o evento SSE `conversation` (PCX-19j).
- [x] Contrato OpenAPI do lembrete em `docs/api/openapi.v1.yaml`.
- Evidência local em 08/11/2026, PostgreSQL 17.10: `npm run validate` aprovado
  e gate live completo do CI com 212 testes aprovados, sem skips, incluindo
  `test/inbox-buckets-postgres-live.test.js`,
  `test/conversation-reminder-postgres-live.test.js` e
  `test/lead-outcome-postgres-live.test.js`. Sem migration, nada a aplicar.
  Medição do p95 em volume real pendente (ADR 065).

## INBOX-VEZ-02/03 — Caixa por vez de responder: UI (08/11/2026)

Front da [RFC 052](../../../docs/rfc/052-caixa-de-entrada-por-vez-de-responder.md),
decisões D1–D10 do PO. Deploy: API (INBOX-VEZ-01) antes do front; ver
`docs/runbooks/inbox-prioridades.md`.

- [x] INBOX-VEZ-02 — Abas Responder/Aguardando/Sem retorno/Perdidos com contagem
      do snapshot, seletor de responsável, card em três linhas, chip Pedido
      pronto, Consultar (Encerradas/Arquivadas), mapeamento das URLs antigas,
      relógio do alerta projetado a partir de `turnAsOf`, estado de erro quando a
      resposta vem sem `bucket`, releitura de 60 s com a aba visível.
- [x] INBOX-VEZ-03 — Faixa na conversa: Lembrar depois (`POST /reminder`),
      Marcar perdido e Reabrir (`lead-outcome`, versão lida do servidor ao abrir),
      só para dono ou administrador em atendimento humano, com motivo visível
      quando indisponível. Retomar é abrir a conversa e responder.
- Evidência local em 08/11/2026: lint, typecheck, format, build, 24 testes de
  `inbox-turn` e suíte Playwright completa (587 aprovados, 7 ignorados, 0
  falhas), com axe nas telas novas. Revisão independente sem P1; os P2
  (comando em conversa errada, linhas da aba anterior, troca de conversa com
  rascunho) foram corrigidos com teste. Testes dos atalhos antigos (Atender,
  Fechar pedidos, Todas) foram substituídos por `test/e2e/inbox-vez.spec.js`.
- [x] INBOX-VEZ-04 — Extração do template de `InboxView.vue` para `InboxTabs`,
      `ConversationCard` e `InboxTurnStrip`, sem mudança de comportamento.
- [x] INBOX-VEZ-05 — Extração da lógica de Lembrar depois (ACT-05), Marcar
      perdido e Corrigir perda (MET-06/07, D9) para `useInboxReminder`,
      `useInboxOutcome` e `useConversationTitleFocus`, em
      `apps/edge-web/src/components/inbox/`, com testes unitários de caminho
      feliz, erro e conflito de versão. Sem mudança de texto, ARIA, ordem de
      foco, contrato de API ou migration. `InboxView.vue`: 4407 → 4065 linhas.
- [x] INBOX-VEZ-06 — P2 da revisão da RFC 052: em celular, o formulário
      Lembrar depois esconde a barra inferior como o compositor (`:focus-within`
      em `.inbox-turn-form`); os totais das abas são lidos em paralelo com a
      lista, não depois dela. Teste E2E novo em `inbox-vez.spec.js`; Playwright
      completo 587 aprovados e 7 ignorados mais o teste novo (um teste de áudio
      do Firefox falhou só sob carga e passa isolado, também sem a mudança).
- [x] Validação da tela contra API e banco reais (08/11/2026): PostgreSQL 17.10
      local, 58 migrations, API e edge reais, dados sintéticos e Chromium.
      Abas e contagens batem (4/1/2/0 e depois 5/1/1/0); Lembrar depois é por
      pessoa (some para quem adiou, fica com selo para a outra pessoa); Marcar
      perdido e Corrigir perda movem a conversa entre Sem retorno e Perdidos;
      uma mensagem nova do cliente leva a conversa a Responder em cerca de 1 s
      pelo SSE; `terminal=true` lista Encerradas; os links antigos
      `?situacao=` e `?fila=` abrem a aba esperada; 320 px sem rolagem lateral;
      sem erro de console nem resposta 4xx/5xx. No celular, a barra inferior
      continuava visível com o formulário aberto no master e some com a PR 314.
- [x] INBOX-VEZ-07 — Resto do P3: regras puras saem de `InboxView.vue` para
      `lib/inbox-turn.js`: `inboxStateFromRoute` (links antigos, D1/D10),
      `inboxListUrl`/`inboxBucketsUrl`, `turnCardTime` e o registro
      `BADGE_RULES` (`{key, priority, leadsIn, tone, applies, label}`), onde a
      cobrança pela conversa (RFC 047) e o cancelamento Olist entram como uma
      entrada cada. Sem mudança de comportamento, texto, ARIA, contrato ou
      migration. `InboxView.vue`: 4065 → 3996 linhas. Testes novos em
      `test/inbox-turn-rules.test.js`; nenhum existente foi editado; `npm test`
      1956 aprovados, 0 falhas; Playwright completo 587 aprovados, 7 ignorados.
- [x] Deploy em produção (08/11/2026): API, worker e edge publicados pelo
      Auto Deploy do EasyPanel a partir do `289df19c`, sem migration. Conferido
      em `crm.silmer.com.br/inbox`: as quatro abas listam conversas diferentes
      (9/6/35/0 na hora), `GET /api/v1/inbox/buckets` e as listas `bucket=respond`,
      `silent` e `lost` responderam 200, sem erro de console. Não foram exercidos
      em produção Lembrar depois, Marcar perdido nem o celular (escrevem em dados
      reais; cobertos pela validação local e pelo E2E).
- [x] p95 da lista em volume real: **dispensado por decisão do proprietário
      (08/11/2026)**. A caixa de produção tem cerca de 50 conversas abertas,
      muito abaixo das 5.000 do teste sintético. A medição de dois dias do
      [runbook](../../../docs/runbooks/inbox-prioridades.md) só é aberta se a
      equipe relatar lentidão; nesse caso, e se o p95 passar de 300 ms, abrir ADR
      para a migration de desnormalização. INBOX-VEZ-01 a 07 concluídas.

## OPS-DEPS-01 — correção da auditoria npm (07/11/2026)

Manutenção interna do gate INT-3 / T00.2. Atualização autorizada pelo mantenedor,
preservando ESLint 10.9.1. Versões, compatibilidade, evidências e rollback no
[runbook](../../../docs/runbooks/dependency-audit-2026-11-07.md).

- [x] Seis alertas eliminados, instalação reproduzível e ESLint preservado.
- [x] CI manual autorizado sobre master: validate (1.872 aprovados), E2E/axe
      (538 aprovados), PostgreSQL (264 aprovados) e auditoria zerada.
      Actions bloqueado por cobrança; checks de containers/Trivy indisponíveis
      localmente, com limitação registrada no runbook. Integração e implantação
      acompanhadas na [PR 309](https://github.com/romulosutil/crm-silmer/pull/309).

## OLIST-T20b — Início da Fase 3 (05/11/2026)

## OLIST-T07 — comando idempotente, snapshot e job (06/11/2026)

- [x] Rota humana com checkbox/sessão/CSRF/Origin/Idempotency-Key, corpo estrito
      somente com recibo de prévia cifrado e resposta mínima 202.
- [x] Revalidar fonte e gerar snapshot/operação/job/evento/auditoria/recibo na
      mesma transação; nenhuma escrita ERP ou mutação comercial do Pedido.
- [x] Uma operação por Pedido/conta, fingerprint semântico imutável em 0067,
      convergência de prévias/chaves e conflito de request divergente.
- [x] Replay com gates/época atuais, preservando executor, data e resposta;
      falhas de persistência revertem todos os artefatos locais.

OLIST-01–02, 06, 11–15, 30, 33. [Contrato e evidências](../../../docs/runbooks/olist-phase3.md#t07--comando-idempotente-snapshot-e-job).
Próximo T08. F3 permanece aberto e fila olist sem consumidor; flags de produção,
interface, deploy e piloto não foram habilitados.

## OLIST-T22 — resolução e criação segura (06/11/2026)

- [x] Compartilhar cliente/pai/tamanhos entre Pedidos com base cifrada imutável,
      vínculo por export e request/tickets duráveis na migration expand 0066.
- [x] Resolver snapshot persistido, política fiscal explícita, consulta completa
      de situações/formatos e confirmação por documento, atributos, pai/SKU/grade.
- [x] Reservar pai e filhos antes do POST composto, preservar IDs antes de GET,
      bloquear zero após incerteza e retomar sem recriar sucesso anterior.
- [x] Revalidar usuário/checkbox, conexão, configuração, Pedido e comprador/fonte
      antes de cada efeito; resultado iniciado persiste após revogação.
- [x] Concorrência, timeout, falha de commit, resposta ID-pai e recuperação
      comprovados com fixtures sintéticas e PostgreSQL dedicado.

OLIST-07–08, 12–17, 27, 35–39. [Contrato e evidências](../../../docs/runbooks/olist-phase3.md#t22--resolução-e-criação-segura-de-cadastros).
T07 está concluída acima; próximo T08; F3 permanece aberto. Não há rota/worker criador
ativo, integração real, deploy ou piloto nesta entrega.

## OLIST-T06 — prévia completa (06/11/2026)

- [x] OLIST-T06: prévia por fonte atual/legado/loja com cadastro, preço exato,
      parâmetros e plano somente leitura; recibo cifrado expirável/versionado.
- [x] Negativos, ACL/CSRF, mudanças durante GET, fontes suplementares completas
      e obsoletas e ausência de efeitos verificados no PostgreSQL dedicado.

Prévia de API implementada para OLIST-06–12, 34–44: fonte gerenciada/legado/loja,
cadastro fiscal, centavos exatos, configuração e descoberta somente leitura.
Recibo cifrado por sessão/conta/fontes com validade de 15 minutos, revalidação
e pendências explícitas. Gate local/evidências no
[runbook](../../../docs/runbooks/olist-phase3.md#t06--prévia-completa-sem-escrita-erp).
T22/T07 estão concluídas acima; o próximo item é T08; gate F3, UI, deploy e piloto seguem
abertos. Nenhuma criação ERP foi habilitada.

## OLIST-T24 — Fonte da loja sem alterar checkout (05/11/2026)

- [x] Adaptador validado do snapshot pago com uma linha: subtotal igual ao total
      persistido, sem rateio, consulta de catálogo atual ou edição de preço.
- [x] Complementos explícitos de previsão, Aplicação e cadastro fiscal cifrado,
      com pendências por campo, sem criar Contato ou sobrescrever dados originais.
- [x] Admin comercial atual, versão/ACL/idempotência transacionais, fonte obsoleta
      após correção comercial e rebase explícito; checkout/gateway/travas preservados.
- [x] Fonte interna transitória para T06; preços completos não eliminam pendências
      fiscais nem substituem os gates de prévia/configuração/precisão ERP.

OLIST-01, 06–12, 19, 29, 34–35, 44. [ADR 067](../../../docs/adr/067-fontes-comerciais-suplementares-sem-reescrever-ficha.md),
[runbook](../../../docs/runbooks/olist-phase3.md). T24/T26 concluídas no domínio/API;
próxima tarefa T08. F3 permanece aberto, sem UI, deploy ou geração ERP.

## OLIST-T26 — Legado sem reescrever ficha (05/11/2026)

- [x] Fonte suplementar cifrada append-only, IDs estáveis, autoria/versão e HMAC.
- [x] Lote humano versionado/idempotente com igualdade do total histórico,
      preservando ficha, pagamento/check e rótulos/templates antigos.
- [x] ACL atual antes de replay, mesma transação de revisão/evento/auditoria/recibo,
      reserva Olist e fontes obsoletas bloqueadas, rebase e rollback sem down.
- [x] Leitura/reconfirmação do legado usa prova interna fresca, sem migrar a ficha.

OLIST-29, 42–44. [ADR 067](../../../docs/adr/067-fontes-comerciais-suplementares-sem-reescrever-ficha.md),
[runbook](../../../docs/runbooks/olist-phase3.md). T24 concluída acima; T06 descrita acima e F3 aberto.

## OLIST-T20/T21 — Composição e confirmação calculada (05/11/2026)

- [x] Persistir composição opt-in no envelope cifrado, com IDs emitidos pelo servidor.
- [x] Comandos humanos com ACL/versão/idempotência/auditoria: revisão, quantidade,
      reordenação de grupos e duplicação; grade/composição na mesma escrita.
- [x] Bloquear perda de identidade por cliente antigo/projeção automática,
      adoção de loja/confirmado/reaberto histórico e confirmação livre após adoção.
- [x] Completar T20: edição de atributos, inclusão/remoção e reordenação de linhas.
- [x] T21: total calculado persistido e confirmação sem preço livre;
      declaração antiga só por igualdade, incompleto bloqueia sem fallback.
- [x] Quitação/check invalidados transacionalmente quando o total muda;
      histórico e revisão de quantidade preservados.
- [x] T24/T26: adapters de loja e legado (fechamentos acima).
- [ ] Fase 4: interface de edição.

Requisitos OLIST-09–10, 29, 34, 40–44. [Contrato e limites](../../../docs/runbooks/olist-phase3.md).
T20/T21 completas no domínio/API; F3 permanece aberto. Nenhuma adoção operacional,
UI, geração ERP, deploy ou piloto liberado.

## OLIST-F2 — Fase 2 concluída (05/11/2026)

- [x] OLIST-T03: migrações expand 0063/0064, vínculos/snapshots cifrados,
      reservas duráveis e outbox transacional, preservando jobs de cobrança.
- [x] OLIST-T04: OAuth por sessão, conta esperada, refresh reservado/fencing,
      parâmetros centrais versionados e disconnect; criação desligada.
- [x] OLIST-T19: checkbox ortogonal, CAS/auditoria/revogação e entrada Olist
      com projeção mínima entre donos/perfis, incluindo Financeiro habilitado.
- [x] OLIST-T05: consultas oficiais fechadas, limites de corpo/paginação/tempo,
      quota compartilhada por conta e métodos de criação bloqueados.
- [x] Gate F2 local: conexão/ACL protegidas e geração desativada.

[RFC 050 — Fase 2](../../../docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md#fase-2-dados-habilitação-e-conexão),
[evidências/handoff](../../../docs/integrations/olist/phase2-implementation.md) e
[operação/rollback](../../../docs/runbooks/olist-phase2.md).
Implementação no [commit 6a79cc8a](https://github.com/romulosutil/crm-silmer/commit/6a79cc8aecc3111dbfad5b8b14220f3b3df860aa),
com push confirmado em `codex/olist-phase2`. `npm run validate` aprovado:
1.779 testes/15 skips explícitos; SQL Olist 36/36 sem skips; E2E completo
485 aprovados/7 skips previstos; auditoria sem altas/críticas.

Sem deploy, chamadas autenticadas ao ERP ou habilitação de conta real.
Homologação da conexão/proxy/imagem e piloto continuam nos gates posteriores.
Próxima fronteira: Fase 3, começando por T20/T21 e suas integrações de
persistência, legado/loja e completude; o núcleo T20a/T21a não fecha essas tarefas.
Este é o checkpoint da Fase 2; os registros datados abaixo
preservam o estado observado em cada entrega anterior.

## OLIST-T02/T06a — Escopo de centavos exatos (05/11/2026)

- [x] Registrar redução de escopo aprovada na [ADR 062](../../../docs/adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) / [RFC 046](../../../docs/rfc/046-olist-escopo-inicial-de-centavos-exatos.md).
- [x] Implementar bloqueio fracionário e conferência exata por identidade de linha no núcleo Orders.
- [x] Validar negativos offline e preparar prova C05–C07, até três pedidos/R$ 5,20, 14 GETs, sem retry.
- [x] Executar prova API e tela na conta autorizada; T02/F1 fechados somente para o subconjunto exact-cent-v1.

O bloqueio não altera subtotais negociados nem a validade do CRM. Controles de
API/persistência/ACL/piloto continuam nas tarefas próprias. A prova real C05–C07 foi concluída após recuperar a aba: três pedidos
abertos, 14 GETs, três POSTs, R$ 5,20, valores por linha/totais e marcadores
consistentes. [Evidência](../../../docs/integrations/olist/evidence/exact-cent-proof-result.json).
Coletor encerrado. T03 pode iniciar, sem liberação de piloto/produção.

Os checkpoints datados abaixo são históricos, anteriores ao fechamento restrito.

## OLIST-T02 — Prova de capacidades em andamento (04/11/2026)

Status parcial: schema oficial 3.1/OpenAPI 3.0.0 com hashes e captura
reproduzível; fixtures sintéticas e 11 testes offline aprovados. PO autorizou
consultas na conta operacional e preparo do caso controlado para aprovação
antes de qualquer criação. Novo login permitiu completar 36 observações UI:
automações fiscais/estoque, expedição, reserva e webhooks. Gestão de Aplicativos
instalada gratuitamente após aprovação; formulário de app inspecionado sem
salvar. [Proposta de acesso somente leitura](../../../docs/integrations/olist/read-only-access.md)
e coletor local preparados com 17 testes offline. App/conexão v3 aguardam
aprovação; cadastro fiscal, precisão e efeitos reais pendentes. Gate F1 aberto.
[Evidência](../../../docs/integrations/olist/capabilities.md) e
[caso controlado](../../../docs/integrations/olist/controlled-case.md).
Zero chamadas autenticadas v3, cadastros/vendas ou credenciais criadas; T02 aberta.

## COB-DEL-01 — Cobranças InfinitePay (05/11/2026)

Protótipo aprovado pelo proprietário; execução autorizada após avaliação.
Contrato [COB-01–16](../order-billing/spec.md), RFC 049 / ADR 058. Entrega
vertical e gate operacional separados em [tasks](../order-billing/tasks.md).
Status e evidências de implementação/ativação são mantidos nessa fronteira.

## COB-T00 — Proposta de cobrança InfinitePay (05/11/2026)

PAY-01–05 diferidos, FIN-01–03, FINQ-01–19 e PRV-01–03.
Demanda: cobranças para pedidos existentes com 0%, X% ou 100%, Pix e cartão,
incluindo parcelamento pela InfinitePay no pagamento integral.

- [x] Investigar checkout da loja e confirmar fontes atuais após o grafo.
- [x] Consolidar definições do proprietário e revisão de confiabilidade/QA
      na [RFC 049](../../../docs/rfc/049-cobrancas-do-pedido-com-infinitepay.md).
- [x] Decidir a RFC e publicar contratos/ADR antes da implementação COB-T01–05.

Análise concluída e sucedida por COB-DEL-01 acima. Ativação real permanece
no gate COB-OPS-01.

## OPS-INBOX-SEND-09 — Mídia reservada após timeout HTTP (05/11/2026)

MSG-02/03, ORC-08, PRV-01 e OPS-ERR-03/06/08/10. Os dois alertas de
08:54 eram um comando humano: o timeout HTTP antecedeu o preflight da mídia;
o workflow não alcançou o nó de envio.

- [x] Permitir leitura/preflight pela execução originalmente reservada por
      até cinco minutos da reserva, somente após `N8N_COMMAND_TIMEOUT`, sem
      ID externo ou recibo de transporte incerto e com todos os fences atuais.
- [x] Aceitar falha pré-envio tardia autenticada de mídia e reconciliar fila
      sem retry, preservando tentativas e histórico; excluir de Ativas apenas
      falha comprovada com reconciliação encerrada.
- [x] Preservar conclusão incerta tardia do transporte e impedir que trigger
      ou recovery sobrescrevam falha conclusiva; migration expand 0054.
- [x] Gates locais e revisão QA; regressões PostgreSQL sintéticas fazem parte
      do CI obrigatório da entrega.

Gate operacional de fechamento: CI PostgreSQL, migration 0054, publicação,
reconciliação do original com prova técnica auditada, Ativas/Histórico e health.
Evidências de execução ficam na PR da entrega; sem repetir a execução ou
enviar ao cliente.

[Diagnóstico, limites e rollback](../../../docs/runbooks/inbox-delivery-feedback.md#timeout-durante-preparação-de-mídia--05112026).

## OPS-INBOX-SEND-09V — Recuperação autorizada e conferência (05/11/2026)

MSG-02/03, ORC-08, PRV-01 e OPS-ERR-03/06/08/10.

- [x] Preservar os originais e criar operações separadas, auditadas e com
      chaves novas; upload/validação normais da mídia; restaurar responsáveis.
- [x] Confirmar release com a correção, migration 0054, readiness, jobs
      concluídos e painel ativo sem ocorrências.
- [x] Registrar imagem recuperada lida e texto enviado, ainda sem recibo de
      entrega na última consulta; não repetir o texto enquanto aguarda.
- [x] Registrar a falha da deduplicação: a foto já tinha chegado sem legenda;
      exigir imagem+legenda iguais permitiu repeti-la. Atualizar o
      [runbook](../../../docs/runbooks/inbox-delivery-feedback.md) para bloquear
      mídia já entregue independentemente da legenda e tratar variantes do
      provedor de forma conservadora. Sem nova mudança de aplicação.

## INBOX-UX-06 — Filtros no topo e paridade local/produção (05/11/2026)

PCX-18a–d, PCX-14/15/17 e UX-FUNC-01. Autorização explícita do proprietário:
publicar os filtros preferidos do local sobre a versão atual de produção e,
ao final, alinhar o local. Sem API, migration, dependência ou infraestrutura nova.

- [x] Preservar alterações locais anteriores em stash identificado e partir
      de `origin/master`, mantendo a branch anterior recuperável.
- [x] Repor barra horizontal Atender / Fechar pedidos / Todas, botão textual
      Filtros e folha com aplicação consciente, descarte e retorno do foco.
- [x] Preservar Todas padrão, urgência, cursores/paginação, busca, expansão,
      rascunhos e correções atuais de produção.
- [x] Executar gates completos, E2E/axe, revisão visual e QA independente.
- [ ] Commit/push atômico, CI, publicação e conferência do build público.
- [ ] Alinhar checkout/build local à revisão publicada, conferir servidor e
      registrar separadamente as limitações de dados/integrações locais.

Contrato e operação: [inbox-prioridades](../../../docs/runbooks/inbox-prioridades.md).

Evidência pré-publicação: Node 24.20.0/npm 11.19.0; `npm run validate` com
1.717 aprovados/12 ignorados e build. E2E completo: 497 aprovados/7 ignorados,
um timeout de áudio Firefox e uma decisão de sugestão parcialmente recortada
após mover a barra. O orçamento vertical foi corrigido sem relaxar o teste;
42 regressões posteriores passaram, incluindo os dois cenários. Inspeção
visual em 320/390/1366 px claro/escuro, sem overflow, e axe dos filtros
aprovados; detector sem achados e QA independente sem P1/P2. Auditoria:
zero alta/crítica, uma baixa e cinco moderadas preexistentes. O primeiro CI da
PR 293 passou integralmente: PostgreSQL, 499 E2E/7 ignorados e as duas imagens.
Uma integração concorrente de OPS-INBOX-SEND-09 exigiu rebase, preservando as
duas tarefas neste arquivo. O CI da revisão integrada, publicação e paridade
dos assets devem ser conferidos no fechamento da PR.

## OPS-INBOX-SEND-08 — Encerrar pendências sem duplicar envios (04/11/2026)

MSG-02/03, ORC-08, PRV-01 e OPS-ERR-03/06/08/10/11. Autorização do
proprietário no chat: investigar a IA, corrigir causas e conferir resultados
incertos antes de qualquer reenvio.

- [x] Identificar a reserva obsoleta da IA por nova revisão de entrada e
      preparar tratamento fechado de `STALE_AUTOMATION_FENCE`, sem retry.
- [x] Impedir envio humano de contas Meta DEV/sintéticas antes de criar
      mensagem, tomar atendimento ou enfileirar transporte; preservar rascunho.
- [x] Separar falhas conclusivas encerradas e disposições operacionais
      auditadas da projeção ativa, preservando resultados e histórico.
- [x] Executar gates completos, CI PostgreSQL e revisar casos negativos.
- [x] Publicar e verificar versões, health, workflow e preservação dos demais.
- [x] Aplicar os manifestos privados revisados, sem enviar mensagens, e
      conferir Ativas e Histórico da central.

[Diagnóstico, critérios e rollback](../../../docs/runbooks/inbox-delivery-feedback.md#encerramento-das-pendências-e-reserva-obsoleta-da-ia--04112026).

### OPS-INBOX-SEND-08V — Evidência operacional

- [x] Registrar CI 719 e release da PR 289, serviços saudáveis, principal n8n
      publicado com delta revisado e 42 outros workflows preservados.
- [x] Confirmar duas reconciliações e quatro disposições auditadas sem reenvio,
      resultados originais preservados, zero pendências ativas e quatro grupos
      históricos resolvidos pela interface autenticada.

## OPS-INBOX-SEND-07 — Resposta humana após confirmar pedido (04/11/2026)

MSG-02/03, ORC-08, INBOX-3 e INT-2. A reserva de resposta humana usa o comando
persistido e seu fence, independentemente de haver pedido pendente. O guard de
Assunto/Pedido permanece para respostas automáticas. Autoria, conteúdo, epoch,
revisão, estado e reserva de uso único continuam obrigatórios.

- [x] Isolar o guard comercial da reserva humana autenticada.
- [x] Cobrir pedido confirmado, autoria/conteúdo/epoch inválidos, briefing,
      reserva automática e replay com regressão PostgreSQL sintética.
- [x] Executar CI com PostgreSQL, gates completos e publicar a API corrigida.
- [x] Reconciliar individualmente as duas falhas anteriores à reserva e enviar
      somente as duas mensagens autorizadas por novas operações humanas.

[Diagnóstico e recuperação](../../../docs/runbooks/inbox-delivery-feedback.md#resposta-humana-após-confirmar-pedido--04112026).

### OPS-INBOX-SEND-07V — Evidência operacional

- [x] Registrar CI, imagem da API, health/readiness, reconciliação auditada,
      duas novas mensagens observadas e resposta natural do cliente, preservando
      a responsável original. As três tentativas das duas conversas adicionais
      têm reserva e incerteza no transporte; não integram essa recuperação.

## UX-FUNC-01 — Componentes com função explícita (04/11/2026)

[Contrato](spec.md#ux-func-01--componentes-com-função-explícita-04112026),
PCX-13/14/15, MSG-02/03 e PLI-09/10, sob ADRs 035/036. Autorização no chat.

- [x] Isolar rascunhos textuais e respostas assíncronas por conversa, sem storage.
- [x] Explicitar escolha única de filtros, remover por chip e recuperar vazios.
- [x] Diferenciar ações, seleção, status, hints e elevação nos componentes existentes.
- [x] Executar gates completos, E2E/axe, revisão visual claro/escuro e QA adversarial.
- [x] Preparar entrega atômica em `codex/componentes-funcionais`, com commit/push
      da fatia e preservação de alterações locais de outras tarefas.

Evidências locais: Node 24.20.0/npm 11.19.0; `npm run validate` com 1.690
aprovados, dez ignorados e build; E2E completo com 469 aprovados/sete ignorados;
após ajustes finais de apresentação e breakpoint, 59 regressões aprovadas.
Pedidos, filtros e Inbox em claro/escuro a 390/768/1440 px: 18 verificações axe
sem violações e sem overflow da página. Auditoria sem high/critical (um low e
oito moderate preexistentes). Revisão independente sem findings P1/P2.

Operação: rascunhos são temporários e saem com a instância da Inbox. Não há
API, migration ou configuração nova. Rollback é reverter a entrega de frontend;
mensagens aceitas pela API não devem ser reenviadas para testar apresentação.

## OLIST-T01 — Revisão do contrato da Fase 1 (04/11/2026)

- [x] Conferir ADR 057 e emendas canônicas, mapear OLIST-01–50, alocar donos
      por papel/tarefa e registrar gaps técnicos com gates e responsáveis.

[Evidência T01](../../../docs/integrations/olist/contract-review.md).
Tech Lead: Codex nesta execução. T02 e gate F1 continuam abertos; não há
runtime, habilitação real ou inclusão ERP nesta entrega.

## OLIST-PLAN-02 — Decisões Olist subtotal cancelamento e rótulos

- [x] Registrar decisões do proprietário na ADR 057 e reconciliar RFC 050,
      RULES, PRD/specs, arquitetura/TDD e índices sem implementar runtime.
- [x] Planejar OLIST-01–50, seis fases e OLIST-T01–T26, com subtotais por tamanho,
      checkbox por usuário, cadastros/variações e cancelamento CRM pré-exportação.
- [ ] Provar contrato T02, precisão por linha e dados fiscais/comerciais reais.
- [ ] Implementar checkbox/IDs/subtotal/legado/loja/cancelamento/cadastros/venda.
- [ ] Implementar rótulos e ficha v7 preservando versões anteriores; aprovar amostra.
- [ ] Validar e liberar piloto individual por ID privado; não habilitar conta no código.

[RFC 050](../../../docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md) /
[ADR 057](../../../docs/adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md).
Esta entrega registra produto e prepara execução, sem alterar usuários ou ERP.

## SIL-36 — Git reconciliado com a referência publicada (05/11/2026)

Manutenção de referência: ORC-03/05/08 e AGT-10; ADRs 050/052/056.
O proprietário definiu o publicado como fonte da verdade e autorizou somente
alinhamento Git e registro das funcionalidades extras no Linear.

- [x] Comparar publicado/rascunho/Git: 141 nós operacionais, sem diferença
      funcional no rascunho; oito posições e um parâmetro igual ao default.
- [x] Ler publicado em transação READ ONLY; sanitizar vínculos privados antes
      de transferir, com fingerprints calculados na origem e releitura final
      de versão/nós/conexões/settings inalterados.
- [x] Versionar o export publicado de 141 nós e seu manifesto como referência
      operacional; preservar os 29 artefatos anteriores de ops/n8n byte a byte.
- [x] Registrar os deltas em SIL-8 e SIL-39–49, com código preservado,
      requisitos, nós afetados e critérios de aceite separados.
- [x] Validar fingerprints, privacidade, topologia e preservação; revisão
      independente sem achados pendentes e entrega em branch própria.
- [x] Confirmar captura/reprodução nativas em Firefox e Chromium na imagem
      Linux fixada do Playwright: dois testes aprovados, sem skips ou
      alteração de assertions; preparo de áudio sintético igual ao CI.

Validação após rebase sobre a master: `npm run validate` com 1.757 aprovados, 16 ignorados,
nenhuma falha e build; 12 testes focados aprovados após a correção do header
técnico SHA256. A pendência Firefox foi encerrada em 06/11 na cópia Linux
isolada do commit do PR, com Node 24.20.0/npm 11.19.0 e dispositivo sintético.
E2E integral final: 505 aprovados, sete skips legados, zero falhas e nenhum
retry consumido; a política de dois retries é a já configurada para CI.
Procedimento em [áudio local](../../../docs/runbooks/playwright-audio-local.md)
e resultado integral na [validação do PR](../workflow-reference/validation.md).
O WinError 14001/SideBySide de `mozglue` continua sendo uma limitação do
executável nativo Windows, não uma homologação de microfone físico.
Auditoria sem vulnerabilidades high/critical. Nenhum teste foi removido ou
enfraquecido. Commit/push da entrega incluem este registro;
integração na master e deploy não pertencem à autorização desta tarefa.

[Referência e pendências](../../../ops/n8n/workflows/README.md).
O candidato Meta/SDK e os testes continuam preparados para evolução; isso
não comprova publicação dos extras. Nenhuma importação, ativação, execução
de workflow ou mudança de produção pertence a esta tarefa. Checkboxes
históricos de implementação não substituem o estado operacional registrado
nessa referência nem encerram as pendências separadas.

## AGENTE-OBS-03 — Turnos por versão no workflow vivo (04/11/2026)

AGT-06/10 e ORC-03/05, sob a ADR 052.
[Causa, procedimento e rollback](../../../docs/runbooks/agente-turnos-versao.md).

- [x] Conferir API, persistência e agrupamento; export vivo confirma ausência
      da telemetria nos seis nós anteriores à VND-L03.
- [x] Preparar overlay mínimo com hashes revisados; preservar programas,
      transporte, reservas, abertura humana, conexões, credenciais e retenção.
- [x] Corrigir gerador Evolution para preservar versão da jornada e rejeitar
      fonte sem versão inequívoca; manter override explícito.
- [x] Gates locais/QA: validate com 1.706 testes aprovados/10 ignorados e
      build; E2E com 460 aprovados/7 ignorados e um timeout de áudio que
      passou isoladamente; 29 regressões específicas e revisão final aprovadas.
- [x] Publicar revisão `dff49439-56db-43d2-ae2e-1bebe8a0214e`; conferir
      export exato do candidato e registro no painel: 1 turno/1 transferência
      da versão sintética `qa-agente-obs-03-turns-1`, sem aviso ou envio externo.
- Próximos atendimentos reais medem `evolution-baileys-1-turns-1`;
  canário comprova coleta, não evolução comercial. Sem backfill.
- Commit/push e evidências operacionais registrados no handoff da entrega.

## INBOX-UX-05 — Todas por urgência, filtros opcionais (04/11/2026)

PCX-17a–f emenda a entrada padrão de PCX-15a. UI abre o universo não arquivado
por urgência; as filas pessoais permanecem filtros explícitos. Sem migration,
nova dependência, infraestrutura ou mudança nos comandos comerciais.

- [x] Entrada Todas, filtros opcionais, links explícitos e ordem oficial.
- [x] Botões refinados com seleção identificável, contagens alinhadas e temas.
- [x] Ordenação antes da paginação, cursor assinado por ordem/filtro/ator,
      total global e contratos anteriores preservados.
- [x] Ver mais conversas, falha/retry, corrida de filtro e foco por teclado.
- [x] Gates locais, revisão, commit e push atômicos.
- [ ] CI e publicação verificadas no alvo antes de declarar implantação.

Evidência local: validate aprovado (1.690 testes, 10 ignorados), suíte E2E
completa com 484 aprovados/7 ignorados; depois da correção de recuperação,
os 21 cenários de prioridades/paginação passaram. Auditoria sem alta/crítica,
detector sem achados e revisão independente sem bloqueantes. O teste real
PostgreSQL novo será executado no CI; não há banco/ferramenta local disponível.

Contrato e operação em [inbox-prioridades](../../../docs/runbooks/inbox-prioridades.md).

## INBOX-UX-04 — refinamento aprovado da Caixa (04/11/2026)

PCX-16a–h, PCX-14/15 e OA-03–10/12. Implementação autorizada após a revisão
visual do protótipo V2 no chat. Vue, Router, tokens, contratos de API e
comandos oficiais permanecem; sem migration, dependência ou infraestrutura.

- [x] Filtros imediatos e ações ancoradas, com teclado, foco e fechamento
      externo; mesmas capacidades, parâmetros, confirmações e filas oficiais.
- [x] Sugestões fora da trilha, uma instância persistente por conversa,
      evidência/decisão visíveis e utilidades em Atendimento; feedback tardio
      acessível sem reabrir painel nem duplicar comandos.
- [x] Resumo compacto, cores semânticas, navegação por ícone e ampliação sem
      remontar histórico ou perder rascunho; composição responsiva.
- [x] Gates completos, revisão independente, commit e push atômicos.
- [ ] Conferir CI e SHA/health no ambiente implantado antes de afirmar
      publicação operacional; observar vendedores sem mutações reais de teste.

Evidência local: `npm run validate` (1.681 aprovados, 10 ignorados),
E2E completo (476 aprovados, 7 ignorados), 18 cenários focais e auditoria sem
alta/crítica. Revisão independente sem bloqueantes; conferência visual sintética
em claro/escuro, desktop, celular e 320 px. Detalhes no runbook.

Operação e rollback em [inbox-compacta](../../../docs/runbooks/inbox-compacta.md).

## VND-L05 — Triagem prioritária sem inferir regra comercial (06/11/2026)

AGT-01–05/08, ORC-03/05/07; RFC 051 / ADR 063, autorizadas pelo proprietário
após revisão da Inbox. Supersede somente continuação após dúvida de capacidade
e exigência de ficha completa para urgência hoje/amanhã. Sem catálogo novo.

- [x] Encaminhar dúvida de mínimo/viabilidade sem inventar resposta ou mínimo.
- [x] Preservar alternativas de quantidade sem escolher, somar ou sobrescrever.
- [x] Antecipar urgência inequívoca com ficha incompleta e preservar pendências.
- [x] Perguntar somente campos faltantes, preservando dados fora de ordem.
- [x] Preparar SDK/snapshots principal/DEV/local `mvp-simple-23` e regressões sintéticas.
- [x] Concluir revisão e gates de código: `npm run validate` (1.806 aprovados,
      19 ignorados), E2E/axe (505 aprovados, sete ignorados, sem falha ou retry),
      39 testes da triagem/patch e diff check. Referência publicada SIL-36 intacta;
      quatro fingerprints candidatos atualizados com proveniência explícita.
- [x] Preparar entrega atômica na branch `codex/vendedor-triagem-prioritaria`;
      commit e push registrados no handoff.
- [ ] Executar auditoria npm: revisão automática bloqueou envio de metadados
      das dependências ao registro externo; aguarda autorização do proprietário.
- [ ] Publicar delta sobre export vivo Evolution, com backup/comparação e
      observação, sem importar snapshot inteiro nem reativar bot humano.

Operação e limites no [runbook](../../../docs/runbooks/vendedor-prioridades.md).

## VND-L04 — Revisão dos atendimentos de 03/11/2026

AGT-01–06/10, ORC-03/05/07 e INB-02; correções nas ADRs 024/049/051/052/056.
[Amostra, achados e propostas comerciais](../../../docs/integrations/n8n/revisao-2026-11-03.md).

- [x] Revisar as 35 conversas exibidas; identificar 16 comerciais com atividade
      no dia, sem guardar transcrições, nomes ou identificadores de clientes.
- [x] Preparar `mvp-simple-22`: saudação só com dados faltantes, pergunta
      contextual de imagem, filtro de elogios e handoff sem promessa imediata.
- [x] Cobrir regressões sintéticas e preservar preço, prazo, mínimo, epoch,
      reservas, origem da arte e abertura humana; gerar snapshots DEV/local.
- [x] Gate local e revisão QA sem achados pendentes: 103 testes focados,
      `npm run validate` (1.689 aprovados, 10 ignorados), E2E/axe
      (461 aprovados, 7 ignorados) e auditoria sem altas/críticas.
- Commit/push e PR da preparação registrados no handoff desta entrega.
- [ ] Publicação como delta sobre o workflow Evolution vivo, com backup,
      comparação e observação real; investigar ausência de turnos por versão.

Triagem comercial, mínimo, urgência antecipada e coleta por item são propostas
para decisão, não alterações de regra aprovadas por esta revisão.

## OA-T01 — Abertura assistida de pedidos (03/11/2026)

Implementação autorizada pelo proprietário: [OA-01–12](../order-assistance/spec.md),
[entrega e gates](../order-assistance/tasks.md), RFC 043 / ADR 056.
Substitui abertura automática por confirmação humana, com observação durante
atendimento humano e avaliação de sugestões e omissões. Publicação mantém
GitHub → EasyPanel; [runbook](../../../docs/runbooks/order-assistance.md).

## INBOX-UX-03 — conversa compacta e mídia na Inbox (03/11/2026)

INBOX-4, PCX-10/12/13/15, CP-07..10, IMG-12/13 e MED-01..03/09..13/16/19/25.
Layout e simplificação dos botões de imagens autorizados pelo proprietário
após revisão do protótipo clicável no chat. A emenda de apresentação fica em
[pedidos-mvp](../pedidos-mvp/spec.md) e os fluxos, limites e rollback no
[runbook](../../../docs/runbooks/inbox-compacta.md). Preserva Vue 3, tokens,
fila/prioridades de INBOX-UX-02, permissões, pedidos e infraestrutura.

- [x] Integrar compositor único com anexar, cotar frete, gravar e enviar por
      ícones nomeados; reduzir avatares/ícones sem reduzir alvos de teclado e
      toque; manter dicas sob demanda e estados de indisponibilidade visíveis.
- [x] Abrir cadastro pelo nome, manter atendimento sobreposto à conversa e
      organizar pedido, assuntos e resumo sem duplicar formulários visíveis.
- [x] Simplificar imagens com miniatura clicável, ampliação, baixar e anexar
      ao pedido por ações compactas; abrir seleção/confirmação do alvo somente
      sob demanda, preservando ACL, bytes originais e retry idempotente.
- [x] Apresentar áudio com reprodução, posição e volume reais; preservar a
      transcrição automática em Atendimento › Resumo › Transcrições automáticas
      e as falhas, sem onda sonora fictícia ou rótulos redundantes de mídia/autor.
- [x] Expor `hasPendingOrder` na lista e no detalhe, incluindo pendentes
      vinculados por qualquer Assunto, e exigir confirmação consciente no
      encerramento. Preservar o guard transacional, o status dos pedidos e a
      independência de arquivar; conflito 409 não autoriza aceite automático.
- [x] Gates locais com Node 24.20.0/npm 11.19.0: `npm run validate`
      (1.631 aprovados, oito skips), E2E/axe completo (450 aprovados, sete
      skips), auditoria sem high/critical (um low e oito moderate
      preexistentes), revisão independente sem bloqueantes e diff check limpo.
- [ ] Executar cenários PostgreSQL reais de pedido direto, pendente apenas por
      Assunto e vínculo confirmado no banco sintético dedicado/CI; registrar
      eventual indisponibilidade local sem tratá-la como aceite live.
      Localmente PostgreSQL/Docker e TEST_DATABASE_URL não estão disponíveis;
      o cenário foi incluído na suíte PostgreSQL serial do CI.
- [x] Preparar entrega atômica em `codex/inbox-mobile-first`, preservando
      alterações locais de outras tarefas. Commit e push seguem o protocolo
      1:1:1:1; CI e cenários PostgreSQL são gates antes da integração.
- [ ] Conferir SHA/health e layout no ambiente implantado e observar o uso
      por vendedores em notebook. Não enviar ou encerrar atendimentos reais
      somente para validar apresentação.

## INBOX-UX-02 — prioridades do vendedor e alertas (03/11/2026)

PCX-15a–f, PCX-03/04/13/14 e AGT-03/05. Proposta revisada e implementação
autorizada pelo proprietário após validação sintética no chat. Não altera
transporte n8n, confirmação comercial, ACL de escrita ou infraestrutura.

- [x] Validar cenários sintéticos de assumir, responder, prontidão oficial,
      espera, outro vendedor, automação e falhas antes da integração visual.
- [x] Implementar projeções oficiais, filtros globais/contagens e cursores
      vinculados ao ator, preservando queries existentes sem workQueue.
- [x] Cards com identificação/espera/próxima ação; motivo e responsável no
      chat, registro unsupported expansível e tomada humana no cabeçalho.
- [x] Gates locais: Node 24.20.0/npm 11.19.0; validate com 1.629 aprovados,
      oito skips; E2E/axe completo com 434 aprovados, sete skips; auditoria
      sem high/critical (um low e oito moderate preexistentes), diff check
      limpo e revisão independente sem bloqueantes. PostgreSQL indisponível
      localmente; a suíte real foi incluída no gate serial do CI.
- [x] Entrega atômica preparada em codex/inbox-seller-priorities, preservando
      alterações locais de outras tarefas. Commit e push seguem o protocolo
      1:1:1:1; o CI PostgreSQL é gate de integração.
- [ ] Conferir ambiente implantado e observar vendedores reais. O teste
      sintético não comprova produtividade real nem corrige a causa do handoff
      unsupported no workflow. Operação e rollback no
      [runbook](../../../docs/runbooks/inbox-prioridades.md).

## OPS-ERR-T01 — Saúde e erros (02/11/2026)

Requisitos OPS-ERR-01–08, PRV-01 e INT-2/3; decisão do proprietário na
[ADR 055](../../../docs/adr/055-central-de-erros-restrita-a-conta-operadora.md),
[RFC 042](../../../docs/rfc/042-central-de-saude-e-erros.md) e
[runbook](../../../docs/runbooks/saude-erros.md). Relacionada à issue #11,
sem substituir os gates de monitor externo.

- [x] Menu e rota exclusivos da conta operadora designada; API valida a
      identidade atual, sem ampliar acesso aos demais administradores.
- [x] Ocorrências persistentes e agrupadas, códigos sem PII, ingestão
      deduplicada de falhas de jobs/n8n e captura de 5xx da API.
- [x] Triagem versionada, idempotente, auditada e com histórico; recorrência
      reabre o grupo e nenhuma ação repete o efeito de origem.
- [x] Gates locais: `npm run validate` (1.621 aprovados, oito ignorados),
      E2E/axe completo (423 aprovados, sete ignorados), auditoria sem high ou
      critical e `git diff --check`. Node 24.20.0/npm 11.19.0; testes com
      subprocessos/navegador precisaram de execução fora do sandbox Windows.
      Revisão independente sem findings abertos.
- [x] Entrega atômica preparada na branch `codex/health-errors-admin`.
- [ ] Executar a suíte PostgreSQL real no CI (incluída no gate serial),
      sem banco dedicado disponível nesta máquina. Ela cobre migração,
      concorrência, rollback de auditoria, ACL atual, retenção e recriação.
- [ ] Aplicar migration expand e conferir a tela no ambiente implantado.

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

- [ ] **OPS-INBOX-SEND-06 — recusa de destinatário sem novo envio incerto**
      (MSG-02/03, ORC-08, PRV-01, EVOL-01D / INT-2–3).
      Consulta autenticada do destinatário depois da reserva humana e antes de
      texto/mídia; resposta inequívoca libera o destino original. Recusa,
      indisponibilidade ou formato inesperado concluem falha sem retry, com
      motivo visível e ACK de rejeição. Callback tardio e fila exigem recibos
      da mesma reserva, preservando estados conclusivos e incerteza posterior
      ao transporte. Gates: contrato/SQL sintético, negativos, replay,
      teclado/axe, CI, publicação e acompanhamento natural. Não reenviar nem
      reclassificar os três comandos históricos pela consulta atual.
      [Diagnóstico e rollout](../../../docs/runbooks/inbox-delivery-feedback.md#destinatário-não-reconhecido--04112026).

- [ ] **OPS-INBOX-ACK-05 — corrigir correlação de recibos Evolution com LID**
      (EVOL-01D, ORC-05/08, MSG-01–03, PRV-01 / INT-2–3).
      Correção publicada em 03/11 no principal de 113 nós: ACK consulta ID
      exato e direção outbound na mesma instância e aceita somente um registro
      com telefone válido, sem criar alias de identidade inbound. Duplicatas,
      identidade própria e alternativas contraditórias continuam bloqueadas.
      Diagnóstico usa motivos controlados, sem payload/stack. Gates locais:
      validate (1.650 aprovados, nove skips), E2E/axe (455 aprovados, sete skips),
      observabilidade (15 aprovados), audit sem high/critical e revisão independente.
      Os 40 demais workflows foram preservados. Falta observar recibo novo
      natural no fluxo completo; nenhum envio ou callback histórico é repetido.
      Comando Evolution antigo permanece incerto/em análise e os 12 WAHA
      permanecem arquivados operacionalmente. [Evidências e limites](../../../docs/runbooks/evolution-baileys.md#recibos-com-lid--03112026).

- [ ] **OPS-INBOX-ACK-04 — arquivar triagem WAHA e esclarecer falhas atuais**
      (OPS-ERR-03–09, MSG-02–03, ORC-08, AGENTE-OBS-01 / INT-2–3).
      Arquivamento operacional autenticado, auditado e idempotente dos comandos
      WAHA com manifesto conferido, sem alterar resultados incertos ou repetir
      envios. Manter Evolution em análise; separar fontes atuais de ocorrências
      históricas e mostrar recorrência recente de workflow.failed no desempenho.
      Diagnosticar o workflow publicado com códigos controlados, sem payloads.
      Gates: SQL sintético, ACL/conflitos/replay, teclado/axe, CI, migration,
      publicação e verificação dos 12 registros reais e da pendência Evolution.

- [x] **OPS-INBOX-ACK-02 — reconciliar fila após confirmação tardia**
      (MSG-02–03, ORC-08, INBOX-3 / INT-2). O poll conclui somente jobs n8n
      incertos com comando/mensagem sent, mesmo ID externo e evento
      autenticado message.sent. Fecha o item de reconciliação sem alterar
      tentativas ou reexecutar envio; prova ausente preserva a pendência.
      Cenários de concorrência, locks e replay para banco sintético dedicado;
      publicação e conferência dos registros reais são gates operacionais.
      [Diagnóstico e operação](../../../docs/runbooks/inbox-delivery-feedback.md#reconciliação-da-fila-após-confirmação-tardia--03112026).

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

## Vendedor mensurável e com mais contexto — 30/10/2026

Estado: implementado, aguardando implantação. Decisão ADR 052/RFC 041.
Nenhum campo novo do contrato é obrigatório, e o workflow VND-L02 publicado
continua funcionando com o CRM novo. Implantação em três etapas: PR só das
migrações 0046–0048 (merge, deploy e aplicação no console), depois PR do
código, depois a publicação do n8n
([runbook](../../../docs/runbooks/vendedor-l03-implantacao.md)). O código lê
colunas da 0048 no inbound; subir a API antes da migração perderia mensagens.
Teste com PostgreSQL real: `node --test --test-concurrency=1 test/vendedor-evolucao-postgres-live.test.js`.

Revisão da PR #257 (31/10/2026, AGENTE-FAIL-01 / AGT-09): comprovante tardio
de entrega ou leitura reconcilia o envio para `sent`, limpa a falha e evita
handoff indevido pela varredura. Callback de falha posterior não regride a
entrega comprovada. A suíte live do Vendedor integra o gate PostgreSQL
serializado do CI, incluindo essa regressão.

- [x] **AGENTE-FAIL-01 — falha do bot vira handoff** (AGT-05, AGT-09, ORC-08).
      Erro do modelo, do parser, do agente ou da decisão vira
      `handoff.requested` com `automation_failure` e aviso fixo. O worker roda
      `automation.stall.sweep` a cada 60 s
      (`ASSISTANT_STALL_SWEEP_INTERVAL_MS`) e transfere a conversa cuja
      revisão de entrada mais recente não teve resposta efetiva (não
      consumida, ou consumida por resposta `failed`, `outcome_unknown` ou
      presa em `sending` há mais de 2 minutos), com a última mensagem do
      cliente das últimas 24 h e mais antiga que `ASSISTANT_STALL_MINUTES`
      (padrão 5, 2..60 com clamp). Epoch novo, histórico e auditoria, sem
      aviso ao cliente. Lote resiliente por candidato, com log
      `automation_stall_sweep_completed`. O cartão do painel inicial usa a
      mesma regra e a mesma env (antes, 10 minutos fixos).
- [x] **AGENTE-OBS-01 — telemetria por turno** (AGT-06, AGT-10). `turn`
      estrito em `message.send.requested` e `handoff.requested`, com
      `ficha_filled` e `ficha_total` obrigatórios; chave desconhecida dá
      `400`. Linha única por evento em `crm.automation_turns` (0047). Painel
      "Desempenho do agente" (`/dashboard/agente`, só administrador, ação
      `assistant.performance.read`) com agregados de 1 a 90 dias e `null` sem
      amostra; `stale_fence` contado pela auditoria. Nenhum texto do cliente,
      nome ou telefone.
- [x] **AGENTE-OBS-02 — leitura e atualização do desempenho** (AGT-06,
      AGT-10, AGENTE-OBS-01). Distinguir conexão ativa da última consulta
      bem-sucedida; atualização manual, por eventos agrupados e a cada 60 s
      enquanto a página está visível. Preservar resposta/janela/horário em
      falha e foco nas atualizações de fundo. Explicar os universos de
      respostas, transferências e eventos de falha; sinalizar atividade sem
      turnos por versão sem diagnosticar a causa. Investigação inicial e
      consultas agregadas sem PII no
      [runbook do desempenho](../../../docs/runbooks/desempenho-agente.md).
      Publicação ativa e causa dos eventos remotos continuam pendentes de
      consulta ao ambiente; testes locais não encerram esses gates.
- [x] **INBOX-HANDOFF-02 — handoff completo** (AGT-03, ORC-07). Encerrar a
      conversa resolve o handoff ativo na mesma transação, com
      `conversation_closed` no histórico. `requested_seller_id` fora dos
      Vendedores ativos é ignorado e auditado (`PREFERRED_SELLER_NOT_ACTIVE`),
      sem falhar o handoff; o id segue `^[A-Za-z0-9_-]{1,128}$`. A lista da
      Inbox mostra `handoff.preferredSellerFirstName` e o detalhe devolve
      `preferred_seller`.
      Motivo `partnership` aceito (0046). O handoff continua sem dono e o claim
      continua atômico.
- [x] **INBOX-AUDIO-TRANSCRIPT-01 — transcrição no CRM** (AGT-01, MSG-01).
      `message.transcribed` só para áudio de entrada da conversa, pelo
      `external_message_id`; idempotente; `failed` pode virar `ok`, e `ok` não
      é substituído (`409 TRANSCRIPT_ALREADY_RECORDED`). Texto cifrado com a
      chave das mensagens (0048). A Inbox mostra a transcrição abaixo do áudio
      e o histórico do agente traz `transcribed: true`.
- [x] **VND-CTX-01 — mais contexto** (AGT-01). `subject_ids` em cada item de
      `recent_messages`, sem zerar o histórico com vários Assuntos.
      `contact_context` só com `previous_cycles`, `previous_orders_count`
      (0..99, sem teste nem os desta conversa) e `last_closed_at`; lista de
      pedidos e desfecho saíram por minimização (RULES 8 e 13). O prompt
      recebe só "Cliente recorrente: já foi atendido pela Silmer antes."
- [x] **INBOX-DELIVERY-02 — código de falha do bot** (MSG-02). `failure.code`
      em `message.failed` e `message.send.unknown`; ausente ou fora do padrão
      vira `SEND_FAILED` ou `SEND_OUTCOME_UNKNOWN`. Um `sent` ou `delivered`
      posterior limpa o código. A Inbox explica o código nas mensagens do bot,
      inclusive `META_SEND_OUTCOME_UNKNOWN`.
- [x] **VND-L03 — workflow `mvp-simple-20`** (AGT-02..05, AGT-09..10).
      Consome os itens acima, com 5 nós novos (95 no total), e só envia os
      campos novos quando o inbound traz `contact_context`; contra CRM antigo
      volta ao modo da `mvp-simple-19`. Modelo 30 s com um retry,
      transcrição 30 s; pior caso de cerca de 112 s, dentro dos 120 s. Menos
      falsos positivos (e-mail ou telefone do próprio cliente, link de
      referência, "loja" sozinha, fotos das peças, "Sim" fora da pergunta da
      arte, "faixa etária", "jogo" sozinho, "passei pelo instagram",
      "respondo pelo celular"); pedido repetido transfere ("igual da última
      vez"). Sem "Ótima pergunta!" no aviso de preço e com feriados nacionais
      de 2026–2027 no aviso de horário (sem ES nem municipais). Teste: `test/n8n-vendedor-l03.test.js`.
- [x] **DOC-VND-03 — documentação.** RFC 041, ADR 052, gate OpenAI (DPA e ZDR
      informados em 30/10/2026), drift e contrato no README do n8n e runbook
      de implantação.
- [ ] PR das migrações: merge, deploy e 0046–0048 com `applied_count` 3.
- [ ] PR do código: merge e deploy; worker com `N8N_INTEGRATION_ENVELOPE_KEY`
      e `automation_stall_sweep_completed` no log.
- [ ] Smoke da API e do painel; VND-L02 segue respondendo.
- [ ] Publicar `mvp-simple-20` como delta sobre o export vivo, autorizado pelo
      proprietário; rollback `cd0de4e8`.
- [ ] Observar as primeiras conversas reais pelo painel.

Fora desta rodada: catálogo para o agente (RFC própria) e agente com
ferramentas.

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

## OPS-HEALTH-T01 — Sinais e healthcheck operacional (05/11/2026)

Implementação e gates em [operational-health](../operational-health/tasks.md).
OPSH-01–05, OPS-ERR-03/04/08, ADR060, RFC045 e issue11.
Coleta permanece manual; expurgo diário14dias autorizado pelo proprietário.

## OLIST-PLAN-01 — Preparação da integração Olist (04/11/2026)

- [x] Preparar especificação completa com requisitos OLIST-01–32, seis fases,
      tarefas OLIST-T01–T18, testes negativos, recuperação e checklists na
      [RFC 050](../../../docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md).
- [x] Revisar decisões de produto na ADR 057/RFC 050 revisão 2 (OLIST-PLAN-02).
- [ ] Provar contratos técnicos de cadastros/precisão e preencher parâmetros reais.
- [ ] Implementar e validar OLIST-T01–T15 e T19–T26 conforme gates da RFC revisada.
- [ ] Autorizar/executar piloto e decidir ampliação em OLIST-T16–T18.

A proposta original foi revisada pela OLIST-PLAN-02/ADR 057. Produto decidido;
contratos técnicos, implementação, conexão real e ativação continuam pendentes.
