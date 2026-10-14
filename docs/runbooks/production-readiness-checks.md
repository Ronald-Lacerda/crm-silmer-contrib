# Checagens para produção — EasyPanel

Data da checagem: **05/10/2026, America/Sao_Paulo**.
Checagens públicas do CRM às 21:43–21:45.
Rastreabilidade: [INT-3 / OPS-CHK-01](../../.specs/features/crm-mvp/tasks.md),
T00.3, T00.7 e [ADR 022](../adr/022-manter-deploy-automatico-github-easypanel.md).
Responsável pela coleta: agente DevOps/QA, sob integração do Tech Lead.

## Incidente observado em 14/10/2026 — dashboard indisponível

No domínio `https://crm.silmer.com.br`, a sessão autenticada foi restaurada,
mas Dashboard e Pedidos exibiram erro de carregamento. Checagens públicas,
sem cookie nem corpo de rota de negócio: `/healthz` e `/api/health/live`
responderam 200; `/api/health/ready` respondeu 503 com
`{"service":"crm-silmer-api","status":"unavailable"}`. Esta é uma
regressão em relação à leitura de 05/10 abaixo, não evidência de recuperação.
Rastreabilidade: FIN-02, CRM-4 e T80 de Pedidos MVP.

No EasyPanel, `silmer-api`, `silmer-edge-web`, `silmer-postgres` e
`silmer-worker` aparecem em execução; o worker exibiu heartbeat recente. O
`silmer-chat-spool-init` está parado, como previsto após a preparação do spool.
A API mostra implantação de código recente e deploy automático desativado. A
página Scripts da API não tem job de migration salvo. O Auto Deploy desativado
diverge da decisão operacional registrada abaixo e precisa ser reconciliado.
O backup do PostgreSQL usa Local Disk e execução manual. Em 14/10, foi criada
e marcada como concluída a cópia `pre-migracao-0035-0037-2026-10-14`; ela
permanece no disco local, sem cópia externa nem restore comprovado.

O código de readiness exige conexão PostgreSQL e igualdade dos checksums de
todas as migrations `expand` carregadas pela imagem. A sessão restaurada
indica que ao menos a leitura de identidade respondeu. Consulta somente leitura
em `crm_meta.schema_migrations` mostrou `0034` como última migration aplicada,
com checksum igual ao arquivo do release. A imagem implantada contém `0035`,
`0036` e `0037`, ausentes no banco. Isso explica o readiness 503.

### Recuperação confirmada em 14/10/2026

O proprietário executou no console da `silmer-api` implantada
`node /app/modules/database/src/cli.js --phase=expand`. O migrador retornou
`{"applied_count":3,"phase":"expand","status":"ok"}`. Na sequência,
`/api/health/ready`, `/api/health/live` e `/healthz` responderam 200. Na
sessão publicada, Dashboard exibiu os painéis de indicadores, Pedidos carregou
a lista e Caixa de Entrada carregou sem alerta. O painel mostra totais zerados;
o pedido confirmado observado é de teste e não integra as vendas reais.

