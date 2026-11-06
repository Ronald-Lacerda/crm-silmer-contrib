# Cobranças InfinitePay — entrega

Contrato [COB-01–16](spec.md), RFC 049 / ADR 058.

## COB-DEL-01 — Implementar o fluxo aprovado

Entrega vertical atômica, com um commit/push. T01–04 da RFC são fronteiras
da implementação integrada; T05 distingue gates locais da ativação real.

- [x] Protótipo avaliado e implementação autorizada pelo proprietário.
- [x] COB-T01: ADR, contrato e fontes canônicas.
- [x] COB-T02: migração, ACL, saldo, quitação e recuperação.
- [x] COB-T03: fila/worker, reserva e workflow n8n importável.
- [x] COB-T04: pedido, revisão, compartilhamento e conciliação.
- [x] COB-T05 local: gates, PostgreSQL sintético, E2E/axe e QA independente.
- [x] Commit/push atômicos e limites operacionais documentados.

Evidências locais em Node 24.20.0/npm 11.19.0: `npm run validate` com
1.760 aprovados e 13 skips; nove suítes PostgreSQL 17 sintético serializadas
com 69/69 aprovados, incluindo concorrência com a loja e UUIDs em caixa
diferente; E2E completo com 520 aprovados e sete skips. A revisão independente
de segurança encerrou sem achados após corrigir repetição com resposta perdida;
a revisão de interface conferiu desktop, 390/320 px, claro/escuro, foco,
anúncios de atualização e alvos de 44 px. Detector sem achados. Auditoria sem
alta/crítica, mantendo uma baixa e cinco moderadas preexistentes. Nenhuma
dependência adicionada. Export/expressões n8n verificados com dados sintéticos.
Após o ajuste final de feedback, `validate` repetido com sucesso e os 11 E2E
de cobranças aprovados novamente; revisão final de interface com decisão ship.

## COB-REV-01 — Revisar a jornada da Inbox e do Pedido

COB-12/13, MSG-02/03, PCX-13 e UX-FUNC-01; revisão do proprietário em
05/11/2026. Evidências e limitações no
[relatório](../../../docs/qa/order-billing-journey-2026-11-05.md).

- [x] Comparar checkout do site e verificar a jornada com avaliações independentes.
- [x] Estabilizar o alvo Enviar no toque durante a saída do campo.
- [x] Preservar rascunhos na navegação Inbox → Pedido → Inbox, com descarte
      no reload/saída/troca de sessão, sem conteúdo em armazenamento persistente.
- [x] Bloquear compartilhamento normal em revisão, incerteza, reabertura,
      validade vencida ou leitura desatualizada; conservar conferência explícita.
- [x] Gates integrados, revisão final, commit e push das correções.

Gates: validate com 1.760 aprovados/13 skips; E2E completo com 534 aprovados/
sete skips, mais 16 cenários finais do Pedido. Typecheck/lint/format/diff check,
detector sem achados e revisão independente sem pendências. Esta fatia não
altera backend, migração, produção ou workflows remotos.

## COB-CHAT-01 — Novo fluxo solicitado: gerar e enviar na conversa

Proposta em [RFC 047](../../../docs/rfc/047-enviar-cobranca-pela-conversa.md).
O proprietário escolheu link direto no chat com Pix e cartão; não QR Pix.
Protótipo atualizado precede a implementação desta orquestração.

- [ ] Avaliar protótipo de Enviar cobrança no chat/pedido e revisão do destino/valor.
- [ ] Decidir contrato/ADR e implementar intenção transacional, mensagem única,
      guardas no enfileiramento/reserva e retorno real do transporte.
- [ ] Cobrir concorrência, falhas, conversa alterada e operação por teclado/toque.

Esta proposta não é a capacidade de envio do runtime entregue em COB-DEL-01,
que ainda depende do compartilhamento manual. Dashboard foi retirado do foco
desta fatia e sua entrega paralela deve ser preservada.

Pendências preservadas para fatias próprias:

- [ ] COB-DASH-01: integrar o saldo à nova central enquanto houver valor a
      receber até a quitação, sem lembretes automáticos ao cliente; foco diferido
      expressamente pelo proprietário para priorizar Inbox e Pedido.
- [ ] COB-STORE-01: decidir/corrigir a divergência entre cartão habilitado no
      checkout da loja e domínio CRM limitado a Pix, preservando pagamentos.

## COB-OPS-01 — Ativação e homologação reais

- [ ] Aplicar migração 0055 antes de habilitar código.
- [ ] Conferir conta/credenciais, workflow privado, URLs e flags.
- [ ] Observar pagamento real autorizado, duplicidade e recuperação;
      preservar taxas e conferir devolução do teste.
- [ ] Rollback mantém callbacks dos links emitidos.

Gates locais não comprovam conta remota, deploy ou pagamento real. Evidências
e passo a passo no [runbook](../../../docs/runbooks/order-billing.md).
