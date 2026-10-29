import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const privacy = await readFile(new URL('privacy.cjs', root), 'utf8');
const retention = await readFile(new URL('retention.cjs', root), 'utf8');
const dockerfile = `# syntax=docker/dockerfile:1.7
# EVOL-01. Official Evolution v2.3.7 OCI index, verified 2026-10-29.
FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2 AS node_runtime
FROM evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /evolution
ENV TZ=UTC NODE_VERSION=24.22.1
RUN node -e 'if (process.version !== "v24.22.1" || !require("node:fs").readFileSync("/etc/alpine-release", "utf8").startsWith("3.23.")) process.exit(1); Promise.all([import("baileys"), import("sharp"), import("@prisma/client")]).then(() => process.stdout.write("EVOLUTION_RUNTIME_COMPATIBLE\\n")).catch(() => process.exit(1));'
COPY <<'SILMER_PRIVACY_EOF' /evolution/silmer-privacy.cjs
${privacy}
SILMER_PRIVACY_EOF
COPY <<'SILMER_RETENTION_EOF' /evolution/silmer-retention.cjs
${retention}
SILMER_RETENTION_EOF
RUN mkdir -p /evolution/instances /evolution/store && chown -R node:node /evolution/instances /evolution/store /evolution/prisma /evolution/node_modules/.prisma
USER node
EXPOSE 8080
# Upstream migration script prints DATABASE_URL; discard all raw migration output.
# Runtime protection is loaded only in the API, never in npm/Prisma subprocesses.
ENTRYPOINT ["/bin/bash", "-c", "set -eu; node /evolution/silmer-privacy.cjs --check; if /bin/bash ./Docker/scripts/deploy_database.sh >/dev/null 2>&1; then printf 'EVOLUTION_DATABASE_READY\\n'; else printf 'EVOLUTION_DATABASE_FAILED\\n' >&2; exit 1; fi; node /evolution/silmer-retention.cjs --once; exec node --require /evolution/silmer-privacy.cjs dist/main"]
`;
await writeFile(new URL('Dockerfile.inline', root), dockerfile);
