import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pullPinnedImage } from './edge-media-image-pull.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** @param {...string} args */
function docker(...args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Docker ${args[0]} failed: ${result.stderr || result.error || result.stdout}`,
    );
  }
  // Docker sends the container's stderr stream to its own stderr. Both streams
  // must be inspected when proving that OAuth credentials never reach logs.
  return args[0] === 'logs'
    ? `${result.stdout}\n${result.stderr}`
    : result.stdout.trim();
}

const OAUTH_MARKERS = Object.freeze([
  'synthetic-oauth-code',
  'synthetic-state',
  'synthetic-oauth-referrer',
]);
const SPA_MARKER = '<div id="app">Synthetic CRM SPA</div>';
const OAUTH_CALLBACK_PATHS = Object.freeze(['/melhor-envio', '/olist']);

/** Exercise the actual callback response and then inspect both nginx streams.
 * The injected boundaries let unit tests prove that this gate fails on leaks.
 * @param {string} origin
 * @param {()=>string|Promise<string>} readLogs
 * @param {{path?:string, expectedStatus?:number, fetch?:typeof globalThis.fetch}} [options]
 */
export async function checkOAuthCallback(origin, readLogs, options = {}) {
  const expectedStatus = options.expectedStatus ?? 200;
  const path = options.path ?? '/melhor-envio';
  assert.ok(
    OAUTH_CALLBACK_PATHS.includes(path),
    'Unsupported OAuth callback path',
  );
  const response = await (options.fetch ?? globalThis.fetch)(
    `${origin}${path}?code=${OAUTH_MARKERS[0]}&state=${OAUTH_MARKERS[1]}`,
    {
      headers: { Referer: `https://example.test/${OAUTH_MARKERS[2]}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    },
  );
  const body = await response.text();
  assert.equal(response.status, expectedStatus, 'OAuth callback status');
  assert.match(
    response.headers.get('content-type') ?? '',
    /^text\/html(?:;|$)/u,
    'OAuth callback must retain the HTML content type',
  );
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /default-src 'self';/u,
    'OAuth callback must inherit the server CSP',
  );
  assert.equal(
    response.headers.get('referrer-policy'),
    'no-referrer',
    'OAuth callback must inherit the referrer policy',
  );
  assert.match(
    response.headers.get('cache-control') ?? '',
    /(?:^|[,\s])no-store(?:$|[,\s])/u,
    'OAuth callback must never be cached',
  );
  assert.equal(
    body.includes(SPA_MARKER),
    expectedStatus === 200,
    'OAuth callback must serve the synthetic SPA only when its index exists',
  );
  const logs = await readLogs();
  for (const marker of OAUTH_MARKERS) {
    assert.ok(!body.includes(marker), 'OAuth markers must not be reflected');
    assert.ok(
      !logs.includes(marker),
      'OAuth markers must not enter nginx logs',
    );
  }
}

/** @param {string} path @param {string} repository */
async function pinnedBase(path, repository) {
  const source = await readFile(resolve(root, path), 'utf8');
  const images = [...source.matchAll(/^FROM (\S+)/gmu)].map(
    (match) => match[1],
  );
  const image = images.find((value) => value.startsWith(`${repository}:`));
  assert.ok(image, `${path} must declare the ${repository} base`);
  assert.match(image, /@sha256:[a-f0-9]{64}$/u);
  return image;
}

