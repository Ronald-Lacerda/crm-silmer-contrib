# Sobre o CRM Silmer

O CRM Silmer é um produto web próprio para organizar conversas comerciais, qualificação, vendas e geração de Fichas de Pedido. Ele substitui integralmente o Datacrazy.

O fluxo começa quando uma mensagem válida do cliente dispara automaticamente um workflow no n8n. O n8n é o motor obrigatório da jornada: integra os canais, executa o Vendedor Silmer, coleta dados, sugere internamente a abertura após intenção de fechamento e transfere para uma pessoa quando necessário. A criação do pedido de atendimento é humana (ADR 056); a análise continua no atendimento humano sem retomar o bot. Não existe botão da interface para iniciar essa automação.

O MVP é organizado em três objetivos que evoluem em paralelo e se conectam no lançamento:

1. **CRM:** fonte oficial dos dados, regras, permissões, estados, auditoria, pedidos e relatórios.
2. **Inbox Multicanal:** visão operacional das conversas, mensagens, pendências e tomada humana.
3. **Agente Vendedor Silmer no n8n:** integração WhatsApp, IA, orquestração da jornada, atualizações comerciais e handoff.

O n8n nunca acessa diretamente o banco. Toda mutação oficial passa pela API idempotente e autorizada do CRM; a interface observa o fluxo e permite intervenção humana, mas não o dispara.

O primeiro MVP operacional usa WhatsApp Business. Instagram Direct é a próxima
fase de canal e reutilizará a mesma jornada. Quando essa fase chegar, o
atendimento poderá migrar entre canais preservando o Contato somente após
correlação verificável entre `@instagram` e telefone. O artefato central do
domínio é `ficha_exemplo.xlsx`: os dados
necessários para produzir e cobrar um pedido orientam as perguntas e validações. A baseline vigente é Pedido com dois status, técnica por item, arte do pedido e impressão v6 com público por item (ADRs 006, 020 e 025); assinatura física e homologação permanecem gates de produção.

Documentos principais:

- `README.md`: porta de entrada, estado atual e ordem de leitura.
- `AGENTS.md`: protocolo, papéis e Definition of Done para agentes.
- `CODEX.md`: contexto inicial e guardrails específicos do Codex.
- `CONTRIBUTING.md`: fluxo de contribuição, validação e publicação.
- `CRM-MVP-ESPECIFICACAO.md`: PRD e escopo canônico.
- `.specs/features/crm-mvp/spec.md`: requisitos rastreáveis e critérios de aceite.
- `.specs/features/crm-mvp/context.md`: decisões de produto já tomadas.
- `PRODUCT-READINESS-TECH-LEAD.md`: gate de passagem para especificação técnica.
- `CAMPOS-FICHA-E-JORNADA-P0-1.md`: inventário integral da Ficha, etapas
  definitivas, gates, PIX e boas-vindas.
- `RULES.md`: invariantes de produto e implementação.
- `ARCHITECTURE.md`: resumo das fronteiras e decisões técnicas propostas como baseline.
- `docs/adr/`: decisões arquiteturais tomadas, imutáveis e numeradas.
- `docs/rfc/`: propostas relevantes em avaliação antes da decisão.
- `docs/integrations/n8n/README.md`: contrato v1, entidades, estados,
  configuração, rollout e troubleshooting da integração.
- `docs/roadmap/PROXIMAS-FASES.md`: ordem das próximas telas e do Instagram,
  critérios de aceite e mapa dos documentos que guiam as próximas telas.
- `docs/roadmap/BACKLOG-POS-GO-LIVE.md`: evoluções planejadas após o go-live;
  primeira demanda é upload e download de arquivos na Ficha do Pedido.
- `TECHNICAL-DESIGN.md`: TDD canônico com stack, módulos, dados, APIs,
  segurança, SLOs, riscos e decisões técnicas do MVP.
- `EASYPANEL-TOPOLOGY.md`: projetos, serviços, sizing, CI/CD, backups e
  operação na VPS Hostinger/EasyPanel.
- `docs/runbooks/rustfs-chat-media.md`: mídia enviada pelo vendedor preservada
  no RustFS, ativação local, quotas e gates de recovery.
- `docs/phase0/TRANSIENT-MEDIA.md`: mídia temporária por até sete dias,
  handoff do arquivo válido ao pedido no RustFS e diferimento do R2.
- `.specs/features/crm-mvp/tasks.md`: plano de implementação por fases com
  verificação e rastreabilidade.
- `historico-datacrazy/`: arquivo histórico, sem valor normativo para o sistema novo.

O documento externo de API foi inicialmente incorporado por RFC 001/ADR 002 e
depois simplificado por RFC 002/ADR 003: Basic only, CRM como fonte da verdade,
três endpoints, fence de envio incorporado à reserva e WhatsApp primeiro.

OpenAI é o provedor escolhido para produção ([ADR 021](docs/adr/021-adotar-openai-no-mvp.md)). O deploy continua automático GitHub → EasyPanel ([ADR 022](docs/adr/022-manter-deploy-automatico-github-easypanel.md)).
