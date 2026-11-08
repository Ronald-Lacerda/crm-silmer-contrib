# Integração do backend — COB-CHAT-B04

API e worker compõem o serviço PostgreSQL e o transporte existente para
BAPI-01–10. Frontend permanece adiado, sem alteração de arquivos de interface.
Implementação local concluída; operação real exige COB-OPS-01.

## Configuração e recuperação

`ORDER_BILLING_CHAT_SEND_ENABLED` é estrita, inicialmente ausente/false e
inventariada junto às flags existentes. True exige emissão financeira,
banco, autorização operacional e outbox funcional. API registra intenção e
histórico quando o recebimento está disponível, mantendo escrita fechada no
rollback. Serviços injetados são encapsulados sem mutação e com métodos
vinculados ao receiver original. Worker também exige ambas as flags para
encaminhar cobranças, mantendo envios comuns independentes.

Rotas do preflight de texto não dependem da ativação de mídia. Autorização
técnica e prova da execução original antecedem o envio. Callbacks financeiros
continuam disponíveis quando novas emissões/envios estão desabilitados.
Runbook contém migrações 0063/0064, preparação offline do workflow, ordem de
ativação futura e rollback sem apagar histórico/links/envelopes.

## Gates

- Integração de servidor/rotas/flags: 8/8 em
  `test/order-billing-chat-wiring.test.js`.
- `npm run validate`: 1.801 aprovados, 17 skips condicionais, zero falhas;
  inclui format, typecheck, lint, fronteiras, topologia/inventários e build.
- Matriz PostgreSQL sintética: 86 cenários distintos aprovados, abrangendo
  composição, idempotência, saldo/correção, financeiro, Inbox, n8n, migrações
  e loja. Detalhamento no [QA de transporte](order-billing-chat-transport-2026-11-06.md).
- Correção COB-CHAT-B05: a suíte de transporte passou de 13 para 15 cenários,
  cobrindo invalidação única da Inbox, payload privado e rollback/reentrega
  quando o evento falha. Total atualizado: 88 cenários PostgreSQL distintos.
- `git diff --check` e validação estrutural das tarefas passaram. O validador
  avisa que não interpretou o diagrama legado; dependências conferidas:
  T1 → T2 → T3 → T4 → T5.
- Revisões independentes Backend/QA e de transporte encerradas sem achado
  bloqueante depois das correções descritas no QA de transporte.

Verificação independente final aprovada após B05: 15/15 PostgreSQL na nova
rodada e seis falhas semânticas detectadas pelos testes em cópias isoladas.
Evidências em [validação](../../.specs/features/order-billing/validation.md).
O relatório restringe o parecer ao backend B01–B04; não aprova frontend,
redesign, deploy ou pagamentos reais.

Nenhuma flag habilitada, workflow publicado ou chamada real de cobrança/envio.
