# PharmaSentinel ETL

Batch/offline data-loading layer for PharmaSentinel. This is **not** part of
the live query-serving app -- it's a set of standalone scripts that populate
the local Docker Postgres instance from two public sources:

- openFDA FAERS (adverse event reports) -- bulk quarterly export files
- ClinicalTrials.gov -- the v2 studies API

Run these manually whenever you need a fresh or updated data slice, or wire
them into a scheduler (cron, Airflow, etc.) for periodic refreshes. All
connection details come from `etl/.env` (never committed) -- see setup below.

## Setup

```bash
cp etl/.env.example etl/.env
# then edit etl/.env with your local Postgres credentials
```

**Use a virtualenv, and on Windows use the `py` launcher, not bare
`python`/`pip`.** In a plain Git Bash shell on Windows, `python`/`pip` often
resolve to the Microsoft Store's app-execution-alias stub ("Python was not
found...") rather than a real interpreter, even when Python is genuinely
installed — the `py` launcher bypasses that:

```bash
py -3 -m venv etl/.venv
etl/.venv/Scripts/python.exe -m pip install -r etl/requirements.txt
```

(On macOS/Linux, or a Windows shell where bare `python3`/`pip3` already work
correctly, the conventional `python3 -m venv etl/.venv && etl/.venv/bin/pip
install -r etl/requirements.txt` is equivalent — the venv is what matters,
not which launcher gets you there.)

Every command below assumes `etl/.venv`'s own interpreter — replace
`python` with `etl/.venv/Scripts/python.exe` (Windows) or
`etl/.venv/bin/python` (macOS/Linux) if it's not the active interpreter on
your `PATH`.

`etl/.env` must define `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`.
The Postgres database and the `faers`/`ct` schemas/tables are expected to
already exist (see `db/` in the repo root) -- this layer only loads data into
them, it does not create schema.

## Run order (fresh load)

```bash
python etl/faers/fetch_bulk.py --quarters 2023Q3,2023Q4
python etl/faers/load_reports.py
python etl/clinicaltrials/fetch_v2_api.py --condition cancer --intervention-type DRUG --max-studies 3000
python etl/clinicaltrials/load_studies.py
```

- `fetch_bulk.py` downloads the requested FAERS quarterly bulk zip(s) from
  openFDA's download manifest into `etl/faers/_raw/` (skips files it has
  already downloaded).
- `load_reports.py` parses those zip(s) and loads `faers.report`,
  `faers.patient`, `faers.drug`, `faers.reaction`.
- `fetch_v2_api.py` paginates the ClinicalTrials.gov v2 API into
  `etl/clinicaltrials/_raw/` (tracks progress in `_manifest.json` so it can
  resume instead of re-fetching completed pages).
- `load_studies.py` parses those pages and loads `ct.study`, `ct.condition`,
  `ct.intervention`, `ct.outcome_measure`.

All four scripts are idempotent: re-running a fetch step skips
already-downloaded files/pages, and re-running a load step will not create
duplicate rows if run again against the same raw data.

Use `--limit` on `load_reports.py`, or a small `--max-studies` on
`fetch_v2_api.py`, for quick local/dev testing without pulling a full
dataset.
