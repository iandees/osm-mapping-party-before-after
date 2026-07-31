-- frontend/migrations/0007_style.sql
-- Americana as an alternate render style (architecture integration; no UI
-- picker yet — see the integration design doc for the deferred follow-up).
ALTER TABLE jobs ADD COLUMN style TEXT NOT NULL DEFAULT 'carto';
