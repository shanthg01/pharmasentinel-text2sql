-- =============================================================================
-- 005_roles.sql
-- Read-only application roles
-- =============================================================================
--
-- Two roles, deliberately kept separate rather than one role with broad
-- access, because they encode two different trust levels in the platform's
-- tier model:
--
--   app_runtime          Tier 3 (LLM text-to-SQL generation) and any normal
--                          application query path. Can SELECT from sem.*
--                          (the governed semantic layer) and ont.* (the
--                          ontology/lookup tables it may legitimately need
--                          to join against, e.g. resolving a drug synonym
--                          in a generated query). Cannot see faers.*/ct.*
--                          raw tables at all -- if a bug or a prompt
--                          injection tricked Tier 3 into emitting
--                          `SELECT * FROM faers.report`, this role makes
--                          that fail at the database, not just at the
--                          application layer.
--
--   app_runtime_tier4     Tier 4's raw-schema fallback path only. Everything
--                          app_runtime can see, PLUS SELECT on faers.*/ct.*.
--                          This is intentionally a second, wider role rather
--                          than widening app_runtime, so that any connection
--                          using it is self-evidently "the fallback path was
--                          invoked" for audit/logging purposes -- you can
--                          tell which tier touched raw data purely from
--                          which role executed the query.
--
-- Both roles are NOLOGIN-safe application roles: NOSUPERUSER NOCREATEDB
-- NOCREATEROLE, and SELECT-only (no INSERT/UPDATE/DELETE/DDL) since neither
-- tier should ever be able to mutate data.
--
-- *** PASSWORD NOTE ***
-- The 'changeme' password below is a local-dev placeholder only. In any
-- shared or production environment, override it immediately after running
-- this file, e.g.:
--   ALTER ROLE app_runtime        WITH PASSWORD '<from secrets manager>';
--   ALTER ROLE app_runtime_tier4  WITH PASSWORD '<from secrets manager>';
-- Do not commit real credentials -- these ALTER statements belong in a
-- secrets-managed deploy step, not in version control.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- app_runtime -- Tier 3 / normal application access: sem.* + ont.* only
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime WITH LOGIN PASSWORD 'changeme' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

COMMENT ON ROLE app_runtime IS 'Tier 3 / application read-only role. SELECT on sem.* and ont.* only -- no access to raw faers.*/ct.* tables.';

GRANT USAGE ON SCHEMA sem TO app_runtime;
GRANT USAGE ON SCHEMA ont TO app_runtime;

GRANT SELECT ON ALL TABLES IN SCHEMA sem TO app_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA ont TO app_runtime;

-- Ensure future tables/views created in sem/ont are automatically readable
-- by app_runtime without a manual follow-up GRANT -- this is what keeps the
-- Tier 3 access boundary from silently regressing to "forgot to grant" as
-- the semantic layer grows.
ALTER DEFAULT PRIVILEGES IN SCHEMA sem GRANT SELECT ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA ont GRANT SELECT ON TABLES TO app_runtime;

-- ---------------------------------------------------------------------------
-- app_runtime_tier4 -- Tier 4 fallback: everything app_runtime has, PLUS raw
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_tier4') THEN
        CREATE ROLE app_runtime_tier4 WITH LOGIN PASSWORD 'changeme' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;

COMMENT ON ROLE app_runtime_tier4 IS 'Tier 4 raw-schema fallback role. SELECT on sem.*, ont.*, faers.*, and ct.*. Narrower-scoped, audit-distinguishable alternative to widening app_runtime -- use only for the documented fallback path.';

GRANT USAGE ON SCHEMA sem TO app_runtime_tier4;
GRANT USAGE ON SCHEMA ont TO app_runtime_tier4;
GRANT USAGE ON SCHEMA faers TO app_runtime_tier4;
GRANT USAGE ON SCHEMA ct TO app_runtime_tier4;

GRANT SELECT ON ALL TABLES IN SCHEMA sem TO app_runtime_tier4;
GRANT SELECT ON ALL TABLES IN SCHEMA ont TO app_runtime_tier4;
GRANT SELECT ON ALL TABLES IN SCHEMA faers TO app_runtime_tier4;
GRANT SELECT ON ALL TABLES IN SCHEMA ct TO app_runtime_tier4;

ALTER DEFAULT PRIVILEGES IN SCHEMA sem   GRANT SELECT ON TABLES TO app_runtime_tier4;
ALTER DEFAULT PRIVILEGES IN SCHEMA ont   GRANT SELECT ON TABLES TO app_runtime_tier4;
ALTER DEFAULT PRIVILEGES IN SCHEMA faers GRANT SELECT ON TABLES TO app_runtime_tier4;
ALTER DEFAULT PRIVILEGES IN SCHEMA ct    GRANT SELECT ON TABLES TO app_runtime_tier4;
