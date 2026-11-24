PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'paired', 'closed')),
  created_at INTEGER NOT NULL,
  paired_at INTEGER,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pairing_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'file')),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('phone', 'laptop')),
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_session_date
  ON activity_events(session_id, created_at DESC);
