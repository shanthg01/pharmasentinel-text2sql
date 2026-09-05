"""Download openFDA FAERS quarterly bulk export files.

This script hits openFDA's bulk-download manifest at
``https://api.fda.gov/download.json`` to discover the drug-event quarterly
zip files, filters them down to the quarters requested on the command line,
and downloads each one (streamed, with a progress bar) into an output
directory.

Note: each downloaded zip contains one large JSON file (commonly named
``drug-event-000N-of-000M.json`` or similar, historically referred to by the
openFDA docs' ``ADR*.json`` naming) holding the *bulk* FAERS drug-event
export -- this is a full historical quarterly slice, and is a distinct data
source from the paginated ``https://api.fda.gov/drug/event.json`` REST
search API (which only returns sampled/paged results). We use the bulk files
here because we want a complete historical slice to load into Postgres, not
an API-sampled subset.

Usage:
    python etl/faers/fetch_bulk.py --quarters 2023Q1,2023Q2 --out-dir etl/faers/_raw
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Iterable

import requests
from tqdm import tqdm

DOWNLOAD_MANIFEST_URL = "https://api.fda.gov/download.json"
REQUEST_TIMEOUT_S = 30
DOWNLOAD_CHUNK_BYTES = 1024 * 1024  # 1 MiB


def parse_quarters(raw: str) -> list[str]:
    """Parse a comma-separated ``--quarters`` argument into a normalized list.

    :param raw: comma-separated quarters, e.g. ``"2023Q1,2023Q2"``.
    :returns: a list of upper-cased, whitespace-stripped quarter strings,
        e.g. ``["2023Q1", "2023Q2"]``.
    :raises ValueError: if any entry doesn't match the ``YYYYQ#`` shape.
    """
    quarters = [q.strip().upper() for q in raw.split(",") if q.strip()]
    pattern = re.compile(r"^\d{4}Q[1-4]$")
    for q in quarters:
        if not pattern.match(q):
            raise ValueError(
                f"Invalid quarter '{q}' -- expected format YYYYQ#, e.g. 2023Q1"
            )
    return quarters


def _quarter_patterns(quarter: str) -> list[re.Pattern[str]]:
    """Build regexes matching the various ways a manifest may spell a quarter.

    The openFDA download manifest's ``display_name``/file path fields have
    historically spelled quarters in more than one way (e.g. "2023q1",
    "2023 Q1", "Q1 2023"). We match loosely against several known spellings
    since we cannot introspect the live manifest at authoring time.

    :param quarter: a normalized quarter string, e.g. ``"2023Q1"``.
    :returns: compiled case-insensitive regexes to test against manifest text.
    """
    year, q = quarter[:4], quarter[4:]  # "2023", "Q1"
    qnum = q[1]
    return [
        re.compile(rf"{year}\s*{q}\b", re.IGNORECASE),
        re.compile(rf"{q}\s*{year}\b", re.IGNORECASE),
        re.compile(rf"{year}[\s\-_]?q{qnum}\b", re.IGNORECASE),
    ]


def fetch_manifest() -> dict:
    """Fetch and parse the openFDA bulk-download manifest.

    :returns: the parsed JSON manifest.
    :raises SystemExit: on network failure or an unparseable response, after
        printing a clear message to stderr.
    """
    try:
        resp = requests.get(DOWNLOAD_MANIFEST_URL, timeout=REQUEST_TIMEOUT_S)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(
            f"ERROR: failed to fetch openFDA download manifest from "
            f"{DOWNLOAD_MANIFEST_URL}: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    try:
        return resp.json()
    except ValueError as exc:
        print(
            f"ERROR: openFDA download manifest response was not valid JSON: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc


def find_partitions_for_quarters(manifest: dict, quarters: Iterable[str]) -> dict[str, list[dict]]:
    """Match requested quarters against the drug-event partitions in the manifest.

    :param manifest: the parsed manifest from :func:`fetch_manifest`.
    :param quarters: normalized quarter strings, e.g. ``["2023Q1"]``.
    :returns: mapping of requested quarter -> list of matching partition dicts
        (each with at least a ``"file"`` URL). A quarter with no matches maps
        to an empty list.
    :raises SystemExit: if the manifest doesn't contain the expected
        ``results.drug.event.partitions`` path at all (a structurally broken
        or unexpected manifest).
    """
    try:
        partitions = manifest["results"]["drug"]["event"]["partitions"]
    except (KeyError, TypeError) as exc:
        print(
            "ERROR: openFDA manifest did not contain the expected "
            "results.drug.event.partitions structure -- the manifest format "
            "may have changed.",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    matches: dict[str, list[dict]] = {q: [] for q in quarters}
    for quarter in quarters:
        patterns = _quarter_patterns(quarter)
        for partition in partitions:
            haystack = " ".join(
                str(partition.get(k, "")) for k in ("display_name", "file")
            )
            if any(p.search(haystack) for p in patterns):
                matches[quarter].append(partition)

    return matches


def download_file(url: str, dest: Path) -> None:
    """Stream-download one file to ``dest`` with a progress bar.

    Skips the download entirely if ``dest`` already exists (idempotent
    re-runs), matching the pattern used across this ETL layer.

    :param url: the file URL to download.
    :param dest: local destination path.
    :raises SystemExit: on network failure, after printing a clear message to
        stderr. Any partially-written file is removed so a subsequent run
        will retry.
    """
    if dest.exists():
        print(f"SKIP  {dest.name} (already downloaded)")
        return

    tmp_dest = dest.with_suffix(dest.suffix + ".part")
    try:
        with requests.get(url, stream=True, timeout=REQUEST_TIMEOUT_S) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("Content-Length", 0)) or None
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp_dest, "wb") as fh, tqdm(
                total=total,
                unit="B",
                unit_scale=True,
                desc=dest.name,
            ) as bar:
                for chunk in resp.iter_content(chunk_size=DOWNLOAD_CHUNK_BYTES):
                    if chunk:
                        fh.write(chunk)
                        bar.update(len(chunk))
    except requests.RequestException as exc:
        tmp_dest.unlink(missing_ok=True)
        print(f"ERROR: failed to download {url}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    tmp_dest.rename(dest)


def main() -> None:
    """CLI entry point: download requested FAERS quarterly bulk zips."""
    parser = argparse.ArgumentParser(
        description="Download openFDA FAERS quarterly drug-event bulk export files."
    )
    parser.add_argument(
        "--quarters",
        required=True,
        help="Comma-separated list of quarters to fetch, e.g. 2023Q1,2023Q2",
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parent / "_raw"),
        help="Directory to save downloaded zip files into (default: etl/faers/_raw)",
    )
    args = parser.parse_args()

    try:
        quarters = parse_quarters(args.quarters)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = fetch_manifest()
    matches = find_partitions_for_quarters(manifest, quarters)

    missing = [q for q, parts in matches.items() if not parts]
    if missing:
        print(
            f"ERROR: no manifest entries found for quarter(s): {', '.join(missing)}. "
            "The openFDA manifest may not cover these quarters, or its "
            "display naming has changed.",
            file=sys.stderr,
        )

    downloaded = 0
    for quarter, partitions in matches.items():
        for partition in partitions:
            url = partition.get("file")
            if not url:
                print(
                    f"WARNING: skipping a {quarter} partition with no 'file' URL: {partition}",
                    file=sys.stderr,
                )
                continue
            dest = out_dir / Path(url).name
            print(f"Fetching {quarter}: {url}")
            download_file(url, dest)
            downloaded += 1

    if downloaded == 0:
        print("ERROR: no files were downloaded.", file=sys.stderr)
        raise SystemExit(1)

    print(f"Done. {downloaded} file(s) available in {out_dir}")


if __name__ == "__main__":
    main()
