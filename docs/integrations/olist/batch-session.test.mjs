import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { publicEncrypt, constants } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { startBatchSession } from './batch-session.mjs';
import { loadBatchPlan, bindBatch, BATCH_NAME } from './controlled-batch.mjs';
import { input, provider } from './controlled-batch.fixtures.mjs';
test('loopback OAuth executes fixed batch once, clears callback and never persists secret/token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olist-batch-session-')),
    p = join(root, 'f1-next-cases-private.json');
  await writeFile(p, JSON.stringify(input()));
  const plan = await loadBatchPlan(),
    bound = bindBatch(plan, input()),
    mock = provider(plan);
  let exchanges = 0,
    session;
  try {
    session = await startBatchSession(root, {
      approvedDigest: bound.digest,
      pause: async () => {},
      fetcher: async (url, init) => {
        if (
          url ===
          'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token'
        ) {
          exchanges++;
          assert.equal(init.method, 'POST');
          assert.match(init.body, /grant_type=authorization_code/);
          return new Response(JSON.stringify({ access_token: 'MOCK' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return mock.fetch(url, init);
      },
    });
    const key = await readFile(join(session.directory, 'public-key.pem'));
    const credentials = {
      clientId: 'MOCK_CLIENT',
      clientSecret: 'SECRET_NEVER_PERSIST',
      expectedDocument: input().accountDocument,
    };
    const encrypted = publicEncrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(JSON.stringify(credentials)),
    );
    await writeFile(join(session.directory, 'credentials.enc'), encrypted);
    let html = '';
    for (let i = 0; i < 30; i++) {
      html = await (await fetch('http://127.0.0.1:8765')).text();
      if (html.includes('Conectar Olist')) break;
      await wait(100);
    }
    assert.match(html, /Conectar Olist/);
    const auth = new URL(
      html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'),
    );
    const callback =
      'http://127.0.0.1:8765/olist/callback?state=' +
      auth.searchParams.get('state') +
      '&code=MOCK_CODE';
    const redirect = await fetch(callback, { redirect: 'manual' });
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get('location'), '/');
    let result;
    for (let i = 0; i < 60; i++) {
      try {
        result = JSON.parse(
          await readFile(join(session.directory, 'result.json'), 'utf8'),
        );
        break;
      } catch {
        await wait(100);
      }
    }
    assert.equal(result.state, 'api_batch_completed_ui_proof_required');
    assert.equal(exchanges, 1);
    await fetch(callback, { redirect: 'manual' });
    assert.equal(exchanges, 1);
    assert.equal(
      (await readdir(session.directory)).includes('credentials.enc'),
      false,
    );
    for (const file of await readdir(session.directory)) {
      const content = await readFile(join(session.directory, file), 'utf8');
      assert.ok(!content.includes('SECRET_NEVER_PERSIST'));
      assert.ok(!content.includes('MOCK_CODE'));
      assert.ok(!content.includes('"access_token"'));
    }
  } finally {
    session?.close();
    if (session) {
      for (const f of await readdir(session.directory))
        await unlink(join(session.directory, f));
      await rmdir(session.directory);
    }
    const journal = join(root, 'controlled', BATCH_NAME + '.jsonl');
    try {
      await unlink(journal);
      await rmdir(join(root, 'controlled'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await unlink(p);
    await rmdir(root);
  }
});
