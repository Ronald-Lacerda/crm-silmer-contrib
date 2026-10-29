-- ADR 047 / CP-25..27: the optional customer registration is private data in
-- its own AES-256-GCM envelope. The list reads only the completeness flag; the
-- CPF/CNPJ is neither unique nor a merge key. Celular and e-mail stay in the
-- contact details envelope (ADR 033).
ALTER TABLE crm.contacts
  ADD COLUMN registration_envelope jsonb,
  ADD COLUMN registration_fields_complete boolean NOT NULL DEFAULT false;

ALTER TABLE crm.contacts
  ADD CONSTRAINT contacts_registration_envelope_shape CHECK (
    registration_envelope IS NULL OR (
      jsonb_typeof(registration_envelope) = 'object'
      AND registration_envelope ->> 'algorithm' = 'AES-256-GCM'
      AND registration_envelope ->> 'version' = '1')
  ),
  ADD CONSTRAINT contacts_registration_complete_envelope CHECK (
    NOT registration_fields_complete OR registration_envelope IS NOT NULL
  );
