-- Optional scale bar overlay (GitHub issue #23). Defaults off for existing rows.
ALTER TABLE jobs ADD COLUMN scale_bar INTEGER NOT NULL DEFAULT 0;
