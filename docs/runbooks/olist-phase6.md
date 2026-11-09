# Olist — Fase 6: piloto individual

Rastreabilidade: RFC 050, OLIST-T15/T16/T17/T18; OLIST-14–17, 25–31 e 48–50.
Este registro distingue o ensaio sintético da liberação no ambiente real.

## Ativação restrita (T17 / OLIST-48)

API e worker usam `OLIST_PILOT_USER_IDS`, lista privada separada por vírgula de
IDs exatos. Ausente, vazia ou inválida nega efeitos para todos; não publicar os
valores. O checkbox continua obrigatório e é revalidado em cada reserva,
inclusive em jobs anteriores à revogação. A allowlist não concede Inbox,
edição comercial nem administração da conexão.

Em Olist → Conexão da empresa → Geração no piloto, administrador informa um
motivo e ativa/desativa pelo comando `POST /api/v1/integrations/olist/creation`.
O comando exige sessão, CSRF, idempotência e versão atual da conexão; incrementa
a versão e audita a decisão, invalidando prévias anteriores. Ativar exige
conexão válida, parâmetros salvos, conta fora de recuperação e operadores
ativos com checkbox. Desativar é local, sem chamada ao ERP. Não limpa
`recovery_required` nem apaga entidades/vendas. A interface reflete a flag real
e bloqueia ativação enquanto há recuperação ou identidade ainda não configurada.

Conta nova também nasce com `recovery_required=true`. Após conferir o caso
existente e os cadastros/vendas da conta, o administrador usa **Registrar
conferência concluída**, com declaração explícita e motivo. O comando
`POST /api/v1/integrations/olist/recovery` exige sessão/CSRF, idempotência e a
versão atual, registra `OLIST_RECOVERY_CONFIRMED` e incrementa a versão; não
ativa criação, não consulta o ERP e não apaga nem repete efeitos. A declaração
atesta o procedimento humano externo, sem prometer detectá-lo automaticamente.

Criação ligada, renovação em voo, operações ativas, reservas, incertezas sem
prova atual, divergências e leituras pendentes impedem a conclusão. Tentativa
incerta histórica só deixa de bloquear quando seu alvo atual está confirmado
com identidade remota compatível; a tentativa é preservada. Desligar a geração
continua disponível mesmo sem conexão. Não liberar a primeira criação sem
conferir os registros que já existem na conta.

Revisão QA independente dos ajustes: nenhum blocker de release em
autorização, concorrência, idempotência ou projeção de segredos. Os ports de
persistência isolados permitem omitir a política para injeção de teste; os
dois callsites de produção passam explicitamente a lista do ambiente, com
teste da composição real comprovando que lista vazia ou ID divergente não
produzem consulta, tentativa ou escrita no ERP.

## Ensaio de recuperação (T15)

Em 09/11/2026, o ensaio existente no checkout `olist-liveness`, ainda não
versionado, foi preservado no local de origem e adaptado como
`test/olist-operation-rehearsal-postgres-live.test.js`. A adaptação acrescenta
allowlist sintética por ID, corrige tipagem e contadores da janela de restore,
e substitui a instrumentação temporária por asserções efetivas.