async function main() {
  const edgeBase = await pinnedBase('docker/edge-web.Dockerfile', 'nginx');
  const apiBase = await pinnedBase('docker/runtime.Dockerfile', 'node');
  const prefix = `crm-silmer-t31-${randomUUID()}`;
  const networkName = `${prefix}-network`;
  /** @type {string | undefined} */
  let networkId;
  /** @type {string[]} */
  const containers = [];
  const upstream = `const http=require('node:http');http.createServer((req,res)=>{let bytes=0;req.on('data',b=>bytes+=b.length);req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({bytes,path:req.url}));});}).listen(3000,'0.0.0.0');`;

  try {
    const edgeImage = pullPinnedImage(edgeBase, (image) =>
      docker('pull', image),
    );
    const apiImage = pullPinnedImage(apiBase, (image) => docker('pull', image));
    networkId = docker('network', 'create', networkName);
    containers.push(
      docker(
        'run',
        '-d',
        '--name',
        `${prefix}-api`,
        '--network',
        networkName,
        '--network-alias',
        'silmer-api',
        '--user',
        'node',
        '--entrypoint',
        'node',
        apiImage,
        '-e',
        upstream,
      ),
    );
    const edgeId = docker(
      'run',
      '-d',
      '--name',
      `${prefix}-edge`,
      '--network',
      networkName,
      '--user',
      'nginx',
      '-p',
      '127.0.0.1::8080',
      '--mount',
      `type=bind,source=${resolve(root, 'docker/nginx.conf')},target=/etc/nginx/nginx.conf,readonly`,
      '--entrypoint',
      'nginx',
      edgeImage,
      '-g',
      'daemon off;',
    );
    containers.push(edgeId);
    docker('exec', edgeId, 'nginx', '-t');
    const binding = /:(\d+)$/u.exec(docker('port', edgeId, '8080/tcp'));
    assert.ok(binding, 'edge must publish its dedicated loopback port');
    const origin = `http://127.0.0.1:${binding[1]}`;
    /** @type {Response | undefined} */
    let ready;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        ready = await globalThis.fetch(`${origin}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (ready.ok) break;
      } catch {
        // Docker may publish the port before nginx starts listening.
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.ok(ready, 'edge must respond within the readiness window');
    assert.equal(ready.status, 200);
    assert.equal(
      ready.headers.get('permissions-policy'),
      'camera=(), geolocation=(), microphone=(self)',
    );
    assert.match(
      ready.headers.get('content-security-policy') ?? '',
      /img-src 'self' data: blob:; media-src 'self' blob:;/u,
    );

    // T138: mutate only this disposable container's default welcome page, never
    // the mounted source configuration or the host checkout.
    docker(
      'exec',
      '--user',
      'root',
      edgeId,
      'sh',
      '-c',
      `printf '%s' '<!doctype html><html><body>${SPA_MARKER}</body></html>' > /usr/share/nginx/html/index.html`,
    );
    for (const path of OAUTH_CALLBACK_PATHS)
      await checkOAuthCallback(origin, () => docker('logs', edgeId), { path });
    docker(
      'exec',
      '--user',
      'root',
      edgeId,
      'mv',
      '/usr/share/nginx/html/index.html',
      '/tmp/t138-index.html',
    );
    try {
      for (const path of OAUTH_CALLBACK_PATHS)
        await checkOAuthCallback(origin, () => docker('logs', edgeId), {
          path,
          expectedStatus: 404,
        });
    } finally {
      docker(
        'exec',
        '--user',
        'root',
        edgeId,
        'mv',
        '/tmp/t138-index.html',
        '/usr/share/nginx/html/index.html',
      );
    }

    const mib = 1024 * 1024;
    /** @type {[string, number, number][]} */
    const cases = [
      ['/api/v1/conversations/synthetic-t31/media', 16 * mib + 1024, 200],
      [
        '/api/v1/conversations/synthetic-t31/media?source=test',
        16 * mib + 1024,
        200,
      ],
      ['/api/v1/conversations/synthetic-t31/media', 17 * mib + 1, 413],
      ['/api/v1/conversations/synthetic-t31/media/status', mib + 1, 413],
      ['/api/v1/conversations/synthetic-t31/media/', mib + 1, 413],
      ['/api/v1/conversations/synthetic-t31/messages', mib + 1, 413],
      ['/api/v1/orders/synthetic-t31/files', 10 * mib + 1024, 200],
      ['/api/v1/orders/synthetic-t31/files', 11 * mib + 1, 413],
      [
        '/api/v1/integrations/n8n/conversations/synthetic-audio/attachments',
        16 * mib + 1024,
        200,
      ],
      [
        '/api/v1/integrations/n8n/conversations/synthetic-audio/attachments?source=test',
        16 * mib + 1024,
        200,
      ],
      [
        '/api/v1/integrations/n8n/conversations/synthetic-audio/attachments',
        17 * mib + 1,
        413,
      ],
      [
        '/api/v1/integrations/n8n/conversations/synthetic-audio/attachments/',
        mib + 1,
        413,
      ],
      [
        '/api/v1/integrations/n8n/conversations/synthetic-audio/attachments/content',
        mib + 1,
        413,
      ],
      ['/api/v1/integrations/n8n/messages/inbound', mib + 1, 413],
    ];
    for (const [path, bytes, expected] of cases) {
      const response = await globalThis.fetch(origin + path, {
        method: 'POST',
        body: Buffer.alloc(bytes, 65),
        headers: { 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, expected, `${path} ${bytes}`);
      if (expected === 200) {
        const body = await response.json();
        assert.equal(body.bytes, bytes);
        assert.equal(body.path, path);
      } else {
        await response.arrayBuffer();
      }
      console.log(JSON.stringify({ path, bytes, status: response.status }));
    }
    const inboundPath =
      '/api/v1/integrations/n8n/conversations/synthetic-audio/attachments';
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await globalThis.fetch(origin + inboundPath, { method });
      assert.equal(response.status, 403, `${inboundPath} ${method}`);
      await response.arrayBuffer();
    }
    console.log(
      `PASS: ${cases.length}/` +
        `${cases.length} routes/limits, inbound methods, actual response headers, nginx syntax, both OAuth callback HTML/404 and credential-free logs`,
    );
  } finally {
    const failures = [];
    for (const id of containers.toReversed()) {
      try {
        docker('rm', '-f', id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (networkId) {
      try {
        docker('network', 'rm', networkId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Dedicated smoke resource cleanup failed',
      );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
