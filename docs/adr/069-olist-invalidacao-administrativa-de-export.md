# ADR 069 — Olist: invalidação administrativa de export antes da venda

Data: 09/11/2026. Status: decisão técnica adotada para OLIST-T27, no escopo
autorizado da [ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md);
as decisões D1, D2 e D5 abaixo aguardam confirmação do proprietário. Decisor
técnico: Tech Lead. Proposta e acompanhamento: [RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md).
Requisitos OLIST-14, 17, 21, 26–28, 45–47 e OLIST-51; tarefa OLIST-T27 no
[plano](../../.specs/features/crm-mvp/tasks.md). Achado de origem: o alto de
liveness da revisão T14 no [runbook da fase 5](../runbooks/olist-phase5.md).
Sem issue/PR específica; implementação local na branch `codex/olist-liveness`.
Complementa a ADR 057 e a [ADR 068](068-cancelamento-local-terminal-pre-exportacao.md);
não as supersede. A ADR [070](070-olist-quota-com-espera-de-leitura-e-folga.md)
trata a outra metade do mesmo achado (quota).

## Contexto

Um export que para antes de qualquer venda (mudança de versão do Pedido, de
configuração ou de contato, `generation` da conexão trocada, autorização
revogada e reconcedida, quota) termina em estado que nenhum comando sai: o
Pedido fica preso ao export por causa de duas regras anteriores. A primeira é a
unicidade `(account_key, order_id)` em `olist_exports`, que torna a linha a
única operação possível do Pedido. A segunda é o lock comercial, que congela a
ficha enquanto existe operação não invalidada. O cancelamento local (ADR 068)
só serve quando o Pedido deve morrer; não resolve o Pedido que deve seguir e
ser exportado de novo com dados atuais.

Reabrir a mesma linha não é possível: snapshot, versão e `generation` são
imutáveis por trigger (`protect_olist_snapshot`), o job é único por export
(`unique(outbox_jobs.olist_export_id)`) e a referência da venda é
`CRM-<id>`. Reutilizar a linha significaria reutilizar uma referência que
talvez já tenha sido pesquisada no ERP.

## Decisão

1. **Comando local e síncrono.** `POST /api/v1/orders/:orderId/olist/invalidate`,
   corpo `{operationId, expectedVersion, reason}`, resposta 200 com recibo
   `{operationId, orderId, state: 'invalidated', version, replayed?}`. Nenhuma
   chamada HTTP ao ERP e nenhuma exigência de conexão saudável: funciona com
   `OLIST_CONNECTION_CHANGED` ou reconexão pendente, que são justamente causas
   comuns do problema. `operationId` é o ID do export e `expectedVersion` sua
   versão, ambos lidos do diagnóstico administrativo. O próprio diagnóstico
   (`GET .../olist/administration`) também é local: só lê o banco e revalida
   ator, sessão, ACL e versão de autorização sob lock, mas **não exige conexão
   saudável** (`reconnect_required`, token ausente, `exchange`/`refresh`
   em curso e outra `generation` não o impedem). Sem isso o botão "Invalidar"
   nunca apareceria justamente quando a conexão quebrada é a causa do impasse.
   Os comandos que fazem HTTP (`/reconcile`, vínculo, prévia) continuam
   exigindo conexão saudável.
2. **Autorização.** Nova ação `olist.invalidate`: somente Admin atual
   (Vendedor com `COMMERCIAL_ADMIN`), independente do checkbox Olist. A ação
   entra em `OLIST_ACTIONS` e o runtime de identidade real a aceita (a rota é
   escrita, não leitura operacional). Sessão, grants, checkbox e
   `authorization_version` são revalidados sob lock via `lockOlistActor`,
   inclusive no replay. Dez comandos por minuto, `strictBody`, idempotente por
   `Idempotency-Key`.