Ambiente dedicado: Node 24.20.0, npm 11.19.0 e PostgreSQL 17.11 nativo local,
com bases `crm_silmer_test_t15_live` e `crm_silmer_test_t15_backup`. O ensaio
recusa bases fora do prefixo `crm_silmer_test`. Não há chamada ao ERP real.

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55426/crm_silmer_test'
node --test test/olist-operation-rehearsal-postgres-live.test.js
```

Resultado em 09/11/2026: **76 testes aprovados, zero falhas e zero pulados**, em aproximadamente 80 segundos. `npm run typecheck`, ESLint do ensaio e Prettier dos dois arquivos também aprovados. Log local sintético: `var/qa-olist-phase6/rehearsal.log` (ignorado pelo Git).

O worker, fila, leases, resolvedor, escritores, repositórios e reconciliação são
reais; o ERP é um `fetch` falso que conta cada efeito. O ensaio cobre:

- criação limpa e replay sem duplicação;
- morte depois da reserva e antes do POST em cliente, produto, variação e venda;
- timeout, 5xx, corpo inválido e 2xx sem ID após criação remota;
- falha de persistência após POST, sem repetição da etapa incerta;
- quota esgotada antes da escrita, espera segura e conclusão posterior;
- revogação de checkbox ou desativação entre etapas;
- reconexão OAuth no meio, invalidação local e reaproveitamento das entidades;
- preservação das tentativas, envelopes, snapshots e eventos;
- restore com efeitos remotos posteriores à fotografia e reconciliação por leitura.

O restore usa `CREATE DATABASE … TEMPLATE` após fechar conexões. Isso valida a
recuperação lógica do fluxo; não comprova backup externo, criptografia, escrow,
RPO/RTO, OAuth real, RustFS, EasyPanel nem comportamento do Olist.

## Roteiro de recuperação ensaiado

1. Manter despacho e reconciliação parados durante a restauração.
2. Antes de subir qualquer consumidor, desligar criação e marcar recuperação na conta.
3. Aposentar leases antigos das filas Olist.
4. Incrementar a versão dos parâmetros por comando administrativo para expirar prévias.
5. Reconciliar toda a janela por leituras; vincular vendas existentes sem nova inclusão.
6. Conferir as entidades, tentativas e vendas; nenhuma incerteza fica sem responsável.
7. Só então retirar a trava de recuperação e reautorizar criação.

As mutações do ensaio removem controles individualmente e devem falhar nas
asserções correspondentes. Sem desligar criação **e** sem invalidar prévias,
um ERP com busca atrasada pode receber duplicatas após restore. A proteção
procedural continua necessária; não existe interlock externo ao banco restaurado.

## Critérios para liberar o teste da operadora

### Revisar e enviar; cadastros e vencimento no Olist

A diretriz final do proprietário em 09/11/2026 é manter o Olist independente
e reduzir ações no CRM. [RFC 056](../rfc/056-envio-simples-da-ficha-com-cadastros-no-olist.md)
e [ADR 072](../adr/072-envio-em-aberto-sem-duplicar-cadastros-do-erp.md)
supersedem a rotina de campos adicionais da RFC 055/ADR 071.

1. Na ficha, escolher **Revisar envio**. O CRM consulta e valida a prévia.
2. Conferir comprador, itens, tamanhos, quantidades, subtotais e total; escolher
   **Enviar para Olist**. Só a confirmação autoriza a inclusão.

Não preencher NCM, copiar cadastro fiscal ou escolher ID de comprador na rotina
do CRM. Com cadastro CRM vazio, o comprador existente no ERP só é usado quando
há uma correspondência única e ativa de nome/telefone. Uma pendência não cria
comprador nem faz associação aproximada. A operação preserva referência e
hashes, sem importar CNPJ/IE/endereço para Contact.

Usar `paymentDuePolicy=erp`, com pagamento/parcelas omitidos. Rose define o
vencimento no ERP. A condição enum da ficha vai apenas por frase fixa, sem
copiar notas ou conversa. Fiscal central ausente adia a tripla opcional do
produto; não inventar valores ou status de produto. O pedido vai em situação
0, sem comando de nota, estoque, recebimento ou baixa. Os modos anteriores de
vencimento permanecem compatíveis, sem serem exigidos nesta rotina.

Não alterar gatilhos ou parâmetros globais do ERP para fazer o teste passar.
Ordem de compra histórica não se torna padrão de novas vendas. A aceitação
real da omissão fiscal deve ser observada no primeiro teste; erro não autoriza
preencher defaults ou repetir um POST de resultado incerto.

### Venda histórica sem identidade canônica

O caminho **Vincular venda histórica** exige ID da venda e correspondência
explícita de cada grupo/linha com pai, filho e posição do item. Conferir os
atributos humanos, cliente, tamanhos, quantidades, datas e todos os valores.
Origem, vencimento, OC e fiscal observados pertencem ao passado; não são os
defaults atuais nem dados para novos cadastros. Fiscal ausente aparece como
não verificado. A confirmação com motivo gera um vínculo cifrado e auditado
`legacy-sale-only-v1`, sem recursos compartilhados, jobs criadores ou POST ERP.
Nome exato com telefone divergente pode ser conferido explicitamente nessa tela, com aviso e declaração no aceite existente (ADR 073/RFC 057). A prova é exclusiva da venda, cifrada e relida no commit, replay e reconferência; não autoriza reutilização em novos envios e não altera Contato. Qualquer mudança remota ou local exige nova conferência. A reconferência desse
vínculo continua apenas por leitura; tentativas incertas usam a trilha estrita.

### Checklist do piloto restrito

O piloto permanece individual. A configuração privada contém o ID exato da
conta ativa, além do checkbox Olist. Administrador, e-mail parecido, nome igual
ou posse do Pedido não conferem essa habilitação. A API e o worker devem usar a
mesma allowlist; vazia ou inválida mantém a criação desligada para todos.

Antes do aviso de prontidão para teste, registrar evidência real de:

- release/digests, health e migrações da API/worker/edge no EasyPanel;
- conexão da empresa correta, parâmetros do envio em aberto e gatilhos ERP;
- conta exata da operadora, checkbox e allowlist privada, sem permissão herdada;
- histórico já existente vinculado ou protegido em conferência pendente, conforme decisão do proprietário; nunca recriá-lo para testar;
- ausência de incerteza ou efeito em andamento sem responsável;
- backup atual concluído, preservação privada das chaves e procedimento de desligamento.

Por determinação do proprietário, a conferência do histórico fica com a Rose.
A [ADR 075](../adr/075-retirada-local-de-vinculo-historico-sem-liberar-duplicata.md)
permite retirar o aceite local legado para `legacy_review_required`, preservando
IDs e auditoria. O comando exige os três modos autenticados na API, prova do
vínculo legado no banco e zero recursos/tentativas/jobs criadores; leituras
históricas concluídas são preservadas, leituras ou leases em andamento impedem
a retirada. Esse pedido não oferece criação, edição, reabertura, cancelamento,
reconciliação que reative ou replay que anuncie vínculo ativo. Não ampliar
permissões da operadora ou executar outro vínculo no lugar dela.

A prontidão não afirma que T17 foi executada. No primeiro teste supervisionado,
usar um pedido novo, conferir uma entidade por identidade, uma venda e cada
subtotal, depois recarregar sem nova venda. Observar a aceitação do produto com
fiscal adiado e os efeitos reais do envio em aberto; erro não autoriza defaults
ou repetição cega. A pendência histórica protegida não impede novos pedidos.
T16 permanece reservado à conferência humana, e T17/T18 só encerram após as
evidências e o aceite posteriores. O aviso autoriza o teste individual, sem
ampliar acesso ou declarar o piloto já observado.

O piloto individual não comprova recuperação da perda total da VPS. Backup
externo, escrow com dois custodians e o drill completo continuam nos gates
operacionais independentes da topologia/recovery. Não ampliar esse ensaio para
provisionar armazenamento novo sem decisão do proprietário. A evidência local
de restore lógico e o backup EasyPanel não fecham esses gates gerais. Após
qualquer restauração, despacho e criação permanecem parados até reconciliar a
janela; nunca restaurar e religar automaticamente.

O aviso de prontidão para teste não encerra o período de observação do piloto.
T18 exige avaliação posterior e decisão explícita de ampliar ou manter restrito;
nenhum outro usuário recebe permissão por herança. A ficha v7 continua sob seu
gate de aprovação de amostra; não trocar `PRINT_TEMPLATE` para concluir o piloto.

## Evidência do ambiente real

Em 09/11/2026, a correção de formatos reais dos catálogos foi integrada no
[PR 327](https://github.com/romulosutil/crm-silmer/pull/327), commit
`b01d39b681c774049b54c1bcc25503a64d174446`. API, worker e edge implantados
automaticamente em `master`, todos saudáveis; live, ready e healthz retornaram 200. Consultas limitadas comprovaram vendedores e depósitos sem mutação ERP.
Os identificadores das opções e as correspondências reais permanecem privados.

Validação da fatia seguinte (vencimento/fiscal por prévia e vínculo histórico):
`npm run validate` aprovado, 2.379 testes, 2.331 aprovados e 48 skips
condicionais; revisão independente sem crítico/alto. SQL administrativo/runtime
afetado 58/58 e inspector final 28/28, incluindo o nome de grade legado no
plural e a recusa de aliases ambíguos. UI Olist cobriu 171 cenários, com
reexecuções focadas aprovadas após corrigir seletor de mensagem e substituir
números privados por fixtures sintéticas. Esses gates não são criação real.
O gate SQL completo foi reexecutado no commit enviado: **351/351**, sem skips.

Uma leitura adicional de venda previamente criada na prova real confirmou duas
representações do detalhe: lista opcional não selecionada como `{id:0}` e
`origemPedido=3`. A conferência aceita ID zero somente quando nenhum ID positivo
foi configurado e aceita as origens observadas 0/3; não atribui significado
fiscal ao valor 3. O [schema oficial](https://erp.olist.com/public-api/v3/swagger/swagger-mintlify.json)
do detalhe declara inteiro nullable, mas descreve apenas 0/1; essa diferença
com a resposta real fica registrada. Situação aberta, ausência de NF,
faturamento e pagamentos integrados continuam verificadas separadamente.
Testes da correção: 17/17, incluindo recusas de identidades divergentes,
origens desconhecidas e efeitos fiscais/financeiros.

Em 09/11/2026, o PostgreSQL permaneceu ativo; a API conectava ao banco, mas
readiness retornava 503 e o login não completava. O esquema aplicado terminava
em 0062 enquanto a imagem implantada já trazia as migrations Olist.

- Backup `pre-olist-phase6-20261109`: concluído com sucesso em cinco segundos,
  2,38 MB, no provedor **Local Disk**. Isso ainda não comprova cópia externa.
- Migrador oficial `node /app/modules/database/src/cli.js --phase=expand`:
  nove migrations aplicadas, `status=ok`. Readiness passou a 200 e a sessão
  administrativa do CRM foi restaurada, sem reiniciar ou recriar PostgreSQL.
- Aplicativo Olist existente preservado, mesmos escopos e credenciais;
  callback salvo como `https://crm.silmer.com.br/olist`.
