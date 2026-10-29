import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers';

import {
  MediaHashMismatchError,
  MediaQuotaExceededError,
  PrivateMediaVolume,
} from '../modules/integration-reliability/src/private-media-volume.js';

/** @returns {any} */
function repositoryFixture() {
  /** @type {any[]} */
  const events = [];
  return {
    events,
    /** @param {any} event */
    async markAvailable(event) {
      events.push(['available', event]);
    },
    /** @param {any} event */
    async markDeleted(event) {
      events.push(['deleted', event]);
    },
    /** @param {any} event */
    async markQuarantined(event) {
      events.push(['quarantined', event]);
    },
    /** @param {any} event */
    async markRejected(event) {
      events.push(['rejected', event]);
    },
    /** @param {any} event */
    async markUnavailable(event) {
      events.push(['unavailable', event]);
    },
  };
}

/** @param {Record<string, any>} options @param {(fixture: {repository: any, rootDirectory: string, volume: PrivateMediaVolume}) => Promise<void>} work */
async function withVolume(options, work) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'crm-private-media-'));
  const repository = repositoryFixture();
  const volume = new PrivateMediaVolume({
    maxBytes: 1024,
    maxFileBytes: 512,
    repository,
    rootDirectory,
    scanner: {
      async scan() {
        return {
          clean: true,
          detectedMimeType: 'image/png',
          signatureUpdatedAt: new Date('2026-09-02T11:00:00.000Z'),
        };
      },
    },
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    ...options,
  });
  try {
    await work({ repository, rootDirectory, volume });
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
}