3. **Uma transação, ordem de locks existente.** Ator, conexão (`FOR SHARE`,
   só o lock), conversa (`FOR SHARE`), Pedido (`FOR UPDATE`), export
   (**`FOR NO KEY UPDATE`**), recursos do export (`FOR SHARE`, ordenados) e
   job (`FOR UPDATE`). A invalidação disputa com o worker pelo lock do export:
   quem o toma primeiro vence. O lock do export é `FOR NO KEY UPDATE` e não
   `FOR UPDATE` de propósito: ele continua conflitando com `FOR SHARE` e
   `FOR UPDATE` (guardas de despacho e resolução, triggers (a) e (c), cancelamento),
   então a corrida com a venda segue serializada, mas **não** conflita com o
   `FOR KEY SHARE` que o INSERT em `olist_events` (FK para o export) toma.
   Com `FOR UPDATE` havia um ciclo possível com o registro de resultado de
   recurso (`finishResult`: tentativa `FOR UPDATE`, UPDATE do recurso e só
   então o evento): a invalidação segurava o export e esperava o recurso, e o
   escritor, já com o recurso, esperava o export para inserir o evento. O teste
   de duas conexões reproduz o ciclo (`40P01`) com o lock antigo e passa com o
   novo; os testes de corrida com a venda e com o INSERT cru (trigger (c))
   continuam passando. Se a reserva da venda ou de um recurso vence, a
   invalidação é recusada; se a invalidação vence, `reserveSaleEffect` e
   `reserveResourceEffect` recebem `OLIST_EXPORT_UNAVAILABLE` sem efeito.
4. **Recusas, em ordem.** Pedido cancelado (`ORDER_CANCELLED`); export
   inexistente para o Pedido (`OLIST_EXPORT_UNAVAILABLE`); `operationId`
   desconhecido para um Pedido que já tem operações, ou `expectedVersion`
   divergente (`VERSION_CONFLICT`); estado fora de `queued`, `resolving` ou
   `ready`, `remote_id` ou `observed_sale_id` preenchidos, ou **qualquer**
   tentativa `stage='sale'` de qualquer desfecho (`OLIST_INVALIDATION_BLOCKED`);
   recurso do export `reserved` ou `uncertain`, ou tentativa de recurso
   `reserved` (sempre), ou tentativa `uncertain` **cujo recurso ainda não está
   `confirmed` com `remote_id`** (`OLIST_RESOURCE_RECONCILIATION_REQUIRED`);
   job `processing` com lease **vivo** (`locked_until >= agora`;
   `OLIST_EXPORT_IN_FLIGHT`). A tentativa `uncertain` é histórico imutável
   (trigger da 0068; `completeReadRequest` só reescreve tentativa `reserved`):
   depois que o `/reconcile` leva o **recurso** a `confirmed`, a tentativa
   antiga continua `uncertain` para sempre, então tratá-la como bloqueio
   tornaria a invalidação impossível. Não há risco de segundo POST: o
   resolvedor só despacha recurso `pending` sem nenhuma tentativa
   (`resource-resolver.js`, `dispatch`) e `reserveResourceEffect` recusa recurso
   fora de `pending` ou com qualquer tentativa anterior
   (`OLIST_EFFECT_ALREADY_RESERVED`/`OLIST_RESOURCE_RECONCILIATION_REQUIRED`);
   um recurso `confirmed` nunca é repostado. A mesma regra vale em
   `assertRetrySafe` (campos `resource_open` e `attempt_open`, testados
   separadamente). A regra da venda é mais estrita que a do
   cancelamento: uma tentativa rejeitada já indica que um POST saiu, e não se
   interpreta ausência de ID como ausência de efeito.
5. **Efeito.** O export vira `invalidated` com `last_error_code =
'OLIST_EXPORT_INVALIDATED'` e `version + 1`. O job `olist.export` em
   `pending`, `retry`, `dead_letter` ou `outcome_unknown` passa a `completed`,
   sem campos de lease (também o `processing` com lease vencido: o worker morreu
   e o job está órfão), e o item de reconciliação aberto do job é resolvido; o
   claim só pega `pending` e `retry`, então não há reentrega. Um recibo
   append-only (`olist_export_invalidations`) guarda ator, versão de
   autorização, versão esperada e o motivo **somente** em envelope AES-GCM com
   AAD próprio. Evento `OLIST_EXPORT_INVALIDATED` e auditoria
   `olist.invalidate` carregam códigos e IDs, nunca o motivo ou PII. Não há
   incremento de `orders.version`.
6. **Nova geração é nova linha.** A linha invalidada permanece como histórico
   e nunca volta a outro estado; a próxima prévia/exportação cria outro export,
   com outra referência. A migração 0071 troca a unicidade por
   `UNIQUE (account_key, order_id) WHERE state <> 'invalidated'`: passa a
   valer **uma operação ativa por Pedido/conta**. `unique(account_key, reference)`
   e `olist_exports_remote_key` permanecem. Os leitores que viram "somente
   ativo" são `findExport`, `prepareExport`, a consulta de operação existente
   da prévia, `operation()` administrativo e a projeção da API (esta última
   prefere a ativa e, na falta, mostra a invalidada mais recente); o UPDATE do
   cancelamento ganha `state <> 'invalidated'`, para não reescrever o arquivo.
