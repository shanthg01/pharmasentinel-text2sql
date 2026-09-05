"""Load fetched ClinicalTrials.gov v2 API pages into Postgres.

Reads every ``page_*.json`` file saved by ``fetch_v2_api.py`` in
``--raw-dir``, parses each study's ``protocolSection``, flattens it into four
DataFrames matching ``ct.study`` / ``ct.condition`` / ``ct.intervention`` /
``ct.outcome_measure``, and loads them via ``etl/common/db.py``'s
``bulk_upsert`` in FK-safe order.

Each study in the CT.gov v2 API response has this shape (the real
ClinicalTrials.gov v2 API response schema)::

    {
      "protocolSection": {
        "identificationModule": {"nctId": "NCT01234567", "briefTitle": "..."},
        "statusModule": {
          "overallStatus": "RECRUITING",
          "startDateStruct": {"date": "2023-01"},
          "primaryCompletionDateStruct": {"date": "2025-06-30"}
        },
        "designModule": {
          "studyType": "INTERVENTIONAL",
          "phases": ["PHASE2"],
          "enrollmentInfo": {"count": 200}
        },
        "sponsorCollaboratorsModule": {"leadSponsor": {"name": "Example Pharma"}},
        "conditionsModule": {"conditions": ["Breast Cancer"]},
        "armsInterventionsModule": {
          "interventions": [{"type": "DRUG", "name": "Drug X"}]
        },
        "outcomesModule": {
          "primaryOutcomes": [{"measure": "Overall Survival", "timeFrame": "5 years"}],
          "secondaryOutcomes": [{"measure": "Response Rate", "timeFrame": "1 year"}]
        }
      }
    }

Usage:
    python etl/clinicaltrials/load_studies.py --raw-dir etl/clinicaltrials/_raw
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterator

import pandas as pd

sys.path.append(str(Path(__file__).resolve().parent.parent))
from common.db import bulk_upsert, delete_by_parent_ids, get_connection  # noqa: E402

STUDY_COLUMNS = [
    "nct_id",
    "brief_title",
    "overall_status",
    "phase",
    "study_type",
    "enrollment_count",
    "start_date",
    "primary_completion_date",
    "lead_sponsor",
]
CONDITION_COLUMNS = ["nct_id", "condition_name"]
INTERVENTION_COLUMNS = ["nct_id", "intervention_type", "intervention_name"]
OUTCOME_MEASURE_COLUMNS = ["nct_id", "outcome_type", "measure", "time_frame"]

_PARTIAL_DATE_RE = re.compile(r"^\d{4}(-\d{2})?$")


def _parse_ct_date(date_str: str | None) -> str | None:
    """Normalize a CT.gov date string to ``YYYY-MM-DD``.

    CT.gov dates are sometimes partial (``"2023"`` or ``"2023-01"``) rather
    than a full ``"2023-01-15"``. Partial dates are anchored to the first of
    the month/year so they still parse as a valid SQL ``DATE``.

    :param date_str: the raw date string from the API, or ``None``.
    :returns: a ``YYYY-MM-DD`` string, or ``None`` if ``date_str`` is falsy or
        unparseable.
    """
    if not date_str:
        return None
    if _PARTIAL_DATE_RE.match(date_str):
        parts = date_str.split("-")
        year = parts[0]
        month = parts[1] if len(parts) > 1 else "01"
        return f"{year}-{month}-01"
    return date_str


def iter_studies(raw_dir: Path) -> Iterator[dict]:
    """Yield individual study dicts from every ``page_*.json`` file in ``raw_dir``.

    :param raw_dir: directory containing pages saved by ``fetch_v2_api.py``.
    :yields: one raw study dict (with a top-level ``protocolSection``) per
        study.
    :raises SystemExit: if no page files are found.
    """
    page_paths = sorted(raw_dir.glob("page_*.json"))
    if not page_paths:
        print(
            f"ERROR: no page_*.json files found in {raw_dir}. "
            "Run etl/clinicaltrials/fetch_v2_api.py first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    for page_path in page_paths:
        try:
            with open(page_path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"ERROR: failed to read {page_path}: {exc}", file=sys.stderr)
            continue
        yield from payload.get("studies", [])


def flatten_studies(
    studies: Iterator[dict],
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Flatten raw CT.gov v2 API study dicts into four target-shaped DataFrames.

    :param studies: an iterator of raw study dicts, as yielded by
        :func:`iter_studies`.
    :returns: a 4-tuple of DataFrames ``(study_df, condition_df,
        intervention_df, outcome_measure_df)`` matching ``ct.study`` /
        ``ct.condition`` / ``ct.intervention`` / ``ct.outcome_measure``.
    """
    study_rows: list[dict] = []
    condition_rows: list[dict] = []
    intervention_rows: list[dict] = []
    outcome_measure_rows: list[dict] = []

    for study in studies:
        protocol: dict[str, Any] = study.get("protocolSection") or {}

        identification = protocol.get("identificationModule") or {}
        nct_id = identification.get("nctId")
        if not nct_id:
            continue

        status = protocol.get("statusModule") or {}
        design = protocol.get("designModule") or {}
        sponsors = protocol.get("sponsorCollaboratorsModule") or {}
        conditions_module = protocol.get("conditionsModule") or {}
        arms = protocol.get("armsInterventionsModule") or {}
        outcomes = protocol.get("outcomesModule") or {}

        phases = design.get("phases") or []
        enrollment_info = design.get("enrollmentInfo") or {}
        lead_sponsor = sponsors.get("leadSponsor") or {}
        start_date_struct = status.get("startDateStruct") or {}
        completion_date_struct = status.get("primaryCompletionDateStruct") or {}

        study_rows.append(
            {
                "nct_id": nct_id,
                "brief_title": identification.get("briefTitle"),
                "overall_status": status.get("overallStatus"),
                "phase": ", ".join(phases) if phases else None,
                "study_type": design.get("studyType"),
                "enrollment_count": enrollment_info.get("count"),
                "start_date": _parse_ct_date(start_date_struct.get("date")),
                "primary_completion_date": _parse_ct_date(
                    completion_date_struct.get("date")
                ),
                "lead_sponsor": lead_sponsor.get("name"),
            }
        )

        for condition_name in conditions_module.get("conditions", []) or []:
            condition_rows.append({"nct_id": nct_id, "condition_name": condition_name})

        for intervention in arms.get("interventions", []) or []:
            intervention_rows.append(
                {
                    "nct_id": nct_id,
                    "intervention_type": intervention.get("type"),
                    "intervention_name": intervention.get("name"),
                }
            )

        for outcome in outcomes.get("primaryOutcomes", []) or []:
            outcome_measure_rows.append(
                {
                    "nct_id": nct_id,
                    "outcome_type": "primary",
                    "measure": outcome.get("measure"),
                    "time_frame": outcome.get("timeFrame"),
                }
            )
        for outcome in outcomes.get("secondaryOutcomes", []) or []:
            outcome_measure_rows.append(
                {
                    "nct_id": nct_id,
                    "outcome_type": "secondary",
                    "measure": outcome.get("measure"),
                    "time_frame": outcome.get("timeFrame"),
                }
            )

    study_df = pd.DataFrame(study_rows, columns=STUDY_COLUMNS)
    condition_df = pd.DataFrame(condition_rows, columns=CONDITION_COLUMNS)
    intervention_df = pd.DataFrame(intervention_rows, columns=INTERVENTION_COLUMNS)
    outcome_measure_df = pd.DataFrame(outcome_measure_rows, columns=OUTCOME_MEASURE_COLUMNS)

    return study_df, condition_df, intervention_df, outcome_measure_df


