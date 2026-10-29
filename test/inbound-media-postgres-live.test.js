import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createApi } from '../apps/api/src/app.js';
import { createInboundMediaRuntime } from '../apps/api/src/inbound-media-runtime.js';
import { createN8nApiRuntime } from '../apps/api/src/n8n-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresInboxReadRepository } from '../modules/inbox-channels/src/index.js';
import {
  PostgresTransientMediaRepository,
  PrivateMediaVolume,
} from '../modules/integration-reliability/src/index.js';
import { createSafeLogger } from '../modules/shared/src/index.js';
import { SYNTHETIC_GIF } from './fixtures/inbound-raster.js';

const connectionString = process.env.TEST_DATABASE_URL;

if (connectionString) {
  test('IMG-01/02/05 PostgreSQL: upload, replay, Inbox list/get, retention and private bytes', async (t) => {
    assert.match(
      new URL(connectionString).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9_]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 4 });
    const directory = await mkdtemp(join(tmpdir(), 'crm-inbound-media-live-'));
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const now = new Date();
    let currentTime = now;
    let scanMode = 'fresh';
    let scans = 0;
    let detectedMimeType = 'image/png';
    const key = Buffer.alloc(32, 91);
    const bytes = await readFile(
      new URL('./fixtures/media-composer.png', import.meta.url),
    );
    const volume = new PrivateMediaVolume({
      rootDirectory: directory,
      maxBytes: 10 * 1024 * 1024,
      maxFileBytes: 5 * 1024 * 1024,
      now: () => currentTime,
      repository: new PostgresTransientMediaRepository({ database }),
      scanner: {
        async scan() {
          scans++;
          if (scanMode === 'offline')
            throw new Error('synthetic scanner offline');
          return {
            clean: scanMode !== 'infected',
            detectedMimeType,
            signatureUpdatedAt:
              scanMode === 'stale'
                ? new Date(currentTime.getTime() - 48 * 60 * 60 * 1000)
                : currentTime,
          };
        },
      },
    });
    const integration = createN8nApiRuntime(database, {
      environment: {
        N8N_INTEGRATION_ENVELOPE_KEY: key.toString('base64'),
        CONTACT_IDENTITY_ENVELOPE_KEY: key.toString('base64'),
        CONTACT_IDENTITY_LOOKUP_KEY: key.toString('base64'),
        INBOX_MESSAGE_ENVELOPE_KEY: key.toString('base64'),
      },
      mediaVolume: volume,
      clock: () => currentTime,
    });
    const inbox = new PostgresInboxReadRepository({
      database,
      contactEnvelopeKey: key,
      messageEnvelopeKey: key,
    });
    const runtime = createInboundMediaRuntime({
      database,
      mediaVolume: volume,
      clock: () => now,
      access: {
        async authorizeRead() {
          return { actor: { id: 'reader-synthetic' } };
        },
      },
    });
    const api = createApi(
      {},
      {
        inboundMedia: runtime,
        logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      },
    );
    t.after(async () => {
      await api.close();
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    });
    /** @param {string} id */
    const technical = (id) => ({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: id,
      credentialVersion: 'current',
      executionId: id,
      idempotencyKey: id,
      requestId: id,
      workflowKey: 'synthetic-inbound',
      workflowVersion: 'synthetic-1',
    });
    /** @param {string} suffix @param {boolean} [persist] @param {{type?: string, mime?: string, bytes?: Buffer}} [options] */
    async function image(suffix, persist = true, options = {}) {
      const content = options.bytes ?? bytes;
      const mime = options.mime ?? 'image/png';
      detectedMimeType = mime;
      const messageId = `message-${suffix}`;
      const received = await integration.receiveInbound({
        schema_version: '1.0',
        channel: 'whatsapp',
        event_id: messageId,
        occurred_at: currentTime.toISOString(),
        metadata: { phone_number_id: 'synthetic-account' },
        contact: { name: 'Synthetic', wa_id: `5527900000${suffix}` },
        message: {
          external_id: messageId,
          type: options.type ?? 'image',
          text: 'Referência sintética',
          attachment: {
            external_id: `provider-media-${suffix}`,
            mime_type: mime,
          },
        },
        technical: technical(messageId),
      });
      const input = {
        conversationId: received.conversation_id,
        externalId: messageId,
        filename: mime === 'image/gif' ? 'synthetic.gif' : 'synthetic.png',
        mimeType: mime,
        size: content.length,
        contentSha256: createHash('sha256').update(content).digest('hex'),
        stream: content,
        technical: technical(`attachment-${suffix}`),
      };
      const stored = persist ? await integration.storeAttachment(input) : null;
      return { received, stored, input };
    }
    /** @param {string} conversationId @param {string} mediaId */
    const get = (conversationId, mediaId) =>
      api.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}/media/${mediaId}/content`,
        headers: { cookie: 'crm_session=synthetic' },
      });

    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    const first = await image('101');
    const replay = await integration.storeAttachment(first.input);
    assert.equal(replay.duplicate, true);
    assert.equal(
      (await pool.query('SELECT count(*)::int count FROM crm.attachments'))
        .rows[0].count,
      1,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int count FROM crm.transient_media'))
        .rows[0].count,
      1,
    );
    const mediaId = first.stored.attachment_id;
    const details = await inbox.get(first.received.conversation_id);
    const media = details.messages[0].media;
    assert.equal(media.mediaId, mediaId);
    assert.equal(media.kind, 'image');
    assert.equal(media.state, 'attached');
    assert.equal(media.mimeType, 'image/png');
    assert.equal(
      media.contentUrl,
      `/api/v1/conversations/${first.received.conversation_id}/media/${mediaId}/content`,
    );
    assert.equal(details.messages[0].preview, 'Referência sintética');
    const list = await inbox.list({ limit: 20 });
    assert.deepEqual(list.items[0].lastMessage.media, media);
    const response = await get(first.received.conversation_id, mediaId);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, bytes);
    assert.equal((await get('another-conversation', mediaId)).statusCode, 404);
    assert.doesNotMatch(
      JSON.stringify(details),
      /storage_key|content_envelope|provider-media-|https:\/\//u,
    );

    // Preserve document history while presenting only detected raster images.
    let sequence = 110;
    for (const type of ['image', 'document']) {
      for (const [mime, content] of [
        ['image/png', bytes],
        ['image/gif', SYNTHETIC_GIF],
      ]) {
        const uploaded = await image(String(sequence++), true, {
          type,
          mime: String(mime),
          bytes: /** @type {Buffer} */ (content),
        });
        const replay = await integration.storeAttachment(uploaded.input);
        assert.equal(replay.duplicate, true);
        const shown = await inbox.get(uploaded.received.conversation_id);
        assert.equal(shown.messages[0].type, type);
        assert.equal(shown.messages[0].media.kind, 'image');
        assert.equal(shown.messages[0].media.state, 'attached');
        assert.equal(shown.messages[0].media.mimeType, mime);
        const listed = await inbox.list({ limit: 20 });
        assert.deepEqual(
          listed.items.find(
            (/** @type {any} */ item) =>
              item.id === uploaded.received.conversation_id,
          ).lastMessage.media,
          shown.messages[0].media,
        );
        const served = await get(
          uploaded.received.conversation_id,
          uploaded.stored.attachment_id,
        );
        assert.equal(served.statusCode, 200);
        assert.equal(served.headers['content-type'], mime);
        assert.deepEqual(served.rawPayload, content);
        assert.equal(
          (
            await get(
              first.received.conversation_id,
              uploaded.stored.attachment_id,
            )
          ).statusCode,
          404,
        );
        if (type === 'document') {
          const counts = await pool.query(
            'SELECT count(*)::int total FROM crm.attachments WHERE message_id=(SELECT id FROM crm.messages WHERE conversation_id=$1)',
            [uploaded.received.conversation_id],
          );
          assert.equal(counts.rows[0].total, 1);
        }
      }
    }
    const missingDocument = await image('117', false, {
      type: 'document',
      mime: 'image/png',
    });
    const missingDocumentDetail = await inbox.get(
      missingDocument.received.conversation_id,
    );
    assert.deepEqual(missingDocumentDetail.messages[0].media, {
      mediaId: null,
      kind: 'image',
      state: 'unavailable',
      mimeType: 'image/png',
      sizeBytes: null,
      durationMs: null,
      contentUrl: null,
    });
    assert.equal(missingDocumentDetail.messages[0].type, 'document');
    const missingList = await inbox.list({ limit: 20 });
    assert.deepEqual(
      missingList.items.find(
        (/** @type {any} */ item) =>
          item.id === missingDocument.received.conversation_id,
      ).lastMessage.media,
      missingDocumentDetail.messages[0].media,
    );
    // A claimed MIME only explains unavailable content. It never provides a URL
    // or bypasses scanning, even when the submitted bytes are a different type.
    detectedMimeType = 'text/html';
    await assert.rejects(
      integration.storeAttachment(missingDocument.input),
      (error) => /** @type {any} */ (error).code === 'UNSUPPORTED_MEDIA_TYPE',
    );
    const rejectedDocumentMedia = (
      await pool.query(
        'SELECT id FROM crm.transient_media WHERE external_media_id=$1',
        [missingDocument.input.externalId],
      )
    ).rows[0];
    assert.equal(
      (
        await get(
          missingDocument.received.conversation_id,
          rejectedDocumentMedia.id,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await inbox.get(missingDocument.received.conversation_id)).messages[0]
        .media.contentUrl,
      null,
    );
    const missingPdf = await image('118', false, {
      type: 'document',
      mime: 'application/pdf',
    });
    assert.equal(
      (await inbox.get(missingPdf.received.conversation_id)).messages[0].media,
      null,
    );
    const pdf = await image('119', true, {
      type: 'document',
      mime: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7\nsynthetic\n'),
    });
    assert.equal(
      (await inbox.get(pdf.received.conversation_id)).messages[0].media,
      null,
    );
    assert.equal(
      (await get(pdf.received.conversation_id, pdf.stored.attachment_id))
        .statusCode,
      404,
    );
    const pdfList = await inbox.list({ limit: 20 });
    assert.equal(
      pdfList.items.find(
        (/** @type {any} */ item) => item.id === pdf.received.conversation_id,
      ).lastMessage.media,
      null,
    );
    detectedMimeType = 'image/png';

    await pool.query(
      "UPDATE crm.transient_media SET availability_status='quarantined',validation_status='stale_signatures' WHERE id=$1",
      [mediaId],
    );
    const quarantined = await inbox.get(first.received.conversation_id);
    assert.equal(quarantined.messages[0].media.state, 'unavailable');
    assert.equal(quarantined.messages[0].media.contentUrl, null);
    assert.equal(
      (await get(first.received.conversation_id, mediaId)).statusCode,
      503,
    );
    await pool.query(
      "UPDATE crm.transient_media SET availability_status='available',validation_status='clean' WHERE id=$1",
      [mediaId],
    );

    const closed = await image('103');
    await pool.query(
      "UPDATE crm.conversations SET state='sem_lead',terminal_at=$2 WHERE id=$1",
      [closed.received.conversation_id, now],
    );
    const closedDetails = await inbox.get(closed.received.conversation_id);
    assert.equal(closedDetails.messages[0].media.state, 'unavailable');
    assert.equal(closedDetails.messages[0].media.contentUrl, null);
    assert.equal(
      (await get(closed.received.conversation_id, closed.stored.attachment_id))
        .statusCode,
      410,
    );
    await assert.rejects(
      integration.storeAttachment(closed.input),
      (error) => /** @type {any} */ (error).code === 'ATTACHMENT_EXPIRED',
    );

    currentTime = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const expired = await image('102');
    currentTime = now;
    const expiredDetails = await inbox.get(expired.received.conversation_id);
    assert.equal(expiredDetails.messages[0].media.state, 'unavailable');
    assert.equal(expiredDetails.messages[0].media.contentUrl, null);
    assert.equal(
      (
        await get(
          expired.received.conversation_id,
          expired.stored.attachment_id,
        )
      ).statusCode,
      410,
    );
    await assert.rejects(
      integration.storeAttachment(expired.input),
      (error) => /** @type {any} */ (error).code === 'ATTACHMENT_EXPIRED',
    );

    const persisted = (
      await pool.query('SELECT * FROM crm.transient_media WHERE id=$1', [
        mediaId,
      ])
    ).rows[0];
    const path = await volume.resolvePath({
      mediaId,
      storageKey: persisted.storage_key,
    });
    assert.ok(path);
    await rm(path);
    assert.equal(
      (await get(first.received.conversation_id, mediaId)).statusCode,
      410,
    );
    const lostDetails = await inbox.get(first.received.conversation_id);
    assert.equal(lostDetails.messages[0].media.state, 'lost');
    assert.equal(lostDetails.messages[0].media.contentUrl, null);

    // IMG-04/MSG-02: failed validation can be retried with the same identity,
    // while the original retention window and one canonical binding remain.
    const failed = await image('104', false);
    const fileCount = (await readdir(directory)).length;
    scanMode = 'offline';
    await assert.rejects(integration.storeAttachment(failed.input));
    const failedRow = (
      await pool.query(
        'SELECT * FROM crm.transient_media WHERE external_media_id=$1',
        [failed.input.externalId],
      )
    ).rows[0];
    assert.equal(failedRow.availability_status, 'unavailable');
    assert.equal(failedRow.unavailable_reason, 'storage_or_scan_failed');
    assert.equal(failedRow.storage_key, null);
    assert.equal((await readdir(directory)).length, fileCount);
    scanMode = 'fresh';
    const recovered = await integration.storeAttachment(failed.input);
    assert.equal(recovered.duplicate, false);
    assert.equal(
      (await integration.storeAttachment(failed.input)).duplicate,
      true,
    );
    const recoveredRow = (
      await pool.query('SELECT * FROM crm.transient_media WHERE id=$1', [
        failedRow.id,
      ])
    ).rows[0];
    assert.equal(recoveredRow.availability_status, 'available');
    assert.equal(
      recoveredRow.expires_at.toISOString(),
      failedRow.expires_at.toISOString(),
    );
    assert.equal((await readdir(directory)).length, fileCount + 1);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int count FROM crm.attachments WHERE transient_media_id=$1',
          [failedRow.id],
        )
      ).rows[0].count,
      1,
    );

    const stale = await image('105', false);
    scanMode = 'stale';
    await assert.rejects(
      integration.storeAttachment(stale.input),
      (error) => /** @type {any} */ (error).code === 'MEDIA_QUARANTINED',
    );
    const staleRow = (
      await pool.query(
        'SELECT * FROM crm.transient_media WHERE external_media_id=$1',
        [stale.input.externalId],
      )
    ).rows[0];
    assert.equal(staleRow.availability_status, 'quarantined');
    assert.ok(staleRow.storage_key);
    const staleFiles = await readdir(directory);
    await assert.rejects(
      integration.storeAttachment(stale.input),
      (error) => /** @type {any} */ (error).code === 'MEDIA_QUARANTINED',
    );
    scanMode = 'offline';
    await assert.rejects(integration.storeAttachment(stale.input));
    assert.equal(
      (
        await pool.query(
          'SELECT availability_status FROM crm.transient_media WHERE id=$1',
          [staleRow.id],
        )
      ).rows[0].availability_status,
      'unavailable',
    );
    scanMode = 'fresh';
    const scanned = await integration.storeAttachment(stale.input);
    const freshRow = (
      await pool.query('SELECT * FROM crm.transient_media WHERE id=$1', [
        staleRow.id,
      ])
    ).rows[0];
    assert.equal(scanned.duplicate, false);
    assert.equal(freshRow.availability_status, 'available');
    assert.equal(freshRow.storage_key, staleRow.storage_key);
    assert.equal(freshRow.size_bytes, staleRow.size_bytes);
    assert.equal(
      freshRow.expires_at.toISOString(),
      staleRow.expires_at.toISOString(),
    );
    assert.deepEqual(await readdir(directory), staleFiles);
    assert.equal(
      (await get(stale.received.conversation_id, staleRow.id)).statusCode,
      200,
    );

    const rejected = await image('106', false);
    scanMode = 'infected';
    await assert.rejects(
      integration.storeAttachment(rejected.input),
      (error) => /** @type {any} */ (error).code === 'UNSUPPORTED_MEDIA_TYPE',
    );
    const calls = scans;
    scanMode = 'fresh';
    await assert.rejects(
      integration.storeAttachment(rejected.input),
      (error) => /** @type {any} */ (error).code === 'ATTACHMENT_NOT_RETRYABLE',
    );
    assert.equal(scans, calls);
    await pool.query(
      "UPDATE crm.transient_media SET availability_status='deleted',deleted_at=now() WHERE id=$1",
      [staleRow.id],
    );
    await assert.rejects(
      integration.storeAttachment(stale.input),
      (error) => /** @type {any} */ (error).code === 'ATTACHMENT_NOT_RETRYABLE',
    );
    assert.equal(scans, calls);
    await assert.rejects(
      integration.storeAttachment(first.input),
      (error) => /** @type {any} */ (error).code === 'ATTACHMENT_NOT_RETRYABLE',
    );
    assert.equal(scans, calls);
    const quota = await image('107', false);
    const limited = createN8nApiRuntime(database, {
      environment: {
        N8N_INTEGRATION_ENVELOPE_KEY: key.toString('base64'),
        CONTACT_IDENTITY_ENVELOPE_KEY: key.toString('base64'),
        CONTACT_IDENTITY_LOOKUP_KEY: key.toString('base64'),
        INBOX_MESSAGE_ENVELOPE_KEY: key.toString('base64'),
      },
      mediaVolume: new PrivateMediaVolume({
        rootDirectory: directory,
        maxBytes: 10 * 1024 * 1024,
        maxFileBytes: 1,
        now: () => currentTime,
        repository: new PostgresTransientMediaRepository({ database }),
        scanner: {
          async scan() {
            throw new Error('quota must prevent scanning');
          },
        },
      }),
      clock: () => currentTime,
    });
    const beforeQuota = await readdir(directory);
    await assert.rejects(
      limited.storeAttachment(quota.input),
      (error) => /** @type {any} */ (error).code === 'MEDIA_QUOTA_EXCEEDED',
    );
    const quotaRow = (
      await pool.query(
        'SELECT * FROM crm.transient_media WHERE external_media_id=$1',
        [quota.input.externalId],
      )
    ).rows[0];
    assert.equal(quotaRow.unavailable_reason, 'quota_exceeded');
    assert.deepEqual(await readdir(directory), beforeQuota);
    assert.equal(
      (await integration.storeAttachment(quota.input)).duplicate,
      false,
    );
    assert.equal(
      (await integration.storeAttachment(quota.input)).duplicate,
      true,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int count FROM crm.attachments WHERE transient_media_id=$1',
          [quotaRow.id],
        )
      ).rows[0].count,
      1,
    );

    for (const [suffix, failure] of [
      ['108', 'stale'],
      ['109', 'offline'],
    ]) {
      const concurrent = await image(suffix, false);
      scanMode = failure;
      await assert.rejects(integration.storeAttachment(concurrent.input));
      const before = (
        await pool.query(
          'SELECT * FROM crm.transient_media WHERE external_media_id=$1',
          [concurrent.input.externalId],
        )
      ).rows[0];
      const files = (await readdir(directory)).length;
      scanMode = 'fresh';
      const outcomes = await Promise.allSettled([
        integration.storeAttachment(concurrent.input),
        integration.storeAttachment(concurrent.input),
      ]);
      const concurrentState = (
        await pool.query(
          'SELECT availability_status FROM crm.transient_media WHERE id=$1',
          [before.id],
        )
      ).rows[0];
      assert.equal(concurrentState.availability_status, 'available');
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        ['fulfilled', 'fulfilled'],
      );
      const results = outcomes.map(
        (outcome) => /** @type {PromiseFulfilledResult<any>} */ (outcome).value,
      );
      assert.deepEqual(results.map((result) => result.duplicate).sort(), [
        false,
        true,
      ]);
      const after = (
        await pool.query('SELECT * FROM crm.transient_media WHERE id=$1', [
          before.id,
        ])
      ).rows[0];
      assert.equal(after.availability_status, 'available');
      assert.equal(after.validation_status, 'clean');
      assert.equal(
        after.expires_at.toISOString(),
        before.expires_at.toISOString(),
      );
      assert.equal(
        (await readdir(directory)).length,
        files + (failure === 'offline' ? 1 : 0),
      );
      if (before.storage_key)
        assert.equal(after.storage_key, before.storage_key);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int count FROM crm.attachments WHERE transient_media_id=$1',
            [before.id],
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int count FROM crm.audit_events WHERE action='integration.n8n.attachment.stored' AND target_id=$1",
            [before.id],
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (await get(concurrent.received.conversation_id, before.id)).statusCode,
        200,
      );
    }
  });
}
