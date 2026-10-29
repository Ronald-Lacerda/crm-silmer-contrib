# INBOX-IMG-01 — evidência local

Implementação preparada em branch própria a partir de `dbbb762`, sem mudar
produção. Requisitos IMG-01..05; arquivos e limites em `spec.md`.

## Gates

- Node `24.20.0`, npm `11.19.0`, instalação pelo lockfile.
- `npm run validate` final: PASS; 1.150 testes aprovados, zero falhas, cinco skips
  por pré-condições das suítes; tipos, lint, formatação, fronteiras, tokens,
  validadores e build aprovados.
- Testes focais finais de volume, conteúdo e retenção: 33/33, sem skips;
  patch offline: 10/10, sem skips.
- PostgreSQL 17 dedicado, dados sintéticos: integração nova aprovada,
  incluindo upload, replay, projeção list/get, bytes, ACL, retenção e perda.
  Regressão de Inbox/n8n: 15/16 na primeira execução; o cenário concorrente
  falhou por lock timeout durante a carga de E2E e passou isoladamente em
  1,7 s. Nenhum teste ou timeout foi alterado.
  A integração nova passou novamente após corrigir retry e concorrência.
- E2E: 320 aprovados, sete skips existentes e quatro falhas na primeira
  execução com oito workers. Reexecução dos quatro casos com um worker e
  Firefox Linux no servidor de testes já previsto pelo repositório: 4/4 PASS.
  Foram recuperados o teste concorrente de captura, dispositivos sintéticos
  Chromium/Firefox e a navegação mobile que teve `ERR_NO_BUFFER_SPACE`.
- `npm audit --audit-level=high`: exit 0; três avisos preexistentes (um baixo,
  dois moderados), sem alteração de dependências.
- `git diff --check`: PASS.

## Correções da revisão independente

A revisão inicial identificou retry impossível depois de falha temporária do
scanner e um teste de hash mascarado pela diferença de tamanho. A correção
permite somente estados transitórios conhecidos, revalida a cópia existente
sem outra ocupação e adiciona corrupção de um byte com tamanho idêntico.

O teste concorrente reproduziu outra falha: duas tentativas podiam rebaixar
o arquivo já limpo para indisponível. A API agora serializa descoberta, scan
e vínculo por mensagem na instância do piloto. Nos dois cenários concorrentes
(quarentena e indisponível sem cópia), ambas as requisições concluem e deixam
um arquivo, um anexo e uma auditoria, `available/clean`, prazo preservado e
GET 200. Múltiplas instâncias exigem coordenação durável antes de escalar.

O sensor e o veredicto finais pertencem ao relatório independente
`validation.md`; o relatório preliminar não autoriza ativação.

A inspeção dos parâmetros ativos identificou URL de inbound como concatenação
de duas strings constantes. O preparador aceita esse formato por regex
restrita e `JSON.parse`, sem executar expressões. Os testes preservam a URL
original e rejeitam variáveis, código, templates e caminhos incompatíveis.

## n8n real, isolado

n8n `2.38.7` em container `--network none`, mocks somente em loopback,
HTTPS com CA sintética confiada, Basic e credenciais de header sintéticas.
O inbound respondeu modo humano e `duplicate=true`. Resultado: um download,
um upload, zero falhas e zero envios. Boundary multipart, SHA256, idempotência,
schema, identidade da mensagem, MIME e bytes originais conferiram.

Artefatos sintéticos locais ignorados: `var/waha-inbound-smoke/result.json`
e log de execução. Não contêm credenciais ou dados de produção e não substituem
ensaio operacional no ambiente remoto.

## Evidência remota e pendências

Ações remotas foram somente leitura da interface e consultas de existência
de recursos; SQL usou conexão read-only e devolveu somente contagens. A API
não tem volume transitório presente nem acesso ao socket e às assinaturas
que existem no worker. A conversa tem duas imagens e zero anexos vinculados.

Aplicação, revisão dos mounts, scan real, publicação do workflow, recuperação
pontual e confirmação visual na conversa permanecem pendentes. O procedimento
está em `docs/runbooks/inbound-images-inbox.md`. Não declarar o incidente
resolvido ou as imagens exibidas em produção com esta evidência local.
