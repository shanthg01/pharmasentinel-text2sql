-- =============================================================================
-- 006_field_search.sql
-- Tier 4 fallback ranking: trigram similarity search over ont.field_label
-- =============================================================================
--
-- The reference Snowflake-based architecture this project is modeled after
-- uses Cortex Search (a managed full-text/semantic search service) to rank
-- candidate raw columns against a user's question when the curated
-- semantic layer (sem.*) can't answer it. Postgres has no equivalent
-- managed service, so Tier 4's ranking step instead uses `pg_trgm`
-- (trigram) similarity directly over `ont.field_label.human_label` -- the
-- same hand-curated human-readable labels described in
-- `003_ontology.sql`. This is the fallback ranking mechanism that narrows
-- an otherwise-unbounded raw `faers.*`/`ct.*` schema down to a small
-- relevant candidate set before anything reaches an LLM prompt (see
-- `web/src/lib/sql/fieldSearch.ts` and `web/src/lib/text2sql/tier4.ts`).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on the human-readable label, since Tier 4 similarity
-- ranking (searchFieldCandidates in web/src/lib/sql/fieldSearch.ts) matches
-- the user's raw question text against human_label, not the internal
-- schema/table/column identifiers.
CREATE INDEX IF NOT EXISTS idx_ont_field_label_human_label_trgm
    ON ont.field_label
    USING gin (human_label gin_trgm_ops);

-- Schema-qualified: an unqualified index name here resolves against
-- search_path, which doesn't include `ont` by default and makes this
-- COMMENT fail with "relation does not exist" even though the index
-- above was created successfully.
COMMENT ON INDEX ont.idx_ont_field_label_human_label_trgm IS 'Trigram index backing Tier 4''s pg_trgm similarity() ranking over ont.field_label.human_label -- the fallback replacement for Cortex Search in the Snowflake-based reference architecture. See file header.';
