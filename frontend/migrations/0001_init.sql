-- Job requests and their lifecycle.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  bbox          TEXT NOT NULL,          -- "left,bottom,right,top"
  time_before   TEXT NOT NULL,          -- ISO-8601
  time_after    TEXT NOT NULL,          -- ISO-8601
  min_zoom      INTEGER NOT NULL,
  max_zoom      INTEGER NOT NULL,
  num_frames    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','failed')),
  error         TEXT,
  result_key    TEXT,                   -- R2 object key of the finished GIF
  created_at    INTEGER NOT NULL,       -- epoch seconds
  started_at    INTEGER,
  finished_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_email_status ON jobs (email, status);

-- Single-use magic-link login tokens.
CREATE TABLE IF NOT EXISTS login_tokens (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,         -- epoch seconds
  used_at     INTEGER                   -- set when consumed; NULL while unused
);
