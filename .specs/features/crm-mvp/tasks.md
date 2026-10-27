# CRM Silmer MVP — Plano de prontidão

## WAHA-01 — piloto autorizado da linha temporária

Decisão: [ADR 042](../../../docs/adr/042-piloto-whatsapp-waha-webjs.md).
Requisitos: ORC-01..08, INB-01 e MSG-01..04; fronteiras INBOX-2/3, AGENTE-6,
OPS-1 e INT-1/2. [Runbook e evidências](../../../docs/runbooks/waha-webjs.md).

- [x] WAHA-01A — preservar fonte e backup do workflow anterior.
- [x] WAHA-01B — instalar e validar WEBJS privado com persistência e autenticação.
- [x] WAHA-01C — adaptar, testar e salvar candidato inativo no n8n; smoke TEST
      autenticado sem efeito de domínio, sem substituir homologação real.
- [ ] WAHA-01D — ativar WhatsApp no celular, parear conta esperada e homologar
      entrada/resposta na Inbox, mídia, takeover, status e replay antes do cutover.
- [x] WAHA-01E — registrar evidências, checks e entrega atômica no Git.

O fluxo original permanece publicado durante a preparação. O piloto não recebe
cutover nem replay de comandos antigos antes do pareamento e das verificações.

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

| Etapa                      | Contrato ou capacidade                                           | Pendência                                                                        |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| AGENTE-1 — Runtime         | n8n com banco e criptografia próprios                            | Checar ambiente EasyPanel existente, editor protegido, backup e restauração      |
| AGENTE-2 — API             | Três endpoints, Basic, idempotência, correlação e epoch/revisão  | OPS-1 no ambiente real                                                           |
| AGENTE-3 — OpenAI          | Provedor escolhido; schema e regras determinísticas              | DPA, retenção, logging e ZDR aplicáveis da issue #5; escolha não prova aprovação |
| AGENTE-4 — Coleta e Pedido | Briefing progressivo, projeção e criação idempotente do pendente | Jornada real com dados fora de ordem, técnica e origem da arte                   |
| AGENTE-5 — Handoff         | Transferência e invalidar execuções antigas                      | Takeover durante resposta e claim concorrente                                    |
| AGENTE-6 — Operação        | Workflows e contratos versionados                                | Health, alertas, rotação, custo e runbooks no ambiente alvo                      |

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
| OPS-AI-01  | Escolher OpenAI e reconciliar baseline documental                        | ORC-06, PRV-01..03, AGENTE-3 / INT-3            | Decisão técnica registrada; privacidade externa pendente                                                                                  |

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
