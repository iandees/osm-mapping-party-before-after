-- Deferred ("scheduled") jobs: a job whose time_after is still in the future is
-- held until after that time passes, then dispatched to the queue. This needs a
-- new 'scheduled' status value plus two timestamps:
--   scheduled_for — when the dispatcher should enqueue it (time_after + buffer)
--   queued_at     — when it was actually dispatched to the queue; the reaper clock
--                   measures from here, NOT created_at, so a job scheduled days out
--                   is not reaped the instant it is created.
--
-- SQLite cannot ALTER a CHECK constraint, so the status CHECK must be widened by
-- rebuilding the table. Do the whole change (widen CHECK + add columns) in one
-- rebuild, backfilling queued_at = created_at for existing rows.

CREATE TABLE jobs_new (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  bbox          TEXT NOT NULL,
  time_before   TEXT NOT NULL,
  time_after    TEXT NOT NULL,
  zoom          INTEGER NOT NULL,
  output_px     INTEGER NOT NULL,
  num_frames    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('scheduled','queued','running','done','failed')),
  error         TEXT,
  result_key    TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  progress      TEXT,
  name          TEXT,
  cost_usd      REAL,
  scheduled_for INTEGER,               -- epoch seconds; NULL for immediate jobs
  queued_at     INTEGER                -- epoch seconds; when dispatched to the queue
);

INSERT INTO jobs_new
  (id, email, bbox, time_before, time_after, zoom, output_px, num_frames, status,
   error, result_key, created_at, started_at, finished_at, progress, name, cost_usd,
   scheduled_for, queued_at)
SELECT
   id, email, bbox, time_before, time_after, zoom, output_px, num_frames, status,
   error, result_key, created_at, started_at, finished_at, progress, name, cost_usd,
   NULL, created_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX IF NOT EXISTS idx_jobs_email_status ON jobs (email, status);
CREATE INDEX IF NOT EXISTS idx_jobs_done ON jobs (status, finished_at);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs (status, scheduled_for);
