# Proteção de envio publicada, cobranças desligadas

BREL-06/04, BAPI-07/09/10, tarefa T5. Conferência em09/11/2026,
America/Sao_Paulo. Autorização: concluir proteção e preparar ativação coordenada,
mantendo envios desligados e avisando antes de teste com pagamento real.

## Publicação observada

Workflow humano: `k7tI6T4RhQPyJkn9`.
Versão publicada: `9157724a-1493-4d85-91f7-582af4d73a1c`, nome
“Proteção de cobrança — flags desligadas”, às23:06:25 de09/11.

Após publicar, o editor foi recarregado e mostrou Published. A seleção da
versão publicada no histórico abriu `/history/9157724a-1493-4d85-91f7-582af4d73a1c`.
O export após publicação tem esse UUID, active=true e144nós. Isso publica
a guarda do atendimento; não habilita emissão ou envio de cobranças no CRM.

Versão anterior publicada, preservada no histórico:
`7b78d0b9-80e0-41b5-a5ae-e4ff52cd96b3`, de06/11 às16:27:52.
O backup privado anterior à edição foi reexportado da instância atual.

## Mudança delimitada

O marcador de cobrança vem do comando humano já reservado. Texto comum
mantém o caminho anterior. Cobrança passa por GET de preflight no CRM,
com Basic e contexto da execução preservados; somente `valid:true` booleano
autoriza seguir ao envio reservado. Resposta inválida, HTTP com erro,
timeout ou falha na validação seguem à conclusão autenticada de falha
`before_message_send`, sem envio ou retry automático do efeito.

Acrescentados três nós: Texto humano e cobranca?, CRM - Preflight cobranca
reservada e Validar preflight de cobranca. O HTTP tem timeout10s, sem retry,
redirect desligado e resposta JSON. O export omite o método GET padrão do
n8n; isso foi a única normalização funcionalmente equivalente admitida.

Comparação independente com o candidato gerado pelo patch do repositório:

- Todos os141nós originais exatamente iguais, incluindo IDs, parâmetros, credenciais e posições.
- Três novos nós iguais ao candidato após normalizar apenas IDs/posições atribuídos pelo editor e GET padrão omitido no novo HTTP.
- Conexões exatamente iguais ao candidato: cinco arestas normais e duas de erro adicionadas; uma ligação direta removida.
- Identidade do workflow, webhooks, settings e referências de credencial preservados. A única diferença adicional de metadados é versionId, gerado pelo salvamento.
- Código, fase e destino da conclusão de falha anterior ao envio permanecem iguais aos do workflow original.

Nenhum JSON remoto foi versionado. A alteração foi revisada no rascunho
antes da publicação e novamente no export após publicar. Não se importou
o workflow inteiro sobre o atendimento nem se recriaram seus nós originais.

## Verificação e limites

Revisão independente billing_release_verifier:24/24 testes focais aprovados,
zero skips, cobrindo patch/workflow, contrato HTTP do preflight e wiring.
Sensor do comparador:6/6 mutações perigosas recusadas — bypass direto,
erro de validação→envio, erro HTTP→envio, valor truthy em vez de true,
retry habilitado e método POST. Exports originais permaneceram intactos.

Esses resultados verificam estrutura e contratos; não são execução completa
da nova rota no engine n8n em produção. Não se clicou Execute nem se enviou
checkout, pagamento ou mensagem de teste. Execuções normais do atendimento
preexistente não foram usadas como homologação de cobrança.

## Estado depois da publicação

API NodePID8 e worker NodePID7 foram conferidos antes/depois da publicação.
ORDER_BILLING_ENABLED, ORDER_BILLING_CHAT_SEND_ENABLED e
ORDER_BILLING_RECEIVE_ENABLED permanecem explicitamentefalse em ambos.
Não houve alteração de ambiente, novo deploy da aplicação ou migração nesta
etapa. API/worker permanecem nas instâncias da release87cbc435.

- API live200 e ready200; edge healthz200.
- Migrações expand71/71, última0075, zero divergências.
- Charges, payments, refunds, send_intents, external_receipts e payment_checks: zero registros.
- Outbox com job_type `billing.%`: nenhum registro; heartbeat observado com8s.
- Workflows financeiros YI75ZEo33RsVbW4r e t5wxOAz2c8OUl9Hf continuam activefalse, com19 e11nós. Exports finais mantêm nós/conexões/settings exatamente iguais aos candidatos já vinculados às credenciais.
- Loja e demais ramos do atendimento preservados. Não foi feita chamada à InfinitePay.

## Evidência privada

Em `var/billing-activation-preparation/`, ignorado pelo Git:

- human-before.json, human-candidate.json, human-published.json e human-published-version.jpg.
- independent-human-review.json, independent-published-review-verifier.json e independent-published-sensor.json.
- api-flags-before-publish.jpg, worker-flags-before-publish.jpg, api-flags-health-after-publish.jpg e worker-flags-after-publish.jpg.
- database-after-publish.jpg, issue-inactive-final.json, check-inactive-final.json e financial-inactive-review.json.

A proteção está publicada. Publicação dos workflows financeiros, ativação
coordenada e ensaio real continuam etapas separadas. O proprietário deve
ser avisado antes do teste e autorizar seu valor, pedido/destinatário e efeitos.
