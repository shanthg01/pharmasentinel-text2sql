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
- A `psql` client. **Most setups won't have one installed locally** — this
  is genuinely fine; every command below has a `docker exec` form that runs
  `psql` *inside* the container instead, which needs nothing installed on
  the host beyond Docker itself. Use whichever you have; the `docker exec`
  form is what was actually verified end-to-end for this project (a bare
  cold start on a machine with no local `psql`).

## 1. Start Postgres

```bash
cp db/.env.example db/.env
# edit db/.env and set a real POSTGRES_PASSWORD before anything but local dev

docker compose -f db/docker-compose.yml --env-file db/.env up -d

# wait for healthy status
docker compose -f db/docker-compose.yml ps
```

This starts a single `postgres:16` container named `pharmasentinel-postgres`,
persisting data in the named volume `pharmasentinel-pgdata`. It publishes on
host port **5439** by default (`POSTGRES_HOST_PORT` in `db/.env`), not the
Postgres-standard 5432 — deliberately, so it doesn't fail to bind on a
machine that already has some other Postgres container using 5432 (a real
collision hit while building this project). Override
`POSTGRES_HOST_PORT` if 5439 is ever taken too.

## 2. Apply DDL, in order

The DDL files are numbered and must be applied in order — later files
depend on schemas/tables/roles created by earlier ones. **All six**,
through `006` — an earlier version of this doc stopped at `005` and missed
`006_field_search.sql` (the `pg_trgm` extension + index Tier 4's fallback
search needs), which silently left Tier 4 broken for anyone who followed
this doc literally.

Using the container's own `psql` (no local client needed):

```bash
for f in db/ddl/000_schemas.sql \
         db/ddl/001_raw_faers.sql \
         db/ddl/002_raw_clinicaltrials.sql \
         db/ddl/003_ontology.sql \
         db/ddl/004_semantic_views.sql \
         db/ddl/005_roles.sql \
         db/ddl/006_field_search.sql; do
  echo "applying $f"
  cat "$f" | docker exec -i pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -v ON_ERROR_STOP=1
done
```

Or, with a local `psql` client (adjust `PGPORT` if you overrode
`POSTGRES_HOST_PORT` above):

```bash
export PGHOST=localhost
export PGPORT=5439
export PGUSER=pharmasentinel      # matches POSTGRES_USER in db/.env
export PGDATABASE=pharmasentinel  # matches POSTGRES_DB in db/.env
export PGPASSWORD=changeme        # matches POSTGRES_PASSWORD in db/.env

for f in db/ddl/000_schemas.sql db/ddl/001_raw_faers.sql db/ddl/002_raw_clinicaltrials.sql \
         db/ddl/003_ontology.sql db/ddl/004_semantic_views.sql db/ddl/005_roles.sql \
         db/ddl/006_field_search.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -f "$f"
done
```

(On Windows/PowerShell with a local client, run each
`psql -v ON_ERROR_STOP=1 -f db\ddl\NNN_*.sql` individually, or adapt the
loop to PowerShell's `foreach`.)

## 3. Load seed data

The seed CSVs populate the `ont` lookup tables that the semantic views
(Tier 2) join against.

Using the container's own `psql` — `\copy` reads the file from wherever the
`psql` process runs, so pipe the CSV in over stdin rather than referencing
a host path the container can't see:

```bash
docker exec -i pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -v ON_ERROR_STOP=1 \
  -c "\copy ont.drug_class(ingredient, drug_class) FROM STDIN WITH (FORMAT csv, HEADER true)" \
  < db/seed/drug_class.csv

docker exec -i pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -v ON_ERROR_STOP=1 \
  -c "\copy ont.meddra_pt(pt_term, body_system, is_serious_category) FROM STDIN WITH (FORMAT csv, HEADER true)" \
  < db/seed/meddra_pt_curated.csv
```

Or, with a local `psql` client (same env vars as step 2, `\copy` here reads
the file straight off your own filesystem):

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
docker exec pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -c "SELECT * FROM sem.faers_case_summary LIMIT 5;"
docker exec pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -c "SELECT * FROM sem.trials_summary LIMIT 5;"
docker exec pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -c "SELECT rolname FROM pg_roles WHERE rolname LIKE 'app_runtime%';"
docker exec pharmasentinel-postgres psql -U pharmasentinel -d pharmasentinel -c "\dx" # confirm pg_trgm is listed (006)
```

(swap in a bare `psql ...` with the step-2 env vars if using a local client)

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