- Configuração privada salva na API e no worker, chaves próprias e envelope
  cifrado de recuperação fora da VPS. Allowlist contém uma única conta ativa
  conferida no CRM; só essa conta recebeu o checkbox. Despacho continua
  desligado, sem ativação da flag criadora da conta ERP.

Validação local final: `npm run validate` aprovado (2.366 testes, 2.318
aprovados, 48 pulados condicionais, zero falhas), SQL `test:olist:live`
316/316 sem skips, auditoria de dependências sem vulnerabilidades. SQL inclui
renovação OAuth antes da primeira prévia, corrida de ativação, revogação do
piloto e o ensaio de recuperação. E2E completo do primeiro commit: 790
aprovados e sete skips previstos, sem falhas. Ajuste T15 posterior: comando de
conferência com SQL 36/36 e interface administrativa 33/33 (teclado, axe,
declaração obrigatória e recusa preservando o motivo). `npm run validate` do
ajuste também aprovado: 2.367 testes, 2.319 aprovados, 48 skips e zero falhas;
formatação, tipos e lint finais aprovados. Release no alvo
ainda em validação.

Identidade, documento, credenciais, pedidos reais e capturas com dados pessoais
ficam em evidência privada. Vínculo T16, criação controlada T17, parâmetros e
backup atual com chaves recuperáveis ainda precisam de conferência final no
alvo antes da liberação. A cópia externa permanece pendência de recuperação
geral, separada da prontidão para o teste individual supervisionado.

