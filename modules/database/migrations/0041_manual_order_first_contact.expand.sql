-- T136 / PLA-02: a manual order starts its own first contact. Preserve every
-- recorded date and immutable print snapshot; only fill the missing metadata.
UPDATE crm.orders
SET first_contact_at = created_at
WHERE origin = 'atendimento'
  AND conversation_id IS NULL
  AND first_contact_at IS NULL;
