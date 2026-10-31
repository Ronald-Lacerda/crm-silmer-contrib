# Próximas fases — prontidão do CRM Silmer

> **Atualizado em:** 10/10/2026\
> **Fila canônica:** `.specs/features/crm-mvp/tasks.md`

Inbox, Handoffs, Clientes, usuários, Pedidos e Dashboard já estão implementados.
A PR 142 incorpora técnica por item e origem da arte; a ficha vigente é v6
com público por item (ADR 025). Arte no RustFS, chat do site e loja paga
foram incorporados à baseline (ADRs 023, 026, 027 e 028). A próxima fase
é homologar a operação e demonstrar prontidão de produção.

Kanban e Negócio estão aposentados (ADR 004); Pedido possui dois status e
confirmação humana (ADR 006). Handoff e takeover não retornam à IA (ADR 015).
Aprovação provisória da v6 para desenvolvimento não substitui assinatura
física de Rose e Operação.

## Ordem de trabalho

| Ordem | Frente                 | Evidência para concluir                                                                                      | Tarefa               |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| 1     | Baseline de lançamento | Docs/IDs coerentes com ADR 020 e PR 142; sem tarefas de telas já entregues tratadas como futuro              | OPS-DOC-01           |
| 2     | Pipeline               | Build e publicação de imagens verdes; SHA/digest verificável                                                 | OPS-CI-01 / INT-3    |
| 3     | EasyPanel atual        | Deploy automático, domínio/HTTPS, rede privada, health, segredos e rollback checados no ambiente             | OPS-CHK-01 / INT-3   |
| 4     | OpenAI                 | Provedor único documentado; DPA e ZDR informados em 30/10/2026; retenção e logging aprovados antes de PII    | OPS-AI-01 / AGENTE-3 |
| 5     | WhatsApp real          | Duas credenciais distintas; versão ativa e jornada com mensagens/resposta humana, handoff e takeover         | OPS-1 / INT-1..2     |
| 6     | Recuperação e alertas  | Backups externos dos bancos, chave n8n recuperável, tombstones, restore e monitor externo com drills         | CRM-4 / INT-3        |
| 7     | Pedido e ficha         | Jornada por teclado, ACL negativa, dados fora de ordem, geração/reabertura, v6 e assinatura física           | CRM-1..3 / INT-4     |
| 8     | Arquivos e Rose        | Procedimento durável dos arquivos e encaminhamento acordados com Operação; automação só com contrato próprio | ORD-03..04 / INT-4   |
| 9     | Lançamento controlado  | UAT, smoke, carga aprovada, release identificada e rollback/recovery demonstrados                            | INT-4                |

Frentes 1–4 podem avançar em paralelo preservando posse dos arquivos. Cada
gate registra o que foi testado e o que ainda depende do ambiente ou de pessoa.

## Caminho de homologação

1. Checar a versão compatível do CRM no EasyPanel antes de publicar workflow.
2. Rodar smoke sintético em DEV, com `message`, `handoff`, `send_unknown` e
   `delivery_status`, identificadores inéditos e sem PII em evidências.
3. Homologar WhatsApp oficial: inbound, IA, resposta humana, status, replay,
   claim concorrente e takeover durante resposta.
4. Completar Pedido com técnica em cada item, arte do pedido, entrega
   prometida, valor e condição; gerar por dono/admin, imprimir e reabrir.
5. Verificar sinais do Dashboard e cliente sem resposta; eventos preservam
   rascunho e foco. Não usar tempo parado como probabilidade de venda.
6. Registrar gates de operação, privacidade e ficha assinada antes do go-live.

## Evoluções posteriores

- `CANAL-2`: Instagram com adapter, identidades separadas até correlação
  verificável e auditável, preservando Contato e histórico.
- PAY-01..05: cobrança PIX, comprovante estruturado e boas-vindas automáticas,
  diferidos pela ADR 006. Datas manuais não implementam esse fluxo.
- Arquivos da arte no RustFS chegam com a ADR 023; provisionar o serviço e
  evidenciar o backup do bucket antes da produção. Aviso automático a Rose
  exige fluxo e contrato próprios; não presumir integração ativa.
- Painel operacional de reconciliação só quando o uso justificar.
- Recebimentos/saldo, escala por queue/Redis e
  produção completa dependem de escopo e decisões futuros.

## Fontes de trabalho

`RULES.md`, `.specs/features/crm-mvp/spec.md`, PRD, TDD, OpenAPI e tasks
mantêm a precedência do AGENTS. Para Pedido, usar também
`.specs/features/pedidos-mvp/spec.md`, tarefas vigentes e ADRs 019/020/025.
Mídia enviada pelo vendedor tem plano e gates próprios em
`.specs/features/inbox-media-rustfs/tasks.md`; não aplicar seu prazo de
retenção ao runtime transitório legado nem presumir captura física ou
privacidade n8n homologadas pela evidência DEV.
Contratos executáveis e rollout ficam em `docs/integrations/n8n/README.md`;
ambiente alvo em `EASYPANEL-TOPOLOGY.md`. Evidências antigas não comprovam
configuração atual ou aprovação de produção.