Gate da simplificação em dois gestos: `npm run validate` com 2.397 testes, 2.349 aprovados, 48 skips condicionais e zero falhas; SQL oficial `test:olist:live` com 356/356 e zero skips. UI cobre 217 cenários distintos, incluindo revisão/envio sem formulário fiscal ou vencimento, teclado e largura de 320 px. Ajuste de mensagem de comprador ausente: API 19/19; configuração em modo ERP: UI 1/1. A exceção histórica posterior recebe checks próprios antes da integração. Nenhum desses resultados é prova de inclusão real no ERP.

Gate integrado final da simplificação e exceção histórica: `npm run validate`
aprovado com 2.404 testes (2.356 aprovados, 48 skips condicionais, zero falhas).
Exceção T16: SQL administrativo 24/24, unitários focados 57/57, QA independente
3/3 e UI 23/23 (13 históricos e 10 da rotina normal). Revisão independente sem
finding alto/crítico. O gate SQL completo da simplificação continua registrado
como 356/356; o CI do head final repete os gates integrados antes do merge.

O [PR 330](https://github.com/romulosutil/crm-silmer/pull/330) passou todos os
jobs do CI (PostgreSQL, estáticos/E2E, dependências e build/scan das duas
imagens) e foi integrado como `13a0ff0104bd3c3260ed322820f40a55f47ec5c9`.
API, worker e edge foram observados saudáveis nessa versão; live, ready e
healthz retornaram 200. Parâmetros centrais foram salvos em modo ERP, sem
alteração dos parâmetros globais do Olist. Identificadores reais permanecem
na evidência privada.

A verificação real identificou uma corrida na entrada da ficha: `stream.reset`
podia abortar a primeira leitura CRM antes da projeção e ocultar a conferência
administrativa. A correção repõe somente essa leitura enquanto ainda não há
projeção; uma recusa de acesso permanece recusada. Não gera prévia, consulta
ERP, reutiliza recibo nem envia automaticamente. O teste reproduz o EventSource
real com GET inicial atrasado, além de cobrir operadora e recusa 403. Regressões
com adaptadores reais e PostgreSQL preservam leitura administrativa sem checkbox,
recusa de exportação, origem externa e sessão revogada.

Hotfix de entrada da ficha: `npm run validate` aprovado (2.405 testes, 2.357
aprovados, 48 skips condicionais, zero falhas); E2E 76/76, autenticação real
2/2 e SQL runtime 37/37. Revisão QA independente sem blocker. A reprodução
antes do patch falhou com a mesma ausência da administração observada no alvo.

Retirada local protegida (ADR 075/RFC 059): validação integrada aprovada com
2.408 testes (2.360 aprovados, 48 skips condicionais, zero falhas). SQL focal
50/50 inclui claims concorrentes, tuplas atuais após espera por trava e
preservação da invalidação comum. UI 64/64, focais 22/22, visuais 2/2 e QA
independente 3/3. Revisão sem bloqueios restantes. O gate SQL completo e o CI
do head integrado precisam passar antes da implantação e do comando no alvo.
