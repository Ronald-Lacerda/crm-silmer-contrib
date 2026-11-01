# Melhor Envio — conexão e cotação

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

Fontes oficiais verificadas em 01/11/2026:
[autenticação](https://docs.melhorenvio.com.br/docs/autenticacao-1),
[autorização](https://docs.melhorenvio.com.br/reference/fluxo-de-autoriza%C3%A7%C3%A3o)
e [introdução da API](https://docs.melhorenvio.com.br/reference/introducao-api-melhor-envio).