def _rows_for_insert(df: pd.DataFrame) -> list[tuple]:
    """Convert a DataFrame to a list of row tuples with NaN mapped to None.

    ``df.where(pd.notnull(df), None)`` alone is not enough: on a numeric
    (e.g. ``float64``) column, pandas cannot actually store a bare ``None``
    in-place and silently coerces it right back to ``NaN`` -- so a masked
    "missing" cell in a numeric column round-trips as ``NaN``, not ``None``.
    That ``NaN`` then reaches psycopg2 as a literal float, and Postgres
    rejects binding ``NaN`` into an ``integer`` column with "integer out of
    range" (a confusing error for what is actually just a null value).
    Casting to ``object`` dtype first gives every column room to hold a real
    ``None``.

    :param df: the DataFrame to convert.
    :returns: a list of tuples suitable for ``execute_values``.
    """
    object_df = df.astype(object).where(pd.notnull(df), None)
    return [tuple(r) for r in object_df.itertuples(index=False)]


def main() -> None:
    """CLI entry point: load fetched CT.gov v2 pages from ``--raw-dir`` into Postgres."""
    parser = argparse.ArgumentParser(
        description="Load fetched ClinicalTrials.gov v2 API pages into Postgres."
    )
    parser.add_argument(
        "--raw-dir",
        default=str(Path(__file__).resolve().parent / "_raw"),
        help="Directory containing fetched page_*.json files (default: etl/clinicaltrials/_raw)",
    )
    args = parser.parse_args()

    raw_dir = Path(args.raw_dir)
    studies = iter_studies(raw_dir)
    study_df, condition_df, intervention_df, outcome_measure_df = flatten_studies(studies)

    if study_df.empty:
        print("No studies parsed -- nothing to load.", file=sys.stderr)
        raise SystemExit(1)

    conn = get_connection()
    try:
        nct_ids = study_df["nct_id"].tolist()

        n_study = bulk_upsert(
            conn, "ct.study", STUDY_COLUMNS, _rows_for_insert(study_df), ["nct_id"]
        )

        # Child tables only have a surrogate BIGSERIAL id with no natural
        # unique constraint to key ON CONFLICT on, so we clear any
        # previously-loaded rows for these studies before reinserting -- this
        # keeps re-running the loader against the same raw files idempotent
        # instead of accumulating duplicate rows.
        delete_by_parent_ids(conn, "ct.condition", "nct_id", nct_ids)
        delete_by_parent_ids(conn, "ct.intervention", "nct_id", nct_ids)
        delete_by_parent_ids(conn, "ct.outcome_measure", "nct_id", nct_ids)

        n_condition = bulk_upsert(
            conn, "ct.condition", CONDITION_COLUMNS, _rows_for_insert(condition_df), ["id"]
        )
        n_intervention = bulk_upsert(
            conn,
            "ct.intervention",
            INTERVENTION_COLUMNS,
            _rows_for_insert(intervention_df),
            ["id"],
        )
        n_outcome_measure = bulk_upsert(
            conn,
            "ct.outcome_measure",
            OUTCOME_MEASURE_COLUMNS,
            _rows_for_insert(outcome_measure_df),
            ["id"],
        )
    finally:
        conn.close()

    print("Load summary:")
    print(f"  ct.study           : {n_study} rows")
    print(f"  ct.condition       : {n_condition} rows")
    print(f"  ct.intervention    : {n_intervention} rows")
    print(f"  ct.outcome_measure : {n_outcome_measure} rows")


if __name__ == "__main__":
    main()
