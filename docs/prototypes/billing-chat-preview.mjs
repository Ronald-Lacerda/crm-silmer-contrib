// @ts-nocheck -- local-only preview harness; never imported by the application.
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBillingPreviewFixtures,
  PREVIEW_CONVERSATION,
} from './billing-chat-fixtures.mjs';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const previewComponent = resolve(
  repository,
  'docs/prototypes/BillingChatPreviewAction.vue',
).replaceAll('\\', '/');
export async function createBillingChatPreview({ port = 4189 } = {}) {
  const fixtures = createBillingPreviewFixtures();
  const server = await createServer({
    configFile: false,
    root: resolve(repository, 'apps/edge-web'),
    plugins: [
      vue(),
      {
        name: 'isolated-billing-chat-preview',
        enforce: 'pre',
        transform(code, id) {
          if (!id.replaceAll('\\', '/').endsWith('/src/views/InboxView.vue'))
            return;
          const anchor = '<ConversationShippingQuote';
          if (!code.includes(anchor))
            throw new Error(
              'The current Inbox shipping action changed; review preview insertion.',
            );
          return code
            .replace(
              '<script setup>',
              `<script setup>\nimport BillingChatPreviewAction from '${previewComponent}';`,
            )
            .replace(
              anchor,
              `<BillingChatPreviewAction :disabled="quoteDisabled || busy || mediaSending || !canReply" @sent="mediaSent" />\n                ${anchor}`,
            );
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const path = url.pathname;
            if (
              !path.startsWith('/api/') &&
              !path.startsWith('/__billing-preview/')
            )
              return next();
            res.setHeader('Cache-Control', 'private, no-store');
            if (path === '/api/v1/events') {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                Connection: 'keep-alive',
              });
              res.write('retry: 60000\n\n: connected\n\n');
              const heartbeat = setInterval(
                () => res.write(': local preview\n\n'),
                15000,
              );
              req.on('close', () => clearInterval(heartbeat));
              return;
            }
            const json = (body, status = 200) => {
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(body));
            };
            try {
              if (path === '/__billing-preview/state' && req.method === 'GET')
                return json(fixtures.view());
              if (
                path === '/__billing-preview/action' &&
                req.method === 'POST'
              ) {
                let raw = '';
                for await (const chunk of req) {
                  raw += chunk;
                  if (raw.length > 8192)
                    throw new Error('Preview body too large');
                }
                const body = JSON.parse(raw || '{}');
                return json(fixtures.action(body.action, body));
              }
              const result = fixtures.api(path, req.method);
              return json(result.body, result.status ?? 200);
            } catch (error) {
              return json({ detail: error.message }, error.statusCode ?? 400);
            }
          });
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: port !== 0,
      cors: false,
      fs: { allow: [repository] },
    },
    clearScreen: false,
  });
  await server.listen();
  const address = server.httpServer.address();
  return {
    server,
    fixtures,
    url: `http://127.0.0.1:${address.port}/inbox/${PREVIEW_CONVERSATION}`,
    async close() {
      fixtures.dispose();
      await server.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const preview = await createBillingChatPreview({
    port: Number(process.env.BILLING_PREVIEW_PORT ?? 4189),
  });
  process.stdout.write(
    `Protótipo local, somente dados fictícios: ${preview.url}\n`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await preview.close();
      process.exit(0);
    });
}