Esta verificação confirma a recuperação das rotas observadas, não um teste de
restauração do backup nem a ausência de falhas em fluxos de escrita. A melhoria
de resiliência da interface (indicadores disponíveis preservados quando uma
API falha) chegou com o Painel por papel (#192) e só vale em produção depois
da implantação.

A PR #250 complementa essa resiliência na leitura inicial: uma falha no resumo
de pedidos preserva a fila disponível e exibe “—” em vendas e entregas, sem
inferir valores zerados ou ausência de urgência. O retry continua por teclado.
Rastreabilidade: FIN-02, PNL-03 e T130 (Pedidos MVP); isso não comprova deploy.

Para uma nova ocorrência, antes de aplicar migrations, verificar backup, espaço
livre, estado dos serviços e plano de rollback. No container `silmer-api` do
release correto,
executar `node modules/database/src/cli.js --phase=expand` (a imagem remove
`npm`). O migrador usa advisory lock e aplica cada migration em transação;
não editar checksums nem executar migrations contract para tentar liberar o
health. Depois, exigir `/api/health/ready` 200 e repetir leituras autenticadas
de Dashboard, Pedidos e Inbox, além de conferir que não há erros 5xx.

O proprietário escolheu manter o deploy automático GitHub → EasyPanel
existente. A checagem de 05/10 abaixo não alterou serviços, segredos, DNS,
workflows, migrations nem configuração de deploy. Nesta recuperação de 14/10,
foram aplicadas somente as três migrations `expand` pendentes.

## Alvo e limites da evidência

O alvo público conhecido é
`https://espectro-mvp-silmer-edge-web.jicnzg.easypanel.host`, registrado em
[`META-SANDBOX.md`](../phase0/META-SANDBOX.md) e
[`activation-gate.json`](../../ops/observability/activation-gate.json).
As fontes de produto identificam esse contexto como cloud-dev. Nesta sessão,
o proprietário confirmou o painel e o projeto `espectro-mvp`, com os serviços
`silmer-edge-web`, `silmer-api`, `silmer-postgres` e `silmer-worker`, como fluxo
atual a preservar. A tela Domains do edge vincula o endpoint acima ao serviço
interno `http://espectro-mvp_silmer-edge-web:8080/`; a identidade do endpoint
foi confirmada no painel. A revisão exata executada e o aceite de produção
continuam pendentes. O contexto permanece cloud-dev até os gates de lançamento.

O grafo de 23/09/2026 apontou a comunidade de Topologia EasyPanel; a
investigação confirmou as fontes atuais com `rg`. O inventário
[`topology.json`](../../ops/easypanel/topology.json) e o
[`provisioning-gate.json`](../../ops/easypanel/provisioning-gate.json)
preservam evidência histórica, incluindo quatro serviços, digests anteriores,
domínios nulos e um workflow antigo. Não foram reescritos com estados presumidos.

## Resultado observado

| Controle                        | Estado em 05/10/2026   | Evidência e alcance                                                                                                                                                                                                             |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolução do host conhecido     | Observado              | Requisições externas concluídas pelo hostname; não certifica DNS final de produção.                                                                                                                                             |
| HTTPS e validação TLS           | Observado              | `curl` com validação padrão: HTTP 200 e `ssl_verify_result=0`; sem `--insecure`. Expiração/renovação automática ainda não auditadas.                                                                                            |
| Redirecionamento HTTP           | Observado              | `GET http://<host>/healthz` retorna 301 para a mesma rota HTTPS.                                                                                                                                                                |
| Edge live                       | Observado              | `GET /healthz` retorna 200.                                                                                                                                                                                                     |
| API live                        | Observado              | `GET /api/health/live` retorna 200.                                                                                                                                                                                             |
| API ready                       | Observado              | `GET /api/health/ready` retorna 200, com `service=crm-silmer-api` e `status=ready`. No código, readiness verifica conexão e checksums das migrations expand carregadas pelo runtime; não identifica o SHA implantado.           |
| Headers do edge                 | Observado              | `/healthz`: HSTS `max-age=31536000; includeSubDomains`, CSP restritiva, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, Permissions-Policy sem câmera/localização/microfone.        |
| Sessão ausente                  | Observado              | `GET /api/v1/sessions/current` sem cookie retorna 401. Corpo descartado.                                                                                                                                                        |
| Inbox sem sessão                | Observado              | `GET /api/v1/inbox/conversations` sem cookie retorna 403. Corpo descartado; não substitui teste de ACL entre usuários.                                                                                                          |
| Publicação GHCR no CI           | Observado no código    | `.github/workflows/ci.yml` publica imagens e artefatos por SHA/digest após os gates. Não contém chamada à API administrativa EasyPanel. A investigação/correção do publish pertence à etapa 2.                                  |
| Registro GitHub Deployments     | Histórico insuficiente | Um deployment `t00-2-promotion`, de 12/09/2026, permanece `waiting`, sem URL. Isso não exclui auto-deploy configurado externamente no EasyPanel.                                                                                |
| Lista de webhooks GitHub        | Bloqueado por acesso   | CLI retorna 404 e informa ausência do escopo `admin:repo_hook`. Nenhum escopo foi ampliado. URLs e credenciais de webhook não foram coletadas.                                                                                  |
| SSH do worker                   | Bloqueado por acesso   | `ssh -o BatchMode=yes -o ConnectTimeout=10 dell-worker` não resolve o hostname nesta sessão. O worker Ubuntu não foi inspecionado; esse host não é prova de acesso à VPS EasyPanel.                                             |
| Sessão administrativa EasyPanel | Observado              | Proprietário efetuou login; Tech Lead acessou a aba autenticada e assumiu auditoria somente leitura. Nenhuma senha foi digitada pelos agentes; segredos não integram estes artefatos.                                           |
| Transporte do painel            | Pendente crítico       | Formulário de login acessível por HTTP na porta 3000 pela rede desta sessão. HTTPS do painel e restrição VPN/allowlist não comprovados. Isso não mede a regra global do firewall; credenciais não foram enviadas pelos agentes. |

As respostas de health contêm apenas os campos técnicos acima. Corpos de
rotas de negócio foram descartados; os agentes não enviaram credenciais.

Após o proprietário efetuar login, o Tech Lead recuperou a sessão autenticada
e assumiu a navegação do painel somente leitura. O overview de `silmer-worker`
mostra **Disable Auto Deploy**, comprovando o gatilho automático ativo nesse
serviço. A leitura instantânea indicou CPU 0,4% e memória 25,4 MB; esses valores
não comprovam limites configurados, sizing sob carga ou heartbeat no banco.

### Painel autenticado — fonte e release

Coleta do Tech Lead por navegação somente leitura; nenhuma configuração salva.

Uma leitura inicial do histórico exibiu a URL secreta de gatilho na saída da
ferramenta. O valor não foi incluído no repositório ou na PR; leituras posteriores
filtraram esse campo. Regenerar o gatilho exposto e conferir seu vínculo com a
integração existente faz parte da revisão de segredos antes da produção.

| Serviço/controle              | Observado                                                                                                                                                       | Pendência para produção                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `silmer-worker` Source        | GitHub `romulosutil/crm-silmer`, branch `master`, build path `/`, Dockerfile `docker/runtime.Dockerfile`. Auto Deploy ativo pelo botão **Disable Auto Deploy**. | Conferir revisão executada, imagem, health e vínculo com aprovação do CI.                                                                             |
| `silmer-api` Source           | Mesmo repositório, branch, path e Dockerfile. Auto Deploy desativado pelo botão **Enable Auto Deploy**.                                                         | Divergência com worker: o merge não comprova implantação coordenada. O proprietário mantém o fluxo escolhido; esta auditoria não habilitou o gatilho. |
| Último deployment da API      | `feat(print)` da ficha v5; build **Success**, 05/10/2026 às 21:36:13 BRT (06/10/2026 00:36:13 GMT no painel).                                                   | SHA Git exato não estava disponível na evidência visual; conferir commit implantado, migration e release anterior.                                    |
| Imagem gerada no build da API | Local `docker.io/easypanel/espectro-mvp/silmer-api`, digest `sha256:b8cf56dc88239c0451b038b7d924f851669866cf811523e214023bed61b8006d`.                          | Build próprio do EasyPanel; não é prova de consumo da imagem GHCR escaneada. Vincular esse build à revisão, scan e gates antes do go-live.            |
| Resources da API              | CPU/memória: reservas e limites com valor 0; UI descreve **unlimited**.                                                                                         | Não atende a hipótese de limites da topologia. Conferir teto e uso agregado com os serviços vizinhos antes da carga/produção.                         |

Sucesso de build e ausência de limites não foram convertidos em evidência de
health do container ou de isolamento da rede. Migrations, rollback e checks
de CI anteriores ao gatilho ainda precisam ser comprovados no fluxo real.

Checagens adicionais do mesmo painel autenticado:

| Serviço/controle           | Observado                                                                                                                                               | Alcance                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `silmer-edge-web` Source   | GitHub `romulosutil/crm-silmer`, branch `master`, build path `/`, Dockerfile `docker/edge-web.Dockerfile`; Auto Deploy ativo (**Disable Auto Deploy**). | Fonte e gatilho conferidos; revisão executada e vínculo com gates CI pendentes.                                                                 |
| Resources de edge e worker | CPU/memória: reservas e limites 0, UI **unlimited**, como API.                                                                                          | A baseline de limites por serviço ainda não está efetivada para os três apps. O uso instantâneo não substitui sizing ou carga.                  |
| `silmer-worker` Advanced   | Uma réplica, **Zero Downtime** marcado; comando `node apps/worker/src/worker.js`; seção Ports sem entradas, apenas **Add Port**.                        | Comando e ausência de publicação de portas nessa tela conferidos; não prova firewall do host, redes, Docker HEALTHCHECK nem heartbeat no banco. |

O lote final conferiu `silmer-postgres` com reservas/limites de CPU e memória
em 0 (**unlimited**). O Advanced da API mostrou uma réplica, **Zero Downtime**
marcado, Command vazio e seção Ports sem entradas. Command vazio significa
que nenhum override foi preenchido nessa tela; não identifica o processo
executado. A tela Domains do edge vincula HTTPS do endpoint conhecido ao
serviço interno na porta 8080. A auditoria se limitou aos quatro serviços
confirmados pelo proprietário; não inspecionou serviços de terceiros nem
presumiu onde n8n está provisionado.

## Checagens privadas pendentes no ambiente alvo

A auditoria do banco `silmer-postgres` mostrou **Exposed Port = 0**, com o
comportamento interno padrão descrito pela UI. Essa tela não comprova regras
globais do host. Em Backups, o banco `crm_silmer` está configurado como
**Local Disk / Manual Run**; a lista mostra uma entrada **Backup database**
com o rótulo `pre-migracao-0026-2026-10-03`, duração de dois segundos e idade
relativa de três dias exibida pelo painel. O rótulo não é prova da data exata,
integridade ou capacidade de recuperação. Nenhum botão Manual Run, Edit ou
Restore foi acionado. Backup externo, agendamento horário/diário e restore
continuam sem comprovação.

Todas exigem evidência atual do painel ou acesso administrativo somente leitura.
Usar nomes de variáveis e referências, sem exportar valores, `.env`, headers
Authorization, URLs assinadas, dump de configuração ou payloads de clientes.

| Checagem                    | Evidência mínima para liberar INT-3                                                                                                                                                                 | Estado atual                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Fonte do deploy e gatilho   | Projeto/serviço, fonte Git ou imagem, branch, integração/gatilho habilitado, execução recente vinculada ao SHA, e relação com os gates do CI. Preservar o fluxo existente.                          | API/worker/edge source Git master comprovado; Auto Deploy edge/worker ativo/API desativado; vínculo CI pendente |
| Versão executada e rollback | SHA/imagem atual e anterior recuperável; processo de rollback; ordem API/worker/edge e migration expand/contract sob advisory lock.                                                                 | Pendente                                                                                                        |
| Rede e firewall             | Somente edge/webhook públicos; banco CRM, banco n8n, API e worker internos; painel restrito; SSH restrito; ausência de portas de teste publicadas. Uma checagem HTTP não prova firewall.            | API/worker Ports vazios; banco Exposed Port0; edge HTTPS→interno8080; firewall/painel/n8n pendentes             |
| n8n                         | Serviço e banco próprios, health interno, versão publicada, editor/API administrativa sem rota pública, apenas webhook permitido; sem acesso ao banco CRM.                                          | Pendente                                                                                                        |
| CPU, memória e disco        | Limites efetivos de cada serviço, uso agregado com vizinhos, disco livre ≥30%, jobs e scanner do worker com concorrência limitada.                                                                  | Quatro serviços sem reservas/limites (0/unlimited); sizing agregado pendente                                    |
| Worker e fila               | Heartbeat <120 s, job mais antigo, falhas/reconciliação e progresso; consulta técnica agregada sem dados de cliente.                                                                                | Pendente                                                                                                        |
| Containers e volume privado | Usuário não-root, capabilities, read-only quando aplicável, temporários limitados; API/worker com volume privado e scanner atualizado; sem mídia pública.                                           | Pendente                                                                                                        |
| Segredos                    | Metadados comprovam Basic n8n→CRM e CRM→n8n distintos, menor privilégio, chaves por finalidade, registro de rotação e escrow da chave n8n; OpenAI apenas no n8n. Valores nunca entram na evidência. | Pendente                                                                                                        |
| TLS operacional             | Domínio final, certificado/expiração e mecanismo de renovação, HSTS e redirecionamento no host de produção.                                                                                         | Pendente                                                                                                        |
| Backups                     | Últimos dumps externos dos dois bancos, cadência horária/diária, retenção ≤35 dias, alerta de atraso, escrow e ledger externo de tombstones.                                                        | CRM com backup Local Disk/Manual Run; cópia externa/agendamento não comprovados                                 |
| Restore e perda total       | Evidência isolada de restore e host limpo com RPO ≤1 h/RTO ≤4 h, incluindo n8n e sua chave. Não executar drill no ambiente real durante esta auditoria.                                             | Bloqueado no gate histórico; sem nova prova                                                                     |
| Monitor off-host            | Monitor fora da VPS, alvos live/ready, heartbeat, donos/destinos, alertas de backup e drills autorizados com detecção/entrega/recuperação.                                                          | `pending-external` no gate versionado                                                                           |
| WhatsApp e IA               | Smoke sintético compatível com workflow publicado, credenciais Basic distintas, reserva antes da Meta, deduplicação e reconciliação; privacidade OpenAI aprovada para a configuração real.          | Pendente; etapas 4 e 5                                                                                          |

Referências dos gates: [recovery](../../ops/recovery/drill-gate.json),
[observabilidade](../../ops/observability/activation-gate.json),
[issue #3](https://github.com/romulosutil/crm-silmer/issues/3),
[issue #11](https://github.com/romulosutil/crm-silmer/issues/11).

## Próximas ações em ordem

1. **Coordenar API e gates de CI no fluxo escolhido.** Explicar/desfazer a
   divergência de Auto Deploy da API, vincular o SHA/build efetivo aos checks
   aprovados e provar ordem de migrations/API/worker/edge e rollback. Não
   assumir que o gatilho Git espera CI nem que o digest local foi escaneado.
2. **Aplicar limites e fechar acesso administrativo.** Dimensionar CPU/memória
   dos quatro serviços atualmente sem teto, medir disco/uso agregado e
   conferir HTTPS, VPN/allowlist do painel e firewall. Complementar hardening,
   volume/scanner e heartbeat com evidência do runtime real.
3. **Concluir backup externo e recuperação.** Substituir a suficiência do
   backup local/manual por dumps externos agendados dos dois bancos,
   tombstones e escrow. Executar restore isolado e drill em host limpo com
   RPO/RTO demonstrados.
4. **Ativar monitor fora da VPS.** Definir destinos/donos e ingestão de
   live/ready, heartbeat, fila e backup; ensaiar detecção, entrega e recuperação
   em janela autorizada, sem interromper operação real nesta checagem.
5. **Fechar OpenAI, smoke e UAT.** Aprovar privacidade para a configuração
   real do n8n/OpenAI; homologar WhatsApp com dados sintéticos, deduplicação,
   handoff e reconciliação; obter assinatura física da ficha v5 e aceite de
   Produto/Operação. Publicar CRM compatível antes do workflow.

A checagem registrou os gaps; nenhuma dessas correções operacionais foi
executada ou inferida. A validação local completa informada pelo Tech Lead
passou com 647 testes e três skips; E2E com 107 testes e sete skips; audit sem
vulnerabilidades. Esses resultados não fecham gates externos ou privados.

## Repetir as checagens públicas

Substituir o host somente depois de confirmar o ambiente alvo. A saída abaixo
descarta corpos e registra apenas status, validação TLS e redirecionamento:

```powershell
rtk proxy curl.exe -sS --max-time 20 -o NUL -w 'HTTP=%{http_code} TLS=%{ssl_verify_result}\n' https://<host>/healthz
rtk proxy curl.exe -sS --max-time 20 -o NUL -w 'HTTP=%{http_code} TLS=%{ssl_verify_result}\n' https://<host>/api/health/live
rtk proxy curl.exe -sS --max-time 20 -o NUL -w 'HTTP=%{http_code} TLS=%{ssl_verify_result}\n' https://<host>/api/health/ready
rtk proxy curl.exe -sS --max-time 20 -o NUL -w 'HTTP=%{http_code} redirect=%{redirect_url}\n' http://<host>/healthz
rtk proxy curl.exe -sS --max-time 20 -o NUL -w 'HTTP=%{http_code}\n' https://<host>/api/v1/sessions/current
rtk proxy curl.exe -sS --max-time 20 -o NUL -w 'HTTP=%{http_code}\n' https://<host>/api/v1/inbox/conversations
```

O gate continua aberto até conferir o ambiente alvo e fechar as evidências
privadas, o smoke, os alertas, o restore e o rollback. Disponibilidade pública
observada em cloud-dev não é aceite de produção.
