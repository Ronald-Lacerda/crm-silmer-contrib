# Imagens recebidas na Inbox

Correção INBOX-IMG-01, vinculada a INBOX-2/3, INB-01..05, MSG-01/02 e
PRV-03 do MVP. Preserva o monólito, o contrato de anexos e a retenção legada.

## Escopo e premissas

O operador confirmou em 28/10/2026 que produção usa WAHA temporariamente.
O workflow implantado diverge do snapshot Meta versionado. A correção deve
ser preparada sobre uma exportação atual do WAHA e preservar seus nós e
conexões de atendimento. Nenhuma execução, envio, publicação, alteração de
configuração ou recuperação de dados reais está autorizada por este documento.

Arquivos de canal continuam transitórios: sete dias do recebimento original
ou encerramento da jornada, o que ocorrer primeiro. O scanner permanece
obrigatório; esta correção não altera a política de mídia do vendedor.
O piloto observado usa uma instância de API. O ingresso protege o ciclo
snapshot, scan e vínculo por mensagem nessa instância; múltiplos processos
ou réplicas exigem coordenação durável antes de escalar.

## Requisitos e critérios de aceite

- **IMG-01:** WHEN uma mensagem recebida possui imagem vinculada, disponível,
  validada e dentro da retenção THEN a API SHALL projetar a mídia na Inbox
  com URL relativa autenticada e entregar os bytes originais para o componente
  de imagem existente, sem expor caminho de disco, URL do provedor ou segredo.
- **IMG-02:** WHEN a leitura não tem sessão, capacidade ou vínculo com a
  conversa THEN a API SHALL negar os bytes; WHEN o arquivo está vencido,
  a jornada terminou, o scanner não liberou ou o conteúdo sumiu/divergiu THEN
  a API SHALL preservar o histórico sem servir o arquivo.
- **IMG-03:** WHEN o patch offline recebe um workflow WAHA compatível THEN
  ele SHALL acrescentar somente um ramo de persistência de imagens, inclusive
  no atendimento humano e em replay, conservando todos os nós e caminhos
  anteriores; esse ramo SHALL não alcançar IA, reserva ou envio de mensagens.
- **IMG-04:** WHEN esse ramo recebe uma imagem THEN ele SHALL validar a URL
  privada do WAHA, impedir redirects, limitar a imagem a 5 MB e enviar bytes,
  MIME, SHA256 e identidade da mensagem pelo endpoint de anexos existente,
  com Basic Auth e chave idempotente estável; uma falha SHALL gerar evento
  redigido, sem texto do cliente, URLs ou detalhes de credencial. WHEN scanner,
  volume ou quota se recuperam de falha temporária THEN a API SHALL permitir
  nova validação do mesmo anexo, sem reiniciar retenção, duplicar bytes ou
  dispensar a inspeção; `rejected`, `deleted` e `lost` SHALL não ser reabertos
  por esse retry. Quarentena por assinaturas antigas SHALL ser revalidada
  sobre a mesma cópia, sem outra ocupação de quota.
- **IMG-05:** WHEN uma imagem antiga é recuperada THEN o upload SHALL manter
  a retenção a partir do recebimento original e SHALL não reexecutar o
  atendimento nem enviar mensagem; a recuperação real depende da disponibilidade
  do arquivo no WAHA e de uma aplicação controlada em produção.

## Entrega e validação

Uma tarefa atômica: INBOX-IMG-01. Arquivos: leitura da Inbox, composição da
API, rota/runtime de mídia recebida, patch offline do n8n, revalidação do volume
transitório e suas guardas de persistência, testes associados e runbook.
Sem migration, alteração de infraestrutura ou publicação neste patch.

Gates locais: testes das rotas/projeção e do patch WAHA, typecheck, lint,
fronteiras, build, regressão e E2E de mídia, `git diff --check`. SQL deve ser
validado em PostgreSQL dedicado com dados sintéticos. Verificador independente
registra evidências e mutações isoladas em `validation.md`.

## Complemento de implantação autorizado em 29/10/2026

O proprietário pediu implantar a ação direta de imagem para pedido e garantir
exibição das imagens recebidas. Tarefa **INBOX-IMG-RELEASE-03**, incluindo a
entrega de **INBOX-IMG-ORDER-01** preparada anteriormente.

- **IMG-06 / ARQ-02:** imagem recebida disponível oferece escolha explícita
  de um pedido pendente vinculado à conversa e cópia como referência.
  Somente responsável ou administrador, em conversa aberta, vê a ação.
- **IMG-07 / ARQ-04:** leitura privada e upload existente preservam os bytes,
  CSRF, autorização, scanner, cinco referências e dez MB por arquivo do pedido.
  Uma resposta incerta reutiliza o mesmo formulário e chave idempotente;
  sucesso só é anunciado após resposta positiva do upload.
- **IMG-08 / PRV-03:** mensagens enviadas, conversa encerrada, pedido confirmado,
  mídia perdida, rejeitada ou vencida não autorizam a cópia.
- **IMG-09:** JPEG, PNG, WebP e GIF válidos, de até cinco MB, são exibidos
  também quando enviados como documento. O tipo canônico `document` permanece;
  o MIME detectado e o scanner determinam se os bytes podem ser servidos.
  PDF e outros documentos não se tornam imagens por nome ou extensão.
- **IMG-10:** imagem recebida sem arquivo disponível mostra aviso explícito.
  Documentos novos preservam apenas MIME raster permitido no conteúdo cifrado
  para esse aviso; históricos sem MIME nem anexo não são inferidos como imagem.
- **IMG-11:** no scheduler v1 do n8n, a persistência da imagem precede os
  demais destinos do inbound. Erro posterior da IA não impede o anexo já salvo;
  falha no relatório de mídia não interrompe o caminho comercial preservado.
  Esse ramo é sequencial: timeouts e retries de mídia podem atrasar o atendimento.

Implantação deve partir da baseline publicada, preservar CP-T09 e migrações,
passar pelos gates e ser conferida no ambiente alvo com bytes e hash.
Nenhum requisito autoriza dispensar scanner, retenção ou limites para prometer
que um arquivo inválido, expirado ou em formato incompatível será exibido.

## Ampliação e download — INBOX-IMG-VIEW-01 (30/10/2026)

- **IMG-12 / MED-25:** imagem disponível permite clique ou teclado para
  ampliar em diálogo nomeado e responsivo, com foco contido, Escape/Fechar
  e retorno à foto. Perda da mídia fecha o diálogo e foca o aviso; troca ou
  saída da conversa fecha a ampliação e cancela downloads pendentes.
- **IMG-13 / MED-16/19:** Baixar imagem na conversa ou na ampliação usa os
  bytes originais pela rota privada existente, sem redirect externo, com
  nome sintético e extensão do MIME JPEG/PNG/WebP/GIF. Falha de acesso,
  expiração ou indisponibilidade anuncia erro sem salvar a resposta como
  imagem. A ação independe de pedido editável e preserva Anexar ao pedido.

## Limites operacionais

Antes da ativação, verificar armazenamento transitório e scanner real da API.
O socket do clamd pertence ao worker; não presumir que a API consegue usá-lo.
Exportar a revisão atual e revisar o diff antes de publicar. Recuperar somente
os anexos afetados, nunca o workflow comercial completo. A evidência local
não confirma exibição das imagens reais em produção.
