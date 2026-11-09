# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2

## Confirmed (load these at Specify/Design)

Corroborated across multiple features. Safe to apply as guidance.

_none_

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

### L-001 - Use fileURLToPath para passar scripts locais a processos Node no Windows.

- signal: `gate_fail` · recurrence: 1 feature(s) · scope: `test` · harmful: 0
- features: production-readiness
- evidence: .specs/features/production-readiness/validation.md:41 (test)
- last seen: 2026-10-06T00:58:49Z

### L-002 - Confirme tabelas nas migrations e rotas nos mounts atuais antes de atualizar a síntese técnica do CRM.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `docs` · harmful: 0
- features: production-readiness
- evidence: .specs/features/production-readiness/validation.md:112 (docs)
- last seen: 2026-10-06T00:58:50Z

### L-003 - Diferencie recusa conhecida de envio incerto na interface e preserve chave e payload originais ao repetir comandos.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `inbox-ui` · harmful: 0
- features: inbox-media-rustfs
- evidence: .specs/features/inbox-media-rustfs/validation-ux.md:74 (inbox-ui)
- last seen: 2026-10-07T01:19:31Z

### L-004 - Confirme a paridade dos arquivos da imagem construída com as fontes finais antes de atribuir benchmarks e smoke ao patch atual.

- signal: `gate_fail` · recurrence: 1 feature(s) · scope: `runtime-image` · harmful: 0
- features: inbox-media-rustfs
- evidence: .specs/features/inbox-media-rustfs/validation-clamd.md:48 (runtime-image)
- last seen: 2026-10-10T16:12:05Z

### L-005 - Nos testes de SHA256 de mídia, corrompa bytes mantendo o mesmo tamanho para não mascarar a verificação pelo limite de comprimento.

- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `media-integrity` · harmful: 0
- features: inbound-media-inbox
- evidence: .specs/features/inbound-media-inbox/validation.md:1 (media-integrity)
- last seen: 2026-10-29T01:15:36Z

### L-006 - Valide o retry de mídia desde unavailable ou quarantined até available, preservando retenção, inspeção e uma única cópia.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `transient-media` · harmful: 0
- features: inbound-media-inbox
- evidence: MSG-02: retry transitório em validation.md (transient-media)
- last seen: 2026-10-29T01:15:36Z

### L-007 - Na mídia recebida, serialize descoberta, scan e vínculo por mensagem e teste replays concorrentes; a fila de arquivos sozinha não protege o estado persistido.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `transient-media` · harmful: 0
- features: inbound-media-inbox
- evidence: MSG-01: concorrencia comprovada em .specs/features/inbound-media-inbox/validation.md (transient-media)
- last seen: 2026-10-29T01:35:27Z

### L-008 - Publique invalidação da conversa na mesma transação de toda mudança efetiva no estado de entrega da mensagem.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `inbox` · harmful: 0
- features: order-billing
- evidence: modules/n8n-integration/src/billing-send-guard.js:202 (inbox)
- last seen: 2026-11-06T04:38:09Z

### L-009 - Após conflito de versão, recarregue pedido e conversa e exija nova revisão explícita antes de criar outra chave de comando.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `billing` · harmful: 0
- features: order-billing-completion
- evidence: BFUI-05 (billing)
- last seen: 2026-11-09T01:18:44Z

### L-010 - A elegibilidade de reversão de recebimento externo depende da reversão registrada, não da validade de aplicação do crédito.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `billing` · harmful: 0
- features: order-billing-completion
- evidence: BFUI-04 (billing)
- last seen: 2026-11-09T01:18:44Z

### L-011 - Teste seleção financeira tanto com pedido diretamente vinculado à conversa quanto com pedido associado por assunto.

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `inbox` · harmful: 0
- features: order-billing-completion
- evidence: BFUI-01 (inbox)
- last seen: 2026-11-09T01:18:44Z

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
