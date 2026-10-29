import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { mediaError } from './chat-media-runtime.js';

const MIME_TYPES = /** @type {Record<string, string[]>} */ ({
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  audio: ['audio/mpeg', 'audio/ogg'],
  video: ['video/mp4'],
});

/**
 * Serves canonical inbound attachments through the same private Inbox URL as
 * retained seller media. No provider URL or filename determines a read path.
 * @param {{database: any, access: any, mediaVolume: any, retained?: any, clock?: () => Date}} dependencies
 */
export function createInboundMediaRuntime({
  database,
  access,
  mediaVolume,
  retained,
  clock = () => new Date(),
}) {
  return {
    authorizeRead: (/** @type {any} */ input) => access.authorizeRead(input),
    async content(/** @type {any} */ input) {
      if (!/^media-[a-f0-9-]{36}$/u.test(input.mediaId)) {
        if (retained) return retained.content(input);
        throw mediaError(404);
      }
      const row = (
        await database.query(
          `SELECT media.*, conversation.terminal_at
           FROM crm.attachments attachment
           JOIN crm.messages message ON message.id=attachment.message_id
           JOIN crm.conversations conversation ON conversation.id=message.conversation_id
           JOIN crm.transient_media media ON media.id=attachment.transient_media_id
           WHERE media.id=$1 AND message.conversation_id=$2
             AND message.direction='inbound' AND media.media_type=message.message_type
             AND (message.message_type IN ('image','audio','video')
               OR (message.message_type='document' AND media.detected_mime_type
                 IN ('image/jpeg','image/png','image/webp','image/gif')))`,
          [input.mediaId, input.conversationId],
        )
      ).rows[0];
      if (!row) throw mediaError(404);
      if (
        row.availability_status === 'lost' ||
        row.availability_status === 'deleted' ||
        row.terminal_at ||
        new Date(row.expires_at).getTime() <= clock().getTime()
      )
        throw mediaError(410);
      const size = Number(row.size_bytes);
      // A raster image sent as a document keeps its historical message type;
      // only its private presentation and byte limit follow the detected MIME.
      const kind =
        row.media_type === 'document' &&
        MIME_TYPES.image.includes(row.detected_mime_type)
          ? 'image'
          : row.media_type;
      if (
        row.availability_status !== 'available' ||
        row.validation_status !== 'clean' ||
        !Number.isFinite(new Date(row.expires_at).getTime()) ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > (kind === 'image' ? 5 : 16) * 1024 * 1024 ||
        !MIME_TYPES[kind]?.includes(row.detected_mime_type) ||
        !/^[a-f0-9]{64}$/u.test(row.content_sha256 ?? '')
      )
        throw mediaError(503);
      const binding = {
        mediaId: row.id,
        storageKey: row.storage_key,
      };
      const path = await mediaVolume.resolvePath(binding);
      if (!path) throw mediaError(410);
      let file;
      try {
        file = await open(path, 'r');
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          // Mark a loss between resolution and opening through the volume's
          // existing state transition, without exposing the private pathname.
          await mediaVolume.resolvePath(binding);
          throw mediaError(410);
        }
        throw mediaError(503);
      }
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size !== size) throw mediaError(503);
        const digest = createHash('sha256');
        let readBytes = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          readBytes += chunk.length;
          if (readBytes > size) throw mediaError(503);
          digest.update(chunk);
        }
        if (digest.digest('hex') !== row.content_sha256) throw mediaError(503);
        const { start, end, partial } = contentRange(input.range, size);
        return {
          statusCode: partial ? 206 : 200,
          stream: file.createReadStream({ start, end }),
          headers: {
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Accept-Ranges': 'bytes',
            'Content-Type': row.detected_mime_type,
            'Content-Length': String(end - start + 1),
            ...(partial
              ? { 'Content-Range': `bytes ${start}-${end}/${size}` }
              : {}),
          },
        };
      } catch (error) {
        await file.close();
        throw error;
      }
    },
  };
}

/** @param {unknown} range @param {number} size */
function contentRange(range, size) {
  if (range === undefined) return { start: 0, end: size - 1, partial: false };
  const invalid = () =>
    Object.assign(mediaError(416), { contentRange: `bytes */${size}` });
  const match = typeof range === 'string' && /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match || (!match[1] && !match[2])) throw invalid();
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))
    throw invalid();
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if ((!match[1] && last < 1) || start >= size || end < start) throw invalid();
  return { start, end, partial: true };
}
