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
  return result.stdout.trim();
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
  const edgeImage = pullPinnedImage(edgeBase, (image) => docker('pull', image));
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
      `${cases.length} routes/limits, inbound methods, actual response headers, nginx syntax`,
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
