# Imagens recebidas — validação independente

## Validation: PASS

Data: 28/10/2026. Revisão final examinada: `dbbb762..c0cc21e`.
Verificador: agente independente `/root/verificar_imagens`, sem autoria do patch.
**O aceite cobre a implementação local e a preparação offline. A aplicação,
recuperação dos anexos reais e confirmação visual em produção continuam pendentes.**

## Achados anteriores encerrados

- A revisão inicial `49b60cd` foi reprovada: falhas transitórias não permitiam
  retomada e o mutante que retirava SHA256 sobrevivia aos testes. A implementação
  final revalida somente estados transitórios permitidos e acrescenta corrupção
  com tamanho idêntico. Os testes correspondentes e os mutantes passaram a
  discriminar ambos os comportamentos.
- A integração identificou também uma corrida entre snapshot, scan e vínculo.
  A fila agora cobre a operação inteira por mensagem na instância de API do
  piloto. O teste PostgreSQL exige duas respostas bem-sucedidas, uma repetida,
  um arquivo, um anexo e uma auditoria. Retirar essa proteção reproduziu
  `unavailable` em vez de `available` e fez o teste falhar.
- O parser offline passou a aceitar a expressão constante de duas strings
  JSON observada no n8n, preservando o nó original. Expressões dinâmicas ou
  executáveis continuam recusadas; não há `eval` ou execução de código do campo.

Não há finding local aberto nesta revisão. O limite de uma instância de API
está declarado na especificação e no runbook; múltiplas réplicas precisam de
coordenação durável antes de escalar.

## Critérios ancorados na especificação

| Critério | Evidência concreta e resultado esperado | Resultado |
| --- | --- | --- |
| IMG-01: projeção e bytes privados | `test/inbound-media-postgres-live.test.js:179`: `assert.equal(media.mediaId, mediaId)`; linha 181: `assert.equal(media.state, 'attached')`; linha 189: `assert.deepEqual(list.items[0].lastMessage.media, media)`; linha 192: `assert.deepEqual(response.rawPayload, bytes)`. `test/inbound-media-content.test.js:97`: bytes originais; linhas 99–101: headers privados e tamanho exato. | Coberto |
| IMG-02: sessão, capacidade, vínculo, retenção, validação e perda | `test/inbound-media-content.test.js:194`: `assert.equal(response.statusCode, status)` para matriz explícita 401/403/404/410/503; linha 195: zero leituras para os bloqueios prévios; linhas 244–248: tamanho igual, status 503 e conteúdo corrompido não entregue. `test/inbound-media-postgres-live.test.js:193`: conversa cruzada 404; linhas 204–205, 221–222, 237–238 e 269–270: estado/URL indisponível ou perdido. | Coberto |
| IMG-03: preservar atendimento e persistir em modo humano/replay sem enviar | `test/waha-inbound-images-patch.test.js:162`: nós anteriores idênticos; linha 169: conexões anteriores preservadas; linha 181: cada destino alcançável pertence aos nós adicionados; linha 186: nove nós alcançáveis. Linha 219 exige condição verdadeira para combinações de modo humano e duplicate; linha 227 exclui outras mensagens. | Coberto |
| IMG-04: URL, tamanho, bytes, autenticação, identidade e falha redigida | `test/waha-inbound-images-patch.test.js:252`: URLs adversariais recusadas; linhas 299–304: binário, SHA256, external ID, idempotência, correlação e conversa exatos; linhas 317–318: ID de 255 caracteres inteiro; linhas 326–350: multipart e headers; linha 383: limite exato de 5 MB; linha 408: objeto de falha com código fixo. Linhas 469–471 preservam a expressão original e resolvem o endpoint esperado; linhas 494–506 rejeitam expressões dinâmicas e destinos inválidos. | Coberto |
| IMG-04/MSG-02: retomar falha transitória sem duplicação ou bypass | `test/inbound-media-postgres-live.test.js:300`: estado recuperado `available`; linhas 301–306: prazo original e um arquivo/anexo. Linhas 354–361: quarentena recupera a mesma storage key, tamanho, prazo e conjunto de arquivos; linhas 379, 388 e 393: rejeitados, descartados e perdidos não voltam ao scanner. Linhas 472–519: concorrência exige `available/clean`, dois fulfilled, duplicate false/true, um arquivo, um anexo, uma auditoria e GET 200. `test/private-media-volume.test.js:254` e linha 259 confirmam estado disponível e nova inspeção da mesma cópia. | Coberto |
| IMG-05: recuperação preserva prazo e não reexecuta atendimento | `test/inbound-media-retention.test.js:73` e linha 77 exigem os instantes originais; linhas 97–104 rejeitam prazo/jornada vencidos sem inserção ou store. `test/inbound-media-postgres-live.test.js:165` confirma replay; o grafo novo não alcança envio. A recuperação real está expressamente fora do aceite local. | Coberto |