7. **Defesa no banco (migração 0071, expand-only).** Três triggers:
   (a) o recibo só entra para export já `invalidated`, sem tentativa de venda e
   sem ID remoto ou observado; (b) `invalidated` é terminal para a linha (não
   sai para outro estado); (c) nenhuma tentativa `stage='sale'` entra em export
   `invalidated`, mesmo vinda de job antigo ou escritor direto. A inserção
   trava o export `FOR SHARE` antes de olhar o estado, então uma invalidação
   não commitada é aguardada e um único caminho vence.
8. **Cadastros e Pedido.** Nada do ERP é apagado e nenhum vínculo é removido.
   Recursos `confirmed` permanecem e o novo export os reaproveita por
   `identity_hash`. O lock comercial não muda: libera pela cláusula de estado
   (`invalidated`) e continua travando pela cláusula de tentativa de recurso
   quando já existe cadastro confirmado (D1).
9. **Interface, somente admin.** "Invalidar esta geração" ao lado de
   "Conferir" e "Vincular", visível quando `canOfferInvalidate` (sem venda
   tentada, sem recurso reservado ou incerto, estado `queued`, `resolving` ou
   `ready`); o servidor é a autoridade. Diálogo com motivo obrigatório de até
   1000 caracteres, foco previsível e a mesma chave de idempotência em reenvio
   idêntico. Depois do sucesso, o painel trata a geração invalidada por
   administrador como "sem operação ativa" e leva o foco a "Conferir prévia
   Olist".

## Decisões a confirmar pelo proprietário

- **D1.** O Pedido continua congelado para edição quando já há cadastro ERP
  confirmado (a cláusula 4 do lock comercial permanece). Nova prévia e nova
  exportação funcionam mesmo assim. Alternativa não adotada: liberar a edição
  também nesse caso, o que exigiria aceitar que o cadastro confirmado deixe de
  refletir a ficha.
- **D2.** Só Admin invalida: Vendedor com `COMMERCIAL_ADMIN`, sem herdar o
  checkbox. O Vendedor habilitado e o Financeiro recebem 403.
- **D5.** Não há auto-invalidação ao esgotar os retries; o admin decide. O job
  esgotado fica em `dead_letter` e a invalidação é a saída explícita.

Decisão técnica, sem confirmação pendente, mas registrada para evitar
reabertura silenciosa: o `markEffectStarted` tardio **ficou de fora** (D3).
Hoje o worker marca a tentativa do job como `sending` assim que o handler
começa, antes de o despachante decidir se haverá algum POST; adiar a marca para
logo antes do primeiro POST permitiria tratar como "sem efeito" a queda do
worker em fases só de leitura. Não foi feito: mexe no contrato da fila
compartilhada com outros workers, e o custo atual é conservador (um job que
perde o lease depois de iniciado é tratado como possível efeito e vai à
reconciliação, em vez de ser repetido; leitura inferida do código da fila, sem
teste dedicado nesta entrega).

## Alternativas descartadas

- **Reaproveitar a linha do export** (voltar para `queued` ou novo snapshot):
  quebra a imutabilidade do snapshot e da `generation`, a unicidade do job e
  reutiliza a referência `CRM-<id>`, já possivelmente pesquisada no ERP.
- **Auto-invalidar ao esgotar retries:** decide pelo humano sem ele ter lido a
  causa e libera a edição do Pedido sem ciência; fica fora por D5.
- **Re-enfileirar automático** ao mudar versão, configuração ou conexão: cria a
  mesma venda a partir de dados que talvez já divirjam do que o operador
  aprovou na prévia, e esconde a causa.
- **Espera de escrita** (segurar o POST até haver quota): ver ADR 070; um POST
  atrasado dentro do lease é uma incerteza a mais, não uma segurança.
- **Exigir conexão saudável para invalidar:** a causa mais comum do impasse é
  justamente a conexão trocada; o comando é local e não precisa dela.

## Consequências

- A saída de um export parado deixa de ser cancelar o Pedido. O custo é uma
  migração aditiva, uma tabela de recibos e três triggers; nenhum serviço,
  dependência ou infraestrutura novos.
- **Uma operação ativa por Pedido/conta.** O histórico é append-only e o ID
  remoto continua único em todo o banco. Consultas por "o export do Pedido"
  precisam escolher a ativa; código que assume uma linha por Pedido está
  errado a partir da 0071.
- **Rollback.** A migração só relaxa unicidade, então código antigo roda sobre
  o esquema novo. **Depois da primeira invalidação, não fazer rollback de
  código**: leitores antigos usam `rows[0]` sem filtrar o estado e podem ler a
  geração arquivada como se fosse a atual. Antes da primeira invalidação o
  rollback é seguro. Nunca apagar vínculo, cadastro ou recibo.
