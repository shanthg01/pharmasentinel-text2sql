"""Load downloaded openFDA FAERS bulk export file(s) into Postgres.

Reads every ``.zip`` (and any already-extracted ``.json``) file in
``--raw-dir``, parses the FAERS bulk JSON's top-level ``results`` array (one
element per safety report), flattens it into four DataFrames matching
``faers.report`` / ``faers.patient`` / ``faers.drug`` / ``faers.reaction``,
and loads them via ``etl/common/db.py``'s ``bulk_upsert`` in FK-safe order.

Each result in the openFDA FAERS bulk export has this shape (the real
openFDA FAERS drug-event JSON schema)::

    {
      "safetyreportid": "12345678",
      "receivedate": "20230115",
      "serious": "1",
      "seriousnessdeath": "1",
      "seriousnesshospitalization": "2",
      "seriousnesslifethreatening": "2",
      "seriousnessdisabling": "2",
      "reporttype": "1",
      "companynumb": "US-PFIZER-2023001234",
      "occurcountry": "US",
      "primarysource": {"qualification": "3", "reportercountry": "US"},
      "patient": {
        "patientonsetage": "45",
        "patientonsetageunit": "801",
        "patientsex": "2",
        "patientweight": "70",
        "drug": [
          {
            "medicinalproduct": "ASPIRIN",
            "drugcharacterization": "1",
            "drugdosagetext": "100MG DAILY",
            "drugindication": "PAIN",
            "drugadministrationroute": "048",
            "activesubstance": {"activesubstancename": "ASPIRIN"}
          }
        ],
        "reaction": [
          {"reactionmeddrapt": "Nausea", "reactionoutcome": "1"}
        ]
      }
    }

Usage:
    python etl/faers/load_reports.py --raw-dir etl/faers/_raw --limit 1000
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from typing import Any, Iterator

import pandas as pd

sys.path.append(str(Path(__file__).resolve().parent.parent))
from common.db import bulk_upsert, delete_by_parent_ids, get_connection  # noqa: E402

REPORT_COLUMNS = [
    "safetyreportid",
    "receivedate",
    "serious",
    "seriousnessdeath",
    "seriousnesshospitalization",
    "seriousnesslifethreatening",
    "seriousnessdisabling",
    "reporttype",
    "companynumb",
    "primarysource_qualification",
    "occurcountry",
]
PATIENT_COLUMNS = [
    "safetyreportid",
    "patientonsetage",
    "patientonsetageunit",
    "patientsex",
    "patientweight",
]
DRUG_COLUMNS = [
    "safetyreportid",
    "drugname",
    "active_ingredient",
    "drugcharacterization",
    "drugdosagetext",
    "drugindication",
    "drugadministrationroute",
]
REACTION_COLUMNS = ["safetyreportid", "reactionmeddrapt", "reactionoutcome"]


def _to_bool(value: Any) -> bool | None:
    """Coerce an openFDA "1"/"2" seriousness flag to a Python bool.

    openFDA encodes these fields as the string ``"1"`` (yes/applicable) or
    ``"2"`` (no); the field is simply absent when unknown.

    :param value: the raw field value (usually a string, or ``None``).
    :returns: ``True`` for ``"1"``, ``False`` for ``"2"``, else ``None``.
    """
    if value == "1":
        return True
    if value == "2":
        return False
    return None


def iter_result_records(raw_dir: Path) -> Iterator[dict]:
    """Yield individual FAERS safety-report dicts from every file in ``raw_dir``.

    Reads the ``results`` array out of each ``.zip`` (extracting its inner
    ``.json`` member(s) in memory) and out of any already-extracted ``.json``
    files found directly in ``raw_dir``.

    :param raw_dir: directory containing downloaded FAERS bulk files.
    :yields: one dict per safety report.
    :raises SystemExit: if ``raw_dir`` contains no zip or json files at all.
    """
    zip_paths = sorted(raw_dir.glob("*.zip"))
    json_paths = sorted(raw_dir.glob("*.json"))

    if not zip_paths and not json_paths:
        print(
            f"ERROR: no .zip or .json files found in {raw_dir}. "
            "Run etl/faers/fetch_bulk.py first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    for zip_path in zip_paths:
        try:
            with zipfile.ZipFile(zip_path) as zf:
                members = [n for n in zf.namelist() if n.lower().endswith(".json")]
                if not members:
                    print(
                        f"WARNING: {zip_path.name} contains no .json member, skipping",
                        file=sys.stderr,
                    )
                for member in members:
                    with zf.open(member) as fh:
                        payload = json.load(fh)
                    yield from payload.get("results", [])
        except (zipfile.BadZipFile, OSError) as exc:
            print(f"ERROR: failed to read {zip_path}: {exc}", file=sys.stderr)
            continue

    for json_path in json_paths:
        try:
            with open(json_path, encoding="utf-8") as fh:
                payload = json.load(fh)
            yield from payload.get("results", [])
        except (json.JSONDecodeError, OSError) as exc:
            print(f"ERROR: failed to read {json_path}: {exc}", file=sys.stderr)
            continue


def flatten_reports(
    records: Iterator[dict], limit: int | None = None
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Flatten raw FAERS safety-report dicts into four target-shaped DataFrames.

    :param records: an iterator of raw safety-report dicts, as yielded by
        :func:`iter_result_records`.
    :param limit: optional cap on the number of safety reports processed
        (useful for quick dev runs).
    :returns: a 4-tuple of DataFrames ``(report_df, patient_df, drug_df,
        reaction_df)`` matching ``faers.report``/``faers.patient``/
        ``faers.drug``/``faers.reaction``.
    """
    report_rows: list[dict] = []
    patient_rows: list[dict] = []
    drug_rows: list[dict] = []
    reaction_rows: list[dict] = []

    for count, result in enumerate(records):
        if limit is not None and count >= limit:
            break

        safetyreportid = result.get("safetyreportid")
        if not safetyreportid:
            continue

        primarysource = result.get("primarysource") or {}
        report_rows.append(
            {
                "safetyreportid": safetyreportid,
                "receivedate": result.get("receivedate"),
                "serious": _to_bool(result.get("serious")),
                "seriousnessdeath": _to_bool(result.get("seriousnessdeath")),
                "seriousnesshospitalization": _to_bool(
                    result.get("seriousnesshospitalization")
                ),
                "seriousnesslifethreatening": _to_bool(
                    result.get("seriousnesslifethreatening")
                ),
                "seriousnessdisabling": _to_bool(result.get("seriousnessdisabling")),
                "reporttype": result.get("reporttype"),
                "companynumb": result.get("companynumb"),
                "primarysource_qualification": primarysource.get("qualification"),
                "occurcountry": result.get("occurcountry"),
            }
        )

        patient = result.get("patient") or {}
        patient_rows.append(
            {
                "safetyreportid": safetyreportid,
                "patientonsetage": patient.get("patientonsetage"),
                "patientonsetageunit": patient.get("patientonsetageunit"),
                "patientsex": patient.get("patientsex"),
                "patientweight": patient.get("patientweight"),
            }
        )

        for drug in patient.get("drug", []) or []:
            active_substance = drug.get("activesubstance") or {}
            active_ingredient = active_substance.get("activesubstancename")
            if not active_ingredient:
                fallback = drug.get("medicinalproduct") or ""
                active_ingredient = fallback.strip().lower() or None
            drug_rows.append(
                {
                    "safetyreportid": safetyreportid,
                    "drugname": drug.get("medicinalproduct"),
                    "active_ingredient": active_ingredient,
                    "drugcharacterization": drug.get("drugcharacterization"),
                    "drugdosagetext": drug.get("drugdosagetext"),
                    "drugindication": drug.get("drugindication"),
                    "drugadministrationroute": drug.get("drugadministrationroute"),
                }
            )

        for reaction in patient.get("reaction", []) or []:
            reaction_rows.append(
                {
                    "safetyreportid": safetyreportid,
                    "reactionmeddrapt": reaction.get("reactionmeddrapt"),
                    "reactionoutcome": reaction.get("reactionoutcome"),
                }
            )

    report_df = pd.DataFrame(report_rows, columns=REPORT_COLUMNS)
    if not report_df.empty:
        report_df["receivedate"] = pd.to_datetime(
            report_df["receivedate"], format="%Y%m%d", errors="coerce"
        ).dt.date

    patient_df = pd.DataFrame(patient_rows, columns=PATIENT_COLUMNS)
    drug_df = pd.DataFrame(drug_rows, columns=DRUG_COLUMNS)
    reaction_df = pd.DataFrame(reaction_rows, columns=REACTION_COLUMNS)

    return report_df, patient_df, drug_df, reaction_df


