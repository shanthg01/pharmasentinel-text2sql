import { Pool, type QueryResultRow } from "pg";

/**
 * Build a `pg.Pool` from the standard PG* environment variables
 * (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD), optionally overriding just
 * the credential pair -- host/port/database are shared by every role, only
 * the role (user/password) differs between the Tier 1-3 pool and the Tier
 * 4 pool.
 */
function createPool(credentials?: { user?: string; password?: string }): Pool {
  return new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE,
    user: credentials?.user ?? process.env.PGUSER,
    password: credentials?.password ?? process.env.PGPASSWORD,
    max: 10,
  });
}

// Module-level singleton, stashed on globalThis so Next.js dev-mode hot
// reload (which can re-evaluate this module many times) doesn't leak a new
// pg.Pool — and its underlying TCP connections — on every reload.
const globalForDb = globalThis as unknown as {
  __pharmasentinelPool?: Pool;
  __pharmasentinelTier4Pool?: Pool;
};

/**
 * Primary connection pool.
 *
 * Authenticates as the `app_runtime` Postgres role (see
 * db/ddl/005_roles.sql, owned by the db/ track), which is granted
 * SELECT-only on `sem.*` and `ont.*`. This is the pool Tier 1–3 code
 * (guardrails' ontology lookups, Tier 3 SQL execution) should use.
 *
 * It must never be granted write access, and it must never be pointed at
 * the raw `faers.*` / `ct.*` tables — those are Tier 4-only, via
 * `tier4Pool` below.
 */
export const pool: Pool = globalForDb.__pharmasentinelPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalForDb.__pharmasentinelPool = pool;
}

/**
 * Tier 4 connection pool.
 *
 * Authenticates as the distinct `app_runtime_tier4` Postgres role (see
 * db/ddl/005_roles.sql), which is granted SELECT-only on raw `faers.*` /
 * `ct.*` in addition to `sem.*`/`ont.*`. Genuinely separate credentials
 * from `pool` above (not just a separate `Pool` object pointed at the same
 * role) matters: it means a bug in Tier 3 code can never read raw tables
 * under elevated grants, and it means Tier 4's raw-table SQL — which
 * `pool`'s `app_runtime` role has no grant to read at all — actually
 * succeeds at the database level instead of failing with a permission
 * error the first time it runs against a real (non-superuser) connection.
 *
 * `PGUSER_TIER4`/`PGPASSWORD_TIER4` fall back to `app_runtime_tier4` /
 * `PGPASSWORD` (the DDL's own local-dev default is the same placeholder
 * password for both roles) so this works out of the box against the
 * `db/docker-compose.yml` setup without extra env-var configuration,
 * while still being overridable for a real deployment.
 */
export const tier4Pool: Pool =
  globalForDb.__pharmasentinelTier4Pool ??
  createPool({
    user: process.env.PGUSER_TIER4 ?? "app_runtime_tier4",
    password: process.env.PGPASSWORD_TIER4 ?? process.env.PGPASSWORD,
  });
if (process.env.NODE_ENV !== "production") {
  globalForDb.__pharmasentinelTier4Pool = tier4Pool;
}

/**
 * Run a parameterized query against `pool` (the `app_runtime` role — Tier
 * 1-3, `sem.*`/`ont.*` only) and return typed rows.
 *
 * This helper does not itself enforce the SELECT-only / table-allowlist /
 * LIMIT invariants — callers are expected to have already run the SQL
 * through `lib/sql/astValidator.ts` before it ever reaches here.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

/**
 * Run a parameterized query against `tier4Pool` (the `app_runtime_tier4`
 * role — raw `faers.*`/`ct.*` access) and return typed rows. Tier 4
 * results must be executed through this, not `query()` — see `tier4Pool`'s
 * doc comment for why the distinction is load-bearing, not cosmetic.
 */
export async function queryTier4<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await tier4Pool.query<T>(sql, params);
  return result.rows;
}