- **Retry pré-efeito associado** (a invalidação é a saída dele, ver também a
  [ADR 070](070-olist-quota-com-espera-de-leitura-e-folga.md)). Somente
  `OLIST_RATE_LIMITED`, `OLIST_UNAVAILABLE` e `OLIST_REFRESH_IN_PROGRESS`,
  sem ticket de venda e com `assertRetrySafe` verdadeiro (estado
  `queued/resolving/ready`, sem tentativa de venda, sem ID de venda, sem
  recurso `reserved` ou `uncertain`), voltam como `failed` com `retryable` e
  `retrySafe`. O worker só repassa os dois indicadores a um `failed` com um
  desses três códigos. Backoff de 15 s a 300 s (dobrando, com jitter) e oito
  tentativas somam cerca de 17 minutos; depois o job vai a `dead_letter`.
  `INCOMPLETE_LOOKUP` e `RESOURCE_UNAVAILABLE` ficam fora (podem seguir um POST
  de recurso cujo resultado não foi visto). Um hook `prepare` renova o token
  antes do guard local, que exige `expires_at > now`; sem ele, um token apenas
  vencido virava `OLIST_CONNECTION_CHANGED` terminal.
- **Versão do export.** `recordDispatchStop` incrementa a versão do export
  quando o código de falha gravado muda (primeira falha, ou alternância entre os
  códigos acima); a repetição do mesmo código não incrementa. A tela que
  mostrou a versão anterior recebe `VERSION_CONFLICT` e precisa reler o
  diagnóstico. É conservador por desenho: o comando confirma exatamente o que o
  admin viu.
- Causas que continuam terminais e dependem da invalidação: `generation + 1`,
  `authorization_version` revogada ou reconcedida, mudança de versão do
  Pedido, das configurações ou do contato.
- O 429 do provedor não tem `Retry-After` documentado; o código o respeita
  quando presente e, sem ele, bloqueia a conta por 60 s (ADR 070).

## Invariantes

1. Nenhum POST de venda depois de qualquer tentativa de venda; a recusa é
   verificada na aplicação e no banco.
2. Nada do ERP é apagado; recursos confirmados são reaproveitados por
   identidade. Zero em busca não autoriza criação.
3. Recurso `reserved` ou `uncertain`, tentativa de recurso `reserved` ou
   tentativa `uncertain` de recurso ainda não confirmado bloqueiam a
   invalidação; só `/reconcile` os resolve, antes. Recurso confirmado com ID
   remoto nunca é repostado, logo sua tentativa antiga não bloqueia.
4. Escrita nunca espera nem repete; POST incerto nunca é repetido.
5. Cancelamento (ADR 068) continua terminal; `invalidated` não sai desse
   estado e `cancelOrder` ignora linhas já arquivadas.
6. Autorização revalidada sob lock em todo comando e replay.
7. Motivo só em envelope cifrado; evento, auditoria e recibo só com códigos e IDs.
8. Uma operação ativa por Pedido/conta; histórico append-only; ID remoto único.
9. Invalidar é local: zero HTTP e sem exigir conexão saudável; o diagnóstico que
   oferece o comando também é local.

## Riscos aceitos

- Sem o `markEffectStarted` tardio (D3), a perda do lease depois do início do
  job continua sendo tratada como possível efeito, mesmo em fase só de leitura.
- Comprador ou produto recorrente com cadastro alterado no ERP continua em
  `OLIST_RESOURCE_DIVERGENT` (`payload_hash` imutável) e a invalidação não o
  resolve; o contorno é manual, no runbook (risco aceito do piloto em
  08/11/2026).
- Um Pedido com cadastro confirmado segue congelado para edição (D1).
- Rollback de código inseguro depois da primeira invalidação (acima).
- `OLIST_EXPORT_IN_FLIGHT` pode exigir nova tentativa do admin; o lease do job
  é de 30 s. Um job `processing` de lease vencido não bloqueia: é retirado como
  os demais (as recusas por venda e por recurso já excluem um POST possível e o
  worker tardio é barrado pelo lock e pelo estado do export).

Contrato em [OpenAPI](../api/openapi.v1.yaml) (`invalidateOlistExport`);
procedimento, códigos e rollback no
[runbook da fase 5](../runbooks/olist-phase5.md#invalidação-administrativa-e-quota).
Geração real continua desligada, sem deploy, conexão homologada ou piloto; a
evidência local não equivale a operação no EasyPanel.
