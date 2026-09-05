-- =============================================================================
-- 000_schemas.sql
-- PharmaSentinel schema layout
-- =============================================================================
--
-- PharmaSentinel is a 4-tier governed text-to-SQL platform. This file creates
-- the four Postgres schemas that back those tiers. Splitting raw ingestion
-- from curated/governed layers (rather than one flat schema) is the single
-- most load-bearing decision in the data layer: it is what lets us hand an
-- LLM a small, well-documented, semantically stable surface (sem/ont) while
-- the raw tables underneath are free to be messy, wide, and to change shape
-- as upstream sources evolve, without breaking Tier 3 prompts or grounding.
--
-- Schema -> Tier mapping:
--
--   faers   raw           Unprocessed OpenFDA FAERS drug-event data, loaded
--                          verbatim (modulo type-casting) by the ETL track.
--                          Not a "tier" in the platform's own numbering --
--                          it's the ingestion substrate everything else is
--                          built from. Never queried directly by Tier 3.
--
--   ct      raw           Unprocessed ClinicalTrials.gov v2 API study data.
--                          Same rationale/restrictions as faers.*.
--
--   ont     Tier 1         Ontology / governance layer: field catalog and
--                          human labels, curated MedDRA-illustrative term
--                          mappings, drug class mappings, drug name
--                          synonym/normalization table. This is metadata
--                          *about* the data (what a column means, how a
--                          drug name variant maps to a canonical ingredient)
--                          rather than the data itself. Tier 3's prompt
--                          grounding and Tier 4's fallback path both read
--                          from here.
--
--   sem     Tier 2         Semantic layer: curated, denormalized, governed
--                          views (faers_case_summary, trials_summary, etc.)
--                          that join raw + ontology into analysis-ready
--                          shapes. This is the ONLY layer Tier 3 (LLM SQL
--                          generation) is normally allowed to generate SQL
--                          against -- see db/ddl/004_semantic_views.sql for
--                          the full rule and its one documented exception
--                          (Tier 4 fallback).
--
-- Tiers 3 (text-to-SQL generation) and 4 (fallback / raw-schema escape
-- hatch) are application-layer concerns owned by other tracks; this schema
-- split is what makes their access boundary enforceable at the database
-- level via GRANTs (see db/ddl/005_roles.sql) rather than by convention only.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS faers;
COMMENT ON SCHEMA faers IS 'Raw OpenFDA FAERS drug-event tables, loaded by ETL. Not directly queryable by Tier 3 LLM SQL generation.';

CREATE SCHEMA IF NOT EXISTS ct;
COMMENT ON SCHEMA ct IS 'Raw ClinicalTrials.gov v2 API study tables, loaded by ETL. Not directly queryable by Tier 3 LLM SQL generation.';

CREATE SCHEMA IF NOT EXISTS ont;
COMMENT ON SCHEMA ont IS 'Tier 1: ontology / governance layer -- field catalog, curated MedDRA-illustrative terms, drug class + synonym lookups.';

CREATE SCHEMA IF NOT EXISTS sem;
COMMENT ON SCHEMA sem IS 'Tier 2: curated semantic views. This is the layer Tier 3 text-to-SQL generation is grounded on and allowed to query.';
