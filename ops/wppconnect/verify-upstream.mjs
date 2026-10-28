import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const sha = '27d2b0e573870d8ac20e28ed4180a2e51c30c8ea';
const directory = await mkdtemp(join(tmpdir(), 'silmer-wpp-upstream-'));
try {
  for (const path of [
    'src/index.ts',
    'src/util/functions.ts',
    'src/util/createSessionUtil.ts',
    'src/util/tokenStore/FileTokenStore/FileTokenStore.ts',
    'package.json',
    'yarn.lock',
  ]) {
    const response = await fetch(
      `https://raw.githubusercontent.com/wppconnect-team/wppconnect-server/${sha}/${path}`,
    );
    if (!response.ok) throw new Error('WPP_UPSTREAM_FETCH_FAILED');
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await response.text());
  }
  const result = spawnSync(
    process.execPath,
    [resolve('ops/wppconnect/patch-upstream.mjs'), directory],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error('WPP_PATCH_SMOKE_FAILED');
  assert.match(
    await readFile(join(directory, 'src/index.ts'), 'utf8'),
    /allowRequest:.*callback\('Disabled', false\)/,
  );
  assert.match(
    await readFile(join(directory, 'src/util/functions.ts'), 'utf8'),
    /silmer-webhook\.cjs/,
  );
  assert.doesNotMatch(
    await readFile(join(directory, 'src/config.ts'), 'utf8'),
    /THISISMYSECURETOKEN|ignore-certificate|disable-web-security/,
  );
  const session = await readFile(
    join(directory, 'src/util/createSessionUtil.ts'),
    'utf8',
  );
  assert.match(
    session,
    /process\.env\.WPP_PHASE === 'integrated'.*listenMessages/,
  );
  assert.doesNotMatch(session, /download\(message, client, req.logger\)/);
  console.log('WPP_PINNED_UPSTREAM_PATCH_SMOKE_PASSED');
} finally {
  await rm(directory, { recursive: true, force: true });
}