def _rows_for_insert(df: pd.DataFrame) -> list[tuple]:
    """Convert a DataFrame to a list of row tuples with NaN mapped to None.

    ``df.where(pd.notnull(df), None)`` alone is not enough: on a numeric
    (e.g. ``float64``) column, pandas cannot actually store a bare ``None``
    in-place and silently coerces it right back to ``NaN`` -- so a masked
    "missing" cell in a numeric column round-trips as ``NaN``, not ``None``.
    That ``NaN`` then reaches psycopg2 as a literal float, and Postgres
    rejects binding ``NaN`` into an ``integer`` column with "integer out of
    range" (a confusing error for what is actually just a null value, e.g.
    ``patientonsetage``/``patientweight`` when the source report omits them).
    Casting to ``object`` dtype first gives every column room to hold a real
    ``None``.

    :param df: the DataFrame to convert.
    :returns: a list of tuples suitable for ``execute_values``.
    """
    object_df = df.astype(object).where(pd.notnull(df), None)
    return [tuple(r) for r in object_df.itertuples(index=False)]


def main() -> None:
    """CLI entry point: load FAERS bulk files from ``--raw-dir`` into Postgres."""
    parser = argparse.ArgumentParser(
        description="Load downloaded openFDA FAERS bulk export file(s) into Postgres."
    )
    parser.add_argument(
        "--raw-dir",
        default=str(Path(__file__).resolve().parent / "_raw"),
        help="Directory containing downloaded FAERS zip/json files (default: etl/faers/_raw)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional cap on the number of safety reports processed (for dev testing)",
    )
    args = parser.parse_args()

    raw_dir = Path(args.raw_dir)
    records = iter_result_records(raw_dir)
    report_df, patient_df, drug_df, reaction_df = flatten_reports(records, limit=args.limit)

    if report_df.empty:
        print("No FAERS reports parsed -- nothing to load.", file=sys.stderr)
        raise SystemExit(1)

    conn = get_connection()
    try:
        report_ids = report_df["safetyreportid"].tolist()

        n_report = bulk_upsert(
            conn, "faers.report", REPORT_COLUMNS, _rows_for_insert(report_df), ["safetyreportid"]
        )
        n_patient = bulk_upsert(
            conn,
            "faers.patient",
            PATIENT_COLUMNS,
            _rows_for_insert(patient_df),
            ["safetyreportid"],
        )

        # Child tables (drug/reaction) only have a surrogate BIGSERIAL id with
        # no natural unique constraint to key ON CONFLICT on, so we clear any
        # previously-loaded rows for these report ids before reinserting --
        # this keeps re-running the loader against the same raw files
        # idempotent instead of accumulating duplicate drug/reaction rows.
        delete_by_parent_ids(conn, "faers.drug", "safetyreportid", report_ids)
        delete_by_parent_ids(conn, "faers.reaction", "safetyreportid", report_ids)

        n_drug = bulk_upsert(
            conn, "faers.drug", DRUG_COLUMNS, _rows_for_insert(drug_df), ["id"]
        )
        n_reaction = bulk_upsert(
            conn, "faers.reaction", REACTION_COLUMNS, _rows_for_insert(reaction_df), ["id"]
        )
    finally:
        conn.close()

    print("Load summary:")
    print(f"  faers.report   : {n_report} rows")
    print(f"  faers.patient  : {n_patient} rows")
    print(f"  faers.drug     : {n_drug} rows")
    print(f"  faers.reaction : {n_reaction} rows")


if __name__ == "__main__":
    main()