test('writes clean media atomically with an opaque path and content hash', async () => {
  await withVolume({}, async ({ repository, rootDirectory, volume }) => {
    await writeFile(join(rootDirectory, '.partial-interrupted'), 'partial');
    const stored = await volume.store({
      bytes: Buffer.from('safe-image-bytes'),
      declaredMimeType: 'image/png',
      mediaId: 'media-1',
    });

    assert.equal(stored.availabilityStatus, 'available');
    assert.match(stored.contentSha256, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(stored.storageKey, /media-1/u);
    assert.deepEqual(await readdir(rootDirectory), [stored.storageKey]);
    assert.equal(repository.events[0][0], 'available');
    assert.equal(repository.events[0][1].sizeBytes, 16);
  });
});

test('fails quota closed and removes every partial file', async () => {
  await withVolume(
    { maxBytes: 4, maxFileBytes: 4 },
    async ({ repository, rootDirectory, volume }) => {
      await assert.rejects(
        volume.store({
          bytes: Buffer.from('too-large'),
          declaredMimeType: 'image/png',
          mediaId: 'media-quota',
        }),
        MediaQuotaExceededError,
      );
      assert.deepEqual(await readdir(rootDirectory), []);
      assert.equal(repository.events.at(-1)[0], 'unavailable');
    },
  );
});

test('rejects a divergent declared digest before scanning or publishing bytes', async () => {
  let scans = 0;
  await withVolume(
    {
      scanner: {
        async scan() {
          scans += 1;
          throw new Error('scanner must not run for a bad digest');
        },
      },
    },
    async ({ repository, rootDirectory, volume }) => {
      await assert.rejects(
        volume.store({
          bytes: Buffer.from('uploaded-bytes'),
          declaredMimeType: 'image/png',
          expectedSha256: createHash('sha256')
            .update('different-bytes')
            .digest('hex'),
          mediaId: 'media-bad-digest',
        }),
        MediaHashMismatchError,
      );
      assert.equal(scans, 0);
      assert.deepEqual(await readdir(rootDirectory), []);
      assert.equal(repository.events.at(-1)[0], 'rejected');
      assert.equal(repository.events.at(-1)[1].reason, 'hash_mismatch');
    },
  );
});

test('keeps stale scanner signatures quarantined and rejects unsafe bytes', async () => {
  await withVolume(
    {
      scanner: {
        async scan() {
          return {
            clean: true,
            detectedMimeType: 'image/png',
            signatureUpdatedAt: new Date('2026-08-31T12:00:00.000Z'),
          };
        },
      },
    },
    async ({ repository, volume }) => {
      const stored = await volume.store({
        bytes: Buffer.from('quarantined'),
        declaredMimeType: 'image/png',
        mediaId: 'media-stale',
      });
      assert.equal(stored.availabilityStatus, 'quarantined');
      assert.equal(repository.events.at(-1)[0], 'quarantined');
    },
  );

  await withVolume(
    {
      scanner: {
        async scan() {
          return {
            clean: false,
            detectedMimeType: 'application/x-msdownload',
            signatureUpdatedAt: new Date('2026-09-02T11:00:00.000Z'),
          };
        },
      },
    },
    async ({ repository, rootDirectory, volume }) => {
      const stored = await volume.store({
        bytes: Buffer.from('unsafe'),
        declaredMimeType: 'image/png',
        mediaId: 'media-unsafe',
      });
      assert.equal(stored.availabilityStatus, 'rejected');
      assert.deepEqual(await readdir(rootDirectory), []);
      assert.equal(repository.events.at(-1)[0], 'rejected');
    },
  );
});

test('marks a missing file lost and deletes an existing file idempotently', async () => {
  await withVolume({}, async ({ repository, rootDirectory, volume }) => {
    const stored = await volume.store({
      bytes: Buffer.from('temporary'),
      declaredMimeType: 'image/png',
      mediaId: 'media-delete',
    });
    assert.ok(stored.storageKey);
    await unlink(join(rootDirectory, stored.storageKey));

    assert.equal(
      await volume.resolvePath({
        mediaId: 'media-delete',
        storageKey: stored.storageKey,
      }),
      null,
    );
    assert.equal(repository.events.at(-1)[0], 'unavailable');

    await volume.delete({
      mediaId: 'media-delete',
      reason: 'journey_terminal',
      storageKey: stored.storageKey,
    });
    assert.equal(repository.events.at(-1)[0], 'deleted');
  });
});

test('IMG-04: stale media is rescanned in place and published only with fresh signatures', async () => {
  let fresh = false;
  let scans = 0;
  await withVolume(
    {
      scanner: {
        async scan() {
          scans++;
          return {
            clean: true,
            detectedMimeType: 'image/png',
            signatureUpdatedAt: fresh
              ? '2026-09-02T11:00:00Z'
              : '2026-08-31T11:00:00Z',
          };
        },
      },
    },
    async ({ repository, rootDirectory, volume }) => {
      const stored = await volume.store({
        bytes: Buffer.from('quarantined'),
        declaredMimeType: 'image/png',
        mediaId: 'rescan-stale',
      });
      assert.equal(stored.availabilityStatus, 'quarantined');
      assert.ok(stored.storageKey);
      const input = {
        mediaId: 'rescan-stale',
        storageKey: stored.storageKey,
        expectedSha256: stored.contentSha256,
        expectedSizeBytes: stored.sizeBytes,
        declaredMimeType: 'image/png',
      };
      const stillStale = await volume.revalidate(input);
      assert.equal(stillStale.availabilityStatus, 'quarantined');
      assert.equal(repository.events.at(-1)[0], 'quarantined');
      fresh = true;
      const healed = await volume.revalidate(input);
      assert.equal(healed.availabilityStatus, 'available');
      assert.equal(healed.storageKey, stored.storageKey);
      assert.equal(healed.sizeBytes, stored.sizeBytes);
      assert.deepEqual(await readdir(rootDirectory), [stored.storageKey]);
      assert.equal(repository.events.at(-1)[0], 'available');
      assert.equal(scans, 3);
    },
  );
});

test('IMG-04: revalidation never publishes tampered, oversized or unsafe stored bytes', async () => {
  for (const fault of ['hash', 'size', 'mime', 'infected', 'scanner']) {
    let changed = false;
    await withVolume(
      {
        scanner: {
          async scan() {
            if (changed && fault === 'scanner')
              throw new Error('scanner temporarily offline');
            return {
              clean: !(changed && fault === 'infected'),
              detectedMimeType:
                changed && fault === 'mime' ? 'image/jpeg' : 'image/png',
              signatureUpdatedAt: changed
                ? '2026-09-02T11:00:00Z'
                : '2026-08-31T11:00:00Z',
            };
          },
        },
      },
      async ({ repository, rootDirectory, volume }) => {
        const stored = await volume.store({
          bytes: Buffer.from('safe-bytes'),
          declaredMimeType: 'image/png',
          mediaId: `rescan-${fault}`,
        });
        assert.equal(stored.availabilityStatus, 'quarantined');
        assert.ok(stored.storageKey);
        const input = {
          mediaId: `rescan-${fault}`,
          storageKey: stored.storageKey,
          expectedSha256: stored.contentSha256,
          expectedSizeBytes: stored.sizeBytes,
          declaredMimeType: 'image/png',
        };
        changed = true;
        if (fault === 'hash')
          await writeFile(join(rootDirectory, stored.storageKey), 'unsafe-one');
        if (fault === 'size') input.expectedSizeBytes = 513;
        if (['hash', 'size', 'scanner'].includes(fault)) {
          await assert.rejects(volume.revalidate(input));
        } else {
          assert.equal(
            (await volume.revalidate(input)).availabilityStatus,
            'rejected',
          );
        }
        assert.notEqual(repository.events.at(-1)[0], 'available');
        if (fault === 'scanner') {
          assert.equal(
            repository.events.at(-1)[1].reason,
            'storage_or_scan_failed',
          );
          assert.deepEqual(await readdir(rootDirectory), [stored.storageKey]);
        }
      },
    );
  }
});

test('IMG-04: revalidation waits on the same serial queue as new storage', async () => {
  let release = /** @type {() => void} */ (() => {});
  const entered = /** @type {string[]} */ ([]);
  let rescan = false;
  const waiting = new Promise((resolveWaiting) => {
    release = () => resolveWaiting(undefined);
  });
  await withVolume(
    {
      scanner: {
        async scan() {
          entered.push(rescan ? 'rescan' : 'store');
          if (!rescan) await waiting;
          return {
            clean: true,
            detectedMimeType: 'image/png',
            signatureUpdatedAt: '2026-09-02T11:00:00Z',
          };
        },
      },
    },
    async ({ volume }) => {
      const pending = volume.store({
        bytes: Buffer.from('safe-bytes'),
        declaredMimeType: 'image/png',
        mediaId: 'serial-new',
      });
      // The first operation owns the scanner until the gate is explicitly released.
      while (!entered.length)
        await new Promise((resolveTick) => setImmediate(resolveTick));
      rescan = true;
      const invalid = volume.revalidate({
        mediaId: 'serial-old',
        storageKey: '00000000-0000-4000-8000-000000000000',
        expectedSha256: 'a'.repeat(64),
        expectedSizeBytes: 1,
        declaredMimeType: 'image/png',
      });
      assert.deepEqual(entered, ['store']);
      release();
      await pending;
      await assert.rejects(invalid);
      assert.deepEqual(entered, ['store']);
    },
  );
});
