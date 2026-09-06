#!/usr/bin/env bash
# One-shot bootstrap: start Postgres, apply all DDL (000-006), load seed CSVs, verify.
# Usage: bash db/setup.sh   (run from the repo root; safe to re-run)
set -euo pipefail

# Resolve paths relative to this script's location so it works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$SCRIPT_DIR"
COMPOSE_FILE="$DB_DIR/docker-compose.yml"
ENV_FILE="$DB_DIR/.env"
ENV_EXAMPLE="$DB_DIR/.env.example"
CONTAINER="pharmasentinel-postgres"
PG_USER="pharmasentinel"
PG_DB="pharmasentinel"
HEALTH_TIMEOUT_SECS=60

log() { echo "[db/setup.sh] $*"; }
die() { echo "[db/setup.sh] ERROR: $*" >&2; exit 1; }

# --- 0. .env ---------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "Created $ENV_FILE from $ENV_EXAMPLE."
  log "NOTE: it contains the placeholder POSTGRES_PASSWORD=changeme — change it before using this beyond local dev."
else
  log "$ENV_FILE already exists — leaving it untouched."
fi

# --- 1. Start Postgres and wait for healthy ---------------------------------
log "Starting Postgres via docker compose..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d \
  || die "docker compose up failed."

log "Waiting for $CONTAINER to report healthy (timeout ${HEALTH_TIMEOUT_SECS}s)..."
elapsed=0
poll_interval=2
status=""
while [ "$elapsed" -lt "$HEALTH_TIMEOUT_SECS" ]; do
  # NOTE: don't fold the "|| echo missing" fallback into the same command
  # substitution as the docker inspect call -- on a missing object, docker
  # inspect still writes a lone newline to stdout (its error goes to
  # stderr), and command substitution only strips *trailing* newlines from
  # the whole capture, so "$(cmd 2>/dev/null || echo missing)" ends up as
  # the literal string "\nmissing", which never equals "missing" below.
  # Checking emptiness as a separate step sidesteps that.
  status="$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)"
  if [ -z "$status" ]; then
    status="missing"
  fi
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "missing" ]; then
    die "Container '$CONTAINER' not found — did docker compose up succeed?"
  fi
  sleep "$poll_interval"
  elapsed=$((elapsed + poll_interval))
done

if [ "$status" != "healthy" ]; then
  die "$CONTAINER did not become healthy within ${HEALTH_TIMEOUT_SECS}s (last status: '$status'). Check 'docker compose -f $COMPOSE_FILE logs postgres'."
fi
log "$CONTAINER is healthy."

# --- 2. Apply DDL, in order --------------------------------------------------
DDL_FILES=(
  "000_schemas.sql"
  "001_raw_faers.sql"
  "002_raw_clinicaltrials.sql"
  "003_ontology.sql"
  "004_semantic_views.sql"
  "005_roles.sql"
  "006_field_search.sql"
)

for f in "${DDL_FILES[@]}"; do
  path="$DB_DIR/ddl/$f"
  [ -f "$path" ] || die "DDL file not found: $path"
  log "Applying db/ddl/$f ..."
  docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < "$path" \
    || die "Applying db/ddl/$f failed."
done
log "All DDL files applied."

# --- 3. Load seed data --------------------------------------------------------
# The seed tables are keyed by PRIMARY KEY (ont.drug_class on
# (ingredient, drug_class), ont.meddra_pt on pt_term) and \copy has no
# ON CONFLICT clause, so re-running \copy against an already-populated table
# would fail with a primary-key violation. Guard by row count instead of
# silently erroring on a re-run.

seed_count() {
  # $1 = fully-qualified table name
  docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tA -c "SELECT count(*) FROM $1;"
}

load_seed() {
  # $1 = csv path, $2 = \copy target-columns clause, $3 = table name (for count check)
  local csv="$1" copy_cols="$2" table="$3"
  local n
  n="$(seed_count "$table")" || die "Could not check row count of $table."
  if [ "$n" -gt 0 ]; then
    log "Skipping $csv — $table already has $n row(s) (re-running \\copy would hit a primary-key conflict; this is not a hard failure, just a no-op)."
    return 0
  fi
  log "Loading $csv into $table ..."
  docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 \
    -c "\\copy $copy_cols FROM STDIN WITH (FORMAT csv, HEADER true)" \
    < "$csv" \
    || die "Loading $csv failed."
}

load_seed "$DB_DIR/seed/drug_class.csv" \
  "ont.drug_class(ingredient, drug_class)" \
  "ont.drug_class"

load_seed "$DB_DIR/seed/meddra_pt_curated.csv" \
  "ont.meddra_pt(pt_term, body_system, is_serious_category)" \
  "ont.meddra_pt"

# --- 4. Verify ----------------------------------------------------------------
log "Verifying setup..."
echo
echo "--- sem.faers_case_summary (up to 5 rows) ---"
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "SELECT * FROM sem.faers_case_summary LIMIT 5;" \
  || die "Verify query against sem.faers_case_summary failed."

echo "--- sem.trials_summary (up to 5 rows) ---"
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "SELECT * FROM sem.trials_summary LIMIT 5;" \
  || die "Verify query against sem.trials_summary failed."

echo "--- app_runtime* roles ---"
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "SELECT rolname FROM pg_roles WHERE rolname LIKE 'app_runtime%';" \
  || die "Verify query against pg_roles failed."

echo "--- extensions (expect pg_trgm) ---"
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "\dx" \
  || die "Verify \\dx failed."

echo
log "Setup complete. (sem.* views may legitimately show 0 rows until the ETL track loads raw faers.*/ct.* data.)"
