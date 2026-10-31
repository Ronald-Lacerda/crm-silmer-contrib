-- INBOX-HANDOFF-02 / AGENTE-FAIL-01: two more reasons for an unassigned
-- handoff, and the seller the customer asked for by name.
--
-- `automation_failure`: the assistant failed (model, parser or agent error on
-- the workflow, or the CRM stall sweep found a customer message left without
-- an answer). `partnership`: the customer wants a partnership or resale deal.
--
-- `preferred_user_id` only records the request. The handoff still opens
-- without an owner, and any active Vendedor can claim it (ADR 009, RULES.md
-- rule 20). It is text because crm.users.id is text (SPEC_DEVIATION of 0023).
--
-- Expand-only: the previous release never writes the new values and never
-- reads the new nullable column.

ALTER TABLE crm.handoffs
  DROP CONSTRAINT handoffs_reason_code_check,
  ADD CONSTRAINT handoffs_reason_code_check CHECK (reason_code IN (
    'customer_requested_human', 'price_before_quote', 'unresolved_blocker',
    'low_confidence', 'briefing_complete', 'human_requested', 'negotiation',
    'complaint', 'urgency', 'unsupported', 'iteration_limit',
    'automation_failure', 'partnership'
  ));

ALTER TABLE crm.handoffs
  ADD COLUMN preferred_user_id text REFERENCES crm.users (id)
    ON DELETE RESTRICT;