Não houve remoção, enfraquecimento ou novo skip de teste preexistente. Os testes
novos mapeiam para IMG-01/02 (conteúdo/projeção), IMG-03/04 (patch, contrato,
falhas e retomada) e IMG-05 (retenção). A rota usa a autorização
`conversation.read` da Inbox, exige vínculo da mensagem com a conversa e
delega UUIDs de mídia do vendedor ao runtime anterior. O patch não altera
framework, scanner obrigatório, infraestrutura ou migrations.

## Sensor de discriminação

Node `24.20.0`. Cópias isoladas no diretório temporário do sistema, sem
`git stash` ou mutação da árvore real. Baselines: 22 testes de conteúdo,
uma integração PostgreSQL e dez testes do patch, todos aprovados.

| Mutação isolada | Evidência de comportamento | Resultado |
| --- | --- | --- |
| Remover bloqueio no prazo exato | `deadline reached` falha | Morto |
| Remover bloqueio por término da jornada | `conversation ended` falha | Morto |
| Remover exigência `validation_status=clean` | `unscanned attachment` falha | Morto |
| Remover comparação SHA256 | Novo caso de um byte alterado com tamanho igual falha | Morto |
| Bypassar `access.authorizeRead` | `actor lacks conversation read` falha | Morto |
| Remover limite de imagem de 5 MB | `image exceeds five MB` falha | Morto |
| Retirar espera da fila de ingresso | PostgreSQL observa `unavailable`, esperado `available` | Morto |
| Desabilitar retomada de estados transitórios | PostgreSQL recebe `ATTACHMENT_NOT_RETRYABLE` e falha | Morto |
| Retirar suporte à expressão URL constante | Caso da expressão implantada falha | Morto |
| Retirar exigência HTTPS do parser | Caso de URL HTTP recusada deixa de lançar e falha | Morto |

Resultado final: **10/10 mutantes mortos, zero sobreviventes**. Os oito
mutantes do core usaram `c115145`; a inspeção do diff confirmou que o core
permaneceu idêntico em `c0cc21e`. Os dois mutantes do parser usaram `c0cc21e`.
Em cada execução, `git status --porcelain` era vazio antes e depois,
confirmado por assertion; as cópias temporárias foram removidas. A escrita
deste relatório ocorreu somente depois de todos os sensores.

## Gates e limites de evidência

- Reexecutados pelo verificador: 33/33 testes de volume, conteúdo e retenção;
  10/10 testes do patch; integração PostgreSQL 1/1. Zero skips nesses gates.
- Gate completo do integrador, log `var/inbound-validate-release.log`
  inspecionado: 1.150 aprovados, zero falhas, cinco skips condicionais;
  tipos, lint, formatação, fronteiras, tokens, validadores e build aprovados.
- Regressão E2E registrada pelo integrador: 320 aprovados e sete skips
  existentes na primeira execução; os quatro casos que falharam por condições
  do host passaram na reexecução com um worker e Firefox Linux previsto pelo
  repositório. Nenhum teste foi enfraquecido para essa recuperação.
- Smoke n8n 2.38.7 isolado: resultado sintético inspecionado com um inbound,
  download e upload, zero falhas/envios, boundary/hash/identidade/bytes corretos.
- As duas lições dos achados iniciais foram registradas pelo integrador;
  este passe não criou novo sinal nem alterou o catálogo.

## Pendências de produção

O aceite local não confirma a exibição das imagens reais. A inspeção remota
do integrador encontrou duas mensagens de imagem sem anexo vinculado; a API
não tem o volume transitório nem os recursos de scanner presentes no worker.
Preparação de mounts, aplicação do CRM, publicação do ramo WAHA, scan real,
recuperação pontual dos anexos e confirmação visual continuam pendentes de
procedimento autorizado. Não foi realizada mutação de produção pelo verificador.
