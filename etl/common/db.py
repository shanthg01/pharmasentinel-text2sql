"""Shared database helpers for the PharmaSentinel ETL layer.

Reads connection settings from environment variables (populated from an
``.env`` file via ``python-dotenv``) and exposes a small idempotent bulk-load
helper used by every loader script in this package.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Sequence

import psycopg2
from dotenv import load_dotenv
from psycopg2.extensions import connection as Connection
from psycopg2.extras import execute_values

# Load the .env that sits alongside this package (etl/.env) regardless of the
# caller's current working directory.
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH)


def get_connection() -> Connection:
    """Open a new psycopg2 connection using PG* environment variables.

    Expects ``PGHOST``, ``PGPORT``, ``PGDATABASE``, ``PGUSER`` and
    ``PGPASSWORD`` to be set (see ``etl/.env.example``).

    :returns: an open ``psycopg2`` connection. Callers are responsible for
        closing it (or using it as a context manager).
    :raises psycopg2.OperationalError: if the connection cannot be
        established (bad credentials, host unreachable, etc.).
    """
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "pharmasentinel"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", ""),
    )


def bulk_upsert(
    conn: Connection,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[object]],
    conflict_cols: Sequence[str],
) -> int:
    """Bulk-insert rows into ``table``, ignoring conflicts on ``conflict_cols``.

    Uses ``psycopg2.extras.execute_values`` for efficient batched inserts and
    an ``ON CONFLICT (...) DO NOTHING`` clause so the same rows can be safely
    re-loaded (idempotent re-runs of an ETL script won't create duplicates or
    raise on primary/foreign key collisions).

    :param conn: an open psycopg2 connection. The caller owns the transaction
        (this function commits once after the insert).
    :param table: fully-qualified table name, e.g. ``"faers.report"``.
    :param columns: ordered column names matching the positions in ``rows``.
    :param rows: an iterable of row tuples/lists, one per record to insert.
    :param conflict_cols: column(s) forming the conflict target for
        ``ON CONFLICT``. Must correspond to a unique or primary key
        constraint on ``table``.
    :returns: the number of rows passed to the statement (not necessarily the
        number actually inserted, since conflicting rows are skipped).
    """
    rows = list(rows)
    if not rows:
        return 0

    col_list = ", ".join(columns)
    conflict_list = ", ".join(conflict_cols)
    query = (
        f"INSERT INTO {table} ({col_list}) VALUES %s "
        f"ON CONFLICT ({conflict_list}) DO NOTHING"
    )

    with conn.cursor() as cur:
        execute_values(cur, query, rows)
    conn.commit()

    return len(rows)


def delete_by_parent_ids(
    conn: Connection,
    table: str,
    parent_col: str,
    parent_ids: Iterable[object],
) -> int:
    """Delete all rows in a child table for a given set of parent id values.

    Child tables such as ``faers.drug``/``faers.reaction`` and
    ``ct.condition``/``ct.intervention``/``ct.outcome_measure`` only carry a
    surrogate ``BIGSERIAL`` primary key with no natural unique constraint to
    key an ``ON CONFLICT DO NOTHING`` upsert on. To keep re-runs of a loader
    idempotent, callers should delete any previously-loaded child rows for
    the parent ids about to be (re)loaded before inserting the fresh batch
    via :func:`bulk_upsert`.

    :param conn: an open psycopg2 connection.
    :param table: fully-qualified child table name, e.g. ``"faers.drug"``.
    :param parent_col: the foreign key column, e.g. ``"safetyreportid"``.
    :param parent_ids: the parent id values whose child rows should be
        cleared before reinsertion.
    :returns: the number of rows deleted.
    """
    parent_ids = list(dict.fromkeys(parent_ids))  # de-dupe, preserve order
    if not parent_ids:
        return 0

    query = f"DELETE FROM {table} WHERE {parent_col} = ANY(%s)"
    with conn.cursor() as cur:
        cur.execute(query, (parent_ids,))
        deleted = cur.rowcount
    conn.commit()

    return deleted
