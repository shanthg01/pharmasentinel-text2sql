# PharmaSentinel — Database Layer

Local Postgres 16 database backing all four tiers of the PharmaSentinel
text-to-SQL platform. This directory owns infrastructure (docker-compose),
DDL, and seed data only — ETL/ingestion code and application/LLM code live
elsewhere in the repo and are owned by other tracks.

For the full rationale behind the schema split, the MedDRA licensing
constraint, the FAERS/CTCAE limitation, and known data-quality gaps, see
[`docs/design/data-layer.md`](../docs/design/data-layer.md). This README is
just the "how to run it" reference.

## Schema / tier mapping

| Schema  | Tier         | Contents                                                            |
|---------|--------------|----------------------------------------------------------------------|
| `faers` | raw          | OpenFDA FAERS drug-event tables, loaded verbatim by ETL              |
| `ct`    | raw          | ClinicalTrials.gov v2 study tables, loaded verbatim by ETL           |
| `ont`   | Tier 1       | Field catalog, curated MedDRA-illustrative terms, drug class/synonym lookups |
| `sem`   | Tier 2       | Curated semantic views — the only surface Tier 3 (LLM SQL generation) is grounded on |

Tiers 3 (text-to-SQL generation) and 4 (raw-schema fallback) are
application-layer and are owned by other tracks; this layer only enforces
their access boundary via schema separation and role grants
(`db/ddl/005_roles.sql`).

## Prerequisites

- Docker Desktop (or compatible engine) with the Compose plugin
- `psql` client available locally (or run it via `docker compose exec`)

## 1. Start Postgres

```bash
cp db/.env.example db/.env
# edit db/.env and set a real POSTGRES_PASSWORD before anything but local dev

docker compose -f db/docker-compose.yml --env-file db/.env up -d

# wait for healthy status
docker compose -f db/docker-compose.yml ps
```

This starts a single `postgres:16` container named `pharmasentinel-postgres`,
publishing port 5432 and persisting data in the named volume
`pharmasentinel-pgdata`.

## 2. Apply DDL, in order

The DDL files are numbered and must be applied in order — later files
depend on schemas/tables/roles created by earlier ones.

```bash
export PGHOST=localhost
export PGPORT=5439
export PGUSER=pharmasentinel      # matches POSTGRES_USER in db/.env
export PGDATABASE=pharmasentinel  # matches POSTGRES_DB in db/.env
export PGPASSWORD=changeme        # matches POSTGRES_PASSWORD in db/.env

for f in db/ddl/000_schemas.sql \
         db/ddl/001_raw_faers.sql \
         db/ddl/002_raw_clinicaltrials.sql \
         db/ddl/003_ontology.sql \
         db/ddl/004_semantic_views.sql \
         db/ddl/005_roles.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -f "$f"
done
```

(On Windows/PowerShell, run each `psql -v ON_ERROR_STOP=1 -f db\ddl\NNN_*.sql`
individually, or adapt the loop to PowerShell's `foreach`.)

## 3. Load seed data

The seed CSVs populate the `ont` lookup tables that the semantic views
(Tier 2) join against. Load them with `\copy` (client-side, so it works
against a container without needing to mount the CSV into it):

```bash
psql -v ON_ERROR_STOP=1 <<'SQL'
\copy ont.drug_class (ingredient, drug_class) FROM 'db/seed/drug_class.csv' WITH (FORMAT csv, HEADER true)
\copy ont.meddra_pt (pt_term, body_system, is_serious_category) FROM 'db/seed/meddra_pt_curated.csv' WITH (FORMAT csv, HEADER true)
SQL
```

`ont.drug_synonym` and `ont.field_label` are not seeded from CSV here — the
former is expected to be populated/extended by the ETL track as it resolves
drug name variants, and the latter already has a handful of illustrative
rows inserted directly by `003_ontology.sql`.

## 4. Verify

```bash
psql -c "SELECT * FROM sem.faers_case_summary LIMIT 5;"
psql -c "SELECT * FROM sem.trials_summary LIMIT 5;"
psql -c "SELECT rolname FROM pg_roles WHERE rolname LIKE 'app_runtime%';"
```

(Both `sem.*` views will legitimately return zero rows until the ETL track
loads raw `faers.*`/`ct.*` data — the views themselves are ready to query as
soon as the DDL above has been applied.)

## Roles

- `app_runtime` — read-only, `SELECT` on `sem.*` and `ont.*` only. Intended
  for Tier 3 / normal application query paths.
- `app_runtime_tier4` — read-only, `SELECT` on `sem.*`, `ont.*`, `faers.*`,
  and `ct.*`. Intended only for the Tier 4 raw-schema fallback path.

Both are created with a `changeme` placeholder password — override via
`ALTER ROLE ... WITH PASSWORD '...'` sourced from your secrets manager
before using this outside of local dev. See the header comment in
`db/ddl/005_roles.sql` for the full rationale behind having two roles
instead of one.

## Resetting

```bash
docker compose -f db/docker-compose.yml down -v   # drops the named volume too
docker compose -f db/docker-compose.yml --env-file db/.env up -d
# re-apply DDL + seeds as above
```
