-- INBOX-AUDIO-TRANSCRIPT-01: the transcript of a customer's audio, sent
-- back by the workflow (`message.transcribed`). It is customer content: it is
-- stored only as an AES-256-GCM envelope with the message key, like the text
-- of an inbound message, and follows the same retention as that message.
-- A failed transcription keeps only a bounded code.
--
-- INBOX-DELIVERY-02: the bounded code of why an assistant send failed or
-- ended unknown, so the Inbox can explain it. Never a provider message.
--
-- Expand-only: nullable columns, one more accepted n8n event type. The
-- previous release neither writes nor reads them.
ALTER TABLE crm.messages
  ADD COLUMN transcript_status text
    CHECK (transcript_status IN ('ok', 'failed')),
  ADD COLUMN transcript_envelope jsonb,
  ADD COLUMN transcript_code text CHECK (transcript_code IN (
    'TRANSCRIPTION_FAILED', 'TRANSCRIPTION_EMPTY', 'AUDIO_TOO_LARGE'
  )),
  ADD COLUMN transcribed_at timestamptz,
  ADD COLUMN delivery_failure_code text
    CHECK (delivery_failure_code ~ '^[A-Z0-9_]{1,64}$'),
  ADD CONSTRAINT messages_transcript_shape CHECK (
    (transcript_status IS NULL AND transcript_envelope IS NULL
      AND transcript_code IS NULL AND transcribed_at IS NULL)
    OR (transcript_status = 'ok'
      AND direction = 'inbound' AND message_type = 'audio'
      AND jsonb_typeof(transcript_envelope) = 'object'
      AND transcript_envelope ->> 'algorithm' = 'AES-256-GCM'
      AND transcript_envelope ->> 'keyVersion' = '1'
      AND transcript_envelope ->> 'version' = '1'
      AND transcript_code IS NULL AND transcribed_at IS NOT NULL)
    OR (transcript_status = 'failed'
      AND direction = 'inbound' AND message_type = 'audio'
      AND transcript_envelope IS NULL
      AND transcript_code IS NOT NULL AND transcribed_at IS NOT NULL)
  );

ALTER TABLE crm.n8n_events
  DROP CONSTRAINT n8n_events_type_check,
  ADD CONSTRAINT n8n_events_type_check CHECK (event_type IN (
    'message.inbound', 'attachment.stored', 'message.sent',
    'message.delivered', 'message.read', 'message.failed', 'lead.updated',
    'handoff.requested', 'workflow.failed', 'message.send.requested',
    'message.send.unknown', 'message.transcribed'
  ));
