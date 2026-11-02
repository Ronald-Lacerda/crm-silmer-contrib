# Melhor Envio — conexão e cotação

## Cotação na conversa vinculada ao pedido — T139

[ADR 054](../adr/054-cotacao-na-conversa-vinculada-ao-pedido.md), MEVQ-01–08.
O responsável humano ou administrador abre **Cotar frete** na conversa e
escolhe explicitamente o Assunto com Pedido. Um CEP na mensagem oferece
atalho para preencher o destino. Informar CEP de origem, peso total, medidas
e seguro da embalagem; consultar e escolher o serviço para vincular a
estimativa. A seleção não muda o Valor final. A resposta sugerida vai para o
campo de composição e preserva o rascunho, com revisão e envio humanos.

Para ativar a entrega, aplicar migration expand 0050 antes da API e edge da
mesma revisão, mantendo a configuração e a conta T138. Não há novo scope,
credencial ou serviço. `shipping.quote` permite a cotação operacional; a
administração da conta continua exigindo `shipping.manage`.

CEPs e resposta do provedor ficam no envelope cifrado da cotação no
PostgreSQL. A chave privada `MELHOR_ENVIO_ENVELOPE_KEY` também protege essas
estimativas; preservar sua cópia segura separada para recovery. Não rotacionar
a chave sem considerar as cotações históricas. Audit e idempotência não
armazenam CEP em claro; backups seguem os controles comerciais existentes.
O vínculo ao pedido e a estimativa seguem a classe `commercial-documents` do
catálogo aprovado; esta fatia não altera prazos ou aprovações daquele catálogo.

Alterar o pedido torna a estimativa desatualizada por versão, mesmo quando a
edição não envolve a grade. Repetir consulta com entradas diferentes substitui
a anterior; editar entradas no diálogo descarta o resultado local. Se houver
troca de responsável, Assunto ou atendimento durante uma consulta, a API
recusa o vínculo. Refazer a seleção do alvo após atualizar o atendimento.
Conta desconectada/indisponível pede ação do administrador; não usar preços
manuais como se fossem resultado da integração.

Homologar com dados sintéticos: vendedor dono, administrador, outro vendedor
e Financeiro; dois Assuntos com pedidos diferentes; cálculo, escolha, reload,
mudança de grade, erro do provedor e resposta tardia; teclado/foco no diálogo
e revisão do composer sem envio. Conferir Valor final/status inalterados.
Compra, etiqueta e validade comercial fixa continuam fora da entrega.

Rollback: voltar API e edge para a revisão anterior preservada, sem remover
a migration aditiva nem os envelopes. A cotação administrativa T138 permanece
disponível naquela revisão. Não restaurar banco como primeira medida.

T138 / MEVC-01–08 / ADR 053. Conta verificada não significa API conectada.

## Preparar e ativar

1. Publicar API e edge-web da mesma revisão, aplicar migration expand 0049
   pelo procedimento existente e conferir health/readiness. Preservar digest
   anterior e backup. Não mudar deploy para branch de desenvolvimento.
2. No Sandbox oficial, criar conta de testes e aplicativo **CRM Silmer**.
   Cadastro, senha, CAPTCHA e termos respeitam a participação/autorizações do
   operador. Nunca salvar senha/token em documentação, issue ou chat.
3. Registrar callback HTTPS exatamente igual à rota do CRM `/melhor-envio`.
   Sandbox e produção usam credenciais separadas. A URL de testes do cadastro
   deve apontar para um ambiente acessível apropriado.
4. Configurar somente na API as variáveis abaixo, com e-mail de suporte
   autorizado. `.env.example` é inventário vazio, não arquivo de segredos.
5. Entrar no CRM como administrador, abrir Melhor Envio e conectar. Conferir
   consentimento restrito a `shipping-calculate shipping-companies`.
   Antes do primeiro callback, conferir também os logs do proxy externo do
   EasyPanel: não podem registrar query/Referer de `/melhor-envio`. O nginx do
   edge usa formato sem query, suprime logs desse caminho inclusive erros e
   aplica `private, no-store`; comandos da API e auditoria continuam observáveis.
   O smoke do CI executa nginx real, callback sintético 200/404 e procura
   marcadores de code/state/Referer nos dois streams de log.
