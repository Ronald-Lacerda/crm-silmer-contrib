# Validar áudio Chromium/Firefox em Linux local

Rastreabilidade: SIL-36 / PR #301 / T19 / MED-09–10.
O teste usa `getUserMedia` e `MediaRecorder` nativos com dispositivo sintético,
reproduz a mídia e confirma MIME, `paused=false`, ausência de erro e descarte.
As assertions de `test/e2e/audio-recorder.spec.js` permanecem intactas.

## Diagnóstico e ambiente

No Windows desta validação, o Firefox 153/build 1538 não inicia: o erro
genérico `spawn UNKNOWN` corresponde a WinError 14001 e o log SideBySide
identifica a dependência `mozglue`. A reinstalação oficial com
`npx playwright install --force firefox` não resolveu esse host.

O gate foi executado com sucesso em cópia isolada do commit
`26975c705f9110d106792a9c07d764d971e2b2d4`, dentro da imagem oficial
`mcr.microsoft.com/playwright:v1.62.1-noble`, digest
`sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`.
Node 24.20.0, npm 11.19.0 e Playwright 1.62.1 foram fixados.
PulseAudio com null sink segue o preparo de áudio do CI.

Não há endpoint de navegador exposto, porta publicada ou mount do checkout.
O container recebe somente o arquivo produzido por `git archive`; não recebe
`.env`, credenciais, banco ou dados de produção. O Docker utilizado é local
(`npipe:////./pipe/dockerDesktopLinuxEngine`). Não executar esta receita em
um contexto Docker remoto ou de produção.

## Reproduzir no PowerShell

Confirme o contexto local e use um nome livre para o container. Os comandos
abaixo executam um commit fixo; para validar outra revisão, troque o SHA.

```powershell
docker context inspect --format '{{.Endpoints.docker.Host}}'
New-Item -ItemType Directory -Force -Path var
git archive --format=tar --output=var/pr301-source.tar 26975c705f9110d106792a9c07d764d971e2b2d4
docker run --detach --rm --init --name silmer-pr301-validation --workdir /work mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e sleep infinity
docker cp var/pr301-source.tar silmer-pr301-validation:/tmp/pr301-source.tar
docker exec silmer-pr301-validation tar -xf /tmp/pr301-source.tar -C /work
docker exec silmer-pr301-validation chown -R pwuser:pwuser /work
docker exec silmer-pr301-validation apt-get update
docker exec silmer-pr301-validation apt-get install --yes --no-install-recommends pulseaudio
docker exec --user pwuser silmer-pr301-validation npx --yes --package=node@24.20.0 --package=npm@11.19.0 -- npm ci
docker exec --user pwuser silmer-pr301-validation pulseaudio --start --exit-idle-time=-1 '--load=module-null-sink sink_name=playwright'
docker exec --user pwuser silmer-pr301-validation npx --yes --package=node@24.20.0 --package=npm@11.19.0 -- playwright test test/e2e/audio-recorder.spec.js --grep 'actual .* synthetic device' --workers=1
```

Resultado focal observado: **2 aprovados, zero falhas e zero skips**,
incluindo Firefox. Não configure `PW_FIREFOX_WS_ENDPOINT` nesta receita:
o navegador e os servidores das fixtures ficam no mesmo container, e o
teste usa seu caminho de lançamento nativo Linux.

Para a validação completa, execute sequencialmente no mesmo container:

```powershell
docker exec --user pwuser silmer-pr301-validation npx --yes --package=node@24.20.0 --package=npm@11.19.0 -- npm run validate
docker exec --user pwuser silmer-pr301-validation npx --yes --package=node@24.20.0 --package=npm@11.19.0 -- playwright test --workers=2 --retries=2
docker exec --user pwuser silmer-pr301-validation npx --yes --package=node@24.20.0 --package=npm@11.19.0 -- npm audit --audit-level=high
docker stop silmer-pr301-validation
```

Resultado integral final: `npm run validate` com **1.757 aprovados, 16 skips
de PostgreSQL sem banco de teste, zero falhas/cancelamentos e build**; E2E com
**505 aprovados, sete skips legados, zero falhas e nenhum retry consumido**.
A opção `--retries=2` reproduz a política já definida para CI.

`--rm` remove o container ao parar. O relatório da
[validação independente](../../.specs/features/workflow-reference/validation.md)
registra os resultados do PR. Isso valida captura/reprodução sintéticas;
microfone físico, WhatsApp e homologação operacional mantêm seus gates.

Referência do fornecedor: [Playwright em Docker](https://playwright.dev/docs/docker).
O suporte remoto já existente no teste não foi usado na execução final.
O servidor padrão `run-server` filtra `firefoxUserPrefs`, e `launchServer`
pré-iniciado não configura o proxy de loopback dessa fixture; essas tentativas
não substituem a execução nativa documentada acima.
