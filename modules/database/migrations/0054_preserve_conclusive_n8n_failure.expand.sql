-- OPS-INBOX-SEND-09: an HTTP timeout must not overwrite a callback's final failure.
-- Keep the uncertain job/attempt until the evidence-based poll reconciles it.
CREATE OR REPLACE FUNCTION crm.sync_n8n_command_outbox_outcome()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.job_type = 'n8n.command.deliver'
    AND NEW.n8n_command_id IS NOT NULL
    AND NEW.status = 'outcome_unknown'
    AND OLD.status IS DISTINCT FROM NEW.status
  THEN
    UPDATE crm.n8n_commands
    SET status = 'outcome_unknown', locked_by = NULL, locked_until = NULL,
        last_error_code = COALESCE(NEW.last_error_code, 'OUTCOME_UNKNOWN'),
        retryable = false, retry_safe = false, updated_at = NEW.updated_at,
        completed_at = NEW.completed_at
    WHERE command_id = NEW.n8n_command_id
      AND (status IN ('pending', 'processing')
        OR (status = 'failed' AND (retryable IS DISTINCT FROM false
          OR retry_safe IS DISTINCT FROM false)));
  END IF;
  RETURN NEW;
END;
$$;