6. Cotar com CEPs públicos de teste e peso/medidas sintéticos explícitos.
   Registrar apenas sucesso/códigos, revisão e ambiente. Reiniciar API e
   repetir para verificar persistência; testar renovação em ambiente dedicado.
7. Só ativar produção após homologação aplicável. Esta fatia consulta frete;
   não compra etiqueta nem recarrega carteira.

| Variável privada da API      | Uso                                                                     |
| ---------------------------- | ----------------------------------------------------------------------- |
| `MELHOR_ENVIO_ENABLED`       | `true` habilita; ausente/`false` mantém indisponível.                   |
| `MELHOR_ENVIO_ENVIRONMENT`   | `sandbox` (padrão) ou `production`; URLs oficiais fixas.                |
| `MELHOR_ENVIO_CLIENT_ID`     | ID do aplicativo no ambiente escolhido.                                 |
| `MELHOR_ENVIO_CLIENT_SECRET` | Segredo do aplicativo; nunca frontend/worker.                           |
| `MELHOR_ENVIO_REDIRECT_URI`  | HTTPS, sem query/fragmento, caminho `/melhor-envio`, igual ao cadastro. |
| `MELHOR_ENVIO_USER_AGENT`    | Nome da aplicação e e-mail autorizado de suporte.                       |
| `MELHOR_ENVIO_ENVELOPE_KEY`  | Chave aleatória própria de 32 bytes em base64; backup seguro separado.  |

Tokens ficam em `crm.shipping_connections.token_envelope`, cifrados com
AES-256-GCM e contexto próprio. `shipping_oauth_states` contém hashes de
estado/sessão, ator e prazo de dez minutos; expirados são limpos na próxima
autorização. CEP e cotação não são persistidos. Backups contêm envelopes
antigos e seguem retenção/isolamento aprovados do PostgreSQL. Desconexão local
não revoga cópias no provedor: revogar também o aplicativo no Melhor Envio ao
retirar a integração.

## Recuperação e diagnóstico

### Callback no Traefik do EasyPanel

O access log do Traefik 3.6.7 inclui a query do pedido HTTP. Proteger apenas
o nginx não protege o código OAuth no proxy externo. Antes de conectar uma
conta, conferir a rota HTTPS efetiva no dashboard do Traefik e acrescentar
uma rota de maior prioridade para o caminho exato do callback, com
`observability.accessLogs=false`. Preservar entrypoint, serviço, middlewares,
opções TLS e certificado da rota atual; não desabilitar os logs globais.

Configuração observada e aplicada em 01/11/2026, mesclada no `http.routers`
customizado existente do EasyPanel:

```json
{
  "silmer-melhor-envio-callback": {
    "entryPoints": ["https"],
    "rule": "Host(`crm.silmer.com.br`) && Path(`/melhor-envio`)",
    "priority": 10000,
    "service": "espectro-mvp_silmer-edge-web-1",
    "middlewares": ["bad-gateway-error-page@file"],
    "tls": {
      "options": "default",
      "certResolver": "letsencrypt",
      "domains": [{ "main": "crm.silmer.com.br" }]
    },
    "observability": { "accessLogs": false }
  }
}
```

Esse fragmento não substitui o documento completo: preservar os demais
campos, incluindo `n8n-security-headers`. Nomes dependem da configuração
efetiva e devem ser reconferidos se o domínio/serviço mudar. O reload é
dinâmico, sem reiniciar o proxy. Rollback remove somente essa rota adicional
ou restaura a configuração customizada anterior preservada privadamente;
desabilitar a integração antes de restaurar logs do callback.

