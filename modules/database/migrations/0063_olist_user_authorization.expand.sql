-- OLIST-T19 / OLIST-02, 03, 27, 33, 48: authorization is orthogonal to profile.
-- Expansion only. Existing users and sessions never acquire ERP permission.
ALTER TABLE crm.users
  ADD COLUMN olist_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN olist_authorization_version integer NOT NULL DEFAULT 0
    CHECK (olist_authorization_version >= 0);
