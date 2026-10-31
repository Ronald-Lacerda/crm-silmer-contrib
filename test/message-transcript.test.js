import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRANSCRIPT_PREVIEW_CHARS,
  messageTranscript,
} from '../apps/edge-web/src/lib/message-transcript.js';

// INBOX-AUDIO-TRANSCRIPT-01 (RFC 041): synthetic text only.

test('shows a short transcript whole', () => {
  assert.deepEqual(
    messageTranscript({ status: 'ok', text: '  Quero 30 camisetas.  ' }),
    {
      long: false,
      preview: 'Quero 30 camisetas.',
      status: 'ok',
      text: 'Quero 30 camisetas.',
    },
  );
});

test('opens a long transcript from a preview cut at a word', () => {
  const text = `${'palavra '.repeat(60)}fim`;
  const view = messageTranscript({ status: 'ok', text });
  assert.equal(view?.status, 'ok');
  if (view?.status !== 'ok') return;
  assert.equal(view.long, true);
  assert.equal(view.text, text);
  assert.ok(view.preview.endsWith('palavra…'), view.preview);
  assert.ok(view.preview.length <= TRANSCRIPT_PREVIEW_CHARS + 1);
});

test('a failed transcription is a status without text', () => {
  assert.deepEqual(
    messageTranscript({ status: 'failed', text: null, code: 'X' }),
    { status: 'failed' },
  );
});

test('nothing to show without a transcript the contract allows', () => {
  assert.equal(messageTranscript(null), null);
  assert.equal(messageTranscript(undefined), null);
  assert.equal(messageTranscript('texto'), null);
  assert.equal(messageTranscript({ status: 'pending' }), null);
  assert.equal(messageTranscript({ status: 'ok', text: '   ' }), null);
  assert.equal(messageTranscript({ status: 'ok', text: 42 }), null);
});
