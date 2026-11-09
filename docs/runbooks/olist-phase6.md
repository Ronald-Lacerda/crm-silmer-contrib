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

O piloto permanece individual. A configuração privada contém o ID exato da
conta ativa, além do checkbox Olist. Administrador, e-mail parecido, nome igual
ou posse do Pedido não conferem essa habilitação. A API e o worker devem usar a
mesma allowlist; vazia ou inválida mantém a criação desligada para todos.

Antes do aviso à operadora, registrar evidência real de:

- release/digests, health e migrações da API/worker/edge no EasyPanel;
- conexão da empresa correta, parâmetros comerciais/fiscais explícitos e gatilhos ERP;
- vínculo T16 do caso privado existente, com zero POSTs criadores;
- teste controlado T17, com uma entidade por identidade, uma venda e valores por linha;
- replay/recarga sem nova venda e ausência de incerteza sem responsável;
- backup externo e preservação privada das chaves, suporte e procedimento de desligamento.

O aviso de prontidão para teste não encerra o período de observação do piloto.
T18 exige avaliação posterior e decisão explícita de ampliar ou manter restrito;
nenhum outro usuário recebe permissão por herança. A ficha v7 continua sob seu
gate de aprovação de amostra; não trocar `PRINT_TEMPLATE` para concluir o piloto.

## Evidência do ambiente real

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
cópia externa do backup ainda precisam de evidência no alvo antes da liberação.
