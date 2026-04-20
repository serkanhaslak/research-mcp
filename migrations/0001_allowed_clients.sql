-- Capability URL auth table.
-- secret_hash = hex(SHA-256(plaintext_secret)). Plaintext is NEVER stored server-side.
-- The plaintext secret lives in the URL path: /s/<plaintext>/mcp
CREATE TABLE IF NOT EXISTS allowed_clients (
  secret_hash    TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  revoked        INTEGER NOT NULL DEFAULT 0,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_allowed_clients_email ON allowed_clients(email);
