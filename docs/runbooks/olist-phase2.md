# Olist — fundação de dados, habilitação e conexão

Entrega OLIST-F2: OLIST-T03/T04/T19/T05; requisitos OLIST-02–08, 11–16,
23, 25–30, 32–33, 35–39 e 48. Implementa a Fase 2 da
[RFC 050](../rfc/050-geracao-assistida-de-pedidos-no-olist.md) sob as
[ADRs 057](../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
e [059](../adr/062-olist-exportacao-com-unitario-exato-em-centavos.md).
O RFC e o checkpoint da Fase 1 são mantidos pela entrega documental separada.

## Comportamento entregue

Usuários tem checkbox Habilitado Olist independente de perfil e responsável.
Default falso, sem habilitação de conta real por migração. Admin pode habilitar
outro usuário ou se desabilitar; auto-habilitação é recusada. A versão de
autorização sobe em toggles e desativação/reativação. Sessões continuam
autenticadas para outras ações, mas o acesso Olist sempre relê a autorização
atual. Jobs futuros devem comparar a versão congelada, não só o booleano.

A entrada Olist permite ao usuário habilitado, inclusive Financeiro, localizar
um Pedido pelo número completo NN-CRM ou UUID exato. A projeção contém apenas
ID, número, status, pendência explícita de geração e estado da integração.
Não depende da fila financeira ou do dono. Não concede Inbox, listagem geral,
cadastro completo ou edição comercial. O perfil anterior conserva sua ACL.
Admin sem checkbox gerencia conexão e parâmetros, mas não usa a busca Olist.

**A criação remota permanece desligada nesta fase.** Não há endpoint de
exportação e os métodos fechados de criação do adapter recusam sem HTTP.
Nenhuma variável de ambiente libera esse bloqueio. A conferência de completude,
subtotal/legado/loja, sequência de cadastros e handlers do worker são tarefas da
Fase 3. missing_fields vazio de confirmado não significa pronto para exportar.

## Dados e concorrência

As migrações expand 0063/0064 acrescentam apenas colunas/tabelas e alargam a
outbox preservando os tipos anteriores. Não reescrevem fichas, pagamentos,
status ou templates. Numeradas depois da última migração da master (0062) na
integração de 08/11/2026; veja [Integração com a master](olist-phase5.md#integração-com-a-master).

- Conexão por aplicativo/callback/conta esperada com versão e geração; conta
  identificada por HMAC do documento normalizado, nunca documento em claro.
- Settings centrais por conta, cifrados, com revisão e ator; vendedor ERP não
  deriva do responsável CRM. Não preencher valores comerciais por inferência.
- Recursos com unicidade por conta/tipo/identidade HMAC; pai/variação também
  compartilham a conta e a FK exige pai produto. Preço negociado não participa
  da identidade do produto. Texto comercial é aparado, NFC e minúsculo pt-BR;
  sinônimos não são automaticamente equiparados.
- Exportação única por conta/Pedido e por ID remoto, snapshot cifrado imutável,
  referência estável, vínculos e tentativas independentes. Reserva, evento e
  outbox compartilham uma transação; jobs carregam somente olist_export_id.
- Eventos append-only e tentativas duráveis. Resultado incerto preserva a
  reserva e impede outra criação. Resultado já iniciado pode ser persistido
  depois de revogar usuário, sem conceder poder para novo efeito.
- Novas contas têm creation_enabled=false e recovery_required=true.
  A fase 2 não expõe comando para alterar essas guardas. A fila olist está
  separada da default, sem handler de geração nesta entrega.
- Quota PostgreSQL por conta coordena réplicas/API/worker: limite conservador
  de 30 chamadas/minuto, reserva consumida mesmo em falha, restante remoto
  nunca aumenta por resposta fora de ordem e 429 aplica bloqueio compartilhado.
  Buscas percorrem no máximo 5 páginas/250 candidatos; truncamento é erro,
  não prova de ausência. Não há retry automático.

AES-256-GCM usa chave própria Olist, versão de chave 1 e AAD por finalidade,
conta e entidade. Copiar envelope entre linhas/contas/finalidades falha.
Documento e parâmetros não entram em jobs ou mensagens de erro. Auditoria usa
somente códigos fixos; motivo humano é validado, sem copiar texto livre para
logs/auditoria. Respostas idempotentes usam o envelope da infraestrutura atual.
As chaves devem ter backup privado separado; troca sem migração/reconciliação
torna vínculos HMAC/envelopes antigos ilegíveis.

## Configuração privada, sem ativação automática

A configuração é somente da API nesta fase. O worker não recebe novos
segredos enquanto não houver handler autorizado. Ausência/configuração inválida
mantém startup operacional e Olist indisponível.

| Variável                        | Uso                                                             |
| ------------------------------- | --------------------------------------------------------------- |
| OLIST_ENABLED                   | true habilita apenas conexão/consultas; ausência/false desliga  |
| OLIST_CLIENT_ID                 | Aplicativo privado autorizado                                   |
| OLIST_CLIENT_SECRET             | Segredo só da API; nunca UI, log ou arquivo versionado          |
| OLIST_REDIRECT_URI              | HTTPS exato, mesma origem APP_ORIGIN, caminho /olist, sem query |
| OLIST_EXPECTED_ACCOUNT_DOCUMENT | Identidade privada esperada; /info precisa coincidir            |
| OLIST_ENVELOPE_KEY              | Chave aleatória de 32 bytes base64, exclusiva Olist             |
| OLIST_IDENTITY_HMAC_KEY         | Outra chave aleatória de 32 bytes base64, distinta da anterior  |
| IDEMPOTENCY_ENVELOPE_KEY        | Chave existente para respostas idempotentes                     |

URLs de autorização/token/API são oficiais fixas, com redirect HTTP recusado,
timeout de 15s, corpo de 256 KiB (32 KiB para token) e erros públicos finitos.
Não presumir sandbox. O OAuth usa scope openid e permissões de módulo do
aplicativo; os consentimentos do provedor podem agrupar incluir/editar, mas
o adapter não expõe atualização/exclusão nem fiscal/estoque/baixa.
[Contrato oficial OAuth](https://api-docs.erp.olist.com/documentacao/comecando/autenticacao).
PKCE não é anunciado como comprovado pela prova atual.

Catálogos consultáveis são somente vendedores, depósitos, formas de pagamento,
formas de recebimento e listas de preços, conforme o [schema público v3](https://erp.olist.com/public-api/v3/swagger/swagger-mintlify.json)
consultado em 05/11/2026. A consulta não comprovou rota de natureza de operação;
seu ID central é informado explicitamente e deve ser conferido na ativação.
Não inferir endpoint nem confundir forma de recebimento com prazo de pagamento.

Antes de conectar em ambiente remoto, proteger também o proxy externo:
a rota HTTPS exata /olist no Traefik/EasyPanel precisa suprimir access logs
(incluindo query e Referer), preservando serviço/TLS/middlewares. O nginx desta
entrega suprime logs de acesso/erro desse caminho e retorna private,no-store
também em 404. O código/state são removidos da URL antes de criar o Vue Router.
O smoke CI verifica ambos streams com marcadores sintéticos em 200 e 404.
Isso não comprova a configuração do proxy remoto, que precisa de evidência
própria antes do primeiro consentimento.

## OAuth, recuperação e rollback

Estado OAuth aleatório de dez minutos, hash persistido, ligado a ator/sessão
e versão da conexão. Consumo e reserva são confirmados antes do HTTP. Tokens
só são persistidos depois de /info conferir a conta esperada e de uma nova
checagem de sessão/ACL/fence. A conta diferente não herda configurações/vínculos.

Refresh é reservado por nonce e versão em transação curta e confirmado fora
do HTTP. Outra réplica encontra refresh em andamento; processo morto após
consumir o token exige reconexão. Não reutilizar refresh token após incerteza.
Access/refresh usam expirações devolvidas pelo provedor; se não houver expiração
do refresh, não inventar prazo. Disconnect limpa tokens e estados e incrementa
geração/versão, invalidando retorno tardio. A desconexão local não revoga a
autorização do aplicativo no provedor.

Rollback operacional: desligar OLIST_ENABLED primeiro e manter as tabelas,
vínculos, snapshots e reservas. Não fazer down destrutivo nem apagar/cancelar
entidade ERP. A release anterior continua lendo os pedidos e os tipos antigos
da outbox; a fila olist permanece parada. Para restore, manter criação
desligada e recovery_required=true e reconciliar entidades/vendas da janela
antes de qualquer habilitação futura. Restaurar backup não prova ausência
de efeito externo. Não redefinir HMAC da conta nem reutilizar identidades
como atalho para recriar cadastros.

Homologação de conexão/conta real, parâmetros, proxy externo, digest/health,
permissões, quota da conta e ID privado da única operadora piloto permanecem
gates de ativação posteriores. Esta entrega não executa OAuth real, POST ERP,
deploy, habilitação de usuário real ou piloto.

## Verificação

Use Node 24.20.0/npm 11.19.0. Testes SQL exigem TEST_DATABASE_URL apontando
exclusivamente para crm_silmer_test dedicado; fazem reset de crm/crm_meta.
Runner serial, preservando concorrência interna dos cenários:

```powershell
npm run test:olist:live
npm run validate
npm run test:e2e
npm audit --audit-level=high
git diff --check
```

Os testes cobrem padrões positivos/negativos, concorrência real, dados
sintéticos, revogação, fencing, aritmética já existente e UI teclado/axe.
Mocks não representam contrato remoto. Teste local com PostgreSQL portátil
18.6 verifica SQL/locks; não é evidência de operação EasyPanel/RustFS.
Build do container/nginx real segue no CI, sem Docker disponível nesta máquina.
