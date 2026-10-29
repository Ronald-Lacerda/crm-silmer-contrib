FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/edge-web/package.json apps/edge-web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY modules/audit-privacy/package.json modules/audit-privacy/package.json
COPY modules/catalog/package.json modules/catalog/package.json
COPY modules/configuration/package.json modules/configuration/package.json
COPY modules/contacts/package.json modules/contacts/package.json
COPY modules/database/package.json modules/database/package.json
COPY modules/deals-pipeline/package.json modules/deals-pipeline/package.json
COPY modules/qualification/package.json modules/qualification/package.json
COPY modules/work-management/package.json modules/work-management/package.json
COPY modules/identity-access/package.json modules/identity-access/package.json
COPY modules/inbox-channels/package.json modules/inbox-channels/package.json
COPY modules/integration-reliability/package.json modules/integration-reliability/package.json
COPY modules/n8n-integration/package.json modules/n8n-integration/package.json
COPY modules/orders/package.json modules/orders/package.json
COPY modules/shared/package.json modules/shared/package.json
RUN npm ci --ignore-scripts
COPY apps apps
COPY modules modules
COPY scripts scripts
RUN npm run build

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS production-dependencies

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/edge-web/package.json apps/edge-web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY modules/audit-privacy/package.json modules/audit-privacy/package.json
COPY modules/catalog/package.json modules/catalog/package.json
COPY modules/configuration/package.json modules/configuration/package.json
COPY modules/contacts/package.json modules/contacts/package.json
COPY modules/database/package.json modules/database/package.json
COPY modules/deals-pipeline/package.json modules/deals-pipeline/package.json
COPY modules/qualification/package.json modules/qualification/package.json
COPY modules/work-management/package.json modules/work-management/package.json
COPY modules/identity-access/package.json modules/identity-access/package.json
COPY modules/inbox-channels/package.json modules/inbox-channels/package.json
COPY modules/integration-reliability/package.json modules/integration-reliability/package.json
COPY modules/n8n-integration/package.json modules/n8n-integration/package.json
COPY modules/orders/package.json modules/orders/package.json
COPY modules/shared/package.json modules/shared/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=0
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade perl-base \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' perl-base)" ge '5.36.0-7+deb12u4' \
  && apt-get install -y --no-install-recommends ca-certificates clamav clamav-daemon clamdscan clamav-freshclam file ffmpeg libbrotli1 \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge '1.0.9-2+deb12u1' \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node docker/freshclam.conf ./freshclam.conf
COPY --chown=node:node docker/clamd.conf ./clamd.conf
# Genuine baseline database cached independently of application code changes.
RUN chown -R node:node /var/lib/clamav \
  && timeout 180s freshclam --config-file=/app/freshclam.conf --stdout

RUN mkdir -p /var/lib/crm-chat-media /var/lib/crm-legacy-media \
  && chown node:node /var/lib/crm-chat-media /var/lib/crm-legacy-media \
  && chmod 0700 /var/lib/crm-chat-media /var/lib/crm-legacy-media

RUN rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium
COPY --from=build --chown=node:node /workspace/dist/runtime/apps ./apps
COPY --from=build --chown=node:node /workspace/dist/runtime/modules ./modules
COPY --chown=node:node scripts/runtime-healthcheck.mjs ./runtime-healthcheck.mjs

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "runtime-healthcheck.mjs", "http://127.0.0.1:3000/api/health/live"]
CMD ["node", "apps/api/src/server.js"]
