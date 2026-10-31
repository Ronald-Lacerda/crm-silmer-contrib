/**
 * INBOX-AUDIO-TRANSCRIPT-01 (RFC 041): the automatic transcript of a
 * customer's audio, as the Inbox read model sends it
 * (`transcript: {status: 'ok'|'failed', text|null}`). The text is the
 * customer's words: it is shown in full (behind "Ler transcrição completa"
 * when long), never cut without a way to read the rest, and never stored.
 */

/** Characters shown before "Ler transcrição completa". */
export const TRANSCRIPT_PREVIEW_CHARS = 280;

/**
 * @typedef {{status: 'ok', text: string, preview: string, long: boolean}|{status: 'failed'}} MessageTranscript
 */

/**
 * The transcript to show under the audio, or null when there is none (an
 * older API, a pending transcription or an answer outside the contract).
 *
 * @param {unknown} transcript
 * @returns {MessageTranscript|null}
 */
export function messageTranscript(transcript) {
  if (!transcript || typeof transcript !== 'object') return null;
  const value = /** @type {Record<string, unknown>} */ (transcript);
  if (value.status === 'failed') return { status: 'failed' };
  if (value.status !== 'ok' || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  if (!text) return null;
  const long = text.length > TRANSCRIPT_PREVIEW_CHARS;
  return { long, preview: long ? previewOf(text) : text, status: 'ok', text };
}

/** The start of a long text, cut at a word and marked with "…". @param {string} text */
function previewOf(text) {
  const head = text.slice(0, TRANSCRIPT_PREVIEW_CHARS);
  const space = head.search(/\s\S*$/u);
  const cut =
    space > TRANSCRIPT_PREVIEW_CHARS / 2 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}
