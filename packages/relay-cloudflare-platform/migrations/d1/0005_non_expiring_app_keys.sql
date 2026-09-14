DROP INDEX platform_app_credentials_lookup;
ALTER TABLE platform_app_credentials DROP COLUMN expires_at;
CREATE INDEX platform_app_credentials_lookup
  ON platform_app_credentials(public_credential_id, revoked_at, overlap_ends_at);
