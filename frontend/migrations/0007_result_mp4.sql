-- MP4 companion to the GIF result (GitHub issue #26). NULL for jobs rendered
-- before this shipped, and for any render where the MP4 encode step failed.
ALTER TABLE jobs ADD COLUMN result_key_mp4 TEXT;