Verificar o stream de logs **ao vivo**: enviar primeiro um callback com
code/state/Referer sintéticos e depois um GET em outro caminho com marcador
de controle. O controle deve aparecer e os marcadores do callback devem
estar ausentes. Confirmar callback HTTPS 200, `private, no-store`,
`Referrer-Policy: no-referrer`, headers existentes e HTTP → HTTPS. A tela de
logs pode carregar um trecho histórico antigo antes de acompanhar o stream;
ausência de um probe enviado antes da assinatura não é evidência suficiente.

### Falhas da integração

- **Não configurado:** conferir nomes, ambiente, HTTPS/callback, User-Agent
  com e-mail e tamanho da chave, sem imprimir valores.
- **Estado inválido/expirado:** iniciar conexão na mesma sessão; não repetir
  callback antigo.
- **Reconectar:** revogação, envelope ilegível ou rotação incerta exigem novo
  consentimento. Não recuperar reutilizando refresh token em log.
- **Renovação em andamento:** a reserva é persistida antes da chamada remota;
  outra réplica recebe `MELHOR_ENVIO_REFRESH_IN_PROGRESS` por até 60 segundos.
  Reserva expirada exige reconectar e nunca reutiliza o refresh token antigo.
- **Frete indisponível/422:** conferir CEP, peso, medidas e seguro; erros
  livres do provedor são substituídos por códigos fixos.
- **429/timeout/5xx:** esperar e solicitar nova cotação; não há retry automático.
- **Rollback:** desabilitar `MELHOR_ENVIO_ENABLED` e reimplantar imagem anterior
  verificada. Migration aditiva permanece; não apagar tabelas/credenciais ou
  backups. Rotacionar chave exige recifrar envelopes ou reconectar explicitamente.

## Evidência operacional de 01/11/2026

- Chrome: conta de produção verificada; nenhum aplicativo cadastrado.
- Sandbox: cadastro concluído após aceite explícito dos termos pelo proprietário,
  com 1.000 envios e saldo fictício. Troca do e-mail aguarda SMS do provedor.
  Aplicativo OAuth criado com autorização explícita, sem valores de credencial
  neste documento. Não há cotação real ou homologação de etiquetas.
- EasyPanel: serviços `espectro-mvp/silmer-api`, `silmer-edge-web`,
  `silmer-worker` e PostgreSQL preservados. Nenhuma variável `MELHOR_ENVIO_*`
  na consulta inicial. API com autoDeploy desabilitado; edge/worker habilitados.
  Não alterar silenciosamente essa configuração.
- Gates locais e PR: registrar em T138. Ativação real pendente até credenciais,
  consentimento e evidência do Sandbox.
- Configuração privada da API salva após aprovação específica do proprietário
  para a substituição do documento de ambiente. Leitura posterior confirmou
  exatamente as sete variáveis novas e a preservação dos valores anteriores;
  `MELHOR_ENVIO_ENABLED=false`. Nenhum deploy solicitado, revisão em execução
  permanece na master anterior. Sessão administrativa do CRM confirmada.
- CI da revisão `65eb625`: estáticos/unit/build, smoke nginx real, PostgreSQL,
  E2E/axe e audit passaram. Revisão de dependências falhou porque o serviço do
  GitHub não está disponível no repositório. Classificador local corrigido para
  reconhecer somente vínculos exatos entre workspaces privados verificados no
  manifesto e lock de ambos os commits; versões externas, scripts, flags,
  metadata, Actions e inconsistências continuam exigindo revisão. Comparação
  real retorna `required=false`; 13 testes do classificador passaram. Repetir
  o CI antes da publicação.
- Configuração/ambiente customizado do Traefik consultados sem encontrar
  diretiva de access log. Isso não comprova os argumentos efetivos do proxy;
  manter o gate de ausência de code/state/Referer em logs antes do OAuth real.

### Publicação autorizada

