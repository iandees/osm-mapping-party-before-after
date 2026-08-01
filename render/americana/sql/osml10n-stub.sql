-- Stub replacements for the `osml10n` Postgres extension (mapnik-german-l10n,
-- https://github.com/giggls/mapnik-german-l10n).
--
-- openmaptiles-tools' bundled SQL_TOOLS_DIR (copied into
-- render/americana/openmaptiles-build/sql-tools/ — see the Dockerfile) ships
-- zzz_language.sql and the transportation-name layer SQL, both of which call
-- osml10n_* functions without defining them: the real extension is a compiled
-- C extension that openmaptiles's own reference Postgres image
-- (openmaptiles/postgis, PG14) bundles, but this project's image runs
-- PostgreSQL 16 (see the Dockerfile for why: PG17+ restricts materialized
-- view search_path in a way that breaks the vendored OpenMapTiles SQL) and
-- does not have osml10n built/installed for it.
--
-- Loaded (by make.sh, frame 0 of the Americana import path) before
-- sql-tools/*.sql so those files' own definitions succeed. These are
-- deliberately simple pass-through fallbacks, not a real port of osml10n:
--   - osml10n_get_name_without_brackets_from_tags: real implementation strips
--     bracketed alt-language names and transliterates non-Latin scripts to
--     Latin. Stub returns NULL, so get_latin_name() falls back to name/
--     name:en/int_name only — a non-Latin-only name renders with no
--     "name:latin" field rather than a transliterated approximation.
--   - osml10n_street_abbrev_{all,en,de}: real implementation abbreviates long
--     street-type suffixes (e.g. "Avenue" -> "Ave") for label rendering.
--     Stub returns the input unchanged — long street names render unabbreviated
--     rather than failing to import.
--
-- Both are purely label-cosmetic degradations, not functional blockers.
-- Revisit if Americana's shipped labels need real transliteration/abbreviation
-- parity with upstream OpenMapTiles (would mean building the osml10n extension
-- for PG16, or switching this image to a Postgres version it already targets).

CREATE OR REPLACE FUNCTION osml10n_get_name_without_brackets_from_tags(tags hstore, lang text, geom geometry)
RETURNS text AS $$
  SELECT NULL::text;
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION osml10n_street_abbrev_all(name text)
RETURNS text AS $$
  SELECT name;
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION osml10n_street_abbrev_en(name text)
RETURNS text AS $$
  SELECT name;
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION osml10n_street_abbrev_de(name text)
RETURNS text AS $$
  SELECT name;
$$ LANGUAGE SQL IMMUTABLE;
