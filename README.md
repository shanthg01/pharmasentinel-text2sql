# PharmaSentinel

A 4-tier governed text-to-SQL platform over **OpenFDA FAERS** (adverse
event reports) and **ClinicalTrials.gov**, on local Docker Postgres —
no Snowflake trial account required. Re-anchors the same architecture
as [Snowflake_Chat](https://github.com/shanthg01/Snowflake_Chat) onto a
medical-ontology domain: Ontology → Governed Semantic Views →
Text-to-SQL → Fallback, with pre-execution AST guardrails and an
automated gold-case regression suite.

## Architecture

```
Tier 1 — Ontology (ont.*)         raw column dictionary, curated MedDRA-PT
                                   subset, drug-class/synonym lookups
   │
Tier 2 — Semantic views (sem.*)   governed, human-named, cross-dataset joins
                                   (sem.drug_trial_ae_link links FAERS
                                   drug/reaction data to ClinicalTrials.gov
                                   trials on canonical ingredient)
   │
question → guardrails (2 layers) → Tier 3 (Claude, grounded on sem.*)
                │                        │ no_match / long-tail
                ▼                        ▼
          reject / clarify         Tier 4 (pg_trgm field search over
                                    ont.field_label → Claude → validated
                                    raw-table SQL)
                │
                ▼
      astValidator.ts (SELECT-only, table allowlist, forced LIMIT)
                │
                ▼
           execute → render
```

See [docs/design/data-layer.md](docs/design/data-layer.md) for the full
data-source, licensing (MedDRA is proprietary — this project uses only a
small curated PT subset), and data-quality rationale.

## Repo layout

| Path | What | README |
|---|---|---|
| `db/` | Postgres schema/DDL, seed data, docker-compose | [db/README.md](db/README.md) |
| `etl/` | Python loaders: FAERS bulk export + ClinicalTrials.gov v2 API | [etl/README.md](etl/README.md) |
| `web/` | Next.js app: guardrails, Tier 3/4 engine, Chat/Cohort/Auditor/Evaluation UI | [web/README.md](web/README.md) |
| `docs/design/` | Design docs (data sources, licensing, known gaps) | [docs/design/data-layer.md](docs/design/data-layer.md) |

## Quickstart

```bash
# 1. Database
#
# One command (starts Postgres, applies all DDL, loads seed CSVs, verifies):
#   bash db/setup.sh
#
# ...or the manual steps it automates, if you'd rather see what's happening
# (or aren't running bash):
cp db/.env.example db/.env   # edit password
docker compose -f db/docker-compose.yml --env-file db/.env up -d
# apply db/ddl/000_schemas.sql .. 006_field_search.sql in order (psql or
# `docker exec -i <container> psql -U pharmasentinel -d pharmasentinel`),
# then \copy the two db/seed/*.csv files — see db/README.md for exact commands

# 2. ETL (loads real FAERS + ClinicalTrials.gov data)
cd etl && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
cp .env.example .env   # point at the Postgres above
python faers/fetch_bulk.py --quarters 2023Q4
python faers/load_reports.py --limit 2000   # --limit optional, dev-sized slice
python clinicaltrials/fetch_v2_api.py --condition cancer --intervention-type DRUG --max-studies 200
python clinicaltrials/load_studies.py

# 3. App
cd web && npm install
cp .env.example .env.local   # ANTHROPIC_API_KEY + the PG* vars above
npm run dev   # http://localhost:3000, defaults to /chat
```

## Status

All 4 tiers are real and verified against a live Postgres with real
FAERS/ClinicalTrials.gov data loaded — not stubs. See
[web/README.md](web/README.md) for the current, file-by-file honest
breakdown of what's fully wired vs. a documented follow-up (e.g. the
gold-case suite currently covers 18 of a planned 30+ cases; the
remaining categories need real reference numbers from a larger data
load).

## License note

Full MedDRA (the licensed medical terminology this domain normally
runs on) is proprietary and not included. This project uses only the
free-text reaction terms OpenFDA already publishes, plus a small
hand-curated PT → body-system lookup, clearly marked as illustrative —
see `docs/design/data-layer.md` for the swap-in path if you hold a real
MedDRA subscription.
