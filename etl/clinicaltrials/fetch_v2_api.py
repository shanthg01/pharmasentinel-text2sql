"""Fetch studies from the ClinicalTrials.gov v2 API and save raw pages to disk.

Paginates ``https://clinicaltrials.gov/api/v2/studies`` using its cursor-based
``pageToken``/``nextPageToken`` scheme until either ``--max-studies`` studies
have been collected or the API reports no further pages, saving each page's
raw JSON response as a numbered file in ``--out-dir``.

Progress is tracked in a ``_manifest.json`` file alongside the pages so a
re-run with the same query resumes from where it left off (already-saved
pages are not re-fetched) rather than re-downloading everything -- this is
what makes the script idempotent.

No API key is required for the CT.gov v2 API, but we still pace requests
with a small delay to be a polite API citizen.

Usage:
    python etl/clinicaltrials/fetch_v2_api.py --condition cancer --intervention-type DRUG --max-studies 3000
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import requests

API_URL = "https://clinicaltrials.gov/api/v2/studies"
MAX_PAGE_SIZE = 1000
REQUEST_TIMEOUT_S = 30
POLITE_DELAY_S = 0.5
MANIFEST_FILENAME = "_manifest.json"


def _load_manifest(out_dir: Path) -> dict[str, Any] | None:
    """Load a previous run's manifest, if one exists.

    :param out_dir: the output directory to look in.
    :returns: the parsed manifest dict, or ``None`` if no manifest exists.
    """
    manifest_path = out_dir / MANIFEST_FILENAME
    if not manifest_path.exists():
        return None
    with open(manifest_path, encoding="utf-8") as fh:
        return json.load(fh)


def _save_manifest(out_dir: Path, manifest: dict[str, Any]) -> None:
    """Persist the manifest to disk.

    :param out_dir: the output directory.
    :param manifest: the manifest dict to write.
    """
    manifest_path = out_dir / MANIFEST_FILENAME
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)


def _query_fingerprint(condition: str | None, intervention_type: str | None) -> dict[str, str | None]:
    """Build the query fingerprint stored in the manifest for resume validation.

    :param condition: the ``--condition`` filter, if any.
    :param intervention_type: the ``--intervention-type`` filter, if any.
    :returns: a small dict used to detect if a stale manifest belongs to a
        different query.
    """
    return {"condition": condition, "intervention_type": intervention_type}


def fetch_page(
    condition: str | None,
    intervention_type: str | None,
    page_size: int,
    page_token: str | None,
) -> dict[str, Any]:
    """Fetch a single page of studies from the CT.gov v2 API.

    :param condition: optional ``query.cond`` filter, e.g. ``"cancer"``.
    :param intervention_type: optional ``query.intr`` filter, e.g. ``"DRUG"``.
    :param page_size: number of studies to request (max 1000).
    :param page_token: the ``pageToken`` cursor from a previous response's
        ``nextPageToken``, or ``None`` for the first page.
    :returns: the parsed JSON response, shaped as
        ``{"studies": [...], "nextPageToken": "..."}`` (the last key absent
        on the final page).
    :raises SystemExit: on network failure or a non-JSON response, after
        printing a clear message to stderr.
    """
    params: dict[str, str | int] = {"pageSize": page_size}
    if condition:
        params["query.cond"] = condition
    if intervention_type:
        params["query.intr"] = intervention_type
    if page_token:
        params["pageToken"] = page_token

    try:
        resp = requests.get(API_URL, params=params, timeout=REQUEST_TIMEOUT_S)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"ERROR: request to ClinicalTrials.gov v2 API failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    try:
        return resp.json()
    except ValueError as exc:
        print(f"ERROR: ClinicalTrials.gov v2 API response was not valid JSON: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


def main() -> None:
    """CLI entry point: paginate the CT.gov v2 API and save raw pages to disk."""
    parser = argparse.ArgumentParser(
        description="Fetch studies from the ClinicalTrials.gov v2 API."
    )
    parser.add_argument("--condition", default=None, help='Condition filter, e.g. "cancer"')
    parser.add_argument(
        "--intervention-type", default=None, help='Intervention type filter, e.g. "DRUG"'
    )
    parser.add_argument(
        "--max-studies", type=int, default=5000, help="Maximum number of studies to fetch"
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parent / "_raw"),
        help="Directory to save downloaded page files into (default: etl/clinicaltrials/_raw)",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    fingerprint = _query_fingerprint(args.condition, args.intervention_type)
    manifest = _load_manifest(out_dir)

    if manifest is not None and manifest.get("query") != fingerprint:
        print(
            f"ERROR: existing manifest in {out_dir} was fetched with a different "
            f"query ({manifest.get('query')!r}) than requested ({fingerprint!r}). "
            "Use a different --out-dir for a different query.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    if manifest is None:
        manifest = {"query": fingerprint, "pages": [], "done": False}

    if manifest.get("done"):
        total = sum(p["study_count"] for p in manifest["pages"])
        print(
            f"Already complete: {total} studies across {len(manifest['pages'])} "
            f"page(s) in {out_dir} (API reported no further pages last run)."
        )
        return

    total_fetched = sum(p["study_count"] for p in manifest["pages"])
    page_token = manifest["pages"][-1]["next_page_token"] if manifest["pages"] else None
    page_num = len(manifest["pages"])

    while total_fetched < args.max_studies:
        page_size = min(MAX_PAGE_SIZE, args.max_studies - total_fetched)
        page_num += 1
        print(f"Fetching page {page_num} (page_size={page_size}, token={page_token!r})...")

        payload = fetch_page(args.condition, args.intervention_type, page_size, page_token)
        studies = payload.get("studies", [])
        next_page_token = payload.get("nextPageToken")

        page_filename = f"page_{page_num:04d}.json"
        with open(out_dir / page_filename, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)

        manifest["pages"].append(
            {
                "file": page_filename,
                "page_token_used": page_token,
                "next_page_token": next_page_token,
                "study_count": len(studies),
            }
        )
        total_fetched += len(studies)

        if not next_page_token:
            manifest["done"] = True
            _save_manifest(out_dir, manifest)
            print("Reached the last page reported by the API.")
            break

        _save_manifest(out_dir, manifest)
        page_token = next_page_token
        time.sleep(POLITE_DELAY_S)
    else:
        _save_manifest(out_dir, manifest)

    print(f"Done. {total_fetched} studies saved across {len(manifest['pages'])} page(s) in {out_dir}")


if __name__ == "__main__":
    main()
