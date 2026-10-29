import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
  EXPECTED_SOURCE_SHA256,
  OLD_CALL,
  NEW_CALL,
  patchWebjsQr,
} = require('../ops/waha/patch-webjs-qr.cjs');
const fixture = [
  "'use strict';",
  'async function register(exposeFunctionIfAbsent, pairWithPhoneNumber) {',
  '  await exposeFunctionIfAbsent(',
  '    this.pupPage,',
  "    'onAuthAppStateChangedEvent',",
  '    async (state) => {',
  '      if (',
  "        state == 'UNPAIRED_IDLE' &&",
  '        !pairWithPhoneNumber.phoneNumber',
  '      ) {',
  '        // refresh qr code',
  '        await this.pupPage.evaluate(() => {',
  "          window.require('WAWebCmd').Cmd.refreshQR();",
  '        });',
  '      }',
  '    },',
  '  );',
  '}',
  'module.exports = register;',
  '',
].join('\n');
/** @param {string} source */
const digest = (source) => createHash('sha256').update(source).digest('hex');
/** @param {string} source */
const patchFixture = (source) => patchWebjsQr(source, digest(source));

test('WAHA-01D: refreshes idle QR when the legacy API is absent', async () => {
  const patched = patchFixture(fixture);
  assert.equal(patched, fixture.replace(OLD_CALL, NEW_CALL));
  let calls = 0;
  const window = {
    /** @param {string} name */
    require(name) {
      if (name === 'WAWebLaunchSocketUtils') {
        return { refreshQR: () => calls++ };
      }
      if (name === 'WAWebCmd') return { Cmd: {} };
      throw new Error('UNEXPECTED_MODULE');
    },
  };
  /** @type {{ exports: (...args: any[]) => Promise<void> }} */
  const module = { exports: async () => {} };
  vm.runInNewContext(patched, { module });
  const register = module.exports;
  /** @type {(state: string) => Promise<void>} */
  let handler = async () => {
    throw new Error('HANDLER_NOT_REGISTERED');
  };
  const page = {
    /** @param {Function} fn */
    evaluate(fn) {
      return vm.runInNewContext('(' + fn.toString() + ')()', { window });
    },
  };
  /** @param {unknown} _page @param {string} name @param {(state: string) => Promise<void>} callback */
  const expose = async (_page, name, callback) => {
    assert.equal(name, 'onAuthAppStateChangedEvent');
    handler = callback;
  };
  await register.call({ pupPage: page }, expose, {});
  await handler('UNPAIRED_IDLE');
  assert.equal(calls, 1);
  await handler('CONNECTED');
  assert.equal(calls, 1);
  await register.call({ pupPage: page }, expose, { phoneNumber: 'synthetic' });
  await handler('UNPAIRED_IDLE');
  assert.equal(calls, 1);
});

test('WAHA-01D: refuses source drift before patching', () => {
  assert.throws(
    () => patchWebjsQr(fixture + '\n', digest(fixture)),
    /WAHA_CLIENT_SOURCE_HASH_MISMATCH/,
  );
  assert.throws(
    () => patchWebjsQr(fixture),
    /WAHA_CLIENT_SOURCE_HASH_MISMATCH/,
  );
});

test('WAHA-01D: refuses missing or duplicate legacy calls', () => {
  for (const source of [
    fixture.replace(OLD_CALL, NEW_CALL),
    fixture + '\nfunction duplicate() { ' + OLD_CALL + ' }',
  ]) {
    assert.throws(
      () => patchFixture(source),
      /WAHA_CLIENT_QR_CALL_COUNT_INVALID/,
    );
  }
});

test('WAHA-01D: refuses a different auth guard or browser context', () => {
  for (const source of [
    fixture.replace('UNPAIRED_IDLE', 'CONNECTED'),
    fixture.replace('!pairWithPhoneNumber.phoneNumber', 'true'),
    fixture.replace(
      'await this.pupPage.evaluate(() => {',
      'await execute(() => {',
    ),
  ]) {
    assert.throws(
      () => patchFixture(source),
      /WAHA_CLIENT_AUTH_CONTEXT_INVALID/,
    );
  }
});

test('WAHA-01D: checks syntax without executing the source', () => {
  assert.throws(
    () => patchFixture(fixture + '\nconst broken = ;'),
    /WAHA_CLIENT_SYNTAX_INVALID/,
  );
  const source = 'throw new Error("MUST_NOT_EXECUTE");\n' + fixture;
  assert.equal(patchFixture(source), source.replace(OLD_CALL, NEW_CALL));
});

test('WAHA-01D: inline Dockerfile pins base and identical build patch', async () => {
  const dockerfile = await readFile(
    new URL('../ops/waha/Dockerfile.inline', import.meta.url),
    'utf8',
  );
  const script = await readFile(
    new URL('../ops/waha/patch-webjs-qr.cjs', import.meta.url),
    'utf8',
  );
  assert.match(
    dockerfile,
    /^FROM devlikeapro\/waha:chrome-2026\.9\.2@sha256:d4c2b1da8373fa48c5022aa947c95a87480cf6e26a9d3c9b59721f96b044d223$/m,
  );
  const inline = dockerfile.match(
    /RUN node <<'WAHA_QR_PATCH'\n([\s\S]*?)\nWAHA_QR_PATCH/,
  );
  assert.ok(inline, 'Expected self-contained build heredoc');
  assert.equal(inline[1], script.trimEnd() + '\npatchFile();');
  assert.match(
    dockerfile,
    /RUN node --check \/app\/node_modules\/whatsapp-web\.js\/src\/Client\.js/,
  );
  assert.doesNotMatch(
    dockerfile,
    /^(?:COPY|ADD|ENV|VOLUME|EXPOSE|USER|ENTRYPOINT|CMD)\b/m,
  );
  assert.match(EXPECTED_SOURCE_SHA256, /^[a-f0-9]{64}$/);
});
