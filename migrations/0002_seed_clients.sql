-- Seed two assigned capability secrets. Plaintext is in CAPABILITY_SECRETS.md (gitignored).
INSERT OR IGNORE INTO allowed_clients (secret_hash, email, created_at, note) VALUES
  ('f69c4aebb3b6deff6703038bef4dc2df9bf7cd0bcd31e24f949c67a8f67041ee', 'serkan@pragmaticgrowth.com',    strftime('%s','now')*1000, 'initial seed'),
  ('fbb549878e81810efc759cb22a8cecf05ed22c1d18fb3a4605224653de8635fa', 'serkan.haslak@figopara.com',    strftime('%s','now')*1000, 'initial seed');
