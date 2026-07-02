-- Free-text progress message shown while a job runs (e.g. "Importing frame 3/24").
ALTER TABLE jobs ADD COLUMN progress TEXT;

-- Index to fetch recent finished jobs for the galleries.
CREATE INDEX IF NOT EXISTS idx_jobs_done ON jobs (status, finished_at);
