# Desempenho do agente: leitura e diagnóstico

Requisitos AGT-06 e AGT-10; tarefas AGENTE-OBS-01 e AGENTE-OBS-02.
Decisão existente: [ADR 052](../adr/052-vendedor-mensuravel-e-com-mais-contexto.md).
Implantação: [VND-L03](vendedor-l03-implantacao.md).

## O que os números medem

O painel `/dashboard/agente` exige administrador e recebe somente agregados
de `GET /api/v1/inbox/assistant/performance`. Não expõe mensagens, nomes,
telefones ou identificadores de clientes. A janela usa `(from, to]`.

| Indicador                    | Universo e limite                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversas com o agente       | Conversas distintas com resposta registrada, turno ou handoff identificado como automação na janela. Não é o total de entradas recebidas.                                                       |
| Respostas                    | Mensagens criadas como assistente na janela, inclusive em envio, falha ou resultado incerto. Não comprova entrega.                                                                              |
| Transferências               | Registros de handoff criados na janela, de todos os motivos. Não são conversas distintas nem exclusivamente transferências iniciadas pelo bot.                                                  |
| Paradas agora                | Situação atual segundo a regra de espera do worker; não é uma contagem histórica da janela.                                                                                                     |
| Ficha na transferência       | Turnos `handoff.requested` com total de campos maior que zero. Sem turno válido, não há amostra.                                                                                                |
| Tempo até assumir            | Primeira aceitação dos handoffs criados na janela; percentis calculados somente com amostras aceitas.                                                                                           |
| Tempo até resolver           | Handoffs criados na janela com `resolved_at`. Sem amostras não significa que nenhuma conversa foi encerrada.                                                                                    |
| Eventos de falha do workflow | Linhas aceitas de `workflow.failed` por horário de processamento, inclusive falhas globais, abertura de pedido e caminhos de envio humano. Não é taxa de erro nem execuções ou clientes únicos. |
| Versões do workflow          | Agrupamento de turnos persistidos por versão. Ausência de versões não comprova ausência de atendimento.                                                                                         |

Replay com a mesma chave idempotente não cria outro evento. Chaves diferentes
podem representar falhas da mesma execução; não dividir o total de falhas pelo
total de conversas para calcular uma taxa.

## Atualização e falhas de consulta

A tela consulta ao abrir, ao trocar o período, por Atualizar, após eventos da
Inbox agrupados e a cada 60 segundos enquanto está visível. Ao voltar para a
aba, reconcilia novamente. Requisições de fundo não se sobrepõem; eventos
durante uma consulta agendam uma leitura posterior. Sair cancela consulta,
timers e listener de visibilidade.

O horário de São Paulo mostrado em Última consulta só muda depois de uma
resposta bem-sucedida. Conexão ativa no cabeçalho descreve o transporte de
eventos, não a idade dos números. Em falha de atualização, os números, a janela
e o horário anteriores permanecem identificados. Nenhum erro vira zero.

Atividade sem linhas de versão produz o aviso Medição incompleta neste
período. É um sinal para verificar a coleta, não uma conclusão sobre o bot,
o modelo ou a versão publicada.

## Investigação inicial de 03/11/2026

Na consulta da página de 7 dias, foram observados 29 conversas, 137 respostas,
23 transferências, 706 eventos de falha e nenhuma versão exibida. Ficha e
tempo até resolver estavam sem amostras; tempo até assumir tinha 18 amostras.
São contagens observadas naquele instante, não um diagnóstico de produção.

O código confirmou os universos acima e a falta de recarga nessa tela antes
da AGENTE-OBS-02. A consulta de logs pelo conector EasyPanel retornou HTTP 400;
a navegação automatizada não permitiu concluir a inspeção do console.
Não foram executadas consultas no banco remoto nem verificada a versão
publicada do workflow. Nenhuma automação foi publicada, reexecutada ou alterada.

Hipótese a verificar: workflow anterior ao VND-L03 ou delta incompleto pode
não enviar `turn`. O gerador exige capacidade indicada por `contact_context`
e o instante inicial do turno. A API persiste telemetria somente com `turn`
e conversa. Não inferir a causa apenas pelo painel vazio.

## Consultas no console autorizado

Executar no banco CRM com sessão somente leitura, limite de tempo e janela
explícita. Usar o mesmo `from`/`to` do painel para comparação exata. Os exemplos
usam os últimos sete dias apenas para triagem. Não selecionar payloads,
envelopes, nomes, mensagens, telefones ou IDs em resultados compartilhados.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL TIME ZONE 'America/Sao_Paulo';

SELECT coalesce(outcome->>'failureCode', 'WORKFLOW_FAILED') AS code,
       count(*) AS events,
       count(DISTINCT (workflow_key, execution_id))
         FILTER (WHERE execution_id IS NOT NULL) AS identified_executions,
       count(DISTINCT conversation_id) AS conversations,
       count(*) FILTER (WHERE conversation_id IS NULL) AS without_conversation,
       min(processed_at)::date AS first_day,
       max(processed_at)::date AS last_day
FROM crm.n8n_events
WHERE event_type = 'workflow.failed'
  AND processed_at > now() - interval '7 days'
  AND processed_at <= now()
GROUP BY 1
ORDER BY 2 DESC;

SELECT event_type, count(*) AS turns,
       count(*) FILTER (WHERE ficha_total > 0) AS with_ficha
FROM crm.automation_turns
WHERE occurred_at > now() - interval '7 days'
  AND occurred_at <= now()
GROUP BY event_type;

SELECT e.event_type, count(*) AS accepted_events,
       count(t.id) AS with_turn_telemetry
FROM crm.n8n_events e
LEFT JOIN crm.automation_turns t ON t.n8n_event_id = e.id
WHERE e.event_type IN ('message.send.requested', 'handoff.requested')
  AND e.conversation_id IS NOT NULL
  AND e.occurred_at > now() - interval '7 days'
  AND e.occurred_at <= now()
GROUP BY e.event_type;

ROLLBACK;
```

`failureCode` é normalizado pela persistência. Uma execução pode contribuir
com mais de um evento. Confirmar a distribuição e o período antes de chamar
706 eventos de 706 execuções ou de incidente ainda ativo.

Se eventos aceitos existem sem turnos, conferir no export vivo somente os
metadados necessários: versão ativa, envio de `turn`, preservação de
`contact_context` e do instante inicial. Seguir o runbook VND-L03 para preparar
um delta; não importar o snapshot do repositório sobre o fluxo Evolution vivo.
Não fazer replay de envios nem publicar alterações como parte da consulta.

## Validação e reversão

Unitários: `node --test test/assistant-performance.test.js`.
Interface: `npx playwright test test/e2e/assistant-performance.spec.js`.
Os cenários incluem recarga manual e automática, falha preservando dados,
troca de janela, ausência de amostras, teclado, mobile, axe e recusa ao vendedor.
Executar também os gates gerais do repositório.

Evidência local de 03/11/2026 sobre `master`, Node 24.20.0/npm 11.19.0:
`npm run validate` aprovado (1.613 testes, 7 ignorados). E2E completo: 415
aprovados, 7 ignorados e um timeout de gravação de áudio no Firefox; esse
cenário passou na reexecução isolada (6,8 s). Os 9 cenários da tela passaram
na suíte completa. `git diff --check` aprovado.
Auditoria no nível alto aprovada; a árvore existente tem 9 ocorrências
baixas/moderadas. Esses resultados não validam a coleta remota nem a produção.

A mudança é restrita ao frontend e não tem migração. Para reverter, publicar
o bundle anterior; dados, eventos e workflow permanecem preservados.
