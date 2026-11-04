# Turnos do agente por versão — AGENTE-OBS-03

Requisitos: AGT-06/10, ORC-03/05 e ADR 052. Correção operacional de
04/11/2026; não muda coleta, pedidos, mensagens, handoff ou infraestrutura.

## Causa observada

O export publicado `b4407864-c649-4b23-b59b-5baf7aa31ac9` contém 133 nós.
Os preparadores de inbound, contexto, decisão, reserva e handoffs não têm
`received_at`, `turn_started_at`, `crm_evolution` ou envio de `turn`.
São os nós anteriores à telemetria VND-L03, preservados pela implantação
parcial da abertura assistida. Ter cabeçalhos novos no observador OA não
atualiza os outros caminhos do workflow.

O CRM devolve `contact_context` no inbound, aceita `turn` em reserva/handoff
e persiste uma linha por evento na mesma transação. O painel consulta
`crm.automation_turns` por `workflow_version`. Mensagem registrada sem o
objeto `turn` não gera essa linha. Não foi encontrado defeito nessa consulta.

Além disso, o gerador Evolution substituía a versão da jornada por
`evolution-baileys-1`. Agora conserva a versão literal do inbound da fonte;
fonte sem versão ou ambígua exige correção ou override explícito. Uma
versão já perdida em um export histórico não pode ser recuperada por inferência.

## Correção mínima

`ops/n8n/patch-turn-telemetry.mjs` prepara um delta sobre o export vivo:

- Horário de recebimento no preparador inbound.
- Capacidade do CRM, início e tipo da mídia no contexto.
- Horário da decisão e ponto perguntado no normalizador.
- Telemetria permitida nas reservas e nos handoffs da IA/conteúdo.
- Cabeçalhos dos dois nós que enviam esses turnos (reserva IA e handoff)
  com a release `evolution-baileys-1-turns-1`.

O modelo vem do nó vivo; não é inferido da versão do código. Conteúdo que
não passa pelo modelo registra `model: null` e ficha `0/0`, sem inventar
preenchimento. Um CRM antigo sem `contact_context` continua sem receber
campos desconhecidos. Só códigos, contagens e tempos entram em `turn`.

O patch verifica hashes dos seis nós revisados, rejeita drift, duplicidade,
alvo diferente e dados fixados. Reaplicar o mesmo patch é idempotente.
Preserva integralmente os programas comerciais dentro dos wrappers, os
133 nós/IDs, conexões, credenciais, settings, retenção e ramo OA. Não importa
o snapshot Meta nem publica as melhorias comerciais da PR #280.

## Procedimento

1. Exportar o principal publicado e guardar backup privado fora do Git;
   registrar versão, hash e contagens. Não guardar execução ou cliente.
2. Executar `node ops/n8n/patch-turn-telemetry.mjs <backup> <candidato>`.
3. Conferir o delta: seis `jsCode` e cabeçalhos de versão; todo o resto
   deve ser igual. Executar regressões sintéticas e o gate do projeto.
4. Aplicar somente os seis campos `jsCode` e os dois cabeçalhos na revisão
   do mesmo workflow. **Import from file acrescenta nós ao canvas existente:**
   não usar esse recurso para substituir o principal. Antes de publicar,
   exportar de novo e comparar IDs, código, conexões e settings.
5. Publicar pelo mecanismo normal do n8n; confirmar a versão ativa e os
   seis nós após recarregar.
6. Verificar um turno novo com dados sintéticos pelo caminho do CRM,
   sem envio a cliente; conferir versão, modelo, ficha e ausência de PII.
   Conferir o agregado em `/dashboard/agente`. Evidência de teste não é
   resultado comercial nem amostra de melhoria de qualidade.

## Rollback e limites

Restaurar a revisão anterior pelo histórico do n8n. Ela já contém a barreira
humana da ADR 056 e o transporte Evolution. Nunca voltar a uma revisão
anterior à abertura assistida só para retirar a telemetria.

Não há migração nem backfill. As respostas antigas sem telemetria continuam
sem turnos; não recriar eventos ou reenviar reservas. Comparações começam
com a coleta verificada da nova release. O painel agregado de sete dias
ainda pode mostrar aviso de medição incompleta pelo histórico sem turnos.

## Publicação e evidência de 04/11/2026

- Principal publicado: revisão `dff49439-56db-43d2-ae2e-1bebe8a0214e`,
  **Turnos por versão — AGENTE-OBS-03**. Após abrir uma página nova, o n8n
  exibiu `Published` e a revisão correspondente no histórico. Os próximos
  turnos reais usam `evolution-baileys-1-turns-1`.
- O export conferido antes da publicação é idêntico ao candidato nos
  códigos, cabeçalhos, 133 nós, conexões e settings; só `versionId` difere.
  Reaplicar o preparador ao export conferido não altera a telemetria.
- Canário manual separado: workflow `Aja6LT4j5DO35pin`, não publicado,
  sete nós sem modelo, aviso ou transporte de saída. Reutiliza os códigos
  inbound/handoff de conteúdo publicados e as referências de credencial
  existentes. Identidade e texto explicitamente sintéticos, sem arquivo real.
  A API aceitou o handoff como novo em `2026-11-04T04:01:48.883Z`.
- O painel `/dashboard/agente` exibiu **`qa-agente-obs-03-turns-1` —
  1 turno · 1 transferência**. A versão QA distingue o canário dos atendimentos
  reais. Esse caminho registra modelo nulo/ficha 0/0 e comprova persistência
  e agrupamento; respostas e handoffs com modelo foram cobertos por VM e testes
  de contrato, sem enviar mensagem a cliente.
- Antes do sucesso, o canário recusou um documento sem metadado obrigatório
  e falhou no helper de teste por ausência de `structuredClone` no sandbox
  do n8n. Corrigidos somente os dados/helper do canário; a publicação principal
  não contém esse helper nem chama `structuredClone` em seus wrappers.
- `npm run validate`: 1.706 aprovados, 10 ignorados, zero falhas e build.
  `npm run test:e2e`: 460 aprovados, 7 ignorados; o cenário AbortError de áudio
  teve timeout ao localizar o botão e passou isoladamente (554 ms), sem patch
  de UI. As 29 regressões Evolution/overlay e a revisão final passaram.
  `git diff --check` limpo.

O histórico anterior segue sem turnos. O agregado pode deixar de mostrar
o aviso de ausência total após o canário; isso não completa a amostra antiga.
Comparar qualidade somente com atendimentos reais coletados após a publicação,
excluindo a versão QA. Nenhum backfill ou replay de envios foi executado.
