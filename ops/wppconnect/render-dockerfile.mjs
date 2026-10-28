import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('./', import.meta.url);
const base =
  'node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da';
const sha = '27d2b0e573870d8ac20e28ed4180a2e51c30c8ea';
let docker = `# syntax=docker/dockerfile:1.7
# WPP-01. Inline source build: no local context, credentials or Manager assets.
FROM ${base} AS build
ENV PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true HUSKY=0 SHARP_IGNORE_GLOBAL_LIBVIPS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ pkg-config && rm -rf /var/lib/apt/lists/*
RUN git init . && git remote add origin https://github.com/wppconnect-team/wppconnect-server.git && git fetch --depth 1 origin ${sha} && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "${sha}"
RUN corepack enable && corepack prepare yarn@4.14.1 --activate && yarn install --immutable
`;
for (const [source, destination] of [
  ['runtime.cjs', '/app/src/silmer-runtime.cjs'],
  ['webhook.cjs', '/app/src/silmer-webhook.cjs'],
  ['patch-upstream.mjs', '/tmp/patch-upstream.mjs'],
]) {
  docker += `COPY <<'SILMER_SOURCE' ${destination}\n${await readFile(new URL(source, directory), 'utf8')}SILMER_SOURCE\n`;
}
docker += `RUN node /tmp/patch-upstream.mjs /app && yarn build && test -f dist/silmer-runtime.cjs && test -f dist/silmer-webhook.cjs && yarn workspaces focus --all --production && node -e "if(require('@wppconnect-team/wppconnect/package.json').version!=='2.3.6')process.exit(1);require('prom-client');require('bcrypt');require.resolve('@babel/runtime/package.json')"
FROM ${base} AS runtime
LABEL org.opencontainers.image.source="https://github.com/wppconnect-team/wppconnect-server" org.opencontainers.image.revision="${sha}" org.opencontainers.image.version="2.10.69-silmer-private-1"
ENV NODE_ENV=production PORT=21465 PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=true MANAGER_ENABLED=false
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox tini ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/* && test -u /usr/lib/chromium/chrome-sandbox && test "$(stat -c %u /usr/lib/chromium/chrome-sandbox)" = "0" && mkdir -p /data/api /data/tokens /data/browser /app/uploads /app/WhatsAppImages && chown -R node:node /app /data && chmod 700 /data /data/api /data/tokens /data/browser
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/yarn.lock /app/LICENSE ./
USER node
EXPOSE 21465
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:21465/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server.js"]
`;
await writeFile(new URL('Dockerfile.inline', directory), docker);
console.log('WPP_INLINE_DOCKERFILE_READY');