- [PR #258](https://github.com/romulosutil/crm-silmer/pull/258) integrada por
  rebase em `09c259e61abcb30402e616aeca136c604fd734f3`, após
  [CI da PR](https://github.com/romulosutil/crm-silmer/actions/runs/41356852137)
  completo. O [CI da master](https://github.com/romulosutil/crm-silmer/actions/runs/41358341331)
  também concluiu estáticos, PostgreSQL, E2E/axe e build/scan/publicação das
  imagens com sucesso. Um job Dependabot separado falhou; não é o pipeline
  da entrega.
- Backup prévio `silmer-pre-mev-t138-20261101` concluído no PostgreSQL:
  783 kB, 22:39:56 UTC, no provedor Local Disk. Isso não comprova backup
  externo ou um drill de restauração. Revisão anterior recuperável:
  `2da566be5f79427adde071c70fc1b7957f057589`.
- API, edge-web e worker observados na revisão publicada, em execução e
  saudáveis. IDs das imagens construídas pelo EasyPanel (não confundir com
  os digests publicados no GHCR): runtime/API/worker
  `sha256:f130b5226d33ec07e456c7ede119545b05de8569214dd087ed13cab72a007f0c`;
  edge-web `sha256:7aef46a21ad1c9eeb2e14202d6eb93bf3f02d8f668e39a663a38708aaafa0ca9`.
- Ledger anterior em 0048. CLI expand da nova API aplicou exatamente uma
  migration; repetição aplicou zero. Ledger 0049 conferido com checksum
  `8aab647c6b8d8888843de476cedadd6331f2df8a4c3fadf86d6d0f6037d299f4`,
  e ambas as tabelas existentes. Readiness público retornou `ready`.
- `MELHOR_ENVIO_ENABLED=true`, com ambiente `sandbox`, salvo por substituição
  verificada do documento privado, alterando somente a flag. API reiniciada
  sem rebuild; interface confirmou conta desconectada em testes. As demais
  variáveis e a configuração de autoDeploy foram preservadas.
- Probe inicial demonstrou vazamento de marcadores sintéticos no Traefik.
  Rota adicional acima aplicada após conferir no dashboard os controles
  originais. A revisão automática rejeitou a primeira proposta sem essa
  comprovação; a configuração corrigida preserva middleware e TLS efetivos.
  Probe ao vivo de 22:57:31 UTC: callback 200 sem marcadores no stream,
  controle positivo em outro caminho presente; HTTPS e headers preservados.
- Consentimento Sandbox concluído com somente cotação e transportadoras,
  após autorizações específicas para termos, endereço sintético e regras
  finais de postagem exigidas pelo provedor. Usada a unidade de teste
  `Agencia SP platform-3`; geolocalização do operador não foi solicitada.
  A tentativa longa inicial não concluiu no CRM; nova tentativa com estado
  novo conectou, mantendo o prazo e a proteção de uso único do estado.
  Interface confirmou conta conectada em testes e validade até 01/12/2026.
- Cotação remota no Sandbox com dados aprovados: CEPs públicos de teste
  01001-000 → 20040-002, 1.000 g, largura 20 cm, altura 15 cm, comprimento
  10 cm e valor segurado de R$ 100. Retornaram quatro opções: PAC, SEDEX,
  Jadlog .Package e .Com, com valores e prazos exibidos; Mini Envios apareceu
  indisponível, coerente com a embalagem. Esses resultados são de testes,
  não condições comerciais de produção. Nenhum pedido, etiqueta ou compra.
- API reiniciada sem rebuild após a conexão. Conferido que apenas a nova
  instância permaneceu em execução, saudável, com a mesma imagem. Readiness
  retornou `ready`; reload do CRM preservou a conta conectada. A mesma cotação
  foi repetida e retornou as mesmas quatro opções, validando persistência
  dos tokens e uso pela nova instância. Renovação por expiração permanece
  coberta pelos testes dedicados, sem forçar expiração da conta conectada.

Fontes oficiais verificadas em 01/11/2026:
[autenticação](https://docs.melhorenvio.com.br/docs/autenticacao-1),
[autorização](https://docs.melhorenvio.com.br/reference/fluxo-de-autoriza%C3%A7%C3%A3o)
e [introdução da API](https://docs.melhorenvio.com.br/reference/introducao-api-melhor-envio).
Configuração por rota: [observabilidade do Traefik](https://doc.traefik.io/traefik/reference/routing-configuration/http/routing/observability/).
