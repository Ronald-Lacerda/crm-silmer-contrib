# Supply chain da Fase 0

## Rastreabilidade e limite

Esta entrega implementa `T00.2` e é um enabler técnico correlato a `MSG-02` e
`MSG-03`: torna releases identificáveis e repetíveis para que as futuras
rotinas de pendência, recuperação e indisponibilidade possam ser operadas com
segurança. Ela **não satisfaz** o comportamento funcional de `MSG-02` nem de
`MSG-03`; esses critérios dependem das fatias de canais, filas e interface.

## Build e promoção

- Pull requests executam lint/checkJs, unitários, E2E com axe-core, auditoria
  de dependências, build/scan das duas imagens e `git diff --check`.
- E2E e PostgreSQL executam em jobs paralelos; os testes de banco continuam
  serializados em um banco dedicado. O check `Lint, tests, E2E and dependencies`
  exige sucesso dos dois jobs antes de liberar as imagens. Para desfazer essa
  organização, reverta o commit da tarefa OPS-CI-02 (INT-3 / T00.2).
- O merge em `master` constrói `edge-web` e `runtime` uma única vez em layouts
  OCI locais, executa o Trivy antes de qualquer upload e somente então copia os
  mesmos manifestos, sem rebuild e preservando os digests, para a tag
  publicável `github.sha` no GHCR.
- Os builds publicados levam SBOM e provenance OCI gerados pelo BuildKit.
- O workflow manual recebe um SHA completo, seleciona uma execução `push`
  bem-sucedida para aquele SHA em `master`, baixa os artifacts de digest desse
  run e os compara com as tags no GHCR. Só então produz, sem rebuild, um
  manifesto cujas referências de `edge-web` e `runtime` são idênticas por
  digest em dev e hml. A promoção deve ocorrer dentro da retenção de 30 dias
  desses artifacts.
- A operação mantém o deploy automático GitHub → EasyPanel existente,
  conforme a [ADR 022](../adr/022-manter-deploy-automatico-github-easypanel.md).
  A publicação GHCR não comprova que o painel consome essa imagem nem espera
  o CI. Conferir gatilho, SHA/build/imagem implantados e release anterior
  recuperável no [relatório operacional](../runbooks/production-readiness-checks.md).
  O workflow manual acima é uma ferramenta auxiliar de conferência de digests,
  não uma exigência para substituir o fluxo existente.

## Pins verificados em 30/08/2026

As Actions usam o commit completo do release oficial. As bases usam o digest
do índice OCI oficial resolvido com `docker buildx imagetools inspect`:

| Componente | Referência imutável                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Node.js    | `node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e` |
| Nginx      | `nginx:1.31.4-alpine-slim@sha256:1870de6d59aafee152589b64404556d2535922cdd998e6dac1c4888c938ed8f9`   |

Atualizar um pin exige PR próprio, nova resolução em fonte oficial, build,
scan e registro do novo digest; aliases mutáveis não entram em deploy.

## Scanner

### Correção do bloqueio de release em 05/10/2026

O CI de `master` após a PR #142 (`2979c812`, run `37394796634`)
publicou `edge-web`, mas bloqueou `runtime` antes do login no GHCR. O Trivy
encontrou três vulnerabilidades críticas corrigíveis em
`perl-base 5.36.0-7+deb12u3`: `CVE-2026-13221`, `CVE-2026-42496` e
`CVE-2026-8376`. A imagem mantém sua base Node por digest e atualiza somente
`perl-base` durante a instalação dos pacotes de runtime. O build exige versão
igual ou superior a `5.36.0-7+deb12u4`, a correção publicada pelo Debian.
O scan continua obrigatório, com as mesmas severidade e condições de bloqueio.

Fontes: [CI do SHA integrado](https://github.com/romulosutil/crm-silmer/actions/runs/37394796634),
[Debian CVE-2026-13221](https://security-tracker.debian.org/tracker/CVE-2026-13221),
[Debian CVE-2026-42496](https://security-tracker.debian.org/tracker/CVE-2026-42496)
e [Debian CVE-2026-8376](https://security-tracker.debian.org/tracker/CVE-2026-8376).

A falha anterior de publicação de `edge-web` no run `37114381756` saiu com
código 255 após a cópia dos manifestos. Ela não se repetiu no run atual; os
logs antigos não comprovam sua causa. A extração de digest, porém, fechava o
pipe ao encontrar o primeiro header. Sob `pipefail`, isso pode reprovar um
inspector que ainda escreve detalhes. A publicação e a resolução para
promoção agora consomem toda a saída e continuam comparando o primeiro digest
com a referência aprovada. O teste de regressão exercita um pipe real com
saída extensa, falha do produtor e header ausente. A validação remota do novo
build e do scan pertence ao CI do commit que contém a correção.

Trivy foi escolhido por reunir vulnerabilidades de pacotes e imagem em um
scanner conhecido, reproduzível e integrável ao GitHub Actions. Ele roda no
CI sobre o layout OCI local e antes de existir qualquer artefato no GHCR:
achados críticos corrigíveis bloqueiam a publicação/promovibilidade, enquanto
o relatório continua visível. Assim, um candidato reprovado nunca fica
disponível, nem mesmo temporariamente, no registry público.

Trivy **não roda no runtime**. Embutir scanner e banco de vulnerabilidades nas
imagens aumentaria tamanho, superfície de ataque e privilégio operacional, além
de envelhecer o banco junto com o container. O runtime fica mínimo e não-root;
o scanner é atualizado e executado na fronteira de build/CI.

## Verificação local

```powershell
npm ci
npm run validate
npm run test:e2e
npm audit --audit-level=high
docker build --file docker/edge-web.Dockerfile --tag crm-silmer-edge-web:test .
docker build --file docker/runtime.Dockerfile --tag crm-silmer-runtime:test .
git diff --check
```
